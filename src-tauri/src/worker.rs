/* worker.rs — service-worker lifecycle: spawn, stdio IO threads, the sole
 * reaper/watcher, respawn backoff, diagnostics, and the restart commands.
 *
 * The worker runs under the system `node` binary in dev, or the bundled
 * `bare` runtime in packaged builds (desktop/Android), so the native addons
 * (sodium-native, udx-native) load with the ABI they were built for.
 */

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// Default RPC reply timeout — a hung worker surfaces fast.
pub(crate) const RPC_TIMEOUT: Duration = Duration::from_secs(30);
/// SIGTERM -> SIGKILL escalation grace period on app quit.
const EXIT_GRACE: Duration = Duration::from_secs(3);
/// A worker that stayed up this long is considered healthy; the respawn
/// backoff resets so a later crash restarts fast again.
const HEALTHY_UPTIME: Duration = Duration::from_secs(60);
/// Respawn backoff ladder; the last entry repeats indefinitely.
const BACKOFF: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];
pub(crate) static NEXT_RPC_ID: AtomicU64 = AtomicU64::new(1);
/// Bumped on every manual restart so a pending auto-respawn from an older
/// worker generation aborts instead of double-spawning.
pub(crate) static RESPAWN_GEN: AtomicU64 = AtomicU64::new(1);
/// Set when the worker's `worker:ready` handshake arrives; reset on every
/// spawn/exit. RPCs issued before ready fail fast instead of riding the
/// full RPC_TIMEOUT against a worker that is still initializing.
pub(crate) static WORKER_READY: AtomicBool = AtomicBool::new(false);

fn backoff_delay(attempt: u32) -> Duration {
    BACKOFF[(attempt as usize).min(BACKOFF.len() - 1)]
}

/// Backoff bookkeeping on a worker exit: if the previous worker was healthy
/// (lived >= HEALTHY_UPTIME), restart the ladder; otherwise advance it.
/// Returns the attempt to pass to `schedule_respawn` (which will bump it
/// again). Pure — unit-tested without a Tauri app.
fn next_attempt(restart_attempt: u32, healthy: bool) -> u32 {
    if healthy {
        0
    } else {
        restart_attempt
    }
}

pub(crate) struct Worker {
    child: Child,
}

pub(crate) struct WorkerState(pub(crate) Mutex<Option<Worker>>);

/// The worker's stdin lives in its own state so an RPC write never holds the
/// WorkerState lock: a wedged pipe must not starve the exit watcher.
pub(crate) struct StdinState(pub(crate) Mutex<Option<ChildStdin>>);

pub(crate) struct Pending {
    pub(crate) tx: tokio::sync::oneshot::Sender<Result<Value, String>>,
}

pub(crate) struct PendingState(pub(crate) Mutex<HashMap<String, Pending>>);

/// Diagnostics about the service worker lifecycle, queryable from the UI.
/// Emitted events can be missed (the webview subscribes after setup), so the
/// authoritative status lives here.
#[derive(Default)]
pub(crate) struct WorkerDiag {
    running: bool,
    /// Last spawn failure or unexpected exit, human-readable.
    last_error: Option<String>,
    /// Consecutive crash count driving the respawn backoff.
    restart_attempt: u32,
    spawned_at: Option<Instant>,
}

pub(crate) struct DiagState(pub(crate) Mutex<WorkerDiag>);

pub(crate) fn diag_record_spawn(app: &AppHandle) {
    let ds = app.state::<DiagState>();
    let mut d = ds.0.lock().unwrap();
    d.running = true;
    d.last_error = None;
    d.spawned_at = Some(Instant::now());
}

pub(crate) fn diag_record_failure(app: &AppHandle, msg: String) {
    let ds = app.state::<DiagState>();
    let mut d = ds.0.lock().unwrap();
    d.running = false;
    d.last_error = Some(msg);
    d.spawned_at = None;
}

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

/// Desktop: run the worker under the bundled bare runtime when present
/// (production bundles ship it — no system Node needed), falling back to
/// the system `node` for dev checkouts and installs without the bundle.
#[cfg(not(target_os = "android"))]
pub(crate) fn worker_command(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    // bare-runtime-win32-* ships bin/bare.exe; prepare-resources.mjs
    // preserves that name when bundling (see its --bare handling).
    let bare_name = if cfg!(windows) { "bare.exe" } else { "bare" };
    // Candidate dirs for the bundle: tauri's resource_dir, then the
    // executable's own dir. Flatpak installs resources to
    // /app/lib/holesail-gui/ (same dir as the binary) and resource_dir()
    // can resolve elsewhere, so exe-relative is the reliable fallback.
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            // /app/lib/holesail-gui/bin/ (some layouts nest it)
            dirs.push(dir.join("bin"));
        }
    }
    for dir in &dirs {
        let bare = dir.join(bare_name);
        let worker = dir.join("service-worker.js");
        if bare.is_file() && worker.is_file() {
            return Ok((bare, worker));
        }
    }
    let worker_path =
        find_worker(app).ok_or_else(|| "Could not locate service-worker.js".to_string())?;
    let node = find_node().ok_or_else(|| {
        let _ = app.emit("worker:event", json!({ "event": "worker:node_missing" }));
        "Node.js not found — install Node.js v18+ to run tunnels".to_string()
    })?;
    Ok((node, worker_path))
}

