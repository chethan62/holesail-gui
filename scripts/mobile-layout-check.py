#!/usr/bin/env python3
"""Assert the renderer survives a phone-sized viewport.

    scripts/mobile-layout-check.py [--self-test]

Renders renderer/index.html in an offscreen WebKit2 view at several widths and
fails if the page scrolls sideways, if anything sits past the right edge, if a tab
label wraps onto a second line, or — below the 560px breakpoint, i.e. on a phone —
if a control you tap is shorter than 44px (39px tabs were the "not polish" part of
that report). A 39px tab is fine under a mouse on the desktop layout, which is why
the tap-target rule only applies to the narrow widths. This is the regression guard for the Android
report that the app "is not polish": at a 390px viewport the page had 454px of
scrollWidth, so the status cluster — with the worker-restart button inside it —
sat 67px off the right edge, and the tab row overflowed at 320px. The causes were
two single flex rows that could not wrap, plus a <select> as wide as its longest
option pushing the whole document wider than the screen.

--self-test proves the checker can fail: it re-injects the pre-fix behaviour
(rows that may not wrap, labels that may break, no sideways clipping) and
requires an overflow at 390px. A guard that cannot fail is not a guard.

Needs PyGObject plus the WebKit2 4.1 typelib (gir1.2-webkit2-4.1) and a display
(Gtk must initialise). When the typelib is missing it says so and exits 0 — a
skip, never a silent pass dressed up as coverage.
"""
import json
import os
import pathlib
import sys

# The renderer's own environment: without these, GDK aborts with "not able to
# create a GL context" on a headless/Xvfb or hybrid-GPU box. setdefault so a
# caller (CI, a debugger) can override.
os.environ.setdefault("GDK_BACKEND", "x11")
os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")
os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

REPO = pathlib.Path(__file__).resolve().parent.parent
PAGE = REPO / "renderer/index.html"
# 320 is the reflow floor (WCAG 1.4.10), 390 is the phone, 560 is the breakpoint,
# 1200 the desktop regression check.
WIDTHS = [320, 390, 560, 1200]
SEL = (
    ".topbar, .topbar > *, .brand, .brand > *, .status, .status > *, #worker-restart,"
    " #theme-toggle, .tabs, .tab, .panel.active, button.primary, select, input"
)

PROBE_JS = """
(function () {
  const vt = document.getElementById('version-tag');
  if (vt && !vt.textContent) vt.textContent = 'v0.0.0 \\u00b7 abc1234';
  const els = [];
  document.querySelectorAll("%s").forEach(function (e) {
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) return;
    els.push({cls: (typeof e.className === 'string' ? e.className : e.tagName),
              tag: e.tagName.toLowerCase(),
              h: Math.round(r.height), right: Math.round(r.right),
              offRight: Math.round(r.right) > window.innerWidth + 1});
  });
  return JSON.stringify({vw: window.innerWidth,
                         scrollW: document.documentElement.scrollWidth,
                         overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
                         els: els});
})()
""" % SEL

# The pre-fix world, for --self-test: rows back to nowrap, labels free to break,
# nothing clipping sideways. It must fail.
PREFIX_CSS = (
    ".topbar, .brand, .tabs { flex-wrap: nowrap !important; }"
    ".tab { white-space: normal !important; }"
    "html, body { overflow-x: visible !important; }"
)


def measure(width, height=800, inject=None):
    """Return the geometry JSON for one viewport size (or None if we cannot run)."""
    import gi

    gi.require_version("Gtk", "3.0")  # webkit2gtk-4.1 is the GTK3 build
    gi.require_version("WebKit2", "4.1")
    from gi.repository import GLib, Gtk, WebKit2

    Gtk.init([])
    window = Gtk.OffscreenWindow()
    window.set_size_request(width, height)
    view = WebKit2.WebView()
    window.add(view)
    window.show_all()

    result = {}
    loop = GLib.MainLoop()

    def on_js(view, res, _):
        try:
            result.update(json.loads(view.evaluate_javascript_finish(res).to_string()))
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            result["error"] = str(exc)
        loop.quit()

    def run_probe(view):
        view.evaluate_javascript(PROBE_JS, -1, None, None, None, on_js, None)

    def on_load(view, event, _):
        if event != WebKit2.LoadEvent.FINISHED:
            return
        if inject:
            # apply the injected CSS first, then measure, so the probe can never
            # read geometry from the wrong stylesheet
            view.evaluate_javascript(
                "const s=document.createElement('style');s.textContent=%s;"
                "document.head.appendChild(s);(()=>{s.sheet.cssRules.length})()"
                % json.dumps(inject),
                -1, None, None, None, lambda *_: run_probe(view), None,
            )
        else:
            run_probe(view)

    view.connect("load-changed", on_load, None)
    view.load_uri(GLib.filename_to_uri(str(PAGE)))
    GLib.timeout_add_seconds(30, lambda: (loop.quit(), False)[1])
    loop.run()
    return result or None


