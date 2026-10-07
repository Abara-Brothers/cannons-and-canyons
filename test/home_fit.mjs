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
//   5. The Service record (owner, 2026-10-07): "the text gets cut off on the
//      right. all the text must be visible and easy to read. You must allow
//      the player to scroll through the challenges." Every word on the screen
//      is on the screen, every challenge a whole row in a list that scrolls by
//      touch, fades where there is more, and reaches all twelve.
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
// A CARD'S TANK AND WHAT HOLDS IT (check 8d): every column the sprite draws,
// as SPRITES reads them; the card it stands in, by its inner edges (inside the
// border) -- a lobby seat is its own card; the row it lays out in (its
// parent); and every other box in that row.
const CARD_TANK = (sel) => `(async () => {
  const img = document.querySelector(${JSON.stringify(sel)});
  if (!img) return null;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const q = c.getContext('2d'); q.drawImage(img, 0, 0);
  const d = q.getImageData(0, 0, W, H).data;
  const b = img.getBoundingClientRect(), kx = b.width / W, ky = b.height / H;
  const cols = [];
  for (let x = 0; x < W; x++) {
    let t = -1, e = -1;
    for (let y = 0; y < H; y++) if (d[(y * W + x) * 4 + 3] > 0) { if (t < 0) t = y; e = y; }
    if (t >= 0) cols.push([b.left + x * kx, b.left + (x + 1) * kx, b.top + t * ky, b.top + (e + 1) * ky]);
  }
  const R = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const card = img.closest('.seat') || img.closest('.card'), cs = getComputedStyle(card), cr = R(card);
  const inner = { l: cr.l + parseFloat(cs.borderLeftWidth), t: cr.t + parseFloat(cs.borderTopWidth), r: cr.r - parseFloat(cs.borderRightWidth), b: cr.b - parseFloat(cs.borderBottomWidth) };
  const row = img.parentElement;
  const beside = [...row.children].filter((e) => e !== img && e.getClientRects().length > 0).map((e) => ({ n: e.className || e.tagName.toLowerCase(), ...R(e) }));
  return { cols, card: card.className, inner, row: R(row), beside };
})()`;
// THE SERVICE RECORD AS IT IS DRAWN (check 9), in CSS px. `text`: every node
// on the screen that holds words of its own, by the box of those words (a
// Range, so a line that runs on past its element is caught), and every box
// that clips it on the way up -- its overflow is not visible -- by its inner
// edges. `rows`: each challenge row's name, description and reward line by
// their font size in u and whether they are cut (wider than their box, or
// taller than a box that clips), and the box the row gives its words (inside its
// border and padding). `reach`: each row's top and bottom against the list's
// once the list is scrolled to put that row at its top -- or as far as it
// goes, for the last rows -- and the list put back where it was. The fade is
// the list's bottom 56u (styles.css THE CHALLENGES LIST).
const CAREER = `(() => {
  const len = (css) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:-9999px;top:0;height:0;width:' + css; document.body.appendChild(d); const w = d.getBoundingClientRect().width; d.remove(); return w; };
  const u = len('calc(var(--u) * 1000)') / 1000;
  const sa = { l: len('var(--sa-l)'), r: len('var(--sa-r)') };
  const R = (b) => ({ l: b.left, t: b.top, r: b.right, b: b.bottom });
  const words = (e) => { const g = document.createRange(); g.selectNodeContents(e); return R(g.getBoundingClientRect()); };
  const inner = (e) => { const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return { l: b.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), r: b.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) }; };
  const stage = document.querySelector('#bay .stage'), list = document.querySelector('#bay .achs');
  const text = [];
  for (const e of stage.querySelectorAll('*')) {
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.data.trim()) || !e.getClientRects().length) continue;
    const clips = [];
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === 'visible') continue;
      const b = a.getBoundingClientRect();
      clips.push({ n: a.className || a.id, l: b.left + a.clientLeft, r: b.left + a.clientLeft + a.clientWidth });
    }
    text.push({ s: e.textContent.trim().slice(0, 40), w: words(e), clips });
  }
  const fs = (e) => e ? Math.round(parseFloat(getComputedStyle(e).fontSize) / u * 10) / 10 : null;
  // Down, only where the box clips: a 15u Rajdhani name on a 1.1 line stands
  // a pixel taller than its line box at some sizes, and shows every pixel.
  const cut = (e) => !!e && (e.scrollWidth > e.clientWidth + 0.5 || (getComputedStyle(e).overflowY !== 'visible' && e.scrollHeight > e.clientHeight + 0.5));
  const rows = [...list.querySelectorAll('.b-ach')].map((r) => {
    const an = r.querySelector('.an'), ad = r.querySelector('.ad'), ar = r.querySelector('.ar'), box = inner(r);
    const out = [an, ad, ar].filter(Boolean).filter((e) => { const w = words(e); return w.l < box.l - 0.5 || w.r > box.r + 0.5; }).map((e) => e.className);
    const rb = r.getBoundingClientRect();
    return { name: an ? an.textContent : '', reward: ar ? ar.textContent : null, fs: { an: fs(an), ad: fs(ad), ar: fs(ar) }, x: [rb.left, rb.right],
      cut: [an, ad, ar].filter(cut).map((e) => e.className), out, colour: ad ? getComputedStyle(ad).color : '' };
  });
  const lb = list.getBoundingClientRect(), cs = getComputedStyle(list);
  const keep = list.scrollTop;
  list.scrollTop = 0;
  const atTop = { st: list.scrollTop, under: [...list.querySelectorAll('.b-ach')].filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > lb.bottom - 56 * u + 0.5 && b.top < lb.bottom - 0.5; }).length };
  const reach = [...list.querySelectorAll('.b-ach')].map((r) => {
    list.scrollTop = r.getBoundingClientRect().top - lb.top + list.scrollTop;
    const b = r.getBoundingClientRect();
    return { t: b.top - lb.top, b: b.bottom - lb.top };
  });
  list.scrollTop = keep;
  return { u, sa, iw: innerWidth, scr: document.getElementById('bay').dataset.scr, achs: (typeof ACHS !== 'undefined' ? ACHS : []).map((a) => a[1]),
    list: { ...R(lb), h: list.clientHeight, sh: list.scrollHeight, sw: list.scrollWidth, cw: list.clientWidth, oy: cs.overflowY, ox: cs.overflowX,
      mask: cs.maskImage && cs.maskImage !== 'none' ? cs.maskImage : (cs.webkitMaskImage || 'none') },
    text, rows, atTop, reach };
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
  //       layout gives it, the image's margins handing back the pad (and
  //       drawn tankImg's `drop` lower than that box: d);
  //    c. on the Paint shop, the gun is clear of the header and the locker;
  //    d. a card's tank keeps its whole gun inside its card: Match setup's
  //       crew card (in every mode -- Duel and Free-for-all leave the card no
  //       room above its row), the Service record card and the lobby seat.
  //       The topmost pixel the sprite draws is at least 2u under the card's
  //       top border, every pixel it draws is inside the card and inside its
  //       own row, and none is over anything beside it in that row.
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
  // d. The lobby is a room's own (app.js renderLobby, the payload the bay
  //    reads): this player in the first seat, of a duel's two and of a
  //    free-for-all's four.
  const CARDS = [...MODES.map((m) => ['setup', m, '#bay .crew img']), ['career', null, '#bay .cmd img'], ['lobby', 'duel', '#bay .seat img'], ['lobby', 'ffa', '#bay .seat img']];
  const inCard = [];
  for (const [scr, m, sel] of CARDS) {
    const lob = { type: 'lobby', code: 'ABCD', mode: m, max: m === 'ffa' ? 4 : 2, you: 0, host: 0, players: [{ name: 'TESTPILOT', skin: 'olive' }, { name: 'Bunker Nine', skin: 'desert' }] };
    await ev(`(() => { ${scr === 'lobby' ? `renderLobby(${JSON.stringify(lob)});` : `ccMode = ${JSON.stringify(m || 'duel')};`} Bay.show(${JSON.stringify(scr)}); return true; })()`);
    await sleep(40);
    const k = await ev(CARD_TANK(sel)), n = scr + (m ? ' ' + m : '');
    if (!k || !k.cols.length) { inCard.push(`${n}: no tank drawn`); continue; }
    const dr = { l: k.cols[0][0], r: k.cols[k.cols.length - 1][1], t: Math.min(...k.cols.map((c) => c[2])), b: Math.max(...k.cols.map((c) => c[3])) };
    const clear = (dr.t - k.inner.t) / u, inside = (o) => dr.l >= o.l - 0.01 && dr.r <= o.r + 0.01 && dr.t >= o.t - 0.01 && dr.b <= o.b + 0.01;
    const why = [];
    if (!(clear >= 2)) why.push(`the gun's top is ${f1(clear)}u under the top border of its card (.${k.card}), not 2u`);
    if (!inside(k.inner)) why.push(`drawn ${f1((dr.t - k.inner.t) / u)}..${f1((dr.b - k.inner.t) / u)}u down, it leaves its card (${f1((k.inner.b - k.inner.t) / u)}u inside)`);
    if (!inside(k.row)) why.push(`drawn ${f1((dr.t - k.row.t) / u)}..${f1((dr.b - k.row.t) / u)}u down its row, it leaves the row (${f1((k.row.b - k.row.t) / u)}u)`);
    for (const s of k.beside) if (k.cols.some(([l, r, t, b]) => rectsOverlap({ l, r, t, b }, s))) why.push(`it is over .${s.n} beside it`);
    if (why.length) inCard.push(`${n}: ${why.join(', ')}`);
  }
  // e. MATCH SETUP FITS WITHOUT SCROLLING, in every mode as it opens (Computer
  //    or Solo): its left column holds Play with, at most one row of options
  //    and the crew card, and everything the card holds -- the tank row, the
  //    rule, the rack with its Edit -- lies inside the card's border. The
  //    free-for-all's CPU count and difficulty share one row; as a third row
  //    they pushed the card below a scrolling fold.
  const setupFit = [];
  for (const m of MODES) {
    await ev(`(() => { ccMode = ${JSON.stringify(m)}; Bay.show('home'); Bay.show('setup'); return true; })()`);
    await sleep(40);
    const s = await ev(`(() => {
      const col = document.querySelector('#bay .cols > div'), card = col && col.querySelector(':scope > .card');
      if (!card) return null;
      const R = (e) => { const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right }; };
      const cs = getComputedStyle(card), cr = R(card);
      const inner = { t: cr.t + parseFloat(cs.borderTopWidth), b: cr.b - parseFloat(cs.borderBottomWidth) };
      const kids = [...card.querySelectorAll(':scope > *, :scope .lbl, :scope .slots, :scope button')].filter((e) => e.getClientRects().length).map(R);
      const opts = [...col.querySelectorAll('.b-opt:not(.hidden)')].map((e) => ({ n: e.querySelector('.lbl').textContent, ...R(e) }));
      return { sh: col.scrollHeight, ch: col.clientHeight, inner, kids, opts };
    })()`);
    if (!s) { setupFit.push(`${m}: no crew card`); continue; }
    const why = [];
    if (s.sh > s.ch + 1) why.push(`the column scrolls (${s.sh} in ${s.ch})`);
    const out = s.kids.filter((k) => k.t < s.inner.t - 0.5 || k.b > s.inner.b + 0.5);
    if (out.length) why.push(`${out.length} of the card's boxes leave its border (${out.map((k) => f1((k.t - s.inner.t) / u) + '..' + f1((k.b - s.inner.t) / u) + 'u').join(', ')} in ${f1((s.inner.b - s.inner.t) / u)}u)`);
    const rows = new Set(s.opts.map((o) => Math.round(o.t)));
    if (rows.size > 2) why.push(`${rows.size} rows of options (${s.opts.map((o) => o.n).join(', ')})`);
    if (m === 'ffa') {
      const c = s.opts.find((o) => /CPU commanders/i.test(o.n)), d = s.opts.find((o) => /Difficulty/i.test(o.n));
      if (!(c && d && near(c.t, d.t) && c.r <= d.l)) why.push('the CPU count and the difficulty are not side by side');
    }
    if (why.length) setupFit.push(`${m}: ${why.join('; ')}`);
  }
  check(`[${V}] Match setup fits as it opens in every mode: two rows of options at most, the column never scrolls, and the crew card holds its tank and rack inside its border`, setupFit.length === 0, setupFit.join('; '));
  await ev(`(() => { ccMode = 'duel'; Bay.show('home'); return true; })()`);
  check(`[${V}] the whole gun is in every tank image (home, Paint shop, Armoury, Match setup, Service record): nothing drawn on its top or right edge, the muzzle past the frame`, uncut.length === 0, uncut.join('; '));
  check(`[${V}] every tank's frame stands where its screen puts it, the size it always was`, placed.length === 0, placed.join('; '));
  check(`[${V}] on the Paint shop the gun is clear of the header and the Paint locker`, shop.length === 0, shop.join('; '));
  check(`[${V}] every card's tank keeps its whole gun inside its card, 2u under the top border, and stays in its row (Match setup in every mode, Service record, a lobby seat)`, inCard.length === 0, inCard.join('; '));

  // 9. THE SERVICE RECORD (owner, 2026-10-07). At 874x402 the challenges'
  //    right column ran off the screen ("Win a battle with 5 Health or less
  //    rema", "Finish an enemy with the Tactical Nuk"), and the player could
  //    not scroll to the rest. Now:
  //    a. every word on the screen is inside the safe box and inside every
  //       box that clips it -- not only the challenges;
  //    b. the twelve challenges are twelve rows, in order, one column, and no
  //       name, description or reward line is cut, across or down, or runs
  //       past its row;
  //    c. the list scrolls up and down and never across, and at its top the
  //       rows that do not fit run under a fade: there is more, and it shows;
  //    d. every row can be scrolled to where all of it is above the fade;
  //    e. a finger's drag on the list scrolls it, and the page under it does
  //       not move;
  //    f. legible: names at least 13u, descriptions and reward lines at
  //       least 12u, the description at least 7:1 against the page's
  //       brightest background stop (Bay controls' measure);
  //    g. the two challenges that hand over a paint say which, before and
  //       after it is earned, and no other row claims one.
  await ev(`(() => { delete PROF.ach.untouchable; Bay.show('career'); return true; })()`);
  await sleep(40);
  const car = await ev(CAREER);
  const FADE = 56 * u;                              // styles.css THE CHALLENGES LIST: the mask's 56u
  const lost = car.text.filter((x) => x.w.l < car.sa.l - 0.5 || x.w.r > car.iw - car.sa.r + 0.5
    || x.clips.some((c) => x.w.l < c.l - 0.5 || x.w.r > c.r + 0.5)).map((x) => `"${x.s}" ${f1(x.w.l)}-${f1(x.w.r)}`);
  check(`[${V}] Service record: every word on the screen is inside the safe box and inside whatever clips it (${car.text.length} lines of text)`,
    car.scr === 'career' && car.text.length >= 40 && lost.length === 0, lost.slice(0, 4).join('; '));
  const names = car.rows.map((r) => r.name);
  const rowsBad = car.rows.filter((r) => r.cut.length || r.out.length).map((r) => `${r.name}: cut ${r.cut.join('/')} past ${r.out.join('/')}`);
  const oneCol = car.rows.length > 1 && car.rows.every((r) => near(r.x[0], car.rows[0].x[0], 0.5) && near(r.x[1], car.rows[0].x[1], 0.5));
  check(`[${V}] Service record: all ${car.achs.length} challenges are rows in one column, in order, and no name, description or reward line is cut or runs past its row`,
    car.achs.length === 12 && JSON.stringify(names) === JSON.stringify(car.achs) && oneCol && rowsBad.length === 0, rowsBad.slice(0, 4).join('; ') || JSON.stringify(names));
  const L = car.list;
  check(`[${V}] Service record: the challenges scroll up and down, never across, inside the screen, and at the top the rows that do not fit run under a fade (${car.atTop.under} under it)`,
    L.oy === 'auto' && L.ox === 'hidden' && L.sh > L.h + 1 && L.sw <= L.cw && L.r <= car.iw - car.sa.r + 0.5 && L.l >= car.sa.l - 0.5
      && /linear-gradient/.test(L.mask) && /rgba\(0, 0, 0, 0\)|transparent/.test(L.mask) && car.atTop.st === 0 && car.atTop.under >= 1,
    JSON.stringify({ ...L, atTop: car.atTop }));
  const unreached = car.reach.map((r, i) => (r.t >= -0.5 && r.b <= L.h - FADE + 0.5 ? null : `${names[i]} ${f1(r.t)}-${f1(r.b)} of ${f1(L.h)}`)).filter(Boolean);
  check(`[${V}] Service record: every challenge, the last included, scrolls to where the whole row is above the fade`, car.reach.length === 12 && unreached.length === 0, unreached.join('; '));
  {
    const c = await ev(`(() => { const l = document.querySelector('#bay .achs'); l.scrollTop = 0; const b = l.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height * 0.7), d: Math.round(b.height * 0.5) }; })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
    for (let i = 1; i <= 8; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x, y: c.y - Math.round(c.d * i / 8) }] }); await sleep(16); }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
    const s = await ev(`(() => { const l = document.querySelector('#bay .achs'), st = l.scrollTop; l.scrollTop = 0; return { st, bay: document.getElementById('bay').scrollTop, doc: document.scrollingElement.scrollTop, x: scrollX, y: scrollY }; })()`);
    check(`[${V}] Service record: a finger dragged up the list scrolls it (${f1(s.st)}px) and the page stays put`, s.st >= 20 && !s.bay && !s.doc && !s.x && !s.y, JSON.stringify(s));
  }
  const rgbOf = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
  const small = car.rows.filter((r) => !(r.fs.an >= 13 && r.fs.ad >= 12 && (r.fs.ar === null || r.fs.ar >= 12))).map((r) => `${r.name} ${JSON.stringify(r.fs)}`);
  const dim = Math.min(...car.rows.map((r) => contrast(rgbOf(r.colour), [0x1b, 0x24, 0x36])));
  check(`[${V}] Service record: names at least 13u, descriptions and reward lines at least 12u, descriptions ${f1(dim)}:1 against the page (at least 7:1)`,
    car.rows.length === 12 && small.length === 0 && dim >= 7, small.slice(0, 3).join('; '));
  const earned = await ev(`(() => { PROF.ach.untouchable = true; Bay.show('career'); const r = [...document.querySelectorAll('#bay .b-ach')].map((x) => [x.querySelector('.an').textContent, x.classList.contains('got'), (x.querySelector('.ar') || {}).textContent || null]); delete PROF.ach.untouchable; Bay.show('home'); return r; })()`);
  const rewards = car.rows.filter((r) => r.reward !== null).map((r) => `${r.name}: ${r.reward}`);
  const after = earned.filter((r) => r[2] !== null).map((r) => `${r[0]}${r[1] ? ' (earned)' : ''}: ${r[2]}`);
  check(`[${V}] Service record: the two paint challenges say which paint they hand over, and say so once it is earned`,
    JSON.stringify(rewards) === JSON.stringify(['Untouchable: Unlocks the Arctic paint', 'Under Par: Unlocks the Gold paint'])
      && JSON.stringify(after) === JSON.stringify(['Untouchable (earned): Arctic paint unlocked', 'Under Par: Unlocks the Gold paint']),
    JSON.stringify({ rewards, after }));
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
