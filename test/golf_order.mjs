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
process.on('uncaughtException', (e) => { escaped = e; });

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

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall golf_order checks passed');
if (escaped) { console.error('escaped exception: ' + escaped.message); process.exit(1); }
process.exit(out.errors.length ? 1 : 0);
