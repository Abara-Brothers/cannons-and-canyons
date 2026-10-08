// Battle tanks are 15% bigger (owner, 2026-10-07: "slightly increase the size
// of the tanks in-game across all game modes ... relayed across areas such as
// the hit box and anything else it would affect"). game-core's TANK_R went
// from the 240 design to 276, and test/hitbox.mjs holds the server's outline,
// muzzle and putt tee to it. This suite holds the CLIENT to the same tank, in
// a real page against a real server, because the client keeps its own copy of
// the size (a classic script cannot import game-core) and every check below is
// a place where a copy left at 240 would show a tank, a shot or a putt that is
// not the one the server plays:
//   1. the page's TANK_R is game-core's own (imported from the page's origin),
//      and tankScreen draws at r = TANK_R x zoom;
//   2. by pixels: the tank drawn on flat ground with its gun straight up is as
//      wide as the hitbox (2 x TANK_HW) and its turret roof stands TANK_TOP high;
//   3. the drawn muzzle tip is game-core's shot origin at six aims;
//   4. the aim line's dots lie on game-core's own path for the shot;
//   5. golf: the putter's pace line starts at game-core's putt tee, on the
//      cup itself when the cup is nearer than the tee;
//   6. the menu picture of the tank (Bay.tankURL) is drawn at its frame's r,
//      the size it always was: the menus did not grow;
//   7. on screen at the opening view, in a duel and in golf, the tank is 15%
//      bigger than build 7 drew it at the same moment.
// Matches are started the way a player starts them (home's Launch, then Start
// Game). Headless Chrome over CDP at 844x390 and deviceScaleFactor 3.
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
if (!existsSync(CHROME)) { console.log(`SKIP  tank_size tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// Every CDP call has a deadline, and so does the whole run, the way
// test/aim_focus.mjs does it: a Chrome or a server that stops answering fails
// the suite loudly and never hangs it. Every way out takes Chrome and the
// server with it, registered before either is spawned.
const CDP_MS = 15000;
const RUN_MS = 150000;
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
let srv = null, chrome = null, prof = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog = setTimeout(() => { console.error(`FAIL tank_size overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

// ---- server ----------------------------------------------------------------
const appPort = await freePort();
srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { console.error('FAIL tank_size: server never came up'); process.exit(1); }

// ---- browser ---------------------------------------------------------------
const dbg = await freePort(); prof = join(tmpdir(), `cc-tanksize-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
if (!wsUrl) { console.error('FAIL tank_size: Chrome never offered a page to drive'); process.exit(1); }
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl);
await Promise.race([new Promise((r) => (ws.onopen = r)), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
// Uncaught page exceptions are collected: a throw inside drawTank or drawAim
// lands in the frame loop's recovery path and would otherwise go unseen.
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
// The size the owner plays at: a 6.1-inch phone in landscape at 3x.
await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: false });

// ---- helpers ---------------------------------------------------------------
const READY = `typeof intent === 'function' && typeof tankScreen === 'function' && !!window.Bay && S.connected === true`;
async function newDocument(what) {
  if (!(await until(`!window.__oldDoc && (${READY})`, 15000, 150))) throw new Error(what + ': the page never came back ready');
}
async function load() {
  await ev('window.__oldDoc = true').catch(() => {});
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await newDocument('load');
  await until(`!!document.querySelector('#bay .lbar')`, 8000);
  await ev(`(window.showToast = () => {}, true)`);
  // game-core, from the page's own origin: the module the server runs, so
  // every expectation below is game-core's answer, never a number copied here.
  await ev(`import('/game-core.js').then((m) => { window.__core = m; return true; })`);
}
async function leave() {
  await ev(`(window.__oldDoc = true, $('leaveYesBtn').click(), true)`);
  await newDocument('leave');
  if (!(await until(`!!document.querySelector('#bay .lbar') && !S.playing`, 8000))) throw new Error('leave: never landed on the bay home');
  await ev(`(window.showToast = () => {}, true)`);
  await ev(`import('/game-core.js').then((m) => { window.__core = m; return true; })`);
}
// Home's Launch, then Match setup's Start Game, the way a player starts one.
// Duel is against the computer; golf is a solo round.
async function launch(mode) {
  await ev(`(() => { ccMode = ${JSON.stringify(mode)}; Bay.show('home'); document.querySelector('#bay .launch').click();
    document.querySelector('#bay .pfoot [data-launch]').click(); return true; })()`);
  if (!(await until(`S.playing === true && S.mode === ${JSON.stringify(mode)} && $('game').classList.contains('active')`, 15000)))
    throw new Error('launch ' + mode + ': no match: ' + JSON.stringify(await ev(`({ playing: S.playing, mode: S.mode })`)));
}
const MY_TURN = `S.playing && S.turn === S.you && !S.anim && !S.killcam && !S.shotSent`;
// Section 7's yardstick, read at the moment of the check: build 7 (1.0.0 (7),
// commit d16463a, the build before update 8 round 2) drew the tank at r = 240
// x zoom, and its camera's zoom target was min(0.32, max(F, aimZoom() x
// userZoom x 1.35 while you aim)), where F, its minMapZoom(), was the
// whole-map fit max(cssW / WW, cssH / (WH x TALL_CAP)) in every mode, golf
// included (git show d16463a:public/app.js: minMapZoom, cameraTarget,
// tankScreen). aimZoom(), AIM_FOCUS_ZOOM and START_ZOOM are unchanged since,
// so build 7's tank at this moment is computed from the page's own. Today's
// r is tankScreen's, which section 1 holds to TANK_R x the camera's zoom.
const BUILD7 = `(() => {
  const F = Math.max(view.cssW / WW(), view.cssH / (WH() * TALL_CAP));
  const z7 = Math.min(0.32, Math.max(F, aimZoom() * S.userZoom * (aimFocusActive() ? AIM_FOCUS_ZOOM : 1)));
  return { mode: S.mode, w: view.cssW, h: view.cssH, uz: S.userZoom, start: START_ZOOM, z: cam.zoom, tz: cameraTarget().tz,
    r: tankScreen(S.you).r, r7: 240 * z7, z7, fit: F, aim: aimZoom(), golfHole: S.golf ? S.golf.hole : null }; })()`;
// The camera eases; the opening view is where it comes to rest.
const SETTLED = `(() => { const t = cameraTarget(); return Math.abs(cam.zoom - t.tz) <= 0.0005 * t.tz; })()`;
// 276 / 240, to within the camera's 0.05% rest.
const GROWN = (o) => Math.abs(o.r / o.r7 - 1.15) <= 0.002;

try {
  await load();

  // ---- 6. the menu picture did NOT grow ---------------------------------------
  // On the home screen, before any match: Bay.tankURL draws the tank by the
  // battle renderer into a frame, and it must still be drawn at the frame's r
  // (cssW x 0.33), not at the battle tank's 15% bigger size. The intro's own
  // measurements of this picture (test/intro.mjs) rest on that.
  const menu = await ev(`(() => { const orig = window.drawTank; let g = null;
    window.drawTank = function (i) { g = { r: tankScreen(i).r }; return orig.apply(this, arguments); };
    try { Bay.tankURL('tank-size-probe', 204); } finally { window.drawTank = orig; }
    return { r: g && g.r, want: 204 * 0.33 }; })()`);
  if (menu.r != null && Math.abs(menu.r - menu.want) < 1e-6) ok(`6: the menu picture is drawn at its frame's r (${menu.r.toFixed(2)} px in a 204 wide frame): the menus did not grow`);
  else fail('6: menu picture r ' + JSON.stringify(menu));

  // ---- 1. one size, the server's ---------------------------------------------
  await launch('duel');
  if (!(await until(MY_TURN, 30000))) throw new Error('duel: the first turn never came round to the player');
  const size = await ev(`(() => { const ts = tankScreen(S.you); return { core: __core.TANK_R, page: TANK_R, r: ts.r, z: cam.zoom, mech: S.boss }; })()`);
  if (size.core === 276 && size.page === size.core) ok(`1: the page draws game-core's battle tank size, TANK_R ${size.page} (the 240 design x 1.15)`);
  else fail('1: TANK_R ' + JSON.stringify(size));
  if (Math.abs(size.r - size.core * size.z) <= 1e-9 * size.r) ok(`1: tankScreen draws at r = TANK_R x zoom (${size.r.toFixed(3)} px at zoom ${size.z.toFixed(5)})`);
  else fail('1: tankScreen r ' + JSON.stringify(size));

  // ---- 7. on screen at the opening view: duel ---------------------------------
  // The duel's camera did not change in round 2, so this is the comparison
  // that shows the yardstick: the opening view, settled, on your first turn.
  if (!(await until(SETTLED, 8000, 60))) throw new Error('duel: the camera never came to rest');
  const duelOpen = await ev(BUILD7);
  if (duelOpen.uz === duelOpen.start && GROWN(duelOpen))
    ok(`7 duel: at the opening view the tank is ${(duelOpen.r / duelOpen.r7).toFixed(4)} x build 7's (r ${duelOpen.r.toFixed(2)} px against ${duelOpen.r7.toFixed(2)}, ${(2 * 1.35 * duelOpen.r).toFixed(1)} px wide against ${(2 * 1.35 * duelOpen.r7).toFixed(1)})`);
  else fail('7 duel: opening tank against build 7 ' + JSON.stringify(duelOpen));

  // ---- 2. by pixels, the drawn tank is the hitbox -----------------------------
  // On ground flattened around the tank (inside this one evaluate, put back
  // before any frame), gun straight up so it adds no width, level, no recoil,
  // no turn marker: the real drawTank on the real 3x canvas. The widest
  // opaque run is the hull's bottom edge (1.35r), which is game-core's
  // TANK_HW; the turret roof, read in a column clear of the hatch, the gun
  // and the antenna, is TANK_TOP. The shadow under the tank is 32% alpha and
  // sits below the 50% threshold.
  const PIXELS = (zoom) => `(() => {
    const me = S.tanks[S.you], a = myAim(), keepA = { ...a }, keepT = S.terrain, keepZ = cam.zoom, keepX = cam.cx, keepY = cam.cy;
    const keepL = S.lean[S.you], keepR = S.recoil[S.you], keepAnim = S.anim;
    const y0 = surfaceAt(me.x), flat = keepT.slice();
    for (let x = Math.max(0, Math.floor(me.x) - 4000); x <= Math.min(flat.length - 1, Math.ceil(me.x) + 4000); x++) flat[x] = y0;
    const W = canvas.width, H = canvas.height, dpr = W / view.cssW;
    const wipe = () => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H); ctx.restore(); };
    let d, ts, front;
    try {
      S.terrain = flat; cam.zoom = ${zoom}; cam.cx = me.x; cam.cy = y0 - 600; S.lean[S.you] = 0; S.recoil[S.you] = 0;
      a.angle = 90; S.anim = { probe: true };
      ts = tankScreen(S.you); front = facingOf(S.you);
      wipe(); drawTank(S.you); d = ctx.getImageData(0, 0, W, H).data;
    } finally {
      S.terrain = keepT; cam.zoom = keepZ; cam.cx = keepX; cam.cy = keepY; S.lean[S.you] = keepL; S.recoil[S.you] = keepR;
      Object.assign(a, keepA); S.anim = keepAnim; wipe();
    }
    const solid = (x, y) => d[(y * W + x) * 4 + 3] >= 128;
    let x0 = W, x1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (solid(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    const col = Math.round((ts.sx + front * 0.1 * ts.r) * dpr), yMin = Math.round((ts.sy - 2 * ts.r) * dpr);
    let top = -1;
    for (let y = Math.max(0, yMin); y < Math.round(ts.sy * dpr); y++) if (solid(col, y)) { top = y; break; }
    return { r: ts.r, z: ${zoom}, width: (x1 - x0 + 1) / dpr, roof: top < 0 ? null : ts.sy - top / dpr,
      hw: __core.TANK_HW, tt: __core.TANK_TOP }; })()`;
  for (const zoom of [0.05, 0.1]) {
    const px = await ev(PIXELS(zoom));
    const wantW = 2 * px.hw * zoom, wantH = px.tt * zoom;
    if (Math.abs(px.width - wantW) <= 1.5) ok(`2 zoom ${zoom}: the drawn tank is ${px.width.toFixed(1)} px wide, the hitbox's 2 x TANK_HW is ${wantW.toFixed(1)} px`);
    else fail(`2 zoom ${zoom}: drawn width against the hitbox ` + JSON.stringify({ ...px, wantW }));
    if (px.roof != null && Math.abs(px.roof - wantH) <= 1.5) ok(`2 zoom ${zoom}: the turret roof stands ${px.roof.toFixed(1)} px high, the hitbox's TANK_TOP is ${wantH.toFixed(1)} px`);
    else fail(`2 zoom ${zoom}: drawn roof against the hitbox ` + JSON.stringify({ ...px, wantH }));
  }

  // ---- 3. the drawn muzzle is where game-core fires from ----------------------
  // Flat ground again, level, no recoil. muzzleTipWorld is the drawn barrel's
  // tip (the muzzle blast comes from it); game-core's shot path starts at its
  // own muzzle. They agree to under a world unit: game-core rounds its three
  // numbers to whole units, the drawing does not.
  const muzzle = await ev(`(() => {
    const me = S.tanks[S.you], a = myAim(), keepA = { ...a }, keepT = S.terrain, keepL = S.lean[S.you], keepR = S.recoil[S.you];
    const y0 = surfaceAt(me.x), flat = keepT.slice();
    for (let x = Math.max(0, Math.floor(me.x) - 4000); x <= Math.min(flat.length - 1, Math.ceil(me.x) + 4000); x++) flat[x] = y0;
    const dir = facingOf(S.you), rows = [];
    try {
      S.terrain = flat; S.lean[S.you] = 0; S.recoil[S.you] = 0;
      for (const ang of [-30, 0, 20, 45, 90, 135]) {
        a.angle = ang;
        const tip = muzzleTipWorld(S.you);
        const shot = __core.simulateShot({ terrain: flat.slice(), tanks: [{ x: me.x, y: y0 }] }, { by: 0, weapon: 'cannon', angle: ang, power: 60, dir });
        const p0 = shot.projectiles[0].path[0];
        rows.push({ ang, tip: [tip.x, tip.y], p0, off: Math.hypot(tip.x - p0[0], tip.y - p0[1]) });
      }
    } finally { S.terrain = keepT; S.lean[S.you] = keepL; S.recoil[S.you] = keepR; Object.assign(a, keepA); }
    return rows; })()`);
  const worst = Math.max(...muzzle.map((m) => m.off));
  if (worst <= 1) ok(`3: the drawn muzzle tip is game-core's shot origin at aims ${muzzle.map((m) => m.ang).join(', ')} (worst ${worst.toFixed(2)} world units apart)`);
  else fail('3: drawn muzzle against the shot origin ' + JSON.stringify(muzzle));

  // ---- 4. the aim line follows game-core's own path ---------------------------
  // drawAim's dots, read off the real canvas calls (each dot is a dark square
  // under a yellow one, or a red one when the shot would hurt you, both
  // centred on it), back into world units. Every one
  // must lie on game-core's path for the same shot from the same tank: the
  // aim line integrates the same physics from its own copy of the muzzle, so a
  // copy left at the old size draws a parallel arc tens of units off. Aims
  // 10 and 25 degrees, where that offset runs across the arc, not along it.
  // On ground flattened 12,000 units around the tank, with the tank on it,
  // and a camera at zoom 0.1 on the tank (all put back in the same evaluate):
  // the real map can stop a flat shot on a hill a few dots out, and at the
  // battle zoom the arc is short on screen, so the line draws only two or
  // three dots (seen on one map in the first full run).
  const arc = await ev(`(() => {
    const me = S.tanks[S.you], a = myAim(), keepA = { ...a }, keepSel = S.selected, keepC = S.charging, out = [];
    const keepT = S.terrain, keepY = me.y, keepZ = cam.zoom, keepX = cam.cx, keepCY = cam.cy;
    const y0 = surfaceAt(me.x), flat = keepT.slice();
    for (let x = Math.max(0, Math.floor(me.x) - 12000); x <= Math.min(flat.length - 1, Math.ceil(me.x) + 12000); x++) flat[x] = y0;
    const dir = facingOf(S.you);
    const segDist = (p, q, r) => { const vx = r[0] - q[0], vy = r[1] - q[1], L = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - q[0]) * vx + (p[1] - q[1]) * vy) / L));
      return Math.hypot(p[0] - q[0] - t * vx, p[1] - q[1] - t * vy); };
    try {
      S.selected = 'cannon'; S.charging = false;
      S.terrain = flat; me.y = y0; cam.zoom = 0.1; cam.cx = me.x; cam.cy = y0 - 600;
      for (const ang of [10, 25]) {
        a.angle = ang; a.power = 60;
        const dots = [];
        ctx.fillRect = function (x, y, w, h) { if (/255,\\s*(214,\\s*70|90,\\s*82)/.test(String(this.fillStyle))) dots.push([x + w / 2, y + h / 2]); return CanvasRenderingContext2D.prototype.fillRect.call(this, x, y, w, h); };
        try { drawAim(); } finally { delete ctx.fillRect; }
        const path = __core.simulateShot({ terrain: flat.slice(), tanks: [{ x: me.x, y: y0 }] }, { by: 0, weapon: 'cannon', angle: ang, power: 60, dir }).projectiles[0].path;
        let worst = 0;
        for (const [sx, sy] of dots) {
          const w = [s2wx(sx), (sy - view.cssH / 2) / cam.zoom + cam.cy];
          let best = Infinity;
          for (let k = 1; k < path.length; k++) best = Math.min(best, segDist(w, path[k - 1], path[k]));
          worst = Math.max(worst, best);
        }
        out.push({ ang, dots: dots.length, worst });
      }
    } finally {
      Object.assign(a, keepA); S.selected = keepSel; S.charging = keepC;
      S.terrain = keepT; me.y = keepY; cam.zoom = keepZ; cam.cx = keepX; cam.cy = keepCY;
    }
    return out; })()`);
  if (arc.every((r) => r.dots >= 4 && r.worst <= 2)) ok(`4: every aim-line dot lies on game-core's path for the shot (${arc.map((r) => r.dots + ' dots at ' + r.ang + ' degrees, worst ' + r.worst.toFixed(2) + ' units').join('; ')})`);
  else fail('4: aim line against game-core\'s path ' + JSON.stringify(arc));
  await leave();

  // ---- 5. golf: the putt starts at game-core's tee ----------------------------
  // The putter's pace line is a row of dots along the turf, the first one 1/22
  // of the way into the shown 60% of the roll, from the point the ball is
  // struck. game-core strikes it PUTT_AHEAD in front of the tank, which grew
  // with the tank (the old 350 is now under the hull).
  await launch('golf');
  if (!(await until(MY_TURN, 20000))) throw new Error('golf: never the player\'s shot');
  const putt = await ev(`(() => {
    const me = S.tanks[S.you], a = myAim(), keepA = { ...a }, keepSel = S.selected, keepC = S.charging, dots = [];
    const dir = facingOf(S.you);
    try {
      S.selected = 'putter'; S.charging = false; a.angle = 30; a.power = 40;
      const w = (S.weapons || []).find((x) => x.id === 'putter');
      ctx.fillRect = function (x, y, ww, h) { if (/255,\\s*214,\\s*70/.test(String(this.fillStyle))) dots.push(x + ww / 2); return CanvasRenderingContext2D.prototype.fillRect.call(this, x, y, ww, h); };
      try { drawAim(); } finally { delete ctx.fillRect; }
      const p0 = __core.simulateShot({ terrain: S.terrain.slice(), tanks: [{ x: me.x, y: me.y }] }, { by: 0, weapon: 'putter', angle: 30, power: 40, dir }).projectiles[0].path[0];
      const v = 40 * 52 * w.speedMul, roll = (v * v) / (2 * 0.05 * 900);
      const want = p0[0] + dir * roll * (1 / 22) * 0.6;
      // With no golf state at all (S.golf null for this one draw) the line
      // still starts at the tee: the cup check must not throw inside drawAim,
      // whose catch would swallow it and draw no line.
      const bare = [], keepG = S.golf;
      ctx.fillRect = function (x, y, ww, h) { if (/255,\\s*214,\\s*70/.test(String(this.fillStyle))) bare.push(x + ww / 2); return CanvasRenderingContext2D.prototype.fillRect.call(this, x, y, ww, h); };
      try { S.golf = null; drawAim(); } finally { S.golf = keepG; delete ctx.fillRect; }
      return { dots: dots.length, first: dots.length ? s2wx(dots[0]) : null, want, tee: p0[0] - me.x, hw: __core.TANK_HW,
        bare: bare.length, bareFirst: bare.length ? s2wx(bare[0]) : null };
    } finally { Object.assign(a, keepA); S.selected = keepSel; S.charging = keepC; } })()`);
  if (putt.dots >= 3 && Math.abs(putt.first - putt.want) <= 1 && Math.abs(putt.tee) > putt.hw)
    ok(`5: the putter's pace line starts at game-core's tee, ${Math.abs(putt.tee)} ahead of the tank and clear of its ${putt.hw} hull edge (first dot ${(putt.first - putt.want).toFixed(2)} units from game-core's)`);
  else fail('5: putt pace line against game-core\'s tee ' + JSON.stringify(putt));
  if (putt.bare >= 3 && Math.abs(putt.bareFirst - putt.want) <= 1) ok('5: with no golf state the pace line still starts at the tee');
  else fail('5: pace line with no golf state ' + JSON.stringify(putt));
  // From a lie nearer the cup than the tee (200 short of it, on the green),
  // game-core strikes the ball on the cup, never past it, so the pace line
  // must start there too. The cup is handed to game-core exactly as
  // room-engine's golfShot hands it (catch r, drop-in speed 2,200). The tank
  // is moved for this one evaluate and put back before any frame.
  const near = await ev(`(() => {
    const me = S.tanks[S.you], a = myAim(), keepA = { ...a }, keepSel = S.selected, keepC = S.charging, keepX = me.x, keepY = me.y, dots = [];
    const dir = facingOf(S.you), cup = S.golf.cup;
    try {
      me.x = cup.x - dir * 200; me.y = surfaceAt(me.x);
      S.selected = 'putter'; S.charging = false; a.angle = 30; a.power = 40;
      const w = (S.weapons || []).find((x) => x.id === 'putter');
      ctx.fillRect = function (x, y, ww, h) { if (/255,\\s*214,\\s*70/.test(String(this.fillStyle))) dots.push(x + ww / 2); return CanvasRenderingContext2D.prototype.fillRect.call(this, x, y, ww, h); };
      try { drawAim(); } finally { delete ctx.fillRect; }
      const shot = (angle) => __core.simulateShot({ terrain: S.terrain.slice(), tanks: [{ x: me.x, y: me.y }], cup: { x: cup.x, r: cup.r, capV: 2200 } }, { by: 0, weapon: 'putter', angle, power: 40, dir });
      const r = shot(30), p0 = r.projectiles[0].path[0];
      const v = 40 * 52 * w.speedMul, roll = (v * v) / (2 * 0.05 * 900);
      // A putt AWAY from the cup (aim past 90) from the same lie is struck
      // PUTT_AHEAD behind the tank, as before: only a cup ahead moves the tee.
      const back = [];
      a.angle = 150;
      ctx.fillRect = function (x, y, ww, h) { if (/255,\\s*214,\\s*70/.test(String(this.fillStyle))) back.push(x + ww / 2); return CanvasRenderingContext2D.prototype.fillRect.call(this, x, y, ww, h); };
      try { drawAim(); } finally { delete ctx.fillRect; }
      const b0 = shot(150).projectiles[0].path[0][0];
      return { dots: dots.length, first: dots.length ? s2wx(dots[0]) : null, want: p0[0] + dir * roll * (1 / 22) * 0.6, p0: p0[0], cup: cup.x,
        holed: !!(r.golf && r.golf.rest && Math.abs(r.golf.rest[0] - cup.x) <= cup.r),
        back: back.length, backFirst: back.length ? s2wx(back[0]) : null, backWant: b0 - dir * roll * (1 / 22) * 0.6, backTee: (b0 - me.x) * dir };
    } finally { me.x = keepX; me.y = keepY; Object.assign(a, keepA); S.selected = keepSel; S.charging = keepC; } })()`);
  if (near.dots >= 3 && Math.abs(near.p0 - near.cup) <= 0.05 && Math.abs(near.first - near.want) <= 1 && near.holed)
    ok(`5: 200 short of the cup the putt is struck on the cup, never past it, and holes; the pace line starts there too (first dot ${(near.first - near.want).toFixed(2)} units from game-core's)`);
  else fail('5: putt from a lie nearer the cup than the tee ' + JSON.stringify(near));
  if (near.back >= 3 && Math.abs(near.backTee + 403) <= 0.05 && Math.abs(near.backFirst - near.backWant) <= 1)
    ok(`5: from the same lie a putt away from the cup is struck 403 behind the tank, and its pace line starts there (first dot ${(near.backFirst - near.backWant).toFixed(2)} units from game-core's)`);
  else fail('5: putt away from the cup from a lie near it ' + JSON.stringify(near));

  // ---- 7. on screen at the opening view: golf ---------------------------------
  // This round's own opening, settled: hole 1 at the zoom it opens on.
  if (!(await until(SETTLED, 8000, 60))) throw new Error('golf: the camera never came to rest');
  const golfOpen = await ev(BUILD7);
  if (golfOpen.uz === golfOpen.start && GROWN(golfOpen))
    ok(`7 golf: at hole ${golfOpen.golfHole}'s opening view the tank is ${(golfOpen.r / golfOpen.r7).toFixed(4)} x build 7's (r ${golfOpen.r.toFixed(2)} px against ${golfOpen.r7.toFixed(2)}, zoom ${golfOpen.z.toFixed(5)}${Math.abs(golfOpen.z - golfOpen.fit) <= 1e-9 ? ', the whole course across the screen' : ', framed by its terrain band'})`);
  else fail('7 golf: opening tank against build 7 ' + JSON.stringify(golfOpen));
  // A short hole opens with the whole course across the screen (golf's
  // aimZoom() frames the course whenever its terrain band is tall enough),
  // and that is where a camera that opens further out shows. Whatever this
  // round's hole 1 is, that opening is made here by giving aimZoom() a band
  // that tall (S.minY, read by nothing else; put back with the camera before
  // any frame), at three phone sizes: 844x390, the 667x375 of the smallest
  // phone, and 932x430. The page is resized for real for each.
  const SHORT = `(() => {
    const keep = { minY: S.minY, z: cam.zoom, cx: cam.cx, cy: cam.cy };
    try {
      S.minY = WH() - 2 * view.cssH / fullZoom();
      snapCamera();
      return { ...${BUILD7}, fz: fullZoom() };
    } finally { S.minY = keep.minY; cam.zoom = keep.z; cam.cx = keep.cx; cam.cy = keep.cy; } })()`;
  for (const [w, h] of [[844, 390], [667, 375], [932, 430]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: false });
    await until(`window.innerWidth === ${w} && window.innerHeight === ${h}`, 4000, 50);
    await ev(`(window.dispatchEvent(new Event('resize')), resize(), true)`);
    await sleep(250);
    const o = await ev(SHORT);
    if (o.uz === o.start && Math.abs(o.z - o.fz) <= 1e-9 * o.fz && GROWN(o))
      ok(`7 golf ${w}x${h}: a short hole opens with the whole course across the screen, as on build 7, and the tank is ${(o.r / o.r7).toFixed(4)} x build 7's (r ${o.r.toFixed(2)} px against ${o.r7.toFixed(2)})`);
    else fail(`7 golf ${w}x${h}: short hole's opening against build 7 ` + JSON.stringify(o));
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: false });
  await until(`window.innerWidth === 844 && window.innerHeight === 390`, 4000, 50);
  await ev(`(window.dispatchEvent(new Event('resize')), resize(), true)`);
} catch (e) {
  fail('tank_size suite stopped: ' + (e && e.message));
}

if (pageErrors.length) fail('page errors during the run: ' + JSON.stringify(pageErrors.slice(0, 5)));
clearTimeout(watchdog);
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall tank_size checks passed');
process.exit(errors.length ? 1 : 0);
