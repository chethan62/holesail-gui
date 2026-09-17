/* limiter.js — per-session token-bucket bandwidth cap. Depends on
 * runtime.js + state.js.
 *
 * A single bucket caps COMBINED upload+download (the use case behind the
 * feature: "a busy tunnel can saturate my link"). The data-boundary
 * wrappers in stats.js call consume()/pauseForLimit()/queueWrite() here.
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

function limiterFor(entry) {
  if (!entry._lim)
    entry._lim = {
      tokens: 0,
      last: 0,
      queue: [],
      queued: 0,
      overflowed: false,
      paused: [],
      timer: null
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

function startLimitTicker(entry) {
  const lim = limiterFor(entry)
  if (lim.timer) return
  lim.last = Date.now()
  const tick = () => {
    if (!entry.limit || !sessions.has(entry.id)) {
      lim.timer = null
      return
    }
    const now = Date.now()
    // bucket caps at 1s worth of budget; partial-write draining below
    // guarantees no chunk ever deadlocks the queue
    lim.tokens = Math.min(
      entry.limit,
      lim.tokens + (entry.limit * (now - lim.last)) / 1000
    )
    lim.last = now
    // drain queued writes (partial writes for chunks larger than budget)
    while (lim.queue.length && lim.tokens > 0) {
      const q = lim.queue[0]
      if (q.len <= lim.tokens) {
        lim.queue.shift()
        lim.tokens -= q.len
        lim.queued -= q.len
        try {
          q.fn(q.buf, ...q.rest)
        } catch {}
      } else {
        const take = Math.floor(lim.tokens)
        lim.tokens = 0
        lim.queued -= take
        const isBuf = Buffer.isBuffer(q.buf)
        const head = isBuf
          ? q.buf.subarray(0, take)
          : String(q.buf).slice(0, take)
        q.buf = isBuf ? q.buf.subarray(take) : String(q.buf).slice(take)
        q.len -= take
        try {
          q.fn(head, ...q.rest)
        } catch {}
      }
    }
    // resume paused source streams now that budget is available
    if (lim.paused.length && lim.tokens > 0) {
      for (const s of lim.paused) {
        try {
          s.resume()
        } catch {}
      }
      lim.paused = []
    }
    lim.timer = setTimeout(tick, 200)
  }
  lim.timer = setTimeout(tick, 200)
}

function stopLimitTicker(entry) {
  const lim = entry._lim
  if (!lim) return
  if (lim.timer) {
    clearTimeout(lim.timer)
    lim.timer = null
  }
  // unlimited: flush anything queued and un-pause everything immediately
  while (lim.queue.length) {
    const q = lim.queue.shift()
    lim.queued -= q.len
    try {
      q.fn(q.buf, ...q.rest)
    } catch {}
  }
  lim.queued = 0
  for (const s of lim.paused) {
    try {
      s.resume()
    } catch {}
  }
  lim.paused = []
}

module.exports = {
  MAX_QUEUE_BYTES,
  limiterFor,
  queueWrite,
  startLimitTicker,
  stopLimitTicker
}
