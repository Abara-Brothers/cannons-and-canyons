// Artillery Golf for four, in-process: the seat cap, the honour rule
// (farthest ball plays next), forfeits inside a four-player round, the
// winner rule, and real strokes through the engine. No server, no browser.
//
// WHY THIS EXISTS: with two players a forfeit ends the round, so the engine
// never had to hand a turn past a scuttled seat, keep it scuttled on the next
// tee, or keep it out of the winner's tally. Four players make every one of
// those reachable, and each fails silently as a stall or a wrong winner.
process.env.GOLF_HOLD_MS = '30';        // a fixed hold instead of the replay length
process.env.RESUME_GRACE_MS = '60';     // forfeit quickly
process.env.PICK_MS = '200';
process.env.BOT_FIRE_MS = '40';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engine = await import('../public/room-engine.js');
const { rooms, handleClientMessage, handleClose, golfNextSeat, golfWinner } = engine;
let escaped = null;
process.on('uncaughtException', (e) => { escaped = e; fail('escaped: ' + e.message); process.exitCode = 1; });

const mkws = () => ({ readyState: 1, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });
const FIVE = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
const frames = (ws, t) => ws._rx.filter((m) => m.type === t);
const roomOf = (ws) => rooms.get(ws.roomCode);
async function until(pred, ms, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(step); }
  return pred();
}
const golfCreate = (ws, max) => handleClientMessage(ws, { type: 'create', name: 'Host', skin: 'olive', mode: 'golf', tees: 'mens', loadout: FIVE, ...(max === undefined ? {} : { max }) });
const leave = (ws) => { try { handleClientMessage(ws, { type: 'leave' }); } catch (e) { fail('leave threw: ' + e.message); } };

// ---- (a) the seat cap: golf opens 1..4 seats, two by default ---------------
{
  const CASES = [
    [4, 4], [9, 4], [0, 2], [undefined, 2], [1, 1], [3, 3],
    [-2, 1], // below the floor clamps, as ffa does
  ];
  for (const [given, want] of CASES) {
    const ws = mkws(); golfCreate(ws, given);
    const r = roomOf(ws);
    if (r && r.mode === 'golf' && r.max === want) ok(`(a) golf create max=${given} -> room.max ${want}`);
    else fail(`(a) golf create max=${given}: room=${r && r.mode} max=${r && r.max}`);
    leave(ws);
  }
  const ws = mkws(); handleClientMessage(ws, { type: 'create', name: 'H', skin: 'olive', mode: 'duel', max: 4, loadout: FIVE });
  const r = roomOf(ws);
  if (r && r.max === 2) ok('(a) a duel still seats exactly two whatever max says'); else fail('(a) duel max=' + (r && r.max));
  leave(ws);
}

// ---- (a) a one-seat golf room tees off at once ------------------------------
// Nobody can ever join a 1-seat room, so a lobby there is a dead end: the
// create handler starts the round itself, exactly as the offline Play solo
// path does. Two seats must still wait.
{
  const solo = mkws(); golfCreate(solo, 1);
  const r1 = roomOf(solo);
  if (r1 && r1.state === 'playing' && r1.players.length === 1 && frames(solo, 'start').length === 1) ok('(a) a one-seat golf room is playing on create: one seat, exactly one start frame');
  else fail(`(a) one-seat golf: state=${r1 && r1.state} players=${r1 && r1.players.length} starts=${frames(solo, 'start').length}`);
  leave(solo);
  const pair = mkws(); golfCreate(pair, 2);
  const r2 = roomOf(pair);
  if (r2 && r2.state === 'waiting' && frames(pair, 'start').length === 0) ok('(a) a two-seat golf room still waits in the lobby: no start frame');
  else fail(`(a) two-seat golf: state=${r2 && r2.state} starts=${frames(pair, 'start').length}`);
  leave(pair);
}

