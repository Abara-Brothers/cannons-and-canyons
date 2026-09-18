// The per-room seat handle (BINDING.md resolution 24), end to end in process:
// the REAL room engine mints and resolves it, the REAL social layer reports and
// blocks through it, and the two are joined exactly the way server.js joins
// them — `resolveHandle: resolveSeatHandle`. No server, no sockets, no Supabase.
//
// WHY THIS EXISTS. Report and Block were reachable only from the friends panel,
// because a lobby payload carried a name and a paint and nothing else, and the
// person who needs reporting is a stranger in a lobby. The fix everyone reaches
// for first — put the account uuid in the payload — hands every opponent a
// stable identifier and makes cross-match correlation trivial for a modified
// client. So a seat carries a random per-room token instead, and every property
// that makes that safe rather than merely different is one line away from not
// being there and invisible in ordinary play:
//
//   * it must not be derivable from the account, or it is the uuid again;
//   * it must not outlive its room, or it is a stable identifier again;
//   * it must not resolve across rooms, or one lobby's token reaches another;
//   * it must not let a RAW UUID through the same door, or the leak returns by
//     the back door;
//   * it must resolve BEFORE the uuid-shape test and BEFORE the self test, or
//     every honest frame is refused and a player can report themselves;
//   * it must never reach the log line, which keeps the resolved account id.
//
// Every one of those has a case below and a fault injection behind it.
//
// Timers: the engine's bot and pick clocks are pushed far out so nothing fires
// during the run, and every case leaves its room the way a player does.
process.env.BOT_FIRE_MS = '600000';
process.env.PICK_MS = '600000';

import { createSocial } from '../server/social.js';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };

const engine = await import('../public/room-engine.js');
const { rooms, handleClientMessage, resolveSeatHandle } = engine;

// A throw out of the engine reaches uncaughtException in production and takes
// every live match with it, so a case that provokes one must not look green.
let escaped = null;
process.on('uncaughtException', (e) => { escaped = e; });

// HEX LETTERS ON PURPOSE, the same fixture shape test/social.mjs uses: a uuid
// of digits alone makes a case-fold a no-op and gives the lower-casing on the
// resolved id no test that can fail.
const uid = (n) => '00000000-0000-4000-8000-cd' + String(n).padStart(10, '0');
const A = uid(1), B = uid(2), C = uid(3), GUEST = uid(9);

// One socket object serving both halves, which is what a real one is: the
// engine writes strings through ws.send and hangs roomCode/seat off it, the
// social layer reads ws.userId / ws.isGuest and is handed its own send. Both
// land in _rx so a case can read either.
const mkws = (userId = null, isGuest = false) => ({
  readyState: 1, userId, isGuest, chosenName: null, _rx: [],
  send(s) { this._rx.push(JSON.parse(s)); },
});
const frames = (ws, t) => ws._rx.filter((m) => m.type === t);
const lastOf = (ws, t) => frames(ws, t)[frames(ws, t).length - 1] || null;
const roomOf = (ws) => rooms.get(ws.roomCode);
const seatsOf = (ws) => (roomOf(ws) ? roomOf(ws).players : []);
// Leave the way a player does, so every timer the engine armed is cleared and
// the next case cannot inherit this room.
const leave = (ws) => { try { handleClientMessage(ws, { type: 'leave' }); } catch (e) { fail('leave threw: ' + e.message); } };
const ROLLED = 'Anvil Six';          // a curated pair — isGeneratedCallsign says so

// The handle a seat is carrying, straight off the LAST lobby frame this socket
// was sent — the wire, not the room object, because the wire is what a client
// actually has to work with.
const wireHandle = (ws, seat) => {
  const l = lastOf(ws, 'lobby');
  const p = l && l.players && l.players[seat];
  return p ? p.handle : undefined;
};

