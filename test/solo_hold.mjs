// A match with no other human waits a day for its player (owner, 2026-10-07:
// "the server keeps any match with no other HUMAN players for 24 hours in
// every mode; reopen -> back on your turn"). The REAL room engine, in process,
// on a FAKE CLOCK, so a day is a day and not an env knob standing in for one:
//   1. in every mode alone (Duel and FFA against the computer, a Boss raid and
//      an Alien raid alone, golf alone) the match is kept 23 hours with nothing
//      moving, and the resume puts the player back on their turn, able to fire;
//   2. 24 hours and 1 ms after the player went, it is gone and the resume is
//      refused; and the day counts from the LAST time the player went;
//   3. a CPU part-way through its turn when the player went (thinking, driving
//      or aiming) does not finish it while they are away, and plays it once
//      they are back; a shell already in the air lands and hands the turn on
//      once, and then nothing moves;
//   4. one held match per player: a new match by the same resume token or the
//      same account ends the held one at once, and of two matches one account
//      left, only the newer is kept; nobody else's match is touched, neither a
//      match its player came back to nor a room with another human is ever
//      ended this way, and at the server's capacity the held match's place is
//      freed for the new one;
//   5. a cap on held matches server-wide, the one held longest going first; a
//      room with another human, or a match its player came back to, never
//      counts and is never evicted; moving on from a live match never evicts
//      anyone; and the cap is 100 at the default MAX_ROOMS;
//   6. a room with another human keeps today's rules: a 2-minute seat, then a
//      forfeit, and the half-hour hold once everyone has gone;
//   7. moving on from a live match alone still takes the socket out of the
//      quick-match queue, as handleClose did on that path.
// Headless: no server, no Chrome.
//
// WHY THIS EXISTS: the bug it answers (update 8, item 21) was a 30-minute timer
// nobody had noticed was the whole of "come back later". Only a clock that can
// really run 23 and 24 hours tells a day-long hold from a long knob.

// THE CLOCK. Installed before the engine is imported, because the engine reads
// setTimeout, setInterval and Date.now when it calls them; every timer it arms
// lands here and runs only when advance() reaches it, in time order.
let NOW = Date.UTC(2026, 9, 7, 9, 0, 0);
let SEQ = 0;
const TIMERS = new Map();
globalThis.setTimeout = (fn, ms = 0) => { const id = ++SEQ; TIMERS.set(id, { at: NOW + Math.max(0, Number(ms) || 0), fn }); return id; };
globalThis.setInterval = (fn, ms = 0) => { const every = Math.max(1, Number(ms) || 0); const id = ++SEQ; TIMERS.set(id, { at: NOW + every, fn, every }); return id; };
globalThis.clearTimeout = (id) => { TIMERS.delete(id); };
globalThis.clearInterval = (id) => { TIMERS.delete(id); };
Date.now = () => NOW;
function advance(ms) {
  const end = NOW + ms;
  for (let runs = 0; ; runs++) {
    if (runs > 500000) throw new Error('the fake clock ran away: a timer re-arms for ever');
    let id = 0, t = null;
    for (const [k, v] of TIMERS) if (v.at <= end && (!t || v.at < t.at || (v.at === t.at && k < id))) { id = k; t = v; }
    if (!t) break;
    NOW = t.at;
    if (t.every) t.at += t.every; else TIMERS.delete(id);
    t.fn();
  }
  NOW = end;
}
const H = 60 * 60 * 1000;

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };

const E = await import('../public/room-engine.js');
// A SECOND ENGINE with a small cap, for section 5: a module URL with a query is
// a separate instance with its own rooms, reading its env when it is imported.
process.env.MAX_HELD_ROOMS = '3';
const C = await import('../public/room-engine.js?held-cap');
delete process.env.MAX_HELD_ROOMS;
// A THIRD with room for two matches in all, for (4h).
process.env.MAX_ROOMS = '2';
const R = await import('../public/room-engine.js?rooms-cap');
delete process.env.MAX_ROOMS;

const faults = [];
for (const eng of [E, C, R]) eng.setFaultSink((e) => faults.push(e));

const LOADOUT = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
let wsSeq = 0;
const mkws = (userId) => ({ n: ++wsSeq, readyState: 1, _rx: [], ...(userId ? { userId } : {}), send(s) { this._rx.push(JSON.parse(s)); } });
const last = (ws, type) => ws._rx.filter((m) => m.type === type).pop() || null;
const count = (ws, type) => ws._rx.filter((m) => m.type === type).length;
// A socket going away is the host calling handleClose, as server.js does on 'close'.
const gone = (eng, ws) => { ws.readyState = 3; eng.handleClose(ws); };
const resume = (eng, start) => { const ws = mkws(); eng.handleClientMessage(ws, { type: 'resume', code: start.code, token: start.token }); return ws; };
const leave = (eng, ws) => eng.handleClientMessage(ws, { type: 'leave' });

