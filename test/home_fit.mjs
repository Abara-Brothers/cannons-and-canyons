// Home fits the safe box, in a real page (owner, 2026-10-06, update 8 task U5).
//
// WHAT THE OWNER ASKED FOR, and what each part of this suite holds to:
//   1. No empty space under the Launch ribbon. On an iPhone held sideways iOS
//      insets both long sides (~62pt) and the bottom (21pt), the frame is
//      fitted by its width, and ~40pt of floor showed under the ribbon. Home
//      now reaches the safe box's top and bottom (--ht, styles.css HOME
//      REACHES BOTH SAFE EDGES) with --u, and so every width, unchanged; the
//      ribbon stands 4u above the safe bottom and never inside the inset.
//   2. The top row is one smaller height, every chip a target of at least
//      44 CSS px, and the mode boards come up into the space saved.
//   3. The tank sits lower, on its platform inside the blue ring, and the top
//      of its sprite -- the barrel's end -- is clear of every board. Since
//      2026-10-06 ("the tank is also being cut off at the top") the sprite
//      holds the whole gun: its muzzle stands inside the image with clear
//      pixels round it, and every pixel the tank draws, the gun's with it, is
//      clear of every board. The same sprite, uncut, on the Paint shop and
//      every other screen that shows it, its frame where it always stood.
//   4. The Bay controls line under each row is larger and easily read.
// Headless Chrome has no safe-area insets, so the iPhone 17 is emulated the
// way the task brief says: a stylesheet sets --sa-l/--sa-r/--sa-b, from which
// the app derives every inset.
//
// WHY A SUITE OF ITS OWN: test/layout.mjs is a change detector -- it says the
// boxes moved, never that they are right. These are the rules the new boxes
// must keep at every size: a later change that puts a chip over a board, the
// tank under one, or the ribbon in the home-indicator strip fails here by
// name.
//
// Self-hosted: spawns its own server and Chrome on free ports. Skips cleanly
// (exit 3) when Chrome is absent, like every other client-side suite.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.log(`SKIP  home_fit tests — no Chrome at ${CHROME}`);
  console.log('      (set CHROME_PATH to run them)');
  process.exit(3);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
let passed = 0, failed = 0;
const check = (name, okay, detail) => {
  if (okay) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? '\n      ' + detail : ''}`); }
};

// EVERY CDP CALL HAS A DEADLINE, AND SO DOES THE WHOLE RUN, as in
// test/layout.mjs: a peer that stops answering fails the suite loudly, and
// every way out takes Chrome and the server with it.
const CDP_MS = 15000, RUN_MS = 180000;
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
let srv = null, chrome = null, profile = null, cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { chrome && chrome.kill('SIGKILL'); } catch {}
  try { srv && srv.kill('SIGKILL'); } catch {}
  try { profile && rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog = setTimeout(() => { console.error(`FAIL  home_fit overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);
