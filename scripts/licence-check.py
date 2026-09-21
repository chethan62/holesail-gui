#!/usr/bin/env python3
"""Check the licence inventory of a packaged payload.

Usage: scripts/licence-check.py <payload-dir | appimage | apk> [--self-test]

Why: the README tells users which copyleft code the installers carry, and that
claim has been wrong twice — livefiles redistributed with no licence text
(v0.9.5), then holesail-server / holesail-logger / barely-colours doing the same
(v0.12.6). A claim nothing checks rots, so this walks the bundled node_modules,
prints every licence it finds, and FAILS if any package that declares a
copyleft licence ships no licence text beside it.

Stdlib only (no Pillow, no third-party imports): the CI runner's python is not
this box's python, and the icon checker already cost a release to that.

Exit 0 = every copyleft package carries a text; 1 = something is missing.
--self-test synthesises a clean payload and a broken one and requires 0 then 1,
because a verifier that cannot fail proves nothing.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

COPYLEFT = re.compile(r"(A?GPL|LGPL|MPL|CDDL|EPL)", re.I)
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
    # AppImage: --appimage-extract drops squashfs-root next to cwd
    subprocess.run(
        [target, "--appimage-extract"],
        cwd=workdir,
        capture_output=True,
        check=False,
    )
    return os.path.join(workdir, "squashfs-root")


def find_nm(payload_root):
    for root, dirs, _ in os.walk(payload_root):
        if os.path.basename(root) == "node_modules" and "holesail" in dirs:
            return root
    return None


def audit(payload_root):
    nm = find_nm(payload_root)
    if not nm:
        print("FAIL: no bundled node_modules with holesail in it — nothing to audit")
        return 1
    table = {}
    missing = []
    for pkg_dir, manifest in packages(nm):
        lic = licence_of(manifest)
        name = manifest.get("name") or os.path.basename(pkg_dir)
        table.setdefault(lic, []).append(name)
        if COPYLEFT.search(lic):
            has_text = any(TEXT_FILE.match(f) for f in os.listdir(pkg_dir))
            if not has_text:
                missing.append(f"{name}@{manifest.get('version', '?')} ({lic})")
    print(f"bundled packages audited: {sum(len(v) for v in table.values())}")
    for lic in sorted(table, key=lambda k: -len(table[k])):
        print(f"  {len(table[lic]):3d}  {lic or '(no licence field)'}")
    copyleft_count = sum(len(v) for k, v in table.items() if COPYLEFT.search(k))
    print(f"copyleft packages: {copyleft_count}")
    if missing:
        print("FAIL: copyleft packages with no licence text beside them:")
        for m in missing:
            print(f"  - {m}")
        return 1
    print("PASS: every copyleft package ships its licence text")
    return 0


def self_test():
    """A payload WITH texts must pass, the same payload WITHOUT them must fail."""
    work = tempfile.mkdtemp()
    try:
        for variant, expect in (("clean", 0), ("broken", 1)):
            root = os.path.join(work, variant)
            for pkg, lic in (
                ("holesail", "AGPL-3.0"),
                ("holesail-server", "GNU GPL v3"),
                ("probably-mit", "MIT"),
            ):
                d = os.path.join(root, "node_modules", pkg)
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, "package.json"), "w", encoding="utf-8") as fh:
                    json.dump({"name": pkg, "version": "1.0.0", "license": lic}, fh)
                if variant == "clean" or lic == "MIT":
                    with open(os.path.join(d, "LICENSE"), "w", encoding="utf-8") as fh:
                        fh.write("GNU AFFERO GENERAL PUBLIC LICENSE\n")
            got = audit(root)
            status = "OK" if got == expect else f"WRONG (expected {expect})"
            print(f"  self-test {variant}: exit {got} {status}")
            if got != expect:
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
    work = tempfile.mkdtemp()
    try:
        return audit(unpack(target, work))
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
