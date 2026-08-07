/*
 * holesail-gui — desktop binary wrapper. All application code lives in
 * src/lib.rs (holesail_gui_lib) so the same crate also builds as a library
 * for the Android/iOS targets (cargo build --lib).
 */

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    holesail_gui_lib::run()
}
