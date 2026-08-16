/* state.js — shared mutable worker state. Leaf module: imports nothing.
 *
 * Everything that tunnels/dispatch/errors/traffic mutate lives here so the
 * modules stay acyclic (features never import each other; they all import
 * this shared leaf).
 */

// id -> { hs, type, url, port, host, secure, protocol, key, publicKey,
//         state, stats, limit, fileServer?, dir?, fsRole?, ... }
const sessions = new Map()

let nextId = 1
function nextSessionId() {
  return String(nextId++)
}

// id -> timeout handle (throttled per-session traffic emit)
const statsTimers = new Map()

module.exports = { sessions, statsTimers, nextSessionId }
