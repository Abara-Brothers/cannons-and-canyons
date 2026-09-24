// Task 1's half of squads: ONE CODE NAMESPACE, and the two new frame types
// reaching the server.
//
// WHY THIS EXISTS. A squad code and a room code are typed into the SAME
// "Enter a code" field (design D8). If the two spaces can collide, that field
// has two honest answers and no way to choose — and the failure is rare,
// silent, and seats a player in the wrong container. Nothing else in this
// tree looks at makeCode's loop condition.
//
// NOTHING UNDER TEST IS STUBBED. The room half is the REAL engine: real
// makeCode, real `rooms` Map, real create path, driven through the real
// handleClientMessage. The social half is the REAL createSocial. The only
// injected functions are the ones server.js itself injects, injected with the
// same expressions server.js uses.
//
// This suite loads public/room-engine.js, which test/social.mjs deliberately
// does not. That is the point of this one: the seam between the engine's code
// minting and the squad container is what task 1 builds.
//
// THE CODE FRAME IS NOT HERE. Its answer is computed in server.js's socket
// handler, ahead of the social layer, and nothing in process can reach that
// handler; test/code_frame.mjs drives it against a real server.js, with the
// layer off and with it on against a hanging Supabase.
//
// Headless: no server, no Chrome, no Supabase, no network, no real clock.
import { readFileSync } from 'node:fs';
import { createSquads } from '../server/squads.js';
// THE REAL ENGINE. This is the one suite in the tree that needs both halves in
// one process: makeCode's loop is what task 1 changes, and `rooms` is the
// container the code frame's room arm reads through.
import { rooms, handleClientMessage, setCodeTaken, MODE_SEATS, TEE_IDS, validRackFor } from '../public/room-engine.js';
import { LOADOUT_POOL, loadoutSizeFor } from '../public/game-core.js';
import { createSocial, SOCIAL_TYPES } from '../server/social.js';
// Task 2: the one-byte hook the code minters are proved on. The same module
// is loaded into a spawned server.js by test/code_frame.mjs with --import;
// here it is installed for the length of one block and taken out again.
import { scriptCodeBytes } from './fixtures/scripted-code-bytes.mjs';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
// One fake socket for BOTH consumers. The engine needs `readyState === 1` and
// `send(<string>)` and nothing else; the social layer additionally reads
// userId / isGuest / chosenName. This is test/social.mjs's mkws with the
// engine's requirements already satisfied.
const mkws = (userId = null, isGuest = false) => ({ readyState: 1, userId, isGuest, chosenName: null, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });
const frames = (ws, t) => ws._rx.filter((m) => m.type === t);
const last = (ws) => ws._rx[ws._rx.length - 1];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const FIVE = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];   // a duel's draft size
// The engine's send(), the spelling test/social.mjs uses.
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const TERMS = ['badword'];
// A store fake with ONE method on it, on purpose: neither frame this task
// adds may reach the store at all, so anything that did would throw on a
// method that is not here, the layer's net would answer 'unavailable', and
// the kind assertions below would fail loudly instead of passing quietly.
const mkstore = () => { const st = { calls: [], async profileById(id) { st.calls.push(['profileById', id]); return null; } }; return st; };
const UID = '11111111-1111-4111-8111-111111111111';

const NOW = Date.parse('2026-09-22T09:00:00Z');
const now = () => NOW;

// ---- (1) server/squads.js: the container and the three readers -------------
// THE MAP IS EMPTY FOR THE WHOLE OF THIS TASK — create() arrives in task 2 —
// so what is provable here is the container's IDENTITY and the shape of a
// miss. Both are worth pinning. `has` is what the engine's codeTaken calls on
// every candidate code, and a `has` that answers yes to a string nobody
// minted would spin makeCode for ever; a `get` that answers `undefined` where
// the plan's surface says `null` passes `if (!squad)` and fails `=== null`,
// so it would work in some call sites downstream and not others.
{
  const squads = createSquads({ now });

  if (typeof squads.has === 'function' && typeof squads.get === 'function' && typeof squads.ofUser === 'function')
    ok('(1a) createSquads returns has, get and ofUser');
  else fail('(1a) createSquads returned ' + JSON.stringify(Object.keys(squads)));

  if (squads.has('ABCD') === false) ok('(1b) has() on an empty container is false, not undefined');
  else fail('(1b) has("ABCD") was ' + JSON.stringify(squads.has('ABCD')));
  if (Object.is(squads.get('ABCD'), null)) ok('(1b) get() on a miss is null, not Map.get\'s undefined');
  else fail('(1b) get("ABCD") was ' + String(squads.get('ABCD')));
  if (Object.is(squads.ofUser('u1'), null)) ok('(1b) ofUser() with no squads is null');
  else fail('(1b) ofUser("u1") was ' + String(squads.ofUser('u1')));

  // A MAP, NOT AN OBJECT LITERAL. A code arrives off the wire as whatever the
  // sender felt like sending, and every one of these strings is a key an
  // object-backed container inherits: `'constructor' in {}` is true and
  // `{}['toString']` is a function it never stored. Backed by an object,
  // has('constructor') answers yes, the engine's codeTaken refuses that code,
  // and it stays refused for ever because no squad can ever release it.
  const proto = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];
  const hits = proto.filter((k) => squads.has(k) !== false || !Object.is(squads.get(k), null));
  if (hits.length === 0) ok('(1c) no prototype key is a squad code — the container is a Map');
  else fail('(1c) the container answered for prototype keys: ' + JSON.stringify(hits));
}

// ---- (2) public/room-engine.js: makeCode consults the injected predicate ----
// THE ALPHABET, read out of the engine rather than copied, so this suite
// cannot vouch for a constant that has drifted underneath it.
{
  const CODE_CHARS = (read('public/room-engine.js').match(/const CODE_CHARS = '([A-Z0-9]+)';/) || [])[1] || '';
  if (CODE_CHARS.length === 31 && !/[ILO01]/.test(CODE_CHARS))
    ok('(2a) the shared alphabet is 31 characters with no I, L, O, 0 or 1');
  else fail('(2a) CODE_CHARS read from the engine was ' + JSON.stringify(CODE_CHARS));

  // THE OFFLINE PAGE'S LOOP FIRST, before anything is injected. The default
  // has to be `() => false` rather than the sinks' `() => {}`, because this
  // predicate is CONSULTED inside a do/while rather than announced to, and
  // anything truthy spins it for ever. The offline page never calls
  // setCodeTaken, so this is the loop it runs.
  const ws = mkws();
  handleClientMessage(ws, { type: 'create', name: 'T', skin: 'olive', mode: 'duel', loadout: FIVE });
  const cr = frames(ws, 'created')[0];
  if (cr && typeof cr.code === 'string' && cr.code.length === 4
    && [...cr.code].every((c) => CODE_CHARS.includes(c)) && rooms.has(cr.code))
    ok('(2a) with nothing injected the engine still mints a live 4-character code — the offline loop is unchanged');
  else fail('(2a) created was ' + JSON.stringify(cr) + ' rooms.has=' + !!(cr && rooms.has(cr.code)));
  handleClientMessage(ws, { type: 'leave' });
}

// THE PREDICATE IS CONSULTED FOR EVERY CANDIDATE AND A REFUSAL IS OBEYED, and
// it is proved DETERMINISTICALLY rather than probabilistically: a predicate
// that refuses a fixed number of codes forces a fixed number of loops. An
// assertion that merely showed the minted code was not in some refused set
// would pass ~999,997 times in a million with the guard removed.
{
  if (rooms.size !== 0) fail('(2b) the rooms Map was not empty at the start of this section: ' + rooms.size);
  const seen = [];
  let refuse = 3;
  setCodeTaken((code) => { seen.push(code); return refuse-- > 0; });
  const ws = mkws();
  handleClientMessage(ws, { type: 'create', name: 'T', skin: 'olive', mode: 'duel', loadout: FIVE });
  const cr = frames(ws, 'created')[0];
  if (seen.length === 4 && cr && cr.code === seen[3])
    ok('(2b) makeCode offered every candidate to codeTaken and kept the first it did not refuse (3 refused, the 4th used)');
  else fail('(2b) offers=' + JSON.stringify(seen) + ' code=' + JSON.stringify(cr && cr.code));
  handleClientMessage(ws, { type: 'leave' });
  setCodeTaken(null);
}

// A HOST THAT WIRES NOTHING, AND A HOST THAT UNWIRES. setCodeTaken(null) must
// restore the refuse-nothing default rather than storing null and throwing on
// the next create — which is every room on a deploy where the social layer
// failed to build.
{
  let threw = null;
  const ws = mkws();
  try { handleClientMessage(ws, { type: 'create', name: 'T', skin: 'olive', mode: 'duel', loadout: FIVE }); }
  catch (e) { threw = e; }
  const cr = frames(ws, 'created')[0];
  if (!threw && cr && typeof cr.code === 'string' && cr.code.length === 4)
    ok('(2c) setCodeTaken(null) restored the refuse-nothing default');
  else fail('(2c) after setCodeTaken(null): threw=' + (threw && threw.message) + ' created=' + JSON.stringify(cr));
  handleClientMessage(ws, { type: 'leave' });
}

// ---- (3) server/social.js: the two frame types -----------------------------
{
  if (SOCIAL_TYPES.has('squad') && SOCIAL_TYPES.has('code'))
    ok('(3a) squad and code are in SOCIAL_TYPES — server.js intercepts them before the engine');
  else fail('(3a) SOCIAL_TYPES is ' + JSON.stringify([...SOCIAL_TYPES]));
  // The exact SIZE is test/social.mjs's assertion and stays there. This is
  // the squad side of the same fact, so a set that grew a type nobody meant
  // to add fails there and a type squads need fails here.
}

