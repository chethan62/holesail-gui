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
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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

// Pinned; contains the prebuilt bin/bare. 1.33.4 is current and verified on
// Linux (full bare suite) plus all CI platforms. There is nothing wrong with
// 1.31.0 either — an earlier bump to fix macOS measured the wrong variable (see
// the Mach-O strip note below); this is simply the version we run.
const BARE_RUNTIME_VERSION = '1.33.4'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// An absolute --out means it: path.join(root, '/tmp/x') silently nests the
// tree under the repo (hit while auditing licences).
const out = path.isAbsolute(opt.out) ? opt.out : path.join(root, opt.out)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// 1. worker script + its modules
cpSync(
  path.join(root, 'service-worker.js'),
  path.join(out, 'service-worker.js')
)
cpSync(path.join(root, 'worker'), path.join(out, 'worker'), { recursive: true })

// 1b. the in-app brand logo — copied from the app icon so the header can
//     never drift from the mark a launcher/taskbar shows. Generated, so it is
//     gitignored (same pattern as packaging/arch/holesail-gui.png).
cpSync(
  path.join(root, 'src-tauri', 'icons', '128x128.png'),
  path.join(root, 'renderer', 'logo.png')
)

// 2. production-only node_modules — a clean install against a package.json
//    that lists only the runtime dependency.
writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'holesail-gui-resources',
      private: true,
      version: '0.0.0',
      dependencies: {
        hyperdht: '^6.34.0',
        z32: '^1.1.0',
        '@holesail/hyper-cmd-lib-net': '1.1.2',
        // worker/runtime.js resolves net/fs/path/crypto/process/http to these
        // under the packaged (bare) runtime. They used to arrive with holesail's
        // own tree; with holesail gone they must be declared here - without
        // bare-crypto the bare worker dies at startup with "Cannot find module
        // 'crypto' imported from worker/runtime.js".
        'bare-crypto': '^1.15.3',
        'bare-process': '^4.5.1',
        'bare-net': '^2.3.3',
        'bare-fs': '^4.8.0',
        'bare-path': '^3.1.1',
        'bare-http1': '^4.6.2'
      },
      overrides: { 'bare-dgram': '1.0.1' }
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
rmSync(path.join(out, 'node_modules', 'prettier'), {
  recursive: true,
  force: true
})
rmSync(path.join(out, 'node_modules', '.bin', 'prettier'), { force: true })

// The payload must carry NO copyleft code, and that is now an INVARIANT rather
// than something to remediate.
//
// Before the engine migration this spot pruned livefiles (GPLv3, reachable only
// from holesail's CLI) and then vendored the AGPL/GPL licence texts that
// holesail's own tree dragged in - holesail-server, holesail-logger and
// barely-colours all declare copyleft and none ships its own text, so every
// installer redistributed them. The migration removed holesail, and this repo's
// engine now runs on hyperdht (MIT), z32 (MIT) and
// @holesail/hyper-cmd-lib-net (Apache-2.0), so nothing copyleft belongs in the
// bundle at all: if anything is, it is a regression to fix or to fail the build
// over - never something to paper over by copying a licence text beside it.
const COPYLEFT_RE = /\b(A?GPL|LGPL|MPL|CDDL|EPL|EUPL)\b/i
const copyleft = []
const scanManifests = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = path.join(dir, entry.name)
    if (entry.name.startsWith('@')) {
      scanManifests(child)
      continue
    }
    const manifestPath = path.join(child, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      const declared = String(manifest.license || '')
      if (COPYLEFT_RE.test(declared)) {
        copyleft.push(`${manifest.name || entry.name} (${declared})`)
      }
    }
    if (existsSync(path.join(child, 'node_modules'))) {
      scanManifests(path.join(child, 'node_modules'))
    }
  }
}
scanManifests(path.join(out, 'node_modules'))
if (copyleft.length) {
  throw new Error(
    `copyleft packages in the bundle: ${copyleft.join(', ')} - refusing to build`
  )
}

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
      } else if (
        entry.name !== 'node_modules' ||
        path.basename(dir) !== 'node_modules'
      ) {
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
  const tgz = execSync(
    `npm pack ${runtimePkg}@${BARE_RUNTIME_VERSION} --silent`,
    { cwd: out }
  )
    .toString()
    .trim()
  execSync(`tar -xzf ${tgz}`, { cwd: out })
  cpSync(path.join(out, 'package', 'bin', binName), path.join(out, binName))
  chmodSync(path.join(out, binName), 0o755)
  // Size win from dropping symbols — but ONLY for formats where that is safe:
  // ELF keeps its .dynsym and PE keeps its export directory, so Linux/Windows
  // lose ~18MB of dead symbol table and still load addons.
  //
  // Never do this to a Mach-O. `--strip-all` deletes the global symbol table,
  // which is exactly what a .bare addon binds against when it loads
  // (bare_addon_load_dynamic, bare_addon_get_dynamic, bare_register_module_v0).
  // A stripped darwin runtime starts fine and runs plain JS, then SIGSEGVs the
  // instant it loads any addon — so the worker died on startup and a macOS
  // install could never tunnel. Measured on the darwin-arm64 binary:
  //   raw 71.07MB: 2/2 ABI symbols, 117984 total
  //   --strip-all 53.19MB: 0/2 ABI symbols, 4494 total
  //   --strip-debug 70.59MB: 2/2 ABI symbols, 117984 total
  // Since --strip-debug saves ~0.5MB, the answer for darwin is no strip at all.
  // The mac CI job's "Verify the bundled runtime boots the worker" step is what
  // catches this: it boots the real worker under the real bundled runtime.
  //
  // Also: strip/llvm-strip may not understand a foreign-platform PE/Mach-O when
  // cross-prepping (e.g. --target win32-x64 on a Linux runner) — that failure is
  // swallowed below on purpose.
  if (!opt.target.startsWith('darwin-')) {
    try {
      execSync(`llvm-strip --strip-all ${path.join(out, binName)}`, {
        stdio: 'ignore'
      })
    } catch {
      try {
        execSync(`strip ${path.join(out, binName)}`, { stdio: 'ignore' })
      } catch {
        console.log('warning: could not strip bare runtime binary')
      }
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
console.log(
  'prepared',
  out,
  mb + ' MB',
  opt.bare ? '(bare mode, target ' + opt.target + ')' : ''
)
