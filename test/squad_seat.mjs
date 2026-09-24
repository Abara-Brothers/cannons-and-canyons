// Seating a whole squad into one room: the real seatSquad in server.js and the
// real abandonRoom in the engine (plan R2, R5, R6).
//
// WHY THIS FILE EXISTS AND test/squad.mjs IS NOT ENOUGH. seatSquad lives in
// server.js, which exports nothing and binds a port on import, so the only way
// to reach it is a real socket. test/squad.mjs injects a seatSquad of its own
// on purpose, to test the HANDLER — what it hands the seating and what it does
// with the answer — and a suite whose stub IS the thing under test proves only
// that something was called. This file drives the real one, over real
// sockets, into the real engine, so between the two nothing is invisible.
//
// SELF-HOSTED, like auth_sink.mjs, push_persist.mjs and code_frame.mjs: it
// spawns its own servers on free ports with SUPABASE_* pointed at a local mock
// of GoTrue and PostgREST. It never reaches a shared or a deployed server, so
// it ignores $WS.
// SECTION A runs in THIS process against the real engine module — the idiom
// test/solo_engine.mjs and test/squad.mjs use. It touches the `rooms` Map of
// this process only; every server spawned below has its own.
import { rooms, handleClientMessage, abandonRoom } from '../public/room-engine.js';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const FIVE = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];

