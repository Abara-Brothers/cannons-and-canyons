// server/seat-squad.js — seating a whole squad into one room (plan R2, R5, R6).
//
// A FACTORY, AND EVERYTHING IT TOUCHES IS INJECTED. Creating a room and seating
// players is the engine's (public/room-engine.js), and nothing here imports it:
// the offline page loads that file and must gain no server state (ADR-001), and
// server/ keeps to its side of the seam. server.js — the one file that holds
// both halves — builds seatSquad from the engine's own pieces and injects it
// into createSocial, whose start handler is its only caller. It lives in its
// own module rather than inside server.js for one reason: server.js exports
// nothing and binds a port on import, so the paths here that no correct squad
// can reach over the wire (a join refused part way, a room that will not start,
// an engine that throws) could only ever be proved by editing the source.
// Here test/squad_seat.mjs hands it the real engine in process and drives them.
//
// HOW IT SEATS WITHOUT WIDENING THE ENGINE. It sends the engine the frames an
// ordinary client sends — `create` for the leader, `join` for each member, and
// the host's `startMatch` — through handleClientMessage, which is already the
// engine's whole inbound surface. The create path is module-private and the
// join path is not a function at all, only the body of a switch arm, so this is
// the one route the engine offers; taking it means every seat passes the same
// sanitizers, rack check, seat limits and auto-start as every ordinary
// player's, with no second entry point into room state to keep in step.
// `case 'create'` leaves the new code on the host socket and `case 'join'` on
// each member's, so the answers come back on the sockets themselves. The one
// thing no frame can do is abandon a half-built room quietly, and abandonRoom
// is the one export this feature adds to the engine.
//
//   rooms               the engine's rooms Map, read only
//   handleClientMessage the engine's inbound router
//   abandonRoom         the engine's quiet teardown of a room marked a squad's
//   report(kind, err)   where an engine fault is sent (server.js: reportServerError)
//   log(line)           where a start is announced (server.js: stdout)
export function createSeatSquad({ rooms, handleClientMessage, abandonRoom, report = () => {}, log = () => {} }) {
  // IN A GAME ALREADY? The engine treats a socket that creates or joins a
  // room as LEAVING the one it holds (releasePriorRoom), which is right when a
  // player chooses it and wrong when a squad Start chooses it for them:
  // mid-match their tank is scuttled once the grace runs out and the ledger
  // records the loss, and in a lobby somebody else is in, that player's lobby
  // is destroyed (they are sent 'Opponent left') or loses a seat. So a seat
  // whose socket holds a place in a match in progress, or in a lobby with any
  // other player in it, is 'member_busy' and nothing is touched. A lobby they
  // sit in alone is theirs to lose and goes quietly (the lone-host teardown);
  // a room whose match is over holds nothing to protect.
  function seatBusy(ws) {
    const r = ws.roomCode ? rooms.get(ws.roomCode) : null;
    const p = r ? r.players[ws.seat] : null;
    if (!p || p.ws !== ws) return false;
    if (r.state === 'playing') return true;
    return r.state === 'waiting' && r.players.some((q) => q && q !== p && q.connected);
  }

  //   seats: [{ ws, name, skin, loadout }] — INDEX 0 IS THE LEADER; the rest
  //          are seated in the order given. R5 makes the order load-bearing:
  //          the engine auto-starts, so the match begins as the last one lands.
  //   opts:  { mode, tees, squad } — the armed mode, a golf tee set, and the
  //          squad code the room is marked with.
  //
  // Returns { ok: true, code } or { ok: false, error, at }, `at` the index in
  // `seats` that failed (-1 for an engine fault). NEVER THROWS, and on a
  // failure no room it built is left standing, so the caller's only job is to
  // answer the squad.
  return function seatSquad(seats, opts = {}) {
    const list = Array.isArray(seats) ? seats : [];
    const sockets = list.map((s) => s && s.ws);
    const leader = list[0];
    // THE ROOM THIS CALL BUILT, and only that one: the leader holding seat 0
    // of a room that is not the one they held before. A refused create leaves
    // no such room, and a room the leader already hosted is not ours to take.
    // `sent` is the net's arming: until the create frame has gone, this call
    // has built nothing, so there is nothing for a failure to undo — and the
    // room the leader is sitting in (their own lobby, a match in progress) is
    // somebody's game, never ours to mark or take down.
    let prior = null, room = null, sent = false;
    const built = () => {
      const r = leader && leader.ws && leader.ws.roomCode ? rooms.get(leader.ws.roomCode) : null;
      return r && r !== prior && r.players[0] && r.players[0].ws === leader.ws ? r : null;
    };
    try {
      if (!list.length) return { ok: false, error: 'refused', at: 0 };
      // A LIVE SOCKET FOR EVERY SEAT. The engine's join never looks at a
      // socket's state, so a closed one would be SEATED — a ghost, marked
      // connected, that the match would one day hand the turn to. The start
      // handler refuses one first; this is the code that knows why, so it
      // does not trust its caller to have.
      for (let i = 0; i < list.length; i++) {
        const ws = list[i] && list[i].ws;
        if (!ws || ws.readyState !== 1) return { ok: false, error: 'member_offline', at: i };
      }
      for (let i = 0; i < list.length; i++) if (seatBusy(list[i].ws)) return { ok: false, error: 'member_busy', at: i };
      prior = leader.ws.roomCode ? rooms.get(leader.ws.roomCode) || null : null;
      // THE ROOM IS SIZED TO THE SQUAD, never to the seat count the leader
      // advertised (design 4.3: `max = members.length` for ffa and golf; every
      // other mode has one seat count). That is what makes R5 trustworthy: the
      // last member's join is the seat that fills the room, so the auto-start
      // and the end of the loop below are the same instant, and no seat is
      // left open for a stranger holding the code.
      const max = opts.mode === 'ffa' || opts.mode === 'golf' ? list.length : undefined;
      sent = true;
      handleClientMessage(leader.ws, {
        type: 'create', name: leader.name, skin: leader.skin,
        mode: opts.mode, max, tees: opts.tees, loadout: leader.loadout,
      });
      // `case 'create'` answers a refusal (MAX_ROOMS) to the socket itself and
      // returns nothing, so the only honest test is whether the leader now
      // holds seat 0 of a new room.
      room = built();
      if (!room) return { ok: false, error: 'capacity', at: 0 };
      // MARKED BEFORE ANY MEMBER IS SEATED (design 4.3: "the room is marked
      // squad: code"). abandonRoom tears down only a marked room, so an
      // unmarked one could not be cleaned up after a refusal below.
      room.squad = opts.squad;
      const code = room.code;
      // OUT OF THE QUICK-MATCH QUEUE, every seat, through the engine's own
      // `cancelQuick` — now, once there IS a room, so a start refused at the
      // create leaves a queued member still queued, and still ahead of every
      // join. `join` does not clear the one-socket queue, so a member seated
      // while queued would be paired with the next quick seeker a moment later
      // — and pairing is a create, which takes them straight back out.
      for (const ws of sockets) handleClientMessage(ws, { type: 'cancelQuick' });
      for (let i = 1; i < list.length; i++) {
        const m = list[i];
        handleClientMessage(m.ws, { type: 'join', code, name: m.name, skin: m.skin, loadout: m.loadout });
        // `case 'join'` also answers a refusal to the joiner and returns
        // nothing, so again: is the seat really theirs? Read through m.ws.seat,
        // which compactRoster keeps true even when this join started a duel.
        const p = rooms.get(code) === room ? room.players[m.ws.seat] : null;
        if (m.ws.roomCode !== code || !p || p.ws !== m.ws) {
          // R6: a half-seated room is one some of the squad is standing in and
          // the rest cannot reach. It goes, and the caller answers everybody.
          abandonRoom(code, sockets);
          return { ok: false, error: 'refused', at: i };
        }
      }
      // THE MATCH BEGINS AS THE LAST MEMBER LANDS (R5) — in every mode. A duel
      // starts on its second seat and a room sized to the squad starts when it
      // fills, but a raid (boss, aliens) is always seated at two, and a squad
      // of one leaves it a seat short: the engine would hold the leader in a
      // lobby with an open seat. The host's own `startMatch` is how a lone
      // commander starts one everywhere else (Play solo sends exactly this),
      // through the engine's own host and minimum checks. A room still waiting
      // after that is not a started squad, and is abandoned like any other
      // failure rather than reported as one.
      if (room.state === 'waiting') handleClientMessage(leader.ws, { type: 'startMatch' });
      if (rooms.get(code) !== room || room.state === 'waiting') {
        abandonRoom(code, sockets);
        return { ok: false, error: 'refused', at: 0 };
      }
      // ONE LINE PER START, for whoever reads the server's log: the squad, the
      // room it became, the mode and how many were seated. No names — the
      // [report] line's rule, and a name is not needed to find a room.
      log(`[squad] ${opts.squad} seated ${list.length} into ${code} (${room.mode})`);
      return { ok: true, code };
    } catch (err) {
      // An engine throw on a synthesised frame would also throw for an
      // ordinary client, and server.js's socket handler catches those. This is
      // the same net for the one caller that is not a socket: report it, take
      // down whatever this call built — including a room whose create threw
      // after the room was made, before it could be marked — and refuse. ONLY
      // ONCE THE CREATE HAS BEEN SENT: a fault before it undoes nothing,
      // because nothing was done.
      try { report('seatSquad', err); } catch { /* never the second fault */ }
      try {
        const r = sent ? room || built() : null;
        if (r && rooms.get(r.code) === r) { if (!r.squad) r.squad = opts.squad || true; abandonRoom(r.code, sockets); }
      } catch { /* the room is the engine's problem now; the answer still goes out */ }
      return { ok: false, error: 'refused', at: -1 };
    }
  };
}
