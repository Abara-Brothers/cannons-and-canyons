// EVERY PLAYER'S ONE NAME, HELD BY THE SERVER (owner, 2026-10-10, item 28:
// "Ensure that usernames must be unique and no 2 players can have the same
// exact name"), in process: server/reservations.js against a fake of its
// table that keeps the table's three unique constraints, the social layer
// built on top of it exactly as server.js builds it, and the REAL room engine's
// door with the two hooks server.js installs. No server, no Supabase, no
// sockets, and a clock this file moves.
//
//   A. off until the table answers: a missing table is the old rules, and the
//      feature turns on when the table appears, with no restart
//   B. the first to reserve keeps a name; anyone else gets a new unused default
//      and `moved: 'taken'`, once; capitals and look-alike letters collide
//   C. the holder: a device by its secret (only the hash is stored), the move
//      to an account keeps the name, an account's own row, a chosen callsign
//   D. defaults are always unused, the numbered tier when the pairs run out,
//      never a computer's name, never a chosen callsign
//   E. the two namespaces never overlap: a claim refuses a chosen callsign,
//      the Set refuses a reserved name, an unknown chosen index fails closed
//   F. renames, the 90-day sweep, last_seen_at, the process-wide bucket, a
//      unique conflict the memory did not know about, two sockets racing
//   G. the social layer: the claim frame, the guest's rename, the Set, the
//      squad row, a hello landing mid-claim
//   H. the engine's door: a socket seats its reserved name whatever it sends,
//      nobody else's name is shown, the stand-in is unused, offline unchanged
import { createReservations, RESERVATIONS_OFF, DEFAULT_TIERS, SECRET_RE, hashSecret, nameKeyOf, combineStates, RESERVE_TTL_MS, TOUCH_MS, MINT_BURST } from '../server/reservations.js';
import { createNameProofs } from '../server/display-name.js';
import { loadBlocklist, keyReadings } from '../server/callsign.js';
import { createSocial } from '../server/social.js';
import { isGeneratedCallsign, callsignFromSeed } from '../public/game-core.js';
import { fileURLToPath } from 'node:url';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// THE SHIPPED BLOCKLIST, as server.js loads it: the guidelines every name
// meets are display-name.js's checkPlayerName over the real term list.
const TERMS = loadBlocklist(fileURLToPath(new URL('../server/blocklist.txt', import.meta.url)));
const BASE = Date.parse('2026-10-10T09:00:00Z');
let clock = BASE;
const now = () => clock;
const iso = (t) => new Date(t).toISOString();
// A seeded pick, so a failure here can be run again exactly.
let seed = 12345;
const pick = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

// ---- the fake table ------------------------------------------------------------
// name_reservations as the migration makes it: name_key, secret_hash and
// user_id each UNIQUE (two nulls never clash), and every write answering as
// server/store.js answers. `before` runs ahead of an insert, which is how
// another instance's write lands between this process's read and its write.
function mkTable() {
  const t = { rows: [], seq: 0, calls: [], keysFail: null, before: null };
  const pub = (r) => (r ? { ...r } : null);
  const clash = (r) => t.rows.some((o) => o.name_key === r.name_key || (r.secret_hash && o.secret_hash === r.secret_hash) || (r.user_id && o.user_id === r.user_id));
  Object.assign(t, {
    async reservationKeys(after, limit) {
      t.calls.push(['keys']);
      if (t.keysFail) throw t.keysFail;
      return t.rows.map((r) => r.name_key).sort().filter((k) => !after || k > after).slice(0, limit);
    },
    async reservationByUser(id) { t.calls.push(['byUser']); return pub(t.rows.find((r) => r.user_id === id)); },
    async reservationBySecret(h) { t.calls.push(['bySecret']); return /^[0-9a-f]{64}$/.test(h) ? pub(t.rows.find((r) => r.secret_hash === h)) : null; },
    async reservationsByKeys(keys) { t.calls.push(['byKeys']); return [...new Set(keys)].map((k) => t.rows.find((r) => r.name_key === k)).filter(Boolean).map((r) => ({ name_key: r.name_key, user_id: r.user_id || null })); },
    async insertReservation({ name, key, secretHash = null, userId = null, linked = false }) {
      t.calls.push(['insert', name]);
      if (t.before) { const f = t.before; t.before = null; f(); }
      const r = { id: ++t.seq, name, name_key: key, secret_hash: secretHash, user_id: userId, linked: !!linked, created_at: iso(clock), last_seen_at: iso(clock) };
      if (clash(r)) return { ok: false };
      t.rows.push(r);
      return { ok: true, row: pub(r) };
    },
    async moveReservation(id, userId, linked, at) {
      t.calls.push(['move']);
      const r = t.rows.find((x) => x.id === id && !x.user_id);
      if (!r || t.rows.some((o) => o.user_id === userId)) return null;
      Object.assign(r, { user_id: userId, linked: !!linked, last_seen_at: iso(at) });
      return pub(r);
    },
    async attachSecret(id, h) {
      t.calls.push(['attach']);
      const r = t.rows.find((x) => x.id === id && !x.secret_hash);
      if (!r || t.rows.some((o) => o.secret_hash === h)) return null;
      r.secret_hash = h;
      return pub(r);
    },
    async renameReservation(id, name, key, at) {
      t.calls.push(['rename', name]);
      const r = t.rows.find((x) => x.id === id);
      if (!r) return { ok: false, error: 'gone' };
      if (t.rows.some((o) => o !== r && o.name_key === key)) return { ok: false, error: 'taken' };
      Object.assign(r, { name, name_key: key, last_seen_at: iso(at) });
      return { ok: true, row: pub(r) };
    },
    async touchReservation(id, linked, at) { t.calls.push(['touch']); const r = t.rows.find((x) => x.id === id); if (r) Object.assign(r, { last_seen_at: iso(at), linked: !!linked }); },
    async deleteReservationOfUser(uid) { t.calls.push(['release']); const gone = t.rows.filter((r) => r.user_id === uid); t.rows = t.rows.filter((r) => r.user_id !== uid); return gone.map((r) => r.name_key); },
    async sweepReservations(before) { t.calls.push(['sweep']); const gone = t.rows.filter((r) => !r.linked && Date.parse(r.last_seen_at) < before); t.rows = t.rows.filter((r) => !gone.includes(r)); return gone.map((r) => r.name_key); },
  });
  return t;
}
const byName = (t, n) => t.rows.find((r) => r.name === n);

