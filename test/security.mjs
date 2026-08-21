// Security regressions (batch 8.25). Each section reproduces an exploit that
// was CONFIRMED against the live code during the 2026-07-31 store-readiness
// audit, and asserts it is now closed.
//
//   1. Room exhaustion — one socket could own unlimited rooms. handleClose only
//      ever resolves the LATEST ws.roomCode, so every earlier room was orphaned,
//      unreachable by cleanup and never swept. Repeated `create` exhausted the
//      instance and OOM-killed the process, destroying every live match.
//   2. NaN drive — `move.dir` reached Math.sign() unvalidated. A non-numeric
//      value produced tank.x = NaN (untargetable: every distance test in
//      simulateShot resolves false) and fuel = NaN (unlimited movement, because
//      `fuel < MOVE_STEP` is false for NaN). The old `moved <= 0` guard did not
//      catch it — NaN <= 0 is false.
//   3. Frame size — the socket now caps a single frame (maxPayload).
//   4. Seat hoarding — `join` checked room state and fullness but never whether
//      the socket ALREADY held a seat, so one socket could take several. Filling
//      an FFA lobby that way auto-started the match; a single disconnect then
//      freed only ws.seat and left the rest `connected` behind a dead socket.
//      With no shot clock the turn eventually reached a ghost and the match
//      never advanced again. Reachable by accident, not just malice: joinBtn has
//      no debounce, and a push notification or ?room= link for the room you are
//      already in re-sends `join`.
import WebSocket from 'ws';
import { isGeneratedCallsign } from '../public/game-core.js';

const URL = process.env.WS || 'ws://localhost:3000/ws';
const out = { steps: [], errors: [] };
const step = (m) => { out.steps.push(m); console.log('  ok — ' + m); };
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const finish = () => {
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
  process.exit(out.errors.length ? 1 : 0);
};
setTimeout(() => { fail('timeout'); finish(); }, 90000);

const open = () => new Promise((res, rej) => {
  const ws = new WebSocket(URL);
  ws.on('open', () => res(ws));
  ws.on('error', rej);
});
const wait = (ws, type, ms = 8000) => new Promise((res) => {
  const t = setTimeout(() => res(null), ms);
  const on = (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== type) return;
    clearTimeout(t); ws.off('message', on); res(m);
  };
  ws.on('message', on);
});
const send = (ws, m) => ws.send(JSON.stringify(m));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 1. One socket cannot hoard rooms ---------------------------------------
async function roomHoarding() {
  const ws = await open();
  const codes = [];
  for (let i = 0; i < 5; i++) {
    send(ws, { type: 'create', name: 'Hoarder', skin: 'olive', mode: 'ffa', max: 4 });
    const m = await wait(ws, 'created');
    if (!m) { fail('room hoarding: no `created` reply'); ws.close(); return; }
    codes.push(m.code);
    await sleep(60);
  }
  const unique = [...new Set(codes)];
  if (unique.length !== 5) fail(`expected 5 distinct codes from 5 creates, got ${JSON.stringify(codes)}`);

  // The first four rooms must be GONE — each create releases the previous
  // waiting room. A second socket must not be able to join any of them.
  const probe = await open();
  let joinable = 0;
  for (const code of codes.slice(0, 4)) {
    send(probe, { type: 'join', code, name: 'Probe', skin: 'desert' });
    const err = await Promise.race([wait(probe, 'joinError', 2500), wait(probe, 'lobby', 2500), wait(probe, 'start', 2500)]);
    if (err && err.type !== 'joinError') joinable++;
    await sleep(60);
  }
  if (joinable > 0) fail(`${joinable}/4 abandoned rooms were still joinable — they leaked`);
  else step('room hoarding: 5 creates leave only the newest room alive (4 released)');

  // The newest room must still work.
  send(probe, { type: 'join', code: codes[4], name: 'Probe', skin: 'desert' });
  const good = await Promise.race([wait(probe, 'lobby', 4000), wait(probe, 'start', 4000)]);
  if (!good) fail('the most recent room should still be joinable, but was not');
  else step('room hoarding: the newest room is unaffected');

  try { ws.close(); probe.close(); } catch {}
}

