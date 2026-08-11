/* renderer.js — Holesail GUI front-end logic. Runs in the sandboxed webview;
   talks to the service worker only through the Tauri bridge (bridge.js). */

'use strict'

import {
  rpc,
  onEvent,
  workerDiagnostics,
  workerRestart,
  workerRetrySpawn,
  takePendingDeepLinks,
  onAppEvent,
  versionInfo,
  lanAddress,
  savedList,
  savedSave,
  savedDelete,
  savedDuplicate,
  savedExport,
  savedImport
} from './bridge.js'

const $ = (sel) => document.querySelector(sel)
const RECENT_KEY = 'holesail-gui:recent'
const THEME_KEY = 'holesail-gui:theme'

/* ------------------------------ helpers -------------------------------- */

function log(message, cls = '') {
  const line = document.createElement('div')
  line.className = 'log-line ' + cls
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`
  const el = $('#log')
  if (el.querySelector('.empty')) el.innerHTML = ''
  el.appendChild(line)
  el.scrollTop = el.scrollHeight
}

let toastTimer = null
function toast(message, isError = false) {
  const el = $('#toast')
  el.textContent = message
  el.classList.toggle('err', isError)
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000)
}

function setBusy(button, busy) {
  button.disabled = busy
  button.textContent = busy ? 'Working…' : button.dataset.label
}

/// Copy text to the clipboard. navigator.clipboard needs a secure context
/// + permission and can be missing in some Android WebViews; fall back to
/// a hidden textarea + execCommand('copy').
function copyText(text) {
  return new Promise((resolve) => {
    const done = (ok) => {
      toast(ok ? 'Copied' : 'Copy failed', !ok)
      resolve(ok)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => fallback(text, done))
    } else {
      fallback(text, done)
    }
    function fallback(t, cb) {
      try {
        const ta = document.createElement('textarea')
        ta.value = t
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        cb(ok)
      } catch {
        cb(false)
      }
    }
  })
}

function maskKey(url) {
  if (url.length <= 16) return url
  return url.slice(0, 10) + '…' + url.slice(-8)
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  const h = Math.floor(m / 60)
  return h + 'h ' + (m % 60) + 'm'
}

/* DOM builder helpers — all text goes through textContent so untrusted
   values (connection strings, hosts, log lines) can never inject HTML. */
function el(tag, className = '', id = '', text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (id) node.id = id
  if (text !== '') node.textContent = text
  return node
}

function metaItem(label, value) {
  const span = el('span')
  span.append(label + ': ', el('strong', '', '', String(value ?? '—')))
  return span
}

function badge(text, kind) {
  return el('span', 'badge ' + kind, '', text)
}

/* ------------------------------ state ---------------------------------- */

const state = {
  sessions: new Map(), // id -> session
  meta: new Map(), // id -> { startedAt }
  revealed: new Set(), // ids whose connection string is revealed
  saved: [], // saved tunnels from the backend (temp/permanent)
  lanIp: null, // this machine's LAN IPv4, for direct same-network access
  workerOk: false
}

// worker readiness handshake (worker:ready event); RPCs fail fast until set
let workerReady = false

function upsertSession(data) {
  if (data.state === 'stopped') {
    state.sessions.delete(data.id)
    state.meta.delete(data.id)
    state.revealed.delete(data.id)
  } else {
    if (data.state === 'error') {
      // the worker killed just this session after an async error — show
      // why, then the follow-up 'stopped' event removes the card
      log(`Session errored: ${data.error || 'unknown error'}`, 'err')
    }
    const existing = state.sessions.get(data.id)
    if (existing) {
      Object.assign(existing, data) // events may carry only {id, state}
    } else {
      state.sessions.set(data.id, { ...data })
      if (!state.meta.has(data.id)) state.meta.set(data.id, { startedAt: Date.now() })
    }
  }
  renderSessions()
}

function renderSessions() {
  const container = $('#sessions')
  if (state.sessions.size === 0) {
    container.innerHTML =
      '<p class="empty">No active sessions. Share a port or connect to a tunnel to get started.</p>'
    updateUptimeNote()
    return
  }
  container.innerHTML = ''
  for (const s of state.sessions.values()) renderSession(container, s)
  updateUptimeNote()
}

function updateUptimeNote() {
  const note = $('#uptime-note')
  if (state.sessions.size === 0) {
    note.textContent = '—'
    return
  }
  const ages = [...state.meta.values()].map((m) => Date.now() - m.startedAt)
  const oldest = ages.length ? fmtDuration(Math.min(...ages)) : ''
  note.textContent = `${state.sessions.size} session${state.sessions.size > 1 ? 's' : ''} · up ${oldest}`
}

function renderSession(container, s) {
  const card = el('div', 'session', 'session-' + s.id)
  const type = s.type === 'server' ? 'Server' : 'Client'
  const mode = s.secure ? 'Private' : 'Public'
  const isPaused = s.state === 'paused'
  const meta = state.meta.get(s.id)
  const uptime = meta ? fmtDuration(Date.now() - meta.startedAt) : ''

  const urlText = s.url || ''
  const displayUrl = s.secure && !state.revealed.has(s.id) ? maskKey(urlText) : urlText

  // head: badges + state
  const head = el('div', 'head')
  head.append(
    badge(type, s.type),
    badge(mode, s.secure ? 'secure' : 'public'),
    badge((s.protocol || 'tcp').toUpperCase(), 'proto'),
    el('span', 'state ' + (s.state || 'running'), '', s.state || 'running')
  )
  card.append(head)

  // body: QR (servers only) + url + meta
  const body = el('div', 'card-body')
  if (s.type === 'server') {
    const qrBox = el('div', 'qr')
    if (s.secure && !state.revealed.has(s.id)) {
      qrBox.textContent = 'QR hidden while key is masked'
    } else {
      try {
        const q = qrcode(0, 'M')
        q.addData(urlText)
        q.make()
        const img = document.createElement('img')
        img.src = q.createDataURL(4, 8)
        img.alt = 'QR code'
        qrBox.append(img)
      } catch {
        qrBox.textContent = 'QR unavailable'
      }
    }
    body.append(qrBox)
  }

  const urlCol = el('div', 'url-col')
  const urlRow = el('div', 'url-row')
  urlRow.append(el('code', '', '', displayUrl))
  if (s.secure) {
    const eye = el('button', 'eye-btn', '', '👁')
    eye.title = 'Reveal / hide'
    eye.addEventListener('click', () => {
      if (state.revealed.has(s.id)) state.revealed.delete(s.id)
      else state.revealed.add(s.id)
      renderSessions()
    })
    urlRow.append(eye)
  }
  const copy = el('button', 'copy', '', 'Copy')
  copy.title = 'Copy connection string'
  copy.addEventListener('click', () => copyText(urlText))
  urlRow.append(copy)
  urlCol.append(urlRow)

  // Client sessions expose a local HTTP proxy. Android Chrome refuses
  // literal 127.0.0.1 in some cases, but `localhost` always resolves to
  // the app's tunnel — hand out the URL that actually works.
  if (s.type === 'client' && s.port) {
    const localUrl = 'http://localhost:' + s.port + '/'
    const localRow = el('div', 'url-row')
    localRow.append(el('code', 'local-url', '', localUrl))
    const copyUrl = el('button', 'copy', '', 'Copy URL')
    copyUrl.title = 'Copy local URL'
    copyUrl.addEventListener('click', () => copyText(localUrl))
    localRow.append(copyUrl)
    urlCol.append(localRow)
  }

  // Server sessions also expose the service on the LAN — a phone on the
  // SAME network can skip the DHT entirely and hit the LAN URL directly
  // (fast, and works even when hole-punching is blocked by the router).
  // Only shown when the machine actually has a LAN address; the DHT
  // connection string above remains the universal fallback.
  if (s.type === 'server' && s.port && state.lanIp && state.lanIp !== '127.0.0.1') {
    const lanUrl = `http://${state.lanIp}:${s.port}/`
    const lanRow = el('div', 'url-row')
    lanRow.append(el('code', 'local-url', '', lanUrl))
    const copyLan = el('button', 'copy', '', 'Copy LAN URL')
    copyLan.title = 'Copy LAN URL (same network only)'
    copyLan.addEventListener('click', () => copyText(lanUrl))
    lanRow.append(copyLan)
    urlCol.append(lanRow)
  }

  const metaRow = el('div', 'meta')
  metaRow.append(metaItem('Host', s.host), metaItem('Port', s.port))
  const up = el('span')
  up.append('Uptime: ', el('strong', 'up', '', uptime))
  metaRow.append(up)
  urlCol.append(metaRow)
  body.append(urlCol)
  card.append(body)

  // actions
  const actions = el('div', 'actions')
  const pause = el('button', 'pause', '', isPaused ? 'Resume' : 'Pause')
  pause.addEventListener('click', async () => {
    try {
      await rpc(isPaused ? 'session:resume' : 'session:pause', { id: s.id })
    } catch (err) {
      toast(err.message, true)
    }
  })
  const stop = el('button', 'stop', '', s.type === 'server' ? 'Stop sharing' : 'Disconnect')
  stop.addEventListener('click', async () => {
    try {
      await rpc('session:stop', { id: s.id })
      toast(s.type === 'server' ? 'Sharing stopped' : 'Disconnected')
    } catch (err) {
      toast(err.message, true)
    }
  })
  actions.append(pause, stop)
  card.append(actions)

  container.append(card)
}

