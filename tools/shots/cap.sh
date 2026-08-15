#!/usr/bin/env bash
# cap.sh <udid> <name>  — grab a raw simulator framebuffer into raw/<name>.png
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw
xcrun simctl io "$1" screenshot --mask ignored "raw/$2.png" >/dev/null 2>&1
sips -g pixelWidth -g pixelHeight "raw/$2.png" | awk '/pixel/{printf "%s ", $2} END{print ""}'
