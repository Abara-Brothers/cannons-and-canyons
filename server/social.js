// server/social.js — the social layer: chosen callsigns, and (Tasks 5 and 6)
// friends, blocks and reports. Server-only, and deliberately OUTSIDE public/:
// the static server serves files under public/ and nothing else (server.js
// containment check), and public/room-engine.js is imported by the OFFLINE
// page, which must never gain a database or a social protocol (ADR-001 /
// BQ-007). server.js intercepts these frames before the engine sees them.
//
// Everything this module touches is injected — the store, the blocklist terms,
// the engine's send(), and the clock — so the whole layer runs in process with
// no Supabase, no sockets and no real time (test/social.mjs).
import { validateCallsign, normaliseCallsign, keyReadings, shownSpelling, CALLSIGN_MIN, CALLSIGN_MAX } from './callsign.js';
// isUuid only — the pure shape test, not createStore. A friend op is handed an
// account id straight off a socket, and server/store.js THROWS 'bad uuid' on a
// malformed one; that throw would be answered 'unavailable', which is the wrong
// word for a request that was simply misaddressed. Checking the shape here turns
// it into 'no_such_user' and saves the round trip, using the same regex the
// store guards its own query strings with rather than a second copy of it.
// reportCallsign comes from the same module for the same reason: it is what a
// name_reports row ACTUALLY holds — the clamp to the column and the sentinel
// for a player with no name — and handleReport has to log the string the store
// stored, not the one it was handed.
import { isUuid, isRefusal, reportCallsign } from './store.js';
// THE NAME PROOFS. Written here, MOVED to server/display-name.js and imported
// back. They had two callers when they moved: this layer's panels and search
// results, and the route behind the Bay's recent-match panel, which was removed
// on 2026-09-30 with the panel itself. They stay in their own module anyway,
// because the rule is a security rule with its own suite against the shipped
// blocklist (BINDING.md resolution 27) — copying it into a second caller would
// leave two copies to drift, and drift here fails OPEN on the one string every
// other player has to look at. The reasoning for each proof — and the two
// reviews and three decisions behind them — travelled with them; this layer's
// behaviour is unchanged.
import { createNameProofs } from './display-name.js';
// THE NAME RESERVATIONS (round 3): every player's one name, held by the server.
// The default is the host with no table, which answers every question the old
// way, so a layer built without it behaves exactly as it did.
import { RESERVATIONS_OFF, ROWS_PER_SOCKET, combineStates, nameReadings } from './reservations.js';
import { isGeneratedCallsign, isProfane, standInWalk } from '../public/game-core.js';
// THE SQUAD STATE MACHINE. Built and held HERE rather than in server.js (plan
// R1): every squad op needs the per-socket queue, the rate buckets, `reply`,
// presence and the block reads, and all five are trapped inside
// createSocial's closure. Importing the factory rather than widening that
// closure is the same move createNameProofs above is.
import { createSquads } from './squads.js';
// THE ONLY NODE API IN THIS FILE, and it is a pure computation rather than I/O:
// the blocked list has to carry something a client can hand back to Unblock and
// nothing a client can keep. See blockKey below. randomBytes/createHmac are
// synchronous, need no wiring and are not mockable state, so the "everything is
// injected" rule this module is built on is untouched — there is still no
// Supabase, no socket and no real clock here. createCipheriv mints a squad
// row's handle (rowRid below), randomBytes a guest row's resume secret, and
// timingSafeEqual compares one: the same kind of pure computation.
import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The frame types that belong here and never reach the engine. server.js
// imports this set to decide what to intercept; keep it in step with the
// switch in handleOne() below.
//
// THREE CONSUMERS, AND THEY MOVE TOGETHER (plan R15): this file's own switch,
// server.js's socket 'message' handler, which imports the set to intercept,
// and public/app.js's routing block, which mirrors it so a reply reaches
// socialReply. This set is the ONLY server-side gate — server.js's handler is
// `if (SOCIAL_TYPES.has(msg.type)) { ... return; } handleClientMessage(ws, msg);`
// — so a type left out of it is handed to the room engine, whose switch has
// no arm for it and answers nothing at all. That failure is silent on the
// wire and surfaces twelve seconds later as the client's own timeout.
//
// ONE MEMBER HAS NO ARM IN handleOne(): `code`. It is in the set so that
// server.js intercepts it and app.js routes its answer, but server.js answers
// it itself, ahead of the hello wait and this layer's per-socket queue,
// because the answer is two lookups in memory and a frame queued behind a slow
// store read outlived the client's waiter. This layer never sees one.
//
// `name` (round 3, 2026-10-10) is the claim a client sends after every hello:
// the name this player has, and the device's secret, for the server to reserve
// or to answer with the name it already holds for them (claimName below).
export const SOCIAL_TYPES = new Set(['friends', 'friend', 'block', 'callsign', 'report', 'squad', 'code', 'name']);

// Per-socket rate limits, messages per minute (design 4.2). These sit ON TOP of
// the engine's 60 frames/s socket limiter: that one stops a flood of anything,
// these stop one signed-in client turning a single socket into a write
// amplifier against PostgREST. friend and report are wired by Tasks 5 and 6.
// `friends` — the READ MODEL — is not in design 4.2's table, and it is the
// heaviest path in this layer. THE COST, COUNTED IN ROUND TRIPS AND NOT IN
// METHOD CALLS, because the first version of this note said "six reads" and six
// is the number of store METHODS: friendIdsOf 1, requestsOf 2, blockIdsOf 2,
// ensureFriendCode 1, profileById 1, profilesByIds 1 — EIGHT PostgREST round
// trips per frame, nine when requestsOf's hourly sweep runs, ten the first time
// an account is given a friend code. Behind an engine socket limiter that allows
// 60 frames a second, unlimited, that is ~480 round trips a second from one
// signed-in client without a single write. Twenty a minute is far above any
// honest client — a panel opens, it does not poll — and caps this at 160 round
// trips a minute per socket. 'slow_down' already has copy (BINDING 16).
//
// WHAT THIS BUCKET DOES NOT PROTECT, stated plainly so nothing is sized against
// it again: it lives on the SOCKET. There is no per-account and no
// per-connection cap in this server, so one account opening N sockets gets N
// buckets and N times the allowance, and the database sees the sum. It caps a
// connection, not an account and not the database. The push path is not in it
// either — a snapshot pushed by somebody else's accept costs the same eight
// round trips and spends nobody's allowance (see pushFriends, which collapses
// those instead). A per-connection cap belongs with the connection accounting
// in server.js and is the next task's, not this one's.
//
// `squad` is sized like `friends` and for the same reason: a squad op is a
// memory change plus at most ONE profilesByIds behind each snapshot it fans
// out, and a squad box is acted on, not polled. EVERY squad op spends from
// this one bucket — an unknown op included, for handleFriend's reason — and
// every later op (invite, ready, mode, start, resume) joins it by being
// registered in SQUAD_OPS.
//
// `name`, the claim, has a bucket of its own rather than the callsign one: a
// page load, a first save and a sign-in each send one, and three in a minute
// is ordinary, while a rename spends the callsign bucket as before. A claim
// that WRITES a new row is held by reservations.js's own bounds as well: at
// most ROWS_PER_SOCKET new rows a connection, and a process-wide hourly window
// and ceiling.
const LIMITS = { callsign: 3, friend: 10, friends: 20, report: 5, squad: 20, name: 6 };

// The chosen-callsign cooling-off period: a rolling 24 hours since the last
// set, not a calendar day, so there is no timezone to be wrong about.
const DAY = 86400000;

// The cosmetic paint ids public/room-engine.js validates against (its SKINS),
// COPIED rather than imported: nothing under server/ may pull in the game
// engine, which the OFFLINE page also loads. A search result carries the found
// player's paint (BINDING resolution 19) and a paint id is a closed vocabulary,
// so whatever the profile holds is checked against this set before it is echoed
// to another client. Keep in step with public/room-engine.js's SKINS.
const SKIN_IDS = new Set(['olive', 'desert', 'jungle', 'midnight', 'arctic', 'gold']);

// A ROOM OR SQUAD CODE OFF THE WIRE, normalised THE SAME WAY
// public/room-engine.js's roomCode() does it: coerce, upper-case, trim, and
// bound the length. COPIED rather than imported for the reason SKIN_IDS above
// is copied: nothing under server/ may pull in the game engine, which the
// OFFLINE page also loads. Keep in step with public/room-engine.js's roomCode().
//
// TWO COPIES OF THIS RULE, AND THERE MUST NOT BE A THIRD. The engine's
// roomCode() is the authority: its `join` looks rooms up through it and the
// rooms Map is keyed by what it produced. This is the other, and it lives at
// module scope and is EXPORTED because its reader is server.js: the code frame
// is answered there, in the one place its kind is computed, whether or not
// createSocial was ever built. The squad ops that take a code (task 2's join)
// read it here too. test/code_frame.mjs proves this copy and the engine's
// agree, by asking the engine's own `join` the same strings.
//
// Copying it is load-bearing, not tidiness. A code typed in lower case would
// miss every live room if this did not upper-case it the way roomCode() does.
// The coercion is what keeps `{"code": 123}` from throwing on .toUpperCase()
// — the throw that used to reach uncaughtException. An empty string is safe to
// look up in either container, because makeCode only ever mints four
// characters, so it needs no guard of its own.
export const codeOf = (v) => (typeof v === 'string' ? v : '').toUpperCase().trim().slice(0, 8);

// A PER-KEY COOLDOWN: take(key) is true when the caller may act now, and
// the key is then held for `ms`; false while an earlier take's window is
// open. Its one user is the invite push (D-PUSH-1 R, in createSocial).
// BOUNDED, because every key is a value off the wire: expired entries go on
// every take (a Map iterates in insertion order, a re-taken key is
// re-inserted, and every window is the same length, so the expired ones are
// at the front; a clock stepped back can leave one behind a later one, and
// it goes when that one does), and at `max` entries the oldest goes, so a
// flood of new keys costs the flood's own oldest window, never memory. A
// window of 0 holds nothing. Exported for its own tests.
export function createCooldown({ ms, max, now }) {
  const until = new Map();
  return {
    take(key) {
      const t = now();
      for (const [k, u] of until) { if (u > t) break; until.delete(k); }
      const u = until.get(key);
      if (u !== undefined && u > t) return false;
      until.delete(key);
      if (!(ms > 0)) return true;
      while (until.size >= max) until.delete(until.keys().next().value);
      until.set(key, t + ms);
      return true;
    },
    get size() { return until.size; },
  };
}

// THE SQUAD REFUSALS, BY OP (E9, the whole-branch fix wave): every error code
// a squad reply to that op can carry, and nothing else. The client words
// each as squad.<op>.<code>, so this is the contract between the two, and
// test/squad.mjs (err) pins it: adding or renaming a code is a change the
// client must be told of. squadReply and Start's fan-out send any code NOT
// on its op's list as 'unavailable', so a word the state machine or the
// seating starts to answer can never reach a client unnamed. An op not
// listed here (one that does not exist) answers only slow_down or
// unavailable. `dropped` (ready) is the machine's refusal of a Ready on a
// row with no socket; `refused` and `capacity` (start) are the seating's.
const BASE_ERRORS = Object.freeze(['slow_down', 'unavailable']);
export const SQUAD_ERRORS = new Map(Object.entries({
  create: [...BASE_ERRORS],
  join: [...BASE_ERRORS, 'no_such_squad', 'full', 'already_in'],
  leave: [...BASE_ERRORS],
  kick: [...BASE_ERRORS, 'not_leader', 'no_such_member'],
  ready: [...BASE_ERRORS, 'no_squad', 'no_rack', 'dropped'],
  mode: [...BASE_ERRORS, 'no_squad', 'not_leader', 'bad_mode', 'bad_tees', 'bad_max'],
  start: [...BASE_ERRORS, 'no_squad', 'not_leader', 'wrong_device', 'no_rack', 'duplicate_member', 'wont_fit',
    'member_offline', 'not_ready', 'member_busy', 'refused', 'capacity'],
  resume: [...BASE_ERRORS],
  // no_such_user is the by-callsign invite's one miss (squadInviteByName).
  invite: [...BASE_ERRORS, 'no_squad', 'full', 'not_friend', 'already', 'no_such_user'],
}).map(([op, codes]) => [op, Object.freeze(codes)]));
const squadError = (op, code) => ((SQUAD_ERRORS.get(op) || BASE_ERRORS).includes(code) ? code : 'unavailable');

// THE KEY AN EXACT CALLSIGN IS LOOKED UP BY, or '' for a query no stored
// callsign could match. ONE COPY for the two lookups, friend search and the
// squad invite by callsign, so a name one of them finds the other finds too.
// Code points, because that is how validateCallsign measured the name that
// was stored: one astral letter is one character on both sides.
function callsignKeyOf(raw) {
  const q = normaliseCallsign(raw);
  const n = [...q].length;
  return n < CALLSIGN_MIN || n > CALLSIGN_MAX ? '' : q.toLowerCase();
}
// A BLOCK EITHER WAY between the reader of `b` (blockIdsOf's answer) and `id`:
// blocking is not a mute, and every gate in this file reads both directions.
const blockedEither = (b, id) => b.blocked.includes(id) || b.blockedBy.includes(id);

// ---- UNBLOCK KEYS (BINDING.md resolution 24, applied to the blocked list) ----
// THE HOLE THIS CLOSES. A lobby seat carries a per-room opaque handle instead of
// an account id precisely so a modified client cannot correlate a player across
// matches and build a graph of who plays with whom — resolution 24's own words
// are that publishing account ids "is a privacy leak far worse than the
// problem". block add ACCEPTS that handle (targetId below) and the blocked list
// used to answer `{ id: <the account uuid>, callsign }` for every row. Compose
// the two and the handle is trivially convertible, from a socket the attacker
// already owns and with no rate limit on add or remove: block every seat in the
// lobby, list, read the uuids, unblock. The uuid is not inert either — a uuid is
// all friendRequest needs, so a stranger from one quick match could then be
// asked for ever, and public/privacy.html states in this build that another
// player can never learn your account identifier.
//
// WHAT REPLACES IT. The list still has to be ACTIONABLE — Unblock is the only
// way out of a block, and a guest's blocked list is the whole Friends screen for
// them — so the row cannot simply lose its id. It carries an UNBLOCK KEY:
// HMAC(process secret, this connection's salt + the account id), 32 hex
// characters. The properties are the seat handle's, on purpose:
//
//   * NOT DERIVABLE from the account: without the process secret and the
//     socket's salt there is nothing to compute, and neither ever leaves here.
//   * MEANINGLESS ANYWHERE ELSE: it fails isUuid, so it cannot be spent as
//     `friend op:'request' to:`, as a report target, or as a block target; and
//     it is 32 hex where a seat handle is 8, so it cannot be spent as a handle.
//   * DOES NOT SURVIVE THE CONNECTION: the salt is minted per socket, so the
//     same account seen on a new connection is a different key, and a key kept
//     from a previous session resolves to nothing.
//   * STABLE WITHIN one connection, which is what keeps a rendered Unblock
//     button working — including after the list is re-read, which the client
//     does after every unblock.
//
// WHAT IT DOES NOT CLOSE, said plainly rather than left to be discovered: block
// add is idempotent and the list is enumerable, so a modified client can still
// ask "is this seat someone I have already blocked?" by watching the list's
// LENGTH, and narrow which one by unblocking selectively. That oracle survives
// any id scheme, including no id at all, because the block itself is a durable
// per-pair relation. What is gone is the cheap part: a permanent, global,
// cross-account identifier that is also a valid target on three other frames.
//
// ONE SECRET PER PROCESS, and a restart rotates every key in flight. That is
// harmless: a key is only ever spent seconds after the list that carried it, and
// a restart drops every socket anyway.
const BLOCK_KEY_SECRET = randomBytes(32);
const BLOCK_KEY_RE = /^[0-9a-f]{32}$/;

