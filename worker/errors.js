/* errors.js — attribute async errors to a session; drop only that session.
 * Depends on runtime.js + state.js + transport.js + limiter.js + stats.js.
 *
 * The holesail instances expose no error events — internal socket/bind
 * failures surface as uncaughtException/unhandledRejection with the port in
 * the message. When a session can be blamed, stop ONLY that session instead
 * of taking down every tunnel; unattributable errors still exit (respawn
 * restores permanents).
 */

const { setImmediate } = require('./runtime.js')
const { sessions } = require('./state.js')
const { sendEvent } = require('./transport.js')
const { stopLimitTicker } = require('./limiter.js')
const { clearStatsEmit } = require('./stats.js')

function sessionForError(err) {
  const msg = String((err && err.message) || err)
  const errPort = err && err.port
  for (const id of sessions.keys()) {
    const entry = sessions.get(id)
    if (!entry) continue
    if (errPort !== undefined && errPort !== null && entry.port === errPort) return entry
    if (entry.port && msg.includes(`:${entry.port}`)) return entry
  }
  return null
}

function onAsyncError(kind, err) {
  const session = sessionForError(err)
  if (session) {
    // one broken tunnel must not kill the rest — drop just this session.
    // Remove it from the map and emit BOTH events synchronously so the
    // UI always clears the card, then best-effort close the instance
    // (close() may itself hang on the broken resource).
    sessions.delete(session.id)
    clearStatsEmit(session.id)
    stopLimitTicker(session)
    sendEvent('session:update', {
      id: session.id,
      state: 'error',
      error: String((err && err.message) || err)
    })
    sendEvent('session:update', { id: session.id, state: 'stopped' })
    session.hs.close().catch(() => {})
    return
  }
  // unattributable error: the process may be in a broken state; report and
  // exit so the parent can respawn (permanent tunnels are restored by the
  // renderer on worker:spawned, temporary ones are lost by design)
  sendEvent('worker:error', { message: `${kind}: ${String((err && err.message) || err)}` })
  setImmediate(() => process.exit(1))
}

module.exports = { sessionForError, onAsyncError }
