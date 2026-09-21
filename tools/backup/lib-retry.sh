#!/usr/bin/env bash
#
# lib-retry.sh — how long to wait between dump attempts.
#
# WHY A RETRY POLICY IS A SEPARATE, TESTED THING: it is one arithmetic function,
# and getting it wrong is invisible. A schedule that runs off the end of its own
# list and waits 0 seconds is a hot loop against a database that just dropped the
# connection — which is both useless and rude to the pooler. Sourced rather than
# inlined so tools/backup/test-validate.sh can run it with no database at all.

# backoff_for <attempt-number> <seconds...>
#   Seconds to wait AFTER attempt N fails. Attempts past the end of the list
#   reuse the last value, so the list never has to be kept in step with the
#   attempt count — and can never be walked off the end into an empty string,
#   which `sleep` would reject and, under `set -e`, would kill the backup on the
#   recovery path instead of on the fault.
backoff_for() {
  local want="$1"; shift
  local n=0 v=0 s
  for s in "$@"; do
    n=$((n + 1))
    v="$s"
    if [ "$n" -ge "$want" ]; then break; fi
  done
  printf '%s' "$v"
}
