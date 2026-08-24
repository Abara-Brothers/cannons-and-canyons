// Timer safety — BEHAVIOUR, not spelling. Headless: no server needed.
//
// WHY THIS EXISTS: `house-rules.mjs` asserts that the engine schedules only
// through safeTimeout/safeInterval. That rule is real, but it is a STATIC check
// on how lines are written, and both helpers carry a `BARE-TIMER-OK` marker that
// exempts them — so the marker that licenses them also exempts their bodies.
// Verified 2026-08-22: reducing BOTH helpers to a bare `setTimeout(fn, ms)` /
// `setInterval(fn, ms)`, removing every try/catch, left the rule printing
//   ok — engine schedules only through safeTimeout/safeInterval
// and the suite green. The guard against a server-wide outage was enforcing
// spelling.
//
// So this file asserts the three things that actually matter:
//   1. a throw inside a timer callback does NOT escape (it would reach
//      uncaughtException, whose handler shuts the process down and destroys
//      every live match, not just the room that faulted);
//   2. the fault is ANNOUNCED to the host, because containment without
//      visibility is a room that silently stops advancing;
//   3. a faulting INTERVAL disarms itself, or one fault becomes a sustained
//      write storm against the error table.
//
// PICK_MS is set BEFORE the dynamic import so the engine reads it at module
// evaluation time — that is what makes a real armed timer fire in under a second.
process.env.PICK_MS = '350';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const engine = await import('../public/room-engine.js');
const { rooms, handleClientMessage, setFaultSink } = engine;

if (typeof setFaultSink !== 'function') {
  fail('the engine does not export setFaultSink — faults cannot reach the host at all');
  console.log(`\n${out.errors.length} FAILED`);
  process.exit(1);
}

let faults = 0;
setFaultSink(() => { faults += 1; });

let escaped = null;
process.on('uncaughtException', (e) => { escaped = e; });

const mkws = () => ({ readyState: 1, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });

// ---- 1 + 2. A throw in a real armed TIMEOUT is contained and announced ------
{
  const ws = mkws();
  handleClientMessage(ws, { type: 'ai', difficulty: 'easy', name: 'T', skin: 'olive' });
  const room = [...rooms.values()].pop();
  if (!room || !room.pickTimer) {
    fail('could not arm a real timer (no pickTimer) — this test proves nothing, treat as broken');
  } else {
    // finishPicking() reads room.players; make that read throw.
    Object.defineProperty(room, 'players', {
      configurable: true,
      get() { throw new Error('timer-safety probe'); },
    });
    const before = faults;
    await sleep(1200);
    if (escaped) fail(`a timer throw ESCAPED to uncaughtException (${escaped.message}) — this kills every live match`);
    else ok('a throw inside a timer callback is contained');
    if (faults > before) ok('the fault was announced to the host (setFaultSink)');
    else fail('the fault was swallowed silently — a stalled room with nothing reported anywhere');
    try { Object.defineProperty(room, 'players', { value: [], writable: true, configurable: true }); } catch {}
  }
}

// ---- 3. A faulting INTERVAL disarms itself ---------------------------------
{
  const ws = mkws();
  handleClientMessage(ws, { type: 'ai', difficulty: 'easy', name: 'I', skin: 'olive',
    loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] });
  const room = [...rooms.values()].pop();
  await sleep(600);                                   // let the pick window close
  handleClientMessage(ws, { type: 'fire', weapon: 'napalm', angle: 45, power: 70 });
  await sleep(900);                                   // burning hazards -> startFire

  if (!room || !room.fireTimer) {
    // Not a failure of the ENGINE — the shot may not have started a blaze. Say so
    // plainly rather than printing "ok" for something never exercised, which is
    // the exact decorative-pass this file exists to stop.
    fail('could not arm a real INTERVAL (no fireTimer) — self-disarm was NOT exercised');
  } else {
    Object.defineProperty(room, 'hazards', {
      configurable: true,
      get() { throw new Error('interval probe'); },
    });
    const before = faults;
    await sleep(2500);
    const raised = faults - before;
    if (escaped) fail('an interval throw escaped to uncaughtException');
    else if (raised === 1) ok('a faulting interval disarms after ONE fault, not every tick');
    else if (raised === 0) fail('the interval never threw — self-disarm was not exercised');
    else fail(`a faulting interval kept firing: ${raised} faults — one defect becomes a write storm`);
  }
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
