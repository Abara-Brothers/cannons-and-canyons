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
// ONE ROW PER HOLDER (the table is name_reservations; its migration says what
// each column is for). A row holds the name as shown, its key, and exactly one
// HOLDER:
//   * a DEVICE, by a random secret this server issues and the device keeps
//     (cc_name_secret in its storage). The table holds only the secret's
//     SHA-256, so a copy of the table names no device and lets nobody claim a
//     name. The secret carries 256 random bits, so the hash needs no salt.
//   * or an ACCOUNT (anonymous or linked), by its user id, and then no device
//     secret at all (round 3 fix, 2026-10-10, below).
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
// A DEVICE'S SECRET NEVER CONFERS AN ACCOUNT'S NAME (round 3 fix, 2026-10-10).
// The move used to leave the device's secret on the row, so the row answered
// both the account and the bare secret. A signed-out device, or the next
// person on a shared one, was then seated under the account's name beside the
// account itself, and could rename the account's row with the guest check op.
// So the move writes the secret OFF the row in the same write that writes the
// account on (store.moveReservation), the table refuses a row with both
// holders (the migration's check), a secret is only ever believed for a row
// with no account, and an account's row never takes a device secret. The
// device keeps its own identity: its next claim with no account (a sign-out,
// or another person on it) is a new row of its own, for the device's own name
// when nobody holds it, or else a new unused default. The player who moved
// still has exactly one name: the account's, on every device.
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
// ONE NAME IGNORING CAPITALS, IN EVERY SCRIPT (round 3 fix, 2026-10-10). A
// reservation's key is the name in lower case, the very normalisation of a
// chosen callsign's key (checkPlayerName's key, profiles.callsign_key), and
// two names are one when ANY of their keys' readings meet (server/callsign.js
// keyReadings: the key, the key in capitals and the key capitalised word by
// word, each with look-alike letters read as the Latin ones they imitate).
// The key used to be the look-alike skeleton of the one spelling presented,
// and a Greek capital reads as a different letter from its lower case (capital
// nu reads N, small nu v), so 'Αννα' and 'ΑΝΝΑ' had two skeletons and were
// reserved by two players. The index keeps every reading (keyReadings, the
// chosen callsigns' rule), and the name stored is the one every reader shows
// (shownSpelling), so what a reservation looks like on screen is always one
// of the readings checked. The table's UNIQUE key refuses the same name in
// other capitals at the write; a look-alike in another script is refused by
// the readings in memory before the write, the read-before-write the chosen
// callsigns have always accepted, and this process marks a name taken in
// memory before its insert goes out, so two claims in this process cannot
// both pass that read.
//
// THE TWO NAMESPACES NEVER OVERLAP. A reservation is never made for a name an
// account holds as its chosen callsign, nor a look-alike of one (chosenState,
// the in-memory index server/name-index.js keeps), and the Set refuses a
// chosen callsign another player has reserved (takenFor). The race between
// the two is a read before a write, as the look-alike check in the Set
// already is: closing it would need both names in one table.
//
// THE FEATURE IS OFF UNTIL THE TABLE ANSWERS. The migration is applied by
// hand, so a deploy may run before it. Until the index's first read of the
// table lands, `ready` is false and every question is answered the old way:
// state() says 'free', free() says yes, a claim answers 'unavailable' (the
// client keeps the name it has, and asks again) and takenFor() says no. A
// missing table is a 404, the read fails, and the index retries every
// RETRY_MS, so applying the migration turns the feature on within half a
// minute with no restart. /health says which (server.js: supabaseNames and
// nameReservations).
//
// AND IT FORGETS A GUEST WHO HAS GONE. A row whose holder never linked an
// account and has not connected for RESERVE_TTL_MS (90 days) is deleted by
// the sweep below, once a day, and its name is free again. A linked account's
// row lasts as long as the account; deleting the account deletes the row
// (the foreign key cascades).
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { keyReadings, normaliseCallsign, shownSpelling } from './callsign.js';
import { createNameIndex, PAGE } from './name-index.js';
import { RES_KEY_MAX } from './store.js';
import { defaultPairs, defaultNameAt, defaultNameCount } from '../public/game-core.js';

const DAY = 86400000;
const HOUR = 3600000;
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