// THE CHOSEN CALLSIGNS: an index that has loaded, answering as
// server/name-index.js does (a key or any of its readings is 'taken').
function mkChosen(keys = []) {
  const set = new Set(keys);
  let known = true;
  return {
    set, unknown(v) { known = !v; },
    state: (k) => (!known ? 'unknown' : set.has(k) || [...set].some((x) => keyReadings(x).includes(k)) ? 'taken' : 'free'),
    lookalikes: (r) => (!known ? null : [...set].filter((x) => keyReadings(x).includes(r))),
    add: (k) => set.add(k), remove: (k) => set.delete(k),
  };
}

// ONE WORLD, built as server.js builds it: the proofs over the shipped list,
// keyState over both namespaces, the reservations over the table.
function world({ chosen = [], table = mkTable(), sweeps = [] } = {}) {
  const ci = mkChosen(chosen);
  let res = null;
  const keyState = (k) => combineStates(ci.state(k), res ? res.state(k) : 'free');
  const proofs = createNameProofs({ terms: TERMS, keyState });
  // How many names met the full guidelines (D asks it of the default pick).
  const counted = { n: 0 };
  const checkName = (raw) => { counted.n++; return proofs.checkPlayerName(raw); };
  res = createReservations({ store: table, chosenState: ci.state, checkName, now, pick, schedule: (fn, ms) => { sweeps.push({ fn, ms }); return () => {}; } });
  return { table, ci, res, proofs, sweeps, counted };
}
const secretOf = (r) => (r && typeof r.secret === 'string' ? r.secret : null);

// ==== A. off until the table answers ============================================
{
  const w = world();
  w.table.keysFail = new Error('sb GET 404');
  const before = await w.res.claim({ name: 'Dune Viper' });
  await w.res.refresh();
  // A device with a secret and an account: nothing is read for it either, so
  // a missing table costs no request per connect.
  const after404 = await w.res.claim({ userId: U1, linked: true, secret: 'A'.repeat(43), name: 'Dune Viper' });
  if (!w.res.ready && same(before, { ok: false, error: 'unavailable' }) && same(after404, { ok: false, error: 'unavailable' })
      && w.res.state('dune viper') === 'free' && w.res.free('Dune Viper') === true && (await w.res.takenFor(['dune viper'], U1)) === false
      && same(await w.res.rename({ id: 1, name_key: 'x' }, 'Iron Hawk'), { ok: false, error: 'unavailable' }) && (await w.res.sweep()) === 0
      && !w.table.calls.some(([c]) => c === 'insert' || c === 'byUser' || c === 'bySecret'))
    ok('A: with the table missing (a 404 on its read) every answer is the old rules: a claim is "unavailable", every name is free, the Set is never refused, nothing is written or read but the retry');
  else fail('A: off: ' + JSON.stringify({ ready: w.res.ready, before, after404, calls: w.table.calls }));
  // The migration lands: the next read turns it on, no restart.
  w.table.keysFail = null;
  await w.res.refresh();
  const on = await w.res.claim({ name: 'Dune Viper' });
  if (w.res.ready && on.ok && on.name === 'Dune Viper' && byName(w.table, 'Dune Viper')) ok('A: the first read after the table appears turns it on, and the next claim reserves');
  else fail('A: on: ' + JSON.stringify({ ready: w.res.ready, on }));
  // And the stand-in a host with no Supabase uses.
  if (RESERVATIONS_OFF.ready === false && RESERVATIONS_OFF.state('x') === 'free' && RESERVATIONS_OFF.free('Dune Viper') === true
      && same(await RESERVATIONS_OFF.claim({ name: 'x' }), { ok: false, error: 'unavailable' }) && (await RESERVATIONS_OFF.takenFor(['x'], U1)) === false)
    ok('A: RESERVATIONS_OFF (no Supabase, and createSocial\'s default) answers every question the old way');
  else fail('A: RESERVATIONS_OFF');
}