// ---- the store double ------------------------------------------------------
// Only what report, block and the friends snapshot a block pushes actually
// call, with server/store.js's return shapes. profilesByIds hands back
// { id, callsign, callsign_key } and nothing else, exactly as the real
// `select=id,callsign,callsign_key` does.
const PAIR = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
function memStore(rows) {
  const profiles = new Map(rows.map((p) => [p.id, { ...p }]));
  const friends = new Set(), requests = new Set(), blocks = new Set();
  const st = {
    profiles, friends, requests, blocks, reports: [], calls: [],
    _hit(m) { st.calls.push(m); },
    async ensureFriendCode(id) { st._hit('ensureFriendCode'); const p = profiles.get(id); return p ? p.friend_code : null; },
    async profileById(id) { st._hit('profileById'); return profiles.get(id) || null; },
    async profileByFriendCode(code) { st._hit('profileByFriendCode'); return [...profiles.values()].find((p) => p.friend_code === code) || null; },
    async profileByCallsignKey(k) { st._hit('profileByCallsignKey'); return [...profiles.values()].find((p) => p.callsign_key === k) || null; },
    async profilesByIds(ids) { st._hit('profilesByIds'); const m = new Map(); for (const id of ids) { const p = profiles.get(id); if (p) m.set(id, { id, callsign: p.callsign, callsign_key: p.callsign_key ?? null }); } return m; },
    async friendIdsOf(id) { st._hit('friendIdsOf'); const o = []; for (const k of friends) { const [a, b] = k.split('|'); if (a === id) o.push(b); else if (b === id) o.push(a); } return o; },
    async requestsOf(id) { st._hit('requestsOf'); const incoming = [], outgoing = []; for (const k of requests) { const [f, t] = k.split('>'); if (t === id) incoming.push(f); else if (f === id) outgoing.push(t); } return { incoming, outgoing }; },
    async blockIdsOf(id) { st._hit('blockIdsOf'); const blocked = [], blockedBy = []; for (const k of blocks) { const [a, b] = k.split('>'); if (a === id) blocked.push(b); else if (b === id) blockedBy.push(a); } return { blocked, blockedBy }; },
    async addFriendship(a, b) { st._hit('addFriendship'); friends.add(PAIR(a, b)); },
    async removeFriendship(a, b) { st._hit('removeFriendship'); friends.delete(PAIR(a, b)); },
    async addRequest(f, t) { st._hit('addRequest'); requests.add(f + '>' + t); },
    async deleteRequest(f, t) { st._hit('deleteRequest'); requests.delete(f + '>' + t); },
    async addBlock(a, b) { st._hit('addBlock'); blocks.add(a + '>' + b); },
    async removeBlock(a, b) { st._hit('removeBlock'); blocks.delete(a + '>' + b); },
    async addReport(reporter, reported, callsign) { st._hit('addReport'); st.reports.push({ reporter, reported, callsign }); },
    async reportedSince() { st._hit('reportedSince'); return false; },
  };
  return st;
}
const ROWS = [
  { id: A, callsign: 'Anvil Six', friend_code: 'ABC234', callsign_key: 'anvil six' },
  { id: B, callsign: 'Bunker Nine', friend_code: 'BDF345', callsign_key: 'bunker nine' },
  { id: C, callsign: 'Crater Two', friend_code: 'CGH456', callsign_key: 'crater two' },
  { id: GUEST, callsign: 'Dune Four', friend_code: 'DJK567', callsign_key: null },
];
// THE SEAM UNDER TEST: the resolver server.js injects, nothing stubbed.
const mkSocial = (store) => createSocial({
  store, terms: [], send: (ws, frame) => ws._rx.push(frame),
  now: () => 1700000000000, resolveHandle: resolveSeatHandle,
});
// Captures console.log for one handler call and no longer — ok() writes there
// too, and a wider capture would eat this suite's own output.
async function withLog(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.log = real; }
  return lines.filter((l) => l.startsWith('[report] '));
}

// A four-seat lobby that never starts: ffa waits for the host, so the room
// stays in 'waiting' with no timers armed and a real lobby frame per seat.
function lobbyOf(...sockets) {
  const [host, ...rest] = sockets;
  handleClientMessage(host, { type: 'create', mode: 'ffa', max: 4, name: ROLLED, skin: 'olive' });
  for (const ws of rest) handleClientMessage(ws, { type: 'join', code: host.roomCode, name: ROLLED, skin: 'olive' });
  return roomOf(host);
}