// Start a match alone in mode `mode` on engine `eng`, and run the clock until
// it is the player's turn. Returns the socket, its room and its 'start' frame.
function solo(eng, mode, ws = mkws(), extra = {}) {
  const m = { name: 'Solo', skin: 'olive', ...extra };
  if (mode === 'duel') eng.handleClientMessage(ws, { type: 'ai', difficulty: 'hard', loadout: LOADOUT, ...m });
  else if (mode === 'ffa') eng.handleClientMessage(ws, { type: 'ai', mode: 'ffa', max: 4, difficulty: 'hard', loadout: LOADOUT, ...m });
  else if (mode === 'golf') eng.handleClientMessage(ws, { type: 'create', mode: 'golf', max: 1, tees: 'mens', ...m });
  else { eng.handleClientMessage(ws, { type: 'create', mode, ...m }); eng.handleClientMessage(ws, { type: 'startMatch' }); }
  const room = eng.rooms.get(ws.roomCode);
  // Past the draft window (Boss and Alien raids draft at the start) and the
  // opening, until the engine is waiting on the player.
  for (let i = 0; i < 120 && !(room && room.state === 'playing' && !room.picking && room.turn === ws.seat && !room.clock && !room.shotPending); i++) advance(1000);
  return { ws, room, start: last(ws, 'start') };
}
// What would show that anything happened in a room: whose turn, how many turns,
// every tank's place and health, every seat's ammunition.
const sig = (room) => JSON.stringify({
  state: room.state, turn: room.turn, turns: room.turnCount, hp: room.hp,
  x: (room.tanks || []).map((t) => t.x), ammo: room.ammo, golf: room.golf ? room.golf.strokes : null,
});
const held = (eng) => [...eng.rooms.values()].filter((r) => r.heldSince);

// ---- 1 + 2. Every mode, alone: 23 hours kept, 24 hours and 1 ms gone ------
for (const mode of ['duel', 'ffa', 'boss', 'aliens', 'golf']) {
  {
    const { ws, room, start } = solo(E, mode);
    if (!room || !start || room.turn !== start.you) { fail(`(1 ${mode}) could not reach the player's turn`); continue; }
    const before = sig(room);
    gone(E, ws);
    advance(23 * H);
    if (E.rooms.get(room.code) === room && room.state === 'playing') ok(`(1 ${mode}) the match is still held 23 hours after the player went`);
    else fail(`(1 ${mode}) the match was not kept 23 hours`);
    if (sig(room) === before) ok(`(1 ${mode}) nothing moved in 23 hours: same turn, same tanks, same health, nobody forfeited`);
    else fail(`(1 ${mode}) the match moved while the player was away: ${before} -> ${sig(room)}`);
    const back = resume(E, start);
    const r = last(back, 'restore');
    if (r && r.you === start.you && r.turn === start.you && r.code === room.code) ok(`(1 ${mode}) the resume puts the player back in their seat, on their turn`);
    else fail(`(1 ${mode}) resume answered ${JSON.stringify(back._rx.map((m) => m.type))}, turn ${r && r.turn}, you ${r && r.you}`);
    E.handleClientMessage(back, { type: 'fire', weapon: mode === 'golf' ? 'golfball' : 'cannon', angle: 50, power: 40 });
    if (last(back, 'shot') && last(back, 'shot').by === start.you) ok(`(1 ${mode}) and fire: the shot is taken`);
    else fail(`(1 ${mode}) the returning player's shot was not taken`);
    leave(E, back);
  }
  {
    const { ws, room, start } = solo(E, mode);
    gone(E, ws);
    advance(24 * H - 1);
    const kept = E.rooms.get(room.code) === room;
    advance(2);
    const ended = !E.rooms.has(room.code);
    if (kept && ended) ok(`(2 ${mode}) kept until the day is up, gone 24 hours and 1 ms after the player went`);
    else fail(`(2 ${mode}) at 24 h - 1 ms kept=${kept}, at 24 h + 1 ms ended=${ended}`);
    const back = resume(E, start);
    if (last(back, 'resumeError') && !last(back, 'restore')) ok(`(2 ${mode}) a resume after that is refused (resumeError)`);
    else fail(`(2 ${mode}) a resume after the day answered ${JSON.stringify(back._rx.map((m) => m.type))}`);
  }
}
{
  // THE DAY COUNTS FROM THE LAST TIME THE PLAYER WENT: back after 20 hours,
  // away again, and the match is still there 23 hours after that.
  const { ws, room, start } = solo(E, 'ffa');
  gone(E, ws);
  advance(20 * H);
  const back = resume(E, start);
  advance(60 * 1000);
  gone(E, back);
  advance(23 * H);
  const kept = E.rooms.get(room.code) === room;
  advance(H + 1);
  if (last(back, 'restore') && kept && !E.rooms.has(room.code)) ok('(2) the day counts from the last time the player went: back after 20 h, away again, kept 23 h more, gone at 24 h');
  else fail(`(2) day from the last leave: restored ${!!last(back, 'restore')}, kept 23 h after the second leave ${kept}, gone at 24 h ${!E.rooms.has(room.code)}`);
}

