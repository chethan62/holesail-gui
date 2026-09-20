/* sessions.js — session state transitions + the session-card rendering layer.
   Depends on state.js, ui.js, and bridge.js (rpc). Actions (share/connect/
   filemanager forms) live in actions.js; saved-tunnel CRUD in saved.js. */

import { state, flags, dropSession } from './state.js'
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
import { withCredentials } from './invite.js'

export function upsertSession(data) {
  if (data.state === 'stopped') {
    // Say so in the log. The card leaves and the local proxy port is released,
    // but nothing was written — so a stop read as silence, which is how "Stop did
    // nothing" looks to a user even when it worked. Measured: the port is freed
    // within seconds while the log stayed empty, so this line is the difference
    // between "it worked" and "nothing happened".
    const gone = state.sessions.get(data.id)
    if (gone) {
      const what =
        gone.type === 'client'
          ? `Client on localhost:${gone.port}`
          : gone.type === 'filemanager'
            ? `Folder share${gone.dir ? ` (${gone.dir})` : ''}`
            : `Tunnel on port ${gone.port}`
      log(`${what} stopped`)
    }
    // Everything else the renderer remembers about this session — including the
    // replay params that hold its key, and its share credentials. See
    // dropSession for why this must not be a hand-written list of maps:
    // `replay` was the one it forgot, so it grew without bound.
    dropSession(data.id)
    // Re-render: the card is gone from state, so it must leave the screen too.
    // Without this the stopped session lingers until some unrelated event
    // happens to rebuild the list — which reads as "Stop did nothing".
    renderSessions()
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
      if (!state.meta.has(data.id))
        state.meta.set(data.id, { startedAt: Date.now() })
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
    log(
      `Peer connected to ${what}${peer} (${count} total) — via relay, higher latency`,
      'warn'
    )
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
    document
      .getElementById('empty-share')
      .addEventListener('click', () => switchTab('share'))
    document
      .getElementById('empty-connect')
      .addEventListener('click', () => switchTab('connect'))
    updateUptimeNote()
    return
  }
  container.innerHTML = ''
  for (const s of state.sessions.values()) renderSession(container, s)
  updateUptimeNote()
}

export function updateUptimeNote() {
  const note = $('#uptime-note')
  // the all-tunnels cap is worth showing here: it silently shapes every
  // session, so "why is this slow?" has an answer on screen
  const cap = state.globalLimit
    ? ` · ⏱ ${fmtBytes(state.globalLimit)}/s total`
    : ''
  if (state.sessions.size === 0) {
    note.textContent = '—' + cap
    return
  }
  const ages = [...state.meta.values()].map((m) => Date.now() - m.startedAt)
  const oldest = ages.length ? fmtDuration(Math.min(...ages)) : ''
  note.textContent =
    `${state.sessions.size} session${state.sessions.size > 1 ? 's' : ''} · up ${oldest}` +
    cap
}

