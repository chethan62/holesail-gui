#!/usr/bin/env python3
"""Audit the licences of the Rust crates that get STATICALLY LINKED into the app.

The npm half of the payload is already covered: `scripts/licence-check.py` walks
the bundled packages and fails on copyleft, and `prepare-resources.mjs` refuses
to build if one declares it. The Rust half was never audited at all — and these
crates do not ship as files, they are compiled into the binary, so a licence
problem here is invisible to every check that reads the payload.

Measured 2026-09-27 on the shipped tree: 495 registry crates, every one MIT /
Apache-2.0 / BSD / ISC / Zlib / Unicode-3.0 / MPL-2.0 / CC0 / Unlicense — no
strong copyleft. The single LGPL hit (`r-efi`) is `MIT OR Apache-2.0 OR
LGPL-2.1-or-later`, i.e. one arm of a choice, which is why the rule below tests
ARMS and not the whole string.

Rule: a crate passes if its SPDX expression is satisfiable using only permissive
arm(s) — split on AND, and each term must offer at least one permissive
alternative. Weak copyleft (MPL, LGPL, CDDL, EPL) is reported as a note, not a
failure: these are consumed unmodified, so there is no source obligation — but a
reviewer should see them.

Usage:
  scripts/rust-licence-check.py                 # audit, exit 1 on strong copyleft
  scripts/rust-licence-check.py --write <path>  # also write a notices file
  scripts/rust-licence-check.py --metadata f.json   # audit a fixture instead of cargo
  scripts/rust-licence-check.py --self-test     # prove the rule fires both ways
"""
import json
import re
import subprocess
import sys
from pathlib import Path

STRONG = ("GPL", "AGPL", "SSPL", "CPAL", "EUPL", "OSL-")
WEAK = ("MPL", "LGPL", "CDDL", "EPL")
# Anything not listed here and not strong/weak is treated as permissive-unknown
# and reported, never silently accepted.
PERMISSIVE = (
    "MIT",
    "APACHE",
    "BSD",
    "ISC",
    "ZLIB",
    "UNICODE",
    "CC0",
    "UNLICENSE",
    "0BSD",
    "CDLA",
    "BLESSING",
    "WTFPL",
)


def licences(crate):
    return crate.get("license") or crate.get("license_file") or ""


def classify(expr):
    """Return (verdict, detail): verdict in {'permissive','weak','strong','unknown'}."""
    if not expr:
        return "unknown", "no licence field"
    terms = [t.strip() for t in re.split(r"\s+AND\s+", _strip_parens(expr), flags=re.I)]
    weak_terms = []
    for term in terms:
        arms = [a.strip().upper() for a in re.split(r"\s+OR\s+", term, flags=re.I)]
        # A permissive arm settles the term: where the publisher offers a choice,
        # the permissive alternative is what this app relies on. The real case is
        # r-efi's "MIT OR Apache-2.0 OR LGPL-2.1-or-later", which must not be
        # reported as copyleft on the strength of an arm nobody takes.
        if any(any(p in a for p in PERMISSIVE) for a in arms):
            continue
        # No permissive arm, but a weak one: consuming MPL/LGPL code unmodified
        # carries no source obligation, so this is a note for a reviewer rather
        # than a failure (the 5 MPL-2.0 crates that come in via the webview stack).
        if any(any(w in a for w in WEAK) for a in arms):
            weak_terms.append(term)
            continue
        if any(any(s in a for s in STRONG) for a in arms):
            return "strong", term
        return "unknown", term
    return ("weak", ", ".join(weak_terms)) if weak_terms else ("permissive", "")


def _strip_parens(expr):
    while "(" in expr or ")" in expr:
        expr = expr.replace("(", "").replace(")", "")
    return expr


def audit(crates):
    """crates: [{'name','version','license','repository','source'}] -> report dict."""
    rows, strong, weak, unknown = [], [], [], []
    for c in crates:
        if not c.get("source"):  # workspace members are the app's own MIT code
            continue
        expr = licences(c)
        verdict, detail = classify(expr)
        rows.append((c["name"], c.get("version", ""), expr, verdict))
        if verdict == "strong":
            strong.append(f"{c['name']} {c.get('version','')} = {expr} ({detail})")
        elif verdict == "weak":
            weak.append(f"{c['name']} {c.get('version','')} = {expr}")
        elif verdict == "unknown":
            unknown.append(f"{c['name']} {c.get('version','')} = {expr or 'NONE'}")
    return {
        "total": len(rows),
        "strong": sorted(strong),
        "weak": sorted(weak),
        "unknown": sorted(unknown),
        "crates": sorted(rows),
    }


