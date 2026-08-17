#!/usr/bin/env bash
#
# validate_db_url — shape-check a Postgres connection URI BEFORE handing it to
# any tool that might print it.
#
# WHY THIS EXISTS: on 2026-08-17 the keychain held a URI whose password field
# was still wrapped in the dashboard's square brackets, with a stray space
# inside them. Nothing caught it, so the URI went straight to psql — and psql
# rejected it with an error message that QUOTED THE PASSWORD FIELD BACK. A
# malformed credential became a leaked credential, printed to a terminal and a
# transcript, and the password had to be rotated.
#
# So the rule is: validate first, connect second. Every check below is one that
# can be made without a network round trip, and NOTHING here ever echoes the
# value — only the name of the rule that failed.
#
# Usage:
#   . "$(dirname "$0")/lib-validate.sh"
#   DB_URL="$(security find-generic-password -s ... -w)"
#   if reason="$(validate_db_url "$DB_URL")"; then : ; else echo "$reason"; exit 1; fi
#
# The value is passed as an argument to a SHELL FUNCTION, which is an in-process
# call — it never becomes a separate process, so it never appears in `ps`.

validate_db_url() {
  local u="$1"

  if [ -z "$u" ]; then
    echo "empty — no value stored"; return 1
  fi

  # Scheme. Postgres accepts both spellings; Supabase's dashboard shows the long one.
  case "$u" in
    postgresql://*|postgres://*) ;;
    *) echo "not a Postgres URI — must begin 'postgresql://'. If it begins 'sb_secret_', 'sb_publishable_' or 'eyJ' you have stored an API key instead of the database connection string."; return 1 ;;
  esac

  # The single most likely mistake, and the one that leaked a password.
  case "$u" in
    *"[YOUR-PASSWORD]"*)
      echo "the literal placeholder [YOUR-PASSWORD] is still present — replace it with the real database password"; return 1 ;;
  esac
  case "$u" in
    *"["*|*"]"*)
      echo "contains square brackets — the dashboard shows the password as [YOUR-PASSWORD] and the BRACKETS THEMSELVES must be deleted too, not just the words inside them"; return 1 ;;
  esac

  # psql refuses these outright, and says so by quoting the offending field.
  case "$u" in
    *" "*)  echo "contains a space — percent-encode it as %20, or remove it if it was pasted by accident"; return 1 ;;
  esac
  case "$u" in
    *"	"*) echo "contains a tab — the value was probably pasted from a table or wrapped line"; return 1 ;;
  esac

  # Structure: user@host is mandatory, and a bare host with no password will
  # prompt interactively — which an unattended launchd job cannot answer.
  case "$u" in
    *@*) ;;
    *) echo "has no '@' — the user and host section is missing"; return 1 ;;
  esac
  case "$u" in
    postgresql://*:*@*|postgres://*:*@*) ;;
    *) echo "has no password before the '@' — an unattended run would block on a password prompt forever"; return 1 ;;
  esac

  # Host choice. Not fatal, but both wrong choices fail in ways that are hard to
  # read: the direct host is IPv6-only, and the transaction pooler rejects the
  # statements pg_dump issues.
  case "$u" in
    *.pooler.supabase.com:5432/*) ;;
    *:6543/*)
      echo "points at the TRANSACTION pooler (port 6543), which cannot serve pg_dump — use the SESSION pooler on port 5432"; return 1 ;;
    *db.*.supabase.co*)
      echo "points at the direct host (db.<ref>.supabase.co), which is IPv6-only and unreachable from most networks — use the SESSION pooler (aws-N-<region>.pooler.supabase.com:5432)"; return 1 ;;
  esac

  return 0
}
