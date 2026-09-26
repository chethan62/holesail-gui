/* engine/hs.js - our own tunnel engine: the holesail protocol implemented over
 * the permissive stack (hyperdht MIT, z32 MIT, @holesail/hyper-cmd-lib-net
 * Apache-2.0). It replaces the AGPL/GPL glue (holesail + holesail-server +
 * holesail-client + holesail-logger + barely-colours), which was the last
 * copyleft in a shipped installer. The copyleft source was read for behaviour,
 * never copied; the protocol was measured and spike-validated 7/7 interop
 * against the real holesail (both directions, TCP and UDP). Plan and evidence:
 * the holesail-gui skill, references/permissive-engine-migration.md.
 *
 * The protocol:
 *   secure  "hs://s000<key>"  seed = sha256(key) -> keyPair, used by BOTH ends;
 *                             the server's firewall admits only that publicKey,
 *                             so the shared identity IS the access control.
 *   public  "hs://0000<z32>"  the server keeps a random keyPair and the URL
 *                             carries its publicKey; anyone may dial it.
 *   discovery: a mutable DHT record under the server's keyPair, JSON
 *                             {host, udp, port}, refreshed every 50 min.
 *   transport: raw TCP over the HyperDHT stream (and the Apache piper's UDP
 *                             framing), piped to the local service.
 *
 * What the app consumes - keep every shape here:
 *   new Engine({ server: true, port, host, secure, key, udp })
 *   new Engine({ client: true, key, port, host, udp, secure })
 *   await ready() -> info { type, protocol, secure, port, host, url, key,
 *                           publicKey }   (key is the RAW key part: the
 *   renderer rebuilds "hs://s000"+key), pause()/resume(), close()
 *   engine.dht.{server,proxy,proxySocket,stats} are read by stats.js, which was
 *   written against holesail's shape - so `dht` here is an engine-owned carrier
 *   object, NOT the DHT node. Putting our byte counters on the NODE's own
 *   `stats` property breaks the node: dht-rpc's Query._destroy() does
 *   `this.dht.stats.queries.active--`, so clobbering it makes every query
 *   destroyed afterwards throw "Cannot read properties of undefined (reading
 *   'active')" - an unattributable async error, and errors.js then exits the
 *   whole worker (found by the DHT suite dying at its section 6).
 */
'use strict'

const { Buffer, crypto, process } = require('../runtime.js')
const HyperDHT = require('hyperdht')
const z32 = require('z32')
const libNet = require('@holesail/hyper-cmd-lib-net')

// The piper reports EVERY pipe failure (a b-factory error, why it destroyed a
// connection) only through this logger, so a broken pipe is otherwise silent.
// Off by default; HG_ENGINE_TRACE=1 sends it to stderr for debugging.
const noop = () => {}
const trace = (...args) => console.error('[engine]', ...args)
// The 1.x helper has two logger conventions - the TCP piper calls
// debug/info/warn/error, the UDP proxy calls log({type,msg}) - so the silent
// logger answers all five names.
const silent = process.env.HG_ENGINE_TRACE
  ? { log: trace, debug: trace, info: trace, warn: trace, error: trace }
  : { log: noop, debug: noop, info: noop, warn: noop, error: noop }

// The pinned 1.x API is LOAD-BEARING, so fail fast if it ever moves. 2.x takes
// the remote-tunnel factory as the first argument instead of the local target,
// pipes with .pipe() (respecting write() back-pressure, on which the
// bandwidth-cap overflow guard depends) and threads no stats object. An npm
// bump therefore breaks capped tunnels and local ports instead of erroring.
if (
  typeof libNet.pipeTcpServer !== 'function' ||
  libNet.pipeTcpServer.length !== 4
) {
  throw new Error(
    '@holesail/hyper-cmd-lib-net must stay on 1.x: pipeTcpServer takes ' +
      '(remoteStream, localOpts, piperOpts, stats), got arity ' +
      (libNet.pipeTcpServer ? libNet.pipeTcpServer.length : 'missing')
  )
}
const HEX64 = /^[0-9a-f]{64}$/i
// what holesail announces with
const RECORD_REFRESH_MS = 50 * 60 * 1000

const sha256 = (v) => crypto.createHash('sha256').update(v).digest()
const urlFor = (secure, key) => (secure ? 'hs://s000' : 'hs://0000') + key
const listening = (emitter) =>
  new Promise((resolve) => emitter.once('listening', resolve))

