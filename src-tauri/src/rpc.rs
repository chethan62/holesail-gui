/* rpc.rs — the renderer -> worker JSON-RPC bridge (the `rpc` Tauri command).
 *
 * The worker owns the actual tunnel logic; the Rust backend only proxies
 * newline-JSON over the worker's stdio. This command is the ONLY path from
 * the sandboxed webview to the worker, so it carries the method allowlist
 * and the parameter validation.
 */

use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::State;

use std::io::Write;

use crate::worker::{Pending, PendingState, StdinState, NEXT_RPC_ID, RPC_TIMEOUT, WORKER_READY};

/// Longest a renderer-supplied timeout may be. The renderer asks for 90s
/// around cold DHT bootstrap, so the clamp sits above that and below
/// "effectively forever".
const MAX_TIMEOUT_MS: u64 = 120_000;
/// Generic cap for string fields (paths, keys, urls).
const MAX_STR: usize = 4096;
/// Ceiling for a rate limit, in bytes/sec (0 = unlimited). This is the
/// renderer's own maximum — `readLimit()` in renderer/ui.js clamps at
/// 1024*1024*1024 and the worker's normalizeLimit() takes any finite
/// non-negative number — so legitimate callers can never trip it.
const MAX_LIMIT_BYTES: f64 = (1024 * 1024 * 1024) as f64;

/* The ABI the renderer and worker share, documented at the top of
 * service-worker.js:
 *   server:start      {port, host?, secure?, key?, udp?, limit?}
 *   client:connect    {key, port?, host?, udp?, secure?, limit?}
 *   filemanager:start {path, host?, port?, secure?, key?, role?, username?,
 *                      password?, limit?}
 *   session:stop|pause|resume {id}
 *   sessions:list     {}
 *   limit:global      {limit}
 *   lookup            {key}
 */

fn get_str(params: &Value, key: &str, max: usize) -> Result<Option<String>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            if s.chars().count() > max {
                return Err(format!("{key} is too long (max {max} characters)"));
            }
            Ok(Some(s.clone()))
        }
        Some(_) => Err(format!("{key} must be a string")),
    }
}

fn required_str(params: &Value, key: &str, max: usize) -> Result<String, String> {
    match get_str(params, key, max)? {
        Some(s) if !s.is_empty() => Ok(s),
        Some(_) => Err(format!("{key} must not be empty")),
        None => Err(format!("{key} is required")),
    }
}

fn get_port(params: &Value, key: &str) -> Result<Option<u16>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => match n.as_u64() {
            Some(p) if (1..=65535).contains(&p) => Ok(Some(p as u16)),
            _ => Err(format!("{key} must be a whole number between 1 and 65535")),
        },
        Some(_) => Err(format!("{key} must be a number")),
    }
}

fn get_limit(params: &Value, required: bool) -> Result<(), String> {
    match params.get("limit") {
        None | Some(Value::Null) if !required => Ok(()),
        None | Some(Value::Null) => Err("limit is required".to_string()),
        // finite and non-negative, like the worker's normalizeLimit()
        Some(Value::Number(n)) => match n.as_f64() {
            Some(v) if v.is_finite() && (0.0..=MAX_LIMIT_BYTES).contains(&v) => Ok(()),
            _ => Err(format!(
                "limit must be between 0 and {MAX_LIMIT_BYTES} bytes/sec"
            )),
        },
        Some(_) => Err("limit must be a number".to_string()),
    }
}

/// Type and range checks for the handful of methods the renderer may call.
///
/// The worker validates all of this too, and that is the real check — but the
/// worker is also the process a malformed payload would take down, and "the
/// other side validates" is not a trust boundary. Everything here is a cheap
/// shape check: nothing allocates from an attacker-supplied size, and no arm
/// can panic.
fn validate(method: &str, params: &Value) -> Result<(), String> {
    if !params.is_null() && !params.is_object() {
        return Err("params must be an object".to_string());
    }

    match method {
        "server:start" => {
            get_port(params, "port")?;
            get_str(params, "host", 255)?;
            get_str(params, "username", 255)?;
            get_limit(params, false)?;
            // Absent key = the worker generates one (the renderer sends
            // undefined, not ""). A supplied one has to be real material.
            match get_str(params, "key", MAX_STR)? {
                Some(k) if k.chars().count() < 32 => {
                    return Err("key must be at least 32 characters".to_string())
                }
                _ => {}
            }
        }
        "client:connect" => {
            required_str(params, "key", MAX_STR)?;
            get_port(params, "port")?;
            get_str(params, "host", 255)?;
            get_limit(params, false)?;
        }
        "filemanager:start" => {
            // The worker refuses a missing/blank path; catching it here keeps
            // the error legible instead of a worker-side throw.
            required_str(params, "path", MAX_STR)?;
            get_port(params, "port")?;
            get_str(params, "host", 255)?;
            get_str(params, "username", 255)?;
            get_str(params, "password", 1024)?;
            get_limit(params, false)?;
            match get_str(params, "key", MAX_STR)? {
                Some(k) if k.chars().count() < 32 => {
                    return Err("key must be at least 32 characters".to_string())
                }
                _ => {}
            }
        }
        "session:stop" | "session:pause" | "session:resume" => {
            required_str(params, "id", 128)?;
        }
        "session:stats" => {
            get_str(params, "id", 128)?;
        }
        "limit:global" => {
            get_limit(params, true)?;
        }
        "lookup" => {
            required_str(params, "key", MAX_STR)?;
        }
        // ping / sessions:list take nothing.
        _ => {}
    }
    Ok(())
}

