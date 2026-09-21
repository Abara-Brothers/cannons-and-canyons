#!/usr/bin/env bash
#
# lib-alert.sh — make a failed backup impossible to miss.
#
# WHY THIS EXISTS: for a month this job failed in near silence. 2026-08-30,
# 09-06 and 09-20 failed outright and 09-13 produced a zero-byte roles.sql while
# logging "done (8 kept)" — and the only trace of any of it was a line in
# backups/backup.log, which nobody reads, because the entire point of a
# scheduled job is that you stop thinking about it. The failure was discovered
# on 2026-09-21 by hand. By then the newest dump holding the game's own data was
# eight days old and the newest holding roles was twenty-nine.
#
# A signal nobody sees is not a signal. There is no mail relay, no webhook and
# no notifier binary on this machine, and the data being protected is every
# player account — so shipping it to a third-party alerting service is not a
# free choice. What IS available is the Mac itself, and the job is a LaunchAgent
# in gui/$(id -u), so it can put something on the screen. Three layers, because
# each one covers where the previous one fails:
#
#   1. A CRITICAL ALERT WINDOW. Loudest thing available; unmissable if the owner
#      is at the machine. It auto-dismisses after ten minutes so an unattended
#      run can never wedge on a dialog nobody is there to click.
#   2. A NOTIFICATION CENTER ENTRY. Outlives the window, so a failure that
#      happened while the owner was away is still sitting there afterwards.
#   3. A STICKY MARKER FILE, which is the layer that actually matters. Both of
#      the above can be missed exactly once and then be gone forever. The marker
#      cannot: while it exists, EVERY later run alerts again — including a run
#      that SUCCEEDS, which reports how long the gap was before clearing it. A
#      Sunday alert nobody saw is therefore re-raised the next Sunday, and the
#      one after that, until a genuinely complete backup lands.
#
# Only a complete backup clears the marker. Nothing else does, and nothing in
# here ever deletes it on a guess.
#
# The message builders are PURE — no I/O, no osascript — so tools/backup/
# test-validate.sh proves what the owner will actually be shown, including the
# quoting, without putting a window on anyone's screen.

# The marker. Named so that `ls backups/` says what is wrong without opening it.
CC_ALERT_MARKER_NAME="BACKUP-IS-FAILING.txt"

# ---------------------------------------------------------------- pure helpers

# as_quote <text>
#   Escape a string for an AppleScript double-quoted literal. NOT cosmetic: the
#   reason string is pg_dump's own stderr, which routinely contains double
#   quotes — `could not translate host name "aws-0-..." to address` is the exact
#   text of two of the four failures this file was written for. Unescaped, that
#   ends the literal early and osascript dies with a syntax error, which would
#   mean the alarm silently fails on precisely the failure it exists to report.
#   Backslash first, or it re-escapes the escapes.
as_quote() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# alert_plural <n> <singular> <plural>
alert_plural() { if [ "$1" = "1" ]; then printf '%s' "$2"; else printf '%s' "$3"; fi; }

# alert_last_good_text <stamp-or-empty> <age-in-days-or-empty>
#   How the alarm describes the newest COMPLETE backup. "none" is a different
#   and much worse fact than "one from eight days ago", so it is never blurred
#   into a missing value.
alert_last_good_text() {
  local stamp="${1:-}" days="${2:-}"
  if [ -z "$stamp" ]; then
    printf '%s' "NONE — there is no complete backup on this machine at all"
  elif [ -z "$days" ]; then
    printf '%s' "$stamp"
  else
    printf '%s (%s %s old)' "$stamp" "$days" "$(alert_plural "$days" day days)"
  fi
}

# stamp_age_days <YYYYmmddTHHMMSSZ> [now-epoch]
#   Whole days between a backup's stamp and now. Takes `now` as an argument so
#   the suite can pin it — an age function tested against the real clock proves
#   nothing tomorrow. Prints nothing and fails if the stamp is not a stamp, so a
#   stray directory name can never be reported to the owner as an age.
#   BOTH date dialects, because the suite this is pinned by runs on ubuntu in CI
#   while the job itself only ever runs on this Mac. BSD `date -j -f` and GNU
#   `date -d` share no syntax at all, and a helper that silently returns nothing
#   on the runner is a helper CI cannot actually prove anything about.
stamp_age_days() {
  local stamp="$1" now="${2:-}" then
  case "$stamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  then="$(date -j -u -f '%Y%m%dT%H%M%SZ' "$stamp" '+%s' 2>/dev/null)" \
    || then="$(date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2}T${stamp:9:2}:${stamp:11:2}:${stamp:13:2}Z" '+%s' 2>/dev/null)" \
    || return 1
  [ -n "$then" ] || return 1
  [ -n "$now" ] || now="$(date -u +%s)"
  [ "$now" -ge "$then" ] || { printf '0'; return 0; }
  printf '%s' "$(( (now - then) / 86400 ))"
}

