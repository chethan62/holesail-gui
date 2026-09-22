/* fileserver.js — the folder share's HTTP file server (in-repo, MIT).
 *
 * Replaces livefiles (GPLv3), which was bundled into every released artifact
 * while this repository said MIT. Only livefiles' READ side was ever used: no
 * UI path sets role='admin' (the share form has no role field), so its upload /
 * mkdir / delete endpoints were unreachable. What the app actually needs is
 * Basic auth, a browseable listing and downloads — that is what this implements,
 * and the write endpoints are deliberately absent rather than reimplemented.
 *
 * Runs under both runtimes through runtime.js: bare-http1 + bare-fs in the
 * packaged build, node's http + fs in development.
 *
 * One thing it fixes rather than reproduces: livefiles called process.exit(1)
 * when its listen failed, so a busy port (or a second folder share) killed the
 * whole worker. Here a listen failure rejects ready() and fails only its own
 * session.
 */

const { fs, http, path, crypto, Buffer } = require('./runtime')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.woff2': 'font/woff2'
}

const statP = (p) =>
  new Promise((resolve, reject) =>
    fs.stat(p, (e, s) => (e ? reject(e) : resolve(s)))
  )
const readdirP = (p) =>
  new Promise((resolve, reject) =>
    fs.readdir(p, (e, l) => (e ? reject(e) : resolve(l)))
  )
const realpathP = (p) =>
  new Promise((resolve, reject) =>
    fs.realpath(p, (e, r) => (e ? reject(e) : resolve(r)))
  )

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[c]
  )
}

