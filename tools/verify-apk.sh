#!/usr/bin/env bash
#
# verify-apk.sh — is the built APK actually the code you think it is?
#
#   bash tools/verify-apk.sh
#
# WHY: on 2026-08-21 the debug APK on disk was **22 commits behind** HEAD while
# `RELEASE_CHECKLIST.md` called it "rebuilt and current". Running the one
# physical-device test against that binary would have validated a client nobody
# will ever ship — and burned the only chance to see the accessibility, ghost-seat
# and native-OAuth work on real hardware.
#
# WHY NOT A PRE-PUSH HOOK: `tools/hooks/pre-push` runs on every push to main, and
# a raw `public/` vs bundled diff would refuse every ordinary web-only push — the
# APK is *expected* to lag until someone rebuilds it. This is a RELEASE-TIME and
# BEFORE-DEVICE-TESTING check, run deliberately.
#
# WHY NOT A VERSION COMPARE: `house-rules.mjs` already asserts the version strings
# agree, and they did agree throughout — 1.0.0/build 1 on both sides — while the
# binary was months of work out of date. A version string cannot detect this.
# Only hashing the bundled assets can.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="${1:-$ROOT/android/app/build/outputs/apk/debug/app-debug.apk}"

[ -f "$APK" ] || { echo "no APK at $APK — build one:  cd android && ./gradlew assembleDebug" >&2; exit 1; }

# EVERY file under public/, not a hand-listed few. The first version named seven
# JS files, so a stale 102 KB styles.css — or a changed icon, manifest or privacy
# page — sailed through and the script still printed "safe to test on a device".
# A hand-maintained list is the same class of mistake as the version-string check
# it replaced: it looks like coverage and is not.
#
# index.html is EXEMPT: `cap sync` legitimately injects cordova script tags, so it
# is expected to differ and comparing it would cry wolf on every run.
EXEMPT="index.html"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

echo "APK : $APK"
echo "built: $(date -r "$APK" '+%Y-%m-%d %H:%M')"
echo "HEAD : $(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo '?')"
echo

stale=0
checked=0
while IFS= read -r rel; do
  case " $EXEMPT " in *" $rel "*) continue ;; esac
  checked=$((checked + 1))
  mkdir -p "$tmp/$(dirname "$rel")"
  if ! unzip -p "$APK" "assets/public/$rel" > "$tmp/$rel" 2>/dev/null; then
    printf '  %-28s MISSING FROM APK\n' "$rel"; stale=$((stale + 1)); continue
  fi
  a="$(shasum -a 256 "$tmp/$rel" | cut -d' ' -f1)"
  b="$(shasum -a 256 "$ROOT/public/$rel" | cut -d' ' -f1)"
  if [ "$a" != "$b" ]; then
    printf '  %-28s STALE  apk=%s  tree=%s\n' "$rel" "${a:0:12}" "${b:0:12}"; stale=$((stale + 1))
  fi
done < <(cd "$ROOT/public" && find . -type f ! -name '.DS_Store' | sed 's|^\./||' | sort)
echo "  checked $checked file(s) under public/ (exempt: $EXEMPT)"

echo
if [ "$stale" -eq 0 ]; then
  echo "APK matches the working tree — safe to test on a device."
  exit 0
fi
echo "$stale file(s) STALE. Rebuild before any device test:"
echo "    npx cap sync android && (cd android && ./gradlew assembleDebug)"
echo "Testing a stale APK validates a client you will not ship."
exit 1
