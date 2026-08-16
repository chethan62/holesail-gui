/* tray.rs — system tray + close-to-tray window handling (desktop only).
 *
 * The app lives in the tray once the window is closed (close = hide, not
 * exit). Quit happens from the tray menu, which triggers RunEvent::Exit and
 * the worker teardown in lib.rs::run().
 */

use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// System tray: show/hide the window, stop all tunnels, quit.
#[cfg(desktop)]
pub(crate) fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
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
                let _ = app.emit("app:event", serde_json::json!({ "event": "tray:stop-all" }));
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
/// exiting (desktop only — mobile has no close button semantics).
pub(crate) fn handle_window_event(window: &tauri::Window, event: &WindowEvent) {
    #[cfg(desktop)]
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
    // mobile: nothing to do (no close button semantics); silence unused params
    #[cfg(not(desktop))]
    let _ = (window, event);
}
