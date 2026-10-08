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
//   9. Seat hoarding — `join` checked room state and fullness but never whether
//      the socket ALREADY held a seat, so one socket could take several. Filling
//      an FFA lobby that way auto-started the match; a single disconnect then
//      freed only ws.seat and left the rest `connected` behind a dead socket.
//      With no shot clock the turn eventually reached a ghost and the match
//      never advanced again. Reachable by accident, not just malice: joinBtn has
//      no debounce, and a push notification or ?room= link for the room you are
//      already in re-sends `join`.
import WebSocket from 'ws';
import { isGeneratedCallsign } from '../public/game-core.js';
// Section 6 needs the engine in process as well as over the wire: the one name
// that may pass is hung on the SOCKET by server.js after a Supabase token
// verifies, and a local test run has no Supabase and no account. Importing the
// engine here gives a second, independent `rooms` Map with no listeners and no
// timers, which the section tears down when it is done.
import { handleClientMessage, setNameCheck } from '../public/room-engine.js';
// The guidelines a typed name must meet, built the way server.js builds them,
// so section 6 can install the server's own check on the in-process engine.
import { createNameProofs } from '../server/display-name.js';
// ...and the two lists, to build section 6's profanity fixture at RUN TIME
// instead of spelling a slur in this file. The fixture has to be a term the
// ENGINE refuses and server/blocklist.txt does NOT, because that is exactly
// the name the server would store and only the engine's own check keeps off
// the board. Deriving it means the check cannot go stale when either list
// moves — and if the lists ever fully agree, it says so and skips rather than
// quietly asserting nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateCallsign, loadBlocklist } from '../server/callsign.js';

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

