/* scripts/android-glue.mjs
 *
 * Wires the bare-runtime worker bundle into the generated Tauri Android
 * project (src-tauri/gen/android, regenerated on demand):
 *   1. copies dist-resources-android/ -> app/src/main/assets/bare/
 *      (gradle packages that into the APK as assets)
 *   2. writes BareAssets.kt — extracts the assets to filesDir/bare on
 *      first launch (Android assets are not real filesystem paths, and
 *      the Rust side needs a real path to spawn the bare binary)
 *   3. patches MainActivity.kt to run the extraction before Tauri starts
 *
 * Run AFTER `tauri android init` and BEFORE `tauri android build`.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const args = process.argv.slice(2)
let bundleArg = 'dist-resources-android'
let abi = 'android-arm64'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bundle') bundleArg = args[i + 1]
  else if (args[i] === '--abi') abi = args[i + 1]
}

// NDK sysroot triple for each Android ABI (for libc++_shared.so)
const NDK_TRIPLES = {
  'android-arm64': 'aarch64-linux-android',
  'android-arm': 'arm-linux-androideabi',
  'android-x64': 'x86_64-linux-android',
  'android-ia32': 'i686-linux-android'
}

// Android ABI directory names used by the APK packaging
const ABI_DIRS = {
  'android-arm64': 'arm64-v8a',
  'android-arm': 'armeabi-v7a',
  'android-x64': 'x86_64',
  'android-ia32': 'x86'
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(root, bundleArg)
const GEN = path.join(root, 'src-tauri', 'gen', 'android')

if (!existsSync(BUNDLE)) {
  console.error(
    `${bundleArg}/ not found. Build it first:\n` +
      `  node scripts/prepare-resources.mjs --bare --target <platform-arch> --out ${bundleArg}`
  )
  process.exit(1)
}

// 1. ensure the android project exists
if (!existsSync(path.join(GEN, 'settings.gradle'))) {
  console.log('gen/android missing — running tauri android init...')
  execSync('npx tauri android init --ci --skip-targets-install', { cwd: root, stdio: 'inherit' })
}

// 2. copy the bundle into the APK assets
const assets = path.join(GEN, 'app', 'src', 'main', 'assets', 'bare')
rmSync(assets, { recursive: true, force: true })
mkdirSync(assets, { recursive: true })
cpSync(BUNDLE, assets, { recursive: true })
// the bare runtime is shipped ONLY as a jniLibs library (step 2c) — the
// Rust side spawns it from the native lib dir, so the 60 MB duplicate in
// assets would only bloat the APK
rmSync(path.join(assets, 'bare'), { recursive: true, force: true })
console.log('copied', BUNDLE, '->', assets, '(bare runtime excluded — jniLibs only)')

// 2b. udx-native links against libc++_shared.so (the sodium addon does not).
// The bare worker is spawned OUTSIDE the zygote linker namespace, so the
// C++ STL must ship next to it; the Rust side sets LD_LIBRARY_PATH to the
// extracted bundle dir. Take the library from the NDK sysroot.
const ndkHome = process.env.NDK_HOME || findNdkHome()
if (!ndkHome) {
  console.error('NDK not found — set NDK_HOME (needed for libc++_shared.so)')
  process.exit(1)
}
const triple = NDK_TRIPLES[abi]
if (!triple) {
  console.error('Unknown --abi', abi, '(expected android-arm64|android-arm|android-x64|android-ia32)')
  process.exit(1)
}
const libcxx = path.join(
  ndkHome,
  'toolchains',
  'llvm',
  'prebuilt',
  'linux-x86_64',
  'sysroot',
  'usr',
  'lib',
  triple,
  'libc++_shared.so'
)
if (!existsSync(libcxx)) {
  console.error('libc++_shared.so not found at', libcxx)
  process.exit(1)
}
cpSync(libcxx, path.join(assets, 'libc++_shared.so'))
console.log('bundled', libcxx)

// 2c. SELinux: untrusted_app (targetSdk >= 26) cannot exec() files from
// its own data dir (app_data_file), but CAN exec apk_data_file — the
// APK's native lib dir. So the bare runtime is shipped as a jniLibs
// library: it lands in /data/app/.../lib/<abi>/ at install time, which
// is where the Rust side spawns it from.
const androidAbi = ABI_DIRS[abi]
if (!androidAbi) {
  console.error('Unknown --abi', abi)
  process.exit(1)
}
const jniLibs = path.join(GEN, 'app', 'src', 'main', 'jniLibs', androidAbi)
mkdirSync(jniLibs, { recursive: true })
cpSync(path.join(BUNDLE, 'bare'), path.join(jniLibs, 'libholesail_bare.so'))
cpSync(libcxx, path.join(jniLibs, 'libc++_shared.so'))
console.log('jniLibs:', androidAbi, '(libholesail_bare.so + libc++_shared.so)')

function findNdkHome() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (!sdk) return null
  const ndkDir = path.join(sdk, 'ndk')
  if (!existsSync(ndkDir)) return null
  const versions = readdirSync(ndkDir).filter((d) => d !== '.temp')
  if (versions.length === 0) return null
  return path.join(ndkDir, versions.sort().reverse()[0])
}

// 2d. The generated manifest uses extractNativeLibs=false (libs load from
// inside the APK). The bare worker needs a REAL exec-able file on disk
// (apk_data_file), so force extraction on install.
const manifestPath = path.join(GEN, 'app', 'src', 'main', 'AndroidManifest.xml')
let manifest = readFileSync(manifestPath, 'utf8')
if (!manifest.includes('extractNativeLibs')) {
  manifest = manifest.replace('<application', '<application\n        android:extractNativeLibs="true"')
  writeFileSync(manifestPath, manifest)
  console.log('patched AndroidManifest.xml (extractNativeLibs=true)')
} else {
  console.log('AndroidManifest.xml already has extractNativeLibs')
}

// 3. write the Kotlin extractor next to MainActivity
const mainActivity = path.join(
  GEN,
  'app',
  'src',
  'main',
  'java',
  ...findMainActivityPackage(GEN).split('.')
)
const mainActivityFile = path.join(mainActivity, 'MainActivity.kt')
if (!existsSync(mainActivityFile)) {
  console.error('MainActivity.kt not found at', mainActivityFile)
  process.exit(1)
}

const bareAssets = `package ${findMainActivityPackage(GEN)}

import android.content.Context
import java.io.File

/**
 * Extracts the bundled bare-runtime worker bundle from the APK assets into
 * filesDir/bare on first launch. Android assets are not real filesystem
 * paths, and the Rust backend needs a real path to spawn the \`bare\`
 * binary, so the whole tree is copied out once.
 */
