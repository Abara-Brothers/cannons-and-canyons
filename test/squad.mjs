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
    // Task 6: a join reads the joiner's blocks. Nobody here has blocked
    // anybody, and the read is not counted in `calls`.
    async blockIdsOf() { return { blocked: [], blockedBy: [] }; },
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
  // `online` IS PRESENCE FOR AN ACCOUNT AND THE SOCKET FOR A GUEST, and the
  // test must be able to tell presence from the row's socket. (It first did
  // so by closing D's presence with the sign-out hook while D's socket
  // stayed open; since task 5 that hook is a leave.) It asks the case where
  // they really diverge in production: D's row socket closes — a real close,
  // so the row is DROPPED — while D is signed in on a SECOND DEVICE. D is
  // online (presence: the friends panel's dot, the same everywhere) and the
  // row is dropped (this seat's socket); the box renders dropped over online.
  // Taken from the row's socket, D would read offline. The guest's socket
  // goes too: a guest's `online` is its own socket. B then joins, which is
  // the push the assertions read.
  sqUp(S, sqws(SQD));                          // D's second device
  wd.readyState = 3; S.onClose(wd); g.readyState = 3;
  const wb = sqUp(S, sqws(SQB));
  await S.handle(wb, { type: 'squad', op: 'join', code });
  const now4 = (sqlast(wa, 'state') || {}).members || [];
  if (now4.length === 4 && now4[0].online === true
    && now4[1].id === SQD && now4[1].online === true && now4[1].dropped === true
    && now4[2].guest === true && now4[2].online === false
    && now4[3].id === SQB && now4[3].online === true)
    ok('(h1) online is the account\'s presence — a dropped row whose account is on another device reads online — and a guest\'s is its own socket');
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
  // AND THE REVERSE: a socket whose identity is gone while it still holds its
  // account's row leaves THAT row, handing leadership on.
  //
  // THE STATE IS BUILT DIRECTLY, without server.js's hook. Since task 5 a
  // sign-out runs the hook with the socket open, which is a LEAVE, so the
  // server itself no longer leaves a signed-out socket holding the row (task
  // 5's (d11) tests that sequence). This keeps squadKey's socket-first rule
  // proved for an ACCOUNT row as well as a guest's.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB));
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(wb, { type: 'squad', op: 'join', code });
    wa.userId = null; wa.isGuest = false;
    wb.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'leave', id: 'o' });
    const heir = sqat(wb, 'state');
    if (sqat(wa).op === 'left' && heir.leader === SQB && heir.members && heir.members.length === 1)
      ok('(h9) a socket that signed out leaves the account row it holds, and leadership passes on');
    else fail('(h9) leave after sign-out: ' + JSON.stringify(heir));
  }
  // BUT LEADERSHIP IS THE ACCOUNT'S. A socket signed in as ANOTHER account
  // while it still holds the leader's row must not command that squad: the
  // row it holds and the account on it must both be the leader.
  //
  // THE STATE IS BUILT DIRECTLY, without server.js's hook: since task 5 an
  // account switch runs the hook on the open socket, which is a leave, so the
  // server no longer produces it. ledSquad's row half is defence in depth
  // now, and this keeps it proved; task 5's (d11) tests the real sequence.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null);
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(wb, { type: 'squad', op: 'join', code });
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    wa.userId = SQE; wa.isGuest = false; S.onAuth(wa);
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
  // signs in on the same socket readies the row it holds — found by the
  // account instead, it would ready SOMEBODY ELSE'S ROW.
  //
  // BUILT WHERE THE TWO DIFFER (task 5's fix pass). Since then a signed-in
  // guest's row becomes the account's at the sign-in (claimOnSignIn), so the
  // row and the account agree and a test built there cannot tell them apart
  // — (d18) covers that case. They still differ in exactly one state, and the
  // guard is asked there: the account is ALREADY IN ANOTHER SQUAD (Y, led
  // from its other device), so the guest row in X stays a guest row. Ready
  // pressed on X's screen must ready the guest row in X, and leave the
  // account's row in Y alone.
  const wd = sqUp(S, sqws(SQD));
  await S.handle(wd, { type: 'squad', op: 'create' });                  // SQD leads Y elsewhere
  const Y = sqat(wd, 'state').code;
  const h = sqws(null);
  await S.handle(h, { type: 'squad', op: 'join', code, name: 'H', skin: 'gold' });
  h.userId = SQD; h.isGuest = false; S.onAuth(h);
  h.rx.length = 0; wd.rx.length = 0;
  await S.handle(h, { type: 'squad', op: 'ready', ready: true, loadout: RACK5, id: 'h' });
  const hrow = (sqat(wa, 'state').members || [])[3] || {};
  await S.handle(wd, { type: 'squad', op: 'resume', code: Y, id: 'y' });
  const yrow = ((wd.rx.find((f) => f.id === 'y') || {}).members || [])[0] || {};
  if (sqat(h, 'ready').ok === true && hrow.guest === true && hrow.ready === true && yrow.id === SQD && yrow.ready === false)
    ok('(s3f) a guest who signed in on the same socket readies the guest row it holds — not its account\'s row in another squad');
  else fail('(s3f) signed-in guest ready: ' + JSON.stringify(h.rx) + ' row ' + JSON.stringify(hrow) + ' account row in Y ' + JSON.stringify(yrow));

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
  // THE ROW ALONE: the leader's socket is signed in as E while still holding
  // the leader's row. It must not arm that squad. Built directly, without
  // server.js's hook, which since task 5 makes an account switch a leave
  // (see (h9)'s note); ledSquad's row half stays proved as defence in depth.
  const S = sqSocial(sqstore());
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB));
  await S.handle(wa, { type: 'squad', op: 'create' });
  await S.handle(wb, { type: 'squad', op: 'join', code: sqat(wa, 'state').code });
  wa.userId = SQE; wa.isGuest = false; S.onAuth(wa);
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
  // THE ROW ALONE: the leader's socket is signed in as E while still holding
  // the leader's row. Built directly, without server.js's hook, which since
  // task 5 makes an account switch a leave (see (h9)'s note).
  const seat = mkSeat();
  const S = sqSocial(sqstore(), { seatSquad: seat.fn });
  const { ws: [wa, wb] } = await stSquad(S);
  wa.userId = SQE; wa.isGuest = false; S.onAuth(wa);
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

  // ==== THE SOCIAL LAYER: the close hook, the timer, the fan-out ============
  // THE CLOCKWORK: an injected scheduler that records every timer it is asked
  // for, stamps it due at CLOCK5 + ms, and runs it only when the test says so.
  // createSocial takes it as `schedule(fn, ms) -> cancel`, and production's
  // default is a real setTimeout (tested once, below, on its own).
  //   fire()  — run every timer whose time has come by CLOCK5: what a real
  //             timer does once the clock has moved.
  //   force() — run every timer still pending, due or not: a timer firing
  //             EARLY by the wall clock, which Node can do by a millisecond.
  const mkClockwork = () => {
    const all = [];
    const schedule = (fn, ms) => { const t = { fn, ms, due: CLOCK5 + ms, off: false, ran: false }; all.push(t); return () => { t.off = true; }; };
    const pending = () => all.filter((t) => !t.off && !t.ran);
    const run = (list) => { for (const t of list) { if (t.off || t.ran) continue; t.ran = true; t.fn(); } return list.length; };
    const fire = () => run(pending().filter((t) => t.due <= CLOCK5));
    const force = () => run(pending());
    return { all, schedule, pending, fire, force };
  };
  const flush5 = () => new Promise((r) => setImmediate(r));
  // true once `p` settles, false if it has not within fifty macrotask turns —
  // so a read that is never entered fails its assertion instead of leaving
  // the file hanging on an await that nothing will ever settle.
  const within5 = async (p) => {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 50 && !done; i++) await flush5();
    return done;
  };
  const NAMES5 = { [LEAD]: 'Anvil Six', [MEM]: 'Bunker Nine', [THIRD]: 'Crater Two', [FOURTH]: 'Delta Four' };
  // profilesByIds answers the three columns server/store.js really selects,
  // and nothing else. `gate`, when set, holds the read until it resolves, and
  // `entered` resolves the moment a read is waiting on it — so a test can act
  // INSIDE a name read without guessing how long one takes.
  const store5 = () => {
    const st = { gate: null, entered: null, onEnter: null, calls: 0 };
    // Task 6: a join reads the joiner's blocks; nobody here has blocked
    // anybody, and the read is not counted in `calls`.
    st.blockIdsOf = async () => ({ blocked: [], blockedBy: [] });
    st.profilesByIds = async (ids) => {
      st.calls += 1;
      if (st.gate) { const g = st.gate; st.gate = null; if (st.onEnter) st.onEnter(); await g; }
      const m = new Map();
      for (const id of ids) if (NAMES5[id]) m.set(id, { id, callsign: NAMES5[id], callsign_key: NAMES5[id].toLowerCase() });
      return m;
    };
    st.hold = () => {
      let release;
      st.gate = new Promise((r) => { release = r; });
      st.entered = new Promise((r) => { st.onEnter = r; });
      return () => release();
    };
    return st;
  };
  // The send server.js really uses, down to the wire: nothing reaches a
  // socket that is not open, and what does has been through JSON.
  const social5 = (store = store5(), { clock = now5, cw = null, seatSquad } = {}) => createSocial({
    store, terms: [], now: clock, seats: MODE_SEATS, teeIds: TEE_IDS, validRack: validRackFor,
    ...(seatSquad ? { seatSquad } : {}),
    ...(cw ? { schedule: cw.schedule } : {}),
    send: (ws, f) => { if (ws && ws.readyState === 1) ws.rx.push(JSON.parse(JSON.stringify(f))); },
  });
  const sq5 = (w, op) => w.rx.filter((f) => f.type === 'squad' && (!op || f.op === op));
  const last5 = (w, op) => { const f = sq5(w, op); return f[f.length - 1] || null; };
  const up5 = (S, ws) => { S.onAuth(ws); return ws; };
  // server.js's close, exactly: the socket is CLOSED by the time the event
  // fires, and the hook runs before the engine's handleClose.
  const close5 = (S, ws) => { ws.readyState = 3; S.onClose(ws); };
  // server.js's sign-out branch, exactly: the hook with the socket still
  // OPEN, then the generation bump, then the identity cleared.
  const signOut5 = (S, ws) => { S.onClose(ws); ws.authGen = (ws.authGen || 0) + 1; ws.userId = null; ws.isGuest = false; ws.chosenName = null; };
  // A hello for a DIFFERENT account: the generation is bumped when the hello
  // arrives, and the hook runs when its verification lands, only when the
  // socket already had an id — then the new id, then onAuth.
  const switch5 = (S, ws, id, guest = false) => { ws.authGen = (ws.authGen || 0) + 1; if (ws.userId && ws.userId !== id) S.onClose(ws); ws.userId = id; ws.isGuest = guest; S.onAuth(ws); };
  const pair5 = async (S) => {
    const wl = up5(S, mkws5(LEAD)), wm = up5(S, mkws5(MEM));
    await S.handle(wl, { type: 'squad', op: 'create' });
    const code = (last5(wl, 'state') || {}).code;
    CLOCK5 += 1;
    await S.handle(wm, { type: 'squad', op: 'join', code, name: 'Bee', skin: 'olive' });
    wl.rx.length = 0; wm.rx.length = 0;
    return { wl, wm, code };
  };
  const ids5 = (f) => (f && f.members ? f.members.map((r) => r.id || 'guest') : null);

  // ---- (d9) THE WINDOW, WIRED: a close keeps the row, sixty seconds later it
  // goes, and the squad is told both times ---------------------------------
  {
    const prevEnv = process.env.SQUAD_DROP_MS;
    delete process.env.SQUAD_DROP_MS;          // production's window, not a suite's
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    if (prevEnv === undefined) delete process.env.SQUAD_DROP_MS; else process.env.SQUAD_DROP_MS = prevEnv;
    const { wl, wm } = await pair5(S);
    close5(S, wm);
    await flush5();
    const a = last5(wl, 'state');
    const row = a && a.members.find((r) => r.id === MEM);
    if (a && a.id === undefined && same(ids5(a), [LEAD, MEM]) && row.dropped === true && row.ready === false && row.online === false)
      ok('(d9) a close pushes the squad a roster that still carries the member, marked dropped, not ready and offline, with no id');
    else fail('(d9) close snapshot: ' + JSON.stringify(a));
    const armed = cw.pending();
    if (armed.length === 1 && armed[0].ms === 60000)
      ok('(d9) the close arms ONE timer, and the window is sixty seconds');
    else fail('(d9) timers armed: ' + JSON.stringify(cw.all.map((t) => [t.ms, t.off, t.ran])));
    wl.rx.length = 0;
    CLOCK5 += 60000;
    cw.fire();
    await flush5();
    const b = last5(wl, 'state');
    if (b && b.id === undefined && same(ids5(b), [LEAD]) && sq5(wl).length === 1 && cw.pending().length === 0)
      ok('(d9) when it fires the member is removed and the squad is pushed one fresh roster, and nothing is left armed');
    else fail('(d9) after the window: ' + JSON.stringify(wl.rx) + ' pending ' + cw.pending().length);
  }

  // ---- (d9b) deferred item 1: A DISCONNECTED GUEST IS DROPPED, THEN REMOVED -
  // Before the drop window a guest whose socket closed stayed a member for
  // the life of the squad, holding a dead socket in the index.
  {
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    const { wl, code } = await pair5(S);
    const g = mkws5(ANON, true);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    wl.rx.length = 0;
    close5(S, g);
    await flush5();
    const a = last5(wl, 'state');
    if (a && same(ids5(a), [LEAD, MEM, 'guest']) && a.members[2].dropped === true && a.members[2].online === false)
      ok('(d9b) a guest whose socket closes is marked dropped, and the squad is told');
    else fail('(d9b) guest close: ' + JSON.stringify(a));
    CLOCK5 += 60000;
    cw.fire();
    await flush5();
    const b = last5(wl, 'state');
    if (b && same(ids5(b), [LEAD, MEM])) ok('(d9b) and at the end of the window the guest\'s row is removed');
    else fail('(d9b) guest after the window: ' + JSON.stringify(b));
  }

  // ---- (d9c) deferred item 7: A GUEST WHO SIGNED IN, THEN DISCONNECTED -----
  // The row is found by the SOCKET, not by who is signed in on it. Two
  // shapes since the fix pass. Ordinarily the guest row BECOMES the account's
  // at the sign-in (claimOnSignIn), and its close is an ordinary drop. But
  // when the account is already in ANOTHER squad the guest row stays a guest
  // row under a socket signed in as that account: by identity this socket is
  // MEM, whose row is in the other squad on a live device, and the guest row
  // it really holds would be left behind for good.
  for (const shape of ['adopted', 'another squad']) {
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    const wl = up5(S, mkws5(LEAD));
    await S.handle(wl, { type: 'squad', op: 'create' });
    const code = last5(wl, 'state').code;
    const wm = up5(S, mkws5(MEM));
    if (shape === 'another squad') await S.handle(wm, { type: 'squad', op: 'create' });
    const g = mkws5(null);                     // never said hello
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    switch5(S, g, MEM);                        // signs in mid-squad (no hook: it had no id)
    await flush5();
    const held = shape === 'adopted' ? MEM : 'guest';
    wl.rx.length = 0; wm.rx.length = 0;
    close5(S, g);
    await flush5();
    const a = last5(wl, 'state');
    if (a && same(ids5(a), [LEAD, held]) && a.members[1].dropped === true && sq5(wm).length === 0)
      ok(`(d9c) ${shape}: a guest who signed in and then disconnected — the row their socket holds is dropped, and nothing else is`);
    else fail(`(d9c) ${shape}: signed-in guest close: ` + JSON.stringify({ roster: a, other: wm.rx }));
    CLOCK5 += 60000;
    cw.fire();
    await flush5();
    const b = last5(wl, 'state');
    if (b && same(ids5(b), [LEAD])) ok(`(d9c) ${shape}: and swept at the end of the window — no row is left behind`);
    else fail(`(d9c) ${shape}: after the window: ` + JSON.stringify(b));
  }

  // ---- (d9d) a socket holding NO row closes: nobody is dropped -------------
  // A second device of a member closing is not the member leaving. Their row
  // is on the first device, which is still here.
  {
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    const { wl, wm } = await pair5(S);
    const wm2 = up5(S, mkws5(MEM));
    close5(S, wm2);
    await flush5();
    if (sq5(wl).length === 0 && sq5(wm).length === 0 && cw.all.length === 0)
      ok('(d9d) a second device closing drops nobody, pushes nothing and arms nothing');
    else fail('(d9d) second-device close: ' + JSON.stringify({ wl: wl.rx, timers: cw.all.length }));
  }

  // ---- (d9e) THE WINDOW RESTARTS FOR A MEMBER WHO DROPS AGAIN --------------
  // A member who drops, is removed some other way, comes back and drops
  // again must be swept a full window after the SECOND drop — not left
  // unswept because a timer from the first was still standing.
  {
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    const { wl, wm, code } = await pair5(S);
    const t0 = CLOCK5;
    close5(S, wm);
    await flush5();
    await S.handle(wl, { type: 'squad', op: 'kick', id: MEM });      // removed while dropped
    CLOCK5 = t0 + 30000;
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'join', code });
    close5(S, wm2);                            // the second drop, thirty seconds on
    await flush5();
    // SIXTY SECONDS AFTER THE FIRST DROP: only thirty into the second, so
    // they stay. Whatever timer is standing fires here.
    CLOCK5 = t0 + 60000;
    cw.fire();
    await flush5();
    const mid = last5(wl, 'state');
    const kept = !!(mid && mid.members.some((r) => r.id === MEM && r.dropped === true));
    // SIXTY SECONDS AFTER THE SECOND DROP: they go. A window that kept the
    // FIRST drop's timer instead of replacing it has nothing left armed here,
    // and the member would be dropped for ever.
    CLOCK5 = t0 + 90000;
    cw.fire();
    await flush5();
    const b = last5(wl, 'state');
    if (kept && b && same(ids5(b), [LEAD]))
      ok('(d9e) a second drop re-arms the window from THAT drop: kept at sixty seconds from the first, swept at sixty from the second');
    else fail('(d9e) re-drop: ' + JSON.stringify({ keptAtSixty: kept, last: ids5(b), pending: cw.pending().length }));
    // A FIRED TIMER IS FORGOTTEN. The member comes back and drops a third
    // time; arming for them must find no stale entry to cancel — an entry
    // left behind by a fired timer is one per drop, for ever.
    const wm3 = up5(S, mkws5(MEM));
    await S.handle(wm3, { type: 'squad', op: 'join', code });
    close5(S, wm3);
    if (!cw.all.some((t) => t.ran && t.off) && cw.pending().length === 1)
      ok('(d9e) a timer that has fired leaves no entry behind to be cancelled later');
    else fail('(d9e) a fired timer was still on the books: ' + JSON.stringify(cw.all.map((t) => [t.ran, t.off])));
  }

  // ---- (d9f) A TIMER THAT FIRES A MILLISECOND EARLY STILL SWEEPS ITS MEMBER -
  // Node can fire a timer a millisecond before Date.now() says the delay has
  // passed, and a clock can be stepped backwards. The member the timer was
  // armed for must be swept anyway: there is no second timer for them.
  {
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    const { wl, wm } = await pair5(S);
    const t0 = CLOCK5;
    close5(S, wm);
    await flush5();
    CLOCK5 = t0 + 60000 - 1;                   // the wall clock says: not quite
    cw.force();                                // ...and the timer fires anyway
    await flush5();
    const b = last5(wl, 'state');
    if (b && same(ids5(b), [LEAD])) ok('(d9f) a timer firing a millisecond early by the wall clock still removes the member it was armed for');
    else fail('(d9f) early fire left them: ' + JSON.stringify(ids5(b)));
    CLOCK5 = t0 + 60000;
  }

  // ---- (d10) A THROW IN THE WINDOW MUST NOT REACH THE PROCESS ---------------
  // server.js answers uncaughtException by shutting down: one throw out of
  // an unattended callback kills every live match on the box. The engine's
  // timers get this from safeTimeout; nothing under server/ has one, so the
  // containment here is written by hand and has to be tested. now() is a
  // REAL injected dependency the sweep and the close both call — the clock
  // the factory takes as an argument, made to fail.
  {
    let boom = false, throws = 0;
    const clock = () => { if (boom) { throws += 1; throw new Error('drop-window probe'); } return CLOCK5; };
    const cw = mkClockwork();
    const S = social5(store5(), { clock, cw });
    const { wl, wm, code } = await pair5(S);
    close5(S, wm);                             // armed with a working clock
    await flush5();
    CLOCK5 += 60000;
    boom = true;
    let escaped = null;
    try { cw.fire(); } catch (e) { escaped = e; }
    if (!escaped && throws > 0) ok('(d10) a throw inside the sweep timer is contained — the callback returns');
    else fail('(d10) the sweep callback threw: ' + (escaped ? escaped.message : 'the clock was never called'));
    // THE CLOSE HOOK TOO. onClose runs in server.js's 'close' handler and
    // its sign-out branch; a throw there skips handleClose (the seat is never
    // released) or leaves the identity uncleared, and reaches the process.
    const wt = up5(S, mkws5(THIRD));
    boom = false;
    await S.handle(wt, { type: 'squad', op: 'join', code });
    boom = true; throws = 0;
    let fromClose = null;
    try { close5(S, wt); } catch (e) { fromClose = e; }
    if (!fromClose && throws > 0 && wt.socialUser === null && !S.online.has(THIRD))
      ok('(d10) a throw inside the close hook is contained, and the rest of onClose still ran');
    else fail('(d10) the close hook: ' + JSON.stringify({ threw: fromClose && fromClose.message, throws, socialUser: wt.socialUser, online: S.online.has(THIRD) }));
    // AND THE LAYER IS STILL ALIVE: one fault is one lost sweep, not a
    // wedged window. The next drop arms and fires normally, and its sweep
    // catches up with the member the faulted SWEEP missed (MEM).
    //
    // WHAT IT DOES NOT RECOVER, asserted rather than left out: the close hook
    // threw BEFORE markDropped, so THIRD's row holds a closed socket with no
    // dropAt, and no sweep will ever remove it — the window is keyed by
    // dropAt. It is a stranded row, not a live seat: it reads offline and not
    // dropped, Start refuses it member_offline by its socket's state, and the
    // leader can kick it.
    boom = false;
    const wf = up5(S, mkws5(FOURTH));
    await S.handle(wf, { type: 'squad', op: 'join', code });
    close5(S, wf);
    await flush5();
    wl.rx.length = 0;
    CLOCK5 += 60000;
    cw.fire();
    await flush5();
    const f = last5(wl, 'state');
    if (f && same(ids5(f), [LEAD, THIRD]))
      ok('(d10) and the next window still runs, catching up with the member the faulted sweep missed');
    else fail('(d10) the layer did not recover: ' + JSON.stringify(ids5(f)));
    const stranded = f && f.members[1];
    await S.handle(wl, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    const refused = wl.rx.find((x) => x.id === 's');
    await S.handle(wl, { type: 'squad', op: 'kick', id: THIRD });
    const cleared = last5(wl, 'state');
    if (stranded && stranded.online === false && stranded.dropped === false
      && same(refused, { type: 'squad', op: 'start', error: 'member_offline', at: 1, id: 's' }) && cleared && same(ids5(cleared), [LEAD]))
      ok('(d10) the row whose close hook threw is stranded, not swept — offline, refused member_offline at Start, and the leader can kick it');
    else fail('(d10) stranded row: ' + JSON.stringify({ stranded, refused, cleared: ids5(cleared) }));
  }

  // ---- (d10b) THE DEFAULT SCHEDULER: a real timer, and still contained -----
  // Everything above injects the clockwork. This is the one test of what
  // production runs when nothing is injected: a real setTimeout, the window
  // read from SQUAD_DROP_MS per instance. It waits on a CONDITION with a
  // generous ceiling, never on a fixed sleep, so a busy machine can make it
  // slow but not wrong.
  {
    const waitFor = async (cond, ms = 10000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5)); return cond(); };
    const prevEnv = process.env.SQUAD_DROP_MS;
    process.env.SQUAD_DROP_MS = '0';
    let boom = false, throws = 0;
    const clock = () => { if (boom) { throws += 1; throw new Error('default-timer probe'); } return CLOCK5; };
    const S = social5(store5(), { clock });
    if (prevEnv === undefined) delete process.env.SQUAD_DROP_MS; else process.env.SQUAD_DROP_MS = prevEnv;
    const { wl, wm } = await pair5(S);
    close5(S, wm);
    const gone = await waitFor(() => { const f = last5(wl, 'state'); return !!(f && same(ids5(f), [LEAD])); });
    if (gone) ok('(d10b) with nothing injected, a real timer runs the window and the squad is told');
    else fail('(d10b) the default timer never swept: ' + JSON.stringify(wl.rx));
    let escaped = null;
    const onEsc = (e) => { escaped = e; };
    process.on('uncaughtException', onEsc);
    try {
      const S2 = (() => { process.env.SQUAD_DROP_MS = '0'; const s = social5(store5(), { clock }); if (prevEnv === undefined) delete process.env.SQUAD_DROP_MS; else process.env.SQUAD_DROP_MS = prevEnv; return s; })();
      const p = await pair5(S2);
      close5(S2, p.wm);                        // arms a real timer with a working clock...
      boom = true;                             // ...that fires into a failing one
      const fired = await waitFor(() => throws > 0);
      await flush5(); await flush5();
      if (fired && !escaped) ok('(d10b) and a throw inside the real timer never reaches uncaughtException');
      else fail('(d10b) default timer: ' + (escaped ? 'ESCAPED to uncaughtException: ' + escaped.message : 'never fired'));
    } finally { boom = false; process.removeListener('uncaughtException', onEsc); }
  }

  // ---- (d10c) A PENDING WINDOW NEVER HOLDS THE PROCESS OPEN ----------------
  // The house rule for every timer this layer arms (presence's too): unref'd.
  // Asked of a child process left to exit NATURALLY with a full sixty-second
  // window pending — this suite ends in process.exit, so it cannot see it.
  // A ceiling of twenty seconds, far above the fraction of a second the child
  // needs and far below the sixty it would hang for.
  {
    const { spawnSync } = await import('node:child_process');
    // The child creates a squad, then its only member's socket closes: a
    // sixty-second window is pending when the script's last line has run.
    const src = `
      const { createSocial } = await import(${JSON.stringify(new URL('../server/social.js', import.meta.url).href)});
      const S = createSocial({ store: { async profilesByIds() { return new Map(); } }, terms: [], now: Date.now, send() {} });
      const a = { readyState: 1, userId: ${JSON.stringify(LEAD)}, isGuest: false };
      S.onAuth(a);
      await S.handle(a, { type: 'squad', op: 'create' });
      a.readyState = 3;
      S.onClose(a);
      console.log('armed');
    `;
    const env = { ...process.env };
    delete env.SQUAD_DROP_MS;
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 20000, env });
    const took = Date.now() - t0;
    // What matters is the EXIT: on its own, whole, promptly. Not a pristine
    // stderr — NODE_OPTIONS or a Node warning is the environment's to print,
    // and a check on it would fail the push gate for nothing this tests.
    const said = (r.stdout || '').trim().split('\n').pop();
    if (r.status === 0 && !r.signal && said === 'armed' && took < 20000)
      ok(`(d10c) with a sixty-second window pending, a process that is done exits on its own (${took < 5000 ? 'promptly' : took + ' ms'})`);
    else fail('(d10c) the window held the process open: ' + JSON.stringify({ status: r.status, signal: r.signal, took, out: r.stdout, err: (r.stderr || '').slice(0, 300) }));
  }

  // ---- (d11) A SIGN-OUT IS A LEAVE, NOT A DROP -----------------------------
  // server.js's sign-out branch calls onClose with the socket STILL OPEN, and
  // a hello for a different account does the same. That connection is nobody
  // now, or somebody else, and the account is not coming back on it: holding
  // the row for a window would go on pushing that account's squad — its
  // friends' callsigns — down a connection that no longer holds the account.
  {
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    const { wl, wm, code } = await pair5(S);
    signOut5(S, wm);
    await flush5();
    const f = last5(wl, 'state');
    if (f && same(ids5(f), [LEAD]) && sq5(wm).length === 0 && cw.all.length === 0)
      ok('(d11) a sign-out takes the member out at once: the squad is told, nothing is held and nothing is armed');
    else fail('(d11) sign-out: ' + JSON.stringify({ roster: ids5(f), toSignedOut: wm.rx, timers: cw.all.length }));
    // AND NOTHING MORE IS PUSHED DOWN THAT CONNECTION.
    const wt = up5(S, mkws5(THIRD));
    await S.handle(wt, { type: 'squad', op: 'join', code, id: 'j' });
    if (sq5(wt).some((x) => x.id === 'j' && x.op === 'state') && sq5(wm).length === 0)
      ok('(d11) and the signed-out connection is sent nothing when the squad changes after');
    else fail('(d11) the signed-out socket was still pushed: ' + JSON.stringify({ toSignedOut: wm.rx, joiner: wt.rx }));
  }
  {
    // THE LEADER SIGNS OUT: leadership passes on, and the socket that was the
    // leader's commands nothing.
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    const { wl, wm } = await pair5(S);
    signOut5(S, wl);
    await flush5();
    const f = last5(wm, 'state');
    wl.rx.length = 0;
    await S.handle(wl, { type: 'squad', op: 'mode', mode: 'boss', id: 'm' });
    if (f && f.leader === MEM && same(ids5(f), [MEM]) && same(wl.rx, [{ type: 'squad', op: 'mode', error: 'no_squad', id: 'm' }]))
      ok('(d11) the leader signing out hands the squad on, and their old socket is in no squad');
    else fail('(d11) leader sign-out: ' + JSON.stringify({ heir: f, wl: wl.rx }));
  }
  {
    // A HELLO FOR ANOTHER ACCOUNT on the member's socket: the same leave.
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, wm } = await pair5(S);
    switch5(S, wm, FOURTH);
    await flush5();
    const f = last5(wl, 'state');
    if (f && same(ids5(f), [LEAD])) ok('(d11) a hello for a different account on a member\'s socket is a leave too');
    else fail('(d11) account switch: ' + JSON.stringify(ids5(f)));
  }
  {
    // A GUEST ROW STAYS through its own socket's hook. A guest's squad
    // identity IS the socket, and it is not the socket that is leaving.
    //   * An ANONYMOUS guest who signs OUT is still that socket: the row stays.
    //   * An anonymous guest who signs IN is a hello for a different account,
    //     so server.js runs the hook (open socket) BEFORE onAuth — and onAuth
    //     then makes the row the account's (claimOnSignIn). Taken away at the
    //     hook, the player would lose their place a moment before it was
    //     theirs by name.
    //   * Once it IS the account's row, signing out is an account's sign-out:
    //     a leave, like anyone's.
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, code } = await pair5(S);
    const g = mkws5(ANON, true);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    wl.rx.length = 0;
    signOut5(S, g);                            // an anonymous guest signs out
    g.userId = ANON; g.isGuest = true;         // ...and hellos as a guest again
    await flush5();
    const quiet = sq5(wl).length === 0;
    switch5(S, g, THIRD);                      // signs in to a real account
    await flush5();
    const mine = last5(g, 'state');
    signOut5(S, g);                            // and out of it
    await flush5();
    const after = last5(wl, 'state');
    if (quiet && mine && same(ids5(mine), [LEAD, MEM, THIRD]) && mine.you === 2 && after && same(ids5(after), [LEAD, MEM]))
      ok('(d11) a guest keeps its row through its own sign-out and its sign-in — where the row becomes the account\'s — and that account\'s sign-out then leaves');
    else fail('(d11) guest row on sign-in/out: ' + JSON.stringify({ quiet, mine: ids5(mine), you: mine && mine.you, after: ids5(after) }));
  }
  {
    // A SECOND DEVICE SIGNING OUT is not the account leaving: the row is on
    // the first device, which is still signed in.
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, wm } = await pair5(S);
    const wm2 = up5(S, mkws5(MEM));
    signOut5(S, wm2);
    await flush5();
    wl.rx.length = 0;
    await S.handle(wm, { type: 'squad', op: 'ready', ready: true, loadout: RACK5, id: 'r' });
    const f = last5(wl, 'state');
    if (f && same(ids5(f), [LEAD, MEM]) && f.members[1].ready === true)
      ok('(d11) a second device signing out leaves the account\'s row, on the first device, exactly where it was');
    else fail('(d11) second-device sign-out: ' + JSON.stringify(f));
  }

  // ---- (d11b) deferred item 3: SIGN-OUT, THEN RE-JOIN AS A GUEST ON THE SAME
  // SOCKET — one row, and it is a guest's ----------------------------------
  // Before this, the signed-out socket still held the ACCOUNT's row, so its
  // guest join matched that row as "already here": a connection that was
  // nobody was answered as the account, shown the account's name as its own
  // row, and could ready or leave for it.
  for (const where of ['the same squad', 'another squad']) {
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, wm, code } = await pair5(S);
    const wt = up5(S, mkws5(THIRD));
    await S.handle(wt, { type: 'squad', op: 'create' });
    const other = last5(wt, 'state').code;
    signOut5(S, wm);
    await flush5();
    await S.handle(wm, { type: 'squad', op: 'join', code: where === 'the same squad' ? code : other, name: 'G', skin: 'gold', id: 'j' });
    const got = wm.rx.find((f) => f.id === 'j') || {};
    // Both squads' rosters as they stand: every change to either was pushed
    // to its leader, so the last one each leader holds is the truth.
    const x = last5(wl, 'state') || {}, y = last5(wt, 'state') || {};
    const all = [...(x.members || []), ...(y.members || [])];
    const mine = got.members && got.members[got.you];
    if (got.op === 'state' && mine && mine.guest === true && mine.id === null && !all.some((r) => r.id === MEM)
      && all.filter((r) => r.guest).length === 1)
      ok(`(d11b) signed out, then joined ${where} as a guest: exactly one row for that socket, a guest row, and the account is in no squad`);
    else fail(`(d11b) ${where}: answered ${JSON.stringify(got)}; rosters ${JSON.stringify([ids5(x), ids5(y)])}`);
  }

  // ---- (d11c) deferred item 6a: A GUEST WHO SIGNS IN AND RE-JOINS THEIR OWN
  // SQUAD ENDS WITH EXACTLY ONE ROW ------------------------------------------
  // Both ways a guest signs in: a socket that never said hello (server.js
  // runs no hook — it had no id), and an ANONYMOUS guest (server.js runs the
  // hook with the socket open, because the anonymous id differs — the sign-
  // out branch above must keep the guest row, not take it). Either way the
  // row the socket holds becomes the account's at the sign-in, and the
  // re-join is task 2's already-here: still exactly one row.
  for (const [label, before] of [['a socket that never said hello', [null, false]], ['an anonymous guest', [ANON, true]]]) {
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, code } = await pair5(S);
    const g = mkws5(before[0], before[1]);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    switch5(S, g, THIRD);
    await flush5();
    await S.handle(g, { type: 'squad', op: 'join', code, id: 'j' });
    const got = g.rx.find((f) => f.id === 'j') || {};
    const roster = last5(wl, 'state') || {};
    if (got.op === 'state' && same(ids5(got), [LEAD, MEM, THIRD]) && got.you === 2 && same(ids5(roster), [LEAD, MEM, THIRD]))
      ok(`(d11c) ${label} who signs in and re-joins their own squad ends with exactly one row — the one their socket held, now the account's`);
    else fail(`(d11c) ${label}: answered ${JSON.stringify(ids5(got))} you ${got.you}; squad ${JSON.stringify(ids5(roster))}`);
  }

  // ---- (d12) resume ---------------------------------------------------------
  // THE WIRE CONTRACT: a live squad answers the `state` snapshot as this
  // socket must see it (squadFrame: `you` is its row), with the request's id;
  // anything else answers exactly { type:'squad', op:'gone', id } and carries
  // nothing. Not in SQUAD_LINKED: a guest is answered, never told to sign in.
  const GONE = (id) => ({ type: 'squad', op: 'gone', id });
  {
    // THE ORDINARY POST-MATCH PATH (design 5.4): nobody dropped, the bay
    // renders home and asks. Exactly one frame back, and nobody else is sent
    // anything, because nothing changed.
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, wm, code } = await pair5(S);
    await S.handle(wm, { type: 'squad', op: 'resume', code, id: 'r1' });
    const r = wm.rx[0] || {};
    if (wm.rx.length === 1 && r.op === 'state' && r.code === code && r.id === 'r1' && r.you === 1 && same(ids5(r), [LEAD, MEM]) && wl.rx.length === 0)
      ok('(d12) resume on the socket holding the row answers its snapshot once, id echoed, `you` its row, and tells nobody else');
    else fail('(d12) ordinary resume: ' + JSON.stringify({ wm: wm.rx, wl: wl.rx }));
    // THE BARE FRAME — the Squad box sends it when it remembers no code.
    wm.rx.length = 0;
    await S.handle(wm, { type: 'squad', op: 'resume', id: 'r0' });
    if (wm.rx.length === 1 && wm.rx[0].op === 'state' && wm.rx[0].code === code && wm.rx[0].id === 'r0')
      ok('(d12) a bare resume, with no code, is answered with the squad the socket is in');
    else fail('(d12) bare resume: ' + JSON.stringify(wm.rx));
  }
  {
    // A GUEST'S POST-MATCH RESUME, ON THE SAME SOCKET: still a member, so the
    // snapshot. Their key is the socket they are asking on.
    const S = social5(store5(), { cw: mkClockwork() });
    const { code } = await pair5(S);
    const g = mkws5(null);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    g.rx.length = 0;
    await S.handle(g, { type: 'squad', op: 'resume', code, id: 'rg' });
    const r = g.rx[0] || {};
    if (g.rx.length === 1 && r.op === 'state' && r.you === 2 && r.id === 'rg' && r.members[2].guest === true)
      ok('(d12) a guest resuming on the socket they joined on is answered their squad — no sign-in, no `gone`');
    else fail('(d12) guest resume: ' + JSON.stringify(g.rx));
    // deferred item 5: THE SOCKET'S OWN ROW FIRST. That guest signs in on the
    // same socket as THIRD, who is already in ANOTHER squad on another device
    // — the one case where the guest row stays a guest row (claimOnSignIn),
    // so the row this socket holds and the account signed in on it disagree.
    // A resume built on identity would answer THIRD's other squad to a
    // socket standing in this one.
    const wt = up5(S, mkws5(THIRD));
    await S.handle(wt, { type: 'squad', op: 'create' });
    const other = last5(wt, 'state').code;
    switch5(S, g, THIRD);
    await flush5();
    g.rx.length = 0;
    await S.handle(g, { type: 'squad', op: 'resume', code, id: 'rh' });
    const r2 = g.rx[0] || {};
    if (g.rx.length === 1 && r2.op === 'state' && r2.code === code && r2.code !== other && r2.you === 2 && r2.members[2].guest === true)
      ok('(d12) a signed-in socket still holding a guest row resumes the squad that row is in, not its account\'s other squad');
    else fail('(d12) signed-in guest resume: ' + JSON.stringify(g.rx));
  }
  {
    // A DROPPED MEMBER COMES BACK: re-attached, the dot back for everyone,
    // and the window that was armed for them stands down.
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    const { wl, wm, code } = await pair5(S);
    close5(S, wm);
    await flush5();
    wl.rx.length = 0;
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'resume', code, id: 'r2' });
    const mine = wm2.rx.filter((f) => f.type === 'squad'), theirs = last5(wl, 'state');
    const row = theirs && theirs.members.find((x) => x.id === MEM);
    if (mine.length === 1 && mine[0].op === 'state' && mine[0].id === 'r2' && mine[0].you === 1 && mine[0].members[1].dropped === false
      && sq5(wl).length === 1 && theirs.id === undefined && row && row.dropped === false && row.online === true)
      ok('(d12) a dropped member resuming is re-attached: ONE answer to them, id echoed, and one push to the rest with the dot back');
    else fail('(d12) resume after a drop: ' + JSON.stringify({ mine, theirs }));
    if (cw.pending().length === 0) ok('(d12) and the window armed for them is cancelled');
    else fail('(d12) the window is still armed: ' + cw.pending().length);
    CLOCK5 += 60000;
    cw.fire();
    await flush5();
    wl.rx.length = 0;
    await S.handle(wl, { type: 'squad', op: 'resume', id: 'q' });
    if (same(ids5(wl.rx[0]), [LEAD, MEM])) ok('(d12) and the window passing does not remove them');
    else fail('(d12) a resumed member was swept: ' + JSON.stringify(wl.rx));
    // THEY ARE THE ROW NOW: the squad reaches them, and their new socket
    // closing drops them again.
    close5(S, wm2);
    await flush5();
    const again = last5(wl, 'state');
    if (again && again.members[1].dropped === true) ok('(d12) the new socket holds the row: its close drops them again');
    else fail('(d12) re-attached row: ' + JSON.stringify(again));
  }
  {
    // A BARE RESUME PICKS UP A DROPPED ROW TOO — the reconnect of a device
    // that never stored a code. Nobody else holds the row.
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, wm } = await pair5(S);
    close5(S, wm);
    await flush5();
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'resume', id: 'rb' });
    const r = wm2.rx.find((f) => f.id === 'rb') || {};
    if (r.op === 'state' && r.you === 1 && r.members[1].dropped === false && last5(wl, 'state').members[1].dropped === false)
      ok('(d12) a bare resume from the account re-attaches a row nobody is holding');
    else fail('(d12) bare resume after a drop: ' + JSON.stringify(r));
  }
  {
    // 'gone': a real code this account is not a member of, in no squad at
    // all. Answering that squad's roster would hand strangers' callsigns to
    // anyone who can guess four characters.
    const S = social5(store5(), { cw: mkClockwork() });
    const { code } = await pair5(S);
    const wt = up5(S, mkws5(THIRD));
    await S.handle(wt, { type: 'squad', op: 'resume', code, id: 'r3' });
    await S.handle(wt, { type: 'squad', op: 'resume', id: 'r4' });
    if (same(wt.rx, [GONE('r3'), GONE('r4')]))
      ok('(d12) a real code this account is not in answers exactly gone, and so does a bare resume from nobody\'s member');
    else fail('(d12) a non-member was answered: ' + JSON.stringify(wt.rx));
    // A GUEST ON A NEW SOCKET: a guest's key was the socket that went.
    const g = mkws5(null);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    close5(S, g);
    const g2 = mkws5(null);
    await S.handle(g2, { type: 'squad', op: 'resume', code, id: 'r5' });
    if (same(g2.rx, [GONE('r5')])) ok('(d12) a guest reconnecting on a new socket is answered gone — a guest can never resume');
    else fail('(d12) a guest resumed: ' + JSON.stringify(g2.rx));
  }
  {
    // A STALE CODE (task 8's C1): the device remembers X, the account has
    // since moved to Y on another device. The answer is Y — the squad the
    // player is really in — never X's roster, and never a false `gone`.
    const S = social5(store5(), { cw: mkClockwork() });
    const { code: X, wm } = await pair5(S);
    const wt = up5(S, mkws5(THIRD));
    await S.handle(wt, { type: 'squad', op: 'create' });
    const Y = last5(wt, 'state').code;
    await S.handle(wm, { type: 'squad', op: 'join', code: Y });
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'resume', code: X, id: 'r6' });
    const r = wm2.rx.find((f) => f.id === 'r6') || {};
    if (r.op === 'state' && r.code === Y && same(ids5(r), [THIRD, MEM]) && !JSON.stringify(r).includes(LEAD))
      ok('(d12) a stale code is answered with the squad the account is really in — never the named squad\'s roster');
    else fail('(d12) stale code: ' + JSON.stringify(r));
  }

  // ---- (d12b) A SECOND DEVICE: a bare resume looks, a named one takes over -
  // Resume is how a device takes the account's row (task 4's wrong_device
  // waits on it). A resume that NAMES the squad takes the row even from a
  // socket that still looks live — the engine's own rule for a seat, because
  // a proxy can hold a dead socket open for twenty seconds. A bare resume
  // names nothing: it is answered as a second device and moves nothing, so a
  // device merely opening does not pull the squad off the one in use.
  {
    const S = social5(store5(), { cw: mkClockwork(), seatSquad: () => ({ ok: false, error: 'refused' }) });
    const { wl, wm, code } = await pair5(S);
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'resume', id: 'b1' });
    const look = wm2.rx.find((f) => f.id === 'b1') || {};
    wl.rx.length = 0; wm.rx.length = 0; wm2.rx.length = 0;
    await S.handle(up5(S, mkws5(THIRD)), { type: 'squad', op: 'join', code: 'ZZZZ' });  // nothing
    await S.handle(wl, { type: 'squad', op: 'mode', mode: 'duel' });                      // a change
    if (look.op === 'state' && look.you === 1 && sq5(wm).length === 1 && sq5(wm2).length === 0)
      ok('(d12b) a bare resume from a second device is shown the squad, and the row stays on the first device');
    else fail('(d12b) bare second-device resume: ' + JSON.stringify({ look, first: wm.rx, second: wm2.rx }));
    wm.rx.length = 0;
    await S.handle(wm2, { type: 'squad', op: 'resume', code, id: 'b2' });
    const took = wm2.rx.find((f) => f.id === 'b2') || {};
    const told = sq5(wm);
    await S.handle(wl, { type: 'squad', op: 'mode', mode: 'duel' });
    if (took.op === 'state' && took.you === 1 && same(told, [{ type: 'squad', op: 'ended', reason: 'elsewhere' }])
      && sq5(wm2).filter((f) => f.id === undefined).length === 1)
      ok('(d12b) a resume naming the squad takes the row: the old device is told `ended: elsewhere` and nothing more, the new one is pushed from now on');
    else fail('(d12b) take-over: ' + JSON.stringify({ took, old: sq5(wm), fresh: sq5(wm2) }));
    // AND THE OLD DEVICE CLOSING NOW DROPS NOBODY: it holds no row.
    wl.rx.length = 0;
    close5(S, wm);
    await flush5();
    if (sq5(wl).length === 0) ok('(d12b) the old device closing afterwards drops nobody');
    else fail('(d12b) the old device dropped the member: ' + JSON.stringify(wl.rx));
  }
  {
    // A LEADER WHO RELOADED, with the old socket still looking open: task 4
    // answers wrong_device until the new socket holds the leader's row.
    // After a resume naming the squad it does, and Start reaches its gates.
    const seated = [];
    const S = social5(store5(), { cw: mkClockwork(), seatSquad: (seats) => { seated.push(seats.length); return { ok: false, error: 'refused' }; } });
    const { wl, wm, code } = await pair5(S);
    const wl2 = up5(S, mkws5(LEAD));
    await S.handle(wl2, { type: 'squad', op: 'start', id: 's1' });
    const before = (wl2.rx.find((f) => f.id === 's1') || {}).error;
    await S.handle(wl2, { type: 'squad', op: 'resume', code, id: 'rl' });
    await S.handle(wm, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    await S.handle(wl2, { type: 'squad', op: 'start', loadout: RACK5, id: 's2' });
    const after = wl2.rx.find((f) => f.id === 's2') || {};
    if (before === 'wrong_device' && after.error === 'refused' && seated.length === 1 && same(sq5(wl), [{ type: 'squad', op: 'ended', reason: 'elsewhere' }]))
      ok('(d12b) a reloaded leader is wrong_device until their resume takes the row, and then Start from the new socket goes through to the seating');
    else fail('(d12b) reloaded leader: ' + JSON.stringify({ before, after, seated, oldDevice: sq5(wl) }));
  }

  // ---- (d13) A SIGN-OUT INSIDE THE NAME READ CANCELS THE ANSWER ------------
  // ws.authGen is the cancel token for anything async hung on a socket
  // (server.js's auth sink). The snapshot waits on a profile read; a sign-out
  // landing inside it means the socket is no longer the account whose squad
  // this is, and its client has already reset. The store is GATED so the
  // sign-out lands inside the read, not before the resume has started: the
  // per-socket queue would otherwise run the resume after it.
  {
    const st = store5();
    const S = social5(st, { cw: mkClockwork() });
    const { wm, code } = await pair5(S);
    const release = st.hold();
    const p = S.handle(wm, { type: 'squad', op: 'resume', code, id: 'r7' });
    const inside = await within5(st.entered);  // the resume is inside its name read
    signOut5(S, wm);                           // server.js's order: hook, generation, id
    const before = wm.rx.length;
    release();
    await p;
    await flush5();
    if (inside && wm.rx.length === before && !wm.rx.some((f) => f.id === 'r7'))
      ok('(d13) a sign-out inside the snapshot read cancels the answer — nothing at all reaches a socket that has left the account');
    else fail('(d13) the answer was sent anyway: ' + JSON.stringify({ inside, sent: wm.rx.slice(before) }));
  }
  {
    // A KICK INSIDE THE READ (no sign-out): the socket is in no row of this
    // squad by the time the frame is built — squadFrame's `you` of -1 — and
    // is answered gone rather than handed the roster it was just removed from.
    const st = store5();
    const S = social5(st, { cw: mkClockwork() });
    const { wl, wm, code } = await pair5(S);
    const release = st.hold();
    const p = S.handle(wm, { type: 'squad', op: 'resume', code, id: 'r8' });
    const inside = await within5(st.entered);
    const k = S.handle(wl, { type: 'squad', op: 'kick', id: MEM });
    release();
    await p; await k;
    await flush5();
    const answer = wm.rx.find((f) => f.id === 'r8');
    if (inside && same(answer, GONE('r8')) && !wm.rx.some((f) => f.op === 'state'))
      ok('(d13) a member kicked while their resume was reading names is answered gone, never the roster with you: -1');
    else fail('(d13) kicked mid-resume: ' + JSON.stringify({ inside, rx: wm.rx }));
  }
  {
    // THE SQUAD ENDS INSIDE THE READ: a guest asks, and the only account
    // leaves. The ended squad still carries the guest on its list (task 2
    // keeps it so they can be told), so `you` is still a real index — only
    // the squad being gone stops a dead roster going out as the answer.
    const st = store5();
    const S = social5(st, { cw: mkClockwork() });
    const wl = up5(S, mkws5(LEAD));
    await S.handle(wl, { type: 'squad', op: 'create' });
    const code = last5(wl, 'state').code;
    const g = mkws5(null);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    g.rx.length = 0;
    const release = st.hold();
    const p = S.handle(g, { type: 'squad', op: 'resume', code, id: 'r11' });
    const inside = await within5(st.entered);
    await S.handle(wl, { type: 'squad', op: 'leave' });
    release();
    await p;
    await flush5();
    const answer = g.rx.find((f) => f.id === 'r11');
    if (inside && same(answer, GONE('r11')) && same(sq5(g, 'ended'), [{ type: 'squad', op: 'ended', reason: 'no_leader' }]) && sq5(g, 'state').length === 0)
      ok('(d13) a squad that ends while a guest\'s resume reads names answers gone — the guest is told it ended, never shown it alive');
    else fail('(d13) ended mid-resume: ' + JSON.stringify({ inside, rx: g.rx }));
  }

  // ---- (d14) AFTER A RESTART EVERY RESUME ANSWERS GONE ---------------------
  // A restart is a new process with new memory; in process, a SECOND layer:
  // the same store, the same frame, nothing shared. Both arms are asserted —
  // a resume hard-wired to 'gone' fails the first, and squad state leaking
  // between instances (a Map hoisted to module scope) fails the second.
  {
    const S1 = social5(store5(), { cw: mkClockwork() });
    const { wl, code } = await pair5(S1);
    await S1.handle(wl, { type: 'squad', op: 'resume', code, id: 'r9' });
    const live = wl.rx.find((f) => f.id === 'r9') || {};
    if (live.op === 'state' && live.code === code) ok('(d14) the frame against the live layer answers the snapshot');
    else fail('(d14) the live arm: ' + JSON.stringify(live));
    const S2 = social5(store5(), { cw: mkClockwork() });   // the deploy
    const w = up5(S2, mkws5(LEAD));
    await S2.handle(w, { type: 'squad', op: 'resume', code, id: 'r9' });
    await S2.handle(w, { type: 'squad', op: 'resume', id: 'r10' });
    if (same(w.rx, [GONE('r9'), GONE('r10')]))
      ok('(d14) the identical frame against a restarted layer answers gone, with no code and no roster, and so does a bare one');
    else fail('(d14) a squad outlived the process: ' + JSON.stringify(w.rx));
  }

  // ---- (d15) deferred items 2 and 6b: DEVICE A IS TOLD WHEN DEVICE B TAKES
  // ITS ROW AWAY ------------------------------------------------------------
  // The account's row is on device A (wm). Device B (wm2) holds no row, so
  // its leave, create or join acts on the account's row — task 2's rule —
  // and A's box went on showing a squad it would never be pushed again.
  const ELSEWHERE = { type: 'squad', op: 'ended', reason: 'elsewhere' };
  for (const [what, act] of [
    ['a leave', async (S, w2) => { await S.handle(w2, { type: 'squad', op: 'leave', id: 'x' }); }],
    ['a create', async (S, w2) => { await S.handle(w2, { type: 'squad', op: 'create', id: 'x' }); }],
    ['a join to another squad', async (S, w2) => {
      const wt = up5(S, mkws5(THIRD));
      await S.handle(wt, { type: 'squad', op: 'create' });
      await S.handle(w2, { type: 'squad', op: 'join', code: last5(wt, 'state').code, id: 'x' });
    }],
  ]) {
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, wm } = await pair5(S);
    const wm2 = up5(S, mkws5(MEM));
    await act(S, wm2);
    await S.handle(wl, { type: 'squad', op: 'mode', mode: 'duel' });  // a later change in the old squad
    const answered = wm2.rx.some((f) => f.id === 'x');
    if (answered && same(wm.rx, [ELSEWHERE]) && same(ids5(last5(wl, 'state')), [LEAD]))
      ok(`(d15) ${what} from device B tells device A, whose row it took, ended: elsewhere — and nothing after`);
    else fail(`(d15) ${what} from device B: device A got ${JSON.stringify(wm.rx)}, B answered ${answered}`);
  }
  {
    // NOBODY IS TOLD WHAT DID NOT HAPPEN: device B joining the squad the
    // account is already in moves nothing, and a device leaving its OWN row
    // is the actor, answered `left`, not told it was left elsewhere.
    const S = social5(store5(), { cw: mkClockwork() });
    const { wm, code } = await pair5(S);
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'join', code, id: 'j' });
    // (A join re-pushes the roster to the squad — task 2's rule — so the row's
    // socket does get a `state`; what it must not get is an `ended`.)
    const quiet = sq5(wm, 'ended').length === 0 && sq5(wm, 'state').length === 1;
    wm.rx.length = 0;
    await S.handle(wm, { type: 'squad', op: 'leave', id: 'l' });
    if (quiet && same(wm.rx, [{ type: 'squad', op: 'left', ok: true, id: 'l' }]))
      ok('(d15) a join that is already-here tells the other device nothing, and a device leaving its own row is only answered');
    else fail('(d15) over-told: ' + JSON.stringify(wm.rx));
  }
  {
    // A KICK ALREADY TELLS THE ROW'S SOCKET, from whichever device of the
    // leader sends it (task 2 holds the victim's socket before the removal).
    const S = social5(store5(), { cw: mkClockwork() });
    const { wm } = await pair5(S);
    const wl2 = up5(S, mkws5(LEAD));
    await S.handle(wl2, { type: 'squad', op: 'kick', id: MEM });
    if (same(wm.rx, [{ type: 'squad', op: 'ended', reason: 'kicked' }]))
      ok('(d15) a kick sent from the leader\'s second device tells the member on the row: ended, kicked');
    else fail('(d15) kick from a second device: ' + JSON.stringify(wm.rx));
  }

  // ---- (d16) A SQUAD OP THAT OUTLIVES ITS SOCKET ATTACHES NOTHING -----------
  // A frame can wait on the per-socket queue (behind a slow name read) or on
  // the hello, and the socket can close while it waits. The close has already
  // dropped the row it held; a join that ran afterwards would put the DEAD
  // socket on a row with no drop stamped — a member no window would ever
  // sweep, and a socket nothing can answer.
  {
    const st = store5();
    const S = social5(st, { cw: mkClockwork() });
    const { wl, code } = await pair5(S);
    const w = up5(S, mkws5(THIRD));
    await S.handle(w, { type: 'squad', op: 'create' });              // THIRD's own squad
    const release = st.hold();
    const p1 = S.handle(w, { type: 'squad', op: 'resume', id: 'q1' }); // waits in its name read
    const inside = await within5(st.entered);
    const p2 = S.handle(w, { type: 'squad', op: 'join', code, id: 'q2' }); // queued behind it
    close5(S, w);
    release();
    await p1; await p2;
    await flush5();
    const x = last5(wl, 'state');
    if (inside && !(x && x.members.some((r) => r.id === THIRD)))
      ok('(d16) a join queued before its socket closed does not run after: the squad gains no dead member');
    else fail('(d16) a closed socket joined: ' + JSON.stringify({ inside, roster: ids5(x) }));
  }

  // ---- (d17) deferred item 9: START AND A MEMBER WHOSE SOCKET JUST CLOSED ---
  // task 4's member_offline gate is the only thing between a closed socket
  // and a seat — the engine's join never looks. The drop clears the member's
  // Ready (design 4.3), so the start must ask who is MISSING before it asks
  // who is not ready: the answer names the member who is gone (`at`), which
  // is the reason the leader can act on, and nobody is seated.
  {
    const seated = [];
    const S = social5(store5(), { cw: mkClockwork(), seatSquad: (seats) => { seated.push(seats.length); return { ok: true, code: 'RM05' }; } });
    const { wl, wm } = await pair5(S);
    await S.handle(wm, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    close5(S, wm);
    await flush5();
    wl.rx.length = 0;
    await S.handle(wl, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    const a = wl.rx.find((f) => f.id === 's');
    if (same(a, { type: 'squad', op: 'start', error: 'member_offline', at: 1, id: 's' }) && seated.length === 0)
      ok('(d17) a member whose socket just closed stops the start with member_offline, naming their row, and nobody is seated');
    else fail('(d17) start after a close: ' + JSON.stringify({ a, seated }));
    // THEY COME BACK: the resume re-attaches them and does NOT hand their
    // Ready back (markResumed), so the same start is not_ready — and once
    // they ready AGAIN, on the socket now on the row, it seats the squad.
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'resume', id: 'r' });
    const back = (wm2.rx.find((f) => f.id === 'r') || {}).members || [];
    await S.handle(wl, { type: 'squad', op: 'start', loadout: RACK5, id: 't' });
    const b = wl.rx.find((f) => f.id === 't');
    await S.handle(wm2, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    await S.handle(wl, { type: 'squad', op: 'start', loadout: RACK5, id: 'u' });
    const c = wl.rx.find((f) => f.id === 'u');
    if (back[1] && back[1].ready === false && back[1].dropped === false && same(b, { type: 'squad', op: 'start', error: 'not_ready', id: 't' })
      && c && c.ok === true && same(seated, [2]))
      ok('(d17) the member resumes without their Ready, the start is not_ready until they ready again, and then it seats the whole squad');
    else fail('(d17) resume then ready again: ' + JSON.stringify({ back: back[1], b, c, seated }));
  }

  // ---- (d17b) A DROPPED ROW IS NEVER READY (review, Important 3) -----------
  // "Kept 60 s as dropped and not ready." Task 3 lets an account's second
  // device act on the account's row — including a DROPPED one, whose Ready
  // then showed beside `dropped` and survived the resume. The machine now
  // refuses a Ready on a dropped row outright; and a second device pressing
  // Ready on it first PICKS THE ROW UP (resume's own rule: nobody live holds
  // it, and this device is in the player's hand), so the Ready is true of a
  // live socket and the seat goes to that device.
  {
    const S0 = createSquads({ now: now5 });
    const sq = S0.create(mem5(LEAD, mkws5(LEAD)));
    const wm = mkws5(MEM);
    S0.join(sq.code, mem5(MEM, wm));
    wm.readyState = 3;
    S0.markDropped(MEM, CLOCK5);
    const r = S0.setReady(MEM, true, RACK5);
    const down = S0.setReady(MEM, false, null);
    if (r.ok === false && r.error === 'dropped' && sq.members[1].ready === false && sq.members[1].loadout === null && down.ok === true)
      ok('(d17b) the machine refuses a Ready on a dropped row (dropped), and a stand-down is still fine');
    else fail('(d17b) machine: ' + JSON.stringify({ r: { ok: r.ok, error: r.error }, row: sq.members[1] }, noWs));
  }
  {
    const seated = [];
    const S = social5(store5(), { cw: mkClockwork(), seatSquad: (seats) => { seated.push(seats.map((x) => x.ws)); return { ok: true, code: 'RM17' }; } });
    const { wl, wm } = await pair5(S);
    close5(S, wm);
    await flush5();
    wl.rx.length = 0;
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'ready', ready: true, loadout: RACK5, id: 'y' });
    const answer = wm2.rx.find((f) => f.id === 'y');
    const rows = sq5(wl, 'state').map((f) => f.members[1]);
    await S.handle(wl, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    const started = wl.rx.find((f) => f.id === 's') || {};
    if (answer && answer.ok === true && rows.length && rows.every((m) => !(m.dropped && m.ready)) && rows[rows.length - 1].ready === true
      && rows[rows.length - 1].dropped === false && started.ok === true && seated.length === 1 && seated[0][1] === wm2)
      ok('(d17b) a second device readying a dropped row picks it up first: never shown dropped and ready, and the seat goes to that device');
    else fail('(d17b) second-device ready: ' + JSON.stringify({ answer, rows, started, seated: seated.length }));
  }

  // ---- (d8s) C4 AT THE SOCKET: THE LAST ACCOUNT GOES, THE GUESTS ARE TOLD ---
  // task 2: a squad nobody signed in is left to lead ENDS, and the guests
  // standing in it are told { op:'ended', reason:'no_leader' } — never pushed
  // a roster of a squad that no longer exists, and never left with none. Both
  // of this task's removals reach that end: the drop window sweeping the
  // leader, and the leader signing out.
  for (const how of ['swept by the drop window', 'signing out']) {
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    const wl = up5(S, mkws5(LEAD));
    await S.handle(wl, { type: 'squad', op: 'create' });
    const code = last5(wl, 'state').code;
    const g1 = mkws5(null), g2 = mkws5(ANON, true);
    await S.handle(g1, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    await S.handle(g2, { type: 'squad', op: 'join', code, name: 'H', skin: 'gold' });
    if (how === 'swept by the drop window') { close5(S, wl); await flush5(); }
    g1.rx.length = 0; g2.rx.length = 0;
    if (how === 'signing out') signOut5(S, wl);
    else { CLOCK5 += 60000; cw.fire(); }
    await flush5();
    const told = (w) => same(w.rx, [{ type: 'squad', op: 'ended', reason: 'no_leader' }]);
    const both = told(g1) && told(g2);
    await S.handle(g1, { type: 'squad', op: 'resume', code, id: 'r' });
    const after = g1.rx.find((f) => f.id === 'r');
    if (both && same(after, GONE('r')))
      ok(`(d8s) the leader ${how} with only guests left: every guest is told ended: no_leader, and the squad is gone`);
    else fail(`(d8s) leader ${how}: ` + JSON.stringify({ g1: g1.rx, g2: g2.rx }));
  }

  // ---- (d18) ONE ACCOUNT, ONE ROW, ONE SEAT (review, Important 4) ----------
  // "Each member is seated exactly once when the squad starts." A GUEST row
  // is keyed by its socket, and that socket can sign in afterwards, so the
  // same account could stand in one squad twice: once as the guest row its
  // signed-in socket holds, once as an account row on another device. The
  // engine's join checks the socket, never the account, so Start seated it
  // twice — and a duel led by that account would be the account against
  // itself. Two ways in, both closed at the sign-in; one guard on the harm.
  const seatRec5 = () => { const r = { calls: [] }; r.fn = (seats) => { r.calls.push(seats.map((s) => s.ws.userId || 'guest')); return { ok: true, code: 'RM18' }; }; return r; };
  const readyAll5 = async (S, socks) => { for (const w of socks) await S.handle(w, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 }); };
  {
    // THE REVIEWER'S EXACT SEQUENCE: g joins as a guest and then signs in as
    // MEM; MEM's other device joins the same squad by code. On a free-for-all,
    // so a squad of three would FIT and only the rule can stop a double seat.
    const seat = seatRec5();
    const S = social5(store5(), { cw: mkClockwork(), seatSquad: seat.fn });
    const wl = up5(S, mkws5(LEAD));
    await S.handle(wl, { type: 'squad', op: 'create' });
    const code = last5(wl, 'state').code;
    await S.handle(wl, { type: 'squad', op: 'mode', mode: 'ffa' });
    const g = mkws5(null);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    switch5(S, g, MEM);                        // signs in (it had no id: no hook, then onAuth)
    await flush5();                            // the sign-in door's read lands (D-BLOCK-3 F)
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'join', code, id: 'j' });
    const seen = wm2.rx.find((f) => f.id === 'j') || {};
    await readyAll5(S, [wl, g, wm2]);
    await S.handle(wl, { type: 'squad', op: 'start', id: 's' });
    if (same(ids5(seen), [LEAD, MEM]) && seen.you === 1 && same(seat.calls, [[LEAD, MEM]]))
      ok('(d18) signed in on the guest\'s socket, then joining from another device: one row for the account, and Start seats it once');
    else fail('(d18) reviewer sequence: ' + JSON.stringify({ roster: ids5(seen), you: seen.you, seated: seat.calls, start: wl.rx.find((f) => f.id === 's') }));
  }
  {
    // THE MIRROR, which no join-time check can see: the account's row comes
    // FIRST (live, on another device), then a guest socket joins and signs in
    // as it. The account is already here; the guest row goes, and the socket
    // that signed in is told its squad is on the other device.
    const seat = seatRec5();
    const S = social5(store5(), { cw: mkClockwork(), seatSquad: seat.fn });
    const { wl, wm, code } = await pair5(S);
    await S.handle(wl, { type: 'squad', op: 'mode', mode: 'ffa' });
    const g = mkws5(ANON, true);               // an ANONYMOUS guest: the hook runs, then onAuth
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    g.rx.length = 0;
    switch5(S, g, MEM);
    await flush5();
    await readyAll5(S, [wl, wm]);
    await S.handle(wl, { type: 'squad', op: 'start', id: 's' });
    if (same(sq5(g, 'ended'), [ELSEWHERE]) && same(seat.calls, [[LEAD, MEM]]) && same(ids5(last5(wl, 'state')), [LEAD, MEM]))
      ok('(d18) a guest socket signing in as an account already in the squad: its guest row goes, it is told ended: elsewhere, and Start seats the account once');
    else fail('(d18) mirror, live: ' + JSON.stringify({ g: g.rx, seated: seat.calls, roster: ids5(last5(wl, 'state')) }));
  }
  {
    // THE MIRROR WHEN THE ACCOUNT'S ROW IS DROPPED: nobody live holds it, so
    // the socket that has just signed in takes it — resume's own rule — and
    // the player is back in the squad on the device in their hand.
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, wm, code } = await pair5(S);
    close5(S, wm);
    await flush5();
    const g = mkws5(null);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    g.rx.length = 0;
    switch5(S, g, MEM);
    await flush5();
    const mine = last5(g, 'state');
    if (mine && same(ids5(mine), [LEAD, MEM]) && mine.you === 1 && mine.members[1].dropped === false && sq5(g, 'ended').length === 0)
      ok('(d18) signing in as an account whose row is dropped takes that row onto this socket: one row, back, and pushed to it');
    else fail('(d18) mirror, dropped: ' + JSON.stringify(g.rx));
  }
  {
    // WHAT A SIGNED-IN GUEST ROW BECOMES. With no other row for the account
    // anywhere, the row the socket holds becomes the ACCOUNT's: shown by its
    // proved callsign, and addressable by the account id like anyone else's.
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, code } = await pair5(S);
    const g = mkws5(null);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    switch5(S, g, THIRD);
    await flush5();
    const shown = last5(wl, 'state') || {};
    g.rx.length = 0;
    await S.handle(wl, { type: 'squad', op: 'kick', id: THIRD });
    if (shown.members && shown.members[2] && shown.members[2].id === THIRD && shown.members[2].callsign === 'Crater Two'
      && shown.members[2].guest === false && same(sq5(g, 'ended'), [{ type: 'squad', op: 'ended', reason: 'kicked' }]))
      ok('(d18) a guest who signs in with no row elsewhere becomes that account\'s row: its callsign is shown and it answers to the account id');
    else fail('(d18) adopted row: ' + JSON.stringify({ shown: shown.members, g: g.rx }));
  }
  {
    // THE VARIANT TASK 2 ACCEPTED is left as it is: g holds a guest row in X
    // and signs in as MEM, who LEADS squad Y from another device. (That state
    // is what (h9), (s3l), (st6) and squad_seat's (B11) are built on.) From
    // it, MEM's other device joining X would put the account in X twice, so
    // that join is refused — and refused before anything moves, so Y keeps
    // its leader.
    const S = social5(store5(), { cw: mkClockwork() });
    const wl = up5(S, mkws5(LEAD)), wm = up5(S, mkws5(MEM));
    await S.handle(wl, { type: 'squad', op: 'create' });
    const X = last5(wl, 'state').code;
    await S.handle(wm, { type: 'squad', op: 'create' });
    const Y = last5(wm, 'state').code;
    const g = mkws5(null);
    await S.handle(g, { type: 'squad', op: 'join', code: X, name: 'G', skin: 'gold' });
    switch5(S, g, MEM);
    await flush5();
    const x0 = ids5(last5(wl, 'state'));
    wl.rx.length = 0;
    await S.handle(wm, { type: 'squad', op: 'join', code: X, id: 'j' });
    const a = wm.rx.find((f) => f.id === 'j');
    await S.handle(wm, { type: 'squad', op: 'resume', code: Y, id: 'r' });
    const y = wm.rx.find((f) => f.id === 'r') || {};
    if (same(x0, [LEAD, 'guest']) && same(a, { type: 'squad', op: 'join', error: 'already_in', id: 'j' }) && sq5(wl).length === 0 && y.code === Y && y.leader === MEM)
      ok('(d18) the account joining a squad its signed-in guest row already stands in is refused already_in, and nothing moves');
    else fail('(d18) variant join: ' + JSON.stringify({ x0, answer: a, told: wl.rx, y }));
  }
  {
    // THE GUARD ON THE HARM ITSELF. The state is built DIRECTLY — a socket's
    // identity changed without the sign-in hook — because the rules above
    // make it unreachable through server.js; Start must refuse it anyway,
    // naming the second row, and seat nobody. Twice: on a free-for-all, and
    // on a duel, where it would be the account against itself.
    for (const mode of ['ffa', 'duel']) {
      const seat = seatRec5();
      const S = social5(store5(), { cw: mkClockwork(), seatSquad: seat.fn });
      const wm = up5(S, mkws5(MEM));
      await S.handle(wm, { type: 'squad', op: 'create' });
      const code = last5(wm, 'state').code;
      await S.handle(wm, { type: 'squad', op: 'mode', mode });
      const g = mkws5(null);
      await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
      g.userId = MEM; g.isGuest = false;       // no hook: built directly
      await readyAll5(S, [wm, g]);
      if (mode === 'ffa') { const wt = up5(S, mkws5(THIRD)); await S.handle(wt, { type: 'squad', op: 'join', code }); await readyAll5(S, [wt]); }
      wm.rx.length = 0;
      await S.handle(wm, { type: 'squad', op: 'start', id: 's' });
      const a = wm.rx.find((f) => f.id === 's');
      if (same(a, { type: 'squad', op: 'start', error: 'duplicate_member', at: 1, id: 's' }) && seat.calls.length === 0)
        ok(`(d18) Start refuses one account on two rows (${mode}): duplicate_member, naming the second row, and nobody is seated`);
      else fail(`(d18) defence on ${mode}: ` + JSON.stringify({ a, seated: seat.calls }));
    }
  }

  // ---- (end of task 5) ----
}

