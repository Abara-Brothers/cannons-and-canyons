// The cold-start intro (public/intro.js), in a real page.
//
// WHAT THIS PROVES. The owner's hard requirement is that the end of the intro
// IS the menu: the last frame and the first frame of the dashboard are the
// same picture, and that stays true when the dashboard changes. So the centre
// of this suite is the seam, checked four ways that do not depend on knowing
// what the dashboard looks like:
//   - the canvas is fully transparent on every frame of the hand-off;
//   - every element's computed style is identical in the last intro frame and
//     after the intro has removed itself;
//   - after the intro, a bay redraw (the morph re-asserts every attribute from
//     the template) finds NOTHING to change, and the #bay subtree equals a load
//     that never played the intro;
//   - every part of home stands in the last intro frame exactly where it stands
//     after it -- including on an iPhone 17's safe areas, where home stretches
//     to the safe box (U5, 2026-10-06) and the ribbon ends on its bottom.
// Around that: no frame of the dashboard before the doors (A1), when it must
// not play (A4-A6), skipping (A7), the menu redrawing itself mid-intro (A8), a
// slow menu (A9), a dashboard element the intro has never seen (A10), leaving
// home mid-intro, faults inside the intro (A11), and the iOS launch image
// still being the intro's own frame 0 (A15). Criteria are numbered as
// in the governance spec, docs/superpowers/specs/2026-10-02-cold-start-intro-design.md.
// V9 (owner, 2026-10-07) adds the quick doors: a reopen within ten minutes of
// last use, a held seat, a link and reduced motion get no intro and no cut,
// but the sealed doors -- the launch image's own frame 0 -- opening in about
// half a second onto the last view or the match (faded under reduced motion);
// after ten minutes the intro again; and the native launch hold let go once on
// every path. A held seat the server no longer has opens onto home, and only
// once the doors have gone does home say "That match ended while you were
// away."; a match against the computer comes back from past the old empty-room
// hold (owner, 2026-10-07, item 21). The round 2 review adds: the last view is
// kept the moment it changes and its time while the page is on screen, so a
// kill with no word (the iOS app switcher) still reopens onto it; no toast is
// drawn on the quick doors and none is lost; and a native sign-in return gets
// the quick doors. ROUND 3 (owner, 2026-10-10, "Stay shut until ready"): the
// doors stay shut until the last view is ready, under a safety limit of about
// 15 s instead of 3; while a held seat's resume is out they say
// "Reconnecting..." after a second; no frame shows home behind them on the way
// to a match; nothing stands over them; and after ten minutes the full intro
// still ends on the main menu.
//
// Self-hosted (its own server and Chrome on free ports, never 3000). Skips
// cleanly (exit 3) without Chrome, like every other client-side suite.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCanvasRGB, decodeRGB } from '../tools/splash/doors-png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.log(`SKIP  intro tests — no Chrome at ${CHROME}`);
  console.log('      (set CHROME_PATH to run them)');
  process.exit(3);
}

// RUN_MS only catches a CDP peer that stopped answering. The round 2 review's
// checks (a 16.5 s wait for the last view's beat among them) took a whole run
// from about 170 s to about 200 s on an idle machine, so the ceiling went from
// 300 s to 420 s, which leaves a busy machine at least the room it had.
// Round 3 adds waits of 15 s (twice), 5 s (twice), 4.5 s and 4 s for the
// doors, four more held matches and a full intro played to its end, about
// 80 s in all (a whole run took 4 min 35 s on 2026-10-10), so the ceiling
// goes to 540 s for the same reason.
const CDP_MS = 20000, RUN_MS = 540000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const get = (url) => fetch(url, { signal: AbortSignal.timeout(4000) });

let srv = null, chrome = null, profile = null, failed = 0, passed = 0;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {}
  try { srv && srv.kill('SIGTERM'); } catch {}
  try { profile && rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
setTimeout(() => { console.error(`FAIL  intro overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS).unref();

// A thrown error anywhere is a reported FAIL with the count so far, never a
// silent abort that hides which checks did not run.
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, (e) => {
  console.log(`FAIL  the suite crashed: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  cleanup(); process.exit(1);
});
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? '\n      ' + detail : ''}`); }
}

// ---- server and browser -----------------------------------------------------
const appPort = await freePort();
// EMPTY_ROOM_GRACE_MS is cut to a second so that V9's held seat is brought
// back from past the hold that used to end a match against the computer (half
// an hour, by default): only the day a match with no other human now waits
// (room-engine.js SOLO_HOLD_MS) can bring it back, as the owner asked.
const OLD_HOLD_MS = 1000;
srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort), EMPTY_ROOM_GRACE_MS: String(OLD_HOLD_MS) }, stdio: ['ignore', 'pipe', 'pipe'] });
let up = false;
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { console.error('FAIL  server never came up'); process.exit(1); }
const BASE = `http://127.0.0.1:${appPort}/`;

const dbgPort = await freePort();
profile = join(tmpdir(), `cc-intro-${dbgPort}`);
rmSync(profile, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try { const v = await (await get(`http://127.0.0.1:${dbgPort}/json/version`)).json(); if (v.webSocketDebuggerUrl) { wsUrl = v.webSocketDebuggerUrl; break; } } catch {}
  await sleep(250);
}
if (!wsUrl) { console.error('FAIL  Chrome exposed no debugger'); process.exit(1); }

// One browser socket, one flattened session per page.
let mid = 0;
const pending = new Map(), listeners = new Map();
const ws = new WebSocket(wsUrl);
await Promise.race([new Promise((r) => { ws.onopen = r; }), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (m.method && m.sessionId && listeners.has(m.sessionId)) listeners.get(m.sessionId)(m);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const i = ++mid;
  const t = setTimeout(() => { pending.delete(i); reject(new Error(`CDP ${method} gave no answer in ${CDP_MS} ms`)); }, CDP_MS);
  pending.set(i, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (er) => { clearTimeout(t); reject(er); } });
  ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }));
});

// The page's own instrumentation, installed before any page script runs.
//   A1: the first time #bay .stage exists, and on every frame until the
//       reveal, the intro canvas must be opaque everywhere on a sample grid.
//   A3: on every frame of the hand-off the canvas must be fully transparent.
//   Seam: computed style of every #bay element in the first frame at
//       tp >= 5960, to compare with the same elements after the intro.
const INSTR = `(() => {
  const S = window.__t = { stageSeen: false, coverAtStage: null, a1Checks: 0, a1Fails: [], a3Frames: 0, a3Max: 0, seam: null, geo: null, errors: 0, clicks: 0, revealOpacity: null, start: null, drive: null, rest: null };
  addEventListener('error', () => { S.errors++; });
  addEventListener('unhandledrejection', () => { S.errors++; });
  document.addEventListener('click', () => { S.clicks++; });
  function alphaRange(cv) {
    const q = cv.getContext('2d'), w = cv.width, h = cv.height; let mn = 255, mx = 0;
    for (let i = 0; i < 9; i++) for (let j = 0; j < 7; j++) {
      const a = q.getImageData(Math.floor((i + .5) * w / 9), Math.floor((j + .5) * h / 7), 1, 1).data[3];
      if (a < mn) mn = a; if (a > mx) mx = a;
    }
    return [mn, mx];
  }
  new MutationObserver((recs, ob) => {
    if (!document.querySelector('#bay .stage')) return;
    ob.disconnect(); S.stageSeen = true;
    const cv = document.getElementById('intro');
    S.coverAtStage = cv ? alphaRange(cv)[0] : -1;
  }).observe(document, { childList: true, subtree: true });
  const PROPS = ['opacity', 'translate', 'scale', 'filter', 'clip-path', 'visibility', 'transform'];
  // Geometry: where the menu's parts stand, in CSS px. The chrome and the
  // boards by their drawn boxes; the tank and its platform by their laid-out
  // boxes, because the tank's idle bob moves its drawn box from frame to frame.
  window.__geo = function () {
    const R = (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((n) => Math.round(n * 100) / 100); };
    const L = (e) => { let x = 0, y = 0; for (let n = e; n && n.id !== 'bay'; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; } return [x, y, e.offsetWidth, e.offsetHeight]; };
    const all = (s) => Array.from(document.querySelectorAll('#bay .stage ' + s)), st = document.querySelector('#bay .stage');
    return {
      stage: st ? R(st) : null,
      top: all('> .top').map(R), chips: all('.top .chip').map(R), cards: all('.boards .bcard').map(R),
      pnl: all('> .pnl').map(R), lbar: all('> .lbar').map(R), ap: all('> .ap').map(R),
      tankw: all('> .tankw').map(L), plat: all('> .plat').map(L),
    };
  };
  // The intro's own tank: its two layers in the wrapper it appends to .tankw,
  // beside the menu's own image. Mid-drive, the point the hull pitches about
  // (the second translate in its transform) and the pivot the barrel layer
  // turns about (the fourth, after the hull's three), with the frame they are
  // measured on; at rest, where the wrapper and the image stand, the layers'
  // transforms and their clips.
  function introTank() {
    const tw = document.querySelector('#bay .stage .tankw'), wrap = tw && tw.querySelector('[data-intro]');
    const imgs = tw ? Array.from(tw.querySelectorAll(':scope > img')) : [];
    return wrap && imgs.length ? { wrap, img: imgs[imgs.length - 1], cvs: Array.from(wrap.querySelectorAll('canvas')) } : null;
  }
  window.__driveGeo = function () {
    const t = introTank(); if (!t || t.cvs.length !== 2) return null;
    const tf = t.cvs[1].style.transform, m = tf.match(/translate\\(([-0-9.]+)px, ?([-0-9.]+)px\\)/g) || [];
    const xy = (k) => (m[k] ? m[k].match(/[-0-9.]+/g).map(Number) : null), ic = getComputedStyle(t.img);
    return { pivot: xy(3), hull: xy(1), w: parseFloat(getComputedStyle(t.wrap).width), h: parseFloat(getComputedStyle(t.wrap).height), tf,
      frameW: parseFloat(getComputedStyle(t.img.parentElement).width), pad: -parseFloat(ic.marginTop) || 0, imgH: parseFloat(ic.height) };
  };
  // The drive's first frames (still cruising): how far left the hull is, the
  // tp it was drawn at, and, as laid out in the stage (computed styles, so
  // the rotation shim reads the same), the tank's frame (.tankw) and the
  // backdrop's left edge (.ap); both stand in .stage, neither transformed.
  window.__startGeo = function (tp) {
    const t = introTank(); if (!t || t.cvs.length !== 2) return null;
    const m = t.cvs[0].style.transform.match(/translate\\(([-0-9.]+)px/);
    const tw = getComputedStyle(document.querySelector('#bay .stage > .tankw')), ap = getComputedStyle(document.querySelector('#bay .stage > .ap'));
    const rotated = getComputedStyle(document.documentElement).getPropertyValue('--rotated').trim() === '1';
    return { tp, dx: m ? +m[1] : null, frameL: parseFloat(tw.left), frameW: parseFloat(tw.width), apL: parseFloat(ap.left), apTf: ap.transform,
      rotated, bob: new DOMMatrixReadOnly(tw.transform === 'none' ? undefined : tw.transform).f };
  };
  window.__restGeo = function () {
    const t = introTank(); if (!t || t.cvs.length !== 2) return null;
    const R = (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; };
    return { wrap: R(t.wrap), img: R(t.img), tf: t.cvs.map((c) => getComputedStyle(c).transform), clips: t.cvs.map((c) => getComputedStyle(c).clipPath),
      sizes: t.cvs.map((c) => [c.width, c.height]), nat: [t.img.naturalWidth, t.img.naturalHeight], opacity: getComputedStyle(t.wrap).opacity };
  };
  window.__snap = function () {
    return Array.from(document.querySelectorAll('#bay *')).map((el) => {
      const cs = getComputedStyle(el), anim = el.getAnimations ? el.getAnimations().length > 0 : false;
      return [el.tagName, el.className && el.className.baseVal === undefined ? el.className : '', anim ? null : PROPS.map((p) => cs.getPropertyValue(p))];
    });
  };
  // THE QUICK DOORS, frame by frame (V9): how far they have opened, where
  // they stand, the canvas's own opacity, what is under them, and three
  // canvas readings -- the middle of the screen and a point well inside each
  // door -- plus a ring of points round the top-left beacon, which must turn
  // while the doors hold, and how many toasts are up (round 2 review: none
  // may be drawn on the doors). At the first frame they open: what they open
  // onto, and whether anything in the bay is still animating its entrance.
  // ROUND 3 (owner, 2026-10-10: the doors stay shut until the last view is
  // ready, up to about 15 s, and say "Reconnecting..." while a held seat's
  // resume is out): each frame also reads the words' line on the doors (lit),
  // what intro.js says of them (label), whether the bay is on screen and the
  // connection banner up, and how many times app.js has drawn the match
  // (draws, from DRAWS, when a case installs it). A wait of up to 15 s is
  // about 900 frames, so rows are kept for the first 400 frames and for every
  // frame that shows anything behind the doors, and S.qa counts what must hold
  // on EVERY frame, kept or not: the shut doors cover the screen, nothing is
  // up over them, and when the words are said and drawn. Every 15th frame the
  // whole page is looked at for anything that could be drawn over the doors.
  // ROUND 3 REVIEW (the doors stay shut "studio mark and beacons lit", under
  // reduced motion as well): each frame also reads the light at the top-left
  // beacon's centre (beacon) and along one row of device pixels through the
  // studio mark's letters (mark, the channels summed).
  S.quick = [];
  S.qa = { n: 0, shut: 0, notOpaque: 0, toast: 0, mg: 0, conn: 0, scans: 0, over: [], labelFirst: null, litFirst: null, early: 0, full: 0, fullUnlit: 0, spinN: 0, spinMoved: 0, ring: '' };
  function px(cv, x, y) { const q = cv.getContext('2d'); return q.getImageData(Math.max(0, Math.min(cv.width - 1, Math.round(x))), Math.max(0, Math.min(cv.height - 1, Math.round(y))), 1, 1).data; }
  // How many device pixels are lit on one row through the middle of where
  // intro.js sets its words (status.labelGeo), 90 stage units either side of
  // the seam, counted for each door: [left, right]. The doors there are dark
  // and the words light, so a channel average over 120 is a letter.
  function lit(cv, I, g, d) {
    const L = I.labelGeo; if (!L) return [0, 0];
    const y = Math.round((g[1] + L[1] * g[2]) * d), x0 = Math.round((g[0] + (L[0] - 90) * g[2]) * d), w = Math.max(2, Math.round(180 * g[2] * d));
    const a = cv.getContext('2d').getImageData(x0, y, w, 1).data, seam = (g[0] + L[0] * g[2]) * d - x0, n = [0, 0];
    for (let i = 0; i < a.length; i += 4) if (a[i + 3] > 0 && (a[i] + a[i + 1] + a[i + 2]) / 3 > 120) n[i / 4 < seam ? 0 : 1]++;
    return n;
  }
  // Anything that could be drawn over the doors, whose canvas stands at its
  // own z-index (89) among #app's children: in #app, anything drawn with a
  // z-index as high or higher (counting one inside a lower stacking context
  // too, which only errs on the strict side); outside #app, anything
  // positioned and drawn. The toast layer is the one thing above (z 90), and
  // is drawn only while it holds a toast.
  function overDoors(cv) {
    const app = document.getElementById('app'), out = [], zc = parseInt(getComputedStyle(cv).zIndex, 10);
    for (const el of document.body.querySelectorAll('*')) {
      if (el === cv || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (app.contains(el) ? !(parseInt(cs.zIndex, 10) < zc) && cs.zIndex !== 'auto' : cs.position !== 'static') out.push(el.id || String(el.className) || el.tagName);
    }
    return out;
  }
  // The row through the mark: intro.js sets the mark 466 stage units wide
  // from x 233, and the middle of its letters ABARA 219.5 units down.
  function markLine(cv, g, d) {
    const y = Math.round((g[1] + 219.5 * g[2]) * d), x0 = Math.round((g[0] + 233 * g[2]) * d), w = Math.max(2, Math.round(466 * g[2] * d));
    const a = cv.getContext('2d').getImageData(x0, y, w, 1).data;
    let n = 0;
    for (let i = 0; i < a.length; i += 4) n += a[i] + a[i + 1] + a[i + 2];
    return n;
  }
  function quickFrame(I, cv) {
    const d = cv.width / (cv.clientWidth || 1), g = I.geo || [0, 0, 1], bay = document.getElementById('bay');
    const bc = px(cv, (g[0] + 932 * .085 * g[2]) * d, (g[1] + 430 * .12 * g[2]) * d);
    const ring = [];
    for (let k = 0; k < 12; k++) { const a = k / 12 * 6.283, p = px(cv, (g[0] + (932 * .085 + Math.cos(a) * 40) * g[2]) * d, (g[1] + (430 * .12 + Math.sin(a) * 40) * g[2]) * d); ring.push(p[0] + p[1] + p[2]); }
    const row = { t: Math.round(I.t), open: I.open || 0, shift: I.shift || 0, seam: g[0] + 466 * g[2], u: g[2], opacity: +getComputedStyle(cv).opacity,
      mid: px(cv, cv.width / 2, cv.height / 2)[3], left: px(cv, cv.width * .04, cv.height / 2)[3], right: px(cv, cv.width * .96, cv.height / 2)[3],
      ring: ring.join(','), scr: bay.dataset.scr || '', game: document.getElementById('game').classList.contains('active'), mg: mgUp(),
      toast: document.querySelectorAll('.toast-item').length, bay: bay.classList.contains('active'), label: I.label || 0, lit: lit(cv, I, g, d),
      conn: !document.getElementById('connErr').classList.contains('hidden'), draws: window.__draws || 0,
      beacon: bc[0] + bc[1] + bc[2], mark: markLine(cv, g, d) };
    if (row.open > 0 && !S.quickOpen) {
      const anims = bay.getAnimations ? bay.getAnimations({ subtree: true }).filter((a) => { const it = a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming(); return it && isFinite(it.iterations) && a.playState === 'running'; }).length : 0;
      S.quickOpen = { t: row.t, scr: row.scr, game: row.game, anims, resume: localStorage.getItem('cc_resume') !== null, draws: row.draws };
    }
    const Q = S.qa, shut = row.open === 0 && row.opacity === 1;
    Q.n++;
    const litBoth = row.lit[0] >= 3 && row.lit[1] >= 3;
    if (shut) {
      Q.shut++;
      if (row.mid !== 255 || row.left !== 255 || row.right !== 255) Q.notOpaque++;
      // past 3.2 s, where the intro's own beacons have spun down to a stop:
      // how many shut frames, and on how many the beacon looks different
      if (I.t >= 3200) { Q.spinN++; if (row.ring !== Q.ring) Q.spinMoved++; }
      Q.ring = row.ring;
      if (litBoth && Q.litFirst === null) Q.litFirst = I.t;
      if (row.label >= .999) { if (litBoth) Q.full++; else Q.fullUnlit++; }
    }
    if (row.toast) Q.toast++;
    if (row.mg) Q.mg++;
    if (row.conn) Q.conn++;
    if (row.label > 0 && Q.labelFirst === null) Q.labelFirst = I.t;
    if (I.t < 1000 && (row.label > 0 || (shut && row.lit[0] + row.lit[1] > 0))) Q.early++;
    if (Q.n % 15 === 1) { Q.scans++; for (const o of overDoors(cv)) if (!Q.over.includes(o)) Q.over.push(o); }
    if (S.quick.length < 400 || !shut) S.quick.push(row);
  }
  // THE NOTICE OF A MATCH THAT ENDED WHILE THE PLAYER WAS AWAY (bay.js
  // #mgone): whether it is up, on every quick-door frame above, and the first
  // frame it is up at all, with whether the doors were still there then.
  function mgUp() { const m = document.getElementById('mgone'); return !!(m && !m.hidden && getComputedStyle(m).display !== 'none'); }
  S.mgFirst = null;
  function loop() {
    const I = window.__ccIntro, cv = document.getElementById('intro');
    if (!S.mgFirst && mgUp()) S.mgFirst = { state: I ? I.state : null, cv: !!cv, open: I ? I.open || 0 : 0 };
    if (I && I.state === 'running' && cv && I.mode === 'quick') quickFrame(I, cv);
    if (I && I.state === 'running' && cv && I.mode === 'full') {
      if (I.tp < 2100) { const r = alphaRange(cv); S.a1Checks++; if (r[0] < 255) S.a1Fails.push([Math.round(I.tp), r[0]]); }
      if (I.tp >= 2105 && I.tp < 2400 && S.revealOpacity === null) {
        const top = document.querySelector('#bay .stage .top');
        S.revealOpacity = top ? Array.from(top.children).filter((c) => { const r = c.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; }).map((c) => +getComputedStyle(c).opacity) : [];
      }
      if (I.tp >= 4250 && I.tp < 4600 && !S.start) S.start = window.__startGeo(I.tp);
      if (I.tp >= 4900 && I.tp < 5600 && !S.drive) S.drive = window.__driveGeo();
      if (I.tp >= 5650 && I.tp < 5800 && !S.rest) S.rest = window.__restGeo();
      if (I.tp >= 5955) { const r = alphaRange(cv); S.a3Frames++; if (r[1] > S.a3Max) S.a3Max = r[1]; }
      if (I.tp >= 5960 && !S.seam) { S.seam = window.__snap(); S.geo = window.__geo(); }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();`;
