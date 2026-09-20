/* transport.js — newline-JSON writer on stdout. Depends on runtime.js.
 *
 * The parent (Rust backend) reads newline-delimited JSON; events and
 * responses share this single `send` path so the format can't drift.
 */

const { process } = require('./runtime.js')

function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch (err) {
    // One un-serialisable field (a circular reference, a BigInt, a getter that
    // throws) must not take down the worker: send() is the single path every
    // event and every reply shares, so a throw here kills all tunnels at once.
    // Degrade to a frame the parent can still parse, keeping the id when this
    // was a reply so the caller errors instead of timing out.
    const fallback =
      obj && obj.id !== undefined
        ? { id: obj.id, error: `un-serialisable response: ${err.message}` }
        : {
            event: 'worker:error',
            data: {
              message: `un-serialisable ${obj && obj.event} payload: ${err.message}`
            }
          }
    try {
      process.stdout.write(JSON.stringify(fallback) + '\n')
    } catch {
      // Nothing further we can do; dropping one frame beats a dead worker.
    }
  }
}

function sendResult(id, result) {
  send({ id, result })
}

function sendError(id, error) {
  send({ id, error: String((error && error.message) || error) })
}

function sendEvent(name, data) {
  send({ event: name, data })
}

module.exports = { send, sendResult, sendError, sendEvent }
