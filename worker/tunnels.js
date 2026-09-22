/* tunnels.js — server/client/filemanager session start/stop/pause/resume.
 * Depends on runtime.js + state.js + transport.js + guards.js + stats.js
 * + limiter.js. This is the only module that constructs Engine/FileServer
 * instances.
 */

const { fs, path, crypto } = require('./runtime.js')
const { sessions, nextSessionId } = require('./state.js')
const { sendEvent } = require('./transport.js')
const {
  assertCapacity,
  pickFreePort,
  isBroadSharePath
} = require('./guards.js')
const {
  wireSessionStats,
  armStatsEmit,
  clearStatsEmit,
  emitSession
} = require('./stats.js')
const {
  normalizeLimit,
  startLimitTicker,
  stopLimitTicker
} = require('./limiter.js')

const { Engine } = require('./engine/index.js')
const FileServer = require('./fileserver.js')

// A fresh Basic-Auth password for each folder share. The file server's own
// default is the well-known admin/admin, and the UI shows whatever pair is in
// use — so leaving the default would advertise protection that isn't there. On
// a PUBLIC share (hs://0000..., where the key is public by design) that left
// the folder effectively unauthenticated. 96 bits of CSPRNG output as base64
// with the URL-unsafe characters dropped (base64url isn't guaranteed under the
// bare runtime). Callers that pass an explicit password still win.
const randomPassword = () =>
  crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 16)

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
  if (
    params.key !== undefined &&
    params.key !== null &&
    String(params.key).length < 32
  ) {
    throw new Error(
      'A key should have a minimum length of 32 chars for security purposes'
    )
  }
  const limit = normalizeLimit(params.limit)
  const hs = new Engine({
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
  // a late url update (a permanent tunnel's regenerated key) must name its
  // session in the event
  hs.sessionId = id
  wireSessionStats(entry)
  // always: a session with no cap of its own still needs a ticker to
  // drain under the global one (the ticker self-terminates otherwise)
  startLimitTicker(entry)
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
  // failed deep inside the file server (or surfaced as a generic worker error)
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
  // Mirrors the CLI (`holesail --filemanager <dir>`): an HTTP file server +
  // a holesail tunnel in front, both on the same local port. Pure JS deps
  // (bare-fs/bare-http1) so it runs under the bare runtime too.
  //
  // The server is `fileserver.js` — this repo's own, MIT, read-only. It replaced
  // livefiles (GPLv3, which every release artifact then redistributed while this
  // repo said MIT): the app only ever used livefiles' read side, so nothing was
  // lost by not reimplementing upload/create/delete.
  //
  // One deliberate divergence from the CLI: livefiles' default credentials are
  // admin/admin, and the UI displays whatever pair is in use (with a reveal
  // toggle) — so leaving the default would tell the user a secret is protecting
  // the folder when the password is well known. On a PUBLIC share
  // (hs://0000..., where the key is public by design) that left the folder
  // effectively unauthenticated. Generate one per share instead; an explicit
  // username/password from the caller still wins.
  //
  // A folder share's local port is an implementation detail — the receiver
  // reaches it through the tunnel — and livefiles exited the PROCESS when its
  // listen failed, so a second folder share (or anything else on 5409) took the
  // whole worker down with it (that is what made the filemanager test time out
  // while the app was sharing). fileserver.js surfaces that failure to the
  // caller instead, but the port is still asked of the OS rather than fixed:
  // no reason to collide with anything. An explicit port from the caller is
  // honoured, probe-free.
  const port =
    Number(params.port) > 0 ? Number(params.port) : await pickFreePort()
  const host = params.host || '0.0.0.0'
  // Bind every interface, not just loopback. The session card offers a
  // "Copy LAN URL" row for folder shares, and the CLI's own filemanager is
  // LAN-reachable, so a phone on the same network can skip the DHT entirely.
  // With the default on loopback that row was a dead address: measured, the
  // app logged `127.0.0.1:<port>`, `ss` showed loopback only, and a request to
  // the LAN address was refused. The barrier is the per-share random password
  // behind a 401 challenge, not the bind address — fileserver.js is read-only.
  //
  // The tunnel, however, dials the loopback side of that wildcard: connecting
  // *to* 0.0.0.0 is not routable on every platform.
  const dialHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const limit = normalizeLimit(params.limit)
  const fileServer = new FileServer({
    path: resolved,
    username: params.username,
    password: params.password || randomPassword(),
    host,
    port
  })
  await fileServer.ready()
  const fsInfo = fileServer.info
  const hs = new Engine({
    server: true,
    port: Number(fsInfo.port) || port,
    host: dialHost,
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
    // Where the file server is really bound. The record's own `host` is the
    // loopback side the tunnel dials, which is not where a peer reaches it, so
    // a log line built from that would understate the share's exposure.
    fsBindHost: host,
    fsRole: fsInfo.role || null,
    fsUsername: fsInfo.username || null,
    fsPassword: fsInfo.password || null
  }
  const entry = { hs, fileServer, ...session, limit }
  sessions.set(id, entry)
  hs.sessionId = id
  wireSessionStats(entry)
  // always: a session with no cap of its own still needs a ticker to
  // drain under the global one (the ticker self-terminates otherwise)
  startLimitTicker(entry)
  armStatsEmit(entry)
  emitSession(session)
  return { ...session, limit }
}

async function connectClient(params) {
  assertCapacity()
  // URL parsers normalize hs://s000… to hs://s000…/ — the trailing slash
  // becomes part of the key and derives a WRONG seed (a phantom tunnel
  // that never establishes, with no error). Strip it.
  //
  // An invite link may also carry folder-share credentials in its fragment
  // (the link a QR code or the clipboard delivers, see renderer/invite.js).
  // A fragment is not part of the key either, and leaving it on derives the
  // same kind of phantom — so strip it here as well, defensively. The renderer
  // splits it before calling, so this is the second line of defence, not the
  // only one.
  const key = String(params.key || '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
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
  const hs = new Engine({
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
  // a late url update (a permanent tunnel's regenerated key) must name its
  // session in the event
  hs.sessionId = id
  wireSessionStats(entry)
  // always: a session with no cap of its own still needs a ticker to
  // drain under the global one (the ticker self-terminates otherwise)
  startLimitTicker(entry)
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
  // filemanager sessions own a file server next to the tunnel
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
  // Strip BOTH engine instances (holesail + the FileServer):
  // they're non-serializable object graphs that would otherwise ride along
  // in every sessions:list RPC response (payload bomb + junk in renderer
  // state). Sessions map back to their instances via sessions.get(id).
  // `_lim` (limiter.js) is worker-private state holding a live Timeout — it
  // serializes fine once its ticker has gone quiet and throws "Converting
  // circular structure to JSON" until then, i.e. listing a session within
  // ~200ms of starting it. (Latent with holesail, whose DHT bootstrap took
  // long enough to hide it; hit immediately by the engine, which is
  // ready in ~15ms.)
  return [...sessions.values()].map(({ hs, fileServer, _lim, ...s }) => s)
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
