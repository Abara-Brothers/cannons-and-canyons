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
import { isUuid } from './store.js';

// The frame types that belong here and never reach the engine. server.js
// imports this set to decide what to intercept; keep it in step with the
// switch in handle() below.
export const SOCIAL_TYPES = new Set(['friends', 'friend', 'block', 'callsign', 'report']);

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
const LIMITS = { callsign: 3, friend: 10, friends: 20, report: 5 };

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

export function createSocial({ store, terms, send, now }) {
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
    ws.chosenName = v.name;
    reply(ws, msg, { type: 'callsign', ok: true, callsign: v.name });
  }

  async function handle(ws, msg) {
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
        case 'report':
          // Open to a guest on purpose — see requireAccount above.
          if (!requireAccount(ws, msg)) return;
          return reply(ws, msg, { type: msg.type, error: 'unavailable' });
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
  // WHO CAN WRITE THIS COLUMN? profiles.callsign is PATCHed by the account
  // itself on every cloud save (profiles_update_own; public/cloud.js save()).
  // profiles.callsign_key beside it is NOT — the phase 6 migration revokes
  // update on it from the authenticated role, so the key is the only part of
  // that row the server is entitled to believe. Task 4 closed this exact hole in
  // the auth sink; the friends frame and the search reply are two more doors to
  // it, and they are shut the same way.
  const provenName = (row) => {
    const key = row && typeof row.callsign_key === 'string' ? row.callsign_key : '';
    if (!key) return null;
    // validateCallsign stored key = normaliseCallsign(name).toLowerCase(), so
    // the SHARED normaliser is by construction the one that wrote it. A second
    // copy could only drift open.
    const shown = normaliseCallsign(row.callsign);
    return shown.toLowerCase() === key ? shown : null;
  };

  // A second pass over a name the key already proved. The blocklist is read at
  // START-UP and a term can be added to it after a name was set, so a name that
  // was clean when it was stored is checked again at the moment it is shown.
  // This is belt and braces on top of provenName, NOT a substitute for it: the
  // character class here is letters, digits and spaces, so plenty of unwanted
  // text passes it, and a name it passes is still only a string the account
  // itself wrote unless a key stands behind it.
  const presentable = (raw) => { const v = validateCallsign(raw, terms); return v.ok ? v.name : null; };

  // WHAT ANOTHER PLAYER IS SHOWN FOR A ROW: the name the SERVER stored, proven
  // against callsign_key, and nothing else. A row with no key — an account
  // holding only a rolled name — is shown as null, because its display column is
  // free text the account PATCHes itself and there is nothing to check it
  // against. That is the invariant this release committed to, and the blocklist
  // is not a stand-in for it: 'FOLLOW ME OK' is clean, in class and in length,
  // and an account with a rolled name could put ANOTHER PLAYER'S chosen callsign
  // there and render identically in a panel — with a name report then pointing
  // at the wrong account. Search hands out an id for any known callsign and a
  // request puts the requester's name into the target's incoming list, so this
  // is reachable against any account whose callsign is known.
  //
  // null keeps the ROW — and Task 8's Report and Block buttons on it — in place,
  // which dropping the entry would not. Task 8 renders the fallback copy.
  const displayName = (row) => {
    const shown = provenName(row);
    return shown === null ? null : presentable(shown);
  };

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
    for (const w of live) safeSend(w, snap);
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

  async function handleFriends(ws, msg) {
    if (!rateOk(ws, 'friends', LIMITS.friends)) return reply(ws, msg, { type: 'friends', error: 'slow_down' });
    // No try/catch: handle()'s net answers { type:'friends', error:'unavailable' }
    // for a throw here, which is the right frame. Note what it does NOT do —
    // send empty lists. A panel that renders "no friends yet" because PostgREST
    // was down is worse than one that says it could not load.
    reply(ws, msg, await friendsSnapshot(ws.userId));
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

  // presenceLast is handed out for the same reason `online` is, and for no
  // other: both are process-lifetime Maps keyed by account, so the only way a
  // test can assert they do not grow by an entry per account that has ever
  // connected is to look at them. Nothing outside writes to either. server.js
  // uses handle, onAuth and onClose alone.
  return { handle, online, onAuth, onClose, presenceLast };
}
