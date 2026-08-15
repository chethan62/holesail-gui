/*
 * test/service.test.js — end-to-end test of the holesail-gui service worker.
 * Spawns service-worker.js under system node, drives it over the JSON-RPC
 * stdio protocol, and verifies a real server <-> client tunnel on the DHT.
 *
 * Run: npm test   (or: node test/service.test.js)
 */

'use strict'

const { spawn } = require('child_process')
const readline = require('readline')
const path = require('path')

const WORKER = process.env.WORKER_PATH || path.join(__dirname, '..', 'service-worker.js')
const WORKER_CMD = process.env.WORKER_CMD || 'node' // e.g. a bare runtime binary
const TEST_PORT = 43117 // hard-coded local port to expose
const TIMEOUT_MS = 120000

let nextId = 1
const pending = new Map()
let worker, rl

function rpc(method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++)
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for ${method}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    worker.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function assert(cond, message) {
  if (!cond) throw new Error('ASSERT FAILED: ' + message)
  console.log('  ✓ ' + message)
}

async function main() {
  worker = spawn(WORKER_CMD, [WORKER], { stdio: ['pipe', 'pipe', 'inherit'] })
  rl = readline.createInterface({ input: worker.stdout })

  rl.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(timer)
      if (msg.error) reject(new Error(msg.error))
      else resolve(msg.result)
    }
  })

  const overall = setTimeout(() => {
    console.error('FATAL: overall test timeout')
    process.exit(1)
  }, TIMEOUT_MS)

  try {
    console.log('1) ping')
    const pong = await rpc('ping', {})
    assert(pong === 'pong', 'ping -> pong')

    console.log('2) server:start on port ' + TEST_PORT)
    const server = await rpc('server:start', { port: TEST_PORT, secure: true }, 90000)
    assert(server.type === 'server', 'type is server')
    assert(server.port === TEST_PORT, 'port matches')
    assert(typeof server.url === 'string' && server.url.startsWith('hs://s000'), 'private url hs://s000…')
    console.log('    url: ' + server.url)

    console.log('3) client:connect to that url')
    const client = await rpc('client:connect', { key: server.url }, 90000)
    assert(client.type === 'client', 'type is client')
    assert(client.secure === true, 'secure auto-detected from prefix')
    assert(typeof client.url === 'string' && client.url.startsWith('hs://s000'), 'client url present')
    console.log('    client url: ' + client.url)

    console.log('4) trailing-slash key regression (hs://…/ must not corrupt the key)')
    const slashed = await rpc('client:connect', { key: server.url + '/' }, 90000)
    assert(slashed.url === server.url, 'slashed key strips to the same url (no phantom tunnel)')
    const stoppedSlashed = await rpc('session:stop', { id: slashed.id })
    assert(stoppedSlashed.state === 'stopped', 'slashed client stopped')

    console.log('5) sessions:list')
    const sessions = await rpc('sessions:list', {})
    assert(sessions.length === 2, 'two active sessions')

    console.log('6) client free-port regression (empty port while the server port is taken)')
    // holesail's client mirrors the server's port when none is given; if
    // something local occupies it, the bind used to crash the worker as an
    // async EADDRINUSE. The worker must now bind a free port instead.
    const net = require('net')
    const blocker = net.createServer()
    await new Promise((res) => blocker.listen(TEST_PORT, '127.0.0.1', res))
    const clash = await rpc('client:connect', { key: server.url }, 90000)
    assert(clash.type === 'client', 'client connects despite the occupied default port')
    assert(clash.port !== TEST_PORT, 'client landed on a free port, not the taken one')
    const stoppedClash = await rpc('session:stop', { id: clash.id })
    assert(stoppedClash.state === 'stopped', 'free-port client stopped')
    await new Promise((res) => blocker.close(res))
    const pongAfter = await rpc('ping', {})
    assert(pongAfter === 'pong', 'worker still alive after the port conflict')

    console.log('7) session:stop both')
    const stop1 = await rpc('session:stop', { id: server.id })
    assert(stop1.state === 'stopped', 'server session stopped')
    const stop2 = await rpc('session:stop', { id: client.id })
    assert(stop2.state === 'stopped', 'client session stopped')

    const after = await rpc('sessions:list', {})
    assert(after.length === 0, 'no sessions remain')

    console.log('8) invalid server port rejected')
    let threw = false
    try {
      await rpc('server:start', { port: 'not-a-port' })
    } catch (err) {
      threw = true
    }
    assert(threw, 'invalid port raises error')

    console.log('9) async session error kills only that session')
    const survivor = await rpc('server:start', { port: TEST_PORT + 1, secure: true }, 90000)
    assert(survivor.type === 'server', 'survivor server started')
    // simulate a real async bind failure attributed to the SURVIVOR's port
    // (thrown on the next tick as an uncaughtException, like a socket
    // 'error' event nobody listens to) — containment must drop just that
    // session and keep the worker alive
    const sim = await rpc('test:throw', { port: survivor.port })
    assert(sim && sim.thrown === true, 'simulated error scheduled')
    await new Promise((res) => setTimeout(res, 800)) // let the containment settle
    const pongAfterSim = await rpc('ping', {})
    assert(pongAfterSim === 'pong', 'worker still alive after a session-attributable error')
    const list = await rpc('sessions:list', {})
    assert(list.length === 0, 'broken session was removed, worker did not die')

    console.log('10) filemanager:start shares a directory through the tunnel')
    const os = require('os')
    const fs = require('fs')
    const http = require('http')
    const fmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holesail-fm-'))
    fs.writeFileSync(path.join(fmDir, 'hello.txt'), 'filemanager test payload')
    const fm = await rpc('filemanager:start', { path: fmDir, secure: true }, 90000)
    assert(fm.type === 'filemanager', 'filemanager session started')
    assert(fm.dir === fmDir, 'session records the shared directory')
    const fmClient = await rpc('client:connect', { key: fm.url }, 90000)
    assert(fmClient.type === 'client', 'client connected to the filemanager tunnel')
    const page = await new Promise((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port: fmClient.port, path: '/', auth: 'admin:admin' },
          (res) => {
            let data = ''
            res.on('data', (c) => (data += c))
            res.on('end', () => resolve({ status: res.statusCode, body: data }))
          }
        )
        .on('error', reject)
    })
    assert(page.status === 200, 'file browser responds 200 through the tunnel')
    assert(page.body.includes('hello.txt'), 'shared file is listed in the browser')
    await rpc('session:stop', { id: fmClient.id })
    await rpc('session:stop', { id: fm.id })
    const fmAfter = await rpc('sessions:list', {})
    assert(!fmAfter.some((s) => s.type === 'filemanager'), 'filemanager session stopped cleanly')

    console.log('11) filemanager:start rejects missing / non-directory paths')
    const missingDir = path.join(os.tmpdir(), 'holesail-fm-missing-' + Date.now())
    let missingErr = null
    try {
      await rpc('filemanager:start', { path: missingDir, secure: true }, 30000)
    } catch (e) {
      missingErr = e
    }
    assert(
      missingErr && /Folder not found/.test(missingErr.message),
      `missing folder rejected (${missingErr ? missingErr.message : 'no error'})`
    )
    const fileAsDir = path.join(fmDir, 'hello.txt')
    let notDirErr = null
    try {
      await rpc('filemanager:start', { path: fileAsDir, secure: true }, 30000)
    } catch (e) {
      notDirErr = e
    }
    assert(
      notDirErr && /Not a directory/.test(notDirErr.message),
      `file-as-folder rejected (${notDirErr ? notDirErr.message : 'no error'})`
    )
    // worker-side broad-path guard: / and the home dir must be refused
    // even if a (compromised/scripted) renderer never confirmed them
    const homeDir = os.homedir()
    for (const broadPath of ['/', homeDir]) {
      let broadErr = null
      try {
        await rpc('filemanager:start', { path: broadPath, secure: true }, 30000)
      } catch (e) {
        broadErr = e
      }
      assert(
        broadErr && /Refusing to share a broad path/.test(broadErr.message),
        `broad path ${broadPath} rejected (${broadErr ? broadErr.message : 'no error'})`
      )
    }

    console.log('12) session pause/resume cycle')
    const prServer = await rpc('server:start', { port: TEST_PORT + 2, secure: true }, 90000)
    const paused = await rpc('session:pause', { id: prServer.id })
    assert(paused.state === 'paused', 'session:pause -> paused')
    const pausedList = await rpc('sessions:list', {})
    assert(
      pausedList.find((s) => s.id === prServer.id).state === 'paused',
      'sessions:list reports paused state'
    )
    const resumed = await rpc('session:resume', { id: prServer.id })
    assert(resumed.state === 'running', 'session:resume -> running')
    const resumedList = await rpc('sessions:list', {})
    assert(
      resumedList.find((s) => s.id === prServer.id).state === 'running',
      'sessions:list reports running after resume'
    )
    await rpc('session:stop', { id: prServer.id })

    console.log('13) traffic stats: bytes flow through the tunnel and are counted')
    const net2 = require('net')
    const tServer = net2.createServer((sock) => {
      // echo server: whatever the client sends comes back
      sock.on('data', (d) => sock.write(d))
    })
    await new Promise((res) => tServer.listen(0, '127.0.0.1', res))
    const tPort = tServer.address().port
    const statsServer = await rpc('server:start', { port: tPort, secure: true }, 90000)
    const statsClient = await rpc('client:connect', { key: statsServer.url }, 90000)
    const probe = net2.connect({ host: '127.0.0.1', port: statsClient.port })
    await new Promise((res, rej) => {
      probe.on('connect', res)
      probe.on('error', rej)
    })
    const payload = Buffer.alloc(64 * 1024, 0x61) // 64 KiB
    probe.write(payload)
    await new Promise((res) => probe.on('data', res)) // echo back
    probe.end()
    await sleep(900) // let the throttled stats events drain (500ms)
    const srvStats = await rpc('session:stats', { id: statsServer.id })
    const cliStats = await rpc('session:stats', { id: statsClient.id })
    assert(
      srvStats.bytesDown >= payload.length,
      `server counted ${payload.length} bytes down (got ${srvStats.bytesDown})`
    )
    assert(
      srvStats.bytesUp >= payload.length,
      `server counted ${payload.length} bytes up (got ${srvStats.bytesUp})`
    )
    assert(
      cliStats.bytesDown >= payload.length,
      `client counted ${payload.length} bytes down (got ${cliStats.bytesDown})`
    )
    assert(
      cliStats.bytesUp >= payload.length,
      `client counted ${payload.length} bytes up (got ${cliStats.bytesUp})`
    )
    assert(srvStats.locCnt === 0, 'no lingering connections after close')
    await rpc('session:stop', { id: statsClient.id })
    await rpc('session:stop', { id: statsServer.id })
    await new Promise((res) => tServer.close(res))

    console.log('13b) stats events keep flowing (throttled re-arm, not one-shot)')
    // start a fresh server and listen for session:update events carrying
    // stats — with no traffic, counters stay at 0 but the EVENTS must
    // keep arriving (the emitter re-arms itself every 500ms)
    const evServer = await rpc('server:start', { port: TEST_PORT + 5, secure: true }, 90000)
    const seen = []
    const onLine = (line) => {
      try {
        const m = JSON.parse(line)
        if (m.event === 'session:update' && m.data && m.data.id === evServer.id && m.data.stats) {
          seen.push(m.data.stats)
        }
      } catch {}
    }
    rl.on('line', onLine)
    await sleep(1600) // ~3 emit intervals
    rl.off('line', onLine)
    assert(seen.length >= 2, `stats events re-arm (got ${seen.length} in ~1.6s)`)
    await rpc('session:stop', { id: evServer.id })

    console.log('13c) session:peer fires when a client connects to a server')
    const peerServer = await rpc('server:start', { port: TEST_PORT + 6, secure: true }, 90000)
    const peers = []
    const onPeer = (line) => {
      try {
        const m = JSON.parse(line)
        if (m.event === 'session:peer' && m.data && m.data.id === peerServer.id) peers.push(m.data)
      } catch {}
    }
    rl.on('line', onPeer)
    // connect a real client through the tunnel
    const peerClient = await rpc('client:connect', { key: peerServer.url }, 90000)
    // make sure a connection actually establishes (the client proxy
    // listening isn't enough — the DHT connection happens on first use),
    // so probe through the proxy against the server's local port
    const net3 = require('net')
    const peerProbe = net3.connect({ host: '127.0.0.1', port: peerClient.port })
    await new Promise((res, rej) => {
      peerProbe.on('connect', res)
      peerProbe.on('error', rej)
    })
    peerProbe.end()
    // the DHT connection can take longer under the bare runtime — poll
    // for up to 8s for the peer event instead of a fixed sleep
    let waited = 0
    while (peers.length === 0 && waited < 8000) {
      await sleep(250)
      waited += 250
    }
    rl.off('line', onPeer)
    assert(peers.length >= 1, `session:peer fired for the connected client (got ${peers.length})`)
    assert(
      typeof peers[0].viaRelay === 'boolean',
      `session:peer carries viaRelay routing info (got ${JSON.stringify(peers[0].viaRelay)})`
    )
    await rpc('session:stop', { id: peerClient.id })
    await rpc('session:stop', { id: peerServer.id })

    console.log('13d) bandwidth cap throttles a session')
    // a 50 KB/s cap on a fast local loopback tunnel should visibly
    // stretch the transfer time of 200 KB (uncapped it's near-instant)
    const capServer = await rpc('server:start', { port: TEST_PORT + 7, secure: true, limit: 50 * 1024 }, 90000)
    assert(capServer.limit === 50 * 1024, 'session reports the limit')
    const capClient = await rpc('client:connect', { key: capServer.url }, 90000)
    // echo server behind the tunnel
    const net4 = require('net')
    const echoServer = net4.createServer((sock) => sock.on('data', (d) => sock.write(d)))
    await new Promise((res) => echoServer.listen(TEST_PORT + 7, '127.0.0.1', res))
    const probe2 = net4.connect({ host: '127.0.0.1', port: capClient.port })
    await new Promise((res, rej) => {
      probe2.on('connect', res)
      probe2.on('error', rej)
    })
    const total = 200 * 1024 // 200 KB
    const start = Date.now()
    // write in chunks so the limiter's queue/pause actually engages
    for (let sent = 0; sent < total; ) {
      const chunk = Math.min(16 * 1024, total - sent)
      probe2.write(Buffer.alloc(chunk, 0x62))
      sent += chunk
      await sleep(10)
    }
    // drain the echo (the cap applies to BOTH directions, so reading is
    // throttled too — wait until everything comes back)
    let received = 0
    while (received < total) {
      const chunk = await new Promise((res) => probe2.once('data', (d) => res(d.length)))
      received += chunk
      if (Date.now() - start > 15000) break // safety
    }
    const elapsed = Date.now() - start
    probe2.end()
    const rate = (received / elapsed) * 1000
    assert(received === total, `all ${total} bytes echoed (got ${received})`)
    // 200 KB at 50 KB/s cap ≈ 4s+; assert it took meaningfully longer
    // than the uncapped path would (and well above the cap's rate)
    assert(rate <= 55 * 1024, `throughput capped (${Math.round(rate / 1024)} KB/s, limit 50 KB/s)`)
    assert(elapsed > 2000, `transfer stretched by the cap (${elapsed}ms)`)
    await rpc('session:stop', { id: capClient.id })
    await rpc('session:stop', { id: capServer.id })
    await new Promise((res) => echoServer.close(res))

    console.log('14) lookup: online key resolves, offline key returns null')
    const lkServer = await rpc('server:start', { port: TEST_PORT + 3, secure: true }, 90000)
    const online = await rpc('lookup', { key: lkServer.url }, 60000)
    assert(online && typeof online === 'object', 'lookup of a live server returns its DHT record')
    assert(online.port === lkServer.port, 'lookup record carries the server port')
    assert(online.protocol === 'tcp', 'lookup record carries the protocol')
    assert(online.secure === true, 'lookup record marks the tunnel secure')
    // a random valid key nobody announced -> the worker normalizes the bare
    // {secure:true} shell to null (offline is a state, NOT an error)
    const deadKey = 'hs://s000' + 'a'.repeat(64)
    const offline = await rpc('lookup', { key: deadKey }, 60000)
    assert(offline === null, 'lookup of an unannounced key returns null (offline)')
    // malformed public key -> thrown error (unlike a well-formed absent key)
    let badErr = null
    try {
      await rpc('lookup', { key: 'hs://0000!!!not-z32!!!' }, 30000)
    } catch (e) {
      badErr = e
    }
    assert(badErr !== null, 'lookup of a malformed public key throws')
    await rpc('session:stop', { id: lkServer.id })

    console.log('15) filemanager accepts a fixed key (permanent folder shares)')
    const fmKey = 'b'.repeat(64)
    const fmDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'holesail-fm-key-'))
    fs.writeFileSync(path.join(fmDir2, 'f.txt'), 'x')
    const fmKeyed = await rpc(
      'filemanager:start',
      { path: fmDir2, secure: true, key: fmKey },
      90000
    )
    assert(fmKeyed.type === 'filemanager', 'filemanager started with a fixed key')
    assert(
      fmKeyed.url === 'hs://s000' + fmKey,
      'filemanager url uses the fixed key (stable across restarts)'
    )
    await rpc('session:stop', { id: fmKeyed.id })

    console.log('\nALL TESTS PASSED ✅')
  } catch (err) {
    console.error('\nTEST FAILED ❌\n' + err.message)
    process.exitCode = 1
  } finally {
    clearTimeout(overall)
    try {
      worker.kill('SIGTERM')
    } catch {}
  }
}

main()
