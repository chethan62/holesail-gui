/* engine/index.js - the seam that selects the tunnel engine.
 *
 * One engine: ours (hs.js) - the holesail protocol over the permissive stack
 * (hyperdht MIT, z32 MIT, @holesail/hyper-cmd-lib-net Apache-2.0). It replaces
 * the AGPL/GPL holesail glue (holesail + holesail-server + holesail-client +
 * holesail-logger + barely-colours), which was the only copyleft left in a
 * shipped installer, and speaks the same `hs://` keys - so the phone app and
 * the holesail CLI keep working against it. Protocol, spike evidence and the
 * migration checklist: references/permissive-engine-migration.md in the
 * holesail-gui skill.
 *
 * The iroh engine that once lived here (QUIC, iroh tickets) became its own
 * project (github.com/chethan62/iroh-tunnel): @number0/iroh ships NAPI-RS
 * prebuilds needing Node >= 20.3, while a packaged build runs the worker under
 * Bare (its own addon ABI), so it could never ship from this repo.
 *
 * The facade both the callers and any future engine speak: `Engine` (the
 * constructor tunnels.js calls with {server|client, port, host, secure, key,
 * udp}) and `lookup(key)`. This file is the only place a swap happens.
 */

'use strict'

const { Engine, lookup } = require('./hs.js')

module.exports = {
  name: 'hs',
  Engine,
  lookup
}
