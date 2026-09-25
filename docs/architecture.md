# Architecture and invariants

[Layers](#layers) · [Invariants](#invariants) · [The wire](#the-wire) · [Worker lifecycle](#worker-lifecycle)

The narrative and the diagram are in the README ([Architecture](https://github.com/chethan62/holesail-gui#architecture)).
This page is the part that must not drift: the layer map, and the invariants
that are load-bearing, each with the thing that enforces it. Every claim below
was read out of the code, not the other way round.

## Layers

| Layer                 | Lives in            | Knows about                                                                          |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| **Webview** (UI)      | `renderer/`         | the DOM, and talking to the host through Tauri commands/events. Nothing else.        |
| **Host** (Rust)       | `src-tauri/src/`    | process lifecycle, filesystem, updater, window/tray; proxies RPC. Never tunnels.     |
| **Worker** (protocol) | `worker/*.js`       | tunnel state, bandwidth limits, the file server, stats — plain JS, no DOM.           |
| **Engine**            | `worker/engine/`    | the holesail protocol itself, over `hyperdht`, `z32`, `@holesail/hyper-cmd-lib-net`. |
| **Runtime**           | `worker/runtime.js` | Node vs Bare — and nothing else does.                                                |

Dependency direction is acyclic and leaves-first: `runtime.js` is a leaf, the
engine depends on it, the worker on the engine, the host on the worker's stdio,
the renderer on the host. That is why a fix lands in one place and debuggers
work by reading downward.

## Invariants

"Asserted by" is the point of the table: an invariant with no enforcement is a
comment, and a comment is what someone deletes at 3am.

| Invariant                                                                                                    | Where                                               | Asserted by                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| One engine, and the payload carries **no copyleft**                                                          | `worker/engine/hs.js` over MIT/Apache-2.0 deps      | `scripts/licence-check.py` in CI (has `--self-test` and a negative control)                                         |
| `worker/runtime.js` is the **only** module that knows which runtime is running (Node or Bare) — it is a leaf | `worker/runtime.js`                                 | `npm run test:bare` in CI: a Node-only global passes lint and `npm test`, then dies under Bare                      |
| The engine's `dht` object is an **engine-owned carrier**, never the raw HyperDHT node                        | `worker/engine/hs.js` (`carrier()`, lines ~122/156) | by construction — `stats.js` reads `dht.{server,proxy,proxySocket,stats}` and clobbering it breaks query accounting |
| The wire is **newline-delimited JSON** on the worker's stdio                                                 | `worker/transport.js` ↔ `src-tauri/src/rpc.rs`      | every section of `test/service.test.js` drives it                                                                   |
| The method list exists **twice by hand** (`dispatch.js` cases ↔ `rpc.rs` `ALLOWED`) and must agree           | `worker/dispatch.js` ↔ `src-tauri/src/rpc.rs`       | `test/service.test.js` §23 — a static check, because drift is silent in both directions                             |
| The file server's failed-password throttle **exempts loopback** (the tunnel dials it over `127.0.0.1`)       | `worker/fileserver.js:114-119`                      | `test/fileserver.test.js`                                                                                           |
| An async error **exits the worker**, and the host respawns it with a backoff ladder                          | `src-tauri/src/worker.rs`                           | `backoff_ladder_progression`, `next_attempt_advances_on_unhealthy_exit`, `next_attempt_resets_after_healthy_uptime` |

## The wire

<details>
<summary><strong>Requests, replies, events</strong></summary>

One JSON object per line, in both directions, over the worker's stdio:

- request `{ "id": <n>, "method": "<name>", "params": { … } }`
- reply `{ "id": <n>, "result": … }` or `{ "id": <n>, "error": { … } }`
- event `{ "event": "<name>", "data": { … } }`

Methods are allowlisted in Rust (`rpc.rs` `ALLOWED`) and dispatched in JS
(`worker/dispatch.js`) — two hand-maintained lists, hence §23. A method missing
from `ALLOWED` is unreachable from the UI ("Method not allowed"); one missing
from `dispatch.js` dies as an unknown method after the full round trip.

</details>

## Worker lifecycle

<details>
<summary><strong>Timeouts, backoff, generations</strong></summary>

From `src-tauri/src/worker.rs`:

| Constant / mechanism | Value                            | What it is for                                                                  |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `RPC_TIMEOUT`        | 30 s                             | a hung worker surfaces fast instead of hanging the UI                           |
| `EXIT_GRACE`         | 3 s                              | SIGTERM → SIGKILL escalation on app quit                                        |
| `HEALTHY_UPTIME`     | 60 s                             | a worker that lived this long resets the ladder, so a later crash restarts fast |
| `BACKOFF`            | 1, 2, 5, 10, 30 s (last repeats) | respawn ladder; `next_attempt()` is pure and unit-tested                        |
| `RESPAWN_GEN`        | counter                          | a manual restart bumps it so a pending auto-respawn cannot double-spawn         |
| `WORKER_READY`       | flag set by `worker:ready`       | RPCs issued before ready fail fast rather than riding the full timeout          |

</details>
