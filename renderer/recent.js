/* recent.js — recent connection keys (Rust backend, OS keychain/0600 file).
   state.recent is the in-memory mirror; mutations update the cache
   immediately and persist in the background. Depends on state, ui, bridge. */

import { state } from './state.js'
import { $, RECENT_KEY, updatePublicWarnings } from './ui.js'
import { recentList, recentAdd } from './bridge.js'

export async function initRecent() {
  try {
    state.recent = await recentList()
  } catch {
    state.recent = []
  }
  // One-time migration: builds before the keychain store kept recents in
  // web storage. Move them into the backend, then wipe the local copy.
  try {
    const legacy = JSON.parse(localStorage.getItem(RECENT_KEY)) || []
    if (legacy.length) {
      for (const item of legacy.slice(0, 10).reverse()) {
        await recentAdd(item)
      }
      state.recent = await recentList()
    }
    localStorage.removeItem(RECENT_KEY)
  } catch {}
  renderRecent()
}

export function addRecent(label) {
  state.recent = [label, ...state.recent.filter((x) => x !== label)].slice(0, 10)
  recentAdd(label).catch(() => {})
  renderRecent()
}

export function renderRecent() {
  const list = state.recent
  const row = $('#recent-row')
  const chips = $('#recent-chips')
  const dl = $('#recent-keys')
  dl.innerHTML = ''
  if (list.length === 0) {
    row.hidden = true
    return
  }
  row.hidden = false
  chips.innerHTML = ''
  for (const item of list) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'recent-chip'
    chip.textContent = item.length > 26 ? item.slice(0, 23) + '…' : item
    chip.title = item
    chip.addEventListener('click', () => {
      $('#connect-key').value = item
      updatePublicWarnings() // a public recent must show the warning too
    })
    chips.appendChild(chip)
    const opt = document.createElement('option')
    opt.value = item
    dl.appendChild(opt)
  }
}
