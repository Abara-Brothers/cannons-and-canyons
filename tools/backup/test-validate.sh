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
. "$HERE/lib-alert.sh"
. "$HERE/lib-retry.sh"

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


# ---------------------------------------------------------------------------
# THE ALARM (lib-alert.sh) and THE RETRY SCHEDULE (lib-retry.sh).
#
# These are pinned here for the same reason everything above is: the code that
# only runs when something has already gone wrong is the code nobody ever sees
# run. A backoff that returns an empty string, or an alert whose text does not
# survive a pg_dump error message with quotes in it, fails silently ON THE ONE
# DAY IT MATTERS. No database, no credentials, and nothing here puts a window on
# anybody's screen.

echo
echo "== the retry schedule never runs off the end of its own list =="
is "first wait"                   "$(backoff_for 1 15 60 180)" "15"
is "second wait"                  "$(backoff_for 2 15 60 180)" "60"
is "third wait"                   "$(backoff_for 3 15 60 180)" "180"
is "past the end reuses the last" "$(backoff_for 9 15 60 180)" "180"
is "a one-entry list"             "$(backoff_for 4 7)"         "7"
# The bug this exists for: an empty wait is a hot retry loop against a pooler
# that just dropped the connection, and `sleep ""` under set -e kills the backup
# on the RECOVERY path rather than on the fault.
case "$(backoff_for 3 15 60 180)" in "") echo "  FAIL  a wait is never empty"; fail=$((fail+1));;
  *) echo "  ok    a wait is never empty"; pass=$((pass+1));; esac

echo "== the alert text survives the errors it has to carry =="
# THE REAL MESSAGE from backups/backup.log, 2026-08-30. It contains double
# quotes; unescaped they close the AppleScript literal early and osascript dies
# with a syntax error — the alarm failing on exactly the failure it reports.
dns_err='pg_dump: error: could not translate host name "aws-0-ap-southeast-1.pooler.supabase.com" to address'
has   "a double quote is escaped"      "$(as_quote "$dns_err")"       '\"aws-0'
hasnt "and is not left bare"           "$(as_quote 'say "hi"')"       'say "hi"'
is    "a backslash is escaped first"   "$(as_quote 'a\b')"            'a\\b'
is    "plain text is untouched"        "$(as_quote 'nothing to do')"  'nothing to do'
if command -v osascript >/dev/null 2>&1; then
  # Compile the real literal — assign it to a variable and measure it, so this
  # proves the quoting parses WITHOUT displaying anything.
  if osascript -e "set m to \"$(as_quote "$dns_err")\"" -e "return length of m" >/dev/null 2>&1; then
    echo "  ok    the escaped message compiles as AppleScript"; pass=$((pass+1))
  else
    echo "  FAIL  the escaped message does NOT compile as AppleScript"; fail=$((fail+1))
  fi
else
  echo "  ok    (no osascript here — AppleScript compile check is macOS-only)"; pass=$((pass+1))
fi

echo "== how old a backup is, against a pinned clock =="
# 2026-08-23 is the newest backup that was ever COMPLETE; 2026-09-21T10:54:28Z
# is when this was written. 29 days is the real gap that went unnoticed.
is "the real 29-day gap"           "$(stamp_age_days 20260823T001117Z 1789968868)" "29"
is "a backup from today"           "$(stamp_age_days 20260921T000000Z 1789968868)" "0"
is "a clock skewed backwards"      "$(stamp_age_days 20270101T000000Z 1789968868)" "0"
# `backups/offsite` is a real directory next to the stamps. An age must never be
# invented for something that is not a backup.
is "a non-stamp yields no age"     "$(stamp_age_days offsite 1789968868 || true)" ""
is "a near-miss yields no age"     "$(stamp_age_days 20260823T001117 1789968868 || true)" ""

echo "== what the owner is actually shown =="
has "names the failure count"   "$(alert_failure_text 3 20260823T001117Z 29 "$dns_err")" "Consecutive failures: 3"
has "names the newest good one" "$(alert_failure_text 3 20260823T001117Z 29 "$dns_err")" "20260823T001117Z (29 days old)"
has "carries the real reason"   "$(alert_failure_text 3 20260823T001117Z 29 "$dns_err")" "could not translate host name"
has "promises to repeat"        "$(alert_failure_text 3 20260823T001117Z 29 "$dns_err")" "repeats every run"
# "no backup at all" and "a backup from a while ago" are different emergencies
# and must never render the same way.
has "no backup says so plainly" "$(alert_failure_text 1 "" "" "$dns_err")" "NONE"
has "one day is singular"       "$(alert_failure_text 1 20260920T000000Z 1 x)" "(1 day old)"
has "a missing reason is named" "$(alert_failure_text 1 "" "" "")" "unrecorded"
has "recovery names the gap"    "$(alert_recovery_text 3 20260921T000000Z 29)" "29 days"
has "recovery counts failures"  "$(alert_recovery_text 3 20260921T000000Z 29)" "failed 3 times in a row"
has "one failure is singular"   "$(alert_recovery_text 1 20260921T000000Z 2)" "failed 1 time in a row"

# The Notification Center layer: one line, no newlines, and it must still carry
# the two facts that matter after the alert window is gone.
echo "== the one-line notification body =="
has "short form counts failures"  "$(alert_failure_short 3 20260823T001117Z 29)" "Failed 3 times in a row"
has "short form names the fallback" "$(alert_failure_short 3 20260823T001117Z 29)" "20260823T001117Z (29 days old)"
has "short form says NONE plainly" "$(alert_failure_short 1 "" "")" "NONE"
is  "short form is a single line"  "$(alert_failure_short 3 20260823T001117Z 29 | wc -l | tr -d ' ')" "0"
has "short recovery form"          "$(alert_recovery_short 2)" "after 2 failures"
has "one failure is singular"      "$(alert_recovery_short 1)" "after 1 failure"

echo "== the marker round-trips through the reader backup-auto.sh uses =="
# The contract that keeps the alarm sticky: alert_marker_body writes it, and
# backup-auto.sh's markerget() reads it back with this exact grep+cut. If those
# two drift, the count resets every week and "3 consecutive failures" silently
# becomes "1" forever.
_m="$(mktemp -t ccmarker)"
alert_marker_body 3 "2026-08-30T23:59:45Z" "2026-09-20T00:15:52Z" "$dns_err" >"$_m"
mg() { grep -E "^$1=" "$_m" 2>/dev/null | head -1 | cut -d= -f2-; }
is "the count reads back"       "$(mg CONSECUTIVE_FAILURES)" "3"
is "the first failure reads back" "$(mg FIRST_FAILED_AT)"    "2026-08-30T23:59:45Z"
is "the last failure reads back"  "$(mg LAST_FAILED_AT)"     "2026-09-20T00:15:52Z"
# cut -d= -f2- , not -f2: the reason contains no '=' today, but a pg_dump error
# easily could, and a truncated reason is a misleading one.
is "a reason with an = survives" \
   "$(alert_marker_body 1 a b 'search_path=; failed' >"$_m"; mg LAST_REASON)" "search_path=; failed"
has "it says what clears it"    "$(cat "$_m")" "deleted ONLY by a run that produces a complete backup"
rm -f "$_m"

echo "== the alert sink stands in for the screen =="
_s="$(mktemp -t ccsink)"
( CC_ALERT_SINK="$_s"; alert_owner "T" "$dns_err" )
has "the sink captured the title"  "$(cat "$_s")" "T"
has "the sink captured the body"   "$(cat "$_s")" "could not translate host name"
rm -f "$_s"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