// ---- (a) the lobby payload carries a handle, and never an account id -------
{
  const wa = mkws(A), wb = mkws(B), wc = mkws(null);   // C never saved: no account
  const room = lobbyOf(wa, wb, wc);
  const l = lastOf(wa, 'lobby');
  const h0 = wireHandle(wa, 0), h1 = wireHandle(wa, 1), h2 = wireHandle(wa, 2);
  if (room && room.players.filter(Boolean).length === 3) ok('(a) three seats in a waiting ffa lobby');
  else fail('(a) lobby seats: ' + JSON.stringify(room && room.players.length));
  if (/^[0-9a-f]{8}$/.test(String(h0)) && /^[0-9a-f]{8}$/.test(String(h1))) ok('(a) each accounted seat carries a short opaque handle (8 hex)');
  else fail('(a) handles: ' + JSON.stringify([h0, h1]));
  if (h0 !== h1) ok('(a) the two seats in one room hold different handles');
  else fail('(a) both seats hold the same handle: ' + h0);

  // THE WHOLE POINT. No account id, in any spelling, anywhere in the frame.
  const wire = JSON.stringify(l);
  if (!wire.includes(A) && !wire.includes(B) && !wire.includes(A.slice(0, 8)) && !wire.includes(B.slice(0, 8)))
    ok('(a) no account uuid — and no prefix of one — appears anywhere in the lobby payload');
  else fail('(a) an account id reached the lobby payload: ' + wire);
  // Not derivable: a handle must share nothing with the id it stands for.
  if (!A.replace(/-/g, '').includes(String(h0)) && !B.replace(/-/g, '').includes(String(h1)))
    ok('(a) a handle is not a slice of the account uuid it resolves to');
  else fail('(a) a handle looks derived from the account id: ' + JSON.stringify([h0, h1]));

  // A SEAT WITH NO ACCOUNT CARRIES NO HANDLE AT ALL — not a random one that
  // resolves to nothing. Task 8 shows Report where there is a handle and
  // nowhere else, so nobody is offered a control that was always going to fail.
  const seat2 = l && l.players && l.players[2];
  if (seat2 && !('handle' in seat2) && seat2.name && seat2.skin) ok('(a) a seat with no account carries name and paint and NO handle key');
  else fail('(a) accountless seat: ' + JSON.stringify(seat2));
  if (h2 === undefined) ok('(a) there is nothing for a client to send for an accountless seat');
  else fail('(a) accountless handle: ' + JSON.stringify(h2));

  // Minted ONCE per seat: a handle that changed per broadcast would break a menu
  // that is already open, and a handle that changed per RECIPIENT would let two
  // clients compare notes.
  const before = wireHandle(wb, 0);
  handleClientMessage(wb, { type: 'join', code: room.code, name: ROLLED, skin: 'olive' });  // refused: one socket one seat
  const after = wireHandle(wa, 0);
  if (before === h0 && after === h0) ok('(a) one handle per seat: stable across broadcasts and identical for every recipient');
  else fail('(a) handle moved: ' + JSON.stringify([h0, before, after]));

  leave(wc); leave(wb); leave(wa);
}

// ---- (b) unique within its room, reusable across rooms ---------------------
// The uniqueness retry cannot be provoked by chance, so the CSPRNG is forced to
// repeat itself for exactly two 4-byte draws — makeHandle's buffer and nothing
// else's (a room code draws 1 byte, a resume token 12).
{
  const realRV = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let forced = 2;
  globalThis.crypto.getRandomValues = (buf) => {
    if (forced > 0 && buf.length === 4) { forced -= 1; buf.fill(0x11); return buf; }
    return realRV(buf);
  };
  let wa, wb;
  try {
    wa = mkws(A); wb = mkws(B);
    lobbyOf(wa, wb);
  } finally { globalThis.crypto.getRandomValues = realRV; }
  const h0 = wireHandle(wa, 0), h1 = wireHandle(wa, 1);
  if (h0 === '11111111') ok('(b) the forced draw reached makeHandle — the first seat holds it');
  else fail('(b) the forcing stub did not take: seat 0 holds ' + JSON.stringify(h0));
  if (h1 && h1 !== h0) ok('(b) the second seat drew the same bytes and was minted again — unique within the room');
  else fail('(b) a collision was kept: ' + JSON.stringify([h0, h1]));

  // A SECOND ROOM MAY HOLD THE SAME STRING. Resolution is scoped to the asking
  // socket's own room, so two rooms cannot collide — which is what "meaningless
  // outside its room" has to mean concretely.
  const wc = mkws(C);
  lobbyOf(wc);
  const hC = wireHandle(wc, 0);                      // C's own, before the forge
  roomOf(wc).players[0].handle = h0;                 // the same string, another room
  if (resolveSeatHandle(wa, h0) === A && resolveSeatHandle(wc, h0) === C)
    ok('(b) two rooms hold the same handle and each resolves to its own seat');
  else fail('(b) cross-room collision: ' + JSON.stringify([resolveSeatHandle(wa, h0), resolveSeatHandle(wc, h0)]));
  if (resolveSeatHandle(wa, hC) === null) ok('(b) and a handle only the other room ever held reaches nobody');
  else fail('(b) a handle crossed rooms: ' + resolveSeatHandle(wa, hC));
  leave(wc); leave(wb); leave(wa);
}

