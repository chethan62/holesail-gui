/*
 * holesail-gui — Tauri backend (library target).
 *
 * Spawns service-worker.js (a plain-Node process) and proxies JSON-RPC
 * between the webview frontend (invoke -> rpc command) and the worker's
 * stdio. Worker events (session:update, worker:log, ...) are re-emitted
 * to the frontend as "worker:event" Tauri events.
 *
 * The worker runs under the SYSTEM node binary so the native addons
 * (sodium-native, udx-native) load with the ABI they were built for.
 *
 * The code lives in the lib target so the mobile builds (cargo build --lib)
 * can compile it; src/main.rs is a thin binary wrapper for the desktop.
 */

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const RPC_TIMEOUT: Duration = Duration::from_secs(90); // DHT bootstrap can take a while
const EXIT_GRACE: Duration = Duration::from_secs(3); // SIGTERM -> SIGKILL escalation on app quit
static NEXT_RPC_ID: AtomicU64 = AtomicU64::new(1);

struct Worker {
    child: Child,
}

struct WorkerState(Mutex<Option<Worker>>);

/// The worker's stdin lives in its own state so an RPC write never holds the
/// WorkerState lock: a wedged pipe must not starve the exit watcher.
struct StdinState(Mutex<Option<ChildStdin>>);

struct Pending {
    tx: tokio::sync::oneshot::Sender<Result<Value, String>>,
}

struct PendingState(Mutex<HashMap<String, Pending>>);

/// Locate service-worker.js: try the resource dir (packaged app), then the
/// directory layout around the running binary (dev build: src-tauri/target/...).
#[cfg(not(target_os = "android"))]
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

/// Desktop: run the worker under the system `node`, located via resource_dir
/// (packaged) or the dev directory layout.
#[cfg(not(target_os = "android"))]
fn worker_command(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let worker_path =
        find_worker(app).ok_or_else(|| "Could not locate service-worker.js".to_string())?;
    Ok((PathBuf::from("node"), worker_path))
}

/// Android: run the worker under the bundled bare runtime.
///
/// SELinux forbids untrusted_app (targetSdk >= 26) from exec'ing files in
/// its own data dir (app_data_file), but allows exec of apk_data_file —
/// the APK's extracted native lib dir (/data/app/.../lib/<abi>/). The
/// bare runtime is shipped there as libholesail_bare.so by the glue
/// script; the worker tree (service-worker.js + node_modules) is
/// extracted from assets into filesDir/bare by BareAssets.kt.
#[cfg(target_os = "android")]
fn worker_command(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let bundle = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("files")
        .join("bare");
    let worker = bundle.join("service-worker.js");
    if !worker.is_file() {
        return Err("Android worker bundle not extracted (assets missing)".to_string());
    }

    // locate our own loaded library to derive the native lib dir
    let maps = std::fs::read_to_string("/proc/self/maps")
        .map_err(|e| format!("Failed to read /proc/self/maps: {e}"))?;
    let libdir = maps
        .lines()
        .filter_map(|l| l.split_whitespace().last())
        .find(|p| p.ends_with("libholesail_gui_lib.so"))
        .and_then(|p| std::path::Path::new(p).parent())
        .ok_or_else(|| "Could not locate libholesail_gui_lib.so in /proc/self/maps".to_string())?
        .to_path_buf();

    let bare = libdir.join("libholesail_bare.so");
    if !bare.is_file() {
        return Err(format!("libholesail_bare.so not found in {libdir:?}"));
    }
    // extracted native libs already carry 0755 (system-owned; the app
    // cannot and must not chmod them)
    Ok((bare, worker))
}