// ---- 2. A malformed drive direction cannot corrupt tank state ---------------
async function nanDrive() {
  const ws = await open();
  send(ws, {
    type: 'ai', difficulty: 'easy', name: 'Driver', skin: 'olive',
    loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'],
  });
  const start = await wait(ws, 'start', 12000);
  if (!start) { fail('NaN drive: no start snapshot'); ws.close(); return; }
  const me = start.you;
  if (start.pick) {           // draft is open — lock in so the match can begin
    send(ws, { type: 'loadout', picks: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] });
    await wait(ws, 'pickDone', 8000);
  }
  // Wait for our turn.
  for (let i = 0; i < 20 && start.turn !== me; i++) {
    const t = await wait(ws, 'turn', 6000);
    if (t && t.turn === me) break;
  }
  const x0 = start.tanks[me].x;

  // Every one of these used to reach Math.sign() and yield NaN.
  const poison = ['abc', null, undefined, {}, [], NaN, Infinity, '1e999', 0];
  for (const dir of poison) { send(ws, { type: 'move', dir }); await sleep(45); }
  await sleep(400);

  // A legitimate move must still work, and must move a FINITE distance.
  send(ws, { type: 'move', dir: 1 });
  const mv = await wait(ws, 'move', 5000);
  if (!mv) {
    fail('NaN drive: a legitimate move after the poison attempts produced nothing (state may be corrupt)');
  } else if (!Number.isFinite(mv.x) || !Number.isFinite(mv.y) || !Number.isFinite(mv.fuel)) {
    fail(`NaN drive: move broadcast carries non-finite values x=${mv.x} y=${mv.y} fuel=${mv.fuel}`);
  } else if (mv.seat !== me) {
    fail(`NaN drive: move broadcast is for seat ${mv.seat}, expected ${me}`);
  } else {
    const drift = Math.abs(mv.x - x0);
    if (drift > 400) fail(`NaN drive: tank jumped ${Math.round(drift)}u — poison input moved it`);
    else step(`NaN drive: ${poison.length} malformed dirs rejected; position finite and intact (moved ${Math.round(drift)}u on a valid step)`);
  }
  try { ws.close(); } catch {}
}

// ---- 3. Oversized frames are rejected, not buffered -------------------------
async function frameCap() {
  const ws = await open();
  let closed = false;
  ws.on('close', () => { closed = true; });
  // 512 KB — comfortably past the 64 KB cap.
  send(ws, { type: 'create', name: 'X'.repeat(512 * 1024), skin: 'olive' });
  await sleep(1200);
  if (!closed) fail('frame cap: a 512 KB frame was accepted (maxPayload not enforced)');
  else step('frame cap: oversized frame closed the socket instead of being buffered');
  try { ws.close(); } catch {}
}

// ---- 4. ONE SHOT PER TURN ---------------------------------------------------
// room.turn is not reassigned when a shot resolves — the handover waits 300ms,
// then any burn (5s), and in golf the whole ball roll (30s). Every extra `fire`
// inside that window used to pass handleFire's guard and resolve again:
// measured 5 shots from 5 rapid messages, and the cannon has unlimited ammo.
async function oneShotPerTurn() {
  const ws = await open();
  send(ws, {
    type: 'ai', difficulty: 'easy', name: 'Rapid', skin: 'olive',
    loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'],
  });
  const start = await wait(ws, 'start', 12000);
  if (!start) { fail('one-shot: no start snapshot'); ws.close(); return; }
  const me = start.you;
  if (start.pick) {
    send(ws, { type: 'loadout', picks: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] });
    await wait(ws, 'pickDone', 8000);
  }
  if (start.turn !== me) {
    for (let i = 0; i < 12; i++) { const t = await wait(ws, 'turn', 8000); if (t && t.turn === me) break; }
  }

  let shots = 0;
  const count = (raw) => { const m = JSON.parse(raw); if (m.type === 'shot' && m.by === me) shots++; };
  ws.on('message', count);

  // Five fire messages back to back, all inside one turn.
  for (let i = 0; i < 5; i++) send(ws, { type: 'fire', weapon: 'cannon', angle: 45, power: 60 });
  await sleep(3500);
  ws.off('message', count);

  if (shots === 0) fail('one-shot: no shot resolved at all — the fire path may be broken');
  else if (shots > 1) fail(`one-shot: ${shots} shots resolved from 5 rapid fire messages in ONE turn (expected exactly 1)`);
  else step('one shot per turn: 5 rapid fire messages produced exactly 1 shot');
  try { ws.close(); } catch {}
}

