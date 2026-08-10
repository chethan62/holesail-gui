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

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

const RPC_TIMEOUT: Duration = Duration::from_secs(90); // DHT bootstrap can take a while
const EXIT_GRACE: Duration = Duration::from_secs(3); // SIGTERM -> SIGKILL escalation on app quit
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
static NEXT_RPC_ID: AtomicU64 = AtomicU64::new(1);
/// Bumped on every manual restart so a pending auto-respawn from an older
/// worker generation aborts instead of double-spawning.
static RESPAWN_GEN: AtomicU64 = AtomicU64::new(1);

fn backoff_delay(attempt: u32) -> Duration {
    BACKOFF[(attempt as usize).min(BACKOFF.len() - 1)]
}

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

/// Diagnostics about the service worker lifecycle, queryable from the UI.
/// Emitted events can be missed (the webview subscribes after setup), so the
/// authoritative status lives here.
#[derive(Default)]
struct WorkerDiag {
    running: bool,
    /// Last spawn failure or unexpected exit, human-readable.
    last_error: Option<String>,
    /// Consecutive crash count driving the respawn backoff.
    restart_attempt: u32,
    spawned_at: Option<Instant>,
}

struct DiagState(Mutex<WorkerDiag>);

/// hs:// URLs delivered before the webview subscribed (startup deep links).
/// The renderer drains them via take_pending_deep_links on boot; live links
/// are also pushed here so nothing is lost if the UI is reloaded.
struct PendingDeepLinks(Mutex<Vec<String>>);

fn queue_deep_link(app: &AppHandle, url: String) {
    if !url.starts_with("hs://") {
        return;
    }
    app.state::<PendingDeepLinks>().0.lock().unwrap().push(url.clone());
    let _ = app.emit(
        "app:event",
        json!({ "event": "deep-link:open", "data": { "url": url } }),
    );
}

#[tauri::command]
fn take_pending_deep_links(app: AppHandle) -> Vec<String> {
    std::mem::take(&mut app.state::<PendingDeepLinks>().0.lock().unwrap())
}

/// App version + embedded short git hash — lets the UI identify exactly
/// which build is installed (identical versions across CI builds are
/// otherwise indistinguishable on-device).
#[tauri::command]
fn version_info(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "gitHash": env!("GIT_HASH"),
    })
}

/* --------------------------- saved tunnels ---------------------------- */

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedTunnel {
    id: String,
    name: String,
    kind: String, // "server" | "client"
    key: String,  // server: fixed key hex; client: full hs:// string
    port: Option<u16>,
    host: Option<String>,
    udp: bool,
    autostart: bool,
    created_at: u64,
}

struct SavedStore(Mutex<Vec<SavedTunnel>>);

fn saved_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("saved-tunnels.json")
}

fn saved_persist(app: &AppHandle, store: &SavedStore) {
    let data = serde_json::to_string_pretty(&*store.0.lock().unwrap()).unwrap_or_else(|_| "[]".into());
    let path = saved_path(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, data);
}

/// Keep login autostart in sync with saved tunnels: on when any tunnel
/// wants it, off when none do. Desktop only (mobile has no login session).
#[cfg(desktop)]
fn autostart_sync(app: &AppHandle, store: &SavedStore) {
    use tauri_plugin_autostart::ManagerExt;
    let want = store.0.lock().unwrap().iter().any(|t| t.autostart);
    let la = app.autolaunch();
    let on = la.is_enabled().unwrap_or(false);
    if want && !on {
        let _ = la.enable();
    } else if !want && on {
        let _ = la.disable();
    }
}

#[cfg(not(desktop))]
fn autostart_sync(_app: &AppHandle, _store: &SavedStore) {}

fn next_id() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        N.fetch_add(1, Ordering::SeqCst)
    )
}

#[tauri::command]
fn saved_list(store: State<SavedStore>) -> Vec<SavedTunnel> {
    store.0.lock().unwrap().clone()
}

#[tauri::command]
fn saved_save(app: AppHandle, store: State<SavedStore>, tunnel: SavedTunnel) -> SavedTunnel {
    let mut t = tunnel;
    if t.id.is_empty() {
        t.id = next_id();
    }
    if t.name.is_empty() {
        t.name = t.kind.clone();
    }
    {
        let mut list = store.0.lock().unwrap();
        if let Some(existing) = list.iter_mut().find(|x| x.id == t.id) {
            *existing = t.clone();
        } else {
            list.push(t.clone());
        }
    }
    saved_persist(&app, &store);
    autostart_sync(&app, &store);
    t
}

#[tauri::command]
fn saved_delete(app: AppHandle, store: State<SavedStore>, id: String) {
    store.0.lock().unwrap().retain(|t| t.id != id);
    saved_persist(&app, &store);
    autostart_sync(&app, &store);
}

#[tauri::command]
fn saved_duplicate(app: AppHandle, store: State<SavedStore>, id: String) -> Option<SavedTunnel> {
    let copy = {
        let mut list = store.0.lock().unwrap();
        let mut c = list.iter().find(|t| t.id == id).cloned()?;
        c.id = next_id();
        c.name = format!("{} (copy)", c.name);
        list.push(c.clone());
        c
    };
    saved_persist(&app, &store);
    Some(copy)
}

#[tauri::command]
fn saved_export(store: State<SavedStore>) -> String {
    serde_json::to_string_pretty(&*store.0.lock().unwrap()).unwrap_or_else(|_| "[]".into())
}

#[tauri::command]
fn saved_import(app: AppHandle, store: State<SavedStore>, json: String) -> usize {
    let parsed: Vec<SavedTunnel> = match serde_json::from_str(&json) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    {
        let mut list = store.0.lock().unwrap();
        for mut t in parsed {
            if t.id.is_empty() {
                t.id = next_id();
            }
            if let Some(existing) = list.iter_mut().find(|x| x.id == t.id) {
                *existing = t;
            } else {
                list.push(t);
            }
        }
    }
    saved_persist(&app, &store);
    autostart_sync(&app, &store);
    store.0.lock().unwrap().len()
}

