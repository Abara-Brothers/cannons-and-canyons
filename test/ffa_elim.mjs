// FFA elimination path: wrecks leave the rotation, the match runs on, and the
// last tank standing wins. Drives it through the disconnect/scuttle route so it
// does not depend on landing shots.
//
// Run with a short grace period:
//   RESUME_GRACE_MS=1200 node server.js
//   node test/ffa_elim.mjs
import { WebSocket } from 'ws';

const URL = process.env.WS || 'ws://localhost:3000/ws';
const GRACE = Number(process.env.RESUME_GRACE_MS) || 1200;
const errors = [], steps = [];
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const log = (m) => steps.push(m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    const h = { type, res }; ws.handlers.push(h);
    setTimeout(() => {
      const i = ws.handlers.indexOf(h);
      if (i >= 0) { ws.handlers.splice(i, 1); rej(new Error(`${ws.name}: timeout waiting for '${type}'`)); }
    }, ms);
  });
}

try {
  const host = await open('host');
  send(host, { type: 'create', name: 'Ava', skin: 'olive', mode: 'ffa', max: 4 });
  const { code } = await wait(host, 'created');
  await wait(host, 'lobby');

  const others = [];
  for (const nm of ['Ben', 'Cleo', 'Dev']) {
    const ws = await open(nm);
    send(ws, { type: 'join', code, name: nm, skin: 'desert' });
    others.push(ws); await sleep(120);
  }
  const clients = [host, ...others];
  const starts = await Promise.all(clients.map(c => wait(c, 'start')));
  const seatOf = new Map(clients.map((c, i) => [c, starts[i].you]));
  log(`4-player match started; seats ${clients.map(c => c.name + '=' + seatOf.get(c)).join(' ')}`);

  // Drop TWO players. Each should be scuttled after the grace period, and the
  // match must continue with the survivors rather than tearing down.
  const dropped = others.slice(0, 2);
  for (const d of dropped) d.close();
  log(`closed sockets for ${dropped.map(d => d.name).join(' and ')}`);

  const forfeits = [];
  for (let k = 0; k < 2; k++) {
    const f = await wait(host, 'forfeit', GRACE * 4 + 5000);
    forfeits.push(f);
    if (!Array.isArray(f.alive) || f.alive.length !== 4) fail('forfeit payload missing a 4-wide alive mask');
    if (f.alive[f.seat] !== false) fail(`forfeit for seat ${f.seat} but alive[${f.seat}] is still true`);
    if (f.hp[f.seat] !== 0) fail(`forfeit for seat ${f.seat} but hp is ${f.hp[f.seat]}`);
    log(`seat ${f.seat} scuttled; alive=[${f.alive}]`);
  }
  const goneSeats = forfeits.map(f => f.seat).sort();
  if (goneSeats.length !== 2) fail('expected two forfeits');

  // Two remain. The match must still be live and the turn must never land on a wreck.
  // Drop any 'turn' buffered from BEFORE the scuttles — those legitimately named a
  // seat that was still alive at the time, and would be a false positive below.
  host.inbox = host.inbox.filter(m => m.type !== 'turn');
  const survivors = clients.filter(c => !dropped.includes(c));
  let over = null;
  for (let i = 0; i < 12 && !over; i++) {
    const t = await Promise.race([
      wait(host, 'turn', 12000).then(m => ({ k: 't', m })),
      wait(host, 'gameover', 12000).then(m => ({ k: 'o', m })),
    ]).catch(() => null);
    if (!t) break;
    if (t.k === 'o') { over = t.m; break; }
    const seat = t.m.turn;
    if (goneSeats.includes(seat)) fail(`turn landed on scuttled seat ${seat}`);
    if (t.m.alive && t.m.alive[seat] === false) fail(`turn landed on a dead seat ${seat}`);
    const actor = survivors.find(c => seatOf.get(c) === seat);
    if (!actor) { fail(`no live client owns seat ${seat}`); break; }
    send(actor, { type: 'fire', weapon: 'cannon', angle: 45, power: 60 });
    await Promise.race([wait(host, 'shot', 12000), wait(host, 'gameover', 12000)]).catch(() => null);
  }
  log(over ? `match ended: winner=${over.winner} alive=[${over.alive}]` : 'match still running with 2 survivors (correct — nobody died)');
  if (over && over.alive.filter(Boolean).length > 1) fail('gameover fired with >1 alive');

  // Now drop one survivor: only ONE tank is left, so the match MUST end.
  if (!over) {
    const victim = survivors[1];
    victim.close();
    log(`closed ${victim.name}; only one tank should remain`);
    const f = await wait(host, 'forfeit', GRACE * 4 + 5000);
    if (f.alive.filter(Boolean).length !== 1) fail(`expected 1 survivor, alive=[${f.alive}]`);
    const g = await wait(host, 'gameover', 6000);
    if (g.winner !== seatOf.get(host)) fail(`winner should be the host's seat ${seatOf.get(host)}, got ${g.winner}`);
    if (g.alive.filter(Boolean).length !== 1) fail(`gameover alive=[${g.alive}], expected exactly 1`);
    log(`last tank standing: seat ${g.winner} wins with ${g.hp[g.winner]} HP`);
  }

  for (const c of clients) { try { c.close(); } catch {} }
} catch (e) {
  fail(e.message);
}

await sleep(200);
console.log(JSON.stringify({ steps, errors }, null, 2));
process.exit(errors.length === 0 ? 0 : 1);
