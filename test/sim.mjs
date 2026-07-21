// Headless two-client match — verifies the server end-to-end. With the HP
// system there is no shot limit, so the sim plays a fixed number of shots
// (cycling every weapon) and checks the pipeline stays consistent; it also
// ends early if someone is destroyed.
import WebSocket from 'ws';
const URL = process.env.WS || 'ws://localhost:3000/ws';
const MAX_SHOTS = 24;

function client(name) {
  const ws = new WebSocket(URL);
  const c = { ws, name, seat: null };
  ws.on('message', (raw) => c.onMsg(JSON.parse(raw)));
  return c;
}

const a = client('A'), b = client('B');
let code = null;
const summary = { shots: 0, craters: 0, maxProjectiles: 0, hazardsSeen: 0, hpFinal: null, gameover: null, errors: [] };

// Cycle through every weapon (splits, airstrike, hazards, wall, buster) to exercise all paths.
const ROTATION = ['cannon', 'mortar', 'volley', 'railgun', 'cluster', 'napalm', 'gas', 'airstrike', 'buster', 'wall', 'teleport', 'nuke', 'cannon'];
function fire(c, shotIndex) {
  const power = 68 + (shotIndex % 7) * 4;
  const weapon = ROTATION[shotIndex % ROTATION.length];
  c.ws.send(JSON.stringify({ type: 'fire', weapon, angle: 45, power }));
}

function attach(c) {
  let myShotCount = 0;
  c.onMsg = (m) => {
    switch (m.type) {
      case 'created': code = m.code; break;
      case 'start':
        c.seat = m.you;
        if (m.terrain.length !== m.world.w + 1) summary.errors.push(`bad terrain length ${m.terrain.length}`);
        if (!Array.isArray(m.hp) || m.hp[0] !== 100) summary.errors.push('missing/odd hp in start');
        if (!Array.isArray(m.trees) || m.trees.length < 30) summary.errors.push('missing trees');
        break;
      case 'turn':
        if (m.turn === c.seat && summary.shots < MAX_SHOTS && !summary.gameover) {
          setTimeout(() => fire(c, myShotCount++), 15);
        } else if (summary.shots >= MAX_SHOTS && c.seat === 0) {
          finish();
        }
        break;
      case 'shot':
        if (c.seat === 0) {
          summary.shots++;
          summary.maxProjectiles = Math.max(summary.maxProjectiles, m.projectiles.length);
          if (!m.projectiles.every(p => Array.isArray(p.path) && p.path.length >= 1)) summary.errors.push('projectile with empty path');
          if (!Array.isArray(m.hp)) summary.errors.push('shot missing hp');
          else summary.hpFinal = m.hp;
          if (m.terrainDiff) summary.craters++;
          if ((m.hazards || []).length) summary.hazardsSeen = Math.max(summary.hazardsSeen, m.hazards.length);
        }
        break;
      case 'gameover':
        if (c.seat === 0 && !summary.gameover) {
          summary.gameover = { hp: m.hp, winner: m.winner };
          finish();
        }
        break;
    }
  };
}
attach(a); attach(b);

a.ws.on('open', () => a.ws.send(JSON.stringify({ type: 'create', name: 'A' })));
const joinIv = setInterval(() => {
  if (code && b.ws.readyState === 1) { clearInterval(joinIv); b.ws.send(JSON.stringify({ type: 'join', code, name: 'B' })); }
}, 30);

let done = false;
function finish() {
  if (done) return; done = true;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.errors.length ? 1 : 0);
}
setTimeout(() => { summary.errors.push('timeout'); finish(); }, 20000);