/// Spawn the service worker (node on desktop, bare on Android) and start
/// its IO threads.
/// Requires WorkerState/StdinState/PendingState to be managed already.
fn spawn_worker(app: &AppHandle) -> Result<(), String> {
    let (program, worker_path) = worker_command(app)?;
    let cwd = worker_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();

    let mut child = Command::new(&program);
    // Android: the spawned bare process is outside the zygote linker
    // namespace, so its dependencies (libc++_shared.so for udx-native)
    // must be found via LD_LIBRARY_PATH — the native lib dir and the
    // extracted bundle dir both carry a copy.
    #[cfg(target_os = "android")]
    child.env(
        "LD_LIBRARY_PATH",
        format!(
            "{}:{}",
            program.parent().unwrap_or(&cwd).display(),
            cwd.display()
        ),
    );
    let mut child = child
        .arg(&worker_path)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn service worker ({program:?}): {e}"))?;

    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let stdin = child.stdin.take().expect("stdin is piped");

    *app.state::<WorkerState>().0.lock().unwrap() = Some(Worker { child });
    *app.state::<StdinState>().0.lock().unwrap() = Some(stdin);

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

    // watcher: the SOLE reaper. Detects worker exit, fails pending RPCs,
    // notifies the frontend, then stops (the worker is never respawned in v1).
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
                // Close the stdin pipe so nothing writes to a dead process
                let ss = app.state::<StdinState>();
                ss.0.lock().unwrap().take();

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
                break;
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

    Ok(())
}

#[tauri::command]
async fn rpc(
    stdin: State<'_, StdinState>,
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

    // Register the pending reply, then write the request, releasing every
    // mutex guard before we await — MutexGuard is not Send and the tauri
    // command future must be Send. The watcher owns reaping, so a dead
    // worker surfaces here as a broken pipe or a missing stdin handle.
    let rx = {
        let (tx, rx) = tokio::sync::oneshot::channel();
        pending.0.lock().unwrap().insert(id.clone(), Pending { tx });

        let req = json!({ "id": id, "method": method, "params": params });
        let mut ss = stdin.0.lock().unwrap();
        let pipe = ss.as_mut().ok_or_else(|| {
            pending.0.lock().unwrap().remove(&id);
            "Service worker is not running".to_string()
        })?;
        if let Err(e) = writeln!(pipe, "{req}") {
            pending.0.lock().unwrap().remove(&id);
            return Err(format!("Failed to write to worker: {e}"));
        }
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

/// Tauri application entry point (desktop via src/main.rs, mobile via the
/// generated Android/iOS entry).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingState(Mutex::new(HashMap::new())))
        .setup(|app| {
            app.manage(WorkerState(Mutex::new(None)));
            app.manage(StdinState(Mutex::new(None)));

            // A missing or incompatible worker runtime (no node on desktop, no
            // extracted bundle on Android) must not kill the app: surface it
            // in the UI and keep the window alive.
            if let Err(e) = spawn_worker(app.handle()) {
                eprintln!("Failed to spawn holesail service worker: {}", e);
                let _ = app.emit(
                    "worker:event",
                    json!({ "event": "worker:error", "data": { "message": e } }),
                );
                let _ = app.emit(
                    "worker:event",
                    json!({ "event": "worker:exit", "data": { "code": null, "reason": e } }),
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                let worker = app_handle.state::<WorkerState>().0.lock().unwrap().take();
                let _stdin = app_handle.state::<StdinState>().0.lock().unwrap().take();
                if let Some(mut w) = worker {
                    // SIGTERM so the worker's graceful shutdown (session teardown)
                    // runs; escalate to SIGKILL if it does not exit in time.
                    #[cfg(unix)]
                    unsafe {
                        libc::kill(w.child.id() as i32, libc::SIGTERM);
                    }
                    #[cfg(not(unix))]
                    let _ = w.child.kill();

                    let deadline = Instant::now() + EXIT_GRACE;
                    while Instant::now() < deadline {
                        if w.child.try_wait().ok().flatten().is_some() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    if w.child.try_wait().ok().flatten().is_none() {
                        let _ = w.child.kill();
                        let _ = w.child.wait();
                    }
                }
            }
        });
}