// ---- THE BOUNDS ON NEW ROWS (round 3 fix, 2026-10-10) -----------------------
// A claim is open to any socket, and each one that finds no row writes one,
// so without bounds a flood of sockets each sending a new name grows the table
// and this process's memory of it without end, and spends whatever stands
// between real newcomers and their names.
//
// AND FAIRLY, NOT ONLY BOUNDED (round 3 fix, 2026-10-10). The bounds below
// used to be the only ones, and the hourly window is one for the whole
// process: one script with no hello and no secret filled it, and every real
// newcomer for as long as it ran was answered 'unavailable', their name
// reserved by nobody. So a new row now passes four layers, in this order:
//   1. A HELLO. Only a socket that has said hello may make one (social.js
//      passes `helloed`): a bare claim frame, the cheapest flood there is,
//      makes nothing. A guest's hello carries no token (it has no account,
//      and depends on none), so this orders the protocol rather than proving
//      anything; the layers after it are the bounds.
//   2. PER SOCKET: ROWS_PER_SOCKET, below.
//   3. PER CLIENT ADDRESS: ADDR_ROWS_PER_HOUR, below, keyed by the address
//      the host's edge reports for the connection (server/client-address.js).
//      Every attempt that gets this far spends from it, the attempts the
//      layers after it refuse included, so a script holding sockets open
//      cannot retry its way into the rows others are waiting for.
//   4. PER PROCESS: the ceiling and the hourly window, below, now the bounds
//      on the table and on memory, sized so that only a flood from a hundred
//      addresses at once can reach the window.
// A newcomer who still gets no row is still never shown under another
// player's name: the door gives them a name nobody holds and no live player
// is using (room-engine.js nameAtDoor), and the client asks again.
//
// PER SOCKET: ROWS_PER_SOCKET new rows a connection may make. An honest
// connection makes one when its device first claims, and one more each time a
// sign-out leaves the device without a row of its own (its row went with the
// account it signed in to); three covers a player who signs in and out twice
// on one connection. Past it the claim answers 'slow_down', and the device
// keeps its name by the old rules until it reconnects. A flood must then open a
// new connection for every three rows, and the bounds below hold whatever it
// opens.
export const ROWS_PER_SOCKET = 3;
// PER CLIENT ADDRESS: at most ADDR_ROWS_PER_HOUR attempts at a new row an hour
// from one address, a bucket that holds that many and refills one every two
// minutes. Why 30. A new row is made by a device's FIRST claim (once a
// device, until it is unseen for 90 days) and by a sign-out, so the honest
// rows from one address in an hour are the new players of this game behind
// it in that hour. A mobile carrier puts many phones behind one address (and
// an IPv6 carrier many behind one /48, which is how those are keyed), and 30
// newcomers an hour behind a single one is far past anything this game has
// seen. If it is ever exceeded, the 31st newcomer still plays under a name
// nobody else is shown under (the door), and their client asks again, backing
// off to a minute, so the row comes within minutes as the bucket refills. A
// claim refused by it answers 'unavailable', as the window below does.
export const ADDR_ROWS_PER_HOUR = 30;
// At most ADDR_MAX addresses are remembered, the one used longest ago dropped
// first (its next attempt starts from a full bucket again; pushing it out
// takes ten thousand other addresses in under an hour, and a flood that has
// those has their budgets anyway), and an address is forgotten an hour after
// its last attempt, when its bucket is full again and remembering it changes
// nothing. The sweep that forgets runs every ADDR_SWEEP_MS, and every attempt
// forgets the ones an hour old first. An entry is a short keyed hash and two
// numbers, never the address (server/client-address.js): ten thousand of them
// measured 1.6 MB on this Node.
export const ADDR_MAX = 10000;
export const ADDR_SWEEP_MS = 5 * 60000;
// PER HOUR, PER PROCESS: at most ROWS_PER_HOUR new rows in any 60 minutes, a
// sliding window, not a bucket that refills in bursts. RAISED TO MATCH THE
// ADDRESS BUDGET (round 3 fix, 2026-10-10): it was 600, which twenty
// addresses' budgets fill; 3,000 an hour is a hundred addresses' worth, fifty
// a minute, far past this game's newcomers on its busiest day so far. At that
// rate the ceiling below is reached after about 33 hours of a flood that never
// stops, and the prune then frees its rows a thousand a minute, twenty times
// faster than the window lets them in. Its writes are under one a second,
// nothing to the database. A claim refused by it answers 'unavailable': the
// player is still seated under a name nobody else is shown under (the door),
// and the client asks again, backing off, until a row is made.
export const ROWS_PER_HOUR = 3000;
// THE TABLE'S CEILING: no new row once ROWS_MAX are held. Measured on this
// Node (v26), the index below costs about 210 bytes a reservation with every
// reading kept, so 100,000 rows are about 20 MB, and twice that for the
// moment a refresh holds the old set and the new one: a bounded share of the
// 512 MB the host's starter plan has. At the ceiling the claim answers
// 'unavailable' and starts the prune below, which frees the rows nobody ever
// came back to, oldest first, before any other.
export const ROWS_MAX = 100000;
// THE INDEX'S OWN LIMIT: it reads at most this many pages of PAGE keys, so
// it never holds more than half as much again as the ceiling (room for the
// rows another instance may write in a deploy's overlap); the one page more
// is the empty one that ends a read. A table past it fails the read, the
// index keeps what it had, and the prune is started, so a server that boots
// onto an overgrown table frees the never-used rows and turns the feature on
// by itself.
export const INDEX_MAX_PAGES = Math.ceil((ROWS_MAX * 1.5) / PAGE) + 1;
// THE PRUNE (store.pruneReservations): at most PRUNE_BATCH rows a run, at most
// one run a PRUNE_GAP_MS, and only rows that have never been reused (no claim
// found them on a later day), are held by nobody linked, and are older than
// PRUNE_MIN_AGE_MS, so a newcomer playing right now is never pruned. A flood's
// rows are exactly these. A thousand a minute outruns the fifty a minute the
// window above lets in.
export const PRUNE_BATCH = 1000;
export const PRUNE_GAP_MS = 60000;
export const PRUNE_MIN_AGE_MS = DAY;
// A row is REUSED once a claim finds it a day or more after it was made: its
// holder came back.
export const REUSE_MS = DAY;
// THE HOLDERS THIS PROCESS HAS SEEN (vouch, below): at most HOLDERS_MAX, the
// most recent kept. A few thousand players connect to one process in a day;
// ten thousand entries are about 2 MB.
export const HOLDERS_MAX = 10000;
// How many random draws the widest default tier gets before a pick gives up.
// At the ceiling at most one default in ten is held (DEFAULT_TIERS, below), so
// 64 draws all landing on held names is a chance below 10^-64.
export const DEFAULT_DRAWS = 64;