// ---- 5. Message-rate limit --------------------------------------------------
// maxPayload caps frame SIZE; nothing capped frame COUNT. Legitimate play peaks
// near 40/s (drive ticks + aim relay), the limit is 60/s with a 120 burst.
//
// DO NOT assert on the close event here. Render's proxy holds a dead socket
// open for ~20s and reports 1006 rather than the server's code — measured at
// +20,884ms against production, which made an earlier version of this test
// fail remotely even though the limiter was working perfectly. Assert the
// server-side OUTCOME instead: a cut-off socket stops being answered. A
// `join` with a nonsense code is the ideal probe — it always draws a
// `joinError` reply and has no side effects.
async function rateLimit() {
  const probe = (ws, ms = 4000) => {
    send(ws, { type: 'join', code: 'ZZZZ', name: 'Probe', skin: 'olive' });
    return wait(ws, 'joinError', ms);
  };

  const ws = await open();
  if (!await probe(ws)) { fail('rate limit: baseline probe got no reply — cannot test'); try { ws.close(); } catch {} return; }
  for (let i = 0; i < 400; i++) send(ws, { type: 'ping', i });   // well past the 120 burst
  await sleep(1200);
  if (await probe(ws)) fail('rate limit: socket still answered after 400 rapid messages (no frequency cap)');
  else step('rate limit: flooding socket is cut off — server stops answering it');
  try { ws.close(); } catch {}

  // The limit must NOT punish normal play: a drive-rate burst stays answered.
  const ws2 = await open();
  for (let i = 0; i < 30; i++) { send(ws2, { type: 'ping', i }); await sleep(45); }
  if (!await probe(ws2)) fail('rate limit: a legitimate 22/s drive-rate burst was throttled');
  else step('rate limit: 30 messages at drive rate (45ms) stay fully answered');
  try { ws2.close(); } catch {}
}