// ==== B. first keeps it ==========================================================
{
  const w = world();
  await w.res.refresh();
  const a = await w.res.claim({ name: '  Dune   Viper ' });
  const row = byName(w.table, 'Dune Viper');
  const sa = secretOf(a);
  if (a.ok && a.name === 'Dune Viper' && !a.moved && SECRET_RE.test(sa || '') && row && row.secret_hash === hashSecret(sa) && row.name_key === 'dune viper'
      && !JSON.stringify(w.table.rows).includes(sa) && row.user_id === null)
    ok('B: the first claim reserves the name (normalised), issues a 43-character secret, and the table holds only its SHA-256, never the secret');
  else fail('B: first: ' + JSON.stringify({ a, row }));
  const seen = new Set(['dune viper']);
  const tries = [['Dune Viper', 'the same name'], ['dune viper', 'in lower case'], ['DUNE VIPER', 'in capitals'],
    ['\uFF24une Viper', 'with a fullwidth D'], ['Dune V\u0131\u0307per', 'with a dotless i and a dot above']];
  const bad = [];
  for (const [n, how] of tries) {
    const r = await w.res.claim({ name: n });
    const held = r.ok && w.table.rows.find((x) => x.name === r.name);
    if (!(r.ok && r.moved === 'taken' && r.name !== 'Dune Viper' && isGeneratedCallsign(r.name) && held && !seen.has(held.name_key))) bad.push({ how, r });
    if (held) seen.add(held.name_key);
  }
  // And none of them cost a doomed write: memory knew the name was held.
  const doomed = w.table.calls.filter(([c, n]) => c === 'insert' && n !== 'Dune Viper' && tries.some(([t]) => t === n)).length
    + w.table.calls.filter(([c, n]) => c === 'insert' && n === 'Dune Viper').length - 1;
  if (!bad.length && w.table.rows.length === 1 + tries.length && doomed === 0)
    ok(`B: ${tries.length} later players presenting the name (${tries.map(([, h]) => h).join(', ')}) each get a new unused default and moved: 'taken', and not one of them first tries a write that must fail`);
  else fail('B: later players: ' + JSON.stringify(bad));
  // A WHOLE-SCRIPT LOOK-ALIKE: 'Coco' held in Latin letters, presented in
  // Cyrillic ones (the same pixels, another key). A name that MIXES scripts
  // never gets this far: the guidelines refuse it first, so it cannot collide.
  await w.res.claim({ name: 'Coco' });
  const cyr = await w.res.claim({ name: '\u0421\u043e\u0441\u043e' });
  const mixed = await w.res.claim({ name: 'Dune V\u0456per' });
  if (cyr.ok && cyr.moved === 'taken' && cyr.name !== 'Coco' && mixed.ok && mixed.moved === 'refused')
    ok('B: \'Coco\' spelt in Cyrillic letters collides with the Latin \'Coco\' (moved: \'taken\'), and a mixed-script spelling is refused by the guidelines before it can collide (moved: \'refused\')');
  else fail('B: look-alike scripts: ' + JSON.stringify({ cyr, mixed }));
  // The holder comes back with a different name on their device: the server's wins, and nothing is said.
  const rowsNow = w.table.rows.length;
  const back = await w.res.claim({ secret: sa, name: 'Something Else' });
  if (back.ok && back.name === 'Dune Viper' && !back.moved && !back.secret && w.table.rows.length === rowsNow)
    ok('B: the holder returning with its secret is answered its own name whatever name it presents, with no notice and no new row');
  else fail('B: holder back: ' + JSON.stringify(back));
  // fresh: a device's first default, swapped silently.
  const fr = await w.res.claim({ name: 'Dune Viper', fresh: true });
  if (fr.ok && fr.name !== 'Dune Viper' && !fr.moved) ok('B: a device\'s fresh first default that is taken is swapped for an unused one without a notice (nobody has seen it yet)');
  else fail('B: fresh: ' + JSON.stringify(fr));
  // A name the guidelines refuse is replaced too, and said as refused, not taken.
  const r1 = await w.res.claim({ name: 'CPU 2' }), r2 = await w.res.claim({ name: 'x' }), r3 = await w.res.claim({ name: '' });
  if ([r1, r2, r3].every((r) => r.ok && r.moved === 'refused' && isGeneratedCallsign(r.name)))
    ok('B: a presented name the guidelines refuse (a computer\'s name, too short, empty) gets a default with moved: \'refused\'');
  else fail('B: refused: ' + JSON.stringify([r1, r2, r3]));
}

// ==== C. the holder and the move to an account ==================================
{
  const w = world();
  await w.res.refresh();
  const g = await w.res.claim({ name: 'Iron Hawk' });
  const sec = secretOf(g);
  const rowId = byName(w.table, 'Iron Hawk').id;
  // First save: an anonymous account. The device's row MOVES, name and all.
  const m = await w.res.claim({ userId: U1, linked: false, secret: sec, name: 'Iron Hawk' });
  const moved = w.table.rows.find((r) => r.id === rowId);
  if (m.ok && m.name === 'Iron Hawk' && !m.moved && moved.user_id === U1 && moved.secret_hash === hashSecret(sec) && w.table.rows.length === 1 && !w.table.calls.some(([c]) => c === 'release'))
    ok('C: a guest who gets an account keeps the name: the same row moves to the account, still carrying the device\'s secret, and nothing is released or re-reserved');
  else fail('C: move: ' + JSON.stringify({ m, rows: w.table.rows }));
  // Another player cannot slip in: the name is held throughout.
  const other = await w.res.claim({ name: 'Iron Hawk' });
  // The account from a device with no secret, and the device with its secret but no session.
  const acct = await w.res.claim({ userId: U1, linked: false, name: 'Whatever Else' });
  const dev = await w.res.claim({ secret: sec, name: 'Whatever Else' });
  if (other.moved === 'taken' && acct.name === 'Iron Hawk' && dev.name === 'Iron Hawk' && !acct.secret)
    ok('C: after the move the account (from any device) and the device (signed out, or its session lost) are both answered "Iron Hawk", and nobody else can take it');
  else fail('C: after move: ' + JSON.stringify({ other, acct, dev }));
  // Linking the anonymous account (the same id): the row is marked linked.
  clock += 2 * TOUCH_MS;
  await w.res.claim({ userId: U1, linked: true, secret: sec, name: 'Iron Hawk' });
  if (w.table.rows.find((r) => r.id === rowId).linked === true) ok('C: when the account is linked the row is marked linked (and so is never swept)');
  else fail('C: linked flag: ' + JSON.stringify(w.table.rows));
  // An account with no row and a device with none: a new row, carrying a new secret.
  const n2 = await w.res.claim({ userId: U2, linked: true, name: 'Rusty Mule' });
  const r2 = byName(w.table, 'Rusty Mule');
  if (n2.ok && SECRET_RE.test(secretOf(n2) || '') && r2.user_id === U2 && r2.linked === true && r2.secret_hash === hashSecret(secretOf(n2)))
    ok('C: an account with no row reserves its name, and the device it claimed from gets a secret on that row');
  else fail('C: new account row: ' + JSON.stringify({ n2, r2 }));
  // An account row reserved before this device had a secret gets this device's secret.
  w.table.rows.push({ id: ++w.table.seq, name: 'Bold Coyote', name_key: 'bold coyote', secret_hash: null, user_id: U3, linked: true, created_at: iso(clock), last_seen_at: iso(clock) });
  await w.res.refresh();
  const n3 = await w.res.claim({ userId: U3, linked: true, name: 'Bold Coyote' });
  if (n3.name === 'Bold Coyote' && SECRET_RE.test(secretOf(n3) || '') && byName(w.table, 'Bold Coyote').secret_hash === hashSecret(secretOf(n3)))
    ok('C: an account\'s row with no device on it takes this device\'s new secret, so a sign-out later keeps the name here too');
  else fail('C: attach: ' + JSON.stringify({ n3, row: byName(w.table, 'Bold Coyote') }));
  // A secret the server never issued (or one whose row went) is no secret: a new one is issued.
  const forged = 'A'.repeat(43);
  const f = await w.res.claim({ secret: forged, name: 'Mad Rim' });
  if (f.ok && secretOf(f) && secretOf(f) !== forged && byName(w.table, f.name).secret_hash === hashSecret(secretOf(f)))
    ok('C: a well-formed secret no row holds is not believed: the device gets a new one with its new row');
  else fail('C: forged secret: ' + JSON.stringify(f));
  // A linked account with a chosen callsign: that is its name, and any row it held is released.
  const n4 = await w.res.claim({ userId: U2, linked: true, chosen: 'Marguerite Vale', name: 'Rusty Mule' });
  if (n4.ok && n4.chosen === true && n4.name === 'Marguerite Vale' && !byName(w.table, 'Rusty Mule') && w.res.state('rusty mule') === 'free')
    ok('C: a linked account holding a chosen callsign is answered with it, and the row it had is released: one name per player');
  else fail('C: chosen: ' + JSON.stringify({ n4, rows: w.table.rows.map((r) => r.name) }));
  // An anonymous account is never answered "chosen", whatever the socket says.
  const n5 = await w.res.claim({ userId: U3, linked: false, chosen: 'Marguerite Vale', name: 'Bold Coyote' });
  if (n5.name === 'Bold Coyote' && !n5.chosen) ok('C: a chosen name on a guest\'s socket is ignored: only a linked account holds one');
  else fail('C: guest chosen: ' + JSON.stringify(n5));
}

