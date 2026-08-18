#!/usr/bin/env bash
#
# db-connect.sh — run psql against the backup credential, without ever typing
# or pasting a connection string.
#
#   bash tools/backup/db-connect.sh                    # interactive psql
#   bash tools/backup/db-connect.sh -f roles.sql       # run a file
#   bash tools/backup/db-connect.sh -Atc "select 1"    # run one statement
#
# Every argument is passed straight through to psql.
#
# WHY: a restore is done under pressure, which is the worst possible moment to
# be hand-splicing a password into a URI. Doing exactly that on 2026-08-17
# produced a malformed string that psql rejected by printing the password back
# into the terminal. Host and user come from db.conf; the password comes from
# the Keychain and is handed over in PGPASSWORD, which never appears in `ps`.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONF="$HERE/db.conf"
SERVICE="cc-supabase-db-password"

[ -f "$CONF" ] || { echo "no $CONF — run: bash tools/backup/setup-credential.sh" >&2; exit 1; }

PSQL=""
for p in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
  [ -x "$p/psql" ] && PSQL="$p/psql" && break
done
[ -z "$PSQL" ] && command -v psql >/dev/null 2>&1 && PSQL="$(command -v psql)"
[ -n "$PSQL" ] || { echo "psql not found — brew install libpq" >&2; exit 1; }

getconf() { grep -E "^$1=" "$CONF" 2>/dev/null | head -1 | cut -d= -f2-; }
PW="$(security find-generic-password -s "$SERVICE" -w 2>/dev/null || true)"
[ -n "$PW" ] || { echo "no password in the Keychain — run: bash tools/backup/setup-credential.sh" >&2; exit 1; }

exec env \
  PGHOST="$(getconf PGHOST)" \
  PGPORT="$(getconf PGPORT)" \
  PGUSER="$(getconf PGUSER)" \
  PGDATABASE="$(getconf PGDATABASE)" \
  PGPASSWORD="$PW" \
  PGCONNECT_TIMEOUT=30 \
  "$PSQL" "$@"
