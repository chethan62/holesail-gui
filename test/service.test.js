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

const WORKER = path.join(__dirname, '..', 'service-worker.js')
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
  worker = spawn('node', [WORKER], { stdio: ['pipe', 'pipe', 'inherit'] })
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

    console.log('4) sessions:list')
    const sessions = await rpc('sessions:list', {})
    assert(sessions.length === 2, 'two active sessions')

    console.log('5) session:stop both')
    const stop1 = await rpc('session:stop', { id: server.id })
    assert(stop1.state === 'stopped', 'server session stopped')
    const stop2 = await rpc('session:stop', { id: client.id })
    assert(stop2.state === 'stopped', 'client session stopped')

    const after = await rpc('sessions:list', {})
    assert(after.length === 0, 'no sessions remain')

    console.log('6) invalid server port rejected')
    let threw = false
    try {
      await rpc('server:start', { port: 'not-a-port' })
    } catch (err) {
      threw = true
    }
    assert(threw, 'invalid port raises error')

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