// ==== D. defaults are always unused =============================================
{
  const [pairs, numbered] = DEFAULT_TIERS;
  const w = world({ chosen: ['amber anvil'] });
  await w.res.refresh();
  if (pairs.length === 1454 && numbered.length === 1454 * 8 && pairs.every(isGeneratedCallsign) && numbered.every((n) => [...n].length <= 16))
    ok('D: the defaults are the 1,454 rolled pairs, then the same pairs numbered 2 to 9 (11,632 more), every one within 16 characters');
  else fail('D: tiers: ' + JSON.stringify([pairs.length, numbered.length]));
  // Every default meets the guidelines, so none passes for a computer's name.
  const refused = [...pairs, ...numbered].filter((n) => !w.proofs.checkPlayerName(n).ok);
  if (!refused.length) ok('D: all 13,086 defaults meet the guidelines over the shipped blocklist: none is a computer\'s name, none is refused');
  else fail('D: refused defaults: ' + refused.slice(0, 5).join(', '));
  // Fill all but three pairs: the next moves get exactly those three, then numbered names.
  const free3 = new Set([pairs[5], pairs[700], pairs[1400]]);
  for (const p of pairs) if (!free3.has(p)) w.table.rows.push({ id: ++w.table.seq, name: p, name_key: nameKeyOf(p), secret_hash: 'f'.repeat(48) + String(w.table.seq).padStart(16, '0'), user_id: null, linked: false, created_at: iso(clock), last_seen_at: iso(clock) });
  await w.res.refresh();
  const got = [];
  w.counted.n = 0;
  for (let i = 0; i < 5; i++) { const r = await w.res.claim({ name: pairs[0] }); got.push(r.name); }
  const firstThree = new Set(got.slice(0, 3));
  // FIVE MOVES, AND THE GUIDELINES RAN ONLY ON FREE NAMES: once per presented
  // name and once per default given, never on the 1,451 held pairs walked past.
  if (same([...firstThree].sort(), [...free3].sort()) && numbered.includes(got[3]) && numbered.includes(got[4]) && got[3] !== got[4] && new Set(got).size === 5 && w.counted.n <= 10)
    ok(`D: with all but three pairs held, five moved players get exactly those three (${[...free3].join(', ')}), then numbered names (${got[3]}, ${got[4]}), never one twice, and the guidelines ran ${w.counted.n} times, never on a held name`);
  else fail('D: exhaustion: ' + JSON.stringify({ got, checks: w.counted.n }));
  // Never a chosen callsign or a look-alike of one.
  const w2 = world({ chosen: pairs.slice(1).map((p) => p.toLowerCase()) });
  await w2.res.refresh();
  const only = await w2.res.claim({ name: 'Not Mine' });
  const c2 = await w2.res.claim({ name: 'Not Mine' });
  if (only.name === 'Not Mine' && c2.moved === 'taken' && c2.name === pairs[0]) ok('D: with every pair but one held as chosen callsigns, a moved player gets that one pair');
  else fail('D: chosen-aware default: ' + JSON.stringify({ only, c2 }));
}

