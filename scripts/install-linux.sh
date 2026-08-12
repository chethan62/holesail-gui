#!/usr/bin/env bash
# One-shot Linux install for holesail-gui.
#
# Builds the AppImage (worker assets + release bundle), installs it to
# ~/Applications, and writes the desktop entry + icon. Idempotent — safe to
# re-run after code changes.
#
# Usage:
#   scripts/install-linux.sh            # build + install
#   scripts/install-linux.sh --no-build # install the existing bundle
#
# Notes:
#   - The AppImage step needs no FUSE (APPIMAGE_EXTRACT_AND_RUN) and
#     NO_STRIP (linuxdeploy's bundled strip chokes on .relr.dyn).
#   - Installing over a RUNNING AppImage fails with "Text file busy" —
#     quit Holesail GUI (or `systemctl --user stop holesail-gui-app`)
#     before re-running.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$HOME/Applications"
APPIMAGE_NAME="holesail-gui.AppImage"
BUNDLE_DIR="$REPO/src-tauri/target/release/bundle/appimage"

BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

if [ "$BUILD" = 1 ]; then
  cd "$REPO"
  node scripts/prepare-resources.mjs --bare
  NO_STRIP=1 APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --bundles appimage
fi

APPIMAGE="$(ls -1t "$BUNDLE_DIR"/holesail-gui_*.AppImage 2>/dev/null | head -1)"
[ -n "$APPIMAGE" ] || {
  echo "error: no AppImage in $BUNDLE_DIR — run without --no-build first" >&2
  exit 1
}

mkdir -p "$APP_DIR" "$HOME/.local/share/applications" \
  "$HOME/.local/share/icons/hicolor/128x128/apps"

if ! cp "$APPIMAGE" "$APP_DIR/$APPIMAGE_NAME" 2>/tmp/hgui-install-err; then
  if grep -q 'Text file busy' /tmp/hgui-install-err; then
    echo "error: $APP_DIR/$APPIMAGE_NAME is running — quit Holesail GUI first" >&2
  else
    cat /tmp/hgui-install-err >&2
  fi
  rm -f /tmp/hgui-install-err
  exit 1
fi
rm -f /tmp/hgui-install-err

cp "$REPO/packaging/appimage/launch.sh" "$APP_DIR/launch.sh"
chmod +x "$APP_DIR/launch.sh"
cp "$REPO/src-tauri/icons/128x128.png" "$APP_DIR/holesail-gui.png"
cp "$REPO/src-tauri/icons/128x128.png" \
  "$HOME/.local/share/icons/hicolor/128x128/apps/holesail-gui.png"

sed "s|@APPDIR@|$APP_DIR|" "$REPO/packaging/appimage/holesail-gui.desktop" \
  > "$HOME/.local/share/applications/holesail-gui.desktop"

echo "installed: $APP_DIR/$APPIMAGE_NAME"
echo "launcher:  $APP_DIR/launch.sh"
echo "menu:      $HOME/.local/share/applications/holesail-gui.desktop"
echo "run:       systemd-run --user --unit=holesail-gui-app $APP_DIR/launch.sh"