// ===========================================================================
// TASK 6 — INVITES TO A CONNECTED FRIEND, AND WHAT A BLOCK DOES TO A SQUAD
//
// This section brings its own store double, its own clock and its own sockets
// so a change to another section's fixture cannot break it — the rule
// test/social.mjs's phase 6 block states above itself. It drives the REAL
// createSocial and the REAL squad state machine: nothing here stubs the
// function under test. What is injected is what server.js itself injects —
// the engine's seat table, a seat-handle resolver, and the push transport,
// which task 7 builds and which does not exist in this build at all.
// ===========================================================================
{
  // Read INSIDE createSocial, per instance, and put back at the end of the
  // section. 0 turns the friends fan-out's collapse off, so a block's two
  // snapshots have arrived by the next await — the collapse runs on the WALL
  // clock, and left on it would make these checks depend on how fast the
  // machine is. The presence window is pushed out of reach for the same
  // reason: a flush landing mid-section would put store reads into `calls`.
  const prevPushMs = process.env.SOCIAL_PUSH_MS;
  const prevPresenceMs = process.env.SOCIAL_PRESENCE_MS;
  process.env.SOCIAL_PUSH_MS = '0';
  process.env.SOCIAL_PRESENCE_MS = '3600000';

  const uid6 = (n) => '00000000-0000-4000-8000-cc' + String(n).padStart(10, '0');
  const A = uid6(1), B = uid6(2), C = uid6(3), D = uid6(4), E = uid6(5), NN = uid6(7), GU = uid6(9);
  const ROWS6 = [
    { id: A, callsign: 'Anvil Six',   friend_code: 'ABC234', callsign_key: 'anvil six',   callsign_set_at: null, skin: 'desert' },
    { id: B, callsign: 'Bunker Nine', friend_code: 'BDF345', callsign_key: 'bunker nine', callsign_set_at: null, skin: 'gold' },
    { id: C, callsign: 'Crater Two',  friend_code: 'CGH456', callsign_key: 'crater two',  callsign_set_at: null },
    { id: D, callsign: 'Dune Four',   friend_code: 'DJK567', callsign_key: 'dune four',   callsign_set_at: null },
    { id: E, callsign: 'Echo Seven',  friend_code: 'EMN678', callsign_key: 'echo seven',  callsign_set_at: null },
    // NO PROVABLE NAME: free text in a column the account PATCHes itself,
    // with no callsign_key beside it, so displayName answers null.
    { id: NN, callsign: 'FOLLOW ME OK', friend_code: 'NPQ789', callsign_key: null, callsign_set_at: null },
    // The ANONYMOUS account a guest actually arrives on (BINDING 1): an
    // account id, a profile row, and never a friend.
    { id: GU, callsign: 'Ghost', friend_code: 'GRS234', callsign_key: null, callsign_set_at: null },
  ];
  const UUID6 = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const PAIR6 = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

  // The store double: server/store.js's method set and return shapes.
  // profilesByIds returns { id, callsign, callsign_key } and nothing else,
  // exactly as `select=id,callsign,callsign_key` does, so a name can only be
  // proved against the columns the real query fetches. `boom` fails a method;
  // `hold` parks the next call to a method until released, and says when a
  // call is parked there — so a test can act INSIDE a read without guessing
  // how long one takes.
  function t6store(rows) {
    const profiles = new Map(rows.map((p) => [p.id, { ...p }]));
    const friends = new Set(), requests = new Set(), blocks = new Set();
    const gates = new Map();
    const st = {
      profiles, friends, requests, blocks, calls: [], boom: new Set(),
      async _hit(m) {
        st.calls.push(m);
        if (st.boom.has(m)) throw new Error('sb GET 500');
        const g = gates.get(m);
        if (g) { gates.delete(m); g.entered(); await g.open; }
      },
      hold(m) {
        let release, entered;
        const open = new Promise((r) => { release = r; });
        const inside = new Promise((r) => { entered = r; });
        gates.set(m, { open, entered });
        return { release, inside };
      },
      async ensureFriendCode(id) { await st._hit('ensureFriendCode'); const p = profiles.get(id); return p ? p.friend_code : null; },
      async profileById(id) { await st._hit('profileById'); return profiles.get(id) || null; },
      async profileByCallsignKey(k) { await st._hit('profileByCallsignKey'); return [...profiles.values()].find((p) => p.callsign_key === k) || null; },
      async profilesByIds(ids) { await st._hit('profilesByIds'); const m = new Map(); for (const id of ids) { const p = profiles.get(id); if (p) m.set(id, { id, callsign: p.callsign, callsign_key: p.callsign_key ?? null }); } return m; },
      async friendIdsOf(id) { await st._hit('friendIdsOf'); const o = []; for (const k of friends) { const [a, b] = k.split('|'); if (a === id) o.push(b); else if (b === id) o.push(a); } return o; },
      async requestsOf(id) { await st._hit('requestsOf'); const incoming = [], outgoing = []; for (const k of requests) { const [f, t] = k.split('>'); if (t === id) incoming.push(f); else if (f === id) outgoing.push(t); } return { incoming, outgoing }; },
      async blockIdsOf(id) { await st._hit('blockIdsOf'); const blocked = [], blockedBy = []; for (const k of blocks) { const [a, b] = k.split('>'); if (a === id) blocked.push(b); else if (b === id) blockedBy.push(a); } return { blocked, blockedBy }; },
      async addFriendship(a, b) { await st._hit('addFriendship'); friends.add(PAIR6(a, b)); },
      async removeFriendship(a, b) { await st._hit('removeFriendship'); friends.delete(PAIR6(a, b)); },
      async addRequest(f, t) { await st._hit('addRequest'); requests.add(f + '>' + t); },
      async deleteRequest(f, t) { await st._hit('deleteRequest'); requests.delete(f + '>' + t); },
      async addBlock(a, b) { await st._hit('addBlock'); blocks.add(a + '>' + b); },
      async removeBlock(a, b) { await st._hit('removeBlock'); blocks.delete(a + '>' + b); },
    };
    return st;
  }

  let CLOCK6 = Date.parse('2026-09-24T09:00:00Z');
  // A socket as server.js leaves it after a verified hello. `throwOn`, when
  // set, makes send() THROW for the frames it matches — the half-closed
  // socket safeSend exists for — so a reply can be made undeliverable.
  const t6ws = (userId, isGuest = false) => ({ readyState: 1, userId, isGuest, rx: [] });
  // WHAT THE PUSH SEAM WAS ASKED FOR. Task 7 replaces the default inside
  // server.js; recording the call here is what lets the payload be asserted
  // where a wrong code or a missing size is visible. PUSHES holds the calls
  // that SEND; DRY6 the dry runs (`{ dryRun: true }`, D-BLOCK-2 E revised),
  // which send nothing and answer what a real call would.
  const PUSHES = [];
  const DRY6 = [];
  let pushAnswer = true;
  // EVERY FRAME SENT, IN ORDER, across all sockets — what a twin world
  // compares when the order BETWEEN players matters (a kick's victim frame
  // goes before the roster).
  const TRACE6 = [];
  // THE SEND server.js REALLY USES, down to the wire: nothing reaches a
  // socket that is not open, and what does has been through JSON.
  const mkSocial6 = (store, extra = {}) => createSocial({
    seats: MODE_SEATS, teeIds: TEE_IDS, validRack: validRackFor,
    schedule: () => () => {},
    pushInvite: async (to, payload, opts) => { (opts && opts.dryRun === true ? DRY6 : PUSHES).push([to, payload]); return pushAnswer; },
    ...extra,
    store, terms: [], now: () => CLOCK6,
    send: (ws, f) => {
      if (!ws || ws.readyState !== 1) return;
      if (ws.throwOn && ws.throwOn(f)) throw new Error('half-closed socket');
      const g = JSON.parse(JSON.stringify(f));
      ws.rx.push(g);
      TRACE6.push([ws, g]);
    },
  });
  // Linked, and counted in presence by onAuth, as a verified hello leaves it.
  const up6 = (S, id, isGuest = false) => { const w = t6ws(id, isGuest); S.onAuth(w); return w; };
  const got6 = (w, type, op) => w.rx.filter((f) => f.type === type && (!op || f.op === op));
  const last6 = (w, type, op) => { const f = got6(w, type, op); return f[f.length - 1] || null; };
  const ans6 = (w, id) => w.rx.find((f) => f.id === id) || null;
  const invited6 = (w) => got6(w, 'squad', 'invited');
  const ids6 = (f) => (f && Array.isArray(f.members) ? f.members.map((m) => m.id) : null);
  const same6 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const clear6 = (...ws) => { for (const w of ws) w.rx.length = 0; };
  // A squad, made the way a player makes one, its code read off the answer.
  const create6 = async (S, w) => { await S.handle(w, { type: 'squad', op: 'create' }); return (last6(w, 'squad', 'state') || {}).code; };
  const join6 = (S, w, code, name = 'Somebody') => S.handle(w, { type: 'squad', op: 'join', code, name, skin: 'olive' });
  // true once `p` settles, false if it has not within fifty macrotask turns
  // — so a read that is never entered fails its check instead of hanging the
  // file on an await nothing will ever settle.
  const within6 = async (p) => {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 50 && !done; i++) await new Promise((r) => setImmediate(r));
    return done;
  };
  // A READ ANSWERED FROM A SNAPSHOT AND DELIVERED LATE: the NEXT call to
  // method `m` computes its answer from the store as it is NOW, then waits
  // until released — a read that went out before a write and lands after it.
  // Later calls are ordinary again. restore() disarms one never called, so
  // a read that never came cannot catch some later, unrelated one.
  const stale6 = (st, m) => {
    const real = st[m];
    let release, entered;
    const open = new Promise((r) => { release = r; });
    const inside = new Promise((r) => { entered = r; });
    const wrap = async function (...a) { st[m] = real; const v = await real.apply(st, a); entered(); await open; return v; };
    st[m] = wrap;
    return { release, inside, restore: () => { if (st[m] === wrap) st[m] = real; } };
  };
  // stale6, for the next call to `m` whose first argument is `arg` only:
  // calls about anybody else pass straight through.
  const staleFor6 = (st, m, arg) => {
    const real = st[m];
    let release, entered;
    const open = new Promise((r) => { release = r; });
    const inside = new Promise((r) => { entered = r; });
    const wrap = async function (...a) {
      if (a[0] !== arg) return real.apply(st, a);
      st[m] = real;
      const v = await real.apply(st, a); entered(); await open; return v;
    };
    st[m] = wrap;
    return { release, inside, restore: () => { if (st[m] === wrap) st[m] = real; } };
  };
  // server.js's hello, in its order: the generation (bumped as verification
  // starts), the close hook when the socket was some other account, the
  // identity, then onAuth.
  const hello6 = (S, w, id, isGuest = false) => {
    w.authGen = (w.authGen || 0) + 1;
    if (w.userId && w.userId !== id) S.onClose(w);
    w.userId = id; w.isGuest = isGuest; S.onAuth(w);
  };
  // Lets the layer's detached work (the sign-in check) run to the end.
  const settle6 = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  // Polls real time for `pred`, up to `ms` — for a check that waits on a timer.
  const until6 = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
    return pred();
  };

  // ---- (inv-a) an online friend gets the invite down every socket ----------
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa = up6(S, A), wb1 = up6(S, B), wb2 = up6(S, B);
    const code = await create6(S, wa);
    clear6(wa, wb1, wb2); PUSHES.length = 0;
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'i1' });
    const r = ans6(wa, 'i1');
    if (same6(r, { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'i1' }))
      ok('(inv-a) invite: the inviter is told delivered:online, with the request id echoed');
    else fail('(inv-a) invite reply: ' + JSON.stringify(r));
    const inv = invited6(wb1);
    // THE WHOLE FRAME, compared exactly: the code, the PROVED name, the
    // size and the cap — and so nothing else: no request id, no account id.
    if (inv.length === 1 && same6(inv[0], { type: 'squad', op: 'invited', code, from: { callsign: 'Anvil Six' }, size: 1, max: 4 }))
      ok('(inv-a) invite: the frame is exactly the code, the proved name, the size and the cap');
    else fail('(inv-a) invited frame: ' + JSON.stringify(inv));
    if (invited6(wb2).length === 1) ok('(inv-a) invite: EVERY socket of the invited account, not only the newest');
    else fail('(inv-a) second device got ' + JSON.stringify(wb2.rx));
    if (inv[0] && inv[0].id === undefined && !UUID6.test(JSON.stringify(inv[0])))
      ok('(inv-a) the invited frame carries no request id and no account id — it answers nothing, and Join needs only the code');
    else fail('(inv-a) the invited frame carried an id: ' + JSON.stringify(inv[0]));
    if (PUSHES.length === 0) ok('(inv-a) an online player is never also pushed (design 4.4)');
    else fail('(inv-a) an online player was pushed: ' + JSON.stringify(PUSHES));
    if (invited6(wa).length === 0 && got6(wa, 'squad').length === 1)
      ok('(inv-a) and the inviter gets its answer and nothing else — no invite of its own, no roster');
    else fail('(inv-a) the inviter got ' + JSON.stringify(wa.rx));
  }

  // ---- (inv-b) an offline friend goes to the push seam (task 7 fills it) ---
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa = up6(S, A);                           // B holds no socket at all
    const code = await create6(S, wa);
    PUSHES.length = 0; pushAnswer = true;
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'p1' });
    const r = ans6(wa, 'p1');
    if (same6(r, { type: 'squad', op: 'invite', ok: true, delivered: 'push', id: 'p1' })) ok('(inv-b) invite: an offline friend is delivered:push');
    else fail('(inv-b) push reply: ' + JSON.stringify(r));
    if (PUSHES.length === 1 && PUSHES[0][0] === B && same6(PUSHES[0][1], { code, from: 'Anvil Six', size: 1, max: 4 }))
      ok('(inv-b) the seam is handed the account, the code, the proved name, the size and the cap — all task 7 renders');
    else fail('(inv-b) seam call: ' + JSON.stringify(PUSHES));
    // THE HALF THAT MAKES `delivered` HONEST: no endpoint took it.
    pushAnswer = false;
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'p2' });
    if ((ans6(wa, 'p2') || {}).delivered === 'none') ok('(inv-b) a seam that delivered nothing is reported none, not push');
    else fail('(inv-b) undelivered push: ' + JSON.stringify(ans6(wa, 'p2')));
    // ONLY A LITERAL true IS A PUSH. A transport that answers a count, a
    // word or a receipt has said nothing about whether an endpoint took it.
    const loose = [];
    for (const [i, v] of [[3, 1], [4, 'sent'], [5, {}]]) {
      pushAnswer = v;
      await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'p' + i });
      if ((ans6(wa, 'p' + i) || {}).delivered !== 'none') loose.push([v, ans6(wa, 'p' + i)]);
    }
    pushAnswer = true;
    if (!loose.length) ok('(inv-b) a seam answering anything but true — 1, a word, an object — is none');
    else fail('(inv-b) a truthy non-true seam answer: ' + JSON.stringify(loose));
    // A TRANSPORT THAT THROWS IS none, NOT unavailable: handleSquad's net
    // would otherwise turn a failed notification into a failed invite. Both
    // ways a transport can throw: rejecting, and throwing before it returns.
    const thrown = [];
    for (const seam of [async () => { throw new Error('apns 503'); }, () => { throw new Error('sync 503'); }]) {
      const S2 = mkSocial6(st, { pushInvite: seam });
      const w = up6(S2, A); await create6(S2, w);
      await S2.handle(w, { type: 'squad', op: 'invite', to: B, id: 't' });
      const r2 = ans6(w, 't');
      if (!(r2 && r2.ok === true && r2.delivered === 'none')) thrown.push(r2);
    }
    if (!thrown.length) ok('(inv-b) a push transport that throws, async or not, is delivered:none — an invite is not failed by a notification');
    else fail('(inv-b) throwing transport: ' + JSON.stringify(thrown));
    // A SYNCHRONOUS seam that answers true is a push: task 7 may hand in a
    // plain function, and the answer is awaited either way.
    const S4 = mkSocial6(st, { pushInvite: () => true });
    const w4 = up6(S4, A); await create6(S4, w4);
    await S4.handle(w4, { type: 'squad', op: 'invite', to: B, id: 's' });
    if ((ans6(w4, 's') || {}).delivered === 'push') ok('(inv-b) a synchronous seam answering true is a push');
    else fail('(inv-b) synchronous seam: ' + JSON.stringify(ans6(w4, 's')));
    // THE DEFAULT SEAM: no transport injected at all, which is what this
    // build ships until task 7 wires server.js.
    const S3 = createSocial({ store: st, terms: [], now: () => CLOCK6, schedule: () => () => {}, send: (w, f) => w.rx.push(JSON.parse(JSON.stringify(f))) });
    const w3 = up6(S3, A); await create6(S3, w3);
    await S3.handle(w3, { type: 'squad', op: 'invite', to: B, id: 'd' });
    if (same6(ans6(w3, 'd'), { type: 'squad', op: 'invite', ok: true, delivered: 'none', id: 'd' }))
      ok('(inv-b) with no transport injected the default seam answers none — task 7 replaces the default and nothing else');
    else fail('(inv-b) default seam: ' + JSON.stringify(ans6(w3, 'd')));
  }


  // ---- (inv-c) the refusals, and not one of them delivers anything --------
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa = up6(S, A), wb = up6(S, B), wc = up6(S, C);
    PUSHES.length = 0; DRY6.length = 0;
    // NO SQUAD. The Friends tab's Invite button creates one first; the
    // server does not create one behind a client's back.
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'c1' });
    if (same6(ans6(wa, 'c1'), { type: 'squad', op: 'invite', error: 'no_squad', id: 'c1' })) ok('(inv-c) invite with no squad: no_squad');
    else fail('(inv-c) no squad: ' + JSON.stringify(ans6(wa, 'c1')));
    const code = await create6(S, wa);
    // A MEMBER IS NOT A TARGET.
    await join6(S, wb, code, 'Bunker Nine');
    clear6(wb);
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'c2' });
    if (same6(ans6(wa, 'c2'), { type: 'squad', op: 'invite', error: 'already', id: 'c2' })) ok('(inv-c) inviting somebody already in the squad: already');
    else fail('(inv-c) already a member: ' + JSON.stringify(ans6(wa, 'c2')));
    if (!invited6(wb).length) ok('(inv-c) and they are not invited to the squad they are sitting in');
    else fail('(inv-c) a member was invited: ' + JSON.stringify(wb.rx));
    // A STRANGER, AND A MALFORMED TARGET, IN THE SAME WORDS.
    await S.handle(wa, { type: 'squad', op: 'invite', to: C, id: 'c3' });
    if (same6(ans6(wa, 'c3'), { type: 'squad', op: 'invite', error: 'not_friend', id: 'c3' })) ok('(inv-c) inviting a stranger: not_friend');
    else fail('(inv-c) stranger: ' + JSON.stringify(ans6(wa, 'c3')));
    const junk = [];
    for (const [i, to] of [[4, 'not-a-uuid'], [5, ''], [6, undefined], [7, 42]]) {
      st.calls.length = 0;
      await S.handle(wa, { type: 'squad', op: 'invite', to, id: 'c' + i });
      if (!(same6(ans6(wa, 'c' + i), { type: 'squad', op: 'invite', error: 'not_friend', id: 'c' + i }) && st.calls.length === 0)) junk.push([to, ans6(wa, 'c' + i), [...st.calls]]);
    }
    if (!junk.length) ok('(inv-c) a malformed or missing target is refused in the same words and costs no round trip');
    else fail('(inv-c) malformed target: ' + JSON.stringify(junk));
    if (!invited6(wc).length) ok('(inv-c) the stranger was told nothing at all');
    else fail('(inv-c) a stranger got an invite: ' + JSON.stringify(wc.rx));
    // A STORE FAULT answers unavailable, WITH THE OP, and delivers nothing —
    // handleSquad's own net, which is why this handler has no catch.
    st.boom.add('friendIdsOf');
    const wd = up6(S, D); await st.addFriendship(A, D);
    await S.handle(wa, { type: 'squad', op: 'invite', to: D, id: 'c8' });
    st.boom.delete('friendIdsOf');
    if (same6(ans6(wa, 'c8'), { type: 'squad', op: 'invite', error: 'unavailable', id: 'c8' }) && !invited6(wd).length)
      ok('(inv-c) a store fault answers unavailable with the op on it, and nobody is invited');
    else fail('(inv-c) store fault: ' + JSON.stringify(ans6(wa, 'c8')) + ' ' + JSON.stringify(wd.rx));
    if (PUSHES.length === 0 && DRY6.length === 0) ok('(inv-c) not one refusal reached the push seam');
    else fail('(inv-c) a refusal pushed: ' + JSON.stringify({ PUSHES, DRY6 }));
  }

  // ---- (inv-c2) a block refuses an invite in BOTH directions ---------------
  // The friendship is written UNDER the block on purpose. In ordinary
  // operation `block add` deletes it, so a one-directional gate would never be
  // caught by a test that blocks through the handler — the friend read alone
  // would refuse. This is the state that isolates the block read itself. B
  // holds no socket in the second pass, so a leak there reaches the SEAM.
  {
    for (const dir of ['blocked', 'blockedBy']) {
      for (const online of [true, false]) {
        const st = t6store(ROWS6);
        await st.addFriendship(A, B);
        if (dir === 'blocked') await st.addBlock(A, B); else await st.addBlock(B, A);
        const S = mkSocial6(st);
        const wa = up6(S, A), wb = online ? up6(S, B) : t6ws(B);
        await create6(S, wa);
        clear6(wb); PUSHES.length = 0; DRY6.length = 0;
        const tag = `${dir}, ${online ? 'online' : 'offline'}`;
        await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'k' });
        if (same6(ans6(wa, 'k'), { type: 'squad', op: 'invite', error: 'not_friend', id: 'k' }))
          ok(`(inv-c2) ${tag}: the invite is refused, in the same words a stranger gets`);
        else fail(`(inv-c2) ${tag}: ` + JSON.stringify(ans6(wa, 'k')));
        if (!invited6(wb).length && PUSHES.length === 0 && DRY6.length === 0)
          ok(`(inv-c2) ${tag}: and nothing reached them, by socket or by push`);
        else fail(`(inv-c2) ${tag} leaked: ` + JSON.stringify(wb.rx) + ' ' + JSON.stringify({ PUSHES, DRY6 }));
      }
    }
  }

  // ---- (inv-d) a full squad cannot invite a fifth ------------------------
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa = up6(S, A), wb = up6(S, B);
    const code = await create6(S, wa);
    for (const [id, name] of [[C, 'Crater Two'], [D, 'Dune Four']]) await join6(S, up6(S, id), code, name);
    // THE CONTROL: three is not full. A cap written one short passes the
    // refusal below and fails here.
    clear6(wb); PUSHES.length = 0;
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'd3' });
    const three = invited6(wb)[0];
    if ((ans6(wa, 'd3') || {}).delivered === 'online' && three && three.size === 3 && three.max === 4)
      ok('(inv-d) a squad of three may still invite, and the frame says 3 of 4');
    else fail('(inv-d) squad of three: ' + JSON.stringify(ans6(wa, 'd3')) + ' ' + JSON.stringify(three));
    await join6(S, up6(S, E), code, 'Echo Seven');
    clear6(wb); PUSHES.length = 0; DRY6.length = 0;
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'd4' });
    if (same6(ans6(wa, 'd4'), { type: 'squad', op: 'invite', error: 'full', id: 'd4' })) ok('(inv-d) a squad of four refuses an invite: full');
    else fail('(inv-d) full squad: ' + JSON.stringify(ans6(wa, 'd4')));
    if (!invited6(wb).length && PUSHES.length === 0 && DRY6.length === 0)
      ok('(inv-d) and the fifth player is never told about a squad they cannot enter');
    else fail('(inv-d) leaked to the fifth: ' + JSON.stringify(wb.rx) + ' ' + JSON.stringify({ PUSHES, DRY6 }));
    // AND THE MACHINE AGREES: the fifth player's own join is refused too, so
    // the invite cap and the join cap are the same number.
    await join6(S, wb, code, 'Bunker Nine');
    if ((last6(wb, 'squad', 'join') || {}).error === 'full') ok('(inv-d) the join cap is the same number: the fifth join is refused full');
    else fail('(inv-d) fifth join: ' + JSON.stringify(wb.rx));
  }

  // ---- (inv-e) a null name keeps the invite -----------------------------
  // displayName answers null for a rolled name, for a row whose callsign does
  // not match its key, and for a name the blocklist has caught since. The rule
  // is the panels' rule: a null name KEEPS THE ROW. An invite that dropped
  // itself here would be a friend who simply cannot invite, with nothing on
  // any screen to say why.
  {
    const st = t6store(ROWS6);
    await st.addFriendship(NN, B);
    const S = mkSocial6(st);
    const wn = up6(S, NN), wb = up6(S, B);
    await create6(S, wn);
    clear6(wb);
    await S.handle(wn, { type: 'squad', op: 'invite', to: B, id: 'e' });
    const inv = invited6(wb)[0];
    if ((ans6(wn, 'e') || {}).delivered === 'online' && inv && inv.from && inv.from.callsign === null)
      ok('(inv-e) an inviter with no provable name still delivers, and the frame carries callsign:null');
    else fail('(inv-e) null-name invite: ' + JSON.stringify(ans6(wn, 'e')) + ' ' + JSON.stringify(inv));
    if (inv && !/FOLLOW ME OK/i.test(JSON.stringify(inv)))
      ok('(inv-e) and the free text in the profile column never reaches the invited player');
    else fail('(inv-e) an unproved name leaked: ' + JSON.stringify(inv));
  }

  // ---- (inv-e2) a guest cannot be invited, and presence is not why (R12) --
  // onAuth returns early for an anonymous account, so a guest has no
  // presence at all. That makes "online ? frame : push" answer a guest
  // delivered:'none' — an invite that looks accepted and reaches nobody. The
  // FRIEND READ is what refuses it, and the fault injection that removes that
  // one line is what proves it.
  {
    const st = t6store(ROWS6);
    const S = mkSocial6(st);
    const wa = up6(S, A), wg = up6(S, GU, true);
    if (!S.online.has(GU)) ok('(inv-e2) a guest is never counted online — onAuth returns early for an anonymous account');
    else fail('(inv-e2) a guest was counted online: ' + JSON.stringify([...S.online.keys()]));
    await create6(S, wa);
    clear6(wg); PUSHES.length = 0; DRY6.length = 0;
    await S.handle(wa, { type: 'squad', op: 'invite', to: GU, id: 'g' });
    if (same6(ans6(wa, 'g'), { type: 'squad', op: 'invite', error: 'not_friend', id: 'g' })) ok('(inv-e2) inviting a guest is refused: not_friend');
    else fail('(inv-e2) guest invite: ' + JSON.stringify(ans6(wa, 'g')));
    if (wg.rx.length === 0 && PUSHES.length === 0 && DRY6.length === 0)
      ok('(inv-e2) and nothing at all was delivered — no frame, no push, no delivered:none');
    else fail('(inv-e2) a guest was reached: ' + JSON.stringify(wg.rx) + ' ' + JSON.stringify({ PUSHES, DRY6 }));
  }

  // ---- (inv-f) invite is behind the sign-in gate, per op (R3) --------------
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wg = up6(S, GU, true);             // a REAL uuid with isGuest true
    st.calls.length = 0; PUSHES.length = 0; DRY6.length = 0;
    await S.handle(wg, { type: 'squad', op: 'invite', to: B, id: 'g1' });
    if (same6(wg.rx, [{ type: 'social', error: 'sign_in', id: 'g1' }]))
      ok('(inv-f) a guest inviting is answered sign_in on type social, with its id echoed, and nothing else');
    else fail('(inv-f) guest invite reply: ' + JSON.stringify(wg.rx));
    if (st.calls.length === 0 && PUSHES.length === 0 && DRY6.length === 0)
      ok('(inv-f) and never reaches the store or the push seam');
    else fail('(inv-f) a guest reached ' + JSON.stringify(st.calls) + ' ' + JSON.stringify({ PUSHES, DRY6 }));
    const wn = t6ws(null);                   // a socket that never said hello
    await S.handle(wn, { type: 'squad', op: 'invite', to: B, id: 'g2' });
    if (same6(wn.rx, [{ type: 'social', error: 'sign_in', id: 'g2' }])) ok('(inv-f) and so is a socket with no account at all');
    else fail('(inv-f) anonymous socket reply: ' + JSON.stringify(wn.rx));
  }

  // ---- (inv-g) an invite spends the friend bucket --------------------------
  // design 4.2 sizes no squad-invite bucket. This op belongs in the friend
  // one on every count: it is aimed at a friend, it costs the round trips a
  // `friend op:'request'` does, and it is the one frame in this layer that can
  // reach a device's notification tray. Ten a minute is far above any honest
  // client — a squad holds three other people.
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa = up6(S, A), wb = up6(S, B);
    await create6(S, wa);
    for (let i = 0; i < 10; i++) await S.handle(wa, { type: 'friend', op: 'search', q: 'nobody at all' });
    clear6(wb); PUSHES.length = 0; DRY6.length = 0; st.calls.length = 0;
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'r1' });
    if (same6(ans6(wa, 'r1'), { type: 'squad', op: 'invite', error: 'slow_down', id: 'r1' }))
      ok('(inv-g) ten friend ops in a minute leave no allowance for an invite — one bucket, deliberately shared');
    else fail('(inv-g) invite after ten friend ops: ' + JSON.stringify(ans6(wa, 'r1')));
    if (!invited6(wb).length && PUSHES.length === 0 && DRY6.length === 0 && st.calls.length === 0)
      ok('(inv-g) and a refused invite notifies nobody and costs no round trip');
    else fail('(inv-g) a rate-refused invite still ran: ' + JSON.stringify(wb.rx) + ' ' + JSON.stringify({ PUSHES, DRY6 }) + ' ' + JSON.stringify(st.calls));
    CLOCK6 += 60000;
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'r2' });
    if ((ans6(wa, 'r2') || {}).delivered === 'online') ok('(inv-g) and the bucket refills: a minute later the invite goes');
    else fail('(inv-g) after the refill: ' + JSON.stringify(ans6(wa, 'r2')));
  }


  // ---- (inv-h) a member who does not lead may invite -----------------------
  // design 4.3: "leader or member may invite". Mode, start and kick are the
  // leader's and go through ledSquad; invite must not, or every member's
  // Invite button answers a refusal.
  {
    const st = t6store(ROWS6);
    await st.addFriendship(B, C);
    const S = mkSocial6(st);
    const wa = up6(S, A), wb = up6(S, B), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wb, code, 'Bunker Nine');
    clear6(wc);
    await S.handle(wb, { type: 'squad', op: 'invite', to: C, id: 'h' });
    const inv = invited6(wc)[0];
    if ((ans6(wb, 'h') || {}).delivered === 'online' && same6(inv, { type: 'squad', op: 'invited', code, from: { callsign: 'Bunker Nine' }, size: 2, max: 4 }))
      ok('(inv-h) a member who does not lead invites their own friend, under their own proved name');
    else fail('(inv-h) member invite: ' + JSON.stringify(ans6(wb, 'h')) + ' ' + JSON.stringify(inv));
  }

  // ---- (inv-i) WHICH squad: the row this socket holds ---------------------
  // squadKey's order, the file's one answer to "which row is this caller":
  // the socket's own row first, the account's only for a socket holding none.
  // Built in the TWO-SQUADS state task 5 left standing on purpose (see
  // claimOnSignIn): device 1 joined C's squad X as a guest and then signed in
  // as A, while A leads squad Y from device 2. The Invite button pressed on
  // device 1 is on X's box; an account-first lookup would invite to Y.
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B); await st.addFriendship(A, C);
    const S = mkSocial6(st);
    const wc = up6(S, C);
    const X = await create6(S, wc);
    const wa2 = up6(S, A);
    const Y = await create6(S, wa2);
    const wa1 = t6ws(null);
    await join6(S, wa1, X, 'Anvil');
    // server.js's hello, in its order: the generation, the identity, onAuth.
    wa1.authGen = 1; wa1.userId = A; wa1.isGuest = false; S.onAuth(wa1);
    const wb = up6(S, B);
    await S.handle(wa1, { type: 'squad', op: 'invite', to: B, id: 'x' });
    const inv = invited6(wb)[0];
    if (X !== Y && (ans6(wa1, 'x') || {}).delivered === 'online' && inv && inv.code === X && inv.size === 2)
      ok('(inv-i) a socket holding a row invites to THAT squad — the one on its screen — not the one its account leads elsewhere');
    else fail('(inv-i) invite from the guest row\'s socket: ' + JSON.stringify({ X, Y, answer: ans6(wa1, 'x'), inv }));
    // A SECOND DEVICE HOLDING NO ROW invites to the ACCOUNT's squad.
    const wa3 = up6(S, A);
    clear6(wb);
    await S.handle(wa3, { type: 'squad', op: 'invite', to: B, id: 'y' });
    const inv2 = invited6(wb)[0];
    if ((ans6(wa3, 'y') || {}).delivered === 'online' && inv2 && inv2.code === Y && inv2.size === 1)
      ok('(inv-i) a device holding no row invites to the squad its account is in');
    else fail('(inv-i) invite from a rowless device: ' + JSON.stringify({ answer: ans6(wa3, 'y'), inv2 }));
    // AND A PLAYER WHOSE SOCKET STANDS IN THE SQUAD IS ALREADY THERE, on a
    // guest row as much as on their own: C invites A, and A's device 1 is
    // sitting in X. Asked by row KEY alone, A would be invited to the squad
    // their own screen is showing.
    clear6(wa1, wa2, wa3); PUSHES.length = 0; DRY6.length = 0;
    await S.handle(wc, { type: 'squad', op: 'invite', to: A, id: 'z' });
    if (same6(ans6(wc, 'z'), { type: 'squad', op: 'invite', error: 'already', id: 'z' }) && ![wa1, wa2, wa3].some((w) => invited6(w).length) && PUSHES.length === 0 && DRY6.length === 0)
      ok('(inv-i) an account whose socket stands in the squad on a guest row is already there, and is not invited to it');
    else fail('(inv-i) invite to a player on a guest row: ' + JSON.stringify({ answer: ans6(wc, 'z'), a1: wa1.rx, a2: wa2.rx, a3: wa3.rx, PUSHES, DRY6 }));
  }

  // ---- (inv-k) the squad and the socket can move while the reads are out --
  {
    // (i) THE SQUAD FILLS DURING THE FRIEND READ. The frame must carry the
    // squad as it IS, and a squad that is full now must not invite a fifth.
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa = up6(S, A), wb = up6(S, B);
    const code = await create6(S, wa);
    clear6(wb); PUSHES.length = 0; DRY6.length = 0;
    const gate = st.hold('friendIdsOf');
    const pending = S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'k1' });
    const inside = await within6(gate.inside);
    if (inside) for (const id of [C, D, E]) await join6(S, up6(S, id), code);
    gate.release(); await pending;
    if (inside && same6(ans6(wa, 'k1'), { type: 'squad', op: 'invite', error: 'full', id: 'k1' }) && !invited6(wb).length && PUSHES.length === 0 && DRY6.length === 0)
      ok('(inv-k) a squad that filled while the friend read was out answers full, and invites nobody');
    else fail('(inv-k) filled during the read: ' + JSON.stringify({ inside, answer: ans6(wa, 'k1'), b: wb.rx, PUSHES, DRY6 }));
  }
  {
    // (ii) THE SOCKET BECOMES ANOTHER ACCOUNT DURING THE READ. server.js's
    // hello for a different account, in its order: the generation, the close
    // hook (A's row leaves — the socket is still open), the new identity,
    // onAuth. D leads a squad of their own, so a handler that carried on
    // would invite A's friend to D's squad, under A's name.
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa = up6(S, A), wb = up6(S, B);
    await create6(S, wa);
    await create6(S, up6(S, D));
    clear6(wb); PUSHES.length = 0; DRY6.length = 0;
    const gate = st.hold('friendIdsOf');
    const pending = S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'k2' });
    const inside = await within6(gate.inside);
    wa.authGen = (wa.authGen || 0) + 1; S.onClose(wa); wa.userId = D; wa.isGuest = false; S.onAuth(wa);
    gate.release(); await pending;
    if (inside && !invited6(wb).length && PUSHES.length === 0 && DRY6.length === 0)
      ok('(inv-k) a socket that became another account during the read invites nobody, from nobody\'s squad');
    else fail('(inv-k) identity changed during the read: ' + JSON.stringify({ inside, answer: ans6(wa, 'k2'), b: wb.rx, PUSHES, DRY6 }));
  }


  // ===== R16: WHAT A BLOCK DOES TO A SQUAD THE PAIR SHARE ====================
  // design 4.2, the block row: "removes them from your squad if you lead it
  // or you from theirs". To everybody but the blocker it is an unfriend plus
  // a kick (the blocker leads) or a leave (the blocker does not): D-BLOCK.
  //
  // A WORLD: `lead` leads, then the others join in order, every socket linked
  // and online, and `pairs` are friends. Frames up to here are cleared.
  const world6 = async (lead, others, pairs = [[A, B]], extra = {}) => {
    const st = t6store(ROWS6);
    for (const [x, y] of pairs) await st.addFriendship(x, y);
    const S = mkSocial6(st, extra);
    const w = { [lead]: up6(S, lead) };
    const code = await create6(S, w[lead]);
    for (const id of others) { w[id] = up6(S, id); await join6(S, w[id], code, 'Member'); }
    clear6(...Object.values(w));
    return { st, S, w, code, mark: TRACE6.length };
  };
  // A frame with its squad code blanked, so two worlds can be compared. ONLY
  // A CODE THE FRAME CARRIES is blanked: a frame without one is compared as
  // it is, so a code that appears where it should not is a difference.
  const blank6 = (f) => ('code' in f ? { ...f, code: '-' } : f);
  // What `socks` received from `mark` on, in the order it was sent, each
  // frame tagged with its socket's place in the list and its code blanked.
  const seq6 = (mark, socks) => TRACE6.slice(mark).filter(([w]) => socks.includes(w)).map(([w, f]) => socks.indexOf(w) + ':' + JSON.stringify(blank6(f)));
  const bare6 = (f) => (f ? JSON.stringify(blank6(f)) : null);

  // ---- (blk-a) the blocker LEADS: the blocked party leaves the squad -------
  {
    const { st, S, w, mark } = await world6(A, [B, C]);
    await S.handle(w[A], { type: 'block', op: 'add', id: B });
    const roster = last6(w[C], 'squad', 'state');
    if (roster && same6(ids6(roster), [A, C]) && got6(w[C], 'squad').length === 1)
      ok('(blk-a) block: the blocked member is out, and the rest of the squad is pushed ONE fresh roster');
    else fail('(blk-a) roster after the block: ' + JSON.stringify(w[C].rx));
    if (roster && roster.leader === A) ok('(blk-a) block: the leader is unchanged — a block never hands a squad on');
    else fail('(blk-a) leader after the block: ' + JSON.stringify(roster && roster.leader));
    // A KICK, TO THE PLAYER REMOVED (D-BLOCK): exactly squadKick's victim
    // frame, and nothing else on the squad channel.
    if (same6(got6(w[B], 'squad'), [{ type: 'squad', op: 'ended', reason: 'kicked' }])) ok('(blk-a) block: the removed player is sent exactly the frame a kick sends its victim, and nothing else');
    else fail('(blk-a) the removed player was told: ' + JSON.stringify(got6(w[B], 'squad')));
    if (last6(w[B], 'friends')) ok('(blk-a) and their socket WAS live: the friends snapshot handleBlock always pushes arrived on it');
    else fail('(blk-a) the removed player got no friends snapshot');
    // ORDER on the blocker: the roster, then its answer (members first,
    // actor last), then its friends snapshot.
    const kinds = w[A].rx.map((f) => f.type + (f.op ? ':' + f.op : ''));
    if (same6(kinds, ['squad:state', 'block:add', 'friends']))
      ok('(blk-a) the blocker is shown the new roster, then gets its answer, then its friends snapshot');
    else fail('(blk-a) frame order on the blocker: ' + JSON.stringify(kinds));
    if (st.blocks.has(A + '>' + B) && st.friends.size === 0)
      ok('(blk-a) and the shipped half is untouched: the block row stands and the friendship is gone');
    else fail('(blk-a) blocks ' + JSON.stringify([...st.blocks]) + ' friends ' + JSON.stringify([...st.friends]));
    // THE FRAMES OF A KICK AND AN UNFRIEND (D-BLOCK). A twin world where the
    // leader kicks B and then unfriends them: every frame B and the rest of
    // the squad receive, in the order sent across both, is the same frame,
    // byte for byte but for the code. No frame names the block; that is the
    // bar, and probing can still infer one (D-BLOCK-2 A, accepted).
    const t = await world6(A, [B, C]);
    await t.S.handle(t.w[A], { type: 'squad', op: 'kick', id: B });
    await t.S.handle(t.w[A], { type: 'friend', op: 'remove', id: B });
    const mine6 = seq6(mark, [w[B], w[C]]), twin6 = seq6(t.mark, [t.w[B], t.w[C]]);
    if (mine6.length === 3 && same6(mine6, twin6))
      ok('(blk-a) the blocked player and the rest of the squad receive exactly what a kick and an unfriend send them, in the same order');
    else fail('(blk-a) block vs kick+unfriend: ' + JSON.stringify({ block: mine6, kick: twin6 }));
  }

  // ---- (blk-b) the blocker does NOT lead: the blocker leaves ---------------
  {
    const { S, w, mark } = await world6(B, [A, C]);             // B LEADS
    await S.handle(w[A], { type: 'block', op: 'add', id: B });   // A blocks the LEADER
    const roster = last6(w[C], 'squad', 'state');
    if (same6(ids6(roster), [B, C]) && roster.leader === B)
      ok('(blk-b) block: when the blocker does not lead, the BLOCKER leaves and the squad keeps its leader');
    else fail('(blk-b) roster after blocking the leader: ' + JSON.stringify(roster));
    if (same6(got6(w[A], 'squad'), [{ type: 'squad', op: 'ended', reason: 'left' }]))
      ok('(blk-b) block: the blocker, who leaves, is told ended:left on the socket that held the row — a reason only a blocker sees');
    else fail('(blk-b) the blocker was pushed: ' + JSON.stringify(got6(w[A], 'squad')));
    if (same6(ans6(w[A], B), { type: 'block', op: 'add', ok: true, id: B })) ok('(blk-b) and the block itself answered ok');
    else fail('(blk-b) block reply: ' + JSON.stringify(w[A].rx));
    const t = await world6(B, [A, C]);
    await t.S.handle(t.w[A], { type: 'squad', op: 'leave' });
    if (same6(got6(w[B], 'squad').map(bare6), got6(t.w[B], 'squad').map(bare6)) && same6(got6(w[C], 'squad').map(bare6), got6(t.w[C], 'squad').map(bare6)))
      ok('(blk-b) and the leader who was blocked is shown exactly what a leave shows them');
    else fail('(blk-b) block vs leave: ' + JSON.stringify({ block: [w[B].rx, w[C].rx], leave: [t.w[B].rx, t.w[C].rx] }));
    // AND EVERYTHING ELSE THEY RECEIVE IS A LEAVE AND AN UNFRIEND, in order.
    const u = await world6(B, [A, C]);
    await u.S.handle(u.w[A], { type: 'squad', op: 'leave' });
    await u.S.handle(u.w[A], { type: 'friend', op: 'remove', id: B });
    const mine6 = seq6(mark, [w[B], w[C]]), twin6 = seq6(u.mark, [u.w[B], u.w[C]]);
    if (mine6.length === 3 && same6(mine6, twin6))
      ok('(blk-b) everything the blocked leader and the squad receive is exactly a leave and an unfriend, in the same order');
    else fail('(blk-b) block vs leave+unfriend: ' + JSON.stringify({ block: mine6, leave: twin6 }));
  }

  // ---- (blk-b2) neither leads: the blocker leaves, the leader stays --------
  {
    const { S, w } = await world6(C, [A, B]);                   // C LEADS
    await S.handle(w[A], { type: 'block', op: 'add', id: B });
    const roster = last6(w[C], 'squad', 'state');
    if (same6(ids6(roster), [C, B]) && roster.leader === C && same6(got6(w[A], 'squad'), [{ type: 'squad', op: 'ended', reason: 'left' }]))
      ok('(blk-b2) block between two members: the blocker leaves, told ended:left; the blocked member and the leader stay');
    else fail('(blk-b2) roster: ' + JSON.stringify(roster) + ' blocker got ' + JSON.stringify(got6(w[A], 'squad')));
  }

  // ---- (blk-c) two squads, no contact: neither is touched ------------------
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa = up6(S, A), wb = up6(S, B), wc = up6(S, C), wd = up6(S, D);
    const ca = await create6(S, wa);
    await join6(S, wc, ca, 'Crater Two');
    const cb = await create6(S, wb);
    await join6(S, wd, cb, 'Dune Four');
    clear6(wa, wb, wc, wd);
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    if (![wa, wb, wc, wd].some((w) => got6(w, 'squad').length))
      ok('(blk-c) block: with no squad in common neither roster moves and nobody is pushed one — each keeps the squad they lead');
    else fail('(blk-c) a roster moved: ' + JSON.stringify([wa, wb, wc, wd].map((w) => got6(w, 'squad'))));
    if ((last6(wa, 'block') || {}).ok === true && st.blocks.has(A + '>' + B)) ok('(blk-c) the block itself still landed');
    else fail('(blk-c) block: ' + JSON.stringify(last6(wa, 'block')) + ' ' + JSON.stringify([...st.blocks]));
  }

  // ---- (blk-d) a GUEST who blocks is torn out like anyone else --------------
  // A guest MAY block — the gate is requireAccount, deliberately: the player
  // who needs Block is often the one who never signed in — and a guest may
  // sit in a squad, by code. Left in it, the guest would be seated beside the
  // player they blocked on every Start. The guest does not lead (a guest
  // never can), so the guest goes. The leader's account id is on every
  // roster, which is how a guest names them.
  {
    const st = t6store(ROWS6);
    const S = mkSocial6(st);
    const wb = up6(S, B), wc = up6(S, C), wg = up6(S, GU, true);
    const code = await create6(S, wb);
    await join6(S, wg, code, 'Ghost'); await join6(S, wc, code, 'Crater Two');
    clear6(wb, wc, wg);
    await S.handle(wg, { type: 'block', op: 'add', id: B });
    if (same6(ans6(wg, B), { type: 'block', op: 'add', ok: true, id: B }) && st.blocks.has(GU + '>' + B))
      ok('(blk-d) a guest can block a squad-mate: the row is written and the answer is ok');
    else fail('(blk-d) guest block: ' + JSON.stringify(wg.rx) + ' ' + JSON.stringify([...st.blocks]));
    const roster = last6(wc, 'squad', 'state');
    if (same6(ids6(roster), [B, C]) && roster.leader === B && same6(ids6(last6(wb, 'squad', 'state')), [B, C]))
      ok('(blk-d) and the guest who blocked is out of the leader\'s squad; the rest are pushed the new roster');
    else fail('(blk-d) roster after a guest block: ' + JSON.stringify({ c: wc.rx, b: wb.rx }));
    if (same6(got6(wg, 'squad'), [{ type: 'squad', op: 'ended', reason: 'left' }])) ok('(blk-d) the guest who blocked, and so left, is told ended:left — as any blocker who leaves is');
    else fail('(blk-d) the guest was told: ' + JSON.stringify(got6(wg, 'squad')));
  }

  // ---- (blk-d2) the leader blocks a GUEST by the seat handle a lobby shows --
  // A guest row carries no account id on any frame, so the leader reaches a
  // guest the one way the product offers: Block on their lobby seat, by its
  // per-room handle, after a squad match. The block names the anonymous
  // account; the teardown has to find the seat that account is sitting in.
  {
    const HANDLES = new Map([['a1b2c3d4', GU]]);
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { resolveHandle: (ws, h) => HANDLES.get(h) || null });
    const wa = up6(S, A), wc = up6(S, C), wg = up6(S, GU, true);
    const code = await create6(S, wa);
    await join6(S, wg, code, 'Ghost'); await join6(S, wc, code, 'Crater Two');
    clear6(wa, wc, wg);
    await S.handle(wa, { type: 'block', op: 'add', handle: 'a1b2c3d4', id: 'b1' });
    if (same6(ans6(wa, 'b1'), { type: 'block', op: 'add', ok: true, id: 'b1' }) && st.blocks.has(A + '>' + GU))
      ok('(blk-d2) the leader blocks a guest by seat handle: the row names the anonymous account');
    else fail('(blk-d2) block by handle: ' + JSON.stringify(wa.rx) + ' ' + JSON.stringify([...st.blocks]));
    const roster = last6(wc, 'squad', 'state');
    if (same6(ids6(roster), [A, C]) && roster.leader === A)
      ok('(blk-d2) and the blocked guest is out of the leader\'s squad — a Start will not seat the two together again');
    else fail('(blk-d2) roster after blocking a guest: ' + JSON.stringify(wc.rx));
    if (same6(wg.rx, [{ type: 'squad', op: 'ended', reason: 'kicked' }]))
      ok('(blk-d2) and the guest is sent exactly what a kick sends its victim, and nothing else');
    else fail('(blk-d2) the guest was told: ' + JSON.stringify(wg.rx));
  }

  // ---- (blk-e) a half-failed block still empties the squad ----------------
  // handleBlock's own rule: the block row is the answer, and a failure AFTER
  // it lands is reported ok because the block is in force. The teardown has
  // to run on that path too, or the one case where the cleanup is already
  // half-done leaves the blocked party sitting in the blocker's box.
  {
    const { st, S, w } = await world6(A, [B, C]);
    st.boom.add('removeFriendship');                   // the write right after the block row
    await S.handle(w[A], { type: 'block', op: 'add', id: B });
    st.boom.delete('removeFriendship');
    if (same6(ans6(w[A], B), { type: 'block', op: 'add', ok: true, id: B })) ok('(blk-e) the block still answers ok — the row landed (the shipped rule)');
    else fail('(blk-e) half-failed block replied ' + JSON.stringify(w[A].rx));
    const roster = last6(w[C], 'squad', 'state');
    if (same6(ids6(roster), [A, C]))
      ok('(blk-e) and the squad teardown ran anyway: it hangs off the block row, not off the friendship delete');
    else fail('(blk-e) roster after a half-failed block: ' + JSON.stringify(roster));
  }

  // ---- (blk-f) a failing name read never becomes a second answer -----------
  // The block has been written and answered ok. The roster push reads names;
  // a throw out of it would reach handle()'s net and emit a second frame
  // saying the block failed — the bug safeSend and pushFriends were built
  // around. The names degrade to null and every row is kept.
  {
    const { st, S, w } = await world6(A, [B, C]);
    st.boom.add('profilesByIds');
    await S.handle(w[A], { type: 'block', op: 'add', id: B });
    st.boom.delete('profilesByIds');
    const blocks = got6(w[A], 'block');
    if (blocks.length === 1 && blocks[0].ok === true)
      ok('(blk-f) one answer, and it is the true one: a broken name read does not un-block anybody');
    else fail('(blk-f) block frames: ' + JSON.stringify(blocks));
    const roster = last6(w[C], 'squad', 'state');
    if (same6(ids6(roster), [A, C]) && roster.members.every((m) => m.callsign === null))
      ok('(blk-f) and the squad is still told: the same roster, its names null, every row kept');
    else fail('(blk-f) roster with a failed name read: ' + JSON.stringify(roster));
  }

  // ---- (blk-g) a second device, on either side of the block ----------------
  {
    // (i) THE BLOCKER DOES NOT LEAD, and blocks from a device that holds no
    // row. The row goes from device 1, which is told `ended: left` — the
    // blocker's own view of a block that made them leave.
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wb = up6(S, B), wa1 = up6(S, A), wc = up6(S, C);
    const code = await create6(S, wb);
    await join6(S, wa1, code); await join6(S, wc, code);
    const wa2 = up6(S, A);
    clear6(wa1, wa2, wb, wc);
    await S.handle(wa2, { type: 'block', op: 'add', id: B });
    if (same6(ids6(last6(wc, 'squad', 'state')), [B, C]) && same6(ids6(last6(wb, 'squad', 'state')), [B, C]))
      ok('(blk-g) the blocker\'s row leaves even when the block comes from their other device');
    else fail('(blk-g) roster after a second-device block: ' + JSON.stringify({ b: wb.rx, c: wc.rx }));
    if (same6(got6(wa1, 'squad'), [{ type: 'squad', op: 'ended', reason: 'left' }]) && got6(wa2, 'squad').length === 0)
      ok('(blk-g) the blocker\'s device that held the row is told ended:left, and the device that blocked, holding none, only its answer');
    else fail('(blk-g) blocker devices: ' + JSON.stringify({ a1: wa1.rx, a2: got6(wa2, 'squad') }));
    if (!got6(wb, 'squad', 'ended').length) ok('(blk-g) and the blocked leader is told nothing beyond the roster a leave would give them');
    else fail('(blk-g) the blocked party was told: ' + JSON.stringify(wb.rx));
  }
  {
    // (ii) THE BLOCKER LEADS, and blocks from a device that holds no row: the
    // blocked member goes, and the device holding the leader's row is shown
    // the new roster like the rest.
    const { S, w } = await world6(A, [B, C]);
    const wa2 = up6(S, A);
    await S.handle(wa2, { type: 'block', op: 'add', id: B });
    if (same6(ids6(last6(w[A], 'squad', 'state')), [A, C]) && same6(ids6(last6(w[C], 'squad', 'state')), [A, C]) && same6(got6(w[B], 'squad'), [{ type: 'squad', op: 'ended', reason: 'kicked' }]) && got6(wa2, 'squad').length === 0)
      ok('(blk-g) a leader blocking from their other device removes the blocked member; the rest see the roster, the blocked party a kick');
    else fail('(blk-g) leader second device: ' + JSON.stringify({ a1: w[A].rx, a2: wa2.rx, b: got6(w[B], 'squad'), c: w[C].rx }));
  }

  // ---- (blk-h) who leads is read off each squad, not off the socket --------
  // The TWO-SQUADS state (see claimOnSignIn): device 1 holds a guest row in
  // C's squad X and is signed in as A, while A LEADS squad Y, with B in it,
  // from device 2. A blocks B from device 1. The pair share Y, and A leads
  // it, so B goes. Asked through ledSquad — "which squad may THIS SOCKET
  // command" — device 1 leads nothing, the leader would be the one removed,
  // and a block would hand Y to the player just blocked.
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wc = up6(S, C);
    const X = await create6(S, wc);
    const wa2 = up6(S, A);
    const Y = await create6(S, wa2);
    const wb = up6(S, B);
    await join6(S, wb, Y, 'Bunker Nine');
    const wa1 = t6ws(null);
    await join6(S, wa1, X, 'Anvil');
    wa1.authGen = 1; wa1.userId = A; wa1.isGuest = false; S.onAuth(wa1);
    clear6(wa1, wa2, wb, wc);
    await S.handle(wa1, { type: 'block', op: 'add', id: B });
    const y = last6(wa2, 'squad', 'state');
    if (X !== Y && y && y.code === Y && same6(ids6(y), [A]) && y.leader === A)
      ok('(blk-h) the blocked player leaves the squad the blocker\'s ACCOUNT leads, though the block came from a socket in another squad');
    else fail('(blk-h) squad Y after the block: ' + JSON.stringify({ X, Y, a2: wa2.rx }));
    if (same6(got6(wb, 'squad'), [{ type: 'squad', op: 'ended', reason: 'kicked' }]) && got6(wc, 'squad').length === 0 && got6(wa1, 'squad').length === 0)
      ok('(blk-h) and nobody else moves: X is untouched, and the blocked player is told exactly a kick');
    else fail('(blk-h) other frames: ' + JSON.stringify({ b: got6(wb, 'squad'), c: got6(wc, 'squad'), a1: got6(wa1, 'squad') }));
  }

  // ---- (blk-i) lifting a block moves nothing, and says nothing -------------
  // A block row is written straight into the store UNDER a shared squad here
  // — a state no handler now produces (the teardown runs on add, and join and
  // invite refuse a blocked pair) — so the remove path is the only thing that
  // could move a roster.
  {
    const { st, S, w, code } = await world6(A, [B, C]);
    await st.addBlock(A, B);
    await S.handle(w[A], { type: 'block', op: 'remove', id: B });
    if (same6(ans6(w[A], B), { type: 'block', op: 'remove', ok: true, id: B }) && !st.blocks.size)
      ok('(blk-i) unblock answers ok and lifts the row');
    else fail('(blk-i) unblock: ' + JSON.stringify(w[A].rx));
    if (![A, B, C].some((id) => got6(w[id], 'squad').length))
      ok('(blk-i) and no squad frame goes to anyone — a block is silent coming off');
    else fail('(blk-i) squad frames on unblock: ' + JSON.stringify([A, B, C].map((id) => got6(w[id], 'squad'))));
    await S.handle(w[C], { type: 'squad', op: 'resume', code, id: 'rs' });
    if (same6(ids6(ans6(w[C], 'rs')), [A, B, C])) ok('(blk-i) and the squad is exactly as it was');
    else fail('(blk-i) squad after unblock: ' + JSON.stringify(ans6(w[C], 'rs')));
  }

  // ---- (blk-j) an answer that cannot be delivered does not undo the removal -
  // The removal happens BEFORE the reply. A half-closed socket whose send()
  // throws on the answer must not be what leaves the blocked party in the
  // blocker's squad: the block row is in force, and a Start would seat them.
  {
    const { st, S, w, code } = await world6(A, [B, C]);
    w[A].throwOn = (f) => f.type === 'block';
    await S.handle(w[A], { type: 'block', op: 'add', id: B });
    delete w[A].throwOn;
    const pushed6 = got6(w[C], 'squad', 'state').slice();
    await S.handle(w[C], { type: 'squad', op: 'resume', code, id: 'rs' });
    if (st.blocks.has(A + '>' + B) && same6(ids6(ans6(w[C], 'rs')), [A, C]))
      ok('(blk-j) a block whose answer could not be sent still takes the blocked party out of the squad');
    else fail('(blk-j) squad after an undeliverable answer: ' + JSON.stringify(ans6(w[C], 'rs')) + ' ' + JSON.stringify([...st.blocks]));
    // The telling runs before the answer as well, so the throw skips neither.
    if (same6(got6(w[B], 'squad'), [{ type: 'squad', op: 'ended', reason: 'kicked' }]) && pushed6.length === 1 && same6(ids6(pushed6[0]), [A, C]))
      ok('(blk-j) and the telling ran before the answer: the blocked party got its kick and the squad its roster');
    else fail('(blk-j) telling around an undeliverable answer: ' + JSON.stringify({ b: got6(w[B], 'squad'), c: pushed6 }));
  }


  // ---- (blk-k) a guest's squad found from the OTHER side -------------------
  // A guest has no presence, so a guest who blocks from one tab while their
  // guest row sits in another has no socket this layer can list: their
  // shared squad is found only from the BLOCKED account's side — its own row,
  // or a socket presence holds for it. Both routes, one case each.
  {
    // (i) through the blocked account's own row: B leads the squad the
    // guest's second tab is in.
    const st = t6store(ROWS6);
    const S = mkSocial6(st);
    const wb = up6(S, B), wc = up6(S, C);
    const code = await create6(S, wb);
    const wg2 = t6ws(GU, true); S.onAuth(wg2);
    await join6(S, wg2, code, 'Ghost'); await join6(S, wc, code, 'Crater Two');
    const wg1 = t6ws(GU, true); S.onAuth(wg1);                 // the tab that blocks
    clear6(wb, wc, wg1, wg2);
    await S.handle(wg1, { type: 'block', op: 'add', id: B });
    if (same6(ids6(last6(wc, 'squad', 'state')), [B, C]) && same6(got6(wg2, 'squad'), [{ type: 'squad', op: 'ended', reason: 'left' }]))
      ok('(blk-k) a guest blocking from one tab leaves the squad their other tab is in, and that tab is told ended:left');
    else fail('(blk-k) guest second tab: ' + JSON.stringify({ c: wc.rx, g2: wg2.rx }));
  }
  {
    // (ii) through a socket presence holds for the blocked account: B's
    // device 2 stands in C's squad on a guest row signed in as B (B leads a
    // squad of their own from device 1, so the row was left a guest row).
    const st = t6store(ROWS6);
    const S = mkSocial6(st);
    const wc = up6(S, C);
    const X = await create6(S, wc);
    const wb1 = up6(S, B);
    await create6(S, wb1);
    const wb2 = t6ws(null);
    await join6(S, wb2, X, 'Bunker');
    wb2.authGen = 1; wb2.userId = B; wb2.isGuest = false; S.onAuth(wb2);
    const wg2 = t6ws(GU, true); S.onAuth(wg2);
    await join6(S, wg2, X, 'Ghost');
    const wg1 = t6ws(GU, true); S.onAuth(wg1);
    clear6(wc, wb1, wb2, wg1, wg2);
    await S.handle(wg1, { type: 'block', op: 'add', id: B });
    const x = last6(wc, 'squad', 'state');
    if (x && x.members.length === 2 && x.members.every((m) => m.guest ? true : m.id === C) && same6(got6(wg2, 'squad'), [{ type: 'squad', op: 'ended', reason: 'left' }]) && got6(wb2, 'squad', 'ended').length === 0)
      ok('(blk-k) and when the blocked account is in that squad only through a socket, the guest still leaves it; the blocked player sees only a leave');
    else fail('(blk-k) through the blocked account\'s socket: ' + JSON.stringify({ c: wc.rx, g2: wg2.rx, b2: wb2.rx }));
  }

  {
    // (iii) through a socket presence holds for the BLOCKER: A's device 1
    // stands on a guest row in C's squad X (A leads Y from device 2), beside
    // an anonymous guest. A blocks the guest by seat handle from device 3.
    // The guest has no presence and no account row, so X is reachable only
    // through the blocker's own device 1. A does not lead X: A's row there
    // goes, device 1 is told ended:left, and the guest — who stays — is
    // shown the roster a leave would show them.
    const HANDLES = new Map([['e5f6a7b8', GU]]);
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { resolveHandle: (ws, h) => HANDLES.get(h) || null });
    const wc = up6(S, C);
    const X = await create6(S, wc);
    const wa2 = up6(S, A);
    await create6(S, wa2);
    const wa1 = t6ws(null);
    await join6(S, wa1, X, 'Anvil');
    wa1.authGen = 1; wa1.userId = A; wa1.isGuest = false; S.onAuth(wa1);
    const wg = t6ws(GU, true); S.onAuth(wg);
    await join6(S, wg, X, 'Ghost');
    const wa3 = up6(S, A);
    clear6(wc, wa1, wa2, wa3, wg);
    await S.handle(wa3, { type: 'block', op: 'add', handle: 'e5f6a7b8', id: 'b3' });
    const x = last6(wc, 'squad', 'state');
    if (x && same6(ids6(x), [C, null]) && same6(got6(wa1, 'squad'), [{ type: 'squad', op: 'ended', reason: 'left' }]) && same6(ids6(last6(wg, 'squad', 'state')), [C, null]) && got6(wg, 'squad', 'ended').length === 0)
      ok('(blk-k) and a squad the blocker is in only through another device is found through that device; the guest blocked sees only the roster a leave would show');
    else fail('(blk-k) through the blocker\'s own device: ' + JSON.stringify({ c: wc.rx, a1: wa1.rx, g: wg.rx }));
  }

  // ---- (blk-l) a teardown that throws never becomes a second answer --------
  // Everything in it is memory, but it runs outside handleBlock's try, BEFORE
  // the reply: a throw that escaped would reach handle()'s net and tell the
  // blocker `unavailable` for a block whose row has landed. The fault is a
  // squad member whose identity cannot be read.
  {
    const { st, S, w, code } = await world6(A, [B, C]);
    const odd = t6ws(null);
    await join6(S, odd, code, 'Odd');
    Object.defineProperty(odd, 'userId', { configurable: true, get() { throw new Error('unreadable'); } });
    clear6(w[A]);
    await S.handle(w[A], { type: 'block', op: 'add', id: B });
    Object.defineProperty(odd, 'userId', { configurable: true, writable: true, value: null });
    if (same6(got6(w[A], 'block'), [{ type: 'block', op: 'add', ok: true, id: B }]) && st.blocks.has(A + '>' + B))
      ok('(blk-l) a teardown that throws costs the teardown, never the answer: one block frame, and it is ok');
    else fail('(blk-l) block frames with a throwing teardown: ' + JSON.stringify(w[A].rx));
  }


  // ---- (blk-m) one squad's failure does not cost another squad's teardown --
  // The pair share squad Q through A's device 1 (a guest row there, signed in
  // as A), while A leads P from device 2 beside a member whose identity cannot
  // be read. P is searched first and throws; Q is still torn down and told.
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa2 = up6(S, A);
    const P = await create6(S, wa2);
    const odd = t6ws(null);
    await join6(S, odd, P, 'Odd');
    const wc = up6(S, C);
    const Q = await create6(S, wc);
    const wb = up6(S, B);
    await join6(S, wb, Q, 'Bunker Nine');
    const wa1 = t6ws(null);
    await join6(S, wa1, Q, 'Anvil');
    wa1.authGen = 1; wa1.userId = A; wa1.isGuest = false; S.onAuth(wa1);
    clear6(wa1, wa2, wb, wc);
    Object.defineProperty(odd, 'userId', { configurable: true, get() { throw new Error('unreadable'); } });
    await S.handle(wa1, { type: 'block', op: 'add', id: B });
    Object.defineProperty(odd, 'userId', { configurable: true, writable: true, value: null });
    const q = last6(wc, 'squad', 'state');
    if (P !== Q && q && q.code === Q && same6(ids6(q), [C, B]) && same6(got6(wa1, 'squad'), [{ type: 'squad', op: 'ended', reason: 'left' }]) && same6(got6(wa1, 'block'), [{ type: 'block', op: 'add', ok: true, id: B }]))
      ok('(blk-m) a squad whose teardown throws costs only itself: the other shared squad is still torn down and told');
    else fail('(blk-m) per-squad teardown: ' + JSON.stringify({ P, Q, c: wc.rx, a1: wa1.rx }));
  }

  // ---- (inv-m1) `already` is no oracle before the friend check -------------
  // Any member could otherwise aim an invite at any uuid and learn from
  // `already` that the account stands on a guest row in their squad. Before
  // the friend check only a row's own key counts; after it, the rest.
  {
    const st = t6store(ROWS6);
    const S = mkSocial6(st);
    const wa = up6(S, A);
    const code = await create6(S, wa);
    const wg = up6(S, GU, true);
    await join6(S, wg, code, 'Ghost');
    await S.handle(wa, { type: 'squad', op: 'invite', to: GU, id: 'o' });
    if (same6(ans6(wa, 'o'), { type: 'squad', op: 'invite', error: 'not_friend', id: 'o' }))
      ok('(inv-m1) a uuid standing on a guest row in the squad, and no friend, is answered not_friend — not already');
    else fail('(inv-m1) the already oracle: ' + JSON.stringify(ans6(wa, 'o')));
  }

  // ---- (inv-k iii) an invite is pinned to the squad it was asked for -------
  // A's second device, holding no row, invites for the squad A's account is
  // in. While the reads are out, device 1 creates a new squad. The invite
  // was asked for the old one, which A has left: no_squad, and nothing sent.
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa1 = up6(S, A), wb = up6(S, B);
    await create6(S, wa1);
    const wa2 = up6(S, A);
    clear6(wb); PUSHES.length = 0; DRY6.length = 0;
    const gate = st.hold('friendIdsOf');
    const pending = S.handle(wa2, { type: 'squad', op: 'invite', to: B, id: 'k3' });
    const inside = await within6(gate.inside);
    if (inside) await create6(S, wa1);
    gate.release(); await pending;
    if (inside && same6(ans6(wa2, 'k3'), { type: 'squad', op: 'invite', error: 'no_squad', id: 'k3' }) && !invited6(wb).length && PUSHES.length === 0 && DRY6.length === 0)
      ok('(inv-k) an account that moved squads while the reads were out invites to neither: no_squad');
    else fail('(inv-k) moved during the read: ' + JSON.stringify({ inside, answer: ans6(wa2, 'k3'), b: wb.rx, PUSHES, DRY6 }));
  }

  // ---- (inv-l) a block with ANOTHER member drops the invite, silently ------
  // D-BLOCK 4. A invites their friend B; C, in A's squad, and B have a block
  // row between them, either way. Nothing reaches B, by socket or by push,
  // nothing reaches C, and A is answered exactly what a delivered invite
  // would be: online if B holds a live socket, otherwise what the push seam
  // answers in its DRY-RUN form — here, where the seam says yes, push
  // (D-BLOCK-2 E, as the owner revised it). The dry run is the one seam call,
  // and it sends nothing.
  {
    const drops = [];
    pushAnswer = true;
    for (const dir of ['member blocked invitee', 'invitee blocked member']) {
      for (const online of [true, false]) {
        const st = t6store(ROWS6);
        await st.addFriendship(A, B);
        const S = mkSocial6(st);
        const wa = up6(S, A), wc = up6(S, C);
        const code = await create6(S, wa);
        await join6(S, wc, code, 'Crater Two');
        if (dir === 'member blocked invitee') await st.addBlock(C, B); else await st.addBlock(B, C);
        const wb = online ? up6(S, B) : t6ws(B);
        clear6(wa, wb, wc); PUSHES.length = 0; DRY6.length = 0;
        await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'q' });
        const want = { type: 'squad', op: 'invite', ok: true, delivered: online ? 'online' : 'push', id: 'q' };
        const dry = online ? [] : [[B, { code, from: 'Anvil Six', size: 2, max: 4 }]];
        if (!(same6(wa.rx, [want]) && !wb.rx.length && !wc.rx.length && PUSHES.length === 0 && same6(DRY6, dry))) drops.push({ dir, online, a: wa.rx, b: wb.rx, c: wc.rx, PUSHES: [...PUSHES], DRY6: [...DRY6] });
      }
    }
    if (!drops.length) ok('(inv-l) a block between the invitee and another member, either way, drops the invite: no frame, no push, and the answer a real invite gets — offline, from the seam\'s dry run');
    else fail('(inv-l) dropped invite: ' + JSON.stringify(drops));
    // THE SAME READS: a delivered, a dropped and a refused invite make the
    // same store calls, so what they cost in the store is the same.
    const reads = [];
    for (const kind of ['delivered', 'dropped', 'refused']) {
      const st = t6store(ROWS6);
      await st.addFriendship(A, B);
      const S = mkSocial6(st);
      const wa = up6(S, A), wc = up6(S, C);
      const code = await create6(S, wa);
      await join6(S, wc, code, 'Crater Two');
      if (kind === 'dropped') await st.addBlock(C, B);
      up6(S, B);
      st.calls.length = 0;
      await S.handle(wa, { type: 'squad', op: 'invite', to: kind === 'refused' ? D : B });
      reads.push(st.calls.slice().sort());
    }
    if (reads[0].length === 4 && same6(reads[0], reads[1]) && same6(reads[0], reads[2]))
      ok('(inv-l) a delivered, a dropped and a refused invite make exactly the same store reads');
    else fail('(inv-l) reads per invite: ' + JSON.stringify(reads));
  }

  // ===== D-BLOCK 3: A JOIN CANNOT PUT A BLOCKED PAIR BACK TOGETHER ==========
  // A block row, either way, between the joiner and ANY member refuses the
  // join in a dead code's exact words, and moves nothing.
  const DEAD6 = (id) => ({ type: 'squad', op: 'join', error: 'no_such_squad', id });
  // B leads a squad of their own with D in it, so a refused join can be seen
  // to leave it where it is; A leads the target, with C in it.
  const joinWorld6 = async () => {
    const st = t6store(ROWS6);
    const S = mkSocial6(st);
    const wa = up6(S, A), wc = up6(S, C), wb = up6(S, B), wd = up6(S, D);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    const home = await create6(S, wb);
    await join6(S, wd, home, 'Dune Four');
    clear6(wa, wb, wc, wd);
    return { st, S, wa, wb, wc, wd, code, home };
  };

  // ---- (jn-a) and (jn-b): the leader, or any other member, either way ------
  {
    const bad = [];
    for (const [who, x, y] of [['leader blocked joiner', A, B], ['joiner blocked leader', B, A], ['member blocked joiner', C, B], ['joiner blocked member', B, C]]) {
      const j = await joinWorld6();
      await j.st.addBlock(x, y);
      await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, name: 'Bunker Nine', skin: 'gold', id: 'j' });
      await j.S.handle(j.wb, { type: 'squad', op: 'join', code: '1111', name: 'Bunker Nine', skin: 'gold', id: 'z' });
      const refused = ans6(j.wb, 'j'), dead = ans6(j.wb, 'z');
      await j.S.handle(j.wb, { type: 'squad', op: 'resume', id: 'r' });
      const still = ans6(j.wb, 'r');
      if (!(same6(refused, DEAD6('j')) && same6(dead, DEAD6('z')) && still && still.code === j.home && same6(ids6(still), [B, D])
        && !j.wa.rx.length && !j.wc.rx.length && !j.wd.rx.length)) bad.push({ who, refused, dead, still, a: j.wa.rx, c: j.wc.rx, d: j.wd.rx });
    }
    if (!bad.length) ok('(jn-a) a block either way with the leader or any member refuses the join in a dead code\'s exact words, and nothing moves');
    else fail('(jn-a) blocked join: ' + JSON.stringify(bad));
  }

  // ---- (jn-c) a guest's anonymous account, on either side ------------------
  {
    const bad = [];
    {
      // The JOINER is a guest whom a member has blocked (by seat handle).
      const j = await joinWorld6();
      await j.st.addBlock(C, GU);
      const wg = up6(j.S, GU, true);
      await j.S.handle(wg, { type: 'squad', op: 'join', code: j.code, name: 'Ghost', skin: 'gold', id: 'g' });
      if (!same6(ans6(wg, 'g'), DEAD6('g')) || j.wc.rx.length) bad.push({ guestJoiner: ans6(wg, 'g'), c: j.wc.rx });
    }
    {
      // A MEMBER is a guest, and the joiner has blocked them.
      const j = await joinWorld6();
      const wg = up6(j.S, GU, true);
      await join6(j.S, wg, j.code, 'Ghost');
      await j.st.addBlock(B, GU);
      clear6(j.wa, j.wc, wg);
      await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, name: 'Bunker Nine', skin: 'gold', id: 'm' });
      if (!same6(ans6(j.wb, 'm'), DEAD6('m')) || wg.rx.length) bad.push({ guestMember: ans6(j.wb, 'm'), g: wg.rx });
    }
    {
      // CONTROL: a socket with no account joins, and nothing is read for it.
      const j = await joinWorld6();
      const wn = t6ws(null);
      j.st.calls.length = 0;
      await j.S.handle(wn, { type: 'squad', op: 'join', code: j.code, name: 'N', skin: 'olive', id: 'n' });
      if (!((ans6(wn, 'n') || {}).op === 'state' && !j.st.calls.includes('blockIdsOf'))) bad.push({ noAccount: ans6(wn, 'n'), calls: j.st.calls });
    }
    if (!bad.length) ok('(jn-c) a guest is matched by the anonymous account on its socket, as joiner and as member; a socket with no account reads nothing');
    else fail('(jn-c) guest joins: ' + JSON.stringify(bad));
  }

  // ---- (jn-d) the read runs for every join from an account, live or dead ---
  {
    const j = await joinWorld6();
    await j.st.addBlock(A, B);
    j.st.calls.length = 0;
    await j.S.handle(j.wb, { type: 'squad', op: 'join', code: '1111', id: 'z' });
    const dead = j.st.calls.slice();
    j.st.calls.length = 0;
    await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const refused = j.st.calls.slice();
    if (same6(dead, ['blockIdsOf']) && same6(refused, dead))
      ok('(jn-d) a join to a dead code reads the blocks too: the refusal costs exactly what a dead code does');
    else fail('(jn-d) reads: ' + JSON.stringify({ dead, refused }));
  }

  // ---- (jn-e) everything is decided on the world AFTER the read ------------
  {
    // (i) The socket becomes another account while the read is out.
    const j = await joinWorld6();
    const gate = j.st.hold('blockIdsOf');
    const pending = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const inside = await within6(gate.inside);
    j.wb.authGen = (j.wb.authGen || 0) + 1; j.S.onClose(j.wb); j.wb.userId = E; j.wb.isGuest = false; j.S.onAuth(j.wb);
    gate.release(); await pending;
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (inside && same6(ids6(ans6(j.wc, 'r')), [A, C]) && !ans6(j.wb, 'j'))
      ok('(jn-e) a socket that became another account during the read joins nothing');
    else fail('(jn-e) identity changed: ' + JSON.stringify({ inside, c: ans6(j.wc, 'r'), b: j.wb.rx }));
  }
  {
    // (ii) The socket closes while the read is out: no row may hold it.
    const j = await joinWorld6();
    const wn = up6(j.S, E);
    const gate = j.st.hold('blockIdsOf');
    const pending = j.S.handle(wn, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const inside = await within6(gate.inside);
    wn.readyState = 3; j.S.onClose(wn);
    gate.release(); await pending;
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (inside && same6(ids6(ans6(j.wc, 'r')), [A, C]))
      ok('(jn-e) a socket that closed during the read joins nothing — no row is left holding a dead socket');
    else fail('(jn-e) closed during the read: ' + JSON.stringify({ inside, c: ans6(j.wc, 'r') }));
  }
  {
    // (iii) A member B has blocked joins the target while B's read is out.
    const j = await joinWorld6();
    await j.st.addBlock(B, E);
    const we = up6(j.S, E);
    const gate = j.st.hold('blockIdsOf');
    const pending = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const inside = await within6(gate.inside);
    if (inside) await join6(j.S, we, j.code, 'Echo Seven');
    gate.release(); await pending;
    if (inside && same6(ans6(j.wb, 'j'), DEAD6('j')))
      ok('(jn-e) the members are those AFTER the read: one who arrived during it still refuses the join');
    else fail('(jn-e) member arrived during the read: ' + JSON.stringify({ inside, b: j.wb.rx }));
  }
  {
    // (iv) The account's row moves during the read, so the squad it leaves
    // is the one it is in NOW: B's second device joins A's squad while B's
    // first device starts a new squad and D joins it. D must be told B left.
    const j = await joinWorld6();
    const wb2 = up6(j.S, B);
    const gate = j.st.hold('blockIdsOf');
    const pending = j.S.handle(wb2, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const inside = await within6(gate.inside);
    let fresh = null;
    if (inside) { fresh = await create6(j.S, j.wb); await join6(j.S, j.wd, fresh, 'Dune Four'); }
    gate.release(); await pending;
    const d = last6(j.wd, 'squad', 'state');
    if (inside && (ans6(wb2, 'j') || {}).op === 'state' && d && d.code === fresh && same6(ids6(d), [D]))
      ok('(jn-e) the squad a join leaves is the one the account is in after the read, and it is told');
    else fail('(jn-e) row moved during the read: ' + JSON.stringify({ inside, fresh, b2: ans6(wb2, 'j'), d }));
  }


  // ---- (blk-n) the blocked player's other device sees exactly a kick's -----
  // A kick tells the row's socket and nobody else of that player, so the
  // block does too: B's second device, holding no row, gets what a kick and
  // an unfriend give it (the friends snapshot) and no squad frame.
  {
    const { S, w, mark } = await world6(A, [B, C]);
    const wb2 = up6(S, B);
    await S.handle(w[A], { type: 'block', op: 'add', id: B });
    const t = await world6(A, [B, C]);
    const tb2 = up6(t.S, B);
    await t.S.handle(t.w[A], { type: 'squad', op: 'kick', id: B });
    await t.S.handle(t.w[A], { type: 'friend', op: 'remove', id: B });
    const mine6 = seq6(mark, [w[B], wb2, w[C]]), twin6 = seq6(t.mark, [t.w[B], tb2, t.w[C]]);
    if (!got6(wb2, 'squad').length && same6(mine6, twin6))
      ok('(blk-n) the blocked player\'s other device gets what a kick and an unfriend give it, and no squad frame');
    else fail('(blk-n) other device: ' + JSON.stringify({ block: mine6, kick: twin6 }));
  }


  // ---- (blk-c2) a squad only the blocker is in is left alone ---------------
  // The blocker is a member (not the leader) of C's squad, which the blocked
  // player is not in: no shared squad, so the blocker stays where they are.
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wc = up6(S, C), wa = up6(S, A), wb = up6(S, B);
    const code = await create6(S, wc);
    await join6(S, wa, code, 'Anvil Six');
    clear6(wa, wb, wc);
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    await S.handle(wc, { type: 'squad', op: 'resume', id: 'r' });
    if (same6(ids6(ans6(wc, 'r')), [C, A]) && !got6(wa, 'squad').length && got6(wc, 'squad').length === 1)
      ok('(blk-c2) a blocker who is only a member of a squad the blocked player is not in stays in it, and nobody is told anything');
    else fail('(blk-c2) unshared squad: ' + JSON.stringify({ c: wc.rx, a: got6(wa, 'squad') }));
  }

  // ---- (inv-k iv) another account, in the SAME squad, by the time the reads land
  // A leads, D is a member (from D's own device). A's socket becomes D while
  // the invite's reads are out: A's row leaves, D now leads the same squad,
  // so the squad pin passes. The invite was A's, for A's friend, under A's
  // name: the socket that is D now must send nothing.
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa = up6(S, A), wb = up6(S, B), wd = up6(S, D);
    const code = await create6(S, wa);
    await join6(S, wd, code, 'Dune Four');
    clear6(wb); PUSHES.length = 0; DRY6.length = 0;
    const gate = st.hold('friendIdsOf');
    const pending = S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'k4' });
    const inside = await within6(gate.inside);
    wa.authGen = (wa.authGen || 0) + 1; S.onClose(wa); wa.userId = D; wa.isGuest = false; S.onAuth(wa);
    gate.release(); await pending;
    if (inside && !invited6(wb).length && PUSHES.length === 0 && DRY6.length === 0)
      ok('(inv-k) a socket that became a squad-mate during the reads invites nobody under the old account\'s name');
    else fail('(inv-k) same-squad identity change: ' + JSON.stringify({ inside, answer: ans6(wa, 'k4'), b: wb.rx, PUSHES, DRY6 }));
  }

  // ===== FIX PASS, WORKFLOW ROUND 1: D-BLOCK-2 ================================

  // ---- (inv-l ii) the drop is decided on the world AFTER the reads ---------
  // Four ways the drop could be asked of the wrong world, one case each: the
  // members as they were, the row keys only, presence as it was, and a drop
  // decided before the second look at the squad.
  {
    const bad = [];
    pushAnswer = true;
    {
      // (a) A member the invitee has a block with JOINS while the reads are
      // out: the drop reads the squad as it is now.
      const st = t6store(ROWS6);
      await st.addFriendship(A, B); await st.addBlock(C, B);
      const S = mkSocial6(st);
      const wa = up6(S, A), wb = up6(S, B), wc = up6(S, C);
      const code = await create6(S, wa);
      clear6(wa, wb); PUSHES.length = 0; DRY6.length = 0;
      const gate = st.hold('friendIdsOf');
      const pending = S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'a' });
      const inside = await within6(gate.inside);
      if (inside) await join6(S, wc, code, 'Crater Two');
      gate.release(); await pending;
      if (!(inside && same6(ans6(wa, 'a'), { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'a' }) && !invited6(wb).length && !PUSHES.length && !DRY6.length))
        bad.push({ joinedDuringReads: { inside, a: ans6(wa, 'a'), b: wb.rx } });
    }
    {
      // (b) The member is a GUEST, on the anonymous account the invitee has
      // blocked: matched through the row's socket, not only by row keys.
      const st = t6store(ROWS6);
      await st.addFriendship(A, B); await st.addBlock(B, GU);
      const S = mkSocial6(st);
      const wa = up6(S, A), wb = up6(S, B), wg = up6(S, GU, true);
      const code = await create6(S, wa);
      await join6(S, wg, code, 'Ghost');
      clear6(wa, wb, wg);
      await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'b' });
      if (!(same6(ans6(wa, 'b'), { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'b' }) && !invited6(wb).length))
        bad.push({ guestMember: { a: ans6(wa, 'b'), b: wb.rx } });
    }
    {
      // (c) The squad FILLS while the reads are out, with a blocked member in
      // it: full, as any invite to a full squad is. The drop comes after the
      // second look, never instead of it.
      const st = t6store(ROWS6);
      await st.addFriendship(A, B); await st.addBlock(C, B);
      const S = mkSocial6(st);
      const wa = up6(S, A), wb = up6(S, B), wc = up6(S, C);
      const code = await create6(S, wa);
      await join6(S, wc, code, 'Crater Two');
      clear6(wa, wb);
      const gate = st.hold('friendIdsOf');
      const pending = S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'c' });
      const inside = await within6(gate.inside);
      if (inside) for (const id of [D, E]) await join6(S, up6(S, id), code);
      gate.release(); await pending;
      if (!(inside && same6(ans6(wa, 'c'), { type: 'squad', op: 'invite', error: 'full', id: 'c' }) && !invited6(wb).length))
        bad.push({ filledDuringReads: { inside, a: ans6(wa, 'c') } });
    }
    {
      // (d) The invitee comes ONLINE while the reads are out: answered as a
      // real invite to them now would be — online — and nothing reaches them.
      const st = t6store(ROWS6);
      await st.addFriendship(A, B); await st.addBlock(C, B);
      const S = mkSocial6(st);
      const wa = up6(S, A), wc = up6(S, C);
      const code = await create6(S, wa);
      await join6(S, wc, code, 'Crater Two');
      clear6(wa); PUSHES.length = 0; DRY6.length = 0;
      const gate = st.hold('friendIdsOf');
      const pending = S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'd' });
      const inside = await within6(gate.inside);
      const wb = inside ? up6(S, B) : t6ws(B);
      gate.release(); await pending;
      if (!(inside && same6(ans6(wa, 'd'), { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'd' }) && !wb.rx.length && !PUSHES.length && !DRY6.length))
        bad.push({ cameOnline: { inside, a: ans6(wa, 'd'), b: wb.rx, PUSHES, DRY6 } });
    }
    if (!bad.length) ok('(inv-l) the drop is decided on the squad and the presence AFTER the reads, guest rows included, and after the second look');
    else fail('(inv-l) drop on a stale world: ' + JSON.stringify(bad));
  }

  // ---- (inv-l iii) offline, with a seam that takes time and says yes -------
  // A real invite to an offline friend and a dropped one each ask the seam
  // ONCE — the real one to send, the dropped one as a dry run — and neither
  // is answered before the seam is. So the two replies are byte-identical and
  // go out at the same point, and the dropped one sends nothing.
  {
    const run = async (answer) => {
      const SEAM = [];
      let open;
      const seamOpen = new Promise((r) => { open = r; });
      const worlds = [];
      for (const kind of ['real', 'dropped']) {
        const st = t6store(ROWS6);
        await st.addFriendship(A, B);
        if (kind === 'dropped') await st.addBlock(C, B);
        // The options as sent, with the abort signal (inv-o) recorded as
        // whether one was handed over — a signal has no JSON of its own.
        const S = mkSocial6(st, { pushInvite: async (to, payload, opts) => { SEAM.push([kind, to, blank6(payload), { ...opts, signal: !!opts && opts.signal instanceof AbortSignal }]); await seamOpen; return answer; } });
        const wa = up6(S, A), wc = up6(S, C);
        const code = await create6(S, wa);
        await join6(S, wc, code, 'Crater Two');
        clear6(wa, wc); st.calls.length = 0;
        worlds.push({ kind, st, wa, wc, pending: S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'q' }) });
      }
      await settle6();
      const early = worlds.map((x) => x.wa.rx.length);
      open();
      for (const x of worlds) await x.pending;
      return { SEAM, early, worlds };
    };
    const yes = await run(true);
    const [r, d] = yes.worlds;
    const reply = { type: 'squad', op: 'invite', ok: true, delivered: 'push', id: 'q' };
    const payload = { code: '-', from: 'Anvil Six', size: 2, max: 4 };
    if (same6(yes.early, [0, 0]) && same6(r.wa.rx, [reply]) && same6(d.wa.rx, [reply]))
      ok('(inv-l) offline: a real invite and a dropped one are both answered only once the seam has, and byte for byte alike (push)');
    else fail('(inv-l) offline replies: ' + JSON.stringify({ early: yes.early, real: r.wa.rx, dropped: d.wa.rx }));
    if (same6(yes.SEAM, [['real', B, payload, { dryRun: false, signal: true }], ['dropped', B, payload, { dryRun: true, signal: true }]]))
      ok('(inv-l) offline: the seam is asked once each, with the same payload — to send for the real invite, as a dry run for the dropped one');
    else fail('(inv-l) seam calls: ' + JSON.stringify(yes.SEAM));
    if (same6(r.st.calls.slice().sort(), d.st.calls.slice().sort()) && !d.wc.rx.length)
      ok('(inv-l) offline: the two make the same store reads, and the member the invitee blocked is told nothing');
    else fail('(inv-l) offline reads: ' + JSON.stringify({ real: r.st.calls, dropped: d.st.calls, c: d.wc.rx }));
    const no = await run(false);
    const none = { type: 'squad', op: 'invite', ok: true, delivered: 'none', id: 'q' };
    if (same6(no.worlds[0].wa.rx, [none]) && same6(no.worlds[1].wa.rx, [none]))
      ok('(inv-l) offline: a seam with no device to reach answers none for both');
    else fail('(inv-l) seam false: ' + JSON.stringify(no.worlds.map((x) => x.wa.rx)));
  }

  // ---- (inv-n) a seam that never answers cannot hold the socket's queue ----
  // The seam is awaited inside the inviter's one-frame-at-a-time social
  // queue, and a block waits in it. Past INVITE_PUSH_MS the invite is none,
  // real or dropped alike, and the block behind it is answered.
  {
    const prev = process.env.SQUAD_INVITE_PUSH_MS;
    process.env.SQUAD_INVITE_PUSH_MS = '30';
    const bad = [];
    for (const kind of ['real', 'dropped']) {
      const st = t6store(ROWS6);
      await st.addFriendship(A, B);
      if (kind === 'dropped') await st.addBlock(C, B);
      const S = mkSocial6(st, { pushInvite: () => new Promise(() => {}) });
      const wa = up6(S, A), wc = up6(S, C);
      const code = await create6(S, wa);
      await join6(S, wc, code, 'Crater Two');
      clear6(wa);
      S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'q' });
      S.handle(wa, { type: 'block', op: 'add', id: E });
      const done = await until6(() => ans6(wa, 'q') && ans6(wa, E));
      if (!(done && same6(ans6(wa, 'q'), { type: 'squad', op: 'invite', ok: true, delivered: 'none', id: 'q' }) && same6(ans6(wa, E), { type: 'block', op: 'add', ok: true, id: E })))
        bad.push({ kind, rx: wa.rx });
    }
    if (prev === undefined) delete process.env.SQUAD_INVITE_PUSH_MS; else process.env.SQUAD_INVITE_PUSH_MS = prev;
    if (!bad.length) ok('(inv-n) a push seam that never answers is none after its bound, real or dropped, and the block queued behind it is answered');
    else fail('(inv-n) a hung seam: ' + JSON.stringify(bad));
  }

  // ---- (blk-o) D-BLOCK 5: the row a block removes was DROPPED at the time ---
  // No frame can reach a socket that is gone, and a later resume answers
  // exactly `gone` — what a kick while dropped leaves behind. Twin worlds.
  {
    // (i) The blocker LEADS, and the blocked member's socket is down. B's
    // second device, holding no row, is live throughout.
    const run = async (act) => {
      const { S, w, code } = await world6(A, [B, C]);
      const wb2 = up6(S, B);
      w[B].readyState = 3; S.onClose(w[B]);
      await settle6();
      clear6(w[A], w[C], wb2);
      const m = TRACE6.length;
      await act(S, w);
      const seq = seq6(m, [w[B], wb2, w[C]]);
      const wb3 = up6(S, B);
      await S.handle(wb3, { type: 'squad', op: 'resume', code, id: 'rs' });
      await S.handle(w[C], { type: 'squad', op: 'resume', id: 'rc' });
      return { wb2, seq, gone: ans6(wb3, 'rs'), roster: ans6(w[C], 'rc') };
    };
    const blk = await run((S, w) => S.handle(w[A], { type: 'block', op: 'add', id: B }));
    const kick = await run(async (S, w) => { await S.handle(w[A], { type: 'squad', op: 'kick', id: B }); await S.handle(w[A], { type: 'friend', op: 'remove', id: B }); });
    if (same6(ids6(blk.roster), [A, C]) && same6(blk.gone, { type: 'squad', op: 'gone', id: 'rs' }) && !got6(blk.wb2, 'squad').length)
      ok('(blk-o) the leader blocks a member whose socket is down: the dropped row goes, no squad frame reaches any of their sockets, and a resume answers exactly gone');
    else fail('(blk-o) blocked while dropped: ' + JSON.stringify({ roster: blk.roster, gone: blk.gone, b2: blk.wb2.rx }));
    if (same6(blk.seq, kick.seq) && same6(blk.gone, kick.gone))
      ok('(blk-o) and every frame the blocked player and the squad receive, and the gone, are a kick-while-dropped\'s and an unfriend\'s');
    else fail('(blk-o) block vs kick while dropped: ' + JSON.stringify({ block: blk.seq, kick: kick.seq }));
  }
  {
    // (ii) The blocker does NOT lead, their own row is dropped, and they block
    // from a second device holding none.
    const run = async (act) => {
      const { S, w, code } = await world6(B, [A, C]);
      w[A].readyState = 3; S.onClose(w[A]);
      await settle6();
      const wa2 = up6(S, A);
      clear6(w[B], w[C], wa2);
      const m = TRACE6.length;
      await act(S, wa2);
      const seq = seq6(m, [w[B], w[C]]);
      const wa3 = up6(S, A);
      await S.handle(wa3, { type: 'squad', op: 'resume', code, id: 'rs' });
      await S.handle(w[C], { type: 'squad', op: 'resume', id: 'rc' });
      return { wa2, seq, gone: ans6(wa3, 'rs'), roster: ans6(w[C], 'rc') };
    };
    const blk = await run((S, wa2) => S.handle(wa2, { type: 'block', op: 'add', id: B }));
    const leave = await run(async (S, wa2) => { await S.handle(wa2, { type: 'squad', op: 'leave' }); await S.handle(wa2, { type: 'friend', op: 'remove', id: B }); });
    if (same6(ids6(blk.roster), [B, C]) && blk.roster.leader === B && same6(blk.gone, { type: 'squad', op: 'gone', id: 'rs' }) && !got6(blk.wa2, 'squad').length)
      ok('(blk-o) a blocker whose own row is dropped, blocking from another device, loses that row; the device is told nothing on the squad channel, and a resume answers gone');
    else fail('(blk-o) blocker dropped: ' + JSON.stringify({ roster: blk.roster, gone: blk.gone, a2: got6(blk.wa2, 'squad') }));
    if (same6(blk.seq, leave.seq))
      ok('(blk-o) and the blocked leader and the squad receive exactly a leave\'s and an unfriend\'s frames');
    else fail('(blk-o) block vs leave while dropped: ' + JSON.stringify({ block: blk.seq, leave: leave.seq }));
  }

  // ---- (blk-p) the blocker is the account that ASKED (D-BLOCK-2 D) ---------
  {
    // (i) The blocking device signs out while the block's writes are out. The
    // block is the account's, and so is the squad it tears down, whose row
    // sits on the account's other device.
    const { st, S, w } = await world6(A, [B, C]);
    const wa2 = up6(S, A);
    const gate = st.hold('removeFriendship');
    const pending = S.handle(wa2, { type: 'block', op: 'add', id: B });
    const inside = await within6(gate.inside);
    wa2.authGen = (wa2.authGen || 0) + 1; S.onClose(wa2); wa2.userId = null; wa2.isGuest = false;
    gate.release(); await pending;
    await S.handle(w[C], { type: 'squad', op: 'resume', id: 'rc' });
    if (inside && same6(ids6(ans6(w[C], 'rc')), [A, C]) && same6(got6(w[B], 'squad'), [{ type: 'squad', op: 'ended', reason: 'kicked' }]) && st.blocks.has(A + '>' + B))
      ok('(blk-p) a block whose device signs out mid-way still takes the blocked player out of the account\'s squad');
    else fail('(blk-p) sign-out mid-block: ' + JSON.stringify({ inside, c: ans6(w[C], 'rc'), b: got6(w[B], 'squad'), blocks: [...st.blocks] }));
  }
  {
    // (ii) The blocking socket says hello as ANOTHER account, D, mid-way. D
    // leads a squad with B in it and blocked nobody: D's squad is not
    // touched, D's requests are not deleted, and D is pushed nothing.
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    await st.addRequest(A, B); await st.addRequest(B, D);
    const S = mkSocial6(st);
    const wd = up6(S, D), wb = up6(S, B);
    const Z = await create6(S, wd);
    await join6(S, wb, Z, 'Bunker Nine');
    const wx = up6(S, A);
    clear6(wd, wb, wx);
    const gate = st.hold('removeFriendship');
    const pending = S.handle(wx, { type: 'block', op: 'add', id: B });
    const inside = await within6(gate.inside);
    hello6(S, wx, D);
    gate.release(); await pending;
    const told = { d: got6(wd, 'friends').length, b: got6(wb, 'squad') };
    await S.handle(wd, { type: 'squad', op: 'resume', id: 'rz' });
    if (inside && same6(ids6(ans6(wd, 'rz')), [D, B]) && !told.b.length && !told.d
      && same6([...st.blocks], [A + '>' + B]) && same6([...st.requests], [B + '>' + D]))
      ok('(blk-p) a socket that becomes another account mid-block blocks for the account that asked: the other account\'s squad, requests and panels are untouched');
    else fail('(blk-p) hello mid-block: ' + JSON.stringify({ inside, z: ans6(wd, 'rz'), told, blocks: [...st.blocks], requests: [...st.requests] }));
  }

  // ===== D-BLOCK-3 G: THE RECENT-BLOCKS LOG (replaced D-BLOCK-2 C's epoch) =====
  // ---- (jn-e v) a block that lands while the join's read is out -----------
  {
    // The read was answered BEFORE the block landed and arrives AFTER it. The
    // blocker's teardown ran while B was not in the squad yet and found
    // nothing, so the join has to notice by itself.
    const j = await joinWorld6();
    const h = stale6(j.st, 'blockIdsOf');
    const pending = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const inside = await within6(h.inside);
    if (inside) await j.S.handle(j.wa, { type: 'block', op: 'add', id: B });
    h.release(); await pending;
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r' });
    await j.S.handle(j.wb, { type: 'squad', op: 'resume', id: 'rb' });
    if (inside && same6(ans6(j.wb, 'j'), DEAD6('j')) && same6(ids6(ans6(j.wc, 'r')), [A, C]) && same6(ids6(ans6(j.wb, 'rb')), [B, D]))
      ok('(jn-e) a block landing while the join\'s read is out is added to it from the log: refused as a dead code, and the pair is never co-members');
    else fail('(jn-e) block during the read: ' + JSON.stringify({ inside, b: ans6(j.wb, 'j'), c: ans6(j.wc, 'r'), home: ans6(j.wb, 'rb') }));
  }
  {
    // (v, b) THE BLOCK IS LOGGED THE MOMENT THE ROW LANDS, before the rest of the
    // block: the join's stale read comes back while the blocker's friendship
    // delete is still out, and is still refused — never joined and then
    // kicked by the teardown a moment later.
    const j = await joinWorld6();
    const h = stale6(j.st, 'blockIdsOf');
    const pj = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const in1 = await within6(h.inside);
    const g = j.st.hold('removeFriendship');
    const pb = j.S.handle(j.wa, { type: 'block', op: 'add', id: B });
    const in2 = await within6(g.inside);
    h.release(); await pj;
    const answer = ans6(j.wb, 'j');
    g.release(); await pb;
    if (in1 && in2 && same6(answer, DEAD6('j')) && !got6(j.wb, 'squad', 'state').some((f) => f.code === j.code))
      ok('(jn-e) the block is logged as its row lands, before the teardown: the join is refused, never admitted and then kicked');
    else fail('(jn-e) log placement: ' + JSON.stringify({ in1, in2, answer, b: j.wb.rx }));
  }

  // ---- (jn-e vi) the blocks a read adds are the JOINER's, from the log -----
  // D-BLOCK-3 G. Every block below NAMES B, the joiner, and lands while B's
  // read (answered before any of them) is out. Pairs with players outside
  // the squad let B in; one with a member refuses. The log keeps an entry
  // 16 s (BLOCK_LOG_MS): a read whose entries were dropped meanwhile reads
  // once more, and a second miss refuses the join as a dead code.
  //
  // `outs6` — sockets of E, NN and GU, in neither squad — land blocks naming
  // B. `age6` moves the clock past the log's 16 s and lands one more block,
  // which drops every older entry. `after6` counts the store's reads of
  // `id`'s blocks from the moment it is armed: armed once the blocks (whose
  // friends pushes read B's blocks too) have landed, it counts re-reads.
  const outs6 = (S) => ({ e: up6(S, E), n: up6(S, NN), g: up6(S, GU, true) });
  const blk6 = (S, w, id) => S.handle(w, { type: 'block', op: 'add', id });
  const age6 = async (S, w, id) => { CLOCK6 += 16001; await blk6(S, w, id); };
  const after6 = (st, id) => {
    const real = st.blockIdsOf, n = { c: 0 };
    st.blockIdsOf = async function (x, ...r) { if (x === id) n.c++; return real.call(st, x, ...r); };
    return n;
  };
  {
    // (a) Blocks naming B with players outside the squad: B joins, no re-read.
    // (b) The same, and C (a member) blocks B too: refused.
    const run = async (member) => {
      const j = await joinWorld6();
      const o = outs6(j.S);
      const h = stale6(j.st, 'blockIdsOf');
      const pending = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
      const inside = await within6(h.inside);
      if (inside) {
        await blk6(j.S, o.e, B); await blk6(j.S, o.n, B);
        if (member) await blk6(j.S, j.wc, B);
      } else h.restore();
      const n = after6(j.st, B);
      h.release(); await pending;
      return { inside, rereads: n.c, answer: ans6(j.wb, 'j'), code: j.code };
    };
    const out = await run(false), mem = await run(true);
    if (out.inside && out.rereads === 0 && out.answer && out.answer.op === 'state' && out.answer.code === out.code
      && mem.inside && same6(mem.answer, DEAD6('j')))
      ok('(jn-e) blocks naming the joiner that land during its read are added to it: outsiders let it in on the one read, a member refuses it');
    else fail('(jn-e) blocks naming the joiner: ' + JSON.stringify({ out, mem }));
  }
  {
    // (c) THE LOG DROPPED THE READ'S ENTRIES: one more read. Dropped again
    // during that one: refused as a dead code, and no third read. Kept that
    // time: B joins.
    const run = async (twice) => {
      const j = await joinWorld6();
      const o = outs6(j.S);
      const h = stale6(j.st, 'blockIdsOf');
      const pending = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
      let inside = await within6(h.inside), again = null, n = null;
      if (inside) {
        await blk6(j.S, o.e, B); await age6(j.S, o.n, B);
        if (twice) again = staleFor6(j.st, 'blockIdsOf', B);
      } else h.restore();
      if (!again) n = after6(j.st, B);
      h.release();
      if (again) {
        inside = inside && await within6(again.inside);
        if (inside) { await blk6(j.S, o.e, B); await age6(j.S, o.n, B); } else again.restore();
        n = after6(j.st, B);
        again.release();
      }
      await pending;
      return { inside, more: n.c, answer: ans6(j.wb, 'j'), code: j.code };
    };
    const twice = await run(true), once = await run(false);
    if (twice.inside && twice.more === 0 && same6(twice.answer, DEAD6('j')))
      ok('(jn-e) a join whose read, and its one re-read, each lost log entries is refused as a dead code');
    else fail('(jn-e) two dropped reads: ' + JSON.stringify(twice));
    if (once.inside && once.more === 1 && once.answer && once.answer.op === 'state' && once.answer.code === once.code)
      ok('(jn-e) and one that lost them once reads again and joins');
    else fail('(jn-e) one dropped read: ' + JSON.stringify(once));
  }

  // ===== D-BLOCK-2 B: THE SIGN-IN DOOR =========================================
  // A leads X with C in it. B's socket stands in X on a row it took WITHOUT
  // B's account — before saying hello, or as a throwaway anonymous account —
  // so no join ever read B's blocks. Then it signs in as B.
  const signWorld6 = async (row) => {
    const st = t6store(ROWS6);
    if (row) await st.addBlock(row[0], row[1]);
    const S = mkSocial6(st);
    const wa = up6(S, A), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    return { st, S, wa, wc, code };
  };
  const KICKED6 = { type: 'squad', op: 'ended', reason: 'kicked' };
  const lastSquad6 = (w) => { const f = got6(w, 'squad'); return f[f.length - 1] || null; };

  // ---- (sg-a) no hello, a join, then a sign-in: checked before it is claimed -
  {
    const bad = [];
    for (const row of [[A, B], [B, A], [C, B], [B, C]]) {
      const g = await signWorld6(row);
      const wn = t6ws(null);
      await join6(g.S, wn, g.code, 'Bunker');
      clear6(g.wa, g.wc, wn);
      hello6(g.S, wn, B);
      await settle6();
      await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
      const roster = ans6(g.wc, 'r');
      if (!(same6(lastSquad6(wn), KICKED6) && same6(ids6(roster), [A, C]) && roster.leader === A)) bad.push({ row, b: wn.rx, roster });
    }
    if (!bad.length) ok('(sg-a) a row taken with no account and then signed in as a blocked account goes, either way, leader or member: the socket is told exactly a kick');
    else fail('(sg-a) sign-in after a hello-less join: ' + JSON.stringify(bad));
    // EXACTLY A KICK OF THE NAMELESS ROW (D-BLOCK-3 F): the door reads before
    // anything is claimed, so the squad never sees B's name. The twin: the
    // same row, never signed in, kicked by A by its index.
    const g = await signWorld6([A, B]);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    const m = TRACE6.length;
    hello6(g.S, wn, B);
    await settle6();
    const t = await signWorld6(null);
    const tn = t6ws(null);
    await join6(t.S, tn, t.code, 'Bunker');
    const tm = TRACE6.length;
    await t.S.handle(t.wa, { type: 'squad', op: 'kick', i: 2 });
    const mine = seq6(m, [wn, g.wc]), twin = seq6(tm, [tn, t.wc]);
    if (mine.length === 2 && same6(mine, twin))
      ok('(sg-a) and what the signed-in player and the squad receive is exactly a kick of the row as it stood, nameless, in the same order');
    else fail('(sg-a) sign-in door vs kick: ' + JSON.stringify({ door: mine, kick: twin }));
  }
  {
    // CONTROLS: with no block the adopted row stays, shown by its proved
    // name, for one read; and a socket that holds no row reads nothing.
    const g = await signWorld6(null);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    g.st.calls.length = 0;
    hello6(g.S, wn, B);
    await settle6();
    const reads = g.st.calls.filter((c) => c === 'blockIdsOf').length;
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    const roster = ans6(g.wc, 'r');
    const idle = await signWorld6([A, B]);
    const wz = t6ws(null);
    idle.st.calls.length = 0;
    hello6(idle.S, wz, B);
    await settle6();
    if (reads === 1 && same6(ids6(roster), [A, C, B]) && roster.members[2].callsign === 'Bunker Nine' && !got6(wn, 'squad', 'ended').length && !idle.st.calls.includes('blockIdsOf'))
      ok('(sg-a) with no block the signed-in row stays, by name, for one read; a socket holding no row reads nothing');
    else fail('(sg-a) controls: ' + JSON.stringify({ reads, roster, b: wn.rx, idle: idle.st.calls }));
  }

  // ---- (sg-b) a throwaway anonymous account first, then the real one -------
  {
    const bad = [];
    for (const row of [[A, B], [B, A]]) {
      const g = await signWorld6(row);
      const wg = up6(g.S, GU, true);
      await join6(g.S, wg, g.code, 'Ghost');
      clear6(g.wa, g.wc, wg);
      hello6(g.S, wg, B);
      await settle6();
      await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
      if (!(same6(lastSquad6(wg), KICKED6) && same6(ids6(ans6(g.wc, 'r')), [A, C]))) bad.push({ row, g: wg.rx, roster: ans6(g.wc, 'r') });
    }
    {
      // THE ANONYMOUS ACCOUNT IS THE ONE BLOCKED: A blocked the guest's
      // account by seat handle, and its socket joined before saying hello.
      const g = await signWorld6([A, GU]);
      const wn = t6ws(null);
      await join6(g.S, wn, g.code, 'Ghost');
      clear6(g.wa, g.wc, wn);
      hello6(g.S, wn, GU, true);
      await settle6();
      await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
      if (!(same6(lastSquad6(wn), KICKED6) && same6(ids6(ans6(g.wc, 'r')), [A, C]))) bad.push({ anonymous: wn.rx, roster: ans6(g.wc, 'r') });
    }
    {
      // THE OTHER MEMBER IS THE GUEST: B blocked an anonymous account whose
      // guest row stands in X. Matched through that row's socket.
      const g = await signWorld6([B, GU]);
      const wg = up6(g.S, GU, true);
      await join6(g.S, wg, g.code, 'Ghost');
      const wn = t6ws(null);
      await join6(g.S, wn, g.code, 'Bunker');
      clear6(g.wa, g.wc, wg, wn);
      hello6(g.S, wn, B);
      await settle6();
      await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
      if (!(same6(lastSquad6(wn), KICKED6) && same6(ids6(ans6(g.wc, 'r')), [A, C, null]))) bad.push({ guestMember: wn.rx, roster: ans6(g.wc, 'r') });
    }
    if (!bad.length) ok('(sg-b) a row taken as an anonymous account and then signed in as a blocked one goes, either way; so does one whose own anonymous account is blocked, and one beside a guest it has blocked');
    else fail('(sg-b) sign-in after an anonymous join: ' + JSON.stringify(bad));
  }

  // ---- (sg-c) the account is in ANOTHER squad: the row stays a guest row ---
  {
    const bad = [];
    for (const row of [[A, B], [B, A]]) {
      const g = await signWorld6(row);
      const wb1 = up6(g.S, B);
      const Y = await create6(g.S, wb1);
      const wn = t6ws(null);
      await join6(g.S, wn, g.code, 'Bunker');
      clear6(g.wa, g.wc, wn, wb1);
      hello6(g.S, wn, B);
      await settle6();
      await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
      await g.S.handle(wb1, { type: 'squad', op: 'resume', id: 'ry' });
      const y = ans6(wb1, 'ry');
      if (!(same6(lastSquad6(wn), KICKED6) && same6(ids6(ans6(g.wc, 'r')), [A, C]) && y && y.code === Y && same6(ids6(y), [B]))) bad.push({ row, b2: wn.rx, x: ans6(g.wc, 'r'), y });
    }
    if (!bad.length) ok('(sg-c) a guest row left standing because the account leads elsewhere goes too, either way; the account\'s own squad is untouched');
    else fail('(sg-c) sign-in, account in another squad: ' + JSON.stringify(bad));
  }

  // ---- (sg-d) the cancel is the account, not the socket's state ------------
  {
    // (i) The socket becomes ANOTHER account while B's read is out. E leads a
    // squad elsewhere, so the row stays a guest row — standing for E now,
    // who blocked nobody. B's check must not remove it.
    const g = await signWorld6([A, B]);
    const wb1 = up6(g.S, B); await create6(g.S, wb1);
    const we1 = up6(g.S, E); await create6(g.S, we1);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'N');
    clear6(g.wa, g.wc, wn);
    const gate = g.st.hold('blockIdsOf');
    hello6(g.S, wn, B);
    const inside = await within6(gate.inside);
    hello6(g.S, wn, E);
    gate.release();
    await settle6();
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (inside && !got6(wn, 'squad', 'ended').length && same6(ids6(ans6(g.wc, 'r')), [A, C, null]))
      ok('(sg-d) a check whose socket became another account during the read removes nothing — that account\'s own hello decides');
    else fail('(sg-d) identity changed during the check: ' + JSON.stringify({ inside, n: wn.rx, x: ans6(g.wc, 'r') }));
  }
  {
    // (ii) The socket CLOSES while the read is out. The adopted row is
    // dropped but still stands for B, so it goes, with no frame, and a
    // resume answers gone (D-BLOCK 5).
    const g = await signWorld6([A, B]);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    const gate = g.st.hold('blockIdsOf');
    hello6(g.S, wn, B);
    const inside = await within6(gate.inside);
    wn.readyState = 3; g.S.onClose(wn);
    gate.release();
    await settle6();
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    const wb = up6(g.S, B);
    await g.S.handle(wb, { type: 'squad', op: 'resume', code: g.code, id: 'rb' });
    if (inside && same6(ids6(ans6(g.wc, 'r')), [A, C]) && same6(ans6(wb, 'rb'), { type: 'squad', op: 'gone', id: 'rb' }))
      ok('(sg-d) a socket that closes during the check is no cancel: its dropped row goes, and a resume answers gone');
    else fail('(sg-d) closed during the check: ' + JSON.stringify({ inside, x: ans6(g.wc, 'r'), b: ans6(wb, 'rb') }));
  }

  // ---- (sg-e) the log, a dropped read and a failed read at the sign-in door --
  // Whether any squad frame `w` was sent shows account `id` on a row.
  const shows6 = (w, id) => got6(w, 'squad').some((f) => Array.isArray(f.members) && f.members.some((m) => m.id === id));
  {
    // (i) A leads and blocks B while B's door read — answered before the
    // block — is out, and the read lands while that block's teardown is
    // still to run (its removeFriendship held). The log adds the block: the
    // row goes as a kick, still nameless, and B's name never reaches A or C.
    const g = await signWorld6(null);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    clear6(g.wa, g.wc, wn);
    const h = stale6(g.st, 'blockIdsOf');
    hello6(g.S, wn, B);
    const inside = await within6(h.inside);
    let in2 = false, pb = null, gate = null;
    if (inside) {
      gate = g.st.hold('removeFriendship');
      pb = g.S.handle(g.wa, { type: 'block', op: 'add', id: B });
      in2 = await within6(gate.inside);
    } else h.restore();
    h.release();
    await settle6();
    if (gate) gate.release();
    if (pb) await pb;
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (inside && in2 && same6(got6(wn, 'squad'), [KICKED6]) && same6(ids6(ans6(g.wc, 'r')), [A, C]) && !shows6(g.wa, B) && !shows6(g.wc, B))
      ok('(sg-e) a block naming the account that lands while the door reads is added from the log: the row goes as a kick, and its name never reached the squad');
    else fail('(sg-e) block during the door\'s read: ' + JSON.stringify({ inside, in2, n: got6(wn, 'squad'), x: ans6(g.wc, 'r'), a: shows6(g.wa, B), c: shows6(g.wc, B) }));
  }
  {
    // (i, b) The socket CLOSES during the read, so the teardown of A's block
    // cannot see the row at all (a dropped guest row stands for nobody). The
    // log is what finds it: the row goes, and B's resume answers gone.
    const g = await signWorld6(null);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    const h = stale6(g.st, 'blockIdsOf');
    hello6(g.S, wn, B);
    const inside = await within6(h.inside);
    if (inside) {
      wn.readyState = 3; g.S.onClose(wn);
      await g.S.handle(g.wa, { type: 'block', op: 'add', id: B });
    } else h.restore();
    h.release();
    await settle6();
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    const wb = up6(g.S, B);
    await g.S.handle(wb, { type: 'squad', op: 'resume', code: g.code, id: 'rb' });
    if (inside && same6(ids6(ans6(g.wc, 'r')), [A, C]) && same6(ans6(wb, 'rb'), { type: 'squad', op: 'gone', id: 'rb' }))
      ok('(sg-e) and when the socket closed during the read, the log still finds the block: the dropped row goes and a resume answers gone');
    else fail('(sg-e) closed, block during the door\'s read: ' + JSON.stringify({ inside, x: ans6(g.wc, 'r'), b: ans6(wb, 'rb') }));
  }
  {
    // (ii) THE LOG DROPPED THE DOOR'S ENTRIES (blocks naming B, from players
    // outside the squad, aged past 16 s): one more read. Dropped again during
    // that one: the door fails TO GUEST (D-BLOCK-3 H) — not kicked, not
    // claimed, a nameless guest row. Kept that time: claimed, by name.
    const run = async (twice) => {
      const g = await signWorld6(null);
      const o = outs6(g.S);
      const wn = t6ws(null);
      await join6(g.S, wn, g.code, 'Bunker');
      const h = stale6(g.st, 'blockIdsOf');
      hello6(g.S, wn, B);
      let inside = await within6(h.inside), again = null, n = null;
      if (inside) {
        await blk6(g.S, o.e, B); await age6(g.S, o.n, B);
        if (twice) again = staleFor6(g.st, 'blockIdsOf', B);
      } else h.restore();
      if (!again) n = after6(g.st, B);
      h.release();
      if (again) {
        inside = inside && await within6(again.inside);
        if (inside) { await blk6(g.S, o.e, B); await age6(g.S, o.n, B); } else again.restore();
        n = after6(g.st, B);
        again.release();
      }
      await settle6();
      await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
      const x = ans6(g.wc, 'r');
      return { inside, more: n.c, ended: got6(wn, 'squad', 'ended'), x: ids6(x), row: x && x.members[2] };
    };
    const twice = await run(true), once = await run(false);
    if (twice.inside && twice.more === 0 && !twice.ended.length && same6(twice.x, [A, C, null]) && twice.row.guest === true && twice.row.callsign === null
      && once.inside && once.more === 1 && !once.ended.length && same6(once.x, [A, C, B]))
      ok('(sg-e) a door whose read and re-read both lost log entries leaves the row a nameless guest row, kicking nobody; one that lost them once reads again and claims it');
    else fail('(sg-e) dropped reads at sign-in: ' + JSON.stringify({ twice, once }));
  }
  {
    // (iii) A FAILED READ FAILS TO GUEST (D-BLOCK-3 H). A blocked B, and the
    // store failing: B is not kicked and not claimed — the row stays the
    // nameless guest row it was. The door let nobody in, so B's next hello
    // (the store answering again) runs it once more, and the block found
    // then removes the row as a kick.
    const g = await signWorld6([A, B]);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    clear6(g.wa, g.wc, wn);
    g.st.boom.add('blockIdsOf');
    hello6(g.S, wn, B);
    await settle6();
    g.st.boom.delete('blockIdsOf');
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    const x = ans6(g.wc, 'r');
    const failed = { ended: got6(wn, 'squad', 'ended'), x: ids6(x), row: x && x.members[2], named: shows6(g.wa, B) || shows6(g.wc, B) };
    hello6(g.S, wn, B);                        // the same account again, a rotated token
    await settle6();
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r2' });
    if (!failed.ended.length && same6(failed.x, [A, C, null]) && failed.row.guest === true && failed.row.callsign === null && !failed.named
      && same6(lastSquad6(wn), KICKED6) && same6(ids6(ans6(g.wc, 'r2')), [A, C]))
      ok('(sg-e) a block read that fails at sign-in leaves the row a nameless guest row, kicking nobody; the next hello reads again');
    else fail('(sg-e) failed read at sign-in: ' + JSON.stringify({ failed, n: wn.rx, x2: ans6(g.wc, 'r2') }));
  }

  // ===== FIX PASS, WORKFLOW ROUND 2 ============================================

  // ---- (sg-d iii) a hello that does not verify is no cancel ----------------
  // server.js bumps ws.authGen as EVERY hello starts, before its token is
  // verified. A junk, missing or expired token then changes nothing else: no
  // identity, no onAuth. The socket is still the account whose check is out,
  // so that check must finish — both block directions, a row that was
  // adopted and one left a guest row, a socket that was anonymous first, and
  // the anonymous account's own door.
  {
    const bad = [];
    const cases = [
      { tag: 'A>B, adopted', row: [A, B], as: B },
      { tag: 'B>A, adopted', row: [B, A], as: B },
      { tag: 'A>B, left a guest row', row: [A, B], as: B, elsewhere: true },
      { tag: 'B>A, anonymous first', row: [B, A], as: B, anon: true },
      { tag: 'A>GU, the anonymous door', row: [A, GU], as: GU, guest: true },
    ];
    for (const c of cases) {
      const g = await signWorld6(c.row);
      if (c.elsewhere) await create6(g.S, up6(g.S, B));
      const wn = c.anon ? up6(g.S, GU, true) : t6ws(null);
      await join6(g.S, wn, g.code, 'N');
      clear6(g.wa, g.wc, wn);
      const gate = g.st.hold('blockIdsOf');
      hello6(g.S, wn, c.as, !!c.guest);
      const inside = await within6(gate.inside);
      wn.authGen += 1;                     // a second hello whose token does not verify
      gate.release();
      await settle6();
      await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
      if (!(inside && same6(lastSquad6(wn), KICKED6) && same6(ids6(ans6(g.wc, 'r')), [A, C]))) bad.push({ tag: c.tag, inside, n: wn.rx, x: ans6(g.wc, 'r') });
    }
    if (!bad.length) ok('(sg-d) a hello that does not verify, sent while the check is out, cancels nothing: the socket is still the account, and its row goes');
    else fail('(sg-d) junk hello during the check: ' + JSON.stringify(bad));
  }

  // ---- (sg-f) a hello as the SAME account opens no door --------------------
  // The door is for a socket that BECOMES an account. A rotated token for the
  // account the row already stands for (the client's re-hello, a repeated
  // sign-in) was checked when that row was made: it reads nothing, and a
  // store fault at that moment removes nobody — a member or the leader.
  {
    const bad = [];
    for (const who of [B, A]) {
      const { st, S, w } = await world6(A, [B, C]);
      st.calls.length = 0;
      st.boom.add('blockIdsOf');
      hello6(S, w[who], who);
      await settle6();
      st.boom.delete('blockIdsOf');
      await S.handle(w[C], { type: 'squad', op: 'resume', id: 'r' });
      const x = ans6(w[C], 'r');
      if (!(same6(ids6(x), [A, B, C]) && x.leader === A && ![A, B].some((id) => got6(w[id], 'squad', 'ended').length) && !st.calls.includes('blockIdsOf')))
        bad.push({ who: who === A ? 'leader' : 'member', x, a: got6(w[A], 'squad'), b: got6(w[B], 'squad'), calls: st.calls });
    }
    if (!bad.length) ok('(sg-f) a member or the leader saying hello again as the same account reads no blocks, and a store fault then removes nobody');
    else fail('(sg-f) same-account re-hello: ' + JSON.stringify(bad));
  }
  {
    // (i, b) The same for an ANONYMOUS account: its guest row, joined as that
    // account (the join read its blocks), and a second hello as it.
    const g = await signWorld6(null);
    const wg = up6(g.S, GU, true);
    await join6(g.S, wg, g.code, 'Ghost');
    clear6(wg);
    g.st.calls.length = 0;
    g.st.boom.add('blockIdsOf');
    hello6(g.S, wg, GU, true);
    await settle6();
    g.st.boom.delete('blockIdsOf');
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (same6(ids6(ans6(g.wc, 'r')), [A, C, null]) && !got6(wg, 'squad', 'ended').length && !g.st.calls.includes('blockIdsOf'))
      ok('(sg-f) and an anonymous guest saying hello again as the same account reads nothing and is removed by no fault');
    else fail('(sg-f) anonymous re-hello: ' + JSON.stringify({ x: ans6(g.wc, 'r'), g: wg.rx, calls: g.st.calls }));
  }
  {
    // (ii) A row an earlier sign-in already let in: a second hello as the
    // same account reads nothing, even while the store is failing.
    const g = await signWorld6(null);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    hello6(g.S, wn, B);
    await settle6();
    g.st.calls.length = 0;
    g.st.boom.add('blockIdsOf');
    hello6(g.S, wn, B);
    await settle6();
    g.st.boom.delete('blockIdsOf');
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (same6(ids6(ans6(g.wc, 'r')), [A, C, B]) && !got6(wn, 'squad', 'ended').length && !g.st.calls.includes('blockIdsOf'))
      ok('(sg-f) a row the door has already let in is not read again on the next hello as the same account');
    else fail('(sg-f) second hello after the door: ' + JSON.stringify({ x: ans6(g.wc, 'r'), n: wn.rx, calls: g.st.calls }));
  }
  {
    // (iii) BUT A SIGN-OUT CLOSES THE DOOR BEHIND IT. The row is left a guest
    // row (B leads elsewhere); the socket signs out, a block A>B lands while
    // it is nobody, and it signs in as B again: that is a socket BECOMING B,
    // and the door runs.
    const g = await signWorld6(null);
    await create6(g.S, up6(g.S, B));
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    hello6(g.S, wn, B);
    await settle6();
    wn.authGen += 1; g.S.onClose(wn); wn.userId = null; wn.isGuest = false;   // server.js's sign-out
    await g.st.addBlock(A, B);
    clear6(wn);
    hello6(g.S, wn, B);
    await settle6();
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (same6(lastSquad6(wn), KICKED6) && same6(ids6(ans6(g.wc, 'r')), [A, C]))
      ok('(sg-f) a socket that signed out and signs in again as the same account goes through the door again');
    else fail('(sg-f) sign-out then the same account: ' + JSON.stringify({ n: wn.rx, x: ans6(g.wc, 'r') }));
  }
  {
    // (iv) NOTHING CLAIMS THE ROW WHILE THE DOOR IS OUT (D-BLOCK-3 F). B
    // leads Y, so the row would be left a guest row. While B's read is out,
    // B leaves Y and the socket says hello as B again: that hello opens no
    // door, and B now has no other row — but the row is the door's, so it
    // is not adopted. It goes as the nameless row it was, and B's name never
    // reached A or C.
    const g = await signWorld6([A, B]);
    const wb1 = up6(g.S, B);
    await create6(g.S, wb1);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    clear6(g.wa, g.wc, wn);
    const gate = g.st.hold('blockIdsOf');
    hello6(g.S, wn, B);
    const inside = await within6(gate.inside);
    if (inside) { await g.S.handle(wb1, { type: 'squad', op: 'leave' }); hello6(g.S, wn, B); }
    gate.release();
    await settle6();
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (inside && same6(lastSquad6(wn), KICKED6) && same6(ids6(ans6(g.wc, 'r')), [A, C]) && !shows6(g.wa, B) && !shows6(g.wc, B))
      ok('(sg-f) a hello as the same account while the door is out claims nothing: the row goes nameless');
    else fail('(sg-f) adopted during the check: ' + JSON.stringify({ inside, n: wn.rx, x: ans6(g.wc, 'r'), a: shows6(g.wa, B), c: shows6(g.wc, B) }));
  }

  // ---- (sg-g) the squad is read AFTER the block read -----------------------
  // While B's read is out, B's socket leaves X and makes a squad of its own.
  // X still holds A, whom B is blocked by; Y holds nobody but B. Nothing may
  // be sent to B, and Y stands.
  {
    const g = await signWorld6([A, B]);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    clear6(g.wa, g.wc, wn);
    const gate = g.st.hold('blockIdsOf');
    hello6(g.S, wn, B);
    const inside = await within6(gate.inside);
    let Y = null;
    if (inside) { await g.S.handle(wn, { type: 'squad', op: 'leave', id: 'l' }); Y = await create6(g.S, wn); }
    gate.release();
    await settle6();
    await g.S.handle(wn, { type: 'squad', op: 'resume', id: 'ry' });
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    const y = ans6(wn, 'ry');
    if (inside && Y && !got6(wn, 'squad', 'ended').length && y && y.code === Y && same6(ids6(y), [B]) && same6(ids6(ans6(g.wc, 'r')), [A, C]))
      ok('(sg-g) the door judges the squad the row is in once its read lands: a socket that moved on is sent nothing, and its new squad stands');
    else fail('(sg-g) moved during the check: ' + JSON.stringify({ inside, Y, n: wn.rx, x: ans6(g.wc, 'r') }));
  }
  {
    // (ii) The same move, and the read then FAILS. A failed read fails to
    // guest (D-BLOCK-3 H) and touches no row at all — least of all the new
    // row the account made meanwhile under the same key.
    const g = await signWorld6(null);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    clear6(g.wa, g.wc, wn);
    const real = g.st.blockIdsOf;
    let release, entered;
    const open = new Promise((r) => { release = r; });
    const inRead = new Promise((r) => { entered = r; });
    g.st.blockIdsOf = async () => { g.st.blockIdsOf = real; entered(); await open; throw new Error('sb GET 500'); };
    hello6(g.S, wn, B);
    const inside = await within6(inRead);
    let Y = null;
    if (inside) { await g.S.handle(wn, { type: 'squad', op: 'leave', id: 'l' }); Y = await create6(g.S, wn); }
    else g.st.blockIdsOf = real;
    release();
    await settle6();
    await g.S.handle(wn, { type: 'squad', op: 'resume', id: 'ry' });
    const y = ans6(wn, 'ry');
    if (inside && Y && !got6(wn, 'squad', 'ended').length && y && y.code === Y && same6(ids6(y), [B]) && y.leader === B)
      ok('(sg-g) a check whose read fails after its row has moved on removes nothing: the account\'s new squad stands');
    else fail('(sg-g) failed read after a move: ' + JSON.stringify({ inside, Y, n: wn.rx }));
  }

  // ---- (inv-p) a block that lands while the invite's reads are out ---------
  // C leads with A in the squad; C invites their friend B. A blocks B while
  // the invite's reads are out: the invite must not carry the squad's code
  // to a player a member has just blocked (the recent-blocks log, as join
  // reads it). (i) Inside B's own block read, answered before the block
  // landed; (ii) inside another leg of the reads, after B's read had answered.
  {
    const bad = [];
    for (const where of ['in B\'s block read', 'in another read']) {
      const st = t6store(ROWS6);
      await st.addFriendship(C, B); await st.addFriendship(A, B);
      const S = mkSocial6(st);
      const wc = up6(S, C), wa = up6(S, A), wb = up6(S, B);
      const code = await create6(S, wc);
      await join6(S, wa, code, 'Anvil Six');
      clear6(wa, wb, wc); PUSHES.length = 0; DRY6.length = 0;
      const h = where === 'in another read' ? st.hold('profileById') : staleFor6(st, 'blockIdsOf', B);
      const pending = S.handle(wc, { type: 'squad', op: 'invite', to: B, id: 'p' });
      const inside = await within6(h.inside);
      if (inside) await S.handle(wa, { type: 'block', op: 'add', id: B });
      else if (h.restore) h.restore();
      h.release(); await pending;
      if (!(inside && st.blocks.has(A + '>' + B) && same6(ans6(wc, 'p'), { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'p' }) && !invited6(wb).length && !PUSHES.length && !DRY6.length))
        bad.push({ where, inside, c: ans6(wc, 'p'), b: invited6(wb) });
    }
    if (!bad.length) ok('(inv-p) a block landing while the invite\'s reads are out is added from the log: nothing reaches the player just blocked, and the inviter gets the ordinary answer');
    else fail('(inv-p) block during the invite: ' + JSON.stringify(bad));
  }
  {
    // (ii) THE LOG DROPPED THE LEG'S ENTRIES. Blocks naming B, from players
    // outside the squad, land while the invite's reads are out and age past
    // 16 s: B's blocks are read once more. Dropped again during that read:
    // the invite is dropped, and answered as ever. Kept that time: delivered.
    const run = async (twice) => {
      const st = t6store(ROWS6);
      await st.addFriendship(C, B);
      const S = mkSocial6(st);
      const wc = up6(S, C), wb = up6(S, B);
      const o = outs6(S);
      await create6(S, wc);
      clear6(wb, wc);
      const g = st.hold('profileById');
      const pending = S.handle(wc, { type: 'squad', op: 'invite', to: B, id: 'p' });
      let inside = await within6(g.inside), again = null, n = null;
      if (inside) {
        await blk6(S, o.e, B); await age6(S, o.n, B);
        if (twice) again = staleFor6(st, 'blockIdsOf', B);
      }
      if (!again) n = after6(st, B);
      g.release();
      if (again) {
        inside = inside && await within6(again.inside);
        if (inside) { await blk6(S, o.e, B); await age6(S, o.n, B); } else again.restore();
        n = after6(st, B);
        again.release();
      }
      await pending;
      return { inside, more: n.c, answer: ans6(wc, 'p'), invited: invited6(wb).length };
    };
    const twice = await run(true), once = await run(false);
    const onl = { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'p' };
    if (twice.inside && twice.more === 0 && same6(twice.answer, onl) && twice.invited === 0
      && once.inside && once.more === 1 && same6(once.answer, onl) && once.invited === 1)
      ok('(inv-p) an invite whose reads and one re-read both lost log entries is dropped and answered as ever; one that lost them once reads again and delivers');
    else fail('(inv-p) dropped reads: ' + JSON.stringify({ twice, once }));
  }

  // ---- (inv-o) the seam is told when its bound has passed ------------------
  // Past INVITE_PUSH_MS the inviter is answered none. The seam is handed a
  // signal that is aborted at that moment, so a transport whose read ran
  // long sends nothing afterwards, and 'none' stays true. One that answers
  // in time is never aborted.
  {
    const prev = process.env.SQUAD_INVITE_PUSH_MS;
    process.env.SQUAD_INVITE_PUSH_MS = '30';
    const run = async (readMs) => {
      const SENDS = [], SIGS = [];
      const seam = async (to, payload, opts) => {
        SIGS.push(opts ? opts.signal : undefined);
        await new Promise((r) => setTimeout(r, readMs));        // the one subscription read
        if (opts && opts.signal && opts.signal.aborted) return false;
        if (!(opts && opts.dryRun)) SENDS.push([to, payload]);
        return true;
      };
      const st = t6store(ROWS6);
      await st.addFriendship(A, B);
      const S = mkSocial6(st, { pushInvite: seam });
      const wa = up6(S, A);
      await create6(S, wa);
      clear6(wa);
      await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'o' });
      await new Promise((r) => setTimeout(r, readMs + 60));
      return { answer: ans6(wa, 'o'), sends: SENDS.length, signal: SIGS[0] instanceof AbortSignal, aborted: !!(SIGS[0] && SIGS[0].aborted) };
    };
    const slow = await run(90), fast = await run(5);
    if (prev === undefined) delete process.env.SQUAD_INVITE_PUSH_MS; else process.env.SQUAD_INVITE_PUSH_MS = prev;
    if (same6(slow, { answer: { type: 'squad', op: 'invite', ok: true, delivered: 'none', id: 'o' }, sends: 0, signal: true, aborted: true }))
      ok('(inv-o) a seam slower than its bound is aborted as the inviter is told none, and sends nothing after');
    else fail('(inv-o) slow seam: ' + JSON.stringify(slow));
    if (same6(fast, { answer: { type: 'squad', op: 'invite', ok: true, delivered: 'push', id: 'o' }, sends: 1, signal: true, aborted: false }))
      ok('(inv-o) and a seam that answers in time is never aborted');
    else fail('(inv-o) fast seam: ' + JSON.stringify(fast));
  }

  // ---- (blk-q) every squad is searched, not only the ones a key reaches ----
  // An ANONYMOUS account has no presence and its rows are keyed by socket, so
  // when both parties are anonymous a block from a socket that holds no row
  // reaches their shared squad by no key at all. (i) A second tab blocks.
  // (ii) The tab that blocks becomes another account while the block's
  // writes are out, so even the acting socket no longer leads there.
  {
    const bad = [];
    {
      const st = t6store(ROWS6);
      const S = mkSocial6(st);
      const wa = up6(S, A);
      const code = await create6(S, wa);
      const g1 = up6(S, GU, true), gv = up6(S, NN, true);
      await join6(S, g1, code, 'Ghost'); await join6(S, gv, code, 'Vapour');
      const g2 = up6(S, GU, true);                               // holds no row
      clear6(wa, g1, gv, g2);
      await S.handle(g2, { type: 'block', op: 'add', id: NN });
      await S.handle(wa, { type: 'squad', op: 'resume', id: 'r' });
      const x = ans6(wa, 'r');
      if (!(st.blocks.has(GU + '>' + NN) && x && x.members.length === 2 && same6(got6(g1, 'squad'), [{ type: 'squad', op: 'ended', reason: 'left' }]) && !got6(gv, 'squad', 'ended').length))
        bad.push({ secondTab: { x, g1: g1.rx, gv: gv.rx } });
    }
    {
      const st = t6store(ROWS6);
      const S = mkSocial6(st);
      const wc = up6(S, C);
      const code = await create6(S, wc);
      const wg1 = up6(S, GU, true), wg2 = up6(S, GU, true), wv = up6(S, NN, true);
      for (const w of [wg1, wg2, wv]) await join6(S, w, code, 'Guest');
      clear6(wc, wg1, wg2, wv);
      const gate = st.hold('removeFriendship');
      const pending = S.handle(wg1, { type: 'block', op: 'add', id: NN });
      const inside = await within6(gate.inside);
      if (inside) hello6(S, wg1, D);
      gate.release(); await pending;
      await settle6();
      await S.handle(wc, { type: 'squad', op: 'resume', id: 'r' });
      const x = ans6(wc, 'r');
      // wg2 also saw the roster tab 1's sign-in pushed; the one end is its own.
      if (!(inside && st.blocks.has(GU + '>' + NN) && same6(ids6(x), [C, D, null]) && same6(got6(wg2, 'squad', 'ended'), [{ type: 'squad', op: 'ended', reason: 'left' }]) && same6(lastSquad6(wg2), { type: 'squad', op: 'ended', reason: 'left' }) && !got6(wv, 'squad', 'ended').length))
        bad.push({ tabSignedIn: { inside, x, g2: wg2.rx, v: wv.rx } });
    }
    if (!bad.length) ok('(blk-q) a block between two anonymous accounts finds their shared squad from any socket, even one that became somebody else mid-block');
    else fail('(blk-q) anonymous pair: ' + JSON.stringify(bad));
  }

  // ---- (blk-p iii) every write is the asking account's ---------------------
  // The socket becomes D while the block's FIRST read is out, before any
  // write: the block row, the unfriend and both request deletes are still
  // A's, and nothing of D's is touched. Then the unblock route: the key is
  // resolved while the socket becomes somebody else — D, or B itself — and
  // A's block is still the one lifted.
  {
    const st = t6store(ROWS6);
    await st.addFriendship(A, B); await st.addFriendship(D, E);
    await st.addRequest(A, B); await st.addRequest(D, B);
    const S = mkSocial6(st);
    const wx = up6(S, A); up6(S, B);
    const gate = st.hold('profileById');
    const pending = S.handle(wx, { type: 'block', op: 'add', id: B });
    const inside = await within6(gate.inside);
    if (inside) hello6(S, wx, D);
    gate.release(); await pending;
    if (inside && same6([...st.blocks], [A + '>' + B]) && same6([...st.friends], [PAIR6(D, E)]) && same6([...st.requests], [D + '>' + B]))
      ok('(blk-p) a socket that becomes another account before the block writes anything still blocks, unfriends and clears requests for the account that asked');
    else fail('(blk-p) hello before the writes: ' + JSON.stringify({ inside, blocks: [...st.blocks], friends: [...st.friends], requests: [...st.requests] }));
  }
  {
    const bad = [];
    for (const into of [D, B]) {
      const st = t6store(ROWS6);
      await st.addBlock(A, B); await st.addBlock(D, E);
      const S = mkSocial6(st);
      const wx = up6(S, A);
      await S.handle(wx, { type: 'block', op: 'list', id: 'l' });
      const key = ((ans6(wx, 'l') || {}).blocked || [])[0];
      const gate = st.hold('blockIdsOf');
      const pending = S.handle(wx, { type: 'block', op: 'remove', id: key && key.id });
      const inside = await within6(gate.inside);
      if (inside) hello6(S, wx, into);
      gate.release(); await pending;
      if (!(key && inside && same6([...st.blocks], [D + '>' + E]) && same6(ans6(wx, key.id), { type: 'block', op: 'remove', ok: true, id: key.id })))
        bad.push({ into: into === B ? 'B' : 'D', inside, blocks: [...st.blocks], rx: wx.rx });
    }
    if (!bad.length) ok('(blk-p) an unblock whose socket becomes another account, or the blocked one, mid-way lifts the asking account\'s block and no other');
    else fail('(blk-p) hello during an unblock: ' + JSON.stringify(bad));
  }

  // ===== CONTROLLER FIX PASS: D-BLOCK-3 F, G AND H =============================

  // ---- (blk-r) a storm of unrelated blocks moves no reader (G) -------------
  // Every read of B's blocks, answered first, then waits while fifteen
  // blocks that do not name B land — E blocking NN, NN blocking GU, and a
  // member of the squad B is reading for blocking E — so blocks are always
  // landing while a reader is out. B joins, B's door lets B in, and C's
  // invite reaches B, each on one read: nothing is refused, kicked or
  // dropped, and nothing is read again.
  {
    const stormy6 = (st, S, wm) => {
      const real = st.blockIdsOf, n = { c: 0 }, o = outs6(S);
      st.blockIdsOf = async function (x, ...a) {
        if (x !== B) return real.call(st, x, ...a);
        n.c++;
        const v = await real.call(st, x, ...a);
        for (let i = 0; i < 5; i++) { await blk6(S, o.e, NN); await blk6(S, o.n, GU); await blk6(S, wm, E); }
        return v;
      };
      return n;
    };
    const bad = [];
    {
      const j = await joinWorld6();
      const n = stormy6(j.st, j.S, j.wc);
      await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
      const a = ans6(j.wb, 'j');
      if (!(n.c === 1 && a && a.op === 'state' && a.code === j.code)) bad.push({ join: { reads: n.c, a } });
    }
    {
      const g = await signWorld6(null);
      const wn = t6ws(null);
      await join6(g.S, wn, g.code, 'Bunker');
      const n = stormy6(g.st, g.S, g.wc);
      hello6(g.S, wn, B);
      await until6(() => n.c > 0);
      await settle6(); await settle6();
      await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
      const x = ids6(ans6(g.wc, 'r'));
      if (!(n.c === 1 && same6(x, [A, C, B]) && !got6(wn, 'squad', 'ended').length)) bad.push({ door: { reads: n.c, x, n: got6(wn, 'squad', 'ended') } });
    }
    {
      const st = t6store(ROWS6);
      await st.addFriendship(C, B);
      const S = mkSocial6(st);
      const wc = up6(S, C), wb = up6(S, B), wa = up6(S, A);
      const code = await create6(S, wc);
      await join6(S, wa, code, 'Anvil Six');
      clear6(wb, wc);
      const n = stormy6(st, S, wa);
      await S.handle(wc, { type: 'squad', op: 'invite', to: B, id: 'p' });
      if (!(n.c === 1 && same6(ans6(wc, 'p'), { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'p' }) && invited6(wb).length === 1))
        bad.push({ invite: { reads: n.c, a: ans6(wc, 'p'), invited: invited6(wb).length } });
    }
    if (!bad.length) ok('(blk-r) blocks naming none of the readers, landing during every read, refuse no join, kick no signing-in row, drop no invite, and make nobody read again');
    else fail('(blk-r) unrelated storm: ' + JSON.stringify(bad));
  }

  // ---- (blk-r ii) what the log keeps: 16 s, and 4096 entries (G) ------------
  // A join's read is out while blocks that do not name the joiner land. At
  // exactly 16 s old the read's entry is still kept, and 4096 entries are
  // all kept: one read, and B joins. At 4097 the oldest goes by the count:
  // the read needed it, so it reads once more — and joins.
  {
    const run = async (land) => {
      const j = await joinWorld6();
      const o = outs6(j.S);
      const h = stale6(j.st, 'blockIdsOf');
      const pending = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
      const inside = await within6(h.inside);
      if (inside) await land(j.S, o); else h.restore();
      const n = after6(j.st, B);
      h.release(); await pending;
      const a = ans6(j.wb, 'j');
      return { inside, rereads: n.c, joined: !!(a && a.op === 'state' && a.code === j.code) };
    };
    const flood = (count) => async (S, o) => { for (let i = 0; i < count; i++) await blk6(S, o.e, NN); };
    const aged = await run(async (S, o) => { await blk6(S, o.e, NN); CLOCK6 += 16000; await blk6(S, o.n, GU); });
    const full = await run(flood(4096)), over = await run(flood(4097));
    if (aged.inside && aged.rereads === 0 && aged.joined && full.inside && full.rereads === 0 && full.joined && over.inside && over.rereads === 1 && over.joined)
      ok('(blk-r) the log keeps an entry 16 s and 4096 entries: a read that needed only those reads once; the 4097th drops one, and the read reads again');
    else fail('(blk-r) log retention: ' + JSON.stringify({ aged, full, over }));
  }

  // ---- (sg-h) the door reads BEFORE the claim (F) --------------------------
  {
    // (i) While B's door read is out, the row is the nameless guest row it
    // was: every roster shows it as a guest, nobody is sent B's name, and a
    // Start that would seat it — the squad fits ffa and every rack is in —
    // is refused member_offline at that row. Once the read lets B in, the
    // row is B's, by name, and the same Start seats the squad.
    const seated = [];
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { seatSquad: (seats) => { seated.push(seats.length); return { ok: true, code: 'RM6F' }; } });
    const wa = up6(S, A), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    await S.handle(wa, { type: 'squad', op: 'mode', mode: 'ffa' });
    const wn = t6ws(null);
    await join6(S, wn, code, 'Bunker');
    await S.handle(wc, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    await S.handle(wn, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    clear6(wa, wc, wn);
    const h = stale6(st, 'blockIdsOf');
    hello6(S, wn, B);
    const inside = await within6(h.inside);
    let during = null, roster = null;
    if (inside) {
      await S.handle(wa, { type: 'squad', op: 'start', loadout: RACK5, id: 's1' });
      during = ans6(wa, 's1');
      await S.handle(wa, { type: 'squad', op: 'resume', id: 'r1' });
      roster = ans6(wa, 'r1');
    } else h.restore();
    const named = shows6(wa, B) || shows6(wc, B) || shows6(wn, B);
    h.release();
    await settle6();
    const after = last6(wc, 'squad', 'state');
    await S.handle(wa, { type: 'squad', op: 'start', loadout: RACK5, id: 's2' });
    if (inside && same6(during, { type: 'squad', op: 'start', error: 'member_offline', at: 2, id: 's1' }) && !named
      && roster && same6(roster.members[2], { id: null, callsign: null, guest: true, online: true, ready: true, dropped: false })
      && after && same6(ids6(after), [A, C, B]) && after.members[2].callsign === 'Bunker Nine'
      && same6(ans6(wa, 's2'), { type: 'squad', op: 'start', ok: true, code: 'RM6F', id: 's2' }) && same6(seated, [3]))
      ok('(sg-h) while the door reads, the row stays a nameless guest row and Start answers member_offline for it; once B is let in the row is B\'s by name and Start seats it');
    else fail('(sg-h) during the door: ' + JSON.stringify({ inside, during, named, row: roster && roster.members[2], after: after && after.members[2], s2: ans6(wa, 's2'), seated }));
  }
  {
    // (ii) THE DOOR FOLLOWS THE ROW when its socket closes during the read:
    // with no block the row, dropped now, is still claimed as B's, and B's
    // next device takes it back.
    const g = await signWorld6(null);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    const h = stale6(g.st, 'blockIdsOf');
    hello6(g.S, wn, B);
    const inside = await within6(h.inside);
    if (inside) { wn.readyState = 3; g.S.onClose(wn); } else h.restore();
    h.release();
    await settle6();
    const wb = up6(g.S, B);
    await g.S.handle(wb, { type: 'squad', op: 'resume', code: g.code, id: 'rb' });
    const r = ans6(wb, 'rb');
    if (inside && r && r.op === 'state' && r.you === 2 && same6(ids6(r), [A, C, B]) && r.members[2].dropped === false)
      ok('(sg-h) a socket that closes while the door reads is still judged: with no block its dropped row is claimed as the account\'s, and its next device takes it back');
    else fail('(sg-h) closed during the door, no block: ' + JSON.stringify({ inside, r }));
  }
  {
    // (iii) And when B ALREADY has a dropped row in that squad, the claim
    // takes the guest row out and puts the closed socket on nothing: B's row
    // stays dropped, for the window to sweep or B to resume.
    const g = await signWorld6(null);
    const wb1 = up6(g.S, B);
    await join6(g.S, wb1, g.code, 'Bunker Nine');
    wb1.readyState = 3; g.S.onClose(wb1);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    const h = stale6(g.st, 'blockIdsOf');
    hello6(g.S, wn, B);
    const inside = await within6(h.inside);
    if (inside) { wn.readyState = 3; g.S.onClose(wn); } else h.restore();
    h.release();
    await settle6();
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    const x = ans6(g.wc, 'r');
    if (inside && same6(ids6(x), [A, C, B]) && x.members[2].dropped === true)
      ok('(sg-h) a closed socket is never put on the account\'s own dropped row by the door\'s claim: that row stays dropped');
    else fail('(sg-h) closed during the door, own row dropped: ' + JSON.stringify({ inside, x }));
  }
  {
    // (iv) A LATER DOOR OWNS THE ROW. The socket signs in as B, then — B's
    // read still out — as E. B's door ends first (another account now) and
    // must not lift E's: a Start while E's read is out is still refused.
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { seatSquad: () => ({ ok: true, code: 'RM6G' }) });
    const wa = up6(S, A), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    await S.handle(wa, { type: 'squad', op: 'mode', mode: 'ffa' });
    const wn = t6ws(null);
    await join6(S, wn, code, 'Bunker');
    await S.handle(wc, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    await S.handle(wn, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    const hb = staleFor6(st, 'blockIdsOf', B);
    hello6(S, wn, B);
    const in1 = await within6(hb.inside);
    const he = staleFor6(st, 'blockIdsOf', E);
    hello6(S, wn, E);
    const in2 = await within6(he.inside);
    hb.release();
    await settle6();
    await S.handle(wa, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    he.release();
    await settle6();
    if (in1 && in2 && same6(ans6(wa, 's'), { type: 'squad', op: 'start', error: 'member_offline', at: 2, id: 's' }))
      ok('(sg-h) a door for another account takes the row over: the first door\'s end leaves the second\'s hold on Start');
    else fail('(sg-h) two doors: ' + JSON.stringify({ in1, in2, s: ans6(wa, 's') }));
  }
  {
    // (v) A SIGN-OUT AND BACK IN AS B while B's read is out: the second door
    // owns the row. The first read then fails, and must neither lift the
    // second door's hold on Start nor stop it claiming the row.
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { seatSquad: () => ({ ok: true, code: 'RM6H' }) });
    const wa = up6(S, A), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    await S.handle(wa, { type: 'squad', op: 'mode', mode: 'ffa' });
    const wn = t6ws(null);
    await join6(S, wn, code, 'Bunker');
    await S.handle(wc, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    await S.handle(wn, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    const q = [true, false].map((fails) => { const r = { fails }; r.open = new Promise((f) => { r.release = f; }); r.inside = new Promise((f) => { r.entered = f; }); return r; });
    const real = st.blockIdsOf;
    st.blockIdsOf = async function (x, ...a) {
      const hq = x === B ? q.shift() : null;
      if (!hq) return real.call(st, x, ...a);
      const v = await real.call(st, x, ...a); hq.entered(); await hq.open;
      if (hq.fails) throw new Error('sb GET 500');
      return v;
    };
    const [first, second] = q;
    hello6(S, wn, B);
    const in1 = await within6(first.inside);
    wn.authGen += 1; S.onClose(wn); wn.userId = null; wn.isGuest = false;   // server.js's sign-out
    hello6(S, wn, B);
    const in2 = await within6(second.inside);
    first.release(); await settle6();
    await S.handle(wa, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    second.release(); await settle6();
    st.blockIdsOf = real;
    await S.handle(wc, { type: 'squad', op: 'resume', id: 'r' });
    if (in1 && in2 && same6(ans6(wa, 's'), { type: 'squad', op: 'start', error: 'member_offline', at: 2, id: 's' }) && same6(ids6(ans6(wc, 'r')), [A, C, B]))
      ok('(sg-h) signed out and back in as the same account mid-read: the first door\'s failed read leaves the second door holding Start, and it claims the row');
    else fail('(sg-h) re-signed-in door: ' + JSON.stringify({ in1, in2, s: ans6(wa, 's'), x: ans6(wc, 'r') }));
  }
  {
    // (vi) THE SOCKET SIGNS OUT while B's read is out, and A has blocked B.
    // No later door takes the row over: the identity is what cancels. The
    // socket is nobody now, so the door removes and claims nothing.
    const g = await signWorld6([A, B]);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    clear6(wn);
    const h = stale6(g.st, 'blockIdsOf');
    hello6(g.S, wn, B);
    const inside = await within6(h.inside);
    if (inside) { wn.authGen += 1; g.S.onClose(wn); wn.userId = null; wn.isGuest = false; } else h.restore();   // server.js's sign-out
    h.release();
    await settle6();
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (inside && !got6(wn, 'squad', 'ended').length && same6(ids6(ans6(g.wc, 'r')), [A, C, null]))
      ok('(sg-h) a socket that signs out while the door reads is nobody: the door removes and claims nothing');
    else fail('(sg-h) signed out during the door: ' + JSON.stringify({ inside, n: wn.rx, x: ans6(g.wc, 'r') }));
  }

  // ---- (end of task 6 checks) ----
  if (prevPushMs === undefined) delete process.env.SOCIAL_PUSH_MS; else process.env.SOCIAL_PUSH_MS = prevPushMs;
  if (prevPresenceMs === undefined) delete process.env.SOCIAL_PRESENCE_MS; else process.env.SOCIAL_PRESENCE_MS = prevPresenceMs;
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall squad checks passed');
process.exit(out.errors.length ? 1 : 0);
