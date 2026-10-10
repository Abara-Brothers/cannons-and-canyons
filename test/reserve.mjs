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
//      to an account keeps the name and takes the device's secret off the row,
//      a signed-out or shared device gets a name of its own, an account's own
//      row, a chosen callsign
//   D. defaults are always unused, the numbered tier when the pairs run out,
//      then the wide tier no flood can use up, never a computer's name, never
//      a chosen callsign
//   E. the two namespaces never overlap: a claim refuses a chosen callsign,
//      the Set refuses a reserved name, an unknown chosen index fails closed
//   F. renames, the 90-day sweep, last_seen_at, the bounds on new rows (per
//      socket, per hour, the ceiling and its prune), a unique conflict the
//      memory did not know about, two sockets racing
//   G. the social layer: the claim frame, the guest's rename, the Set, the
//      squad row, a hello landing mid-claim
//   H. the engine's door: a socket seats its reserved name whatever it sends,
//      nobody else's name is shown, the stand-in is unused, offline unchanged,
//      and a claim that failed still seats the player's own name
//   I. one name ignoring capitals in every script: a Greek name in other
//      capitals, a name whose capitals read as another's, the Set and the door
//   J. new names handed out fairly (round 3 fix, 2026-10-10): a claim with no
//      hello makes no row, a budget per client address that the attempts the
//      process-wide bounds refuse also spend, the window raised to match, the
//      address read from the edge's header and never from X-Forwarded-For,
//      and the starvation the check reproduced, which no longer starves
//   K. a stand-in is never anybody's (round 3 fix): drawn from every default
//      name, never a reserved one once all 1,454 pairs are, never one a live
//      player is shown under; a server-assigned default never one either
//   L. no two humans in one room or one squad are ever shown one name
//      (round 3 fix), whatever the reservations can say: the table missing,
//      the store down, the budget spent; the later player moved and told
import { createReservations, RESERVATIONS_OFF, DEFAULT_TIERS, WIDE_DEFAULTS, SECRET_RE, hashSecret, nameKeyOf, combineStates, RESERVE_TTL_MS, TOUCH_MS, ROWS_PER_SOCKET, ROWS_PER_HOUR, ROWS_MAX, PRUNE_BATCH, PRUNE_GAP_MS, HOLDERS_MAX, ADDR_ROWS_PER_HOUR, ADDR_MAX, ADDR_SWEEP_MS, nameReadings } from '../server/reservations.js';
import { createNameProofs } from '../server/display-name.js';
import { loadBlocklist, keyReadings } from '../server/callsign.js';
import { createSocial } from '../server/social.js';
import { createSeatSquad } from '../server/seat-squad.js';
import { clientAddressOf, addressGroup } from '../server/client-address.js';
import { CALLSIGN_MAX } from '../server/callsign.js';
import { isGeneratedCallsign, callsignFromSeed, defaultNameAt, defaultNameCount, defaultPairs, DEFAULT_NAME_MAX, CALL_ADJ, CALL_NOUN, NAME_MAX, standInWalk, isProfane } from '../public/game-core.js';
import * as eng from '../public/room-engine.js';
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
// user_id each UNIQUE (two nulls never clash), EXACTLY ONE holder per row (a
// write that would leave a row with both, or neither, throws, as the table's
// check makes PostgREST answer 400), `reused` false until written true, and
// every write answering as server/store.js answers: the move takes the
// secret off in the same write, a rename matches its holder as well as its
// id. `before` runs ahead of an insert, which is how another instance's write
// lands between this process's read and its write. `secretFail` makes the
// read by secret throw, as a store that is down does.
function mkTable() {
  const t = { rows: [], seq: 0, calls: [], keysFail: null, before: null, secretFail: null };
  const pub = (r) => (r ? { ...r } : null);
  const clash = (r) => t.rows.some((o) => o !== r && (o.name_key === r.name_key || (r.secret_hash && o.secret_hash === r.secret_hash) || (r.user_id && o.user_id === r.user_id)));
  const oneHolder = (r) => { if (!r.secret_hash === !r.user_id) throw new Error('sb 400: name_reservations_check'); };
  Object.assign(t, {
    async reservationKeys(after, limit) {
      t.calls.push(['keys']);
      if (t.keysFail) throw t.keysFail;
      return t.rows.map((r) => r.name_key).sort().filter((k) => !after || k > after).slice(0, limit);
    },
    async reservationByUser(id) { t.calls.push(['byUser']); return pub(t.rows.find((r) => r.user_id === id)); },
    async reservationBySecret(h) { t.calls.push(['bySecret']); if (t.secretFail) throw t.secretFail; return /^[0-9a-f]{64}$/.test(h) ? pub(t.rows.find((r) => r.secret_hash === h)) : null; },
    async reservationsByKeys(keys) { t.calls.push(['byKeys', [...new Set(keys)].sort()]); return [...new Set(keys)].map((k) => t.rows.find((r) => r.name_key === k)).filter(Boolean).map((r) => ({ name_key: r.name_key, user_id: r.user_id || null })); },
    async insertReservation({ name, key, secretHash = null, userId = null, linked = false }) {
      t.calls.push(['insert', name]);
      if (t.before) { const f = t.before; t.before = null; f(); }
      const r = { id: ++t.seq, name, name_key: key, secret_hash: secretHash, user_id: userId, linked: !!linked, created_at: iso(clock), last_seen_at: iso(clock), reused: false };
      oneHolder(r);
      if (clash(r)) return { ok: false };
      t.rows.push(r);
      return { ok: true, row: pub(r) };
    },
    async moveReservation(id, userId, linked, at) {
      t.calls.push(['move']);
      const r = t.rows.find((x) => x.id === id && !x.user_id);
      if (!r || t.rows.some((o) => o.user_id === userId)) return null;
      Object.assign(r, { user_id: userId, linked: !!linked, secret_hash: null, reused: true, last_seen_at: iso(at) });
      oneHolder(r);
      return pub(r);
    },
    async renameReservation(id, name, key, at, holder) {
      t.calls.push(['rename', name]);
      const h = holder || {};
      if (!h.userId && !h.secretHash) throw new Error('rename without a holder');
      const r = t.rows.find((x) => x.id === id && (h.userId ? x.user_id === h.userId : x.secret_hash === h.secretHash && !x.user_id));
      if (!r) return { ok: false, error: 'gone' };
      if (t.rows.some((o) => o !== r && o.name_key === key)) return { ok: false, error: 'taken' };
      Object.assign(r, { name, name_key: key, last_seen_at: iso(at) });
      return { ok: true, row: pub(r) };
    },
    async touchReservation(id, linked, at, reused = false) { t.calls.push(['touch', reused === true]); const r = t.rows.find((x) => x.id === id); if (r) Object.assign(r, { last_seen_at: iso(at), linked: !!linked }, reused === true ? { reused: true } : {}); },
    async deleteReservationOfUser(uid) { t.calls.push(['release']); const gone = t.rows.filter((r) => r.user_id === uid); t.rows = t.rows.filter((r) => r.user_id !== uid); return gone.map((r) => r.name_key); },
    async sweepReservations(before) { t.calls.push(['sweep']); const gone = t.rows.filter((r) => !r.linked && Date.parse(r.last_seen_at) < before); t.rows = t.rows.filter((r) => !gone.includes(r)); return gone.map((r) => r.name_key); },
    async pruneReservations(before, limit) {
      t.calls.push(['prune', limit]);
      const can = (r) => !r.linked && r.reused !== true && Date.parse(r.created_at) < before;
      const ids = t.rows.filter(can).map((r) => r.id).sort((a, b) => a - b).slice(0, limit);
      if (!ids.length) return [];
      const top = ids[ids.length - 1];
      const gone = t.rows.filter((r) => can(r) && r.id <= top);
      t.rows = t.rows.filter((r) => !gone.includes(r));
      return gone.map((r) => r.name_key);
    },
  });
  return t;
}
// A row as another holder left it, pushed straight into the fake table.
const rowFor = (t, name, holder = {}) => {
  const r = { id: ++t.seq, name, name_key: nameKeyOf(name), secret_hash: holder.user_id ? null : holder.secret_hash || ('f'.repeat(48) + String(t.seq).padStart(16, '0')), user_id: holder.user_id || null, linked: !!holder.linked, created_at: iso(holder.at ?? clock), last_seen_at: iso(holder.at ?? clock), reused: !!holder.reused };
  t.rows.push(r);
  return r;
};
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
// `live`: the names live in the engine's rooms and squads are asked by the
// default pick, as server.js wires it (liveNameReadings).
function world({ chosen = [], table = mkTable(), sweeps = [], live = false } = {}) {
  const ci = mkChosen(chosen);
  let res = null;
  const keyState = (k) => combineStates(ci.state(k), res ? res.state(k) : 'free');
  const proofs = createNameProofs({ terms: TERMS, keyState });
  // How many names met the full guidelines (D asks it of the default pick).
  const counted = { n: 0 };
  const checkName = (raw) => { counted.n++; return proofs.checkPlayerName(raw); };
  res = createReservations({ store: table, chosenState: ci.state, checkName, now, pick, schedule: (fn, ms) => { sweeps.push({ fn, ms }); return () => {}; },
    ...(live ? { liveNames: () => eng.liveNameReadings(null) } : {}) });
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
  // First save: an anonymous account. The device's row MOVES, name and all,
  // and the device's secret comes off it in the same write.
  const m = await w.res.claim({ userId: U1, linked: false, secret: sec, name: 'Iron Hawk' });
  const moved = w.table.rows.find((r) => r.id === rowId);
  if (m.ok && m.name === 'Iron Hawk' && !m.moved && !m.secret && moved.user_id === U1 && moved.secret_hash === null && moved.reused === true
      && w.table.rows.length === 1 && !w.table.calls.some(([c]) => c === 'release'))
    ok('C: a guest who gets an account keeps the name: the same row moves to the account, the device\'s secret comes off it in the same write, and nothing is released or re-reserved');
  else fail('C: move: ' + JSON.stringify({ m, rows: w.table.rows }));
  // Another player cannot slip in, and the account is answered from any device.
  const other = await w.res.claim({ name: 'Iron Hawk' });
  const acct = await w.res.claim({ userId: U1, linked: false, name: 'Whatever Else' });
  if (other.moved === 'taken' && acct.name === 'Iron Hawk' && !acct.secret)
    ok('C: after the move the account is answered "Iron Hawk" from any device, and nobody else can take it');
  else fail('C: after move: ' + JSON.stringify({ other, acct }));
  // THE DEVICE SIGNED OUT (or another person on it): its secret names no
  // account. It presents its own name, which went with the account, and is
  // given a new unused default of its own, on a row of its own, with a new
  // secret; marked fresh (the sign-out said a fresh guest starts) it is told
  // nothing. The account's row is untouched.
  const before = w.table.rows.length;
  const out = await w.res.claim({ secret: sec, name: 'Iron Hawk', fresh: true });
  const outRow = out.ok && byName(w.table, out.name);
  const acctRow = w.table.rows.find((r) => r.id === rowId);
  if (out.ok && out.name !== 'Iron Hawk' && isGeneratedCallsign(out.name) && !out.moved && SECRET_RE.test(secretOf(out) || '') && secretOf(out) !== sec
      && outRow && outRow.user_id === null && outRow.secret_hash === hashSecret(secretOf(out)) && w.table.rows.length === before + 1
      && acctRow.name === 'Iron Hawk' && acctRow.user_id === U1)
    ok(`C: the signed-out device's old secret is no longer believed: it gets a name of its own ('${out.name}'), a new row and a new secret, silently when marked fresh, and the account keeps "Iron Hawk"`);
  else fail('C: signed out: ' + JSON.stringify({ out, outRow, acctRow }));
  // And not marked fresh (another person on a shared device): the same, told 'taken'.
  const out2 = await w.res.claim({ secret: sec, name: 'Iron Hawk' });
  // The device's own row from then on answers its new secret, never the account's name.
  const again = await w.res.claim({ secret: secretOf(out), name: 'Iron Hawk' });
  if (out2.ok && out2.moved === 'taken' && out2.name !== 'Iron Hawk' && again.ok && again.name === out.name && !again.secret)
    ok('C: unmarked, a device presenting the account\'s name is moved to a default and told \'taken\'; the device\'s new secret answers its own name, never the account\'s');
  else fail('C: shared device: ' + JSON.stringify({ out2, again }));
  // ITS PREVIOUS OWN NAME WHEN NOBODY HOLDS IT. A device's row moves to an
  // account, which then sets a chosen callsign and lets the name go; the
  // device signing out gets its own old name back.
  const d2 = await w.res.claim({ name: 'Mad Rim' });
  await w.res.claim({ userId: U3, linked: true, secret: secretOf(d2), name: 'Mad Rim' });
  await w.res.claim({ userId: U3, linked: true, chosen: 'Marguerite Vale', name: 'Mad Rim' });
  const back = await w.res.claim({ secret: secretOf(d2), name: 'Mad Rim', fresh: true });
  if (back.ok && back.name === 'Mad Rim' && !back.moved && secretOf(back) && byName(w.table, 'Mad Rim').user_id === null)
    ok('C: a signed-out device whose old name the account has since let go gets that name back, on a row of its own');
  else fail('C: previous own name: ' + JSON.stringify({ back, rows: w.table.rows }));
  // Linking the anonymous account (the same id): the row is marked linked.
  clock += 2 * TOUCH_MS;
  await w.res.claim({ userId: U1, linked: true, name: 'Iron Hawk' });
  if (w.table.rows.find((r) => r.id === rowId).linked === true) ok('C: when the account is linked the row is marked linked (and so is never swept)');
  else fail('C: linked flag: ' + JSON.stringify(w.table.rows));
  // An account with no row and a device with none: a new row, held by the account alone.
  const n2 = await w.res.claim({ userId: U2, linked: true, name: 'Rusty Mule' });
  const r2 = byName(w.table, 'Rusty Mule');
  if (n2.ok && !n2.secret && r2.user_id === U2 && r2.linked === true && r2.secret_hash === null)
    ok('C: an account with no row reserves its name on a row the account alone holds: no device secret is issued for it');
  else fail('C: new account row: ' + JSON.stringify({ n2, r2 }));
  // An account's row reserved elsewhere never takes this device's secret.
  rowFor(w.table, 'Bold Coyote', { user_id: '44444444-4444-4444-8444-444444444444', linked: true });
  await w.res.refresh();
  const n3 = await w.res.claim({ userId: '44444444-4444-4444-8444-444444444444', linked: true, name: 'Bold Coyote' });
  if (n3.name === 'Bold Coyote' && !n3.secret && byName(w.table, 'Bold Coyote').secret_hash === null && !w.table.calls.some(([c]) => c === 'attach'))
    ok('C: an account\'s row from another device is answered as it is, and no device secret is ever written onto it');
  else fail('C: no attach: ' + JSON.stringify({ n3, row: byName(w.table, 'Bold Coyote') }));
  // A row that still carries both (a table from before the check): its
  // secret is not believed for it.
  const both = 'B'.repeat(43);
  w.table.rows.push({ id: ++w.table.seq, name: 'Lone Fuse', name_key: 'lone fuse', secret_hash: hashSecret(both), user_id: '55555555-5555-4555-8555-555555555555', linked: true, created_at: iso(clock), last_seen_at: iso(clock), reused: true });
  await w.res.refresh();
  const nb = await w.res.claim({ secret: both, name: 'Lone Fuse' });
  if (nb.ok && nb.name !== 'Lone Fuse' && nb.moved === 'taken' && secretOf(nb) && secretOf(nb) !== both)
    ok('C: a secret on a row an account holds is never answered with that row: the device is given a name of its own');
  else fail('C: both holders: ' + JSON.stringify(nb));
  // A secret the server never issued (or one whose row went) is no secret: a new one is issued.
  const forged = 'A'.repeat(43);
  const f = await w.res.claim({ secret: forged, name: 'Steady Spire' });
  if (f.ok && secretOf(f) && secretOf(f) !== forged && byName(w.table, f.name).secret_hash === hashSecret(secretOf(f)))
    ok('C: a well-formed secret no row holds is not believed: the device gets a new one with its new row');
  else fail('C: forged secret: ' + JSON.stringify(f));
  // A linked account with a chosen callsign: that is its name, and any row it held is released.
  const n4 = await w.res.claim({ userId: U2, linked: true, chosen: 'Marguerite Vale', name: 'Rusty Mule' });
  if (n4.ok && n4.chosen === true && n4.name === 'Marguerite Vale' && !byName(w.table, 'Rusty Mule') && w.res.state('rusty mule') === 'free')
    ok('C: a linked account holding a chosen callsign is answered with it, and the row it had is released: one name per player');
  else fail('C: chosen: ' + JSON.stringify({ n4, rows: w.table.rows.map((r) => r.name) }));
  // An anonymous account is never answered "chosen", whatever the socket says.
  const n5 = await w.res.claim({ userId: '66666666-6666-4666-8666-666666666666', linked: false, chosen: 'Marguerite Vale', name: 'Quiet Gunner' });
  if (n5.name === 'Quiet Gunner' && !n5.chosen) ok('C: a chosen name on a guest\'s socket is ignored: only a linked account holds one');
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
{
  // THE WIDE TIER (round 3 fix, 2026-10-10): every pair with a number from 10
  // to 999 that fits in 16 characters, drawn at random, so a flood that holds
  // all 13,086 walked defaults still leaves newcomers an unused one.
  const [pairs, numbered] = DEFAULT_TIERS;
  let longest = 0, shape = true;
  for (let i = 0; i < WIDE_DEFAULTS.size; i++) {
    const n = WIDE_DEFAULTS.at(i), len = [...n].length;
    if (len > longest) longest = len;
    const m = /^(.+) (\d{2,3})$/.exec(n);
    if (!m || !pairs.includes(m[1]) || +m[2] < 10 || +m[2] > 999) { shape = false; break; }
  }
  if (WIDE_DEFAULTS.size === 1075050 && WIDE_DEFAULTS.size >= 10 * ROWS_MAX && longest === 16 && shape
      && WIDE_DEFAULTS.at(0).endsWith(' 10') && WIDE_DEFAULTS.at(WIDE_DEFAULTS.size - 1).endsWith(' 999'))
    ok(`D: the wide tier is ${WIDE_DEFAULTS.size.toLocaleString('en')} names (a pair and 10 to 999, never past 16 characters), more than ten times the ${ROWS_MAX.toLocaleString('en')}-row ceiling`);
  else fail('D: wide tier shape: ' + JSON.stringify({ size: WIDE_DEFAULTS.size, longest, shape }));
  // Every walked default held: moved players are drawn from the wide tier,
  // each one unused, and the guidelines run only on names drawn free.
  const draws = [];
  const t = mkTable();
  for (const n of [...pairs, ...numbered]) rowFor(t, n);
  const ci = mkChosen();
  let res = null;
  const proofs = createNameProofs({ terms: TERMS, keyState: (k) => combineStates(ci.state(k), res ? res.state(k) : 'free') });
  let checks = 0;
  const checkName = (raw) => { checks++; return proofs.checkPlayerName(raw); };
  // The walked tiers start at 0; the wide tier's draws come from `draws`.
  const queue = [];
  res = createReservations({ store: t, chosenState: ci.state, checkName, now, pick: (n) => (n === WIDE_DEFAULTS.size ? (draws.push(queue[0] ?? 0), queue.shift() ?? 0) : 0) });
  await res.refresh();
  // The first draw is a held wide name, the second one the guidelines refuse
  // ('Iron Wash 17' reads as a term on the shipped list), the third is free.
  const heldWide = WIDE_DEFAULTS.at(500);
  rowFor(t, heldWide);
  await res.refresh();
  const refusedAt = 31687;
  queue.push(500, refusedAt, 777);
  checks = 0;
  const r = await res.claim({ name: pairs[0] });
  const want = WIDE_DEFAULTS.at(777);
  if (r.ok && r.moved === 'taken' && r.name === want && WIDE_DEFAULTS.at(refusedAt) === 'Iron Wash 17' && !proofs.checkPlayerName('Iron Wash 17').ok
      && same(draws, [500, refusedAt, 777]) && checks === 3)
    ok(`D: with all 13,086 walked defaults held, a moved player is drawn from the wide tier: a held draw is skipped by a lookup, one the guidelines refuse is skipped, and the next free one is given ('${want}'); the guidelines ran 3 times, never on the 13,086 held names`);
  else fail('D: wide draw: ' + JSON.stringify({ r, draws, checks, want }));
  // Many moves, all different and all unused.
  queue.length = 0;
  const res2 = createReservations({ store: t, chosenState: ci.state, checkName: proofs.checkPlayerName, now, pick });
  await res2.refresh();
  const got = [];
  for (let i = 0; i < 40; i++) { const x = await res2.claim({ name: pairs[1] }); got.push(x.ok ? x.name : null); }
  if (got.every((n) => n && /^.+ \d{2,3}$/.test(n)) && new Set(got).size === 40 && got.every((n) => t.rows.filter((q) => q.name === n).length === 1))
    ok('D: forty players moved with every walked default held each get a different, unused name from the wide tier');
  else fail('D: wide moves: ' + JSON.stringify(got));
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
  // The sweep runs a minute after start and then daily, on an unref'd timer
  // of the host's; beside it, the address budgets are forgotten every five
  // minutes (round 3 fix, 2026-10-10).
  const w3 = world();
  w3.res.start();
  const armed = w3.sweeps.map((s) => s.ms);
  await w3.res.refresh();
  w3.sweeps[0].fn();
  w3.sweeps[1].fn();
  await new Promise((r) => setTimeout(r, 10));
  w3.res.stop();
  const later = w3.sweeps.slice(2).map((s) => s.ms).sort((a, b) => a - b);
  if (same(armed, [60000, ADDR_SWEEP_MS]) && ADDR_SWEEP_MS === 300000 && same(later, [ADDR_SWEEP_MS, 86400000]) && w3.table.calls.some(([c]) => c === 'sweep'))
    ok('F: start() arms the sweep a minute after boot and then every 24 hours, and the address budgets\' forgetting every five minutes');
  else fail('F: sweep timer: ' + JSON.stringify(w3.sweeps.map((s) => s.ms)));
}
{
  // THE HOURLY WINDOW on new rows, per process (round 3 fix, 2026-10-10): at
  // most ROWS_PER_HOUR in any 60 minutes, answered 'unavailable' past it.
  const w = world();
  await w.res.refresh();
  const t0 = clock;
  const first = await w.res.claim({ name: 'Ashen Mesa' });
  let made = 1, refused = null;
  for (let i = 0; i < ROWS_PER_HOUR + 5 && !refused; i++) {
    clock = t0 + 1 + i;      // one a millisecond after the first, so the window's order is plain
    const r = await w.res.claim({ name: `Ashen Mesa ${i}`.slice(0, 16) });
    if (r.ok) made++; else refused = r;
  }
  const holder = await w.res.claim({ secret: secretOf(first), name: 'x' });
  clock = t0 + 59 * 60000;
  const stillShut = await w.res.claim({ name: 'Brass Butte' });
  clock = t0 + 60 * 60000;
  const one = await w.res.claim({ name: 'Brass Butte' });
  const two = await w.res.claim({ name: 'Brass Rider' });
  clock = t0 + 60 * 60000 + 1;
  const three = await w.res.claim({ name: 'Brass Hawk' });
  if (made === ROWS_PER_HOUR && same(refused, { ok: false, error: 'unavailable' }) && holder.ok && holder.name === 'Ashen Mesa'
      && same(stillShut, { ok: false, error: 'unavailable' }) && one.ok && same(two, { ok: false, error: 'unavailable' }) && three.ok)
    ok(`F: ${ROWS_PER_HOUR} new rows in an hour and the next new-row claim is "unavailable"; a holder is still answered; 59 minutes on it is still shut, and from the hour each new row waits for the oldest of the ${ROWS_PER_HOUR} to be an hour old`);
  else fail('F: hourly window: ' + JSON.stringify({ made, refused, holder, stillShut, one, two, three }));
  // A clock that jumps back a day does not shut new rows out for that day.
  clock = t0 - 86400000;
  const back = await w.res.claim({ name: 'Brass Mule' });
  clock = t0 + 2 * 3600000;
  if (back.ok) ok('F: a clock that jumps backwards does not shut new rows out (a stamp from the future is not counted)');
  else fail('F: clock back: ' + JSON.stringify(back));
}
{
  // THE CEILING AND THE PRUNE (round 3 fix, 2026-10-10). A table holding
  // ROWS_MAX rows makes no new row: the claim is 'unavailable' and the prune
  // starts, which deletes the oldest rows nobody linked holds, nobody came
  // back to and that are over a day old, PRUNE_BATCH at most, then the next
  // claim is answered.
  const t = mkTable();
  const old = clock - 2 * 86400000;
  for (let i = 0; i < ROWS_MAX; i++) {
    const kind = i < 1000 ? 'linked' : i < 2000 ? 'reused' : i < ROWS_MAX - 1000 ? 'old' : 'young';
    t.rows.push({ id: ++t.seq, name: `Flood ${i}`, name_key: `flood ${i}`, secret_hash: kind === 'linked' ? null : String(i).padStart(64, '0'), user_id: kind === 'linked' ? `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000` : null, linked: kind === 'linked', created_at: iso(kind === 'young' ? clock : old), last_seen_at: iso(kind === 'young' ? clock : old), reused: kind === 'reused', kind });
  }
  // The table's key read, sorted once per change rather than once a page.
  let sorted = null, at = -1;
  t.reservationKeys = async (after, limit) => {
    if (at !== t.rows.length) { sorted = t.rows.map((r) => r.name_key).sort(); at = t.rows.length; }
    let lo = 0, hi = sorted.length;
    if (after) { while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= after) lo = m + 1; else hi = m; } }
    return sorted.slice(lo, lo + limit);
  };
  const res = createReservations({ store: t, chosenState: () => 'free', checkName: createNameProofs({ terms: TERMS, keyState: () => 'free' }).checkPlayerName, now, pick });
  await res.refresh();
  const full = await res.claim({ name: 'Newcomer One' });
  // The prune the claim started, not one this test starts.
  await new Promise((r) => setTimeout(r, 20));
  const started = t.calls.filter(([c]) => c === 'prune').length;
  const gone = new Set(t.rows.map((r) => r.id));
  const removed = [];
  for (let id = 1; id <= ROWS_MAX; id++) if (!gone.has(id)) removed.push(id);
  const kinds = new Set(t.rows.map((r) => r.kind));
  const after = await res.claim({ name: 'Newcomer One' });
  const sizeAfter = res.size;
  const prunes = t.calls.filter(([c]) => c === 'prune').length;
  const soon = await res.prune();
  const prunesSoon = t.calls.filter(([c]) => c === 'prune').length;
  clock += PRUNE_GAP_MS;
  await res.prune();
  const prunesLater = t.calls.filter(([c]) => c === 'prune').length;
  if (sizeAfter === ROWS_MAX - PRUNE_BATCH + 1 && same(full, { ok: false, error: 'unavailable' }) && started === 1 && removed.length === PRUNE_BATCH
      && removed[0] === 2001 && removed[removed.length - 1] === 2000 + PRUNE_BATCH && kinds.has('linked') && kinds.has('reused') && kinds.has('young')
      && t.rows.filter((r) => r.kind && r.kind !== 'old').length === 3000 && after.ok && after.name === 'Newcomer One'
      && prunes === 1 && soon === 0 && prunesSoon === 1 && prunesLater === 2)
    ok(`F: at the ${ROWS_MAX.toLocaleString('en')}-row ceiling a new name is "unavailable" and the prune frees the ${PRUNE_BATCH} oldest rows nobody came back to (never a linked, reused or day-old-or-younger one), the next claim is answered, and the prune runs at most once a minute`);
  else fail('F: ceiling: ' + JSON.stringify({ size: sizeAfter, full, started, removed: [removed[0], removed[removed.length - 1], removed.length], after, prunes, soon, prunesSoon, prunesLater }));
}
{
  // REUSED: a claim that finds the row a day or more after it was made marks
  // it, once, with the touch it writes anyway.
  const w = world();
  await w.res.refresh();
  const a = await w.res.claim({ name: 'Ochre Ridge' });
  clock += TOUCH_MS / 2;
  await w.res.claim({ secret: secretOf(a), name: 'x' });
  const early = byName(w.table, 'Ochre Ridge').reused;
  clock += TOUCH_MS / 2;
  await w.res.claim({ secret: secretOf(a), name: 'x' });
  const late = byName(w.table, 'Ochre Ridge').reused;
  if (early === false && late === true && w.table.calls.filter(([c, r]) => c === 'touch' && r === true).length === 1)
    ok('F: a row is marked reused the first time its holder comes back a day or more after it was made, never before');
  else fail('F: reused: ' + JSON.stringify({ early, late, calls: w.table.calls.filter(([c]) => c === 'touch') }));
}
{
  // THE INDEX'S OWN LIMIT: a table past it fails the read (the feature stays
  // off), starts the prune, and the next read turns the feature on.
  const t = mkTable();
  const old = clock - 2 * 86400000;
  const over = ROWS_MAX * 1.5 + 10;
  for (let i = 0; i < over; i++) t.rows.push({ id: ++t.seq, name: `Flood ${i}`, name_key: `flood ${i}`, secret_hash: String(i).padStart(64, '0'), user_id: null, linked: false, created_at: iso(old), last_seen_at: iso(old), reused: false });
  let sorted = null, at = -1;
  t.reservationKeys = async (after, limit) => {
    if (at !== t.rows.length) { sorted = t.rows.map((r) => r.name_key).sort(); at = t.rows.length; }
    let lo = 0, hi = sorted.length;
    if (after) { while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= after) lo = m + 1; else hi = m; } }
    return sorted.slice(lo, lo + limit);
  };
  const errs = [];
  const res = createReservations({ store: t, chosenState: () => 'free', checkName: createNameProofs({ terms: TERMS, keyState: () => 'free' }).checkPlayerName, now, pick, onError: (e) => errs.push(e && e.code) });
  const first = await res.refresh();
  const wasReady = res.ready;
  // The prune the failed read started, not one this test starts.
  await new Promise((r) => setTimeout(r, 20));
  const second = await res.refresh();
  if (first === false && !wasReady && errs.includes('NAME_INDEX_FULL') && t.rows.length === over - PRUNE_BATCH && second === true && res.ready)
    ok(`F: a table past the index's limit (${over.toLocaleString('en')} rows) fails the read and leaves the feature off, the prune it starts frees ${PRUNE_BATCH} never-used rows, and the next read turns the feature on`);
  else fail('F: index limit: ' + JSON.stringify({ first, wasReady, errs, rows: t.rows.length, second, ready: res.ready }));
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
// A socket as server.js leaves it once it has said hello (saidHello: the
// message loop's mark; round 3 fix, 2026-10-10), with no address key.
const mkws = (userId = null, isGuest = false) => ({ readyState: 1, userId, isGuest, chosenName: null, authGen: 1, saidHello: true, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });
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
  // `door`: the engine's own name door and the real seating, as server.js
  // hands them in (round 3 fix, 2026-10-10).
  const doorOpts = opts.door ? {
    door: { standInFor: eng.standInFor, liveNameReadings: eng.liveNameReadings, nameReadingsOf: eng.nameReadingsOf },
    seats: eng.MODE_SEATS, teeIds: eng.TEE_IDS, validRack: eng.validRackFor, schedule: () => () => {},
    seatSquad: createSeatSquad({ rooms: eng.rooms, handleClientMessage: eng.handleClientMessage, abandonRoom: eng.abandonRoom }),
  } : {};
  w.social = createSocial({ store, terms: TERMS, send, now, names: w.ci, reservations: w.res, ...doorOpts });
  return w;
}
// THE ENGINE'S DOOR AS server.js WIRES IT: the guidelines, the reservations,
// the reservations' reading of a name, and the squads' live names. Returns the
// unwiring, which every block that wires runs.
function wire(w) {
  eng.setNameCheck(w.proofs.playerName);
  eng.setNameFree((n) => w.res.free(n));
  eng.setNameReadings(nameReadings);
  eng.setNameLive(() => (w.social ? w.social.liveNames() : []));
  return () => { eng.setNameCheck(null); eng.setNameFree(null); eng.setNameReadings(null); eng.setNameLive(null); };
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
  // The bucket: six claims a minute per socket (each carrying the device's
  // secret, as the client sends it).
  const z = mkws();
  await w.social.handle(z, { type: 'name', name: 'Blunt Wash', id: 20 });
  for (let i = 1; i < 7; i++) await w.social.handle(z, { type: 'name', name: 'Blunt Wash', secret: z._rx[0].secret, id: 20 + i });
  if (z._rx.slice(0, 6).every((m) => m.ok && m.name === 'Blunt Wash') && z._rx[6].error === 'slow_down') ok('G: six claims a minute per socket, then "slow_down"');
  else fail('G: claim bucket: ' + JSON.stringify(z._rx.map((m) => m.error || m.name)));
  // NEW ROWS PER SOCKET (round 3 fix, 2026-10-10): a connection that claims
  // with no secret every time makes a new row each time, ROWS_PER_SOCKET at
  // most; then 'slow_down', with nothing written. A holder's claim on it is
  // still answered, and a new connection may make its own.
  const y = mkws();
  for (let i = 0; i < ROWS_PER_SOCKET; i++) { clock += 10001; await w.social.handle(y, { type: 'name', name: `Fresh Name ${i}`, id: 30 + i }); }
  const rowsNow = w.table.rows.length;
  clock += 10001;
  await w.social.handle(y, { type: 'name', name: `Fresh Name ${ROWS_PER_SOCKET}`, id: 30 + ROWS_PER_SOCKET });
  const rowsAfter = w.table.rows.length;
  clock += 10001;
  await w.social.handle(y, { type: 'name', name: 'x', secret: y._rx[0].secret, id: 35 });
  const y2 = mkws();
  await w.social.handle(y2, { type: 'name', name: 'Fresh Name 9', id: 36 });
  if (y._rx.slice(0, ROWS_PER_SOCKET).every((m) => m.ok && m.secret) && y._rx[ROWS_PER_SOCKET].error === 'slow_down' && rowsAfter === rowsNow
      && y._rx[ROWS_PER_SOCKET + 1].ok && y._rx[ROWS_PER_SOCKET + 1].name === 'Fresh Name 0' && last(y2).ok && last(y2).name === 'Fresh Name 9')
    ok(`G: one connection makes at most ${ROWS_PER_SOCKET} new rows, then "slow_down" with nothing written; a claim with its secret is still answered, and another connection makes its own`);
  else fail('G: rows per socket: ' + JSON.stringify({ y: y._rx.map((m) => m.error || m.name), y2: last(y2) }));
  // A CLAIM MADE AS AN ACCOUNT IS NEVER ANSWERED AS A DEVICE: the hello ahead
  // of it did not make the socket an account (GoTrue refused it), so the
  // claim is 'unavailable', with nothing read or written.
  const nobody = mkws();
  const callsBefore = w.table.calls.length;
  await w.social.handle(nobody, { type: 'name', name: 'Dune Viper', account: true, secret: ra.secret, id: 37 });
  if (same(last(nobody), { type: 'name', error: 'unavailable', id: 37 }) && w.table.calls.length === callsBefore && !nobody.reservedName)
    ok('G: a claim marked as an account\'s on a socket that is no account is "unavailable", with nothing read or written (never answered as the device)');
  else fail('G: account claim without an account: ' + JSON.stringify(last(nobody)));
}
{
  // THE GUEST CHECK OP NEVER RENAMES AN ACCOUNT'S ROW (round 3 fix,
  // 2026-10-10). A tablet's guest reserves 'Dune Viper'; a parent's account
  // signs in on it and the row moves to the account. The tablet's guest
  // socket that still remembers the row, and a new guest socket with the
  // tablet's secret, both try to rename it: neither can, and the parent keeps
  // 'Dune Viper' on every device.
  const w = socialWorld();
  await w.res.refresh();
  const kid = mkws();
  await w.social.handle(kid, { type: 'name', name: 'Dune Viper', id: 1 });
  const S1 = last(kid).secret;
  const parent = mkws(U2, false);
  await w.social.handle(parent, { type: 'name', name: 'Dune Viper', secret: S1, account: true, id: 2 });
  const row = byName(w.table, 'Dune Viper');
  await w.social.handle(kid, { type: 'callsign', op: 'check', name: 'Kid Renamed', id: 3 });
  const r1 = last(kid);
  const kid2 = mkws();
  await w.social.handle(kid2, { type: 'name', name: 'Dune Viper', secret: S1, fresh: true, id: 4 });
  const c2 = last(kid2);
  await w.social.handle(kid2, { type: 'callsign', op: 'check', name: 'Kid Renamed', id: 5 });
  const r2 = last(kid2);
  const parentAgain = mkws(U2, false);
  await w.social.handle(parentAgain, { type: 'name', name: 'Whatever', account: true, id: 6 });
  if (last(parent).ok && last(parent).name === 'Dune Viper' && last(parent).linked && row.user_id === U2 && row.secret_hash === null
      && r1.error === 'unavailable' && kid.nameRow === null && byName(w.table, 'Dune Viper') && byName(w.table, 'Dune Viper').user_id === U2
      && c2.ok && c2.name !== 'Dune Viper' && !c2.moved && kid2.nameRow && kid2.nameRow.user_id === null
      && r2.ok && r2.name === 'Kid Renamed' && byName(w.table, 'Kid Renamed').user_id === null
      && last(parentAgain).name === 'Dune Viper')
    ok('G: after a device\'s row moves to an account, the device\'s old socket cannot rename it ("unavailable", and it lets the row go), the device\'s next guest claim gets a name of its own, its renames move only that, and the account keeps "Dune Viper"');
  else fail('G: check op vs account row: ' + JSON.stringify({ parent: last(parent), row, r1, c2, r2, parentAgain: last(parentAgain), rows: w.table.rows.map((r) => [r.name, r.user_id]) }));
  // And a socket whose remembered account row is not its account's any more
  // (an identity change it was not told about) lets the row go, renaming nothing.
  const odd = mkws(U3, false);
  odd.nameRow = { ...row, name: 'Dune Viper' };
  odd.reservedName = 'Dune Viper';
  await w.social.handle(odd, { type: 'callsign', op: 'check', name: 'Odd Rename', id: 7 });
  if (odd.nameRow === null && odd.reservedName === null && !byName(w.table, 'Odd Rename') && byName(w.table, 'Dune Viper').user_id === U2)
    ok('G: a socket holding another account\'s row lets it go at the check op and renames nothing');
  else fail('G: foreign row: ' + JSON.stringify({ row: odd.nameRow, rows: w.table.rows.map((r) => r.name) }));
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
  // A CLAIM THAT FAILED STILL SEATS THE PLAYER'S OWN NAME (round 3 fix,
  // 2026-10-10). 'Steel Gunner' is reserved; the store then stops answering.
  // The holder reconnects: its claim fails, but the socket is vouched for its
  // own name, and the door seats it. A socket presenting a secret this
  // process never saw is vouched for nothing, and is refused the name; and a
  // player with no row at all is seated under their own name because nobody
  // holds it. When the store answers again, the claim is answered.
  const sw = socialWorld();
  await sw.res.refresh();
  eng.setNameCheck(sw.proofs.playerName);
  eng.setNameFree((n) => sw.res.free(n));
  const g1 = mkws();
  await sw.social.handle(g1, { type: 'name', name: 'Steel Gunner', id: 1 });
  const S = last(g1).secret;
  const acct = mkws(U1, false);
  await sw.social.handle(acct, { type: 'name', name: 'Cinder Hawk', account: true, id: 2 });
  sw.table.secretFail = new Error('sb 503');
  const realByUser = sw.table.reservationByUser;
  sw.table.reservationByUser = async () => { throw new Error('sb 503'); };
  const g2 = mkws(), forger = mkws(), acct2 = mkws(U1, false), nobodyHeld = mkws();
  await sw.social.handle(g2, { type: 'name', name: 'Something Else', secret: S, id: 3 });
  await sw.social.handle(forger, { type: 'name', name: 'Steel Gunner', secret: 'Q'.repeat(43), id: 4 });
  await sw.social.handle(acct2, { type: 'name', name: 'Old Name', account: true, id: 5 });
  await sw.social.handle(nobodyHeld, { type: 'name', name: 'Quiet Dawn', secret: 'R'.repeat(43), id: 6 });
  const seatG2 = seat(mkew({ reservedName: g2.reservedName }), 'Something Else');
  const seatForger = seat(mkew({ reservedName: forger.reservedName }), 'Steel Gunner');
  const seatAcct2 = seat(mkew({ reservedName: acct2.reservedName }), 'Old Name');
  const seatFree = seat(mkew({ reservedName: nobodyHeld.reservedName }), 'Quiet Dawn');
  sw.table.secretFail = null;
  sw.table.reservationByUser = realByUser;
  await sw.social.handle(g2, { type: 'name', name: 'Something Else', secret: S, id: 7 });
  eng.setNameCheck(null);
  eng.setNameFree(null);
  if (last(g2).id === 7 && last(g2).ok && last(g2).name === 'Steel Gunner' && g2.nameRow && g2.nameRow.name === 'Steel Gunner'
      && g2._rx[0].error === 'unavailable' && seatG2 && seatG2.name === 'Steel Gunner' && !seatG2.renamed
      && last(forger).error === 'unavailable' && forger.reservedName == null && seatForger && seatForger.name !== 'Steel Gunner' && seatForger.renamed
      && last(acct2).error === 'unavailable' && acct2.reservedName === 'Cinder Hawk' && seatAcct2 && seatAcct2.name === 'Cinder Hawk'
      && last(nobodyHeld).error === 'unavailable' && nobodyHeld.reservedName == null && seatFree && seatFree.name === 'Quiet Dawn' && !seatFree.renamed)
    ok('H: with the store down, a holder\'s failed claim still seats its own name (a device by its secret, an account by its id), a stranger presenting it is refused, a player nobody holds a name against keeps theirs, and the next claim is answered');
  else fail('H: vouch: ' + JSON.stringify({ g2: g2._rx, seatG2, forger: last(forger), seatForger, acct2: [last(acct2), acct2.reservedName], seatAcct2, free: [last(nobodyHeld), seatFree] }));
  // The vouch follows the holder: once a device's row moves to an account,
  // the device's secret is vouched for nothing, and the account for the name.
  const vw = world();
  await vw.res.refresh();
  // An account id with letters in it, so its capitals differ.
  const UA = 'abcdef01-abcd-4abc-8abc-abcdefabcdef';
  const d = await vw.res.claim({ name: 'Grim Gulch' });
  const devBefore = vw.res.vouch({ secret: secretOf(d) });
  await vw.res.claim({ userId: UA, linked: true, secret: secretOf(d), name: 'Grim Gulch' });
  const devAfter = vw.res.vouch({ secret: secretOf(d) });
  const acctAfter = vw.res.vouch({ userId: UA });
  const acctUpper = vw.res.vouch({ userId: UA.toUpperCase() });
  await vw.res.claim({ userId: UA, linked: true, chosen: 'Marguerite Vale', name: 'Grim Gulch' });
  const released = vw.res.vouch({ userId: UA });
  if (devBefore === 'Grim Gulch' && devAfter === null && acctAfter === 'Grim Gulch' && acctUpper === 'Grim Gulch' && released === null && vw.res.vouch({}) === null)
    ok('H: the vouch follows the holder: the device until its row moves, the account after (its id case-blind), nobody once the name is released');
  else fail('H: vouch holder: ' + JSON.stringify({ devBefore, devAfter, acctAfter, acctUpper, released }));
  // Bounded: the most recent HOLDERS_MAX holders, never more.
  const bw = world();
  await bw.res.refresh();
  const first = await bw.res.claim({ name: 'Zero Holder' });
  const uid = (i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
  for (let i = 0; i < HOLDERS_MAX; i++) rowFor(bw.table, `Held ${i}`, { user_id: uid(i) });
  await bw.res.refresh();
  for (let i = 0; i < HOLDERS_MAX; i++) await bw.res.claim({ userId: uid(i), name: 'x' });
  const holders = bw.res.holders;
  if (holders === HOLDERS_MAX && bw.res.vouch({ secret: secretOf(first) }) === null)
    ok(`H: the holders kept for the vouch are bounded at ${HOLDERS_MAX.toLocaleString('en')}, the oldest dropped first`);
  else fail('H: holders bound: ' + JSON.stringify({ holders }));
}

// ==== I. one name ignoring capitals, in every script ===============================
// (round 3 fix, 2026-10-10). A Greek capital reads as a different letter from
// its lower case (capital nu reads N, small nu v), so the look-alike skeleton
// of 'Αννα' is 'avva' and of 'ΑΝΝΑ' is 'anna': the key was the skeleton of the
// spelling presented, and both were reserved. The key is the name in lower
// case now, and every reading of it is compared, as chosen callsigns are.
{
  const w = world();
  await w.res.refresh();
  const a = await w.res.claim({ name: 'Αννα' });
  const b = await w.res.claim({ name: 'ΑΝΝΑ' });
  const c = await w.res.claim({ name: 'αννα' });
  if (a.ok && a.name === 'Αννα' && !a.moved && byName(w.table, 'Αννα').name_key === 'αννα'
      && b.ok && b.moved === 'taken' && b.name !== 'ΑΝΝΑ' && c.ok && c.moved === 'taken' && w.table.rows.filter((r) => r.name_key === 'αννα').length === 1)
    ok('I: \'Αννα\' is reserved under the key \'αννα\', and \'ΑΝΝΑ\' and \'αννα\' after it are each moved to a default and told \'taken\'');
  else fail('I: Greek capitals: ' + JSON.stringify({ a, b, c, rows: w.table.rows.map((r) => [r.name, r.name_key]) }));
  // A NAME WHOSE CAPITALS READ AS ANOTHER'S: 'ΗΙΤ' (Greek) reads 'HIT'. Held
  // either way round, the other is refused.
  const h1 = await w.res.claim({ name: 'Hit' });
  const h2 = await w.res.claim({ name: 'ΗΙΤ' });
  const h3 = await w.res.claim({ name: 'ηιτ' });
  const w2 = world();
  await w2.res.refresh();
  const g1 = await w2.res.claim({ name: 'ηιτ' });
  const g2 = await w2.res.claim({ name: 'Hit' });
  if (h1.ok && h1.name === 'Hit' && h2.moved === 'taken' && h3.moved === 'taken' && g1.ok && g1.name === 'ηιτ' && !g1.moved && g2.moved === 'taken' && g2.name !== 'Hit')
    ok('I: a Greek name whose capitals read as a Latin one (\'ΗΙΤ\' and \'Hit\') is one name: whichever is reserved first, the other is moved and told \'taken\'');
  else fail('I: cross-script readings: ' + JSON.stringify({ h1, h2, h3, g1, g2 }));
  // A RENAME: into another holder's name in other capitals is 'taken'; into
  // the holder's own in other capitals is theirs.
  const other = await w.res.claim({ name: 'Iron Gulch' });
  const r1 = await w.res.rename(other.row, 'ΑΝΝΑ');
  const r2 = await w.res.rename(a.row, 'ΑΝΝΑ');
  if (same(r1, { ok: false, error: 'taken' }) && r2.ok && r2.name === 'ΑΝΝΑ' && byName(w.table, 'ΑΝΝΑ') && byName(w.table, 'ΑΝΝΑ').name_key === 'αννα')
    ok('I: a rename into another player\'s Greek name in other capitals is \'taken\'; the holder may re-case their own');
  else fail('I: rename: ' + JSON.stringify({ r1, r2 }));
  // THE SET: a chosen callsign that any reading of meets a reservation is
  // refused, whoever's capitals.
  const setA = await w.res.takenFor('αννα', U1);
  const setH = await w.res.takenFor('ηιτ', U1);
  const setFree = await w.res.takenFor('ωμεγα', U1);
  const keysAsked = w.table.calls.filter(([c0]) => c0 === 'byKeys').map(([, k]) => k);
  if (setA === true && setH === true && setFree === false && keysAsked.some((k) => k.includes('hit')))
    ok('I: the Set\'s check (takenFor) reads the table for every reservation any reading of the key meets: \'αννα\' and \'ηιτ\' are taken, a free Greek name is not');
  else fail('I: takenFor: ' + JSON.stringify({ setA, setH, setFree, keysAsked }));
  // THE DOOR: a socket that does not hold it is refused the name in other capitals too.
  const t1 = w.proofs.typedName('ΑΝΝΑ'), t2 = w.proofs.typedName('ΗΙΤ');
  if (t1.error === 'taken' && t2.error === 'taken' && w.res.free('ΑΝΝΑ') === false && w.res.free('Ωμεγα') === true)
    ok('I: the door refuses \'ΑΝΝΑ\' and \'ΗΙΤ\' to a socket that does not hold them');
  else fail('I: door: ' + JSON.stringify({ t1, t2 }));
  // WHAT IS STORED IS WHAT WILL BE SHOWN: a spelling whose capitals read as
  // none of its key's readings is reserved as the key itself.
  const w3 = world();
  await w3.res.refresh();
  const odd = await w3.res.claim({ name: 'αΝνα' });
  if (odd.ok && odd.name === 'αννα' && byName(w3.table, 'αννα'))
    ok('I: \'αΝνα\' (a capital that reads as no reading of its key) is reserved as shown to everyone else, \'αννα\'');
  else fail('I: shown spelling: ' + JSON.stringify(odd));
  // TWO AT ONCE IN THIS PROCESS: look-alikes are two keys, so the table's
  // unique key cannot refuse the second; the name is taken in memory before
  // the first write goes out, so the second claim, or rename, is refused.
  const w4 = world();
  await w4.res.refresh();
  const [x1, x2] = await Promise.all([w4.res.claim({ name: 'Coco' }), w4.res.claim({ name: '\u0421\u043e\u0441\u043e' })]);
  const [y1, y2] = await Promise.all([w4.res.claim({ name: 'Hit' }), w4.res.claim({ name: 'ΗΙΤ' })]);
  const p1 = await w4.res.claim({ name: 'Grey Mesa' }), p2 = await w4.res.claim({ name: 'Grey Ridge' });
  const [z1, z2] = await Promise.all([w4.res.rename(p1.row, 'Kayak'), w4.res.rename(p2.row, '\u041a\u0430\u0443\u0430\u043a')]);
  if (x1.ok && x1.name === 'Coco' && x2.moved === 'taken' && y1.ok && y1.name === 'Hit' && y2.moved === 'taken' && z1.ok && same(z2, { ok: false, error: 'taken' })
      && w4.table.rows.filter((r) => ['coco', 'сосо', 'hit', 'ηιτ', 'kayak', '\u043a\u0430\u0443\u0430\u043a'].includes(r.name_key)).length === 3)
    ok('I: two claims (or renames) at once in this process for look-alike names in two scripts: the first holds it, the second is refused \'taken\'');
  else fail('I: race: ' + JSON.stringify({ x1, x2, y1, y2, z1, z2 }));
  // A write that fails gives the name back.
  const w5 = world();
  await w5.res.refresh();
  const realInsert = w5.table.insertReservation;
  w5.table.insertReservation = async () => { throw new Error('sb 503'); };
  let threw = null;
  try { await w5.res.claim({ name: 'Rapid Dune' }); } catch (e) { threw = e; }
  w5.table.insertReservation = realInsert;
  const p3 = await w5.res.claim({ name: 'Grey Spire' });
  const realRename = w5.table.renameReservation;
  w5.table.renameReservation = async () => { throw new Error('sb 503'); };
  let threw2 = null;
  try { await w5.res.rename(p3.row, 'Lucky Dune'); } catch (e) { threw2 = e; }
  w5.table.renameReservation = realRename;
  if (threw && threw2 && w5.res.state('rapid dune') === 'free' && w5.res.state('lucky dune') === 'free' && w5.res.state('grey spire') === 'taken')
    ok('I: a write that fails gives back the name it had taken in memory (a claim\'s and a rename\'s)');
  else fail('I: give back: ' + JSON.stringify({ threw: String(threw), threw2: String(threw2), a: w5.res.state('rapid dune'), b: w5.res.state('lucky dune') }));
}

// ---- the engine's rooms, for J, K and L ---------------------------------------
// A socket the engine can seat, a free-for-all lobby for four (it waits for
// its host, so seats can be read one by one), and the seat a socket was given.
const ews = (over = {}) => Object.assign({ readyState: 1, roomCode: null, seat: null, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } }, over);
const FIVE = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
const seatOfWs = (ws) => { const r = ws.roomCode ? eng.rooms.get(ws.roomCode) : null; const p = r ? r.players[ws.seat] : null; return p && p.ws === ws ? { name: p.name, renamed: p.renamed === true } : null; };
const openRoom = (host, name) => { eng.handleClientMessage(host, { type: 'create', name, skin: 'olive', mode: 'ffa', max: 4, loadout: FIVE }); return host.roomCode; };
const joinRoom = (ws, code, name) => { eng.handleClientMessage(ws, { type: 'join', code, name, skin: 'desert', loadout: FIVE }); return seatOfWs(ws); };
// Everyone out, the host last, so the room is gone and no seat stays live.
const shut = (...sockets) => { for (const s of [...sockets].reverse()) if (s.roomCode) eng.handleClientMessage(s, { type: 'leave' }); };
const sameName = (a, b) => nameReadings(a).some((x) => nameReadings(b).includes(x)) || String(a).toLowerCase() === String(b).toLowerCase();

