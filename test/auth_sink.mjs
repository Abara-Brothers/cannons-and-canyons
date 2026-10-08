// The AUTH SINK, driven end to end (server.js setAuthSink).
//
// WHY THIS FILE EXISTS. `ws.chosenName` is the one string a player authors that
// every opponent sees and that is painted into the shared result card. Two
// tests already cover the DOOR it goes through — test/security.mjs section 6
// sets chosenName on a fake socket and asserts the engine presents it — but
// nothing covered the sink that FILLS it, and that is where the hole was:
//
//   `callsign_key` is server-only and the migration revokes it from
//   `authenticated`. `callsign` is NOT. The same migration grants
//   `update (id, callsign, progression, progression_version)` because
//   public/cloud.js save() writes the rolled name on every cloud save, and the
//   column's only constraint is a length check with no content rule. So an
//   account that has ever set one legitimate callsign carries a non-null key
//   for ever, and could then PATCH its OWN row's `callsign` to any sixteen
//   characters and reconnect. A sink that trusts the string because a key
//   exists beside it hands that straight to the engine — with no socket frame
//   sent, so the blocklist, the character class, the once-a-day gate and the
//   3/min bucket are every one of them bypassed.
//
// The fix is that the key is the PROOF: server/callsign.js validateCallsign
// returns key = normaliseCallsign(name).toLowerCase(), so a name the server
// stored still normalises to the key beside it and a substituted one does not.
//
// This suite proves it against the REAL sink, in the real server process, with
// a mock GoTrue and a mock PostgREST — because in process there is no sink to
// call: setAuthSink's callback is a closure inside server.js and the only way
// to reach it is a `hello` frame on a real socket. What it asserts is the
// OBSERVABLE consequence: the name the next player sees in the lobby.
//
// SELF-HOSTED, like shutdown.mjs and push_persist.mjs: it spawns its own server
// on its own port with SUPABASE_* pointed at the mock. It must never be aimed
// at a shared or a deployed server, so it ignores $WS.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { isGeneratedCallsign } from '../public/game-core.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
let child = null, mock = null;
const finish = () => {
  try { if (child && child.exitCode === null) child.kill('SIGKILL'); } catch {}
  try { if (mock) mock.close(); } catch {}
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
  process.exit(out.errors.length ? 1 : 0);
};
setTimeout(() => { fail('timeout'); finish(); }, 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- The two profile rows ----------------------------------------------------
// HONEST: written by this server, so the display form still normalises to the
// key beside it. TAMPERED: the same key, with the display string swapped for
// something the server never validated — the exact row the attack produces.
const HONEST_ID = '11111111-1111-4111-8111-111111111111';
const TAMPER_ID = '22222222-2222-4222-8222-222222222222';
const SLOW_ID = '33333333-3333-4333-8333-333333333333';
const ODD_ID = '66666666-6666-4666-8666-666666666666';
const HONEST = 'Marguerite Vale';
const KEY = 'marguerite vale';
const SLOW = 'Wren Delacroix';
// 14 chars, inside the 16 the column allows — AND OUTSIDE THE GUIDELINES. Since
// 2026-10-07 any player may present a name of their own that passes the room
// engine's name check (the owner: "change it to whatever they like, as long as
// it stays within the guidelines"), so a tampered string that PASSED them would
// reach the lobby by that door whatever the sink did, and case 1 would prove
// nothing. It was 'FOLLOW ME ON X', which passes them now. The attack this file
// exists for is "any sixteen characters" in a column the account writes, and a
// link is the shape it takes: the check refuses the full stop, so only a sink
// that trusts the column can put this string on a board.
const TAMPERED = 'GO TO EVIL.COM';
// A STORED CHOSEN NAME ONLY THE EXEMPTION CAN ADMIT, for the two cases that
// must see ws.chosenName itself (2 and 5). HONEST passes the guidelines, so
// presenting it now succeeds through the name check whether or not the sink
// filled ws.chosenName — a sink that always answered null would sail through.
// ODD normalises to its own key exactly as HONEST does, and is refused by the
// guidelines (the full stop), so the lobby can show it by one door alone. It is
// the shape a chosen name takes when a term is added to the blocklist after it
// was stored, spelled here with a full stop rather than with a slur.
const ODD = 'Mme.Vale';
const ROWS = {
  [HONEST_ID]: { id: HONEST_ID, callsign: HONEST, friend_code: 'ABC234', callsign_key: KEY, callsign_set_at: null },
  // callsign and callsign_key DISAGREE. This is the whole test.
  [TAMPER_ID]: { id: TAMPER_ID, callsign: TAMPERED, friend_code: 'ABC235', callsign_key: KEY, callsign_set_at: null },
  // A second honest account, reached only through the DELAYED token below —
  // the one whose verification is still in flight when the next frame lands.
  [SLOW_ID]: { id: SLOW_ID, callsign: SLOW, friend_code: 'ABC236', callsign_key: SLOW.toLowerCase(), callsign_set_at: null },
  [ODD_ID]: { id: ODD_ID, callsign: ODD, friend_code: 'ABC237', callsign_key: ODD.toLowerCase(), callsign_set_at: null },
};
// A REAL ANONYMOUS ACCOUNT — what public/cloud.js mints for every player who
// saves anything. It carries a perfectly good uuid, so it is the case a gate
// written as `if (!ws.userId)` waves straight through. Case 8 drives report and
// block on it END TO END, through the real socket, the real interception seam
// and the real store, because a test that calls the handler directly can pass
// while the path that reaches it is broken.
const GUEST_ID = '44444444-4444-4444-8444-444444444444';
// An account section 10 deletes. Only its sockets may change when it goes.
const DOOMED_ID = '55555555-5555-4555-8555-555555555555';
// A SECOND ANONYMOUS ACCOUNT, with a profile row but no name (case 11): the
// target of a report against a guest's typed name, which only the seat proves.
const NAMELESS_ID = '77777777-7777-4777-8777-777777777777';
ROWS[NAMELESS_ID] = { id: NAMELESS_ID, callsign: null, friend_code: 'ABC238', callsign_key: null, callsign_set_at: null };
// A GREEK KEY WHOSE COLUMN WAS PATCHED TO A MIXTURE OF CAPITALS (case 2b,
// round 2 fix). The key is eta upsilon epsilon nu alpha; the column lower-
// cases onto it, so the old proof believed it, but its capitals read 'huena',
// none of the key's own readings. Code points, because as glyphs the two
// strings read as Latin words on the page.
const GREEK_ID = '88888888-8888-4888-8888-888888888888';
const GREEK_KEY = String.fromCodePoint(0x03B7, 0x03C5, 0x03B5, 0x03BD, 0x03B1);
const GREEK_MIXED = String.fromCodePoint(0x0397, 0x03C5, 0x0395, 0x039D, 0x03B1);
ROWS[GREEK_ID] = { id: GREEK_ID, callsign: GREEK_MIXED, friend_code: 'ABC239', callsign_key: GREEK_KEY, callsign_set_at: null };
const TOKENS = { 'tok-honest': HONEST_ID, 'tok-tampered': TAMPER_ID, 'tok-slow': SLOW_ID, 'tok-slower': HONEST_ID, 'tok-guest': GUEST_ID, 'tok-doomed': DOOMED_ID, 'tok-odd': ODD_ID, 'tok-anon2': NAMELESS_ID, 'tok-greek': GREEK_ID };
const ANON = new Set(['tok-guest', 'tok-anon2']);
// How long the mock GoTrue sits on each delayed token before answering. Long
// enough that a sign-out, or a second hello, is comfortably ahead of it — and
// two different delays, so an OLDER verification can settle while a NEWER one
// is still in flight (case 6).
const SLOW_MS = 600, SLOWER_MS = 1600;
const DELAY = { 'tok-slow': SLOW_MS, 'tok-slower': SLOWER_MS };

// ---- Mock Supabase -----------------------------------------------------------
const MOCK_PORT = 9931, GAME_PORT = 3106;
const profileHits = [];
const indexReads = [];
const reportPosts = [], blockPosts = [];
// The blocks this mock is actually holding, as `blocker>blocked`. POST adds,
// DELETE removes and the two GETs read it, so case 8 can block, list and unblock
// against something that remembers.
const blockRows = new Set();
// Every token GoTrue was asked about, in order (section 9 waits on these).
const verifiedTokens = [];
mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
    const json = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/auth/v1/health') return json(200, { name: 'GoTrue', version: 'mock' });
    if (u.pathname === '/auth/v1/user') {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      verifiedTokens.push(token);
      const id = TOKENS[token];
      if (!id) { res.writeHead(401); return res.end('{}'); }
      // Linked for every token but 'tok-guest'. is_anonymous is the field the
      // whole social layer gates on (BINDING.md resolution 1), and GoTrue
      // reports it on this same GET.
      const answer = () => json(200, { id, aud: 'authenticated', is_anonymous: ANON.has(token) });
      if (DELAY[token]) return void setTimeout(answer, DELAY[token]);
      return answer();
    }
    // What the moderation writes actually put on the wire. PostgREST answers a
    // return=minimal insert with 204 and no body, which is what the catch-all
    // below does; these two only record first.
    if (u.pathname === '/rest/v1/name_reports' && req.method === 'POST') {
      try { reportPosts.push(JSON.parse(body)); } catch { reportPosts.push({ unparseable: body }); }
      res.writeHead(204); return res.end();
    }
    if (u.pathname === '/rest/v1/blocks' && req.method === 'POST') {
      try { blockPosts.push(JSON.parse(body)); } catch { blockPosts.push({ unparseable: body }); }
      const row = blockPosts[blockPosts.length - 1];
      if (row && row.blocker && row.blocked) blockRows.add(row.blocker + '>' + row.blocked);
      res.writeHead(204); return res.end();
    }
    // A REAL LITTLE TABLE, not a write sink, because case 8 now reads its own
    // writes back: a guest blocks, LISTS what it blocked, and lifts it. A mock
    // that answered [] to every select would have let the list frame come back
    // empty and pass for the wrong reason.
    if (u.pathname === '/rest/v1/blocks' && req.method === 'GET') {
      const mine = (u.searchParams.get('blocker') || '').replace(/^eq\./, '');
      const theirs = (u.searchParams.get('blocked') || '').replace(/^eq\./, '');
      const out = [];
      for (const k of blockRows) {
        const [a, b] = k.split('>');
        if (mine && a === mine) out.push({ blocked: b });
        else if (theirs && b === theirs) out.push({ blocker: a });
      }
      return json(200, out);
    }
    if (u.pathname === '/rest/v1/blocks' && req.method === 'DELETE') {
      const a = (u.searchParams.get('blocker') || '').replace(/^eq\./, '');
      const b = (u.searchParams.get('blocked') || '').replace(/^eq\./, '');
      blockRows.delete(a + '>' + b);
      res.writeHead(204); return res.end();
    }
    // A SERVER POINTED AT /broken (case 11) gets a 500 for everything: its
    // name index can never load, which is the fail-closed world.
    if (u.pathname.startsWith('/broken/')) { res.writeHead(500); return res.end('{}'); }
    // THE NAME INDEX'S READ (round 2, server/name-index.js through
    // store.chosenCallsignKeys): every chosen key, in key order, a page past
    // `gt.` the last. Recorded so case 11 can see the shape on the wire.
    if (u.pathname === '/rest/v1/profiles' && req.method === 'GET' && u.searchParams.get('select') === 'callsign_key') {
      indexReads.push(u.search);
      const after = (u.searchParams.get('callsign_key') || '').replace(/^gt\./, '');
      const keys = [...new Set(Object.values(ROWS).map((r) => r.callsign_key).filter(Boolean))].sort();
      const from = /^gt\./.test(u.searchParams.get('callsign_key') || '') ? keys.filter((k) => k > after) : keys;
      return json(200, from.slice(0, Number(u.searchParams.get('limit')) || 1000).map((k) => ({ callsign_key: k })));
    }
    // A Set's write (case 11): return=representation, one row, nothing stored.
    if (u.pathname === '/rest/v1/profiles' && req.method === 'PATCH') {
      const id = (u.searchParams.get('id') || '').replace(/^eq\./, '');
      let b = {}; try { b = JSON.parse(body); } catch {}
      return json(200, [{ ...(ROWS[id] || { id }), ...b }]);
    }
    if (u.pathname === '/rest/v1/profiles' && req.method === 'GET') {
      const q = u.searchParams.get('id') || '';
      // profileById asks id=eq.<uuid>; profilesByIds asks id=in.(<uuid>,…). The
      // blocked list needs the second one, and answering [] to it would blank
      // every name in the list rather than fail it.
      const inList = /^in\.\((.*)\)$/.exec(q);
      if (inList) {
        const want = inList[1].split(',').map((s) => decodeURIComponent(s.trim())).filter(Boolean);
        for (const id of want) profileHits.push(id);
        return json(200, want.filter((id) => ROWS[id]).map((id) => ({ id, callsign: ROWS[id].callsign, callsign_key: ROWS[id].callsign_key })));
      }
      const eq = q.replace(/^eq\./, '');
      profileHits.push(eq);
      return json(200, ROWS[eq] ? [ROWS[eq]] : []);
    }
    // Everything else the server pokes at boot (readiness probes) answers empty.
    if (req.method === 'GET') return json(200, []);
    res.writeHead(204); res.end();
  });
});