/// Renderer-requested timeout, clamped. Exposed for tests: a timeout is a
/// resource the caller does not own — an unbounded one would pin the pending
/// entry (and its oneshot sender) for as long as it likes.
fn clamp_timeout(timeout_ms: Option<u64>) -> Duration {
    match timeout_ms {
        Some(ms) if ms > 0 => Duration::from_millis(ms.min(MAX_TIMEOUT_MS)),
        _ => RPC_TIMEOUT,
    }
}

#[tauri::command]
pub(crate) async fn rpc(
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
        "session:stats",
        "lookup",
        "limit:global",
    ];
    if !ALLOWED.contains(&method.as_str()) {
        return Err(format!("Method not allowed: {method}"));
    }
    validate(&method, &params)?;

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

    match tokio::time::timeout(clamp_timeout(timeout_ms), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Service worker dropped the request".into()),
        Err(_) => {
            pending.0.lock().unwrap().remove(&id);
            Err("Request timed out".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(method: &str, params: Value) {
        assert!(
            validate(method, &params).is_ok(),
            "{method} should accept {params}: {:?}",
            validate(method, &params)
        );
    }

    fn bad(method: &str, params: Value) -> String {
        validate(method, &params).expect_err(&format!("{method} should reject {params}"))
    }

    #[test]
    fn server_start_accepts_the_documented_shape() {
        ok(
            "server:start",
            json!({"port": 3000, "host": "127.0.0.1", "secure": true, "udp": false, "limit": 0}),
        );
        ok("server:start", json!({"port": 3000}));
        ok(
            "server:start",
            json!({"port": 65535, "key": "a".repeat(32)}),
        );
        // the renderer omits `key` entirely when the field is empty
        ok(
            "server:start",
            json!({"port": 3000, "host": "127.0.0.1", "key": null}),
        );
    }

    #[test]
    fn ports_must_be_real_ports() {
        for bad_port in [
            json!(0),
            json!(65536),
            json!(-1),
            json!("3000"),
            json!(3000.5),
        ] {
            let msg = bad("server:start", json!({"port": bad_port}));
            assert!(msg.contains("port"), "{bad_port} -> {msg}");
        }
        // null is "not supplied", which the worker defaults
        ok("server:start", json!({"port": null}));
    }

    #[test]
    fn keys_must_be_real_key_material() {
        assert!(bad("server:start", json!({"port": 1, "key": "short"})).contains("32"));
        assert!(bad(
            "filemanager:start",
            json!({"path": "/tmp/x", "key": "short"})
        )
        .contains("32"));
        // client:connect has no default key, so it is required outright
        assert!(bad("client:connect", json!({})).contains("required"));
    }

    #[test]
    fn folder_share_requires_a_path() {
        // the old bug class: a blank path reached the worker and threw there
        assert!(bad("filemanager:start", json!({"port": 3000})).contains("path"));
        assert!(bad("filemanager:start", json!({"path": ""})).contains("path"));
        assert!(bad("filemanager:start", json!({"path": 42})).contains("path"));
        ok(
            "filemanager:start",
            json!({"path": "/home/chethan/SAP_fico_doc"}),
        );
    }

    #[test]
    fn session_control_requires_an_id() {
        for m in ["session:stop", "session:pause", "session:resume"] {
            assert!(bad(m, json!({})).contains("id"), "{m}");
            assert!(bad(m, json!({"id": ""})).contains("id"), "{m}");
            assert!(bad(m, json!({"id": 7})).contains("id"), "{m}");
            ok(m, json!({"id": "12-1758391234567"}));
        }
    }

    #[test]
    fn limits_are_bounded_numbers() {
        assert!(bad("limit:global", json!({})).contains("limit"));
        assert!(bad("limit:global", json!({"limit": "fast"})).contains("limit"));
        assert!(bad("limit:global", json!({"limit": -5})).contains("limit"));
        assert!(bad("limit:global", json!({"limit": MAX_LIMIT_BYTES + 1.0})).contains("limit"));
        ok("limit:global", json!({"limit": 0}));
        ok("limit:global", json!({"limit": 512}));
        // a value the renderer itself can produce must never be rejected
        ok("limit:global", json!({"limit": MAX_LIMIT_BYTES}));
        ok(
            "server:start",
            json!({"port": 3000, "limit": MAX_LIMIT_BYTES}),
        );
    }

    #[test]
    fn oversized_and_wrong_typed_strings_are_rejected() {
        assert!(bad(
            "filemanager:start",
            json!({"path": "p".repeat(MAX_STR + 1)})
        )
        .contains("long"));
        assert!(bad("server:start", json!({"port": 1, "host": 12})).contains("host"));
        assert!(bad("client:connect", json!({"key": "k".repeat(MAX_STR + 1)})).contains("long"));
    }

    #[test]
    fn params_must_be_an_object() {
        assert!(validate("sessions:list", &json!([1, 2, 3])).is_err());
        assert!(validate("sessions:list", &json!("nope")).is_err());
        // null is tolerated: the renderer sends {} but a no-arg call may omit it
        assert!(validate("ping", &Value::Null).is_ok());
        ok("ping", json!({}));
        ok("sessions:list", json!({}));
    }

    #[test]
    fn timeout_is_clamped_and_defaulted() {
        assert_eq!(clamp_timeout(None), RPC_TIMEOUT);
        assert_eq!(clamp_timeout(Some(0)), RPC_TIMEOUT);
        assert_eq!(clamp_timeout(Some(90_000)), Duration::from_millis(90_000));
        // beyond the ceiling, and far beyond it
        assert_eq!(
            clamp_timeout(Some(MAX_TIMEOUT_MS + 1)),
            Duration::from_millis(MAX_TIMEOUT_MS)
        );
        assert_eq!(
            clamp_timeout(Some(u64::MAX)),
            Duration::from_millis(MAX_TIMEOUT_MS)
        );
    }
}
