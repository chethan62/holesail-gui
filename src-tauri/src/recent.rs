/* recent.rs — recent connection strings (credentials) store + commands.
 *
 * Desktop: stored in the OS keychain (Secret Service / Keychain /
 * Credential Manager) via the keyring crate, falling back to a 0600 file
 * when no keychain daemon is reachable. Android (no keyring): 0600 file
 * beside saved-tunnels.json. The renderer never keeps these in web storage.
 */

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

const RECENT_MAX: usize = 10;

pub(crate) struct RecentStore(pub(crate) Mutex<Vec<String>>);

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
pub(crate) fn recent_load(app: &AppHandle) -> Vec<String> {
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
pub(crate) fn recent_load(app: &AppHandle) -> Vec<String> {
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
pub(crate) fn recent_list(store: State<RecentStore>) -> Vec<String> {
    store.0.lock().unwrap().clone()
}

#[tauri::command]
pub(crate) fn recent_add(app: AppHandle, store: State<RecentStore>, label: String) {
    let snapshot = {
        let mut list = store.0.lock().unwrap();
        recent_push(&mut list, &label);
        list.clone()
    };
    recent_persist(&app, &snapshot);
}

#[tauri::command]
pub(crate) fn recent_clear(app: AppHandle, store: State<RecentStore>) {
    store.0.lock().unwrap().clear();
    recent_persist(&app, &[]);
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
