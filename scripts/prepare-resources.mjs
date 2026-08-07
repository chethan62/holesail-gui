/* scripts/prepare-resources.mjs
 *
 * Prepares dist-resources/ for bundling into the Tauri app:
 *   - service-worker.js (the plain-Node worker the Rust backend spawns)
 *   - node_modules/ containing ONLY the production tree (holesail + deps,
 *     including the native prebuilds sodium-native / udx-native)
 *
 * Run before `tauri build` (wired in package.json "build").
 * Requires network access (npm registry) on the packaging machine.
 */

import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'dist-resources')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// 1. worker script
cpSync(path.join(root, 'service-worker.js'), path.join(out, 'service-worker.js'))

// 2. production-only node_modules — a clean install against a package.json
//    that lists only the runtime dependency.
writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'holesail-gui-resources',
      private: true,
      version: '0.0.0',
      dependencies: { holesail: '^2.4.1' }
    },
    null,
    2
  )
)
execSync('npm install --omit=dev', { cwd: out, stdio: 'inherit' })

// hoist nested duplicates (npm sometimes nests sodium-native inside hyperdht)
execSync('npm dedupe --omit=dev', { cwd: out, stdio: 'inherit' })

// Drop packages that are dev tooling misdeclared as runtime deps upstream
// (verified: nothing in holesail's runtime tree requires 'prettier').
rmSync(path.join(out, 'node_modules', 'prettier'), { recursive: true, force: true })
rmSync(path.join(out, 'node_modules', '.bin', 'prettier'), { force: true })

// Native addons ship prebuilds for every platform (prebuildify convention).
// Tauri bundles are built per-platform, so keep only the current one.
const prebuildKeep = process.platform + '-' + process.arch // e.g. linux-x64
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'prebuilds') {
        for (const platform of readdirSync(full)) {
          if (platform !== prebuildKeep) rmSync(path.join(full, platform), { recursive: true, force: true })
        }
      } else if (entry.name !== 'node_modules' || path.basename(dir) !== 'node_modules') {
        walk(full)
      }
    }
  }
}
walk(path.join(out, 'node_modules'))

// keep the artifact clean
rmSync(path.join(out, 'package.json'), { force: true })
rmSync(path.join(out, 'package-lock.json'), { force: true })

function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const p = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(p)
      else total += statSync(p).size
    }
  }
  return total
}

const bytes = dirSize(out)
const mb = (bytes / (1024 * 1024)).toFixed(1)
console.log('prepared', out, mb + ' MB')
