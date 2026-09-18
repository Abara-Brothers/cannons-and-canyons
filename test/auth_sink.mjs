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
setTimeout(() => { fail('timeout'); finish(); }, 45000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- The two profile rows ----------------------------------------------------
// HONEST: written by this server, so the display form still normalises to the
// key beside it. TAMPERED: the same key, with the display string swapped for
// something the server never validated — the exact row the attack produces.
const HONEST_ID = '11111111-1111-4111-8111-111111111111';
const TAMPER_ID = '22222222-2222-4222-8222-222222222222';
const SLOW_ID = '33333333-3333-4333-8333-333333333333';
const HONEST = 'Marguerite Vale';
const KEY = 'marguerite vale';
const SLOW = 'Wren Delacroix';
const TAMPERED = 'FOLLOW ME ON X';          // 14 chars, inside the 16 the column allows
const ROWS = {
  [HONEST_ID]: { id: HONEST_ID, callsign: HONEST, friend_code: 'ABC234', callsign_key: KEY, callsign_set_at: null },
  // callsign and callsign_key DISAGREE. This is the whole test.
  [TAMPER_ID]: { id: TAMPER_ID, callsign: TAMPERED, friend_code: 'ABC235', callsign_key: KEY, callsign_set_at: null },
  // A second honest account, reached only through the DELAYED token below —
  // the one whose verification is still in flight when the next frame lands.
  [SLOW_ID]: { id: SLOW_ID, callsign: SLOW, friend_code: 'ABC236', callsign_key: SLOW.toLowerCase(), callsign_set_at: null },
};
// A REAL ANONYMOUS ACCOUNT — what public/cloud.js mints for every player who
// saves anything. It carries a perfectly good uuid, so it is the case a gate
// written as `if (!ws.userId)` waves straight through. Case 8 drives report and
// block on it END TO END, through the real socket, the real interception seam
// and the real store, because a test that calls the handler directly can pass
// while the path that reaches it is broken.
const GUEST_ID = '44444444-4444-4444-8444-444444444444';
const TOKENS = { 'tok-honest': HONEST_ID, 'tok-tampered': TAMPER_ID, 'tok-slow': SLOW_ID, 'tok-slower': HONEST_ID, 'tok-guest': GUEST_ID };
const ANON = new Set(['tok-guest']);
// How long the mock GoTrue sits on each delayed token before answering. Long
// enough that a sign-out, or a second hello, is comfortably ahead of it — and
// two different delays, so an OLDER verification can settle while a NEWER one
// is still in flight (case 6).
const SLOW_MS = 600, SLOWER_MS = 1600;
const DELAY = { 'tok-slow': SLOW_MS, 'tok-slower': SLOWER_MS };

// ---- Mock Supabase -----------------------------------------------------------
const MOCK_PORT = 9931, GAME_PORT = 3106;
const profileHits = [];
const reportPosts = [], blockPosts = [];
// The blocks this mock is actually holding, as `blocker>blocked`. POST adds,
// DELETE removes and the two GETs read it, so case 8 can block, list and unblock
// against something that remembers.
const blockRows = new Set();
mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
    const json = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/auth/v1/health') return json(200, { name: 'GoTrue', version: 'mock' });
    if (u.pathname === '/auth/v1/user') {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
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
  const good = await presentedName('tok-honest', HONEST);
  if (good.err) fail(`(2) ${good.err}`);
  else if (good.name === HONEST) ok(`(2) a row whose callsign DOES normalise to its key is still presented verbatim (${JSON.stringify(HONEST)})`);
  else fail(`(2) an honestly stored chosen callsign was replaced with ${JSON.stringify(good.name)} — the proof is too strict`);

  // ---- 3. the sink really did read both rows --------------------------------
  // Guards the shape of failure where the profile read never happened and both
  // answers above are "no chosen name" for a reason that has nothing to do
  // with the proof under test.
  if (profileHits.includes(TAMPER_ID) && profileHits.includes(HONEST_ID)) {
    ok(`(3) the sink read both profile rows (${profileHits.length} read(s)) — cases 1 and 2 are about the proof, not a missing read`);
  } else {
    fail('(3) the sink never read one of the profile rows: ' + JSON.stringify(profileHits));
  }

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
    send(ws, { type: 'hello', token: 'tok-honest' });    // resolves at once
    await sleep(SLOW_MS + 500);
    send(ws, { type: 'create', name: HONEST, skin: 'olive', mode: 'duel' });
    const lobby = await wait(ws, 'lobby');
    const name = lobby && lobby.players && lobby.players[0] && lobby.players[0].name;
    try { send(ws, { type: 'leave' }); } catch {}
    try { ws.close(); } catch {}
    if (name === HONEST) ok(`(5) the LATER hello owns the socket — the slow first one cannot overwrite it`);
    else fail(`(5) a slow first hello overwrote the second: presenting ${JSON.stringify(HONEST)} gave `
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
    send(ws, { type: 'block', op: 'remove', id: HONEST_ID });
    await wait(ws, 'block');
    ws._rx.length = 0;
    send(ws, { type: 'block', op: 'list', id: 82 });
    const empty = await wait(ws, 'block');
    try { ws.close(); } catch {}

    const rows = (listed && listed.blocked) || [];
    if (listed && listed.ok === true && listed.op === 'list' && listed.id === 81
      && rows.length === 1 && rows[0].id === HONEST_ID && rows[0].callsign === HONEST)
      ok(`(8b) a guest can LIST what it blocked, with the proven name beside it (${JSON.stringify(HONEST)})`);
    else fail('(8b) guest blocked list: ' + JSON.stringify(listed));
    if (listed && listed.friendCode === undefined && listed.friends === undefined && listed.requests === undefined)
      ok('(8b) and the frame carries the blocked list alone — no friend code is minted for an anonymous account');
    else fail('(8b) the list frame leaked panel fields: ' + JSON.stringify(Object.keys(listed || {})));
    if (empty && empty.ok === true && ((empty.blocked || []).length === 0))
      ok('(8b) and it can LIFT the block and watch the list empty — the one-way door is closed end to end');
    else fail('(8b) after a guest unblock: ' + JSON.stringify(empty));
  }

  // ---- 7. nothing crashed the host ------------------------------------------
  const stray = log.split('\n').filter((l) => /uncaught|unhandled|ERR_/i.test(l));
  if (!stray.length) ok('(7) the server logged no uncaught or unhandled failure across both flows');
  else fail('(7) server log: ' + stray.join(' / '));

  finish();
})().catch((e) => { fail('threw: ' + (e && e.stack || e)); finish(); });