def notices(report, version):
    """The attribution file that ships inside the payload."""
    out = [
        f"# Third-party licences — Rust crates (holesail-gui {version})",
        "",
        "This app statically links the crates below. They are compiled into the",
        "binary rather than shipped as files, so they cannot be listed from the",
        "payload; this file is generated from the locked dependency graph",
        "(`cargo metadata`) by `scripts/rust-licence-check.py --write`.",
        "",
        "The licence identifier is the crate's own SPDX expression. Where it offers",
        "a choice (`OR`), the permissive alternative is what this app relies on.",
        "",
        f"Crates: {report['total']}",
        "",
        "| crate | version | licence (SPDX) |",
        "| --- | --- | --- |",
    ]
    for name, ver, expr, _verdict in report["crates"]:
        out.append(f"| {name} | {ver} | {expr or 'see upstream'} |")
    out += [
        "",
        "Full licence texts are distributed with each crate by its publisher and are",
        "available from crates.io under the name and version above.",
        "",
    ]
    return "\n".join(out)


def load_metadata(manifest):
    raw = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--manifest-path", manifest],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return json.loads(raw)


def report_and_exit(report, write_path=None, app_version="", verbose=True):
    if verbose:
        print(f"rust crates audited: {report['total']}")
        print(f"  strong copyleft: {len(report['strong'])}")
        for row in report["strong"]:
            print("    " + row)
        print(f"  weak copyleft (unmodified use, no source obligation): {len(report['weak'])}")
        for row in report["weak"]:
            print("    " + row)
        print(f"  unrecognised licence: {len(report['unknown'])}")
        for row in report["unknown"]:
            print("    " + row)
    if write_path:
        Path(write_path).write_text(notices(report, app_version))
        print(f"wrote {write_path}")
    if report["strong"]:
        print("FAIL: a crate with strong copyleft is statically linked into the app")
        return 1
    if report["unknown"]:
        print("FAIL: a crate's licence is not recognised as permissive")
        print("      (add it to PERMISSIVE/STRONG in this checker with a reason)")
        return 1
    print("PASS: no strong copyleft among the linked crates")
    return 0


FIXTURES = {
    "permissive": [
        {"name": "a", "version": "1", "license": "MIT", "source": "registry+https://x"},
        {"name": "b", "version": "1", "license": "MIT OR Apache-2.0", "source": "r"},
    ],
    "pure-gpl": [
        {"name": "g", "version": "1", "license": "GPL-3.0-only", "source": "registry+x"},
    ],
    # the real r-efi expression: an LGPL arm alongside permissive ones
    "or-with-permissive": [
        {"name": "r-efi", "version": "5", "license": "MIT OR Apache-2.0 OR LGPL-2.1-or-later", "source": "r"},
    ],
    "mpl-alone": [
        {"name": "selectors", "version": "0.25", "license": "MPL-2.0", "source": "r"},
    ],
    "and-with-gpl": [
        {"name": "x", "version": "1", "license": "MIT AND GPL-3.0-only", "source": "r"},
    ],
    "no-field": [
        {"name": "n", "version": "1", "source": "r"},
    ],
}


def self_test():
    expect = {
        "permissive": ("permissive", 0),
        "pure-gpl": ("strong", 1),
        "or-with-permissive": ("permissive", 0),
        "mpl-alone": ("weak", 0),
        "and-with-gpl": ("strong", 1),
        "no-field": ("unknown", 1),
    }
    failures = 0
    for name, (want_verdict, want_exit) in expect.items():
        rep = audit(FIXTURES[name])
        got = (
            "strong"
            if rep["strong"]
            else "weak"
            if rep["weak"]
            else "unknown"
            if rep["unknown"]
            else "permissive"
        )
        code = report_and_exit(rep, verbose=False)
        ok = (got == want_verdict) and (code == want_exit)
        print(f"  self-test {name}: verdict={got} exit={code} {'OK' if ok else 'WRONG'}")
        if not ok:
            failures += 1
    if failures:
        print(f"self-test FAILED ({failures})")
        return 1
    print("self-test PASS")
    return 0


def main(argv):
    if "--self-test" in argv:
        return self_test()
    verbose = "--quiet" not in argv
    write_path = None
    if "--write" in argv:
        write_path = argv[argv.index("--write") + 1]
    manifest = "src-tauri/Cargo.toml"
    if "--manifest" in argv:
        manifest = argv[argv.index("--manifest") + 1]
    if "--metadata" in argv:
        crates = json.loads(Path(argv[argv.index("--metadata") + 1]).read_text())["packages"]
    else:
        crates = load_metadata(manifest)["packages"]
    version = ""
    try:
        version = json.loads(Path("package.json").read_text())["version"]
    except Exception:  # a fixture run may not have one
        pass
    return report_and_exit(audit(crates), write_path, version, verbose)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
