// The social layer's callsign message, in process: no server, no sockets, no
// Supabase, no real clock. The store is a fake that records what it was asked
// and can be told to fail; the clock is a variable this file moves.
//
// WHY THIS EXISTS: a chosen callsign is the first string a player authors that
// another player sees. Every rule that keeps it safe — sign-in, the character
// and length rules, the blocklist, the once-a-day gate, the uniqueness race and
// the rate limit — is one `if` away from silently not being there, and not one
// of them shows up in ordinary play. A missing gate here is not a bug report,
// it is a slur on a stranger's screen and an App Review rejection.
import { createSocial, SOCIAL_TYPES } from '../server/social.js';
// The two curated lists and the two pure tests the second name proof is built
// from — the same module server/social.js imports, so (a5) can sweep every pair
// the game can actually roll rather than a handful copied into a fixture.
import { CALL_ADJ, CALL_NOUN, isGeneratedCallsign, isProfane } from '../public/game-core.js';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };

// The engine's send(), copied rather than imported so this suite never loads
// room-engine.js — no rooms, no turn loop, no simulation (the original is
// public/room-engine.js:255-257). It DOES now load public/game-core.js, through
// server/social.js, for the two pure callsign tests that prove a rolled name:
// constants and pure functions, no timers and no side effects.
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
// `isGuest` is the ACCOUNT KIND, not the absence of an id (BINDING.md
// resolution 1): public/cloud.js mints an ANONYMOUS Supabase account for every
// player who saves anything, so a guest arrives here with ws.userId set and
// ws.isGuest true. A fake socket that only ever passes null would test a case
// that barely occurs in production and would miss the one that does.
const mkws = (userId = null, isGuest = false) => ({ readyState: 1, userId, isGuest, chosenName: null, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });
const mkanon = (userId = 'anon-1') => mkws(userId, true);
const last = (ws) => ws._rx[ws._rx.length - 1];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86400000;

// A two-term blocklist. The real one is server/blocklist.txt, loaded by
// server.js and never by this suite: the rule under test is "a term in the list
// is rejected", not which terms ship.
const TERMS = ['badword', 'slur'];

const BASE = Date.parse('2026-09-18T09:00:00Z');
let clock = BASE;
const now = () => clock;

// The fake store. It is the SAME contract server/store.js implements, including
// the part that is easy to forget: setChosenCallsign stamps callsign_set_at as
// part of its own write (design 4.2), which is what the once-a-day gate reads.
function mkstore(over = {}) {
  const st = {
    rows: new Map(),            // userId -> profile row
    keys: new Map(),            // callsign_key -> userId (the unique index)
    calls: [],
    async profileById(id) { st.calls.push(['profileById', id]); return st.rows.get(id) || null; },
    async setChosenCallsign(id, name, key) {
      st.calls.push(['setChosenCallsign', id, name, key]);
      const holder = st.keys.get(key);
      if (holder && holder !== id) return { ok: false, error: 'taken' };
      const row = st.rows.get(id) || { id, friend_code: 'ABC234' };
      if (row.callsign_key && row.callsign_key !== key) st.keys.delete(row.callsign_key);
      st.keys.set(key, id);
      row.callsign = name; row.callsign_key = key; row.callsign_set_at = new Date(now()).toISOString();
      st.rows.set(id, row);
      return { ok: true };
    },
    async clearCallsignKey(id) {
      st.calls.push(['clearCallsignKey', id]);
      const row = st.rows.get(id);
      if (row && row.callsign_key) { st.keys.delete(row.callsign_key); row.callsign_key = null; }
    },
  };
  return Object.assign(st, over);
}
const mk = (over) => { const store = mkstore(over); return { store, social: createSocial({ store, terms: TERMS, send, now }) }; };

// ---- (a) the frame types this layer owns ------------------------------------
{
  const want = ['friends', 'friend', 'block', 'callsign', 'report'];
  if (SOCIAL_TYPES instanceof Set && want.every((t) => SOCIAL_TYPES.has(t)) && SOCIAL_TYPES.size === want.length)
    ok('(a) SOCIAL_TYPES is exactly the five social frame types');
  else fail('(a) SOCIAL_TYPES is ' + JSON.stringify([...(SOCIAL_TYPES || [])]));
}

// ---- (b) a guest is told to sign in, and the reply carries the request id ---
{
  clock = BASE;
  const { store, social } = mk();
  const guest = mkws(null);
  await social.handle(guest, { type: 'callsign', name: 'Wren Delacroix', id: 'x1' });
  if (same(last(guest), { type: 'social', error: 'sign_in', id: 'x1' })) ok('(b) a guest gets sign_in with its id echoed');
  else fail('(b) guest reply was ' + JSON.stringify(last(guest)));
  if (store.calls.length === 0) ok('(b) a guest never reaches the store');
  else fail('(b) a guest reached the store: ' + JSON.stringify(store.calls));
  // Every social type, not just callsign.
  for (const t of ['friends', 'friend', 'block', 'report']) {
    const g = mkws(null);
    await social.handle(g, { type: t });
    if (!same(last(g), { type: 'social', error: 'sign_in' })) fail(`(b) guest '${t}' reply was ` + JSON.stringify(last(g)));
  }
  ok('(b) every social type gates on sign-in, not only callsign');
}

// ---- (b2) AN ANONYMOUS ACCOUNT IS A GUEST (BINDING.md resolution 1) --------
// This is the case that actually happens. public/cloud.js signs every player
// who saves anything into an ANONYMOUS Supabase account, so the socket carries
// a real uuid and a bare `!ws.userId` check waves it straight through — which
// is spec D5 broken with no test failing. The guard is on the account KIND.
{
  clock = BASE;
  const { store, social } = mk();
  const anon = mkanon('anon-1');
  await social.handle(anon, { type: 'callsign', name: 'Wren Delacroix', id: 'a1' });
  if (same(last(anon), { type: 'social', error: 'sign_in', id: 'a1' }))
    ok('(b2) an anonymous account WITH an id is refused a callsign — the guard reads is_anonymous, not the id');
  else fail('(b2) anonymous callsign reply was ' + JSON.stringify(last(anon)));
  if (store.calls.length === 0) ok('(b2) an anonymous account never reaches the store on the callsign path');
  else fail('(b2) an anonymous account reached the store: ' + JSON.stringify(store.calls));
  for (const t of ['friends', 'friend']) {
    const g = mkanon('anon-2');
    await social.handle(g, { type: t });
    if (!same(last(g), { type: 'social', error: 'sign_in' })) fail(`(b2) anonymous '${t}' reply was ` + JSON.stringify(last(g)));
  }
  ok('(b2) friends and friend need a linked account too (spec D5)');
}

// ---- (b3) report and block stay OPEN to a guest (resolution 18) ------------
// The whole moderation case rests on this: a guest who sees an offensive name
// is exactly the player who needs to report it, and Apple asks for a mechanism
// for USERS, not for some of them. So the guard is per message type — and the
// proof that it is per type, rather than one gate that happens to be off, is
// that the SAME anonymous socket is refused a callsign and served a report.
{
  clock = BASE;
  const { social } = mk();
  for (const t of ['report', 'block']) {
    const g = mkanon('anon-3');
    await social.handle(g, { type: t, id: 5 });
    // Tasks 5 and 6 replace 'unavailable' with the real handler. What matters
    // here is that it is NOT 'sign_in': the guest got past the gate.
    if (last(g) && last(g).error !== 'sign_in' && last(g).type === t)
      ok(`(b3) an anonymous guest may '${t}' — the gate is per message type`);
    else fail(`(b3) anonymous '${t}' was refused: ` + JSON.stringify(last(g)));
  }
  // But a socket with NO account at all still cannot: report and block write
  // rows keyed to a reporter, and there is nobody to key them to.
  const nobody = mkws(null);
  await social.handle(nobody, { type: 'report', id: 6 });
  if (same(last(nobody), { type: 'social', error: 'sign_in', id: 6 })) ok('(b3) a socket with no account at all still cannot report');
  else fail('(b3) accountless report reply was ' + JSON.stringify(last(nobody)));
}

// ---- (c) a valid name is stored and echoed ----------------------------------
{
  clock = BASE;
  const { store, social } = mk();
  const ws = mkws('u1');
  await social.handle(ws, { type: 'callsign', name: '  Marguerite   Vale  ', id: 7 });
  if (same(last(ws), { type: 'callsign', ok: true, callsign: 'Marguerite Vale', id: 7 }))
    ok('(c) a valid name is normalised, stored and echoed back with its id');
  else fail('(c) reply was ' + JSON.stringify(last(ws)));
  const wrote = store.calls.find((c) => c[0] === 'setChosenCallsign');
  if (same(wrote, ['setChosenCallsign', 'u1', 'Marguerite Vale', 'marguerite vale']))
    ok('(c) the store was asked for the display form and the lowercased key');
  else fail('(c) the write was ' + JSON.stringify(wrote));
  if (ws.chosenName === 'Marguerite Vale') ok('(c) ws.chosenName is set, so the lobby may show the name');
  else fail('(c) ws.chosenName is ' + JSON.stringify(ws.chosenName));
  // 15 characters: the chosen limit is 16, four more than a rolled pair may use.
  if ('Marguerite Vale'.length === 15) ok('(c) a 15-character name passes — CALLSIGN_MAX is 16, not NAME_MAX 14');
  else fail('(c) the fixture name changed length');
}

// ---- (d) the write is the authority: a race answers taken -------------------
{
  clock = BASE;
  const { store, social } = mk();
  const a = mkws('u1'), b = mkws('u2');
  await social.handle(a, { type: 'callsign', name: 'Wren Delacroix' });
  await social.handle(b, { type: 'callsign', name: 'wren  DELACROIX' });
  if (same(last(b), { type: 'callsign', error: 'taken' })) ok('(d) a second account taking the same key is told taken');
  else fail('(d) reply was ' + JSON.stringify(last(b)));
  if (b.chosenName === null) ok('(d) the loser of the race keeps no chosen name on its socket');
  else fail('(d) loser chosenName is ' + JSON.stringify(b.chosenName));
  if (store.keys.get('wren delacroix') === 'u1') ok('(d) the key still belongs to the winner');
  else fail('(d) key holder is ' + JSON.stringify(store.keys.get('wren delacroix')));
}

// ---- (e) every validation error code ----------------------------------------
{
  const CASES = [
    ['ab', 'length'],
    ['x'.repeat(17), 'length'],
    ['Bad<name>', 'chars'],
    ['Badword Ridge', 'not_allowed'],
  ];
  for (const [name, error] of CASES) {
    clock = BASE;
    const { store, social } = mk();
    const ws = mkws('u1');
    await social.handle(ws, { type: 'callsign', name });
    if (same(last(ws), { type: 'callsign', error })) ok(`(e) ${JSON.stringify(name)} -> ${error}`);
    else fail(`(e) ${JSON.stringify(name)} -> ` + JSON.stringify(last(ws)));
    if (store.calls.length) fail(`(e) ${JSON.stringify(name)} reached the store before failing validation`);
  }
  ok('(e) a rejected name never costs a round trip to the database');
}

// ---- (e2) validateCallsign THROWING must not take the process ---------------
// server/callsign.js throws a TypeError when `terms` is not an array — a
// deliberate fail-closed at wire-up time. This project's uncaughtException
// handler ENDS THE PROCESS, and with it every live match, so that throw has to
// be caught here or a wiring mistake in one file kills every game in progress.
{
  clock = BASE;
  const { social } = mk();
  // The wire-up mistake the throw exists to catch: terms that are not an array.
  const broken = createSocial({ store: mkstore(), terms: new Set(TERMS), send, now });
  const ws = mkws('u1');
  let threw = null;
  try { await broken.handle(ws, { type: 'callsign', name: 'Wren Delacroix', id: 4 }); } catch (e) { threw = e; }
  if (threw) fail('(e2) a throw from validateCallsign escaped handle(): ' + threw.message);
  else if (same(last(ws), { type: 'callsign', error: 'unavailable', id: 4 }))
    ok('(e2) a throw out of validateCallsign is caught and answered unavailable, not left to kill the process');
  else fail('(e2) reply was ' + JSON.stringify(last(ws)));
  // And the healthy layer is unaffected by its broken neighbour.
  const ws2 = mkws('u2');
  await social.handle(ws2, { type: 'callsign', name: 'Wren Delacroix' });
  if (last(ws2).ok === true) ok('(e2) a correctly wired layer still works');
  else fail('(e2) healthy layer reply was ' + JSON.stringify(last(ws2)));
}