// ---- 3. A CPU part-way through its turn does not finish it while you are away
// A free-for-all alone, the player fires, and the clock runs in 5 ms steps
// until the CPU now playing is in `phase` of its turn:
//   think  its turn has begun and it has done nothing yet;
//   drive  it has driven at least one step and has not turned its gun;
//   aim    it has turned its gun ('aim') and not fired;
//   air    it has fired and the turn has not been handed on yet.
// CPUs choose at random whether to drive, so a match that never shows the
// phase is left and another one started.
function cpuAt(phase) {
  for (let tries = 0; tries < 40; tries++) {
    // Easy CPUs, so three of them in a row never end the match on the player.
    const m = solo(E, 'ffa', mkws(), { difficulty: 'easy' });
    const { ws, room, start } = m;
    E.handleClientMessage(ws, { type: 'fire', weapon: 'cannon', angle: 60, power: 30 });
    for (let i = 0; i < 6000 && room.state === 'playing'; i++) {
      advance(5);
      if (room.turn === start.you && !room.shotPending) break;          // round over: not in this match
      const cpu = room.turn;
      if (cpu === start.you || !room.players[cpu].bot) continue;
      let at = -1;
      for (let k = ws._rx.length - 1; k >= 0; k--) if (ws._rx[k].type === 'turn' && ws._rx[k].turn === cpu) { at = k; break; }
      if (at < 0) continue;
      const since = ws._rx.slice(at + 1);
      const moved = since.some((f) => f.type === 'move' && f.seat === cpu);
      const aimed = since.some((f) => f.type === 'aim' && f.seat === cpu);
      const shot = since.some((f) => f.type === 'shot' && f.by === cpu);
      const hit = phase === 'think' ? !moved && !aimed && !shot
        : phase === 'drive' ? moved && !aimed && !shot
        : phase === 'aim' ? aimed && !shot
        : shot && room.clock;
      if (hit) return { ...m, cpu };
    }
    leave(E, ws);
  }
  return null;
}
for (const phase of ['think', 'drive', 'aim']) {
  const m = cpuAt(phase);
  if (!m) { fail(`(3 ${phase}) never caught a CPU ${phase === 'think' ? 'thinking' : phase === 'drive' ? 'driving' : 'aiming'}`); continue; }
  const { ws, room, start, cpu } = m;
  const turns = room.turnCount;
  gone(E, ws);
  const before = sig(room);
  advance(23 * H);
  if (room.turn === cpu && room.turnCount === turns && sig(room) === before) ok(`(3 ${phase}) a CPU ${phase === 'think' ? 'thinking' : phase === 'drive' ? 'driving' : 'aiming'} when the player went plays nothing in 23 hours: no step, no shot, same turn`);
  else fail(`(3 ${phase}) the CPU played on while nobody watched: turn ${cpu} -> ${room.turn}, turns ${turns} -> ${room.turnCount}, ${before} -> ${sig(room)}`);
  const back = resume(E, start);
  const r = last(back, 'restore');
  if (r && r.turn === cpu) ok(`(3 ${phase}) the resume shows that CPU still to play`);
  else fail(`(3 ${phase}) resume answered turn ` + (r && r.turn));
  for (let i = 0; i < 4000 && room.turn !== start.you; i++) advance(25);
  const cpuShots = back._rx.filter((f) => f.type === 'shot' && room.players[f.by] && room.players[f.by].bot).length;
  if (room.turn === start.you && back._rx.some((f) => f.type === 'shot' && f.by === cpu) && cpuShots >= 4 - cpu) ok(`(3 ${phase}) back with the player, that CPU and the rest take their turns, and it is the player's again`);
  else fail(`(3 ${phase}) after the resume turn ${room.turn}, CPU shots seen ${cpuShots}`);
  leave(E, back);
}
{
  // A SHELL ALREADY IN THE AIR lands and hands the turn on, once, as it would
  // have; and then nothing at all moves.
  const m = cpuAt('air');
  if (!m) fail('(3 air) never caught a CPU shell in the air');
  else {
    const { ws, room, start, cpu } = m;
    const turns = room.turnCount;
    gone(E, ws);
    advance(60 * 1000);
    const settled = sig(room);
    advance(23 * H);
    if (room.turnCount === turns + 1 && room.turn !== cpu && sig(room) === settled && E.rooms.get(room.code) === room) ok('(3 air) a CPU shell in the air when the player went lands and hands the turn on once; then nothing moves for 23 hours');
    else fail(`(3 air) turns ${turns} -> ${room.turnCount}, turn ${cpu} -> ${room.turn}, moved after the handover ${sig(room) !== settled}`);
    leave(E, resume(E, start));
  }
}

