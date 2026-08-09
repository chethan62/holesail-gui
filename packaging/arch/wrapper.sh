#!/bin/sh
# Launcher for the holesail-gui desktop app.
# The real binary + worker + node_modules live together in /usr/lib/holesail-gui
# so Tauri's resource_dir() resolves to the right place.
# WEBKIT_DISABLE_DMABUF_RENDERER avoids blank-webview rendering glitches on
# NVIDIA systems (same workaround as the flatpak manifest).
export WEBKIT_DISABLE_DMABUF_RENDERER=1
exec /usr/lib/holesail-gui/holesail-gui "$@"
