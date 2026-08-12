/*
 * holesail-gui — desktop binary wrapper. All application code lives in
 * src/lib.rs (holesail_gui_lib) so the same crate also builds as a library
 * for the Android/iOS targets (cargo build --lib).
 */

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod instance_diag {
    //! Diagnostic for the single-instance DBus name. A stale instance (e.g.
    //! an older packaged binary still running) can own the name and silently
    //! swallow deep links and extra launches. These helpers answer "who owns
    //! it and what is it" without GTK — pure busctl + /proc reads.

    use std::process::Command;

    /// DBus name registered by tauri-plugin-single-instance for the
    /// `io.holesail.gui` identifier. Confirmed via
    /// `busctl --user list | grep -i holesail`.
    const DBUS_NAME: &str = "io.holesail.gui.SingleInstance";

    pub struct Owner {
        pub pid: u32,
        pub exe: String,
        pub appimage: Option<String>,
        pub cmdline: String,
    }

    fn proc_env(pid: u32, key: &str) -> Option<String> {
        let env = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
        let prefix = format!("{key}=");
        env.split(|&b| b == 0)
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .find(|e| e.starts_with(&prefix))
            .map(|e| e[prefix.len()..].to_string())
    }

    fn proc_link(pid: u32, what: &str) -> Option<String> {
        std::fs::read_link(format!("/proc/{pid}/{what}"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }

    fn proc_cmdline(pid: u32) -> String {
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        raw.split(|&b| b == 0)
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn owner() -> Option<Owner> {
        let out = Command::new("busctl").args(["--user", "list"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if !line.contains(DBUS_NAME) {
                continue;
            }
            // busctl --user list columns:
            // NAME PID PROCESS USER CONNECTION UNIT SESSION DESCRIPTION
            let pid: u32 = line.split_whitespace().nth(1)?.parse().ok()?;
            return Some(Owner {
                pid,
                exe: proc_link(pid, "exe").unwrap_or_else(|| "<gone>".into()),
                appimage: proc_env(pid, "APPIMAGE"),
                cmdline: proc_cmdline(pid),
            });
        }
        None
    }

    pub fn report() {
        match owner() {
            Some(o) => {
                println!("holesail-gui single-instance owner (DBus {DBUS_NAME}):");
                println!("  pid:      {}", o.pid);
                println!("  exe:      {}", o.exe);
                println!(
                    "  appimage: {}",
                    o.appimage.as_deref().unwrap_or("<not an AppImage>")
                );
                println!("  cmdline:  {}", o.cmdline);
            }
            None => println!("no holesail-gui instance running (DBus {DBUS_NAME} unowned)"),
        }
    }
}

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

        // --instances: print who owns the single-instance name and exit
        // (no GTK, no webview). Useful when a stale instance swallows deep
        // links and the visible app "doesn't react".
        if std::env::args().any(|a| a == "--instances") {
            instance_diag::report();
            return;
        }

        // Explain the silent second-launch: the single-instance plugin will
        // route this launch into the running instance and this process exits
        // without ever showing a window.
        if let Some(o) = instance_diag::owner() {
            eprintln!(
                "holesail-gui: another instance is running (pid {}, {}); \
                 deep links and extra launches route there. \
                 Run 'holesail-gui --instances' for details.",
                o.pid, o.exe
            );
        }
    }

    holesail_gui_lib::run()
}
