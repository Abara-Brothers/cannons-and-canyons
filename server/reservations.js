// server/reservations.js — every player's name, held by the server: one name
// per player, and no two players with the same one.
//
// WHY THIS EXISTS (owner, 2026-10-10, item 28: "Ensure that usernames must be
// unique and no 2 players can have the same exact name"). A chosen callsign
// was already unique (profiles.callsign_key), but it is a signed-in account's
// alone. Every other name was not: two guests could type the same one, and the
// default names come from 1,454 pairs, so two players met under the same name
// in the same lobby. The owner's answers, all binding:
//   * RESERVE ON FIRST CONNECT: the first time ANY player connects, guests
//     included, the server reserves the name they have, as it already does for
//     a chosen callsign. Unique ignoring capitals and look-alike letters, so
//     'Viper', 'viper' and 'Viper' with a Cyrillic i are one name.
//   * FIRST KEEPS IT: whoever reserved a name first keeps it; anyone else gets
//     a NEW UNUSED default name and is told once: "Your name was taken, so
//     you're now X. You can change it in Bay controls." New default names are
//     always picked from unused ones.
//
// ONE ROW PER PLAYER (the table is name_reservations; its migration says what
// each column is for). A row holds the name as shown, its key, and its HOLDER:
//   * a DEVICE, by a random secret this server issues and the device keeps
//     (cc_name_secret in its storage). The table holds only the secret's
//     SHA-256, so a copy of the table names no device and lets nobody claim a
//     name. The secret carries 256 random bits, so the hash needs no salt.
//   * an ACCOUNT (anonymous or linked), by its user id, with the device's
//     secret still on the row when the row moved there from the device.
//
// WHY A SECRET OF THE SERVER'S AND NOT THE ANONYMOUS ACCOUNT (the controller's
// constraint). A guest gets an anonymous Supabase account only on their first
// save, and Supabase limits anonymous sign-ins PER IP ADDRESS; a mobile
// carrier puts many phones behind one address, so on a busy carrier the
// sign-in that would have named the holder can be refused for an hour. A
// player who could not get an account would then have no reservation, and
// their name would be anybody's. The secret is minted here, by this process,
// with nothing in the way, so every player who reaches the game server can
// hold a name. When the player does get an account, the device's row MOVES to
// it (user_id is written onto the same row), so the name is the same name on
// both sides of the move: nothing is released and nothing is re-reserved, and
// no other player can take it in between.
//
// WHAT A CLAIM ANSWERS (claim, below; the client sends one after every hello):
//   * a linked account holding a chosen callsign: that callsign. Its key is in
//     profiles, and any reservation the account still holds is released, so a
//     player never holds two names.
//   * a holder that has a row: the row's name, whatever name the frame carried.
//     The server is the authority on what a player is called.
//   * an account with no row of its own whose device has one: the device's row
//     moves to the account, name and all.
//   * anybody else: a new row for the name the frame carried when it is free
//     and within the guidelines, or else a new unused default, with `moved`
//     saying why ('taken' or 'refused') so the player is told once.
//
// THE TWO NAMESPACES NEVER OVERLAP. A reservation is never made for a name an
// account holds as its chosen callsign, nor a look-alike of one (chosenState,
// the in-memory index server/name-index.js keeps), and the Set refuses a
// chosen callsign another player has reserved (takenFor). The exact key's race
// between the two is a read before a write, as the look-alike check in the
// Set already is: closing it would need both names in one table.
//
// THE FEATURE IS OFF UNTIL THE TABLE ANSWERS. The migration is applied by
// hand, so a deploy may run before it. Until the index's first read of the
// table lands, `ready` is false and every question is answered the old way:
// state() says 'free', free() says yes, a claim answers 'unavailable' (the
// client keeps the name it has) and takenFor() says no. A missing table is a
// 404, the read fails, and the index retries every RETRY_MS, so applying the
// migration turns the feature on within half a minute with no restart.
// /health says which (server.js: supabaseNames and nameReservations).
//
// AND IT FORGETS A GUEST WHO HAS GONE. A row whose holder never linked an
// account and has not connected for RESERVE_TTL_MS (90 days) is deleted by
// the sweep below, once a day, and its name is free again. A linked account's
// row lasts as long as the account; deleting the account deletes the row
// (the foreign key cascades).
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { lookalikeSkeleton, normaliseCallsign } from './callsign.js';
import { createNameIndex } from './name-index.js';
import { RES_KEY_MAX } from './store.js';
import { CALL_ADJ, CALL_NOUN, NAME_MAX } from '../public/game-core.js';

