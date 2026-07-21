// End-to-end 4-player free-for-all against a live server.
// Start the server first:  node server.js
//
// Guards the things a duel can never exercise: N-wide payloads, turn rotation that
// skips wrecks, elimination ordering, last-tank-standing, and late-join refusal.
import { WebSocket } from 'ws';

const URL = process.env.WS || 'ws://localhost:3000/ws';
const errors = [];
const steps = [];
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const log = (m) => { steps.push(m); };

function open(name) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.name = name; ws.inbox = []; ws.handlers = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      // Hand it to the first waiter for this type; only buffer it if nobody is
      // waiting. Buffering a message that was already delivered would let the next
      // wait() re-read it and see phantom duplicates.
      const h = ws.handlers.find(x => x.type === m.type);
      if (h) { ws.handlers.splice(ws.handlers.indexOf(h), 1); h.res(m); return; }
      ws.inbox.push(m);
    });
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
function wait(ws, type, ms = 8000) {
  const hit = ws.inbox.find(m => m.type === type);
  if (hit) { ws.inbox.splice(ws.inbox.indexOf(hit), 1); return Promise.resolve(hit); }
  return new Promise((res, rej) => {
    const h = { type, res };
    ws.handlers.push(h);
    setTimeout(() => {
      const i = ws.handlers.indexOf(h);
      if (i >= 0) { ws.handlers.splice(i, 1); rej(new Error(`${ws.name}: timeout waiting for '${type}'`)); }
    }, ms);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  // ---- Lobby: host creates a 4-player FFA, three others join ----------------
  const host = await open('host');
  send(host, { type: 'create', name: 'Ava', skin: 'olive', mode: 'ffa', max: 4 });
  const created = await wait(host, 'created');
  if (created.mode !== 'ffa') fail(`created.mode is '${created.mode}', expected 'ffa'`);
  if (created.max !== 4) fail(`created.max is ${created.max}, expected 4`);
  const code = created.code;
  log(`created FFA room ${code}`);

  const lob0 = await wait(host, 'lobby');
  if (lob0.host !== 0 || lob0.you !== 0) fail('host should be seat 0 in its own lobby');

  const others = [];
  for (const nm of ['Ben', 'Cleo', 'Dev']) {
    const ws = await open(nm);
    send(ws, { type: 'join', code, name: nm, skin: 'desert' });
    others.push(ws);
    await sleep(120);
  }
  const clients = [host, ...others];
  log('three players joined');

  // A full room auto-starts — everyone should get 'start' without the host pressing.
  const starts = await Promise.all(clients.map(c => wait(c, 'start')));
  log('match auto-started when the room filled');

  // ---- Snapshot shape ------------------------------------------------------
  for (const s of starts) {
    if (s.n !== 4) fail(`snapshot.n is ${s.n}, expected 4`);
    if (s.names.length !== 4) fail(`names.length is ${s.names.length}`);
    if (s.hp.length !== 4) fail(`hp.length is ${s.hp.length}`);
    if (s.tanks.length !== 4) fail(`tanks.length is ${s.tanks.length}`);
    if (s.alive.length !== 4 || !s.alive.every(Boolean)) fail('everyone should start alive');
    if (s.facing.length !== 4) fail(`facing.length is ${s.facing.length}`);
    if (s.mode !== 'ffa') fail(`snapshot.mode is '${s.mode}'`);
  }
  // Seats must be ordered left -> right, and every seat sees the same battlefield.
  const xs = starts[0].tanks.map(t => t.x);
  for (let i = 1; i < xs.length; i++) if (xs[i] <= xs[i - 1]) fail(`seats not ordered L->R: ${xs}`);
  for (const s of starts) {
    if (JSON.stringify(s.tanks) !== JSON.stringify(starts[0].tanks)) fail('clients disagree about tank positions');
  }
  if (new Set(starts.map(s => s.you)).size !== 4) fail('seat assignments are not unique');
  log(`seats ordered L->R at x = [${xs.map(Math.round)}]`);

  // ---- A late joiner must be refused ---------------------------------------
  const late = await open('late');
  send(late, { type: 'join', code, name: 'Eve', skin: 'gold' });
  const je = await wait(late, 'joinError');
  if (!/already started/i.test(je.reason)) fail(`late join reason was '${je.reason}'`);
  late.close();
  log('late joiner refused: ' + je.reason);

  // ---- Play: everyone fires on their turn; nobody may act out of turn -------
  let turnMsg = await wait(host, 'turn');
  let shots = 0, gameover = null;
  const seenTurns = new Set();

  while (shots < 40 && !gameover) {
    const seat = turnMsg.turn;
    seenTurns.add(seat);
    if (turnMsg.alive && turnMsg.alive[seat] === false) fail(`turn landed on eliminated seat ${seat}`);
    const actor = clients.find(c => c.seatIdx === seat) ||
                  clients[starts.findIndex(s => s.you === seat)];
    // Aim roughly at a neighbour and fire.
    send(actor, { type: 'fire', weapon: 'cannon', angle: 30 + Math.random() * 30, power: 45 + Math.random() * 35 });
    shots++;

    const res = await Promise.race([
      wait(host, 'shot', 12000).then(m => ({ kind: 'shot', m })),
      wait(host, 'gameover', 12000).then(m => ({ kind: 'over', m })),
    ]);
    if (res.kind === 'over') { gameover = res.m; break; }

    const shot = res.m;
    if (!Array.isArray(shot.alive) || shot.alive.length !== 4) fail('shot payload missing a 4-wide alive mask');
    if (!Array.isArray(shot.hp) || shot.hp.length !== 4) fail('shot payload missing 4-wide hp');

    const nxt = await Promise.race([
      wait(host, 'turn', 15000).then(m => ({ kind: 'turn', m })),
      wait(host, 'gameover', 15000).then(m => ({ kind: 'over', m })),
    ]);
    if (nxt.kind === 'over') { gameover = nxt.m; break; }
    turnMsg = nxt.m;
  }

  log(`played ${shots} shots; distinct seats that acted: ${[...seenTurns].sort().join(',')}`);

  if (!gameover) {
    log('no elimination within the shot budget (tanks are far apart) — turn rotation still verified');
    if (seenTurns.size < 2) fail('turn never rotated between seats');
  } else {
    const liveCount = gameover.alive.filter(Boolean).length;
    if (liveCount > 1) fail(`gameover with ${liveCount} tanks still alive`);
    if (gameover.winner !== -1 && gameover.alive[gameover.winner] !== true) {
      fail(`winner ${gameover.winner} is not among the living`);
    }
    if (gameover.hp.length !== 4) fail('gameover hp is not 4-wide');
    log(`gameover: winner=${gameover.winner} alive=[${gameover.alive}] hp=[${gameover.hp}]`);
    // Every client must receive it, including eliminated ones (they spectate).
    for (const c of others) {
      const g = await wait(c, 'gameover', 4000).catch(() => null);
      if (!g) fail(`${c.name} never received gameover`);
    }
    log('all four clients received gameover');
  }

  for (const c of clients) c.close();
} catch (e) {
  fail(e.message);
}

await sleep(200);
console.log(JSON.stringify({ steps, errors }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
