/*
 * holesail-gui — desktop binary wrapper. All application code lives in
 * src/lib.rs (holesail_gui_lib) so the same crate also builds as a library
 * for the Android/iOS targets (cargo build --lib).
 */

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // NVIDIA/Wayland: WebKitGTK's DMABUF renderer fails on some GPU stacks
    // ("Failed to create GBM buffer") and the WebView renders a blank white
    // window. Set the fallbacks here — BEFORE GTK/WebKit init inside run() —
    // so every launch path is covered (AppImage double-click, .desktop,
    // updater, dev binary), not just the launch.sh wrapper.
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
    holesail_gui_lib::run()
}
