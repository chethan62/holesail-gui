/* renderer.test.js — the renderer's own check, kept out of service.test.js
   (that suite belongs to the worker; neither should have to know about the
   other). `npm test` runs it right after the worker suite.

   The DOM stub below is deliberately minimal: this file only exercises
   renderSessions()'s empty-state branch and updateUptimeNote(). Anything that
   renders a real session card needs a real DOM — drive the app for that
   (scripts/ci-ui-smoke.py) or open the page in a browser. */

// What log() needs to run: createElement for each line, and a #log node with
// appendChild/scrollTop. Without them a stopped session's log line threw inside
// upsertSession and took the whole run with it — the stub doing its job, since it
// is minimal ON PURPOSE so a renderer path needing a real DOM fails loudly here.
const nodes = new Map()
const stubNode = () => ({
  _html: '',
  get innerHTML() {
    return this._html
  },
  // Real DOM semantics: assigning innerHTML REPLACES the children. Without
  // this, renderSessions()'s `container.innerHTML = ''` would leave the
  // previously-rendered cards in `children`, and the "the card is gone"
  // assertion below could not tell an emptied list from a card left behind.
  set innerHTML(v) {
    this._html = String(v)
    this.children.length = 0
  },
  textContent: '',
  className: '',
  scrollTop: 0,
  scrollHeight: 0,
  children: [],
  // toast() toggles classes on #toast; without this the download guard's
  // "Already downloading" path threw instead of being asserted.
  classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
  appendChild(child) {
    this.children.push(child)
  },
  append(child) {
    this.children.push(child)
  },
  handlers: {},
  addEventListener(ev, fn) {
    ;(this.handlers[ev] ||= []).push(fn)
  },
  setAttribute() {},
  querySelector: () => null,
  // renderSession draws the traffic sparkline on the card's <canvas>. Without
  // getContext the stub throws and takes the whole run with it — so the stub
  // gets extended, never the assertion deleted. No-op 2d context on purpose:
  // these assertions are about which nodes are on screen, not about pixels.
  getContext: () => ({
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    strokeStyle: '',
    lineWidth: 1
  })
})
const node = (sel) => {
  if (!nodes.has(sel)) nodes.set(sel, stubNode())
  return nodes.get(sel)
}
globalThis.document = {
  querySelector: node,
  getElementById: node,
  createElement: () => stubNode()
}

const check = (cond, msg, fail) => {
  if (cond) console.log('✓ ' + msg)
  else {
    console.error('✗ ' + msg)
    fail.n++
  }
}