// ---- (b) golfNextSeat, the rule on its own ---------------------------------
// A fake room is enough: the rule reads players.length, golf.cup.x, golf.done
// and tanks[i].x / alive. Distances are to the cup at x=10000.
const fake = (xs, done, alive) => ({
  players: xs.map(() => ({})),
  golf: { cup: { x: 10000 }, done: done || xs.map(() => false) },
  tanks: xs.map((x, i) => ({ x, y: 0, alive: alive ? alive[i] : true })),
});
{
  const r = fake([1000, 4000, 9000, 4000]);           // distances 9000, 6000, 1000, 6000
  if (golfNextSeat(r, 2) === 0) ok('(b) farthest ball plays next (seat 0 at 9000 away)'); else fail('(b) farthest: got ' + golfNextSeat(r, 2));
  if (golfNextSeat(r, 0) === 0) ok('(b) the seat that just played plays again while it is still the farthest'); else fail('(b) same seat: got ' + golfNextSeat(r, 0));
  const tie = fake([9000, 4000, 9000, 4000], [true, false, true, false]);   // seats 1 and 3 tie at 6000; 0 and 2 holed
  if (golfNextSeat(tie, 1) === 3) ok('(b) a tie goes to seat order starting after the seat that played (after 1: 2 holed, 3)'); else fail('(b) tie after 1: got ' + golfNextSeat(tie, 1));
  if (golfNextSeat(tie, 3) === 1) ok('(b) …and after seat 3 the tie goes to seat 1'); else fail('(b) tie after 3: got ' + golfNextSeat(tie, 3));
  const dead = fake([1000, 4000, 9000, 4000], null, [false, true, true, true]);
  if (golfNextSeat(dead, 2) === 3) ok('(b) a scuttled seat is never a candidate (seat 0 dead at 9000 -> seat 3, the first at 6000 after seat 2)'); else fail('(b) dead skip: got ' + golfNextSeat(dead, 2));
  if (golfNextSeat(dead, 0) === 1) ok('(b) a scuttled seat as `by` still hands on by the rule (after 0: seat 1 at 6000)'); else fail('(b) dead by: got ' + golfNextSeat(dead, 0));
  const all = fake([1000, 4000], [true, true]);
  if (golfNextSeat(all, 0) === -1) ok('(b) nobody in play -> -1'); else fail('(b) all done: got ' + golfNextSeat(all, 0));
  const solo = fake([3000]);
  if (golfNextSeat(solo, 0) === 0) ok('(f) solo: the one seat plays on'); else fail('(f) solo: got ' + golfNextSeat(solo, 0));
  const soloDone = fake([3000], [true]);
  if (golfNextSeat(soloDone, 0) === -1) ok('(f) solo holed out -> -1 (next hole)'); else fail('(f) solo done: got ' + golfNextSeat(soloDone, 0));
  const equal = fake([2000, 2000, 2000, 2000]);       // everyone on the tee
  if (golfNextSeat(equal, 3) === 0 && golfNextSeat(equal, 0) === 1) ok('(b) all equal (the tee): seat order from the seat after `by`'); else fail('(b) equal: ' + golfNextSeat(equal, 3) + ',' + golfNextSeat(equal, 0));
  const over = fake([9000, 12000, 4000]);                 // seat 1 is 2000 past the cup; seat 2 is 6000 short
  if (golfNextSeat(over, 0) === 2) ok('(b) distance is unsigned: a ball 2000 past the cup is nearer than one 6000 short'); else fail('(b) overshoot: got ' + golfNextSeat(over, 0));
  const overFar = fake([9000, 17000, 4000]);              // seat 1 is 7000 past the cup: the farthest
  if (golfNextSeat(overFar, 0) === 1) ok('(b) a ball far past the cup is still the farthest'); else fail('(b) overshoot far: got ' + golfNextSeat(overFar, 0));
  const short = fake([1000, 4000, 9000]); short.tanks.length = 2;   // seat 2 has no tank yet
  if (golfNextSeat(short, 1) === 0) ok('(b) a seat without a tank is not a candidate'); else fail('(b) short tanks: got ' + golfNextSeat(short, 1));
}

// ---- (e) golfWinner: a forfeited seat cannot win on a short card ---------
{
  const r = fake([0, 0, 0, 0], null, [false, true, true, true]);
  if (golfWinner(r, [3, 40, 38, 41]) === 2) ok('(e) the lowest total among seats still on the course wins (seat 0 left early with 3)'); else fail('(e) winner: ' + golfWinner(r, [3, 40, 38, 41]));
  if (golfWinner(r, [3, 38, 38, 41]) === -1) ok('(e) a tie for lowest among live seats is a draw'); else fail('(e) tie: ' + golfWinner(r, [3, 38, 38, 41]));
  const r2 = fake([0, 0, 0, 0], null, [false, false, false, true]);
  if (golfWinner(r2, [1, 1, 1, 99]) === 3) ok('(e) the last one standing wins whatever the card says'); else fail('(e) last standing: ' + golfWinner(r2, [1, 1, 1, 99]));
  if (golfWinner(fake([0]), [37]) === 0) ok('(e) solo: the one seat wins its own round'); else fail('(e) solo winner');
  const all = fake([0, 0], null, [true, true]);
  if (golfWinner(all, [30, 31]) === 0 && golfWinner(all, [31, 30]) === 1) ok('(e) two live seats: lowest wins as before'); else fail('(e) pair');
}