for (const evn of ['uncaughtException', 'unhandledRejection']) process.on(evn, (e) => {
  console.log(`FAIL  the suite crashed: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  cleanup(); process.exit(1);
});

// ---- server and browser -----------------------------------------------------
const appPort = await freePort();
srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
let up = false;
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { console.error('FAIL  server never came up'); process.exit(1); }
const dbgPort = await freePort();
profile = join(tmpdir(), `cc-homefit-${dbgPort}`);
rmSync(profile, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try { const l = await (await get(`http://127.0.0.1:${dbgPort}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {}
  await sleep(250);
}
if (!wsUrl) { console.error('FAIL  Chrome exposed no debugger'); process.exit(1); }
let mid = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
await Promise.race([new Promise((r) => { ws.onopen = r; }), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
const pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails || {}; pageErrors.push((d.exception && d.exception.description) || d.text); return; }
  const p = pending.get(m.id); if (!p) return;
  pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++mid;
  const t = setTimeout(() => { pending.delete(i); reject(new Error(`CDP ${method} gave no answer in ${CDP_MS} ms`)); }, CDP_MS);
  pending.set(i, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (er) => { clearTimeout(t); reject(er); } });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
// Nothing here may reach a real backend, production least of all.
await send('Network.setBlockedURLs', { urls: ['*supabase.co*', '*googleapis*', '*abarabrothers.com*'] });
// The cold-start intro is off: test/intro.mjs owns it (and its hand-off onto
// this layout). A fixed callsign, so the callsign chip is the same width on
// every run.
await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__ccNoIntro = true; try { localStorage.setItem('pt_name', 'TESTPILOT'); } catch (e) {}" });

// ---- the page-side readers --------------------------------------------------
// The home geometry, in CSS px. `u` is resolved by spending it on a real
// length; the safe-area insets the same way, so an injected stylesheet and a
// real env() read back identically.
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const R = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const len = (css) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:-9999px;top:0;height:0;width:' + css; document.body.appendChild(d); const w = d.getBoundingClientRect().width; d.remove(); return w; };
  const u = len('calc(var(--u) * 1000)') / 1000;
  const sa = { l: len('var(--sa-l)'), r: len('var(--sa-r)'), t: len('var(--sa-t)'), b: len('var(--sa-b)') };
  const chips = [...document.querySelectorAll('#bay .top .chip')];
  const st = [...document.querySelectorAll('#bay .stn .st')];
  const stn = q('#bay .stn');
  return {
    u, sa, iw: innerWidth, ih: innerHeight, scr: q('#bay').dataset.scr,
    stage: R(q('#bay .stage')), top: R(q('#bay .top')), mark: R(q('#bay .top .mark')), boards: R(q('#bay .boards')),
    lbar: R(q('#bay .lbar')), ap: R(q('#bay .ap')), plat: R(q('#bay .plat')), img: R(q('#bay .tankw img')),
    pad: -parseFloat(getComputedStyle(q('#bay .tankw img')).marginTop) || 0,
    box: R(q('#bay .pnl.sqx')), stn: R(stn), ph: R(stn.querySelector('.ph')),
    stnPad: parseFloat(getComputedStyle(stn).paddingBottom), stnBorder: parseFloat(getComputedStyle(stn).borderBottomWidth),
    st: st.map(R),
    chips: chips.map((c) => ({ ...R(c), sq: c.classList.contains('sq'), cls: c.className })),
    over: [q('#bay').scrollWidth > q('#bay').clientWidth, q('#bay').scrollHeight > q('#bay').clientHeight],
  };
})()`;
// Each board's card as the four corners it is drawn at: the board's inline
// rotate/translate and the card's own lift (armed, scale 1.04), both about
// their centres, composed exactly as the browser does. A bounding box would
// be too blunt: a tilted board's box reaches well past its corners.
const QUADS = `(() => {
  const bx = document.querySelector('#bay .boards').getBoundingClientRect();
  return [...document.querySelectorAll('#bay .boards .board')].map((b) => {
    const c = b.querySelector('.bcard');
    const w = b.offsetWidth, h = b.offsetHeight;
    const about = (el) => { const t = getComputedStyle(el).transform; const m = new DOMMatrix(t === 'none' ? undefined : t); return new DOMMatrix().translate(w / 2, h / 2).multiply(m).translate(-w / 2, -h / 2); };
    const M = new DOMMatrix().translate(bx.left + b.offsetLeft, bx.top + b.offsetTop).multiply(about(b)).multiply(about(c));
    return { on: b.classList.contains('on'), mode: (b.getAttribute('data-set') || '').replace('mode=', ''),
      pts: [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => { const p = M.transformPoint(new DOMPoint(x, y)); return [p.x, p.y]; }) };
  });
})()`;
// THE TANK AS IT IS DRAWN, not the box of its image: the image is the frame
// plus a transparent pad above and to the right that holds the gun (bay.js
// tankURL), so its box is far taller than the tank in most columns. For each
// image matched (a stage's tank, or a card's), every column of the sprite's
// pixels that draws anything, as its CSS-px rectangle on the page (first to
// last drawn pixel); the frame (the image less the pad its negative margins
// hand back, or its wrapper's box on a stage) and the box the layout gives
// it; and how many drawn pixels lie within 2px (the sprite's own CSS px) of
// its top and right edges -- where a cut sprite ends its gun.
const SPRITES = (sel) => `(async () => {
  const out = [];
  for (const img of document.querySelectorAll(${JSON.stringify(sel)})) {
    await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const q = c.getContext('2d'); q.drawImage(img, 0, 0);
    const d = q.getImageData(0, 0, W, H).data;
    const b = img.getBoundingClientRect(), kx = b.width / W, ky = b.height / H, cs = getComputedStyle(img);
    // 2px of the sprite's own (tankURL draws at the page's pixel ratio)
    const m = Math.round(2 * Math.max(1, Math.min(3, devicePixelRatio || 1)));
    const cols = []; let edgeT = 0, edgeR = 0, minY = H, maxX = -1;
    for (let x = 0; x < W; x++) {
      let t = -1, e = -1;
      for (let y = 0; y < H; y++) if (d[(y * W + x) * 4 + 3] > 0) { if (t < 0) t = y; e = y; if (y < m) edgeT++; if (x >= W - m) edgeR++; }
      if (t >= 0) { cols.push([b.left + x * kx, b.left + (x + 1) * kx, b.top + t * ky, b.top + (e + 1) * ky]); if (t < minY) minY = t; maxX = x; }
    }
    const stageImg = !!img.closest('.tankw'), wrap = img.parentElement.getBoundingClientRect();
    const mt = -parseFloat(cs.marginTop) || 0, mr = -parseFloat(cs.marginRight) || 0;
    const frame = stageImg ? { l: wrap.left, t: wrap.top, w: wrap.width } : { l: b.left, t: b.top + mt, w: b.width - mr };
    out.push({ stageImg, cols, edgeT, edgeR, frame, img: { l: b.left, t: b.top, w: b.width, h: b.height, mt, mr },
      drawn: { t: b.top + minY * ky, r: b.left + (maxX + 1) * kx } });
  }
  return out;
})()`;
// The point a tap at (x, y) reaches, as the chip it belongs to (or null).
const HITS = (pts) => `(() => ${JSON.stringify(pts)}.map(([x, y]) => { const e = document.elementFromPoint(x, y); const c = e && e.closest('#bay .top .chip'); return c ? [...document.querySelectorAll('#bay .top .chip')].indexOf(c) : -1; }))()`;

// ---- geometry helpers -------------------------------------------------------
const EPS = 0.25;                                   // touching is not overlapping
const rectPts = (r) => [[r.l, r.t], [r.r, r.t], [r.r, r.b], [r.l, r.b]];
// Separating-axis test for two convex polygons: they overlap only if no edge
// normal of either one separates them (by more than EPS).
function polysOverlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const nx = y2 - y1, ny = x1 - x2, len = Math.hypot(nx, ny) || 1;
      const pa = a.map(([x, y]) => (x * nx + y * ny) / len), pb = b.map(([x, y]) => (x * nx + y * ny) / len);
      if (Math.max(...pa) <= Math.min(...pb) + EPS || Math.max(...pb) <= Math.min(...pa) + EPS) return false;
    }
  }
  return true;
}
const rectsOverlap = (a, b) => polysOverlap(rectPts(a), rectPts(b));
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const f1 = (n) => Math.round(n * 10) / 10;
// The target a chip must offer: 44 CSS px at the least each way, centred on a
// wide chip's height and spanning its width; a square chip's reaches left.
function targetOf(c) {
  const h = Math.max(c.h, 44), cy = (c.t + c.b) / 2;
  const w = c.sq ? Math.max(c.w, 44) : c.w;
  return { l: c.r - w, r: c.r, t: cy - h / 2, b: cy + h / 2, w, h };
}
// WCAG relative luminance and contrast, for the Bay controls line.
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// ---- the viewports ----------------------------------------------------------
// The four the task names (667x375, 812x375, 874x402, an iPad held sideways),
// the iPhone 17 with its safe areas, the 932x430 design size, the smallest
// tier the CSS targets, and a portrait iPad window, where the stretch stops
// at its cap.
const IPHONE17 = ':root{--sa-l:62px;--sa-r:62px;--sa-b:21px;--sa-t:0px}';
const VIEWS = [
  { name: '667x375', w: 667, h: 375 },
  { name: '812x375', w: 812, h: 375 },
  { name: '874x402', w: 874, h: 402 },
  { name: '874x402 iPhone 17 safe areas', w: 874, h: 402, css: IPHONE17 },
  { name: '932x430', w: 932, h: 430 },
  { name: '568x320', w: 568, h: 320 },
  { name: '1194x834 iPad', w: 1194, h: 834 },
  { name: '834x1194 iPad portrait', w: 834, h: 1194 },
];
const MODES = ['duel', 'ffa', 'boss', 'aliens', 'golf'];
const FREEZE = `(() => { const s = document.createElement('style'); s.id = 'hf-freeze'; s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important;}'; document.head.appendChild(s); return true; })()`;

async function open(v) {
  await send('Emulation.setDeviceMetricsOverride', { width: v.w, height: v.h, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  let ready = false;
  for (let i = 0; i < 80; i++) { if (await ev('!!window.Bay && !!document.querySelector("#bay .stage .lbar") && typeof ccMode !== "undefined"').catch(() => false)) { ready = true; break; } await sleep(150); }
  if (!ready) throw new Error(`${v.name}: the bay never drew home`);
  // Fonts settle first: a fallback face measures differently.
  await ev('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true');
  if (v.css) await ev(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(v.css)}; document.head.appendChild(s); return true; })()`);
  await ev(FREEZE);
  await ev(`(() => { Bay.show('home'); return true; })()`);
  await sleep(150);
}

for (const v of VIEWS) {
  await open(v);
  const g = await ev(PROBE);
  const V = v.name, u = g.u;
  const aw = g.iw - g.sa.l - g.sa.r, ah = g.ih - g.sa.t - g.sa.b;
  const uWant = Math.min(aw / 932, ah / 430);
  const htFull = (ah - 430 * uWant) / 2, ht = Math.min(htFull, 140 * uWant), capped = htFull > ht + 0.5;
  const te = Math.max(0, 22 - 20 * u), rt = Math.max(4 * u, te);
  const safeTop = g.sa.t, safeBottom = g.ih - g.sa.b;

  // 1. THE FRAME. --u and the .stage box are exactly what they were: the
  //    contents move, nothing gets wider, and the intro's frame stays put.
  check(`[${V}] --u is unchanged (${f1(uWant * 1000) / 1000}) and the frame box is the centred 932x430u one`,
    near(u, uWant, 0.0015) && near(g.stage.w, 932 * u) && near(g.stage.h, 430 * u)
      && near(g.stage.l, g.sa.l + (aw - 932 * u) / 2) && near(g.stage.t, safeTop + (ah - 430 * u) / 2),
    JSON.stringify({ u, uWant, stage: g.stage }));
  // 2. THE RIBBON ON THE SAFE BOTTOM, never inside the inset; the top row at
  //    the safe top. A tablet past the cap keeps the frame centred instead.
  if (!capped) {
    check(`[${V}] the Launch ribbon stands 4u above the safe bottom (${f1(g.lbar.b)} of ${f1(safeBottom)})`,
      near(g.lbar.b, safeBottom - 4 * u) && g.lbar.b <= safeBottom + 0.01, JSON.stringify({ lbar: g.lbar, safeBottom }));
    check(`[${V}] the top row stands at the safe top, its targets on the screen (${f1(g.top.t)})`,
      near(g.top.t, safeTop + rt), JSON.stringify({ top: g.top, safeTop, rt }));
  } else {
    check(`[${V}] past the 140u cap the frame's contents stay centred: as far above the top row as below the ribbon`,
      near(g.top.t - rt, safeTop + (ah - 430 * u) / 2 - 140 * u) && near(safeBottom - g.lbar.b, g.top.t - rt - safeTop + 4 * u),
      JSON.stringify({ top: g.top.t, lbar: g.lbar.b, ah }));
  }
  if (v.css) {
    check(`[${V}] the ribbon's bottom is within 4px of 402 - 21 = 381 (${f1(g.lbar.b)})`, Math.abs(g.lbar.b - 381) <= 4 && g.lbar.b <= 381);
    check(`[${V}] the spare height went between the boards and the ribbon: the ribbon sank by --ht, the row rose by it`,
      ht > 15 && near(g.lbar.b, g.stage.b + ht - 4 * u) && near(g.top.t, g.stage.t - ht + rt));
  }

  // 3. THE TOP ROW: one height, smaller than before, every target 44px.
  const hs = g.chips.map((c) => c.h);
  check(`[${V}] five chips, one height of 40u (${f1(40 * u)}px); the square ones 40u wide`,
    g.chips.length === 5 && hs.every((h) => near(h, 40 * u, 0.6)) && g.chips.filter((c) => c.sq).length === 2 && g.chips.filter((c) => c.sq).every((c) => near(c.w, 40 * u, 0.6)),
    JSON.stringify(g.chips.map((c) => [f1(c.w), f1(c.h)])));
  if (V === '874x402') check(`[${V}] the chips are visibly smaller than the 51px they were (${f1(hs[0])}px)`, hs.every((h) => h <= 0.8 * 51));
  const T = g.chips.map(targetOf);
  // (Layout runs in 1/64 px, so an edge on the screen's own edge may read a
  // hair past it.)
  const onScreen = T.every((t) => t.t >= -0.05 && t.l >= -0.05 && t.r <= g.iw + 0.05);
  const pts = [];
  T.forEach((t, i) => { const x0 = t.l + 0.75, x1 = t.r - 0.75, y0 = t.t + 0.75, y1 = t.b - 0.75, xm = (t.l + t.r) / 2, ym = (t.t + t.b) / 2;
    for (const p of [[x0, y0], [xm, y0], [x1, y0], [x0, ym], [x1, ym], [x0, y1], [xm, y1], [x1, y1]]) pts.push([i, p]); });
  const hit = await ev(HITS(pts.map((p) => p[1])));
  const missed = pts.filter((p, k) => hit[k] !== p[0]).map((p) => `chip ${p[0]} at ${p[1].map(f1)}`);
  check(`[${V}] every chip takes a tap across at least 44x44 CSS px, all of it on the screen`,
    T.every((t) => t.w >= 44 - 0.01 && t.h >= 44 - 0.01) && onScreen && missed.length === 0, missed.slice(0, 4).join('; ') || JSON.stringify(T));
  const tOver = [];
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) if (rectsOverlap(T[i], T[j])) tOver.push(`${i}/${j}`);
  check(`[${V}] no two chips' targets share a pixel`, tOver.length === 0, tOver.join(', '));

  // 4. NOTHING OVERLAPS, with every mode armed in turn (the armed board rises
  //    10.8u): no drawn chip or the brand mark over a board, no target over a
  //    resting board, no panel over a board, and no pixel the tank draws --
  //    the whole gun, at the top of its 7u bob -- under any board.
  const bad = [];
  for (const m of MODES) {
    await ev(`(() => { ccMode = ${JSON.stringify(m)}; Bay.show('home'); return true; })()`);
    await sleep(40);
    const q = await ev(QUADS), gg = await ev(PROBE), [spr] = await ev(SPRITES('#bay .tankw img'));
    if (!q.some((b) => b.on && b.mode === m)) { bad.push(`${m}: not armed`); continue; }
    const tankCols = spr.cols.map(([l, r, t, b]) => rectPts({ l, r, t: t - 7 * u, b: b - 7 * u }));
    for (const b of q) {
      gg.chips.forEach((c, i) => { if (polysOverlap(rectPts(c), b.pts)) bad.push(`${m}: chip ${i} over ${b.mode}`); });
      if (polysOverlap(rectPts(gg.mark), b.pts)) bad.push(`${m}: brand mark over ${b.mode}`);
      if (!b.on) gg.chips.map(targetOf).forEach((t, i) => { if (polysOverlap(rectPts(t), b.pts)) bad.push(`${m}: chip ${i}'s target over resting ${b.mode}`); });
      for (const [n, p] of [['Squad box', gg.box], ['Bay stations', gg.stn]]) if (polysOverlap(rectPts(p), b.pts)) bad.push(`${m}: ${n} over ${b.mode}`);
      if (tankCols.some((col) => polysOverlap(col, b.pts))) bad.push(`${m}: the tank (its gun, or any pixel of it) under ${b.mode} at the top of its bob`);
    }
  }
  check(`[${V}] nothing overlaps, every mode armed in turn: top row vs boards, boards vs the tank's barrel, boards vs panels`, bad.length === 0, bad.slice(0, 5).join('; '));
  await ev(`(() => { ccMode = 'duel'; Bay.show('home'); return true; })()`);

  // 5. THE TANK ON ITS PLATFORM: drawTank's floor (80% down the sprite's
  //    frame, bay.js tankURL; the image is the frame and, above it, the pad
  //    it hands back in its negative margin) inside the ring, between its far
  //    rim and its middle.
  //    Before, it stood on the far rim, 7u above the platform's top.
  const floor = g.img.t + g.pad + 0.8 * (g.img.h - g.pad), platMid = g.plat.t + g.plat.h / 2;
  check(`[${V}] the tank stands inside the ring: its floor ${f1((floor - g.plat.t) / u)}u below the platform's far rim, above its middle`,
    floor > g.plat.t + 4 * u && floor < platMid, JSON.stringify({ floor, plat: g.plat }));

  // 6. WHAT RIDES WITH THE RIBBON AND WHAT STRETCHES. The platform keeps its
  //    50u to the ribbon and the battlefield window its 32u; the window starts
  //    where it always did under the boards; the panels end 4u above the
  //    ribbon and start 115u below the boards' top, both alike.
  check(`[${V}] the tank and its platform ride with the ribbon (platform middle 50u above it)`, near(g.lbar.t - platMid, 50 * u),
    `${f1((g.lbar.t - platMid) / u)}u`);
  check(`[${V}] the battlefield window stretches from under the boards to 32u above the ribbon`,
    near(g.lbar.t - g.ap.b, 32 * u) && near(g.ap.t, g.stage.t + 138 * u - ht), JSON.stringify({ ap: g.ap, lbar: g.lbar.t }));
  check(`[${V}] both side panels span from 115u under the boards' top to 4u above the ribbon`,
    [g.box, g.stn].every((p) => near(p.b, g.lbar.t - 4 * u) && near(p.t, g.boards.t + 115 * u)) && near(g.box.h, g.stn.h),
    JSON.stringify({ box: g.box, stn: g.stn, boards: g.boards.t, lbar: g.lbar.t }));
  // Bay stations spreads: equal stations of 44-60u, equal gaps of 6-20u that
  // open by --ht/3, and the stations fill the panel unless they are at 60u.
  const gaps = g.st.map((s, i) => s.t - (i ? g.st[i - 1].b : g.ph.b));
  const gapWant = Math.min(Math.max(6 * u, 6 * u + ht / 3), 20 * u);
  const contentBottom = g.stn.b - g.stnBorder - g.stnPad;
  check(`[${V}] Bay stations spreads its three stations over the height (each ${f1(g.st[0].h / u)}u, gaps ${f1(gaps[0] / u)}u)`,
    g.st.length === 3 && g.st.every((s) => near(s.h, g.st[0].h, 0.6) && s.h >= 44 * u - 0.6 && s.h <= 60 * u + 0.6)
      && gaps.every((d) => near(d, gapWant, 0.6))
      && (near(g.st[0].h, 60 * u, 0.6) ? g.st[2].b <= contentBottom + 0.6 : near(g.st[2].b, contentBottom, 0.6)),
    JSON.stringify({ st: g.st.map((s) => [f1(s.t), f1(s.h)]), gaps: gaps.map(f1), gapWant: f1(gapWant), contentBottom: f1(contentBottom) }));
  check(`[${V}] nothing on home overflows the bay`, !g.over[0] && !g.over[1], JSON.stringify(g.over));

  // 7. BAY CONTROLS: the line under each row is 13u, a reading colour, and
  //    every fixed sentence fits its row on one line.
  const set = await ev(`(() => {
    Bay.show('settings');
    const len = (css) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;width:' + css; document.body.appendChild(d); const w = d.getBoundingClientRect().width; d.remove(); return w; };
    const u = len('calc(var(--u) * 1000)') / 1000;
    const rd = [...document.querySelectorAll('#bay .row .rd')];
    const out = { scr: document.getElementById('bay').dataset.scr, n: rd.length,
      sizes: rd.map((e) => Math.round(parseFloat(getComputedStyle(e).fontSize) / u * 10) / 10),
      colours: [...new Set(rd.map((e) => getComputedStyle(e).color))],
      cut: rd.filter((e) => e.scrollWidth > e.clientWidth + 0.5).map((e) => e.textContent) };
    Bay.show('home');
    return out;
  })()`);
  const rgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
  const worst = Math.min(...set.colours.map((c) => contrast(rgb(c), [0x1b, 0x24, 0x36])));
  check(`[${V}] Bay controls: every row's line is 13u, at least 7:1 against the page's brightest background stop (${f1(worst)}:1), none cut short`,
    set.scr === 'settings' && set.n >= 10 && set.sizes.every((s) => s === 13) && worst >= 7 && set.cut.length === 0, JSON.stringify(set));

  // 8. THE WHOLE GUN, ON EVERY SCREEN THAT SHOWS THE TANK (owner, 2026-10-06:
  //    "also being cut off at the top"). drawTank's gun leaves the tank's
  //    frame through its top-right corner, 0.147 of its width to the right
  //    and 0.128 above; cut at the frame, it ended in a square corner. Now:
  //    a. every tank image draws nothing within 2px of its top and right
  //       edges, and its gun reaches past the frame (at least 0.12 of the
  //       frame's width above it and 0.14 to its right) -- the muzzle is in
  //       the image, with clear pixels round it;
  //    b. its frame stands where the screen puts it, at its own size: on a
  //       stage, on the tank's wrapper (.tankw); in a card, in the box its
  //       layout gives it, the image's margins handing back the pad;
  //    c. on the Paint shop, the gun is clear of the header and the locker.
  const SHOWS = [['home', 204], ['paint', 286], ['armoury', 164], ['setup', 56], ['career', 120]];
  const uncut = [], placed = [], shop = [];
  for (const [scr, w] of SHOWS) {
    await ev(`(() => { Bay.show(${JSON.stringify(scr)}); return true; })()`);
    await sleep(40);
    const sp = await ev(SPRITES('#bay .tankw img, #bay .crew img, #bay .cmd img'));
    if (sp.length !== 1) { uncut.push(`${scr}: ${sp.length} tank images`); continue; }
    const s = sp[0], f = s.frame, fh = Math.round(w * 246 / 300) * u;
    if (s.edgeT || s.edgeR) uncut.push(`${scr}: ${s.edgeT} drawn pixels on the top edge, ${s.edgeR} on the right`);
    if (!(s.drawn.t <= f.t - 0.12 * f.w && s.drawn.r >= f.l + 1.14 * f.w)) uncut.push(`${scr}: the gun ends ${f1((f.t - s.drawn.t) / f.w * 100) / 100} of the frame above it and ${f1((s.drawn.r - f.l - f.w) / f.w * 100) / 100} to its right`);
    // The sprite's pad as drawn: its image is the frame's height and the pad.
    // The frame is the frame's own size; on a stage it starts on the
    // wrapper; in a card the negative margins hand back exactly the pad.
    const padPx = s.img.h - fh;
    if (!(padPx > 0 && near(s.img.w - padPx, w * u, 0.6) && (s.stageImg
      ? near(f.w, w * u, 0.5) && near(s.img.t + padPx, f.t, 0.6) && near(s.img.l, f.l, 0.5)
      : near(s.img.mt, padPx, 0.6) && near(s.img.mr, padPx, 0.6))))
      placed.push(`${scr}: frame ${JSON.stringify(f)}, image ${JSON.stringify(s.img)}, pad ${f1(padPx)}`);
    if (scr === 'paint') {
      // what is drawn above the frame: the gun, and the pennant's tip
      const gun = s.cols.filter((c) => c[2] < f.t).map(([l, r, t, b]) => rectPts({ l, r, t, b: Math.min(b, f.t) }));
      const boxes = await ev(`(() => { const R = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
        return { head: R(document.querySelector('#bay .phead')), locker: R([...document.querySelectorAll('#bay .card')].find((c) => c.querySelector('.swg'))) }; })()`);
      for (const [n, bx] of Object.entries(boxes)) if (gun.some((c) => polysOverlap(c, rectPts(bx)))) shop.push(`the gun under the ${n}`);
      if (!gun.length) shop.push('no gun above the frame');
    }
  }
  await ev(`(() => { Bay.show('home'); return true; })()`);
  check(`[${V}] the whole gun is in every tank image (home, Paint shop, Armoury, Match setup, Service record): nothing drawn on its top or right edge, the muzzle past the frame`, uncut.length === 0, uncut.join('; '));
  check(`[${V}] every tank's frame stands where its screen puts it, the size it always was`, placed.length === 0, placed.join('; '));
  check(`[${V}] on the Paint shop the gun is clear of the header and the Paint locker`, shop.length === 0, shop.join('; '));
}

