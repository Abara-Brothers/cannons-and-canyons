// Batch-6 wire checks:
//   1. profanity filter — a leetspeak-dirty callsign never reaches other players
//   2. loadouts — a duel starts with 5 picked weapons x2 rounds + everyone's nuke,
//      and a malformed loadout falls back to the default kit
//   3. Boss Fight friendly fire — a nuke dropped on your own squad hurts NOBODY
//      on the human side (blast now, fallout ticks after)
import WebSocket from 'ws';

const URL = process.env.WS || 'ws://localhost:3000/ws';
const out = { steps: [], errors: [] };
const step = (m) => out.steps.push(m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const finish = () => { console.log(JSON.stringify(out, null, 2)); process.exit(out.errors.length ? 1 : 0); };
setTimeout(() => { fail('global timeout'); finish(); }, 60000);

// ---- Pass 1: profanity ------------------------------------------------------
function profanityPass() {
  const ws = new WebSocket(URL);
  const dirty = 'Sh1tL0rd';
  ws.on('open', () => ws.send(JSON.stringify({ type: 'create', name: dirty, skin: 'olive', mode: 'duel' })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'lobby') {
      const shown = m.players[0] && m.players[0].name;
      step(`dirty callsign became '${shown}'`);
      // Fold the leet back out and look for the actual slur — 'Longshot' (a
      // clean fallback) must pass, the raw input must not survive.
      const folded = String(shown || '').toLowerCase().replace(/1/g, 'i').replace(/0/g, 'o').replace(/[^a-z]/g, '');
      if (!shown || shown === dirty || folded.includes('shit')) fail(`profanity filter let '${shown}' through`);
      try { ws.close(); } catch {}
      loadoutPass();
    }
  });
}

// ---- Pass 2: loadouts (vs CPU so the match starts instantly) ------------------
function loadoutPass() {
  const picks = ['gas', 'wall', 'teleport', 'nano', 'minigun'];
  const ws = new WebSocket(URL);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'ai', difficulty: 'easy', name: 'Loadout Tester', skin: 'olive', loadout: picks })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== 'start') return;
    const lo = m.loadouts && m.loadouts[m.you];
    if (!lo || lo.join() !== picks.join()) fail(`snapshot loadout is ${JSON.stringify(lo)}, expected ${JSON.stringify(picks)}`);
    for (const id of picks) if (m.ammo[id] !== 2) fail(`picked ${id} has ammo ${m.ammo[id]}, expected 2`);
    if (m.ammo.nuke !== 1) fail(`nuke ammo ${m.ammo.nuke}, expected 1 (everyone gets it)`);
    for (const id of ['cannon', 'mortar', 'cluster', 'napalm', 'airstrike', 'volley', 'buster']) {
      if (m.ammo[id] !== 0) fail(`unpicked ${id} has ammo ${m.ammo[id]}, expected 0`);
    }
    if ((m.loadouts || []).length && !Array.isArray(m.loadouts[1 - m.you])) fail('the CPU seat has no loadout of its own');
    step('loadout ammo map correct (5 picks x2 + nuke)');
    try { ws.close(); } catch {}
    fallbackPass();
  });
}

function fallbackPass() {
  const ws = new WebSocket(URL);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'ai', difficulty: 'easy', name: 'Fallback', skin: 'olive', loadout: ['gas', 'gas', 'gas'] })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== 'start') return;
    // malformed picks -> the default kit
    for (const id of ['cannon', 'mortar', 'cluster', 'napalm', 'airstrike']) {
      if (m.ammo[id] !== 2) fail(`fallback ${id} ammo ${m.ammo[id]}, expected 2 (default kit)`);
    }
    if (m.ammo.nuke !== 1) fail(`fallback nuke ammo ${m.ammo.nuke}, expected 1`);
    step('malformed loadout fell back to the default kit');
    try { ws.close(); } catch {}
    bossFriendlyFirePass();
  });
}

// ---- Pass 3: Boss Fight friendly fire -----------------------------------------
function bossFriendlyFirePass() {
  const A = new WebSocket(URL);
  const B = new WebSocket(URL);
  const sendA = (m) => A.send(JSON.stringify(m));
  const sendB = (m) => B.send(JSON.stringify(m));
  let code = null, seatA = -1, bossSeat = -1, baseHp = null, fired = false, shotSeen = false;

  // The first turn is RANDOM (2 humans + the WARLORD). Bravo plinks a cannon
  // shot on its own turns so the rotation always reaches Alpha's nuke.
  let seatB = -1;
  B.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'start') seatB = m.you;
    if (m.type === 'turn' && m.turn === seatB) sendB({ type: 'fire', weapon: 'cannon', angle: 55, power: 45 });
  });

  A.on('open', () => sendA({ type: 'create', name: 'Alpha', skin: 'olive', mode: 'boss' }));
  A.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'created') { code = m.code; B.on('open', () => sendB({ type: 'join', code, name: 'Bravo', skin: 'desert' })); if (B.readyState === 1) sendB({ type: 'join', code, name: 'Bravo', skin: 'desert' }); }
    if (m.type === 'lobby' && m.players.filter(Boolean).length === 2) sendA({ type: 'startMatch' });
    if (m.type === 'start') {
      seatA = m.you; bossSeat = m.boss; baseHp = m.hp.slice();
      step(`boss room live: humans=[${m.names.filter((_, i) => i !== bossSeat)}]`);
    }
    if (m.type === 'turn' && m.turn === seatA && !fired) {
      fired = true;
      // Drop the nuke at our own feet: near-vertical, minimum range. In a world
      // WITH friendly fire this hurts Alpha badly and likely Bravo's shield of
      // dirt too; with the fix, every human damage entry must be exactly 0.
      sendA({ type: 'fire', weapon: 'nuke', angle: 88, power: 10 });
    }
    if (m.type === 'shot' && m.by === seatA) {
      shotSeen = true;
      for (let i = 0; i < m.damage.length; i++) {
        if (i !== bossSeat && (m.damage[i] || 0) !== 0) fail(`friendly fire: human seat ${i} took ${m.damage[i]} from a squad nuke`);
      }
      step(`squad nuke resolved: damage=${JSON.stringify(m.damage)} (humans untouched)`);
      // Now watch the fallout window: the nuke leaves a gas hazard on our own
      // position — its ticks must skip humans too.
      let hpAtBlast = m.hp.slice();
      const watch = (raw2) => {
        const d = JSON.parse(raw2);
        if (d.type === 'dot') {
          // The WARLORD keeps fighting during the window and its magma fire
          // legitimately burns humans for 8 a bite — only the nuke fallout's
          // 5-damage signature counts as friendly fire here.
          for (let i = 0; i < d.hp.length; i++) {
            if (i !== bossSeat && (d.damage[i] || 0) === 5) fail(`fallout tick burned human seat ${i} for 5`);
          }
        }
      };
      A.on('message', watch);
      setTimeout(() => {
        A.off('message', watch);
        step('fallout window clean — no human took a tick');
        try { A.close(); B.close(); } catch {}
        step('ALL GOOD');
        finish();
      }, 5200);
    }
  });
  setTimeout(() => { if (!shotSeen) { fail('boss FF pass never saw the shot resolve'); finish(); } }, 30000);
}

profanityPass();