// ---- (c) a handle is useless outside its room, and dies with it ------------
{
  const wa = mkws(A), wb = mkws(B);
  lobbyOf(wa, wb);
  const code = wa.roomCode;
  const hB = wireHandle(wa, 1);
  const wOut = mkws(C);                                // signed in, not in the room
  lobbyOf(wOut);                                       // a room of their own
  if (resolveSeatHandle(wOut, hB) === null) ok('(c) a socket in another room resolves this room\'s handle to nothing');
  else fail('(c) an outsider resolved the handle to ' + resolveSeatHandle(wOut, hB));

  // A socket with no room at all, and one claiming a room it does not sit in.
  const wNone = mkws(C);
  if (resolveSeatHandle(wNone, hB) === null) ok('(c) a socket with no room resolves nothing');
  else fail('(c) a roomless socket resolved a handle');
  wNone.roomCode = code; wNone.seat = 0;               // a forged claim on a real room
  if (resolveSeatHandle(wNone, hB) === null) ok('(c) claiming the room code is not enough — the asker must hold a seat in it');
  else fail('(c) a forged roomCode resolved a handle: ' + resolveSeatHandle(wNone, hB));

  if (resolveSeatHandle(wa, hB) === B) ok('(c) a seated player resolves a seat in their own room');
  else fail('(c) a seated player could not resolve: ' + resolveSeatHandle(wa, hB));

  // AND IT DOES NOT SURVIVE THE ROOM. The handle lives on the seat object, so
  // the room being deleted is the expiry — there is nothing to sweep.
  leave(wb); leave(wa);
  if (!rooms.has(code)) ok('(c) the room is gone');
  else fail('(c) the room survived the last player leaving');
  wa.roomCode = code;                                  // as a stale client would
  if (resolveSeatHandle(wa, hB) === null) ok('(c) a handle from a finished room resolves to nothing');
  else fail('(c) a dead room still resolved a handle: ' + resolveSeatHandle(wa, hB));
  leave(wOut);
}

// ---- (d) a seat with no account cannot be made to resolve to somebody ------
// A real CPU seat from the real 'ai' path, handed a handle by force. There is
// no account on it, so there is nobody for it to resolve to — which is the
// property a bot and a never-saved guest share.
{
  const wa = mkws(A);
  handleClientMessage(wa, { type: 'ai', difficulty: 'easy', name: ROLLED, skin: 'olive' });
  const seats = seatsOf(wa);
  const bot = seats[1];
  if (bot && bot.bot === true && bot.ws === null) ok('(d) a real CPU seat');
  else fail('(d) no CPU seat: ' + JSON.stringify(seats.length));
  if (bot && bot.handle === undefined) ok('(d) a CPU seat was never minted a handle');
  else fail('(d) a CPU seat holds a handle: ' + JSON.stringify(bot && bot.handle));
  bot.handle = 'deadbeef';
  if (resolveSeatHandle(wa, 'deadbeef') === null) ok('(d) even a forged handle on an accountless seat resolves to nobody');
  else fail('(d) an accountless seat resolved to ' + resolveSeatHandle(wa, 'deadbeef'));

  // AND "NO HANDLE" IS NOT A HANDLE. An 'ai' room never broadcasts a lobby, so
  // the HUMAN seat here holds an account and no handle at all — and a lookup
  // that did not insist on a string would match it on `undefined` and hand back
  // a real account to anyone who could get a non-string past the wire.
  if (seats[0] && seats[0].handle === undefined && resolveSeatHandle(wa, undefined) === null)
    ok('(d) an unminted seat is not reachable by sending nothing');
  else fail('(d) undefined resolved to ' + resolveSeatHandle(wa, undefined));
  leave(wa);
}