const NAME = "try { localStorage.setItem('pt_name', 'TESTPILOT'); } catch (e) {}";
// THE NATIVE LAUNCH HOLD, counted (V9). iOS keeps the launch image up until
// intro.js calls CCLaunch.hide(); this stands in for the plugin and records
// every call, and what was on screen at it: the overlay and its middle pixel
// (the sealed doors are opaque there), or the menu with no overlay at all.
// It is handed to intro.js ALONE (the caller's stack names it): a page that
// sees window.Capacitor takes itself for the native shell, and config.js
// would aim its socket at the production host.
// LAUNCH_NATIVE is the same stub that also tells intro.js, and only intro.js,
// that it runs in the native shell (isNativePlatform), for its sign-in return
// (round 2 review); the rest of the page still sees no Capacitor at all.
const launchStub = (native) => `(() => {
  const L = window.__launch = { hides: 0, at: [] };
  const stub = { ${native ? 'isNativePlatform: () => true, ' : ''}Plugins: { CCLaunch: { hide() {
    L.hides++;
    const cv = document.getElementById('intro');
    let a = -1;
    try { if (cv) a = cv.getContext('2d').getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data[3]; } catch (e) {}
    L.at.push({ canvas: !!cv, alpha: a, scr: document.getElementById('bay').dataset.scr || '' });
    return Promise.resolve();
  } } } };
  Object.defineProperty(window, 'Capacitor', { configurable: true, get() { return /\\/intro\\.js/.test(new Error().stack || '') ? stub : undefined; } });
})();`;
const LAUNCH = launchStub(false), LAUNCH_NATIVE = launchStub(true);
// The last view a page left behind (app.js cc_last_view), planted before any
// page script runs: ageMs ago (negative: from the future), with these fields.
const LAST = (ageMs, rec) => `try { localStorage.setItem('cc_last_view', JSON.stringify(Object.assign({ t: Date.now() - (${ageMs}) }, ${JSON.stringify(rec)}))); } catch (e) {}`;
const HELD = "try { localStorage.setItem('cc_resume', JSON.stringify({ code: 'ABCD', seat: 0, token: 'x', t: Date.now() })); } catch (e) {}";
// A server slow to answer a held seat. A local server answers a resume in a
// few milliseconds, inside the doors' first frames, so a wait for it could not
// be told from no wait at all: from the resume's answer on, every frame the
// page receives is held for RESUME_SLOW ms and then handed over in order.
// slowAnswer(ms) is the same server slower still (round 3: 4, 5 and 20 s),
// and answerAt(t) one whose answer is handed over in the first animation
// frame at which the doors have been up for t ms of their own clock. The
// moment the answer is handed over, on the doors' clock, is kept in
// window.__answeredAt: the doors count only the time they are on screen and
// the server's delay is wall time, so the two are compared on one clock.
const RESUME_SLOW = 700;
const slowAnswer = (ms, atT = 0) => `(() => {
  const Real = window.WebSocket;
  const Slow = function (url, proto) {
    const s = new Real(url, proto);
    let fn = null, q = null;
    Object.defineProperty(s, 'onmessage', { configurable: true, get: () => fn, set: (f) => { fn = f; } });
    s.addEventListener('message', (e) => {
      let t = null; try { t = JSON.parse(e.data).type; } catch (x) {}
      if (q === null && (t === 'restore' || t === 'resumeError')) {
        q = [];
        const go = () => {
          try { window.__answeredAt = window.__ccIntro ? window.__ccIntro.t : null; } catch (x) {}
          const held = q; q = false; held.forEach((ev) => { if (fn) fn.call(s, ev); });
        };
        if (${atT}) { const at = () => { const I = window.__ccIntro; if (I && I.t >= ${atT}) go(); else requestAnimationFrame(at); }; requestAnimationFrame(at); }
        else setTimeout(go, ${ms});
      }
      if (q) { q.push(e); return; }
      if (fn) fn.call(s, e);
    });
    return s;
  };
  Slow.prototype = Real.prototype;
  Slow.CONNECTING = 0; Slow.OPEN = 1; Slow.CLOSING = 2; Slow.CLOSED = 3;
  window.WebSocket = Slow;
})();`;
const SLOW_ANSWER = slowAnswer(RESUME_SLOW);
const answerAt = (t) => slowAnswer(0, t);
// HOW OFTEN app.js HAS DRAWN THE MATCH (round 3): every draw() made while the
// game screen is up with a match in play, so a case can show the doors began
// to open only after the restored match had been drawn under them. draw is a
// global function of app.js, and its frame loop calls it by that name, as
// TANK_CHECK's drawTank is.
const DRAWS = `(() => {
  window.__draws = 0;
  document.addEventListener('DOMContentLoaded', () => {
    const real = window.draw;
    if (typeof real === 'function') window.draw = function () {
      try { if (document.getElementById('game').classList.contains('active') && S.playing && S.terrain) window.__draws++; } catch (e) {}
      return real.apply(this, arguments);
    };
  });
})();`;
// EVERY TOAST, ASKED FOR AND PUT UP (round 2 review: none may be drawn on the
// quick doors, and none may be lost). window.__toasts.asked is every
// showToast() call from the moment app.js has run, with whether the doors
// were up then; .shown is every toast that reached the screen, with whether
// the intro's canvas was still there.
const TOASTS = `(() => {
  const T = window.__toasts = { asked: [], shown: [] };
  document.addEventListener('DOMContentLoaded', () => {
    const real = window.showToast;
    if (typeof real === 'function') window.showToast = function (text) { T.asked.push({ text, up: window.CC_DOORS_UP === true }); return real.apply(this, arguments); };
  });
  new MutationObserver((recs) => {
    for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('toast-item')) T.shown.push({ text: n.textContent, cv: !!document.getElementById('intro') });
  }).observe(document, { childList: true, subtree: true });
})();`;
// A NATIVE SIGN-IN RETURN (round 2 review): cloud.js's flag that this app
// started a sign-in, which in the native shell lives in localStorage.
const PENDING = "try { localStorage.setItem('cc_oauth_pending', '1'); } catch (e) {}";

// context: open the page in an existing browser context, so it shares that
// context's localStorage with an earlier page (a reopened app) while getting
// a sessionStorage of its own (a genuine launch). Closing such a page leaves
// the context to its owner.
async function openPage({ w = 844, h = 390, dpr = 2, insets = null, name = true, noIntro = false, extra = [], media = null, slowBay = 0, context = null } = {}) {
  const { browserContextId } = context ? { browserContextId: context } : await send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const logs = [];
  const s = (m, p) => send(m, p, sessionId);
  const paused = [];
  listeners.set(sessionId, (m) => {
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('ERR ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Fetch.requestPaused') paused.push(m.params.requestId);
  });
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable');
  await s('Network.setBlockedURLs', { urls: ['*supabase.co*', '*googleapis*', '*abarabrothers.com*'] });
  await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: w < 1000 });
  if (insets) await s('Emulation.setSafeAreaInsetsOverride', { insets });
  if (media) await s('Emulation.setEmulatedMedia', { features: media });
  const scripts = [INSTR];
  if (name) scripts.push(NAME);
  if (noIntro) scripts.push('window.__ccNoIntro = true;');
  scripts.push(...extra);
  for (const src of scripts) await s('Page.addScriptToEvaluateOnNewDocument', { source: src });
  if (slowBay) {
    await s('Fetch.enable', { patterns: [{ urlPattern: '*bay.js*', requestStage: 'Request' }] });
    (async () => {
      for (let i = 0; i < 200; i++) {
        if (paused.length) { const id = paused.shift(); await sleep(slowBay); try { await s('Fetch.continueRequest', { requestId: id }); } catch {} }
        await sleep(25);
      }
    })();
  }
  const ev = async (expr) => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };
  const go = (url = BASE) => s('Page.navigate', { url });
  const intro = () => ev('window.__ccIntro ? JSON.parse(JSON.stringify(window.__ccIntro)) : null');
  const until = async (pred, ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      let st = null; try { st = await intro(); } catch {}
      if (st && pred(st)) return st;
      if (Date.now() - t0 > ms) return st;
      await sleep(20);
    }
  };
  const close = async () => { listeners.delete(sessionId); try { await send('Target.closeTarget', { targetId }); } catch {} if (!context) { try { await send('Target.disposeBrowserContext', { browserContextId }); } catch {} } };
  return { s, ev, go, intro, until, close, logs, context: browserContextId };
}

