/* saved.rs — saved-tunnel (permanent tunnel) persistence + CRUD commands.
 *
 * The list (tunnel keys AND filemanager passwords — credentials) is stored
 * in the OS keychain on desktop (Secret Service / Keychain / Credential
 * Manager) via the keyring crate, falling back to a 0600 file when no
 * keychain daemon is reachable. Android (no keyring): 0600 file only.
 */

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedTunnel {
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
    /// Per-session bandwidth cap in bytes/sec (0 = unlimited). Persisted so
    /// permanent/saved tunnels keep their cap across restarts.
    #[serde(default)]
    limit: u64,
    #[serde(default)]
    autostart: bool,
    #[serde(default)]
    created_at: u64,
}

fn default_true() -> bool {
    true
}

pub(crate) struct SavedStore(pub(crate) Mutex<Vec<SavedTunnel>>);

fn saved_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("saved-tunnels.json")
}

/// Keychain service/account for the saved-tunnel store.
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
pub(crate) fn saved_load(app: &AppHandle) -> (Vec<SavedTunnel>, bool) {
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
pub(crate) fn saved_load(app: &AppHandle) -> (Vec<SavedTunnel>, bool) {
    let from_file = std::fs::read_to_string(saved_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    (from_file, false)
}

#[cfg(desktop)]
pub(crate) fn saved_persist(app: &AppHandle, store: &SavedStore) {
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
pub(crate) fn saved_persist(app: &AppHandle, store: &SavedStore) {
    saved_write_file(app, &saved_serialize(store));
}

/// Keep login autostart in sync with saved tunnels: on when any tunnel
/// wants it, off when none do. Desktop only (mobile has no login session).
#[cfg(desktop)]
pub(crate) fn autostart_sync(app: &AppHandle, store: &SavedStore) {
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
pub(crate) fn autostart_sync(_app: &AppHandle, _store: &SavedStore) {}

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
pub(crate) fn saved_list(store: State<SavedStore>) -> Vec<SavedTunnel> {
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
pub(crate) fn saved_save(
    app: AppHandle,
    store: State<SavedStore>,
    tunnel: SavedTunnel,
) -> SavedTunnel {
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
pub(crate) fn saved_delete(app: AppHandle, store: State<SavedStore>, id: String) {
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
pub(crate) fn saved_duplicate(app: AppHandle, store: State<SavedStore>, id: String) -> Option<SavedTunnel> {
    let copy = saved_duplicate_core(&store, &id)?;
    saved_persist(&app, &store);
    Some(copy)
}

#[tauri::command]
pub(crate) fn saved_export(store: State<SavedStore>) -> String {
    serde_json::to_string_pretty(&*store.0.lock().unwrap()).unwrap_or_else(|_| "[]".into())
}

/// Cap on how many saved tunnels the import path will accept. Matches the
/// worker's MAX_SESSIONS philosophy: a pasted/huge/malformed export must
/// not bloat the keychain-backed store without bound. (Legitimate users
/// don't exceed this; the Saved tab is a small curated list.)
const MAX_SAVED_TUNNELS: usize = 100;

/// Core import: merge parsed tunnels by id (new ids for empty ones).
/// Returns the new store length. Pure.
fn saved_import_core(store: &SavedStore, json: &str) -> usize {
    let parsed: Vec<SavedTunnel> = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let mut list = store.0.lock().unwrap();
    for mut t in parsed {
        if list.len() >= MAX_SAVED_TUNNELS {
            break; // stop importing, keep what fits
        }
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
pub(crate) fn saved_import(app: AppHandle, store: State<SavedStore>, json: String) -> usize {
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
            limit: 0,
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
                limit: 0,
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
    fn import_respects_max_saved_tunnels_cap() {
        // 120 fresh tunnels in the import JSON; only MAX_SAVED_TUNNELS (100)
        // may land in the store — a huge/malformed export must not bloat it.
        let store = store_with(vec![]);
        let json = serde_json::json!(
            (0..120)
                .map(|i| serde_json::json!({
                    "id": format!("t{i}"),
                    "name": format!("t{i}"),
                    "kind": "client",
                    "key": "hs://x",
                    "port": null,
                    "secure": false,
                    "udp": false,
                    "autostart": false,
                    "createdAt": i
                }))
                .collect::<Vec<_>>()
        )
        .to_string();
        let len = saved_import_core(&store, &json);
        assert_eq!(len, 100); // capped, not 120
        assert_eq!(store.0.lock().unwrap().len(), 100);
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
}