// A TRIPWIRE, NOT A PROOF, and said plainly the way test/display_name.mjs
// says it about its own source checks. Task 1 wrote these while the two wiring
// lines had no effect any test could observe — no squad could exist. Task 2
// made them observable, and the PROOF is now behavioural: test/code_frame.mjs
// (12) and (13) script the code bytes in a spawned server.js so each minter
// is made to try the other's live code, and go red with either line removed.
// These stay as the fast tripwire in front of that. The
// source is read — and read WITH COMMENTS STRIPPED and SCOPED TO THE BLOCK
// THAT BUILDS THE LAYER, the way test/house-rules.mjs reads the auth sink.
// Unstripped, a commented-out copy of the line, or a comment that merely
// quotes it, satisfied these regexes; unscoped, a copy wired outside that
// block would run on a deploy with no social layer at all (plan R14).
//
// What EXECUTES the same shapes is (2b) and (3g) here, which wire them by
// hand with the same expressions, and test/code_frame.mjs, which boots the
// real server.js with the layer on and mints rooms through the wired loop.
{
  const code = (src) => src.split('\n')
    .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
  const src = code(read('server.js'));
  if (/if \(SOCIAL_TYPES\.has\(msg\.type\)\) \{/.test(src))
    ok('(3b) server.js still routes on SOCIAL_TYPES alone — membership in that set IS interception');
  else fail('(3b) server.js no longer contains "if (SOCIAL_TYPES.has(msg.type)) {" — (3a) proves nothing without it');
  const from = src.indexOf('if (SB_URL && SB_SECRET) {');
  const to = src.indexOf('[boot] social off', from);
  const block = from >= 0 && to > from ? src.slice(from, to) : '';
  if (!block) fail('(3b) no "if (SB_URL && SB_SECRET) {" ... "[boot] social off" block in server.js — nothing below was checked');
  if (block && /roomExists: \(code\) => rooms\.has\(code\)/.test(block))
    ok('(3b) server.js injects roomExists as rooms.has, in live code inside the block that builds the layer');
  else fail('(3b) server.js does not inject "roomExists: (code) => rooms.has(code)" in live code inside the block that builds the layer — task 2\'s squad minter has no route to `rooms`');
  if (block && /^\s*setCodeTaken\(social\.hasSquad\);/m.test(block))
    ok('(3b) server.js wires the engine\'s codeTaken to the squad container, in live code inside the block that builds the layer');
  else fail('(3b) server.js does not call setCodeTaken(social.hasSquad) in live code inside the block that builds the layer — squad and room codes can collide');
}

// WHY INTERCEPTION IS NOT OPTIONAL, shown rather than asserted: hand both new
// frames to the engine and it answers neither and builds nothing.
{
  const ws = mkws();
  const before = rooms.size;
  handleClientMessage(ws, { type: 'squad', op: 'create' });
  handleClientMessage(ws, { type: 'code', code: 'ABCD' });
  if (ws._rx.length === 0 && rooms.size === before)
    ok('(3c) the room engine answers neither frame and creates nothing');
  else fail('(3c) the engine answered ' + JSON.stringify(ws._rx) + ' rooms ' + before + '->' + rooms.size);
}

// ---- (3f) the squad handler ------------------------------------------------
{
  const store = mkstore();
  const social = createSocial({ store, terms: TERMS, send, now, roomExists: (code) => rooms.has(code) });

  const w1 = mkws(UID);
  await social.handle(w1, { type: 'squad', op: 'nope', id: 's1' });
  if (same(last(w1), { type: 'squad', op: 'nope', error: 'unavailable', id: 's1' }))
    ok('(3f) an unknown squad op is ANSWERED with its op and id — a dropped frame holds the client\'s waiter 12 seconds');
  else fail('(3f) op "nope" answered ' + JSON.stringify(last(w1)));

  const w2 = mkws(UID);
  await social.handle(w2, { type: 'squad' });
  if (same(last(w2), { type: 'squad', op: 'unknown', error: 'unavailable' }))
    ok('(3f) a squad frame with no op answers op:"unknown", the spelling handleBlock uses');
  else fail('(3f) a frame with no op answered ' + JSON.stringify(last(w2)));

  // THE OPS TABLE HAS A NULL PROTOTYPE. With a plain object literal
  // SQUAD_OPS['constructor'] is Object — truthy — so the dispatch would call
  // it, it would return quietly, nothing would be sent, and the client would
  // wait out its full timeout.
  const w3 = mkws(UID);
  await social.handle(w3, { type: 'squad', op: 'constructor' });
  if (same(last(w3), { type: 'squad', op: 'constructor', error: 'unavailable' }))
    ok('(3f) op "constructor" is answered as an unknown op — the ops table inherits nothing');
  else fail('(3f) op "constructor" answered ' + JSON.stringify(last(w3)));

  // R3: THE GATE IS PER OP AND LIVES INSIDE THE HANDLER, not on the switch,
  // because `join` by code is open to a guest and the rest are not. An op
  // that does not exist has no gate to apply, so a socket with no account
  // gets the same unknown-op answer as anyone else — never
  // { type:'social', error:'sign_in' }, which would advertise ops this build
  // does not have.
  const guest = mkws(null);
  await social.handle(guest, { type: 'squad', op: 'nope' });
  if (same(last(guest), { type: 'squad', op: 'nope', error: 'unavailable' }))
    ok('(3f) an unknown squad op from a socket with no account is answered, not gated at the switch (R3)');
  else fail('(3f) an unauthenticated unknown op got ' + JSON.stringify(last(guest)));

  if (store.calls.length === 0) ok('(3f) no squad frame reached the store');
  else fail('(3f) a squad frame reached the store: ' + JSON.stringify(store.calls));
}

// ---- (3g) hasSquad, the one member server.js needs -------------------------
{
  const social = createSocial({ store: mkstore(), terms: TERMS, send, now, roomExists: () => false });
  if (typeof social.hasSquad !== 'function') {
    // SAID RATHER THAN THROWN. Calling a member that is not there would crash
    // the suite on this line and hide every check after it, section (4)
    // included — so the rest of (3g) is skipped, out loud.
    fail('(3g) createSocial returned ' + JSON.stringify(Object.keys(social)) + ' — no hasSquad, so the rest of (3g) did not run');
  } else {
    ok('(3g) createSocial hands out hasSquad — server.js has something to give setCodeTaken and the code frame');
    const odd = ['ABCD', 'constructor', '__proto__', ''].filter((c) => social.hasSquad(c) !== false);
    if (odd.length === 0) ok('(3g) hasSquad answers false for every string with no squad behind it, prototype keys included');
    else fail('(3g) hasSquad answered true for ' + JSON.stringify(odd));

    // Handed to the engine exactly as server.js hands it over. The loop must
    // still terminate and still mint a live code.
    setCodeTaken(social.hasSquad);
    const ws = mkws();
    handleClientMessage(ws, { type: 'create', name: 'T', skin: 'olive', mode: 'duel', loadout: FIVE });
    const cr = frames(ws, 'created')[0];
    if (cr && typeof cr.code === 'string' && cr.code.length === 4 && rooms.has(cr.code))
      ok('(3g) with hasSquad wired as codeTaken the engine still mints a live room code');
    else fail('(3g) create under a wired hasSquad produced ' + JSON.stringify(cr));
    handleClientMessage(ws, { type: 'leave' });
    setCodeTaken(null);
  }

  // WHAT TASK 1 COULD NOT PROVE HERE, and where task 2 proved it once a squad
  // could exist: (i) create, then has / get / ofUser — section (s1);
  // (ii) a live squad code answering { type:'code', kind:'squad' } from the
  // REAL server.js — test/code_frame.mjs (12); (iii) ofUser(null) with a
  // guest member present — section (s5); (iv) the other direction of R4, the
  // squad minter refusing a live room's code — section (r4) in process and
  // test/code_frame.mjs (13) against the real server.js.
}

// ---- (4) public/app.js mirrors the set (plan R15) --------------------------
// The third consumer. The server intercepting a frame is only half of it: the
// ANSWER has to reach socialReply, which owns the id matching and runs the
// waiter socialSend parked. A type missing from this block is not an error
// anywhere — the switch has no default — it is a button that reports
// 'unavailable' twelve seconds later from the client's own timer.
{
  const app = read('public/app.js');
  const m = app.match(/((?:\s*case '[a-z]+':)+)\s*socialReply\(m\);/);
  if (!m) {
    // SAID OUT LOUD RATHER THAN PASSED VACUOUSLY: if the block cannot be
    // found, nothing below ran and this section proved nothing.
    fail('(4) no run of case labels ending in socialReply(m) found in public/app.js — the mirror could not be located, so nothing was checked');
  } else {
    const labels = new Set([...m[1].matchAll(/case '([a-z]+)':/g)].map((x) => x[1]));
    const missing = [...SOCIAL_TYPES].filter((t) => !labels.has(t));
    if (missing.length === 0)
      ok(`(4) public/app.js routes every SOCIAL_TYPES frame to socialReply (${[...labels].join(', ')})`);
    else fail('(4) public/app.js never routes ' + JSON.stringify(missing) + ' — socialSend parks a waiter for each and nothing answers it');
  }
}

// ==========================================================================
// TASK 2 — the squad state machine and its socket handlers
// ==========================================================================
// The machine is imported DIRECTLY and the handlers are driven through a REAL
// createSocial. Nothing under test is stubbed: the store double stands in for
// PostgREST and a socket is an object with an rx array, which is the seam
// test/social.mjs already uses. Three suites in this project have shipped
// broken the same way — the thing under test replaced by a recorder, a mock
// that answered every query alike, a harness that supplied what the file was
// missing — so the rule for every line below is: if the behaviour were
// reverted, would this assertion fail?
const SQA = '00000000-0000-4000-8000-5a0000000001';
const SQB = '00000000-0000-4000-8000-5a0000000002';
const SQC = '00000000-0000-4000-8000-5a0000000003';
const SQD = '00000000-0000-4000-8000-5a0000000004';
const SQE = '00000000-0000-4000-8000-5a0000000005';
const SQCODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

let SQCLOCK = Date.parse('2026-09-22T10:00:00Z');
const sqnow = () => SQCLOCK;

// profilesByIds answers { id, callsign, callsign_key } and NOTHING ELSE — the
// three columns server/store.js really selects. A double handing back a whole
// row would let a name be proved against a column the real query never reads,
// which is the hole BINDING resolution 27 was opened for.
const SQ_PROFILES = new Map([
  [SQA, { id: SQA, callsign: 'Anvil Six', callsign_key: 'anvil six' }],
  [SQB, { id: SQB, callsign: 'Bunker Nine', callsign_key: 'bunker nine' }],
  [SQC, { id: SQC, callsign: 'Crater Two', callsign_key: 'crater two' }],
  // Free text with no key beside it: displayName cannot vouch for it and
  // answers null, and the ROW has to survive that.
  [SQD, { id: SQD, callsign: 'FOLLOW ME OK', callsign_key: null }],
  [SQE, { id: SQE, callsign: 'Echo Seven', callsign_key: 'echo seven' }],
]);
// `boom` fails the lookup whenever the asked-for ids include one of its
// members, so a test can fail ONE squad's snapshot and not another's.
function sqstore() {
  const st = {
    calls: [], boom: new Set(),
    async profilesByIds(ids) {
      st.calls.push(['profilesByIds', [...ids]]);
      if (ids.some((id) => st.boom.has(id))) throw new Error('sb GET 500');
      const m = new Map();
      for (const id of ids) { const p = SQ_PROFILES.get(id); if (p) m.set(id, { ...p }); }
      return m;
    },
  };
  return st;
}
const sqws = (userId = null, isGuest = false) => ({ readyState: 1, userId, isGuest, rx: [] });
const sqf = (ws, op) => ws.rx.filter((m) => m.type === 'squad' && (!op || m.op === op));
const sqlast = (ws, op) => { const f = sqf(ws, op); return f[f.length - 1] || null; };
// The same, as an object to read a field off: a missing frame then FAILS the
// assertion it was for instead of throwing and taking every later section
// with it.
const sqat = (ws, op) => sqlast(ws, op) || {};
// THE SEND server.js REALLY USES, down to the wire: nothing reaches a socket
// that is not open, and what does reach it has been through JSON — so a frame
// that carried a socket or shared an array with another destination's frame
// could not pass here and fail in production.
//
// AND THE ENGINE'S OWN SEAT TABLE, TEE SETS AND RACK PREDICATE, wired exactly
// as server.js wires them (task 3). Nothing here is a stand-in: if the numbers
// the room enforces change, `fits`, the mode vetting and the rack check change
// with them. `extra` can take them away again, to see the defaults fail closed.
const sqSocial = (store, extra = {}) => createSocial({
  seats: MODE_SEATS, teeIds: TEE_IDS, validRack: validRackFor,
  ...extra, store, terms: [], now: sqnow,
  send: (ws, frame) => { if (ws && ws.readyState === 1) ws.rx.push(JSON.parse(JSON.stringify(frame))); },
});
// A LINKED socket as server.js leaves it after a verified hello: counted in
// presence by onAuth, which is what a member row's `online` reads.
const sqUp = (S, ws) => { S.onAuth(ws); return ws; };
const sqMachine = (opts = {}) => createSquads({ now: sqnow, capacity: 4, ...opts });
const sqM = (userId, ws) => ({ userId, guest: false, name: 'Rolling Thunder', skin: 'olive', ws });
const sqG = (ws, name = 'Guest One') => ({ userId: null, guest: true, name, skin: 'gold', ws });
const noWs = (k, v) => (k === 'ws' || k === 'key' ? '<ref>' : v);

// ---- (s1) create: the fixed shape, and the creator leads ------------------
{
  const S = sqMachine();
  const wa = sqws(SQA);
  const sq = S.create(sqM(SQA, wa));
  const m0 = sq && sq.members && sq.members[0];
  if (sq && SQCODE_RE.test(sq.code) && sq.leader === SQA && sq.created === SQCLOCK
    && sq.mode === 'duel' && sq.tees === null && sq.max === null && sq.members.length === 1
    && m0.userId === SQA && m0.guest === false && m0.ws === wa && m0.ready === false
    && m0.loadout === null && m0.joinedAt === SQCLOCK && m0.dropAt === null)
    ok('(s1) create builds the squad shape the plan fixes, with the creator leading');
  else fail('(s1) create returned ' + JSON.stringify(sq, noWs));
  if (S.has(sq.code) && S.get(sq.code) === sq && S.ofUser(SQA) === sq)
    ok('(s1) the new squad is reachable by code and by its member');
  else fail('(s1) has/get/ofUser disagreed after create');
  // CREATE IS ALSO A LEAVE. A player already in a squad who creates another
  // is out of the first: off its roster, and its leadership handed on —
  // otherwise one account would be a member of two squads and the leader of
  // one it can no longer see.
  const wb = sqws(SQB);
  S.join(sq.code, sqM(SQB, wb));
  const next = S.create(sqM(SQA, wa));
  if (next !== sq && S.ofUser(SQA) === next && sq.members.length === 1 && sq.members[0].userId === SQB && sq.leader === SQB && S.has(sq.code))
    ok('(s1) creating while in a squad leaves it first: off its roster, leadership handed on');
  else fail('(s1) create-while-in-a-squad: old roster ' + JSON.stringify(sq.members.map((m) => m.userId)) + ', old leader ' + sq.leader);
  // A SQUAD IS ALWAYS LED BY AN ACCOUNT, and the machine holds that rule
  // itself rather than trusting the one gate in front of it. A guest's create
  // is refused with no squad, no index entry and no code spent — and a guest
  // already in a squad keeps it, because a refusal must cost nothing.
  const T = sqMachine();
  const g = sqws(null), g2 = sqws('00000000-0000-4000-8000-a00000000009', true);
  const host = T.create(sqM(SQC, sqws(SQC)));
  T.join(host.code, sqG(g2));
  const spent = scriptCodeBytes([]);
  let refusedA;
  try { refusedA = T.create(sqG(g)); } finally { spent.restore(); }
  const refusedB = T.create(sqG(g2));
  const refusedC = T.create({ userId: null, guest: false, name: 'X', skin: null, ws: sqws(null) });
  if (refusedA === null && spent.oneByte === 0 && refusedB === null && refusedC === null && T.ofUser(g) === null
    && T.ofUser(g2) === host && host.members.length === 2 && host.leader === SQC)
    ok('(s1) create refuses a guest — no squad is ever led by null — and the refused guest keeps the squad they had');
  else fail('(s1) guest create: ' + JSON.stringify([refusedA, refusedB, refusedC], noWs) + ', bytes drawn ' + spent.oneByte + ', host members ' + host.members.length);
}

// ---- (s2) the code minter: one byte a character, one namespace -------------
// PROVED ON SCRIPTED BYTES, never by looking at random codes: a minted code
// that merely "was not" some refused string passes almost every time with
// the refusal deleted. scriptCodeBytes serves one-byte requests from a list
// and COUNTS them, so each assertion below also says how many draws the mint
// took — which is what pins "one byte per character" and catches anything
// else that drew a byte first. Always restored, even if a create throws.
{
  const mint = (bytes, fn) => {
    const hook = scriptCodeBytes(bytes);
    try { return { got: fn(), hook }; } finally { hook.restore(); }
  };
  const engineChars = (read('public/room-engine.js').match(/const CODE_CHARS = '([A-Z0-9]+)';/) || [])[1] || '';

  // IMPORTING THE HELPER NEVER ARMS IT, whatever the environment says — this
  // suite imports it in process, and a CC_TEST_CODE_BYTES left in somebody's
  // shell must not script its codes. Only the preload entry arms, and it
  // does. Fresh module instances (a query string) so both loads really run.
  // THE PRELOAD ANNOUNCES ITSELF ON STDERR, which is right in a spawned
  // server and noise in this suite's output, so stderr is CAPTURED for the
  // length of the probe — and what it caught is asserted, which is also the
  // proof that the preload really loaded and armed rather than merely that
  // something set the property.
  {
    const own = () => Object.prototype.hasOwnProperty.call(globalThis.crypto, 'getRandomValues');
    const was = process.env.CC_TEST_CODE_BYTES;
    const write = process.stderr.write;
    const caught = [];
    process.env.CC_TEST_CODE_BYTES = '0,1,2,3';
    process.stderr.write = (chunk) => { caught.push(String(chunk)); return true; };
    let helperArmed = null, preloadArmed = null;
    try {
      await import('./fixtures/scripted-code-bytes.mjs?probe=' + Date.now());
      helperArmed = own();
      await import('./fixtures/scripted-code-bytes-preload.mjs?probe=' + Date.now());
      preloadArmed = own();
    } finally {
      process.stderr.write = write;
      delete globalThis.crypto.getRandomValues;
      if (was === undefined) delete process.env.CC_TEST_CODE_BYTES; else process.env.CC_TEST_CODE_BYTES = was;
    }
    if (helperArmed === false && preloadArmed === true && !own() && caught.join('') === '[code-bytes] armed 4\n')
      ok('(s2) importing the helper arms nothing even with CC_TEST_CODE_BYTES set; only the preload entry arms, and says so on the stderr this probe captured');
    else fail('(s2) arming: helper ' + helperArmed + ', preload ' + preloadArmed + ', stderr caught ' + JSON.stringify(caught));
  }
  // THE HOOK IS PROVED BEFORE ANYTHING RELIES ON IT. "ABCD" out of a real
  // CSPRNG is one chance in 923,521.
  {
    const { got, hook } = mint([0, 1, 2, 3], () => sqMachine().create(sqM(SQA, sqws(SQA))).code);
    if (got === 'ABCD' && hook.oneByte === 4 && hook.scripted === 4 && hook.real === 0)
      ok('(s2) bytes 0,1,2,3 mint "ABCD" — one one-byte draw per character, and nothing else drew one');
    else fail('(s2) bytes 0,1,2,3 minted ' + JSON.stringify(got) + ' in ' + JSON.stringify(hook));
  }
  // THE REJECTION LIMIT. 248 and 255 fold onto 'A' and 'H' under a bare
  // `% 31`; drawn again, they cost two extra draws and change nothing.
  {
    const { got, hook } = mint([248, 0, 255, 1, 2, 3], () => sqMachine().create(sqM(SQA, sqws(SQA))).code);
    if (got === 'ABCD' && hook.oneByte === 6 && hook.real === 0)
      ok('(s2) a byte of 248 or more is drawn again, not folded onto the alphabet — the draw stays uniform');
    else fail('(s2) bytes 248,0,255,1,2,3 minted ' + JSON.stringify(got) + ' in ' + JSON.stringify(hook));
  }
  // THE ALPHABET, character for character and in the engine's order. Bytes 0
  // to 30 then 0 again, across eight creators, must spell the engine's
  // CODE_CHARS followed by 'A' — a copy that lost, gained or reordered one
  // character would spell something else.
  {
    const S = sqMachine();
    const { got } = mint([...Array(31).keys(), 0], () => Array.from({ length: 8 }, (_, i) => S.create(sqM('u' + i, sqws('u' + i))).code));
    if (engineChars.length === 31 && got.join('') === engineChars + 'A')
      ok('(s2) the squad alphabet is the engine\'s CODE_CHARS, in the engine\'s order: ' + got.join(' '));
    else fail('(s2) bytes 0..30,0 minted ' + JSON.stringify(got) + ' against the engine\'s ' + JSON.stringify(engineChars));
  }
  // THE SAME BYTES MINT THE SAME ROOM CODE IN THE ENGINE, which is what lets
  // one hook steer both minters in test/code_frame.mjs.
  {
    const ws = mkws();
    const pre = rooms.has('ABCD');
    const { hook } = mint([0, 1, 2, 3], () => handleClientMessage(ws, { type: 'create', name: 'T', skin: 'olive', mode: 'duel', loadout: FIVE }));
    const cr = frames(ws, 'created')[0];
    if (!pre && cr && cr.code === 'ABCD' && hook.oneByte === 4 && hook.real === 0)
      ok('(s2) the engine\'s makeCode turns the same four bytes into the same "ABCD", with no other one-byte draw on the create path');
    else fail('(s2) the engine minted ' + JSON.stringify(cr && cr.code) + ' from 0,1,2,3 (ABCD held before: ' + pre + ') in ' + JSON.stringify(hook));
    handleClientMessage(ws, { type: 'leave' });
  }
  // A CODE THIS CONTAINER HOLDS IS REFUSED. Without it the second create
  // would take "ABCD" and overwrite the first squad in the map.
  {
    const S = sqMachine();
    const { got: [a, b], hook } = mint([0, 1, 2, 3, 0, 1, 2, 3, 4, 5, 6, 7],
      () => [S.create(sqM(SQA, sqws(SQA))), S.create(sqM(SQB, sqws(SQB)))]);
    if (a.code === 'ABCD' && b.code === 'EFGH' && S.get('ABCD') === a && S.get('EFGH') === b && hook.oneByte === 12)
      ok('(s2) a code a live squad holds is refused and the next candidate drawn');
    else fail('(s2) second squad on the same bytes took ' + JSON.stringify(b && b.code) + '; ABCD is ' + (S.get('ABCD') === a ? 'the first squad' : 'NOT the first squad'));
  }
  // A CODE codeTaken NAMES IS REFUSED — in production, a live room's code
  // (plan R4's other direction; test/code_frame.mjs proves the wiring).
  {
    const asked = [];
    const S = sqMachine({ codeTaken: (c) => { asked.push(c); return c === 'ABCD'; } });
    const { got } = mint([0, 1, 2, 3, 4, 5, 6, 7], () => S.create(sqM(SQA, sqws(SQA))).code);
    if (got === 'EFGH' && JSON.stringify(asked) === '["ABCD","EFGH"]')
      ok('(s2) a candidate codeTaken refuses is skipped, and every candidate is offered to it');
    else fail('(s2) with codeTaken refusing ABCD the squad took ' + JSON.stringify(got) + ', offered ' + JSON.stringify(asked));
  }
}

// ---- (s3) join: unknown code, the cap, and the cost of a refusal ----------
{
  const S = sqMachine();
  const host = S.create(sqM(SQA, sqws(SQA)));
  const miss = S.join('ZZZZ', sqM(SQB, sqws(SQB)));
  if (miss.ok === false && miss.error === 'no_such_squad' && miss.squad === null)
    ok('(s3) an unknown code answers no_such_squad and hands back no squad');
  else fail('(s3) unknown code: ' + JSON.stringify(miss, noWs));
  for (const id of [SQB, SQC, SQD]) S.join(host.code, sqM(id, sqws(id)));
  if (host.members.length === 4 && S.ofUser(SQD) === host) ok('(s3) four members fill the squad');
  else fail('(s3) after three joins: ' + host.members.length);
  // THE FIFTH IS REFUSED, AND E MUST STILL BE IN THE SQUAD THEY HAD. The
  // ordinary shape of this bug is leave-then-check instead of check-then-leave:
  // the join fails and the player is left with nothing.
  const we = sqws(SQE);
  const mine = S.create(sqM(SQE, we));
  const full = S.join(host.code, sqM(SQE, we));
  if (full.ok === false && full.error === 'full' && full.squad === host && host.members.length === 4)
    ok('(s3) the fifth member is refused full, against the squad they aimed at');
  else fail('(s3) fifth join: ' + JSON.stringify(full, noWs));
  if (S.ofUser(SQE) === mine && mine.members.length === 1 && S.has(mine.code))
    ok('(s3) a refused join costs the joiner nothing: their own squad is intact');
  else fail('(s3) a refused join emptied the squad the joiner already had');
  // AND A JOIN THAT LANDS MOVES THE PLAYER: out of the old squad, which goes
  // with them when they were its only member, and into the new one.
  const T = sqMachine();
  const t1 = T.create(sqM(SQA, sqws(SQA)));
  const t2 = T.create(sqM(SQB, sqws(SQB)));
  const moved = T.join(t1.code, sqM(SQB, sqws(SQB)));
  if (moved.ok === true && moved.squad === t1 && T.ofUser(SQB) === t1 && T.has(t2.code) === false && t1.members.length === 2)
    ok('(s3) joining another squad leaves the old one first, and an emptied squad is deleted');
  else fail('(s3) move: ofUser ' + (T.ofUser(SQB) === t1) + ', old squad kept ' + T.has(t2.code));
}

// ---- (s4) joining the squad you already lead changes nothing --------------
{
  const S = sqMachine();
  const wa = sqws(SQA);
  const sq = S.create(sqM(SQA, wa));
  S.join(sq.code, sqM(SQB, sqws(SQB)));
  const again = S.join(sq.code, sqM(SQA, sqws(SQA)));
  if (again.ok === true && again.squad === sq && sq.members.length === 2 && sq.leader === SQA && sq.members[0].ws === wa)
    ok('(s4) re-joining your own squad is a no-op: it does not hand the squad away or swap the socket');
  else fail('(s4) re-join: members ' + sq.members.length + ', leader ' + sq.leader);
}

// ---- (s5) a guest is a member with no account id and an unforgeable key ----
{
  const S = sqMachine();
  const wa = sqws(SQA);
  const sq = S.create(sqM(SQA, wa));
  const g1 = sqws(null, false);              // never signed in at all
  const g2 = sqws('anon-account-id', true);  // an ANONYMOUS account is a guest too
  S.join(sq.code, sqG(g1, 'FOLLOW ME OK'));
  S.join(sq.code, sqG(g2, 'Guest Two'));
  const rows = sq.members.slice(1);
  if (rows.length === 2 && rows.every((m) => m.userId === null && m.guest === true))
    ok('(s5) a guest row carries userId null and guest true, anonymous account or not');
  else fail('(s5) guest rows: ' + JSON.stringify(rows.map((m) => [m.userId, m.guest])));
  if (S.ofUser(g1) === sq && S.ofUser(g2) === sq && rows.length === 2 && rows[0].key !== rows[1].key)
    ok('(s5) each guest resolves by the socket they joined on, and no two share a key');
  else fail('(s5) guest keys collided or did not resolve');
  // NOTHING OFF THE WIRE CAN BE ONE. A frame carries strings, numbers, arrays
  // and objects the client authored; it can never carry a value that is === a
  // socket this server owns. ofUser(null) is the case task 1 left to this
  // task: with guests present it must still find nobody.
  if (S.ofUser(null) === null && S.ofUser('anon-account-id') === null && S.ofUser({}) === null && S.ofUser(undefined) === null)
    ok('(s5) no value a client could send resolves to a guest member — ofUser(null) included');
  else fail('(s5) a forged guest key resolved');
  // THE NULL-KEY FALLBACK, exercised directly, in a squad with room for it:
  // two guests with no socket must still be two members, not one that
  // evicted the other.
  const T = sqMachine();
  const t = T.create(sqM(SQA, sqws(SQA)));
  const h1 = T.join(t.code, sqG(null, 'A')); const h2 = T.join(t.code, sqG(null, 'B'));
  const tail = t.members.slice(1);
  if (h1.ok && h2.ok && tail.length === 2 && tail[0].key !== tail[1].key && tail[0].key !== null
    && T.ofUser(tail[0].key) === t && T.ofUser(tail[1].key) === t)
    ok('(s5) a socketless guest still gets a key of its own');
  else fail('(s5) socketless guests collided: ' + JSON.stringify(tail.map((m) => m.name)));
}

// ---- (s6) leave: hand-off by joinedAt, the index, and the last member -----
{
  const S = sqMachine();
  const sq = S.create(sqM(SQA, sqws(SQA)));
  SQCLOCK += 10; S.join(sq.code, sqM(SQC, sqws(SQC)));
  SQCLOCK += 10; S.join(sq.code, sqM(SQB, sqws(SQB)));
  // THE RULE IS joinedAt, NOT POSITION, and a roster built by appending can
  // never tell them apart — so separate them by hand. The last row in the
  // array is now the earliest joiner, and it must inherit.
  sq.members[2].joinedAt = SQCLOCK - 1000;
  const out = S.leave(SQA);
  if (out.squad === sq && out.ended === false && out.newLeader === SQB && sq.leader === SQB)
    ok('(s6) the leader leaving hands the squad to the EARLIEST joinedAt survivor, not the first row');
  else fail('(s6) hand-off: ' + JSON.stringify({ ended: out.ended, newLeader: out.newLeader, leader: sq.leader }));
  if (S.ofUser(SQA) === null && sq.members.length === 2)
    ok('(s6) the leaver is out of the roster and out of the index');
  else fail('(s6) the leaver was left behind: members ' + sq.members.length + ', ofUser ' + (S.ofUser(SQA) ? 'still finds them' : 'null'));
  const none = S.leave(SQA);
  if (none.squad === null && none.ended === false && none.newLeader === null)
    ok('(s6) leaving when you are in no squad answers that nothing happened');
  else fail('(s6) second leave: ' + JSON.stringify(none, noWs));
  // A MEMBER WHO IS NOT THE LEADER LEAVING CHANGES NO LEADER.
  const T = sqMachine();
  const t = T.create(sqM(SQA, sqws(SQA)));
  T.join(t.code, sqM(SQC, sqws(SQC)));
  T.join(t.code, sqM(SQB, sqws(SQB)));
  const plain = T.leave(SQB);
  if (plain.ended === false && plain.newLeader === null && t.leader === SQA && t.members.length === 2)
    ok('(s6) a member leaving leaves the leader where they are');
  else fail('(s6) member leave: ' + JSON.stringify({ ended: plain.ended, newLeader: plain.newLeader, leader: t.leader }));
  // A TIE GOES TO THE EARLIER ROW. With an injected clock two joins in the
  // same millisecond are the ordinary case, and production can do it too.
  T.join(t.code, sqM(SQB, sqws(SQB)));
  if (T.leave(SQA).newLeader === SQC) ok('(s6) equal joinedAt goes to the member already earlier in the roster');
  else fail('(s6) tie-break picked ' + t.leader);
  S.leave(SQB);
  const last = S.leave(SQC);
  if (last.ended === true && last.squad === sq && S.has(sq.code) === false && S.ofUser(SQC) === null)
    ok('(s6) the last member takes the squad with them, out of both maps');
  else fail('(s6) last leave: ended ' + last.ended + ', has ' + S.has(sq.code));
}

// ---- (s7) a squad with nobody left who can lead it ends --------------------
{
  const S = sqMachine();
  const g1 = sqws(null), g2 = sqws(null);
  const sq = S.create(sqM(SQA, sqws(SQA)));
  S.join(sq.code, sqG(g1)); S.join(sq.code, sqG(g2));
  const out = S.leave(SQA);
  if (out.ended === true && out.newLeader === null && S.has(sq.code) === false)
    ok('(s7) a squad with no signed-in survivor ends rather than standing there unable to do anything');
  else fail('(s7) all-guest squad: ended ' + out.ended + ', newLeader ' + out.newLeader + ', has ' + S.has(sq.code));
  if (out.squad === sq && sq.members.length === 2 && S.ofUser(g1) === null && S.ofUser(g2) === null)
    ok('(s7) the guests it ended under are still on the returned list, so they can be told, and out of the index');
  else fail('(s7) ended squad: members ' + sq.members.length + ', indexed ' + !!S.ofUser(g1));
  // AND A GUEST LEAVING NEVER RUNS THE HAND-OFF: the leader stays put.
  const T = sqMachine();
  const g = sqws(null);
  const t = T.create(sqM(SQA, sqws(SQA)));
  T.join(t.code, sqG(g));
  const gone = T.leave(g);
  if (gone.squad === t && gone.ended === false && gone.newLeader === null && t.leader === SQA && t.members.length === 1 && T.ofUser(g) === null)
    ok('(s7) a guest leaves by their socket key and the leader is untouched');
  else fail('(s7) guest leave: ' + JSON.stringify({ ended: gone.ended, leader: t.leader, n: t.members.length }));
}

// ---- (s8) kick: leader only, and the leader is not a target ---------------
{
  const S = sqMachine();
  const wa = sqws(SQA), wb = sqws(SQB), g = sqws(null);
  const sq = S.create(sqM(SQA, wa));
  S.join(sq.code, sqM(SQB, wb)); S.join(sq.code, sqG(g));
  const notLeader = S.kick(sq.code, SQB, SQA);
  if (notLeader.ok === false && notLeader.error === 'not_leader' && sq.members.length === 3)
    ok('(s8) a member cannot kick, and the roster is untouched by the attempt');
  else fail('(s8) member kick: ' + JSON.stringify(notLeader, noWs));
  const self = S.kick(sq.code, SQA, SQA);
  if (self.ok === false && self.error === 'no_such_member' && sq.members.length === 3 && sq.leader === SQA)
    ok('(s8) the leader is not among the targets a kick can name');
  else fail('(s8) self kick: ' + JSON.stringify(self, noWs));
  const guest = S.kick(sq.code, SQA, g);
  if (guest.ok === true && guest.squad === sq && sq.members.length === 2 && S.ofUser(g) === null)
    ok('(s8) a guest is kicked by the key their socket is, and leaves the index with the roster');
  else fail('(s8) guest kick: ' + JSON.stringify(guest, noWs));
  const ghost = S.kick(sq.code, SQA, SQE);
  if (ghost.ok === false && ghost.error === 'no_such_member' && ghost.squad === sq)
    ok('(s8) kicking somebody who is not in the squad answers no_such_member');
  else fail('(s8) ghost kick: ' + JSON.stringify(ghost, noWs));
  // A STALE LEADER AFTER A HAND-OFF. A is the leader, leaves, B inherits; a
  // frame from A that was already in flight must not still command.
  S.leave(SQA);
  const stale = S.kick(sq.code, SQA, SQB);
  if (stale.ok === false && stale.error === 'not_leader' && sq.leader === SQB && sq.members.length === 1)
    ok('(s8) a stale leader is not a leader');
  else fail('(s8) stale leader: ' + JSON.stringify(stale, noWs) + ' leader ' + sq.leader);
  if (S.kick('ZZZZ', SQB, SQB).error === 'not_leader') ok('(s8) a kick against a squad that does not exist answers not_leader');
  else fail('(s8) kick against an unknown code did not answer not_leader');
  // A LEADER OF null MUST NEVER MATCH A CALLER OF null. Unreachable through
  // this surface as it stands — create refuses a guest and the hand-off only
  // ever picks an account — so the squad is put in that state BY HAND, the
  // way a later caller's bug would leave it. A signed-in member is in the
  // squad, because that is who a null caller could otherwise remove.
  const N = sqMachine();
  const n = N.create(sqM(SQA, sqws(SQA)));
  N.join(n.code, sqM(SQB, sqws(SQB)));
  n.leader = null;
  const nk = N.kick(n.code, null, SQB);
  if (n.leader === null && nk.ok === false && nk.error === 'not_leader' && n.members.length === 2 && N.ofUser(SQB) === n)
    ok('(s8) a squad with a null leader cannot be commanded by a caller with no account');
  else fail('(s8) a null leader was matched: ' + JSON.stringify(nk, noWs) + ', members ' + n.members.length);
}

// ---- (s9) removeMember: the same rules, reached from somebody else's block -
{
  const S = sqMachine();
  const sq = S.create(sqM(SQA, sqws(SQA)));
  SQCLOCK += 5; S.join(sq.code, sqM(SQB, sqws(SQB)));
  const r = S.removeMember(sq.code, SQA);
  if (r.ended === false && r.squad === sq && sq.leader === SQB && sq.members.length === 1 && S.ofUser(SQA) === null)
    ok('(s9) removeMember runs the same hand-off leave does, reached by code and account id');
  else fail('(s9) removeMember: ' + JSON.stringify({ ended: r.ended, leader: sq.leader, n: sq.members.length }));
  // BY CODE, NOT BY WHEREVER THE PLAYER IS NOW. A teardown aimed at one squad
  // must not reach into another the player has since moved to.
  const other = S.create(sqM(SQC, sqws(SQC)));
  const wrong = S.removeMember(sq.code, SQC);
  if (wrong.squad === null && wrong.ended === false && S.ofUser(SQC) === other && other.members.length === 1)
    ok('(s9) removeMember against a squad the player is not in touches nothing');
  else fail('(s9) removeMember reached another squad: ' + JSON.stringify(wrong, noWs));
  const last = S.removeMember(sq.code, SQB);
  if (last.ended === true && S.has(sq.code) === false) ok('(s9) removing the last member deletes the squad');
  else fail('(s9) last removeMember: ended ' + last.ended);
  const gone = S.removeMember(sq.code, SQB);
  if (gone.squad === null && gone.ended === false) ok('(s9) removeMember on a squad that is gone answers nothing happened');
  else fail('(s9) removeMember after deletion: ' + JSON.stringify(gone, noWs));
}

// ---- (s11) the caller's row is found by SOCKET, and a move leaves it -------
// A socket's row and its signed-in account are not always the same key: a
// guest who signs in on the same socket still holds a GUEST row, keyed by
// that socket, while the account now names somebody the squad has never
// seen. keyOfSocket finds the row a socket IS; create and join take it as
// `fromKey` and leave it, so one socket is never two members.
{
  const S = sqMachine();
  const wa = sqws(SQA), g = sqws(null), stranger = sqws(SQE);
  const sq = S.create(sqM(SQA, wa));
  S.join(sq.code, sqG(g));
  if (S.keyOfSocket(g) === g && S.keyOfSocket(wa) === SQA && S.keyOfSocket(stranger) === null && S.keyOfSocket(null) === null && S.keyOfSocket(undefined) === null)
    ok('(s11) keyOfSocket names the row a socket holds — a guest\'s socket, an account\'s id — and nothing for a stranger or null');
  else fail('(s11) keyOfSocket: ' + JSON.stringify([S.keyOfSocket(g) === g, S.keyOfSocket(wa), S.keyOfSocket(stranger), S.keyOfSocket(null)]));
  // The guest signs in as B on the same socket, and creates.
  const mine = S.create(sqM(SQB, g), g);
  if (mine && mine !== sq && mine.leader === SQB && sq.members.length === 1 && sq.members[0].userId === SQA
    && S.ofUser(g) === null && S.ofUser(SQB) === mine && S.keyOfSocket(g) === SQB)
    ok('(s11) create with fromKey leaves the caller\'s guest row: one socket, one row, in the new squad only');
  else fail('(s11) create from a guest row: old roster ' + JSON.stringify(sq.members.map((m) => m.userId)) + ', ofUser(g) ' + !!S.ofUser(g));
  // JOIN with fromKey: the old row goes only AFTER the cap check.
  const T = sqMachine();
  const h = sqws(null);
  const t1 = T.create(sqM(SQA, sqws(SQA)));
  T.join(t1.code, sqG(h));
  const t2 = T.create(sqM(SQC, sqws(SQC)));
  for (const id of [SQD, SQE]) T.join(t2.code, sqM(id, sqws(id)));
  T.join(t2.code, sqG(sqws(null)));
  const full = T.join(t2.code, sqM(SQB, h), h);
  if (full.ok === false && full.error === 'full' && T.ofUser(h) === t1 && t1.members.length === 2)
    ok('(s11) a join refused full keeps the caller\'s old row, whichever key it is under');
  else fail('(s11) full join from a guest row: ' + JSON.stringify(full, noWs) + ', still in t1 ' + (T.ofUser(h) === t1));
  T.leave(SQE);
  const moved = T.join(t2.code, sqM(SQB, h), h);
  if (moved.ok && T.ofUser(h) === null && T.ofUser(SQB) === t2 && t1.members.length === 1 && T.keyOfSocket(h) === SQB)
    ok('(s11) a join with fromKey leaves the caller\'s guest row and adds the account row');
  else fail('(s11) join from a guest row: t1 roster ' + t1.members.length + ', ofUser(h) ' + !!T.ofUser(h));
  // JOINING THE SQUAD THE SOCKET IS ALREADY IN changes nothing: the squad
  // keeps the row it has, and no seat is spent on a second one.
  const U = sqMachine();
  const k = sqws(null);
  const u = U.create(sqM(SQA, sqws(SQA)));
  U.join(u.code, sqG(k));
  const same2 = U.join(u.code, sqM(SQB, k), k);
  if (same2.ok && same2.squad === u && u.members.length === 2 && u.members[1].guest === true && U.ofUser(SQB) === null)
    ok('(s11) joining the squad the socket is already in is a no-op, not a second row');
  else fail('(s11) re-join from a guest row: members ' + u.members.length);
}

// ---- (h1) the snapshot: proved names, a guest row, and one round trip -----
{
  const st = sqstore(); const S = sqSocial(st);
  const wa = sqUp(S, sqws(SQA)), wd = sqUp(S, sqws(SQD)), g = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create', id: 'c1' });
  const code = (sqlast(wa, 'state') || {}).code;
  await S.handle(wd, { type: 'squad', op: 'join', code, id: 'j1' });
  st.calls.length = 0;
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'FOLLOW ME OK', skin: 'gold', id: 'j2' });
  const seen = sqlast(wa, 'state');
  if (seen && seen.type === 'squad' && seen.op === 'state' && seen.code === code && seen.leader === SQA
    && seen.mode === 'duel' && seen.tees === null && seen.max === null && seen.you === 0
    && same(seen.fits, { duel: false, ffa: true, boss: false, aliens: false, golf: true }))
    ok('(h1) the snapshot is the frame the plan fixes, with `you` per destination');
  else fail('(h1) frame: ' + JSON.stringify(seen));
  const rows = seen && seen.members;
  if (rows && rows.length === 3
    && JSON.stringify(rows[0]) === JSON.stringify({ id: SQA, callsign: 'Anvil Six', guest: false, online: true, ready: false, dropped: false })
    && JSON.stringify(rows[1]) === JSON.stringify({ id: SQD, callsign: null, guest: false, online: true, ready: false, dropped: false })
    && JSON.stringify(rows[2]) === JSON.stringify({ id: null, callsign: null, guest: true, online: true, ready: false, dropped: false }))
    ok('(h1) a proved name is shown, an unprovable one keeps its row as null, and a guest row is null and flagged');
  else fail('(h1) rows: ' + JSON.stringify(rows));
  // THE NAME THE GUEST SENT NEVER LEAVES THE SERVER. It arrived off the wire
  // on a socket with no account behind it and nothing to prove it against.
  if (!JSON.stringify(wa.rx).includes('FOLLOW ME OK') && !JSON.stringify(wd.rx).includes('FOLLOW ME OK') && !JSON.stringify(g.rx).includes('FOLLOW ME OK'))
    ok('(h1) the name a guest sent reaches no member, the guest included');
  else fail('(h1) a guest smuggled free text onto a screen: ' + JSON.stringify(sqlast(wa, 'state')));
  // ONE profilesByIds FOR THE WHOLE FAN-OUT, holding the SIGNED-IN ids only.
  const many = st.calls.filter((c) => c[0] === 'profilesByIds');
  if (many.length === 1 && JSON.stringify(many[0][1]) === JSON.stringify([SQA, SQD]))
    ok('(h1) one round trip for the whole squad, and a guest costs no lookup');
  else fail('(h1) profilesByIds calls: ' + JSON.stringify(many));
  // `online` IS PRESENCE FOR AN ACCOUNT AND THE SOCKET FOR A GUEST. D's last
  // socket closes and the guest's goes; the next roster says so, and both
  // rows are still there.
  S.onClose(wd); g.readyState = 3;
  const wb = sqUp(S, sqws(SQB));
  await S.handle(wb, { type: 'squad', op: 'join', code });
  const now4 = (sqlast(wa, 'state') || {}).members || [];
  if (now4.length === 4 && now4[1].id === SQD && now4[1].online === false && now4[2].guest === true && now4[2].online === false && now4[0].online === true)
    ok('(h1) online follows the account\'s presence and a guest\'s own socket, and an offline row keeps its place');
  else fail('(h1) online after D and the guest went: ' + JSON.stringify(now4));
  if (sqf(g).length === 1) ok('(h1) nothing is sent down a socket that is no longer open');
  else fail('(h1) the closed guest socket was sent ' + sqf(g).length + ' frames');
}

