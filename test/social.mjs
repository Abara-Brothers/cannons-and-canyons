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
// What server/store.js ACTUALLY stores in a name_reports row: the clamp to the
// column's 16 characters and the sentinel for a player with no name. Imported
// rather than restated, because the whole point of (t6j) is that the handler's
// log line and the stored row are one string and not two that look alike.
import { NO_CALLSIGN, reportCallsign } from '../server/store.js';
// The look-alike readings server/name-index.js keeps, for the fake index below.
import { keyReadings } from '../server/callsign.js';

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

// ---- the blocked list carries NO account id ---------------------------------
// BINDING.md resolution 24 gives a lobby seat an opaque per-room handle so a
// modified client cannot correlate a player across matches. block add accepts
// that handle, and while the blocked list answered `{ id: <account uuid> }` the
// two composed into a converter: block every seat, list, read the uuids,
// unblock. Every row now carries an UNBLOCK KEY instead — 32 hex, scoped to the
// connection it was issued on — so these assertions check the SHAPE and the
// BEHAVIOUR (it lifts the right block) and never an identity the client is not
// entitled to. `bnames` exists because the callsign is what the old assertions
// were really about; the id they compared was the leak.
const isUnblockKey = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const keysOpaque = (list) => Array.isArray(list) && list.length > 0 && list.every((r) => r && isUnblockKey(r.id));
const bnames = (list) => (list || []).map((r) => (r ? JSON.stringify(r.callsign) : 'null')).sort().join(',');
const bkey = (list, callsign) => { const r = (list || []).find((x) => x && x.callsign === callsign); return r ? r.id : null; };
// Any uuid anywhere in a frame. The fixtures below are uuid-shaped for the
// accounts and short strings for the guest, so this is used where the ids in
// play really are uuids.
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
// THE NAME INDEX (round 2): an index that has loaded and holds no key, so a
// typed name is judged by the rules alone, as these sections expect. (nu)
// drives a held key, an index that has not loaded, and no index at all.
// `lookalikes` answers as server/name-index.js does, from the same readings
// (round 2 fix): the Set asks it, and an index without it refuses the Set.
const freeNames = () => {
  const keys = new Set();
  return {
    keys, state: (k) => (keys.has(k) ? 'taken' : 'free'), add: (k) => keys.add(k), remove: (k) => keys.delete(k),
    lookalikes: (r) => [...keys].filter((k) => keyReadings(k).includes(r)),
  };
};
const mk = (over) => { const store = mkstore(over); return { store, social: createSocial({ store, terms: TERMS, send, now, names: freeNames() }) }; };

