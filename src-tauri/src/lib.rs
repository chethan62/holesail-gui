/*
 * holesail-gui — Tauri backend (library target).
 *
 * Spawns service-worker.js (a plain-Node process) and proxies JSON-RPC
 * between the webview frontend (invoke -> rpc command) and the worker's
 * stdio. Worker events (session:update, worker:log, ...) are re-emitted
 * to the frontend as "worker:event" Tauri events.
 *
 * The worker runs under the SYSTEM node binary (or the bundled bare
 * runtime in packaged builds) so the native addons (sodium-native,
 * udx-native) load with the ABI they were built for.
 *
 * Module map (acyclic, leaves first):
 *   worker.rs    — worker spawn/respawn/backoff/IO threads + diagnostics
 *   rpc.rs       — the renderer->worker JSON-RPC bridge (allowlisted)
 *   commands.rs  — version/LAN/home + event-log + deep-link queue
 *   saved.rs     — saved-tunnel (permanent) CRUD + keychain/file store
 *   recent.rs    — recent connection strings + keychain/file store
 *   tray.rs      — system tray + close-to-tray (desktop)
 *   lib.rs       — this file: module wiring + run() entry point
 *
 * The code lives in the lib target so the mobile builds (cargo build --lib)
 * can compile it; src/main.rs is a thin binary wrapper for the desktop.
 */

mod commands;
mod recent;
mod rpc;
mod saved;
mod tray;
mod worker;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use commands::PendingDeepLinks;
use recent::RecentStore;
use saved::SavedStore;
use worker::{
    schedule_respawn, spawn_worker, DiagState, PendingState, StdinState, WorkerDiag, WorkerState,
    RESPAWN_GEN,
};

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
            commands::queue_deep_link(app, arg.clone());
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
        .on_window_event(tray::handle_window_event)
        .setup(|app| {
            app.manage(WorkerState(Mutex::new(None)));
            app.manage(StdinState(Mutex::new(None)));
            // Saved tunnels (temp/permanent) persisted under the app config
            // dir; autostart follows the saved tunnels' preferences. On
            // desktop the list (tunnel keys + filemanager passwords) lives
            // in the OS keychain; the 0600 file is the no-daemon fallback.
            let (saved_list, from_keychain) = saved::saved_load(app.handle());
            app.manage(SavedStore(Mutex::new(saved_list)));
            // One-time migration: if we loaded from the legacy plaintext
            // file (or nothing), persist now so the credentials move into
            // the keychain and the plaintext copy is removed.
            #[cfg(desktop)]
            if !from_keychain {
                saved::saved_persist(app.handle(), &app.state::<SavedStore>());
            }
            saved::autostart_sync(app.handle(), &app.state::<SavedStore>());
            app.manage(RecentStore(Mutex::new(recent::recent_load(app.handle()))));

            #[cfg(desktop)]
            tray::setup_tray(app.handle())?;

            // Deep links: deliver startup URLs via the pending queue (the
            // webview is not listening for events yet) and forward live ones
            // to the renderer as app:event messages.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    commands::queue_deep_link(&handle, url.to_string());
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    commands::queue_deep_link(app.handle(), url.to_string());
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
                worker::diag_record_failure(app.handle(), e.clone());
                let _ = app.emit(
                    "worker:event",
                    serde_json::json!({ "event": "worker:error", "data": { "message": e } }),
                );
                schedule_respawn(app.handle(), 0);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc::rpc,
            worker::worker_diagnostics,
            worker::worker_restart,
            worker::retry_spawn_worker,
            commands::take_pending_deep_links,
            commands::version_info,
            commands::lan_address,
            commands::home_dir,
            commands::log_append,
            saved::saved_list,
            saved::saved_save,
            saved::saved_delete,
            saved::saved_duplicate,
            saved::saved_export,
            saved::saved_import,
            recent::recent_list,
            recent::recent_add,
            recent::recent_clear
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
                    worker::kill_worker(w);
                }
            }
        });
}