// ==== E. two namespaces, never overlapping ========================================
{
  const w = world({ chosen: ['viper', 'coco'] });
  await w.res.refresh();
  const c1 = await w.res.claim({ name: 'Viper' });
  const c2 = await w.res.claim({ name: '\u0421\u043e\u0441\u043e' });
  const c3 = await w.res.claim({ name: 'VIPER' });
  if ([c1, c2, c3].every((r) => r.ok && r.moved === 'taken' && r.name !== 'Viper') && !w.table.rows.some((r) => r.name_key === 'viper' || r.name_key === 'coco'))
    ok('E: a guest can never reserve an account\'s chosen callsign, in any capitals or with a look-alike letter');
  else fail('E: chosen refused: ' + JSON.stringify([c1, c2, c3]));
  // And the Set: another holder's reservation refuses it; the account's own does not.
  const g = await w.res.claim({ name: 'Copper Spire' });
  const own = await w.res.claim({ userId: U1, linked: true, name: 'Iron Ridge' });
  const blocked = await w.res.takenFor(keyReadings('copper spire'), U1);
  const mine = await w.res.takenFor(keyReadings('iron ridge'), U1);
  const fresh = await w.res.takenFor(keyReadings('quiet dawn'), U1);
  if (g.ok && own.ok && blocked === true && mine === false && fresh === false)
    ok('E: takenFor (the Set\'s check, read from the table) says yes for another player\'s reservation and no for the account\'s own or a free name');
  else fail('E: takenFor: ' + JSON.stringify({ blocked, mine, fresh }));
  // An index of chosen callsigns that cannot answer refuses a new reservation, as the door does.
  w.ci.unknown(true);
  const u = await w.res.claim({ name: 'Quiet Dawn' });
  const kept = await w.res.claim({ secret: secretOf(g), name: 'x' });
  w.ci.unknown(false);
  if (same(u, { ok: false, error: 'unavailable' }) && kept.ok && kept.name === 'Copper Spire')
    ok('E: while the chosen callsigns are unknown a NEW reservation is refused "unavailable" (fail closed), and a holder is still answered its own name');
  else fail('E: unknown: ' + JSON.stringify({ u, kept }));
}

// ==== F. renames, sweep, touch, the bucket, conflicts, races ====================
{
  const w = world();
  await w.res.refresh();
  const a = await w.res.claim({ name: 'Grim Gulch' });
  const b = await w.res.claim({ name: 'Sly Bandit' });
  const rn = await w.res.rename(a.row, 'Quiet Dawn');
  const freed = await w.res.claim({ name: 'Grim Gulch' });
  const clash = await w.res.rename(b.row, 'quiet dawn');
  const recase = await w.res.rename(b.row, 'SLY bandit');
  const rule = await w.res.rename(b.row, 'CPU 3');
  if (rn.ok && rn.name === 'Quiet Dawn' && freed.ok && freed.name === 'Grim Gulch' && !freed.moved && same(clash, { ok: false, error: 'taken' })
      && recase.ok && recase.name === 'SLY bandit' && byName(w.table, 'SLY bandit') && rule.ok === false && rule.error === 'not_allowed')
    ok('F: a rename frees the old name at once (the next player reserves it), refuses another\'s name in other capitals, lets a holder re-case their own, and meets the guidelines');
  else fail('F: rename: ' + JSON.stringify({ rn, freed, clash, recase, rule }));
  // A rename that loses on the table (another instance wrote the key) is 'taken'; a row that has gone is 'gone'.
  w.table.rows.push({ id: ++w.table.seq, name: 'Lucky Raven', name_key: 'lucky raven', secret_hash: 'e'.repeat(64), user_id: null, linked: false, created_at: iso(clock), last_seen_at: iso(clock) });
  const lost = await w.res.rename(rn.row, 'Lucky Raven');
  const gone = await w.res.rename({ id: 9999, name: 'X', name_key: 'nobody' }, 'Feral Fuse');
  if (same(lost, { ok: false, error: 'taken' }) && w.res.state('lucky raven') === 'taken' && same(gone, { ok: false, error: 'gone' }))
    ok('F: a rename the table refuses is "taken" (and now known), and a row that has gone answers "gone"');
  else fail('F: rename conflicts: ' + JSON.stringify({ lost, gone }));
  // THE SWEEP: unlinked rows unseen for 90 days go, linked ones stay, and their names are free again.
  const L = await w.res.claim({ userId: U1, linked: true, name: 'Steady Hawk' });
  const touches = w.table.calls.filter(([c]) => c === 'touch').length;
  clock += TOUCH_MS / 2;
  await w.res.claim({ secret: secretOf(a), name: 'x' });
  const noTouch = w.table.calls.filter(([c]) => c === 'touch').length === touches;
  clock += RESERVE_TTL_MS + 1000;
  await w.res.claim({ secret: secretOf(b), name: 'x' });          // b connects: its row is touched and stays
  const touched = w.table.calls.filter(([c]) => c === 'touch').length === touches + 1;
  const n = await w.res.sweep();
  const left = w.table.rows.map((r) => r.name).sort();
  const again = await w.res.claim({ name: 'Grim Gulch' });
  if (noTouch && touched && L.ok && n === 3 && same(left, ['SLY bandit', 'Steady Hawk']) && again.ok && again.name === 'Grim Gulch' && !again.moved)
    ok('F: last_seen_at is written at most once a day; the sweep deletes every unlinked row unseen for 90 days (3 here), keeps a linked one and one seen today, and their names are free again');
  else fail('F: sweep: ' + JSON.stringify({ noTouch, touched, n, left, again }));
  // The sweep runs a minute after start and then daily, on an unref'd timer of the host's.
  const w3 = world();
  w3.res.start();
  const armed = w3.sweeps.map((s) => s.ms);
  await w3.res.refresh();
  w3.sweeps[0].fn();
  await new Promise((r) => setTimeout(r, 10));
  w3.res.stop();
  if (armed[0] === 60000 && w3.sweeps[1] && w3.sweeps[1].ms === 86400000 && w3.table.calls.some(([c]) => c === 'sweep'))
    ok('F: start() arms the sweep a minute after boot and then every 24 hours');
  else fail('F: sweep timer: ' + JSON.stringify(w3.sweeps.map((s) => s.ms)));
}
{
  // THE PROCESS-WIDE BUCKET on new rows.
  const w = world();
  await w.res.refresh();
  const first = await w.res.claim({ name: 'Ashen Mesa' });
  let made = 1, refused = null;
  for (let i = 0; i < MINT_BURST + 5 && !refused; i++) {
    const r = await w.res.claim({ name: `Ashen Mesa ${i}`.slice(0, 16) });
    if (r.ok) made++; else refused = r;
  }
  const holder = await w.res.claim({ secret: secretOf(first), name: 'x' });
  clock += 60000;
  const later = await w.res.claim({ name: 'Brass Butte' });
  if (made === MINT_BURST && same(refused, { ok: false, error: 'slow_down' }) && holder.ok && holder.name === 'Ashen Mesa' && later.ok)
    ok(`F: ${MINT_BURST} new rows in an instant and the next new-row claim is "slow_down"; a holder is still answered, and a minute later new rows are made again`);
  else fail('F: bucket: ' + JSON.stringify({ made, refused, holder, later }));
}
{
  // A UNIQUE CONFLICT MEMORY DID NOT KNOW ABOUT (another instance reserved it a
  // moment ago): the claim falls to a default and says 'taken'.
  const w = world();
  await w.res.refresh();
  w.table.before = () => w.table.rows.push({ id: ++w.table.seq, name: 'Molten Shell', name_key: 'molten shell', secret_hash: 'd'.repeat(64), user_id: null, linked: false, created_at: iso(clock), last_seen_at: iso(clock) });
  const r = await w.res.claim({ name: 'Molten Shell' });
  if (r.ok && r.moved === 'taken' && r.name !== 'Molten Shell' && w.res.state('molten shell') === 'taken')
    ok('F: a name another instance reserved between the read and the write loses on the table\'s unique key, and the player gets a default with moved: \'taken\'');
  else fail('F: conflict: ' + JSON.stringify(r));
  // Two sockets of one account claiming at once: one row, one name for both.
  const [x, y] = await Promise.all([w.res.claim({ userId: U2, linked: true, name: 'Cobalt Rider' }), w.res.claim({ userId: U2, linked: true, name: 'Other Name' })]);
  const rows = w.table.rows.filter((q) => q.user_id === U2);
  if (x.ok && y.ok && x.name === y.name && rows.length === 1) ok(`F: two sockets of one account claiming at once end with one row and one name ('${x.name}') for both`);
  else fail('F: race: ' + JSON.stringify({ x, y, rows }));
}

