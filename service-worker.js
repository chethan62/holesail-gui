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
 *   server:start  {port, host?, secure?, key?, udp?, limit?}
 *   client:connect {key, port?, host?, udp?, secure?, limit?}
 *   filemanager:start {path, host?, port?, secure?, key?, role?, username?, password?, limit?}
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
const fs = (() => {
  try {
    return require('bare-fs')
  } catch {
    return require('fs')
  }
})()
const path = (() => {
  try {
    return require('bare-path')
  } catch {
    return require('path')
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

const sessions = new Map() // id -> { hs, type, url, port, host, secure, protocol, key, publicKey, state, stats }
let nextId = 1

// Traffic counters live on the SAME `stats` object the holesail engine
// threads into connPiper/createTcpProxy/pipeUdpFramedServer (it mutates
// locCnt/remCnt/rejectCnt there — we add byte counters it never touches).
// This survives upstream engine changes that swap internal plumbing,
// because the engine always hands the piper the object we give it.
//   stats.bytesUp   — bytes from the local service TO the tunnel (upload)
//   stats.bytesDown — bytes from the tunnel TO the local service (download)
//   stats.locCnt    — live TCP connections (engine-maintained)
//   stats.rejectCnt — rejected connections (engine-maintained)
const STATS_EMIT_MS = 500 // throttle: ~2 stats events/sec/session at most

// Wire per-session byte counters at the data boundaries we can actually
// reach post-ready:
//   SERVER — the hyperdht Server emits 'connection' per incoming tunnel
//            stream: bytes read from it = download (remote -> local),
//            bytes written to it = upload (local -> remote). This covers
//            both TCP and UDP (UDP rides framed streams on the same DHT
//            connection).
//   CLIENT — the local TCP proxy (net.Server) emits 'connection' per local
//            app socket: bytes read from it = upload, bytes written to it
//            = download.
//   UDP client — the dgram proxySocket: 'message' from local = upload,
//            send() to local = download.
// The engine's connPiper never counts bytes (only locCnt/remCnt/rejectCnt),
// so we count at these choke points instead — no engine internals needed,
// and it survives upstream plumbing changes.
//
// The same wrappers enforce the optional per-session bandwidth cap
// (entry.limit, bytes/sec, 0 = unlimited) with a shared token bucket:
//   read direction — when tokens run out, pause the source stream (server:
//   the DHT stream; client: the local socket); the ticker resumes it.
//   write direction — when tokens run out, queue the chunk and drain it
//   (with partial writes) as tokens refill.
// A single bucket caps COMBINED throughput (the use case behind the
// feature: "a busy tunnel can saturate my link").

function limiterFor(entry) {
  if (!entry._lim) entry._lim = { tokens: 0, last: 0, queue: [], paused: [], timer: null }
  return entry._lim
}

function startLimitTicker(entry) {
  const lim = limiterFor(entry)
  if (lim.timer) return
  lim.last = Date.now()
  const tick = () => {
    if (!entry.limit || !sessions.has(entry.id)) {
      lim.timer = null
      return
    }
    const now = Date.now()
    // bucket caps at 1s worth of budget; partial-write draining below
    // guarantees no chunk ever deadlocks the queue
    lim.tokens = Math.min(entry.limit, lim.tokens + (entry.limit * (now - lim.last)) / 1000)
    lim.last = now
    // drain queued writes (partial writes for chunks larger than budget)
    while (lim.queue.length && lim.tokens > 0) {
      const q = lim.queue[0]
      if (q.len <= lim.tokens) {
        lim.queue.shift()
        lim.tokens -= q.len
        try { q.fn(q.buf, ...q.rest) } catch {}
      } else {
        const take = Math.floor(lim.tokens)
        lim.tokens = 0
        const head = Buffer.isBuffer(q.buf) ? q.buf.subarray(0, take) : String(q.buf).slice(0, take)
        q.buf = Buffer.isBuffer(q.buf) ? q.buf.subarray(take) : String(q.buf).slice(take)
        q.len -= take
        try { q.fn(head, ...q.rest) } catch {}
      }
    }
    // resume paused source streams now that budget is available
    if (lim.paused.length && lim.tokens > 0) {
      for (const s of lim.paused) {
        try { s.resume() } catch {}
      }
      lim.paused = []
    }
    lim.timer = setTimeout(tick, 200)
  }
  lim.timer = setTimeout(tick, 200)
}

function stopLimitTicker(entry) {
  const lim = entry._lim
  if (!lim) return
  if (lim.timer) {
    clearTimeout(lim.timer)
    lim.timer = null
  }
  // unlimited: flush anything queued and un-pause everything immediately
  while (lim.queue.length) {
    const q = lim.queue.shift()
    try { q.fn(q.buf, ...q.rest) } catch {}
  }
  for (const s of lim.paused) {
    try { s.resume() } catch {}
  }
  lim.paused = []
}

function wireDataCounters(entry) {
  const dht = entry.hs && entry.hs.dht
  if (!dht) return
  const stats = entry.stats
  const bump = (dir, n) => {
    if (n > 0) stats[dir] = (stats[dir] || 0) + n
  }
  // consume() returns true when the byte count fits the budget (or there
  // is no cap); false → caller must throttle (pause/queue)
  const consume = (n) => {
    if (!entry.limit) return true
    const lim = limiterFor(entry)
    if (lim.tokens >= n) {
      lim.tokens -= n
      return true
    }
    return false
  }
  const pauseForLimit = (stream) => {
    const lim = limiterFor(entry)
    if (!lim.paused.includes(stream)) lim.paused.push(stream)
    try { stream.pause() } catch {}
  }
  const wrapStream = (stream, upDir, downDir) => {
    if (!stream || stream.__hgCounted) return
    stream.__hgCounted = true
    stream.on('data', (d) => {
      const n = d ? d.length : 0
      bump(downDir, n)
      if (entry.limit && n && !consume(n)) pauseForLimit(stream)
    })
    if (typeof stream.write === 'function') {
      const ow = stream.write.bind(stream)
      stream.write = (buf, ...rest) => {
        const n = typeof buf === 'string' ? Buffer.byteLength(buf) : buf ? buf.length : 0
        bump(upDir, n)
        if (entry.limit && n) {
          if (consume(n)) return ow(buf, ...rest)
          limiterFor(entry).queue.push({ len: n, buf, rest, fn: ow })
          return false
        }
        return ow(buf, ...rest)
      }
    }
    stream.on('close', () => {
      const lim = entry._lim
      if (lim) lim.paused = lim.paused.filter((s) => s !== stream)
    })
  }

  // SERVER: every incoming tunnel connection — count bytes AND tell the
  // UI a peer arrived (session:peer). The renderer logs/toasts it, so the
  // tunnel owner knows when someone actually connects to their share.
  if (dht.server && typeof dht.server.on === 'function') {
    dht.server.on('connection', (c) => {
      wrapStream(c, 'bytesUp', 'bytesDown')
      // routing info: relay != null means the DHT fell back to relaying
      // (no direct hole-punch) — surface it so the UI can warn about
      // latency. rawStream.remoteHost is the peer's real IP.
      let viaRelay = false
      let peerAddr = ''
      try {
        const rs = c.rawStream
        if (rs && rs.remoteHost) peerAddr = String(rs.remoteHost)
        viaRelay = !!c.relay
      } catch {}
      sendEvent('session:peer', { id: entry.id, at: Date.now(), viaRelay, peerAddr })
    })
  }
  // CLIENT TCP: every local app connection through the proxy
  if (dht.proxy && typeof dht.proxy.on === 'function') {
    dht.proxy.on('connection', (sock) => wrapStream(sock, 'bytesUp', 'bytesDown'))
  }
  // CLIENT UDP: the dgram socket (counted but NOT capped — datagram
  // pacing is out of scope for the per-session cap)
  if (dht.proxySocket && typeof dht.proxySocket.on === 'function') {
    const ps = dht.proxySocket
    ps.on('message', (m) => bump('bytesUp', m ? m.length : 0))
    if (typeof ps.send === 'function') {
      const osend = ps.send.bind(ps)
      ps.send = (buf, ...rest) => {
        bump('bytesDown', typeof buf === 'string' ? Buffer.byteLength(buf) : buf ? buf.length : 0)
        return osend(buf, ...rest)
      }
    }
  }
}

// Hard ceiling on concurrent tunnels. A single-user local GUI should never
// need hundreds; this guards against fd/port exhaustion from a runaway
// script or a UI bug that re-shares the same port in a loop.
const MAX_SESSIONS = 50

function assertCapacity() {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Too many sessions (limit ${MAX_SESSIONS}) — stop some before starting more`)
  }
}

/// True when `p` is the filesystem root, a home directory, or a home
/// dir's immediate child — refusing to share these over the DHT is the
/// worker-side half of the renderer's broad-path guardrail. Mirrors the
/// renderer's isBroadSharePath (cross-platform, never throws).
function isBroadSharePath(p) {
  const raw = String(p || '').trim()
  if (!raw) return false
  // filesystem root: "/", "\", "C:\", "C:/" — check BEFORE trimming
  // trailing slashes (a bare root trims to '' and slips past otherwise)
  if (raw === '/' || raw === '\\' || /^[a-zA-Z]:[\\/]?$/.test(raw)) return true
  const s = raw.replace(/[\\/]+$/, '')
  if (!s) return false
  // home dir itself + its immediate children (~/Documents, ~/.ssh, ...)
  const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/[\\/]+$/, '')
  if (home) {
    if (s === home || s.toLowerCase() === home.toLowerCase()) return true
    const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
    if (idx > 0) {
      const parent = s.slice(0, idx)
      if (parent === home || parent.toLowerCase() === home.toLowerCase()) return true
    }
  }
  return false
}

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
    state: 'running',
    stats: { bytesUp: 0, bytesDown: 0 }
  }
}

function emitSession(session) {
  sendEvent('session:update', session)
}

// Session start hooks into the engine's stats object (TCP) + socket wraps
// (UDP). Called right after the session is registered so counters live on
// the object the engine mutates from the first byte.
function wireSessionStats(entry) {
  if (!entry || !entry.hs) return
  const hs = entry.hs
  // The engine assigns `this.stats = {}` inside HolesailServer/HolesailClient
  // constructors, and by the time we wire (post-ready) `hs.dht` IS the
  // server/client with its own stats object already threaded into the piper.
  // Attach our byte counters to that live object so counts accumulate from
  // the first byte — and remember it so the throttled emit reads the same
  // object the engine mutates.
  if (hs.dht && hs.dht.stats && typeof hs.dht.stats === 'object') {
    entry.stats = hs.dht.stats
    if (!('bytesUp' in entry.stats)) entry.stats.bytesUp = 0
    if (!('bytesDown' in entry.stats)) entry.stats.bytesDown = 0
  }
  wireDataCounters(entry)
}

// Per-session traffic readout, throttled. The renderer holds the full
// session record (including stats) and refreshes counters in place — the
// payload here is the SAME shape as sessions:list entries.
// Re-arms itself every STATS_EMIT_MS so counters keep flowing for the
// session's lifetime (a one-shot fire would freeze the UI after the first
// update); stopSession / onAsyncError clear the timer.
const statsTimers = new Map() // id -> timeout handle
function armStatsEmit(entry) {
  if (statsTimers.has(entry.id)) return
  const tick = () => {
    statsTimers.delete(entry.id)
    const current = sessions.get(entry.id)
    if (!current) return
    emitSession({
      id: current.id,
      stats: current.stats,
      locCnt: current.stats.locCnt || 0,
      rejectCnt: current.stats.rejectCnt || 0
    })
    armStatsEmit(current)
  }
  statsTimers.set(entry.id, setTimeout(tick, STATS_EMIT_MS))
}

function clearStatsEmit(id) {
  const t = statsTimers.get(id)
  if (t) {
    clearTimeout(t)
    statsTimers.delete(id)
  }
}

async function startServer(params) {
  assertCapacity()
  const port = Number(params.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${params.port}`)
  }
  if (params.key !== undefined && params.key !== null && String(params.key).length < 32) {
    throw new Error('A key should have a minimum length of 32 chars for security purposes')
  }
  const limit = normalizeLimit(params.limit)
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
  const entry = { hs, ...session, limit }
  sessions.set(id, entry)
  wireSessionStats(entry)
  if (limit) startLimitTicker(entry)
  armStatsEmit(entry)
  emitSession(session)
  return { ...session, limit }
}

function normalizeLimit(limit) {
  if (limit === undefined || limit === null || limit === '') return 0
  const n = Number(limit)
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

async function startFilemanager(params) {
  assertCapacity()
  const dir = params.path
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new Error('Directory path is required')
  }
  // Validate BEFORE creating the file server: a typo'd folder currently
  // failed deep inside Livefiles (or surfaced as a generic worker error)
  // while the card still showed "running". Resolve + stat up front.
  const resolved = path.resolve(dir)
  let st
  try {
    st = fs.statSync(resolved)
  } catch {
    throw new Error(`Folder not found: ${resolved}`)
  }
  if (!st.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`)
  }
  // Defense-in-depth: the renderer already confirms broad paths (/, home
  // dir, home dir children) before sharing; refuse them here too so a
  // scripted/compromised renderer can't silently expose the filesystem
  // root or a user's home over the DHT.
  if (isBroadSharePath(resolved)) {
    throw new Error(
      `Refusing to share a broad path (${resolved}) — share a specific folder instead`
    )
  }
  // Mirrors the CLI (`holesail --filemanager <dir>`): a Livefiles HTTP
  // file server + a holesail tunnel in front, both on the same local
  // port. Pure JS deps (bare-fs/bare-http1) so it runs under the bare
  // runtime too.
  const port = Number(params.port) || 5409
  const host = params.host || '127.0.0.1'
  const limit = normalizeLimit(params.limit)
  const fileServer = new Livefiles({
    path: resolved,
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
    dir: resolved,
    fsRole: fsInfo.role || null,
    fsUsername: fsInfo.username || null,
    fsPassword: fsInfo.password || null
  }
  const entry = { hs, fileServer, ...session, limit }
  sessions.set(id, entry)
  wireSessionStats(entry)
  if (limit) startLimitTicker(entry)
  armStatsEmit(entry)
  emitSession(session)
  return { ...session, limit }
}

async function connectClient(params) {
  assertCapacity()
  // URL parsers normalize hs://s000… to hs://s000…/ — the trailing slash
  // becomes part of the key and derives a WRONG seed (a phantom tunnel
  // that never establishes, with no error). Strip it.
  let key = String(params.key || '').replace(/\/+$/, '')
  if (key.length === 0) {
    throw new Error('Connection string is required')
  }
  const limit = normalizeLimit(params.limit)
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
  const entry = { hs, ...session, limit }
  sessions.set(id, entry)
  wireSessionStats(entry)
  if (limit) startLimitTicker(entry)
  armStatsEmit(entry)
  emitSession(session)
  return { ...session, limit }
}

async function stopSession(id) {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`No session with id ${id}`)
  // stop the throttled stats emitter + the bandwidth limiter so no stale
  // event lands after the card is gone (the renderer deletes on 'stopped')
  clearStatsEmit(id)
  stopLimitTicker(entry)
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

// Session-level traffic/connection readout, unpolled by the renderer (it
// subscribes to the throttled session:update events instead) — kept as an
// RPC for debugging and for clients that want a one-shot snapshot.
function getSessionStats(id) {
  const entry = sessions.get(id)
  if (!entry) throw new Error(`No session with id ${id}`)
  const stats = entry.stats || {}
  return {
    id,
    limit: entry.limit || 0,
    bytesUp: stats.bytesUp || 0,
    bytesDown: stats.bytesDown || 0,
    locCnt: stats.locCnt || 0,
    rejectCnt: stats.rejectCnt || 0
  }
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
    case 'session:stats':
      return getSessionStats(params.id)
    // Holesail.lookup returns the server's DHT record ({host, port,
    // protocol, secure}) when the key is announced. For a well-formed but
    // UNANNOUNCED key it returns `{ secure: true/false }` — a bare shell
    // (the `|| {}` fallback in Holesail.lookup masks the null from
    // HolesailClient.ping). Offline is a STATE, not an error: normalize
    // "record with no port" to null so the renderer can branch
    // online/offline/unknown cleanly. Malformed keys still throw
    // (Invalid key format), which surfaces as an RPC error -> 'unknown'.
    case 'lookup': {
      const res = await Holesail.lookup(params.key)
      return res && Number.isInteger(res.port) ? res : null
    }
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
    clearStatsEmit(session.id)
    stopLimitTicker(session)
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