// ---- (d) a forfeit mid-round: skipped, kept out on the next tee, cannot win
{
  const { surfaceAt } = await import('../public/game-core.js');
  const hs = [mkws(), mkws(), mkws(), mkws()];
  golfCreate(hs[0], 4);
  const code = roomOf(hs[0]).code;
  for (let i = 1; i < 4; i++) handleClientMessage(hs[i], { type: 'join', code, name: 'P' + i, skin: 'olive', loadout: FIVE });
  handleClientMessage(hs[0], { type: 'startMatch' });
  const room = roomOf(hs[0]);
  if (room && room.state === 'playing' && room.players.length === 4 && hs.every((w) => frames(w, 'start').length === 1)) ok('(d) four golfers on the tee');
  else { fail('(d) round did not start: state=' + (room && room.state)); }
  // Drop the seat that holds the turn (pinned to seat 1 just below), so the
  // mid-turn hand-off runs on every run. First place the balls so the
  // generic ring (the next seat after the dropped one) and the honour rule
  // (the farthest ball) disagree: the seat two after the dropped one stays on
  // the tee, farthest; the ring's next seat is 0.4 of the way, the rest 0.6.
  // A forfeit routed through the generic ring fails the hand-off check.
  // Hand the opening turn to seat 1, the seat hole 2 wants to open, so the
  // scuttle is also proven to skip the wanted opener on every run (hole 1's
  // opener is random; beginTurn has already run, and nothing else reads it).
  room.turn = 1;
  const n = 4, dead = room.turn, ringNext = (dead + 1) % n, far = (dead + 2) % n;
  const live = hs[ringNext];                            // a socket that stays connected
  const tee = room.golf.tee, span = room.golf.cup.x - tee;
  room.tanks.forEach((t, i) => {
    t.x = i === far ? tee : Math.round(tee + span * (i === ringNext ? 0.4 : 0.6));
    t.y = surfaceAt(room.terrain, t.x);
  });
  handleClose(hs[dead]);
  const forfeited = await until(() => frames(live, 'forfeit').some((m) => m.seat === dead), 2000);
  if (forfeited && room.tanks[dead].alive === false) ok(`(d) after the grace the dropped seat ${dead} is scuttled`); else fail(`(d) no forfeit for seat ${dead}`);
  if (room.state === 'playing' && room.turn === far) ok(`(d) the mid-turn forfeit handed the turn by the rule: to the farthest ball (seat ${far}), not the ring's next seat (${ringNext})`);
  else fail(`(d) mid-turn forfeit handed the turn to ${room.turn}; the rule says ${far}, the ring would say ${ringNext}; state=${room.state}`);
  // Play the hole out: whoever is on turn putts; the dropped seat must never come up.
  let strokes = 0, sawDead = false, holeTwo = false;
  const holesBefore = frames(live, 'hole').length;
  while (strokes < 60 && !holeTwo && room.state === 'playing') {
    const t = room.turn;
    if (t === dead) { sawDead = true; break; }
    const before = frames(live, 'turn').length + frames(live, 'hole').length;
    handleClientMessage(hs[t], { type: 'fire', weapon: 'putter', angle: 30, power: 35 });
    strokes++;
    await until(() => frames(live, 'turn').length + frames(live, 'hole').length > before || room.state !== 'playing', 3000);
    if (frames(live, 'hole').length > holesBefore) holeTwo = true;
  }
  if (!sawDead && holeTwo) ok(`(d) the scuttled seat never received a turn and hole 1 completed in ${strokes} strokes`); else fail(`(d) sawDead=${sawDead} holeTwo=${holeTwo} strokes=${strokes} state=${room.state}`);
  if (room.tanks[dead].alive === false) ok('(d) on the next tee the scuttled seat is still out'); else fail(`(d) the next hole resurrected seat ${dead}`);
  // Hole h wants seat (h-1)%n to open; the rule from the seat before it gives
  // that seat, or the next in ring order when the wanted seat is out.
  const opener = golfNextSeat(room, (room.golf.hole - 2 + n) % n);
  if (room.turn !== dead && room.turn === opener) ok(`(d) hole 2 opened on seat ${room.turn}, the wanted seat or the next in ring order past the scuttled one`);
  else fail(`(d) hole 2 opened on seat ${room.turn}; the rule from the seat before the wanted one says ${opener}; dead=${dead}`);
  for (let i = 0; i < n; i++) if (i !== dead) leave(hs[i]);
}

