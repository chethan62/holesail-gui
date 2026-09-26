/* url-contract.test.js — the hs:// URL contract of the tunnel engine
 * (worker/engine/hs.js: parse / resolve / lookup).
 *
 * A URL is "hs://" + a 4-char marker + the key:
 *   hs://s000<key>  secure  — <key> is the RAW human secret (hashed to a seed)
 *   hs://0000<key>  public  — <key> is the z32 ed25519 publicKey
 * The mode is the marker's first char ('s' => secure) and the key is everything
 * after the 4-char marker, so the round trip url -> (parse) -> key -> url is what
 * makes a shared link reconnectable.
 *
 * The branch that matters: a MALFORMED key THROWS, while a well-formed but
 * UNANNOUNCED key is null (offline, not an error). Those are different outcomes
 * and this file proves the engine keeps them apart. Fixtures come from the
 * source's own rules (64-hex from crypto.randomBytes(32).toString('hex'),
 * the z32 public key as Server builds it).
 *
 * The DHT is stubbed so `lookup` runs offline and deterministically: a readable
 * module cache entry for 'hyperdht' replaces the node before hs.js binds it.
 * Only hs.js reads that binding (libNet does not import hyperdht), and the
 * stub reuses the real keyPair, so parse/resolve stay on the real crypto.
 */

const assert = require('assert')
const z32 = require('z32')

const realDHT = require('hyperdht')
class FakeDHT {
  constructor() {
    this.destroyed = false
  }
  async mutableGet() {
    return null // unannounced: the DHT has no record for this key
  }
  async destroy() {
    this.destroyed = true
  }
}
FakeDHT.keyPair = realDHT.keyPair
const hyperdhtPath = require.resolve('hyperdht')
require.cache[hyperdhtPath] = {
  id: hyperdhtPath,
  filename: hyperdhtPath,
  loaded: true,
  exports: FakeDHT
}

const { parse, resolve, lookup } = require('../worker/engine/hs.js')

// urlFor(), mirroring the source: the marker is the scheme's own mode.
const urlFor = (secure, key) => (secure ? 'hs://s000' : 'hs://0000') + key

// Fixtures from the source's rules.
const HEX = 'ab'.repeat(32) // 64 hex — crypto.randomBytes(32).toString('hex')
const SECRET = 'my human passphrase 1234567890abcdef' // >= 32 chars (secure key)
const PUB = z32.encode(Buffer.alloc(32, 7)) // the publicKey Server announces
const bad = [
  '',
  'hs://',
  'hs://0000!!!not-z32!!!',
  'hs://0000abc',
  'hs://s000short'
]

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
}

;(async () => {
  console.log('\nhs:// url contract (parse/resolve/lookup)')

  await check(
    'secure round trip: hs://s000<key> parses to the raw key, resolves secure',
    () => {
      for (const key of [HEX, SECRET]) {
        const url = urlFor(true, key)
        assert.deepStrictEqual(parse(url), { marker: true, key })
        const r = resolve(url)
        assert.strictEqual(r.secure, true)
        assert.strictEqual(
          r.key,
          key,
          'the key is the raw secret after the marker'
        )
        assert.strictEqual(r.publicKey.length, 32)
        // the renderer rebuilds the link from the raw key: this must round trip
        assert.strictEqual(urlFor(r.secure, r.key), url)
      }
    }
  )

  await check(
    'public round trip: hs://0000<z32> parses to the z32 key, resolves public',
    () => {
      const url = urlFor(false, PUB)
      assert.deepStrictEqual(parse(url), { marker: false, key: PUB })
      const r = resolve(url)
      assert.strictEqual(r.secure, false)
      assert.strictEqual(r.key, PUB)
      assert.strictEqual(
        r.keyPair,
        null,
        'a public client has no shared identity'
      )
      assert.strictEqual(
        r.publicKey.length,
        32,
        'the z32 key decodes to 32 bytes'
      )
      assert.strictEqual(urlFor(r.secure, r.key), url)
    }
  )

  await check(
    'the marker is the first 4 chars after hs://; only "s" is secure',
    () => {
      // the 4-char strip is unconditional
      assert.deepStrictEqual(parse('hs://0000' + HEX), {
        marker: false,
        key: HEX
      })
      assert.deepStrictEqual(parse('hs://x000' + HEX), {
        marker: false,
        key: HEX
      })
      assert.deepStrictEqual(parse('hs://s').key, '')
      // a secure hex key behind the public marker is NOT silently accepted
      assert.throws(() => resolve('hs://0000' + HEX), /Invalid key format/)
      // nor is a wrong marker char treated as secure
      assert.throws(() => resolve('hs://x000' + HEX), /Invalid key format/)
      // the marker drives secure even from a stub body -> too short -> throws
      assert.throws(() => resolve('hs://s'), /Invalid key format/)
    }
  )

  await check('a malformed key THROWS (negative control)', () => {
    for (const value of bad) {
      assert.throws(
        () => resolve(value),
        /Invalid key format/,
        JSON.stringify(value)
      )
    }
  })

  await check(
    'whitespace is trimmed; a scheme-less key autodetects its mode',
    () => {
      assert.strictEqual(resolve('   hs://s000' + HEX + '   ').key, HEX)
      assert.strictEqual(parse('  hs://s000' + HEX + '  ').key, HEX)
      assert.strictEqual(
        resolve(HEX).secure,
        true,
        'a bare 64-hex key is secure'
      )
      assert.deepStrictEqual(parse(HEX), { marker: null, key: HEX })
      assert.strictEqual(resolve(PUB).secure, false, 'a bare z32 key is public')
      // a >=32-char secret is only a valid key WITH the secure marker; bare, it is
      // read as a public key and throws (the autodetect rule is hex/z32 only)
      assert.strictEqual(resolve('hs://s000' + SECRET).secure, true)
      assert.throws(() => resolve(SECRET), /Invalid key format/)
    }
  )

  await check(
    'unannounced is null, malformed throws: lookup keeps them apart',
    async () => {
      // a well-formed key with no DHT record is offline (null), NOT an error
      assert.strictEqual(await lookup('hs://s000' + HEX), null)
      assert.strictEqual(await lookup('hs://0000' + PUB), null)
      // a malformed key must throw — a silent null would report junk as "offline"
      await assert.rejects(
        () => lookup('hs://0000!!!not-z32!!!'),
        /Invalid key format/
      )
    }
  )

  if (failed) {
    console.log(`\n${failed} URL CONTRACT TEST(S) FAILED ❌\n`)
    process.exitCode = 1
  } else {
    console.log('\nALL URL CONTRACT TESTS PASSED ✅\n')
  }
})()
