/* ui.js — DOM helpers, formatting, logging/toast, and small pure utilities.
   Depends only on `state.js` (for homeDir in the broad-path check) and the
   bridge (for log persistence). No session/action logic here. */

import { state } from './state.js'
import { logAppend } from './bridge.js'

export const $ = (sel) => document.querySelector(sel)

export const RECENT_KEY = 'holesail-gui:recent'
export const THEME_KEY = 'holesail-gui:theme'

/* ------------------------------ logging ---------------------------------- */

export function log(message, cls = '', actions = []) {
  const line = document.createElement('div')
  line.className = 'log-line ' + cls
  const stamp = `[${new Date().toLocaleTimeString()}] ${message}`
  line.textContent = stamp
  for (const a of actions) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'log-action'
    btn.textContent = a.label
    btn.addEventListener('click', a.onClick)
    line.appendChild(btn)
  }
  const el = $('#log')
  if (el.querySelector('.empty')) el.innerHTML = ''
  el.appendChild(line)
  el.scrollTop = el.scrollHeight
  // Persist so the history survives restarts (bug reports). Best-effort: a
  // missing command (mobile) or full disk must never break the UI — and that
  // includes a THROW, not just a rejected promise: without a bridge the call
  // fails synchronously and escapes the .catch below, taking the caller with
  // it (a stopped session's log line was enough to crash the renderer test).
  try {
    logAppend(stamp).catch(() => {})
  } catch {
    /* no persistence available; the on-screen log still worked */
  }
}

let toastTimer = null
export function toast(message, isError = false) {
  const el = $('#toast')
  el.textContent = message
  el.classList.toggle('err', isError)
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000)
}

// Exposed for the inline-confirm helper (below), which shares the toast
// element + timer.
export function clearToastTimer() {
  clearTimeout(toastTimer)
}
export function setToastTimer(fn, ms) {
  toastTimer = setTimeout(fn, ms)
}

export function setBusy(button, busy) {
  button.disabled = busy
  if (busy) {
    // Lazy-capture the resting label on the FIRST busy so callers don't
    // have to remember to set dataset.label. fm-start was missing it —
    // after a share its text became `undefined`, leaving a small empty
    // button (verified 2026-08-13: 28px-tall accent bar, 0 text pixels).
    if (!button.dataset.label) button.dataset.label = button.textContent
    button.textContent = 'Working…'
  } else {
    button.textContent = button.dataset.label || ''
  }
}

/* ------------------------------ clipboard -------------------------------- */

