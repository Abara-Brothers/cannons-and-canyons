// Artillery Golf: the off-screen flag marker and its tap, in a real page.
// A local solo round is started through the same in-page engine the offline
// path uses, then the camera is placed by hand and cupMarker() read back in
// the same synchronous evaluation, so the draw loop's easing cannot interfere.
// Headless Chrome over CDP; skips without Chrome.
//
// WHY THIS EXISTS: the marker is computed from four things that only meet in a
// browser — the camera, the terrain surface, the cup and your tank — and the
// tap is consumed ahead of the aim gesture. A marker that never appears, sits
// under the tank markers, or lets a tap start an aim drag would all be silent.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  golf_marker tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const appPort = await freePort();
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${appPort}/health`); break; } catch {} await sleep(150); }
const dbg = await freePort(); const prof = join(tmpdir(), `cc-golf-${dbg}`); rmSync(prof, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
// SIGCONT first: a stopped server ignores SIGTERM until it is continued, and an
// early exit after the freeze would leave a stopped orphan on its port.
const cleanup = () => { try { srv.kill('SIGCONT'); } catch {} try { chrome.kill(); } catch {} try { srv.kill(); } catch {} try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {} };
process.on('exit', cleanup);
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };
const until = async (expr, ms, step = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(step); } return ev(expr).catch(() => false); };
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 932, height: 430, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
const ready = await until(`typeof cupMarker === 'function' && typeof startLocal === 'function' && !!window.Bay && S.connected === true`, 15000, 150);
if (!ready) { fail('page never became ready'); cleanup(); process.exit(1); }
await ev(`(() => { window.showToast = () => {}; try { localStorage.setItem('cc_dock_learned', '1'); localStorage.setItem('cc_coach', '1'); } catch {} return true; })()`);

// Lose the server the way the offline suite does (socket closed first, then
// the process frozen), or startLocal() rightly honours the live connection and
// sends the create online instead of booting the in-page engine.
await ev(`import('./room-engine.js').then(() => true)`);
await ev(`(() => { Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }); S.ws.close(); return true; })()`);
if (!(await until('S.connected === false', 4000, 25))) { fail('socket never reported closed'); cleanup(); process.exit(1); }
srv.kill('SIGSTOP');
// A local solo golf round, the way Play solo boots one.
await ev(`(() => { soloAutoStart = true; startLocal({ type: 'create', mode: 'golf', max: 2, tees: 'mens', name: 'T', skin: 'olive' }); return true; })()`);
const started = await until(`S.local === true && S.playing === true && S.mode === 'golf' && !!S.golf && !!S.golf.cup && !!S.tanks[S.you] && view.cssW > 0`, 8000);
if (started) ok('a local solo golf round is up with a cup and a tank'); else { fail('no golf round: ' + (await ev('JSON.stringify({ local: S.local, playing: S.playing, mode: S.mode })'))); cleanup(); process.exit(1); }

// 1. cup in view -> no marker; far left -> marker on the right edge; far right -> left edge
const geo = await ev(`(() => {
  const cup = S.golf.cup.x, me = S.tanks[S.you].x, span = view.cssW / cam.zoom;
  cam.cx = cup; const onScreen = cupMarker();
  cam.cx = cup - span; const right = cupMarker();
  cam.cx = cup + span; const left = cupMarker();
  return { onScreen, right, left, dist: Math.abs(cup - me), cssW: view.cssW, cssH: view.cssH };
})()`);
if (geo.onScreen === null) ok('cup in view: no marker'); else fail('marker drawn with the cup in view: ' + JSON.stringify(geo.onScreen));
if (geo.right && geo.right.left === false && geo.right.ex === geo.cssW - 14) ok('cup off to the right: marker on the right edge'); else fail('right marker: ' + JSON.stringify(geo.right));
if (geo.left && geo.left.left === true && geo.left.ex === 14) ok('cup off to the left: marker on the left edge'); else fail('left marker: ' + JSON.stringify(geo.left));
if (geo.right && Math.abs(geo.right.dist - geo.dist) < 1e-6) ok('the distance is cup to your tank'); else fail('distance: ' + JSON.stringify({ got: geo.right && geo.right.dist, want: geo.dist }));
if (geo.right && geo.right.ey >= 40 && geo.right.ey <= geo.cssH - 90) ok('the marker sits in the band above the tank markers'); else fail('marker y: ' + JSON.stringify(geo.right && geo.right.ey));

// 2. seat 0's REAL edge marker, with that tank moved to the cup, lands 30px
//    below the flag marker — read off drawEdgeIndicators() itself, not a copy
//    of either formula, so a change to the tank marker's clamp or stagger fails here.
const band = await ev(`(() => { const cup = S.golf.cup.x, span = view.cssW / cam.zoom; cam.cx = cup - span; const m = cupMarker();
  const t = S.tanks[0], keep = { x: t.x, y: t.y }; t.x = cup; t.y = surfaceAt(cup);
  const ys = [], orig = ctx.moveTo; ctx.moveTo = function (x, y) { ys.push(y); return orig.call(this, x, y); };
  try { drawEdgeIndicators(); } finally { ctx.moveTo = orig; t.x = keep.x; t.y = keep.y; }
  return { my: m.ey, tankMarkerY: ys[0], drew: ys.length }; })()`);
if (band.drew >= 1 && band.tankMarkerY - band.my === 30) ok('sits exactly 30px above where the real tank marker draws for a tank at the cup'); else fail('band: ' + JSON.stringify(band));

// 3. a tap on the marker pans to the cup and starts no aim; a tap elsewhere still aims
const tap = await ev(`(() => {
  const cup = S.golf.cup.x, me = S.tanks[S.you].x, span = view.cssW / cam.zoom;
  cam.cx = cup - span; const m = cupMarker();
  const r = canvas.getBoundingClientRect();
  const down = (x, y, pid) => canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + x, clientY: r.top + y, pointerId: pid, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }));
  S.panX = 0; S.charging = false; S.pullPointer = null; S.pullAnchor = null; pointers.clear();
  down(m.ex - 30, m.ey, 71);
  const after = { panX: S.panX, charging: S.charging, pull: S.pullPointer, pointers: pointers.size, want: Math.max(-WW(), Math.min(WW(), cup - me)), canAim: canAim() };
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + m.ex - 30, clientY: r.top + m.ey, pointerId: 71, pointerType: 'touch', bubbles: true }));
  S.charging = false; S.pullPointer = null; S.pullAnchor = null; pointers.clear();
  cam.cx = cup - span;
  down(view.cssW / 2, view.cssH / 2, 72);
  const elsewhere = { charging: S.charging, pointers: pointers.size };
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + view.cssW / 2, clientY: r.top + view.cssH / 2, pointerId: 72, pointerType: 'touch', bubbles: true }));
  S.charging = false; S.pullPointer = null; S.pullAnchor = null; pointers.clear(); S.panX = 0;
  return { after, elsewhere };
})()`);
if (tap.after.panX === tap.after.want && tap.after.want !== 0) ok('a tap on the marker sets the pan so the cup is mid-screen'); else fail('pan after tap: ' + JSON.stringify(tap.after));
if (tap.after.charging === false && tap.after.pull === null && tap.after.pointers === 0) ok('the marker tap is consumed: no aim anchored, no pointer tracked'); else fail('aim leaked from the marker tap: ' + JSON.stringify(tap.after));
if (tap.after.canAim && tap.elsewhere.charging === true && tap.elsewhere.pointers === 1) ok('a tap elsewhere still anchors an aim (the consumption is specific)'); else fail('control tap: ' + JSON.stringify({ canAim: tap.after.canAim, elsewhere: tap.elsewhere }));

// 4. holed out -> no marker, even with the cup off-screen
const holed = await ev(`(() => { const cup = S.golf.cup.x, span = view.cssW / cam.zoom; cam.cx = cup - span;
  const before = !!cupMarker(); S.golf.done = S.golf.done || []; const keep = S.golf.done[S.you]; S.golf.done[S.you] = true;
  const during = cupMarker(); S.golf.done[S.you] = keep; return { before, during }; })()`);
if (holed.before && holed.during === null) ok('once you have holed out the marker is gone'); else fail('holed out: ' + JSON.stringify(holed));

// 3b. the LEFT-edge marker: its mirrored box is tappable and pans too
const tapL = await ev(`(() => {
  const cup = S.golf.cup.x, me = S.tanks[S.you].x, span = view.cssW / cam.zoom;
  cam.cx = cup + span; const m = cupMarker();
  const r = canvas.getBoundingClientRect();
  S.panX = 0; S.charging = false; S.pullPointer = null; S.pullAnchor = null; pointers.clear();
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + m.ex + 30, clientY: r.top + m.ey, pointerId: 73, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }));
  const out = { left: m.left, panX: S.panX, want: Math.max(-WW(), Math.min(WW(), cup - me)), charging: S.charging, pointers: pointers.size,
    hitOn: cupMarkerHit(m.ex + 40, m.ey - 10), hitFar: cupMarkerHit(m.ex + 120, m.ey), hitBehind: cupMarkerHit(m.ex - 30, m.ey) };
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + m.ex + 30, clientY: r.top + m.ey, pointerId: 73, pointerType: 'touch', bubbles: true }));
  S.charging = false; S.pullPointer = null; S.pullAnchor = null; pointers.clear(); S.panX = 0;
  return out; })()`);
if (tapL.left === true && tapL.panX === tapL.want && tapL.charging === false && tapL.pointers === 0) ok('left edge: a tap on the marker pans to the cup and is consumed'); else fail('left tap: ' + JSON.stringify(tapL));
if (tapL.hitOn && !tapL.hitFar && !tapL.hitBehind) ok('left edge: the hit box is mirrored — it covers the marker and its distance, not off-screen'); else fail('left hit box: ' + JSON.stringify(tapL));

// 3c. a SECOND finger landing on the marker mid-aim is a pinch, never a pan
const pinch = await ev(`(() => {
  const cup = S.golf.cup.x, span = view.cssW / cam.zoom; cam.cx = cup - span; const m = cupMarker();
  const r = canvas.getBoundingClientRect();
  const down = (x, y, pid) => canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + x, clientY: r.top + y, pointerId: pid, pointerType: 'touch', bubbles: true, cancelable: true }));
  S.panX = 0; S.charging = false; S.pullPointer = null; S.pullAnchor = null; pointers.clear();
  down(view.cssW / 2, view.cssH / 2, 81); const oneDown = { charging: S.charging, pointers: pointers.size };
  down(m.ex - 30, m.ey, 82);
  const out = { oneDown, panX: S.panX, pointers: pointers.size, charging: S.charging, pinch: !!pinchStart };
  for (const pid of [81, 82]) canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left, clientY: r.top, pointerId: pid, pointerType: 'touch', bubbles: true }));
  S.charging = false; S.pullPointer = null; S.pullAnchor = null; pointers.clear(); S.panX = 0; pinchStart = null;
  return out; })()`);
if (pinch.oneDown.charging && pinch.oneDown.pointers === 1 && pinch.panX === 0 && pinch.pointers === 2 && pinch.charging === false && pinch.pinch) ok('a second finger on the marker mid-aim becomes a pinch: no pan, both pointers tracked'); else fail('pinch guard: ' + JSON.stringify(pinch));

// 5. the hit box: just outside the marker's padded box is not a hit
const box = await ev(`(() => { const cup = S.golf.cup.x, span = view.cssW / cam.zoom; cam.cx = cup - span; const m = cupMarker();
  return { on: cupMarkerHit(m.ex - 40, m.ey + 10), above: cupMarkerHit(m.ex - 40, m.ey - 40), far: cupMarkerHit(m.ex - 120, m.ey) }; })()`);
if (box.on && !box.above && !box.far) ok('the hit box covers the marker and its distance, not the space around'); else fail('hit box: ' + JSON.stringify(box));

// 6. your own stroke clears the marker pan: panToCup's offset is tank-relative,
//    so left in place it would frame cup + shot length after the ball moves.
//    A REAL stroke through the local engine, replay and all.
//    The ball's x may end where it started (a penalty returns it to its lie),
//    so the proof is the stroke COUNT going up and the replay finishing.
const fired = await ev(`(() => { S.panX = 5000; const s0 = (S.golf.strokes && S.golf.strokes[S.you]) || 0; sendMsg({ type: 'fire', weapon: 'driver', angle: 45, power: 70 }); return { s0, panX: S.panX }; })()`);
const settled = await until(`S.anim === null && ((S.golf.strokes && S.golf.strokes[S.you]) || 0) > ${fired.s0}`, 25000, 200);
const afterStroke = await ev(`({ panX: S.panX, strokes: (S.golf.strokes && S.golf.strokes[S.you]) || 0, anim: S.anim === null })`);
if (settled && fired.panX === 5000 && afterStroke.panX === 0) ok('after your own stroke resolves the pan is cleared, so the camera frames your new lie'); else fail('stroke pan: ' + JSON.stringify({ fired, afterStroke, settled }));

try { srv.kill('SIGCONT'); } catch {}
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall golf_marker checks passed');
process.exit(errors.length ? 1 : 0);
