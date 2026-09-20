/* invite.test.js — the invite-link credential fragment (renderer/invite.js).
 *
 * Pure string handling, so this runs in milliseconds and both directions can be
 * asserted: a link with no credentials must come back untouched, and one with
 * them must round-trip exactly — including the punctuation a generated password
 * actually contains (base64 gives '+', '/' and '=', and '&' or '#' would break
 * a naive fragment).
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
  const { withCredentials, splitCredentials } =
    await import('../renderer/invite.js')

  console.log('\ninvite link credentials (fragment codec)')

  check('a session with no credentials keeps the bare link', () => {
    const link = 'hs://s0001abcdef'
    assert.strictEqual(withCredentials(link, null, null), link)
    assert.strictEqual(withCredentials(link, '', ''), link)
    // half a pair is not a pair
    assert.strictEqual(withCredentials(link, 'admin', ''), link)
    assert.strictEqual(withCredentials(link, '', 'secret'), link)
  })

  check('credentials survive the round trip, punctuation included', () => {
    const link = 'hs://s0001abcdef'
    for (const pass of ['abc123', 'a+b/c=d', 'with&and#inside', 'p@ss:word']) {
      const built = withCredentials(link, 'admin', pass)
      const got = splitCredentials(built)
      assert.strictEqual(got.key, link, `key polluted by ${pass}`)
      assert.strictEqual(got.user, 'admin')
      assert.strictEqual(
        got.pass,
        pass,
        `password mangled: ${pass} -> ${got.pass}`
      )
    }
  })

  check('the fragment is never part of the tunnel key', () => {
    // a fragment left on the key derives a phantom DHT seed that never
    // establishes — the same trap as the trailing slash connectClient strips
    const got = splitCredentials('hs://s0001abcdef#u=admin&p=secret')
    assert.strictEqual(got.key, 'hs://s0001abcdef')
    assert.ok(!got.key.includes('#'), 'the key still carries a fragment')
    // and the old link format (no fragment) is untouched
    assert.strictEqual(
      splitCredentials('hs://s0001abcdef').key,
      'hs://s0001abcdef'
    )
  })

  check(
    'a percent-encoded fragment is split too (deep links deliver it)',
    () => {
      // A deep link can hand the fragment over as %23, which a plain indexOf('#')
      // cannot see. Measured on a live share: its clean key resolved on the DHT
      // and the fragment-bearing one returned null, so the app said "key not found
      // on the DHT" for a tunnel that was demonstrably online.
      const enc = splitCredentials('hs://s0001abcdef%23u=admin&p=secret')
      assert.strictEqual(
        enc.key,
        'hs://s0001abcdef',
        'encoded fragment left on the key'
      )
      assert.strictEqual(enc.user, 'admin')
      assert.strictEqual(enc.pass, 'secret')
    }
  )

  check('the key keeps its own shape whatever trails it', () => {
    // the key is a fixed shape; trailing junk of any kind is not part of it
    assert.strictEqual(
      splitCredentials('hs://s0001abcdef/').key,
      'hs://s0001abcdef'
    )
    assert.strictEqual(
      splitCredentials('hs://s0001abcdef/#u=a&p=b').key,
      'hs://s0001abcdef'
    )
    assert.strictEqual(splitCredentials('hs://s0001abcdef#u=a&p=b').user, 'a')
  })

  check('credentials are not stacked onto an already-tagged link', () => {
    const once = withCredentials('hs://k', 'admin', 'one')
    const twice = withCredentials(once, 'admin', 'two')
    assert.strictEqual(twice.split('#').length, 2, 'more than one fragment')
    assert.strictEqual(splitCredentials(twice).pass, 'two')
  })

  if (failed) {
    console.log(`\n${failed} INVITE TEST(S) FAILED ❌\n`)
    process.exitCode = 1
  } else {
    console.log('\nALL INVITE TESTS PASSED ✅\n')
  }
})()