// ---- (c) a real hole with four golfers: every hand-off obeys the rule ------
// The expected seat is computed from the room's state at the moment the
// server hands the turn over (nothing moves between a stroke settling and the
// next `turn`), so the assertion is the rule itself, not fixed numbers.
// (c)/(g)/(h) pin the WIRING — that the engine really hands every turn over
// through this rule at 4, 2 and 3 seats — while (b) above pins the rule itself.
async function playHole(n, label) {
  const hs = Array.from({ length: n }, mkws);
  golfCreate(hs[0], n);
  const code = roomOf(hs[0]).code;
  for (let i = 1; i < n; i++) handleClientMessage(hs[i], { type: 'join', code, name: 'P' + i, skin: 'olive', loadout: FIVE });
  handleClientMessage(hs[0], { type: 'startMatch' });
  const room = roomOf(hs[0]);
  if (!(room && room.state === 'playing' && room.players.length === n)) { fail(`${label}: no ${n}-player round`); return; }
  const first = frames(hs[0], 'start')[0];
  if (first && first.golf && first.golf.hole === 1) ok(`${label}: ${n} golfers started hole 1 (turn ${room.turn})`); else fail(`${label}: no start frame for hole 1`);
  let strokes = 0, handoffs = 0, bad = 0, holeTwo = false, nonRing = 0;
  while (strokes < 80 && !holeTwo && room.state === 'playing') {
    const by = room.turn;
    const seenTurns = frames(hs[0], 'turn').length, seenHoles = frames(hs[0], 'hole').length;
    handleClientMessage(hs[by], { type: 'fire', weapon: strokes % 3 === 0 ? 'driver' : 'putter', angle: 28 + (strokes % 5) * 6, power: 30 + (strokes % 4) * 15 });
    strokes++;
    const moved = await until(() => frames(hs[0], 'turn').length > seenTurns || frames(hs[0], 'hole').length > seenHoles || room.state !== 'playing', 3000);
    if (!moved) { fail(`${label}: no hand-off after stroke ${strokes} by seat ${by}`); break; }
    if (frames(hs[0], 'hole').length > seenHoles) { holeTwo = true; break; }
    const want = golfNextSeat(room, by);
    handoffs++;
    if (room.turn !== want) { bad++; if (bad <= 3) fail(`${label}: after seat ${by}'s stroke the turn went to ${room.turn}, the rule says ${want} (dist ${room.players.map((_, i) => Math.round(Math.abs(room.golf.cup.x - room.tanks[i].x))).join('/')}, done ${room.golf.done.map(Number).join('')})`); }
    if (want !== (by + 1) % n) nonRing++;
  }
  if (!bad && handoffs > 0) ok(`${label}: ${handoffs} hand-offs, every one to the farthest ball in play (${nonRing} of them not the next seat in the ring)`);
  if (holeTwo) ok(`${label}: hole 1 completed in ${strokes} strokes and hole 2 opened on seat ${room.turn}`); else fail(`${label}: hole 1 did not complete within ${strokes} strokes (state ${room.state})`);
  if (holeTwo) {                                     // hole h wants seat (h-1)%n; the rule from the seat before it
    const opener = golfNextSeat(room, (room.golf.hole - 2 + n) % n);
    if (room.turn === opener) ok(`${label}: hole 2 opened on the wanted seat by the rule (seat ${room.turn})`); else fail(`${label}: hole 2 opened on seat ${room.turn}, the rule says ${opener}`);
  }
  for (const w of hs) leave(w);
}
await playHole(4, '(c) four golfers');
await playHole(2, '(g) two golfers');
await playHole(3, '(h) three golfers');

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall golf_order checks passed');
if (escaped) { console.error('escaped exception: ' + escaped.message); process.exit(1); }
process.exit(out.errors.length ? 1 : 0);
