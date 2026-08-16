/* dispatch.js — the method router. Depends on runtime.js + tunnels.js.
 *
 * Keep the method names in sync with the Rust `rpc` command's ALLOWED list
 * (src-tauri/src/rpc.rs). `test:throw` is test-only and NOT in the Rust
 * allowlist — it must stay out of production reach.
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

const Holesail = require('holesail')

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

module.exports = { dispatch }