// "hs://s000<key>" / "hs://0000<key>" / the bare key of either. `marker` is the
// scheme's own mode ('s' means secure) or null when there is no scheme at all.
function parse(value) {
  const s = String(value === null || value === undefined ? '' : value).trim()
  if (!s.startsWith('hs://')) return { marker: null, key: s }
  const body = s.slice(5)
  return { marker: body.slice(0, 1) === 's', key: body.slice(4) }
}

// A MALFORMED key must THROW: dispatch/renderer branch online / offline /
// unknown, and a silent null would report junk as merely "offline".
// test/service.test.js 14 asserts both directions (a malformed public key
// throws, an unannounced well-formed key is null). A secure key is any string
// the app already accepted (>= 32 chars, hashed into the seed); the public
// branch is z32 and must decode to 32 bytes.
function resolve(value, secureOpt) {
  const { marker, key } = parse(value)
  const secure =
    secureOpt === undefined
      ? marker === null
        ? HEX64.test(key)
        : marker
      : !!secureOpt
  if (secure) {
    if (key.length < 32) throw new Error('Invalid key format')
    const keyPair = HyperDHT.keyPair(sha256(key))
    return { secure: true, key, keyPair, publicKey: keyPair.publicKey }
  }
  let publicKey
  try {
    publicKey = z32.decode(key)
  } catch {
    throw new Error('Invalid key format')
  }
  if (!publicKey || publicKey.length !== 32)
    throw new Error('Invalid key format')
  return { secure: false, key, keyPair: null, publicKey }
}

// The object stats.js reaches into (it was written against holesail's
// HolesailServer/HolesailClient, which kept these four fields). `stats` is the
// object the piper mutates and the app counts bytes on; the others are the
// connection sources it wraps. Deliberately NOT the DHT node - see the header.
function carrier(stats) {
  return { stats, server: null, proxy: null, proxySocket: null }
}

class Server {
  constructor({
    port,
    host = '127.0.0.1',
    secure = true,
    key,
    udp = false
  } = {}) {
    this.type = 'server'
    this.udp = !!udp
    this.port = +port
    this.host = host
    this.secure = secure !== false
    if (this.secure) {
      // an explicit key is whatever the app validated (it hashes it, so any
      // sufficiently long string works); otherwise generate 256 bits
      this.key =
        typeof key === 'string' && key.length >= 32
          ? key
          : crypto.randomBytes(32).toString('hex')
      this.keyPair = HyperDHT.keyPair(sha256(this.key))
    } else {
      // public mode: random identity, the URL carries its publicKey, and the
      // firewall admits anyone
      this.keyPair = HyperDHT.keyPair()
      this.key = z32.encode(this.keyPair.publicKey)
    }
    this.publicKey = this.keyPair.publicKey
    this.node = new HyperDHT()
    this.stats = { bytesUp: 0, bytesDown: 0 }
    this.dht = carrier(this.stats)
    this.server = null
    this._refresh = null
  }

  get url() {
    return urlFor(this.secure, this.key)
  }

  get info() {
    return {
      type: this.type,
      protocol: this.udp ? 'udp' : 'tcp',
      secure: this.secure,
      port: this.port,
      host: this.host,
      url: this.url,
      key: this.key,
      publicKey: this.publicKey.toString('hex')
    }
  }

  async ready() {
    const opts = { reusableSocket: true }
    if (this.secure) {
      opts.firewall = (remotePublicKey) =>
        !remotePublicKey.equals(this.keyPair.publicKey)
    }
    this.server = this.node.createServer(opts, (conn) => {
      const local = { port: this.port, host: this.host }
      // 1.x signatures: the local target is its own argument and the stats
      // object is the LAST one (the piper mutates locCnt/remCnt there, and its
      // on('data') pumping - not .pipe() - is what lets the cap guard see an
      // unbounded producer).
      if (this.udp) {
        libNet.pipeUdpFramedServer(conn, local, silent, this.stats)
      } else {
        libNet.pipeTcpServer(
          conn,
          local,
          { isServer: true, compress: false, logger: silent },
          this.stats
        )
      }
    })
    await this.server.listen(this.keyPair)
    const record = JSON.stringify({
      host: this.host,
      udp: this.udp,
      port: this.port
    })
    await this.node.mutablePut(this.keyPair, Buffer.from(record))
    this._refresh = setInterval(() => {
      this.node.mutablePut(this.keyPair, Buffer.from(record)).catch(() => {})
    }, RECORD_REFRESH_MS)
    if (this._refresh.unref) this._refresh.unref()
    this.dht.server = this.server
    return this
  }

