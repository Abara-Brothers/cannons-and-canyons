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
import { createSquads, fitsFor, SQUAD_SEATS } from '../server/squads.js';
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
const sqSocial = (store, extra = {}) => createSocial({
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

// ---- (s10) the seat table, and the engine it is a copy of -----------------
// Task 3 owns the seat table (X6) and replaces this copy with one source of
// truth; until it does, the copy is held to the engine here.
{
  const want = { duel: [2, 2], ffa: [2, 4], boss: [1, 2], aliens: [1, 2], golf: [1, 4] };
  if (JSON.stringify(SQUAD_SEATS) === JSON.stringify(want)) ok('(s10) SQUAD_SEATS is the spec seat table');
  else fail('(s10) SQUAD_SEATS is ' + JSON.stringify(SQUAD_SEATS));
  const f = (n) => JSON.stringify(fitsFor(n));
  if (f(1) === '{"duel":false,"ffa":false,"boss":true,"aliens":true,"golf":true}'
    && f(2) === '{"duel":true,"ffa":true,"boss":true,"aliens":true,"golf":true}'
    && f(3) === '{"duel":false,"ffa":true,"boss":false,"aliens":false,"golf":true}'
    && f(4) === '{"duel":false,"ffa":true,"boss":false,"aliens":false,"golf":true}')
    ok('(s10) fitsFor answers every squad size against every mode, minimum AND maximum');
  else fail('(s10) fitsFor: 1=' + f(1) + ' 2=' + f(2) + ' 3=' + f(3) + ' 4=' + f(4));
  // THE COPY IS PINNED TO ITS ORIGINAL. server/ may not import
  // public/room-engine.js (ADR-001), so this table is COPIED the way
  // SKIN_IDS is in server/social.js — and a copy with nothing holding it to
  // the original is a copy that drifts. Read as TEXT, by content rather than
  // line number.
  const eng = read('public/room-engine.js');
  const clamp = "  const max = mode === 'ffa' ? Math.max(2, Math.min(4, (opts.max | 0) || 4))\n"
    + "    : mode === 'golf' ? Math.max(1, Math.min(4, (opts.max | 0) || 2))\n    : 2;";
  const floor = "      const minSeats = (r.mode === 'boss' || r.mode === 'golf' || r.mode === 'aliens') ? 1 : 2;";
  if (eng.includes(clamp) && eng.includes(floor))
    ok('(s10) the engine still clamps seats and floors startMatch exactly as SQUAD_SEATS copies');
  else fail('(s10) room-engine.js seat rules have MOVED — SQUAD_SEATS is now a second opinion: clamp ' + eng.includes(clamp) + ', floor ' + eng.includes(floor));
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
    && JSON.stringify(seen.fits) === JSON.stringify(fitsFor(3)))
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

// ---- (h8) a store that fails: one honest answer, never two -----------------
{
  // THE ACTOR'S OWN SNAPSHOT FAILS: the net inside handleSquad answers, and
  // its answer carries the OP — handle()'s outer net would answer
  // { type:'squad', error } with no op, which a client with two squad
  // requests outstanding cannot place.
  {
    const st = sqstore(); const S = sqSocial(st);
    st.boom.add(SQA);
    const wa = sqUp(S, sqws(SQA));
    await S.handle(wa, { type: 'squad', op: 'create', id: 'c' });
    if (wa.rx.length === 1 && JSON.stringify(wa.rx[0]) === JSON.stringify({ type: 'squad', op: 'create', error: 'unavailable', id: 'c' }))
      ok('(h8) a create whose snapshot cannot be built is answered unavailable, carrying its op');
    else fail('(h8) create over a failing store got ' + JSON.stringify(wa.rx));
  }
  // A COURTESY PUSH THAT FAILS AFTER THE ANSWER IS SWALLOWED. The leaver has
  // been told `left`; a second frame saying the leave failed would be false.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB));
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = (sqlast(wa, 'state') || {}).code;
    await S.handle(wb, { type: 'squad', op: 'join', code });
    wa.rx.length = 0; wb.rx.length = 0;
    st.boom.add(SQB);
    await S.handle(wa, { type: 'squad', op: 'leave', id: 'l' });
    if (wa.rx.length === 1 && wa.rx[0].op === 'left' && wa.rx[0].ok === true && wa.rx[0].id === 'l')
      ok('(h8) a leave is answered left exactly once, even when the roster push behind it fails');
    else fail('(h8) leave over a failing push got ' + JSON.stringify(wa.rx));
  }
  // AND THE SAME FOR THE SQUAD A CREATOR LEFT: the creator's new squad
  // builds, the old squad's push fails, and the creator hears only success.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB));
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = (sqlast(wa, 'state') || {}).code;
    await S.handle(wb, { type: 'squad', op: 'join', code });
    wa.rx.length = 0;
    st.boom.add(SQB);
    await S.handle(wa, { type: 'squad', op: 'create', id: 'c2' });
    if (wa.rx.length === 1 && wa.rx[0].op === 'state' && wa.rx[0].id === 'c2' && wa.rx[0].code !== code)
      ok('(h8) a create is answered with its new squad once, even when telling the old squad fails');
    else fail('(h8) create-from-a-squad over a failing push got ' + JSON.stringify(wa.rx));
  }
  // THE OTHER WAY ROUND: the mover's OWN answer fails, and the squad they
  // left has still changed under the people in it — so it is still told.
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), wc = sqUp(S, sqws(SQC));
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = (sqlast(wa, 'state') || {}).code;
    await S.handle(wb, { type: 'squad', op: 'join', code });
    await S.handle(wc, { type: 'squad', op: 'create' });
    const other = (sqlast(wc, 'state') || {}).code;
    wa.rx.length = 0; wb.rx.length = 0;
    st.boom.add(SQC);                 // any snapshot with C in it fails
    await S.handle(wa, { type: 'squad', op: 'join', code: other, id: 'j' });
    const told = sqlast(wb, 'state');
    if (wa.rx.length === 1 && wa.rx[0].op === 'join' && wa.rx[0].error === 'unavailable'
      && told && told.code === code && told.leader === SQB && told.members.length === 1)
      ok('(h8) a join whose own answer fails still tells the squad the mover left');
    else fail('(h8) failed join: mover ' + JSON.stringify(wa.rx) + ' left-behind ' + JSON.stringify(told));
  }
  {
    const st = sqstore(); const S = sqSocial(st);
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB));
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = (sqlast(wa, 'state') || {}).code;
    await S.handle(wb, { type: 'squad', op: 'join', code });
    wa.rx.length = 0; wb.rx.length = 0;
    st.boom.add(SQA);                 // A's new squad cannot be named; A's old one, now B's alone, can
    await S.handle(wa, { type: 'squad', op: 'create', id: 'c' });
    const heir = sqlast(wb, 'state');
    if (wa.rx.length === 1 && wa.rx[0].op === 'create' && wa.rx[0].error === 'unavailable'
      && heir && heir.code === code && heir.leader === SQB && heir.members.length === 1)
      ok('(h8) a create whose own answer fails still tells the squad the creator left');
    else fail('(h8) failed create: creator ' + JSON.stringify(wa.rx) + ' left-behind ' + JSON.stringify(heir));
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

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall squad checks passed');
process.exit(out.errors.length ? 1 : 0);
