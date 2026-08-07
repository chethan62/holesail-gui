/*
 * holesail-gui — Tauri backend.
 *
 * Spawns service-worker.js (a plain-Node process) and proxies JSON-RPC
 * between the webview frontend (invoke -> rpc command) and the worker's
 * stdio. Worker events (session:update, worker:log, ...) are re-emitted
 * to the frontend as "worker:event" Tauri events.
 *
 * The worker runs under the SYSTEM node binary so the native addons
 * (sodium-native, udx-native) load with the ABI they were built for.
 */

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const RPC_TIMEOUT: Duration = Duration::from_secs(90); // DHT bootstrap can take a while
static NEXT_RPC_ID: AtomicU64 = AtomicU64::new(1);

struct Worker {
    child: Child,
    stdin: Mutex<ChildStdin>,
}

struct WorkerState(Mutex<Option<Worker>>);

struct Pending {
    tx: tokio::sync::oneshot::Sender<Result<Value, String>>,
}

struct PendingState(Mutex<HashMap<String, Pending>>);

/// Locate service-worker.js: try the resource dir (packaged app), then the
/// directory layout around the running binary (dev build: src-tauri/target/...).
fn find_worker(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("service-worker.js"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("service-worker.js"));
            // dev layout: <root>/src-tauri/target/{debug,release}/holesail-gui
            for up in [1usize, 2, 3, 4] {
                let mut p = dir.to_path_buf();
                for _ in 0..up {
                    p.pop();
                }
                candidates.push(p.join("service-worker.js"));
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("service-worker.js"));
    }

    candidates.into_iter().find(|p| p.is_file())
}

fn spawn_worker(app: &AppHandle) -> Result<Worker, String> {
    let worker_path =
        find_worker(app).ok_or_else(|| "Could not locate service-worker.js".to_string())?;
    let cwd = worker_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();

    let mut child = Command::new("node")
        .arg(&worker_path)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn node: {e}"))?;

    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let stdin = child.stdin.take().expect("stdin is piped");

    // stdout reader: match responses to pending RPCs, forward events to UI
    {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                    if let Some(p) = app.state::<PendingState>().0.lock().unwrap().remove(id) {
                        let result = match msg.get("error").and_then(|v| v.as_str()) {
                            Some(err) => Err(err.to_string()),
                            None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = p.tx.send(result);
                        continue;
                    }
                }
                if msg.get("event").is_some() {
                    let _ = app.emit("worker:event", msg);
                }
            }
        });
    }

    // watcher: detect worker exit, fail pending RPCs, notify the frontend
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(400));
            let exited = {
                let ws = app.state::<WorkerState>();
                let mut guard = ws.0.lock().unwrap();
                match guard
                    .as_mut()
                    .and_then(|w| w.child.try_wait().ok().flatten())
                {
                    Some(status) => {
                        guard.take();
                        Some(status)
                    }
                    None => None,
                }
            };
            if let Some(status) = exited {
                let ps = app.state::<PendingState>();
                let mut map = ps.0.lock().unwrap();
                for (_, p) in map.drain() {
                    let _ = p.tx.send(Err(format!("Service worker exited ({status})")));
                }
                drop(map);
                let _ = app.emit(
                    "worker:event",
                    json!({ "event": "worker:exit", "data": { "code": status.code() } }),
                );
            }
        });
    }

    // stderr reader: forward worker log lines to the UI
    {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let _ = app.emit(
                    "worker:event",
                    json!({ "event": "worker:log", "data": { "text": line } }),
                );
            }
        });
    }

    Ok(Worker {
        child,
        stdin: Mutex::new(stdin),
    })
}

#[tauri::command]
async fn rpc(
    worker: State<'_, WorkerState>,
    pending: State<'_, PendingState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let id = format!(
        "{}-{}",
        NEXT_RPC_ID.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    );

    // Register the pending reply and write the request, releasing every mutex
    // guard before we await — MutexGuard is not Send and the tauri command
    // future must be Send.
    let rx = {
        let mut guard = worker.0.lock().unwrap();
        let w = guard
            .as_mut()
            .ok_or_else(|| "Service worker is not running".to_string())?;

        if let Ok(Some(status)) = w.child.try_wait() {
            guard.take();
            return Err(format!("Service worker exited ({status})"));
        }

        let (tx, rx) = tokio::sync::oneshot::channel();
        pending.0.lock().unwrap().insert(id.clone(), Pending { tx });

        let req = json!({ "id": id, "method": method, "params": params });
        let mut stdin = w.stdin.lock().unwrap();
        writeln!(stdin, "{req}").map_err(|e| {
            pending.0.lock().unwrap().remove(&id);
            format!("Failed to write to worker: {e}")
        })?;
        rx
    };

    match tokio::time::timeout(RPC_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Service worker dropped the request".into()),
        Err(_) => {
            pending.0.lock().unwrap().remove(&id);
            Err("Request timed out".into())
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(PendingState(Mutex::new(HashMap::new())))
        .setup(|app| {
            let worker = spawn_worker(app.handle())?;
            app.manage(WorkerState(Mutex::new(Some(worker))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(mut w) = app_handle.state::<WorkerState>().0.lock().unwrap().take() {
                    // SIGTERM so the worker's graceful shutdown (session teardown) runs
                    #[cfg(unix)]
                    unsafe {
                        libc::kill(w.child.id() as i32, libc::SIGTERM);
                    }
                    #[cfg(not(unix))]
                    let _ = w.child.kill();
                    let _ = w.child.wait();
                }
            }
        });
}