// ---- (e) report and block through a handle, over the real seam -------------
{
  const st = memStore(ROWS);
  const S = mkSocial(st);
  const wa = mkws(A), wb = mkws(B);
  lobbyOf(wa, wb);
  S.onAuth(wa); S.onAuth(wb);
  const hA = wireHandle(wa, 0), hB = wireHandle(wa, 1);

  // THE HAPPY PATH, and it is also the proof that resolution runs BEFORE the
  // uuid-shape test: a handle is not a uuid, so isUuid first would refuse every
  // honest frame with no_such_user.
  const log = await withLog(() => S.handle(wa, { type: 'report', handle: hB, id: 11 }));
  const r = lastOf(wa, 'report');
  if (r && r.ok === true && r.id === 11) ok('(e) report by handle is answered ok, with the correlation id echoed');
  else fail('(e) report by handle replied ' + JSON.stringify(r));
  if (st.reports.length === 1 && st.reports[0].reported === B && st.reports[0].reporter === A)
    ok('(e) the row names the resolved ACCOUNT, both sides');
  else fail('(e) report rows: ' + JSON.stringify(st.reports));
  if (st.reports[0] && st.reports[0].callsign === 'Bunker Nine') ok('(e) and it keeps the name the reporter saw');
  else fail('(e) reported name: ' + JSON.stringify(st.reports[0] && st.reports[0].callsign));

  // THE HANDLE MUST NEVER REACH THE LOG. The line keeps the resolved uuid, as
  // it does today: a room-scoped token in a log that outlives the room makes
  // the line and the row unreconcilable and puts the token somewhere it was
  // never meant to be.
  if (log.length === 1 && log[0].includes(B) && log[0].includes(A) && !log[0].includes(hB) && !log[0].includes(hA))
    ok('(e) the log line carries both account ids and neither handle');
  else fail('(e) log line: ' + JSON.stringify(log));

  // BLOCK TAKES THE SAME DOOR.
  await S.handle(wa, { type: 'block', op: 'add', handle: hB, id: 12 });
  const bl = lastOf(wa, 'block');
  if (bl && bl.ok === true && bl.op === 'add') ok('(e) block add by handle is answered ok, with its op');
  else fail('(e) block by handle replied ' + JSON.stringify(bl));
  if (st.blocks.has(A + '>' + B)) ok('(e) the block row names the resolved account');
  else fail('(e) block rows: ' + JSON.stringify([...st.blocks]));

  leave(wb); leave(wa);
}

// ---- (f) resolution runs BEFORE the self check ----------------------------
// Your own seat's handle is in your own lobby payload. Resolve after the self
// check and `handle === wireId(ws.userId)` compares a token to an account id,
// is false, and a player reports themselves.
{
  const st = memStore(ROWS);
  const S = mkSocial(st);
  const wa = mkws(A), wb = mkws(B);
  lobbyOf(wa, wb);
  S.onAuth(wa);
  const hA = wireHandle(wa, 0);
  const log = await withLog(() => S.handle(wa, { type: 'report', handle: hA, id: 21 }));
  const r = lastOf(wa, 'report');
  if (r && r.error === 'self') ok('(f) reporting your own seat\'s handle is caught as self');
  else fail('(f) self-report by handle replied ' + JSON.stringify(r));
  if (st.reports.length === 0 && log.length === 0) ok('(f) and it wrote no row and logged no line');
  else fail('(f) a self-report got through: ' + JSON.stringify([st.reports, log]));

  await S.handle(wa, { type: 'block', op: 'add', handle: hA, id: 22 });
  const bl = lastOf(wa, 'block');
  if (bl && bl.error === 'self' && bl.op === 'add') ok('(f) blocking your own seat is caught as self too');
  else fail('(f) self-block by handle replied ' + JSON.stringify(bl));
  if (st.blocks.size === 0) ok('(f) and no block row was written');
  else fail('(f) a self-block wrote ' + JSON.stringify([...st.blocks]));
  leave(wb); leave(wa);
}

