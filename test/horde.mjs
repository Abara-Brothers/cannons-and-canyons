// Horde survival smoke test: solo host vs the alien invasion.
// Asserts three themed enemy seats join with their own
// names/kinds/HP, that enemies fire from their OWN kit and a human cannot,
// that kills are counted on the wire, and that a downed enemy respawns
// stronger on a later turn.
import WebSocket from 'ws';
import { aiShot } from '../game-core.js';

const URL = process.env.WS || 'ws://localhost:3000/ws';
const out = { steps: [], errors: [] };
const step = (m) => out.steps.push(m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const finish = () => { console.log(JSON.stringify(out, null, 2)); process.exit(out.errors.length ? 1 : 0); };
setTimeout(() => { fail('timeout'); finish(); }, 360000);   // deployed bots hold for each shot's replay window

// ---- Pass 1: aliens, played until we see kills + a respawn (or gameover) ----
// A LONE defender vs three saucers occasionally gets overrun on a bad seed
// before it can land its first kill — pure match randomness, not a wire bug.
// The pass retries a few times so the kill-counting / respawn assertions
// (which only fire once a kill actually happens) are verified reliably.
let ws, send, mySeat, enemySeats, enemyFired, waveSeen, respawnSeen, shots, tanks, terrain;
let attempt = 0;

function alienPass() {
  attempt++;
  mySeat = -1; enemySeats = []; enemyFired = false; waveSeen = false;
  respawnSeen = false; shots = 0; tanks = []; terrain = null;
  ws = new WebSocket(URL);
  send = (m) => ws.send(JSON.stringify(m));

  ws.on('open', () => send({ type: 'create', name: 'Defender', skin: 'olive', mode: 'aliens', max: 2, loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley', 'buster', 'gas'] }));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'created') {
      if (m.mode !== 'aliens') fail(`created.mode is '${m.mode}'`);
      step('alien room created ' + m.code);
    }
    if (m.type === 'lobby') send({ type: 'startMatch' });      // solo defence is legal
    if (m.type === 'start') {
      mySeat = m.you;
      tanks = m.tanks;
      terrain = m.terrain;
      enemySeats = (m.kinds || []).map((k, i) => (k === 'alien' ? i : -1)).filter(i => i >= 0);
      step(`match started: me=seat ${mySeat}, aliens=[${enemySeats}]`);
      if (m.n !== 4) fail(`expected 4 seats (1 human + 3 aliens), got ${m.n}`);
      if (enemySeats.length !== 3) fail(`kinds lists ${enemySeats.length} aliens, expected 3`);
      if (!m.horde || m.horde.target !== 8) fail(`snapshot horde is ${JSON.stringify(m.horde)}`);
      for (const i of enemySeats) {
        if (m.hpMax[i] !== 108) fail(`alien seat ${i} hpMax ${m.hpMax[i]}, expected 108 (90 + wave1*18)`);
        if (!/^XENO-/.test(m.names[i])) fail(`alien seat ${i} named '${m.names[i]}'`);
      }
      if (m.hpMax[mySeat] !== 150) fail(`human hpMax is ${m.hpMax[mySeat]}, expected 150`);
      // A human must not be able to fire the alien kit.
      send({ type: 'fire', weapon: 'a_plasma', angle: 45, power: 60 });
    }
    if (m.type === 'turn' && m.turn === mySeat) {
      shots++;
      if (shots > 26 || (waveSeen && respawnSeen)) return wrapUp();
      // The game's own gunnery brain solves every shot against the live terrain.
      // Open with the nuke, follow with clusters (its 2 rounds) to land the
      // first kill fast, then fall back to the unlimited cannon.
      const sol = aiShot(terrain, tanks, mySeat, 'hard');
      const weapon = shots === 1 ? 'nuke' : shots <= 3 ? 'cluster' : 'cannon';
      send({ type: 'fire', weapon, angle: sol.angle, power: sol.power });
    }
    if (m.type === 'shot') {
      if (enemySeats.includes(m.by)) {
        enemyFired = true;
        if (!/^a_/.test(m.weapon)) fail(`alien fired '${m.weapon}' — not from its kit`);
      } else if (m.by === mySeat && m.weapon === 'a_plasma') {
        fail('server let a HUMAN fire an aiOnly alien weapon');
      }
      if (m.tanks) tanks = m.tanks;
      if (m.terrainDiff && terrain) {
        for (let k = 0; k < m.terrainDiff.values.length; k++) terrain[m.terrainDiff.from + k] = m.terrainDiff.values[k];
      }
    }
    if (m.type === 'wave') {
      waveSeen = true;
      step(`kill counted: ${m.kills}/${m.target} (wave ${m.wave})`);
      if (!(m.kills >= 1 && m.target === 8)) fail(`bogus wave payload ${JSON.stringify(m)}`);
    }
    if (m.type === 'respawn') {
      respawnSeen = true;
      step(`respawn: seat ${m.seat} back at x=${m.x} with ${m.hpMax[m.seat]} health (wave ${m.wave})`);
      if (!enemySeats.includes(m.seat)) fail(`respawned seat ${m.seat} is not an alien`);
      if (m.hpMax[m.seat] <= 108) fail(`respawn hpMax ${m.hpMax[m.seat]} — waves must get stronger`);
      if (m.alive && m.alive[m.seat] !== true) fail('respawn did not revive the seat');
      if (Math.abs(m.x - tanks[mySeat].x) <= 2600) fail(`respawn at ${m.x} is within 2600 of the human at ${tanks[mySeat].x}`);
    }
    // Everything this smoke test verifies (enemies fire their own kit, kills
    // count, a downed enemy respawns stronger) is proven the moment all three
    // are seen — wrap up immediately rather than play on. On the deployed
    // server each turn carries an RTT + the bot replay-hold, so waiting for
    // another human turn otherwise drags the war of attrition past the timeout.
    if (enemyFired && waveSeen && respawnSeen) return wrapUp();
    if (m.type === 'gameover') {
      step(`gameover: team=${m.team}`);
      if (m.team !== 'players' && m.team !== 'horde') fail(`gameover team '${m.team}' — expected players/horde`);
      // Overrun before a single kill on this seed → retry a fresh defence
      // rather than flake; a scored kill (waveSeen) means the wire is proven.
      if (m.team === 'horde' && !waveSeen && attempt < 4) {
        step(`overrun before a kill — retrying (attempt ${attempt})`);
        try { ws.close(); } catch {}
        return alienPass();
      }
      return wrapUp(true);
    }
  });
}

let wrapped2 = false;
function wrapUp(already) {
  if (wrapped2) return; wrapped2 = true;
  try { ws.close(); } catch {}
  if (!enemyFired) fail('no alien ever fired');
  if (!waveSeen) fail('no kill was ever counted on the wire');
  if (!respawnSeen && !already) fail('no respawn seen (and the match did not end)');
  step('ALL GOOD');
  finish();
}

alienPass();
