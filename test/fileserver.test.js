/* fileserver.test.js — the folder share's file server (worker/fileserver.js).
 *
 * Fast and network-free: it starts the server on a loopback port and talks to
 * it like a receiver's browser does. The DHT suite covers the tunnel in front
 * (service.test.js §10) and the bare-runtime leg runs this server for real, so
 * this file is only about the HTTP contract the app promises:
 *   - no credentials (or the old well-known default) → 401
 *   - the right credentials → a listing that names the files
 *   - a file downloads byte-exact, ranges work (media seeking), HEAD works
 *   - '..' cannot escape the shared folder, however it is encoded
 *   - writes are refused: the share is read-only by design
 *   - failed passwords from a real client are throttled; loopback is exempt
 *     (the tunnel dials it, so every remote visitor shares that address)
 */

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const FileServer = require('../worker/fileserver.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holesail-fserver-'))
const root = path.join(tmp, 'shared')
fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
const PAYLOAD = 'filemanager test payload'
fs.writeFileSync(path.join(root, 'hello.txt'), PAYLOAD)
fs.writeFileSync(
  path.join(root, 'sub', 'nested.bin'),
  Buffer.from([0, 1, 2, 250, 255])
)
// A file OUTSIDE the share, as the traversal target.
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'OUTSIDE-THE-SHARE')

const USER = 'admin'
const PASS = 'a-randomly-generated-password'

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

// A non-loopback IPv4 to reach a wildcard-bound share: the throttle only counts
// real clients, so the LAN case cannot be exercised over loopback.
function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address
    }
  }
  return null
}

function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.host || '127.0.0.1',
        port,
        path: urlPath,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        auth: opts.auth === null ? undefined : opts.auth || `${USER}:${PASS}`
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        )
      }
    )
    req.on('error', reject)
    if (opts.method === 'POST') req.write('x')
    req.end()
  })
}

