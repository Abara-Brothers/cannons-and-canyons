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
import { rooms, handleClientMessage, setCodeTaken } from '../public/room-engine.js';
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
// says it about its own source checks. Two of these lines are wiring whose
// effect NO test can observe in this task, in process or against a running
// server: setCodeTaken(social.hasSquad) changes nothing while no squad can
// exist (hasSquad answers false for every string, which is also the engine's
// default), and roomExists has no reader until task 2's squad minter. So the
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

  // WHAT THIS SUITE DOES NOT YET PROVE, stated rather than implied. The SQUAD
  // arm of codeTaken and the 'squad' arm of the code frame cannot be reached
  // until a squad can exist, and create() is task 2. TASK 2 MUST ADD HERE:
  // (i) createSquads().create(member) followed by has(code) === true and
  // get(code) returning that squad and ofUser(member.userId) finding it;
  // (ii) a live squad code answering { type:'code', kind:'squad' } — asked of
  // the REAL server.js, which is where that answer is computed (see
  // test/code_frame.mjs), because nothing in process reaches it;
  // (iii) ofUser(null) answering null with a guest member present, which is
  // the guard server/squads.js deliberately leaves to that task;
  // (iv) THE OTHER DIRECTION OF R4: the squad minter refusing a candidate that
  // names a live room. server/squads.js cannot import `rooms`, so whatever
  // mints a squad code has to be handed this layer's roomExists — and nothing
  // in this task can test that, because nothing in it mints a squad code.
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
// THE SEND server.js REALLY USES, down to the wire: nothing reaches a socket
// that is not open, and what does reach it has been through JSON — so a frame
// that carried a socket or shared an array with another destination's frame
// could not pass here and fail in production.
const sqSocial = (store) => createSocial({
  store, terms: [], now: sqnow,
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
  // the handlers — create is gated on a linked account — and reachable from
  // this surface, which later tasks call directly; the guard is here for
  // them. A signed-in member is in the squad, because that is who a null
  // caller could otherwise remove.
  const N = sqMachine();
  const n = N.create({ userId: null, guest: true, name: 'G', skin: null, ws: sqws(null) });
  N.join(n.code, sqM(SQB, sqws(SQB)));
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

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall squad checks passed');
process.exit(out.errors.length ? 1 : 0);