// ---- 6. NO FREE-TEXT NAMES REACH OTHER PLAYERS (ISSUE-015) ------------------
// The readonly input in index.html stops honest players typing; it stops nobody
// else. This asserts the SERVER boundary: a client sending an arbitrary string
// must have it replaced with a rolled callsign, because that name is broadcast
// to every opponent and painted into the shared result card. If this regresses,
// the app carries user-generated content and Apple Guideline 1.2 requires
// report, block and a staffed contact — none of which exist.
async function noFreeTextNames() {
  const attempts = [
    'FOLLOW ME ON TIKTOK',        // advertising — the common real-world abuse
    'x  x',                       // shape of a callsign, words not on the list
    'Iron',                       // half a callsign
    'Iron  Ridge',                // right words, wrong spacing
    'iron ridge',                 // right words, wrong case
    'Iron Ridge Extra',           // right words, extra token
    '<img src=x onerror=alert(1)>',
    '',
  ];
  let clean = 0;
  for (const attempt of attempts) {
    const before = out.errors.length;
    const ws = await open();
    send(ws, { type: 'create', name: attempt, skin: 'olive', mode: 'duel' });
    const m = await wait(ws, 'lobby');
    const shown = m && m.players && m.players[0] && m.players[0].name;
    try { ws.close(); } catch {}
    if (!shown) { fail(`no name came back for ${JSON.stringify(attempt)}`); continue; }
    if (shown === attempt) { fail(`free-text name survived: ${JSON.stringify(attempt)}`); continue; }
    if (!isGeneratedCallsign(shown)) {
      fail(`replacement ${JSON.stringify(shown)} is not a callsign from the curated lists`);
    }
    if (out.errors.length === before) clean++;
  }
  // Only claim success for the ones that actually passed — a blanket "all
  // replaced" alongside individual FAIL lines is how a bad run reads as good.
  if (clean === attempts.length) step(`${attempts.length} free-text names all replaced with rolled callsigns`);
  else fail(`only ${clean}/${attempts.length} free-text names were replaced`);

  // Deterministic, not random: the same rejected input must yield the same
  // callsign, or a reconnecting player changes identity mid-match and a griefer
  // can reroll until they land on something they wanted.
  const seen = [];
  for (let i = 0; i < 2; i++) {
    const ws = await open();
    send(ws, { type: 'create', name: 'SAME BAD INPUT', skin: 'olive', mode: 'duel' });
    const m = await wait(ws, 'lobby');
    seen.push(m && m.players && m.players[0] && m.players[0].name);
    try { ws.close(); } catch {}
  }
  if (seen[0] && seen[0] === seen[1]) step(`replacement is deterministic ('${seen[0]}' twice)`);
  else fail(`replacement is not deterministic: ${seen.join(' vs ')}`);

  // A legitimate rolled callsign must survive untouched — the filter must not
  // rename players who did nothing wrong.
  const ws = await open();
  send(ws, { type: 'create', name: 'Iron Ridge', skin: 'olive', mode: 'duel' });
  const m = await wait(ws, 'lobby');
  const kept = m && m.players && m.players[0] && m.players[0].name;
  try { ws.close(); } catch {}
  if (kept === 'Iron Ridge') step('a valid rolled callsign is preserved exactly');
  else fail(`valid callsign 'Iron Ridge' was altered to ${JSON.stringify(kept)}`);
}

// ---- 7. HOSTILE IDENTITY TOKENS COST NOTHING BUT THE FEATURE (8.48) ---------
// 'hello' and 'pushSub' carry a Supabase access token the server verifies
// out-of-band. A garbage, giant, or non-string token must never crash the
// process, block the message loop, or interfere with the match — the sender
// just does not get persistent nudges. Verification is async, so this also
// guards against a malformed token wedging the socket's ordinary traffic.
async function hostileTokens() {
  const ws = await open();
  const nasty = [
    { type: 'hello' },                                    // no token at all
    { type: 'hello', token: null },
    { type: 'hello', token: 12345 },
    { type: 'hello', token: { evil: true } },
    { type: 'hello', token: 'x'.repeat(60000) },          // giant string
    { type: 'hello', token: 'a.b.c' },                    // JWT-shaped junk
  ];
  for (const m of nasty) send(ws, m);
  // The socket must still play a completely normal match afterwards.
  send(ws, { type: 'ai', difficulty: 'easy', name: 'Iron Ridge' });
  const started = await wait(ws, 'start', 10000);
  if (started) step('6 hostile hello tokens ignored; the socket still starts a match');
  else fail('socket could not start a match after hostile hello tokens');
  // pushSub with a junk token: the in-room ack must still arrive.
  send(ws, { type: 'pushSub', sub: { endpoint: 'https://example.com/push/x', keys: {} }, token: 'garbage' });
  const ok = await wait(ws, 'pushOk', 6000);
  if (ok) step('pushSub with a junk token still gets its in-room pushOk');
  else fail('pushSub with a junk token lost its pushOk ack');
  send(ws, { type: 'leave' });
  try { ws.close(); } catch {}
}

