#!/bin/sh
# Launcher for the holesail-gui desktop app.
# The real binary + worker + node_modules live together in /usr/lib/holesail-gui
# so Tauri's resource_dir() resolves to the right place.
exec /usr/lib/holesail-gui/holesail-gui "$@"
