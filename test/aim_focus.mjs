// The aim focus camera and the power cradle (owner, 2026-10-06, "Option E",
// mild), in a real page against a real server. While it is your turn to aim the
// camera eases in by AIM_FOCUS_ZOOM (1.35; Jordan rejected 2.4x as far too
// much), and it eases back out when you fire and stays out on everyone else's
// turn. The 12 px power ring that was drawn across the tank is replaced by a
// cradle: an arc under the tracks, sized off the tank, filling left to right
// with power. Matches are started the way a player starts them (home's Launch,
// then Start Game) against the computer, FIRE is a real press, and the pinch is
// a real two-finger touch on the battlefield. Headless Chrome over CDP at
// 844x390 and deviceScaleFactor 3; skips without Chrome.
//
// WHY THIS EXISTS: nothing else looks at the battle camera. The focus is one
// multiplier behind seven guards, and every guard fails silently somewhere
// else: on the CPU's turn, in the shot's flight, in golf, under reduced motion,
// mid-warp, for a dead or missing tank. And the camera must EASE: a snap on
// every turn change is the jolt this rule must never become.
//
// Self-hosted: spawns its own server on a free port. Exit 3 = SKIP when Chrome
// is absent.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  aim_focus tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// Every CDP call has a deadline, and so does the whole run, the same way
// test/dock.mjs does it: a Chrome or a server that stops answering fails the
// suite loudly and never hangs it. Every way out takes Chrome and the server
// with it, registered before either is spawned.
const CDP_MS = 15000;                                           // one call
const RUN_MS = 200000;                                          // the whole suite
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
let srv = null, chrome = null, prof = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog = setTimeout(() => { console.error(`FAIL aim_focus overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

// ---- server ----------------------------------------------------------------
// The CPU keeps its shipped pace (BOT_FIRE_MS is NOT shortened). A shorter
// wind-up also shortens the server's wait for the replay to finish, so on a
// loaded machine a CPU could fire while this page is still replaying the last
// shot, and its turn would never be seen with no shot in flight.
const appPort = await freePort();
srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { console.error('FAIL aim_focus: server never came up'); process.exit(1); }

// ---- browser ---------------------------------------------------------------
const dbg = await freePort(); prof = join(tmpdir(), `cc-aimfocus-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
if (!wsUrl) { console.error('FAIL aim_focus: Chrome never offered a page to drive'); process.exit(1); }
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl);
await Promise.race([new Promise((r) => (ws.onopen = r)), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
// Uncaught page exceptions are collected: a throw inside the camera or the
// cradle would land in the frame loop's recovery path, which snaps the camera.
const pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    pageErrors.push((d.exception && d.exception.description) || d.text || 'exception');
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    pageErrors.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    return;
  }
  const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  const t = setTimeout(() => { pend.delete(i); rej(new Error(`CDP ${method} gave no answer in ${CDP_MS} ms`)); }, CDP_MS);
  pend.set(i, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };
const until = async (expr, ms, step = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(step); } return ev(expr).catch(() => false); };
await send('Page.enable'); await send('Runtime.enable');
// The cold-start intro, the first-battle coach card and the first-play aim
// demo are all off: each covers the battlefield, and none is under test here.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__ccNoIntro = true;
  try { localStorage.setItem('cc_coach', '1'); localStorage.setItem('cc_aim_guide', '1'); } catch {}` });
// The handover's verification size: a 6.1-inch phone in landscape at 3x.
await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: false });

// ---- helpers ---------------------------------------------------------------
const READY = `typeof intent === 'function' && typeof cameraTarget === 'function' && !!window.Bay && S.connected === true`;
async function newDocument(what) {
  if (!(await until(`!window.__oldDoc && (${READY})`, 15000, 150))) throw new Error(what + ': the page never came back ready');
}
async function load() {
  await ev('window.__oldDoc = true').catch(() => {});
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await newDocument('load');
  await until(`!!document.querySelector('#bay .lbar')`, 8000);
  await ev(`(window.showToast = () => {}, true)`);
}
async function leave() {
  await ev(`(window.__oldDoc = true, $('leaveYesBtn').click(), true)`);
  await newDocument('leave');
  if (!(await until(`!!document.querySelector('#bay .lbar') && !S.playing`, 8000))) throw new Error('leave: never landed on the bay home');
  await ev(`(window.showToast = () => {}, true)`);
}
// Home's Launch, then Match setup's Start Game, the way a player starts one.
// Duel and Free-for-all are against the computer; golf is a solo round.
async function launch(mode) {
  await ev(`(() => { ccMode = ${JSON.stringify(mode)}; Bay.show('home'); document.querySelector('#bay .launch').click();
    document.querySelector('#bay .pfoot [data-launch]').click(); return true; })()`);
  if (!(await until(`S.playing === true && S.mode === ${JSON.stringify(mode)} && $('game').classList.contains('active')`, 15000)))
    throw new Error('launch ' + mode + ': no match: ' + JSON.stringify(await ev(`({ playing: S.playing, mode: S.mode })`)));
}
const MY_TURN = `S.playing && S.turn === S.you && !S.anim && !S.killcam && !S.shotSent`;
const THEIR_TURN = `S.playing && S.turn !== S.you && !S.anim && !S.killcam`;
// The camera's two possible targets, from the formula the handover gives, so
// no check leans on the guards it is checking: unfocused is aimZoom() x the
// player's own zoom, clamped; focused multiplies by AIM_FOCUS_ZOOM BEFORE the
// clamp. Read at the moment of the check, because tank positions move them.
const TZ = `((focused) => Math.min(0.32, Math.max(minMapZoom(), aimZoom() * S.userZoom * (focused ? 1.35 : 1))))`;
const near = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-12);
// Let the camera's own easing run until it rests on its target.
const settle = (ms = 4000) => until(`(() => { const t = cameraTarget(); return Math.abs(cam.zoom - t.tz) <= 0.004 * t.tz; })()`, ms, 60);

// A per-frame log of the camera, registered after the frame loop's own
// requestAnimationFrame, so every row reads the zoom that frame's
// updateCamera() has just eased. Rows: t, zoom, the camera's own target,
// focus, seats, anim, killcam, and the two formula targets of that frame.
const LOG_ON = `(() => { window.__camLog = []; window.__logOn = true;
  const tick = () => { if (!window.__logOn) return;
    const tz = ${TZ};
    __camLog.push({ t: performance.now(), z: cam.zoom, tz: cameraTarget().tz, f: aimFocusActive(), me: S.you, turn: S.turn, anim: !!S.anim, kc: !!S.killcam, on: tz(true), off: tz(false) });
    if (__camLog.length > 4000) __camLog.shift();
    requestAnimationFrame(tick); };
  requestAnimationFrame(tick); return true; })()`;
const LOG_OFF = `(() => { window.__logOn = false; return window.__camLog; })()`;

// EASING, read off a log: from the frame the focus flips, the zoom must walk to
// its new target over many frames, never land in one. updateCamera() moves a
// fraction 1 - e^(-4 dt) of the gap per frame, with dt capped at 50 ms, so no
// single frame can cover more than about 18% of it; a snap covers 100%.
function easing(log, from, to) {
  const i = log.findIndex((r, k) => k > 0 && log[k - 1].f === from && r.f === to);
  if (i < 0) return { found: false };
  const z0 = log[i - 1].z, target = to ? log[i].on : log[i].off;
  const gap = target - z0;
  const first = (log[i].z - z0) / gap;                       // share of the gap covered by the first frame
  let k75 = -1, kRest = -1;
  for (let k = i; k < log.length && log[k].f === to; k++) {
    const done = (log[k].z - z0) / gap;
    if (k75 < 0 && done >= 0.75) k75 = k - i + 1;
    if (kRest < 0 && Math.abs(log[k].z - (to ? log[k].on : log[k].off)) <= 0.03 * Math.abs(gap)) kRest = k - i + 1;
  }
  return { found: true, z0, target, gapRel: gap / z0, first: +first.toFixed(3), k75, kRest, sameDir: Math.sign(log[i].z - z0) === Math.sign(gap) };
}

try {
  await load();

  // ---- 1. duel, your turn: the camera is 1.35x in, and only the zoom moved ----
  // The opening zoom (START_ZOOM, 0.62x the fit-all view): the focus is on,
  // and every opponent is still on screen. At this zoom the survey blend is
  // fully on, so the focus only tightens the frame around the whole battle.
  // A MAP WHERE THE FACTOR CAN SHOW. The check below tells the focused target
  // from the unfocused one, so it proves the focus only where the two differ.
  // On about one duel map in 200 they do not: the spawns stand 6.7k or more
  // world units apart vertically (seed 119641, volcanic, tanks at y 476 and
  // 7753), aimZoom() x 0.62 x 1.35 is already under the whole-map floor, and
  // both targets clamp to minMapZoom(). A camera with no focus at all passes
  // there, and the strict on > off failed the suite for the map, not the
  // code. So such a map is left for a fresh one. The test's own formula
  // decides, never the camera under test, and a run whose every map clamps
  // fails: that is a broken aimZoom(), not luck (one in 200^6 by chance).
  const ROLLS = 6;
  let open = null;
  for (let roll = 1; ; roll++) {
    if (roll > 1) await leave();
    await launch('duel');
    if (!(await until(MY_TURN, 30000))) throw new Error('duel: the first turn never came round to the player');
    await settle();
    open = await ev(`(() => { const t = cameraTarget(), tz = ${TZ};
      const opp = []; for (let i = 0; i < S.n; i++) if (i !== S.you && S.alive[i] !== false && S.tanks[i]) opp.push(wx2s(S.tanks[i].x));
      return { focus: aimFocusActive(), tz: t.tz, on: tz(true), off: tz(false), floor: minMapZoom(), z: cam.zoom, uz: S.userZoom, start: START_ZOOM, opp, w: view.cssW }; })()`);
    if (open.on > open.off && !near(open.on, open.off)) break;
    if (roll >= ROLLS) throw new Error(`duel: all ${ROLLS} maps clamp both opening targets to the whole-map floor ` + JSON.stringify(open));
    console.log(`  .. 1: map ${roll} clamps both opening targets to the whole-map floor (${open.on.toFixed(6)} = ${open.off.toFixed(6)}), so the factor cannot show on it; launching another`);
  }
  if (open.focus && open.uz === open.start && near(open.tz, open.on) && open.on > open.off)
    ok(`1: on your turn at the opening zoom the focus is on and the target is aimZoom x ${open.start} x 1.35, clamped (${open.on.toFixed(5)} against ${open.off.toFixed(5)} unfocused)`);
  else fail('1: opening zoom target ' + JSON.stringify(open));
  if (open.opp.length && open.opp.every((sx) => sx >= 0 && sx <= open.w)) ok('1: at the opening zoom, eased in, every opponent is still on screen');
  else fail('1: opponent off screen at the opening zoom ' + JSON.stringify(open));
  // At the fit-all zoom (userZoom 1) neither target is clamped, so the factor
  // shows exactly. The focus scales the zoom target ONLY: the whole target
  // equals the unfocused target at 1.35x the player's own zoom, centre
  // included, so nothing recentres by hand.
  await ev(`(S.userZoom = 1, true)`);
  await settle();
  const fit = await ev(`(() => { const t = cameraTarget(), tz = ${TZ};
    const a = S.anim; S.anim = { probe: true }; const k = S.userZoom; S.userZoom = k * 1.35;
    let same; try { same = cameraTarget(); } finally { S.anim = a; S.userZoom = k; }
    const ts = tankScreen(S.you);
    const opp = []; for (let i = 0; i < S.n; i++) if (i !== S.you && S.alive[i] !== false && S.tanks[i]) opp.push({ i, sx: wx2s(S.tanks[i].x) });
    // The existing edge marker answers for an opponent pushed off screen: its
    // distance label is what drawEdgeIndicators() writes for each one.
    const labels = []; const ft = ctx.fillText; ctx.fillText = function (s, ...r) { labels.push(String(s)); return ft.call(this, s, ...r); };
    try { drawEdgeIndicators(); } finally { delete ctx.fillText; }
    return { focus: aimFocusActive(), t, same, on: tz(true), off: tz(false), z: cam.zoom, r: ts.r, rOff: 240 * tz(false), opp, labels, w: view.cssW }; })()`);
  if (fit.focus && near(fit.t.tz, fit.on) && near(fit.t.tz / fit.off, 1.35, 1e-9)) ok(`1: at the fit-all zoom the focused target is exactly 1.35x the unfocused one (${fit.t.tz.toFixed(5)} / ${fit.off.toFixed(5)})`);
  else fail('1: fit zoom factor ' + JSON.stringify(fit));
  if (near(fit.t.tz, fit.same.tz) && near(fit.t.tx, fit.same.tx) && near(fit.t.ty, fit.same.ty))
    ok('1: the focus scales the zoom target only: the whole target (zoom and centre) equals the unfocused one at 1.35x your zoom, so the survey blend does the framing');
  else fail('1: focus moved more than the zoom ' + JSON.stringify({ t: fit.t, same: fit.same }));
  if (near(fit.r / fit.rOff, 1.35, 0.01)) ok(`1: eased in, your tank is drawn 1.35x bigger (r ${fit.r.toFixed(2)} px against ${fit.rOff.toFixed(2)} unfocused)`);
  else fail('1: tank size on your turn ' + JSON.stringify(fit));
  const offOpp = fit.opp.filter((o) => o.sx < -10 || o.sx > fit.w + 10);
  if (fit.opp.length > 0 && fit.labels.length === offOpp.length)
    ok(`1: every opponent is on screen or shown by the edge marker (${offOpp.length ? offOpp.length + ' by the marker' : 'all on screen'})`);
  else fail('1: an opponent is off screen with no marker ' + JSON.stringify(fit));

  // ---- 2. FIRE eases out, the CPU's turn has no focus, your next turn eases in --
  await ev(LOG_ON);
  await sleep(400);                      // some settled frames before the press
  await ev(`(() => { const b = $('fireBtn'); if (b.disabled) throw new Error('FIRE is disabled on your turn'); b.click(); return true; })()`);
  const theirs = await until(THEIR_TURN, 20000, 50);
  // Rest on the CPU's turn long enough to read it settled, then wait for yours.
  await sleep(300);
  const back = theirs && await until(MY_TURN, 30000, 50);
  await sleep(2600);
  const log = await ev(LOG_OFF);
  const out = easing(log, true, false), inn = easing(log, false, true);
  if (out.found && out.sameDir && out.gapRel < -0.2 && out.first > 0 && out.first <= 0.3 && out.k75 >= 5 && out.kRest > 0)
    ok(`2: after FIRE the camera eases back out: the first frame covers ${(out.first * 100).toFixed(1)}% of the way, 75% takes ${out.k75} frames, and it comes to rest on the unfocused target`);
  else fail('2: easing out after FIRE ' + JSON.stringify({ out, theirs, back, n: log.length }));
  const cpuRows = log.filter((r) => r.turn !== r.me && !r.anim);
  const cpuFocus = cpuRows.filter((r) => r.f);
  const cpuOff = cpuRows.filter((r) => near(r.tz, r.off));
  const lastCpu = cpuRows[cpuRows.length - 1];
  if (cpuRows.length > 10 && cpuFocus.length === 0 && lastCpu && Math.abs(lastCpu.z - lastCpu.off) <= 0.03 * lastCpu.off && cpuOff.length === cpuRows.length)
    ok(`2: on the CPU's turn there is no focus zoom on any of ${cpuRows.length} frames, and the camera rests on the unfocused target`);
  else fail('2: CPU turn ' + JSON.stringify({ rows: cpuRows.length, focus: cpuFocus.length, lastCpu }));
  if (back && inn.found && inn.sameDir && inn.gapRel > 0.2 && inn.first > 0 && inn.first <= 0.3 && inn.k75 >= 5 && inn.kRest > 0)
    ok(`2: when your turn comes back the camera eases in, never snaps: the first frame covers ${(inn.first * 100).toFixed(1)}% of the way, 75% takes ${inn.k75} frames, and it rests on the 1.35x target`);
  else fail('2: easing in on your turn ' + JSON.stringify({ inn, back, n: log.length }));
  const rows = log.filter((r) => !r.kc);
  const wrong = rows.filter((r) => r.f !== (r.turn === r.me && !r.anim) || !near(r.tz, r.f ? r.on : r.off));
  if (rows.length > 50 && wrong.length === 0) ok(`2: across the whole cycle (${rows.length} frames) the focus is on exactly when it is your turn and no shot is in flight, and the camera's target is the matching one`);
  else fail('2: focus on the wrong frames ' + JSON.stringify(wrong.slice(0, 4)));

  // ---- 3. every guard ---------------------------------------------------------
  // Each guard is flipped and put back inside one synchronous evaluate, so no
  // frame ever runs with the probe state.
  if (!(await until(MY_TURN, 20000))) throw new Error('section 3: not your turn');
  const guards = await ev(`(() => { const tz = ${TZ}; const out = {};
    // With no tank of your own cameraTarget() has nothing to frame (seat 0's
    // tank stands in, and there is none when you are seat 0), so that probe
    // reads the guard alone.
    const probe = (name, set, undo, guardOnly) => { set(); try { out[name] = guardOnly ? { f: aimFocusActive() } : { f: aimFocusActive(), tz: cameraTarget().tz, off: tz(false), on: tz(true) }; } finally { undo(); } };
    probe('base', () => {}, () => {});
    let k;
    probe('notYourTurn', () => { k = S.turn; S.turn = (S.you + 1) % S.n; }, () => { S.turn = k; });
    probe('shotInFlight', () => { k = S.anim; S.anim = { probe: true }; }, () => { S.anim = k; });
    probe('notPlaying', () => { k = S.playing; S.playing = false; }, () => { S.playing = k; });
    probe('golf', () => { k = S.mode; S.mode = 'golf'; }, () => { S.mode = k; });
    probe('dead', () => { k = S.alive[S.you]; S.alive[S.you] = false; }, () => { S.alive[S.you] = k; });
    probe('noTank', () => { k = S.tanks[S.you]; S.tanks[S.you] = undefined; }, () => { S.tanks[S.you] = k; }, true);
    probe('reducedMotion', () => { k = MOTION_OK; MOTION_OK = false; }, () => { MOTION_OK = k; });
    probe('midWarp', () => { k = S.warp; S.warp = { seat: S.you, t: 0.2, dur: 1 }; }, () => { S.warp = k; });
    probe('warpDone', () => { k = S.warp; S.warp = { seat: S.you, t: 1, dur: 1 }; }, () => { S.warp = k; });
    probe('otherWarp', () => { k = S.warp; S.warp = { seat: (S.you + 1) % S.n, t: 0.2, dur: 1 }; }, () => { S.warp = k; });
    return out; })()`);
  const want = { base: true, notYourTurn: false, shotInFlight: false, notPlaying: false, golf: false, dead: false, noTank: false, reducedMotion: false, midWarp: false, warpDone: true, otherWarp: true };
  for (const [name, on] of Object.entries(want)) {
    const g = guards[name];
    if (name === 'golf' || name === 'noTank') {
      // aimZoom() itself changes in golf, and with no tank of your own the
      // frame centres on seat 0, so only the guard's answer is compared here.
      if (g && g.f === on) ok(`3: ${name}: aimFocusActive() is ${on}`); else fail(`3: ${name} ` + JSON.stringify(g));
      continue;
    }
    if (g && g.f === on && near(g.tz, on ? g.on : g.off)) ok(`3: ${name}: aimFocusActive() is ${on} and the camera target is the ${on ? 'focused' : 'unfocused'} one`);
    else fail(`3: ${name} ` + JSON.stringify(g));
  }

  // ---- 4. the player's own zoom still multiplies; the cap and the killcam win --
  // A real two-finger pinch on the battlefield while aiming, spread to double
  // the distance about a fixed centre: the player's zoom doubles, and the
  // focus multiplies on top of it.
  await ev(`(S.userZoom = START_ZOOM, S.panX = 0, S.panY = 0, true)`);
  const cvs = await ev(`(() => { const b = canvas.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  const pts = (d) => [{ x: cvs.x - d, y: cvs.y, id: 1 }, { x: cvs.x + d, y: cvs.y, id: 2 }];
  const uz0 = await ev(`S.userZoom`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(60) });
  for (const d of [75, 90, 105, 120]) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const pinch = await ev(`(() => { const tz = ${TZ}; return { uz: S.userZoom, f: aimFocusActive(), tz: cameraTarget().tz, on: tz(true), panX: S.panX, panY: S.panY }; })()`);
  if (near(pinch.uz / uz0, 2, 0.02) && pinch.f && near(pinch.tz, pinch.on))
    ok(`4: a real pinch while aiming doubles your zoom (${uz0} -> ${pinch.uz.toFixed(3)}) and the focus multiplies on top of it`);
  else fail('4: pinch while aiming ' + JSON.stringify({ uz0, pinch }));
  // THE CLAMP STILL BINDS: the focus multiplies BEFORE it, so it can never take
  // the camera past the 0.32 cap, nor lift it off the whole-map floor. A zoom
  // 20% past the point where the focused target meets each bound is used; on a
  // map whose tanks stand close the cap is inside the pinch's own 6x.
  const bounds = await ev(`(() => { const k = S.userZoom, base = aimZoom(); const r = { f: aimFocusActive(), floor: minMapZoom() };
    try {
      S.userZoom = 1.2 * 0.32 / (base * 1.35); r.cap = cameraTarget().tz;
      S.userZoom = 0.8 * minMapZoom() / (base * 1.35); r.low = cameraTarget().tz;
    } finally { S.userZoom = k; }
    return r; })()`);
  if (bounds.f && bounds.cap === 0.32 && bounds.low === bounds.floor)
    ok(`4: the focus is applied before the clamp: pinched far in it stops at the 0.32 cap, and pinched far out it rests on the whole-map floor (${bounds.floor.toFixed(5)}), not 1.35x past either`);
  else fail('4: clamp ' + JSON.stringify(bounds));
  // THE KILLCAM STILL WINS: at full mix its frame is the killcam's own, with or
  // without the focus under it, and half-way it blends from the focused target.
  const kc = await ev(`(() => { const me = S.tanks[S.you]; const tz = ${TZ};
    const kz = Math.min(0.30, Math.max(minMapZoom(), aimZoom() * KC.zoom)); const on = tz(true);
    const k = S.killcam; const r = {};
    try {
      S.killcam = { seat: S.you, pi: 0, x: me.x, y: me.y, phase: 'slow', t: 0, pt: 0, mix: 1 }; r.full = cameraTarget().tz;
      S.killcam.mix = 0.5; r.half = cameraTarget().tz;
    } finally { S.killcam = k; }
    return { ...r, kz, on, f: aimFocusActive() }; })()`);
  if (kc.f && near(kc.full, kc.kz) && near(kc.half, kc.on + (kc.kz - kc.on) * 0.5))
    ok('4: the killcam still wins: at full mix the zoom is the killcam\'s own, and half-way it blends from the focused target');
  else fail('4: killcam ' + JSON.stringify(kc));

  // ---- 5. the power cradle ----------------------------------------------------
  // Every arc drawAim() strokes, read at stroke time. Two zooms: a close one
  // where the cradle is 1.9r, and the opening zoom where r is small and the
  // 16 px floor holds. The trajectory dots are fillRects and the tether a line,
  // so the only stroked arcs are the cradle's.
  const CRADLE = (power, zoom) => `(() => {
    const keep = { zoom: cam.zoom, cx: cam.cx, cy: cam.cy, power: myAim().power, charging: S.charging };
    const arcs = []; let cur = null; const P = CanvasRenderingContext2D.prototype;
    ctx.beginPath = function () { cur = []; return P.beginPath.call(this); };
    ctx.arc = function (...a) { if (cur) cur.push(a); return P.arc.apply(this, a); };
    ctx.stroke = function () { if (cur && cur.length) arcs.push({ a: cur.map((x) => x.slice()), style: this.strokeStyle, lw: this.lineWidth, cap: this.lineCap }); return P.stroke.call(this); };
    let ts, col;
    try {
      cam.zoom = ${zoom}; cam.cx = S.tanks[S.you].x; cam.cy = S.tanks[S.you].y - 600; myAim().power = ${power}; S.charging = false;
      ts = tankScreen(S.you); const pct = ${power} / 100;
      col = pct < 0.5 ? lerpColor([76, 232, 143], [255, 210, 63], pct / 0.5) : lerpColor([255, 210, 63], [255, 90, 82], (pct - 0.5) / 0.5);
      ctx.save(); ctx.strokeStyle = col; col = ctx.strokeStyle; ctx.restore();   // the canvas's own spelling of it
      drawAim();
    } finally { delete ctx.beginPath; delete ctx.arc; delete ctx.stroke; Object.assign(cam, { zoom: keep.zoom, cx: keep.cx, cy: keep.cy }); myAim().power = keep.power; S.charging = keep.charging; }
    return { ts, col, arcs }; })()`;
  const PI = Math.PI, S0 = PI * 0.86, E0 = PI * 0.14;
  const at = (c, ang) => [c[0] + c[2] * Math.cos(ang), c[1] + c[2] * Math.sin(ang)];
  for (const [label, zoom] of [['close zoom (r 24 px)', 0.1], ['far zoom (r 4.4 px, the 16 px floor)', 0.0185]]) {
    const runs = {};
    for (const p of [20, 60, 100]) runs[p] = await ev(CRADLE(p, zoom));
    const { ts } = runs[60];
    const cR = Math.max(16, 1.9 * ts.r), ccy = ts.sy - 0.55 * ts.r;
    const shape = Object.values(runs).every((run) => run.arcs.length === 2 && run.arcs.every((s) => s.a.length === 1
      && near(s.a[0][0], ts.sx) && near(s.a[0][1], ccy) && near(s.a[0][2], cR) && near(s.lw, 3.2, 1e-6) && s.cap === 'round'));
    if (shape) ok(`5 ${label}: the cradle is two round-capped 3.2 px arcs on one circle, centred under the tank at (sx, sy - 0.55r), radius max(16, 1.9r) = ${cR.toFixed(2)} px (r ${ts.r.toFixed(2)})`);
    else fail(`5 ${label}: cradle shape ` + JSON.stringify({ ts, cR, ccy, arcs: runs[60].arcs }));
    const track = runs[60].arcs[0], fill = runs[60].arcs[1];
    if (track && near(track.a[0][3], E0) && near(track.a[0][4], S0) && !track.a[0][5] && /rgba\(255, 255, 255, 0\.2\)/.test(track.style))
      ok(`5 ${label}: the faint track runs clockwise from 0.14 pi to 0.86 pi, under the tank, in white at 20%`);
    else fail(`5 ${label}: track arc ` + JSON.stringify(track));
    // Fills left to right: from the left end, anticlockwise, an extent in
    // proportion to power, in the power colour; its far end moves right as the
    // power rises and reaches the right end at 100.
    const ends = {};
    let fillOk = true;
    for (const p of [20, 60, 100]) {
      const f = runs[p].arcs[1]; if (!f) { fillOk = false; continue; }
      const [, , , s, e, acw] = f.a[0];
      if (!(near(s, S0) && near(e, S0 - (S0 - E0) * p / 100) && acw === true && f.style === runs[p].col)) fillOk = false;
      ends[p] = at([ts.sx, ccy, cR], e)[0];
    }
    if (fillOk && ends[20] < ends[60] && ends[60] < ends[100] && near(ends[100], at([ts.sx, ccy, cR], E0)[0]) && ends[20] < ts.sx)
      ok(`5 ${label}: the power fill starts at the left end and grows to the right with power (end x ${ends[20].toFixed(1)}, ${ends[60].toFixed(1)}, ${ends[100].toFixed(1)}), in the power colour`);
    else fail(`5 ${label}: fill ` + JSON.stringify({ ends, fill, cols: [runs[20].col, runs[60].col, runs[100].col] }));
    // Never across the tank (geometry, flat ground): both ends sit outside the
    // hull's +/-1.35r, and every point of the stroke that is inside the hull's
    // width lies below the tracks' bottom edge (sy + 0.10r: the tracks reach
    // sy + 0.52r and drawTank lifts the tank by 0.42r).
    const half = 3.2 / 2;
    const L = at([ts.sx, ccy, cR], S0), R = at([ts.sx, ccy, cR], E0);
    let clear = Math.min(Math.abs(L[0] - ts.sx), Math.abs(R[0] - ts.sx)) - half > 1.35 * ts.r;
    for (let k = 0; k <= 200; k++) {
      const [x, y] = at([ts.sx, ccy, cR], E0 + (S0 - E0) * k / 200);
      if (Math.abs(x - ts.sx) <= 1.35 * ts.r + half && y - half <= ts.sy + 0.10 * ts.r) clear = false;
    }
    if (clear) ok(`5 ${label}: by geometry the cradle never crosses the tank: its ends are ${((Math.abs(R[0] - ts.sx)) / ts.r).toFixed(2)}r out against the hull's 1.35r, and under the hull it stays below the tracks`);
    else fail(`5 ${label}: cradle geometry ` + JSON.stringify({ ts, L, R, cR, ccy }));
  }
  // …and by pixels: on ground flattened around the tank (inside this one
  // evaluate, put back before any frame), the tank drawn alone and the cradle
  // drawn alone share no pixel. The real drawTank, the real drawAim, the real
  // canvas at 3x; drawAim's fills and text are muted so only its strokes land.
  const PIXELS = (zoom) => `(() => {
    const me = S.tanks[S.you], keepT = S.terrain, keepZ = cam.zoom, keepX = cam.cx, keepY = cam.cy, keepL = S.lean[S.you], keepP = myAim().power, keepC = S.charging;
    const y0 = surfaceAt(me.x), flat = keepT.slice();
    for (let x = Math.max(0, Math.floor(me.x) - 4000); x <= Math.min(flat.length - 1, Math.ceil(me.x) + 4000); x++) flat[x] = y0;
    const W = canvas.width, H = canvas.height; const P = CanvasRenderingContext2D.prototype;
    const wipe = () => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.restore(); };
    const mask = () => { const d = ctx.getImageData(0, 0, W, H).data; const m = new Uint8Array(W * H); for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 0 ? 1 : 0; return m; };
    let tank, cradle, ts;
    try {
      S.terrain = flat; cam.zoom = ${zoom}; cam.cx = me.x; cam.cy = y0 - 600; S.lean[S.you] = 0; myAim().power = 100; S.charging = false;
      ts = tankScreen(S.you);
      wipe(); drawTank(S.you); tank = mask();
      wipe(); ctx.fillRect = () => {}; ctx.fill = () => {}; ctx.fillText = () => {};
      try { drawAim(); } finally { delete ctx.fillRect; delete ctx.fill; delete ctx.fillText; }
      cradle = mask();
    } finally { S.terrain = keepT; cam.zoom = keepZ; cam.cx = keepX; cam.cy = keepY; S.lean[S.you] = keepL; myAim().power = keepP; S.charging = keepC; wipe(); }
    let both = 0, nT = 0, nC = 0;
    for (let i = 0; i < tank.length; i++) { nT += tank[i]; nC += cradle[i]; if (tank[i] && cradle[i]) both++; }
    return { both, nT, nC, r: ts.r }; })()`;
  for (const [label, zoom] of [['far zoom', 0.0185], ['mid zoom', 0.042], ['close zoom', 0.1]]) {
    const px = await ev(PIXELS(zoom));
    if (px.nT > 50 && px.nC > 50 && px.both === 0) ok(`5 ${label} (r ${px.r.toFixed(1)} px): by pixels, the tank (${px.nT} px) and the cradle (${px.nC} px) share no pixel`);
    else fail(`5 ${label}: pixel overlap ` + JSON.stringify(px));
  }
  // The red self-damage warning is untouched: on ground flattened around the
  // tank (put back in the same evaluate), aimed 60 degrees down, the muzzle is
  // buried and the trajectory squares are drawn red.
  const red = await ev(`(() => { const a = myAim(), keep = { ...a }, keepT = S.terrain, me = S.tanks[S.you]; const fills = [];
    const y0 = surfaceAt(me.x), flat = keepT.slice();
    for (let x = Math.max(0, Math.floor(me.x) - 4000); x <= Math.min(flat.length - 1, Math.ceil(me.x) + 4000); x++) flat[x] = y0;
    ctx.fillRect = function (...r) { fills.push(this.fillStyle); return CanvasRenderingContext2D.prototype.fillRect.apply(this, r); };
    try { S.terrain = flat; a.angle = -60; a.power = 60; drawAim(); } finally { delete ctx.fillRect; Object.assign(a, keep); S.terrain = keepT; }
    return { red: fills.filter((s) => /255, 90, 82|#ff5a52/i.test(s)).length, all: fills.length }; })()`);
  if (red.red > 0) ok(`5: aimed into the ground, the arc still warns in red (${red.red} red squares)`);
  else fail('5: red self-damage arc ' + JSON.stringify(red));

  // ---- 6. reduced motion: no focus zoom --------------------------------------
  // The operating system's setting, as the page sees it: the media query's own
  // change event clears MOTION_OK.
  await ev(`(S.userZoom = 1, true)`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const rmOn = await until(`MOTION_OK === false`, 3000, 50);
  await settle();
  const rm = await ev(`(() => { const tz = ${TZ}; return { mine: S.turn === S.you && !S.anim, f: aimFocusActive(), tz: cameraTarget().tz, z: cam.zoom, off: tz(false) }; })()`);
  if (rmOn && rm.mine && !rm.f && near(rm.tz, rm.off) && Math.abs(rm.z - rm.off) <= 0.005 * rm.off)
    ok('6: with reduced motion on, your turn has no focus zoom: the camera rests on the unfocused target');
  else fail('6: reduced motion ' + JSON.stringify({ rmOn, rm }));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const rmOff = await until(`MOTION_OK === true && aimFocusActive()`, 3000, 50);
  if (rmOff) ok('6: with reduced motion off again, the focus comes back on your turn'); else fail('6: focus did not come back after reduced motion');
  await leave();

  // ---- 7. free-for-all with four tanks: the focus is yours alone -------------
  await launch('ffa');
  if (!(await until(`S.n === 4 && ${MY_TURN}`, 30000))) throw new Error('ffa: no four-tank match on the player\'s turn: ' + JSON.stringify(await ev(`({ n: S.n, turn: S.turn, you: S.you })`)));
  await ev(`(S.userZoom = 1, true)`);
  await settle();
  await ev(LOG_ON);
  await sleep(400);
  await ev(`($('fireBtn').click(), true)`);
  const cycled = await until(`S.turn !== S.you`, 20000, 50) && await until(MY_TURN, 60000, 100);
  await sleep(1500);
  const flog = await ev(LOG_OFF);
  // Every seat's turn is in the log. A CPU that fires the moment its turn
  // opens may never be seen with no shot in flight, so any row counts.
  const seen = [...new Set(flog.map((r) => r.turn))];
  const ffaWrong = flog.filter((r) => !r.kc && (r.f !== (r.turn === r.me && !r.anim) || !near(r.tz, r.f ? r.on : r.off)));
  const cpuFocused = flog.filter((r) => r.turn !== r.me && r.f);
  const restMine = flog[flog.length - 1];
  if (cycled && seen.length === 4 && ffaWrong.length === 0 && cpuFocused.length === 0 && restMine.f && Math.abs(restMine.z - restMine.on) <= 0.03 * restMine.on)
    ok(`7: in a four-tank free-for-all the focus is on only on your own turn: none on ${seen.length - 1} CPU turns, eased in again on yours`);
  else fail('7: ffa ' + JSON.stringify({ cycled, seen, wrong: ffaWrong.slice(0, 3), cpuFocused: cpuFocused.length, restMine }));
  await leave();

  // ---- 8. golf: the camera is exactly as it was -------------------------------
  await launch('golf');
  if (!(await until(MY_TURN, 20000))) throw new Error('golf: never the player\'s shot');
  const golf = [];
  for (const uz of [null, 1]) {
    if (uz) await ev(`(S.userZoom = ${uz}, true)`);
    await settle();
    golf.push(await ev(`(() => { const tz = ${TZ}; return { uz: S.userZoom, f: aimFocusActive(), tz: cameraTarget().tz, z: cam.zoom, off: tz(false) }; })()`));
  }
  if (golf.every((g) => !g.f && near(g.tz, g.off) && Math.abs(g.z - g.off) <= 0.005 * g.off))
    ok('8: on your golf shot there is no focus zoom, at the opening zoom and at the fit zoom: the golf camera is unchanged');
  else fail('8: golf ' + JSON.stringify(golf));
} catch (e) {
  fail('aim_focus suite stopped: ' + (e && e.message));
}

if (pageErrors.length) fail('page errors during the run: ' + JSON.stringify(pageErrors.slice(0, 5)));
clearTimeout(watchdog);
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall aim_focus checks passed');
process.exit(errors.length ? 1 : 0);
