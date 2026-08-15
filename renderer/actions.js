/* actions.js — the Share / Share-a-folder / Connect form handlers, plus the
   DHT lookup preflight and drag-and-drop. Depends on state, ui, bridge,
   sessions, saved, errors. */

import { rememberSession } from './state.js'
import { $, log, toast, setBusy, isBroadSharePath, confirmInline, updatePublicWarnings } from './ui.js'
import { rpc, savedSave, savedDelete } from './bridge.js'
import { genKey, refreshSaved } from './saved.js'
import { addRecent } from './recent.js'
import { humanError } from './errors.js'
import { lookupKey } from './lookup.js'

// Re-exported so the boot wiring in app.js can import them from one place.
export { updatePublicWarnings, lookupKey }

// Read a speed-limit input (KB/s) → bytes/sec for the worker. Empty/0 →
// 0 (unlimited). Clamped to a sane ceiling (1 GB/s) so a typo can't set a
// nonsense value.
export function readLimit(sel) {
  const v = $(sel).value.trim()
  if (!v) return 0
  const kb = Number(v)
  if (!Number.isFinite(kb) || kb <= 0) return 0
  return Math.min(Math.round(kb * 1024), 1024 * 1024 * 1024)
}

export async function startShare(event) {
  event.preventDefault()
  const button = $('#share-start')
  const isPerm = $('#share-type').value === 'perm'
  const key = $('#share-key').value.trim() || undefined
  const params = {
    port: Number($('#share-port').value),
    host: $('#share-host').value.trim() || '127.0.0.1',
    secure: $('#share-secure').checked,
    udp: $('#share-udp').checked,
    limit: readLimit('#share-limit'),
    key
  }
  setBusy(button, true)
  let tunnel = null // hoisted so the catch can roll back a persisted-but-failed save
  try {
    if (isPerm) {
      // permanent: fixed key (user-provided or generated once), saved to
      // the store so it auto-restarts with the same connection string
      if (!key) params.key = genKey()
      tunnel = await savedSave({
        id: '',
        name: $('#share-name').value.trim() || 'Permanent server',
        kind: 'server',
        key: params.key,
        port: params.port,
        host: params.host,
        secure: params.secure,
        udp: params.udp,
        limit: params.limit,
        autostart: true,
        createdAt: Date.now()
      })
    }
    const session = await rpc('server:start', params, 90000)
    rememberSession(session.id, 'server', { ...params })
    log(`Server started on ${session.host}:${session.port} (${session.protocol})`, 'ok')
    toast(isPerm ? 'Permanent sharing started 🔒' : 'Sharing started 🎉')
    addRecent(session.url)
    if (tunnel) {
      await refreshSaved()
      log(`Saved as permanent tunnel "${tunnel.name}" — it will restart with the app`, 'ok')
    }
    $('#share-port').value = ''
    $('#share-key').value = ''
  } catch (err) {
    const msg = humanError(err)
    log('Failed to start server: ' + msg, 'err')
    toast('Failed to start: ' + msg, true)
    if (tunnel) {
      // roll back the persisted permanent tunnel — it never started
      await savedDelete(tunnel.id).catch(() => {})
      await refreshSaved()
      log('Removed permanent tunnel that failed to start', 'warn')
    }
  } finally {
    setBusy(button, false)
  }
}

export async function startFilemanagerShare(event) {
  event.preventDefault()
  const button = $('#fm-start')
  const path = $('#fm-path').value.trim()
  if (!path) {
    toast('Enter a folder path', true)
    return
  }
  // Guardrail: sharing an entire home directory (or the filesystem root)
  // over the DHT is almost never what a fat-fingered path intended. Cheap
  // insurance — ask once before exposing something that broad.
  const broad = isBroadSharePath(path)
  if (broad) {
    const go = await confirmInline(
      `"${path}" is a broad path — this would expose it over the tunnel. Share it anyway?`
    )
    if (!go) {
      log(`Folder share aborted — broad path "${path}"`, 'warn')
      return
    }
    log(`Sharing broad path "${path}" (user confirmed)`, 'warn')
  }
  const isPerm = $('#fm-perm').checked
  const key = $('#fm-key').value.trim() || undefined
  const params = { path, secure: $('#fm-secure').checked, limit: readLimit('#fm-limit'), key }
  setBusy(button, true)
  let tunnel = null // hoisted so the catch can roll back a persisted-but-failed save
  try {
    if (isPerm) {
      if (!key) params.key = genKey()
      tunnel = await savedSave({
        id: '',
        name: $('#fm-name').value.trim() || 'Permanent folder',
        kind: 'filemanager',
        key: params.key,
        path: params.path,
        secure: params.secure,
        udp: false, // filemanager can't use UDP (CLI validateInput)
        limit: params.limit,
        autostart: true,
        createdAt: Date.now()
      })
    }
    const session = await rpc('filemanager:start', params, 90000)
    rememberSession(session.id, 'filemanager', { path, secure: params.secure, key: params.key })
    log(`File manager sharing ${path} (${session.host}:${session.port})`, 'ok')
    toast('Folder shared 📁')
    addRecent(session.url)
    $('#fm-path').value = ''
    if (tunnel) {
      await refreshSaved()
      log(`Saved folder share "${tunnel.name}" — it will restart with the app`, 'ok')
    }
  } catch (err) {
    const msg = humanError(err)
    log('Failed to share folder: ' + msg, 'err')
    toast('Failed to share: ' + msg, true)
    if (tunnel) {
      // roll back the persisted permanent folder share — it never started
      await savedDelete(tunnel.id).catch(() => {})
      await refreshSaved()
      log('Removed folder share that failed to start', 'warn')
    }
  } finally {
    setBusy(button, false)
  }
}