// ---- 4. One held match per player ---------------------------------------------
{
  // (a) THE RESUME TOKEN: a new vs-Computer start carrying it ends that match.
  const a = solo(E, 'ffa');
  gone(E, a.ws);
  const other = solo(E, 'duel');                  // another guest's held match
  gone(E, other.ws);
  advance(5000);
  const b = solo(E, 'duel', mkws(), { held: a.start.token });
  if (!E.rooms.has(a.room.code)) ok('(4a) a new match carrying the held match\'s token ends the held match at once');
  else fail('(4a) the held match outlived a new match carrying its token');
  if (b.room && b.room.state === 'playing' && b.room !== a.room) ok('(4a) and the new match starts');
  else fail('(4a) the new match did not start');
  if (E.rooms.get(other.room.code) === other.room) ok('(4a) another player\'s held match is untouched');
  else fail('(4a) another player\'s held match was ended');
  // (b) A create frame carries it too.
  gone(E, b.ws);
  const c = solo(E, 'golf', mkws(), { held: b.start.token });
  if (!E.rooms.has(b.room.code) && c.room && c.room.state === 'playing') ok('(4b) a create carrying the token ends the held match too');
  else fail('(4b) a create carrying the token left the held match');
  // (c) A token that names nothing held ends nothing: a wrong string, a
  // non-string, and the token of a match whose player is still connected.
  const n0 = E.rooms.size;
  for (const bad of ['0123456789abcdef01234567', 12, { token: other.start.token }, [other.start.token]]) {
    const s = mkws(); E.handleClientMessage(s, { type: 'ai', difficulty: 'easy', name: 'X', skin: 'olive', loadout: LOADOUT, held: bad }); leave(E, s);
  }
  const s2 = mkws(); E.handleClientMessage(s2, { type: 'ai', difficulty: 'easy', name: 'X', skin: 'olive', loadout: LOADOUT, held: c.start.token }); leave(E, s2);
  if (E.rooms.size === n0 && E.rooms.get(other.room.code) === other.room && E.rooms.get(c.room.code) === c.room) ok('(4c) a wrong token, a non-string, or the token of a match still being played ends nothing');
  else fail(`(4c) rooms ${n0} -> ${E.rooms.size}; other kept ${E.rooms.has(other.room.code)}, live kept ${E.rooms.has(c.room.code)}`);
  leave(E, c.ws);
  // (d) THE ACCOUNT: a new match by the same account ends its held match,
  // with no token sent at all. Another account's is untouched.
  const u1 = solo(E, 'ffa', mkws('acct-1'));
  gone(E, u1.ws);
  const u2 = solo(E, 'duel', mkws('acct-2'));
  gone(E, u2.ws);
  const u1b = solo(E, 'duel', mkws('acct-1'));
  if (!E.rooms.has(u1.room.code) && E.rooms.get(u2.room.code) === u2.room) ok('(4d) a new match by the same account ends its held match; another account\'s is kept');
  else fail(`(4d) acct-1's held match kept=${E.rooms.has(u1.room.code)}, acct-2's kept=${E.rooms.has(u2.room.code)}`);
  leave(E, u1b.ws);
  // (e) TWO MATCHES ONE ACCOUNT LEFT: both live, then both left. A new match
  // does not end a match still being played; once both are held, only the
  // newer is kept.
  const p1 = solo(E, 'ffa', mkws('acct-3'));
  const p2 = solo(E, 'boss', mkws('acct-3'));
  const bothLive = E.rooms.get(p1.room.code) === p1.room && E.rooms.get(p2.room.code) === p2.room;
  gone(E, p1.ws);
  advance(1000);
  gone(E, p2.ws);
  if (bothLive && !E.rooms.has(p1.room.code) && E.rooms.get(p2.room.code) === p2.room) ok('(4e) of two matches one account left, only the newer is held; a match being played was never ended');
  else fail(`(4e) live together ${bothLive}; older kept ${E.rooms.has(p1.room.code)}, newer kept ${E.rooms.has(p2.room.code)}`);
  // (f) GUESTS are not linked: two guests' held matches both stay.
  const g1 = solo(E, 'duel'); gone(E, g1.ws);
  const g2 = solo(E, 'duel'); gone(E, g2.ws);
  if (E.rooms.has(g1.room.code) && E.rooms.has(g2.room.code)) ok('(4f) two guests\' held matches are both kept');
  else fail('(4f) a guest\'s held match was ended by another guest\'s');
  // (g) A MATCH ITS PLAYER CAME BACK TO is live again, and neither its token
  // nor its account ends it any more.
  const w = solo(E, 'ffa', mkws('acct-4'));
  gone(E, w.ws);
  const wBack = resume(E, w.start);
  const t1 = mkws(); E.handleClientMessage(t1, { type: 'ai', difficulty: 'easy', name: 'X', skin: 'olive', loadout: LOADOUT, held: w.start.token }); leave(E, t1);
  const t2 = mkws('acct-4'); E.handleClientMessage(t2, { type: 'ai', difficulty: 'easy', name: 'X', skin: 'olive', loadout: LOADOUT }); leave(E, t2);
  if (last(wBack, 'restore') && E.rooms.get(w.room.code) === w.room && !w.room.heldSince) ok('(4g) a match its player came back to is not held: neither its token nor its account ends it');
  else fail(`(4g) resumed match kept ${E.rooms.has(w.room.code)}, heldSince ${w.room.heldSince}`);
  leave(E, wBack);
  // (h) THE PLACE IS FREED FIRST: on a server with room for two matches, one
  // held and one being played, the held match's player can still start a new
  // one, because the held match is ended before the capacity check.
  {
    const h = solo(R, 'ffa'); gone(R, h.ws);
    const busy = solo(R, 'duel');
    const n = solo(R, 'duel', mkws(), { held: h.start.token });
    const refused = n.ws._rx.some((f) => f.type === 'joinError');
    if (R.rooms.size === 2 && !R.rooms.has(h.room.code) && n.room && n.room.state === 'playing' && !refused) ok('(4h) at the server\'s capacity a new match carrying the held match\'s token still starts: the held match\'s place is freed first');
    else fail(`(4h) at capacity: refused ${refused}, held kept ${R.rooms.has(h.room.code)}, rooms ${R.rooms.size}`);
    leave(R, busy.ws); if (n.room) leave(R, n.ws);
  }
  // (i) ONLY A ROOM WITH ONE HUMAN IS EVER ENDED THIS WAY, whatever marks it:
  // a room two humans play in, marked held by hand (holdSolo never marks one;
  // this stands in for a later edit that did), is ended by neither player's
  // token nor either player's account.
  {
    const h1 = mkws('acct-5'), h2 = mkws('acct-6');
    E.handleClientMessage(h1, { type: 'create', mode: 'ffa', max: 2, name: 'A', skin: 'olive', loadout: LOADOUT });
    const pair = E.rooms.get(h1.roomCode);
    E.handleClientMessage(h2, { type: 'join', code: pair.code, name: 'B', skin: 'desert', loadout: LOADOUT });
    pair.heldSince = Date.now();
    let threw = null;
    try {
      const t1 = mkws(); E.handleClientMessage(t1, { type: 'ai', difficulty: 'easy', name: 'X', skin: 'olive', loadout: LOADOUT, held: pair.players[0].token }); leave(E, t1);
      const t2 = mkws('acct-6'); E.handleClientMessage(t2, { type: 'ai', difficulty: 'easy', name: 'X', skin: 'olive', loadout: LOADOUT }); leave(E, t2);
    } catch (e) { threw = e; }
    if (!threw && pair.state === 'playing' && E.rooms.get(pair.code) === pair) ok('(4i) a room two humans play in is never ended by a token or an account, even marked as held');
    else fail(`(4i) two-human room kept ${E.rooms.get(pair.code) === pair}, state ${pair.state}, threw ${threw && threw.message}`);
    pair.heldSince = 0;
    leave(E, h1); leave(E, h2);
  }
  // Clean up every held match this section left, through the real resume and leave.
  for (const st of [other.start, u2.start, p2.start, g1.start, g2.start]) leave(E, resume(E, st));
  if (held(E).length === 0) ok('(4) every held match this section made is gone again');
  else fail('(4) held matches left: ' + held(E).length);
}

