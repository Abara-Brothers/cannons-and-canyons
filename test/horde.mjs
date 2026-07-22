// Horde survival smoke test: solo host vs the alien invasion (and a zombie
// lobby sanity pass). Asserts three themed enemy seats join with their own
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
setTimeout(() => { fail('timeout'); finish(); }, 90000);

// ---- Pass 1: aliens, played until we see kills + a respawn (or gameover) ----
const ws = new WebSocket(URL);
const send = (m) => ws.send(JSON.stringify(m));

let mySeat = -1, enemySeats = [], enemyFired = false, waveSeen = false,
    respawnSeen = false, shots = 0, tanks = [], terrain = null;

ws.on('open', () => send({ type: 'create', name: 'Defender', skin: 'olive', mode: 'aliens', max: 2 }));
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
    // Use the game's own gunnery brain against the live terrain so every human
    // shot is a real solution — first shot spends the nuke, the rest are cannon.
    const sol = aiShot(terrain, tanks, mySeat, 'hard');
    send({ type: 'fire', weapon: shots === 1 ? 'nuke' : 'cannon', angle: sol.angle, power: sol.power });
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
  if (m.type === 'gameover') {
    step(`gameover: team=${m.team}`);
    if (m.team !== 'players' && m.team !== 'horde') fail(`gameover team '${m.team}' — expected players/horde`);
    return wrapUp(true);
  }
});

let wrapped = false;
function wrapUp(already) {
  if (wrapped) return; wrapped = true;
  try { ws.close(); } catch {}
  if (!enemyFired) fail('no alien ever fired');
  if (!waveSeen) fail('no kill was ever counted on the wire');
  if (!respawnSeen && !already) fail('no respawn seen (and the match did not end)');
  zombiePass();
}

// ---- Pass 2: zombies — just the roster, then bail ---------------------------
function zombiePass() {
  const z = new WebSocket(URL);
  const zsend = (m) => z.send(JSON.stringify(m));
  const done = setTimeout(() => { fail('zombie pass timeout'); finish(); }, 15000);
  z.on('open', () => zsend({ type: 'create', name: 'Survivor', skin: 'olive', mode: 'zombies', max: 2 }));
  z.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'lobby') zsend({ type: 'startMatch' });
    if (m.type === 'start') {
      const zombies = (m.kinds || []).map((k, i) => (k === 'zombie' ? i : -1)).filter(i => i >= 0);
      step(`zombie roster: [${zombies.map(i => m.names[i])}]`);
      if (zombies.length !== 3) fail(`kinds lists ${zombies.length} zombies, expected 3`);
      for (const i of zombies) {
        if (m.hpMax[i] !== 130) fail(`zombie seat ${i} hpMax ${m.hpMax[i]}, expected 130 (110 + wave1*20)`);
      }
      const wanted = ['ROTBOX', 'GRAVEDIGGER', 'PUTRID-9'];
      if (!zombies.every((i, k) => m.names[i] === wanted[k])) fail(`zombie names ${zombies.map(i => m.names[i])}`);
      clearTimeout(done);
      try { z.close(); } catch {}
      step('ALL GOOD');
      finish();
    }
  });
}
