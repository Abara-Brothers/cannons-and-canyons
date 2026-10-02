// The cold-start intro (public/intro.js), in a real page.
//
// WHAT THIS PROVES. The owner's hard requirement is that the end of the intro
// IS the menu: the last frame and the first frame of the dashboard are the
// same picture, and that stays true when the dashboard changes. So the centre
// of this suite is the seam, checked three ways that do not depend on knowing
// what the dashboard looks like:
//   - the canvas is fully transparent on every frame of the hand-off;
//   - every element's computed style is identical in the last intro frame and
//     after the intro has removed itself;
//   - after the intro, a bay redraw (the morph re-asserts every attribute from
//     the template) finds NOTHING to change, and the #bay subtree equals a load
//     that never played the intro.
// Around that: no frame of the dashboard before the doors (A1), when it must
// not play (A4-A6), skipping (A7), the menu redrawing itself mid-intro (A8), a
// slow menu (A9), a dashboard element the intro has never seen (A10), leaving
// home mid-intro, faults inside the intro (A11), and the iOS launch image
// still being the intro's own frame 0 (A15). Criteria are numbered as
// in the governance spec, docs/superpowers/specs/2026-10-02-cold-start-intro-design.md.
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

const CDP_MS = 20000, RUN_MS = 300000;
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
srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const S = window.__t = { stageSeen: false, coverAtStage: null, a1Checks: 0, a1Fails: [], a3Frames: 0, a3Max: 0, seam: null, errors: 0, clicks: 0, revealOpacity: null };
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
  window.__snap = function () {
    return Array.from(document.querySelectorAll('#bay *')).map((el) => {
      const cs = getComputedStyle(el), anim = el.getAnimations ? el.getAnimations().length > 0 : false;
      return [el.tagName, el.className && el.className.baseVal === undefined ? el.className : '', anim ? null : PROPS.map((p) => cs.getPropertyValue(p))];
    });
  };
  function loop() {
    const I = window.__ccIntro, cv = document.getElementById('intro');
    if (I && I.state === 'running' && cv) {
      if (I.tp < 2100) { const r = alphaRange(cv); S.a1Checks++; if (r[0] < 255) S.a1Fails.push([Math.round(I.tp), r[0]]); }
      if (I.tp >= 2105 && I.tp < 2400 && S.revealOpacity === null) {
        const top = document.querySelector('#bay .stage .top');
        S.revealOpacity = top ? Array.from(top.children).filter((c) => { const r = c.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; }).map((c) => +getComputedStyle(c).opacity) : [];
      }
      if (I.tp >= 5955) { const r = alphaRange(cv); S.a3Frames++; if (r[1] > S.a3Max) S.a3Max = r[1]; }
      if (I.tp >= 5960 && !S.seam) S.seam = window.__snap();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();`;
const NAME = "try { localStorage.setItem('pt_name', 'TESTPILOT'); } catch (e) {}";

async function openPage({ w = 844, h = 390, dpr = 2, insets = null, name = true, noIntro = false, extra = [], media = null, slowBay = 0 } = {}) {
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
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
  const close = async () => { listeners.delete(sessionId); try { await send('Target.closeTarget', { targetId }); } catch {} try { await send('Target.disposeBrowserContext', { browserContextId }); } catch {} };
  return { s, ev, go, intro, until, close, logs };
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

async function settled(p) {
  // the intro is gone (canvas, hint, any shield) and the page has had a beat
  for (let i = 0; i < 200; i++) { if (!(await p.ev("!!document.getElementById('intro')"))) break; await sleep(25); }
  await sleep(120);
}

// ---- the full playthroughs: A1, A2, A3 and the seam, per viewport -----------
const VIEWS = [
  { label: '844x390 phone', w: 844, h: 390, dpr: 3 },
  { label: '1180x820 iPad', w: 1180, h: 820, dpr: 2 },
  { label: '1440x900 desktop', w: 1440, h: 900, dpr: 2 },
  { label: '390x844 rotation shim', w: 390, h: 844, dpr: 3 },
  { label: '844x390 notched 47/47/0/21', w: 844, h: 390, dpr: 3, insets: { left: 47, right: 47, top: 0, bottom: 21 } },
  { label: '844x390 asymmetric 32/0/0/0', w: 844, h: 390, dpr: 3, insets: { left: 32, right: 0, top: 0, bottom: 0 } },
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

  const p = await openPage(v);
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
  const redraw = await p.ev(REDRAW_DIFF);
  check(`[${v.label}] A2 a redraw after the intro finds nothing to change`, redraw.length === 0, redraw.slice(0, 6).join(', '));
  const sub = await p.ev(SUBTREE);
  check(`[${v.label}] A2 the #bay subtree equals a load that never played the intro`, sub === controlSubtree[v.label],
    (() => { const a = sub.split('\n'), b = controlSubtree[v.label].split('\n'); const i = a.findIndex((x, k) => x !== b[k]); return i < 0 ? 'length differs' : `first difference: ${a[i]}  vs  ${b[i]}`; })());
  check(`[${v.label}] no canvas, no inert left behind`, !(await p.ev("!!document.getElementById('intro') || document.getElementById('bay').inert")));
  check(`[${v.label}] A11 no console errors`, p.logs.length === 0 && T.errors === 0, p.logs.slice(0, 3).join(' | '));
  if (v === VIEWS[0]) {
    // A4: the same tab again (Back to menu, a refresh, the sign-in return)
    await p.go(); await sleep(800);
    const again = await p.intro();
    check('A4 a second load in the same tab does not replay it', again && again.state === 'off', JSON.stringify(again));
  }
  await p.close();
}