// ==== J. new names, handed out fairly =========================================
{
  // J1. A CLAIM WITH NO HELLO MAKES NO ROW. A socket that never said hello
  // is answered 'unavailable' and nothing is written; once it has said hello
  // its claim makes its row; an account's socket has said one by being one.
  const w = socialWorld();
  await w.res.refresh();
  const bare = mkws(); bare.saidHello = false;
  await w.social.handle(bare, { type: 'name', name: 'Copper Mesa', id: 1 });
  const r1 = last(bare), rows1 = w.table.rows.length, made1 = bare.nameRowsMade || 0;
  bare.saidHello = true;
  await w.social.handle(bare, { type: 'name', name: 'Copper Mesa', id: 2 });
  const r2 = last(bare);
  const acct = mkws(U2, true); acct.saidHello = false;
  await w.social.handle(acct, { type: 'name', name: 'Copper Ridge', account: true, id: 3 });
  const r3 = last(acct);
  if (same(r1, { type: 'name', error: 'unavailable', id: 1 }) && rows1 === 0 && made1 === 0
      && r2.ok && r2.name === 'Copper Mesa' && SECRET_RE.test(r2.secret || '') && r3.ok && r3.name === 'Copper Ridge' && w.table.rows.length === 2)
    ok('J1: a claim from a socket that has not said hello makes no row ("unavailable", nothing written); after its hello the same claim makes its row, and an account\'s socket counts as having said one');
  else fail('J1: hello: ' + JSON.stringify({ r1, rows1, r2, r3 }));
  // A holder is answered its own name with or without a hello: only a NEW row needs one.
  const back = mkws(); back.saidHello = false;
  await w.social.handle(back, { type: 'name', name: 'x', secret: r2.secret, id: 4 });
  if (last(back).ok && last(back).name === 'Copper Mesa' && w.table.rows.length === 2) ok('J1: a holder is answered its own name before any hello: only a new row needs one');
  else fail('J1: holder without hello: ' + JSON.stringify(last(back)));
}
{
  // J2. THE PER-ADDRESS BUDGET. Thirty new rows an hour from one address
  // (each from a fresh socket, so the per-socket cap is not what stops it),
  // then 'unavailable' with nothing written; another address is answered; the
  // bucket gives one back every two minutes.
  const w = socialWorld();
  await w.res.refresh();
  const t0 = clock;
  const from = (addr) => { const s = mkws(); s.clientAddr = addr; return s; };
  const answers = [];
  for (let i = 0; i < ADDR_ROWS_PER_HOUR + 1; i++) { const s = from('addr-A'); await w.social.handle(s, { type: 'name', name: `Budget A${i}`, id: i }); answers.push(last(s)); }
  const madeA = answers.filter((a) => a.ok).length, lastA = answers[answers.length - 1];
  const rowsA = w.table.rows.length;
  const b = from('addr-B');
  await w.social.handle(b, { type: 'name', name: 'Budget B0', id: 99 });
  clock = t0 + 119000;
  const early = from('addr-A');
  await w.social.handle(early, { type: 'name', name: 'Budget A90', id: 100 });
  clock = t0 + 120001;
  const refilled = from('addr-A');
  await w.social.handle(refilled, { type: 'name', name: 'Budget A91', id: 101 });
  if (ADDR_ROWS_PER_HOUR === 30 && madeA === 30 && same(lastA, { type: 'name', error: 'unavailable', id: 30 }) && rowsA === 30
      && last(b).ok && last(early).error === 'unavailable' && last(refilled).ok && last(refilled).name === 'Budget A91')
    ok('J2: one address makes 30 new rows an hour and the 31st claim is "unavailable" with nothing written; another address is answered; one more comes back two minutes later');
  else fail('J2: address budget: ' + JSON.stringify({ madeA, lastA, rowsA, b: last(b), early: last(early), refilled: last(refilled) }));
  // A socket with no address key (the host could not tell its address) has
  // no budget: only the per-process bounds hold it.
  let free = 0;
  for (let i = 0; i < ADDR_ROWS_PER_HOUR + 5; i++) { const s = mkws(); await w.social.handle(s, { type: 'name', name: `Budget N${i}`, id: i }); if (last(s).ok) free++; }
  if (free === ADDR_ROWS_PER_HOUR + 5) ok('J2: a socket whose address could not be told is held by the per-process bounds alone, never by another\'s budget');
  else fail('J2: no address: ' + free);
}
{
  // J3. AN ATTEMPT THE PROCESS-WIDE BOUNDS REFUSE STILL SPENDS THE ADDRESS'S
  // BUDGET, so a script holding sockets open cannot retry its way into the
  // rows that free up. The window is filled by a hundred addresses at once
  // (ROWS_PER_HOUR is a hundred budgets: raised to match); address C then
  // spends its whole budget on refused attempts in the window's last minute;
  // when the window opens, C is still refused and a fresh address is not.
  const w = world();
  await w.res.refresh();
  const t0 = clock;
  let made = 0;
  for (let i = 0; i < ROWS_PER_HOUR; i++) {
    clock = t0 + i;
    const r = await w.res.claim({ name: `Wave ${i}`, addr: `flood-${Math.floor(i / ADDR_ROWS_PER_HOUR)}` });
    if (r.ok) made++;
  }
  clock = t0 + ROWS_PER_HOUR;
  const full = await w.res.claim({ name: 'Newcomer Zero', addr: 'fresh-0' });
  clock = t0 + 59 * 60000;
  const spent = [];
  for (let i = 0; i < ADDR_ROWS_PER_HOUR; i++) spent.push(await w.res.claim({ name: `Retry ${i}`, addr: 'addr-C' }));
  clock = t0 + 60 * 60000 + ROWS_PER_HOUR;
  const c = await w.res.claim({ name: 'Retry Late', addr: 'addr-C' });
  const d = await w.res.claim({ name: 'Newcomer One', addr: 'fresh-1' });
  if (ROWS_PER_HOUR === 3000 && ROWS_PER_HOUR === 100 * ADDR_ROWS_PER_HOUR && made === ROWS_PER_HOUR && same(full, { ok: false, error: 'unavailable' })
      && spent.every((r) => same(r, { ok: false, error: 'unavailable' })) && same(c, { ok: false, error: 'unavailable' }) && d.ok && d.name === 'Newcomer One')
    ok(`J3: the process-wide window is ${ROWS_PER_HOUR} an hour, a hundred addresses' budgets; an address that spent its budget on attempts the full window refused is still refused when it opens, and a fresh address is answered`);
  else fail('J3: refused attempts: ' + JSON.stringify({ made, full, spent: spent.slice(-2), c, d }));
}
{
  // J4. THE CLIENT'S ADDRESS (server/client-address.js): CF-Connecting-IP,
  // never X-Forwarded-For; a connection with no proxy is its socket's; one
  // through a proxy that names no client is nobody's; IPv6 by its /48, an
  // IPv4 written as IPv6 as itself; and the key is a hash, never the address.
  const req = (headers, remote = '10.1.2.3') => ({ headers, socket: { remoteAddress: remote } });
  const a1 = clientAddressOf(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 203.0.113.9, 172.71.0.1, 10.0.0.1' }));
  const a2 = clientAddressOf(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.77, 203.0.113.9, 172.71.0.1' }));
  const a3 = clientAddressOf(req({ 'cf-connecting-ip': '203.0.113.10' }));
  const xffOnly = clientAddressOf(req({ 'x-forwarded-for': '198.51.100.1' }));
  const direct = clientAddressOf(req({}, '::ffff:127.0.0.1'));
  const direct4 = clientAddressOf(req({}, '127.0.0.1'));
  const forged = clientAddressOf(req({ 'cf-connecting-ip': 'not an address', 'x-forwarded-for': '1.2.3.4' }));
  const v6a = clientAddressOf(req({ 'cf-connecting-ip': '2001:db8:abcd:1::1' }));
  const v6b = clientAddressOf(req({ 'cf-connecting-ip': '2001:DB8:ABCD:ffff:1:2:3:4' }));
  const v6c = clientAddressOf(req({ 'cf-connecting-ip': '2001:db8:abce::1' }));
  const keys = [a1, a3, direct, v6a, v6c].map((a) => a.key);
  if (a1.source === 'edge' && a1.key === a2.key && a1.key !== a3.key && xffOnly.key === null && xffOnly.source === null
      && direct.source === 'socket' && direct.key === direct4.key && forged.key === null
      && v6a.key === v6b.key && v6a.key !== v6c.key && new Set(keys).size === keys.length
      && keys.every((k) => typeof k === 'string' && /^[A-Za-z0-9_-]{22}$/.test(k) && !/203|113|127|2001|db8/.test(k))
      && addressGroup('::ffff:203.0.113.9') === '203.0.113.9' && addressGroup('2001:db8:abcd:12::1') === '2001:db8:abcd::/48' && addressGroup('1.2.3.4, 5.6.7.8') === null)
    ok('J4: the address is CF-Connecting-IP (a spoofed X-Forwarded-For changes nothing), the socket\'s own with no proxy, nobody\'s through a proxy that names no client; IPv6 by its /48, IPv4-in-IPv6 as IPv4; the key a 22-character hash, never the address');
  else fail('J4: address: ' + JSON.stringify({ a1, a2, a3, xffOnly, direct, direct4, forged, v6a, v6b, v6c }));
  // Nothing a connection can carry makes it throw (server.js calls it in the
  // connection handler): no request, a repeated header, a header of another
  // type, an address too long to be one.
  let threw = null;
  const odd = [];
  try {
    for (const r of [undefined, null, {}, { headers: null }, { headers: { 'cf-connecting-ip': ['203.0.113.9', '198.51.100.1'] } }, { headers: { 'cf-connecting-ip': 7 } },
      { headers: { 'cf-connecting-ip': '1'.repeat(5000) } }, { headers: { 'cf-connecting-ip': '::ffff:999.1.1.1' } }, { headers: {}, socket: null }, { headers: {}, socket: { remoteAddress: 12 } }])
      odd.push(clientAddressOf(r).key);
  } catch (e) { threw = e; }
  if (!threw && odd.every((k) => k === null)) ok('J4: no request, a repeated or malformed CF-Connecting-IP, or a socket with no address throws; each is a connection with no address');
  else fail('J4: odd requests: ' + JSON.stringify({ threw: threw && String(threw), odd }));
  // Forgotten an hour after the last attempt, by the sweep, and at most ADDR_MAX remembered.
  const w = world();
  await w.res.refresh();
  for (let i = 0; i < 3; i++) await w.res.claim({ name: `Forget ${i}`, addr: `fa-${i}` });
  const held = w.res.addresses;
  clock += 3600000 - 1; w.res.sweepAddresses(); const still = w.res.addresses;
  clock += 1; w.res.sweepAddresses(); const gone = w.res.addresses;
  // And between sweeps, an attempt from any address forgets the ones an hour old.
  for (let i = 0; i < 3; i++) await w.res.claim({ name: `Forget ${i + 3}`, addr: `fb-${i}` });
  clock += 3600000;
  await w.res.claim({ name: 'Forget Late', addr: 'fb-new' });
  const between = w.res.addresses;
  for (let i = 0; i < ADDR_MAX + 3; i++) await w.res.claim({ name: 'Iron Ridge', addr: `cap-${i}` });
  if (held === 3 && still === 3 && gone === 0 && between === 1 && w.res.addresses === ADDR_MAX) ok(`J4: an address is forgotten an hour after its last attempt (by the sweep, or by the next attempt from anywhere), and at most ${ADDR_MAX} are remembered`);
  else fail('J4: forgetting: ' + JSON.stringify({ held, still, gone, between, cap: w.res.addresses }));
}
{
  // J5. THE CHECK'S REPRODUCTION, NOW LAYERED. The check flooded one process
  // from 200 fresh sockets, three claims each, no hello and no secret: the
  // hourly window filled and two newcomers claiming 'Iron Ridge' were both
  // answered 'unavailable' and both seated as 'Iron Ridge'. Now: the bare
  // flood makes no row at all; the same flood saying hello from one address
  // makes thirty; two newcomers from their own addresses are answered, the
  // second moved to an unused default and told, and the door seats each under
  // their own name.
  const w = socialWorld({ live: true, door: true });
  await w.res.refresh();
  const unwire = wire(w);
  const t0 = clock;
  let bareRows = 0;
  for (let i = 0; i < 200; i++) {
    const s = mkws(); s.saidHello = false; s.clientAddr = 'script';
    for (let k = 0; k < 3; k++) { clock = t0 + i * 3 + k; await w.social.handle(s, { type: 'name', name: `Squat ${i} ${k}`.slice(0, 16), id: k }); }
  }
  bareRows = w.table.rows.length;
  for (let i = 0; i < 200; i++) {
    const s = mkws(); s.clientAddr = 'script';
    for (let k = 0; k < 3; k++) { clock = t0 + 1000 + i * 3 + k; await w.social.handle(s, { type: 'name', name: `Squat ${i} ${k}`.slice(0, 16), id: k }); }
  }
  const helloRows = w.table.rows.length;
  clock = t0 + 5 * 60000;
  const n1 = mkws(), n2 = mkws(); n1.clientAddr = 'phone-1'; n2.clientAddr = 'phone-2';
  await w.social.handle(n1, { type: 'name', name: 'Iron Ridge', id: 1 });
  await w.social.handle(n2, { type: 'name', name: 'Iron Ridge', id: 1 });
  const s1 = ews({ reservedName: n1.reservedName }), s2 = ews({ reservedName: n2.reservedName });
  const code = openRoom(s1, 'Iron Ridge');
  const seat2 = joinRoom(s2, code, 'Iron Ridge');
  const seat1 = seatOfWs(s1);
  shut(s1, s2);
  unwire();
  if (bareRows === 0 && helloRows === ADDR_ROWS_PER_HOUR && last(n1).ok && last(n1).name === 'Iron Ridge' && !last(n1).moved
      && last(n2).ok && last(n2).moved === 'taken' && last(n2).name !== 'Iron Ridge' && seat1.name === 'Iron Ridge' && !seat1.renamed
      && seat2.name === last(n2).name && !seat2.renamed)
    ok(`J5: the check's flood (200 sockets, 3 claims each) makes no row with no hello and ${ADDR_ROWS_PER_HOUR} from one address with one; two newcomers then claim 'Iron Ridge': the first holds it, the second is moved to '${last(n2).name}' and told, and a room seats each under their own`);
  else fail('J5: layered: ' + JSON.stringify({ bareRows, helloRows, n1: last(n1), n2: last(n2), seat1, seat2 }));
}
{
  // J6. STARVED ANYWAY, STILL NEVER ONE NAME. A hundred addresses fill the
  // process-wide window (the most this layer cannot stop); two newcomers
  // claiming 'Iron Ridge' are both 'unavailable'. In one room the second is
  // moved to a stand-in and told; in two rooms at once the second is too
  // (the first is live), and so is one typing it in other capitals.
  const w = socialWorld({ live: true, door: true });
  await w.res.refresh();
  const unwire = wire(w);
  const t0 = clock;
  for (let i = 0; i < ROWS_PER_HOUR; i++) { clock = t0 + i; await w.res.claim({ name: `Wave ${i}`, addr: `flood-${Math.floor(i / ADDR_ROWS_PER_HOUR)}` }); }
  clock = t0 + ROWS_PER_HOUR;
  const n1 = mkws(), n2 = mkws(), n3 = mkws(), n4 = mkws();
  for (const [s, a] of [[n1, 'p1'], [n2, 'p2'], [n3, 'p3'], [n4, 'p4']]) { s.clientAddr = a; await w.social.handle(s, { type: 'name', name: 'Iron Ridge', id: 1 }); }
  const starved = [n1, n2, n3, n4].every((s) => last(s).error === 'unavailable' && !s.reservedName);
  const a = ews(), b = ews(), c = ews(), d = ews();
  const code = openRoom(a, 'Iron Ridge');
  const sb = joinRoom(b, code, 'Iron Ridge');
  const code2 = openRoom(c, 'Iron Ridge');
  const sc = seatOfWs(c);
  const sd = joinRoom(d, code2, 'IRON RIDGE');
  const sa = seatOfWs(a);
  const names = [sa, sb, sc, sd].map((x) => x && x.name);
  const distinct = names.every((n, i) => names.every((m, j) => i === j || !sameName(n, m)));
  const free = [sb, sc, sd].every((x) => x && w.res.free(x.name));
  shut(a, b); shut(c, d);
  unwire();
  if (starved && sa.name === 'Iron Ridge' && !sa.renamed && sb.renamed && sc.renamed && sd.renamed && distinct && free)
    ok(`J6: with the window full, newcomers are unreserved, yet nobody is shown another's name: in one room the second 'Iron Ridge' is '${sb.name}', in another room at the same time '${sc.name}' (the first is live), and 'IRON RIDGE' there '${sd.name}', each told`);
  else fail('J6: starved: ' + JSON.stringify({ starved, sa, sb, sc, sd }));
}

// ==== K. a stand-in is never anybody's ========================================
{
  // K1. THE POOL: game-core's default names are, name for name, the tiers
  // the reservations have always handed out, written out here on their own
  // (4737039's derivation) rather than read back from the module, and a
  // default may be as long as a typed name. The server's tiers are read from
  // the pool, so they match it too.
  const pairs = [];
  for (const noun of CALL_NOUN) for (const adj of CALL_ADJ) if (adj.length + 1 + noun.length <= NAME_MAX) pairs.push(`${adj} ${noun}`);
  const numbered = [];
  for (const d of ['2', '3', '4', '5', '6', '7', '8', '9']) for (const p of pairs) numbered.push(`${p} ${d}`);
  const two = pairs.filter((p) => p.length + 3 <= CALLSIGN_MAX), three = pairs.filter((p) => p.length + 4 <= CALLSIGN_MAX);
  const wideAt = (i) => (i < two.length * 90 ? `${two[Math.floor(i / 90)]} ${10 + (i % 90)}` : `${three[Math.floor((i - two.length * 90) / 900)]} ${100 + ((i - two.length * 90) % 900)}`);
  const want = pairs.length + numbered.length + two.length * 90 + three.length * 900;
  let sameAll = defaultNameCount() === want && same(defaultPairs(), pairs) && same(DEFAULT_TIERS[0], pairs) && same(DEFAULT_TIERS[1], numbered) && WIDE_DEFAULTS.size === want - pairs.length - numbered.length;
  for (let i = 0; sameAll && i < want; i++) {
    const n = i < pairs.length ? pairs[i] : i < pairs.length + numbered.length ? numbered[i - pairs.length] : wideAt(i - pairs.length - numbered.length);
    if (defaultNameAt(i) !== n) sameAll = false;
    else if (i >= pairs.length + numbered.length && WIDE_DEFAULTS.at(i - pairs.length - numbered.length) !== n) sameAll = false;
  }
  if (sameAll && DEFAULT_NAME_MAX === CALLSIGN_MAX && want === 1088136 && defaultNameAt(-1) === null && defaultNameAt(want) === null)
    ok('K1: game-core\'s pool is the 1,088,136 default names the reservations have always handed out, name for name, the server\'s tiers read from it, and its length limit is a typed name\'s (16)');
  else fail('K1: pool: ' + JSON.stringify({ n: defaultNameCount(), max: DEFAULT_NAME_MAX }));
}
{
  // K2. EVERY PAIR RESERVED (the check: three hours of a flood, or about
  // 1,454 players holding defaults). A socket presenting a pair someone holds,
  // or a name the guidelines refuse, is given a stand-in nobody holds, that
  // meets the guidelines; before, every seed was held and the first stood.
  const w = world();
  for (const p of DEFAULT_TIERS[0]) rowFor(w.table, p);
  await w.res.refresh();
  const unwire = wire(w);
  const a = ews(), b = ews(), c = ews();
  const code = openRoom(a, 'Iron Ridge');
  const sa = seatOfWs(a);
  const sb = joinRoom(b, code, 'Steel Gunner');
  const sc = joinRoom(c, code, 'x');
  shut(a, b, c);
  unwire();
  const ok3 = [sa, sb, sc].every((s) => s && s.renamed && w.res.free(s.name) && w.proofs.checkPlayerName(s.name).ok && !isGeneratedCallsign(s.name));
  const names = [sa, sb, sc].map((s) => s && s.name);
  if (ok3 && new Set(names.map((n) => nameKeyOf(n))).size === 3)
    ok(`K2: with all 1,454 pairs reserved, the stand-ins are names nobody holds that meet the guidelines ('${names.join("', '")}'), never a held pair`);
  else fail('K2: all pairs held: ' + JSON.stringify({ sa, sb, sc, free: names.map((n) => n && w.res.free(n)) }));
}
{
  // K2b. A STAND-IN PAST THE PAIRS MEETS THE GUIDELINES. Some numbered
  // defaults fail them (2,787 of the pool, a number a term is spelt with; 70
  // of those only by the server's term list, not the engine's own filter). A
  // refused name whose walk's first name past the pairs is one of those is
  // found (a name the guidelines refuse, so the door stands one in), and
  // seated with every pair held: its stand-in is a later one.
  const w = world();
  for (const p of DEFAULT_TIERS[0]) rowFor(w.table, p);
  await w.res.refresh();
  const unwire = wire(w);
  const seed = (n) => [...n].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
  let raw = null, first = null;
  for (let i = 0; i < 400000 && !raw; i++) {
    const n = `#${i}`;
    const f = standInWalk(seed(n), (c) => !isGeneratedCallsign(c));
    // One the engine's own word filter passes, so only the host's check
    // (the server's term list) stands between it and the seat.
    if (f && !isProfane(f) && !w.proofs.checkPlayerName(f).ok) { raw = n; first = f; }
  }
  const a = ews();
  if (raw) openRoom(a, raw);
  const sa = raw ? seatOfWs(a) : null;
  shut(a);
  unwire();
  if (raw && sa && sa.renamed && sa.name !== first && w.proofs.checkPlayerName(sa.name).ok && w.res.free(sa.name))
    ok(`K2b: '${raw}' would have stood in as '${first}', which the guidelines refuse; it is seated as '${sa.name}', which they pass`);
  else fail('K2b: guidelines: ' + JSON.stringify({ raw, first, sa }));
}
{
  // K3. NEVER A LIVE PLAYER'S NAME. Two sockets refused the same name, each
  // in a room of their own at the same time, are given two stand-ins; and the
  // first stand-in is deterministic: the same refusal in the same state is
  // the same name.
  const w = world();
  await w.res.refresh();
  await w.res.claim({ name: 'Steel Gunner' });
  const unwire = wire(w);
  const a = ews(), b = ews();
  openRoom(a, 'Steel Gunner');
  const sa = seatOfWs(a);
  openRoom(b, 'Steel Gunner');
  const sb = seatOfWs(b);
  shut(a); shut(b);
  const c = ews();
  openRoom(c, 'Steel Gunner');
  const sc = seatOfWs(c);
  shut(c);
  unwire();
  if (sa.renamed && sb.renamed && !sameName(sa.name, sb.name) && sc.name === sa.name && w.res.free(sa.name) && w.res.free(sb.name))
    ok(`K3: two players refused 'Steel Gunner' at once, in two rooms, are '${sa.name}' and '${sb.name}': a stand-in is never a live player's name, and is still the same name for the same refusal`);
  else fail('K3: live stand-ins: ' + JSON.stringify({ sa, sb, sc }));
}
{
  // K4. A SERVER-ASSIGNED DEFAULT IS NEVER A LIVE PLAYER'S NAME. Every pair
  // but one is reserved, and that one is live: a player whose claim was not
  // answered is seated under it. The next player moved to a default is given
  // a numbered name, not that pair.
  const w = socialWorld({ live: true, door: true });
  const keep = DEFAULT_TIERS[0][700];
  for (const p of DEFAULT_TIERS[0]) if (p !== keep) rowFor(w.table, p);
  await w.res.refresh();
  const unwire = wire(w);
  const liveWs = ews();
  openRoom(liveWs, keep);
  const seen = seatOfWs(liveWs);
  const n = mkws();
  await w.social.handle(n, { type: 'name', name: DEFAULT_TIERS[0][0], id: 1 });
  shut(liveWs);
  const after = mkws();
  await w.social.handle(after, { type: 'name', name: DEFAULT_TIERS[0][1], id: 2 });
  unwire();
  if (seen.name === keep && !seen.renamed && last(n).ok && last(n).moved === 'taken' && last(n).name !== keep && !isGeneratedCallsign(last(n).name)
      && last(after).ok && last(after).name === keep)
    ok(`K4: with '${keep}' the only free pair and a live player shown under it, a moved player is given '${last(n).name}', not it; once that player has gone, the pair is handed out again`);
  else fail('K4: live default: ' + JSON.stringify({ keep, seen, n: last(n), after: last(after) }));
}

// ==== L. no two humans in one room or one squad are shown one name ==============
{
  // L1. THE TABLE MISSING (the state the server ships into): nothing is
  // reserved, and still a room never shows one name twice: the same pair, the
  // same name in other capitals, a look-alike in another script. Computers
  // keep their own names, and a quick match's second seat is kept apart too.
  const w = world();
  w.table.keysFail = new Error('sb GET 404');
  await w.res.refresh();
  const unwire = wire(w);
  const a = ews(), b = ews(), c = ews(), d = ews();
  const code = openRoom(a, 'Iron Ridge');
  const sb = joinRoom(b, code, 'Iron Ridge');
  const sc = joinRoom(c, code, 'iron ridge');
  const sd = joinRoom(d, code, 'Basalt Rim');
  const sa = seatOfWs(a);
  shut(a, b, c, d);
  // A seat whose socket is closing (its close not yet handled) is still in
  // the room, and still shown there: nobody may join under its name.
  const h = ews(), g = ews();
  const code3 = openRoom(h, 'Basalt Rim');
  h.readyState = 2;
  const sg = joinRoom(g, code3, 'Basalt Rim');
  h.readyState = 1;
  shut(h, g);
  const e = ews(), f = ews();
  const code2 = openRoom(e, 'Coco');
  const sf = joinRoom(f, code2, 'Сосо');
  const se = seatOfWs(e);
  shut(e, f);
  const q1 = ews(), q2 = ews();
  eng.handleClientMessage(q1, { type: 'quick', name: 'Dusty Mule', skin: 'olive' });
  eng.handleClientMessage(q2, { type: 'quick', name: 'Dusty Mule', skin: 'olive' });
  const qa = seatOfWs(q1), qb = seatOfWs(q2);
  const qStart = q2._rx.find((m) => m.type === 'start');
  shut(q1, q2);
  const cpu = ews();
  eng.handleClientMessage(cpu, { type: 'ai', difficulty: 'easy', mode: 'ffa', max: 4, name: 'Iron Ridge', skin: 'olive', loadout: FIVE });
  const cr = eng.rooms.get(cpu.roomCode);
  const cpuNames = cr ? cr.players.map((p) => p.name) : [];
  shut(cpu);
  unwire();
  if (!w.res.ready && sa.name === 'Iron Ridge' && !sa.renamed && sb.renamed && sc.renamed && !sameName(sb.name, 'Iron Ridge') && !sameName(sc.name, 'Iron Ridge') && !sameName(sb.name, sc.name)
      && sd.name === 'Basalt Rim' && !sd.renamed && sg && sg.renamed && !sameName(sg.name, 'Basalt Rim') && se.name === 'Coco' && sf.renamed && !sameName(sf.name, 'Coco')
      && qa.name === 'Dusty Mule' && qb.renamed && qb.name !== 'Dusty Mule' && qStart && qStart.renamed === true
      && cpuNames[0] === 'Iron Ridge' && cpuNames.length === 4 && new Set(cpuNames).size === 4)
    ok(`L1: with the table missing, a room never shows one name twice: the second 'Iron Ridge' is '${sb.name}', 'iron ridge' is '${sc.name}', 'Basalt Rim' beside a seat whose socket is closing is '${sg.name}', Cyrillic 'Сосо' beside 'Coco' is '${sf.name}', each told; a quick match's second 'Dusty Mule' is '${qb.name}' and its start frame says so; computers keep their names`);
  else fail('L1: table missing: ' + JSON.stringify({ sa, sb, sc, sd, sg, se, sf, qa, qb, renamed: qStart && qStart.renamed, cpuNames }));
}
{
  // L2. THE STORE DOWN, AND A NAME TWO SOCKETS ARE BOTH ALLOWED. With the
  // store failing, two newcomers' claims fail and both present one name: the
  // second in the room is moved. And two sockets carrying one server-held
  // name (a vouch, or a look-alike written by another instance in a deploy's
  // overlap) in one room: the later is moved and told, even though the name
  // is one the server holds for it.
  const w = socialWorld({ live: true, door: true });
  await w.res.refresh();
  const unwire = wire(w);
  w.table.secretFail = new Error('sb 503');
  const realInsert = w.table.insertReservation;
  w.table.insertReservation = async () => { throw new Error('sb 503'); };
  const n1 = mkws(), n2 = mkws();
  await w.social.handle(n1, { type: 'name', name: 'Quiet Dawn', secret: 'R'.repeat(43), id: 1 });
  await w.social.handle(n2, { type: 'name', name: 'Quiet Dawn', secret: 'S'.repeat(43), id: 1 });
  w.table.secretFail = null; w.table.insertReservation = realInsert;
  const a = ews({ reservedName: n1.reservedName }), b = ews({ reservedName: n2.reservedName });
  const code = openRoom(a, 'Quiet Dawn');
  const sb = joinRoom(b, code, 'Quiet Dawn');
  const sa = seatOfWs(a);
  shut(a, b);
  const c = ews({ reservedName: 'Marguerite Vale' }), d = ews({ chosenName: 'MARGUERITE VALE' });
  const code2 = openRoom(c, 'x');
  const sd = joinRoom(d, code2, 'y');
  const sc = seatOfWs(c);
  const snap = (() => { eng.handleClientMessage(c, { type: 'startMatch' }); return d._rx.find((m) => m.type === 'start'); })();
  shut(c, d);
  unwire();
  if (last(n1).error === 'unavailable' && last(n2).error === 'unavailable' && sa.name === 'Quiet Dawn' && !sa.renamed && sb.renamed && !sameName(sb.name, 'Quiet Dawn')
      && sc.name === 'Marguerite Vale' && !sc.renamed && sd.renamed && !sameName(sd.name, 'Marguerite Vale') && snap && snap.renamed === true && snap.names[snap.you] === sd.name)
    ok(`L2: with the store down two unreserved 'Quiet Dawn's in one room are 'Quiet Dawn' and '${sb.name}'; two sockets both allowed 'Marguerite Vale' are it and '${sd.name}', the later told in its start frame`);
  else fail('L2: store down / allowed clash: ' + JSON.stringify({ n1: last(n1), n2: last(n2), sa, sb, sc, sd, snap: snap && { renamed: snap.renamed, names: snap.names } }));
}
{
  // L3. A SQUAD. The table missing; a signed-in leader whose profile name is
  // 'Iron Ridge' and a guest who joined as 'Iron Ridge'. The box never shows
  // the two one name: the guest's row is the stand-in the room will seat them
  // under. The squad starts: the leader is seated 'Iron Ridge', the guest
  // under that same stand-in, told; and no row is ever shown twice.
  const w = socialWorld({ live: true, door: true });
  w.table.keysFail = new Error('sb GET 404');
  await w.res.refresh();
  const unwire = wire(w);
  w.profiles.set(U1, { id: U1, callsign: 'Iron Ridge', callsign_key: null });
  const lead = Object.assign(ews(), mkws(U1, false)); w.social.onAuth(lead);
  const guest = Object.assign(ews(), mkws());
  await w.social.handle(lead, { type: 'squad', op: 'create', name: 'Iron Ridge', skin: 'olive', id: 'c' });
  const code = (lead._rx.find((m) => m.type === 'squad' && m.op === 'state') || {}).code;
  await w.social.handle(guest, { type: 'squad', op: 'join', code, name: 'Iron Ridge', skin: 'gold', id: 'j' });
  const box = [...guest._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state');
  const rows = box ? box.members.map((m) => m.callsign) : [];
  const live = w.social.liveNames().map((e) => e.name).sort();
  // The box's names are live: a stranger opening a room as the leader's name
  // is moved while the squad stands.
  const stranger = ews();
  openRoom(stranger, 'Iron Ridge');
  const ss = seatOfWs(stranger);
  shut(stranger);
  await w.social.handle(lead, { type: 'squad', op: 'ready', ready: true, loadout: FIVE, id: 'r1' });
  await w.social.handle(guest, { type: 'squad', op: 'ready', ready: true, loadout: FIVE, id: 'r2' });
  await w.social.handle(lead, { type: 'squad', op: 'start', id: 's' });
  const sl = seatOfWs(lead), sg = seatOfWs(guest);
  const st = guest._rx.find((m) => m.type === 'start');
  shut(lead, guest);
  unwire();
  if (rows.length === 2 && rows[0] === 'Iron Ridge' && typeof rows[1] === 'string' && !sameName(rows[1], 'Iron Ridge') && same(live, [...rows].sort())
      && ss && ss.renamed && !sameName(ss.name, 'Iron Ridge') && !sameName(ss.name, rows[1])
      && sl && sl.name === 'Iron Ridge' && !sl.renamed && sg && sg.name === rows[1] && sg.renamed && st && st.renamed === true && st.names[st.you] === rows[1])
    ok(`L3: a squad's box shows its leader 'Iron Ridge' and the guest who joined as 'Iron Ridge' as '${rows[1]}', and a stranger opening a room as 'Iron Ridge' meanwhile is '${ss.name}'; its start seats them so, the guest told in the match`);
  else fail('L3: squad: ' + JSON.stringify({ code, rows, live, ss, sl, sg, st: st && { renamed: st.renamed, names: st.names }, rx: guest._rx.filter((m) => m.type === 'squad').map((m) => m.op + ':' + (m.error || '')) }));
}
{
  // L4. THE LATER MEMBER IS THE ONE MOVED, IN THE BOX AS IN THE ROOM. Two
  // guests in a squad with a signed-in leader, the table missing: the first
  // joined as 'Quiet Dawn', the second as 'Brass Hawk'. The first then
  // changes their name to 'Brass Hawk': the box keeps it for the first (they
  // come first) and moves the second, rather than taking the second's shown
  // name as a live name elsewhere and moving the first; the start agrees.
  const w = socialWorld({ live: true, door: true });
  w.table.keysFail = new Error('sb GET 404');
  await w.res.refresh();
  const unwire = wire(w);
  w.profiles.set(U1, { id: U1, callsign: 'Iron Ridge', callsign_key: null });
  const lead = Object.assign(ews(), mkws(U1, false)); w.social.onAuth(lead);
  const g1 = Object.assign(ews(), mkws()), g2 = Object.assign(ews(), mkws());
  await w.social.handle(lead, { type: 'squad', op: 'create', name: 'Iron Ridge', skin: 'olive', id: 'c' });
  const code = (lead._rx.find((m) => m.type === 'squad' && m.op === 'state') || {}).code;
  await w.social.handle(g1, { type: 'squad', op: 'join', code, name: 'Quiet Dawn', skin: 'gold', id: 'j1' });
  await w.social.handle(g2, { type: 'squad', op: 'join', code, name: 'Brass Hawk', skin: 'gold', id: 'j2' });
  await w.social.handle(g1, { type: 'callsign', op: 'check', name: 'Brass Hawk', id: 'k' });
  const box = [...lead._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state');
  const rows = box ? box.members.map((m) => m.callsign) : [];
  await w.social.handle(lead, { type: 'squad', op: 'mode', mode: 'ffa', id: 'm' });
  for (const [s, k] of [[lead, 'r0'], [g1, 'r1'], [g2, 'r2']]) await w.social.handle(s, { type: 'squad', op: 'ready', ready: true, loadout: FIVE, id: k });
  await w.social.handle(lead, { type: 'squad', op: 'start', id: 's' });
  const seats = [lead, g1, g2].map(seatOfWs);
  shut(lead, g1, g2);
  unwire();
  if (rows.length === 3 && rows[0] === 'Iron Ridge' && rows[1] === 'Brass Hawk' && typeof rows[2] === 'string' && !sameName(rows[2], 'Brass Hawk') && !sameName(rows[2], 'Iron Ridge')
      && seats.every(Boolean) && seats[0].name === 'Iron Ridge' && seats[1].name === 'Brass Hawk' && !seats[1].renamed && seats[2].name === rows[2] && seats[2].renamed)
    ok(`L4: a guest who changes their name to a later member's ('Brass Hawk') keeps it, and the later member is moved, to '${rows[2]}', in the box and in the room`);
  else fail('L4: later moves: ' + JSON.stringify({ rows, seats, rx: lead._rx.filter((m) => m.type === 'squad').map((m) => m.op + ':' + (m.error || '')) }));
}
{
  // L5. A NAME THE SERVER DOES NOT HOLD IS NOT SHOWN IN A BOX WHILE A LIVE
  // PLAYER ELSEWHERE IS SHOWN UNDER IT, as the room's door would not seat it;
  // one the server holds for the member is, even while the same player's other
  // device is in a room under it.
  const w = socialWorld({ live: true, door: true });
  w.table.keysFail = new Error('sb GET 404');
  await w.res.refresh();
  const unwire = wire(w);
  w.profiles.set(U1, { id: U1, callsign: 'Iron Ridge', callsign_key: null });
  const lead = Object.assign(ews(), mkws(U1, false)); w.social.onAuth(lead);
  const elsewhere = ews(), otherDevice = ews({ reservedName: 'Copper Mesa' });
  openRoom(elsewhere, 'Quiet Dawn');
  openRoom(otherDevice, 'x');
  const sOther = seatOfWs(otherDevice);
  const g1 = Object.assign(ews(), mkws()), g2 = Object.assign(ews(), mkws(), { reservedName: 'Copper Mesa' });
  await w.social.handle(lead, { type: 'squad', op: 'create', name: 'Iron Ridge', skin: 'olive', id: 'c' });
  const code = (lead._rx.find((m) => m.type === 'squad' && m.op === 'state') || {}).code;
  await w.social.handle(g1, { type: 'squad', op: 'join', code, name: 'Quiet Dawn', skin: 'gold', id: 'j1' });
  await w.social.handle(g2, { type: 'squad', op: 'join', code, name: 'Copper Mesa', skin: 'gold', id: 'j2' });
  const box = [...lead._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state');
  const rows = box ? box.members.map((m) => m.callsign) : [];
  shut(elsewhere); shut(otherDevice);
  unwire();
  if (sOther && sOther.name === 'Copper Mesa' && rows.length === 3 && rows[0] === 'Iron Ridge' && typeof rows[1] === 'string' && !sameName(rows[1], 'Quiet Dawn') && rows[2] === 'Copper Mesa')
    ok(`L5: a guest who joins a squad as 'Quiet Dawn' while a player elsewhere is shown under it is shown '${rows[1]}'; a member whose reserved 'Copper Mesa' is also on their other device in a room keeps it`);
  else fail('L5: box live: ' + JSON.stringify({ sOther, rows }));
}
{
  // L6. A SOCIAL LAYER HANDED NO ENGINE (a host, or a suite, that wires no
  // door) still never shows two members one name: the later one is shown a
  // stand-in drawn from the same pool, that nobody holds and that meets the
  // guidelines.
  const w = socialWorld();
  await w.res.refresh();
  await w.res.claim({ name: 'Steel Gunner' });
  // The first name each guest's stand-in walk tries is held by somebody, so
  // the box must skip it.
  const seed = (n, seat) => [...n].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7) + seat * 2654435761;
  const firstTried = [callsignFromSeed(seed('IRON RIDGE', 1)), callsignFromSeed(seed('Steel Gunner', 2))];
  for (const n of firstTried) await w.res.claim({ name: n });
  w.profiles.set(U1, { id: U1, callsign: 'Iron Ridge', callsign_key: null });
  const lead = mkws(U1, false); w.social.onAuth(lead);
  const g1 = mkws(), g2 = mkws();
  await w.social.handle(lead, { type: 'squad', op: 'create', name: 'Iron Ridge', skin: 'olive', id: 'c' });
  const code = (lead._rx.find((m) => m.type === 'squad' && m.op === 'state') || {}).code;
  await w.social.handle(g1, { type: 'squad', op: 'join', code, name: 'IRON RIDGE', skin: 'gold', id: 'j1' });
  await w.social.handle(g2, { type: 'squad', op: 'join', code, name: 'Steel Gunner', skin: 'gold', id: 'j2' });
  const box = [...lead._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state');
  const rows = box ? box.members.map((m) => m.callsign) : [];
  const distinct = rows.every((n, i) => rows.every((x, j) => i === j || !sameName(n, x)));
  if (rows.length === 3 && rows[0] === 'Iron Ridge' && rows[1] && !sameName(rows[1], 'Iron Ridge') && w.res.free(rows[1]) && w.proofs.checkPlayerName(rows[1]).ok
      && rows[2] && rows[2] !== 'Steel Gunner' && w.res.free(rows[2]) && distinct && !firstTried.includes(rows[1]) && !firstTried.includes(rows[2]))
    ok(`L6: with no engine handed in, a squad's box still shows the guest who joined as 'IRON RIDGE' beside its leader 'Iron Ridge' as '${rows[1]}', and one who joined as another player's reserved 'Steel Gunner' as '${rows[2]}'`);
  else fail('L6: no door: ' + JSON.stringify({ rows, firstTried }));
}
// A ROW THE BOX COULD NOT NAME (the round 3 check, 2026-10-10). A row whose
// name came out null was given no stand-in, so the player's own page drew
// that row with the device's own name, which could be the name another member
// is shown under, and the match then seated the player under a stand-in the
// box had never shown. What a member's own page draws for its own row is
// played out here as the client draws it (bay.js sqRowParts): the server's
// name whenever the frame carries one, and the device's name otherwise.
const drawnBy = (box, mine) => box.members.map((m, i) => (typeof m.callsign === 'string' && m.callsign ? m.callsign : i === box.you ? mine : null));
const noTwo = (rows) => rows.every((n, i) => n === null || rows.every((x, j) => i === j || x === null || !sameName(n, x)));
{
  // L7. THE SHIPPING STATE, ON THE GUEST'S OWN SCREEN. The table missing; a
  // signed-in leader whose chosen callsign is 'Marguerite Vale'; a guest whose
  // device name is the same typed name, typed before the account chose it (so
  // the guidelines now refuse it to the guest: an account holds it); a second
  // guest as 'Iron Ridge'. Every row carries a name, the guest's is the
  // stand-in the match seats them under, and no screen shows one name twice.
  const w = socialWorld({ live: true, door: true, chosen: ['marguerite vale'] });
  w.table.keysFail = new Error('sb GET 404');
  await w.res.refresh();
  const unwire = wire(w);
  w.profiles.set(U1, { id: U1, callsign: 'Marguerite Vale', callsign_key: 'marguerite vale' });
  const lead = Object.assign(ews(), mkws(U1, false), { chosenName: 'Marguerite Vale' }); w.social.onAuth(lead);
  const guest = Object.assign(ews(), mkws()), guest2 = Object.assign(ews(), mkws());
  await w.social.handle(lead, { type: 'squad', op: 'create', name: 'Marguerite Vale', skin: 'olive', id: 'c' });
  const code = (lead._rx.find((m) => m.type === 'squad' && m.op === 'state') || {}).code;
  await w.social.handle(guest, { type: 'squad', op: 'join', code, name: 'Marguerite Vale', skin: 'gold', id: 'j1' });
  await w.social.handle(guest2, { type: 'squad', op: 'join', code, name: 'Iron Ridge', skin: 'gold', id: 'j2' });
  const box = [...guest._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state') || { members: [], you: -1 };
  const rows = box.members.map((m) => m.callsign);
  const screens = [lead, guest, guest2].map((s, k) => {
    const f = [...s._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state') || { members: [], you: -1 };
    return drawnBy(f, ['Marguerite Vale', 'Marguerite Vale', 'Iron Ridge'][k]);
  });
  // A REPORT ON THE ROW RECORDS THE NAME THE ROW SHOWED (handleReport, for a
  // guest with no account: the log line), which is the stand-in the leader
  // saw, never nothing.
  const said = [];
  const realLog = console.log;
  console.log = (...a) => { said.push(a.join(' ')); };
  try { await w.social.handle(lead, { type: 'report', rid: (box.members[1] || {}).rid, id: 'q' }); }
  finally { console.log = realLog; }
  const reported = lead._rx.find((m) => m.type === 'report' && m.id === 'q');
  const logged = said.find((l) => l.startsWith('[report] guest in squad'));
  await w.social.handle(lead, { type: 'squad', op: 'mode', mode: 'ffa', id: 'm' });
  for (const [s, k] of [[lead, 'r0'], [guest, 'r1'], [guest2, 'r2']]) await w.social.handle(s, { type: 'squad', op: 'ready', ready: true, loadout: FIVE, id: k });
  await w.social.handle(lead, { type: 'squad', op: 'start', id: 's' });
  const seats = [lead, guest, guest2].map(seatOfWs);
  const st = guest._rx.find((m) => m.type === 'start');
  shut(lead, guest, guest2);
  unwire();
  if (box.you === 1 && rows.length === 3 && rows.every((n) => typeof n === 'string' && n) && rows[0] === 'Marguerite Vale' && rows[2] === 'Iron Ridge'
      && !sameName(rows[1], 'Marguerite Vale') && noTwo(rows) && screens.every((s) => s.every((n) => typeof n === 'string') && noTwo(s))
      && seats.every(Boolean) && same(seats.map((s) => s.name), rows) && !seats[0].renamed && seats[1].renamed && !seats[2].renamed
      && st && st.renamed === true && st.names[st.you] === rows[1]
      && reported && reported.ok === true && logged === `[report] guest in squad ${code} seat 2 "${rows[1]}" by ${U1}`)
    ok(`L7: with the table missing, a guest whose device name an account has since chosen ('Marguerite Vale') is shown in the box, on every member's screen and their own, as '${rows[1]}', the match seats them so and tells them, and a report on the row records '${rows[1]}'`);
  else fail('L7: the guest\'s own screen: ' + JSON.stringify({ you: box.you, rows, screens, seats, st: st && { renamed: st.renamed, names: st.names, you: st.you }, reported, logged }));
}
{
  // L8. A PROFILE READ THAT FAILS. The table missing; the squad's one name
  // read fails. The leader's chosen callsign is the one their socket holds,
  // which the match seats; a second account with no chosen callsign presented
  // the rolled pair 'Iron Ridge', which the match seats too; a guest who
  // joined after them as 'Iron Ridge' is the later member and is moved; and a
  // third account presented 'Quiet Dawn' while a player elsewhere is shown
  // under it, a name the server does not hold for them, so the match moves
  // them and the box must too. The box says all four and agrees with the
  // match. Before this fix the accounts' rows were null, the second account's
  // own page drew its own row 'Iron Ridge' beside the guest's 'Iron Ridge',
  // and the match moved a member the box had not.
  const w = socialWorld({ live: true, door: true, chosen: ['marguerite vale'] });
  w.table.keysFail = new Error('sb GET 404');
  await w.res.refresh();
  const unwire = wire(w);
  w.profiles.set(U1, { id: U1, callsign: 'Marguerite Vale', callsign_key: 'marguerite vale' });
  w.profiles.set(U2, { id: U2, callsign: 'Iron Ridge', callsign_key: null });
  w.profiles.set(U3, { id: U3, callsign: 'Quiet Dawn', callsign_key: null });
  const lead = Object.assign(ews(), mkws(U1, false), { chosenName: 'Marguerite Vale' }); w.social.onAuth(lead);
  const acct = Object.assign(ews(), mkws(U2, false)); w.social.onAuth(acct);
  const third = Object.assign(ews(), mkws(U3, false)); w.social.onAuth(third);
  const guest = Object.assign(ews(), mkws());
  const elsewhere = ews();
  openRoom(elsewhere, 'Quiet Dawn');
  const realRead = w.table.profilesByIds;
  w.table.profilesByIds = async () => { throw new Error('sb GET 500'); };
  await w.social.handle(lead, { type: 'squad', op: 'create', name: 'Marguerite Vale', skin: 'olive', id: 'c' });
  const code = (lead._rx.find((m) => m.type === 'squad' && m.op === 'state') || {}).code;
  await w.social.handle(acct, { type: 'squad', op: 'join', code, name: 'Iron Ridge', skin: 'desert', id: 'j1' });
  await w.social.handle(guest, { type: 'squad', op: 'join', code, name: 'Iron Ridge', skin: 'gold', id: 'j2' });
  await w.social.handle(third, { type: 'squad', op: 'join', code, name: 'Quiet Dawn', skin: 'olive', id: 'j3' });
  const box = [...acct._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state') || { members: [], you: -1 };
  const rows = box.members.map((m) => m.callsign);
  const screens = [lead, acct, guest, third].map((s) => {
    const f = [...s._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state') || { members: [], you: -1 };
    return drawnBy(f, ['Marguerite Vale', 'Iron Ridge', 'Iron Ridge', 'Quiet Dawn'][f.you]);
  });
  await w.social.handle(lead, { type: 'squad', op: 'mode', mode: 'ffa', id: 'm' });
  for (const [s, k] of [[lead, 'r0'], [acct, 'r1'], [guest, 'r2'], [third, 'r3']]) await w.social.handle(s, { type: 'squad', op: 'ready', ready: true, loadout: FIVE, id: k });
  await w.social.handle(lead, { type: 'squad', op: 'start', id: 's' });
  const seats = [lead, acct, guest, third].map(seatOfWs);
  w.table.profilesByIds = realRead;
  shut(lead, acct, guest, third);
  shut(elsewhere);
  unwire();
  if (box.you === 1 && rows.length === 4 && same(rows.slice(0, 2), ['Marguerite Vale', 'Iron Ridge']) && rows.every((n) => typeof n === 'string' && n) && noTwo(rows)
      && !sameName(rows[3], 'Quiet Dawn') && screens.every((s) => s.every((n) => typeof n === 'string') && noTwo(s))
      && seats.every(Boolean) && same(seats.map((s) => s.name), rows) && !seats[0].renamed && !seats[1].renamed && seats[2].renamed && seats[3].renamed)
    ok(`L8: with the name read failing, the box names the leader by the chosen callsign their socket holds, the account that presented 'Iron Ridge' by it, the later guest as '${rows[2]}' and the account whose 'Quiet Dawn' is live elsewhere as '${rows[3]}', and the match seats exactly those`);
  else fail('L8: failed read: ' + JSON.stringify({ you: box.you, rows, screens, seats }));
}
{
  // L9. A ROW IS NEVER NAMED BY ANOTHER ACCOUNT'S CALLSIGN. server.js moves a
  // socket to another account by taking it out of its squad first (onClose)
  // and only then writing the new account on it. Were a snapshot ever built
  // between those two, the old account's row must not show the chosen
  // callsign the socket now carries for the new one (chosenOf asks that the
  // socket is still the row's account): it is named as any row is.
  const w = socialWorld({ live: true, door: true, chosen: ['marguerite vale', 'wren delacroix'] });
  w.table.keysFail = new Error('sb GET 404');
  await w.res.refresh();
  const unwire = wire(w);
  w.profiles.set(U1, { id: U1, callsign: 'Marguerite Vale', callsign_key: 'marguerite vale' });
  w.profiles.set(U2, { id: U2, callsign: 'Iron Ridge', callsign_key: null });
  const lead = Object.assign(ews(), mkws(U1, false), { chosenName: 'Marguerite Vale' }); w.social.onAuth(lead);
  const acct = Object.assign(ews(), mkws(U2, false)); w.social.onAuth(acct);
  await w.social.handle(lead, { type: 'squad', op: 'create', name: 'Marguerite Vale', skin: 'olive', id: 'c' });
  const code = (lead._rx.find((m) => m.type === 'squad' && m.op === 'state') || {}).code;
  await w.social.handle(acct, { type: 'squad', op: 'join', code, name: 'Iron Ridge', skin: 'desert', id: 'j1' });
  const realRead = w.table.profilesByIds;
  w.table.profilesByIds = async () => { throw new Error('sb GET 500'); };
  Object.assign(acct, { userId: U3, chosenName: 'Wren Delacroix' });
  await w.social.handle(Object.assign(ews(), mkws()), { type: 'squad', op: 'join', code, name: 'Basalt Rim', skin: 'gold', id: 'j2' });
  const rows = ([...lead._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state') || { members: [] }).members.map((m) => m.callsign);
  Object.assign(acct, { userId: U2, chosenName: null });
  w.table.profilesByIds = realRead;
  unwire();
  if (same(rows, ['Marguerite Vale', 'Iron Ridge', 'Basalt Rim']) && !JSON.stringify(lead._rx).includes('Wren Delacroix'))
    ok('L9: a row whose socket carries another account\'s chosen callsign is never shown under it; it is named by the name its frame carried');
  else fail('L9: another account\'s name: ' + JSON.stringify(rows));
}
{
  // L10. A CHOSEN CALLSIGN THE TERM LIST NOW REFUSES IS NOT SHOWN FROM THE
  // SOCKET EITHER. The list is read at start-up and can gain a term after a
  // name was set. The box takes such a name off every screen when it comes
  // from the profile (displayName), and must when the read fails and it comes
  // from the socket (chosenOf). The name is built from the shipped list here,
  // and no line below ever prints it.
  const term = TERMS.find((t) => /^[a-z]{5,9}$/.test(t));
  const bad = term[0].toUpperCase() + term.slice(1) + ' Tank';
  const w = socialWorld({ live: true, door: true, chosen: [bad.toLowerCase()] });
  w.table.keysFail = new Error('sb GET 404');
  await w.res.refresh();
  const unwire = wire(w);
  w.profiles.set(U1, { id: U1, callsign: bad, callsign_key: bad.toLowerCase() });
  const lead = Object.assign(ews(), mkws(U1, false), { chosenName: bad }); w.social.onAuth(lead);
  const guest = Object.assign(ews(), mkws());
  const realRead = w.table.profilesByIds;
  w.table.profilesByIds = async () => { throw new Error('sb GET 500'); };
  await w.social.handle(lead, { type: 'squad', op: 'create', name: bad, skin: 'olive', id: 'c' });
  const code = (lead._rx.find((m) => m.type === 'squad' && m.op === 'state') || {}).code;
  await w.social.handle(guest, { type: 'squad', op: 'join', code, name: 'Basalt Rim', skin: 'gold', id: 'j' });
  const rows = ([...guest._rx].reverse().find((m) => m.type === 'squad' && m.op === 'state') || { members: [] }).members.map((m) => m.callsign);
  const shown = JSON.stringify([lead._rx, guest._rx]).toLowerCase().includes(term);
  w.table.profilesByIds = realRead;
  unwire();
  if (rows.length === 2 && typeof rows[0] === 'string' && rows[0] && rows[1] === 'Basalt Rim' && !shown)
    ok('L10: with the name read failing, a chosen callsign the term list now refuses is not shown from the socket: the row shows the stand-in the box gives any name it cannot show');
  else fail('L10: a refused chosen callsign: ' + JSON.stringify({ rows: rows.length, named: typeof rows[0] === 'string', shown }));
}
if (eng.rooms.size === 0) ok('J-L: every room these checks opened is gone, so no seat of theirs is live for the next');
else fail('J-L: rooms left open: ' + [...eng.rooms.keys()].join(','));

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall reserve checks passed');
process.exit(out.errors.length ? 1 : 0);
