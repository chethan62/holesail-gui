#!/usr/bin/env bash
# Launcher for the portable holesail-gui AppImage.
#
# On machines where $HOME is read-only, Tauri/WebKit cannot write
# ~/.config etc.; in that case only, the XDG dirs are redirected next to
# the app. On normal desktops the default XDG dirs are used, so app state
# (saved tunnels, event log) lives in ~/.config/io.holesail.gui no matter
# how the app was launched (direct AppImage, .desktop, terminal) —
# an unconditional redirect split state across launch paths.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# NVIDIA/Wayland: WebKitGTK DMABUF path fails (GBM buffer errors) and the
# WebView renders blank white. Force the non-DMABUF renderer.
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
if [ ! -w "$HOME" ]; then
  export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$DIR/.local/config}"
  export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$DIR/.local/cache}"
  export XDG_DATA_HOME="${XDG_DATA_HOME:-$DIR/.local/data}"
fi
exec env APPIMAGE_EXTRACT_AND_RUN=1 "$DIR/holesail-gui.AppImage" "$@"
