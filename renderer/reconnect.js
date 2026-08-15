/* reconnect.js — one-click reconnect for dropped temporary tunnels.
   Depends on state.js, ui.js, bridge.js. */

import { state } from './state.js'
import { log, toast } from './ui.js'
import { rpc } from './bridge.js'
import { humanError } from './errors.js'
import { addRecent } from './recent.js'

export async function reconnectSession(id) {
  const r = state.replay.get(id)
  if (!r) return
  // filemanager sessions must reconnect through filemanager:start (they
  // carry {path, secure}, not {port, host} — routing them to server:start
  // used to fail with "Invalid port: undefined")
  const method =
    r.type === 'client'
      ? 'client:connect'
      : r.type === 'filemanager'
        ? 'filemanager:start'
        : 'server:start'
  try {
    const session = await rpc(method, r.params, 90000)
    state.replay.delete(id) // the new session has its own id
    log(
      `Reconnected ${
        r.type === 'filemanager' ? 'file manager' : r.type === 'server' ? 'server' : 'client'
      } (${session.host}:${session.port})`,
      'ok'
    )
    toast('Reconnected')
    addRecent(session.url)
  } catch (err) {
    const msg = humanError(err)
    log('Reconnect failed: ' + msg, 'err')
    toast('Reconnect failed: ' + msg, true)
  }
}
