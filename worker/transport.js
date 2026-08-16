/* transport.js — newline-JSON writer on stdout. Depends on runtime.js.
 *
 * The parent (Rust backend) reads newline-delimited JSON; events and
 * responses share this single `send` path so the format can't drift.
 */

const { process } = require('./runtime.js')

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
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
