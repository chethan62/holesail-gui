/* runtime.js — resolve the runtime globals once (Node or Bare).
 *
 * The bare runtime (Android backend) does not expose Node globals — its
 * builtins live under bare-* names. Node has them as globals. Resolve
 * whichever runtime we are running under. Leaf module: imports nothing.
 */

const process = (() => {
  try {
    return require('bare-process')
  } catch {
    return globalThis.process
  }
})()

const Buffer = (() => {
  try {
    return require('buffer').Buffer
  } catch {
    return globalThis.Buffer
  }
})()

const setImmediate = globalThis.setImmediate || ((fn, ...args) => setTimeout(fn, 0, ...args))

const net = (() => {
  try {
    return require('bare-net')
  } catch {
    return require('net')
  }
})()

const fs = (() => {
  try {
    return require('bare-fs')
  } catch {
    return require('fs')
  }
})()

const path = (() => {
  try {
    return require('bare-path')
  } catch {
    return require('path')
  }
})()

module.exports = { process, Buffer, setImmediate, net, fs, path }
