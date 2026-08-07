#!/usr/bin/env bash
# Builds a Flatpak (io.holesail.gui) for holesail-gui.
# Requirements:
#   flatpak, flatpak-builder, and the freedesktop runtimes:
#     flatpak install flathub org.freedesktop.Sdk//24.08 org.freedesktop.Platform//24.08
#     flatpak install flathub org.freedesktop.Sdk.Extension.webkit2gtk-4.1//24.08
# Run:
#   ./build.sh
#   flatpak run io.holesail.gui
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

echo "==> preparing resources (dist-resources/)"
(cd "$REPO_ROOT" && node scripts/prepare-resources.mjs >/dev/null)

echo "==> building unpatched release binary"
(cd "$REPO_ROOT/src-tauri" && touch src/main.rs && cargo build --release >/dev/null)

echo "==> building flatpak"
flatpak-builder --user --install --force-clean build-dir io.holesail.gui.yml
