// Security regressions (batch 8.25). Each section reproduces an exploit that
// was CONFIRMED against the live code during the 2026-07-31 store-readiness
// audit, and asserts it is now closed.
//
//   1. Room exhaustion — one socket could own unlimited rooms. handleClose only
//      ever resolves the LATEST ws.roomCode, so every earlier room was orphaned,
//      unreachable by cleanup and never swept. Repeated `create` exhausted the
//      instance and OOM-killed the process, destroying every live match.
//   2. NaN drive — `move.dir` reached Math.sign() unvalidated. A non-numeric
//      value produced tank.x = NaN (untargetable: every distance test in
//      simulateShot resolves false) and fuel = NaN (unlimited movement, because
//      `fuel < MOVE_STEP` is false for NaN). The old `moved <= 0` guard did not
//      catch it — NaN <= 0 is false.
//   3. Frame size — the socket now caps a single frame (maxPayload).
import WebSocket from 'ws';

const URL = process.env.WS || 'ws://localhost:3000/ws';
const out = { steps: [], errors: [] };
const step = (m) => { out.steps.push(m); console.log('  ok — ' + m); };
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const finish = () => {
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
  process.exit(out.errors.length ? 1 : 0);
};
setTimeout(() => { fail('timeout'); finish(); }, 90000);

const open = () => new Promise((res, rej) => {
  const ws = new WebSocket(URL);
  ws.on('open', () => res(ws));
  ws.on('error', rej);
});
const wait = (ws, type, ms = 8000) => new Promise((res) => {
  const t = setTimeout(() => res(null), ms);
  const on = (raw) => {
    const m = JSON.parse(raw);
    if (m.type !== type) return;
    clearTimeout(t); ws.off('message', on); res(m);
  };
  ws.on('message', on);
});
const send = (ws, m) => ws.send(JSON.stringify(m));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 1. One socket cannot hoard rooms ---------------------------------------
async function roomHoarding() {
  const ws = await open();
  const codes = [];
  for (let i = 0; i < 5; i++) {
    send(ws, { type: 'create', name: 'Hoarder', skin: 'olive', mode: 'ffa', max: 4 });
    const m = await wait(ws, 'created');
    if (!m) { fail('room hoarding: no `created` reply'); ws.close(); return; }
    codes.push(m.code);
    await sleep(60);
  }
  const unique = [...new Set(codes)];
  if (unique.length !== 5) fail(`expected 5 distinct codes from 5 creates, got ${JSON.stringify(codes)}`);

  // The first four rooms must be GONE — each create releases the previous
  // waiting room. A second socket must not be able to join any of them.
  const probe = await open();
  let joinable = 0;
  for (const code of codes.slice(0, 4)) {
    send(probe, { type: 'join', code, name: 'Probe', skin: 'desert' });
    const err = await Promise.race([wait(probe, 'joinError', 2500), wait(probe, 'lobby', 2500), wait(probe, 'start', 2500)]);
    if (err && err.type !== 'joinError') joinable++;
    await sleep(60);
  }
  if (joinable > 0) fail(`${joinable}/4 abandoned rooms were still joinable — they leaked`);
  else step('room hoarding: 5 creates leave only the newest room alive (4 released)');

  // The newest room must still work.
  send(probe, { type: 'join', code: codes[4], name: 'Probe', skin: 'desert' });
  const good = await Promise.race([wait(probe, 'lobby', 4000), wait(probe, 'start', 4000)]);
  if (!good) fail('the most recent room should still be joinable, but was not');
  else step('room hoarding: the newest room is unaffected');

  try { ws.close(); probe.close(); } catch {}
}

// ---- 2. A malformed drive direction cannot corrupt tank state ---------------
async function nanDrive() {
  const ws = await open();
  send(ws, {
    type: 'ai', difficulty: 'easy', name: 'Driver', skin: 'olive',
    loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'],
  });
  const start = await wait(ws, 'start', 12000);
  if (!start) { fail('NaN drive: no start snapshot'); ws.close(); return; }
  const me = start.you;
  if (start.pick) {           // draft is open — lock in so the match can begin
    send(ws, { type: 'loadout', picks: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'] });
    await wait(ws, 'pickDone', 8000);
  }
  // Wait for our turn.
  for (let i = 0; i < 20 && start.turn !== me; i++) {
    const t = await wait(ws, 'turn', 6000);
    if (t && t.turn === me) break;
  }
  const x0 = start.tanks[me].x;

  // Every one of these used to reach Math.sign() and yield NaN.
  const poison = ['abc', null, undefined, {}, [], NaN, Infinity, '1e999', 0];
  for (const dir of poison) { send(ws, { type: 'move', dir }); await sleep(45); }
  await sleep(400);

  // A legitimate move must still work, and must move a FINITE distance.
  send(ws, { type: 'move', dir: 1 });
  const mv = await wait(ws, 'move', 5000);
  if (!mv) {
    fail('NaN drive: a legitimate move after the poison attempts produced nothing (state may be corrupt)');
  } else if (!Number.isFinite(mv.x) || !Number.isFinite(mv.y) || !Number.isFinite(mv.fuel)) {
    fail(`NaN drive: move broadcast carries non-finite values x=${mv.x} y=${mv.y} fuel=${mv.fuel}`);
  } else if (mv.seat !== me) {
    fail(`NaN drive: move broadcast is for seat ${mv.seat}, expected ${me}`);
  } else {
    const drift = Math.abs(mv.x - x0);
    if (drift > 400) fail(`NaN drive: tank jumped ${Math.round(drift)}u — poison input moved it`);
    else step(`NaN drive: ${poison.length} malformed dirs rejected; position finite and intact (moved ${Math.round(drift)}u on a valid step)`);
  }
  try { ws.close(); } catch {}
}

// ---- 3. Oversized frames are rejected, not buffered -------------------------
async function frameCap() {
  const ws = await open();
  let closed = false;
  ws.on('close', () => { closed = true; });
  // 512 KB — comfortably past the 64 KB cap.
  send(ws, { type: 'create', name: 'X'.repeat(512 * 1024), skin: 'olive' });
  await sleep(1200);
  if (!closed) fail('frame cap: a 512 KB frame was accepted (maxPayload not enforced)');
  else step('frame cap: oversized frame closed the socket instead of being buffered');
  try { ws.close(); } catch {}
}

(async () => {
  try {
    await roomHoarding();
    await nanDrive();
    await frameCap();
  } catch (e) {
    fail('threw: ' + (e && e.message ? e.message : String(e)));
  }
  finish();
})();
