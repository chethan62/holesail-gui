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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

const RPC_TIMEOUT: Duration = Duration::from_secs(30); // hung worker surfaces fast
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
/// Set when the worker's `worker:ready` handshake arrives; reset on every
/// spawn/exit. RPCs issued before ready fail fast instead of riding the
/// full RPC_TIMEOUT against a worker that is still initializing.
static WORKER_READY: AtomicBool = AtomicBool::new(false);

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
        // The updater plugin is registered #[cfg(desktop)] only; the
        // renderer uses this to decide whether to show the ⬆ check button.
        "updater": cfg!(desktop),
    })
}

/// Trim `text` to at most `cap` bytes, dropping only whole lines from the
/// front. Kept pure so the edge cases are unit-testable. The cap may fall
/// inside a multibyte UTF-8 char (log lines contain emoji, '…', etc.) —
/// the start index is floored to a char boundary first.
fn trim_to_cap(text: String, cap: usize) -> String {
    if text.len() <= cap {
        return text;
    }
    let keep_from = text.floor_char_boundary(text.len() - cap);
    match text[keep_from..].find('\n') {
        // drop through the first line break inside the kept window so the
        // result never starts mid-line
        Some(pos) => text[keep_from + pos + 1..].to_string(),
        None => text[keep_from..].to_string(),
    }
}

