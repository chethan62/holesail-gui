/* engine/index.js — the single seam that selects the tunnel engine.
 *
 * Default is holesail (unchanged behaviour, DHT/HyperDHT, AGPL engine).
 * TUNNEL_ENGINE=iroh swaps in worker/engine/iroh.js — QUIC, MIT/Apache-2.0,
 * same facade, different network (iroh tickets instead of hs:// keys, TCP
 * only, always encrypted).
 *
 * Both expose `Engine` (a constructor tunnels.js calls with
 * {server|client, port, host, secure, key, udp}) and `lookup(key)`. */

'use strict'

const name = String(process.env.TUNNEL_ENGINE || 'holesail')
  .trim()
  .toLowerCase()

if (name === 'iroh') {
  const { Iroh, lookup } = require('./iroh.js')
  module.exports = { name, Engine: Iroh, lookup }
} else {
  const Holesail = require('holesail')
  module.exports = {
    name: 'holesail',
    Engine: Holesail,
    lookup: (key) => Holesail.lookup(key)
  }
}
