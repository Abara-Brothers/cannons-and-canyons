#!/usr/bin/env bash
#
# restore-drill.sh — prove the backup can actually be restored.
#
#   bash tools/backup/restore-drill.sh [<backup-dir>]     # default: newest in backups/
#
# WHY: a backup that has never been restored is a hypothesis. The 2026-08-14
# drill proved the restore PATH, but it did so with dumps produced by the
# Supabase CLI; on 2026-08-17 that producer was replaced with pg_dump, so that
# evidence no longer covers the files actually on disk.
#
# WHAT IT SIMULATES — RESTORE.md Case 2, "the project is gone, rebuild":
#   1. roles.sql        from the backup
#   2. auth schema DDL  pulled live from production, standing in for what
#                       Supabase creates automatically in a fresh project
#                       (our migrations do NOT create auth, and cannot)
#   3. supabase/migrations/*.sql   the repo rebuilding `public` from scratch
#   4. auth.sql         data — MUST precede public.sql
#   5. public.sql       data — every row FKs to auth.users
#
# Then it compares row counts against production and checks the foreign key
# that made the 2026-08-14 drill fail. Everything happens in a throwaway
# cluster on port 55432; nothing touches production but one read.
set -uo pipefail

PGV="/opt/homebrew/opt/postgresql@17/bin"
[ -x "$PGV/psql" ] || { echo "PostgreSQL 17 not found: brew install postgresql@17" >&2; exit 1; }
export PATH="$PGV:/opt/homebrew/opt/libpq/bin:$PATH"
export LC_ALL=en_US.UTF-8
# Both sides must render timestamps identically or the content hashes compare
# formatting, not data. Supabase runs UTC; a local cluster inherits the Mac's
# zone, so the same instant renders as +10 here and +00 there and every hash
# differs for a reason that has nothing to do with the backup.
export PGTZ=UTC

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="${1:-$(ls -1dt "$ROOT"/backups/*/ 2>/dev/null | head -1)}"
[ -n "$SRC" ] && [ -s "$SRC/auth.sql" ] || { echo "no usable backup found in $ROOT/backups" >&2; exit 1; }

PORT=55432
D="$(mktemp -d /tmp/ccdrill.XXXXXX)"
trap 'pg_ctl -D "$D/data" stop -m immediate >/dev/null 2>&1; rm -rf "$D"' EXIT

echo "restoring: $SRC"
echo "scratch  : $D"

initdb -D "$D/data" -U postgres --encoding=UTF8 >"$D/initdb.log" 2>&1 || { tail -5 "$D/initdb.log"; exit 1; }
pg_ctl -D "$D/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" \
       -l "$D/server.log" start >/dev/null 2>&1
for i in $(seq 1 20); do psql -h 127.0.0.1 -p $PORT -U postgres -Atc "select 1" >/dev/null 2>&1 && break; sleep 1; done
psql -h 127.0.0.1 -p $PORT -U postgres -Atc "select 1" >/dev/null 2>&1 || { tail -10 "$D/server.log"; exit 1; }

# A shell FUNCTION, not a variable holding a command line: under zsh an
# unquoted "$CMD" is NOT word-split, so it is looked up as a single executable
# name and silently fails. That produced a clean-looking pass on a drill where
# nothing had run at all.
pd() { psql -h 127.0.0.1 -p $PORT -U postgres -d drill -v ON_ERROR_STOP=0 "$@" 2>&1; }

psql -h 127.0.0.1 -p $PORT -U postgres -q -c "create database drill" >/dev/null 2>&1

# step <label> <file> [regex matching errors that are EXPECTED here]
#
# The third argument is not a way to make the drill go green. Roles on Supabase
# are platform-managed: they already exist, and the login doing the restore is
# not `supabase_admin`, so re-creating or re-granting them is refused. Those
# refusals say nothing about whether the DATA is restorable, and they would
# happen against a real fresh Supabase project too. Anything NOT matching the
# expected pattern is still counted as a genuine failure.
step() {
  local out all real benign
  out="$(pd -q -f "$2")"
  all="$(printf '%s\n' "$out" | grep 'ERROR:' || true)"
  if [ -z "$all" ]; then
    printf '  %-34s %s\n' "$1" "clean"; return
  fi
  if [ -n "${3:-}" ]; then
    real="$(printf '%s\n' "$all" | grep -Ev "$3" || true)"
    benign="$(printf '%s\n' "$all" | grep -Ec "$3" || true)"
  else
    real="$all"; benign=0
  fi
  local rn=0
  [ -n "$real" ] && rn="$(printf '%s\n' "$real" | grep -c 'ERROR:' || true)"
  if [ "$rn" -eq 0 ]; then
    printf '  %-34s %s\n' "$1" "clean ($benign expected refusals, see note)"
  else
    printf '  %-34s %s\n' "$1" "$rn UNEXPECTED ERRORS"
    printf '%s\n' "$real" | sed -E 's/^.*(ERROR:)/      \1/' | sort -u | head -8
  fi
  ERRS=$((ERRS + rn))
}

