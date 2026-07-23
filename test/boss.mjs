// Boss Raid smoke test: solo host vs WARLORD-7.
// Asserts the boss seat exists at 1.8x scale with 400 HP, that the boss takes
// its turn and fires from ITS OWN kit, that a human cannot fire boss weapons,
// and that boss damage actually lands on the wire.
import WebSocket from 'ws';

const URL = process.env.WS || 'ws://localhost:3000/ws';
const out = { steps: [], errors: [] };
const step = (m) => out.steps.push(m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const finish = () => { console.log(JSON.stringify(out, null, 2)); process.exit(out.errors.length ? 1 : 0); };
setTimeout(() => { fail('timeout'); finish(); }, 150000);   // deployed bots hold for each shot's replay window

const ws = new WebSocket(URL);
const send = (m) => ws.send(JSON.stringify(m));

let bossSeat = -1, mySeat = -1, bossFired = false, myTurnSeen = false, shots = 0;

ws.on('open', () => send({ type: 'create', name: 'Raider', skin: 'olive', mode: 'boss', max: 2, loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] }));
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'created') {
    if (m.mode !== 'boss') fail(`created.mode is '${m.mode}'`);
    step('boss room created ' + m.code);
  }
  if (m.type === 'lobby') {
    // Solo raid: the host may engage alone.
    send({ type: 'startMatch' });
  }
  if (m.type === 'start') {
    mySeat = m.you;
    bossSeat = m.boss;
    step(`match started: me=seat ${mySeat}, WARLORD=seat ${bossSeat}, biome=${m.biome}`);
    if (bossSeat == null || bossSeat < 0) fail('snapshot has no boss seat');
    if (m.n !== 2) fail(`expected 2 seats (1 human + boss), got ${m.n}`);
    if (!m.hpMax || m.hpMax[bossSeat] !== 400) fail(`boss hpMax is ${m.hpMax && m.hpMax[bossSeat]}, expected 400`);
    if (m.hpMax[mySeat] !== 150) fail(`human hpMax is ${m.hpMax[mySeat]}, expected 150`);
    if (!m.scales || Math.abs(m.scales[bossSeat] - 1.8) > 0.01) fail(`boss scale is ${m.scales && m.scales[bossSeat]}, expected 1.8`);
    if (m.names[bossSeat] !== 'WARLORD-7') fail(`boss name is '${m.names[bossSeat]}'`);
    // A human trying to fire the boss's kit must be silently refused.
    send({ type: 'fire', weapon: 'b_twin', angle: 45, power: 60 });
  }
  if (m.type === 'turn') {
    if (m.turn === mySeat) {
      myTurnSeen = true;
      if (shots < 4) { shots++; send({ type: 'fire', weapon: 'cannon', angle: 40 + shots * 3, power: 60 }); }
      else { step('done shooting'); wrapUp(); }
    }
    // Boss turn: do nothing — the bot must act on its own.
  }
  if (m.type === 'shot') {
    if (m.by === bossSeat) {
      bossFired = true;
      if (!/^b_/.test(m.weapon)) fail(`boss fired '${m.weapon}' — not from its kit`);
      else step(`WARLORD fired ${m.weapon}`);
      if (!Array.isArray(m.hp) || m.hp.length !== 2) fail('boss shot payload malformed');
    } else if (m.by === mySeat && m.weapon === 'b_twin') {
      fail('server let a HUMAN fire a bossOnly weapon');
    }
  }
  if (m.type === 'gameover') { step(`gameover early: team=${m.team}`); wrapUp(true); }
});

let wrapped = false;
function wrapUp(already) {
  if (wrapped) return; wrapped = true;
  setTimeout(() => {
    if (!myTurnSeen) fail('never got a turn');
    if (!bossFired) fail('the WARLORD never fired');
    step('ALL GOOD');
    finish();
  }, already ? 100 : 9000);   // leave room for one more boss turn (walk + 1.5s hold)
}
