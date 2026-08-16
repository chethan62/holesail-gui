/* tunnels.js — server/client/filemanager session start/stop/pause/resume.
 * Depends on runtime.js + state.js + transport.js + guards.js + stats.js
 * + limiter.js. This is the only module that constructs Holesail/Livefiles
 * instances.
 */

const { fs, path } = require('./runtime.js')
const { sessions, nextSessionId } = require('./state.js')
const { sendEvent } = require('./transport.js')
const { assertCapacity, pickFreePort, isBroadSharePath } = require('./guards.js')
const { wireSessionStats, armStatsEmit, clearStatsEmit, emitSession } = require('./stats.js')
const { startLimitTicker, stopLimitTicker } = require('./limiter.js')

const Holesail = require('holesail')
const Livefiles = require('livefiles')

function normalizeLimit(limit) {
  if (limit === undefined || limit === null || limit === '') return 0
  const n = Number(limit)
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

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
  const id = nextSessionId()
  const session = recordFromHs(hs, id)
  const entry = { hs, ...session, limit }
  sessions.set(id, entry)
  wireSessionStats(entry)
  if (limit) startLimitTicker(entry)
  armStatsEmit(entry)
  emitSession(session)
  return { ...session, limit }
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
  const id = nextSessionId()
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
  const key = String(params.key || '').replace(/\/+$/, '')
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
  const id = nextSessionId()
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

module.exports = {
  startServer,
  startFilemanager,
  connectClient,
  stopSession,
  pauseSession,
  resumeSession,
  listSessions,
  getSessionStats
}
