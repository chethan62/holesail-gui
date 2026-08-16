/* limiter.js — per-session token-bucket bandwidth cap. Depends on
 * runtime.js + state.js.
 *
 * A single bucket caps COMBINED upload+download (the use case behind the
 * feature: "a busy tunnel can saturate my link"). The data-boundary
 * wrappers in stats.js call consume()/pauseForLimit()/queueWrite() here.
 */

const { Buffer } = require('./runtime.js')
const { sessions } = require('./state.js')

function limiterFor(entry) {
  if (!entry._lim) entry._lim = { tokens: 0, last: 0, queue: [], paused: [], timer: null }
  return entry._lim
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
    lim.tokens = Math.min(entry.limit, lim.tokens + (entry.limit * (now - lim.last)) / 1000)
    lim.last = now
    // drain queued writes (partial writes for chunks larger than budget)
    while (lim.queue.length && lim.tokens > 0) {
      const q = lim.queue[0]
      if (q.len <= lim.tokens) {
        lim.queue.shift()
        lim.tokens -= q.len
        try { q.fn(q.buf, ...q.rest) } catch {}
      } else {
        const take = Math.floor(lim.tokens)
        lim.tokens = 0
        const head = Buffer.isBuffer(q.buf) ? q.buf.subarray(0, take) : String(q.buf).slice(0, take)
        q.buf = Buffer.isBuffer(q.buf) ? q.buf.subarray(take) : String(q.buf).slice(take)
        q.len -= take
        try { q.fn(head, ...q.rest) } catch {}
      }
    }
    // resume paused source streams now that budget is available
    if (lim.paused.length && lim.tokens > 0) {
      for (const s of lim.paused) {
        try { s.resume() } catch {}
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
    try { q.fn(q.buf, ...q.rest) } catch {}
  }
  for (const s of lim.paused) {
    try { s.resume() } catch {}
  }
  lim.paused = []
}

module.exports = { limiterFor, startLimitTicker, stopLimitTicker }