;(async () => {
  const server = new FileServer({
    path: root,
    username: USER,
    password: PASS,
    host: '127.0.0.1',
    port: 0
  })
  await server.ready()
  const port = server.info.port
  assert(Number.isInteger(port) && port > 0, 'a real port is reported back')
  assert(server.info.role === 'user', 'the role the app has always shown')

  await check(
    'refuses an unauthenticated request and asks for Basic auth',
    async () => {
      const res = await request(port, '/', { auth: null })
      assert.strictEqual(res.status, 401)
      assert.match(res.headers['www-authenticate'] || '', /Basic/)
    }
  )

  await check('refuses the well-known admin/admin default', async () => {
    const res = await request(port, '/', { auth: 'admin:admin' })
    assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`)
  })

  await check('wrong password for the right username → 401', async () => {
    const res = await request(port, '/', { auth: `${USER}:nope` })
    assert.strictEqual(res.status, 401)
  })

  await check(
    'one client is one bucket, however its address is spelled',
    () => {
      // A dual-stack bind reports an IPv4 peer as '::ffff:a.b.c.d'; without
      // normalising, the same client would spend the quota once per family.
      const key = FileServer.clientAddress
      assert.strictEqual(
        key({ socket: { remoteAddress: '::ffff:192.168.29.5' } }),
        '192.168.29.5'
      )
      assert.strictEqual(
        key({ socket: { remoteAddress: '192.168.29.5' } }),
        '192.168.29.5'
      )
      assert.strictEqual(key({ socket: { remoteAddress: '::1' } }), '::1')
      assert.strictEqual(key({ socket: {} }), 'unknown')
    }
  )

  await check('throttles password guessing from a LAN address', async () => {
    const lan = lanIPv4()
    if (!lan) {
      console.log('      (skipped: this host has no non-loopback IPv4)')
      return
    }
    const s = new FileServer({
      path: root,
      username: USER,
      password: PASS,
      host: '0.0.0.0',
      port: 0
    })
    await s.ready()
    try {
      const p = s.info.port
      const at = { host: lan }
      const ok = await request(p, '/', at)
      assert.strictEqual(
        ok.status,
        200,
        'the right password works before any guessing'
      )

      for (let i = 1; i <= 8; i++) {
        const bad = await request(p, '/', { ...at, auth: `${USER}:guess-${i}` })
        assert.strictEqual(
          bad.status,
          401,
          `guess ${i} is refused, not throttled yet`
        )
      }
      const ninth = await request(p, '/', { ...at, auth: `${USER}:guess-9` })
      assert.strictEqual(ninth.status, 429, 'the 9th guess is throttled')
      assert.match(
        ninth.headers['retry-after'] || '',
        /^\d+$/,
        'and it says when to come back'
      )

      const withGoodPassword = await request(p, '/', at)
      assert.strictEqual(
        withGoodPassword.status,
        429,
        'the window blocks the endpoint, so guessing cannot continue with a slow-but-valid header'
      )

      // The window is a minute; drop it rather than wait it out.
      s.failures.clear()
      const recovered = await request(p, '/', at)
      assert.strictEqual(
        recovered.status,
        200,
        'once the window passes, the right password is served again'
      )
    } finally {
      await s.close()
    }
  })

  await check(
    'leaves loopback alone: tunnel visitors share that address',
    async () => {
      // tunnels.js dials this server over 127.0.0.1, so every remote visitor
      // arrives as one address. Throttling it would let a single guesser hold the
      // real visitor out for a minute; the tunnel rate-limits its own clients.
      const s = new FileServer({
        path: root,
        username: USER,
        password: PASS,
        host: '127.0.0.1',
        port: 0
      })
      await s.ready()
      try {
        const p = s.info.port
        for (let i = 1; i <= 12; i++) {
          const bad = await request(p, '/', { auth: `${USER}:guess-${i}` })
          assert.strictEqual(
            bad.status,
            401,
            `loopback guess ${i} is refused, never throttled`
          )
        }
        const ok = await request(p, '/')
        assert.strictEqual(ok.status, 200, 'and the right password still works')
      } finally {
        await s.close()
      }
    }
  )

  await check('lists the shared folder (files and subfolders)', async () => {
    const res = await request(port, '/')
    assert.strictEqual(res.status, 200)
    const body = res.body.toString()
    assert.match(body, /hello\.txt/)
    assert.match(body, /sub\//)
    assert.match(res.headers['content-type'], /text\/html/)
  })

  await check('serves a file byte-exact with a sensible type', async () => {
    const res = await request(port, '/hello.txt')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.body.toString(), PAYLOAD)
    assert.match(res.headers['content-type'], /text\/plain/)
    assert.strictEqual(res.headers['accept-ranges'], 'bytes')
  })

  await check('answers HEAD with headers and no body', async () => {
    const res = await request(port, '/hello.txt', { method: 'HEAD' })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.body.length, 0)
    assert.strictEqual(Number(res.headers['content-length']), PAYLOAD.length)
  })

  await check('honours a byte range (media seeking)', async () => {
    const res = await request(port, '/hello.txt', {
      headers: { Range: 'bytes=10-14' }
    })
    assert.strictEqual(res.status, 206)
    assert.strictEqual(
      res.headers['content-range'],
      `bytes 10-14/${PAYLOAD.length}`
    )
    assert.strictEqual(res.body.toString(), PAYLOAD.slice(10, 15))
  })

  await check('rejects an unsatisfiable range with 416', async () => {
    const res = await request(port, '/hello.txt', {
      headers: { Range: 'bytes=99-' }
    })
    assert.strictEqual(res.status, 416)
  })

  // The shapes the first version of this file never tried, and got wrong:
  // `bytes=-3` answered 416 (the suffix length was clamped as an end offset),
  // and every multi/foreign range answered 416 too.
  await check('serves a SUFFIX range (last N bytes)', async () => {
    const res = await request(port, '/hello.txt', {
      headers: { Range: 'bytes=-3' }
    })
    assert.strictEqual(res.status, 206, `status ${res.status}`)
    assert.strictEqual(
      res.headers['content-range'],
      `bytes ${PAYLOAD.length - 3}-${PAYLOAD.length - 1}/${PAYLOAD.length}`
    )
    assert.strictEqual(res.body.toString(), PAYLOAD.slice(-3))
  })

  await check('serves an OPEN-ENDED range (start-)', async () => {
    const res = await request(port, '/hello.txt', {
      headers: { Range: 'bytes=5-' }
    })
    assert.strictEqual(res.status, 206)
    assert.strictEqual(res.body.toString(), PAYLOAD.slice(5))
  })

  await check(
    'IGNORES a multi-range request (200 with the whole file)',
    async () => {
      const res = await request(port, '/hello.txt', {
        headers: { Range: 'bytes=0-1,4-5' }
      })
      assert.strictEqual(res.status, 200, `status ${res.status}`)
      assert.strictEqual(res.body.toString(), PAYLOAD)
      assert.strictEqual(res.headers['content-range'], undefined)
    }
  )

  await check('IGNORES a range in a unit it does not serve (200)', async () => {
    const res = await request(port, '/hello.txt', {
      headers: { Range: 'chunks=1-2' }
    })
    assert.strictEqual(res.status, 200, `status ${res.status}`)
    assert.strictEqual(res.body.toString(), PAYLOAD)
  })

  await check(
    '416s a genuinely impossible range (start > end, and -0)',
    async () => {
      for (const spec of ['bytes=5-2', 'bytes=-0']) {
        const res = await request(port, '/hello.txt', {
          headers: { Range: spec }
        })
        assert.strictEqual(res.status, 416, `${spec} -> ${res.status}`)
        assert.strictEqual(
          res.headers['content-range'],
          `bytes */${PAYLOAD.length}`
        )
      }
    }
  )

  await check('HEAD on a directory: headers, no body', async () => {
    const res = await request(port, '/', { method: 'HEAD' })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.body.length, 0)
    assert.strictEqual(Number(res.headers['content-length']) > 0, true)
  })

  await check('serves binary content unchanged', async () => {
    const res = await request(port, '/sub/nested.bin')
    assert.strictEqual(res.status, 200)
    assert.deepStrictEqual([...res.body], [0, 1, 2, 250, 255])
    assert.match(res.headers['content-type'], /octet-stream/)
  })

  await check('lists a subfolder and offers a way back up', async () => {
    const res = await request(port, '/sub')
    const body = res.body.toString()
    assert.strictEqual(res.status, 200)
    assert.match(body, /nested\.bin/)
    assert.match(body, /href="\/"/, 'a parent link')
  })

  // The security boundary: a receiver must not be able to name anything
  // outside the shared folder, encoded or not.
  await check(
    "'..' cannot escape the share (plain, encoded, or nested)",
    async () => {
      const attempts = [
        '/../secret.txt',
        '/%2e%2e/secret.txt',
        '/sub/../../secret.txt',
        '/..%2f..%2fsecret.txt',
        '/./../secret.txt'
      ]
      for (const attempt of attempts) {
        const res = await request(port, attempt)
        assert.ok(
          !res.body.toString().includes('OUTSIDE-THE-SHARE'),
          `${attempt} leaked a file outside the share (${res.status})`
        )
      }
    }
  )

  await check(
    'a symlink out of the share cannot escape it either',
    async () => {
      // A link names no '..', so the string filter above cannot see it: this
      // is the check that decides on real paths.
      fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'link-out'))
      fs.symlinkSync(tmp, path.join(root, 'link-out-dir'))
      fs.symlinkSync('hello.txt', path.join(root, 'link-in'))

      for (const attempt of ['/link-out', '/link-out-dir/secret.txt']) {
        const res = await request(port, attempt)
        assert.ok(
          !res.body.toString().includes('OUTSIDE-THE-SHARE'),
          `${attempt} leaked a file outside the share (${res.status})`
        )
        assert.strictEqual(res.status, 404, `${attempt} should 404, not leak`)
      }

      // ...and the listing must not advertise the way out.
      const listed = (await request(port, '/')).body.toString()
      assert.ok(
        !listed.includes('OUTSIDE-THE-SHARE'),
        'the listing leaked content from outside the share'
      )

      // A link that stays inside the share still works — containment, not a
      // blanket ban on symlinks.
      const inside = await request(port, '/link-in')
      assert.strictEqual(inside.status, 200)
      assert.strictEqual(inside.body.toString(), PAYLOAD)
    }
  )

  await check('every listed row gets a glyph, file or folder', async () => {
    // The rows are a two-column grid; without a glyph on file rows the names
    // do not line up with folder rows. Cheap guard: both rules must exist.
    const body = (await request(port, '/')).body.toString()
    assert.match(body, /\.isdir span:first-child::before/)
    assert.match(body, /\.file span:first-child::before/)
  })

  await check('refuses writes: the share is read-only', async () => {
    const res = await request(port, '/hello.txt', { method: 'POST' })
    assert.strictEqual(res.status, 405)
    assert.strictEqual(res.headers.allow, 'GET, HEAD')
  })

  await check('404s a missing file', async () => {
    const res = await request(port, '/nope.txt')
    assert.strictEqual(res.status, 404)
  })

  await check('names in the listing survive escaping', async () => {
    const tricky = 'a&b<c>"d\'.txt'
    fs.writeFileSync(path.join(root, tricky), 'x')
    const res = await request(port, '/')
    const body = res.body.toString()
    assert.match(body, /a&amp;b&lt;c&gt;&quot;d&#39;\.txt/)
    assert.ok(
      !body.includes('<c>'),
      'the raw name must not be injected as markup'
    )
  })

  await check(
    'a foldered share of a non-directory is refused up front',
    async () => {
      assert.throws(
        () => new FileServer({ path: path.join(root, 'hello.txt') }),
        /Not a directory/
      )
      assert.throws(
        () => new FileServer({ path: path.join(tmp, 'gone') }),
        /Folder not found/
      )
    }
  )

  await check(
    'a busy port fails its own session instead of the process',
    async () => {
      const clash = new FileServer({
        path: root,
        username: USER,
        password: PASS,
        host: '127.0.0.1',
        port
      })
      await assert.rejects(
        () => clash.ready(),
        /EADDRINUSE|address already in use/
      )
    }
  )

  await server.close()
  fs.rmSync(tmp, { recursive: true, force: true })

  console.log(
    failed ? `\nfileserver: ${failed} FAILED ❌\n` : '\nfileserver: PASS ✅\n'
  )
  process.exit(failed ? 1 : 0)
})()
