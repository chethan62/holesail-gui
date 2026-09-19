/* engine/index.js - the seam that selects the tunnel engine.
 *
 * One engine today: holesail (HyperDHT, hs:// keys, AGPL-3.0). The iroh engine
 * that lived here (QUIC, iroh tickets, MIT/Apache-2.0) became its own project:
 * @number0/iroh ships NAPI-RS prebuilds and needs Node >= 20.3, while the Bare
 * runtime a packaged build runs loads only its own addon ABI - so an iroh
 * engine could never ship from this repo. It is github.com/chethan62/iroh-tunnel
 * now, with the UDP datagram work and its tests.
 *
 * The facade both the callers and any future engine speak: `Engine` (the
 * constructor tunnels.js calls with {server|client, port, host, secure, key,
 * udp}) and `lookup(key)`. This file is the only place a swap happens.
 */

'use strict'

const Holesail = require('holesail')

module.exports = {
  name: 'holesail',
  Engine: Holesail,
  lookup: (key) => Holesail.lookup(key)
}
