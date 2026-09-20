#!/usr/bin/env python3
"""apk-icon-check.py <apk> [reference-dir] | --self-test — does this APK carry the app's icon?

Why not a byte comparison: aapt2 re-encodes the mipmap PNGs, so a correct APK is
never byte-identical to the source family. Compare the ART instead — same size,
flattened onto white, mean absolute per-channel difference — and let a threshold
decide. Measured art-diffs: a correct APK scores a few units; an APK carrying
Tauri's template mark or an older mark scores tens.

The reference is the repo's own family (src-tauri/icons/android by default), so
this answers the only question that matters for a launcher: does what the launcher
draws match the artwork the app is supposed to have?

EVERY layer the launcher can draw is compared, because they are separate launch
paths: the FOREGROUND is what a launcher paints on API 26+ (via
mipmap-anydpi-v26), the flat ic_launcher is the legacy fallback, and
ic_launcher_round is the legacy round-mask fallback. Checking only the flat one
leaves the path this device actually takes unverified — which is exactly how an
oversized foreground shipped unreported in v0.12.2.

Run `--self-test` after touching this file, and in CI: it synthesises a correct
APK and an oversized-foreground one (the v0.12.2 regression) and requires 0 and 1
back. A checker whose failure mode is silently reporting OK must be shown to fail.

Exit 0 = every density matches within the threshold; 1 = at least one does not;
2 = usage or IO error (a missing APK, or no reference family).
"""
import io
import pathlib
import sys
import tempfile
import zipfile

from PIL import Image

DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]
LAYERS = ["ic_launcher.png", "ic_launcher_foreground.png", "ic_launcher_round.png"]
COMPARE = 96
THRESHOLD = 12.0
DEFAULT_REF = "src-tauri/icons/android"
INSET_PCT = 70  # what scripts/android-icons.sh insets the foreground to


def art_diff(a: Image.Image, b: Image.Image) -> float:
    """Mean absolute per-channel difference, both flattened onto white."""
    def prep(im):
        im = im.convert("RGBA").resize((COMPARE, COMPARE), Image.Resampling.LANCZOS)
        flat = Image.new("RGB", im.size, (255, 255, 255))
        flat.paste(im, mask=im.split()[3])
        return flat

    pa, pb = prep(a).tobytes(), prep(b).tobytes()
    return sum(abs(x - y) for x, y in zip(pa, pb)) / len(pa)


def check(apk: pathlib.Path, ref_root: pathlib.Path) -> int:
    if not apk.exists():
        print(f"apk not found: {apk}")
        return 2
    if not ref_root.exists():
        print(f"reference icon family not found: {ref_root}")
        return 2

    z = zipfile.ZipFile(apk)
    worst, worst_name = 0.0, ""
    rows = []
    for asset in LAYERS:
        short = asset.replace("ic_launcher", "").removesuffix(".png").strip("_") or "flat"
        for d in DENSITIES:
            ref = ref_root / f"mipmap-{d}" / asset
            member = f"res/mipmap-{d}-v4/{asset}"
            label = f"{d}/{short}"
            if not ref.exists():
                rows.append((label, "-", "no reference"))
                continue
            try:
                apk_img = Image.open(io.BytesIO(z.read(member)))
            except KeyError:
                rows.append((label, "-", f"{member} MISSING from the apk"))
                if not worst_name:
                    worst, worst_name = 999.0, member
                continue
            diff = art_diff(apk_img, Image.open(ref))
            if diff > worst:
                worst, worst_name = diff, label
            rows.append((label, f"{diff:6.2f}", "ok" if diff <= THRESHOLD else "DIFFERS"))

    print(f"apk:    {apk}  ({apk.stat().st_size:,} bytes)")
    print(f"ref:    {ref_root}")
    print(f"metric: mean abs channel diff on {COMPARE}x{COMPARE}, flattened on white "
          f"(threshold {THRESHOLD:.0f})")
    for d, diff, note in rows:
        print(f"  mipmap-{d:8} {diff:>7}  {note}")
    if worst <= THRESHOLD:
        print(f"PASS: the launcher icon matches the app's artwork (worst {worst:.2f} at {worst_name})")
        return 0
    print(f"FAIL: the launcher icon is NOT the app's artwork (worst {worst:.2f} at {worst_name})")
    return 1


def _reinset(src: pathlib.Path, pct: int) -> bytes:
    """Re-lay the mark out at `pct` of the canvas — how a wrong inset looks."""
    img = Image.open(src).convert("RGBA")
    canvas = img.size[0]
    inner = max(1, canvas * pct // 100)
    mark = img.crop(img.getbbox()).resize((inner, inner), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    off = (canvas - inner) // 2
    out.paste(mark, (off, off), mark)
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return buf.getvalue()


def _synth_apk(ref_root: pathlib.Path, dest: pathlib.Path, fg_pct: int) -> None:
    """A minimal APK carrying the family's art, with the foreground at fg_pct."""
    with zipfile.ZipFile(dest, "w") as z:
        for d in DENSITIES:
            for asset in LAYERS:
                src = ref_root / f"mipmap-{d}" / asset
                if not src.exists():
                    continue
                data = _reinset(src, fg_pct) if "foreground" in asset else src.read_bytes()
                z.writestr(f"res/mipmap-{d}-v4/{asset}", data)


def self_test() -> int:
    ref = pathlib.Path(DEFAULT_REF)
    if not ref.exists():
        print(f"self-test must run from the repo root ({DEFAULT_REF} not found)")
        return 2
    with tempfile.TemporaryDirectory() as td:
        good, bad = pathlib.Path(td) / "good.apk", pathlib.Path(td) / "bad.apk"
        _synth_apk(ref, good, INSET_PCT)
        _synth_apk(ref, bad, 82)  # ~81.5%: what shipped in v0.12.2
        print("self-test positive control (correct APK, must pass):")
        rc_good = check(good, ref)
        print("self-test negative control (oversized foreground, must fail):")
        rc_bad = check(bad, ref)
    if rc_good == 0 and rc_bad == 1:
        print("self-test PASS: a correct apk passes and an oversized foreground fails")
        return 0
    print(f"self-test FAIL: expected 0 and 1, got {rc_good} and {rc_bad} — the check proves nothing")
    return 1


def main() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 2
    if args[0] == "--self-test":
        return self_test()
    ref = pathlib.Path(args[1] if len(args) > 1 else DEFAULT_REF)
    return check(pathlib.Path(args[0]), ref)


if __name__ == "__main__":
    raise SystemExit(main())
