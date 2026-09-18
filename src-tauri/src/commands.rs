/* commands.rs — simple utility Tauri commands + the event-log writer.
 *
 * Keep this module free of state-management logic (that lives in worker.rs,
 * saved.rs, recent.rs) — these are the small leaf commands the renderer
 * calls at boot: version, LAN address, home dir, and log persistence.
 */

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// hs:// URLs delivered before the webview subscribed (startup deep links).
/// The renderer drains them via take_pending_deep_links on boot; live links
/// are also pushed here so nothing is lost if the UI is reloaded.
pub(crate) struct PendingDeepLinks(pub(crate) Mutex<Vec<String>>);

pub(crate) fn queue_deep_link(app: &AppHandle, url: String) {
    if !url.starts_with("hs://") {
        return;
    }
    app.state::<PendingDeepLinks>()
        .0
        .lock()
        .unwrap()
        .push(url.clone());
    let _ = app.emit(
        "app:event",
        serde_json::json!({ "event": "deep-link:open", "data": { "url": url } }),
    );
}

#[tauri::command]
pub(crate) fn take_pending_deep_links(app: AppHandle) -> Vec<String> {
    std::mem::take(&mut app.state::<PendingDeepLinks>().0.lock().unwrap())
}

/// App version + embedded short git hash — lets the UI identify exactly
/// which build is installed (identical versions across CI builds are
/// otherwise indistinguishable on-device).
#[tauri::command]
pub(crate) fn version_info(app: AppHandle) -> serde_json::Value {
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
fn restrict_perms(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/* ---------------------------- settings store ---------------------------- */
/* One small JSON blob in the app config dir. Its only current use is the
 * all-tunnels speed limit, which must outlive a restart: permanent tunnels
 * come back automatically at launch, so a link the user deliberately capped
 * must not come back uncapped. */

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

/// Missing or unreadable file reads as "no settings" — never an error.
fn read_settings(path: &std::path::Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_settings(path: &std::path::Path, value: &serde_json::Value) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_vec(value)?)?;
    restrict_perms(path);
    Ok(())
}

#[tauri::command]
pub(crate) fn settings_get(app: AppHandle) -> serde_json::Value {
    settings_path(&app)
        .map(|path| read_settings(&path))
        .unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
pub(crate) fn settings_set(app: AppHandle, value: serde_json::Value) {
    if let Some(path) = settings_path(&app) {
        if let Err(err) = write_settings(&path, &value) {
            eprintln!("settings write failed: {err}");
        }
    }
}

/// Append a renderer log line to the persistent event log so history
/// survives restarts (bug reports). File: <app_config_dir>/event-log.txt,
/// capped at 64 KiB (whole-line trim, see trim_to_cap).
#[tauri::command]
pub(crate) fn log_append(app: AppHandle, line: String) {
    const LOG_MAX_BYTES: usize = 64 * 1024;
    let Ok(config_dir) = app.path().app_config_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&config_dir);
    let path = config_dir.join("event-log.txt");
    // Append-only write: avoid reading the entire file on every call.
    // The periodic trim (below) keeps the file bounded.
    {
        use std::io::Write;
        let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        else {
            return;
        };
        let _ = writeln!(f, "{line}");
    }
    // Trim when the file exceeds the cap. This is rare (only after 64 KiB
    // of log lines), so the read-modify-write is acceptable here.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > LOG_MAX_BYTES as u64 {
            if let Ok(cur) = std::fs::read_to_string(&path) {
                let _ = std::fs::write(&path, trim_to_cap(cur, LOG_MAX_BYTES));
            }
        }
    }
    restrict_perms(&path);
}

/// The machine's primary LAN IPv4 address (e.g. 192.168.29.94). Server
/// session cards show a "LAN access" URL built from it, so a phone on the
/// same network can reach the shared service directly — no DHT, no
/// hole-punching. Falls back to 127.0.0.1 when no LAN address exists.
#[tauri::command]
pub(crate) fn lan_address() -> String {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

#[tauri::command]
pub(crate) fn home_dir() -> String {
    std::env::var_os("HOME")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn settings_roundtrip() {
        let dir = std::env::temp_dir().join(format!("hg-settings-{}", std::process::id()));
        let path = dir.join("settings.json");
        write_settings(&path, &serde_json::json!({ "globalLimit": 102400 })).unwrap();
        assert_eq!(read_settings(&path)["globalLimit"], 102400);
        // overwrite replaces, never merges stale keys back in
        write_settings(&path, &serde_json::json!({ "globalLimit": 0 })).unwrap();
        assert_eq!(read_settings(&path)["globalLimit"], 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_missing_or_corrupt_reads_as_empty() {
        let dir = std::env::temp_dir().join(format!("hg-settings-bad-{}", std::process::id()));
        let missing = dir.join("settings.json");
        assert_eq!(read_settings(&missing), serde_json::json!({}));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&missing, b"{not json").unwrap();
        assert_eq!(read_settings(&missing), serde_json::json!({}));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
