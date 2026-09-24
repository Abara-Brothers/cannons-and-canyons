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
// injected the way server/social.js injects it, so the drop window (task 3)
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
// TASK 1 BUILDS THE CONTAINER AND ITS THREE READERS AND NOTHING ELSE. The
// writers — create, join, leave, kick, setReady, setMode, markDropped,
// markResumed, sweepDropped, removeMember, clearReady — arrive in tasks 2 and
// 3. `has` is needed first because the engine's codeTaken calls it on every
// candidate code, and one code namespace has to exist before anything mints a
// code in it.
export function createSquads({ now, capacity = 4 } = {}) {
  // `now` and `capacity` are the agreed surface and are held for the writers:
  // created / joinedAt / dropAt are stamped from now(), and capacity is the
  // four-member cap join() refuses against. Nothing in task 1 reads either,
  // and they are destructured here so task 2 does not change this signature.

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

  // The one reader that is a SEARCH rather than a lookup: a player is in at
  // most one squad, but nothing indexes by player. Squads hold at most four
  // members and MAX_ROOMS is 250, so this walks a handful of short arrays.
  //
  // A GUEST'S userId IS null (the shape above), so TASK 2 — the first task in
  // which a member can exist at all — MUST open this with
  // `if (!userId) return null;`, or the first guest member makes ofUser(null)
  // answer with a squad. That guard is not written here because with an empty
  // container it cannot be made to fail, and a guard no test can break is a
  // guard nobody is keeping.
  function ofUser(userId) {
    for (const squad of squads.values()) {
      for (const m of squad.members) if (m && m.userId === userId) return squad;
    }
    return null;
  }

  return { has, get, ofUser };
}
