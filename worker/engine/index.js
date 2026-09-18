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

// `process` comes from runtime.js like every other worker module: Bare (the
// runtime a packaged build runs the worker under) has NO global `process`, so
// reading `process.env` here killed the worker on load — the whole packaged
// app failed to start, and the only symptom was the suite's opaque "timeout
// waiting for ping". Bare gets an empty env, i.e. the default engine.
const { process: proc } = require('../runtime.js')

const name = String((proc.env && proc.env.TUNNEL_ENGINE) || 'holesail')
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
