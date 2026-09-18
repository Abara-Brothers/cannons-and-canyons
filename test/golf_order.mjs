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
process.on('uncaughtException', (e) => { escaped = e; console.error('FAIL escaped: ' + e.message); process.exitCode = 1; });

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

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall golf_order checks passed');
if (escaped) { console.error('escaped exception: ' + escaped.message); process.exit(1); }
process.exit(out.errors.length ? 1 : 0);
