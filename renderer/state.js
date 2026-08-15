/* state.js — shared mutable application state + module-level flags.
   The single source of truth for session/saved/recent data and the
   worker/lifecycle flags. Imported by every other renderer module; this
   module imports NOTHING (acyclic leaf), so there are no circular deps. */

export const state = {
  sessions: new Map(), // id -> session
  meta: new Map(), // id -> { startedAt }
  revealed: new Set(), // ids whose connection string is revealed
  saved: [], // saved tunnels from the backend (temp/permanent)
  recent: [], // recent keys, mirrored from the Rust keychain/file store
  replay: new Map(), // session id -> { type, params } for one-click reconnect
  lanIp: null, // this machine's LAN IPv4, for direct same-network access
  homeDir: null, // home dir, feeds the folder-share broad-path guardrail
  workerOk: false,
  traffic: new Map(), // id -> { up: number[], down: number[] } rolling history
  conn: new Map() // id -> total peers connected (server sessions)
}

// Module-level mutable flags (shared across modules). Grouped in one object
// so they're discoverable and greppable; each has a single owning module.
export const flags = {
  workerReady: false, // worker:ready handshake received; RPCs fail fast until set
  lastPeerToast: 0, // timestamp of the last peer-connected toast (rate limit)
  nodeRetryInFlight: false, // retryNode() guard
  autostartRunning: false, // autostartSaved() re-entrancy guard
  relaySessions: new Set() // session ids that have seen a relayed peer
}

/// Remember the params that started a session so a dropped temporary
/// tunnel can be restarted in one click (see the 'error' event path).
/// Pure state mutation — lives here (not in a DOM module) so both
/// sessions.js and actions.js/saved.js can use it without a cycle.
export function rememberSession(id, type, params) {
  state.replay.set(id, { type, params })
}

