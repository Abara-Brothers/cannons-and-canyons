// Artillery Golf: OUT OF BOUNDS made obvious (owner, 2026-10-07, update 8 item
// 20: "white OB stakes + dashed line at both ends, the ground beyond darkened,
// striped and labelled OUT OF BOUNDS, and a clear banner when the ball goes
// out", penalty unchanged). In a real page, on a local solo round:
//   1. the engine's own limit on this hole, found by firing straight up from
//      just inside and just outside each end;
//   2. the drawn boundary at both ends at six zooms: the dashed line on that
//      limit, the darkened, striped strip from the line to the screen edge
//      with ground under it, the stake on the line, the label in the strip at
//      a legible size; an end out of view draws nothing, and no other mode
//      draws any of it or any ground past the map;
//   3. the drawing against the rule, stroke by stroke: of hundreds of real
//      game-core strokes off both ends, every one the engine rules out ends
//      past the drawn line, and no other ever reaches it;
//   4. the camera: zoomed out, a short hole shows both strips whole; at battle
//      zoom either strip can be framed whole and never more; no other mode
//      looks past the map;
//   5. the banner: a real out-of-bounds stroke raises it in the note's own
//      words and colour, instead of the floater; a real in-bounds stroke never
//      does; another player's ball and a picked-up ball are said so, names
//      as text; a new snapshot clears it;
//   6. legibility at 667x375, 812x375, 874x402 with the iPhone 17 safe areas
//      and 932x430: the labels and the banner whole on screen, clear of the
//      buttons and the dock, at legible sizes and contrast.
// Headless Chrome over CDP; skips without Chrome.
//
// WHY THIS EXISTS: the boundary is a rule drawn as a picture. A line a few
// units off the engine's limit would show a ball as in that the server scores
// out, or the reverse, and nothing else in the suite would notice.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  golf_bounds tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
// Every CDP call has a deadline, and so does the whole run, as in golf_marker:
// a Chrome or a server that stops answering fails the suite, never hangs it.
const CDP_MS = 15000;                                           // one call
const RUN_MS = 150000;                                          // the whole suite
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });

