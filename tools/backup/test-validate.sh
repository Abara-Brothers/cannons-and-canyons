#!/usr/bin/env bash
#
# Tests for validate_db_password. Every value below is FAKE.
#
# These exist because the check they replace was itself a shell-pattern bug:
# `case` patterns passed as function arguments matched nothing and reported a
# malformed value as clean. Pattern matching that has not been run is not
# pattern matching.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib-validate.sh"

pass=0; fail=0
ok(){ if validate_db_password "$2" >/dev/null; then echo "  ok    $1"; pass=$((pass+1));
      else echo "  FAIL  $1 — rejected: $(validate_db_password "$2")"; fail=$((fail+1)); fi; }
bad(){ local r; if r="$(validate_db_password "$3")"; then echo "  FAIL  $1 — ACCEPTED"; fail=$((fail+1)); return; fi
       case "$r" in *"$2"*) echo "  ok    $1"; pass=$((pass+1));; *) echo "  FAIL  $1 — wrong reason: $r"; fail=$((fail+1));; esac; }

echo "== accepts real passwords, including awkward ones =="
ok  "ordinary generated password"      'Ilxxxx2MGCg2x50yp'
ok  "contains punctuation"             'p@ss!w#rd$%^&*()'
ok  "contains an interior space"       'correct horse battery staple'
ok  "contains brackets legitimately"   'ab[cd]ef'
ok  "very long"                        "$(printf 'a%.0s' $(seq 1 200))"

echo "== rejects the wrong secret =="
bad "empty"                  "empty"             ""
bad "whole URI pasted"       "connection string" 'postgresql://postgres.abc:Fake@aws-1.pooler.supabase.com:5432/postgres'
bad "service key"            "API key"           'sb_secret_FAKEFAKEFAKE'
bad "publishable key"        "API key"           'sb_publishable_FAKEFAKE'
bad "legacy JWT"             "API key"           'eyJhbGciOiJIUzI1NiJ9.FAKE.FAKE'
bad "placeholder text"       "placeholder"       '[YOUR-PASSWORD]'

echo "== rejects invisible paste artefacts =="
bad "leading space"          "paste artefact"    ' FakePassw0rd'
bad "trailing space"         "paste artefact"    'FakePassw0rd '

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
