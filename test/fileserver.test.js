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

function request(port, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
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
