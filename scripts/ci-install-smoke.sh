#!/usr/bin/env bash
# Smoke test for scripts/install-linux.sh: runs the REAL installer into a
# throwaway HOME and asserts what it promises. Uses --no-build, so it expects
# an AppImage already in the bundle dir (CI builds one; see build.yml).
#
# Two directions, per the repo rule that a check which only exercises success
# is worse than no check:
#   1) a good run installs everything and MIGRATES state correctly
#   2) a missing AppImage fails loudly instead of half-installing
#
# Usage: bash scripts/ci-install-smoke.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_DIR="$REPO/src-tauri/target/release/bundle/appimage"
fail() { echo "ASSERT FAILED: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

SRC_APPIMAGE="$(ls -1t "$BUNDLE_DIR"/holesail-gui_*.AppImage 2>/dev/null | head -1 || true)"
[ -n "$SRC_APPIMAGE" ] || fail "no AppImage in $BUNDLE_DIR — build one first"

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
export HOME="$SANDBOX"
export XDG_DATA_HOME="$SANDBOX/.local/share"

# Seed state in the OLD location the installer migrates away from, with a
# known event log so the merge order (oldest first) is checkable.
OLD_STATE="$HOME/Applications/.local/config/io.holesail.gui"
mkdir -p "$OLD_STATE" "$HOME/.config/io.holesail.gui"
printf 'OLD-LINE\n' > "$OLD_STATE/event-log.txt"
printf '{"seeded":true}\n' > "$OLD_STATE/settings.json"
printf 'NEW-LINE\n' > "$HOME/.config/io.holesail.gui/event-log.txt"

echo "1) a good run"
bash "$REPO/scripts/install-linux.sh" --no-build > "$SANDBOX/install.log" 2>&1 \
  || { cat "$SANDBOX/install.log" >&2; fail "installer exited non-zero"; }

[ -f "$HOME/Applications/holesail-gui.AppImage" ] || fail "AppImage not installed"
cmp -s "$SRC_APPIMAGE" "$HOME/Applications/holesail-gui.AppImage" \
  || fail "installed AppImage differs from the built one"
pass "AppImage installed byte-identically"

[ -x "$HOME/Applications/launch.sh" ] || fail "launch.sh missing or not executable"
[ -f "$HOME/.local/share/icons/hicolor/128x128/apps/holesail-gui.png" ] \
  || fail "theme icon not installed"
[ -f "$HOME/Applications/holesail-gui.png" ] || fail "app-dir icon not installed"
pass "launcher + icons installed"

ENTRY="$HOME/.local/share/applications/holesail-gui.desktop"
[ -f "$ENTRY" ] || fail "desktop entry not written"
grep -q "@APPDIR@" "$ENTRY" && fail "desktop entry still contains the @APPDIR@ placeholder"
grep -q "$HOME/Applications" "$ENTRY" || fail "desktop entry does not point at the install dir"
pass "desktop entry written with real paths"

MERGED="$HOME/.config/io.holesail.gui/event-log.txt"
[ "$(cat "$MERGED")" = "$(printf 'OLD-LINE\nNEW-LINE')" ] \
  || fail "event log merge wrong (want old content first, then new): $(cat "$MERGED")"
pass "event log merged oldest-first"

[ -f "$HOME/.config/io.holesail.gui/settings.json" ] || fail "settings.json not migrated"
grep -q 'seeded' "$HOME/.config/io.holesail.gui/settings.json" || fail "settings.json migrated with wrong content"
[ ! -d "$OLD_STATE" ] || fail "old state dir left behind after a clean migration"
pass "state migrated and old dir removed"

HANDLER="$HOME/.local/share/applications/holesail-gui-handler.desktop"
[ -f "$HANDLER" ] || fail "hs:// scheme handler not installed"
grep -q 'x-scheme-handler/hs' "$HANDLER" || fail "handler does not declare x-scheme-handler/hs"
grep -q '@APPDIR@' "$HANDLER" && fail "handler still contains the @APPDIR@ placeholder"
grep -q "$HOME/Applications" "$HANDLER" || fail "handler does not point at the install dir"
grep -q '%u' "$HANDLER" || fail "handler does not accept a URL argument"
pass "hs:// scheme handler installed and templated"
CACHE="$HOME/.local/share/applications/mimeinfo.cache"
if command -v update-desktop-database >/dev/null 2>&1; then
  grep -q 'x-scheme-handler/hs' "$CACHE" || fail "desktop database did not index the handler ($CACHE)"
  pass "desktop database lists the handler"
else
  echo "  skip: update-desktop-database not available here"
fi

echo "2) a missing AppImage fails loudly"
mv "$SRC_APPIMAGE" "$SRC_APPIMAGE.hidden"
set +e
OUT="$(bash "$REPO/scripts/install-linux.sh" --no-build 2>&1)"
RC=$?
set -e
mv "$SRC_APPIMAGE.hidden" "$SRC_APPIMAGE"
[ "$RC" -ne 0 ] || fail "installer exited 0 with no AppImage available"
echo "$OUT" | grep -q "no AppImage" || fail "installer did not explain the missing AppImage (got: $OUT)"
pass "missing bundle rejected"

echo "ALL INSTALLER SMOKE CHECKS PASSED"
