// Artillery Golf smoke test: a solo round of hole 1.
// Asserts golf snapshots (single weapon, cup, par), that strokes count, that the
// TANK walks to where the ball rests, that driving is refused, and that
// finishing hole 1 advances to hole 2.
import WebSocket from 'ws';

const URL = process.env.WS || 'ws://localhost:3000/ws';
const out = { steps: [], errors: [] };
const step = (m) => out.steps.push(m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const finish = () => { console.log(JSON.stringify(out, null, 2)); process.exit(out.errors.length ? 1 : 0); };
setTimeout(() => { fail('timeout'); finish(); }, 130000);   // roll-out holds the turn now (longer since the 8.17 roll retune)

const ws = new WebSocket(URL);
const send = (m) => ws.send(JSON.stringify(m));

let cup = null, par = 0, myX = 0, shots = 0, lastStrokes = 0, movedOnce = false, wrapped = false;

ws.on('open', () => send({ type: 'create', name: 'Golfer', skin: 'olive', mode: 'golf', max: 2 }));
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'created') {
    if (m.mode !== 'golf') fail(`created.mode is '${m.mode}'`);
    step('golf room created ' + m.code);
  }
  if (m.type === 'lobby') send({ type: 'startMatch' });   // solo tee-off
  if (m.type === 'start') {
    if (!m.golf) return fail('start snapshot has no golf payload'), finish();
    if (m.golf.hole !== 1) fail(`expected hole 1, got ${m.golf.hole}`);
    const ids = (m.weapons || []).map(w => w.id);
    // Bag order since 8.22: Driver, Iron (golfball), Putter.
    if (ids.join() !== 'driver,golfball,putter') {
      fail(`golf weapons should be [driver, golfball, putter], got ${JSON.stringify(ids)}`);
    }
    cup = m.golf.cup; par = m.golf.par;
    myX = m.tanks[m.you].x;
    step(`hole 1: par ${par}, tee at ${Math.round(myX)}, cup at ${Math.round(cup.x)} (biome ${m.biome})`);
    // Driving must be refused in golf.
    send({ type: 'move', dir: 1 });
    setTimeout(swing, 400);
  }
  if (m.type === 'move') fail('server allowed driving in golf mode');
  if (m.type === 'shot') {
    const g = m.golf;
    if (!g) return fail('golf shot payload missing golf block');
    if (g.strokes[0] !== lastStrokes + 1 && g.note !== 'hazard' && g.note !== 'oob' && g.note !== 'water') {
      fail(`strokes went ${lastStrokes} -> ${g.strokes[0]} without a penalty note`);
    }
    lastStrokes = g.strokes[0];
    const nx = m.tanks[0].x;
    if (Math.abs(nx - myX) > 1) movedOnce = true;
    myX = nx;
    step(`stroke ${g.strokes[0]}${g.note ? ' (' + g.note + ')' : ''} — ball/tank at ${Math.round(nx)}`);
    if (!g.done[0]) setTimeout(swing, 350);
    else step(g.note === 'holed' ? 'SUNK IT' : 'picked up at the cap');
  }
  if (m.type === 'hole') {
    if (!m.golf || m.golf.hole !== 2) fail(`expected hole 2 payload, got ${m.golf && m.golf.hole}`);
    step('advanced to hole 2 — course flow works');
    if (!movedOnce) fail('the tank never walked to its ball');
    if (!wrapped) { wrapped = true; step('ALL GOOD'); finish(); }
  }
  if (m.type === 'gameover') { fail('gameover before hole 2 in a 9-hole round'); finish(); }
});

function swing() {
  // Aim at the cup with a crude range guess; the cap (par+4) bounds the hole.
  // The ball ROLLS a long way now — aim deliberately short and let the
  // roll-out do the work; the point here is course FLOW, not sinking it.
  // Real physics also means a wall in front of the tee can roll the ball
  // straight back to your feet — so play like a golfer and LOFT progressively
  // higher on each stroke that goes nowhere.
  const dist = Math.max(400, cup.x - myX);
  const power = Math.max(18, Math.min(68, Math.sqrt(dist * 620) / (58 * 0.9)));
  shots++;
  const angle = Math.min(78, 44 + shots * 5);   // 49, 54, 59... clears tee-side walls
  send({ type: 'fire', weapon: 'golfball', angle, power });
}