// ---- 5. The server-wide cap (MAX_HELD_ROOMS = 3 on engine C) -------------------
{
  const s = [];
  for (let i = 0; i < 3; i++) { const m = solo(C, 'duel'); gone(C, m.ws); s.push(m); advance(1000); }
  // The first player comes back and goes again: now the most recent to go.
  gone(C, resume(C, s[0].start));
  advance(1000);
  const s3 = solo(C, 'ffa'); gone(C, s3.ws); advance(1000);
  const has = (m) => C.rooms.get(m.room.code) === m.room;
  if (!has(s[1]) && has(s[0]) && has(s[2]) && has(s3) && held(C).length === 3) ok('(5) at the cap the match held LONGEST goes (not the oldest created), and the cap holds at 3');
  else fail(`(5) after a 4th hold: kept ${[s[0], s[1], s[2], s3].map(has)}, held ${held(C).length}`);
  // A room with another human never counts and is never evicted.
  const h1 = mkws(), h2 = mkws();
  C.handleClientMessage(h1, { type: 'create', mode: 'ffa', max: 2, name: 'A', skin: 'olive', loadout: LOADOUT });
  const pair = C.rooms.get(h1.roomCode);
  C.handleClientMessage(h2, { type: 'join', code: pair.code, name: 'B', skin: 'desert', loadout: LOADOUT });
  gone(C, h1); gone(C, h2);
  const s4 = solo(C, 'golf'); gone(C, s4.ws); advance(1000);
  if (C.rooms.get(pair.code) === pair && !pair.heldSince && !has(s[2]) && has(s[0]) && has(s3) && has(s4) && held(C).length === 3) {
    ok('(5) a room with two humans is not a held match: it never counts toward the cap and is never evicted');
  } else fail(`(5) two-human room kept ${C.rooms.has(pair.code)} heldSince ${pair.heldSince}; held ${held(C).length}`);
  // A MATCH ITS PLAYER CAME BACK TO is being played: it never counts and is
  // never evicted, however long ago it was first held.
  const s0Back = resume(C, s[0].start);
  for (let i = 0; i < 3; i++) { const m = solo(C, 'duel'); gone(C, m.ws); advance(1000); }
  if (C.rooms.get(s[0].room.code) === s[0].room && !s[0].room.heldSince && held(C).length === 3) ok('(5) a match its player came back to never counts toward the cap and is never evicted');
  else fail(`(5) the resumed match kept ${C.rooms.has(s[0].room.code)}, heldSince ${s[0].room.heldSince}, held ${held(C).length}`);
  leave(C, s0Back);
  // MOVING ON from a live match alone never evicts anybody: the old match is
  // ended, and it is never counted as held on the way out.
  const live = solo(C, 'duel');
  const keep = held(C).map((r) => r.code).join();
  C.handleClientMessage(live.ws, { type: 'ai', difficulty: 'easy', name: 'Solo', skin: 'olive', loadout: LOADOUT });
  if (held(C).map((r) => r.code).join() === keep && !C.rooms.has(live.room.code)) ok('(5) starting a new match from a live one ends the old one and evicts nobody at the cap');
  else fail(`(5) moving on evicted: held ${keep} -> ${held(C).map((r) => r.code).join()}, old kept ${C.rooms.has(live.room.code)}`);
  leave(C, live.ws);
}

