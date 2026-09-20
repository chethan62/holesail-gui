/* units.test.js — fast unit tests for the worker's pure modules: the stdout
 * transport and the bandwidth limiter.
 *
 * The DHT suite (service.test.js) takes minutes and needs a live network, so a
 * regression in the frame format or the accounting is expensive to catch
 * there. These run in milliseconds against a fake stdout and hand-built
 * entries, and run under BOTH node and the bundled bare runtime (test:bare).
 */

const assert = require('assert')

const runtime = require('../worker/runtime.js')
const transport = require('../worker/transport.js')
const limiter = require('../worker/limiter.js')

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
}

/// Run fn with process.stdout.write captured, and return what it wrote.
function capture(fn) {
  const out = []
  const p = runtime.process
  const original = p.stdout.write
  p.stdout.write = (s) => {
    out.push(s)
    return true
  }
  try {
    fn()
  } finally {
    p.stdout.write = original
  }
  return out.join('')
}

console.log('\ntransport (the single path every event and reply shares)')

check(
  'a circular payload still produces a parseable reply, keeping its id',
  () => {
    const circ = {}
    circ.self = circ
    const wire = capture(() => transport.sendResult('r1', circ))
    const frame = JSON.parse(wire.trim())
    assert.strictEqual(
      frame.id,
      'r1',
      'the reply must keep its id or the caller just times out'
    )
    assert.ok(
      /un-serialisable/.test(frame.error),
      `expected an error frame, got: ${wire}`
    )
  }
)

check('a circular event degrades to an error event instead of throwing', () => {
  const circ = {}
  circ.self = circ
  const wire = capture(() => transport.sendEvent('session:update', circ))
  const frame = JSON.parse(wire.trim())
  assert.strictEqual(frame.event, 'worker:error')
  assert.ok(/un-serialisable/.test(frame.data.message), wire)
})

check('ordinary frames are byte-for-byte unchanged', () => {
  const wire = capture(() => transport.sendResult('r2', { ok: true }))
  assert.deepStrictEqual(JSON.parse(wire.trim()), {
    id: 'r2',
    result: { ok: true }
  })
  assert.ok(wire.endsWith('\n'), 'every frame is newline-terminated')
})

console.log('\nlimiter (bandwidth caps)')

check('normalizeLimit maps junk to "no cap" and keeps real numbers', () => {
  for (const junk of [undefined, null, '', -1, 'abc', NaN, Infinity]) {
    assert.strictEqual(
      limiter.normalizeLimit(junk),
      0,
      `${junk} should mean no cap`
    )
  }
  assert.strictEqual(limiter.normalizeLimit(512), 512)
  assert.strictEqual(limiter.normalizeLimit('2048'), 2048)
})

check('queueWrite refuses past the ceiling instead of buffering to OOM', () => {
  const entry = { id: 'q1', limit: 0 }
  const half = Math.floor(limiter.MAX_QUEUE_BYTES / 2)
  const item = (len) => ({
    len,
    buf: Buffer.alloc(len),
    fn: () => {},
    rest: []
  })
  assert.strictEqual(limiter.queueWrite(entry, item(half)), true)
  assert.strictEqual(limiter.queueWrite(entry, item(half)), true)
  assert.strictEqual(
    limiter.queueWrite(entry, item(1)),
    false,
    'a third write must be refused'
  )
  // a single oversized chunk is refused too, not partially accepted
  const other = { id: 'q2', limit: 0 }
  assert.strictEqual(
    limiter.queueWrite(other, item(limiter.MAX_QUEUE_BYTES + 1)),
    false
  )
})

check(
  'a string payload is queued as bytes, so the drain cannot split a character',
  () => {
    const entry = { id: 'q3', limit: 0 }
    const text = 'héllo 🎉 世界'
    // len deliberately wrong (UTF-16 units, as String.length would give)
    assert.strictEqual(
      limiter.queueWrite(entry, {
        len: text.length,
        buf: text,
        fn: () => {},
        rest: []
      }),
      true
    )
    const queued = limiter.limiterFor(entry).queue[0]
    assert.ok(
      Buffer.isBuffer(queued.buf),
      'a string payload must be converted to a Buffer'
    )
    assert.strictEqual(
      queued.len,
      Buffer.byteLength(text, 'utf8'),
      'len must be a byte count'
    )
    assert.strictEqual(queued.buf.toString('utf8'), text)
  }
)

