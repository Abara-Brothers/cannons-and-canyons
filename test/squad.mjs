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
// container the squad minter's roomExists reads (the code frame reads it too,
// but in server.js, where only test/code_frame.mjs can reach it).
import { rooms, handleClientMessage, setCodeTaken, MODE_SEATS, TEE_IDS, validRackFor } from '../public/room-engine.js';
import { LOADOUT_POOL, loadoutSizeFor } from '../public/game-core.js';
import { createSocial, createCooldown, SOCIAL_TYPES, SQUAD_ERRORS } from '../server/social.js';
// Task 2: the one-byte hook the code minters are proved on. The same module
// is loaded into a spawned server.js by test/code_frame.mjs with --import;
// here it is installed for the length of one block and taken out again.
import { scriptCodeBytes } from './fixtures/scripted-code-bytes.mjs';

// THE INVITE PUSH COOLDOWN OFF for this whole file (D-PUSH-1 R, the
// whole-branch fix wave): most worlds below invite one offline friend more
// than once under a clock that does not move, and pin what each invite sends.
// (cool) turns production's 30 s window back on to prove it.
process.env.SQUAD_INVITE_COOLDOWN_MS = '0';

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
// D-UI-3: EVERY ROSTER ROW CARRIES `rid`, a handle the server mints per row,
// so no expected literal can spell it. `norid` takes out that one field and
// nothing else -- any other field a row carried would still fail the
// comparison -- and (rid) holds the handle itself to its rules.
const norid = (r) => { if (!r || typeof r !== 'object' || !('rid' in r)) return r; const { rid, ...rest } = r; return rest; };
const RID32 = /^[0-9a-f]{32}$/;
// THE HANDLE OF A ROW, read off the LAST roster `w` was sent -- the way the
// leader's box reads it -- by account id, or by index for a guest row. It
// THROWS when there is no such row, so a kick is never sent as
// `rid: undefined` and left to pass for a refusal it did not earn.
const ridOf = (w, who) => {
  const f = [...w.rx].reverse().find((m) => m && m.type === 'squad' && m.op === 'state');
  const r = f && (typeof who === 'number' ? f.members[who] : f.members.find((m) => m.id === who));
  if (!r || typeof r.rid !== 'string') throw new Error('no rid for ' + JSON.stringify(who) + ' in the last roster ' + JSON.stringify(f && f.members));
  return r.rid;
};
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
  // Block comments first, ACROSS lines (the old per-line pass left a
  // multi-line one standing, and a wiring line inside it passed), then line
  // comments. server.js has no '/*' inside a string or a regex for this to
  // misread; the fixture below and (3b)'s positive matches would show it.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
  // THE STRIPPER ITSELF, on a fixture: a block comment that spans lines is a
  // comment too, and a wiring line inside one must not satisfy (3b).
  {
    const fixture = 'x();\n/*\n  setCodeTaken(social.hasSquad);\n*/\ny(); /* one */ z(); // tail\n';
    const out = code(fixture);
    if (!out.includes('setCodeTaken') && !out.includes('one') && !out.includes('tail') && /x\(\);[\s\S]*y\(\);\s+z\(\);/.test(out))
      ok('(3b) the comment stripper removes a block comment that spans lines, as well as one-line and trailing comments');
    else fail('(3b) the comment stripper left ' + JSON.stringify(out));
  }
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
// THE TWO-SQUADS STATE, BUILT THE ONE WAY IT STILL STANDS (E8, the
// whole-branch fix wave). A guest row whose socket signs in as an account
// with a row in ANOTHER squad now leaves once the sign-in door lets the
// account in. Until then — the door's read out, or failed (D-BLOCK-3 H) —
// the socket holds a guest row in one squad while its account is in another,
// and every guard below that is asked in that state still has to hold. So
// the worlds that test those guards sign in with the door's read failing:
// while DOOR_FAILS is set, the store fakes' blockIdsOf throws. The door
// reads SYNCHRONOUSLY inside onAuth, so the flag need only span that call.
let DOOR_FAILS = false;
const failedDoor = (fn) => { DOOR_FAILS = true; try { fn(); } finally { DOOR_FAILS = false; } };
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
    // anybody, and the read is not counted in `calls`. It fails only inside
    // failedDoor (above).
    async blockIdsOf() { if (DOOR_FAILS) throw new Error('sb GET 500'); return { blocked: [], blockedBy: [] }; },
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
// A TIMER THAT NEVER FIRES, unless a check passes its own: since U3 a squad
// whose every member is ready COUNTS DOWN on `schedule` and then seats itself,
// and many worlds below ready every member, the leader included. A real timer
// would fire three seconds later in whichever world was running by then, on
// a busy machine. The ready-up checks drive the countdown on a clock of their
// own (rdy-*), and nothing here waits on the drop window's real minute.
const sqSocial = (store, extra = {}) => createSocial({
  seats: MODE_SEATS, teeIds: TEE_IDS, validRack: validRackFor, schedule: () => () => {},
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
  if (rows && rows.length === 3 && rows.every((r) => RID32.test(r.rid))
    && JSON.stringify(norid(rows[0])) === JSON.stringify({ id: SQA, callsign: 'Anvil Six', guest: false, online: true, ready: false, dropped: false })
    && JSON.stringify(norid(rows[1])) === JSON.stringify({ id: SQD, callsign: null, guest: false, online: true, ready: false, dropped: false })
    && JSON.stringify(norid(rows[2])) === JSON.stringify({ id: null, callsign: null, guest: true, online: true, ready: false, dropped: false }))
    ok('(h1) a proved name is shown, an unprovable one keeps its row as null, and a guest row is null and flagged');
  else fail('(h1) rows: ' + JSON.stringify(rows));
  // THE NAME THE GUEST SENT LEAVES THE SERVER ONLY THROUGH THE DOOR'S RULES.
  // CHANGED (round 2, 2026-10-08): this read "never leaves the server". A
  // guest's seat now shows the name a lobby would (see (gn)), held to the
  // guidelines and to the name index. THIS world wires no index, the default
  // a host gets when it forgets one, and that default knows no key, so a typed
  // name is shown to nobody: closed, not open.
  if (!JSON.stringify(wa.rx).includes('FOLLOW ME OK') && !JSON.stringify(wd.rx).includes('FOLLOW ME OK') && !JSON.stringify(g.rx).includes('FOLLOW ME OK'))
    ok('(h1) with no name index wired, the typed name a guest sent reaches no member, the guest included');
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

// ---- (h5) kick: by the row's handle, a guest's included, and never by a member
// CHANGED BY TASK 9's FIX PASS (D-UI-3): a kick names its row by `rid` and by
// nothing else. The index form and the account-id form went with it; (rid-k)
// below proves each of them now kicks nobody.
{
  const st = sqstore(); const S = sqSocial(st);
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = (sqlast(wa, 'state') || {}).code;
  await S.handle(wb, { type: 'squad', op: 'join', code });
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  const ridA = ridOf(wa, SQA), ridB = ridOf(wa, SQB), ridG = ridOf(wa, 2);
  // A SIGNED-IN SOCKET IN NO SQUAD leads nothing, whatever handle it holds.
  const wz = sqUp(S, sqws(SQE));
  await S.handle(wz, { type: 'squad', op: 'kick', rid: ridB });
  if (wz.rx.length === 1 && sqat(wz).op === 'kick' && sqat(wz).error === 'not_leader') ok('(h5) a kick from a player in no squad is answered not_leader');
  else fail('(h5) kick from outside: ' + JSON.stringify(wz.rx));
  wb.rx.length = 0;
  await S.handle(wb, { type: 'squad', op: 'kick', rid: ridA, id: 'k1' });
  const refused = sqlast(wb);
  if (refused && refused.op === 'kick' && refused.error === 'not_leader' && refused.id === 'k1') ok('(h5) a member who is not the leader is answered not_leader');
  else fail('(h5) member kick: ' + JSON.stringify(refused));
  // A STRANGER: a row of ANOTHER squad, named by its own real handle. It is
  // no row of this one, that squad is not touched, and -- asked while this
  // squad still has members a wrong answer could land on -- nobody here is.
  await S.handle(wz, { type: 'squad', op: 'create' });
  const ridZ = ridOf(wz, SQE);
  wz.rx.length = 0; wb.rx.length = 0; g.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'kick', rid: ridZ, id: 'k3' });
  if (sqat(wa).op === 'kick' && sqat(wa).error === 'no_such_member' && sqat(wa).id === 'k3' && wz.rx.length === 0 && wb.rx.length === 0 && g.rx.length === 0)
    ok('(h5) kicking a stranger answers no_such_member');
  else fail('(h5) stranger kick: ' + JSON.stringify(sqlast(wa)) + ' stranger got ' + JSON.stringify(wz.rx) + ' members got ' + JSON.stringify([wb.rx, g.rx]));
  await S.handle(wa, { type: 'squad', op: 'kick', rid: ridA, id: 'k4' });
  if (sqat(wa).op === 'kick' && sqat(wa).error === 'no_such_member' && sqat(wa).id === 'k4' && wb.rx.length === 0 && g.rx.length === 0)
    ok('(h5) the leader naming themselves answers no_such_member and they stay');
  else fail('(h5) self kick: ' + JSON.stringify(sqlast(wa)));
  // THE FRAME CARRIES A CORRELATION id, because public/app.js's socialSend
  // mints a numeric one onto every frame that has none. `rid` is the target;
  // `id` is the echo and nothing else.
  wa.rx.length = 0; g.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'kick', rid: ridG, id: 7 });
  const seen = sqlast(wa, 'state'), told = sqlast(g);
  if (seen && seen.id === 7 && seen.members.length === 2 && told && told.op === 'ended' && told.reason === 'kicked' && told.id === undefined)
    ok('(h5) a guest row is kicked by its rid, with the client\'s numeric id on the frame, and the guest is told');
  else fail('(h5) guest kick: ' + JSON.stringify(seen) + ' told ' + JSON.stringify(told));
  // A SIGNED-IN MEMBER BY THEIR ROW'S rid TOO, and the echo is the frame's id.
  wa.rx.length = 0; wb.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'kick', rid: ridB, id: 'k2' });
  const byRid = sqlast(wa, 'state');
  if (byRid && byRid.members.length === 1 && byRid.id === 'k2' && sqlast(wb) && sqat(wb).op === 'ended' && sqat(wb).reason === 'kicked')
    ok('(h5) a signed-in member is kicked by their row\'s rid');
  else fail('(h5) rid kick: ' + JSON.stringify(byRid) + ' ' + JSON.stringify(sqlast(wb)));
  // THE KICKED PLAYER IS OUT OF IT: a join elsewhere is not a move out of it.
  wb.rx.length = 0;
  await S.handle(wb, { type: 'squad', op: 'leave' });
  if (wb.rx.length === 1 && sqat(wb).op === 'left') ok('(h5) a kicked member is in no squad afterwards');
  else fail('(h5) kicked member after: ' + JSON.stringify(wb.rx));
}

// ---- (rid) D-UI-3: EVERY ROW CARRIES ITS OWN HANDLE, AND A KICK AIMS AT IT --
// A kick must name ONE ROW, and nothing else in the frame can. An index names
// whoever stands at that place when the frame lands, which after an earlier
// row has left is somebody else (task 2's review); a guest's `id` is null by
// the frame's own rule. So every row of every state frame carries `rid`:
// opaque, never an account id, minted per row, the same for as long as that
// row stands, and never given to another row of the squad -- and a kick names
// a row by it and by nothing else, so a kick that was aimed before the roster
// moved lands on the row it was aimed at or on nobody.
{
  const HEX32 = /^[0-9a-f]{32}$/;
  const rows = (w) => (sqat(w, 'state').members || []);
  // A rid read off a socket's LAST roster, the way the leader's box reads it.
  // THROWS when the row is not there, so a kick below can never be sent with
  // `rid: undefined` and pass for a refusal it did not earn.
  const ridAt = (w, i) => { const r = rows(w)[i]; if (!r || typeof r.rid !== 'string') throw new Error('(rid) no rid at row ' + i + ' of ' + JSON.stringify(rows(w))); return r.rid; };
  const shape = (w) => rows(w).map((m) => m.id || 'guest');
  const st = sqstore(); const S = sqSocial(st);
  const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB)), g = sqws(null), h = sqws(null);
  await S.handle(wa, { type: 'squad', op: 'create' });
  const code = sqat(wa, 'state').code;
  await S.handle(wb, { type: 'squad', op: 'join', code, name: 'B', skin: 'olive' });
  await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
  // EVERY ROW, IN EVERY FRAME, TO EVERY SOCKET: a string of 32 hex digits,
  // distinct within its frame, and none of them an account id or carrying one.
  const all = [wa, wb, g].flatMap((w) => sqf(w, 'state'));
  const flat = (id) => id.replace(/-/g, '').toLowerCase();
  const badShape = all.filter((f) => !f.members.every((m) => typeof m.rid === 'string' && HEX32.test(m.rid))
    || new Set(f.members.map((m) => m.rid)).size !== f.members.length);
  const leaks = all.flatMap((f) => f.members.map((m) => m.rid)).filter((r) => typeof r === 'string' && [SQA, SQB].some((id) => r === id || r.includes(flat(id))));
  if (all.length >= 6 && !badShape.length && !leaks.length)
    ok('(rid) every row of every state frame, a guest\'s included, carries a 32-hex-digit rid, distinct within the frame and never an account id');
  else fail('(rid) rid shape: ' + JSON.stringify({ frames: all.length, badShape, leaks }));
  // EVERY SOCKET IS TOLD THE SAME HANDLE FOR THE SAME ROW.
  const views = [wa, wb, g].map((w) => rows(w).map((m) => m.rid));
  if (views[0].length === 3 && views[0].every((r) => typeof r === 'string') && views.every((v) => same(v, views[0])))
    ok('(rid) the leader, a member and a guest are told the same rid for each row');
  else fail('(rid) views disagree: ' + JSON.stringify(views));

  // STABLE WHILE THE ROW STANDS: through a Ready, a mode change, and a row
  // above it arriving and leaving again.
  const before = views[0];
  await S.handle(wb, { type: 'squad', op: 'ready', ready: true, loadout: FIVE });
  await S.handle(wa, { type: 'squad', op: 'mode', mode: 'ffa' });
  await S.handle(h, { type: 'squad', op: 'join', code, name: 'H', skin: 'gold' });
  const withH = rows(wa).map((m) => m.rid);
  await S.handle(h, { type: 'squad', op: 'leave' });
  const after = rows(wa).map((m) => m.rid);
  if (before.every((r) => typeof r === 'string') && typeof withH[3] === 'string'
    && same(after, before) && same(withH.slice(0, 3), before) && withH.length === 4 && !before.includes(withH[3]))
    ok('(rid) a row keeps its rid through a Ready, a mode change and another row joining and leaving');
  else fail('(rid) not stable: ' + JSON.stringify({ before, withH, after }));

  // A KICK BY rid removes exactly that row, answers the leader the roster
  // with the correlation id the client minted, and tells the removed player.
  // (Each check that reads a rid off a roster is wrapped: a roster with no
  // rid makes ridAt throw, and that is this check failing, not the file.)
  try {
  const gRid = ridAt(wa, 2);
  wa.rx.length = 0; wb.rx.length = 0; g.rx.length = 0;
  await S.handle(wa, { type: 'squad', op: 'kick', rid: gRid, id: 7 });
  const kr = sqlast(wa, 'state');
  if (kr && kr.id === 7 && same(shape(wa), [SQA, SQB]) && same(kr.members.map((m) => m.rid), before.slice(0, 2))
    && same(sqf(g), [{ type: 'squad', op: 'ended', reason: 'kicked' }]) && sqf(wb, 'ended').length === 0)
    ok('(rid) a kick by rid removes that row, answers the leader the roster with its numeric id, and tells the removed guest');
  else fail('(rid) kick by rid: ' + JSON.stringify({ leader: wa.rx, guest: g.rx }));

  // NEVER GIVEN TO ANOTHER ROW. The same account out and back in is a NEW
  // row with a new rid; a new guest standing where the old one stood too.
  const bOld = ridAt(wa, 1);
  await S.handle(wb, { type: 'squad', op: 'leave' });
  await S.handle(wb, { type: 'squad', op: 'join', code, name: 'B', skin: 'olive' });
  const g2 = sqws(null);
  await S.handle(g2, { type: 'squad', op: 'join', code, name: 'G2', skin: 'gold' });
  const seen = [...new Set([wa, wb, g, g2, h].flatMap((w) => sqf(w, 'state')).flatMap((f) => f.members.map((m) => m.rid)).concat(before, withH))];
  if (same(shape(wa), [SQA, SQB, 'guest']) && ridAt(wa, 1) !== bOld && ridAt(wa, 2) !== gRid && seen.length === 6)
    ok('(rid) a rid is never reused: the same account rejoining, and a new guest in the old guest\'s place, each get a new one -- six rows, six rids');
  else fail('(rid) reused: ' + JSON.stringify({ shape: shape(wa), bOld, bNew: rows(wa)[1], gRid, g2: rows(wa)[2], seen }));
  } catch (e) { fail('(rid) kick by rid and reuse: ' + e.message); }
}