// ---- (h2) create and join answer the actor and tell everyone else ---------
{
  const st = sqstore(); const S = sqSocial(st);
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB));
  await S.handle(wa, { type: 'squad', op: 'create', id: 'c1' });
  const mine = sqlast(wa, 'state');
  if (mine && mine.id === 'c1' && mine.you === 0 && mine.members.length === 1 && wa.rx.length === 1)
    ok('(h2) create answers the creator once, with the request id echoed');
  else fail('(h2) create reply: ' + JSON.stringify(wa.rx));
  wa.rx.length = 0;
  // Lower case with spaces round it: the one normalisation, codeOf.
  await S.handle(wb, { type: 'squad', op: 'join', code: '  ' + ((mine && mine.code) || '').toLowerCase() + ' ', id: 'j1' });
  const joiner = sqlast(wb, 'state'), sitting = sqlast(wa, 'state');
  if (joiner && joiner.id === 'j1' && joiner.you === 1 && sitting && sitting.you === 0 && sitting.id === undefined && sitting.members.length === 2)
    ok('(h2) a join answers the joiner and pushes the member already there a snapshot with no id on it');
  else fail('(h2) join: joiner ' + JSON.stringify(joiner) + ' sitting ' + JSON.stringify(sitting));
  const bad = [];
  for (const frame of [{ op: 'join', code: 'ZZZZ' }, { op: 'join', code: '!!!!' }, { op: 'join', code: 123 }, { op: 'join' }]) {
    const w = sqUp(S, sqws(SQC)); await S.handle(w, { type: 'squad', ...frame, id: 'x' });
    const r = sqlast(w);
    if (!(r && r.op === 'join' && r.error === 'no_such_squad' && r.id === 'x' && w.rx.length === 1)) bad.push([frame, r]);
  }
  if (!bad.length) ok('(h2) an unknown, malformed, non-string or missing code is answered no_such_squad with the op on the frame');
  else fail('(h2) bad codes answered ' + JSON.stringify(bad));
}

// ---- (h3) leave, and the guest who can leave without an account -----------
{
  const st = sqstore(); const S = sqSocial(st);
  const wa = sqUp(S, sqws(SQA)), g = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = (sqlast(wa, 'state') || {}).code;
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  wa.rx.length = 0; g.rx.length = 0;
  await S.handle(g, { type: 'squad', op: 'leave', id: 'l1' });
  const said = sqlast(g), after = sqlast(wa, 'state');
  if (said && said.op === 'left' && said.ok === true && said.id === 'l1' && g.rx.length === 1)
    ok('(h3) a guest can leave, and the answer is one frame, not a snapshot of a squad they are out of');
  else fail('(h3) guest leave reply: ' + JSON.stringify(g.rx));
  if (after && after.members.length === 1 && after.you === 0 && after.id === undefined) ok('(h3) the member left behind gets the fresh roster');
  else fail('(h3) leader after guest left: ' + JSON.stringify(after));
  // A GUEST WHO DID NOT ACT IS STILL PUSHED THE ROSTER. The fan-out walks the
  // squad's own sockets; a guest has no presence, so one fanned out through
  // presence would skip them silently.
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  g.rx.length = 0;
  const wc = sqUp(S, sqws(SQC));
  await S.handle(wc, { type: 'squad', op: 'join', code });
  const pushed = sqlast(g, 'state');
  if (pushed && pushed.you === 1 && pushed.id === undefined && pushed.members.length === 3 && pushed.members[1].guest === true)
    ok('(h3) a guest is pushed the roster when somebody else joins, with their own row as `you`');
  else fail('(h3) guest push: ' + JSON.stringify(g.rx));
  await S.handle(g, { type: 'squad', op: 'leave' });
  await S.handle(wc, { type: 'squad', op: 'leave' });
  const lonely = sqUp(S, sqws(SQE));
  await S.handle(lonely, { type: 'squad', op: 'leave', id: 'l2' });
  const none = sqlast(lonely);
  if (none && none.op === 'left' && none.ok === true && none.id === 'l2') ok('(h3) leaving when you are in no squad is answered, not dropped');
  else fail('(h3) empty leave: ' + JSON.stringify(none));
  // THE LEADER LEAVING: the one left behind is told who leads now.
  const wb = sqUp(S, sqws(SQB));
  await S.handle(wb, { type: 'squad', op: 'join', code });
  wb.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'leave' });
  const heir = sqlast(wb, 'state');
  if (heir && heir.leader === SQB && heir.members.length === 1 && heir.you === 0) ok('(h3) when the leader leaves, the heir is pushed a roster naming them leader');
  else fail('(h3) after the leader left: ' + JSON.stringify(heir));
}

// ---- (h4) the squad that ends under the guests left standing in it --------
{
  const st = sqstore(); const S = sqSocial(st);
  const wa = sqUp(S, sqws(SQA)), g1 = sqws(null), g2 = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = (sqlast(wa, 'state') || {}).code;
  await S.handle(g1, { type: 'squad', op: 'join', code, name: 'G1', skin: 'gold' });
  await S.handle(g2, { type: 'squad', op: 'join', code, name: 'G2', skin: 'gold' });
  g1.rx.length = 0; g2.rx.length = 0; wa.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'leave', id: 'l' });
  const e1 = sqlast(g1), e2 = sqlast(g2);
  if (e1 && e1.op === 'ended' && e1.reason === 'no_leader' && e1.id === undefined && e2 && e2.op === 'ended' && e2.reason === 'no_leader' && g1.rx.length === 1 && g2.rx.length === 1)
    ok('(h4) when the last account leaves, the guests are told the squad ended rather than left holding one');
  else fail('(h4) ended frames: ' + JSON.stringify([g1.rx, g2.rx]));
  if (wa.rx.length === 1 && sqat(wa).op === 'left') ok('(h4) the leaver is answered left, and is not also told the squad ended');
  else fail('(h4) the leaver got ' + JSON.stringify(wa.rx));
  // THE GUESTS ARE OUT OF IT, not merely told: a second leave finds nothing.
  g1.rx.length = 0;
  await S.handle(g1, { type: 'squad', op: 'leave' });
  if (g1.rx.length === 1 && sqat(g1).op === 'left') ok('(h4) a guest the squad ended under is in no squad afterwards');
  else fail('(h4) guest after end: ' + JSON.stringify(g1.rx));
}

// ---- (h5) kick: by id, by index for a guest, and never by a member --------
{
  const st = sqstore(); const S = sqSocial(st);
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = (sqlast(wa, 'state') || {}).code;
  await S.handle(wb, { type: 'squad', op: 'join', code });
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  // A SIGNED-IN SOCKET IN NO SQUAD leads nothing.
  const wz = sqUp(S, sqws(SQE));
  await S.handle(wz, { type: 'squad', op: 'kick', id: SQB });
  if (wz.rx.length === 1 && sqat(wz).op === 'kick' && sqat(wz).error === 'not_leader') ok('(h5) a kick from a player in no squad is answered not_leader');
  else fail('(h5) kick from outside: ' + JSON.stringify(wz.rx));
  wb.rx.length = 0;
  await S.handle(wb, { type: 'squad', op: 'kick', id: SQA });
  const refused = sqlast(wb);
  if (refused && refused.op === 'kick' && refused.error === 'not_leader' && refused.id === SQA) ok('(h5) a member who is not the leader is answered not_leader');
  else fail('(h5) member kick: ' + JSON.stringify(refused));
  // THE INDEX FORM CARRIES A CORRELATION id, because public/app.js's
  // socialSend mints a numeric one onto every frame that has none. With `i`
  // present, `id` is the echo and nothing else.
  wa.rx.length = 0; g.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'kick', i: 2, id: 7 });
  const seen = sqlast(wa, 'state'), told = sqlast(g);
  if (seen && seen.id === 7 && seen.members.length === 2 && told && told.op === 'ended' && told.reason === 'kicked' && told.id === undefined)
    ok('(h5) a guest row is kicked by its index, with the client\'s numeric id on the frame, and the guest is told');
  else fail('(h5) guest kick: ' + JSON.stringify(seen) + ' told ' + JSON.stringify(told));
  // THE INDEX FORM IS FOR GUEST ROWS ONLY. A stale index can miss; it can
  // never land on a signed-in member the leader did not aim at.
  wa.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'kick', i: 1, id: 'k2' });
  const miss = sqlast(wa);
  if (miss && miss.op === 'kick' && miss.error === 'no_such_member' && miss.id === 'k2' && sqf(wb, 'ended').length === 0)
    ok('(h5) an index aimed at a signed-in row is refused, and that member stays put');
  else fail('(h5) index at a signed-in row: ' + JSON.stringify(miss));
  const junk = [];
  for (const i of [-1, 9, 1.5, '2', null]) {
    wa.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'kick', i, id: 'kj' });
    const r = sqlast(wa);
    if (!(r && r.op === 'kick' && r.error === 'no_such_member')) junk.push([i, r]);
  }
  if (!junk.length) ok('(h5) an index that is not a row — negative, past the end, fractional, a string, null — kicks nobody');
  else fail('(h5) junk indexes answered ' + JSON.stringify(junk));
  // BY ACCOUNT ID: `id` is the target, and the echo is that same uuid
  // (BINDING resolution 3's shape, the way friend remove spells it).
  wa.rx.length = 0; wb.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'kick', id: SQB.toUpperCase() });
  const byId = sqlast(wa, 'state');
  if (byId && byId.members.length === 1 && byId.id === SQB.toUpperCase() && sqlast(wb) && sqat(wb).op === 'ended' && sqat(wb).reason === 'kicked')
    ok('(h5) a signed-in member is kicked by account id, in any case');
  else fail('(h5) id kick: ' + JSON.stringify(byId) + ' ' + JSON.stringify(sqlast(wb)));
  await S.handle(wa, { type: 'squad', op: 'kick', id: SQE });
  if (sqat(wa).op === 'kick' && sqat(wa).error === 'no_such_member') ok('(h5) kicking a stranger answers no_such_member');
  else fail('(h5) stranger kick: ' + JSON.stringify(sqlast(wa)));
  await S.handle(wa, { type: 'squad', op: 'kick', id: SQA });
  if (sqat(wa).op === 'kick' && sqat(wa).error === 'no_such_member' && sqat(wa).id === SQA) ok('(h5) the leader naming themselves answers no_such_member and they stay');
  else fail('(h5) self kick: ' + JSON.stringify(sqlast(wa)));
  // THE KICKED PLAYER IS OUT OF IT: a join elsewhere is not a move out of it.
  wb.rx.length = 0;
  await S.handle(wb, { type: 'squad', op: 'leave' });
  if (wb.rx.length === 1 && sqat(wb).op === 'left') ok('(h5) a kicked member is in no squad afterwards');
  else fail('(h5) kicked member after: ' + JSON.stringify(wb.rx));
}

// ---- (h6) the per-op gate (R3), one op at a time, and the bucket -----------
{
  const st = sqstore(); const S = sqSocial(st);
  // A GUEST: an anonymous account (ws.userId set, ws.isGuest true) and a
  // socket that never said hello. Both must be refused create and kick.
  const gated = [];
  for (const g of [sqws('anon-1', true), sqws(null)]) {
    for (const op of ['create', 'kick']) {
      g.rx.length = 0;
      await S.handle(g, { type: 'squad', op, id: 'g' });
      const r = g.rx[g.rx.length - 1];
      if (!(g.rx.length === 1 && r.type === 'social' && r.error === 'sign_in' && r.id === 'g')) gated.push([g.userId, op, [...g.rx]]);
    }
  }
  if (!gated.length) ok('(h6) create and kick each gate on a linked account, for an anonymous account and for no account at all');
  else fail('(h6) guest create/kick answered ' + JSON.stringify(gated));
  // AND join AND leave DO NOT. This is the assertion that would fail if the
  // gate were put back on the TYPE the way the other five are.
  const host = sqUp(S, sqws(SQA));
  await S.handle(host, { type: 'squad', op: 'create' });
  const code = (sqlast(host, 'state') || {}).code;
  const g = sqws(null);
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold', id: 'j' });
  const joined = sqlast(g, 'state');
  if (joined && joined.op === 'state' && joined.you === 1 && joined.id === 'j') ok('(h6) join is open to a socket that has never signed in (D5)');
  else fail('(h6) guest join: ' + JSON.stringify(g.rx));
  await S.handle(g, { type: 'squad', op: 'leave', id: 'l' });
  if (sqat(g).op === 'left' && sqat(g).ok === true) ok('(h6) leave is open too, or a guest is trapped in a squad they joined');
  else fail('(h6) guest leave: ' + JSON.stringify(sqlast(g)));
  // AN ANONYMOUS ACCOUNT JOINS AS A GUEST. It has an account id (public/
  // cloud.js mints one for every player who saves), and that id is an
  // identity this feature must never spend or show: the row is id null.
  const anon = sqws('00000000-0000-4000-8000-a00000000001', true);
  await S.handle(anon, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold', id: 'a' });
  const arow = sqlast(anon, 'state');
  const seenBy = JSON.stringify(host.rx) + JSON.stringify(anon.rx);
  if (arow && arow.id === 'a' && arow.you === 1 && JSON.stringify(arow.members[1]) === JSON.stringify({ id: null, callsign: null, guest: true, online: true, ready: false, dropped: false })
    && !seenBy.includes('a00000000001'))
    ok('(h6) an anonymous account joins as a guest row — id null — and its account id reaches no screen');
  else fail('(h6) anonymous join: ' + JSON.stringify(arow));
  await S.handle(anon, { type: 'squad', op: 'leave' });
  // AN OP THAT DOES NOT EXIST IS ANSWERED, NEVER DROPPED — prototype names
  // included, because SQUAD_OPS has none.
  const odd = [];
  for (const op of ['nope', 'toString', 'constructor', '__proto__']) {
    await S.handle(host, { type: 'squad', op, id: 'n' });
    const r = sqat(host);
    if (!(r.op === op && r.error === 'unavailable' && r.id === 'n')) odd.push([op, r]);
  }
  if (!odd.length) ok('(h6) an unknown squad op, prototype names included, is answered with its op on the frame');
  else fail('(h6) unknown ops answered ' + JSON.stringify(odd));
  // THE BUCKET: twenty squad frames a minute per socket, EVERY op spending
  // from it, an unknown one included, and the refusal carries the op. The
  // clock is frozen, so nothing refills inside this block.
  const w = sqUp(S, sqws(SQE));
  const answers = [];
  for (let i = 0; i < 20; i++) { await S.handle(w, { type: 'squad', op: 'leave' }); answers.push(sqat(w).op); }
  await S.handle(w, { type: 'squad', op: 'leave', id: 's1' });
  const slow = sqat(w);
  await S.handle(w, { type: 'squad', op: 'nope', id: 's2' });
  const slow2 = sqat(w);
  if (answers.every((a) => a === 'left') && slow.op === 'leave' && slow.error === 'slow_down' && slow.id === 's1'
    && slow2.op === 'nope' && slow2.error === 'slow_down')
    ok('(h6) the twenty-first squad frame in a minute is answered slow_down with its op, an unknown op included');
  else fail('(h6) bucket: ' + JSON.stringify({ answers, slow, slow2 }));
  SQCLOCK += 60000;
  await S.handle(w, { type: 'squad', op: 'leave', id: 's3' });
  if (sqat(w).op === 'left' && sqat(w).id === 's3') ok('(h6) a minute later the bucket has refilled');
  else fail('(h6) after a minute: ' + JSON.stringify(sqlast(w)));
}

// ---- (h7) the actor is always answered, and the squad they left is told ----
{
  const st = sqstore(); const S = sqSocial(st);
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = (sqlast(wa, 'state') || {}).code;
  await S.handle(wb, { type: 'squad', op: 'join', code });
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  // A SECOND DEVICE ON THE SAME ACCOUNT. The squad keeps the socket it has
  // (resume is task 5's), but a frame that arrives on the other one is still
  // a request, and a request is answered — never left to the client's twelve
  // second timer.
  const wa2 = sqUp(S, sqws(SQA));
  await S.handle(wa2, { type: 'squad', op: 'join', code, id: 'd1' });
  const dj = sqlast(wa2, 'state');
  if (dj && dj.id === 'd1' && dj.you === 0 && dj.members.length === 3 && wa2.rx.length === 1)
    ok('(h7) a join from a second device of a member is answered, with that member\'s row as `you`');
  else fail('(h7) second-device join got ' + JSON.stringify(wa2.rx));
  wa2.rx.length = 0;
  await S.handle(wa2, { type: 'squad', op: 'kick', i: 2, id: 'd2' });
  const dk = sqlast(wa2, 'state');
  if (dk && dk.id === 'd2' && dk.members.length === 2 && sqlast(g) && sqat(g).op === 'ended')
    ok('(h7) the leader kicking from a second device is answered too');
  else fail('(h7) second-device kick got ' + JSON.stringify(wa2.rx));
  // CREATE FROM INSIDE A SQUAD: the squad left behind is pushed its new
  // leader, and the creator gets exactly one answer.
  wa.rx.length = 0; wb.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'create', id: 'c2' });
  const made = sqlast(wa, 'state'), heir = sqlast(wb, 'state');
  if (made && made.id === 'c2' && made.code !== code && made.members.length === 1 && wa.rx.length === 1
    && heir && heir.code === code && heir.leader === SQB && heir.members.length === 1)
    ok('(h7) creating from inside a squad answers the creator once and hands the old squad on, telling its heir');
  else fail('(h7) create-from-a-squad: creator ' + JSON.stringify(wa.rx) + ' heir ' + JSON.stringify(heir));
  // JOINING ANOTHER SQUAD FROM ONE ONLY GUESTS WOULD BE LEFT IN: it ends,
  // and they are told.
  const wc = sqUp(S, sqws(SQC)), g2 = sqws(null);
  await S.handle(wc, { type: 'squad', op: 'create' });
  const cc = (sqlast(wc, 'state') || {}).code;
  await S.handle(g2, { type: 'squad', op: 'join', code: cc, name: 'G2', skin: 'gold' });
  g2.rx.length = 0; wc.rx.length = 0;
  await S.handle(wc, { type: 'squad', op: 'join', code: made && made.code, id: 'mv' });
  const moved = sqlast(wc, 'state');
  if (moved && moved.id === 'mv' && moved.code === (made && made.code) && sqlast(g2) && sqat(g2).op === 'ended' && sqat(g2).reason === 'no_leader')
    ok('(h7) the last account moving to another squad ends the one it leaves, and the guest there is told');
  else fail('(h7) move: mover ' + JSON.stringify(moved) + ' guest ' + JSON.stringify(g2.rx));
  // A JOIN REFUSED full LEAVES THE JOINER WHERE THEY WERE, and says so.
  const target = made && made.code;
  // A and C are in it; D and a guest make four.
  for (const w of [sqUp(S, sqws(SQD)), sqws(null)]) await S.handle(w, { type: 'squad', op: 'join', code: target, name: 'G3', skin: 'gold' });
  const filled = (sqat(wa, 'state').members || []).length;
  if (filled !== 4) fail('(h7) the target squad is not full, so the full check below proves nothing: ' + filled);
  const we = sqUp(S, sqws(SQE));
  await S.handle(we, { type: 'squad', op: 'create' });
  const ec = (sqlast(we, 'state') || {}).code;
  we.rx.length = 0;
  await S.handle(we, { type: 'squad', op: 'join', code: target, id: 'f' });
  await S.handle(we, { type: 'squad', op: 'join', code: ec, id: 'f2' });
  const fr = we.rx[0], back = we.rx[1];
  if (fr && fr.op === 'join' && fr.error === 'full' && fr.id === 'f' && back && back.op === 'state' && back.code === ec && back.members.length === 1)
    ok('(h7) a join refused full is answered full and the joiner is still in their own squad');
  else fail('(h7) full: ' + JSON.stringify(we.rx));
}

