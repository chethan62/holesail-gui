/* session-state.test.js — what the renderer must forget, and must not.
 *
 * The stopped branch listed the maps to clear BY NAME and forgot `replay`,
 * which holds the params needed to reconnect — so it grew without bound and
 * kept connection strings (keys, and the credentials invite links now carry)
 * alive after their tunnel was stopped. dropSession/forgetAllSessions derive
 * the collections by shape instead, so a map added later cannot be forgotten.
 *
 * Both directions are asserted: the forget must reach every per-session
 * collection, and it must not touch saved tunnels, recent keys, or another
 * session's state.
 */

const assert = require('assert')

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

;(async () => {
  const { state, flags, dropSession, forgetAllSessions, rememberSession } =
    await import('../renderer/state.js')

  const NAMES = [
    'sessions',
    'meta',
    'revealed',
    'traffic',
    'conn',
    'relay',
    'replay'
  ]

  function seed(id) {
    state.sessions.set(id, { id, state: 'running' })
    state.meta.set(id, { startedAt: 1 })
    state.revealed.add(id)
    state.traffic.set(id, { up: [], down: [] })
    state.conn.set(id, 1)
    flags.relaySessions.add(id)
    rememberSession(id, 'client', {
      key: 'hs://' + id,
      fsUser: 'admin',
      fsPass: 'pw-' + id
    })
  }

  function held(id) {
    return [
      state.sessions.has(id),
      state.meta.has(id),
      state.revealed.has(id),
      state.traffic.has(id),
      state.conn.has(id),
      flags.relaySessions.has(id),
      state.replay.has(id)
    ]
  }

  console.log('\nsession state (what a stop must forget)')

  check(
    'dropSession clears every per-session collection, replay included',
    () => {
      seed('a')
      assert.ok(
        held('a').every(Boolean),
        'the seed did not populate every collection'
      )
      dropSession('a')
      const left = held('a')
      assert.ok(
        !left.some(Boolean),
        'left behind: ' + NAMES.filter((_, i) => left[i]).join(', ')
      )
    }
  )

  check('dropSession leaves other sessions and the user data alone', () => {
    seed('b')
    seed('c')
    state.saved = [{ id: 'saved-1' }]
    state.recent = ['hs://recent']
    dropSession('b')
    assert.ok(held('c').every(Boolean), 'dropping b also dropped c')
    assert.strictEqual(state.saved.length, 1, 'saved tunnels were wiped')
    assert.strictEqual(state.recent.length, 1, 'recent keys were wiped')
    dropSession('c')
    state.saved = []
    state.recent = []
  })

  check(
    'forgetAllSessions empties every collection but keeps user data',
    () => {
      seed('d')
      seed('e')
      state.saved = [{ id: 'saved-2' }]
      state.recent = ['hs://recent-2']
      forgetAllSessions()
      for (const [name, bag] of Object.entries(state)) {
        if ((bag instanceof Map || bag instanceof Set) && bag.size) {
          throw new Error(`state.${name} still holds ${bag.size}`)
        }
      }
      assert.strictEqual(flags.relaySessions.size, 0, 'relaySessions survived')
      assert.strictEqual(
        state.saved.length,
        1,
        'forgetting sessions wiped the saved tunnels'
      )
      assert.strictEqual(
        state.recent.length,
        1,
        'forgetting sessions wiped the recent keys'
      )
      state.saved = []
      state.recent = []
    }
  )

  if (failed) {
    console.log(`\n${failed} SESSION-STATE TEST(S) FAILED ❌\n`)
    process.exitCode = 1
  } else {
    console.log('\nALL SESSION-STATE TESTS PASSED ✅\n')
  }
})()
