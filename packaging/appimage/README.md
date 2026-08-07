# AppImage packaging

The AppImage is produced by the regular build:

```bash
npm run build        # needs FUSE; on FUSE-less / old-strip machines:
NO_STRIP=1 APPIMAGE_EXTRACT_AND_RUN=1 npx tauri build --bundles appimage
# artifact: src-tauri/target/release/bundle/appimage/holesail-gui_0.1.0_amd64.AppImage
```

## Install (no root needed)

```bash
mkdir -p ~/Applications
cp src-tauri/target/release/bundle/appimage/holesail-gui_*.AppImage ~/Applications/holesail-gui.AppImage
cp packaging/appimage/launch.sh ~/Applications/
cp src-tauri/icons/128x128.png ~/Applications/holesail-gui.png

# desktop entry
sed "s|@APPDIR@|$HOME/Applications|" \
  packaging/appimage/holesail-gui.desktop > ~/.local/share/applications/holesail-gui.desktop
```

`launch.sh` redirects the XDG dirs next to the app when they would otherwise
point into an unwritable `$HOME`; on normal desktops it is harmless (unset
`XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `XDG_DATA_HOME` to use system defaults).

The worker is a `node` process, so end-user machines need Node.js 18+ on PATH.
