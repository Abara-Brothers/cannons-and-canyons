#!/usr/bin/env bash
#
# setup-credential.sh — one command, two pastes, no editing.
#
# WHY THIS EXISTS: the old instructions asked a human to splice a password into
# a connection string by hand. On 2026-08-17 that produced a URI with the
# dashboard's square brackets still around the password and a stray space
# inside them. psql rejected it by QUOTING THE PASSWORD FIELD BACK into the
# terminal, so a typo became a credential rotation. The editing step was the
# defect, so it is gone.
#
# The split matters. Only the password is secret; the host, port, user and
# database name are not. So the password goes to the Keychain via security's
# OWN hidden prompt — it is never in this script's memory, never on a command
# line, never in `ps`, never in shell history — and everything else goes to a
# plain config file. Nothing downstream ever builds a URI, so nothing needs
# percent-encoding, which is the other thing that is impossible to get right
# by eye.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-validate.sh"
SERVICE="cc-supabase-db-password"
CONF="$HERE/db.conf"

PSQL=""
for p in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
  [ -x "$p/psql" ] && PSQL="$p/psql" && break
done
[ -z "$PSQL" ] && command -v psql >/dev/null 2>&1 && PSQL="$(command -v psql)"

echo
echo "======================================================================"
echo " Supabase backup credential setup"
echo "======================================================================"
echo
echo " STEP 1 of 2 — the connection string (this one is NOT secret)"
echo
echo "   Open:  https://supabase.com/dashboard/project/onacdpaxcqdfxikxiecy"
echo "   Click: Connect  ->  Session pooler  ->  copy the URI"
echo
echo "   Paste it below EXACTLY as the dashboard gives it to you."
echo "   Do NOT edit it. Leave [YOUR-PASSWORD] in there. It is thrown away."
echo
printf "   Paste URI here: "
IFS= read -r RAW
RAW="$(printf '%s' "$RAW" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

if [ -z "$RAW" ]; then echo; echo "   Nothing pasted. Stopping; nothing was changed."; exit 1; fi

# Pull the non-secret parts out. Any password present is discarded here and
# never reaches a variable that outlives this line.
PARTS="$(RAW="$RAW" python3 - <<'PY'
import os, sys
from urllib.parse import unquote

raw = os.environ["RAW"]

def err(m):
    print("ERR|" + m); sys.exit(0)

# Parsed by hand, NOT with urllib. The whole point of this script is that the
# user pastes the dashboard string untouched, which means the password field is
# still the literal "[YOUR-PASSWORD]" - and a urlsplit() chokes on those square
# brackets, because in a URL they are reserved for IPv6 address literals. So the
# password section is cut out FIRST, before anything tries to interpret it.
if "://" not in raw:
    err("that does not look like a connection string - it has no ://")
scheme, _, rest = raw.partition("://")
scheme = scheme.strip().lower()
if scheme not in ("postgres", "postgresql"):
    err("expected a postgresql:// URI but got '%s://' - if it starts sb_secret_ or eyJ you copied an API key instead" % scheme)
if "@" not in rest:
    err("no '@' in that URI, so there is no host section")

# rpartition: a password may itself contain '@', the host section may not.
userinfo, _, hostpart = rest.rpartition("@")
user = unquote(userinfo.split(":", 1)[0]).strip()      # password deliberately dropped
if not user:
    err("no username found before the ':' in that URI")

hostport, _, pathpart = hostpart.partition("/")
db = (pathpart.split("?", 1)[0] or "postgres").strip() or "postgres"

if hostport.startswith("["):                            # IPv6 literal, e.g. [::1]:5432
    close = hostport.find("]")
    if close == -1: err("malformed IPv6 host in that URI")
    host, after = hostport[1:close], hostport[close+1:]
    port = after[1:] if after.startswith(":") else "5432"
elif ":" in hostport:
    host, _, port = hostport.rpartition(":")
else:
    host, port = hostport, "5432"

host = host.strip()
port = port.strip() or "5432"
if not host:
    err("no host found in that URI")
if not port.isdigit():
    err("the port in that URI is not a number")
port = int(port)

if port == 6543:
    err("that is the TRANSACTION pooler (port 6543), which cannot run pg_dump - go back and pick the SESSION pooler tab")
if host.startswith("db.") and host.endswith(".supabase.co"):
    err("that is the direct connection (IPv6-only, unreachable from most networks) - go back and pick the SESSION pooler tab")