;(async () => {
  const fail = { n: 0 }
  /* A hung await used to read as a PASS: with nothing left pending (a promise
     nobody resolves has no handle), Node exits 0 mid-run — the file printed no
     "renderer: PASS" and still exited 0, so the harness reported green on a
     truncated run. The timer keeps the loop alive, so a stall now fails. */
  const watchdog = setTimeout(() => {
    console.error('✗ renderer: never finished — the run hung')
    process.exit(1)
  }, 15000)
  const { state, rememberSession } = await import('../renderer/state.js')
  const { upsertSession } = await import('../renderer/sessions.js')

  /* A stopped session must leave the SCREEN, not just the state map. This was a
     real shipped bug: the `stopped` branch deleted the session from every map
     and never re-rendered, so the stopped card stayed visible until some
     unrelated event happened to rebuild the list — which reads as "Stop did
     nothing". Verified by hand against a real browser DOM, both ways: this
     assertion holds on the fixed code and fails (innerHTML stays empty) on the
     pre-fix code. */
  state.sessions.set('t1', { id: 't1', type: 'server' })
  /* The stop must forget the replay params too. They hold the tunnel key and,
     for a folder share, its credentials — and `replay` was precisely the map
     the hand-written clears forgot, so it grew without bound and kept secrets
     alive after their tunnel was gone. See dropSession in state.js. */
  rememberSession('t1', 'client', {
    key: 'hs://t1',
    fsUser: 'admin',
    fsPass: 'pw'
  })
  upsertSession({ id: 't1', state: 'stopped' })
  check(state.sessions.size === 0, 'a stopped session leaves state', fail)
  /* The stop must also SAY it stopped. It removed the card and released the local
     proxy port correctly, but it wrote nothing to the log — which is how a
     working stop reads as "nothing happened". Found by driving the real app
     (scripts/e2e-app.py): the port was measurably freed while the log stayed
     empty, so the silence was the whole of the user-visible symptom. */
  check(
    node('#log').children.some((c) => /stopped/.test(c.textContent)),
    'a stopped session says so in the log',
    fail
  )
  check(
    !state.replay.has('t1') && state.replay.size === 0,
    'a stopped session forgets its replay params (key + credentials)',
    fail
  )
  check(
    node('#sessions').innerHTML.includes('No active tunnels yet'),
    'a stopped session leaves the screen (empty state re-rendered)',
    fail
  )

  /* A client tunnel whose DHT dial fails is removed by the worker's
     session-error containment, which emits {state:'error', error:'…'} and then
     {state:'stopped'} back to back (worker/errors.js:55-60). What the user saw
     was previously INFERRED by reading sessions.js; drive the two real events
     here instead. Three claims, asserted rather than described: the card leaves
     the list, the REASON is in the log, and the Reconnect offer is on screen
     and wired while its replay params exist.

     The last check is the one that matters: the replay params live in the same
     map the stopped branch drops (dropSession), so an offer that survives on
     screen can have nothing left to replay — clicking it does nothing at all
     (no rpc, no log, no toast). Both orderings are asserted. */
  state.sessions.clear()
  state.replay.clear()
  state.meta.clear()
  state.sessions.set('e1', {
    id: 'e1',
    type: 'client',
    state: 'running',
    port: 51000,
    host: '127.0.0.1'
  })
  rememberSession('e1', 'client', { key: 'hs://0000wrongkeywrongkey' })
  upsertSession({
    id: 'e1',
    state: 'error',
    error: 'PEER_NOT_FOUND: Peer not found'
  })
  const errLine = node('#log').children.find((c) =>
    /Session errored:/.test(c.textContent)
  )
  check(
    !!errLine && /PEER_NOT_FOUND: Peer not found/.test(errLine.textContent),
    'a failed dial puts the REASON in the log, verbatim',
    fail
  )
  const offer = node('#log').children.find((c) =>
    /Tunnel dropped/.test(c.textContent)
  )
  const reconnect =
    offer && offer.children.find((c) => /Reconnect/.test(c.textContent))
  check(
    !!reconnect && /Reconnect/.test(reconnect.textContent),
    'a dropped tunnel offers a Reconnect button on screen',
    fail
  )
  // clicking it while the params are still in memory really reconnects
  let connects = 0
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: (cmd, args) => {
          if (cmd === 'rpc' && args.method === 'client:connect') connects++
          return Promise.resolve({
            id: 'e2',
            host: '127.0.0.1',
            port: 51,
            url: 'hs://x'
          })
        }
      }
    }
  }
  reconnect.handlers.click[0]()
  await new Promise((r) => setImmediate(r))
  check(connects === 1, 'the Reconnect offer is wired to client:connect', fail)

  // the ordering the worker actually uses: stopped lands right after error.
  // Re-seed the params first: the click above consumed them (reconnectSession
  // deletes the entry on success), and the point here is what the STOPPED
  // branch drops on its own.
  rememberSession('e1', 'client', { key: 'hs://0000wrongkeywrongkey' })
  upsertSession({ id: 'e1', state: 'stopped' })
  check(state.sessions.size === 0, 'a failed dial leaves state', fail)
  check(
    node('#sessions').children.length === 0 &&
      node('#sessions').innerHTML.includes('No active tunnels yet'),
    'a failed dial leaves the SCREEN (card gone, empty state back)',
    fail
  )
  const offer2 = node('#log')
    .children.filter((c) => /Tunnel dropped/.test(c.textContent))
    .pop()
  const reconnect2 = offer2.children.find((c) =>
    /Reconnect/.test(c.textContent)
  )
  const connectsBefore = connects
  reconnect2.handlers.click[0]()
  await new Promise((r) => setImmediate(r))
  check(
    !state.replay.has('e1') && connects === connectsBefore,
    'the surviving Reconnect offer is dead once the params are dropped',
    fail
  )

  /* savedSession must not confuse a saved CLIENT with a share that names the
     same key. The owner's session url IS the invite key, so a plain url match
     returned the owner, marked the client "running" (with the owner's badge)
     and skipped its autostart — after a restart only the folder share came
     back and the client's local proxy never existed. Measured by driving the
     real app (skill: scripts/e2e-saved-cred.py), which is why this is a test
     and not just a comment. */
  const { savedSession } = await import('../renderer/saved.js')
  const key = 'hs://s000abc123def456'
  const clientRecord = { kind: 'client', key, secure: true, autostart: true }
  state.sessions.set('own1', { id: 'own1', type: 'filemanager', url: key })
  check(
    savedSession(clientRecord) === null,
    'a client record is NOT the owner share that names the same key',
    fail
  )
  state.sessions.set('srv1', { id: 'srv1', type: 'server', url: key })
  check(
    savedSession(clientRecord) === null,
    'a client record is NOT a server session with the same key',
    fail
  )
  state.sessions.set('cli1', {
    id: 'cli1',
    type: 'client',
    url: key,
    port: 5000
  })
  check(
    savedSession(clientRecord)?.id === 'cli1',
    'a client record matches its own client session',
    fail
  )

  /* The offer's link stays live while a download runs, so every click used to
     start ANOTHER 106 MB download. Measured on the real app at v0.13.0: 33
     clicks forked 33 concurrent downloads — 596 MB received, 781 MiB RSS, the
     offer still on screen and none finished, because they shared the link. The
     guard belongs in installUpdate() (one place, every caller routes through)
     and it must clear again after a failure, or one flaky download retires the
     offer for the life of the process. */
  let downloads = 0
  let release
  globalThis.window = {
    __TAURI__: {
      core: {
        Channel: class {},
        invoke: (cmd) => {
          if (cmd === 'plugin:updater|download') {
            downloads++
            return new Promise((r) => (release = r))
          }
          if (cmd === 'plugin:updater|check') {
            return Promise.resolve({
              version: '9.9.9',
              currentVersion: '1.0.0',
              rid: 1
            })
          }
          return Promise.resolve()
        }
      }
    }
  }
  const { installUpdate } = await import('../renderer/updater.js')
  const first = installUpdate('9.9.9')
  await new Promise((r) => setImmediate(r))
  const second = installUpdate('9.9.9')
  await new Promise((r) => setImmediate(r))
  check(
    downloads === 1,
    'a second click while a download runs starts no second download',
    fail
  )
  release(1)
  await first
  await second
  const third = installUpdate('9.9.9')
  await new Promise((r) => setImmediate(r))
  check(
    downloads === 2,
    'the guard clears, so a later click can still install',
    fail
  )
  release(1)
  await third

  /* Every check logged its own offer, and the offer line carries a LIVE install
     button — so the boot check plus one tap on "Check for updates" put TWO
     Download & install buttons in the log for the same release (reported from
     the running app). One line per version, in the one function every caller
     routes through; the manual click still gets its toast. */
  const { checkForUpdate } = await import('../renderer/updater.js')
  const logNode = node('#log')
  const linesBefore = logNode.children.length
  await checkForUpdate()
  await checkForUpdate(true)
  check(
    logNode.children.length === linesBefore + 1,
    'two checks for one version log ONE offer, not two',
    fail
  )

  console.log(fail.n ? `renderer: ${fail.n} FAILED` : 'renderer: PASS')
  clearTimeout(watchdog)
  process.exit(fail.n ? 1 : 0)
})()
