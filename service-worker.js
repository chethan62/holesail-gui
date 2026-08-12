#!/usr/bin/env node
/*
 * service-worker.js
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
 * Methods:
 *   ping                          -> "pong"
 *   server:start  {port, host?, secure?, key?, udp?}
 *   client:connect {key, port?, host?, udp?, secure?}
 *   filemanager:start {path, host?, port?, secure?, key?, role?, username?, password?}
 *   session:stop  {id}
 *   session:pause {id}
 *   session:resume {id}
 *   sessions:list                 -> [session, ...]
 *   lookup        {key}
 */

'use strict'

const Holesail = require('holesail')
const Livefiles = require('livefiles')

// Runtime shim: the bare runtime (Android backend) does not expose Node
// globals — its builtins live under bare-* names. Node has them as
// globals. Resolve whichever runtime we are running under.
const process = (() => {
  try {
    return require('bare-process')
  } catch {
    return globalThis.process
  }
})()
const Buffer = (() => {
  try {
    return require('buffer').Buffer
  } catch {
    return globalThis.Buffer
  }
})()
const setImmediate = globalThis.setImmediate || ((fn, ...args) => setTimeout(fn, 0, ...args))
const net = (() => {
  try {
    return require('bare-net')
  } catch {
    return require('net')
  }
})()

/// Ask the OS for a free local port (bind :0, read the assignment, close).
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

const sessions = new Map() // id -> { hs, type, url, port, host, secure, protocol, key, publicKey, state }
let nextId = 1

/* ------------------------------ transport ------------------------------ */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function sendResult(id, result) {
  send({ id, result })
}

function sendError(id, error) {
  send({ id, error: String((error && error.message) || error) })
}

function sendEvent(name, data) {
  send({ event: name, data })
}

/* ------------------------------ sessions ------------------------------- */

function recordFromHs(hs, id) {
  const info = hs.info
  return {
    id,
    type: info.type, // 'server' | 'client'
    protocol: info.protocol,
    secure: info.secure,
    port: info.port,
    host: info.host,
    url: info.url,
    key: info.key,
    publicKey: info.publicKey,
    state: 'running'
  }
}

function emitSession(session) {
  sendEvent('session:update', session)
}

async function startServer(params) {
  const port = Number(params.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${params.port}`)
  }
  if (params.key !== undefined && params.key !== null && String(params.key).length < 32) {
    throw new Error('A key should have a minimum length of 32 chars for security purposes')
  }
  const hs = new Holesail({
    server: true,
    port,
    host: params.host || '127.0.0.1',
    secure: params.secure !== false, // private by default
    key: params.key || undefined,
    udp: params.udp || false
  })
  await hs.ready()
  const id = String(nextId++)
  const session = recordFromHs(hs, id)
  sessions.set(id, { hs, ...session })
  emitSession(session)
  return session
}

async function startFilemanager(params) {
  const dir = params.path
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new Error('Directory path is required')
  }
  // Mirrors the CLI (`holesail --filemanager <dir>`): a Livefiles HTTP
  // file server + a holesail tunnel in front, both on the same local
  // port. Pure JS deps (bare-fs/bare-http1) so it runs under the bare
  // runtime too.
  const port = Number(params.port) || 5409
  const host = params.host || '127.0.0.1'
  const fileServer = new Livefiles({
    path: dir,
    role: params.role,
    username: params.username,
    password: params.password,
    host,
    port
  })
  await fileServer.ready()
  const fsInfo = fileServer.info
  const hs = new Holesail({
    server: true,
    port: Number(fsInfo.port) || port,
    host: fsInfo.host || host,
    secure: params.secure !== false, // private by default
    key: params.key || undefined,
    udp: false // filemanager can't use UDP (CLI validateInput)
  })
  await hs.ready()
  const id = String(nextId++)
  const session = {
    ...recordFromHs(hs, id),
    type: 'filemanager',
    dir,
    fsRole: fsInfo.role || null,
    fsUsername: fsInfo.username || null,
    fsPassword: fsInfo.password || null
  }
  sessions.set(id, { hs, fileServer, ...session })
  emitSession(session)
  return session
}

async function connectClient(params) {
  // URL parsers normalize hs://s000… to hs://s000…/ — the trailing slash
  // becomes part of the key and derives a WRONG seed (a phantom tunnel
  // that never establishes, with no error). Strip it.
  let key = String(params.key || '').replace(/\/+$/, '')
  if (key.length === 0) {
    throw new Error('Connection string is required')
  }
  let port
  if (params.port !== undefined && params.port !== null && params.port !== '') {
    port = Number(params.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${params.port}`)
    }
  } else {
    // holesail's client mirrors the SERVER's port when none is given —
    // if something local already occupies that port, the bind fails as an
    // ASYNC 'error' event (uncaughtException) that would crash the whole
    // worker. Always bind an OS-assigned free port instead.
    port = await pickFreePort()
  }
  const hs = new Holesail({
    client: true,
    key,
    port,
    host: params.host || undefined,
    udp: params.udp || false,
    secure: params.secure // undefined -> auto-detect from hs:// prefix
  })
  await hs.ready()
  const id = String(nextId++)
  const session = recordFromHs(hs, id)
  sessions.set(id, { hs, ...session })
  emitSession(session)
  return session
}

