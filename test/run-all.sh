#!/usr/bin/env bash
# Run the whole suite. Use this rather than starting servers by hand.
#
# The subtle failure this guards against: if an old `node server.js` is still
# bound to the port when a new one starts, BOTH end up listening and incoming
# connections split between them. A multi-client test (ffa / ffa_elim) then has
# its players land in different processes, the room only exists in one, and the
# test fails with a bare "timeout waiting for gameover" that looks like a
# product bug. So: always wait for the port to actually be free.
#
#   ./test/run-all.sh              # localhost
#   WS=wss://host/ws ./test/run-all.sh --remote   # against a deployment
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
REMOTE=0
[ "${1:-}" = "--remote" ] && REMOTE=1

pass=0; fail=0
run() {                      # run <name> <cmd...>
  local name="$1"; shift
  if "$@" > /tmp/cc_$name.log 2>&1; then
    printf '  %-16s PASS\n' "$name"; pass=$((pass+1))
  else
    printf '  %-16s FAIL\n' "$name"; fail=$((fail+1))
    sed 's/^/      /' /tmp/cc_$name.log | tail -14
  fi
}

kill_server() {
  pkill -f "node server.js" 2>/dev/null
  for _ in $(seq 1 40); do                     # up to ~10s for the port to clear
    local pids; pids=$(lsof -ti :"$PORT" 2>/dev/null)
    [ -z "$pids" ] && return 0
    kill -9 $pids 2>/dev/null
    sleep 0.25
  done
  echo "  WARNING: port $PORT still busy: $(lsof -ti :"$PORT" | tr '\n' ' ')"
}

start_server() {             # start_server [extra env assignments...]
  kill_server
  # Truncate FIRST. The readiness check greps this file for the banner, and a
  # previous server's line would satisfy it instantly — the tests would then
  # connect before this server is listening, which shows up much later as a
  # bare "timeout waiting for gameover" that looks like a product bug.
  : > /tmp/cc_server.log
  env "$@" node server.js >> /tmp/cc_server.log 2>&1 &
  for _ in $(seq 1 40); do
    grep -q "running at" /tmp/cc_server.log 2>/dev/null && sleep 0.3 && return 0
    sleep 0.25
  done
  echo "  WARNING: server did not report ready"; return 1
}

echo "== headless (no server needed) =="
run house_rules node test/house-rules.mjs
run hitbox node test/hitbox.mjs
run golf_hazards node test/golf_hazards.mjs

if [ "$REMOTE" = "1" ]; then
  echo "== against ${WS:-?} =="
  for t in sim resume_test resume_takeover ffa boss golf horde batch6 security; do run "$t" node test/$t.mjs; done
  echo "  (ffa_elim needs RESUME_GRACE_MS on the server — local only)"
else
  echo "== local server =="
  start_server BOT_FIRE_MS=250 PICK_MS=800
  for t in sim resume_test resume_takeover ffa boss golf horde batch6 security; do run "$t" node test/$t.mjs; done

  echo "== local server, short resume grace =="
  start_server RESUME_GRACE_MS=1200 BOT_FIRE_MS=250 PICK_MS=800
  run ffa_elim node test/ffa_elim.mjs
  kill_server

  # Spawns and SIGTERMs its OWN server on its own port, so it must run with no
  # shared server up — and must never be aimed at a deployed one.
  echo "== self-hosted (spawns + signals its own server) =="
  run shutdown node test/shutdown.mjs
  # Also self-hosted: mocks Supabase locally and asserts the push-persistence
  # wire shapes (verify, upsert, nudge lookup, delivery, dead-endpoint delete).
  run push_persist node test/push_persist.mjs
  # Also self-hosted, and it asks the OS for a free port rather than taking one
  # — kill_server() above only clears $PORT, so a hardcoded port left busy by a
  # crashed run would surface here as a misleading "server never came up".
  # Guards ISSUE-036 (b) UTF-8 across chunk boundaries in /errors, and (c) a
  # missing asset returning a real 404 instead of 200 + text/html.
  run http_contract node test/http_contract.mjs

  # Expected chatter: the listen banner, the readiness line (8.58 — locally it
  # always reads supabase=unconfigured, which is correct with no env), and the
  # graceful-shutdown line the harness itself triggers every time it SIGTERMs a
  # shared server. Anything else in this log is a real problem and must stay
  # loud — do not widen this filter to silence a genuine error. Note the boot
  # line only reaches STDERR when something is wired WRONG, so a `[boot]` here
  # with bad_key_or_url/unreachable is still worth reading.
  benign='running at|^\[boot\]|^\[shutdown\] SIGTERM'
  stray=$(grep -vE "$benign" /tmp/cc_server.log 2>/dev/null | wc -l | tr -d ' ')
  [ "$stray" != "0" ] && { echo "  server stderr:"; grep -vE "$benign" /tmp/cc_server.log; }
fi

echo
echo "$pass passed, $fail failed"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