// ---- 6. A TYPED NAME REACHES A LOBBY ONLY THROUGH THE GUIDELINES (ISSUE-015) --
// The SERVER is the boundary on a name, because that name is broadcast to every
// opponent and painted into the shared result card, and a modified client can
// send any string it likes.
//
// WHAT THE BOUNDARY ADMITS CHANGED ON 2026-10-07, and this section changed with
// it. The owner: "the player is given a default name and then they can change
// it to whatever they like, as long as it stays within the guidelines" — so a
// typed name is no longer replaced for being typed. This section USED TO assert
// that every free-text name over the wire came back as a rolled pair ('Iron',
// 'iron ridge' and 'Iron Ridge Extra' among them) and that a verified socket
// could present no string but its own stored one. Both pinned the old rule and
// are replaced here by the new one. What holds now:
//   * over the wire, a name INSIDE the guidelines — 3-16 letters, digits and
//     single spaces, nothing on server/blocklist.txt, nothing the engine's own
//     isProfane refuses — is shown in the SERVER's normalised form, never the
//     client's copy;
//   * a name OUTSIDE them is still replaced with a rolled pair, and the same
//     input always yields the same pair;
//   * the door is the HOST's: the engine alone (the offline page, imported
//     here in process with no check installed) still replaces every typed
//     name, and a check that throws or answers nonsense opens nothing;
//   * the chosen-callsign exemption is unchanged, still not claimable from the
//     wire, and still not exempt from isProfane.
async function noFreeTextNames() {
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const terms = loadBlocklist(path.join(ROOT, 'server', 'blocklist.txt'));
  // The engine's own lists, read out of public/game-core.js to build fixtures
  // at RUN TIME instead of spelling a slur in this file. game-core.js, not
  // room-engine.js: the profanity lists moved there when server/social.js
  // started applying the same test to a name in a friends panel, so the engine
  // and the social layer share ONE copy.
  const engineSrc = readFileSync(path.join(ROOT, 'public', 'game-core.js'), 'utf8');
  const listOf = (n) => [...(((engineSrc.match(new RegExp(`const ${n} = \\[([\\s\\S]*?)\\];`)) || [])[1]) || '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const badSub = listOf('BAD_SUB'), badWord = listOf('BAD_WORD');
  if (!badSub.length || !badWord.length) fail('could not read BAD_SUB / BAD_WORD out of public/game-core.js — the fixtures below prove nothing');
  // The 'Xxxx Ridge' shape is the one a player actually types. GAP: the engine
  // refuses it and the shipped blocklist does not — the names only isProfane
  // keeps off the board. LISTED: the shipped blocklist refuses it.
  const shape = (t) => `${t[0].toUpperCase()}${t.slice(1)} Ridge`;
  const shapes = [...badSub, ...badWord].map(shape).filter((n) => [...n].length <= 16);
  const gap = shapes.filter((n) => validateCallsign(n, terms).ok === true);
  const listed = terms.map(shape).find((n) => [...n].length <= 16);
  const lobbyName = async (name) => {
    const ws = await open();
    send(ws, { type: 'create', name, skin: 'olive', mode: 'duel' });
    const m = await wait(ws, 'lobby');
    try { ws.close(); } catch {}
    return m && m.players && m.players[0] && m.players[0].name;
  };

  // a. OUTSIDE THE GUIDELINES: replaced with a curated pair, over the wire.
  //    No term is ever printed: a refused fixture is named by its kind.
  const refused = [
    ['FOLLOW ME ON TIKTOK', 'too long'],          // advertising — the common real-world abuse, and 19 characters
    ['<img src=x onerror=alert(1)>', 'markup'],
    ['', 'empty'],
    ['Io', 'too short'],
    ['Iron!', 'punctuation'],
    ['follow.me/x', 'a link'],
  ];
  if (listed) refused.push([listed, 'a term on the shipped blocklist']);
  else fail('no shipped blocklist term fits the "<term> Ridge" shape — the blocklist half of the door is untested');
  if (gap.length) refused.push([gap[0], 'a term only the engine refuses']);
  let clean = 0;
  for (const [attempt, why] of refused) {
    const shown = await lobbyName(attempt);
    if (!shown) { fail(`no name came back for ${why}`); continue; }
    if (shown === attempt || !isGeneratedCallsign(shown)) { fail(`a name outside the guidelines (${why}) came back as ${shown === attempt ? 'itself' : 'something that is not a curated pair'}`); continue; }
    clean++;
  }
  // Only claim success for the ones that actually passed — a blanket "all
  // replaced" alongside individual FAIL lines is how a bad run reads as good.
  if (clean === refused.length) step(`${refused.length} names outside the guidelines (length, markup, punctuation, a link, the shipped blocklist, the engine's own list) all replaced with rolled callsigns`);
  else fail(`only ${clean}/${refused.length} names outside the guidelines were replaced`);

  // EVERY engine-only term, not one: the door must never show a name the
  // engine's own filter would refuse, whatever the shipped list is missing.
  let leakedGap = 0;
  for (const dirty of gap.slice(1)) { const got = await lobbyName(dirty); if (got === dirty || !got || !isGeneratedCallsign(got)) leakedGap++; }
  if (!leakedGap) step(`all ${gap.length} engine-only term(s) the shipped blocklist lets through are replaced at the door over the wire`);
  else fail(`${leakedGap} engine-only term(s) reached a lobby verbatim`);

  // b. INSIDE THE GUIDELINES: shown, in the SERVER's normalised form.
  const kept = [
    ['Iron', 'Iron'],                             // half a callsign is now just a short name
    ['iron ridge', 'iron ridge'],                 // case is the player's to choose
    ['Iron Ridge Extra', 'Iron Ridge Extra'],     // 16 characters, the most there may be
    ['  Tank   Ace ', 'Tank Ace'],                // trimmed and collapsed: the server's string, not the client's
    ['x  x', 'x x'],
  ];
  let shownOk = 0;
  for (const [attempt, want] of kept) {
    const shown = await lobbyName(attempt);
    if (shown === want) shownOk++;
    else fail(`a name inside the guidelines ${JSON.stringify(attempt)} came back as ${JSON.stringify(shown)} (want ${JSON.stringify(want)})`);
  }
  if (shownOk === kept.length) step(`${kept.length} names inside the guidelines are shown over the wire, normalised by the server`);

  // c. Deterministic, not random: the same rejected input must yield the same
  //    callsign, or a reconnecting player changes identity mid-match and a
  //    griefer can reroll until they land on something they wanted.
  const seen = [await lobbyName('SAME BAD INPUT!'), await lobbyName('SAME BAD INPUT!')];
  if (seen[0] && seen[0] === seen[1] && isGeneratedCallsign(seen[0])) step(`replacement is deterministic ('${seen[0]}' twice)`);
  else fail(`replacement is not deterministic: ${seen.join(' vs ')}`);

  // d. A legitimate rolled callsign must survive untouched — the filter must
  //    not rename players who did nothing wrong.
  const rolled = await lobbyName('Iron Ridge');
  if (rolled === 'Iron Ridge') step('a valid rolled callsign is preserved exactly');
  else fail(`valid callsign 'Iron Ridge' was altered to ${JSON.stringify(rolled)}`);

  // e. THE ENGINE ALONE KEEPS THE DOOR SHUT. In process, this engine has no
  //    name check installed — which is exactly the offline page, whose only
  //    player is the one on the device. Every typed name is replaced, a
  //    verified socket included; only its ONE stored name passes.
  const CHOSEN = 'Marguerite Vale';
  const mkLocal = (chosen = CHOSEN) => ({ readyState: 1, chosenName: chosen, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });
  const nameIn = (w) => {
    const lobby = w._rx.find((m) => m.type === 'lobby');
    return lobby && lobby.players && lobby.players[0] && lobby.players[0].name;
  };
  const leave = (...ws) => { for (const w of ws) { try { handleClientMessage(w, { type: 'leave' }); } catch {} } };
  const mine = mkLocal();
  handleClientMessage(mine, { type: 'create', name: CHOSEN, skin: 'olive', mode: 'duel' });
  if (nameIn(mine) === CHOSEN) step(`a server-verified chosen callsign is presented verbatim ('${CHOSEN}')`);
  else fail(`a server-verified chosen callsign was replaced with ${JSON.stringify(nameIn(mine))}`);
  const other = mkLocal();
  handleClientMessage(other, { type: 'create', name: 'Someone Else Entirely', skin: 'olive', mode: 'duel' });
  const second = nameIn(other);
  if (second && second !== 'Someone Else Entirely' && isGeneratedCallsign(second))
    step('with no name check installed (the offline page) a verified socket still may not present any OTHER typed name');
  else fail(`a typed name passed an engine with no name check: ${JSON.stringify(second)}`);
  const guest = { readyState: 1, userId: 'anon-uuid', isGuest: true, chosenName: null, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } };
  handleClientMessage(guest, { type: 'create', name: CHOSEN, skin: 'olive', mode: 'duel' });
  const guestName = nameIn(guest);
  if (guestName && guestName !== CHOSEN && isGeneratedCallsign(guestName))
    step('with no name check installed a guest socket gets a typed name replaced like anyone else');
  else fail(`a guest presented a typed name to an engine with no name check: ${JSON.stringify(guestName)}`);
  leave(mine, other, guest);

  // f. AND THE EXEMPTION IS NOT EXEMPT FROM THE PROFANITY FILTER. sanitizeName
  //    used to return `allowed` BEFORE isProfane() ran, which made the one
  //    player-AUTHORED string in the product the only string exempt from the
  //    product's own check. A stored chosen name carrying an engine-only term
  //    (the gap above) is the name the server stores happily, and THIS is what
  //    stops it reaching a lobby. Every term, not a sample.
  const leaked = [];
  for (const dirty of gap) {
    const w = mkLocal(dirty);
    handleClientMessage(w, { type: 'create', name: dirty, skin: 'olive', mode: 'duel' });
    const got = nameIn(w);
    leave(w);
    if (got === dirty || !got || !isGeneratedCallsign(got)) leaked.push(dirty);
  }
  if (!leaked.length) {
    step(`${shapes.length} engine term(s) in the typed-name shape: ${shapes.length - gap.length}`
      + ` refused by the server filter before storage, ${gap.length} stored but replaced at the door`
      + ' by isProfane — none reaches a lobby');
  } else {
    fail(`${leaked.length} of ${gap.length} stored chosen callsign(s) carrying an engine term`
      + ' were presented VERBATIM — the exemption is returning before isProfane');
  }

  // g. THE DOOR IS THE HOST'S CHECK, and only a string from it opens it.
  //    Installed here exactly as server.js installs it, then taken away again.
  //    CHANGED (round 2, 2026-10-08): server.js now passes `keyState`, the
  //    name index's answer to "is this some account's chosen callsign?". This
  //    suite's server has no Supabase, where server.js answers 'free' for
  //    every key, so the check is installed with that answer. With no
  //    keyState at all the default is 'unknown', and the door refuses every
  //    typed name rather than guess (the second half below). A computer's
  //    name ('CPU 2') is replaced either way.
  try {
    setNameCheck(createNameProofs({ terms, keyState: () => 'free' }).playerName);
    const w1 = mkLocal(null);
    handleClientMessage(w1, { type: 'create', name: '  Tank   Ace ', skin: 'olive', mode: 'duel' });
    const w2 = mkLocal(null);
    handleClientMessage(w2, { type: 'create', name: 'Iron!', skin: 'olive', mode: 'duel' });
    const w2b = mkLocal(null);
    handleClientMessage(w2b, { type: 'create', name: 'CPU 2', skin: 'olive', mode: 'duel' });
    if (nameIn(w1) === 'Tank Ace' && nameIn(w2) !== 'Iron!' && isGeneratedCallsign(nameIn(w2)) && isGeneratedCallsign(nameIn(w2b)))
      step('with server.js\'s check installed in process, a good typed name is shown normalised, and a bad one and a computer\'s name are replaced');
    else fail(`installed check: ${JSON.stringify([nameIn(w1), nameIn(w2), nameIn(w2b)])}`);
    leave(w1, w2, w2b);
    setNameCheck(createNameProofs({ terms }).playerName);
    const w1b = mkLocal(null);
    handleClientMessage(w1b, { type: 'create', name: 'Tank Ace', skin: 'olive', mode: 'duel' });
    if (nameIn(w1b) !== 'Tank Ace' && isGeneratedCallsign(nameIn(w1b)))
      step('with no name index to ask (keyState left out), the check refuses even a good typed name: the default name is shown');
    else fail(`unknown keyState opened the door: ${JSON.stringify(nameIn(w1b))}`);
    leave(w1b);
    // A check that says yes to a name isProfane refuses is overruled at the
    // door: this file's own lists stand behind every door.
    setNameCheck((raw) => String(raw));
    const w3 = mkLocal(null);
    const dirty = gap[0] || 'Iron Ridge';
    handleClientMessage(w3, { type: 'create', name: dirty, skin: 'olive', mode: 'duel' });
    if (!gap.length || (nameIn(w3) !== dirty && isGeneratedCallsign(nameIn(w3))))
      step('a host check that passes an engine-only term is overruled by isProfane at the door');
    else fail('a host check passed an engine-only term into a lobby');
    leave(w3);
    // A check that throws, or answers anything but a non-empty string, opens
    // nothing: the name falls through to the deterministic fallback.
    let opened = 0;
    for (const bad of [() => { throw new Error('boom'); }, () => '', () => 7, () => ({ toString: () => 'Tank Ace' }), () => true]) {
      setNameCheck(bad);
      const w = mkLocal(null);
      handleClientMessage(w, { type: 'create', name: 'Tank Ace', skin: 'olive', mode: 'duel' });
      if (nameIn(w) === 'Tank Ace' || !isGeneratedCallsign(nameIn(w))) opened++;
      leave(w);
    }
    if (!opened) step('a check that throws or answers anything but a non-empty string opens nothing');
    else fail(`${opened} broken check(s) opened the door`);
  } finally {
    setNameCheck(null);
  }

  // h. The exemption is not claimable from the wire. This socket has no
  //    account, and says so in the frame as loudly as it likes. The name it
  //    claims is one ONLY the exemption could admit — it fails the guidelines —
  //    so the server's door cannot let it through for the other reason.
  const CLAIMED = 'Marguerite.Vale';
  const liar = await open();
  send(liar, { type: 'create', name: CLAIMED, skin: 'olive', mode: 'duel', chosenName: CLAIMED, userId: 'u1' });
  const lm = await wait(liar, 'lobby');
  const claimed = lm && lm.players && lm.players[0] && lm.players[0].name;
  try { liar.close(); } catch {}
  if (claimed && claimed !== CLAIMED && isGeneratedCallsign(claimed))
    step('a client cannot claim a chosen callsign in the frame — a name only the exemption could admit is replaced');
  else fail(`a client-claimed chosenName survived: ${JSON.stringify(claimed)}`);
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


// ---- 9. One socket cannot hold more than one seat ---------------------------
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

  // Watch for `start` from BEFORE the loop. `wait()` attaches its listener at call
  // time and keeps no backlog, so asking afterwards cannot see a `start` emitted
  // DURING the loop — which is exactly when the bug would fire. The assertion
  // below called itself decisive while looking in the wrong direction in time.
  let sawStart = false;
  const startWatch = (raw) => { try { if (JSON.parse(raw).type === 'start') sawStart = true; } catch {} };
  host.on('message', startWatch);
  guest.on('message', startWatch);

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
  await sleep(400);
  host.off('message', startWatch); guest.off('message', startWatch);
  if (sawStart) fail('seat hoarding: repeat joins from ONE socket auto-started the match');
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
  // Distinguish the two reasons a probe cannot join. "That game is full" or
  // "already started" means the lobby is ALIVE — the opposite of what this
  // assertion tests — and reporting that as "the host's lobby was DESTROYED"
  // points the reader at the wrong subsystem entirely.
  const gone = alive && alive.type === 'joinError'
    && /no game with that code/i.test(alive.reason || '');
  if (!alive) fail("seat hoarding: no reply at all when probing the host's lobby");
  else if (gone) fail("seat hoarding: a guest leaving DESTROYED the host's lobby");
  else step("seat hoarding: a guest moving to another room leaves the host's lobby intact");

  try { host.close(); guest.close(); probe.close(); } catch {}
}


// ---- 10. Abandoning a match must not strand the room -----------------------
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
  // An UNMEASURABLE run must be RED, not green. roomsNow() returns null on any
  // failure — including a 200 whose body is not JSON, which is exactly what a
  // WAF, CDN or proxy error page returns — and this used to call step(), which
  // prints "ok —" and never touches the error list. Verified: with the historical
  // room-orphan bug live and /health serving an HTML body, the suite reported ALL
  // GOOD and exited 0. This test is explicitly built to run against production
  // via --remote, which is precisely where such a body is served.
  const before = await roomsNow();
  if (typeof before !== 'number') {
    fail('abandoned rooms: /health did not return JSON — cannot measure, so this is NOT a pass');
    return;
  }

  const ws = await open();
  for (let i = 0; i < 6; i++) {
    send(ws, { type: 'ai', difficulty: 'easy', name: 'Abandoner', skin: 'olive',
      loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] });
    await wait(ws, 'start', 8000);
  }
  const after = await roomsNow();
  if (typeof after !== 'number') {
    fail('abandoned rooms: /health stopped returning JSON mid-test — cannot measure');
    try { ws.close(); } catch {}
    return;
  }
  const leaked = after - before;
  // One live room is correct — the game currently in progress. Six is the bug.
  if (leaked > 2) fail(`abandoned rooms: 6 successive games from one socket left ${leaked} extra rooms (expected ~1) — they are orphaned`);
  else step(`abandoned rooms: 6 successive games leave ${leaked} room(s), not 6`);
  try { ws.close(); } catch {}
}