/* ------------------------------ worker ---------------------------------- */

function updateWorkerStatus(ok, label) {
  state.workerOk = ok
  const dot = $('#worker-dot')
  dot.className = 'dot ' + (ok ? 'ok pulse' : ok === null ? '' : 'err')
  $('#worker-label').textContent = label
  // manual restart is only useful when the worker is down or degraded
  $('#worker-restart').hidden = ok === true
}

/// Ping the worker and pull the current session list into the UI.
async function syncWorker() {
  await rpc('ping', {})
  updateWorkerStatus(true, 'worker online')
  const sessions = await rpc('sessions:list', {})
  for (const s of sessions) upsertSession(s)
}

/* ------------------------ node-required screen ------------------------- */
// Shown when the desktop backend cannot find a Node.js runtime to run the
// worker (the bundled bare runtime is preferred; this only happens on
// dev/standalone installs without the bundle).

function showNodeRequired() {
  updateWorkerStatus(false, 'node.js required')
  $('#node-required').hidden = false
}

function hideNodeRequired() {
  $('#node-required').hidden = true
}

let nodeRetryInFlight = false
async function retryNode() {
  if (nodeRetryInFlight) return
  nodeRetryInFlight = true
  const btn = $('#node-retry')
  btn.disabled = true
  try {
    await workerRetrySpawn()
    // success path flows through worker:ready — hideNodeRequired() there
  } catch (err) {
    log('Node.js still not found: ' + err.message, 'err')
    $('#node-required-msg').textContent =
      'Still can\'t find Node.js. Install it, then try again (restarting the app also refreshes the PATH).'
  } finally {
    btn.disabled = false
    nodeRetryInFlight = false
  }
}

