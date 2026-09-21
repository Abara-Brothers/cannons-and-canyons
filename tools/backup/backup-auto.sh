#!/usr/bin/env bash
#
# Unattended wrapper around backup.sh, for a schedule.
#
# WHY THIS EXISTS: this project is on the Supabase FREE plan, which has NO
# automatic backups and NO point-in-time recovery. `backup.sh` was documented as
# "the only thing standing between a mistake and permanent loss of every
# account" — and on 2026-08-15 it turned out it had never been run, there was no
# backups/ directory, and the Supabase CLI was not even installed. A backup
# procedure nobody runs is not a backup procedure.
#
# ---------------------------------------------------------------------------
# SETUP IS ONE COMMAND. Do not hand-edit connection strings:
#
#     bash tools/backup/setup-credential.sh
#
# It asks for the dashboard's connection URI (paste it UNEDITED — the password
# field is discarded) and then for the password, via macOS's own hidden prompt.
# Everything non-secret lands in db.conf; the password lands in the Keychain.
#
# Then prove it works, and only then schedule it:
#     bash tools/backup/backup-auto.sh
#     bash tools/backup/install-schedule.sh
# ---------------------------------------------------------------------------
#
# THE SECRET NEVER TOUCHES A FILE, A COMMAND LINE, OR SHELL HISTORY. It is read
# from the Keychain at run time and handed to pg_dump through PGPASSWORD.
# Arguments are world-readable via `ps`; a subprocess environment is not.
set -uo pipefail

KEYCHAIN_SERVICE="cc-supabase-db-password"
LEGACY_SERVICE="cc-supabase-db-url"       # pre-2026-08-17 hand-spliced URI
KEEP=8                                    # ~2 months of weekly runs
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# Overridable ONLY so the fail-on-purpose drill can point this at an unreachable
# host without touching the real db.conf. Never set it in normal use. (The
# password is NOT in here and never has been — it comes from the Keychain below —
# so a drill conf carries nothing secret.)
CONF="${CC_BACKUP_CONF:-$HERE/db.conf}"
OUT_ROOT="${CC_BACKUP_DIR:-$ROOT/backups}"
LOG="$OUT_ROOT/backup.log"

mkdir -p "$OUT_ROOT"
say() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" | tee -a "$LOG"; }

. "$HERE/lib-alert.sh"
MARKER="$OUT_ROOT/$CC_ALERT_MARKER_NAME"

# Read the marker as DATA, never sourced — the same rule db.conf follows, for
# the same reason: a state file that gets executed is a state file that can run
# anything.
markerget() { grep -E "^$1=" "$MARKER" 2>/dev/null | head -1 | cut -d= -f2-; }

