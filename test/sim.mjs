// Headless two-client match — verifies the server end-to-end without the UI clock.
import WebSocket from 'ws';
const URL = 'ws://localhost:3000/ws';

function client(name) {
  const ws = new WebSocket(URL);
  const c = { ws, name, seat: null, log: [] };
  ws.on('message', (raw) => c.onMsg(JSON.parse(raw)));
  return c;
}

const a = client('A'), b = client('B');
let code = null;
const summary = { shots: 0, scored: 0, craters: 0, dirt: 0, maxProjectiles: 0, gameover: null, errors: [] };

// Cycle through every weapon (including the new split weapons) to exercise all paths.
const ROTATION = ['cannon', 'bigshot', 'twin', 'triple', 'scatter', 'cluster', 'firestorm', 'sniper', 'digger', 'dirt', 'nuke'];
function fire(c, shotIndex) {
  const power = 68 + (shotIndex % 7) * 4;   // sweep power to vary impacts
  const weapon = ROTATION[shotIndex % ROTATION.length];
  c.ws.send(JSON.stringify({ type: 'fire', weapon, angle: 45, power }));
}

function attach(c, other) {
  let myShotCount = 0;
  c.onMsg = (m) => {
    switch (m.type) {
      case 'created': code = m.code; break;
      case 'start':
        c.seat = m.you;
        if (m.terrain.length !== 1281) summary.errors.push('bad terrain length ' + m.terrain.length);
        break;
      case 'turn':
        if (m.turn === c.seat) setTimeout(() => fire(c, myShotCount++), 15);
        break;
      case 'shot':
        if (c.seat === 0) { // count once (from one client's perspective)
          summary.shots++;
          summary.maxProjectiles = Math.max(summary.maxProjectiles, m.projectiles.length);
          const pathsOk = m.projectiles.every(p => Array.isArray(p.path) && p.path.length >= 1);
          if (!pathsOk) summary.errors.push('projectile with empty path');
          if (m.scoreDelta > 0) summary.scored++;
          if (m.terrainDiff) { const anyDirt = false; summary.craters++; }
        }
        break;
      case 'gameover':
        if (c.seat === 0 && !summary.gameover) {
          summary.gameover = { scores: m.scores, winner: m.winner };
          finish();
        }
        break;
    }
  };
}
attach(a, b); attach(b, a);

a.ws.on('open', () => a.ws.send(JSON.stringify({ type: 'create', name: 'A' })));
// Poll for the room code, then B joins.
const joinIv = setInterval(() => {
  if (code && b.ws.readyState === 1) { clearInterval(joinIv); b.ws.send(JSON.stringify({ type: 'join', code, name: 'B' })); }
}, 30);

let done = false;
function finish() {
  if (done) return; done = true;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.errors.length ? 1 : 0);
}
setTimeout(() => { summary.errors.push('timeout — no gameover'); finish(); }, 15000);
