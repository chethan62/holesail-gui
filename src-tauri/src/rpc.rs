/* rpc.rs — the renderer -> worker JSON-RPC bridge (the `rpc` Tauri command).
 *
 * The worker owns the actual tunnel logic; the Rust backend only proxies
 * newline-JSON over the worker's stdio. This command is the ONLY path from
 * the sandboxed webview to the worker, so it carries the method allowlist.
 */

use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::State;

use std::io::Write;

use crate::worker::{
    Pending, PendingState, StdinState, NEXT_RPC_ID, RPC_TIMEOUT, WORKER_READY,
};

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