for field, val in (("username", user), ("host", host), ("database", db)):
    if "[" in val or "]" in val:
        err("the %s still contains square brackets - copy the URI again from the dashboard without editing it" % field)

print("OK|%s|%s|%s|%s" % (host, port, user, db))
PY
)"

case "$PARTS" in
  ERR\|*) echo; echo "   PROBLEM: ${PARTS#ERR|}"; echo; echo "   Nothing was changed. Run this again when you have the right string."; exit 1 ;;
esac

IFS='|' read -r _ PGHOST PGPORT PGUSER PGDATABASE <<EOF
$PARTS
EOF

echo
echo "   Read back from what you pasted:"
echo "     host      $PGHOST"
echo "     port      $PGPORT"
echo "     user      $PGUSER"
echo "     database  $PGDATABASE"
echo "   (no password was taken from that string)"

umask 077
cat > "$CONF" <<EOF
# Written by setup-credential.sh. NOT secret - no password here.
# The password lives in the macOS Keychain under the service name:
#   $SERVICE
PGHOST=$PGHOST
PGPORT=$PGPORT
PGUSER=$PGUSER
PGDATABASE=$PGDATABASE
EOF
echo "   saved to  $CONF"

echo
echo " STEP 2 of 2 — the password (this one IS secret)"
echo
echo "   Get it from: Settings -> Database -> Reset database password"
echo
echo "   The next line is macOS's own password prompt, not this script."
echo "   Paste the password and press return."
echo "   NOTHING WILL APPEAR AS YOU PASTE. That is normal. Just press return."
echo
security add-generic-password -a "$USER" -s "$SERVICE" -T /usr/bin/security -U -w
RC=$?
if [ $RC -ne 0 ]; then
  echo; echo "   The password was not saved (security exited $RC). Nothing else changed."; exit 1
fi

PW="$(security find-generic-password -s "$SERVICE" -w 2>/dev/null)"
if [ -z "$PW" ]; then
  echo; echo "   Nothing was stored. Try again and make sure you paste before pressing return."; exit 1
fi

# Catches the pastes that are unmistakably the wrong secret. It never echoes
# the value, only the rule that failed.
if ! reason="$(validate_db_password "$PW")"; then
  echo; echo "   PROBLEM: $reason"
  echo; echo "   Run this again with the right value."; exit 1
fi

echo
echo "======================================================================"
if [ -z "$PSQL" ]; then
  echo " Saved. psql is not installed, so the connection was not tested."
  echo " Install it with:  brew install libpq"
  exit 0
fi

echo " Testing the connection..."
OUT="$(PGPASSWORD="$PW" PGHOST="$PGHOST" PGPORT="$PGPORT" PGUSER="$PGUSER" \
       PGDATABASE="$PGDATABASE" PGCONNECT_TIMEOUT=20 \
       "$PSQL" -Atc "select current_user" 2>&1)"
RC=$?
if [ $RC -eq 0 ]; then
  echo
  echo "   SUCCESS - connected as '$OUT'."
  # The retired item held the hand-spliced URI whose password leaked into a
  # terminal on 2026-08-17. Nothing reads it any more, so leaving it behind
  # would just be a stale copy of a rotated credential.
  if security find-generic-password -s cc-supabase-db-url >/dev/null 2>&1; then
    security delete-generic-password -s cc-supabase-db-url >/dev/null 2>&1 \
      && echo "   Removed the old 'cc-supabase-db-url' keychain item (retired)."
  fi
  echo
  echo "   You are done. Tell Claude it worked."
  exit 0
fi

# Deliberately does NOT print psql's message: that is exactly how the password
# leaked last time.
echo
case "$OUT" in
  *"password authentication failed"*|*"SASL"*|*"authentication"*)
      echo "   The connection was refused: WRONG PASSWORD." ;;
  *"could not translate host name"*|*"Name or service not known"*|*"nodename nor servname"*)
      echo "   The connection failed: the HOST NAME did not resolve." ;;
  *"timeout"*|*"timed out"*)
      echo "   The connection timed out - check your network." ;;
  *)  echo "   The connection failed for another reason." ;;
esac
echo
echo "   The settings are saved, so to retry just the password, run:"
echo "     security add-generic-password -a \"\$USER\" -s $SERVICE -T /usr/bin/security -U -w"
exit 1
