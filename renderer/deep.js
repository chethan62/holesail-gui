/* deep.js — hs:// deep links + stop-all-tunnels (tray action).
   Depends on state, ui, bridge, actions. */

import { state } from './state.js'
import { $, log, toast, switchTab, updatePublicWarnings } from './ui.js'
import { rpc } from './bridge.js'

export function handleDeepLink(url) {
  if (!url.startsWith('hs://')) return
  const input = $('#connect-key')
  if (input.value === url) return // already loaded (queued + live event)
  input.value = url
  switchTab('connect')
  updatePublicWarnings() // a public hs://0000… deep link must show the warning
  toast('Connection string loaded — press Connect')
  log('Loaded connection string from deep link')
}

export async function stopAllTunnels() {
  const ids = [...state.sessions.keys()]
  if (ids.length === 0) {
    toast('No active tunnels')
    return
  }
  let stopped = 0
  for (const id of ids) {
    try {
      await rpc('session:stop', { id })
      stopped++
    } catch (err) {
      log('Failed to stop ' + id + ': ' + err.message, 'err')
    }
  }
  toast(`Stopped ${stopped} tunnel${stopped === 1 ? '' : 's'}`)
}
