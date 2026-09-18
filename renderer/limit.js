/* limit.js — the all-tunnels speed limit (the shared bandwidth budget).
   Depends on state, ui, bridge, sessions. The worker holds the live value;
   Rust persists it, so a link the user deliberately capped does not come
   back uncapped after a restart (permanent tunnels restart on their own). */

import { state } from './state.js'
import { $, log, toast, readLimit, fmtBytes } from './ui.js'
import { rpc, settingsGet, settingsSet } from './bridge.js'
import { updateUptimeNote } from './sessions.js'

/// Apply the value in the input: worker first (that's the part that must
/// work), then persist. Persisting is best-effort — a read-only config dir
/// must not look like the cap failed.
export async function applyGlobalLimit() {
  const limit = readLimit('#global-limit')
  try {
    await rpc('limit:global', { limit })
  } catch (err) {
    toast('Could not set the total speed limit: ' + err.message, true)
    return
  }
  state.globalLimit = limit
  $('#global-limit').value = limit ? String(Math.round(limit / 1024)) : ''
  log(
    limit
      ? `Total speed limit: ${fmtBytes(limit)}/s across all tunnels`
      : 'Total speed limit cleared'
  )
  updateUptimeNote()
  settingsSet({ globalLimit: limit }).catch((err) =>
    log('Could not save the total speed limit: ' + err.message, 'warn')
  )
}

/// Hand the persisted value to the worker. Called at boot and after every
/// worker (re)start: a respawned worker knows nothing about the cap, and
/// permanent tunnels restart right after this — so this must run first.
export async function restoreGlobalLimit() {
  try {
    const settings = await settingsGet()
    const limit = Number(settings && settings.globalLimit) || 0
    if (limit <= 0) return
    await rpc('limit:global', { limit })
    state.globalLimit = limit
    $('#global-limit').value = String(Math.round(limit / 1024))
    updateUptimeNote()
    // log it: after a restart the tunnels are slow for a reason the user
    // can't see in the UI (the field is filled, but the reason isn't)
    log(`Total speed limit restored: ${fmtBytes(limit)}/s across all tunnels`)
  } catch (err) {
    log('Could not restore the total speed limit: ' + err.message, 'err')
  }
}

export function bindGlobalLimit() {
  $('#global-limit-apply').addEventListener('click', applyGlobalLimit)
  // Enter in the field applies too (the row is outside any form, so the
  // browser would otherwise do nothing)
  $('#global-limit').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyGlobalLimit()
  })
}
