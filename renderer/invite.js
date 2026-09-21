/* invite.js — the hs:// invite link's optional credential fragment.
 *
 * Leaf module (no imports, no DOM): pure string handling, so it can be unit
 * tested directly.
 *
 * Why a fragment: a folder share needs the file server's username and password
 * (the server defaults the user to "admin" and compares both exactly), and the
 * receiver's browser raises its own Basic-auth prompt unless the app can hand
 * the credentials over already. Measured: a Chromium navigation to
 * http://user:pass@host/ authenticates without any prompt, so the client side
 * only needs the pair, not a protocol change.
 *
 * The fragment (#…) is never transmitted by a URL client, so it carries the
 * pair through a QR code or the clipboard without changing what the tunnel key
 * means. The key MUST be split off before connecting: the worker derives the
 * DHT seed from it, and a stray "#…" derives a phantom tunnel that never
 * establishes — the same trap as the trailing slash in connectClient().
 */

const SEP = '#'

/// Append credentials to an invite link. Missing halves add nothing, so this is
/// safe to call for every session kind (a plain port share has no credentials).
export function withCredentials(link, user, pass) {
  const base = String(link || '').split(SEP)[0]
  if (!user || !pass) return base
  return `${base}${SEP}u=${encodeURIComponent(user)}&p=${encodeURIComponent(pass)}`
}

// A holesail key is a fixed shape: hs:// + a short id + hex, optionally with a
// trailing slash. EVERYTHING after it is metadata, never part of the key — a
// fragment can arrive percent-encoded (%23) from a deep link, which a plain
// indexOf('#') cannot see, and a fragment left on the key makes every DHT lookup
// return null (measured: the same share's clean key resolves from this box),
// which surfaces as "key not found on the DHT" for a tunnel that is online.
const KEY_RE = /^hs:\/\/[0-9a-z]+\/?/i

/// Split an invite link into the tunnel key and whatever credentials it
/// carries. Always returns a usable key; user/pass are '' when absent.
export function splitCredentials(link) {
  const raw = String(link || '')
  const match = raw.match(KEY_RE)
  const key = match
    ? match[0].replace(/\/+$/, '')
    : raw.split(SEP)[0].split('%23')[0].trim()
  const rest = raw.slice(match ? match[0].length : key.length)
  const fragment = rest.replace(/^#|^%23/i, '')
  // Parsed by hand rather than with URLSearchParams: two known keys, and the
  // renderer's lint environment does not declare the DOM constructor.
  const pair = {}
  for (const part of fragment.split('&')) {
    const eq = part.indexOf('=')
    if (eq > 0) pair[part.slice(0, eq)] = part.slice(eq + 1)
  }
  const decode = (value) => {
    try {
      return decodeURIComponent(value || '')
    } catch {
      return '' // a malformed escape is not a credential
    }
  }
  return {
    key,
    user: decode(pair.u),
    pass: decode(pair.p)
  }
}