/// The event log can carry tunnel URLs / session params from log lines —
/// keep it owner-only, like the saved-tunnels store (0600 on unix).
fn restrict_log_perms(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Append a renderer log line to the persistent event log so history
/// survives restarts (bug reports). File: <app_config_dir>/event-log.txt,
/// capped at 64 KiB (whole-line trim, see trim_to_cap).
#[tauri::command]
fn log_append(app: AppHandle, line: String) {
    const LOG_MAX_BYTES: usize = 64 * 1024;
    let Ok(config_dir) = app.path().app_config_dir() else {
        return;
    };
    let path = config_dir.join("event-log.txt");
    let Ok(mut cur) = std::fs::read_to_string(&path) else {
        let _ = std::fs::create_dir_all(&config_dir);
        let _ = std::fs::write(&path, format!("{line}\n"));
        restrict_log_perms(&path);
        return;
    };
    cur.push_str(&line);
    cur.push('\n');
    let _ = std::fs::write(&path, trim_to_cap(cur, LOG_MAX_BYTES));
    restrict_log_perms(&path);
}

/// The machine's primary LAN IPv4 address (e.g. 192.168.29.94). Server
/// session cards show a "LAN access" URL built from it, so a phone on the
/// same network can reach the shared service directly — no DHT, no
/// hole-punching. Falls back to 127.0.0.1 when no LAN address exists.
#[tauri::command]
fn lan_address() -> String {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

#[tauri::command]
fn home_dir() -> String {
    std::env::var_os("HOME")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/* --------------------------- saved tunnels ---------------------------- */

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedTunnel {
    id: String,
    name: String,
    kind: String, // "server" | "client" | "filemanager"
    key: String,  // server/filemanager: fixed key hex; client: full hs:// string
    port: Option<u16>,
    host: Option<String>,
    /// Folder path for filemanager-kind tunnels (the Livefiles share root).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// Livefiles auth (filemanager kind): role / username / password.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    /// Secure (private) mode. Servers: controls the keypair derivation —
    /// private vs public derive DIFFERENT keys, so this must be persisted.
    /// Defaults to true for saved tunnels created before this field existed.
    #[serde(default = "default_true")]
    secure: bool,
    #[serde(default)]
    udp: bool,
    #[serde(default)]
    autostart: bool,
    #[serde(default)]
    created_at: u64,
}

fn default_true() -> bool {
    true
}

struct SavedStore(Mutex<Vec<SavedTunnel>>);

/* ------------------------------ recent keys ------------------------------ */
// Recent connection strings are credentials. Desktop: stored in the OS
// keychain (Secret Service / Keychain / Credential Manager) via the keyring
// crate, falling back to a 0600 file when no keychain daemon is reachable.
// Android (no keyring support): 0600 file beside saved-tunnels.json. The
// renderer never keeps these in web storage anymore.

const RECENT_MAX: usize = 10;

struct RecentStore(Mutex<Vec<String>>);

fn recent_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("recent-keys.json")
}

fn recent_load_file(app: &AppHandle) -> Vec<String> {
    std::fs::read_to_string(recent_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn recent_write_file(app: &AppHandle, list: &[String]) {
    let path = recent_path(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let data = serde_json::to_string_pretty(list).unwrap_or_else(|_| "[]".into());
    let _ = std::fs::write(&path, data);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
}

#[cfg(desktop)]
fn recent_load(app: &AppHandle) -> Vec<String> {
    if let Ok(entry) = keyring::Entry::new("io.holesail.gui", "recent-keys") {
        if let Ok(s) = entry.get_password() {
            if let Ok(v) = serde_json::from_str::<Vec<String>>(&s) {
                return v;
            }
        }
    }
    recent_load_file(app)
}

#[cfg(not(desktop))]
fn recent_load(app: &AppHandle) -> Vec<String> {
    recent_load_file(app)
}

#[cfg(desktop)]
fn recent_persist(app: &AppHandle, list: &[String]) {
    let data = serde_json::to_string(list).unwrap_or_else(|_| "[]".into());
    if let Ok(entry) = keyring::Entry::new("io.holesail.gui", "recent-keys") {
        if entry.set_password(&data).is_ok() {
            return;
        }
    }
    recent_write_file(app, list);
}

#[cfg(not(desktop))]
fn recent_persist(app: &AppHandle, list: &[String]) {
    recent_write_file(app, list);
}

/// Dedupe + front-insert + truncate, shared by the command and tests.
fn recent_push(list: &mut Vec<String>, label: &str) {
    list.retain(|x| x != label);
    list.insert(0, label.to_string());
    list.truncate(RECENT_MAX);
}

#[tauri::command]
fn recent_list(store: State<RecentStore>) -> Vec<String> {
    store.0.lock().unwrap().clone()
}

#[tauri::command]
fn recent_add(app: AppHandle, store: State<RecentStore>, label: String) {
    let snapshot = {
        let mut list = store.0.lock().unwrap();
        recent_push(&mut list, &label);
        list.clone()
    };
    recent_persist(&app, &snapshot);
}

#[tauri::command]
fn recent_clear(app: AppHandle, store: State<RecentStore>) {
    store.0.lock().unwrap().clear();
    recent_persist(&app, &[]);
}

fn saved_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("saved-tunnels.json")
}

/// Keychain service/account for the saved-tunnel store. Tunnel keys AND
/// filemanager passwords are credentials, so on desktop the whole list lives
/// in the OS keychain (encrypted at rest), not just the 0600 file.
const SAVED_KEYRING_SERVICE: &str = "io.holesail.gui";
const SAVED_KEYRING_ACCOUNT: &str = "saved-tunnels";

fn saved_serialize(store: &SavedStore) -> String {
    serde_json::to_string_pretty(&*store.0.lock().unwrap()).unwrap_or_else(|_| "[]".into())
}

/// Write the list to the 0600 file (the keychain fallback, and the only path
/// on Android where no keyring daemon exists).
fn saved_write_file(app: &AppHandle, data: &str) {
    let path = saved_path(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, data);
    // The file holds private tunnel keys — never world-readable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
}

/// Load saved tunnels. Returns (list, from_keychain) — the flag lets the
/// caller migrate a legacy plaintext file into the keychain on first launch
/// after upgrade, without prompting every subsequent launch.
#[cfg(desktop)]
fn saved_load(app: &AppHandle) -> (Vec<SavedTunnel>, bool) {
    if let Ok(entry) = keyring::Entry::new(SAVED_KEYRING_SERVICE, SAVED_KEYRING_ACCOUNT) {
        if let Ok(s) = entry.get_password() {
            if let Ok(v) = serde_json::from_str::<Vec<SavedTunnel>>(&s) {
                return (v, true);
            }
        }
    }
    let from_file = std::fs::read_to_string(saved_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    (from_file, false)
}

#[cfg(not(desktop))]
fn saved_load(app: &AppHandle) -> (Vec<SavedTunnel>, bool) {
    let from_file = std::fs::read_to_string(saved_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    (from_file, false)
}

#[cfg(desktop)]
fn saved_persist(app: &AppHandle, store: &SavedStore) {
    let data = saved_serialize(store);
    if let Ok(entry) = keyring::Entry::new(SAVED_KEYRING_SERVICE, SAVED_KEYRING_ACCOUNT) {
        if entry.set_password(&data).is_ok() {
            // Credentials now live encrypted in the keychain — drop the
            // plaintext fallback file so a stale copy can't outlive it.
            let _ = std::fs::remove_file(saved_path(app));
            return;
        }
    }
    saved_write_file(app, &data);
}

#[cfg(not(desktop))]
fn saved_persist(app: &AppHandle, store: &SavedStore) {
    saved_write_file(app, &saved_serialize(store));
}

/// Keep login autostart in sync with saved tunnels: on when any tunnel
/// wants it, off when none do. Desktop only (mobile has no login session).
#[cfg(desktop)]
fn autostart_sync(app: &AppHandle, store: &SavedStore) {
    use tauri_plugin_autostart::ManagerExt;
    let want = saved_wants_autostart(store);
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

/// Core upsert (insert or replace by id), filling id/name when empty.
/// Pure — no AppHandle, so it is unit-testable.
fn saved_upsert(store: &SavedStore, mut t: SavedTunnel) -> SavedTunnel {
    if t.id.is_empty() {
        t.id = next_id();
    }
    if t.name.is_empty() {
        t.name = t.kind.clone();
    }
    let mut list = store.0.lock().unwrap();
    if let Some(existing) = list.iter_mut().find(|x| x.id == t.id) {
        *existing = t.clone();
    } else {
        list.push(t.clone());
    }
    t
}

#[tauri::command]
fn saved_save(app: AppHandle, store: State<SavedStore>, tunnel: SavedTunnel) -> SavedTunnel {
    let t = saved_upsert(&store, tunnel);
    saved_persist(&app, &store);
    autostart_sync(&app, &store);
    t
}

/// Core remove by id. Pure.
fn saved_remove(store: &SavedStore, id: &str) {
    store.0.lock().unwrap().retain(|t| t.id != id);
}

#[tauri::command]
fn saved_delete(app: AppHandle, store: State<SavedStore>, id: String) {
    saved_remove(&store, &id);
    saved_persist(&app, &store);
    autostart_sync(&app, &store);
}

/// Core duplicate: new id, "(copy)" name. Returns the copy or None. Pure.
fn saved_duplicate_core(store: &SavedStore, id: &str) -> Option<SavedTunnel> {
    let mut list = store.0.lock().unwrap();
    let mut c = list.iter().find(|t| t.id == id).cloned()?;
    c.id = next_id();
    c.name = format!("{} (copy)", c.name);
    list.push(c.clone());
    Some(c)
}

#[tauri::command]
fn saved_duplicate(app: AppHandle, store: State<SavedStore>, id: String) -> Option<SavedTunnel> {
    let copy = saved_duplicate_core(&store, &id)?;
    saved_persist(&app, &store);
    Some(copy)
}

#[tauri::command]
fn saved_export(store: State<SavedStore>) -> String {
    serde_json::to_string_pretty(&*store.0.lock().unwrap()).unwrap_or_else(|_| "[]".into())
}

/// Core import: merge parsed tunnels by id (new ids for empty ones).
/// Returns the new store length. Pure.
fn saved_import_core(store: &SavedStore, json: &str) -> usize {
    let parsed: Vec<SavedTunnel> = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return 0,
    };
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
    list.len()
}

#[tauri::command]
fn saved_import(app: AppHandle, store: State<SavedStore>, json: String) -> usize {
    let len = saved_import_core(&store, &json);
    if len > 0 {
        saved_persist(&app, &store);
        autostart_sync(&app, &store);
    }
    len
}

/// Does any saved tunnel want login autostart? Pure (used by autostart_sync).
fn saved_wants_autostart(store: &SavedStore) -> bool {
    store.0.lock().unwrap().iter().any(|t| t.autostart)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(items: Vec<SavedTunnel>) -> SavedStore {
        SavedStore(Mutex::new(items))
    }

    fn tunnel(id: &str, kind: &str, autostart: bool) -> SavedTunnel {
        SavedTunnel {
            id: id.to_string(),
            name: format!("tunnel-{id}"),
            kind: kind.to_string(),
            key: "k".repeat(64),
            port: Some(8080),
            host: Some("127.0.0.1".into()),
            path: None,
            role: None,
            username: None,
            password: None,
            secure: true,
            udp: false,
            autostart,
            created_at: 1,
        }
    }

    #[test]
    fn upsert_fills_id_and_name() {
        let store = store_with(vec![]);
        let saved = saved_upsert(
            &store,
            SavedTunnel {
                id: String::new(),
                name: String::new(),
                kind: "server".into(),
                key: "k".repeat(64),
                port: Some(1),
                host: None,
                path: None,
                role: None,
                username: None,
                password: None,
                secure: true,
                udp: false,
                autostart: false,
                created_at: 2,
            },
        );
        assert!(!saved.id.is_empty());
        assert_eq!(saved.name, "server");
        assert_eq!(store.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn upsert_replaces_existing_id_without_duplicating() {
        let store = store_with(vec![tunnel("a", "server", false)]);
        let mut updated = tunnel("a", "client", true);
        updated.name = "renamed".into();
        let saved = saved_upsert(&store, updated);
        assert_eq!(saved.name, "renamed");
        let list = store.0.lock().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, "client");
        assert!(list[0].autostart);
    }

    #[test]
    fn delete_removes_by_id() {
        let store = store_with(vec![tunnel("a", "server", false), tunnel("b", "client", false)]);
        saved_remove(&store, "a");
        let list = store.0.lock().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "b");
    }

    #[test]
    fn duplicate_creates_new_id_and_copy_name() {
        let store = store_with(vec![tunnel("a", "server", true)]);
        let copy = saved_duplicate_core(&store, "a").expect("copy");
        assert_ne!(copy.id, "a");
        assert!(copy.name.contains("(copy)"));
        assert_eq!(store.0.lock().unwrap().len(), 2);
    }

    #[test]
    fn duplicate_missing_id_returns_none() {
        let store = store_with(vec![]);
        assert!(saved_duplicate_core(&store, "nope").is_none());
    }

    #[test]
    fn import_merges_and_counts() {
        let store = store_with(vec![tunnel("a", "server", false)]);
        let json = serde_json::json!([
            { "id": "a", "name": "replaced", "kind": "server", "key": "k", "port": 1, "secure": true, "udp": false, "autostart": true, "createdAt": 1 },
            { "id": "b", "name": "new", "kind": "client", "key": "hs://x", "port": null, "secure": false, "udp": false, "autostart": false, "createdAt": 2 }
        ])
        .to_string();
        let len = saved_import_core(&store, &json);
        assert_eq!(len, 2);
        let list = store.0.lock().unwrap();
        assert_eq!(list[0].name, "replaced"); // existing id replaced
        assert_eq!(list[1].id, "b");
    }

    #[test]
    fn import_invalid_json_returns_zero_and_keeps_store() {
        let store = store_with(vec![tunnel("a", "server", false)]);
        assert_eq!(saved_import_core(&store, "not json"), 0);
        assert_eq!(store.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn legacy_json_without_secure_defaults_to_private() {
        // tunnels saved before the `secure` field existed must deserialize
        // as private (secure=true) — otherwise a public permanent server
        // would silently become private (different keypair) on restart
        let legacy = r#"[{"id":"x","name":"old","kind":"server","key":"k","port":1,"udp":false,"autostart":true,"createdAt":1}]"#;
        let parsed: Vec<SavedTunnel> = serde_json::from_str(legacy).expect("legacy parses");
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].secure, "legacy entries must default to private");
    }

    #[test]
    fn autostart_wants_true_when_any_tunnel_asks() {
        let store = store_with(vec![tunnel("a", "server", false), tunnel("b", "client", true)]);
        assert!(saved_wants_autostart(&store));
        let store2 = store_with(vec![tunnel("a", "server", false)]);
        assert!(!saved_wants_autostart(&store2));
    }

    #[test]
    fn recent_push_dedupes_and_caps() {
        let mut list = vec!["a".to_string(), "b".to_string()];
        recent_push(&mut list, "c");
        assert_eq!(list, vec!["c", "a", "b"]);
        // re-adding an existing label moves it to the front, no duplicate
        recent_push(&mut list, "a");
        assert_eq!(list, vec!["a", "c", "b"]);
        // never more than RECENT_MAX entries
        for i in 0..20 {
            recent_push(&mut list, &format!("k{i}"));
        }
        assert_eq!(list.len(), RECENT_MAX);
        assert_eq!(list[0], "k19");
    }

    /// Roundtrip through the OS keychain where a Secret Service daemon is
    /// reachable (CI has none → the test skips itself instead of failing).
    #[test]
    #[cfg(desktop)]
    fn keyring_roundtrip_or_skip() {
        let entry = match keyring::Entry::new("io.holesail.gui.test", "smoke") {
            Ok(e) => e,
            Err(_) => {
                eprintln!("skip: keyring backend unavailable");
                return;
            }
        };
        if entry.set_password("hello").is_err() {
            eprintln!("skip: no keyring daemon reachable");
            return;
        }
        assert_eq!(entry.get_password().unwrap_or_default(), "hello");
        let _ = entry.delete_credential();
    }

    /// The saved-tunnel store is a single keychain secret (encrypting tunnel
    /// keys AND filemanager passwords together). Verify the serialize/parse
    /// roundtrip shape the keychain path uses, including the password field.
    #[test]
    fn saved_serialize_roundtrip_carries_secrets() {
        let mut fm = tunnel("fm", "filemanager", true);
        fm.password = Some("s3cr3t".into());
        fm.username = Some("admin".into());
        let store = store_with(vec![fm]);
        let json = saved_serialize(&store);
        let back: Vec<SavedTunnel> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].password.as_deref(), Some("s3cr3t"));
        assert_eq!(back[0].username.as_deref(), Some("admin"));
        assert_eq!(back[0].key.len(), 64); // tunnel key rides along, encrypted at rest
    }

    #[test]
    fn saved_json_roundtrip() {
        let store = store_with(vec![tunnel("a", "server", true)]);
        let json = serde_json::to_string(&*store.0.lock().unwrap()).unwrap();
        let back: Vec<SavedTunnel> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].id, "a");
        assert!(back[0].secure);
    }

    #[test]
    fn saved_filemanager_roundtrip_preserves_path_and_auth() {
        let mut t = tunnel("fm", "filemanager", true);
        t.path = Some("/home/user/Downloads".into());
        t.role = Some("admin".into());
        t.username = Some("admin".into());
        t.password = Some("secret".into());
        let json = serde_json::to_string(&t).unwrap();
        let back: SavedTunnel = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, "filemanager");
        assert_eq!(back.path.as_deref(), Some("/home/user/Downloads"));
        assert_eq!(back.role.as_deref(), Some("admin"));
        assert_eq!(back.username.as_deref(), Some("admin"));
        assert_eq!(back.password.as_deref(), Some("secret"));
        // absent path on a legacy server entry parses as None
        let legacy = serde_json::from_str::<SavedTunnel>(
            r#"{"id":"x","name":"x","kind":"server","key":"kk","port":1,"host":null,"secure":true,"udp":false,"autostart":false,"createdAt":1}"#,
        )
        .unwrap();
        assert!(legacy.path.is_none());
        assert_eq!(legacy.kind, "server");
    }

    #[test]
    fn saved_tunnel_missing_optional_fields_deserialize() {
        // A caller omitting udp/autostart/createdAt (e.g. the filemanager
        // save path before it sent udp) must NOT fail deserialization —
        // serde defaults these to false/false/0. This was the root cause of
        // "Failed to share folder: undefined" (missing `udp` field rejected
        // the whole SavedTunnel, and the raw invoke string collapsed to
        // undefined at the bridge).
        let t = serde_json::from_str::<SavedTunnel>(
            r#"{"id":"f","name":"f","kind":"filemanager","key":"kk","secure":true,"path":"/tmp/x"}"#,
        )
        .unwrap();
        assert_eq!(t.kind, "filemanager");
        assert_eq!(t.path.as_deref(), Some("/tmp/x"));
        assert!(!t.udp);
        assert!(!t.autostart);
        assert_eq!(t.created_at, 0);
    }

    // ---- trim_to_cap (event log) ----

    #[test]
    fn trim_keeps_short_text_unchanged() {
        let s = "line one\nline two\n".to_string();
        assert_eq!(trim_to_cap(s.clone(), 1024), s);
    }

    #[test]
    fn trim_drops_whole_lines_from_front() {
        let s = "aaaa\nbbbb\ncccc\n".to_string(); // 15 bytes
        // cap 10 -> keep_from 5 lands inside "bbbb"; the kept window
        // "bb\ncccc\n" drops through its first newline -> "cccc\n"
        let t = trim_to_cap(s, 10);
        assert_eq!(t, "cccc\n");
        assert!(t.len() <= 10);
    }

    #[test]
    fn trim_at_exact_cap_is_noop() {
        let s = "aaaa\nbbbb\ncccc\n".to_string();
        assert_eq!(trim_to_cap(s.clone(), s.len()), s);
    }

    #[test]
    fn trim_without_newline_keeps_tail() {
        assert_eq!(trim_to_cap("0123456789".to_string(), 4), "6789");
    }

    #[test]
    fn trim_empty_is_empty() {
        assert_eq!(trim_to_cap(String::new(), 10), "");
    }

    #[test]
    fn trim_never_splits_multibyte_chars() {
        // '…' is 3 bytes; cap lands keep_from inside it (byte 5 of 15).
        // Would panic without floor_char_boundary.
        let s = "aaa\n…bbb\nccc\n".to_string();
        let t = trim_to_cap(s, 10);
        assert_eq!(t, "ccc\n");
    }

    // ---- worker lifecycle (backoff + respawn ladder) ----

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
        let bare = dir.join(&bare_name);
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
#[cfg(not(target_os = "android"))]
fn find_node() -> Option<PathBuf> {
    let candidates = [
        "/usr/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/nodejs",
    ];
    for c in candidates {
        if std::path::Path::new(c).is_file() {
            return Some(PathBuf::from(c));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("node");
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

/// Manual retry after "Node.js not found": bump the respawn generation so
/// any pending auto-respawn aborts, reset the backoff ladder, and try to
/// spawn now. Success flows through the normal worker:ready path.
#[tauri::command]
async fn retry_spawn_worker(app: AppHandle) -> Result<Value, String> {
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

#[tauri::command]
async fn rpc(
    stdin: State<'_, StdinState>,
    pending: State<'_, PendingState>,
    method: String,
    params: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    if !WORKER_READY.load(Ordering::SeqCst) {
        return Err("Service worker is still starting up".to_string());
    }
    // Trust boundary: this command is the only path from the sandboxed
    // webview to the worker. The worker's own dispatch() already rejects
    // unknown methods (its `default` arm throws), so an allowlist here is
    // defense-in-depth, not a correctness requirement — but it means a
    // compromised renderer can only ever reach the methods it legitimately
    // uses, even if the worker's surface grows later. Keep this in sync
    // with service-worker.js dispatch().
    const ALLOWED: &[&str] = &[
        "ping",
        "server:start",
        "client:connect",
        "filemanager:start",
        "session:stop",
        "session:pause",
        "session:resume",
        "sessions:list",
        "lookup",
    ];
    if !ALLOWED.contains(&method.as_str()) {
        return Err(format!("Method not allowed: {method}"));
    }
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

    let timeout = match timeout_ms {
        Some(ms) if ms > 0 => Duration::from_millis(ms),
        _ => RPC_TIMEOUT,
    };
    match tokio::time::timeout(timeout, rx).await {
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

    // Update checking (desktop only — there is no updater on Android).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

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
            // dir; autostart follows the saved tunnels' preferences. On
            // desktop the list (tunnel keys + filemanager passwords) lives
            // in the OS keychain; the 0600 file is the no-daemon fallback.
            let (saved_list, from_keychain) = saved_load(app.handle());
            app.manage(SavedStore(Mutex::new(saved_list)));
            // One-time migration: if we loaded from the legacy plaintext
            // file (or nothing), persist now so the credentials move into
            // the keychain and the plaintext copy is removed.
            #[cfg(desktop)]
            if !from_keychain {
                saved_persist(app.handle(), &app.state::<SavedStore>());
            }
            autostart_sync(app.handle(), &app.state::<SavedStore>());
            app.manage(RecentStore(Mutex::new(recent_load(app.handle()))));

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
            // FLATPAK: skip — the sandbox home isn't writable for a
            // .desktop entry, and the shipped flatpak .desktop file already
            // declares x-scheme-handler/hs (deep-link register() would fail
            // with "No such file or directory" and abort setup).
            #[cfg(desktop)]
            if std::env::var_os("FLATPAK_ID").is_none() {
                if let Err(e) = app.deep_link().register("hs") {
                    eprintln!("Failed to register hs:// deep link: {e}");
                }
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
            retry_spawn_worker,
            take_pending_deep_links,
            version_info,
            lan_address,
            home_dir,
            log_append,
            saved_list,
            saved_save,
            saved_delete,
            saved_duplicate,
            saved_export,
            saved_import,
            recent_list,
            recent_add,
            recent_clear
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
