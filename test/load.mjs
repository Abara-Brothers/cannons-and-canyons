// Load and capacity test — the last NOT-RUN gate that needs no device and no
// developer account (`RELEASE_CHECKLIST.md` §7: "Do before any marketing push").
//
// It answers the questions the checklist says are unvalidated: one Render
// Starter instance, every match in process memory, `MAX_ROOMS` 500. What breaks
// first, at what number, and what does a player see when it does?
//
// STRICTLY LOCAL. It spawns its own server on a free port and never touches a
// deployment — pointing this at production would create hundreds of real rooms
// and, since room state is in memory, is indistinguishable from an attack.
// There is no $WS override for that reason.
//
//   node test/load.mjs              # ramp to the MAX_ROOMS ceiling and past it
//   ROOMS=200 node test/load.mjs    # stop earlier
//   MAX_ROOMS=60 node test/load.mjs # lower the server's own cap to reach it fast
//
// Each room is one vs-CPU match: one socket, one bot opponent, a full live
// match with terrain, turn state and a bot timer. That is the cheapest real
// room the server can hold, so these numbers are a CEILING on capacity — a
// room of two humans costs a second socket, and FFA up to four.
import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

const TARGET = Number(process.env.ROOMS || 620);        // past the 500 default cap
const STEP = Number(process.env.STEP || 50);
const SERVER_MAX_ROOMS = process.env.MAX_ROOMS || '';   // '' = server default (500)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Two modes, because they answer different questions:
//   default   — bots never fire. Measures the cost of HOLDING rooms: memory.
//   ACTIVE=1  — bots fire on the real 1500 ms timer, every room simulating
//               shots, terrain deformation and damage. Measures CPU, which is
//               the constraint memory alone will not reveal.
const ACTIVE = process.env.ACTIVE === '1';
const port = await freePort();
const env = { ...process.env, PORT: String(port) };
if (!ACTIVE) env.BOT_FIRE_MS = '100000';
if (SERVER_MAX_ROOMS) env.MAX_ROOMS = SERVER_MAX_ROOMS;
delete env.SUPABASE_SECRET_KEY; delete env.SUPABASE_URL;

const srv = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
srv.stderr.on('data', (d) => { srvLog += d; });

let up = false;
for (let i = 0; i < 80; i++) {
  try { await fetch(`http://127.0.0.1:${port}/health`); up = true; break; } catch {}
  await sleep(150);
}
if (!up) { srv.kill(); console.error('server never came up\n' + srvLog.slice(0, 600)); process.exit(1); }

const rss = () => new Promise((resolve) => {
  const ps = spawn('ps', ['-o', 'rss=', '-p', String(srv.pid)]);
  let out = ''; ps.stdout.on('data', (d) => { out += d; });
  ps.on('close', () => resolve(Math.round((parseInt(out.trim(), 10) || 0) / 1024)));  // MiB
});
const health = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json());

const baselineRss = await rss();
console.log(`server pid ${srv.pid} on :${port} — baseline RSS ${baselineRss} MiB`);
console.log(`ramping to ${TARGET} vs-CPU rooms in steps of ${STEP} — bots ${ACTIVE ? "FIRING (active play)" : "idle (holding cost)"}\n`);

const sockets = [];
let refusedAt = null, refusalReason = null, openFailures = 0;

/** One vs-CPU room. Resolves when the server confirms the match started. */
function makeRoom(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done('timeout'), 15000);
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'ai', name: `Load${i}`, skin: 'desert', difficulty: 'easy',
      loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'gas'],
    })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'state' || m.type === 'start' || m.type === 'match') { clearTimeout(timer); sockets.push(ws); done('ok'); }
      if (m.type === 'joinError') {
        clearTimeout(timer);
        if (refusedAt === null) { refusedAt = sockets.length; refusalReason = m.reason; }
        try { ws.close(); } catch {}
        done('refused');
      }
    });
    ws.on('error', () => { clearTimeout(timer); openFailures++; done('error'); });
  });
}

/** Round-trip a frame the server must answer, to see latency under load. */
async function latency() {
  const t0 = process.hrtime.bigint();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const ms = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: 'ZZZZ' })));  // no such room
    ws.on('message', () => { clearTimeout(timer); resolve(Number(process.hrtime.bigint() - t0) / 1e6); });
    ws.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  try { ws.close(); } catch {}
  return ms;
}

const rows = [];
let created = 0;
for (let base = 0; base < TARGET; base += STEP) {
  const n = Math.min(STEP, TARGET - base);
  const results = await Promise.all(Array.from({ length: n }, (_, k) => makeRoom(base + k)));
  created += results.filter((r) => r === 'ok').length;
  await sleep(400);                                   // let the event loop settle
  const h = await health();
  const mem = await rss();
  const lat = await latency();
  const row = {
    attempted: base + n, live: h.rooms, sockets: sockets.length,
    rssMiB: mem, perRoomKiB: h.rooms ? Math.round(((mem - baselineRss) * 1024) / h.rooms) : 0,
    latencyMs: lat === null ? null : Number(lat.toFixed(1)),
  };
  rows.push(row);
  console.log(
    `attempted ${String(row.attempted).padStart(4)}  live ${String(row.live).padStart(4)}`
    + `  RSS ${String(row.rssMiB).padStart(4)} MiB  ~${String(row.perRoomKiB).padStart(4)} KiB/room`
    + `  join-rtt ${row.latencyMs === null ? ' timeout' : String(row.latencyMs).padStart(6) + ' ms'}`
    + (refusedAt !== null ? '  [AT CAPACITY]' : ''),
  );
  if (refusedAt !== null && base + n >= refusedAt + STEP) break;   // one step past the wall
}

const finalHealth = await health();
const finalRss = await rss();

// Does the server say anything when it refuses? The engine returns a
// player-facing joinError and logs NOTHING, so `rooms` is the only external
// signal — which is why ALERT-4 watches it.
const loggedCapacity = /capacity|MAX_ROOMS/i.test(srvLog);

console.log('\n──────────── results ────────────');
console.log(`rooms created            : ${created}`);
console.log(`live rooms at peak       : ${Math.max(...rows.map((r) => r.live))}`);
console.log(`server cap (MAX_ROOMS)   : ${SERVER_MAX_ROOMS || '500 (default)'}`);
console.log(`refused first at         : ${refusedAt === null ? 'never reached the cap' : `${refusedAt} live rooms`}`);
console.log(`refusal a player sees    : ${refusalReason ? `"${refusalReason}"` : '(none seen)'}`);
console.log(`server logged the refusal: ${loggedCapacity ? 'yes' : 'NO — rooms count is the only signal'}`);
console.log(`RSS baseline -> peak     : ${baselineRss} -> ${finalRss} MiB`);
console.log(`memory per live room     : ~${finalHealth.rooms ? Math.round(((finalRss - baselineRss) * 1024) / finalHealth.rooms) : 0} KiB`);
const lats = rows.map((r) => r.latencyMs).filter((v) => v !== null);
console.log(`join round-trip          : ${Math.min(...lats).toFixed(1)}–${Math.max(...lats).toFixed(1)} ms across the ramp`);
console.log(`socket open failures     : ${openFailures}`);
console.log('\nOne vs-CPU room = one socket. Two humans cost a second socket and');
console.log('FFA up to four, so treat these as a CEILING, not a forecast.');

for (const ws of sockets) { try { ws.close(); } catch {} }
await sleep(300);
srv.kill();
process.exit(0);