echo
echo "== pulling the auth schema from production (read-only) =="
PW="$(security find-generic-password -s cc-supabase-db-password -w 2>/dev/null)"
getc() { grep -E "^$1=" "$HERE/db.conf" | head -1 | cut -d= -f2-; }
if ! env PGHOST="$(getc PGHOST)" PGPORT="$(getc PGPORT)" PGUSER="$(getc PGUSER)" \
         PGDATABASE="$(getc PGDATABASE)" PGPASSWORD="$PW" \
     pg_dump --schema-only --schema=auth --no-owner --no-privileges -f "$D/auth-schema.sql" 2>"$D/pgdump.err"; then
  echo "  FAILED to read the auth schema — see $D/pgdump.err"; exit 1
fi
echo "  auth DDL: $(wc -l < "$D/auth-schema.sql" | tr -d ' ') lines"

ERRS=0
echo
echo "== restoring, in dependency order =="
step "1. roles.sql"        "$SRC/roles.sql" \
     "already exists|permission denied to (alter role|grant privileges as role)"
step "2. auth schema DDL"  "$D/auth-schema.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  step "3. $(basename "$f" | cut -c1-28)" "$f"
done
step "4. auth.sql (data)"  "$SRC/auth.sql"
step "5. public.sql (data)" "$SRC/public.sql"

echo
echo "== verifying against production =="
# Normalise BOTH sides identically. Comparing a squeezed string against an
# unsqueezed one reported a MISMATCH on numbers that were in fact equal.
norm() { printf '%s' "$1" | tr -s ' ' ' ' | sed -e 's/^ *//' -e 's/ *$//'; }
LIVE="$(norm "$(grep '^live_rows' "$SRC/MANIFEST.txt" 2>/dev/null | cut -d: -f2-)")"
GOT="$(norm "$(pd -Atc "select 'auth.users='||(select count(*) from auth.users)
                    ||' profiles='||(select count(*) from public.profiles)
                    ||' push_subs='||(select count(*) from public.push_subscriptions)")")"
echo "  at dump time : $LIVE"
echo "  restored     : $GOT"
[ "$LIVE" = "$GOT" ] && echo "  MATCH" || { echo "  MISMATCH"; ERRS=$((ERRS + 1)); }

echo
echo "== content fidelity (hashes, never the data itself) =="
# Row counts can match while every value is wrong. These hashes compare the
# actual contents, computed identically on both sides.
#
# Production keeps moving while the drill runs, so mutable rows are excluded
# by the dump's own timestamp rather than pretending the two are frozen: a
# profile touched after the dump SHOULD differ, and counting those separately
# is the difference between a real check and one tuned to pass.
prod() {
  env PGHOST="$(getc PGHOST)" PGPORT="$(getc PGPORT)" PGUSER="$(getc PGUSER)" \
      PGDATABASE="$(getc PGDATABASE)" PGPASSWORD="$PW" PGCONNECT_TIMEOUT=30 \
      psql -Atc "$1" 2>/dev/null
}
TS="$(grep '^taken_at' "$SRC/MANIFEST.txt" | cut -d: -f2- | tr -d ' ' \
      | sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$/\1-\2-\3 \4:\5:\6+00/')"
echo "  dump taken at: $TS"

Q_USERS="select md5(string_agg(id::text||'|'||coalesce(role,'')||'|'||coalesce(email,'')||'|'||created_at::text||'|'||coalesce(is_anonymous::text,''), chr(10) order by id::text)) from auth.users"
Q_PROF="select md5(string_agg(id::text||'|'||coalesce(callsign,'')||'|'||coalesce(progression::text,'')||'|'||coalesce(progression_version::text,'')||'|'||created_at::text, chr(10) order by id::text)) from public.profiles where updated_at <= '$TS'::timestamptz"

for pair in "auth.users|$Q_USERS" "public.profiles|$Q_PROF"; do
  label="${pair%%|*}"; q="${pair#*|}"
  a="$(prod "$q")"; b="$(pd -Atc "$q" | tr -d '\r')"
  if [ -n "$a" ] && [ "$a" = "$b" ]; then
    printf '  %-16s IDENTICAL  (md5 %s)\n' "$label" "$(printf '%s' "$a" | cut -c1-12)"
  else
    printf '  %-16s DIFFERS    prod=%s restored=%s\n' "$label" "$(printf '%s' "$a" | cut -c1-12)" "$(printf '%s' "$b" | cut -c1-12)"
    ERRS=$((ERRS + 1))
  fi
done
DRIFT="$(prod "select count(*) from public.profiles where updated_at > '$TS'::timestamptz")"
echo "  profiles changed in production since the dump: ${DRIFT:-?} (excluded above, not a fault)"

echo
echo "== the foreign key that failed the 2026-08-14 drill =="
ORPH="$(pd -Atc "select count(*) from public.profiles p
                 where not exists (select 1 from auth.users u where u.id = p.id)")"
echo "  profiles with no auth.users row: $ORPH"
[ "$ORPH" = "0" ] || ERRS=$((ERRS + 1))

echo
if [ "$ERRS" -eq 0 ]; then
  echo "DRILL PASSED — this backup restores."
else
  echo "DRILL FAILED — $ERRS problem(s) above. The backup is NOT proven restorable."
fi
exit $([ "$ERRS" -eq 0 ] && echo 0 || echo 1)
