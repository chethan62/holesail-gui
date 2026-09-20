#!/usr/bin/env bash
# Derive the Android launcher FOREGROUND icons from the brand master.
#
# Why an inset at all: Android's adaptive icon paints its foreground on a 108dp
# canvas, but only the inner 72dp is ever visible and a round mask crops to
# roughly 66% of it. The brand master's mark fills ~81.5% of its canvas (right for
# a Linux launcher and for the in-app header), so used as-is on Android the boat
# renders jammed against the circle — measured on a OnePlus 13R: the mark touched
# the edge with a hairline of white around it.
#
# So the foreground is the master's mark TRIMMED and inset to 70% of each canvas:
# bold, but clear of the mask. A fresh master with more transparent padding gets
# the same treatment automatically.
#
# Run this after any icon change, then commit src-tauri/icons/android — CI copies
# that directory into the generated Android project (scripts/android-glue.mjs), so
# what is committed here is what the phone draws.
set -euo pipefail
cd "$(dirname "$0")/.."

MASTER=${1:-src-tauri/icons/source.png}
DEST=src-tauri/icons/android
INSET_PCT=${INSET_PCT:-70}

IM=""
for c in magick convert; do command -v "$c" >/dev/null 2>&1 && { IM=$c; break; }; done
[ -n "$IM" ] || { echo "need ImageMagick (magick or convert)" >&2; exit 1; }
[ -f "$MASTER" ] || { echo "master not found: $MASTER" >&2; exit 1; }

# foreground canvas = 108dp at each density's scale
canvas_for() {
  case "$1" in
    mdpi) echo 108 ;;
    hdpi) echo 162 ;;
    xhdpi) echo 216 ;;
    xxhdpi) echo 324 ;;
    xxxhdpi) echo 432 ;;
    *) echo "unknown density $1" >&2; exit 1 ;;
  esac
}

echo "master: $MASTER (mark inset to ${INSET_PCT}% of each android foreground)"
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  S=$(canvas_for "$d")
  INNER=$(( S * INSET_PCT / 100 ))
  out="$DEST/mipmap-$d/ic_launcher_foreground.png"
  mkdir -p "$(dirname "$out")"
  "$IM" "$MASTER" -trim +repage -resize "${INNER}x${INNER}" \
    -background none -gravity center -extent "${S}x${S}" "$out"
  printf '  %-9s foreground %3spx  mark %3spx (%s%%)  -> %s\n' \
    "$d" "$S" "$INNER" "$INSET_PCT" "$out"
done
echo "done — commit $DEST so CI ships it"
