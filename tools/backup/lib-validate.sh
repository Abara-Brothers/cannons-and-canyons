#!/usr/bin/env bash
#
# validate_db_password — sanity-check the secret BEFORE anything connects with it.
#
# WHY THIS EXISTS: on 2026-08-17 the Keychain held a hand-spliced connection
# URI whose password was still wrapped in the dashboard's square brackets, with
# a stray space inside them. Nothing checked it, so it went straight to psql —
# which rejected it by QUOTING THE PASSWORD FIELD BACK into the terminal. A
# typo became a credential rotation.
#
# The URI is now assembled by machine, not by hand, so the old URI-shape
# validator is gone: host, port, user and database come from db.conf and the
# password is passed via PGPASSWORD, which needs no escaping. What remains is
# the one check a machine still cannot make for you — whether the human pasted
# the RIGHT SECRET. A password may legitimately contain brackets, spaces or
# punctuation, so this deliberately does NOT police its characters; it only
# catches values that are unmistakably something else.
#
# It never echoes the value, only the name of the rule that failed.

validate_db_password() {
  local p="$1"

  if [ -z "$p" ]; then
    echo "empty — no password stored"; return 1
  fi

  case "$p" in
    postgresql://*|postgres://*)
      echo "that is a whole connection string, not a password — paste only the password itself; the host and user come from db.conf"; return 1 ;;
    sb_secret_*|sb_publishable_*|eyJ*)
      echo "that is a Supabase API key, not the database password — get the database password from Settings -> Database -> Reset database password"; return 1 ;;
    "[YOUR-PASSWORD]"|"[your-password]")
      echo "that is the dashboard's placeholder text, not a password"; return 1 ;;
  esac

  # A leading or trailing space is almost always a paste artefact, and unlike
  # interior characters it is invisible to the person who pasted it.
  case "$p" in
    " "*|*" ")
      echo "starts or ends with a space — that is almost certainly a paste artefact; re-copy the password"; return 1 ;;
  esac

  return 0
}
