#!/usr/bin/env python3
"""Report the CSS/HTML features the loaded WebKitGTK engine actually supports.

The shipped Linux app does NOT use the system engine: it carries its own
WebKitGTK inside the AppImage (measured 2.50.4), so "does the webview support X"
has to be answered by the engine that is loaded, not by a browser-support table.
This drives whatever engine is present and names it in the output, which is the
only honest way to compare two of them.

    python3 scripts/webkit-support.py            # system webkit2gtk (dev builds)
    python3 scripts/webkit-support.py --json     # machine-readable

For the engine *inside a shipped AppImage* the same measurements need a C probe:
the payload ships no typelibs, so PyGObject cannot drive it. See
docs/ui-support.md for that recipe — it is what produced the 2.50.4 column.

Needs PyGObject with WebKit2-4.1 (system python, not the project's node/python
tooling), a display, and GTK's usual headless env:

    GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \\
      /usr/bin/python3 scripts/webkit-support.py
"""
from __future__ import annotations

import json
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

# CSS.supports covers most of it; the four insertRule entries are at-rules, which
# CSS.supports cannot see. Each at-rule is tried for real rather than string-matched.
PROBE = r"""
(function () {
  const css = (p) => { try { return CSS.supports(p); } catch (e) { return false; } };
  const rule = (r) => { try { const s = new CSSStyleSheet(); s.insertRule(r); return true; }
                        catch (e) { return false; } };
  const out = {};
  out["selector :has()"]            = css('selector(:has(a))') && !!document.querySelector('div:has(span)');
  out["selector :focus-visible"]    = css('selector(:focus-visible)');
  out["selector :is()/:where()"]    = css('selector(:is(a))') && css('selector(:where(a))');
  out["selector :user-invalid"]     = css('selector(:user-invalid)');
  out["container queries"]          = css('container-type: inline-size') && css('inline-size: 10cqw');
  out["container style queries"]    = rule('@container style(--x: 1) { a { color: red } }');
  out["container scroll-state"]     = rule('@container scroll-state(stuck: top) { a { color: red } }');
  out["@scope"]                     = rule('@scope (.a) { b { color: red } }');
  out["@starting-style"]            = rule('@starting-style { a { color: red } }');
  out["CSS nesting"]                = rule('a { & b { color: red } }');
  out["popover attribute"]          = ('popover' in HTMLElement.prototype);
  out["popover=hint"]               = (function () { const d = document.createElement('div');
                                        d.setAttribute('popover', 'hint'); return d.popover === 'hint'; })();
  out["dialog element"]             = (typeof HTMLDialogElement === 'function' &&
                                        !!HTMLDialogElement.prototype.showModal);
  out["dialog closedBy"]            = ('closedBy' in HTMLDialogElement.prototype);
  out["button commandForElement"]   = ('commandForElement' in HTMLButtonElement.prototype);
  out["inert attribute"]            = ('inert' in HTMLElement.prototype);
  out["color-mix()"]                = css('color: color-mix(in srgb, red, blue)');
  out["oklch()"]                    = css('color: oklch(0.5 0.1 200)');
  out["light-dark()"]               = css('color: light-dark(red, blue)');
  out["backdrop-filter"]            = css('backdrop-filter: blur(2px)') ||
                                      css('-webkit-backdrop-filter: blur(2px)');
  out["view transitions"]           = (typeof document.startViewTransition === 'function');
  out["scroll-driven animations"]   = css('animation-timeline: scroll()') &&
                                      css('view-timeline-name: --x');
  out["anchor positioning"]         = css('position-anchor: --a');
  out["subgrid"]                    = css('grid-template-columns: subgrid');
  out["scrollbar-color"]            = css('scrollbar-color: red blue');
  out["text-wrap: balance/pretty"]  = css('text-wrap: balance') && css('text-wrap: pretty');
  out["text-box-trim"]              = css('text-box: trim-both cap alphabetic');
  out["field-sizing"]               = css('field-sizing: content');
  out["calc-size()/interpolate-size"] = css('width: calc-size(auto, size)') &&
                                      css('interpolate-size: allow-keywords');
  out["appearance: base-select"]    = css('appearance: base-select');
  out["prefers-reduced-transparency"] = matchMedia('(prefers-reduced-transparency: reduce)').media !== 'not all';
  return JSON.stringify(out);
})()
"""

HTML = "<!doctype html><html><body><div><span>x</span></div></body></html>"


def measure(timeout_ms: int = 20000) -> dict:
    view = WebKit2.WebView()
    window = Gtk.OffscreenWindow()  # never mapped: no window appears on the user's desktop
    window.add(view)
    window.show_all()
    result: dict = {}

    def done(_view, res, _data):
        try:
            result.update(json.loads(view.evaluate_javascript_finish(res).to_string()))
        except Exception as exc:  # noqa: BLE001
            result["error"] = f"{type(exc).__name__}: {exc}"
        result["engine"] = "{}.{}.{}".format(
            WebKit2.get_major_version(), WebKit2.get_minor_version(), WebKit2.get_micro_version()
        )
        result["gtk"] = "{}.{}.{}".format(
            Gtk.get_major_version(), Gtk.get_minor_version(), Gtk.get_micro_version()
        )
        Gtk.main_quit()

    def loaded(_view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            view.evaluate_javascript(PROBE, -1, None, None, None, done, None)

    view.connect("load-changed", loaded)
    view.load_html(HTML, None)
    GLib.timeout_add(timeout_ms, lambda: (result.update({"error": "timeout"}), Gtk.main_quit())[1])
    Gtk.main()
    return result


def main(argv: list[str]) -> int:
    report = measure()
    if "--json" in argv:
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    if "error" in report:
        print(f"probe failed: {report['error']}", file=sys.stderr)
        return 1
    features = {k: v for k, v in report.items() if k not in ("engine", "gtk")}
    unsupported = sorted(k for k, v in features.items() if not v)
    print(f"WebKitGTK {report['engine']} (GTK {report['gtk']})")
    for name in sorted(features):
        print(f"  {'yes' if features[name] else 'NO ':4} {name}")
    print(f"\n{len(features) - len(unsupported)}/{len(features)} supported; not available: "
          f"{', '.join(unsupported) if unsupported else 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
