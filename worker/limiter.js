/* limiter.js — bandwidth caps: one token bucket per session, plus one
 * bucket shared by every tunnel. Depends on runtime.js + state.js.
 *
 * A bucket caps COMBINED upload+download for whatever it governs (the use
 * case behind the feature: "a busy tunnel can saturate my link"). The
 * global bucket is what makes a SECOND tunnel not simply add its own
 * allowance on top: bytes move only when BOTH the session's bucket and the
 * shared one have budget, so N tunnels share one link budget.
 *
 * The data-boundary wrappers in stats.js drive all of this through
 * limitConsume() / queueWrite() / the ticker's drain. Reads are paced by
 * pausing the source stream (pauseForLimit in stats.js), writes by the
 * queue.
 */

const { Buffer } = require('./runtime.js')
const { sessions } = require('./state.js')

// The engine's TCP piper (connPiper in @holesail/hyper-cmd-lib-net) calls
// `dest.write(chunk)` and IGNORES the return value, so a producer faster
// than the cap cannot be paused — every byte it writes lands in `queue`.
// Measured: one 64 MiB burst through a 20 KiB/s cap grew the worker's RSS
// by 75 MiB while only 15 KiB reached the app. A big file (Jellyfin movie,
// multi-GB upload) would buffer to OOM. So the queue is bounded: past the
// ceiling the session is stopped with an actionable error instead of
// buffering the desktop app to death (see queueWrite + stats.js).
// ponytail: constant ceiling; make it a per-session setting if anyone
// genuinely needs a deeper burst behind a slow cap.
const MAX_QUEUE_BYTES = 16 * 1024 * 1024

// The all-tunnels budget (0 = no global cap). Shared state, like `sessions`.
const global = { limit: 0, tokens: 0, last: 0, timer: null }

