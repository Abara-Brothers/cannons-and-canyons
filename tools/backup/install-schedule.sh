#!/usr/bin/env bash
#
# Install (or remove) a weekly launchd job that runs backup-auto.sh.
#
#   bash tools/backup/install-schedule.sh            # install + load
#   bash tools/backup/install-schedule.sh --remove   # unload + delete
#
# Weekly, Sundays 10:00 local. launchd runs a missed job when the machine next
# wakes, so a laptop that was shut at 10:00 still gets its backup — which is the
# whole reason for launchd over cron here.
set -euo pipefail

LABEL="com.abarabrothers.cannons-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

# Refuse to schedule something that cannot work — a job that fails silently every
# week is worse than no job, because the calendar entry reads as protection.
if ! command -v supabase >/dev/null 2>&1 \
   && [ ! -x /opt/homebrew/bin/supabase ] && [ ! -x /usr/local/bin/supabase ]; then
  echo "REFUSING: the Supabase CLI is not installed." >&2
  echo "  brew install supabase/tap/supabase" >&2
  exit 1
fi
if ! security find-generic-password -s cc-supabase-db-url -w >/dev/null 2>&1; then
  echo "REFUSING: no 'cc-supabase-db-url' entry in your Keychain." >&2
  echo "  See the setup notes at the top of tools/backup/backup-auto.sh." >&2
  echo "  Store the connection string yourself — never paste it into a chat or a file." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/backup-auto.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>0</integer>
    <key>Hour</key><integer>10</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$ROOT/backups/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/backups/launchd.err.log</string>
</dict>
</plist>
PLIST_EOF

mkdir -p "$ROOT/backups"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $LABEL — weekly, Sundays 10:00"
echo
echo "  run one now:   bash $HERE/backup-auto.sh"
echo "  check it ran:  tail $ROOT/backups/backup.log"
echo "  remove:        bash $HERE/install-schedule.sh --remove"
echo
echo "Note: these dumps stay on THIS machine. That protects against a bad"
echo "migration or a mistaken delete, not against losing the laptop."