# The newest backup that is actually COMPLETE: all three dumps non-empty and a
# manifest describing them. This is what the alarm reports as your fallback, and
# it is deliberately stricter than "newest directory" — backups/20260913T001115Z
# has a timestamp name, a manifest and a ZERO-BYTE roles.sql, and telling the
# owner mid-incident that it is their newest backup would be a lie of exactly
# the kind this whole change exists to stop.
newest_complete() {
  local d
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    d="${d%/}"
    if [ -s "$d/roles.sql" ] && [ -s "$d/auth.sql" ] && [ -s "$d/public.sql" ] && [ -s "$d/MANIFEST.txt" ]; then
      basename "$d"; return 0
    fi
  done < <(ls -1dt -- "$OUT_ROOT"/*/ 2>/dev/null | grep -E '/[0-9]{8}T[0-9]{6}Z/$')
  return 1
}
# Captured BEFORE this run can add to it, so the failure alarm names the copy you
# would actually fall back to, and a recovery can say how long the gap really was.
PRE_RUN_LAST_GOOD="$(newest_complete || true)"
PRE_RUN_LAST_GOOD_DAYS=""
if [ -n "$PRE_RUN_LAST_GOOD" ]; then
  PRE_RUN_LAST_GOOD_DAYS="$(stamp_age_days "$PRE_RUN_LAST_GOOD" || true)"
fi

# alarm <reason> — write the sticky marker and put the failure on the screen.
# See lib-alert.sh for why a log line was never going to be enough.
alarm() {
  local reason="$1" now n first
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  n="$(markerget CONSECUTIVE_FAILURES)"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1))
  first="$(markerget FIRST_FAILED_AT)"
  [ -n "$first" ] || first="$now"
  alert_marker_body "$n" "$first" "$now" "$reason" >"$MARKER" 2>/dev/null || true
  say "ALARM: failure #$n — marker written to $MARKER; it clears only when a complete backup succeeds"
  alert_owner "Cannons & Canyons backup FAILED" \
    "$(alert_failure_text  "$n" "$PRE_RUN_LAST_GOOD" "$PRE_RUN_LAST_GOOD_DAYS" "$reason")" \
    "$(alert_failure_short "$n" "$PRE_RUN_LAST_GOOD" "$PRE_RUN_LAST_GOOD_DAYS")"
}
# Every exit path that is not a complete backup goes through one of these two.
die_loud() { say "FAILED: $1"; alarm "$1"; exit 1; }

say "starting"

# Homebrew is not on a launchd job's PATH, and libpq is keg-only on top of that.
for p in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin /opt/homebrew/bin /usr/local/bin; do
  [ -d "$p" ] && PATH="$p:$PATH"
done
export PATH
if ! command -v pg_dump >/dev/null 2>&1; then
  die_loud "pg_dump not found. Install it:  brew install libpq"
fi

if [ ! -f "$CONF" ]; then
  die_loud "$CONF is missing — run:  bash tools/backup/setup-credential.sh"
fi

# Read as data, not sourced: a config file that gets executed is a config file
# that can run anything.
getconf() { grep -E "^$1=" "$CONF" 2>/dev/null | head -1 | cut -d= -f2-; }
PGHOST="$(getconf PGHOST)"
PGPORT="$(getconf PGPORT)"
PGUSER="$(getconf PGUSER)"
PGDATABASE="$(getconf PGDATABASE)"
if [ -z "$PGHOST" ] || [ -z "$PGUSER" ]; then
  die_loud "$CONF has no PGHOST/PGUSER — re-run setup-credential.sh"
fi

PGPASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
if [ -z "$PGPASSWORD" ]; then
  if security find-generic-password -s "$LEGACY_SERVICE" >/dev/null 2>&1; then
    die_loud "the Keychain still holds the retired '$LEGACY_SERVICE' item (a hand-spliced URI). Run:  bash tools/backup/setup-credential.sh"
  else
    die_loud "no password in the Keychain — run:  bash tools/backup/setup-credential.sh"
  fi
fi

. "$HERE/lib-validate.sh"
if ! reason="$(validate_db_password "$PGPASSWORD")"; then
  say "        Re-run:  bash tools/backup/setup-credential.sh"
  die_loud "the stored password is not usable — $reason"
fi

# backup.sh does the real work: roles + auth + public, in restore order. The
# auth schema is not optional — a public-only dump cannot be restored, which the
# 2026-08-14 drill proved by having the insert rejected on a foreign key.
# Where the log ends BEFORE this run's dump, so the alarm can quote the reason
# this run failed instead of an error from some previous week.
log_mark="$(wc -c <"$LOG" 2>/dev/null | tr -d ' ')"
case "$log_mark" in ''|*[!0-9]*) log_mark=0 ;; esac
# The CAUSE, not the epitaph, and in the owner's words rather than "returned
# non-zero". Only lines THIS run wrote are considered, so an alarm never quotes
# an error from some previous week.
#
# Order matters: "attempt 2 of 2 failed — no attempts left" is the last line
# printed and tells you nothing. The line worth showing is the error that
# actually ended the dump, which came several lines earlier.
why_failed() {
  local recent w
  recent="$(tail -c "+$((log_mark + 1))" "$LOG" 2>/dev/null)"
  w="$(printf '%s\n' "$recent" | grep -E 'pg_dump(all)?: error' | tail -1)"
  [ -n "$w" ] || w="$(printf '%s\n' "$recent" | grep -E 'is missing or EMPTY|did not answer' | tail -1)"
  [ -n "$w" ] || w="$(printf '%s\n' "$recent" | grep -E 'no attempts left' | tail -1)"
  # The log indents these under the attempt that produced them; the alarm does not.
  w="$(printf '%s' "$w" | sed 's/^[[:space:]]*//')"
  printf '%s' "${w:-backup.sh returned non-zero — see backups/backup.log}"
}

if PGHOST="$PGHOST" PGPORT="${PGPORT:-5432}" PGUSER="$PGUSER" \
   PGDATABASE="${PGDATABASE:-postgres}" PGPASSWORD="$PGPASSWORD" \
   bash "$HERE/backup.sh" "$OUT_ROOT" >>"$LOG" 2>&1; then
  # THE DIRECTORY THIS RUN MADE, as named by the run that made it — not
  # "whichever directory in backups/ was touched most recently", which is what
  # this used to be. That guess was wrong in two ways at once: `*/` also matches
  # backups/offsite/ (encrypted archives, no auth.sql in them), and any directory
  # with a newer mtime than the fresh dump wins regardless of what it is. Either
  # way the checks below were applied to the wrong path. backup.sh prints
  # BACKUP_DIR= on success; if it is not there, nothing is assumed and the run
  # fails closed.
  latest="$(tail -c "+$((log_mark + 1))" "$LOG" 2>/dev/null | sed -n 's/^BACKUP_DIR=//p' | tail -1)"
  [ -n "$latest" ] && latest="${latest%/}/"    # the "${latest}auth.sql" idiom below wants it
  # Establish WHICH directory is being judged before judging anything about it.
  # With this after the row-count check, a missing BACKUP_DIR line made `rows`
  # empty and the run died claiming the manifest reported no accounts — a
  # confident, specific, wrong diagnosis of a completely different fault.
  if [ -z "$latest" ]; then
    die_loud "backup.sh reported success but never named a backup directory — not trusting it."
  fi

  # ALL FOUR FILES, EACH NON-EMPTY — roles.sql included, which it was not.
  # backups/20260913T001115Z passed this gate with a zero-byte roles.sql beside a
  # roles.FAILED.txt and was logged as "done (8 kept)". backup.sh now refuses to
  # promote such a directory at all, so this is the second lock on the same door
  # rather than the only one; it stays because this is the line that decides
  # whether the word OK is written, and that decision should not depend on
  # another script having done its job.
  missing=""
  for f in roles.sql auth.sql public.sql MANIFEST.txt; do
    [ -s "${latest}${f}" ] || missing="$missing $f"
  done
  if [ -n "$missing" ]; then
    die_loud "$(basename "$latest") is incomplete — missing or empty:$missing. Do not trust it."
  fi
  # A "successful" dump of nothing is the failure mode worth catching: if auth.sql
  # is empty the backup is useless and everything downstream would look fine.
  # ROWS, NOT BYTES. `[ -s ]` only asks whether the file is non-empty, and
  # pg_dump emits ~800 bytes of SET/header for a schema with no data at all —
  # measured 2026-08-22: a zero-row dump produced auth.sql 805 bytes and
  # public.sql 815 bytes, and this guard blessed it. The comment above has always
  # said "a 'successful' dump of nothing is the failure mode worth catching"; it
  # did not catch it. With a weekly job and KEEP=8, eight weeks of a misconfigured
  # db.conf would evict every good local copy while logging OK each time.
  rows="$(grep '^live_rows' "${latest}MANIFEST.txt" 2>/dev/null | cut -d: -f2-)"
  users="$(printf '%s' "$rows" | sed -n 's/.*auth\.users=\([0-9][0-9]*\).*/\1/p')"
  if [ -z "$users" ] || [ "$users" -eq 0 ]; then
    if [ "${CC_ALLOW_EMPTY_BACKUP:-0}" = "1" ]; then
      say "note: manifest reports '${rows:-no live_rows line}' — blessed anyway, because CC_ALLOW_EMPTY_BACKUP=1 was set deliberately."
    else
      say "        If the database really is empty, set CC_ALLOW_EMPTY_BACKUP=1 deliberately."
      die_loud "manifest reports '${rows:-no live_rows line}' — refusing to bless a backup with no accounts."
    fi
  fi
  say "OK: $(basename "$latest") — $(du -sh "$latest" | cut -f1) — $(grep '^live_rows' "${latest}MANIFEST.txt" 2>/dev/null | cut -d: -f2-)"

  # THE ONLY THING THAT CLEARS THE ALARM is the line above having been reached.
  # And a recovery is announced, not silent: the gap is the fact worth knowing,
  # because it is how long every player account was unprotected. A run that
  # quietly went back to normal is how a month went by unnoticed.
  had="$(markerget CONSECUTIVE_FAILURES)"
  if [ -n "$had" ]; then
    rm -f "$MARKER"
    say "alarm cleared — the previous $had run(s) had failed"
    alert_owner "Cannons & Canyons backup recovered" \
      "$(alert_recovery_text  "$had" "$(basename "$latest")" "$PRE_RUN_LAST_GOOD_DAYS")" \
      "$(alert_recovery_short "$had")"
  fi
else
  die_loud "$(why_failed)"
fi

# Prune, newest kept. Local rotation only — see the off-site note below.
#
# `for d in $(ls ...)` word-splits on WHITESPACE, and this project's path is
# ".../Projects/Pocket Tanks Online/backups". Every directory therefore became
# three iterations — [.../Pocket] [Tanks] [Online/backups/<stamp>/] — so the log
# proudly reported `pruned Pocket` and `pruned Tanks` while pruning NOTHING (rm -rf
# on a nonexistent path exits 0, so the `&& say` chain ran anyway and the count was
# a fiction). Two failures in one line: retention never worked, and `rm -rf` was
# firing at RELATIVE paths — under launchd the working directory is the project
# root, so a directory literally named `Tanks` or `Online` there would have been
# destroyed. Nothing was lost only because no such directory exists.
#
# Read a line at a time, quote everything, and match the stamp shape so `offsite/`
# (encrypted archives, not dumps) is never counted or deleted as a backup.
n=0
while IFS= read -r d; do
  [ -n "$d" ] || continue
  # RETENTION COUNTS COMPLETE BACKUPS, NOT DIRECTORIES. Measured on this machine
  # 2026-09-21: nine stamped directories, four of them wreckage, so KEEP=8 was
  # holding FOUR real backups and evicting a good one every week to make room for
  # rubbish. Within a month that is every restorable copy gone, with the log still
  # saying "8 kept". A directory that is not a backup does not get to take a
  # backup's slot.
  #
  # It is not deleted either, and that is deliberate: 20260913T001115Z is
  # incomplete AND holds every row of the game's own data. "Incomplete" and
  # "worthless" are not the same thing, and a weekly script must not be what
  # decides they are. They are named in the summary below; what happens to them
  # is the owner's call.
  if [ ! -s "${d}roles.sql" ] || [ ! -s "${d}auth.sql" ] || [ ! -s "${d}public.sql" ] || [ ! -s "${d}MANIFEST.txt" ]; then
    continue
  fi
  n=$((n + 1))
  if [ "$n" -gt "$KEEP" ]; then
    # STRIP THE TRAILING SLASH, and never follow a symlink. `ls -1dt */` emits
    # "path/", and `rm -rf link/` resolves the link and deletes its TARGET, while
    # `rm -rf link` would remove only the link. The `--` and the quoting were both
    # already correct; the slash defeated them. RESTORE.md pushes operators toward
    # keeping copies off the machine, so a symlink under backups/ is a plausible
    # thing for someone to create — and the dangling link would survive to repeat
    # the deletion every week.
    d="${d%/}"
    if [ -L "$d" ]; then
      say "skipped $(basename "$d") — it is a symlink; refusing to delete through it"
    else
      rm -rf -- "$d" && say "pruned $(basename "$d")"
    fi
  fi
done < <(ls -1dt -- "$OUT_ROOT"/*/ 2>/dev/null | grep -E '/[0-9]{8}T[0-9]{6}Z/$')

# AN HONEST COUNT. `done (8 kept)` counted DIRECTORIES, and on 2026-09-13 four of
# the eight it counted were wreckage: 20260830 (an empty roles.sql and a failure
# note), 20260906 and 20260920 (no public.sql at all), 20260913 (a zero-byte
# roles.sql). Reporting those as kept backups is the same overstatement as
# "done (8 kept)" over a broken run — the same lie, one line further down.
#
# Note what this does NOT do: it does not delete them. 20260913 is incomplete AND
# holds every row of the game's own data, so "incomplete" does not mean
# "worthless", and a script must not be the thing that decides it does. They are
# named and the retention cost is spelled out; removing them stays a human's call.
kept=0; broken=""
while IFS= read -r d; do
  [ -n "$d" ] || continue
  d="${d%/}"
  if [ -s "$d/roles.sql" ] && [ -s "$d/auth.sql" ] && [ -s "$d/public.sql" ] && [ -s "$d/MANIFEST.txt" ]; then
    kept=$((kept + 1))
  else
    broken="$broken $(basename "$d")"
  fi
done < <(ls -1dt -- "$OUT_ROOT"/*/ 2>/dev/null | grep -E '/[0-9]{8}T[0-9]{6}Z/$')
if [ -n "$broken" ]; then
  say "done ($kept complete, KEEP=$KEEP) — also present, NOT restorable as they stand:$broken"
  say "      Left from before this was caught. They no longer take a retention slot and"
  say "      are never pruned, so they will sit there until you remove them. Read one"
  say "      first — 20260913T001115Z is incomplete but still holds the game's own data."
else
  say "done ($kept kept)"
fi

# HONEST LIMITATION: this is a LOCAL copy on the same machine that made it,
# which is not a backup in the sense that matters — one disk failure or one
# stolen laptop takes the database and every copy of it. It is strictly better
# than the nothing that existed before, and it buys protection against the far
# likelier accident: a bad migration or a mistaken delete. Getting these off the
# machine (an encrypted external disk, or object storage the game does not use)
# is the remaining half, and it is a decision about where user data may live.
