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
#   roles.sql   — role grants. REQUIRED since 2026-09-21; see the note above
#                 the roles dump below for what its exemption was hiding.
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
. "$HERE/lib-retry.sh"

OUT_ROOT="${1:-$(cd "$HERE/../.." && pwd)/backups}"
mkdir -p "$OUT_ROOT"
# Absolutised before anything is built from it, because further down a path
# derived from this is handed to `rm -rf`. backup-auto.sh already passes an
# absolute path; a human running backup.sh by hand may not, and the one previous
# `rm -rf` bug in this tooling fired at a relative path (see the prune in
# backup-auto.sh). Resolve it once, here, rather than trusting the caller.
OUT_ROOT="$(cd "$OUT_ROOT" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL="$OUT_ROOT/$STAMP"
STAGE="$OUT_ROOT/.incomplete-$STAMP"

: "${PGHOST:?PGHOST is not set — run tools/backup/backup-auto.sh instead, or see the header}"
: "${PGUSER:?PGUSER is not set}"
: "${PGPASSWORD:?PGPASSWORD is not set}"
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-postgres}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-30}"

# libpq is keg-only under Homebrew, so it is not on PATH by default — and a
# launchd job gets an even barer PATH than a login shell.
#
# CC_PG_BIN overrides the search. It exists so the fail-on-purpose drill can put
# a fake pg_dump in front of this and reproduce the failure that actually hurt:
# one that dies PART WAY THROUGH, after roles and auth have landed and before
# public ever does. That is the 2026-09-20 shape, and an unreachable host cannot
# produce it — an unreachable host fails on the first step, where there is
# nothing half-written to get wrong. Never set it in normal use.
PG_BIN="${CC_PG_BIN:-}"
if [ -z "$PG_BIN" ]; then
  for p in /opt/homebrew/opt/libpq/bin /usr/local/opt/libpq/bin; do
    [ -x "$p/pg_dump" ] && PG_BIN="$p" && break
  done
fi
if [ -z "$PG_BIN" ]; then
  command -v pg_dump >/dev/null 2>&1 || {
    echo "pg_dump not found. Install it: brew install libpq" >&2; exit 1; }
  PG_BIN="$(dirname "$(command -v pg_dump)")"
fi
DUMP="$PG_BIN/pg_dump"
DUMPALL="$PG_BIN/pg_dumpall"
PSQL="$PG_BIN/psql"


# ---------------------------------------------------------------------------
# NOTHING IS EVER WRITTEN STRAIGHT INTO A PATH THAT LOOKS LIKE A BACKUP.
#
# backups/20260920T001552Z is a directory with an ordinary timestamp name
# holding auth.sql and roles.sql and NO public.sql and no manifest: a run died
# mid-dump and left its wreckage sitting in the backups list, where `ls` shows
# it as the NEWEST backup. It is not a backup — it has none of the game's own
# data. A half-written directory that looks complete is worse than no directory
# at all, because it is what you reach for in the one hour you are least able to
# check it.
#
# So every attempt dumps into ".incomplete-<stamp>" and that directory is
# RENAMED into place only once all three files exist, are non-empty, and are
# described by a manifest whose row counts came back from a live connection. The
# rename is the single act that makes a backup exist, and on this filesystem it
# is atomic. The leading dot also keeps the staging directory out of the `*/`
# glob backup-auto.sh prunes with, and its name does not match that prune's
# stamp pattern either — two independent reasons it can never be counted as a
# backup or deleted as one.
discard_stage() {
  [ -n "${STAGE:-}" ] || return 0
  # A belt-and-braces guard on the argument to `rm -rf`: whatever else has gone
  # wrong, this function can only ever delete a staging directory of ours.
  case "$STAGE" in "$OUT_ROOT"/.incomplete-*) ;; *) return 0 ;; esac
  [ -e "$STAGE" ] || return 0
  if [ -L "$STAGE" ]; then
    echo "  refusing to remove $STAGE — it is a symlink" >&2
    return 0
  fi
  rm -rf -- "$STAGE"
  return 0
}
# So a signal — a laptop shutting down, launchd stopping the job, a Ctrl-C —
# cannot leave the staging directory behind either.
trap 'discard_stage' EXIT HUP INT TERM