/// Copy text to the clipboard. navigator.clipboard needs a secure context
/// + permission and can be missing in some Android WebViews; fall back to
/// a hidden textarea + execCommand('copy').
export function copyText(text) {
  return new Promise((resolve) => {
    const done = (ok) => {
      toast(ok ? 'Copied' : 'Copy failed', !ok)
      resolve(ok)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => done(true),
        () => fallback(text, done)
      )
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

/* ------------------------------ formatting ------------------------------- */

export function maskKey(url) {
  if (url.length <= 16) return url
  return url.slice(0, 10) + '…' + url.slice(-8)
}

export function fmtDuration(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  const h = Math.floor(m / 60)
  return h + 'h ' + (m % 60) + 'm'
}

// Human byte count: 0 B, 1.2 KB, 3.4 MB, 5.6 GB. Rounds to whole B below
// 1 KB, one decimal from KB up.
export function fmtBytes(n) {
  n = Number(n) || 0
  if (n < 1024) return n + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let u = -1
  do {
    n /= 1024
    u++
  } while (n >= 1024 && u < units.length - 1)
  return (n >= 10 ? Math.round(n) : n.toFixed(1)) + ' ' + units[u]
}

/* ------------------------------ speed limits ----------------------------- */

/// Read a speed-limit input (KB/s) → bytes/sec for the worker. Empty/0 →
/// 0 (unlimited). Clamped to a sane ceiling (1 GB/s) so a typo can't set a
/// nonsense value. Lives here (not in actions.js) because BOTH the
/// per-tunnel forms and the all-tunnels limit (limit.js) need it — features
/// never import each other.
export function readLimit(sel) {
  const v = $(sel).value.trim()
  if (!v) return 0
  const kb = Number(v)
  if (!Number.isFinite(kb) || kb <= 0) return 0
  return Math.min(Math.round(kb * 1024), 1024 * 1024 * 1024)
}

/* --------------------------- broad-path guard --------------------------- */

/// True when `path` is the filesystem root, a home directory, or a home
/// dir's immediate children — the sort of thing a fat-fingered share could
/// accidentally expose over the DHT. Cross-platform (POSIX + Windows drive
/// roots); never throws on weird input.
export function isBroadSharePath(p) {
  const raw = String(p || '').trim()
  if (!raw) return false
  // filesystem root: "/", "\", "C:\", "C:/" — check BEFORE trimming
  // trailing slashes, since a bare root trims down to '' and would
  // otherwise fall through the empty-string guard below untested.
  if (raw === '/' || raw === '\\' || /^[a-zA-Z]:[\\/]?$/.test(raw)) return true
  const s = raw.replace(/[\\/]+$/, '')
  if (!s) return false
  // home dir itself
  const home = (state.homeDir || '').replace(/[\\/]+$/, '')
  if (home && (s === home || s.toLowerCase() === home.toLowerCase()))
    return true
  // HIDDEN entries directly in home (~/.ssh, ~/.gnupg) are secrets; other home
  // children are the named folders users actually share. Treating every child
  // as broad refused ordinary folders and contradicted the guard's own advice
  // to "share a specific subfolder instead" (see worker/guards.js).
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  if (home && idx > 0) {
    const parent = s.slice(0, idx)
    const child = s.slice(idx + 1)
    if (
      child.startsWith('.') &&
      (parent === home || parent.toLowerCase() === home.toLowerCase())
    )
      return true
  }
  return false
}

/// Yes/No confirm as a dismissable toast with two buttons — native
/// confirm() is unreliable in Android WebView, and the answer must be
/// awaitable. Resolves true on Yes, false on No / auto-dismiss after 10s.
export function confirmInline(message) {
  return new Promise((resolve) => {
    const toastEl = $('#toast') // NOT the el() builder — avoid shadowing it
    toastEl.classList.remove('hidden', 'err')
    toastEl.innerHTML = ''
    const span = el('span', 'confirm-msg', '', message)
    const yes = el('button', 'confirm-yes', '', 'Yes')
    const no = el('button', 'confirm-no', '', 'No')
    toastEl.append(span, yes, no)
    clearToastTimer()
    const done = (val) => {
      clearToastTimer()
      toastEl.classList.add('hidden')
      resolve(val)
    }
    yes.addEventListener('click', () => done(true), { once: true })
    no.addEventListener('click', () => done(false), { once: true })
    setToastTimer(() => done(false), 10000)
  })
}

/* --------------------------- DOM element builders ------------------------ */
/* All text goes through textContent so untrusted values (connection strings,
   hosts, log lines) can never inject HTML. */

export function el(tag, className = '', id = '', text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (id) node.id = id
  if (text !== '') node.textContent = text
  return node
}

export function metaItem(label, value) {
  const span = el('span')
  span.append(label + ': ', el('strong', '', '', String(value ?? '—')))
  return span
}

export function badge(text, kind) {
  return el('span', 'badge ' + kind, '', text)
}

/* ------------------------------ navigation ------------------------------ */

export function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.tab === name
    t.classList.toggle('active', active)
    // A tab that never announces its selection is invisible to AT-SPI: the
    // panels were always shown/hidden correctly, the STATE was not exposed at
    // all. All tabs stay tabbable on purpose — the app's keyboard navigation is
    // numeric (1-4), so roving tabindex without arrow keys would remove tabs
    // from the tab order instead of improving it.
    t.setAttribute('aria-selected', String(active))
  })
  document
    .querySelectorAll('.panel')
    .forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name))
}

/* --------------------------- public-mode warning ------------------------- */

// Show/hide the public-mode warning banners. Share + folder forms warn
// when Private mode is unchecked; the Connect form warns when the pasted
// key is a public hs://0000… string. Lives here (pure DOM, no rpc/state)
// so recent.js / deep.js / actions.js can all use it without a cycle.
export function updatePublicWarnings() {
  $('#share-public-warn').hidden = $('#share-secure').checked
  $('#fm-public-warn').hidden = $('#fm-secure').checked
  const key = $('#connect-key').value.trim()
  $('#connect-public-warn').hidden = !key.startsWith('hs://0000')
}