function bindNodeScreen() {
  // CSP blocks in-webview navigation; copy the link instead
  $('#node-install').addEventListener('click', () => copyText('https://nodejs.org'))
  $('#node-retry').addEventListener('click', retryNode)
}

onEvent((msg) => {
  switch (msg.event) {
    case 'session:update':
      upsertSession(msg.data)
      break
    case 'worker:spawned':
      // fresh worker (boot or respawn): log only — actual syncing waits for
      // worker:ready so RPCs never race a still-initializing worker
      log('Service worker started')
      // fallback: a worker that never emits ready (older build, odd race)
      // must not wedge autostart forever
      setTimeout(() => {
        if (!workerReady) {
          log('worker:ready never arrived — syncing anyway', 'warn')
          syncWorker()
            .then(() => autostartSaved())
            .catch((err) => {
              updateWorkerStatus(false, 'worker unavailable')
              log(err.message, 'err')
            })
        }
      }, 5000)
      break
    case 'worker:ready':
      workerReady = true
      hideNodeRequired()
      syncWorker()
        .then(() => autostartSaved().catch((err) => log('Autostart failed: ' + err.message, 'err')))
        .catch((err) => {
          updateWorkerStatus(false, 'worker unavailable')
          log('Worker ready but did not answer: ' + err.message, 'err')
        })
      break
    case 'worker:restarting':
      updateWorkerStatus(null, `restarting (attempt ${msg.data.attempt})…`)
      log(
        `Restarting service worker in ${Math.round(msg.data.delay_ms / 1000)}s (attempt ${msg.data.attempt})`
      )
      break
    case 'worker:exit':
      workerReady = false
      updateWorkerStatus(false, `worker exited (code ${msg.data.code ?? 'signal'})`)
      log(`Service worker exited with code ${msg.data.code ?? 'signal'}`, 'err')
      // the worker is gone — drop stale sessions so the UI reflects reality
      state.sessions.clear()
      state.meta.clear()
      state.revealed.clear()
      renderSessions()
      break
    case 'worker:log':
      log(msg.data.text)
      break
    case 'worker:error':
      log('Worker error: ' + msg.data.message, 'err')
      break
    case 'worker:node_missing':
      showNodeRequired()
      break
  }
}).catch((err) => log('Failed to subscribe to worker events: ' + err.message, 'err'))

