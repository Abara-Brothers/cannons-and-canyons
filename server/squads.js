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
//     tees: null,                // golf tee count, null otherwise
//     max: null,                 // ffa/golf seat choice; null = the mode's own max
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
// removeMember, and ofUser as a real lookup. Still to come: setReady, setMode
// and clearReady (task 3), and the drop window's markDropped, markResumed and
// sweepDropped (task 5). `has` came first because the engine's codeTaken calls
// it on every candidate code, and one code namespace had to exist before
// anything minted a code in it.
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

// THE SEAT TABLE, COPIED FROM public/room-engine.js RATHER THAN IMPORTED, for
// the reason CODE_CHARS above is. [min, max] per mode: max is createRoom's
// clamp (`const max = mode === 'ffa' ? ...`) and min is startMatch's floor
// (`const minSeats = ...`). Pinned against both of those lines by
// test/squad.mjs (s10), because a copy with nothing holding it to the
// original is a copy that drifts. TASK 3 OWNS THE SEAT TABLE (plan X6) and
// replaces this copy with one source of truth; this is only as much as the
// snapshot's `fits` needs.
export const SQUAD_SEATS = { duel: [2, 2], ffa: [2, 4], boss: [1, 2], aliens: [1, 2], golf: [1, 4] };

// WHICH MODES A SQUAD OF THIS SIZE CAN BE SEATED IN — minimum AND maximum, so
// a squad of one fits no duel. Computed on the SERVER so the Squad box and the
// mode boards read one truth, and so Start and the dimming can never disagree
// about the same squad.
export function fitsFor(size) {
  const out = {};
  for (const m of ['duel', 'ffa', 'boss', 'aliens', 'golf']) {
    const [lo, hi] = SQUAD_SEATS[m];
    out[m] = size >= lo && size <= hi;
  }
  return out;
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

  function create(member) {
    const row = mkMember(member);
    // ONE SQUAD PER PLAYER. Create is also a LEAVE: a player creating while
    // already in a squad is asking for a new one, and leaving first is what
    // keeps `byKey` a map rather than a multimap. The old squad survives under
    // its next leader unless they were the last member of it.
    leave(row.key);
    const code = mintCode();
    const squad = { code, leader: row.userId, created: now(), mode: 'duel', tees: null, max: null, members: [row] };
    squads.set(code, squad);
    byKey.set(row.key, squad);
    return squad;
  }

  function join(code, member) {
    const squad = squads.get(code) || null;
    if (!squad) return { ok: false, squad: null, error: 'no_such_squad' };
    const row = mkMember(member);
    // ALREADY HERE IS NOT A JOIN. Without this the one-squad-per-player leave
    // below would remove this member and add them again — and if they were the
    // leader, the hand-off would give their squad away on a frame that asked
    // for nothing to change. A second device is `resume`'s business, not this
    // one's: the squad keeps the socket it already has.
    if (squad.members.some((m) => m.key === row.key)) return { ok: true, squad, error: null };
    // THE CAP IS CHECKED BEFORE THE LEAVE, and the order is the whole point: a
    // refused join must not be the thing that costs a player the squad they
    // were already in.
    if (squad.members.length >= capacity) return { ok: false, squad, error: 'full' };
    leave(row.key);
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

  // `callerKey` is the CALLER's member key and `targetKey` the target's. The
  // leader is always a signed-in account (see detach), so a guest's socket
  // key never equals it and a guest can never pass the first test.
  function kick(code, callerKey, targetKey) {
    const squad = squads.get(code) || null;
    // `!squad.leader` closes the one case the rest of this file makes
    // unreachable and a future caller could not: a leader of null must never
    // be matched by a caller whose account id is also null.
    if (!squad || !squad.leader || squad.leader !== callerKey) return { ok: false, squad: null, error: 'not_leader' };
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

  return { has, get, ofUser, create, join, leave, kick, removeMember };
}
