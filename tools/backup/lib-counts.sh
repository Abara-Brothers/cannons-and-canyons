#!/usr/bin/env bash
#
# lib-counts.sh — build the live_rows query for the schema that is ACTUALLY
# there, and name what is not.
#
# WHY THIS EXISTS: the phase 6 migration is applied BY HAND and the deploy is a
# separate act, so this tooling runs against two different schemas — before the
# migration, when friendships, friend_requests, blocks and name_reports do not
# exist, and after it, when they do. It was correct in only one of them. All
# seven counts were a single SELECT, and one missing relation (42P01) kills a
# whole statement: `counts` became the literal string 'unavailable', MANIFEST.txt
# recorded `live_rows  : unavailable`, and backup-auto.sh — which reads
# auth.users out of that line precisely to catch a dump of an empty database —
# found no number and printed "refusing to bless a backup with no accounts" over
# a dump that held every one of them. offsite.sh applies the same test, so the
# off-site archive was refused too, and the prune never ran.
#
# A backup that refuses to bless itself is not a cosmetic bug. The owner either
# loses backup coverage or learns to ignore a red line, and both are worse than
# the risk the check was written for. So a table that does not exist yet is a
# KNOWN, NAMED STATE here, never a failure: it is counted when it exists, named
# in the manifest when it does not, and it can no longer take the three counts
# that have always worked down with it.
#
# These are pure string functions with no I/O on purpose. tools/backup/
# test-validate.sh runs them with no database and no credentials, so the one
# property that matters — the live_rows line always carries auth.users, whatever
# the schema is doing — is pinned by the suite instead of by hope. Nothing in
# the suite executed backup.sh before, which is why this shipped.

# The tables the phase 6 migration adds, in the order the manifest names them.
CC_PHASE6_TABLES="friendships friend_requests blocks name_reports"

# counts_sql <present...>
#   The one-statement live_rows query: the three tables that have always existed,
#   plus exactly those phase 6 tables named in the argument list. A table that is
#   not named is not mentioned by the SQL at all — which is the whole point, since
#   a relation is resolved at PARSE time and naming a missing one fails the
#   statement before any of the others are counted.
counts_sql() {
  local present=" $* " t
  local q="select 'auth.users=' || (select count(*) from auth.users)
      || ' profiles='  || (select count(*) from public.profiles)
      || ' push_subs=' || (select count(*) from public.push_subscriptions)"
  for t in $CC_PHASE6_TABLES; do
    case "$present" in
      *" $t "*) q="$q
      || ' $t=' || (select count(*) from public.$t)" ;;
    esac
  done
  printf '%s\n' "$q"
}

# counts_absent <present...>
#   Which phase 6 tables are NOT in that list, in the canonical order, space
#   separated. Empty output means every one of them is there.
counts_absent() {
  local present=" $* " out="" t
  for t in $CC_PHASE6_TABLES; do
    case "$present" in
      *" $t "*) ;;
      *) out="$out $t" ;;
    esac
  done
  printf '%s' "${out# }"
}
