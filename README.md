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

| Platform    | Status                                      | Deliverables                                                 |
| ----------- | ------------------------------------------- | ------------------------------------------------------------ |
| **Linux**   | ✅ fully working                            | `.deb`, `.rpm`, `.AppImage`, pacman, `.flatpak`              |
| **Windows** | ✅ builds + boots its packaged worker in CI | `.msi`, `.exe` (NSIS) — bare runtime bundled, no Node needed |
| **Android** | ✅ backend works (bare runtime) — arm64 APK | debug APK — see the [Android](#android) section              |
| **macOS**   | ✅ builds + boots its packaged worker in CI | `.dmg`/`.app` — bare runtime bundled, no Node needed         |

Every platform ships a flatpak bundle from CI alongside the desktop installers; see [Build a release bundle](#build-a-release-bundle).

All four targets are built automatically by the GitHub Actions workflow in
`.github/workflows/build.yml` (artifacts on every push / `workflow_dispatch`),
and the Linux, Windows and macOS jobs also **boot the worker they packaged**
under the runtime they bundled — that check is what found the macOS bundles
dying at startup, so it stays strict. None of them _launch the app_ on real
hardware: the GUI has only been exercised on Linux here. macOS builds are
unsigned and un-notarized, so Gatekeeper wants right-click → Open on first
launch. The flatpak job builds the GNOME-platform bundle in CI too (artifacts on
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

**Tunnel engine is swappable** (`worker/engine/`). `TUNNEL_ENGINE=iroh`
selects [iroh](https://iroh.computer) — QUIC, NAT hole-punching with relay
fallback, MIT/Apache-2.0 — behind the same RPC contract. Differences worth
knowing before relying on it:

- **Keys differ**: iroh tickets (`iroh://endpoint…`) instead of `hs://s000…`.
  Different network — an iroh key and a holesail key can never reach each other.
- **Always encrypted** (TLS 1.3): the "secure" toggle is a no-op; there is no
  plaintext mode.
- **UDP rides native QUIC datagrams** (`udp: true`), one tunnel flow per
  local source address — the same topology holesail uses, so a service that
  keys sessions by source port behaves identically. Consequence of using real
  datagrams: an oversized datagram is dropped, and the drop is counted. holesail
  has no such MTU bound, but whether an 8 KiB datagram arrives intact or comes
  back silently truncated at 2048 bytes varies with the environment, not with the
  engine: measured intact under Bare on a dev box, truncated to 2048 under the
  same Bare on a CI runner and under Node in both places. So a large-datagram
  service (TFTP-style transfers, some game traffic) cannot rely on it either
  way. The suite asserts what holds everywhere — the payload is delivered whole
  or at that 2 KB ceiling, never mangled into a third length, and the tunnel
  keeps working — and logs the measured number instead of asserting it.
- **Node only**: `@number0/iroh` ships napi prebuilds, which the packaged Bare
  runtime cannot load — so it is selectable in dev/tests, not in shipped
  packages yet. Shipping it means bundling the **Node** binary as the worker
  runtime instead of Bare (the layout the worker already uses) — measured
  trade-offs in Known issues.
- **A fixed key = a stable identity**: hashing the key derives a deterministic
  endpoint, so a permanent tunnel keeps its address across restarts. A peer
  that only receives still works — bi-streams are announced with a handshake,
  the way iroh's own `dumbpipe` does it.
- **Bulk throughput is ~7x slower** — and this one is not a design choice, it
  is a limit of the current JS binding. Measured on one machine, same bench,
  same services, both ends in separate processes:

  |                              | upload    | download  | 20 sockets at once  |
  | ---------------------------- | --------- | --------- | ------------------- |
  | holesail                     | 28.9 MB/s | 30.8 MB/s | 20/20 in 3.6 s      |
  | iroh (`@number0/iroh` 1.1.0) | 4.1 MB/s  | 4.1 MB/s  | 20/20 in **0.09 s** |

  iroh's per-connection cost is ~40x lower (QUIC streams are nearly free) and
  it reaches a direct path the same way, but every byte of tunnel payload
  crosses the JS boundary as a **plain JS array**, not a typed array:
  `recv.read()` returns `Array` (~0.19 µs/byte) and `send.write()` _rejects_
  `Buffer`/`Uint8Array` ("Failed to get Array length"). That caps a JS host at
  ~4 MB/s no matter the chunk size — chunk size, receive window (16/64 MB),
  relay-off and stream limits were all measured and change nothing. The
  upgrade path is small and upstream: accept/return `Uint8Array` in
  `iroh-ffi`'s napi signatures (`Vec<u8>` → typed array) and the same
  memcpy path would run at hundreds of MB/s. Until then, pick per use case —
  iroh for many short-lived connections and awkward NATs, holesail for
  streaming or moving files.

`npm run test:iroh` runs the whole E2E suite against that engine.

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
                     # format + lint + node/iroh/bare suites + rustfmt + clippy
                     # + cargo test (add scripts/ci-ui-smoke.py by hand when
                     # renderer files changed — it needs a built binary)
```

The test talks to the exact same `service-worker.js` the GUI uses, so a green
`npm test` verifies the full backend chain (validation → holesail → hyperdht →
real tunnel). `npm run test:iroh` runs the same 21 sections against the
alternate engine; the suite is engine-aware only where behaviour genuinely
differs (the key scheme, the lookup record, the capped-burst outcome, the RSS
bound and UDP's datagram ceiling), and every branch is asserted per engine.
`npm run test:bare` is the leg that runs the worker under the runtime a
PACKAGED build uses — the only local check that sees a Node-only global, and
CI runs it too.

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
string — hit **Copy** and send it to whoever needs access. Server cards also show
a **Copy LAN URL** row (`http://<lan-ip>:<port>`) — a phone on the _same network_
can reach the service directly, no DHT involved.

**Connect** — paste a connection string (`hs://s000…` private or `hs://0000…`
public; secure mode is auto-detected from the prefix). The tunnel is exposed on
your localhost port.

Sessions can be paused/resumed/stopped; the event log at the bottom shows what the worker is doing.

**Speed limits** — every form (Share, Share a folder, Connect) takes an optional
**Speed limit (KB/s)** for that one tunnel, and the Sessions header has a **Total
speed limit** that shapes _all_ tunnels together (one shared budget, so five
busy tunnels can't add up to five times the rate you allowed). Both are live:
change or clear them while tunnels run. The total is remembered across restarts
— permanent tunnels restart on their own, so a link you deliberately capped
doesn't come back uncapped. A cap can't slow a sender that ignores
backpressure; the worker bounds a tunnel's backlog at 16 MB and stops that one
tunnel with a clear error instead of buffering the burst into RAM.

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
- **macOS/Windows bundles are boot-checked in CI, but the apps are unlaunched there** — no Mac or Windows machine here, so "the packaged worker boots under the packaged runtime" is verified and "the window appears" is not. macOS builds are also unsigned and not notarized (no `_CodeSignature` in the `.app`), so Gatekeeper requires right-click → Open on first launch
- **Flatpak** — ships with releases again (CI job restored in v0.6.0); runtime
  behavior on real desktops is still being validated
- **Bandwidth caps: per-tunnel, or one total for all of them** — the Speed-limit (KB/s) field caps a single tunnel's combined up+down; the Sessions header's **Total speed limit** is a shared budget every tunnel is charged against. There's no per-direction control yet (one combined figure per tunnel, and one total)
- **A cap can't slow a sender it doesn't control (holesail engine)** — that engine's TCP piper ignores socket backpressure, so a producer sending faster than the cap cannot be paused. The worker bounds a tunnel's backlog at 16 MB and stops _that_ tunnel with a clear, actionable error rather than buffering the burst into RAM (so for a transfer much larger than that, raise or remove the cap). The iroh engine paces the producer through QUIC flow control instead, so the same burst never accumulates — measured +1 MiB RSS, no error, tunnel stays up
- **The iroh engine is dev/test-selectable only** — packaged builds bundle the Bare runtime, whose ABI cannot load `@number0/iroh`'s napi prebuilds, so `TUNNEL_ENGINE=iroh` fails in an installed app. The measured path to ship it: bundle the **Node binary as the worker runtime** (`bare` → `node`; the worker+resources layout is unchanged and already runs both engines under Node — verified end to end on Linux). Cost: ~+22 MB compressed per installer (node 41.9 MB vs bare 19.7 MB gzipped; the iroh prebuild itself is 168 KB), and Node is MIT so it redistributes fine. A Node **single-executable** (SEA) binary is NOT the answer here: its injected script can only `require` built-ins (measured: `require('./worker/runtime.js')` fails), so it would need a JS bundler plus a native-addon `dlopen` shim. Android keeps Bare either way (no official Node build for it). The UI also still speaks `hs://`: an iroh key works when pasted, but deep links and the key-format hints assume holesail. Bulk throughput is the other caveat: ~4 MB/s, ~7x below holesail, because the JS binding moves payload bytes one array element at a time (measured; engine section above)
- **File manager sharing is basic** — single root path, one role/username/password pair per tunnel; no multi-user ACLs
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

**Note:** the bundled `holesail` engine (the service worker) is
[AGPL-3.0](https://github.com/holesail/holesail). Distributing an app that
embeds AGPL code carries source-availability obligations for the combined
work; the GUI's own source is here, so this is effectively satisfied, but if
you intend commercial redistribution, review AGPL implications or contact the
upstream maintainers.