// ---- (f) once per day, before and after the clock moves ---------------------
{
  clock = BASE;
  const { store, social } = mk();
  const ws = mkws('u1');
  await social.handle(ws, { type: 'callsign', name: 'Wren Delacroix' });
  if (last(ws).ok !== true) fail('(f) the first set did not succeed: ' + JSON.stringify(last(ws)));
  clock = BASE + DAY - 1000;
  await social.handle(ws, { type: 'callsign', name: 'Marguerite Vale' });
  if (same(last(ws), { type: 'callsign', error: 'too_soon' })) ok('(f) a second set one second inside 24 hours is refused');
  else fail('(f) inside the day the reply was ' + JSON.stringify(last(ws)));
  if (ws.chosenName === 'Wren Delacroix') ok('(f) the refused set left the old name on the socket');
  else fail('(f) chosenName after too_soon is ' + JSON.stringify(ws.chosenName));
  clock = BASE + DAY + 1000;
  await social.handle(ws, { type: 'callsign', name: 'Marguerite Vale' });
  if (same(last(ws), { type: 'callsign', ok: true, callsign: 'Marguerite Vale' })) ok('(f) one second past 24 hours it goes through');
  else fail('(f) past the day the reply was ' + JSON.stringify(last(ws)));
  if (store.keys.get('wren delacroix') === undefined) ok('(f) the old key is released when the name changes');
  else fail('(f) the old key survived: ' + JSON.stringify([...store.keys]));
}

// ---- (f2) no record of a previous set means the gate is open ---------------
{
  clock = BASE;
  // A row that exists but has never had a chosen name, and a row that does not
  // exist at all: both must be allowed through. Failing OPEN is deliberate —
  // a null or unreadable timestamp must never lock a player out of their own
  // name for ever.
  for (const [label, row] of [['null callsign_set_at', { id: 'u1', callsign: 'Iron Ridge', callsign_key: null, callsign_set_at: null }],
                              ['an unparseable timestamp', { id: 'u1', callsign: 'Iron Ridge', callsign_key: null, callsign_set_at: 'not a date' }]]) {
    const { store, social } = mk();
    store.rows.set('u1', row);
    const ws = mkws('u1');
    await social.handle(ws, { type: 'callsign', name: 'Wren Delacroix' });
    if (last(ws).ok === true) ok(`(f2) ${label} -> the set is allowed`);
    else fail(`(f2) ${label} -> ` + JSON.stringify(last(ws)));
  }
  const { social } = mk();               // no row for this account at all
  const ws = mkws('u9');
  await social.handle(ws, { type: 'callsign', name: 'Wren Delacroix' });
  if (last(ws).ok === true) ok('(f2) no profile row at all -> the set is allowed');
  else fail('(f2) no row -> ' + JSON.stringify(last(ws)));
}

// ---- (g) the rate limit: three a minute, then slow_down --------------------
{
  clock = BASE;
  const { social } = mk();
  const ws = mkws('u1');
  const got = [];
  for (let i = 0; i < 4; i++) { await social.handle(ws, { type: 'callsign', name: 'ab' }); got.push(last(ws).error); }
  if (same(got, ['length', 'length', 'length', 'slow_down'])) ok('(g) the fourth callsign message in a minute is slow_down');
  else fail('(g) four messages gave ' + JSON.stringify(got));
  clock = BASE + 60000;
  await social.handle(ws, { type: 'callsign', name: 'ab' });
  if (last(ws).error === 'length') ok('(g) the bucket refills: a minute later the message is served again');
  else fail('(g) after a minute the reply was ' + JSON.stringify(last(ws)));
  // A second socket has its own bucket — the limit is per socket, not global.
  const other = mkws('u2');
  await social.handle(other, { type: 'callsign', name: 'ab' });
  if (last(other).error === 'length') ok('(g) the bucket is per socket');
  else fail('(g) a fresh socket was limited: ' + JSON.stringify(last(other)));
}

// ---- (g2) the bucket has a FLOOR as well as a ceiling ----------------------
// The refill term is (now - lastRefill), and now() is wall clock. A clock that
// steps BACKWARDS — ntp correction, a VM resume, someone setting the date —
// makes it negative, and without a clamp the bucket goes below zero with no
// floor: the socket is then starved for as long as the honest refill takes to
// climb back from -N, in proportion to the size of the jump. A player's
// callsign box silently stops working and nothing anywhere says why.
{
  clock = BASE;
  const { social } = mk();
  const ws = mkws('u1');
  // Spend one, then hand the limiter a clock ten minutes in the past.
  await social.handle(ws, { type: 'callsign', name: 'ab' });
  clock = BASE - 600000;
  const got = [];
  for (let i = 0; i < 2; i++) { await social.handle(ws, { type: 'callsign', name: 'ab' }); got.push(last(ws).error); }
  // 3/min, one already spent: two more must still be served across the jump.
  if (same(got, ['length', 'length'])) ok('(g2) a backwards clock jump does not drive the bucket below zero');
  else fail('(g2) after a backwards clock jump two messages gave ' + JSON.stringify(got));
  // ...and the limit itself still bites, so the clamp did not simply open it.
  await social.handle(ws, { type: 'callsign', name: 'ab' });
  if (last(ws).error === 'slow_down') ok('(g2) the clamp restores the floor, it does not remove the limit');
  else fail('(g2) the fourth message after the jump gave ' + JSON.stringify(last(ws)));
}

// ---- (h) a store failure is unavailable, never a crash ---------------------
{
  for (const [label, over] of [
    ['the profile read', { async profileById() { throw new Error('sb GET 500'); } }],
    ['the write', { async setChosenCallsign() { throw new Error('sb PATCH 503'); } }],
    ['the key clear', { async clearCallsignKey() { throw new Error('sb PATCH 503'); } }],
  ]) {
    clock = BASE;
    const { social } = mk(over);
    const ws = mkws('u1');
    const msg = label === 'the key clear' ? { type: 'callsign', rolled: true } : { type: 'callsign', name: 'Wren Delacroix' };
    // The roll path only writes when there is a key to clear (see (i3) below),
    // so this socket has to be holding a chosen name or the failing store call
    // is never reached and this case would assert nothing.
    if (label === 'the key clear') ws.chosenName = 'Wren Delacroix';
    let threw = null;
    try { await social.handle(ws, msg); } catch (e) { threw = e; }
    if (threw) fail(`(h) ${label} threw out of handle(): ` + threw.message);
    else if (same(last(ws), { type: 'callsign', error: 'unavailable' })) ok(`(h) ${label} failing answers unavailable`);
    else fail(`(h) ${label} failing answered ` + JSON.stringify(last(ws)));
  }
}

// ---- (i) rolling gives up the key, and only the key ------------------------
{
  clock = BASE;
  const { store, social } = mk();
  const ws = mkws('u1');
  await social.handle(ws, { type: 'callsign', name: 'Wren Delacroix' });
  const stamp = store.rows.get('u1').callsign_set_at;
  clock = BASE + 1000;
  await social.handle(ws, { type: 'callsign', rolled: true, id: 3 });
  if (same(last(ws), { type: 'callsign', ok: true, callsign: null, id: 3 })) ok('(i) a rolled frame answers ok with callsign null');
  else fail('(i) rolled reply was ' + JSON.stringify(last(ws)));
  if (store.rows.get('u1').callsign_key === null) ok('(i) the key is cleared, so the rolled name is non-unique again');
  else fail('(i) key after roll is ' + JSON.stringify(store.rows.get('u1').callsign_key));
  if (store.rows.get('u1').callsign_set_at === stamp) ok('(i) callsign_set_at is untouched — roll-then-set is not a way around the daily rule');
  else fail('(i) callsign_set_at moved on roll: ' + JSON.stringify(store.rows.get('u1').callsign_set_at));
  if (ws.chosenName === null) ok('(i) the socket may no longer present the old name in a lobby');
  else fail('(i) chosenName after roll is ' + JSON.stringify(ws.chosenName));
  // And the daily rule still bites afterwards.
  await social.handle(ws, { type: 'callsign', name: 'Marguerite Vale' });
  if (last(ws).error === 'too_soon') ok('(i) setting again straight after a roll is still too_soon');
  else fail('(i) set after roll gave ' + JSON.stringify(last(ws)));
  // A rolled frame carrying a name is not a set: the name is ignored.
  clock = BASE + DAY + 5000;
  const ws2 = mkws('u2');
  await social.handle(ws2, { type: 'callsign', rolled: true, name: 'Badword Ridge' });
  if (last(ws2).ok === true && ws2.chosenName === null) ok('(i) a name on a rolled frame is ignored, not stored');
  else fail('(i) rolled+name gave ' + JSON.stringify(last(ws2)) + ' chosenName=' + JSON.stringify(ws2.chosenName));
}

// ---- (i3) a roll with nothing to clear is not a database write -------------
// The roll branch has no once-a-day gate, and the 3/min bucket lives on the
// SOCKET — so reconnecting resets it. An unconditional PATCH there is one
// uncapped database write per frame per account, from a client that only has
// to open a socket and say hello. ws.chosenName is what the account actually
// holds (server.js's auth sink fills it from the profile row), so a null one
// means the write would clear a key that is already null.
{
  clock = BASE;
  const { store, social } = mk();
  // An account that holds NO chosen name — the overwhelmingly common case,
  // because every player who has never picked one is in it.
  const ws = mkws('u1');
  for (let i = 0; i < 3; i++) await social.handle(ws, { type: 'callsign', rolled: true, id: i });
  const writes = store.calls.filter((c) => c[0] === 'clearCallsignKey');
  if (!writes.length) ok('(i3) three rolled frames from an account with no chosen name cost zero writes');
  else fail(`(i3) a roll with nothing to clear still wrote ${writes.length} time(s): ` + JSON.stringify(store.calls));
  // The REPLY is unchanged, so no client can tell the write was skipped.
  if (same(last(ws), { type: 'callsign', ok: true, callsign: null, id: 2 })) ok('(i3) the reply is the same ok/callsign:null either way');
  else fail('(i3) the skipped-write reply was ' + JSON.stringify(last(ws)));
  // And an account that DOES hold one still pays exactly once.
  clock = BASE + DAY;
  const ws2 = mkws('u2');
  await social.handle(ws2, { type: 'callsign', name: 'Wren Delacroix' });
  await social.handle(ws2, { type: 'callsign', rolled: true });
  await social.handle(ws2, { type: 'callsign', rolled: true });
  const w2 = store.calls.filter((c) => c[0] === 'clearCallsignKey' && c[1] === 'u2');
  if (w2.length === 1) ok('(i3) an account that holds a chosen name pays for exactly one clear, not one per frame');
  else fail(`(i3) clearing an existing key cost ${w2.length} write(s)`);
  if (store.rows.get('u2').callsign_key === null) ok('(i3) and the key really is gone after that one write');
  else fail('(i3) key after roll is ' + JSON.stringify(store.rows.get('u2').callsign_key));
}

// ---- (i2) a guest cannot roll away someone's key either --------------------
// The roll path writes to the database before it reads anything, so if the gate
// were only on the SET branch an anonymous socket could clear a key.
{
  clock = BASE;
  const { store, social } = mk();
  const anon = mkanon('anon-4');
  await social.handle(anon, { type: 'callsign', rolled: true, id: 8 });
  if (same(last(anon), { type: 'social', error: 'sign_in', id: 8 })) ok('(i2) an anonymous account cannot roll — the gate covers both branches');
  else fail('(i2) anonymous roll reply was ' + JSON.stringify(last(anon)));
  if (store.calls.length === 0) ok('(i2) the roll never reached the store');
  else fail('(i2) anonymous roll reached the store: ' + JSON.stringify(store.calls));
}

// ---- (j) a store that cannot serve the read model answers rather than hangs --
// Task 4 wrote this when 'friends' was a stub. It still holds, for a better
// reason: this section's store double implements the callsign methods and none
// of the friend ones, which is exactly the shape of a live server whose
// PostgREST cannot see the phase 6 tables — and the frame it answers is the one
// a client can act on instead of waiting for ever.
{
  clock = BASE;
  const { social } = mk();
  const ws = mkws('u1');
  await social.handle(ws, { type: 'friends', id: 9 });
  if (same(last(ws), { type: 'friends', error: 'unavailable', id: 9 })) ok('(j) a store with no friend methods answers unavailable, so no client waits for ever');
  else fail('(j) reply was ' + JSON.stringify(last(ws)));
}

