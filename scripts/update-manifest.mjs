#!/usr/bin/env node
/* update-manifest.mjs — build latest.json (tauri-plugin-updater manifest) +
 * .sig files for a release's artifacts, for upload alongside the release.
 *
 * Usage: node scripts/update-manifest.mjs <artifacts-dir> <tag> [--key <keyfile>]
 *
 * The tag must be v<version> (e.g. v0.2.1) — it builds the download URLs
 * from the GitHub release asset convention:
 *   https://github.com/chethan62/holesail-gui/releases/download/<tag>/<asset>
 *
 * Without --key, the manifest is not written (signing key missing) and the
 * script exits 0 so CI can skip gracefully.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const [dir, tag] = process.argv.slice(2)
const keyIdx = process.argv.indexOf('--key')
const key = keyIdx > -1 ? process.argv[keyIdx + 1] : null

if (!dir || !tag) {
  console.error('usage: update-manifest.mjs <artifacts-dir> <vX.Y.Z> [--key <keyfile>]')
  process.exit(2)
}
if (!/^v\d/.test(tag)) {
  console.error(`tag must look like v0.2.1, got "${tag}"`)
  process.exit(2)
}
if (!existsSync(dir)) {
  console.error(`artifacts dir not found: ${dir}`)
  process.exit(2)
}
if (!key || !existsSync(key)) {
  console.log('no signing key — skipping update manifest')
  process.exit(0)
}

const version = tag.replace(/^v/, '')
const baseUrl = `https://github.com/chethan62/holesail-gui/releases/download/${tag}`
const files = readdirSync(dir).filter((f) => !f.endsWith('.sig') && f !== 'latest.json')

const platformFor = (name) => {
  // exact arch-specific mac dmg first, then generics
  if (/-aarch64\.dmg$/.test(name)) return 'darwin-aarch64'
  if (/-x86_64\.dmg$/.test(name)) return 'darwin-x86_64'
  if (name.endsWith('.dmg')) return 'darwin-universal'
  if (/-aarch64\.AppImage$/.test(name)) return 'linux-aarch64'
  if (name.endsWith('.AppImage')) return 'linux-x86_64'
  if (name.endsWith('.msi')) return 'windows-x86_64'
  return null
}

const platformsObj = {}
let signed = 0
for (const f of files) {
  const p = platformFor(f)
  if (!p) continue
  const abs = join(dir, f)
  console.log(`signing ${f} -> ${p}`)
  const sig = execFileSync(
    'npx',
    ['tauri', 'signer', 'sign', '-f', key, abs],
    { encoding: 'utf8' }
  ).trim()
  writeFileSync(join(dir, `${f}.sig`), `${sig}\n`)
  platformsObj[p] = { signature: sig, url: `${baseUrl}/${f}` }
  signed++
}

if (signed === 0) {
  console.log('no signable artifacts found')
  process.exit(1)
}

const manifest = {
  version,
  notes: `https://github.com/chethan62/holesail-gui/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms: platformsObj
}
writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`wrote latest.json (${signed} platform(s))`)