// ---- (g) one form, never either — a raw uuid in `handle` is not a target ---
// If a raw account id worked here, the leak this whole mechanism exists to
// avoid would be back through the door marked exit: a modified client would
// simply send the uuid it was never given and the lobby payload would be the
// only thing that had changed.
{
  const st = memStore(ROWS);
  const S = mkSocial(st);
  const wa = mkws(A), wb = mkws(B);
  lobbyOf(wa, wb);
  S.onAuth(wa);
  const hB = wireHandle(wa, 1);

  const log = await withLog(() => S.handle(wa, { type: 'report', handle: B, id: 31 }));
  let r = lastOf(wa, 'report');
  if (r && r.error === 'no_such_user') ok('(g) a raw account uuid in `handle` resolves to nothing');
  else fail('(g) a raw uuid in handle replied ' + JSON.stringify(r));
  if (st.reports.length === 0 && log.length === 0) ok('(g) and it wrote no row and logged no line');
  else fail('(g) a raw uuid in handle got through: ' + JSON.stringify([st.reports, log]));

  await S.handle(wa, { type: 'block', op: 'add', handle: B, id: 32 });
  const bl = lastOf(wa, 'block');
  if (bl && bl.error === 'no_such_user' && bl.op === 'add' && st.blocks.size === 0) ok('(g) and block refuses it the same way');
  else fail('(g) block with a raw uuid in handle: ' + JSON.stringify([bl, [...st.blocks]]));

  // WHEN A HANDLE IS PRESENT, `id` IS NOT A TARGET. It is the correlation echo
  // it is on every other frame, so a client cannot name one player in `handle`
  // and a different one in `id` and have the second one be the one filed
  // against.
  await withLog(() => S.handle(wa, { type: 'report', handle: hB, id: C }));
  r = lastOf(wa, 'report');
  if (st.reports.length === 1 && st.reports[0].reported === B) ok('(g) handle wins outright: the row names the handle\'s seat, not the uuid in `id`');
  else fail('(g) the id field was used as a target: ' + JSON.stringify(st.reports));
  if (r && r.ok === true && r.id === C) ok('(g) `id` came back as the pure echo it now is');
  else fail('(g) echo: ' + JSON.stringify(r));

  // AN UNKNOWN HANDLE IS A MISS, NOT A CRASH — and the honest word for an
  // expired one, which is why Task 8 must not offer Report on a card whose
  // room has ended.
  // A MISS MUST NOT FALL BACK TO `id`. This is the same back door as (g) above
  // wearing a different coat: a client sends a dead handle and the uuid it was
  // never given, and a resolver that treats the handle as optional files the
  // report against the uuid.
  await withLog(() => S.handle(wa, { type: 'report', handle: 'ffffffff', id: C }));
  r = lastOf(wa, 'report');
  if (r && r.error === 'no_such_user' && st.reports.length === 1) ok('(g) an unknown or expired handle is no_such_user — it does not fall back to `id`');
  else fail('(g) unknown handle replied ' + JSON.stringify(r) + ' rows ' + JSON.stringify(st.reports));
  if (!st.reports.some((x) => x.reported === C)) ok('(g) and nothing was ever filed against the uuid in `id`');
  else fail('(g) the dead handle fell back to the id: ' + JSON.stringify(st.reports));
  // THE JUNK SWEEP RUNS ON block, which design 4.2 rate limits not at all: the
  // same targetId, and seven frames of report on one socket would prove the
  // five-a-minute bucket rather than the resolver. A fresh socket, holding no
  // room — itself one of the misses, because null is null however it is reached.
  const wj = mkws(A);
  let junkBad = null;
  for (const bad of [null, 5, {}, [], '', true, 'x'.repeat(4096), B.toUpperCase()]) {
    await S.handle(wj, { type: 'block', op: 'add', handle: bad, id: 34 });
    const rr = lastOf(wj, 'block');
    if (!rr || rr.error !== 'no_such_user') { junkBad = '(g) junk handle ' + JSON.stringify(bad).slice(0, 40) + ' replied ' + JSON.stringify(rr); break; }
  }
  if (!junkBad && st.blocks.size === 0) ok('(g) every junk shape of `handle` is refused rather than thrown on, and none of them wrote');
  else fail(junkBad || '(g) a junk handle wrote a block row: ' + JSON.stringify([...st.blocks]));
  // And the same two shapes on report, inside its bucket.
  await withLog(() => S.handle(wj, { type: 'report', handle: {}, id: 35 }));
  const rj1 = lastOf(wj, 'report');
  await withLog(() => S.handle(wj, { type: 'report', handle: null, id: 36 }));
  const rj2 = lastOf(wj, 'report');
  if (rj1 && rj1.error === 'no_such_user' && rj2 && rj2.error === 'no_such_user') ok('(g) report refuses the same shapes');
  else fail('(g) report on junk: ' + JSON.stringify([rj1, rj2]));
  leave(wb); leave(wa);
}

