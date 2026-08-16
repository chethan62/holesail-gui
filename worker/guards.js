/* guards.js — session-cap, broad-path guardrail, and free-port helper.
 * Depends on runtime.js + state.js.
 */

const { net, process } = require('./runtime.js')
const { sessions } = require('./state.js')

// Hard ceiling on concurrent tunnels. A single-user local GUI should never
// need hundreds; this guards against fd/port exhaustion from a runaway
// script or a UI bug that re-shares the same port in a loop.
const MAX_SESSIONS = 50

function assertCapacity() {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Too many sessions (limit ${MAX_SESSIONS}) — stop some before starting more`)
  }
}

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

module.exports = { MAX_SESSIONS, assertCapacity, pickFreePort, isBroadSharePath }
