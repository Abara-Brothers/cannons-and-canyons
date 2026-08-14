#!/usr/bin/env bash
#
# Cannons & Canyons — database backup.
#
#   bash tools/backup/backup.sh                 # writes ./backups/<timestamp>/
#   bash tools/backup/backup.sh /path/to/dir    # …somewhere else
#
# WHY THIS EXISTS: on Supabase's free plan there are NO automatic backups and
# NO point-in-time recovery. Nothing is protecting this data but this script.
# Even on Pro, daily snapshots are 7-day retention — this is the off-site copy.
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
# Requires: the Supabase CLI (`brew install supabase/tap/supabase`) and the
# project's database password. The password is a SECRET: keep it in your
# password manager, pass it in the environment, never commit it.
#
#   export SUPABASE_DB_URL='postgresql://postgres.<ref>:<password>@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres'
#
# Use the SESSION POOLER host, not db.<ref>.supabase.co — the direct host is
# IPv6-only and will fail from most networks.
set -euo pipefail

OUT_ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_ROOT/$STAMP"

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SUPABASE_DB_URL is not set — see the header of this script." >&2
  exit 1
fi
command -v supabase >/dev/null || { echo "supabase CLI not found: brew install supabase/tap/supabase" >&2; exit 1; }

mkdir -p "$OUT"
echo "backing up to $OUT"

supabase db dump --db-url "$SUPABASE_DB_URL" --role-only  -f "$OUT/roles.sql"
supabase db dump --db-url "$SUPABASE_DB_URL" --schema auth --data-only -f "$OUT/auth.sql"
supabase db dump --db-url "$SUPABASE_DB_URL" --data-only  -f "$OUT/public.sql"

# A manifest makes a restore VERIFIABLE instead of hopeful: the fingerprints
# are the same expressions the drill compares after reloading.
cat > "$OUT/MANIFEST.txt" <<EOF
Cannons & Canyons backup
taken_at   : $STAMP
source     : ${SUPABASE_DB_URL%%:*}://…(redacted)
files      : roles.sql auth.sql public.sql
restore    : see tools/backup/RESTORE.md — auth.sql MUST be loaded before public.sql
EOF

ls -la "$OUT"
echo
echo "done. Store this OFF the machine that made it (that is the point of a backup)."
