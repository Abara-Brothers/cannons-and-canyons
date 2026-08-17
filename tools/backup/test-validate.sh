#!/usr/bin/env bash
#
# Tests for validate_db_url. Every password below is FAKE.
#
# These exist because the bug they guard against was a shell-pattern bug: an
# earlier ad-hoc check used `case` patterns passed as function arguments, which
# silently matched nothing and reported a malformed URI as clean. Pattern
# matching that has not been run is not pattern matching.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib-validate.sh"

pass=0; fail=0
GOOD="postgresql://postgres.abcdefghijklmnop:FakePassw0rd@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"

# expect_ok <label> <url>
expect_ok() {
  if validate_db_url "$2" >/dev/null; then echo "  ok    $1"; pass=$((pass+1))
  else echo "  FAIL  $1 — rejected, reason: $(validate_db_url "$2")"; fail=$((fail+1)); fi
}
# expect_bad <label> <substring the reason must contain> <url>
expect_bad() {
  local reason
  if reason="$(validate_db_url "$3")"; then
    echo "  FAIL  $1 — ACCEPTED a bad URI"; fail=$((fail+1)); return
  fi
  case "$reason" in
    *"$2"*) echo "  ok    $1"; pass=$((pass+1)) ;;
    *) echo "  FAIL  $1 — wrong reason: $reason"; fail=$((fail+1)) ;;
  esac
}

echo "== accepts a well-formed URI =="
expect_ok  "session pooler, port 5432"          "$GOOD"
expect_ok  "postgres:// short scheme"           "${GOOD/postgresql:/postgres:}"

echo "== rejects the mistakes that actually happened =="
expect_bad "brackets kept (the 2026-08-17 bug)" "brackets"    "postgresql://postgres.abcdefghijklmnop:[ FakePassw0rd]@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
expect_bad "placeholder untouched"              "placeholder" "postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
expect_bad "bare space in password"             "space"       "postgresql://postgres.abcdefghijklmnop:Fake Passw0rd@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
expect_bad "tab in value"                       "tab"         "postgresql://postgres.abcdefghijklmnop:Fake	Passw0rd@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"

echo "== rejects the wrong secret entirely =="
expect_bad "empty"                              "empty"       ""
expect_bad "service key pasted instead"         "API key"     "sb_secret_FAKEFAKEFAKEFAKEFAKEFAKE"
expect_bad "publishable key pasted instead"     "API key"     "sb_publishable_FAKEFAKEFAKEFAKE"
expect_bad "legacy JWT pasted instead"          "API key"     "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.FAKE.FAKE"
expect_bad "just a password"                    "Postgres URI" "FakePassw0rd"

echo "== rejects structurally unusable URIs =="
expect_bad "no host section"                    "no '@'"      "postgresql://postgres"
expect_bad "no password (would prompt)"         "no password" "postgresql://postgres.abcdefghijklmnop@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"

echo "== rejects the two wrong hosts =="
expect_bad "transaction pooler, port 6543"      "TRANSACTION" "postgresql://postgres.abcdefghijklmnop:FakePassw0rd@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres"
expect_bad "direct host, IPv6-only"             "IPv6"        "postgresql://postgres:FakePassw0rd@db.abcdefghijklmnop.supabase.co:5432/postgres"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