// ---- (h) the friends-panel path is untouched ------------------------------
// `id` stays a uuid the SERVER handed out — a friends list, a search result, a
// blocked list. The two routes are different fields and are never
// interchangeable: a uuid in `handle` resolves to nothing (g), and a handle in
// `id` fails the uuid shape test below.
{
  const st = memStore(ROWS);
  const S = mkSocial(st);
  const wa = mkws(A), wb = mkws(B);
  lobbyOf(wa, wb);
  S.onAuth(wa);
  const hB = wireHandle(wa, 1);

  const log = await withLog(() => S.handle(wa, { type: 'report', id: B }));
  const r = lastOf(wa, 'report');
  if (r && r.ok === true && st.reports.length === 1 && st.reports[0].reported === B)
    ok('(h) a report with no `handle` still takes the uuid route the friends panel uses');
  else fail('(h) the uuid route broke: ' + JSON.stringify([r, st.reports]));
  if (log.length === 1 && log[0].includes(B)) ok('(h) and it logs exactly as it did before');
  else fail('(h) log: ' + JSON.stringify(log));

  await withLog(() => S.handle(wa, { type: 'report', id: hB }));
  const r2 = lastOf(wa, 'report');
  if (r2 && r2.error === 'no_such_user' && st.reports.length === 1) ok('(h) a handle sent in `id` is refused — it is not a uuid');
  else fail('(h) a handle in id: ' + JSON.stringify([r2, st.reports]));
  leave(wb); leave(wa);
}

// ---- (i) a guest may report and block by handle; nobody may without an account
// BINDING resolution 18: the guest who sees an offensive name in a lobby is
// exactly the player who needs to report it, and a lobby is now where they can.
{
  const st = memStore(ROWS);
  const S = mkSocial(st);
  const wg = mkws(GUEST, true), wb = mkws(B);
  lobbyOf(wg, wb);
  S.onAuth(wg);
  const hB = wireHandle(wg, 1);
  if (/^[0-9a-f]{8}$/.test(String(hB))) ok('(i) a guest\'s lobby carries the other seat\'s handle');
  else fail('(i) no handle in the guest\'s lobby: ' + JSON.stringify(hB));
  const log = await withLog(() => S.handle(wg, { type: 'report', handle: hB, id: 41 }));
  const r = lastOf(wg, 'report');
  if (r && r.ok === true && st.reports[0] && st.reports[0].reporter === GUEST && st.reports[0].reported === B)
    ok('(i) a guest reports a stranger in a lobby, by handle');
  else fail('(i) guest report: ' + JSON.stringify([r, st.reports]));
  if (log.length === 1 && !log[0].includes(hB)) ok('(i) the guest\'s report logs the accounts and not the handle');
  else fail('(i) guest log: ' + JSON.stringify(log));
  await S.handle(wg, { type: 'block', op: 'add', handle: hB, id: 42 });
  if (st.blocks.has(GUEST + '>' + B)) ok('(i) and blocks them');
  else fail('(i) guest block rows: ' + JSON.stringify([...st.blocks]));

  // A socket that never said hello has no account to file against, handle or
  // not: the gate does not move because a handle is involved.
  const wn = mkws(null);
  lobbyOf(wn);
  const hSelf = wireHandle(wn, 0);
  await S.handle(wn, { type: 'report', handle: hB, id: 43 });
  const sn = lastOf(wn, 'social');
  if (sn && sn.error === 'sign_in' && !lastOf(wn, 'report')) ok('(i) a socket with no account is still answered sign_in');
  else fail('(i) accountless report: ' + JSON.stringify([sn, lastOf(wn, 'report')]));
  if (hSelf === undefined) ok('(i) and its own seat was never minted a handle to begin with');
  else fail('(i) an accountless socket got a handle: ' + JSON.stringify(hSelf));
  leave(wn); leave(wb); leave(wg);
}

