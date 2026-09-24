// server/squads.js — the squad state machine (design 4.3).
//
// SERVER-ONLY, AND DELIBERATELY OUTSIDE public/, for the reason
// server/social.js gives at its own head: the static route serves public/ and
// nothing else, and public/room-engine.js is imported by the OFFLINE page,
// which must gain no server state (ADR-001 / BQ-007). Nothing here may import
// the engine and nothing in the engine may import this. server.js holds both
// and joins them.
//
// PURE. No sockets, no rooms, no database, no real clock, no timers. `now` is
// injected the way server/social.js injects it, so the drop window (task 5)
// can be driven without waiting for wall time, and the whole machine runs in
// test/squad.mjs with nothing mocked.
//
// SQUADS ARE MEMORY, AND THAT IS THE DESIGN rather than a shortcut taken for
// speed. The phase 6 migration says it in its own header: a restart must cost
// a player their squad, never their friends. There is no table here and there
// will not be one.
//
// THE SQUAD SHAPE, fixed by the plan so every task agrees:
//
//   Squad {
//     code,                      // 4 chars, unique across rooms AND squads
//     leader,                    // userId
//     created,                   // ms
//     mode: 'duel',              // the armed mode; leader's choice
//     tees: null,                // golf tee set, one of the engine's TEE_IDS; null otherwise
//     max: null,                 // ffa/golf seat choice; null = the mode's own seats
//     members: [{
//       userId,                  // null for a guest
//       guest,                   // bool
//       name, skin,              // as presented; the display name is proved at snapshot time
//       ws,                      // the live socket, or null while dropped
//       ready, loadout,          // loadout is null until ready
//       joinedAt,                // ms; earliest survivor inherits leadership
//       dropAt,                  // ms when the socket went, else null
//     }],
//   }
//
// WHO BUILT WHAT. Task 1: the container and its readers, has and get. Task 2:
// the code minter and the MEMBERSHIP half — create, join, leave, kick,
// removeMember, ofUser as a real lookup, and keyOfSocket. Task 3: setReady,
// setMode and clearReady. Still to come: the drop window's markDropped,
// markResumed and sweepDropped (task 5). `has` came first
// because the engine's codeTaken calls it on every candidate code, and one
// code namespace had to exist before anything minted a code in it.
//
// THE MEMBER KEY. Every method below that addresses a member takes a KEY, not
// an account id, whatever the plan's surface calls the parameter: the
// lower-cased account id for a signed-in member, and for a GUEST — whose row
// carries `userId: null` — the socket object they joined on. See byKey below.

// THE ALPHABET, COPIED from public/room-engine.js's CODE_CHARS rather than
// imported: nothing under server/ may pull in the engine, which the OFFLINE
// page also loads (ADR-001), and server/social.js copies SKIN_IDS for the same
// reason. One namespace needs one alphabet (plan R4) — a squad code the Bay's
// "Enter a code" field could not type, or one it would read as a room code's
// neighbour, is a code nobody can use. test/squad.mjs (s2) holds this copy to
// the engine's by BEHAVIOUR: the same bytes mint the same codes in both.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ONE CHARACTER FROM ONE BYTE, drawn exactly as the engine's makeCode draws
// it: a one-byte getRandomValues, rejection-sampled against the largest
// multiple of 31 below 256 (248) so the alphabet stays uniform — `% 31` over
// the full byte would favour the first eight characters. The SAME draw, not
// merely an equivalent one, and that is load-bearing twice over: the two
// minters share one distribution over one namespace, and a test that scripts
// one-byte requests (test/fixtures/scripted-code-bytes.mjs) steers both with
// one hook — which is the only way R4 can be proved deterministically against
// a real server, where nothing lets a test choose a code.
function drawCodeChar() {
  const b = new Uint8Array(1);
  const limit = 256 - (256 % CODE_CHARS.length);   // discard the biased tail
  do { globalThis.crypto.getRandomValues(b); } while (b[0] >= limit);
  return CODE_CHARS[b[0] % CODE_CHARS.length];
}

