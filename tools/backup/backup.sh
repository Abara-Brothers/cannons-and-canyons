#!/usr/bin/env bash
#
# Cannons & Canyons — database backup.
#
#   bash tools/backup/backup-auto.sh            # normal use: reads the Keychain
#   bash tools/backup/backup.sh /path/to/dir    # direct use: PG* must already be set
#
# WHY THIS EXISTS: on Supabase's free plan there are NO automatic backups and
# NO point-in-time recovery. Nothing is protecting this data but this script.
#
# WHAT IT CAPTURES, and why all three parts are required:
#   roles.sql   — role grants
#   auth.sql    — THE AUTH SCHEMA. Not optional. Every profile and push
#                 subscription has a foreign key to auth.users, so a dump of
#                 `public` alone CANNOT be restored: the inserts fail with a
#                 foreign-key violation on a fresh project. Verified in the
#                 2026-08-14 restore drill, which is the whole reason this
#                 script does not just dump public.
#   public.sql  — the game's own tables and data
#
# The schema itself is ALSO reproducible from supabase/migrations/ (proven in
# the same drill: the three tracked migrations rebuilt every table, index,
# policy and trigger from scratch). These dumps are the DATA insurance.
#
# WHY pg_dump AND NOT THE SUPABASE CLI (changed 2026-08-17): `supabase db dump`
# runs pg_dump inside a DOCKER CONTAINER. There is no Docker on this machine,
# so the very first run of this script — a year after it was written — died on
# `LegacyDockerRunError` before it ever reached the database. Docker Desktop is
# also the wrong dependency for a scheduled job: it is a GUI application that
# must be RUNNING, and an unattended weekly backup cannot assume that. libpq's
# pg_dump has no daemon and no container. `brew install libpq`.
#
# HOW CREDENTIALS ARE PASSED: through the standard PG* environment variables,
# never as a URI on the command line. Command-line arguments are visible to
# every process on the machine via `ps`; a subprocess environment is not. This
# also removes percent-encoding entirely — a URI needs the password escaped,
# PGPASSWORD does not — and percent-encoding by hand is exactly the kind of
# step that produced a leaked credential on 2026-08-17.
set -euo pipefail

OUT_ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_ROOT/$STAMP"

: "${PGHOST:?PGHOST is not set — run tools/backup/backup-auto.sh instead, or see the header}"
: "${PGUSER:?PGUSER is not set}"
: "${PGPASSWORD:?PGPASSWORD is not set}"
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-postgres}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-30}"

# libpq is keg-only under Homebrew, so it is not on PATH by default — and a
# launchd job gets an even barer PATH than a login shell.
PG_BIN=""
for p in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
  [ -x "$p/pg_dump" ] && PG_BIN="$p" && break
done
if [ -z "$PG_BIN" ]; then
  command -v pg_dump >/dev/null 2>&1 || {
    echo "pg_dump not found. Install it: brew install libpq" >&2; exit 1; }
  PG_BIN="$(dirname "$(command -v pg_dump)")"
fi
DUMP="$PG_BIN/pg_dump"
DUMPALL="$PG_BIN/pg_dumpall"
PSQL="$PG_BIN/psql"

mkdir -p "$OUT"
echo "backing up to $OUT"
echo "using $("$DUMP" --version)"

# Roles are best-effort ON PURPOSE. --no-role-passwords reads pg_roles rather
# than pg_authid, because Supabase's `postgres` login is NOT a superuser and
# cannot read pg_authid. Roles are platform-managed anyway, so a missing
# roles.sql must not fail a backup that has the irreplaceable data in it.
if "$DUMPALL" --roles-only --no-role-passwords -f "$OUT/roles.sql" 2>"$OUT/.roles.err"; then
  rm -f "$OUT/.roles.err"
else
  echo "  note: roles dump failed (platform-managed on Supabase; not fatal)"
  mv "$OUT/.roles.err" "$OUT/roles.FAILED.txt" 2>/dev/null || true
  : > "$OUT/roles.sql"
fi

echo "  dumping auth data..."
"$DUMP" --schema=auth --data-only --no-owner --no-privileges -f "$OUT/auth.sql"

echo "  dumping public data..."
"$DUMP" --schema=public --data-only --no-owner --no-privileges -f "$OUT/public.sql"

# Row counts make a restore VERIFIABLE instead of hopeful, and catch the
# failure mode that matters most: a dump that "succeeds" while containing
# nothing. A backup nobody has counted is a backup nobody has checked.
counts="$("$PSQL" -Atc "
  select 'auth.users=' || (select count(*) from auth.users)
      || ' profiles='  || (select count(*) from public.profiles)
      || ' push_subs=' || (select count(*) from public.push_subscriptions)
" 2>/dev/null || echo 'unavailable')"

cat > "$OUT/MANIFEST.txt" <<EOF
Cannons & Canyons backup
taken_at   : $STAMP
host       : $PGHOST:$PGPORT  (password not recorded)
database   : $PGDATABASE as $PGUSER
dumped_by  : $("$DUMP" --version)
live_rows  : $counts
files      : roles.sql auth.sql public.sql
restore    : see tools/backup/RESTORE.md — auth.sql MUST be loaded before public.sql
EOF

ls -la "$OUT"
echo
echo "live row counts at dump time: $counts"
echo "done. Store this OFF the machine that made it (that is the point of a backup)."
