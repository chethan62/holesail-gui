# Releasing

The updater (tauri-plugin-updater) makes releases load-bearing: the
release job publishes signed artifacts + `latest.json`, and every
installed desktop build checks that manifest at boot. A bad
version/tag pairing or a missing signature breaks update checks for
everyone on that release.

## One-time prerequisites

- GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` +
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (already set). Without them the
  release job skips `latest.json` and the updater endpoint 404s.
- The pubkey embedded in `src-tauri/tauri.conf.json`
  (`plugins.updater.pubkey`) must match the release key. Verify locally:
  sign a file with the key, extract the base64 block, decode it, and
  `minisign -Vm <file> -p <decoded-pubkey> -x <raw-sig>` (see the
  `scripts/update-manifest.mjs` header for the full recipe).

## Cut a release

1. Master must be green: test → clippy → ui-smoke →
   linux/windows/macos/android.
2. Bump the version if the content warrants it — BOTH
   `src-tauri/tauri.conf.json` (`version`) and `src-tauri/Cargo.toml`
   (`version`) must match the tag `vX.Y.Z`.
3. Commit the bump (fast-forward to master, no PRs).
4. Tag and push:
   ```
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   The `v*` push triggers the build workflow; the release job
   (refs/tags/v*) waits for the four platform builds, signs the
   artifacts, writes `latest.json` + `.sig`, and creates the GitHub
   release with `--generate-notes` (`fetch-depth: 0` already
   configured).
5. Verify the run: `gh run watch <id>` — the release job must complete.
   The Windows MSI bundle step is the flakiest spot
   (`io: Peer disconnected` mid-WiX — the job caches WiX tools and
   retries the build 3×; re-run failed jobs rather than re-tagging if
   anything still flakes).
6. Verify the manifest:
   ```
   curl -sL https://github.com/chethan62/holesail-gui/releases/latest/download/latest.json
   ```
   → `version` == X.Y.Z and every platform entry carries `url` +
   `signature`.
7. Verify in-app on the installed desktop build: click the topbar ⬆
   button — "You are up to date" toast (or the update toast on an older
   installed version). The event log records the result.

## Notes

- `scripts/update-manifest.mjs` extracts ONLY the `Public signature:`
  base64 block from `tauri signer sign` output — the plugin
  base64-decodes the `signature` field before minisign verification
  (tauri-plugin-updater 2.x `src/updater.rs` `verify_signature`).
- Platform mapping: AppImage → `linux-x86_64`, `.msi` →
  `windows-x86_64`, `.dmg` → `darwin-*`.
- Windows/macOS updater paths are built + manifested by CI but not yet
  exercised on real machines — test when hardware is available.
- AppImage updates replace `~/Applications/holesail-gui.AppImage`;
  `launch.sh` and the desktop entry stay valid across updates (the
  WebKit renderer fallback also lives in `main.rs`, so any launch path
  is covered).

## Updater test pass (Windows/macOS) — TODO before next hardware release

The updater is load-bearing but the Windows/macOS update path has never
been exercised on real hardware. When a Windows or macOS machine is
available:

1. Install the previous release's .msi/.exe or .dmg/.app.
2. Launch; confirm it checks the updater (event log shows
   "Update available" or a version check).
3. Optionally: `hole-sail-gui` version must be < latest.json version
   for an update prompt to appear. Verify the in-app ⬆ button pulls
   the new artifact, verifies the minisign signature, and relaunches.
4. Log results in this file (date, platform, result).
