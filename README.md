# Holesail GUI

A desktop GUI for [Holesail](https://github.com/holesail/holesail) — the peer-to-peer
TCP/UDP tunnel. Share any local port with the world, or connect to someone else's
tunnel, from a friendly window instead of the CLI.

Built with **Tauri v2** (Rust + system webview) and a **plain-Node service worker**.

## Platforms

| Platform | Status | Deliverables |
|---|---|---|
| **Linux** | ✅ fully working | `.deb`, `.rpm`, `.AppImage`, pacman, flatpak manifest |
| **Windows** | ✅ builds via CI | `.msi`, `.exe` (NSIS) — needs Node 18+ on the machine |
| **Android** | ⚠️ UI builds, backend pending | debug APK — see the [Android](#android) caveat |
| macOS | code-compatible, untested here | `.dmg`/`.app` via `tauri build` on a Mac |

The three primary targets are built automatically by the GitHub Actions
workflow in `.github/workflows/build.yml` (artifacts on every push /
`workflow_dispatch`).

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────────┐
│  Webview (renderer/)     │  IPC   │  Rust backend (src-tauri/)   │
│  HTML/CSS/JS UI          │ ─────▶ │  tauri commands + events     │
└──────────────────────────┘        └──────────────┬───────────────┘
                                                   │ stdio JSON-RPC
                                    ┌──────────────▼───────────────┐
                                    │ service-worker.js (plain     │
                                    │ Node — NOT Electron's Node)  │
                                    │  └── holesail npm package    │
                                    └──────────────────────────────┘
```

Why a separate Node worker? `holesail` depends on native addons
(`sodium-native`, `udx-native`) that are prebuilt for the **Node ABI**. Running
them inside a webview/Electron process breaks on ABI mismatch. The worker runs
under the system `node` binary, so the addons load as-is; the Rust backend only
proxies JSON-RPC over stdio.

## Requirements

- **Node.js 18+** (`node` on PATH) — needed by the service worker
- Rust toolchain (`cargo`) for Tauri
- Linux: `webkit2gtk-4.1` + `gtk3` dev packages (Tauri prerequisites;
  see [Tauri docs](https://v2.tauri.app/start/prerequisites/))

## Run (development)

```bash
npm install          # installs holesail (worker dep) + @tauri-apps/cli
npm run dev          # tauri dev — builds the Rust backend and opens the window
```

## Test

```bash
npm test             # E2E: spawns the real service worker, starts a server on
                     # the DHT, connects a client, stops both, asserts protocol
```

The test talks to the exact same `service-worker.js` the GUI uses, so a green
`npm test` verifies the full backend chain (validation → holesail → hyperdht →
real tunnel).

## Build a release bundle

```bash
npm run build        # prepares resources, then tauri build (deb + rpm + AppImage on Linux)
```

`build` first runs `scripts/prepare-resources.mjs`, which assembles a lean
`dist-resources/` folder (the Node service worker + a **production-only**
`node_modules` with `holesail` and its native addons, pruned to the current
platform's prebuilds, ~38 MB) and then bundles it into the installers:

- **Linux:** `.deb` and `.rpm` put the binary in `/usr/bin` and the resources in
  `/usr/lib/holesail-gui/` — `find_worker` resolves them via `resource_dir()`.
  The AppImage target needs FUSE; on FUSE-less machines (containers/CI) and on
  distros whose newer toolchain trips linuxdeploy's bundled `strip`
  (`.relr.dyn` errors), build it with:

  ```bash
  NO_STRIP=1 APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --bundles appimage
  ```

  Or skip it entirely with `npx tauri build --bundles deb,rpm`.

**Arch Linux (pacman)** — verified build in `packaging/arch/`:

```bash
./packaging/arch/build.sh        # -> packaging/arch/holesail-gui-<ver>-1-x86_64.pkg.tar.zst
sudo pacman -U packaging/arch/holesail-gui-*.pkg.tar.zst
```

Installs the binary + worker + `node_modules` into `/usr/lib/holesail-gui/` with
a launcher at `/usr/bin/holesail-gui` (binary and resources in the same dir, so
Tauri's `resource_dir()` resolves without bundler patching).

**Flatpak** — manifest in `packaging/flatpak/` (Tauri webkit2gtk-4.1 base so
WebKit is bundled):

```bash
flatpak install flathub org.freedesktop.Sdk//24.08 org.freedesktop.Platform//24.08
flatpak install flathub org.freedesktop.Sdk.Extension.webkit2gtk-4.1//24.08
./packaging/flatpak/build.sh     # builds + installs io.holesail.gui (user)
flatpak run io.holesail.gui
```

> Note: the flatpak manifest is written but **not verified in this repo's CI
> environment** (needs `flatpak-builder` + the SDK runtimes).
- **macOS / Windows:** `npm run build` produces `.dmg`/`.app` and `.msi`/`.exe`
  respectively with the same resource layout.

**Packaged-app requirements:** the GUI spawns the service worker with `node`
from PATH, so end-user machines need Node.js 18+ installed (documented in the
release notes). A fully embedded Node runtime is future work.

## Using the app

**Share a port** — pick a local port (e.g. 3000), optionally a custom 32+ char key,
toggle private/public. A session card appears with the `hs://s000…` connection
string — hit **Copy** and send it to whoever needs access.

**Connect** — paste a connection string (`hs://s000…` private or `hs://0000…`
public; secure mode is auto-detected from the prefix). The tunnel is exposed on
your localhost port.

Sessions can be paused/resumed/stopped; the event log at the bottom shows what
the worker is doing.

## Android

An Android project is scaffolded with `tauri android init` (already done — see
`src-tauri/gen/android/`, regenerated on demand; the mobile capability lives in
`src-tauri/capabilities/mobile.json`).

**Build an APK** (on a machine with Android Studio / the SDK+NDK):

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
ANDROID_HOME=$HOME/Android/Sdk npx tauri android build --apk --debug
# or open src-tauri/gen/android in Android Studio and run the app
```

**Current limitation — the backend does not run on Android yet.** The GUI
spawns its worker with the `node` binary, which does not exist on Android, so
the Android build currently shows the UI but tunnels are non-functional until
the worker is ported to the **Bare runtime** (holepunch's JS runtime — this is
exactly what upstream holesail uses for its own Android build; the native
addons `sodium-native`/`udx-native` already ship android prebuilds). Plan:

1. Cross-compile `bare` for android (upstream: `bare-make` + `builtins.json`).
2. Bundle the worker JS into the bare binary; ship it as an APK asset.
3. In `main.rs`, spawn the bundled bare binary instead of `node` when
   `cfg(target_os = "android")`.

> The SDK installed in this repo's sandbox lives at
> `/home/chethan/.reasonix/global-workspace/android-sdk` (not in `$HOME`,
> which is read-only). `ANDROID_USER_HOME` must also point at a writable dir
> or `sdkmanager`/gradle will fail.

## Security notes

- Private connection strings are credentials — treat them like SSH keys.
- The GUI runs a local service worker; the renderer is sandboxed
  (`withGlobalTauri`, CSP `default-src 'self'`, `style-src 'unsafe-inline'`) and
  can only talk to it through the whitelisted `rpc` command. Untrusted values
  (keys, hosts, logs) are rendered with `textContent`, never injected as HTML.
- **Recent keys are stored in plaintext in the webview's localStorage** (up to
  10 entries) for convenience. They're only readable by local processes with
  access to your app profile, but if that's a concern, use the "clear" button
  or avoid saving private keys you care about.