// ---- (a) the frame types this layer owns ------------------------------------
{
  const want = ['friends', 'friend', 'block', 'callsign', 'report', 'squad', 'code'];
  if (SOCIAL_TYPES instanceof Set && want.every((t) => SOCIAL_TYPES.has(t)) && SOCIAL_TYPES.size === want.length)
    ok('(a) SOCIAL_TYPES is exactly the seven social frame types');
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
  // `wait` is new (owner, 2026-10-07: the editor says WHEN the next change is
  // allowed). This assertion pinned the refusal without it; it now pins the
  // exact milliseconds left, which one second inside the day is 1000.
  if (same(last(ws), { type: 'callsign', error: 'too_soon', wait: 1000 })) ok('(f) a second set one second inside 24 hours is refused, and says 1000 ms are left');
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

// ---- (f3) the refusal counts down from the server's own record -----------
// "You can change your name again in 7 hours" needs WHEN, and only the server
// knows when this account last set a name: a second device, or a reinstall,
// has nothing of its own to count from. So `wait` is what is left of the 24
// hours by the server's clock, measured from the stored callsign_set_at, and
// a later refusal says less than an earlier one.
{
  clock = BASE;
  const { store, social } = mk();
  const ws = mkws('u1');
  await social.handle(ws, { type: 'callsign', name: 'Wren Delacroix' });
  const waits = [];
  for (const h of [3, 17]) {
    clock = BASE + h * 3600000;
    await social.handle(ws, { type: 'callsign', name: 'Marguerite Vale', id: h });
    waits.push(last(ws));
  }
  if (same(waits, [{ type: 'callsign', error: 'too_soon', wait: DAY - 3 * 3600000, id: 3 },
                   { type: 'callsign', error: 'too_soon', wait: DAY - 17 * 3600000, id: 17 }]))
    ok('(f3) three hours in, 21 h are left; seventeen hours in, 7 h — measured from the stored set, by the server\'s clock');
  else fail('(f3) the countdown was ' + JSON.stringify(waits));
  if (store.rows.get('u1').callsign === 'Wren Delacroix') ok('(f3) and neither refusal wrote anything');
  else fail('(f3) a refused set changed the row: ' + JSON.stringify(store.rows.get('u1')));
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

// ---- (i4) a roll on one device does not leave another wearing the name -----
// ws.chosenName is the ONE door through which a string that is not a rolled pair
// reaches another player — public/room-engine.js's sanitizeName reads exactly
// this field. It is filled per SOCKET by server.js's auth sink, and
// store.clearCallsignKey frees the key for the whole ACCOUNT, so clearing only
// the socket that asked left every other live socket of that account presenting
// a callsign the account had just surrendered. The ordinary outcome is a player
// whose own name differs between their phone and their desktop; the sharp one is
// that somebody else then legitimately takes 'Wren Delacroix' and the stale
// socket shows THAT player's unique callsign to strangers — and a report against
// that seat records the '(no name)' sentinel, because seenName reads the profile
// and finds no key, which is the evidence mismatch BINDING 26 exists to prevent.
//
// socketsOf is how pushFriends has always fanned a panel out to a player's
// devices; the exemption simply never used it.
{
  clock = BASE;
  const { store, social } = mk();
  const phone = mkws('u1'), desktop = mkws('u1');
  social.onAuth(phone); social.onAuth(desktop);
  await social.handle(phone, { type: 'callsign', name: 'Wren Delacroix' });
  if (phone.chosenName === 'Wren Delacroix' && desktop.chosenName === 'Wren Delacroix')
    ok('(i4) a name SET on one device is presented by the other too — the account holds the key, so every one of its sockets may wear it');
  else fail('(i4) after a set: ' + JSON.stringify([phone.chosenName, desktop.chosenName]));
  clock = BASE + 1000;
  await social.handle(phone, { type: 'callsign', rolled: true });
  if (store.rows.get('u1').callsign_key === null) ok('(i4) the roll cleared the key for the account');
  else fail('(i4) the key survived the roll');
  if (phone.chosenName === null && desktop.chosenName === null)
    ok('(i4) and NEITHER socket may present the surrendered name — not just the one that rolled');
  else fail('(i4) a stale socket kept the surrendered name: ' + JSON.stringify([phone.chosenName, desktop.chosenName]));
  // A SOCKET OF A DIFFERENT ACCOUNT IS NOT TOUCHED, which is the other way a
  // loop over the wrong set fails: quietly, by stripping a name that is still
  // proven, so an innocent player is silently demoted to a rolled pair.
  clock = BASE + DAY + 1000;
  const other = mkws('u2');
  social.onAuth(other);
  await social.handle(other, { type: 'callsign', name: 'Marguerite Vale' });
  await social.handle(phone, { type: 'callsign', rolled: true });
  if (other.chosenName === 'Marguerite Vale') ok('(i4) another ACCOUNT\'s socket keeps its own chosen name through all of it');
  else fail('(i4) the fan-out reached another account: ' + JSON.stringify(other.chosenName));
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

// ---- (nc) THE NAME CHECK: every player may name themselves (2026-10-07) ----
// The owner: "the player is given a default name and then they can change it
// to whatever they like, as long as it stays within the guidelines". A guest
// has no account a chosen callsign could live on, so the device keeps the name
// and asks the server FIRST: {type:'callsign', op:'check', name}. The answer is
// the same test the room engine applies at the door (server.js installs its
// twin there), so what this says yes to is what a lobby shows. It stores
// nothing, reads nothing, is open to a socket with no account at all, spends
// the same 3-a-minute bucket a set does, and never says 'taken' — that would
// be a pre-auth oracle over every chosen callsign.
{
  // A fixture the engine's own lists refuse and this suite's two-term blocklist
  // does not: the check must apply BOTH, or a name it passes is renamed at the
  // lobby door. Derived from public/game-core.js at run time rather than
  // spelled here, the way test/security.mjs builds its gap fixture.
  const { readFileSync } = await import('node:fs');
  const coreSrc = readFileSync(new URL('../public/game-core.js', import.meta.url), 'utf8');
  const badWord = [...((coreSrc.match(/const BAD_WORD = \[([\s\S]*?)\];/) || [])[1] || '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const PROFANE = badWord.map((t) => `${t[0].toUpperCase()}${t.slice(1)} Ridge`)
    .find((n) => isProfane(n) && !TERMS.some((t) => n.toLowerCase().replace(/[^a-z]/g, '').includes(t)));
  if (!PROFANE) fail('(nc) no BAD_WORD term could be read out of public/game-core.js — the isProfane case below proves nothing');

  // 1. A socket with NO account at all, an anonymous guest and a linked account
  //    are all answered, normalised, with the id echoed — and nothing is stored.
  for (const [label, ws] of [['a socket with no account', mkws(null)], ['an anonymous guest', mkanon('anon-9')], ['a linked account', mkws('u1')]]) {
    clock = BASE;
    const { store, social } = mk();
    await social.handle(ws, { type: 'callsign', op: 'check', name: '  Tank   Ace ', id: 'n1' });
    if (same(last(ws), { type: 'callsign', op: 'check', ok: true, name: 'Tank Ace', id: 'n1' }) && store.calls.length === 0 && ws.chosenName === null)
      ok(`(nc) ${label}: a good name is answered ok, normalised to 'Tank Ace', with no store call and no door opened on the socket`);
    else fail(`(nc) ${label}: ` + JSON.stringify({ reply: last(ws), calls: store.calls, chosen: ws.chosenName }));
  }

  // 2. Every refusal carries its code, for the editor to say why.
  const CASES = [['ab', 'length'], ['x'.repeat(17), 'length'], ['Bad<name>', 'chars'], ['Badword Ridge', 'not_allowed']];
  if (PROFANE) CASES.push([PROFANE, 'not_allowed']);
  let bad = 0;
  for (const [name, error] of CASES) {
    clock = BASE;
    const { store, social } = mk();
    const ws = mkws(null);
    await social.handle(ws, { type: 'callsign', op: 'check', name, id: 2 });
    // Never the reply itself: an ok reply carries the name, and for the two
    // term fixtures that name IS the term (test/display_name.mjs's rule).
    if (!same(last(ws), { type: 'callsign', op: 'check', error, id: 2 }) || store.calls.length) { bad++; fail(`(nc) a ${[...name].length}-character name -> ` + JSON.stringify({ ok: last(ws).ok, error: last(ws).error, calls: store.calls.length })); }
  }
  if (!bad) ok(`(nc) ${CASES.length} refusals each carry their code: length (short and long), chars, the blocklist, and the engine's own isProfane list`);

  // 3. Three a minute, shared with a set: the check cannot probe the blocklist
  //    faster than a player types, and a linked account cannot get a fourth
  //    try at the day's set by mixing the two.
  clock = BASE;
  const { social } = mk();
  const g = mkws(null);
  const got = [];
  for (let i = 0; i < 4; i++) { await social.handle(g, { type: 'callsign', op: 'check', name: 'Tank Ace' }); got.push(last(g).ok ? 'ok' : last(g).error); }
  if (same(got, ['ok', 'ok', 'ok', 'slow_down']) && same(last(g), { type: 'callsign', op: 'check', error: 'slow_down' }))
    ok('(nc) the fourth check in a minute is slow_down');
  else fail('(nc) four checks gave ' + JSON.stringify(got) + ' last ' + JSON.stringify(last(g)));
  const l = mkws('u3');
  for (let i = 0; i < 3; i++) await social.handle(l, { type: 'callsign', op: 'check', name: 'Tank Ace' });
  await social.handle(l, { type: 'callsign', name: 'Wren Delacroix' });
  if (last(l).error === 'slow_down') ok('(nc) the check and the set spend ONE bucket');
  else fail('(nc) a set after three checks gave ' + JSON.stringify(last(l)));

  // 4. The op is the ONLY callsign op a guest may use: a set without it is
  //    still refused sign_in, so naming a guest never stores anything.
  const anon = mkanon('anon-10');
  const { store: st2, social: so2 } = mk();
  await so2.handle(anon, { type: 'callsign', name: 'Tank Ace', id: 4 });
  if (same(last(anon), { type: 'social', error: 'sign_in', id: 4 }) && st2.calls.length === 0)
    ok('(nc) a guest\'s SET is still refused sign_in — only the check is open');
  else fail('(nc) guest set gave ' + JSON.stringify(last(anon)));

  // 5. A wiring fault answers, never crashes: the same fail-closed TypeError as
  //    (e2), through the same net.
  const broken = createSocial({ store: mkstore(), terms: new Set(TERMS), send, now });
  const bw = mkws(null);
  let threw = null;
  try { await broken.handle(bw, { type: 'callsign', op: 'check', name: 'Tank Ace', id: 5 }); } catch (e) { threw = e; }
  if (!threw && same(last(bw), { type: 'callsign', error: 'unavailable', id: 5 })) ok('(nc) a check on a mis-wired layer answers unavailable, not a crash');
  else fail('(nc) mis-wired check: ' + (threw ? threw.message : JSON.stringify(last(bw))));
}

// ---- (nu) NAMES, ROUND 2 (2026-10-08) ---------------------------------------
// Three rules the round-2 review found missing. (1) A name a guest checks may
// not be an account's chosen callsign: the check answers 'taken' from the
// in-memory index (server/name-index.js), with no store call, and refuses
// 'unavailable' while the index knows nothing (and with no index wired at
// all). (2) The signed-in Set meets the guest's rules: the engine's isProfane
// and the game's own names are refused not_allowed BEFORE any store call,
// where validateCallsign alone used to let them be stored. (3) The index
// follows the Set and the roll: a key set is taken at once, the key it
// replaced and a key rolled away are free again.
{
  const { readFileSync } = await import('node:fs');
  const { createNameIndex } = await import('../server/name-index.js');
  const coreSrc = readFileSync(new URL('../public/game-core.js', import.meta.url), 'utf8');
  const badWord = [...((coreSrc.match(/const BAD_SUB = \[([\s\S]*?)\];/) || [])[1] || '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  // A slur the engine's list refuses and this suite's two-term list passes, in
  // the shape a player types ('<Term> Tank'): the Set used to store it.
  const PROFANE = badWord.map((t) => `${t[0].toUpperCase()}${t.slice(1)} Tank`)
    .find((n) => [...n].length <= 16 && isProfane(n) && !TERMS.some((t) => n.toLowerCase().replace(/[^a-z]/g, '').includes(t)));
  if (!PROFANE) fail('(nu) no BAD_SUB term could be read out of public/game-core.js -- the Set\'s isProfane case proves nothing');
  // 1. THE CHECK, against a held key, an index that has not loaded, and none.
  clock = BASE;
  const names = createNameIndex({ load: async (after) => (after === null ? ['viper'] : []) });
  await names.refresh();
  const st1 = mkstore();
  const S1 = createSocial({ store: st1, terms: TERMS, send, now, names });
  const g1 = mkws(null);
  await S1.handle(g1, { type: 'callsign', op: 'check', name: '  VIPER ', id: 'h' });
  const held = last(g1);
  await S1.handle(g1, { type: 'callsign', op: 'check', name: 'CPU Hard', id: 'b' });
  const bot = last(g1);
  const g2 = mkws(null);
  await S1.handle(g2, { type: 'callsign', op: 'check', name: 'Tank Ace', id: 'f' });
  const free = last(g2);
  const unloaded = createSocial({ store: mkstore(), terms: TERMS, send, now, names: createNameIndex({ load: async () => [] }) });
  const none = createSocial({ store: mkstore(), terms: TERMS, send, now });
  const g3 = mkws(null), g4 = mkws(null);
  await unloaded.handle(g3, { type: 'callsign', op: 'check', name: 'Tank Ace', id: 'u' });
  await none.handle(g4, { type: 'callsign', op: 'check', name: 'Tank Ace', id: 'n' });
  if (same(held, { type: 'callsign', op: 'check', error: 'taken', id: 'h' }) && same(bot, { type: 'callsign', op: 'check', error: 'not_allowed', id: 'b' })
      && same(free, { type: 'callsign', op: 'check', ok: true, name: 'Tank Ace', id: 'f' }) && st1.calls.length === 0
      && same(last(g3), { type: 'callsign', op: 'check', error: 'unavailable', id: 'u' }) && same(last(g4), { type: 'callsign', op: 'check', error: 'unavailable', id: 'n' }))
    ok("(nu) a guest's check of an account's chosen callsign is 'taken', a computer's name is not_allowed, both from memory with no store call; an index that has not loaded and no index at all answer 'unavailable'");
  else fail('(nu) check: ' + JSON.stringify({ held, bot, free, calls: st1.calls, u: last(g3), n: last(g4) }));
  // 2. THE SIGNED-IN SET MEETS THE SAME RULES, before the store.
  const st2 = mkstore();
  const N2 = freeNames();
  const S2 = createSocial({ store: st2, terms: TERMS, send, now, names: N2 });
  const refused = [];
  for (const [name, id] of [[PROFANE, 'p'], ['CPU Hard', 'c'], ['Warlord 7', 'w']]) {
    clock = BASE;
    const w = mkws('u-set-' + id);
    await S2.handle(w, { type: 'callsign', name, id });
    if (!(same(last(w), { type: 'callsign', error: 'not_allowed', id }) && w.chosenName === null)) refused.push({ name: name === PROFANE ? 'the BAD_SUB fixture' : name, reply: last(w) });
  }
  if (PROFANE && !refused.length && st2.calls.length === 0 && N2.keys.size === 0)
    ok("(nu) a signed-in Set of an isProfane name the blocklist passes, and of a computer's name, is refused not_allowed before the store, exactly as a guest's check is");
  else fail('(nu) signed-in Set rules: ' + JSON.stringify({ refused, calls: st2.calls, keys: [...N2.keys] }));
  // 3. THE INDEX FOLLOWS THE WRITES: set, change, roll.
  clock = BASE;
  const st3 = mkstore();
  const N3 = createNameIndex({ load: async () => [] });
  await N3.refresh();
  const S3 = createSocial({ store: st3, terms: TERMS, send, now, names: N3 });
  const owner = mkws('u-owner'), guest = mkws(null);
  const check = async (name) => { clock += 61000; await S3.handle(guest, { type: 'callsign', op: 'check', name }); return last(guest).ok ? 'ok' : last(guest).error; };
  await S3.handle(owner, { type: 'callsign', name: 'Wren Hollow' });
  const afterSet = [N3.state('wren hollow'), await check('Wren Hollow')];
  clock += DAY + 1;
  await S3.handle(owner, { type: 'callsign', name: 'Kestrel Bay' });
  const afterChange = [N3.state('wren hollow'), N3.state('kestrel bay'), await check('Wren Hollow'), await check('Kestrel Bay')];
  await S3.handle(owner, { type: 'callsign', rolled: true });
  const afterRoll = [N3.state('kestrel bay'), await check('Kestrel Bay')];
  if (same(afterSet, ['taken', 'taken']) && same(afterChange, ['free', 'taken', 'ok', 'taken']) && same(afterRoll, ['free', 'ok']))
    ok("(nu) a Set takes its key in the index at once, a change frees the key it replaced, and an old build's roll frees the key it gave up: a guest's check follows each");
  else fail('(nu) index follows writes: ' + JSON.stringify({ afterSet, afterChange, afterRoll }));
  // 4. A REFUSED SET TOUCHES NOTHING: 'taken' by the store leaves the index as it was.
  clock = BASE;
  const st4 = mkstore();
  st4.keys.set('wren hollow', 'someone-else');
  const N4 = freeNames();
  const S4 = createSocial({ store: st4, terms: TERMS, send, now, names: N4 });
  const w4 = mkws('u-loser');
  await S4.handle(w4, { type: 'callsign', name: 'Wren Hollow', id: 't' });
  if (same(last(w4), { type: 'callsign', error: 'taken', id: 't' }) && N4.keys.size === 0)
    ok("(nu) a Set the store refuses 'taken' changes nothing in the index: only a write that landed moves it");
  else fail('(nu) refused set: ' + JSON.stringify({ reply: last(w4), keys: [...N4.keys] }));
}

// ---- (nl) THE SET REFUSES ANOTHER ACCOUNT'S NAME TO THE EYE (round 2 fix) ----
// The unique index compares keys, so a fullwidth copy of a held name, or a
// whole-Cyrillic name that reads as one, used to be stored as a key of its
// own. The Set now refuses a mixed-script name 'chars' before any store call,
// and a name whose look-alike skeleton reads as ANOTHER account's key 'taken'
// before the write, from the in-memory index. The account's own key is not a
// collision, a legitimate single-script name is stored, and an index that has
// not loaded refuses 'unavailable'. Code points as escapes, for the reason
// test/display_name.mjs (13) gives.
{
  const { createNameIndex } = await import('../server/name-index.js');
  const cp = (...c) => String.fromCodePoint(...c);
  const FULL = cp(0xFF36, 0xFF49, 0xFF50, 0xFF45, 0xFF52);         // fullwidth Viper
  const COCO = cp(0x0421, 0x043E, 0x0441, 0x043E);                 // Cyrillic, reads Coco
  const VIRER = 'Vi' + cp(0x0440) + 'er';                          // Cyrillic er inside Latin
  const IVAN = cp(0x0418, 0x0432, 0x0430, 0x043D) + ' ' + cp(0x041F, 0x0435, 0x0442, 0x0440, 0x043E, 0x0432);
  const st = mkstore();
  st.keys.set('viper', 'u-other-1'); st.keys.set('coco', 'u-other-2');
  st.rows.set('u-coco', { id: 'u-coco', friend_code: 'COC234', callsign: 'Coco Two', callsign_key: 'coco two', callsign_set_at: null });
  const N = createNameIndex({ load: async (after) => (after === null ? ['coco', 'coco two', 'viper'] : []) });
  await N.refresh();
  const S = createSocial({ store: st, terms: TERMS, send, now, names: N });
  const run = async (who, name, id) => { clock = BASE + DAY * 10; const w = mkws(who); const before = st.calls.length; await S.handle(w, { type: 'callsign', name, id }); return { reply: last(w), calls: st.calls.slice(before).map((c) => c[0]), chosen: w.chosenName }; };
  const full = await run('u-a', FULL, 'f');
  const coco = await run('u-b', COCO, 'c');
  const mixed = await run('u-c', VIRER, 'm');
  const ivan = await run('u-d', IVAN, 'i');
  if (same(full.reply, { type: 'callsign', error: 'taken', id: 'f' }) && same(full.calls, ['profileById']) && full.chosen === null
      && same(coco.reply, { type: 'callsign', error: 'taken', id: 'c' }) && same(coco.calls, ['profileById'])
      && same(mixed.reply, { type: 'callsign', error: 'chars', id: 'm' }) && same(mixed.calls, [])
      && same(ivan.reply, { type: 'callsign', ok: true, callsign: IVAN, id: 'i' }) && same(ivan.calls, ['profileById', 'setChosenCallsign']) && N.state(IVAN.toLowerCase()) === 'taken')
    ok("(nl) the Set refuses a fullwidth copy and a whole-Cyrillic look-alike of another account's callsign 'taken' with no write, a mixed-script name 'chars' with no store call, and stores a legitimate Cyrillic name");
  else fail('(nl) look-alike Set: ' + JSON.stringify({ full, coco, mixed, ivan }));
  // THE ACCOUNT'S OWN KEY IS NOT A COLLISION: re-casing its own name passes.
  const own = await run('u-coco', 'COCO TWO', 'o');
  if (same(own.reply, { type: 'callsign', ok: true, callsign: 'COCO TWO', id: 'o' }) && same(own.calls, ['profileById', 'setChosenCallsign']))
    ok("(nl) an account re-casing its own callsign is not refused: its own key is not a look-alike of somebody else's");
  else fail('(nl) own key: ' + JSON.stringify(own));
  // AN INDEX THAT HAS NOT LOADED, or none at all, refuses the Set 'unavailable'.
  const S2 = createSocial({ store: mkstore(), terms: TERMS, send, now, names: createNameIndex({ load: async () => [] }) });
  const S3 = createSocial({ store: mkstore(), terms: TERMS, send, now });
  const w2 = mkws('u-x'), w3 = mkws('u-y');
  clock = BASE;
  await S2.handle(w2, { type: 'callsign', name: 'Tank Ace', id: 'u' });
  await S3.handle(w3, { type: 'callsign', name: 'Tank Ace', id: 'n' });
  if (same(last(w2), { type: 'callsign', error: 'unavailable', id: 'u' }) && same(last(w3), { type: 'callsign', error: 'unavailable', id: 'n' }) && w2.chosenName === null && w3.chosenName === null)
    ok("(nl) with the index not loaded, or no index wired, the Set refuses 'unavailable' rather than store a name it could not compare");
  else fail('(nl) fail closed: ' + JSON.stringify({ u: last(w2), n: last(w3) }));
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
      // Task 6: the rows a report writes, and every `since` the handler asked
      // for — the once-a-day window is a value this suite has to be able to read.
      reports: [], sinceSeen: [],
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
      async addReport(reporter, reported, callsign) { st._hit('addReport'); st.reports.push({ reporter, reported, callsign, at: CLOCK }); },
      async reportedSince(reporter, reported, since) {
        st._hit('reportedSince');
        st.sinceSeen.push(since);
        const t = Date.parse(since);
        return st.reports.some((r) => r.reporter === reporter && r.reported === reported && r.at >= t);
      },
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
    if (f && f.blocked && f.blocked.length === 1 && f.blocked[0].callsign === 'Echo Seven' && keysOpaque(f.blocked))
      ok('(a) friends: the blocked list is named too, and its id is an opaque unblock key rather than the account');
    else fail('(a) blocked: ' + JSON.stringify(f && f.blocked));
    if (f && f.blocked && !f.blocked.some((r) => r.id === E))
      ok('(a) friends: and E\'s account id is NOT in it — the one list a stranger can reach never carries one');
    else fail('(a) the blocked list carried an account id: ' + JSON.stringify(f && f.blocked));
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
    if (blk && blk.callsign === null && isUnblockKey(blk.id)) ok('(a4) the blocked list is no exception — the row stays, the name does not');
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
    if (blk && blk.callsign === 'Frost Hawk' && isUnblockKey(blk.id)) ok('(a5) the blocked list is named too — all four lists take either proof');
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
    if ((last(wa, 'friend') || {}).error === 'no_such_code') ok('(c) add: someone who blocked YOU is refused as an unknown code is, no_such_code (D-BLOCK-4)');
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
    if ((last(wa2, 'friend') || {}).error === 'no_such_request' && st2.friends.size === 0)
      ok('(e2) accept: a pending request from someone who has since blocked YOU is refused too, as a request that is gone (D-BLOCK-4)');
    else fail('(e2) accept while blocked: ' + JSON.stringify(last(wa2, 'friend')) + ' rows ' + JSON.stringify([...st2.friends]));
    // The panel does not show this row (e3): their block hides it. So decline
    // answers it as a request that is gone, and still clears the row, so
    // nothing is stranded in the table either (dc).
    await S2.handle(wa2, { type: 'friend', op: 'decline', from: B });
    if ((last(wa2, 'friend') || {}).error === 'no_such_request' && st2.requests.size === 0)
      ok('(e2) decline: a request their block hides from the panel is no_such_request, as one that is gone, and the row is still cleared');
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
    if ((last(wa3, 'friend') || {}).error === 'no_such_user' && st3.requests.size === 0)
      ok('(e2) request: someone who blocked YOU cannot be asked either, and is refused as no_such_user (D-BLOCK-4)');
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
    if ((f.blocked || []).length === 2 && bnames(f.blocked) === bnames([{ callsign: 'Bunker Nine' }, { callsign: 'Dune Four' }]) && keysOpaque(f.blocked))
      ok('(e3) the Blocked list itself is the one place they still appear — by name, behind an opaque unblock key');
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

  // =========================================================================
  // TASK 6 — BLOCKS AND NAME REPORTS.
  //
  // WHY THIS EXISTS: these are the two acts the whole project rests on. Apple
  // Guideline 1.2 asks for a mechanism to report objectionable content and the
  // ability to block abusive users, and public/game-core.js's ISSUE-015 is
  // being REVERSED on the strength of them — so a silent failure here is not a
  // bug report, it is a rejected build and a player with no way out.
  //
  // Four silent failures matter. A block that leaves the friendship behind, so
  // the blocked player is still in the box. A block that leaves a pending
  // request behind, so the same person walks back in the moment it is
  // accepted. An unblock that quietly hands the friendship back, which nobody
  // asked for. And a report whose row carries a name the reporter never saw —
  // profiles.callsign is PATCHed by the account ITSELF, so a row trusted here
  // is a moderation table full of whatever the reported player typed, and a
  // server log line they wrote.
  //
  // Reuses this block's memStore / mkws / mkSocial harness rather than building
  // a second one, which is the follow-up the task brief asked for in its own
  // note 3. SOCIAL_PUSH_MS is already '0' above, so every snapshot this section
  // asserts on has arrived by the next await.
  const T6 = {
    // A player who has NEVER chosen a callsign: profiles.callsign is nullable
    // and this is the ordinary state of the table, not an edge case.
    nameless: { id: uid(21), callsign: null, friend_code: 'NPQ789', callsign_key: null, callsign_set_at: null },
    // A row whose display column holds free text with NO key beside it — what
    // profiles_update_own lets any account write to itself. It passes the
    // character class, the length and the blocklist, and it is still a string
    // no player was ever shown.
    tampered: { id: uid(22), callsign: 'FOLLOW ME OK', friend_code: 'TPQ790', callsign_key: null, callsign_set_at: null },
    // A ROLLED pair, which is server-verifiable by the second proof: a
    // selection from two curated lists, not authored text.
    rolled: { id: uid(24), callsign: 'Iron Ridge', friend_code: 'RPQ791', callsign_key: null, callsign_set_at: null },
  };
  const T6_ROWS = [...ROWS, T6.nameless, T6.tampered, T6.rolled];
  const NAMELESS = T6.nameless.id, TAMPERED = T6.tampered.id, ROLLED = T6.rolled.id;
  // A REAL ANONYMOUS ACCOUNT, not a missing id. public/cloud.js mints one for
  // every player who saves anything, so this — a real uuid with isGuest true —
  // is the guest that actually arrives. A gate reading only "is there an id"
  // waves it through, which is CORRECT for report and block and wrong for
  // everything else; (t6i) proves both halves on the SAME socket.
  const GUEST = uid(23);
  // Captures console.log for the length of one handler call and no longer:
  // ok() writes to console.log too, so a wider capture eats the suite's own
  // output and the run goes quiet.
  async function withLog(fn) {
    const lines = [];
    const real = console.log;
    console.log = (...a) => { lines.push(a.map(String).join(' ')); };
    try { await fn(); } finally { console.log = real; }
    return lines.filter((l) => l.startsWith('[report] '));
  }

  // ---- (t6a) block add tears down everything the pair had -------------------
  // The row is the easy half. The teardown is the half that is one forgotten
  // line away from not being there, and NEITHER (e3) NOR (g3) CATCHES IT —
  // both of those construct the surviving state on purpose and assert that the
  // read model and the presence fan-out defend themselves anyway. They removed
  // the dependency; they did not enforce it. This case is the one that fails
  // if the block op writes its row and stops.
  {
    const st = memStore(T6_ROWS);
    await st.addFriendship(A, B);
    await st.addRequest(A, B);              // a stale request each way
    await st.addRequest(B, A);
    await st.addRequest(C, A);              // unrelated: must survive
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B);
    S.onAuth(wa); S.onAuth(wb);
    wa.rx.length = 0; wb.rx.length = 0;
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    const r = last(wa, 'block');
    if (r && r.op === 'add' && r.ok === true) ok('(t6a) block add: ok:true to the blocker');
    else fail('(t6a) block add replied ' + JSON.stringify(r));
    if (st.blocks.has(A + '>' + B) && st.blocks.size === 1) ok('(t6a) block add: one row, and the CALLER is the blocker');
    else fail('(t6a) block rows: ' + JSON.stringify([...st.blocks]));
    if (st.friends.size === 0) ok('(t6a) block add: the friendship is gone');
    else fail('(t6a) block add left the friendship: ' + JSON.stringify([...st.friends]));
    if (st.requests.size === 1 && st.requests.has(C + '>' + A))
      ok('(t6a) block add: both requests between the pair are deleted, the unrelated one is kept');
    else fail('(t6a) block add requests: ' + JSON.stringify([...st.requests]));
    if (last(wa, 'friends')) ok('(t6a) block add: a fresh snapshot to the blocker');
    else fail('(t6a) block add: no snapshot to the blocker');
    const bs = last(wb, 'friends');
    if (bs && Array.isArray(bs.friends) && bs.friends.length === 0)
      ok('(t6a) block add: the blocked player is pushed a snapshot with the friendship gone, and is told nothing about why');
    else fail('(t6a) block add: the blocked player got ' + JSON.stringify(bs));
    if (bs && bs.id === undefined) ok('(t6a) the pushed snapshot carries no request id — a client must not match it to one');
    else fail('(t6a) pushed snapshot carried an id: ' + JSON.stringify(bs));
    if (!last(wb, 'block')) ok('(t6a) the blocked player is never sent a block frame');
    else fail('(t6a) the blocked player was told: ' + JSON.stringify(last(wb, 'block')));
  }

  // ---- (t6b) after a block there is no route left between the two -----------
  // Seven ways in, each refused in BOTH directions, plus the panel. This is the
  // whole safety claim, checked rather than assumed.
  {
    const st = memStore(T6_ROWS);
    await st.addFriendship(A, B);
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B);
    S.onAuth(wa); S.onAuth(wb);
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    wa.rx.length = 0; wb.rx.length = 0;
    const res = (f) => (f && Array.isArray(f.results) ? f.results : null);
    const errs = [];
    await S.handle(wb, { type: 'friend', op: 'add', code: 'ABC234' });
    if ((last(wb, 'friend') || {}).error !== 'no_such_code') errs.push('add by code, blocked -> blocker: ' + JSON.stringify(last(wb, 'friend')));
    await S.handle(wa, { type: 'friend', op: 'add', code: 'BDF345' });
    if ((last(wa, 'friend') || {}).error !== 'blocked') errs.push('add by code, blocker -> blocked: ' + JSON.stringify(last(wa, 'friend')));
    await S.handle(wb, { type: 'friend', op: 'request', to: A });
    if ((last(wb, 'friend') || {}).error !== 'no_such_user') errs.push('request, blocked -> blocker: ' + JSON.stringify(last(wb, 'friend')));
    await S.handle(wa, { type: 'friend', op: 'request', to: B });
    if ((last(wa, 'friend') || {}).error !== 'blocked') errs.push('request, blocker -> blocked: ' + JSON.stringify(last(wa, 'friend')));
    await S.handle(wb, { type: 'friend', op: 'search', q: 'Anvil Six' });
    if ((res(last(wb, 'friend')) || ['x']).length !== 0) errs.push('search, blocked -> blocker: ' + JSON.stringify(last(wb, 'friend')));
    await S.handle(wa, { type: 'friend', op: 'search', q: 'Bunker Nine' });
    if ((res(last(wa, 'friend')) || ['x']).length !== 0) errs.push('search, blocker -> blocked: ' + JSON.stringify(last(wa, 'friend')));
    if (!errs.length) ok('(t6b) after a block: add by code, friend request and callsign search all refuse, in BOTH directions');
    else fail('(t6b) a route survived the block: ' + errs.join(' | '));
    // The accept route needs a request to accept, and the block deleted them —
    // so the surviving state has to be constructed to be tested at all.
    await st.addRequest(B, A);
    await S.handle(wa, { type: 'friend', op: 'accept', from: B });
    if ((last(wa, 'friend') || {}).error === 'blocked') ok('(t6b) a request that somehow outlived the block still cannot be accepted');
    else fail('(t6b) accept after block: ' + JSON.stringify(last(wa, 'friend')));
    if (st.friends.size === 0) ok('(t6b) not one of the seven refusals wrote a friendship');
    else fail('(t6b) a refusal wrote: ' + JSON.stringify([...st.friends]));
    await st.deleteRequest(B, A);
    // And the panel: the blocker sees them in the Blocked list and nowhere else.
    await S.handle(wa, { type: 'friends' });
    const f = last(wa, 'friends') || {};
    if ((f.friends || ['x']).length === 0 && (f.blocked || []).length === 1 && f.blocked[0].callsign === 'Bunker Nine' && keysOpaque(f.blocked))
      ok('(t6b) the panel shows the blocked player in the Blocked list and nowhere else');
    else fail('(t6b) panel after block: ' + JSON.stringify(f));
  }

  // ---- (t6c) block remove lifts the block and restores NOTHING --------------
  {
    const st = memStore(T6_ROWS);
    await st.addFriendship(A, B);
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B);
    S.onAuth(wa); S.onAuth(wb);
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    wa.rx.length = 0; wb.rx.length = 0;
    await S.handle(wa, { type: 'block', op: 'remove', id: B });
    const r = last(wa, 'block');
    if (r && r.op === 'remove' && r.ok === true) ok('(t6c) block remove: ok:true');
    else fail('(t6c) block remove replied ' + JSON.stringify(r));
    if (st.blocks.size === 0) ok('(t6c) block remove: the block row is gone');
    else fail('(t6c) block remove left ' + JSON.stringify([...st.blocks]));
    if (st.friends.size === 0) ok('(t6c) block remove: the friendship is NOT restored');
    else fail('(t6c) block remove restored a friendship: ' + JSON.stringify([...st.friends]));
    if (last(wa, 'friends')) ok('(t6c) block remove: the blocker gets a fresh snapshot, so the Blocked list empties');
    else fail('(t6c) block remove: no snapshot to the blocker');
    // NOT PUSHED TO THE OTHER PLAYER, deliberately: nothing of theirs changed,
    // and an unsolicited frame the moment somebody lifts a block is a timing
    // signal that they had been blocked. A block is silent in both directions,
    // going on and coming off.
    if (!last(wb, 'friends')) ok('(t6c) block remove: the unblocked player is told nothing — an unblock is not an event of theirs');
    else fail('(t6c) block remove leaked a frame to the unblocked player: ' + JSON.stringify(wb.rx));
    wb.rx.length = 0;
    await S.handle(wb, { type: 'friend', op: 'request', to: A });
    const q = last(wb, 'friend');
    if (q && q.op === 'request' && q.ok === true) ok('(t6c) block remove: a request works again, so the block really was lifted');
    else fail('(t6c) after unblock, request: ' + JSON.stringify(q));
    // Removing a block that was never there is not an error: the row may point
    // at a deleted account, and refusing would strand the blocker with a block
    // they cannot lift.
    wa.rx.length = 0;
    await S.handle(wa, { type: 'block', op: 'remove', id: D });
    if ((last(wa, 'block') || {}).ok === true) ok('(t6c) removing a block that is not there is ok:true, not an error');
    else fail('(t6c) idempotent remove: ' + JSON.stringify(last(wa, 'block')));
  }

  // ---- (t6d) block refusals, and not one of them writes ---------------------
  {
    const st = memStore(T6_ROWS);
    const S = mkSocial(st);
    const wa = mkws(A);
    S.onAuth(wa);
    const cases = [
      ['self', { type: 'block', op: 'add', id: A }, 'self'],
      // THE SAME ACCOUNT IN ANOTHER CASE. Postgres renders uuid lower-case, so
      // an id that arrives upper-cased is the same account — and without the
      // fold it sails past the self check into store.addBlock, which throws
      // 'pair self' and is answered 'unavailable': the wrong word, and a round
      // trip spent to say it.
      ['upper-case self', { type: 'block', op: 'add', id: A.toUpperCase() }, 'self'],
      ['unknown account', { type: 'block', op: 'add', id: uid(90) }, 'no_such_user'],
      ['no id at all', { type: 'block', op: 'add' }, 'no_such_user'],
      ['a junk id', { type: 'block', op: 'add', id: '../rpc/exec' }, 'no_such_user'],
      ['a junk id on remove', { type: 'block', op: 'remove', id: 'not-a-uuid' }, 'no_such_user'],
      ['an op that does not exist', { type: 'block', op: 'nonsense', id: B }, 'unavailable'],
      ['no op at all', { type: 'block', id: B }, 'unavailable'],
    ];
    const bad = [];
    for (const [label, msg, want] of cases) {
      wa.rx.length = 0;
      await S.handle(wa, msg);
      const got = last(wa, 'block');
      if (!got || got.error !== want) bad.push(`${label}: wanted ${want}, got ${JSON.stringify(got)}`);
    }
    if (!bad.length) ok('(t6d) block refuses self (in either case), an unknown account, a missing id, a junk id and an unknown op');
    else fail('(t6d) ' + bad.join(' | '));
    if (st.blocks.size === 0 && st.friends.size === 0 && st.requests.size === 0)
      ok('(t6d) not one refused block wrote a row');
    else fail('(t6d) a refused block wrote ' + JSON.stringify({ blocks: [...st.blocks], friends: [...st.friends] }));
    // A MALFORMED ID COSTS NO ROUND TRIP. server/store.js throws 'bad uuid' on
    // one, which the net would answer 'unavailable' — the wrong word for a
    // frame that was simply misaddressed, after a wasted query.
    const st2 = memStore(T6_ROWS);
    const S2 = mkSocial(st2);
    const w2 = mkws(A); S2.onAuth(w2);
    st2.calls.length = 0;
    await S2.handle(w2, { type: 'block', op: 'add', id: '../rpc/exec' });
    await S2.handle(w2, { type: 'block', op: 'remove', id: 'not-a-uuid' });
    await S2.handle(w2, { type: 'report', id: 'not-a-uuid' });
    await S2.handle(w2, { type: 'block', op: 'nonsense', id: B });
    if (st2.calls.length === 0) ok('(t6d) a malformed id, and an op that does not exist, never reach the store');
    else fail('(t6d) a refused frame reached the store: ' + JSON.stringify(st2.calls));
  }

  // ---- (t6e) report: the row, the name as seen, the log line, once a day ----
  {
    const st = memStore(T6_ROWS);
    const S = mkSocial(st);
    const wc = mkws(C);
    S.onAuth(wc);
    const lines = await withLog(() => S.handle(wc, { type: 'report', id: B }));
    const r = last(wc, 'report');
    if (r && r.ok === true) ok('(t6e) report: ok:true');
    else fail('(t6e) report replied ' + JSON.stringify(r));
    if (st.reports.length === 1 && st.reports[0].reporter === C && st.reports[0].reported === B && st.reports[0].callsign === 'Bunker Nine')
      ok('(t6e) report: one row carrying the reporter, the reported account and the callsign as seen');
    else fail('(t6e) report rows: ' + JSON.stringify(st.reports));
    if (lines.length === 1 && lines[0] === `[report] ${B} "Bunker Nine" by ${C}`)
      ok('(t6e) report: the log line is exactly [report] <reported-uuid> "<callsign>" by <reporter-uuid>');
    else fail('(t6e) report log lines: ' + JSON.stringify(lines));
    // HE RENAMES AFTER THE REPORT. setChosenCallsign writes the name AND the
    // key in one PATCH, so the fixture moves both — a row whose key does not
    // match is a different case and (t6j) owns it.
    st.profiles.get(B).callsign = 'Ridge Eleven';
    st.profiles.get(B).callsign_key = 'ridge eleven';
    await S.handle(wc, { type: 'report', id: B });
    if ((last(wc, 'report') || {}).error === 'already') ok('(t6e) report: a second report of the same account inside a day is `already`');
    else fail('(t6e) second report: ' + JSON.stringify(last(wc, 'report')));
    if (st.reports.length === 1) ok('(t6e) report: `already` writes no row');
    else fail('(t6e) already wrote a row: ' + JSON.stringify(st.reports));
    const was = CLOCK;
    CLOCK += DAY + 1000;
    const lines2 = await withLog(() => S.handle(wc, { type: 'report', id: B }));
    const r2 = last(wc, 'report');
    if (r2 && r2.ok === true && st.reports.length === 2 && st.reports[1].callsign === 'Ridge Eleven')
      ok('(t6e) report: allowed again a rolling day later, carrying the name as it reads THEN — a rename does not erase the evidence');
    else fail('(t6e) next-day report: ' + JSON.stringify(r2) + ' rows ' + JSON.stringify(st.reports));
    if (lines2.length === 1 && lines2[0] === `[report] ${B} "Ridge Eleven" by ${C}`) ok('(t6e) the log line follows the rename too');
    else fail('(t6e) renamed log line: ' + JSON.stringify(lines2));
    // A ROLLING 24 HOURS, NOT A CALENDAR DAY: the window handed to the store
    // must be exactly one day back from now(), or a grudge gets two free
    // reports either side of midnight — and the clock the layer uses must be
    // the INJECTED one, or a test can never move it.
    const since = st.sinceSeen[st.sinceSeen.length - 1];
    if (since && Math.abs(Date.parse(since) - (CLOCK - DAY)) < 1000)
      ok('(t6e) the once-a-day window is a rolling 24 hours measured from the injected clock');
    else fail('(t6e) window asked for: ' + JSON.stringify(since) + ' wanted ' + new Date(CLOCK - DAY).toISOString());
    CLOCK = was;
  }

  // ---- (t6f) report refusals ------------------------------------------------
  {
    const st = memStore(T6_ROWS);
    const S = mkSocial(st);
    const wc = mkws(C);
    S.onAuth(wc);
    const bad = [];
    for (const [label, msg, want] of [
      ['self', { type: 'report', id: C }, 'self'],
      ['upper-case self', { type: 'report', id: C.toUpperCase() }, 'self'],
      ['an unknown account', { type: 'report', id: uid(91) }, 'no_such_user'],
      ['no id at all', { type: 'report' }, 'no_such_user'],
    ]) {
      wc.rx.length = 0;
      await S.handle(wc, msg);
      const got = last(wc, 'report');
      if (!got || got.error !== want) bad.push(`${label}: wanted ${want}, got ${JSON.stringify(got)}`);
    }
    if (!bad.length) ok('(t6f) report refuses yourself (in either case), an unknown account and a missing id');
    else fail('(t6f) ' + bad.join(' | '));
    if (st.reports.length === 0) ok('(t6f) not one refused report wrote a row');
    else fail('(t6f) a refused report wrote ' + JSON.stringify(st.reports));
  }

  // ---- (t6g) report is five a minute; block is deliberately unlimited -------
  {
    const st = memStore(T6_ROWS);
    const S = mkSocial(st);
    const wd = mkws(D);
    S.onAuth(wd);
    const got = [];
    for (let i = 0; i < 6; i++) {
      wd.rx.length = 0;
      await withLog(() => S.handle(wd, { type: 'report', id: B }));
      const f = last(wd, 'report');
      got.push(f && f.ok ? 'ok' : (f && f.error) || 'none');
    }
    if (got.join(',') === 'ok,already,already,already,already,slow_down')
      ok('(t6g) report rate: five answered inside a minute, the sixth is slow_down');
    else fail('(t6g) report rate shape: ' + got.join(','));
    if (st.reports.length === 1) ok('(t6g) report rate: the duplicates and the refusal wrote nothing more');
    else fail('(t6g) rate rows: ' + JSON.stringify(st.reports));
    const was = CLOCK;
    CLOCK += 60001;
    wd.rx.length = 0;
    await S.handle(wd, { type: 'report', id: B });
    if ((last(wd, 'report') || {}).error === 'already')
      ok('(t6g) report rate: the minute window reopens; the once-a-day rule does not');
    else fail('(t6g) after the window: ' + JSON.stringify(last(wd, 'report')));
    CLOCK = was;
    // THE REFUSALS SPEND FROM THE BUCKET TOO. A frame that costs no store read
    // still costs a reply, and an unlimited reply is an amplifier — the same
    // hole (i3) closed on the unknown friend op. The rate check therefore runs
    // FIRST, before the self and shape guards, which is the only order in which
    // a loop of junk frames cannot buy replies for ever. A fresh socket, so the
    // count starts at five.
    const we = mkws(E);
    S.onAuth(we);
    const shapes = [];
    for (let i = 0; i < 6; i++) {
      we.rx.length = 0;
      await S.handle(we, { type: 'report', id: E });      // self, every time
      shapes.push(((last(we, 'report') || {}).error) || 'none');
    }
    if (shapes.join(',') === 'self,self,self,self,self,slow_down')
      ok('(t6g) a loop of refused reports is rate limited too — a refusal is still a reply');
    else fail('(t6g) refusal bucket: ' + shapes.join(','));
    // BLOCK HAS NO PER-TYPE LIMIT, and that is the spec (4.2 rate-limits
    // friend, callsign and report, and not block) rather than an oversight: a
    // player in trouble must be able to block several people quickly. The
    // engine's 60 frames/s socket limiter is what bounds it.
    const wf = mkws(F);
    S.onAuth(wf);
    let blocked = 0;
    for (let i = 0; i < 12; i++) {
      wf.rx.length = 0;
      await S.handle(wf, { type: 'block', op: 'add', id: i % 2 ? A : B });
      if ((last(wf, 'block') || {}).ok === true) blocked++;
    }
    if (blocked === 12) ok('(t6g) block has no per-type limit, per design 4.2 — twelve in a row all answered ok');
    else fail('(t6g) block was rate limited after ' + blocked);
  }

  // ---- (t6h) a store that is down answers unavailable and never throws ------
  // AND THE ORDER OF THE WRITES IS PART OF THE ANSWER. There is no transaction
  // across PostgREST calls, so a teardown that fails half way leaves one of two
  // states, and only one of them is safe: a block row with a friendship that
  // outlived it is hidden by the read model and by the presence fan-out ((e3),
  // (g3)), while a deleted friendship with no block row is silent data loss for
  // a player who is not even protected. So the block is written FIRST.
  {
    const st = memStore(T6_ROWS);
    const S = mkSocial(st);
    const wa = mkws(A), wc = mkws(C);
    S.onAuth(wa); S.onAuth(wc);
    const say = async (ws, msg, label) => {
      try { await S.handle(ws, msg); }
      catch (e) { fail(`(t6h) ${label}: handle threw out of the socket: ${e.message}`); }
    };
    const bad = [];
    // ONLY THE CALLS THAT RUN BEFORE THE BLOCK ROW EXISTS CAN ANSWER
    // 'unavailable'. A failure AFTER it is a different answer and has its own
    // section at the end of this case.
    for (const m of ['profileById', 'addBlock']) {
      st.boom.clear(); st.boom.add(m);
      wa.rx.length = 0;
      await say(wa, { type: 'block', op: 'add', id: B }, 'block/' + m);
      const r = last(wa, 'block');
      // THE OP HAS TO COME BACK WITH IT. handleBlock keeps a catch of its own
      // beside handle()'s net for the one reason handleFriend does: a client
      // with an add and a remove outstanding cannot tell which one failed from
      // { type:'block', error:'unavailable' } alone. Drop the local catch and
      // the net answers without an op — which is why this asserts the op and
      // not merely the code.
      if (!(r && r.error === 'unavailable' && r.op === 'add')) bad.push(`${m}: ` + JSON.stringify(r));
    }
    st.boom.clear(); st.boom.add('removeBlock');
    wa.rx.length = 0;
    await say(wa, { type: 'block', op: 'remove', id: B }, 'block remove');
    if (!((last(wa, 'block') || {}).error === 'unavailable' && (last(wa, 'block') || {}).op === 'remove')) bad.push('removeBlock: ' + JSON.stringify(last(wa, 'block')));
    for (const m of ['profileById', 'reportedSince', 'addReport']) {
      st.boom.clear(); st.boom.add(m);
      wc.rx.length = 0;
      await say(wc, { type: 'report', id: B }, 'report/' + m);
      const r = last(wc, 'report');
      if (!(r && r.error === 'unavailable')) bad.push(`${m}: ` + JSON.stringify(r));
    }
    st.boom.clear();
    if (!bad.length) ok('(t6h) a failure in any of the seven store calls block and report make answers unavailable, and never throws');
    else fail('(t6h) ' + bad.join(' | '));
    if (st.reports.length === 0) ok('(t6h) a failed report writes no row');
    else fail('(t6h) a failed report wrote: ' + JSON.stringify(st.reports));
    // THE SAFE DIRECTION, asserted rather than assumed: the block that could
    // not finish its teardown still exists.
    const st2 = memStore(T6_ROWS);
    await st2.addFriendship(A, B);
    const S2 = mkSocial(st2);
    const w2 = mkws(A); S2.onAuth(w2);
    st2.boom.add('removeFriendship');
    await S2.handle(w2, { type: 'block', op: 'add', id: B });
    st2.boom.clear();
    if (st2.blocks.has(A + '>' + B)) ok('(t6h) a teardown that fails leaves the BLOCK standing — the protection survives, the cleanup is what is lost');
    else fail('(t6h) a half-finished block left no block row: ' + JSON.stringify([...st2.blocks]));
    const st3 = memStore(T6_ROWS);
    await st3.addFriendship(A, B);
    const S3 = mkSocial(st3);
    const w3 = mkws(A); S3.onAuth(w3);
    st3.boom.add('addBlock');
    await S3.handle(w3, { type: 'block', op: 'add', id: B });
    st3.boom.clear();
    if (st3.friends.size === 1) ok('(t6h) and a block that could not be written at all destroys nothing');
    else fail('(t6h) a failed block still destroyed the friendship: ' + JSON.stringify([...st3.friends]));
    // A PARTIAL TEARDOWN IS NOT A FAILURE, AND MUST NOT SAY IT IS. The block row
    // is written FIRST, so by the time the teardown can fail the player really
    // IS blocked: the row stands, and friendsSnapshot and flushPresence both
    // read the blocks themselves, so the survivor is invisible either way.
    // Answering 'unavailable' there told the player it had not worked in the one
    // moment that matters, and suppressed both panel pushes — so their own list
    // went on showing the person they had just blocked. Recovery converged on a
    // retry because the writes are idempotent, but the reply was a lie. What is
    // reported now is what actually happened.
    const st4 = memStore(T6_ROWS);
    await st4.addFriendship(A, B);
    await st4.addRequest(B, A);
    const S4 = mkSocial(st4);
    const w4 = mkws(A), w4b = mkws(B);
    S4.onAuth(w4); S4.onAuth(w4b);
    w4.rx.length = 0; w4b.rx.length = 0;
    st4.boom.add('deleteRequest');
    await S4.handle(w4, { type: 'block', op: 'add', id: B });
    st4.boom.clear();
    const r4 = last(w4, 'block');
    if (r4 && r4.ok === true && r4.op === 'add')
      ok('(t6h) a teardown that fails AFTER the block row is written still answers ok — the player really is blocked');
    else fail('(t6h) partial teardown replied ' + JSON.stringify(r4));
    if (st4.blocks.has(A + '>' + B)) ok('(t6h) and the row that makes that answer true is there');
    else fail('(t6h) a partial teardown wrote no block row: ' + JSON.stringify([...st4.blocks]));
    if (last(w4, 'friends')) ok('(t6h) the blocker is still pushed a snapshot, so their own panel stops showing the person they blocked');
    else fail('(t6h) a partial teardown suppressed the blocker snapshot');
    if (last(w4b, 'friends')) ok('(t6h) and so is the blocked player, exactly as a clean block does');
    else fail('(t6h) a partial teardown suppressed the blocked player snapshot');
    const f4 = last(w4, 'friends');
    if (st4.requests.has(B + '>' + A) && f4 && f4.friends.length === 0 && f4.requests.in.length === 0 && f4.blocked.length === 1)
      ok('(t6h) and the panel it carries is right anyway — the request the teardown could not delete is filtered by the read model');
    else fail('(t6h) the panel after a partial teardown: ' + JSON.stringify(f4) + ' requests ' + JSON.stringify([...st4.requests]));
  }

  // ---- (t6i) A GUEST MAY REPORT AND BLOCK. NOTHING ELSE. -------------------
  // BINDING.md resolution 18, and the sentence a reviewer looks for. The point
  // of doing it on ONE socket is that it proves the gate is PER MESSAGE TYPE
  // rather than a single gate that happens to be off: the same anonymous
  // account is served a block and a report and refused friends, friend and
  // callsign. isGuest TRUE with a real uuid is the guest that actually
  // arrives — a socket with no id at all is a different case, checked below.
  {
    const st = memStore([...T6_ROWS, { id: GUEST, callsign: null, friend_code: null, callsign_key: null, callsign_set_at: null }]);
    const S = mkSocial(st);
    const g = mkws(GUEST, true);
    S.onAuth(g);
    await S.handle(g, { type: 'block', op: 'add', id: B });
    const b = last(g, 'block');
    if (b && b.ok === true && st.blocks.has(GUEST + '>' + B))
      ok('(t6i) an ANONYMOUS account may block, and the row stores with the guest as the blocker');
    else fail('(t6i) guest block: ' + JSON.stringify(b) + ' rows ' + JSON.stringify([...st.blocks]));
    const lines = await withLog(() => S.handle(g, { type: 'report', id: A }));
    const r = last(g, 'report');
    if (r && r.ok === true && st.reports.length === 1 && st.reports[0].reporter === GUEST)
      ok('(t6i) an ANONYMOUS account may report, and the row stores with the guest as the reporter');
    else fail('(t6i) guest report: ' + JSON.stringify(r) + ' rows ' + JSON.stringify(st.reports));
    if (lines.length === 1 && lines[0] === `[report] ${A} "Anvil Six" by ${GUEST}`) ok('(t6i) a guest report logs the same line as anyone else');
    else fail('(t6i) guest log line: ' + JSON.stringify(lines));
    // AND THE OTHER HALF, ON THE SAME SOCKET.
    const refused = [];
    for (const msg of [{ type: 'friends' }, { type: 'friend', op: 'search', q: 'Anvil Six' }, { type: 'callsign', name: 'Wren Delacroix' }]) {
      g.rx.length = 0;
      await S.handle(g, msg);
      const f = last(g, 'social');
      if (!(f && f.error === 'sign_in') || last(g, msg.type)) refused.push(msg.type + ': ' + JSON.stringify(g.rx));
    }
    if (!refused.length) ok('(t6i) the SAME anonymous socket is refused friends, friend and callsign with sign_in — the gate is per message type');
    else fail('(t6i) a guest reached a linked-only path: ' + refused.join(' | '));
    if (!S.online.has(GUEST)) ok('(t6i) a guest that blocked and reported still has no presence entry');
    else fail('(t6i) a guest is in the online map');
    // A socket with NO account at all cannot: both rows are keyed to an account
    // and there is nobody to key them to.
    const nobody = mkws(null);
    const stray = [];
    for (const msg of [{ type: 'block', op: 'add', id: B }, { type: 'report', id: B }]) {
      nobody.rx.length = 0;
      await S.handle(nobody, msg);
      const f = last(nobody, 'social');
      if (!(f && f.error === 'sign_in')) stray.push(msg.type + ': ' + JSON.stringify(nobody.rx));
    }
    if (!stray.length) ok('(t6i) a socket with no account at all still cannot block or report');
    else fail('(t6i) accountless: ' + stray.join(' | '));
  }

  // ---- (t6j) THE REPORTED NAME IS ONE THE SERVER PROVED --------------------
  // WHO CAN WRITE profiles.callsign? The account itself, on every cloud save
  // (profiles_update_own). So the column is free text, and passing it straight
  // into a report row would fill the moderation table with whatever the
  // reported player typed — and write it into a server log line, which is the
  // one place a newline or a quote in it would do real damage. The name stored
  // is the one displayName vouches for, which is by construction the string
  // another player was actually shown; anything else is the store's sentinel,
  // so the report still LANDS and the reported uuid still identifies the
  // account. A never-named player must be reportable: they are the one player
  // a naive implementation makes untouchable.
  {
    const st = memStore(T6_ROWS);
    const S = mkSocial(st);
    const wa = mkws(A);
    S.onAuth(wa);
    const l1 = await withLog(() => S.handle(wa, { type: 'report', id: NAMELESS }));
    if ((last(wa, 'report') || {}).ok === true && st.reports.length === 1 && st.reports[0].callsign === NO_CALLSIGN)
      ok('(t6j) a player who never chose a callsign can still be reported — the row carries the store sentinel');
    else fail('(t6j) nameless report: ' + JSON.stringify(last(wa, 'report')) + ' rows ' + JSON.stringify(st.reports));
    if (l1.length === 1 && l1[0] === `[report] ${NAMELESS} "${NO_CALLSIGN}" by ${A}`)
      ok('(t6j) the log line for a never-named player says what was STORED, not "null"');
    else fail('(t6j) nameless log line: ' + JSON.stringify(l1));
    if (l1.length === 1 && !/"(null|undefined)?"/.test(l1[0])) ok('(t6j) no report log line can read "null", "undefined" or ""');
    else fail('(t6j) the log line printed an empty or null name: ' + JSON.stringify(l1));
    const l2 = await withLog(() => S.handle(wa, { type: 'report', id: TAMPERED }));
    if ((last(wa, 'report') || {}).ok === true && st.reports.length === 2 && st.reports[1].callsign === NO_CALLSIGN)
      ok('(t6j) free text in a display column with no key beside it is NOT what the report row records');
    else fail('(t6j) tampered report row: ' + JSON.stringify(st.reports));
    if (l2.length === 1 && !l2[0].includes('FOLLOW ME OK')) ok('(t6j) and it never reaches the server log either');
    else fail('(t6j) a tampered display column reached the log: ' + JSON.stringify(l2));
    // THE CONTROL, without which "always the sentinel" would pass everything
    // above: a row the server really wrote is recorded verbatim.
    const l3 = await withLog(() => S.handle(wa, { type: 'report', id: B }));
    if (st.reports.length === 3 && st.reports[2].callsign === 'Bunker Nine' && l3[0] === `[report] ${B} "Bunker Nine" by ${A}`)
      ok('(t6j) a name the server stored, with its key beside it, is recorded and logged verbatim');
    else fail('(t6j) proven name: ' + JSON.stringify(st.reports) + ' ' + JSON.stringify(l3));
    // A ROLLED PAIR IS PROVEN TOO (Task 5's second proof): it is a selection
    // from two curated lists, not authored text, and it is what the lobby
    // shows — so it is exactly what a report is about.
    const l4 = await withLog(() => S.handle(wa, { type: 'report', id: ROLLED }));
    if (st.reports.length === 4 && st.reports[3].callsign === 'Iron Ridge' && l4[0] === `[report] ${ROLLED} "Iron Ridge" by ${A}`)
      ok('(t6j) a ROLLED callsign is proof enough to record — it is the name the lobby showed');
    else fail('(t6j) rolled name report: ' + JSON.stringify(st.reports) + ' ' + JSON.stringify(l4));
    // AND WHAT THE STORE STORES IS WHAT THE LOG SAYS, always. The clamp and the
    // sentinel live in server/store.js; if the handler computed its log line its
    // own way the two would drift, and the drift would only ever surface in a
    // moderation queue nobody can reconcile.
    const drift = st.reports.filter((row) => reportCallsign(row.callsign) !== row.callsign);
    if (!drift.length) ok('(t6j) every stored name is already in the form server/store.js would store — one source of truth, not two');
    else fail('(t6j) the handler and the store disagree about the stored name: ' + JSON.stringify(drift));
  }

  // ---- (t6j2) A REPORT AGAINST A SEAT RECORDS THE NAME THE SEAT SHOWED -------
  // (round 2, 2026-10-08). Any player may present a name they typed, and no
  // profile row proves one, so a report against a guest's typed name recorded
  // '(no name)'. A report by seat HANDLE now records the name the engine's door
  // let onto that seat (the injected seatName, server.js's resolveSeatName),
  // re-tested for SHAPE only so the log line stays safe; a report by id has no
  // seat and records seenName, as before. The seat's name is read before the
  // first store call, so a seat that leaves while the report is out still has
  // its name recorded.
  {
    const st = memStore(T6_ROWS);
    const SEATS = new Map([['h-tamp', [TAMPERED, 'Tank Ace']], ['h-bad', [NAMELESS, 'Tank "Ace"']], ['h-b', [B, 'Bunker Nine']], ['h-none', [ROLLED, null]]]);
    const S = createSocial({
      store: st, terms: [], send: (ws, frame) => ws.rx.push(frame), now: () => CLOCK,
      resolveHandle: (ws, h) => (SEATS.get(h) || [null])[0],
      seatName: (ws, h) => { st.calls.push('seatName'); const v = SEATS.get(h); const n = v ? v[1] : null; SEATS.delete(h); return n; },
    });
    const wa = mkws(A);
    S.onAuth(wa);
    st.calls.length = 0;
    const l1 = await withLog(() => S.handle(wa, { type: 'report', handle: 'h-tamp', id: 1 }));
    const order = st.calls.slice();
    const l2 = await withLog(() => S.handle(wa, { type: 'report', handle: 'h-bad', id: 2 }));
    CLOCK += 2 * 86400000;
    const l3 = await withLog(() => S.handle(wa, { type: 'report', id: TAMPERED, idx: 3 }));
    const l4 = await withLog(() => S.handle(wa, { type: 'report', handle: 'h-b', id: 4 }));
    const l5 = await withLog(() => S.handle(wa, { type: 'report', handle: 'h-none', id: 5 }));
    const rows = st.reports.map((r) => r.callsign);
    if (same(rows, ['Tank Ace', NO_CALLSIGN, NO_CALLSIGN, 'Bunker Nine', 'Iron Ridge'])
        && l1[0] === `[report] ${TAMPERED} "Tank Ace" by ${A}` && l2[0] === `[report] ${NAMELESS} "${NO_CALLSIGN}" by ${A}`
        && l3[0] === `[report] ${TAMPERED} "${NO_CALLSIGN}" by ${A}` && l4[0] === `[report] ${B} "Bunker Nine" by ${A}` && l5[0] === `[report] ${ROLLED} "Iron Ridge" by ${A}`
        && order.indexOf('seatName') === 0 && order.indexOf('profileById') > 0)
      ok("(t6j2) a report by seat handle records the typed name the seat showed ('Tank Ace', not '(no name)'); a seat name of the wrong shape, a report by id and a seat with no name fall back to what seenName proves; the seat is read before the first store call");
    else fail('(t6j2) seat-name reports: ' + JSON.stringify({ rows, l1, l2, l3, l4, l5, order }));
  }

  // ---- (t6k) A BLOCK IS NOT A ONE-WAY DOOR ---------------------------------
  // requireAccount lets a GUEST write a block row, and the blocked list lived
  // ONLY inside the friends snapshot, behind requireLinked. So a guest could
  // block somebody and then never see or lift it — an action a player cannot
  // undo, which is worse than one they were never offered.
  //
  // `block op:'list'` is the smallest shape that closes it, and the cheapest to
  // get right: the frame type is already in SOCIAL_TYPES, already behind
  // requireAccount and already carries an op on every reply, so nothing about
  // the friends gate moves, server.js needs no change, and the new path reads
  // the blocks table and nothing else — it CANNOT widen the panel by accident.
  // Answering the friends snapshot to a guest instead would have meant a second
  // shape of that frame, a guest branch inside the eight round trips it makes,
  // and a friend code minted for an account that must never be addable.
  {
    const st = memStore([...T6_ROWS, { id: GUEST, callsign: null, friend_code: null, callsign_key: null, callsign_set_at: null }]);
    const S = mkSocial(st);
    const g = mkws(GUEST, true);
    S.onAuth(g);
    await S.handle(g, { type: 'block', op: 'add', id: B });
    await S.handle(g, { type: 'block', op: 'add', id: NAMELESS });
    g.rx.length = 0;
    await S.handle(g, { type: 'block', op: 'list', id: 9 });
    const l = last(g, 'block');
    if (l && l.op === 'list' && l.ok === true && bnames(l.blocked) === bnames([{ callsign: 'Bunker Nine' }, { callsign: null }]) && keysOpaque(l.blocked))
      ok('(t6k) a GUEST can see the blocks it wrote, with the same proven name the panel would show and null for a player who has none');
    else fail('(t6k) guest blocked list: ' + JSON.stringify(l));
    if (l && l.id === 9) ok('(t6k) the list reply echoes the request id like every other reply in this layer');
    else fail('(t6k) list echo: ' + JSON.stringify(l));
    // THE FRAME CARRIES THE BLOCKED LIST AND NOTHING ELSE. No friends, no
    // requests, no friend code — a guest must not be handed a code that would
    // make an anonymous account addable, and this is the assertion that fails if
    // somebody later "reuses" friendsSnapshot to build this answer.
    if (l && JSON.stringify(Object.keys(l).sort()) === JSON.stringify(['blocked', 'id', 'ok', 'op', 'type']))
      ok('(t6k) and it carries ONLY the blocked list — no friends, no requests, no friend code');
    else fail('(t6k) the list frame carried: ' + JSON.stringify(l && Object.keys(l).sort()));
    // WHO BLOCKED *YOU* IS NOT IN IT. blockIdsOf answers both directions; only
    // the direction this account wrote is theirs to see, or the list becomes a
    // way to enumerate who has blocked you.
    st.blocks.add(C + '>' + GUEST);
    g.rx.length = 0;
    await S.handle(g, { type: 'block', op: 'list' });
    const l2 = last(g, 'block');
    const b2 = (l2 && l2.blocked) || [];
    if (l2 && l2.ok === true && b2.length === 2 && !b2.some((r) => r.id === C))
      ok('(t6k) a block written AGAINST this account is not in its list — the list is what you did, never what was done to you');
    else fail('(t6k) blockedBy leaked into the list: ' + JSON.stringify(l2));
    // AND THE DOOR OPENS BOTH WAYS.
    // LIFTED THROUGH THE KEY THE LIST HANDED BACK, which is the only id this
    // client has: the round trip list -> Unblock is what the key exists to keep
    // working now that the row no longer carries an account id.
    await S.handle(g, { type: 'block', op: 'remove', id: bkey(l2.blocked, 'Bunker Nine') });
    g.rx.length = 0;
    await S.handle(g, { type: 'block', op: 'list' });
    const l3 = last(g, 'block');
    if (l3 && l3.ok === true && l3.blocked.length === 1 && l3.blocked[0].callsign === null && !st.blocks.has(GUEST + '>' + B) && st.blocks.has(GUEST + '>' + NAMELESS))
      ok('(t6k) a guest LIFTS a block with the key the list gave them, the right row goes, and it leaves the list — the one-way door is closed');
    else fail('(t6k) after a guest unblock: ' + JSON.stringify(l3));
    // The gate did not move while this was added.
    g.rx.length = 0;
    await S.handle(g, { type: 'friends' });
    if ((last(g, 'social') || {}).error === 'sign_in' && !last(g, 'friends'))
      ok('(t6k) the same guest socket is STILL refused the friends panel — list did not widen the gate');
    else fail('(t6k) a guest reached the panel after list was added: ' + JSON.stringify(g.rx));
    // A socket with no account at all has nothing to list.
    const nobody = mkws(null);
    await S.handle(nobody, { type: 'block', op: 'list' });
    if ((last(nobody, 'social') || {}).error === 'sign_in' && !last(nobody, 'block'))
      ok('(t6k) a socket with no account at all cannot list blocks either');
    else fail('(t6k) accountless list: ' + JSON.stringify(nobody.rx));
    // A LINKED ACCOUNT GETS THE IDENTICAL FRAME, so Task 8 has one code path for
    // the Blocked list rather than one per account kind.
    const wa = mkws(A);
    S.onAuth(wa);
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    wa.rx.length = 0;
    await S.handle(wa, { type: 'block', op: 'list' });
    const l4 = last(wa, 'block');
    if (l4 && l4.ok === true && l4.blocked.length === 1 && l4.blocked[0].callsign === 'Bunker Nine' && keysOpaque(l4.blocked))
      ok('(t6k) a LINKED account is answered the identical frame — one code path for Task 8');
    else fail('(t6k) linked list: ' + JSON.stringify(l4));
    // LIST IS A READ, SO IT SPENDS FROM THE READ MODEL'S BUCKET. D9 leaves add
    // and remove unlimited because a player in trouble must be able to block
    // several people quickly; this op writes nothing and costs three PostgREST
    // round trips, which is the friends frame's shape and is bounded its way.
    const wd = mkws(D);
    S.onAuth(wd);
    const codes = [];
    for (let i = 0; i < 21; i++) {
      wd.rx.length = 0;
      await S.handle(wd, { type: 'block', op: 'list' });
      const f = last(wd, 'block');
      codes.push(f && f.ok ? 'ok' : (f && f.error) || 'none');
    }
    if (codes.slice(0, 20).every((c) => c === 'ok') && codes[20] === 'slow_down')
      ok('(t6k) list is twenty a minute, from the read model bucket — and the refusal still carries the op');
    else fail('(t6k) list rate shape: ' + codes.join(','));
    if ((last(wd, 'block') || {}).op === 'list') ok('(t6k) a rate-refused list says WHICH op was refused');
    else fail('(t6k) list slow_down frame: ' + JSON.stringify(last(wd, 'block')));
    wd.rx.length = 0;
    await S.handle(wd, { type: 'block', op: 'add', id: E });
    if ((last(wd, 'block') || {}).ok === true) ok('(t6k) and block ADD is untouched by it — design 4.2 rate limits no write here');
    else fail('(t6k) list exhaustion blocked an add: ' + JSON.stringify(last(wd, 'block')));
    const before = st.blocks.size;
    wd.rx.length = 0;
    await S.handle(wd, { type: 'block', op: 'list' });
    if (st.blocks.size === before) ok('(t6k) list writes nothing');
    else fail('(t6k) list changed the blocks table');
  }

  // ---- (t6k2) a list that cannot be read says so, and says which op ---------
  {
    const st = memStore(T6_ROWS);
    const S = mkSocial(st);
    const wa = mkws(A);
    S.onAuth(wa);
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    for (const m of ['blockIdsOf', 'profilesByIds']) {
      st.boom.clear(); st.boom.add(m);
      wa.rx.length = 0;
      let threw = null;
      try { await S.handle(wa, { type: 'block', op: 'list' }); } catch (e) { threw = e; }
      const r = last(wa, 'block');
      if (!threw && r && r.error === 'unavailable' && r.op === 'list') ok(`(t6k2) a failed list (${m}) answers unavailable WITH the op, and never throws`);
      else fail(`(t6k2) list/${m}: ` + JSON.stringify(r) + (threw ? ' threw ' + threw.message : ''));
    }
    st.boom.clear();
  }

  // ---- (t6k3) THE BLOCKED LIST IS NOT A HANDLE-TO-UUID CONVERTER -----------
  // BINDING.md resolution 24 gives a lobby seat an opaque per-room handle
  // precisely so a modified client cannot correlate a player across matches and
  // build a graph of who plays with whom: publishing account ids "is a privacy
  // leak far worse than the problem", in its own words. block add ACCEPTS that
  // handle. While the blocked list answered with the account uuid, the two
  // composed into a converter — block every seat in the lobby (unrated, silent,
  // the victim is never told), list, read the uuids, unblock — and the uuid it
  // yielded is all friendRequest needs, so a stranger from one quick match could
  // be asked for ever. public/privacy.html states in this build that another
  // player can never learn your account identifier.
  //
  // FOUR PROPERTIES, and the second is the one that makes the first worth
  // having: the id is opaque, it still LIFTS the block, it does not work as a
  // target on any other frame, and it is scoped to the connection that was given
  // it. Asserted here rather than left to the shape checks scattered above,
  // because "the list no longer carries a uuid" is only half a fix if the key
  // that replaced it is spendable somewhere else.
  {
    const st = memStore(T6_ROWS);
    const S = mkSocial(st);
    const wa = mkws(A), wa2 = mkws(A), wb = mkws(B);
    S.onAuth(wa); S.onAuth(wa2); S.onAuth(wb);
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    wa.rx.length = 0;
    await S.handle(wa, { type: 'block', op: 'list' });
    const l = last(wa, 'block');
    const key = bkey(l.blocked, 'Bunker Nine');
    if (key && isUnblockKey(key) && key !== B) ok('(t6k3) the blocked row carries a 32-hex unblock key, and it is not the account id');
    else fail('(t6k3) blocked id shape: ' + JSON.stringify(l.blocked));
    if (!UUID_ANY.test(JSON.stringify(l))) ok('(t6k3) and there is no uuid ANYWHERE in the list frame — not the target, not the viewer');
    else fail('(t6k3) a uuid survived in the list frame: ' + JSON.stringify(l));

    // STABLE WITHIN THE CONNECTION, so a rendered Unblock button still works
    // after the client re-reads the list — which it does after every unblock.
    wa.rx.length = 0;
    await S.handle(wa, { type: 'block', op: 'list' });
    if (bkey((last(wa, 'block') || {}).blocked, 'Bunker Nine') === key) ok('(t6k3) the same socket is given the SAME key twice — a rendered Unblock button does not go stale between reads');
    else fail('(t6k3) the key changed inside one connection');

    // AND DIFFERENT ON ANOTHER CONNECTION OF THE SAME ACCOUNT, which is what
    // stops it being a stable pseudonym a client can keep and compare.
    wa2.rx.length = 0;
    await S.handle(wa2, { type: 'block', op: 'list' });
    const key2 = bkey((last(wa2, 'block') || {}).blocked, 'Bunker Nine');
    if (key2 && isUnblockKey(key2) && key2 !== key) ok('(t6k3) a SECOND connection of the same account is given a DIFFERENT key for the same person — nothing here survives the socket');
    else fail('(t6k3) two connections shared a key: ' + JSON.stringify([key, key2]));

    // AND IT IS NOT A TARGET ANYWHERE ELSE. This is the half that would make the
    // opacity cosmetic: a key that friendRequest or report accepted would be a
    // uuid by another name.
    wa.rx.length = 0;
    await S.handle(wa, { type: 'friend', op: 'request', to: key });
    if ((last(wa, 'friend') || {}).error === 'no_such_user' && !st.requests.size) ok('(t6k3) the key cannot be spent as a friend request target');
    else fail('(t6k3) friend request took the key: ' + JSON.stringify([last(wa, 'friend'), [...st.requests]]));
    wa.rx.length = 0;
    await S.handle(wa, { type: 'report', id: key });
    if ((last(wa, 'report') || {}).error === 'no_such_user' && !st.reports.length) ok('(t6k3) nor as a report target');
    else fail('(t6k3) report took the key: ' + JSON.stringify([last(wa, 'report'), st.reports]));
    wa.rx.length = 0;
    await S.handle(wa, { type: 'block', op: 'add', id: key });
    if ((last(wa, 'block') || {}).error === 'no_such_user') ok('(t6k3) nor as a block ADD target — a key is a way OUT of a block, never a way to write a new one');
    else fail('(t6k3) block add took the key: ' + JSON.stringify(last(wa, 'block')));
    wa.rx.length = 0;
    await S.handle(wa, { type: 'friend', op: 'remove', id: key });
    if ((last(wa, 'friend') || {}).error === 'no_such_user') ok('(t6k3) nor as a friend remove target');
    else fail('(t6k3) friend remove took the key: ' + JSON.stringify(last(wa, 'friend')));

    // A KEY FROM ANOTHER SOCKET IS NOTHING HERE, which is the same statement as
    // "it does not survive the connection", said from the receiving end.
    wa.rx.length = 0;
    await S.handle(wa, { type: 'block', op: 'remove', id: key2 });
    if (st.blocks.has(A + '>' + B)) ok('(t6k3) a key issued to the OTHER connection lifts nothing on this one');
    else fail('(t6k3) a foreign key lifted a block');

    // AND A SOCKET THAT WAS NEVER GIVEN A KEY SPENDS NO ROUND TRIP LOOKING FOR
    // ONE. `block op:'remove'` is rate limited by design 4.2 not at all, so a
    // resolution that always read the blocks table would let any client turn
    // junk into two PostgREST reads a frame, from a socket that has never even
    // opened a blocked list. No salt means no key was ever issued here.
    const wc = mkws(C);
    S.onAuth(wc);
    st.calls.length = 0;
    wc.rx.length = 0;
    await S.handle(wc, { type: 'block', op: 'remove', id: key });
    if ((last(wc, 'block') || {}).error === 'no_such_user' && !st.calls.length)
      ok('(t6k3) a socket that never opened a blocked list answers no_such_user WITHOUT touching the store — an unrated op is not an amplifier');
    else fail('(t6k3) a keyless socket cost ' + JSON.stringify(st.calls) + ' -> ' + JSON.stringify(last(wc, 'block')));

    // ...and then the one thing it must do.
    wa.rx.length = 0;
    await S.handle(wa, { type: 'block', op: 'remove', id: key });
    if ((last(wa, 'block') || {}).ok === true && !st.blocks.has(A + '>' + B)) ok('(t6k3) and the key lifts the block it belongs to — the list stays actionable, which is the whole reason the row keeps an id');
    else fail('(t6k3) the key did not unblock: ' + JSON.stringify([last(wa, 'block'), [...st.blocks]]));

    // THE PUSHED SNAPSHOT IS MAPPED PER DEVICE, not once for the account. One
    // read builds the frame and every socket gets its own blocked array; a fan-
    // out that forgot to remap would hand one device another's keys, which
    // resolve to nothing there and leave Unblock permanently inert.
    await S.handle(wa, { type: 'block', op: 'add', id: B });
    wa.rx.length = 0; wa2.rx.length = 0;
    await S.handle(wa, { type: 'friends' });
    const ownKey = bkey((last(wa, 'friends') || {}).blocked, 'Bunker Nine');
    wa2.rx.length = 0;
    await S.handle(wa2, { type: 'friends' });
    const ownKey2 = bkey((last(wa2, 'friends') || {}).blocked, 'Bunker Nine');
    if (ownKey && ownKey2 && ownKey !== ownKey2) ok('(t6k3) the friends snapshot carries per-connection keys too — the leak had TWO mouths and both are shut');
    else fail('(t6k3) snapshot keys: ' + JSON.stringify([ownKey, ownKey2]));
    wa2.rx.length = 0;
    await S.handle(wa2, { type: 'block', op: 'remove', id: ownKey2 });
    if ((last(wa2, 'block') || {}).ok === true && !st.blocks.has(A + '>' + B))
      ok('(t6k3) and the key from the SNAPSHOT lifts the block on the device that received it');
    else fail('(t6k3) the snapshot key did not unblock: ' + JSON.stringify([last(wa2, 'block'), [...st.blocks]]));
  }

  // ---- (t6l) ONE SOCIAL FRAME AT A TIME, PER SOCKET -------------------------
  // THE ONCE-A-DAY REPORT RULE IS A READ BEFORE A WRITE, and until now nothing
  // made a frame wait for the one in front of it: five reports sent in ONE tick
  // all passed reportedSince() before the first row landed, and five rows were
  // written for the same pair on the same day. The callsign branch three hundred
  // lines up states the standard — THE WRITE IS THE AUTHORITY, not a read before
  // it — and name_reports has no unique index to be that authority, so the
  // ORDERING is what restores it. Every other read-then-write in this layer sits
  // behind the same chain.
  {
    const st = memStore(T6_ROWS);
    const S = mkSocial(st);
    const wa = mkws(A);
    S.onAuth(wa);
    const lines = await withLog(() => Promise.all([0, 1, 2, 3, 4].map(() => S.handle(wa, { type: 'report', id: B }))));
    const codes = sent(wa, 'report').map((f) => (f.ok ? 'ok' : f.error));
    if (st.reports.length === 1) ok('(t6l) five report frames in ONE tick write ONE row — the daily rule is not defeatable by pipelining');
    else fail('(t6l) pipelined reports wrote ' + st.reports.length + ' rows: ' + JSON.stringify(st.reports));
    if (codes.join(',') === 'ok,already,already,already,already') ok('(t6l) the first is accepted and the other four are `already`, in the order they were sent');
    else fail('(t6l) pipelined report replies: ' + codes.join(','));
    if (lines.length === 1) ok('(t6l) one row, one log line — the moderation log cannot be flooded through one socket either');
    else fail('(t6l) pipelined log lines: ' + JSON.stringify(lines));
  }

  // ---- (t6l2) a rejected predecessor cannot wedge the chain -----------------
  // The chain must survive a link that REJECTS, or one bad frame silences the
  // socket for the rest of its life. Two things do it: the stored link is the
  // settled promise, never the one handed to the caller, and the next frame is
  // scheduled on BOTH settlements of the one before it.
  {
    const st = memStore(T6_ROWS);
    const S = mkSocial(st);
    const wa = mkws(A);
    S.onAuth(wa);
    // The no-op catch is on the FIXTURE, not on the layer: it only stops Node
    // ending the process on an unhandled rejection before this check can report,
    // and it attaches no handler the implementation could be credited with.
    const rejected = Promise.reject(new Error('the frame before this one blew up'));
    rejected.catch(() => {});
    wa._socialQueue = rejected;
    let threw = null;
    try { await withLog(() => S.handle(wa, { type: 'report', id: B })); } catch (e) { threw = e; }
    if (!threw && (last(wa, 'report') || {}).ok === true && st.reports.length === 1)
      ok('(t6l2) a frame behind a REJECTED one is still handled — a rejection cannot wedge the socket');
    else fail('(t6l2) after a rejected predecessor: ' + JSON.stringify(last(wa, 'report')) + (threw ? ' threw ' + threw.message : ''));
    wa.rx.length = 0;
    await S.handle(wa, { type: 'block', op: 'add', id: C });
    if ((last(wa, 'block') || {}).ok === true) ok('(t6l2) and the socket keeps working for every frame after that');
    else fail('(t6l2) the chain stayed broken: ' + JSON.stringify(last(wa, 'block')));
  }

  // ---- (t6l3) a slow frame holds ITS socket and no other --------------------
  // The cost of serialising, stated and tested rather than assumed. A frame that
  // is slow delays the next frame ON THE SAME SOCKET and nothing else: another
  // player's socket has its own chain, and this socket's GAME frames never enter
  // this layer at all. The wait is bounded — every store call goes through
  // sbAdmin's AbortSignal.timeout(8000), so a wedged link settles and drains.
  {
    const base = memStore(T6_ROWS);
    let release = () => {};
    const gate = new Promise((r) => { release = r; });
    let hits = 0;
    const st = { ...base, async profileById(id) { hits += 1; if (hits === 1) await gate; return base.profileById(id); } };
    const S = mkSocial(st);
    const wa = mkws(A), wd = mkws(D);
    S.onAuth(wa); S.onAuth(wd);
    const p1 = withLog(() => S.handle(wa, { type: 'report', id: B }));
    const p2 = S.handle(wa, { type: 'report', id: C });
    const p3 = S.handle(wd, { type: 'report', id: E });
    await sleep(20);
    const held = sent(wa, 'report').length;
    const other = sent(wd, 'report').length;
    release();
    await Promise.all([p1, p2, p3]);
    if (held === 0) ok('(t6l3) a second frame on the SAME socket waits for the slow one in front of it');
    else fail('(t6l3) a frame overtook the slow one: ' + held + ' replies while it was still in flight');
    if (other === 1) ok('(t6l3) while ANOTHER socket is answered straight away — the chain is per socket, not per server');
    else fail('(t6l3) the other socket was held up too: ' + other + ' replies');
    if (sent(wa, 'report').length === 2 && base.reports.length === 3)
      ok('(t6l3) and when the slow frame settles the queue drains — nothing is lost, only ordered');
    else fail('(t6l3) after the release: ' + sent(wa, 'report').length + ' replies, ' + JSON.stringify(base.reports));
  }

  // ---- (t6m) A REPORT KEEPS THE NAME THE REPORTER SAW ----------------------
  // THE ONE CASE MODERATION EXISTS FOR, and it used to invert. displayName ends
  // with a blocklist pass, so the moment the owner added the term the offending
  // name matched, every LATER report of that player recorded the sentinel —
  // while the name carried on appearing in lobbies, because a lobby name is
  // PROVED, not re-tested against a list that moved. The evidence was destroyed
  // at exactly the moment it was needed, and the row and the log line said
  // "(no name)" about a player whose name was on screen.
  //
  // So a report records what the PROOF vouches for — the key, or a curated
  // rolled pair — and nothing else. The blocklist decides what another player is
  // SHOWN; it never decides what the owner is TOLD.
  {
    const SLUR = uid(25);
    const st = memStore([...T6_ROWS, { id: SLUR, callsign: 'Badword Ridge', friend_code: 'SPQ792', callsign_key: 'badword ridge', callsign_set_at: null }]);
    // The term arrives AFTER the name was set, which is the only order in which
    // this can happen: validateCallsign would have refused the name otherwise.
    const S = mkSocial(st, ['badword']);
    const wa = mkws(A);
    S.onAuth(wa);
    const l = await withLog(() => S.handle(wa, { type: 'report', id: SLUR }));
    if ((last(wa, 'report') || {}).ok === true && st.reports.length === 1 && st.reports[0].callsign === 'Badword Ridge')
      ok('(t6m) a name blocklisted AFTER it was set is what the report row records — the evidence outlives the blocklist');
    else fail('(t6m) blocklisted-later report row: ' + JSON.stringify(last(wa, 'report')) + ' rows ' + JSON.stringify(st.reports));
    if (l.length === 1 && l[0] === `[report] ${SLUR} "Badword Ridge" by ${A}`)
      ok('(t6m) and the log line carries it, so the owner can search for the name they were told about');
    else fail('(t6m) blocklisted-later log line: ' + JSON.stringify(l));
    // AND THE PANEL STILL HIDES IT. The two rules are not in tension.
    await st.addFriendship(A, SLUR);
    wa.rx.length = 0;
    await S.handle(wa, { type: 'friends' });
    const f = last(wa, 'friends');
    const row = f && f.friends.find((x) => x.id === SLUR);
    if (row && row.callsign === null)
      ok('(t6m) the same name is STILL null in the friends panel — the blocklist still decides what is shown');
    else fail('(t6m) the panel showed a blocklisted name: ' + JSON.stringify(f && f.friends));
    // THE FLOOR IS THE PROOF, not the absence of the blocklist. Without this
    // control, "record whatever the column holds" would pass everything above.
    const l2 = await withLog(() => S.handle(wa, { type: 'report', id: TAMPERED }));
    if (st.reports.length === 2 && st.reports[1].callsign === NO_CALLSIGN && l2.length === 1 && !l2[0].includes('FOLLOW ME OK'))
      ok('(t6m) dropping the blocklist pass did NOT drop the proof — free text with no key beside it is still the sentinel');
    else fail('(t6m) tampered after the relaxation: ' + JSON.stringify(st.reports) + ' ' + JSON.stringify(l2));
    // A REPORTER CANNOT INFLUENCE WHAT IS WRITTEN ABOUT SOMEBODY ELSE. The only
    // thing the handler reads off the frame is the target id; there is no name,
    // no note and no free text anywhere in the request.
    const l3 = await withLog(() => S.handle(wa, { type: 'report', id: NAMELESS, callsign: 'PUT THIS IN THE ROW', name: 'OR THIS' }));
    if (st.reports.length === 3 && st.reports[2].callsign === NO_CALLSIGN && l3.length === 1 && !/PUT THIS|OR THIS/.test(l3[0]))
      ok('(t6m) a reporter cannot smuggle a name into a row about someone else — the frame carries an id and nothing else is read');
    else fail('(t6m) a reporter influenced the row: ' + JSON.stringify(st.reports) + ' ' + JSON.stringify(l3));
  }

  // ---- (db4) ONLY YOUR OWN BLOCK IS NAMED (D-BLOCK-4) -----------------------
  // Add, request and accept refuse across a block both ways. The caller's own
  // block answers `blocked`: it tells them what they did. A block naming the
  // caller answers the op's own not-found, byte for byte a genuine miss and
  // at its cost (D-BLOCK-5 I), so no answer tells a player they were
  // blocked. Blocked both ways is the caller's own block, or `blocked` would
  // say whether they were blocked back.
  {
    const OPS = {
      add: { frame: { type: 'friend', op: 'add', code: 'BDF345' }, miss: 'no_such_code', genuine: { type: 'friend', op: 'add', code: 'ZZZ999' } },
      request: { frame: { type: 'friend', op: 'request', to: B }, miss: 'no_such_user', genuine: { type: 'friend', op: 'request', to: uid(99) } },
      accept: { frame: { type: 'friend', op: 'accept', from: B }, miss: 'no_such_request', genuine: { type: 'friend', op: 'accept', from: B } },
    };
    const WRITES = new Set(['addFriendship', 'removeFriendship', 'addRequest', 'deleteRequest', 'addBlock', 'removeBlock']);
    // WHAT AN ANSWER COSTS (D-BLOCK-5 I), as (jn-d) pins it for join: the
    // store calls the op made, and the round trip each read went out in
    // (how many reads had come back before it was asked).
    const READS = ['profileByFriendCode', 'profileById', 'friendIdsOf', 'requestsOf', 'blockIdsOf'];
    const costed = (st) => {
      const trips = [];
      let back = 0;
      for (const m of READS) {
        const real = st[m];
        st[m] = async function (...a) { trips.push(back); try { return await real.apply(st, a); } finally { back++; } };
      }
      return trips;
    };
    // A asks about B. For accept, B's request predates the block. `genuine`
    // sends the op's real miss in a world with no block and no request.
    const world = async (op, blocks, genuine = false, boom = null) => {
      const st = memStore(ROWS);
      if (op === 'accept' && !genuine) await st.addRequest(B, A);
      for (const [x, y] of blocks) await st.addBlock(x, y);
      const S = mkSocial(st);
      const wa = mkws(A), wb = mkws(B);
      S.onAuth(wa); S.onAuth(wb);
      wa.rx.length = 0; wb.rx.length = 0; st.calls.length = 0;
      if (boom) st.boom.add(boom);
      const trips = costed(st);
      await S.handle(wa, { ...(genuine ? OPS[op].genuine : OPS[op].frame), id: 'q' });
      return { a: JSON.stringify(wa.rx), b: JSON.stringify(wb.rx), writes: st.calls.filter((c) => WRITES.has(c)), friends: st.friends.size, requests: [...st.requests], calls: st.calls.slice(), trips };
    };
    const cost = (w) => JSON.stringify([w.calls, w.trips]);
    const oneTrip = (w) => w.trips.length > 0 && w.trips.every((t) => t === 0);
    const only = (op, error) => JSON.stringify([{ type: 'friend', op, error, id: 'q' }]);
    const untouched = (op, w) => w.b === '[]' && !w.writes.length && w.friends === 0
      && JSON.stringify(w.requests) === JSON.stringify(op === 'accept' ? [B + '>' + A] : []);
    for (const op of Object.keys(OPS)) {
      const { miss } = OPS[op];
      const mine = await world(op, [[A, B]]);
      if (mine.a === only(op, 'blocked') && untouched(op, mine)) ok(`(db4) ${op}: your own block is named — blocked, nothing written, and they are sent nothing`);
      else fail(`(db4) ${op} mine: ` + JSON.stringify(mine));
      const theirs = await world(op, [[B, A]]);
      if (theirs.a === only(op, miss) && untouched(op, theirs)) ok(`(db4) ${op}: blocked BY them answers ${miss}, nothing written, and they are sent nothing`);
      else fail(`(db4) ${op} theirs: ` + JSON.stringify(theirs));
      const real = await world(op, [], true);
      if (real.a === theirs.a && real.b === theirs.b && real.a === only(op, miss) && cost(real) === cost(theirs) && oneTrip(theirs))
        ok(`(db4) ${op}: that answer is byte for byte a genuine ${miss}, and costs the same reads in one round trip`);
      else fail(`(db4) ${op} twin: ` + JSON.stringify({ blockedBy: theirs.a, genuine: real.a, b: [theirs.b, real.b], calls: [theirs.calls, real.calls], trips: [theirs.trips, real.trips] }));
      // And when one of the caller's own reads fails, the two fail alike.
      const fails = [];
      for (const m of ['friendIdsOf', 'requestsOf', 'blockIdsOf']) {
        const x = await world(op, [[B, A]], false, m), y = await world(op, [], true, m);
        if (!(x.a === y.a && x.a === only(op, 'unavailable'))) fails.push({ m, blockedBy: x.a, genuine: y.a });
      }
      if (!fails.length) ok(`(db4) ${op}: when one of the caller's reads fails, the blocked-by answer and a genuine ${miss} fail alike`);
      else fail(`(db4) ${op} failed read: ` + JSON.stringify(fails));
      const both = await world(op, [[A, B], [B, A]]);
      if (both.a === only(op, 'blocked') && untouched(op, both)) ok(`(db4) ${op}: blocked both ways is your own block — blocked, whether or not they blocked you back`);
      else fail(`(db4) ${op} both: ` + JSON.stringify(both));
    }
  }

  // ---- (db4 ii) the block lines come before `already` and the acceptance ----
  // T6-R1-6. (db4)'s worlds hold no friendship, and no request from B for
  // `request`, so nothing pinned where the two direction lines sit against
  // `already`, or against friendRequest's acceptance of an incoming request.
  // A block can leave either row behind: a half-failed block (a delete that
  // threw is still answered ok) keeps a request, and a friendship can outlive
  // a block the same way. Behind either row the answer is still the block's:
  // your own is `blocked`, theirs the op's own miss, byte for byte a genuine
  // one. Never `already`, never a friendship, and nothing is written.
  {
    const WRITES = new Set(['addFriendship', 'removeFriendship', 'addRequest', 'deleteRequest', 'addBlock', 'removeBlock']);
    const world = async (frame, blocks, rows) => {
      const st = memStore(ROWS);
      if (rows.request) await st.addRequest(B, A);
      if (rows.friends) await st.addFriendship(A, B);
      for (const [x, y] of blocks) await st.addBlock(x, y);
      const S = mkSocial(st);
      const wa = mkws(A), wb = mkws(B);
      S.onAuth(wa); S.onAuth(wb);
      wa.rx.length = 0; wb.rx.length = 0; st.calls.length = 0;
      await S.handle(wa, { ...frame, id: 'q' });
      return { a: JSON.stringify(wa.rx), b: wb.rx.length, writes: st.calls.filter((c) => WRITES.has(c)), friends: [...st.friends], requests: [...st.requests] };
    };
    const only = (op, error) => JSON.stringify([{ type: 'friend', op, error, id: 'q' }]);
    const OPS = {
      add: { frame: { type: 'friend', op: 'add', code: 'BDF345' }, miss: 'no_such_code', genuine: { type: 'friend', op: 'add', code: 'ZZZ999' } },
      request: { frame: { type: 'friend', op: 'request', to: B }, miss: 'no_such_user', genuine: { type: 'friend', op: 'request', to: uid(99) } },
    };
    const bad = [];
    // (a) B's request to A outlived the block, and A sends a request to B.
    // Unguarded, that request is the acceptance and writes a friendship.
    {
      const rows = { request: true };
      const keep = (w) => !w.b && !w.writes.length && !w.friends.length && JSON.stringify(w.requests) === JSON.stringify([B + '>' + A]);
      const mine = await world(OPS.request.frame, [[A, B]], rows);
      const theirs = await world(OPS.request.frame, [[B, A]], rows);
      const real = await world(OPS.request.genuine, [], rows);
      if (!(mine.a === only('request', 'blocked') && keep(mine))) bad.push({ rows: 'request B>A', who: 'mine', ...mine });
      if (!(theirs.a === only('request', 'no_such_user') && theirs.a === real.a && keep(theirs))) bad.push({ rows: 'request B>A', who: 'theirs', ...theirs, genuine: real.a });
    }
    // (b) A friendship outlived the block, and A adds B by code or asks.
    for (const op of ['add', 'request']) {
      const rows = { friends: true };
      const keep = (w) => !w.b && !w.writes.length && JSON.stringify(w.friends) === JSON.stringify([pair(A, B)]) && !w.requests.length;
      const mine = await world(OPS[op].frame, [[A, B]], rows);
      const theirs = await world(OPS[op].frame, [[B, A]], rows);
      const real = await world(OPS[op].genuine, [], rows);
      if (!(mine.a === only(op, 'blocked') && keep(mine))) bad.push({ rows: 'friendship', op, who: 'mine', ...mine });
      if (!(theirs.a === only(op, OPS[op].miss) && theirs.a === real.a && keep(theirs))) bad.push({ rows: 'friendship', op, who: 'theirs', ...theirs, genuine: real.a });
    }
    if (!bad.length) ok('(db4 ii) behind a request or a friendship that outlived the block, add and request still answer the block\'s way: your own is blocked, theirs a genuine miss, never already, never a friendship, and nothing is written');
    else fail('(db4 ii) block lines against already and the acceptance: ' + JSON.stringify(bad));
  }

  // ---- (wd) withdraw: the hand twin of D-BLOCK-5 J --------------------------
  // When A blocks B and A's own pending request to B is the only row between
  // them, the block deletes that request and B's panel is pushed without it.
  // While no hand act did the same, a request vanishing from B's panel could
  // only mean a block. Withdraw is that hand act, so (v) compares what B
  // receives from each. The op reads the caller's own requests and blocks
  // and nothing else, side by side: it is not gated on blocks, and nothing
  // about the other player is read, so a withdraw aimed at someone who
  // blocked the caller answers and costs what a genuine miss does (iv).
  const WD_WRITES = new Set(['addFriendship', 'removeFriendship', 'addRequest', 'deleteRequest', 'addBlock', 'removeBlock']);
  // WHAT AN ANSWER COSTS, measured as (db4) measures it: per read, how many
  // reads had come back before it was asked. Two reads side by side are
  // [0, 0]; a read that waited for the other is [0, 1]. Installed after a
  // world is set up, so only the op under test is counted.
  const WD_READS = ['requestsOf', 'blockIdsOf'];
  const tripsOf = (st) => {
    const trips = [];
    let back = 0;
    for (const m of WD_READS) {
      const real = st[m];
      st[m] = async function (...a) { trips.push(back); try { return await real.apply(st, a); } finally { back++; } };
    }
    return trips;
  };
  {
    // (i) THE ROW GOES, AND BOTH PANELS ARE TOLD. The caller is answered ok
    // with its id echoed, then every device of the caller and the other
    // player is pushed a snapshot without the request. An upper-case id off
    // the wire is the same account. Someone else's request to B is kept.
    const st = memStore(ROWS);
    await st.addRequest(A, B);
    await st.addRequest(C, B);
    const S = mkSocial(st);
    const wa = mkws(A), wa2 = mkws(A), wb = mkws(B);
    S.onAuth(wa); S.onAuth(wa2); S.onAuth(wb);
    await sleep(60);
    wa.rx.length = 0; wa2.rx.length = 0; wb.rx.length = 0; st.calls.length = 0;
    await S.handle(wa, { type: 'friend', op: 'withdraw', to: B.toUpperCase(), id: 'w1' });
    if (same(sent(wa, 'friend'), [{ type: 'friend', op: 'withdraw', ok: true, id: 'w1' }]) && wa.rx[0] && wa.rx[0].type === 'friend')
      ok('(wd) withdraw: answered ok with the id echoed, ahead of the snapshot');
    else fail('(wd) withdraw answer: ' + JSON.stringify(wa.rx));
    if (same([...st.requests], [C + '>' + B]) && same(st.calls.filter((c) => WD_WRITES.has(c)), ['deleteRequest']))
      ok('(wd) withdraw: the caller\'s request is the one row deleted, and someone else\'s request to the same player is kept');
    else fail('(wd) withdraw rows: ' + JSON.stringify({ rows: [...st.requests], calls: st.calls }));
    const fa = sent(wa, 'friends'), fa2 = sent(wa2, 'friends'), fb = sent(wb, 'friends');
    if (fa.length === 1 && fa2.length === 1 && fb.length === 1
        && same(fa[0].requests, { in: [], out: [] }) && same(fa2[0].requests, { in: [], out: [] })
        && same(fb[0].requests, { in: [{ id: C, callsign: 'Crater Two' }], out: [] }) && fb[0].id === undefined)
      ok('(wd) withdraw: every device of the caller, and the other player, is pushed a snapshot without the request');
    else fail('(wd) withdraw pushes: ' + JSON.stringify({ a: fa, a2: fa2, b: fb }));
  }
  {
    // (ii) EVERY MISS IS no_such_request. It costs the caller's two reads
    // (none for an id that is not one) and no write, and pushes nobody: an
    // id nobody holds, B's own request to A (not A's to withdraw), someone
    // else's request, a request A already withdrew, A's own id, and ids that
    // are not ids at all.
    const st = memStore(ROWS);
    await st.addRequest(B, A);
    await st.addRequest(C, D);
    await st.addRequest(A, E);
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B), wd = mkws(D), we = mkws(E);
    for (const w of [wa, wb, wd, we]) S.onAuth(w);
    await S.handle(wa, { type: 'friend', op: 'withdraw', to: E });
    await sleep(60);
    const keep = JSON.stringify([...st.requests]);
    const bad = [];
    const MISSES = [['unknown', uid(99)], ['their request to me', B], ['someone else\'s', D], ['already withdrawn', E], ['self', A],
      ['not a uuid', 'not-a-uuid'], ['empty', ''], ['absent', undefined], ['a number', 42], ['an object', { id: E }]];
    const MALFORMED = new Set(['not a uuid', 'empty', 'absent', 'a number', 'an object']);
    for (const [what, to] of MISSES) {
      for (const w of [wa, wb, wd, we]) w.rx.length = 0;
      st.calls.length = 0;
      const frame = { type: 'friend', op: 'withdraw', id: 'q' };
      if (to !== undefined) frame.to = to;
      await S.handle(wa, frame);
      const got = { a: wa.rx, others: wb.rx.length + wd.rx.length + we.rx.length, calls: st.calls.slice(), rows: JSON.stringify([...st.requests]) };
      const reads = MALFORMED.has(what) ? [] : ['requestsOf', 'blockIdsOf'];
      if (!(same(got.a, [{ type: 'friend', op: 'withdraw', error: 'no_such_request', id: 'q' }]) && !got.others && same(got.calls, reads) && got.rows === keep))
        bad.push({ what, ...got });
    }
    if (!bad.length) ok(`(wd) withdraw: all ${MISSES.length} misses (unknown, their request, someone else's, already withdrawn, self, malformed) answer no_such_request for the caller's requests and blocks (no read for a malformed id), write nothing and push nobody`);
    else fail('(wd) withdraw misses: ' + JSON.stringify(bad));
  }
  {
    // (iii) NOT IN THE FRIEND BUCKET. A withdraw acts on a row already on the
    // player's screen, as decline and remove do: twelve of them leave a
    // search all ten of its turns, and one still goes through with the
    // bucket empty.
    const st = memStore(ROWS);
    const S = mkSocial(st);
    const wa = mkws(A), wb = mkws(B);
    S.onAuth(wa); S.onAuth(wb);
    for (let i = 0; i < 12; i++) await S.handle(wa, { type: 'friend', op: 'withdraw', to: B });
    for (let i = 0; i < 10; i++) await S.handle(wa, { type: 'friend', op: 'search', q: 'nobody here' });
    const spent = sent(wa, 'friend').filter((m) => m.error === 'slow_down').length;
    await S.handle(wa, { type: 'friend', op: 'search', q: 'nobody here' });
    const empty = (last(wa, 'friend') || {}).error === 'slow_down';
    await st.addRequest(A, B);
    await S.handle(wa, { type: 'friend', op: 'withdraw', to: B, id: 'late' });
    const l = last(wa, 'friend') || {};
    if (spent === 0 && empty && l.ok === true && l.id === 'late' && st.requests.size === 0)
      ok('(wd) withdraw: not in the friend bucket — twelve spend nothing a search needs, and one still lands with the bucket empty');
    else fail('(wd) withdraw bucket: ' + JSON.stringify({ spent, empty, l, rows: [...st.requests] }));
  }
  {
    // (iv) B BLOCKED A, AND A WITHDRAWS. B's block took A's request with it,
    // so the answer is a genuine miss, byte for byte and read for read: the
    // caller's own requests and blocks, side by side, nothing about B, and
    // nothing pushed to B. A request that OUTLIVED B's block (a half-failed
    // teardown) is hidden from A's panel by that block (e3), so it is
    // answered the same way at the same cost, and only then deleted, with
    // nobody pushed: before this, it answered ok, which a request that is
    // gone never does. `upto` is the store calls made before the answer went
    // out; `trips` is (iv)'s round-trip measure of the two reads.
    const world = async (block, row, boom = null) => {
      const st = memStore(ROWS);
      const upto = [];
      const S = createSocial({ store: st, terms: [], now: () => CLOCK,
        send: (ws, f) => { if (f.type === 'friend' && f.op === 'withdraw') upto.push(st.calls.slice()); ws.rx.push(f); } });
      const wa = mkws(A), wb = mkws(B);
      S.onAuth(wa); S.onAuth(wb);
      if (block === 'op' || row) await S.handle(wa, { type: 'friend', op: 'request', to: B });
      if (block === 'op') await S.handle(wb, { type: 'block', op: 'add', id: A });
      if (block === 'row') await st.addBlock(B, A);
      await sleep(60);
      wa.rx.length = 0; wb.rx.length = 0; st.calls.length = 0;
      const trips = tripsOf(st);
      if (boom) st.boom.add(boom);
      await S.handle(wa, { type: 'friend', op: 'withdraw', to: B, id: 'q' });
      await sleep(60);
      return { a: JSON.stringify(wa.rx), b: wb.rx.length, upto: upto[0], all: st.calls.slice(), trips, rows: [...st.requests] };
    };
    const gone = JSON.stringify([{ type: 'friend', op: 'withdraw', error: 'no_such_request', id: 'q' }]);
    const blocked = await world('op', false), miss = await world(null, false);
    if (blocked.a === gone && blocked.a === miss.a && same(blocked.all, WD_READS) && same(miss.all, WD_READS)
        && same(blocked.trips, [0, 0]) && same(miss.trips, [0, 0]) && !blocked.b && !miss.b && !blocked.rows.length)
      ok('(wd) withdraw: after B blocked A, A\'s withdraw is byte for byte a genuine miss, A\'s own requests and blocks read in one round trip and nothing about B, and B is sent nothing');
    else fail('(wd) withdraw after being blocked: ' + JSON.stringify({ blocked, miss }));
    const outlived = await world('row', true);
    if (outlived.a === miss.a && same(outlived.upto, miss.upto) && same(outlived.trips, miss.trips)
        && same(outlived.all, [...WD_READS, 'deleteRequest']) && !outlived.rows.length && !outlived.b)
      ok('(wd) withdraw: a request that outlived B\'s block, hidden from A\'s panel, is answered byte for byte as a genuine miss at the same reads and round trip, then deleted quietly: A hears nothing more and B is sent nothing');
    else fail('(wd) withdraw of a request that outlived the block: ' + JSON.stringify({ outlived, miss }));
    // The first two trips are the op's own reads; the snapshots pushed after
    // the answer read again, and are not the answer's cost.
    const plain = await world(null, true);
    if (JSON.parse(plain.a)[0].ok === true && same(plain.upto, [...WD_READS, 'deleteRequest']) && same(plain.trips.slice(0, 2), outlived.trips) && !plain.rows.length)
      ok('(wd) withdraw: a request the panel shows costs the same two reads in the same round trip as a hidden one, then is withdrawn ok');
    else fail('(wd) withdraw of a shown request: ' + JSON.stringify({ plain, outlived }));
    // The cleanup comes after the answer, so a cleanup that fails must not
    // add a second frame: an `unavailable` after no_such_request is a tell
    // a genuine miss never gives.
    const failed = await world('row', true, 'deleteRequest');
    if (failed.a === miss.a && same(failed.rows, [A + '>' + B]) && !failed.b)
      ok('(wd) withdraw: a hidden row whose cleanup fails still gets the one answer and nothing after it, and the row stays hidden for the sweep');
    else fail('(wd) withdraw, failed cleanup: ' + JSON.stringify(failed));
  }
  {
    // (v) THE TWIN (D-BLOCK-5 J). A's request to B is the only row between
    // them. In one world A blocks B; in the other A withdraws the request.
    // B, on both devices, must receive the same frames in the same order: one
    // snapshot each, without A's request, and nothing else. B's panel holds
    // a friend who is online, a request each way and a block of B's own, so
    // the snapshot compared is a full one. Each of B's sockets has a fixed
    // unblock salt, so the two worlds key B's blocked list alike.
    const world = async (act) => {
      const st = memStore(ROWS);
      await st.addRequest(A, B);
      await st.addFriendship(B, C);
      await st.addRequest(D, B);
      await st.addRequest(B, E);
      await st.addBlock(B, F);
      const S = mkSocial(st);
      const wa = mkws(A), wb = mkws(B), wb2 = mkws(B), wc = mkws(C);
      wb.blockSalt = 'salt-one'; wb2.blockSalt = 'salt-two';
      for (const w of [wa, wb, wb2, wc]) S.onAuth(w);
      await sleep(60);
      for (const w of [wa, wb, wb2, wc]) w.rx.length = 0;
      await S.handle(wa, act === 'block' ? { type: 'block', op: 'add', id: B } : { type: 'friend', op: 'withdraw', to: B });
      await sleep(60);
      return { b: JSON.stringify([wb.rx, wb2.rx]), c: wc.rx.length, fb: sent(wb, 'friends'), a: wa.rx, rows: [...st.requests], blocks: [...st.blocks] };
    };
    const blk = await world('block'), wd = await world('withdraw');
    const fb = blk.fb[0] || {};
    if (blk.fb.length === 1 && same(fb.requests, { in: [{ id: D, callsign: 'Dune Four' }], out: [{ id: E, callsign: 'Echo Seven' }] })
        && same(fb.friends, [{ id: C, callsign: 'Crater Two', online: true }]) && (fb.blocked || []).length === 1
        && same(blk.rows, [D + '>' + B, B + '>' + E]) && same(wd.rows, blk.rows) && blk.blocks.includes(A + '>' + B))
      ok('(wd) the J world: A\'s block takes A\'s request and pushes B one full snapshot without it');
    else fail('(wd) J world: ' + JSON.stringify(blk));
    if (blk.b === wd.b && !blk.c && !wd.c)
      ok('(wd) the twin: B receives, on both devices, exactly the same frames from A\'s withdraw as from A\'s block (D-BLOCK-5 J)');
    else fail('(wd) twin: ' + JSON.stringify({ block: blk.b, withdraw: wd.b, c: [blk.c, wd.c] }));
  }

  // ---- (dc) decline answers from the panel too ------------------------------
  // B's request to A is the row. In the outlived worlds it survived a block
  // that should have deleted it (A's own, B's, or both), so A's panel hides
  // it (e3). Before this, A's decline answered it ok, where a request that
  // is gone answers no_such_request: an answer that told A about B's block
  // (D-BLOCK-4). Now it is answered byte for byte as a request that is gone,
  // at the same reads in the same round trip before the answer, and only
  // then deleted, with nobody pushed. A request the panel shows is still
  // declined for the same reads, and both panels are told (e).
  {
    const world = async (blocks, row, boom = null) => {
      const st = memStore(ROWS);
      const upto = [];
      const S = createSocial({ store: st, terms: [], now: () => CLOCK,
        send: (ws, f) => { if (f.type === 'friend' && f.op === 'decline') upto.push(st.calls.slice()); ws.rx.push(f); } });
      const wa = mkws(A), wb = mkws(B);
      S.onAuth(wa); S.onAuth(wb);
      if (row) await st.addRequest(B, A);
      for (const [x, y] of blocks) await st.addBlock(x, y);
      await sleep(60);
      wa.rx.length = 0; wb.rx.length = 0; st.calls.length = 0;
      const trips = tripsOf(st);
      if (boom) st.boom.add(boom);
      await S.handle(wa, { type: 'friend', op: 'decline', from: B, id: 'q' });
      await sleep(60);
      return { a: JSON.stringify(wa.rx), b: wb.rx.length, upto: upto[0], all: st.calls.slice(), trips, rows: [...st.requests] };
    };
    const gone = JSON.stringify([{ type: 'friend', op: 'decline', error: 'no_such_request', id: 'q' }]);
    const miss = await world([], false);
    if (miss.a === gone && same(miss.all, WD_READS) && same(miss.trips, [0, 0]) && !miss.b)
      ok('(dc) decline: a request that is gone is no_such_request for the caller\'s requests and blocks, read in one round trip');
    else fail('(dc) decline miss: ' + JSON.stringify(miss));
    const bad = [];
    for (const [who, blocks] of [['A blocked B', [[A, B]]], ['B blocked A', [[B, A]]], ['both ways', [[A, B], [B, A]]]]) {
      const w = await world(blocks, true);
      if (!(w.a === miss.a && same(w.upto, miss.upto) && same(w.trips, miss.trips)
          && same(w.all, [...WD_READS, 'deleteRequest']) && !w.rows.length && !w.b))
        bad.push({ who, ...w });
    }
    if (!bad.length)
      ok('(dc) decline: a request that outlived a block (mine, theirs or both), hidden from the panel, is answered byte for byte as one that is gone, at the same reads and round trip, then deleted quietly: nothing more to A and nothing to B');
    else fail('(dc) decline of a hidden request: ' + JSON.stringify({ bad, miss }));
    // The first two trips are the op's own, as in (wd) (iv).
    const shown = await world([], true);
    const sa = JSON.parse(shown.a);
    if (sa[0] && sa[0].ok === true && same(shown.upto, [...WD_READS, 'deleteRequest']) && same(shown.trips.slice(0, 2), miss.trips) && !shown.rows.length
        && sa.filter((f) => f.type === 'friends').length === 1 && shown.b === 1)
      ok('(dc) decline: a request the panel shows is still cleared ok, for the same two reads in the same round trip, and both panels are pushed');
    else fail('(dc) decline of a shown request: ' + JSON.stringify(shown));
    const failed = await world([[B, A]], true, 'deleteRequest');
    if (failed.a === miss.a && same(failed.rows, [B + '>' + A]) && !failed.b)
      ok('(dc) decline: a hidden row whose cleanup fails still gets the one answer and nothing after it, and the row stays hidden for the sweep');
    else fail('(dc) decline, failed cleanup: ' + JSON.stringify(failed));
    // An id that is not one is in no list, so it is answered before the
    // store, as withdraw's are (wd) (ii).
    const st = memStore(ROWS);
    await st.addRequest(B, A);
    const S = mkSocial(st);
    const wa = mkws(A); S.onAuth(wa);
    const junk = [];
    for (const from of ['not-a-uuid', '', undefined, 42, { id: B }]) {
      wa.rx.length = 0; st.calls.length = 0;
      const frame = { type: 'friend', op: 'decline', id: 'q' };
      if (from !== undefined) frame.from = from;
      await S.handle(wa, frame);
      if (!(JSON.stringify(wa.rx) === gone && !st.calls.length && st.requests.size === 1)) junk.push({ from, a: wa.rx, calls: st.calls.slice() });
    }
    if (!junk.length) ok('(dc) decline: an id that is not one is no_such_request with no store call at all');
    else fail('(dc) decline, malformed ids: ' + JSON.stringify(junk));
  }

  // ---- (hq) a hidden row's cleanup holds up no frame behind it --------------
  // The cleanup of a hidden row goes after the answer ((wd) iv, (dc)), and it
  // must not go IN FRONT OF the caller's next frame either: handle() runs one
  // socket's social frames in order, so a cleanup the op awaited held that
  // frame for the delete's round trip, where after a genuine miss it is
  // answered at once, and a cheap frame sent straight behind the op timed the
  // block (D-BLOCK-4, D-BLOCK-5). Here the delete is HELD, a store that has
  // not come back, and the probe behind the op (a withdraw of an id that is
  // not one, answered before the store) must be answered while it is still
  // held, after the very store calls that had come back behind a genuine
  // miss. Released, the hidden row still goes, and B hears nothing.
  {
    const world = async (op, hidden) => {
      const st = memStore(ROWS);
      let back = 0, release = null;
      const held = new Promise((r) => { release = r; });
      const at = [];
      const S = createSocial({ store: st, terms: [], now: () => CLOCK,
        send: (ws, f) => { if (f.id === 'p') at.push({ back, calls: st.calls.slice() }); ws.rx.push(f); } });
      const wa = mkws(A), wb = mkws(B);
      S.onAuth(wa); S.onAuth(wb);
      if (hidden) { await (op === 'withdraw' ? st.addRequest(A, B) : st.addRequest(B, A)); await st.addBlock(B, A); }
      await sleep(60);
      wa.rx.length = 0; wb.rx.length = 0; st.calls.length = 0;
      for (const m of [...WD_READS, 'deleteRequest']) {
        const real = st[m];
        st[m] = async function (...a) { try { if (m === 'deleteRequest') await held; return await real.apply(st, a); } finally { back++; } };
      }
      const p1 = S.handle(wa, op === 'withdraw' ? { type: 'friend', op, to: B, id: 'q' } : { type: 'friend', op, from: B, id: 'q' });
      const p2 = S.handle(wa, { type: 'friend', op: 'withdraw', to: 'not-a-uuid', id: 'p' });
      await sleep(60);
      const early = { a: JSON.stringify(wa.rx), at: at.slice(), rows: [...st.requests] };
      release();
      await Promise.all([p1, p2]);
      await sleep(60);
      return { ...early, after: [...st.requests], b: wb.rx.length };
    };
    const bad = [];
    for (const op of ['withdraw', 'decline']) {
      const miss = await world(op, false), hid = await world(op, true);
      const want = JSON.stringify([{ type: 'friend', op, error: 'no_such_request', id: 'q' }, { type: 'friend', op: 'withdraw', error: 'no_such_request', id: 'p' }]);
      if (!(miss.a === want && hid.a === want && same(miss.at, [{ back: 2, calls: WD_READS }]) && same(hid.at, miss.at)
          && hid.rows.length === 1 && !hid.after.length && !hid.b && !miss.b))
        bad.push({ op, miss, hid });
    }
    if (!bad.length)
      ok('(hq) withdraw and decline: a frame sent behind a hidden row is answered while the row\'s delete is still out, after the same store calls as behind a genuine miss, and the row still goes when the delete lands');
    else fail('(hq) a frame queued behind a hidden row\'s cleanup: ' + JSON.stringify(bad));
  }
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall social checks passed');
process.exit(out.errors.length ? 1 : 0);