/* ------------------------------ recent keys ------------------------------ */

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || []
  } catch {
    return []
  }
}

function saveRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)))
  } catch {}
}

function addRecent(label) {
  const list = loadRecent().filter((x) => x !== label)
  list.unshift(label)
  saveRecent(list)
  renderRecent()
}

function renderRecent() {
  const list = loadRecent()
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
    })
    chips.appendChild(chip)
    const opt = document.createElement('option')
    opt.value = item
    dl.appendChild(opt)
  }
}

/* ------------------------------ theme ------------------------------------ */

function applyTheme(theme) {
  document.body.dataset.theme = theme
  $('#theme-toggle').textContent = theme === 'light' ? '🌙' : '🌓'
}

function initTheme() {
  let theme = 'dark'
  try {
    theme = localStorage.getItem(THEME_KEY) || 'dark'
  } catch {}
  applyTheme(theme)
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.body.dataset.theme === 'light' ? 'dark' : 'light'
    applyTheme(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {}
  })
}

/* ------------------------------ deep links ------------------------------ */

function handleDeepLink(url) {
  if (!url.startsWith('hs://')) return
  const input = $('#connect-key')
  if (input.value === url) return // already loaded (queued + live event)
  input.value = url
  switchTab('connect')
  toast('Connection string loaded — press Connect')
  log('Loaded connection string from deep link')
}

async function stopAllTunnels() {
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

/* ------------------------------ actions ---------------------------------- */

async function startShare(event) {
  event.preventDefault()
  const button = $('#share-start')
  const isPerm = $('#share-type').value === 'perm'
  const key = $('#share-key').value.trim() || undefined
  const params = {
    port: Number($('#share-port').value),
    host: $('#share-host').value.trim() || '127.0.0.1',
    secure: $('#share-secure').checked,
    udp: $('#share-udp').checked,
    key
  }
  setBusy(button, true)
  try {
    let tunnel = null
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
        autostart: true,
        createdAt: Date.now()
      })
    }
    const session = await rpc('server:start', params, 90000)
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
    log('Failed to start server: ' + err.message, 'err')
    toast('Failed to start: ' + err.message, true)
  } finally {
    setBusy(button, false)
  }
}

async function startConnect(event) {
  event.preventDefault()
  const button = $('#connect-start')
  const portVal = $('#connect-port').value
  const params = {
    key: $('#connect-key').value.trim(),
    port: portVal ? Number(portVal) : undefined,
    host: $('#connect-host').value.trim() || undefined,
    udp: $('#connect-udp').checked
  }
  setBusy(button, true)
  try {
    let tunnel = null
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
        autostart: true,
        createdAt: Date.now()
      })
    }
    const session = await rpc('client:connect', params, 90000)
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
    log('Failed to connect: ' + err.message, 'err')
    toast('Failed to connect: ' + err.message, true)
  } finally {
    setBusy(button, false)
  }
}

