/* errors.js — map raw worker/engine error strings to plain-English messages
   with a troubleshooting hint. Unknown errors pass through unchanged. */

const ERROR_HINTS = [
  [/Folder not found: (.+)/, (m) => `That folder doesn't exist: ${m[1]} — check the path and try again.`],
  [/Not a directory: (.+)/, (m) => `That path is a file, not a folder: ${m[1]} — pick a directory.`],
  [/Refusing to share a broad path/, () => `Sharing your whole drive or home folder is blocked for safety — share a specific subfolder instead.`],
  [/Invalid port: (.+)/, (m) => `"${m[1]}" isn't a valid port — use a number between 1 and 65535.`],
  [/A key should have a minimum length of 32/, () => `The custom key is too short — use at least 32 hex characters (0-9, a-f).`],
  [/Invalid key format/, () => `That connection string isn't a valid hs:// key — double-check it (private keys start with hs://s000, public with hs://0000).`],
  [/Connection string is required/, () => `Paste a connection string first (hs://s000… or hs://0000…).`],
  [/Too many sessions/, () => `You've reached the 50-tunnel limit — stop a session before starting another.`],
  [/Directory path is required/, () => `Enter a folder path or drop a folder to share it.`],
  [/No session with id/, () => `That session is already gone — it may have been stopped or dropped.`],
  [/EADDRINUSE|address already in use/, () => `Port already in use — the app usually picks a free one automatically; if this persists, stop the other process on that port.`],
  [/ENOTFOUND|getaddrinfo|tunneling socket could not be established/, () => `Network error reaching the tunnel — check your internet connection and try again.`],
  [/ECONNREFUSED/, () => `Connection refused — the service on the other end isn't accepting connections right now.`],
  [/ETIMEDOUT|timed out|timeout/, () => `The connection timed out — the peer may be offline, or your network blocks the DHT (try mobile data if you're on a strict WiFi).`],
  [/SIGTERM|worker exited/, () => `The tunnel backend stopped unexpectedly — restart it and try again.`]
]

export function humanError(err) {
  const msg = String((err && err.message) || err)
  for (const [re, fn] of ERROR_HINTS) {
    const m = msg.match(re)
    if (m) return fn(m)
  }
  return msg
}