// ---- 8. THE SERVER MUST SURVIVE HOSTILE INPUT (8.61) ------------------------
// Two remotely-triggerable KILLS were live in production until this batch, both
// unauthenticated, both one request:
//   * `GET /%` — decodeURIComponent throws on a malformed escape, the throw
//     reached uncaughtException, and that handler shuts the process down.
//     `/a%00b.png` did the same via fs.
//   * a single WebSocket frame containing `null` — JSON.parse succeeds, so the
//     existing catch did not fire, and the engine read .type off null.
// Every live match died with the process. These assertions exist so no future
// edit can reopen either door.
async function survivesHostileInput() {
  const base = URL.replace(/^ws/, 'http').replace(/\/ws$/, '');
  const up = async () => {
    try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(3000) }); return r.ok; }
    catch { return false; }
  };
  if (!(await up())) { fail('server was not reachable before the hostile-input checks'); return; }

  const paths = ['/%', '/a%00b.png', '/%zz', '/%e0%a4%a', '/..%00/', '/%FF%FE'];
  for (const p of paths) {
    try { await fetch(base + p, { signal: AbortSignal.timeout(3000) }); } catch {}
  }
  if (await up()) step(`server survived ${paths.length} malformed URL paths`);
  else { fail(`server DIED on a malformed URL path — a single unauthenticated GET kills it`); return; }

  const frames = ['null', '5', '"str"', '[]', '{}', '{"type":"join","code":123}',
    '{"type":"resume","code":{}}', `{"type":"join","code":"${'A'.repeat(5000)}"}`,
    '{"type":null}', '{"type":{"a":1}}', '{"type":"fire","weapon":{},"angle":"x"}', '{"type":"move","dir":[]}'];
  for (const f of frames) {
    const ws = await open();
    await new Promise((res) => { ws.send(f); setTimeout(res, 120); });
    try { ws.close(); } catch {}
  }
  if (await up()) step(`server survived ${frames.length} hostile WebSocket frames`);
  else fail('server DIED on a hostile WebSocket frame — one anonymous frame kills it');
}


// ---- 4. One socket cannot hold more than one seat ---------------------------
// Regression for the 2026-08-18 ghost-seat defect. Reproduced before the fix:
// five joins from one socket took three seats in a 4-player lobby, auto-started
// the match, and left two seats marked `connected` behind a dead socket.
async function seatHoarding() {
  const host = await open();
  send(host, { type: 'create', name: 'Host', skin: 'olive', mode: 'ffa', max: 4 });
  const made = await wait(host, 'created', 6000);
  if (!made) { fail('seat hoarding: no room created'); try { host.close(); } catch {} return; }

  // Join once legitimately, then four more times exactly as a double-tapped
  // button or a duplicate deep-link would.
  const guest = await open();
  send(guest, { type: 'join', code: made.code, name: 'Guest', skin: 'desert' });
  const seated = await Promise.race([wait(guest, 'lobby', 5000), wait(guest, 'start', 5000)]);
  if (!seated) { fail('seat hoarding: the first legitimate join did not seat'); }

  let refusals = 0;
  for (let i = 0; i < 4; i++) {
    send(guest, { type: 'join', code: made.code, name: 'Guest', skin: 'desert' });
    const m = await Promise.race([wait(guest, 'joinError', 2500), wait(guest, 'start', 2500), wait(guest, 'lobby', 2500)]);
    if (m && m.type === 'joinError') refusals++;
    await sleep(60);
  }
  if (refusals !== 4) fail(`seat hoarding: expected 4 duplicate joins to be refused, got ${refusals}`);
  else step('seat hoarding: a socket already seated cannot take a second seat');

  // The decisive assertion: those repeat joins must not have filled the lobby
  // and started the match. A `start` here means the ghost-seat bug is back.
  const started = await Promise.race([wait(host, 'start', 1500), sleep(1600).then(() => null)]);
  if (started) fail('seat hoarding: repeat joins from ONE socket auto-started the match');
  else step('seat hoarding: a 4-seat lobby is not filled by one socket rejoining');

  // And a guest moving to another lobby must not destroy the host's room —
  // releasePriorRoom used to teardown() unconditionally, which only became
  // reachable by a guest once `join` started calling it.
  send(guest, { type: 'create', name: 'Guest', skin: 'desert', mode: 'ffa', max: 4 });
  const own = await wait(guest, 'created', 6000);
  if (!own) fail('seat hoarding: the guest could not create its own room');
  await sleep(150);
  const probe = await open();
  send(probe, { type: 'join', code: made.code, name: 'Probe', skin: 'desert' });
  const alive = await Promise.race([wait(probe, 'lobby', 4000), wait(probe, 'start', 4000), wait(probe, 'joinError', 4000)]);
  if (!alive || alive.type === 'joinError') fail("seat hoarding: a guest leaving DESTROYED the host's lobby");
  else step("seat hoarding: a guest moving to another room leaves the host's lobby intact");

  try { host.close(); guest.close(); probe.close(); } catch {}
}


