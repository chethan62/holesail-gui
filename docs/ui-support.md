# What the UI can rely on (the webview ceiling)

[Engines](#engines) · [Measured status](#measured-status) · [The ceiling](#the-ceiling) · [The rule](#the-rule) · [Re-measuring](#re-measuring)

The renderer is HTML/CSS/JS inside a platform webview, and the Linux build does
**not** use the system engine: it carries its own WebKitGTK inside the AppImage.
So "can I use this CSS feature?" has one correct answer here — the one measured
in the engine that is loaded — and it is not the same as Safari's, or as the
engine on a newer distro.

## Engines

| Where                                        | Engine                               | Version                                                  |
| -------------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| **Linux, packaged** (AppImage `.deb` `.rpm`) | WebKitGTK **bundled in the payload** | **2.50.4** — measured, see [Re-measuring](#re-measuring) |
| Linux, dev/debug build                       | system `libwebkit2gtk-4.1`           | whatever the distro ships (this box: 2.52.6)             |
| macOS                                        | WKWebView                            | follows the OS version (not measured here)               |
| Windows                                      | WebView2 (Evergreen runtime)         | follows the installed runtime (not measured here)        |
| Android                                      | System WebView                       | follows the device (not measured here)                   |

The running app loads the payload's copy, not the system's — verified by reading
the process maps of the live app (`/proc/<pid>/maps` →
`/tmp/.mount_*/usr/lib/libwebkit2gtk-4.1.so.0`). A newer engine on the user's
machine therefore changes nothing.

## Measured status

Measured 2026-09-25 with `scripts/webkit-support.py` (system engine) and the C
probe in [Re-measuring](#re-measuring) (bundled engine). `NO` means the probe
could not do it, not that it is hard to do.

<details>
<summary><strong>31 features, shipped 2.50.4 vs this box's system 2.52.6</strong></summary>

| Feature                            | 2.50.4 (shipped) | 2.52.6 (system, this box) |
| ---------------------------------- | :--------------: | :-----------------------: |
| `:has()`                           |       yes        |            yes            |
| `:focus-visible`                   |       yes        |            yes            |
| `:is()` / `:where()`               |       yes        |            yes            |
| `:user-invalid`                    |       yes        |            yes            |
| container queries                  |       yes        |            yes            |
| container style queries            |       yes        |            yes            |
| container `scroll-state()` queries |       yes        |            yes            |
| `@scope`                           |       yes        |            yes            |
| `@starting-style`                  |       yes        |            yes            |
| CSS nesting                        |       yes        |            yes            |
| `popover` attribute                |       yes        |            yes            |
| `popover=hint`                     |      **NO**      |          **NO**           |
| `<dialog>` (+ `showModal`)         |       yes        |            yes            |
| `dialog.closedBy`                  |      **NO**      |          **NO**           |
| `button.commandForElement`         |      **NO**      |            yes            |
| `inert`                            |       yes        |            yes            |
| `color-mix()`                      |       yes        |            yes            |
| `oklch()`                          |       yes        |            yes            |
| `light-dark()`                     |       yes        |            yes            |
| `backdrop-filter`                  |       yes        |            yes            |
| view transitions                   |       yes        |            yes            |
| scroll-driven animations           |       yes        |            yes            |
| anchor positioning                 |       yes        |            yes            |
| `subgrid`                          |       yes        |            yes            |
| `scrollbar-color`                  |      **NO**      |            yes            |
| `text-wrap: balance` / `pretty`    |       yes        |            yes            |
| `text-box-trim`                    |       yes        |            yes            |
| `field-sizing`                     |      **NO**      |            yes            |
| `calc-size()` / `interpolate-size` |      **NO**      |          **NO**           |
| `appearance: base-select`          |      **NO**      |          **NO**           |
| `prefers-reduced-transparency`     |       yes        |            yes            |

**24/31 supported at 2.50.4.** Nothing the app currently uses is on the list of
misses — the renderer's CSS is tokens, grid/flex and transitions.

</details>

## The ceiling

Unavailable in the **shipped** engine, so unavailable in the product:

- `scrollbar-color` — present in 2.52.6, absent at 2.50.4. Style scrollbars with
  the platform's own appearance instead.
- `field-sizing` — present in 2.52.6, absent at 2.50.4.
- `button.commandForElement` — present in 2.52.6, absent at 2.50.4.
- `popover=hint`, `dialog.closedBy`, `calc-size()`/`interpolate-size`,
  `appearance: base-select` — absent in both.

The first three arrive the day the payload's engine moves (a newer Ubuntu runner
in `.github/workflows/build.yml`); the last four are a "someday" list. Until
then, anything relying on them fails quietly at runtime, which is why this page
exists.

## The rule

Any new CSS or JS API gets a line in the table above **with the version that
supports it**, measured against the engine — never inferred from another
browser's support tables. WebKitGTK is not Safari and not the system webview:
`scrollbar-color` is `NO` at 2.50.4 and `yes` at 2.52.6, and a "supported in
Safari 18" note would have been wrong for both.

## Re-measuring

<details>
<summary><strong>Version out of the shipped payload (no install, no compile)</strong></summary>

`--appimage-extract` then ask the bundled library its own version — this is the
number the doc above quotes:

```sh
~/Applications/holesail-gui.AppImage --appimage-extract
/usr/bin/python3 - <<'PY'
import ctypes
lib = ctypes.CDLL("squashfs-root/usr/lib/libwebkit2gtk-4.1.so.0")
print(".".join(str(getattr(lib, f"webkit_get_{k}_version")()) for k in ("major", "minor", "micro")))
PY
```

Which engine the running app actually loaded:

```sh
grep -o '/[^ ]*libwebkit2gtk-4.1.so.0' "/proc/$(systemctl --user show -p MainPID --value hg-app.service)/maps"
```

</details>

<details>
<summary><strong>Features in the system engine</strong></summary>

```sh
GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  /usr/bin/python3 scripts/webkit-support.py          # add --json for machines
```

Needs PyGObject with WebKit2-4.1 (the system python, not the project tooling) and
a display; the window is an `OffscreenWindow`, so none appears. `GDK_BACKEND=x11`
is not optional on Wayland — GDK aborts with no GL context otherwise, the same
reason the AppImage's own launch hook forces it.

</details>

<details>
<summary><strong>Features in the shipped (bundled) engine</strong></summary>

The payload ships no typelibs, so PyGObject cannot drive it: a probe compiled
against the system headers has to call into the bundled library, which works
because the 4.1 C ABI is stable. Compile the probe once, then run it with the
payload's libraries in front — the same trick the app's own rpath uses.

```sh
A=/tmp/ai-b4/squashfs-root                      # from --appimage-extract
gcc -O2 -o wksupport wksupport.c $(pkg-config --cflags --libs gtk+-3.0 webkit2gtk-4.1)

mkdir -p $A/farm/lib/x86_64-linux-gnu
cp -a $A/usr/lib/libwebkit2gtk-4.1.so.0 $A/usr/lib/libjavascriptcoregtk-4.1.so.0 \
      $A/usr/lib/libicu*.so.70 $A/usr/lib/libxml2.so.2 $A/farm/
cp -a $A/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1 $A/farm/lib/x86_64-linux-gnu/

cd $A/farm && LD_LIBRARY_PATH=$A/farm GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 /tmp/wksupport
```

Three things bite: the bundled WebKit needs the payload's own ICU 70 and
JavaScriptCore, its helper processes are resolved **relative to the process
working directory** (`./lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess`, so
run from the directory that contains them), and the base stack (glib, GTK,
pango, libmount, libpcre2…) must come from the system or the probe will not
start at all. The output names the engine it loaded, so a run cannot claim a
version it did not measure.

</details>
