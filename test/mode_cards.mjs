// THE MODE CARDS ARE STILLS FROM THE GAME (owner, 2026-10-07: "Each game mode
// card on the home menu dashboard needs to be the actual game mode ... make it
// look cooler ... use actual game footage or as close as possible"; his answer:
// real game scenes, styled, the same art on the Mission board and in Match
// setup). tools/cards/capture.mjs captures one moment of a real match of each
// mode and crops it once for each place a card is shown. This suite holds the
// three screens to those pictures, in a real page against a real server:
//   1. every mode's card on the home boards, the Mission board and Match
//      setup's brief is its own new still for that place -- the right mode,
//      the right shape, under bay.js's ?v= stamp -- and it has loaded;
//   2. each still has its box's shape (so the box crops nothing off it), and
//      on the largest screen the bay is drawn at (an iPad Pro 13", 1376 x
//      1032) it is at least twice the size it is shown at;
//   3. the scene reads: the top of each picture is shown at most of its own
//      brightness, not dimmed and shaded the way the old scenery was;
//   4. the glint sweeps only the armed card, never a greyed one, and stops
//      for reduced motion, the OS setting and the in-game switch alike;
//   5. offline: from a clean slate the service worker precaches every card at
//      install under the URL the page asks for, and with the server gone a
//      reload still shows them all; the old pictures are neither asked for
//      nor precached.
// Checked at 874 x 402 with the iPhone 17's safe areas and at 932 x 430.
//
// Self-hosted: spawns its own server on a free port. Exit 3 = SKIP when Chrome
// is absent.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  mode_cards tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// The stamp index.html loads bay.js with: the one every card must carry.
const STAMP = (readFileSync(join(ROOT, 'public/index.html'), 'utf8').match(/bay\.js\?v=(\d+)/) || [])[1];
const MODES = ['duel', 'ffa', 'boss', 'aliens', 'golf'];
const SCREENS = { home: 'board', modes: 'tall', setup: 'wide' };
const OLD = ['alpine-hero', 'desert-hero', 'volcanic-hero', 'ruins-mid', 'ice-mid'];

