/* saved.js — saved-tunnel (permanent) CRUD + the Saved tab UI.
   Depends on state, ui, bridge, sessions, recent, errors. */

import { state, flags, rememberSession } from './state.js'
import { $, el, badge, metaItem, toast, log, copyText } from './ui.js'
import {
  rpc,
  savedList,
  savedSave,
  savedDelete,
  savedDuplicate,
  savedExport,
  savedImport
} from './bridge.js'
import { addRecent } from './recent.js'
import { lookupKey } from './lookup.js'

/// 32 random bytes as hex — a fixed key for permanent tunnels.
export function genKey() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function refreshSaved() {
  try {
    state.saved = await savedList()
    renderSaved()
  } catch (err) {
    log('Failed to load saved tunnels: ' + err.message, 'err')
  }
}

/// Is there a running session for this saved tunnel?
export function savedSession(t) {
  const serverUrl = t.kind === 'server' ? (t.secure === false ? 'hs://0000' : 'hs://s000') + t.key : null
  const clientKey = t.kind === 'client' ? String(t.key || '').replace(/\/+$/, '') : null
  const fmUrl = t.kind === 'filemanager' ? (t.secure === false ? 'hs://0000' : 'hs://s000') + t.key : null
  for (const s of state.sessions.values()) {
    if (serverUrl && s.url === serverUrl) return s
    if (clientKey && s.url === clientKey) return s
    if (fmUrl && s.url === fmUrl) return s
  }
  return null
}

export async function startSaved(t) {
  try {
    let session
    if (t.kind === 'server') {
      session = await rpc('server:start', {
        port: t.port,
        host: t.host || '127.0.0.1',
        secure: t.secure !== false, // public permanents must stay public
        udp: t.udp,
        limit: t.limit || 0,
        key: t.key
      }, 90000) // cold DHT bootstrap can take 90s — same as the Share tab
    } else if (t.kind === 'filemanager') {
      if (!t.path) throw new Error('Saved folder share is missing its path')
      session = await rpc('filemanager:start', {
        path: t.path,
        secure: t.secure !== false,
        limit: t.limit || 0,
        key: t.key,
        host: t.host || undefined,
        port: t.port ?? undefined,
        role: t.role || undefined,
        username: t.username || undefined,
        password: t.password || undefined
      }, 90000)
    } else {
      session = await rpc('client:connect', {
        key: t.key,
        port: t.port ?? undefined,
        host: t.host || undefined,
        udp: t.udp,
        limit: t.limit || 0
      }, 90000) // cold DHT bootstrap can take 90s — same as the Connect tab
    }
    rememberSession(session.id, t.kind, {
      ...(t.kind === 'server'
        ? { port: t.port, host: t.host || '127.0.0.1', secure: t.secure !== false, udp: t.udp, limit: t.limit || 0, key: t.key }
        : t.kind === 'filemanager'
          ? { path: t.path, secure: t.secure !== false, limit: t.limit || 0, key: t.key }
          : { key: t.key, port: t.port ?? undefined, host: t.host || undefined, udp: t.udp, limit: t.limit || 0 })
    })
    addRecent(session.url)
    log(`Started saved tunnel "${t.name}"`, 'ok')
  } catch (err) {
    toast('Failed to start: ' + err.message, true)
  }
}

export async function stopSaved(t) {
  const s = savedSession(t)
  if (!s) return
  try {
    await rpc('session:stop', { id: s.id })
  } catch (err) {
    toast(err.message, true)
  }
}

export async function toggleAutostart(t) {
  await savedSave({ ...t, autostart: !t.autostart })
  await refreshSaved()
  toast(!t.autostart ? 'Will restart with the app' : "Won't auto-restart")
}

