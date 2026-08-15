/* lookup.js — DHT reachability preflight (worker `lookup`). Leaf module
   (depends only on bridge.js) so both actions.js and saved.js can use it
   without a cycle. */

import { rpc } from './bridge.js'

/// Reachability pre-flight: ping the key's DHT record (worker `lookup`).
/// Returns { state } where state is 'online' (record found), 'offline'
/// (no record — the tunnel can't establish), or 'unknown' (lookup
/// itself failed / timed out — DHT flake, not proof the peer is down).
export async function lookupKey(key) {
  try {
    const res = await rpc('lookup', { key }, 45000)
    return { state: res ? 'online' : 'offline', info: res }
  } catch (err) {
    return { state: 'unknown', error: err.message }
  }
}