// A NAME'S KEY: the name in lower case after the guidelines' normalisation,
// exactly checkPlayerName's key (validateCallsign) and so exactly the key a
// chosen callsign has in profiles.callsign_key.
export const nameKeyOf = (name) => normaliseCallsign(name).toLowerCase();
// EVERY WAY A NAME READS: its key and the key's readings (keyReadings), the
// strings two names share exactly when they are one name ignoring capitals and
// look-alike letters. The room engine is handed this (server.js
// setNameReadings), so the names it keeps apart in a room, a squad and the
// stand-ins it draws are kept apart by the rule the reservations use.
export function nameReadings(name) {
  const k = nameKeyOf(name);
  return k ? [...new Set([k, ...keyReadings(k)])] : [];
}
export const hashSecret = (s) => createHash('sha256').update(String(s)).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');

// THE ONE RULE FOR TWO ANSWERS: a name is taken when either namespace says
// so, and not known when either cannot say.
export function combineStates(a, b) {
  if (a === 'taken' || b === 'taken') return 'taken';
  if (a === 'free' && b === 'free') return 'free';
  return 'unknown';
}

// EVERY DEFAULT NAME, in three tiers. The rolled pairs come first: every
// "<Adj> <Noun>" within NAME_MAX, exactly as the client rolls them (app.js
// rollCallsign) and the engine's fallback seeds them. There are 1,454 of them,
// and with every name unique they run out at 1,454 players. So behind them
// stands the same list with a digit from 2 to 9 ('Iron Ridge 2'), 11,632 more,
// which a 14-character pair always leaves room for inside the 16 a name may
// have. Those two tiers are walked in full (pickDefault).
//
// AND A THIRD THAT NO FLOOD CAN USE UP (round 3 fix, 2026-10-10). 13,086 names
// could all be held by a flood of claims well inside the ceiling, and every
// newcomer after it would then have no unused default to be given. So behind
// them stands every pair with a number from 10 to 99 that fits in 16
// characters (121,050 names) and from 100 to 999 (954,000 more): 1,075,050,
// more than ten times ROWS_MAX, so however the table fills, nine in ten of
// them are unused. They are drawn at random (WIDE_DEFAULTS.at), not walked,
// and never listed in memory: a name is worked out from its number.
//
// ONE LIST, THE ENGINE'S TOO (round 3 fix, 2026-10-10). The pool is
// public/game-core.js's (defaultNameAt), the one the room engine's door draws
// its stand-ins from, so a stand-in and a default are the same kind of name
// and neither can be a name the other side does not know. These are its first
// two tiers and its wide tier, read from it in its order.
export const DEFAULT_TIERS = (() => {
  const pairs = [...defaultPairs()];
  const numbered = [];
  for (let i = pairs.length; i < pairs.length * 9; i++) numbered.push(defaultNameAt(i));
  return [pairs, numbered];
})();
export const WIDE_DEFAULTS = (() => {
  const base = DEFAULT_TIERS[0].length + DEFAULT_TIERS[1].length;
  return Object.freeze({
    size: defaultNameCount() - base,
    at(i) { return defaultNameAt(base + i); },
  });
})();