// ---- A5 and A6: launches that must not play it ------------------------------
async function offCase(label, opts, url = BASE) {
  const p = await openPage(opts);
  await p.go(url); await sleep(900);
  const st = await p.intro();
  check(label, st && st?.state === 'off' && !(await p.ev("!!document.getElementById('intro')")), JSON.stringify(st));
  await p.close();
}
await offCase('A5 a room link with a saved name skips it', {}, BASE + '?room=ABCD');
await offCase('A5 a squad link with a saved name skips it', {}, BASE + '?squad=ABCD');
await offCase('A5 a held seat skips it', { extra: ["try { localStorage.setItem('cc_resume', JSON.stringify({ code: 'ABCD', seat: 0, token: 'x', t: Date.now() })); } catch (e) {}"] });
await offCase('A6 the OS reduced-motion setting skips it', { media: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await offCase("A6 the in-game Reduce motion toggle skips it", { extra: ["try { localStorage.setItem('cc_motion', '1'); } catch (e) {}"] });
await offCase('test switch: window.__ccNoIntro skips it', { noIntro: true });
{
  // R8: a first-time visitor on an invite link is not routed anywhere, so they get the intro
  const p = await openPage({ name: false });
  await p.go(BASE + '?room=ABCD');
  const st = await p.until((x) => x.state !== 'off', 2000);
  check('A5/R8 a nameless invite launch (boot routes nowhere) still plays it', st && st?.state === 'running', JSON.stringify(st));
  await p.close();
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
  if (png) {
    const p = await openPage({ w: SIDE, h: SIDE, dpr: 1, extra: ['window.__ccIntroFrame0 = true;'] });
    await p.go();
    const st = await p.until((x) => x.state === 'running', 10000);
    await sleep(600);
    const size = await p.ev("(() => { const cv = document.getElementById('intro'); return cv ? cv.width + 'x' + cv.height : 'missing'; })()");
    if (st?.state !== 'running' || size !== `${SIDE}x${SIDE}` || png.w !== SIDE || png.h !== SIDE) {
      check('A15 frame 0 renders at the launch image size', false, `intro ${st?.state}, canvas ${size}, png ${png.w}x${png.h}`);
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
      check('A15 the launch image is the intro\'s frame 0 (re-run tools/splash/render-doors.mjs if not)', opaque && off <= px * 0.0005,
        `${opaque ? 'opaque' : 'NOT opaque'}; ${(100 * exact / px).toFixed(3)}% exact, ${off} pixels off by more than 2, worst ${worst}`);
    }
    await p.close();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
cleanup();
process.exit(failed ? 1 : 0);