# ---------------------------------------------------------------- retry policy
#
# WHY RETRIES EXIST: every failure in backups/backup.log in the month before
# 2026-09-21 was a TRANSIENT connection fault against the Supabase pooler —
# "server closed the connection unexpectedly" partway through a dump, or
# "could not translate host name ... to address" on a laptop that had just woken
# up. Not one was a misconfiguration; db.conf is correct. A single dropped TCP
# connection was costing an entire week of protection, because the job runs
# weekly and nothing ever tried twice.
#
# THE RETRY IS OF THE WHOLE DUMP, never of the piece that failed. Resuming after
# a mid-dump disconnect would splice two different reads of a live database into
# one directory. The three files are already three separate transactions;
# letting them also become three separate MOMENTS is not worth the few seconds
# it would save. Each attempt starts from an empty staging directory.
ATTEMPTS="${CC_BACKUP_ATTEMPTS:-4}"
BACKOFF="${CC_BACKUP_BACKOFF:-15 60 180}"

attempt_dump() {
  discard_stage
  mkdir -p "$STAGE" || return 1

  # ROLES ARE NO LONGER BEST-EFFORT, and this is the exemption being retired:
  #
  #     note: roles dump failed (platform-managed on Supabase; not fatal)
  #
  # It was written for a real case — Supabase's `postgres` is not a superuser and
  # cannot read pg_authid — but --no-role-passwords reads pg_roles instead, which
  # it CAN read, proven by every successful run in the log carrying a 5,900-byte
  # roles.sql. So the exemption was not catching the case it was written for. On
  # 2026-09-13 it caught "server closed the connection unexpectedly" — the same
  # transient fault as every other failure that month — wrote a ZERO-BYTE
  # roles.sql, and let the run report "done (8 kept)". It was absorbing precisely
  # the error the retry above exists to fix, and filing it as expected.
  #
  # If reading roles genuinely stops being possible, this now fails loudly and a
  # person decides what to do about it, instead of a script deciding it every
  # week in silence.
  echo "  dumping roles..."
  if ! "$DUMPALL" --roles-only --no-role-passwords -f "$STAGE/roles.sql" 2>"$STAGE/.roles.err"; then
    echo "  roles dump FAILED:"
    sed 's/^/    /' "$STAGE/.roles.err" 2>/dev/null
    return 1
  fi
  rm -f "$STAGE/.roles.err"

  echo "  dumping auth data..."
  "$DUMP" --schema=auth --data-only --no-owner --no-privileges -f "$STAGE/auth.sql" || return 1

  echo "  dumping public data..."
  "$DUMP" --schema=public --data-only --no-owner --no-privileges -f "$STAGE/public.sql" || return 1

  # ALL THREE, EACH NON-EMPTY, or this attempt did not happen. pg_dump's exit
  # status is checked above and is the primary test; this is the second one,
  # because the 2026-09-13 directory proves a file can be there and be worth
  # nothing. Note what this check is NOT: `[ -s ]` cannot tell a real dump from
  # ~800 bytes of SET/header over an empty schema. That is the row-count gate
  # below and in backup-auto.sh, and both still apply.
  for f in roles.sql auth.sql public.sql; do
    if [ ! -s "$STAGE/$f" ]; then
      echo "  $f is missing or EMPTY after a dump that reported success — not usable"
      return 1
    fi
  done

  # WHICH TABLES ARE ACTUALLY THERE, asked before anything counts them. The phase 6
  # migration is applied by hand and the deploy is separate, so this script has to
  # be right in both windows. to_regclass answers NULL for a relation that does not
  # exist instead of raising 42P01, so this probe can never be the thing that fails,
  # and it names the gap instead of guessing at it. See lib-counts.sh for what the
  # single-statement version cost. It stays NON-FATAL on purpose: an unanswered
  # probe is recorded honestly as "unknown" below, and must never be the reason a
  # backup holding real data is thrown away.
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

  # Row counts make a restore VERIFIABLE instead of hopeful, and catch the
  # failure mode that matters most: a dump that "succeeds" while containing
  # nothing. A backup nobody has counted is a backup nobody has checked.
  counts="$("$PSQL" -Atc "$(counts_sql $present)" 2>/dev/null || echo 'unavailable')"

  # THIS IS A GATE, not a note. backup-auto.sh and offsite.sh both read
  # auth.users out of the live_rows line and refuse a backup that reports no
  # accounts. When a flaky connection made this query fail, the line read
  # `unavailable`, the guard found no number, and a run whose three dumps were
  # perfectly good got thrown away as "no accounts" — a whole week lost to a
  # question a retry would almost certainly have answered. So ask again, rather
  # than promote a backup the very next guard is going to reject.
  case "$counts" in
    *auth.users=[0-9]*) ;;
    *) echo "  live row counts came back as '$counts' — the connection did not answer"
       return 1 ;;
  esac

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
  # Also a gate, for the same reason: this value is the ONLY thing a restore can
  # be checked against, and a backup that cannot be verified after a restore is
  # not much of a backup. 'no-rows' is a real answer (an empty profiles table);
  # 'unavailable' means nobody answered, and the connection gets asked again.
  if [ "$fingerprint" = "unavailable" ]; then
    echo "  profiles fingerprint could not be computed — the connection did not answer"
    return 1
  fi

  cat > "$STAGE/MANIFEST.txt" <<EOF || return 1
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
  return 0
}

