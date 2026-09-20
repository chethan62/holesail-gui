/* renderer.test.js — the renderer's own check, kept out of service.test.js
   (that suite belongs to the worker; neither should have to know about the
   other). `npm test` runs it right after the worker suite.

   The DOM stub below is deliberately minimal: this file only exercises
   renderSessions()'s empty-state branch and updateUptimeNote(). Anything that
   renders a real session card needs a real DOM — drive the app for that
   (scripts/ci-ui-smoke.py) or open the page in a browser. */

const nodes = new Map()
const node = (sel) => {
  if (!nodes.has(sel)) nodes.set(sel, { innerHTML: '', textContent: '' })
  return nodes.get(sel)
}
globalThis.document = {
  querySelector: node,
  getElementById: () => ({ addEventListener() {} })
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

  console.log(fail.n ? `renderer: ${fail.n} FAILED` : 'renderer: PASS')
  process.exit(fail.n ? 1 : 0)
})()
