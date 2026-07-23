// Fast-reconnect takeover.
//
// Behind a proxy that holds dead upstream sockets open, a player can be back
// BEFORE the server has noticed they left — measured at ~20s on Render, vs 1ms
// locally. The seat therefore still reads `connected: true` when its owner
// reconnects. This test reproduces that exact state locally by resuming while
// the original socket is still open, and asserts the seat is handed over
// instead of the reconnect being refused (which used to wipe the player's
// saved token and cost them the match).
import WebSocket from 'ws';
const URL = process.env.WS || 'ws://localhost:3000/ws';

const out = { steps: [], errors: [] };
const step = (s) => out.steps.push(s);
const fail = (s) => { out.errors.push(s); console.error('FAIL ' + s); };
function finish() { console.log(JSON.stringify(out, null, 2)); process.exit(out.errors.length ? 1 : 0); }
setTimeout(() => { fail('timeout'); finish(); }, 30000);

let code = null, tokenA = null, startedA = null;
const b = new WebSocket(URL);
const a1 = new WebSocket(URL);
let a1GotBooted = false;

a1.on('open', () => a1.send(JSON.stringify({ type: 'create', name: 'A', skin: 'jungle', loadout: ['cannon', 'mortar', 'cluster', 'napalm', 'airstrike'] })));
a1.on('close', () => { a1GotBooted = true; });
a1.on('error', () => { /* expected: the ghost gets terminated */ });
a1.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'created') code = m.code;
  if (m.type === 'start') {
    tokenA = m.token; startedA = m;
    step(`match started, A is seat ${m.you}, turn=${m.turn}`);
    // Reconnect WITHOUT closing this socket — the server still thinks A is here.
    setTimeout(takeover, 300);
  }
});

b.on('open', () => {
  const iv = setInterval(() => {
    if (code && b.readyState === 1) { clearInterval(iv); b.send(JSON.stringify({ type: 'join', code, name: 'B', loadout: ['cannon', 'mortar', 'cluster', 'napalm', 'airstrike'] })); }
  }, 30);
});
let bSawReconnect = false;
b.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'oppConn' && m.connected === true) { bSawReconnect = true; step('B was told A reconnected'); }
});

function takeover() {
  if (a1.readyState !== 1) fail('the original socket closed early — this test needs it still open');
  step('resuming on a NEW socket while the old one is still open');
  const a2 = new WebSocket(URL);
  a2.on('open', () => a2.send(JSON.stringify({ type: 'resume', code, token: tokenA })));
  a2.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'resumeError') {
      fail('resumeError — the seat was NOT handed over (fast reconnect still broken)');
      return finish();
    }
    if (m.type === 'restore') {
      step(`A took the seat back: seat=${m.you} turn=${m.turn} hp=${JSON.stringify(m.hp)}`);
      if (m.you !== startedA.you) fail(`restored into the wrong seat: ${m.you} vs ${startedA.you}`);
      if (!Array.isArray(m.terrain) || m.terrain.length !== m.world.w + 1) fail('restore terrain bad');
      if (!m.weapons || !m.ammo) fail('restore missing fields');

      // The server terminates the ghost synchronously, so it is dead server-side
      // the moment `restore` is sent. The CLIENT only learns that when the close
      // frame reaches it, which the same proxy delays by ~20s in production — so
      // treat a late close as information, not a failure. What must hold is that
      // the seat now belongs to the new socket and the opponent was told.
      setTimeout(() => {
        step(a1GotBooted
          ? 'stale ghost socket closed promptly'
          : 'ghost close not yet observed by the client (expected behind a proxy; the server already dropped it)');
        if (!bSawReconnect) fail('the opponent was never told A came back');
        if (!out.errors.length) step('ALL GOOD');
        finish();
      }, 1500);
    }
  });
}
