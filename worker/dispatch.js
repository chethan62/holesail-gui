/* dispatch.js — the method router. Depends on runtime.js + tunnels.js.
 *
 * Keep the method names in sync with the Rust `rpc` command's ALLOWED list
 * (src-tauri/src/rpc.rs). `test:throw` is test-only and NOT in the Rust
 * allowlist — it must stay out of production reach. Suite §23 parses both
 * lists and asserts they agree in both directions, so this is checked rather
 * than trusted (the exception above is the only one it allows).
 */

const { setImmediate } = require('./runtime.js')
const {
  startServer,
  startFilemanager,
  connectClient,
  stopSession,
  pauseSession,
  resumeSession,
  listSessions,
  getSessionStats
} = require('./tunnels.js')

const { lookup } = require('./engine/hs.js')
const { setGlobalLimit } = require('./limiter.js')

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
    // all-tunnels bandwidth budget (0 = off). One shared bucket that every
    // session is charged against, on top of whatever cap that session has
    // of its own — the reason to set it: N permanent tunnels must not each
    // get a full allowance and add up to more than the link can carry.
    case 'limit:global':
      return { limit: setGlobalLimit(params.limit) }
    // Holesail.lookup returns the server's DHT record ({host, port,
    // protocol, secure}) when the key is announced. For a well-formed but
    // UNANNOUNCED key it returns `{ secure: true/false }` — a bare shell
    // (the `|| {}` fallback in Holesail.lookup masks the null from
    // HolesailClient.ping). Offline is a STATE, not an error: normalize
    // "record with no port" to null so the renderer can branch
    // online/offline/unknown cleanly. Malformed keys still throw
    // (Invalid key format), which surfaces as an RPC error -> 'unknown'.
    case 'lookup': {
      const res = await lookup(params.key)
      // holesail: a record with no port is a bare {secure} shell from an
      // unannounced key. A live peer returns its record and no
      // port at all (the local port is never published). Both are "online".
      return res && (Number.isInteger(res.port) || res.endpointId) ? res : null
    }
    // test-only: throw an async error OUTSIDE the RPC promise chain
    // (uncaughtException, like a real socket/bind failure) attributed to a
    // session via its port — the error-containment regression test relies
    // on this. The caller gets a response immediately; the throw happens
    // on the next tick so the containment path actually triggers.
    case 'test:throw':
      setImmediate(() => {
        throw Object.assign(
          new Error(`simulated bind failure on 127.0.0.1:${params.port}`),
          { port: params.port }
        )
      })
      return { thrown: true }
    default:
      throw new Error(`Unknown method: ${method}`)
  }
}

module.exports = { dispatch }
