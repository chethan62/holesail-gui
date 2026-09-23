#!/usr/bin/env python3
"""Check the licence inventory of a packaged payload.

Usage: scripts/licence-check.py <payload-dir | appimage | apk> [--self-test]

Why: the README tells users the installers carry no copyleft code at all — a
claim nothing checks rots, and this one has already been wrong four times
(livefiles in v0.9.5; holesail-server / holesail-logger / barely-colours in
v0.12.6). Since the engine migration the payload is MIT/Apache-only by
construction, so this walks the bundled node_modules, prints every licence it
finds, and FAILS if ANY package declares a copyleft licence. A licence text
beside it is no excuse any more: shipping copyleft at all is the regression.

Stdlib only (no Pillow, no third-party imports): the CI runner's python is not
this box's python, and the icon checker already cost a release to that.

Exit 0 = no copyleft in the payload; 1 = something copyleft, unlicenced or
unrecognised is in there.
--self-test synthesises a permissive payload and three failing ones and
requires 0 then 1, 1, 1, because a verifier that cannot fail proves nothing.
--vendored checks the hand-vendored browser file the payload walk cannot see
(renderer/vendor/qrcode.js) against the sha256 recorded for it — a provenance
note nothing verifies is exactly what rots. It has its own negative control.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

COPYLEFT = re.compile(r"(A?GPL|LGPL|MPL|CDDL|EPL|EUPL)", re.I)
# Recognised permissive families. Anything NOT in one of these two lists is a
# failure, not a shrug: the README claims every bundled package is permissive
# apart from the listed copyleft family, and an unrecognised or missing licence
# string would quietly falsify that claim (measured: a tree with a "WTFPL"
# package and one with no licence field at all used to PASS).
PERMISSIVE = re.compile(
    r"(MIT|APACHE|ISC|BSD|0BSD|ZLIB|CC0|CC-BY|UNLICENSE|PYTHON|BLUEOAK|JSON|"
    r"X11|WTFPL|ARTISTIC|MPL-2\.0-COMPAT)",
    re.I,
)
PROPRIETARY = re.compile(r"(UNLICENSED|PROPRIETARY|ALL RIGHTS RESERVED|SEE LICENSE IN)", re.I)
TEXT_FILE = re.compile(r"^(LICEN|COPYING|NOTICE)", re.I)


def licence_of(manifest):
    lic = manifest.get("license") or manifest.get("licenses") or ""
    if isinstance(lic, list):
        parts = []
        for item in lic:
            parts.append(item.get("type", "") if isinstance(item, dict) else str(item))
        lic = ",".join(parts)
    if isinstance(lic, dict):
        lic = lic.get("type", "")
    return str(lic)


def packages(nm_dir):
    """Every package manifest under a node_modules dir, including nested."""
    found = []
    for root, dirs, files in os.walk(nm_dir):
        if "package.json" in files and os.path.basename(root) != "node_modules":
            try:
                with open(os.path.join(root, "package.json"), encoding="utf-8") as fh:
                    manifest = json.load(fh)
            except Exception:
                dirs[:] = []
                continue
            found.append((root, manifest))
        # do not descend into a package's own tests/fixtures
        dirs[:] = [d for d in dirs if d not in (".bin", "test", "tests", "fixtures")]
    return found


def unpack(target, workdir):
    """Return a directory that contains the payload's node_modules."""
    if not os.path.exists(target):
        print(f"FAIL: no such payload: {target}")
        raise SystemExit(1)
    if os.path.isdir(target):
        return target
    if target.lower().endswith(".apk"):
        with zipfile.ZipFile(target) as zf:
            zf.extractall(workdir)
        return workdir
    # AppImage: --appimage-extract drops squashfs-root next to cwd. A file
    # downloaded with gh/curl carries no executable bit, so extract from a copy
    # we own instead of chmod-ing the caller's artifact.
    local = os.path.join(workdir, "payload.AppImage")
    shutil.copy2(target, local)
    os.chmod(local, 0o755)
    proc = subprocess.run(
        [local, "--appimage-extract"],
        cwd=workdir,
        capture_output=True,
        check=False,
    )
    root = os.path.join(workdir, "squashfs-root")
    if not os.path.isdir(root):
        print(
            "FAIL: could not extract the AppImage "
            f"(exit {proc.returncode}): {proc.stderr.decode('utf-8', 'replace')[:200]}"
        )
        raise SystemExit(1)
    return root


def find_nm(payload_root):
    for root, dirs, _ in os.walk(payload_root):
        if os.path.basename(root) == "node_modules" and "hyperdht" in dirs:
            return root
    return None