// ---- 6. A room with another human keeps today's rules -------------------------
{
  // A 2-minute seat, then the forfeit, while the other human plays on.
  const a = mkws(), b = mkws();
  E.handleClientMessage(a, { type: 'create', mode: 'ffa', max: 2, name: 'A', skin: 'olive', loadout: LOADOUT });
  const room = E.rooms.get(a.roomCode);
  E.handleClientMessage(b, { type: 'join', code: room.code, name: 'B', skin: 'desert', loadout: LOADOUT });
  advance(1000);
  gone(E, a);
  advance(120000 - 1);
  const early = count(b, 'forfeit');
  advance(2);
  const f = last(b, 'forfeit');
  if (!room.heldSince && early === 0 && f && f.seat === 0) ok('(6) with another human, a dropped seat is still held 2 minutes, then forfeited');
  else fail(`(6) heldSince ${room.heldSince}, forfeits before 2 min ${early}, after ${JSON.stringify(f)}`);
  leave(E, b);
  // Everyone gone: the half-hour hold, not the day.
  const c = mkws(), d = mkws();
  E.handleClientMessage(c, { type: 'create', mode: 'ffa', max: 2, name: 'C', skin: 'olive', loadout: LOADOUT });
  const r2 = E.rooms.get(c.roomCode);
  E.handleClientMessage(d, { type: 'join', code: r2.code, name: 'D', skin: 'desert', loadout: LOADOUT });
  advance(1000);
  gone(E, c); gone(E, d);
  advance(30 * 60 * 1000 - 1);
  const kept = E.rooms.get(r2.code) === r2;
  advance(2);
  if (!r2.heldSince && kept && !E.rooms.has(r2.code)) ok('(6) with everyone gone, a room two humans played in is reclaimed after half an hour, as before');
  else fail(`(6) heldSince ${r2.heldSince}, kept at 30 min - 1 ms ${kept}, gone after ${!E.rooms.has(r2.code)}`);
}

// ---- 7. Moving on from a live match alone leaves the quick-match queue --------
{
  const { ws, room } = solo(E, 'duel');
  E.handleClientMessage(ws, { type: 'quick', name: 'Solo', skin: 'olive', loadout: LOADOUT });
  const queued = last(ws, 'queued');
  E.handleClientMessage(ws, { type: 'ai', difficulty: 'easy', name: 'Solo', skin: 'olive', loadout: LOADOUT });
  const next = E.rooms.get(ws.roomCode);
  const other = mkws();
  E.handleClientMessage(other, { type: 'quick', name: 'Other', skin: 'desert', loadout: LOADOUT });
  if (queued && !E.rooms.has(room.code) && next && next !== room && E.rooms.get(ws.roomCode) === next && next.state === 'playing' && last(other, 'queued') && !other.roomCode) {
    ok('(7) a player who queued for a quick match and then started a new match alone is out of the queue: the next quick match waits instead of pairing with them');
  } else fail(`(7) old kept ${E.rooms.has(room.code)}, new match kept ${E.rooms.get(ws.roomCode) === next}, other queued ${!!last(other, 'queued')}, other seated in ${other.roomCode}`);
  E.handleClientMessage(other, { type: 'cancelQuick' });
  leave(E, ws);
}

// ---- 8. A resume is news to the OTHER seats only (round 2 fix) ----------------
// handleResume broadcast oppConn {connected:true} to every seat, the resuming
// one included, and the client toasts "<name> reconnected" for any seat: a
// player back at a held match against the computer was told that THEY had
// reconnected. The frame now goes to every seat but the one it is about.
{
  const { ws, room, start } = solo(E, 'ffa');
  gone(E, ws);
  advance(31 * 60 * 1000);                 // past the old half-hour hold
  const back = resume(E, start);
  const self = back._rx.filter((m) => m.type === 'oppConn' && m.seat === start.you);
  if (last(back, 'restore') && self.length === 0) ok('(8) a player back at a held match against the computer is not told that they reconnected');
  else fail(`(8) the resuming seat was sent ${JSON.stringify(self)} (restore ${!!last(back, 'restore')})`);
  leave(E, back);
  // Two humans: the other seat is still told; the seat that came back is not.
  const a = mkws(), b = mkws();
  E.handleClientMessage(a, { type: 'create', mode: 'ffa', max: 2, name: 'A', skin: 'olive', loadout: LOADOUT });
  const pair = E.rooms.get(a.roomCode);
  E.handleClientMessage(b, { type: 'join', code: pair.code, name: 'B', skin: 'desert', loadout: LOADOUT });
  advance(1000);
  const aStart = last(a, 'start');
  gone(E, a);
  advance(5000);
  b._rx.length = 0;
  const aBack = resume(E, aStart);
  const toB = b._rx.filter((m) => m.type === 'oppConn');
  const toA = aBack._rx.filter((m) => m.type === 'oppConn' && m.seat === aStart.you);
  if (last(aBack, 'restore') && toB.length === 1 && toB[0].seat === aStart.you && toB[0].connected === true && toA.length === 0)
    ok('(8) with another human, that human is told the seat reconnected, and the seat that came back is not');
  else fail(`(8) two humans: to B ${JSON.stringify(toB)}, to A ${JSON.stringify(toA)}`);
  leave(E, aBack); leave(E, b);
}