// ---- (l) a player who walks out mid-match can still be reported -----------
// The seat keeps the account when the socket goes (handleClose carries ws.userId
// onto the player, for the push nudges), and the handle is on the same object —
// so the player who said something and then pulled the plug is exactly as
// reportable as one still sitting there. A resolver that read only the socket
// would make quitting the way to escape a report.
{
  const wa = mkws(A), wb = mkws(B);
  handleClientMessage(wa, { type: 'create', mode: 'ffa', max: 3, name: ROLLED, skin: 'olive' });
  handleClientMessage(wb, { type: 'join', code: wa.roomCode, name: ROLLED, skin: 'olive' });
  const hA = wireHandle(wb, 0);
  handleClientMessage(wa, { type: 'startMatch' });
  const room = roomOf(wb);
  if (room && room.state === 'playing') ok('(l) a three-seat ffa started with two commanders');
  else fail('(l) the room did not start: ' + JSON.stringify(room && room.state));
  engine.handleClose(wa);                       // the socket drops, the seat stays
  const seatA = room.players[0];
  if (seatA && seatA.ws === null && seatA.connected === false) ok('(l) the seat is held with no socket on it');
  else fail('(l) seat 0 after the drop: ' + JSON.stringify(seatA && { ws: seatA.ws, connected: seatA.connected }));
  if (resolveSeatHandle(wb, hA) === A) ok('(l) and their handle still resolves to the account they left behind');
  else fail('(l) a disconnected seat resolved to ' + resolveSeatHandle(wb, hA));
  leave(wb);
  if (!rooms.size) ok('(l) the room went with the last player');
  else fail('(l) rooms left: ' + rooms.size);
}

// ---- (k) a host that wires no resolver resolves NOTHING --------------------
// The default has to fail closed. A createSocial built without a resolver — an
// older host, a test, a future embedding — must not treat the handle as a
// target by passing it through, or the shape of the frame alone decides who
// gets reported.
{
  const st = memStore(ROWS);
  const S = createSocial({ store: st, terms: [], send: (ws, frame) => ws._rx.push(frame), now: () => 1700000000000 });
  const wa = mkws(A), wb = mkws(B);
  lobbyOf(wa, wb);
  S.onAuth(wa);
  const hB = wireHandle(wa, 1);
  const log = await withLog(() => S.handle(wa, { type: 'report', handle: hB, id: 51 }));
  const r = lastOf(wa, 'report');
  if (r && r.error === 'no_such_user' && st.reports.length === 0 && log.length === 0)
    ok('(k) with no resolver injected, a handle names nobody and writes nothing');
  else fail('(k) unwired host: ' + JSON.stringify([r, st.reports, log]));
  const uuidLog = await withLog(() => S.handle(wa, { type: 'report', id: B }));
  if (lastOf(wa, 'report').ok === true && st.reports.length === 1 && uuidLog.length === 1)
    ok('(k) and the friends-panel uuid route still works on the same unwired host');
  else fail('(k) the uuid route broke without a resolver: ' + JSON.stringify(st.reports));
  leave(wb); leave(wa);
}

// ---- (m) the offline page's payload does not move by a byte ---------------
// public/app.js's stand-in socket (startLocal, `engineLink`) carries exactly
// two properties — readyState and send — and the engine hangs roomCode and seat
// on it. There is no account on it and there never can be, because offline
// there is no server to verify one. So every offline seat takes the accountless
// branch and the players array is the SAME two-key object it has always been.
// ADR-001: the offline page must gain nothing from this change, and this is the
// assertion rather than the intention.
{
  const link = { readyState: 1, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } };
  handleClientMessage(link, { type: 'create', mode: 'ffa', max: 4, name: ROLLED, skin: 'olive' });
  const l = lastOf(link, 'lobby');
  const seat = l && l.players && l.players[0];
  const keys = seat ? Object.keys(seat).sort() : [];
  if (JSON.stringify(keys) === JSON.stringify(['name', 'skin'])) ok('(m) an offline-shaped socket produces a seat of exactly { name, skin }');
  else fail('(m) the offline lobby seat carries ' + JSON.stringify(keys));
  if (JSON.stringify(l.players) === JSON.stringify([{ name: seat && seat.name, skin: seat && seat.skin }]))
    ok('(m) and the whole players array is the literal it always was');
  else fail('(m) offline players: ' + JSON.stringify(l && l.players));
  leave(link);
}

// ---- (j) nothing escaped, and nothing was left behind ---------------------
if (!escaped) ok('(j) no throw escaped the engine');
else fail('(j) uncaught: ' + escaped.message);
if (rooms.size === 0) ok('(j) every room this suite made was torn down');
else fail('(j) rooms left in memory: ' + rooms.size);

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall seat-handle checks passed');
process.exit(out.errors.length ? 1 : 0);
