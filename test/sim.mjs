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

// Duels now run on 5-pick loadouts (2 rounds each + everyone's nuke), so the
// clients carry complementary kits and each walks its OWN kit twice — between
// them every weapon path (splits, airstrike, hazards, wall, buster, teleport,
// nuke) is exercised. Railgun stays crate-only. Past its 11 rounds a client
// fires plain cannon: that's the server's emergency shell, tested for free.
const LOADOUT_A = ['volley', 'napalm', 'airstrike', 'wall', 'minigun'];
const LOADOUT_B = ['mortar', 'cluster', 'gas', 'buster', 'teleport'];
const rotOf = (picks) => [...picks, 'nuke', ...picks];
const ROT_A = rotOf(LOADOUT_A), ROT_B = rotOf(LOADOUT_B);
function fire(c, shotIndex) {
  const power = 68 + (shotIndex % 7) * 4;
  const rot = c.seat === 0 ? ROT_A : ROT_B;
  let weapon = shotIndex < rot.length ? rot[shotIndex] : 'cannon';
  // Past the kit: fire whatever the wire says we actually hold. A shot that
  // cracked a supply crate open may have gifted us ammo — in that case the
  // server (correctly) does NOT grant the emergency cannon, and blindly
  // firing cannon at 0 rounds would stall the match. (This was the flaky
  // 22-shot suite failure.)
  if (shotIndex >= rot.length && c.ammo) {
    if (!(c.ammo.cannon > 0)) {
      const armed = Object.keys(c.ammo).find(id => c.ammo[id] > 0);
      if (armed) weapon = armed;
    }
  }
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
        if (!Array.isArray(m.hp) || m.hp[0] !== (m.maxHp || 150)) summary.errors.push('missing/odd hp in start');
        if (!Array.isArray(m.trees) || m.trees.length < 30) summary.errors.push('missing trees');
        break;
      case 'turn':
        if (m.ammoSeat === c.seat && m.ammo) c.ammo = m.ammo;
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

a.ws.on('open', () => a.ws.send(JSON.stringify({ type: 'create', name: 'A', loadout: LOADOUT_A })));
const joinIv = setInterval(() => {
  if (code && b.ws.readyState === 1) { clearInterval(joinIv); b.ws.send(JSON.stringify({ type: 'join', code, name: 'B', loadout: LOADOUT_B })); }
}, 30);

let done = false;
function finish() {
  if (done) return; done = true;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.errors.length ? 1 : 0);
}
setTimeout(() => { summary.errors.push('timeout'); finish(); }, 90000);   // remote runs pay an RTT per turn (~2.7s/shot x 24)
