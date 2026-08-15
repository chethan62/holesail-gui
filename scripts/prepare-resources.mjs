/* scripts/prepare-resources.mjs
 *
 * Prepares a dist-resources folder for bundling into the Tauri app:
 *   - service-worker.js (the plain-Node worker the Rust backend spawns)
 *   - node_modules/ containing ONLY the production tree (holesail + deps,
 *     including the native prebuilds sodium-native / udx-native)
 *
 * Run before `tauri build` (wired in package.json "build").
 * Requires network access (npm registry) on the packaging machine.
 *
 * Flags:
 *   --out <dir>    output directory (default: dist-resources)
 *   --target <t>   keep only prebuilds for this platform-arch, e.g.
 *                  linux-x64 (default: host) or android-arm64
 *   --bare         Bundled-runtime mode: also install bare-runtime-<target>,
 *                  copy its binary to <out>/bare (<out>/bare.exe on
 *                  win32-* targets), and keep only the .bare addon
 *                  prebuilds (drop the node-ABI .node files). Used for
 *                  Android, and for Linux/Windows/macOS desktop packages
 *                  so end users don't need Node.js installed.
 */

import { execSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const opt = {
  out: 'dist-resources',
  target: process.platform + '-' + process.arch,
  bare: false
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') opt.out = args[i + 1]
  else if (args[i] === '--target') opt.target = args[i + 1]
  else if (args[i] === '--bare') opt.bare = true
}

const BARE_RUNTIME_VERSION = '1.31.0' // pinned; contains the prebuilt bin/bare

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, opt.out)

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
      dependencies: { holesail: '^2.4.1', livefiles: '^1.1.0' }
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
const prebuildKeep = opt.target
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'prebuilds') {
        for (const platform of readdirSync(full)) {
          if (platform !== prebuildKeep) {
            rmSync(path.join(full, platform), { recursive: true, force: true })
          } else if (opt.bare) {
            // bare mode: only the .bare ABI addons are used — drop the
            // node-ABI .node files from the kept platform dir too
            for (const f of readdirSync(path.join(full, platform))) {
              if (!f.endsWith('.bare')) {
                rmSync(path.join(full, platform, f), { force: true })
              }
            }
          }
        }
      } else if (entry.name !== 'node_modules' || path.basename(dir) !== 'node_modules') {
        walk(full)
      }
    }
  }
}
walk(path.join(out, 'node_modules'))

// bare mode: lift the runtime binary out of the prebuilt tarball to
// <out>/bare (executable), then drop the tarball. npm refuses to install
// the os-gated bare-runtime-* package for a foreign platform (e.g.
// android-arm64 from a linux host), so fetch it directly with npm pack.
if (opt.bare) {
  // bare-runtime-win32-* ships bin/bare.exe; every other platform ships
  // bin/bare (no extension). The bundled resource keeps the same name so
  // Windows can execute it directly (CreateProcess doesn't require the
  // extension for a full path, but .exe keeps it consistent with how
  // Windows tooling/AV expects a native binary to look).
  const isWindows = opt.target.startsWith('win32-')
  const binName = isWindows ? 'bare.exe' : 'bare'

  const runtimePkg = 'bare-runtime-' + opt.target
  const tgz = execSync(`npm pack ${runtimePkg}@${BARE_RUNTIME_VERSION} --silent`, { cwd: out })
    .toString()
    .trim()
  execSync(`tar -xzf ${tgz}`, { cwd: out })
  cpSync(path.join(out, 'package', 'bin', binName), path.join(out, binName))
  chmodSync(path.join(out, binName), 0o755)
  // the runtime ships with debug info (~80MB); strip it best-effort
  // (strip/llvm-strip may not understand a foreign-platform PE/Mach-O
  // binary when cross-prepping, e.g. --target win32-x64 on a Linux CI
  // runner — that's fine, the failure is silently swallowed below).
  try {
    execSync(`llvm-strip --strip-all ${path.join(out, binName)}`, { stdio: 'ignore' })
  } catch {
    try {
      execSync(`strip ${path.join(out, binName)}`, { stdio: 'ignore' })
    } catch {
      console.log('warning: could not strip bare runtime binary')
    }
  }
  rmSync(path.join(out, 'package'), { recursive: true, force: true })
  rmSync(path.join(out, tgz), { force: true })
}

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
console.log('prepared', out, mb + ' MB', opt.bare ? '(bare mode, target ' + opt.target + ')' : '')