/// KB/s input (or anything) -> bytes/sec; junk and negatives mean "no cap".
function normalizeLimit(limit) {
  if (limit === undefined || limit === null || limit === '') return 0
  const n = Number(limit)
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

function limiterFor(entry) {
  if (!entry._lim)
    entry._lim = {
      tokens: 0,
      last: 0,
      queue: [],
      queued: 0,
      overflowed: false,
      paused: [],
      timer: null,
      pendingEnd: null
    }
  return entry._lim
}

// Buffer one rejected write. Returns false when that would push the
// backlog past MAX_QUEUE_BYTES — the caller must stop the session instead
// of queueing (it can't slow the producer down).
function queueWrite(entry, item) {
  const lim = limiterFor(entry)
  if (lim.queued + item.len > MAX_QUEUE_BYTES) return false
  lim.queue.push(item)
  lim.queued += item.len
  return true
}

/// Hold a stream end until the queue has drained. The engine's piper relays
/// 'end' straight through to the far socket, so without this a burst that
/// finishes while chunks are still queued would be written AFTER end() —
/// and Node drops writes-after-end silently: a capped download would look
/// like a clean but truncated response. Found by the global-cap test, which
/// is the first case that sends a full payload and then closes.
function queueEnd(entry, fn) {
  limiterFor(entry).pendingEnd = fn
  return true
}

function releaseEnd(lim) {
  if (!lim.pendingEnd || lim.queue.length) return
  const endFn = lim.pendingEnd
  lim.pendingEnd = null
  try {
    endFn()
  } catch {}
}

/* ------------------------------- budgets -------------------------------- */

function getGlobalLimit() {
  return global.limit
}

/// Budget this session may use right now: the smaller of its own bucket and
/// the shared one (Infinity for whichever isn't capped).
function limitTokens(entry) {
  const own = entry.limit ? limiterFor(entry).tokens : Infinity
  const shared = global.limit ? global.tokens : Infinity
  return Math.min(own, shared)
}

function chargeTokens(entry, n) {
  if (entry.limit) limiterFor(entry).tokens -= n
  if (global.limit) global.tokens -= n
}

/// May `n` bytes move now? Charges both buckets when the answer is yes.
function limitConsume(entry, n) {
  if (!entry.limit && !global.limit) return true
  if (limitTokens(entry) < n) return false
  chargeTokens(entry, n)
  return true
}

/* ------------------------------- tickers -------------------------------- */

function startGlobalTicker() {
  if (global.timer || !global.limit) return
  global.last = Date.now()
  const tick = () => {
    if (!global.limit) {
      global.timer = null
      return
    }
    const now = Date.now()
    // refill only — the per-session tickers below are what drain queues and
    // resume paused streams, against BOTH buckets
    global.tokens = Math.min(
      global.limit,
      global.tokens + (global.limit * (now - global.last)) / 1000
    )
    global.last = now
    global.timer = setTimeout(tick, 200)
  }
  global.timer = setTimeout(tick, 200)
}

/// Set (or clear, with 0) the budget shared by every tunnel. Returns the
/// applied bytes/sec. Live: existing sessions start draining under it
/// immediately, and sessions with no cap of their own get a ticker (they
/// had no reason for one before).
function setGlobalLimit(bytes) {
  global.limit = normalizeLimit(bytes)
  // a change must not hand out a stale burst from the old setting
  global.tokens = 0
  global.last = Date.now()
  if (global.limit) startGlobalTicker()
  else if (global.timer) {
    clearTimeout(global.timer)
    global.timer = null
  }
  for (const entry of sessions.values()) startLimitTicker(entry)
  return global.limit
}

function startLimitTicker(entry) {
  const lim = limiterFor(entry)
  if (lim.timer) return
  lim.last = Date.now()
  const tick = () => {
    // Nothing left to enforce (session gone, or its cap and the global one
    // are both off): flush what a cap held back and stop. setGlobalLimit
    // re-arms every session when a global cap appears.
    if (!sessions.has(entry.id) || (!entry.limit && !global.limit)) {
      lim.timer = null
      stopLimitTicker(entry)
      return
    }
    const now = Date.now()
    if (entry.limit) {
      // bucket caps at 1s worth of budget; the partial drain below
      // guarantees no chunk ever deadlocks the queue
      lim.tokens = Math.min(
        entry.limit,
        lim.tokens + (entry.limit * (now - lim.last)) / 1000
      )
    }
    lim.last = now
    // drain queued writes — a chunk leaves only when BOTH budgets allow it
    // (partial writes for chunks larger than the available budget)
    const drained = new Set()
    while (lim.queue.length) {
      const avail = Math.floor(limitTokens(entry))
      if (avail <= 0) break
      const q = lim.queue[0]
      const take = Math.min(q.len, avail)
      const isBuf = Buffer.isBuffer(q.buf)
      const head =
        take === q.len
          ? q.buf
          : isBuf
            ? q.buf.subarray(0, take)
            : String(q.buf).slice(0, take)
      if (take === q.len) {
        lim.queue.shift()
        if (q.stream) drained.add(q.stream)
      } else {
        q.buf = isBuf ? q.buf.subarray(take) : String(q.buf).slice(take)
        q.len -= take
      }
      lim.queued -= take
      chargeTokens(entry, take)
      try {
        q.fn(head, ...q.rest)
      } catch {}
    }
    // A queued write returns false to the producer, which the pipe honours by
    // PAUSING it — but Node only emits 'drain' after a real write, so a stream
    // whose backlog we just drained here would stay paused forever (observed:
    // a capped download stopped dead after the first 16 KB). Emit the resume
    // signal ourselves once nothing of that stream is left in the queue.
    // ponytail: per-tick drain only, no per-chunk scheduling — a source is
    // paused for at most one tick past its backlog.
    if (drained.size) {
      const pending = new Set(lim.queue.map((q) => q.stream))
      for (const s of drained) {
        if (pending.has(s)) continue
        try {
          s.emit('drain')
        } catch {}
      }
    }
    // resume paused source streams now that budget is available
    if (lim.paused.length && limitTokens(entry) > 0) {
      for (const s of lim.paused) {
        try {
          s.resume()
        } catch {}
      }
      lim.paused = []
    }
    // an end that arrived while chunks were still queued goes out last
    releaseEnd(lim)
    lim.timer = setTimeout(tick, 200)
  }
  lim.timer = setTimeout(tick, 200)
}

/// Stop pacing this session and let everything it was holding back through
/// (session stopped, or its caps were cleared).
function stopLimitTicker(entry) {
  const lim = entry._lim
  if (!lim) return
  if (lim.timer) {
    clearTimeout(lim.timer)
    lim.timer = null
  }
  // unlimited: flush anything queued and un-pause everything immediately
  const flushed = new Set()
  while (lim.queue.length) {
    const q = lim.queue.shift()
    lim.queued -= q.len
    if (q.stream) flushed.add(q.stream)
    try {
      q.fn(q.buf, ...q.rest)
    } catch {}
  }
  lim.queued = 0
  for (const s of flushed) {
    try {
      s.emit('drain')
    } catch {}
  }
  releaseEnd(lim)
  for (const s of lim.paused) {
    try {
      s.resume()
    } catch {}
  }
  lim.paused = []
}

module.exports = {
  MAX_QUEUE_BYTES,
  normalizeLimit,
  limiterFor,
  queueWrite,
  queueEnd,
  limitConsume,
  limitTokens,
  getGlobalLimit,
  setGlobalLimit,
  startLimitTicker,
  stopLimitTicker
}
