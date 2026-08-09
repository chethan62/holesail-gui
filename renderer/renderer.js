/* renderer.js — Holesail GUI front-end logic. Runs in the sandboxed webview;
   talks to the service worker only through the Tauri bridge (bridge.js). */

'use strict'

import {
  rpc,
  onEvent,
  workerDiagnostics,
  workerRestart,
  takePendingDeepLinks,
  onAppEvent
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
  workerOk: false
}

function upsertSession(data) {
  if (data.state === 'stopped') {
    state.sessions.delete(data.id)
    state.meta.delete(data.id)
    state.revealed.delete(data.id)
  } else {
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
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(urlText).then(
      () => toast('Connection string copied'),
      () => toast('Copy failed', true)
    )
  })
  urlRow.append(copy)
  urlCol.append(urlRow)

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

onEvent((msg) => {
  switch (msg.event) {
    case 'session:update':
      upsertSession(msg.data)
      break
    case 'worker:spawned':
      // fresh worker (boot or respawn): re-sync state
      log('Service worker started')
      syncWorker().catch((err) => {
        updateWorkerStatus(false, 'worker unavailable')
        log('Worker spawned but did not answer: ' + err.message, 'err')
      })
      break
    case 'worker:restarting':
      updateWorkerStatus(null, `restarting (attempt ${msg.data.attempt})…`)
      log(
        `Restarting service worker in ${Math.round(msg.data.delay_ms / 1000)}s (attempt ${msg.data.attempt})`
      )
      break
    case 'worker:exit':
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
  $('#connect-key').value = url
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
  const params = {
    port: Number($('#share-port').value),
    host: $('#share-host').value.trim() || '127.0.0.1',
    secure: $('#share-secure').checked,
    udp: $('#share-udp').checked,
    key: $('#share-key').value.trim() || undefined
  }
  setBusy(button, true)
  try {
    const session = await rpc('server:start', params)
    log(`Server started on ${session.host}:${session.port} (${session.protocol})`, 'ok')
    toast('Sharing started 🎉')
    addRecent(session.url)
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
    const session = await rpc('client:connect', params)
    log(`Connected to ${session.host}:${session.port} (${session.protocol})`, 'ok')
    toast('Connected')
    addRecent(params.key)
    $('#connect-key').value = ''
    $('#connect-port').value = ''
  } catch (err) {
    log('Failed to connect: ' + err.message, 'err')
    toast('Failed to connect: ' + err.message, true)
  } finally {
    setBusy(button, false)
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
  $('#share-form').addEventListener('submit', startShare)
  $('#connect-form').addEventListener('submit', startConnect)
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
      await syncWorker()
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
    await syncWorker()
    log('Connected to holesail service worker')
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

  // Deep links: URLs delivered before this listener existed are drained
  // from the pending queue; live ones arrive as app:event messages.
  try {
    const pending = await takePendingDeepLinks()
    for (const url of pending) handleDeepLink(url)
  } catch {}
  onAppEvent((msg) => {
    if (msg.event === 'deep-link:open') handleDeepLink(msg.data.url)
    else if (msg.event === 'tray:stop-all') stopAllTunnels()
  }).catch((err) => log('Failed to subscribe to app events: ' + err.message, 'err'))
})
