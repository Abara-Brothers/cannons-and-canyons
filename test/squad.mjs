// Task 1's half of squads: ONE CODE NAMESPACE, and the two new frame types
// reaching the layer that will answer them.
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
// minting and the layer that answers a code is what task 1 builds.
//
// Headless: no server, no Chrome, no Supabase, no network, no real clock.
import { readFileSync } from 'node:fs';
import { createSquads } from '../server/squads.js';
// THE REAL ENGINE. This is the one suite in the tree that needs both halves in
// one process: makeCode's loop is what task 1 changes, and `rooms` is the
// container the code frame's room arm reads through.
import { rooms, handleClientMessage, setCodeTaken } from '../public/room-engine.js';
import { createSocial, SOCIAL_TYPES } from '../server/social.js';

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
// says it about its own source checks. These three lines in server.js are
// only observable against a running server with Supabase configured, which
// this headless suite has neither of. What EXECUTES the same shapes is (2b)
// and (3d) below, which wire them by hand with the same expressions.
{
  const src = read('server.js');
  if (/if \(SOCIAL_TYPES\.has\(msg\.type\)\) \{/.test(src))
    ok('(3b) server.js still routes on SOCIAL_TYPES alone — membership in that set IS interception');
  else fail('(3b) server.js no longer contains "if (SOCIAL_TYPES.has(msg.type)) {" — (3a) proves nothing without it');
  if (/roomExists: \(code\) => rooms\.has\(code\)/.test(src))
    ok('(3b) server.js injects roomExists as rooms.has');
  else fail('(3b) server.js does not inject "roomExists: (code) => rooms.has(code)" — the code frame\'s room arm has no container behind it');
  if (/setCodeTaken\(social\.hasSquad\)/.test(src))
    ok('(3b) server.js wires the engine\'s codeTaken to the squad container');
  else fail('(3b) server.js does not call setCodeTaken(social.hasSquad) — squad and room codes can collide');
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

// ---- (3d) the code frame, against the REAL rooms container ------------------
{
  // A CODE WITH A LETTER IN IT, forced rather than hoped for. Eight of the 31
  // characters are digits, so about one mint in 226 is digits alone — and for
  // that code the lower-case probe below is the very same string, passes with
  // the case fold deleted, and proves nothing on that run. Refusing letterless
  // candidates through the engine's own seam (the one (2b) proves) makes every
  // run exercise the fold. The predicate is unwired again before anything else
  // mints.
  setCodeTaken((c) => !/[A-Z]/.test(c));
  const host = mkws();
  handleClientMessage(host, { type: 'create', name: 'T', skin: 'olive', mode: 'duel', loadout: FIVE });
  setCodeTaken(null);
  const CODE = frames(host, 'created')[0].code;
  if (CODE.toLowerCase() === CODE) fail('(3d) the minted code ' + JSON.stringify(CODE) + ' has no letter, so the lower-case probe below cannot fail');

  const store = mkstore();
  const social = createSocial({ store, terms: TERMS, send, now, roomExists: (code) => rooms.has(code) });

  const w1 = mkws(UID);
  await social.handle(w1, { type: 'code', code: CODE, id: 'c1' });
  if (same(last(w1), { type: 'code', kind: 'room', id: 'c1' }))
    ok('(3d) a live room code answers kind "room", with the request id echoed');
  else fail('(3d) a live room code answered ' + JSON.stringify(last(w1)));

  const w2 = mkws(UID);
  await social.handle(w2, { type: 'code', code: CODE.toLowerCase() });
  if (same(last(w2), { type: 'code', kind: 'room' }))
    ok('(3d) the same code in lower case answers "room" — the normalisation matches the engine\'s roomCode()');
  else fail('(3d) lower case answered ' + JSON.stringify(last(w2)));

  // THE TRIM, the other half of roomCode() that a lookup can observe. The
  // engine's join trims, so a pasted " ABCD " seats a player; a code frame that
  // did not trim would tell that same player there is no such game.
  const w2b = mkws(UID);
  await social.handle(w2b, { type: 'code', code: ' ' + CODE + ' ' });
  if (same(last(w2b), { type: 'code', kind: 'room' }))
    ok('(3d) the same code with spaces round it answers "room" — trimmed, as the engine\'s join trims it');
  else fail('(3d) a space-padded code answered ' + JSON.stringify(last(w2b)));

  const w3 = mkws(UID);
  await social.handle(w3, { type: 'code', code: 123 });
  if (same(last(w3), { type: 'code', kind: 'none' }))
    ok('(3d) a non-string code answers "none" rather than throwing on .toUpperCase()');
  else fail('(3d) {code:123} answered ' + JSON.stringify(last(w3)));

  const w4 = mkws(UID);
  await social.handle(w4, { type: 'code' });
  if (same(last(w4), { type: 'code', kind: 'none' })) ok('(3d) a frame with no code at all answers "none"');
  else fail('(3d) a frame with no code answered ' + JSON.stringify(last(w4)));

  // NO SIGN-IN. This field is the guest's whole way in (design 5.1), so it is
  // the one frame in this layer that must never answer the shared
  // { type:'social', error:'sign_in' }. mkws(null) is a socket that never
  // said hello.
  const guest = mkws(null);
  await social.handle(guest, { type: 'code', code: CODE });
  if (same(last(guest), { type: 'code', kind: 'room' }))
    ok('(3d) a socket with no account gets the answer, not a sign-in gate');
  else fail('(3d) an unauthenticated socket got ' + JSON.stringify(last(guest)));

  // THE SAME STRING, THE OTHER ANSWER. Tear the room down and ask again. A
  // handler answering from a constant, or from a container it never
  // consulted, cannot produce two answers for one input.
  handleClientMessage(host, { type: 'leave' });
  if (rooms.size !== 0) fail('(3d) leave did not tear the lobby down; rooms.size is ' + rooms.size);
  const w5 = mkws(UID);
  await social.handle(w5, { type: 'code', code: CODE });
  if (same(last(w5), { type: 'code', kind: 'none' }))
    ok('(3d) the very same code answers "none" once the room is gone — the answer is read, not remembered');
  else fail('(3d) a dead room code still answered ' + JSON.stringify(last(w5)));

  if (store.calls.length === 0) ok('(3d) a code frame never reaches the store — both lookups are memory');
  else fail('(3d) a code frame reached the store: ' + JSON.stringify(store.calls));
}

// ---- (3e) the roomExists default -------------------------------------------
// Every existing test builds createSocial without it, and so does any host
// that does not wire one. The default must REFUSE rather than throw or guess:
// a layer answering "room" here would tell a player a code is joinable on a
// deploy with no rooms container behind the question at all.
{
  const host = mkws();
  handleClientMessage(host, { type: 'create', name: 'T', skin: 'olive', mode: 'duel', loadout: FIVE });
  const CODE = frames(host, 'created')[0].code;
  const social = createSocial({ store: mkstore(), terms: TERMS, send, now });
  const ws = mkws(UID);
  await social.handle(ws, { type: 'code', code: CODE });
  if (same(last(ws), { type: 'code', kind: 'none' }))
    ok('(3e) with no roomExists injected a live room code answers "none" — the default refuses, it does not throw');
  else fail('(3e) the default roomExists answered ' + JSON.stringify(last(ws)));
  handleClientMessage(host, { type: 'leave' });
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
    ok('(3g) createSocial hands out hasSquad — server.js has something to give setCodeTaken');
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
  // (ii) a live squad code answering { type:'code', kind:'squad' };
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

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall squad checks passed');
process.exit(out.errors.length ? 1 : 0);