// ---- 11. A native push subscription is size-bounded too --------------------
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


// ---- 12. The aim relay is not a free-text channel ---------------------------
// `angle` is clamped and `power` is clamped, and between them `weapon` was
// forwarded verbatim — the only field on this wire that was neither validated nor
// bounded. Two modified clients could pass arbitrary strings through it, against
// privacy.html's promise of "No chat, no messages, and no message field of any
// kind" (:152).
//
// THE JUSTIFICATION CHANGED ON 2026-09-21 AND THE RULE GOT STRONGER, NOT WEAKER.
// This comment used to cite a promise of "no free-text input", which was true
// when ISSUE-015 removed the typed callsign field. That promise is GONE from
// privacy.html — this project gives players a typed name back — so citing it
// would have been citing a sentence that no longer exists. What replaced it
// matters more: a callsign is typed, but it passes a blocklist, a character
// class and a daily limit, and it can be reported and blocked from any screen
// that shows it. A string smuggled through `weapon` passes none of that and can
// be reported by nobody. The one text channel players have is moderated; this
// test exists so it stays the only one.
// Measured before the fix: a 60-character sentence arrived at the opponent intact.
async function aimRelay() {
  const host = await open();
  send(host, { type: 'create', name: 'AimHost', skin: 'olive', mode: 'duel' });
  const made = await wait(host, 'created', 6000);
  if (!made) { fail('aim relay: no room'); try { host.close(); } catch {} return; }
  const guest = await open();
  send(guest, { type: 'join', code: made.code, name: 'AimGuest', skin: 'desert' });
  if (!await wait(host, 'start', 8000)) { fail('aim relay: match never started'); }

  const PAYLOAD = 'free text that should never reach another player';
  send(guest, { type: 'aim', angle: 45, power: 60, weapon: PAYLOAD });
  const leaked = await wait(host, 'aim', 3000);
  if (leaked && leaked.weapon === PAYLOAD) fail('aim relay: arbitrary text reached the opponent');
  else step('aim relay: an unknown weapon id is not forwarded');

  // NAMES THE WEAPON TABLE INHERITS ARE NOT WEAPONS. WEAPON_BY_ID is a plain
  // object, so a bare lookup finds Object.prototype's members: measured before
  // the fix, twelve such words were relayed verbatim to the other seats, a
  // vocabulary outside the weapon ids. Each must arrive as null.
  const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];
  const inherited = [];
  for (const name of INHERITED) {
    send(guest, { type: 'aim', angle: 45, power: 60, weapon: name });
    const got = await wait(host, 'aim', 3000);
    if (!got || got.weapon !== null) inherited.push([name, got && got.weapon]);
  }
  if (inherited.length) fail('aim relay: a name the weapon table inherits was relayed: ' + JSON.stringify(inherited));
  else step('aim relay: a name the weapon table only inherits (constructor, toString, __proto__ ...) relays as null');

  send(guest, { type: 'aim', angle: 40, power: 55, weapon: 'cannon' });
  const real = await wait(host, 'aim', 3000);
  if (!real || real.weapon !== 'cannon') fail('aim relay: a REAL weapon stopped relaying');
  else step('aim relay: a real weapon still relays');
  try { host.close(); guest.close(); } catch {}
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
    await aimRelay();
  } catch (e) {
    fail('threw: ' + (e && e.message ? e.message : String(e)));
  }
  finish();
})();