// Every CDP call has a deadline, and so does the whole run; every way out
// takes Chrome and the server with it.
const CDP_MS = 15000;
const RUN_MS = 240000;
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
let srv = null, chrome = null, prof = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
setTimeout(() => { console.error(`FAIL mode_cards overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS).unref();

// ---- server ----------------------------------------------------------------
const appPort = await freePort();
srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { console.error('FAIL mode_cards: server never came up'); process.exit(1); }
const ORIGIN = `http://127.0.0.1:${appPort}`;

// ---- browser ---------------------------------------------------------------
const dbg = await freePort(); prof = join(tmpdir(), `cc-modecards-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
if (!wsUrl) { console.error('FAIL mode_cards: Chrome never offered a page to drive'); process.exit(1); }
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl);
await Promise.race([new Promise((r) => (ws.onopen = r)), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
const requested = [];
const pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent') { requested.push(m.params.request.url); return; }
  if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails || {}; pageErrors.push((d.exception && d.exception.description) || d.text || 'exception'); return; }
  const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  const t = setTimeout(() => { pend.delete(i); rej(new Error(`CDP ${method} gave no answer in ${CDP_MS} ms`)); }, CDP_MS);
  pend.set(i, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };
const until = async (expr, ms, step = 120) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(step); } return ev(expr).catch(() => false); };
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
// No intro: it covers the bay for six seconds and test/intro.mjs owns it.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__ccNoIntro = true;` });

// The iPhone 17 in landscape: Chrome has no safe areas, so a stylesheet sets
// the insets the app derives everything from (test/home_fit.mjs does the same).
const IPHONE17 = ':root{--sa-l:62px;--sa-r:62px;--sa-b:21px;--sa-t:0px}';
async function load(w, h, sa) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await ev('window.__oldDoc = true').catch(() => {});
  await send('Page.navigate', { url: ORIGIN + '/' });
  if (!(await until(`!window.__oldDoc && !!window.Bay && !!document.querySelector('#bay .launch')`, 20000))) throw new Error('the bay never came up');
  if (sa) await ev(`(() => { const s = document.createElement('style'); s.id = 'sa'; s.textContent = ${JSON.stringify(sa)}; document.head.appendChild(s); return true; })()`);
  await ev(`(window.showToast = () => {}, true)`);
}
// Show a screen with a mode armed, and wait until every card picture on it
// has loaded (or failed) and the entrance has settled.
async function show(screen, mode) {
  await ev(`(() => { ccMode = ${JSON.stringify(mode)}; Bay.show(${JSON.stringify(screen)}); return true; })()`);
  await until(`[...document.querySelectorAll('#bay .bcard img, #bay .mbi img, #bay .brief .bi img')].every((i) => i.complete)`, 8000);
  await sleep(700);
}
// What a screen shows for its mode cards: each picture's mode, its URL, whether
// it loaded, its natural size and its box.
const CARDS = `(() => [...document.querySelectorAll('#bay .board, #bay .mb, #bay .brief')].map((el) => {
  const img = el.querySelector('.bcard img, .mbi img, .bi img');
  const box = img && img.parentElement;
  const mode = (el.getAttribute('data-set') || ('mode=' + ccMode)).replace('mode=', '');
  return { mode, on: el.classList.contains('on'), src: img && img.getAttribute('src'), done: !!img && img.complete,
    nw: img ? img.naturalWidth : 0, nh: img ? img.naturalHeight : 0, bw: box ? box.offsetWidth : 0, bh: box ? box.offsetHeight : 0 };
}))()`;

// ---- 3's measure: how bright the top of a card is shown, against the picture
// itself. The card's box is screenshotted where it stands; the same band of
// the source picture is drawn alone. Both are mean luminance over the middle
// half of the width, from `top` to `bottom` of the height: clear of the icon,
// the players tag and the offline badge in the corners, and of the name.
async function brightness(sel, index, top, bottom) {
  const box = await ev(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}];
    const r = el.getBoundingClientRect(); const img = el.querySelector('img');
    return { x: r.left, y: r.top, w: r.width, h: r.height, src: img.currentSrc }; })()`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } });
  return ev(`(async () => {
    const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = s; });
    const mean = (img) => { const c = document.createElement('canvas'); c.width = 200; c.height = 200; const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 200, 200); const d = g.getImageData(50, Math.round(200 * ${top}), 100, Math.round(200 * (${bottom} - ${top}))).data; let s = 0;
      for (let k = 0; k < d.length; k += 4) s += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
      return s / (d.length / 4); };
    const shown = mean(await load('data:image/png;base64,${data}')), own = mean(await load(${JSON.stringify(box.src)}));
    return { shown, own, ratio: shown / own };
  })()`);
}
const glint = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el, '::after').animationName : 'missing'; })()`;

