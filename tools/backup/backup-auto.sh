#!/usr/bin/env bash
#
# Unattended wrapper around backup.sh, for a schedule.
#
# WHY THIS EXISTS: this project is on the Supabase FREE plan, which has NO
# automatic backups and NO point-in-time recovery. `backup.sh` was documented as
# "the only thing standing between a mistake and permanent loss of every
# account" — and on 2026-08-15 it turned out it had never been run, there was no
# backups/ directory, and the Supabase CLI was not even installed. A backup
# procedure nobody runs is not a backup procedure.
#
# ---------------------------------------------------------------------------
# SETUP IS ONE COMMAND. Do not hand-edit connection strings:
#
#     bash tools/backup/setup-credential.sh
#
# It asks for the dashboard's connection URI (paste it UNEDITED — the password
# field is discarded) and then for the password, via macOS's own hidden prompt.
# Everything non-secret lands in db.conf; the password lands in the Keychain.
#
# Then prove it works, and only then schedule it:
#     bash tools/backup/backup-auto.sh
#     bash tools/backup/install-schedule.sh
# ---------------------------------------------------------------------------
#
# THE SECRET NEVER TOUCHES A FILE, A COMMAND LINE, OR SHELL HISTORY. It is read
# from the Keychain at run time and handed to pg_dump through PGPASSWORD.
# Arguments are world-readable via `ps`; a subprocess environment is not.
set -uo pipefail

KEYCHAIN_SERVICE="cc-supabase-db-password"
LEGACY_SERVICE="cc-supabase-db-url"       # pre-2026-08-17 hand-spliced URI
KEEP=8                                    # ~2 months of weekly runs
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CONF="$HERE/db.conf"
OUT_ROOT="${CC_BACKUP_DIR:-$ROOT/backups}"
LOG="$OUT_ROOT/backup.log"

mkdir -p "$OUT_ROOT"
say() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG"; }

say "starting"

# Homebrew is not on a launchd job's PATH, and libpq is keg-only on top of that.
for p in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin /opt/homebrew/bin /usr/local/bin; do
  [ -d "$p" ] && PATH="$p:$PATH"
done
export PATH
if ! command -v pg_dump >/dev/null 2>&1; then
  say "FAILED: pg_dump not found. Install it:  brew install libpq"
  exit 1
fi

if [ ! -f "$CONF" ]; then
  say "FAILED: $CONF is missing — run:  bash tools/backup/setup-credential.sh"
  exit 1
fi

# Read as data, not sourced: a config file that gets executed is a config file
# that can run anything.
getconf() { grep -E "^$1=" "$CONF" 2>/dev/null | head -1 | cut -d= -f2-; }
PGHOST="$(getconf PGHOST)"
PGPORT="$(getconf PGPORT)"
PGUSER="$(getconf PGUSER)"
PGDATABASE="$(getconf PGDATABASE)"
if [ -z "$PGHOST" ] || [ -z "$PGUSER" ]; then
  say "FAILED: $CONF has no PGHOST/PGUSER — re-run setup-credential.sh"
  exit 1
fi

PGPASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
if [ -z "$PGPASSWORD" ]; then
  if security find-generic-password -s "$LEGACY_SERVICE" >/dev/null 2>&1; then
    say "FAILED: found the OLD '$LEGACY_SERVICE' keychain item, which held a hand-spliced URI."
    say "        That scheme is retired. Run:  bash tools/backup/setup-credential.sh"
  else
    say "FAILED: no password in the Keychain — run:  bash tools/backup/setup-credential.sh"
  fi
  exit 1
fi

. "$HERE/lib-validate.sh"
if ! reason="$(validate_db_password "$PGPASSWORD")"; then
  say "FAILED: the stored password is not usable — $reason"
  say "        Re-run:  bash tools/backup/setup-credential.sh"
  exit 1
fi

# backup.sh does the real work: roles + auth + public, in restore order. The
# auth schema is not optional — a public-only dump cannot be restored, which the
# 2026-08-14 drill proved by having the insert rejected on a foreign key.
if PGHOST="$PGHOST" PGPORT="${PGPORT:-5432}" PGUSER="$PGUSER" \
   PGDATABASE="${PGDATABASE:-postgres}" PGPASSWORD="$PGPASSWORD" \
   bash "$HERE/backup.sh" "$OUT_ROOT" >>"$LOG" 2>&1; then
  latest="$(ls -1dt "$OUT_ROOT"/*/ 2>/dev/null | head -1)"
  # A "successful" dump of nothing is the failure mode worth catching: if auth.sql
  # is empty the backup is useless and everything downstream would look fine.
  if [ -n "$latest" ] && [ -s "${latest}auth.sql" ] && [ -s "${latest}public.sql" ]; then
    say "OK: $(basename "$latest") — $(du -sh "$latest" | cut -f1) — $(grep '^live_rows' "${latest}MANIFEST.txt" 2>/dev/null | cut -d: -f2-)"
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
