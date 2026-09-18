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
# The tests default to ws://localhost:3000/ws individually, so overriding PORT
# alone started the server somewhere else and left eleven suites connecting to
# 3000 — 7 passed / 11 ECONNREFUSED. This header exists to prevent exactly that
# class of misleading failure. The ${WS:-…} form leaves --remote untouched.
export WS="${WS:-ws://localhost:$PORT/ws}"
REMOTE=0
[ "${1:-}" = "--remote" ] && REMOTE=1

pass=0; fail=0; skip=0
run() {                      # run <name> <cmd...>
  local name="$1"; shift
  "$@" > /tmp/cc_$name.log 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '  %-16s PASS\n' "$name"; pass=$((pass+1))
  elif [ "$rc" -eq 3 ]; then
    # EXIT 3 = SKIPPED, not passed. merge.mjs exits when Chrome is absent, and
    # scoring that as PASS meant the only client-side coverage in the tree
    # reported success on every CI run without ever executing — CI is
    # ubuntu-latest and never sets CHROME_PATH. A skip must be VISIBLE.
    printf '  %-16s SKIP  %s\n' "$name" "$(tail -1 /tmp/cc_$name.log)"; skip=$((skip+1))
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
run timer_safety node test/timer_safety.mjs
# FFA vs CPUs, in-process: the 'ai' case's duel seat stays key-for-key the
# historical literal, and a room of plain CPUs hands the turn bot to bot.
run ffa_bots node test/ffa_bots.mjs
# Same feature, production fire hold: ffa CPUs use the 550 ms survival hold,
# the duel CPU keeps 1500 ms. Separate because the 40 ms knob above hides it.
run ffa_bots_pace node test/ffa_bots_pace.mjs
# The exact offline entry points: boss/aliens/golf create+startMatch with one
# commander, a one-seat ffa create refused, the ffa 'ai' frame starting at once.
run solo_engine node test/solo_engine.mjs
# Artillery Golf for four, in-process: seat cap (a one-seat room tees off on
# create), the honour rule (farthest ball plays next), forfeits inside a
# four-player round, the winner rule, and real four-, three- and two-player
# holes played right through the engine.
run golf_order node test/golf_order.mjs
  # The OAuth redirect contract: provider, return URL, and the anti-login-CSRF
  # guard on BOTH carriers. Headless — cloud.js is evaluated against stubs.
  run auth_redirect   node test/auth_redirect.mjs
  # Sign in with Apple, natively: the id_token grant, the link variant with the
  # guest's bearer, and every refusal. Headless — the same stub harness.
  run apple_native    node test/apple_native.mjs
  # whoami()'s per-provider account list, the source of the account chip and
  # the Bay controls row. Headless — the same stub harness.
  run account         node test/account.mjs
run validate    bash tools/backup/test-validate.sh
run hitbox node test/hitbox.mjs
run golf_hazards node test/golf_hazards.mjs

if [ "$REMOTE" = "1" ]; then
  echo "== against ${WS:-?} =="
  for t in sim resume_test resume_takeover ffa boss golf horde batch6 security rematch; do run "$t" node test/$t.mjs; done
  echo "  (ffa_elim needs RESUME_GRACE_MS on the server — local only)"
else
  echo "== local server =="
  start_server BOT_FIRE_MS=250 PICK_MS=800
  # ffa_bots_live drives three real CPUs on the real event loop; local only
  # until it has run green for a while (it is not in the --remote loop above).
  for t in sim resume_test resume_takeover ffa boss golf horde batch6 security rematch ffa_bots_live; do run "$t" node test/$t.mjs; done

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
  # The Apple half of native push. Mocks Supabase AND both Apple hosts locally,
  # so it never reaches production or APNs. Exercises HTTP/2, ES256 signing and
  # the dead-token contract — including the one that must NOT delete a row.
  run push_apns node test/push_apns.mjs
  # Also self-hosted, and it asks the OS for a free port rather than taking one
  # — kill_server() above only clears $PORT, so a hardcoded port left busy by a
  # crashed run would surface here as a misleading "server never came up".
  # Guards ISSUE-036 (b) UTF-8 across chunk boundaries in /errors, and (c) a
  # missing asset returning a real 404 instead of 200 + text/html.
  run http_contract node test/http_contract.mjs
  run ledger node test/ledger.mjs
  # GET /history (Launch Bay recent sorties): the one client read path into the
  # ledger. Mocks Supabase; asserts no uuid ever leaves, W/L derivation, auth, rate limit.
  run history node test/history.mjs
  # First CLIENT-side coverage (RISK-012). Drives the real mergeCloudProgression
  # in a real page over CDP, so it cannot drift from a copy of the logic.
  # Skips cleanly when Chrome is absent, so a bare CI runner stays green.
  run merge node test/merge.mjs
  # THIRD client-side suite: the offline lobby, Play solo, Cancel and the Back
  # arrow, driven in a real page with the server stopped and resumed. Also skips
  # without Chrome — a SKIP here means the offline path shipped unproven.
  run offline node test/offline.mjs
  # FOURTH client-side suite: the account chip, the Account row, the modal
  # lines and the home-only type size, in a real page. Skips without Chrome.
  run account_ui node test/account_ui.mjs
  # FIFTH client-side suite: Artillery Golf's off-screen flag marker and its
  # tap-to-pan, on a local solo round. Skips without Chrome.
  run golf_marker node test/golf_marker.mjs
  # SIXTH client-side suite: golf for four in the page — the Players choice
  # into the create frame, four HUD cards, a four-row scorecard. Skips without Chrome.
  run golf_four_ui node test/golf_four_ui.mjs
  # SECOND client-side suite, and the only one that looks at LAYOUT. Drives the
  # real bundle in headless Chrome at 14 exact viewports and diffs the measured
  # geometry against test/fixtures/layout-baseline.json. It is a change
  # detector, not a correctness oracle: it cannot say the layout is good, only
  # that it has not moved since someone last looked. That is what makes a wide
  # media-query rewrite (ISSUE-039, the iPad reflow) survivable. Also skips
  # cleanly without Chrome.
  run layout node test/layout.mjs

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
echo "$pass passed, $fail failed$([ "$skip" -gt 0 ] && echo ", $skip SKIPPED — not run, not proven")"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