const DAY = 86400000;
export const RESERVE_TTL_MS = 90 * DAY;
// last_seen_at is written at most once a day per row: a reconnect is frequent,
// and the 90 days need nothing finer.
export const TOUCH_MS = DAY;
export const SWEEP_MS = DAY;
// The first sweep waits a minute after boot, so a deploy's restart is not
// also the moment it deletes.
export const SWEEP_FIRST_MS = 60000;
// What newSecret() makes: 32 random bytes in base64url, 43 characters. Any
// other string is not a secret this server issued.
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
// NEW ROWS, PROCESS-WIDE. A claim is open to any socket, and each one that
// finds no row writes one, so a flood of fresh sockets could otherwise reserve
// every default name in minutes. Not per IP address, for the reason above.
// A claim refused by this answers 'slow_down', and that player keeps their name
// by the old rules until their next connect.
export const MINT_PER_MIN = 60;
export const MINT_BURST = 120;

export const nameKeyOf = (name) => lookalikeSkeleton(name);
export const hashSecret = (s) => createHash('sha256').update(String(s)).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');

// THE ONE RULE FOR TWO ANSWERS: a name is taken when either namespace says
// so, and not known when either cannot say.
export function combineStates(a, b) {
  if (a === 'taken' || b === 'taken') return 'taken';
  if (a === 'free' && b === 'free') return 'free';
  return 'unknown';
}

// EVERY DEFAULT NAME, in two tiers. The rolled pairs come first: every "<Adj>
// <Noun>" within NAME_MAX, exactly as the client rolls them (app.js
// rollCallsign) and the engine's fallback seeds them. There are 1,454 of them,
// and with every name unique they run out at 1,454 players. So behind them
// stands the same list with a digit from 2 to 9 ('Iron Ridge 2'), 11,632 more,
// which a 14-character pair always leaves room for inside the 16 a name may
// have. Every candidate still goes through the guidelines before it is used.
export const DEFAULT_TIERS = (() => {
  const pairs = [];
  for (const noun of CALL_NOUN) for (const adj of CALL_ADJ) if (adj.length + 1 + noun.length <= NAME_MAX) pairs.push(`${adj} ${noun}`);
  const numbered = [];
  for (const d of ['2', '3', '4', '5', '6', '7', '8', '9']) for (const p of pairs) numbered.push(`${p} ${d}`);
  return [pairs, numbered];
})();

// Each default's key, worked out once, the first time one is picked: a held
// name is then skipped by a set lookup, and only a free one meets the full
// guidelines. With every default but one held, a pick took 26 ms of the
// event loop doing the guidelines 13,085 times; this keeps it to lookups.
let defaultKeys = null;
const defaultKey = (name) => {
  if (!defaultKeys) defaultKeys = new Map(DEFAULT_TIERS.flat().map((n) => [n, nameKeyOf(n)]));
  return defaultKeys.get(name) || nameKeyOf(name);
};

