/* app.js — boot entry + UI chrome (tabs, log toolbar, shortcuts, uptime tick).
   Orchestrates the module graph: imports every feature module and wires the
   DOMContentLoaded boot sequence. Replaces the old monolithic renderer.js. */

import { state, flags } from './state.js'
import { $, log, copyText, fmtDuration, switchTab } from './ui.js'
import {
  onAppEvent,
  workerRestart,
  workerDiagnostics,
  takePendingDeepLinks,
  versionInfo,
  lanAddress,
  homeDir
} from './bridge.js'
import { initTheme } from './theme.js'
import { initRecent, renderRecent, recentClear } from './recent.js'
import { checkForUpdate } from './updater.js'
import { renderSessions, updateUptimeNote } from './sessions.js'
import { refreshSaved, exportAllSaved, applyImport, autostartSaved } from './saved.js'
import {
  startShare,
  startConnect,
  startFilemanagerShare,
  bindDropZone,
  updatePublicWarnings
} from './actions.js'
import {
  syncWorker,
  updateWorkerStatus,
  bindNodeScreen,
  subscribeWorkerEvents
} from './worker.js'
import { handleDeepLink, stopAllTunnels } from './deep.js'

/* ------------------------------ navigation ------------------------------ */

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
  // toolbar: copy the on-screen log for bug reports; clear empties the view
  // (the persistent event-log.txt keeps the full history)
  $('#log-copy').addEventListener('click', async () => {
    const lines = [...$('#log').querySelectorAll('.log-line')].map((l) => l.textContent)
    if (lines.length === 0) {
      log('Log is empty')
      return
    }
    const ok = await copyText(lines.join('\n'))
    if (ok) log('Log copied')
  })
  $('#log-clear').addEventListener('click', () => {
    $('#log').innerHTML = '<p class="empty">No events yet.</p>'
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

/* --------------------------------- boot ---------------------------------- */

document.addEventListener('DOMContentLoaded', async () => {
  bindTabs()
  bindLogToggle()
  bindShortcuts()
  initTheme()
  initRecent()
  checkForUpdate()
  // identify the installed build (version + git hash embedded at compile
  // time) — lets anyone tell two otherwise-identical builds apart; the
  // desktop-only `updater` flag gates the manual ⬆ check button
  try {
    const v = await versionInfo()
    $('#version-tag').textContent = `v${v.version} · ${v.gitHash}`
    if (v.updater) {
      const updBtn = $('#update-check')
      updBtn.hidden = false
      updBtn.addEventListener('click', () => checkForUpdate(true))
    }
  } catch {
    $('#version-tag').textContent = 'v?'
  }
  // LAN address for the direct same-network URL on server cards (best-effort)
  try {
    state.lanIp = await lanAddress()
    renderSessions() // cards may have rendered before the fetch finished
  } catch {}
  // Home directory for the folder-share broad-path guardrail
  try {
    state.homeDir = await homeDir()
  } catch {}
  $('#share-form').addEventListener('submit', startShare)
  $('#connect-form').addEventListener('submit', startConnect)
  $('#filemanager-form').addEventListener('submit', startFilemanagerShare)
  bindDropZone()
  updatePublicWarnings() // initial state (public keys from recents/deep links)
  bindNodeScreen()
  // tunnel type toggle reveals the name field for permanent tunnels
  $('#share-type').addEventListener('change', () => {
    $('#share-name-wrap').hidden = $('#share-type').value !== 'perm'
  })
  // public-mode warnings
  $('#share-secure').addEventListener('change', updatePublicWarnings)
  $('#fm-secure').addEventListener('change', updatePublicWarnings)
  $('#connect-key').addEventListener('input', updatePublicWarnings)
  // save-connection checkbox reveals its name field
  $('#connect-save').addEventListener('change', () => {
    $('#connect-name-wrap').hidden = !$('#connect-save').checked
  })
  // permanent folder share reveals name + key fields
  $('#fm-perm').addEventListener('change', () => {
    const on = $('#fm-perm').checked
    $('#fm-name-wrap').hidden = !on
    $('#fm-key-wrap').hidden = !on
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
    state.recent = []
    recentClear().catch(() => {})
    renderRecent()
  })
  // Android-only hint: boot-restart needs manual Auto-launch permission on
  // most OEMs, and the localhost-vs-127.0.0.1 browser quirk is phone-specific.
  if (/Android/i.test(navigator.userAgent)) {
    $('#android-hint').hidden = false
  }
  $('#share-start').dataset.label = 'Start sharing'
  $('#connect-start').dataset.label = 'Connect'
  $('#fm-start').dataset.label = 'Share folder'
  $('#worker-restart').addEventListener('click', async () => {
    const btn = $('#worker-restart')
    btn.disabled = true
    updateWorkerStatus(null, 'restarting…')
    try {
      await workerRestart()
      // wait for the fresh worker's ready handshake (max 5s), then re-sync
      const startedAt = Date.now()
      while (!flags.workerReady && Date.now() - startedAt < 5000) {
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

  subscribeWorkerEvents()

  try {
    // wait for the worker's ready handshake (max 10s), then sync — RPCs
    // fail fast until then, so an eager boot would look like a failure
    const bootDeadline = Date.now() + 10000
    while (!flags.workerReady && Date.now() < bootDeadline) {
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
