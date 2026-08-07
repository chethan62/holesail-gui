# Holesail GUI

A desktop GUI for [Holesail](https://github.com/holesail/holesail) — the peer-to-peer
TCP/UDP tunnel. Share any local port with the world, or connect to someone else's
tunnel, from a friendly window instead of the CLI.

Built with **Tauri v2** (Rust + system webview) and a **plain-Node service worker**.

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
npm run build        # tauri build — produces installers under src-tauri/target/release/bundle/
```

> **Known limitation:** the release bundle currently embeds the renderer but not
> the Node backend (`service-worker.js` + `node_modules/` with `holesail` and its
> native addons), so `npm run build` artifacts run **dev-only today** — the GUI
> needs `npm install` + `npm run dev` to work. Packaging the backend into
> `bundle.resources` (and fixing `find_worker`'s resource-dir lookup) is the
> remaining step for self-contained releases. `find_worker` in
> `src-tauri/src/main.rs` looks in: resource dir → binary dir → ancestor dirs → cwd.

## Using the app

**Share a port** — pick a local port (e.g. 3000), optionally a custom 32+ char key,
toggle private/public. A session card appears with the `hs://s000…` connection
string — hit **Copy** and send it to whoever needs access.

**Connect** — paste a connection string (`hs://s000…` private or `hs://0000…`
public; secure mode is auto-detected from the prefix). The tunnel is exposed on
your localhost port.

Sessions can be paused/resumed/stopped; the event log at the bottom shows what
the worker is doing.

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
