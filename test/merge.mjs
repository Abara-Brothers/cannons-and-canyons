// Progression merge tests — the FIRST client-side coverage in this project
// (RISK-012: ~6,100 lines of public/app.js with no test touching any of it).
//
// `mergeCloudProgression` decides what happens when the device and the cloud
// disagree about a player's career. Get it wrong and someone's progress is
// silently eaten on sign-in — which is the kind of bug players never report,
// they just stop playing. It is also the testable half of ISSUE-008; the other
// half, genuine two-device conflict, needs two clients on the same LINKED
// account and cannot be automated here.
//
// HOW, without refactoring shipping code: app.js is a classic script, so its
// top-level `function` declarations land on `window` and its top-level `const`
// bindings are reachable by name from an evaluated expression in the same
// realm. So this drives the REAL function in a REAL page over CDP, rather than
// testing a copy of the logic that could drift from it.
//
// Self-hosted: spawns its own server on a free port. Skips cleanly (exit 0)
// when Chrome is absent, so CI on a bare runner stays green.
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.log(`SKIP  merge tests — no Chrome at ${CHROME}`);
  console.log('      (set CHROME_PATH to run them)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// ---- server ----------------------------------------------------------------
const appPort = await freePort();
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(appPort) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverUp = false;
for (let i = 0; i < 80; i++) {
  try { await fetch(`http://127.0.0.1:${appPort}/health`); serverUp = true; break; } catch {}
  await sleep(150);
}
if (!serverUp) { srv.kill(); console.error('FAIL  server never came up'); process.exit(1); }

// ---- browser ---------------------------------------------------------------
const dbgPort = await freePort();
const profile = join(tmpdir(), `cc-merge-${dbgPort}`);
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(250);
}
if (!wsUrl) { chrome.kill(); srv.kill(); console.error('FAIL  Chrome exposed no debugger'); process.exit(1); }

let id = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
for (let i = 0; i < 60; i++) {
  const ready = await evalJs('typeof mergeCloudProgression === "function" && typeof PROF === "object"')
    .catch(() => false);
  if (ready) break;
  await sleep(250);
}

// ---- harness ---------------------------------------------------------------
// A complete PROF shape. `modeStat()` and the merge both assume these exist, so
// every case starts from a whole profile rather than a partial one.
const base = (over = {}) => JSON.stringify({
  v: 1, modes: {}, weapons: {}, shots: 0, hits: 0, maxDmg: 0, longest: 0,
  kills: 0, aces: 0, golfBest: null, hordeBest: {}, ach: {}, ...over,
});