check("both directions' ends survive and follow their bytes", () => {
  const entry = { id: 'q4', limit: 0 }
  const order = []
  limiter.queueWrite(entry, {
    len: 8,
    buf: Buffer.alloc(8),
    fn: () => order.push('chunk'),
    rest: [],
    stream: null
  })
  limiter.queueEnd(entry, () => order.push('end-a'))
  limiter.queueEnd(entry, () => order.push('end-b'))
  // stopLimitTicker flushes the queue then releases every held end
  limiter.stopLimitTicker(entry)
  assert.deepStrictEqual(
    order,
    ['chunk', 'end-a', 'end-b'],
    'the second end used to overwrite the first'
  )
})

check(
  'limitConsume: uncapped passes free, capped charges and then refuses',
  () => {
    const free = { id: 'f1', limit: 0 }
    assert.strictEqual(
      limiter.limitConsume(free, 1e12),
      true,
      'no cap = no accounting'
    )

    const capped = { id: 'c1', limit: 1000 }
    limiter.limiterFor(capped).tokens = 500
    assert.strictEqual(limiter.limitConsume(capped, 400), true)
    assert.strictEqual(
      limiter.limiterFor(capped).tokens,
      100,
      'a move charges the bucket'
    )
    assert.strictEqual(
      limiter.limitConsume(capped, 400),
      false,
      'more than the budget is refused'
    )
    assert.strictEqual(
      limiter.limiterFor(capped).tokens,
      100,
      'a refusal must not charge'
    )
  }
)

check(
  'the shared bucket governs sessions that have no cap of their own',
  () => {
    const entry = { id: 'g1', limit: 0 }
    assert.strictEqual(
      limiter.limitTokens(entry),
      Infinity,
      'nothing capped = unlimited'
    )
    limiter.setGlobalLimit(2000)
    try {
      // a global cap alone must bind every session, which is the whole point of
      // the shared bucket: N tunnels cannot each get their own allowance
      assert.strictEqual(limiter.limitTokens(entry), 0)
    } finally {
      limiter.setGlobalLimit(0)
    }
    assert.strictEqual(
      limiter.limitTokens(entry),
      Infinity,
      'clearing the cap releases it'
    )
  }
)

console.log('\nguards (what must never be shared)')

check(
  'refuses filesystem roots, the home dir itself, and hidden entries in it',
  () => {
    const guards = require('../worker/guards.js')
    for (const p of ['/', '\\', 'C:\\', 'C:/']) {
      assert.strictEqual(
        guards.isBroadSharePath(p),
        true,
        `${p} is a filesystem root`
      )
    }
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (!home) return
    assert.strictEqual(
      guards.isBroadSharePath(home),
      true,
      'the home dir itself'
    )
    assert.strictEqual(
      guards.isBroadSharePath(home + '/.ssh'),
      true,
      'a hidden entry holds secrets'
    )
    assert.strictEqual(
      guards.isBroadSharePath(home + '/.aws/'),
      true,
      'trailing slash and all'
    )
  }
)

check(
  'a named subfolder of home stays shareable (the point of the guard fix)',
  () => {
    const guards = require('../worker/guards.js')
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (!home) return
    assert.strictEqual(guards.isBroadSharePath(home + '/SAP_fico_doc'), false)
    assert.strictEqual(
      guards.isBroadSharePath(home + '/SAP_fico_doc/sub'),
      false
    )
    assert.strictEqual(
      guards.isBroadSharePath(''),
      false,
      'an empty path is not "broad"'
    )
  }
)

check('an unknown home does not make the hidden-entry guard a no-op', () => {
  const guards = require('../worker/guards.js')
  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE
  delete process.env.HOME
  delete process.env.USERPROFILE
  try {
    assert.strictEqual(
      guards.isBroadSharePath('/home/someone/.ssh'),
      true,
      'with no HOME to compare against, a hidden entry must still be refused'
    )
  } finally {
    if (savedHome !== undefined) process.env.HOME = savedHome
    if (savedProfile !== undefined) process.env.USERPROFILE = savedProfile
  }
})

check('session capacity passes below the ceiling and refuses at it', () => {
  const guards = require('../worker/guards.js')
  const { sessions } = require('../worker/state.js')
  const saved = new Map(sessions)
  try {
    assert.doesNotThrow(
      () => guards.assertCapacity(),
      'a fresh worker has room'
    )
    for (let i = 0; i < guards.MAX_SESSIONS; i++) sessions.set(`cap-${i}`, {})
    assert.throws(() => guards.assertCapacity(), /Too many sessions/)
  } finally {
    sessions.clear()
    for (const [k, v] of saved) sessions.set(k, v)
  }
})

if (failed) {
  console.log(`\n${failed} UNIT TEST(S) FAILED ❌\n`)
  process.exitCode = 1
} else {
  console.log('\nALL UNIT TESTS PASSED ✅\n')
}