// What a redraw of the bay finds to change, right now. The morph re-asserts
// every attribute from the template; zero records means nothing differs.
const REDRAW_DIFF = `(async () => {
  const bay = document.getElementById('bay'), recs = [];
  // render() rewrites #bay's own data-scr on every render, same value or not
  // (bay.js:3062): that is the bay's housekeeping, not something left behind.
  const ob = new MutationObserver((r) => { for (const x of r) if (!(x.target === bay && x.attributeName === 'data-scr')) recs.push((x.target.className || x.target.tagName) + ':' + (x.attributeName || x.type)); });
  ob.observe(bay, { subtree: true, attributes: true, childList: true });
  document.dispatchEvent(new Event('cc:social'));
  await new Promise((r) => setTimeout(r, 30));
  ob.disconnect();
  return recs;
})()`;
const SUBTREE = `Array.from(document.querySelectorAll('#bay *')).map((el) => el.tagName + '|' + (typeof el.className === 'string' ? el.className : '') + '|' + (el.hasAttribute('style') ? '[' + el.getAttribute('style') + ']' : '-')).join('\\n')`;
const TRANSITIONS = `Array.from(document.getElementById('bay').getAnimations({ subtree: true })).filter((a) => a.constructor.name === 'CSSTransition').map((a) => a.transitionProperty + '@' + (a.effect.target.className || a.effect.target.tagName))`;
// THE INTRO'S TANK IS THE MENU'S (2026-10-06: the sprite now holds the whole
// gun, and intro.js's measurements of it were re-taken). Run on the live menu
// after the intro, with what the page recorded during it (__restGeo,
// __driveGeo). The two layers' clips are tested on the menu's own sprite: a
// pixel is in a layer when the clip, filled, covers at least half of it.
// drawTank's own geometry gives the gun's pivot: the muzzle tip it fires from
// (muzzleTipWorld), back along the barrel by BARREL.len + BARREL.brake, in a
// fresh render of the same 204-wide sprite.
const TANK_CHECK = (rest, drive) => `(async () => {
  const rest = ${JSON.stringify(rest)}, drive = ${JSON.stringify(drive)};
  if (!rest || !drive || !drive.pivot) return { missing: true };
  const tw = document.querySelector('#bay .stage .tankw'), img = Array.from(tw.querySelectorAll(':scope > img')).pop();
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const layer = (clip) => {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const q = c.getContext('2d');
    if (clip) {
      q.beginPath();
      clip.replace(/^polygon\\(|\\)$/g, '').split(',').forEach((pt, i) => { const [x, y] = pt.trim().split(/\\s+/).map((n) => parseFloat(n) / 100); i ? q.lineTo(x * W, y * H) : q.moveTo(x * W, y * H); });
      q.closePath(); q.fillStyle = '#fff'; q.fill();
    } else q.drawImage(img, 0, 0);
    return q.getImageData(0, 0, W, H).data;
  };
  const px = layer(null), hull = layer(rest.clips[0]), gun = layer(rest.clips[1]);
  const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  // The gun's pixels: drawn in its own steels (TANK_G), and, so that an
  // anti-aliased edge elsewhere that happens to blend to one of them (a road
  // wheel's rim against the track can) is not taken for it, only where the
  // four neighbours are gun steel too.
  const GUN = [TANK_G.barrel, TANK_G.barrelLite, TANK_G.brake, TANK_G.brakeSlot].map(hex);
  const steel = (i) => i >= 0 && i < px.length && px[i + 3] === 255 && GUN.some((g) => g[0] === px[i] && g[1] === px[i + 1] && g[2] === px[i + 2]);
  let solid = 0, missed = 0, gunPx = 0, gunOut = 0, gunInHull = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    solid++;
    const inH = hull[i + 3] >= 128, inG = gun[i + 3] >= 128;
    if (!inH && !inG) missed++;
    const x = (i / 4) % W;
    if (x > 0 && x < W - 1 && steel(i) && steel(i - 4) && steel(i + 4) && steel(i - 4 * W) && steel(i + 4 * W)) { gunPx++; if (!inG) gunOut++; if (inH) gunInHull++; }
  }
  const orig = window.drawTank; let g = null;
  window.drawTank = function (i) { g = { t: tankScreen(i), m: muzzleTipWorld(i), w: view.cssW, h: view.cssH, zoom: cam.zoom, cx: cam.cx, cy: cam.cy }; return orig.apply(this, arguments); };
  try { Bay.tankURL('intro-test-probe', 204); } finally { window.drawTank = orig; }
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const tipX = (g.m.x - g.cx) * g.zoom + g.w / 2, tipY = (g.m.y - g.cy) * g.zoom + g.h / 2, L = g.t.r * (BARREL.len + BARREL.brake);
  const s = drive.w / (W / dpr), padTop = H / dpr - g.h;
  const want = [(tipX - g.m.dx * L) * s, (tipY - g.m.dy * L + padTop) * s];
  return { solid, missed, gunPx, gunOut, gunInHull, pivot: drive.pivot, want: want.map((n) => Math.round(n * 10) / 10),
    off: Math.hypot(drive.pivot[0] - want[0], drive.pivot[1] - want[1]) };
})()`;

async function settled(p) {
  // the intro is gone (canvas, hint, any shield) and the page has had a beat
  for (let i = 0; i < 200; i++) { if (!(await p.ev("!!document.getElementById('intro')"))) break; await sleep(25); }
  await sleep(120);
}

// ---- the quick doors, read and judged (V9) ----------------------------------
async function quickRun(p, ms = 9000) {
  const st = await p.until((x) => x.state === 'ended', ms);
  await settled(p);
  const T = await p.ev('window.__t'), L = await p.ev('window.__launch ? JSON.parse(JSON.stringify(window.__launch)) : null');
  const after = await p.ev("({ cv: !!document.getElementById('intro'), inert: document.getElementById('bay').inert, scr: document.getElementById('bay').dataset.scr, game: document.getElementById('game').classList.contains('active') })");
  return { st, T, L, after, logs: p.logs.slice() };
}
// One launch that should get the quick doors, judged on everything the owner
// asked of them: not the intro, up before anything is drawn, open onto the
// destination (`dest`: a bay screen, or 'game' for a resumed match), at once
// when it is ready (`prompt`), in about half a second and in frames, never a
// cut; parting from the seam with the gap clear onto the destination and the
// seam still, or under reduced motion (`fade`) not moving at all but fading;
// on a screen already at rest; the launch hold let go once, with them up.
// ROUND 3 (owner, 2026-10-10) adds two things every launch's doors are judged
// on. `held`: the doors say "Reconnecting..." only while a held seat's
// resume is out; then never in their first LABEL_AT ms, and from then on drawn
// on every frame it is said. And on every frame of every launch's doors,
// nothing stands over them (overOk).
const QUICK_OPEN = 500, QUICK_FADE = 400, LABEL_AT = 1000;
function doorsOk(label, R, { dest, fade = false, prompt = true, held = false }) {
  const { st, T, L, after } = R, rows = (T && T.quick) || [], at = T && T.quickOpen;
  const onto = dest === 'game' ? !!at && at.game && after.game : !!at && !at.game && at.scr === dest && after.scr === dest && !after.game;
  check(`[${label}] the quick doors, not the intro: up before anything is drawn, opening onto ${dest}, nothing left after`,
    !!st && st.mode === 'quick' && st.reason === 'done' && !!st.fade === fade && T.coverAtStage === 255 && onto && !after.cv && !after.inert,
    JSON.stringify({ st, cover: T && T.coverAtStage, at, after }));
  const dur = st && typeof st.openAt === 'number' ? st.t - st.openAt : NaN, want = fade ? QUICK_FADE : QUICK_OPEN;
  const moving = rows.filter((r) => r.open > 0 && r.open < 1).length;
  check(`[${label}] they open ${prompt ? 'at once, ' : ''}in about ${want} ms (${Math.round(dur)} ms, ${moving} frames in between), never a cut`,
    (!prompt || st.openAt <= 250) && dur >= want - 1 && dur <= want + 60 && moving >= 8, JSON.stringify({ openAt: st && st.openAt, dur, moving }));
  if (!fade) {
    const mid = rows.filter((r) => r.open > .25 && r.open < .55), g0 = rows[0];
    check(`[${label}] the doors part from the seam: mid-way the middle is clear onto the destination, both doors still on screen, the seam never moving`,
      mid.length >= 2 && mid.every((r) => r.mid === 0 && r.left === 255 && r.right === 255 && r.opacity === 1)
      && !!g0 && rows.every((r) => Math.abs(r.seam - g0.seam) < .01 && Math.abs(r.u - g0.u) < 1e-6),
      JSON.stringify({ mid: mid.slice(0, 3), seams: [...new Set(rows.map((r) => r.seam.toFixed(3) + '/' + r.u.toFixed(5)))] }));
  } else {
    const ops = rows.map((r) => r.opacity), inner = new Set(ops.filter((o) => o > 0 && o < 1));
    check(`[${label}] under reduced motion the doors do not move: they fade (${inner.size} steps)`,
      rows.length > 0 && rows.every((r) => r.shift === 0 && r.mid === 255 && r.left === 255 && r.right === 255)
      && ops.every((o, i) => i === 0 || o <= ops[i - 1]) && ops[0] === 1 && Math.min(...ops) < .2 && inner.size >= 4,
      JSON.stringify({ ops: ops.filter((_, i) => i % 3 === 0).map((o) => +o.toFixed(3)), shifts: [...new Set(rows.map((r) => r.shift))] }));
  }
  check(`[${label}] nothing under them is still dealing itself in when they open, and the launch hold is let go once, with the doors up`,
    !!at && at.anims === 0 && !!L && L.hides === 1 && L.at[0].canvas && L.at[0].alpha === 255, JSON.stringify({ anims: at && at.anims, L }));
  labelOk(label, R, held);
  overOk(label, R);
  check(`[${label}] no console errors`, R.logs.length === 0 && T.errors === 0, R.logs.slice(0, 3).join(' | '));
}
// THE WORDS ON THE DOORS (round 3). Without a held seat nothing is said or
// drawn. With one: nothing in the first LABEL_AT ms; if the doors were still
// shut well after that, "Reconnecting..." is said within a frame or so of it,
// drawn in full on the shut doors, never said without being drawn, and at
// least 13 stage units tall (the house rules' floor for a label); and it is
// gone by the time the doors are a third of the way open.
function labelOk(label, R, held) {
  const { st, T } = R, qa = T && T.qa, rows = (T && T.quick) || [];
  if (!qa || !st) { check(`[${label}] the words on the doors were read`, false, JSON.stringify({ st, qa })); return; }
  if (!held) {
    check(`[${label}] nothing is said on these doors: only a held seat's wait says "Reconnecting..."`,
      qa.labelFirst === null && qa.litFirst === null && qa.full === 0 && st.labelAt === undefined, JSON.stringify(qa));
    return;
  }
  check(`[${label}] nothing is said on the doors in their first second (${qa.early} frames said or drew something then)`,
    qa.early === 0 && (qa.labelFirst === null || qa.labelFirst >= LABEL_AT) && (qa.litFirst === null || qa.litFirst >= LABEL_AT), JSON.stringify(qa));
  if (st.openAt >= LABEL_AT + 600) {
    check(`[${label}] then "Reconnecting..." comes up on the shut doors (said at ${Math.round(qa.labelFirst)} ms, lit from ${Math.round(qa.litFirst)} ms, in full on ${qa.full} frames), across both doors, ${st.labelGeo && st.labelGeo[2]} stage units tall in the intro's Barlow, and drawn on every frame it is said`,
      st.labelText === 'Reconnecting…' && qa.labelFirst >= LABEL_AT && qa.labelFirst <= LABEL_AT + 100 && qa.litFirst !== null && qa.litFirst <= LABEL_AT + 400
      && qa.full >= 10 && qa.fullUnlit === 0 && !!st.labelGeo && st.labelGeo[2] >= 13 && /^Barlow,/.test(st.labelFace || ''), JSON.stringify({ qa, text: st.labelText, geo: st.labelGeo, face: st.labelFace }));
  }
  check(`[${label}] the words never first come up once the doors have begun to open`, qa.labelFirst === null || qa.labelFirst <= st.openAt, JSON.stringify({ first: qa.labelFirst, openAt: st.openAt }));
  const late = rows.filter((r) => r.open >= .3);
  check(`[${label}] and the words have gone by the time the doors are a third of the way open (${late.length} frames)`,
    late.length > 0 && late.every((r) => r.label === 0), JSON.stringify(late.slice(0, 3)));
}
// NOTHING OVER THE DOORS (round 3: "make sure nothing else (resume toasts,
// the connection banner, the bay's own entrance) shows over the shut doors").
// The shut doors cover the screen on every frame; no toast, no notice of a
// match that ended and no connection banner is up on any frame of them; and
// the looks at the whole page found nothing that could be drawn over them.
// The bay's entrance is under them, and doorsOk shows it finished at the open.
function overOk(label, R) {
  const qa = R.T && R.T.qa;
  check(`[${label}] nothing stands over the doors: on all ${qa && qa.shut} shut frames they cover the screen, no toast, notice or connection banner is up on any of their ${qa && qa.n} frames, and ${qa && qa.scans} looks at the whole page found nothing that could be drawn over them`,
    !!qa && qa.shut >= 1 && qa.notOpaque === 0 && qa.toast === 0 && qa.mg === 0 && qa.conn === 0 && qa.scans >= 1 && qa.over.length === 0, JSON.stringify(qa));
}
// STILL TURNING (round 3): doors that hold past 3.2 s, where the intro's own
// beacons have spun down to a stop, are still not a frozen frame: the beacons
// look different on most of those frames, every one of which is counted.
function spinOk(label, R, min) {
  const qa = R.T && R.T.qa;
  check(`[${label}] past 3.2 s the shut doors are still alive: the beacons look different on ${qa && qa.spinMoved} of ${qa && qa.spinN} frames`,
    !!qa && qa.spinN >= min && qa.spinMoved >= qa.spinN * .5, JSON.stringify(qa && { spinN: qa.spinN, spinMoved: qa.spinMoved }));
}
// LIT WHILE THEY WAIT (owner, 2026-10-10: shut "studio mark and beacons
// lit"; round 3 review: under reduced motion they were left dark, blank doors
// but for their words). On every shut frame from the end of the power-on
// (250 ms) the light over the studio mark and at the top-left beacon's
// centre is well up on frame 0's, the launch image's, where neither is lit
// yet. And with `still` (reduced motion) nothing on them moves: the light
// round the beacon, and at its centre, stays within a few levels of the
// first of those frames on every one of them (a turning beam moves it by
// tens).
function litOk(label, R, still) {
  const rows = (R.T && R.T.quick) || [], f0 = rows.find((r) => r.t === 0);
  const held = rows.filter((r) => r.t >= 300 && r.open === 0 && r.opacity === 1), h0 = held[0];
  check(`[${label}] the shut doors are lit, the studio mark and the beacons, on all ${held.length} of their frames from the power-on's end (the mark's row ${h0 && h0.mark} against frame 0's ${f0 && f0.mark}, the beacon ${h0 && h0.beacon} against ${f0 && f0.beacon})`,
    !!f0 && held.length >= 20 && held.every((r) => r.mark >= f0.mark * 1.25 && r.beacon >= f0.beacon + 200),
    JSON.stringify({ f0: f0 && { mark: f0.mark, beacon: f0.beacon }, held: held.filter((_, i) => i % 40 === 0).map((r) => ({ t: r.t, mark: r.mark, beacon: r.beacon })) }));
  if (!still) return;
  const ring0 = h0 ? h0.ring.split(',').map(Number) : [];
  const moved = held.map((r) => Math.max(Math.abs(r.beacon - h0.beacon), ...r.ring.split(',').map((v, k) => Math.abs(+v - ring0[k]))));
  check(`[${label}] and nothing on them moves: round the beacon and at its centre the light stays within 6 levels of its first lit frame on every one (at most ${moved.length ? Math.max(...moved) : null})`,
    held.length >= 20 && moved.every((m) => m <= 6), JSON.stringify({ moved: moved.filter((_, i) => i % 20 === 0) }));
}
// NO FRAME SHOWS HOME BEHIND THEM (round 3): every frame that shows anything
// behind the doors, parted or faded, shows the match with the bay off screen,
// and app.js had drawn the restored match (DRAWS) before the first of them.
function revealOk(label, R) {
  const rows = (R.T && R.T.quick) || [], seen = rows.filter((r) => r.open > 0 || r.opacity < 1), at = R.T && R.T.quickOpen;
  check(`[${label}] no frame shows home behind the doors: on all ${seen.length} frames that show anything behind them the match is up and the bay is not, and the restored match had been drawn (${at && at.draws} draws) before the first`,
    seen.length >= 8 && seen.every((r) => r.game && !r.bay) && !!at && at.draws >= 1, JSON.stringify({ wrong: seen.filter((r) => !r.game || r.bay).slice(0, 3), at }));
}
async function bayReady(p) {
  for (let i = 0; i < 200; i++) {
    if (await p.ev("!!window.Bay && !!document.querySelector('#bay .stage') && !document.getElementById('bay').classList.contains('enter')").catch(() => false)) return true;
    await sleep(40);
  }
  return false;
}
const SCR = "document.getElementById('bay').dataset.scr";