echo "backing up to $FINAL"
echo "using $("$DUMP" --version)"

ok=0
i=1
while [ "$i" -le "$ATTEMPTS" ]; do
  if [ "$i" -gt 1 ]; then
    echo "attempt $i of $ATTEMPTS"
  fi
  if attempt_dump; then
    ok=1
    break
  fi
  if [ "$i" -lt "$ATTEMPTS" ]; then
    wait_s="$(backoff_for "$i" $BACKOFF)"
    echo "  attempt $i of $ATTEMPTS failed — waiting ${wait_s}s before trying again"
    sleep "$wait_s"
  else
    echo "  attempt $i of $ATTEMPTS failed — no attempts left"
  fi
  i=$((i + 1))
done

if [ "$ok" != "1" ]; then
  discard_stage
  echo "FAILED after $ATTEMPTS attempts. No backup directory was left behind —"
  echo "the newest directory in $OUT_ROOT is still the newest COMPLETE backup."
  exit 1
fi

# The rename is the backup coming into existence. Everything above this line was
# a candidate; nothing above this line was ever visible under a backup's name.
mv -- "$STAGE" "$FINAL" || { echo "could not promote the completed dump to $FINAL"; exit 1; }
STAGE=""            # nothing left to discard — keep the EXIT trap off $FINAL

# NAME THE DIRECTORY THIS RUN MADE, for backup-auto.sh to validate.
#
# It used to find it with `ls -1dt | head -1` — "whichever directory was touched
# most recently" — which is only the same thing by luck. Anything that gives
# another directory a newer mtime (a clock that stepped, a restored copy, an
# operator opening an old backup) and the caller checks the WRONG directory:
# passing a run because some older backup has a manifest, or failing a good one
# because the newest thing in backups/ is not a backup. This is the script that
# knows the answer for certain, so it says it rather than leaving it to be
# guessed.
echo "BACKUP_DIR=$FINAL"

ls -la "$FINAL"
echo
echo "live row counts at dump time: $(grep '^live_rows' "$FINAL/MANIFEST.txt" | cut -d: -f2-)"
echo "done. Store this OFF the machine that made it (that is the point of a backup)."