async function stopSession(id) {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`No session with id ${id}`)
  await entry.hs.close()
  // filemanager sessions own a Livefiles server next to the tunnel
  if (entry.fileServer) {
    try {
      await entry.fileServer.close()
    } catch {}
  }
  sessions.delete(id)
  sendEvent('session:update', { id, state: 'stopped' })
  return { id, state: 'stopped' }
}

async function pauseSession(id) {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`No session with id ${id}`)
  await entry.hs.pause()
  entry.state = 'paused'
  emitSession({ id, state: 'paused' })
  return { id, state: 'paused' }
}

async function resumeSession(id) {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`No session with id ${id}`)
  await entry.hs.resume()
  entry.state = 'running'
  emitSession({ id, state: 'running' })
  return { id, state: 'running' }
}

function listSessions() {
  return [...sessions.values()].map(({ hs, ...s }) => s)
}

/* -------------------------------- rpc ---------------------------------- */

async function dispatch(method, params) {
  switch (method) {
    case 'ping':
      return 'pong'
    case 'server:start':
      return startServer(params || {})
    case 'client:connect':
      return connectClient(params || {})
    case 'filemanager:start':
      return startFilemanager(params || {})
    case 'session:stop':
      return stopSession(params.id)
    case 'session:pause':
      return pauseSession(params.id)
    case 'session:resume':
      return resumeSession(params.id)
    case 'sessions:list':
      return listSessions()
    case 'lookup':
      return Holesail.lookup(params.key)
    // test-only: throw an async error OUTSIDE the RPC promise chain
    // (uncaughtException, like a real socket/bind failure) attributed to a
    // session via its port — the error-containment regression test relies
    // on this. The caller gets a response immediately; the throw happens
    // on the next tick so the containment path actually triggers.
    case 'test:throw':
      setImmediate(() => {
        throw Object.assign(new Error(`simulated bind failure on 127.0.0.1:${params.port}`), { port: params.port })
      })
      return { thrown: true }
    default:
      throw new Error(`Unknown method: ${method}`)
  }
}

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

/// Attribute an async error to a running session when possible (the holesail
/// instances expose no error events — internal socket/bind failures surface
/// as uncaught exceptions with the port in the message). When a session can
/// be blamed, stop ONLY that session instead of taking down every tunnel.
function sessionForError(err) {
  const msg = String((err && err.message) || err)
  const errPort = err && err.port
  for (const id of sessions.keys()) {
    const entry = sessions.get(id)
    if (!entry) continue
    if (errPort !== undefined && errPort !== null && entry.port === errPort) return entry
    if (entry.port && msg.includes(`:${entry.port}`)) return entry
  }
  return null
}

function onAsyncError(kind, err) {
  const session = sessionForError(err)
  if (session) {
    // one broken tunnel must not kill the rest — drop just this session.
    // Remove it from the map and emit BOTH events synchronously so the
    // UI always clears the card, then best-effort close the instance
    // (close() may itself hang on the broken resource).
    sessions.delete(session.id)
    sendEvent('session:update', {
      id: session.id,
      state: 'error',
      error: String((err && err.message) || err)
    })
    sendEvent('session:update', { id: session.id, state: 'stopped' })
    session.hs.close().catch(() => {})
    return
  }
  // unattributable error: the process may be in a broken state; report and
  // exit so the parent can respawn (permanent tunnels are restored by the
  // renderer on worker:spawned, temporary ones are lost by design)
  sendEvent('worker:error', { message: `${kind}: ${String((err && err.message) || err)}` })
  setImmediate(() => process.exit(1))
}

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