// `store` is server/store.js. `chosenState(key)` answers for the chosen
// callsigns ('free', 'taken' or 'unknown': server/name-index.js). `checkName`
// is display-name.js's checkPlayerName, the guidelines every name meets.
// `liveNames()` is the room engine's liveNameReadings (server.js): every
// reading of every name a live player is shown under right now, in a room or a
// squad, or null when it cannot say. The clock, the secret and the random
// pick are injected so a suite can drive them.
export function createReservations({
  store, chosenState = () => 'unknown', checkName, liveNames = () => null,
  now = Date.now, mint = newSecret, pick = (n) => randomInt(n),
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); if (typeof t.unref === 'function') t.unref(); return () => clearTimeout(t); },
  refreshMs, retryMs, onError = () => {},
} = {}) {
  if (!store || typeof checkName !== 'function') throw new TypeError('createReservations needs a store and checkName');
  // EVERY READING OF EVERY KEY, as the chosen callsigns' index keeps them
  // (keyReadings is name-index.js's default), and at most INDEX_MAX_PAGES of
  // them. A read refused for being past that limit starts the prune.
  const index = createNameIndex({
    load: (after, limit) => store.reservationKeys(after, limit),
    maxPages: INDEX_MAX_PAGES,
    ...(refreshMs !== undefined ? { refreshMs } : {}), ...(retryMs !== undefined ? { retryMs } : {}),
    onError: (e) => { if (e && e.code === 'NAME_INDEX_FULL') prune().catch(() => {}); onError(e); },
  });
  const ask = (k) => { try { return chosenState(k); } catch { return 'unknown'; } };
  // A KEY AND EVERY WAY IT READS: the questions both namespaces are asked.
  const readingsOf = (key) => [...new Set([key, ...keyReadings(key)])];
  const heldHere = (key) => readingsOf(key).some((r) => index.state(r) !== 'free');
  const chosenOf = (key) => readingsOf(key).reduce((s, r) => combineStates(s, ask(r)), 'free');

  // THE HOURLY WINDOW: the times of the last ROWS_PER_HOUR new rows, oldest
  // at `slot`. A new row may be made when the oldest of them is an hour old.
  // A clock that jumps backwards makes a stamp from the future, which is not
  // counted, so a clock fault can never shut new rows out for longer than it.
  const stamps = new Array(ROWS_PER_HOUR).fill(-Infinity);
  let slot = 0;
  function hourOk() {
    const t = now(), age = t - stamps[slot];
    if (age >= 0 && age < HOUR) return false;
    stamps[slot] = t;
    slot = (slot + 1) % ROWS_PER_HOUR;
    return true;
  }

  // THE ADDRESS BUDGETS (ADDR_ROWS_PER_HOUR): an address key to its bucket,
  // `tokens` as of `at`. The Map's order is the order the addresses were last
  // used (an entry is taken out and put back on every use), so the one used
  // longest ago is first, for the bound and for forgetting. An address with
  // no key (a connection whose address the host could not tell) has no
  // budget: the per-process bounds still hold it. A clock that jumps
  // backwards refills nothing until it has caught up, and empties nothing.
  const budgets = new Map();
  function forgetAddresses(t) {
    for (const [k, b] of budgets) { if (t - b.at < HOUR) break; budgets.delete(k); }
  }
  function addrOk(addr) {
    if (typeof addr !== 'string' || !addr) return true;
    const t = now();
    forgetAddresses(t);
    const b = budgets.get(addr);
    budgets.delete(addr);
    const tokens = b ? Math.min(ADDR_ROWS_PER_HOUR, b.tokens + (Math.max(0, t - b.at) * ADDR_ROWS_PER_HOUR) / HOUR) : ADDR_ROWS_PER_HOUR;
    const ok = tokens >= 1;
    budgets.set(addr, { tokens: ok ? tokens - 1 : tokens, at: t });
    while (budgets.size > ADDR_MAX) budgets.delete(budgets.keys().next().value);
    return ok;
  }
  // The timer's sweep reads every entry, so an address the order above has
  // put behind a newer one (a clock that jumped) is forgotten too.
  function sweepAddresses() {
    const t = now();
    for (const [k, b] of budgets) if (t - b.at >= HOUR) budgets.delete(k);
  }

  // THE HOLDERS THIS PROCESS HAS SEEN, for the moment a claim cannot be
  // answered (vouch, below). byKey: a reservation's key to its holder's tag
  // and its name, as this process last read or wrote it; byTag: the tag back
  // to that key. Every write this process makes keeps them exact; the oldest
  // is dropped past HOLDERS_MAX. A tag is 'u:' and an account id, or 's:' and
  // a device secret's hash.
  const byKey = new Map();
  const byTag = new Map();
  // An account id is compared case-blind, the way the social layer reads ids.
  const userTag = (id) => `u:${String(id).trim().toLowerCase()}`;
  const tagOfRow = (row) => (row && row.user_id ? userTag(row.user_id) : row && row.secret_hash ? `s:${row.secret_hash}` : null);
  function forget(key) {
    const e = byKey.get(key);
    if (!e) return;
    byKey.delete(key);
    if (byTag.get(e.tag) === key) byTag.delete(e.tag);
  }
  function remember(row) {
    const tag = tagOfRow(row);
    if (!tag || typeof row.name_key !== 'string') return;
    const old = byTag.get(tag);
    if (old !== undefined && old !== row.name_key) forget(old);
    forget(row.name_key);
    byKey.set(row.name_key, { tag, name: row.name });
    byTag.set(tag, row.name_key);
    if (byKey.size > HOLDERS_MAX) forget(byKey.keys().next().value);
  }

  // MAY A NEW ROW HOLD THIS NAME? The guidelines first, then neither
  // namespace may hold it, any reading of it, or a name any reading of which
  // is one of its own. A chosen callsign index that cannot answer refuses
  // 'unavailable', as the door does: a reservation made blind could be another
  // player's chosen callsign. The name answered is the spelling every reader
  // shows (shownSpelling): a spelling whose capitals read as none of the key's
  // readings is stored as the key itself.
  function vet(raw) {
    const v = checkName(raw);
    if (!v || !v.ok) return { ok: false, error: (v && v.error) || 'chars' };
    const key = v.key;
    if (typeof key !== 'string' || !key || [...key].length > RES_KEY_MAX) return { ok: false, error: 'chars' };
    const chosen = chosenOf(key);
    if (chosen === 'taken') return { ok: false, error: 'taken' };
    if (chosen !== 'free') return { ok: false, error: 'unavailable' };
    if (heldHere(key)) return { ok: false, error: 'taken' };
    return { ok: true, name: shownSpelling(v.name, key) || key, key };
  }

  // A NEW UNUSED DEFAULT (owner: "New default names are always picked from
  // unused ones"). The first two tiers are each walked once, from a random
  // place, so every name in them is reached and two moved players do not
  // start from the same one; the pairs are used up before any numbered name
  // is offered. A held name is skipped by a lookup of its key (a default is
  // plain ASCII, so its key is its only reading), and only a free one meets
  // the full guidelines. Then the wide tier, drawn at random. A name that has
  // just lost on the table was added to the memory, so it is not offered
  // again. null when nothing is free or the chosen callsigns cannot be asked.
  //
  // NOR ONE A LIVE PLAYER IS SHOWN UNDER (round 3 fix, 2026-10-10). A player
  // whose claim was never answered plays under a name nobody reserved, and a
  // stand-in the door gave a seat is reserved by nobody either; a default
  // handed out by name alone could be either, and two players would then be
  // shown one name. So the names live in rooms and squads right now are asked
  // too, read once for the pick. When they cannot be read the pick goes on
  // without them: the door still keeps two players in one room apart.
  function pickDefault() {
    let busy = null;
    try { busy = liveNames(); } catch { busy = null; }
    const live = (c) => !!(busy && typeof busy.has === 'function') && readingsOf(c.toLowerCase()).some((r) => busy.has(r));
    for (const tier of DEFAULT_TIERS) {
      const n = tier.length;
      const at = pick(n);
      for (let i = 0; i < n; i++) {
        const c = tier[(at + i) % n];
        if (index.state(c.toLowerCase()) !== 'free' || live(c)) continue;
        const v = vet(c);
        if (v.ok) return v;
        if (v.error === 'unavailable') return null;
      }
    }
    for (let d = 0; d < DEFAULT_DRAWS; d++) {
      const c = WIDE_DEFAULTS.at(pick(WIDE_DEFAULTS.size));
      if (index.state(c.toLowerCase()) !== 'free' || live(c)) continue;
      const v = vet(c);
      if (v.ok) return v;
      if (v.error === 'unavailable') return null;
    }
    return null;
  }

  // The row a socket keeps (ws.nameRow) carries its holder, so a rename can
  // be made only by that holder (store.renameReservation). It never leaves
  // the server: the frame carries the name alone.
  const rowOf = (row) => ({ id: row.id, name: row.name, name_key: row.name_key, user_id: row.user_id || null, secret_hash: row.secret_hash || null });
  const answer = (row, extra = {}) => ({ ok: true, name: row.name, row: rowOf(row), ...extra });

  // last_seen_at at most once a day, and `reused` the first time a claim
  // finds the row a day or more after it was made (the prune spares it then).
  async function touch(row, linked) {
    const t = now();
    const seen = Date.parse(row.last_seen_at || '');
    const made = Date.parse(row.created_at || '');
    const reuse = row.reused !== true && Number.isFinite(made) && t - made >= REUSE_MS;
    if (Number.isFinite(seen) && t - seen < TOUCH_MS && row.linked === linked && !reuse) return;
    try { await store.touchReservation(row.id, linked, t, reuse || row.reused === true); } catch { /* the next connect writes it */ }
  }

  // THE CLAIM. `userId` is the socket's account (anonymous or linked) or
  // null; `linked` whether it is a linked one; `chosen` its chosen callsign
  // (server.js's ws.chosenName) or null; `secret` what the device holds;
  // `name` the name the device has; `fresh` that a swap is no news to the
  // player (the device rolled that name a moment ago, or has just signed out
  // and was told it starts again as a guest); `mayInsert` whether this socket
  // may still make a new row (ROWS_PER_SOCKET, counted by the social layer
  // from `made` on the answer); `helloed` whether the socket has said hello,
  // and `addr` its address key (server/client-address.js, or null), for the
  // first and third layers above. Every default here is the permissive one,
  // for a caller with no socket; the social layer passes all three.
  async function claim({ userId = null, linked = false, chosen = null, secret = null, name = '', fresh = false, mayInsert = true, helloed = true, addr = null } = {}) {
    if (!index.ready) return { ok: false, error: 'unavailable' };
    linked = !!(userId && linked);
    if (linked && typeof chosen === 'string' && chosen) {
      await release(userId).catch(() => {});
      return { ok: true, name: chosen, chosen: true, row: null };
    }
    // A SECRET NO DEVICE'S ROW HOLDS IS NO SECRET: one this server never
    // issued, one whose row was swept or deleted, or one whose row has moved
    // to an account (which no longer carries it). A row with an account on it
    // is never answered for a secret, whatever the table holds: that is the
    // account's name, and the secret is only the device's.
    const sh = typeof secret === 'string' && SECRET_RE.test(secret) ? hashSecret(secret) : null;
    let dev = sh ? await store.reservationBySecret(sh) : null;
    if (dev && dev.user_id) dev = null;
    let row = null;
    if (userId) {
      row = await store.reservationByUser(userId);
      if (!row && dev) row = (await store.moveReservation(dev.id, userId, linked, now())) || (await store.reservationByUser(userId));
    } else row = dev;
    if (row) {
      await touch(row, userId ? linked : false);
      index.add(row.name_key);
      remember(row);
      return answer(row);
    }
    // NO ROW: A NEW ONE, for the name the device has when it may have it.
    const presented = normaliseCallsign(name);
    let v = presented ? vet(presented) : { ok: false, error: 'length' };
    if (!v.ok && v.error === 'unavailable') return { ok: false, error: 'unavailable' };
    let why = v.ok ? null : v.error === 'taken' ? 'taken' : 'refused';
    // THE LAYERS, in the order the note on the bounds gives them. Nothing
    // has been written or spent for a claim the first two refuse; from the
    // address budget on, the attempt is spent whatever refuses it after.
    if (!helloed) return { ok: false, error: 'unavailable' };
    if (!mayInsert) return { ok: false, error: 'slow_down' };
    if (!addrOk(addr)) return { ok: false, error: 'unavailable' };
    if (index.size >= ROWS_MAX) { prune().catch(() => {}); return { ok: false, error: 'unavailable' }; }
    if (!hourOk()) return { ok: false, error: 'unavailable' };
    // A device's row needs a holder, so a device always gets a new secret
    // here (a secret some device's row holds would have found that row
    // above). An account's row is held by the account alone.
    const minted = userId ? null : mint();
    const secretHash = minted ? hashSecret(minted) : null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const choice = v.ok ? v : pickDefault();
      if (!choice) return { ok: false, error: 'unavailable' };
      // TAKEN IN MEMORY BEFORE THE WRITE GOES OUT, so a second claim in this
      // process that arrives while it is out cannot pass vet for the same name
      // or a look-alike of it. A write that throws gives the name back.
      index.add(choice.key);
      let res;
      try { res = await store.insertReservation({ name: choice.name, key: choice.key, secretHash, userId, linked }); }
      catch (e) { index.remove(choice.key); throw e; }
      if (res && res.ok) {
        remember(res.row);
        const extra = { made: true };
        if (minted) extra.secret = minted;
        if (why && !fresh) extra.moved = why;
        return answer(res.row, extra);
      }
      // REFUSED BY A UNIQUE CONSTRAINT. Either another socket of this same
      // account made its row a moment ago, which is this player's name, or
      // another player holds the name (another instance's write, or a race
      // this process lost): then it is taken here too (it stays in memory),
      // and a default is next.
      // The name marked taken before the write is given back then: the
      // refusal was this account's own row, not a holder of that name.
      if (userId) {
        const mine = await store.reservationByUser(userId);
        if (mine) {
          if (mine.name_key !== choice.key) index.remove(choice.key);
          index.add(mine.name_key); remember(mine); return answer(mine);
        }
      }
      // The name the device had lost on the table: it is taken, and the
      // player is told so with the default that stands in for it.
      if (v.ok) why = 'taken';
      v = { ok: false, error: 'taken' };
    }
    return { ok: false, error: 'unavailable' };
  }

  // A HOLDER CHANGES THEIR NAME (the guest's check op). `row` is the one the
  // socket's claim answered, holder and all, and the write matches that
  // holder too, so no socket can rename a row it does not hold. The holder's
  // own name in other capitals is their own; anything else must be free, and
  // the write is the authority.
  async function rename(row, raw) {
    if (!index.ready || !row) return { ok: false, error: 'unavailable' };
    const holder = row.user_id ? { userId: row.user_id } : row.secret_hash ? { secretHash: row.secret_hash } : null;
    if (!holder) return { ok: false, error: 'gone' };
    const v0 = checkName(raw);
    if (!v0 || !v0.ok) return { ok: false, error: (v0 && v0.error) || 'chars' };
    const own = v0.key === row.name_key;
    const v = own ? { ok: true, name: shownSpelling(v0.name, v0.key) || v0.key, key: v0.key } : vet(v0.name);
    if (!v.ok) return v;
    // A NEW NAME IS TAKEN IN MEMORY BEFORE THE WRITE GOES OUT, as a claim's
    // is, and given back unless the table says another holder has it.
    if (!own) index.add(v.key);
    let res;
    try { res = await store.renameReservation(row.id, v.name, v.key, now(), holder); }
    catch (e) { if (!own) index.remove(v.key); throw e; }
    if (!res || !res.ok) {
      if (res && res.error === 'taken') return { ok: false, error: 'taken' };
      if (!own) index.remove(v.key);
      return { ok: false, error: res && res.error === 'gone' ? 'gone' : 'unavailable' };
    }
    if (!own) { index.remove(row.name_key); forget(row.name_key); }
    remember(res.row);
    return answer(res.row);
  }

  // The account's reservation goes: it has a chosen callsign now.
  async function release(userId) {
    if (!index.ready || !userId) return;
    for (const k of await store.deleteReservationOfUser(userId)) { index.remove(k); forget(k); }
  }

  // Does a player other than this account hold this key, or a name that any
  // reading of it reads as? Read from the table itself, because this answers
  // the Set, which writes next: the key itself (which another instance may
  // have written a moment ago) and every reservation the memory knows reads
  // the same. A list of keys is taken too, each asked the same way.
  async function takenFor(keys, userId) {
    if (!index.ready) return false;
    const asked = new Set();
    for (const k of (Array.isArray(keys) ? keys : [keys]).map(String)) {
      if (!k) continue;
      asked.add(k);
      for (const r of readingsOf(k)) for (const x of index.lookalikes(r) || []) asked.add(x);
    }
    const rows = await store.reservationsByKeys([...asked]);
    return rows.some((r) => r.user_id !== userId);
  }

  async function sweep() {
    if (!index.ready) return 0;
    const keys = await store.sweepReservations(now() - RESERVE_TTL_MS);
    for (const k of keys) { index.remove(k); forget(k); }
    return keys.length;
  }

  // THE PRUNE, one run at a time and at most one a PRUNE_GAP_MS. It does not
  // need the index to have loaded: it is how an overgrown table is brought
  // back under the index's limit.
  let pruning = null, prunedAt = -Infinity;
  function prune() {
    if (pruning) return pruning;
    const t = now();
    if (t - prunedAt < PRUNE_GAP_MS && t >= prunedAt) return Promise.resolve(0);
    prunedAt = t;
    pruning = Promise.resolve()
      .then(() => store.pruneReservations(t - PRUNE_MIN_AGE_MS, PRUNE_BATCH))
      .then((keys) => { for (const k of keys) { index.remove(k); forget(k); } return keys.length; })
      .finally(() => { pruning = null; });
    return pruning;
  }

  // THE DOOR'S TWO QUESTIONS, both synchronous and both answered from memory
  // (the engine's door may not wait). state: is this key, or a reading of a
  // reserved key, a reservation? free: may a socket that does not hold it
  // show this name? A chosen callsign index that cannot answer is no reason
  // to refuse a rolled pair here, which the door has always shown: only a
  // known holder refuses.
  const state = (key) => (index.ready ? index.state(String(key)) : 'free');
  function free(name) {
    if (!index.ready) return true;
    const key = nameKeyOf(name);
    if (heldHere(key)) return false;
    return chosenOf(key) !== 'taken';
  }

  // A CLAIM THAT COULD NOT BE ANSWERED (round 3 fix, 2026-10-10: the player
  // is seated under their own name until it is). The table did not answer, so
  // whose a name is cannot be read; but this process knows the holders it has
  // answered or written. A socket whose claim failed is vouched for the name
  // this process last knew its holder by (its account, or its device's
  // secret), while the memory still says that holder has it. Nobody else is
  // vouched for anything: a name this process has not seen its holder for, or
  // that has moved to another holder, stays refused at the door.
  function vouch({ userId = null, secret = null } = {}) {
    if (!index.ready) return null;
    const tag = userId ? userTag(userId) : typeof secret === 'string' && SECRET_RE.test(secret) ? `s:${hashSecret(secret)}` : null;
    if (!tag) return null;
    const key = byTag.get(tag);
    const e = key === undefined ? null : byKey.get(key);
    if (!e || e.tag !== tag || index.state(key) !== 'taken') return null;
    return e.name;
  }

  let stopSweep = null, stopForget = null, stopped = true;
  function armSweep(ms) {
    if (stopped) return;
    stopSweep = schedule(() => { sweep().catch((e) => onError(e)).finally(() => armSweep(SWEEP_MS)); }, ms);
  }
  function armForget() {
    if (stopped) return;
    stopForget = schedule(() => { try { sweepAddresses(); } finally { armForget(); } }, ADDR_SWEEP_MS);
  }

  return {
    claim, rename, release, takenFor, sweep, prune, state, free, vouch, pickDefault, vet, sweepAddresses,
    start() { if (!stopped) return; stopped = false; index.start(); armSweep(SWEEP_FIRST_MS); armForget(); },
    stop() { stopped = true; index.stop(); if (stopSweep) stopSweep(); if (stopForget) stopForget(); stopSweep = null; stopForget = null; },
    refresh: () => index.refresh(),
    get ready() { return index.ready; },
    get size() { return index.size; },
    get holders() { return byKey.size; },
    get addresses() { return budgets.size; },
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
  prune: async () => 0,
  state: () => 'free',
  free: () => true,
  vouch: () => null,
});
