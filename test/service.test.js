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

const WORKER =
  process.env.WORKER_PATH || path.join(__dirname, '..', 'service-worker.js')
const WORKER_CMD = process.env.WORKER_CMD || 'node' // e.g. a bare runtime binary
// Which tunnel engine the suite drives. Both engines must satisfy the same
// RPC contract; only the network underneath differs (iroh: QUIC + tickets +
// always-encrypted + real backpressure; holesail: HyperDHT + hs:// keys).
const IROH = String(process.env.TUNNEL_ENGINE || '').toLowerCase() === 'iroh'
// Which JS runtime runs the worker. It changes real behaviour (see §20: holesail
// truncates a large UDP datagram under Node and carries it under Bare), so
// assertions that depend on it must ask rather than assume.
const BARE = WORKER_CMD !== 'node'
const URL_PREFIX = IROH ? 'iroh://' : 'hs://s000'
const TEST_PORT = 43117 // hard-coded local port to expose
const TIMEOUT_MS = 300000 // hang guard, not a speed budget: the suite runs
// ~2 min on node and the bare runtime (DHT bootstrap dominates), so a tighter
// limit flakes on slow runners — a genuine hang still surfaces here in 5 min.

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

// Close a test server without ever hanging the suite. server.close() waits for
// open connections, and a socket whose peer stopped reading never drains — one
// CI run sat here for 4 minutes and died on the overall guard instead of
// reporting anything. Destroy what we know about and never wait forever.
function closeServer(srv, sockets = []) {
  return new Promise((resolve) => {
    for (const s of sockets) {
      try {
        s.destroy()
      } catch {}
    }
    srv.close(() => resolve())
    setTimeout(resolve, 3000).unref() // safety net: fires only if we're still up
  })
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
    const server = await rpc(
      'server:start',
      { port: TEST_PORT, secure: true },
      90000
    )
    assert(server.type === 'server', 'type is server')
    assert(server.port === TEST_PORT, 'port matches')
    assert(
      typeof server.url === 'string' && server.url.startsWith(URL_PREFIX),
      `connection string starts with ${URL_PREFIX}`
    )
    console.log('    url: ' + server.url)

    console.log('3) client:connect to that url')
    const client = await rpc('client:connect', { key: server.url }, 90000)
    assert(client.type === 'client', 'type is client')
    assert(client.secure === true, 'secure auto-detected from prefix')
    assert(
      typeof client.url === 'string' && client.url.startsWith(URL_PREFIX),
      'client url present'
    )
    console.log('    client url: ' + client.url)

    console.log(
      '4) trailing-slash key regression (hs://…/ must not corrupt the key)'
    )
    const slashed = await rpc(
      'client:connect',
      { key: server.url + '/' },
      90000
    )
    assert(
      slashed.url === server.url,
      'slashed key strips to the same url (no phantom tunnel)'
    )
    const stoppedSlashed = await rpc('session:stop', { id: slashed.id })
    assert(stoppedSlashed.state === 'stopped', 'slashed client stopped')

    console.log('5) sessions:list')
    const sessions = await rpc('sessions:list', {})
    assert(sessions.length === 2, 'two active sessions')

    console.log(
      '6) client free-port regression (empty port while the server port is taken)'
    )
    // holesail's client mirrors the server's port when none is given; if
    // something local occupies it, the bind used to crash the worker as an
    // async EADDRINUSE. The worker must now bind a free port instead.
    const net = require('net')
    const blocker = net.createServer()
    await new Promise((res) => blocker.listen(TEST_PORT, '127.0.0.1', res))
    const clash = await rpc('client:connect', { key: server.url }, 90000)
    assert(
      clash.type === 'client',
      'client connects despite the occupied default port'
    )
    assert(
      clash.port !== TEST_PORT,
      'client landed on a free port, not the taken one'
    )
    const stoppedClash = await rpc('session:stop', { id: clash.id })
    assert(stoppedClash.state === 'stopped', 'free-port client stopped')
    await closeServer(blocker)
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
    } catch {
      threw = true
    }
    assert(threw, 'invalid port raises error')

    console.log('9) async session error kills only that session')
    const survivor = await rpc(
      'server:start',
      { port: TEST_PORT + 1, secure: true },
      90000
    )
    assert(survivor.type === 'server', 'survivor server started')
    // simulate a real async bind failure attributed to the SURVIVOR's port
    // (thrown on the next tick as an uncaughtException, like a socket
    // 'error' event nobody listens to) — containment must drop just that
    // session and keep the worker alive
    const sim = await rpc('test:throw', { port: survivor.port })
    assert(sim && sim.thrown === true, 'simulated error scheduled')
    await new Promise((res) => setTimeout(res, 800)) // let the containment settle
    const pongAfterSim = await rpc('ping', {})
    assert(
      pongAfterSim === 'pong',
      'worker still alive after a session-attributable error'
    )
    const list = await rpc('sessions:list', {})
    assert(list.length === 0, 'broken session was removed, worker did not die')

    console.log('10) filemanager:start shares a directory through the tunnel')
    const os = require('os')
    const fs = require('fs')
    const http = require('http')
    const fmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holesail-fm-'))
    fs.writeFileSync(path.join(fmDir, 'hello.txt'), 'filemanager test payload')
    const fm = await rpc(
      'filemanager:start',
      { path: fmDir, secure: true },
      90000
    )
    assert(fm.type === 'filemanager', 'filemanager session started')
    assert(fm.dir === fmDir, 'session records the shared directory')
    const fmClient = await rpc('client:connect', { key: fm.url }, 90000)
    assert(
      fmClient.type === 'client',
      'client connected to the filemanager tunnel'
    )
    const page = await new Promise((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port: fmClient.port,
            path: '/',
            auth: 'admin:admin'
          },
          (res) => {
            let data = ''
            res.on('data', (c) => (data += c))
            res.on('end', () => resolve({ status: res.statusCode, body: data }))
          }
        )
        .on('error', reject)
    })
    assert(page.status === 200, 'file browser responds 200 through the tunnel')
    assert(
      page.body.includes('hello.txt'),
      'shared file is listed in the browser'
    )
    await rpc('session:stop', { id: fmClient.id })
    await rpc('session:stop', { id: fm.id })
    const fmAfter = await rpc('sessions:list', {})
    assert(
      !fmAfter.some((s) => s.type === 'filemanager'),
      'filemanager session stopped cleanly'
    )

    console.log('11) filemanager:start rejects missing / non-directory paths')
    const missingDir = path.join(
      os.tmpdir(),
      'holesail-fm-missing-' + Date.now()
    )
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
    const prServer = await rpc(
      'server:start',
      { port: TEST_PORT + 2, secure: true },
      90000
    )
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

    console.log(
      '13) traffic stats: bytes flow through the tunnel and are counted'
    )
    const net2 = require('net')
    const req = Buffer.alloc(8 * 1024, 0x61) // 8 KiB up
    const reply = Buffer.alloc(64 * 1024, 0x62) // 64 KiB down
    // DELIBERATELY asymmetric: echo the request AND push 64 KiB back. A
    // symmetric echo hides swapped up/down counters (both sides read the
    // same number) — this is the only shape that catches a direction bug.
    const tSockets = []
    const tServer = net2.createServer((sock) => {
      tSockets.push(sock)
      sock.on('data', (d) => sock.write(d))
      sock.once('data', () => sock.write(reply))
    })
    await new Promise((res) => tServer.listen(0, '127.0.0.1', res))
    const tPort = tServer.address().port
    const statsServer = await rpc(
      'server:start',
      { port: tPort, secure: true },
      90000
    )
    const statsClient = await rpc(
      'client:connect',
      { key: statsServer.url },
      90000
    )
    const probe = net2.connect({ host: '127.0.0.1', port: statsClient.port })
    await new Promise((res, rej) => {
      probe.on('connect', res)
      probe.on('error', rej)
    })
    const expectedDown = req.length + reply.length // 72 KiB comes back
    probe.write(req)
    // read the whole reply back (echo 8 KiB + the 64 KiB push)
    let got = 0
    while (got < expectedDown) {
      got += await new Promise((res) =>
        probe.once('data', (d) => res(d.length))
      )
    }
    probe.end()
    await sleep(900) // let the throttled stats events drain (500ms)
    const srvStats = await rpc('session:stats', { id: statsServer.id })
    const cliStats = await rpc('session:stats', { id: statsClient.id })
    assert(
      srvStats.bytesDown >= req.length,
      `server counted ${req.length} bytes down (got ${srvStats.bytesDown})`
    )
    assert(
      srvStats.bytesUp >= expectedDown,
      `server counted ${expectedDown} bytes up (got ${srvStats.bytesUp})`
    )
    // DIRECTION, not just totals: the client uploaded exactly the 8 KiB it
    // sent, and downloaded the 72 KiB that came back. Swapped counters
    // (up=72K/down=8K) fail here — see stats.js wrapStream arg order.
    assert(
      cliStats.bytesUp >= req.length && cliStats.bytesUp <= req.length + 4096,
      `client upload is the ${req.length} bytes it sent (got ${cliStats.bytesUp})`
    )
    assert(
      cliStats.bytesDown >= expectedDown,
      `client download is the ${expectedDown} bytes it received (got ${cliStats.bytesDown})`
    )
    assert(srvStats.locCnt === 0, 'no lingering connections after close')
    await rpc('session:stop', { id: statsClient.id })
    await rpc('session:stop', { id: statsServer.id })
    await closeServer(tServer, tSockets)

    console.log(
      '13b) stats events keep flowing (throttled re-arm, not one-shot)'
    )
    // start a fresh server and listen for session:update events carrying
    // stats — with no traffic, counters stay at 0 but the EVENTS must
    // keep arriving (the emitter re-arms itself every 500ms)
    const evServer = await rpc(
      'server:start',
      { port: TEST_PORT + 5, secure: true },
      90000
    )
    const seen = []
    const onLine = (line) => {
      try {
        const m = JSON.parse(line)
        if (
          m.event === 'session:update' &&
          m.data &&
          m.data.id === evServer.id &&
          m.data.stats
        ) {
          seen.push(m.data.stats)
        }
      } catch {}
    }
    rl.on('line', onLine)
    await sleep(1600) // ~3 emit intervals
    rl.off('line', onLine)
    assert(
      seen.length >= 2,
      `stats events re-arm (got ${seen.length} in ~1.6s)`
    )
    await rpc('session:stop', { id: evServer.id })

    console.log('13c) session:peer fires when a client connects to a server')
    const peerServer = await rpc(
      'server:start',
      { port: TEST_PORT + 6, secure: true },
      90000
    )
    const peers = []
    const onPeer = (line) => {
      try {
        const m = JSON.parse(line)
        if (m.event === 'session:peer' && m.data && m.data.id === peerServer.id)
          peers.push(m.data)
      } catch {}
    }
    rl.on('line', onPeer)
    // connect a real client through the tunnel
    const peerClient = await rpc(
      'client:connect',
      { key: peerServer.url },
      90000
    )
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
    assert(
      peers.length >= 1,
      `session:peer fired for the connected client (got ${peers.length})`
    )
    assert(
      typeof peers[0].viaRelay === 'boolean',
      `session:peer carries viaRelay routing info (got ${JSON.stringify(peers[0].viaRelay)})`
    )
    await rpc('session:stop', { id: peerClient.id })
    await rpc('session:stop', { id: peerServer.id })

    console.log('13d) bandwidth cap throttles a session')
    // a 50 KB/s cap on a fast local loopback tunnel should visibly
    // stretch the transfer time of 200 KB (uncapped it's near-instant)
    const capServer = await rpc(
      'server:start',
      { port: TEST_PORT + 7, secure: true, limit: 50 * 1024 },
      90000
    )
    assert(capServer.limit === 50 * 1024, 'session reports the limit')
    const capClient = await rpc('client:connect', { key: capServer.url }, 90000)
    // echo server behind the tunnel
    const net4 = require('net')
    const eSockets = []
    const echoServer = net4.createServer((sock) => {
      eSockets.push(sock)
      sock.on('data', (d) => sock.write(d))
    })
    await new Promise((res) =>
      echoServer.listen(TEST_PORT + 7, '127.0.0.1', res)
    )
    const probe2 = net4.connect({ host: '127.0.0.1', port: capClient.port })
    await new Promise((res, rej) => {
      probe2.on('connect', res)
      probe2.on('error', rej)
    })
    const total = 200 * 1024 // 200 KB
    const start = Date.now()
    // write in chunks so the limiter's queue/pause actually engages
    for (let sent = 0; sent < total;) {
      const chunk = Math.min(16 * 1024, total - sent)
      probe2.write(Buffer.alloc(chunk, 0x62))
      sent += chunk
      await sleep(10)
    }
    // drain the echo (the cap applies to BOTH directions, so reading is
    // throttled too — wait until everything comes back)
    let received = 0
    while (received < total) {
      const chunk = await new Promise((res) =>
        probe2.once('data', (d) => res(d.length))
      )
      received += chunk
      if (Date.now() - start > 15000) break // safety
    }
    const elapsed = Date.now() - start
    probe2.end()
    const rate = (received / elapsed) * 1000
    assert(received === total, `all ${total} bytes echoed (got ${received})`)
    // 200 KB at 50 KB/s cap ≈ 4s+; assert it took meaningfully longer
    // than the uncapped path would (and well above the cap's rate)
    assert(
      rate <= 55 * 1024,
      `throughput capped (${Math.round(rate / 1024)} KB/s, limit 50 KB/s)`
    )
    assert(elapsed > 2000, `transfer stretched by the cap (${elapsed}ms)`)
    await rpc('session:stop', { id: capClient.id })
    await rpc('session:stop', { id: capServer.id })
    await closeServer(echoServer, eSockets)

    console.log('14) lookup: online key resolves, offline key returns null')
    const lkServer = await rpc(
      'server:start',
      { port: TEST_PORT + 3, secure: true },
      90000
    )
    const online = await rpc('lookup', { key: lkServer.url }, 60000)
    assert(
      online && typeof online === 'object',
      IROH
        ? 'lookup of a live peer returns its endpoint record'
        : 'lookup of a live server returns its DHT record'
    )
    if (IROH) {
      // iroh publishes no port (the ticket names a peer, not a service) —
      // the probe PROVES reachability by dialing instead of reading a record
      assert(
        typeof online.endpointId === 'string' && online.endpointId.length > 0,
        'lookup record carries the peer endpoint id'
      )
    } else {
      assert(
        online.port === lkServer.port,
        'lookup record carries the server port'
      )
    }
    assert(online.protocol === 'tcp', 'lookup record carries the protocol')
    assert(online.secure === true, 'lookup record marks the tunnel secure')
    // offline is a STATE, not an error: holesail normalizes the bare
    // {secure:true} shell of an unannounced key to null; iroh has no record
    // to read, so the same key after the peer is gone is the honest case
    if (IROH) {
      await rpc('session:stop', { id: lkServer.id })
      await sleep(500)
    }
    const deadKey = IROH ? lkServer.url : 'hs://s000' + 'a'.repeat(64)
    const offline = await rpc('lookup', { key: deadKey }, 60000)
    assert(
      offline === null,
      IROH
        ? 'lookup of a peer that has gone away returns null (offline)'
        : 'lookup of an unannounced key returns null (offline)'
    )
    // malformed public key -> thrown error (unlike a well-formed absent key)
    let badErr = null
    try {
      await rpc('lookup', { key: 'hs://0000!!!not-z32!!!' }, 30000)
    } catch (e) {
      badErr = e
    }
    assert(badErr !== null, 'lookup of a malformed public key throws')
    if (!IROH) await rpc('session:stop', { id: lkServer.id })

    console.log('15) filemanager accepts a fixed key (permanent folder shares)')
    const fmKey = 'b'.repeat(64)
    const fmDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'holesail-fm-key-'))
    fs.writeFileSync(path.join(fmDir2, 'f.txt'), 'x')
    const fmKeyed = await rpc(
      'filemanager:start',
      { path: fmDir2, secure: true, key: fmKey },
      90000
    )
    assert(
      fmKeyed.type === 'filemanager',
      'filemanager started with a fixed key'
    )
    assert(
      fmKeyed.url.startsWith(URL_PREFIX),
      'filemanager url uses the engine key scheme'
    )
    if (IROH) {
      // iroh has no hs://-style key: a fixed key derives a deterministic
      // endpoint identity, so the SAME key must yield the SAME address
      // (that invariant is what permanent tunnels rest on)
      const again = await rpc(
        'server:start',
        { port: TEST_PORT + 9, secure: true, key: fmKey },
        90000
      )
      // the ticket itself carries ephemeral addresses, so compare the
      // IDENTITY the key derives (publicKey == endpoint id)
      assert(
        again.publicKey === fmKeyed.publicKey &&
          typeof again.publicKey === 'string' &&
          again.publicKey.length > 0,
        'the same fixed key yields the same identity (stable across restarts)'
      )
      await rpc('session:stop', { id: again.id })
    } else {
      assert(
        fmKeyed.url === 'hs://s000' + fmKey,
        'filemanager url uses the fixed key (stable across restarts)'
      )
    }
    await rpc('session:stop', { id: fmKeyed.id })

    console.log(
      '16) capped tunnel stops instead of buffering a fast producer forever'
    )
    // The engine's TCP piper ignores write()'s backpressure, so a producer
    // faster than the cap cannot be slowed down — everything it sends piles
    // up in the worker's queue (measured: +75 MiB RSS for one 64 MiB burst
    // at a 20 KiB/s cap). The queue is now bounded, so the session is
    // dropped with an actionable error; the blast here is 128 MiB, so an
    // unbounded queue would show up as a >100 MiB RSS jump.
    const net5 = require('net')
    const BURST = 128 * 1024 * 1024
    let blastSock = null // kept so cleanup can destroy it (see closeServer)
    const blast = net5.createServer((sock) => {
      blastSock = sock
      sock.on('error', () => {}) // tunnel dies mid-blast; EPIPE is expected
      let sent = 0
      const buf = Buffer.alloc(64 * 1024, 0x63)
      const pump = () => {
        while (sent < BURST) {
          if (sock.destroyed) return
          sent += buf.length
          if (!sock.write(buf)) return sock.once('drain', pump)
        }
        sock.end()
      }
      pump()
    })
    await new Promise((res) => blast.listen(0, '127.0.0.1', res))
    const workerRss = () => {
      try {
        const status = fs.readFileSync(`/proc/${worker.pid}/status`, 'utf8')
        return Math.round(Number(/VmRSS:\s+(\d+)/.exec(status)[1]) / 1024)
      } catch {
        return null // no /proc (e.g. macOS) — behaviour checks still run
      }
    }
    const overflowServer = await rpc(
      'server:start',
      { port: blast.address().port, secure: true, limit: 20 * 1024 },
      90000
    )
    const overflowClient = await rpc(
      'client:connect',
      { key: overflowServer.url },
      90000
    )
    // a neighbouring, uncapped tunnel that must survive the overflow
    const bystander = await rpc(
      'server:start',
      { port: TEST_PORT + 8, secure: true },
      90000
    )
    const rssBefore = workerRss()
    const overflowErrs = []
    const onOverflow = (line) => {
      try {
        const m = JSON.parse(line)
        if (
          m.event === 'session:update' &&
          m.data &&
          m.data.id === overflowServer.id &&
          m.data.state === 'error'
        )
          overflowErrs.push(m.data)
      } catch {}
    }
    rl.on('line', onOverflow)
    const boom = net5.connect({ host: '127.0.0.1', port: overflowClient.port })
    boom.on('error', () => {})
    await new Promise((res, rej) => {
      boom.on('connect', res)
      boom.on('error', rej)
    })
    let waitedOverflow = 0
    // iroh throttles instead of overflowing, so there is no error to wait
    // for — give the burst a bounded window to prove it stays quiet
    const overflowWait = IROH ? 6000 : 20000
    while (overflowErrs.length === 0 && waitedOverflow < overflowWait) {
      await sleep(250)
      waitedOverflow += 250
    }
    rl.off('line', onOverflow)
    const rssAfter = workerRss()
    const pongOverflow = await rpc('ping', {})
    assert(pongOverflow === 'pong', 'worker survived the burst')
    const afterOverflow = await rpc('sessions:list', {})
    if (IROH) {
      // The iroh engine paces the producer through QUIC flow control instead
      // of accepting writes it cannot deliver, so the burst never piles up:
      // no cap error, the session lives, and RSS stays flat. Same ceiling,
      // reached by not creating the backlog rather than by dying on it.
      assert(
        overflowErrs.length === 0,
        `no cap error: the sender was throttled, not buffered (${overflowErrs.length})`
      )
      assert(
        afterOverflow.some((s) => s.id === overflowServer.id),
        'the capped tunnel survived the burst'
      )
    } else {
      assert(
        overflowErrs.length >= 1,
        `capped session stopped with an error (after ~${waitedOverflow}ms)`
      )
      assert(
        /Bandwidth cap/.test(overflowErrs[0].error || ''),
        `error explains the cap (${overflowErrs[0] ? overflowErrs[0].error : 'none'})`
      )
      assert(
        !afterOverflow.some((s) => s.id === overflowServer.id),
        'the overflowing session was dropped'
      )
    }
    assert(
      afterOverflow.some((s) => s.id === bystander.id),
      'the neighbouring tunnel was left alone'
    )
    if (IROH && rssBefore !== null && rssAfter !== null) {
      // the burst is 128 MiB behind a 20 KiB/s cap: an unbounded backlog
      // shows up here as >100 MiB. Asserted for iroh because backpressure
      // should mean there is nothing to accumulate (holesail's number stays
      // measured-only: allocator/GC lag over the transient churn is what it
      // reflects, see below).
      assert(
        rssAfter - rssBefore < 64,
        `burst did not accumulate in the worker (+${rssAfter - rssBefore} MiB)`
      )
    }
    if (rssBefore === null || rssAfter === null) {
      console.log('  · /proc unavailable — no RSS reading')
    } else {
      // MEASURED, not asserted. RSS growth here is dominated by allocator/GC
      // lag over the transient churn while the blast is still being drained,
      // which is runtime- and machine-dependent (bare in CI: +83 MiB for a
      // 128 MiB burst with the queue properly bounded; same test +20 MiB
      // locally) — asserting it just flakes. The bounded queue itself is
      // asserted by the error above: the ceiling firing IS the mechanism
      // that stops the backlog growing, and pre-fix it never fired at all.
      console.log(
        `  · worker RSS ${rssBefore} -> ${rssAfter} MiB (+${rssAfter - rssBefore})`
      )
    }
    boom.destroy()
    await rpc('session:stop', { id: overflowClient.id })
    await rpc('session:stop', { id: bystander.id })
    await closeServer(blast, blastSock ? [blastSock] : [])

    console.log('17) global speed limit shapes ALL tunnels together')
    // Two independent tunnels with no per-tunnel caps. Without a shared
    // bucket each would run at loopback speed and the SUM would be orders of
    // magnitude above the limit — that is what this asserts against. Note
    // the double charge: a byte crossing both ends of a tunnel inside this
    // one worker is charged once as the server's upload and once as the
    // client's download, so the delivered rate lands at about half the
    // limit. The invariant asserted is the sum being WITHIN the limit.
    const net6 = require('net')
    // Sizing matters: the bucket may hold up to a full second of budget, so
    // a payload barely above the cap can drain as one burst. 512 KB per
    // tunnel against a 1 MB/s total means the pacing dominates any burst
    // allowance (and the numbers below stay readable).
    const PAYLOAD = 512 * 1024
    const CAP = 1024 * 1024
    const mkBlaster = async () => {
      const sockets = []
      const srv = net6.createServer((sock) => {
        sockets.push(sock)
        sock.on('error', () => {}) // the tunnel may drop under a cap
        sock.write(Buffer.alloc(PAYLOAD, 0x64))
        sock.end()
      })
      await new Promise((res) => srv.listen(0, '127.0.0.1', res))
      return { srv, sockets }
    }
    const readAll = (port) =>
      new Promise((resolve, reject) => {
        const sock = net6.connect({ host: '127.0.0.1', port })
        let got = 0
        let firstAt = 0
        const timer = setTimeout(() => {
          sock.destroy()
          reject(new Error(`probe stalled after ${got} of ${PAYLOAD} bytes`))
        }, 60000)
        sock.on('error', (err) => {
          clearTimeout(timer)
          sock.destroy()
          reject(err)
        })
        sock.on('data', (d) => {
          if (!firstAt) firstAt = Date.now()
          got += d.length
          if (got >= PAYLOAD) {
            clearTimeout(timer)
            sock.destroy()
            // timed from the FIRST byte: a cold tunnel pays a DHT handshake
            // (seconds on the bare runtime) before any data moves, and that
            // is connection setup, not throughput
            resolve({ bytes: got, transferMs: Date.now() - firstAt })
          }
        })
      })
    const blasterA = await mkBlaster()
    const blasterB = await mkBlaster()
    const gServerA = await rpc(
      'server:start',
      { port: blasterA.srv.address().port, secure: true },
      90000
    )
    const gServerB = await rpc(
      'server:start',
      { port: blasterB.srv.address().port, secure: true },
      90000
    )
    const gClientA = await rpc('client:connect', { key: gServerA.url }, 90000)
    const gClientB = await rpc('client:connect', { key: gServerB.url }, 90000)
    const applied = await rpc('limit:global', { limit: CAP })
    assert(applied.limit === CAP, `limit:global applied (${applied.limit})`)
    // whole round for the capped phase: setup time only ever makes the
    // measured rate LOWER, so this cannot flake into a false failure, and a
    // cap that isn't applied shows up as a round two orders of magnitude
    // faster (loopback transfers this size in milliseconds).
    const cappedStart = Date.now()
    const phase1 = await Promise.all([
      readAll(gClientA.port),
      readAll(gClientB.port)
    ])
    const cappedMs = Date.now() - cappedStart
    const cappedRate = (phase1[0].bytes + phase1[1].bytes) / (cappedMs / 1000)
    assert(
      phase1[0].bytes === PAYLOAD && phase1[1].bytes === PAYLOAD,
      `both tunnels delivered their ${PAYLOAD} bytes`
    )
    assert(
      cappedRate <= CAP,
      `combined throughput stayed within the ${Math.round(CAP / 1024)} KB/s total (${Math.round(cappedRate / 1024)} KB/s)`
    )
    assert(
      cappedMs >= 1200,
      `transfer stretched by the shared limit (${cappedMs}ms)`
    )
    // live, not just at start: clearing it must release both tunnels
    const cleared = await rpc('limit:global', { limit: 0 })
    assert(cleared.limit === 0, 'limit:global cleared')
    const phase2 = await Promise.all([
      readAll(gClientA.port),
      readAll(gClientB.port)
    ])
    const fastMs = Math.max(phase2[0].transferMs, phase2[1].transferMs)
    assert(
      phase2[0].bytes === PAYLOAD && phase2[1].bytes === PAYLOAD,
      'both tunnels deliver their bytes again after the cap is cleared'
    )
    assert(
      fastMs * 2 < cappedMs,
      `uncapped transfer is far quicker (${fastMs}ms vs ${cappedMs}ms capped)`
    )
    await rpc('session:stop', { id: gClientA.id })
    await rpc('session:stop', { id: gClientB.id })
    await rpc('session:stop', { id: gServerA.id })
    await rpc('session:stop', { id: gServerB.id })
    await closeServer(blasterA.srv, blasterA.sockets)
    await closeServer(blasterB.srv, blasterB.sockets)

    console.log('18) UDP tunnel relays datagrams to a UDP service')
    // UDP is a separate engine path (holesail frames datagrams over a tunnel
    // stream; iroh carries them as native QUIC datagrams) and had no coverage
    // at all before this — a silent breakage would only show up as a dead game
    // server or resolver for a user who ticked "Use UDP".
    const dgram = require('dgram')
    const udpEcho = dgram.createSocket('udp4')
    udpEcho.on('message', (msg, rinfo) =>
      udpEcho.send(msg, rinfo.port, rinfo.address)
    )
    await new Promise((res) => udpEcho.bind(0, '127.0.0.1', res))
    const udpPort = udpEcho.address().port
    const udpServer = await rpc(
      'server:start',
      { port: udpPort, secure: true, udp: true },
      90000
    )
    assert(udpServer.protocol === 'udp', 'server session reports protocol udp')
    const udpClient = await rpc(
      'client:connect',
      { key: udpServer.url, udp: true },
      90000
    )
    assert(udpClient.protocol === 'udp', 'client session reports protocol udp')
    // Each exchange uses its OWN bound socket: the local port is the flow's
    // identity, so two calls must be two sources. (Read the port at bind time —
    // after close() the socket no longer answers address().)
    const exchange = (payload) =>
      new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4')
        let localPort = 0
        const timer = setTimeout(() => {
          sock.close()
          reject(new Error(`no UDP reply for ${payload} in 25s`))
        }, 25000)
        sock.on('message', (msg) => {
          clearTimeout(timer)
          const result = { payload: msg.toString(), port: localPort }
          sock.close()
          resolve(result)
        })
        sock.bind(0, '127.0.0.1', () => {
          localPort = sock.address().port
          sock.send(Buffer.from(payload), udpClient.port, '127.0.0.1')
        })
      })
    const firstReply = await exchange('udp-ping')
    assert(
      firstReply.payload === 'udp-ping',
      'datagram echoed through the tunnel'
    )
    // A SECOND local source must be answered on its own flow — the topology
    // (one tunnel connection per source address) is what keeps two clients of
    // one UDP service apart, and a shared single flow would misroute the reply.
    const secondReply = await exchange('udp-ping-2')
    assert(
      secondReply.payload === 'udp-ping-2',
      'a second source is answered on its own flow'
    )
    assert(
      secondReply.port !== firstReply.port,
      'the two sources were distinct local ports'
    )
    await sleep(1200) // let the throttled stats events drain
    const sStats = await rpc('session:stats', { id: udpServer.id })
    const cStats = await rpc('session:stats', { id: udpClient.id })
    assert(
      sStats.bytesUp >= 10 && sStats.bytesDown >= 10,
      `server counted datagrams both ways (up ${sStats.bytesUp} / down ${sStats.bytesDown})`
    )
    assert(
      cStats.bytesUp >= 10 && cStats.bytesDown >= 10,
      `client counted datagrams both ways (up ${cStats.bytesUp} / down ${cStats.bytesDown})`
    )
    await rpc('session:stop', { id: udpClient.id })
    await rpc('session:stop', { id: udpServer.id })
    assert(
      !(await rpc('sessions:list', {})).some((s) => s.protocol === 'udp'),
      'udp sessions stopped cleanly'
    )
    // An open dgram socket keeps the event loop (and the whole run) alive
    // after the assertions — the same reason every TCP test server goes
    // through closeServer().
    udpEcho.close()

    console.log(
      '19) many app sockets at once, multiplexed onto one shared connection'
    )
    // The client tunnels every local socket over ONE connection, so this is
    // what breaks if the peer's advertised bi-stream limit is hit or a dial
    // races with another. Measured on this box: iroh serves 20 at once in
    // ~90 ms, holesail needs ~180 ms of DHT setup per socket, so 8 keeps the
    // default-engine run quick while still being simultaneous.
    const concEcho = net.createServer((s) => {
      s.on('error', () => {})
      s.pipe(s)
    })
    await new Promise((res) => concEcho.listen(0, '127.0.0.1', res))
    const CONC = 8
    const concServer = await rpc(
      'server:start',
      { port: concEcho.address().port, secure: true },
      90000
    )
    const concClient = await rpc(
      'client:connect',
      { key: concServer.url },
      90000
    )
    const concPayload = Buffer.alloc(16 * 1024, 0x51)
    const concSockets = []
    const concReplies = await Promise.all(
      Array.from({ length: CONC }, () => {
        return new Promise((resolve) => {
          const s = net.connect({ host: '127.0.0.1', port: concClient.port })
          concSockets.push(s)
          const timer = setTimeout(() => resolve(0), 30000)
          // ACCUMULATE: a tunnel read is whatever the peer's stream delivered
          // (the iroh engine sends each read straight through), so a 16 KiB
          // echo legitimately arrives as two chunks — asserting on the first
          // chunk alone reports a healthy tunnel as broken.
          let got = 0
          s.on('data', (d) => {
            if (!got) clearTimeout(timer)
            got += d.length
            if (got >= concPayload.length) resolve(got)
          })
          s.once('connect', () => s.write(concPayload))
          s.once('error', () => {
            clearTimeout(timer)
            resolve(0)
          })
        })
      })
    )
    const concOk = concReplies.filter((n) => n === concPayload.length).length
    assert(
      concOk === CONC,
      `all ${CONC} simultaneous sockets echoed (${concOk} did)`
    )
    await rpc('session:stop', { id: concClient.id })
    await rpc('session:stop', { id: concServer.id })
    await closeServer(concEcho, concSockets)

    console.log('20) an oversized UDP datagram cannot take the tunnel down')
    // QUIC datagrams are MTU-bounded, so the iroh engine DROPS one that is too
    // large and counts it; holesail frames datagrams over a stream and carries
    // it. Both engines run the same harness and only the EXPECTATION differs —
    // what must hold either way is that the tunnel and the worker survive, so
    // "a game server or resolver goes quiet because one app sent a big packet"
    // can't happen silently.
    const jumboEcho = dgram.createSocket('udp4')
    jumboEcho.on('message', (msg, rinfo) =>
      jumboEcho.send(msg, rinfo.port, rinfo.address)
    )
    await new Promise((res) => jumboEcho.bind(0, '127.0.0.1', res))
    const jumboServer = await rpc(
      'server:start',
      { port: jumboEcho.address().port, secure: true, udp: true },
      90000
    )
    const jumboClient = await rpc(
      'client:connect',
      { key: jumboServer.url, udp: true },
      90000
    )
    const jumboSock = dgram.createSocket('udp4')
    await new Promise((res) => jumboSock.bind(0, '127.0.0.1', res))
    // 8 KB: past any QUIC datagram limit, well inside UDP's own
    const jumboReply = (payload, expectReplyMs = 20000) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), expectReplyMs)
        jumboSock.once('message', (m) => {
          clearTimeout(t)
          resolve(m.length)
        })
        jumboSock.send(payload, jumboClient.port, '127.0.0.1')
      })
    const jumbo = await jumboReply(Buffer.alloc(8 * 1024, 0x7a), 12000)
    if (IROH) {
      assert(jumbo === null, 'the oversize datagram is dropped, not delivered')
      const jumboStats = await rpc('session:stats', { id: jumboClient.id })
      assert(jumboStats.rejectCnt >= 1, 'and the drop is counted, not silent')
    } else {
      // Whether holesail delivers this intact or truncates it at 2048 bytes is
      // ENVIRONMENT-dependent, not runtime-dependent, and it is upstream's
      // either way (worker/ sets no socket or buffer options at all). Measured:
      // 8192 intact under bare on the dev box, 2048 under bare on an ubuntu-22.04
      // runner and 2048 under Node in both places. Asserting a number therefore
      // tested the machine, not the code — it failed twice for that reason — so
      // assert the MECHANISM (delivered whole or at its known 2 KB ceiling, never
      // some third mangled length, never silently nothing) and log the number.
      // Same policy as RSS in §16: never assert an environment-dependent value.
      assert(
        jumbo === 8 * 1024 || jumbo === 2048,
        `oversize datagram came back as ${jumbo} of 8192 bytes`
      )
      console.log(
        `    (measured on ${BARE ? 'bare' : 'node'}: ${jumbo} of 8192 bytes)`
      )
    }
    const stillWorks = await jumboReply(Buffer.from('after-jumbo'), 20000)
    assert(
      stillWorks === 'after-jumbo'.length,
      'the tunnel still relays normal datagrams afterwards'
    )
    await rpc('session:stop', { id: jumboClient.id })
    await rpc('session:stop', { id: jumboServer.id })
    jumboSock.close()
    jumboEcho.close()

    console.log('21) a peer that goes away is told to the app, not hidden')
    // Stop the SERVER session under a live transfer. The client's connection
    // dies from the far end and its app socket must learn that promptly —
    // error, FIN or close are all fine, hanging forever is not (measured
    // before the fix: sockets sat open with nothing logged and the session
    // still read "running"). The CLIENT session must survive: only the
    // streams riding the dead connection are gone.
    const deadEcho = net.createServer((s) => {
      s.on('error', () => {})
      s.pipe(s)
    })
    await new Promise((res) => deadEcho.listen(0, '127.0.0.1', res))
    const deadServer = await rpc(
      'server:start',
      { port: deadEcho.address().port, secure: true },
      90000
    )
    const deadClient = await rpc(
      'client:connect',
      { key: deadServer.url },
      90000
    )
    const deadSock = net.connect({ host: '127.0.0.1', port: deadClient.port })
    await new Promise((r, j) => deadSock.once('connect', r).once('error', j))
    const alive = await new Promise((res) => {
      const t = setTimeout(() => res(false), 20000)
      deadSock.once('data', () => {
        clearTimeout(t)
        res(true)
      })
      deadSock.write(Buffer.from('before-the-peer-dies'))
    })
    assert(alive, 'the tunnel carries a transfer before the peer leaves')
    // Two traps in one line, both measured: a socket with no 'data' listener is
    // PAUSED (Node only emits 'end' for a FIN it actually reads), and a close
    // that lands between `session:stop` resolving and the listener being
    // attached is never reported again. So: resume, arm the listeners, THEN
    // kill the peer.
    deadSock.resume()
    const told = new Promise((resolve) => {
      const t = setTimeout(() => resolve('hung'), 20000)
      const done = (what) => {
        clearTimeout(t)
        resolve(what)
      }
      deadSock.once('close', () => done('closed'))
      deadSock.once('error', () => done('errored'))
      deadSock.once('end', () => done('ended'))
    })
    await rpc('session:stop', { id: deadServer.id })
    const how = await told
    assert(how !== 'hung', `the app socket was told within 20s (it ${how})`)
    assert(
      (await rpc('sessions:list', {})).some((s) => s.id === deadClient.id),
      'the client session itself survived its dead streams'
    )
    await rpc('session:stop', { id: deadClient.id })
    await closeServer(deadEcho, [deadSock])

    console.log('\nALL TESTS PASSED ✅')
  } catch (err) {
    console.error('\nTEST FAILED ❌\n' + err.message)
    // Fail FAST: a failing run must not hang CI. A test that dies while a
    // capped tunnel is backed up (test 16) leaves a session whose clean
    // shutdown can stall on the stalled connection, and the blast/probe
    // sockets keep this process alive — the run then looked like a job
    // timeout instead of the assertion that actually failed.
    try {
      worker.kill('SIGKILL')
    } catch {}
    process.exit(1)
  } finally {
    clearTimeout(overall)
    try {
      worker.kill('SIGTERM')
    } catch {}
  }
}

main()