// ---- SECTION A: abandonRoom, in process --------------------------------------
// A fake socket is all the engine needs: readyState for its send() gate, send()
// itself, and the roomCode/seat it hangs off the object.
const mkws = () => ({ readyState: 1, roomCode: null, seat: null, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });
const got = (ws, type) => ws._rx.filter((m) => m.type === type);
// A room built through the engine's own frames, then MARKED the way server.js's
// seatSquad marks the room it builds. The mark is what abandonRoom asks for:
// an ordinary player's room carries none, so the one door this project adds to
// the engine cannot be pointed at one.
const squadRoom = (mode, max, joiners) => {
  const host = mkws();
  handleClientMessage(host, { type: 'create', name: 'Ava', skin: 'olive', mode, max, loadout: FIVE });
  const guests = [];
  for (let i = 0; i < joiners; i++) {
    const g = mkws();
    handleClientMessage(g, { type: 'join', code: host.roomCode, name: 'Bo', skin: 'desert', loadout: FIVE });
    guests.push(g);
  }
  const room = rooms.get(host.roomCode);
  if (room) room.squad = 'SQD1';
  return { host, guests, code: host.roomCode, room };
};
const roomsAtStart = rooms.size;
{
  // A WAITING ROOM: a free-for-all for four with two seated, still in its lobby.
  const { host, guests: [guest], code, room } = squadRoom('ffa', 4, 1);
  if (!room || room.state !== 'waiting' || guest.roomCode !== code) {
    fail(`(A0) the fixture room was never built: code=${code} state=${room && room.state} seated=${guest.roomCode}`);
  } else {
    const r = abandonRoom(code, [host]);
    if (r === true && !rooms.has(code)) ok('(A1) abandonRoom deletes the squad room it is given and says so');
    else fail(`(A1) abandonRoom returned ${JSON.stringify(r)}, room still there: ${rooms.has(code)}`);
    // QUIET FOR OUR OWN, WHILE THE ROOM IS A LOBBY. The squad layer is about to
    // tell these sockets the real reason; an 'opponentLeft' on top of it is the
    // second, contradictory card public/app.js cannot dismiss (see the
    // engine's releasePriorRoom note), and a lobby has its own honest exit.
    if (got(host, 'opponentLeft').length === 0) ok('(A2) a socket listed in `own` is NOT sent opponentLeft while the room is still a lobby');
    else fail('(A2) the caller\'s own socket was sent opponentLeft: ' + JSON.stringify(host._rx.map((m) => m.type)));
    // LOUD FOR ANYONE ELSE. Nobody else is going to tell them the room is gone.
    if (got(guest, 'opponentLeft').length === 1) ok('(A3) a seat NOT in `own` is told the room went away, once');
    else fail('(A3) the outsider got ' + JSON.stringify(guest._rx.map((m) => m.type)));
    if (host.roomCode === null && host.seat === null && guest.roomCode === null && guest.seat === null)
      ok('(A4) every evicted socket is released — no client keeps a code that names nothing');
    else fail(`(A4) sockets still carry a code: host=${host.roomCode}/${host.seat} guest=${guest.roomCode}/${guest.seat}`);
  }
}
{
  // WHAT IT REFUSES. A code that names no room, and a code that is not a
  // string at all: the rooms Map is keyed by string and does not coerce, so an
  // array naming a live code must miss it — the class of hole task 3's review
  // found in the engine's mode lookup.
  const { host, code, room } = squadRoom('ffa', 4, 0);
  const odd = [['ZZZZ'], [[code]], [{ toString: () => code }], [123], [null], [undefined]];
  const said = odd.map(([c]) => abandonRoom(c, [host]));
  if (room && said.every((r) => r === false) && rooms.get(code) === room && host.roomCode === code && host._rx.every((m) => m.type !== 'opponentLeft'))
    ok('(A5) an unknown code, and a live code sent as an array, an object or a number, are refused and touch nothing');
  else fail('(A5) answers ' + JSON.stringify(said) + ' room kept ' + (rooms.get(code) === room) + ' host code ' + host.roomCode);
  abandonRoom(code, [host]);
}
{
  // AN ORDINARY PLAYER'S ROOM IS OUT OF REACH. A room nobody marked is not
  // one a squad start built, so it is refused whole: nothing torn down,
  // nobody told, nobody released.
  const host = mkws(), guest = mkws();
  handleClientMessage(host, { type: 'create', name: 'Ava', skin: 'olive', mode: 'ffa', max: 4, loadout: FIVE });
  const code = host.roomCode;
  handleClientMessage(guest, { type: 'join', code, name: 'Bo', skin: 'desert', loadout: FIVE });
  const room = rooms.get(code);
  const before = host._rx.length + guest._rx.length;
  const r = abandonRoom(code, [host, guest]);
  if (r === false && rooms.get(code) === room && room.state === 'waiting' && host.roomCode === code && guest.roomCode === code
    && host._rx.length + guest._rx.length === before)
    ok('(A6) a room no squad start built is refused: not torn down, nobody told, nobody released');
  else fail(`(A6) answered ${JSON.stringify(r)}, room kept ${rooms.get(code) === room}, codes ${host.roomCode}/${guest.roomCode}, frames +${host._rx.length + guest._rx.length - before}`);
  handleClientMessage(host, { type: 'leave' });
}
{
  // A ROOM THAT HAS ALREADY STARTED. A duel starts the instant its second seat
  // lands, so a squad room can be a live match by the time a later seat is
  // refused. Those clients are on the MATCH screen, where the squad's own
  // refusal is not drawn, and the one thing that takes them out of a match
  // whose room has gone is the 'Opponent left' card. So once the room is not
  // a lobby any more, everyone is told — our own sockets included.
  const { host, guests: [guest], code, room } = squadRoom('duel', 2, 1);
  if (!room || room.state !== 'playing') fail('(A7) the fixture duel never started: ' + (room && room.state));
  else {
    const r = abandonRoom(code, [host, guest]);
    if (r === true && !rooms.has(code) && got(host, 'opponentLeft').length === 1 && got(guest, 'opponentLeft').length === 1
      && host.roomCode === null && guest.roomCode === null)
      ok('(A7) a squad room that has already started tells every seat, its own included, and releases them');
    else fail(`(A7) answered ${JSON.stringify(r)}; opponentLeft host=${got(host, 'opponentLeft').length} guest=${got(guest, 'opponentLeft').length}; codes ${host.roomCode}/${guest.roomCode}`);
  }
}
{
  // `own` THAT IS NOT A LIST is nobody's: it must not throw out of the one
  // path that is cleaning up after a failure, and nobody is left untold.
  const said = [];
  for (const own of [5, 'x', null, { length: 1, 0: null }]) {
    const { host, code } = squadRoom('ffa', 4, 0);
    let r;
    try { r = abandonRoom(code, own); } catch (e) { r = 'threw ' + e.message; }
    said.push([r, rooms.has(code), got(host, 'opponentLeft').length]);
  }
  if (said.every(([r, kept, told]) => r === true && kept === false && told === 1))
    ok('(A8) an `own` that is not an array is treated as nobody\'s — no throw, the room goes, the seat is told');
  else fail('(A8) ' + JSON.stringify(said));
}
if (rooms.size === roomsAtStart) ok('(A9) section A leaves the rooms Map as it found it');
else fail(`(A9) rooms went from ${roomsAtStart} to ${rooms.size}`);

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall squad-seat checks passed');
process.exit(out.errors.length ? 1 : 0);