object BareAssets {
  private const val ASSET_DIR = "bare"
  private const val TARGET_DIR = "bare"

  fun extract(context: Context) {
    val target = File(context.filesDir, TARGET_DIR)
    val marker = File(target, "service-worker.js")
    if (marker.exists() && File(target, "bare").exists()) return
    copyTree(context, ASSET_DIR, target)
    File(target, "bare").setExecutable(true, false)
  }

  private fun copyTree(context: Context, assetPath: String, target: File) {
    val children = context.assets.list(assetPath) ?: return
    target.mkdirs()
    for (name in children) {
      val src = "$assetPath/$name"
      val dst = File(target, name)
      // list() returns the child names for directories; for a file it
      // returns null on some Android versions and an EMPTY array on
      // others — so only treat a non-empty result as a directory.
      val subs = context.assets.list(src)
      if (subs != null && subs.isNotEmpty()) {
        copyTree(context, src, dst)
      } else {
        try {
          context.assets.open(src).use { input ->
            dst.outputStream().use { output -> input.copyTo(output) }
          }
        } catch (e: java.io.FileNotFoundException) {
          dst.mkdirs() // genuinely empty directory
        }
      }
    }
  }
}
`

writeFileSync(path.join(mainActivity, 'BareAssets.kt'), bareAssets)
console.log('wrote BareAssets.kt in', mainActivity)

// 4. call the extraction before Tauri's Rust init (super.onCreate)
let main = readFileSync(mainActivityFile, 'utf8')
const anchor = '    super.onCreate(savedInstanceState)'
if (!main.includes('BareAssets.extract')) {
  if (!main.includes(anchor)) {
    console.error('Could not find super.onCreate anchor in MainActivity.kt')
    process.exit(1)
  }
  main = main.replace(anchor, '    BareAssets.extract(this)\n' + anchor)
  writeFileSync(mainActivityFile, main)
  console.log('patched MainActivity.kt (extraction before super.onCreate)')
} else {
  console.log('MainActivity.kt already patched')
}

// 5. foreground service: keeps the app process (and the bare worker child)
// alive when the app is backgrounded — Android freezes backgrounded apps,
// which silently kills tunnels. The service itself does nothing; its
// foreground notification exempts the process from the freezer.
const holeService = `package ${findMainActivityPackage(GEN)}

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

