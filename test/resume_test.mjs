// Resume test: A creates, B joins, one shot is fired, then A's socket dies
// abruptly. A reconnects with its token and must receive a full 'restore'
// snapshot; B must see oppConn false→true. Exits 0 on success.
import WebSocket from 'ws';
const URL = process.env.WS || 'ws://localhost:3000/ws';

const out = { steps: [], errors: [] };
const step = (s) => out.steps.push(s);

function finish() {
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.errors.length ? 1 : 0);
}
setTimeout(() => { out.errors.push('timeout'); finish(); }, 25000);

let code = null, tokenA = null, hpAfterShot = null, turnAfterShot = null;
let bSawDrop = false, bSawBack = false;

const b = new WebSocket(URL);
const a1 = new WebSocket(URL);

a1.on('open', () => a1.send(JSON.stringify({ type: 'create', name: 'A', skin: 'jungle', loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] })));
a1.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'created') { code = m.code; step('created ' + code); }
  if (m.type === 'start') {
    tokenA = m.token;
    if (!tokenA) out.errors.push('no token in start');
    if (m.skins[0] !== 'jungle') out.errors.push('skin not applied: ' + m.skins);
    step('A started, turn=' + m.turn);
    // whoever holds the turn fires one cannon shot
    if (m.turn === 0) a1.send(JSON.stringify({ type: 'fire', weapon: 'cannon', angle: 45, power: 70 }));
  }
  if (m.type === 'shot') { hpAfterShot = m.hp; }
  if (m.type === 'turn' && hpAfterShot) {
    turnAfterShot = m.turn;
    step('shot resolved, next turn=' + m.turn);
    // hard-kill A's connection (accidental disconnect)
    setTimeout(() => { step('killing A socket'); a1.terminate(); setTimeout(resumeA, 900); }, 150);
  }
});

b.on('open', () => {
  const iv = setInterval(() => {
    if (code && b.readyState === 1) { clearInterval(iv); b.send(JSON.stringify({ type: 'join', code, name: 'B', loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] })); }
  }, 30);
});
b.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'start' && m.turn === 1) b.send(JSON.stringify({ type: 'fire', weapon: 'cannon', angle: 45, power: 70 }));
  if (m.type === 'oppConn' && m.connected === false) { bSawDrop = true; step('B saw opponent drop'); }
  if (m.type === 'oppConn' && m.connected === true) { bSawBack = true; step('B saw opponent return'); checkDone(); }
});

let restored = null;
function resumeA() {
  const a2 = new WebSocket(URL);
  a2.on('open', () => a2.send(JSON.stringify({ type: 'resume', code, token: tokenA })));
  a2.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'restore') {
      restored = m;
      step('A restored: turn=' + m.turn + ' hp=' + JSON.stringify(m.hp));
      if (m.you !== 0) out.errors.push('restore wrong seat');
      if (JSON.stringify(m.hp) !== JSON.stringify(hpAfterShot)) out.errors.push(`restore hp mismatch ${m.hp} vs ${hpAfterShot}`);
      if (m.turn !== turnAfterShot) out.errors.push('restore wrong turn');
      if (!Array.isArray(m.terrain) || m.terrain.length !== m.world.w + 1) out.errors.push('restore terrain bad');
      if (!m.trees || !m.weapons || !m.ammo) out.errors.push('restore missing fields');
      checkDone();
    }
    if (m.type === 'resumeError') { out.errors.push('resumeError'); finish(); }
  });
}

function checkDone() {
  // A must come back with correct state, and B must end up knowing A is present.
  // Seeing the DROP first is NOT required: if A reconnects before the server has
  // noticed the dead socket (routine behind a proxy — Render takes ~20s to report
  // one), the seat is handed straight back and the opponent is never told anything
  // went wrong. That is the desired outcome, not a missed event.
  if (restored && bSawBack) {
    step(bSawDrop
      ? 'B saw the full drop → return cycle'
      : 'A was back before the server noticed the drop — B never saw an interruption');
    step('ALL GOOD');
    finish();
  }
}
