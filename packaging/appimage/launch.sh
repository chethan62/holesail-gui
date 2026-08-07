#!/usr/bin/env bash
# Launcher for the portable holesail-gui AppImage.
#
# On machines where $HOME is read-only (like this sandbox), Tauri/WebKit
# cannot write ~/.config etc.; this redirects the XDG dirs next to the app
# (a writable location). On normal desktops the redirect is harmless —
# unset XDG_CONFIG_HOME/XDG_CACHE_HOME/XDG_DATA_HOME to use the defaults.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$DIR/.local/config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$DIR/.local/cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$DIR/.local/data}"
exec env APPIMAGE_EXTRACT_AND_RUN=1 "$DIR/holesail-gui.AppImage" "$@"
