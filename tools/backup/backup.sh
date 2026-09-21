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

HERE="$(cd "$(dirname "$0")" && pwd)"
# Sourced rather than inlined so the suite can exercise it: these are pure string
# functions with no database, and tools/backup/test-validate.sh runs them.
. "$HERE/lib-counts.sh"

OUT_ROOT="${1:-$(cd "$HERE/../.." && pwd)/backups}"
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
#
# WHICH TABLES ARE ACTUALLY THERE, asked before anything counts them. The phase 6
# migration is applied by hand and the deploy is separate, so this script has to
# be right in both windows. to_regclass answers NULL for a relation that does not
# exist instead of raising 42P01, so this probe can never be the thing that fails,
# and it names the gap instead of guessing at it. See lib-counts.sh for what the
# single-statement version cost.
probe="$("$PSQL" -Atc "
  select 'ok:' || coalesce(string_agg(t.n, ' ' order by t.n), '')
    from unnest(array['friendships','friend_requests','blocks','name_reports']) as t(n)
   where to_regclass('public.' || t.n) is not null
" 2>/dev/null || echo '')"
case "$probe" in
  # The 'ok:' prefix is what separates "the answer is none" from "there was no
  # answer". An unreachable database must not be recorded as a database without
  # tables: that would write a fact into the manifest that nobody established.
  ok:*) present="${probe#ok:}"; absent="$(counts_absent $present)" ;;
  *)    present=""; absent="unknown" ;;
esac

counts="$("$PSQL" -Atc "$(counts_sql $present)" 2>/dev/null || echo 'unavailable')"

case "$absent" in
  "")      absent_note="none — every table this tooling knows about existed and was counted" ;;
  unknown) absent_note="unknown — the schema probe did not answer, so this backup cannot say which tables existed" ;;
  *)       absent_note="$absent — not in the database at dump time (the phase 6 migration is not applied yet). They are not counted above and hold nothing to dump; nothing that EXISTS is missing from this backup." ;;
esac
if [ -n "$absent" ]; then
  echo "  note: $absent_note"
fi

# The fingerprint is the check that counts cannot make: equal row counts still
# hide corrupted progression JSON. It is computed HERE, at dump time, and written
# into the manifest — because RESTORE.md used to carry one hardcoded value from
# the 4-profile drill of 2026-08-14, which could never match once there were 14
# profiles, and the manifest it told you to compare against held no fingerprint
# at all. An operator meets that contradiction mid-incident, and concludes the
# backup is corrupt.
#
# PGTZ is pinned because created_at::text renders in the session's timezone: the
# same data fingerprints differently from a UTC server and a local machine, which
# cost a false failure in the restore drill before it was pinned.
fingerprint="$(PGTZ=UTC "$PSQL" -Atc "
  select coalesce(md5(string_agg(
      p.id::text || coalesce(p.callsign,'') || coalesce(p.progression::text,''),
      '|' order by p.id::text)), 'no-rows')
  from public.profiles p
" 2>/dev/null || echo 'unavailable')"

cat > "$OUT/MANIFEST.txt" <<EOF
Cannons & Canyons backup
taken_at   : $STAMP
host       : $PGHOST:$PGPORT  (password not recorded)
database   : $PGDATABASE as $PGUSER
dumped_by  : $("$DUMP" --version)
live_rows  : $counts
absent_tables : $absent_note
profiles_fingerprint : $fingerprint
  (md5 over id + callsign + progression, ordered by id, computed with PGTZ=UTC.
   After a restore, re-run the same query and compare against THIS value —
   never against a number written in a runbook, which goes stale the moment
   anyone signs up.)
files      : roles.sql auth.sql public.sql
restore    : see tools/backup/RESTORE.md — auth.sql MUST be loaded before public.sql
EOF

ls -la "$OUT"
echo
echo "live row counts at dump time: $counts"
echo "done. Store this OFF the machine that made it (that is the point of a backup)."