/// Locate a usable `node` binary: known install locations first, then PATH.
/// Platform-aware: on Windows the binary is `node.exe` (the bundled-bare
/// path handles packaged installs; this is the dev/source-install fallback).
#[cfg(not(target_os = "android"))]
fn find_node() -> Option<PathBuf> {
    let bin_name = if cfg!(windows) { "node.exe" } else { "node" };
    let candidates: &[&str] = if cfg!(windows) {
        &[
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
        ]
    } else {
        &[
            "/usr/bin/node",
            "/usr/local/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/bin/nodejs",
        ]
    };
    for c in candidates {
        if std::path::Path::new(c).is_file() {
            return Some(PathBuf::from(c));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join(bin_name);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
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
pub(crate) fn worker_command(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
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
pub(crate) fn spawn_worker(app: &AppHandle) -> Result<(), String> {
    WORKER_READY.store(false, Ordering::SeqCst);
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
    diag_record_spawn(app);
    // The frontend re-syncs (ping + sessions:list) on this event; on first
    // boot the webview is not listening yet, which is fine — it syncs on load.
    let _ = app.emit("worker:event", json!({ "event": "worker:spawned" }));

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
                    // readiness handshake: gate RPC traffic on it
                    if msg.get("event").and_then(|v| v.as_str()) == Some("worker:ready") {
                        WORKER_READY.store(true, Ordering::SeqCst);
                    }
                    let _ = app.emit("worker:event", msg);
                }
            }
        });
    }

    // watcher: the SOLE reaper. Detects worker exit, fails pending RPCs,
    // notifies the frontend, then schedules a respawn with backoff.
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
                WORKER_READY.store(false, Ordering::SeqCst);
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

                // Backoff bookkeeping: a worker that lived long enough was
                // healthy, so its crash restarts the ladder from the bottom.
                let attempt = {
                    let ds = app.state::<DiagState>();
                    let mut d = ds.0.lock().unwrap();
                    let healthy = d
                        .spawned_at
                        .map(|t| t.elapsed() >= HEALTHY_UPTIME)
                        .unwrap_or(false);
                    let attempt = next_attempt(d.restart_attempt, healthy);
                    d.restart_attempt += 1;
                    d.running = false;
                    d.last_error = Some(format!("worker exited ({status})"));
                    d.spawned_at = None;
                    attempt
                };
                schedule_respawn(&app, attempt);
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

/// Schedule an automatic worker respawn after a backoff delay. Aborts if a
/// manual restart happened in the meantime (generation changed) or a worker
/// is already running.
pub(crate) fn schedule_respawn(app: &AppHandle, attempt: u32) {
    let delay = backoff_delay(attempt);
    let gen = RESPAWN_GEN.load(Ordering::Relaxed);
    let _ = app.emit(
        "worker:event",
        json!({
            "event": "worker:restarting",
            "data": { "attempt": attempt + 1, "delay_ms": delay.as_millis() }
        }),
    );
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if gen != RESPAWN_GEN.load(Ordering::Relaxed) {
            return; // a manual restart took over
        }
        if app.state::<WorkerState>().0.lock().unwrap().is_some() {
            return; // already running (manual restart beat us)
        }
        if let Err(e) = spawn_worker(&app) {
            diag_record_failure(&app, e.clone());
            let _ = app.emit(
                "worker:event",
                json!({ "event": "worker:error", "data": { "message": e } }),
            );
            let attempt = {
                let ds = app.state::<DiagState>();
                let mut d = ds.0.lock().unwrap();
                let a = d.restart_attempt;
                d.restart_attempt += 1;
                a
            };
            schedule_respawn(&app, attempt);
        }
    });
}