class HoleService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 26) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Holesail worker",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Keeps the tunnel worker running in the background"
        setShowBadge(false)
      }
      getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
    val builder = if (Build.VERSION.SDK_INT >= 26) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      Notification.Builder(this)
    }
    startForeground(
      NOTIFICATION_ID,
      builder
        .setContentTitle("Holesail")
        .setContentText("Tunnel worker active")
        .setSmallIcon(R.drawable.ic_holesail_notification)
        .setOngoing(true)
        .build()
    )
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

  override fun onTaskRemoved(rootIntent: Intent?) {
    // user swiped the app away — release the keep-alive
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  companion object {
    private const val CHANNEL_ID = "holesail-worker"
    private const val NOTIFICATION_ID = 1

    fun start(context: Context) {
      val intent = Intent(context, HoleService::class.java)
      if (Build.VERSION.SDK_INT >= 26) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, HoleService::class.java))
    }
  }
}
`
writeFileSync(path.join(mainActivity, 'HoleService.kt'), holeService)
console.log('wrote HoleService.kt in', mainActivity)

// 5b. notification small icon (white alpha mask — plain vector, no deps)
const iconDir = path.join(GEN, 'app', 'src', 'main', 'res', 'drawable')
mkdirSync(iconDir, { recursive: true })
writeFileSync(
  path.join(iconDir, 'ic_holesail_notification.xml'),
  `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
  <!-- two linked nodes: reads as a network link, not a camera -->
  <path
      android:fillColor="#FFFFFFFF"
      android:pathData="M8.5,12 a2.5,2.5 0 1,1 -5,0 a2.5,2.5 0 1,1 5,0z" />
  <path
      android:fillColor="#FFFFFFFF"
      android:pathData="M20.5,12 a2.5,2.5 0 1,1 -5,0 a2.5,2.5 0 1,1 5,0z" />
  <path
      android:strokeColor="#FFFFFFFF"
      android:strokeWidth="2"
      android:strokeLineCap="round"
      android:pathData="M8.5,12 L15.5,12" />
</vector>
`
)
console.log('wrote ic_holesail_notification.xml')

// 5c. activity wiring: start the service while the UI is alive, request the
// notification permission (API 33+), stop on destroy
if (!main.includes('HoleService.start')) {
  main = main
    .replace(
      'import android.os.Bundle',
      'import android.os.Build\nimport android.os.Bundle'
    )
    .replace(
      '    super.onCreate(savedInstanceState)\n  }\n}',
      `    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 33) {
      requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
    }
  }

  override fun onStart() {
    super.onStart()
    HoleService.start(this)
  }

  override fun onDestroy() {
    HoleService.stop(this)
    super.onDestroy()
  }
}`
    )
  writeFileSync(mainActivityFile, main)
  console.log('patched MainActivity.kt (foreground service wiring)')
} else {
  console.log('MainActivity.kt already has foreground service wiring')
}

// 5d. manifest: service declaration + permissions
const manifestPath2 = path.join(GEN, 'app', 'src', 'main', 'AndroidManifest.xml')
let manifest2 = readFileSync(manifestPath2, 'utf8')
if (!manifest2.includes('HoleService')) {
  manifest2 = manifest2
    .replace(
      '<uses-permission android:name="android.permission.INTERNET" />',
      '<uses-permission android:name="android.permission.INTERNET" />\n' +
        '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n' +
        '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />\n' +
        '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />'
    )
    .replace(
      '    </application>',
      '        <service\n' +
        '            android:name=".HoleService"\n' +
        '            android:exported="false"\n' +
        '            android:foregroundServiceType="specialUse">\n' +
        '            <property\n' +
        '                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"\n' +
        '                android:value="peer-to-peer tunnel worker" />\n' +
        '        </service>\n' +
        '    </application>'
    )
  writeFileSync(manifestPath2, manifest2)
  console.log('patched AndroidManifest.xml (foreground service)')
} else {
  console.log('AndroidManifest.xml already has foreground service')
}

function findMainActivityPackage(genDir) {
  // AGP 8+: the app package is the gradle `namespace`, not a manifest attr
  const gradle = readFileSync(path.join(genDir, 'app', 'build.gradle.kts'), 'utf8')
  const m = gradle.match(/namespace\s*=\s*"([\w.]+)"/)
  if (m) return m[1]
  const manifest = readFileSync(path.join(genDir, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8')
  const mm = manifest.match(/package\s*=\s*"([\w.]+)"/)
  if (mm) return mm[1]
  throw new Error('Could not determine app package from build.gradle.kts / AndroidManifest.xml')
}