// ---- One socket's worth of the flow -----------------------------------------
const open = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${GAME_PORT}/ws`);
  ws._rx = [];
  ws.on('message', (raw) => { try { ws._rx.push(JSON.parse(raw)); } catch {} });
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
});
const send = (ws, m) => ws.send(JSON.stringify(m));
// Case 11 also talks to a second server, on a port of its own.
const openAt = (port) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws._rx = [];
  ws.on('message', (raw) => { try { ws._rx.push(JSON.parse(raw)); } catch {} });
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
});
const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const waitId = (ws, id, ms = 8000) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    const m = ws._rx.find((x) => x.id === id);
    if (m) return resolve(m);
    if (Date.now() - t0 > ms) return resolve(null);
    setTimeout(tick, 20);
  };
  tick();
});
const wait = (ws, type, ms = 8000) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    const m = ws._rx.find((x) => x.type === type);
    if (m) return resolve(m);
    if (Date.now() - t0 > ms) return resolve(null);
    setTimeout(tick, 20);
  };
  tick();
});

// The name this socket is presented AS, after its account has been verified.
// The `friends` frame is the sync point: server.js makes every social frame
// wait on ws.authPending, so its reply cannot arrive until the sink — profile
// read included — has finished. Racing `create` against the hello instead
// would make this suite flaky in exactly the direction that hides a failure.
async function presentedName(token, typed) {
  const ws = await open();
  send(ws, { type: 'hello', token });
  send(ws, { type: 'friends', id: 1 });
  const gate = await wait(ws, 'friends');
  if (!gate) { try { ws.close(); } catch {} return { err: 'no reply to the friends frame — the hello never settled' }; }
  send(ws, { type: 'create', name: typed, skin: 'olive', mode: 'duel' });
  const lobby = await wait(ws, 'lobby');
  try { send(ws, { type: 'leave' }); } catch {}
  try { ws.close(); } catch {}
  if (!lobby) return { err: 'no lobby frame came back' };
  return { name: lobby.players && lobby.players[0] && lobby.players[0].name };
}

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(GAME_PORT),
      SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      SUPABASE_PUBLISHABLE_KEY: 'pk_test',
      SUPABASE_SECRET_KEY: 'sk_test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  for (let i = 0; i < 100 && !/running at/.test(log); i++) await sleep(100);
  if (!/running at/.test(log)) { fail('server never reported listening:\n' + log); return finish(); }
  // The social layer must actually be ON, or every assertion below passes for
  // the wrong reason (no store means no profile read at all).
  if (/\[boot\] social off/.test(log)) { fail('the social layer refused to boot: ' + log.trim()); return finish(); }

  // ---- 1. THE ATTACK: callsign and callsign_key disagree --------------------
  const bad = await presentedName('tok-tampered', TAMPERED);
  if (bad.err) fail(`(1) ${bad.err}`);
  else if (bad.name === TAMPERED) {
    fail(`(1) a profile row whose callsign does not match its callsign_key was trusted: ${JSON.stringify(bad.name)}`
      + ' reached the lobby — the sink is filling ws.chosenName from a column the client can write');
  } else if (!isGeneratedCallsign(bad.name)) {
    fail(`(1) the tampered name was replaced with ${JSON.stringify(bad.name)}, which is not a rolled callsign`);
  } else {
    ok(`(1) a callsign that does not normalise to its own callsign_key yields chosenName null —`
      + ` the lobby shows a rolled callsign (${JSON.stringify(bad.name)}) instead`);
  }

  // ---- 2. THE CONTROL: a row the server really wrote still works ------------
  // Without this the fix could be "always null" and case 1 would still pass.
  // ODD, not HONEST: HONEST passes the guidelines and would be shown with a
  // null ws.chosenName too (see ODD's note above).
  const good = await presentedName('tok-odd', ODD);
  if (good.err) fail(`(2) ${good.err}`);
  else if (good.name === ODD) ok(`(2) a row whose callsign DOES normalise to its key is still presented verbatim (${JSON.stringify(ODD)}, a name only ws.chosenName can admit)`);
  else fail(`(2) an honestly stored chosen callsign was replaced with ${JSON.stringify(good.name)} — the proof is too strict`);

  // ---- 3. the sink really did read both rows --------------------------------
  // Guards the shape of failure where the profile read never happened and both
  // answers above are "no chosen name" for a reason that has nothing to do
  // with the proof under test.
  if (profileHits.includes(TAMPER_ID) && profileHits.includes(ODD_ID)) {
    ok(`(3) the sink read both profile rows (${profileHits.length} read(s)) — cases 1 and 2 are about the proof, not a missing read`);
  } else {
    fail('(3) the sink never read one of the profile rows: ' + JSON.stringify(profileHits));
  }

  // ---- 2b. THE COLUMN'S CAPITALS MUST READ AS THE KEY (round 2 fix) --------
  // The column lower-cases onto its key, which was the whole proof, but its
  // mixture of Greek capitals reads as none of the key's own readings, the
  // ones the Set checked against every other account. The sink now presents
  // the key itself for such a column (server/callsign.js shownSpelling): the
  // lobby shows the key, which only ws.chosenName can admit (the third door
  // refuses a typed name that is a held key, and this one is), and the
  // mixture the client presents is not shown.
  const gKey = await presentedName('tok-greek', GREEK_KEY);
  const gMix = await presentedName('tok-greek', GREEK_MIXED);
  if (gKey.err || gMix.err) fail(`(2b) ${gKey.err || gMix.err}`);
  else if (gKey.name === GREEK_KEY && gMix.name !== GREEK_MIXED && isGeneratedCallsign(gMix.name))
    ok(`(2b) a column whose capitals read as none of its key's readings is presented as the key itself; the mixture gets the default (${JSON.stringify(gMix.name)})`);
  else fail(`(2b) the sink trusted the column's capitals: key presented as ${JSON.stringify(gKey.name)}, mixture as ${JSON.stringify(gMix.name)}`);

  // ---- 4. A LATE HELLO MUST NOT RESURRECT A SIGNED-OUT IDENTITY -------------
  // The sign-out branch clears ws.userId, ws.isGuest and ws.chosenName, but it
  // cannot reach a verification that is already in flight: that promise settles
  // a moment later and writes all three back, restoring the account's id, its
  // presence entry and its free-text exemption on a socket the player has just
  // signed out of. The generation counter is the cancel.
  {
    const ws = await open();
    send(ws, { type: 'hello', token: 'tok-slow' });
    await sleep(60);                       // the verification is now in flight
    send(ws, { type: 'hello', token: null });   // ...and the player signs out
    await sleep(SLOW_MS + 500);            // let the stale verification settle
    send(ws, { type: 'friends', id: 2 });
    // A signed-out socket is refused by the shared gate with type 'social'; a
    // signed-in one reaches the layer and is answered on its own type.
    const social = await wait(ws, 'social', 4000);
    const friends = ws._rx.find((m) => m.type === 'friends');
    try { ws.close(); } catch {}
    if (social && social.error === 'sign_in' && !friends) {
      ok('(4) a verification that settles AFTER a sign-out does not restore the account on the socket');
    } else {
      fail('(4) a sign-out was undone by an in-flight hello: the socket answered '
        + JSON.stringify(friends || social) + ' — it is still signed in');
    }
  }

  // ---- 5. OF TWO HELLOS, THE LATER ONE WINS ---------------------------------
  // Same defect, same fix: the callback wrote unconditionally, so whichever
  // verification happened to settle LAST decided who the socket was — not
  // whichever the client asked for last. Here the first is slow and the second
  // is fast, so without the generation the loser overwrites the winner.
  {
    const ws = await open();
    send(ws, { type: 'hello', token: 'tok-slow' });      // resolves in SLOW_MS
    await sleep(60);
    send(ws, { type: 'hello', token: 'tok-odd' });       // resolves at once
    await sleep(SLOW_MS + 500);
    // ODD, for case 2's reason: only the socket's own chosenName can show it.
    send(ws, { type: 'create', name: ODD, skin: 'olive', mode: 'duel' });
    const lobby = await wait(ws, 'lobby');
    const name = lobby && lobby.players && lobby.players[0] && lobby.players[0].name;
    try { send(ws, { type: 'leave' }); } catch {}
    try { ws.close(); } catch {}
    if (name === ODD) ok(`(5) the LATER hello owns the socket — the slow first one cannot overwrite it`);
    else fail(`(5) a slow first hello overwrote the second: presenting ${JSON.stringify(ODD)} gave `
      + `${JSON.stringify(name)}, so ws.chosenName belongs to the account the client already left`);
  }

  // ---- 6. THE WAIT HANDLE BELONGS TO THE CURRENT VERIFICATION ---------------
  // `ws.authPending` is what the message loop waits on so a social frame sent
  // straight after sign-in is answered for the account instead of refused for a
  // race. It used to be cleared by WHICHEVER verification settled first — so an
  // older one finishing dropped the handle the newer one owns, and a frame in
  // that window was answered sign_in while a hello was still in flight.
  //
  // Here the FIRST hello is fast-ish and the SECOND is slow, so the older one
  // settles while the current one is still out: with the handle cleared for the
  // current generation only, the frame below waits and is answered for the
  // account; without, it is refused.
  {
    const ws = await open();
    send(ws, { type: 'hello', token: 'tok-slow' });     // gen 1, settles at ~600ms
    await sleep(60);
    send(ws, { type: 'hello', token: 'tok-slower' });   // gen 2, settles at ~1600ms
    await sleep(SLOW_MS + 250);                         // gen 1 has settled; gen 2 has not
    send(ws, { type: 'friends', id: 3 });
    const friends = await wait(ws, 'friends', 5000);
    const refused = ws._rx.find((m) => m.type === 'social');
    try { ws.close(); } catch {}
    if (friends && !refused) ok('(6) a social frame still waits on the CURRENT hello after an older one has settled');
    else fail('(6) the wait handle was cleared by the older verification: the frame was answered '
      + JSON.stringify(refused || friends) + ' while a hello was still in flight');
  }

  // ---- 8. A GUEST MAY REPORT AND BLOCK, END TO END --------------------------
  // BINDING.md resolution 18, proved on the path a player actually takes rather
  // than against a fake socket: hello with an ANONYMOUS token, then two frames
  // through server.js's SOCIAL_TYPES interception into the real social layer
  // and the real store, against this mock PostgREST. A guest who sees an
  // offensive name in a lobby is exactly the player who needs to report it, and
  // Apple asks for a mechanism for USERS, not for some of them.
  {
    const ws = await open();
    send(ws, { type: 'hello', token: 'tok-guest' });
    send(ws, { type: 'report', id: HONEST_ID });
    const rep = await wait(ws, 'report');
    send(ws, { type: 'block', op: 'add', id: HONEST_ID });
    const blk = await wait(ws, 'block');
    // ...and the SAME socket must still be refused the linked-only paths, which
    // is what makes this a per-type gate rather than one gate left open.
    send(ws, { type: 'friends', id: 8 });
    const refused = await wait(ws, 'social', 4000);
    const panel = ws._rx.find((m) => m.type === 'friends');
    try { ws.close(); } catch {}

    if (rep && rep.ok === true) ok('(8) a guest report is accepted through the real socket and the real store');
    else fail('(8) guest report replied ' + JSON.stringify(rep));
    if (blk && blk.ok === true && blk.op === 'add') ok('(8) a guest block is accepted through the real socket and the real store');
    else fail('(8) guest block replied ' + JSON.stringify(blk));
    const row = reportPosts.find((r) => r && r.reporter === GUEST_ID);
    if (row && row.reported === HONEST_ID && row.callsign === HONEST)
      ok(`(8) the name_reports row really reached PostgREST: reporter=<guest> reported=<honest> callsign=${JSON.stringify(HONEST)}`);
    else fail('(8) name_reports POSTs: ' + JSON.stringify(reportPosts));
    const brow = blockPosts.find((r) => r && r.blocker === GUEST_ID);
    if (brow && brow.blocked === HONEST_ID) ok('(8) the blocks row really reached PostgREST, with the guest as the blocker');
    else fail('(8) blocks POSTs: ' + JSON.stringify(blockPosts));
    // The log line is the other half of the moderation surface, and it is
    // written by the real server process — so it is in this child's stdout.
    const line = `[report] ${HONEST_ID} "${HONEST}" by ${GUEST_ID}`;
    if (log.includes(line)) ok('(8) the server logged [report] <reported-uuid> "<callsign>" by <reporter-uuid>');
    else fail('(8) the report log line is not in the server output: ' + JSON.stringify(log.split('\n').filter((l) => l.startsWith('[report]'))));
    if (refused && refused.error === 'sign_in' && !panel)
      ok('(8) the same anonymous socket is still refused the friends panel — the gate is per message type');
    else fail('(8) a guest reached the friends panel: ' + JSON.stringify(panel || refused));
  }

  // ---- 8b. AND THE GUEST CAN SEE AND LIFT WHAT IT BLOCKED -------------------
  // The door has to open both ways. A guest could write a block row and then
  // never reach it: the blocked list lived only inside the friends snapshot,
  // behind requireLinked. This drives `block op:'list'` on the same anonymous
  // account, through the real socket, the real interception seam and the real
  // store, against a mock PostgREST that is actually holding the row.
  {
    const ws = await open();
    send(ws, { type: 'hello', token: 'tok-guest' });
    send(ws, { type: 'block', op: 'add', id: HONEST_ID, i: 1 });
    await wait(ws, 'block');
    ws._rx.length = 0;
    send(ws, { type: 'block', op: 'list', id: 81 });
    const listed = await wait(ws, 'block');
    ws._rx.length = 0;
    // UNBLOCKED THROUGH THE KEY THE LIST GAVE BACK, which is the only id this
    // client is ever handed now (BINDING.md resolution 24, applied to the
    // blocked list): the row carries a per-connection unblock key instead of the
    // account uuid, because block add accepts a lobby seat's handle and a list
    // that answered with the account turned the one into the other. This is the
    // end-to-end half of that — over the real socket, the real interception seam
    // and the real store.
    const listedKey = ((listed && listed.blocked) || [{}])[0].id;
    send(ws, { type: 'block', op: 'remove', id: listedKey });
    await wait(ws, 'block');
    ws._rx.length = 0;
    send(ws, { type: 'block', op: 'list', id: 82 });
    const empty = await wait(ws, 'block');
    try { ws.close(); } catch {}

    const rows = (listed && listed.blocked) || [];
    if (listed && listed.ok === true && listed.op === 'list' && listed.id === 81
      && rows.length === 1 && /^[0-9a-f]{32}$/.test(String(rows[0].id)) && rows[0].callsign === HONEST)
      ok(`(8b) a guest can LIST what it blocked, with the proven name beside it (${JSON.stringify(HONEST)}) and an opaque unblock key in place of the account`);
    else fail('(8b) guest blocked list: ' + JSON.stringify(listed));
    if (listed && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(JSON.stringify(listed)))
      ok('(8b) and NO account uuid anywhere in the list frame — end to end, the blocked list is not a handle-to-uuid converter');
    else fail('(8b) an account uuid reached the guest: ' + JSON.stringify(listed));
    if (listed && listed.friendCode === undefined && listed.friends === undefined && listed.requests === undefined)
      ok('(8b) and the frame carries the blocked list alone — no friend code is minted for an anonymous account');
    else fail('(8b) the list frame leaked panel fields: ' + JSON.stringify(Object.keys(listed || {})));
    if (empty && empty.ok === true && ((empty.blocked || []).length === 0))
      ok('(8b) and it can LIFT the block and watch the list empty — the one-way door is closed end to end');
    else fail('(8b) after a guest unblock: ' + JSON.stringify(empty));
  }

  // ---- 8c. REPORT A STRANGER IN A LOBBY, BY HANDLE, END TO END -------------
  // BINDING.md resolution 24, on the path a player actually takes. Cases 8 and
  // 8b both send an account uuid the FRIENDS PANEL handed out — which is a
  // screen a guest cannot even open. This is the screen the moderation story
  // rests on: two strangers in one lobby, and the only thing either client has
  // ever been told about the other is a per-room handle.
  //
  // It is also the only test in this tree that can see server.js's half of the
  // wiring. The engine's resolveSeatHandle is passed into createSocial there and
  // nowhere else; in process the two halves can be joined by hand and pass while
  // the real server joins nothing.
  {
    const before = reportPosts.length;
    const g = await open();                       // the guest: the reporter
    const h = await open();                       // a linked account: the target
    // Both hellos must have SETTLED before a seat is taken, or the seat is
    // minted with no account on the socket and carries no handle — a race that
    // would fail in the direction that hides the bug.
    send(g, { type: 'hello', token: 'tok-guest' });
    send(g, { type: 'friends', id: 90 });
    const gGate = await wait(g, 'social');
    send(h, { type: 'hello', token: 'tok-honest' });
    send(h, { type: 'friends', id: 91 });
    const hGate = await wait(h, 'friends');
    if (!gGate || !hGate) { fail('(8c) a hello never settled: ' + JSON.stringify([gGate, hGate])); }

    send(g, { type: 'create', name: 'Anvil Six', skin: 'olive', mode: 'ffa', max: 4 });
    const made = await wait(g, 'created');
    g._rx.length = 0;
    send(h, { type: 'join', code: made && made.code, name: HONEST, skin: 'gold' });
    const lobby = await wait(g, 'lobby');
    const seats = (lobby && lobby.players) || [];
    const mine = seats[0] && seats[0].handle;
    const theirs = seats[1] && seats[1].handle;

    if (seats[1] && seats[1].name === HONEST) ok('(8c) two strangers in one lobby, the second presenting a chosen callsign');
    else fail('(8c) the lobby did not fill: ' + JSON.stringify(seats));
    if (/^[0-9a-f]{8}$/.test(String(theirs)) && /^[0-9a-f]{8}$/.test(String(mine)) && mine !== theirs)
      ok('(8c) every occupied seat carries its own short handle, over the real socket');
    else fail('(8c) handles on the wire: ' + JSON.stringify([mine, theirs]));
    const wire = JSON.stringify(lobby);
    if (!wire.includes(HONEST_ID) && !wire.includes(GUEST_ID))
      ok('(8c) and NO account uuid is anywhere in the payload — which is the whole point of the handle');
    else fail('(8c) an account id reached a real lobby payload: ' + wire);

    g._rx.length = 0;
    send(g, { type: 'report', handle: theirs, id: 92 });
    const rep = await wait(g, 'report');
    if (rep && rep.ok === true && rep.id === 92) ok('(8c) the guest reports the stranger by handle, through server.js\'s own wiring');
    else fail('(8c) report by handle replied ' + JSON.stringify(rep));
    const row = reportPosts.slice(before).find((r) => r && r.reporter === GUEST_ID);
    if (row && row.reported === HONEST_ID && row.callsign === HONEST)
      ok('(8c) the name_reports row really reached PostgREST, resolved to the ACCOUNT the handle stood for');
    else fail('(8c) name_reports POSTs since the lobby: ' + JSON.stringify(reportPosts.slice(before)));
    // THE HANDLE MUST NOT BE IN THE LOG. The line keeps the resolved uuid; a
    // room-scoped token in a log that outlives the room makes the line and the
    // row unreconcilable and puts the token somewhere it was never meant to go.
    const reportLines = log.split('\n').filter((l) => l.startsWith('[report] '));
    if (reportLines.length && !reportLines.some((l) => l.includes(String(theirs)) || l.includes(String(mine))))
      ok('(8c) no [report] line the server has written contains a handle');
    else fail('(8c) a handle reached the log: ' + JSON.stringify(reportLines));

    // THE BACK DOOR, end to end: a raw account uuid must not work in `handle`,
    // or the lobby leak this mechanism exists to avoid returns unchanged.
    g._rx.length = 0;
    send(g, { type: 'report', handle: HONEST_ID, id: 93 });
    const raw = await wait(g, 'report');
    if (raw && raw.error === 'no_such_user') ok('(8c) a raw account uuid in `handle` is refused by the real server too');
    else fail('(8c) a raw uuid in handle replied ' + JSON.stringify(raw));

    // AND YOUR OWN SEAT'S HANDLE IS YOU. The resolution has to run ahead of the
    // self check or this is a player reporting themselves.
    g._rx.length = 0;
    send(g, { type: 'block', op: 'add', handle: mine, id: 94 });
    const self = await wait(g, 'block');
    if (self && self.error === 'self' && self.op === 'add') ok('(8c) blocking your own seat\'s handle is caught as self');
    else fail('(8c) self by handle replied ' + JSON.stringify(self));

    // AND THE SAME CARD IN THE MATCH. The lobby lasts seconds; the HUD carries
    // every player's name for the whole battle, so this is the screen a report
    // is actually decided on. Same handles, positional this time, over the real
    // socket.
    g._rx.length = 0; h._rx.length = 0;
    send(g, { type: 'startMatch' });
    const started = await wait(g, 'start');
    const hs = (started && started.handles) || [];
    if (started && JSON.stringify(hs) === JSON.stringify([mine, theirs]))
      ok('(8c) the in-match snapshot carries the same handles, one per seat, in seat order');
    else fail('(8c) snapshot handles: ' + JSON.stringify(hs) + ' wanted ' + JSON.stringify([mine, theirs]));
    if (started && !JSON.stringify(started).includes(HONEST_ID) && !JSON.stringify(started).includes(GUEST_ID))
      ok('(8c) and no account uuid is anywhere in the snapshot either');
    else fail('(8c) an account id reached a real snapshot');
    g._rx.length = 0;
    send(g, { type: 'report', handle: hs[1], id: 95 });
    const inMatch = await wait(g, 'report');
    if (inMatch && inMatch.ok === true) ok('(8c) the guest reports the player beside them MID-MATCH, by the handle in the snapshot');
    else fail('(8c) in-match report replied ' + JSON.stringify(inMatch));
    const lines = log.split('\n').filter((l) => l.startsWith('[report] '));
    if (lines.length && !lines.some((l) => hs.some((x) => x && l.includes(x))))
      ok('(8c) and still no handle, in-match or lobby, has reached a log line');
    else fail('(8c) a handle reached the log: ' + JSON.stringify(lines));

    try { send(g, { type: 'leave' }); } catch {}

    try { g.close(); } catch {}
    try { h.close(); } catch {}
  }

  // ---- 9. A PUSH TOKEN INTRODUCES A SOCKET THE WAY A HELLO DOES --------------
  // A pushSub frame carries an access token too, and a socket that never said
  // hello becomes that account when it lands. It used to set ws.userId there
  // and nothing else: no ws.isGuest, so an ANONYMOUS account passed the linked
  // gate, and no onAuth, so a squad row such a socket held skipped the sign-in
  // door. Every check waits for the push token to be verified first, because a
  // frame answered before that proves nothing about what the token did.
  const pushSub = async (ws, token, tag) => {
    const seen = verifiedTokens.length;
    send(ws, { type: 'pushSub', sub: { endpoint: `https://push.example.test/sub/${tag}`, keys: { p256dh: 'x', auth: 'y' } }, token });
    const acked = await wait(ws, 'pushOk', 4000);
    for (let i = 0; i < 100 && !verifiedTokens.slice(seen).includes(token); i++) await sleep(20);
    await sleep(250);                           // the verified identity lands on the socket
    return acked;
  };
  const seated = async () => {                  // a socket holding a seat: the only kind a pushSub is taken from
    const ws = await open();
    send(ws, { type: 'create', name: 'Seat', skin: 'olive', mode: 'duel' });
    return (await wait(ws, 'lobby')) ? ws : null;
  };
  {
    // (9a) AN ANONYMOUS PUSH TOKEN IS A GUEST, and the friends panel is not a guest's.
    const ws = await seated();
    const acked = ws && await pushSub(ws, 'tok-guest', 'guest');
    if (ws) { send(ws, { type: 'friends', id: 91 }); }
    const r = ws && await wait(ws, 'social', 3000);
    const panel = ws && ws._rx.find((m) => m.type === 'friends');
    if (acked && r && r.error === 'sign_in' && !panel)
      ok('(9a) a socket identified only by an ANONYMOUS push token is a guest: the friends panel answers sign_in');
    else fail('(9a) anonymous push token: ack ' + JSON.stringify(acked) + ', friends answered ' + JSON.stringify(panel || r));
    try { ws.close(); } catch {}
  }
  {
    // (9b) A LINKED PUSH TOKEN STILL IDENTIFIES THE SOCKET (the control: nudges
    // for that seat find the account's other devices, as they always did).
    const ws = await seated();
    const acked = ws && await pushSub(ws, 'tok-honest', 'honest');
    if (ws) send(ws, { type: 'friends', id: 92 });
    const panel = ws && await wait(ws, 'friends', 3000);
    if (acked && panel && !panel.error) ok('(9b) a socket identified only by a LINKED push token is that account: the friends panel answers');
    else fail('(9b) linked push token: ack ' + JSON.stringify(acked) + ', friends answered ' + JSON.stringify(panel || ws && ws._rx.slice(-3)));
    try { ws.close(); } catch {}
  }
  {
    // (9d) A HELLO ALREADY IN FLIGHT IS WAITED FOR, not overtaken. The socket
    // says hello as a linked account whose verification takes 600 ms, then
    // registers a subscription with a different (anonymous) token. The hello
    // is who the socket is; the push token must not cancel it and stand in.
    const ws = await seated();
    if (ws) {
      send(ws, { type: 'hello', token: 'tok-slow' });
      await pushSub(ws, 'tok-guest', 'inflight');
      for (let i = 0; i < 60 && !verifiedTokens.includes('tok-slow'); i++) await sleep(20);
      await sleep(SLOW_MS + 300);
      send(ws, { type: 'friends', id: 95 });
    }
    const panel = ws && await wait(ws, 'friends', 3000);
    if (panel && !panel.error) ok('(9d) a push token sent while a hello is verifying waits for it: the socket is the hello\'s account');
    else fail('(9d) push token over an in-flight hello: friends answered ' + JSON.stringify(panel || ws && ws._rx.slice(-3)));
    try { ws.close(); } catch {}
  }
  {
    // (9c) THE SIGN-IN DOOR. A tab with no account joins HONEST's squad by
    // code, holds a seat of its own, and becomes the guest account through a
    // push token. HONEST has blocked that account, so the door must remove the
    // row as a kick, exactly as it does for a hello.
    const lead = await open();
    send(lead, { type: 'hello', token: 'tok-honest' });
    send(lead, { type: 'squad', op: 'create', id: 93 });
    const made = await wait(lead, 'squad');
    const g = await seated();
    if (g && made && made.code) send(g, { type: 'squad', op: 'join', code: made.code, name: 'Tab', skin: 'gold', id: 94 });
    const joined = g && await wait(g, 'squad');
    blockRows.add(HONEST_ID + '>' + GUEST_ID);
    const acked = g && joined && joined.op === 'state' && await pushSub(g, 'tok-guest', 'door');
    let kicked = null;
    for (let i = 0; i < 100 && g && !kicked; i++) {
      kicked = g._rx.find((m) => m.type === 'squad' && m.op === 'ended') || null;
      if (!kicked) await sleep(20);
    }
    blockRows.delete(HONEST_ID + '>' + GUEST_ID);
    if (acked && kicked && kicked.reason === 'kicked')
      ok('(9c) a guest row whose socket becomes a blocked account through a push token is removed by the sign-in door, as a kick');
    else fail('(9c) push-token sign-in door: joined ' + JSON.stringify(joined) + ', ack ' + JSON.stringify(acked) + ', then ' + JSON.stringify(g && g._rx.slice(-3)));
    try { lead.close(); } catch {}
    try { g.close(); } catch {}
  }

  // ---- 10. A DELETED ACCOUNT'S SOCKETS STOP BEING IT --------------------------
  // POST /account/delete removed the auth user and left every live socket of
  // it identified: ws.userId stayed set, nothing re-verifies a socket after
  // its hello, so those sockets kept acting as an account that no longer
  // exists (every write then failing on a foreign key). They must become
  // nobody at once, as a sign-out makes them, and the squad the account was
  // in must see it leave. A bystander's socket must not change at all.
  {
    const d1 = await open(), d2 = await open(), h = await open();
    send(d1, { type: 'hello', token: 'tok-doomed' });
    send(d2, { type: 'hello', token: 'tok-doomed' });
    send(h, { type: 'hello', token: 'tok-honest' });
    send(h, { type: 'squad', op: 'create', id: 101 });
    const made = await wait(h, 'squad');
    if (made && made.code) send(d1, { type: 'squad', op: 'join', code: made.code, name: 'Doomed', skin: 'gold', id: 102 });
    const joined = await wait(d1, 'squad');
    send(d2, { type: 'friends', id: 103 });
    const before = await wait(d2, 'friends');
    h._rx.length = 0; d2._rx.length = 0;
    const res = await fetch(`http://127.0.0.1:${GAME_PORT}/account/delete`, { method: 'POST', headers: { Authorization: 'Bearer tok-doomed' } });
    send(d2, { type: 'friends', id: 104 });
    const after = await wait(d2, 'social', 3000);
    const panel = d2._rx.find((m) => m.type === 'friends');
    let roster = null;
    for (let i = 0; i < 100 && !roster; i++) {
      roster = h._rx.find((m) => m.type === 'squad' && m.op === 'state') || null;
      if (!roster) await sleep(20);
    }
    send(h, { type: 'friends', id: 105 });
    const still = await wait(h, 'friends', 3000);
    if (joined && joined.op === 'state' && before && !before.error && res.status === 200)
      ok('(10) the world is real: the account was in a squad and signed in on two sockets, and the delete answered 200');
    else fail('(10) setup: joined ' + JSON.stringify(joined) + ' panel ' + JSON.stringify(before) + ' delete ' + res.status);
    if (after && after.error === 'sign_in' && !panel)
      ok('(10) after /account/delete, the deleted account\'s other socket is nobody: the friends panel answers sign_in');
    else fail('(10) a socket of a deleted account still acts as it: friends answered ' + JSON.stringify(panel || after));
    if (roster && roster.members.length === 1 && roster.members[0].id === HONEST_ID)
      ok('(10) and its squad sees it leave');
    else fail('(10) the squad after the delete: ' + JSON.stringify(roster));
    if (still && !still.error) ok('(10) a socket of another account is untouched by the delete');
    else fail('(10) the bystander after the delete: ' + JSON.stringify(still));
    for (const w of [d1, d2, h]) { try { w.close(); } catch {} }
  }

  // ---- 11. THE NAME INDEX, END TO END (round 2, 2026-10-08) -----------------
  // server.js builds the name index from the store, asks it at the room
  // engine's door, and hands it to the social layer with the engine's seat
  // name. Only a real server can show that wiring: in process the halves can
  // be joined by hand and pass while server.js joins nothing. A guest's typed
  // name that is an account's chosen callsign never reaches a seat, nor a
  // computer's name; a good one does; the guest's check says 'taken' for a held
  // name and follows a Set made on this server; a report against a guest's
  // seat records the typed name it showed; and a server whose index can never
  // load shows no typed name at all.
  {
    const presentedAt = async (port, typed, token) => {
      const ws = await openAt(port);
      if (token) { send(ws, { type: 'hello', token }); send(ws, { type: 'friends', id: 1 }); await wait(ws, token === 'tok-guest' ? 'social' : 'friends'); }
      send(ws, { type: 'create', name: typed, skin: 'olive', mode: 'duel' });
      const lobby = await wait(ws, 'lobby');
      try { send(ws, { type: 'leave' }); } catch {}
      try { ws.close(); } catch {}
      return lobby && lobby.players && lobby.players[0] ? lobby.players[0].name : null;
    };
    const check = async (ws, name, id) => { send(ws, { type: 'callsign', op: 'check', name, id }); await sleep(50); return ws._rx.find((m) => m.type === 'callsign' && m.id === id) || (await waitId(ws, id)); };
    const reads = indexReads.slice();
    if (reads[0] === '?select=callsign_key&callsign_key=not.is.null&order=callsign_key.asc&limit=1000' && reads.some((r) => /callsign_key=gt\./.test(r)))
      ok('(11) the server read the name index at boot: every non-null key in key order, then past the last key, to an empty page');
    else fail('(11) index reads: ' + JSON.stringify(reads));
    const held = await presentedAt(GAME_PORT, 'marguerite VALE');
    const good = await presentedAt(GAME_PORT, '  Tank   Ace ');
    const bot = await presentedAt(GAME_PORT, 'CPU 2');
    if (isGeneratedCallsign(held) && held !== HONEST && good === 'Tank Ace' && isGeneratedCallsign(bot))
      ok(`(11) at the door a guest typing an account's chosen callsign gets the default (${JSON.stringify(held)}), so does a computer's name, and a good typed name is shown normalised`);
    else fail('(11) door: ' + JSON.stringify({ held, good, bot }));
    const g = await openAt(GAME_PORT);
    const c1 = await check(g, 'Wren Delacroix', 'c1');
    const c2 = await check(g, 'Tank Ace', 'c2');
    // A Set made on this server takes its key at once.
    const hs = await openAt(GAME_PORT);
    send(hs, { type: 'hello', token: 'tok-honest' }); send(hs, { type: 'friends', id: 2 }); await wait(hs, 'friends');
    send(hs, { type: 'callsign', name: 'Kestrel Bay', id: 'set' });
    const set = await waitId(hs, 'set');
    // Three checks on one socket: exactly the callsign bucket's three a minute.
    const c3 = await check(g, 'kestrel bay', 'c3');
    const kb = await presentedAt(GAME_PORT, 'Kestrel Bay');
    const word = (m) => (m ? (m.ok ? 'ok' : m.error) : 'none');
    if (word(c1) === 'taken' && word(c2) === 'ok' && set && set.ok === true && word(c3) === 'taken' && isGeneratedCallsign(kb))
      ok("(11) a guest's check answers 'taken' for a held name and ok for a free one, and a Set on this server is taken at once: the check and the door both refuse it");
    else fail('(11) check and Set: ' + JSON.stringify({ c1, c2, set, c3, kb }));
    // A report against a guest's seat records the typed name it showed.
    const before = reportPosts.length;
    const guest = await openAt(GAME_PORT);
    send(guest, { type: 'hello', token: 'tok-anon2' }); send(guest, { type: 'friends', id: 3 }); await wait(guest, 'social');
    hs._rx.length = 0;
    send(hs, { type: 'create', name: HONEST, skin: 'olive', mode: 'ffa', max: 4 });
    const made = await wait(hs, 'created');
    hs._rx.length = 0;
    send(guest, { type: 'join', code: made && made.code, name: 'Tank Ace', skin: 'gold' });
    const lobby = await wait(hs, 'lobby');
    const seat = lobby && lobby.players && lobby.players[1];
    send(hs, { type: 'report', handle: seat && seat.handle, id: 'rep' });
    const rep = await waitId(hs, 'rep');
    const row = reportPosts.slice(before).find((r) => r && r.reported === NAMELESS_ID);
    if (seat && seat.name === 'Tank Ace' && rep && rep.ok === true && row && row.callsign === 'Tank Ace')
      ok("(11) a report against a guest's seat by handle records the typed name the seat showed, 'Tank Ace', not '(no name)'");
    else fail('(11) seat report: ' + JSON.stringify({ seat, rep, rows: reportPosts.slice(before) }));
    for (const w of [g, hs, guest]) { try { send(w, { type: 'leave' }); } catch {} try { w.close(); } catch {} }
    // FAIL CLOSED: a second server whose every store read fails.
    const port2 = await freePort();
    const child2 = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port2), SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}/broken`, SUPABASE_PUBLISHABLE_KEY: 'pk_test', SUPABASE_SECRET_KEY: 'sk_test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log2 = '';
    child2.stdout.on('data', (d) => { log2 += d.toString(); });
    child2.stderr.on('data', (d) => { log2 += d.toString(); });
    try {
      for (let i = 0; i < 100 && !/running at/.test(log2); i++) await sleep(100);
      for (let i = 0; i < 50 && !/\[names\] index read failed/.test(log2); i++) await sleep(100);
      const closed = await presentedAt(port2, 'Tank Ace');
      const rolled = await presentedAt(port2, 'Iron Ridge');
      const g2 = await openAt(port2);
      const c4 = await check(g2, 'Tank Ace', 'c4');
      try { g2.close(); } catch {}
      if (/\[names\] index read failed/.test(log2) && isGeneratedCallsign(closed) && closed !== 'Tank Ace' && rolled === 'Iron Ridge' && word(c4) === 'unavailable')
        ok(`(11) a server whose name index cannot load says so on stderr and shows no typed name (the default ${JSON.stringify(closed)} instead) while a rolled pair still shows; the check answers unavailable`);
      else fail('(11) fail closed: ' + JSON.stringify({ closed, rolled, c4, said: /\[names\]/.test(log2) }));
    } finally {
      try { child2.kill('SIGKILL'); } catch {}
    }
  }

  // ---- 7. nothing crashed the host ------------------------------------------

  const stray = log.split('\n').filter((l) => /uncaught|unhandled|ERR_/i.test(l));
  if (!stray.length) ok('(7) the server logged no uncaught or unhandled failure across both flows');
  else fail('(7) server log: ' + stray.join(' / '));

  finish();
})().catch((e) => { fail('threw: ' + (e && e.stack || e)); finish(); });