function renderSession(container, s) {
  const card = el('div', 'session', 'session-' + s.id)
  const type =
    s.type === 'filemanager'
      ? 'File manager'
      : s.type === 'server'
        ? 'Server'
        : 'Client'
  const mode = s.secure ? 'Private' : 'Public'
  const isPaused = s.state === 'paused'
  const meta = state.meta.get(s.id)
  const uptime = meta ? fmtDuration(Date.now() - meta.startedAt) : ''

  // A filemanager session's invite link carries its credentials in the
  // fragment, so the receiver is logged in on arrival instead of having to
  // guess that the username is "admin" and retype a random password. The
  // displayed form still respects the reveal gate; the QR and the copy button
  // hand out the actionable link.
  const urlText = withCredentials(s.url || '', s.fsUsername, s.fsPassword)
  const displayUrl =
    s.secure && !state.revealed.has(s.id) ? maskKey(urlText) : urlText

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
    const relayBadge = el(
      'span',
      'badge relay',
      'relay-badge-' + s.id,
      '⇄ via relay'
    )
    relayBadge.hidden = !flags.relaySessions.has(s.id)
    relayBadge.title =
      'Connection routed through the DHT relay — higher latency than direct'
    head.append(relayBadge)
  }
  card.append(head)

  // One reveal path for the whole card: the eye beside the URL and the QR
  // placeholder both call this, so the two can never disagree. It has to be
  // declared at card scope — the eye lives outside the server/filemanager block
  // that renders the QR, and a helper scoped inside it is a ReferenceError.
  // The QR encodes the same secret as the invite link, so it stays behind the
  // gate; the placeholder just must not be a dead end.
  const toggleReveal = () => {
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
  }

  // body: QR (servers only) + url + meta
  const body = el('div', 'card-body')
  if (s.type === 'server' || s.type === 'filemanager') {
    const qrBox = el('div', 'qr')
    if (s.secure && !state.revealed.has(s.id)) {
      qrBox.append(
        el('span', 'qr-hint', '', 'QR hidden while the key is masked')
      )
      const showQr = el('button', 'qr-show', '', 'Show QR')
      showQr.type = 'button'
      showQr.addEventListener('click', toggleReveal)
      qrBox.append(showQr)
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
    eye.addEventListener('click', toggleReveal) // the same path as the QR button
    urlRow.append(eye)
  }
  const copy = el('button', 'copy', '', 'Copy invite link')
  copy.title = 'Copy the invite link — send it to whoever needs access'
  copy.addEventListener('click', () => copyText(urlText))
  urlRow.append(copy)
  urlCol.append(urlRow)
  urlCol.append(
    el(
      'p',
      'hint',
      '',
      'Send this link to whoever needs access, then stop the tunnel here when done.'
    )
  )

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
      // One click to hand the password over: it is a random 16-character
      // string, and the username is Livefiles' "admin" default, so the pair
      // was previously unguessable and untypable in equal measure.
      const copyPass = el('button', 'copy', '', 'Copy password')
      copyPass.title = 'Copy the share password'
      copyPass.addEventListener('click', () => copyText(s.fsPassword || ''))
      fmRow.append(copyPass)
    }
    urlCol.append(fmRow)
  }

  // Client sessions expose a local HTTP proxy. Android Chrome refuses
  // literal 127.0.0.1 in some cases, but `localhost` always resolves to
  // the app's tunnel — hand out the URL that actually works.
  if (s.type === 'client' && s.port) {
    // Credentials carried by the invite link ride in the URL's userinfo:
    // a Chromium navigation to http://user:pass@host/ authenticates without
    // raising its Basic-auth prompt (measured), which is the only way "scan
    // and you are in" can work, since the local proxy is the engine's and
    // cannot inject an Authorization header. The displayed form stays masked
    // behind the reveal; Copy URL hands over the version that logs in.
    //
    // Two sources, because they arrive by different routes: the worker reports
    // the owner's own filemanager session with fsUsername/fsPassword, while a
    // RECEIVER's pair comes out of the invite link's fragment and lives in the
    // replay params that startConnect stores. Reading only the session produced
    // a bare http://localhost:port/ for a scanned link, and the fetch through it
    // answered 401 — measured against a live share, which is also the negative
    // control that proves the folder really is protected.
    const sent = state.replay.get(s.id)?.params
    const user = s.fsUser || sent?.fsUser
    const pass = s.fsPass || sent?.fsPass
    const plainUrl = 'http://localhost:' + s.port + '/'
    const localUrl =
      user && pass
        ? 'http://' +
          encodeURIComponent(user) +
          ':' +
          encodeURIComponent(pass) +
          '@localhost:' +
          s.port +
          '/'
        : plainUrl
    const shownUrl =
      user && pass && !state.revealed.has(s.id) ? plainUrl : localUrl
    const localRow = el('div', 'url-row')
    localRow.append(el('code', 'local-url', '', shownUrl))
    const copyUrl = el('button', 'copy', '', 'Copy URL')
    copyUrl.title = user && pass ? 'Copy local URL (logs in)' : 'Copy local URL'
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
  connSpan.textContent =
    (stats.locCnt ? stats.locCnt + ' conn' : '') +
    (stats.rejectCnt ? ' · ' + stats.rejectCnt + ' rej' : '')
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
  const stop = el(
    'button',
    'stop',
    '',
    s.type === 'server' ? 'Stop sharing' : 'Disconnect'
  )
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
  if (up) {
    const s = up.querySelector('strong')
    if (s) s.textContent = fmtBytes(stats.bytesUp)
  }
  if (down) {
    const s = down.querySelector('strong')
    if (s) s.textContent = fmtBytes(stats.bytesDown)
  }
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
  if (state.sessions.get(id))
    state.sessions.get(id).__prevStats = {
      bytesUp: stats.bytesUp,
      bytesDown: stats.bytesDown
    }
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