// `store` is server/store.js. `chosenState(key)` answers for the chosen
// callsigns ('free', 'taken' or 'unknown': server/name-index.js). `checkName`
// is display-name.js's checkPlayerName, the guidelines every name meets. The
// clock, the secret and the random pick are injected so a suite can drive them.
export function createReservations({
  store, chosenState = () => 'unknown', checkName,
  now = Date.now, mint = newSecret, pick = (n) => randomInt(n),
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); if (typeof t.unref === 'function') t.unref(); return () => clearTimeout(t); },
  refreshMs, retryMs, onError = () => {},
} = {}) {
  if (!store || typeof checkName !== 'function') throw new TypeError('createReservations needs a store and checkName');
  const index = createNameIndex({
    load: (after, limit) => store.reservationKeys(after, limit),
    readings: (k) => [k],
    ...(refreshMs !== undefined ? { refreshMs } : {}), ...(retryMs !== undefined ? { retryMs } : {}),
    onError,
  });
  const ask = (k) => { try { return chosenState(k); } catch { return 'unknown'; } };

  let mintTokens = MINT_BURST, mintAt = now();
  function mintOk() {
    const t = now();
    mintTokens = Math.min(MINT_BURST, mintTokens + (Math.max(0, t - mintAt) / 60000) * MINT_PER_MIN);
    mintAt = t;
    if (mintTokens < 1) return false;
    mintTokens -= 1;
    return true;
  }

  // MAY A NEW ROW HOLD THIS NAME? The guidelines first, then neither
  // namespace may hold it or a look-alike of it. A chosen callsign index that
  // cannot answer refuses 'unavailable', as the door does: a reservation made
  // blind could be another player's chosen callsign.
  function vet(raw) {
    const v = checkName(raw);
    if (!v || !v.ok) return { ok: false, error: (v && v.error) || 'chars' };
    const key = nameKeyOf(v.name);
    if (!key || [...key].length > RES_KEY_MAX) return { ok: false, error: 'chars' };
    const chosen = combineStates(ask(v.key), ask(key));
    if (chosen === 'taken') return { ok: false, error: 'taken' };
    if (chosen !== 'free') return { ok: false, error: 'unavailable' };
    if (index.state(key) !== 'free') return { ok: false, error: 'taken' };
    return { ok: true, name: v.name, key };
  }

  // A NEW UNUSED DEFAULT (owner: "New default names are always picked from
  // unused ones"). Each tier is walked once, from a random place, so every
  // name in it is reached and two moved players do not start from the same
  // one. The pairs are used up before any numbered name is offered. A name
  // that has just lost on the table was added to the memory, so it is not
  // offered again. null when nothing is free or the chosen callsigns cannot
  // be asked.
  function pickDefault() {
    for (const tier of DEFAULT_TIERS) {
      const n = tier.length;
      const at = pick(n);
      for (let i = 0; i < n; i++) {
        const c = tier[(at + i) % n];
        if (index.state(defaultKey(c)) !== 'free') continue;
        const v = vet(c);
        if (v.ok) return v;
        if (v.error === 'unavailable') return null;
      }
    }
    return null;
  }

  const answer = (row, extra = {}) => ({ ok: true, name: row.name, row: { id: row.id, name: row.name, name_key: row.name_key }, ...extra });

  async function touch(row, linked) {
    const seen = Date.parse(row.last_seen_at || '');
    if (Number.isFinite(seen) && now() - seen < TOUCH_MS && row.linked === linked) return;
    try { await store.touchReservation(row.id, linked, now()); } catch { /* the next connect writes it */ }
  }

  // THE CLAIM. `userId` is the socket's account (anonymous or linked) or
  // null; `linked` whether it is a linked one; `chosen` its chosen callsign
  // (server.js's ws.chosenName) or null; `secret` what the device holds;
  // `name` the name the device has; `fresh` that the device rolled that name
  // a moment ago and has never been answered, so a swap is no news to tell.
  async function claim({ userId = null, linked = false, chosen = null, secret = null, name = '', fresh = false } = {}) {
    if (!index.ready) return { ok: false, error: 'unavailable' };
    linked = !!(userId && linked);
    if (linked && typeof chosen === 'string' && chosen) {
      await release(userId).catch(() => {});
      return { ok: true, name: chosen, chosen: true, row: null };
    }
    // A SECRET NO ROW HOLDS IS NO SECRET: one this server never issued, or
    // whose row was swept or deleted. It is treated as none, and a new one is
    // issued where a row can carry it.
    let sh = typeof secret === 'string' && SECRET_RE.test(secret) ? hashSecret(secret) : null;
    const dev = sh ? await store.reservationBySecret(sh) : null;
    if (!dev) sh = null;
    let row = null;
    if (userId) {
      row = await store.reservationByUser(userId);
      if (!row && dev && !dev.user_id) row = (await store.moveReservation(dev.id, userId, linked, now())) || (await store.reservationByUser(userId));
    } else row = dev;
    if (row) {
      await touch(row, userId ? linked : row.linked === true);
      index.add(row.name_key);
      // An ACCOUNT's row with no device on it yet (reserved before this
      // device held a secret): this device becomes it, so a sign-out later
      // keeps the name here too. Only when the device holds no secret of
      // its own, so a device is never taken from the row it already has.
      if (!sh && !row.secret_hash) {
        const fresh2 = mint();
        let on = null;
        try { on = await store.attachSecret(row.id, hashSecret(fresh2)); } catch { on = null; }
        if (on) return answer(row, { secret: fresh2 });
      }
      return answer(row);
    }
    // NO ROW: A NEW ONE, for the name the device has when it may have it.
    const presented = normaliseCallsign(name);
    let v = presented ? vet(presented) : { ok: false, error: 'length' };
    if (!v.ok && v.error === 'unavailable') return { ok: false, error: 'unavailable' };
    let why = v.ok ? null : v.error === 'taken' ? 'taken' : 'refused';
    if (!mintOk()) return { ok: false, error: 'slow_down' };
    // A guest's row needs a holder, so a guest always gets a secret here (a
    // device secret that some row holds would have found that row above). An
    // account's row gets one when the device has none, for the same reason as
    // the attach above.
    const minted = sh ? null : mint();
    const secretHash = minted ? hashSecret(minted) : null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const choice = v.ok ? v : pickDefault();
      if (!choice) return { ok: false, error: 'unavailable' };
      const res = await store.insertReservation({ name: choice.name, key: choice.key, secretHash, userId, linked });
      if (res && res.ok) {
        index.add(choice.key);
        const extra = {};
        if (minted) extra.secret = minted;
        if (why && !fresh) extra.moved = why;
        return answer(res.row, extra);
      }
      // REFUSED BY A UNIQUE CONSTRAINT. Either another socket of this same
      // account made its row a moment ago, which is this player's name, or
      // another player holds the name (another instance's write, or a race
      // this process lost): then it is taken here too, and a default is next.
      if (userId) {
        const mine = await store.reservationByUser(userId);
        if (mine) { index.add(mine.name_key); return answer(mine); }
      }
      index.add(choice.key);
      // The name the device had lost on the table: it is taken, and the
      // player is told so with the default that stands in for it.
      if (v.ok) why = 'taken';
      v = { ok: false, error: 'taken' };
    }
    return { ok: false, error: 'unavailable' };
  }

  // A HOLDER CHANGES THEIR NAME (the guest's check op). `row` is the one the
  // socket's claim answered. The holder's own name in other capitals is their
  // own; anything else must be free, and the write is the authority.
  async function rename(row, raw) {
    if (!index.ready || !row) return { ok: false, error: 'unavailable' };
    const v0 = checkName(raw);
    if (!v0 || !v0.ok) return { ok: false, error: (v0 && v0.error) || 'chars' };
    const own = nameKeyOf(v0.name) === row.name_key;
    const v = own ? { ok: true, name: v0.name, key: row.name_key } : vet(v0.name);
    if (!v.ok) return v;
    const res = await store.renameReservation(row.id, v.name, v.key, now());
    if (!res || !res.ok) {
      if (res && res.error === 'taken') { index.add(v.key); return { ok: false, error: 'taken' }; }
      return { ok: false, error: res && res.error === 'gone' ? 'gone' : 'unavailable' };
    }
    if (!own) { index.remove(row.name_key); index.add(v.key); }
    return answer(res.row);
  }

  // The account's reservation goes: it has a chosen callsign now.
  async function release(userId) {
    if (!index.ready || !userId) return;
    for (const k of await store.deleteReservationOfUser(userId)) index.remove(k);
  }

  // Does a player other than this account hold any of these keys? Read from
  // the table itself, because this answers the Set, which writes next.
  async function takenFor(keys, userId) {
    if (!index.ready) return false;
    const rows = await store.reservationsByKeys(keys);
    return rows.some((r) => r.user_id !== userId);
  }

  async function sweep() {
    if (!index.ready) return 0;
    const keys = await store.sweepReservations(now() - RESERVE_TTL_MS);
    for (const k of keys) index.remove(k);
    return keys.length;
  }

  // THE DOOR'S TWO QUESTIONS, both synchronous and both answered from memory
  // (the engine's door may not wait). state: is this key a reservation?
  // free: may a socket that does not hold it show this name? A chosen
  // callsign index that cannot answer is no reason to refuse a rolled pair
  // here, which the door has always shown: only a known holder refuses.
  const state = (key) => (index.ready ? index.state(String(key)) : 'free');
  function free(name) {
    if (!index.ready) return true;
    const n = normaliseCallsign(name);
    const key = nameKeyOf(n);
    if (index.state(key) !== 'free') return false;
    return ask(n.toLowerCase()) !== 'taken' && ask(key) !== 'taken';
  }

  let stopSweep = null, stopped = true;
  function armSweep(ms) {
    if (stopped) return;
    stopSweep = schedule(() => { sweep().catch((e) => onError(e)).finally(() => armSweep(SWEEP_MS)); }, ms);
  }

  return {
    claim, rename, release, takenFor, sweep, state, free, pickDefault, vet,
    // The defaults' keys are worked out at boot, not on the first player who
    // needs a new name.
    start() { if (!stopped) return; stopped = false; defaultKey(''); index.start(); armSweep(SWEEP_FIRST_MS); },
    stop() { stopped = true; index.stop(); if (stopSweep) stopSweep(); stopSweep = null; },
    refresh: () => index.refresh(),
    get ready() { return index.ready; },
    get size() { return index.size; },
  };
}

// WHAT A HOST WITHOUT THE TABLE HOLDS: every answer the old one. createSocial
// defaults to it, and server.js uses it when there is no Supabase at all.
export const RESERVATIONS_OFF = Object.freeze({
  ready: false,
  claim: async () => ({ ok: false, error: 'unavailable' }),
  rename: async () => ({ ok: false, error: 'unavailable' }),
  release: async () => {},
  takenFor: async () => false,
  sweep: async () => 0,
  state: () => 'free',
  free: () => true,
});
