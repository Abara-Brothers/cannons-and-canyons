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

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };

// The engine's send(), copied rather than imported so this suite never loads
// the game engine (the original is public/room-engine.js:255-257).
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

  // HEX LETTERS ON PURPOSE. A fixture of digits alone makes toUpperCase() a
  // no-op, so the case-fold on ids arriving off the wire would have no test
  // that can fail — see the upper-case remove in (e).
  const uid = (n) => '00000000-0000-4000-8000-ab' + String(n).padStart(10, '0');
  const A = uid(1), B = uid(2), C = uid(3), D = uid(4), E = uid(5);
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
  // profilesByIds returns { id, callsign } ONLY, exactly as server/store.js does
  // (`select=id,callsign`): the read model gets no callsign_key for anyone but
  // the player themselves, which is why those names go through the filter
  // rather than through the key proof.
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
      async profilesByIds(ids) { st._hit('profilesByIds'); const m = new Map(); for (const id of ids) { const p = profiles.get(id); if (p) m.set(id, { id, callsign: p.callsign }); } return m; },
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

  // ---- (a3) every OTHER player's name goes through the filter ----------------
  // These names come from profilesByIds, which selects id,callsign and nothing
  // else — there is no callsign_key to prove them against. They are therefore
  // treated as what they are: a string the account itself wrote. The same
  // blocklist the callsign message enforces at set time is applied here at read
  // time, so a name PATCHed straight into the row cannot ride into a panel.
  {
    const DIRTY = [
      { id: A, callsign: 'Anvil Six',    friend_code: 'ABC234', callsign_key: 'anvil six', callsign_set_at: null },
      { id: B, callsign: 'Badword Nine', friend_code: 'BDF345', callsign_key: null,        callsign_set_at: null },
      { id: C, callsign: 'x',            friend_code: 'CGH456', callsign_key: null,        callsign_set_at: null },
      { id: D, callsign: 'Dune Four',    friend_code: 'DJK567', callsign_key: null,        callsign_set_at: null },
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
    if (byId.get(B) === null) ok('(a3) a friend whose PATCHed name carries a blocklist term is presented as null, not verbatim');
    else fail('(a3) dirty friend name: ' + JSON.stringify(names));
    if (byId.get(C) === null) ok('(a3) a name outside the length rules is null too, never a raw column value');
    else fail('(a3) short friend name: ' + JSON.stringify(names));
    if (byId.get(D) === 'Dune Four') ok('(a3) an ordinary rolled name is untouched');
    else fail('(a3) clean friend name: ' + JSON.stringify(names));
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

  // ---- (h2) the pending flush never holds the process open -------------------
  // A 2 s window means there is almost always a timer in flight when the last
  // socket goes. test/run-all.sh runs this file as a child process and waits
  // for it to EXIT; a ref'd timer would make the suite hang for the length of
  // the window at best, and a production server carries the same handle.
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
  // Six store reads per frame and no limit in design 4.2, behind an engine
  // socket limiter that allows 60 frames a second: one signed-in client could
  // aim ~360 PostgREST reads a second at our own database. The allowance is
  // deliberately far above any honest client — a panel opens, it does not poll.
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
