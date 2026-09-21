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
      dependencies: { holesail: '^2.4.1', 'bare-http1': '^4.0.2' }
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

// livefiles is GPLv3 and only reachable from holesail's CLI
// (`holesail --filemanager <dir>`, i.e. src/bin/holesail.mjs) — this app runs
// holesail's Engine, never its CLI, and its own file server is worker/
// fileserver.js (MIT). holesail declares it as a plain dependency, so npm
// installs it and every installer would redistribute GPL code this MIT project
// neither uses nor means to ship. Verified rather than assumed: requiring both
// `holesail` and `holesail-server` resolves with node_modules/livefiles absent
// (the filemanager test and the saved-credential E2E then exercise a folder
// share end to end on a pruned tree), and `grep -rn` finds no other require.
const livefilesDir = path.join(out, 'node_modules', 'livefiles')
if (existsSync(livefilesDir)) {
  rmSync(livefilesDir, { recursive: true, force: true })
  if (existsSync(livefilesDir)) {
    throw new Error('livefiles is still in the bundle — refusing to build')
  }
}

// Copyleft packages that publish no licence file of their own.
//
// Same obligation as livefiles had (v0.9.5), and the sweep for v0.12.6 found it
// three more times: holesail-server, holesail-logger and barely-colours are all
// holesail's own dependencies, all declare GPL-3.0/AGPL-3.0 in their manifests,
// and none ships a licence text — so every installer redistributed them without
// the licence their terms require be passed on. They cannot be pruned like
// livefiles: requiring holesail pulls them in at runtime.
//
// The texts are copied from copies ALREADY inside the installed tree rather than
// from a vendored file in this repo: `holesail/LICENSE` is the AGPL-3.0 text and
// `holesail-client/LICENSE.txt` the GPL-3.0 one, both shipped by upstream and
// both then carried into every installer by the same resource mapping. The title
// line of each source is asserted so an upstream text change cannot silently
// vendor the wrong licence, and every package we add a text to is re-checked
// afterwards.
//
// holesail-server declares "GNU GPL v3" in its npm manifest while its repository
// carries AGPL-3.0, so both texts land next to it: a redistributor with
// inconsistent upstream metadata is better off shipping both than guessing.
// The texts are DERIVED from each installed package's own declaration rather
// than from a hand-written list — that list was wrong within the hour (it gave
// holesail-logger the AGPL text while installed 1.1.0 declares "GPL 3.0", and
// npm's 2.0.0 is the one that says AGPL). A new copyleft dependency is now
// covered automatically; a licence family we hold no text for fails the build
// rather than silently shipping nothing.
const LICENCE_TEXTS = {
  AGPL: {
    from: 'holesail/LICENSE',
    title: 'GNU AFFERO GENERAL PUBLIC LICENSE',
    dest: 'LICENSE.AGPL-3.0.txt'
  },
  GPL: {
    from: 'holesail-client/LICENSE.txt',
    title: 'GNU GENERAL PUBLIC LICENSE',
    dest: 'LICENSE.GPL-3.0.txt'
  }
}
// Packages whose metadata contradicts itself get every text it mentions.
const BOTH_TEXTS = new Set(['holesail-server'])

const nmDir = path.join(out, 'node_modules')
const allManifests = []
const collect = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = path.join(dir, entry.name)
    if (entry.name.startsWith('@')) collect(child)
    else if (existsSync(path.join(child, 'package.json')))
      allManifests.push(child)
    if (
      entry.name !== 'node_modules' &&
      existsSync(path.join(child, 'node_modules'))
    ) {
      collect(path.join(child, 'node_modules'))
    }
  }
}
collect(nmDir)

for (const pkgDir of allManifests) {
  const manifest = JSON.parse(
    readFileSync(path.join(pkgDir, 'package.json'), 'utf-8')
  )
  const declared = String(manifest.license || '')
  const upper = declared.toUpperCase()
  if (!/\b(A?GPL)/.test(upper)) continue
  // A package whose metadata contradicts itself (manifest GPL, repository
  // AGPL) gets every text it mentions; everything else is derived.
  const fams = BOTH_TEXTS.has(manifest.name) ? ['GPL', 'AGPL'] : []
  if (fams.length === 0) {
    if (upper.includes('AGPL')) fams.push('AGPL')
    if (/(^|[^LA])GPL/.test(upper)) fams.push('GPL')
  }
  if (upper.includes('LGPL')) {
    throw new Error(
      `${manifest.name} declares ${declared} and this build holds no LGPL text — add one to LICENCE_TEXTS`
    )
  }
  if (fams.length === 0) continue
  const hasOwn = readdirSync(pkgDir).some((f) =>
    /^(LICEN|COPYING|NOTICE)/i.test(f)
  )
  if (hasOwn) continue // upstream ships its own; leave it alone
  for (const fam of [...new Set(fams)]) {
    const { from, title, dest } = LICENCE_TEXTS[fam]
    const src = path.join(nmDir, from)
    if (!existsSync(src)) {
      throw new Error(
        `no ${fam} text to vendor (looked for ${from}) — refusing to build`
      )
    }
    if (!readFileSync(src, 'utf-8').includes(title)) {
      throw new Error(`${from} is not the ${fam} text — refusing to build`)
    }
    const target = path.join(pkgDir, dest)
    cpSync(src, target)
    if (!existsSync(target)) {
      throw new Error(
        `licence text did not land in ${manifest.name} — refusing to build`
      )
    }
  }
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