// ---- (h8) a name read that fails: the squad is still told the truth --------
// profilesByIds is COSMETIC to a squad. By the time a snapshot is built the
// operation has already landed — the member has joined, the kick has
// happened — so a failed name read must not turn into an "unavailable" that
// splits the squad: the joiner's client showing the old squad while the new
// one carries a member it was never told about, who takes a seat and changes
// `fits`. The snapshot degrades instead: every row is KEPT and every name is
// null, which is displayName's own answer for a name it cannot vouch for.
{
  // CREATE: the creator gets the real frame, their row kept, their name null.
  {
    const st = sqstore(); const S = sqSocial(st);
    st.boom.add(SQA);
    const wa = sqUp(S, sqws(SQA));
    await S.handle(wa, { type: 'squad', op: 'create', id: 'c' });
    const r = wa.rx[0] || {};
    if (wa.rx.length === 1 && r.op === 'state' && r.id === 'c' && SQCODE_RE.test(r.code) && r.you === 0
      && JSON.stringify(r.members) === JSON.stringify([{ id: SQA, callsign: null, guest: false, online: true, ready: false, dropped: false }]))
      ok('(h8) a create whose name read fails is answered with the real squad, the row kept and the name null');
    else fail('(h8) create over a failing name read got ' + JSON.stringify(wa.rx));
  }
  // JOIN: the mover, EVERY member of the squad they joined, and the squad
  // they left are all told — the one squad state, on every screen.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), wc = sqUp(S, sqws(SQC));
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(wb, { type: 'squad', op: 'join', code });
    await S.handle(wc, { type: 'squad', op: 'create' });
    const other = sqat(wc, 'state').code;
    wa.rx.length = 0; wb.rx.length = 0; wc.rx.length = 0;
    st.boom.add(SQC);                 // any snapshot with C in it cannot be named
    await S.handle(wb, { type: 'squad', op: 'join', code: other, id: 'j' });
    const mine = wb.rx[0] || {}, host = sqat(wc, 'state'), left = sqat(wa, 'state');
    const nulls = [{ id: SQC, callsign: null, guest: false, online: true, ready: false, dropped: false },
      { id: SQB, callsign: null, guest: false, online: true, ready: false, dropped: false }];
    if (wb.rx.length === 1 && mine.op === 'state' && mine.id === 'j' && mine.code === other && mine.you === 1
      && JSON.stringify(mine.members) === JSON.stringify(nulls)
      && host.code === other && host.you === 0 && JSON.stringify(host.members) === JSON.stringify(nulls)
      && same(host.fits, { duel: true, ffa: true, boss: true, aliens: true, golf: true })
      && left.code === code && left.members.length === 1 && left.members[0].callsign === 'Anvil Six')
      ok('(h8) a join whose name read fails tells the joiner, every member of the new squad and the squad left behind');
    else fail('(h8) join over a failing name read: mover ' + JSON.stringify(wb.rx) + ' host ' + JSON.stringify(host) + ' left ' + JSON.stringify(left));
  }
  // LEAVE and KICK: one answer each, and the members still in the squad are
  // pushed their roster with the rows intact.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), wc = sqUp(S, sqws(SQC));
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(wb, { type: 'squad', op: 'join', code });
    await S.handle(wc, { type: 'squad', op: 'join', code });
    wa.rx.length = 0; wb.rx.length = 0; wc.rx.length = 0;
    st.boom.add(SQA);
    await S.handle(wc, { type: 'squad', op: 'leave', id: 'l' });
    const seen = sqat(wb, 'state');
    if (wc.rx.length === 1 && wc.rx[0].op === 'left' && wc.rx[0].id === 'l'
      && seen.members && seen.members.length === 2 && seen.members.every((m) => m.callsign === null) && seen.you === 1)
      ok('(h8) a leave is answered once and the members left behind get their roster, rows kept, names null');
    else fail('(h8) leave over a failing name read: leaver ' + JSON.stringify(wc.rx) + ' seen ' + JSON.stringify(seen));
    wa.rx.length = 0; wb.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'kick', id: SQB });
    const k = wa.rx[0] || {};
    if (wa.rx.length === 1 && k.op === 'state' && k.id === SQB && k.members.length === 1 && k.members[0].callsign === null
      && sqat(wb).op === 'ended' && sqat(wb).reason === 'kicked')
      ok('(h8) a kick whose name read fails is answered with the real roster, and the kicked member is told');
    else fail('(h8) kick over a failing name read: leader ' + JSON.stringify(wa.rx) + ' kicked ' + JSON.stringify(wb.rx));
  }
  // THE NET INSIDE handleSquad STILL CARRIES THE OP for a throw that is not
  // a name read. Nothing in these four ops throws on a frame JSON can carry,
  // so the stand-in is a frame whose `code` throws when it is read.
  {
    const S = sqSocial(sqstore());
    const w = sqUp(S, sqws(SQA));
    await S.handle(w, { type: 'squad', op: 'join', get code() { throw new Error('unexpected'); }, id: 'x' });
    if (w.rx.length === 1 && JSON.stringify(w.rx[0]) === JSON.stringify({ type: 'squad', op: 'join', error: 'unavailable', id: 'x' }))
      ok('(h8) any other throw inside an op is answered unavailable, carrying its op');
    else fail('(h8) a throwing op answered ' + JSON.stringify(w.rx));
  }
}

// ---- (h9) a guest who signs in on the same socket is not stuck -------------
// The client re-sends `hello` over the LIVE socket after a sign-in
// (public/app.js, both sign-in paths), and server.js's hello branch sets
// ws.userId and ws.isGuest and calls onAuth — no onClose, because nothing
// closed. An anonymous account upgraded in place is the same socket with
// isGuest flipped. Either way the socket still holds its GUEST row, keyed by
// the socket, and every squad op must act on THAT row.
{
  for (const [label, before, after] of [
    ['a socket that never said hello', [null, false], [SQB, false]],
    ['an anonymous account upgraded in place', ['00000000-0000-4000-8000-a00000000002', true], ['00000000-0000-4000-8000-a00000000002', false]],
  ]) {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA));
    const g = sqws(before[0], before[1]);
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    // SIGN IN, exactly as server.js's hello branch does it.
    g.userId = after[0]; g.isGuest = after[1]; S.onAuth(g);
    // LEAVE: exactly one answer, the guest row gone, and nothing more pushed
    // down this socket from the squad it left.
    g.rx.length = 0; wa.rx.length = 0;
    await S.handle(g, { type: 'squad', op: 'leave', id: 'l' });
    const roster = sqat(wa, 'state').members || [];
    await S.handle(sqws(null), { type: 'squad', op: 'join', code, name: 'H', skin: 'gold' });
    if (g.rx.length === 1 && g.rx[0].op === 'left' && roster.length === 1 && roster[0].id === SQA)
      ok(`(h9) ${label}, signed in mid-squad: leave takes its guest row out, and the squad stops pushing to it`);
    else fail(`(h9) ${label}: leave left the guest row behind — socket got ${JSON.stringify(g.rx)}, roster ${JSON.stringify(roster)}`);
  }
  // CREATE after signing in: the new squad is led by the account, the old
  // squad has lost the guest row and is told, and the socket is pushed ONE
  // squad from then on.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), g = sqws(null);
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    g.userId = SQB; g.isGuest = false; S.onAuth(g);
    g.rx.length = 0; wa.rx.length = 0;
    await S.handle(g, { type: 'squad', op: 'create', id: 'c' });
    const made = g.rx.find((f) => f.id === 'c') || {};
    const told = sqat(wa, 'state');
    g.rx.length = 0;
    await S.handle(sqws(null), { type: 'squad', op: 'join', code, name: 'H', skin: 'gold' });
    if (made.op === 'state' && made.code !== code && made.leader === SQB && made.members.length === 1 && made.you === 0
      && told.code === code && told.members.length === 1 && g.rx.length === 0)
      ok('(h9) create after signing in leads a new squad and leaves the old one — which is told, and never pushes to this socket again');
    else fail('(h9) create after sign-in: made ' + JSON.stringify(made) + ', old squad told ' + JSON.stringify(told) + ', later pushes ' + g.rx.length);
  }
  // JOIN after signing in: out of the old squad (told), into the new one.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wc = sqUp(S, sqws(SQC)), g = sqws(null);
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(wc, { type: 'squad', op: 'create' });
    const other = sqat(wc, 'state').code;
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    g.userId = SQB; g.isGuest = false; S.onAuth(g);
    wa.rx.length = 0; g.rx.length = 0;
    await S.handle(g, { type: 'squad', op: 'join', code: other, id: 'j' });
    const now2 = g.rx.find((f) => f.id === 'j') || {};
    const told = sqat(wa, 'state');
    if (now2.code === other && now2.you === 1 && now2.members[1].id === SQB && told.members && told.members.length === 1)
      ok('(h9) join after signing in moves the socket: out of the old squad, which is told, and in as the account');
    else fail('(h9) join after sign-in: ' + JSON.stringify(now2) + ' old squad ' + JSON.stringify(told));
  }
  // AND THE REVERSE: a socket that SIGNS OUT still holds its account's row,
  // and its leave takes that row out, handing leadership on.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB));
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(wb, { type: 'squad', op: 'join', code });
    S.onClose(wa); wa.userId = null; wa.isGuest = false;
    wb.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'leave', id: 'o' });
    const heir = sqat(wb, 'state');
    if (sqat(wa).op === 'left' && heir.leader === SQB && heir.members && heir.members.length === 1)
      ok('(h9) a socket that signed out leaves the account row it holds, and leadership passes on');
    else fail('(h9) leave after sign-out: ' + JSON.stringify(heir));
  }
  // BUT LEADERSHIP IS THE ACCOUNT'S. A socket that signed out of the leader's
  // account and into ANOTHER still holds the leader's row, and must not
  // command that squad: the row it holds and the account on it must both be
  // the leader.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null);
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(wb, { type: 'squad', op: 'join', code });
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    S.onClose(wa); wa.userId = SQE; wa.isGuest = false; S.onAuth(wa);
    wa.rx.length = 0; g.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'kick', i: 2, id: 'k' });
    await S.handle(wa, { type: 'squad', op: 'kick', id: SQB });
    if (wa.rx.length === 2 && wa.rx.every((f) => f.op === 'kick' && f.error === 'not_leader') && g.rx.length === 0 && sqf(wb, 'ended').length === 0)
      ok('(h9) a socket now signed in as someone else cannot kick from the leader\'s row it still holds');
    else fail('(h9) kick after an account switch: ' + JSON.stringify(wa.rx));
  }
  // AND THE OTHER HALF: a socket still holding a GUEST row in one squad does
  // not command another squad that its new account leads from a different
  // device — its screen is showing the first one, and an index it sends was
  // read off that screen.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null), h = sqws(null);
    await S.handle(wa, { type: 'squad', op: 'create' });
    const one = sqat(wa, 'state').code;
    await S.handle(g, { type: 'squad', op: 'join', code: one, name: 'G', skin: 'gold' });
    await S.handle(wb, { type: 'squad', op: 'create' });
    const two = sqat(wb, 'state').code;
    await S.handle(h, { type: 'squad', op: 'join', code: two, name: 'H', skin: 'gold' });
    g.userId = SQB; g.isGuest = false; S.onAuth(g);   // g's account now leads squad two, elsewhere
    g.rx.length = 0; h.rx.length = 0;
    await S.handle(g, { type: 'squad', op: 'kick', i: 1, id: 'k' });
    if (g.rx.length === 1 && g.rx[0].op === 'kick' && g.rx[0].error === 'not_leader' && h.rx.length === 0)
      ok('(h9) a socket holding a guest row cannot kick in the squad its account leads from another device');
    else fail('(h9) cross-squad kick: ' + JSON.stringify(g.rx) + ' guest in squad two got ' + JSON.stringify(h.rx));
    // AND WHEN THAT SOCKET CREATES, the account's row in squad two goes too —
    // one squad per player — and squad two is told, not just squad one.
    wa.rx.length = 0; h.rx.length = 0;
    await S.handle(g, { type: 'squad', op: 'create', id: 'c' });
    const toldOne = sqat(wa, 'state'), toldTwo = sqat(h);
    if (toldOne.code === one && toldOne.members.length === 1 && toldTwo.op === 'ended' && toldTwo.reason === 'no_leader')
      ok('(h9) a create from that socket leaves both the socket\'s row and the account\'s, and tells both squads');
    else fail('(h9) create across two squads: squad one saw ' + JSON.stringify(toldOne) + ', squad two\'s guest got ' + JSON.stringify(h.rx));
  }
  // ONE SOCKET NEVER SHOWS TWO SQUADS, even when the join is a no-op for the
  // account. g holds a guest row in X, signs in as B, whose other device is
  // already in Y, and joins Y: the join matches on B's row and changes
  // nothing in Y — but g's guest row in X must still go, or g is answered
  // with Y and then pushed X.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wc = sqUp(S, sqws(SQC)), wb = sqUp(S, sqws(SQB)), g = sqws(null);
    await S.handle(wa, { type: 'squad', op: 'create' });
    const X = sqat(wa, 'state').code;
    await S.handle(wc, { type: 'squad', op: 'create' });
    const Y = sqat(wc, 'state').code;
    await S.handle(wb, { type: 'squad', op: 'join', code: Y });
    await S.handle(g, { type: 'squad', op: 'join', code: X, name: 'G', skin: 'gold' });
    g.userId = SQB; g.isGuest = false; S.onAuth(g);
    g.rx.length = 0; wa.rx.length = 0;
    await S.handle(g, { type: 'squad', op: 'join', code: Y, id: 'j' });
    const answer = g.rx.find((f) => f.id === 'j') || {};
    const toldX = sqat(wa, 'state');
    g.rx.length = 0;
    await S.handle(sqws(null), { type: 'squad', op: 'join', code: X, name: 'L', skin: 'gold' });
    if (answer.code === Y && answer.members && answer.members.length === 2 && answer.you === 1
      && toldX.code === X && toldX.members && toldX.members.length === 1 && g.rx.length === 0)
      ok('(h9) a join that is a no-op for the account still takes the socket\'s guest row out of its other squad — one socket, one squad');
    else fail('(h9) join-variant: answer ' + JSON.stringify(answer) + ', X told ' + JSON.stringify(toldX) + ', X still pushes ' + JSON.stringify(g.rx.map((f) => f.code + ' you=' + f.you)));
  }
}

// ---- (h10) the actor's own socket throws: everyone else is still told -----
// Once the snapshot cannot reject, the one send in a push that can throw is
// the actor's REPLY — a half-closed socket whose send() raises, the case
// safeSend exists for. The operation has already landed, so the rest of the
// squad, and the squad the actor left, must still get the truth.
{
  // A linked socket whose every send throws.
  const brittle = (id) => ({ readyState: 1, userId: id, isGuest: false, rx: { push() { throw new Error('half-closed'); } } });
  // KICK: the leader is row 0, so a push that answered the actor first would
  // throw before reaching anybody after them.
  {
    const S = sqSocial(sqstore());
    const wa = sqUp(S, sqws(SQA)), wc = sqUp(S, sqws(SQC)), g = sqws(null);
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(wc, { type: 'squad', op: 'join', code });
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    const ra = wa.rx;
    Object.assign(wa, { rx: { push() { throw new Error('half-closed'); } } });
    wc.rx.length = 0;
    let threw = null;
    try { await S.handle(wa, { type: 'squad', op: 'kick', i: 2, id: 'k' }); } catch (e) { threw = e; }
    wa.rx = ra;
    const seen = sqat(wc, 'state');
    if (!threw && seen.members && seen.members.length === 2 && sqat(g).op === 'ended')
      ok('(h10) a kick whose leader\'s socket throws still pushes the new roster to everyone else');
    else fail('(h10) kick with a throwing actor: threw ' + (threw && threw.message) + ', member saw ' + JSON.stringify(seen));
  }
  // CREATE and JOIN from inside a squad: the squad left behind is told even
  // though the mover's own answer throws.
  for (const op of ['create', 'join']) {
    const S = sqSocial(sqstore());
    const wa = sqUp(S, brittle(SQA)), wb = sqUp(S, sqws(SQB)), wc = sqUp(S, sqws(SQC));
    await S.handle(wb, { type: 'squad', op: 'create' });
    const code = sqat(wb, 'state').code;
    await S.handle(wc, { type: 'squad', op: 'create' });
    const other = sqat(wc, 'state').code;
    await S.handle(wa, { type: 'squad', op: 'join', code });
    wb.rx.length = 0;
    let threw = null;
    try { await S.handle(wa, op === 'create' ? { type: 'squad', op } : { type: 'squad', op, code: other }); } catch (e) { threw = e; }
    const told = sqat(wb, 'state');
    if (!threw && told.code === code && told.members && told.members.length === 1 && told.members[0].id === SQB)
      ok(`(h10) a ${op} whose mover's socket throws still tells the squad they left`);
    else fail(`(h10) ${op} with a throwing mover: threw ${threw && threw.message}, left-behind saw ${JSON.stringify(told)}`);
  }
  // LEAVE: the leaver's own `left` is the send that throws, and the members
  // left behind must still get their roster.
  {
    const S = sqSocial(sqstore());
    const wa = sqUp(S, brittle(SQA)), wb = sqUp(S, sqws(SQB));
    await S.handle(wb, { type: 'squad', op: 'create' });
    const code = sqat(wb, 'state').code;
    await S.handle(wa, { type: 'squad', op: 'join', code });
    wb.rx.length = 0;
    let threw = null;
    try { await S.handle(wa, { type: 'squad', op: 'leave' }); } catch (e) { threw = e; }
    const told = sqat(wb, 'state');
    if (!threw && told.code === code && told.members && told.members.length === 1 && told.members[0].id === SQB)
      ok('(h10) a leave whose leaver\'s socket throws still pushes the roster to the members left behind');
    else fail('(h10) leave with a throwing leaver: threw ' + (threw && threw.message) + ', left-behind saw ' + JSON.stringify(told));
  }
}

// ---- (r4) ONE CODE NAMESPACE, both directions, in one process --------------
// The REAL engine and the REAL social layer, wired with the expressions
// server.js uses — roomExists as rooms.has, and the engine's codeTaken as
// hasSquad — and the code bytes scripted so each minter is MADE to try the
// code the other already holds. This pins social.js's own
// `createSquads({ now, codeTaken: roomExists })`; test/code_frame.mjs pins the
// two lines in server.js the same way, against a spawned server.
{
  const mintWith = async (bytes, fn) => {
    const hook = scriptCodeBytes(bytes);
    try { return { got: await fn(), hook }; } finally { hook.restore(); }
  };
  const roomCreate = () => {
    const ws = mkws();
    handleClientMessage(ws, { type: 'create', name: 'T', skin: 'olive', mode: 'duel', loadout: FIVE });
    return { ws, code: (frames(ws, 'created')[0] || {}).code };
  };
  // DIRECTION 2 — the squad minter refuses a live ROOM's code.
  {
    const S = sqSocial(sqstore(), { roomExists: (code) => rooms.has(code) });
    const pre = rooms.has('ABCD');
    const { got: room } = await mintWith([0, 1, 2, 3], roomCreate);
    const wa = sqUp(S, sqws(SQA));
    const { hook } = await mintWith([0, 1, 2, 3, 4, 5, 6, 7], () => S.handle(wa, { type: 'squad', op: 'create' }));
    const sq = sqat(wa, 'state');
    if (!pre && room.code === 'ABCD' && sq.code === 'EFGH' && hook.oneByte === 8 && hook.real === 0)
      ok('(r4) a squad scripted onto a live room\'s code "ABCD" is refused it and takes "EFGH"');
    else fail('(r4) room ' + JSON.stringify(room.code) + ', then the squad took ' + JSON.stringify(sq.code) + ' in ' + JSON.stringify(hook));
    handleClientMessage(room.ws, { type: 'leave' });
    await S.handle(wa, { type: 'squad', op: 'leave' });
  }
  // DIRECTION 1 — the engine refuses a live SQUAD's code, through hasSquad.
  {
    const S = sqSocial(sqstore(), { roomExists: (code) => rooms.has(code) });
    setCodeTaken(S.hasSquad);
    try {
      const wa = sqUp(S, sqws(SQA));
      await mintWith([0, 1, 2, 3], () => S.handle(wa, { type: 'squad', op: 'create' }));
      const sq = sqat(wa, 'state');
      const { got: room, hook } = await mintWith([0, 1, 2, 3, 4, 5, 6, 7], roomCreate);
      if (sq.code === 'ABCD' && S.hasSquad('ABCD') === true && room.code === 'EFGH' && hook.oneByte === 8 && hook.real === 0)
        ok('(r4) a room scripted onto a live squad\'s code "ABCD" is refused it and takes "EFGH"');
      else fail('(r4) squad ' + JSON.stringify(sq.code) + ', then the room took ' + JSON.stringify(room.code) + ' in ' + JSON.stringify(hook));
      handleClientMessage(room.ws, { type: 'leave' });
    } finally { setCodeTaken(null); }
  }
}

