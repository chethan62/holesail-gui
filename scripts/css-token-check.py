#!/usr/bin/env python3
"""css-token-check.py — the renderer's token layer, guarded.

Why this exists: every hardcoded color in renderer/style.css moved into a :root
token, with a body[data-theme='light'] value where the surface differs. That is
only worth having if nothing drifts back, because the two failure modes are both
SILENT:

  - a color literal at the point of use is a color light mode cannot reach (the
    reason the light theme used to render white text on a near-white panel);
  - a typo'd var(--tokn) resolves to nothing, so the property falls back to
    inherited/initial and looks wrong without ever erroring.

So both are hard failures here, plus two consistency rules: every var() used must
be defined in :root, and a light-block override for a token :root never defines is
dead code (it would silently do nothing).

Runs in CI (build.yml, linux job). Exits 0 clean, 1 on any finding.
"""

import re
import sys
from pathlib import Path

CSS = Path(__file__).resolve().parent.parent / "renderer" / "style.css"
THEME_BLOCKS = (":root", "body[data-theme='light']")
# Hex only: that is the invariant the token pass established. rgba() tints
# (badge/banner backgrounds, one box-shadow) are a documented NON-goal here —
# they read acceptably in both themes and re-valuing them is a design decision,
# not a refactor. Widen this regex only when they are tokenized too.
LITERAL = re.compile(r"#[0-9a-fA-F]{3,8}\b")
VAR = re.compile(r"var\(\s*(--[\w-]+)")
DECL = re.compile(r"(--[\w-]+)\s*:")


def strip_comments(text):
    """Blank out /* ... */ but keep every newline, so line numbers stay true."""
    return re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)


def block(text, selector):
    """Span of `selector { ... }`, by brace matching from the selector."""
    start = re.search(r"^" + re.escape(selector) + r"\s*\{", text, re.M)
    if not start:
        return None
    i = text.index("{", start.start())
    depth = 0
    for j in range(i, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return (start.start(), j + 1, i + 1, j)
    return None


def check(text):
    """Return a list of findings (strings) for this stylesheet text."""
    findings = []
    spans = {}
    for sel in THEME_BLOCKS:
        spans[sel] = block(text, sel)
        if not spans[sel]:
            findings.append(f"FINDING: no `{sel}` block at all")

    def defined(sel):
        """token -> line, for the declarations inside a theme block."""
        span = spans[sel]
        if not span:
            return {}
        out = {}
        for m in DECL.finditer(text, span[2], span[3]):
            out[m.group(1)] = text.count("\n", 0, m.start()) + 1
        return out

    root = defined(":root")
    light = defined("body[data-theme='light']")

    # (1) literals anywhere except the two theme blocks
    theme_zone = [s for s in spans.values() if s]
    for m in LITERAL.finditer(text):
        if any(lo <= m.start() < hi for lo, hi, _, _ in theme_zone):
            continue
        line = text.count("\n", 0, m.start()) + 1
        findings.append(
            f"FINDING: color literal {m.group(0)!r} outside a theme block "
            f"(line {line}) — it must be a var(--token) instead"
        )

    # (2) var() uses with no definition, (3) overrides for undefined tokens
    for m in VAR.finditer(text):
        if m.group(1) not in root:
            line = text.count("\n", 0, m.start()) + 1
            findings.append(
                f"FINDING: var({m.group(1)}) is used (line {line}) but :root never defines it"
            )
    for tok, line in light.items():
        if tok not in root:
            findings.append(
                f"FINDING: body[data-theme='light'] overrides {tok} (line {line}) "
                f"which :root never defines — the override is dead"
            )
    return findings


def run(text, label):
    findings = check(text)
    if findings:
        print(f"{label}: {len(findings)} finding(s)")
        for f in findings:
            print("  " + f)
        return 1
    print(f"{label}: PASS (no literal outside the theme blocks, every var() defined)")
    return 0


def main():
    if "--self-test" in sys.argv:
        # A verifier that cannot fail proves nothing: the two silent failure
        # modes are injected into a copy and must both be reported.
        text = strip_comments(CSS.read_text())
        clean = run(text, "self-test / clean copy")
        # Injected INSIDE the real light block, not in a second one at the end:
        # the checker reads the first block per selector, so a duplicate would
        # have hidden this finding and the self-test would have "passed" by
        # testing nothing (it did exactly that on the first run).
        broken = text.replace(
            "body[data-theme='light'] {",
            "body[data-theme='light'] {\n  --also-undefined: #fff;",
            1,
        )
        broken += "\n.self-test {\n  color: #abc;\n  background: var(--no-such-token);\n}\n"
        findings = check(broken)
        want = [
            "literal '#abc'",
            "var(--no-such-token)",
            "--also-undefined",
        ]
        hit = [w for w in want if any(w in f for f in findings)]
        print(f"self-test / broken copy: {len(findings)} finding(s), matched {len(hit)}/{len(want)}")
        for f in findings:
            print("  " + f)
        ok = len(findings) == len(want) and len(hit) == len(want) and clean == 0
        print("self-test: PASS" if ok else "self-test: FAIL")
        return 0 if ok else 1

    return run(strip_comments(CSS.read_text()), str(CSS))


if __name__ == "__main__":
    sys.exit(main())