/* --------------------------- saved tunnels ------------------------------ */

/// 32 random bytes as hex — a fixed key for permanent tunnels.
function genKey() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function refreshSaved() {
  try {
    state.saved = await savedList()
    renderSaved()
  } catch (err) {
    log('Failed to load saved tunnels: ' + err.message, 'err')
  }
}

/// Is there a running session for this saved tunnel?
function savedSession(t) {
  const serverUrl = t.kind === 'server' ? (t.secure === false ? 'hs://0000' : 'hs://s000') + t.key : null
  const clientKey = t.kind === 'client' ? String(t.key || '').replace(/\/+$/, '') : null
  for (const s of state.sessions.values()) {
    if (serverUrl && s.url === serverUrl) return s
    if (clientKey && s.url === clientKey) return s
  }
  return null
}

async function startSaved(t) {
  try {
    let session
    if (t.kind === 'server') {
      session = await rpc('server:start', {
        port: t.port,
        host: t.host || '127.0.0.1',
        secure: t.secure !== false, // public permanents must stay public
        udp: t.udp,
        key: t.key
      })
    } else {
      session = await rpc('client:connect', {
        key: t.key,
        port: t.port ?? undefined,
        host: t.host || undefined,
        udp: t.udp
      })
    }
    addRecent(session.url)
    log(`Started saved tunnel "${t.name}"`, 'ok')
  } catch (err) {
    toast('Failed to start: ' + err.message, true)
  }
}

async function stopSaved(t) {
  const s = savedSession(t)
  if (!s) return
  try {
    await rpc('session:stop', { id: s.id })
  } catch (err) {
    toast(err.message, true)
  }
}

async function toggleAutostart(t) {
  await savedSave({ ...t, autostart: !t.autostart })
  await refreshSaved()
  toast(!t.autostart ? 'Will restart with the app' : 'Won\'t auto-restart')
}

function renderSaved() {
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
      badge(t.kind === 'server' ? 'Server' : 'Client', t.kind),
      badge(t.secure === false ? 'Public' : 'Private', t.secure === false ? 'public' : 'secure'),
      nameSpan
    )
    const startBtn = el('button', 'saved-start', '', savedSession(t) ? 'Stop' : 'Start')
    startBtn.addEventListener('click', () => {
      if (savedSession(t)) stopSaved(t)
      else startSaved(t)
    })
    head.append(startBtn)
    item.append(head)

    const keyLine = el('code', '', '', t.kind === 'server' ? 'hs://s000' + t.key : t.key)
    const meta = el('div', 'meta')
    meta.append(metaItem('Port', t.port ?? 'auto'))
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

async function exportAllSaved() {
  try {
    const json = await savedExport()
    await copyText(json)
  } catch {
    toast('Export failed', true)
  }
}

async function applyImport() {
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
let autostartRunning = false
async function autostartSaved() {
  if (autostartRunning) return
  autostartRunning = true
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
    autostartRunning = false
  }
}

/* ------------------------------ boot ------------------------------------- */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name))
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name))
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab))
  })
}

function bindLogToggle() {
  $('#log-toggle').addEventListener('click', () => {
    const el = $('#log')
    el.classList.toggle('collapsed')
    $('#log-toggle .caret').textContent = el.classList.contains('collapsed') ? '▸' : '▾'
  })
}

function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const form = document.querySelector('.panel.active form')
      if (form) {
        e.preventDefault()
        form.requestSubmit()
      }
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.target.matches('input, textarea')) {
      if (e.key === '1') switchTab('share')
      else if (e.key === '2') switchTab('connect')
      else if (e.key === '3') switchTab('saved')
    }
  })
}

function tickUptime() {
  setInterval(() => {
    if (state.sessions.size === 0) return
    const now = Date.now()
    for (const s of state.sessions.values()) {
      const meta = state.meta.get(s.id)
      const el = document.querySelector(`#session-${s.id} .up`)
      if (meta && el) el.textContent = fmtDuration(now - meta.startedAt)
    }
    updateUptimeNote()
  }, 1000)
}