// ---- (k) presence: the online map ------------------------------------------
{
  clock = BASE;
  const { social } = mk();
  const a1 = mkws('u1'), a2 = mkws('u1'), b1 = mkws('u2'), guest = mkws(null);
  social.onAuth(a1); social.onAuth(a2); social.onAuth(b1); social.onAuth(guest);
  if (social.online.get('u1') && social.online.get('u1').size === 2 && social.online.get('u2').size === 1 && social.online.size === 2)
    ok('(k) two sockets for one account are one online entry; a guest is none');
  else fail('(k) online after auth: ' + JSON.stringify([...social.online].map(([k, v]) => [k, v.size])));
  social.onClose(a1);
  if (social.online.get('u1').size === 1) ok('(k) closing one of two sockets leaves the account online');
  else fail('(k) after one close: ' + JSON.stringify(social.online.get('u1') && social.online.get('u1').size));
  social.onClose(a2);
  if (!social.online.has('u1') && social.online.size === 1) ok('(k) the last socket closing drops the whole entry — the map cannot grow for ever');
  else fail('(k) after both closes the map is ' + JSON.stringify([...social.online.keys()]));
  social.onClose(guest); social.onClose(mkws('u3'));
  ok('(k) closing a guest, or a socket that never authenticated, is a no-op');
}

// ---- (k2) an anonymous account is not "online" -----------------------------
// Presence exists to tell FRIENDS who is about, and an anonymous account can
// never be anyone's friend (D5). Listing one would leak a stranger's session to
// the friends panel and grow the map by an entry per throwaway account.
{
  clock = BASE;
  const { social } = mk();
  const anon = mkanon('anon-5');
  social.onAuth(anon);
  if (social.online.size === 0) ok('(k2) an anonymous account gets no presence entry');
  else fail('(k2) an anonymous account is in the online map: ' + JSON.stringify([...social.online.keys()]));
  social.onClose(anon);
  ok('(k2) closing an anonymous socket is a no-op');
}

