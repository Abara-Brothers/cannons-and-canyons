#!/usr/bin/env bash
#
# Tests for validate_db_password and for the live_rows query builder. Every
# credential value below is FAKE and nothing here touches a database.
#
# These exist because the check they replace was itself a shell-pattern bug:
# `case` patterns passed as function arguments matched nothing and reported a
# malformed value as clean. Pattern matching that has not been run is not
# pattern matching.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-validate.sh"
. "$HERE/lib-counts.sh"

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

is(){ if [ "$2" = "$3" ]; then echo "  ok    $1"; pass=$((pass+1));
      else echo "  FAIL  $1 — got [$2] want [$3]"; fail=$((fail+1)); fi; }
has(){ case "$2" in *"$3"*) echo "  ok    $1"; pass=$((pass+1));;
       *) echo "  FAIL  $1 — [$3] is missing"; fail=$((fail+1));; esac; }
hasnt(){ case "$2" in *"$3"*) echo "  FAIL  $1 — [$3] is there"; fail=$((fail+1));;
         *) echo "  ok    $1"; pass=$((pass+1));; esac; }

# WHY THESE EXIST: the phase 6 commit put all seven counts in one SELECT, so the
# four tables that do not exist until the owner applies the migration by hand
# took the three that have always worked down with them. The manifest then read
# `live_rows  : unavailable`, and backup-auto.sh refused to bless a perfectly
# good dump with "no accounts". Nothing in the suite ran backup.sh, so nothing
# saw it. These run the builder itself, with no database, in both windows.
echo
echo "== the live_rows query names only tables that exist =="
q_none="$(counts_sql)"
has   "before the migration: still counts auth.users"   "$q_none" "from auth.users"
has   "before the migration: still counts profiles"     "$q_none" "from public.profiles"
has   "before the migration: still counts push_subs"    "$q_none" "from public.push_subscriptions"
for t in friendships friend_requests blocks name_reports; do
  hasnt "before the migration: never names $t"          "$q_none" "public.$t"
done
q_all="$(counts_sql friendships friend_requests blocks name_reports)"
for t in friendships friend_requests blocks name_reports; do
  has   "after the migration: counts $t"                "$q_all"  "from public.$t"
  has   "after the migration: labels it $t="            "$q_all"  "' $t='"
done
q_some="$(counts_sql blocks name_reports)"
has   "half a schema: counts the table that is there"   "$q_some" "from public.blocks"
hasnt "half a schema: omits the one that is not"        "$q_some" "public.friendships"

echo "== which tables are named as absent =="
is "none present names all four"  "$(counts_absent)" "friendships friend_requests blocks name_reports"
is "all present names none"       "$(counts_absent friendships friend_requests blocks name_reports)" ""
is "two present names the other two" "$(counts_absent friendships blocks)" "friend_requests name_reports"

# The contract between backup.sh's manifest line and the two scripts that read
# it: backup-auto.sh:106 and offsite.sh:181 both pull auth.users out with this
# exact sed, and refuse the backup when it yields nothing. The refusal must stay
# armed for an empty database and must not fire for an un-migrated one.
echo "== what backup-auto.sh and offsite.sh read out of that line =="
users_of(){ printf '%s' "$1" | sed -n 's/.*auth\.users=\([0-9][0-9]*\).*/\1/p'; }
is "an un-migrated line still yields the account count" \
   "$(users_of 'auth.users=17 profiles=15 push_subs=0')" "17"
is "a migrated line still yields it" \
   "$(users_of 'auth.users=17 profiles=15 push_subs=0 friendships=2 friend_requests=0 blocks=1 name_reports=0')" "17"
is "'unavailable' still yields nothing, so the guard still refuses" \
   "$(users_of 'unavailable')" ""
is "an empty database still yields 0, so the guard still refuses" \
   "$(users_of 'auth.users=0 profiles=0 push_subs=0')" "0"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