// ---- the full playthroughs: A1, A2, A3 and the seam, per viewport -----------
const VIEWS = [
  { label: '844x390 phone', w: 844, h: 390, dpr: 3 },
  { label: '1180x820 iPad', w: 1180, h: 820, dpr: 2 },
  { label: '1440x900 desktop', w: 1440, h: 900, dpr: 2 },
  { label: '390x844 rotation shim', w: 390, h: 844, dpr: 3 },
  { label: '844x390 notched 47/47/0/21', w: 844, h: 390, dpr: 3, insets: { left: 47, right: 47, top: 0, bottom: 21 } },
  { label: '844x390 asymmetric 32/0/0/0', w: 844, h: 390, dpr: 3, insets: { left: 32, right: 0, top: 0, bottom: 0 } },
  // U5: an iPhone 17 held sideways, where home stretches to the safe box --
  // the frame is width-limited and the ribbon goes down to 4u above 402 - 21.
  { label: '874x402 iPhone 17 62/62/0/21', w: 874, h: 402, dpr: 3, insets: { left: 62, right: 62, top: 0, bottom: 21 }, stretched: true },
];
let controlSubtree = {};
for (const v of VIEWS) {
  // the control: the same page with the intro switched off
  const c = await openPage({ ...v, noIntro: true });
  await c.go(); await sleep(6600);
  const cRedraw = await c.ev(REDRAW_DIFF);
  controlSubtree[v.label] = await c.ev(SUBTREE);
  await c.close();
  if (v === VIEWS[0]) check('control: a redraw of an untouched menu changes nothing (validates the method)', cRedraw.length === 0, cRedraw.slice(0, 6).join(', '));

  const p = await openPage({ ...v, extra: [LAUNCH] });
  await p.go();
  const st0 = await p.until((x) => x.state !== 'off', 3000);
  check(`[${v.label}] plays on a genuine launch`, st0 && st0.state === 'running', JSON.stringify(st0));
  const fin = await p.until((x) => x.state === 'ended', 20000);
  check(`[${v.label}] runs to the end on its own`, fin && fin?.state === 'ended' && fin?.reason === 'done', JSON.stringify(fin));
  await settled(p);
  const T = await p.ev('window.__t');
  check(`[${v.label}] A1 the doors are up before the menu is first drawn`, T.stageSeen && T.coverAtStage === 255, 'min alpha at first .stage: ' + T.coverAtStage);
  check(`[${v.label}] A1 no frame shows the menu before the reveal`, T.a1Checks > 30 && T.a1Fails.length === 0, `${T.a1Checks} frames, fails ${JSON.stringify(T.a1Fails.slice(0, 4))}`);
  check(`[${v.label}] A3 the canvas is fully transparent through the hand-off`, T.a3Frames >= 1 && T.a3Max === 0, `${T.a3Frames} frames, max alpha ${T.a3Max}`);
  const after = await p.ev('window.__snap()');
  const diffs = [];
  if (!T.seam || T.seam.length !== after.length) diffs.push(`element count ${T.seam && T.seam.length} vs ${after.length}`);
  else T.seam.forEach((row, i) => { const a = after[i]; if (row[0] !== a[0] || row[1] !== a[1]) diffs.push(`#${i} ${row[0]}.${row[1]} became ${a[0]}.${a[1]}`); else if (row[2] && a[2] && JSON.stringify(row[2]) !== JSON.stringify(a[2])) diffs.push(`${row[0]}.${row[1]} ${JSON.stringify(row[2])} -> ${JSON.stringify(a[2])}`); });
  check(`[${v.label}] seam: every element computes the same in the last intro frame and after it`, diffs.length === 0, diffs.slice(0, 4).join('\n      '));
  check(`[${v.label}] seam: nothing in the menu starts a transition when the intro lets go`, (await p.ev(TRANSITIONS)).length === 0);
  // U5: THE LAST FRAME STANDS WHERE THE LIVE MENU STANDS. The seam above
  // compares styles; this compares where every part of home actually is --
  // the top row, each chip, each board, both panels, the ribbon, the
  // battlefield window, the tank and its platform -- in the intro's last
  // frame and on the live menu after it, so a home that moved its parts (the
  // stretched frame) is still handed over exactly.
  const geoNow = await p.ev('window.__geo()');
  const geoDiff = [];
  if (!T.geo) geoDiff.push('no last-frame geometry');
  else for (const k of Object.keys(geoNow)) {
    const a = JSON.stringify(T.geo[k]), b = JSON.stringify(geoNow[k]);
    const flat = (x) => [].concat(...(Array.isArray(x[0]) ? x : [x]));
    if (!T.geo[k] || !geoNow[k] || T.geo[k].length !== geoNow[k].length) { if (a !== b) geoDiff.push(`${k}: ${a} vs ${b}`); continue; }
    const fa = flat(T.geo[k]), fb = flat(geoNow[k]);
    if (fa.some((n, i) => Math.abs(n - fb[i]) > 0.5)) geoDiff.push(`${k}: ${a} vs ${b}`);
  }
  check(`[${v.label}] geometry: the last intro frame's menu stands exactly where the live menu does`, geoDiff.length === 0 && geoNow.chips.length === 5 && geoNow.cards.length === 5, geoDiff.slice(0, 3).join('\n      '));
  if (v.stretched && T.geo) {
    const [lx, ly, lw, lh] = T.geo.lbar[0], st = T.geo.stage, tp = T.geo.top[0];
    check(`[${v.label}] the intro ends on the stretched home: the ribbon 4u above the safe bottom (${(ly + lh).toFixed(1)} of ${v.h - v.insets.bottom}), the row and the ribbon outside the centred frame`,
      Math.abs(ly + lh - (v.h - v.insets.bottom)) <= 4 && ly + lh <= v.h - v.insets.bottom && ly + lh > st[1] + st[3] + 10 && tp[1] < st[1] - 5, JSON.stringify({ lbar: T.geo.lbar[0], stage: st, top: tp }));
  }
  const redraw = await p.ev(REDRAW_DIFF);
  check(`[${v.label}] A2 a redraw after the intro finds nothing to change`, redraw.length === 0, redraw.slice(0, 6).join(', '));
  const sub = await p.ev(SUBTREE);
  check(`[${v.label}] A2 the #bay subtree equals a load that never played the intro`, sub === controlSubtree[v.label],
    (() => { const a = sub.split('\n'), b = controlSubtree[v.label].split('\n'); const i = a.findIndex((x, k) => x !== b[k]); return i < 0 ? 'length differs' : `first difference: ${a[i]}  vs  ${b[i]}`; })());
  check(`[${v.label}] no canvas, no inert left behind`, !(await p.ev("!!document.getElementById('intro') || document.getElementById('bay').inert")));
  check(`[${v.label}] A11 no console errors`, p.logs.length === 0 && T.errors === 0, p.logs.slice(0, 3).join(' | '));
  { const L = await p.ev('JSON.parse(JSON.stringify(window.__launch))');
    check(`[${v.label}] V9 the launch hold is let go once, with frame 0 up`, L.hides === 1 && L.at[0].canvas && L.at[0].alpha === 255, JSON.stringify(L)); }
  // THE INTRO'S TANK ENDS ON THE MENU'S. At rest (tp 5650-5800, before the
  // menu's own image has faded in over it) the wrapper stands on the menu
  // image's box with nothing left of the drive in either layer, and the two
  // layers hold the menu's own sprite; between them every solid pixel of it,
  // the whole gun in the barrel layer and none of it in the hull's. Mid-drive
  // the barrel turns about drawTank's own pivot, the mantlet's centre.
  {
    const R = T.rest, tk = await p.ev(TANK_CHECK(T.rest, T.drive));
    const boxOk = R && R.wrap.every((n, i) => Math.abs(n - R.img[i]) <= 0.5);
    check(`[${v.label}] the intro's tank comes to rest exactly on the menu's: the same box, no transform left, the menu's own sprite in both layers`,
      !!R && boxOk && R.tf.every((t) => t === 'none') && R.sizes.every((sz) => sz[0] === R.nat[0] && sz[1] === R.nat[1]), JSON.stringify(R));
    check(`[${v.label}] at rest the two layers are the whole tank: every solid pixel in one (${tk.solid}), all ${tk.gunPx} of the gun's in the barrel layer, none in the hull's`,
      !tk.missing && tk.solid > 1000 && tk.missed === 0 && tk.gunPx > 200 && tk.gunOut === 0 && tk.gunInHull === 0, JSON.stringify(tk));
    check(`[${v.label}] mid-drive the barrel turns about the gun's own pivot, the mantlet's centre (${tk.off !== undefined ? tk.off.toFixed(2) : '?'}px off)`,
      !tk.missing && tk.off <= 1, JSON.stringify({ pivot: tk.pivot, want: tk.want }));
    // The hull still pitches about the point it always did, (.5, .58) of the
    // frame, now that the frame starts the pad down the image.
    const D = T.drive, hw = D && D.hull ? [D.frameW * .5, D.pad + .58 * (D.imgH - D.pad)] : null;
    check(`[${v.label}] mid-drive the hull pitches about (.5, .58) of the tank's frame, as it always did`,
      !!hw && Math.abs(D.hull[0] - hw[0]) <= .6 && Math.abs(D.hull[1] - hw[1]) <= .6, JSON.stringify({ hull: D && D.hull, want: hw }));
    // The drive measures from the tank's FRAME, not from the bigger image
    // that holds the gun: it sets off with the frame's right edge on the
    // backdrop's left edge and cruises (intro.js driveIn, driveDist; V0 =
    // 2 / 1.58 of the way per drive, the drive 4250-5300 ms).
    // (Under the rotation shim intro.js's bobOffset() takes the idle bob,
    // which is the wrapper's own translateY, as an x offset, so there the
    // start may also be out by that frame's bob; the frame-against-image
    // question this asks is the pad, 30px and more.)
    const S0 = T.start, p0 = S0 ? (S0.tp - 4250) / 1050 : 0;
    const dxWant = S0 ? -(S0.frameL + S0.frameW - S0.apL) * (1 - (2 / 1.58) * p0) : NaN, dxTol = 1 + (S0 && S0.rotated ? Math.abs(S0.bob) : 0);
    check(`[${v.label}] the drive sets off from the tank's frame: its right edge on the backdrop's left edge (${S0 && S0.dx !== null ? (S0.dx - dxWant).toFixed(2) : '?'}px off, within ${dxTol.toFixed(2)})`,
      !!S0 && S0.dx !== null && S0.apTf === 'none' && p0 >= 0 && p0 < .58 && Math.abs(S0.dx - dxWant) <= dxTol, JSON.stringify({ start: S0, dxWant }));
  }
  if (v === VIEWS[0]) {
    // A4: the same tab again (Back to menu, a refresh, the sign-in return)
    await p.go(); await sleep(800);
    const again = await p.intro();
    check('A4 a second load in the same tab does not replay it', again && again.state === 'off', JSON.stringify(again));
  }
  await p.close();
}

// ---- A5 and A6: launches that must not play it ------------------------------
// V9 (owner, 2026-10-07): none of these plays the intro, and none of them is
// left with a cut either. On iOS each starts on the launch image, the sealed
// doors, and a cut from those straight to the menu is the "split second" the
// owner saw; so each gets the quick doors, faded under reduced motion. Only
// the test switch, and a load that is not a launch (A4), have no doors.
async function offCase(label, opts, url = BASE) {
  const p = await openPage(opts);
  await p.go(url); await sleep(900);
  const st = await p.intro();
  check(label, st && st?.state === 'off' && !(await p.ev("!!document.getElementById('intro')")), JSON.stringify(st));
  await p.close();
}
async function quickCase(label, opts, url, want) {
  const p = await openPage({ w: 844, h: 390, dpr: 3, ...opts, extra: [...(opts.extra || []), opts.native ? LAUNCH_NATIVE : LAUNCH] });
  await p.go(url);
  const R = await quickRun(p, want.ms);
  doorsOk(label, R, want);
  if (want.also) await want.also(p, R);
  await p.close();
  return R;
}
await quickCase('A5 a room link with a saved name: the quick doors, never the intro', {}, BASE + '?room=ABCD', { dest: 'home' });
await quickCase('A5 a squad link with a saved name: the quick doors, never the intro', {}, BASE + '?squad=ABCD', { dest: 'home' });
// THE HELD SEAT THAT IS GONE IS SAID SO (owner, 2026-10-07: "if the room is
// gone (e.g. a deploy), a clear 'that match ended while you were away' message
// instead of a silent kick"). This case pinned the silent landing until then:
// the doors opened onto home and nothing said why. They still wait for the
// refusal and open onto home, and once they have gone, never while they are
// shut, home says what happened.
await quickCase('A5 a held seat the server no longer has: the doors wait for its answer, then open onto home', { extra: [HELD, SLOW_ANSWER] }, BASE, { dest: 'home', prompt: false, held: true,
  also: async (p, R) => {
    check(`A5 that held seat was answered (${RESUME_SLOW} ms late) and cleared before the doors opened, at ${R.st && Math.round(R.st.openAt)} ms`,
      !!R.st && R.st.openAt >= RESUME_SLOW && R.T.quickOpen && R.T.quickOpen.resume === false && !(await p.ev("localStorage.getItem('cc_resume')")), JSON.stringify(R.T.quickOpen));
    const rows = R.T.quick || [], first = R.T.mgFirst;
    const mg = await p.ev(`(() => { const m = document.getElementById('mgone'); const up = !!(m && !m.hidden);
      return { up, text: up ? m.querySelector('.mgh').textContent : null, focus: up && document.activeElement === m.querySelector('.mgo') }; })()`);
    check('A5 and home then says "That match ended while you were away.", with OK to put it away: the refusal is never a silent kick',
      mg.up && mg.text === 'That match ended while you were away.' && mg.focus, JSON.stringify(mg));
    check(`A5 that notice is never drawn over the doors: up on none of their ${rows.length} frames, and first up once they had gone`,
      rows.length > 20 && rows.every((r) => !r.mg) && !!first && first.state === 'ended' && !first.cv, JSON.stringify({ mgFrames: rows.filter((r) => r.mg).length, first }));
  } });
