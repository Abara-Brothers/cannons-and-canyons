#!/usr/bin/env bash
#
# Unattended wrapper around backup.sh, for a schedule.
#
# WHY THIS EXISTS: this project is on the Supabase FREE plan (confirmed
# 2026-08-15), which has NO automatic backups and NO point-in-time recovery.
# `backup.sh` was documented as "the only thing standing between a mistake and
# permanent loss of every account" — and on 2026-08-15 it turned out it had
# never been run, there was no backups/ directory, and the Supabase CLI was not
# even installed. A backup procedure nobody runs is not a backup procedure.
#
# THE SECRET NEVER TOUCHES A FILE. backup.sh needs SUPABASE_DB_URL, which
# embeds the database password. That must not live in a script, in a plist, in
# shell history, or in a chat log. It is read from the macOS Keychain at run
# time instead, so the only copy is the one the OS protects.
#
# ---------------------------------------------------------------------------
# ONE-TIME SETUP — run these yourself; do not paste the URL to anyone.
#
#   1. Install the CLI:
#        brew install supabase/tap/supabase
#
#   2. Get the connection string: Supabase dashboard → Project Settings →
#      Database → Connection string → URI. Use the SESSION POOLER host
#      (aws-1-…pooler.supabase.com), NOT db.<ref>.supabase.co — the direct
#      host is IPv6-only and fails from most networks.
#
#   3. Store it in the Keychain. Run it with NO value after -w: `security` then
#      prompts and reads it without echo, so the string never appears on the
#      command line, in your shell history, or in a process list. It also side-
#      steps shell quoting, which is the usual reason this step silently fails —
#      database passwords routinely contain !, $ or #, and an unquoted (or
#      double-quoted) value gets mangled by the shell before `security` sees it.
#
#        security add-generic-password -a "$USER" -s cc-supabase-db-url \
#          -T /usr/bin/security -U -w
#
#      Paste the URI at the prompt, press return. `-T /usr/bin/security` puts the
#      security binary on the item's access list, so the scheduled job can read it
#      without a GUI dialog — a launchd job cannot answer one, and a backup that
#      blocks on an invisible prompt is a backup that never runs. Only that one
#      binary is trusted; do NOT use -A, which trusts every application on the Mac.
#      If a dialog appears anyway on the first read, choose Always Allow.
#
#      Then check it took:
#
#        security find-generic-password -s cc-supabase-db-url >/dev/null && echo stored
#
#   4. Prove it works before trusting the schedule:
#        bash tools/backup/backup-auto.sh
#
#   5. Schedule it:
#        bash tools/backup/install-schedule.sh
# ---------------------------------------------------------------------------
set -uo pipefail

KEYCHAIN_SERVICE="cc-supabase-db-url"
KEEP=8                                    # ~2 months of weekly runs
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT_ROOT="${CC_BACKUP_DIR:-$ROOT/backups}"
LOG="$OUT_ROOT/backup.log"

mkdir -p "$OUT_ROOT"
say() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG"; }

say "starting"

if ! command -v supabase >/dev/null 2>&1; then
  # Homebrew is not on a launchd job's PATH by default.
  for p in /opt/homebrew/bin /usr/local/bin; do
    [ -x "$p/supabase" ] && PATH="$p:$PATH" && break
  done
fi
if ! command -v supabase >/dev/null 2>&1; then
  say "FAILED: supabase CLI not found. Install it: brew install supabase/tap/supabase"
  exit 1
fi

DB_URL="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
if [ -z "$DB_URL" ]; then
  say "FAILED: no '$KEYCHAIN_SERVICE' entry in the Keychain — see the setup notes in this file"
  exit 1
fi

# backup.sh does the real work: roles + auth + public, in restore order. The
# auth schema is not optional — a public-only dump cannot be restored, which the
# 2026-08-14 drill proved by having the insert rejected on a foreign key.
if SUPABASE_DB_URL="$DB_URL" bash "$HERE/backup.sh" "$OUT_ROOT" >>"$LOG" 2>&1; then
  latest="$(ls -1dt "$OUT_ROOT"/*/ 2>/dev/null | head -1)"
  # A "successful" dump of nothing is the failure mode worth catching: if auth.sql
  # is empty the backup is useless and everything downstream would look fine.
  if [ -n "$latest" ] && [ -s "${latest}auth.sql" ] && [ -s "${latest}public.sql" ]; then
    say "OK: $(basename "$latest") — $(du -sh "$latest" | cut -f1)"
  else
    say "FAILED: dump completed but auth.sql or public.sql is EMPTY — do not trust it"
    exit 1
  fi
else
  say "FAILED: backup.sh returned non-zero — see the log above"
  exit 1
fi

# Prune, newest kept. Local rotation only — see the off-site note below.
n=0
for d in $(ls -1dt "$OUT_ROOT"/*/ 2>/dev/null); do
  n=$((n + 1))
  [ "$n" -gt "$KEEP" ] && rm -rf "$d" && say "pruned $(basename "$d")"
done

say "done ($(ls -1d "$OUT_ROOT"/*/ 2>/dev/null | wc -l | tr -d ' ') kept)"

# HONEST LIMITATION: this is a LOCAL copy on the same machine that made it,
# which is not a backup in the sense that matters — one disk failure or one
# stolen laptop takes the database and every copy of it. It is strictly better
# than the nothing that existed before, and it buys protection against the far
# likelier accident: a bad migration or a mistaken delete. Getting these off the
# machine (an encrypted external disk, or object storage the game does not use)
# is the remaining half, and it is a decision about where user data may live.