/// Gracefully stop a worker: SIGTERM, escalate to SIGKILL after the grace
/// period, and reap the child.
pub(crate) fn kill_worker(mut w: Worker) {
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

#[tauri::command]
pub(crate) fn worker_diagnostics(app: AppHandle) -> Value {
    let ds = app.state::<DiagState>();
    let d = ds.0.lock().unwrap();
    json!({
        "running": d.running,
        "last_error": d.last_error,
        "restart_attempt": d.restart_attempt,
        "uptime_ms": d.spawned_at.map(|t| t.elapsed().as_millis()),
    })
}

#[tauri::command]
pub(crate) async fn worker_restart(app: AppHandle) -> Result<Value, String> {
    // Invalidate any pending auto-respawn BEFORE killing, so the old
    // worker's watcher schedules against the new generation and then bails
    // (it will see the fresh worker below already running).
    RESPAWN_GEN.fetch_add(1, Ordering::Relaxed);

    let worker = app.state::<WorkerState>().0.lock().unwrap().take();
    app.state::<StdinState>().0.lock().unwrap().take();
    if let Some(w) = worker {
        kill_worker(w);
    }

    {
        let ds = app.state::<DiagState>();
        let mut d = ds.0.lock().unwrap();
        d.restart_attempt = 0;
    }
    match spawn_worker(&app) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(e) => {
            diag_record_failure(&app, e.clone());
            let _ = app.emit(
                "worker:event",
                json!({ "event": "worker:error", "data": { "message": e } }),
            );
            Err(e)
        }
    }
}

/// Manual retry after "Node.js not found": bump the respawn generation so
/// any pending auto-respawn aborts, reset the backoff ladder, and try to
/// spawn now. Success flows through the normal worker:ready path.
#[tauri::command]
pub(crate) async fn retry_spawn_worker(app: AppHandle) -> Result<Value, String> {
    RESPAWN_GEN.fetch_add(1, Ordering::Relaxed);
    {
        let ds = app.state::<DiagState>();
        let mut d = ds.0.lock().unwrap();
        d.restart_attempt = 0;
    }
    match spawn_worker(&app) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(e) => {
            diag_record_failure(&app, e.clone());
            let _ = app.emit(
                "worker:event",
                json!({ "event": "worker:error", "data": { "message": e } }),
            );
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_ladder_progression() {
        // attempts 0..4 map to the fixed ladder; beyond clamps at the last
        assert_eq!(backoff_delay(0), Duration::from_secs(1));
        assert_eq!(backoff_delay(1), Duration::from_secs(2));
        assert_eq!(backoff_delay(2), Duration::from_secs(5));
        assert_eq!(backoff_delay(3), Duration::from_secs(10));
        assert_eq!(backoff_delay(4), Duration::from_secs(30));
        // clamped: every later crash repeats the 30s rung
        assert_eq!(backoff_delay(5), Duration::from_secs(30));
        assert_eq!(backoff_delay(100), Duration::from_secs(30));
    }

    #[test]
    fn next_attempt_advances_on_unhealthy_exit() {
        // crash loop: each exit advances the ladder (0 -> 1 -> 2)
        assert_eq!(next_attempt(0, false), 0);
        assert_eq!(next_attempt(1, false), 1);
        assert_eq!(next_attempt(2, false), 2);
    }

    #[test]
    fn next_attempt_resets_after_healthy_uptime() {
        // a worker that lived >= HEALTHY_UPTIME restarts the ladder
        assert_eq!(next_attempt(4, true), 0);
        assert_eq!(next_attempt(0, true), 0);
    }

    /// The Rust->worker stdio boundary is the fragile part (spawn, pipe,
    /// newline JSON-RPC, reply routing). Spawn the REAL service-worker.js
    /// (found relative to the test binary) and do a ping/pong roundtrip —
    /// no DHT, no AppHandle, fast. Skipped if the worker isn't reachable
    /// from the test layout (e.g. cargo test --lib in CI where the repo
    /// root is two parents up from target/debug).
    #[test]
    fn worker_stdio_ping_roundtrip() {
        let mut worker_path = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
            .unwrap_or_default();
        // <root>/src-tauri/target/debug/deps/lib-* -> walk up to the repo
        // root, then into service-worker.js at the top level
        for _ in 0..4 {
            worker_path.pop();
        }
        worker_path.push("service-worker.js");
        if !worker_path.is_file() {
            eprintln!("skip: worker not at {worker_path:?} (unusual test layout)");
            return;
        }
        let mut child = std::process::Command::new("node")
            .arg(&worker_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn node worker");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        // send ping, read the pong line
        let mut writer = std::io::BufWriter::new(stdin);
        use std::io::Write;
        writer
            .write_all(b"{\"id\":\"t1\",\"method\":\"ping\",\"params\":{}}\n")
            .unwrap();
        writer.flush().unwrap();
        drop(writer);
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        use std::io::BufRead;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut pong = None;
        while std::time::Instant::now() < deadline {
            line.clear();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("id").and_then(|i| i.as_str()) == Some("t1") {
                    pong = v.get("result").and_then(|r| r.as_str()).map(String::from);
                    break;
                }
            }
        }
        assert_eq!(pong.as_deref(), Some("pong"), "worker ping/pong over stdio");
        let _ = child.kill();
        let _ = child.wait();
    }
}