# alert_failure_text <consecutive> <last-good-stamp> <last-good-days> <reason>
alert_failure_text() {
  local n="$1" stamp="${2:-}" days="${3:-}" reason="${4:-}"
  printf 'The weekly database backup FAILED.\n\n'
  printf 'Consecutive failures: %s\n' "$n"
  printf 'Newest complete backup: %s\n' "$(alert_last_good_text "$stamp" "$days")"
  printf 'Why it failed: %s\n\n' "${reason:-unrecorded}"
  printf 'Supabase free plan has no automatic backups and no point-in-time\n'
  printf 'recovery. Nothing else is protecting player accounts right now.\n\n'
  printf 'Run it by hand:  bash tools/backup/backup-auto.sh\n'
  printf 'Full log:        backups/backup.log\n'
  printf 'This alarm repeats every run until a complete backup succeeds.'
}

# alert_recovery_text <failures-it-had> <stamp> <gap-days>
#   The message a SUCCESSFUL run shows when it is clearing the marker. Without
#   this, a silent recovery would hide the gap — and the gap is the thing worth
#   knowing, because it is how long the data was unprotected.
alert_recovery_text() {
  local n="$1" stamp="$2" gap="${3:-}"
  printf 'The weekly database backup is working again.\n\n'
  printf 'It had failed %s %s in a row.\n' "$n" "$(alert_plural "$n" time times)"
  if [ -n "$gap" ]; then
    printf 'Gap without a complete backup: %s %s.\n' "$gap" "$(alert_plural "$gap" day days)"
  fi
  printf 'New backup: %s\n\n' "$stamp"
  printf 'The alarm is now cleared.'
}

# alert_failure_short / alert_recovery_short
#   ONE LINE, for the Notification Center entry. That entry is the layer that
#   outlives the alert window, and a notification collapses newlines into a
#   truncated smear — so the full text, which is right for a dialog, is the wrong
#   thing to hand it. This says the two facts worth keeping: how many in a row,
#   and what you would be falling back on.
alert_failure_short() {
  local n="$1" stamp="${2:-}" days="${3:-}"
  printf 'Failed %s %s in a row. Newest complete backup: %s' \
    "$n" "$(alert_plural "$n" time times)" "$(alert_last_good_text "$stamp" "$days")"
}
alert_recovery_short() {
  printf 'Working again after %s %s. The alarm is cleared.' "$1" "$(alert_plural "$1" failure failures)"
}

# alert_marker_body <consecutive> <first> <last> <reason>
#   The marker file's contents. Key=value so backup-auto.sh can read it back as
#   DATA with grep — never sourced. A state file that gets executed is a state
#   file that can run anything, which is the same rule db.conf follows.
alert_marker_body() {
  cat <<EOF
THE WEEKLY DATABASE BACKUP IS FAILING.

This file is the alarm. It is created by tools/backup/backup-auto.sh when a
backup fails, and it is deleted ONLY by a run that produces a complete backup
(roles.sql, auth.sql and public.sql, all non-empty, with a manifest that counts
real accounts). Do not delete it by hand to make the warning go away — that
removes the warning, not the problem.

While it exists, every run raises the alarm again, including a successful one.

CONSECUTIVE_FAILURES=$1
FIRST_FAILED_AT=$2
LAST_FAILED_AT=$3
LAST_REASON=$4
EOF
}

# ---------------------------------------------------------------- delivery

# alert_owner <title> <message>
#   Best effort by definition, and deliberately unable to fail the caller: the
#   backup's exit status must report the BACKUP, never the alarm. A machine with
#   the screen locked, no Aqua session, or osascript unavailable still exits
#   non-zero with the marker on disk and the reason in the log.
#
#   CC_ALERT_SINK redirects delivery to a file instead of the screen, so the
#   suite and the fail-on-purpose drill can assert what would have been shown
#   without putting a window in front of anybody. Never set it in normal use.
#   The third argument is the ONE-LINE form for the notification; without it the
#   notification gets the full text, which it will truncate.
alert_owner() {
  local title="$1" message="$2" short="${3:-$2}"
  if [ -n "${CC_ALERT_SINK:-}" ]; then
    { printf '=== ALERT ===\n%s\n%s\n---\n%s\n' "$title" "$short" "$message"; } >>"$CC_ALERT_SINK" 2>/dev/null || true
    return 0
  fi
  # An `if`, not `[ ... ] && return 0`: as a bare statement that is false when the
  # variable is unset, which would abort a caller running under `set -e`.
  if [ "${CC_ALERT_QUIET:-0}" = "1" ]; then return 0; fi
  command -v osascript >/dev/null 2>&1 || return 0

  local t m sh
  t="$(as_quote "$title")"; m="$(as_quote "$message")"; sh="$(as_quote "$short")"

  # Notification Center FIRST, so the entry that outlives the window is already
  # posted before anything blocks on a click.
  osascript -e "display notification \"$sh\" with title \"$t\"" >/dev/null 2>&1 || true
  # `giving up after` is what keeps an unattended job from hanging forever on a
  # dialog nobody is there to dismiss.
  osascript -e "display alert \"$t\" message \"$m\" as critical buttons {\"OK\"} default button \"OK\" giving up after 600" >/dev/null 2>&1 || true
  return 0
}