// ===========================================================================
// FRIENDS, REQUESTS AND PRESENCE (design 4.1, 4.2) — task 5
//
// WHY THIS EXISTS: every path here fails SILENTLY. A friendship written on one
// side only, a search that finds the person who blocked you, two people who
// each requested the other and stay stuck at "requested", a presence frame
// delivered to a stranger, a snapshot that walks the profile table once per
// friend, a name a player PATCHED into their own profile row shown verbatim in
// somebody else's panel — none of them throws, none of them is visible in a
// screenshot, and each one is a store-review problem rather than a bug report.
//
// This section brings its own store double and its own clock so it cannot be
// broken by a change to another section's fixture.
// ===========================================================================
{
  // Read INSIDE createSocial, so setting it here reaches every instance this
  // section builds even though social.js was imported at the top of the file.
  process.env.SOCIAL_PRESENCE_MS = '40';
  // The fan-out collapse window, OFF for every section but the one that tests
  // it: an operation's own snapshot must arrive before the next `await` in a
  // test, and 0 means every push is immediate. (b3) sets a real window itself.
  process.env.SOCIAL_PUSH_MS = '0';

  // HEX LETTERS ON PURPOSE. A fixture of digits alone makes toUpperCase() a
  // no-op, so the case-fold on ids arriving off the wire would have no test
  // that can fail — see the upper-case remove in (e).
  const uid = (n) => '00000000-0000-4000-8000-ab' + String(n).padStart(10, '0');
  const A = uid(1), B = uid(2), C = uid(3), D = uid(4), E = uid(5), F = uid(6);
  // callsign_key is the SERVER's word — the phase 6 migration revokes update on
  // that column from the authenticated role, so only the secret key writes it.
  // `callsign` beside it is NOT: profiles_update_own lets the account PATCH it
  // on every cloud save. Rows here carry both so the trust rule can be tested.
  const ROWS = [
    { id: A, callsign: 'Anvil Six',   friend_code: 'ABC234', callsign_key: 'anvil six',   callsign_set_at: null, skin: 'desert' },
    { id: B, callsign: 'Bunker Nine', friend_code: 'BDF345', callsign_key: 'bunker nine', callsign_set_at: null, skin: 'gold' },
    { id: C, callsign: 'Crater Two',  friend_code: 'CGH456', callsign_key: 'crater two',  callsign_set_at: null },
    { id: D, callsign: 'Dune Four',   friend_code: 'DJK567', callsign_key: 'dune four',   callsign_set_at: null },
    { id: E, callsign: 'Echo Seven',  friend_code: 'EMN678', callsign_key: 'echo seven',  callsign_set_at: null },
  ];

  // The store double. Same method set and same return shapes as server/store.js
  // (the contract), in memory. `boom` turns any one method into the real
  // thing's failure — sbAdmin throws `sb <METHOD> <status>` and keeps no body.
  //
  // profilesByIds returns { id, callsign, callsign_key } and NOTHING ELSE,
  // exactly as server/store.js does (`select=id,callsign,callsign_key`). The
  // key is the whole reason a panel name can be believed: `callsign` beside it
  // is PATCHed by the account itself. A double that handed back the full row
  // would let a name be proved against a column the real query never selects,
  // which is the bug this suite exists to catch rather than to reproduce.
  const PAIR = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  function memStore(rows) {
    const profiles = new Map(rows.map((p) => [p.id, { ...p }]));
    const friends = new Set();     // PAIR(a, b)
    const requests = new Set();    // from + '>' + to
    const blocks = new Set();      // blocker + '>' + blocked
    const st = {
      profiles, friends, requests, blocks, calls: [], boom: new Set(),
      _hit(m) { st.calls.push(m); if (st.boom.has(m)) throw new Error('sb GET 500'); },
      async ensureFriendCode(id) { st._hit('ensureFriendCode'); const p = profiles.get(id); return p ? p.friend_code : null; },
      async profileById(id) { st._hit('profileById'); return profiles.get(id) || null; },
      async profileByFriendCode(code) { st._hit('profileByFriendCode'); return [...profiles.values()].find((p) => p.friend_code === code) || null; },
      async profileByCallsignKey(k) { st._hit('profileByCallsignKey'); return [...profiles.values()].find((p) => p.callsign_key === k) || null; },
      async profilesByIds(ids) { st._hit('profilesByIds'); const m = new Map(); for (const id of ids) { const p = profiles.get(id); if (p) m.set(id, { id, callsign: p.callsign, callsign_key: p.callsign_key ?? null }); } return m; },
      async friendIdsOf(id) { st._hit('friendIdsOf'); const o = []; for (const k of friends) { const [a, b] = k.split('|'); if (a === id) o.push(b); else if (b === id) o.push(a); } return o; },
      async requestsOf(id) { st._hit('requestsOf'); const incoming = [], outgoing = []; for (const k of requests) { const [f, t] = k.split('>'); if (t === id) incoming.push(f); else if (f === id) outgoing.push(t); } return { incoming, outgoing }; },
      async blockIdsOf(id) { st._hit('blockIdsOf'); const blocked = [], blockedBy = []; for (const k of blocks) { const [a, b] = k.split('>'); if (a === id) blocked.push(b); else if (b === id) blockedBy.push(a); } return { blocked, blockedBy }; },
      async addFriendship(a, b) { st._hit('addFriendship'); friends.add(PAIR(a, b)); },
      async removeFriendship(a, b) { st._hit('removeFriendship'); friends.delete(PAIR(a, b)); },
      async addRequest(f, t) { st._hit('addRequest'); requests.add(f + '>' + t); },
      async deleteRequest(f, t) { st._hit('deleteRequest'); requests.delete(f + '>' + t); },
      async addBlock(a, b) { st._hit('addBlock'); blocks.add(a + '>' + b); },
      async removeBlock(a, b) { st._hit('removeBlock'); blocks.delete(a + '>' + b); },
      async addReport() { st._hit('addReport'); },
      async reportedSince() { st._hit('reportedSince'); return false; },
    };
    return st;
  }

  // A linked account: ws.userId set, ws.isGuest false. The guest case is a
  // socket with a real uuid and isGuest TRUE — see (j).
  const mkws = (userId, isGuest = false) => ({ readyState: 1, userId, isGuest, rx: [] });
  const sent = (ws, t) => ws.rx.filter((m) => m.type === t);
  const last = (ws, t) => sent(ws, t)[sent(ws, t).length - 1] || null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pair = (a, b) => PAIR(a, b);
  let CLOCK = 1700000000000;
  const mkSocial = (store, terms = []) => createSocial({ store, terms, send: (ws, frame) => ws.rx.push(frame), now: () => CLOCK });

  // ---- (a) the read model ---------------------------------------------------
  {
    const st = memStore(ROWS);
    await st.addFriendship(A, B);
    await st.addRequest(C, A);        // incoming
    await st.addRequest(A, D);        // outgoing
    await st.addBlock(A, E);
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B);
    S.onAuth(wa); S.onAuth(wb);
    st.calls.length = 0;
    await S.handle(wa, { type: 'friends', id: 7 });
    const f = last(wa, 'friends');
    if (f && f.id === 7 && f.friendCode === 'ABC234') ok('(a) friends: the request id comes back, with the friend code');
    else fail('(a) friends frame: ' + JSON.stringify(f));
    if (f && JSON.stringify(f.friends) === JSON.stringify([{ id: B, callsign: 'Bunker Nine', online: true }]))
      ok('(a) friends: the callsign is resolved and online is true while B holds a socket');
    else fail('(a) friends list: ' + JSON.stringify(f && f.friends));
    if (f && f.requests && f.requests.in.length === 1 && f.requests.in[0].id === C && f.requests.in[0].callsign === 'Crater Two'
        && f.requests.out.length === 1 && f.requests.out[0].id === D && f.requests.out[0].callsign === 'Dune Four')
      ok('(a) friends: both request directions, each named');
    else fail('(a) requests: ' + JSON.stringify(f && f.requests));
    if (f && f.blocked && f.blocked.length === 1 && f.blocked[0].id === E && f.blocked[0].callsign === 'Echo Seven')
      ok('(a) friends: the blocked list is named too');
    else fail('(a) blocked: ' + JSON.stringify(f && f.blocked));
    // BINDING resolution 13: without this a player signing in on a second
    // device is told to choose a name they already have.
    if (f && f.callsign === 'Anvil Six') ok('(a) friends: the frame carries the player’s OWN chosen callsign (resolution 13)');
    else fail('(a) own callsign: ' + JSON.stringify(f && f.callsign));
    const many = st.calls.filter((c) => c === 'profilesByIds').length;
    const one = st.calls.filter((c) => c === 'profileById').length;
    // ONE profilesByIds for every other player, and exactly ONE profileById —
    // the player's own row, which is the only place callsign_key can be proved.
    if (many === 1 && one === 1) ok('(a) friends: four other ids resolved in ONE profilesByIds; one own-row read, no per-friend lookups');
    else fail(`(a) name lookups: profilesByIds ${many}, profileById ${one}`);
    const wanted = new Set(['friendIdsOf', 'requestsOf', 'blockIdsOf', 'ensureFriendCode', 'profileById', 'profilesByIds']);
    if (st.calls.every((c) => wanted.has(c)) && st.calls.length === 6) ok('(a) friends: six store reads in total, nothing repeated');
    else fail('(a) store calls: ' + JSON.stringify(st.calls));
  }

  // ---- (a2) the own callsign is PROVEN against callsign_key ------------------
  // profiles.callsign is a column the account PATCHes itself on every cloud
  // save (profiles_update_own, public/cloud.js save()). callsign_key beside it
  // is revoked from the authenticated role by the phase 6 migration, so it is
  // the server's word. Trusting `callsign` because a key exists is the exact
  // hole Task 4 closed in the auth sink; this frame is a second door to it.
  {
    const TAMPERED = [
      { id: A, callsign: 'FOLLOW ME OK', friend_code: 'ABC234', callsign_key: 'anvil six', callsign_set_at: null },
      { id: B, callsign: 'Bunker Nine',  friend_code: 'BDF345', callsign_key: null,        callsign_set_at: null },
      { id: C, callsign: null,           friend_code: 'CGH456', callsign_key: null,        callsign_set_at: null },
      { id: D, callsign: '  anvil   SIX ', friend_code: 'DJK567', callsign_key: 'anvil six', callsign_set_at: null },
    ];
    const st = memStore(TAMPERED);
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B), wc = mkws(C), wd = mkws(D);
    await S.handle(wa, { type: 'friends' });
    if ((last(wa, 'friends') || {}).callsign === null)
      ok('(a2) own callsign: a row whose callsign does not match its callsign_key is NOT presented');
    else fail('(a2) tampered own callsign: ' + JSON.stringify(last(wa, 'friends')));
    await S.handle(wb, { type: 'friends' });
    if ((last(wb, 'friends') || {}).callsign === null)
      ok('(a2) own callsign: a rolled name (callsign_key null) reads null, so the client still offers Set callsign');
    else fail('(a2) rolled own callsign: ' + JSON.stringify(last(wb, 'friends')));
    await S.handle(wc, { type: 'friends' });
    if ((last(wc, 'friends') || {}).callsign === null) ok('(a2) own callsign: no name at all is null, not a crash');
    else fail('(a2) null own callsign: ' + JSON.stringify(last(wc, 'friends')));
    await S.handle(wd, { type: 'friends' });
    if ((last(wd, 'friends') || {}).callsign === 'anvil SIX')
      ok('(a2) own callsign: an honest row is presented NORMALISED, the same shape sanitizeName compares against');
    else fail('(a2) honest own callsign: ' + JSON.stringify(last(wd, 'friends')));
  }

  // ---- (a3) every OTHER player's name is filtered at READ time too -----------
  // The key proves the server stored the name; it does not prove the name is
  // still allowed. server/blocklist.txt is read at start-up and terms are added
  // to it, so a name that was clean when it was set is put through the same
  // rules again at the moment it is shown. This is the second half of the check,
  // on top of the key — (a4) is the half that closes impersonation.
  {
    const DIRTY = [
      { id: A, callsign: 'Anvil Six',    friend_code: 'ABC234', callsign_key: 'anvil six',    callsign_set_at: null },
      { id: B, callsign: 'Badword Nine', friend_code: 'BDF345', callsign_key: 'badword nine', callsign_set_at: null },
      { id: C, callsign: 'x',            friend_code: 'CGH456', callsign_key: 'x',            callsign_set_at: null },
      { id: D, callsign: 'Dune Four',    friend_code: 'DJK567', callsign_key: 'dune four',    callsign_set_at: null },
    ];
    const st = memStore(DIRTY);
    await st.addFriendship(A, B);
    await st.addFriendship(A, C);
    await st.addFriendship(A, D);
    const S = mkSocial(st, ['badword']);
    const wa = mkws(A);
    await S.handle(wa, { type: 'friends' });
    const names = ((last(wa, 'friends') || {}).friends || []).map((x) => [x.id, x.callsign]);
    const byId = new Map(names);
    if (byId.get(B) === null) ok('(a3) a name the server DID store is still refused when the blocklist has caught up with it');
    else fail('(a3) dirty friend name: ' + JSON.stringify(names));
    if (byId.get(C) === null) ok('(a3) a name outside the length rules is null too, never a raw column value');
    else fail('(a3) short friend name: ' + JSON.stringify(names));
    if (byId.get(D) === 'Dune Four') ok('(a3) an ordinary proven name is untouched');
    else fail('(a3) clean friend name: ' + JSON.stringify(names));
  }

  // ---- (a4) A PANEL NAME IS ONE THE SERVER PROVED, IN ALL FOUR LISTS ---------
  // THE CRITICAL. profiles.callsign is written by the account itself on every
  // cloud save; uniqueness lives on callsign_key, which the client cannot write.
  // So a row with no key is free text, and free text in a panel is
  // impersonation: an account holding only a ROLLED name can put another
  // player's chosen callsign in its display column and render identically —
  // and a name report against what is on screen then names the wrong account.
  // 'FOLLOW ME OK' is the other half: clean, in class, in length, and nothing
  // anyone chose. Neither is stopped by the blocklist, because neither is a
  // blocked word. Both are stopped by asking the key.
  //
  // This is reachable: search hands out an id for any known callsign, and a
  // request puts the requester's name straight into the target's incoming list,
  // ten a minute. So the rule has to hold for friends, for BOTH request
  // directions and for the blocked list — every list the frame carries.
  {
    const FAKE = [
      { id: A, callsign: 'Anvil Six',    friend_code: 'ABC234', callsign_key: 'anvil six',   callsign_set_at: null },
      // A rolled account wearing A's own proven callsign. The panel must not
      // show two 'Anvil Six'es, and this is the row that has no right to it.
      { id: B, callsign: 'Anvil Six',    friend_code: 'BDF345', callsign_key: null,          callsign_set_at: null },
      // Clean, in class, in length — and the key says the server stored
      // something else entirely.
      { id: C, callsign: 'FOLLOW ME OK', friend_code: 'CGH456', callsign_key: 'crater two',  callsign_set_at: null },
      { id: D, callsign: 'Dune Four',    friend_code: 'DJK567', callsign_key: 'dune four',   callsign_set_at: null },
      { id: E, callsign: 'Echo Seven',   friend_code: 'EMN678', callsign_key: null,          callsign_set_at: null },
      { id: F, callsign: 'Anvil Six',    friend_code: 'FPQ789', callsign_key: null,          callsign_set_at: null },
    ];
    const st = memStore(FAKE);
    await st.addFriendship(A, B);       // the impersonator, as a friend
    await st.addFriendship(A, D);       // an honest, proven friend
    await st.addRequest(C, A);          // incoming: a name that reached A unasked
    await st.addRequest(A, E);          // outgoing: a rolled name
    await st.addBlock(A, F);            // and a second impersonator, blocked
    const S = mkSocial(st);
    const wa = mkws(A); S.onAuth(wa);
    await S.handle(wa, { type: 'friends' });
    const f = last(wa, 'friends') || {};
    const byId = new Map(((f.friends) || []).map((x) => [x.id, x.callsign]));
    if (byId.get(B) === null) ok('(a4) a rolled account wearing another player’s proven callsign is NOT named in the friends list');
    else fail('(a4) impersonated friend name: ' + JSON.stringify(f.friends));
    if (byId.get(B) !== f.callsign) ok('(a4) the impersonator cannot render as the viewer’s own chosen name');
    else fail('(a4) impersonation reached the panel: ' + JSON.stringify([byId.get(B), f.callsign]));
    if (byId.get(D) === 'Dune Four') ok('(a4) a friend whose row PROVES its name is still named, verbatim');
    else fail('(a4) proven friend name: ' + JSON.stringify(f.friends));
    const inc = ((f.requests || {}).in || [])[0];
    if (inc && inc.id === C && inc.callsign === null)
      ok('(a4) an INCOMING request — attacker-chosen text delivered to a stranger — is listed with no name at all');
    else fail('(a4) incoming request name: ' + JSON.stringify((f.requests || {}).in));
    const outg = ((f.requests || {}).out || [])[0];
    if (outg && outg.id === E && outg.callsign === null) ok('(a4) an OUTGOING request carries no unproven name either');
    else fail('(a4) outgoing request name: ' + JSON.stringify((f.requests || {}).out));
    const blk = (f.blocked || [])[0];
    if (blk && blk.id === F && blk.callsign === null) ok('(a4) the blocked list is no exception — the row stays, the name does not');
    else fail('(a4) blocked name: ' + JSON.stringify(f.blocked));
    // The ROW must survive so Task 8 still has something to hang Report and
    // Block on; dropping the entry would hide the person instead of the name.
    if ((f.friends || []).length === 2 && (f.blocked || []).length === 1)
      ok('(a4) an unprovable name empties the name, never the row');
    else fail('(a4) rows lost: ' + JSON.stringify([f.friends, f.blocked]));
  }

  // ---- (b) add by code is immediate and mutual (D2) --------------------------
  {
    const st = memStore(ROWS);
    const S = mkSocial(st);
    const wa = mkws(A), wa2 = mkws(A), wb = mkws(B), wc = mkws(C);
    S.onAuth(wa); S.onAuth(wa2); S.onAuth(wb); S.onAuth(wc);
    await S.handle(wa, { type: 'friend', op: 'add', code: 'fr-bdf345', id: 11 });
    const r = last(wa, 'friend');
    if (r && r.op === 'add' && r.ok === true && r.id === 11 && r.friend && r.friend.id === B
        && r.friend.callsign === 'Bunker Nine' && r.friend.online === true)
      ok('(b) add: the FR- prefix and lower case are accepted, the reply names the new friend');
    else fail('(b) add reply: ' + JSON.stringify(r));
    if (st.friends.has(pair(A, B)) && st.friends.size === 1) ok('(b) add: exactly one friendship row, in uuid order');
    else fail('(b) rows: ' + JSON.stringify([...st.friends]));
    if (sent(wa, 'friends').length === 1 && sent(wa2, 'friends').length === 1 && sent(wb, 'friends').length === 1)
      ok('(b) add: a fresh snapshot went to EVERY socket of both players');
    else fail(`(b) fan-out: A ${sent(wa, 'friends').length} + ${sent(wa2, 'friends').length}, B ${sent(wb, 'friends').length}`);
    if (!sent(wc, 'friends').length) ok('(b) add: a bystander is not fanned out to');
    else fail('(b) bystander got: ' + JSON.stringify(wc.rx));
    const snapB = last(wb, 'friends');
    if (snapB && snapB.friends.length === 1 && snapB.friends[0].id === A && snapB.id === undefined)
      ok('(b) add: B’s pushed snapshot lists A and carries no request id');
    else fail('(b) B snapshot: ' + JSON.stringify(snapB));
  }

  // ---- (a5) A ROLLED PAIR IS PROOF ENOUGH TO SHOW A NAME --------------------
  // Most players have never chosen a callsign, so a key-only rule would leave a
  // friends panel of blank rows — worse than the problem it fixed. A ROLLED name
  // is server-verifiable too: isGeneratedCallsign proves a string is one of the
  // curated adjective-and-noun pairs, which is a SELECTION FROM A FIXED LIST and
  // not attacker-chosen text, and it is the same test room-engine.js applies to
  // every name a client presents in a lobby. So two proofs — the key, or the
  // pair — and everything else is still null.
  {
    const ROLLED = [
      { id: A, callsign: 'Anvil Six',        friend_code: 'ABC234', callsign_key: 'anvil six', callsign_set_at: null },
      { id: B, callsign: 'Iron Ridge',       friend_code: 'BDF345', callsign_key: null, callsign_set_at: null },
      // Correct pair, sloppy spelling: NFC, trim and collapse are applied before
      // the test, so a decomposed or double-spaced copy of a real rolled name
      // does not cost that player their name. What comes back is the pair.
      { id: C, callsign: '  Rusty   Anvil ', friend_code: 'CGH456', callsign_key: null, callsign_set_at: null },
      { id: D, callsign: 'Steel Mesa',       friend_code: 'DJK567', callsign_key: null, callsign_set_at: null },
      { id: E, callsign: 'Frost Hawk',       friend_code: 'EMN678', callsign_key: null, callsign_set_at: null },
      // 'Sixty' is in neither list, so this is free text wearing the shape of a
      // pair — exactly what the test is for.
      { id: F, callsign: 'Iron Sixty',       friend_code: 'FPQ789', callsign_key: null, callsign_set_at: null },
    ];
    const st = memStore(ROLLED);
    await st.addFriendship(A, B);
    await st.addFriendship(A, C);
    await st.addRequest(D, A);
    await st.addRequest(A, F);
    await st.addBlock(A, E);
    const S = mkSocial(st);
    const wa = mkws(A); S.onAuth(wa);
    await S.handle(wa, { type: 'friends' });
    const f = last(wa, 'friends') || {};
    const byId = new Map(((f.friends) || []).map((x) => [x.id, x.callsign]));
    if (byId.get(B) === 'Iron Ridge') ok('(a5) a friend who only ever ROLLED a name is named in the panel');
    else fail('(a5) rolled friend: ' + JSON.stringify(f.friends));
    if (byId.get(C) === 'Rusty Anvil') ok('(a5) a sloppily spelled copy of a real pair is normalised, not blanked — and the PAIR is what is returned');
    else fail('(a5) normalised rolled friend: ' + JSON.stringify(f.friends));
    const inc = ((f.requests || {}).in || [])[0];
    if (inc && inc.id === D && inc.callsign === 'Steel Mesa') ok('(a5) an incoming request carries its rolled name');
    else fail('(a5) incoming: ' + JSON.stringify((f.requests || {}).in));
    const outg = ((f.requests || {}).out || [])[0];
    if (outg && outg.id === F && outg.callsign === null) ok('(a5) free text in the shape of a pair is still null — both halves must come from the lists');
    else fail('(a5) outgoing: ' + JSON.stringify((f.requests || {}).out));
    const blk = (f.blocked || [])[0];
    if (blk && blk.id === E && blk.callsign === 'Frost Hawk') ok('(a5) the blocked list is named too — all four lists take either proof');
    else fail('(a5) blocked: ' + JSON.stringify(f.blocked));

    // BINDING RESOLUTION 13 IS UNTOUCHED. The account's OWN `callsign` field is
    // the CHOSEN name and nothing else: null there is what makes the client
    // offer "Set callsign", so the second proof must not reach it. This is why
    // provenName was not itself widened.
    const st2 = memStore([{ id: A, callsign: 'Iron Ridge', friend_code: 'ABC234', callsign_key: null, callsign_set_at: null }]);
    const S2 = mkSocial(st2);
    const wa2 = mkws(A); S2.onAuth(wa2);
    await S2.handle(wa2, { type: 'friends' });
    if ((last(wa2, 'friends') || {}).callsign === null)
      ok('(a5) an account holding a ROLLED pair still reports its own callsign as null — the second proof is for OTHER people’s names only');
    else fail('(a5) own rolled callsign: ' + JSON.stringify(last(wa2, 'friends')));

    // THE IMPERSONATION QUESTION, ANSWERED IN A TEST. A rolled pair is not
    // unique and never was — two players can roll the same one, and the lobby
    // has always shown that collision — so wearing one is not a new weakness.
    // Wearing a CHOSEN name without its key must stay impossible, and 'Anvil
    // Six' is exactly that case: a real chosen name, not a rollable pair.
    const st3 = memStore([
      { id: A, callsign: 'Dune Four', friend_code: 'ABC234', callsign_key: 'dune four', callsign_set_at: null },
      { id: B, callsign: 'Anvil Six', friend_code: 'BDF345', callsign_key: null, callsign_set_at: null },
      { id: C, callsign: 'FOLLOW ME OK', friend_code: 'CGH456', callsign_key: null, callsign_set_at: null },
    ]);
    await st3.addFriendship(A, B);
    await st3.addFriendship(A, C);
    const S3 = mkSocial(st3);
    const wa3 = mkws(A); S3.onAuth(wa3);
    await S3.handle(wa3, { type: 'friends' });
    const names = new Map((((last(wa3, 'friends') || {}).friends) || []).map((x) => [x.id, x.callsign]));
    if (names.get(B) === null)
      ok('(a5) the second proof did NOT open the first: a chosen name that is not a rollable pair is still refused without its key');
    else fail('(a5) a chosen name was worn without the key: ' + JSON.stringify([...names]));
    if (names.get(C) === null) ok('(a5) and plain free text is still null, pair or no pair');
    else fail('(a5) free text reached the panel: ' + JSON.stringify([...names]));

    // THE PROFANITY GUARD ON THE SECOND PROOF, AND THE ONE CHECK THAT REACHES
    // IT. isProfane only ever runs on a string that is already a curated pair,
    // and none of the pairs the lists can produce is profane — measured here
    // over every pair rather than asserted from memory. So the guard blanks
    // nobody today, and THIS is the tripwire: add a word to either list that the
    // filter catches and this fails loudly, instead of that pair's players going
    // quietly nameless in every panel.
    const pairs = [];
    for (const adj of CALL_ADJ) for (const noun of CALL_NOUN) {
      const p = adj + ' ' + noun;
      if (isGeneratedCallsign(p)) pairs.push(p);
    }
    const profane = pairs.filter((p) => isProfane(p));
    if (pairs.length > 1000 && !profane.length)
      ok(`(a5) none of the ${pairs.length} rollable pairs is caught by the engine’s profanity filter — the guard costs no honest player their name`);
    else fail(`(a5) rollable pairs (${pairs.length}) caught by isProfane: ` + JSON.stringify(profane));
  }

  // ---- (b3) A BURST DRIVEN BY OTHER PEOPLE IS COLLAPSED ---------------------
  // A snapshot is eight PostgREST round trips and one frame per device, and the
  // player it is pushed to did not ask for it: the accepts come from other
  // accounts, spending other accounts' allowances. Ten friends accepting at once
  // cost the player at the other end ten snapshots and eighty round trips, on
  // nobody's bucket. The leading push still goes out IMMEDIATELY — a panel must
  // react to what the player just did — and the rest of the window collapses
  // into ONE trailing snapshot, built when it fires so it carries the newest
  // state rather than a stale one. Same shape as the presence debounce.
  {
    const prev = process.env.SOCIAL_PUSH_MS;
    process.env.SOCIAL_PUSH_MS = '60';
    const st = memStore(ROWS);
    const S = mkSocial(st);                        // reads the window at build time
    process.env.SOCIAL_PUSH_MS = prev;
    await st.addRequest(A, B); await st.addRequest(A, C); await st.addRequest(A, D);
    const wa1 = mkws(A), wa2 = mkws(A);            // the victim, on two devices
    const wb = mkws(B), wc = mkws(C), wd = mkws(D);
    S.onAuth(wa1); S.onAuth(wa2); S.onAuth(wb); S.onAuth(wc); S.onAuth(wd);
    await S.handle(wb, { type: 'friend', op: 'accept', from: A });
    if (sent(wa1, 'friends').length === 1 && sent(wa2, 'friends').length === 1)
      ok('(b3) the first accept reaches every device of the other player at once — the collapse is trailing, not leading');
    else fail(`(b3) leading push: ${sent(wa1, 'friends').length} + ${sent(wa2, 'friends').length}`);
    await S.handle(wc, { type: 'friend', op: 'accept', from: A });
    await S.handle(wd, { type: 'friend', op: 'accept', from: A });
    if (sent(wa1, 'friends').length === 1) ok('(b3) two more accepts inside the window add no further snapshot');
    else fail('(b3) burst not collapsed: ' + sent(wa1, 'friends').length);
    await sleep(150);
    const total = sent(wa1, 'friends').length;
    if (total === 2 && sent(wa2, 'friends').length === 2)
      ok('(b3) three accepts from three different people cost two snapshots per device, not three');
    else fail(`(b3) after the window: ${total} + ${sent(wa2, 'friends').length}`);
    const snap = last(wa1, 'friends');
    if (snap && (snap.friends || []).length === 3)
      ok('(b3) the trailing snapshot is built when it FIRES, so it carries all three and nothing is missed');
    else fail('(b3) trailing snapshot: ' + JSON.stringify(snap && snap.friends));
    // Each accepter is a different player and gets their own immediate push.
    if (sent(wb, 'friends').length === 1 && sent(wc, 'friends').length === 1 && sent(wd, 'friends').length === 1)
      ok('(b3) the collapse is per player: the three accepters each got their own snapshot straight away');
    else fail(`(b3) accepter pushes: ${sent(wb, 'friends').length}, ${sent(wc, 'friends').length}, ${sent(wd, 'friends').length}`);
  }

  // ---- (b4) a socket that throws mid-fan-out takes nothing with it ----------
  // The engine's send() raises on a half-closed socket. Inside a fan-out that
  // throw used to reach handleFriend's catch — which emitted
  // { op:'add', error:'unavailable' } AFTER the same client had been told
  // ok:true for an operation that really was written, and left the player's
  // other devices and the other player with no snapshot at all.
  {
    const st = memStore(ROWS);
    const S = mkSocial(st);
    const dead = mkws(A), live = mkws(A), wb = mkws(B);
    dead.rx.push = () => { throw new Error('write after end'); };
    S.onAuth(dead); S.onAuth(live); S.onAuth(wb);  // dead is first in the fan-out
    await S.handle(live, { type: 'friend', op: 'add', code: 'BDF345', id: 31 });
    const answers = live.rx.filter((m) => m.type === 'friend');
    if (answers.length === 1 && answers[0].ok === true)
      ok('(b4) one answer, and it is the true one — no failure frame after a success');
    else fail('(b4) answers: ' + JSON.stringify(answers));
    if (sent(live, 'friends').length === 1) ok('(b4) the player’s surviving device still got its snapshot');
    else fail('(b4) surviving device: ' + JSON.stringify(live.rx));
    if (sent(wb, 'friends').length === 1) ok('(b4) and so did the other player — one dead socket does not end the loop');
    else fail('(b4) other player: ' + JSON.stringify(wb.rx));
    if (st.friends.has(pair(A, B))) ok('(b4) the friendship the client was told about really is written');
    else fail('(b4) rows: ' + JSON.stringify([...st.friends]));
  }

  // ---- (c) add refused: self, unknown code, already, blocked either way ------
  {
    const st = memStore(ROWS);
    const S = mkSocial(st);
    const wa = mkws(A); S.onAuth(wa);
    await S.handle(wa, { type: 'friend', op: 'add', code: 'ABC234' });
    if ((last(wa, 'friend') || {}).error === 'self') ok('(c) add: your own code is self');
    else fail('(c) self: ' + JSON.stringify(last(wa, 'friend')));
    await S.handle(wa, { type: 'friend', op: 'add', code: 'ZZZ999' });
    if ((last(wa, 'friend') || {}).error === 'no_such_code') ok('(c) add: an unknown code is no_such_code');
    else fail('(c) unknown: ' + JSON.stringify(last(wa, 'friend')));
    st.calls.length = 0;
    await S.handle(wa, { type: 'friend', op: 'add', code: 'nope' });
    if ((last(wa, 'friend') || {}).error === 'no_such_code' && !st.calls.includes('profileByFriendCode'))
      ok('(c) add: a malformed code is refused without touching the store');
    else fail('(c) malformed: ' + JSON.stringify(last(wa, 'friend')) + ' calls ' + JSON.stringify(st.calls));
    await st.addFriendship(A, B);
    await S.handle(wa, { type: 'friend', op: 'add', code: 'BDF345' });
    if ((last(wa, 'friend') || {}).error === 'already') ok('(c) add: an existing friend is already');
    else fail('(c) already: ' + JSON.stringify(last(wa, 'friend')));
    await st.addBlock(A, C);
    await S.handle(wa, { type: 'friend', op: 'add', code: 'CGH456' });
    if ((last(wa, 'friend') || {}).error === 'blocked') ok('(c) add: someone you blocked is blocked');
    else fail('(c) blocked-by-me: ' + JSON.stringify(last(wa, 'friend')));
    await st.addBlock(D, A);
    await S.handle(wa, { type: 'friend', op: 'add', code: 'DJK567' });
    if ((last(wa, 'friend') || {}).error === 'blocked') ok('(c) add: someone who blocked YOU is blocked too');
    else fail('(c) blocked-me: ' + JSON.stringify(last(wa, 'friend')));
    if (st.friends.size === 1) ok('(c) add: not one refusal wrote a row');
    else fail('(c) rows after refusals: ' + JSON.stringify([...st.friends]));
  }

  // ---- (d) search is exact, unique, and respects blocks ----------------------
  {
    const st = memStore(ROWS);
    const S = mkSocial(st);
    const wa = mkws(A); S.onAuth(wa);
    await S.handle(wa, { type: 'friend', op: 'search', q: '  BUNKER   nine ', id: 4 });
    const hit = last(wa, 'friend');
    if (hit && hit.op === 'search' && hit.id === 4 && hit.results.length === 1
        && hit.results[0].id === B && hit.results[0].callsign === 'Bunker Nine')
      ok('(d) search: normalised and case-folded to the key, one result, the display form back');
    else fail('(d) search hit: ' + JSON.stringify(hit));
    // BINDING resolution 19: spec 5.5 draws the found player's tank in their own
    // paint, so the result has to carry one.
    if (hit && hit.results && hit.results[0] && 'skin' in hit.results[0] && hit.results[0].skin === 'gold')
      ok('(d) search: the result carries the paint (resolution 19)');
    else fail('(d) search skin: ' + JSON.stringify(hit && hit.results));
    await S.handle(wa, { type: 'friend', op: 'search', q: 'Crater Two' });
    const noskin = last(wa, 'friend');
    if (noskin.results && noskin.results.length === 1 && noskin.results[0].skin === null)
      ok('(d) search: a profile with no stored paint answers skin null, so the client falls back');
    else fail('(d) search missing skin: ' + JSON.stringify(noskin.results));
    await S.handle(wa, { type: 'friend', op: 'search', q: 'nobody here' });
    if (((last(wa, 'friend') || {}).results || null) && last(wa, 'friend').results.length === 0)
      ok('(d) search: a miss is an empty list, not an error');
    else fail('(d) search miss: ' + JSON.stringify(last(wa, 'friend')));
    await S.handle(wa, { type: 'friend', op: 'search', q: 'Anvil Six' });
    if (((last(wa, 'friend') || {}).results || []).length === 0) ok('(d) search: yourself is never a result');
    else fail('(d) self in search: ' + JSON.stringify(last(wa, 'friend')));
    st.calls.length = 0;
    await S.handle(wa, { type: 'friend', op: 'search', q: 'x' });
    if ((((last(wa, 'friend') || {}).results) || []).length === 0 && !st.calls.includes('profileByCallsignKey'))
      ok('(d) search: a query shorter than the minimum never reaches the store');
    else fail('(d) short query: ' + JSON.stringify(last(wa, 'friend')) + ' calls ' + JSON.stringify(st.calls));
    await st.addBlock(A, C);
    await S.handle(wa, { type: 'friend', op: 'search', q: 'Crater Two' });
    if (((last(wa, 'friend') || {}).results || []).length === 0) ok('(d) search: someone you blocked is absent');
    else fail('(d) blocked-by-me in search: ' + JSON.stringify(last(wa, 'friend')));
    await st.addBlock(D, A);
    await S.handle(wa, { type: 'friend', op: 'search', q: 'Dune Four' });
    if (((last(wa, 'friend') || {}).results || []).length === 0) ok('(d) search: someone who blocked YOU is absent');
    else fail('(d) blocked-me in search: ' + JSON.stringify(last(wa, 'friend')));
  }

  // ---- (d2) a search result is proven and its paint is checked --------------
  // profileByCallsignKey selects callsign_key alongside callsign, so unlike the
  // panel names this one CAN be proved, and is. `skin` is a client-written
  // value too: a paint id is a fixed vocabulary, so it is checked against it.
  {
    const ODD = [
      { id: A, callsign: 'Anvil Six',   friend_code: 'ABC234', callsign_key: 'anvil six',   callsign_set_at: null },
      { id: B, callsign: 'FOLLOW ME OK', friend_code: 'BDF345', callsign_key: 'bunker nine', callsign_set_at: null, skin: 'gold' },
      { id: C, callsign: 'Crater Two',  friend_code: 'CGH456', callsign_key: 'crater two',  callsign_set_at: null, skin: '../../etc/passwd' },
    ];
    const st = memStore(ODD);
    const S = mkSocial(st);
    const wa = mkws(A); S.onAuth(wa);
    await S.handle(wa, { type: 'friend', op: 'search', q: 'Bunker Nine' });
    const r1 = last(wa, 'friend');
    if (r1.results && r1.results.length === 1 && r1.results[0].id === B && r1.results[0].callsign === null)
      ok('(d2) search: a row whose callsign does not match its key is found but NOT named');
    else fail('(d2) tampered search name: ' + JSON.stringify(r1.results));
    await S.handle(wa, { type: 'friend', op: 'search', q: 'Crater Two' });
    const r2 = last(wa, 'friend');
    if (r2.results && r2.results.length === 1 && r2.results[0].skin === null)
      ok('(d2) search: a paint id outside the known set is dropped, never echoed to another client');
    else fail('(d2) junk skin: ' + JSON.stringify(r2.results));
  }

  // ---- (e) request, accept, decline, remove ---------------------------------
  {
    const st = memStore(ROWS);
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B);
    S.onAuth(wa); S.onAuth(wb);
    await S.handle(wa, { type: 'friend', op: 'request', to: B, id: 21 });
    const req = last(wa, 'friend');
    if (req && req.ok === true && req.state === 'requested' && req.id === 21 && st.requests.has(A + '>' + B))
      ok('(e) request: one row, state requested, the id echoed');
    else fail('(e) request: ' + JSON.stringify(req) + ' rows ' + JSON.stringify([...st.requests]));
    const snapB = last(wb, 'friends');
    if (snapB && snapB.requests.in.length === 1 && snapB.requests.in[0].id === A)
      ok('(e) request: B’s live socket got a snapshot showing the incoming request');
    else fail('(e) B snapshot: ' + JSON.stringify(snapB));
    await S.handle(wa, { type: 'friend', op: 'request', to: B });
    if ((last(wa, 'friend') || {}).error === 'already') ok('(e) request: asking twice is already');
    else fail('(e) double request: ' + JSON.stringify(last(wa, 'friend')));
    await S.handle(wa, { type: 'friend', op: 'request', to: A });
    if ((last(wa, 'friend') || {}).error === 'self') ok('(e) request: to yourself is self');
    else fail('(e) self request: ' + JSON.stringify(last(wa, 'friend')));
    await S.handle(wa, { type: 'friend', op: 'request', to: uid(99) });
    if ((last(wa, 'friend') || {}).error === 'no_such_user') ok('(e) request: an unknown id is no_such_user');
    else fail('(e) unknown request: ' + JSON.stringify(last(wa, 'friend')));
    st.calls.length = 0;
    await S.handle(wa, { type: 'friend', op: 'request', to: 'not-a-uuid' });
    if ((last(wa, 'friend') || {}).error === 'no_such_user' && !st.calls.includes('profileById'))
      ok('(e) request: an id that is not a uuid is refused without a query');
    else fail('(e) junk id request: ' + JSON.stringify(last(wa, 'friend')) + ' calls ' + JSON.stringify(st.calls));
    await S.handle(wb, { type: 'friend', op: 'accept', from: uid(99) });
    if ((last(wb, 'friend') || {}).error === 'no_such_request') ok('(e) accept: with no request pending, no_such_request');
    else fail('(e) empty accept: ' + JSON.stringify(last(wb, 'friend')));
    await S.handle(wb, { type: 'friend', op: 'accept', from: A });
    if ((last(wb, 'friend') || {}).ok === true && st.friends.has(pair(A, B)) && st.requests.size === 0)
      ok('(e) accept: friendship written, request gone');
    else fail('(e) accept: ' + JSON.stringify(last(wb, 'friend')) + ' rows ' + JSON.stringify([...st.friends]) + JSON.stringify([...st.requests]));
    await S.handle(wa, { type: 'friend', op: 'remove', id: B });
    if ((last(wa, 'friend') || {}).ok === true && st.friends.size === 0) ok('(e) remove: the friendship row is gone');
    else fail('(e) remove: ' + JSON.stringify(last(wa, 'friend')) + ' rows ' + JSON.stringify([...st.friends]));
    await S.handle(wa, { type: 'friend', op: 'remove', id: C });
    if ((last(wa, 'friend') || {}).error === 'no_such_user') ok('(e) remove: someone who is not a friend is no_such_user');
    else fail('(e) stray remove: ' + JSON.stringify(last(wa, 'friend')));
    // Postgres renders uuid lower-case, so every id the store hands back is
    // lower-case. An id that came off the wire in another case is the same
    // account and must compare equal, not silently miss every list here.
    await st.addFriendship(A, C);
    await S.handle(wa, { type: 'friend', op: 'remove', id: C.toUpperCase() });
    if ((last(wa, 'friend') || {}).ok === true && st.friends.size === 0)
      ok('(e) remove: an upper-case uuid off the wire still matches the account');
    else fail('(e) upper-case remove: ' + JSON.stringify(last(wa, 'friend')) + ' rows ' + JSON.stringify([...st.friends]));
    const wc = mkws(C); S.onAuth(wc);
    await S.handle(wa, { type: 'friend', op: 'request', to: C });
    await S.handle(wc, { type: 'friend', op: 'decline', from: A });
    if ((last(wc, 'friend') || {}).ok === true && st.requests.size === 0 && st.friends.size === 0)
      ok('(e) decline: the request is deleted and no friendship is written');
    else fail('(e) decline: ' + JSON.stringify([...st.requests]) + JSON.stringify([...st.friends]));
    st.calls.length = 0;
    await S.handle(wc, { type: 'friend', op: 'decline', from: D });
    if ((last(wc, 'friend') || {}).error === 'no_such_request' && !st.calls.includes('deleteRequest'))
      ok('(e) decline: a request nobody sent is no_such_request, and costs no write');
    else fail('(e) stray decline: ' + JSON.stringify(last(wc, 'friend')) + ' calls ' + JSON.stringify(st.calls));
  }

  // ---- (e2) a block beats a request that predates it -------------------------
  // The fifth route in. A request sent before a block is still sitting in the
  // panel afterwards, and accepting it would hand a blocked player a friendship
  // through the one op that never asks about blocks. Declining it must still
  // work — that is how the row gets cleared.
  {
    const st = memStore(ROWS);
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B);
    S.onAuth(wa); S.onAuth(wb);
    await st.addRequest(B, A);
    await st.addBlock(A, B);                        // A blocked B afterwards
    await S.handle(wa, { type: 'friend', op: 'accept', from: B });
    if ((last(wa, 'friend') || {}).error === 'blocked' && st.friends.size === 0)
      ok('(e2) accept: a pending request from someone you have since blocked is refused');
    else fail('(e2) accept while blocking: ' + JSON.stringify(last(wa, 'friend')) + ' rows ' + JSON.stringify([...st.friends]));
    const st2 = memStore(ROWS);
    const S2 = mkSocial(st2);
    const wa2 = mkws(A); S2.onAuth(wa2);
    await st2.addRequest(B, A);
    await st2.addBlock(B, A);                       // B blocked A afterwards
    await S2.handle(wa2, { type: 'friend', op: 'accept', from: B });
    if ((last(wa2, 'friend') || {}).error === 'blocked' && st2.friends.size === 0)
      ok('(e2) accept: a pending request from someone who has since blocked YOU is refused too');
    else fail('(e2) accept while blocked: ' + JSON.stringify(last(wa2, 'friend')) + ' rows ' + JSON.stringify([...st2.friends]));
    await S2.handle(wa2, { type: 'friend', op: 'decline', from: B });
    if ((last(wa2, 'friend') || {}).ok === true && st2.requests.size === 0)
      ok('(e2) decline: clearing the row still works — a block must not strand a request in the panel');
    else fail('(e2) decline while blocked: ' + JSON.stringify(last(wa2, 'friend')) + ' rows ' + JSON.stringify([...st2.requests]));
    // The other direction into the same wall: a fresh request, rather than one
    // that predates the block.
    const st3 = memStore(ROWS);
    const S3 = mkSocial(st3);
    const wa3 = mkws(A); S3.onAuth(wa3);
    await st3.addBlock(A, C);
    await S3.handle(wa3, { type: 'friend', op: 'request', to: C });
    if ((last(wa3, 'friend') || {}).error === 'blocked' && st3.requests.size === 0)
      ok('(e2) request: someone you blocked cannot be asked');
    else fail('(e2) request to blocked: ' + JSON.stringify(last(wa3, 'friend')) + ' rows ' + JSON.stringify([...st3.requests]));
    await st3.addBlock(D, A);
    await S3.handle(wa3, { type: 'friend', op: 'request', to: D });
    if ((last(wa3, 'friend') || {}).error === 'blocked' && st3.requests.size === 0)
      ok('(e2) request: someone who blocked YOU cannot be asked either');
    else fail('(e2) request to blocker: ' + JSON.stringify(last(wa3, 'friend')) + ' rows ' + JSON.stringify([...st3.requests]));
  }

  // ---- (e3) a blocked player is not in the panel, whatever the tables say ----
  // Task 6's block op is expected to delete the friendship and the requests as
  // it writes the row. This asserts the read model does not DEPEND on that: a
  // block is the last word even when the rows it should have removed survive.
  {
    const st = memStore(ROWS);
    await st.addFriendship(A, B);
    await st.addFriendship(A, C);
    await st.addRequest(D, A);          // incoming, from someone A then blocks
    await st.addRequest(A, E);          // outgoing, to someone who then blocks A
    await st.addBlock(A, B);            // A blocked a friend
    await st.addBlock(C, A);            // a friend blocked A
    await st.addBlock(A, D);
    await st.addBlock(E, A);
    const S = mkSocial(st);
    const wa = mkws(A); S.onAuth(wa);
    await S.handle(wa, { type: 'friends' });
    const f = last(wa, 'friends') || {};
    if ((f.friends || ['x']).length === 0) ok('(e3) a friendship that outlived a block is not listed as a friend, in either direction');
    else fail('(e3) blocked friend still listed: ' + JSON.stringify(f.friends));
    if ((f.requests || {}).in && f.requests.in.length === 0 && f.requests.out.length === 0)
      ok('(e3) a request that outlived a block is not listed either — that is them reaching you');
    else fail('(e3) blocked requests still listed: ' + JSON.stringify(f.requests));
    if ((f.blocked || []).length === 2 && f.blocked.every((x) => x.id === B || x.id === D))
      ok('(e3) the Blocked list itself is the one place they still appear');
    else fail('(e3) blocked list: ' + JSON.stringify(f.blocked));
  }

  // ---- (e4) a friend is never also a pending request ------------------------
  // THE RACE, AS THE PANEL RENDERS IT. Every op here is read-then-write with no
  // transaction, and one ordering survives its own recovery: an add-by-code
  // racing a request from the other side writes the friendship while the
  // request row stays, because each op read the relation before the other one
  // wrote it. (Two simultaneous requests produce two rows and no friendship,
  // which accept then clears — that ordering heals itself. This one does not.)
  // The state is CONSTRUCTED rather than raced, because a race that depends on
  // two microtask queues interleaving is not a test, it is a coin toss; what is
  // asserted is the rule that makes the state harmless wherever it came from.
  {
    const st = memStore(ROWS);
    await st.addFriendship(A, B);
    await st.addRequest(B, A);        // incoming, from someone who is now a friend
    await st.addFriendship(A, D);
    await st.addRequest(A, D);        // outgoing, to someone who is now a friend
    await st.addRequest(C, A);        // a genuine incoming request
    await st.addRequest(A, E);        // a genuine outgoing request
    const S = mkSocial(st);
    const wa = mkws(A); S.onAuth(wa);
    st.calls.length = 0;
    await S.handle(wa, { type: 'friends' });
    const f = last(wa, 'friends') || {};
    const ids = (f.friends || []).map((x) => x.id);
    if (ids.length === 2 && ids.includes(B) && ids.includes(D)) ok('(e4) both friendships are listed as friendships');
    else fail('(e4) friends: ' + JSON.stringify(f.friends));
    const inc = ((f.requests || {}).in || []).map((x) => x.id);
    if (inc.length === 1 && inc[0] === C) ok('(e4) an incoming request from someone who is ALREADY a friend is not rendered — the panel cannot show one person twice');
    else fail('(e4) incoming: ' + JSON.stringify(inc));
    const outg = ((f.requests || {}).out || []).map((x) => x.id);
    if (outg.length === 1 && outg[0] === E) ok('(e4) the outgoing direction is filtered the same way, and a real request survives both filters');
    else fail('(e4) outgoing: ' + JSON.stringify(outg));
    // The fix is a Set of ids the snapshot already holds. If it ever costs a
    // read, it is the wrong fix.
    if (st.calls.filter((c) => c === 'friendIdsOf').length === 1 && st.calls.length === 6)
      ok('(e4) the filter costs no extra store read — the friend ids were already in hand');
    else fail('(e4) store calls: ' + JSON.stringify(st.calls));
  }

  // ---- (f) a request to someone who already requested you ACCEPTS ------------
  {
    const st = memStore(ROWS);
    await st.addRequest(B, A);                      // B asked first
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B);
    S.onAuth(wa); S.onAuth(wb);
    await S.handle(wa, { type: 'friend', op: 'request', to: B });
    const r = last(wa, 'friend');
    if (r && r.ok === true && r.state === 'friends') ok('(f) mutual: the second request answers state friends, not requested');
    else fail('(f) mutual reply: ' + JSON.stringify(r));
    if (st.friends.has(pair(A, B)) && st.requests.size === 0) ok('(f) mutual: friendship written, both request rows cleared');
    else fail('(f) mutual rows: ' + JSON.stringify([...st.friends]) + JSON.stringify([...st.requests]));
    if (sent(wb, 'friends').length === 1 && (last(wb, 'friends').friends || []).length === 1)
      ok('(f) mutual: B learns without asking');
    else fail('(f) B fan-out: ' + JSON.stringify(wb.rx));
  }

  // ---- (g) presence reaches friends and nobody else --------------------------
  {
    const st = memStore(ROWS);
    await st.addFriendship(A, B);                  // C is a stranger to both
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B), wc = mkws(C);
    S.onAuth(wb); S.onAuth(wc);
    await sleep(120);                              // let B's and C's own arrivals flush
    wb.rx.length = 0; wc.rx.length = 0;
    S.onAuth(wa);
    // A tick, well inside the 40 ms window: long enough for every microtask a
    // flush would queue if it ran straight away, far short of the timer.
    await sleep(5);
    if (!sent(wb, 'presence').length) ok('(g) presence: nothing leaves inside the window');
    else fail('(g) presence fired early: ' + JSON.stringify(wb.rx));
    await sleep(120);
    const p = last(wb, 'presence');
    if (p && p.id === A && p.online === true) ok('(g) presence: A coming online reaches their friend B');
    else fail('(g) presence to friend: ' + JSON.stringify(wb.rx));
    if (!sent(wc, 'presence').length) ok('(g) presence: the stranger C hears nothing');
    else fail('(g) stranger got presence: ' + JSON.stringify(wc.rx));
    wb.rx.length = 0;
    S.onClose(wa);
    await sleep(120);
    const q = last(wb, 'presence');
    if (q && q.id === A && q.online === false) ok('(g) presence: A closing reaches B as offline');
    else fail('(g) offline frame: ' + JSON.stringify(wb.rx));
    wb.rx.length = 0;
    const wa2 = mkws(A), wa3 = mkws(A);
    S.onAuth(wa2); await sleep(120); wb.rx.length = 0;
    S.onAuth(wa3); S.onClose(wa3);                 // a SECOND socket opening and closing is not a change
    await sleep(120);
    if (!sent(wb, 'presence').length) ok('(g) presence: only the first and last socket of a player move presence');
    else fail('(g) second socket moved presence: ' + JSON.stringify(wb.rx));
    S.onClose(wa2);                                // A is offline again
    await sleep(120);
    const wa4 = mkws(A); S.onAuth(wa4);
    await sleep(120); wb.rx.length = 0;            // B knows A is online
    wa4.userId = null;                             // the sign-out hello clears it; the seat closes after
    S.onClose(wa4);
    await sleep(120);
    const z = last(wb, 'presence');
    if (z && z.id === A && z.online === false) ok('(g) presence: a socket that signed out still leaves the map');
    else fail('(g) after sign-out: ' + JSON.stringify(wb.rx));
  }

  // ---- (g2) a guest has no presence, in either direction ---------------------
  {
    const st = memStore(ROWS);
    await st.addFriendship(A, B);
    const S = mkSocial(st);
    const guest = mkws(C, true), wb = mkws(B);
    S.onAuth(wb); S.onAuth(guest);
    await sleep(120);
    if (S.online.size === 1 && S.online.has(B)) ok('(g2) an anonymous account gets no entry in the online map');
    else fail('(g2) online map: ' + JSON.stringify([...S.online.keys()]));
    if (!sent(wb, 'presence').length) ok('(g2) a guest arriving moves nobody’s presence');
    else fail('(g2) guest moved presence: ' + JSON.stringify(wb.rx));
    S.onClose(guest);
    await sleep(120);
    ok('(g2) closing a guest socket is a no-op');
  }

  // ---- (h) the debounce collapses a flap ------------------------------------
  {
    const st = memStore(ROWS);
    await st.addFriendship(A, B);
    const S = mkSocial(st);
    const wb = mkws(B); S.onAuth(wb);
    const wa1 = mkws(A); S.onAuth(wa1);
    await sleep(120);                              // B has been told A is online
    wb.rx.length = 0;
    S.onClose(wa1);                                // drops...
    const wa2 = mkws(A); S.onAuth(wa2);            // ...and is back inside the window
    await sleep(120);
    if (!sent(wb, 'presence').length) ok('(h) debounce: a drop and a reconnect inside the window collapse to nothing');
    else fail('(h) flap leaked: ' + JSON.stringify(wb.rx));
    wb.rx.length = 0;
    S.onClose(wa2);
    const wa3 = mkws(A); S.onAuth(wa3); S.onClose(wa3);   // ends OFFLINE inside the window
    await sleep(120);
    const frames = sent(wb, 'presence');
    if (frames.length === 1 && frames[0].online === false)
      ok('(h) debounce: exactly one frame, carrying the FINAL state of the flap');
    else fail('(h) flap end state: ' + JSON.stringify(frames));
  }

  // ---- (g3) PRESENCE IS NOT A ROUTE ROUND A BLOCK ---------------------------
  // The one open block route. The fan-out reads the FRIENDSHIP table, so a block
  // written without deleting the friendship — one forgotten line in the task that
  // adds the block op — turns presence into a live session signal about somebody
  // who blocked you, symmetrically, in both directions, with nothing in the
  // suite failing. This case constructs exactly that state: a block, and a
  // friendship row that outlived it. It is written to ENFORCE the dependency
  // rather than to document it — the only way to pass it is for this layer to
  // check the blocks itself, which flushPresence now does.
  {
    const st = memStore(ROWS);
    await st.addFriendship(A, B);
    await st.addFriendship(A, C);
    await st.addBlock(B, A);                       // B blocked A; the row survives
    const S = mkSocial(st);
    const wb = mkws(B), wc = mkws(C);
    S.onAuth(wb); S.onAuth(wc);
    await sleep(120);
    wb.rx.length = 0; wc.rx.length = 0;
    const wa = mkws(A); S.onAuth(wa);
    await sleep(120);
    if (!sent(wb, 'presence').length) ok('(g3) presence: a friendship that outlived a block delivers NOTHING to the blocker');
    else fail('(g3) presence reached a blocker: ' + JSON.stringify(wb.rx));
    if (sent(wc, 'presence').length === 1) ok('(g3) presence: an ordinary friend is unaffected by somebody else’s block');
    else fail('(g3) unblocked friend: ' + JSON.stringify(wc.rx));
    // AND THE OTHER DIRECTION. Blocking is not a mute: the player who blocked
    // must not be told about the player they blocked either.
    wb.rx.length = 0; wc.rx.length = 0;
    const wa2 = mkws(A);
    S.onClose(wa); S.onAuth(wa2);                  // settle A back to online
    await sleep(120);
    wb.rx.length = 0;
    S.onClose(wb);                                 // the blocker goes offline
    await sleep(120);
    if (!sent(wa2, 'presence').filter((m) => m.id === B).length)
      ok('(g3) presence: the player who was blocked hears nothing about the blocker either');
    else fail('(g3) presence reached the blocked player: ' + JSON.stringify(wa2.rx));
  }

  // ---- (h3) two flushes for one player cannot cross -------------------------
  // The timer handle is cleared BEFORE the read, so a change arriving while the
  // read is in flight schedules a second flush. Without a generation compared
  // after the read, the older flush can finish last and latch the wrong dot —
  // and it latches it for good, because it also records the state it sent as
  // the one friends were last told, so the collapse suppresses the correction.
  {
    const st = memStore(ROWS);
    await st.addFriendship(A, B);
    const S = mkSocial(st);
    const wb = mkws(B); S.onAuth(wb);
    await sleep(120); wb.rx.length = 0;
    const realIds = st.friendIdsOf;
    let stall = true;
    st.friendIdsOf = async (id) => { const v = await realIds(id); if (id === A && stall) { stall = false; await sleep(100); } return v; };
    const wa = mkws(A); S.onAuth(wa);              // flush 1 fires and stalls in its read
    await sleep(60);
    S.onClose(wa);                                 // A is gone before that read returns
    await sleep(200);
    const frames = sent(wb, 'presence');
    if (!frames.length) ok('(h3) a flush overtaken by a newer one says nothing — no stale dot is latched');
    else fail('(h3) a stale flush latched: ' + JSON.stringify(frames));
    const wa2 = mkws(A); S.onAuth(wa2);
    await sleep(120);
    if ((last(wb, 'presence') || {}).online === true)
      ok('(h3) the guard drops a frame, never the player: the next change is delivered normally');
    else fail('(h3) presence stopped working after the overtake: ' + JSON.stringify(wb.rx));
    S.onClose(wa2); await sleep(120);
  }

  // ---- (h4) in and out inside one window costs nothing -----------------------
  // The last state is SEEDED on first sight, because "nothing was ever said" and
  // "offline" are the same thing to a friend. Without the seed the flush finds
  // no entry, decides offline is a change, and pays a store read to broadcast an
  // offline dot for a player nobody was told about.
  {
    const st = memStore(ROWS);
    await st.addFriendship(A, B);
    const S = mkSocial(st);
    const wb = mkws(B); S.onAuth(wb);
    await sleep(120);
    wb.rx.length = 0; st.calls.length = 0;
    const wa = mkws(A); S.onAuth(wa); S.onClose(wa);
    await sleep(120);
    if (!sent(wb, 'presence').length) ok('(h4) a player who connects and drops inside one window is never announced');
    else fail('(h4) a never-announced player was announced: ' + JSON.stringify(wb.rx));
    if (!st.calls.length) ok('(h4) and it costs no store read at all');
    else fail('(h4) the flush read the database for a player nobody was told about: ' + JSON.stringify(st.calls));
  }

  // ---- (h5) the last-state map is bounded, like the online map beside it -----
  // One permanent entry per account that has ever come online is the same
  // unbounded growth dropping the empty Set in dropPresence exists to avoid.
  // Offline is the last thing there is to say about an account, so the entry
  // goes when it is said — and absent reads as offline, which is what the seed
  // in (h4) writes, so nothing is re-sent.
  {
    const st = memStore(ROWS);
    await st.addFriendship(A, B);
    const S = mkSocial(st);
    const wb = mkws(B); S.onAuth(wb);
    const wa = mkws(A); S.onAuth(wa);
    await sleep(120);
    if (S.presenceLast.get(A) === true && S.presenceLast.get(B) === true) ok('(h5) an online account is remembered while it is online');
    else fail('(h5) online states: ' + JSON.stringify([...S.presenceLast]));
    S.onClose(wa);
    await sleep(120);
    if (!S.presenceLast.has(A) && S.online.size === 1) ok('(h5) the entry is deleted once friends have been told the account is offline');
    else fail('(h5) after offline: ' + JSON.stringify([...S.presenceLast]));
    const wa2 = mkws(A); S.onAuth(wa2);
    await sleep(120);
    if ((last(wb, 'presence') || {}).online === true) ok('(h5) and coming back still reads as a change — the delete did not break the collapse');
    else fail('(h5) reconnect after delete: ' + JSON.stringify(wb.rx));
    S.onClose(wa2); S.onClose(wb);
    await sleep(120);
    if (S.presenceLast.size === 0 && S.online.size === 0) ok('(h5) with everyone gone both maps are empty, not one entry per account that ever connected');
    else fail('(h5) leftovers: ' + JSON.stringify([[...S.presenceLast], [...S.online.keys()]]));
  }

  // ---- (h2) the pending flush never holds the process open -------------------
  // A 2 s window means there is almost always a timer in flight when the last
  // socket goes, and a ref'd one keeps the event loop alive until it fires.
  // NOT BECAUSE OF THIS FILE: it ends with process.exit, which tears down a
  // ref'd timer without waiting, so the suite could never catch this by hanging
  // — the earlier version of this note claimed it could, and was wrong. The
  // handle is asserted DIRECTLY, here, because the thing that pays for it is the
  // production server, which holds one per account and exits on its own terms.
  {
    const prev = process.env.SOCIAL_PRESENCE_MS;
    process.env.SOCIAL_PRESENCE_MS = '30000';
    const S = mkSocial(memStore(ROWS));
    process.env.SOCIAL_PRESENCE_MS = prev;
    S.onAuth(mkws(A));                             // schedules a 30 s flush
    const active = process.getActiveResourcesInfo();
    if (!active.includes('Timeout')) ok('(h2) the pending presence flush is unref’d — it cannot keep the event loop alive');
    else fail('(h2) a pending presence flush is holding the process open: ' + JSON.stringify(active));
  }

  // ---- (i) ten friend ops a minute (design 4.2) -----------------------------
  {
    const st = memStore(ROWS);
    const S = mkSocial(st);
    const wa = mkws(A), wd = mkws(D);
    S.onAuth(wa); S.onAuth(wd);
    for (let i = 0; i < 10; i++) await S.handle(wa, { type: 'friend', op: 'search', q: 'nobody here' });
    const before = sent(wa, 'friend').filter((m) => m.error === 'slow_down').length;
    await S.handle(wa, { type: 'friend', op: 'search', q: 'nobody here' });
    const after = sent(wa, 'friend').filter((m) => m.error === 'slow_down').length;
    if (before === 0 && after === 1) ok('(i) rate limit: ten friend ops pass, the eleventh is slow_down');
    else fail(`(i) slow_down before ${before} after ${after}`);
    await S.handle(wd, { type: 'friend', op: 'search', q: 'nobody here' });
    if (!sent(wd, 'friend').filter((m) => m.error === 'slow_down').length)
      ok('(i) rate limit: the bucket is per socket, another player is unaffected');
    else fail('(i) other socket limited: ' + JSON.stringify(wd.rx));
    await S.handle(wa, { type: 'friend', op: 'remove', id: B });
    if ((last(wa, 'friend') || {}).error === 'no_such_user')
      ok('(i) rate limit: accept, decline and remove are not in the bucket');
    else fail('(i) remove while limited: ' + JSON.stringify(last(wa, 'friend')));
    CLOCK += 60001;
    await S.handle(wa, { type: 'friend', op: 'search', q: 'nobody here' });
    const l = last(wa, 'friend');
    if (l && l.op === 'search' && Array.isArray(l.results)) ok('(i) rate limit: the window slides, a minute later the bucket is clear');
    else fail('(i) after the minute: ' + JSON.stringify(l));
    CLOCK -= 60001;
  }

  // ---- (i2) the read model has a bucket of its own --------------------------
  // SIX STORE METHODS IS EIGHT ROUND TRIPS, not six: requestsOf makes two GETs
  // (and a DELETE on the turn of the hour) and blockIdsOf makes two. With no
  // limit, behind an engine socket limiter that allows 60 frames a second, one
  // signed-in client could aim ~480 PostgREST round trips a second at our own
  // database without sending a single write. The allowance is deliberately far
  // above any honest client — a panel opens, it does not poll. WHAT IT DOES NOT
  // DO: the bucket is on the SOCKET, so an account opening several sockets
  // multiplies it, and nothing here caps an account or the database.
  {
    const st = memStore(ROWS);
    const S = mkSocial(st);
    const wa = mkws(A); S.onAuth(wa);
    for (let i = 0; i < 20; i++) await S.handle(wa, { type: 'friends' });
    const before = sent(wa, 'friends').filter((m) => m.error).length;
    await S.handle(wa, { type: 'friends', id: 'over' });
    const l = last(wa, 'friends');
    if (before === 0 && l && l.error === 'slow_down' && l.id === 'over')
      ok('(i2) rate limit: twenty friends snapshots pass, the twenty-first is slow_down');
    else fail('(i2) friends bucket: ' + before + ' early errors, then ' + JSON.stringify(l));
    st.calls.length = 0;
    await S.handle(wa, { type: 'friends' });
    if (!st.calls.length) ok('(i2) rate limit: a refused snapshot costs the database nothing');
    else fail('(i2) refused snapshot still read: ' + JSON.stringify(st.calls));
    await S.handle(wa, { type: 'friend', op: 'search', q: 'Bunker Nine' });
    if (Array.isArray((last(wa, 'friend') || {}).results))
      ok('(i2) rate limit: the snapshot bucket is separate from the friend-op bucket');
    else fail('(i2) friend op starved by the snapshot bucket: ' + JSON.stringify(last(wa, 'friend')));
  }

  // ---- (i3) an op that does not exist is limited too -------------------------
  // It was answered ABOVE the rate check, which made it the one path in the
  // layer with no limit at all: {type:'friend', op:'x'} costs no store read, but
  // it costs a frame, every time, as fast as the socket limiter will carry it.
  {
    const st = memStore(ROWS);
    const S = mkSocial(st);
    const wa = mkws(A); S.onAuth(wa);
    for (let i = 0; i < 10; i++) await S.handle(wa, { type: 'friend', op: 'nonsense' });
    const before = sent(wa, 'friend').filter((m) => m.error === 'slow_down').length;
    await S.handle(wa, { type: 'friend', op: 'nonsense', id: 9 });
    const l = last(wa, 'friend') || {};
    if (before === 0 && l.error === 'slow_down' && l.op === 'nonsense' && l.id === 9)
      ok('(i3) an unknown op is answered ten times a minute, then slow_down — and the answer still names the op');
    else fail('(i3) unknown op bucket: ' + before + ' early errors, then ' + JSON.stringify(l));
    await S.handle(wa, { type: 'friend', op: 'search', q: 'Bunker Nine' });
    if ((last(wa, 'friend') || {}).error === 'slow_down')
      ok('(i3) it spent from the FRIEND bucket, not a bucket of its own — a misspelled op cannot buy extra searches');
    else fail('(i3) unknown ops had their own allowance: ' + JSON.stringify(last(wa, 'friend')));
    if (!st.calls.length) ok('(i3) and not one of the twelve reached the store');
    else fail('(i3) unknown op reached the store: ' + JSON.stringify(st.calls));
  }

  // ---- (j) a guest, and a store that is down --------------------------------
  {
    const st = memStore(ROWS);
    const S = mkSocial(st);
    // A GUEST HAS A REAL ACCOUNT ID. public/cloud.js mints an anonymous
    // Supabase account for anyone who saves anything, so a guard that reads
    // ws.userId alone waves this socket straight through (BINDING resolution 1).
    const g = mkws(uid(77), true);
    await S.handle(g, { type: 'friends', id: 3 });
    await S.handle(g, { type: 'friend', op: 'add', code: 'ABC234' });
    const two = g.rx.filter((m) => m.type === 'social' && m.error === 'sign_in');
    if (two.length === 2 && g.rx.length === 2) ok('(j) an ANONYMOUS account gets sign_in for both friend types and nothing else');
    else fail('(j) guest replies: ' + JSON.stringify(g.rx));
    if (!st.calls.length) ok('(j) a guest never reaches the store');
    else fail('(j) guest touched the store: ' + JSON.stringify(st.calls));
    const nobody = mkws(null);
    await S.handle(nobody, { type: 'friends', id: 4 });
    if ((last(nobody, 'social') || {}).error === 'sign_in') ok('(j) a socket that never said hello is refused too');
    else fail('(j) unauthenticated reply: ' + JSON.stringify(nobody.rx));

    const wa = mkws(A); S.onAuth(wa);
    st.boom.add('friendIdsOf');
    await S.handle(wa, { type: 'friends', id: 5 });
    const f = last(wa, 'friends');
    if (f && f.error === 'unavailable' && f.id === 5) ok('(j) a store fault answers unavailable, with the id, and the socket lives');
    else fail('(j) friends under fault: ' + JSON.stringify(f));
    if (!(f && (f.friends || f.requests || f.blocked))) ok('(j) an unavailable snapshot carries no empty list to render as "no friends"');
    else fail('(j) unavailable snapshot looks empty rather than broken: ' + JSON.stringify(f));
    await S.handle(wa, { type: 'friend', op: 'request', to: B });
    const r = last(wa, 'friend');
    if (r && r.op === 'request' && r.error === 'unavailable') ok('(j) a store fault inside an op answers unavailable too');
    else fail('(j) request under fault: ' + JSON.stringify(r));
    st.boom.clear();
    await S.handle(wa, { type: 'friend', op: 'nonsense' });
    if ((last(wa, 'friend') || {}).op === 'nonsense') ok('(j) an unknown op is answered, not ignored and not thrown');
    else fail('(j) unknown op: ' + JSON.stringify(last(wa, 'friend')));
    st.boom.add('friendIdsOf');
    wa.rx.length = 0;
    S.onClose(wa);
    await sleep(120);
    ok('(j) a store fault during a presence flush costs a frame, never a throw');
    st.boom.clear();
  }
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall social checks passed');
process.exit(out.errors.length ? 1 : 0);