// resolveHandle(ws, handle) -> account id | null. INJECTED, and defaulting to a
// function that resolves nothing, for the same reason `store` and `send` are:
// the thing that knows about rooms is public/room-engine.js, which the OFFLINE
// page imports and which must therefore gain no database and no account logic
// (ADR-001), and this module must gain no rooms. server.js holds both and joins
// them — it passes the engine's resolveSeatHandle straight in. With no resolver
// (every existing test, and any host that does not wire one) a handle resolves
// to nothing and is answered no_such_user, which is the safe direction: the
// friends-panel route is unaffected and no target is ever guessed at.
//
// roomExists(code) -> bool. INJECTED for exactly the reason resolveHandle
// above is, and defaulting to a function that finds nothing: the container of
// rooms is public/room-engine.js's `rooms` Map, the OFFLINE page imports that
// file, and this module must gain no rooms. server.js holds both and passes
// `(code) => rooms.has(code)` straight in.
//
// ITS READER IS THE SQUAD MINTER: the other direction of one code namespace
// (plan R4) is a squad code refusing any candidate that names a live room,
// and this is the only route from server/ to `rooms`. It is handed to
// createSquads as codeTaken below, and nothing else in this file reads it.
// test/code_frame.mjs proves the wiring against the real server.js, with the
// code bytes scripted so a squad is made to try a live room's code first.
// The default refuses nothing, which is the right direction for a host that
// wires no rooms at all.
//
// seats, teeIds, validRack — public/room-engine.js's MODE_SEATS, TEE_IDS and
// validRackFor, injected by server.js across the same seam and for the same
// reason: this module may not import the engine, and a squad's `fits`, its
// armed mode and its members' racks must be judged by the numbers the room
// will really enforce, not by a copy of them. EVERY DEFAULT FAILS CLOSED: with
// no table no mode is known (every mode frame is bad_mode and `fits` claims
// nothing), with no tee ids every tee set is refused, and with no predicate
// no rack is accepted. A host that forgets to wire them gets refusals, never
// a squad told it fits a room it does not.
//
// seatSquad(seats, opts) -> { ok, code } | { ok: false, error } — server.js's
// seating of a whole squad into one room (plan R2), injected for the same
// reason as the rest: creating a room and seating players is the engine's, and
// this module may not import it. The default refuses, 'unavailable', like
// resolveHandle's resolves nothing: every host that does not wire one (every
// suite that builds this layer without it) gets an honest refusal, never a
// start that quietly seated nobody.
//
// schedule(fn, ms) -> cancel() — the squad drop window's timer (task 5),
// injected for the reason `now` is: so a suite can run the window without
// waiting on wall time, and without a sleep that a busy machine could make
// flake. The default is what production runs: a real setTimeout, unref'd so a
// pending window never holds the process open. It is a BARE timer — nothing
// under server/ has the engine's safeTimeout — so every callback handed to it
// here is wrapped by hand (see the drop window below).
//
// pushInvite(toUserId, { code, from, size, max }, { dryRun, signal }) ->
// Promise<boolean> — the squad invite's PUSH transport (design 4.4), for an
// invited friend who holds no live socket. Injected for the reason seatSquad
// is: the web push, FCM and APNs senders live in server.js, and this module
// has no transport of its own. `from` is the inviter's PROVED name and may be
// null, so the copy for a nameless inviter is the transport's to write. It
// resolves `true` when at least one of the invitee's devices has an endpoint
// to hand the payload to (the one subscription read; the sends are not
// awaited) — the whole difference between delivered:'push' and 'none' — and
// every other answer, a throw included, is 'none' (see squadInvite).
// `dryRun: true` (D-BLOCK-2 E, as the owner revised it) makes THE SAME READ,
// SENDS NOTHING, and answers what a real call would have: a DROPPED invite
// asks it, so the inviter's answer, and what it cost up to that answer, are
// a real invite's (after it a real invite sends, and a dropped one does not).
// `signal` is an AbortSignal aborted when the seam's time is up and the
// inviter has been answered none (see askPushSeam): a transport must start
// no send once it is aborted.
// THE DEFAULT DELIVERS NOTHING AND SAYS SO, in both forms: every host that
// wires no transport, and every suite, gets an honest 'none', never a 'push'
// that went nowhere. Task 7 replaces this default from server.js.
//
// names — the in-memory index of chosen callsign keys (server/name-index.js,
// round 2): state(key) -> 'free' | 'taken' | 'unknown', and add(key) and
// remove(key), which the Set and the roll call when their write lands, and
// lookalikes(reading) -> the keys that read that way, or null before the
// index has loaded (the Set's look-alike check, round 2 fix). A
// typed name a guest checks, and the name a guest's squad seat shows, may not
// be one an account holds (display-name.js typedName). THE DEFAULT KNOWS
// NOTHING: every key is 'unknown', so a host that wires no index refuses every
// typed name ('unavailable') and shows no guest's typed name, never one that
// might be someone else's.
//
// seatName(ws, handle) -> the name a lobby seat showed, or null — the engine's
// resolveSeatName, injected beside resolveHandle and for its reason: a report
// against a seat records the name the reporter SAW, which for a typed name no
// profile row can prove (display-name.js seatName). The default resolves
// nothing, and a report then records what seenName proves, as before.
//
// door — the room engine's own name door, for the squad's box (round 3 fix,
// 2026-10-10): { standInFor, liveNameReadings, nameReadingsOf }, exported by
// public/room-engine.js and handed in by server.js, for the reason seatSquad
// is. Two members of one squad are never shown one name: a member whose name
// reads as one shown before them in the order the squad is seated is shown
// under the stand-in the engine's door will seat them under (standInFor),
// and one whose name the server does not hold is not shown under a name a
// live player elsewhere is (liveNameReadings). THE DEFAULT still keeps two
// members of one squad apart, with this module's own reading of a name and a
// stand-in drawn the engine's way from the same pool; it only knows nothing
// of live names outside the squads.
//
// THIS LIST ACCUMULATES (plan X2). A later task adds its option after these;
// it never restates the line.
export function createSocial({
  store, terms, send, now,
  resolveHandle = () => null,
  roomExists = () => false,
  seats = {}, teeIds = [], validRack = () => false,
  seatSquad = () => ({ ok: false, error: 'unavailable' }),
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); if (typeof t.unref === 'function') t.unref(); return () => clearTimeout(t); },
  pushInvite = async () => false,
  names = { state: () => 'unknown', lookalikes: () => null, add() {}, remove() {} },
  seatName = () => null,
  reservations = RESERVATIONS_OFF,
  door = null,
}) {

  // userId -> that account's live sockets. "Online" is "the set is non-empty".
  // Presence is never persisted (design 4.1).
  const online = new Map();

  // Every reply carries the request's id when one was sent, so a client with
  // two requests in flight can tell the answers apart. The echo goes 1:1 back
  // to the sender only, and the frame that carried it was already capped at
  // 64 KB by maxPayload, so there is nothing here to amplify.
  //
  // Argument order is (ws, msg, frame) — BINDING.md resolution 11, which Tasks
  // 5 and 6 paste against. The message comes before the answer to it.
  function reply(ws, msg, frame) {
    if (msg && msg.id !== undefined) frame.id = msg.id;
    send(ws, frame);
  }

  // The send used by every loop that is not answering a request: a fan-out to a
  // player's other sockets, a snapshot to the other side of an operation, a
  // presence dot to a friend. A throw from ONE socket — a half-closed ws whose
  // send() raises rather than returning — must not take the rest of the loop
  // with it. In pushFriends it did worse than that: the operation had already
  // been written and already been answered ok, so the throw propagated into
  // handleFriend's catch and emitted a second frame saying it had failed, while
  // the remaining sockets and the other player got no snapshot at all.
  const safeSend = (ws, frame) => { try { send(ws, frame); } catch { /* one dead socket, not the loop */ } };

  // The unblock key for THIS socket, for one account. See the long note above
  // BLOCK_KEY_SECRET for why the blocked list carries this instead of a uuid.
  // The salt rides on the ws object the way the rate buckets and socialUser do,
  // and is minted on first use rather than at auth, so a socket that never opens
  // a blocked list never pays for one.
  function blockKey(ws, id) {
    const salt = ws.blockSalt || (ws.blockSalt = randomBytes(16).toString('hex'));
    return createHmac('sha256', BLOCK_KEY_SECRET).update(`${salt}|${id}`).digest('hex').slice(0, 32);
  }

  // The reverse, and it is a SEARCH rather than a lookup on purpose: nothing is
  // stored, so there is no table to grow, nothing to expire, and no way for a
  // key to resolve to an account this socket's own account has not blocked. The
  // candidates are exactly the blocker's own rows.
  async function resolveBlockKey(ws, key) {
    // NO SALT MEANS NO KEY WAS EVER ISSUED ON THIS SOCKET, so nothing 32 hex
    // characters long that arrives on it can be one and there is nothing to look
    // up. Without this, `block op:'remove'` — which design 4.2 rate limits not
    // at all — would spend blockIdsOf's two PostgREST round trips on every junk
    // id a client cared to send, tripling the cost of an unrated write path for
    // a socket that has never even opened a blocked list. The answer is
    // no_such_user either way, so nothing is observable but the round trip.
    if (!ws.blockSalt) return '';
    const { blocked } = await store.blockIdsOf(ws.userId);
    return blocked.find((id) => blockKey(ws, id) === key) || '';
  }

  // A friends snapshot as ONE SOCKET must see it. friendsSnapshot builds the
  // frame once for an account and sendSnapshot fans it out to every device, but
  // an unblock key belongs to a CONNECTION — so the blocked array is remapped
  // per destination. Everything else in the frame is shared and is not copied.
  //
  // `friends` and `requests` keep their uuids, and that is not an oversight: a
  // friend and a pending request are people this account reached deliberately,
  // by friend code or by searching a unique callsign, and the client has to be
  // able to name them on the next frame it sends. The blocked list is the one
  // list a STRANGER can be put on without ever being found.
  const forSocket = (ws, snap) => (snap && Array.isArray(snap.blocked)
    ? { ...snap, blocked: snap.blocked.map((b) => ({ ...b, id: blockKey(ws, b.id) })) }
    : snap);

  // ---- The two gates (BINDING.md resolutions 1 and 18) ----------------------
  // A GUEST HAS AN ACCOUNT ID. public/cloud.js mints an ANONYMOUS Supabase
  // account for every player who saves anything (is_anonymous: true), so
  // `!ws.userId` is not "guest" — it is "this socket never said hello, or its
  // token did not verify". The account KIND is what these gates read, and
  // server.js sets ws.isGuest beside ws.userId from the same GET /auth/v1/user
  // the auth sink already makes.
  //
  // There are TWO gates because the answer differs by message type:
  //
  //   friends / friend / callsign -> requireLinked
  //       Friends need an account that survives a reinstall (spec D5), and a
  //       chosen name needs one a player cannot discard and remint in a tap —
  //       a report against a throwaway anonymous account is unactionable.
  //
  //   report / block              -> requireAccount
  //       The opposite, and it is the sentence App Review looks for: a guest
  //       who sees an offensive name in a lobby is exactly the player who needs
  //       to report it. Apple asks for a mechanism for USERS, not for some of
  //       them. A guest already has an anonymous account id, so both rows store
  //       and cascade normally.
  //
  // Both answer rather than drop: a client that gets nothing back waits for its
  // reply for ever.
  function requireAccount(ws, msg) {
    if (ws.userId) return true;
    reply(ws, msg, { type: 'social', error: 'sign_in' });
    return false;
  }
  function requireLinked(ws, msg) {
    if (ws.userId && !ws.isGuest) return true;
    reply(ws, msg, { type: 'social', error: 'sign_in' });
    return false;
  }

  // The token bucket from server.js's auth sink, one bucket per socket per
  // kind. Refill before spending so an idle socket recovers its allowance, and
  // SPEND BEFORE THE AWAIT so a burst cannot slip several requests past the
  // limit while the first one is still in flight.
  //
  // Named rateOk(ws, key, limit) per BINDING.md resolution 11.
  function rateOk(ws, key, limit) {
    const tok = ws._socialTokens || (ws._socialTokens = {});
    const ref = ws._socialRefill || (ws._socialRefill = {});
    const t = now();
    // Math.max(0, …): CLAMP THE ELAPSED TERM AT ZERO. now() is wall-clock, and
    // a clock that jumps BACKWARDS (ntp step, a VM resume, a manual set) makes
    // the refill NEGATIVE — the bucket then goes below zero with no floor and
    // this socket is starved in proportion to the jump, for as long as it takes
    // the honest refill to climb back. Min() caps the top; this is the bottom.
    tok[key] = Math.min(limit, (tok[key] ?? limit) + (Math.max(0, t - (ref[key] ?? t)) / 60000) * limit);
    ref[key] = t;
    if (tok[key] < 1) return false;
    tok[key] -= 1;
    return true;
  }

  // Call AFTER ws.userId is set. A guest has no presence: presence exists to
  // tell FRIENDS who is about, and an anonymous account can never be anyone's
  // friend, so listing one would leak a stranger's session into a friends panel
  // and grow this map by an entry per throwaway account.
  //
  // The socket also REMEMBERS WHICH ACCOUNT it was counted under. server.js's
  // sign-out branch clears ws.userId and the seat closes afterwards, so a
  // clean-up that looked the socket up by ws.userId alone would never find it
  // and that account would read online for the life of the process.
  //
  // EVERY KIND OF ACCOUNT, GUESTS INCLUDED, GOES THROUGH THE SIGN-IN DOOR of
  // D-BLOCK-2 B (signInDoor): a block can name an anonymous account too.
  //
  // THE DOOR OPENS WHEN THE SOCKET BECOMES AN ACCOUNT, not on every hello,
  // and only on a GUEST row (see signInDoor).
  // `squadAs` is the account this socket was last let in as, and onClose
  // clears it on a sign-out and on a hello for another account, so it
  // answers "the same account again" and nothing else. A re-hello with a
  // rotated token for that account (the client's retry, a repeated sign-in)
  // stands on rows already checked for it — by the join that made them,
  // which sets `squadAs` too (T6-R1-3), or by this door — so it reads
  // nothing, and a store fault at that moment removes nobody, a leader
  // included. A door whose read failed let nobody in, and clears `squadAs`
  // so the next hello tries again.
  function onAuth(ws) {
    if (!ws || !ws.userId) return;
    const fresh = ws.squadAs !== wireId(ws.userId);
    ws.squadAs = wireId(ws.userId);
    if (ws.isGuest) { if (fresh) signInDoor(ws); return; }
    if (ws.socialUser && ws.socialUser !== ws.userId) dropPresence(ws.socialUser, ws);
    ws.socialUser = ws.userId;
    let set = online.get(ws.userId);
    if (!set) { set = new Set(); online.set(ws.userId, set); }
    set.add(ws);
    // SEED THE LAST STATE ON FIRST SIGHT. Nobody has ever been told anything
    // about this account, and "nothing said" is the same as offline — so record
    // it. Without the seed a player who connects and drops inside one window
    // ends the window offline against an EMPTY last state, which is not equal,
    // so the flush costs a store read and broadcasts an offline dot for someone
    // no friend was ever told about. presenceLast is cleared again when a flush
    // reports offline, so this runs for every fresh arrival, not only the first.
    if (!presenceLast.has(ws.userId)) presenceLast.set(ws.userId, false);
    // Every counted change asks for a flush, rather than only the first socket.
    // The "only the first and last socket of a player move presence" property
    // comes from the COLLAPSE in flushPresence, which is the one place it can be
    // right, and is tested there — a second `if (!was)` here would be a branch
    // with no observable behaviour to fail on, and it would also make a flush
    // that lost its store read sticky, because nothing would ask again.
    presenceChanged(ws.userId);
    // A GUEST ROW THIS SOCKET HOLDS IS NOW AN ACCOUNT'S (task 5's fix pass):
    // one account, one row, one seat. See claimOnSignIn. When this hello
    // makes the socket a new account the door reads first, and claims the
    // row only once its answer has let the account in (D-BLOCK-3 F).
    if (!(fresh && signInDoor(ws))) claimOnSignIn(ws);
  }

  // Call on close, and on a sign-out hello. Unlike the first version of this
  // function it does NOT depend on ws.userId still being set.
  //
  // The squad hook runs AFTER presence, so the roster it pushes already says
  // the account is offline, and BEFORE socialUser is cleared. It finds the
  // row by the socket, not by ws.userId, so it does not depend on the id
  // either.
  function onClose(ws) {
    if (!ws) return;
    dropPresence(ws.socialUser || ws.userId, ws);
    dropSquadMember(ws);
    ws.socialUser = null;
    // Whoever this socket is next comes through the sign-in door (onAuth).
    ws.squadAs = null;
  }

  function dropPresence(id, ws) {
    const set = id ? online.get(id) : null;
    // Only a socket that was actually counted can move presence — delete()
    // answering false is how a double close, or a guest, costs nothing.
    if (!set || !set.delete(ws)) return;
    // Drop the empty set rather than leaving it behind: this Map is keyed by
    // account and would otherwise grow by one entry per account that has ever
    // connected, for the life of the process. pushAt goes with it for the same
    // reason — there is nobody left to collapse a snapshot for.
    if (!set.size) { online.delete(id); pushAt.delete(id); }
    presenceChanged(id);
  }

  // ---- callsign (design 4.2, 4.5) -------------------------------------------
  // Every throw out of this function — from validateCallsign or from any of the
  // three store calls — is caught by handle() and answered 'unavailable'. There
  // is deliberately no try/catch here: one net, in one place, that no future
  // branch can be added around by accident.
  async function callsign(ws, msg) {
    if (!rateOk(ws, 'callsign', LIMITS.callsign)) return reply(ws, msg, { type: 'callsign', error: 'slow_down' });

    // THE ROLL. The client rolled a new name, so the account gives up its
    // chosen key: the rolled name becomes non-unique and unsearchable again
    // (design 4.5). `callsign_set_at` is deliberately NOT cleared — if it were,
    // roll-then-set would be a free way around the once-a-day rule. Any `name`
    // on a rolled frame is ignored: the rolled display form is written to the
    // profile by the client's own cloud queue, as it always has been.
    //
    // ONLY AN OLD BUILD SENDS THIS NOW. Roll is gone from the client (owner,
    // 2026-10-07: names are permanent, "disable the ability to cycle through
    // new names"), so a current client never gives its key back. The branch
    // stays, unchanged, for builds 6 and 7, which still offer Roll until they
    // update: answering them is what keeps a name they rolled off from staying
    // reserved to an account that no longer shows it.
    if (msg.rolled === true) {
      // ONE WRITE PER NAME GIVEN UP, NOT ONE PER FRAME. The bucket above lives
      // on the SOCKET, so reconnecting resets it, and this branch has no
      // once-a-day gate and no check that the account holds a key at all —
      // which made every rolled frame an unconditional PATCH against PostgREST,
      // uncapped per account. ws.chosenName is the socket's copy of what the
      // profile row holds (server.js's auth sink fills it, the set branch
      // below updates it), so a null one means there is nothing to clear and
      // the round trip buys nothing. The reply is identical either way, so no
      // client can tell the difference.
      if (ws.chosenName) {
        await store.clearCallsignKey(ws.userId);
        // The key is free again, so the index frees it: a guest may now type
        // the name this account gave up. ws.chosenName is the normalised name
        // the key was derived from (server.js's auth sink proves exactly that),
        // so its lower case IS the key.
        keyRemoved(ws.chosenName.toLowerCase());
        // EVERY SOCKET OF THE ACCOUNT, not just the one that asked.
        // clearCallsignKey frees the key for the ACCOUNT, but ws.chosenName is
        // the per-socket copy and it is the single door through which a string
        // that is not a rolled pair reaches another player (room-engine's
        // sanitizeName reads exactly this field). Clearing only the caller left
        // a player's other device presenting a callsign the account had just
        // surrendered — and once somebody else legitimately takes that name,
        // presenting THEIR unique callsign to strangers, with seenName then
        // recording the '(no name)' sentinel for a report against a seat that
        // visibly had one (the evidence mismatch BINDING 26 exists to prevent).
        // socketsOf is already how pushFriends fans out; the exemption simply
        // never used it.
        //
        // ws is set BESIDE the loop rather than inside it: a socket is in
        // `online` only once onAuth has counted it, and this must not depend on
        // the caller being there to clear the caller.
        for (const w of socketsOf(ws.userId)) w.chosenName = null;
        ws.chosenName = null;
      }
      return reply(ws, msg, { type: 'callsign', ok: true, callsign: null });
    }

    // Validation is pure and free. Doing it first means a rejected name never
    // costs a round trip to the database.
    //
    // It also THROWS a TypeError when `terms` is not an array — a deliberate
    // fail-closed at wire-up time, because substituting [] there would turn the
    // only moderation control in the product off silently. This project's
    // uncaughtException handler ENDS THE PROCESS and every live match with it,
    // so that call has to sit inside handle()'s try, and it does.
    //
    // checkPlayerName, NOT validateCallsign ALONE (round 2, 2026-10-08): the
    // same guidelines a guest's name meets, the engine's isProfane and the
    // game's own names included. validateCallsign alone let 'Pedo Tank' be
    // stored for a signed-in account while a guest typing it was refused.
    // checkPlayerName runs validateCallsign first, so the TypeError above still
    // comes from here. Uniqueness is NOT asked of the index: the write below is
    // the authority on that.
    const v = checkPlayerName(msg.name);
    if (!v.ok) return reply(ws, msg, { type: 'callsign', error: v.error });

    const profile = await store.profileById(ws.userId);
    // A null column, no row at all, or an unparseable timestamp all mean "no
    // set on record", so the change is allowed. Failing OPEN is deliberate: a
    // corrupt timestamp must not lock a player out of their own name for ever.
    const lastSet = profile && profile.callsign_set_at ? Date.parse(profile.callsign_set_at) : NaN;
    // THE REFUSAL SAYS WHEN (owner, 2026-10-07): the editor tells a player
    // "You can change your name again in 7 hours", and only the server knows
    // when this account last set one — a second device, or this one after a
    // reinstall, has nothing of its own to count from. `wait` is what is left
    // of the 24 hours, in milliseconds, so no client clock enters into it;
    // always above zero here, because the branch only runs inside the window.
    if (Number.isFinite(lastSet) && now() - lastSet < DAY) return reply(ws, msg, { type: 'callsign', error: 'too_soon', wait: DAY - (now() - lastSet) });

    // THE WRITE IS THE AUTHORITY on uniqueness, not a read before it: two
    // sockets can both read "free" and then both write. The unique index on
    // callsign_key decides, and the loser is told 'taken'.
    // The key this account holds now, read off the profile BEFORE the write
    // replaces it, so the index can free it once the write lands.
    const prevKey = profile && typeof profile.callsign_key === 'string' ? profile.callsign_key : '';
    // NOR ANOTHER ACCOUNT'S CALLSIGN TO THE EYE (round 2 fix, 2026-10-08).
    // The unique index compares keys, and a fullwidth 'Viper', or 'Coco' spelt
    // in Cyrillic letters beside a Latin 'Coco', is a different key and the
    // same name on screen. So the look-alike readings of the key
    // (server/callsign.js keyReadings, below) are looked up in the
    // in-memory index, which knows every key that reads each way
    // (server/name-index.js lookalikes), and a key there that is not this
    // account's own is refused 'taken', the word the write uses for the same
    // collision. The account's own key is not a collision: a player may
    // re-case their own name, or move off an old look-alike of it. An index
    // that has not loaded, is missing or throws refuses 'unavailable', so the
    // check fails closed; the index loads at boot and retries in thirty
    // seconds (server.js). Mixed scripts never reach here: checkPlayerName
    // refused them above.
    //
    // A READ BEFORE A WRITE, so two accounts setting look-alikes of each other
    // in the same moment can both pass it; the exact key's race is still the
    // unique index's. Stated rather than hidden: closing it would need the
    // skeleton in the database, which this round does not migrate.
    //
    // EVERY READING OF THE KEY, NOT ONLY THE SPELLING SENT (round 2 fix,
    // 2026-10-08). The key is what is stored, and a key can be SHOWN in more
    // than one casing: the spelling column beside it is the account's to
    // PATCH. This looked up the skeleton of the spelling submitted alone, so a
    // Greek lower-case key whose capitals read as another account's name
    // ('HYENA') was stored, and its holder could then show the capitals.
    // keyReadings is every way the key can be shown (itself, in capitals,
    // capitalised word by word), the same readings the index keeps for it,
    // and shownSpelling, the one rule every reader of the column applies,
    // never shows it any other way; so each reading is asked here, and one
    // that belongs to another account's key is refused 'taken'.
    let alike = null;
    try { alike = names && typeof names.lookalikes === 'function' ? keyReadings(v.key).map((r) => names.lookalikes(r)) : null; } catch { alike = null; }
    if (!Array.isArray(alike) || !alike.every(Array.isArray)) return reply(ws, msg, { type: 'callsign', error: 'unavailable' });
    if (alike.some((keys) => keys.some((k) => k !== prevKey))) return reply(ws, msg, { type: 'callsign', error: 'taken' });
    // NOR A NAME ANOTHER PLAYER HAS RESERVED (round 3, 2026-10-10: "no 2
    // players can have the same exact name"). Every reading of the key is asked
    // of the reservations table itself, since a write follows: a row held by
    // any other player, a guest's device included, refuses 'taken'. The
    // account's own reservation is not a collision: a player may make the name
    // they already hold their chosen callsign. With no table this says no.
    // The key itself is asked (round 3 fix, 2026-10-10): the reservations'
    // key is the name in lower case now, and takenFor reads every reservation
    // any reading of it meets, as the index keeps them.
    if (await reservations.takenFor(v.key, ws.userId)) return reply(ws, msg, { type: 'callsign', error: 'taken' });
    // WHAT IS STORED IS WHAT WILL BE SHOWN. A spelling whose capitals read as
    // none of the key's readings (an odd mixture of Greek capitals) would be
    // shown as the key itself by every reader (shownSpelling), so it is stored
    // and answered that way, and the player's own screen agrees with everyone
    // else's. Every ordinary spelling is stored exactly as it was sent.
    const spelled = shownSpelling(v.name, v.key);
    const res = await store.setChosenCallsign(ws.userId, spelled, v.key);
    if (!res || res.ok !== true) {
      // A closed set of codes. Anything the store invents stays inside the
      // server rather than reaching a client that has no string for it.
      return reply(ws, msg, { type: 'callsign', error: res && res.error === 'taken' ? 'taken' : 'unavailable' });
    }
    // THE INDEX FOLLOWS THE WRITE (server/name-index.js): the new key is taken
    // from this moment, so no guest can type it into a lobby, and the key the
    // account held before is free again.
    if (prevKey && prevKey !== v.key) keyRemoved(prevKey);
    keyAdded(v.key);
    // From here this socket may present this name in a lobby: server.js passes
    // ws.chosenName to sanitizeName, which is the ONLY way a string that is not
    // a rolled pair reaches another player's screen.
    //
    // THE MATCHING HALF OF THE ROLL BRANCH ABOVE, and the same loop. The account
    // holds the key now, so every one of its sockets is entitled to present the
    // name; without this a player who sets a callsign on their phone goes on
    // joining lobbies from their desktop under a rolled pair until that socket
    // re-hellos. It changes no seat already sitting in a room — server.js reads
    // this field when a socket joins — so nobody is renamed mid-match.
    for (const w of socketsOf(ws.userId)) w.chosenName = spelled;
    ws.chosenName = spelled;
    // ONE NAME PER PLAYER (round 3): the chosen callsign is the account's name
    // now, so no socket of the account goes on carrying the name it had
    // reserved, and that name is released for anyone, after the answer, so a
    // slow store holds up nobody's Save. Best-effort: a release that fails is
    // retried by the account's next claim, which releases it too.
    for (const w of socketsOf(ws.userId)) { w.reservedName = null; w.nameRow = null; }
    ws.reservedName = null; ws.nameRow = null;
    reply(ws, msg, { type: 'callsign', ok: true, callsign: spelled });
    await reservations.release(ws.userId).catch(() => {});
    // AND THE ACCOUNT'S SQUAD ROW FOLLOWS AT ONCE (owner, 2026-10-10: a rename
    // takes effect everywhere at once). A linked row is named from the profile
    // row (displayName), which the write above has just changed, but nothing
    // told the squad, so every member's box, the player's own included, went on
    // showing the old name until something else pushed the squad. The match
    // the squad starts needs nothing here: the engine seats ws.chosenName, set
    // just above, whatever name the row carried in. checkName does the same
    // for a guest's row. A failed push costs only the cosmetic update, which
    // the next push carries.
    const own = squadOf(ws);
    if (own) await pushSquad(own.squad, null, null).catch(() => {});
  }

  // ---- the name check (owner, 2026-10-07) ------------------------------------
  // A GUEST MAY NAME THEMSELVES TOO: "the player is given a default name and
  // then they can change it to whatever they like, as long as it stays within
  // the guidelines". A guest has no account a chosen callsign could be stored
  // on (requireLinked, above, and BINDING resolution 2), so their name is kept
  // on their own device — and this op is how the device learns, BEFORE it keeps
  // one, whether the guidelines allow it. It stored nothing and read nothing
  // from the store until round 3 (a socket that holds a reservation now
  // renames it: see the last paragraph): the answer is the same test the room
  // engine applies at the door (typedName here, its twin playerName there),
  // so a name this says yes to is the name a lobby shows, and one it refuses
  // would have been replaced there anyway. The check here is what lets the
  // player be TOLD.
  //
  // OPEN TO ANY SOCKET, the one callsign op that is: a guest who never saved
  // anything has no account id at all. The 3-a-minute bucket is the same one a
  // set spends, so the op cannot be used to probe the blocklist faster than a
  // player can type.
  //
  // NOT UNIQUE, BUT NEVER ANOTHER PLAYER'S CHOSEN CALLSIGN (round 2,
  // 2026-10-08). Two guests may type the same name. Neither may type a name an
  // account holds as its chosen callsign: the engine's door refuses it
  // (display-name.js typedName), so this answers 'taken', the word the Set
  // already uses, and the editor says "Someone has that callsign." It reads
  // the in-memory index (server/name-index.js), so it still makes no store call.
  // While the index has not loaded it answers 'unavailable', because the door
  // would refuse the name too.
  //
  // THE ORACLE THIS OPENS, AND WHY IT IS ACCEPTED. It now says, to a socket with
  // no account behind it, whether a chosen callsign exists. That is not new
  // knowledge. The door itself answers the same question (join a lobby under the
  // name and see what the seat shows), every lobby shows chosen callsigns to
  // strangers, and any linked account can find one by exact callsign. The rate
  // stays the 3-a-minute bucket a Set spends.
  //
  // THE ONCE-A-DAY RULE FOR A GUEST IS THE DEVICE'S (the controller's stated
  // default). There is nothing here to count a guest by that a reinstall does
  // not reset, and a modified client could skip the op entirely: what holds a
  // guest's name to the rules is the engine's check at the door, not this.
  //
  // AND IT MOVES THE GUEST'S SQUAD ROW (round 2 fix, 2026-10-08). A yes here
  // is the name the guest keeps (app.js sendGuestName keeps the reply's name
  // the moment it arrives), but a guest's squad row held the name its create
  // or join frame carried, so the row, on every member's screen and the
  // guest's own, and the seat the squad's start hands the engine, kept the old
  // name until the guest left and joined again. So on a yes, the row this
  // socket holds, when it is a guest row and the socket is still a guest's,
  // takes the server's normalised name, and the squad is pushed. A refusal
  // changes nothing. A failed push costs only the cosmetic update, which the
  // next push carries.
  //
  // AND A YES IS NOW THE PLAYER'S RESERVATION (round 3, 2026-10-10). A socket
  // whose claim answered a row (claimName below: ws.nameRow) holds its name on
  // the server, so the check is a rename of that row: the new name is free or
  // the holder's own in other capitals, the write is the authority on that
  // (another player's row with the same key refuses it 'taken'), and the old
  // name is free the moment the new one lands. A socket with no row (an old
  // build, or a host with no table) is answered as before, and the reserved
  // names are part of what 'taken' means for it too (keyState above).
  //
  // ONLY THE ROW THIS SOCKET'S HOLDER HOLDS (round 3 fix, 2026-10-10: a
  // device's secret never confers an account's name). An account's row is
  // renamed only by a socket that is that account now; a device's row by the
  // socket that claimed it with the device's secret. Anything else (a row kept
  // across a change of account this socket was not told about) is let go
  // here, and the store's write matches the holder too, so a row that moved
  // to an account since the claim matches nothing and answers 'gone'.
  async function checkName(ws, msg) {
    if (!rateOk(ws, 'callsign', LIMITS.callsign)) return reply(ws, msg, { type: 'callsign', op: 'check', error: 'slow_down' });
    let v;
    if (ws.nameRow && ws.nameRow.user_id && ws.nameRow.user_id !== ws.userId) { ws.nameRow = null; ws.reservedName = null; }
    if (ws.nameRow && reservations.ready) {
      const gen = ws.authGen;
      const r = await reservations.rename(ws.nameRow, msg.name);
      // A ROW THAT HAS GONE (swept, or deleted with its account) is forgotten
      // here, and the device's next claim reserves again.
      if (!r.ok && r.error === 'gone') { ws.nameRow = null; ws.reservedName = null; }
      if (!r.ok) return reply(ws, msg, { type: 'callsign', op: 'check', error: r.error === 'gone' ? 'unavailable' : r.error });
      // A hello for somebody else landed while the write was out: the next
      // claim answers for whoever this socket is now.
      if (ws.authGen === gen) { ws.nameRow = r.row; ws.reservedName = r.name; }
      v = { ok: true, name: r.name };
    } else {
      v = typedName(msg.name);
      if (!v.ok) return reply(ws, msg, { type: 'callsign', op: 'check', error: v.error });
    }
    reply(ws, msg, { type: 'callsign', op: 'check', ok: true, name: v.name });
    const key = squadGuest(ws) ? squads.keyOfSocket(ws) : null;
    const own = key == null ? null : squads.memberOf(key);
    if (!own || !own.member.guest || own.member.ws !== ws || own.member.name === v.name) return;
    own.member.name = v.name;
    await pushSquad(own.squad, null, null).catch(() => {});
  }

  // ---- the name claim (round 3, 2026-10-10: item 28) -------------------------
  // THE PLAYER'S ONE NAME, held by the server (server/reservations.js says
  // how). The client sends this after every hello with the name it has and
  // the secret its device was given, and the answer is the name the server
  // holds for this player from now on: the socket carries it (ws.reservedName),
  // the room engine seats it whatever name a frame carries (room-engine.js
  // allowedOf), and the squad row shows it. `secret` is on the answer only
  // when a new one was issued for this device. `moved` is there only when the
  // name the device had could not be the player's ('taken' by another player
  // first, or 'refused' by the guidelines) and a default stands in for it: the
  // client tells the player once. `chosen` marks a signed-in account's chosen
  // callsign, which is its name and needs no row, and `linked` an answer that
  // belongs to a linked account rather than to this device.
  //
  // A FAILED CLAIM ('unavailable': no table yet, a store fault, an index that
  // has not loaded, a bound on new rows; 'slow_down') leaves the socket's name
  // as it was, and the client asks again, backing off, on this connection and
  // the next (app.js claimLater). Until a claim is answered the player is
  // still seated under their own name whenever nobody else holds it (round 3
  // fix, 2026-10-10): a name nobody has reserved is free at the door by the
  // old rules, and a name this process has seen this holder hold is vouched
  // for (reservations.vouch) and carried on the socket, so a store fault
  // cannot seat a player under a stand-in for their own reserved name.
  //
  // A CLAIM MADE AS AN ACCOUNT IS NEVER ANSWERED AS A DEVICE. The client marks
  // a claim `account` when it sent the hello ahead of it; when that hello did
  // not make this socket the account (GoTrue refused or did not answer), the
  // claim would otherwise be answered for the device's secret, with the
  // account's name presented as the device's own: a new row, or the account's
  // own name refused 'taken'. It is answered 'unavailable' instead, and the
  // client asks again.
  async function claimName(ws, msg) {
    if (!rateOk(ws, 'name', LIMITS.name)) return reply(ws, msg, { type: 'name', error: 'slow_down' });
    if (msg.account === true && !ws.userId) return reply(ws, msg, { type: 'name', error: 'unavailable' });
    const gen = ws.authGen;
    const linked = !!(ws.userId && !ws.isGuest);
    const secret = typeof msg.secret === 'string' ? msg.secret : null;
    let r;
    try {
      r = await reservations.claim({
        userId: ws.userId || null, linked,
        chosen: linked && typeof ws.chosenName === 'string' ? ws.chosenName : null,
        secret,
        name: typeof msg.name === 'string' ? msg.name : '',
        fresh: msg.fresh === true,
        mayInsert: (ws.nameRowsMade || 0) < ROWS_PER_SOCKET,
        // THE FAIRNESS LAYERS (round 3 fix, 2026-10-10; server/reservations.js
        // says why). A socket has said hello when it is an account (only a
        // hello makes one) or when server.js saw a hello frame on it; its
        // address key is the one server.js took from the connection.
        helloed: !!ws.userId || ws.saidHello === true,
        addr: typeof ws.clientAddr === 'string' && ws.clientAddr ? ws.clientAddr : null,
      });
    } catch { r = null; }
    // A HELLO LANDED WHILE THE CLAIM WAS OUT: the answer is for an account this
    // socket no longer is, so it is not kept and not sent. The client claims
    // again after every hello.
    if (ws.authGen !== gen) return reply(ws, msg, { type: 'name', error: 'unavailable' });
    if (!r || !r.ok) {
      let held = null;
      if (!ws.reservedName) {
        try { held = typeof reservations.vouch === 'function' ? reservations.vouch({ userId: ws.userId || null, secret }) : null; } catch { held = null; }
        // Carried without its row: a rename waits for a claim that answers.
        if (typeof held === 'string' && held) { ws.reservedName = held; ws.nameRow = null; } else held = null;
      }
      reply(ws, msg, { type: 'name', error: r && r.error === 'slow_down' ? 'slow_down' : 'unavailable' });
      // The squad row shows the name the socket now carries.
      const own = held ? squadOf(ws) : null;
      if (own) await pushSquad(own.squad, null, null).catch(() => {});
      return;
    }
    // Every new row this connection makes counts against ROWS_PER_SOCKET.
    if (r.made) ws.nameRowsMade = (ws.nameRowsMade || 0) + 1;
    const was = ws.reservedName || null;
    ws.reservedName = r.chosen ? null : r.name;
    ws.nameRow = r.row || null;
    const frame = { type: 'name', ok: true, name: r.name };
    if (r.secret) frame.secret = r.secret;
    if (r.moved) frame.moved = r.moved;
    if (r.chosen) frame.chosen = true;
    else if (linked) frame.linked = true;
    reply(ws, msg, frame);
    // The squad row shows the reserved name (squadSnapshot), so a claim that
    // named this socket differently tells the squad. A failed push costs only
    // the cosmetic update, which the next push carries.
    if (was !== ws.reservedName) {
      const own = squadOf(ws);
      if (own) await pushSquad(own.squad, null, null).catch(() => {});
    }
  }

  // ---- ONE SOCIAL FRAME AT A TIME, PER SOCKET -------------------------------
  // EVERY OP IN THIS LAYER IS A READ THEN A WRITE WITH NO TRANSACTION, and until
  // this chain existed nothing made a frame wait for the one in front of it. The
  // once-a-day report rule was the visible casualty: five `report` frames
  // arriving in one tick all passed reportedSince() before the first row landed,
  // so five rows were written for the same pair on the same day. The callsign
  // branch above states the standard this layer is held to — THE WRITE IS THE
  // AUTHORITY, not a read before it — and name_reports has no unique index to be
  // that authority. A partial unique index would be the textbook answer and is a
  // second migration against a live database; restoring the ORDERING costs one
  // promise chain and closes this race and every other read-then-write race on
  // the same socket at once.
  //
  // A REJECTION CANNOT BREAK THE CHAIN, two ways. The next frame is scheduled on
  // BOTH settlements of the one in front of it (`then(run, run)`), so a link that
  // rejects still releases the queue; and what is STORED is the settled promise,
  // never the one handed to the caller, so nothing here leaves an unhandled
  // rejection behind. The caller still receives the original promise and
  // server.js still reports a throw through reportServerError.
  //
  // A SLOW FRAME CANNOT WEDGE THE SOCKET FOR EVER. Every store call goes out
  // through server.js's sbAdmin, which carries AbortSignal.timeout(8000)
  // (RISK-014), so the longest a link can hold is that frame's store calls timing
  // out one after another — a block's five is the worst case — and then it
  // settles and the queue drains. The wait is per SOCKET: another player has
  // their own chain, this socket's GAME frames never enter this layer at all, and
  // the chain is a property of the ws object that is dropped with it on close.
  function handle(ws, msg) {
    const run = () => handleOne(ws, msg);
    const prev = (ws && ws._socialQueue) || Promise.resolve();
    const mine = prev.then(run, run);
    if (ws) ws._socialQueue = mine.catch(() => {});
    return mine;
  }

  async function handleOne(ws, msg) {
    try {
      switch (msg.type) {
        case 'callsign':
          // The name check comes BEFORE the gate: it is the one callsign op
          // a guest is entitled to (see checkName). Everything else on this
          // type — set, and an old build's roll — still needs a linked account.
          if (msg.op === 'check') { await checkName(ws, msg); return; }
          if (!requireLinked(ws, msg)) return;
          // AWAIT, not `return callsign(...)`. Returning the promise from
          // inside a try hands the rejection to the CALLER: the catch below
          // never runs, the client never gets a reply, and the whole net under
          // this function is decoration. Every await in here is deliberate.
          await callsign(ws, msg);
          return;
        case 'name':
          // NO GATE: every player holds a name, a guest with no account at all
          // included (round 3). The claim waits for the socket's hello like
          // every other social frame (server.js), so it answers for the
          // account the socket is.
          await claimName(ws, msg);
          return;
        case 'friends':
          if (!requireLinked(ws, msg)) return;
          // AWAIT, for the same reason the callsign branch above does: returning
          // the promise hands its rejection to the caller and the net below
          // never runs. handleFriends deliberately has no catch of its own — a
          // failed snapshot must answer { type:'friends', error:'unavailable' }
          // and that is exactly what the net produces.
          await handleFriends(ws, msg);
          return;
        case 'friend':
          if (!requireLinked(ws, msg)) return;
          await handleFriend(ws, msg);
          return;
        case 'block':
          // Open to a guest on purpose — see requireAccount above.
          if (!requireAccount(ws, msg)) return;
          // AWAIT, not `return handleBlock(...)`. Returning the promise from
          // inside a try hands its rejection to the CALLER: the net below never
          // runs, the client never gets a reply, and in this server the
          // rejection reaches reportServerError instead. Every await in here is
          // deliberate.
          await handleBlock(ws, msg);
          return;
        case 'report':
          if (!requireAccount(ws, msg)) return;
          await handleReport(ws, msg);
          return;
        case 'squad':
          // NO GATE ON THIS LINE. R3: the gate is per op and lives inside the
          // handler, because `join` by code is open to a guest and the rest
          // are not. requireLinked here would refuse the one op a guest is
          // entitled to.
          await handleSquad(ws, msg);
          return;
        default:
          // Unreachable while server.js gates on SOCIAL_TYPES, and answered
          // anyway: same reasoning as above, answer, never drop.
          return reply(ws, msg, { type: msg.type, error: 'unavailable' });
      }
    } catch {
      // THE NET. Any throw from this layer — a store failure, a PostgREST
      // timeout, a misconfigured blocklist — becomes one honest error code.
      // Without it the rejection reaches server.js's reportServerError and the
      // client is left waiting for a reply that is never coming.
      try { reply(ws, msg, { type: msg.type, error: 'unavailable' }); } catch {}
    }
  }

  // ---- presence (design 4.1) -------------------------------------------------
  // Memory only. A userId is online while at least one of its sockets is live;
  // nothing about presence is ever written to or read from the database.
  //
  // The window is read PER INSTANCE rather than at module load, so a suite can
  // shorten it immediately before it builds its social layer even though this
  // module was imported long before. That is the house pattern for a test-only
  // time knob — GOLF_HOLD_MS, RESUME_GRACE_MS, PICK_MS and BOT_FIRE_MS all work
  // this way. Two seconds in production (design 4.2).
  const envPresence = Number(process.env.SOCIAL_PRESENCE_MS);
  const PRESENCE_MS = Number.isFinite(envPresence) && envPresence >= 0 ? envPresence : 2000;
  const presenceTimers = new Map();   // userId -> Timeout; at most one at a time
  // userId -> the state its friends were last TOLD. BOUNDED THE SAME WAY the
  // online map beside it is: the entry is deleted the moment a flush tells
  // friends this account is OFFLINE, which is the last thing there is to say
  // about it. Left in place it would be one permanent entry per account that has
  // ever come online, for the life of the process — the exact growth dropping
  // the empty Set in dropPresence exists to avoid. Absent therefore means
  // "offline as far as anyone was told", which is what the seed in onAuth
  // writes on first sight, so the two agree and no state is re-sent.
  const presenceLast = new Map();
  // userId -> a counter bumped by EVERY change. Read before the flush's store
  // read and compared after it; see flushPresence.
  const presenceGen = new Map();

  const isOnline = (id) => { const s = online.get(id); return !!(s && s.size); };
  const socketsOf = (id) => { const s = online.get(id); return s ? [...s] : []; };

  // THE DEBOUNCE, PRECISELY, because "debounced 2 s" has three plausible
  // meanings and only one of them is this:
  //
  //   * The FIRST change for a player schedules the ONLY flush. A further change
  //     inside the window neither extends it nor queues a second one — it is
  //     simply not scheduled, because a timer is already pending for that id. So
  //     the frame arrives at most PRESENCE_MS after the FIRST change, never
  //     later, however much flapping happens in between.
  //   * The flush reads the LIVE state when it fires, not the state that
  //     scheduled it, so what friends receive is the state at the END of the
  //     window. A player who drops and reconnects inside it is never reported
  //     offline; a player who connects and drops inside it is never reported
  //     online.
  //   * If that final state is what the friends were last TOLD, nothing is sent
  //     at all. That is the ordinary case for a phone changing network.
  //
  // unref(): a pending flush must never hold the process open. With a two second
  // window there is nearly always one in flight, and test/run-all.sh waits for
  // this file's child process to exit.
  function presenceChanged(id) {
    if (!id) return;
    // BUMPED ON EVERY CHANGE, including the ones that schedule no timer. This is
    // what a flush already in flight compares itself against.
    presenceGen.set(id, (presenceGen.get(id) || 0) + 1);
    if (presenceTimers.has(id)) return;
    const t = setTimeout(() => {
      presenceTimers.delete(id);
      flushPresence(id).catch(() => {});
    }, PRESENCE_MS);
    if (typeof t.unref === 'function') t.unref();
    presenceTimers.set(id, t);
  }

  async function flushPresence(id) {
    // THE TIMER HANDLE IS CLEARED BEFORE THIS RUNS, so a change arriving while
    // the reads below are in flight schedules a SECOND flush — two flushes for
    // one player, interleaved, with the older one free to finish last and latch
    // a wrong dot until that player's next change. The generation is read here
    // and compared after the await: if it moved, a newer flush is already
    // scheduled and owns the answer, so this one says nothing at all.
    const gen = presenceGen.get(id);
    const state = isOnline(id);
    if (presenceLast.get(id) === state) return;
    let ids, blocks;
    // A store fault costs one presence dot and nothing else. Recording the state
    // as delivered only AFTER the read succeeds is what makes the next change
    // try again rather than skip.
    try {
      // BLOCKS ARE READ HERE, not assumed away. This fan-out reads the
      // friendship table, and a block written without deleting the friendship —
      // which is one forgotten line in Task 6 — turns it into a live session
      // signal about somebody who blocked you, symmetrically, in both
      // directions. One store method (two GETs) per flush, and a flush is
      // debounced to at most one per player per window, so the guarantee is a
      // property of THIS function rather than of another task remembering.
      [ids, blocks] = await Promise.all([store.friendIdsOf(id), store.blockIdsOf(id)]);
    } catch { return; }
    if (presenceGen.get(id) !== gen) return;
    // Offline is the LAST thing there is to say about an account, so both entries
    // go rather than sitting in their maps for ever. Absent reads as offline,
    // which is exactly what onAuth seeds on first sight.
    if (state) presenceLast.set(id, state);
    else { presenceLast.delete(id); presenceGen.delete(id); }
    const hidden = new Set([...blocks.blocked, ...blocks.blockedBy]);
    const frame = { type: 'presence', id, online: state };
    // FRIENDS ONLY, and the list comes from the friendship table rather than
    // from the online map: presence is the one frame in this layer that goes to
    // someone who did not ask for it, so who receives it is the whole guarantee.
    for (const fid of ids) {
      if (hidden.has(fid)) continue;
      for (const w of socketsOf(fid)) safeSend(w, frame);
    }
  }

  // ---- names that came out of the database -----------------------------------
  // BUILT HERE, DEFINED IN server/display-name.js. The five helpers that used to
  // sit in this spot — provenName, presentable, rolledName, displayName and
  // seenName — moved there whole, comments and all, when a second caller had to
  // prove an opponent's name the same way these panels prove a friend's. That
  // caller was removed on 2026-09-30 and they stay there: the rule is a security
  // rule with its own suite against the shipped blocklist. Everything those
  // comments record is still binding: the OWN-callsign narrowness of provenName
  // (resolution 13), what a block does and does not promise (resolution 25), and
  // why seenName skips the blocklist pass that displayName applies (resolution
  // 26).
  //
  // `terms` is this layer's own injected blocklist, and it is now the only list
  // this factory is ever built with — one file, one rule, one term list.
  // checkPlayerName is the GUIDELINES rather than a proof: the check op below
  // asks it about a name a player typed, and server.js installs its yes-or-no
  // twin (playerName) as the room engine's name check, built from the same
  // file's list — so a name this layer says may be kept is a name a lobby will
  // show.
  //
  // keyState is the injected index (`names`, above), asked through a guard so a
  // malformed one counts as knowing nothing: 'unknown' refuses a typed name.
  //
  // AND EVERY RESERVED NAME (round 3). A typed name another player has
  // reserved is 'taken' exactly as a chosen callsign is, so the guest's check
  // op and a guest's squad seat refuse it as the door does. With no table the
  // reservations answer 'free' and the rule is the round 2 one.
  const keyState = (key) => {
    const chosen = names && typeof names.state === 'function' ? names.state(key) : 'unknown';
    let held = 'unknown';
    try { held = reservations.state(key); } catch { held = 'unknown'; }
    return combineStates(chosen, held);
  };
  const { provenName, rolledName, displayName, seenName, checkPlayerName, typedName, guestName, seatName: seatShown } = createNameProofs({ terms, keyState });

  // A LINKED ACCOUNT IS NAMED BY ITS RESERVATION ON EVERY LIST (round 3 fix,
  // 2026-10-10; the owner's item 27: the player's name "accurately displayed
  // across the whole game", friends, search and invites named). An account
  // with no chosen callsign plays under the name the server reserved for it
  // (server/reservations.js), and its profile's own copy of a name says
  // something else: the rolled pair it had before a move, which another player
  // may hold now, or nothing displayName can vouch for at all (a typed or a
  // numbered name is no rolled pair), which a friend's panel showed as
  // 'No callsign'. So a list names each account the way its squad row does
  // (linkedRowName): its chosen callsign when it has one, else its reserved
  // name while that still meets the guidelines (the blocklist pass every name
  // shown here gets), else what the profile proves, as before.
  //
  // ONE READ FOR THE WHOLE LIST, and none when no account on it lacks a chosen
  // callsign, or while the reservations are off (no table yet). A failed read
  // costs the names only, never the list: every account is then named as it
  // was before this existed.
  async function listNames(ids, profiles) {
    const need = ids.filter((id) => provenName(profiles.get(id)) === null);
    let held = new Map();
    if (need.length && reservations.ready === true && typeof store.reservedNamesOf === 'function') {
      try { held = await store.reservedNamesOf(need); } catch { held = new Map(); }
    }
    return (id) => {
      const p = profiles.get(id);
      if (provenName(p) !== null) return displayName(p);
      const n = held instanceof Map ? held.get(String(id).toLowerCase()) : undefined;
      const v = typeof n === 'string' && n ? checkPlayerName(n) : null;
      return v && v.ok ? v.name : displayName(p);
    };
  }
  // THE INVITER'S OWN NAME on an invite card and its push: their chosen
  // callsign when they have one, else the name their socket's claim was
  // answered (ws.reservedName), the name every match seats them under. Read
  // from memory, so an invite costs the reads it always has: a read here would
  // be one more on a delivered invite than on a dropped one, and the two must
  // cost the same (D-BLOCK-2 E).
  const inviterName = (ws, self) => {
    if (provenName(self) !== null) return displayName(self);
    const n = ws && typeof ws.reservedName === 'string' ? ws.reservedName : '';
    const v = n ? checkPlayerName(n) : null;
    return v && v.ok ? v.name : displayName(self);
  };
  // The index's two hooks, called when a callsign_key write lands. A host with
  // no index (or a malformed one) has nothing to keep current.
  const keyAdded = (key) => { if (key && names && typeof names.add === 'function') names.add(key); };
  const keyRemoved = (key) => { if (key && names && typeof names.remove === 'function') names.remove(key); };

  // ---- squads (design 4.3) -------------------------------------------------
  // THE STATE MACHINE IS server/squads.js AND IT KNOWS NOTHING ABOUT SOCKETS.
  // What lives here is everything that needs this closure: the per-socket
  // queue that serialises a read-then-write, the rate bucket, the sign-in
  // gate, and displayName — because a member row is A NAME ON ANOTHER
  // PLAYER'S SCREEN, and profiles.callsign is PATCHed by the account itself
  // on every cloud save (BINDING resolution 27).
  //
  // One factory, held, never re-created per frame — createNameProofs above is
  // built the same way and for the same reason. codeTaken is the squad half of
  // ONE CODE NAMESPACE (plan R4): the engine refuses a code a squad holds
  // (server.js hands it hasSquad), and the squad minter refuses a code a live
  // room holds, through the roomExists server.js injects. Both directions are
  // proved against the real server.js by test/code_frame.mjs.
  //
  // THE SQUAD CAP IS ONE NUMBER FOR TWO RULES: the machine's join refuses the
  // fifth member at it, and an invite refuses to reach a player the squad
  // could not take. It is HANDED to the machine as its capacity rather than
  // restated beside the machine's own default, so the two cannot drift: an
  // invite cap above the join cap sends invites nobody can accept, and one
  // below it refuses invites to a squad with room. The invited frame carries
  // it as `max` (design 4.3: "size, max:4").
  const SQUAD_MAX = 4;
  const squads = createSquads({ now, capacity: SQUAD_MAX, codeTaken: roomExists });

  // THE RECENT-BLOCKS LOG (D-BLOCK-3 G). A block read is a snapshot, and a
  // block row can land while one is out: the blocker's teardown then finds
  // nothing to remove, because the joiner is not in the squad yet, and a
  // join that trusted its snapshot would seat the pair together a moment
  // later. So handleBlock logs every pair in the turn addBlock's answer
  // arrives, whatever that answer is. A reader notes the log's next seq
  // before its read and afterwards adds every pair logged since then that
  // NAMES ITS OWN ACCOUNT: a block between two other players changes
  // nobody's answer. A block asked after that is caught by its own
  // teardown, which then finds the row.
  //
  // KEPT BLOCK_LOG_MS, twice the store's 8 s request timeout, so a read
  // outlives no entry it needs, and never more than BLOCK_LOG_MAX entries.
  // A reader whose entries were dropped while it was out reads once more;
  // a second miss is null, and its caller fails as on a failed read.
  const BLOCK_LOG_MS = 16000;
  const BLOCK_LOG_MAX = 4096;
  const blockLog = [];
  let blockSeq = 0;       // the seq the next entry gets
  let blockFloor = 0;     // every entry below it has been dropped
  function logBlock(blocker, blocked) {
    const t = now();
    blockLog.push({ seq: blockSeq++, at: t, blocker: wireId(blocker), blocked: wireId(blocked) });
    while (blockLog.length > BLOCK_LOG_MAX || blockLog[0].at < t - BLOCK_LOG_MS) blockFloor = blockLog.shift().seq + 1;
  }
  // AND THE PAIRS BEING WRITTEN (T6-R1-2). handleBlock parts the pair the
  // moment it ASKS for the row, not when the answer comes back, and a read
  // that starts while the row is being written can come back without it.
  // So each asked pair stands here from the ask until its answer is in and
  // the pair is logged, and every reader adds the pairs here that name its
  // account, at the moment its read returns. A pair whose log (or note,
  // below) threw stays here: apart for the life of the process is the safe
  // way round, and the injected clock is the only thing there that can throw.
  const blockPending = new Set();
  // AND THE PAIRS WHOSE addBlock THREW (D-BLOCK-5 K). A write that answered
  // with a failure may still commit AFTER its answer, when the log serves no
  // read that starts then. So for BLOCK_LOG_MS after that answer every
  // reader the pair names counts it as blocked, whenever its read began.
  //
  // ONLY A FAILURE THAT MAY STILL COMMIT IS KEPT (T6-R1-1): a timeout, a
  // network error, a 5xx, a 408. A REFUSAL (isRefusal: PostgREST's 4xx) rolled
  // back and never lands, and a client can repeat one at will: a socket whose
  // account was deleted after its hello is refused on the foreign key for
  // every block it asks for.
  //
  // AND IT IS KEPT SO THAT NOBODY'S FAILURES MOVE ANYONE ELSE. One entry per
  // pair: a repeat renews its BLOCK_LOG_MS (never shortens it, if the clock
  // steps back). One account keeps at most THROWN_EACH pairs, and the set at
  // most BLOCK_LOG_MAX. A failure with no room keeps its ACCOUNT instead, in
  // thrownAll, for BLOCK_LOG_MS: that account may have blocked anybody, so
  // its own reads fail safe (null), and it counts as blocking every other
  // reader: nobody joins a squad it stands in, a row there whose socket
  // signs in is removed as the door removes a blocked one, and an invite
  // out of that squad is dropped. Nothing moves elsewhere. Only an account
  // that finds thrownAll full too (BLOCK_LOG_MAX accounts failing inside
  // 16 s: a store outage, not one client) makes every reader fail safe,
  // until its failure would have expired. Expired entries go as each
  // failure is written.
  const THROWN_EACH = 64;
  const KEPT = false;             // withLanded's answer for a reader kept whole (below)
  const blockThrown = new Map();  // 'blocker>blocked' -> { blocker, blocked, until }
  const thrownBy = new Map();     // blocker -> how many pairs of blockThrown are its
  const thrownAll = new Map();    // blocker -> until: an account kept whole
  let thrownFloor = 0;            // every reader is answered null up to this time
  // A Map iterates in insertion order and a renewed entry is re-inserted, so
  // the expired ones are at the front (a clock that steps back can leave one
  // behind a later one: it goes when that one does, and never early).
  function noteThrown(blocker, blocked) {
    const t = now(), until = t + BLOCK_LOG_MS;
    const who = wireId(blocker), pair = who + '>' + wireId(blocked);
    for (const [k, e] of blockThrown) {
      if (e.until >= t) break;
      blockThrown.delete(k);
      const n = thrownBy.get(e.blocker) - 1;
      if (n > 0) thrownBy.set(e.blocker, n); else thrownBy.delete(e.blocker);
    }
    for (const [k, u] of thrownAll) { if (u >= t) break; thrownAll.delete(k); }
    const kept = blockThrown.get(pair);
    if (kept) { blockThrown.delete(pair); kept.until = Math.max(kept.until, until); blockThrown.set(pair, kept); return; }
    if (thrownAll.has(who)) { const u = Math.max(thrownAll.get(who), until); thrownAll.delete(who); thrownAll.set(who, u); return; }
    const mine = thrownBy.get(who) || 0;
    if (mine < THROWN_EACH && blockThrown.size < BLOCK_LOG_MAX) {
      blockThrown.set(pair, { blocker: who, blocked: wireId(blocked), until });
      thrownBy.set(who, mine + 1);
    } else if (thrownAll.size < BLOCK_LOG_MAX) thrownAll.set(who, until);
    else thrownFloor = Math.max(thrownFloor, until);
  }
  // `b`, the store's answer for `id`, plus every pair logged from `from` on,
  // every pair being written and every unexpired thrown pair that names
  // `id`; and, apart, in `doubt`, every other account kept whole.
  //
  // TWO FAILURES, TOLD APART (D-BLOCK-6 O). null: some of the logged entries
  // have been dropped while the read was out, and one more read can finish
  // the job (landedBlocks makes it). KEPT: `id` is itself an account kept
  // whole, or every reader fails safe; nothing a second read could find
  // changes that, so it is not asked. Both are falsy, and every reader fails
  // on either exactly as it did on null.
  //
  // DOUBT IS NOT A BLOCK (D-BLOCK-6 M). An account kept whole MAY have
  // blocked anybody, and that is all anyone knows. Join and invite treat it
  // as blocked, as before; the sign-in door treats it as a failed read (the
  // row fails to guest and stays out of Start), never as a kick: a kick
  // there would remove a player nobody blocked.
  function withLanded(b, id, from) {
    if (blockFloor > from) return null;
    const out = { blocked: [...b.blocked], blockedBy: [...b.blockedBy], doubt: [] };
    for (const e of blockLog) {
      if (e.seq < from) continue;
      if (e.blocker === id) out.blocked.push(e.blocked);
      if (e.blocked === id) out.blockedBy.push(e.blocker);
    }
    for (const e of blockPending) {
      if (e.blocker === id) out.blocked.push(e.blocked);
      if (e.blocked === id) out.blockedBy.push(e.blocker);
    }
    if (blockThrown.size || thrownAll.size) {
      const t = now();
      if (thrownFloor >= t) return KEPT;
      for (const [who, u] of thrownAll) {
        if (u < t) continue;
        if (who === id) return KEPT;
        out.doubt.push(who);
      }
      for (const e of blockThrown.values()) {
        if (e.until < t) continue;
        if (e.blocker === id) out.blocked.push(e.blocked);
        if (e.blocked === id) out.blockedBy.push(e.blocker);
      }
    }
    return out;
  }
  async function readLanded(id) {
    const from = blockSeq;
    return withLanded(await store.blockIdsOf(id), id, from);
  }
  // One more read ONLY for dropped log entries (null), never for KEPT.
  const landedBlocks = async (id) => { const r = await readLanded(id); return r === null ? readLanded(id) : r; };

  // op -> handler. A NULL PROTOTYPE, and that is not decoration: `op` comes
  // off the wire, and with a plain object literal SQUAD_OPS['constructor'] is
  // `Object` — truthy — so the `!fn` test below would wave it through and
  // `await fn(ws, msg)` would call Object(ws, msg), return quietly and send
  // NOTHING. The client's waiter then sits for its full twelve seconds.
  // (FRIEND_OPS below is a plain literal and has exactly that hole today;
  // closing it belongs with the friend ops and is not this task's, but the
  // new table must not repeat it.)
  //
  // FILLED BY ASSIGNMENT, ONE LINE PER OP, and never redeclared as a literal:
  // a literal would bring the prototype back. Task 2 registers create, join,
  // leave and kick at the end of this section; invite, ready, mode, start and
  // resume are registered the same way by the tasks that write them.
  const SQUAD_OPS = Object.create(null);

  // THE PER-OP SIGN-IN GATE (R3). Squads are the first type whose ops do not
  // share one: `join` and `leave` are open to a guest — a code is how a friend
  // brings somebody in (D5), and a guest who can join must be able to get out
  // — and `create` and `kick` need an account that survives a reinstall,
  // because a squad is led by one (a guest can never lead; see
  // server/squads.js). requireLinked is REUSED rather than restated, so there
  // is one sign-in rule in this file and one piece of copy for it. A later op
  // that needs an account is added here.
  //
  // `invite` (task 6): an invite goes to a FRIEND, and a guest has none — the
  // spec's own words are that a guest "cannot be invited, cannot invite". The
  // gate refuses a guest before the friend bucket, the store or the push
  // seam is touched.
  const SQUAD_LINKED = new Set(['create', 'invite', 'kick']);

  // An error is sent only by its op's name for it (SQUAD_ERRORS); the key
  // keeps its place in the frame when it is renamed.
  const squadReply = (ws, msg, op, rest) => reply(ws, msg, {
    type: 'squad', op, ...rest, ...(rest && typeof rest.error === 'string' ? { error: squadError(op, rest.error) } : {}),
  });

  async function handleSquad(ws, msg) {
    // A SOCKET THAT HAS CLOSED ACTS ON NOTHING (task 5). A frame can wait on
    // this socket's queue, or on its hello, past the socket's own close — and
    // the close has already dropped the row it held. A join or resume run
    // after it would put the DEAD socket on a row with no drop stamped: a
    // member no window ever sweeps, holding a seat's socket nothing can
    // answer. There is nobody to reply to either: send() delivers nothing to
    // a socket that is not open.
    if (!ws || ws.readyState !== 1) return;
    const op = typeof msg.op === 'string' ? msg.op : '';
    const fn = SQUAD_OPS[op];
    // THE RATE CHECK BEFORE ANY ANSWER, INCLUDING FOR AN OP THAT DOES NOT
    // EXIST, for handleFriend's reason: an unknown op costs no store read but
    // it does cost a reply, and a path that answers without spending is free.
    if (!rateOk(ws, 'squad', LIMITS.squad)) return squadReply(ws, msg, op || 'unknown', { error: 'slow_down' });
    // Answered rather than dropped, and answered the way an unknown block op
    // is: the reply carries the OP, because a client with two squad answers
    // outstanding cannot tell which one failed from { type:'squad',
    // error:'unavailable' } alone.
    //
    // NO GATE ON THIS PATH. An op that does not exist has no gate to apply,
    // and answering 'sign_in' to a guest for an op that is not there would
    // advertise ops this build does not have.
    if (!fn) return squadReply(ws, msg, op || 'unknown', { error: 'unavailable' });
    if (SQUAD_LINKED.has(op) && !requireLinked(ws, msg)) return;
    // A catch of its own BESIDE handle()'s net, for handleFriend's reason:
    // this reply carries the OP, and handle()'s net would answer
    // { type:'squad', error } with none.
    try { await fn(ws, msg); }
    catch { squadReply(ws, msg, op, { error: 'unavailable' }); }
  }

  // WHO IS ON THIS SOCKET NOW. A signed-in member is their account id; a
  // GUEST is their socket. A guest cannot be the former and must not be: an
  // ANONYMOUS account id is an identity this feature must never spend, the
  // snapshot says `id: null` for a guest, and this keeps that true all the
  // way down. A socket is also the one key no client can forge. The rule is
  // requireLinked's, so what the gate calls a guest is what the machine does.
  //
  // identityKey IS WHO, NOT WHERE. It is the key a NEW row for this socket
  // would carry, and the account a leadership check must match — it is NOT
  // how to find the row this socket already holds. For that, squadKey below.
  const squadGuest = (ws) => !(ws && ws.userId && !ws.isGuest);
  const identityKey = (ws) => (squadGuest(ws) ? ws : wireId(ws.userId));
  const squadMemberOf = (ws, msg) => ({
    userId: squadGuest(ws) ? null : wireId(ws.userId),
    guest: squadGuest(ws),
    // Kept for the seating path, which hands it to the engine's door. A guest
    // row's seat SHOWS what that door would (guestName, see squadSnapshot);
    // a signed-in member's shows the proved profile name, and this only when
    // nothing the account holds can be shown (boxNames: what the door seats).
    name: typeof msg.name === 'string' ? msg.name : '',
    skin: skinOf(msg),
    ws,
  });

  // squadKey IS WHERE: THE ROW THIS SOCKET HOLDS, and its identity only when
  // it holds none — a second device of a member, or a fresh socket
  // reconnecting. THIS is the key to reach for to find the caller's row, in
  // this task and every later one (ready, mode, start, resume, the drop
  // window), which is why it has the familiar name.
  //
  // The two differ in ordinary use. The client re-sends `hello` over the
  // live socket after a sign-in, so a guest who signs in mid-squad is an
  // account (identityKey) on a socket that still holds a GUEST row keyed by
  // itself (squadKey). Finding the row by identity is what stranded that
  // guest: leave answered `left` while the row stayed, and create made the
  // socket lead a new squad while still a member of the old. The reverse is
  // a socket that signed out and still holds its account's row. Socket first
  // is youIn's rule below as well, so the file has one answer to "which row
  // is this caller".
  const squadKey = (ws) => squads.keyOfSocket(ws) || identityKey(ws);
  // Every squad the caller could be in before a move — BOTH keys, on
  // purpose: the squad its socket's row is in (`from`, a squadKey), and the
  // squad its current identity is in, which may be another device's and
  // which create and join also leave (one squad per player).
  const squadsOfCaller = (ws, from) => [...new Set([squads.ofUser(from), squads.ofUser(identityKey(ws))])].filter(Boolean);

  // THE SQUAD THIS SOCKET VALIDLY LEADS, or null. EVERY LEADER-ONLY OP CALLS
  // THIS — kick, mode, and every later one (start...) — and none re-derives
  // the rule inline. Invite is NOT one: design 4.3 lets a leader or a member
  // invite (see squadInvite).
  //
  // LEADERSHIP IS AN ACCOUNT'S, SO BOTH HALVES MUST BE THE LEADER: the row
  // this socket holds (squadKey) and the account signed in on it
  // (identityKey). Either half alone is exploitable. The row alone would let
  // a socket that signed out of the leader's account and into another keep
  // commanding the squad. The account alone would let a socket that holds a
  // GUEST row in one squad command ANOTHER squad its account leads from a
  // second device — acting on a squad its own screen is not showing, with an
  // index read off the one it is. A second device of the leader that holds
  // no row passes both, because squadKey is then its identity.
  function ledSquad(ws) {
    const me = squadKey(ws);
    const sq = squads.ofUser(me);
    return sq && sq.leader === me && identityKey(ws) === me ? sq : null;
  }

  // `you`: which row of this squad THIS SOCKET is, or -1 when it is none. The
  // socket first — the ordinary case, and the only one for a guest, whose key
  // IS a socket — then squadKey, which for a socket holding no row is its
  // identity, so a second device of a signed-in member (whose row still holds
  // the first device) is shown its own row. squadKey and not identityKey: a
  // socket whose row is in ANOTHER squad is no row of this one, and must not
  // be shown some other device's row as its own.
  function youIn(sq, ws) {
    const i = sq.members.findIndex((m) => m.ws === ws);
    if (i >= 0) return i;
    const key = squadKey(ws);
    return sq.members.findIndex((m) => m.key === key);
  }

  // `held` (D-UI-1): whether THIS SOCKET is the one on a row of this squad.
  // `you` cannot say it: for a socket holding no row it falls back to the
  // account's row, so a second device that only LOOKED (a bare resume while a
  // live socket elsewhere holds the row, task 5) and the device on the row are
  // told the same index. Only the device on the row is pushed a change, so a
  // box told held:false shows "open on another device" (and no controls)
  // rather than a roster that no push will ever update.
  // THE SOCKET, NEVER THE KEY: the key is the account's, and would say true to
  // every device of it. Per destination, like `you`, on every state frame.
  const holds = (sq, ws) => sq.members.some((m) => m.ws === ws);

  // WHICH MODES A SQUAD OF n FITS: n within the mode's seats, MINIMUM AND
  // MAXIMUM (plan X6; design 4.3's start row), over the injected table. A
  // squad of one fits no duel and no free-for-all, and three or four fit no
  // co-op raid. Computed here so the box, the boards and the start gate read
  // one truth, and walked in the table's own key order, which is the spec's
  // seat line. THE WHOLE ROSTER COUNTS, dropped members included: they hold
  // their place for the drop window (task 5), and a squad must not be told it
  // fits a mode it stops fitting the moment they come back.
  const fitsFor = (n) => {
    const f = {};
    for (const id of Object.keys(seats)) f[id] = n >= seats[id].min && n <= seats[id].max;
    return f;
  };

  // A ROW'S OWN HANDLE, `rid` (D-UI-3). A kick has to name ONE ROW, and
  // nothing else in the frame can: an index names whoever stands at that
  // place when the frame lands — somebody else, once an earlier row has
  // left — and a guest's `id` is null by the frame's own rule. So every row
  // carries a handle of its own, and squadTarget takes nothing else.
  //
  // MINTED THE FIRST TIME THE ROW IS SHOWN OR AIMED AT, KEPT WHILE IT STANDS.
  // The key is the row OBJECT, in a WeakMap: the machine never replaces a
  // row it keeps — a Ready, a drop and a resume write fields on it, and a
  // guest row adopted at sign-in (squads.adoptGuest) is the same object
  // under a new key — so each of those keeps its handle, and a row that has
  // gone takes its entry with it. Nothing is added to the machine's shape,
  // and no seat path ever sees it.
  //
  // NEVER GIVEN TO ANOTHER ROW, BY CONSTRUCTION RATHER THAN BY LUCK. Each
  // handle is this process's next count run through AES-128 under a key
  // minted at start-up. A block cipher is a permutation, so two counts can
  // never give one handle — in this squad or any other, for the life of the
  // process — and without the key the output is indistinguishable from
  // random bytes: it says nothing about who joined when, how many rows the
  // server has made, or whose row it is. It is never an account id.
  const RID_KEY = randomBytes(16);
  const rids = new WeakMap();
  let ridCount = 0n;
  function rowRid(m) {
    let r = rids.get(m);
    if (r) return r;
    const block = Buffer.alloc(16);
    block.writeBigUInt64BE((ridCount += 1n), 8);
    const c = createCipheriv('aes-128-ecb', RID_KEY, null);
    c.setAutoPadding(false);
    r = Buffer.concat([c.update(block), c.final()]).toString('hex');
    rids.set(m, r);
    return r;
  }

  // THE FRAME, WITHOUT `you` AND `held` — the fields that differ per
  // destination.
  //
  // A GUEST ROW CARRIES callsign null AND guest true, AND NEVER THE NAME THE
  // GUEST SENT. That string arrived off the wire on a socket with no account
  // behind it and nothing to prove it against; it is exactly what
  // displayName exists to keep off another player's screen. null is also
  // what displayName answers for a name it cannot vouch for, so the box has
  // ONE rule and `guest` chooses the word. It is never the empty string,
  // which would paint a blank row, and a null name never drops the row.
  //
  // `online` and `dropped` are not complements. `online` is PRESENCE — the
  // account has a live socket somewhere — and for a guest, who has none
  // (onAuth returns early for a guest), it is their own socket. `dropped` is
  // this member's squad socket inside the drop window (task 5).
  //
  // ONE profilesByIds FOR THE WHOLE SQUAD, and none at all when every member
  // is a guest. A squad change fans out to four sockets; a per-member lookup
  // would make one leave four round trips. The rows are built AFTER the read,
  // from the roster as it stands then, so a push's frames and their `you`
  // indexes always describe the same roster.
  //
  // A FAILED NAME READ DEGRADES THE NAMES, NEVER THE SQUAD. By the time a
  // snapshot is built the operation has already landed — the join happened,
  // the kick happened — and the names are the one cosmetic part of the frame.
  // Rejecting here once answered the actor 'unavailable' for a join that had
  // succeeded: their screen kept the old squad while the new one carried a
  // member it was never told about, who took a seat and changed `fits`. So a
  // failed read answers every name null — displayName's own answer for a name
  // it cannot vouch for — and keeps every row, the plan's rule for a null
  // name. The next snapshot that can read names shows them.
  // CHANGED (round 3 check fix, 2026-10-10): a row the read could not name is
  // no longer null. It is named as the room engine's door names it, the
  // chosen callsign the account's socket holds first (boxNames, below, EVERY
  // ROW BUT THE SIGN-IN DOOR'S IS NAMED), so a failed read still never fails
  // the operation, and the box still says what the match will seat.
  //
  // A GUEST ROW SHOWS THE GUEST'S NAME (round 2, 2026-10-08), not 'No
  // callsign': the name its create or join frame carried, held to exactly what
  // the engine's door would show for it in a lobby (display-name.js guestName:
  // a rolled pair, or a typed name that passes the guidelines and is no
  // account's chosen callsign). Read when the frame is built, so a key taken
  // since the guest joined takes the name off at the next snapshot.
  // NOT FOR A GUEST ROW WHOSE SOCKET HAS SIGNED IN. That row is the sign-in
  // door's (D-BLOCK-3 F and H): it stays a NAMELESS guest row until the door
  // admits it, and nothing about the account it became may reach a member who
  // might have blocked it. Its guest-time name is withheld as well, so the
  // door's row reads exactly as it always has.
  //
  // A GUEST ROW IS NAMED FOR REPORT AND BLOCK BY ITS ROW HANDLE (round 2
  // fix, 2026-10-08). A guest row's `id` is null by the frame's own rule, so a
  // report or a block names it by `rid` (see rowTarget below), which resolves
  // to the ANONYMOUS account the guest's socket is signed in as.
  // guestRowAccount is that account, read off the row's socket, or, for a row
  // inside its drop window, off the socket it dropped from (droppedAcct,
  // written as the row drops), so a dropped row keeps its report path.
  //
  // A GUEST WITH NO ACCOUNT AT ALL IS NAMED TOO (final audit, 2026-10-09). It
  // used to show no name, on the rule "no player text without a report path",
  // so a new player who joined by code before their first save read
  // 'No callsign' on every screen, their own seat included, and 'a guest' on
  // the Ready line, while the match a moment later showed their name to the
  // same players. The rule still holds, by a different path: Report on such a
  // row records the name the row showed and the row itself (handleReport), and
  // only Block, which needs an account to write against, is not offered.
  // `noacct` tells the menu which rows those are. It is a flag and never an
  // id: like the engine's seat handle (room-engine.js seatHandle), it says
  // only whether a row has SOME account, which is not stable, not comparable
  // across squads and not tied to anything, and it is what keeps a Block
  // button off a row it could never work on.
  //
  // THE SIGN-IN DOOR'S ROW IS STILL NAMELESS. doorRow is a guest row whose
  // socket is a LINKED account the door has not admitted yet, or a dropped
  // row whose socket was one when it dropped (droppedLinked): its guest-time
  // name stays withheld, as the paragraph above says, and it carries no
  // `noacct`, because it does stand for an account.
  //
  // A ROW SHOWS ITS PLAYER'S RESERVED NAME (round 3, 2026-10-10). A player
  // whose socket's claim was answered holds a name on the server
  // (ws.reservedName), and the match the squad starts seats that name
  // (room-engine.js allowedOf), so the row shows it too: a guest's in place of
  // the name its frame carried, and a linked account's when it has no chosen
  // callsign, in place of the rolled pair the profile's own copy of the name
  // says, which the account may PATCH and another player may hold. It is
  // shown only while it still meets the guidelines (checkPlayerName), the
  // blocklist pass displayName gives every name. A row that dropped keeps the
  // name its socket held (droppedReserved), as it keeps its account.
  const droppedAcct = new WeakMap();
  const droppedLinked = new WeakSet();
  const droppedReserved = new WeakMap();
  const reservedOf = (m) => {
    const n = !m ? null : m.ws ? m.ws.reservedName : droppedReserved.get(m);
    if (typeof n !== 'string' || !n) return null;
    const v = checkPlayerName(n);
    return v.ok ? v.name : null;
  };
  const guestRowAccount = (m) => {
    if (!m || !m.guest) return '';
    if (m.ws) return squadGuest(m.ws) && m.ws.userId ? wireId(m.ws.userId) : '';
    return droppedAcct.get(m) || '';
  };
  const doorRow = (m) => !!(m && m.guest && (m.ws ? !squadGuest(m.ws) : droppedLinked.has(m)));
  const guestRowName = (m) => (m && m.guest && !doorRow(m) ? reservedOf(m) ?? guestName(m.name) : null);
  // A linked row: its chosen callsign when it has one, else its reserved name,
  // else what the profile proves, as before.
  const linkedRowName = (m, p) => (provenName(p) !== null ? displayName(p) : reservedOf(m) ?? displayName(p));
  // THE CHOSEN CALLSIGN A LINKED ROW'S SOCKET HOLDS (ws.chosenName), for a
  // row the profile read gave no name: the read failed, or answered nothing
  // this account proves. server.js's sign-in sink reads it from the profile
  // row once the token verifies, and the Set keeps it current, so it is the
  // name the match seats the account under (room-engine.js allowedOf)
  // whatever this read answered. It goes through displayName, the pass a
  // chosen callsign read from the profile gets, with the key validateCallsign
  // derives from it, which is the key the sink proved it against. Only the
  // socket on the row, and only while that socket is still this account's: a
  // socket a hello is moving to another account must not name this row.
  const chosenOf = (m) => {
    const w = m && m.ws;
    const n = w && wireId(w.userId) === m.userId && typeof w.chosenName === 'string' ? w.chosenName : '';
    return n ? displayName({ callsign: n, callsign_key: normaliseCallsign(n).toLowerCase() }) : null;
  };
  const guestNoAcct = (m) => !!(m && m.guest && !doorRow(m) && !guestRowAccount(m));

  // TWO MEMBERS OF ONE SQUAD ARE NEVER SHOWN ONE NAME (round 3 fix,
  // 2026-10-10). The names above come from four places (a chosen callsign, a
  // reservation, a profile's default, the name a guest's frame carried), and
  // with the reservations' table missing, their store down, or a newcomer's
  // claim refused by a bound on new names, two of them could be one name,
  // ignoring capitals and look-alike letters. So the box reads its rows in the
  // order the squad's start seats them (the leader, then the roster: launchSquad)
  // and shows a member whose name reads as one shown before them under the
  // stand-in the room engine's door will seat them under, for the same name
  // and the same place (door.standInFor). And a member whose name the server
  // does not hold (no chosen callsign, no reservation) is not shown under a
  // name another player has reserved, nor one a live player elsewhere is
  // shown under, which is the door's rule for that name (a rolled pair's
  // proof, guestName, asks neither).
  // This squad's own rows are not "elsewhere": `liveSkip` holds them out of
  // liveNames, below, while the box is read, so the later member is the one
  // moved, as the room moves them. The names shown are kept on the rows
  // (m.shown) for liveNames.
  //
  // EVERY ROW BUT THE SIGN-IN DOOR'S IS NAMED, BY THE NAME THE MATCH WILL
  // SEAT IT UNDER (round 3 check fix, 2026-10-10). A row whose name came out
  // null used to stay null: a guest whose typed name an account has since
  // chosen, a guest whose claim got no answer, an account whose name read
  // failed. Its player's own page then drew that row with the device's own
  // name, which could be the very name another member's row showed, and the
  // match seated the player under a stand-in the box had never shown. A null
  // row was also left out of the names the later rows were kept apart from,
  // so a later member could keep a name the match then took from them. So a
  // row the box cannot name the usual way is named the way the room engine's
  // door names it (room-engine.js nameAtDoor), in its order: the chosen
  // callsign the account's socket holds (chosenOf); else the name its frame
  // carried, held to the door's own rules for a name the server does not
  // hold (guestName: a rolled pair, or a typed name the guidelines pass and
  // no account holds); else the door's stand-in for that name and place. It
  // then meets the same three checks as every other row, and it counts as
  // shown for the rows after it.
  // A signed-in member's frame name is shown only this way, when nothing the
  // account holds can be: it is what the match shows every player in it.
  // THE SIGN-IN DOOR'S ROW STAYS NAMELESS, for the reason given with doorRow
  // above, and is left out of the names the later rows are kept apart from,
  // as before: a later row moved for a name nobody can see would tell a
  // member something about the account behind it. The squad cannot start
  // while that row is at the door (startRefusal), so no match disagrees.
  const readingsOf = (n) => {
    if (door && typeof door.nameReadingsOf === 'function') { try { return door.nameReadingsOf(n); } catch { /* below */ } }
    return [String(n ?? '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' '), ...nameReadings(n)];
  };
  const readsAs = (n, set) => readingsOf(n).some((x) => set.has(x));
  const seedOf = (name, seat) => [...String(name ?? '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7) + seat * 2654435761;
  function standIn(m, seat, before) {
    if (door && typeof door.standInFor === 'function') {
      try { const c = door.standInFor(m.name, seat, before, m.ws || null); if (typeof c === 'string' && c) return c; } catch { /* below */ }
    }
    // No engine handed in: the engine's walk with what this module can ask.
    const shown = new Set();
    for (const n of before) for (const x of readingsOf(n)) shown.add(x);
    const c = standInWalk(seedOf(m.name, seat), (n) => !!n && !isProfane(n) && !readsAs(n, shown) && freeName(n)
      && (isGeneratedCallsign(n) || (() => { const v = typedName(n); return v.ok && v.name === n; })()));
    return c || null;
  }
  const freeName = (name) => { try { return reservations.free(name) === true; } catch { return false; } };
  const liveElsewhere = (name, ws) => {
    if (!door || typeof door.liveNameReadings !== 'function') return false;
    try { return readsAs(name, door.liveNameReadings(ws || null)); } catch { return false; }
  };
  let liveSkip = null;
  // THE NAMES LIVE IN SQUADS RIGHT NOW, for the room engine's door
  // (server.js setNameLive): every row with an open socket, under the name its
  // box last showed. The squad whose box is being read (liveSkip) is left out.
  function liveNames() {
    const out = [];
    for (const sq of squads.all()) {
      if (sq === liveSkip) continue;
      for (const m of sq.members) if (m.ws && m.ws.readyState === 1 && typeof m.shown === 'string' && m.shown) out.push({ name: m.shown, ws: m.ws });
    }
    return out;
  }
  function boxNames(sq, profiles) {
    const lead = sq.members.find((m) => m.key === sq.leader);
    const order = lead ? [lead, ...sq.members.filter((m) => m !== lead)] : sq.members.slice();
    const out = new Map();
    const before = [];
    const was = liveSkip;
    liveSkip = sq;
    try {
      order.forEach((m, seat) => {
        let c = m.userId ? linkedRowName(m, profiles.get(m.userId)) : guestRowName(m);
        let held = m.userId ? provenName(profiles.get(m.userId)) !== null || reservedOf(m) !== null : reservedOf(m) !== null;
        // A row the usual way cannot name, named as the door names it (see
        // EVERY ROW BUT THE SIGN-IN DOOR'S IS NAMED, above).
        if (!(typeof c === 'string' && c) && !doorRow(m)) {
          const own = m.userId ? chosenOf(m) : null;
          c = own ?? (m.userId ? guestName(m.name) : null);
          held = own !== null;
          if (!(typeof c === 'string' && c)) c = standIn(m, seat, before);
        }
        if (typeof c === 'string' && c) {
          const here = new Set();
          for (const n of before) for (const x of readingsOf(n)) here.add(x);
          if (readsAs(c, here) || (!held && (!freeName(c) || liveElsewhere(c, m.ws)))) c = standIn(m, seat, before) || c;
          before.push(c);
        }
        out.set(m, c);
      });
    } finally { liveSkip = was; }
    for (const [m, c] of out) m.shown = typeof c === 'string' && c ? c : null;
    return out;
  }
  async function squadSnapshot(sq) {
    const ids = sq.members.filter((m) => m.userId).map((m) => m.userId);
    let names = new Map();
    if (ids.length) {
      try { names = await store.profilesByIds(ids); }
      catch { /* no profile proves a name; every row kept, and named as the door names it (boxNames) */ }
    }
    const shown = boxNames(sq, names);
    const frame = {
      type: 'squad', op: 'state', code: sq.code, leader: sq.leader,
      mode: sq.mode, tees: sq.tees, max: sq.max,
      members: sq.members.map((m) => ({
        id: m.userId,
        rid: rowRid(m),
        callsign: shown.get(m) ?? null,
        guest: m.guest,
        online: m.userId ? isOnline(m.userId) : !!(m.ws && m.ws.readyState === 1),
        ready: m.ready,
        dropped: m.dropAt !== null,
        // Only on a guest row with no account behind it; see guestNoAcct.
        ...(guestNoAcct(m) ? { noacct: true } : {}),
      })),
      fits: fitsFor(sq.members.length),
    };
    // THE COUNTDOWN, AS TIME LEFT AND NOT AS A TIME OF DAY (U3). Every member
    // is ready, so the squad starts in this many milliseconds (see the
    // countdown below), and a client counts down from the moment this frame
    // ARRIVES: a phone whose clock is a minute out still shows three, two,
    // one. Read AFTER the name read, so it is the time left as the frame is
    // built. ADDED ONLY WHILE ONE RUNS, so every other frame is exactly what
    // it always was, and builds 6 and 7, which know no such field, ignore it.
    const c = countdowns.get(sq);
    if (c) frame.startsIn = Math.max(0, c.at - now());
    return frame;
  }

  // A GUEST ROW'S RESUME SECRET, `gk` (E1, the whole-branch fix wave). A
  // guest's squad identity is its socket, so a guest whose tab reloaded
  // (Back to menu after a match does) came back on a socket no row knew and
  // fell out of the squad. So each guest row has a secret: 128 random bits,
  // minted the first time the row is shown to its own socket and kept while
  // the row stands (the row OBJECT is the key, as for rids, so a rekey or a
  // drop keeps it and a row that has gone takes it with it). It is sent ONLY
  // to the socket holding that row, on that socket's own state frames
  // (ownFields), NEVER on another member's frame and never in the shared
  // snapshot, and it is no account id. The tab keeps it and presents it with
  // the code in `resume` (squadResume). A row adopted by an account at
  // sign-in is no guest row: its secret is neither sent nor accepted again.
  const gks = new WeakMap();
  const GK_RE = /^[0-9a-f]{32}$/;
  function rowGk(m) {
    let k = gks.get(m);
    if (!k) { k = randomBytes(16).toString('hex'); gks.set(m, k); }
    return k;
  }
  // The guest row of squad `code` whose secret is `gk`, or null: a secret of
  // the wrong shape, a dead code, or no row with it all answer null.
  function guestBySecret(code, gk) {
    if (typeof gk !== 'string' || !GK_RE.test(gk)) return null;
    const sq = squads.get(codeOf(code));
    if (!sq) return null;
    const want = Buffer.from(gk, 'hex');
    const member = sq.members.find((m) => m.guest && gks.has(m) && timingSafeEqual(Buffer.from(gks.get(m), 'hex'), want));
    return member ? { squad: sq, member } : null;
  }

  // THE FIELDS OF A STATE FRAME THAT ARE THIS DESTINATION'S OWN (plan X4,
  // the mirror of forSocket above): `you`, `held` and, for the socket on a
  // guest row, that row's `gk`. Every state frame — pushSquad's fan-out and
  // task 5's resume — is the shared snapshot plus these, built per
  // destination; nothing may be copied from one destination's frame to
  // another's.
  function ownFields(sq, w) {
    const f = { you: youIn(sq, w), held: holds(sq, w) };
    const row = sq.members.find((m) => m.ws === w);
    if (row && row.guest) f.gk = rowGk(row);
    return f;
  }


  // THE FAN-OUT GOES DOWN THE SQUAD'S OWN SOCKETS, NOT socketsOf(). A guest
  // has no presence at all — onAuth returns early for one, so `online` never
  // holds them and socketsOf(guest) is always empty — and a roster fanned out
  // through presence would reach every signed-in member and nobody else,
  // silently, on every squad with a guest in it.
  //
  // `actor` is the socket whose request this answers: it gets the frame as a
  // REPLY (with the request's id); everyone else gets it with none.
  //
  // THE ACTOR IS ALWAYS ANSWERED, even when it is not the socket on its row —
  // a second device of a member, or of the leader kicking. The squad keeps
  // the socket it already has (resume is task 5's), but a request is a
  // request, and one that was never answered holds the client's waiter for
  // its full twelve seconds.
  //
  // EVERYONE ELSE FIRST, THE ACTOR LAST. The actor's frame is the one send
  // here that is a reply rather than a safeSend, so it is the one that can
  // throw — a half-closed socket whose send() raises, the case safeSend
  // exists for — and a throw must not cost the rest of the squad the roster
  // the operation has already changed under them. The snapshot itself no
  // longer rejects (see squadSnapshot), so this is the only throw left.
  //
  // EVERY ROSTER GOES OUT THROUGH HERE, SO THE COUNTDOWN IS ASKED HERE (U3):
  // whatever changed — a Ready, a join, a leave, a kick, a drop, a mode — the
  // squad is pushed, and the push first starts, keeps or stops the countdown
  // for the squad as it now stands, before the frames are built.
  async function pushSquad(sq, actor, msg) {
    countdownCheck(sq);
    const base = await squadSnapshot(sq);
    for (const m of sq.members) {
      if (m.ws && m.ws !== actor) safeSend(m.ws, { ...base, ...ownFields(sq, m.ws) });
    }
    if (actor) reply(actor, msg, { ...base, ...ownFields(sq, actor) });
  }

  // A SQUAD SOMEBODY HAS JUST LEFT. `has` is the test, because the machine
  // deletes the squad but hands the object back with its members still on it
  // so exactly this can be done.
  async function pushSquadAfterExit(sq) {
    if (squads.has(sq.code)) return pushSquad(sq, null, null);
    // A squad that has gone counts nobody in (U3).
    dropCountdown(sq);
    // It is gone. Anyone still on the list is there because the last account
    // left and only guests remained: nobody can lead, the squad ended under
    // them, and a box still rendering it is a Start button that answers
    // nothing. An empty list means the leaver was the last member, and their
    // own answer is the whole story.
    for (const m of sq.members) if (m.ws) safeSend(m.ws, { type: 'squad', op: 'ended', reason: 'no_leader' });
  }

  // A SOCKET WHOSE ROW HAS GONE SOMEWHERE ELSE (task 5) — removed by a leave,
  // create or join from ANOTHER device of the account (which acts on the
  // account's row: a second device holds none of its own), or taken over by
  // that device's resume. Its box is showing a squad it will never be pushed
  // again, and nothing else would tell it. `ended` because this device's
  // squad has; `elsewhere` because the account's has not, necessarily.
  const endedElsewhere = (w) => safeSend(w, { type: 'squad', op: 'ended', reason: 'elsewhere' });
  // The socket on the row `key` holds now, or null.
  const rowSocketOf = (key) => { const f = squads.memberOf(key); return f ? f.member.ws : null; };
  // Read BEFORE an op that may remove or move rows: every [key, socket] for a
  // row under `keys` held by a socket other than the caller's. AFTER it,
  // tellMoved tells each of those sockets whose row is no longer on it — and
  // nobody whose row the op left where it was.
  const heldElsewhere = (ws, keys) => [...new Set(keys)].map((k) => [k, rowSocketOf(k)]).filter(([, w]) => w && w !== ws);
  const tellMoved = (held) => { for (const [k, w] of held) if (rowSocketOf(k) !== w) endedElsewhere(w); };

  // WHO A KICK IS AIMED AT: THE ROW WHOSE HANDLE IS `rid`, AND NOTHING ELSE
  // NAMES ONE (D-UI-3). The leader's box read that handle off the roster on
  // its screen, and the frame spends time on the wire while other players
  // come and go, so it lands on the row it was aimed at wherever that row
  // now stands — or, when that row has gone, on nobody: a handle is never
  // given to another row (rowRid), so a stale one can miss and be refused
  // but can never land on a player the leader did not aim at. That is what
  // the two forms this replaced could not promise: an index named whoever
  // stood at that place by then, and an account id named a member who had
  // left and come straight back. `id` is the pure correlation echo it is on
  // every other frame (public/app.js's socialSend mints a numeric one onto
  // every frame that carries none).
  // STRICT EQUALITY AGAINST A HANDLE rowRid MINTED, so a rid that is absent,
  // not a string, or not one of this squad's rows matches no row at all.
  const squadTarget = (sq, msg) => sq.members.find((m) => rowRid(m) === msg.rid) || null;

  async function squadCreate(ws, msg) {
    const from = squadKey(ws);
    const olds = squadsOfCaller(ws, from);
    // The account's row may be on ANOTHER device, and this create takes it
    // (one squad per player): that device is told, in the finally below.
    const held = heldElsewhere(ws, [from, identityKey(ws)]);
    const sq = squads.create(squadMemberOf(ws, msg), from);
    // THE SQUAD THEY JUST LEFT STILL HAS PEOPLE IN IT. create() leaves it as
    // its first act, so those left behind have a new leader — or none of them
    // can lead and it is gone. Either way they are owed the truth and nobody
    // is going to ask for it on their behalf. Told AFTER the creator is
    // answered, and in a finally, so a creator whose own socket throws on the
    // answer does not also cost them it.
    try { await pushSquad(sq, ws, msg); }
    finally {
      tellMoved(held);
      for (const o of olds) if (o !== sq) await pushSquadAfterExit(o);
    }
  }

  async function squadJoin(ws, msg) {
    // codeOf is the ONE normalisation of a code off the wire (see its note at
    // the top of this file): upper case, trimmed, bounded, and '' for a value
    // that is not a string. No shape test beside it — a string that is not a
    // live squad's code misses the machine's Map and is answered no_such_squad
    // either way, so a regex here could never be seen to do anything.
    //
    // D-BLOCK 3: A BLOCK ROW, EITHER WAY, BETWEEN THE JOINER AND ANY MEMBER
    // REFUSES THE JOIN, in a dead code's words — R16 keeps a blocked pair out
    // of one squad, and a code must not put them back. The read runs for EVERY
    // join from an account, live code or not, so the refusal also takes a dead
    // code's time. That keeps the block unnamed and untold, NOT undetectable:
    // the code frame still says the squad is live (D-BLOCK-2 A, accepted).
    // By ws.userId: a block can name a guest's anonymous account.
    // Everything below is computed AFTER the read, from the squads as they are.
    // A block naming the joiner that lands while the read is out is added
    // from the recent-blocks log; a read the log cannot complete refuses.
    const acct = wireId(ws.userId);
    let hidden = null;
    if (isUuid(acct)) {
      const b = await landedBlocks(acct);
      // Another account, or a closed socket, by now: act on nothing (a
      // closed socket's row would hold a dead socket no window sweeps).
      // THE CANCEL IS THE IDENTITY, NOT ws.authGen (the sign-in door's rule,
      // and for its reason): server.js bumps the generation as every hello
      // STARTS, so a rotated token for this same account, or one that never
      // verifies, would otherwise drop this join with no answer at all, and
      // the client would wait out its twelve seconds for nothing (T6-R1-3).
      if (wireId(ws.userId) !== acct || ws.readyState !== 1) return;
      if (!b) return squadReply(ws, msg, 'join', { error: 'no_such_squad' });
      hidden = new Set([...b.blocked, ...b.blockedBy, ...b.doubt]);
    }
    const from = squadKey(ws);
    const olds = squadsOfCaller(ws, from);
    // THE ACCOUNT IS ALREADY STANDING IN THIS SQUAD AS A GUEST ROW whose
    // socket has since signed in as it — left so by the sign-in door until
    // its read lets the account in (or while a failed read holds it; once
    // let in, claimOnSignIn adopts it, or it leaves for the account's row
    // elsewhere, E8). Joining would put it here twice. Refused BEFORE
    // anything moves, so the squad the account is in now keeps it (task 5's
    // fix pass).
    const me = identityKey(ws);
    const target = squads.get(codeOf(msg.code));
    if (target && hidden && anyRowOf(target, hidden)) return squadReply(ws, msg, 'join', { error: 'no_such_squad' });
    if (typeof me === 'string' && target && target.members.some((m) => m.guest && m.ws && m.ws !== ws && identityKey(m.ws) === me))
      return squadReply(ws, msg, 'join', { error: 'already_in' });
    // create's rule: the account's row on another device is told if this
    // join takes it — and only then, so an already-here join tells nobody.
    const held = heldElsewhere(ws, [from, me]);
    const res = squads.join(codeOf(msg.code), squadMemberOf(ws, msg), from);
    if (!res.ok) return squadReply(ws, msg, 'join', { error: res.error });
    // THE READ ABOVE LET THIS SOCKET IN AS ITS ACCOUNT (T6-R1-3), as the
    // sign-in door does, so the account's next hello (a rotated token)
    // re-reads nothing. It matters for a GUEST row, which has a door: an
    // anonymous account's rows are always guest rows, and after a failed
    // door that hello would otherwise read the row this join has just
    // vetted, and a store fault then would keep it out of Start. NOT when
    // the join made no row and the row it found is one whose door failed:
    // that door stays open for the next hello.
    if (hidden) { const f = squads.memberOf(squadKey(ws)); if (f && !doorShut(f.member)) ws.squadAs = acct; }
    try { await pushSquad(res.squad, ws, msg); }
    finally {
      tellMoved(held);
      for (const o of olds) if (o !== res.squad) await pushSquadAfterExit(o);
    }
  }

  async function squadLeave(ws, msg) {
    const key = squadKey(ws);
    // A SECOND DEVICE'S LEAVE takes the account's row off the device holding
    // it, which is told `ended: elsewhere` — the leaver is answered below.
    const held = heldElsewhere(ws, [key]);
    const res = squads.leave(key);
    tellMoved(held);
    // ANSWERED FIRST AND ALWAYS, INCLUDING WHEN THERE WAS NOTHING TO LEAVE.
    // The state the player asked for is the state they are in, and a second
    // word for it would be one more string to render. The leaver gets a
    // REPLY; `ended` is reserved for members who did not ask.
    //
    // THE MEMBERS LEFT BEHIND FIRST, THE LEAVER'S ANSWER LAST — pushSquad's
    // rule. The push cannot fail (safeSend only, over a snapshot that
    // degrades rather than rejects) and does not reach the leaver, who is
    // already off the roster; the answer is the one send here that can throw,
    // and a throw must not cost the others the roster the leave has changed.
    if (res.squad) await pushSquadAfterExit(res.squad);
    squadReply(ws, msg, 'left', { ok: true });
  }

  async function squadKick(ws, msg) {
    const sq = ledSquad(ws);
    if (!sq) return squadReply(ws, msg, 'kick', { error: 'not_leader' });
    const target = squadTarget(sq, msg);
    if (!target) return squadReply(ws, msg, 'kick', { error: 'no_such_member' });
    // Held BEFORE the removal: kick() takes the row off the squad, and a
    // player who is no longer in it is exactly the one who has to be told.
    const victim = target.ws;
    // sq.leader, because ledSquad has just established that this caller IS
    // the leader, on both halves. THE MACHINE'S OWN LEADER CHECK THEREFORE
    // ALWAYS PASSES FOR THIS CALLER AND GUARDS NOTHING HERE: ledSquad is the
    // only leadership check on this path, and nothing may lean on kick()'s.
    // That is a choice, not an oversight. Passing the caller's identity
    // instead made the machine a second, partial copy of the rule, and it
    // hid a broken half of ledSquad from every test of it (task 3's F30).
    const res = squads.kick(sq.code, sq.leader, target.key);
    if (!res.ok) return squadReply(ws, msg, 'kick', { error: res.error });
    if (victim) safeSend(victim, { type: 'squad', op: 'ended', reason: 'kicked' });
    await pushSquad(sq, ws, msg);
  }

  // THE CALLER'S OWN ROW and the squad it is in, or null. Found by squadKey,
  // so it is the row this socket holds — a guest who has since signed in
  // still holds, and acts on, its guest row — and only for a socket holding
  // none, its account's row (a second device of a member).
  const squadOf = (ws) => squads.memberOf(squadKey(ws));

  // design 4.3, row 'ready'. NO SIGN-IN GATE (R3): membership is the gate. D5
  // lets a guest join by code and design 7 lets a guest be seated, so a guest
  // who could not ready would be a squad that can never start.
  //
  // THE SERVER RE-CHECKS THE RACK against the ARMED mode, with the engine's
  // own validRackFor (injected as validRack): the client checks first so the
  // toggle is honest, and this makes it true. A rack accepted here is a rack
  // the seat keeps when the squad starts. Only `true` is ready.
  //
  // THE RATE BUCKET IS NOT SPENT HERE. handleSquad has already charged this
  // frame; spending again would halve the allowance for this op alone.
  async function squadReady(ws, msg) {
    const found = squadOf(ws);
    if (!found) return squadReply(ws, msg, 'ready', { error: 'no_squad' });
    const want = msg.ready === true;
    if (want && !validRack(found.squad.mode, msg.loadout)) return squadReply(ws, msg, 'ready', { error: 'no_rack' });
    // A DROPPED ROW IS PICKED UP BEFORE IT IS READIED (task 5's fix pass).
    // Only an account's other device can reach its dropped row (squadOf falls
    // back to the account when the socket holds no row), and a dropped row is
    // one nobody live holds — resume's own rule gives it to the account's
    // device that asks, and this device is the one in the player's hand. So
    // the Ready is true of a live socket, and the seat goes where the player
    // is. The machine refuses a Ready on a dropped row outright; this is what
    // keeps that refusal from reaching a player who is right here.
    if (want && found.member.dropAt !== null && squads.markResumed(found.member.key, ws)) clearDropSweep(found.member.key);
    const res = squads.setReady(found.member.key, want, want ? msg.loadout : null);
    if (!res.ok) return squadReply(ws, msg, 'ready', { error: res.error });
    // pushSquad's rule: EVERYONE ELSE FIRST, then the sender its roster, and
    // the sender's answer LAST — the one send that can throw must not cost
    // the others the roster that has already changed. The sender is pushed
    // the roster even from a second device, which holds no row.
    await pushSquad(res.squad, ws, null);
    squadReply(ws, msg, 'ready', { ok: true });
  }

  // design 4.3, row 'mode'. LEADER ONLY, through ledSquad, and no sign-in gate
  // of its own (a guest can never lead, so a guest member is not_leader).
  // Leadership is asked before the frame is read: somebody who does not lead
  // learns nothing about which modes or tee sets exist.
  async function squadMode(ws, msg) {
    const no = (error) => squadReply(ws, msg, 'mode', { error });
    if (!squadOf(ws)) return no('no_squad');
    const sq = ledSquad(ws);
    if (!sq) return no('not_leader');
    // THE INJECTED TABLE IS THE WHITELIST, read with hasOwnProperty so a
    // mode of 'constructor' cannot find Object.prototype's.
    const mode = msg.mode;
    if (typeof mode !== 'string' || !Object.prototype.hasOwnProperty.call(seats, mode)) return no('bad_mode');
    const lim = seats[mode];
    // TEE SETS ARE ECHOED TO EVERY MEMBER in the next roster, so they are
    // vetted here rather than left to the room: an unchecked string in a
    // broadcast frame is a free-text channel between two modified clients —
    // what the aim relay's `weapon` field once was (see `case 'aim'` in
    // public/room-engine.js) — against privacy.html's "No chat, no messages,
    // and no message field of any kind". They belong to golf and nothing
    // else, so a frame carrying one while arming another mode has it dropped,
    // unechoed, rather than refused: a box that has just shown the golf
    // controls may still have the last choice in hand. Absent, it is null,
    // the room's own default.
    let tees = null;
    if (mode === 'golf' && msg.tees != null) {
      if (!teeIds.includes(msg.tees)) return no('bad_tees');
      tees = msg.tees;
    }
    // THE SEAT CHOICE, for a mode the host may choose for (ffa, golf): absent
    // or null is "the mode's own seats"; anything else must be an integer
    // inside the mode's own seats, or the frame is REFUSED bad_max. Refused,
    // not quietly replaced: the leader's box shows the number it sent, and an
    // ok that armed something else would show 3 while the squad seats 4. And
    // NEVER COERCED: '3' (a <select>'s .value) is refused, not read as 3 — a
    // lookup that coerced its key is how an array once became a room's mode.
    // A mode with no choice has no number on screen to disagree with, so a
    // max sent with it is dropped unechoed, as tees are off golf.
    let max = null;
    if (lim.pick && msg.max != null) {
      if (!(Number.isInteger(msg.max) && msg.max >= lim.min && msg.max <= lim.max)) return no('bad_max');
      max = msg.max;
    }
    // Read BEFORE the write: whether this frame changes anything the squad
    // readied for.
    const changed = sq.mode !== mode || sq.tees !== tees || sq.max !== max;
    // sq.leader: ledSquad has established that this caller IS the leader.
    // As in squadKick, THE MACHINE'S LEADER CHECK ALWAYS PASSES FOR THIS
    // CALLER AND GUARDS NOTHING HERE — ledSquad is the only leadership check
    // on this path, and nothing may lean on setMode()'s.
    const res = squads.setMode(sq.code, sq.leader, mode, tees, max);
    if (!res.ok) return no(res.error);
    // EVERY CHANGE CLEARS EVERY READY (owner, 2026-10-06). A Ready is a
    // player saying yes to THIS match, and the last Ready now starts it on
    // its own (the countdown below), so a squad readied for Duel must not be
    // counted into a Boss Fight, or onto another tee set, that nobody agreed
    // to. A frame that changes nothing — the leader's box sends only what
    // differs, but a client may repeat itself — stands nobody down.
    // AND READY STILL MEANS "MY RACK IS FULL FOR THE ARMED MODE": with
    // nothing changed, a rack the mode would not keep stands its member down
    // as it always has.
    for (const m of res.squad.members) if (m.ready && (changed || !validRack(mode, m.loadout))) squads.setReady(m.key, false, null);
    await pushSquad(res.squad, ws, null);
    squadReply(ws, msg, 'mode', { ok: true });
  }

  // design 4.3, row 'start': THE LEADER SEATS THE WHOLE SQUAD IN ONE ROOM.
  // Every gate below is checked before anything is seated, and a refusal
  // changes nothing — no room, no ready flag, no rack — save the one gate that
  // finds a Ready the room would not honour, which stands that member down so
  // the box shows the squad the reason.
  //
  // THE OLD WAY IN, KEPT WORD FOR WORD (U3). Since the owner's ready-up
  // (2026-10-06) a squad starts itself when its last member readies — the
  // countdown below — and this build's client never sends Start. Builds 6
  // and 7, and a cached web page, still do: their leader never readies and
  // presses Start once the others have, with the rack on the frame. So this
  // op answers exactly what it always answered, through the same seating
  // path the countdown uses (launchSquad), and a squad mixing old and new
  // clients starts either way: an old leader's Start once the others are
  // ready, or the countdown once a new leader readies too.
  //
  // LEADER ONLY, THROUGH ledSquad, and no sign-in gate of its own: mode's
  // rule, and for mode's reason (a guest can never lead, so a guest member is
  // not_leader). ledSquad is the ONLY leadership check on this path; nothing
  // here re-derives it.
  //
  // AND ONLY FROM THE DEVICE THAT HOLDS THE LEADER'S SEAT. ledSquad lets a
  // second device of the leader act as the leader, which is harmless for kick
  // and mode. Start is different: it SEATS a socket, and the host seat is the
  // socket on the leader's ROW — the one the squad knows and every member's
  // box is showing. Seating it for a press on another device would leave the
  // leader looking at a screen in no room while their tank waits on a device
  // they may not be watching, and a squad duel gives a turn a day's grace. So
  // that press is refused wrong_device and nobody is seated. This is not a
  // second leadership rule: the caller has already passed ledSquad; it is
  // which socket the seat would go to.
  //
  // THE RATE BUCKET IS NOT SPENT HERE; handleSquad has already charged it.
  async function squadStart(ws, msg) {
    const no = (error) => squadReply(ws, msg, 'start', { error });
    if (!squadOf(ws)) return no('no_squad');
    const sq = ledSquad(ws);
    if (!sq) return no('not_leader');
    const lead = sq.members.find((m) => m.key === sq.leader);
    if (lead.ws !== ws) return no('wrong_device');
    // THE LEADER'S RACK MAY RIDE ON THE START FRAME (the Squad box's Start
    // carries the leader's picks rather than asking for a Ready). It is judged by
    // the same predicate the ready op uses — the engine's validRackFor for the
    // ARMED mode — and a frame that carries one that is not a rack is refused
    // no_rack, never quietly ignored. It stands in for the leader's Ready for
    // THIS start only and is not stored: a refused start changes nothing, and a
    // seated one clears every rack anyway.
    const sent = msg.loadout != null;
    if (sent && !validRack(sq.mode, msg.loadout)) return no('no_rack');
    return launchSquad(sq, sent ? msg.loadout : null, ws, msg);
  }

  // THE GATES EVERY START PASSES, the leader's Start and the countdown's alike
  // (U3), and the countdown's test for whether it may run at all: one function,
  // so what the countdown waits for and what the seating then demands can never
  // drift apart. PURE: it reads the squad and changes nothing, so it can be
  // asked on every push. `leadRack` is the rack a leader's Start carried, which
  // stands in for the leader's Ready, or null.
  // -> null when the squad may be seated now; else { error } or { error, at }
  //    (`at` on duplicate_member and member_offline, the roster row at fault),
  //    or { error: 'not_ready', stale } when every member is ready but a rack
  //    the room would not keep is among them (see launchSquad).
  function startRefusal(sq, leadRack) {
    const lead = sq.members.find((m) => m.key === sq.leader);
    const rackOf = (m) => (m === lead && leadRack ? leadRack : m.loadout);
    // EACH ACCOUNT IS SEATED EXACTLY ONCE (task 5's fix pass). The engine's
    // join checks the socket, never the account, so one account on two rows
    // would be two seats — and in a duel, the account against itself. The
    // rows' own rules keep that state out (claimOnSignIn, squadJoin's
    // already_in); this guards the HARM, whatever the cause, and asks before
    // `fits` so the answer names the real fault rather than a squad that
    // looks one too big. An account is a row's userId or the account its
    // socket is signed in as; `at` is the SECOND row of that account.
    const whose = new Map();
    let twice = -1;
    sq.members.forEach((m, i) => {
      const ids = new Set([m.userId, m.ws ? identityKey(m.ws) : null].filter((v) => typeof v === 'string' && v));
      for (const a of ids) { if (twice < 0 && whose.has(a) && whose.get(a) !== i) twice = i; whose.set(a, whose.has(a) ? whose.get(a) : i); }
    });
    if (twice >= 0) return { error: 'duplicate_member', at: twice };
    // THE SAME `fits` THE BOX AND THE BOARDS ARE SHOWING: fitsFor over the
    // engine's own seat table, minimum AND maximum (plan X6). A squad of one
    // does not start a duel; three do not start one either.
    if (!fitsFor(sq.members.length)[sq.mode]) return { error: 'wont_fit' };
    // A LIVE SOCKET FOR EVERY MEMBER. The engine's join does not look at a
    // socket's state, so a closed one would be SEATED: a ghost seat, marked
    // connected, that the match would one day hand the turn to. Nothing is
    // seated unless every seat has somebody on it. `at` is the roster row of
    // the first member who is not there, so the box can mark them.
    //
    // ASKED BEFORE READY (task 5). A member whose socket goes is DROPPED, and
    // a dropped member is not ready (design 4.3), so the ready gate below
    // would answer every such start `not_ready` — true, but not the reason:
    // they cannot ready from a socket that is gone. This names who is missing.
    //
    // A ROW THE SIGN-IN DOOR IS STILL READING FOR is not there yet either
    // (D-BLOCK-3 F): its account's blocks are unread, and seating it could
    // seat a blocked pair together. Nor is one whose read FAILED (H
    // amended), and refusing it runs its door again (launchSquad, and the
    // countdown's own check).
    const off = sq.members.findIndex((m) => !(m.ws && m.ws.readyState === 1 && m.dropAt == null) || doorOut.has(m) || doorShut(m));
    if (off >= 0) return { error: 'member_offline', at: off };
    if (!sq.members.every((m) => (m === lead && leadRack) || m.ready === true)) return { error: 'not_ready' };
    // THE LAST GATE ON THE RACKS. Arming a mode stands down every member
    // whose rack it would not keep (squadMode, above), but this is the last
    // line before a room is built and it does not trust that that happened: a
    // rack the room would not keep sends that seat to the pick screen, and the
    // squad's match with it. Such a member is not ready by the rule ready
    // itself states.
    const stale = sq.members.filter((m) => !validRack(sq.mode, rackOf(m)));
    if (stale.length) return { error: 'not_ready', stale };
    return null;
  }

  // THE ONE PATH THAT SEATS A SQUAD (U3): the leader's Start, which builds 6
  // and 7 still send, and the countdown's end, which nobody sends. ONE PATH,
  // so the two can never seat by different rules: the same gates
  // (startRefusal), the same order, the same seating, the same telling.
  // `leadRack` is the rack the leader's Start carried, or null. `ws` and `msg`
  // are that Start's socket and frame, answered as a Start always was; for the
  // countdown both are null, and every member is told instead (see
  // countdownRefused).
  //
  // A START PRESSED WHILE THE SQUAD COUNTS DOWN needs nothing of its own: the
  // countdown runs only while these same gates pass, so that Start passes
  // them too, and every way it then ends pushes the squad — seated, its
  // Readies spent, or refused by the seating with every Ready standing — and
  // the push stops the countdown or lets it run.
  async function launchSquad(sq, leadRack, ws, msg) {
    const lead = sq.members.find((m) => m.key === sq.leader);
    const rackOf = (m) => (m === lead && leadRack ? leadRack : m.loadout);
    const r = startRefusal(sq, leadRack);
    if (r) {
      const why = r.at !== undefined ? { error: r.error, at: r.at } : { error: r.error };
      // A row behind the sign-in door's failed read is held out of Start
      // until a door lets it in, and each refusal at it runs that door again
      // (D-BLOCK-3 H amended): one read in flight per row, no timer, no loop.
      if (r.error === 'member_offline') reopenDoor(sq.members[r.at]);
      // A Ready the room would not honour is stood down HERE, so the box
      // shows the squad the reason the start was refused.
      if (r.stale) for (const m of r.stale) squads.setReady(m.key, false, null);
      if (!ws) return countdownRefused(sq, why);
      if (r.stale) await pushSquad(sq, ws, null);
      return squadReply(ws, msg, 'start', why);
    }
    // R5: THE ORDER IS THE ORDER THE ROOM FILLS IN. The leader first, because
    // the create makes them the host seat; everyone else in roster order, and
    // the match begins as the last one lands. Each seat is handed a COPY of
    // its rack, like every rack this layer passes on.
    // THE BOX'S ORDER (boxNames, above): each member meets the room's door
    // after the same members the box read before them, so a member the box
    // moved is moved here to the same stand-in. This squad's rows count as
    // live names here, which the box did not ask: they are the names the box
    // has just settled, each of which a member before it does not have.
    const ordered = [lead, ...sq.members.filter((m) => m !== lead)];
    const seated = seatSquad(
      ordered.map((m) => ({ ws: m.ws, name: m.name, skin: m.skin, loadout: rackOf(m).slice() })),
      { mode: sq.mode, tees: sq.tees, squad: sq.code },
    );
    if (!(seated && seated.ok === true && typeof seated.code === 'string')) {
      // R6: EVERY MEMBER IS TOLD, not only the one who asked: a member seated
      // before the failure was shown a lobby that no longer exists, and this is
      // what tells them why. Nothing was started, so every Ready stands and the
      // squad can simply try again. pushSquad's order: everyone else first,
      // then the caller its roster, and the caller's own answer LAST, because
      // it is the one send here that can throw.
      //
      // `at` NAMES THE MEMBER AT FAULT, and rides ONLY on the two refusals
      // that have one: member_busy and member_offline. A capacity refusal, or
      // a room the engine would not build or start, is nobody's doing, and an
      // `at` there would have the box mark a member who did nothing wrong.
      // seatSquad counts in the list it was handed — leader first — and the
      // box counts in the roster, and the two differ whenever the leader is
      // not the first row, so it is translated; an index naming no seat is
      // dropped rather than passed on.
      const error = squadError('start', (seated && typeof seated.error === 'string' && seated.error) || 'unavailable');
      const blames = error === 'member_busy' || error === 'member_offline';
      const row = blames && Number.isInteger(seated.at) && seated.at >= 0 ? sq.members.indexOf(ordered[seated.at]) : -1;
      const why = row >= 0 ? { error, at: row } : { error };
      if (!ws) return countdownRefused(sq, why);
      for (const m of sq.members) if (m.ws && m.ws !== ws) safeSend(m.ws, { type: 'squad', op: 'start', ...why });
      await pushSquad(sq, ws, null);
      return squadReply(ws, msg, 'start', why);
    }
    // SEATED. The Readies are spent (design 4.3: they reset when the room is
    // created), and the racks with them — clearReady's order, AFTER the seats
    // took their copies. Every member already has the engine's own frames for
    // the room; this tells their box which room, and then what it now holds.
    // A countdown has no caller, so every member gets `done`.
    squads.clearReady(sq.code);
    const done = { type: 'squad', op: 'start', ok: true, code: seated.code };
    for (const m of sq.members) if (m.ws && m.ws !== ws) safeSend(m.ws, done);
    await pushSquad(sq, ws, null);
    if (ws) squadReply(ws, msg, 'start', { ok: true, code: seated.code });
  }

  // ---- the ready-up countdown (U3; owner, 2026-10-06) -----------------------
  // "All players must ready up and then the game starts. The leader does not
  // need to initiate the game start." So the leader readies like everyone
  // else, and the moment every member of a squad of two or more is ready, and
  // the squad could be seated (startRefusal: it fits the mode, every member is
  // online and past the sign-in door, every rack is one the room keeps), the
  // squad COUNTS DOWN: COUNTDOWN_MS on the injected timer, shown to every
  // member as `startsIn` on the state frame, and at its end the squad is
  // seated by the very path a leader's Start takes (launchSquad).
  //
  // ANY CHANGE STOPS IT. Every change to a squad is pushed, and pushSquad asks
  // countdownCheck first. A Ready taken back, a join, a drop and a change of
  // mode or tee set (which stands every Ready down, see squadMode) each stop
  // it, because the squad is no longer all ready. A leave or a kick changes
  // the ROWS, which the countdown was started for (countdownSig, below, its
  // rows in order): that countdown stops, and when the members left are
  // all still ready, a new one starts from the top, so nobody is counted
  // into a match that changed under them with less than the full time to say
  // no. A sign-in door opening stops it as well (openDoor), because that row
  // is not past the door any more. What a countdown keeps is a Ready sent
  // again, or a mode frame that changes nothing: a repeat cannot hold a
  // squad from starting by restarting it.
  //
  // A SQUAD OF ONE NEVER COUNTS (owner: "a squad of one behaves as no
  // squad"). Its client offers the ordinary Launch; a leader's Start from
  // builds 6 and 7 still seats it.
  //
  // Read PER INSTANCE, the house pattern for a time knob (DROP_MS below).
  const envCount = Number(process.env.SQUAD_COUNTDOWN_MS);
  const COUNTDOWN_MS = Number.isFinite(envCount) && envCount >= 0 ? envCount : 3000;
  // squad OBJECT -> { sig, at, cancel }: at most one per live squad, deleted
  // when it ends, stops or its squad goes. Keyed by the object, not the code,
  // so a code minted again for a later squad can never meet an old countdown.
  const countdowns = new Map();
  // THE SQUAD A COUNTDOWN COUNTS IN, taken as it is armed: the mode and tee
  // set, and for each row in order its handle, its key and its Ready. A key
  // is an account id or, for a guest, a socket OBJECT, so the signature is a
  // list compared item by item with ===, never a string: a socket has no
  // spelling that tells two of them apart. A row re-keyed under a countdown
  // (a guest adopted at sign-in, or resumed on another socket) is not the
  // seat that was counted in, so it counts again from the top. The same
  // signature is what the push keeps a countdown for (countdownCheck) and
  // what its end seats (countdownEnd), so the two can never disagree about
  // which squad counted.
  const countdownSig = (sq) => [sq.mode, sq.tees, ...sq.members.flatMap((m) => [rowRid(m), m.key, m.ready])];
  const sameSig = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  // -> true when a countdown was running and has stopped.
  function dropCountdown(sq) {
    const c = countdowns.get(sq);
    if (!c) return false;
    countdowns.delete(sq);
    c.cancel();
    return true;
  }

  // Starts, keeps or stops the countdown for `sq` as it stands now. The push
  // that called it then tells every member what it decided. Synchronous, and
  // WRAPPED: it runs at the head of every push, and a throw here must cost the
  // squad its countdown, never its roster.
  function countdownCheck(sq) {
    try {
      const live = squads.get(sq.code) === sq;
      const r = live && sq.members.length >= 2 ? startRefusal(sq, null) : { error: 'none' };
      const cur = countdowns.get(sq);
      if (!r && cur && sameSig(cur.sig, countdownSig(sq))) return;
      dropCountdown(sq);
      if (r) {
        // EVERYONE IS READY AND ONE ROW IS HELD AT THE SIGN-IN DOOR by a read
        // that failed: the countdown is the start that is refused at it, so
        // the door runs again, as a refused Start runs it (reopenDoor: one
        // read in flight per row; a failed read pushes nothing, so this
        // cannot loop). Its success pushes the squad, and that push counts.
        if (r.error === 'member_offline' && sq.members.every((m) => m.ready === true)) reopenDoor(sq.members[r.at]);
        return;
      }
      const entry = { sig: countdownSig(sq), at: now() + COUNTDOWN_MS, cancel: () => {} };
      countdowns.set(sq, entry);
      entry.cancel = schedule(() => countdownEnd(sq, entry), COUNTDOWN_MS);
    } catch { /* this squad's countdown only */ }
  }

  // THE COUNTDOWN'S END, WRAPPED BY HAND for the drop window's reason:
  // `schedule` is a bare timer, and a throw out of it would reach
  // 'uncaughtException', whose handler shuts the server down and every live
  // match with it. A countdown stopped or replaced since, or a squad that has
  // gone, seats nobody, even from a timer that fires after its cancel. And a
  // seating that THROWS is a refusal like any other: every member is told,
  // rather than left watching a count that reached nought.
  //
  // ONLY THE SQUAD THAT WAS COUNTED IN IS SEATED. The push stops a countdown
  // whose squad changed, but a change can land BEFORE its push: a join or a
  // create takes the caller off this squad at once, then awaits the NEW
  // squad's push (a name read) before this one is pushed at all. A timer
  // firing in that gap found the same countdown on a squad its members'
  // rosters had never shown changing, and seated whoever was left with no
  // fresh three seconds — or, a duel left with one, refused every member
  // wont_fit and stood every Ready down. So a squad that is not the one
  // armed is seated by nobody and PUSHED instead, here and now: the members
  // are shown the change their rosters had not shown yet, that push's
  // countdownCheck starts a fresh countdown when the members left are still
  // all ready and fit, exactly as after a leave or a kick, and the push the
  // join or create still owes them then finds that one and keeps it.
  function countdownEnd(sq, entry) {
    try {
      if (countdowns.get(sq) !== entry) return;
      countdowns.delete(sq);
      if (squads.get(sq.code) !== sq) return;
      if (!sameSig(entry.sig, countdownSig(sq))) { pushSquad(sq, null, null).catch(() => {}); return; }
      launchSquad(sq, null, null, null).catch(() => countdownRefused(sq, { error: 'unavailable' }).catch(() => {}));
    } catch { /* one lost countdown, never the process */ }
  }

  // A COUNTDOWN THAT ENDS IN A REFUSAL (U3). Every member is told why, in the
  // frame R6 sends every member after a refused Start, and then the roster.
  // EVERY READY IS STOOD DOWN FIRST, which R6 does not do: R6 waits for the
  // leader to press Start again, but a countdown's squad left all ready would
  // count down again at once and try the same seating every three seconds for
  // as long as the cause lasts — a busy member's lobby built and torn down
  // over and over. So the squad sees the reason and readies again.
  async function countdownRefused(sq, why) {
    squads.clearReady(sq.code);
    const f = { type: 'squad', op: 'start', ...why, error: squadError('start', why.error) };
    for (const m of sq.members) if (m.ws) safeSend(m.ws, f);
    await pushSquad(sq, null, null);
  }

  // ---- the drop window (task 5, design 4.3) --------------------------------
  // A member whose socket goes keeps their row for DROP_MS, shown as dropped
  // and not ready, and is then removed and the squad pushed a fresh roster.
  // server/squads.js holds the state of the window; this holds its length,
  // its timers and the fan-out, which need this closure.
  //
  // THE THIRD GRACE WINDOW IN THIS BUILD, AND IT IS NEITHER OF THE OTHER TWO.
  // public/room-engine.js holds a per-SEAT forfeit timer (RESUME_GRACE_MS,
  // 120 s, or ASYNC_GRACE_MS, 24 h, for an async duel) and a whole-ROOM hold
  // (EMPTY_ROOM_GRACE_MS, 30 min, or SOLO_HOLD_MS, 24 h, for a match with no
  // other human in it). This one is about a MEMBERSHIP: a player
  // who drops mid-match keeps their seat under the engine's window and their
  // squad row under this one, and the two expire independently, on purpose.
  // Nothing here touches a room.
  //
  // Read PER INSTANCE, the house pattern for a time knob (PRESENCE_MS above),
  // so a suite can set it just before it builds its layer.
  const envDrop = Number(process.env.SQUAD_DROP_MS);
  const DROP_MS = Number.isFinite(envDrop) && envDrop >= 0 ? envDrop : 60000;
  // member key -> cancel(), at most one per member dropped in the last
  // DROP_MS: an entry is deleted when its timer fires or the member resumes,
  // and a member who drops again replaces theirs. A key is an account id or,
  // for a guest, the dead socket, held here for at most one window.
  const dropTimers = new Map();

  // THE SWEEP, WRAPPED BY HAND. `schedule` is a bare timer: safeTimeout and
  // safeInterval live in public/room-engine.js and nothing under server/ has
  // either, so a throw out of this callback would reach 'uncaughtException',
  // whose handler shuts the server down and takes every live match with it.
  // One fault costs one sweep, never the process; the next drop's sweep
  // catches up with whoever this one missed.
  //
  // THE CUTOFF IS AT LEAST `at`, the drop this timer was armed for. The timer
  // firing IS that member's window having passed; now() is only asked about
  // everyone else. A timer can fire a millisecond early by the wall clock,
  // and a clock can be stepped backwards, and either would leave the member
  // one millisecond inside the window, with no timer left to try again.
  function sweepSquads(at) {
    try {
      const cutoff = Math.max(now() - DROP_MS, at);
      // Every squad that still has someone to tell: a survivor's roster, or
      // the guests a leaderless squad ended under. pushSquadAfterExit is
      // task 2's answer to both, and swallows nothing it should not.
      for (const sq of squads.sweepDropped(cutoff)) pushSquadAfterExit(sq).catch(() => {});
    } catch { /* one lost sweep, never the process */ }
  }

  // Replaces any timer this member already has, so the window always runs
  // from their LATEST drop.
  function armDropSweep(key, at) {
    clearDropSweep(key);
    const cancel = schedule(() => {
      if (dropTimers.get(key) === cancel) dropTimers.delete(key);
      sweepSquads(at);
    }, DROP_MS);
    dropTimers.set(key, cancel);
  }

  function clearDropSweep(key) {
    const cancel = dropTimers.get(key);
    if (!cancel) return;
    dropTimers.delete(key);
    cancel();
  }

  // Called from onClose, which server.js calls from THREE places: the
  // socket's own 'close', the sign-out branch of the auth sink, and a hello
  // for a different account. It cannot be bolted onto the engine's
  // handleClose instead: that returns early unless `player.ws === ws` and
  // does nothing for a socket that held no room, and a member in the bay
  // holds no room.
  //
  // THE ROW THIS SOCKET HOLDS, AND ONLY THAT ONE (squads.keyOfSocket — the
  // first half of squadKey). A socket closing takes nothing but its own row
  // with it. squadKey's other half, the identity, is how a REQUEST from a
  // second device finds the account's row; a second device CLOSING is not
  // the account leaving, and its row is on a device that is still here.
  //
  // WRAPPED, for the timer's reason and one more: onClose runs inside
  // server.js's 'close' handler ahead of the engine's handleClose, and a
  // throw here would also skip the seat's release.
  function dropSquadMember(ws) {
    try {
      const key = squads.keyOfSocket(ws);
      if (key == null) return;
      // TWO CALLERS, TWO ANSWERS, AND readyState TELLS THEM APART. A CLOSED
      // socket is a DROP: the player may be back inside the window, and the
      // row is held for them. A socket still OPEN got here from the sign-out
      // branch or from a hello for another account, and that is a LEAVE: the
      // connection is nobody now, or somebody else, and holding the row would
      // go on pushing the account's squad down it. It is also what keeps one
      // socket to one row: a signed-out socket left holding the account's
      // row was answered AS that account when it joined again as a guest.
      if (ws.readyState === 1) {
        // A GUEST ROW STAYS. Its key is this socket — a guest's squad
        // identity is the connection, and it is not the connection that is
        // leaving. This matters most when an ANONYMOUS guest signs in:
        // server.js runs this hook first (the anonymous id differs from the
        // new one), then onAuth, whose sign-in door reads the account's
        // blocks and then makes the row the account's (claimOnSignIn).
        // Taking it out here would lose the player their place a moment
        // before it was theirs by name.
        if (typeof key !== 'string') return;
        const res = squads.leave(key);
        // pushSquadAfterExit: a roster for the survivors, or `ended` for the
        // guests left in a squad nobody signed in can now lead.
        if (res.squad) pushSquadAfterExit(res.squad).catch(() => {});
        return;
      }
      const at = now();
      // A GUEST ROW REMEMBERS ITS ACCOUNT THROUGH THE DROP (round 2 fix): the
      // row loses its socket here, and guestRowAccount reads this instead,
      // so the row keeps its name and its report path until the window ends.
      // A socket with no account clears any account an earlier socket left.
      // AND WHETHER IT WAS THE SIGN-IN DOOR'S ROW (final audit, 2026-10-09):
      // a socket signed in as a LINKED account leaves droppedLinked set, so
      // the dropped row stays as nameless as it was while its socket stood.
      const held = squads.memberOf(key);
      if (held && held.member.guest) {
        const acct = squadGuest(ws) && ws.userId ? wireId(ws.userId) : '';
        if (acct) droppedAcct.set(held.member, acct); else droppedAcct.delete(held.member);
        if (!squadGuest(ws)) droppedLinked.add(held.member); else droppedLinked.delete(held.member);
      }
      if (held) {
        if (typeof ws.reservedName === 'string' && ws.reservedName) droppedReserved.set(held.member, ws.reservedName);
        else droppedReserved.delete(held.member);
      }
      const sq = squads.markDropped(key, at);
      if (!sq) return;
      armDropSweep(key, at);
      pushSquad(sq, null, null).catch(() => {});
    } catch {
      // The close goes on, and that is all this buys. WHAT IT COSTS, said
      // plainly: a throw BEFORE markDropped (the clock, say) leaves the row
      // holding a CLOSED socket with no dropAt, which no sweep will ever
      // remove — the window is keyed by dropAt. The row is not dangerous:
      // Start's member_offline gate reads the socket's state and refuses it,
      // and the leader can kick it, or it goes when the squad does. It is a
      // stranded row, not a live seat, and test (d10) pins exactly that.
    }
  }

  // ---- one account, one row (task 5's fix pass) -----------------------------
  // Called from onAuth on a verified hello of a SIGNED-IN account — at once
  // for the account the socket already stood for, and from the sign-in door
  // once its read has let a NEW account in (D-BLOCK-3 F). A
  // guest row is keyed by the socket that joined, and that socket may since
  // have signed in: it is then an ACCOUNT standing in the squad under a key
  // no account-keyed rule can see — and the account's other device could
  // join beside it and be seated beside it, the same player twice (a duel
  // led by that account would be the account against itself). There are two
  // ways into that state, and this is where both are closed: a join can only
  // see the first, and the second (the account's row came FIRST, the guest
  // then signed in) is only visible here.
  //
  //   * The account has NO row anywhere: the guest row BECOMES the account's
  //     (squads.adoptGuest). It then carries the account id, is shown by its
  //     proved callsign, and every account-keyed rule reaches it; the byKey
  //     index — a Map — holds one row per account from then on.
  //   * The account has a row IN THIS SQUAD: it is already here. The guest
  //     row goes. If no live socket holds the account's row (it is dropped),
  //     this socket takes it — resume's own rule, and the device in the
  //     player's hand. Otherwise the row stays where it is and this socket
  //     is told `ended: elsewhere`, as any device whose row went elsewhere is.
  //   * The account has a row in ANOTHER squad: ONE SQUAD PER PLAYER (E8,
  //     the whole-branch fix wave; task 2 had left one account in two
  //     squads). The account's existing row wins. The guest row leaves its
  //     squad — a guest row, so no hand-off and no end — whose members are
  //     pushed their roster as for any leave, and this socket is told
  //     `ended: elsewhere`, as any device whose row went elsewhere is. Until
  //     the door lets the account in (or while a failed door holds the row),
  //     the two-squads state can still stand, nameless and out of Start;
  //     ledSquad's two halves, squadJoin's already_in and Start's
  //     duplicate_member still guard it.
  //
  // `rowKey` is the door's: the row it read for, followed by its key (see
  // the door), because a socket that closed meanwhile no longer holds it.
  // A closed socket is never put on the account's row: it would be a row
  // no drop window sweeps.
  //
  // Wrapped: onAuth runs inside server.js's hello callback, and a throw here
  // must not cost the socket its callsign lookup behind it.
  function claimOnSignIn(ws, rowKey) {
    try {
      const key = rowKey !== undefined ? rowKey : squads.keyOfSocket(ws);
      if (key == null || typeof key === 'string') return;     // no guest row here
      const id = identityKey(ws);
      if (typeof id !== 'string') return;                     // still a guest
      const here = squads.memberOf(key);
      // The door is still reading for this row: it claims it when it lands.
      if (!here || doorOut.has(here.member)) return;
      const adopted = squads.adoptGuest(key, id);
      if (adopted) { pushSquad(adopted, null, null).catch(() => {}); return; }
      const theirs = squads.memberOf(id);
      if (!theirs) return;
      if (theirs.squad !== here.squad) {                      // another squad: the account's row wins
        squads.leave(key);
        endedElsewhere(ws);
        pushSquadAfterExit(here.squad).catch(() => {});
        return;
      }
      const was = theirs.member.ws;
      const held = !!(was && was.readyState === 1);
      squads.leave(key);                                      // a guest row: no hand-off, no end
      if (!held && ws.readyState === 1 && squads.markResumed(id, ws)) clearDropSweep(id);
      else endedElsewhere(ws);
      pushSquad(here.squad, null, null).catch(() => {});
    } catch { /* the hello goes on */ }
  }

  // ---- the sign-in door (D-BLOCK-2 B, D-BLOCK-3 F and H) --------------------
  // No two identified accounts with a block row between them, either way, are
  // members of one squad from the moment this server asks for the row: the
  // block's own teardown parts them in the turn its write is ASKED, before
  // any answer (T6-R1-2), and runs again as the answer arrives, and every
  // door treats the pair as blocked while the write is out (blockPending).
  // A row this server never asked for (written by anything else) is unknown
  // here until a read returns it. Join, invite and block keep that at their
  // doors, and THIS is the fourth: a socket that holds a row BECOMES an
  // account here, and the join that made the row read no block for it.
  // Without this, a player refused by code could join before saying hello,
  // or as a throwaway anonymous account, and then sign in: the row would
  // stand for them, by name, beside the player who blocked them, and Start
  // would seat the two.
  //
  // THE DOOR READS BEFORE THE CLAIM (D-BLOCK-3 F). Until the account's
  // blocks are read the row stays the nameless guest row it was: no adoption,
  // so the account's name reaches nobody, and Start answers member_offline
  // for it (doorOut), so nobody is seated beside it. Then: a block with any
  // member removes it, still nameless; none, and claimOnSignIn runs as it
  // always did.
  //
  // EVERY WAY IN PASSES HERE. server.js's push-subscription sink, which
  // once set ws.userId from a token on a socket that never said hello with
  // no onAuth, now introduces such a socket through the hello path itself,
  // so a guest row it holds meets this door like any other. An account row
  // a join makes was vetted by that join, and it has no door.
  //
  // THE ROW IS REMOVED AS A KICK: its socket gets exactly squadKick's victim
  // frame and the rest of the squad the roster a kick gives them. Nothing
  // names the block.
  //
  // THE CANCEL IS THE IDENTITY, NOT ws.authGen. server.js bumps the
  // generation as every hello STARTS, before its token is verified, so a
  // hello with a junk, missing or expired token moves it and changes nothing
  // else: the socket is still this account, no onAuth follows, and a cancel
  // on the generation would leave the row standing unchecked for good. Only
  // a socket that is no longer this account — signed out, or signed in as
  // another, whose onAuth runs the door for that account — is left alone.
  // A socket that CLOSED meanwhile is not a cancel either: its row still
  // stands for the account, so it is judged, dropped, told nothing —
  // D-BLOCK 5's rule. A socket with no account stands for nobody and is not
  // read at all. A later door for the same row (a sign-out and back in)
  // takes the row over, and this one does nothing.
  //
  // THE CHECK FOLLOWS THE ROW OBJECT: the squad is looked up AFTER the read,
  // from the row's key as it is then, and a row that has left, or moved, is
  // left alone: the socket has moved on, through a door of its own.
  //
  // A FAILED READ FAILS TO GUEST (D-BLOCK-3 H). A read that throws, or that
  // the recent-blocks log cannot complete, cannot let the account in, and
  // is no reason to kick anybody: the row stays the nameless guest row it
  // was, and `squadAs` is cleared so the account's next hello tries again.
  // The teardown and join still count the socket as the account (rowsOf),
  // so a block landing later still separates them.
  //
  // AND THE ROW STAYS OUT OF START (H amended): the engine seats the
  // socket, which is the account. doorFailed holds it until a door lets the
  // account in or removes the row; a socket that is no longer that account
  // is not held for it. Each Start refused at it runs its door again
  // (reopenDoor), and so does the account's next hello. No timer, no loop.
  //
  // Called from onAuth, which learns synchronously whether the door took the
  // row (and must not claim it), and from squadStart. The read is never
  // awaited there, so everything is caught here: nothing is left to reject
  // unhandled.
  const doorOut = new Map();            // row -> the door reading for it now
  const doorFailed = new WeakMap();     // row -> the account its door failed for
  const doorShut = (m) => !!m.ws && doorFailed.get(m) === wireId(m.ws.userId);
  function openDoor(ws, id, row) {
    const mark = {};
    doorOut.set(row, mark);
    // A ROW AT THE DOOR IS NOT PAST IT (U3), so a squad counting down stops,
    // and is told: nothing else is pushed until the read lands. The read's
    // own push, when it lets the row in, counts again.
    const f = squads.memberOf(row.key);
    if (f && f.member === row && dropCountdown(f.squad)) pushSquad(f.squad, null, null).catch(() => {});
    doorCheck(ws, id, row, mark);
  }
  // ONLY A GUEST ROW HAS A DOOR (T6-R2-3). A row keyed by an account was made
  // by an op that vetted that account: a join read its blocks, a create had
  // nobody else in it, and a resume or a claim takes a row that was vetted
  // already. A failed door clears `squadAs`, and a create afterwards does
  // not set it again. So the account's next hello is counted as new, and
  // without this test it would re-read an account row that was already
  // vetted. A store fault would then keep that row, the leader's included,
  // out of Start, and a block row the store held unseen would remove the
  // leader, which no block may do. A GUEST row a join makes is covered the
  // other way (T6-R1-3): the join's read lets the socket in, and it sets
  // `squadAs` as this door does, because an anonymous account's rows are
  // always guest rows and this test cannot tell them apart.
  function signInDoor(ws) {
    try {
      const key = squads.keyOfSocket(ws);
      const id = wireId(ws.userId);
      const held = key == null || typeof key === 'string' || !isUuid(id) ? null : squads.memberOf(key);
      if (!held) return false;
      openDoor(ws, id, held.member);
      return true;
    } catch { return false; }
  }
  // One read per row: never while a door holds it.
  function reopenDoor(row) {
    if (doorShut(row) && !doorOut.has(row)) openDoor(row.ws, doorFailed.get(row), row);
  }
  async function doorCheck(ws, id, row, mark) {
    try {
      let b = null;
      try { b = await landedBlocks(id); } catch { /* unread */ }
      if (doorOut.get(row) !== mark || wireId(ws.userId) !== id) return;
      const found = squads.memberOf(row.key);
      if (!found || found.member !== row) return;
      doorOut.delete(row);
      // A FAILED READ, AND DOUBT, FAIL TO GUEST (D-BLOCK-3 H; D-BLOCK-6 M): a
      // member kept whole may have blocked this account or may not, so the
      // row is neither let in nor removed; it stays out of Start until a
      // door reads it clear.
      const fails = !b || (!anyRowOf(found.squad, new Set([...b.blocked, ...b.blockedBy])) && anyRowOf(found.squad, new Set(b.doubt)));
      if (fails) { if (ws.squadAs === id) ws.squadAs = null; doorFailed.set(row, id); return; }
      // Every row, the account's own included: no account can block itself.
      // Let in: the socket is the account as far as the next hello goes.
      if (!anyRowOf(found.squad, new Set([...b.blocked, ...b.blockedBy]))) {
        doorFailed.delete(row);
        ws.squadAs = id;
        claimOnSignIn(ws, row.key);
        // AN ANONYMOUS ACCOUNT LET IN KEEPS ITS GUEST ROW (claimOnSignIn adopts
        // a row for a linked account only), and the row now has an account
        // behind it, so every member's frame is pushed again (final audit,
        // 2026-10-09): a row that went out with `noacct` gains Block on every
        // screen now, not at the squad's next change. This is the door a
        // guest's first save opens, through the client's fresh hello.
        if (squadGuest(ws)) pushSquad(found.squad, null, null).catch(() => {});
        return;
      }
      const was = row.ws;
      squads.removeMember(found.squad.code, row.key);
      safeSend(was, { type: 'squad', op: 'ended', reason: 'kicked' });
      await pushSquadAfterExit(found.squad);
    } catch { /* the hello goes on */ }
    finally { if (doorOut.get(row) === mark) doorOut.delete(row); }
  }

  // ---- squad resume (task 5; design 4.3 and 5.4) ----------------------------
  // THE WIRE: the `state` snapshot as this socket must see it (ownFields —
  // `you` is its row, `held` false when it only LOOKED, D-UI-1, and `gk`
  // when its row is a guest's, E1), with the request's id, or EXACTLY
  // { type:'squad', op:'gone', id } and nothing else. `gone` IS CAUSE-NEUTRAL
  // and the box says only "Your squad has ended.": a restart (squads are
  // memory by design), a kick, a drop-window sweep and a block's removal all
  // answer it alike, and copy naming one cause would tell a removed player
  // which of them it was (D-BLOCK 5).
  //
  // NOT IN SQUAD_LINKED. A guest resuming on the socket they joined on is
  // still a member and is answered their squad (design 5.4: the bay asks
  // after every match). A guest on a new socket is answered gone by the
  // lookup itself, since their key was the socket that went; refusing them
  // 'sign_in' instead would put a sign-in sentence where the box's own
  // answer belongs.
  //
  // WHICH SQUAD: the one this socket's row is in, else the one its account's
  // row is in (squadKey's order). NEVER the squad a presented code names:
  // answering a code the caller is not in would hand a roster of strangers'
  // callsigns to anyone who can guess four characters, and a code the device
  // remembers from before the account moved squads elsewhere would be
  // answered `gone` although the player is in a squad right now. A bare
  // frame — no code — is how the box asks when it remembers none.
  //
  // WHEN THE ROW MOVES TO THIS SOCKET. A socket that holds no row may take the
  // account's: always when no live socket holds it (the reconnect this op
  // exists for — dropped, or its socket closing), and from a socket that
  // still looks live ONLY when the frame names this squad's code. That is the
  // engine's own rule for a seat — the token's holder takes it over, because
  // a proxy can hold a dead socket open for twenty seconds — and it is what
  // task 4's wrong_device waits on. A bare resume names nothing: it is
  // answered as a second device and moves nothing, so a device merely
  // opening the app does not pull the squad off the one in use. The device
  // the row leaves is told.
  async function squadResume(ws, msg) {
    const own = squads.keyOfSocket(ws);
    const key = own != null ? own : identityKey(ws);
    let found = squads.memberOf(key);
    let back = false, bySecret = false;
    // A GUEST ROW BY ITS SECRET (E1). Only for a socket that holds no row
    // and whose own identity finds none — so every answer above is what it
    // always was — and only with the row's squad's code and its exact
    // secret; anything else falls through to gone, the answer no secret
    // gets. The row MOVES to this socket even from a socket that still looks
    // live, as the engine's seat token moves a seat and as a code-named
    // resume moves an account's row: a page load can reach the server before
    // the old socket's close does. The socket it left is told.
    //
    // A SOCKET THAT IS AN ACCOUNT ALREADY (its hello came first) now holds a
    // guest row it did not hold when that hello's door ran, so the row meets
    // the sign-in door here (D-BLOCK-2 B): the secret is a bearer's, and the
    // account presenting it need not be the one the row was vetted for.
    if (!found && own == null) {
      const g = guestBySecret(msg.code, msg.gk);
      if (g) {
        const was = g.member.ws, dropped = g.member.dropAt !== null, old = g.member.key;
        if (squads.resumeGuest(old, ws)) {
          clearDropSweep(old);
          back = dropped;
          bySecret = true;
          found = g;
          if (was && was !== ws) endedElsewhere(was);
          signInDoor(ws);
        }
      }
    }
    if (!found) return squadReply(ws, msg, 'gone', {});
    const { squad: sq, member: m } = found;
    if (own == null && !bySecret) {
      const held = m.ws && m.ws.readyState === 1;
      if (!held || codeOf(msg.code) === sq.code) {
        const was = m.ws, dropped = m.dropAt !== null;
        // markResumed is by account only and never gives a socket a second
        // row; `own == null` has already established this socket holds none.
        if (squads.markResumed(key, ws)) {
          clearDropSweep(key);
          back = dropped;
          if (was && was !== ws) endedElsewhere(was);
        }
      }
    }
    // THE CANCEL IS THE IDENTITY, NOT ws.authGen (join's and invite's rule,
    // T6-R1-3). The snapshot waits on a profile read; a sign-out, or a hello
    // verified as another account, landing inside it means this socket is no
    // longer the one whose squad this is, and its client has reset. A hello
    // that leaves it the same account (a rotated token, or one that never
    // verifies) still bumps the generation, and must still be answered.
    const who = wireId(ws.userId);
    const base = await squadSnapshot(sq);
    const frame = { ...base, ...ownFields(sq, ws) };
    const live = squads.has(sq.code);
    // A MEMBER WHO WAS DROPPED IS BACK, and the dot beside them has to come
    // back on every other screen — whatever becomes of this socket's own
    // answer, because the re-attach has already happened. From the same
    // snapshot: one name read for the whole resume. Everyone else first; the
    // answer, the one send here that can throw, last (pushSquad's order).
    // `you`, `held` AND `gk` ARE EACH DESTINATION'S OWN, never the
    // resumer's: built from the shared snapshot, never from the resumer's
    // frame, which carries the resumer's secret. The resumer can also lose
    // its row inside the names read (a kick), and its frame then says
    // held:false to a squad that still holds theirs.
    if (back && live) for (const x of sq.members) if (x.ws && x.ws !== ws) safeSend(x.ws, { ...base, ...ownFields(sq, x.ws) });
    if (wireId(ws.userId) !== who) return;
    // NO ROW OF THIS SQUAD IS THIS SOCKET'S ANY MORE — kicked, or the squad
    // ended, while the names were read. The roster it has just been removed
    // from is not its to see: gone.
    if (!live || frame.you < 0) return squadReply(ws, msg, 'gone', {});
    reply(ws, msg, frame);
  }

  // EVERY ROW OF squad `sq` THAT ACCOUNT `id` STANDS ON: the account's own
  // row, and any row held by a live socket signed in as that account. The
  // second half is for the rows keyed by a CONNECTION rather than an account
  // — a guest row whose socket has since signed in (a row the sign-in door
  // has not let in yet, or whose read failed: since E8 the only two-squads
  // state), and an anonymous account's guest row. A
  // block and an invite name an ACCOUNT, and this is how they find the seat
  // that account is in when the seat is keyed by a socket.
  //
  // IT SPENDS NO GUEST IDENTITY. A guest's squad identity is still its
  // connection (identityKey): this reads the account a connection is signed
  // in as, OFF THE SOCKET, and compares it in memory. It is never a row's key
  // and never on a frame. For an anonymous account it is the id a block row
  // already names — a guest may block and be blocked (requireAccount) — so the
  // block's own teardown has to be able to find them.
  //
  // A DROPPED GUEST ROW IS FOUND TOO (round 2 fix, 2026-10-08), by the
  // account its socket was signed in as when it dropped (droppedAcct, the same
  // account guestRowAccount names it by). It has no socket to read, and this
  // used to say it could not come back. It can: its player resumes it by its
  // secret (squadResume, guestBySecret) inside the drop window. A block by the
  // row's handle (rowTarget) landed on that account, but the teardown below
  // found no row for it, so nobody was parted at block time: the blocked
  // guest came back to the whole roster, the blocker included, and was then
  // removed by the sign-in door as 'kicked', while a blocker who does not
  // lead stayed in the squad, against R16. Found here, the dropped row is
  // parted at block time like any other, and the join, invite and sign-in
  // doors see it as well.
  const rowAccounts = (m) => [typeof m.key === 'string' ? m.key : '', m.ws ? wireId(m.ws.userId) : (m.guest && droppedAcct.get(m)) || ''].filter(Boolean);
  const rowsOf = (sq, id) => (id ? sq.members.filter((m) => rowAccounts(m).includes(id)) : []);
  // True when any row of `sq` stands for an account in `ids` (a Set).
  const anyRowOf = (sq, ids) => sq.members.some((m) => rowAccounts(m).some((a) => ids.has(a)));

  // ---- invite (design 4.3, the invite row; 4.4) -----------------------------
  // LEADER OR MEMBER MAY INVITE (design 4.3). A squad of friends is not a
  // hierarchy: mode, start and kick are the leader's and go through ledSquad,
  // and this does NOT — every member's box has an Invite button.
  //
  // WHICH SQUAD: the one this socket's own row is in, else its account's —
  // squadOf, squadKey's order, the file's one answer to "which row is this
  // caller". The Invite button was pressed on THIS screen's squad. An
  // account-first lookup would, for a socket holding a guest row in one squad
  // while its account sits in another, invite a friend to the squad this
  // screen is not showing.
  //
  // THE ANSWER: { ok:true, delivered } to the inviter, or an error. 'online':
  // the frame went down every live socket the friend holds, and nothing is
  // pushed (design 4.4: no push to a player who is online). 'push': no live
  // socket, and the injected transport has a device to hand it to. 'none':
  // neither — the invite is valid and nothing reached them. The owner wants
  // the inviter told whether the invite went out (D-BLOCK-2 E, revised).
  // 'sent' is the fourth, and only an invite by callsign to a player who is
  // NOT a friend gets it: one answer whatever happened, because only friends
  // may learn whether a player is online (squadInviteByName, below).
  //
  // THE FRIEND BUCKET, FIRST, on top of the squad one handleSquad has already
  // charged. An invite is aimed at a friend, costs the round trips a
  // `friend op:'request'` does, and is the one frame in this layer that can
  // reach a device's notification tray. Ten a minute is far above an honest
  // client — a squad holds three other people. First for handleReport's
  // reason: a refusal is still a reply, and a check after the guards would
  // leave a loop of junk targets answered with no limit of its own.
  //
  // ON THIS PATH, ONE ANSWER FOR EVERY MISS OF THE PAIR, 'not_friend': not a friend,
  // blocked either way, a guest, no account, not a uuid. friendSearch fixes
  // this shape — "no such player" and "that player has blocked you" must be
  // one answer, or the frame is a way to enumerate blocks. The shape test
  // comes before the store, for friendRequest's reason: store.js throws on a
  // malformed id, and a round trip would be spent to answer 'unavailable'.
  //
  // A GUEST CANNOT BE INVITED (R12), AND THE FRIEND READ IS THE LINE THAT
  // REFUSES ONE. A guest has no presence — onAuth returns early for an
  // anonymous account — so socketsOf(guest) is always empty, and the obvious
  // "online ? frame : push" answers a guest { ok:true, delivered:'none' }: an
  // invite that looks accepted and reaches nobody. Every friend op is behind
  // requireLinked, so no anonymous account is in anyone's friendIdsOf, and
  // `!friendIds.includes(to)` refuses it before presence is ever asked. It is
  // the only signal there is: nothing in the store says an account is
  // anonymous.
  //
  // BLOCKS EITHER WAY, because blocking is not a mute: blockIdsOf answers
  // { blocked, blockedBy } and every gate in this file reads both.
  //
  // WHAT MEMORY ANSWERS IS ASKED TWICE, before the reads and after them. The
  // squad can move while they are out — somebody joins and it is full, the
  // inviter is kicked, it ends — and the frame must carry the squad as it IS;
  // asked before as well, so a refusal memory can give costs no round trip.
  // And the SOCKET can become somebody else meanwhile — signed out, or signed
  // in as another account: an invite asked for by one account must not go
  // out from another account's squad under the first one's name. Nothing is
  // answered. THE CANCEL IS THE IDENTITY, NOT ws.authGen (the sign-in door's
  // rule): server.js bumps the generation as every hello starts, before its
  // token is verified, and a rotated token for the same account, or one
  // that never verifies, leaves the socket exactly the account that asked,
  // which must still be answered (T6-R1-3).
  //
  // THE FRAME carries no account id and no request id: a code, a proved name,
  // the size and the cap are everything Join needs, and it answers no
  // request, so it is sent by hand rather than through reply() — a client
  // routes it ahead of its waiters, as it does `presence`. The name is
  // displayName's, like every name this layer emits (BINDING 27), and a null
  // name KEEPS THE INVITE: the box renders its no-name card.
  async function squadInvite(ws, msg) {
    const no = (error) => squadReply(ws, msg, 'invite', { error });
    if (!rateOk(ws, 'friend', LIMITS.friend)) return no('slow_down');
    // A frame that names its invitee by CALLSIGN takes the one path that does
    // not need a friend (squadInviteByName, below); every other frame is the
    // friend path, exactly as builds 6 and 7 send it.
    if (typeof msg.callsign === 'string') return squadInviteByName(ws, msg, no);
    const to = wireId(msg.to);
    // `deep`: whether a row held through a socket counts as `already`. Only
    // once the friend check has passed — asked earlier, any member could
    // probe any uuid for "stands on a guest row in my squad".
    const vet = (deep) => inviteVet(ws, to, deep, 'not_friend');
    const before = vet(false);
    if (before.error) return no(before.error);
    const me = wireId(ws.userId);
    // The invitee's blocks are read in the same leg: one read covers both
    // directions for every member (D-BLOCK 4). Every read is made for every
    // invite, so a refused or dropped one costs what a delivered one does.
    //
    // A BLOCK NAMING THE INVITEE THAT LANDS WHILE THE LEG IS OUT is added
    // from the recent-blocks log, as join and the sign-in door add theirs:
    // the frame would otherwise carry this squad's code to a player a member
    // has just blocked. The invitee's blocks are read again only when the
    // log dropped entries the leg needed, and a second miss drops the invite.
    const from = blockSeq;
    const [friendIds, blocks, self, first] = await Promise.all([store.friendIdsOf(me), store.blockIdsOf(me), store.profileById(me), store.blockIdsOf(to)]);
    let theirs = withLanded(first, to, from);
    if (theirs === null) theirs = await readLanded(to);
    if (wireId(ws.userId) !== me) return;
    if (!friendIds.includes(to)) return no('not_friend');
    if (blockedEither(blocks, to)) return no('not_friend');
    const after = vet(true);
    if (after.error) return no(after.error);
    // PINNED: an invite for one squad never goes out for another the
    // account has moved to while the reads were out.
    if (after.sq !== before.sq) return no('no_squad');
    return deliverInvite(ws, msg, after.sq, to, self, theirs, {});
  }

  // WHAT MEMORY ANSWERS FOR AN INVITE, asked before the reads and after them
  // (see squadInvite): no squad, a full one, a target that is no account
  // (`miss`, the path's own word for every miss), or one already in the
  // squad. `to` null is a by-callsign invite before its lookup, when there is
  // no target to vet yet.
  function inviteVet(ws, to, deep, miss) {
    const found = squadOf(ws);
    if (!found) return { error: 'no_squad' };
    if (found.squad.members.length >= SQUAD_MAX) return { error: 'full' };
    if (to === null) return { sq: found.squad };
    if (!isUuid(to)) return { error: miss };
    if (deep ? rowsOf(found.squad, to).length : found.squad.members.some((m) => m.key === to)) return { error: 'already' };
    return { sq: found.squad };
  }

  // ---- invite by callsign (owner, 2026-10-07) ------------------------------
  // "You should also have the ability to add someone to the squad without
  // needing to add them as a friend." His answer: by exact callsign, and by
  // the squad code or link; blocked players cannot be found or invited. A
  // frame that carries `callsign` names its invitee by the exact callsign
  // friend search finds them by (callsignKeyOf, one shape test and one key
  // for both), and it is THE ONLY PLACE 'not_friend' IS RELAXED: an Invite
  // on a friend row still sends `to`, and still needs the friend.
  //
  // EVERYTHING ELSE IS THE FRIEND PATH'S, in its order: the friend bucket
  // (squadInvite, first, as search spends it), the squad asked before the
  // reads and after them, the identity checked after every await, the
  // invitee's blocks with the recent-blocks log added from a seq taken before
  // the first read, and the invite dropped silently on a block between the
  // invitee and any member.
  //
  // EXCEPT HOW IT IS DELIVERED, WHEN THE PLAYER IS NOT A FRIEND (round 2,
  // 2026-10-08). Every consent and disclosure text says a push carries "squad
  // invites from friends" (privacy.html, the Nudges row, the pushOk toast, the
  // store listing), and privacy.html says only friends can see whether a player
  // is online. A stranger's invite therefore NEVER reaches the push seam, not
  // even its dry run, and its answer is ONE answer: `delivered: 'sent'`, the
  // same whether the player is online or not, has a device to notify or not,
  // or the invite was dropped. It reaches the player in-app only, on the
  // sockets they hold at that moment (inviteStranger, below). An invite by
  // callsign that finds a FRIEND is a friend's invite and is delivered as one
  // (deliverInvite): the push, the cooldown and 'online' | 'push' | 'none'.
  // Telling the two apart costs the friend read, made in the first leg for
  // every invite by callsign, so a miss, a block, a friend and a stranger all
  // cost the same four first-leg reads.
  //
  // EVERY MISS IS ONE ANSWER, 'no_such_user', AFTER ONE LEG. A callsign that
  // names nobody, the caller's own, a player blocked either way and a guest
  // all answer it after the SAME four reads, made together: the lookup, the
  // caller's blocks, the caller's own row and the caller's friends. So a block
  // costs exactly what a miss costs, and the frame is no way to learn who has
  // blocked you (friendSearch's rule, D-BLOCK). A guest is found by no lookup:
  // a guest has no callsign_key, because setting one is behind requireLinked,
  // so the key is the line that refuses one here, as the friend read is on the
  // other path. A callsign of the wrong shape is a miss before the store, as
  // in search. A found player's own blocks are read only once they are found,
  // in a second leg, so what a delivered and a dropped invite cost is the same.
  //
  // The answer carries `callsign`, the invitee's PROVED name (displayName,
  // null when there is none), for the inviter's "Invite sent to <name>." It
  // is the same on a dropped invite as on a delivered one.
  async function squadInviteByName(ws, msg, no) {
    const before = inviteVet(ws, null, false, 'no_such_user');
    if (before.error) return no(before.error);
    const key = callsignKeyOf(msg.callsign);
    if (!key) return no('no_such_user');
    const me = wireId(ws.userId);
    const from = blockSeq;
    const [them, blocks, self, friendIds] = await Promise.all([store.profileByCallsignKey(key), store.blockIdsOf(me), store.profileById(me), store.friendIdsOf(me)]);
    if (wireId(ws.userId) !== me) return;
    const to = them ? wireId(them.id) : '';
    if (!to || to === me || blockedEither(blocks, to)) return no('no_such_user');
    let theirs = withLanded(await store.blockIdsOf(to), to, from);
    if (theirs === null) theirs = await readLanded(to);
    if (wireId(ws.userId) !== me) return;
    const after = inviteVet(ws, to, true, 'no_such_user');
    if (after.error) return no(after.error);
    if (after.sq !== before.sq) return no('no_squad');
    const extra = { callsign: displayName(them) };
    if (Array.isArray(friendIds) && friendIds.includes(to)) return deliverInvite(ws, msg, after.sq, to, self, theirs, extra);
    return inviteStranger(ws, msg, after.sq, to, self, theirs, extra);
  }

  // THE INVITED FRAME AND THE DROP, one copy for every path. `theirs` is the
  // invitee's blocks with the log added, falsy when they could not be read.
  // D-BLOCK 4: A BLOCK BETWEEN THE INVITEE AND ANY MEMBER DROPS THE INVITE,
  // SILENTLY, and a read that failed drops it too.
  const invitedFrame = (sq, self, ws) => ({ type: 'squad', op: 'invited', code: sq.code, from: { callsign: inviterName(ws, self) }, size: sq.members.length, max: SQUAD_MAX });
  const inviteDropped = (sq, theirs) => !theirs || anyRowOf(sq, new Set([...theirs.blocked, ...theirs.blockedBy, ...theirs.doubt]));

  // THE DELIVERY TO A FRIEND, for both paths: the frame to every live socket,
  // or the push seam, and the inviter's answer (`extra` is what a path adds to
  // it).
  async function deliverInvite(ws, msg, sq, to, self, theirs, extra) {
    const live = socketsOf(to);
    const frame = invitedFrame(sq, self, ws);
    // A DROPPED INVITE: nothing reaches the invitee, and the inviter is
    // answered what this invite would have been answered, at the same point:
    // 'online' for a live socket, and otherwise whatever the push seam says in
    // its DRY-RUN form — the same read, no send (D-BLOCK-2 E, as the owner
    // revised it). So the inviter is told "sent" for an invite that went
    // nowhere: the accepted price of never telling anyone about a block between
    // two OTHER players.
    const dropped = inviteDropped(sq, theirs);
    if (live.length) {
      if (!dropped) for (const w of live) safeSend(w, frame);
      return squadReply(ws, msg, 'invite', { ok: true, delivered: 'online', ...extra });
    }
    // ONE REAL PUSH PER INVITEE PER INVITE_COOLDOWN_MS (D-PUSH-1 R), whoever
    // invites: inside the window a real invite takes the dropped one's path —
    // the dry run, the same read and the same answer, nothing sent. Taken
    // before the await, so two invites racing to one friend send once.
    const real = !dropped && inviteCooldown.take(to);
    const pushed = await askPushSeam(to, { code: frame.code, from: frame.from.callsign, size: frame.size, max: frame.max }, !real);
    squadReply(ws, msg, 'invite', { ok: true, delivered: pushed ? 'push' : 'none', ...extra });
  }

  // THE DELIVERY TO A PLAYER WHO IS NOT A FRIEND (round 2, 2026-10-08): in-app
  // only, to the sockets they hold now, and one answer whatever happened. No
  // push and no dry run, so nothing about the player's devices is read, and
  // nothing in the answer or its timing says whether anyone was there.
  //
  // THE FRAME NAMES THE INVITER'S ACCOUNT (`from.id`), and only this frame
  // does: the card a stranger's invite draws carries the player menu, Report
  // and Block, like every other place a player is shown, and both are aimed by
  // that id. It is the inviter's own id, sent to the one player they chose to
  // invite, who would read it off the squad's roster the moment they joined
  // (squadSnapshot). A friend's invite carries none: that card needs no menu,
  // because the friends list beside it has one.
  function inviteStranger(ws, msg, sq, to, self, theirs, extra) {
    if (!inviteDropped(sq, theirs)) {
      const frame = invitedFrame(sq, self, ws);
      frame.from.id = wireId(ws.userId);
      for (const w of socketsOf(to)) safeSend(w, frame);
    }
    squadReply(ws, msg, 'invite', { ok: true, delivered: 'sent', ...extra });
  }

  // THE PUSH SEAM, ASKED ONCE FOR EVERY OFFLINE INVITE, dropped or not (see
  // pushInvite at the top of createSocial). ONLY A LITERAL true IS A PUSH: a
  // count, a word or a receipt says nothing about whether a device took it.
  // A THROW IS 'none', synchronous or not — a transport fault is no reason to
  // fail an invite that was valid, and handleSquad's net would answer
  // 'unavailable' for it.
  //
  // AND SO IS NO ANSWER WITHIN INVITE_PUSH_MS. The seam is awaited inside
  // this socket's one-frame-at-a-time social queue, and a block waits in that
  // queue behind it: a transport that never settles must not hold a player's
  // block up for ever. Four seconds by default, because the invite's reads
  // may already have taken sbAdmin's eight and the client stops waiting at
  // twelve. Both forms get the same bound, so a timed-out dry run and a
  // timed-out real one answer alike. Read per instance, the house pattern
  // for a time knob (PRESENCE_MS), and unref'd like every timer here.
  //
  // THE SEAM IS TOLD WHEN ITS TIME IS UP: `signal` is aborted at the bound,
  // the moment the inviter is answered none. A transport whose read ran long
  // must not send after that — the inviter has been told it did not go out,
  // and the owner asked for that answer to be true.
  const envInvitePush = Number(process.env.SQUAD_INVITE_PUSH_MS);
  const INVITE_PUSH_MS = Number.isFinite(envInvitePush) && envInvitePush >= 0 ? envInvitePush : 4000;
  // THE INVITE PUSH COOLDOWN (D-PUSH-1 R): an invite needs no match, so
  // without it any number of friends and sockets could fill one player's
  // notification tray. Keyed on the invitee alone, so it caps what a player
  // is sent however many people send it. Read per instance, like every time
  // knob here; 0 turns it off (the suites that invite one friend twice).
  const envCooldown = Number(process.env.SQUAD_INVITE_COOLDOWN_MS);
  const INVITE_COOLDOWN_MS = Number.isFinite(envCooldown) && envCooldown >= 0 ? envCooldown : 30000;
  const inviteCooldown = createCooldown({ ms: INVITE_COOLDOWN_MS, max: 4096, now });
  async function askPushSeam(to, payload, dryRun) {
    const stop = new AbortController();
    let timer = null;
    const expiry = new Promise((r) => {
      timer = setTimeout(() => { stop.abort(); r(false); }, INVITE_PUSH_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try { return (await Promise.race([pushInvite(to, payload, { dryRun, signal: stop.signal }), expiry])) === true; }
    catch { return false; }
    finally { clearTimeout(timer); }
  }

  SQUAD_OPS.create = squadCreate;
  SQUAD_OPS.join = squadJoin;
  SQUAD_OPS.leave = squadLeave;
  SQUAD_OPS.kick = squadKick;
  SQUAD_OPS.ready = squadReady;
  SQUAD_OPS.mode = squadMode;
  SQUAD_OPS.start = squadStart;
  // NOT added to SQUAD_LINKED — see squadResume.
  SQUAD_OPS.resume = squadResume;
  SQUAD_OPS.invite = squadInvite;

  const skinOf = (row) => (row && typeof row.skin === 'string' && SKIN_IDS.has(row.skin) ? row.skin : null);

  // ---- the friends read model (design 4.2, row 1) ----------------------------
  // Five independent store METHODS in one leg, then ONE name lookup: friends,
  // both request directions and the blocked list all resolve out of a single
  // profilesByIds rather than one query per person in the panel.
  //
  // profileById is the sixth METHOD and the only per-id one. It is the player's
  // own row, and it is here because BINDING resolution 13 needs this account's
  // own chosen name and neither of the other profile reads answers for it.
  //
  // SIX METHODS IS NOT SIX ROUND TRIPS. requestsOf makes two GETs (and a DELETE
  // on the turn of the hour) and blockIdsOf makes two, so one frame is EIGHT
  // PostgREST round trips, nine when the sweep runs, and ten the first time an
  // account is given a friend code. Anything sizing a limit against this number
  // must use the round trips, not the method count.
  //
  // AND ONE MORE WHEN AN ACCOUNT ON IT HAS NO CHOSEN CALLSIGN (round 3 fix,
  // 2026-10-10): reservedNamesOf, one read for the whole panel (listNames),
  // and only while the reservations are on.
  async function friendsSnapshot(userId) {
    const [ids, reqs, blocks, friendCode, self] = await Promise.all([
      store.friendIdsOf(userId),
      store.requestsOf(userId),
      store.blockIdsOf(userId),
      store.ensureFriendCode(userId),
      store.profileById(userId),
    ]);
    // BLOCKED EITHER WAY IS HIDDEN EVERYWHERE BUT THE BLOCKED LIST (design 4.2).
    // Task 6's block op is expected to tear the friendship and the requests down
    // as it writes the row, so in ordinary operation this filter removes
    // nothing. It costs nothing either — blockIdsOf is already read above — and
    // it is the difference between "a blocked player cannot reach you" being a
    // property of THIS frame and it being a property of a cleanup running
    // somewhere else. A pending request from a blocked player is them reaching
    // you too, so it goes as well; the store's own 30-day sweep collects the row.
    const hidden = new Set([...blocks.blocked, ...blocks.blockedBy]);
    const visible = (list) => list.filter((id) => !hidden.has(id));
    const friendIds = visible(ids);
    // A REQUEST FROM SOMEONE WHO IS ALREADY A FRIEND IS NOT A REQUEST. Every op
    // in this layer is read-then-write with no transaction, and one ordering
    // leaves exactly that behind: an add-by-code racing a request from the other
    // side writes the friendship and the request row survives, because each op
    // read the relation before the other wrote it. Unfiltered, the panel then
    // shows the same person as a friend AND as an incoming request until
    // somebody acts on it — and Accept on a row that is already a friendship
    // does nothing a player can see. The friend ids are already in hand, so this
    // costs no read; it is the cheap half of the fix and the write side stays
    // racy by design (the unique constraints, not a read, settle the rows).
    const friends = new Set(friendIds);
    const pending = (list) => visible(list).filter((id) => !friends.has(id));
    const incoming = pending(reqs.incoming);
    const outgoing = pending(reqs.outgoing);
    const wanted = [...new Set([...friendIds, ...incoming, ...outgoing, ...blocks.blocked])];
    const names = wanted.length ? await store.profilesByIds(wanted) : new Map();
    // Each account named as its squad row names it (listNames): one read of
    // the reservations for the whole panel, after the profiles say which
    // accounts have no chosen callsign.
    const nameOf = await listNames(wanted, names);
    return {
      type: 'friends',
      friends: friendIds.map((id) => ({ id, callsign: nameOf(id), online: isOnline(id) })),
      requests: {
        in: incoming.map((id) => ({ id, callsign: nameOf(id) })),
        out: outgoing.map((id) => ({ id, callsign: nameOf(id) })),
      },
      blocked: blocks.blocked.map((id) => ({ id, callsign: nameOf(id) })),
      friendCode,
      // BINDING resolution 13. Without it a player signing in on a second device
      // is told to choose a callsign they already hold, and the client would
      // have to guess one out of local storage. null means "this account holds
      // only a ROLLED name", which is precisely when the hint belongs.
      callsign: provenName(self),
    };
  }

  // Both sides of any change see it without asking (design 4.2). Swallows its
  // own faults: a fan-out is a courtesy, never a reason to fail an operation
  // that has already been written and already been answered. Carries no `id`,
  // because it answers no request — a client must not match it to one.
  //
  // COLLAPSED, THE WAY PRESENCE IS, BECAUSE THIS BURST IS DRIVEN BY OTHER
  // PEOPLE. A snapshot is eight PostgREST round trips and a frame to every one
  // of the player's devices, and NOTHING here touches the player's own rate
  // bucket: ten friends accepting at once cost the player at the other end ten
  // snapshots, eighty round trips, and ten frames per device, on ten other
  // people's allowances. The leading push still goes out IMMEDIATELY — a panel
  // must react to the operation the player just performed — and any further
  // push for the same player inside the window is collapsed into one trailing
  // snapshot, which is built when it fires and therefore carries the newest
  // state. A window of 0 (what the suite's op sections use) disables the
  // collapse entirely, so every push is immediate.
  const envPush = Number(process.env.SOCIAL_PUSH_MS);
  const PUSH_MS = Number.isFinite(envPush) && envPush >= 0 ? envPush : 250;
  const pushAt = new Map();       // userId -> when a snapshot was last built
  const pushTimers = new Map();   // userId -> the pending trailing push
  async function sendSnapshot(userId) {
    const live = socketsOf(userId);
    if (!live.length) return;
    pushAt.set(userId, Date.now());
    let snap;
    try { snap = await friendsSnapshot(userId); } catch { return; }
    // PER DESTINATION, because the unblock keys in it are per connection. One
    // read, one build, one cheap remap each — no extra round trip.
    for (const w of live) safeSend(w, forSocket(w, snap));
  }
  async function pushFriends(userId) {
    if (!userId) return;
    // A trailing push is already scheduled and will carry whatever this change
    // did, so there is nothing to add.
    if (pushTimers.has(userId)) return;
    const since = Date.now() - (pushAt.get(userId) || 0);
    if (PUSH_MS > 0 && since < PUSH_MS) {
      const t = setTimeout(() => {
        pushTimers.delete(userId);
        // Nobody left to tell: drop the entries rather than grow two maps by an
        // account each, the way presenceLast is bounded above.
        if (!socketsOf(userId).length) { pushAt.delete(userId); return; }
        sendSnapshot(userId).catch(() => {});
      }, PUSH_MS - since);
      if (typeof t.unref === 'function') t.unref();
      pushTimers.set(userId, t);
      return;
    }
    await sendSnapshot(userId);
  }
  const pushBoth = async (a, b) => { await pushFriends(a); await pushFriends(b); };

  // ---- the friend operations -------------------------------------------------
  // reply(ws, msg, frame) is Task 4's helper and echoes msg.id; BINDING
  // resolution 11 fixes both the name and the argument order.
  const friendReply = (ws, msg, op, rest) => reply(ws, msg, { type: 'friend', op, ...rest });

  // Every op needs the same three facts about the other player, so read them
  // once, concurrently, instead of three times down three branches. They are
  // the CALLER's rows, so add and request read them BESIDE the lookup of the
  // other player, on a miss too (D-BLOCK-5 I): a code or an id whose owner
  // blocked the caller then costs what one nobody holds costs, the same
  // reads in one round trip, and a failure of any read fails both alike.
  const callerRows = (me) => Promise.all([store.friendIdsOf(me), store.requestsOf(me), store.blockIdsOf(me)]);
  const relationTo = async (me, other) => relationOf(await callerRows(me), other);
  function relationOf([ids, reqs, blocks], other) {
    return {
      friend: ids.includes(other),
      incoming: reqs.incoming.includes(other),
      outgoing: reqs.outgoing.includes(other),
      // BY DIRECTION, and every op refuses both: blocking is not a mute.
      // `blocked` is the caller's own block and is named to them, checked
      // first so it says nothing about being blocked back. A block naming
      // the caller is answered as that op's own not-found, so no answer
      // tells a player they were blocked (D-BLOCK-4).
      blocked: blocks.blocked.includes(other),
      blockedBy: blocks.blockedBy.includes(other),
    };
  }

  // An id off the wire, in the shape the store's own ids come back in. Postgres
  // renders uuid lower-case, so an upper-case id from a client would compare
  // false against every list here while still being a perfectly valid account.
  const wireId = (v) => String(v == null ? '' : v).trim().toLowerCase();

  // WHO A report OR block FRAME IS ABOUT (BINDING.md resolution 24). Two routes
  // reach these two handlers and they are different fields, never
  // interchangeable:
  //
  //   `id`     — a uuid the SERVER itself handed this client, from a friends
  //              list, a search result or a blocked list. The friends-panel
  //              route, unchanged.
  //   `handle` — a per-room seat token from a lobby payload. Resolved through
  //              the room engine, in the caller's OWN room, or not at all.
  //
  // ONE FORM, NEVER EITHER. When `handle` is present it is the target and `id`
  // is not read as one — it goes back to being the pure correlation echo it is
  // on every other frame in this layer. If a raw uuid worked in `handle`, the
  // lobby leak this whole mechanism exists to avoid would be back through the
  // door marked exit: a modified client would send the id it was never given and
  // only the payload would have changed.
  //
  // AND IT RESOLVES BEFORE THE SHAPE TEST AND BEFORE THE SELF TEST, which is the
  // order and not a detail. A handle is not a uuid, so an isUuid ahead of this
  // refuses every honest frame with no_such_user; and a self-check run against an
  // unresolved handle compares a room token to an account id, is false for your
  // own seat, and lets a player report themselves. Resolve, then wireId, then
  // isUuid, then self, then the store.
  //
  // A miss — an unknown handle, an expired one, a seat with no account, a caller
  // who has left the room — comes back as '' and is answered no_such_user, which
  // is the honest word for it and the reason Task 8 must not offer Report on a
  // card whose room has ended.
  //
  // A THIRD ROUTE, `rid` (round 2 fix, 2026-10-08): a GUEST row of the
  // caller's own squad, named by its row handle, the one handle a guest row
  // has (its `id` is null by the frame's rule). It resolves to the anonymous
  // account behind the row (rowTarget), and to nothing for a guest with no
  // account, a member's row, or a row of any other squad. Same rule: when
  // `handle` is present it is the target, else `rid`, else `id`; never two.
  const targetId = (ws, msg) => wireId(msg.handle !== undefined ? resolveHandle(ws, msg.handle)
    : msg.rid !== undefined ? (rowTarget(ws, msg.rid) || {}).id : msg.id);

  // THE GUEST ROW A `rid` NAMES, in the caller's own squad, as
  // { id, shown, row, code, seat }: the anonymous account behind it, the name
  // the row shows now, the row, its squad's code and its seat number (from 1,
  // as the squad page numbers seats); or null. Only a GUEST row: a
  // member's row already carries its account id, which the friends-panel route
  // takes, and a guest row whose socket has signed in is the sign-in door's
  // (doorRow), which nothing may name. A guest with no account at all answers
  // id '' (final audit, 2026-10-09): targetId turns that into nobody, so a
  // block finds no one, and handleReport records the row instead
  // (reportGuestRow).
  function rowTarget(ws, rid) {
    if (typeof rid !== 'string' || !rid) return null;
    const own = squadOf(ws);
    if (!own) return null;
    const i = own.squad.members.findIndex((x) => rowRid(x) === rid), m = i < 0 ? null : own.squad.members[i];
    if (!m || !m.guest || doorRow(m)) return null;
    // THE NAME THE BOX LAST SHOWED FOR THE ROW (m.shown, boxNames), which is
    // the name a reporter saw (round 3 check fix, 2026-10-10). It was the
    // guest's own name (guestRowName), but since round 3 a row can be shown
    // the door's stand-in instead, and since this fix a row with no name of
    // its own is shown one too. A row no box has named has shown nothing.
    const shown = typeof m.shown === 'string' && m.shown ? m.shown : null;
    return { id: guestRowAccount(m), shown, row: m, code: own.squad.code, seat: i + 1 };
  }

  async function handleFriends(ws, msg) {

    if (!rateOk(ws, 'friends', LIMITS.friends)) return reply(ws, msg, { type: 'friends', error: 'slow_down' });
    // No try/catch: handle()'s net answers { type:'friends', error:'unavailable' }
    // for a throw here, which is the right frame. Note what it does NOT do —
    // send empty lists. A panel that renders "no friends yet" because PostgREST
    // was down is worse than one that says it could not load.
    reply(ws, msg, forSocket(ws, await friendsSnapshot(ws.userId)));
  }

  async function friendAdd(ws, msg) {
    const code = String(msg.code == null ? '' : msg.code).trim().toUpperCase().replace(/^FR-/, '');
    if (!/^[A-Z0-9]{6}$/.test(code)) return friendReply(ws, msg, 'add', { error: 'no_such_code' });
    const [them, rows] = await Promise.all([store.profileByFriendCode(code), callerRows(ws.userId)]);
    if (!them) return friendReply(ws, msg, 'add', { error: 'no_such_code' });
    if (them.id === ws.userId) return friendReply(ws, msg, 'add', { error: 'self' });
    const rel = relationOf(rows, them.id);
    if (rel.blocked) return friendReply(ws, msg, 'add', { error: 'blocked' });
    if (rel.blockedBy) return friendReply(ws, msg, 'add', { error: 'no_such_code' });
    if (rel.friend) return friendReply(ws, msg, 'add', { error: 'already' });
    // D2: a code or a link is mutual ON ENTRY — no request, straight to friends.
    // Whoever holds the code was given it, so the consent already happened.
    await store.addFriendship(ws.userId, them.id);
    // Any request either way is now spent. Left behind, the panel would show a
    // pending request to somebody who is already a friend.
    if (rel.incoming) await store.deleteRequest(them.id, ws.userId);
    if (rel.outgoing) await store.deleteRequest(ws.userId, them.id);
    // Named as the friends panel will name them (listNames): an account with
    // no chosen callsign by its reservation.
    const nameOf = await listNames([them.id], new Map([[them.id, them]]));
    friendReply(ws, msg, 'add', { ok: true, friend: { id: them.id, callsign: nameOf(them.id), online: isOnline(them.id) } });
    await pushBoth(ws.userId, them.id);
  }

  // Chosen names are unique, so an exact key match is 0 or 1 rows — there is no
  // list to page and no prefix search to abuse (design 4.2, row 3).
  async function friendSearch(ws, msg) {
    const none = () => friendReply(ws, msg, 'search', { results: [] });
    const key = callsignKeyOf(msg.q);
    if (!key) return none();
    const them = await store.profileByCallsignKey(key);
    if (!them || them.id === ws.userId) return none();
    const blocks = await store.blockIdsOf(ws.userId);
    // A MISS, not an error: "no such player" and "that player has blocked you"
    // must be the same answer, or search becomes a way to enumerate blocks.
    if (blockedEither(blocks, them.id)) return none();
    // BINDING resolution 19: spec 5.5 draws the found player's tank in their own
    // paint, so the result carries one — checked, never passed through.
    // Named through listNames like every list: a search finds an account by its
    // chosen callsign, which is then its name, so no reservation is read.
    const nameOf = await listNames([them.id], new Map([[them.id, them]]));
    friendReply(ws, msg, 'search', { results: [{ id: them.id, callsign: nameOf(them.id), skin: skinOf(them) }] });
  }

  async function friendRequest(ws, msg) {
    const to = wireId(msg.to);
    if (!isUuid(to)) return friendReply(ws, msg, 'request', { error: 'no_such_user' });
    if (to === wireId(ws.userId)) return friendReply(ws, msg, 'request', { error: 'self' });
    const [them, rows] = await Promise.all([store.profileById(to), callerRows(ws.userId)]);
    if (!them) return friendReply(ws, msg, 'request', { error: 'no_such_user' });
    const rel = relationOf(rows, to);
    if (rel.blocked) return friendReply(ws, msg, 'request', { error: 'blocked' });
    if (rel.blockedBy) return friendReply(ws, msg, 'request', { error: 'no_such_user' });
    if (rel.friend) return friendReply(ws, msg, 'request', { error: 'already' });
    if (rel.incoming) {
      // THEY ASKED FIRST, SO THIS REQUEST IS THE ACCEPTANCE (design 4.2, row 4).
      // Without this the two of them sit at "requested" for ever, each waiting
      // for an Accept button the other one cannot see, and nothing in the
      // product ever says why.
      await store.addFriendship(ws.userId, to);
      await store.deleteRequest(to, ws.userId);
      if (rel.outgoing) await store.deleteRequest(ws.userId, to);
      friendReply(ws, msg, 'request', { ok: true, state: 'friends' });
      return pushBoth(ws.userId, to);
    }
    if (rel.outgoing) return friendReply(ws, msg, 'request', { error: 'already' });
    await store.addRequest(ws.userId, to);
    friendReply(ws, msg, 'request', { ok: true, state: 'requested' });
    await pushBoth(ws.userId, to);
  }

  async function friendAccept(ws, msg) {
    const from = wireId(msg.from);
    if (!from) return friendReply(ws, msg, 'accept', { error: 'no_such_request' });
    const rel = await relationTo(ws.userId, from);
    // A BLOCK BEATS A REQUEST THAT PREDATES IT. accept is the only op that acts
    // on a row already sitting in the panel, so without this check a request
    // sent before a block is still a way in — for a player you blocked, and for
    // a player who blocked you. It is checked BEFORE the request exists, so
    // neither answer says whether there is one, and blocked by them it is
    // the answer a missing request gets.
    if (rel.blocked) return friendReply(ws, msg, 'accept', { error: 'blocked' });
    if (rel.blockedBy) return friendReply(ws, msg, 'accept', { error: 'no_such_request' });
    if (!rel.incoming) return friendReply(ws, msg, 'accept', { error: 'no_such_request' });
    await store.addFriendship(ws.userId, from);
    await store.deleteRequest(from, ws.userId);
    if (rel.outgoing) await store.deleteRequest(ws.userId, from);
    friendReply(ws, msg, 'accept', { ok: true });
    await pushBoth(ws.userId, from);
  }

  // ANSWERED FROM THE ROWS THE CALLER'S PANEL SHOWS, NOT FROM THE TABLE.
  // Decline and withdraw each act on one request row of the caller's, and
  // friendsSnapshot hides any request across a block either way. A block's
  // teardown deletes that row as it writes the block; when the delete threw,
  // the row OUTLIVES the block in the table while the panel already went on
  // without it. Answered from the raw rows, the op said ok about a request
  // the caller cannot see, where a request that is gone says
  // no_such_request, and that difference told the caller about a block
  // (D-BLOCK-4). So the row counts only if the panel would show it, by
  // friendsSnapshot's own block filter.
  //
  // THE BLOCK READ GOES OUT BESIDE THE REQUEST READ for every well-formed
  // id, never after a hit: a visible row, a hidden row and no row at all
  // then cost the same two reads in one round trip (D-BLOCK-5 I). Both are
  // the caller's own rows. A malformed id is in no list, so it is answered
  // before the store, for friendRequest's reason.
  //
  // A HIDDEN ROW IS ANSWERED no_such_request AND THEN DELETED, quietly: the
  // block meant to delete it, so the cleanup finishes that teardown and
  // changes no panel, which is why nobody is pushed. It goes AFTER the
  // answer, because a request that is really gone is answered without a
  // write, and an answer that waited for one would be the same tell by its
  // timing. A failed cleanup is swallowed: the answer is already out, the
  // row stays hidden, and the store's 30-day sweep collects it.
  //
  // AND IT IS NEVER AWAITED. The op runs inside handle()'s per-socket queue,
  // so a cleanup it awaited would hold the caller's NEXT social frame for the
  // write's round trip — up to the store's eight-second timeout in an outage
  // — where after a genuine miss that frame is answered at once. Any cheap
  // frame sent straight behind the op would then time the same tell. So the
  // op returns as a genuine miss returns, and the write finishes on its own.
  //
  // `side` is the caller's side of the row: 'incoming' (other > caller) or
  // 'outgoing' (caller > other). Answers 'shown', 'hidden' or null.
  async function requestRow(me, other, side) {
    const [reqs, blocks] = await Promise.all([store.requestsOf(me), store.blockIdsOf(me)]);
    if (!reqs[side].includes(other)) return null;
    return blocks.blocked.includes(other) || blocks.blockedBy.includes(other) ? 'hidden' : 'shown';
  }
  // NEVER REJECTS (a store that throws as it is called is caught too), so
  // the ops below can leave it running unawaited with no unhandled rejection.
  async function dropHiddenRequest(from, to) {
    try { await store.deleteRequest(from, to); } catch { /* the sweep collects it */ }
  }

  // Not gated on blocks, deliberately: declining only DELETES a row, and a
  // player must be able to clear any request their panel shows rather than
  // look at it for thirty days. One their panel hides is the block's to
  // clear, and goes the hidden way above.
  async function friendDecline(ws, msg) {
    const from = wireId(msg.from);
    const none = () => friendReply(ws, msg, 'decline', { error: 'no_such_request' });
    if (!isUuid(from)) return none();
    const row = await requestRow(ws.userId, from, 'incoming');
    if (row !== 'shown') {
      none();
      if (row === 'hidden') dropHiddenRequest(from, ws.userId);
      return;
    }
    await store.deleteRequest(from, ws.userId);
    friendReply(ws, msg, 'decline', { ok: true });
    await pushBoth(ws.userId, from);
  }

  // CANCEL, FOR A REQUEST THE CALLER SENT: the hand twin of D-BLOCK-5 J. When
  // A blocks B and A's own pending request to B is the only row between them,
  // the block deletes that request and B's panel is pushed without it. While
  // no hand act did the same, a request vanishing from B's panel could only
  // mean a block. Withdrawing deletes the same row and pushes both panels in
  // the same order the block does (the caller's, then theirs), so B receives
  // the same snapshot whichever of the two A did.
  //
  // Read from the caller's OWN rows and nothing else (requestRow above), and
  // not gated on blocks, for decline's reason: it only deletes a row of the
  // caller's. The same two reads go out whatever they hold, so a withdraw
  // aimed at someone who blocked the caller answers what a request that
  // never existed answers, at the same cost, whether the block took the
  // request with it or the request outlived the block, hidden from the
  // panel. A malformed `to` is in no list, so it is answered the same way
  // too, before the store.
  async function friendWithdraw(ws, msg) {
    const to = wireId(msg.to);
    const none = () => friendReply(ws, msg, 'withdraw', { error: 'no_such_request' });
    if (!isUuid(to)) return none();
    const row = await requestRow(ws.userId, to, 'outgoing');
    if (row !== 'shown') {
      none();
      if (row === 'hidden') dropHiddenRequest(ws.userId, to);
      return;
    }
    await store.deleteRequest(ws.userId, to);
    friendReply(ws, msg, 'withdraw', { ok: true });
    await pushBoth(ws.userId, to);
  }

  // Design 4.2 names this parameter `id`, which is also the correlation key the
  // contract echoes — for `remove` they are deliberately the same value, so the
  // echo comes back as the removed friend's uuid. A client must therefore match
  // this reply on type plus op and never treat `id` as unique per request
  // (BINDING resolution 3).
  async function friendRemove(ws, msg) {
    const id = wireId(msg.id);
    const ids = await store.friendIdsOf(ws.userId);
    if (!id || !ids.includes(id)) return friendReply(ws, msg, 'remove', { error: 'no_such_user' });
    await store.removeFriendship(ws.userId, id);
    friendReply(ws, msg, 'remove', { ok: true });
    await pushBoth(ws.userId, id);
  }

  const FRIEND_OPS = { add: friendAdd, search: friendSearch, request: friendRequest, accept: friendAccept, decline: friendDecline, withdraw: friendWithdraw, remove: friendRemove };
  // Design 4.2: friend add/search/request, ten a minute per socket. accept,
  // decline, withdraw and remove act on a row already on the player's screen,
  // cost one write each and cannot be aimed at a stranger, so they are not in
  // the bucket.
  const FRIEND_LIMITED = new Set(['add', 'search', 'request']);

  async function handleFriend(ws, msg) {
    const op = typeof msg.op === 'string' ? msg.op : '';
    const fn = FRIEND_OPS[op];
    // THE RATE CHECK COMES BEFORE THE ANSWER, INCLUDING FOR AN OP THAT DOES NOT
    // EXIST. An unknown op used to be answered above this line, which made it
    // the one path in the layer with no limit at all: a client sending
    // {type:'friend', op:'x'} got a frame back every time, as fast as the
    // engine's socket limiter would carry it. An unknown op costs no store read,
    // but it costs a reply, so it spends from the friend bucket like the rest.
    if ((!fn || FRIEND_LIMITED.has(op)) && !rateOk(ws, 'friend', LIMITS.friend)) return friendReply(ws, msg, op || 'unknown', { error: 'slow_down' });
    if (!fn) return friendReply(ws, msg, op || 'unknown', { error: 'unavailable' });
    // A catch of its own BESIDE handle()'s net, because this reply has to carry
    // the OP: a client with two friend answers outstanding cannot tell which one
    // failed from { type:'friend', error:'unavailable' } alone.
    try { await fn(ws, msg); }
    catch { friendReply(ws, msg, op, { error: 'unavailable' }); }
  }

  // ---- a block tears the pair out of a squad they share (R16) ---------------
  // design 4.2, the block row: "removes them from your squad if you lead it or
  // you from theirs". Called by handleBlock in the turn it asks for the block
  // row, and again in the turn that write's answer arrives.
  //
  // IN EVERY SQUAD THE TWO ACCOUNTS SHARE, WHOEVER DOES NOT LEAD IT GOES: the
  // blocked party when the blocker leads, otherwise the blocker. THE LEADER IS
  // NEVER THE ONE REMOVED — in the first case the leader is the blocker, in
  // the second the person removed is not the leader — so a block can never
  // hand a squad on and never end one (both were in it; one is left). A
  // hand-off would be an event the rest of the squad could time against the
  // block.
  //
  // WHO LEADS IS READ OFF EACH SQUAD, NOT OFF THE SOCKET, and ledSquad is the
  // wrong tool here on purpose. ledSquad answers "which squad may THIS SOCKET
  // command" — the squad its own row is in — and nothing here is a command
  // issued from a screen: the target is the account the block names, never an
  // index, and the only person ever removed besides the blocker is the
  // blocked party, from a squad the blocker's ACCOUNT leads. Asked through
  // ledSquad, a socket holding a guest row in one squad while its account
  // leads another reads "not leading" for the squad it does lead — and the
  // leader would be the one removed.
  //
  // THE ROWS ARE THE ACCOUNTS', found by rowsOf, so a GUEST is torn out like
  // anyone else. A guest may block (requireAccount, deliberately) and may be
  // blocked by the seat handle a lobby shows, and the squad a guest joined by
  // code is the one a Start seats them in again: a block that left a guest in
  // the blocker's squad would seat the two together on every Start.
  //
  // EVERY SQUAD IS SEARCHED, not only the ones a key reaches. An anonymous
  // account has no presence and its rows are keyed by socket, so when both
  // parties are anonymous and the block comes from a socket that holds no
  // row — a second tab, or the blocking tab after it signed in as somebody
  // else — no key leads to the squad they share. rowsOf judges every row by
  // the account it stands for now, and the captured blocker is its only
  // input; the acting socket is not asked at all.
  //
  // TO EVERYBODY BUT THE BLOCKER IT IS A KICK OR A LEAVE (D-BLOCK). When the
  // blocker leads, each removed row's socket gets exactly squadKick's victim
  // frame, before the roster, as a kick sends it; the blocked player's other
  // devices get nothing, as with a kick. When the blocker does not lead, the
  // squad sees a leave, and the blocker's own removed rows — the acting socket
  // included — are told `ended: left`, a reason only the blocker ever sees.
  //
  // THE REMOVAL IS NOW; THE TELLING IS RETURNED. handleBlock starts it in the
  // same turn, so each removed row's socket is sent its frame in the turn
  // its row goes, as squadKick sends its victim's, and awaits the rest (the
  // roster pushes) before its reply (members first, actor last), so neither
  // a reply that throws nor anything after it can skip either.
  //
  // EVERY SQUAD'S FRAMES FIRST, THEN THE ROSTERS (T6-R2-2). A roster push
  // waits on a name read. When the pair share two squads, frames sent squad
  // by squad would hold the second squad's kick behind the first squad's
  // read. In that gap a resume from the removed player answers gone before
  // the kick arrives, which is an order no real kick produces. So every
  // frame goes out synchronously, before the first await, whatever order the
  // squads were made in. The rosters then follow one squad at a time: a
  // throw costs that squad only, and a squad that lost a row is always told.
  //
  // THE BLOCKER IS WHO ASKED, NOT WHO THE SOCKET IS NOW (D-BLOCK-2 D).
  // handleBlock captures the account before its first await and hands it
  // here after one (the profile read), and again after the block row. A
  // socket that signed out, or said hello as somebody else, in between is
  // no longer the blocker's: read then, the block would tear down nothing,
  // or tear down squads of an account that blocked nobody. Nothing here
  // reads the socket, so its generation is not needed.
  function squadBlockTeardown(blocker, blocked) {
    const me = wireId(blocker), them = wireId(blocked);
    const tell = [];
    for (const sq of squads.all()) {
      const t = { sq, out: [], frame: null };
      try {
        const mine = rowsOf(sq, me), theirs = rowsOf(sq, them);
        // NO SHARED SQUAD IS THE ORDINARY CASE, and this is the whole guard:
        // each of them may lead a squad of their own, and a block is no
        // reason to touch one the other player is not in.
        if (!mine.length || !theirs.length) continue;
        const leads = sq.leader === me;
        t.frame = { type: 'squad', op: 'ended', reason: leads ? 'kicked' : 'left' };
        for (const m of leads ? theirs : mine) {
          const was = m.ws;
          if (!squads.removeMember(sq.code, m.key).squad) continue;
          if (!tell.includes(t)) tell.push(t);
          if (was) t.out.push(was);
        }
      } catch { /* this squad's teardown only */ }
    }
    return async () => {
      for (const t of tell) for (const w of t.out) safeSend(w, t.frame);
      for (const t of tell) await pushSquadAfterExit(t.sq).catch(() => {});
    };
  }

  // ---- blocks (design 4.2; Apple Guideline 1.2, "the ability to block") ------
  // THE ONE SOCIAL ACT THAT DESTROYS STATE. `add` writes the block row and then
  // clears everything the pair had: the friendship, and the pending request in
  // BOTH directions. Each of those is a way back in that the row alone would
  // leave standing — a friendship an unblock would silently hand back, and a
  // request that walks the same person in the moment it is accepted. The
  // blocker is then pushed a fresh snapshot, and so is the blocked player
  // when the block took a row their panel showed (T6-R1-1): their box must
  // stop showing someone who is gone, without being told why, and a box
  // that showed nothing of the blocker is sent nothing.
  //
  // THE ORDER OF THE WRITES IS PART OF THE DESIGN, not an accident of typing.
  // There is no transaction across PostgREST calls, so a failure half way
  // through leaves one of two states and only one of them is safe. Block first,
  // teardown after: a block row with a friendship that outlived it is hidden by
  // friendsSnapshot and by flushPresence, both of which read the blocks
  // themselves, whereas a deleted friendship with no block row is silent data
  // loss for a player who is not even protected. Tested both ways round.
  //
  // REMOVING THE PAIR FROM A SQUAD THEY SHARE — the other half of the 4.2 rule
  // (R16) — is squadBlockTeardown above, tested in test/squad.mjs (blk-*,
  // jn-*, inv-l, sg-*, lg-*). It runs THE MOMENT THE BLOCK ROW IS ASKED FOR,
  // before the answer, the unfriend and the request deletes: a squad is
  // memory, so it moves none of the writes. Run after them it left the pair
  // co-members for three round trips (T6-R1-1), and run at the answer for
  // one (T6-R1-2), when a Start could seat them together. It runs again as
  // the answer arrives. An addBlock that throws is treated as landed for
  // this half, because it may have been (T6-R2-4) or may be later. The blocked
  // party leaves the blocker's squad when the blocker leads it, otherwise the
  // blocker leaves theirs; what the others receive is a kick or a leave
  // (D-BLOCK): no frame names the block, though probing can still infer it
  // (D-BLOCK-2 A). Three other doors keep the pair apart afterwards — join,
  // invite and signing in (the sign-in door). The pending set, from the ask
  // to the answer, and the recent-blocks log, written as the answer
  // arrives, close the race between a block and a join, an invite or a
  // sign-in whose block read was already out; a pair whose addBlock threw
  // and may still commit is kept 16 s past its answer, for a row that
  // commits late (D-BLOCK-5 K; a refusal cannot, and is not kept, T6-R1-1).
  // Every known way in passes
  // one of them (server.js's push-subscription sink goes through the hello
  // path now, see the sign-in door); the second teardown stays, in depth,
  // for a row something might still move there meanwhile.
  //
  // WHO IS BLOCKING IS CAPTURED ON ENTRY (D-BLOCK-2 D): the account, before
  // the first await. Every write, the teardown and the friends pushes act
  // for the account that asked, even if this socket has signed out or
  // become somebody else by the time they run.
  //
  // NO PER-TYPE RATE LIMIT, and that is the spec rather than an oversight:
  // design 4.2 limits friend, callsign and report and says nothing about block,
  // because a player in trouble must be able to block several people quickly.
  // The engine's 60 frames/s socket limiter (MSG_RATE / MSG_BURST in server.js)
  // is what bounds it.
  // The blocked list, and NOTHING else in it. `blocked` carries the same
  // { id, callsign } rows friendsSnapshot's own Blocked list does, resolved
  // through the same displayName, so Task 8 renders one shape whatever kind of
  // account is looking. blockIdsOf answers both directions and only ONE of them
  // is sent: who blocked YOU is not yours to know, or a list becomes a way to
  // enumerate it. No friend code, no friends, no requests.
  async function blockList(ws, msg) {
    // A READ, SO IT SPENDS FROM THE READ MODEL'S BUCKET. D9 leaves add and remove
    // unlimited on purpose — a player in trouble must be able to block several
    // people quickly, and design 4.2 rate limits no write here — but this op
    // writes nothing and costs three PostgREST round trips (blockIdsOf's two plus
    // one profilesByIds; four when a blocked account has no chosen callsign and
    // its reservation is read, listNames), which is the friends frame's shape
    // and is bounded the way that one is. A list opens; it does not poll.
    if (!rateOk(ws, 'friends', LIMITS.friends)) return reply(ws, msg, { type: 'block', op: 'list', error: 'slow_down' });
    const { blocked } = await store.blockIdsOf(ws.userId);
    const names = blocked.length ? await store.profilesByIds(blocked) : new Map();
    // Named as friendsSnapshot's blocked list names them (listNames), so the
    // two lists never disagree about one account.
    const nameOf = await listNames(blocked, names);
    // THE ID IS AN UNBLOCK KEY, NOT THE ACCOUNT — see BLOCK_KEY_SECRET. This
    // reply and friendsSnapshot's own blocked array are the two places a
    // stranger's account id used to leave the server, and they are the same
    // shape on purpose so the client renders one card for both kinds of account.
    reply(ws, msg, { type: 'block', op: 'list', ok: true, blocked: blocked.map((id) => ({ id: blockKey(ws, id), callsign: nameOf(id) })) });
  }

  // WHAT A BLOCK WILL TAKE FROM THE BLOCKED PLAYER'S PANEL (T6-R1-1): true
  // when `me` and `other` are friends or either has a pending request to the
  // other, false when neither, null when the rows could not be read. Only
  // `me`'s rows are read, because a friendship or a request is one row seen
  // from both sides. A request past its 30 days is not read, and their panel
  // never showed it. Never rejects: these rows decide a push and nothing
  // else, so a failed read cannot fail the block.
  async function panelRows(me, other) {
    try {
      const [ids, reqs] = await Promise.all([store.friendIdsOf(me), store.requestsOf(me)]);
      return ids.includes(other) || reqs.incoming.includes(other) || reqs.outgoing.includes(other);
    } catch { return null; }
  }

  async function handleBlock(ws, msg) {
    const op = typeof msg.op === 'string' ? msg.op : '';
    // Answered rather than dropped, and answered the way an unknown friend op
    // is: a client that gets nothing back waits for its reply for ever.
    if (op !== 'add' && op !== 'remove' && op !== 'list') return reply(ws, msg, { type: 'block', op: op || 'unknown', error: 'unavailable' });
    // WHO IS BLOCKING, captured before the first await (D-BLOCK-2 D; see the
    // header above). Everything below acts for this account.
    const blocker = ws.userId;
    // A BLOCK MUST NOT BE A ONE-WAY DOOR. requireAccount lets a GUEST write a
    // block row, and the blocked list lived ONLY inside friendsSnapshot, behind
    // requireLinked — so a guest could block somebody and then never see or lift
    // it. An action a player cannot undo is worse than one they were never
    // offered, and this is the cheapest shape that closes it: the frame type is
    // already in SOCIAL_TYPES, already behind requireAccount and already carries
    // an op on every reply, so server.js needs no change, the friends gate does
    // not move, and this path reads the blocks table and nothing else. It CANNOT
    // widen the panel by accident, which teaching friendsSnapshot to answer a
    // guest could: that would mean a second shape of that frame, a guest branch
    // through its eight round trips, and ensureFriendCode minting a friend code
    // for an anonymous account that must never become addable.
    //
    // A catch of its own, for the reason handleFriend has one: the reply has to
    // carry the op a client is waiting on.
    if (op === 'list') {
      try { await blockList(ws, msg); }
      catch { reply(ws, msg, { type: 'block', op: 'list', error: 'unavailable' }); }
      return;
    }
    // THE HANDLE IS RESOLVED FIRST — see targetId. Ahead of the shape test
    // because a handle is not a uuid, and ahead of the self test because an
    // unresolved handle never equals ws.userId.
    let id = targetId(ws, msg);
    // AND AN UNBLOCK KEY IS RESOLVED WITH IT, on remove only, before the same
    // shape test. The blocked list no longer hands out account ids (see
    // BLOCK_KEY_SECRET), so the id the client sends back from a Blocked card is
    // this connection's key and would otherwise fail isUuid as no_such_user.
    //
    // ONLY ON REMOVE, and only when the value is not already a uuid. `add` is
    // never reached this way: a key is issued only for an account this socket
    // has ALREADY blocked, so it can add nothing new, and leaving it out of add
    // keeps the two routes in resolution 24 — a uuid the server handed out, or a
    // seat handle — as the only ways to acquire a target. A uuid is still
    // accepted here too, because a client that legitimately holds one (the
    // friends panel's own lists) must still be able to lift a block.
    //
    // THE STORE CALL NEEDS THE NET that the shape test sits in front of, so it
    // carries its own: a throw here is 'unavailable', exactly as a throw inside
    // the main try below is, and a key that matches no row of this account's is
    // no_such_user — the same word an unknown uuid gets.
    if (op === 'remove' && !isUuid(id) && BLOCK_KEY_RE.test(id)) {
      try { id = await resolveBlockKey(ws, id); }
      catch { return reply(ws, msg, { type: 'block', op, error: 'unavailable' }); }
    }
    // THE SHAPE TEST BEFORE THE STORE, for the reason friendRequest has one:

    // server/store.js throws 'bad uuid' on a malformed id and the net would
    // answer 'unavailable', which is the wrong word for a frame that was simply
    // misaddressed — after a round trip spent to say it.
    if (!isUuid(id)) return reply(ws, msg, { type: 'block', op, error: 'no_such_user' });
    // wireId lower-cased it, so the same account spelled in another case is
    // caught here rather than inside store.addBlock, which throws 'pair self'
    // and would be answered 'unavailable'.
    if (id === wireId(blocker)) return reply(ws, msg, { type: 'block', op, error: 'self' });
    let outcome;
    // WHETHER THE BLOCK TOOK A ROW THE BLOCKED PLAYER'S PANEL SHOWED
    // (T6-R1-1): true, false, or null when those rows could not be read. It
    // is the only thing that decides their push below.
    let touched = null;
    // THE BLOCK ROW IS THE ANSWER, AND THIS IS WHAT REMEMBERS IT LANDED. The row
    // is written first and the teardown follows, so a failure after it leaves a
    // player who really IS blocked — friendsSnapshot and flushPresence both read
    // the blocks themselves, so the survivor is invisible either way. Answering
    // 'unavailable' there told the player it had not worked in the one moment
    // that matters and suppressed BOTH panel pushes, so their own list went on
    // showing the person they had just blocked. Recovery converged on a retry
    // because every write here is idempotent, but the reply was a lie. The reply
    // now reports what actually happened: the block stands, the cleanup is what
    // was lost, and the read model covers for it.
    let wrote = false;
    // The squad half's telling, started as addBlock is asked, and the second
    // one, started as its answer arrives (see R16 below).
    let telling = null, again = null;
    try {
      if (op === 'add') {
        const who = await store.profileById(id);
        if (!who) outcome = { type: 'block', op, error: 'no_such_user' };
        else {
          // THE PAIR IS PARTED AS THE ROW IS ASKED FOR (R16; T6-R1-1, then
          // T6-R1-2), not when the answer comes back. Start reads no blocks,
          // so a Start while the row was out would seat the pair side by
          // side, and since T6-R2-4 an asked block parts them on every path
          // anyway: waiting for the answer changed nothing but that window.
          // Every removed row's socket, in every squad the pair share, is
          // told in this turn, as squadKick tells its victim in the turn it
          // removes the row. The roster pushes that follow run beside the
          // writes and are awaited before the reply. They cannot reject (the
          // telling contains its own faults), and the catch is there so that
          // nothing ever could while the writes are awaited.
          //
          // AND THE PAIR IS PENDING until the answer is in and it is logged:
          // a join, a sign-in or an invite whose block read comes back
          // meanwhile treats it as blocked (see blockPending).
          //
          // Nothing from here to the teardown can throw (a string, a Set, a
          // loop with a catch per squad), so the teardown needs no net: the
          // one that hung off an `asked` flag (T6-R2-4) had nothing left to
          // catch once the teardown moved up to the ask.
          const pend = { blocker: wireId(blocker), blocked: id };
          blockPending.add(pend);
          telling = squadBlockTeardown(blocker, id)().catch(() => {});
          // What the blocked player's panel showed of the blocker, read
          // beside the write and before the deletes that change it.
          const rows = panelRows(blocker, id);
          let failed = true, refused = false;
          try { await store.addBlock(blocker, id); failed = false; }
          catch (e) { refused = isRefusal(e); throw e; }
          finally {
            // THE ANSWER IS IN, WHATEVER IT IS. A failure that may still
            // commit is noted as thrown (see blockThrown), for a row that
            // commits late; a refusal never lands and is not. The pair is
            // logged for every read still out, and only then stops being
            // pending. A note or a log that throws leaves it pending, and so
            // apart. The teardown then runs AGAIN, for anything that reached
            // a shared squad while the row was out by a way no door stands on
            // (none is known; defence in depth, see the sign-in door).
            // Usually it finds nothing, and then it removes and sends nothing.
            try { if (failed && !refused) noteThrown(blocker, id); logBlock(blocker, id); blockPending.delete(pend); } catch { /* still pending */ }
            again = squadBlockTeardown(blocker, id)().catch(() => {});
          }
          wrote = true;
          touched = await rows;
          await store.removeFriendship(blocker, id);
          await store.deleteRequest(blocker, id);
          await store.deleteRequest(id, blocker);
          outcome = { type: 'block', op, ok: true };
        }
      } else {
        // NO PROFILE LOOKUP ON REMOVE, and no complaint when there was no row.
        // A block can point at an account that has since been deleted, and
        // refusing to clear it would strand the blocker with a block they
        // cannot lift.
        await store.removeBlock(blocker, id);
        outcome = { type: 'block', op, ok: true };
      }
    } catch {
      // Only a failure BEFORE the row landed is a failure to the player. After
      // it, the block is in force and saying otherwise is the misleading half of
      // a half-finished operation; the pushes go out for the same reason.
      //
      // AN addBlock THAT THREW MAY STILL HAVE LANDED (T6-R2-4), or may land
      // later, and nothing here can tell which, so it is treated as landed,
      // the safe way round: the pair was parted as the row was asked for,
      // logged as the answer came, and is kept apart for BLOCK_LOG_MS after
      // it (D-BLOCK-5 K). If the row never lands, the parting is a kick or a
      // leave that the blocker asked for, and it names nothing; the cost is
      // 16 s in which the pair cannot meet again. The one failure that can
      // be told is a REFUSAL (isRefusal, T6-R1-1): the row was refused and
      // never lands, so it is parted and logged like any other answer and
      // not kept after it. The player is answered unavailable either way,
      // because the block may not stand, and a retry is idempotent. A block
      // that failed BEFORE it was asked (its profile read) wrote nothing, and
      // is neither parted, logged nor noted.
      outcome = wrote ? { type: 'block', op, ok: true } : { type: 'block', op, error: 'unavailable' };
    }
    // R16, THE SQUAD HALF OF A BLOCK. It ran above, as the row was asked for,
    // and again as the answer came, on every path that may leave a block row
    // behind: the clean one, a throw after the row landed, and an addBlock
    // that threw. A block that failed before it was asked parts nobody. The
    // removals and the tellings are all done BEFORE the reply (members
    // first, actor last: pushSquad's rule), so a reply that throws cannot
    // skip any of them.
    if (telling) await telling;
    if (again) await again;
    reply(ws, msg, outcome);
    if (!outcome.ok) return;
    await pushFriends(blocker);
    // ONLY WHEN THE BLOCK TOOK A ROW THEIR PANEL SHOWED (T6-R1-1): the
    // friendship, or a request either way. Then their panel really did
    // change, and it is rebuilt as an unfriend, a decline or (for the
    // blocker's own request, D-BLOCK-5 J) a withdraw rebuilds it.
    // Otherwise nothing of theirs changed, and no hand act ever sends a
    // friends frame to a player whose panel did not change: beside a kick,
    // a leave or nothing at all, it would say they had been blocked. Rows
    // that could not be read push nothing either, which is what an unfriend
    // gives when its own snapshot read fails. On REMOVE nothing is pushed to
    // them for the same reason. A block is silent in both directions, going
    // on and coming off.
    if (touched) await pushFriends(id);
  }

  // ---- name reports (design 4.2; Apple Guideline 1.2, "a mechanism to report")
  // There is no email provider in this build (design 3.2), so a report surfaces
  // in exactly two places: the name_reports table and one line on stdout.
  //
  //   [report] <reported-uuid> "<callsign>" by <reporter-uuid>
  //
  // The reported uuid is there so the owner can find the row and the account;
  // the quoted callsign is there because it IS the report, and it is already
  // public — every player who saw that name saw it; the reporter uuid is there
  // so one person filing many reports is visible at a glance. Both uuids stay
  // in the log and in the table and never reach another player, in any frame.
  async function handleReport(ws, msg) {
    // THE RATE CHECK IS FIRST — before the shape and self guards, and long
    // before any store call. Two reasons, and the second is the one that bites.
    // The limit exists to stop a loop reaching the database at all, so spending
    // a query to answer slow_down defeats it. And a REFUSAL IS STILL A REPLY:
    // a check placed after the guards leaves a loop of self-reports or junk ids
    // answered as fast as the socket limiter will carry them, with no limit of
    // its own — the exact hole the unknown friend op had before (i3) closed it.
    if (!rateOk(ws, 'report', LIMITS.report)) return reply(ws, msg, { type: 'report', error: 'slow_down' });
    // THE HANDLE IS RESOLVED FIRST — see targetId. Both orderings matter here:
    // isUuid ahead of it refuses every honest lobby report, and the self check
    // ahead of it lets a player report their own seat's handle.
    const id = targetId(ws, msg);
    // AND THE NAME THAT SEAT SHOWED, read in the same tick as the handle
    // resolved, before any await can let the seat leave the room. See `seen`
    // below for why a seat's name outranks the profile's.
    // A GUEST ROW named by `rid` records the name the row showed (round 2
    // fix), through the same shape test, so the log line stays safe.
    const shown = msg.handle !== undefined ? seatShown(seatName(ws, msg.handle))
      : msg.rid !== undefined ? seatShown((rowTarget(ws, msg.rid) || {}).shown) : null;
    // A GUEST ROW WITH NO ACCOUNT BEHIND IT has no uuid to file against, and
    // is reported by its row instead (reportGuestRow, final audit 2026-10-09).
    // Resolved in the same tick as the two reads above, so it is the same row.
    if (msg.handle === undefined && msg.rid !== undefined && !isUuid(id)) {
      const t = rowTarget(ws, msg.rid);
      if (t && !t.id) return reportGuestRow(ws, msg, t, shown);
    }
    if (!isUuid(id)) return reply(ws, msg, { type: 'report', error: 'no_such_user' });

    if (id === wireId(ws.userId)) return reply(ws, msg, { type: 'report', error: 'self' });
    // NO try/catch OF ITS OWN, unlike handleBlock next door, and the difference
    // is the reply rather than the risk. A block answer has to carry the `op` a
    // client is waiting on, so it needs a local catch to build that frame;
    // a report reply has no op, and handle()'s net already produces exactly
    // { type:'report', error:'unavailable', id } for a throw from here. A second
    // catch that can only ever build the identical frame is a branch no test can
    // fail on — Task 4's one-net-in-one-place, kept.
    const who = await store.profileById(id);
    if (!who) return reply(ws, msg, { type: 'report', error: 'no_such_user' });
    // A ROLLING 24 HOURS, not a calendar day: "one report per reporter per
    // reported per day" has to mean the same thing at 23:59 as it does at 00:01,
    // or a grudge gets two free reports either side of midnight. DAY is the
    // constant the chosen-callsign gate above already uses, for the same reason
    // — one definition of a day in this file, not two.
    if (await store.reportedSince(ws.userId, id, new Date(now() - DAY).toISOString())) return reply(ws, msg, { type: 'report', error: 'already' });
    // THE NAME AS SEEN — AND WHO CAN WRITE profiles.callsign? The account
    // ITSELF, on every cloud save (profiles_update_own, public/cloud.js
    // save()). So the raw column is free text, and handing it to addReport
    // would fill the moderation table with whatever the reported player
    // typed and write the same string into the log line below, where a
    // newline in it forges a line of its own.
    //
    // seenName is therefore the source, not the column: it is the string
    // another player was ACTUALLY shown, by one of the two proofs — the
    // name matches callsign_key (a chosen name the server stored, on a
    // column no client may write) or it is a curated rolled pair. Anything
    // else was never on anybody's screen, so there is nothing about it to
    // report, and reportCallsign turns the null into the store's sentinel
    // so the row still LANDS: a player who never chose a callsign must not
    // be the one player nobody can report. The reported uuid is what
    // identifies the account; the name is evidence beside it.
    //
    // NOT displayName, and the difference is the blocklist pass on the end
    // of it — see seenName above. A name blocklisted AFTER it was set is
    // the one case this feature exists for, and re-running the moved list
    // here recorded the sentinel while the name went on appearing in
    // lobbies. The blocklist decides what a player is SHOWN; the proof
    // decides what the owner is TOLD.
    //
    // reportCallsign is server/store.js's own function, applied here rather
    // than restated, so THE LINE IN THE LOG AND THE ROW IN THE TABLE ARE
    // THE SAME STRING — addReport applies it again on the way out and it is
    // idempotent. A log the moderation queue cannot be reconciled against
    // is worth less than no log.
    //
    // A REPORT AGAINST A LOBBY SEAT RECORDS THE SEAT'S NAME FIRST (round 2,
    // 2026-10-08). Since any player may present a name they typed, the name a
    // reporter saw on a seat is often one no profile row can prove, and
    // seenName recorded the '(no name)' sentinel for it: the evidence lost on
    // exactly the reports a typed name invites. The seat's name is proof of its
    // own kind. The room engine's door passed it at the moment it was
    // presented, and the seat, found by the handle in the reporter's own room,
    // still holds it. display-name.js seatName re-tests only its SHAPE, which
    // keeps this log line safe, and never the blocklist (seenName's reason).
    // A report by id (a friends list, a squad seat, an invite card) has no
    // seat, and records what seenName proves, as before.
    const seen = reportCallsign(shown ?? seenName(who));
    await store.addReport(ws.userId, id, seen);
    console.log(`[report] ${id} "${seen}" by ${ws.userId}`);
    reply(ws, msg, { type: 'report', ok: true });
  }

  // A REPORT ON A GUEST ROW WITH NO ACCOUNT (final audit, 2026-10-09). Such a
  // row now shows the guest's name (squadSnapshot), and every name shown to
  // another player can be reported. name_reports keys a report to the
  // reported ACCOUNT (its `reported` column is not null and references
  // auth.users), and this guest has none, so the report cannot be a row
  // there without a schema change that would have to ship and migrate with
  // the release. It goes where every report's second copy already goes, the
  // game server's log, and holds what the reporter saw and where:
  //
  //   [report] guest in squad <code> seat <n> "<name>" by <reporter-uuid>
  //
  // The row is named by its squad's code and its seat number as the reporter's
  // screen numbered it, and NEVER by its handle: a handle is a token for
  // addressing a row while it stands, and test/auth_sink.mjs (8c) keeps every
  // handle out of the report log, where it would outlive the row. The name is
  // `shown`, which passed seatShown's shape test, so the line is safe to
  // print; a nameless row showed nothing to report and is answered
  // no_such_user, the answer for any miss. One report per reporter per row
  // per day, as the table's rule is per pair, held in memory beside the row,
  // which lives no longer than its squad. A player's own row is 'self', though
  // a socket with an account never holds a row with none.
  const guestReports = new WeakMap();   // row -> Map(reporter id -> time)
  function reportGuestRow(ws, msg, t, shown) {
    if (t.row.ws === ws) return reply(ws, msg, { type: 'report', error: 'self' });
    if (!shown) return reply(ws, msg, { type: 'report', error: 'no_such_user' });
    const by = wireId(ws.userId), at = now();
    let done = guestReports.get(t.row);
    if (!done) { done = new Map(); guestReports.set(t.row, done); }
    if (done.has(by) && at - done.get(by) < DAY) return reply(ws, msg, { type: 'report', error: 'already' });
    done.set(by, at);
    console.log(`[report] guest in squad ${t.code} seat ${t.seat} "${shown}" by ${ws.userId}`);
    reply(ws, msg, { type: 'report', ok: true });
  }

  // presenceLast is handed out for the same reason `online` is, and for no
  // other: both are process-lifetime Maps keyed by account, so the only way a
  // test can assert they do not grow by an entry per account that has ever
  // connected is to look at them. Nothing outside writes to either. server.js
  // uses handle, onAuth and onClose, and hands hasSquad to the engine.
  //
  // hasSquad is handed out for ONE caller and one only, server.js, which uses
  // it twice: wired into the engine as setCodeTaken, so makeCode collides a
  // candidate against squads as well as rooms (plan R4), and as the squad arm
  // of the code frame it answers itself. It is the container's `has` and
  // nothing more — no squad, no member and no name leaves through it, and
  // there is no setter beside it. The same footing as `online` and
  // `presenceLast` above: a reader, never a door.
  return { handle, online, onAuth, onClose, presenceLast, hasSquad: (code) => squads.has(code), liveNames };
}
