fn main() {
    tauri_build::build();

    // Embed the short git hash so the UI can always show which build is
    // running (identical app versions across CI builds are otherwise
    // indistinguishable on-device).
    let hash = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=GIT_HASH={hash}");
}
