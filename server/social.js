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
import { validateCallsign, normaliseCallsign, CALLSIGN_MIN, CALLSIGN_MAX } from './callsign.js';
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
import { isUuid, reportCallsign } from './store.js';
// THE NAME PROOFS. Written here, MOVED to server/display-name.js and imported
// back, because they now have TWO callers: this layer's panels and search
// results, and server.js's GET /history, which paints an opponent's name in
// the Bay's Recent sorties list (BINDING.md resolution 27). Copying the rule
// into the second caller would leave two copies to drift, and drift here fails
// OPEN on the one string every other player has to look at. The reasoning for
// each proof — and the two reviews and three decisions behind them — travelled
// with them; this layer's behaviour is unchanged.
import { createNameProofs } from './display-name.js';
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
// Supabase, no socket and no real clock here.
import { createHmac, randomBytes } from 'node:crypto';

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
export const SOCIAL_TYPES = new Set(['friends', 'friend', 'block', 'callsign', 'report', 'squad', 'code']);

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
const LIMITS = { callsign: 3, friend: 10, friends: 20, report: 5, squad: 20 };

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
// THIS LIST ACCUMULATES (plan X2). A later task adds its option after these;
// it never restates the line.
export function createSocial({
  store, terms, send, now,
  resolveHandle = () => null,
  roomExists = () => false,
  seats = {}, teeIds = [], validRack = () => false,
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
  function onAuth(ws) {
    if (!ws || !ws.userId || ws.isGuest) return;
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
  }

  // Call on close, and on a sign-out hello. Unlike the first version of this
  // function it does NOT depend on ws.userId still being set.
  function onClose(ws) {
    if (!ws) return;
    dropPresence(ws.socialUser || ws.userId, ws);
    ws.socialUser = null;
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
    const v = validateCallsign(msg.name, terms);
    if (!v.ok) return reply(ws, msg, { type: 'callsign', error: v.error });

    const profile = await store.profileById(ws.userId);
    // A null column, no row at all, or an unparseable timestamp all mean "no
    // set on record", so the change is allowed. Failing OPEN is deliberate: a
    // corrupt timestamp must not lock a player out of their own name for ever.
    const lastSet = profile && profile.callsign_set_at ? Date.parse(profile.callsign_set_at) : NaN;
    if (Number.isFinite(lastSet) && now() - lastSet < DAY) return reply(ws, msg, { type: 'callsign', error: 'too_soon' });

    // THE WRITE IS THE AUTHORITY on uniqueness, not a read before it: two
    // sockets can both read "free" and then both write. The unique index on
    // callsign_key decides, and the loser is told 'taken'.
    const res = await store.setChosenCallsign(ws.userId, v.name, v.key);
    if (!res || res.ok !== true) {
      // A closed set of codes. Anything the store invents stays inside the
      // server rather than reaching a client that has no string for it.
      return reply(ws, msg, { type: 'callsign', error: res && res.error === 'taken' ? 'taken' : 'unavailable' });
    }
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
    for (const w of socketsOf(ws.userId)) w.chosenName = v.name;
    ws.chosenName = v.name;
    reply(ws, msg, { type: 'callsign', ok: true, callsign: v.name });
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
          if (!requireLinked(ws, msg)) return;
          // AWAIT, not `return callsign(...)`. Returning the promise from
          // inside a try hands the rejection to the CALLER: the catch below
          // never runs, the client never gets a reply, and the whole net under
          // this function is decoration. Every await in here is deliberate.
          await callsign(ws, msg);
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
  // seenName — moved there whole, comments and all, because GET /history has to
  // prove an opponent's name the same way these panels prove a friend's and a
  // rule kept in two files drifts. Everything those comments record is still
  // binding: the OWN-callsign narrowness of provenName (resolution 13), what a
  // block does and does not promise (resolution 25), and why seenName skips the
  // blocklist pass that displayName applies (resolution 26).
  //
  // `terms` is this layer's own injected blocklist, and server.js passes the SAME
  // list to the same factory for /history — one file, one rule, one term list.
  const { provenName, rolledName, displayName, seenName } = createNameProofs({ terms });

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
  const squads = createSquads({ now, codeTaken: roomExists });

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
  const SQUAD_LINKED = new Set(['create', 'kick']);

  const squadReply = (ws, msg, op, rest) => reply(ws, msg, { type: 'squad', op, ...rest });

  async function handleSquad(ws, msg) {
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
    // Kept for the seating path, NEVER SHOWN: see squadSnapshot.
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
  // THIS — kick, mode, and every later one (start, invite...) — and none
  // re-derives the rule inline.
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

  // THE FRAME, WITHOUT `you` — the one field that differs per destination.
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
  async function squadSnapshot(sq) {
    const ids = sq.members.filter((m) => m.userId).map((m) => m.userId);
    let names = new Map();
    if (ids.length) {
      try { names = await store.profilesByIds(ids); }
      catch { /* every name null; every row kept */ }
    }
    return {
      type: 'squad', op: 'state', code: sq.code, leader: sq.leader,
      mode: sq.mode, tees: sq.tees, max: sq.max,
      members: sq.members.map((m) => ({
        id: m.userId,
        callsign: m.userId ? displayName(names.get(m.userId)) : null,
        guest: m.guest,
        online: m.userId ? isOnline(m.userId) : !!(m.ws && m.ws.readyState === 1),
        ready: m.ready,
        dropped: m.dropAt !== null,
      })),
      fits: fitsFor(sq.members.length),
    };
  }

  // THE FRAME AS ONE SOCKET MUST SEE IT (plan X4): the snapshot plus `you`,
  // the mirror of forSocket above. For a caller that answers ONE socket —
  // task 5's resume. A fan-out uses pushSquad, which builds the snapshot once
  // and applies the same youIn to every destination.
  async function squadFrame(sq, ws) {
    const base = await squadSnapshot(sq);
    return { ...base, you: youIn(sq, ws) };
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
  async function pushSquad(sq, actor, msg) {
    const base = await squadSnapshot(sq);
    for (const m of sq.members) {
      if (m.ws && m.ws !== actor) safeSend(m.ws, { ...base, you: youIn(sq, m.ws) });
    }
    if (actor) reply(actor, msg, { ...base, you: youIn(sq, actor) });
  }

  // A SQUAD SOMEBODY HAS JUST LEFT. `has` is the test, because the machine
  // deletes the squad but hands the object back with its members still on it
  // so exactly this can be done.
  async function pushSquadAfterExit(sq) {
    if (squads.has(sq.code)) return pushSquad(sq, null, null);
    // It is gone. Anyone still on the list is there because the last account
    // left and only guests remained: nobody can lead, the squad ended under
    // them, and a box still rendering it is a Start button that answers
    // nothing. An empty list means the leaver was the last member, and their
    // own answer is the whole story.
    for (const m of sq.members) if (m.ws) safeSend(m.ws, { type: 'squad', op: 'ended', reason: 'no_leader' });
  }

  // WHO A KICK IS AIMED AT. Two forms, and — the rule targetId below applies
  // to `handle` — ONE FORM, NEVER EITHER:
  //   `i`  — the row's index in the last snapshot, and the ONLY way to name a
  //          GUEST, whose row carries `id: null` by the frame's own rule.
  //          When `i` is present IT is the target, and `id` goes back to being
  //          the pure correlation echo it is on every other frame — which
  //          matters, because public/app.js's socialSend mints a numeric `id`
  //          onto every frame that carries none. Read `id` first and every
  //          index kick from the real client would miss.
  //   `id` — an account id the SERVER put in this squad's own roster. The
  //          ordinary case, and it names one person however the roster moves.
  // The index is accepted for a guest row and for nothing else, so a stale
  // index can MISS and be refused but can never land on a signed-in member
  // the leader did not aim at.
  const squadTarget = (sq, msg) => {
    if (msg.i !== undefined) {
      if (!Number.isInteger(msg.i)) return null;
      const m = sq.members[msg.i];
      return m && m.guest ? m : null;
    }
    const id = wireId(msg.id);
    return (id && sq.members.find((m) => m.userId === id)) || null;
  };

  async function squadCreate(ws, msg) {
    const from = squadKey(ws);
    const olds = squadsOfCaller(ws, from);
    const sq = squads.create(squadMemberOf(ws, msg), from);
    // THE SQUAD THEY JUST LEFT STILL HAS PEOPLE IN IT. create() leaves it as
    // its first act, so those left behind have a new leader — or none of them
    // can lead and it is gone. Either way they are owed the truth and nobody
    // is going to ask for it on their behalf. Told AFTER the creator is
    // answered, and in a finally, so a creator whose own socket throws on the
    // answer does not also cost them it.
    try { await pushSquad(sq, ws, msg); }
    finally { for (const o of olds) if (o !== sq) await pushSquadAfterExit(o); }
  }

  async function squadJoin(ws, msg) {
    // codeOf is the ONE normalisation of a code off the wire (see its note at
    // the top of this file): upper case, trimmed, bounded, and '' for a value
    // that is not a string. No shape test beside it — a string that is not a
    // live squad's code misses the machine's Map and is answered no_such_squad
    // either way, so a regex here could never be seen to do anything.
    const from = squadKey(ws);
    const olds = squadsOfCaller(ws, from);
    const res = squads.join(codeOf(msg.code), squadMemberOf(ws, msg), from);
    if (!res.ok) return squadReply(ws, msg, 'join', { error: res.error });
    try { await pushSquad(res.squad, ws, msg); }
    finally { for (const o of olds) if (o !== res.squad) await pushSquadAfterExit(o); }
  }

  async function squadLeave(ws, msg) {
    const res = squads.leave(squadKey(ws));
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
    // the leader, on both halves. Passing anything else would make the
    // machine a second, partial copy of that rule, and one that could hide a
    // broken half of ledSquad from every test of it.
    const res = squads.kick(sq.code, sq.leader, target.key);
    if (!res.ok) return squadReply(ws, msg, 'kick', { error: res.error });
    if (victim) safeSend(victim, { type: 'squad', op: 'ended', reason: 'kicked' });
    await pushSquad(sq, ws, msg);
  }

  SQUAD_OPS.create = squadCreate;
  SQUAD_OPS.join = squadJoin;
  SQUAD_OPS.leave = squadLeave;
  SQUAD_OPS.kick = squadKick;

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
    const nameOf = (id) => displayName(names.get(id));
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
  // once, concurrently, instead of three times down three branches.
  async function relationTo(me, other) {
    const [ids, reqs, blocks] = await Promise.all([
      store.friendIdsOf(me), store.requestsOf(me), store.blockIdsOf(me),
    ]);
    return {
      friend: ids.includes(other),
      incoming: reqs.incoming.includes(other),
      outgoing: reqs.outgoing.includes(other),
      // EITHER WAY. Blocking is not a mute: the player who blocked and the
      // player who was blocked are equally invisible to each other.
      blocked: blocks.blocked.includes(other) || blocks.blockedBy.includes(other),
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
  const targetId = (ws, msg) => wireId(msg.handle === undefined ? msg.id : resolveHandle(ws, msg.handle));

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
    const them = await store.profileByFriendCode(code);
    if (!them) return friendReply(ws, msg, 'add', { error: 'no_such_code' });
    if (them.id === ws.userId) return friendReply(ws, msg, 'add', { error: 'self' });
    const rel = await relationTo(ws.userId, them.id);
    if (rel.blocked) return friendReply(ws, msg, 'add', { error: 'blocked' });
    if (rel.friend) return friendReply(ws, msg, 'add', { error: 'already' });
    // D2: a code or a link is mutual ON ENTRY — no request, straight to friends.
    // Whoever holds the code was given it, so the consent already happened.
    await store.addFriendship(ws.userId, them.id);
    // Any request either way is now spent. Left behind, the panel would show a
    // pending request to somebody who is already a friend.
    if (rel.incoming) await store.deleteRequest(them.id, ws.userId);
    if (rel.outgoing) await store.deleteRequest(ws.userId, them.id);
    friendReply(ws, msg, 'add', { ok: true, friend: { id: them.id, callsign: displayName(them), online: isOnline(them.id) } });
    await pushBoth(ws.userId, them.id);
  }

  // Chosen names are unique, so an exact key match is 0 or 1 rows — there is no
  // list to page and no prefix search to abuse (design 4.2, row 3).
  async function friendSearch(ws, msg) {
    const none = () => friendReply(ws, msg, 'search', { results: [] });
    const q = normaliseCallsign(msg.q);
    // Code points, because that is how validateCallsign measured the name that
    // was stored: one astral letter is one character on both sides.
    const n = [...q].length;
    if (n < CALLSIGN_MIN || n > CALLSIGN_MAX) return none();
    const them = await store.profileByCallsignKey(q.toLowerCase());
    if (!them || them.id === ws.userId) return none();
    const blocks = await store.blockIdsOf(ws.userId);
    // A MISS, not an error: "no such player" and "that player has blocked you"
    // must be the same answer, or search becomes a way to enumerate blocks.
    if (blocks.blocked.includes(them.id) || blocks.blockedBy.includes(them.id)) return none();
    // BINDING resolution 19: spec 5.5 draws the found player's tank in their own
    // paint, so the result carries one — checked, never passed through.
    friendReply(ws, msg, 'search', { results: [{ id: them.id, callsign: displayName(them), skin: skinOf(them) }] });
  }

  async function friendRequest(ws, msg) {
    const to = wireId(msg.to);
    if (!isUuid(to)) return friendReply(ws, msg, 'request', { error: 'no_such_user' });
    if (to === wireId(ws.userId)) return friendReply(ws, msg, 'request', { error: 'self' });
    const them = await store.profileById(to);
    if (!them) return friendReply(ws, msg, 'request', { error: 'no_such_user' });
    const rel = await relationTo(ws.userId, to);
    if (rel.blocked) return friendReply(ws, msg, 'request', { error: 'blocked' });
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
    // a player who blocked you. It is checked BEFORE the request exists, so a
    // blocked player cannot use the two answers to probe for one.
    if (rel.blocked) return friendReply(ws, msg, 'accept', { error: 'blocked' });
    if (!rel.incoming) return friendReply(ws, msg, 'accept', { error: 'no_such_request' });
    await store.addFriendship(ws.userId, from);
    await store.deleteRequest(from, ws.userId);
    if (rel.outgoing) await store.deleteRequest(ws.userId, from);
    friendReply(ws, msg, 'accept', { ok: true });
    await pushBoth(ws.userId, from);
  }

  // Not gated on blocks, deliberately: declining only DELETES a row, and a
  // player who blocks someone must still be able to clear the request they left
  // behind rather than look at it for thirty days.
  async function friendDecline(ws, msg) {
    const from = wireId(msg.from);
    const reqs = await store.requestsOf(ws.userId);
    if (!from || !reqs.incoming.includes(from)) return friendReply(ws, msg, 'decline', { error: 'no_such_request' });
    await store.deleteRequest(from, ws.userId);
    friendReply(ws, msg, 'decline', { ok: true });
    await pushBoth(ws.userId, from);
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

  const FRIEND_OPS = { add: friendAdd, search: friendSearch, request: friendRequest, accept: friendAccept, decline: friendDecline, remove: friendRemove };
  // Design 4.2: friend add/search/request, ten a minute per socket. accept,
  // decline and remove act on a row already on the player's screen, cost one
  // write each and cannot be aimed at a stranger, so they are not in the bucket.
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

  // ---- blocks (design 4.2; Apple Guideline 1.2, "the ability to block") ------
  // THE ONE SOCIAL ACT THAT DESTROYS STATE. `add` writes the block row and then
  // clears everything the pair had: the friendship, and the pending request in
  // BOTH directions. Each of those is a way back in that the row alone would
  // leave standing — a friendship an unblock would silently hand back, and a
  // request that walks the same person in the moment it is accepted. Both
  // parties are then pushed a fresh snapshot: the blocked player's box must
  // stop showing someone who is gone, without being told why.
  //
  // THE ORDER OF THE WRITES IS PART OF THE DESIGN, not an accident of typing.
  // There is no transaction across PostgREST calls, so a failure half way
  // through leaves one of two states and only one of them is safe. Block first,
  // teardown after: a block row with a friendship that outlived it is hidden by
  // friendsSnapshot and by flushPresence, both of which read the blocks
  // themselves, whereas a deleted friendship with no block row is silent data
  // loss for a player who is not even protected. Tested both ways round.
  //
  // Removing the blocked party from a SQUAD — the other half of the 4.2 rule —
  // is PROJECT 3. There are no squads in this build, so it is not implemented
  // here and has no test here.
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
    // one profilesByIds), which is the friends frame's shape and is bounded the
    // way that one is. A list opens; it does not poll.
    if (!rateOk(ws, 'friends', LIMITS.friends)) return reply(ws, msg, { type: 'block', op: 'list', error: 'slow_down' });
    const { blocked } = await store.blockIdsOf(ws.userId);
    const names = blocked.length ? await store.profilesByIds(blocked) : new Map();
    // THE ID IS AN UNBLOCK KEY, NOT THE ACCOUNT — see BLOCK_KEY_SECRET. This
    // reply and friendsSnapshot's own blocked array are the two places a
    // stranger's account id used to leave the server, and they are the same
    // shape on purpose so the client renders one card for both kinds of account.
    reply(ws, msg, { type: 'block', op: 'list', ok: true, blocked: blocked.map((id) => ({ id: blockKey(ws, id), callsign: displayName(names.get(id)) })) });
  }

  async function handleBlock(ws, msg) {
    const op = typeof msg.op === 'string' ? msg.op : '';
    // Answered rather than dropped, and answered the way an unknown friend op
    // is: a client that gets nothing back waits for its reply for ever.
    if (op !== 'add' && op !== 'remove' && op !== 'list') return reply(ws, msg, { type: 'block', op: op || 'unknown', error: 'unavailable' });
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
    if (id === wireId(ws.userId)) return reply(ws, msg, { type: 'block', op, error: 'self' });
    let outcome;
    let alsoPush = null;
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
    try {
      if (op === 'add') {
        const who = await store.profileById(id);
        if (!who) outcome = { type: 'block', op, error: 'no_such_user' };
        else {
          await store.addBlock(ws.userId, id);
          wrote = true;
          await store.removeFriendship(ws.userId, id);
          await store.deleteRequest(ws.userId, id);
          await store.deleteRequest(id, ws.userId);
          outcome = { type: 'block', op, ok: true };
          alsoPush = id;
        }
      } else {
        // NO PROFILE LOOKUP ON REMOVE, and no complaint when there was no row.
        // A block can point at an account that has since been deleted, and
        // refusing to clear it would strand the blocker with a block they
        // cannot lift.
        await store.removeBlock(ws.userId, id);
        outcome = { type: 'block', op, ok: true };
      }
    } catch {
      // Only a failure BEFORE the row landed is a failure to the player. After
      // it, the block is in force and saying otherwise is the misleading half of
      // a half-finished operation; the pushes go out for the same reason.
      if (wrote) { outcome = { type: 'block', op, ok: true }; if (op === 'add') alsoPush = id; }
      else outcome = { type: 'block', op, error: 'unavailable' };
    }
    reply(ws, msg, outcome);
    if (!outcome.ok) return;
    await pushFriends(ws.userId);
    // ONLY ON ADD. The blocked player's own panel really did change — the
    // friendship is gone — so it has to be rebuilt. On REMOVE nothing of theirs
    // changed, and an unsolicited frame at the moment somebody lifts a block is
    // a timing signal that they had been blocked. A block is silent in both
    // directions, going on and coming off.
    if (alsoPush) await pushFriends(alsoPush);
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
    const seen = reportCallsign(seenName(who));
    await store.addReport(ws.userId, id, seen);
    console.log(`[report] ${id} "${seen}" by ${ws.userId}`);
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
  return { handle, online, onAuth, onClose, presenceLast, hasSquad: (code) => squads.has(code) };
}