await quickCase('A6 the OS reduced-motion setting: no intro, the doors fade', { media: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, BASE, { dest: 'home', fade: true });
await quickCase('A6 the in-game Reduce motion toggle: no intro, the doors fade', { extra: ["try { localStorage.setItem('cc_motion', '1'); } catch (e) {}"] }, BASE, { dest: 'home', fade: true });
await offCase('test switch: window.__ccNoIntro skips it', { noIntro: true });
{
  // R8: a first-time visitor on an invite link is not routed anywhere, so they get the intro
  const p = await openPage({ name: false });
  await p.go(BASE + '?room=ABCD');
  const st = await p.until((x) => x.state !== 'off', 2000);
  check('A5/R8 a nameless invite launch (boot routes nowhere) still plays it', st && st?.state === 'running', JSON.stringify(st));
  await p.close();
}
// ---- V9: a native sign-in return ---------------------------------------------
// intro.js decide()'s last way to the quick doors, which nothing ran until the
// round 2 review. In the native shell, a launch that finds cloud.js's sign-in
// flag (cc_oauth_pending, kept in localStorage there) is a sign-in coming back
// to the app, which is somewhere to go: the quick doors, never the intro, which
// would play for six seconds over the return, or a cut from the launch image
// straight to the menu (item 23). Both halves are needed, so each alone is
// shown playing the intro: the shell with no sign-in pending, and the flag on
// the web, where cloud.js keeps its own flag in sessionStorage and never reads
// this one.
await quickCase('V9 a native sign-in return: the quick doors, never the intro', { native: true, extra: [PENDING] }, BASE, { dest: 'home' });
for (const [label, opts] of [['V9 the native shell with no sign-in pending: the full intro', { native: true }], ['V9 a sign-in flag on the web: the full intro', { extra: [PENDING] }]]) {
  const p = await openPage({ w: 844, h: 390, dpr: 3, ...opts, extra: [...(opts.extra || []), opts.native ? LAUNCH_NATIVE : LAUNCH] });
  await p.go();
  const st = await p.until((x) => x.state === 'running' && x.tp >= 300, 6000);
  check(label, !!st && st.mode === 'full' && st.state === 'running', JSON.stringify(st));
  await p.close();
}

// ---- V9: A QUICK REOPEN -------------------------------------------------------
// The owner (2026-10-07): "skip it, the doors open fast but when the doors
// open they open into whatever the player was viewing last ... if they were
// mid game and close the app, they would then reopen the app to see the bay
// doors open to the game their currently playing". Within ten minutes of last
// use: no intro, the quick doors onto the last view; after that, the intro.
// A reopen is a new tab in the SAME browser context: localStorage carries
// over, sessionStorage does not, which is exactly an app killed and launched.
{
  // The real thing: the player arms golf, opens its setup and the Armoury,
  // and the page is put away (the tab closed). Reopened: the doors open onto
  // the Armoury, golf still armed, and Back goes the way they came.
  const { browserContextId: X } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const a = await openPage({ w: 844, h: 390, dpr: 3, noIntro: true, context: X });
  await a.go(); await bayReady(a);
  await a.ev(`(document.querySelector('#bay [data-set="mode=golf"]').click(), Bay.go('setup'), Bay.go('armoury'), true)`);
  const left = await a.ev(`({ scr: ${SCR}, mode: ccMode, rec: JSON.parse(localStorage.getItem('cc_last_view') || 'null') })`);
  // Round 2 review: the record is current while the page is still open, not
  // only once it is put away (it was null here until then).
  check('V9 the last view is kept as the player moves, before the page is put away: the screen, the way back to it and the armed mode',
    left.scr === 'armoury' && left.mode === 'golf' && !!left.rec && left.rec.scr === 'armoury' && JSON.stringify(left.rec.path) === '["home","setup"]' && left.rec.mode === 'golf' && Math.abs(Date.now() - left.rec.t) < 15000,
    JSON.stringify(left));
  await a.go('about:blank'); await sleep(200); await a.close();
  const b = await openPage({ w: 844, h: 390, dpr: 3, context: X, extra: [LAUNCH] });
  await b.go();
  const rec = await b.ev("JSON.parse(localStorage.getItem('cc_last_view') || 'null')");
  check('V9 putting the page away keeps the last view: the screen, the way back to it and the armed mode',
    !!rec && rec.scr === 'armoury' && JSON.stringify(rec.path) === '["home","setup"]' && rec.mode === 'golf' && Math.abs(Date.now() - rec.t) < 15000,
    JSON.stringify({ left, rec }));
  const R = await quickRun(b);
  doorsOk('V9 reopened within ten minutes', R, { dest: 'armoury' });
  const way = await b.ev(`(() => { const out = [ccMode]; Bay.back(); out.push(${SCR}); Bay.back(); out.push(${SCR}); return out; })()`);
  check('V9 the reopened Armoury is golf\'s, and Back goes to its Match setup, then home', JSON.stringify(way) === '["golf","setup","home"]', JSON.stringify(way));
  check('V9 after the quick doors a redraw finds nothing to change', (await b.ev(REDRAW_DIFF)).length === 0);
  await b.close();
  try { await send('Target.disposeBrowserContext', { browserContextId: X }); } catch {}
}
{
  // Each of the two ways a page is put away keeps the view on its own:
  // pagehide (a tab closed or navigated away; the event an unload is sure to
  // send on every engine), and, on iOS, the app going to the background, the
  // last thing a page hears before the app may be killed, which it hears
  // only as becoming hidden. Chrome also turns a page hidden as it unloads,
  // so the real close above cannot tell the two apart: each is fired here
  // alone. Since the round 2 review the view is also kept the moment it
  // changes (below), so the record is taken away before each event: only that
  // event can have put it back. Coming back to the foreground is use again,
  // and keeps the time at once.
  const p = await openPage({ w: 844, h: 390, dpr: 3, noIntro: true });
  await p.go(); await bayReady(p);
  const before = await p.ev("JSON.parse(localStorage.getItem('cc_last_view') || 'null')");
  const onHide = await p.ev("(Bay.go('paint'), localStorage.removeItem('cc_last_view'), window.dispatchEvent(new Event('pagehide')), JSON.parse(localStorage.getItem('cc_last_view') || 'null'))");
  check('V9 pagehide on its own keeps the last view', !!before && before.scr === 'home' && !!onHide && onHide.scr === 'paint' && Math.abs(Date.now() - onHide.t) < 5000, JSON.stringify({ before, onHide }));
  const rec = await p.ev(`(() => {
    Bay.go('career');
    localStorage.removeItem('cc_last_view');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    return JSON.parse(localStorage.getItem('cc_last_view') || 'null');
  })()`);
  check('V9 the app going to the background keeps the last view too', !!rec && rec.scr === 'career' && JSON.stringify(rec.path) === '["home","paint"]' && Math.abs(Date.now() - rec.t) < 5000, JSON.stringify(rec));
  const back = await p.ev(`(() => {
    localStorage.setItem('cc_last_view', JSON.stringify({ t: Date.now() - 3600000, scr: 'career', path: ['home', 'paint'], mode: ccMode }));
    delete document.hidden; delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
    const w = JSON.parse(localStorage.getItem('cc_last_view') || 'null');
    return { hidden: document.hidden, scr: w && w.scr, age: w ? Date.now() - w.t : null };
  })()`);
  check('V9 coming back to the foreground after an hour is use again: the time is kept at once, so a kill straight after is still a quick reopen',
    back.hidden === false && back.scr === 'career' && back.age >= 0 && back.age < 5000, JSON.stringify(back));
  await p.close();
}
{
  // KEPT AS THE PLAYER MOVES (round 2 review). A swipe from the iOS app
  // switcher can kill the app with no pagehide and without its page turning
  // hidden first, so the view is kept the moment it changes: the first screen,
  // every screen and every step Back, and a mode armed, each with its time.
  // All of it in one evaluation, so the beat (below) cannot have written any
  // of it. A redraw of the same view keeps nothing, or every social and squad
  // push would be a write: 25 pushes redraw home (each rewrites #bay's
  // data-scr, counted) and none of them writes the record.
  const p = await openPage({ w: 844, h: 390, dpr: 3, noIntro: true });
  await p.go(); await bayReady(p);
  const steps = await p.ev(`(() => {
    const r = () => { const v = JSON.parse(localStorage.getItem('cc_last_view') || 'null'); return v && [v.scr, v.path.join('>'), v.mode, Math.abs(Date.now() - v.t) < 5000]; };
    const out = [r()];
    Bay.go('career'); out.push(r());
    Bay.go('paint'); out.push(r());
    Bay.back(); out.push(r());
    Bay.back(); out.push(r());
    document.querySelector('#bay [data-set="mode=golf"]').click(); out.push(r());
    return out;
  })()`);
  check('V9 every change of view is kept the moment it happens, with no page put away: the first screen, each screen, each step Back and a mode armed',
    JSON.stringify(steps) === JSON.stringify([['home', '', 'duel', true], ['career', 'home', 'duel', true], ['paint', 'home>career', 'duel', true], ['career', 'home', 'duel', true], ['home', '', 'duel', true], ['home', '', 'golf', true]]),
    JSON.stringify(steps));
  const quiet = await p.ev(`(() => {
    const set = Storage.prototype.setItem, bay = document.getElementById('bay'); let writes = 0;
    const ob = new MutationObserver(() => {}); ob.observe(bay, { attributes: true, attributeFilter: ['data-scr'] });
    Storage.prototype.setItem = function (k) { if (k === 'cc_last_view') writes++; return set.apply(this, arguments); };
    try { for (let i = 0; i < 25; i++) document.dispatchEvent(new Event('cc:social')); }
    finally { Storage.prototype.setItem = set; }
    const redraws = ob.takeRecords().length; ob.disconnect();
    return { writes, redraws, scr: bay.dataset.scr };
  })()`);
  check(`V9 a redraw of the same view keeps nothing: ${quiet.redraws} redraws of home, ${quiet.writes} writes`, quiet.scr === 'home' && quiet.redraws >= 25 && quiet.writes === 0, JSON.stringify(quiet));
  // TOASTS UNDER THE QUICK DOORS (round 2 review), at app.js's end of the
  // contract with intro.js: while CC_DOORS is 'quick' and CC_DOORS_UP is
  // true every toast is held, and cc:doorsgone shows them all, in order; one
  // raised after that shows at once. The real doors are below (a held seat).
  const held = await p.ev(`(() => {
    const mine = ['First', 'Second', 'Third', 'Later'];
    const items = () => [...document.querySelectorAll('.toast-item')].map((t) => t.textContent).filter((t) => mine.includes(t));
    const was = [window.CC_DOORS, window.CC_DOORS_UP];
    window.CC_DOORS = 'quick'; window.CC_DOORS_UP = true;
    showToast('First'); showToast('Second'); showToast('Third');
    const during = items();
    window.CC_DOORS_UP = false; document.dispatchEvent(new Event('cc:doorsgone'));
    const after = items();
    showToast('Later');
    const later = items();
    window.CC_DOORS = was[0]; window.CC_DOORS_UP = was[1];
    return { during, after, later };
  })()`);
  check('V9 a toast raised while the quick doors are up is held, every one is shown in order the moment they have gone, and one raised after shows at once',
    held.during.length === 0 && JSON.stringify(held.after) === '["First","Second","Third"]' && JSON.stringify(held.later) === '["First","Second","Third","Later"]', JSON.stringify(held));
  await p.close();
}
{
  // A MATCH'S START AND ITS END are changes of view too (round 2 review),
  // kept with the moment they happened even though the view kept is the same
  // home it was, as it is all through a match. The page reads as hidden (no
  // event is sent), which holds the beat off, so nothing else can have
  // written the time.
  const p = await openPage({ w: 844, h: 390, dpr: 3, noIntro: true });
  await p.go(); await bayReady(p);
  const AGED = 9 * 60 * 1000;
  const SET_BACK = `(() => { const v = JSON.parse(localStorage.getItem('cc_last_view') || 'null') || { scr: 'none', path: [], mode: ccMode }; v.t = Date.now() - ${AGED}; localStorage.setItem('cc_last_view', JSON.stringify(v)); return v.scr; })()`;
  const READ = "(() => { const v = JSON.parse(localStorage.getItem('cc_last_view') || 'null'); return v ? { scr: v.scr, path: v.path, age: Date.now() - v.t } : null; })()";
  await p.ev("(Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }), true)");
  const was = await p.ev(SET_BACK);
  await p.ev("(document.getElementById('createBtn').onclick(), true)");
  let playing = false;
  for (let i = 0; i < 150 && !playing; i++) { playing = await p.ev('S.playing === true'); if (!playing) await sleep(50); }
  const atStart = await p.ev(READ);
  check('V9 a match starting from home keeps the view at once, with the moment it started: home, though the view did not change',
    was === 'home' && playing && !!atStart && atStart.scr === 'home' && atStart.path.length === 0 && atStart.age >= 0 && atStart.age < 3000, JSON.stringify({ was, playing, atStart }));
  const ends = await p.ev(`(() => {
    ${SET_BACK}; onGameOver({ winner: S.you, hp: S.hp.slice() }); const over = ${READ};
    ${SET_BACK}; handle({ type: 'opponentLeft' }); const left = ${READ};
    return { over, left, overlay: !document.getElementById('overlay').classList.contains('hidden') };
  })()`);
  check('V9 a match ending keeps the view at once, with the moment it ended: the result on screen', ends.overlay && !!ends.over && ends.over.scr === 'home' && ends.over.age >= 0 && ends.over.age < 3000, JSON.stringify(ends));
  check('V9 and so does the opponent leaving', !!ends.left && ends.left.scr === 'home' && ends.left.age >= 0 && ends.left.age < 3000, JSON.stringify(ends));
  await p.close();
}
{
  // KILLED WITH NO WORD (round 2 review): the swipe from the iOS app
  // switcher. CDP's Page.crash ends the page the same way, with no pagehide
  // and no visibilitychange (the page's own listeners below would have marked
  // either). A put-away a moment before left a record naming another screen,
  // so a reopen that found only that would open onto the wrong one, and with
  // no record at all it would play the full intro. The page reads as hidden
  // (no event is sent), which holds the beat off: only the changes of view
  // can have kept the screen the player was on.
  const { browserContextId: X } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const MARK = `addEventListener('pagehide', () => { try { localStorage.setItem('cc_test_unload', 'pagehide'); } catch (e) {} });
    document.addEventListener('visibilitychange', () => { try { localStorage.setItem('cc_test_unload', 'visibilitychange'); } catch (e) {} });`;
  const a = await openPage({ w: 844, h: 390, dpr: 3, noIntro: true, context: X, extra: [MARK] });
  await a.go(); await bayReady(a);
  const stale = await a.ev(`(() => {
    Bay.go('paint'); window.dispatchEvent(new Event('pagehide'));
    const v = JSON.parse(localStorage.getItem('cc_last_view') || 'null');
    localStorage.removeItem('cc_test_unload');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Bay.back(); Bay.go('setup'); Bay.go('armoury');
    return v && v.scr;
  })()`);
  await sleep(300);
  await Promise.race([a.s('Page.crash').catch(() => {}), sleep(1500)]);
  await sleep(300); await a.close();
  const b = await openPage({ w: 844, h: 390, dpr: 3, context: X, extra: [LAUNCH] });
  await b.go();
  const unload = await b.ev("localStorage.getItem('cc_test_unload')");
  const R = await quickRun(b);
  check('V9 the app was killed with no word: no pagehide and no visibilitychange reached it, and the last put-away had kept another screen',
    unload === null && stale === 'paint', JSON.stringify({ unload, stale }));
  doorsOk('V9 reopened after a kill with no word', R, { dest: 'armoury' });
  const way = await b.ev(`(() => { const out = []; Bay.back(); out.push(${SCR}); Bay.back(); out.push(${SCR}); return out; })()`);
  check('V9 that reopen opens onto the screen the player was on, with Back the way they came', JSON.stringify(way) === '["setup","home"]', JSON.stringify(way));
  await b.close();
  try { await send('Target.disposeBrowserContext', { browserContextId: X }); } catch {}
}
{
  // THE TIME IS KEPT WHILE THE PAGE IS ON SCREEN (round 2 review). A player
  // can stay on one screen for longer than the ten minutes and be killed
  // there with no word, so a beat keeps the time every LAST_USE_MS while the
  // page is on screen; while it is hidden nobody is using it, and the beat
  // keeps nothing. Two pages in two contexts, so neither writes over the
  // other's record: one on screen, one reading as hidden. Each sits on one
  // screen with its record set back 9 min 55 s, nothing else changed, and both
  // are read a beat later. The page on screen is also counted: one beat is
  // one write, never a stream of them.
  const vis = await openPage({ w: 844, h: 390, dpr: 3, noIntro: true });
  const hid = await openPage({ w: 844, h: 390, dpr: 3, noIntro: true });
  await vis.go(); await hid.go(); await bayReady(vis); await bayReady(hid);
  const BEAT = await vis.ev("typeof LAST_USE_MS === 'number' ? LAST_USE_MS : 0");
  await hid.ev("(Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }), true)");
  const SET_BACK = `(() => {
    Bay.go('career');
    const v = JSON.parse(localStorage.getItem('cc_last_view') || 'null') || { scr: 'none', path: [], mode: ccMode }; v.t = Date.now() - 595000; localStorage.setItem('cc_last_view', JSON.stringify(v));
    window.__lvWrites = 0; const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k) { if (k === 'cc_last_view') window.__lvWrites++; return set.apply(this, arguments); };
    return true;
  })()`;
  await vis.ev(SET_BACK); await hid.ev(SET_BACK);
  await sleep((BEAT || 15000) + 1500);
  const AGE = "(() => { const v = JSON.parse(localStorage.getItem('cc_last_view') || 'null'); return v ? { scr: v.scr, age: Date.now() - v.t, writes: window.__lvWrites } : null; })()";
  const [on, off] = [await vis.ev(AGE), await hid.ev(AGE)];
  check(`V9 while the page is on screen a beat keeps the last use every ${BEAT / 1000} s: set back 9 min 55 s on one screen, it was ${on && Math.round(on.age / 1000)} s old a beat later, in ${on && on.writes} write(s)`,
    BEAT > 0 && BEAT <= 15000 && !!on && on.scr === 'career' && on.age >= 0 && on.age <= BEAT + 1500 && on.writes >= 1 && on.writes <= 2, JSON.stringify(on));
  check('V9 and while the page is hidden the beat keeps nothing', !!off && off.scr === 'career' && off.age >= 595000 && off.writes === 0, JSON.stringify(off));
  await vis.close(); await hid.close();
}
await quickCase('V9 a reopen 9 min 50 s after last use', { extra: [LAST(590000, { scr: 'settings', path: ['home'], mode: 'boss' })] }, BASE, { dest: 'settings',
  also: async (p) => check('V9 that reopen has Boss Fight armed again, as it was left', (await p.ev('ccMode')) === 'boss') });
for (const [label, age] of [['V9 10 min 10 s after last use: the full intro again', 610000], ['V9 a last use stamped in the future (a clock set back): the full intro', -60000]]) {
  const p = await openPage({ w: 844, h: 390, dpr: 3, extra: [LAST(age, { scr: 'settings', path: ['home'], mode: 'boss' })] });
  await p.go();
  const st = await p.until((x) => x.state === 'running' && x.tp >= 300, 6000);
  check(label, !!st && st.mode === 'full' && st.state === 'running', JSON.stringify(st));
  if (age > 0) {
    // Only the quick doors hold toasts (round 2 review): over the full intro a
    // boot message still shows at once, as intro.js's z-order intends.
    const shown = await p.ev("(showToast('A boot message'), { cv: !!document.getElementById('intro'), running: window.__ccIntro.state === 'running', items: [...document.querySelectorAll('.toast-item')].map((t) => t.textContent) })");
    check('V9 over the full intro a toast still shows at once', shown.cv && shown.running && shown.items.includes('A boot message'), JSON.stringify(shown));
    // EXCEPT THE ONE-TIME NAME NOTICE (round 3 fix, 2026-10-10). "Your name was
    // taken, so you're now X." is said once and never again, and the claim
    // that earns it is answered during the full intro of the first launch
    // after an update; drawn there it was gone before the menu came up. It is
    // held while the doors (either kind) are up and shown once they have gone,
    // on the live menu, exactly once. Every toast that reaches the screen from
    // here on is recorded with whether the intro's canvas was still up.
    const nm = await p.ev(`(() => {
      window.__nm = [];
      new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList.contains('toast-item') && n.textContent.startsWith('Your name'))
        window.__nm.push({ text: n.textContent, cv: !!document.getElementById('intro'), up: window.CC_DOORS_UP === true }); }).observe(document.getElementById('app'), { childList: true, subtree: true });
      nameMovedTold = ''; tellNameMoved('taken', 'Amber Hammer 444'); tellNameMoved('taken', 'Amber Hammer 444');
      return { running: window.__ccIntro.state === 'running', cv: !!document.getElementById('intro'), up: window.CC_DOORS_UP === true,
        items: [...document.querySelectorAll('.toast-item')].map((t) => t.textContent).filter((t) => t.startsWith('Your name')) };
    })()`);
    check('R3 the one-time "Your name was taken" notice is not drawn over the full intro', nm.running && nm.cv && nm.up && nm.items.length === 0, JSON.stringify(nm));
  }
  // ROUND 3 (owner, 2026-10-10: "AFTER 10 MIN (no match): the full intro ends
  // on the MAIN MENU"): played to its end, it lands on home with nothing of
  // the old view put back, neither its screen nor its mode.
  const end = await p.until((x) => x.state === 'ended', 12000);
  await settled(p);
  const at = await p.ev(`({ scr: ${SCR}, mode: ccMode, game: document.getElementById('game').classList.contains('active'), cv: !!document.getElementById('intro') })`);
  check(`R3 ${label.slice(3)}: played to its end, onto the main menu`, !!end && end.reason === 'done' && at.scr === 'home' && at.mode === 'duel' && !at.game && !at.cv, JSON.stringify({ end, at }));
  if (age > 0) {
    const want = "Your name was taken, so you're now Amber Hammer 444. You can change it in Bay controls.";
    const seen = await p.ev(`({ nm: window.__nm, scr: ${SCR}, on: [...document.querySelectorAll('.toast-item')].map((t) => t.textContent).filter((t) => t.startsWith('Your name')) })`);
    check('R3 and it is shown once the doors have gone, once, on the main menu', seen.nm.length === 1 && seen.nm[0].text === want && !seen.nm[0].cv && !seen.nm[0].up
      && seen.scr === 'home' && seen.on.length === 1, JSON.stringify(seen));
  }
  await p.close();
}
await quickCase('V9 a last view naming a screen that cannot come back (a lobby)', { extra: [LAST(60000, { scr: 'lobby', path: ['home'], mode: 'duel' })] }, BASE, { dest: 'home' });
await quickCase('V9 a last view with junk in its way back and its mode', { extra: [LAST(60000, { scr: 'paint', path: ['home', 'lobby', 7, 'settings', '__proto__'], mode: 'nuke' })] }, BASE, { dest: 'paint',
  also: async (p) => {
    const way = await p.ev(`(() => { const out = [ccMode]; Bay.back(); out.push(${SCR}); Bay.back(); out.push(${SCR}); return out; })()`);
    check('V9 only the screens that can come back are kept on the way back, and an unknown mode is not armed', JSON.stringify(way) === '["duel","settings","home"]', JSON.stringify(way));
  } });
await quickCase('V9 a launch boot takes somewhere (a room link) is boot\'s to route: the quick doors open onto home, not the last view',
  { extra: [LAST(60000, { scr: 'settings', path: ['home'], mode: 'boss' })] }, BASE + '?room=ABCD', { dest: 'home' });
{
  // With no doors there is no reopen: the screen comes back only under them.
  const p = await openPage({ w: 844, h: 390, dpr: 3, noIntro: true, extra: [LAST(60000, { scr: 'settings', path: ['home'], mode: 'boss' })] });
  await p.go(); await bayReady(p);
  check('V9 with the doors switched off a recent last view is not put back: home, as always', (await p.ev(SCR)) === 'home' && (await p.ev('ccMode')) === 'duel' && (await p.intro())?.state === 'off');
  await p.close();
}
await quickCase('V9 a reopen within ten minutes under reduced motion', { media: [{ name: 'prefers-reduced-motion', value: 'reduce' }], extra: [LAST(60000, { scr: 'career', path: ['home'], mode: 'duel' })] }, BASE, { dest: 'career', fade: true });
{
  // A HELD SEAT, the real way: a match against the computer is running when
  // the page is put away; the server holds the seat. Reopened, the doors wait
  // for the resume and open onto the match itself. On an iPhone 17's safe
  // areas, where the bay's stage and a hidden bay's measure differ: the doors
  // must not move when the match takes the bay's place under them.
  const { browserContextId: X } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const IP17 = { w: 874, h: 402, dpr: 3, insets: { left: 62, right: 62, top: 0, bottom: 21 } };
  const a = await openPage({ ...IP17, noIntro: true, context: X });
  await a.go(); await bayReady(a);
  // Started from Match setup, as a player does: the bay's last screen before
  // the match is setup, and the view kept is still home, not setup.
  await a.ev("(Bay.go('setup'), ccMode = 'duel', document.getElementById('createBtn').onclick(), true)");
  let playing = false;
  for (let i = 0; i < 150 && !playing; i++) { playing = await a.ev("!!(S.playing && localStorage.getItem('cc_resume'))"); if (!playing) await sleep(100); }
  // Away for longer than the old hold (OLD_HOLD_MS, standing in for its half
  // hour): the match is still there only because nobody else plays in it.
  await a.go('about:blank'); await sleep(200); await a.close();
  await sleep(OLD_HOLD_MS + 800);
  const b = await openPage({ ...IP17, context: X, extra: [LAUNCH, SLOW_ANSWER, TOASTS, DRAWS] });
  await b.go();
  const rec = await b.ev("JSON.parse(localStorage.getItem('cc_last_view') || 'null')");
  const R = await quickRun(b);
  check('V9 a match was running when the page was put away, and the view kept is home: the match is the held seat\'s to bring back', playing && !!rec && rec.scr === 'home', JSON.stringify(rec));
  doorsOk('V9 reopened on a held seat', R, { dest: 'game', prompt: false, held: true });
  revealOk('V9 reopened on a held seat', R);
  check(`V9 the doors waited for the resume, answered ${RESUME_SLOW} ms late (they opened at ${R.st && Math.round(R.st.openAt)} ms), and the match under them is the one that was held, back in play`,
    !!R.st && R.st.openAt >= RESUME_SLOW && await b.ev("!!(S.playing && S.code && localStorage.getItem('cc_resume'))"), JSON.stringify(R.st));
  check(`V9 that match was brought back from more than ${OLD_HOLD_MS + 800} ms away, past the old hold of ${OLD_HOLD_MS} ms, and nothing says it ended`,
    !R.T.mgFirst && !(await b.ev("!!document.getElementById('mgone') && !document.getElementById('mgone').hidden")), JSON.stringify(R.T.mgFirst));
  // THE DOORS STAY CLEAN (round 2 review): the resume's toasts used to be
  // drawn on the sealed doors before they parted. Now no toast is up on any
  // frame of the doors, and every toast asked for while they were up is shown
  // once they have gone, in the order it was asked for, none lost.
  await sleep(100);
  const T9 = await b.ev('JSON.parse(JSON.stringify(window.__toasts))');
  const rows9 = R.T.quick || [], heldAsk = T9.asked.filter((x) => x.up).map((x) => x.text);
  check(`V9 no toast is drawn on the doors: none up on any of their ${rows9.length} frames, and none put up while the intro's canvas was there`,
    rows9.length > 20 && rows9.every((r) => r.toast === 0) && T9.shown.every((x) => !x.cv), JSON.stringify({ up: rows9.filter((r) => r.toast > 0).length, shown: T9.shown }));
  check(`V9 every toast asked for while the doors were up is shown once they have gone, in order (${heldAsk.join(' / ')})`,
    heldAsk.includes('Reconnected — battle on!') && JSON.stringify(T9.shown.slice(0, heldAsk.length).map((x) => x.text)) === JSON.stringify(heldAsk), JSON.stringify(T9));
  await b.close();
  try { await send('Target.disposeBrowserContext', { browserContextId: X }); } catch {}
}
{
  // A held seat with no server to answer: the doors may not wait for ever.
  // They hold, alive (the beacons turn) and saying "Reconnecting..." (round
  // 3), for their ceiling, then open onto what is there.
  const NOSOCK = `window.WebSocket = function () { this.readyState = 0; this.send = function () {}; this.close = function () {}; };
    window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;`;
  await quickCase('V9 a held seat with no server to answer', { extra: [HELD, NOSOCK] }, BASE, { dest: 'home', prompt: false, held: true, ms: 25000,
    also: async (p, R) => {
      const hold = R.T.quick.filter((r) => r.open === 0 && r.t >= 300);
      // CHANGED 2026-10-10 (owner, round 3: "a safety limit of about 15 s").
      // The ceiling was 3 s and this pinned it (openAt 3000-3060), which is
      // what opened a slow resume onto home before the match came back.
      check(`R3 those doors hold for the owner's safety limit of 15 s and no longer (opened at ${R.st && Math.round(R.st.openAt)} ms)`, !!R.st && R.st.openAt >= 15000 && R.st.openAt <= 15060, JSON.stringify(R.st));
      check(`V9 and while they hold they are not a frozen frame: the beacons turn (${new Set(hold.map((r) => r.ring)).size} different looks in ${hold.length} frames)`,
        hold.length >= 20 && new Set(hold.map((r) => r.ring)).size >= hold.length / 2, JSON.stringify(hold.slice(0, 2)));
      spinOk('V9 a held seat with no server to answer', R, 400);
    } });
}

// ---- ROUND 3: THE DOORS STAY SHUT UNTIL THE LAST VIEW IS READY ---------------
// The owner (2026-10-10, item 26): "when a user loads back into a game and
// where they left off, the loading bay doors animation needs to open into
// what the player was last doing. The bay doors need to actually open and
// behind the bay doors needs to be where the player last left off." His
// answer, "Stay shut until ready": the doors stay closed, the studio mark and
// beacons lit and a small "Reconnecting..." on them, until the match is fully
// back, then open onto it; if the match is gone, onto home with the "match
// ended" message; a safety limit of about 15 s. They used to open after 3 s
// onto whatever was there, so a resume slower than that showed home first
// and the match then cut in over it. The server is made slow here as
// RESUME_SLOW makes it slow: 4 and 5 s, past the old limit and inside the
// new one; 20 s, past both; and 0.9 s, just before the words are due.
const IPHONE17 = { w: 874, h: 402, dpr: 3, insets: { left: 62, right: 62, top: 0, bottom: 21 } };
// A MATCH HELD FOR A DEVICE, made as the V9 case above makes one: a match
// against the computer started from Match setup in a page of browser context
// X, which is then put away. The match's code and the device's record of it.
async function holdMatch(X, view) {
  const a = await openPage({ ...view, noIntro: true, context: X });
  await a.go(); await bayReady(a);
  await a.ev("(Bay.go('setup'), ccMode = 'duel', document.getElementById('createBtn').onclick(), true)");
  let held = null;
  for (let i = 0; i < 150 && !held; i++) {
    held = await a.ev("S.playing && S.code && localStorage.getItem('cc_resume') ? { code: S.code, rec: JSON.parse(localStorage.getItem('cc_resume')) } : null");
    if (!held) await sleep(100);
  }
  await a.go('about:blank'); await sleep(200); await a.close();
  return held;
}
const BACK = "({ playing: S.playing === true && document.getElementById('game').classList.contains('active'), code: S.code, rec: JSON.parse(localStorage.getItem('cc_resume') || 'null'), mg: !!document.getElementById('mgone') && !document.getElementById('mgone').hidden })";
{
  // ANSWERED 5 s LATE: shut, alive and saying so until the match is back,
  // then open onto it, never onto home first.
  const SLOW = 5000, label = 'R3 a held seat answered 5 s late';
  const { browserContextId: X } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const held = await holdMatch(X, IPHONE17);
  const b = await openPage({ ...IPHONE17, context: X, extra: [LAUNCH, slowAnswer(SLOW), TOASTS, DRAWS] });
  await b.go();
  const R = await quickRun(b, 25000);
  doorsOk(label, R, { dest: 'game', prompt: false, held: true });
  revealOk(label, R);
  const back = await b.ev(BACK), qa = R.T.qa, ans = await b.ev('window.__answeredAt');
  check(`${label}: the doors stayed shut until it was back, past the old 3 s limit (answered at ${Math.round(ans)} ms on the doors' clock, opened at ${R.st && Math.round(R.st.openAt)} ms), onto the very match that was held, in play, and nothing says it ended`,
    !!held && !!R.st && ans > 3100 && R.st.openAt >= ans && R.st.openAt <= ans + 100 && R.st.openAt < 15000 && R.st.dest === 'game' && back.playing && back.code === held.code
    && !!back.rec && back.rec.code === held.code && !R.T.mgFirst && !back.mg, JSON.stringify({ held, ans, st: R.st, back }));
  const hold = R.T.quick.filter((r) => r.open === 0 && r.t >= 300);
  check(`${label}: all through the wait the doors covered the screen and stayed alive, the beacons turning (${new Set(hold.map((r) => r.ring)).size} looks in ${hold.length} frames), over ${qa.shut} shut frames and ${qa.scans} looks at the page`,
    qa.shut >= 200 && qa.scans >= 15 && hold.length >= 200 && new Set(hold.map((r) => r.ring)).size >= hold.length / 2, JSON.stringify({ shut: qa.shut, scans: qa.scans }));
  await sleep(100);
  const T = await b.ev('JSON.parse(JSON.stringify(window.__toasts))'), ask = T.asked.filter((x) => x.up).map((x) => x.text);
  spinOk(label, R, 60);
  litOk(label, R, false);
  check(`${label}: "Reconnected — battle on!" waited for the doors and showed once they had gone`,
    ask.includes('Reconnected — battle on!') && T.shown.some((x) => x.text === 'Reconnected — battle on!') && T.shown.every((x) => !x.cv), JSON.stringify(T));
  await b.close();
  try { await send('Target.disposeBrowserContext', { browserContextId: X }); } catch {}
}
{
  // ANSWERED 20 s LATE: past the safety limit the doors open onto whatever
  // is there, home, and the resume that lands later still takes the player
  // back to the match.
  const SLOW = 20000, label = 'R3 a held seat answered 20 s late';
  const { browserContextId: X } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const held = await holdMatch(X, IPHONE17);
  const b = await openPage({ ...IPHONE17, context: X, extra: [LAUNCH, slowAnswer(SLOW), TOASTS, DRAWS] });
  await b.go();
  const R = await quickRun(b, 25000);
  doorsOk(label, R, { dest: 'home', prompt: false, held: true });
  spinOk(label, R, 400);
  check(`${label}: at the safety limit the doors open onto what is there (at ${R.st && Math.round(R.st.openAt)} ms, onto ${R.st && R.st.dest}), with the seat still held`,
    !!R.st && R.st.openAt >= 15000 && R.st.openAt <= 15060 && R.st.dest === 'home' && !!R.T.quickOpen && R.T.quickOpen.resume === true, JSON.stringify({ st: R.st, at: R.T.quickOpen }));
  let back = null;
  for (let i = 0; i < 150; i++) { back = await b.ev(BACK); if (back.playing) break; await sleep(100); }
  await sleep(100);
  const T = await b.ev('JSON.parse(JSON.stringify(window.__toasts))');
  check(`${label}: the resume that lands later still takes the player to the match that was held, says "Reconnected — battle on!", and nothing says the match ended`,
    !!held && back.playing && back.code === held.code && !!back.rec && back.rec.code === held.code && !back.mg && !R.T.mgFirst
    && T.shown.some((x) => x.text === 'Reconnected — battle on!' && !x.cv), JSON.stringify({ held, back, T }));
  await b.close();
  try { await send('Target.disposeBrowserContext', { browserContextId: X }); } catch {}
}
// REFUSED 5 s LATE: the match is gone. The doors wait for the answer, open
// onto home, and only then is it said that the match ended.
await quickCase('R3 a held seat the server no longer has, answered 5 s late', { extra: [HELD, slowAnswer(5000)] }, BASE, { dest: 'home', prompt: false, held: true, ms: 25000,
  also: async (p, R) => {
    const first = R.T.mgFirst, ans = await p.ev('window.__answeredAt');
    const mg = await p.ev(`(() => { const m = document.getElementById('mgone'); const up = !!(m && !m.hidden); return { up, text: up ? m.querySelector('.mgh').textContent : null }; })()`);
    check(`R3 those doors stayed shut until the refusal (answered at ${Math.round(ans)} ms on the doors' clock, past the old 3 s; opened at ${R.st && Math.round(R.st.openAt)} ms), opened onto home with the record cleared, and only once they had gone does home say "That match ended while you were away."`,
      !!R.st && ans > 3100 && R.st.openAt >= ans && R.st.openAt <= ans + 100 && R.st.openAt < 15000 && !!R.T.quickOpen && R.T.quickOpen.resume === false && mg.up && mg.text === 'That match ended while you were away.'
      && R.T.qa.mg === 0 && !!first && first.state === 'ended' && !first.cv, JSON.stringify({ st: R.st, mg, first }));
  } });
{
  // UNDER REDUCED MOTION, "the same waiting, then the fade": shut and saying
  // so until the match is back (4 s), then faded onto it.
  const SLOW = 4000, label = 'R3 a held seat answered 4 s late, under reduced motion';
  const { browserContextId: X } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const held = await holdMatch(X, { w: 844, h: 390, dpr: 3 });
  const b = await openPage({ w: 844, h: 390, dpr: 3, context: X, media: [{ name: 'prefers-reduced-motion', value: 'reduce' }], extra: [LAUNCH, slowAnswer(SLOW), DRAWS] });
  await b.go();
  const R = await quickRun(b, 25000);
  doorsOk(label, R, { dest: 'game', fade: true, prompt: false, held: true });
  revealOk(label, R);
  litOk(label, R, true);
  const back = await b.ev(BACK), ans = await b.ev('window.__answeredAt');
  check(`${label}: the doors waited for the match, past the old 3 s limit (answered at ${Math.round(ans)} ms on the doors' clock, faded from ${R.st && Math.round(R.st.openAt)} ms), and it is the match that was held, in play`,
    !!held && !!R.st && ans > 3100 && R.st.openAt >= ans && R.st.openAt <= ans + 100 && R.st.openAt < 15000 && back.playing && back.code === held.code, JSON.stringify({ held, ans, st: R.st, back }));
  await b.close();
  try { await send('Target.disposeBrowserContext', { browserContextId: X }); } catch {}
}
{
  // TAPPED WHILE IT WAITS (round 3 review): a tap, a mouse click, a key press
  // and an assistive-technology click on a held seat's shut doors, while its
  // resume is still out, end nothing and reach nothing. The doors stay shut
  // until the match is back (5 s), then open onto it, as they do untouched.
  // A tap used to end them at once: home came up with the resume still out,
  // and the match then cut in over it.
  const SLOW = 5000, label = 'R3 a held seat answered 5 s late, tapped, clicked and keyed at while it waits';
  const { browserContextId: X } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const held = await holdMatch(X, { w: 844, h: 390, dpr: 3 });
  const b = await openPage({ w: 844, h: 390, dpr: 3, context: X, extra: [LAUNCH, slowAnswer(SLOW), DRAWS] });
  await b.go();
  const after = [];
  const note = async (what) => { await sleep(120); const st = await b.intro(); after.push({ what, t: st && Math.round(st.t), state: st && st.state, reason: st && st.reason, open: st && st.open }); };
  await b.until((x) => x.state === 'running' && x.t >= 1500, 10000);
  const boards = await boardsState(b);
  await b.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 422, y: 195 }] });
  await b.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await note('a tap');
  await b.until((x) => x.t >= 2000, 10000);
  await b.s('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 200, button: 'left', clickCount: 1 });
  await b.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 300, y: 200, button: 'left', clickCount: 1 });
  await note('a mouse click');
  await b.until((x) => x.t >= 2500, 10000);
  await b.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
  await b.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
  await note('a key press');
  await b.until((x) => x.t >= 3000, 10000);
  // assistive technology activates by click with no pointer before it
  await b.ev("(document.querySelectorAll('#bay .board')[3] || document.getElementById('app')).click(), true");
  await note('an assistive-technology click');
  const R = await quickRun(b, 25000);
  doorsOk(label, R, { dest: 'game', prompt: false, held: true });
  revealOk(label, R);
  const back = await b.ev(BACK), ans = await b.ev('window.__answeredAt'), clicks = await b.ev('window.__t.clicks');
  check(`${label}: each of them left the doors shut and running (${after.map((a) => a.what + ' at ' + a.t + ' ms').join(', ')}), none reached the page, and the doors opened only once the match was back (answered at ${Math.round(ans)} ms, opened at ${R.st && Math.round(R.st.openAt)} ms), onto the very match that was held, in play`,
    !!held && after.length === 4 && after.every((a) => a.state === 'running' && !a.reason && a.open === 0 && a.t < ans) && clicks === 0 && (await boardsState(b)) === boards
    && !!R.st && ans > 3100 && R.st.openAt >= ans && R.st.openAt <= ans + 100 && back.playing && back.code === held.code, JSON.stringify({ after, clicks, ans, st: R.st, back }));
  await b.close();
  try { await send('Target.disposeBrowserContext', { browserContextId: X }); } catch {}
}
{
  // ...AND ONCE THEY HAVE BEGUN TO OPEN onto the match (answered at 1.5 s),
  // a tap ends them as it ends any doors: what they wait for is there.
  const label = 'R3 a held seat answered at 1.5 s, tapped once its doors have begun to open';
  const { browserContextId: X } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const held = await holdMatch(X, { w: 844, h: 390, dpr: 3 });
  const b = await openPage({ w: 844, h: 390, dpr: 3, context: X, extra: [LAUNCH, answerAt(1500), DRAWS] });
  await b.go();
  const was = await b.until((x) => x.state === 'running' && x.open > .05, 10000);
  await b.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 422, y: 195 }] });
  const st = await b.intro();
  await b.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
  const back = await b.ev(BACK), clicks = await b.ev('window.__t.clicks');
  check(`${label}: the tap ended them there and then (tapped ${was && was.open.toFixed(2)} of the way open), onto the match that was held, and pressed nothing`,
    !!held && !!was && was.open < .5 && st && st.state === 'ended' && st.reason === 'skip-pointer' && back.playing && back.code === held.code && clicks === 0,
    JSON.stringify({ was, st, back, clicks }));
  await b.close();
  try { await send('Target.disposeBrowserContext', { browserContextId: X }); } catch {}
}
{
  // ANSWERED JUST BEFORE THE WORDS ARE DUE (0.9 s): the doors open onto the
  // match, and the words, due at 1 s while the doors are part way open, never
  // come up on doors that are opening onto the match they were waiting for.
  const label = 'R3 a held seat answered at 0.9 s, just before the words are due';
  const { browserContextId: X } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const held = await holdMatch(X, { w: 844, h: 390, dpr: 3 });
  const b = await openPage({ w: 844, h: 390, dpr: 3, context: X, extra: [LAUNCH, answerAt(900), DRAWS] });
  await b.go();
  const R = await quickRun(b, 25000);
  doorsOk(label, R, { dest: 'game', prompt: false, held: true });
  revealOk(label, R);
  const back = await b.ev(BACK);
  check(`${label}: they opened onto that match (at ${R.st && Math.round(R.st.openAt)} ms), and nothing was said on any frame of them`,
    !!held && !!R.st && R.st.openAt >= 900 && R.st.openAt < LABEL_AT && back.playing && back.code === held.code
    && R.T.qa.labelFirst === null && R.T.qa.litFirst === null && R.st.labelAt === undefined, JSON.stringify({ st: R.st, qa: R.T.qa, back }));
  await b.close();
  try { await send('Target.disposeBrowserContext', { browserContextId: X }); } catch {}
}
// A MENU SCREEN WITHIN TEN MINUTES keeps waiting for that screen, under the
// same 15 s limit: here the bay comes 4.5 s late, past the old 3 s limit,
// which opened these doors onto a bay that had drawn nothing.
await quickCase('R3 a reopen within ten minutes whose screen is 4.5 s late', { slowBay: 4500, extra: [LAST(60000, { scr: 'career', path: ['home'], mode: 'duel' })] }, BASE, { dest: 'career', prompt: false, ms: 25000,
  also: async (p, R) => check(`R3 those doors waited for the Career screen, past the old 3 s limit and inside the new one (opened at ${R.st && Math.round(R.st.openAt)} ms)`,
    !!R.st && R.st.openAt > 3100 && R.st.openAt < 15000 && R.st.dest === 'career', JSON.stringify(R.st)) });
{
  // ONLY A HELD SEAT'S DOORS ARE KEPT FROM A TAP (round 3 review): the same
  // reopen, its screen 4.5 s late, tapped at 1.5 s, ends its doors as a tap
  // always has.
  const p = await openPage({ w: 844, h: 390, dpr: 3, slowBay: 4500, extra: [LAST(60000, { scr: 'career', path: ['home'], mode: 'duel' }), LAUNCH] });
  await p.go();
  const was = await p.until((x) => x.state === 'running' && x.t >= 1500, 10000);
  await p.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 422, y: 195 }] });
  const st = await p.intro();
  await p.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check('R3 the doors of a reopen with no held seat still end on a tap while they wait for a late screen',
    !!was && was.mode === 'quick' && was.open === 0 && st && st.state === 'ended' && st.reason === 'skip-pointer', JSON.stringify({ was, st }));
  await sleep(150);
  await p.close();
}
{
  // THE NATIVE LAUNCH HOLD ON THE PATHS WITH NO DOORS: let go once, after the
  // menu has painted (the doors' paths are checked above, and the intro's
  // in every playthrough).
  const p = await openPage({ w: 844, h: 390, dpr: 3, extra: [LAUNCH] });
  await p.go(); await p.until((x) => x.state === 'running' && x.t >= 300, 6000);
  await p.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
  await p.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
  await settled(p);
  const L1 = await p.ev('JSON.parse(JSON.stringify(window.__launch))');
  check('V9 a skipped intro lets the launch hold go once, with the doors up', L1.hides === 1 && L1.at[0].canvas && L1.at[0].alpha === 255, JSON.stringify(L1));
  await p.go(); await sleep(900);
  const L2 = await p.ev('JSON.parse(JSON.stringify(window.__launch))');
  check('V9 a load that is not a launch lets it go once, onto the drawn menu', (await p.intro())?.state === 'off' && L2.hides === 1 && !L2.at[0].canvas && L2.at[0].scr === 'home', JSON.stringify(L2));
  await p.close();
  const q = await openPage({ w: 844, h: 390, dpr: 3, noIntro: true, extra: [LAUNCH] });
  await q.go(); await sleep(900);
  const L3 = await q.ev('JSON.parse(JSON.stringify(window.__launch))');
  check('V9 the test switch lets it go once, onto the drawn menu', L3.hides === 1 && !L3.at[0].canvas && L3.at[0].scr === 'home', JSON.stringify(L3));
  await q.close();
}

