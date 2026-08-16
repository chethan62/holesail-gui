#!/usr/bin/env node
/*
 * service-worker.js — entry point for the holesail worker.
 *
 * Plain-Node bridge between the holesail npm API and a parent process
 * (the Tauri Rust backend). Runs under the SYSTEM node binary on desktop
 * (native addons load with the ABI they were built for) and under the
 * bare runtime on Android (the .bare prebuilds are picked automatically).
 *
 * Protocol: newline-delimited JSON on stdin/stdout.
 *   Request : { "id": 1, "method": "server:start", "params": { ... } }
 *   Response: { "id": 1, "result": { ... } }  |  { "id": 1, "error": "..." }
 *   Event   : { "event": "session:update", "data": { ... } }
 *
 * Methods (dispatch in worker/dispatch.js, keep in sync with the Rust
 * `rpc` allowlist):
 *   ping                          -> "pong"
 *   server:start  {port, host?, secure?, key?, udp?, limit?}
 *   client:connect {key, port?, host?, udp?, secure?, limit?}
 *   filemanager:start {path, host?, port?, secure?, key?, role?, username?, password?, limit?}
 *   session:stop  {id}
 *   session:pause {id}
 *   session:resume {id}
 *   sessions:list                 -> [session, ...]
 *   lookup        {key}
 *
 * Module map (acyclic, leaves first — all under worker/):
 *   runtime.js   — resolve Node vs Bare globals (process/Buffer/net/fs/path)
 *   state.js     — sessions Map + id counter + stats timers
 *   transport.js — newline-JSON writer
 *   guards.js    — session cap, broad-path guardrail, free-port
 *   limiter.js   — per-session token-bucket bandwidth cap
 *   stats.js     — byte counters + throttled traffic emit
 *   tunnels.js   — server/client/filemanager start/stop/pause/resume
 *   errors.js    — attribute async errors to a session, drop only it
 *   dispatch.js  — the method router
 */

'use strict'

const { process, Buffer, setImmediate } = require('./worker/runtime.js')
const { sessions } = require('./worker/state.js')
const { sendResult, sendError, sendEvent } = require('./worker/transport.js')
const { stopSession } = require('./worker/tunnels.js')
const { dispatch } = require('./worker/dispatch.js')
const { onAsyncError } = require('./worker/errors.js')

/* ------------------------------ transport ------------------------------ */

// Newline-split stdin without `readline` (not a builtin on the bare
// runtime used for the Android backend). Handles \n, \r\n and a final
// unterminated line, mirroring readline's 'line' semantics.
let pending = ''

function handleLine(line) {
  if (line.endsWith('\r')) line = line.slice(0, -1)
  if (line === '') return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    sendError(null, 'Invalid JSON on stdin')
    return
  }
  Promise.resolve()
    .then(() => dispatch(req.method, req.params))
    .then((result) => sendResult(req.id, result))
    .catch((err) => sendError(req.id, err))
}

process.stdin.on('data', (chunk) => {
  pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  let idx
  while ((idx = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, idx)
    pending = pending.slice(idx + 1)
    handleLine(line)
  }
})

process.stdin.on('end', () => {
  if (pending !== '') handleLine(pending)
})

/* ------------------------------ shutdown ------------------------------- */

async function shutdown() {
  for (const id of [...sessions.keys()]) {
    try {
      await stopSession(id)
    } catch {}
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('uncaughtException', (err) => onAsyncError('uncaughtException', err))
process.on('unhandledRejection', (err) => onAsyncError('unhandledRejection', err))

/* ------------------------------ readiness ------------------------------ */

// Handshake: emit once the worker is fully initialized (holesail loaded,
// stdin wired, handlers registered). The parent gates RPC traffic on this
// event, so a spawned-but-still-initializing worker never swallows early
// requests (which previously could ride the full 90s RPC timeout).
setImmediate(() => {
  sendEvent('worker:ready', { pid: process.pid, startedAt: Date.now() })
})