function humanSize(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

// Both fields compared in one pass so a wrong username costs the same as a
// wrong password. Length is compared first because timingSafeEqual throws on
// differing lengths — the length of a random 16-char password is not a secret.
function sameSecret(a, b) {
  const A = Buffer.from(String(a))
  const B = Buffer.from(String(b))
  return A.length === B.length && crypto.timingSafeEqual(A, B)
}

class FileServer {
  constructor(opts = {}) {
    const root = opts.path
    let st
    try {
      st = fs.statSync(root)
    } catch {
      throw new Error(`Folder not found: ${root}`)
    }
    if (!st.isDirectory()) throw new Error(`Not a directory: ${root}`)
    this.path = path.resolve(root)
    // The root's real path: containment is decided on real paths, because a
    // symlink is not something the '..' filter below can see.
    this.real = fs.realpathSync(this.path)
    // livefiles' own defaults, kept so the invite fragment and the UI keep
    // working unchanged — the worker generates a real password per share.
    this.username =
      opts.username && typeof opts.username !== 'boolean'
        ? opts.username
        : 'admin'
    this.password =
      opts.password && typeof opts.password !== 'boolean'
        ? opts.password
        : 'admin'
    this.host =
      opts.host && typeof opts.host !== 'boolean' ? opts.host : '127.0.0.1'
    this.port = Number(opts.port) > 0 ? Number(opts.port) : 0
    this.server = null
  }

  get info() {
    return {
      port: this.port,
      host: this.host,
      username: this.username,
      password: this.password,
      role: 'user'
    }
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) =>
        this.handleRequest(req, res)
      )
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject)
        this.port = this.server.address().port
        resolve(this)
      })
    })
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
  }

  authenticate(req) {
    const header = req.headers && req.headers.authorization
    if (!header || !header.startsWith('Basic ')) return false
    let decoded
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8')
    } catch {
      return false
    }
    const sep = decoded.indexOf(':')
    if (sep === -1) return false
    return (
      sameSecret(decoded.slice(0, sep), this.username) &&
      sameSecret(decoded.slice(sep + 1), this.password)
    )
  }

  handleRequest(req, res) {
    if (!this.authenticate(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Folder share"',
        'Content-Type': 'text/plain; charset=utf-8'
      })
      res.end('Authentication required.')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8'
      })
      res.end('Read-only share: downloads only.')
      return
    }
    // chroot-style: every '..' segment is dropped, so no request can name a
    // path outside the shared folder no matter how it is encoded. That filter
    // is string-level, so serve() also checks the resolved real path — a
    // symlink to /etc or $HOME names no '..' at all and would walk straight out.
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    const parts = urlPath.split('/').filter((p) => p && p !== '.' && p !== '..')
    const rel = parts.join('/')
    const full = path.join(this.path, rel)
    this.serve(full, `/${rel}`, req, res)
  }

  async serve(full, urlPath, req, res) {
    // The containment check, on the real path. A request that follows a
    // symlink out of the shared folder is refused; one whose link stays inside
    // it (or that names no link at all) is served as before.
    let real
    try {
      real = await realpathP(full)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found.')
      return
    }
    if (real !== this.real && !real.startsWith(this.real + path.sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found.')
      return
    }
    let st
    try {
      st = await statP(full)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found.')
      return
    }
    try {
      if (st.isDirectory())
        await this.list(full, urlPath, res, req.method === 'HEAD')
      else await this.file(full, urlPath, st, req, res)
    } catch {
      if (res.headersSent) return res.destroy()
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Server error.')
    }
  }

  async list(dir, urlPath, res, headOnly) {
    const names = await readdirP(dir)
    const rows = []
    for (const name of names) {
      let entry
      try {
        entry = await statP(path.join(dir, name))
      } catch {
        continue // raced away between readdir and stat
      }
      const isDir = entry.isDirectory()
      // encodeURIComponent per segment: names with '#' or '?' survive, and the
      // '/' between segments stays a path separator.
      const href = `${urlPath.replace(/\/$/, '')}/${encodeURIComponent(name)}${isDir ? '/' : ''}`
      rows.push({
        dir: isDir,
        name,
        href,
        size: isDir ? '—' : humanSize(entry.size),
        date: new Date(entry.mtimeMs || entry.mtime)
          .toISOString()
          .slice(0, 16)
          .replace('T', ' ')
      })
    }
    rows.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
    )
    const parent =
      urlPath === '/'
        ? ''
        : `<li><a href="${esc(urlPath.replace(/[^/]+\/?$/, ''))}">..</a></li>`
    // ponytail: the whole listing is built as one string; a share holding
    // ~100k entries would be heavy to render. Stream rows if that ever happens.
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(urlPath)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0 auto;padding:1.25rem;max-width:52rem;font:15px/1.5 system-ui,sans-serif}
h1{margin:0 0 .25rem;font-size:1.15rem}
p.sub{margin:0 0 1rem;opacity:.65;font-size:.85rem}
ul{list-style:none;margin:0;padding:0}
li{border-top:1px solid rgba(128,128,128,.25)}
a{display:flex;gap:.75rem;align-items:baseline;padding:.55rem .25rem;text-decoration:none;color:inherit}
a:hover{background:rgba(128,128,128,.12)}
a span:first-child{flex:1;word-break:break-all}
a span:last-child{opacity:.6;font-size:.8rem;white-space:nowrap}
.isdir span:first-child::before{content:"\\1F4C1  "}
.file span:first-child::before{content:"\\1F4C4  "}
</style></head>
<body>
<h1>${esc(urlPath === '/' ? path.basename(this.path) || '/' : urlPath)}</h1>
<p class="sub">Shared folder &middot; read-only &middot; ${rows.length} item${rows.length === 1 ? '' : 's'}</p>
<ul>
${parent}
${rows.map((r) => `<li><a class="${r.dir ? 'isdir' : 'file'}" href="${esc(r.href)}"><span>${esc(r.name)}${r.dir ? '/' : ''}</span><span>${esc(r.size)} &middot; ${esc(r.date)}</span></a></li>`).join('\n')}
${rows.length === 0 && !parent ? '<li><a href="#">(empty folder)</a></li>' : ''}
</ul>
</body></html>
`
    const body = Buffer.from(html, 'utf-8')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    })
    res.end(headOnly ? undefined : body)
  }

  file(full, urlPath, st, req, res) {
    const type =
      TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream'
    const range = req.headers && req.headers.range
    let start = 0
    let end = st.size - 1
    let status = 200
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(st.mtimeMs || st.mtime).toUTCString()
    }
    if (range) {
      // Exactly one range is served; anything else (multiple ranges, a unit
      // that isn't bytes, a malformed spec) makes this server IGNORE the header
      // and send the whole entity with 200. That is what RFC 9110 allows a
      // server to do, and 416 would be a lie: "unsatisfiable" is not the same
      // as "I don't do that shape". Measured before this: `bytes=0-1,4-5` and
      // `chunks=1-2` both answered 416.
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
      if (m) {
        const hasStart = m[1] !== ''
        const hasEnd = m[2] !== ''
        if (hasStart) start = Number(m[1])
        else if (hasEnd) start = Math.max(0, st.size - Number(m[2])) // bytes=-N: the LAST N
        // `bytes=-0` and `bytes=5-2` are genuinely unsatisfiable; an empty
        // entity has no satisfiable range at all.
        const bad =
          (!hasStart && !hasEnd) ||
          (!hasStart && hasEnd && Number(m[2]) === 0) ||
          (hasStart && hasEnd && Number(m[1]) > Number(m[2])) ||
          start >= st.size
        if (bad) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}` })
          res.end()
          return
        }
        // For a suffix range m[2] is a LENGTH, not an end offset — clamping it
        // as an offset is what made bytes=-3 answer 416 (start 7 > end 3).
        if (hasEnd && hasStart) end = Math.min(Number(m[2]), st.size - 1)
        status = 206
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`
      }
    }
    headers['Content-Length'] = end - start + 1
    // Disposition inline: the receiver is browsing, so images/PDF/video should
    // render in the tab. Filename is quoted and stripped of quotes/newlines.
    const name = path.basename(urlPath).replace(/["\r\n]/g, '')
    headers['Content-Disposition'] = `inline; filename="${name}"`
    res.writeHead(status, headers)
    if (req.method === 'HEAD') return res.end()
    const stream = fs.createReadStream(full, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }
}

module.exports = FileServer