// ==== G. the social layer =========================================================
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const mkws = (userId = null, isGuest = false) => ({ readyState: 1, userId, isGuest, chosenName: null, authGen: 1, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });
const last = (ws) => ws._rx[ws._rx.length - 1];
function socialWorld(opts = {}) {
  const w = world(opts);
  const store = Object.assign(w.table, {
    async profileById(id) { return w.profiles.get(id) || null; },
    async profilesByIds(ids) { const m = new Map(); for (const id of ids) if (w.profiles.has(id)) m.set(id, w.profiles.get(id)); return m; },
    async setChosenCallsign(id, name, key) { const p = w.profiles.get(id) || { id }; Object.assign(p, { callsign: name, callsign_key: key, callsign_set_at: iso(clock) }); w.profiles.set(id, p); w.ci.add(key); return { ok: true }; },
    async clearCallsignKey() {},
    async blockIdsOf() { return { blocked: [], blockedBy: [] }; },
  });
  w.profiles = new Map();
  w.social = createSocial({ store, terms: TERMS, send, now, names: w.ci, reservations: w.res });
  return w;
}
{
  const w = socialWorld();
  await w.res.refresh();
  const a = mkws(), b = mkws(), c = mkws();
  await w.social.handle(a, { type: 'name', name: 'Dune Viper', id: 1 });
  const ra = last(a);
  await w.social.handle(b, { type: 'name', name: 'dune viper', id: 2 });
  const rb = last(b);
  await w.social.handle(c, { type: 'name', name: 'Iron Hawk', secret: ra.secret, id: 3 });
  const rc = last(c);
  if (ra.type === 'name' && ra.ok && ra.name === 'Dune Viper' && SECRET_RE.test(ra.secret) && ra.id === 1 && !('moved' in ra) && a.reservedName === 'Dune Viper' && a.nameRow && a.nameRow.name_key === 'dune viper'
      && rb.ok && rb.moved === 'taken' && rb.name !== 'Dune Viper' && b.reservedName === rb.name
      && rc.ok && rc.name === 'Dune Viper' && !rc.secret && !rc.moved && c.reservedName === 'Dune Viper')
    ok('G: the name frame: the first socket reserves and gets its secret; the next gets a default with moved: \'taken\'; a second socket of the first device (its secret) is answered the same name; each socket carries its name');
  else fail('G: claim frames: ' + JSON.stringify({ ra, rb, rc }));
  // The rename (the guest's check op) moves the reservation; another's name is 'taken'.
  await w.social.handle(a, { type: 'callsign', op: 'check', name: 'Quiet Dawn', id: 4 });
  const r4 = last(a);
  await w.social.handle(b, { type: 'callsign', op: 'check', name: 'QUIET DAWN', id: 5 });
  const r5 = last(b);
  const oldGone = !byName(w.table, 'Dune Viper');
  const d = mkws();
  await w.social.handle(d, { type: 'name', name: 'Dune Viper', id: 6 });
  if (r4.ok && r4.name === 'Quiet Dawn' && a.reservedName === 'Quiet Dawn' && byName(w.table, 'Quiet Dawn') && oldGone
      && r5.error === 'taken' && last(d).ok && last(d).name === 'Dune Viper' && !last(d).moved)
    ok('G: a guest\'s check op is a rename of their row: the new name is theirs, the old one free for the next player, and another player\'s name is "taken"');
  else fail('G: rename: ' + JSON.stringify({ r4, r5, d: last(d) }));
  // A ROW THAT HAS GONE (swept, or deleted with its account) under a socket
  // that still holds it: the rename answers 'unavailable' and the socket lets
  // go of it, so its next check is answered the old way.
  const e = mkws();
  await w.social.handle(e, { type: 'name', name: 'Brass Rider', id: 40 });
  w.table.rows = w.table.rows.filter((r) => r.name !== 'Brass Rider');
  await w.social.handle(e, { type: 'callsign', op: 'check', name: 'Brass Ranger', id: 41 });
  const g1 = last(e), held1 = { row: e.nameRow, name: e.reservedName };
  await w.social.handle(e, { type: 'callsign', op: 'check', name: 'Brass Ranger', id: 42 });
  if (g1.error === 'unavailable' && held1.row === null && held1.name === null && last(e).ok && last(e).name === 'Brass Ranger' && !byName(w.table, 'Brass Ranger'))
    ok('G: a rename whose row has gone answers "unavailable" and the socket lets the row go; its next check is answered the old way, storing nothing');
  else fail('G: gone: ' + JSON.stringify({ g1, held1, next: last(e) }));
  // A socket with no claim (an old build): the check op still refuses a reserved name.
  const old = mkws();
  await w.social.handle(old, { type: 'callsign', op: 'check', name: 'Quiet  Dawn', id: 7 });
  await w.social.handle(old, { type: 'callsign', op: 'check', name: 'Tall Order', id: 8 });
  if (old._rx[0].error === 'taken' && old._rx[1].ok && old._rx[1].name === 'Tall Order' && !byName(w.table, 'Tall Order'))
    ok('G: an old build that never claims is refused a reserved name by the check op ("taken"), and a free one is answered as before, storing nothing');
  else fail('G: old build check: ' + JSON.stringify(old._rx));
  // The Set: another player's reservation refuses it; the account's own becomes its callsign and is released.
  const L = mkws(U1, false);
  w.online = true;
  await w.social.handle(L, { type: 'name', name: 'Steel Mule', id: 9 });
  await w.social.handle(L, { type: 'callsign', name: 'Quiet Dawn', id: 10 });
  const s1 = last(L);
  await w.social.handle(L, { type: 'callsign', name: 'STEEL MULE', id: 11 });
  const s2 = last(L);
  await new Promise((r) => setTimeout(r, 5));
  if (s1.error === 'taken' && s2.ok && s2.callsign === 'STEEL MULE' && L.chosenName === 'STEEL MULE' && L.reservedName === null && L.nameRow === null
      && !w.table.rows.some((r) => r.user_id === U1) && w.res.state('steel mule') === 'free')
    ok('G: the Set refuses a name another player has reserved ("taken"); the account\'s own reserved name may become its callsign, and the reservation is then released');
  else fail('G: Set: ' + JSON.stringify({ s1, s2, chosen: L.chosenName, reserved: L.reservedName, rows: w.table.rows }));
  // The claim of an account holding a chosen callsign answers it.
  const L2 = mkws(U1, false);
  L2.chosenName = 'STEEL MULE';
  await w.social.handle(L2, { type: 'name', name: 'Whatever', id: 12 });
  if (last(L2).ok && last(L2).chosen === true && last(L2).name === 'STEEL MULE' && L2.reservedName === null) ok('G: a linked account\'s claim is answered with its chosen callsign, marked chosen, and the socket holds no reservation');
  else fail('G: chosen claim: ' + JSON.stringify(last(L2)));
  // A hello landing while the claim is out: the answer is not kept.
  const h = mkws();
  w.table.before = () => { h.authGen = 2; };      // the hello lands while the claim's write is out
  await w.social.handle(h, { type: 'name', name: 'Rapid Volley', id: 13 });
  if (last(h).error === 'unavailable' && !h.reservedName) ok('G: a claim whose socket said hello again while it was out is answered "unavailable" and leaves nothing on the socket (the client claims again after every hello)');
  else fail('G: generation: ' + JSON.stringify(last(h)));
  // The bucket: six claims a minute per socket.
  const z = mkws();
  for (let i = 0; i < 7; i++) await w.social.handle(z, { type: 'name', name: 'Blunt Wash', id: 20 + i });
  if (z._rx.slice(0, 6).every((m) => m.ok) && z._rx[6].error === 'slow_down') ok('G: six claims a minute per socket, then "slow_down"');
  else fail('G: claim bucket: ' + JSON.stringify(z._rx.map((m) => m.error || m.name)));
}
{
  // THE SQUAD ROW SHOWS THE RESERVED NAME: a guest's in place of what its join
  // frame carried, a linked account's with no chosen callsign in place of the
  // rolled pair its profile says, and a dropped row keeps its name.
  const w = socialWorld();
  await w.res.refresh();
  const L = mkws(U2, false), G = mkws();
  w.profiles.set(U2, { id: U2, callsign: 'Iron Ridge', callsign_key: null });
  await w.social.handle(L, { type: 'name', name: 'Cinder Spire', id: 1 });
  await w.social.handle(G, { type: 'name', name: 'Gravel Hawk', id: 2 });
  await w.social.handle(L, { type: 'squad', op: 'create', name: 'Iron Ridge', skin: 'olive', id: 3 });
  const code = L._rx.find((m) => m.type === 'squad' && m.code).code;
  await w.social.handle(G, { type: 'squad', op: 'join', code, name: 'Something Typed', skin: 'olive', id: 4 });
  const st = [...L._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state' && m.members && m.members.length === 2);
  const names = st ? st.members.map((m) => m.callsign) : null;
  // The guest renames: the row follows at once.
  await w.social.handle(G, { type: 'callsign', op: 'check', name: 'Feral Falcon', id: 5 });
  const st2 = [...L._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state' && m.members && m.members.length === 2);
  // The guest drops: its row keeps the name through the window.
  G.readyState = 3;
  w.social.onClose(G);
  await new Promise((r) => setTimeout(r, 5));
  const st3 = [...L._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state' && m.members && m.members.length === 2);
  if (same(names, ['Cinder Spire', 'Gravel Hawk']) && st2 && st2.members[1].callsign === 'Feral Falcon' && st3 && st3.members[1].dropped && st3.members[1].callsign === 'Feral Falcon')
    ok('G: squad rows name the reserved names (the linked leader\'s over its profile\'s rolled pair, the guest\'s over its typed frame), a rename shows at once, and a dropped row keeps its name');
  else fail('G: squad rows: ' + JSON.stringify({ names, st2: st2 && st2.members, st3: st3 && st3.members }));
  // A member whose claim lands AFTER it joined (its socket's hello was slow):
  // the claim names the row differently, and the squad is told at once.
  const old = mkws();
  await w.social.handle(old, { type: 'name', name: 'Bold Mule', id: 6 });
  const late = mkws();
  await w.social.handle(late, { type: 'squad', op: 'join', code, name: 'Typed Tank', skin: 'olive', id: 7 });
  const st4 = [...L._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state' && m.members && m.members.length === 3);
  await w.social.handle(late, { type: 'name', name: 'x', secret: last(old).secret, id: 8 });
  const st5 = [...L._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state' && m.members && m.members.length === 3);
  if (st4 && st4.members[2].callsign === 'Typed Tank' && st5 && st5 !== st4 && st5.members[2].callsign === 'Bold Mule')
    ok('G: a member whose claim lands after it joined is renamed on every member\'s screen at once (\'Typed Tank\' to its reserved \'Bold Mule\')');
  else fail('G: late claim: ' + JSON.stringify({ st4: st4 && st4.members, st5: st5 && st5.members }));
}

// ==== H. the room engine's door ====================================================
{
  const eng = await import('../public/room-engine.js');
  const mkew = (over = {}) => Object.assign({ readyState: 1, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } }, over);
  const seat = (ws, name) => {
    eng.handleClientMessage(ws, { type: 'create', name, skin: 'olive', mode: 'golf', max: 1, tees: 'mens', loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] });
    eng.handleClientMessage(ws, { type: 'startMatch' });
    const st = ws._rx.find((m) => m.type === 'start');
    eng.handleClientMessage(ws, { type: 'leave' });
    return st ? { name: st.names[st.you], renamed: st.renamed === true } : null;
  };
  // OFFLINE FIRST, before any hook is installed: exactly the old door.
  const h0 = [...'Steel Gunner'].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
  const off1 = seat(mkew(), 'Steel Gunner'), off2 = seat(mkew(), 'Not A Pair Name');
  const h2 = [...'Not A Pair Name'].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
  if (off1 && off1.name === 'Steel Gunner' && !off1.renamed && off2 && off2.name === callsignFromSeed(h2) && off2.renamed && h0)
    ok('H: with no hooks installed (the offline page) a rolled pair is seated and a refused name falls to callsignFromSeed of its own seed, exactly as before');
  else fail('H: offline: ' + JSON.stringify({ off1, off2 }));
  // NOW AS server.js WIRES IT.
  const w = world();
  await w.res.refresh();
  eng.setNameCheck(w.proofs.playerName);
  eng.setNameFree((n) => w.res.free(n));
  const held = await w.res.claim({ name: 'Steel Gunner' });
  await w.res.claim({ name: 'Viper Ace' });
  // The holder's socket: its reserved name, whatever the frame says.
  const mine = seat(mkew({ reservedName: held.name }), 'Something Else');
  // Another socket presenting the reserved rolled pair, and the reserved typed name.
  const theirs = seat(mkew(), 'Steel Gunner');
  const typed = seat(mkew(), 'viper ace');
  // A socket whose chosen callsign stands ahead of a reservation it still carries.
  const chosen = seat(mkew({ chosenName: 'Marguerite Vale', reservedName: 'Steel Gunner' }), 'x');
  if (mine && mine.name === 'Steel Gunner' && !mine.renamed && theirs && theirs.renamed && theirs.name !== 'Steel Gunner' && w.res.free(theirs.name)
      && typed && typed.renamed && typed.name !== 'Viper Ace' && chosen && chosen.name === 'Marguerite Vale')
    ok(`H: the door seats a socket's reserved name whatever its frame carries; another socket presenting that rolled pair or a reserved typed name is refused, told 'renamed', and seated under an unused name ('${theirs.name}')`);
  else fail('H: door: ' + JSON.stringify({ mine, theirs, typed, chosen }));
  // The stand-in walks its seeds to an unused one: hold the first seed's name and the door skips it.
  // 'x' is refused by the guidelines (too short), so it falls to the stand-in.
  const firstSeed = callsignFromSeed([...'x'].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
  const before = seat(mkew(), 'x');
  await w.res.claim({ name: firstSeed });
  const skip = seat(mkew(), 'x');
  const skip2 = seat(mkew(), 'x');
  if (before && before.name === firstSeed && before.renamed && skip && skip.renamed && skip.name !== firstSeed && isGeneratedCallsign(skip.name) && w.res.free(skip.name) && skip2.name === skip.name)
    ok(`H: the stand-in for a refused name skips a seed another player holds ('${firstSeed}') and is still deterministic on the refused input ('${skip.name}' both times)`);
  else fail('H: stand-in: ' + JSON.stringify({ firstSeed, skip, skip2 }));
  // A hook that throws answers no; a host with the reservations off answers yes.
  // With no typed-name check behind it (so the rolled-pair door is the only
  // way in), a nameFree that throws refuses the pair and every stand-in seed,
  // and the first seed stands, as before.
  eng.setNameCheck(null);
  eng.setNameFree(() => { throw new Error('boom'); });
  const thr = seat(mkew(), 'Rapid Fuse');
  eng.setNameFree((n) => RESERVATIONS_OFF.free(n));
  const offAgain = seat(mkew(), 'Steel Gunner');
  eng.setNameFree(null);
  if (thr && thr.renamed && thr.name === callsignFromSeed([...'Rapid Fuse'].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) && offAgain && offAgain.name === 'Steel Gunner' && !offAgain.renamed)
    ok('H: a nameFree that throws refuses (fail closed), and the first seed stands in; with the reservations off every rolled pair is seated as before');
  else fail('H: hook faults: ' + JSON.stringify({ thr, offAgain }));
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall reserve checks passed');
process.exit(out.errors.length ? 1 : 0);