// ---- two linked accounts still fit the Account row ---------------------------
// The Account row's line is one line per linked provider (bay.js accDesc):
// with both linked it is two lines of 13u under the name, inside the 52u row.
{
  await open(VIEWS[0]);
  const fit = await ev(`(() => {
    const b = $('accountBtn'); b.classList.remove('hidden'); b.dataset.state = 'in';
    window.CC_ACCOUNT = {anonymous:false,google:true,apple:true,email:'me@gmail.example',accounts:[{provider:'apple',email:'x7q2p@privaterelay.appleid.com'},{provider:'google',email:'me@gmail.example'}]};
    document.dispatchEvent(new CustomEvent('cc:account'));
    Bay.show('settings');
    const r = [...document.querySelectorAll('#bay .row')].find((x) => x.querySelector('.rn2') && x.querySelector('.rn2').textContent === 'Account');
    const len = (css) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;width:' + css; document.body.appendChild(d); const w = d.getBoundingClientRect().width; d.remove(); return w; };
    const u = len('calc(var(--u) * 1000)') / 1000;
    const rr = r.getBoundingClientRect(), rt = r.querySelector('.rt').getBoundingClientRect();
    const out = { lines: r.querySelectorAll('.rd .acl').length, rowH: Math.round(rr.height / u * 10) / 10, inside: rt.top >= rr.top - 0.5 && rt.bottom <= rr.bottom + 0.5,
      svg: Math.round(r.querySelector('.rd .acl svg').getBoundingClientRect().width / u * 10) / 10 };
    Bay.show('home');
    return out;
  })()`);
  check('[667x375] two linked accounts: two 13u lines with 12u marks inside the 52u Account row', fit.lines === 2 && fit.rowH === 52 && fit.inside && fit.svg === 12, JSON.stringify(fit));
}

check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
clearTimeout(watchdog);
cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