// ---- 5. Abandoning a match must not strand the room ------------------------
// releasePriorRoom used to skip a room that was already 'playing', which also
// skipped clearing ws.roomCode — so the caller overwrote it and the old room was
// orphaned with a seat still flagged `connected` behind a socket that had moved
// on. The empty-room reaper is gated on no connected humans, so it never fired
// either. Measured before the fix: 8 vs-CPU games from ONE socket held 8 rooms,
// and closing that socket freed none. Permanent until process restart.
async function abandonedRooms() {
  const roomsNow = async () => {
    try {
      const r = await fetch(URL.replace(/^ws/, 'http').replace(/\/ws$/, '') + '/health');
      return (await r.json()).rooms;
    } catch { return null; }
  };
  const before = await roomsNow();
  if (before === null) { step('abandoned rooms: /health unreachable, skipped'); return; }

  const ws = await open();
  for (let i = 0; i < 6; i++) {
    send(ws, { type: 'ai', difficulty: 'easy', name: 'Abandoner', skin: 'olive',
      loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] });
    await wait(ws, 'start', 8000);
  }
  const after = await roomsNow();
  const leaked = after - before;
  // One live room is correct — the game currently in progress. Six is the bug.
  if (leaked > 2) fail(`abandoned rooms: 6 successive games from one socket left ${leaked} extra rooms (expected ~1) — they are orphaned`);
  else step(`abandoned rooms: 6 successive games leave ${leaked} room(s), not 6`);
  try { ws.close(); } catch {}
}

// ---- 6. A native push subscription is size-bounded too ---------------------
// The cap was added to the WEB branch only, leaving the native shape an open door
// to the same abuse: {platform:'android', token:<unique>, junk:<60KB>} wrote
// unbounded rows, and because `endpoint` is UNIQUE a varying token INSERTs rather
// than upserts. The test written alongside that change only sent web shapes.
async function pushSubBounds() {
  const ws = await open();
  send(ws, { type: 'ai', difficulty: 'easy', name: 'Pusher', skin: 'olive',
    loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] });
  if (!await wait(ws, 'start', 12000)) { fail('pushSub bounds: no start'); try { ws.close(); } catch {} return; }

  send(ws, { type: 'pushSub', sub: { platform: 'android', token: 'T'.repeat(120), junk: 'x'.repeat(60000) } });
  const bloated = await wait(ws, 'pushOk', 2000);
  if (bloated) fail('pushSub bounds: a 60KB NATIVE subscription was accepted');
  else step('pushSub bounds: an oversized native subscription is refused');

  send(ws, { type: 'pushSub', sub: { platform: 'android', token: 'T'.repeat(140) } });
  const real = await wait(ws, 'pushOk', 3000);
  if (!real) fail('pushSub bounds: a REAL native subscription was rejected');
  else step('pushSub bounds: a realistic native subscription is still accepted');
  try { ws.close(); } catch {}
}

(async () => {
  try {
    await roomHoarding();
    await nanDrive();
    await frameCap();
    await oneShotPerTurn();
    await rateLimit();
    await noFreeTextNames();
    await hostileTokens();
    await survivesHostileInput();
    await seatHoarding();
    await abandonedRooms();
    await pushSubBounds();
  } catch (e) {
    fail('threw: ' + (e && e.message ? e.message : String(e)));
  }
  finish();
})();