/// Drag-and-drop folder sharing: drop a directory from the OS file
/// manager anywhere on the window → start a filemanager tunnel for it.
/// The drop zone overlay shows during the drag; the path goes through
/// the same startFilemanagerShare path (broad-path guardrail included).
export function bindDropZone() {
  const zone = $('#drop-zone')
  let depth = 0 // dragenter/dragleave fire per child element — track depth

  const show = () => {
    depth++
    zone.hidden = false
  }
  const hide = () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) zone.hidden = true
  }

  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) show()
  })
  window.addEventListener('dragover', (e) => {
    // required to allow the drop
    if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
    }
  })
  window.addEventListener('dragleave', hide)
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    depth = 0
    zone.hidden = true
    const files = e.dataTransfer && e.dataTransfer.files
    if (!files || !files.length) return
    // only directories are shareable — a dropped file means the user
    // grabbed the wrong thing; tell them clearly
    const item = files[0]
    if (item.type || !item.path) {
      toast('Drop a folder, not a file', true)
      return
    }
    // route through the exact same share flow as the form
    $('#fm-path').value = item.path
    startFilemanagerShare(new Event('submit'))
  })
}

export async function startConnect(event) {
  event.preventDefault()
  const button = $('#connect-start')
  const portVal = $('#connect-port').value
  const params = {
    key: $('#connect-key').value.trim(),
    port: portVal ? Number(portVal) : undefined,
    host: $('#connect-host').value.trim() || undefined,
    udp: $('#connect-udp').checked,
    limit: readLimit('#connect-limit')
  }
  if (!params.key) return
  setBusy(button, true)
  let tunnel = null // hoisted so the catch can roll back a persisted-but-failed save
  try {
    // holesail's ready() resolves even when the server is offline (the
    // phantom-tunnel trap): the card would sit "running" while proxying to
    // nothing. Ping the DHT record first so a dead key fails fast with a
    // clear message instead.
    const look = await lookupKey(params.key)
    if (look.state === 'offline') {
      const go = await confirmInline(
        `No tunnel found for this key on the DHT (offline or invalid). Connect anyway?`
      )
      if (!go) {
        log('Connect aborted — key not found on the DHT', 'warn')
        return
      }
      log('Key not found on the DHT — connecting anyway (phantom tunnel possible)', 'warn')
    } else if (look.state === 'online') {
      log('Key reachable on the DHT (server announced)', 'ok')
    }
    if ($('#connect-save').checked) {
      // normalize the key before saving: the worker strips trailing
      // slashes (URL parsers add them), and the saved key must match the
      // session url exactly or the dedupe/autostart logic double-connects
      const cleanKey = params.key.replace(/\/+$/, '')
      tunnel = await savedSave({
        id: '',
        name: $('#connect-name').value.trim() || 'Saved connection',
        kind: 'client',
        key: cleanKey,
        port: params.port ?? null,
        host: params.host ?? null,
        secure: cleanKey.startsWith('hs://s000'),
        udp: params.udp,
        limit: params.limit,
        autostart: true,
        createdAt: Date.now()
      })
    }
    const session = await rpc('client:connect', params, 90000)
    rememberSession(session.id, 'client', { ...params })
    log(`Connected to ${session.host}:${session.port} (${session.protocol})`, 'ok')
    toast('Connected')
    addRecent(params.key)
    if (tunnel) {
      await refreshSaved()
      log(`Saved connection "${tunnel.name}" — it will reconnect with the app`, 'ok')
    }
    $('#connect-key').value = ''
    $('#connect-port').value = ''
    $('#connect-save').checked = false
    $('#connect-name-wrap').hidden = true
  } catch (err) {
    const msg = humanError(err)
    log('Failed to connect: ' + msg, 'err')
    toast('Failed to connect: ' + msg, true)
    if (tunnel) {
      // roll back the persisted saved connection — it never connected
      await savedDelete(tunnel.id).catch(() => {})
      await refreshSaved()
      log('Removed saved connection that failed to start', 'warn')
    }
  } finally {
    setBusy(button, false)
  }
}