// ==========================================================================
// TASK 3 — Ready, the armed mode, and the seat table that feeds fits
// ==========================================================================
// The seat rules were in the engine twice — createRoom's ternary and
// `case 'startMatch'`'s minSeats — and copied a third time into
// server/squads.js for `fits`. They are now ONE frozen table in the engine,
// MODE_SEATS, which both engine paths read and which server.js hands to the
// social layer. Every number below is a LITERAL, read by hand off the engine
// as it stood at da6b016 and run against that engine before the table
// replaced it: an expectation computed from MODE_SEATS would be the table
// vouching for itself.

// ---- (s3a) createRoom seats exactly what the ternary seated ----------------
// opts.max as a client can send it: absent, zero, in range, past the top,
// negative, and a numeric string (createRoom has always coerced with `| 0`).
const SEAT_ASKED = [undefined, 0, 1, 2, 3, 4, 5, 6, -1, '3'];
const SEAT_MATRIX = [
  ['duel',   [2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
  ['ffa',    [4, 4, 2, 2, 3, 4, 4, 4, 2, 3]],
  ['boss',   [2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
  ['aliens', [2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
  ['golf',   [2, 2, 1, 2, 3, 4, 4, 4, 1, 3]],
];
{
  const before = rooms.size;
  let bad = 0;
  for (const [mode, wants] of SEAT_MATRIX) {
    SEAT_ASKED.forEach((mx, i) => {
      const w = mkws();
      handleClientMessage(w, { type: 'create', name: 'T', skin: 'olive', mode, max: mx });
      const cr = frames(w, 'created')[0];
      const r = cr ? rooms.get(cr.code) : null;
      if (!r || r.mode !== mode || r.max !== wants[i] || cr.max !== wants[i]) {
        bad++; fail(`(s3a) ${mode} max=${JSON.stringify(mx)} seated ${r && r.mode}/${r && r.max}, the ternary seated ${mode}/${wants[i]}`);
      }
      handleClientMessage(w, { type: 'leave' });
    });
  }
  if (!bad) ok('(s3a) createRoom seats exactly what the ternary seated — 5 modes x 10 requested counts');
  // A MODE OFF THE WIRE THAT NAMES A PROTOTYPE KEY IS NOT A MODE. The lookup
  // is an object now where it was an array, and `in` or a bare index would
  // find Object.prototype's `constructor` and seat a room in mode
  // 'constructor' with max undefined.
  const odd = [];
  for (const mode of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'battleroyale', '', null, 5]) {
    const w = mkws();
    handleClientMessage(w, { type: 'create', name: 'T', skin: 'olive', mode, max: 4 });
    const cr = frames(w, 'created')[0];
    const r = cr ? rooms.get(cr.code) : null;
    if (!(r && r.mode === 'duel' && r.max === 2 && cr.mode === 'duel')) odd.push([mode, cr]);
    handleClientMessage(w, { type: 'leave' });
  }
  if (!odd.length) ok('(s3a) an unknown mode, prototype names included, is a duel of two, as it always was');
  else fail('(s3a) unknown modes seated ' + JSON.stringify(odd));
  // AN ARRAY IS NOT A MODE EITHER. hasOwnProperty COERCES its key to a
  // string, so to a bare lookup ['aliens'] "is" 'aliens': a room was stored
  // with mode ["aliens"], kept that row's one-seat minimum, started with a
  // lone human, played as a duel against nobody, and handed the match ledger
  // a solo win. At da6b016 every one of these made a duel of two that
  // refuses to start alone — run against that engine and passing there —
  // and that is exactly what each must still make.
  const arrays = [];
  for (const [mode, max] of [[['aliens']], [['boss']], [[['aliens']]], [['golf'], 1], [['ffa'], 4], [['duel']]]) {
    const w = mkws();
    handleClientMessage(w, { type: 'create', name: 'T', skin: 'olive', mode, max });
    const cr = frames(w, 'created')[0];
    const r = cr ? rooms.get(cr.code) : null;
    handleClientMessage(w, { type: 'startMatch' });
    const refused = w._rx.some((m) => m.type === 'joinError' && m.reason === 'Need at least 2 commanders.');
    if (!(r && r.mode === 'duel' && r.max === 2 && cr.mode === 'duel' && cr.max === 2 && r.state === 'waiting' && refused))
      arrays.push([mode, cr, r && r.state, refused]);
    handleClientMessage(w, { type: 'leave' });
  }
  if (!arrays.length) ok('(s3a) a mode sent as an array is a duel of two that will not start alone, exactly as at da6b016');
  else fail('(s3a) array modes seated ' + JSON.stringify(arrays));
  // The CPU entry point takes a mode too; its strict === has always refused
  // an array, and a CPU game from ['ffa'] is still a duel against one CPU.
  {
    const w = mkws();
    handleClientMessage(w, { type: 'ai', name: 'T', skin: 'olive', mode: ['ffa'], max: 4, difficulty: 'easy' });
    const r = rooms.get(w.roomCode);
    if (r && r.mode === 'duel' && r.max === 2 && r.players.length === 2) ok('(s3a) a CPU game asked for as [\'ffa\'] is a duel against one CPU, as it always was');
    else fail('(s3a) CPU game from an array mode: ' + JSON.stringify(r && [r.mode, r.max, r.players.length]));
    handleClientMessage(w, { type: 'leave' });
  }
  if (rooms.size === before) ok('(s3a) every room this block made is gone again');
  else fail(`(s3a) rooms leaked: ${before} -> ${rooms.size}`);

  // THE TABLE THOSE ROOMS NOW COME FROM, whole: every key, in the order the
  // snapshot's `fits` and the spec's seat line use, and no field beyond these.
  // `rack` is game-core's loadoutSizeFor with golf's 0 read as five, which is
  // what the create and join paths have always validated a golf rack against.
  const WANT = {
    duel:   { min: 2, max: 2, def: 2, pick: false, rack: 5 },
    ffa:    { min: 2, max: 4, def: 4, pick: true,  rack: 5 },
    boss:   { min: 1, max: 2, def: 2, pick: false, rack: 7 },
    aliens: { min: 1, max: 2, def: 2, pick: false, rack: 7 },
    golf:   { min: 1, max: 4, def: 2, pick: true,  rack: 5 },
  };
  if (JSON.stringify(MODE_SEATS) === JSON.stringify(WANT)) ok('(s3a) MODE_SEATS is exactly those numbers, those keys and that order');
  else fail('(s3a) MODE_SEATS is ' + JSON.stringify(MODE_SEATS));
  // FROZEN, because it is handed to another module and read on every
  // snapshot: a caller that could write to it could move the seat count the
  // join path enforces.
  if (MODE_SEATS && Object.isFrozen(MODE_SEATS) && Object.values(MODE_SEATS).every((r) => Object.isFrozen(r)))
    ok('(s3a) MODE_SEATS and every row of it are frozen');
  else fail('(s3a) MODE_SEATS is not frozen all the way down');
}

// ---- (s3b) which squad sizes the engine will really start -------------------
// THE ENGINE IS THE ORACLE, driven the way a squad start will drive it: the
// host creates with max = n, the rest join through the ordinary join path,
// and the host presses Start if the room has not already begun. The answer is
// what the engine DID — a room in play holding exactly n humans — so a table
// that disagreed with the engine could not make it agree. The literal is the
// spec's seat line (design 4.3): duel 2, ffa 2-4, boss 1-2, aliens 1-2,
// golf 1-4. Its duel and ffa rows are the startMatch minimum ("Need at least
// 2 commanders.") and every row's top is createRoom's ceiling, which a third
// Boss Fight or Alien Invasion member meets as "That battle has already
// started." because the second one filled the room.
const engineStarts = (mode, n) => {
  const crew = Array.from({ length: n }, () => mkws());
  const [host, ...rest] = crew;
  handleClientMessage(host, { type: 'create', name: 'T', skin: 'olive', mode, max: n });
  const code = (frames(host, 'created')[0] || {}).code;
  let refused = !code;
  for (const w of rest) {
    if (refused) break;
    handleClientMessage(w, { type: 'join', code, name: 'T', skin: 'olive' });
    if (frames(w, 'joinError').length) refused = true;
  }
  const r = code ? rooms.get(code) : null;
  if (!refused && r && r.state === 'waiting') handleClientMessage(host, { type: 'startMatch' });
  const humans = r ? r.players.filter((p) => p && !p.bot).length : 0;
  const began = !refused && !!r && r.state === 'playing' && humans === n;
  for (const w of crew) handleClientMessage(w, { type: 'leave' });
  return began;
};
const SEAT_LINE = {
  duel:   [false, true, false, false],
  ffa:    [false, true, true,  true],
  boss:   [true,  true, false, false],
  aliens: [true,  true, false, false],
  golf:   [true,  true, true,  true],
};
const ENGINE_STARTS = {};
{
  const before = rooms.size;
  for (const mode of Object.keys(SEAT_LINE)) ENGINE_STARTS[mode] = [1, 2, 3, 4].map((n) => engineStarts(mode, n));
  if (JSON.stringify(ENGINE_STARTS) === JSON.stringify(SEAT_LINE))
    ok('(s3b) the engine starts exactly the squad sizes the seat line names — duel 2, ffa 2-4, boss 1-2, aliens 1-2, golf 1-4');
  else fail('(s3b) the engine started ' + JSON.stringify(ENGINE_STARTS));
  // THE REFUSAL COPY IS REACHED BY THE MODES WHOSE MINIMUM IS TWO, and by
  // nothing else: a lone host of each is told, and a lone Boss Fight host is
  // not.
  const told = {};
  for (const mode of ['duel', 'ffa', 'boss']) {
    const w = mkws();
    handleClientMessage(w, { type: 'create', name: 'T', skin: 'olive', mode, max: 4 });
    handleClientMessage(w, { type: 'startMatch' });
    told[mode] = w._rx.some((m) => m.type === 'joinError' && m.reason === 'Need at least 2 commanders.');
    handleClientMessage(w, { type: 'leave' });
  }
  if (told.duel && told.ffa && !told.boss) ok('(s3b) a lone duel or free-for-all host is told they need two; a lone Boss Fight host is not');
  else fail('(s3b) the minimum refusal went to ' + JSON.stringify(told));
  if (rooms.size === before) ok('(s3b) every room this block made is gone again');
  else fail(`(s3b) rooms leaked: ${before} -> ${rooms.size}`);
}

// ---- (s3c) the rack a seat keeps, and the tee sets a golf room takes -------
// "ready:true requires a full rack for the armed mode's draft size (the
// client checks first; the server re-checks)" (design 4.3). The number is the
// ENGINE's: its create and join paths throw away a rack of the wrong length,
// and a squad that readied against a different number would start into a room
// that sent every seat to the pick screen. So what the engine KEEPS is the
// oracle here, read off the create and join paths themselves.
const RACK5 = LOADOUT_POOL.slice(0, 5);
const RACK7 = LOADOUT_POOL.slice(0, 7);
// [keeps five, keeps seven] per mode: duel, ffa and golf draft five (golf's
// loadoutSizeFor is 0, read by the engine as five), the co-op raids seven.
const KEEPS = { duel: [true, false], ffa: [true, false], boss: [false, true], aliens: [false, true], golf: [true, false] };
const keptOnCreate = (mode, rack) => {
  const w = mkws();
  handleClientMessage(w, { type: 'create', name: 'T', skin: 'olive', mode, loadout: rack });
  const cr = frames(w, 'created')[0];
  const r = cr ? rooms.get(cr.code) : null;
  const kept = !!(r && same(r.players[0].loadout, rack));
  handleClientMessage(w, { type: 'leave' });
  return kept;
};
{
  const before = rooms.size;
  const got = {};
  for (const mode of Object.keys(KEEPS)) got[mode] = [keptOnCreate(mode, RACK5), keptOnCreate(mode, RACK7)];
  if (same(got, KEEPS)) ok('(s3c) the create path keeps five picks for duel, ffa and golf and seven for the co-op raids, and drops the other');
  else fail('(s3c) the create path kept ' + JSON.stringify(got));
  // THE JOIN PATH, the one a squad start seats every member but the leader
  // through. An ffa lobby of four stays open, so both sizes can be offered.
  const host = mkws();
  handleClientMessage(host, { type: 'create', name: 'T', skin: 'olive', mode: 'ffa', max: 4, loadout: RACK5 });
  const code = frames(host, 'created')[0].code;
  const j5 = mkws(), j7 = mkws();
  handleClientMessage(j5, { type: 'join', code, name: 'T', skin: 'olive', loadout: RACK5 });
  handleClientMessage(j7, { type: 'join', code, name: 'T', skin: 'olive', loadout: RACK7 });
  const r = rooms.get(code);
  if (r && same(r.players[j5.seat].loadout, RACK5) && r.players[j7.seat].loadout === null)
    ok('(s3c) the join path keeps a five-pick rack in a free-for-all and drops a seven');
  else fail('(s3c) join path kept ' + JSON.stringify(r && r.players.map((p) => p && p.loadout)));
  for (const w of [j5, j7, host]) handleClientMessage(w, { type: 'leave' });

  // THE TEE SETS a golf room takes, and the one it falls back to.
  const tees = {};
  for (const t of ['champ', 'mens', 'womens', 'junior', 'blue', 'constructor', '', null]) {
    const w = mkws();
    handleClientMessage(w, { type: 'create', name: 'T', skin: 'olive', mode: 'golf', tees: t });
    const cr = frames(w, 'created')[0];
    const g = cr ? rooms.get(cr.code) : null;
    tees[String(t)] = g ? g.tees : undefined;
    handleClientMessage(w, { type: 'leave' });
  }
  if (same(tees, { champ: 'champ', mens: 'mens', womens: 'womens', junior: 'junior', blue: 'mens', constructor: 'mens', '': 'mens', null: 'mens' }))
    ok('(s3c) a golf room takes exactly champ, mens, womens and junior, and anything else is mens');
  else fail('(s3c) golf tees: ' + JSON.stringify(tees));
  if (rooms.size === before) ok('(s3c) every room this block made is gone again');
  else fail(`(s3c) rooms leaked: ${before} -> ${rooms.size}`);

  // validRackFor IS THE ENGINE'S OWN PREDICATE, and it answers exactly what
  // the create path just did — so a rack the squad layer accepts at Ready is
  // a rack the seat keeps at Start.
  const pred = {};
  for (const mode of Object.keys(KEEPS)) pred[mode] = [validRackFor(mode, RACK5), validRackFor(mode, RACK7)];
  if (same(pred, KEEPS) && same(pred, got)) ok('(s3c) validRackFor answers what the create path kept, mode by mode');
  else fail('(s3c) validRackFor answered ' + JSON.stringify(pred) + ', the engine kept ' + JSON.stringify(got));
  const junk = [
    ['duel', ['mortar', 'mortar', 'mortar', 'mortar', 'mortar']],
    ['duel', ['mortar', 'volley', 'cluster', 'napalm', 'nosuchweapon']],
    ['duel', null], ['duel', []], ['duel', 'mortar,volley,cluster,napalm,gas'], ['golf', []],
    ['battleroyale', RACK5], ['constructor', RACK5], [undefined, RACK5], [['duel'], RACK5], [['boss'], RACK7],
  ].filter(([mode, picks]) => validRackFor(mode, picks) !== false);
  if (!junk.length) ok('(s3c) validRackFor refuses duplicates, an unknown weapon, a non-array, an empty rack, and any rack for a mode that is not one — an array naming a mode included');
  else fail('(s3c) validRackFor accepted ' + JSON.stringify(junk));

  // THREE CLAIMS ABOUT ONE NUMBER: the table, game-core, and public/bay.js's
  // MODES `draft` column, which is how many weapons the box has the player
  // pick before Ready is offered. If the box drafted a different number from
  // the one the server re-checks, that mode could never ready up. The
  // literal is the floor, so all three drifting together still fails.
  const RACK_WANT = { duel: 5, ffa: 5, boss: 7, aliens: 7, golf: 5 };
  const bay = read('public/bay.js');
  const bayDraft = (id) => { const m = bay.match(new RegExp("\\{\\s*id:\\s*'" + id + "'[^}]*?draft:\\s*(\\d+)")); return m ? Number(m[1]) : null; };
  const drift = Object.entries(RACK_WANT).filter(([id, want]) =>
    !(MODE_SEATS[id].rack === want && (loadoutSizeFor(id) || 5) === want && bayDraft(id) === want));
  if (!drift.length) ok('(s3c) the rack is one number in MODE_SEATS, in game-core and in the box, for every mode');
  else fail('(s3c) rack sizes disagree: ' + JSON.stringify(drift.map(([id]) => [id, MODE_SEATS[id].rack, loadoutSizeFor(id), bayDraft(id)])));

  // AN ARRAY IS NOT A TEE SET — AND THIS ONE PREDATES SQUADS. At da6b016
  // {tees:['champ']} was stored as the array: the course lookup coerced it
  // and played the championship tees, while every player in the room was
  // sent teeSet ["champ"], which the client's tee marker compares with ===,
  // so the played tee never lit and, zoomed out, no tee box was drawn at
  // all. It falls back to mens like any other value that is not a tee set,
  // and the started hole says so as a string.
  const teeArrays = [];
  for (const t of [['champ'], [['womens']], ['junior', 'x']]) {
    const w = mkws();
    handleClientMessage(w, { type: 'create', name: 'T', skin: 'olive', mode: 'golf', max: 1, tees: t });
    const cr = frames(w, 'created')[0];
    const g = cr ? rooms.get(cr.code) : null;
    const gs = (frames(w, 'start')[0] || {}).golf;
    if (!(g && g.tees === 'mens' && gs && gs.teeSet === 'mens' && gs.tee === gs.tees.mens)) teeArrays.push([t, g && g.tees, gs && gs.teeSet]);
    handleClientMessage(w, { type: 'leave' });
  }
  if (!teeArrays.length) ok('(s3c) a tee set sent as an array is mens, and the started hole plays and names mens as a string');
  else fail('(s3c) array tees: ' + JSON.stringify(teeArrays));

  // TEE_IDS IS THE SET THE ENGINE TOOK, not a list beside it.
  const took = Object.keys(tees).filter((t) => tees[t] === t);
  if (Array.isArray(TEE_IDS) && Object.isFrozen(TEE_IDS) && same(TEE_IDS, ['champ', 'mens', 'womens', 'junior']) && same(TEE_IDS, took))
    ok('(s3c) TEE_IDS is frozen and is exactly the tee sets a golf room took');
  else fail('(s3c) TEE_IDS is ' + JSON.stringify(TEE_IDS) + ', the engine took ' + JSON.stringify(took));
}

// ---- (s3e) setReady: the membership invariant, addressed by MEMBER KEY -----
// A ready member holds a rack, and a member who stands down drops it. WHAT
// COUNTS AS A RACK is the armed mode's and belongs to the engine — the
// handler checks it with the injected validRackFor, (s3f) — so the machine
// holds only this invariant. A member is addressed by the key task 2 gave the
// row: the account id, or for a guest THE SOCKET, because a guest's userId is
// null and two guests would otherwise share it.
{
  const S = sqMachine();
  const wa = sqws(SQA), wb = sqws(SQB), g = sqws(null), stray = sqws(null);
  const sq = S.create(sqM(SQA, wa));
  S.join(sq.code, sqM(SQB, wb));
  S.join(sq.code, sqG(g));
  const row = (k) => sq.members.find((m) => m.key === k);
  const flags = () => sq.members.map((m) => [m.ready, m.loadout && m.loadout.length]);

  const strangers = [SQE, null, undefined, stray, 'nobody'].map((k) => S.setReady(k, true, RACK5));
  if (strangers.every((r) => r.ok === false && r.error === 'no_squad' && r.squad === null) && same(flags(), [[false, null], [false, null], [false, null]]))
    ok('(s3e) a key in no squad — an account, null, undefined, a stray socket — is refused no_squad and nobody moves');
  else fail('(s3e) strangers: ' + JSON.stringify(strangers, noWs) + ' ' + JSON.stringify(flags()));

  const racks = [null, [], 'mortar', undefined].map((l) => S.setReady(SQA, true, l));
  if (racks.every((r) => r.ok === false && r.error === 'no_rack') && row(SQA).ready === false && row(SQA).loadout === null)
    ok('(s3e) ready with no rack is refused no_rack and records nothing');
  else fail('(s3e) no rack: ' + JSON.stringify(racks, noWs) + ' ' + JSON.stringify(row(SQA), noWs));

  const mine = RACK5.slice();
  const r3 = S.setReady(SQA, true, mine);
  if (r3.ok && r3.squad === sq && r3.error === null && row(SQA).ready === true && same(row(SQA).loadout, RACK5))
    ok('(s3e) ready with a rack records the flag and the rack, and answers the squad');
  else fail('(s3e) ready: ' + JSON.stringify(r3, noWs) + ' ' + JSON.stringify(row(SQA), noWs));
  // THE STORED RACK IS A COPY. The array came off a client frame; a squad
  // that shared it would seat a member with whatever it became.
  mine[0] = 'nosuchweapon';
  if (row(SQA).loadout[0] === RACK5[0]) ok('(s3e) the stored rack is a copy, not the caller\'s array');
  else fail('(s3e) the squad shares the caller\'s rack array');

  // A GUEST IS ADDRESSED BY ITS SOCKET, and only its own row moves.
  const rg = S.setReady(g, true, RACK7);
  if (rg.ok && row(g).ready === true && same(row(g).loadout, RACK7) && row(SQB).ready === false && row(SQB).loadout === null)
    ok('(s3e) a guest readies by its socket key, and nobody else\'s row moves');
  else fail('(s3e) guest ready: ' + JSON.stringify(rg, noWs) + ' ' + JSON.stringify(flags()));

  // STANDING DOWN drops the rack, whatever rack the frame carried; and only
  // `true` is ready — a truthy string is not a yes.
  const r4 = S.setReady(SQA, false, RACK5);
  const r5 = S.setReady(g, 'yes', RACK7);
  if (r4.ok && r5.ok && row(SQA).ready === false && row(SQA).loadout === null && row(g).ready === false && row(g).loadout === null)
    ok('(s3e) standing down clears the flag and the rack, and anything but true stands down');
  else fail('(s3e) stand down: ' + JSON.stringify([r4, r5], noWs) + ' ' + JSON.stringify(flags()));
}

// ---- (s3g) setMode: the armed mode is the leader's --------------------------
// The machine checks WHO; the handler checks WHAT (mode, tees and max against
// the engine's own table). The leader is always an account id, so a guest's
// socket key and a null can never match it.
{
  const S = sqMachine();
  const wa = sqws(SQA), wb = sqws(SQB), g = sqws(null);
  const sq = S.create(sqM(SQA, wa));
  S.join(sq.code, sqM(SQB, wb));
  S.join(sq.code, sqG(g));
  const armed = () => [sq.mode, sq.tees, sq.max];
  const refused = [[sq.code, SQB], [sq.code, g], [sq.code, null], [sq.code, undefined], ['ZZZZ', SQA]]
    .map(([code, k]) => S.setMode(code, k, 'golf', 'champ', 3));
  if (refused.every((r) => r.ok === false && r.error === 'not_leader' && r.squad === null) && same(armed(), ['duel', null, null]))
    ok('(s3g) a member, a guest, a null, and a squad that is gone are all refused not_leader, and nothing is armed');
  else fail('(s3g) refusals: ' + JSON.stringify(refused, noWs) + ' ' + JSON.stringify(armed()));
  const m3 = S.setMode(sq.code, SQA, 'golf', 'champ', 3);
  if (m3.ok && m3.squad === sq && m3.error === null && same(armed(), ['golf', 'champ', 3]))
    ok('(s3g) the leader arms the mode, the tees and the seat choice');
  else fail('(s3g) leader setMode: ' + JSON.stringify(m3, noWs) + ' ' + JSON.stringify(armed()));
  // AFTER A HAND-OFF the old leader is a stranger to this and the heir is not.
  S.leave(SQA);
  const stale = S.setMode(sq.code, SQA, 'duel', null, null);
  const heir = S.setMode(sq.code, SQB, 'boss', null, null);
  if (stale.error === 'not_leader' && heir.ok && same(armed(), ['boss', null, null]))
    ok('(s3g) after a hand-off the old leader is refused and the heir arms the mode');
  else fail('(s3g) hand-off: ' + JSON.stringify([stale, heir], noWs) + ' ' + JSON.stringify(armed()));
}

// ---- (s3h) clearReady: after a start, the flags AND the racks go -------------
// "Ready flags reset to false on the server when the room is created, so the
// next start needs fresh Readies" (design 4.3). The racks go with the flags:
// loadout is null until ready, and a rack left behind is one the NEXT start
// would seat a member with although they never touched Ready. Destructive, so
// the start reads every rack and seats first, then calls this.
{
  const S = sqMachine();
  const g = sqws(null);
  const sq = S.create(sqM(SQA, sqws(SQA)));
  S.join(sq.code, sqM(SQB, sqws(SQB)));
  S.join(sq.code, sqG(g));
  S.setReady(SQA, true, RACK5); S.setReady(g, true, RACK5);
  const before = sq.members.map((m) => [m.ready, m.loadout && m.loadout.length]);
  const got = S.clearReady(sq.code);
  const after = sq.members.map((m) => [m.ready, m.loadout]);
  if (same(before, [[true, 5], [false, null], [true, 5]]) && got === sq && same(after, [[false, null], [false, null], [false, null]]))
    ok('(s3h) clearReady drops every flag and every rack, and answers the squad');
  else fail('(s3h) ' + JSON.stringify(before) + ' -> ' + JSON.stringify(after) + ' returned the squad: ' + (got === sq));
  if (S.clearReady('ZZZZ') === null && S.clearReady(undefined) === null) ok('(s3h) clearReady on a squad that is gone answers null');
  else fail('(s3h) clearReady on a missing squad did not answer null');
  if (S.setReady(SQB, true, RACK5).ok && sq.members[1].ready === true) ok('(s3h) after a clear, Ready works again');
  else fail('(s3h) Ready after a clear did not take');
}

// ---- (s3d) fits: the seat line, as the social layer reports it ------------
// `fits[mode]` is MINIMUM AND MAXIMUM (plan X6; design 4.3's start row: "squad
// size within the mode's seats"): a squad of one fits no duel and no
// free-for-all, and three or four fit no co-op raid. The squad is walked from
// one member to four through the real handlers — two accounts, a guest, and
// a third account — reading the roster the leader is pushed each time.
const FITS_BY_SIZE = [
  { duel: false, ffa: false, boss: true,  aliens: true,  golf: true },
  { duel: true,  ffa: true,  boss: true,  aliens: true,  golf: true },
  { duel: false, ffa: true,  boss: false, aliens: false, golf: true },
  { duel: false, ffa: true,  boss: false, aliens: false, golf: true },
];
{
  const S = sqSocial(sqstore());
  const wa = sqUp(S, sqws(SQA));
  const crew = [wa, sqUp(S, sqws(SQB)), sqws(null), sqUp(S, sqws(SQC))];
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = sqat(wa, 'state').code;
  const seen = [];
  for (let n = 1; n <= 4; n++) {
    if (n > 1) await S.handle(crew[n - 1], { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    const st = sqat(wa, 'state');
    seen.push(st.members && st.members.length === n ? st.fits : null);
  }
  if (same(seen, FITS_BY_SIZE)) ok('(s3d) fits for a squad of 1, 2, 3 and 4 is the seat line, minimum and maximum, in the seat line\'s order');
  else fail('(s3d) fits by squad size: ' + JSON.stringify(seen));
  // AND IT IS WHAT THE ENGINE DOES. (s3b) drove the real create, join and
  // startMatch paths with each squad size; the box must promise exactly the
  // sizes the engine then started.
  const engine = [1, 2, 3, 4].map((n) => Object.fromEntries(Object.keys(ENGINE_STARTS).map((m) => [m, ENGINE_STARTS[m][n - 1]])));
  if (same(seen, engine)) ok('(s3d) fits agrees with the engine: every mode it calls a fit, the engine started with that many humans, and no other');
  else fail('(s3d) fits ' + JSON.stringify(seen) + ' but the engine started ' + JSON.stringify(engine));
  // FAIL CLOSED. A layer handed no table knows no mode, so it claims no fit;
  // it never says a squad fits a room it cannot see.
  const F = sqSocial(sqstore(), { seats: undefined });
  const wf = sqUp(F, sqws(SQA));
  await F.handle(wf, { type: 'squad', op: 'create' });
  const lone = sqat(wf, 'state');
  if (lone.code && same(lone.fits, {})) ok('(s3d) with no seat table injected, fits is empty — no mode is claimed');
  else fail('(s3d) with no seat table: ' + JSON.stringify(lone));
}

// ---- (s3f) ready through the handler: the server re-checks the rack --------
// "the client checks first; the server re-checks" (design 4.3), against the
// ARMED mode, through the engine's own validRackFor. NO SIGN-IN GATE (R3):
// membership is the gate, so a guest member can ready — or a squad with a
// guest in it could never start. A success answers the sender with
// { op:'ready', ok:true } and its id, LAST, after every member (the sender
// included) has been pushed the roster that says so.
{
  const S = sqSocial(sqstore());
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = sqat(wa, 'state').code;
  await S.handle(wb, { type: 'squad', op: 'join', code });
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  const clear = () => { for (const w of [wa, wb, g]) w.rx.length = 0; };
  const readies = (w) => (sqat(w, 'state').members || []).map((m) => m.ready);

  // DUEL IS ARMED, so seven is not a rack and five is.
  clear();
  await S.handle(wa, { type: 'squad', op: 'ready', ready: true, loadout: RACK7, id: 'r1' });
  await S.handle(wa, { type: 'squad', op: 'ready', ready: true, id: 'r0' });
  if (same(wa.rx, [{ type: 'squad', op: 'ready', error: 'no_rack', id: 'r1' }, { type: 'squad', op: 'ready', error: 'no_rack', id: 'r0' }])
    && wb.rx.length === 0 && g.rx.length === 0)
    ok('(s3f) with duel armed, seven picks and no rack at all are each refused no_rack, with the id, and nobody is pushed anything');
  else fail('(s3f) duel refusals: ' + JSON.stringify(wa.rx) + ' others ' + (wb.rx.length + g.rx.length));
  clear();
  await S.handle(wa, { type: 'squad', op: 'ready', ready: true, loadout: RACK5, id: 'r2' });
  if (wa.rx.length === 2 && wa.rx[0].op === 'state' && wa.rx[0].id === undefined
    && same(wa.rx[1], { type: 'squad', op: 'ready', ok: true, id: 'r2' })
    && same(readies(wa), [true, false, false]) && same(readies(wb), [true, false, false]) && same(readies(g), [true, false, false]))
    ok('(s3f) five picks ready a duel: every member is pushed the roster, and the sender\'s ok comes last with its id');
  else fail('(s3f) five for a duel: ' + JSON.stringify(wa.rx) + ' b ' + JSON.stringify(readies(wb)));

  // A GUEST MEMBER READIES, and its row stays id null on every screen.
  clear();
  await S.handle(g, { type: 'squad', op: 'ready', ready: true, loadout: RACK5, id: 'g1' });
  const grow = (sqat(wb, 'state').members || [])[2] || {};
  if (sqat(g, 'ready').ok === true && sqat(g, 'ready').id === 'g1' && grow.guest === true && grow.ready === true && grow.id === null)
    ok('(s3f) a guest member readies with no sign-in gate, and stays id:null on the others\' screens');
  else fail('(s3f) guest ready: ' + JSON.stringify(g.rx) + ' row ' + JSON.stringify(grow));

  // ONLY `true` IS READY. B readies, then sends the string "true": that is a
  // stand-down, the harmless reading of a frame that is not what it should be.
  await S.handle(wb, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
  const bFirst = readies(wb)[1];
  await S.handle(wb, { type: 'squad', op: 'ready', ready: 'true', loadout: RACK5 });
  if (bFirst === true && readies(wb)[1] === false && sqat(wb, 'ready').ok === true) ok('(s3f) ready:"true" is not a yes — it stands the member down');
  else fail('(s3f) string ready: first ' + bFirst + ', then ' + JSON.stringify(readies(wb)));

  // SOMEONE IN NO SQUAD — an account and a guest — is no_squad, never sign_in.
  const loner = sqUp(S, sqws(SQE)), stray = sqws(null);
  await S.handle(loner, { type: 'squad', op: 'ready', ready: true, loadout: RACK5, id: 'l' });
  await S.handle(stray, { type: 'squad', op: 'ready', ready: true, loadout: RACK5, id: 's' });
  if (same(loner.rx, [{ type: 'squad', op: 'ready', error: 'no_squad', id: 'l' }]) && same(stray.rx, [{ type: 'squad', op: 'ready', error: 'no_squad', id: 's' }]))
    ok('(s3f) ready from an account or a guest in no squad is no_squad, not sign_in');
  else fail('(s3f) loners: ' + JSON.stringify([loner.rx, stray.rx]));

  // THE ROW IS THE ONE THIS SOCKET HOLDS (squadKey, socket first). A guest who
  // signs in on the same socket still holds its GUEST row, and readies that
  // row — found by its account it would be "no squad" and stuck unready.
  const h = sqws(null);
  await S.handle(h, { type: 'squad', op: 'join', code, name: 'H', skin: 'gold' });
  h.userId = SQD; h.isGuest = false; S.onAuth(h);
  h.rx.length = 0;
  await S.handle(h, { type: 'squad', op: 'ready', ready: true, loadout: RACK5, id: 'h' });
  const hrow = (sqat(wa, 'state').members || [])[3] || {};
  if (sqat(h, 'ready').ok === true && hrow.guest === true && hrow.ready === true)
    ok('(s3f) a guest who signed in on the same socket readies the guest row it holds');
  else fail('(s3f) signed-in guest ready: ' + JSON.stringify(h.rx) + ' row ' + JSON.stringify(hrow));

  // A SECOND DEVICE of a member readies that member's row and is answered —
  // roster and ok both — although the squad keeps the socket it had.
  const wb2 = sqUp(S, sqws(SQB));
  await S.handle(wb2, { type: 'squad', op: 'ready', ready: true, loadout: RACK5, id: 'd2' });
  if (wb2.rx.length === 2 && wb2.rx[0].op === 'state' && wb2.rx[0].you === 1 && same(wb2.rx[1], { type: 'squad', op: 'ready', ok: true, id: 'd2' }) && readies(wa)[1] === true)
    ok('(s3f) a second device of a member readies that member\'s row and is answered with the roster and its ok');
  else fail('(s3f) second device: ' + JSON.stringify(wb2.rx));

  // ONE TOKEN PER READY. handleSquad spends the squad bucket for every op;
  // a handler that spent it again would halve the allowance. A fresh
  // member's join spends one of twenty, so nineteen readies are answered and
  // the twentieth is slow_down — at a frozen clock nothing refills.
  const S2 = sqSocial(sqstore());
  const lead = sqUp(S2, sqws(SQA)), mem = sqUp(S2, sqws(SQB));
  await S2.handle(lead, { type: 'squad', op: 'create' });
  await S2.handle(mem, { type: 'squad', op: 'join', code: sqat(lead, 'state').code });
  const answers = [];
  for (let i = 0; i < 20; i++) { await S2.handle(mem, { type: 'squad', op: 'ready', ready: false, id: i }); answers.push(sqat(mem, 'ready').ok === true ? 'ok' : sqat(mem, 'ready').error); }
  if (answers.slice(0, 19).every((a) => a === 'ok') && answers[19] === 'slow_down')
    ok('(s3f) ready spends one token from the squad bucket, not two: nineteen answered after a join, the twentieth slow_down');
  else fail('(s3f) bucket: ' + JSON.stringify(answers));
}

// ---- (s3g) mode through the handler: vetted against the engine's table -----
// The machine checks WHO (ledSquad, then setMode); this checks WHAT. The
// injected MODE_SEATS is the whitelist of modes and of seat counts, TEE_IDS of
// tee sets. Tees are ECHOED to every member in the next roster, so an
// unchecked string there would be a free-text channel between two modified
// clients — which the aim relay's `weapon` field once was — against
// privacy.html's "No chat, no messages, and no message field of any kind".
{
  const S = sqSocial(sqstore());
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = sqat(wa, 'state').code;
  await S.handle(wb, { type: 'squad', op: 'join', code });
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  const clear = () => { for (const w of [wa, wb, g]) w.rx.length = 0; };
  const armed = (w) => { const st = sqat(w, 'state'); return [st.mode, st.tees, st.max]; };

  clear();
  await S.handle(wa, { type: 'squad', op: 'mode', mode: 'golf', tees: 'womens', max: 3, id: 'm1' });
  if (wa.rx.length === 2 && same(wa.rx[1], { type: 'squad', op: 'mode', ok: true, id: 'm1' })
    && same(armed(wa), ['golf', 'womens', 3]) && same(armed(wb), ['golf', 'womens', 3]) && same(armed(g), ['golf', 'womens', 3]))
    ok('(s3g) the leader arms golf with a real tee set and a seat choice; every member is pushed it, and the ok comes last');
  else fail('(s3g) golf: ' + JSON.stringify(wa.rx));

  // AN UNKNOWN MODE NEVER REACHES THE SQUAD — prototype names included.
  const badModes = [];
  for (const mode of ['battleroyale', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 5, null, undefined]) {
    clear();
    await S.handle(wa, { type: 'squad', op: 'mode', mode, id: 'b' });
    if (!(same(wa.rx, [{ type: 'squad', op: 'mode', error: 'bad_mode', id: 'b' }]) && wb.rx.length === 0 && g.rx.length === 0)) badModes.push([mode, [...wa.rx]]);
  }
  await S.handle(wa, { type: 'squad', op: 'mode', mode: 'golf', tees: 'womens', max: 3 });
  if (!badModes.length && same(armed(wa), ['golf', 'womens', 3])) ok('(s3g) a mode the table does not have, prototype names included, is bad_mode, and nothing moves or is pushed');
  else fail('(s3g) bad modes: ' + JSON.stringify(badModes));

  // AN UNKNOWN TEE SET REACHES NO OTHER MEMBER.
  const badTees = [];
  for (const tees of ['MEET ME AT THE OTHER GAME', 'constructor', 'Mens', 7, {}, ['mens']]) {
    clear();
    await S.handle(wa, { type: 'squad', op: 'mode', mode: 'golf', tees, id: 't' });
    const seen = JSON.stringify(wb.rx) + JSON.stringify(g.rx);
    if (!(same(wa.rx, [{ type: 'squad', op: 'mode', error: 'bad_tees', id: 't' }]) && seen === '[][]')) badTees.push([tees, [...wa.rx], seen]);
  }
  if (!badTees.length) ok('(s3g) a tee set that is not one of the engine\'s is bad_tees, and no frame of it reaches another member');
  else fail('(s3g) bad tees: ' + JSON.stringify(badTees));
  // Tee sets are golf's. Carried while arming anything else they are dropped,
  // not echoed; absent for golf they are null — the room's own default.
  clear();
  await S.handle(wa, { type: 'squad', op: 'mode', mode: 'ffa', tees: 'MEET ME AT THE OTHER GAME' });
  const ffaTees = armed(wb);
  const leaked = JSON.stringify(wb.rx).includes('MEET ME') || JSON.stringify(g.rx).includes('MEET ME');
  await S.handle(wa, { type: 'squad', op: 'mode', mode: 'golf' });
  if (same(ffaTees, ['ffa', null, null]) && !leaked && same(armed(wb), ['golf', null, null]))
    ok('(s3g) tees ride with golf only: any other mode drops them unechoed, and golf with none arms null');
  else fail('(s3g) tees off golf: ' + JSON.stringify([ffaTees, leaked, armed(wb)]));

  // THE SEAT CHOICE is vetted against the same table. For a mode the host may
  // choose for (ffa, golf) it is an integer inside the mode's own seats, or
  // absent/null for "the mode's own seats" — and ANYTHING ELSE IS REFUSED
  // bad_max, never quietly replaced: the leader's box shows the number it
  // sent, and an ok that armed null would show 3 while the squad seats 4.
  // Nothing is coerced — '3' (a <select>'s .value) is refused, not read as 3.
  // A mode with no choice has no number on screen to disagree with, so a max
  // sent with it is dropped unechoed, as tees are off golf.
  // The leader's socket has spent its twenty frames a minute on the checks
  // above; a minute passes so these are answered rather than slowed.
  SQCLOCK += 60000;
  const badMax = [];
  for (const [mode, max] of [['ffa', 9], ['ffa', 1], ['ffa', '3'], ['ffa', 3.5], ['ffa', true], ['ffa', [3]], ['golf', 0], ['golf', -1], ['golf', '2']]) {
    clear();
    await S.handle(wa, { type: 'squad', op: 'mode', mode, max, id: 'mx' });
    if (!(same(wa.rx, [{ type: 'squad', op: 'mode', error: 'bad_max', id: 'mx' }]) && wb.rx.length === 0 && g.rx.length === 0)) badMax.push([mode, max, [...wa.rx]]);
  }
  // Nothing moved: the next roster anyone is pushed still shows what was armed.
  await S.handle(g, { type: 'squad', op: 'ready', ready: false });
  if (!badMax.length && same(armed(wb), ['golf', null, null]))
    ok('(s3g) a seat choice outside the mode\'s seats, or not an integer — a numeric string included — is refused bad_max, and nothing is armed or pushed');
  else fail('(s3g) bad seat choices: ' + JSON.stringify(badMax) + ' armed ' + JSON.stringify(armed(wb)));
  SQCLOCK += 60000;
  const maxCases = [['ffa', 2, 2], ['ffa', 3, 3], ['ffa', 4, 4], ['ffa', null, null], ['ffa', undefined, null], ['golf', 1, 1], ['golf', 4, 4],
    ['duel', 2, null], ['duel', 3, null], ['boss', 2, null], ['aliens', 'MEET ME', null]];
  const keptMax = [];
  for (const [mode, max, want] of maxCases) {
    await S.handle(wa, { type: 'squad', op: 'mode', mode, max });
    if (!(sqat(wa, 'mode').ok === true && same(armed(wb), [mode, null, want]))) keptMax.push([mode, max, armed(wb), sqlast(wa, 'mode')]);
  }
  const echoed = JSON.stringify(wb.rx).includes('MEET ME');
  if (!keptMax.length && !echoed) ok('(s3g) a seat choice inside the mode\'s seats is armed, none arms null, and a mode with no choice drops one unechoed');
  else fail('(s3g) seat choices: ' + JSON.stringify(keptMax) + ' echoed ' + echoed);

  // NOT THE LEADER: a member and a guest member are not_leader (never
  // sign_in — this op has no sign-in gate); someone in no squad is no_squad.
  const loner = sqUp(S, sqws(SQE)), stray = sqws(null);
  const asked = [];
  for (const w of [wb, g, loner, stray]) {
    w.rx.length = 0;
    await S.handle(w, { type: 'squad', op: 'mode', mode: 'boss', id: 'x' });
    asked.push(w.rx.map((f) => f.error || f.op));
  }
  if (same(asked, [['not_leader'], ['not_leader'], ['no_squad'], ['no_squad']]) && armed(wa)[0] === 'aliens')
    ok('(s3g) a member and a guest member are refused not_leader and a player in no squad no_squad, and the armed mode stays put');
  else fail('(s3g) non-leaders: ' + JSON.stringify(asked) + ' armed ' + JSON.stringify(armed(wa)));
  // LEADERSHIP IS ASKED FIRST: a member probing with a mode or tee set that
  // does not exist learns only that they do not lead.
  wb.rx.length = 0;
  await S.handle(wb, { type: 'squad', op: 'mode', mode: 'battleroyale', id: 'p1' });
  await S.handle(wb, { type: 'squad', op: 'mode', mode: 'golf', tees: 'MEET ME AT THE OTHER GAME', id: 'p2' });
  if (same(wb.rx.map((f) => f.error), ['not_leader', 'not_leader'])) ok('(s3g) a member sending a mode or tee set that does not exist is told only not_leader');
  else fail('(s3g) a member\'s junk mode was answered ' + JSON.stringify(wb.rx));

  // THE LEADER'S SECOND DEVICE holds no row and is the leader's account on
  // both halves, so it arms the mode, like kick (h7).
  const wa2 = sqUp(S, sqws(SQA));
  await S.handle(wa2, { type: 'squad', op: 'mode', mode: 'boss', id: 'd' });
  if (wa2.rx.length === 2 && wa2.rx[0].you === 0 && same(wa2.rx[1], { type: 'squad', op: 'mode', ok: true, id: 'd' }) && armed(wb)[0] === 'boss')
    ok('(s3g) the leader\'s second device arms the mode and is answered');
  else fail('(s3g) second device: ' + JSON.stringify(wa2.rx));

  // ONE TOKEN PER MODE FRAME, as for ready.
  const S2 = sqSocial(sqstore());
  const lead = sqUp(S2, sqws(SQA));
  await S2.handle(lead, { type: 'squad', op: 'create' });
  const answers = [];
  for (let i = 0; i < 20; i++) { await S2.handle(lead, { type: 'squad', op: 'mode', mode: 'duel', id: i }); answers.push(sqat(lead, 'mode').ok === true ? 'ok' : sqat(lead, 'mode').error); }
  if (answers.slice(0, 19).every((a) => a === 'ok') && answers[19] === 'slow_down')
    ok('(s3g) mode spends one token from the squad bucket, not two');
  else fail('(s3g) bucket: ' + JSON.stringify(answers));
}

// ---- (s3i) a rack readied for one mode does not survive into another --------
// Ready means "my rack is full for the ARMED mode". When the leader arms a
// mode whose rack is a different size, a rack readied for the old one is not
// a rack the new room would keep, and a start would send that member to the
// pick screen. So the switch stands exactly those members down, and nobody
// whose rack still fits.
{
  const S = sqSocial(sqstore());
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = sqat(wa, 'state').code;
  await S.handle(wb, { type: 'squad', op: 'join', code });
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  const readies = () => (sqat(wb, 'state').members || []).map((m) => m.ready);
  for (const w of [wa, wb, g]) await S.handle(w, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
  const r0 = readies();
  await S.handle(wa, { type: 'squad', op: 'mode', mode: 'ffa' });
  const r1 = readies();
  await S.handle(wa, { type: 'squad', op: 'mode', mode: 'boss' });
  const r2 = readies();
  await S.handle(g, { type: 'squad', op: 'ready', ready: true, loadout: RACK7 });
  await S.handle(wa, { type: 'squad', op: 'mode', mode: 'aliens' });
  const r3 = readies();
  await S.handle(wa, { type: 'squad', op: 'mode', mode: 'golf' });
  const r4 = readies();
  if (same([r0, r1, r2, r3, r4], [[true, true, true], [true, true, true], [false, false, false], [false, false, true], [false, false, false]]))
    ok('(s3i) arming a mode stands down exactly the members whose rack it would not keep — five to five stays, five to seven and seven to five do not');
  else fail('(s3i) readies across mode changes: ' + JSON.stringify([r0, r1, r2, r3, r4]));
  // The ready op agrees: a rack for the old mode is refused under the new.
  await S.handle(wb, { type: 'squad', op: 'ready', ready: true, loadout: RACK7, id: 'q' });
  if (sqat(wb, 'ready').error === 'no_rack' && readies()[1] === false) ok('(s3i) and a seven-pick rack is refused once golf is armed');
  else fail('(s3i) seven under golf: ' + JSON.stringify(sqlast(wb, 'ready')));
}

// ---- (s3l) ledSquad guards mode on both halves, as it guards kick -----------
// Leadership is the row this socket holds AND the account signed in on it.
// (h9) proves both halves for kick; these are the same two cases for mode.
{
  // THE ACCOUNT ALONE: a socket holding a GUEST row in squad one, signed in
  // as B, who leads squad two from another device. It must not arm squad two.
  const S = sqSocial(sqstore());
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null), h = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const one = sqat(wa, 'state').code;
  await S.handle(g, { type: 'squad', op: 'join', code: one, name: 'G', skin: 'gold' });
  await S.handle(wb, { type: 'squad', op: 'create' });
  await S.handle(h, { type: 'squad', op: 'join', code: sqat(wb, 'state').code, name: 'H', skin: 'gold' });
  g.userId = SQB; g.isGuest = false; S.onAuth(g);
  g.rx.length = 0; h.rx.length = 0; wb.rx.length = 0; wa.rx.length = 0;
  await S.handle(g, { type: 'squad', op: 'mode', mode: 'boss', id: 'x' });
  if (same(g.rx, [{ type: 'squad', op: 'mode', error: 'not_leader', id: 'x' }]) && h.rx.length === 0 && wb.rx.length === 0 && wa.rx.length === 0)
    ok('(s3l) a socket holding a guest row cannot arm the squad its account leads from another device');
  else fail('(s3l) cross-squad mode: ' + JSON.stringify(g.rx) + ' squad two got ' + JSON.stringify(h.rx.concat(wb.rx)));
}
{
  // THE ROW ALONE: the leader's socket signs out and in as E, still holding
  // the leader's row. It must not arm that squad.
  const S = sqSocial(sqstore());
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB));
  await S.handle(wa, { type: 'squad', op: 'create' });
  await S.handle(wb, { type: 'squad', op: 'join', code: sqat(wa, 'state').code });
  S.onClose(wa); wa.userId = SQE; wa.isGuest = false; S.onAuth(wa);
  wa.rx.length = 0; wb.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'mode', mode: 'boss', id: 'y' });
  if (same(wa.rx, [{ type: 'squad', op: 'mode', error: 'not_leader', id: 'y' }]) && wb.rx.length === 0)
    ok('(s3l) a socket now signed in as someone else cannot arm the squad from the leader\'s row it still holds');
  else fail('(s3l) account-switched mode: ' + JSON.stringify(wa.rx) + ' member got ' + JSON.stringify(wb.rx));
}

// ==========================================================================
// TASK 4 — Start: the handler's half
// ==========================================================================
// seatSquad is INJECTED here. server.js owns the real one, and
// test/squad_seat.mjs drives it end to end over real sockets into the real
// engine; what this section tests is the HANDLER — what it hands the seating,
// in what order, what it refuses before ever calling it, and what it tells
// every member afterwards. So the stub is a collaborator, not the subject: it
// records what it is handed and answers whatever the test tells it to, and
// every assertion below is about frames the handler produced or about what
// it chose to hand over. If the handler were reverted, each would fail.
const stR = (i, n = 5) => LOADOUT_POOL.slice(i, i + n);
const mkSeat = (verdict = { ok: true, code: 'RM01' }) => {
  const st = { calls: [], verdict };
  st.fn = (seats, opts) => { st.calls.push({ seats, opts }); return typeof st.verdict === 'function' ? st.verdict(seats, opts) : st.verdict; };
  return st;
};
// A squad of `n` (leader SQA, then SQB, then a GUEST), the mode armed, and
// every member ready with a rack of its own unless `ready` says otherwise.
const stSquad = async (S, { n = 2, mode = 'duel', ready } = {}) => {
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null);
  const ws = [wa, wb, g].slice(0, n);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = sqat(wa, 'state').code;
  if (n > 1) await S.handle(wb, { type: 'squad', op: 'join', code, name: 'Bee', skin: 'desert' });
  if (n > 2) await S.handle(g, { type: 'squad', op: 'join', code, name: 'Gee', skin: 'gold' });
  if (mode !== 'duel') await S.handle(wa, { type: 'squad', op: 'mode', mode });
  const k = mode === 'boss' || mode === 'aliens' ? 7 : 5;
  for (let i = 0; i < ws.length; i++) {
    if (ready && !ready[i]) continue;
    await S.handle(ws[i], { type: 'squad', op: 'ready', ready: true, loadout: stR(i, k) });
  }
  for (const w of ws) w.rx.length = 0;
  return { ws, code, racks: ws.map((_, i) => stR(i, k)) };
};
const readyRow = (w) => (sqat(w, 'state').members || []).map((m) => m.ready);

// ---- (st1) what seatSquad is handed ----------------------------------------
{
  const seat = mkSeat();
  const S = sqSocial(sqstore(), { seatSquad: seat.fn });
  const { ws: [wa, wb, g], code, racks } = await stSquad(S, { n: 3, mode: 'ffa' });
  await S.handle(wa, { type: 'squad', op: 'start', id: 's' });
  const c = seat.calls[0] || { seats: [], opts: {} };
  // R5: THE LEADER FIRST, then the roster in order. The engine makes the first
  // socket the host seat and starts the match as the last one lands, so this
  // order IS the match's order.
  if (seat.calls.length === 1 && c.seats.length === 3 && c.seats[0].ws === wa && c.seats[1].ws === wb && c.seats[2].ws === g)
    ok('(st1) seatSquad is handed the leader first, then every member in roster order — the guest included');
  else fail('(st1) seats were ' + JSON.stringify(seat.calls.map((x) => x.seats.map((s) => (s.ws === wa ? 'a' : s.ws === wb ? 'b' : s.ws === g ? 'g' : '?')))));
  if (same(c.seats.map((s) => s.loadout), racks) && same(c.seats.map((s) => [s.name, s.skin]), [['', null], ['Bee', 'desert'], ['Gee', 'gold']]))
    ok('(st1) each seat carries its own member\'s rack, and the name and paint that member joined with');
  else fail('(st1) seat payload ' + JSON.stringify(c.seats.map((s) => [s.name, s.skin, s.loadout])));
  if (same(c.opts, { mode: 'ffa', tees: null, squad: code })) ok('(st1) and the armed mode, its tee set, and the squad code the room is marked with');
  else fail('(st1) opts ' + JSON.stringify(c.opts));
}

// ---- (st2) seated: who is told what, and the Readies are spent -------------
{
  const seat = mkSeat({ ok: true, code: 'RM02' });
  const S = sqSocial(sqstore(), { seatSquad: seat.fn });
  const { ws: [wa, wb, g] } = await stSquad(S, { n: 3, mode: 'ffa' });
  await S.handle(wa, { type: 'squad', op: 'start', id: 's' });
  const done = { type: 'squad', op: 'start', ok: true, code: 'RM02' };
  // A member is told unsolicited — no id — and THEN shown the roster.
  const member = (w) => w.rx.length === 2 && same(w.rx[0], done) && w.rx[1].op === 'state' && w.rx[1].id === undefined
    && w.rx[1].members.every((m) => m.ready === false);
  if (member(wb) && member(g)) ok('(st2) every member is told the room code unsolicited, then pushed a roster with every Ready spent');
  else fail('(st2) members got ' + JSON.stringify([wb.rx, g.rx]));
  // The caller: its roster, then its answer LAST with the id — pushSquad's
  // order, because the answer is the one send that can throw.
  if (wa.rx.length === 2 && wa.rx[0].op === 'state' && wa.rx[0].id === undefined && wa.rx[0].members.every((m) => m.ready === false)
    && same(wa.rx[1], { ...done, id: 's' }))
    ok('(st2) the leader is pushed the roster and then answered with the room code, id echoed, last');
  else fail('(st2) leader got ' + JSON.stringify(wa.rx));
  // THE READIES REALLY ARE SPENT: the next start, with nobody re-readying,
  // never reaches the seating.
  await S.handle(wa, { type: 'squad', op: 'start', id: 's2' });
  if (sqat(wa, 'start').error === 'not_ready' && seat.calls.length === 1) ok('(st2) a second start with the Readies spent is not_ready and never reaches the seating');
  else fail('(st2) second start ' + JSON.stringify(sqlast(wa, 'start')) + ' calls ' + seat.calls.length);
}

// ---- (st3) refused by the seating: R6, everybody is told -------------------
{
  const seat = mkSeat({ ok: false, error: 'capacity', at: 0 });
  const S = sqSocial(sqstore(), { seatSquad: seat.fn });
  const { ws: [wa, wb, g] } = await stSquad(S, { n: 3, mode: 'ffa' });
  await S.handle(wa, { type: 'squad', op: 'start', id: 's' });
  // NO `at`, though the seating named seat 0: a full server is nobody's
  // fault, and the box must not mark the leader for it (st12).
  const bad = { type: 'squad', op: 'start', error: 'capacity' };
  // A member who sent nothing may already be standing in a lobby that no
  // longer exists; this is what tells them. Nothing started, so every Ready
  // stands and the squad can simply try again.
  const member = (w) => w.rx.length === 2 && same(w.rx[0], bad) && w.rx[1].op === 'state' && w.rx[1].members.every((m) => m.ready === true);
  if (seat.calls.length === 1 && member(wb) && member(g)) ok('(st3) a refusal from the seating reaches every member unsolicited, and the roster after it still has every Ready');
  else fail('(st3) members got ' + JSON.stringify([wb.rx, g.rx]) + ' calls ' + seat.calls.length);
  if (wa.rx.length === 2 && wa.rx[0].op === 'state' && same(wa.rx[1], { ...bad, id: 's' })) ok('(st3) the leader is answered the same refusal, id echoed, last');
  else fail('(st3) leader got ' + JSON.stringify(wa.rx));
  seat.verdict = { ok: true, code: 'RM03' };
  await S.handle(wa, { type: 'squad', op: 'start', id: 's2' });
  if (sqat(wa, 'start').ok === true && seat.calls.length === 2) ok('(st3) and the same squad starts on the next press without anybody readying again');
  else fail('(st3) retry ' + JSON.stringify(sqlast(wa, 'start')));
}

// ---- (st4) a seating that answers nonsense is a refusal, never a success ---
// server.js's seatSquad never does this; a host that injects something else
// (Task 6's brief once gave it `() => null`) must still get an honest answer
// to every member and a squad that can try again.
{
  const said = [];
  for (const verdict of [null, () => undefined, { ok: 'yes', code: 'RM04' }, { ok: true }, { ok: true, code: 7 }, 'ok']) {
    const seat = mkSeat(verdict);
    const S = sqSocial(sqstore(), { seatSquad: seat.fn });
    const { ws: [wa, wb] } = await stSquad(S, { n: 2 });
    await S.handle(wa, { type: 'squad', op: 'start', id: 's' });
    said.push([sqat(wa, 'start').error, sqat(wb, 'start').error, readyRow(wb).join()]);
  }
  if (said.every(([a, b, r]) => a === 'unavailable' && b === 'unavailable' && r === 'true,true'))
    ok('(st4) a seating answer that is not { ok: true, code } is refused unavailable to every member, and every Ready stands');
  else fail('(st4) ' + JSON.stringify(said));
  // AND WITH NO SEATING WIRED AT ALL, the default refuses honestly.
  const S = sqSocial(sqstore());
  const { ws: [wa, wb] } = await stSquad(S, { n: 2 });
  await S.handle(wa, { type: 'squad', op: 'start', id: 'd' });
  if (same(sqlast(wa, 'start'), { type: 'squad', op: 'start', error: 'unavailable', id: 'd' }) && sqat(wb, 'start').error === 'unavailable')
    ok('(st4) a layer built without seatSquad answers every start unavailable — never a start that seated nobody');
  else fail('(st4) default: ' + JSON.stringify([sqlast(wa, 'start'), sqlast(wb, 'start')]));
}

// ---- (st5) every gate refuses BEFORE the seating, and changes nothing -------
// Each is asked on a squad that would otherwise start, so the refusal is the
// gate's and not something else's. The caller gets exactly one frame, nobody
// else gets any, and the seating is never called.
{
  const cases = [];
  const run = async (label, want, setup) => {
    const seat = mkSeat();
    const S = sqSocial(sqstore(), { seatSquad: seat.fn });
    const { caller, others, frame } = await setup(S);
    for (const w of [caller, ...others]) w.rx.length = 0;
    await S.handle(caller, { type: 'squad', op: 'start', id: 'x', ...frame });
    const body = typeof want === 'string' ? { error: want } : want;
    const good = seat.calls.length === 0 && same(caller.rx, [{ type: 'squad', op: 'start', ...body, id: 'x' }]) && others.every((w) => w.rx.length === 0);
    cases.push([label, good ? 'ok' : JSON.stringify({ calls: seat.calls.length, caller: caller.rx, others: others.map((w) => w.rx) })]);
  };
  await run('an account in no squad', 'no_squad', async (S) => ({ caller: sqUp(S, sqws(SQE)), others: [] }));
  await run('a guest in no squad', 'no_squad', async (S) => ({ caller: sqws(null), others: [] }));
  await run('a member', 'not_leader', async (S) => { const { ws: [wa, wb] } = await stSquad(S); return { caller: wb, others: [wa] }; });
  await run('a guest member', 'not_leader', async (S) => { const { ws: [wa, wb, g] } = await stSquad(S, { n: 3, mode: 'ffa' }); return { caller: g, others: [wa, wb] }; });
  // LEADERSHIP IS ASKED BEFORE THE FRAME IS READ: a member sending a rack that
  // is not one learns nothing about racks.
  await run('a member with a bad rack', 'not_leader', async (S) => { const { ws: [wa, wb] } = await stSquad(S); return { caller: wb, others: [wa], frame: { loadout: ['junk'] } }; });
  for (const [what, rack] of [['seven picks on a duel', stR(0, 7)], ['an unknown weapon', ['junk', ...stR(0, 4)]], ['a string', 'mortar'], ['an object', { 0: 'mortar' }], ['a repeated pick', ['mortar', 'mortar', 'volley', 'cluster', 'napalm']]])
    await run('a leader\'s rack of ' + what, 'no_rack', async (S) => { const { ws: [wa, wb] } = await stSquad(S); return { caller: wa, others: [wb], frame: { loadout: rack } }; });
  await run('three on a duel', 'wont_fit', async (S) => { const { ws: [wa, wb, g] } = await stSquad(S, { n: 3 }); return { caller: wa, others: [wb, g] }; });
  await run('one on a free-for-all', 'wont_fit', async (S) => { const { ws: [wa] } = await stSquad(S, { n: 1, mode: 'ffa' }); return { caller: wa, others: [] }; });
  await run('one on a duel', 'wont_fit', async (S) => { const { ws: [wa] } = await stSquad(S, { n: 1 }); return { caller: wa, others: [] }; });
  await run('three on a raid', 'wont_fit', async (S) => { const { ws: [wa, wb, g] } = await stSquad(S, { n: 3, mode: 'boss' }); return { caller: wa, others: [wb, g] }; });
  await run('a member not ready', 'not_ready', async (S) => { const { ws: [wa, wb, g] } = await stSquad(S, { n: 3, mode: 'ffa', ready: [true, true, false] }); return { caller: wa, others: [wb, g] }; });
  await run('the leader not ready and no rack sent', 'not_ready', async (S) => { const { ws: [wa, wb] } = await stSquad(S, { ready: [false, true] }); return { caller: wa, others: [wb] }; });
  // member_offline NAMES THE ROW that is not there, so the box can mark it.
  await run('a member whose socket has closed', { error: 'member_offline', at: 1 }, async (S) => { const { ws: [wa, wb] } = await stSquad(S); wb.readyState = 3; return { caller: wa, others: [] }; });
  await run('a guest whose socket is closing', { error: 'member_offline', at: 2 }, async (S) => { const { ws: [wa, wb, g] } = await stSquad(S, { n: 3, mode: 'ffa' }); g.readyState = 2; return { caller: wa, others: [wb] }; });
  await run('the first of two members gone', { error: 'member_offline', at: 1 }, async (S) => { const { ws: [wa, wb, g] } = await stSquad(S, { n: 3, mode: 'ffa' }); wb.readyState = 3; g.readyState = 3; return { caller: wa, others: [] }; });
  // Row 0 is not always the leader: a guest who joined before them sits above.
  await run('a guest above the leader, gone', { error: 'member_offline', at: 0 }, async (S) => {
    const wa = sqUp(S, sqws(SQA)), g = sqws(null), wc = sqUp(S, sqws(SQC));
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    await S.handle(wc, { type: 'squad', op: 'join', code });
    await S.handle(wa, { type: 'squad', op: 'leave' });
    for (const w of [g, wc]) await S.handle(w, { type: 'squad', op: 'ready', ready: true, loadout: stR(0) });
    g.readyState = 3;
    return { caller: wc, others: [] };
  });
  const bad = cases.filter(([, r]) => r !== 'ok');
  if (!bad.length) ok(`(st5) ${cases.length} refusals, each answered with its own reason and id, before the seating and with nobody else told anything`);
  else fail('(st5) ' + JSON.stringify(bad));
}

// ---- (st6) ledSquad guards start on both halves ---------------------------
{
  // THE ACCOUNT ALONE: a socket holding a GUEST row in squad one, signed in as
  // B, who leads squad two from another device — and squad two is ready.
  const seat = mkSeat();
  const S = sqSocial(sqstore(), { seatSquad: seat.fn });
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null), wc = sqUp(S, sqws(SQC));
  await S.handle(wa, { type: 'squad', op: 'create' });
  await S.handle(g, { type: 'squad', op: 'join', code: sqat(wa, 'state').code, name: 'G', skin: 'gold' });
  await S.handle(wb, { type: 'squad', op: 'create' });
  await S.handle(wc, { type: 'squad', op: 'join', code: sqat(wb, 'state').code });
  for (const w of [wb, wc]) await S.handle(w, { type: 'squad', op: 'ready', ready: true, loadout: stR(0) });
  g.userId = SQB; g.isGuest = false; S.onAuth(g);
  for (const w of [wa, wb, wc, g]) w.rx.length = 0;
  await S.handle(g, { type: 'squad', op: 'start', id: 'x' });
  if (same(g.rx, [{ type: 'squad', op: 'start', error: 'not_leader', id: 'x' }]) && seat.calls.length === 0 && [wa, wb, wc].every((w) => w.rx.length === 0))
    ok('(st6) a socket holding a guest row cannot start the squad its account leads from another device');
  else fail('(st6) cross-squad start: ' + JSON.stringify(g.rx) + ' calls ' + seat.calls.length);
  // THE CONTROL: that squad two WAS startable, by its leader.
  await S.handle(wb, { type: 'squad', op: 'start', id: 'y' });
  if (sqat(wb, 'start').ok === true && seat.calls.length === 1) ok('(st6) while its leader, on the socket holding the leader\'s row, starts it');
  else fail('(st6) control: ' + JSON.stringify(sqlast(wb, 'start')));
}
{
  // THE ROW ALONE: the leader's socket signs out and in as E, still holding
  // the leader's row.
  const seat = mkSeat();
  const S = sqSocial(sqstore(), { seatSquad: seat.fn });
  const { ws: [wa, wb] } = await stSquad(S);
  S.onClose(wa); wa.userId = SQE; wa.isGuest = false; S.onAuth(wa);
  await S.handle(wa, { type: 'squad', op: 'start', id: 'y' });
  if (same(wa.rx, [{ type: 'squad', op: 'start', error: 'not_leader', id: 'y' }]) && seat.calls.length === 0 && wb.rx.length === 0)
    ok('(st6) a socket now signed in as someone else cannot start from the leader\'s row it still holds');
  else fail('(st6) account-switched start: ' + JSON.stringify(wa.rx) + ' calls ' + seat.calls.length);
}

// ---- (st7) the last gate on the racks ---------------------------------------
// Arming a mode stands down every rack it would not keep, but Start does not
// trust that it happened. The rack predicate is injected, so this makes it
// STRICTER between the Readies and the Start — the case a broken stand-down
// would leave — and the member whose rack the room would no longer keep must
// be stood down, the squad shown it, and the start refused before the seating.
{
  let strict = false;
  const validRack = (mode, picks) => validRackFor(mode, picks) && !(strict && picks[0] === 'volley');
  const seat = mkSeat();
  const S = sqSocial(sqstore(), { seatSquad: seat.fn, validRack });
  const { ws: [wa, wb, g] } = await stSquad(S, { n: 3, mode: 'ffa' });   // wb's rack starts with 'volley'
  strict = true;
  await S.handle(wa, { type: 'squad', op: 'start', id: 's' });
  const shown = (w) => same(readyRow(w), [true, false, true]);
  if (seat.calls.length === 0 && sqat(wa, 'start').error === 'not_ready' && sqat(wa, 'start').id === 's' && shown(wa) && shown(wb) && shown(g))
    ok('(st7) a Ready whose rack the room would not keep is stood down at Start, the squad is shown it, and nothing is seated');
  else fail('(st7) ' + JSON.stringify({ calls: seat.calls.length, a: wa.rx, b: readyRow(wb), g: readyRow(g) }));
}

// ---- (st8) the leader's rack on the Start frame ------------------------------
// It stands in for the leader's Ready for this start, it is the rack the
// leader's seat is handed — a copy — and it is not kept.
{
  const seat = mkSeat({ ok: false, error: 'capacity', at: 0 });
  const S = sqSocial(sqstore(), { seatSquad: seat.fn });
  const { ws: [wa, wb] } = await stSquad(S, { ready: [false, true] });
  const frameRack = stR(3);
  await S.handle(wa, { type: 'squad', op: 'start', loadout: frameRack, id: 's' });
  const c = seat.calls[0] || { seats: [{}] };
  if (seat.calls.length === 1 && same(c.seats[0].loadout, frameRack) && c.seats[0].loadout !== frameRack)
    ok('(st8) the leader\'s rack on the frame stands in for their Ready, and their seat is handed a copy of it');
  else fail('(st8) seat 0 was handed ' + JSON.stringify(c.seats[0].loadout));
  // NOT KEPT: the roster pushed after the refusal still shows the leader not
  // ready, and a start without a rack is not_ready.
  const rowAfter = readyRow(wb);
  await S.handle(wa, { type: 'squad', op: 'start', id: 's2' });
  if (same(rowAfter, [false, true]) && sqat(wa, 'start').error === 'not_ready' && seat.calls.length === 1)
    ok('(st8) and it is not kept: after a refused start the leader is still not ready');
  else fail('(st8) kept? roster ' + JSON.stringify(rowAfter) + ' then ' + JSON.stringify(sqlast(wa, 'start')));
}

// ---- (st9) the host seat is the leader's, wherever the roster puts them -----
// Leadership passes to the earliest-joined SIGNED-IN member, so a guest who
// joined before them sits above the leader in the roster.
{
  const seat = mkSeat();
  const S = sqSocial(sqstore(), { seatSquad: seat.fn });
  const wa = sqUp(S, sqws(SQA)), g = sqws(null), wc = sqUp(S, sqws(SQC));
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = sqat(wa, 'state').code;
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  await S.handle(wc, { type: 'squad', op: 'join', code });
  await S.handle(wa, { type: 'squad', op: 'leave' });
  for (const w of [g, wc]) await S.handle(w, { type: 'squad', op: 'ready', ready: true, loadout: stR(0) });
  const roster = sqat(wc, 'state');
  await S.handle(wc, { type: 'squad', op: 'start', id: 's' });
  const c = seat.calls[0] || { seats: [] };
  if (roster.leader === SQC && roster.you === 1 && c.seats.length === 2 && c.seats[0].ws === wc && c.seats[1].ws === g)
    ok('(st9) a leader who sits below a guest in the roster is still handed to the seating first');
  else fail('(st9) roster ' + JSON.stringify([roster.leader, roster.you]) + ' seats ' + JSON.stringify(c.seats.map((s) => (s.ws === wc ? 'c' : s.ws === g ? 'g' : '?'))));
}

// ---- (st10) a device that is not holding the leader's seat is refused -------
// ledSquad lets a second device of the leader act as the leader, and for kick
// and mode that is harmless. Start is different: it SEATS a socket, and the
// socket the squad would seat as host is the one on the leader's ROW. Seating
// it for a press on another device leaves the leader looking at a screen in no
// room while their tank waits on a device they may not be watching — and a
// squad duel gives a turn a day's grace. So the press is refused wrong_device
// and nobody is seated.
{
  const seat = mkSeat({ ok: true, code: 'RM10' });
  const S = sqSocial(sqstore(), { seatSquad: seat.fn });
  const { ws: [wa, wb] } = await stSquad(S);
  const wa2 = sqUp(S, sqws(SQA));
  await S.handle(wa2, { type: 'squad', op: 'start', id: 'd' });
  if (same(wa2.rx, [{ type: 'squad', op: 'start', error: 'wrong_device', id: 'd' }]) && seat.calls.length === 0 && wa.rx.length === 0 && wb.rx.length === 0)
    ok('(st10) the leader\'s second device is refused wrong_device, nobody is seated, and nobody else is told anything');
  else fail('(st10) second device: ' + JSON.stringify(wa2.rx) + ' calls ' + seat.calls.length + ' row got ' + JSON.stringify(wa.rx));
  // LEADERSHIP IS STILL ASKED FIRST: a member's second device is not_leader,
  // not told which device would have been the right one.
  const wb2 = sqUp(S, sqws(SQB));
  await S.handle(wb2, { type: 'squad', op: 'start', id: 'e' });
  if (same(wb2.rx, [{ type: 'squad', op: 'start', error: 'not_leader', id: 'e' }])) ok('(st10) a member\'s second device is not_leader, as the member is');
  else fail('(st10) member second device: ' + JSON.stringify(wb2.rx));
  // THE CONTROL: the same squad starts from the device holding the leader's row.
  await S.handle(wa, { type: 'squad', op: 'start', id: 'f' });
  if (sqat(wa, 'start').ok === true && seat.calls.length === 1 && seat.calls[0].seats[0].ws === wa) ok('(st10) while the device holding the leader\'s row starts it');
  else fail('(st10) control: ' + JSON.stringify(sqlast(wa, 'start')));
}

// ---- (st12) a refusal from the seating names the ROW that failed ------------
// seatSquad answers `at`, the index in the list it was HANDED — leader first.
// The box addresses members by ROSTER index, and the two differ whenever the
// leader is not the first row (a guest who joined earlier sits above them), so
// the handler translates. An `at` that names no seat is dropped, not passed on.
{
  const seat = mkSeat({ ok: false, error: 'member_busy', at: 1 });
  const S = sqSocial(sqstore(), { seatSquad: seat.fn });
  const wa = sqUp(S, sqws(SQA)), g = sqws(null), wc = sqUp(S, sqws(SQC));
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = sqat(wa, 'state').code;
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  await S.handle(wc, { type: 'squad', op: 'join', code });
  await S.handle(wa, { type: 'squad', op: 'leave' });
  for (const w of [g, wc]) await S.handle(w, { type: 'squad', op: 'ready', ready: true, loadout: stR(0) });
  // Roster: the guest at row 0, the leader (C) at row 1. Seats: C, then G.
  const said = [];
  for (const at of [1, 0, -1, 2, '1', undefined]) {
    seat.verdict = { ok: false, error: 'member_busy', at };
    g.rx.length = 0; wc.rx.length = 0;
    await S.handle(wc, { type: 'squad', op: 'start', id: 'b' });
    said.push([sqlast(wc, 'start'), sqlast(g, 'start')]);
  }
  const want = (at) => (at === undefined ? {} : { at });
  const expect = [0, 1, undefined, undefined, undefined, undefined].map((at) => [
    { type: 'squad', op: 'start', error: 'member_busy', ...want(at), id: 'b' },
    { type: 'squad', op: 'start', error: 'member_busy', ...want(at) },
  ]);
  if (same(said, expect)) ok('(st12) a seating refusal carries `at` as the ROSTER row that failed, to the leader and every member; an index naming no seat is dropped');
  else fail('(st12) ' + JSON.stringify(said));
  // `at` RIDES ONLY WHERE A MEMBER IS AT FAULT: member_busy (above) and
  // member_offline carry it; a full server, a room the engine would not build
  // or start, and an engine fault are nobody's doing and carry none, whatever
  // index the seating reported.
  const said2 = [];
  for (const [error, at] of [['member_offline', 1], ['member_offline', 0], ['capacity', 0], ['refused', 1], ['refused', 0], ['refused', -1], ['unavailable', 1]]) {
    seat.verdict = { ok: false, error, at };
    g.rx.length = 0; wc.rx.length = 0;
    await S.handle(wc, { type: 'squad', op: 'start', id: 'c' });
    said2.push([sqlast(wc, 'start'), sqlast(g, 'start')]);
  }
  const expect2 = [['member_offline', 0], ['member_offline', 1], ['capacity'], ['refused'], ['refused'], ['refused'], ['unavailable']].map(([error, at]) => [
    { type: 'squad', op: 'start', error, ...(at === undefined ? {} : { at }), id: 'c' },
    { type: 'squad', op: 'start', error, ...(at === undefined ? {} : { at }) },
  ]);
  if (same(said2, expect2)) ok('(st12) `at` rides only on member_busy and member_offline — never on capacity, refused or unavailable, whatever index the seating gave');
  else fail('(st12) at on other refusals: ' + JSON.stringify(said2));
}

// ---- (st11) one token per start ---------------------------------------------
// handleSquad spends the squad bucket for every op; a handler that spent it
// again would halve the allowance. The create spends one of twenty, so
// nineteen starts are answered and the twentieth is slow_down — at a frozen
// clock nothing refills.
{
  const S = sqSocial(sqstore(), { seatSquad: mkSeat().fn });
  const wa = sqUp(S, sqws(SQA));
  await S.handle(wa, { type: 'squad', op: 'create' });
  const answers = [];
  for (let i = 0; i < 20; i++) { await S.handle(wa, { type: 'squad', op: 'start', id: i }); answers.push(sqat(wa, 'start').error); }
  if (answers.slice(0, 19).every((a) => a === 'wont_fit') && answers[19] === 'slow_down')
    ok('(st11) start spends one token from the squad bucket, not two: nineteen answered after a create, the twentieth slow_down');
  else fail('(st11) bucket: ' + JSON.stringify(answers));
}

// ==========================================================================
// TASK 5 — DROPPING, RESUMING, AND THE SQUAD THAT DID NOT SURVIVE A RESTART
// ==========================================================================
// A member whose socket goes keeps their row for the drop window, shown as
// dropped and NOT ready, and is then removed; `squad resume` re-attaches a
// returning account; after a restart every resume answers `gone`.
//
// ONE OUTER BLOCK, so nothing here collides with a name another section
// declares at the top level, and its OWN clock, ids and sockets, so a change
// to another section's fixture cannot break it. What is under test is the
// REAL createSquads and the REAL createSocial, imported at the top of this
// file. What is injected is only what the factories take as arguments in
// production: the store, the clock, the socket, and — for the drop window —
// the scheduler.
//
// NO WALL-CLOCK SLEEPS. The window's timer is INJECTED (createSocial's
// `schedule`), so a test fires it by hand after moving the injected clock,
// and nothing here can flake because the machine running the suite is busy.
// The one test of the real default scheduler waits on a CONDITION with a
// generous ceiling rather than on a fixed sleep. A push is asynchronous only
// by the store double's microtasks, so `flush5` — one macrotask turn — is
// enough to let every one of them land.
{
  const D5 = (n) => '00000000-0000-4000-8000-5d' + String(n).padStart(10, '0');
  const LEAD = D5(1), MEM = D5(2), THIRD = D5(3), FOURTH = D5(4), ANON = D5(9);
  let CLOCK5 = Date.parse('2026-09-24T09:00:00Z');
  const now5 = () => CLOCK5;
  // A LINKED account is userId set and isGuest false. A GUEST is a socket
  // with a real anonymous account id and isGuest TRUE — the case that
  // actually happens — or a socket that never said hello.
  const mkws5 = (userId = null, isGuest = false) => ({ readyState: 1, userId, isGuest, rx: [] });
  const mem5 = (userId, ws) => ({ userId, guest: !userId, name: 'Rolling Thunder', skin: 'olive', ws });
  const RACK5 = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
  const rows5 = (sq) => sq.members.map((m) => m.userId || 'guest');

  // ---- (d1) a closed member is stamped dropped and KEEPS their row ---------
  {
    const S = createSquads({ now: now5 });
    const wl = mkws5(LEAD), wm = mkws5(MEM);
    const sq = S.create(mem5(LEAD, wl));
    CLOCK5 += 1;
    S.join(sq.code, mem5(MEM, wm));
    S.setReady(MEM, true, RACK5);
    wm.readyState = 3;                         // the socket closed
    CLOCK5 += 5000;
    const got = S.markDropped(MEM, CLOCK5);
    const m = sq.members.find((x) => x.userId === MEM);
    if (got === sq && sq.members.length === 2 && m && m.dropAt === CLOCK5 && m.ws === null && S.ofUser(MEM) === sq)
      ok('(d1) a closed member is stamped dropped, loses their socket, and KEEPS their row and their index entry');
    else fail('(d1) markDropped: ' + JSON.stringify({ got: got && got.code, n: sq.members.length, m }, noWs));
    // "A dropped member is not ready" is literal (design 4.3). Left set, the
    // flag and the rack would outlive the socket they were readied on.
    if (m && m.ready === false && m.loadout === null)
      ok('(d1) and a dropped member is NOT ready — the flag and the rack go with the socket');
    else fail('(d1) ready survived the drop: ' + JSON.stringify(m, noWs));
  }

  // ---- (d2) a GUEST is found by their socket, and by nothing else ----------
  {
    const S = createSquads({ now: now5 });
    const wl = mkws5(LEAD);
    const sq = S.create(mem5(LEAD, wl));
    const wg = mkws5(ANON, true);              // a guest HAS an anonymous id...
    S.join(sq.code, mem5(null, wg));           // ...and joins as null
    // THE FLOOR FIRST: the anonymous id on the socket is not a squad key. If
    // it were, a second socket presenting that id could claim the row.
    if (S.markDropped(ANON, CLOCK5) === null && sq.members[1].dropAt === null)
      ok('(d2) the anonymous account id a guest socket carries is not a squad key');
    else fail('(d2) the anonymous id resolved a guest member');
    wg.readyState = 3;
    const got = S.markDropped(wg, CLOCK5);
    const g = sq.members[1];
    if (got === sq && g.userId === null && g.dropAt === CLOCK5 && g.ws === null && sq.members.length === 2 && S.ofUser(wg) === sq)
      ok('(d2) a guest is dropped by the SOCKET that is their key, and their row is kept like anyone else\'s');
    else fail('(d2) guest drop: ' + JSON.stringify({ got: got && got.code, g }, noWs));
  }

  // ---- (d3) a member whose row holds a LIVE socket is not dropped ----------
  // The engine's `player.ws === ws` rule, in the machine's terms: nothing
  // there is to drop. server/social.js only ever hands markDropped the key of
  // the row the closing socket holds, so from there this guard cannot be
  // reached; it is the machine holding its own rule for a direct caller.
  {
    const S = createSquads({ now: now5 });
    const wl = mkws5(LEAD), wm = mkws5(MEM);
    const sq = S.create(mem5(LEAD, wl));
    S.join(sq.code, mem5(MEM, wm));
    const m = sq.members[1];
    if (S.markDropped(MEM, CLOCK5 + 10) === null && m.dropAt === null && m.ws === wm)
      ok('(d3) a member whose row holds a live socket is not dropped');
    else fail('(d3) the live socket was dropped: ' + JSON.stringify({ dropAt: m.dropAt, isWm: m.ws === wm }));
    // THE CONTROL: the guard is the socket's state, not a refusal to drop.
    wm.readyState = 3;
    if (S.markDropped(MEM, CLOCK5 + 20) === sq && m.dropAt === CLOCK5 + 20)
      ok('(d3) and once that socket has closed, the same call drops them');
    else fail('(d3) the guard refused a real drop: ' + JSON.stringify({ dropAt: m.dropAt }));
    // ---- (d4) a second close does not slide the window forward -----------
    // onClose is reached from three places in server.js; re-stamping dropAt
    // would hold a member for ever under a socket that closes repeatedly.
    if (S.markDropped(MEM, CLOCK5 + 9999) === null && m.dropAt === CLOCK5 + 20)
      ok('(d4) a second close does not re-stamp dropAt, so the window cannot be slid forward');
    else fail('(d4) the window moved: ' + JSON.stringify({ dropAt: m.dropAt }));
    // A TIME THAT IS NOT ONE IS NOT A DROP. A row with its socket gone and
    // dropAt still null would never be swept: a ghost for the squad's life.
    const wt = mkws5(THIRD);
    S.join(sq.code, mem5(THIRD, wt));
    wt.readyState = 3;
    const t = sq.members[2];
    const bad = [undefined, null, NaN, '1700000000000'].map((at) => S.markDropped(THIRD, at));
    if (bad.every((r) => r === null) && t.ws === wt && t.dropAt === null)
      ok('(d4) a drop stamped with anything but a finite time is refused and the row is untouched');
    else fail('(d4) a bad time was stamped: ' + JSON.stringify({ bad: bad.map((r) => r && r.code), dropAt: t.dropAt, ws: t.ws === wt }));
    if (S.markDropped(null, CLOCK5) === null && S.markDropped(D5(77), CLOCK5) === null && S.markDropped({}, CLOCK5) === null)
      ok('(d4) a key that holds no row drops nothing');
    else fail('(d4) a stranger key dropped something');
  }

  // ---- (d5) resume re-attaches an ACCOUNT's row, and hands back no Ready ---
  {
    const S = createSquads({ now: now5 });
    const wl = mkws5(LEAD), wm = mkws5(MEM);
    const sq = S.create(mem5(LEAD, wl));
    S.join(sq.code, mem5(MEM, wm));
    S.setReady(MEM, true, RACK5);
    wm.readyState = 3;
    S.markDropped(MEM, CLOCK5);
    const w3 = mkws5(MEM);                     // the reconnect
    const m = sq.members[1];
    if (S.markResumed(MEM, w3) === sq && m.ws === w3 && m.dropAt === null && S.keyOfSocket(w3) === MEM)
      ok('(d5) resume re-attaches the new socket to the account\'s row and clears dropAt');
    else fail('(d5) markResumed: ' + JSON.stringify({ isW3: m.ws === w3, dropAt: m.dropAt }));
    // READY IS NOT HANDED BACK. The player has been away and the leader may
    // have changed the mode; they say so again.
    if (m.ready === false && m.loadout === null)
      ok('(d5) and it does NOT restore Ready — a player who was away says so again');
    else fail('(d5) Ready came back by itself: ' + JSON.stringify(m, noWs));
    // THE SOCKET ALREADY ON THE ROW is a no-op re-attach, not a refusal.
    if (S.markResumed(MEM, w3) === sq && m.ws === w3) ok('(d5) resuming onto the socket already on the row changes nothing and says so');
    else fail('(d5) a same-socket resume was refused');
    // A GUEST CAN NEVER RESUME: their key was the socket that went, a new
    // socket is a new key, and the anonymous id is not a key. The OLD socket
    // object is the one spelling a client could never produce — it is the
    // machine's own guard against a direct caller handing it over.
    const wg = mkws5(ANON, true);
    S.join(sq.code, mem5(null, wg));
    wg.readyState = 3;
    S.markDropped(wg, CLOCK5);
    const g = sq.members[2];
    const wg2 = mkws5(ANON, true);
    const tries = [S.markResumed(wg2, wg2), S.markResumed(ANON, wg2), S.markResumed(null, wg2), S.markResumed(wg, wg2)];
    if (tries.every((r) => r === null) && g.ws === null && g.dropAt === CLOCK5)
      ok('(d5) a guest row is never resumed — not by a new socket, not by the anonymous id, not even by the old socket object');
    else fail('(d5) a guest row was resumed: ' + JSON.stringify({ tries: tries.map((r) => r && r.code), dropAt: g.dropAt, ws: !!g.ws }));
  }

  // ---- (d5b) ONE SOCKET, ONE ROW: resume never gives a socket a second row -
  // The invariant task 2 handed on (item 3): a socket on two rows is a
  // player counted twice — in `fits`, in the start gate, in the seats.
  {
    const S = createSquads({ now: now5 });
    const wl = mkws5(LEAD), wt = mkws5(THIRD), wm = mkws5(MEM);
    const x = S.create(mem5(LEAD, wl));
    S.join(x.code, mem5(MEM, wm));
    const y = S.create(mem5(THIRD, wt));
    wm.readyState = 3;
    S.markDropped(MEM, CLOCK5);
    // A socket that already holds a GUEST row in Y presents MEM's account.
    const w = mkws5(null);
    S.join(y.code, mem5(null, w));
    const m = x.members[1];
    if (S.markResumed(MEM, w) === null && m.ws === null && m.dropAt === CLOCK5 && S.keyOfSocket(w) === w)
      ok('(d5b) a socket that already holds a row is not given a second one by resume');
    else fail('(d5b) one socket, two rows: ' + JSON.stringify({ ws: m.ws === w, dropAt: m.dropAt }));
    // THE CONTROL: the same account, on a socket holding nothing, resumes.
    const w2 = mkws5(MEM);
    if (S.markResumed(MEM, w2) === x && m.ws === w2) ok('(d5b) and the same account on a socket holding no row resumes normally');
    else fail('(d5b) the guard refused a real resume');
  }

  // ---- (d6) the sweep: the boundary, and a sweep that removes nobody -------
  {
    const S = createSquads({ now: now5 });
    const T = CLOCK5;
    const wl = mkws5(LEAD), wm = mkws5(MEM), wt = mkws5(THIRD);
    const sq = S.create(mem5(LEAD, wl));
    S.join(sq.code, mem5(MEM, wm));
    S.join(sq.code, mem5(THIRD, wt));
    wm.readyState = 3; wt.readyState = 3;
    S.markDropped(MEM, T);                     // exactly ON the cutoff
    S.markDropped(THIRD, T + 1);               // one millisecond inside it
    const changed = S.sweepDropped(T);
    if (changed.length === 1 && changed[0] === sq && same(rows5(sq), [LEAD, THIRD]) && S.ofUser(MEM) === null && S.ofUser(THIRD) === sq)
      ok('(d6) dropAt === cutoff is swept, one millisecond later is kept, the index entry goes with the row, and the squad is returned once');
    else fail('(d6) sweep boundary: ' + JSON.stringify({ n: changed.length, rows: rows5(sq), mem: !!S.ofUser(MEM) }));
    // A squad that lost nobody is not returned: a sweep is not a broadcast.
    if (S.sweepDropped(T).length === 0 && same(rows5(sq), [LEAD, THIRD]))
      ok('(d6) a sweep that removes nobody returns nothing to push');
    else fail('(d6) an idle sweep returned squads to push');
    // TWO REMOVALS FROM ONE SQUAD ARE ONE PUSH.
    const wf = mkws5(FOURTH);
    S.join(sq.code, mem5(FOURTH, wf));
    wf.readyState = 3;
    S.markDropped(FOURTH, T + 1);
    const both = S.sweepDropped(T + 1);
    if (both.length === 1 && both[0] === sq && same(rows5(sq), [LEAD]))
      ok('(d6) a squad that loses two members in one sweep is returned once');
    else fail('(d6) two removals: ' + JSON.stringify({ n: both.length, rows: rows5(sq) }));
  }

  // ---- (d7) the leader swept hands off exactly as leave() does -------------
  // Two identical squads, one swept and one left, the answers compared: the
  // sweep does not re-derive the earliest-survivor rule, it goes through
  // leave(). joinedAt is stamped by the MACHINE from now() (task 2's
  // mkMember), so the join order is made with the clock: MEM joins before
  // THIRD but sits below them in the roster, so a tie-break by roster order
  // and the real rule give different heirs.
  {
    const build = () => {
      const S = createSquads({ now: now5 });
      const T0 = CLOCK5;
      const sq = S.create(mem5(LEAD, mkws5(LEAD)));
      CLOCK5 = T0 + 50; S.join(sq.code, mem5(THIRD, mkws5(THIRD)));
      CLOCK5 = T0 + 10;
      // MEM is stamped earlier than THIRD although they join later.
      S.join(sq.code, mem5(MEM, mkws5(MEM)));
      CLOCK5 = T0;
      return { S, sq };
    };
    const a = build(), b = build();
    a.sq.members[0].ws.readyState = 3;
    a.S.markDropped(LEAD, CLOCK5);
    a.S.sweepDropped(CLOCK5);
    b.S.leave(LEAD);
    if (a.sq.leader === MEM && b.sq.leader === MEM && same(rows5(a.sq), rows5(b.sq)))
      ok('(d7) the earliest-joined survivor inherits, and the swept answer is the one leave() gives');
    else fail(`(d7) sweep leader ${a.sq.leader} vs leave leader ${b.sq.leader}`);
  }

  // ---- (d8) the last member swept deletes the squad ------------------------
  // An emptied squad left behind is one permanent entry per squad ever
  // formed, and holds its code against every future mint.
  {
    const S = createSquads({ now: now5 });
    const wl = mkws5(LEAD);
    const sq = S.create(mem5(LEAD, wl));
    wl.readyState = 3;
    S.markDropped(LEAD, CLOCK5);
    const changed = S.sweepDropped(CLOCK5);
    if (!S.has(sq.code) && S.get(sq.code) === null && S.ofUser(LEAD) === null && changed.length === 0)
      ok('(d8) the last member swept deletes the squad and its index entry, and there is nobody to push to');
    else fail('(d8) an emptied squad survived: ' + JSON.stringify({ has: S.has(sq.code), ofUser: !!S.ofUser(LEAD), n: changed.length }));
  }

  // ---- (d8b) A SWEPT GUEST GOES THROUGH THE SAME DOOR, AND THE INDEX WITH IT
  // A guest's byKey entry is keyed by their socket. A removal that skipped
  // the index would leave a dead socket pointing at a squad for ever.
  {
    const S = createSquads({ now: now5 });
    const wl = mkws5(LEAD), wg = mkws5(null);
    const sq = S.create(mem5(LEAD, wl));
    S.join(sq.code, mem5(null, wg));
    wg.readyState = 3;
    S.markDropped(wg, CLOCK5);
    const changed = S.sweepDropped(CLOCK5);
    if (changed.length === 1 && changed[0] === sq && same(rows5(sq), [LEAD]) && S.ofUser(wg) === null && S.keyOfSocket(wg) === null)
      ok('(d8b) a swept guest leaves the roster AND the index — no dead socket keeps pointing at the squad');
    else fail('(d8b) guest sweep: ' + JSON.stringify({ n: changed.length, rows: rows5(sq), ofUser: !!S.ofUser(wg) }));
  }

  // ---- (d8c) THE LEADER SWEPT WITH ONLY GUESTS LEFT ENDS THE SQUAD — AND THE
  // GUESTS STILL STANDING IN IT ARE RETURNED, SO THEY CAN BE TOLD ---------
  // leave() ends a squad nobody signed in is left to lead (task 2). It keeps
  // the member list on the squad object it hands back precisely so the people
  // it ended under can be told; a sweep that dropped that squad on the floor
  // would leave their boxes showing a squad that no longer exists.
  {
    const S = createSquads({ now: now5 });
    const wl = mkws5(LEAD), wg = mkws5(null), wh = mkws5(null);
    const sq = S.create(mem5(LEAD, wl));
    S.join(sq.code, mem5(null, wg));
    S.join(sq.code, mem5(null, wh));
    wl.readyState = 3;
    S.markDropped(LEAD, CLOCK5);
    const changed = S.sweepDropped(CLOCK5);
    if (!S.has(sq.code) && changed.length === 1 && changed[0] === sq && sq.members.length === 2
      && S.ofUser(wg) === null && S.ofUser(wh) === null && S.ofUser(LEAD) === null)
      ok('(d8c) a squad left with only guests ends, its index is emptied, and it is returned with the guests on it to be told');
    else fail('(d8c) leaderless sweep: ' + JSON.stringify({ has: S.has(sq.code), n: changed.length, left: sq.members.length }));
  }

  // ---- (end of task 5) ----
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall squad checks passed');
process.exit(out.errors.length ? 1 : 0);
