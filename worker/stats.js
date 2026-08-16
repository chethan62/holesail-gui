/* stats.js — per-session byte counters + the throttled traffic emit.
 * Depends on runtime.js + state.js + transport.js + limiter.js.
 *
 * Traffic counters live on the SAME `stats` object the holesail engine
 * threads into connPiper/createTcpProxy/pipeUdpFramedServer (it mutates
 * locCnt/remCnt/rejectCnt there — we add byte counters it never touches).
 * This survives upstream engine changes that swap internal plumbing,
 * because the engine always hands the piper the object we give it.
 *   stats.bytesUp   — bytes from the local service TO the tunnel (upload)
 *   stats.bytesDown — bytes from the tunnel TO the local service (download)
 *   stats.locCnt    — live TCP connections (engine-maintained)
 *   stats.rejectCnt — rejected connections (engine-maintained)
 *
 * The same wrappers enforce the optional per-session bandwidth cap with a
 * shared token bucket (see limiter.js).
 */

const { Buffer } = require('./runtime.js')
const { sessions, statsTimers } = require('./state.js')
const { sendEvent } = require('./transport.js')
const { limiterFor } = require('./limiter.js')

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

function emitSession(session) {
  sendEvent('session:update', session)
}

module.exports = { wireSessionStats, armStatsEmit, clearStatsEmit, emitSession }