/** Set PROF to a known local state, run the real merge, return PROF after. */
async function merge(local, cloud) {
  return evalJs(`(() => {
    try { localStorage.removeItem('cc_loot_midnight'); } catch (e) {}
    for (const k of Object.keys(PROF)) delete PROF[k];
    Object.assign(PROF, ${local});
    mergeCloudProgression(${JSON.stringify(cloud)});
    return JSON.parse(JSON.stringify({ prof: PROF, midnight: lootMidnight() }));
  })()`);
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

// ---- the cases -------------------------------------------------------------

// 1. Counters take the max in BOTH directions — the core anti-loss property.
{
  const r = await merge(base({ shots: 100, hits: 2, kills: 7 }),
    { career: { shots: 5, hits: 90, kills: 7, aces: 3 } });
  check('counters keep the local value when local is ahead', r.prof.shots === 100, `shots=${r.prof.shots}`);
  check('counters adopt the cloud value when cloud is ahead', r.prof.hits === 90, `hits=${r.prof.hits}`);
  check('counters are unchanged when equal', r.prof.kills === 7, `kills=${r.prof.kills}`);
  check('counters absent locally are adopted', r.prof.aces === 3, `aces=${r.prof.aces}`);
}

// 2. A corrupt or empty cloud row must NEVER wipe a real career. This is the
//    data-loss case that actually matters: the row is jsonb and nothing
//    guarantees its shape.
for (const [label, cloud] of [
  ['null', null], ['empty object', {}], ['career:null', { career: null }],
  ['career:garbage', { career: 'not an object' }], ['wrong types', { career: { shots: 'x', modes: 5, ach: null } }],
]) {
  const r = await merge(base({ shots: 42, kills: 9, ach: { firstBlood: '2026-01-01' } }), cloud);
  check(`a ${label} cloud row does not destroy local progress`,
    r.prof.shots === 42 && r.prof.kills === 9 && r.prof.ach.firstBlood === '2026-01-01',
    JSON.stringify({ shots: r.prof.shots, kills: r.prof.kills, ach: r.prof.ach }));
}

// 2b. The two defects this suite found on its first run. Both are regression
//     cases now: a non-numeric value used to NaN a real counter (which
//     JSON.stringify writes as null, so the corruption saved locally AND synced
//     back up), and a null inside `modes` threw — aborting cloudBoot() after
//     restore(), so sign-in half-completed and the player looked signed out.
{
  const r = await merge(base({ shots: 42, modes: { duel: { w: 3, l: 1 } }, weapons: { cannon: 9 } }),
    { career: { shots: 'x', modes: { duel: 'nonsense' }, weapons: { cannon: {} } } });
  check('a non-numeric cloud counter cannot NaN a local one',
    r.prof.shots === 42, `shots=${JSON.stringify(r.prof.shots)}`);
  check('a non-numeric cloud mode cannot NaN a local record',
    r.prof.modes.duel.w === 3 && r.prof.modes.duel.l === 1, JSON.stringify(r.prof.modes.duel));
  check('a non-numeric cloud weapon count cannot NaN a local one',
    r.prof.weapons.cannon === 9, `cannon=${JSON.stringify(r.prof.weapons.cannon)}`);
}
{
  let threw = null;
  const r = await merge(base({ shots: 7 }), { career: { modes: { duel: null, ffa: null } } })
    .catch((e) => { threw = e.message; return null; });
  check('a null inside modes does not throw (it used to, aborting sign-in)',
    threw === null && r && r.prof.shots === 7, threw || JSON.stringify(r && r.prof.shots));
}
{
  // A string that would win a `<` comparison must not become the golf record.
  const r = await merge(base({ golfBest: 30 }), { career: { golfBest: '5' } });
  check('a non-numeric golfBest is ignored', r.prof.golfBest === 30, `got ${JSON.stringify(r.prof.golfBest)}`);
}

// 3. Per-mode wins/losses take the max independently.
{
  const r = await merge(base({ modes: { duel: { w: 5, l: 1 }, golf: { w: 0, l: 0 } } }),
    { career: { modes: { duel: { w: 2, l: 8 }, boss: { w: 3, l: 0 } } } });
  check('mode wins keep the higher of the two', r.prof.modes.duel.w === 5, `duel.w=${r.prof.modes.duel.w}`);
  check('mode losses keep the higher of the two', r.prof.modes.duel.l === 8, `duel.l=${r.prof.modes.duel.l}`);
  check('a mode only in the cloud is adopted', r.prof.modes.boss && r.prof.modes.boss.w === 3,
    JSON.stringify(r.prof.modes.boss));
}

// 4. Weapon counters take the max.
{
  const r = await merge(base({ weapons: { cannon: 50, nuke: 1 } }),
    { career: { weapons: { cannon: 10, napalm: 7 } } });
  check('weapon counts take the max', r.prof.weapons.cannon === 50 && r.prof.weapons.napalm === 7,
    JSON.stringify(r.prof.weapons));
}

// 5. golfBest is the ONE field where max would be wrong — lower is better.
{
  const r1 = await merge(base({ golfBest: 40 }), { career: { golfBest: 33 } });
  check('golfBest takes the LOWER score when the cloud is better', r1.prof.golfBest === 33, `got ${r1.prof.golfBest}`);
  const r2 = await merge(base({ golfBest: 30 }), { career: { golfBest: 45 } });
  check('golfBest keeps the local score when it is better', r2.prof.golfBest === 30, `got ${r2.prof.golfBest}`);
  const r3 = await merge(base({ golfBest: null }), { career: { golfBest: 52 } });
  check('golfBest adopts the cloud score when unset locally', r3.prof.golfBest === 52, `got ${r3.prof.golfBest}`);
}

// 6. hordeBest takes the max per key.
{
  const r = await merge(base({ hordeBest: { waves: 4 } }), { career: { hordeBest: { waves: 9, kills: 20 } } });
  check('hordeBest takes the max per key', r.prof.hordeBest.waves === 9 && r.prof.hordeBest.kills === 20,
    JSON.stringify(r.prof.hordeBest));
}

// 7. Achievements union. NOTE the documented claim is "union keeping earlier
//    dates", but the code is `if (!PROF.ach[a])` — so a LOCAL entry always
//    wins, even when the cloud's date is earlier. Pinned here as the ACTUAL
//    behaviour, with the mismatch raised rather than silently blessed.
{
  const r1 = await merge(base({ ach: {} }), { career: { ach: { sniper: '2026-02-01' } } });
  check('an achievement only in the cloud is adopted', r1.prof.ach.sniper === '2026-02-01', JSON.stringify(r1.prof.ach));

  const r2 = await merge(base({ ach: { sniper: '2026-03-09' } }), { career: { ach: { sniper: '2026-01-01' } } });
  check('when both hold an achievement, the LOCAL date wins (not the earlier one)',
    r2.prof.ach.sniper === '2026-03-09', `got ${r2.prof.ach.sniper}`);
}

// 8. The midnight cosmetic unlock crosses over from the cloud.
{
  const r = await merge(base(), { career: {}, loot: { midnight: true } });
  check('a cloud-only cosmetic unlock is adopted', r.midnight === true, `midnight=${r.midnight}`);
}

// ---- done ------------------------------------------------------------------
ws.close();
chrome.kill();
srv.kill();
rmSync(profile, { recursive: true, force: true });
try { execSync(`pkill -f 'cc-merge-${dbgPort}'`, { stdio: 'ignore' }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
