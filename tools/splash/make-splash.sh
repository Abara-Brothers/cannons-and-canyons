#!/usr/bin/env bash
# Generate every splash asset at its EXACT target size, so nothing is stretched
# by Android's window-background scaling and nothing is centre-cropped away on
# iOS. One HTML template renders at each aspect; the lockup is sized in `vmin`
# so it scales with the frame instead of being cropped by it.
#
# Usage:  bash tools/splash/make-splash.sh          # render into tools/splash/out
#         bash tools/splash/make-splash.sh --install # …and copy into both projects
#
# Why headless Chrome: this machine has no SVG rasteriser (no rsvg, ImageMagick,
# cairosvg or Pillow), and Chrome renders the icon SVG plus the app's own
# gradient-clipped wordmark exactly as the game does. Adding an image toolchain
# just to draw two rectangles would be the heavier choice.
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$S/../.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$S/out"; mkdir -p "$OUT"
TPL="$S/splash.html"
# The template references icon.svg next to itself.
cp "$ROOT/public/icons/icon.svg" "$S/icon.svg"

# Headless Chrome exits 0 when a file:// navigation fails: it screenshots its own
# "Your file couldn't be accessed" page at the requested window size. With the
# output silenced, `set -euo pipefail` never trips and `--install` happily copies
# 12 KB error pages over the shipped 1.29 MB assets. That is exactly what a stale
# filename here did once — the template is splash.html, not splash-tpl.html — and
# it went unnoticed because nothing ever looked at the result. So: check the
# template up front, let Chrome's stderr through, and sanity-check every render.
[ -f "$TPL" ] || { echo "template missing: $TPL" >&2; exit 1; }

render() {              # render <w> <h> <outfile>
  local w=$1 h=$2 out=$3
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --screenshot="$out" --window-size="$w,$h" --default-background-color=0b1020ff \
    "file://$TPL" 2>&1 | grep -vi 'devtools listening\|^$' || true
  [ -s "$out" ] || { echo "render produced nothing: $out" >&2; exit 1; }

  # An error page is nearly flat, so it compresses to a fraction of the real
  # artwork. The genuine renders sit above 0.15 bytes/pixel; the error pages
  # measured 0.009. 0.05 separates them with two orders of magnitude to spare.
  local px=$((w * h))
  local bytes; bytes=$(wc -c < "$out" | tr -d ' ')
  if [ "$((bytes * 1000 / px))" -lt 50 ]; then
    echo "render looks blank or is an error page: $out (${bytes}B for ${w}x${h})" >&2
    echo "nothing was installed. Open it and check the template renders." >&2
    exit 1
  fi
}

# iOS: one square, centre-cropped by the OS to every device aspect.
render 2732 2732 "$OUT/splash-2732x2732.png"

# Android landscape
render  480  320 "$OUT/land-mdpi.png"
render  800  480 "$OUT/land-hdpi.png"
render 1280  720 "$OUT/land-xhdpi.png"
render 1600  960 "$OUT/land-xxhdpi.png"
render 1920 1280 "$OUT/land-xxxhdpi.png"

# Android portrait
render  320  480 "$OUT/port-mdpi.png"
render  480  800 "$OUT/port-hdpi.png"
render  720 1280 "$OUT/port-xhdpi.png"
render  960 1600 "$OUT/port-xxhdpi.png"
render 1280 1920 "$OUT/port-xxxhdpi.png"

# The orientation-less default Android uses before it picks a bucket.
render  480  320 "$OUT/default.png"

echo "rendered:"; ls -1 "$OUT" | sed 's/^/  /'

# --install copies the rendered set into both native projects at the exact
# sizes Capacitor generated, so nothing is stretched or re-scaled.
if [ "${1:-}" = "--install" ]; then
  R="$ROOT/android/app/src/main/res"
  cp "$OUT/default.png"      "$R/drawable/splash.png"
  for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
    cp "$OUT/land-$d.png" "$R/drawable-land-$d/splash.png"
    cp "$OUT/port-$d.png" "$R/drawable-port-$d/splash.png"
  done
  for f in "$ROOT"/ios/App/App/Assets.xcassets/Splash.imageset/*.png; do
    cp "$OUT/splash-2732x2732.png" "$f"
  done
  echo "installed into android/ and ios/ — run 'npx cap sync' next"
fi