// ---- 9. A raid finished alone is held like a match alone (round 2 fix) --------
// The hold used to count SEATS: a partner who left, or dropped and was
// forfeited, kept a human seat at hp 0, so the player still raiding got the
// two-minute multiplayer forfeit instead of the day, and the raid was over
// before they came back. The hold now counts humans still IN the match: when
// nobody is connected and exactly one human seat is still in it, the match is
// held for that player. Two live humans keep today's rules (section 6).
const M = 60 * 1000;
function raid(eng, mode, a = mkws(), b = mkws()) {
  eng.handleClientMessage(a, { type: 'create', mode, name: 'A', skin: 'olive', loadout: LOADOUT });
  const room = eng.rooms.get(a.roomCode);
  eng.handleClientMessage(b, { type: 'join', code: room.code, name: 'B', skin: 'desert', loadout: LOADOUT });
  advance(500);
  eng.handleClientMessage(a, { type: 'startMatch' });
  for (let i = 0; i < 120 && !(room.state === 'playing' && !room.picking); i++) advance(1000);
  return { a, b, room, aStart: last(a, 'start'), bStart: last(b, 'start') };
}
for (const mode of ['boss', 'aliens']) for (const how of ['leave', 'drop']) {
  const { a, b, room, bStart } = raid(E, mode);
  if (how === 'leave') leave(E, a); else gone(E, a);
  advance(3 * M);
  const aOut = room.hp[0] <= 0;
  gone(E, b);
  const hpB = room.hp[bStart.you];
  advance(23 * H);
  const kept = E.rooms.get(room.code) === room && room.state === 'playing' && !!room.heldSince && room.hp[bStart.you] === hpB;
  const back = resume(E, bStart);
  if (aOut && kept && last(back, 'restore') && last(back, 'restore').you === bStart.you)
    ok(`(9 ${mode}, partner ${how === 'leave' ? 'left' : 'dropped'}) the partner is forfeited, the player raiding on alone goes away, and the raid is held 23 hours untouched and resumes`);
  else fail(`(9 ${mode} ${how}) partner out ${aOut}, kept ${kept} (state ${room.state}, held ${!!room.heldSince}, hp ${hpB} -> ${room.hp[bStart.you]}), resume ${JSON.stringify(back._rx.map((m) => m.type))}`);
  leave(E, back);
}
{
  // BOTH GONE, THE PARTNER FIRST: the player who stayed is held the moment the
  // partner's forfeit lands, not forfeited two minutes after their own drop.
  const { a, b, room, bStart } = raid(E, 'boss');
  gone(E, a);
  advance(30 * 1000);
  gone(E, b);
  advance(3 * H);
  const kept = E.rooms.get(room.code) === room && room.state === 'playing' && room.hp[0] <= 0 && room.hp[bStart.you] > 0 && !!room.heldSince;
  const back = resume(E, bStart);
  if (kept && last(back, 'restore')) ok('(9) both raiders gone, the partner first: once the partner is forfeited the one still in the raid is held, and resumes three hours later');
  else fail(`(9) both gone: state ${room.state}, hp ${JSON.stringify(room.hp)}, held ${!!room.heldSince}, resume ${JSON.stringify(back._rx.map((m) => m.type))}`);
  leave(E, back);
}
{
  // THE PARTNER COMES BACK IN TIME: they are waiting on the player who went,
  // so that player keeps the multiplayer rule, a two-minute seat and then the
  // forfeit, and nothing is held.
  const { a, b, room, aStart, bStart } = raid(E, 'boss');
  gone(E, a);
  advance(30 * 1000);
  gone(E, b);
  advance(30 * 1000);
  const aBack = resume(E, aStart);
  advance(2 * M);
  const f = aBack._rx.filter((m) => m.type === 'forfeit').map((m) => m.seat);
  if (last(aBack, 'restore') && f.includes(bStart.you) && room.hp[bStart.you] <= 0 && !room.heldSince)
    ok('(9) a partner who comes back inside the grace is waiting on the player who went: that player is forfeited after two minutes, and nothing is held');
  else fail(`(9) partner back: forfeits ${JSON.stringify(f)}, hp ${JSON.stringify(room.hp)}, held ${!!room.heldSince}`);
  leave(E, aBack);
}
{
  // THE TWO BOUNDS SEE THE RAID'S PLAYER. A new match carrying the held
  // raid's token ends it (releaseHeld), and moving on from a live raid whose
  // partner has gone ends it without evicting anybody's held match at the cap.
  const r1 = raid(E, 'aliens');
  leave(E, r1.a); advance(3 * M); gone(E, r1.b);
  const wasHeld = !!r1.room.heldSince;
  const t1 = mkws();
  E.handleClientMessage(t1, { type: 'ai', difficulty: 'easy', name: 'X', skin: 'olive', loadout: LOADOUT, held: r1.bStart.token });
  if (wasHeld && !E.rooms.has(r1.room.code)) ok('(9) a new match carrying a held raid\'s token ends that raid, as for any held match');
  else fail(`(9) release by token: held ${wasHeld}, still there ${E.rooms.has(r1.room.code)}`);
  leave(E, t1);
  const s = [];
  for (let i = 0; i < 3; i++) { const m = solo(C, 'duel'); gone(C, m.ws); s.push(m); advance(1000); }
  const keep = held(C).map((r) => r.code).sort().join();
  const r2 = raid(C, 'boss');
  leave(C, r2.a); advance(3 * M);
  C.handleClientMessage(r2.b, { type: 'ai', difficulty: 'easy', name: 'B', skin: 'olive', loadout: LOADOUT });
  if (held(C).map((r) => r.code).sort().join() === keep && !C.rooms.has(r2.room.code)) ok('(9) moving on from a live raid whose partner has gone ends it and evicts nobody\'s held match at the cap');
  else fail(`(9) moving on from a raid: held ${keep} -> ${held(C).map((r) => r.code).sort().join()}, raid kept ${C.rooms.has(r2.room.code)}`);
  leave(C, r2.b);
  for (const m of s) leave(C, resume(C, m.start));
}