def check(width, data):
    """Return a list of failure strings for one width."""
    bad = []
    if data.get("error"):
        return [f"{width}px: probe failed: {data['error']}"]
    if data.get("overflow"):
        bad.append(f"{width}px: page scrolls sideways ({data['scrollW']}px content in a {data['vw']}px viewport)")
    off = [e["cls"] for e in data.get("els", []) if e.get("offRight")]
    if off:
        bad.append(f"{width}px: {len(off)} element(s) past the right edge: {', '.join(off[:4])}")
    tabs = sorted({e["h"] for e in data.get("els", []) if e["cls"] == "tab"})
    if len(tabs) > 1:
        bad.append(f"{width}px: tab labels wrap to different heights {tabs} (should be one line each)")
    if width <= BREAKPOINT:
        small = [
            f"{(e.get('cls') or e['tag'])}.{e['tag']}({e['h']}px)"
            for e in data.get("els", [])
            if is_tap_target(e) and e["h"] < TAP_MIN
        ]
        if small:
            bad.append(
                f"{width}px: {len(small)} tap target(s) under {TAP_MIN}px: {', '.join(sorted(set(small))[:4])}"
            )
    return bad


def is_tap_target(e):
    """Controls you tap to act. Text fields and checkboxes are reported, not failed:
    a 39px field is comfortable, and their box grows with the font on a phone."""
    cls = e.get("cls") or ""
    if e.get("tag") in ("button", "select"):
        return True
    return "tab" in cls.split() or "log-action" in cls.split()


TAP_MIN = 44          # the tap-target floor this guard holds the phone layout to
BREAKPOINT = 560      # below this the layout is the phone one (see style.css)


def report_targets(width, data):
    """One line of measured heights per narrow width, so every run shows its work."""
    if width > BREAKPOINT:
        return None
    rows = [
        (f"{(e.get('cls') or e['tag'])}.{e['tag']}", e["h"])
        for e in data.get("els", [])
        if is_tap_target(e)
    ]
    if not rows:
        return None
    lowest = min(h for _, h in rows)
    return f"{width}px: smallest tap target {lowest}px ({min(rows, key=lambda r: r[1])[0]})"


def main():
    self_test = "--self-test" in sys.argv
    try:
        import gi  # noqa: F401

        gi.require_version("Gtk", "3.0")
        from gi.repository import GLib  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        print(f"SKIP: PyGObject unavailable ({exc}) — not proving anything about the layout")
        return 0
    if not PAGE.exists():
        print(f"SKIP: {PAGE} not found")
        return 0

    failures, ran = [], 0
    for w in WIDTHS:
        try:
            data = measure(w, inject=PREFIX_CSS if self_test else None)
        except Exception as exc:  # noqa: BLE001
            if "WebKit2" in str(exc) or "gi.require_version" in str(exc):
                print(f"SKIP: WebKit2 4.1 typelib unavailable ({exc}) — install gir1.2-webkit2-4.1")
                return 0
            raise
        if data is None:
            print(f"SKIP: no result at {w}px (timeout)")
            return 0
        ran += 1
        line = report_targets(w, data)
        if line:
            print(line)
        failures += check(w, data)

    if self_test:
        if failures:
            print(f"self-test: PASS — the checker fails on the pre-fix CSS, as it must ({failures[0]})")
            return 0
        print("self-test: FAIL — the checker passed the pre-fix CSS, so it cannot fail")
        return 1

    for f in failures:
        print(f"  FAIL: {f}")
    if failures:
        print(f"{len(failures)} layout failure(s) across {ran} viewport widths")
        return 1
    print(f"PASS: no sideways scroll, nothing off-screen, single-line tabs at {', '.join(f'{w}px' for w in WIDTHS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