// Every way out takes Chrome and the server with it, SIGKILL because this
// suite freezes its own server on purpose.
let srv = null, chrome = null, prof = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog = setTimeout(() => { console.error(`FAIL golf_bounds overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

const appPort = await freePort();
srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); break; } catch {} await sleep(150); }
const dbg = await freePort(); prof = join(tmpdir(), `cc-golfob-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
if (!wsUrl) { console.error('FAIL golf_bounds: Chrome never offered a page to drive'); process.exit(1); }
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl);
await Promise.race([new Promise((r) => (ws.onopen = r)), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  const t = setTimeout(() => { pend.delete(i); rej(new Error(`CDP ${method} gave no answer in ${CDP_MS} ms`)); }, CDP_MS);
  pend.set(i, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };
const until = async (expr, ms, step = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(step); } return ev(expr).catch(() => false); };
await send('Page.enable'); await send('Runtime.enable');
// The cold-start intro (public/intro.js) is off for this suite; test/intro.mjs
// owns it. The first-play lesson and the aim demo are marked as seen.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__ccNoIntro = true;
  try { localStorage.setItem('cc_dock_learned', '1'); localStorage.setItem('cc_coach', '1'); localStorage.setItem('cc_aim_guide', '1'); } catch {}` });
const size = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
await size(874, 402);
await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
const ready = await until(`typeof drawGolfBounds === 'function' && typeof startLocal === 'function' && !!window.Bay && S.connected === true`, 15000, 150);
if (!ready) { fail('page never became ready'); cleanup(); process.exit(1); }
await ev(`(() => { window.showToast = () => {}; return true; })()`);

// The round's opening snapshot is kept, so section 5 can hand a fresh one to
// applySnapshot, and the engine's turns are counted, so section 5 swings only
// once the engine has handed the turn back (it holds it while the ball rolls,
// and refuses a second swing inside that hold). handle() is the one door the
// local engine delivers through.
await ev(`(() => { const h = handle; window.__snaps = []; window.__turns = 0; window.handle = (m) => { if (m && (m.type === 'start' || m.type === 'hole')) __snaps.push(JSON.stringify(m)); if (m && m.type === 'turn') __turns++; return h(m); }; return true; })()`);
// Lose the server the way golf_marker does (socket closed first, then the
// process frozen), so Play solo boots the in-page engine.
await ev(`import('./room-engine.js').then(() => true)`);
await ev(`(() => { Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }); S.ws.close(); return true; })()`);
if (!(await until('S.connected === false', 4000, 25))) { fail('socket never reported closed'); cleanup(); process.exit(1); }
srv.kill('SIGSTOP');
await ev(`(() => { soloAutoStart = true; startLocal({ type: 'create', mode: 'golf', max: 2, tees: 'mens', name: 'T', skin: 'olive' }); return true; })()`);
const started = await until(`S.local === true && S.playing === true && S.mode === 'golf' && !!S.golf && !!S.golf.cup && !!S.tanks[S.you] && view.cssW > 0 && __snaps.length > 0`, 8000);
if (started) ok('a local solo golf round is up'); else { fail('no golf round: ' + (await ev('JSON.stringify({ local: S.local, playing: S.playing, mode: S.mode })'))); cleanup(); process.exit(1); }
const MY_TURN = `S.playing && S.turn === S.you && !S.anim && !S.shotSent && !S.queue.length`;
await until(MY_TURN, 8000);

// In-page helpers. __rec(fn) runs fn with every canvas call it makes recorded,
// in CSS pixels; __place(z, end, at) puts the camera at zoom z with the given
// end's boundary at screen x `at`.
await ev(`(() => {
  window.__rec = (fn) => {
    const dpr = ctx.getTransform().a;
    const css = (x, y) => { const m = ctx.getTransform(); return [(m.a * x + m.c * y + m.e) / dpr, (m.b * x + m.d * y + m.f) / dpr]; };
    const rec = { fills: [], strokes: [], texts: [], pills: [], clips: [], calls: 0, base: (() => { const m = ctx.getTransform(); return m.b === 0 && m.c === 0 && m.e === 0 && m.f === 0 && m.a === m.d; })() };
    let path = [];
    const keys = ['beginPath', 'moveTo', 'lineTo', 'arc', 'rect', 'clip', 'stroke', 'fill', 'fillRect', 'fillText'];
    const o = {}; for (const k of keys) o[k] = ctx[k];
    ctx.beginPath = function () { rec.calls++; path = []; return o.beginPath.apply(this, arguments); };
    ctx.moveTo = function (x, y) { rec.calls++; path.push(['M', ...css(x, y)]); return o.moveTo.apply(this, arguments); };
    ctx.lineTo = function (x, y) { rec.calls++; path.push(['L', ...css(x, y)]); return o.lineTo.apply(this, arguments); };
    ctx.arc = function (x, y, r) { rec.calls++; path.push(['A', ...css(x, y), r]); return o.arc.apply(this, arguments); };
    ctx.rect = function (x, y, w, h) { rec.calls++; const [a, b] = css(x, y); path.push(['R', a, b, w, h]); return o.rect.apply(this, arguments); };
    ctx.clip = function () { rec.calls++; rec.clips.push(path.filter((p) => p[0] === 'R').map((p) => p.slice(1))); return o.clip.apply(this, arguments); };
    ctx.stroke = function () { rec.calls++; rec.strokes.push({ path: path.slice(), dash: ctx.getLineDash().slice(), width: ctx.lineWidth, style: String(ctx.strokeStyle) }); return o.stroke.apply(this, arguments); };
    ctx.fill = function () { rec.calls++; const m = ctx.getTransform(); rec.pills.push({ arcs: path.filter((p) => p[0] === 'A').map((p) => p.slice(1)), style: String(ctx.fillStyle), rot: Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI) }); return o.fill.apply(this, arguments); };
    ctx.fillRect = function (x, y, w, h) { rec.calls++; const [a, b] = css(x, y); rec.fills.push({ x: a, y: b, w, h, style: String(ctx.fillStyle) }); return o.fillRect.apply(this, arguments); };
    ctx.fillText = function (t, x, y) { rec.calls++; const m = ctx.getTransform(); rec.texts.push({ t, font: ctx.font, c: css(x, y), rot: Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI), w: ctx.measureText(t).width, align: ctx.textAlign, base: ctx.textBaseline, style: String(ctx.fillStyle) }); return o.fillText.apply(this, arguments); };
    try { fn(); } finally { for (const k of keys) delete ctx[k]; }
    return rec;
  };
  window.__place = (z, end, at) => {
    const L = S.terrain.length - 1, lim = end < 0 ? 0 : L;
    cam.zoom = z;
    cam.cx = lim + (view.cssW / 2 - at) / z;           // wx2s(lim) === at
    cam.cy = surfaceAt(lim) - view.cssH * 0.15 / z;     // the ground at that end a little below centre
    return { lim, sx: wx2s(lim) };
  };
  return true;
})()`);

try {
// ---- 1. the engine's own limit ------------------------------------------------
// Straight up (angle 90: no sideways speed at all) from a muzzle a twentieth of
// a unit inside, then outside, each end, with the real engine on a course as
// long as this hole. A ball that leaves sideways is ruled out with no rest;
// one that comes back down is in. That pins the engine's limit at each end to
// within 0.05 world units, whatever expression the engine uses. The course is
// FLAT and as long as this one, because the limit can depend only on where the
// course ends: on this hole's own sloped ends a ball dropped straight down
// bounces off the slope and out, which is the rule working, not the limit.
const eng = await ev(`import('./game-core.js').then((gc) => {
  const L = S.terrain.length - 1, flat = new Array(L + 1).fill(S.terrain[Math.round(L / 2)]);
  const state = (tx) => ({ terrain: flat.slice(), tanks: [{ x: tx, y: flat[0] }], cup: null, golfHazards: null });
  const up = (tx, dir) => gc.simulateShot(state(tx), { by: 0, weapon: 'golfball', angle: 90, power: 50, dir });
  // The muzzle's offset from the tank, read off the engine's own first path point.
  const off = (dir) => { const r = up(L / 2, dir); return r.projectiles[0].path[0][0] - L / 2; };
  const out = (r) => !r.golf.rest && !r.golf.water;
  const res = {};
  for (const [name, dir, edge] of [['lo', -1, 0], ['hi', 1, L]]) {
    const o = off(dir);
    const inner = up(edge - dir * 0.05 - o, dir), outer = up(edge + dir * 0.05 - o, dir);
    res[name] = { edge, off: o, innerOut: out(inner), outerOut: out(outer), innerRest: inner.golf.rest };
  }
  res.L = L; res.W = WW();
  return res;
})`);
if (eng.lo.innerOut === false && eng.lo.outerOut === true && eng.hi.innerOut === false && eng.hi.outerOut === true)
  ok(`the engine's limit on this hole: out past x = 0 and past x = ${eng.L} (the course's last column), each pinned to 0.05 world units`);
else fail('engine limit probe: ' + JSON.stringify(eng));
if (eng.L === eng.W) ok('the hole the page holds is the hole the engine plays: its last column is the world width'); else fail('terrain vs world width: ' + JSON.stringify({ L: eng.L, W: eng.W }));
const ENG = { lo: [-0.05, 0.05], hi: [eng.L - 0.05, eng.L + 0.05] };

// ---- 2. the drawn boundary at six zooms ----------------------------------------
const draw = await ev(`(() => {
  const keep = { z: cam.zoom, cx: cam.cx, cy: cam.cy };
  const zooms = { floor: minMapZoom(), fit: fullZoom(), aim: aimZoom(), z05: 0.05, battle: 0.14, close: 0.32 };
  const out = { OB: GOLF_OB_PX, rows: [] };
  for (const [zn, z] of Object.entries(zooms)) for (const end of [-1, 1]) {
    const at = end < 0 ? GOLF_OB_PX : view.cssW - GOLF_OB_PX;
    const p = __place(z, end, at);
    const r = __rec(drawGolfBounds);
    const lineW = s2wx(p.sx);
    out.rows.push({ zn, z, end, sx: p.sx, lineW, cssW: view.cssW, cssH: view.cssH, gy: wy2s(surfaceAt(p.lim)), ends: [wx2s(0), wx2s(S.terrain.length - 1)], r });
  }
  // Partly in view (the line 15px in), and out of view (the line 100px off screen).
  const part = __place(0.05, -1, 15); const rp = __rec(drawGolfBounds);
  out.part = { sx: part.sx, r: rp };
  __place(0.05, -1, -100);
  out.gone = __rec(drawGolfBounds);
  // The ground under the strip: drawTerrain fills columns past the line in golf.
  __place(0.05, -1, GOLF_OB_PX);
  const tg = __rec(() => drawTerrain(view.cssW, view.cssH));
  out.ground = tg.fills.filter((f) => f.x + f.w <= GOLF_OB_PX && f.y < view.cssH).length;
  // ...and in any other mode, nothing past the map, and no boundary drawn.
  const mode = S.mode; S.mode = 'duel';
  try {
    const td = __rec(() => drawTerrain(view.cssW, view.cssH));
    out.duelGround = td.fills.filter((f) => f.x + f.w <= GOLF_OB_PX - 1).length;
    out.duelBounds = __rec(drawGolfBounds).calls;
  } finally { S.mode = mode; }
  cam.zoom = keep.z; cam.cx = keep.cx; cam.cy = keep.cy;
  return out;
})()`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sizeOf = (font) => { const m = /(\d+(?:\.\d+)?)px/.exec(font || ''); return m ? Number(m[1]) : 0; };
const weightOf = (font) => { const m = /^(\d{3})\s/.exec(font || ''); return m ? Number(m[1]) : 400; };
const GOB = draw.OB;
if (GOB >= 34) ok(`the strip is ${GOB}px wide on screen`); else fail('strip too narrow to read: ' + GOB);
for (const row of draw.rows) {
  const { r, sx, end, zn, cssW, cssH } = row;
  const tag = `${zn} (zoom ${row.z.toFixed(4)}) ${end < 0 ? 'left' : 'right'} end`;
  const bad = [];
  // Zoomed out, both ends are in view and drawn: each record is matched to its
  // end by where it sits, and nothing may sit anywhere but at one of the two.
  const ends = row.ends;
  if (!r.base) bad.push('drawn under a moved transform');
  // The dashed line: white dashes on sx from the ground up to the top of the canvas.
  const dashed = r.strokes.filter((s) => s.dash.length > 0);
  const pts = dashed.flatMap((s) => s.path.filter((q) => q[0] === 'M' || q[0] === 'L'));
  if (pts.some((q) => !ends.some((x) => near(q[1], x, 1e-6)))) bad.push('a dashed segment off every boundary: ' + JSON.stringify(pts.map((q) => q[1])));
  const mine = dashed.filter((s) => s.path.every((q) => near(q[1], sx, 1e-6)));
  if (!mine.some((s) => /255, 255, 255/.test(s.style))) bad.push('no white dashed line on the boundary');
  const ys = mine.flatMap((s) => s.path.map((q) => q[2]));
  if (!ys.some((y) => near(y, 0, 1e-6))) bad.push('the line does not reach the top of the screen');
  if (!ys.some((y) => near(y, Math.min(cssH, row.gy), 1e-6))) bad.push('the line does not come down to the ground at the boundary');
  const [elo, ehi] = end < 0 ? ENG.lo : ENG.hi;
  if (!(row.lineW > elo && row.lineW < ehi)) bad.push(`line at world x ${row.lineW}, the engine's limit is in (${elo}, ${ehi})`);
  // The strip: darkened from the line to the screen edge, the whole height, and the stripes clipped to it.
  const x0 = end < 0 ? 0 : sx, x1 = end < 0 ? sx : cssW;
  const shades = r.fills.filter((f) => /^rgba\(8, 10, 18/.test(f.style));
  const shade = shades.filter((f) => near(f.x, x0, 1e-6));
  if (shades.some((f) => !ends.some((x) => near(f.x, x, 1e-6) || near(f.x + f.w, x, 1e-6))) || shade.length !== 1 || !near(shade[0].x + shade[0].w, x1, 1e-6) || shade[0].y !== 0 || shade[0].h !== cssH)
    bad.push('the darkened strip is not line-to-edge, full height: ' + JSON.stringify(shades));
  if (!r.clips.some((c) => c[0] && near(c[0][0], x0, 1e-6) && near(c[0][0] + c[0][2], x1, 1e-6))) bad.push('the stripes are not clipped to the strip: ' + JSON.stringify(r.clips));
  const stripes = r.strokes.filter((s) => !s.dash.length && s.width === 6);
  const segs = stripes.flatMap((s) => { const out2 = []; for (let i = 0; i + 1 < s.path.length; i++) if (s.path[i][0] === 'M' && s.path[i + 1][0] === 'L') out2.push([s.path[i], s.path[i + 1]]); return out2; });
  const inStrip = segs.filter(([a]) => a[1] >= x0 && a[1] <= x1 + cssH);
  if (inStrip.length < 2 || segs.some(([a, b]) => !near((b[2] - a[2]) / (b[1] - a[1]), -1, 1e-9)))
    bad.push(`stripes: ${inStrip.length} segments over the strip, not all at 45 degrees`);
  // The stake: white, centred on the line, standing on the ground there.
  const stakes = r.fills.filter((f) => f.style === '#f4f6f8');
  const stake = stakes.filter((f) => near(f.x + f.w / 2, sx, 1e-6));
  if (stakes.some((f) => !ends.some((x) => near(f.x + f.w / 2, x, 1e-6))) || stake.length !== 1 || !near(stake[0].y + stake[0].h, row.gy, 1e-6))
    bad.push('the stake is not on the line, on the ground: ' + JSON.stringify(stakes));
  // The label: the words, at 13px or more, bold, turned 90 degrees to run along
  // the strip, every pixel of it past the line and on the canvas, on its pill.
  const labs = r.texts.filter((t) => t.t === 'OUT OF BOUNDS');
  const lab = labs.filter((t) => (end < 0 ? t.c[0] < sx && t.c[0] > sx - GOB : t.c[0] > sx && t.c[0] < sx + GOB));
  const L0 = lab[0];
  if (labs.some((t) => !ends.some((x) => Math.abs(t.c[0] - x) < GOB)) || lab.length !== 1) bad.push('labels ' + JSON.stringify(labs.map((t) => t.c)));
  else {
    const fs = sizeOf(L0.font), half = fs / 2 + 1;
    if (fs < 13 || weightOf(L0.font) < 800) bad.push('label font ' + L0.font);
    if (Math.abs(L0.rot) !== 90 || L0.align !== 'center') bad.push('label not turned along the strip: ' + JSON.stringify(L0));
    const bx0 = L0.c[0] - half, bx1 = L0.c[0] + half, by0 = L0.c[1] - L0.w / 2, by1 = L0.c[1] + L0.w / 2;
    if (!(end < 0 ? bx1 < sx : bx0 > sx)) bad.push('label crosses onto the course: ' + JSON.stringify({ bx0, bx1, sx }));
    if (bx0 < 0 || bx1 > cssW || by0 < 0 || by1 > cssH) bad.push('label off the canvas: ' + JSON.stringify({ bx0, bx1, by0, by1, cssW, cssH }));
    const pill = r.pills.find((p) => p.arcs.length === 2 && /^rgba\(8, 12, 26/.test(p.style) && near((p.arcs[0][0] + p.arcs[1][0]) / 2, L0.c[0], 1.5));
    if (!pill) bad.push('no pill behind the label');
    else {
      const span = Math.hypot(pill.arcs[1][0] - pill.arcs[0][0], pill.arcs[1][1] - pill.arcs[0][1]) + 2 * pill.arcs[0][2];
      const mid = [(pill.arcs[0][0] + pill.arcs[1][0]) / 2, (pill.arcs[0][1] + pill.arcs[1][1]) / 2];
      if (span < L0.w + 16 || !near(mid[1], L0.c[1], 1.5)) bad.push('the pill does not hold the label: ' + JSON.stringify({ span, w: L0.w, mid, c: L0.c }));
    }
    if (!/255, 255, 255|#ffffff/.test(L0.style)) bad.push('label not white: ' + L0.style);
  }
  if (bad.length) fail(`2: ${tag}: ` + bad.join('; ')); else ok(`2: ${tag}: dashed line on the engine's limit (world x ${row.lineW.toFixed(3)}) from the ground to the top, strip darkened and striped line to edge, stake on the line, label ${sizeOf(L0.font)}px inside the strip`);
}
{
  const p = draw.part, shade = p.r.fills.filter((f) => /^rgba\(8, 10, 18/.test(f.style));
  if (shade.length === 1 && near(shade[0].x, 0, 1e-6) && near(shade[0].w, p.sx, 1e-6) && p.r.strokes.some((s) => s.dash.length)) ok('2: partly in view, the strip is drawn from the screen edge to the line, and the line with it');
  else fail('2: partly in view: ' + JSON.stringify({ sx: p.sx, shade }));
  if (draw.gone.calls === 0) ok('2: an end out of view draws nothing'); else fail('2: an end 100px off screen still drew ' + draw.gone.calls + ' canvas calls');
}
if (draw.ground > 10) ok(`2: the ground runs on under the strip (${draw.ground} terrain columns past the line)`); else fail('2: no ground drawn under the strip: ' + draw.ground);
if (draw.duelGround === 0 && draw.duelBounds === 0) ok('2: in any other mode the same camera draws no boundary and no ground past the map'); else fail('2: outside golf: ' + JSON.stringify({ ground: draw.duelGround, bounds: draw.duelBounds }));

// ---- 3. the drawing against the rule, stroke by stroke -------------------------
// Real game-core strokes off both ends of this hole: the Iron, the Driver and
// the Wedge, from three lies near each end, at four aims and twenty powers. The
// drawn line is read back off the canvas (section 2's left and right rows), so
// this is the PICTURE against the rule. A path point is rounded to 0.1 by the
// engine (round1), hence the 0.05 slack, a hundredth of a pixel at the
// closest zoom.
const lineLo = draw.rows.find((r) => r.end < 0 && r.zn === 'battle').lineW;
const lineHi = draw.rows.find((r) => r.end > 0 && r.zn === 'battle').lineW;
const sweep = await ev(`import('./game-core.js').then((gc) => {
  const L = S.terrain.length - 1, res = { lo: { out: 0, inb: 0, bad: [] }, hi: { out: 0, inb: 0, bad: [] } };
  const lines = { lo: ${lineLo}, hi: ${lineHi} };
  for (const [name, dir, lies] of [['lo', -1, [600, 2500, 6000]], ['hi', 1, [L - 600, L - 2500, L - 6000]]]) {
    for (const tx of lies) for (const weapon of ['golfball', 'driver', 'wedge']) for (const angle of [20, 40, 60, 80]) for (let power = 5; power <= 100; power += 5) {
      const r = gc.simulateShot({ terrain: S.terrain.slice(), tanks: [{ x: tx, y: surfaceAt(tx) }], cup: { x: S.golf.cup.x, r: S.golf.cup.r, capV: 2200 }, golfHazards: S.golf.hazards || null },
        { by: 0, weapon, angle, power, dir });
      const path = r.projectiles[0].path, last = path[path.length - 1][0];
      const out = !r.golf.rest && !r.golf.water;
      const past = (x) => (dir < 0 ? x < lines[name] + 0.05 : x > lines[name] - 0.05);
      const shot = { tx, weapon, angle, power, last };
      if (out) { res[name].out++; if (!past(last)) res[name].bad.push({ ...shot, why: 'ruled out, ends short of the line' }); }
      else { res[name].inb++; const x = path.find((q) => (dir < 0 ? q[0] < lines[name] - 0.05 : q[0] > lines[name] + 0.05)); if (x) res[name].bad.push({ ...shot, why: 'in bounds, crosses the line', at: x }); }
    }
  }
  return res;
})`);
for (const end of ['lo', 'hi']) {
  const s = sweep[end];
  if (s.out >= 20 && s.inb >= 20 && s.bad.length === 0) ok(`3: ${end === 'lo' ? 'left' : 'right'} end: all ${s.out} strokes the engine rules out end past the drawn line, and none of the ${s.inb} in-bounds strokes reaches it`);
  else fail(`3: ${end}: ` + JSON.stringify({ out: s.out, inb: s.inb, bad: s.bad.slice(0, 4) }));
}

// ---- 4. the camera ------------------------------------------------------------
const camChk = await ev(`(() => {
  const keep = { uz: S.userZoom, px: S.panX, py: S.panY, z: cam.zoom, cx: cam.cx, cy: cam.cy };
  const L = S.terrain.length - 1, out = {};
  const frame = (uz, px) => { S.userZoom = uz; S.panX = px; S.panY = 0; snapCamera(); return { z: cam.zoom, floor: minMapZoom(), l: wx2s(0), r: wx2s(L) }; };
  out.wide = frame(0.25, 0);
  out.battleL = frame(1, -WW()); out.battleR = frame(1, WW());
  out.closeL = frame(4, -WW()); out.closeR = frame(4, WW());
  out.cssW = view.cssW; out.ob = GOLF_OB_PX;
  const mode = S.mode; S.mode = 'duel';
  try {
    out.duelFloor = minMapZoom(); out.duelWant = Math.max(view.cssW / WW(), view.cssH / (WH() * TALL_CAP));
    out.duelL = frame(1, -WW()); out.duelR = frame(1, WW()); out.duelWide = frame(0.25, 0);
  } finally { S.mode = mode; }
  S.userZoom = keep.uz; S.panX = keep.px; S.panY = keep.py; cam.zoom = keep.z; cam.cx = keep.cx; cam.cy = keep.cy;
  return out;
})()`);
{
  const c = camChk, W = c.cssW, B = c.ob;
  if (near(c.wide.z, c.wide.floor, 1e-12) && near(c.wide.l, B, 0.5) && near(c.wide.r, W - B, 0.5))
    ok(`4: zoomed out, this short hole sits whole between both strips: left line at ${c.wide.l.toFixed(2)}px, right at ${c.wide.r.toFixed(2)}px of ${W}`);
  else fail('4: zoomed out: ' + JSON.stringify(c.wide));
  const whole = (f, side) => (side < 0 ? near(f.l, B, 0.01) : near(f.r, W - B, 0.01));
  if (whole(c.battleL, -1) && whole(c.battleR, 1) && whole(c.closeL, -1) && whole(c.closeR, 1))
    ok('4: at battle zoom and closer, panned to either end, the camera frames that strip whole and no more');
  else fail('4: battle zoom: ' + JSON.stringify({ L: c.battleL, R: c.battleR, cL: c.closeL, cR: c.closeR }));
  if (near(c.duelFloor, c.duelWant, 1e-15) && near(c.duelL.l, 0, 0.01) && near(c.duelR.r, W, 0.01) && c.duelWide.l <= 0.01 && c.duelWide.r >= W - 0.01)
    ok('4: any other mode keeps its old camera: the same floor, and never a pixel past either end of the map');
  else fail('4: outside golf: ' + JSON.stringify({ floor: c.duelFloor, want: c.duelWant, L: c.duelL, R: c.duelR, wide: c.duelWide }));
}

// ---- 5. the banner --------------------------------------------------------------
// Every time the banner is raised: what it says, which floaters are up, and
// when it went up and came down.
await ev(`(() => { const el = $('obBanner'); window.__ob = []; let was = el.classList.contains('show');
  new MutationObserver(() => { const now = el.classList.contains('show');
    if (now && !was) __ob.push({ text: el.textContent, head: (el.querySelector('.ob-head') || {}).textContent, sub: (el.querySelector('.ob-sub') || {}).textContent, floaters: S.floaters.map((f) => f.text), t: performance.now() });
    if (!now && was && __ob.length) __ob[__ob.length - 1].down = performance.now();
    was = now; })
    .observe(el, { attributes: true, attributeFilter: ['class'] }); return true; })()`);
// Pick a stroke the engine rules out, and one it does not, from the ball's real
// lie with the real facing, then play each for real through the local engine.
const pick = (want) => ev(`import('./game-core.js').then((gc) => {
  const me = S.tanks[S.you], dir = facingOf(S.you);
  const tries = ${want === 'out' ? `[['driver', 135, 100], ['driver', 150, 100], ['driver', 120, 100], ['golfball', 135, 100], ['driver', 160, 90]]` : `[['golfball', 45, 30], ['golfball', 50, 25], ['golfball', 40, 35], ['wedge', 60, 30]]`};
  for (const [weapon, angle, power] of tries) {
    const r = gc.simulateShot({ terrain: S.terrain.slice(), tanks: S.tanks.map((t) => ({ x: t.x, y: t.y })), cup: { x: S.golf.cup.x, r: S.golf.cup.r, capV: 2200 }, golfHazards: S.golf.hazards || null },
      { by: S.you, weapon, angle, power, dir });
    const out = !r.golf.rest && !r.golf.water;
    const plain = r.golf.rest && !r.golf.water && r.golf.rest[1] < S.lavaY - 6 && Math.abs(r.golf.rest[0] - S.golf.cup.x) > S.golf.cup.r;
    if (${want === 'out' ? 'out' : 'plain'}) return { weapon, angle, power };
  }
  return null;
})`);
let turnMark = 0;                                               // __turns when the last swing went
const stroke = async (s) => {
  if (!(await until(`__turns > ${turnMark} && (${MY_TURN})`, 15000, 50))) fail('5: the engine never handed the turn back');
  turnMark = await ev('__turns');
  const s0 = await ev(`(S.golf.strokes && S.golf.strokes[S.you]) || 0`);
  const x0 = await ev(`S.tanks[S.you].x`);
  await ev(`(sendMsg({ type: 'fire', weapon: ${JSON.stringify(s.weapon)}, angle: ${s.angle}, power: ${s.power} }), true)`);
  const done = await until(`S.anim === null && ((S.golf.strokes && S.golf.strokes[S.you]) || 0) > ${s0}`, 30000, 50);
  return { done, s0, x0, after: await ev(`({ strokes: S.golf.strokes[S.you], note: S.golf.note, x: S.tanks[S.you].x, shown: $('obBanner').classList.contains('show') })`) };
};
const OBW = 'OUT OF BOUNDS +1', MINE = 'Your ball left the course. Play again from the same spot.';
const sOut = await pick('out');
if (!sOut) fail('5: no out-of-bounds stroke found from the tee');
else {
  const r = await stroke(sOut);
  await sleep(150);
  const seen = await ev('__ob.slice()');
  if (r.done && r.after.note === 'oob' && r.after.strokes === r.s0 + 2 && Math.abs(r.after.x - r.x0) < 1e-6)
    ok(`5: a real out-of-bounds stroke (${sOut.weapon} at ${sOut.angle} degrees, power ${sOut.power}): ruled oob, stroke plus one, the ball back on its lie (the penalty is unchanged)`);
  else fail('5: the out-of-bounds stroke: ' + JSON.stringify({ sOut, r }));
  if (seen.length === 1 && seen[0].head === OBW && seen[0].sub === MINE) ok(`5: it raised the banner: "${seen[0].head}" / "${seen[0].sub}"`);
  else fail('5: banner on the out-of-bounds stroke: ' + JSON.stringify(seen));
  if (seen.length && !seen[0].floaters.some((t) => /OUT OF BOUNDS/.test(t))) ok('5: and no floater says it a second time'); else fail('5: floaters at the banner: ' + JSON.stringify(seen[0] && seen[0].floaters));
  const look = await ev(`(() => { const h = getComputedStyle($('obBanner').querySelector('.ob-head')); return { color: h.color, weight: h.fontWeight }; })()`);
  if (look.color === 'rgb(255, 210, 63)' && Number(look.weight) >= 800) ok('5: in the penalty notes\' own yellow, bold'); else fail('5: banner headline look: ' + JSON.stringify(look));
}
{
  const gone = await until(`!$('obBanner').classList.contains('show')`, 6000, 100);
  const up = await ev('__ob.length ? __ob[0].down - __ob[0].t : null');
  if (gone && up >= 2500 && up <= 4500) ok(`5: it stays up long enough to read (${(up / 1000).toFixed(1)} s) and then goes by itself`);
  else fail('5: banner time on screen: ' + JSON.stringify({ gone, up }));
}
await until(MY_TURN, 15000);
await ev(`(__ob.length = 0, true)`);
const sIn = await pick('in');
if (!sIn) fail('5: no in-bounds stroke found');
else {
  const r = await stroke(sIn);
  await sleep(600);
  const seen = await ev('__ob.slice()');
  if (r.done && r.after.note === '' && seen.length === 0 && !r.after.shown) ok(`5: a real in-bounds stroke (${sIn.weapon} at ${sIn.angle} degrees, power ${sIn.power}) raises no banner`);
  else fail('5: in-bounds stroke: ' + JSON.stringify({ sIn, r, seen }));
}
await until(MY_TURN, 15000);
// Another player's ball, a picked-up ball, and names shown as text: the real
// applyResolve, handed the strokes the server would send for them.
const others = await ev(`(() => {
  const keep = { names: S.names.slice(), golf: JSON.parse(JSON.stringify(S.golf)), tanks: S.tanks.map((t) => ({ ...t })), floaters: S.floaters.slice() };
  const base = { weapon: 'driver', tanks: S.tanks.map((t) => ({ x: t.x, y: t.y })), hp: S.hp.slice(), damage: [], projectiles: [] };
  const read = () => { const el = $('obBanner'); return { shown: el.classList.contains('show'), head: el.querySelector('.ob-head') && el.querySelector('.ob-head').textContent, sub: el.querySelector('.ob-sub') && el.querySelector('.ob-sub').textContent, kids: el.querySelectorAll('b, i, em, strong, script').length }; };
  const out = {};
  S.names[1] = '<b>Ash</b>';
  applyResolve({ ...base, by: 1, golf: { ...keep.golf, note: 'oob', noteSeat: 1, done: [false, false] } });
  out.other = read();
  applyResolve({ ...base, by: S.you, golf: { ...keep.golf, note: 'oob', noteSeat: S.you, done: keep.golf.done.map((d, i) => i === S.you ? true : d) } });
  out.picked = read();
  S.names = keep.names; S.golf = keep.golf; S.tanks = keep.tanks; S.floaters = keep.floaters; updateHud();
  // A new snapshot clears it: the round's own opening snapshot, handed back.
  applySnapshot(JSON.parse(__snaps[__snaps.length - 1]));
  out.afterSnap = read();
  return out;
})()`);
if (others.other.shown && others.other.head === OBW && others.other.sub === "<b>Ash</b>'s ball left the course." && others.other.kids === 0)
  ok(`5: another player's ball: "${others.other.sub}", the name shown as text, never as markup`);
else fail('5: another player: ' + JSON.stringify(others.other));
if (others.picked.shown && others.picked.head === OBW && others.picked.sub === 'That was the stroke limit. Ball picked up.') ok(`5: a stroke that reaches the hole's limit says the ball is picked up: "${others.picked.sub}"`);
else fail('5: picked up: ' + JSON.stringify(others.picked));
if (!others.afterSnap.shown) ok('5: a new snapshot clears the banner'); else fail('5: the banner outlived a snapshot');

// ---- 6. legibility at the four sizes ---------------------------------------------
// The iPhone 17's insets reach the battlefield through env() on #game.active
// and #dock, which headless Chrome reports as 0, so the same insets are
// applied there as the rules they feed.
const SA = '#game.active{padding-left:62px !important;padding-right:62px !important}#dock{padding-bottom:calc(3px + 21px) !important}';
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const rgb = (s) => (String(s).match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
for (const [w, h, sa] of [[667, 375, ''], [812, 375, ''], [874, 402, SA], [932, 430, '']]) {
  const name = `${w}x${h}${sa ? ' iPhone 17 safe areas' : ''}`;
  await size(w, h);
  await ev(`(() => { let s = document.getElementById('gb-sa'); if (!s) { s = document.createElement('style'); s.id = 'gb-sa'; document.head.appendChild(s); } s.textContent = ${JSON.stringify(sa)}; window.dispatchEvent(new Event('resize')); return true; })()`);
  await sleep(350);
  const g = await ev(`(() => {
    resize();
    const keep = { uz: S.userZoom, px: S.panX };
    S.userZoom = 0.25; S.panX = 0; snapCamera();
    const r = __rec(drawGolfBounds);
    S.userZoom = keep.uz; S.panX = keep.px;
    const cv = canvas.getBoundingClientRect();
    const boxes = r.texts.filter((t) => t.t === 'OUT OF BOUNDS').map((t) => { const half = 7.5; return { x0: cv.left + t.c[0] - half, x1: cv.left + t.c[0] + half, y0: cv.top + t.c[1] - t.w / 2, y1: cv.top + t.c[1] + t.w / 2, font: t.font }; });
    const lines = r.strokes.filter((s) => s.dash.length).map((s) => cv.left + s.path[0][1]);
    const btns = ['camBtn', 'golfCardBtn', 'metaBtn'].map((id) => { const b = $(id).getBoundingClientRect(); return { id, x0: b.left, x1: b.right, y0: b.top, y1: b.bottom, shown: b.width > 0 && getComputedStyle($(id)).display !== 'none' }; });
    const el = $('obBanner');
    showOBBanner('OUT OF BOUNDS +1', S.you, false);
    return { cv: { x0: cv.left, x1: cv.right, y0: cv.top, y1: cv.bottom }, boxes, lines, btns };
  })()`);
  await sleep(450);
  const b = await ev(`(() => {
    const el = $('obBanner'), r = el.getBoundingClientRect(), st = $('stage').getBoundingClientRect(), dk = $('dock').getBoundingClientRect();
    const hd = el.querySelector('.ob-head'), sb = el.querySelector('.ob-sub'), cs = getComputedStyle(el), hs = getComputedStyle(hd), ss = getComputedStyle(sb);
    const out = { r: { x0: r.left, x1: r.right, y0: r.top, y1: r.bottom }, st: { x0: st.left, x1: st.right, y0: st.top, y1: st.bottom }, dk: { y0: dk.top, h: dk.height },
      head: { fs: parseFloat(hs.fontSize), color: hs.color, clip: hd.scrollWidth > hd.clientWidth + 1 }, sub: { fs: parseFloat(ss.fontSize), color: ss.color, clip: sb.scrollWidth > sb.clientWidth + 1 },
      bg: cs.backgroundColor, opacity: cs.opacity };
    el.classList.remove('show');
    return out;
  })()`);
  const bad = [];
  if (g.boxes.length !== 2) bad.push('labels drawn: ' + g.boxes.length);
  for (const x of g.boxes) {
    if (x.x0 < g.cv.x0 || x.x1 > g.cv.x1 || x.y0 < g.cv.y0 || x.y1 > g.cv.y1) bad.push('a label runs off the canvas: ' + JSON.stringify(x));
    if (sizeOf(x.font) < 13) bad.push('label font ' + x.font);
    for (const bt of g.btns) if (bt.shown && x.x0 < bt.x1 && x.x1 > bt.x0 && x.y0 < bt.y1 && x.y1 > bt.y0) bad.push(`a label sits under #${bt.id}`);
  }
  if (g.lines.length < 2) bad.push('boundary lines drawn: ' + g.lines.length);
  const bg = rgb(b.bg);
  if (b.r.x0 < b.st.x0 || b.r.x1 > b.st.x1 || b.r.y0 < b.st.y0 || b.r.y1 > b.st.y1) bad.push('banner off the stage: ' + JSON.stringify({ r: b.r, st: b.st }));
  if (b.dk.h > 0 && b.r.y1 > b.dk.y0) bad.push('banner over the dock');
  if (b.head.fs < 13 || b.sub.fs < 13) bad.push('banner sizes ' + JSON.stringify({ head: b.head.fs, sub: b.sub.fs }));
  if (b.head.clip || b.sub.clip) bad.push('banner text cut: ' + JSON.stringify({ head: b.head.clip, sub: b.sub.clip }));
  const ch = contrast(rgb(b.head.color), bg), cs2 = contrast(rgb(b.sub.color), bg);
  if (ch < 4.5 || cs2 < 4.5) bad.push('banner contrast ' + JSON.stringify({ ch, cs2 }));
  if (Number(b.opacity) !== 1) bad.push('banner not fully shown: opacity ' + b.opacity);
  if (bad.length) fail(`6: ${name}: ` + bad.join('; '));
  else ok(`6: ${name}: both labels whole on the canvas, clear of the buttons, 13px; the banner whole on the stage, above the dock, ${b.head.fs}px over ${b.sub.fs}px, contrast ${ch.toFixed(1)} and ${cs2.toFixed(1)}`);
}
} catch (e) {
  fail('golf_bounds suite stopped: ' + (e && e.message));
}

clearTimeout(watchdog);
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall golf_bounds checks passed');
process.exit(errors.length ? 1 : 0);
