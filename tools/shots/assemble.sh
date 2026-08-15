#!/usr/bin/env bash
# Build the store-ready run3 tree from the native iPhone captures and the
# web-rendered iPad / Android sets. Every output is written opaque at the exact
# size each store demands.
set -euo pipefail
cd "$(dirname "$0")"

DEST="${1:?usage: assemble.sh <destDir>}"
FRAMES=(01-aim 02-strike 03-impact 04-boss 05-aliens 06-golf 07-home)

# The Dynamic Island bounding box measured on the rotated iPhone 17 Pro Max frame.
ISLAND_X0=40
ISLAND_X1=153

mkdir -p "$DEST"/{iphone-6.9,iphone-6.5,ipad-13,android-phone,android-tablet}

echo "iphone-6.9  2868x1320  (iPhone 17 Pro Max simulator, native)"
for f in "${FRAMES[@]}"; do
  swift shot.swift build "picks/$f.png" "$DEST/iphone-6.9/$f.png" 2868 1320 $ISLAND_X0 $ISLAND_X1 >/dev/null
done

echo "iphone-6.5  2688x1242  (same masters, resampled 0.4% off-aspect)"
for f in "${FRAMES[@]}"; do
  swift shot.swift build "picks/$f.png" "$DEST/iphone-6.5/$f.png" 2688 1242 $ISLAND_X0 $ISLAND_X1 >/dev/null
done

flatten() { # flatten <srcDir> <dstDir> <w> <h>
  for f in "${FRAMES[@]}"; do
    swift shot.swift flat "$1/$f.png" "$2/$f.png" "$3" "$4" >/dev/null
  done
}

echo "ipad-13        2752x2064  (web build @ 1376x1032 css, dpr 2)"
flatten web/ipad-13       "$DEST/ipad-13"       2752 2064
echo "android-phone  1920x1080  (web build @  640x360  css, dpr 3)"
flatten web/android-phone "$DEST/android-phone" 1920 1080
echo "android-tablet 2560x1600  (web build @ 1280x800  css, dpr 2)"
flatten web/android-tablet "$DEST/android-tablet" 2560 1600

echo
echo "verifying …"
fail=0
check() { # check <dir> <w> <h>
  for f in "$1"/*.png; do
    read -r w h < <(sips -g pixelWidth -g pixelHeight "$f" | awk '/pixel/{printf "%s ",$2} END{print ""}')
    ct=$(python3 -c "import struct,sys;d=open(sys.argv[1],'rb').read();print(struct.unpack('>IIBB',d[16:26])[3])" "$f")
    if [ "$w" != "$2" ] || [ "$h" != "$3" ]; then echo "  SIZE  $f -> ${w}x${h} (want $2x$3)"; fail=1; fi
    if [ "$ct" != "2" ]; then echo "  ALPHA $f -> PNG colour type $ct (want 2 = RGB, no alpha)"; fail=1; fi
  done
}
check "$DEST/iphone-6.9"    2868 1320
check "$DEST/iphone-6.5"    2688 1242
check "$DEST/ipad-13"       2752 2064
check "$DEST/android-phone" 1920 1080
check "$DEST/android-tablet" 2560 1600
[ "$fail" = 0 ] && echo "  all $(find "$DEST" -name '*.png' | wc -l | tr -d ' ') files: exact size, no alpha channel"
exit $fail