document.addEventListener('DOMContentLoaded', async () => {
  bindTabs()
  bindLogToggle()
  bindShortcuts()
  initTheme()
  renderRecent()
  // identify the installed build (version + git hash embedded at compile
  // time) — lets anyone tell two otherwise-identical builds apart
  try {
    const v = await versionInfo()
    $('#version-tag').textContent = `v${v.version} · ${v.gitHash}`
  } catch {
    $('#version-tag').textContent = 'v?'
  }
  // LAN address for the direct same-network URL on server cards (best-effort)
  try {
    state.lanIp = await lanAddress()
    renderSessions() // cards may have rendered before the fetch finished
  } catch {}
  $('#share-form').addEventListener('submit', startShare)
  $('#connect-form').addEventListener('submit', startConnect)
  bindNodeScreen()
  // tunnel type toggle reveals the name field for permanent tunnels
  $('#share-type').addEventListener('change', () => {
    $('#share-name-wrap').hidden = $('#share-type').value !== 'perm'
  })
  // save-connection checkbox reveals its name field
  $('#connect-save').addEventListener('change', () => {
    $('#connect-name-wrap').hidden = !$('#connect-save').checked
  })
  // saved panel
  $('#saved-export').addEventListener('click', exportAllSaved)
  $('#saved-import').addEventListener('click', () => {
    $('#saved-import-box').hidden = false
  })
  $('#saved-import-apply').addEventListener('click', applyImport)
  $('#saved-import-cancel').addEventListener('click', () => {
    $('#saved-import-box').hidden = true
    $('#saved-import-json').value = ''
  })
  $('#recent-clear').addEventListener('click', () => {
    saveRecent([])
    renderRecent()
  })
  $('#share-start').dataset.label = 'Start sharing'
  $('#connect-start').dataset.label = 'Connect'
  $('#worker-restart').addEventListener('click', async () => {
    const btn = $('#worker-restart')
    btn.disabled = true
    updateWorkerStatus(null, 'restarting…')
    try {
      await workerRestart()
      // wait for the fresh worker's ready handshake (max 5s), then re-sync
      const startedAt = Date.now()
      while (!workerReady && Date.now() - startedAt < 5000) {
        await new Promise((r) => setTimeout(r, 100))
      }
      await syncWorker()
      await autostartSaved()
      log('Service worker restarted manually', 'ok')
    } catch (err) {
      updateWorkerStatus(false, 'worker unavailable')
      log('Worker restart failed: ' + err.message, 'err')
    } finally {
      btn.disabled = false
    }
  })
  tickUptime()

  try {
    // wait for the worker's ready handshake (max 10s), then sync — RPCs
    // fail fast until then, so an eager boot would look like a failure
    const bootDeadline = Date.now() + 10000
    while (!workerReady && Date.now() < bootDeadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await syncWorker()
    log('Connected to holesail service worker')
    // load saved tunnels, then auto-restart the autostart ones
    await refreshSaved()
    await autostartSaved()
  } catch (err) {
    updateWorkerStatus(false, 'worker unavailable')
    log('Service worker unavailable: ' + err.message, 'err')
    // The spawn error was emitted before the webview subscribed (or never
    // emitted at all) — pull the authoritative reason from the backend.
    try {
      const diag = await workerDiagnostics()
      if (diag.last_error) log('Worker diagnostics: ' + diag.last_error, 'err')
    } catch {}
  }

  // Deep links: subscribe FIRST so live app:event links are never lost
  // while the pending-queue drain below runs.
  onAppEvent((msg) => {
    if (msg.event === 'deep-link:open') handleDeepLink(msg.data.url)
    else if (msg.event === 'tray:stop-all') stopAllTunnels()
  }).catch((err) => log('Failed to subscribe to app events: ' + err.message, 'err'))

  // URLs delivered before this listener existed are drained from the
  // pending queue. The drain retries briefly — Rust setup() may still be
  // queuing the startup URL while the webview boots.
  try {
    for (let i = 0; i < 10; i++) {
      const pending = await takePendingDeepLinks()
      if (pending.length) {
        for (const url of pending) handleDeepLink(url)
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  } catch {}
})