// codeTaken(code) -> bool: THE OTHER DIRECTION OF ONE CODE NAMESPACE (plan
// R4). The engine refuses a candidate a live squad holds (server.js wires
// setCodeTaken to this container); this refuses a candidate a live ROOM holds.
// server/social.js passes its injected roomExists straight in, which server.js
// supplies as `(code) => rooms.has(code)` — the only route from server/ to the
// engine's rooms. The default refuses nothing, which is right for a host that
// has no rooms and for every test that builds a machine on its own.
export function createSquads({ now, capacity = 4, codeTaken = () => false } = {}) {
  // `now` stamps created and joinedAt (and task 5's dropAt), and `capacity`
  // is the four-member cap join() refuses against.

  // code -> Squad. A MAP, NOT AN OBJECT LITERAL, and that is a decision
  // rather than a habit. A code arrives off the wire, and an object-backed
  // container answers `has('constructor')` yes and hands `get('toString')` a
  // function it never stored. Either reaches the engine through codeTaken
  // below and refuses a code no squad holds — for ever, because no squad can
  // ever release it.
  const squads = new Map();

  // THE ENGINE'S codeTaken (plan R4), reached through server.js. It is the
  // only reader of this container that runs inside a do/while, so it has to
  // be cheap and must never throw: a Map lookup on a string is both.
  const has = (code) => squads.has(code);

  // `|| null` rather than Map.get's bare `undefined`, because the plan's
  // surface says `squad | null` and every caller downstream tests against
  // null. A reader that answered undefined would satisfy `if (!squad)` and
  // fail `=== null`, so the two spellings would work in some call sites and
  // not in others.
  const get = (code) => squads.get(code) || null;

  // A FRESH CODE, UNIQUE ACROSS SQUADS AND ROOMS. The engine's makeCode, line
  // for line, with the squad container and codeTaken in the loop where the
  // engine has rooms and its own codeTaken: each minter refuses what the OTHER
  // holds as well as what it holds itself, so no string is ever both and the
  // one code field always has one answer.
  function mintCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, drawCodeChar).join('');
    } while (squads.has(code) || codeTaken(code));
    return code;
  }

  // ---- membership -----------------------------------------------------------
  // THE MEMBER KEY, and why it is not simply the account id. A guest's row
  // carries `userId: null` — the squad shape fixes that, and it is what lets the
  // snapshot say `id: null` for a guest without inventing an identity for
  // somebody who has none. But every method on this surface addresses a member
  // by ONE value, so a guest needs one, and it is THE SOCKET THEY JOINED ON:
  // unique while the member exists, never null, and impossible to forge from the
  // wire, because no JSON frame can carry a value that === a socket object. A
  // guest can therefore be named by their own connection and by the leader, and
  // by no third client.
  //
  // It is STORED on the row rather than recomputed from `ws`, because the drop
  // window (task 5) nulls `member.ws` while the member is still in the squad,
  // and a key that changed there would strand this index.
  //
  // BOUNDED, the way `online` and `presenceLast` are in server/social.js: every
  // path that removes a member deletes its entry and the last removal deletes
  // the squad, so this map cannot outgrow the live squads. It is also what
  // closes the hole task 1 left open on purpose: no key in it is ever null, so
  // ofUser(null) finds nobody however many guests there are.
  const byKey = new Map();          // member key -> the squad that member is in

  function mkMember(m) {
    const guest = !!m.guest || !m.userId;
    return {
      userId: guest ? null : m.userId,
      guest,
      // A guest with no socket cannot arrive here through the handlers — the
      // frame that carries a join came in ON one — but the key must never be
      // null, or two such rows would collide in `byKey` and the second would
      // evict the first. A fresh object is unique and nothing else can ever
      // hold a reference to it.
      key: guest ? (m.ws || {}) : m.userId,
      name: typeof m.name === 'string' ? m.name : '',
      skin: typeof m.skin === 'string' ? m.skin : null,
      ws: m.ws || null,
      ready: false,
      loadout: null,
      joinedAt: now(),
      dropAt: null,
    };
  }

  // A LOOKUP, NOT A SCAN. Task 1's version walked every squad comparing
  // m.userId, which could never find a guest (their userId is null, and
  // ofUser(null) would have matched the first one). A friends panel may ask
  // this once per friend per frame, so it must not walk every squad either.
  function ofUser(key) {
    return byKey.get(key) || null;
  }

  // THE ROW A SOCKET IS, found by the SOCKET rather than by who is signed in
  // on it — and the two differ in ordinary use. The client re-sends `hello`
  // over the live socket after a sign-in, so a guest who signs in mid-squad is
  // an account on a socket that still holds a GUEST row, keyed by that
  // socket; an anonymous account upgraded in place is the same. The reverse
  // is a socket that signed out and still holds its account's row. Every op a
  // socket sends acts on the row it holds, so the caller's key comes from
  // here first and from the account only when the socket holds no row (a
  // second device of a member).
  //
  // A SCAN, bounded by the live squads (at most four rows each) and run once
  // per squad frame, which the rate bucket caps. Deliberately not a second
  // index: task 5 writes member.ws on drop and on resume, and an index beside
  // it would be one more thing that could fall out of step with the rows.
  function keyOfSocket(ws) {
    if (!ws) return null;
    for (const squad of squads.values()) {
      for (const m of squad.members) if (m.ws === ws) return m.key;
    }
    return null;
  }

  // Every key a mover may hold a row under: the one this member's row will
  // carry, and `fromKey`, the row the mover's socket holds now, when that is
  // a different key.
  const moverKeys = (row, fromKey) => (fromKey != null && fromKey !== row.key ? [row.key, fromKey] : [row.key]);

  // -> squad, or null for a GUEST. A SQUAD IS ALWAYS LED BY AN ACCOUNT: the
  // mode, the start and the kick all belong to the leader, and a leader of
  // null would be matched by every caller with no account. The handler's gate
  // refuses a guest first; this is the machine holding its own rule rather
  // than trusting the one gate in front of it. Refused BEFORE any leave, so a
  // refusal costs a guest nothing.
  function create(member, fromKey) {
    const row = mkMember(member);
    if (!row.userId) return null;
    // ONE SQUAD PER PLAYER, AND ONE ROW PER SOCKET. Create is also a LEAVE: a
    // player creating while already in a squad is asking for a new one, and
    // leaving first is what keeps `byKey` a map rather than a multimap. Both
    // the account's row and the row the caller's socket holds go. The old
    // squad survives under its next leader unless they were the last member.
    for (const k of moverKeys(row, fromKey)) leave(k);
    const code = mintCode();
    const squad = { code, leader: row.userId, created: now(), mode: 'duel', tees: null, max: null, members: [row] };
    squads.set(code, squad);
    byKey.set(row.key, squad);
    return squad;
  }

  // `fromKey` is the row the caller's socket holds now (keyOfSocket), when it
  // is not the key this member's row will carry — see create.
  function join(code, member, fromKey) {
    const squad = squads.get(code) || null;
    if (!squad) return { ok: false, squad: null, error: 'no_such_squad' };
    const row = mkMember(member);
    const keys = moverKeys(row, fromKey);
    // ALREADY HERE IS NOT A JOIN — under either key. Without this the
    // one-squad-per-player leave below would remove this member and add them
    // again — and if they were the leader, the hand-off would give their
    // squad away on a frame that asked for nothing to change. A second device,
    // or a guest row whose socket has since signed in, is `resume`'s business,
    // not this one's: the squad keeps the row and the socket it already has.
    //
    // BUT ONE SOCKET NEVER SHOWS TWO SQUADS. When the match is on the
    // ACCOUNT's row (another device of it is here) and the socket's own row,
    // fromKey, is in some OTHER squad, that row goes: otherwise the socket is
    // answered with this squad and then pushed the other one for as long as
    // it stays connected. Only fromKey — the socket's own row. The account's
    // other device keeps what it has.
    if (squad.members.some((m) => keys.includes(m.key))) {
      if (fromKey != null && fromKey !== row.key && byKey.has(fromKey) && byKey.get(fromKey) !== squad) leave(fromKey);
      return { ok: true, squad, error: null };
    }
    // THE CAP IS CHECKED BEFORE THE LEAVE, and the order is the whole point: a
    // refused join must not be the thing that costs a player the squad they
    // were already in.
    if (squad.members.length >= capacity) return { ok: false, squad, error: 'full' };
    for (const k of keys) leave(k);
    squad.members.push(row);
    byKey.set(row.key, squad);
    return { ok: true, squad, error: null };
  }

  // One removal, whoever asked for it: a member leaving, a player moving to
  // another squad, a block tearing the pair apart (R16), and task 5's drop
  // window. Returns the squad even when it has just been deleted, and with its
  // member list INTACT, so the caller can still reach the people it ended
  // under.
  function detach(squad, key) {
    const none = { squad: null, ended: false, newLeader: null };
    if (!squad) return none;
    const i = squad.members.findIndex((m) => m.key === key);
    if (i < 0) return none;
    const [gone] = squad.members.splice(i, 1);
    byKey.delete(key);
    // THE LAST MEMBER TAKES THE SQUAD WITH THEM. A map keyed by code that kept
    // empty squads would grow by one entry per squad ever formed for the life
    // of the process, and hold its code against every future mint.
    if (!squad.members.length) { squads.delete(squad.code); return { squad, ended: true, newLeader: null }; }
    if (!gone.userId || squad.leader !== gone.userId) return { squad, ended: false, newLeader: null };
    // A SQUAD IS SOMETHING SOMEBODY LEADS: the mode, the start and the kick all
    // belong to the leader and all three need an account. A guest has none, so
    // a guest leader would be a `leader` of null — which every caller with no
    // account id would then match. Leadership therefore passes to the earliest
    // joined SIGNED-IN survivor; `<` and not `<=` so a tie goes to the member
    // already earlier in the roster.
    let heir = null;
    for (const m of squad.members) if (m.userId && (!heir || m.joinedAt < heir.joinedAt)) heir = m;
    if (!heir) {
      // Nobody left who can lead. Ending it is the honest outcome: the guests
      // standing in it could not start, pick a mode or invite anyone.
      for (const m of squad.members) byKey.delete(m.key);
      squads.delete(squad.code);
      return { squad, ended: true, newLeader: null };
    }
    squad.leader = heir.userId;
    return { squad, ended: false, newLeader: heir.userId };
  }

  // A declaration, not a const arrow: create() and join() call it, and a
  // hoisted function cannot be reached before it is initialised.
  function leave(key) { return detach(byKey.get(key) || null, key); }

  // `fromKey` is the key of the member the caller claims leads, and
  // `targetKey` the target's. The leader is always a signed-in account (see
  // create and detach), so a guest's socket key never equals it and a guest
  // can never pass the first test. The one caller, server/social.js, passes
  // the leader its ledSquad has already established, so for that caller this
  // check always passes and guards nothing: ledSquad is the socket path's
  // only leadership check, and this one guards a direct caller of the machine.
  function kick(code, fromKey, targetKey) {
    const squad = squads.get(code) || null;
    // `!squad.leader` closes the one case the rest of this file makes
    // unreachable and a future caller could not: a leader of null must never
    // be matched by a caller whose account id is also null.
    if (!squad || !squad.leader || squad.leader !== fromKey) return { ok: false, squad: null, error: 'not_leader' };
    // THE LEADER IS NOT A TARGET. Leave is the door they use, and a kick that
    // could remove the leader would run the leadership hand-off from the one
    // path that has no reason to.
    const i = squad.members.findIndex((m) => m.key === targetKey && m.userId !== squad.leader);
    if (i < 0) return { ok: false, squad, error: 'no_such_member' };
    byKey.delete(squad.members[i].key);
    squad.members.splice(i, 1);
    return { ok: true, squad, error: null };
  }

  // THE BLOCK TEARDOWN'S ENTRY POINT (R16). Same rules as leave — the hand-off,
  // the empty squad deleted, the squad no signed-in member is left to lead
  // ended — reached by code and member key, because the caller is somebody
  // else's block rather than the member's own socket. By CODE: a teardown
  // aimed at one squad must not reach into another the player has moved to.
  function removeMember(code, key) {
    const { squad, ended } = detach(squads.get(code) || null, key);
    return { squad, ended };
  }

  // ---- readiness and the armed mode (task 3) --------------------------------
  // design 4.3, row 'ready'. THE MEMBERSHIP INVARIANT ONLY: a ready member
  // holds a rack, and a member who stands down drops it. What counts as a rack
  // is the armed mode's draft size, and that number is the ENGINE's —
  // server/social.js checks it with the validRackFor server.js injects, the
  // predicate the room applies when it seats the member. This file holds no
  // mode table and must not grow one, or there are two answers to "how many
  // weapons" and a squad readies against the wrong one.
  //
  // By MEMBER KEY, like every method here: the account id, or a guest's
  // socket. Only `true` is ready; anything else stands the member down, which
  // is the harmless direction for a frame that is not quite what it should be.
  function setReady(key, ready, loadout) {
    const squad = ofUser(key);
    const m = squad ? squad.members.find((x) => x.key === key) : null;
    if (!m) return { ok: false, squad: null, error: 'no_squad' };
    const want = ready === true;
    if (want && !(Array.isArray(loadout) && loadout.length)) return { ok: false, squad: null, error: 'no_rack' };
    m.ready = want;
    // A COPY. The array arrived off a client frame; a squad holding that same
    // array would seat the member with whatever it had since become.
    m.loadout = want ? loadout.slice() : null;
    return { ok: true, squad, error: null };
  }

  // design 4.3, row 'mode'. LEADER ONLY, and a squad that has gone is answered
  // the same way: nobody leads a squad that does not exist, and a stale leader
  // after a hand-off must get the refusal a stranger gets. `leaderKey` is
  // the member key the caller claims leads; the leader is always an account
  // id (see create and detach), so a guest's socket key and a null never
  // match it, and `!squad.leader` is kick's guard against a leader of null.
  // (Not named byKey: that is the member index above, and a later edit here
  // reaching for the index must not get the caller's key instead.) The one
  // caller, server/social.js, passes the leader its ledSquad has already
  // established, so this check always passes for it: it guards a direct
  // caller of the machine, not the socket path. kick() above is the same.
  //
  // WHAT IS A VALID MODE, TEE SET OR SEAT COUNT is not decided here, for the
  // reason setReady gives: server/social.js vets all three against the
  // engine's own MODE_SEATS and TEE_IDS, and is the only caller.
  function setMode(code, leaderKey, mode, tees, max) {
    const squad = squads.get(code) || null;
    if (!squad || !squad.leader || squad.leader !== leaderKey) return { ok: false, squad: null, error: 'not_leader' };
    squad.mode = mode;
    squad.tees = tees;
    squad.max = max;
    return { ok: true, squad, error: null };
  }

  // After a start (design 4.3: "Ready flags reset to false on the server when
  // the room is created, so the next start needs fresh Readies"). THE RACKS GO
  // WITH THE FLAGS: loadout is null until ready, and a rack left behind is one
  // the NEXT start would seat a member with although they never touched Ready.
  //
  // DESTRUCTIVE, SO THE ORDER IS THE CALLER'S TO GET RIGHT: read every
  // member's rack and seat them FIRST, then call this.
  function clearReady(code) {
    const squad = squads.get(code) || null;
    if (!squad) return null;
    for (const m of squad.members) { m.ready = false; m.loadout = null; }
    return squad;
  }

  // ---- the drop window (task 5, design 4.3) ---------------------------------
  // A member whose socket goes is not removed: the row is kept, shown as
  // dropped and NOT READY, for as long as the caller's window lasts, and then
  // removed. This file owns the STATE of that window and nothing else. There
  // is no timer here and no clock beyond the injected now(): the window's
  // length and its timer belong to server/social.js, beside the fan-out they
  // drive, and sweepDropped takes the cutoff as a TIMESTAMP so a suite can
  // sweep any moment it likes.
  //
  // By MEMBER KEY, like every method above: the account id for a signed-in
  // member, the socket they joined on for a guest (their row carries
  // `userId: null`). The key is stored on the row, so nulling member.ws on a
  // drop strands nothing in byKey.

  // The row a key holds and its squad, or null. The index, never a scan.
  function memberOf(key) {
    const squad = ofUser(key);
    const member = squad ? squad.members.find((m) => m.key === key) : null;
    return member ? { squad, member } : null;
  }

  // -> the squad when a row was dropped, null when nothing changed.
  function markDropped(key, at) {
    // A TIME THAT IS NOT ONE IS NOT A DROP: a row with its socket gone and
    // dropAt still null would be swept by nothing, a ghost for the squad's
    // life. now() always answers a number; this is the machine not trusting it.
    if (!Number.isFinite(at)) return null;
    const found = memberOf(key);
    if (!found) return null;
    const m = found.member;
    // ALREADY DROPPED IS NOT A SECOND DROP. server.js reaches its close hook
    // from three places (the socket's own close, the sign-out branch, a hello
    // for another account), and re-stamping would slide the window forward on
    // every one: a member held for ever by a socket that closes repeatedly.
    // Answering null is also what stops a second snapshot going out for
    // nothing — dropPresence's `set.delete(ws)` answering false, in this
    // file's terms.
    if (m.dropAt !== null) return null;
    // A ROW HOLDING A LIVE SOCKET HAS NOTHING TO DROP — the engine's
    // `player.ws === ws` rule. server/social.js only ever passes the key of
    // the row the closing socket itself holds, so from there this cannot be
    // reached; it is the machine holding its own rule for a direct caller.
    if (m.ws && m.ws.readyState === 1) return null;
    m.dropAt = at;
    m.ws = null;
    // "A dropped member is not ready" (design 4.3), literally. The rack goes
    // with the flag, as it does everywhere else in this file.
    m.ready = false;
    m.loadout = null;
    return found.squad;
  }

  return { has, get, ofUser, keyOfSocket, create, join, leave, kick, removeMember, setReady, setMode, clearReady, markDropped };
}