fn diag_record_spawn(app: &AppHandle) {
    let ds = app.state::<DiagState>();
    let mut d = ds.0.lock().unwrap();
    d.running = true;
    d.last_error = None;
    d.spawned_at = Some(Instant::now());
}

fn diag_record_failure(app: &AppHandle, msg: String) {
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
fn worker_command(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    if let Ok(dir) = app.path().resource_dir() {
        let bare = dir.join("bare");
        let worker = dir.join("service-worker.js");
        if bare.is_file() && worker.is_file() {
            return Ok((bare, worker));
        }
    }
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
                    if healthy {
                        d.restart_attempt = 0;
                    }
                    let attempt = d.restart_attempt;
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
fn schedule_respawn(app: &AppHandle, attempt: u32) {
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
fn kill_worker(mut w: Worker) {
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
fn worker_diagnostics(app: AppHandle) -> Value {
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
async fn worker_restart(app: AppHandle) -> Result<Value, String> {
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

/// System tray: show/hide the window, stop all tunnels, quit. The app lives
/// in the tray once the window is closed (close = hide, not exit).
#[cfg(desktop)]
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "Show Holesail GUI", true, None::<&str>)?;
    let stop_all = MenuItem::with_id(app, "stop-all", "Stop all tunnels", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &stop_all, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("app icon").clone())
        .tooltip("Holesail GUI — peer-to-peer tunnels")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            // the renderer owns the session list — ask it to stop everything
            "stop-all" => {
                let _ = app.emit("app:event", json!({ "event": "tray:stop-all" }));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Close-to-tray: the window close button hides the window instead of
/// exiting (desktop only — mobile has no close button semantics). Quit
/// happens from the tray menu, which triggers RunEvent::Exit and the
/// worker teardown in run().
fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    #[cfg(desktop)]
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
    // mobile: nothing to do (no close button semantics); silence unused params
    #[cfg(not(desktop))]
    let _ = (window, event);
}

/// Tauri application entry point (desktop via src/main.rs, mobile via the
/// generated Android/iOS entry).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // MUST be the first plugin registered. With the "deep-link" feature it
    // routes hs:// argv deep links into the first instance; the on_open_url
    // handler below fires in the running instance. Desktop only — mobile
    // apps have no CLI instances to dedupe.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // A second launch happened (e.g. the window is hidden in the
        // tray): bring the running instance to the front.
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
        // Belt and braces: the plugin integration usually fires
        // on_open_url for configured schemes, but argv is the ground
        // truth on Linux/Windows.
        for arg in argv.iter().skip(1) {
            queue_deep_link(app, arg.clone());
        }
    }));

    // Login autostart for permanent tunnels (desktop only; mobile has no
    // login session to hook into).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));

    builder
        .plugin(tauri_plugin_deep_link::init())
        .manage(PendingState(Mutex::new(HashMap::new())))
        .manage(DiagState(Mutex::new(WorkerDiag::default())))
        .manage(PendingDeepLinks(Mutex::new(Vec::new())))
        .on_window_event(handle_window_event)
        .setup(|app| {
            app.manage(WorkerState(Mutex::new(None)));
            app.manage(StdinState(Mutex::new(None)));
            // Saved tunnels (temp/permanent) persisted under the app config
            // dir; autostart follows the saved tunnels' preferences.
            app.manage(SavedStore(Mutex::new(
                std::fs::read_to_string(saved_path(app.handle()))
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
            )));
            autostart_sync(app.handle(), &app.state::<SavedStore>());

            #[cfg(desktop)]
            setup_tray(app.handle())?;

            // Deep links: deliver startup URLs via the pending queue (the
            // webview is not listening for events yet) and forward live ones
            // to the renderer as app:event messages.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    queue_deep_link(&handle, url.to_string());
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    queue_deep_link(app.handle(), url.to_string());
                }
            }
            // Linux/Windows: make this binary the handler for hs:// links
            // (writes a per-user .desktop entry / registry key). macOS and
            // Android use the statically configured schemes instead.
            #[cfg(desktop)]
            if let Err(e) = app.deep_link().register("hs") {
                eprintln!("Failed to register hs:// deep link: {e}");
            }

            // A missing or incompatible worker runtime (no node on desktop, no
            // extracted bundle on Android) must not kill the app: record it in
            // the diagnostics state (the webview is not listening for events
            // yet at this point, so emitting alone would lose it) and retry
            // with backoff — a runtime installed later will be picked up.
            if let Err(e) = spawn_worker(app.handle()) {
                eprintln!("Failed to spawn holesail service worker: {}", e);
                diag_record_failure(app.handle(), e.clone());
                let _ = app.emit(
                    "worker:event",
                    json!({ "event": "worker:error", "data": { "message": e } }),
                );
                schedule_respawn(app.handle(), 0);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc,
            worker_diagnostics,
            worker_restart,
            take_pending_deep_links,
            version_info,
            saved_list,
            saved_save,
            saved_delete,
            saved_duplicate,
            saved_export,
            saved_import
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                // No respawn on shutdown: any pending timer will find the
                // process gone before it fires, but bump the generation so a
                // racing respawn aborts immediately.
                RESPAWN_GEN.fetch_add(1, Ordering::Relaxed);
                let worker = app_handle.state::<WorkerState>().0.lock().unwrap().take();
                let _stdin = app_handle.state::<StdinState>().0.lock().unwrap().take();
                if let Some(w) = worker {
                    kill_worker(w);
                }
            }
        });
}