def audit(payload_root):
    nm = find_nm(payload_root)
    if not nm:
        print(
            "FAIL: no bundled node_modules holding the engine (looked for hyperdht)"
            " — nothing to audit"
        )
        return 1
    table = {}
    copyleft = []
    unknown = []
    for pkg_dir, manifest in packages(nm):
        lic = licence_of(manifest)
        name = manifest.get("name") or os.path.basename(pkg_dir)
        ident = f"{name}@{manifest.get('version', '?')}"
        table.setdefault(lic, []).append(name)
        if COPYLEFT.search(lic):
            copyleft.append(f"{ident} ({lic})")
        elif not lic:
            unknown.append(f"{ident} — declares no licence at all")
        elif PROPRIETARY.search(lic):
            unknown.append(f"{ident} — {lic}")
        elif not PERMISSIVE.search(lic):
            unknown.append(f"{ident} — unrecognised licence string {lic!r}")
    print(f"bundled packages audited: {sum(len(v) for v in table.values())}")
    for lic in sorted(table, key=lambda k: -len(table[k])):
        print(f"  {len(table[lic]):3d}  {lic or '(no licence field)'}")
    copyleft_count = sum(len(v) for k, v in table.items() if COPYLEFT.search(k))
    print(f"copyleft packages: {copyleft_count}")
    if unknown:
        print("FAIL: packages whose licence is not recognised as permissive:")
        for u in unknown:
            print(f"  - {u}")
        print("  (add the licence to PERMISSIVE/COPYLEFT in this checker with a reason,")
        print("   or remove the package — do not let it ship silently)")
        return 1
    if copyleft:
        print("FAIL: copyleft packages in the payload — the engine migration")
        print("      replaced the holesail family, so none should remain:")
        for c in copyleft:
            print(f"  - {c}")
        print("  (fix the dependency, or teach COPYLEFT/PERMISSIVE in this checker")
        print("   with a reason — do not let it ship silently)")
        return 1
    print("PASS: no copyleft packages in the payload")
    return 0


REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Browser JavaScript that ships in the renderer but is not an npm package, so
# `packages()` above cannot see it. The hash IS the pin: update this table and
# renderer/vendor/README.md together, or the check fails on purpose.
VENDORED = {
    "renderer/vendor/qrcode.js": (
        "18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780",
        "MIT",
    ),
}


def check_vendored(repo_root, table=None):
    """Every vendored file must match its recorded hash. Table is injectable so
    the self-test can prove a wrong hash fails."""
    table = VENDORED if table is None else table
    failures = 0
    for rel, (want, licence) in table.items():
        path = os.path.join(repo_root, rel)
        try:
            with open(path, "rb") as fh:
                got = hashlib.sha256(fh.read()).hexdigest()
        except OSError as exc:
            print(f"FAIL: vendored file unreadable: {rel} ({exc})")
            failures += 1
            continue
        if got != want:
            print(f"FAIL: {rel} hashes to {got}, recorded {want}")
            print("      (update renderer/vendor/README.md and VENDORED together)")
            failures += 1
        else:
            print(f"PASS: {rel} matches its recorded {licence} pin")
    return 1 if failures else 0


def self_test():
    """A permissive payload must pass; one copyleft package must fail it — even
    when that package ships its own licence text (a text used to be the pass
    condition, which is exactly what the migration stopped caring about)."""
    work = tempfile.mkdtemp()
    try:
        variants = (
            (
                "permissive",
                0,
                [("hyperdht", "MIT"), ("z32", "MIT"), ("bares", "Apache-2.0")],
            ),
            (
                "copyleft-with-text",
                1,
                [("hyperdht", "MIT"), ("holesail", "AGPL-3.0")],
            ),
            ("copyleft-no-text", 1, [("hyperdht", "MIT"), ("livefiles", "GPL-3.0")]),
            ("unknown", 1, [("hyperdht", "MIT"), ("mystery", "SomeUnlistedLicence")]),
        )
        for variant, expect, pkgs in variants:
            root = os.path.join(work, variant)
            for pkg, lic in pkgs:
                d = os.path.join(root, "node_modules", pkg)
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, "package.json"), "w", encoding="utf-8") as fh:
                    entry = {"name": pkg, "version": "1.0.0"}
                    if lic:
                        entry["license"] = lic
                    json.dump(entry, fh)
                # every package gets a text: a text must not excuse copyleft
                with open(os.path.join(d, "LICENSE"), "w", encoding="utf-8") as fh:
                    fh.write("GNU AFFERO GENERAL PUBLIC LICENSE\n")
            got = audit(root)
            status = "OK" if got == expect else f"WRONG (expected {expect})"
            print(f"  self-test {variant}: exit {got} {status}")
            if got != expect:
                return 1
        # Negative control for the vendored-file check: a wrong recorded hash
        # must fail, or the pin is decoration.
        wrong = {"renderer/vendor/qrcode.js": ("0" * 64, "MIT")}
        got = check_vendored(REPO, wrong)
        ok = got == 1
        print(
            f"  self-test vendored-wrong-hash: exit {got} "
            f"{'OK' if ok else 'WRONG (expected 1)'}"
        )
        if not ok:
            return 1
        print("self-test PASS")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    target = sys.argv[1]
    if target == "--self-test" or "--self-test" in sys.argv[1:]:
        return self_test()
    if target == "--vendored" or "--vendored" in sys.argv[1:]:
        return check_vendored(REPO)
    work = tempfile.mkdtemp()
    try:
        return audit(unpack(target, work))
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
