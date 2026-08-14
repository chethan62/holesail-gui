# Holesail GUI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/chethan62/holesail-gui/actions/workflows/build.yml/badge.svg)](https://github.com/chethan62/holesail-gui/actions/workflows/build.yml)

A desktop GUI for [Holesail](https://github.com/holesail/holesail) — the peer-to-peer
TCP/UDP tunnel. Share any local port with the world, or connect to someone else's
tunnel, from a friendly window instead of the CLI.

Built with **Tauri v2** (Rust + system webview) and a **plain-Node service worker**.

## What is this tool?

**Holesail GUI is a window over [holesail](https://github.com/holesail/holesail): a
peer-to-peer tunnel that exposes any local service (a web app, an API, a
game server, a NAS, anything on a TCP/UDP port) to other devices — over the
internet — without port forwarding, a static IP, or a middleman server.**

The phone in your pocket can reach your home PC's services from anywhere,
and your PC can reach services on your phone, through an encrypted
connection that goes directly peer-to-peer over the public HyperDHT
network.

## Why does this exist? (the problem it solves)

Exposing a local service to the internet usually means one of these
headaches:

- **Port forwarding** — requires router admin access, a public/static IP,
  and it punches a hole in your home network's firewall
- **CGNAT** — many ISPs (especially mobile and home fiber in some regions)
  don't give you a public IPv4 at all, so port forwarding is impossible
- **Tunneling services (ngrok/cloudflare tunnels)** — work, but route all
  your traffic through a third-party server, add latency, and put a
  single company between you and your data

holesail sidesteps all three: both ends connect *outward* to the DHT
(no inbound ports, works behind any NAT), find each other by key, and
then talk directly peer-to-peer with end-to-end encryption. **No relay
server, no open firewall ports, no static IP.**

## Why a GUI?

The CLI works, but tunnels are a *continuous* thing, not a one-shot
command. The GUI adds what the terminal can't:

- **Permanent tunnels** — a fixed key that never changes and
  auto-restarts with the app, so your phone always knows where to find
  your PC
- **Saved connections** — one tap to reconnect to a key you use often
- **Background operation** — the app lives in the system tray; tunnels
  keep running when the window is closed (desktop) and survive device
  reboots (Android boot receiver, desktop login autostart)
- **A phone app** — the same codebase runs on Android, so a phone can be
  a tunnel *server* too (e.g. share Termux/HTTP servers outward)

## Typical uses

- Reach your home PC's apps (SearXNG, Jellyfin, dev servers) from your
  phone on mobile data
- Share a local dev server with a colleague — no ngrok, no deploy
- Access a service on your phone (e.g. an on-device web server) from
  your PC
- A private, key-based alternative to exposing services — nobody can
  connect without the connection string

## Platforms

| Platform | Status | Deliverables |
|---|---|---|
| **Linux** | ✅ fully working | `.deb`, `.rpm`, `.AppImage`, pacman, flatpak manifest |
| **Windows** | ✅ builds via CI | `.msi`, `.exe` (NSIS) — bare runtime bundled, no Node needed |
| **Android** | ✅ backend works (bare runtime) — arm64 APK | debug APK — see the [Android](#android) section |
| **macOS** | ✅ builds via CI (untested on real hardware) | `.dmg`/`.app` — bare runtime bundled, no Node needed |

All four targets are built automatically by the GitHub Actions workflow in
`.github/workflows/build.yml` (artifacts on every push / `workflow_dispatch`);
macOS just hasn't been verified end-to-end on real hardware the way Linux and
Android have.

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────────┐
│  Webview (renderer/)     │  IPC   │  Rust backend (src-tauri/)   │
│  HTML/CSS/JS UI          │ ─────▶ │  tauri commands + events     │
└──────────────────────────┘        └──────────────┬───────────────┘
                                                   │ stdio JSON-RPC
                                    ┌──────────────▼───────────────┐
                                    │ service-worker.js (plain JS, │
                                    │ Node or Bare — NOT Electron) │
                                    │  └── holesail npm package    │
                                    └──────────────────────────────┘
```

Why a separate worker process? `holesail` depends on native addons
(`sodium-native`, `udx-native`) that are prebuilt per-runtime-ABI. Running them
inside a webview/Electron process breaks on ABI mismatch. The worker runs
under its own process (Node in dev, the bundled **Bare** runtime in packaged
builds — see below), so the addons load as-is; the Rust backend only proxies
JSON-RPC over stdio.

## Requirements

- **Node.js 18+** (`node` on PATH) — for development (`npm run dev`) on every
  platform. Packaged installers for **all four targets** (Linux, Windows,
  macOS, Android) embed the **Bare** runtime instead, so end users don't need
  Node.js installed at all — see [Build a release bundle](#build-a-release-bundle).
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

**Flatpak** — manifest in `packaging/flatpak/` (built on the GNOME platform,
which ships WebKitGTK 4.1 — the freedesktop `webkit2gtk-4.1` extension does
not exist on flathub). The manifest builds `libayatana-appindicator` from
source (intltool → libdbusmenu → ayatana-ido → libayatana-indicator →
appindicator 0.5.94, the flathub shared-modules recipe) because the GNOME
runtime does not ship the tray library and the app panics without it:

```bash
flatpak install flathub org.gnome.Platform//47 org.gnome.Sdk//47
./packaging/flatpak/build.sh     # builds + installs io.holesail.gui (user)
flatpak run io.holesail.gui
```

> Note: built + launched successfully on a Linux dev box (2026-08-15) and
> verified in CI via the `flatpak` job in `.github/workflows/build.yml`
> (builds `holesail-gui.flatpak`, shipped with releases).
- **macOS / Windows:** `npm run build` produces `.dmg`/`.app` and `.msi`/`.exe`
  respectively with the same resource layout — `tauri.macos.conf.json` and
  `tauri.windows.conf.json` bundle the platform's `bare`/`bare.exe` binary as
  a resource alongside the pruned `node_modules`.

**Packaged-app requirements:** every platform's installer bundles the
**Bare runtime** (same engine used for Android) instead of relying on system
Node — `worker_command()` in `src-tauri/src/lib.rs` prefers the bundled
`bare`/`bare.exe` next to `service-worker.js` and only falls back to spawning
`node` from PATH when that bundle is missing (e.g. an unpackaged dev
checkout, or a build produced without `--bare`). End users on Linux, Windows,
macOS, and Android do not need Node.js installed. macOS bundling is
CI-verified but not yet confirmed on real Apple hardware.

## Using the app

**Share a port** — pick a local port (e.g. 3000), optionally a custom 32+ hex char key,
toggle private/public. A session card appears with the `hs://s000…` connection
string — hit **Copy** and send it to whoever needs access. Server cards also show
a **Copy LAN URL** row (`http://<lan-ip>:<port>`) — a phone on the *same network*
can reach the service directly, no DHT involved.

**Connect** — paste a connection string (`hs://s000…` private or `hs://0000…`
public; secure mode is auto-detected from the prefix). The tunnel is exposed on
your localhost port.

Sessions can be paused/resumed/stopped; the event log at the bottom shows what the worker is doing.

**Temporary vs Permanent** — the Tunnel type selector on the Share tab chooses
between a one-off key (new random key each start) and a **permanent** tunnel:
fixed key, named, saved, and auto-restarted whenever the app (re)starts.
Connect has a matching **Save this connection** checkbox for keys you use often.

**Saved tab** — every permanent tunnel and saved connection is listed here with
Start/Stop, an Auto-start toggle, Rename, Duplicate, Export (to clipboard) and
Delete (two-tap confirm). **Import** merges exported JSON back in. On desktop,
Auto-start tunnels also enable login autostart, so they survive PC reboots; on
Android, a boot receiver restores them after device reboots.

**Deep links (`hs://`)** — clicking a connection string link (or running `xdg-open "hs://…"`) opens the app with the Connect form pre-filled, even if it was hidden in the tray. The app registers itself as the handler for the `hs://` scheme on Linux/Windows at first run; on Android, the scheme is baked into the APK manifest. A second app launch while one is running routes to the existing instance instead of duplicating.

**System tray** — closing the window hides the app (tunnels keep running) and a tray icon appears with *Show / Stop all tunnels / Quit*. Quit from the tray is the only way to fully exit while tunnels are active.

## Android

An Android project is scaffolded with `tauri android init` (already done — see
`src-tauri/gen/android/`, regenerated on demand; the mobile capability lives in
`src-tauri/capabilities/mobile.json`).

**Build an APK** (on a machine with Android Studio / the SDK+NDK):

```bash
rustup target add aarch64-linux-android # or all four ABIs
ANDROID_HOME=$HOME/Android/Sdk npm run build:android   # prepare bundle + glue + build
# or step by step:
node scripts/prepare-resources.mjs --bare --target android-arm64 --out dist-resources-android
node scripts/android-glue.mjs
ANDROID_HOME=$HOME/Android/Sdk npx tauri android build --apk --debug
```

**How the backend works on Android.** The worker is the exact same
`service-worker.js`, but instead of the system `node` binary it runs under
**Bare**, holepunch's JS runtime (the same one upstream holesail uses for its
own Android build):

1. `prepare-resources.mjs --bare --target android-arm64` assembles
   `dist-resources-android/`: the worker + a production `node_modules` pruned
   to the `android-arm64` `.bare` prebuilds of `sodium-native`/`udx-native`,
   plus the prebuilt `bare` runtime binary (fetched from the
   `bare-runtime-android-arm64` npm package — no cross-compiling needed).
2. `scripts/android-glue.mjs` wires everything into the generated project:
   - copies the bundle into the APK assets (`app/src/main/assets/bare/`) and
     injects `BareAssets.kt`, a small Kotlin extractor that copies the assets
     into `filesDir/bare` on first launch (Android assets are not real
     filesystem paths);
   - ships `bare` as a jniLibs library (`libholesail_bare.so`) — SELinux
     forbids apps (targetSdk ≥ 26) from exec'ing files in their own data dir,
     but *does* allow exec of the extracted APK lib dir (`apk_data_file`);
   - bundles `libc++_shared.so` (the `udx-native` addon links the C++ STL,
     which is not present on Android 10+) and forces
     `extractNativeLibs="true"` so those files land on disk at install.
3. In Rust, `worker_command()` under `cfg(target_os = "android")` locates the
   native lib dir via `/proc/self/maps`, spawns
   `<libdir>/libholesail_bare.so service-worker.js` with `LD_LIBRARY_PATH`
   pointing at the bundle — same JSON-RPC over stdio, same protocol, same UI.
   If the bundle is missing the app still renders with a "worker offline"
   banner instead of crashing.
4. A tiny foreground service (`HoleService`, injected by the glue) keeps the
   app process — and therefore the worker — alive when the app is
   backgrounded; without it Android freezes backgrounded apps and silently
   kills active tunnels. The service is started while the UI is visible,
   stopped when the task is swiped away, and shows a low-importance
   "Tunnel worker active" notification (notification permission is requested
   on Android 13+).

`npm test` runs the protocol test under node; `npm run test:bare` runs the
same test suite against a linux-x64 bare bundle, verifying the whole chain
(worker → holesail → addons → real DHT tunnel) on the bare runtime.

**Verified end-to-end on an emulator** (x86_64, API 35) **and on real arm64
hardware** (OnePlus 13R): the app spawns the bare worker, the UI shows
"worker online", server sessions started from the app's own UI are reachable
from a desktop client over the public DHT, and data sent through the tunnel
arrives on the device — in both directions.

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
- **Recent keys live in the OS keychain on desktop** (Secret Service /
  Keychain / Credential Manager, falling back to a 0600 file if no keychain
  daemon is reachable) **and a 0600 file on Android** — never in web storage.
  The "clear" button wipes the backing store.

## Acknowledgements

- [holesail](https://github.com/holesail/holesail) — the peer-to-peer
  TCP/UDP tunnel engine this app is a GUI for (**AGPL-3.0** — see the license
  note below).
- [Bare](https://github.com/holepunchto/bare) — holepunch's JavaScript
  runtime; powers the Android and embedded-Linux backends so end users don't
  need Node.js (Apache-2.0).
- [HyperDHT](https://github.com/holepunchto/hyperdht), [udx-native](https://github.com/holepunchto/udx-native)
  and [sodium-native](https://github.com/holepunchto/sodium-native) — the
  encrypted DHT and networking stack underneath (MIT/Apache-2.0).
- [Tauri](https://tauri.app) — the desktop/mobile framework (MIT/Apache-2.0).
- The current app icon is the Tauri template icon (kept by user preference).

## License

[MIT](LICENSE) © 2026 chethan62 — for this project's own code.

**Note:** the bundled `holesail` engine (the service worker) is
[AGPL-3.0](https://github.com/holesail/holesail). Distributing an app that
embeds AGPL code carries source-availability obligations for the combined
work; the GUI's own source is here, so this is effectively satisfied, but if
you intend commercial redistribution, review AGPL implications or contact the
upstream maintainers.
