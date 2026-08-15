/* sessions.js — session state transitions + the session-card rendering layer.
   Depends on state.js, ui.js, and bridge.js (rpc). Actions (share/connect/
   filemanager forms) live in actions.js; saved-tunnel CRUD in saved.js. */

import { state, flags } from './state.js'
import {
  $,
  el,
  badge,
  metaItem,
  toast,
  log,
  copyText,
  maskKey,
  fmtBytes,
  fmtDuration,
  switchTab
} from './ui.js'
import { rpc } from './bridge.js'
import { reconnectSession } from './reconnect.js'

export function upsertSession(data) {
  if (data.state === 'stopped') {
    state.sessions.delete(data.id)
    state.meta.delete(data.id)
    state.revealed.delete(data.id)
    state.traffic.delete(data.id)
    state.conn.delete(data.id)
    flags.relaySessions.delete(data.id)
  } else {
    if (data.state === 'error') {
      // the worker killed just this session after an async error — show
      // why, then the follow-up 'stopped' event removes the card
      log(`Session errored: ${data.error || 'unknown error'}`, 'err')
      // temporary tunnels don't auto-restore (only saved permanents do);
      // offer a one-click reconnect while the params are still in memory
      if (state.replay.has(data.id)) {
        log('Tunnel dropped — reconnect?', 'warn', [
          { label: '↻ Reconnect', onClick: () => reconnectSession(data.id) }
        ])
      }
    }
    const existing = state.sessions.get(data.id)
    if (existing) {
      Object.assign(existing, data) // events may carry only {id, state}
      // stats-only events (throttled traffic readout) must not trigger a
      // full card rebuild — just patch the live counters in place
      if (data.stats && data.state === undefined) {
        updateTrafficReadout(data.id)
      } else {
        renderSessions()
      }
    } else {
      state.sessions.set(data.id, { ...data })
      if (!state.meta.has(data.id)) state.meta.set(data.id, { startedAt: Date.now() })
      renderSessions()
    }
  }
}

// A peer connected to one of our server sessions. Total count lives in
// state.conn (per session); the log line is the durable record and the
// toast is rate-limited so a reconnect-happy peer doesn't spam.
// viaRelay=true means the DHT couldn't hole-punch and fell back to a
// relay — higher latency; surface it as a badge + log.
export function onPeerConnected(data) {
  const id = data && data.id
  if (!id) return
  const count = (state.conn.get(id) || 0) + 1
  state.conn.set(id, count)
  const s = state.sessions.get(id)
  const what = s && s.type === 'filemanager' ? 'folder share' : 'tunnel'
  const viaRelay = data.viaRelay
  const peer = data.peerAddr ? ' from ' + data.peerAddr : ''
  if (viaRelay) {
    flags.relaySessions.add(id)
    log(`Peer connected to ${what}${peer} (${count} total) — via relay, higher latency`, 'warn')
  } else {
    log(`Peer connected to ${what}${peer} (${count} total)`, 'ok')
  }
  const now = Date.now()
  if (now - flags.lastPeerToast > 4000) {
    flags.lastPeerToast = now
    toast(`Peer connected · ${count} total${viaRelay ? ' · via relay' : ''}`)
  }
  // the badge lives on the card; patch it in place if the card exists
  const badgeEl = document.getElementById('relay-badge-' + id)
  if (badgeEl) {
    badgeEl.hidden = !viaRelay
  }
}

/* ------------------------------ rendering -------------------------------- */

