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
# ONE RUN'S LOGS, NAMED BY ITS PORT. Every suite's output and the shared
# server's went to fixed /tmp/cc_<name>.log paths, so two runs at once (two
# sessions, even on different ports) wrote over each other's logs and the
# readiness grep could see the other run's banner: fake failures. Each run
# now writes /tmp/cc_<PORT>_<name>.log and /tmp/cc_<PORT>_server.log.
# .github/workflows/ci.yml's failure-log step reads the same names.
LOG="/tmp/cc_${PORT}"
REMOTE=0
[ "${1:-}" = "--remote" ] && REMOTE=1

pass=0; fail=0; skip=0
run() {                      # run <name> <cmd...>
  local name="$1"; shift
  "$@" > "${LOG}_$name.log" 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '  %-16s PASS\n' "$name"; pass=$((pass+1))
  elif [ "$rc" -eq 3 ]; then
    # EXIT 3 = SKIPPED, not passed. merge.mjs exits when Chrome is absent, and
    # scoring that as PASS meant the only client-side coverage in the tree
    # reported success on every CI run without ever executing — CI is
    # ubuntu-latest and never sets CHROME_PATH. A skip must be VISIBLE.
    printf '  %-16s SKIP  %s\n' "$name" "$(tail -1 "${LOG}_$name.log")"; skip=$((skip+1))
  else
    printf '  %-16s FAIL\n' "$name"; fail=$((fail+1))
    sed 's/^/      /' "${LOG}_$name.log" | tail -14
  fi
}

# The PIDs of the servers THIS run started, space separated. kill_server() kills
# exactly these, by PID, and never by command-line pattern. What used to stand
# here was `pkill -f "node server.js"`, which matched EVERY process on the
# machine whose command line contained that string — so a server someone had
# started by hand, in this checkout or any other, died silently the next time
# anyone ran the suite. The one long-lived server that survived did so purely by
# accident: it had been started as `node /abs/path/server.js`, and the pattern
# wanted the bare relative spelling.
SERVER_PIDS=""
REPO_DIR="$PWD"

# Kill only what this run started. Nothing else can ever reach SERVER_PIDS:
# every entry came from $! at the instant we backgrounded the job.
kill_own_servers() {
  [ -n "$SERVER_PIDS" ] || return 0
  local pid alive=""
  for pid in $SERVER_PIDS; do kill -TERM "$pid" 2>/dev/null; done
  for _ in $(seq 1 12); do                     # ~3s for a graceful shutdown
    alive=""
    for pid in $SERVER_PIDS; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
    [ -z "$alive" ] && break
    sleep 0.25
  done
  for pid in $alive; do kill -KILL "$pid" 2>/dev/null; done
  SERVER_PIDS=""
}
# So an interrupted run cleans up after itself, rather than leaving behind the
# orphan that the old machine-wide pkill existed to sweep away.
trap kill_own_servers EXIT

# Is $1 this checkout's own server? Consulted ONLY to decide whether something
# squatting on our port may be cleared. Two ways to be sure, and both are
# needed: the command line names this checkout's server.js outright (how an
# absolute-path launch looks, whatever its cwd), or the process's cwd is this
# checkout (how a bare `node server.js` from the repo root looks).
is_our_server() {
  local pid="$1" cmd cwd
  cmd=$(ps -o command= -p "$pid" 2>/dev/null)
  [ -n "$cmd" ] || return 1
  case "$cmd" in *server.js*) ;; *) return 1 ;; esac
  case "$cmd" in *"$REPO_DIR/server.js"*) return 0 ;; esac
  cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  [ -n "${cwd:-}" ] && [ "$cwd" = "$REPO_DIR" ]
}

