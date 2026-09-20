# Holesail GUI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/chethan62/holesail-gui/actions/workflows/build.yml/badge.svg)](https://github.com/chethan62/holesail-gui/actions/workflows/build.yml)

A desktop GUI for [Holesail](https://github.com/holesail/holesail) — the peer-to-peer
TCP/UDP tunnel. Share any local port with the world, or connect to someone else's
tunnel, from a friendly window instead of the CLI.

Built with **Tauri v2** (Rust + system webview) and a **plain-Node service worker**. Packaged builds bundle the [Bare](https://github.com/holepunchto/bare) runtime, so end users don't need Node.js installed.

[![Latest release](https://img.shields.io/github/v/release/chethan62/holesail-gui?color=teal&label=release&sort=semver)](https://github.com/chethan62/holesail-gui/releases/latest)

**Contents:** [What is this?](#what-is-this-tool) · [Why a GUI?](#why-a-gui) · [Benefits](#benefits-tldr) · [Platforms](#platforms) · [Architecture](#architecture) · [Requirements](#requirements) · [Run](#run-development) · [Test](#test) · [Build](#build-a-release-bundle) · [Using the app](#using-the-app) · [Android](#android) · [Changelog](#changelog) · [Known issues](#known-issues--limitations) · [FAQ](#faq--details) · [Security](#security-notes) · [License](#license)

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

<details>
<summary>The three usual headaches</summary>

Exposing a local service to the internet usually means one of these
headaches:

- **Port forwarding** — requires router admin access, a public/static IP,
  and it punches a hole in your home network's firewall
- **CGNAT** — many ISPs (especially mobile and home fiber in some regions)
  don't give you a public IPv4 at all, so port forwarding is impossible
- **Tunneling services (ngrok/cloudflare tunnels)** — work, but route all
  your traffic through a third-party server, add latency, and put a
  single company between you and your data

holesail sidesteps all three: both ends connect _outward_ to the DHT
(no inbound ports, works behind any NAT), find each other by key, and
then talk directly peer-to-peer with end-to-end encryption. **No relay
server, no open firewall ports, no static IP.**

</details>

## Why a GUI?

<details>
<summary>What the GUI adds over the CLI</summary>

The CLI works, but tunnels are a _continuous_ thing, not a one-shot
command. The GUI adds what the terminal can't:

- **Permanent tunnels** — a fixed key that never changes and
  auto-restarts with the app, so your phone always knows where to find
  your PC
- **Saved connections** — one tap to reconnect to a key you use often
- **Background operation** — the app lives in the system tray; tunnels
  keep running when the window is closed (desktop) and survive device
  reboots (Android boot receiver, desktop login autostart)
- **A phone app** — the same codebase runs on Android, so a phone can be
  a tunnel _server_ too (e.g. share Termux/HTTP servers outward)

</details>

## Typical uses

<details>
<summary>Real-world scenarios</summary>

- Reach your home PC's apps (SearXNG, Jellyfin, dev servers) from your
  phone on mobile data
- Share a local dev server with a colleague — no ngrok, no deploy
- Access a service on your phone (e.g. an on-device web server) from
  your PC
- A private, key-based alternative to exposing services — nobody can
  connect without the connection string

</details>

## Benefits (TL;DR)

<details>
<summary>Why use this over the alternatives</summary>

- **No server in the middle** — traffic isn't routed through a third-party relay you have to trust (ngrok/cloudflare-style); it rides the public HyperDHT
- **No router access, no static IP, no port forwarding** — works behind CGNAT and any NAT
- **End-to-end encrypted** in secure mode (`hs://s000…`); the key _is_ the address — nobody can connect without it
- **Zero-config for end users** — packaged builds bundle the Bare runtime, no Node.js install
- **Permanent tunnels with fixed keys** — set once, auto-restart on app launch, login, and device boot
- **One codebase, four platforms** — Linux/Windows/macOS desktop + Android phone (phone can be a tunnel _server_ too)
- **Private-by-default UI** — keys in the OS keychain, sandboxed renderer, no telemetry

</details>

## Platforms

| Platform    | Status                                      | Deliverables                                                        |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------- |
| **Linux**   | ✅ fully working                            | `.deb`, `.rpm`, `.AppImage`, pacman, `.flatpak`                     |
| **Windows** | ✅ builds + boots its packaged worker in CI | `.msi`, `.exe` (NSIS) — bare runtime bundled, no Node needed        |
| **Android** | ✅ backend works (bare runtime) — arm64 APK | debug APK — worker + runtime checked in CI, see [Android](#android) |
| **macOS**   | ✅ builds + boots its packaged worker in CI | `.dmg`/`.app` — bare runtime bundled, no Node needed                |

Every platform ships a flatpak bundle from CI alongside the desktop installers; see [Build a release bundle](#build-a-release-bundle).

All four targets are built automatically by the GitHub Actions workflow in
`.github/workflows/build.yml` (artifacts on every push / `workflow_dispatch`),
and the Linux, Windows and macOS jobs also **boot the worker they packaged**
under the runtime they bundled — that check is what found the macOS bundles
dying at startup, so it stays strict. None of them _launch the app_ on real
hardware: the GUI has only been exercised on Linux here. macOS builds are
ad-hoc signed but **not notarized**, so the first launch is a Gatekeeper prompt
you allow under System Settings → Privacy & Security (the old
right-click → Open bypass was removed in Sequoia). Note the signature is not
optional on Apple Silicon: an unsigned `.app` is reported as _damaged_ with no
way to allow it. The flatpak job builds the GNOME-platform bundle in CI too (artifacts on
every push; verified release flow ships it with releases).

## Architecture

<details>
<summary>How the pieces fit</summary>

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

**The tunnel engine is holesail** (`worker/engine/`, AGPL-3.0) — and it is the
only one. A second engine was built and measured here: [iroh](https://iroh.computer),
QUIC with hole-punching and relay fallback, MIT/Apache-2.0. It could never ship
from this repo — `@number0/iroh` ships NAPI-RS prebuilds needing Node >= 20.3,
while the packaged worker runs under Bare, which loads only its own addon ABI —
so it became its own project: **github.com/chethan62/iroh-tunnel**, taking the
UDP datagram work, the reachability probe and its tests with it.

The measurements that decided that are worth keeping (one machine, same bench,
both ends in separate processes):

|                              | upload    | download  | 20 sockets at once  |
| ---------------------------- | --------- | --------- | ------------------- |
| holesail                     | 28.9 MB/s | 30.8 MB/s | 20/20 in 3.6 s      |
| iroh (`@number0/iroh` 1.1.0) | 4.1 MB/s  | 4.1 MB/s  | 20/20 in **0.09 s** |

iroh wins connection setup by ~40x and carries datagrams natively, but every
payload byte crosses its JS boundary as a plain `Array` (not a typed array),
capping a JS host at ~4 MB/s whatever the chunk size — the analysis is in the
other project's README. For a GUI whose main job is moving files, ~7x slower
bulk transfer was the deciding factor, and the licence question it was built to
answer is a decision about this repo, not a second engine.

</details>

## Requirements

<details>
<summary>Dev + end-user needs</summary>

- **Node.js 18+** (`node` on PATH) — for development (`npm run dev`) on every
  platform. Packaged installers for **all four targets** (Linux, Windows,
  macOS, Android) embed the **Bare** runtime instead, so end users don't need
  Node.js installed at all — see [Build a release bundle](#build-a-release-bundle).
- Rust toolchain (`cargo`) for Tauri
- Linux: `webkit2gtk-4.1` + `gtk3` dev packages (Tauri prerequisites;
  see [Tauri docs](https://v2.tauri.app/start/prerequisites/))

</details>

## Run (development)

```bash
npm install          # installs holesail (worker dep) + @tauri-apps/cli
npm run dev          # tauri dev — builds the Rust backend and opens the window
```

## Test

```bash
npm test             # E2E: spawns the real service worker, starts a server on
                     # the DHT, connects a client, stops both, asserts protocol
npm run gate         # the whole pre-push gate in CI's order, fail-fast:
                     # format + lint + node/bare suites + rustfmt + clippy
                     # + cargo test (add scripts/ci-ui-smoke.py by hand when
                     # renderer files changed — it needs a built binary)
```

The test talks to the exact same `service-worker.js` the GUI uses, so a green
`npm test` verifies the full backend chain (validation → holesail → hyperdht →
real tunnel). The suite is engine-agnostic now — the only axis left is the
runtime, which genuinely changes behaviour (the UDP datagram ceiling and the RSS
reading: see §16 and §20), and §22 (the iroh engine's key parser) went with that
engine, so the section numbering has a gap. `npm run test:bare` is the leg that
runs the worker under the runtime a PACKAGED build uses — the only local check
that sees a Node-only global. CI runs both legs.

## Build a release bundle

<details>
<summary>Linux (.deb/.rpm/AppImage/pacman/Flatpak)</summary>

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

> The flatpak job builds this bundle in CI (GNOME Platform//47) and ships it
> with releases; the build.sh flow above is for local/manual builds. Runtime
> behavior on real desktops is still being validated.

</details>

<details>
<summary>macOS / Windows</summary>

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

</details>

## Using the app

<details>
<summary>Share, connect, saved tunnels, deep links, tray</summary>

**Share a port** — pick a local port (e.g. 3000), optionally a custom 32+ hex char key,
toggle private/public. A session card appears with the `hs://s000…` connection
string — hit **Copy invite link** and send it to whoever needs access. Server cards also show
a **Copy LAN URL** row (`http://<lan-ip>:<port>`) — a phone on the _same network_
can reach the service directly, no DHT involved.

**Share a folder** — its own tab: drop a folder from your file manager (or type
its path) and get an invite link for it, with no port to pick. The form is the
first thing on the tab, so it is reachable without scrolling past the port form.

**Connect** — paste the link you were sent (`hs://s000…` private, `hs://0000…`
public; which one it is gets detected for you). The tunnel is exposed on your
localhost port.

Sessions can be paused/resumed/stopped; the event log at the bottom shows what the worker is doing.

**Speed limits** — every form (Share a port, Share a folder, Connect) takes an optional
**Speed limit (KB/s)** for that one tunnel, and the Sessions header has a **Total
speed limit** that shapes _all_ tunnels together (one shared budget, so five
busy tunnels can't add up to five times the rate you allowed). Both are live:
change or clear them while tunnels run. The total is remembered across restarts
— permanent tunnels restart on their own, so a link you deliberately capped
doesn't come back uncapped. A cap can't slow a sender that ignores
backpressure; the worker bounds a tunnel's backlog at 16 MB and stops that one
tunnel with a clear error instead of buffering the burst into RAM.

**Temporary vs Permanent** — the Tunnel type selector on the Share a port tab chooses
between a one-off key (new random key each start) and a **permanent** tunnel:
fixed key, named, saved, and auto-restarted whenever the app (re)starts.
Connect has a matching **Save this connection** checkbox for keys you use often.

**Saved tab** — every permanent tunnel and saved connection is listed here with
Start/Stop, an Auto-start toggle, Rename, Duplicate, Export (to clipboard) and
Delete (two-tap confirm). **Import** merges exported JSON back in. On desktop,
Auto-start tunnels also enable login autostart, so they survive PC reboots; on
Android, a boot receiver restores them after device reboots.

**Deep links (`hs://`)** — clicking a connection string link (or running `xdg-open "hs://…"`) opens the app with the Connect form pre-filled, even if it was hidden in the tray. The app registers itself as the handler for the `hs://` scheme on Linux/Windows at first run; on Android, the scheme is baked into the APK manifest. A second app launch while one is running routes to the existing instance instead of duplicating.

**System tray** — closing the window hides the app (tunnels keep running) and a tray icon appears with _Show / Stop all tunnels / Quit_. Quit from the tray is the only way to fully exit while tunnels are active.

</details>

## Android

<details>
<summary>APK build</summary>

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
     but _does_ allow exec of the extracted APK lib dir (`apk_data_file`);
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

</details>

## Changelog

<details id="v0.11.3">
<summary><b>v0.11.3</b> — new app icon: the sailboat gains a cyan jib</summary>

- New artwork, generated and supplied by the user: an orange hull, brown spars, a
  yellow-to-amber main sail and a new cyan jib. The whole family is regenerated
  from one 1254px transparent master with `npx tauri icon`, so every size comes
  from the same source and cannot drift.
- Framing is normalised to the outgoing master — content fills 81.6% x 82.5% of
  the canvas, against the previous 80.4% x 82.5% — so the mark does not change
  size in the launcher.
- Verified: master corner alpha 0; reads on both `#0f1420` and `#eef2f9`; no
  colour family collapses at launcher size (cyan 20.2% -> 19.1%, gold 19.6% ->
  18.9%, orange-red 35.1% -> 32.0%, brown 13.0% -> 16.0%). The in-app header
  keeps deriving its logo from `128x128.png` each build.

</details>

<details id="v0.11.2">
<summary><b>v0.11.2</b> — stopping a share now actually clears the card</summary>

- **"Stop sharing" looked like it did nothing.** The worker stopped the tunnel
  and sent a `stopped` event; the renderer deleted the session from every state
  map — and never re-rendered. The card stayed on screen until some unrelated
  event happened to rebuild the list, so a share that was already down still
  looked live. The `stopped` branch re-renders now, which also brings the empty
  state back when the last share ends.
- **The Saved tab had the same shape of bug.** Its Start/Stop button reads the
  live session, but neither action refreshed the list, so the button kept
  offering "Stop" for a tunnel that was already down. Both paths refresh.
- **A renderer check now guards it**, which is why it shipped: nothing asserted
  the _screen_ after a stop, only that the state changed. `test/renderer.test.js`
  drives the real renderer module against a minimal DOM stub and fails if a
  stopped session stays on the page — proven to fail on the pre-fix code and to
  pass on this one.

</details>

<details id="v0.11.1">
<summary><b>v0.11.1</b> — a folder in your home is shareable again, and the port field suggests real ports</summary>

- **A folder sitting directly in your home could not be shared.** The guard
  refused the home directory _and every immediate child of it_, so its own
  advice — "share a specific subfolder instead" — was impossible to follow:
  `~/SAP_fico_doc` was rejected as a "broad path". Only hidden entries
  (`~/.ssh`, `~/.gnupg`, `~/.aws`) hold secrets; a named child is the intended
  use. Both implementations move together (`worker/guards.js` and the
  renderer's twin in `ui.js`), and the suite now asserts the ALLOWED direction
  as well as the refusal — the refusal-only assertion passed while the allowed
  direction was broken, which is how this survived several releases.
- **The Local port field suggests the ports this machine is listening on** —
  "node 3000 · python 8000", each entry clickable to fill the field, refreshed
  when the field is focused. (A random free port would have been the wrong
  control: on Share a port you are exposing a service that is _already_
  running, so a free port tunnels to nothing.)
- **A dead renderer is caught before it ships.** A named import that does not
  exist fails the whole module graph to link while the static markup still
  renders — the window looks normal, every listener is silently absent, and
  nothing reaches the event log, with eslint, prettier and both suites green.
  The link stage is now checked: `node --input-type=module -e "import('./renderer/app.js')"`.

</details>

<details id="v0.11.0">
<summary><b>v0.11.0</b> — the folder share gets its own tab, and <code>hidden</code> starts working</summary>

- **Sharing a folder was effectively the hidden feature.** An adversarial UX
  pass as a non-technical persona (a bookkeeper sharing a folder with a client)
  found the folder form sitting at y=1276 in an 888-tall window, while the port
  form — a task she did not have — had a complete submit button at y=700 and no
  nav entry pointed at her screen. The folder share is now its own tab, above
  the fold, and the port tab points at it.
- **`hidden` did nothing on a form label.** The UA rule
  `[hidden] { display: none }` is outranked by any class rule that sets
  `display`, and `.grid-form label { display: flex }` does exactly that — so the
  folder form rendered Name and Custom key while "Permanent" was unticked, and
  the port form's Name field had the same latent bug. Fixed once at the root,
  which also made the older single-element `#recent-row[hidden]` rule redundant.
- **The delivery moment is named for its purpose.** The card's action is
  "Copy invite link" (it was "Copy", tooltip "Copy connection string") and says
  what to do with it; "Private mode (secure)" became "Private link
  (encrypted)"; the Connect tab says "paste the link you were sent"; and the
  Node-runtime screen no longer claims "v18+" or tells a user of a bundled
  build to install Node.js.
- **Number-key tab shortcuts follow the tab row** instead of hardcoded 1/2/3,
  which the fourth tab would otherwise have desynced (2 opened Connect).

</details>

<details id="v0.10.5">
<summary><b>v0.10.5</b> — the chosen sailboat icon, and the header logo stops aliasing</summary>

- **The icon is one transparent master**, expanded by `npx tauri icon` into the
  whole 35-file family (window, installers, launcher, Android, macOS, Windows),
  so the launcher, taskbar, tray and in-app header cannot disagree about what
  the app looks like. It has to be transparent: the same file is drawn on the
  header's dark background and used as the launcher icon, so a badge or a
  coloured tile would render a hard square in the header.
- **The header had been drawing that logo with nearest-neighbour aliasing since
  v0.10.3.** That release removed an `image-rendering: pixelated` hint — correct
  for the old pixel-art mark, wrong for this artwork — but the edit missed the
  `.logo` declaration and the comment left behind claimed it had been removed.
  The hint is gone, the logo is 28px, and the QR code keeps `pixelated`, where
  it is genuinely correct.

</details>

<details id="v0.10.4">
<summary><b>v0.10.4</b> — icon iteration, and CI stops skipping an assertion</summary>

- Icon-only: a second candidate master, normalized to the same coverage and
  checked at 32×32 and on both a dark and a light background before being
  expanded into the family. A later candidate superseded it.
- **CI was skipping an assertion it was supposed to run.** The installer
  smoke's desktop-database check reported a skip because
  `update-desktop-database` was missing on the runner, so the handler entry was
  never verified there. The linux job installs `desktop-file-utils` and the
  assertion now runs for real.

</details>

<details id="v0.10.3">
<summary><b>v0.10.3</b> — a crisp sailboat replaces the pixel-art mark; the installer writes the <code>hs://</code> handler</summary>

- **The old mark was pixel art**, so every size above 32px showed hard edges.
  It is replaced by a vector master rendered at 1024 and expanded into the full
  family, and the Android notification silhouette is regenerated from the same
  file.
- **A brand-new user clicking an `hs://` invite link before the app's first
  launch got nothing.** Tauri writes the scheme handler at runtime, on first
  launch, and the installer wrote only the menu entry.
  `scripts/install-linux.sh` now writes the handler entry and refreshes the
  desktop database, and the installer smoke asserts both.
- **The Flatpak showed a generic icon in every menu**: the manifest installed
  `io.holesail.gui.png` while the desktop entry asked for `Icon=holesail-gui`.
  Fixed, and CI now asserts that the `Icon=` name resolves — for the flatpak
  and for the deb.

</details>

<details id="v0.10.2">
<summary><b>v0.10.2</b> — the sailboat icon returns; <code>install-linux.sh</code> stops failing silently</summary>

- **`--no-build` with no build failed with no message at all.** Under
  `set -euo pipefail`, `APPIMAGE="$(ls … | head -1)"` takes the failing
  pipeline's status and exits _before_ the guard that would have explained the
  missing AppImage. Fixed with `|| true` and a comment recording the trap, and
  `scripts/ci-install-smoke.sh` now runs the REAL installer into a throwaway
  `HOME`, asserting both directions — including that the guard FIRES.
- The launcher and in-app header icons are derived from `src-tauri/icons/` at
  build time, so they cannot drift from the master.

</details>

<details id="v0.10.1">
<summary><b>v0.10.1</b> — folder shares get a real password, not the well-known default</summary>

- **A folder share used to be protected by `admin`/`admin`.** The bundled
  Livefiles file server defaults to those credentials, the worker passed none,
  and the session card displays the pair in use with a reveal toggle — so the UI
  advertised a secret where there was a well-known default. On a **public**
  tunnel (`hs://0000…`, whose key is public by design) that left the shared
  folder effectively unauthenticated: the password was the only remaining
  barrier and it was guessable. Each share now generates a 96-bit password and
  shows it, and an explicit username/password from a caller still wins — a
  deliberate divergence from the CLI's `--filemanager`, which has no card to
  display the pair on.
- The suite checks both directions: the generated password is accepted, and
  `admin:admin` is **refused with a 401** (without that second assertion the
  first would still pass if the generated password were ignored).

</details>
<details id="v0.10.0">
<summary><b>v0.10.0</b> — one engine again: the iroh engine became its own project</summary>

- **The iroh engine moved out.** It was built here as an opt-in second engine
  (`TUNNEL_ENGINE=iroh`) and could never ship from this repo: `@number0/iroh`
  ships NAPI-RS prebuilds needing Node >= 20.3, while packaged builds run the
  worker under Bare, which loads only its own addon ABI. It lives at
  **github.com/chethan62/iroh-tunnel** now — with the UDP datagram work, the
  reachability probe, the throughput analysis, and its own tests (including the
  key-parser check that used to be §22 here). `@number0/iroh` is out of
  package.json, Rust no longer reads `TUNNEL_ENGINE`, the engine seam is a
  holesail-only re-export, and the CI leg that ran the iroh suite is gone.
  **No behaviour change for users**: no shipped build could select iroh, since
  the packaged worker never had a Node runtime to load it in.
- **Engine-agnostic code stayed and was reworded, not deleted.** The Saved tab's
  handling of a server with no fixed key — no derivable connection string — was
  written for iroh's tickets but is a real holesail case too, so it kept its
  behaviour and only lost the iroh naming; the UI hints no longer mention a key
  format this app cannot produce.

</details>
<details id="v0.9.5">
<summary><b>v0.9.5</b> — the GPLv3 dependency's licence now ships; the two method lists are checked</summary>

- **Compliance: an undisclosed GPLv3 dependency shipped without its licence
  text.** `livefiles` (the file server behind folder sharing) is GPLv3 and
  publishes no licence file, so every installer redistributed GPL code with no
  copy of the licence — which GPLv3 §4 requires you to pass on. The build now
  writes a vendored copy (`packaging/licenses/GPL-3.0.txt`) in beside the bundled
  package, so it rides the existing `node_modules` resource mapping into every
  installer (deb/rpm/AppImage, msi/exe, dmg, APK, flatpak) with no new packaging
  path to keep in sync, and refuses to build if that copy does not land. The
  README's licence note covered `holesail` alone, so the second copyleft
  dependency was undisclosed too; both are now listed with what they require.
- **The worker's dispatch table and the Rust allowlist are now checked against
  each other.** They are maintained by hand in two languages, and a drift is
  silent in both directions: a method missing from Rust's `ALLOWED` list is
  unreachable from the UI, and one missing from `dispatch.js` dies as an unknown
  method after a full round trip. Suite §23 parses both and asserts they agree in
  both directions, with `test:throw` as the single documented exception — a test
  hook the suite drives directly over stdio, which must stay out of production
  reach. The guard proved itself immediately by catching that assumption, and its
  failure direction is verified by deleting an entry from either list.

</details>
<details id="v0.9.4">
<summary><b>v0.9.4</b> — a rejected key is no longer written to the log</summary>

- **The iroh engine echoed part of a rejected key into an error message.** A bad
  key was reported as `Invalid key format: <first 24 characters>…`, and the
  renderer writes worker errors to the persistent event log — the one with a
  **Copy log** button, meant to be pasted into bug reports. So a truncated or
  mistyped key's first 24 characters went to disk and into the report. The
  message now reports the input's _length_ instead (same diagnostic value — a
  short paste is the actual cause) and carries no key material. The
  `Invalid key format` prefix stays: the renderer maps it to a peer status.
- **Two test suites had never run in CI.** The iroh engine is opt-in via
  `TUNNEL_ENGINE`, and that string appeared nowhere in the build workflow — so
  every iroh assertion, including the new one above, ran only on a developer's
  machine. The 28 Rust tests had the same gap: they were a hand-run pre-release
  step. Both are CI steps now, and both pass there.
- **Docs corrected**: the macOS note called the bundles unsigned and told you to
  right-click → Open. They have been ad-hoc signed since v0.9.2 (CI asserts the
  signature seals the bundled runtime), and right-click → Open stopped working in
  Sequoia — first launch is allowed under System Settings → Privacy & Security.
  An unsigned `.app` cannot run on Apple Silicon at all. The suite is also 22
  sections, not 21.

</details>
<details id="v0.9.3">
<summary><b>v0.9.3</b> — flatpak installs work: their worker could not start</summary>

- **The flatpak bundle shipped a worker that died at startup.** The manifest
  installs the worker from a hand-written file list, and that list said
  `worker/*.js` — a flat glob. When the engine seam added `worker/engine/`, the
  directory stopped being installed, so every flatpak build since v0.9.0 loaded
  `service-worker.js`, failed to find `./engine/index.js` and exited: a flatpak
  user got a dead worker, "connecting…" and no tunnels. Every other packaging
  path copies the whole directory, which is why flatpak alone was affected — and
  why nothing noticed for four releases. The manifest now copies recursively (a
  future subdirectory cannot drift), and the flatpak job boots the worker it
  installed before uploading the artifact.
- **Android now gets a real check too** — CI asserts the APK contains the worker
  entry and modules, and that the bundled runtime exports the addon ABI symbols
  it binds against. That is the same test that caught the macOS breakage, run on
  the one platform CI cannot boot.

</details>

<details id="v0.9.2">
<summary><b>v0.9.2</b> — macOS downloads install now: the bundle is signed</summary>

- **macOS builds are ad-hoc signed, so a downloaded `.dmg` opens.** v0.9.1 fixed
  the macOS worker dying at startup, but the `.app` inside it carried no
  signature at all, and Apple Silicon refuses unsigned apps from the internet:
  macOS calls them "damaged and can't be opened", which is not a prompt you can
  click past. The macOS build now signs ad-hoc
  (`APPLE_SIGNING_IDENTITY=-`), so first launch shows the
  unidentified-developer warning you CAN allow under System Settings → Privacy &
  Security. **If you downloaded v0.9.1's `.dmg`, use this one.** Not notarized —
  that needs a paid Apple Developer account, so the prompt stays for now.
- **CI asserts the signature rather than trusting the build to have made one** —
  the bundle must carry `_CodeSignature/CodeResources`, that file must seal
  `Resources/bare` (an unsigned runtime inside a signed app is the exact failure
  that made the earlier macOS builds dead on arrival), `codesign --verify --deep
--strict` must pass, and every nested `.bare` addon must carry a signature of
  its own (33/33 at the time of writing — an unsigned one is something arm64
  refuses to load).

</details>

<details id="v0.9.1">
<summary><b>v0.9.1</b> — macOS builds actually worked on: they were dying at startup</summary>

- **macOS installs could never have worked — now they boot.** The bundle shipped
  a runtime stripped with `--strip-all`, which on a Mach-O deletes the global
  symbol table a `.bare` addon resolves when it loads, so the worker segfaulted
  the instant it started: every macOS build so far was dead on arrival, and
  nothing said so. Linux and Windows are unaffected (ELF and PE keep what
  addons need, so they keep the size win). Found by the new check below; the
  shipped `.app`'s own runtime now carries the symbols, verified in the release
  artifact. **If you downloaded the v0.9.0 `.dmg`, it is broken — use this one.**
- **CI now boots the worker each platform packaged, under the runtime it
  bundled** — Linux (deb + AppImage payloads), Windows and macOS. This is the
  check that found the macOS failure, so it stays strict; the older macOS
  bundles had only ever been "the dmg built". The suite's own passing run is
  what a packaged build has to reproduce.
- **The UI stopped fighting the platform's own widgets** — the Tunnel-type
  dropdown rendered white in the dark theme (WebKitGTK ignores a select's
  background until `appearance: none`), the number fields' native spinners read
  as unlabelled buttons, and the topbar's icon buttons were ~26×22 with no
  background. Icons are inline SVG now, with accessible names and a focus ring;
  the logo matches the app's own artwork instead of an emoji; and the window
  opens tall enough to show the whole Share form.
- **An oversize UDP datagram's fate is described, not asserted** — whether
  holesail delivers an 8 KiB datagram intact or truncates it at 2 KB varies
  with the machine (measured: intact under Bare on one box, 2 KB on a CI runner
  and under Node everywhere), so the suite asserts what holds everywhere — never
  a third length, never silently nothing, tunnel keeps working — and logs the
  number it measured instead of asserting it.

</details>

<details id="v0.9.0">
<summary><b>v0.9.0</b> — swappable tunnel engine (iroh, opt-in) + UDP traffic fixed</summary>

- **UDP tunnel cards show their traffic again** — a UDP session sat at 0/0
  up/down forever: the worker looked for the engine's datagram socket under one
  field name while the engine publishes it under another. Both directions now
  count, and UDP has end-to-end coverage for the first time (a datagram echoed
  through the tunnel from two different local sources — the topology that keeps
  two clients of one UDP service apart).
- **The tunnel engine is swappable** — `TUNNEL_ENGINE=iroh` runs the same
  worker on [iroh](https://iroh.computer) (QUIC, hole-punching with relay
  fallback, MIT/Apache-2.0) instead of holesail, behind the same RPC contract.
  holesail stays the default and an installed build behaves exactly as before;
  iroh is selectable in dev/test builds only, because packaged installers
  bundle the Bare runtime and iroh's native prebuilds cannot load there.
  Measured trade-offs — ~7x slower bulk throughput, ~40x faster connection
  setup — are in [Architecture](#architecture).
- **A dead peer no longer hangs silently** — with the peer gone, app sockets
  used to sit open with nothing logged while the session still read "running";
  the connection's death now resets the streams riding it, and a normal Stop
  no longer writes an error line into the event log.
- **Sessions can be listed right after a start** — listing them within ~200 ms
  of starting one serialized live limiter state and threw `Converting circular
structure to JSON`.
- **Release artifacts are checked themselves** — a packaged build could not
  have started from this line as it stood (the worker read Node's global
  `process`, which the bundled Bare runtime does not have). The deb's own
  worker is now exercised under its own bundled runtime, and the installed
  layout is checked by the UI smoke.

</details>

<details id="v0.8.0">
<summary><b>v0.8.0</b> — total speed limit across all tunnels + capped-transfer fixes</summary>

- **All-tunnels speed limit** — the Sessions header takes a **Total speed limit
  (KB/s)** that shapes every tunnel against one shared budget, so N busy tunnels
  can't each use a full allowance. Live (change or clear it while tunnels run)
  and remembered across restarts, so a link you deliberately capped doesn't come
  back uncapped when permanent tunnels auto-restart.
- **Capped transfers are no longer truncated** — the tunnel engine relays `end`
  through to the far socket and Node silently drops writes after it, so a capped
  transfer whose sender closed on finishing (every HTTP response) was delivered
  truncated with no error. The end is now held until the queue has drained.
- **A cap can't buffer the machine to death** — a producer faster than the cap
  cannot be paused (the engine ignores socket backpressure), so a tunnel's
  backlog is bounded at 16 MB; past that the tunnel stops with an actionable
  error instead of piling up until the app is OOM-killed.
- **Client session Up/Down counters were reversed** — client cards showed
  download as upload (the server and UDP paths were already correct).
- **CI: Android SDK install fixed** — `android-actions/setup-android` defaults to
  the legacy `tools` package, which google no longer publishes; pinned to
  `platform-tools`.

</details>

<details id="v0.7.1">
<summary><b>v0.7.1</b> — reliability fixes: append-only event log, updater progress, payload hygiene</summary>

- **Append-only event log** — `log_append` no longer reads + rewrites the whole
  file on every log line; it appends and only trims once the 64 KiB cap is
  exceeded (was O(n²) on long sessions).
- **Updater progress fixed** — the download percentage now accumulates chunk
  lengths across `Progress` events instead of reporting each chunk as a
  fraction of the total (it previously jumped straight to ~99%).
- **Sessions payload strip** — `sessions:list` no longer serializes the
  Livefiles file-server instance alongside the holesail engine; non-serializable
  engine graphs stay out of every RPC response.
- **Filemanager port guard** — a `0`/negative/NaN port now consistently falls
  back to the default 5409 instead of misbehaving.
- **Android glue drift guard** — the boot/foreground-service patch now fails
  loudly if the Tauri template drifted, instead of silently rewriting
  `MainActivity.kt` unchanged while claiming success.
- **Shared error-wrap helper** — `rpc()` and every `saved-*` call now go
  through one `invokeWrapped()` that normalizes Tauri's raw-string rejections.

</details>

<details id="v0.7.0">
<summary><b>v0.7.0</b> — modular codebase + CI guardrails + UI/security polish</summary>

- **Modular codebase** — the renderer (1,791-line monolith), Rust backend
  (1,694-line `lib.rs`), and service worker (769-line file) are each split
  into focused acyclic modules (15 renderer ES modules, 7 Rust modules, 10
  worker CommonJS modules). Same behavior, far easier to fix and extend.
- **CI guardrails** — ESLint (`npm run lint`) and `rustfmt --check` now run
  in CI; Prettier added as an opt-in formatter.
- **Public-mode warning** — unchecking "Private mode" (or pasting a public
  `hs://0000…` key) shows an amber "no encryption" banner.
- **Plain-English errors** — worker/engine errors are mapped to readable
  messages with a hint instead of raw strings; friendlier empty state with
  a CTA.
- **Drag-and-drop folder sharing** — drop a folder on the window to share it.
- **Live per-session traffic stats**: every tunnel card now shows
  cumulative upload/download bytes, live connection count, and a rolling
  throughput sparkline (teal = upload, yellow = download), refreshed ~2×/s
  in place.
- **Peer notifications**: when someone connects to one of your server
  tunnels, the app logs it and shows a toast (rate-limited) with a total
  connection count.
- **Relay-routing badge**: if the DHT can't hole-punch and falls back to a
  relay, the session card shows a "⇄ via relay" badge (higher latency) and
  the peer's address is logged.
- **Per-session bandwidth cap**: Speed limit (KB/s) on Share, Share-a-folder
  and Connect forms caps combined upload+download throughput (token bucket);
  persisted on saved tunnels; shown as "⏱ cap" on the card.
- App icon replaced with a custom flat two-color mark (teal + yellow,
  transparent background).

</details>

<details id="v0.6.0">
<summary><b>v0.6.0</b> — security hardening + flatpak restored</summary>

- Worker-side broad-path guard: filemanager refuses `/`, `~`, home children (defense-in-depth behind the renderer confirm)
- Flatpak fixed (ayatana-ido pc-file cleanup) — CI job restored, bundle ships with releases again
- `livefiles` declared as a direct dependency (was hoisting-dependent)
- `rust-version = 1.91` pinned; saved-import capped at 100 tunnels (+test)
- Fixed: `confirmInline` crash (both guardrails were dead code), ghost saved tunnels on failed start, filemanager password masking, `logAppend` unhandled rejection, saved-tunnel 90s timeout, `find_node` on Windows
- README overhaul: TOC, benefits, known issues, FAQ — all collapsible

</details>

<details id="v0.5.0">
<summary><b>v0.5.0</b> — permanent folder shares + security hardening</summary>

- **Permanent folder shares**: "Permanent" toggle on the Share-a-folder form (fixed key, saved with the tunnel, auto-restarts with the app)
- Saved tunnels (keys + filemanager creds) now live in the **OS keychain** (0600 file fallback), not plaintext JSON
- Broad-path guardrail: sharing `/`, `~`, or a home dir child asks for confirmation
- Worker session cap (50) + RPC method allowlist
- Bare runtime bundled on **Windows/macOS** too — no Node.js needed anywhere

</details>

<details id="v0.4.0">
<summary><b>v0.4.0</b> — DHT preflight + UI polish</summary>

- Connect flow checks the DHT first — clear "no tunnel found" feedback instead of hanging
- Saved-tab online/offline status badges, LAN URL row on server cards
- Fixed reconnect routing for saved sessions, `hs://0000` display for insecure keys
- UI polish: dark-mode safe-area fixes, badges, focus states

</details>

## Known issues & limitations

<details>
<summary>Current rough edges (honest list)</summary>

- **Public mode (`hs://0000…`) has no encryption** — treat it as an unauthenticated TCP relay; anyone with the key can connect
- **No TCP-over-DHT portability guarantee** — like upstream holesail, tunnels are UDP-DHT based; some restrictive networks still block UDP hole-punching (rare; falls back through DHT relays automatically)
- **macOS/Windows bundles are boot-checked in CI, but the apps are unlaunched there** — no Mac or Windows machine here, so "the packaged worker boots under the packaged runtime" is verified and "the window appears" is not. macOS builds are **ad-hoc signed but not notarized**, so the first launch is
  itself a Gatekeeper prompt to allow in System Settings → Privacy & Security
  (CI asserts the signature exists and that it seals the bundled runtime, so a
  downloaded `.dmg` is installable rather than "damaged"; a Developer ID
  certificate plus notarization would remove the prompt and is a paid-account
  decision, not a code change)
- **Flatpak** — ships with releases again (CI job restored in v0.6.0); runtime
  behavior on real desktops is still being validated
- **Bandwidth caps: per-tunnel, or one total for all of them** — the Speed-limit (KB/s) field caps a single tunnel's combined up+down; the Sessions header's **Total speed limit** is a shared budget every tunnel is charged against. There's no per-direction control yet (one combined figure per tunnel, and one total)
- **A cap can't slow a sender it doesn't control** — the engine's TCP piper ignores socket backpressure, so a producer sending faster than the cap cannot be paused. The worker bounds a tunnel's backlog at 16 MB and stops _that_ tunnel with a clear, actionable error rather than buffering the burst into RAM (so for a transfer much larger than that, raise or remove the cap)
- **Tunnel engine: holesail only** — the iroh engine became its own project (github.com/chethan62/iroh-tunnel) because `@number0/iroh`'s NAPI-RS prebuilds cannot load under the Bare runtime this app packages, and shipping it would have meant bundling Node (+~22 MB per installer) for an engine ~7x slower at bulk transfer. Its UDP datagram work, reachability probe and tests went with it
- **File manager sharing is basic** — single root path, one tunnel = one `admin` username with a freshly generated password (both shown in the session card, with a reveal toggle); no multi-user ACLs
- **Session cap is 50** — intentional, prevents fd exhaustion; raise in `service-worker.js` if you truly need more
- **AGPL-3.0 implications** for the bundled holesail engine if you redistribute commercially (see License)

</details>

## FAQ & details

<details>
<summary>How do I reach my PC from my phone?</summary>

Share the port on the PC, copy the `hs://s000…` string, paste it into Connect on the phone (same app on Android, or the holesail CLI). The phone finds the PC over the DHT and tunnels the port — no port forwarding.
</details>

<details>
<summary>Is the traffic really peer-to-peer?</summary>

Yes — both ends register on the public HyperDHT and exchange connection info; the data path is direct. If a direct connection is impossible (double NAT), the DHT relays packets, still encrypted in secure mode.
</details>

<details>
<summary>What does "secure" mode actually encrypt?</summary>

`hs://s000…` keys derive an encryption key; the tunnel payloads are end-to-end encrypted. `hs://0000…` (public) is plaintext — only use it for services you'd expose publicly anyway.
</details>

<details>
<summary>Why is there a separate worker process?</summary>

The holesail engine uses native addons prebuilt for a specific runtime ABI. Running them inside a webview crashes on ABI mismatch. The worker process (Node in dev, bundled Bare runtime in packages) keeps them stable; the GUI just talks JSON-RPC over stdio.
</details>

<details>
<summary>Does the tunnel survive app restart / reboot?</summary>

Permanent tunnels: yes — desktop login autostart and the Android boot receiver restore them. Temporary tunnels get a fresh key each start and are not restored.
</details>

<details>
<summary>What are the system requirements for end users?</summary>

None beyond the OS — packaged builds embed the Bare runtime, so no Node.js. (Development needs Node 18+ and Rust.)
</details>

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
- [livefiles](https://www.npmjs.com/package/livefiles) — the HTTP file server
  behind folder sharing (**GPLv3** — see the license note below). It publishes
  no licence file, so the build drops a copy of the GPLv3 text in beside the
  bundled package (`packaging/licenses/GPL-3.0.txt`).
- [Bare](https://github.com/holepunchto/bare) — holepunch's JavaScript
  runtime; powers the Android and embedded-Linux backends so end users don't
  need Node.js (Apache-2.0).
- [HyperDHT](https://github.com/holepunchto/hyperdht), [udx-native](https://github.com/holepunchto/udx-native)
  and [sodium-native](https://github.com/holepunchto/sodium-native) — the
  encrypted DHT and networking stack underneath (MIT/Apache-2.0).
- [Tauri](https://tauri.app) — the desktop/mobile framework (MIT/Apache-2.0).
- The app icon is a custom flat two-color mark (teal + yellow interlocking
  shapes on transparent), designed for this project; master artwork in
  `src-tauri/icons/source.png`, regenerable via `tauri icon`.

## License

[MIT](LICENSE) © 2026 chethan62 — for this project's own code.

**Note:** two bundled runtime dependencies are copyleft, and both now ship their
licence text inside every installer:

- `holesail` — the tunnel engine behind the service worker —
  [AGPL-3.0](https://github.com/holesail/holesail). Distributing an app that
  embeds AGPL code carries source-availability obligations for the combined
  work; the GUI's own source is here, so this is effectively satisfied, but if
  you intend commercial redistribution, review AGPL implications or contact the
  upstream maintainers.
- `livefiles` — the HTTP file server behind folder sharing — GPLv3. The package
  publishes no licence file, so the build writes a copy of the text from
  [`packaging/licenses/GPL-3.0.txt`](packaging/licenses/GPL-3.0.txt) into the
  bundled package, which satisfies GPLv3 §4's requirement to pass the licence
  on. Its corresponding source is the upstream npm package.

Every other bundled package is permissive (MIT/Apache-2.0) and ships its own
`LICENSE` inside the bundled `node_modules`; this project's own code stays MIT.
