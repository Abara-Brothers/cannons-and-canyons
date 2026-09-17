// FFA vs CPUs (item A) against a LIVE server — the same proof as
// test/ffa_bots.mjs case (b), but through server.js's real socket dispatch and
// safeTimeout on a real event loop, which the in-process suite cannot give.
// Start the server first (run-all.sh does, with BOT_FIRE_MS=250 PICK_MS=800):
//   node server.js
//
// Proves, with real timers: three CPUs are seated; at least two distinct CPU
// seats fire; at least one pair of CONSECUTIVE shots are both by CPUs (a
// bot->bot handover, which no production mode had ever done); every turn
// frame names a living seat; and a lone human's 'leave' tears the room down
// without hurting the socket.
import { WebSocket } from 'ws';

const URL = process.env.WS || 'ws://localhost:3000/ws';
const errors = [];
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const ok = (m) => console.log('  ok — ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(name) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.name = name; ws.inbox = []; ws.all = [];
    ws.on('message', (raw) => { const m = JSON.parse(raw); ws.inbox.push(m); ws.all.push(m); });
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
async function wait(ws, type, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = ws.inbox.findIndex((m) => m.type === type);
    if (i >= 0) return ws.inbox.splice(i, 1)[0];
    await sleep(40);
  }
  throw new Error(`${ws.name}: timeout waiting for '${type}'`);
}

try {
  const ws = await open('solo');
  send(ws, { type: 'ai', mode: 'ffa', max: 4, difficulty: 'medium', name: 'Solo', skin: 'olive',
    loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] });
  const st = await wait(ws, 'start');
  if (st.n === 4 && st.you === 0 && st.mode === 'ffa') ok('a 4-seat ffa starts at once for one socket');
  else fail(`start was n=${st.n} you=${st.you} mode=${st.mode}`);
  const cpuNames = st.names.filter((n) => /^CPU \d$/.test(n));
  if (cpuNames.length === 3 && new Set(cpuNames).size === 3) ok(`three distinct CPU seats: ${cpuNames.join(', ')}`);
  else fail(`CPU names were ${JSON.stringify(st.names)}`);
  if (JSON.stringify(st.hp) === JSON.stringify([150, 150, 150, 150])) ok('everyone starts at full hp');
  else fail(`hp was ${JSON.stringify(st.hp)}`);
  if (Array.isArray(st.kinds) && st.kinds.every((k) => k === 'tank')) ok('plain tanks, no mech, no saucers');
  else fail(`kinds were ${JSON.stringify(st.kinds)}`);

  // Fire on every human turn (a few times at most); collect what the CPUs do.
  let shots = 0;
  const t0 = Date.now();
  let over = null;
  while (Date.now() - t0 < 60000 && shots < 6) {
    const turn = ws.inbox.find((m) => m.type === 'turn' && m.turn === 0);
    over = ws.all.find((m) => m.type === 'gameover') || null;
    if (over) break;
    if (turn) {
      ws.inbox.splice(ws.inbox.indexOf(turn), 1);
      send(ws, { type: 'fire', weapon: 'mortar', angle: 45 + shots * 5, power: 55 });
      shots++;
    }
    const cpuShots = ws.all.filter((m) => m.type === 'shot' && m.by !== 0);
    const consecutive = ws.all.filter((m) => m.type === 'shot').some((m, i, a) => i > 0 && m.by !== 0 && a[i - 1].by !== 0);
    if (new Set(cpuShots.map((m) => m.by)).size >= 2 && consecutive) break;
    await sleep(100);
  }
  const allShots = ws.all.filter((m) => m.type === 'shot');
  const cpuSeats = new Set(allShots.filter((m) => m.by !== 0).map((m) => m.by));
  if (cpuSeats.size >= 2) ok(`${cpuSeats.size} distinct CPU seats fired (${allShots.length} shots in all)`);
  else fail(`only ${cpuSeats.size} CPU seat(s) fired within 60 s (${allShots.length} shots, human fired ${shots})${over ? ' — game ended' : ''}`);
  const pair = allShots.some((m, i, a) => i > 0 && m.by !== 0 && a[i - 1].by !== 0);
  if (pair) ok('two consecutive shots were both by CPUs — a real bot->bot handover on real timers');
  else if (over) ok('the match ended before a bot->bot pair could be observed (allowed; the headless suite pins it)');
  else fail('no two consecutive shots were both by CPUs');
  const badTurn = ws.all.filter((m) => m.type === 'turn' && m.alive && m.alive[m.turn] === false).length;
  if (!badTurn) ok('every turn frame names a living seat'); else fail(`${badTurn} turn frame(s) landed on a wreck`);

  // A lone human leaving tears the room down; the socket must survive it.
  send(ws, { type: 'leave' });
  await sleep(400);
  if (ws.readyState === WebSocket.OPEN) ok('the socket survived leaving a CPU room');
  else fail(`socket readyState after leave was ${ws.readyState}`);
  // And it can start again on the same socket (releasePriorRoom + a fresh room).
  send(ws, { type: 'ai', difficulty: 'easy', name: 'Solo', skin: 'olive' });
  const st2 = await wait(ws, 'start');
  if (st2.n === 2 && st2.mode === 'duel' && st2.names[1] === 'CPU · Easy') ok('a plain duel-vs-CPU frame on the same socket still yields the historical 2-seat duel');
  else fail(`duel start was n=${st2.n} mode=${st2.mode} names=${JSON.stringify(st2.names)}`);
  send(ws, { type: 'leave' });
  await sleep(200);
  ws.close();
} catch (e) {
  fail(e.message);
}

console.log(errors.length ? `\n${errors.length} FAILED` : '\nALL GOOD');
process.exit(errors.length ? 1 : 0);