export function renderSaved() {
  const list = $('#saved-list')
  if (state.saved.length === 0) {
    list.innerHTML =
      '<p class="empty">No saved tunnels yet. Use "Permanent" on the Share tab or ' +
      '"Save this connection" on the Connect tab.</p>'
    return
  }
  list.innerHTML = ''
  for (const t of state.saved) {
    const item = el('div', 'saved-item')
    const head = el('div', 'saved-head')
    const nameSpan = el('span', 'saved-name', '', t.name)
    head.append(
      badge(
        t.kind === 'server' ? 'Server' : t.kind === 'filemanager' ? 'Folder' : 'Client',
        t.kind
      ),
      badge(t.secure === false ? 'Public' : 'Private', t.secure === false ? 'public' : 'secure'),
      nameSpan
    )
    // Saved CLIENT connections: is the remote server actually online?
    // Ping the DHT (worker lookup) and show it — a saved connection to a
    // dead/offline key silently fails to carry traffic otherwise.
    if (t.kind === 'client') {
      const net = el('span', 'net-status', '', '…')
      net.title = 'Checking whether the remote server is announced on the DHT'
      head.append(net)
      lookupKey(t.key).then((look) => {
        net.textContent =
          look.state === 'online' ? '● online' : look.state === 'offline' ? '○ offline' : '? unknown'
        net.classList.add(look.state)
        net.title =
          look.state === 'online'
            ? 'Server announced on the DHT (reachable)'
            : look.state === 'offline'
              ? 'No DHT record — server is offline or the key is invalid'
              : 'Lookup failed (DHT flake) — cannot tell'
      })
    }
    const startBtn = el('button', 'saved-start', '', savedSession(t) ? 'Stop' : 'Start')
    startBtn.addEventListener('click', () => {
      if (savedSession(t)) stopSaved(t)
      else startSaved(t)
    })
    head.append(startBtn)
    item.append(head)

    const keyLine = el(
      'code',
      '',
      '',
      t.kind === 'server' || t.kind === 'filemanager'
        ? (t.secure === false ? 'hs://0000' : 'hs://s000') + t.key
        : t.key
    )
    const meta = el('div', 'meta')
    if (t.kind === 'filemanager') meta.append(metaItem('Folder', t.path ?? '?'))
    else meta.append(metaItem('Port', t.port ?? 'auto'))
    if (t.host) meta.append(metaItem('Host', t.host))
    meta.append(metaItem('Auto-start', t.autostart ? 'on' : 'off'))
    item.append(keyLine, meta)

    const actions = el('div', 'saved-actions')
    const autostart = el('button', '', '', t.autostart ? 'Auto-start: on' : 'Auto-start: off')
    autostart.title = 'Restart automatically with the app'
    autostart.addEventListener('click', () => toggleAutostart(t))

    // rename — inline input (no prompt(): unreliable in Android WebView)
    const rename = el('button', '', '', 'Rename')
    rename.addEventListener('click', () => {
      const input = document.createElement('input')
      input.type = 'text'
      input.maxLength = 40
      input.value = t.name
      input.className = 'saved-rename-input'
      nameSpan.replaceWith(input)
      input.focus()
      input.select()
      const save = el('button', 'primary', '', 'Save')
      const cancel = el('button', '', '', 'Cancel')
      const done = async (apply) => {
        if (apply && input.value.trim()) {
          await savedSave({ ...t, name: input.value.trim() })
        }
        await refreshSaved()
      }
      save.addEventListener('click', () => done(true))
      cancel.addEventListener('click', () => done(false))
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(true)
        else if (e.key === 'Escape') done(false)
      })
      rename.replaceWith(save, cancel)
    })

    const dup = el('button', '', '', 'Duplicate')
    dup.addEventListener('click', async () => {
      await savedDuplicate(t.id)
      await refreshSaved()
      toast('Duplicated')
    })
    const exp = el('button', '', '', 'Export')
    exp.addEventListener('click', () => copyText(JSON.stringify([t], null, 2)))

    // delete — two-tap confirm (no confirm(): unreliable in Android WebView)
    const del = el('button', 'danger', '', 'Delete')
    let confirmTimer = null
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== 'yes') {
        del.dataset.confirm = 'yes'
        del.textContent = 'Confirm?'
        clearTimeout(confirmTimer)
        confirmTimer = setTimeout(() => {
          del.dataset.confirm = ''
          del.textContent = 'Delete'
        }, 3000)
        return
      }
      clearTimeout(confirmTimer)
      await savedDelete(t.id)
      await refreshSaved()
    })
    actions.append(autostart, rename, dup, exp, del)
    item.append(actions)
    list.appendChild(item)
  }
}

export async function exportAllSaved() {
  try {
    const json = await savedExport()
    await copyText(json)
  } catch {
    toast('Export failed', true)
  }
}

export async function applyImport() {
  const json = $('#saved-import-json').value.trim()
  if (!json) return
  try {
    const n = await savedImport(json)
    await refreshSaved()
    toast(`Imported ${n} saved tunnel${n === 1 ? '' : 's'}`)
    $('#saved-import-box').hidden = true
    $('#saved-import-json').value = ''
  } catch (err) {
    toast('Import failed: ' + err.message, true)
  }
}

/// Auto-restart saved tunnels (autostart = on) after the worker connects.
/// Guarded so concurrent callers (boot + worker:spawned) never double-start
/// a tunnel — a port-less client would otherwise get two proxies.
export async function autostartSaved() {
  if (flags.autostartRunning) return
  flags.autostartRunning = true
  try {
    for (const t of state.saved) {
      if (!t.autostart) continue
      if (savedSession(t)) continue
      try {
        await startSaved(t)
        log(`Auto-started saved tunnel "${t.name}"`, 'ok')
      } catch (err) {
        log(`Auto-start failed for "${t.name}": ${err.message}`, 'err')
      }
    }
  } finally {
    flags.autostartRunning = false
  }
}