// ---- (rid-k) A KICK AIMED BEFORE THE ROSTER MOVED REMOVES NOBODY WRONGLY -----
// The leader's box reads a rid off the roster on screen and the frame is on
// the wire while other players come and go. It lands on the row it was aimed
// at wherever that row now stands, or on nobody.
{
  const rows = (w) => (sqat(w, 'state').members || []);
  const ridAt = (w, i) => { const r = rows(w)[i]; if (!r || typeof r.rid !== 'string') throw new Error('(rid-k) no rid at row ' + i + ' of ' + JSON.stringify(rows(w))); return r.rid; };
  const shape = (w) => rows(w).map((m) => m.id || 'guest');
  const three = async () => {
    const S = sqSocial(sqstore());
    const wa = sqUp(S, sqws(SQA)), g1 = sqws(null), g2 = sqws(null);
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(g1, { type: 'squad', op: 'join', code, name: 'G1', skin: 'gold' });
    await S.handle(g2, { type: 'squad', op: 'join', code, name: 'G2', skin: 'gold' });
    return { S, wa, g1, g2, code };
  };
  // (i) Aimed at row 2; row 1 leaves first. The kick still lands on the guest
  //     it was aimed at, who now stands at row 1.
  try {
    const { S, wa, g1, g2 } = await three();
    const aim = ridAt(wa, 2);
    await S.handle(g1, { type: 'squad', op: 'leave' });
    g2.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'kick', rid: aim, id: 'k1' });
    const r = sqlast(wa, 'state');
    if (r && r.id === 'k1' && same(shape(wa), [SQA]) && same(sqf(g2), [{ type: 'squad', op: 'ended', reason: 'kicked' }]))
      ok('(rid-k) a kick aimed at a guest lands on that guest after a row above them has left');
    else fail('(rid-k) moved target: ' + JSON.stringify({ leader: wa.rx.slice(-2), g2: g2.rx }));
  } catch (e) { fail('(rid-k) moved target: ' + e.message); }
  // (ii) Aimed at row 2; that guest leaves and ANOTHER guest joins into the
  //      same place, so the roster has the same shape as when it was aimed.
  //      The old handle names nobody now: refused, and the new guest stays.
  try {
    const { S, wa, g2, code } = await three();
    const aim = ridAt(wa, 2);
    await S.handle(g2, { type: 'squad', op: 'leave' });
    const g3 = sqws(null);
    await S.handle(g3, { type: 'squad', op: 'join', code, name: 'G3', skin: 'gold' });
    const shaped = shape(wa);
    wa.rx.length = 0; g3.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'kick', rid: aim, id: 'k2' });
    const r = sqlast(wa);
    if (same(shaped, [SQA, 'guest', 'guest']) && r && r.op === 'kick' && r.error === 'no_such_member' && r.id === 'k2'
      && wa.rx.length === 1 && g3.rx.length === 0 && S.hasSquad(code))
      ok('(rid-k) a kick aimed at a guest who has since left is refused no_such_member, and the guest now standing in that place stays');
    else fail('(rid-k) stale guest aim: ' + JSON.stringify({ shaped, leader: wa.rx, g3: g3.rx }));
  } catch (e) { fail('(rid-k) stale guest aim: ' + e.message); }
  // (iii) The same for an ACCOUNT row: the member leaves and comes straight
  //       back, which is a new row. The aim was at the row that left.
  try {
    const S = sqSocial(sqstore());
    const wa = sqUp(S, sqws(SQA)), wb = sqUp(S, sqws(SQB));
    await S.handle(wa, { type: 'squad', op: 'create' });
    const code = sqat(wa, 'state').code;
    await S.handle(wb, { type: 'squad', op: 'join', code, name: 'B', skin: 'olive' });
    const aim = ridAt(wa, 1);
    await S.handle(wb, { type: 'squad', op: 'leave' });
    await S.handle(wb, { type: 'squad', op: 'join', code, name: 'B', skin: 'olive' });
    wa.rx.length = 0; wb.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'kick', rid: aim, id: 'k3' });
    const r = sqlast(wa);
    if (r && r.op === 'kick' && r.error === 'no_such_member' && r.id === 'k3' && wa.rx.length === 1 && wb.rx.length === 0)
      ok('(rid-k) a kick aimed at a member who has since left and rejoined is refused, and they stay');
    else fail('(rid-k) stale account aim: ' + JSON.stringify({ leader: wa.rx, member: wb.rx }));
  } catch (e) { fail('(rid-k) stale account aim: ' + e.message); }
  // NOTHING ELSE NAMES A ROW. No handle, a handle that is not a string or not
  // one of this squad's, the leader's own, one from another squad -- and the
  // two forms a kick used to take, an index and an account id -- all kick
  // nobody, and each answer carries the frame's correlation id.
  try {
    const { S, wa, g1, g2, code } = await three();
    const wb = sqUp(S, sqws(SQB));
    await S.handle(wb, { type: 'squad', op: 'join', code, name: 'B', skin: 'olive' });
    const wz = sqUp(S, sqws(SQE));
    await S.handle(wz, { type: 'squad', op: 'create' });
    const other = ridAt(wz, 0), mine = ridAt(wa, 0), real = ridAt(wa, 3), g1Rid = ridAt(wa, 1);
    const junk = [{}, { rid: '' }, { rid: 'x' }, { rid: 0 }, { rid: 42 }, { rid: null }, { rid: {} }, { rid: [real] }, { rid: true },
      { rid: 'constructor' }, { rid: '__proto__' }, { rid: 'toString' }, { rid: real.toUpperCase() }, { rid: real + ' ' },
      { rid: mine }, { rid: other }, { i: 1 }, { i: 2 }, { id: SQB }];
    const missed = [];
    for (const [n, j] of junk.entries()) {
      SQCLOCK += 3000;                  // one squad token back per kick: the bucket is 20 a minute
      wa.rx.length = 0;
      const frame = Object.assign({ type: 'squad', op: 'kick' }, j, 'id' in j ? {} : { id: 'j' + n });
      await S.handle(wa, frame);
      const r = sqlast(wa);
      if (!(wa.rx.length === 1 && r.op === 'kick' && r.error === 'no_such_member' && r.id === frame.id)) missed.push([j, wa.rx]);
    }
    // The roster as it stands now, asked for: a refusal pushes none.
    wa.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'resume', id: 'now' });
    if (!missed.length && same(shape(wa), [SQA, 'guest', 'guest', SQB]) && sqf(g1, 'ended').length === 0 && sqf(g2, 'ended').length === 0 && sqf(wb, 'ended').length === 0)
      ok('(rid-k) no rid, a junk one, the leader\'s own, another squad\'s, an index or an account id: every such kick is refused no_such_member and removes nobody');
    else fail('(rid-k) junk targets: ' + JSON.stringify({ missed, shape: shape(wa), rx: wa.rx }));
    SQCLOCK += 60000;
    // A REAL HANDLE DOES NOT MAKE A MEMBER A LEADER.
    wb.rx.length = 0;
    await S.handle(wb, { type: 'squad', op: 'kick', rid: g1Rid, id: 'm' });
    if (wb.rx.length === 1 && sqat(wb).error === 'not_leader' && sqat(wb).id === 'm' && sqf(g1, 'ended').length === 0 && rows(wa).length === 4)
      ok('(rid-k) a member sending a real rid is answered not_leader, and nobody is removed');
    else fail('(rid-k) member with a real rid: ' + JSON.stringify(wb.rx));
  } catch (e) { fail('(rid-k) junk targets and a member\'s kick: ' + e.message); }
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
  if (arow && arow.id === 'a' && arow.you === 1 && RID32.test(arow.members[1].rid)
    && JSON.stringify(norid(arow.members[1])) === JSON.stringify({ id: null, callsign: null, guest: true, online: true, ready: false, dropped: false })
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
  const gRid = ridOf(wa2, 2);
  wa2.rx.length = 0;
  await S.handle(wa2, { type: 'squad', op: 'kick', rid: gRid, id: 'd2' });
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
      && JSON.stringify(r.members.map(norid)) === JSON.stringify([{ id: SQA, callsign: null, guest: false, online: true, ready: false, dropped: false }]))
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
      && JSON.stringify((mine.members || []).map(norid)) === JSON.stringify(nulls)
      && host.code === other && host.you === 0 && JSON.stringify((host.members || []).map(norid)) === JSON.stringify(nulls)
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
    const bRid = ridOf(wa, SQB);
    wa.rx.length = 0; wb.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'kick', rid: bRid, id: 'k' });
    const k = wa.rx[0] || {};
    if (wa.rx.length === 1 && k.op === 'state' && k.id === 'k' && k.members.length === 1 && k.members[0].callsign === null
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
    const gRid = ridOf(wa, 2), bRid = ridOf(wa, SQB);
    wa.userId = SQE; wa.isGuest = false; S.onAuth(wa);
    wa.rx.length = 0; g.rx.length = 0;
    await S.handle(wa, { type: 'squad', op: 'kick', rid: gRid, id: 'k' });
    await S.handle(wa, { type: 'squad', op: 'kick', rid: bRid, id: 'k2' });
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
    const hRid = ridOf(wb, 1);                          // h's row, as squad two's leader sees it
    failedDoor(() => { g.userId = SQB; g.isGuest = false; S.onAuth(g); });   // g's account now leads squad two, elsewhere (door failed: E8)
    g.rx.length = 0; h.rx.length = 0;
    await S.handle(g, { type: 'squad', op: 'kick', rid: hRid, id: 'k' });
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
    failedDoor(() => { g.userId = SQB; g.isGuest = false; S.onAuth(g); });   // the guest row stands (door failed: E8)
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
    const ra = wa.rx, gRid = ridOf(wa, 2);
    Object.assign(wa, { rx: { push() { throw new Error('half-closed'); } } });
    wc.rx.length = 0;
    let threw = null;
    try { await S.handle(wa, { type: 'squad', op: 'kick', rid: gRid, id: 'k' }); } catch (e) { threw = e; }
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
// negative, and then values that are NOT integers — a numeric string, an
// array, a fraction, a boolean — plus an integer past 2^32. Until the
// whole-branch fix wave createRoom coerced with `| 0`, so '3' and [3] seated
// three, 3.5 seated three and 2^32+3 wrapped round to three. Now it reads a
// count the way the squad's mode op does (NEVER COERCED): anything that is
// not an integer is no choice at all and seats the mode's own default. The
// integers keep their old clamp, so no honest client's room changes.
const SEAT_ASKED = [undefined, 0, 1, 2, 3, 4, 5, 6, -1, '3', [3], 3.5, true, 2 ** 32 + 3];
const SEAT_MATRIX = [
  ['duel',   [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
  ['ffa',    [4, 4, 2, 2, 3, 4, 4, 4, 2, 4, 4, 4, 4, 4]],
  ['boss',   [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
  ['aliens', [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
  ['golf',   [2, 2, 1, 2, 3, 4, 4, 4, 1, 2, 2, 2, 2, 4]],
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
        bad++; fail(`(s3a) ${mode} max=${JSON.stringify(mx)} seated ${r && r.mode}/${r && r.max}, wanted ${mode}/${wants[i]}`);
      }
      handleClientMessage(w, { type: 'leave' });
    });
  }
  if (!bad) ok(`(s3a) createRoom seats exactly what the ternary seated for an integer, and the mode's default for anything else — 5 modes x ${SEAT_ASKED.length} requested counts`);
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
  failedDoor(() => { h.userId = SQD; h.isGuest = false; S.onAuth(h); });   // the guest row stands (door failed: E8)
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
// pick screen.
// CHANGED BY U3 (owner, 2026-10-06: "every change clears every ready"): this
// used to pin that the switch stood down ONLY those members, so five picks
// readied for a duel stayed ready into a free-for-all. A Ready now counts the
// squad into its match on its own, so every change stands every member down,
// a rack that still fits included; (rdy-c) pins that a frame changing nothing
// stands nobody down.
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
  if (same([r0, r1, r2, r3, r4], [[true, true, true], [false, false, false], [false, false, false], [false, false, false], [false, false, false]]))
    ok('(s3i) arming another mode stands every member down — five to five, five to seven and seven to five alike');
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
  failedDoor(() => { g.userId = SQB; g.isGuest = false; S.onAuth(g); });   // the guest row stands (door failed: E8)
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
  failedDoor(() => { g.userId = SQB; g.isGuest = false; S.onAuth(g); });   // the guest row stands (door failed: E8)
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
    // anybody, and the read is not counted in `calls`. It fails only inside
    // failedDoor (top of file).
    st.blockIdsOf = async () => { if (DOOR_FAILS) throw new Error('sb GET 500'); return { blocked: [], blockedBy: [] }; };
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
    // Each row's handle (D-UI-3), read before the frames are cleared, for a
    // check that kicks: account id -> rid.
    const rids = Object.fromEntries(((last5(wl, 'state') || {}).members || []).map((r) => [r.id, r.rid]));
    wl.rx.length = 0; wm.rx.length = 0;
    return { wl, wm, code, rids };
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
    // signs in mid-squad (no hook: it had no id). For 'another squad' the
    // door's read fails, the one way that guest row still stands (E8).
    if (shape === 'another squad') failedDoor(() => switch5(S, g, MEM)); else switch5(S, g, MEM);
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
    await S.handle(wl, { type: 'squad', op: 'kick', rid: ridOf(wl, MEM) });      // removed while dropped
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
    await S.handle(wl, { type: 'squad', op: 'kick', rid: ridOf(wl, THIRD) });
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
  // socket must see it (ownFields: `you` is its row), with the request's id;
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
    failedDoor(() => switch5(S, g, THIRD));   // the guest row stands (door failed: E8)
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

  // ---- (held) D-UI-1: EVERY STATE FRAME SAYS WHETHER THIS SOCKET HOLDS A ROW -
  // A bare resume from a second device only LOOKS while a live socket holds
  // the account's row (d12b): it is answered the roster, the row stays put,
  // and no push will ever reach the looker. `you` cannot tell the two apart —
  // it is the account's row either way — so the frame also carries `held`:
  // true iff THIS socket is the one on a row (m.ws === ws). Per destination,
  // like `you`, on the reply and on every fan-out. The box renders held:false
  // as "Your squad is open on another device." and offers no controls.
  const STATE_KEYS = ['code', 'fits', 'held', 'leader', 'max', 'members', 'mode', 'op', 'tees', 'type', 'you'];
  const keysOf = (f) => Object.keys(f || {}).filter((k) => k !== 'id').sort();
  {
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, wm, code } = await pair5(S);
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'resume', id: 'h1' });
    const look = wm2.rx.find((f) => f.id === 'h1') || {};
    await S.handle(wm, { type: 'squad', op: 'resume', id: 'h2' });
    const own = wm.rx.find((f) => f.id === 'h2') || {};
    if (look.op === 'state' && look.you === 1 && look.held === false && own.op === 'state' && own.you === 1 && own.held === true)
      ok('(held) a look-only bare resume is answered held:false, and the socket holding the row is answered held:true');
    else fail('(held) look vs holder: ' + JSON.stringify({ look, own }));
    if (same(keysOf(look), STATE_KEYS) && same(keysOf(own), STATE_KEYS))
      ok('(held) the resume reply carries exactly the snapshot\'s fields, `you` and `held`, and nothing else');
    else fail('(held) reply keys: ' + JSON.stringify([keysOf(look), keysOf(own)]));
    // ONE FAN-OUT, EACH SOCKET ITS OWN VALUE. The leader's second device holds
    // no row but may still arm a mode (ledSquad goes by the account); the
    // actor is always answered the roster (pushSquad), so that one change
    // reaches a socket that holds no row alongside two that do. The looker
    // holds none either, and is on no fan-out at all.
    wl.rx.length = 0; wm.rx.length = 0; wm2.rx.length = 0;
    const wl2 = up5(S, mkws5(LEAD));
    await S.handle(wl2, { type: 'squad', op: 'mode', mode: 'duel', id: 'h4' });
    const got = (w) => sq5(w, 'state').map((f) => [f.you, f.held]);
    if (same(got(wl), [[0, true]]) && same(got(wm), [[1, true]]) && same(got(wl2), [[0, false]]) && sq5(wm2).length === 0
      && [wl, wm, wl2].every((w) => same(keysOf(sq5(w, 'state')[0]), STATE_KEYS)))
      ok('(held) one fan-out tells each socket its own held: true to the two on rows, false to the leader\'s second device that armed the mode');
    else fail('(held) fan-out: ' + JSON.stringify({ lead: got(wl), mem: got(wm), second: got(wl2), looker: sq5(wm2) }));
    // A RESUME NAMING THE CODE TAKES THE ROW (d12b): that answer is held:true,
    // and from then on the pushes this socket gets say so too.
    wl.rx.length = 0; wm.rx.length = 0; wm2.rx.length = 0;
    await S.handle(wm2, { type: 'squad', op: 'resume', code, id: 'h3' });
    const took = wm2.rx.find((f) => f.id === 'h3') || {};
    await S.handle(wl, { type: 'squad', op: 'mode', mode: 'duel' });
    const pushed = sq5(wm2, 'state').filter((f) => f.id === undefined), lead = sq5(wl, 'state');
    if (took.held === true && took.you === 1 && pushed.length === 1 && pushed[0].held === true && pushed[0].you === 1
      && lead.length === 1 && lead[0].held === true && lead[0].you === 0 && same(keysOf(pushed[0]), STATE_KEYS))
      ok('(held) a resume that takes the row is answered held:true, and every push after it says held:true to each holder');
    else fail('(held) take-over: ' + JSON.stringify({ took, pushed, lead }));
  }
  {
    // THE RESUME'S OWN FAN-OUT ("a member who was dropped is back") is built
    // from the resumer's frame, so each destination's `held` must be its own
    // there too, not the resumer's. They differ when the resumer loses its row
    // inside the names read: here the leader kicks the member it is resuming.
    const st = store5();
    const S = social5(st, { cw: mkClockwork() });
    const { wl, wm, code } = await pair5(S);
    close5(S, wm);
    await flush5();
    const wm2 = up5(S, mkws5(MEM));
    const release = st.hold();
    const p = S.handle(wm2, { type: 'squad', op: 'resume', code, id: 'h5' });
    await st.entered;
    await S.handle(wl, { type: 'squad', op: 'kick', rid: ridOf(wl, MEM) });
    wl.rx.length = 0;
    release();
    await p;
    const back = sq5(wl, 'state');
    const ans = wm2.rx.find((f) => f.id === 'h5') || {};
    if (back.length === 1 && back[0].you === 0 && back[0].held === true && back[0].members.length === 1 && ans.op === 'gone')
      ok('(held) the resume\'s own fan-out tells each member its own held, not the resumer\'s');
    else fail('(held) resume fan-out: ' + JSON.stringify({ back, ans }));
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
    // squad by the time the frame is built — ownFields' `you` of -1 — and
    // is answered gone rather than handed the roster it was just removed from.
    const st = store5();
    const S = social5(st, { cw: mkClockwork() });
    const { wl, wm, code, rids } = await pair5(S);
    if (typeof rids[MEM] !== 'string') throw new Error('(d13) no rid for the member: ' + JSON.stringify(rids));
    const release = st.hold();
    const p = S.handle(wm, { type: 'squad', op: 'resume', code, id: 'r8' });
    const inside = await within5(st.entered);
    const k = S.handle(wl, { type: 'squad', op: 'kick', rid: rids[MEM] });
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
    const { wm, rids } = await pair5(S);
    if (typeof rids[MEM] !== 'string') throw new Error('(d15) no rid for the member: ' + JSON.stringify(rids));
    const wl2 = up5(S, mkws5(LEAD));
    await S.handle(wl2, { type: 'squad', op: 'kick', rid: rids[MEM] });
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
    // proved callsign. CHANGED BY TASK 9's FIX PASS (D-UI-3): it is the SAME
    // ROW, so it keeps the handle it had as a guest, and a kick the leader
    // aimed at the guest row before the sign-in still lands on it.
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, code } = await pair5(S);
    const g = mkws5(null);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold' });
    const asGuest = ridOf(wl, 2);
    switch5(S, g, THIRD);
    await flush5();
    const shown = last5(wl, 'state') || {};
    g.rx.length = 0;
    await S.handle(wl, { type: 'squad', op: 'kick', rid: asGuest });
    if (shown.members && shown.members[2] && shown.members[2].id === THIRD && shown.members[2].callsign === 'Crater Two'
      && shown.members[2].guest === false && shown.members[2].rid === asGuest
      && same(sq5(g, 'ended'), [{ type: 'squad', op: 'ended', reason: 'kicked' }]))
      ok('(d18) a guest who signs in with no row elsewhere becomes that account\'s row: its callsign is shown, it keeps the rid it had as a guest, and a kick by that rid lands');
    else fail('(d18) adopted row: ' + JSON.stringify({ asGuest, shown: shown.members, g: g.rx }));
  }
  {
    // (rid-d) D-UI-3: A DROP AND A RESUME ARE THE SAME ROW. The handle the
    // squad knew the member by is the one shown while they are dropped and the
    // one shown once a new socket of theirs takes the row back -- to the
    // leader and to the member's own new socket alike.
    const S = social5(store5(), { cw: mkClockwork() });
    const { wl, wm, code, rids } = await pair5(S);
    const mem = (w) => { const f = last5(w, 'state'); return (f && f.members.find((r) => r.id === MEM)) || null; };
    close5(S, wm);
    await flush5();
    const dropped = mem(wl);
    const wm2 = up5(S, mkws5(MEM));
    await S.handle(wm2, { type: 'squad', op: 'resume', code, id: 'back' });
    await flush5();
    const back = mem(wl), own = mem(wm2);
    if (RID32.test(rids[MEM] || '') && dropped && dropped.dropped === true && dropped.rid === rids[MEM]
      && back && back.dropped === false && back.rid === rids[MEM] && own && own.rid === rids[MEM])
      ok('(rid-d) a member keeps their rid while dropped and after a new socket of theirs resumes the row');
    else fail('(rid-d) drop and resume: ' + JSON.stringify({ first: rids[MEM], dropped, back, own }));
  }
  {
    // THE VARIANT TASK 2 ACCEPTED: g holds a guest row in X and signs in as
    // MEM, who LEADS squad Y from another device. Since E8 it stands only
    // until the sign-in door lets MEM in (then the guest row leaves X);
    // here the door's read fails, so it stands. (It is what (h9), (s3l) and
    // (st6) are built on.) From it, MEM's other device joining X would put
    // the account in X twice, so that join is refused — and refused before
    // anything moves, so Y keeps its leader.
    const S = social5(store5(), { cw: mkClockwork() });
    const wl = up5(S, mkws5(LEAD)), wm = up5(S, mkws5(MEM));
    await S.handle(wl, { type: 'squad', op: 'create' });
    const X = last5(wl, 'state').code;
    await S.handle(wm, { type: 'squad', op: 'create' });
    const Y = last5(wm, 'state').code;
    const g = mkws5(null);
    await S.handle(g, { type: 'squad', op: 'join', code: X, name: 'G', skin: 'gold' });
    failedDoor(() => switch5(S, g, MEM));   // the guest row stands (door failed: E8)
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

  // ---- (gk) a guest row's resume secret (E1, the whole-branch fix wave) ------
  // A guest's squad identity is its socket, so a guest who left a match by a
  // page load (Back to menu) came back on a new socket that matched no row,
  // and fell out of the squad on every match. Now each guest row has a random
  // secret, `gk`, sent ONLY to the socket that holds that row, in its own
  // state frames; the tab keeps it (sessionStorage) and presents it with the
  // code in `resume`. That re-attaches the row to the new socket within the
  // drop window: the same row (same rid), the window's sweep cancelled, the
  // members told it is back. The secret is never on any other member's
  // frame and is never an account id; a wrong one answers what no secret
  // answers.
  {
    // THE MACHINE'S HALF, resumeGuest: only a guest row, keyed by a socket,
    // moves, and never onto a socket that already holds or keys a row.
    const M = createSquads({ now: now5 });
    const s1 = mkws5(null), s2 = mkws5(null), s3 = mkws5(null), lead = mkws5(LEAD);
    const sq = M.create(mem5(LEAD, lead));
    M.join(sq.code, mem5(null, s1));
    M.join(sq.code, mem5(null, s2));
    const r = [
      M.resumeGuest(LEAD, s3),                     // an account key: null
      M.resumeGuest(s1, s2),                       // onto a socket holding a row: null
      M.resumeGuest(s1, null),                     // no socket: null
    ];
    const kept = sq.members.map((m) => m.ws);
    const moved = M.resumeGuest(s1, s3);
    const row = sq.members[1];
    if (same(r, [null, null, null]) && kept[1] === s1 && kept[2] === s2 && moved === sq && row.key === s3 && row.ws === s3 && M.keyOfSocket(s3) === s3 && M.memberOf(s1) === null && M.memberOf(s3).member === row)
      ok('(gk) resumeGuest moves only a guest row, rekeyed to its new socket, and never onto a socket that already holds one');
    else fail('(gk) resumeGuest: ' + JSON.stringify({ r, moved: moved === sq, key: row.key === s3 }));
  }
  {
    const GK = /^[0-9a-f]{32}$/;
    const cw = mkClockwork();
    const S = social5(store5(), { cw });
    const { wl, wm, code } = await pair5(S);
    const g = mkws5(null);
    await S.handle(g, { type: 'squad', op: 'join', code, name: 'G', skin: 'gold', id: 'j' });
    const mine = g.rx.find((f) => f.id === 'j') || {};
    const gk = mine.gk;
    await S.handle(wl, { type: 'squad', op: 'mode', mode: 'ffa' });           // a push: everybody's frames
    const others = JSON.stringify([...wl.rx, ...wm.rx]);
    const ownPush = last5(g, 'state') || {};
    const rid = (mine.members || [])[2] && mine.members[2].rid;
    if (typeof gk === 'string' && GK.test(gk) && ownPush.gk === gk && !others.includes(gk) && !/"gk"/.test(others)
      && ![LEAD, MEM, THIRD].includes(gk) && !/^[0-9a-f-]{36}$/.test(gk))
      ok('(gk) a guest row\'s secret reaches only the socket on that row, in its own state frames — no other member\'s frame carries it or a gk field at all — and it is no account id');
    else fail('(gk) the secret: ' + JSON.stringify({ gk, ownPush: ownPush.gk, leaked: others.includes(gk), field: /"gk"/.test(others) }));

    // THE ROUND TRIP: the tab's socket goes (a page load), and a new socket,
    // with no account, presents the code and the secret.
    close5(S, g);
    await flush5();
    const g2 = mkws5(null);
    wl.rx.length = 0; wm.rx.length = 0;
    const armedBefore = cw.pending().length;
    await S.handle(g2, { type: 'squad', op: 'resume', code, gk, id: 'back' });
    await flush5();
    const armedAfter = cw.pending().length;
    const back = g2.rx.find((f) => f.id === 'back') || {};
    const row = (back.members || [])[2] || {};
    const seen = last5(wl, 'state') || { members: [] };
    const seenRow = seen.members[2] || {};
    if (back.op === 'state' && back.code === code && back.you === 2 && back.held === true && back.gk === gk && row.rid === rid && row.dropped === false
      && seenRow.rid === rid && seenRow.dropped === false && !JSON.stringify([...wl.rx, ...wm.rx]).includes(gk))
      ok('(gk) a new socket presenting the code and the secret gets the same row back: held, the same rid, no longer dropped, and every member is shown it back');
    else fail('(gk) resume by secret: ' + JSON.stringify({ back, seen: seen.members }));
    // THE WINDOW'S SWEEP WAS CANCELLED: past DROP_MS the row is still there.
    CLOCK5 += 60000;
    cw.fire();
    await flush5();
    await S.handle(wl, { type: 'squad', op: 'resume', id: 'after' });
    const after = wl.rx.find((f) => f.id === 'after') || {};
    if ((after.members || []).length === 3 && after.members[2].rid === rid && armedBefore === 1 && armedAfter === 0)
      ok('(gk) and the drop window armed for the old socket is stood down: no timer is left for it, and the row is not swept');
    else fail('(gk) the row after the window: ' + JSON.stringify({ members: after.members, armedBefore, armedAfter }));

    // A WRONG SECRET, OR NONE, OR ONE FOR ANOTHER CODE: exactly gone.
    const probe = async (frame) => { const w = mkws5(null); await S.handle(w, { type: 'squad', ...frame }); return w.rx; };
    const GONE = (id) => [{ type: 'squad', op: 'gone', id }];
    const wrong = await probe({ op: 'resume', code, gk: gk.replace(/./, (c) => (c === 'a' ? 'b' : 'a')), id: 'x' });
    const none = await probe({ op: 'resume', code, id: 'x' });
    const junk = await probe({ op: 'resume', code, gk: [gk], id: 'x' });
    const elsewhere = await probe({ op: 'resume', code: 'ZZZZ', gk, id: 'x' });
    if (same(wrong, GONE('x')) && same(none, GONE('x')) && same(junk, GONE('x')) && same(elsewhere, GONE('x')))
      ok('(gk) a wrong secret, no secret, a secret that is not a string, or the secret with another code, all answer exactly gone');
    else fail('(gk) misses: ' + JSON.stringify({ wrong, none, junk, elsewhere }));

    // A LIVE ROW IS TAKEN OVER, as a seat token takes a seat: a page load can
    // reach the server before the old socket's close does.
    const g3 = mkws5(null);
    await S.handle(g3, { type: 'squad', op: 'resume', code, gk, id: 'take' });
    const took = g3.rx.find((f) => f.id === 'take') || {};
    if (took.you === 2 && took.held === true && same(sq5(g2).slice(-1), [{ type: 'squad', op: 'ended', reason: 'elsewhere' }]))
      ok('(gk) a secret presented while the row\'s socket still looks live takes the row over, and that socket is told ended:elsewhere');
    else fail('(gk) takeover: ' + JSON.stringify({ took, g2: sq5(g2).slice(-2) }));

    // A SOCKET THAT ALREADY HOLDS A ROW keeps it: one socket, one row.
    const w4 = mkws5(null);
    await S.handle(wm, { type: 'squad', op: 'create' });                       // MEM moves to a squad of their own
    const other = last5(wm, 'state').code;
    await S.handle(w4, { type: 'squad', op: 'join', code: other, name: 'H', skin: 'gold' });
    w4.rx.length = 0;
    await S.handle(w4, { type: 'squad', op: 'resume', code, gk, id: 'own' });
    const kept = w4.rx.find((f) => f.id === 'own') || {};
    await S.handle(wl, { type: 'squad', op: 'resume', id: 'still' });
    const still = wl.rx.find((f) => f.id === 'still') || {};
    if (kept.code === other && (still.members || []).length === 2 && still.members[1].rid === rid && sq5(g3).every((f) => f.op !== 'ended'))
      ok('(gk) a socket that already holds a row is answered its own squad, and the secret moves nothing');
    else fail('(gk) a socket with a row of its own: ' + JSON.stringify({ kept: kept.code, other, still: still.members }));

    // PAST THE WINDOW the row is gone, and so is the secret's use.
    close5(S, g3);
    await flush5();
    CLOCK5 += 60000;
    cw.fire();
    await flush5();
    const late = await probe({ op: 'resume', code, gk, id: 'x' });
    if (same(late, GONE('x'))) ok('(gk) once the window has swept the row, the secret answers gone');
    else fail('(gk) after the sweep: ' + JSON.stringify(late));
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
  // Built in the TWO-SQUADS state (see claimOnSignIn), which since E8 stands
  // only while the sign-in door has not let the account in: device 1 joined
  // C's squad X as a guest and then signed in as A (its door's read failing),
  // while A leads squad Y from device 2. The Invite button pressed on
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
    // The door's read fails, the one way this state still stands (E8).
    st.boom.add('blockIdsOf');
    wa1.authGen = 1; wa1.userId = A; wa1.isGuest = false; S.onAuth(wa1);
    st.boom.delete('blockIdsOf');
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
    // Each row's handle (D-UI-3), read off the leader's last roster before the
    // frames are cleared, for a twin that kicks: account id -> rid.
    const rids = Object.fromEntries(((last6(w[lead], 'squad', 'state') || {}).members || []).map((r) => [r.id, r.rid]));
    clear6(...Object.values(w));
    return { st, S, w, code, rids, mark: TRACE6.length };
  };
  // A twin's kick, by the handle world6 read. THROWS when there is none, so a
  // twin never sends `rid: undefined` and passes for a refusal.
  const kick6 = (t, by, id) => {
    if (typeof t.rids[id] !== 'string') throw new Error('no rid for ' + id + ' in ' + JSON.stringify(t.rids));
    return t.S.handle(t.w[by], { type: 'squad', op: 'kick', rid: t.rids[id] });
  };
  // A frame with its squad code blanked, so two worlds can be compared. ONLY
  // A CODE THE FRAME CARRIES is blanked: a frame without one is compared as
  // it is, so a code that appears where it should not is a difference.
  // AND EACH ROW'S `rid` (D-UI-3, task 9's fix pass): one row's handle in
  // ONE world, so it differs between twins exactly as the code does. It is
  // not blanked to nothing: each handle becomes the order in which it first
  // appears in what is being compared, so twins whose rows keep -- or change
  // -- their handles differently still differ.
  const ridTok6 = (seen, r) => { if (!seen.has(r)) seen.set(r, 'rid' + seen.size); return seen.get(r); };
  const blank6 = (f, seen = new Map()) => {
    const g = 'code' in f ? { ...f, code: '-' } : f;
    return Array.isArray(g.members) ? { ...g, members: g.members.map((m) => (m && 'rid' in m ? { ...m, rid: ridTok6(seen, m.rid) } : m)) } : g;
  };
  // What `socks` received from `mark` on, in the order it was sent, each
  // frame tagged with its socket's place in the list and its code blanked.
  const seq6 = (mark, socks) => { const seen = new Map(); return TRACE6.slice(mark).filter(([w]) => socks.includes(w)).map(([w, f]) => socks.indexOf(w) + ':' + JSON.stringify(blank6(f, seen))); };
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
    if (last6(w[B], 'friends')) ok('(blk-a) and their socket WAS live: the friends snapshot a block pushes when it ends a friendship arrived on it');
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
    await kick6(t, A, B);
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
    st.boom.add('blockIdsOf');                  // the door's read fails: the state stands (E8)
    wa1.authGen = 1; wa1.userId = A; wa1.isGuest = false; S.onAuth(wa1);
    st.boom.delete('blockIdsOf');
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
    st.boom.add('blockIdsOf');                  // the door's read fails: the row stands (E8)
    wb2.authGen = 1; wb2.userId = B; wb2.isGuest = false; S.onAuth(wb2);
    st.boom.delete('blockIdsOf');
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
    st.boom.add('blockIdsOf');                  // the door's read fails: the row stands (E8)
    wa1.authGen = 1; wa1.userId = A; wa1.isGuest = false; S.onAuth(wa1);
    st.boom.delete('blockIdsOf');
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
  // Everything in it is memory, and it runs BEFORE the reply — as the row
  // lands, and on the catch path outside handleBlock's try: a throw that
  // escaped would reach handle()'s net and tell the blocker `unavailable` for
  // a block whose row has landed. The fault is a squad member whose identity
  // cannot be read.
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
  const joinWorld6 = async (rows = ROWS6) => {
    const st = t6store(rows);
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
    await kick6(t, A, B);
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
      const t = await world6(A, [B, C]);
      const { S, w, code } = t;
      const wb2 = up6(S, B);
      w[B].readyState = 3; S.onClose(w[B]);
      await settle6();
      clear6(w[A], w[C], wb2);
      const m = TRACE6.length;
      await act(S, w, t);
      const seq = seq6(m, [w[B], wb2, w[C]]);
      const wb3 = up6(S, B);
      await S.handle(wb3, { type: 'squad', op: 'resume', code, id: 'rs' });
      await S.handle(w[C], { type: 'squad', op: 'resume', id: 'rc' });
      return { wb2, seq, gone: ans6(wb3, 'rs'), roster: ans6(w[C], 'rc') };
    };
    const blk = await run((S, w) => S.handle(w[A], { type: 'block', op: 'add', id: B }));
    const kick = await run(async (S, w, t) => { await kick6(t, A, B); await S.handle(w[A], { type: 'friend', op: 'remove', id: B }); });
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
    // delete is still out, and is still refused. The teardown ran as the row
    // landed, before B was in the squad, so a join the log missed would be
    // admitted and never removed.
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
    await t.S.handle(t.wa, { type: 'squad', op: 'kick', rid: ridOf(t.wa, 2) });
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
    // E's own door fails its read, so E's hello decides nothing either and
    // the row stands (E8 would otherwise take it out of the squad for E).
    g.st.boom.add('blockIdsOf'); hello6(g.S, wn, E); g.st.boom.delete('blockIdsOf');
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
    // block — is out, and the read lands while the block's removeFriendship
    // is held. The block's teardown ran as its row landed and found the row
    // (the socket already stands for B): it goes as a kick, still nameless,
    // the door's late read finds nothing left to judge, and B's name never
    // reaches A or C. The log's own part at the door, where the teardown
    // cannot see the row, is (i, b) and (lg-a iii).
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
      ok('(sg-e) a block naming the account that lands while the door reads removes the row as a kick, once, and its name never reached the squad');
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
    g.st.boom.add('blockIdsOf'); hello6(g.S, wn, B); g.st.boom.delete('blockIdsOf');   // the row stands (door failed: E8)
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
  // writes are out. The teardown ran as the row landed, before that hello,
  // so BOTH of the account's tabs were out of the squad by then (T6-R1-1):
  // the hello finds no row to take. (ii, b) The same hello while the block's
  // first read is out, before the row lands: the acting socket stands for D
  // by the time the teardown runs, so it no longer leads anywhere the
  // blocked account is, and the teardown still finds their shared squad.
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
      // Both tabs were torn out as the row landed, each told its own end once;
      // the hello as D came after, and found no row to take.
      const LEFT6 = { type: 'squad', op: 'ended', reason: 'left' };
      if (!(inside && st.blocks.has(GU + '>' + NN) && same6(ids6(x), [C, null]) && same6(got6(wg1, 'squad', 'ended'), [LEFT6]) && same6(got6(wg2, 'squad', 'ended'), [LEFT6]) && same6(lastSquad6(wg2), LEFT6) && !got6(wv, 'squad', 'ended').length))
        bad.push({ tabSignedIn: { inside, x, g1: wg1.rx, g2: wg2.rx, v: wv.rx } });
    }
    {
      // (ii, b) The hello as D lands while the block's FIRST read is out, so
      // the row has not landed yet: tab 1 is D's by the time it does (its
      // door lets D in, and the row is D's), and only tab 2 is torn out.
      const st = t6store(ROWS6);
      const S = mkSocial6(st);
      const wc = up6(S, C);
      const code = await create6(S, wc);
      const wg1 = up6(S, GU, true), wg2 = up6(S, GU, true), wv = up6(S, NN, true);
      for (const w of [wg1, wg2, wv]) await join6(S, w, code, 'Guest');
      clear6(wc, wg1, wg2, wv);
      const gate = st.hold('profileById');
      const pending = S.handle(wg1, { type: 'block', op: 'add', id: NN });
      const inside = await within6(gate.inside);
      if (inside) { hello6(S, wg1, D); await settle6(); }
      gate.release(); await pending;
      await settle6();
      await S.handle(wc, { type: 'squad', op: 'resume', id: 'r' });
      const x = ans6(wc, 'r');
      // wg2 also saw the roster tab 1's sign-in pushed; the one end is its own.
      if (!(inside && st.blocks.has(GU + '>' + NN) && same6(ids6(x), [C, D, null]) && same6(got6(wg2, 'squad', 'ended'), [{ type: 'squad', op: 'ended', reason: 'left' }]) && same6(lastSquad6(wg2), { type: 'squad', op: 'ended', reason: 'left' }) && !got6(wg1, 'squad', 'ended').length && !got6(wv, 'squad', 'ended').length))
        bad.push({ tabSignedInBeforeTheRow: { inside, x, g1: wg1.rx, g2: wg2.rx, v: wv.rx } });
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
      && roster && RID32.test(roster.members[2].rid) && same6(norid(roster.members[2]), { id: null, callsign: null, guest: true, online: true, ready: true, dropped: false })
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

  // ---- (sg-i) a door-failed row stays out of Start (D-BLOCK-3 H amended) ----
  // A leads X on ffa with C; wn joined with no account, and C and wn are
  // ready, so only the door stands between Start and a seat. Then (`sign`)
  // wn signs in as B while the store fails: the door fails to guest, and
  // the store is left failing. `row` is a block row written first.
  // seatSquad records the sockets it is handed.
  const failWorld6 = async (row, sign = true) => {
    const seated = [];
    const st = t6store(ROWS6);
    if (row) await st.addBlock(row[0], row[1]);
    const S = mkSocial6(st, { seatSquad: (seats) => { seated.push(seats.map((s) => s.ws)); return { ok: true, code: 'RM6I' }; } });
    const wa = up6(S, A), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    await S.handle(wa, { type: 'squad', op: 'mode', mode: 'ffa' });
    const wn = t6ws(null);
    await join6(S, wn, code, 'Bunker');
    await S.handle(wc, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    await S.handle(wn, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    if (sign) { st.boom.add('blockIdsOf'); hello6(S, wn, B); await settle6(); }
    // Each row's handle (D-UI-3), by index, read before the frames are cleared.
    const rids = ((last6(wa, 'squad', 'state') || {}).members || []).map((r) => r.rid);
    clear6(wa, wc, wn);
    st.calls.length = 0;
    return { st, S, wa, wc, wn, code, seated, rids };
  };
  const start6 = async (g, id) => { await g.S.handle(g.wa, { type: 'squad', op: 'start', loadout: RACK5, id }); return ans6(g.wa, id); };
  const OFF6 = (id) => ({ type: 'squad', op: 'start', error: 'member_offline', at: 2, id });
  const OK6 = (id) => ({ type: 'squad', op: 'start', ok: true, code: 'RM6I', id });
  const reads6 = (st) => st.calls.filter((c) => c === 'blockIdsOf').length;
  const roster6 = async (g, id) => { await g.S.handle(g.wc, { type: 'squad', op: 'resume', id }); return ans6(g.wc, id); };
  {
    // (i) A HAS BLOCKED B and the store still fails. Start is refused
    // member_offline at the row, twice: each refusal re-runs the door once,
    // and that read fails too. Nothing is seated, and B is named to nobody.
    const g = await failWorld6([A, B]);
    const s1 = await start6(g, 's1');
    await settle6();
    const s2 = await start6(g, 's2');
    await settle6();
    const failing = { s1, s2, reads: reads6(g.st), seated: g.seated.length, n: got6(g.wn, 'squad') };
    g.st.boom.delete('blockIdsOf');
    failing.x = ids6(await roster6(g, 'r1'));
    failing.named = shows6(g.wa, B) || shows6(g.wc, B);
    if (same6(failing.s1, OFF6('s1')) && same6(failing.s2, OFF6('s2')) && failing.reads === 2 && failing.seated === 0
      && !failing.n.length && same6(failing.x, [A, C, null]) && !failing.named)
      ok('(sg-i) a row whose door read failed is refused by Start member_offline at its index, every time, and nothing is seated');
    else fail('(sg-i) door-failed row at Start: ' + JSON.stringify(failing));
    // (ii) The store answers again. The next refused Start's re-run finds
    // the block: the row goes exactly as A kicking it by index would (the
    // twin), and the Start after that seats A and C, never wn.
    clear6(g.wa, g.wc, g.wn);
    const m = TRACE6.length;
    const s3 = await start6(g, 's3');
    await settle6();
    const mine = seq6(m, [g.wn, g.wc]);
    const s4 = await start6(g, 's4');
    const t = await failWorld6(null, false);
    const tm = TRACE6.length;
    if (typeof t.rids[2] !== 'string') throw new Error('(sg-i) no rid for row 2: ' + JSON.stringify(t.rids));
    await t.S.handle(t.wa, { type: 'squad', op: 'kick', rid: t.rids[2] });
    const twin = seq6(tm, [t.wn, t.wc]);
    if (same6(s3, OFF6('s3')) && mine.length === 2 && same6(mine, twin)
      && same6(s4, OK6('s4')) && g.seated.length === 1 && same6(g.seated[0].map((w) => [g.wa, g.wc].indexOf(w)), [0, 1]))
      ok('(sg-i) once the store answers, the refused Start\'s re-run finds the block and removes the row exactly as a kick; the pair is never seated');
    else fail('(sg-i) re-run finds a block: ' + JSON.stringify({ s3, mine, twin, s4, seated: g.seated.map((l) => l.length) }));
  }
  {
    // (iii) NO BLOCK: the refused Start's re-run reads once and lets B in —
    // the row is B's, by name, on every roster — and the next Start seats
    // all three.
    const g = await failWorld6(null);
    g.st.boom.delete('blockIdsOf');
    const s1 = await start6(g, 's1');
    await settle6();
    const reads = reads6(g.st);
    const after = last6(g.wc, 'squad', 'state');
    const s2 = await start6(g, 's2');
    if (same6(s1, OFF6('s1')) && reads === 1 && after && same6(ids6(after), [A, C, B]) && after.members[2].callsign === 'Bunker Nine'
      && same6(s2, OK6('s2')) && g.seated.length === 1 && g.seated[0].length === 3)
      ok('(sg-i) with no block the refused Start\'s re-run lets the account in: adopted, named, and the next Start seats everyone');
    else fail('(sg-i) re-run admits: ' + JSON.stringify({ s1, reads, after: after && after.members, s2, seated: g.seated.map((l) => l.length) }));
  }
  {
    // (iii, b) The socket is then B as a hello's door leaves it: B's next
    // hello, while the store fails, reads nothing and bars nothing.
    const g = await failWorld6(null);
    g.st.boom.delete('blockIdsOf');
    await start6(g, 's1');
    await settle6();
    g.st.calls.length = 0;
    g.st.boom.add('blockIdsOf');
    hello6(g.S, g.wn, B);
    await settle6();
    g.st.boom.delete('blockIdsOf');
    const reads = reads6(g.st);
    const s2 = await start6(g, 's2');
    if (reads === 0 && same6(s2, OK6('s2')) && g.seated.length === 1 && g.seated[0].length === 3)
      ok('(sg-i) a row the re-run let in is not read again on the account\'s next hello, and a store fault then bars nothing');
    else fail('(sg-i) re-hello after the re-run: ' + JSON.stringify({ reads, s2, n: got6(g.wn, 'squad') }));
  }
  {
    // (iii, c) B's next hello runs the door again too: the store answering,
    // it lets B in, and Start seats all three.
    const g = await failWorld6(null);
    g.st.boom.delete('blockIdsOf');
    hello6(g.S, g.wn, B);
    await settle6();
    const reads = reads6(g.st);
    const s1 = await start6(g, 's1');
    if (reads === 1 && same6(s1, OK6('s1')) && g.seated.length === 1 && g.seated[0].length === 3)
      ok('(sg-i) the account\'s next hello re-runs a failed door too, and once it lets the account in Start seats the row');
    else fail('(sg-i) hello re-runs the failed door: ' + JSON.stringify({ reads, s1, seated: g.seated.map((l) => l.length) }));
  }
  {
    // (iv) ONE READ PER ROW. While a refused Start's re-run is out, a second
    // refused Start starts no second read; the one read lets B in.
    const g = await failWorld6(null);
    g.st.boom.delete('blockIdsOf');
    const h = g.st.hold('blockIdsOf');
    const s1 = await start6(g, 's1');
    const inside = await within6(h.inside);
    const s2 = await start6(g, 's2');
    const during = reads6(g.st);
    h.release();
    await settle6();
    const s3 = await start6(g, 's3');
    if (inside && same6(s1, OFF6('s1')) && same6(s2, OFF6('s2')) && during === 1 && reads6(g.st) === 1 && same6(s3, OK6('s3')))
      ok('(sg-i) two Starts refused while a re-run is out start one read between them');
    else fail('(sg-i) two refused Starts: ' + JSON.stringify({ inside, s1, s2, during, reads: reads6(g.st), s3 }));
  }
  {
    // (v) A RE-RUN THAT FAILS IS CONTAINED. (a) B's door fails WITHOUT a
    // throw — its read and re-read each lose their log entries, as in
    // (sg-e ii) — and then the store fails: each refused Start's re-run
    // throws in its read, the row stays out of Start, and no rejection is
    // left unhandled. (b) The re-run finds A's block while the roster's name
    // read fails: the row still goes, as a kick.
    const a = await failWorld6(null, false);
    const o = outs6(a.S);
    const h = stale6(a.st, 'blockIdsOf');
    hello6(a.S, a.wn, B);
    let inside = await within6(h.inside), again = null;
    if (inside) { await blk6(a.S, o.e, B); await age6(a.S, o.n, B); again = staleFor6(a.st, 'blockIdsOf', B); } else h.restore();
    h.release();
    if (again) {
      inside = await within6(again.inside);
      if (inside) { await blk6(a.S, o.e, B); await age6(a.S, o.n, B); } else again.restore();
      again.release();
    }
    await settle6();
    a.st.boom.add('blockIdsOf');
    a.st.calls.length = 0;
    const stray = [];
    const onStray = (e) => stray.push(String((e && e.message) || e));
    process.on('unhandledRejection', onStray);
    const a1 = await start6(a, 's1');
    await settle6();
    const a2 = await start6(a, 's2');
    await settle6();
    process.off('unhandledRejection', onStray);
    a.st.boom.delete('blockIdsOf');
    if (inside && !stray.length && same6(a1, OFF6('s1')) && same6(a2, OFF6('s2')) && reads6(a.st) === 2 && !a.seated.length && !got6(a.wn, 'squad', 'ended').length)
      ok('(sg-i) a re-run whose read throws is contained: the row stays out of Start and nothing is left unhandled');
    else fail('(sg-i) re-run read throws: ' + JSON.stringify({ inside, stray, a1, a2, reads: reads6(a.st), seated: a.seated.length }));
    const b = await failWorld6([A, B]);
    b.st.boom.delete('blockIdsOf');
    b.st.boom.add('profilesByIds');
    const b1 = await start6(b, 's1');
    await settle6();
    b.st.boom.delete('profilesByIds');
    const xb = ids6(await roster6(b, 'r'));
    if (same6(b1, OFF6('s1')) && same6(got6(b.wn, 'squad'), [KICKED6]) && same6(xb, [A, C]))
      ok('(sg-i) a re-run that finds a block while the roster\'s name read fails still removes the row as a kick');
    else fail('(sg-i) re-run, names unread: ' + JSON.stringify({ b1, n: got6(b.wn, 'squad'), xb }));
  }
  {
    // (vi) THE RE-RUN CANCELS ON IDENTITY, as the door does. A has blocked B;
    // the socket signs out while the re-run's read is out. Nothing is removed
    // or claimed. The socket is nobody now, so no account's failed door holds
    // its row out of Start (a guest row, as any socket with no account).
    const g = await failWorld6([A, B]);
    g.st.boom.delete('blockIdsOf');
    const h = stale6(g.st, 'blockIdsOf');
    const s1 = await start6(g, 's1');
    const inside = await within6(h.inside);
    if (inside) { g.wn.authGen += 1; g.S.onClose(g.wn); g.wn.userId = null; g.wn.isGuest = false; } else h.restore();   // server.js's sign-out
    h.release();
    await settle6();
    const x = await roster6(g, 'r');
    if (inside && same6(s1, OFF6('s1')) && !got6(g.wn, 'squad', 'ended').length && same6(ids6(x), [A, C, null]) && !shows6(g.wa, B) && !shows6(g.wc, B))
      ok('(sg-i) a re-run whose socket signs out during its read removes and claims nothing');
    else fail('(sg-i) signed out during the re-run: ' + JSON.stringify({ inside, s1, n: got6(g.wn, 'squad'), x }));
    const s2 = await start6(g, 's2');
    if (same6(s2, OK6('s2')) && g.seated.length === 1 && g.seated[0].includes(g.wn))
      ok('(sg-i) and a socket signed out of the account is not held out of Start by that account\'s failed door');
    else fail('(sg-i) signed-out row at Start: ' + JSON.stringify({ s2, seated: g.seated.map((l) => l.length) }));
  }
  {
    // (vii) ONLY A DOOR-FAILED ROW IS RE-RUN. B's door failed and then the
    // socket closed: the row is dropped, Start refuses it as offline, and
    // runs no door for it.
    const g = await failWorld6(null);
    g.st.boom.delete('blockIdsOf');
    g.wn.readyState = 3; g.S.onClose(g.wn);
    await settle6();
    g.st.calls.length = 0;
    const s1 = await start6(g, 's1');
    await settle6();
    if (same6(s1, OFF6('s1')) && reads6(g.st) === 0)
      ok('(sg-i) a Start refused at a door-failed row that has dropped runs no door for it');
    else fail('(sg-i) dropped door-failed row: ' + JSON.stringify({ s1, reads: reads6(g.st) }));
  }

  // ===== FIX PASS, WORKFLOW ROUND 1 (after 3aa2d76) ==========================

  // ---- (blk-s) the pair is apart from the moment the block row lands -------
  // T6-R1-1. The teardown once ran after the three writes that follow the
  // block row (the unfriend and two request deletes): three more store round
  // trips, up to 24 s on a slow store, with the pair still co-members under a
  // committed block. Start does not read blocks, so a Start then seated them
  // side by side. Each write in turn is held while a Start is pressed;
  // seatSquad records the sockets it is handed.
  //
  // holdAt6 parks the `nth` call to method `m` BEFORE it runs, until released.
  const holdAt6 = (st, m, nth) => {
    const real = st[m];
    let n = 0, release, entered;
    const open = new Promise((r) => { release = r; });
    const inside = new Promise((r) => { entered = r; });
    const wrap = async function (...a) {
      if (++n !== nth) return real.apply(st, a);
      st[m] = real;
      entered(); await open;
      return real.apply(st, a);
    };
    st[m] = wrap;
    return { release, inside, restore: () => { if (st[m] === wrap) st[m] = real; } };
  };
  // world6 on ffa, every member but the leader ready, frames cleared.
  const readyWorld6 = async (lead, others) => {
    const seated = [];
    const g = await world6(lead, others, [[A, B]], { seatSquad: (seats) => { seated.push(seats.map((s) => s.ws)); return { ok: true, code: 'RM6S' }; } });
    await g.S.handle(g.w[lead], { type: 'squad', op: 'mode', mode: 'ffa' });
    for (const id of others) await g.S.handle(g.w[id], { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    clear6(...Object.values(g.w));
    return { ...g, seated };
  };
  const SEATED6 = (id) => ({ type: 'squad', op: 'start', ok: true, code: 'RM6S', id });
  const WRITES6 = [['removeFriendship', 1], ['deleteRequest', 1], ['deleteRequest', 2]];
  // Blocks with `blocker` (socket) while write `m`/`nth` is held, and presses
  // Start on `starter` inside that hold. -> the Start's answer and the seats,
  // as indexes into `order`.
  const startDuring6 = async (g, blocker, starter, order, [m, nth]) => {
    const h = holdAt6(g.st, m, nth);
    const pb = g.S.handle(blocker, { type: 'block', op: 'add', id: B });
    const inside = await within6(h.inside);
    let s = null;
    if (inside) { await g.S.handle(starter, { type: 'squad', op: 'start', loadout: RACK5, id: 's' }); s = ans6(starter, 's'); }
    else h.restore();
    h.release(); await pb;
    return { held: m + '#' + nth, inside, s, seats: g.seated.map((l) => l.map((w) => order.indexOf(w))) };
  };
  {
    // (i) B LEADS {B, A, C}, and A blocks B: A leaves. While each write after
    // the row is out, B's Start seats B and C, never A beside B.
    const bad = [];
    for (const which of WRITES6) {
      const g = await readyWorld6(B, [A, C]);
      const r = await startDuring6(g, g.w[A], g.w[B], [g.w[B], g.w[A], g.w[C]], which);
      if (!(r.inside && same6(r.s, SEATED6('s')) && same6(r.seats, [[0, 2]]))) bad.push(r);
    }
    if (!bad.length) ok('(blk-s) a member blocks the leader: while each later write of the block is out, a Start seats the leader without the blocker');
    else fail('(blk-s) blocker leaves before the writes: ' + JSON.stringify(bad));
  }
  {
    // (ii) C LEADS {C, A, B}, and A blocks B: A leaves. C's Start, pressed
    // while the unfriend is out, seats C and B, never A beside B.
    const g = await readyWorld6(C, [A, B]);
    const r = await startDuring6(g, g.w[A], g.w[C], [g.w[C], g.w[A], g.w[B]], WRITES6[0]);
    if (r.inside && same6(r.s, SEATED6('s')) && same6(r.seats, [[0, 2]]))
      ok('(blk-s) a block between two members: a Start by the leader while the unfriend is out seats the one who stays, not the pair');
    else fail('(blk-s) third-party leader: ' + JSON.stringify(r));
  }
  {
    // (iii) A LEADS {A, B, C} and blocks B from a second device: B goes. The
    // Start from the device holding A's row, pressed while the unfriend is
    // out, seats A and C.
    const g = await readyWorld6(A, [B, C]);
    const wa2 = up6(g.S, A);
    const r = await startDuring6(g, wa2, g.w[A], [g.w[A], g.w[B], g.w[C]], WRITES6[0]);
    if (r.inside && same6(r.s, SEATED6('s')) && same6(r.seats, [[0, 2]]))
      ok('(blk-s) the leader blocks from a second device: a Start while the unfriend is out seats the squad without the blocked member');
    else fail('(blk-s) leader\'s second device: ' + JSON.stringify(r));
  }
  {
    // (iv) THE REMOVED PLAYER IS TOLD IN THE TURN THE ROW IS REMOVED, as
    // squadKick tells its victim. While the unfriend is still out B already
    // holds exactly the kick frame and C the new roster, and B's own resume
    // then answers gone — after the kick, never before it. Everything B and
    // C receive, in order, is a twin world's: A kicks B, B resumes, A
    // unfriends B.
    const { st, S, w, mark } = await world6(A, [B, C]);
    const h = st.hold('removeFriendship');
    const pb = S.handle(w[A], { type: 'block', op: 'add', id: B });
    const inside = await within6(h.inside);
    let held = null;
    if (inside) {
      await settle6();
      held = { b: got6(w[B], 'squad').slice(), c: got6(w[C], 'squad').map(ids6) };
      await S.handle(w[B], { type: 'squad', op: 'resume', id: 'rb' });
    }
    h.release(); await pb;
    const t = await world6(A, [B, C]);
    await kick6(t, A, B);
    await t.S.handle(t.w[B], { type: 'squad', op: 'resume', id: 'rb' });
    await t.S.handle(t.w[A], { type: 'friend', op: 'remove', id: B });
    const mine6 = seq6(mark, [w[B], w[C]]), twin6 = seq6(t.mark, [t.w[B], t.w[C]]);
    if (inside && same6(held.b, [KICKED6]) && same6(held.c, [[A, C]]) && mine6.length === 4 && same6(mine6, twin6))
      ok('(blk-s) the blocked player is sent the kick as the row is removed, before the unfriend lands: a resume then answers gone after it, exactly as after a kick');
    else fail('(blk-s) telling as the row lands: ' + JSON.stringify({ inside, held, block: mine6, kick: twin6 }));
  }
  {
    // (v) A THROWING LOG IS NO SECOND ANSWER. A clock that throws inside the
    // log (its first read in a block, as addBlock's answer arrives) must not
    // turn a row that landed into an unavailable. The block answers ok, and
    // B, parted as the row was asked for, still goes, as a kick. (Until
    // T6-R1-2 the log came before the removal and the catch path removed B.)
    let clockThrows = false;
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = createSocial({
      seats: MODE_SEATS, teeIds: TEE_IDS, validRack: validRackFor, schedule: () => () => {},
      store: st, terms: [],
      now: () => { if (clockThrows) { clockThrows = false; throw new Error('clock'); } return CLOCK6; },
      send: (ws, f) => { if (ws && ws.readyState === 1) ws.rx.push(JSON.parse(JSON.stringify(f))); },
    });
    const wa = up6(S, A), wb = up6(S, B), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wb, code); await join6(S, wc, code);
    clear6(wa, wb, wc);
    clockThrows = true;
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    const threw = !clockThrows;
    clockThrows = false;
    await S.handle(wc, { type: 'squad', op: 'resume', id: 'r' });
    if (threw && same6(got6(wa, 'block'), [{ type: 'block', op: 'add', ok: true, id: B }]) && st.blocks.has(A + '>' + B)
      && same6(got6(wb, 'squad'), [KICKED6]) && same6(ids6(ans6(wc, 'r')), [A, C]))
      ok('(blk-s) a clock that throws in the log as the row lands: the block still answers ok, and the blocked member is still removed');
    else fail('(blk-s) catch-path teardown: ' + JSON.stringify({ threw, a: wa.rx, b: got6(wb, 'squad'), x: ans6(wc, 'r') }));
  }
  {
    // (vi) THE ANSWER STILL WAITS FOR THE TELLING. The telling starts as the
    // row is asked for and runs beside the writes; here its roster's name read is
    // held until every write has finished. The blocker is answered only
    // after the roster: members first, actor last, whichever finishes first.
    const { st, S, w } = await world6(A, [B, C]);
    const h = st.hold('profilesByIds');
    const pb = S.handle(w[A], { type: 'block', op: 'add', id: B });
    const inside = await within6(h.inside);
    let held = null;
    if (inside) { await settle6(); held = { deletes: st.calls.filter((c) => c === 'deleteRequest').length, answered: got6(w[A], 'block').length }; }
    h.release(); await pb;
    const kinds = w[A].rx.map((f) => f.type + (f.op ? ':' + f.op : ''));
    if (inside && held.deletes === 2 && held.answered === 0 && same6(kinds, ['squad:state', 'block:add', 'friends']))
      ok('(blk-s) with the roster\'s name read slower than every write, the blocker is still answered after the roster');
    else fail('(blk-s) answer waits for the telling: ' + JSON.stringify({ inside, held, kinds }));
  }

  // ---- (jn-f) and (inv-q) the cancel is the account, not the hello ---------
  // T6-R1-3. server.js bumps ws.authGen as every hello STARTS, before its
  // token is verified. A rotated token for the same account (the client's
  // re-hello) or one that never verifies moves it and nothing else: the
  // socket is still the account that asked, so the join or invite whose
  // read is out is answered once, as ever. A sign-out, or a hello verified
  // as another account, cancels it: no answer, nothing done.
  const BUMPS6 = {
    'same account': (S, w, id) => hello6(S, w, id),
    'junk token': (S, w) => { w.authGen = (w.authGen || 0) + 1; },
    'signed out': (S, w) => { w.authGen = (w.authGen || 0) + 1; S.onClose(w); w.userId = null; w.isGuest = false; },
    'another account': (S, w) => hello6(S, w, E),
  };
  const KEEPS6 = new Set(['same account', 'junk token']);
  {
    const bad = [];
    for (const how of Object.keys(BUMPS6)) {
      const j = await joinWorld6();
      const gate = j.st.hold('blockIdsOf');
      const pending = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
      const inside = await within6(gate.inside);
      if (inside) BUMPS6[how](j.S, j.wb, B);
      gate.release(); await pending;
      const answers = j.wb.rx.filter((f) => f.id === 'j');
      await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r' });
      const x = ids6(ans6(j.wc, 'r'));
      const good = KEEPS6.has(how)
        ? answers.length === 1 && answers[0].op === 'state' && answers[0].code === j.code && same6(x, [A, C, B])
        : answers.length === 0 && same6(x, [A, C]);
      if (!(inside && good)) bad.push({ how, inside, answers, x });
    }
    if (!bad.length) ok('(jn-f) a hello that leaves the socket the same account does not cancel a join whose read is out: answered once and joined; a sign-out or another account cancels it');
    else fail('(jn-f) join and a hello during its read: ' + JSON.stringify(bad));
  }
  {
    const bad = [];
    for (const how of Object.keys(BUMPS6)) {
      const st = t6store(ROWS6);
      await st.addFriendship(A, B);
      const S = mkSocial6(st);
      const wa = up6(S, A), wb = up6(S, B);
      await create6(S, wa);
      clear6(wa, wb); PUSHES.length = 0; DRY6.length = 0;
      const gate = st.hold('friendIdsOf');
      const pending = S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'k' });
      const inside = await within6(gate.inside);
      if (inside) BUMPS6[how](S, wa, A);
      gate.release(); await pending;
      const answers = wa.rx.filter((f) => f.id === 'k');
      const good = KEEPS6.has(how)
        ? same6(answers, [{ type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'k' }]) && invited6(wb).length === 1
        : answers.length === 0 && !invited6(wb).length && !PUSHES.length && !DRY6.length;
      if (!(inside && good)) bad.push({ how, inside, answers, b: invited6(wb) });
    }
    if (!bad.length) ok('(inv-q) a hello that leaves the socket the same account does not cancel an invite whose reads are out: answered once and delivered; a sign-out or another account cancels it');
    else fail('(inv-q) invite and a hello during its reads: ' + JSON.stringify(bad));
  }
  // ---- (rs-a) and resume, Task 5's, by the same rule (D-BLOCK-4) -----------
  // C resumes while the roster's name read is out; the same four events land
  // inside it.
  {
    const bad = [];
    for (const how of Object.keys(BUMPS6)) {
      const j = await joinWorld6();
      const gate = j.st.hold('profilesByIds');
      const pending = j.S.handle(j.wc, { type: 'squad', op: 'resume', code: j.code, id: 'r' });
      const inside = await within6(gate.inside);
      if (inside) BUMPS6[how](j.S, j.wc, C);
      gate.release(); await pending;
      const answers = j.wc.rx.filter((f) => f.id === 'r');
      const good = KEEPS6.has(how)
        ? answers.length === 1 && answers[0].op === 'state' && answers[0].code === j.code && answers[0].you === 1 && same6(ids6(answers[0]), [A, C])
        : answers.length === 0;
      if (!(inside && good)) bad.push({ how, inside, answers });
    }
    if (!bad.length) ok('(rs-a) a hello that leaves the socket the same account does not cancel a resume whose name read is out: answered once, with the squad; a sign-out or another account cancels it');
    else fail('(rs-a) resume and a hello during its read: ' + JSON.stringify(bad));
  }
  {
    // A socket with no account: a junk hello leaves it nobody, still answered;
    // signing in makes it somebody, and cancels.
    const bad = [];
    for (const how of ['junk token', 'signs in']) {
      const j = await joinWorld6();
      const g = t6ws(null);
      await join6(j.S, g, j.code, 'Guest');
      clear6(g);
      const gate = j.st.hold('profilesByIds');
      const pending = j.S.handle(g, { type: 'squad', op: 'resume', code: j.code, id: 'r' });
      const inside = await within6(gate.inside);
      if (inside) { if (how === 'junk token') BUMPS6[how](j.S, g); else hello6(j.S, g, E); }
      gate.release(); await pending;
      const answers = g.rx.filter((f) => f.id === 'r');
      const good = how === 'junk token'
        ? answers.length === 1 && answers[0].op === 'state' && answers[0].you === 2 && same6(ids6(answers[0]), [A, C, null])
        : answers.length === 0;
      if (!(inside && good)) bad.push({ how, inside, answers });
    }
    if (!bad.length) ok('(rs-a) a guest\'s resume: a hello that never verifies is answered; one that signs the socket in cancels it');
    else fail('(rs-a) guest resume and a hello during its read: ' + JSON.stringify(bad));
  }

  // ---- (lg-a) the log merges a pair the reader BLOCKED, too ----------------
  // T6-R1-4. The reader's own other device blocks a member while the
  // reader's read is out, answered before that block. The teardown has
  // nothing to remove (the reader is not in that squad yet, or its row
  // there stands for nobody), so the log is the only guard, and the pair
  // names the reader as the BLOCKER.
  {
    // (i) Join: B's second device blocks A, who leads the target.
    const j = await joinWorld6();
    const wb2 = up6(j.S, B);
    const h = stale6(j.st, 'blockIdsOf');
    const pending = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const inside = await within6(h.inside);
    if (inside) await j.S.handle(wb2, { type: 'block', op: 'add', id: A });
    else h.restore();
    h.release(); await pending;
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (inside && j.st.blocks.has(B + '>' + A) && same6(ans6(j.wb, 'j'), DEAD6('j')) && same6(ids6(ans6(j.wc, 'r')), [A, C]))
      ok('(lg-a) a block the joiner itself adds while its read is out is merged from the log: refused as a dead code, and the roster is unchanged');
    else fail('(lg-a) joiner blocks during its read: ' + JSON.stringify({ inside, b: ans6(j.wb, 'j'), x: ans6(j.wc, 'r') }));
  }
  {
    // (ii) Invite: C invites B while B's second device blocks A, a member.
    const st = t6store(ROWS6);
    await st.addFriendship(C, B);
    const S = mkSocial6(st);
    const wc = up6(S, C), wa = up6(S, A), wb = up6(S, B), wb2 = up6(S, B);
    const code = await create6(S, wc);
    await join6(S, wa, code, 'Anvil Six');
    clear6(wa, wb, wb2, wc); PUSHES.length = 0; DRY6.length = 0;
    const h = staleFor6(st, 'blockIdsOf', B);
    const pending = S.handle(wc, { type: 'squad', op: 'invite', to: B, id: 'p' });
    const inside = await within6(h.inside);
    if (inside) await S.handle(wb2, { type: 'block', op: 'add', id: A });
    else h.restore();
    h.release(); await pending;
    if (inside && st.blocks.has(B + '>' + A) && same6(ans6(wc, 'p'), { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'p' })
      && !invited6(wb).length && !invited6(wb2).length && !PUSHES.length && !DRY6.length)
      ok('(lg-a) a block the invitee adds against a member while the invite\'s reads are out drops the invite, answered as ever');
    else fail('(lg-a) invitee blocks during the reads: ' + JSON.stringify({ inside, c: ans6(wc, 'p'), b: invited6(wb), b2: invited6(wb2) }));
  }
  {
    // (iii) The sign-in door: B's socket closes during its door read (so its
    // dropped guest row stands for nobody the teardown can see), and B's
    // other device blocks A. The row goes, and B's next device resumes gone.
    const g = await signWorld6(null);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    const wb = up6(g.S, B);
    const h = stale6(g.st, 'blockIdsOf');
    hello6(g.S, wn, B);
    const inside = await within6(h.inside);
    if (inside) { wn.readyState = 3; g.S.onClose(wn); await g.S.handle(wb, { type: 'block', op: 'add', id: A }); }
    else h.restore();
    h.release();
    await settle6();
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
    const wb3 = up6(g.S, B);
    await g.S.handle(wb3, { type: 'squad', op: 'resume', code: g.code, id: 'rb' });
    if (inside && g.st.blocks.has(B + '>' + A) && same6(ids6(ans6(g.wc, 'r')), [A, C]) && same6(ans6(wb3, 'rb'), { type: 'squad', op: 'gone', id: 'rb' }))
      ok('(lg-a) a block the signing-in account adds while its door reads is merged too: its dropped row goes, and a resume answers gone');
    else fail('(lg-a) door, account blocks during its read: ' + JSON.stringify({ inside, x: ans6(g.wc, 'r'), b: ans6(wb3, 'rb') }));
  }

  // ---- (lg-b) the log records the account that ASKED ------------------------
  // A's second device blocks B, and says hello as D while the block's first
  // read is out; B's join read is out throughout. The row names A (D-BLOCK-2
  // D), and so must the log: a log naming D would let B in beside A.
  {
    const j = await joinWorld6();
    const wa2 = up6(j.S, A);
    const h = stale6(j.st, 'blockIdsOf');
    const pending = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const in1 = await within6(h.inside);
    let in2 = false;
    if (in1) {
      const g = j.st.hold('profileById');
      const pb = j.S.handle(wa2, { type: 'block', op: 'add', id: B });
      in2 = await within6(g.inside);
      if (in2) hello6(j.S, wa2, D);
      g.release(); await pb;
    } else h.restore();
    h.release(); await pending;
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (in1 && in2 && same6([...j.st.blocks], [A + '>' + B]) && same6(ans6(j.wb, 'j'), DEAD6('j')) && same6(ids6(ans6(j.wc, 'r')), [A, C]))
      ok('(lg-b) the log names the account that asked the block, not the one its socket became: the join is refused');
    else fail('(lg-b) log names the asker: ' + JSON.stringify({ in1, in2, blocks: [...j.st.blocks], b: ans6(j.wb, 'j'), x: ans6(j.wc, 'r') }));
  }

  // ---- (lg-c) only pairs logged since the reader's capture are added --------
  // A blocks B and lifts it again through handleBlock, inside the log's
  // window: the entry stays in the log, but a read taken after the lift is
  // the truth. B joins, B's door lets B in, and C's invite reaches B, each on
  // one read of B's blocks and none again.
  {
    const bad = [];
    const addLift6 = async (S, w) => { await S.handle(w, { type: 'block', op: 'add', id: B }); await S.handle(w, { type: 'block', op: 'remove', id: B }); };
    {
      const j = await joinWorld6();
      await addLift6(j.S, j.wa);
      const n = after6(j.st, B);
      await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
      const a = ans6(j.wb, 'j');
      if (!(j.st.blocks.size === 0 && n.c === 1 && a && a.op === 'state' && a.code === j.code && same6(ids6(a), [A, C, B]))) bad.push({ join: { reads: n.c, a } });
    }
    {
      const g = await signWorld6(null);
      const wn = t6ws(null);
      await join6(g.S, wn, g.code, 'Bunker');
      await addLift6(g.S, g.wa);
      const n = after6(g.st, B);
      hello6(g.S, wn, B);
      await settle6();
      await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
      const x = ids6(ans6(g.wc, 'r'));
      if (!(n.c === 1 && same6(x, [A, C, B]) && !got6(wn, 'squad', 'ended').length)) bad.push({ door: { reads: n.c, x, n: got6(wn, 'squad') } });
    }
    {
      const st = t6store(ROWS6);
      await st.addFriendship(C, B);
      const S = mkSocial6(st);
      const wc = up6(S, C), wa = up6(S, A), wb = up6(S, B);
      const code = await create6(S, wc);
      await join6(S, wa, code, 'Anvil Six');
      await addLift6(S, wa);
      clear6(wb, wc);
      const n = after6(st, B);
      await S.handle(wc, { type: 'squad', op: 'invite', to: B, id: 'p' });
      if (!(n.c === 1 && same6(ans6(wc, 'p'), { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'p' }) && invited6(wb).length === 1))
        bad.push({ invite: { reads: n.c, a: ans6(wc, 'p'), invited: invited6(wb).length } });
    }
    if (!bad.length) ok('(lg-c) a block added and lifted before a read is not merged into it: the join, the door and the invite each succeed on one read');
    else fail('(lg-c) a lifted block in the log: ' + JSON.stringify(bad));
  }

  // ---- (sg-h v, b) two doors, settling the other way round ------------------
  // T6-R1-5. As (sg-h v): a sign-out and back in as B while B's first door
  // read is out, so a second door owns the row. Here the SECOND read lands
  // first and lets B in; the first then fails. A door that a later one took
  // the row over from does nothing when it lands — least of all mark the
  // admitted row door-failed — so Start seats all three, the row stays B's,
  // and no door runs again.
  {
    const seated = [];
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { seatSquad: (seats) => { seated.push(seats.length); return { ok: true, code: 'RM6J' }; } });
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
    second.release(); await settle6();
    first.release(); await settle6();
    st.blockIdsOf = real;
    st.calls.length = 0;
    await S.handle(wa, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    await settle6();
    const reads = st.calls.filter((c) => c === 'blockIdsOf').length;
    await S.handle(wc, { type: 'squad', op: 'resume', id: 'r' });
    if (in1 && in2 && same6(ans6(wa, 's'), { type: 'squad', op: 'start', ok: true, code: 'RM6J', id: 's' }) && same6(seated, [3]) && reads === 0 && same6(ids6(ans6(wc, 'r')), [A, C, B]))
      ok('(sg-h) signed out and back in mid-read, the second door admitting first: the first door\'s failed read does nothing, and Start seats the row');
    else fail('(sg-h) re-signed-in door, reverse order: ' + JSON.stringify({ in1, in2, s: ans6(wa, 's'), seated, reads, x: ans6(wc, 'r') }));
  }

  // ---- (blk-k iv) one teardown, two rows of one squad -----------------------
  // T6-R1-6. An anonymous account stands in A's squad from two tabs, each
  // joined by code, and A blocks it by seat handle. Each tab is sent a
  // kick's victim frame exactly once, and the rest of the squad one roster:
  // what A kicking both would send.
  {
    const HANDLES = new Map([['c9d0e1f2', GU]]);
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { resolveHandle: (ws, h) => HANDLES.get(h) || null });
    const wa = up6(S, A), wc = up6(S, C);
    const code = await create6(S, wa);
    const g1 = up6(S, GU, true), g2 = up6(S, GU, true);
    await join6(S, g1, code, 'Ghost'); await join6(S, g2, code, 'Ghost'); await join6(S, wc, code, 'Crater Two');
    clear6(wa, wc, g1, g2);
    await S.handle(wa, { type: 'block', op: 'add', handle: 'c9d0e1f2', id: 'b4' });
    const ra = got6(wa, 'squad'), rc = got6(wc, 'squad');
    if (st.blocks.has(A + '>' + GU) && same6(got6(g1, 'squad'), [KICKED6]) && same6(got6(g2, 'squad'), [KICKED6])
      && ra.length === 1 && same6(ids6(ra[0]), [A, C]) && rc.length === 1 && same6(ids6(rc[0]), [A, C]))
      ok('(blk-k) a block that removes two rows of one squad sends each a kick once, and the rest of the squad one roster');
    else fail('(blk-k) two rows of one squad: ' + JSON.stringify({ g1: g1.rx, g2: g2.rx, a: ra, c: rc }));
  }

  // ===== FIX PASS, WORKFLOW ROUND 2 (after 2774974) ==========================

  // ---- (blk-t) two shared squads: every removed row is told before any roster
  // T6-R2-2. The pair can share TWO squads. C leads Y; A leads X with B in it;
  // a tab of A's and a tab of B's joined Y with no account and then signed
  // in. Their doors' reads failed, so they stand as guest rows while each
  // account has its row in X (the two-squads state, which since E8 a door
  // that lets the account in ends). A
  // blocks B: in Y, which C leads, A's tab leaves; in X, which A leads, B
  // goes as a kick. The first roster push's name read is held. B must
  // already hold exactly the kick, and B's resume must answer gone only
  // after it, which is the order a kick gives. That must hold whichever of
  // the two squads was made first.
  {
    const bad = [];
    const LEFT = { type: 'squad', op: 'ended', reason: 'left' };
    for (const ledFirst of [false, true]) {
      const st = t6store(ROWS6);
      await st.addFriendship(A, B);
      const S = mkSocial6(st);
      const wc = up6(S, C), wa = up6(S, A), wb = up6(S, B);
      let X, Y;
      if (ledFirst) { X = await create6(S, wa); Y = await create6(S, wc); }
      else { Y = await create6(S, wc); X = await create6(S, wa); }
      await join6(S, wb, X, 'Bunker Nine');
      const ta = t6ws(null), tb = t6ws(null);
      await join6(S, ta, Y, 'Anvil'); await join6(S, tb, Y, 'Bunker');
      st.boom.add('blockIdsOf'); hello6(S, ta, A); hello6(S, tb, B); st.boom.delete('blockIdsOf');   // the rows stand (doors failed: E8)
      await settle6();
      await S.handle(wc, { type: 'squad', op: 'resume', id: 'y0' });
      const y0 = ids6(ans6(wc, 'y0'));
      clear6(wa, wb, wc, ta, tb);
      const mark = TRACE6.length;
      const h = st.hold('profilesByIds');
      const pb = S.handle(wa, { type: 'block', op: 'add', id: B });
      const inside = await within6(h.inside);
      let held = null;
      if (inside) {
        await settle6();
        held = got6(wb, 'squad').slice();
        await S.handle(wb, { type: 'squad', op: 'resume', id: 'rb' });
      }
      h.release(); await pb;
      await S.handle(wc, { type: 'squad', op: 'resume', id: 'y1' });
      const t = await world6(A, [B]);
      await kick6(t, A, B);
      await t.S.handle(t.w[B], { type: 'squad', op: 'resume', id: 'rb' });
      await t.S.handle(t.w[A], { type: 'friend', op: 'remove', id: B });
      const mine = seq6(mark, [wb]), twin = seq6(t.mark, [t.w[B]]);
      if (!(X !== Y && same6(y0, [C, null, null]) && inside && same6(held, [KICKED6]) && mine.length === 3 && same6(mine, twin)
        && same6(got6(ta, 'squad'), [LEFT]) && same6(ids6(ans6(wc, 'y1')), [C, null])))
        bad.push({ ledFirst, y0, inside, held, block: mine, kick: twin, ta: got6(ta, 'squad'), y1: ids6(ans6(wc, 'y1')) });
    }
    if (!bad.length) ok('(blk-t) a block that parts the pair in two squads tells every removed row before any roster read: the blocked player is kicked before a resume can answer gone, in either creation order');
    else fail('(blk-t) two shared squads: ' + JSON.stringify(bad));
  }

  // ---- (sg-j) an ACCOUNT row has no door, even after a door failed --------
  // T6-R2-3. B's door fails on a guest row in C's squad T, which clears
  // `squadAs` so that B's next hello tries again. B then CREATES a squad
  // (A joins it) or JOINS D's squad. Now the socket stands on an ACCOUNT
  // row, and the create or join that made that row already vetted it. B's
  // next hello, a rotated token for the same account, must open no door on
  // that row. With the store failing it reads nothing and keeps nobody out
  // of Start. With a block row in the store that no teardown ever saw (an
  // addBlock whose answer was lost), it still removes nobody, and a leader
  // is never removed.
  const doorThen6 = async (how) => {
    const seated = [];
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { seatSquad: (seats) => { seated.push(seats.map((s) => s.ws)); return { ok: true, code: 'RM6J' }; } });
    const wc = up6(S, C);
    const T = await create6(S, wc);
    const wn = t6ws(null);
    await join6(S, wn, T, 'Bunker');
    st.boom.add('blockIdsOf'); hello6(S, wn, B); await settle6(); st.boom.delete('blockIdsOf');
    const g = { st, S, wn, seated };
    if (how === 'create') {
      g.U = await create6(S, wn);
      g.other = up6(S, A);
      await join6(S, g.other, g.U, 'Anvil Six');
      await S.handle(wn, { type: 'squad', op: 'mode', mode: 'ffa' });
      await S.handle(g.other, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
      g.lead = wn; g.order = [wn, g.other]; g.blocker = A; g.ids = [B, A];
    } else {
      g.other = up6(S, D);
      g.U = await create6(S, g.other);
      await join6(S, wn, g.U, 'Bunker Nine');
      await S.handle(g.other, { type: 'squad', op: 'mode', mode: 'ffa' });
      await S.handle(wn, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
      g.lead = g.other; g.order = [g.other, wn]; g.blocker = D; g.ids = [D, B];
    }
    clear6(wc, wn, g.other);
    st.calls.length = 0;
    return g;
  };
  {
    const bad = [];
    for (const how of ['create', 'join']) {
      // (i) The store fails at the re-hello: no read, and Start seats both.
      const g = await doorThen6(how);
      g.st.boom.add('blockIdsOf');
      hello6(g.S, g.wn, B);
      await settle6();
      g.st.boom.delete('blockIdsOf');
      const reads = reads6(g.st);
      await g.S.handle(g.lead, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
      const s = ans6(g.lead, 's');
      if (!(reads === 0 && same6(s, { type: 'squad', op: 'start', ok: true, code: 'RM6J', id: 's' })
        && same6(g.seated.map((l) => l.map((w) => g.order.indexOf(w))), [[0, 1]])))
        bad.push({ how, store: 'failing', reads, s, seats: g.seated.map((l) => l.length) });
    }
    for (const how of ['create', 'join']) {
      // (ii) A block row the server never saw land: the re-hello removes nobody.
      const g = await doorThen6(how);
      g.st.blocks.add(g.blocker + '>' + B);
      hello6(g.S, g.wn, B);
      await settle6();
      const reads = reads6(g.st);
      await g.S.handle(g.other, { type: 'squad', op: 'resume', id: 'r' });
      const x = ans6(g.other, 'r');
      if (!(reads === 0 && !got6(g.wn, 'squad').length && x && same6(ids6(x), g.ids) && x.leader === g.ids[0]))
        bad.push({ how, store: 'block row', reads, n: got6(g.wn, 'squad'), x });
    }
    if (!bad.length) ok('(sg-j) after a failed door, a create or a join puts the socket on an account row, and a same-account hello then opens no door on it: no read, nothing kept out of Start, nobody removed');
    else fail('(sg-j) account row after a failed door: ' + JSON.stringify(bad));
  }

  // ---- (blk-u) an addBlock that throws after its row landed still parts the pair
  // T6-R2-4. A write can commit and still report a failure: sbAdmin's 8 s
  // timeout, or a 5xx or a dropped connection after the commit. The blocker
  // is answered unavailable, because the block may not stand. But it may, so
  // the pair is parted exactly as a landed block parts them, and the pair is
  // logged for any read already out. If the block did not land, the parting
  // is a kick or a leave the blocker asked for, and it names nothing.
  const lostAnswer6 = (st) => {
    const real = st.addBlock;
    st.addBlock = async function (...a) { st.addBlock = real; await real.apply(st, a); throw new Error('sb timeout'); };
  };
  const LOST6 = { type: 'block', op: 'add', error: 'unavailable', id: B };
  {
    // (i) Whoever leads, the pair are apart as the answer goes out, and the
    // next Start seats one of them.
    const bad = [];
    const LEFT = { type: 'squad', op: 'ended', reason: 'left' };
    for (const [lead, others, out, frame] of [[A, [B, C], B, KICKED6], [B, [A, C], A, LEFT], [C, [A, B], A, LEFT]]) {
      const g = await readyWorld6(lead, others);
      lostAnswer6(g.st);
      await g.S.handle(g.w[A], { type: 'block', op: 'add', id: B });
      const told = got6(g.w[out], 'squad').slice();
      const order = [g.w[lead], ...others.map((id) => g.w[id])];
      await g.S.handle(g.w[lead], { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
      const kept = order.filter((w) => w !== g.w[out]).map((w) => order.indexOf(w));
      const seats = g.seated.map((l) => l.map((w) => order.indexOf(w)));
      if (!(g.st.blocks.has(A + '>' + B) && same6(got6(g.w[A], 'block'), [LOST6]) && same6(told, [frame])
        && same6(ans6(g.w[lead], 's'), SEATED6('s')) && same6(seats, [kept])))
        bad.push({ lead, a: got6(g.w[A], 'block'), out: told, s: ans6(g.w[lead], 's'), seats });
    }
    if (!bad.length) ok('(blk-u) an addBlock that commits and then throws is answered unavailable, and the pair is still parted as a kick or a leave: Start seats one of them, whoever leads');
    else fail('(blk-u) lost addBlock answer: ' + JSON.stringify(bad));
  }
  {
    // (ii) B's join read is out when that block lands. The log adds the
    // pair, so the join is refused as a dead code.
    const j = await joinWorld6();
    const h = stale6(j.st, 'blockIdsOf');
    const pending = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const inside = await within6(h.inside);
    if (inside) { lostAnswer6(j.st); await j.S.handle(j.wa, { type: 'block', op: 'add', id: B }); } else h.restore();
    h.release(); await pending;
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r' });
    if (inside && same6(got6(j.wa, 'block'), [LOST6]) && same6(ans6(j.wb, 'j'), DEAD6('j')) && same6(ids6(ans6(j.wc, 'r')), [A, C]))
      ok('(blk-u) and it is logged: a join whose read was out when it landed is refused as a dead code');
    else fail('(blk-u) lost addBlock answer, join read out: ' + JSON.stringify({ inside, a: got6(j.wa, 'block'), b: j.wb.rx, x: ans6(j.wc, 'r') }));
  }
  {
    // (iii) CONTROL: a block that fails before addBlock is asked (its profile
    // read) wrote nothing, so it parts nobody and Start seats all three.
    const g = await readyWorld6(A, [B, C]);
    g.st.boom.add('profileById');
    await g.S.handle(g.w[A], { type: 'block', op: 'add', id: B });
    g.st.boom.delete('profileById');
    const told = got6(g.w[B], 'squad').slice();
    await g.S.handle(g.w[A], { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    const seats = g.seated.map((l) => l.map((w) => [g.w[A], g.w[B], g.w[C]].indexOf(w)));
    if (same6(got6(g.w[A], 'block'), [LOST6]) && !g.st.blocks.size && !told.length && same6(seats, [[0, 1, 2]]))
      ok('(blk-u) a block that failed before addBlock was asked parts nobody');
    else fail('(blk-u) failed profile read: ' + JSON.stringify({ a: got6(g.w[A], 'block'), blocks: [...g.st.blocks], b: told, seats }));
  }
  {
    // (iv) addBlock commits and then throws, and the clock also throws as
    // that answer is noted and logged. The answer still carries its op, and
    // the pair is still parted.
    let clockThrows = false;
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = createSocial({
      seats: MODE_SEATS, teeIds: TEE_IDS, validRack: validRackFor, schedule: () => () => {},
      store: st, terms: [],
      now: () => { if (clockThrows) { clockThrows = false; throw new Error('clock'); } return CLOCK6; },
      send: (ws, f) => { if (ws && ws.readyState === 1) ws.rx.push(JSON.parse(JSON.stringify(f))); },
    });
    const wa = up6(S, A), wb = up6(S, B), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wb, code); await join6(S, wc, code);
    clear6(wa, wb, wc);
    lostAnswer6(st);
    clockThrows = true;
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    const threw = !clockThrows;
    clockThrows = false;
    await S.handle(wc, { type: 'squad', op: 'resume', id: 'r' });
    if (threw && same6(got6(wa, 'block'), [LOST6]) && st.blocks.has(A + '>' + B) && same6(got6(wb, 'squad'), [KICKED6]) && same6(ids6(ans6(wc, 'r')), [A, C]))
      ok('(blk-u) a lost addBlock answer whose log also throws is still answered with its op, and the pair is still parted');
    else fail('(blk-u) lost answer, throwing log: ' + JSON.stringify({ threw, a: wa.rx, b: got6(wb, 'squad'), x: ans6(wc, 'r') }));
  }

  // ---- (jn-g) a blocked join is refused as a dead code, before already_in ---
  // T6-R2-5. D-BLOCK 3's answer to a blocked joiner is no_such_squad, and it
  // is asked before squadJoin's already_in. B's first device stands in A's
  // squad on a guest row that has signed in as B, with its door still
  // reading (held) or failed, and A has blocked B. B's second device joins
  // by code and gets a dead code's words, not already_in, and nothing moves.
  {
    const bad = [];
    for (const kind of ['held', 'failed']) {
      const g = await signWorld6([A, B]);
      const wn = t6ws(null);
      await join6(g.S, wn, g.code, 'Bunker');
      let gate = null, inside = true;
      if (kind === 'held') { gate = g.st.hold('blockIdsOf'); hello6(g.S, wn, B); inside = await within6(gate.inside); if (!inside) gate.release(); }
      else { g.st.boom.add('blockIdsOf'); hello6(g.S, wn, B); await settle6(); g.st.boom.delete('blockIdsOf'); }
      clear6(g.wa, g.wc, wn);
      const wb2 = up6(g.S, B);
      await g.S.handle(wb2, { type: 'squad', op: 'join', code: g.code, name: 'Bunker Nine', skin: 'gold', id: 'j' });
      await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'r' });
      const r = { kind, inside, j: ans6(wb2, 'j'), b2: got6(wb2, 'squad').length, x: ids6(ans6(g.wc, 'r')), a: got6(g.wa, 'squad').length, n: got6(wn, 'squad').length };
      if (gate) { gate.release(); await settle6(); }
      if (!(r.inside && same6(r.j, DEAD6('j')) && r.b2 === 1 && same6(r.x, [A, C, null]) && !r.a && !r.n)) bad.push(r);
    }
    if (!bad.length) ok('(jn-g) a blocked account whose other device stands in the squad on a door-held or door-failed row is refused no_such_squad, not already_in, and nothing moves');
    else fail('(jn-g) blocked join vs already_in: ' + JSON.stringify(bad));
  }

  // ---- (sg-i viii) two door-failed rows: a Start re-runs the row it names ---
  // T6-R2-6, reading 2 of the H-amended pass. With two rows whose doors
  // failed, a refused Start names the first one and re-runs that row's door
  // only, so each refusal costs one read. After the store recovers,
  // successive Starts heal one row each, and then a Start seats everyone.
  {
    const seated = [];
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { seatSquad: (seats) => { seated.push(seats.length); return { ok: true, code: 'RM6K' }; } });
    const wa = up6(S, A);
    const code = await create6(S, wa);
    await S.handle(wa, { type: 'squad', op: 'mode', mode: 'ffa' });
    const wn = t6ws(null), wm = t6ws(null);
    await join6(S, wn, code, 'Bunker'); await join6(S, wm, code, 'Dune');
    for (const w of [wn, wm]) await S.handle(w, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    st.boom.add('blockIdsOf');
    hello6(S, wn, B); hello6(S, wm, D);
    await settle6();
    st.calls.length = 0;
    const OFF = (at, id) => ({ type: 'squad', op: 'start', error: 'member_offline', at, id });
    const step = async (id) => {
      const n0 = reads6(st);
      await S.handle(wa, { type: 'squad', op: 'start', loadout: RACK5, id });
      await settle6();
      return [ans6(wa, id), reads6(st) - n0];
    };
    const failing = await step('f');
    st.boom.delete('blockIdsOf');
    const healing = [await step('h1'), await step('h2'), await step('h3')];
    if (same6(failing, [OFF(1, 'f'), 1])
      && same6(healing, [[OFF(1, 'h1'), 1], [OFF(2, 'h2'), 1], [{ type: 'squad', op: 'start', ok: true, code: 'RM6K', id: 'h3' }, 0]])
      && same6(seated, [3]))
      ok('(sg-i) with two door-failed rows a refused Start re-runs only the row it names: one read per refusal, one row healed per Start, then a seat');
    else fail('(sg-i) two door-failed rows: ' + JSON.stringify({ failing, healing, seated }));
  }

  // ---- (sg-i iii, d) a row the re-run lets in that stays a GUEST row --------
  // Since T6-R2-3 an account row has no door, so a row the re-run ADOPTS is
  // no longer read on the next hello whatever `squadAs` says. A row the
  // re-run lets in but leaves a guest row still has a door. That happens for
  // an ANONYMOUS account, whose rows are always guest rows. (It also used to
  // happen when the account had its row in another squad; since E8 that row
  // leaves instead, below.) So the admit itself must leave the socket as the
  // account: its next hello, while the store fails, must read nothing and
  // keep nothing out of Start.
  {
    const g = await failWorld6(null, false);
    g.st.boom.add('blockIdsOf'); hello6(g.S, g.wn, GU, true); await settle6();
    g.st.boom.delete('blockIdsOf');
    clear6(g.wa, g.wc, g.wn);
    g.st.calls.length = 0;
    const s1 = await start6(g, 's1');
    await settle6();
    const admitted = reads6(g.st);
    g.st.calls.length = 0;
    g.st.boom.add('blockIdsOf');
    hello6(g.S, g.wn, GU, true);
    await settle6();
    g.st.boom.delete('blockIdsOf');
    const reads = reads6(g.st);
    const s2 = await start6(g, 's2');
    const x = ids6(await roster6(g, 'r'));
    if (same6(s1, OFF6('s1')) && admitted === 1 && reads === 0 && same6(s2, OK6('s2')) && g.seated.length === 1 && g.seated[0].length === 3 && same6(x, [A, C, null]))
      ok('(sg-i) a row the re-run lets in but leaves a guest row (an anonymous account) is not read again on the next hello, and Start seats it');
    else fail('(sg-i) re-hello after a guest-row admit: ' + JSON.stringify({ s1, admitted, reads, s2, seated: g.seated.map((l) => l.length), x }));
  }
  {
    // (iii, e) AND WHEN THE ACCOUNT LET IN HAS ITS ROW IN ANOTHER SQUAD (E8):
    // the re-run's admit ends the two-squads state. The guest row leaves,
    // its socket is told ended:elsewhere, the squad sees the leave, and the
    // next Start seats the two left.
    const g = await failWorld6(null, false);
    const wb1 = up6(g.S, B);
    await create6(g.S, wb1);
    g.st.boom.add('blockIdsOf'); hello6(g.S, g.wn, B); await settle6();
    g.st.boom.delete('blockIdsOf');
    clear6(g.wa, g.wc, g.wn);
    const s1 = await start6(g, 's1');
    await settle6();
    const told = got6(g.wn, 'squad').filter((f) => f.op === 'ended');
    const s2 = await start6(g, 's2');
    const x = ids6(await roster6(g, 'r'));
    if (same6(s1, OFF6('s1')) && same6(told, [{ type: 'squad', op: 'ended', reason: 'elsewhere' }]) && same6(s2, OK6('s2')) && g.seated.length === 1 && g.seated[0].length === 2 && same6(x, [A, C]))
      ok('(sg-i) a row the re-run lets in whose account is in another squad leaves, told ended:elsewhere, and Start seats the rest');
    else fail('(sg-i) re-run admit into the two-squads state: ' + JSON.stringify({ s1, told, s2, seated: g.seated.map((l) => l.length), x }));
  }

  // ---- (inv-r) the seam's bound is 4 s unless the knob sets it, never negative
  // T6-R2-7. INVITE_PUSH_MS bounds how long a hung transport can hold the
  // inviter's queue, and any block waiting behind it. It is sized against
  // sbAdmin's 8 s and the client's 12 s. The timer the seam races is read
  // here as it is armed, so the bound is checked without waiting it out. It
  // is 4000 when the knob is unset, unreadable or negative, and the knob's
  // value when that is a number of 0 or more.
  {
    const prev = process.env.SQUAD_INVITE_PUSH_MS;
    pushAnswer = true;
    const bound = async (env) => {
      if (env === undefined) delete process.env.SQUAD_INVITE_PUSH_MS; else process.env.SQUAD_INVITE_PUSH_MS = env;
      const st = t6store(ROWS6);
      await st.addFriendship(A, B);
      const S = mkSocial6(st);
      const wa = up6(S, A);
      await create6(S, wa);
      const armed = [];
      const real = globalThis.setTimeout;
      globalThis.setTimeout = function (fn, ms, ...rest) { armed.push(ms); return real(fn, ms, ...rest); };
      try { await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'v' }); }
      finally { globalThis.setTimeout = real; }
      return { armed, delivered: (ans6(wa, 'v') || {}).delivered };
    };
    const got = { unset: await bound(undefined), junk: await bound('soon'), negative: await bound('-5'), zero: await bound('0'), set: await bound('30') };
    if (prev === undefined) delete process.env.SQUAD_INVITE_PUSH_MS; else process.env.SQUAD_INVITE_PUSH_MS = prev;
    const want = { unset: 4000, junk: 4000, negative: 4000, zero: 0, set: 30 };
    const bad = Object.keys(want).filter((k) => !same6(got[k], { armed: [want[k]], delivered: 'push' }));
    if (!bad.length) ok('(inv-r) the push seam is raced against 4000 ms by default, and against the knob only when it is a number of 0 or more');
    else fail('(inv-r) seam bound: ' + JSON.stringify(got));
  }

  // ===== FIX PASS, WORKFLOW ROUND 1 (after 82e025f) ==========================

  // ---- (blk-v) the blocked player's panel is pushed only when the block took
  // a row it showed ----------------------------------------------------------
  // T6-R1-1. D-BLOCK's cover is an unfriend plus a kick or a leave, and it
  // holds only when the pair were friends: squads are joined by code, so a
  // squad of strangers is ordinary. The block used to push the blocked player
  // a friends snapshot whatever it had deleted. No hand act ever sends a
  // friends frame to a player whose panel did not change, so beside a kick,
  // a leave or nothing at all, that frame was a block's signature. Now the
  // blocked player is pushed exactly when the block deleted a row their panel
  // showed: the friendship, or a request either way. B has a second device,
  // B2, that holds no row.
  //
  // failOnce6 fails only the NEXT call to method `m`.
  const failOnce6 = (st, m) => {
    const real = st[m];
    st[m] = async function () { st[m] = real; st.calls.push(m); throw new Error('sb GET 500'); };
  };
  const BLOCKED6 = { type: 'block', op: 'add', ok: true, id: B };
  {
    // (i) Strangers in a squad, whoever leads: exactly a kick (the blocker
    // leads) or a leave (otherwise), and nothing to B's other device.
    const bad = [];
    for (const [lead, others, how] of [[A, [B, C], 'kick'], [B, [A, C], 'leave'], [C, [A, B], 'leave']]) {
      const g = await world6(lead, others, []);
      const g2 = up6(g.S, B);
      await g.S.handle(g.w[A], { type: 'block', op: 'add', id: B });
      const t = await world6(lead, others, []);
      const t2 = up6(t.S, B);
      await (how === 'kick' ? kick6(t, A, B) : t.S.handle(t.w[A], { type: 'squad', op: 'leave' }));
      const mine = seq6(g.mark, [g.w[B], g2, g.w[C]]), twin = seq6(t.mark, [t.w[B], t2, t.w[C]]);
      if (!(same6(ans6(g.w[A], B), BLOCKED6) && mine.length === 2 && same6(mine, twin) && !g2.rx.length))
        bad.push({ lead, block: mine, [how]: twin, b2: g2.rx });
    }
    if (!bad.length) ok('(blk-v) strangers in a squad: the blocked player and the squad receive exactly what a kick (the blocker leads) or a leave (otherwise) sends them, and the blocked player\'s other device nothing');
    else fail('(blk-v) block between strangers vs a kick or a leave: ' + JSON.stringify(bad));
  }
  {
    // (ii) Strangers who share no squad, blocked by account id or by the seat
    // handle a lobby shows: the blocked player receives nothing at all. The
    // blocker still gets its answer and its own panel.
    const bad = [];
    for (const by of ['id', 'handle']) {
      const st = t6store(ROWS6);
      const S = mkSocial6(st, { resolveHandle: (ws, h) => (h === 'seat-3' ? B : null) });
      const wa = up6(S, A), wb = up6(S, B), wb2 = up6(S, B);
      await S.handle(wa, by === 'id' ? { type: 'block', op: 'add', id: B } : { type: 'block', op: 'add', handle: 'seat-3', id: 'h' });
      const r = got6(wa, 'block');
      if (!(r.length === 1 && r[0].ok === true && st.blocks.has(A + '>' + B) && last6(wa, 'friends') && !wb.rx.length && !wb2.rx.length))
        bad.push({ by, a: wa.rx, b: wb.rx, b2: wb2.rx });
    }
    if (!bad.length) ok('(blk-v) a block between strangers who share no squad, by id or by seat handle, sends the blocked player nothing on any device');
    else fail('(blk-v) block with no squad: ' + JSON.stringify(bad));
  }
  {
    // (iii) EACH ROW THE PANEL SHOWED STILL PUSHES IT. B had asked A: B
    // receives exactly what a kick and a decline send. A had asked B: B
    // receives exactly what a kick and a withdraw send. D-BLOCK-5 J first
    // accepted that second push as a residual with no hand twin; the
    // withdraw op (Cancel on a request you sent) is that twin, and the second
    // check compares the two as the first compares a block with a decline.
    const bad = [];
    {
      const g = await world6(A, [B, C], []);
      await g.st.addRequest(B, A);
      const g2 = up6(g.S, B);
      await g.S.handle(g.w[A], { type: 'block', op: 'add', id: B });
      const t = await world6(A, [B, C], []);
      await t.st.addRequest(B, A);
      const t2 = up6(t.S, B);
      await kick6(t, A, B);
      await t.S.handle(t.w[A], { type: 'friend', op: 'decline', from: B });
      const mine = seq6(g.mark, [g.w[B], g2, g.w[C]]), twin = seq6(t.mark, [t.w[B], t2, t.w[C]]);
      if (!(mine.length === 4 && same6(mine, twin) && same6((last6(g2, 'friends') || {}).requests, { in: [], out: [] })))
        bad.push({ rows: 'B asked A', block: mine, kickDecline: twin });
    }
    {
      const g = await world6(A, [B, C], []);
      await g.st.addRequest(A, B);
      const g2 = up6(g.S, B);
      await g.S.handle(g.w[A], { type: 'block', op: 'add', id: B });
      const t = await world6(A, [B, C], []);
      await t.st.addRequest(A, B);
      const t2 = up6(t.S, B);
      await kick6(t, A, B);
      await t.S.handle(t.w[A], { type: 'friend', op: 'withdraw', to: B });
      const mine = seq6(g.mark, [g.w[B], g2, g.w[C]]), twin = seq6(t.mark, [t.w[B], t2, t.w[C]]);
      const fb = got6(g.w[B], 'friends'), fb2 = got6(g2, 'friends');
      if (!(mine.length === 4 && same6(mine, twin) && same6(got6(g.w[B], 'squad'), [KICKED6]) && fb.length === 1 && fb2.length === 1
          && same6(fb[0].requests, { in: [], out: [] }) && same6(fb2[0].requests, { in: [], out: [] })))
        bad.push({ rows: 'A asked B', block: mine, kickWithdraw: twin });
    }
    if (!bad.length) ok('(blk-v) a request either way still pushes the blocked player\'s panel: B\'s own request goes exactly as a kick and a decline send it, and A\'s request to B exactly as a kick and a withdraw send it (D-BLOCK-5 J\'s hand twin)');
    else fail('(blk-v) requests: ' + JSON.stringify(bad));
  }
  {
    // (iv) THE ROWS COULD NOT BE READ. The block goes on, and the blocked
    // player is pushed nothing: a frame to a player whose panel may not have
    // changed is the signature, and no frame is what a hand unfriend gives
    // when its snapshot read fails.
    const g = await world6(A, [B, C]);
    const g2 = up6(g.S, B);
    failOnce6(g.st, 'friendIdsOf');
    await g.S.handle(g.w[A], { type: 'block', op: 'add', id: B });
    if (same6(ans6(g.w[A], B), BLOCKED6) && same6(g.w[B].rx, [KICKED6]) && !g2.rx.length && g.st.blocks.has(A + '>' + B) && g.st.friends.size === 0)
      ok('(blk-v) when the pair\'s rows cannot be read the block still lands and parts them, and the blocked player is pushed no panel');
    else fail('(blk-v) unread rows: ' + JSON.stringify({ a: g.w[A].rx, b: g.w[B].rx, b2: g2.rx, blocks: [...g.st.blocks], friends: [...g.st.friends] }));
  }
  {
    // (v) A HALF-FAILED BLOCK pushes by the same rule: the unfriend throws,
    // the row stands, the answer is ok. Strangers: nothing. Friends: B's
    // panel, which hides a blocked pair whatever rows are left.
    const bad = [];
    for (const friends of [false, true]) {
      const g = await world6(A, [B, C], friends ? [[A, B]] : []);
      g.st.boom.add('removeFriendship');
      await g.S.handle(g.w[A], { type: 'block', op: 'add', id: B });
      g.st.boom.delete('removeFriendship');
      const fb = got6(g.w[B], 'friends');
      if (!(same6(ans6(g.w[A], B), BLOCKED6) && same6(got6(g.w[B], 'squad'), [KICKED6]) && fb.length === (friends ? 1 : 0) && (!friends || same6(fb[0].friends, []))))
        bad.push({ friends, a: g.w[A].rx, b: g.w[B].rx });
    }
    if (!bad.length) ok('(blk-v) a half-failed block pushes the blocked player\'s panel only when the pair were friends');
    else fail('(blk-v) half-failed block: ' + JSON.stringify(bad));
  }

  // ---- (blk-s vii) the pair is apart from the moment the block is asked ----
  // T6-R1-2. The teardown ran when addBlock's answer came. For one store
  // round trip a committed row was invisible here, and Start reads no
  // blocks, so a Start in that moment seated the pair. Since T6-R2-4 an
  // asked block parts the pair on every path, so waiting for the answer
  // changed nothing but the window. Here the row is committed and its answer
  // held while the leader presses Start, whoever leads.
  {
    const bad = [];
    const LEFT = { type: 'squad', op: 'ended', reason: 'left' };
    for (const [lead, others, out, frame] of [[A, [B, C], B, KICKED6], [B, [A, C], A, LEFT], [C, [A, B], A, LEFT]]) {
      const g = await readyWorld6(lead, others);
      const wa2 = lead === A ? up6(g.S, A) : g.w[A];
      const h = stale6(g.st, 'addBlock');
      const pb = g.S.handle(wa2, { type: 'block', op: 'add', id: B });
      const inside = await within6(h.inside);
      const order = [g.w[lead], ...others.map((id) => g.w[id])];
      let r = null;
      if (inside) {
        const told = got6(g.w[out], 'squad').slice();
        await g.S.handle(g.w[lead], { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
        r = { committed: g.st.blocks.has(A + '>' + B), told, s: ans6(g.w[lead], 's'), seats: g.seated.map((l) => l.map((w) => order.indexOf(w))) };
      } else h.restore();
      h.release(); await pb;
      const kept = order.filter((w) => w !== g.w[out]).map((w) => order.indexOf(w));
      if (!(inside && r.committed && same6(r.told, [frame]) && same6(r.s, SEATED6('s')) && same6(r.seats, [kept]) && same6(ans6(wa2, B), BLOCKED6)))
        bad.push({ lead, inside, r });
    }
    if (!bad.length) ok('(blk-s) with the block row committed and its answer still out, the pair is already parted: the leader\'s Start seats one of them, whoever leads');
    else fail('(blk-s) Start while addBlock\'s answer is out: ' + JSON.stringify(bad));
  }

  // ---- (blk-w) while addBlock is out, every door treats the pair as blocked -
  // T6-R1-2's other half. A read that starts while the row is being written
  // can come back without it. So the pair is PENDING from the ask until the
  // answer is in and the pair is logged, and join, the sign-in door and
  // invite merge it as they merge the log. addBlock is parked BEFORE it
  // runs, so the store holds no row while each door reads.
  {
    // (i) A join by code, either way round: B into A's squad, and A's second
    // device into B's. Refused as a dead code, and nothing moves.
    const bad = [];
    for (const dir of ['blocked joins', 'blocker joins']) {
      const j = await joinWorld6();
      const h = holdAt6(j.st, 'addBlock', 1);
      const pb = j.S.handle(j.wa, { type: 'block', op: 'add', id: B });
      const inside = await within6(h.inside);
      let r = null;
      if (inside) {
        const [w, code] = dir === 'blocked joins' ? [j.wb, j.code] : [up6(j.S, A), j.home];
        await j.S.handle(w, { type: 'squad', op: 'join', code, id: 'j' });
        await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'x' });
        await j.S.handle(j.wd, { type: 'squad', op: 'resume', id: 'y' });
        r = { j: ans6(w, 'j'), stored: j.st.blocks.size, x: ids6(ans6(j.wc, 'x')), y: ids6(ans6(j.wd, 'y')) };
      } else h.restore();
      h.release(); await pb;
      if (!(inside && same6(r.j, DEAD6('j')) && r.stored === 0 && same6(r.x, [A, C]) && same6(r.y, [B, D]) && same6(ans6(j.wa, B), BLOCKED6)))
        bad.push({ dir, inside, r, a: got6(j.wa, 'block') });
    }
    if (!bad.length) ok('(blk-w) a join by code while the block is being written is refused as a dead code, either way round, and nothing moves');
    else fail('(blk-w) join while addBlock is out: ' + JSON.stringify(bad));
  }
  {
    // (i b) THE SAME JOIN WITH THE LOG NOT EMPTY (D-BLOCK-6 P). Every world
    // above starts with nothing logged, so a merge that consulted the
    // pending pairs only while the log was empty passed them all. Here an
    // unrelated block, E on NN, has landed and is logged first.
    const j = await joinWorld6();
    const we = up6(j.S, E);
    await j.S.handle(we, { type: 'block', op: 'add', id: NN });
    const logged = j.st.blocks.has(E + '>' + NN);
    const h = holdAt6(j.st, 'addBlock', 1);
    const pb = j.S.handle(j.wa, { type: 'block', op: 'add', id: B });
    const inside = await within6(h.inside);
    let r = null;
    if (inside) {
      await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
      r = { j: ans6(j.wb, 'j'), stored: j.st.blocks.size };
    } else h.restore();
    h.release(); await pb;
    if (logged && inside && same6(r.j, DEAD6('j')) && r.stored === 1)
      ok('(blk-w) with an unrelated block already logged, a join while the block is being written is still refused as a dead code');
    else fail('(blk-w) pending pair with a non-empty log: ' + JSON.stringify({ logged, inside, r }));
  }
  {
    // (ii) The sign-in door: a tab with no account stands in A's squad and
    // says hello as B while A's block on B is out (from A's other device, so
    // the leader's own socket is free to press Start). The door removes the
    // row, still nameless, as a kick, and Start seats A and C.
    const g = await failWorld6(null, false);
    const wa2 = up6(g.S, A);
    const h = holdAt6(g.st, 'addBlock', 1);
    const pb = g.S.handle(wa2, { type: 'block', op: 'add', id: B });
    const inside = await within6(h.inside);
    let r = null;
    if (inside) {
      hello6(g.S, g.wn, B); await settle6();
      const s = await start6(g, 's');
      r = { n: got6(g.wn, 'squad').slice(), s, seats: g.seated.map((l) => l.map((w) => [g.wa, g.wc, g.wn].indexOf(w))) };
    } else h.restore();
    h.release(); await pb;
    if (inside && same6(r.n, [KICKED6]) && same6(r.s, OK6('s')) && same6(r.seats, [[0, 1]]))
      ok('(blk-w) a sign-in while the block is being written: the door removes the row as a kick, and Start seats the leader without the blocked player');
    else fail('(blk-w) sign-in door while addBlock is out: ' + JSON.stringify({ inside, r }));
  }
  {
    // (iii) An invite: C, who is B's friend and in A's squad, invites B while
    // A's block on B is out. It is dropped silently: B gets nothing, and C
    // the answer a delivered invite gets.
    const st = t6store(ROWS6);
    await st.addFriendship(C, B);
    const S = mkSocial6(st);
    const wa = up6(S, A), wc = up6(S, C), wb = up6(S, B);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    clear6(wa, wc, wb);
    const h = holdAt6(st, 'addBlock', 1);
    const pb = S.handle(wa, { type: 'block', op: 'add', id: B });
    const inside = await within6(h.inside);
    if (inside) await S.handle(wc, { type: 'squad', op: 'invite', to: B, id: 'v' }); else h.restore();
    const r = { v: ans6(wc, 'v'), b: invited6(wb).length };
    h.release(); await pb;
    if (inside && same6(r.v, { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'v' }) && r.b === 0)
      ok('(blk-w) an invite to the blocked player while the block is being written is dropped silently, answered as delivered');
    else fail('(blk-w) invite while addBlock is out: ' + JSON.stringify({ inside, r }));
  }
  {
    // (iv) A join whose read went out while addBlock was out and lands after
    // its answer: the pair was logged as the answer came, so it is refused.
    const j = await joinWorld6();
    const h = holdAt6(j.st, 'addBlock', 1);
    const pb = j.S.handle(j.wa, { type: 'block', op: 'add', id: B });
    const inside = await within6(h.inside);
    let r = null;
    if (inside) {
      const s = stale6(j.st, 'blockIdsOf');
      const pj = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
      const out = await within6(s.inside);
      h.release(); await pb;
      if (out) s.release(); else s.restore();
      await pj;
      r = { out, j: ans6(j.wb, 'j') };
    } else { h.restore(); h.release(); await pb; }
    if (inside && r.out && same6(r.j, DEAD6('j')))
      ok('(blk-w) a join whose read spans the block\'s answer is refused: the pair is logged as the answer arrives');
    else fail('(blk-w) join read across the answer: ' + JSON.stringify({ inside, r }));
  }
  {
    // (v) And when that log throws (a clock that throws), the pair stays
    // pending: the same join is still refused, and nothing moves.
    let clockThrows = false;
    const st = t6store(ROWS6);
    const S = createSocial({
      seats: MODE_SEATS, teeIds: TEE_IDS, validRack: validRackFor, schedule: () => () => {},
      store: st, terms: [],
      now: () => { if (clockThrows) { clockThrows = false; throw new Error('clock'); } return CLOCK6; },
      send: (ws, f) => { if (ws && ws.readyState === 1) ws.rx.push(JSON.parse(JSON.stringify(f))); },
    });
    const wa = up6(S, A), wc = up6(S, C), wb = up6(S, B);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    const h = holdAt6(st, 'addBlock', 1);
    const pb = S.handle(wa, { type: 'block', op: 'add', id: B });
    const inside = await within6(h.inside);
    let r = null;
    if (inside) {
      const s = stale6(st, 'blockIdsOf');
      const pj = S.handle(wb, { type: 'squad', op: 'join', code, id: 'j' });
      const out = await within6(s.inside);
      clockThrows = true;
      h.release(); await pb;
      const threw = !clockThrows;
      clockThrows = false;
      if (out) s.release(); else s.restore();
      await pj;
      await S.handle(wc, { type: 'squad', op: 'resume', id: 'x' });
      r = { out, threw, j: ans6(wb, 'j'), x: ids6(ans6(wc, 'x')) };
    } else { h.restore(); h.release(); await pb; }
    if (inside && r.out && r.threw && same6(r.j, DEAD6('j')) && same6(r.x, [A, C]))
      ok('(blk-w) a log that throws as the answer arrives leaves the pair pending: a join whose read spans the answer is still refused');
    else fail('(blk-w) throwing log keeps the pair pending: ' + JSON.stringify({ inside, r }));
  }
  {
    // (vi) THE TEARDOWN RUNS AGAIN AS THE ANSWER ARRIVES, for anything a door
    // could not stop. No known way onto a row passes no door any more (the
    // push-subscription sink goes through server.js's hello path since the
    // whole-branch fix wave), so the state is built by hand: a tab with no
    // account stands in A's squad and becomes B with no onAuth while A's
    // block on B is out. The second teardown removes it as a kick,
    // and the blocker is answered only after that roster, whose name read is
    // held here past every write: members first, actor last.
    const g = await signWorld6(null);
    const wn = t6ws(null);
    await join6(g.S, wn, g.code, 'Bunker');
    clear6(g.wa, g.wc, wn);
    const h = holdAt6(g.st, 'addBlock', 1);
    const pb = g.S.handle(g.wa, { type: 'block', op: 'add', id: B });
    const inside = await within6(h.inside);
    let early = null;
    if (inside) {
      wn.userId = B;
      const n = g.st.hold('profilesByIds');
      h.release();
      const held = await within6(n.inside);
      await settle6();
      early = { held, answered: got6(g.wa, 'block').length, n: got6(wn, 'squad').slice() };
      n.release();
    } else { h.restore(); h.release(); }
    await pb;
    const kinds = g.wa.rx.map((f) => f.type + (f.op ? ':' + f.op : ''));
    await g.S.handle(g.wc, { type: 'squad', op: 'resume', id: 'x' });
    if (inside && early.held && early.answered === 0 && same6(early.n, [KICKED6]) && same6(got6(wn, 'squad'), [KICKED6])
      && same6(ids6(ans6(g.wc, 'x')), [A, C]) && same6(kinds, ['squad:state', 'block:add', 'friends']))
      ok('(blk-w) a row that became the blocked player by no door while the block was out is removed as a kick when the answer arrives, before the blocker is answered');
    else fail('(blk-w) teardown again at the answer: ' + JSON.stringify({ inside, early, n: wn.rx, x: ans6(g.wc, 'x'), kinds }));
  }
  {
    // (vii) A PAIR STOPS BEING PENDING ONCE IT IS LOGGED. A blocks B, then
    // lifts the block; B then joins A's squad by code and is let in. Kept
    // pending, the pair would stay apart for the life of the process.
    const j = await joinWorld6();
    await j.S.handle(j.wa, { type: 'block', op: 'add', id: B });
    await j.S.handle(j.wa, { type: 'block', op: 'remove', id: B });
    await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'x' });
    if (!j.st.blocks.size && (ans6(j.wb, 'j') || {}).op === 'state' && same6(ids6(ans6(j.wc, 'x')), [A, C, B]))
      ok('(blk-w) once a block is answered and lifted, the pair is no longer pending: a join by code lets the blocked player in');
    else fail('(blk-w) pending after the answer: ' + JSON.stringify({ blocks: [...j.st.blocks], j: ans6(j.wb, 'j'), x: ans6(j.wc, 'x') }));
  }
  {
    // (viii) THE PENDING PAIR IS THE ACCOUNT THAT ASKED (D-BLOCK-2 D). A's
    // second tab blocks B and says hello as D while the profile read is out.
    // The pair being written is still A and B, so B's join into A's squad
    // while the block is being written is refused.
    const j = await joinWorld6();
    const wx = up6(j.S, A);
    const p = holdAt6(j.st, 'profileById', 1);
    const h = holdAt6(j.st, 'addBlock', 1);
    const pb = j.S.handle(wx, { type: 'block', op: 'add', id: B });
    const in1 = await within6(p.inside);
    let r = null;
    if (in1) {
      hello6(j.S, wx, D);
      p.release();
      const in2 = await within6(h.inside);
      if (in2) {
        await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
        await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'x' });
        r = { j: ans6(j.wb, 'j'), x: ids6(ans6(j.wc, 'x')) };
      } else h.restore();
    } else { p.restore(); h.restore(); p.release(); }
    h.release(); await pb;
    if (in1 && r && same6(r.j, DEAD6('j')) && same6(r.x, [A, C]) && j.st.blocks.has(A + '>' + B))
      ok('(blk-w) the pair pending is the account that asked, though its tab became another account before the write: the blocked player\'s join is refused');
    else fail('(blk-w) pending names the asker: ' + JSON.stringify({ in1, r, blocks: [...j.st.blocks] }));
  }
  {
    // (ix) A PENDING PAIR MOVES ONLY THE TWO IT NAMES (D-BLOCK-3 G's rule for
    // the log). D, a member of A's squad, is blocking E, who is in no squad.
    // While that block is being written A invites B, B joins by code, and a
    // tab with no account in the squad signs in as NN, an account no block
    // names. All three go through: the pair D and E is nobody else's, and an
    // in-flight block is no way to hold up the rest of a squad.
    const st = t6store(ROWS6);
    await st.addFriendship(A, B);
    const S = mkSocial6(st);
    const wa = up6(S, A), wb = up6(S, B), wd = up6(S, D), we = up6(S, E);
    const code = await create6(S, wa);
    await join6(S, wd, code, 'Dune Four');
    const wn = t6ws(null);
    await join6(S, wn, code, 'Nameless');
    clear6(wa, wb, wd, we, wn);
    const h = holdAt6(st, 'addBlock', 1);
    const pb = S.handle(wd, { type: 'block', op: 'add', id: E });
    const inside = await within6(h.inside);
    let r = null;
    if (inside) {
      await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'v' });
      const invited = invited6(wb).length;
      await S.handle(wb, { type: 'squad', op: 'join', code, id: 'j' });
      hello6(S, wn, NN); await settle6();
      await S.handle(wa, { type: 'squad', op: 'resume', id: 'x' });
      r = { invited, v: (ans6(wa, 'v') || {}).delivered, j: (ans6(wb, 'j') || {}).op, n: got6(wn, 'squad', 'ended').length, x: ids6(ans6(wa, 'x')) };
    } else h.restore();
    h.release(); await pb;
    if (inside && same6(r, { invited: 1, v: 'online', j: 'state', n: 0, x: [A, D, NN, B] }))
      ok('(blk-w) while a block between two other players is being written, an invite, a join and a sign-in elsewhere all go through');
    else fail('(blk-w) an unrelated pending pair: ' + JSON.stringify({ inside, r }));
  }

  // ---- (sg-k) a GUEST row a join made is not read again on the next hello --
  // T6-R1-3, the guest-row twin of (sg-j). An anonymous account's rows are
  // always guest rows, so (sg-j)'s key test does not cover them. GU's door
  // fails on a guest row in C's squad T. GU then joins D's squad U by code,
  // and that join reads GU's blocks, so it lets the socket in as GU. GU's
  // next hello (a rotated token) must open no door on the row the join made:
  // with the store failing it reads nothing and keeps nothing out of Start,
  // and with a block row the server never saw land it removes nobody.
  const guestThen6 = async () => {
    const seated = [];
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { seatSquad: (seats) => { seated.push(seats.map((s) => s.ws)); return { ok: true, code: 'RM6G' }; } });
    const wc = up6(S, C);
    const T = await create6(S, wc);
    const wg = t6ws(null);
    await join6(S, wg, T, 'Ghost');
    st.boom.add('blockIdsOf'); hello6(S, wg, GU, true); await settle6(); st.boom.delete('blockIdsOf');
    const wd = up6(S, D);
    const U = await create6(S, wd);
    await join6(S, wg, U, 'Ghost');
    await S.handle(wd, { type: 'squad', op: 'mode', mode: 'ffa' });
    await S.handle(wg, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    clear6(wc, wd, wg);
    st.calls.length = 0;
    return { st, S, wc, wd, wg, U, seated };
  };
  {
    const bad = [];
    {
      const g = await guestThen6();
      g.st.boom.add('blockIdsOf'); hello6(g.S, g.wg, GU, true); await settle6(); g.st.boom.delete('blockIdsOf');
      const reads = reads6(g.st);
      await g.S.handle(g.wd, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
      const s = ans6(g.wd, 's');
      const seats = g.seated.map((l) => l.map((w) => [g.wd, g.wg].indexOf(w)));
      if (!(reads === 0 && same6(s, { type: 'squad', op: 'start', ok: true, code: 'RM6G', id: 's' }) && same6(seats, [[0, 1]])))
        bad.push({ store: 'failing', reads, s, seats });
    }
    {
      const g = await guestThen6();
      g.st.blocks.add(D + '>' + GU);
      hello6(g.S, g.wg, GU, true); await settle6();
      const reads = reads6(g.st);
      await g.S.handle(g.wd, { type: 'squad', op: 'resume', id: 'r' });
      const x = ans6(g.wd, 'r');
      if (!(reads === 0 && !got6(g.wg, 'squad').length && x && same6(ids6(x), [D, null]) && x.leader === D))
        bad.push({ store: 'block row', reads, g: got6(g.wg, 'squad'), x });
    }
    if (!bad.length) ok('(sg-k) after a failed door, a join puts an anonymous guest on a row it vetted, and a same-account hello then opens no door on it: no read, nothing kept out of Start, nobody removed');
    else fail('(sg-k) guest row after a failed door: ' + JSON.stringify(bad));
  }
  {
    // CONTROL: a join that finds the socket ALREADY in that squad makes no
    // row, and the door-failed row it finds keeps its door: the next hello
    // reads again and lets it in, and Start then seats it.
    const seated = [];
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { seatSquad: (seats) => { seated.push(seats.length); return { ok: true, code: 'RM6G' }; } });
    const wc = up6(S, C);
    const T = await create6(S, wc);
    await S.handle(wc, { type: 'squad', op: 'mode', mode: 'ffa' });
    const wg = t6ws(null);
    await join6(S, wg, T, 'Ghost');
    await S.handle(wg, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    st.boom.add('blockIdsOf'); hello6(S, wg, GU, true); await settle6(); st.boom.delete('blockIdsOf');
    await S.handle(wg, { type: 'squad', op: 'join', code: T, name: 'Ghost', skin: 'olive', id: 'again' });
    const again = ans6(wg, 'again');
    st.calls.length = 0;
    hello6(S, wg, GU, true); await settle6();
    const reads = reads6(st);
    await S.handle(wc, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    if ((again || {}).op === 'state' && reads === 1 && same6(ans6(wc, 's'), { type: 'squad', op: 'start', ok: true, code: 'RM6G', id: 's' }) && same6(seated, [2]))
      ok('(sg-k) a join into the squad the guest already stands in leaves its failed door open: the next hello reads again, and Start seats it');
    else fail('(sg-k) already-here join keeps the door: ' + JSON.stringify({ again, reads, s: ans6(wc, 's'), seated }));
  }

  // ---- (blk-u iii, b) a block that failed before it was asked logs nothing -
  // T6-R1-7. Only an ASKED block may be treated as landed. A block that fails
  // at its profile read wrote nothing, so the recent-blocks log must not hold
  // the pair: a join whose read was out when it failed is let in, and so is
  // one made after it, well inside the log's 16 s.
  {
    const j = await joinWorld6();
    const h = stale6(j.st, 'blockIdsOf');
    const pj = j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    const inside = await within6(h.inside);
    if (inside) { j.st.boom.add('profileById'); await j.S.handle(j.wa, { type: 'block', op: 'add', id: B }); j.st.boom.delete('profileById'); } else h.restore();
    h.release(); await pj;
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r' });
    const raced = { j: (ans6(j.wb, 'j') || {}).op, x: ids6(ans6(j.wc, 'r')) };
    await j.S.handle(j.wb, { type: 'squad', op: 'leave', id: 'l' });
    await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j2' });
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r2' });
    const later = { j: (ans6(j.wb, 'j2') || {}).op, x: ids6(ans6(j.wc, 'r2')) };
    if (inside && same6(got6(j.wa, 'block'), [LOST6]) && !j.st.blocks.size && same6(raced, { j: 'state', x: [A, C, B] }) && same6(later, { j: 'state', x: [A, C, B] }))
      ok('(blk-u) a block that failed before addBlock was asked logs nothing: a join whose read was out, and one made after, are both let in');
    else fail('(blk-u) failed profile read, log left alone: ' + JSON.stringify({ inside, a: got6(j.wa, 'block'), raced, later }));
  }

  // ===== CONTROLLER FIX PASS: D-BLOCK-5 =======================================

  // ---- (blk-u vi) an addBlock that throws and commits AFTER its answer -----
  // D-BLOCK-5 K. The write answers with a failure (sbAdmin's timeout) and its
  // row lands later. The log serves only reads that were out at the answer,
  // so a join made after it read no row, and Start seated the pair once the
  // row had landed. Now a thrown pair counts as blocked for 16 s by every
  // reader it names: either way round the join is refused as a dead code,
  // and after the row lands each leader's Start seats only its own squad.
  const lateCommit6 = (st) => {
    const real = st.addBlock;
    let args = null;
    st.addBlock = async function (...a) { st.addBlock = real; st.calls.push('addBlock'); args = a; throw new Error('sb timeout'); };
    return () => real.apply(st, args);
  };
  {
    const bad = [];
    for (const dir of ['blocked joins', 'blocker joins']) {
      const seated = [];
      const st = t6store(ROWS6);
      const S = mkSocial6(st, { seatSquad: (seats) => { seated.push(seats.map((s) => s.ws)); return { ok: true, code: 'RM6S' }; } });
      const wa = up6(S, A), wc = up6(S, C), wb = up6(S, B), wd = up6(S, D);
      const code = await create6(S, wa);
      await join6(S, wc, code, 'Crater Two');
      const home = await create6(S, wb);
      await join6(S, wd, home, 'Dune Four');
      for (const [lead, mate] of [[wa, wc], [wb, wd]]) {
        await S.handle(lead, { type: 'squad', op: 'mode', mode: 'ffa' });
        await S.handle(mate, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
      }
      const commit = lateCommit6(st);
      await S.handle(wa, { type: 'block', op: 'add', id: B });
      const [w, into, lead, order] = dir === 'blocked joins' ? [wb, code, wa, [wa, wc, wb]] : [up6(S, A), home, wb, [wb, wd]];
      if (dir === 'blocker joins') order.push(w);
      await S.handle(w, { type: 'squad', op: 'join', code: into, name: 'Somebody', skin: 'olive', id: 'j' });
      const j = ans6(w, 'j');
      if (j && j.op === 'state') await S.handle(w, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
      await commit();
      await S.handle(lead, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
      const seats = seated.map((l) => l.map((x) => order.indexOf(x)));
      if (!(same6(got6(wa, 'block'), [LOST6]) && same6(j, DEAD6('j')) && st.blocks.has(A + '>' + B) && same6(ans6(lead, 's'), SEATED6('s')) && same6(seats, [[0, 1]])))
        bad.push({ dir, a: got6(wa, 'block'), j, blocks: [...st.blocks], s: ans6(lead, 's'), seats });
    }
    if (!bad.length) ok('(blk-u) an addBlock that throws and commits after its answer: a join after the answer is refused as a dead code either way round, and once the row lands Start seats the pair apart');
    else fail('(blk-u) late commit after a thrown addBlock: ' + JSON.stringify(bad));
  }
  {
    // The thrown pair is the account that ASKED (D-BLOCK-2 D): A's second tab
    // blocks B and says hello as D during the profile read. B's join into
    // A's squad after the answer is still refused.
    const j = await joinWorld6();
    const wx = up6(j.S, A);
    const p = holdAt6(j.st, 'profileById', 1);
    const commit = lateCommit6(j.st);
    const pb = j.S.handle(wx, { type: 'block', op: 'add', id: B });
    const inside = await within6(p.inside);
    if (inside) hello6(j.S, wx, D); else p.restore();
    p.release(); await pb;
    await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'j' });
    await commit();
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'x' });
    if (inside && same6(ans6(wx, B), LOST6) && same6(ans6(j.wb, 'j'), DEAD6('j')) && same6(ids6(ans6(j.wc, 'x')), [A, C]) && j.st.blocks.has(A + '>' + B))
      ok('(blk-u) the thrown pair is the account that asked, though its tab became another account before the write: the blocked player\'s join is refused');
    else fail('(blk-u) thrown pair names the asker: ' + JSON.stringify({ inside, a: ans6(wx, B), j: ans6(j.wb, 'j'), x: ans6(j.wc, 'x'), blocks: [...j.st.blocks] }));
  }

  // ---- (blk-u v) an addBlock that throws WITHOUT committing ----------------
  // D-BLOCK-5 K and L. The blocker is answered unavailable and no row
  // exists. It might yet land, so for 16 s after the answer the pair still
  // counts as blocked: (a) B's join by code is refused as a dead code up to
  // and including the 16th second, and C's roster is A and C. From the next
  // millisecond it lets B in, and C's roster shows B.
  {
    const j = await joinWorld6();
    failOnce6(j.st, 'addBlock');
    await j.S.handle(j.wa, { type: 'block', op: 'add', id: B });
    const t0 = CLOCK6;
    CLOCK6 = t0 + 16000;
    await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'in' });
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r1' });
    CLOCK6 = t0 + 16001;
    await j.S.handle(j.wb, { type: 'squad', op: 'join', code: j.code, id: 'out' });
    await j.S.handle(j.wc, { type: 'squad', op: 'resume', id: 'r2' });
    const late = ans6(j.wb, 'out');
    if (same6(got6(j.wa, 'block'), [LOST6]) && !j.st.blocks.size && same6(ans6(j.wb, 'in'), DEAD6('in')) && same6(ids6(ans6(j.wc, 'r1')), [A, C])
      && late && late.op === 'state' && late.code === j.code && same6(ids6(ans6(j.wc, 'r2')), [A, C, B]))
      ok('(blk-u) an addBlock that throws without committing keeps the pair apart for 16 s: a join is refused to the last millisecond of it, and lets B in after');
    else fail('(blk-u) thrown addBlock, no row: ' + JSON.stringify({ a: got6(j.wa, 'block'), blocks: [...j.st.blocks], in: ans6(j.wb, 'in'), r1: ids6(ans6(j.wc, 'r1')), out: late, r2: ids6(ans6(j.wc, 'r2')) }));
  }
  {
    // (b) (blk-w vi) with that write: a tab with no account in A's squad
    // becomes B by no door (built by hand, as (vi) builds it) while the write is
    // out, and the write then fails without committing. The second teardown
    // still removes the row as a kick, and the blocker's answer, unavailable,
    // comes only after that roster, whose name read is held. The same when
    // the clock throws as the failure is noted: the pair stays pending, and
    // the teardown still runs.
    const holdFail6 = (st) => {
      const real = st.addBlock;
      let release, entered;
      const open = new Promise((r) => { release = r; });
      const inside = new Promise((r) => { entered = r; });
      const wrap = async function () { st.addBlock = real; st.calls.push('addBlock'); entered(); await open; throw new Error('sb 500'); };
      st.addBlock = wrap;
      return { release, inside, restore: () => { if (st.addBlock === wrap) st.addBlock = real; } };
    };
    const bad = [];
    for (const clock of ['steady', 'throwing']) {
      let clockThrows = false;
      const st = t6store(ROWS6);
      const S = createSocial({
        seats: MODE_SEATS, teeIds: TEE_IDS, validRack: validRackFor, schedule: () => () => {},
        store: st, terms: [],
        now: () => { if (clockThrows) { clockThrows = false; throw new Error('clock'); } return CLOCK6; },
        send: (ws, f) => { if (ws && ws.readyState === 1) ws.rx.push(JSON.parse(JSON.stringify(f))); },
      });
      const wa = up6(S, A), wc = up6(S, C);
      const code = await create6(S, wa);
      await join6(S, wc, code, 'Crater Two');
      const wn = t6ws(null);
      await join6(S, wn, code, 'Bunker');
      clear6(wa, wc, wn);
      const h = holdFail6(st);
      const pb = S.handle(wa, { type: 'block', op: 'add', id: B });
      const inside = await within6(h.inside);
      let early = null;
      if (inside) {
        wn.userId = B;
        const n = st.hold('profilesByIds');
        clockThrows = clock === 'throwing';
        h.release();
        const held = await within6(n.inside);
        await settle6();
        early = { held, threw: clock === 'steady' || !clockThrows, answered: got6(wa, 'block').length, n: got6(wn, 'squad').slice() };
        clockThrows = false;
        n.release();
      } else { h.restore(); h.release(); }
      await pb;
      const kinds = wa.rx.map((f) => f.type + (f.op ? ':' + f.op : ''));
      await S.handle(wc, { type: 'squad', op: 'resume', id: 'x' });
      if (!(inside && early.held && early.threw && early.answered === 0 && same6(early.n, [KICKED6]) && same6(got6(wn, 'squad'), [KICKED6]) && !st.blocks.size
        && same6(got6(wa, 'block'), [LOST6]) && same6(ids6(ans6(wc, 'x')), [A, C]) && same6(kinds, ['squad:state', 'block:add'])))
        bad.push({ clock, inside, early, n: wn.rx, x: ans6(wc, 'x'), kinds });
    }
    if (!bad.length) ok('(blk-u) with an addBlock that fails without committing, a row that became the blocked player by no door is still removed as a kick before the blocker is answered, and so when the clock throws at the note');
    else fail('(blk-u) thrown addBlock, second teardown: ' + JSON.stringify(bad));
  }

  // ---- (blk-u vii) what the thrown set keeps (D-BLOCK-5 K; T6-R1-1) --------
  // A failed addBlock is kept 16 s only when it may yet commit, and it is
  // kept so that one account's failures move no unrelated reader. Before
  // this, every failure took a slot of one list, and the 4097th inside 16 s
  // made EVERY reader on the server fail safe (every join refused, every
  // sign-in door failed to guest, every invite dropped). A client could do
  // that alone: a socket whose account was deleted after its hello gets a
  // foreign-key refusal for every block it asks for.
  //   (a) A REFUSAL IS NOT KEPT. sbAdmin's `sb POST <4xx>` (408 aside) is
  //       PostgREST refusing the row, and a refused row never lands. A
  //       timeout, a network error, a 5xx or a 408 may have landed, or may
  //       land yet, and is kept: the pair is apart to the 16th second and
  //       meets from the next millisecond.
  //   (b) A flood of refusals keeps nothing: an unrelated join, the flooding
  //       account's own join and a join into its squad are let in on one read.
  //   (c) A REPEATED PAIR TAKES ONE SLOT. 4097 failures of one pair move no
  //       other reader, and the repeat renews the pair's 16 s; a repeat
  //       stamped earlier (the clock stepped back) shortens nothing.
  //   (d) ONE ACCOUNT KEEPS AT MOST 64 PAIRS. Its 65th distinct failure
  //       keeps the ACCOUNT instead, for 16 s: it may have blocked anybody,
  //       so its own reads fail safe (its join reads twice and is refused)
  //       and nobody joins a squad it stands in; a join elsewhere is let in
  //       on one read. Its next failure renews that, never shortens it, and
  //       it holds after the account's pairs have expired.
  //   (e) THE SET HOLDS 4096 PAIRS AND 4096 ACCOUNTS. With 4096 pairs kept an
  //       account whose failure finds no room is kept whole, as in (d), and
  //       nobody else moves. Only when 4096 accounts are kept too does every
  //       reader fail safe, until that failure would have expired (never
  //       sooner, if the clock steps back): that is thousands of accounts
  //       failing inside 16 s, a store outage rather than one client.
  //   (f) ROOM IS MADE ON WRITE: a failure written after the others have
  //       expired drops them and is kept as a pair; written at their 16th
  //       second it finds them still kept. The same for one account's 64,
  //       and for the accounts kept whole. One renewed meanwhile has moved
  //       to the back, so it holds none of the expired ones in place.
  const TGT6 = Array.from({ length: 65 }, (_, i) => uid6(100 + i));
  const ROWS_T6 = [...ROWS6, ...TGT6.map((id) => ({ id, callsign: null, friend_code: null, callsign_key: null, callsign_set_at: null }))];
  // Every addBlock throws what `mk` makes, until restored.
  const failAs6 = (st, mk) => {
    const real = st.addBlock;
    st.addBlock = async function () { st.calls.push('addBlock'); throw mk(); };
    return () => { st.addBlock = real; };
  };
  // A join by `w` into `code`: the block reads it made, whether it was let
  // in, and whether it was refused as a dead code. Let in, it leaves again.
  let tj6 = 0;
  const tryJoin6 = async (j, w, code) => {
    const id = 'tj' + (++tj6);
    j.st.calls.length = 0;
    await j.S.handle(w, { type: 'squad', op: 'join', code, name: 'Somebody', skin: 'olive', id });
    const a = ans6(w, id);
    const r = { reads: reads6(j.st), joined: !!(a && a.op === 'state' && a.code === code), dead: same6(a, DEAD6(id)) };
    if (r.joined) await j.S.handle(w, { type: 'squad', op: 'leave', id: id + 'l' });
    return r;
  };
  const IN6 = { reads: 1, joined: true, dead: false };
  const APART6 = { reads: 1, joined: false, dead: true };
  // A reader whose OWN account is kept whole, or any reader while every
  // reader fails safe, is refused on ONE read (D-BLOCK-6 O): nothing a second
  // read could find would let it in, so it is not asked. (Until the
  // whole-branch fix wave it read twice.) Only a read whose logged entries
  // were dropped while it was out reads again.
  const OUT6 = { reads: 1, joined: false, dead: true };
  const E503 = () => new Error('sb POST 503');
  {
    // (a) A blocks B, and addBlock fails as each of these. B's join into
    // A's squad after the answer, at the answer's time, at +16000 and at
    // +16001.
    const cases = [
      ...[400, 401, 403, 404, 409, 429].map((s) => ['sb POST ' + s, () => new Error('sb POST ' + s), true]),
      ...[408, 500, 502, 503, 504].map((s) => ['sb POST ' + s, () => new Error('sb POST ' + s), false]),
      ['timeout', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError'), false],
      ['network', () => new TypeError('fetch failed'), false],
    ];
    const bad = [];
    for (const [name, mk, refused] of cases) {
      const j = await joinWorld6();
      const restore = failAs6(j.st, mk);
      await j.S.handle(j.wa, { type: 'block', op: 'add', id: B });
      restore();
      const t0 = CLOCK6;
      const at = await tryJoin6(j, j.wb, j.code);
      CLOCK6 = t0 + 16000;
      const edge = await tryJoin6(j, j.wb, j.code);
      CLOCK6 = t0 + 16001;
      const past = await tryJoin6(j, j.wb, j.code);
      const want = refused ? [IN6, IN6, IN6] : [APART6, APART6, IN6];
      if (!(same6(got6(j.wa, 'block'), [LOST6]) && same6([at, edge, past], want))) bad.push({ name, a: got6(j.wa, 'block'), at, edge, past });
    }
    if (!bad.length) ok('(blk-u) a refused addBlock (a 4xx but 408) is not kept, and B joins at once; a timeout, a network error, a 5xx or a 408 keeps the pair apart 16 s');
    else fail('(blk-u) which failures are kept: ' + JSON.stringify(bad));
  }
  {
    // (b) E floods refusals: 4097 on NN, then one on each of 65 others.
    const j = await joinWorld6(ROWS_T6);
    const o = outs6(j.S);
    const restore = failAs6(j.st, () => new Error('sb POST 409'));
    for (let i = 0; i < 4097; i++) await blk6(j.S, o.e, NN);
    for (const t of TGT6) await blk6(j.S, o.e, t);
    restore();
    const b = await tryJoin6(j, j.wb, j.code);
    const e = await tryJoin6(j, o.e, j.code);
    const ec = await create6(j.S, o.e);
    const n = await tryJoin6(j, o.n, ec);
    const x = await tryJoin6(j, j.wb, ec);
    if (same6([b, e, n, x], [IN6, IN6, IN6, IN6])) ok('(blk-u) a flood of refused addBlocks keeps nothing: an unrelated join, the flooding account\'s own join, and joins into its squad are let in on one read');
    else fail('(blk-u) refusal flood: ' + JSON.stringify({ b, e, n, x }));
  }
  {
    // (c) E's block on NN fails (a 5xx) 4097 times.
    const j = await joinWorld6(ROWS_T6);
    const o = outs6(j.S);
    const restore = failAs6(j.st, E503);
    const t0 = CLOCK6;
    for (let i = 0; i < 4097; i++) await blk6(j.S, o.e, NN);
    const b = await tryJoin6(j, j.wb, j.code);
    const e = await tryJoin6(j, o.e, j.code);
    const ec = await create6(j.S, o.e);
    const n0 = await tryJoin6(j, o.n, ec);
    CLOCK6 = t0 + 10000;
    await blk6(j.S, o.e, NN);
    CLOCK6 = t0 - 5000;
    await blk6(j.S, o.e, NN);
    restore();
    CLOCK6 = t0 + 26000;
    const n1 = await tryJoin6(j, o.n, ec);
    CLOCK6 = t0 + 26001;
    const n2 = await tryJoin6(j, o.n, ec);
    if (same6([b, e, n0, n1, n2], [IN6, IN6, APART6, APART6, IN6]))
      ok('(blk-u) a repeated failing pair takes one slot: 4097 of them move no other reader, and a repeat renews the pair\'s 16 s (one stamped earlier shortens nothing)');
    else fail('(blk-u) repeated pair: ' + JSON.stringify({ b, e, n0, n1, n2 }));
  }
  {
    // (d) E's blocks on 64 distinct players fail, then a 65th.
    const j = await joinWorld6(ROWS_T6);
    const o = outs6(j.S);
    const restore = failAs6(j.st, E503);
    for (const t of TGT6.slice(0, 64)) await blk6(j.S, o.e, t);
    const e0 = await tryJoin6(j, o.e, j.code);
    const t0 = CLOCK6;
    await blk6(j.S, o.e, TGT6[64]);
    restore();
    const r = [];
    for (const ms of [0, 16000, 16001]) {
      CLOCK6 = t0 + ms;
      const ec = await create6(j.S, o.e);
      r.push({ ms, b: await tryJoin6(j, j.wb, j.code), be: await tryJoin6(j, j.wb, ec), e: await tryJoin6(j, o.e, j.code) });
    }
    const want = [{ ms: 0, b: IN6, be: APART6, e: OUT6 }, { ms: 16000, b: IN6, be: APART6, e: OUT6 }, { ms: 16001, b: IN6, be: IN6, e: IN6 }];
    // The account kept whole at t1+10000, while its 64 pairs (t1) stand. At
    // t1+16001 they have gone, and its next failure renews it; one stamped
    // at t1 (the clock stepped back) shortens nothing.
    const k = await joinWorld6(ROWS_T6);
    const p = outs6(k.S);
    const again = failAs6(k.st, E503);
    const t1 = CLOCK6;
    for (const t of TGT6.slice(0, 64)) await blk6(k.S, p.e, t);
    CLOCK6 = t1 + 10000;
    await blk6(k.S, p.e, TGT6[64]);
    CLOCK6 = t1 + 16001;
    await blk6(k.S, p.e, TGT6[64]);
    const r1 = await tryJoin6(k, p.e, k.code);
    CLOCK6 = t1;
    await blk6(k.S, p.e, TGT6[64]);
    again();
    CLOCK6 = t1 + 32001;
    const r2 = await tryJoin6(k, p.e, k.code);
    CLOCK6 = t1 + 32002;
    const r3 = await tryJoin6(k, p.e, k.code);
    // Invite counts the account kept whole as blocking too: an invite out of
    // its squad goes nowhere, its inviter told what a real one is told. From
    // the next millisecond after its 16 s the invite goes out. The sign-in
    // door does NOT (D-BLOCK-6 M): a guest in its squad who signs in is not
    // kicked for a block nobody knows was made; that door fails to guest,
    // and (blk-doubt) follows the row from there.
    const q = await joinWorld6(ROWS_T6);
    const qo = outs6(q.S);
    q.st.friends.add(PAIR6(E, C));
    const qa = failAs6(q.st, E503);
    const tq = CLOCK6;
    for (const t of TGT6) await blk6(q.S, qo.e, t);
    qa();
    const qc = await create6(q.S, qo.e);
    const wq = t6ws(null);
    await join6(q.S, wq, qc, 'Guest');
    hello6(q.S, wq, D); await settle6();
    await q.S.handle(qo.e, { type: 'squad', op: 'invite', to: C, id: 'i1' });
    const i1 = ans6(qo.e, 'i1'), c1 = invited6(q.wc).length;
    CLOCK6 = tq + 16000;
    await q.S.handle(qo.e, { type: 'squad', op: 'invite', to: C, id: 'i2' });
    const i2 = ans6(qo.e, 'i2'), c2 = invited6(q.wc).length;
    CLOCK6 = tq + 16001;
    await q.S.handle(qo.e, { type: 'squad', op: 'invite', to: C, id: 'i3' });
    const i3 = ans6(qo.e, 'i3'), c3 = invited6(q.wc).length;
    const sent = (a) => !!(a && a.ok === true && a.delivered === 'online');
    const doors = { door: got6(wq, 'squad', 'ended'), i1: sent(i1), c1, i2: sent(i2), c2, i3: sent(i3), c3 };
    if (same6(e0, IN6) && same6(r, want) && same6([r1, r2, r3], [OUT6, OUT6, IN6])
      && same6(doors, { door: [], i1: true, c1: 0, i2: true, c2: 0, i3: true, c3: 1 }))
      ok('(blk-u) one account keeps at most 64 failing pairs: its 65th keeps the account 16 s, so its own join fails safe on one read and nobody joins or is invited into its squad (a guest there who signs in is not kicked), while a join elsewhere is let in on one read; its next failure renews that, never shortens it');
    else fail('(blk-u) one account\'s share: ' + JSON.stringify({ e0, r, renewed: [r1, r2, r3], doors, i1, i2, i3 }));
  }
  {
    // (blk-doubt) DOUBT AT THE SIGN-IN DOOR IS A FAILED READ, NOT A KICK
    // (D-BLOCK-6 M). E, kept whole (its 65th failing block had no room),
    // leads a squad. A tab with no account joins it and signs in as NN, whom
    // nobody has blocked and who stands in no squad. The row is not removed and D is told nothing; it
    // stays a nameless guest row, and E's Start refuses it member_offline,
    // exactly as for a read that failed. Once E's 16 s are up, that refused
    // Start runs the door again, which lets D in, named.
    const q = await joinWorld6(ROWS_T6);
    const qo = outs6(q.S);
    const qa = failAs6(q.st, E503);
    const tq = CLOCK6;
    for (const t of TGT6) await blk6(q.S, qo.e, t);
    qa();
    const qc = await create6(q.S, qo.e);
    const wq = t6ws(null);
    await join6(q.S, wq, qc, 'Guest');
    q.st.calls.length = 0;
    hello6(q.S, wq, NN); await settle6();
    const read = reads6(q.st);
    const told = got6(wq, 'squad', 'ended').length;
    await q.S.handle(qo.e, { type: 'squad', op: 'start', id: 's1' });
    const s1 = ans6(qo.e, 's1');
    const nameless = (last6(qo.e, 'squad', 'state') || { members: [] }).members.map((m) => [m.id, m.guest]);
    CLOCK6 = tq + 16001;
    await q.S.handle(qo.e, { type: 'squad', op: 'start', id: 's2' });
    await settle6();
    await q.S.handle(qo.e, { type: 'squad', op: 'start', id: 's3' });
    const s3 = ans6(qo.e, 's3');
    const named = (last6(qo.e, 'squad', 'state') || { members: [] }).members.map((m) => [m.id, m.guest]);
    CLOCK6 = tq;
    if (read === 1 && told === 0 && same6(s1, { type: 'squad', op: 'start', error: 'member_offline', at: 1, id: 's1' })
      && same6(nameless, [[E, false], [null, true]]) && same6(s3, { type: 'squad', op: 'start', error: 'not_ready', id: 's3' }) && same6(named, [[E, false], [NN, false]]))
      ok('(blk-doubt) a member kept whole is doubt at the sign-in door: the row fails to guest, unkicked and nameless, out of Start, and is let in once the doubt has expired');
    else fail('(blk-doubt) doubt at the door: ' + JSON.stringify({ read, told, s1, nameless, s3, named }));
  }
  {
    // (blk-kept) AN INVITE TO AN ACCOUNT KEPT WHOLE READS ITS BLOCKS ONCE
    // (D-BLOCK-6 O). The invitee's answer is KEPT, not dropped log entries,
    // so no second read is made: two blockIdsOf in all (the inviter's and
    // the invitee's), and the invite is dropped, answered as delivered.
    const j = await joinWorld6(ROWS_T6);
    const o = outs6(j.S);
    j.st.friends.add(PAIR6(A, E));
    const restore = failAs6(j.st, E503);
    for (const t of TGT6) await blk6(j.S, o.e, t);
    restore();
    clear6(o.e);
    j.st.calls.length = 0;
    await j.S.handle(j.wa, { type: 'squad', op: 'invite', to: E, id: 'ko' });
    const r = { reads: reads6(j.st), a: ans6(j.wa, 'ko'), got: invited6(o.e).length };
    if (same6(r, { reads: 2, a: { type: 'squad', op: 'invite', ok: true, delivered: 'online', id: 'ko' }, got: 0 }))
      ok('(blk-kept) an invite to an account kept whole reads its blocks once, and is dropped, answered as delivered');
    else fail('(blk-kept) invite to an account kept whole: ' + JSON.stringify(r));
  }
  // 64 accounts, each failing on the same 64 players: 4096 pairs kept.
  const fill6 = async (j, base) => {
    const ws = [];
    for (let k = 0; k < 64; k++) {
      const w = up6(j.S, uid6(base + k));
      ws.push(w);
      for (const t of TGT6.slice(0, 64)) await blk6(j.S, w, t);
    }
    return ws;
  };
  {
    // (e) 4096 pairs, then accounts with no room, then one account too many.
    const j = await joinWorld6(ROWS_T6);
    const restore = failAs6(j.st, E503);
    const t1 = CLOCK6;
    await fill6(j, 20000);
    const b0 = await tryJoin6(j, j.wb, j.code);
    const f = up6(j.S, uid6(30000));
    await blk6(j.S, f, TGT6[0]);
    const f1 = await tryJoin6(j, f, j.code);
    const b1 = await tryJoin6(j, j.wb, j.code);
    for (let k = 1; k < 4096; k++) await blk6(j.S, up6(j.S, uid6(30000 + k)), TGT6[0]);
    const b2 = await tryJoin6(j, j.wb, j.code);
    CLOCK6 = t1 + 10000;
    await blk6(j.S, up6(j.S, uid6(40000)), TGT6[0]);
    const b3 = await tryJoin6(j, j.wb, j.code);
    CLOCK6 = t1;
    await blk6(j.S, up6(j.S, uid6(40001)), TGT6[0]);
    restore();
    CLOCK6 = t1 + 26000;
    const b4 = await tryJoin6(j, j.wb, j.code);
    CLOCK6 = t1 + 26001;
    const b5 = await tryJoin6(j, j.wb, j.code);
    if (same6([b0, f1, b1, b2, b3, b4, b5], [IN6, OUT6, IN6, IN6, OUT6, OUT6, IN6]))
      ok('(blk-u) the thrown set holds 4096 pairs and 4096 accounts: an account with no room is kept whole and moves nobody else; one account more fails every reader safe until it would have expired');
    else fail('(blk-u) thrown set full: ' + JSON.stringify({ b0, f1, b1, b2, b3, b4, b5 }));
  }
  {
    // (f) Room is made on write, for the set and for one account's share.
    // 4096 pairs at t1, the first of them renewed at t1+10000.
    const set = async (ms) => {
      const j = await joinWorld6(ROWS_T6);
      const restore = failAs6(j.st, E503);
      const t1 = CLOCK6;
      const ws = await fill6(j, 20000);
      CLOCK6 = t1 + 10000;
      await blk6(j.S, ws[0], TGT6[0]);
      CLOCK6 = t1 + ms;
      const g = up6(j.S, uid6(50000));
      await blk6(j.S, g, TGT6[0]);
      restore();
      return tryJoin6(j, g, j.code);
    };
    // 4096 pairs and 4096 accounts kept whole at t1, the first account
    // renewed at t1+10000. At t1+ms 4096 fresh pairs, then one more account.
    const accounts = async (ms) => {
      const j = await joinWorld6(ROWS_T6);
      const restore = failAs6(j.st, E503);
      const t1 = CLOCK6;
      await fill6(j, 20000);
      const whole = [];
      for (let k = 0; k < 4096; k++) { const w = up6(j.S, uid6(30000 + k)); whole.push(w); await blk6(j.S, w, TGT6[0]); }
      CLOCK6 = t1 + 10000;
      await blk6(j.S, whole[0], TGT6[1]);
      CLOCK6 = t1 + ms;
      await fill6(j, 60000);
      await blk6(j.S, up6(j.S, uid6(70000)), TGT6[0]);
      restore();
      return tryJoin6(j, j.wb, j.code);
    };
    const share = async (ms) => {
      const j = await joinWorld6(ROWS_T6);
      const o = outs6(j.S);
      const restore = failAs6(j.st, E503);
      const t1 = CLOCK6;
      for (const t of TGT6.slice(0, 64)) await blk6(j.S, o.e, t);
      CLOCK6 = t1 + ms;
      await blk6(j.S, o.e, TGT6[64]);
      restore();
      return tryJoin6(j, o.e, j.code);
    };
    const r = {
      set16000: await set(16000), set16001: await set(16001), share16000: await share(16000), share16001: await share(16001),
      accounts16000: await accounts(16000), accounts16001: await accounts(16001),
    };
    if (same6(r, { set16000: OUT6, set16001: IN6, share16000: OUT6, share16001: IN6, accounts16000: OUT6, accounts16001: IN6 }))
      ok('(blk-u) expired failures make room as the next is written, for the set, for one account\'s 64 and for the accounts kept whole, and not before their 16 s are up; a renewed one holds no expired one in place');
    else fail('(blk-u) thrown set eviction: ' + JSON.stringify(r));
  }

  // ---- (sg-k ii) a REFUSED join lets nobody in -----------------------------
  // D-BLOCK-5 L. After a failed door, a join that reads the account's
  // blocks and is then refused (a dead code, a full squad, a block with a
  // member, the account already standing there on another device) made no
  // row and vetted none, so it must not mark the socket let in: the next
  // same-account hello reads once and lets the row in, and Start seats it.
  // The first three are an anonymous account's guest socket (GU). already_in
  // needs an account with an identity of its own (B), whose other device
  // stands in the squad on a guest row its own failed door left there
  // (T6-R1-2: the block and already_in refusals come before squads.join).
  {
    const bad = [];
    for (const how of ['dead code', 'full squad', 'blocked', 'already in']) {
      const [acct, guest] = how === 'already in' ? [B, false] : [GU, true];
      const seated = [];
      const st = t6store(ROWS6);
      const S = mkSocial6(st, { seatSquad: (seats) => { seated.push(seats.length); return { ok: true, code: 'RM6G' }; } });
      const wc = up6(S, C);
      const T = await create6(S, wc);
      await S.handle(wc, { type: 'squad', op: 'mode', mode: 'ffa' });
      const wg = t6ws(null);
      await join6(S, wg, T, 'Ghost');
      await S.handle(wg, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
      st.boom.add('blockIdsOf'); hello6(S, wg, acct, guest); await settle6(); st.boom.delete('blockIdsOf');
      let into = '1111', refusal = DEAD6('no');
      if (how === 'full squad') {
        into = await create6(S, up6(S, D));
        for (const id of [A, B, E]) await join6(S, up6(S, id), into, 'Member');
        refusal = { type: 'squad', op: 'join', error: 'full', id: 'no' };
      }
      if (how === 'blocked') {
        into = await create6(S, up6(S, D));
        await st.addBlock(D, GU);
      }
      if (how === 'already in') {
        into = await create6(S, up6(S, D));
        const wy = t6ws(null);
        await join6(S, wy, into, 'Ghost Two');
        st.boom.add('blockIdsOf'); hello6(S, wy, acct, guest); await settle6(); st.boom.delete('blockIdsOf');
        refusal = { type: 'squad', op: 'join', error: 'already_in', id: 'no' };
      }
      await S.handle(wg, { type: 'squad', op: 'join', code: into, name: 'Ghost', skin: 'olive', id: 'no' });
      const no = ans6(wg, 'no');
      st.calls.length = 0;
      hello6(S, wg, acct, guest); await settle6();
      const reads = reads6(st);
      await S.handle(wc, { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
      if (!(same6(no, refusal) && reads === 1 && same6(ans6(wc, 's'), { type: 'squad', op: 'start', ok: true, code: 'RM6G', id: 's' }) && same6(seated, [2])))
        bad.push({ how, no, reads, s: ans6(wc, 's'), seated });
    }
    if (!bad.length) ok('(sg-k) after a failed door, a refused join (a dead code, a full squad, a block, already_in) leaves the door open: the next same-account hello reads once, and Start seats the row');
    else fail('(sg-k) refused join after a failed door: ' + JSON.stringify(bad));
  }

  // ---- (gk-door) a guest row resumed by its secret meets the sign-in door --
  // The secret is a bearer's: whoever presents it takes the row. When the
  // socket presenting it has already said hello as an account, that socket
  // BECOMES the row's occupant as an account without a hello to open the
  // door (E1 with D-BLOCK-2 B), so the resume opens it. A leads with C; a
  // tab with no account joins, its socket goes, and a new socket, signed in
  // as B, presents the secret. Blocked by A: the row goes as a kick. Not
  // blocked: B is let in and the row becomes B's, and no secret is sent on
  // it any more.
  {
    const bad = [];
    for (const blocked of [true, false]) {
      const st = t6store(ROWS6);
      const S = mkSocial6(st);
      const wa = up6(S, A), wc = up6(S, C);
      const code = await create6(S, wa);
      await join6(S, wc, code, 'Crater Two');
      const g = t6ws(null);
      await S.handle(g, { type: 'squad', op: 'join', code, name: 'Tab', skin: 'gold', id: 'j' });
      const gk = (ans6(g, 'j') || {}).gk;
      g.readyState = 3; S.onClose(g);
      if (blocked) await st.addBlock(A, B);
      const wb = up6(S, B);
      clear6(wa, wc, wb);
      st.calls.length = 0;
      await S.handle(wb, { type: 'squad', op: 'resume', code, gk, id: 'r' });
      await settle6();
      const answer = ans6(wb, 'r') || {};
      await S.handle(wc, { type: 'squad', op: 'resume', id: 'c' });
      // The LAST roster this socket was pushed: once B is let in, the row is
      // B's by name, and no secret rides on it.
      const lastState = last6(wb, 'squad', 'state');
      // And the secret is spent: the row is B's (or gone), so a new socket
      // with no account presenting it again is answered gone.
      const w2 = t6ws(null);
      await S.handle(w2, { type: 'squad', op: 'resume', code, gk, id: 'again' });
      const r = {
        read: reads6(st), answer: [answer.op, answer.you, typeof answer.gk], told: got6(wb, 'squad', 'ended'), x: ids6(ans6(wc, 'c')),
        last: blocked ? null : lastState && ['gk' in lastState, lastState.members[2] && lastState.members[2].id],
        again: w2.rx,
      };
      const GONE = [{ type: 'squad', op: 'gone', id: 'again' }];
      const want = blocked
        ? { read: 1, answer: ['state', 2, 'string'], told: [KICKED6], x: [A, C], last: null, again: GONE }
        : { read: 1, answer: ['state', 2, 'string'], told: [], x: [A, C, B], last: [false, B], again: GONE };
      if (!same6(r, want)) bad.push({ blocked, r });
    }
    if (!bad.length) ok('(gk-door) a socket already signed in that resumes a guest row by its secret goes through the sign-in door: a blocked account is removed as a kick, any other is let in and named, and its frames carry no secret after');
    else fail('(gk-door) resume by secret on a signed-in socket: ' + JSON.stringify(bad));
  }

  // ---- (one) ONE SQUAD PER PLAYER, at the sign-in door (E8) ---------------
  // A tab holding a GUEST row in one squad signs in as an account that
  // already has a row in ANOTHER squad. That state used to be left standing
  // (one account in two squads); now the account's existing row wins: the
  // guest row leaves its squad, whose members see a leave, and that socket
  // is told ended:elsewhere. In both orders: the account's row first, and
  // the account's row landing while the door reads.
  {
    const ELSEWHERE = { type: 'squad', op: 'ended', reason: 'elsewhere' };
    const bad = [];
    for (const order of ['account row first', 'account row during the door']) {
      const st = t6store(ROWS6);
      const S = mkSocial6(st);
      const wa = up6(S, A), wc = up6(S, C), wb = up6(S, B);
      const s1 = await create6(S, wa);
      const s2 = await create6(S, wc);
      const g = t6ws(null);
      await join6(S, g, s2, 'Guest');
      let h = null;
      if (order === 'account row first') await join6(S, wb, s1, 'Bee');
      else h = holdAt6(st, 'blockIdsOf', 1);
      clear6(wa, wb, wc, g);
      hello6(S, g, B);
      if (h) {
        const inside = await within6(h.inside);
        await join6(S, wb, s1, 'Bee');        // the account's row lands in S1 while g's door reads
        if (!inside) h.restore();
        h.release();
      }
      await settle6();
      const two = last6(wc, 'squad', 'state');
      await S.handle(wa, { type: 'squad', op: 'resume', id: 'ar' });
      await S.handle(wb, { type: 'squad', op: 'resume', id: 'br' });
      const r = { told: got6(g, 'squad').filter((f) => f.op === 'ended'), s2: ids6(two), s1: ids6(ans6(wa, 'ar')), bHeld: (ans6(wb, 'br') || {}).held };
      await S.handle(g, { type: 'squad', op: 'resume', id: 'gr' });
      r.gResume = (ans6(g, 'gr') || {}).code === s1 ? 's1 (second device)' : ans6(g, 'gr');
      if (!(same6(r.told, [ELSEWHERE]) && same6(r.s2, [C]) && same6(r.s1, [A, B]) && r.bHeld === true && r.gResume === 's1 (second device)'))
        bad.push({ order, r });
    }
    if (!bad.length) ok('(one) a guest row whose socket signs in as an account with a row in another squad leaves its squad, told ended:elsewhere, and the account\'s row stays where it is, in both orders');
    else fail('(one) one squad per player at the sign-in door: ' + JSON.stringify(bad));
  }

  // ---- (cool-u) the cooldown itself, against a clock this block moves ------
  {
    let t = 1000;
    const cd = createCooldown({ ms: 100, max: 3, now: () => t });
    const r = [];
    r.push(cd.take('x'), cd.take('x'));            // true, false
    t = 1099; r.push(cd.take('x'));                // false: one ms inside
    t = 1100; r.push(cd.take('x'));                // true: the window is over, and x is held again to 1200
    r.push(cd.take('y'), cd.take('z'));            // true, true: three held
    const full = cd.size;
    r.push(cd.take('w'));                          // true: the fourth evicts the oldest (x)
    const capped = cd.size;
    r.push(cd.take('x'));                          // true: x was evicted by the cap, so taken afresh (evicting y)
    t = 5000; r.push(cd.take('v'));                // true, and every expired window goes as it is taken
    const swept = cd.size;
    const off = createCooldown({ ms: 0, max: 3, now: () => t });
    const zero = [off.take('x'), off.take('x'), off.size];
    // A CLOCK STEPPED BACK leaves a window behind a later one, where the
    // sweep does not reach it: it must still end on time, not a ms after.
    let u = 1000;
    const back = createCooldown({ ms: 100, max: 8, now: () => u });
    back.take('a');                                // held to 1100
    u = 900; back.take('b');                       // held to 1000, behind a's
    u = 1000; const stepped = back.take('b');      // b's window is over
    if (same(r, [true, false, false, true, true, true, true, true, true]) && full === 3 && capped === 3 && swept === 1 && same(zero, [true, true, 0]) && stepped === true)
      ok('(cool-u) createCooldown: one take per window per key, expired windows evicted on each take, at most `max` held, a window of 0 holds nothing, and a window left behind by a clock stepped back still ends on time');
    else fail('(cool-u) createCooldown: ' + JSON.stringify({ r, full, capped, swept, zero, stepped }));
  }

  // ---- (cool) one real invite push per invitee per 30 s (D-PUSH-1 R) ------
  // An invite needs no match, and a friend who is offline is sent a push, so
  // without a limit any number of friends and sockets could fill a player's
  // notification tray. Inside the window the invite takes the DRY-RUN path:
  // the same read, the same answer, nothing sent. The window is the
  // invitee's, however many people invite them, and it is PRODUCTION'S
  // (SQUAD_INVITE_COOLDOWN_MS unset: 30 s), which this suite otherwise turns
  // off so its twin worlds can invite one friend twice.
  {
    const prevCool = process.env.SQUAD_INVITE_COOLDOWN_MS;
    delete process.env.SQUAD_INVITE_COOLDOWN_MS;
    const st = t6store(ROWS6);
    await st.addFriendship(A, B); await st.addFriendship(A, D); await st.addFriendship(C, B); await st.addFriendship(A, E);
    const S = mkSocial6(st);
    if (prevCool === undefined) delete process.env.SQUAD_INVITE_COOLDOWN_MS; else process.env.SQUAD_INVITE_COOLDOWN_MS = prevCool;
    const wa = up6(S, A), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    const t0 = CLOCK6;
    // Each invite: its answer, and whether the seam SENT ('real') or ran dry.
    const inv = async (w, to, id, at) => {
      CLOCK6 = t0 + at;
      const p = PUSHES.length, d = DRY6.length;
      await S.handle(w, { type: 'squad', op: 'invite', to, id });
      const kind = PUSHES.length > p && DRY6.length === d ? 'real' : DRY6.length > d && PUSHES.length === p ? 'dry' : 'both or neither';
      return { a: ans6(w, id), kind };
    };
    const runs = [
      await inv(wa, B, 'c1', 0),          // real
      await inv(wa, B, 'c2', 1),          // the same inviter again: dry
      await inv(wc, B, 'c3', 2),          // ANOTHER inviter, the same invitee: dry
      await inv(wa, D, 'c4', 3),          // another invitee: real
      await inv(wa, B, 'c5', 29999),      // still inside B's window: dry
      await inv(wa, B, 'c6', 30000),      // the window is over: real
    ];
    // A DROPPED invite sends nothing and takes no window: E has blocked C (a
    // member), so the invite to E is dropped, and a real one right after it,
    // once the block is gone, still sends.
    await st.addBlock(E, C);
    runs.push(await inv(wa, E, 'c7', 30001));   // dropped: dry
    await st.removeBlock(E, C);
    runs.push(await inv(wa, E, 'c8', 30002));   // real
    CLOCK6 = t0;
    const kinds = runs.map((x) => x.kind);
    const same = runs.every((x, i) => same6(x.a, { type: 'squad', op: 'invite', ok: true, delivered: 'push', id: 'c' + (i + 1) }));
    if (same6(kinds, ['real', 'dry', 'dry', 'real', 'dry', 'real', 'dry', 'real']) && same)
      ok('(cool) one real invite push per invitee per 30 s, whoever invites: the rest take the dry run and are answered alike, and a dropped invite takes no window');
    else fail('(cool) invite push cooldown: ' + JSON.stringify(runs));
  }

  // ===== THE INVITE BY CALLSIGN (owner, 2026-10-07) ========================
  // "You should also have the ability to add someone to the squad without
  // needing to add them as a friend." His answer: by exact callsign, and by
  // the squad code or link; blocked players cannot be found or invited. A
  // squad invite frame that carries `callsign` finds its invitee by friend
  // search's exact-callsign lookup and needs no friend; every other rule is
  // the friend invite's, except delivery to a player who is NOT a friend
  // (round 2): in-app only, never a push, and one answer, 'sent', whatever
  // happened ((inv-cs i)); a friend found by name is a friend's invite
  // ((inv-cs j)). Every miss -- nobody by that name, your own name, a
  // block either way, a guest -- is ONE answer, no_such_user, after the SAME
  // store reads, so the frame says nothing about who has blocked whom.
  const byName6 = (callsign, id) => ({ type: 'squad', op: 'invite', callsign, id });
  // A world where A leads a squad with nobody in it and is friends with NOBODY:
  // every invite below is to a stranger.
  const csWorld6 = async (rows = ROWS6) => {
    const st = t6store(rows);
    const S = mkSocial6(st);
    const wa = up6(S, A);
    const code = await create6(S, wa);
    clear6(wa); PUSHES.length = 0; DRY6.length = 0; st.calls.length = 0;
    return { st, S, wa, code };
  };

  // ---- (inv-cs a) a stranger who is online gets the invite, found by name ---
  // CHANGED (round 2, 2026-10-08): a player who is not a friend is answered
  // delivered:'sent' (was 'online'), the one answer a stranger's invite gets
  // whether anyone was there or not; the frame they are sent names the
  // inviter's account (`from.id`, for the card's Report and Block); and the
  // first leg reads the inviter's friends too (five reads, was four).
  {
    const { st, S, wa, code } = await csWorld6();
    const wb1 = up6(S, B), wb2 = up6(S, B);
    clear6(wb1, wb2); st.calls.length = 0;
    await S.handle(wa, byName6('  bunker   NINE ', 'n1'));
    const r = ans6(wa, 'n1'), inv = invited6(wb1);
    if (same6(r, { type: 'squad', op: 'invite', ok: true, delivered: 'sent', callsign: 'Bunker Nine', id: 'n1' }))
      ok('(inv-cs a) an invite by callsign reaches a player who is NOT a friend: delivered:sent, and the answer names them by their proved name');
    else fail('(inv-cs a) by-callsign reply: ' + JSON.stringify(r));
    if (inv.length === 1 && same6(inv[0], { type: 'squad', op: 'invited', code, from: { callsign: 'Anvil Six', id: A }, size: 1, max: 4 }) && same6(invited6(wb2), inv))
      ok('(inv-cs a) the invited frame is the friend invite\'s plus the inviter\'s account id, down every socket the player holds');
    else fail('(inv-cs a) invited frame: ' + JSON.stringify([wb1.rx, wb2.rx]));
    if (same6(st.calls.slice().sort(), ['blockIdsOf', 'blockIdsOf', 'friendIdsOf', 'profileByCallsignKey', 'profileById']) && st.friends.size === 0 && PUSHES.length === 0 && DRY6.length === 0)
      ok('(inv-cs a) the lookup, both players\' blocks, the inviter\'s own row and friends: five reads, no friendship made, and the push seam is never asked');
    else fail('(inv-cs a) reads ' + JSON.stringify(st.calls) + ' friends ' + st.friends.size + ' pushes ' + JSON.stringify([PUSHES, DRY6]));
    // The same name typed the way friend search takes it finds the same player.
    clear6(wa);
    await S.handle(wa, { type: 'friend', op: 'search', q: '  bunker   NINE ', id: 's1' });
    const s = ans6(wa, 's1');
    if (s && Array.isArray(s.results) && s.results.length === 1 && s.results[0].id === B)
      ok('(inv-cs a) and friend search finds that player by the same spelling: one lookup for both');
    else fail('(inv-cs a) search: ' + JSON.stringify(s));
  }

  // ---- (inv-cs b) a stranger who is offline: NO PUSH, and the same answer ---
  // CHANGED (round 2, 2026-10-08): this pinned a real push to an offline
  // stranger and the cooldown's dry run after it. Every consent text says a
  // push carries squad invites FROM FRIENDS, so a stranger's invite never
  // reaches the push seam in either form, and the inviter is answered 'sent'
  // exactly as for a stranger who is online.
  {
    const prevCool = process.env.SQUAD_INVITE_COOLDOWN_MS;
    delete process.env.SQUAD_INVITE_COOLDOWN_MS;
    const st = t6store(ROWS6);
    const S = mkSocial6(st);
    if (prevCool === undefined) delete process.env.SQUAD_INVITE_COOLDOWN_MS; else process.env.SQUAD_INVITE_COOLDOWN_MS = prevCool;
    const wa = up6(S, A);
    const code = await create6(S, wa);
    PUSHES.length = 0; DRY6.length = 0; pushAnswer = true;
    const t0 = CLOCK6;
    await S.handle(wa, byName6('Bunker Nine', 'p1'));
    const one = { a: ans6(wa, 'p1'), pushes: PUSHES.length, dry: DRY6.length };
    CLOCK6 = t0 + 1000;
    await S.handle(wa, byName6('Bunker Nine', 'p2'));
    const two = { a: ans6(wa, 'p2'), pushes: PUSHES.length, dry: DRY6.length };
    CLOCK6 = t0;
    if (same6(one.a, { type: 'squad', op: 'invite', ok: true, delivered: 'sent', callsign: 'Bunker Nine', id: 'p1' }) && one.pushes === 0 && one.dry === 0 && !!code)
      ok('(inv-cs b) an offline stranger with a device to notify is sent NO push and no dry run, and the inviter is answered delivered:sent');
    else fail('(inv-cs b) push: ' + JSON.stringify({ one, PUSHES, DRY6 }));
    if (same6(two.a, { type: 'squad', op: 'invite', ok: true, delivered: 'sent', callsign: 'Bunker Nine', id: 'p2' }) && two.pushes === 0 && two.dry === 0)
      ok('(inv-cs b) and a second invite inside 30 s is the same: nothing reaches the seam however often a stranger asks');
    else fail('(inv-cs b) second: ' + JSON.stringify(two));
  }

  // ---- (inv-cs c) EVERY MISS IS ONE ANSWER, AFTER THE SAME READS ------------
  // Nobody by that name; the inviter's own name; B blocked by A; A blocked by
  // B; a guest's account (GU: an anonymous account has no callsign_key, so no
  // lookup finds it); an account with no provable name (NN). Each answers
  // no_such_user, reaches nobody, sends no push and runs no dry run -- and
  // costs the same three reads in the same leg, so a block cannot be told
  // from a miss by what it costs. A callsign of the wrong shape is a miss
  // before the store.
  {
    const MISS = (id) => ({ type: 'squad', op: 'invite', error: 'no_such_user', id });
    const cases = [
      ['nobody by that name', 'Granite Owl', null],
      ['the inviter\'s own name', 'Anvil Six', null],
      ['B, blocked by the inviter', 'Bunker Nine', (st) => st.addBlock(A, B)],
      ['B, who blocked the inviter', 'Bunker Nine', (st) => st.addBlock(B, A)],
      ['a guest\'s account', 'Ghost', null],
      ['an account with no provable name', 'FOLLOW ME OK', null],
    ];
    const bad = [], reads = [];
    for (const [what, name, arrange] of cases) {
      const { st, S, wa } = await csWorld6();
      if (arrange) await arrange(st);
      const wb = up6(S, B), wg = up6(S, GU, true), wn = up6(S, NN);
      clear6(wa, wb, wg, wn); PUSHES.length = 0; DRY6.length = 0; st.calls.length = 0;
      await S.handle(wa, byName6(name, 'm'));
      reads.push(st.calls.slice());
      if (!(same6(wa.rx, [MISS('m')]) && !invited6(wb).length && !invited6(wg).length && !invited6(wn).length && !PUSHES.length && !DRY6.length))
        bad.push({ what, a: wa.rx, PUSHES: [...PUSHES], DRY6: [...DRY6] });
    }
    if (!bad.length) ok('(inv-cs c) nobody by that name, your own name, a block either way, a guest and a nameless account all answer no_such_user and reach nobody');
    else fail('(inv-cs c) misses: ' + JSON.stringify(bad));
    // CHANGED (round 2): four reads, the inviter's friends added to the leg
    // so a friend and a stranger can be told apart; still the same four for
    // every miss.
    const sorted = reads.map((r) => r.slice().sort());
    if (sorted.every((r) => same6(r, ['blockIdsOf', 'friendIdsOf', 'profileByCallsignKey', 'profileById'])))
      ok('(inv-cs c) and every one of them costs exactly the same four reads -- a block is a miss to the store as well as on the wire');
    else fail('(inv-cs c) reads per miss: ' + JSON.stringify(reads));
    // ONE LEG: the three reads are asked together, so a miss and a block take
    // the same number of round trips. A held lookup holds all three.
    const legs = [];
    for (const arrange of [null, (st) => st.addBlock(B, A)]) {
      const { st, S, wa } = await csWorld6();
      if (arrange) await arrange(st);
      st.calls.length = 0;
      const g = st.hold('profileByCallsignKey');
      const pending = S.handle(wa, byName6(arrange ? 'Bunker Nine' : 'Granite Owl', 'l'));
      const inside = await within6(g.inside);
      await settle6();
      legs.push({ inside, asked: st.calls.slice().sort(), answered: !!ans6(wa, 'l') });
      g.release(); await pending;
    }
    if (legs.every((l) => l.inside && !l.answered && same6(l.asked, ['blockIdsOf', 'friendIdsOf', 'profileByCallsignKey', 'profileById'])))
      ok('(inv-cs c) a miss and a block ask their four reads in one leg: with the lookup held, all four are out and nothing is answered');
    else fail('(inv-cs c) legs: ' + JSON.stringify(legs));
    const shape = [];
    for (const name of ['', 'ab', 'x'.repeat(40), '   ']) {
      const { st, S, wa } = await csWorld6();
      await S.handle(wa, byName6(name, 'z'));
      if (!(same6(wa.rx, [MISS('z')]) && st.calls.length === 0)) shape.push({ name, a: wa.rx, calls: st.calls });
    }
    if (!shape.length) ok('(inv-cs c) a callsign no stored name could match is the same miss, answered before the store');
    else fail('(inv-cs c) shape misses: ' + JSON.stringify(shape));
  }

  // ---- (inv-cs d) the friend invite still needs a friend ---------------------
  // The relaxation is the callsign's alone: a `to` invite to a stranger is
  // refused exactly as before, and a frame that carries both is the callsign's
  // and finds whoever that name finds, never the uuid beside it.
  {
    const { S, wa } = await csWorld6();
    const wb = up6(S, B), wc = up6(S, C);
    clear6(wb, wc);
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, id: 'f1' });
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, callsign: 'Granite Owl', id: 'f2' });
    await S.handle(wa, { type: 'squad', op: 'invite', to: B, callsign: 'Crater Two', id: 'f3' });
    if (same6(ans6(wa, 'f1'), { type: 'squad', op: 'invite', error: 'not_friend', id: 'f1' })
        && same6(ans6(wa, 'f2'), { type: 'squad', op: 'invite', error: 'no_such_user', id: 'f2' })
        && same6(ans6(wa, 'f3'), { type: 'squad', op: 'invite', ok: true, delivered: 'sent', callsign: 'Crater Two', id: 'f3' })
        && !invited6(wb).length && invited6(wc).length === 1)
      ok('(inv-cs d) only an invite BY CALLSIGN skips the friend check: a `to` invite to a stranger is still not_friend, and `to` beside a callsign is ignored');
    else fail('(inv-cs d) friend path: ' + JSON.stringify({ a: wa.rx, b: wb.rx, c: invited6(wc) }));
  }

  // ---- (inv-cs e) a block between the invitee and ANOTHER member -----------
  // D-BLOCK 4, as the friend invite has it: the invite is dropped silently,
  // the inviter is answered exactly what a delivered invite is answered, and
  // a delivered and a dropped invite make the same reads.
  {
    const runs = [];
    for (const kind of ['delivered', 'dropped']) {
      const { st, S, wa, code } = await csWorld6();
      const wc = up6(S, C);
      await join6(S, wc, code, 'Crater Two');
      if (kind === 'dropped') await st.addBlock(C, B);
      const wb = up6(S, B);
      clear6(wa, wb, wc); st.calls.length = 0;
      await S.handle(wa, byName6('Bunker Nine', 'd'));
      runs.push({ kind, a: wa.rx, b: invited6(wb).length, c: wc.rx.length, reads: st.calls.slice().sort() });
    }
    // CHANGED (round 2): 'sent', the stranger's one answer, and five reads.
    const want = [{ type: 'squad', op: 'invite', ok: true, delivered: 'sent', callsign: 'Bunker Nine', id: 'd' }];
    if (same6(runs[0].a, want) && same6(runs[1].a, want) && runs[0].b === 1 && runs[1].b === 0 && runs[1].c === 0
        && runs[0].reads.length === 5 && same6(runs[0].reads, runs[1].reads))
      ok('(inv-cs e) a block between the invitee and another member drops the invite silently: the same answer and the same five reads as a delivered one');
    else fail('(inv-cs e) dropped by callsign: ' + JSON.stringify(runs));
  }

  // ---- (inv-cs f) a block that lands while the invite's reads are out ------
  // The recent-blocks log, from a seq taken before the FIRST read: C, a
  // member, blocks B after B's own block read has answered and before it
  // lands. Nothing reaches B, and A gets the ordinary answer.
  {
    const { st, S, wa, code } = await csWorld6();
    const wc = up6(S, C), wb = up6(S, B);
    await join6(S, wc, code, 'Crater Two');
    clear6(wa, wb, wc);
    const h = staleFor6(st, 'blockIdsOf', B);
    const pending = S.handle(wa, byName6('Bunker Nine', 'g'));
    const inside = await within6(h.inside);
    if (inside) await S.handle(wc, { type: 'block', op: 'add', id: B }); else h.restore();
    h.release(); await pending;
    if (inside && st.blocks.has(C + '>' + B) && same6(ans6(wa, 'g'), { type: 'squad', op: 'invite', ok: true, delivered: 'sent', callsign: 'Bunker Nine', id: 'g' }) && !invited6(wb).length)
      ok('(inv-cs f) a block landing while the invitee\'s read is out is added from the log: nothing reaches the player just blocked');
    else fail('(inv-cs f) block during the read: ' + JSON.stringify({ inside, a: ans6(wa, 'g'), b: invited6(wb) }));
  }

  // ---- (inv-cs g) memory's refusals, the identity, and the sign-in gate -----
  {
    // No squad, a full one: refused before the store. Already in it: refused.
    const st0 = t6store(ROWS6);
    const S0 = mkSocial6(st0);
    const w0 = up6(S0, A);
    st0.calls.length = 0;
    await S0.handle(w0, byName6('Bunker Nine', 'n'));
    const noSquad = same6(ans6(w0, 'n'), { type: 'squad', op: 'invite', error: 'no_squad', id: 'n' }) && st0.calls.length === 0;
    const { st, S, wa, code } = await csWorld6();
    const wb = up6(S, B), wc = up6(S, C), wd = up6(S, D);
    await join6(S, wb, code, 'Bunker Nine');
    clear6(wa); st.calls.length = 0;
    await S.handle(wa, byName6('Bunker Nine', 'a'));
    const already = same6(ans6(wa, 'a'), { type: 'squad', op: 'invite', error: 'already', id: 'a' });
    await join6(S, wc, code, 'Crater Two'); await join6(S, wd, code, 'Dune Four');
    up6(S, E); clear6(wa); st.calls.length = 0;
    await S.handle(wa, byName6('Echo Seven', 'f'));
    const full = same6(ans6(wa, 'f'), { type: 'squad', op: 'invite', error: 'full', id: 'f' }) && st.calls.length === 0;
    if (noSquad && already && full) ok('(inv-cs g) no squad and a full squad are refused before the store; a player already in the squad is already');
    else fail('(inv-cs g) refusals: ' + JSON.stringify({ noSquad, already, full, w0: w0.rx, wa: wa.rx }));
    // The socket signs out while the lookup is out: nothing is answered and
    // nothing is sent, as on the friend path.
    const w2 = await csWorld6();
    const wb2 = up6(w2.S, B);
    clear6(wb2);
    const g = w2.st.hold('profileByCallsignKey');
    const pending = w2.S.handle(w2.wa, byName6('Bunker Nine', 'i'));
    const inside = await within6(g.inside);
    hello6(w2.S, w2.wa, GU, true);
    g.release(); await pending; await settle6();
    if (inside && !ans6(w2.wa, 'i') && !invited6(wb2).length && !PUSHES.length)
      ok('(inv-cs g) a socket that becomes somebody else while the lookup is out is answered nothing and invites nobody');
    else fail('(inv-cs g) identity: ' + JSON.stringify({ inside, a: w2.wa.rx, b: wb2.rx }));
    // A guest cannot invite by callsign either: the squad's sign-in gate.
    const st3 = t6store(ROWS6);
    const S3 = mkSocial6(st3);
    const wg = up6(S3, GU, true), wb3 = up6(S3, B);
    clear6(wg, wb3); st3.calls.length = 0;
    await S3.handle(wg, byName6('Bunker Nine', 'q'));
    if (same6(wg.rx, [{ type: 'social', error: 'sign_in', id: 'q' }]) && !invited6(wb3).length && st3.calls.length === 0)
      ok('(inv-cs g) a guest\'s invite by callsign is refused at the sign-in gate, before the store');
    else fail('(inv-cs g) guest inviter: ' + JSON.stringify(wg.rx));
  }

  // ---- (inv-cs h) rate-limited like friend search: the friend bucket --------
  {
    const { st, S, wa } = await csWorld6();
    const wb = up6(S, B);
    for (let i = 0; i < 10; i++) await S.handle(wa, byName6('Granite Owl'));
    clear6(wa, wb); st.calls.length = 0;
    await S.handle(wa, byName6('Bunker Nine', 'r1'));
    const spent = same6(ans6(wa, 'r1'), { type: 'squad', op: 'invite', error: 'slow_down', id: 'r1' }) && st.calls.length === 0 && !invited6(wb).length;
    CLOCK6 += 60000;
    await S.handle(wa, byName6('Bunker Nine', 'r2'));
    const back = (ans6(wa, 'r2') || {}).delivered === 'sent';
    // And it is the SAME bucket as search: ten searches leave no invite.
    const w2 = await csWorld6();
    for (let i = 0; i < 10; i++) await w2.S.handle(w2.wa, { type: 'friend', op: 'search', q: 'Granite Owl' });
    w2.st.calls.length = 0;
    await w2.S.handle(w2.wa, byName6('Bunker Nine', 'r3'));
    const shared = same6(ans6(w2.wa, 'r3'), { type: 'squad', op: 'invite', error: 'slow_down', id: 'r3' }) && w2.st.calls.length === 0;
    if (spent && back && shared)
      ok('(inv-cs h) ten invites by callsign a minute, from the friend bucket search spends: the eleventh is slow_down with no read, and a minute refills it');
    else fail('(inv-cs h) rate: ' + JSON.stringify({ spent, back, shared, a: wa.rx, a2: w2.wa.rx }));
  }

  // ---- (inv-cs i) A STRANGER'S INVITE HAS ONE ANSWER (round 2, 2026-10-08) -
  // The reply to an invite to a player who is not a friend must not say
  // whether they are online, whether they have a device to notify, or whether
  // a block dropped the invite: privacy.html says only friends, and the players
  // in a squad with them, can see whether a player is online, and that a
  // stranger's invite never says it. Five worlds, one reply, byte for byte;
  // none of them asks the push seam; and a seam that would never answer holds
  // none of them up, because a stranger's invite never waits on it.
  {
    const run = async (kind) => {
      const st = t6store(ROWS6);
      const S = mkSocial6(st, { pushInvite: async (to, payload, opts) => { (opts && opts.dryRun === true ? DRY6 : PUSHES).push([to, payload]); return kind === 'offline-nudges'; } });
      const wa = up6(S, A);
      const code = await create6(S, wa);
      const wc = up6(S, C);
      await join6(S, wc, code, 'Crater Two');
      if (kind.startsWith('dropped')) await st.addBlock(C, B);
      const wb = kind === 'online' || kind === 'dropped-online' ? up6(S, B) : null;
      clear6(wa); PUSHES.length = 0; DRY6.length = 0;
      await S.handle(wa, byName6('Bunker Nine', 'x'));
      return { kind, a: wa.rx.filter((f) => f.type === 'squad' && f.op === 'invite'), got: wb ? invited6(wb).length : 0, seam: PUSHES.length + DRY6.length };
    };
    const runs = [];
    for (const kind of ['online', 'offline-nudges', 'offline-none', 'dropped-online', 'dropped-offline']) runs.push(await run(kind));
    const want = [{ type: 'squad', op: 'invite', ok: true, delivered: 'sent', callsign: 'Bunker Nine', id: 'x' }];
    if (runs.every((r) => same6(r.a, want) && r.seam === 0) && runs[0].got === 1 && runs[3].got === 0)
      ok("(inv-cs i) online, offline with nudges, offline without, and dropped online or offline all answer the inviter the same delivered:'sent', and none of them asks the push seam");
    else fail('(inv-cs i) one answer: ' + JSON.stringify(runs));
    // A SEAM THAT NEVER SETTLES: the stranger's answer does not wait on it,
    // where a friend's offline invite would wait out INVITE_PUSH_MS.
    const st = t6store(ROWS6);
    let asked = 0;
    const S = mkSocial6(st, { pushInvite: () => { asked++; return new Promise(() => {}); } });
    const wa = up6(S, A);
    await create6(S, wa);
    clear6(wa);
    const pending = S.handle(wa, byName6('Bunker Nine', 'y'));
    const done = await within6(pending);
    if (done && asked === 0 && same6(ans6(wa, 'y'), { type: 'squad', op: 'invite', ok: true, delivered: 'sent', callsign: 'Bunker Nine', id: 'y' }))
      ok("(inv-cs i) and with a push seam that never answers, the stranger's invite is answered at once: it never waits on a device read");
    else fail('(inv-cs i) seam wait: ' + JSON.stringify({ done, asked, a: wa.rx }));
  }

  // ---- (inv-cs j) A FRIEND FOUND BY CALLSIGN IS INVITED AS A FRIEND --------
  // The invite by callsign is the only path that may find a stranger, but a
  // name can find a friend too, and a friend's invite keeps everything it had:
  // the push to an offline friend (their consent covers it), the cooldown, and
  // 'online' | 'push' | 'none'. The frame carries no account id: the friend's
  // card needs no menu of its own.
  {
    const runs = {};
    for (const kind of ['online', 'push', 'none']) {
      const st = t6store(ROWS6);
      await st.addFriendship(A, B);
      const S = mkSocial6(st, { pushInvite: async (to, payload, opts) => { (opts && opts.dryRun === true ? DRY6 : PUSHES).push([to, payload]); return kind === 'push'; } });
      const wa = up6(S, A);
      const code = await create6(S, wa);
      const wb = kind === 'online' ? up6(S, B) : null;
      clear6(wa); PUSHES.length = 0; DRY6.length = 0;
      await S.handle(wa, byName6('bunker nine', 'f'));
      runs[kind] = { a: ans6(wa, 'f'), frame: wb ? invited6(wb) : null, pushes: PUSHES.map((p) => p.slice()), dry: DRY6.length, code };
    }
    const reply = (d) => ({ type: 'squad', op: 'invite', ok: true, delivered: d, callsign: 'Bunker Nine', id: 'f' });
    if (same6(runs.online.a, reply('online')) && same6(runs.online.frame, [{ type: 'squad', op: 'invited', code: runs.online.code, from: { callsign: 'Anvil Six' }, size: 1, max: 4 }])
        && same6(runs.push.a, reply('push')) && runs.push.pushes.length === 1 && runs.push.pushes[0][0] === B && same6(runs.push.pushes[0][1], { code: runs.push.code, from: 'Anvil Six', size: 1, max: 4 })
        && same6(runs.none.a, reply('none')) && runs.none.pushes.length === 1 && runs.none.dry === 0)
      ok("(inv-cs j) a FRIEND found by callsign is invited as a friend: 'online' with the friend frame (no account id), 'push' with a real push to an offline friend, 'none' when no device took it");
    else fail('(inv-cs j) friend by callsign: ' + JSON.stringify(runs));
  }

  // ---- (gn) A GUEST'S SQUAD SEAT SHOWS THE GUEST'S NAME (round 2) ----------
  // A guest's seat read 'No callsign' although the same guest is named in
  // every lobby. With the name index wired (as server.js wires it), a guest
  // row carries what the engine's door would show for the name its join
  // carried: a rolled pair, or a typed name the guidelines pass and no account
  // holds, normalised. A held name, a computer's name and a typed name while
  // the index knows nothing are null. A key taken after the guest joined comes
  // off at the next snapshot. And a guest row whose socket has SIGNED IN stays
  // nameless while the sign-in door reads (D-BLOCK-3 F), then shows the
  // account's proved name.
  {
    const { createNameIndex } = await import('../server/name-index.js');
    const index = createNameIndex({ load: async (after) => (after === null ? ['viper'] : []) });
    await index.refresh();
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { names: index });
    const wa = up6(S, A);
    const code = await create6(S, wa);
    // CHANGED (round 2 fix): the guests are on ANONYMOUS accounts, as a guest
    // who has saved anything is. A guest with no account at all has no report
    // path, so its row shows no name; (gr) pins that.
    const g1 = t6ws(uid6(31), true), g2 = t6ws(uid6(32), true), g3 = t6ws(GU, true);
    await join6(S, g1, code, 'Iron Ridge');
    await join6(S, g2, code, '  Tank   Ace ');
    await join6(S, g3, code, 'VIPER');
    const seen = (last6(wa, 'squad', 'state') || { members: [] }).members.map((m) => [m.callsign, m.guest]);
    const own = last6(g2, 'squad', 'state') || { members: [] };
    if (same6(seen, [['Anvil Six', false], ['Iron Ridge', true], ['Tank Ace', true], [null, true]])
        && own.you === 2 && own.members[2] && own.members[2].callsign === 'Tank Ace')
      ok("(gn) a guest row shows a rolled pair and a typed name, normalised, to every member and to the guest's own seat; a name an account holds is null");
    else fail('(gn) guest names: ' + JSON.stringify({ seen, own: own.members && own.members[own.you] }));
    // A key taken after the guest joined: the next snapshot drops the name.
    index.add('tank ace');
    clear6(wa);
    await S.handle(wa, { type: 'squad', op: 'resume', id: 'r1' });
    const after = (ans6(wa, 'r1') || { members: [] }).members.map((m) => m.callsign);
    if (same6(after, ['Anvil Six', 'Iron Ridge', null, null]))
      ok('(gn) a typed name an account takes after the guest joined is gone from the next snapshot');
    else fail('(gn) after the key was taken: ' + JSON.stringify(after));
    // A computer's name, and an index that has not loaded.
    const st2 = t6store(ROWS6);
    const S2 = mkSocial6(st2, { names: createNameIndex({ load: async () => [] }) });
    const wa2 = up6(S2, A);
    const code2 = await create6(S2, wa2);
    await join6(S2, t6ws(uid6(33), true), code2, 'CPU 2');
    await join6(S2, t6ws(uid6(34), true), code2, 'Tank Ace');
    await join6(S2, t6ws(uid6(35), true), code2, 'Iron Ridge');
    const unloaded = (last6(wa2, 'squad', 'state') || { members: [] }).members.map((m) => m.callsign);
    if (same6(unloaded, ['Anvil Six', null, null, 'Iron Ridge']))
      ok("(gn) a computer's name is null, and while the index knows nothing a typed name is null too (a rolled pair needs no index)");
    else fail('(gn) system and unloaded: ' + JSON.stringify(unloaded));
    // THE SIGN-IN DOOR'S ROW STAYS NAMELESS, typed guest name and all.
    const st3 = t6store(ROWS6);
    const S3 = mkSocial6(st3, { names: index });
    const wa3 = up6(S3, A);
    const code3 = await create6(S3, wa3);
    // An ANONYMOUS guest (round 2 fix): a guest with no account shows no name.
    const wn = t6ws(uid6(36), true);
    await join6(S3, wn, code3, 'Kestrel Bay');
    const before = ((last6(wa3, 'squad', 'state') || { members: [] }).members[1] || {}).callsign;
    const h = stale6(st3, 'blockIdsOf');
    hello6(S3, wn, B);
    const inside = await within6(h.inside);
    let during = null;
    if (inside) { clear6(wa3); await S3.handle(wa3, { type: 'squad', op: 'resume', id: 'r2' }); during = (ans6(wa3, 'r2') || { members: [] }).members[1] || null; }
    else h.restore();
    h.release();
    await settle6();
    const done = ((last6(wa3, 'squad', 'state') || { members: [] }).members[1] || {});
    if (before === 'Kestrel Bay' && inside && during && during.guest === true && during.callsign === null && done.id === B && done.callsign === 'Bunker Nine')
      ok("(gn) a guest row whose socket signs in shows no name at all while the door reads, not even the guest's own, and the account's proved name once admitted");
    else fail('(gn) the door\'s row: ' + JSON.stringify({ before, inside, during, done }));
  }

  // ---- (gr) A GUEST ROW'S NAME HAS A REPORT PATH (round 2 fix) -------------
  // A guest row showing the guest's typed name had no Report and no Block:
  // its `id` is null by the frame's own rule. Now a report and a block may
  // name a guest row by its row handle (`rid`, never an account id), resolved
  // in the caller's own squad to the anonymous account the guest's socket is
  // signed in as, and the report records the name the row showed. A guest
  // with no account at all has nothing a report or a block could be filed
  // against, so its row shows no name. A dropped guest row keeps both its name
  // and its report path through the drop window.
  {
    const { createNameIndex } = await import('../server/name-index.js');
    const index = createNameIndex({ load: async () => [] });
    await index.refresh();
    const GA = uid6(21), GB = uid6(22);
    const st = t6store([...ROWS6,
      { id: GA, callsign: 'Ghost A', friend_code: 'GAA234', callsign_key: null, callsign_set_at: null },
      { id: GB, callsign: 'Ghost B', friend_code: 'GBB234', callsign_key: null, callsign_set_at: null }]);
    const reports = [];
    st.reportedSince = async () => { await st._hit('reportedSince'); return false; };
    st.addReport = async (by, who, name) => { await st._hit('addReport'); reports.push([by, who, name]); };
    const S = mkSocial6(st, { names: index });
    const wa = up6(S, A), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    const ga = t6ws(GA, true), gn = t6ws(null);
    await join6(S, ga, code, 'Tank Ace');
    await join6(S, gn, code, 'Wren Hollow');
    const snap = last6(wc, 'squad', 'state') || { members: [] };
    const rows = snap.members.map((m) => [m.callsign, m.guest]);
    const ownN = last6(gn, 'squad', 'state') || { members: [] };
    const noIds = !UUID6.test(JSON.stringify(snap.members.slice(2))) && snap.members.slice(2).every((m) => m.id === null);
    if (same6(rows, [['Anvil Six', false], ['Crater Two', false], ['Tank Ace', true], [null, true]])
        && ownN.members[ownN.you] && ownN.members[ownN.you].callsign === null && noIds)
      ok('(gr) a guest row on an anonymous account shows its name; a guest with no account at all shows none, on every screen and its own; no guest row carries an account id');
    else fail('(gr) rows: ' + JSON.stringify({ rows, own: ownN.members && ownN.members[ownN.you], noIds }));
    const ridA = snap.members[2] && snap.members[2].rid, ridN = snap.members[3] && snap.members[3].rid, ridC = snap.members[1] && snap.members[1].rid;
    // REPORT BY ROW HANDLE: the anonymous account, and the name the row showed.
    clear6(wc);
    await S.handle(wc, { type: 'report', rid: ridA, id: 'p1' });
    const p1 = ans6(wc, 'p1');
    // The guest with no account, a signed-in member's row, and a handle from
    // another squad are nobody: no_such_user, and nothing is filed.
    await S.handle(wc, { type: 'report', rid: ridN, id: 'p2' });
    await S.handle(wc, { type: 'report', rid: ridC, id: 'p3' });
    const wx = up6(S, E);
    const code2 = await create6(S, wx);
    await S.handle(wx, { type: 'report', rid: ridA, id: 'p4' });
    await S.handle(ga, { type: 'report', rid: ridA, id: 'p5' });
    const misses = [ans6(wc, 'p2'), ans6(wc, 'p3'), ans6(wx, 'p4'), ans6(ga, 'p5')].map((f) => f && f.error);
    if (same6(p1, { type: 'report', ok: true, id: 'p1' }) && same6(reports, [[C, GA, 'Tank Ace']]) && code2
        && same6(misses, ['no_such_user', 'no_such_user', 'no_such_user', 'self']))
      ok("(gr) a member reports a guest row by its handle: the guest's anonymous account and the name the row showed are filed; a guest with no account, a member's row by handle, a handle from another squad and the guest's own row are refused");
    else fail('(gr) report by rid: ' + JSON.stringify({ p1, reports, misses }));
    // A DROPPED guest row keeps its name and its report path.
    ga.readyState = 3;
    S.onClose(ga);
    await settle6();
    const dropped = ((last6(wa, 'squad', 'state') || { members: [] }).members[2]) || {};
    st.reportedSince = async () => false;
    reports.length = 0;
    await S.handle(wa, { type: 'report', rid: ridA, id: 'p6' });
    if (dropped.dropped === true && dropped.callsign === 'Tank Ace' && same6(ans6(wa, 'p6'), { type: 'report', ok: true, id: 'p6' }) && same6(reports, [[A, GA, 'Tank Ace']]))
      ok('(gr) a dropped guest row keeps its name and can still be reported by its handle through the drop window');
    else fail('(gr) dropped row: ' + JSON.stringify({ dropped, p6: ans6(wa, 'p6'), reports }));
    // BLOCK BY ROW HANDLE: the block lands on the anonymous account, and the
    // pair is parted as for any member (R16): the blocker leads, so the guest goes.
    const S2 = mkSocial6(st, { names: index });
    const wa2 = up6(S2, A);
    const code3 = await create6(S2, wa2);
    const gb = t6ws(GB, true);
    await join6(S2, gb, code3, 'Night Owl');
    const ridB = ((last6(wa2, 'squad', 'state') || { members: [] }).members[1] || {}).rid;
    await S2.handle(wa2, { type: 'block', op: 'add', rid: ridB, id: 'b1' });
    await settle6();
    const after = (last6(wa2, 'squad', 'state') || { members: [] }).members.map((m) => m.callsign);
    if (same6(ans6(wa2, 'b1'), { type: 'block', op: 'add', ok: true, id: 'b1' }) && st.blocks.has(A + '>' + GB) && same6(after, ['Anvil Six'])
        && same6(last6(gb, 'squad', 'ended'), { type: 'squad', op: 'ended', reason: 'kicked' }))
      ok("(gr) a block by a guest row's handle lands on the guest's anonymous account and parts them from the leader's squad, as a block of any member does");
    else fail('(gr) block by rid: ' + JSON.stringify({ b1: ans6(wa2, 'b1'), blocks: [...st.blocks], after, ended: last6(gb, 'squad', 'ended') }));
  }


  // ---- (err) THE SQUAD REFUSALS ARE A CLOSED, NAMED SET (E9) ---------------
  // Every error a squad reply can carry, by op, is one list the client maps
  // to its words (squad.<op>.<code>). This pins it: a code added or renamed
  // is a change the client must be told of, not something that leaks out of
  // the state machine or the seating by accident. Anything a handler hands
  // over that is NOT on its op's list is sent as 'unavailable' — here a
  // seating that answers a word the list does not know, to the leader and to
  // every member it fans out to.
  {
    const WANT = {
      create: ['slow_down', 'unavailable'],
      join: ['slow_down', 'unavailable', 'no_such_squad', 'full', 'already_in'],
      leave: ['slow_down', 'unavailable'],
      kick: ['slow_down', 'unavailable', 'not_leader', 'no_such_member'],
      ready: ['slow_down', 'unavailable', 'no_squad', 'no_rack', 'dropped'],
      mode: ['slow_down', 'unavailable', 'no_squad', 'not_leader', 'bad_mode', 'bad_tees', 'bad_max'],
      start: ['slow_down', 'unavailable', 'no_squad', 'not_leader', 'wrong_device', 'no_rack', 'duplicate_member', 'wont_fit',
        'member_offline', 'not_ready', 'member_busy', 'refused', 'capacity'],
      resume: ['slow_down', 'unavailable'],
      // CHANGED BY THE INVITE BY CALLSIGN (owner, 2026-10-07): its one miss.
      invite: ['slow_down', 'unavailable', 'no_squad', 'full', 'not_friend', 'already', 'no_such_user'],
    };
    const got = SQUAD_ERRORS instanceof Map ? Object.fromEntries(SQUAD_ERRORS) : null;
    const frozen = SQUAD_ERRORS instanceof Map && [...SQUAD_ERRORS.values()].every((l) => Object.isFrozen(l));
    if (same6(got, WANT) && frozen) ok('(err) every squad op\'s refusal codes are one pinned, frozen list');
    else fail('(err) SQUAD_ERRORS: ' + JSON.stringify(got) + ' frozen ' + frozen);
    const st = t6store(ROWS6);
    const S = mkSocial6(st, { seatSquad: () => ({ ok: false, error: 'weird_new_word', at: 1 }) });
    const wa = up6(S, A), wc = up6(S, C);
    const code = await create6(S, wa);
    await join6(S, wc, code, 'Crater Two');
    await S.handle(wc, { type: 'squad', op: 'ready', ready: true, loadout: RACK5 });
    clear6(wa, wc);
    await S.handle(wa, { type: 'squad', op: 'start', loadout: RACK5, id: 'w' });
    const lead = ans6(wa, 'w'), member = got6(wc, 'squad', 'start');
    if (same6(lead, { type: 'squad', op: 'start', error: 'unavailable', id: 'w' }) && same6(member, [{ type: 'squad', op: 'start', error: 'unavailable' }]))
      ok('(err) a code the list does not name is sent as unavailable, to the leader and to every member');
    else fail('(err) an unlisted code: ' + JSON.stringify({ lead, member }));
  }

  // ==== U3 — THE READY-UP COUNTDOWN (owner, 2026-10-06) ====================
  // "All players must ready up and then the game starts. The leader does not
  // need to initiate the game start." The leader readies like everyone else;
  // the last Ready of a squad of two or more that could be seated starts a
  // 3 s countdown that every member's roster shows as `startsIn`, and its end
  // seats the squad by the path a leader's Start takes. Anything that changes
  // the squad stops it. Builds 6 and 7 still send the leader's Start, which
  // must go on working exactly as it did.
  //
  // THE COUNTDOWN'S TIMER IS INJECTED (createSocial's `schedule`, the drop
  // window's seam) and fired by hand: nothing here waits on wall time. A
  // countdown is told apart from a drop window by its length, which pins
  // production's three seconds as well. `brokenCancel` is a timer that fires
  // although it was cancelled — a late timer — for (rdy-h).
  const mkCw3 = ({ brokenCancel = false } = {}) => {
    const all = [];
    const schedule = (fn, ms) => { const t = { fn, ms, off: false, ran: false }; all.push(t); return () => { if (!brokenCancel) t.off = true; }; };
    const counts = () => all.filter((t) => t.ms === 3000);
    const live = () => counts().filter((t) => !t.off && !t.ran);
    const fire = () => { const l = live(); for (const t of l) { t.ran = true; t.fn(); } return l.length; };
    return { all, schedule, counts, live, fire };
  };
  // A few macrotask turns: the countdown's end runs a seating that awaits a
  // name read before it pushes.
  const turn3 = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const RB3 = LOADOUT_POOL.slice(1, 6);
  // A squad of `n` led by A (then B, C, D), the mode armed, frames cleared.
  // The seating is a recorder that answers `verdict` (or what it returns).
  const world3 = async (n, { mode = 'duel', tees = null, verdict = { ok: true, code: 'RM3U' }, cw = mkCw3() } = {}) => {
    const st = t6store(ROWS6);
    const calls = [];
    const S = mkSocial6(st, {
      schedule: cw.schedule,
      seatSquad: (seats, opts) => { calls.push({ seats, opts }); return typeof verdict === 'function' ? verdict(seats, opts) : verdict; },
    });
    const w = [A, B, C, D].slice(0, n).map((id) => up6(S, id));
    const code = await create6(S, w[0]);
    for (let i = 1; i < n; i++) await join6(S, w[i], code, 'Member ' + i);
    if (mode !== 'duel' || tees) await S.handle(w[0], { type: 'squad', op: 'mode', mode, tees });
    clear6(...w);
    return { st, S, w, code, cw, calls };
  };
  const rack3 = (mode) => (mode === 'boss' || mode === 'aliens' ? RACK7 : RACK5);
  const ready3 = (S, w, on = true, loadout = RACK5) => S.handle(w, on ? { type: 'squad', op: 'ready', ready: true, loadout } : { type: 'squad', op: 'ready', ready: false });
  const st3 = (w) => last6(w, 'squad', 'state');
  // A world whose every member is ready: the countdown is running. `rids` is
  // the leader's roster's handles, read before the frames are cleared.
  const armed3 = async (n, opts = {}) => {
    const t = await world3(n, opts);
    for (let i = n - 1; i >= 0; i--) await ready3(t.S, t.w[i], true, rack3(opts.mode || 'duel'));
    t.rids = ((st3(t.w[0]) || {}).members || []).map((m) => m.rid);
    t.first = t.cw.live()[0] || null;
    t.armed = t.cw.live().length === 1 && !!st3(t.w[0]) && st3(t.w[0]).startsIn === 3000;
    clear6(...t.w);
    return t;
  };
  // What a roster says about the countdown: the time left, or 'none' when
  // the frame carries no such key at all.
  const left3 = (w) => { const f = st3(w); return !f ? null : 'startsIn' in f ? f.startsIn : 'none'; };
  const readies3 = (w) => ((st3(w) || {}).members || []).map((m) => m.ready);

  // ---- (rdy-a) THE LAST READY, THE LEADER'S AMONG THEM, STARTS THE COUNT ----
  {
    const t = await world3(2);
    await ready3(t.S, t.w[1]);
    const one = { live: t.cw.live().length, a: left3(t.w[0]), b: left3(t.w[1]) };
    await ready3(t.S, t.w[0]);
    const l = t.cw.live();
    if (one.live === 0 && one.a === 'none' && one.b === 'none' && l.length === 1 && l[0].ms === 3000
        && left3(t.w[0]) === 3000 && left3(t.w[1]) === 3000 && same6(readies3(t.w[1]), [true, true]) && t.calls.length === 0)
      ok('(rdy-a) a member\'s Ready starts nothing, the leader\'s Ready as the last one starts one 3 s countdown, and both rosters say startsIn 3000; nobody is seated yet');
    else fail('(rdy-a) arming a duel: ' + JSON.stringify({ one, live: l.map((x) => x.ms), a: left3(t.w[0]), b: left3(t.w[1]), calls: t.calls.length }));
  }
  // The same for three and four, readied last-joined first: every Ready but
  // the last starts nothing.
  for (const n of [3, 4]) {
    const t = await world3(n, { mode: 'ffa' });
    const seen = [];
    for (let i = n - 1; i >= 0; i--) { await ready3(t.S, t.w[i]); seen.push(t.cw.live().length); }
    const want = Array.from({ length: n }, (_, i) => (i === n - 1 ? 1 : 0));
    if (same6(seen, want) && t.w.every((w) => left3(w) === 3000)) ok(`(rdy-a) a squad of ${n}: only the last of the ${n} Readies starts the countdown, and all ${n} rosters show it`);
    else fail(`(rdy-a) a squad of ${n}: ` + JSON.stringify({ seen, left: t.w.map(left3) }));
  }

  // ---- (rdy-b) THE COUNTDOWN'S END SEATS EXACTLY WHAT A LEADER'S START DOES -
  // Twin worlds. X: both ready, the countdown runs out. Y: builds 6 and 7 —
  // the member ready, the leader never, and the leader's Start carrying the
  // rack the leader readied with in X. One seating path, so the seating is
  // handed the same thing, and every member is told the same room.
  {
    const x = await world3(2), y = await world3(2);
    await ready3(x.S, x.w[1], true, RB3); await ready3(x.S, x.w[0], true, RACK5);
    await ready3(y.S, y.w[1], true, RB3);
    const yLive = y.cw.live().length;
    clear6(...x.w, ...y.w);
    const fired = x.cw.fire();
    await turn3();
    await y.S.handle(y.w[0], { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    const norm = (t) => t.calls.map((c) => ({ seats: c.seats.map((s) => ({ ...s, ws: t.w.indexOf(s.ws) })), opts: { ...c.opts, squad: c.opts.squad === t.code ? '-' : c.opts.squad } }));
    const DONE = { type: 'squad', op: 'start', ok: true, code: 'RM3U' };
    if (fired === 1 && yLive === 0 && same6(norm(x), norm(y)) && norm(x).length === 1
        && same6(norm(x)[0], { seats: [{ ws: 0, name: '', skin: null, loadout: RACK5 }, { ws: 1, name: 'Member 1', skin: 'olive', loadout: RB3 }], opts: { mode: 'duel', tees: null, squad: '-' } }))
      ok('(rdy-b) the countdown\'s end hands the seating exactly what the leader\'s Start does — the leader first, each rack, the mode and the squad — and a Ready from all but the leader counts nobody in');
    else fail('(rdy-b) seating: ' + JSON.stringify({ fired, yLive, x: norm(x), y: norm(y) }));
    if (same6(got6(x.w[0], 'squad', 'start'), [DONE]) && same6(got6(x.w[1], 'squad', 'start'), [DONE])
        && same6(got6(y.w[1], 'squad', 'start'), [DONE]) && same6(ans6(y.w[0], 's'), { ...DONE, id: 's' })
        && same6(readies3(x.w[0]), [false, false]) && left3(x.w[0]) === 'none' && left3(x.w[1]) === 'none')
      ok('(rdy-b) and every member is told the room as a Start tells them, then shown the Readies spent and no countdown');
    else fail('(rdy-b) frames: ' + JSON.stringify({ x0: x.w[0].rx, x1: x.w[1].rx, y0: ans6(y.w[0], 's') }));
    const again = x.cw.fire();
    await turn3();
    if (again === 0 && x.calls.length === 1) ok('(rdy-b) and nothing is left counting: one countdown, one seating');
    else fail('(rdy-b) a second seating: ' + JSON.stringify({ again, calls: x.calls.length }));
  }

  // ---- (rdy-c) ANY CHANGE STOPS IT ------------------------------------------
  // i. A Ready taken back.
  {
    const t = await armed3(2);
    await ready3(t.S, t.w[1], false);
    const fired = t.cw.fire(); await turn3();
    if (t.armed && t.first.off && fired === 0 && t.calls.length === 0 && left3(t.w[0]) === 'none' && left3(t.w[1]) === 'none')
      ok('(rdy-c) a Ready taken back stops the countdown, every roster stops showing it, and nobody is seated');
    else fail('(rdy-c) unready: ' + JSON.stringify({ armed: t.armed, off: t.first && t.first.off, fired, calls: t.calls.length, a: left3(t.w[0]) }));
  }
  // ii. A leave. The countdown stops; the two left are still all ready, so a
  // NEW one starts, from the top — a second into the old one, the new one
  // still has its full three. A duel left with one member counts nothing.
  {
    const t = await armed3(3, { mode: 'ffa' });
    const t0 = CLOCK6;
    CLOCK6 = t0 + 1000;
    await t.S.handle(t.w[2], { type: 'squad', op: 'leave' });
    const l = t.cw.live();
    const fresh = l.length === 1 && l[0] !== t.first && t.first.off;
    const left = [left3(t.w[0]), left3(t.w[1])];
    CLOCK6 = t0;
    t.cw.fire(); await turn3();
    const d = await armed3(2);
    await d.S.handle(d.w[1], { type: 'squad', op: 'leave' });
    if (t.armed && fresh && same6(left, [3000, 3000]) && t.calls.length === 1 && same6(t.calls[0].seats.map((s) => t.w.indexOf(s.ws)), [0, 1])
        && d.armed && d.first.off && d.cw.live().length === 0 && left3(d.w[0]) === 'none')
      ok('(rdy-c) a leave stops the countdown; the members left, all ready, get a new one with the full 3 s and only they are seated; a duel left alone counts nothing');
    else fail('(rdy-c) leave: ' + JSON.stringify({ armed: t.armed, fresh, left, seats: t.calls.map((c) => c.seats.map((s) => t.w.indexOf(s.ws))), duel: { armed: d.armed, off: d.first && d.first.off, live: d.cw.live().length, a: left3(d.w[0]) } }));
  }
  // iii. A join: the newcomer is not ready.
  {
    const t = await armed3(2, { mode: 'ffa' });
    const wd = up6(t.S, D);
    await join6(t.S, wd, t.code, 'Late');
    const fired = t.cw.fire(); await turn3();
    if (t.armed && t.first.off && fired === 0 && t.calls.length === 0 && left3(t.w[0]) === 'none' && left3(wd) === 'none' && same6(readies3(wd), [true, true, false]))
      ok('(rdy-c) a join stops the countdown: the newcomer is not ready, and nobody is seated');
    else fail('(rdy-c) join: ' + JSON.stringify({ armed: t.armed, fired, calls: t.calls.length, a: left3(t.w[0]), d: readies3(wd) }));
  }
  // iv. A drop: the socket closes, and a dropped member is not ready.
  {
    const t = await armed3(2);
    t.w[1].readyState = 3; t.S.onClose(t.w[1]);
    await turn3();
    const fired = t.cw.fire(); await turn3();
    const f = st3(t.w[0]);
    if (t.armed && t.first.off && fired === 0 && t.calls.length === 0 && f && f.members[1].dropped === true && left3(t.w[0]) === 'none')
      ok('(rdy-c) a member dropping stops the countdown, and the squad is shown them dropped with no countdown');
    else fail('(rdy-c) drop: ' + JSON.stringify({ armed: t.armed, fired, calls: t.calls.length, f }));
  }
  // v, vi. The leader changes the mode, or golf's tee set: every Ready goes
  // and the countdown with them.
  {
    const t = await armed3(3, { mode: 'ffa' });
    await t.S.handle(t.w[0], { type: 'squad', op: 'mode', mode: 'golf', tees: 'mens' });
    const g = await armed3(2, { mode: 'golf', tees: 'mens' });
    await g.S.handle(g.w[0], { type: 'squad', op: 'mode', mode: 'golf', tees: 'champ' });
    if (t.armed && t.first.off && t.cw.live().length === 0 && same6(readies3(t.w[1]), [false, false, false]) && left3(t.w[2]) === 'none'
        && g.armed && g.first.off && g.cw.live().length === 0 && same6(readies3(g.w[1]), [false, false]) && left3(g.w[1]) === 'none')
      ok('(rdy-c) the leader changing the mode, or only the tee set, stands every member down and stops the countdown');
    else fail('(rdy-c) mode/tees: ' + JSON.stringify({ mode: { armed: t.armed, live: t.cw.live().length, r: readies3(t.w[1]) }, tees: { armed: g.armed, live: g.cw.live().length, r: readies3(g.w[1]) } }));
  }
  // vii, viii. What a countdown keeps: a mode frame that changes nothing, and
  // a Ready sent again — the same timer, the Readies standing, and the time
  // left as each frame is built (1.2 s in, 1800 left).
  {
    const g = await armed3(2, { mode: 'golf', tees: 'mens' });
    await g.S.handle(g.w[0], { type: 'squad', op: 'mode', mode: 'golf', tees: 'mens', id: 'm' });
    const t = await armed3(2);
    const t0 = CLOCK6;
    CLOCK6 = t0 + 1200;
    await ready3(t.S, t.w[1]);
    const left = [left3(t.w[0]), left3(t.w[1])];
    CLOCK6 = t0;
    if (g.armed && !g.first.off && same6(g.cw.live(), [g.first]) && same6(readies3(g.w[1]), [true, true]) && left3(g.w[1]) === 3000
        && same6(ans6(g.w[0], 'm'), { type: 'squad', op: 'mode', ok: true, id: 'm' })
        && t.armed && !t.first.off && same6(t.cw.live(), [t.first]) && same6(left, [1800, 1800]))
      ok('(rdy-c) a mode frame that changes nothing and a Ready sent again keep the same countdown and every Ready, and the time left is the time left as the frame is built');
    else fail('(rdy-c) kept: ' + JSON.stringify({ g: { armed: g.armed, off: g.first && g.first.off, r: readies3(g.w[1]), left: left3(g.w[1]) }, t: { armed: t.armed, off: t.first && t.first.off, left } }));
  }
  // ix. A kick, like a leave: the countdown restarts for the members left.
  {
    const t = await armed3(3, { mode: 'ffa' });
    await t.S.handle(t.w[0], { type: 'squad', op: 'kick', rid: t.rids[2] });
    const l = t.cw.live();
    if (t.armed && t.first.off && l.length === 1 && l[0] !== t.first && left3(t.w[1]) === 3000 && same6(got6(t.w[2], 'squad'), [{ type: 'squad', op: 'ended', reason: 'kicked' }]))
      ok('(rdy-c) a kick stops the countdown and, the two left being ready, starts a fresh one; the kicked player is told only the kick');
    else fail('(rdy-c) kick: ' + JSON.stringify({ armed: t.armed, live: l.length, b: left3(t.w[1]), c: t.w[2].rx }));
  }
  // x. The sign-in door. A guest member signs in: until the account's blocks
  // are read the row is not past the door (D-BLOCK-3 F), so the countdown
  // stops and every member is shown it stopped; the read letting the row in
  // starts a new one.
  {
    const st = t6store(ROWS6), cw = mkCw3(), calls = [];
    const S = mkSocial6(st, { schedule: cw.schedule, seatSquad: (seats) => { calls.push(seats); return { ok: true, code: 'RM3U' }; } });
    const wa = up6(S, A), g = t6ws(null);
    const code = await create6(S, wa);
    await join6(S, g, code, 'Guest');
    await ready3(S, g); await ready3(S, wa);
    const first = cw.live()[0] || null, before = left3(wa);
    clear6(wa, g);
    const h = st.hold('blockIdsOf');
    g.userId = E; g.isGuest = false; S.onAuth(g);
    await turn3();
    const during = { live: cw.live().length, a: left3(wa), g: left3(g), fired: cw.fire() };
    await turn3();
    h.release();
    await turn3();
    const l = cw.live();
    if (first && before === 3000 && first.off && same6(during, { live: 0, a: 'none', g: 'none', fired: 0 }) && calls.length === 0
        && l.length === 1 && left3(wa) === 3000 && (st3(wa).members[1] || {}).id === E)
      ok('(rdy-c) a member\'s sign-in door stops the countdown and everyone is shown so; nobody is seated while the read is out; the read letting them in counts again');
    else fail('(rdy-c) door: ' + JSON.stringify({ first: !!first, before, off: first && first.off, during, calls: calls.length, live: l.length, a: left3(wa) }));
  }

  // xi. The squad ends under the countdown: the leader leaves and only a
  // guest, who cannot lead, is left (detach ends it). Its countdown goes with it.
  {
    const st = t6store(ROWS6), cw = mkCw3(), calls = [];
    const S = mkSocial6(st, { schedule: cw.schedule, seatSquad: (seats) => { calls.push(seats); return { ok: true, code: 'RM3U' }; } });
    const wa = up6(S, A), g = t6ws(null);
    const code = await create6(S, wa);
    await join6(S, g, code, 'Guest');
    await ready3(S, g); await ready3(S, wa);
    const first = cw.live()[0] || null;
    await S.handle(wa, { type: 'squad', op: 'leave' });
    const fired = cw.fire(); await turn3();
    if (first && first.off && fired === 0 && calls.length === 0 && same6(last6(g, 'squad', 'ended'), { type: 'squad', op: 'ended', reason: 'no_leader' }))
      ok('(rdy-c) a squad that ends under its countdown takes the countdown with it, and seats nobody');
    else fail('(rdy-c) squad ended: ' + JSON.stringify({ first: !!first, off: first && first.off, fired, calls: calls.length, g: g.rx.slice(-2) }));
  }

  // ---- (rdy-d) A COUNTDOWN THAT ENDS IN A REFUSAL TELLS EVERY MEMBER --------
  // i. The seating refuses (R6's case). Every member gets the frame R6 sends
  // a member — the twin old-client world proves it the same frame — then the
  // roster, with every Ready stood down so the same seating is not tried
  // again three seconds later, and no countdown.
  {
    const verdict = { ok: false, error: 'member_busy', at: 1 };
    const t = await armed3(2, { verdict });
    t.cw.fire(); await turn3();
    const y = await world3(2, { verdict });
    await ready3(y.S, y.w[1]);
    clear6(...y.w);
    await y.S.handle(y.w[0], { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    const R6 = got6(y.w[1], 'squad', 'start');
    const WHY = { type: 'squad', op: 'start', error: 'member_busy', at: 1 };
    const kinds = t.w[1].rx.map((f) => f.op);
    if (t.armed && t.calls.length === 1 && same6(R6, [WHY]) && same6(got6(t.w[0], 'squad', 'start'), [WHY]) && same6(got6(t.w[1], 'squad', 'start'), [WHY])
        && same6(kinds, ['start', 'state']) && same6(readies3(t.w[0]), [false, false]) && left3(t.w[1]) === 'none' && t.cw.live().length === 0)
      ok('(rdy-d) a seating refused at the countdown\'s end tells every member in R6\'s own frame, then shows the squad stood down with no countdown left');
    else fail('(rdy-d) refused seating: ' + JSON.stringify({ armed: t.armed, calls: t.calls.length, R6, a: t.w[0].rx, b: t.w[1].rx, live: t.cw.live().length }));
  }
  // ii. A gate refuses at the end: a member's socket is closing (its close
  // has not run yet). Nobody is seated, and the member who is there is told
  // who is missing.
  {
    const t = await armed3(2);
    t.w[1].readyState = 2;
    t.cw.fire(); await turn3();
    if (t.armed && t.calls.length === 0 && same6(got6(t.w[0], 'squad', 'start'), [{ type: 'squad', op: 'start', error: 'member_offline', at: 1 }])
        && same6(readies3(t.w[0]), [false, false]) && left3(t.w[0]) === 'none' && t.cw.live().length === 0)
      ok('(rdy-d) a gate refusing at the countdown\'s end seats nobody and tells the squad who is not there, Readies stood down');
    else fail('(rdy-d) gate at the end: ' + JSON.stringify({ armed: t.armed, calls: t.calls.length, a: t.w[0].rx }));
  }
  // iii. A seating that THROWS is a refusal like any other, and the timer's
  // callback never lets it out (an unhandled rejection would end this file).
  {
    const t = await armed3(2, { verdict: () => { throw new Error('engine fault'); } });
    t.cw.fire(); await turn3();
    const U = { type: 'squad', op: 'start', error: 'unavailable' };
    if (t.armed && same6(got6(t.w[0], 'squad', 'start'), [U]) && same6(got6(t.w[1], 'squad', 'start'), [U]) && same6(readies3(t.w[1]), [false, false]) && t.cw.live().length === 0)
      ok('(rdy-d) a seating that throws at the countdown\'s end is told to every member as unavailable, and the squad stands down');
    else fail('(rdy-d) throwing seating: ' + JSON.stringify({ armed: t.armed, a: t.w[0].rx, b: t.w[1].rx }));
  }

  // ---- (rdy-e) OLD CLIENTS AND MIXED SQUADS ---------------------------------
  // The member's Ready and the leader's Start are the only frames builds 6
  // and 7 send; (rdy-b)'s Y world is that squad starting. Here: a new leader
  // who has readied pressing an old Start mid-countdown (a second, older
  // device) seats once, at once, and the countdown seats nobody after it.
  {
    const t = await armed3(2);
    await t.S.handle(t.w[0], { type: 'squad', op: 'start', loadout: RACK5, id: 's' });
    const now1 = t.calls.length;
    const fired = t.cw.fire(); await turn3();
    if (t.armed && now1 === 1 && fired === 0 && t.calls.length === 1 && same6(ans6(t.w[0], 's'), { type: 'squad', op: 'start', ok: true, code: 'RM3U', id: 's' }) && left3(t.w[1]) === 'none')
      ok('(rdy-e) a leader\'s Start during the countdown seats the squad at once, and the countdown seats nobody after it');
    else fail('(rdy-e) start mid-countdown: ' + JSON.stringify({ armed: t.armed, now1, fired, calls: t.calls.length }));
  }

  // ---- (rdy-f) BLOCKS: NO COUNTDOWN SEATS A PAIR THE DOORS KEEP APART -------
  // i. A row whose sign-in door's read FAILED stays out of Start (D-BLOCK-3 H
  // amended), so it stops a countdown from starting at all; every push while
  // the rest are ready runs its door again, and a read that lets it in
  // starts the count.
  {
    const st = t6store(ROWS6), cw = mkCw3(), calls = [];
    const S = mkSocial6(st, { schedule: cw.schedule, seatSquad: (seats) => { calls.push(seats); return { ok: true, code: 'RM3U' }; } });
    const wa = up6(S, A), g = t6ws(null);
    const code = await create6(S, wa);
    await join6(S, g, code, 'Guest');
    st.boom.add('blockIdsOf');
    g.userId = E; g.isGuest = false; S.onAuth(g);
    await turn3();
    const reads = () => st.calls.filter((m) => m === 'blockIdsOf').length;
    const r0 = reads();
    await ready3(S, g); await ready3(S, wa);
    await turn3();
    const shut = { live: cw.live().length, a: left3(wa), r: reads() - r0 };
    st.boom.delete('blockIdsOf');
    await ready3(S, g);
    await turn3();
    const l = cw.live();
    cw.fire(); await turn3();
    if (same6(shut, { live: 0, a: 'none', r: 1 }) && l.length === 1 && calls.length === 1 && calls[0].length === 2)
      ok('(rdy-f) a row held at a failed sign-in door keeps the squad from counting down, its door runs again as the squad readies, and a read that lets it in starts the count');
    else fail('(rdy-f) failed door: ' + JSON.stringify({ shut, live: l.length, calls: calls.length }));
  }
  // ii. The leader blocks a member mid-countdown: the block parts the pair
  // (a kick, D-BLOCK 1), the countdown restarts for the two left, and the
  // blocked player is not among the seats.
  {
    const t = await armed3(3, { mode: 'ffa' });
    await t.S.handle(t.w[0], { type: 'block', op: 'add', id: B });
    await turn3();
    const l = t.cw.live();
    t.cw.fire(); await turn3();
    const seated = t.calls.length === 1 ? t.calls[0].seats.map((s) => t.w.indexOf(s.ws)) : null;
    if (t.armed && t.first.off && l.length === 1 && same6(seated, [0, 2]) && same6(got6(t.w[1], 'squad', 'ended'), [{ type: 'squad', op: 'ended', reason: 'kicked' }]))
      ok('(rdy-f) a block mid-countdown parts the pair, the countdown starts again for the members left, and the blocked player is never seated with the blocker');
    else fail('(rdy-f) block mid-countdown: ' + JSON.stringify({ armed: t.armed, live: l.length, seated, b: t.w[1].rx }));
  }

  // ---- (rdy-g) A SQUAD OF ONE NEVER COUNTS, AND ITS OLD START STILL SEATS ---
  {
    const t = await world3(1, { mode: 'boss' });
    await ready3(t.S, t.w[0], true, RACK7);
    const live = t.cw.live().length, left = left3(t.w[0]);
    await t.S.handle(t.w[0], { type: 'squad', op: 'start', loadout: RACK7, id: 's' });
    if (live === 0 && left === 'none' && t.calls.length === 1 && same6(ans6(t.w[0], 's'), { type: 'squad', op: 'start', ok: true, code: 'RM3U', id: 's' }))
      ok('(rdy-g) a squad of one that readies counts nothing down, and a leader\'s Start still seats it');
    else fail('(rdy-g) squad of one: ' + JSON.stringify({ live, left, calls: t.calls.length }));
  }

  // ---- (rdy-h) A STOPPED COUNTDOWN SEATS NOBODY, EVEN IF ITS TIMER FIRES ----
  {
    const t = await armed3(2, { cw: mkCw3({ brokenCancel: true }) });
    await ready3(t.S, t.w[1], false);
    const fired = t.cw.fire(); await turn3();
    if (t.armed && fired === 1 && t.calls.length === 0 && left3(t.w[0]) === 'none' && got6(t.w[0], 'squad', 'start').length === 0)
      ok('(rdy-h) a countdown stopped by an un-ready seats nobody when a late timer fires anyway, and tells nobody anything');
    else fail('(rdy-h) late timer: ' + JSON.stringify({ armed: t.armed, fired, calls: t.calls.length, a: t.w[0].rx }));
  }

  // ---- (rdy-i) ONLY THE SQUAD THAT WAS COUNTED IN IS SEATED ----------------
  // A join or a create takes the caller off their squad AT ONCE, and pushes
  // the squad they left only after the NEW squad's push, which waits on a
  // name read. The old squad's countdown can run out in that gap, before any
  // push has stopped it. Here that read is HELD (the store double's gate) and
  // the countdown's timer fired inside it.
  // i. An FFA of three, the third joining another squad: the two left are
  // not seated by the old countdown. They are pushed at once, without the
  // leaver, with a fresh 3 s countdown; the push the join owes them keeps
  // that one; and it is that one that seats the two.
  {
    const t = await armed3(3, { mode: 'ffa' });
    const wd = up6(t.S, D);
    const codeD = await create6(t.S, wd);
    clear6(...t.w, wd);
    const h = t.st.hold('profilesByIds');
    const p = t.S.handle(t.w[2], { type: 'squad', op: 'join', code: codeD, name: 'Mover', skin: 'olive' });
    await h.inside;
    const fired = t.cw.fire(); await turn3();
    const l = t.cw.live();
    const during = { fired, calls: t.calls.length, fresh: l.length === 1 && l[0] !== t.first, ids: ids6(st3(t.w[0])), left: [left3(t.w[0]), left3(t.w[1])],
      start: got6(t.w[0], 'squad', 'start').length + got6(t.w[1], 'squad', 'start').length };
    h.release(); await p; await turn3();
    const kept = same6(t.cw.live(), l) && left3(t.w[0]) === 3000 && same6(ids6(st3(t.w[2])), [D, C]);
    t.cw.fire(); await turn3();
    const seated = t.calls.map((c) => ({ ws: c.seats.map((s) => t.w.indexOf(s.ws)), mode: c.opts.mode }));
    if (t.armed && same6(during, { fired: 1, calls: 0, fresh: true, ids: [A, B], left: [3000, 3000], start: 0 }) && kept && same6(seated, [{ ws: [0, 1], mode: 'ffa' }]))
      ok('(rdy-i) a countdown running out while a join is still pushing the leaver\'s new squad seats nobody: the two left are shown without the leaver and given a fresh 3 s, which the join\'s own push keeps and which then seats them');
    else fail('(rdy-i) countdown end inside a join: ' + JSON.stringify({ armed: t.armed, during, kept, seated }));
  }
  // ii. A duel, the member creating a squad of their own: the leader, left
  // alone, is refused nothing and stood down from nothing. A squad of one
  // counts nothing, as after a leave.
  {
    const t = await armed3(2);
    const h = t.st.hold('profilesByIds');
    const p = t.S.handle(t.w[1], { type: 'squad', op: 'create' });
    await h.inside;
    const fired = t.cw.fire(); await turn3();
    const during = { fired, calls: t.calls.length, live: t.cw.live().length, start: got6(t.w[0], 'squad', 'start'), ids: ids6(st3(t.w[0])), r: readies3(t.w[0]), left: left3(t.w[0]) };
    h.release(); await p; await turn3();
    const after = { live: t.cw.live().length, start: got6(t.w[0], 'squad', 'start').length, r: readies3(t.w[0]), left: left3(t.w[0]) };
    if (t.armed && same6(during, { fired: 1, calls: 0, live: 0, start: [], ids: [A], r: [true], left: 'none' })
        && same6(after, { live: 0, start: 0, r: [true], left: 'none' }))
      ok('(rdy-i) a duel\'s countdown running out while its member\'s create is still pushing seats nobody and refuses nobody: the leader is shown alone, still ready, with no countdown');
    else fail('(rdy-i) countdown end inside a create: ' + JSON.stringify({ armed: t.armed, during, after }));
  }

  // ---- (end of task 6 checks) ----
  if (prevPushMs === undefined) delete process.env.SOCIAL_PUSH_MS; else process.env.SOCIAL_PUSH_MS = prevPushMs;
  if (prevPresenceMs === undefined) delete process.env.SOCIAL_PRESENCE_MS; else process.env.SOCIAL_PRESENCE_MS = prevPresenceMs;
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall squad checks passed');
process.exit(out.errors.length ? 1 : 0);