export function renderSessions() {
  const container = $('#sessions')
  if (state.sessions.size === 0) {
    // static template only — no user data interpolated, XSS-safe
    container.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-icon">🚀</div>' +
      '<p class="empty-title">No active tunnels yet</p>' +
      '<p class="empty-text">Share a local port or connect to someone else\'s tunnel to get started — no port forwarding, no static IP.</p>' +
      '<div class="empty-actions">' +
      '<button type="button" class="btn primary" id="empty-share">Share a port</button>' +
      '<button type="button" class="btn" id="empty-connect">Connect to a tunnel</button>' +
      '</div></div>'
    // CTA buttons jump to the right tab
    document.getElementById('empty-share').addEventListener('click', () => switchTab('share'))
    document.getElementById('empty-connect').addEventListener('click', () => switchTab('connect'))
    updateUptimeNote()
    return
  }
  container.innerHTML = ''
  for (const s of state.sessions.values()) renderSession(container, s)
  updateUptimeNote()
}

export function updateUptimeNote() {
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
  const type =
    s.type === 'filemanager' ? 'File manager' : s.type === 'server' ? 'Server' : 'Client'
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
  // relay-routing badge: a peer connected via the DHT relay (no direct
  // hole-punch) — higher latency than a direct path
  if (s.type === 'server' || s.type === 'filemanager') {
    const relayBadge = el('span', 'badge relay', 'relay-badge-' + s.id, '⇄ via relay')
    relayBadge.hidden = !flags.relaySessions.has(s.id)
    relayBadge.title = 'Connection routed through the DHT relay — higher latency than direct'
    head.append(relayBadge)
  }
  card.append(head)

  // body: QR (servers only) + url + meta
  const body = el('div', 'card-body')
  if (s.type === 'server' || s.type === 'filemanager') {
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
      // Targeted re-render of just this card (the QR is the expensive
      // part of a full renderSessions() rebuild); keep focus/scroll.
      const card = document.getElementById('session-' + s.id)
      if (card) {
        card.replaceChildren()
        renderSession(card, s)
      } else {
        renderSessions()
      }
    })
    urlRow.append(eye)
  }
  const copy = el('button', 'copy', '', 'Copy')
  copy.title = 'Copy connection string'
  copy.addEventListener('click', () => copyText(urlText))
  urlRow.append(copy)
  urlCol.append(urlRow)

  // filemanager sessions: show the shared directory + auth credentials
  // (Livefiles defaults to Basic auth admin/admin — the owner needs both
  // to relay to whoever they share the tunnel with). The password is a
  // credential: mask it behind the same reveal gate as the tunnel key.
  if (s.type === 'filemanager') {
    const fmRow = el('div', 'url-row')
    fmRow.append(el('code', 'local-url', '', '📁 ' + (s.dir || '')))
    if (s.fsUsername) {
      const revealed = state.revealed.has(s.id)
      const pass = revealed ? s.fsPassword || '' : '••••'
      fmRow.append(
        el(
          'span',
          '',
          '',
          `user: ${s.fsUsername} · pass: ${pass}` +
            (s.fsRole ? ` · role: ${s.fsRole}` : '')
        )
      )
    }
    urlCol.append(fmRow)
  }

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

  // Server AND filemanager sessions expose the service on the LAN — a
  // phone on the SAME network can skip the DHT entirely and hit the LAN
  // URL directly (fast, and works even when hole-punching is blocked by
  // the router). Only shown when the machine actually has a LAN address;
  // the DHT connection string above remains the universal fallback.
  if (
    (s.type === 'server' || s.type === 'filemanager') &&
    s.port &&
    state.lanIp &&
    state.lanIp !== '127.0.0.1'
  ) {
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

  // live traffic readout (from the worker's throttled session:update
  // events — counts ride the engine's own stats object, so they keep
  // working even if internal plumbing changes)
  const stats = s.stats || {}
  const trafficRow = el('div', 'traffic')
  const upSpan = el('span', 't-up', 'traffic-up-' + s.id)
  upSpan.append('▲ ', el('strong', '', '', fmtBytes(stats.bytesUp)))
  const downSpan = el('span', 't-down', 'traffic-down-' + s.id)
  downSpan.append('▼ ', el('strong', '', '', fmtBytes(stats.bytesDown)))
  trafficRow.append(upSpan, ' · ', downSpan)
  const connSpan = el('span', 't-conn', 'traffic-conn-' + s.id)
  connSpan.textContent = (stats.locCnt ? stats.locCnt + ' conn' : '') + (stats.rejectCnt ? ' · ' + stats.rejectCnt + ' rej' : '')
  if (connSpan.textContent) trafficRow.append(' · ', connSpan)
  if (s.limit) {
    trafficRow.append(' · ⏱ ' + fmtBytes(s.limit) + '/s cap')
  }
  trafficRow.title = 'Upload / download through the tunnel · live connections'

  // rolling traffic sparkline (30 samples of ~500ms each ≈ 15s window)
  const spark = el('canvas', 'spark', 'spark-' + s.id)
  spark.width = 240
  spark.height = 32
  spark.title = 'Recent throughput'
  drawSparkline(spark, s.id)
  urlCol.append(spark)
  urlCol.append(trafficRow)
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

/// Patch the traffic readout on an existing card in place (the worker
/// sends ~2 stats events/sec/session; a full renderSessions() each time
/// would rebuild QR codes and lose focus/scroll). The session record in
/// state is already updated by the caller (upsertSession's Object.assign).
function updateTrafficReadout(id) {
  const s = state.sessions.get(id)
  if (!s) return
  const stats = s.stats || {}
  const up = document.getElementById('traffic-up-' + id)
  const down = document.getElementById('traffic-down-' + id)
  const conn = document.getElementById('traffic-conn-' + id)
  if (up) up.querySelector('strong').textContent = fmtBytes(stats.bytesUp)
  if (down) down.querySelector('strong').textContent = fmtBytes(stats.bytesDown)
  if (conn) {
    const text =
      (stats.locCnt ? stats.locCnt + ' conn' : '') +
      (stats.rejectCnt ? ' · ' + stats.rejectCnt + ' rej' : '')
    conn.textContent = text
  }
  // record the per-interval delta and redraw the sparkline
  const hist = state.traffic.get(id) || { up: [], down: [] }
  const prev = state.sessions.get(id) && state.sessions.get(id).__prevStats
  const upDelta = prev ? Math.max(0, stats.bytesUp - prev.bytesUp) : 0
  const downDelta = prev ? Math.max(0, stats.bytesDown - prev.bytesDown) : 0
  hist.up.push(upDelta)
  hist.down.push(downDelta)
  if (hist.up.length > 30) hist.up.shift()
  if (hist.down.length > 30) hist.down.shift()
  state.traffic.set(id, hist)
  if (state.sessions.get(id)) state.sessions.get(id).__prevStats = { bytesUp: stats.bytesUp, bytesDown: stats.bytesDown }
  const spark = document.getElementById('spark-' + id)
  if (spark) drawSparkline(spark, id)
}

// Draw a compact dual-line sparkline of recent throughput (bytes per
// ~500ms interval). Two teal/yellow lines like the app logo; auto-scales
// to the max of both series so bursts stay visible. Dark-mode aware via
// CSS variables (read from the canvas's computed style).
function drawSparkline(canvas, id) {
  const hist = state.traffic.get(id)
  const up = hist ? hist.up : []
  const down = hist ? hist.down : []
  const ctx = canvas.getContext('2d')
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  if (!up.length && !down.length) return
  const max = Math.max(1, ...up, ...down)
  const style = getComputedStyle(canvas)
  const upColor = style.getPropertyValue('--spark-up').trim() || '#2dd4bf'
  const downColor = style.getPropertyValue('--spark-down').trim() || '#eab308'
  const draw = (series, color) => {
    if (!series.length) return
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.beginPath()
    series.forEach((v, i) => {
      const x = (i / 29) * (w - 2) + 1
      const y = h - 2 - (v / max) * (h - 4)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
  draw(up, upColor)
  draw(down, downColor)
}