try {
  for (const [w, h, sa, label] of [[874, 402, IPHONE17, '874x402 iPhone 17'], [932, 430, null, '932x430']]) {
    await load(w, h, sa);
    for (const [screen, shape] of Object.entries(SCREENS)) {
      // The home boards and the Mission board show all five modes at once;
      // Match setup shows one, so it is visited once for each.
      const visits = screen === 'setup' ? MODES : ['boss'];
      let cards = [];
      for (const mode of visits) { await show(screen, mode); cards = cards.concat(await ev(CARDS)); }
      const seen = cards.map((c) => c.mode).sort().join(',');
      if (seen !== [...MODES].sort().join(',')) { fail(`${label} ${screen}: card modes ${seen}`); continue; }
      // 1. its own still, loaded
      const wrong = cards.filter((c) => c.src !== `bay/card-${c.mode}-${shape}.webp?v=${STAMP}`);
      const broken = cards.filter((c) => !c.done || !c.nw);
      if (!wrong.length) ok(`1 ${label} ${screen}: every mode's card is its own '${shape}' still under ?v=${STAMP} (${cards.map((c) => c.mode).join(', ')})`);
      else fail(`1 ${label} ${screen}: cards that are not their mode's ${shape} still: ` + JSON.stringify(wrong.map((c) => [c.mode, c.src])));
      if (!broken.length) ok(`1 ${label} ${screen}: all ${cards.length} card pictures loaded (${cards[0].nw}x${cards[0].nh})`);
      else fail(`1 ${label} ${screen}: pictures that did not load: ` + JSON.stringify(broken.map((c) => [c.mode, c.src])));
      // 2. the box's shape, so cover crops nothing that matters
      const off = cards.filter((c) => c.nw && Math.abs((c.nw / c.nh) / (c.bw / c.bh) - 1) > 0.03);
      if (!off.length) ok(`2 ${label} ${screen}: each picture has its box's shape to 3% (${(cards[0].nw / cards[0].nh).toFixed(3)} in ${(cards[0].bw / cards[0].bh).toFixed(3)})`);
      else fail(`2 ${label} ${screen}: pictures of another shape than their box: ` + JSON.stringify(off.map((c) => [c.mode, c.nw, c.nh, c.bw, c.bh])));
    }

    // 3. the scene reads. The old scenery sat at 0.56-0.75 opacity under a
    // shade across the whole card. Measured with that shading over these
    // stills, the top of a card showed 0.33 of its picture on the home boards
    // (0.54 armed), 0.55 on the Mission board (0.91 armed) and 0.67-0.73 in
    // Match setup; with the new it shows 0.67-0.74 (0.86), 0.78 (1.03) and
    // 0.95-0.98. Each screen's floor sits between the two.
    await show('home', 'boss');
    const boards = [0, 1, 2, 3, 4];
    const homeR = [];
    for (const i of boards) homeR.push(await brightness('#bay .board .bcard', i, 0.28, 0.42));
    await show('modes', 'boss');
    const modesR = [];
    for (const i of boards) modesR.push(await brightness('#bay .mb .mbi', i, 0.14, 0.45));
    const setupR = [];
    for (const m of MODES) { await show('setup', m); setupR.push(await brightness('#bay .brief .bi', 0, 0.14, 0.45)); }
    const FLOOR = { home: [0.6, 0.8], modes: [0.7, 0.95], setup: [0.85, 0.85] };   // [every card, the armed card]
    for (const [name, rs, armed] of [['home', homeR, MODES.indexOf('boss')], ['modes', modesR, MODES.indexOf('boss')], ['setup', setupR, -1]]) {
      const [floor, armedFloor] = FLOOR[name];
      const worst = Math.min(...rs.map((r) => r.ratio));
      const fmt = rs.map((r) => r.ratio.toFixed(2)).join(' ');
      if (worst >= floor) ok(`3 ${label} ${name}: the top of every card shows its scene at ${fmt} of the picture's own brightness (at least ${floor})`);
      else fail(`3 ${label} ${name}: a card's scene is dimmed to ${worst.toFixed(2)} of its own brightness, under ${floor} (${fmt})`);
      if (armed >= 0) {
        if (rs[armed].ratio >= armedFloor) ok(`3 ${label} ${name}: the armed card shows ${rs[armed].ratio.toFixed(2)} of its picture (at least ${armedFloor})`);
        else fail(`3 ${label} ${name}: the armed card shows only ${rs[armed].ratio.toFixed(2)} of its picture, under ${armedFloor}`);
      }
    }

    // 4. the glint: the armed card only, never a greyed one, and still for
    // reduced motion from either switch.
    await show('home', 'boss');
    const g = await ev(`({ on: ${glint('#bay .board.on .bcard')}, off: ${glint('#bay .board:not(.on) .bcard')} })`);
    if (g.on === 'cardGlint' && g.off === 'none') ok(`4 ${label} home: the armed board glints (${g.on}) and the others keep still`);
    else fail(`4 ${label} home glint: ` + JSON.stringify(g));
    const nofit = await ev(`(() => { const b = document.querySelector('#bay .board.on'); b.classList.add('nofit');
      const a = getComputedStyle(b.querySelector('.bcard'), '::after').animationName; b.classList.remove('nofit'); return a; })()`);
    if (nofit === 'none') ok(`4 ${label} home: an armed board the squad cannot play is greyed and keeps still`);
    else fail(`4 ${label} home: a greyed armed board still glints (${nofit})`);
    await show('modes', 'boss');
    const gm = await ev(`({ on: ${glint('#bay .mb.on .mbi')}, off: ${glint('#bay .mb:not(.on) .mbi')} })`);
    if (gm.on === 'cardGlint' && gm.off === 'none') ok(`4 ${label} Mission board: the armed card glints and the others keep still`);
    else fail(`4 ${label} Mission board glint: ` + JSON.stringify(gm));
    await show('setup', 'golf');
    const gs = await ev(glint('#bay .brief .bi'));
    if (gs === 'cardGlint') ok(`4 ${label} Match setup: the brief's picture glints`); else fail(`4 ${label} Match setup glint: ${gs}`);
    for (const [how, on, off] of [
      ['the OS asks for reduced motion', () => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }),
        () => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })],
      ["the game's Reduce motion switch is on", () => ev(`(document.body.classList.add('reduce-motion'), true)`), () => ev(`(document.body.classList.remove('reduce-motion'), true)`)],
    ]) {
      await on();
      const r = { setup: await ev(glint('#bay .brief .bi')) };
      await show('home', 'boss'); r.home = await ev(glint('#bay .board.on .bcard'));
      await show('modes', 'boss'); r.modes = await ev(glint('#bay .mb.on .mbi'));
      await off();
      await show('setup', 'golf');
      if (r.setup === 'none' && r.home === 'none' && r.modes === 'none') ok(`4 ${label}: when ${how}, no card glints on any of the three screens`);
      else fail(`4 ${label}: ${how}, yet a card glints: ` + JSON.stringify(r));
    }
  }

  // 2b. twice the size it is shown at, on the biggest screen the bay is drawn
  // on: an iPad Pro 13" in landscape, the armed board lifted x1.04 and the
  // Mission board's picture x1.05 under the finger.
  await load(1376, 1032, null);
  const big = {};
  await show('home', 'boss'); big.home = (await ev(CARDS)).map((c) => ({ ...c, k: 1.04 }));
  await show('modes', 'boss'); big.modes = (await ev(CARDS)).map((c) => ({ ...c, k: 1.05 }));
  await show('setup', 'boss'); big.setup = (await ev(CARDS)).map((c) => ({ ...c, k: 1 }));
  for (const [screen, cs] of Object.entries(big)) {
    const small = cs.filter((c) => c.nw < 2 * c.bw * c.k - 1 || c.nh < 2 * c.bh * c.k - 1);
    if (!small.length) ok(`2 1376x1032 iPad Pro 13" ${screen}: each picture (${cs[0].nw}x${cs[0].nh}) is at least twice its shown size (${(cs[0].bw * cs[0].k).toFixed(0)}x${(cs[0].bh * cs[0].k).toFixed(0)})`);
    else fail(`2 iPad ${screen}: pictures under twice their shown size: ` + JSON.stringify(small.map((c) => [c.mode, c.nw, c.nh, c.bw, c.bh])));
  }

  // 5. offline. From a clean slate -- no worker, no caches -- the page shows
  // only home, so it has asked for the board stills and nothing else. Once
  // the worker controls it, every card must already be in its cache under the
  // URL bay.js asks for: the Mission board's and Match setup's stills can only
  // be there because the worker precached them at install (it also caches
  // what a page fetches through it, which would hide a card missing from
  // SHELL on any screen already visited).
  await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'service_workers,cache_storage' });
  await load(874, 402, IPHONE17);
  const controlled = await until(`!!(navigator.serviceWorker && navigator.serviceWorker.controller)`, 15000, 200)
    || (await ev(`(location.reload(), true)`).catch(() => true), await until(`!!(navigator.serviceWorker && navigator.serviceWorker.controller) && !!window.Bay`, 15000, 200));
  if (!controlled) throw new Error('the service worker never took control of the page');
  const shown = await ev(`[...document.querySelectorAll('#bay .mbi img, #bay .brief .bi img')].length`);
  if (shown) fail(`5 the clean page showed ${shown} Mission board or Match setup pictures before the cache was read`);
  const urls = [];
  for (const [screen, shape] of Object.entries(SCREENS)) for (const m of MODES) urls.push(`bay/card-${m}-${shape}.webp?v=${STAMP}`);
  const MISSING = `(async () => { const k = (await caches.keys()).find((n) => n.startsWith('cc-v')); if (!k) return ${JSON.stringify(urls)};
    const c = await caches.open(k); const out = [];
    for (const u of ${JSON.stringify(urls)}) if (!(await c.match(new URL(u, location.href).href))) out.push(u); return out; })()`;
  await until(`${MISSING}.then((m) => m.length === 0)`, 20000, 300);
  const missing = await ev(MISSING);
  if (!missing.length) ok(`5 the service worker precaches all ${urls.length} card stills at install, under the exact URLs bay.js asks for (10 of them on screens this page never showed)`);
  else fail('5 card stills the service worker did not precache under the URL the page asks for: ' + JSON.stringify(missing));
  // The worker holds none of the old card pictures either.
  const held = await ev(`(async () => { const c = await caches.open((await caches.keys()).find((k) => k.startsWith('cc-v')));
    return (await c.keys()).map((r) => r.url); })()`);
  const oldHeld = held.filter((u) => OLD.some((n) => u.includes(`/bay/${n}.jpg`)));
  if (!oldHeld.length) ok(`5 the service worker precaches none of the old card pictures (${held.length} entries held)`);
  else fail('5 the service worker still precaches old card pictures: ' + JSON.stringify(oldHeld));
  // Offline for real: the server is gone, so every fetch fails and only the
  // worker's cache can answer (emulating "offline" on the page would leave the
  // worker's own fetches on the network).
  srv.kill('SIGKILL'); srv = null;
  await sleep(300);
  await ev('window.__oldDoc = true').catch(() => {});
  await send('Page.reload', { ignoreCache: false });
  const back = await until(`!window.__oldDoc && !!window.Bay && !!document.querySelector('#bay .launch')`, 20000);
  if (!back) fail('5 offline: the bay did not come back up from the service worker');
  else {
    await ev(`(window.showToast = () => {}, true)`);
    const off = [];
    for (const screen of Object.keys(SCREENS)) {
      for (const mode of screen === 'setup' ? MODES : ['boss']) { await show(screen, mode); for (const c of await ev(CARDS)) if (!c.done || !c.nw) off.push([screen, c.mode, c.src]); }
    }
    if (!off.length) ok('5 offline: with the server gone, a reload still shows every card on all three screens, from the precache');
    else fail('5 offline: cards that did not load from the precache: ' + JSON.stringify(off));
  }

  const old = requested.filter((u) => OLD.some((n) => u.includes(`/bay/${n}.jpg`)));
  if (!old.length) ok(`5 the page never asked for the old card pictures (${OLD.join(', ')})`);
  else fail('5 the page asked for old card pictures: ' + JSON.stringify([...new Set(old)]));
  if (pageErrors.length) fail('page errors: ' + JSON.stringify(pageErrors.slice(0, 5)));
} catch (e) {
  fail('mode_cards stopped: ' + (e && e.stack || e));
}

if (errors.length) { console.error(`\n${errors.length} mode_cards check(s) failed`); process.exit(1); }
console.log('\nmode_cards: all checks passed');
process.exit(0);