// ---- 9b. A partner who came back to watch cannot end the held raid (round 2 fix)
// A raid held for the player still raiding loses its hold when the forfeited
// partner's client resumes them into it (app.js does that on launch). If the
// partner then tapped Leave, or started any new match, the raid was torn
// down, because nobody else was connected, and the player it was held for
// came back to "That match ended while you were away". Only a closed socket
// put the hold back. Every way out now does: Leave, a vs-Computer start, a
// new lobby and a join of another lobby each hold the raid again for its
// player, who resumes it hours later. The closed socket is the control.
{
  const exits = {
    close: (w) => gone(E, w),
    leave: (w) => leave(E, w),
    ai: (w) => E.handleClientMessage(w, { type: 'ai', difficulty: 'easy', name: 'A', skin: 'olive', loadout: LOADOUT }),
    create: (w) => E.handleClientMessage(w, { type: 'create', mode: 'duel', name: 'A', skin: 'olive', loadout: LOADOUT }),
    join: (w, code) => E.handleClientMessage(w, { type: 'join', code, name: 'A', skin: 'olive', loadout: LOADOUT }),
  };
  for (const [how, exit] of Object.entries(exits)) {
    const { a, b, room, aStart, bStart } = raid(E, 'boss');
    gone(E, a);                          // A closes the app
    advance(3 * M);                      // and is forfeited
    gone(E, b);                          // B, raiding on alone, goes too: held
    const heldB = !!room.heldSince;
    advance(1 * H);
    const aBack = resume(E, aStart);     // A's client resumes them on launch
    const unheld = !!last(aBack, 'restore') && !room.heldSince;
    advance(10 * 1000);
    // A lobby somebody else is hosting, for the join.
    const host = mkws();
    if (how === 'join') E.handleClientMessage(host, { type: 'create', mode: 'duel', name: 'H', skin: 'desert', loadout: LOADOUT });
    exit(aBack, host.roomCode);
    const reheld = E.rooms.get(room.code) === room && room.state === 'playing' && !!room.heldSince;
    advance(5 * H);
    const bBack = resume(E, bStart);
    if (heldB && unheld && reheld && last(bBack, 'restore') && last(bBack, 'restore').you === bStart.you && !last(bBack, 'resumeError'))
      ok(`(9b ${how}) the forfeited partner back to watch ${how === 'close' ? 'closes the app' : how === 'leave' ? 'taps Leave' : 'starts a new match (' + how + ')'}: the raid is held again for the player still in it, who resumes it five hours later`);
    else fail(`(9b ${how}) held ${heldB}, unheld by the resume ${unheld}, held again ${reheld} (room ${E.rooms.get(room.code) === room}, state ${room.state}), B's resume ${JSON.stringify(bBack._rx.map((m) => m.type))}`);
    if (E.rooms.has(room.code)) leave(E, bBack);
    if (aBack.roomCode && E.rooms.has(aBack.roomCode)) leave(E, aBack);
    if (host.roomCode && E.rooms.has(host.roomCode)) leave(E, host);
  }
}

// ---- 5b. The default cap: 100 at the default MAX_ROOMS of 250 ------------------
{
  const s = [];
  for (let i = 0; i < 101; i++) { const m = solo(E, 'duel'); gone(E, m.ws); s.push(m); advance(1000); }
  const has = (m) => E.rooms.get(m.room.code) === m.room;
  if (held(E).length === 100 && !has(s[0]) && s.slice(1).every(has)) ok('(5) at the defaults the cap is 100 held matches: the 101st player to go ends the match held longest');
  else fail(`(5) at the defaults ${held(E).length} held, the first kept ${has(s[0])}`);
  for (const m of s.slice(1)) leave(E, resume(E, m.start));
}

if (faults.length) fail(`${faults.length} timer fault(s): ${faults.map((e) => e && e.message).join('; ')}`);
if (E.rooms.size === 0 && R.rooms.size === 0 && C.rooms.size <= 4) ok('no stray rooms beyond the cap section\'s own');
else fail(`rooms left: ${E.rooms.size} in the main engine, ${R.rooms.size} in the two-room one`);
console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
