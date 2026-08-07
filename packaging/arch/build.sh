#!/usr/bin/env bash
# Builds an Arch Linux package (.pkg.tar.zst) for holesail-gui.
# Requires: the repo's npm deps installed, cargo toolchain, and `makepkg`.
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

echo "==> preparing resources (dist-resources/)"
(cd "$REPO_ROOT" && node scripts/prepare-resources.mjs >/dev/null)

echo "==> building unpatched release binary"
# force a relink: tauri's bundler patch (__TAURI_BUNDLE_TYPE__) persists in
# target/release after a `tauri build` with bundling; we need resource_dir to
# resolve to the exe dir (both binary + resources live in /usr/lib/holesail-gui)
(cd "$REPO_ROOT/src-tauri" && touch src/main.rs && cargo build --release >/dev/null)

echo "==> copying release binary + resources"
cp "$REPO_ROOT/src-tauri/target/release/holesail-gui" ./holesail-gui-bin
rm -f ./resources.tar.zst
(cd "$REPO_ROOT/dist-resources" && tar --zstd -cf "$OLDPWD/resources.tar.zst" service-worker.js node_modules)
cp "$REPO_ROOT/src-tauri/icons/128x128.png" ./holesail-gui.png

echo "==> running makepkg"
makepkg -f
