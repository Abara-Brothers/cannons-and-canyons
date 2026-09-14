#!/usr/bin/env bash
# Build the store-ready tree from the native iPhone captures and the
# web-rendered iPad / Android sets. Every output is written opaque at the exact
# size each store demands.
#
#   assemble.sh <destDir> [--carry <previousRunDir>]
#
# FRAME COUNTS DIFFER BY STORE, deliberately:
#   App Store allows 10 screenshots, Google Play allows 8. We have 9 frames, so
#   the Play sets drop 08-manual — the field manual is a reference screen, and
#   of the two onboarding frames 00-coach is the one that also shows the game.
#
# --carry lets a run reuse a previous run's ALREADY-PROCESSED iPhone frames for
# any frame with no master in picks/. That is not laziness: the iPhone masters
# are raw simulator framebuffers that are not kept in the repo, so a run that
# only re-shoots the frames which actually changed would otherwise have to
# re-shoot all seven unchanged ones by hand through a rotated WebView.
set -euo pipefail
cd "$(dirname "$0")"

DEST="${1:?usage: assemble.sh <destDir> [--carry <previousRunDir>]}"
CARRY=""
if [ "${2:-}" = "--carry" ]; then CARRY="${3:?--carry needs a directory}"; fi

# 00 first: it is the first thing a new player sees. 08 last: reference, not sell.
APPLE_FRAMES=(00-coach 01-aim 02-strike 03-impact 04-boss 05-aliens 06-golf 07-home 08-manual)
PLAY_FRAMES=(00-coach 01-aim 02-strike 03-impact 04-boss 05-aliens 06-golf 07-home)

# The Dynamic Island bounding box measured on the rotated iPhone 17 Pro Max frame.
ISLAND_X0=40
ISLAND_X1=153

mkdir -p "$DEST"/{iphone-6.9,iphone-6.5,ipad-13,android-phone,android-tablet}

# iphone <folder> <w> <h> — build from a native master, or carry the processed
# frame forward from the previous run when this frame did not change.
iphone() {
  local folder="$1" w="$2" h="$3" built=0 carried=0
  for f in "${APPLE_FRAMES[@]}"; do
    if [ -f "picks/$f.png" ]; then
      swift shot.swift build "picks/$f.png" "$DEST/$folder/$f.png" "$w" "$h" $ISLAND_X0 $ISLAND_X1 >/dev/null
      built=$((built + 1))
    elif [ -n "$CARRY" ] && [ -f "$CARRY/$folder/$f.png" ]; then
      cp "$CARRY/$folder/$f.png" "$DEST/$folder/$f.png"
      carried=$((carried + 1))
    else
      echo "  MISSING $folder/$f — no picks/$f.png and no carry source"; exit 1
    fi
  done
  echo "  $folder: $built shot, $carried carried"
}

echo "iphone-6.9  2868x1320  (iPhone 17 Pro Max simulator, native)"
iphone iphone-6.9 2868 1320
echo "iphone-6.5  2688x1242  (same masters, resampled 0.4% off-aspect)"
iphone iphone-6.5 2688 1242

flatten() { # flatten <srcDir> <dstDir> <w> <h> <frames...>
  local src="$1" dst="$2" w="$3" h="$4"; shift 4
  for f in "$@"; do
    swift shot.swift flat "$src/$f.png" "$dst/$f.png" "$w" "$h" >/dev/null
  done
}

echo "ipad-13        2752x2064  (web build @ 1376x1032 css, dpr 2)"
flatten web/ipad-13       "$DEST/ipad-13"       2752 2064 "${APPLE_FRAMES[@]}"
echo "android-phone  1920x1080  (web build @  640x360  css, dpr 3)"
flatten web/android-phone "$DEST/android-phone" 1920 1080 "${PLAY_FRAMES[@]}"
echo "android-tablet 2560x1600  (web build @ 1280x800  css, dpr 2)"
flatten web/android-tablet "$DEST/android-tablet" 2560 1600 "${PLAY_FRAMES[@]}"

echo
echo "verifying …"
fail=0
check() { # check <dir> <w> <h> <wantCount>
  local n=0
  for f in "$1"/*.png; do
    n=$((n + 1))
    read -r w h < <(sips -g pixelWidth -g pixelHeight "$f" | awk '/pixel/{printf "%s ",$2} END{print ""}')
    ct=$(python3 -c "import struct,sys;d=open(sys.argv[1],'rb').read();print(struct.unpack('>IIBB',d[16:26])[3])" "$f")
    if [ "$w" != "$2" ] || [ "$h" != "$3" ]; then echo "  SIZE  $f -> ${w}x${h} (want $2x$3)"; fail=1; fi
    if [ "$ct" != "2" ]; then echo "  ALPHA $f -> PNG colour type $ct (want 2 = RGB, no alpha)"; fail=1; fi
  done
  if [ "$n" != "$4" ]; then echo "  COUNT $1 -> $n files (want $4)"; fail=1; fi
}
check "$DEST/iphone-6.9"     2868 1320 "${#APPLE_FRAMES[@]}"
check "$DEST/iphone-6.5"     2688 1242 "${#APPLE_FRAMES[@]}"
check "$DEST/ipad-13"        2752 2064 "${#APPLE_FRAMES[@]}"
check "$DEST/android-phone"  1920 1080 "${#PLAY_FRAMES[@]}"
check "$DEST/android-tablet" 2560 1600 "${#PLAY_FRAMES[@]}"
[ "$fail" = 0 ] && echo "  all $(find "$DEST" -name '*.png' | wc -l | tr -d ' ') files: exact size, no alpha channel, expected counts"
exit $fail