  async pause() {
    await this.node.suspend()
  }

  async resume() {
    await this.node.resume()
  }

  async close() {
    if (this._refresh) {
      clearInterval(this._refresh)
      this._refresh = null
    }
    // Deliberately NOT awaited: server.close() waits for open connections, so
    // awaiting it makes stop hang on a tunnel that still has a peer attached
    // (the same trap that stalled the suite once before). Closing the listener
    // is what frees the port; node.destroy() is what tears the sockets down.
    try {
      if (this.server) this.server.close().catch(() => {})
    } catch {}
    try {
      await this.node.destroy()
    } catch {}
  }
}

class Client {
  constructor({
    url,
    key,
    port = 0,
    host = '127.0.0.1',
    udp = false,
    secure
  } = {}) {
    const resolved = resolve(url || key, secure)
    this.type = 'client'
    this.secure = resolved.secure
    this.key = resolved.key
    this.keyPair = resolved.keyPair
    this.publicKey = resolved.publicKey
    this.udp = !!udp
    this.host = host || '127.0.0.1'
    this.port = +port || 0
    // the shared identity is what the server's firewall checks, so a secure
    // client dials AS that keyPair
    this.node = new HyperDHT(this.keyPair ? { keyPair: this.keyPair } : {})
    this.stats = { bytesUp: 0, bytesDown: 0 }
    this.dht = carrier(this.stats)
    this.proxy = null
    this.proxySocket = null
  }

  get url() {
    return urlFor(this.secure, this.key)
  }

  get info() {
    return {
      type: this.type,
      protocol: this.udp ? 'udp' : 'tcp',
      secure: this.secure,
      port: this.port,
      host: this.host,
      url: this.url,
      key: this.key,
      publicKey: this.publicKey.toString('hex')
    }
  }

  async ready() {
    const connectRemote = () =>
      this.node.connect(this.publicKey, { reusableSocket: true })
    if (this.udp) {
      // returns { proxySocket, clients }; it binds itself
      const { proxySocket, clients } = libNet.createUdpFramedProxy(
        { port: this.port, host: this.host },
        connectRemote,
        silent,
        null
      )
      this.proxySocket = proxySocket
      await listening(proxySocket)
      this.port = proxySocket.address().port
      // stats.js looks for `proxySocket`, else a `proxy` with send() and no
      // listen() - a dgram socket. Both are set for the UDP client.
      this.dht.proxySocket = proxySocket
      // stats.js watches each dial's stream for a dead-peer error, and this
      // map is how it finds them: libNet creates the stream lazily, on the
      // first local datagram, and drops the entry on failure without ever
      // telling the app (its only channel is the silent engine logger).
      this.dht.clients = clients
    } else {
      // 1.x signature: (listenOpts, connectRemote, piperOpts, stats, onListen)
      this.proxy = libNet.createTcpProxy(
        { port: this.port, host: this.host },
        connectRemote,
        { compress: false, logger: silent },
        this.stats,
        null
      )
      await listening(this.proxy)
      this.port = this.proxy.address().port
      this.dht.proxy = this.proxy
    }
    return this
  }

  async pause() {
    await this.node.suspend()
  }

  async resume() {
    await this.node.resume()
  }

  async close() {
    // same reason as Server.close: never await a listener's close callback
    try {
      if (this.proxy) this.proxy.close()
    } catch {}
    try {
      if (this.proxySocket) this.proxySocket.close()
    } catch {}
    try {
      await this.node.destroy()
    } catch {}
  }
}

// One constructor for both roles, as the app calls it.
class Engine {
  constructor(opts = {}) {
    return opts.client ? new Client(opts) : new Server(opts)
  }
}

// What the UI shows for a key before connecting. A malformed key throws
// (resolve does that); an unannounced one is null, which is the offline state.
async function lookup(value) {
  const { secure, publicKey } = resolve(value, undefined)
  const node = new HyperDHT()
  try {
    const rec = await node.mutableGet(publicKey, { latest: true })
    if (!rec || rec.value === null || rec.value === undefined) return null
    const record = JSON.parse(Buffer.from(rec.value).toString('utf-8'))
    return { ...record, protocol: record.udp ? 'udp' : 'tcp', secure }
  } catch {
    // a DHT read failure is offline, not a malformed key (that threw above)
    return null
  } finally {
    await node.destroy()
  }
}

module.exports = { Engine, Server, Client, lookup, parse, resolve }