// ---- A7: skipping ------------------------------------------------------------
async function boardsState(p) { return p.ev("Array.from(document.querySelectorAll('#bay .board')).map((b) => b.classList.contains('on') ? 1 : 0).join('')"); }
async function boardCentre(p, i) {
  return p.ev(`(() => { const b = document.querySelectorAll('#bay .board')[${i}]; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
}
{
  const p = await openPage({ w: 844, h: 390, dpr: 3 });
  await p.go(); await p.until((x) => x.state === 'running' && x.tp >= 1000, 6000);
  const before = await boardsState(p);
  const [x, y] = await boardCentre(p, 3);
  await p.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  const st = await p.intro();
  await p.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check('A7 a tap ends it at once', st && st?.state === 'ended' && st?.reason === 'skip-pointer', JSON.stringify(st));
  await sleep(150);
  check('A7 the skipping tap presses nothing (the board under it is not armed)', (await boardsState(p)) === before && (await p.ev('window.__t.clicks')) === 0,
    `boards ${before} -> ${await boardsState(p)}, clicks ${await p.ev('window.__t.clicks')}`);
  await sleep(450);
  check('A7 the shield is gone after the tap', !(await p.ev("!!document.getElementById('intro')")));
  { const r = await p.ev(REDRAW_DIFF); check('A7 nothing the intro wrote survives a skip', r.length === 0, r.slice(0, 6).join(', ')); }
  await p.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await p.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  check('A7 the next tap reaches the menu', (await boardsState(p)) !== before, `boards ${before} -> ${await boardsState(p)}`);
  check('A7 the bay is not left inert', !(await p.ev("document.getElementById('bay').inert")));
  await p.close();
}
{
  const p = await openPage({ w: 1440, h: 900, dpr: 2 });
  await p.go(); await p.until((x) => x.state === 'running' && x.tp >= 1200, 6000);
  const before = await boardsState(p);
  const [x, y] = await boardCentre(p, 2);
  await p.s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await p.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(150);
  const st = await p.intro();
  check('A7 a mouse click ends it and presses nothing', st?.reason === 'skip-pointer' && (await boardsState(p)) === before && (await p.ev('window.__t.clicks')) === 0,
    `${JSON.stringify(st)} boards ${before} -> ${await boardsState(p)}`);
  await sleep(100);
  check('A7 no shield after a mouse click', !(await p.ev("!!document.getElementById('intro')")));
  await p.close();
}
{
  const p = await openPage({ w: 1440, h: 900, dpr: 2 });
  await p.go(); await p.until((x) => x.state === 'running' && x.tp >= 1200, 6000);
  await p.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
  await p.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
  await sleep(80);
  const st = await p.intro();
  check('A7 a key press ends it, with nothing left on screen', st?.reason === 'skip-key' && !(await p.ev("!!document.getElementById('intro')")), JSON.stringify(st));
  await p.close();
}
{
  const p = await openPage({ w: 844, h: 390, dpr: 3 });
  await p.go(); await p.until((x) => x.state === 'running' && x.tp >= 1000, 6000);
  await p.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 400, y: 200 }] });
  await p.s('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await sleep(60);
  check('A7 a cancelled touch skips and leaves no shield', (await p.intro())?.state === 'ended' && !(await p.ev("!!document.getElementById('intro')")));
  await p.close();
}
{
  const p = await openPage({ w: 844, h: 390, dpr: 3 });
  await p.go(); await p.until((x) => x.state === 'running' && x.tp >= 1000, 6000);
  const before = await boardsState(p);
  // assistive technology activates by click with no pointer before it
  await p.ev("document.querySelectorAll('#bay .board')[3].click()");
  await sleep(60);
  const st = await p.intro();
  check('A7 an assistive-technology click skips it and reaches nothing', st?.reason === 'skip-click' && (await boardsState(p)) === before, JSON.stringify(st));
  await p.close();
}

// ---- A8: the menu redraws itself mid-entrance --------------------------------
{
  const p = await openPage({ w: 844, h: 390, dpr: 3 });
  await p.go(); await p.until((x) => x.state === 'running' && x.tp >= 5080, 9000);
  const r = await p.ev(`(async () => {
    const units = Array.from(document.querySelectorAll('#bay .board, #bay .lbar, #bay .pnl'));
    const before = units.map((e) => +getComputedStyle(e).opacity);
    document.dispatchEvent(new Event('cc:social'));
    await Promise.resolve();
    const after = units.map((e) => +getComputedStyle(e).opacity);
    return { before, after };
  })()`);
  const drift = r.before.map((b, i) => Math.abs(b - r.after[i]));
  check('A8 a redraw mid-entrance does not pop the chrome to full', Math.max(...drift) < .12 && r.before.some((b) => b < .9),
    `before ${r.before.map((x) => x.toFixed(2))} after ${r.after.map((x) => x.toFixed(2))}`);
  const fin = await p.until((x) => x.state === 'ended', 9000);
  await settled(p);
  check('A8 it still completes, and the seam still holds', fin?.reason === 'done' && (await p.ev(REDRAW_DIFF)).length === 0);
  await p.close();
}

// ---- A9: a slow menu ---------------------------------------------------------
{
  const p = await openPage({ w: 844, h: 390, dpr: 3, slowBay: 3500 });
  await p.go();
  const mid = await p.until((x) => x.state === 'running' && x.t >= 3200, 9000);
  check('A9 a menu that is not ready holds the intro on the logo', mid && mid?.tp <= 2101 && mid?.t >= 3200, JSON.stringify(mid));
  const fin = await p.until((x) => x.state === 'ended', 20000);
  await settled(p);
  const T = await p.ev('window.__t');
  check('A9 it then completes', fin && fin?.reason === 'done', JSON.stringify(fin));
  check('A9 no chrome is visible at the reveal', Array.isArray(T.revealOpacity) && T.revealOpacity.length > 0 && Math.max(...T.revealOpacity) === 0, JSON.stringify(T.revealOpacity));
  check('A9 the seam holds after a hold', (await p.ev(REDRAW_DIFF)).length === 0);
  await p.close();
}

// ---- A10: a dashboard element the intro has never seen ------------------------
async function injectAt(tpAt, label) {
  const p = await openPage({ w: 844, h: 390, dpr: 3 });
  await p.go(); await p.until((x) => x.state === 'running' && x.tp >= tpAt, 9000);
  await p.ev(`(() => { const d = document.createElement('div'); d.className = 'cc-test-new'; d.setAttribute('style', 'position:absolute;left:400px;top:190px;width:80px;height:30px;z-index:15;background:rgb(200,40,40)');
    document.querySelector('#bay .stage').appendChild(d); })()`);
  const samples = [];
  for (;;) {
    const st = await p.intro();
    const o = await p.ev("(() => { const d = document.querySelector('.cc-test-new'); return d ? +getComputedStyle(d).opacity : -1; })()");
    samples.push([Math.round(st?.tp), o]);
    if (st?.state !== 'running') break;
    await sleep(40);
  }
  await settled(p);
  const final = await p.ev("(() => { const d = document.querySelector('.cc-test-new'); return d ? [getComputedStyle(d).opacity, d.getAttribute('style')] : null; })()");
  return { p, samples, final };
}
{
  const { p, samples, final } = await injectAt(1000, 'before');
  const early = samples.filter(([tp]) => tp < 4880).map(([, o]) => o);
  const rose = samples.some(([tp, o]) => tp > 4900 && o > 0 && o < 1);
  check('A10 a new chrome element added before the reveal is hidden, then dealt in', early.every((o) => o === 0) && rose, JSON.stringify(samples.filter((_, i) => i % 6 === 0)));
  check('A10 and is left exactly as it was written', final && final[0] === '1' && final[1] === 'position:absolute;left:400px;top:190px;width:80px;height:30px;z-index:15;background:rgb(200,40,40)', JSON.stringify(final));
  await p.close();
}
{
  const { p, samples, final } = await injectAt(5300, 'during');
  const shown = samples.findIndex(([, o]) => o > 0);
  const blink = shown >= 0 && samples.slice(shown).some(([, o]) => o === 0);
  check('A10 a chrome element added mid-entrance never blinks out', !blink && final && final[0] === '1', JSON.stringify(samples.slice(0, 8)));
  await p.close();
}

// ---- leaving home mid-intro --------------------------------------------------
{
  const p = await openPage({ w: 844, h: 390, dpr: 3 });
  await p.go(); await p.until((x) => x.state === 'running' && x.tp >= 1500, 6000);
  await p.ev("window.Bay.show('settings')");
  await sleep(60);
  const st = await p.intro();
  const left = await p.ev("Array.from(document.querySelectorAll('#bay [style]')).filter((e) => /translate|scale|transition: none|opacity/.test(e.getAttribute('style'))).length");
  check('abort: leaving home mid-intro ends it at once', st?.state === 'ended' && st?.reason === 'abort' && !(await p.ev("!!document.getElementById('intro')")), JSON.stringify(st));
  check('abort: the new screen carries nothing the intro wrote', left === 0, `${left} elements`);
  await p.close();
}

// ---- A11: faults inside the intro --------------------------------------------
{
  // a throw inside a frame, mid-intro
  const p = await openPage({ w: 844, h: 390, dpr: 3, extra: [`(() => {
    const orig = CanvasRenderingContext2D.prototype.drawImage; let armed = true;
    CanvasRenderingContext2D.prototype.drawImage = function () {
      if (armed && window.__ccIntro && window.__ccIntro.tp > 1200) { armed = false; throw new Error('injected intro fault'); }
      return orig.apply(this, arguments);
    };
  })();`] });
  await p.go();
  const st = await p.until((x) => x.state === 'ended', 9000);
  await sleep(150);
  const T = await p.ev('window.__t');
  check('A11 a throw inside a frame ends the intro cleanly', st?.reason === 'error' && !(await p.ev("!!document.getElementById('intro') || document.getElementById('bay').inert")), JSON.stringify(st));
  check('A11 and is reported exactly once', T.errors === 1, `${T.errors} reports`);
  check('A11 and leaves the menu as the template wrote it', (await p.ev(REDRAW_DIFF)).length === 0);
  await p.close();
}
{
  // a throw inside the end itself
  const p = await openPage({ w: 844, h: 390, dpr: 3, extra: [`(() => {
    const orig = Element.prototype.setAttribute; let armed = true;
    Element.prototype.setAttribute = function (n) {
      if (armed && n === 'style' && window.__ccIntro && window.__ccIntro.state === 'ended') { armed = false; throw new Error('injected teardown fault'); }
      return orig.apply(this, arguments);
    };
  })();`] });
  await p.go(); await p.until((x) => x.state === 'running' && x.tp >= 5300, 9000);
  await p.s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
  await sleep(150);
  check('A11 a throw inside the end still removes the overlay and the inert', !(await p.ev("!!document.getElementById('intro') || document.getElementById('bay').inert")));
  await p.close();
}

// ---- A15: the iOS launch image is still the intro's frame 0 ------------------
// iOS shows LaunchDoors aspect-fill and the intro lays its doors out the same
// way, so the hand-off is invisible only while the committed PNG is what
// intro.js paints. Any change to the door painter must be followed by
// `node tools/splash/render-doors.mjs`; this is what notices when it was not.
{
  const SET = join(ROOT, 'ios/App/App/Assets.xcassets/LaunchDoors.imageset'), SIDE = 2732;
  let png = null, contents = null;
  try { png = decodeRGB(readFileSync(join(SET, 'launch-doors.png'))); } catch (e) { check('A15 the launch image reads as 8-bit RGB', false, e.message); }
  try { contents = JSON.parse(readFileSync(join(SET, 'Contents.json'), 'utf8')); } catch {}
  const files = contents ? [...new Set(contents.images.map((i) => i.filename))] : [];
  check('A15 the launch imageset uses launch-doors.png at every scale', files.length === 1 && files[0] === 'launch-doors.png' && contents.images.length === 3, JSON.stringify(files));
  // V9: the quick doors start on the same frame 0, so a reopen, a held seat
  // or a link opens on exactly the launch image too, and nothing jumps when
  // iOS lets it go.
  for (const [mode, extra, label] of [['full', [], 'A15 the launch image is the intro\'s frame 0 (re-run tools/splash/render-doors.mjs if not)'],
    ['quick', [LAST(60000, { scr: 'settings', path: ['home'], mode: 'duel' })], 'A15/V9 the launch image is the quick doors\' frame 0 too']]) {
    if (!png) break;
    const p = await openPage({ w: SIDE, h: SIDE, dpr: 1, extra: ['window.__ccIntroFrame0 = true;', ...extra] });
    await p.go();
    const st = await p.until((x) => x.state === 'running', 10000);
    await sleep(600);
    const size = await p.ev("(() => { const cv = document.getElementById('intro'); return cv ? cv.width + 'x' + cv.height : 'missing'; })()");
    if (st?.state !== 'running' || st?.mode !== mode || size !== `${SIDE}x${SIDE}` || png.w !== SIDE || png.h !== SIDE) {
      check(`A15 frame 0 renders at the launch image size (${mode})`, false, `intro ${st?.state} ${st?.mode}, canvas ${size}, png ${png.w}x${png.h}`);
    } else {
      const { rgb, opaque } = await readCanvasRGB(p.ev, SIDE, SIDE);
      // Same Chrome, same pixels. A different Chrome may dither a gradient a
      // level differently, so a few pixels may move by 1-2; a door painter
      // change moves whole ribs, rivets or shading by far more than that.
      let exact = 0, off = 0, worst = 0;
      for (let i = 0; i < rgb.length; i += 3) {
        const d = Math.max(Math.abs(rgb[i] - png.rgb[i]), Math.abs(rgb[i + 1] - png.rgb[i + 1]), Math.abs(rgb[i + 2] - png.rgb[i + 2]));
        if (d === 0) exact++; else if (d > 2) off++;
        if (d > worst) worst = d;
      }
      const px = SIDE * SIDE;
      check(label, opaque && off <= px * 0.0005,
        `${opaque ? 'opaque' : 'NOT opaque'}; ${(100 * exact / px).toFixed(3)}% exact, ${off} pixels off by more than 2, worst ${worst}`);
    }
    await p.close();
  }
}
// V9: and the quick doors' first frame is the intro's first frame, pixel for
// pixel: one door painter, one layout. On an iPhone 17's safe areas, and where
// the seam falls between two device pixels, so the column the two halves
// share is the intro's too. The seam is the safe box's middle, so with whole
// CSS px it falls between device pixels only at a fractional scale (the
// canvas works at 2x at most): 845 wide at 1.5x puts it at 633.75.
for (const v of [{ label: '874x402 on an iPhone 17\'s safe areas', w: 874, h: 402, dpr: 3, insets: { left: 62, right: 62, top: 0, bottom: 21 } },
  { label: '845x390 @1.5x, the seam between two device pixels', w: 845, h: 390, dpr: 1.5 }]) {
  const shots = {};
  for (const [mode, extra] of [['full', []], ['quick', [LAST(60000, { scr: 'settings', path: ['home'], mode: 'duel' })]]]) {
    const p = await openPage({ ...v, extra: ['window.__ccIntroFrame0 = true;', ...extra] });
    await p.go();
    const st = await p.until((x) => x.state === 'running', 10000);
    await sleep(600);
    const [w, h] = await p.ev("(() => { const cv = document.getElementById('intro'); return cv ? [cv.width, cv.height] : [0, 0]; })()");
    shots[mode] = st?.mode === mode && w ? { w, h, ...(await readCanvasRGB(p.ev, w, h)) } : null;
    await p.close();
  }
  const F = shots.full, Qk = shots.quick;
  let diff = -1;
  if (F && Qk && F.w === Qk.w && F.h === Qk.h) { diff = 0; for (let i = 0; i < F.rgb.length; i++) if (F.rgb[i] !== Qk.rgb[i]) diff++; }
  check(`V9 at ${v.label} the quick doors' frame 0 is the intro's, pixel for pixel`, diff === 0 && F.opaque && Qk.opaque,
    JSON.stringify({ full: F && [F.w, F.h, F.opaque], quick: Qk && [Qk.w, Qk.h, Qk.opaque], diff }));
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
process.exit(failed ? 1 : 0);
