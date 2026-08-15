/* worker.js — worker status/lifecycle + the worker:event subscription.
   Depends on state, ui, bridge, sessions, saved. */

import { state, flags } from './state.js'
import { $, log, fmtDuration, copyText } from './ui.js'
import {
  rpc,
  onEvent,
  workerDiagnostics,
  workerRetrySpawn
} from './bridge.js'
import { upsertSession, onPeerConnected, renderSessions } from './sessions.js'
import { autostartSaved } from './saved.js'

export function updateWorkerStatus(ok, label) {
  const wasOk = state.workerOk
  state.workerOk = ok
  const dot = $('#worker-dot')
  dot.className = 'dot ' + (ok ? 'ok pulse' : ok === null ? '' : 'err')
  $('#worker-label').textContent = label
  // manual restart is only useful when the worker is down or degraded
  $('#worker-restart').hidden = ok === true
  if (ok !== true) return
  // worker-health readout (best-effort, never blocks the UI): surface
  // restart count in the label, uptime + last error as the tooltip, and
  // log a one-line recovery notice when a degraded worker comes back.
  workerDiagnostics()
    .then((diag) => {
      if (!diag) return
      const restarts = diag.restart_attempt || 0
      const lbl = $('#worker-label')
      lbl.textContent =
        restarts > 0 ? `worker online (${restarts} restart${restarts === 1 ? '' : 's'})` : 'worker online'
      const parts = []
      if (diag.uptime_ms) parts.push(`up ${fmtDuration(diag.uptime_ms)}`)
      if (restarts > 0) parts.push(`${restarts} restart${restarts === 1 ? '' : 's'}`)
      if (diag.last_error) parts.push(`last error: ${diag.last_error}`)
      lbl.title = parts.length ? parts.join(' · ') : 'worker online'
      if (!wasOk && restarts > 0) {
        log(
          `Worker recovered after ${restarts} restart${restarts === 1 ? '' : 's'}` +
            (diag.last_error ? ` — last error: ${diag.last_error}` : ''),
          'ok'
        )
      }
    })
    .catch(() => {})
}

/// Ping the worker and pull the current session list into the UI.
export async function syncWorker() {
  await rpc('ping', {})
  updateWorkerStatus(true, 'worker online')
  const sessions = await rpc('sessions:list', {})
  for (const s of sessions) upsertSession(s)
}

/* ------------------------ node-required screen ------------------------- */
// Shown when the desktop backend cannot find a Node.js runtime to run the
// worker (the bundled bare runtime is preferred; this only happens on
// dev/standalone installs without the bundle).

export function showNodeRequired() {
  updateWorkerStatus(false, 'node.js required')
  $('#node-required').hidden = false
}

export function hideNodeRequired() {
  $('#node-required').hidden = true
}

export async function retryNode() {
  if (flags.nodeRetryInFlight) return
  flags.nodeRetryInFlight = true
  const btn = $('#node-retry')
  btn.disabled = true
  try {
    await workerRetrySpawn()
    // success path flows through worker:ready — hideNodeRequired() there
  } catch (err) {
    log('Node.js still not found: ' + err.message, 'err')
    $('#node-required-msg').textContent =
      "Still can't find Node.js. Install it, then try again (restarting the app also refreshes the PATH)."
  } finally {
    btn.disabled = false
    flags.nodeRetryInFlight = false
  }
}

export function bindNodeScreen() {
  // CSP blocks in-webview navigation; copy the link instead
  $('#node-install').addEventListener('click', () => copyText('https://nodejs.org'))
  $('#node-retry').addEventListener('click', retryNode)
}

/// Subscribe to worker events once. Called from app.js at boot.
export function subscribeWorkerEvents() {
  onEvent((msg) => {
    switch (msg.event) {
      case 'session:update':
        upsertSession(msg.data)
        break
      case 'session:peer':
        // a peer connected to a server session — log + toast (rate-limited
        // to avoid toast storms from a chatty peer reconnecting)
        onPeerConnected(msg.data)
        break
      case 'worker:spawned':
        // fresh worker (boot or respawn): log only — actual syncing waits for
        // worker:ready so RPCs never race a still-initializing worker
        log('Service worker started')
        // fallback: a worker that never emits ready (older build, odd race)
        // must not wedge autostart forever
        setTimeout(() => {
          if (!flags.workerReady) {
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
        flags.workerReady = true
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
        flags.workerReady = false
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
}
