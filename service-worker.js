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
 *   session:stop  {id}
 *   session:pause {id}
 *   session:resume {id}
 *   sessions:list                 -> [session, ...]
 *   lookup        {key}
 */

'use strict'

const Holesail = require('holesail')

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

async function connectClient(params) {
  if (!params.key || String(params.key).length === 0) {
    throw new Error('Connection string is required')
  }
  let port
  if (params.port !== undefined && params.port !== null && params.port !== '') {
    port = Number(params.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${params.port}`)
    }
  }
  const hs = new Holesail({
    client: true,
    key: String(params.key),
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
  for (const [id] of sessions) {
    try {
      await stopSession(id)
    } catch {}
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('uncaughtException', (err) => {
  // The process may be in a broken state; report and exit so the parent can
  // surface the failure instead of hanging on a limping worker.
  sendEvent('worker:error', { message: String((err && err.message) || err) })
  setImmediate(() => process.exit(1))
})