kill_server() {
  kill_own_servers
  # Safety net for an orphan left behind by a crashed earlier run. Deliberately
  # narrow: a process qualifies only if it is holding the port THIS run needs
  # AND is this checkout's own server. That is the entire overlap in which an
  # outsider can still be in our way. A server on any other port, and any other
  # program on this one, is reported and left alone — never killed, never
  # silently. Widening either half of that test brings the old bug back.
  local pid pids cmd seen=""
  for _ in $(seq 1 40); do                     # up to ~10s for the port to clear
    pids=$(lsof -ti :"$PORT" 2>/dev/null)
    [ -z "$pids" ] && return 0
    for pid in $pids; do
      case " $seen " in *" $pid "*) continue ;; esac
      cmd=$(ps -o command= -p "$pid" 2>/dev/null)
      [ -n "$cmd" ] || continue                # already gone; the port will clear
      seen="$seen $pid"
      if is_our_server "$pid"; then
        echo "  note: clearing an orphaned server holding port $PORT (pid $pid)"
        kill -KILL "$pid" 2>/dev/null
      else
        echo "  WARNING: port $PORT is held by pid $pid, which this run did not"
        echo "           start and which is not this checkout's server. Left alone:"
        echo "           $cmd"
        echo "           Stop it yourself, or run the suite with PORT=<a free port>."
      fi
    done
    sleep 0.25
  done
  echo "  WARNING: port $PORT still busy: $(lsof -ti :"$PORT" 2>/dev/null | tr '\n' ' ')"
  return 1
}

start_server() {             # start_server [extra env assignments...]
  kill_server
  # Truncate FIRST. The readiness check greps this file for the banner, and a
  # previous server's line would satisfy it instantly — the tests would then
  # connect before this server is listening, which shows up much later as a
  # bare "timeout waiting for gameover" that looks like a product bug.
  : > "${LOG}_server.log"
  env "$@" node server.js >> "${LOG}_server.log" 2>&1 &
  # Record the PID NOW: $! is clobbered by the next background job, and a server
  # that never reports ready still has to be cleaned up.
  SERVER_PIDS="$SERVER_PIDS $!"
  for _ in $(seq 1 40); do
    grep -q "running at" "${LOG}_server.log" 2>/dev/null && sleep 0.3 && return 0
    sleep 0.25
  done
  echo "  WARNING: server did not report ready"; return 1
}

