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

// ---- (j) the handlers Tasks 5 and 6 own answer rather than hang -------------
{
  clock = BASE;
  const { social } = mk();
  const ws = mkws('u1');
  await social.handle(ws, { type: 'friends', id: 9 });
  if (same(last(ws), { type: 'friends', error: 'unavailable', id: 9 })) ok('(j) an unimplemented social type answers unavailable, so no client waits for ever');
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

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall social checks passed');
process.exit(out.errors.length ? 1 : 0);