echo "== headless (no server needed) =="
run house_rules node test/house-rules.mjs
# The account data export's shape, which privacy.html describes field by field.
# Headless: it lifts exportMyData() out of app.js by brace-matching and runs that
# one function against stubs, because app.js itself cannot be loaded under Node.
run export_shape node test/export_shape.mjs
# The chosen-callsign rules (design 4.5): normalising, length, characters, the
# folded blocklist, and the loader's own guards. Pure module, no server.
run callsign node test/callsign.mjs
# ONE proof of a name, for every screen that shows one: server/display-name.js.
# It has ONE caller now -- the social layer's panels, search results, the blocked
# list, the squad roster and its invites, and the name a report records. It stays
# its own module because it is a security rule with its own suite against the
# SHIPPED server/blocklist.txt (BINDING.md resolution 27), not because two files
# import it -- a suite with its own term list would not notice the shipped list
# and the rule drifting apart. No server.
run display_name node test/display_name.mjs
# Web push is only ever SENT to a real push service (live hotfix, 2026-09-25):
# server/push-hosts.js, a pure module. Every legitimate endpoint shape, every
# spoofing trick, and a fuzz that hands each accepted string to https.request,
# as server.js's webPushSend connects, and to url.parse(), to prove the host
# either would reach is a push service; and a pin that server.js makes every web
# push request that one way, straight after the gate. No server. push_persist
# and push_invite below prove the same end to end.
run push_hosts node test/push_hosts.mjs
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
# The social layer's callsign message, in process: the two sign-in gates (a
# linked account for callsigns and friends, any account for report and block —
# a guest HAS an anonymous account id), the character/length/blocklist codes,
# the uniqueness race, the once-a-day gate against an injected clock, the 3/min
# bucket, and any throw answering unavailable instead of crashing a socket.
# Fake store, no server, no Supabase.
run social node test/social.mjs
# The social data store: the exact PostgREST path of every method, the uuid gate
# before any value is spliced into a query string, the friendship pair ordering,
# the unique-violation-to-'taken' translation and the friend-code retry. Headless
# — a recording fake stands in for sbAdmin, so it never reaches Supabase.
run social_store node test/social_store.mjs
# The per-room seat handle (BINDING.md resolution 24), both halves and the join
# between them: the REAL room engine mints one per occupied accounted seat and
# puts it in the lobby payload, the REAL social layer reports and blocks through
# it, and they are wired exactly as server.js wires them. Proves no account id
# reaches a lobby, a handle is useless in another room and dead with its own,
# a raw uuid cannot take the handle's door, the resolution order, and that the
# handle never reaches the [report] log line. Headless — no server, no Supabase.
run seat_handle node test/seat_handle.mjs
# ONE CODE NAMESPACE, and the two frame types squads reach the server through.
# Drives the REAL room engine (real makeCode, real `rooms` Map, real create
# path) and the REAL social layer in one process, wired exactly as server.js
# wires them, so a squad code and a room code cannot name the same thing and a
# squad frame is answered rather than dropped. Headless — no server, no
# Chrome, no Supabase.
run squad node test/squad.mjs

  # The OAuth redirect contract: provider, return URL, and the anti-login-CSRF
  # guard on BOTH carriers. Headless — cloud.js is evaluated against stubs.
  run auth_redirect   node test/auth_redirect.mjs
  # Sign in with Apple, natively: the id_token grant, the link variant with the
  # guest's bearer, and every refusal. Headless — the same stub harness.
  run apple_native    node test/apple_native.mjs
  # whoami()'s per-provider account list, the source of the account chip and
  # the Bay controls row. Headless — the same stub harness.
  run account         node test/account.mjs
  # THE CLOUD SAVE, and the one thing it must never be able to do: write this
  # device's name over an account's CHOSEN callsign. public/cloud.js is not in
  # the phase 6 diff at all, which is exactly why nothing caught it -- 27 commits
  # made profiles.callsign load-bearing around a file nobody touched. Headless,
  # the same stub harness.
  run cloud_save      node test/cloud_save.mjs
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
  # The AUTH SINK, driven end to end: a profile row whose `callsign` does not
  # normalise to its own `callsign_key` must not become ws.chosenName, because
  # `callsign` is a column the account itself may PATCH. Mocks GoTrue and
  # PostgREST and spawns its own server, so it never reaches Supabase.
  run auth_sink node test/auth_sink.mjs
  # Also self-hosted: mocks Supabase locally and asserts the push-persistence
  # wire shapes (verify, upsert, nudge lookup, delivery, dead-endpoint delete).
  run push_persist node test/push_persist.mjs
  # The Apple half of native push. Mocks Supabase AND both Apple hosts locally,
  # so it never reaches production or APNs. Exercises HTTP/2, ES256 signing and
  # the dead-token contract — including the one that must NOT delete a row.
  run push_apns node test/push_apns.mjs
  # One transport, two callers: the shared pushToUser, the seat-local half of the
  # dead-endpoint cleanup, and the squad invite's own collapse key on all three
  # transports. Mocks Supabase, Apple, FCM and the web push endpoint locally.
  run push_invite node test/push_invite.mjs
  # A squad's Start, seated into one room by the REAL seatSquad in server.js --
  # the only place it can be reached, because server.js exports nothing and
  # binds a port on import, so a headless suite could only stub the thing under
  # test. Spawns its own servers on free ports (one with MAX_ROOMS=1 for the
  # capacity refusal) against a local Supabase mock, and drives abandonRoom in
  # process; it never reaches production.
  run squad_seat node test/squad_seat.mjs
  # Also self-hosted, and it asks the OS for a free port rather than taking one
  # — kill_server() above only clears $PORT, so a hardcoded port left busy by a
  # crashed run would surface here as a misleading "server never came up".
  # Guards ISSUE-036 (b) UTF-8 across chunk boundaries in /errors, and (c) a
  # missing asset returning a real 404 instead of 200 + text/html.
  run http_contract node test/http_contract.mjs
  # The "Enter a code" field's question asked of the REAL server.js, twice:
  # with the social layer OFF (no Supabase env) a room code must still answer
  # 'room' -- joining a room by code never needed the database -- and a
  # squad-shaped code 'none', never 'squad', with the engine's own join agreeing
  # with both; and with the layer ON against a mock Supabase that HANGS, a code
  # frame must be answered while that socket's hello is still pending and while
  # a friends read is still running on it. Spawns its own servers on free ports
  # and mocks GoTrue/PostgREST locally; no Chrome, no real Supabase.
  run code_frame node test/code_frame.mjs
  run ledger node test/ledger.mjs
  # /health's three Supabase verdicts, which are what the deploy procedure tells
  # the owner to read and act on. Spawns a server per world against a mock that
  # answers a chosen status, because each verdict is latched at boot. Exists
  # because only the happy path was ever asserted: every non-2xx collapsed into
  # 'bad_secret_key', so a transient 5xx during a deploy's connection churn told
  # the owner his key was broken.
  run health node test/health.mjs
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
  # The in-game dock remembers up or down per device (owner, 2026-10-06): the
  # first match opens UP, only the CONTROLS tab writes the choice, and every new
  # battle, golf round and cold resume reads it back, while a same-match resync
  # and the next golf hole leave the dock alone. Real matches against its own
  # server, real taps on the tab. Skips without Chrome.
  run dock node test/dock.mjs
  # SEVENTH client-side suite: the Bay's Set callsign control — the row with Roll
  # and Set, the inline field, every error sentence, the exact frames that reach
  # the socket, what a guest is told, and the landscape keyboard lift. The socket
  # is stubbed and Supabase is never touched. Skips without Chrome.
  run social_ui node test/social_ui.mjs
  # EIGHTH client-side suite: the Squad box in the left home slot -- the bay's
  # first tab bar, the one client squad read model (window.CC_SQUAD, pushes
  # included), and every state before a squad is drawn (guest, offline, not
  # answered yet, ended, no squad). The socket is stubbed and Supabase is never
  # touched. Every CDP call carries a deadline. Skips without Chrome.
  run squad_ui node test/squad_ui.mjs
  # Deep links, in a real page: the ONE parser behind ?room=, ?squad= and the
  # native notification tap, and which of the three claimants on boot wins. The
  # socket is TAPPED, not stubbed, so a frame that was sent can be told from a
  # frame that was merely attempted. Every CDP call carries a deadline. Skips
  # without Chrome.
  run deeplink node test/deeplink.mjs
  # SECOND client-side suite, and the only one that looks at LAYOUT. Drives the
  # real bundle in headless Chrome at 14 exact viewports and diffs the measured
  # geometry against test/fixtures/layout-baseline.json. It is a change
  # detector, not a correctness oracle: it cannot say the layout is good, only
  # that it has not moved since someone last looked. That is what makes a wide
  # media-query rewrite (ISSUE-039, the iPad reflow) survivable. Also skips
  # cleanly without Chrome.
  run layout node test/layout.mjs
  # The cold-start intro (public/intro.js): that its last frame IS the live
  # menu at six viewports, whatever the menu currently looks like; skipping;
  # the launches that must not play it; faults inside it; and that the iOS
  # launch image is still its frame 0. Self-hosted on its own free ports.
  # Skips without Chrome.
  run intro node test/intro.mjs

  # Expected chatter: the listen banner, the readiness line (8.58 — locally it
  # always reads supabase=unconfigured, which is correct with no env), and the
  # graceful-shutdown line the harness itself triggers every time it SIGTERMs a
  # shared server. Anything else in this log is a real problem and must stay
  # loud — do not widen this filter to silence a genuine error. Note the boot
  # line only reaches STDERR when something is wired WRONG, so a `[boot]` here
  # with bad_key_or_url/unreachable is still worth reading.
  benign='running at|^\[boot\]|^\[shutdown\] SIGTERM'
  stray=$(grep -vE "$benign" "${LOG}_server.log" 2>/dev/null | wc -l | tr -d ' ')
  [ "$stray" != "0" ] && { echo "  server stderr:"; grep -vE "$benign" "${LOG}_server.log"; }
fi

echo
echo "$pass passed, $fail failed$([ "$skip" -gt 0 ] && echo ", $skip SKIPPED — not run, not proven")"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
