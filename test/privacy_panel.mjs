// THE PRIVACY POLICY OPENS INSIDE THE GAME (owner, 2026-10-07: the Privacy
// policy row in Bay controls "does not work"; his answer: inside the app, a
// readable panel with Close, working offline). The row used to click a
// target=_blank link, which the iOS app's WKWebView hands to the system, where
// nothing opens it. Now bay.js reads the bundled page and draws it in a
// full-screen panel (docOpen). This suite holds that, in a real page against a
// real server:
//   1. nothing in the game's own page opens a new window, and the row opens the
//      panel: the whole policy, word for word, over the whole screen, the page
//      under it inert, the keyboard in it, nothing navigated;
//   2. readable at 667x375, 812x375, 874x402 with the iPhone 17's safe areas
//      and 932x430: the type's sizes and contrast, every line inside the safe
//      box, Close at least 44px tall, a page that scrolls under a finger and
//      reaches its last line above the home indicator, nothing wider than the
//      screen; and in portrait it turns with the game;
//   3. Close, Escape and Back each close it, back to Bay controls with the
//      keyboard on the row, the history as it was, no reload; a reopen racing
//      Close's own step back keeps the panel and its Back; a lobby or a match
//      taking the screen closes it;
//   4. its links: the in-page ones scroll the panel, the deletion page opens in
//      the panel and links back, "Open the game" closes it, and https and
//      mailto open a new window -- never the game's own page;
//   5. a read that fails says so with Try again, a slow read never lands on a
//      later page, and a page read once opens again with no network;
//   6. offline for real: from a clean slate the service worker precaches the
//      page, and with the server gone a reloaded game opens the policy.
// NOTHING REACHES THE INTERNET: this Chrome resolves no host but this machine,
// so the links that do open a window open it onto an error page.
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
if (!existsSync(CHROME)) { console.log(`SKIP  privacy_panel tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const check = (m, cond, detail) => (cond ? ok(m) : fail(m + (detail ? ' -- ' + detail : '')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const rgbOf = (s) => (String(s).match(/\d+/g) || []).slice(0, 3).map(Number);
const f1 = (n) => Math.round(n * 10) / 10;

// The two pages as they are on disk: the oracle the panel is held to.
const PRIVACY = readFileSync(join(ROOT, 'public/privacy.html'), 'utf8');
const DELETE = readFileSync(join(ROOT, 'public/delete-account.html'), 'utf8');

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
setTimeout(() => { console.error(`FAIL privacy_panel overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS).unref();

// ---- server ----------------------------------------------------------------
const appPort = await freePort();
srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { console.error('FAIL privacy_panel: server never came up'); process.exit(1); }
const ORIGIN = `http://127.0.0.1:${appPort}`;

// ---- browser ---------------------------------------------------------------
const dbg = await freePort(); prof = join(tmpdir(), `cc-privacy-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null, pageId = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; pageId = p.id; break; } } catch {} await sleep(200); }
if (!wsUrl) { console.error('FAIL privacy_panel: Chrome never offered a page to drive'); process.exit(1); }
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl);
await Promise.race([new Promise((r) => (ws.onopen = r)), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
// What the page did that the player would see as leaving: a navigation of the
// main frame, and every window it asked to open.
let mainFrame = null;
const navs = [], windows = [], pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Page.frameNavigated') { if (!m.params.frame.parentId) navs.push(m.params.frame.url); return; }
  if (m.method === 'Page.windowOpen') { windows.push(m.params.url); return; }
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
const until = async (expr, ms, step = 60) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(step); } return ev(expr).catch(() => false); };
await send('Page.enable'); await send('Runtime.enable');
mainFrame = (await send('Page.getFrameTree')).frameTree.frame.id;
// No intro: it covers the bay for six seconds and test/intro.mjs owns it.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__ccNoIntro = true;` });

const IPHONE17 = ':root{--sa-l:62px;--sa-r:62px;--sa-b:21px;--sa-t:0px}';
let docN = 0;
// A fresh page on Bay controls. Each load is stamped, so a later read can tell
// the same document from a reload.
async function load(w, h, sa) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await ev('window.__oldDoc = true').catch(() => {});
  await send('Page.navigate', { url: ORIGIN + '/' });
  if (!(await until(`!window.__oldDoc && !!window.Bay && !!document.querySelector('#bay .launch')`, 20000))) throw new Error('the bay never came up');
  if (sa) await ev(`(() => { const s = document.createElement('style'); s.id = 'sa'; s.textContent = ${JSON.stringify(sa)}; document.head.appendChild(s); return true; })()`);
  await ev(`(window.__toast = window.showToast, window.showToast = () => {}, Bay.show('settings'), window.__doc = ${++docN}, true)`);
  await settled();
  return docN;
}
// Bay controls slides in for about half a second as it is entered, and a tap
// aimed while it moves can land beside the row: wait until it has stopped.
const settled = () => until(`!document.getElementById('bay').classList.contains('enter')`, 3000);
// A real tap where the player would put a finger: the middle of the element's
// first line box, which must be the element itself (nothing covering it).
async function tap(sel, idx = 0) {
  const c = await ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; if (!e) return null;
    const r = e.getClientRects()[0] || e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const at = document.elementFromPoint(x, y); return { x, y, hit: !!at && (at === e || e.contains(at)) }; })()`);
  if (!c) throw new Error('nothing to tap at ' + sel + '[' + idx + ']');
  if (!c.hit) throw new Error('something covers ' + sel + '[' + idx + ']');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
}
const key = async (k, code) => {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
};
const ROW = '#bay [data-doc="privacy.html"]';
const isOpen = `(() => { const p = document.getElementById('docp'); return !!p && !p.hidden; })()`;
// Bring a link inside the panel into view by the panel's own scroll, and tap it.
async function tapLink(sel, idx = 0) {
  await ev(`(() => { const s = document.getElementById('docpS'), a = document.querySelectorAll(${JSON.stringify(sel)})[${idx}];
    s.scrollTop += a.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientHeight / 3; return true; })()`);
  await sleep(40);
  await tap(sel, idx);
}
const hist = async () => { const h = await send('Page.getNavigationHistory'); return { i: h.currentIndex, n: h.entries.length, entries: h.entries }; };
// The page's own text, from the file on disk, the way a browser reads it.
const fileText = (html) => `(() => { const m = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html').querySelector('main');
  return m.textContent.replace(/\\s+/g, ' ').trim(); })()`;
const fileH1 = (html) => `new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html').querySelector('h1').textContent.replace(/\\s+/g, ' ').trim()`;
const SHOWN = `(() => { const c = document.getElementById('docpC'), t = document.getElementById('docpT');
  return { title: t ? t.textContent : null, text: c ? c.textContent.replace(/\\s+/g, ' ').trim() : '',
    h1: c && c.querySelector('h1') ? c.querySelector('h1').textContent.replace(/\\s+/g, ' ').trim() : null }; })()`;
// The same document, not navigated, not reloaded, nothing opened.
async function stayed(label, doc, url, before) {
  const s = await ev(`({ doc: window.__doc, url: location.href })`).catch(() => ({ doc: null, url: null }));
  check(`${label}: the game's page stayed where it was (same document, same address, no new window)`,
    s.doc === doc && s.url === url && navs.length === before.navs && windows.length === before.windows,
    JSON.stringify({ s, navs: navs.slice(before.navs), windows: windows.slice(before.windows) }));
}
const mark = () => ({ navs: navs.length, windows: windows.length });

try {
  // ---- 1. the row opens the panel ------------------------------------------
  {
    const d = await load(874, 402, IPHONE17);
    const url = await ev('location.href');
    const blanks = await ev(`(() => { const out = []; for (const scr of ['home', 'settings']) { Bay.show(scr);
      out.push(...[...document.querySelectorAll('a[target]')].map((a) => scr + ': ' + a.outerHTML.slice(0, 80))); }
      Bay.show('settings'); return { out, legacy: !!document.getElementById('privacyLink') }; })()`);
    await settled();
    check('1 no link in the game\'s own page asks for a new window (home, Bay controls and the hidden control rack), and the old privacy link is gone',
      blanks.out.length === 0 && !blanks.legacy, JSON.stringify(blanks));
    const row = await ev(`(() => { const b = document.querySelector(${JSON.stringify(ROW)}); const r = b && b.closest('.row');
      return b ? { btn: b.textContent.trim(), name: r.querySelector('.rn2').textContent, desc: r.querySelector('.rd').textContent } : null; })()`);
    check('1 Bay controls has a Privacy policy row whose button reads Open', !!row && row.name === 'Privacy policy' && row.btn === 'Open', JSON.stringify(row));
    const h0 = await hist();
    const before = mark();
    await tap(ROW);
    const opened = await until(`${isOpen} && !!document.querySelector('#docpC h1')`, 4000);
    check('1 tapping the row opens the panel with the policy in it', opened);
    const shown = await ev(SHOWN), want = await ev(fileText(PRIVACY));
    check(`1 the panel shows the whole policy, word for word (${shown.text.length} characters), under the title "Privacy policy"`,
      shown.title === 'Privacy policy' && shown.text === want && want.length > 5000, JSON.stringify({ title: shown.title, len: shown.text.length, want: want.length }));
    const g = await ev(`(() => { const p = document.getElementById('docp').getBoundingClientRect(), a = document.activeElement;
      return { box: [p.left, p.top, p.width, p.height], w: innerWidth, h: innerHeight, inert: document.getElementById('bay').inert,
        focus: !!a && document.getElementById('docp').contains(a), role: document.getElementById('docp').getAttribute('role'),
        modal: document.getElementById('docp').getAttribute('aria-modal'),
        safe: (() => { const c = document.getElementById('docpC'); return { scripts: c.querySelectorAll('script,style,link,meta,iframe,form').length,
          styled: c.querySelectorAll('[style]').length, on: [...c.querySelectorAll('*')].filter((n) => [...n.attributes].some((x) => /^on/i.test(x.name))).length,
          ids: [...c.querySelectorAll('[id]')].map((n) => n.id) }; })() }; })()`);
    check('1 the panel covers the whole screen, as a modal dialog, with the page under it inert and the keyboard inside it',
      g.box[0] === 0 && g.box[1] === 0 && g.box[2] === g.w && g.box[3] === g.h && g.inert === true && g.focus && g.role === 'dialog' && g.modal === 'true', JSON.stringify(g));
    check(`1 only the page's words came across: no script, style, link or form, no inline style or handler, and its ids are its own (${g.safe.ids.join(', ')})`,
      g.safe.scripts === 0 && g.safe.styled === 0 && g.safe.on === 0 && g.safe.ids.length >= 2 && g.safe.ids.every((x) => /^doc-/.test(x)), JSON.stringify(g.safe));
    // A toast still shows over the panel: both hang off #app, the toast higher.
    // (#toast takes no taps, so it takes them for this one probe.)
    await ev(`(__toast('Over the page'), true)`);
    await sleep(350);
    const tz = await ev(`(() => { const t = document.getElementById('toast'), i = t.querySelector('.toast-item'); if (!i) return { item: false };
      t.style.pointerEvents = 'auto'; const r = i.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      t.style.pointerEvents = ''; return { item: true, over: !!at && t.contains(at) }; })()`);
    check('1 a toast still shows over the panel', tz.item && tz.over, JSON.stringify(tz));
    const h1 = await hist();
    check('1 the open panel holds one history entry of its own', h1.i === h0.i + 1 && h1.n === h0.i + 2, JSON.stringify({ h0: [h0.i, h0.n], h1: [h1.i, h1.n] }));
    await stayed('1 opening it', d, url, before);
  }

  // ---- 2. readable at every phone size, and in portrait ----------------------
  const PANEL = `(() => {
    const len = (css) => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:0;height:1px;width:' + css; document.body.appendChild(d); const w = d.getBoundingClientRect().width; d.remove(); return w; };
    const u = len('calc(var(--u) * 1000)') / 1000;
    const sa = { l: len('var(--sa-l)'), r: len('var(--sa-r)'), t: len('var(--sa-t)'), b: len('var(--sa-b)') };
    const p = document.getElementById('docp'), s = document.getElementById('docpS'), c = document.getElementById('docpC');
    const W = innerWidth, H = innerHeight, fs = (e) => Math.round(parseFloat(getComputedStyle(e).fontSize) / u * 10) / 10;
    const blocks = [...c.querySelectorAll('h1,h2,p,li,th,td')].filter((e) => e.textContent.trim());
    const out = blocks.filter((e) => { const r = e.getBoundingClientRect(); return r.left < sa.l - 0.5 || r.right > W - sa.r + 0.5; }).map((e) => e.textContent.trim().slice(0, 30));
    const all = [...c.querySelectorAll('*')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
    const minAll = Math.min(...all.map(fs));
    const body = [...c.querySelectorAll('p:not(.muted),li')].map(fs), small = [...c.querySelectorAll('.muted,th,td')].map(fs);
    const x = p.querySelector('.dpx').getBoundingClientRect(), t = document.getElementById('docpT');
    const tr = t.getBoundingClientRect();
    const colours = [...new Set([...c.querySelectorAll('p,li,td,th,a,.muted,h1,h2')].map((e) => getComputedStyle(e).color))];
    const bg = getComputedStyle(p).backgroundColor;
    const sw = { s: s.scrollWidth - s.clientWidth, c: c.scrollWidth - c.clientWidth };
    s.scrollTop = s.scrollHeight;
    const last = blocks[blocks.length - 1].getBoundingClientRect(), sr = s.getBoundingClientRect();
    const end = { bottom: last.bottom, top: last.top, limit: H - sa.b, sTop: sr.top };
    s.scrollTop = 0;
    return { u, sa, W, H, out, minAll, body: [Math.min(...body), Math.max(...body)], small: [Math.min(...small), Math.max(...small)],
      title: fs(t), titleBox: [tr.left, tr.right], close: { fs: fs(p.querySelector('.dpx span')), l: x.left, r: x.right, t: x.top, b: x.bottom, h: x.height },
      colours, bg, sw, scroll: { sh: s.scrollHeight, ch: s.clientHeight, oy: getComputedStyle(s).overflowY }, end,
      page: { doc: document.scrollingElement.scrollTop, x: scrollX, y: scrollY, bay: document.getElementById('bay').scrollTop } };
  })()`;
  for (const [w, h, sa, V] of [[667, 375, null, '667x375'], [812, 375, null, '812x375'], [874, 402, IPHONE17, '874x402 iPhone 17'], [932, 430, null, '932x430']]) {
    await load(w, h, sa);
    await tap(ROW);
    if (!(await until(`${isOpen} && !!document.querySelector('#docpC h1')`, 4000))) { fail(`2 [${V}] the panel did not open`); continue; }
    const m = await ev(PANEL);
    check(`2 [${V}] every line of the page sits inside the safe box (insets ${f1(m.sa.l)}/${f1(m.sa.r)}/${f1(m.sa.b)}px)`, m.out.length === 0, m.out.slice(0, 4).join('; '));
    check(`2 [${V}] the page's words are ${m.body[0]}-${m.body[1]}u, its tables and quieter lines ${m.small[0]}-${m.small[1]}u, nothing under ${m.minAll}u; the title is ${m.title}u and Close ${m.close.fs}u`,
      m.body[0] >= 17 && m.small[0] >= 16 && m.minAll >= 12 && m.title >= 13 && m.close.fs >= 13, JSON.stringify({ body: m.body, small: m.small, minAll: m.minAll }));
    const worst = Math.min(...m.colours.map((c) => contrast(rgbOf(c), rgbOf(m.bg))));
    check(`2 [${V}] every colour of text is at least 7:1 on the panel (${f1(worst)}:1)`, worst >= 7, JSON.stringify({ colours: m.colours, bg: m.bg }));
    check(`2 [${V}] Close is ${f1(m.close.h)}px tall and stands inside the safe box, and so does the title`,
      m.close.h >= 44 - 0.5 && m.close.l >= m.sa.l - 0.5 && m.close.r <= m.W - m.sa.r + 0.5 && m.close.t >= m.sa.t - 0.5 && m.titleBox[0] >= m.sa.l - 0.5,
      JSON.stringify(m.close));
    check(`2 [${V}] the page scrolls up and down (${m.scroll.sh}px in ${m.scroll.ch}px), never across, and its last line comes up clear of the home indicator`,
      m.scroll.oy === 'auto' && m.scroll.sh > m.scroll.ch + 200 && m.sw.s <= 0 && m.sw.c <= 0 && m.end.bottom <= m.end.limit - 24 * m.u + 0.5 && m.end.top >= m.end.sTop - 0.5,
      JSON.stringify({ scroll: m.scroll, sw: m.sw, end: m.end }));
    // A finger's drag up the page scrolls it, and nothing under it moves.
    const c = await ev(`(() => { const s = document.getElementById('docpS'); s.scrollTop = 0; const b = s.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height * 0.75), d: Math.round(b.height * 0.5) }; })()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
    for (let i = 1; i <= 8; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x, y: c.y - Math.round(c.d * i / 8) }] }); await sleep(16); }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
    const sc = await ev(`(() => { const s = document.getElementById('docpS'), st = s.scrollTop; s.scrollTop = 0; return { st, doc: document.scrollingElement.scrollTop, x: scrollX, y: scrollY, bay: document.getElementById('bay').scrollTop }; })()`);
    check(`2 [${V}] a finger dragged up the page scrolls it (${f1(sc.st)}px) and nothing under it moves`, sc.st >= 20 && !sc.doc && !sc.x && !sc.y && !sc.bay, JSON.stringify(sc));
  }
  {
    // Insets no phone has today, to show the panel follows them rather than
    // happening to clear them: a top inset (the bay keeps one) and a lopsided
    // 200px left one, where a column merely centred on the screen would start
    // under the inset. The title and Close sit below the top inset, the page
    // starts under them, and every line keeps inside the safe box.
    await load(874, 402, ':root{--sa-l:200px;--sa-r:0px;--sa-b:21px;--sa-t:24px}');
    await tap(ROW);
    await until(`${isOpen} && !!document.querySelector('#docpC h1')`, 4000);
    const t = await ev(`(() => { const x = document.querySelector('#docp .dpx').getBoundingClientRect(), t = document.getElementById('docpT').getBoundingClientRect(),
      s = document.getElementById('docpS').getBoundingClientRect(), c = document.getElementById('docpC');
      const left = Math.min(...[...c.querySelectorAll('h1,h2,p,li,th,td')].map((e) => e.getBoundingClientRect().left));
      return { x: x.top, t: t.top, xb: x.bottom, s: s.top, tl: t.left, left }; })()`);
    check(`2 [874x402, a 24px top inset and a lopsided 200px left one] the title and Close sit below the top inset, the page starts under them, and its words start right of the left one (${f1(t.left)}px)`,
      t.x >= 24 && t.t >= 24 && t.s >= t.xb && t.tl >= 200 && t.left >= 200, JSON.stringify(t));
  }
  {
    // The landscape lock turns the whole game a quarter in portrait; the panel
    // turns with it and still covers the screen.
    await load(390, 844, null);
    await tap(ROW);
    await until(`${isOpen} && !!document.querySelector('#docpC h1')`, 4000);
    const p = await ev(`(() => { const r = document.getElementById('docp').getBoundingClientRect(), h = document.querySelector('#docp .dph').getBoundingClientRect();
      return { box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], head: [Math.round(h.width), Math.round(h.height)], w: innerWidth, h: innerHeight,
        turned: getComputedStyle(document.body).transform !== 'none' }; })()`);
    check(`2 [390x844 portrait] the panel turns with the game and still covers the screen (its title bar runs ${p.head[1]}px down the long side)`,
      p.turned && p.box[0] === 0 && p.box[1] === 0 && p.box[2] === p.w && p.box[3] === p.h && p.head[1] >= p.h - 1 && p.head[0] < 120, JSON.stringify(p));
  }

  // ---- 3. Close, Escape, Back, a racing reopen, and the screen changing -----
  {
    const d = await load(874, 402, IPHONE17);
    const url = await ev('location.href');
    const h0 = await hist();
    const before = mark();
    const after = async (how) => {
      await sleep(300);
      const s = await ev(`(() => { const a = document.activeElement; return { open: ${isOpen}, scr: document.getElementById('bay').dataset.scr,
        inert: document.getElementById('bay').inert, focus: !!a && a.matches(${JSON.stringify(ROW)}), empty: !document.getElementById('docpC').firstChild }; })()`);
      const h = await hist();
      check(`3 ${how} closes it: back on Bay controls, the page awake again, the keyboard on the row, the panel emptied and the history where it was`,
        !s.open && s.scr === 'settings' && s.inert === false && s.focus && s.empty && h.i === h0.i, JSON.stringify({ s, h: [h.i, h.n], h0: [h0.i, h0.n] }));
    };
    const reopen = async () => { await tap(ROW); return until(`${isOpen} && !!document.querySelector('#docpC h1')`, 4000); };
    await reopen(); await tap('#docp [data-dp="close"]'); await after('Close');
    await reopen(); await key('Escape', 27); await after('Escape');
    await reopen();
    const back = (await hist()).entries[h0.i];
    await send('Page.navigateToHistoryEntry', { entryId: back.id });
    await after('the browser\'s Back (and the Android back button, which goes back in the same history)');
    // Forward again lands on the entry the panel left behind: nothing opens and
    // nothing reloads.
    const fwd = await hist();
    if (fwd.n > fwd.i + 1) {
      await send('Page.navigateToHistoryEntry', { entryId: fwd.entries[fwd.i + 1].id });
      await sleep(300);
      check('3 Forward after that opens nothing', !(await ev(isOpen)));
      await send('Page.navigateToHistoryEntry', { entryId: fwd.entries[fwd.i].id });
      await sleep(300);
    }
    await stayed('3 Close, Escape, Back and Forward', d, url, before);

    // A reopen in the same moment as Close: Close's own step back has not
    // landed yet. The panel stays open, takes its entry once the step back has
    // landed, and Back still closes it.
    await reopen();
    await ev(`(() => { document.querySelector('#docp [data-dp="close"]').click(); document.querySelector(${JSON.stringify(ROW)}).click(); return true; })()`);
    await sleep(500);
    const r = { open: await ev(isOpen), h: await hist() };
    check('3 reopened the instant it closed, the panel stays open and holds its history entry again', r.open && r.h.i === h0.i + 1, JSON.stringify({ open: r.open, h: [r.h.i, r.h.n] }));
    await send('Page.navigateToHistoryEntry', { entryId: r.h.entries[h0.i].id });
    await after('Back, after that race,');

    // A lobby or a match taking the screen takes the panel down with it.
    await reopen();
    await ev(`(showScreen('game'), true)`);
    await sleep(300);
    const sg = { open: await ev(isOpen), h: await hist() };
    await ev(`(showScreen('home'), Bay.show('settings'), true)`);
    check('3 a match taking the screen closes the panel and gives its history entry back', !sg.open && sg.h.i === h0.i, JSON.stringify({ open: sg.open, h: [sg.h.i, sg.h.n] }));
    await stayed('3 the race and the screen change', d, url, before);
  }

  // ---- 4. the page's own links ----------------------------------------------
  {
    const d = await load(874, 402, IPHONE17);
    const url = await ev('location.href');
    const h0 = await hist();
    const before = mark();
    await tap(ROW);
    await until(`${isOpen} && !!document.querySelector('#docpC h1')`, 4000);
    const sorted = await ev(`(() => { const out = { jump: 0, page: 0, home: 0, out: 0, loose: [] };
      for (const a of document.querySelectorAll('#docpC a[href]')) {
        if (a.dataset.dpl) out[a.dataset.dpl]++;
        else if (a.target === '_blank' && /noopener/.test(a.rel) && /^(https|mailto):/.test(a.getAttribute('href'))) out.out++;
        else out.loose.push(a.outerHTML.slice(0, 80)); }
      return out; })()`);
    check(`4 every link in the policy is sorted: ${sorted.jump} in-page, ${sorted.page} to the deletion page, ${sorted.out} https or mailto to a new window`,
      sorted.loose.length === 0 && sorted.jump === 3 && sorted.page === 2 && sorted.out >= 7, JSON.stringify(sorted));
    // In-page: "Your rights and controls".
    await tapLink('#docpC a[data-dpl="jump"][data-dpid="doc-rights"]');
    await sleep(150);
    const j = await ev(`(() => { const s = document.getElementById('docpS'), hd = document.getElementById('doc-rights');
      const y = hd.getBoundingClientRect().top - s.getBoundingClientRect().top; return { y, h: s.clientHeight, hash: location.hash, open: ${isOpen} }; })()`);
    check(`4 an in-page link scrolls the panel to its heading (${f1(j.y)}px from the top), and the address keeps no #`, j.open && j.y >= 0 && j.y <= 40 && j.hash === '', JSON.stringify(j));
    // The deletion page, in the panel.
    await tapLink('#docpC a[data-dpl="page"]');
    await until(`document.getElementById('docpT').textContent === 'Delete your account' && !!document.querySelector('#docpC h1')`, 4000);
    const dl = await ev(SHOWN), dlWant = await ev(fileText(DELETE));
    const dls = await ev(`({ top: document.getElementById('docpS').scrollTop, focus: document.activeElement === document.getElementById('docpS') })`);
    const dst = await ev(`document.querySelectorAll('#docpC [style]').length`);
    check(`4 the deletion page's own inline styles stay behind (it has ${(DELETE.match(/ style="/g) || []).length})`, dst === 0 && /<main>[\s\S]* style="/.test(DELETE), String(dst));
    check('4 the deletion page opens in the panel, whole and from its top, under its own title', dl.title === 'Delete your account' && dl.text === dlWant && dls.top === 0 && dls.focus, JSON.stringify({ title: dl.title, len: dl.text.length, want: dlWant.length, dls }));
    // Its links: the policy, mail and the support page, and the game's own door.
    const ds = await ev(`(() => [...document.querySelectorAll('#docpC a[href]')].map((a) => [a.getAttribute('href').slice(0, 40), a.dataset.dpl || (a.target === '_blank' ? 'window' : 'loose')]))()`);
    check('4 on the deletion page, "Open the game" closes the panel, the policy link opens the policy, and mail and the support page open a new window',
      JSON.stringify(ds) === JSON.stringify([['https://tanks.abarabrothers.com/', 'home'], ['mailto:support@abarabrothers.com?subject', 'window'], ['https://abarabrothers.com/support', 'window'], ['privacy.html', 'page']]), JSON.stringify(ds));
    await tapLink('#docpC a[data-dpl="page"]');
    await until(`document.getElementById('docpT').textContent === 'Privacy policy' && !!document.querySelector('#docpC h1')`, 4000);
    const back = await ev(SHOWN);
    check('4 its link back opens the policy again', back.title === 'Privacy policy' && back.h1 === (await ev(fileH1(PRIVACY))), JSON.stringify({ title: back.title, h1: back.h1 }));
    const hMid = await hist();
    check('4 moving between the two pages adds no history: Back still closes the panel', hMid.i === h0.i + 1, JSON.stringify([hMid.i, hMid.n]));
    await stayed('4 the in-page and between-page links', d, url, before);
    // Out to the world: a new window each, never the game's own page.
    const w0 = windows.length;
    await tapLink('#docpC a[href^="https://abarabrothers.com/support"]');
    await sleep(400);
    await tapLink('#docpC a[href^="mailto:"]');
    await sleep(400);
    const opened = windows.slice(w0);
    const s = await ev(`({ doc: window.__doc, url: location.href, open: ${isOpen} })`);
    check(`4 the support page and the mail link each open a new window (${opened.join(', ')}), the game stays put and the panel stays open`,
      opened.length === 2 && opened[0] === 'https://abarabrothers.com/support' && /^mailto:support@abarabrothers\.com/.test(opened[1]) && s.doc === d && s.url === url && s.open && navs.length === before.navs,
      JSON.stringify({ opened, s, navs: navs.slice(before.navs) }));
    // The deletion page's "Open the game": the player is in it already.
    await tapLink('#docpC a[data-dpl="page"]');
    await until(`document.getElementById('docpT').textContent === 'Delete your account'`, 4000);
    const w1 = windows.length;
    await tapLink('#docpC a[data-dpl="home"]');
    await sleep(300);
    const g = await ev(`({ open: ${isOpen}, scr: document.getElementById('bay').dataset.scr, doc: window.__doc })`);
    const hg = await hist();
    check('4 "Open the game" closes the panel onto Bay controls, opening nothing', !g.open && g.scr === 'settings' && g.doc === d && windows.length === w1 && hg.i === h0.i, JSON.stringify({ g, h: [hg.i, hg.n], w: windows.slice(w1) }));
    // The windows the links opened are this run's to close.
    for (const t of await (await get(`http://127.0.0.1:${dbg}/json/list`)).json()) if (t.type === 'page' && t.id !== pageId) await get(`http://127.0.0.1:${dbg}/json/close/${t.id}`).catch(() => {});
  }

  // ---- 5. a failed read, a slow read, and a page read before ----------------
  {
    const d = await load(874, 402, IPHONE17);
    const url = await ev('location.href');
    const before = mark();
    await ev(`(window.__fetch = window.fetch, window.fetch = () => Promise.reject(new TypeError('Failed to fetch')), true)`);
    await tap(ROW);
    await until(`!!document.querySelector('#docp [data-dp="retry"]')`, 4000);
    const f = await ev(`({ open: ${isOpen}, say: document.querySelector('#docpC .dpw').textContent, btn: document.querySelector('#docp [data-dp="retry"]').textContent })`);
    check('5 a read that fails says so, with Try again', f.open && f.say === 'This page could not be opened. Check your connection, then try again.' && f.btn === 'Try again', JSON.stringify(f));
    await ev(`(window.fetch = window.__fetch, true)`);
    await tap('#docp [data-dp="retry"]');
    await until(`!!document.querySelector('#docpC h1')`, 4000);
    check('5 Try again reads it once the network is back', (await ev(SHOWN)).text === (await ev(fileText(PRIVACY))));
    await tap('#docp [data-dp="close"]');
    await sleep(300);
    // Read once, it opens again with every read failing.
    await ev(`(window.fetch = () => Promise.reject(new TypeError('Failed to fetch')), true)`);
    await tap(ROW);
    await sleep(200);
    check('5 a page read once opens again with no network at all', (await ev(SHOWN)).text === (await ev(fileText(PRIVACY))));
    await ev(`(window.fetch = window.__fetch, true)`);
    await tap('#docp [data-dp="close"]');
    await sleep(300);
    await stayed('5 the failed read and the retry', d, url, before);
  }
  {
    // What comes back is held to being one of our pages: a failed status is a
    // failed read even with a page in it, a response with no <main> is not a
    // page, and a page with code in it comes across as words only.
    const d = await load(874, 402, IPHONE17);
    const url = await ev('location.href');
    const before = mark();
    const answer = (body, status) => `(window.__fetch = window.__fetch || window.fetch, window.fetch = (u, o) => (String(u).endsWith('privacy.html')
      ? Promise.resolve(new Response(${JSON.stringify(body)}, { status: ${status}, headers: { 'Content-Type': 'text/html' } })) : window.__fetch(u, o)), true)`;
    const failed = async () => { await tap(ROW); await until(`!!document.querySelector('#docp [data-dp="retry"]') || !!document.querySelector('#docpC h1')`, 4000);
      const r = await ev(`({ retry: !!document.querySelector('#docp [data-dp="retry"]'), h1: !!document.querySelector('#docpC h1') })`); await tap('#docp [data-dp="close"]'); await sleep(300); return r; };
    await ev(answer('<!doctype html><main><h1>Not found</h1><p>Nothing here.</p></main>', 404));
    const f404 = await failed();
    await ev(answer('<!doctype html><title>Cannons</title><div id="app"><p>Not one of the pages.</p></div>', 200));
    const fNoMain = await failed();
    check('5 a failed status is a failed read even with a page in it, and a response with no <main> is not a page: both say so, with Try again',
      f404.retry && !f404.h1 && fNoMain.retry && !fNoMain.h1, JSON.stringify({ f404, fNoMain }));
    await ev(answer('<!doctype html><title>x</title><style>body{display:none}</style><main><h1 id="top" onclick="window.__pwned=1" style="color:red">Crafted</h1>'
      + '<p>Words <a href="javascript:window.__pwned=2">here</a>, <a href="other.html">there</a> and <a href="data:text/html,x">elsewhere</a>.</p>'
      + '<script>window.__pwned=3</script><iframe src="about:blank"></iframe><object></object><form action="/x"><input></form>'
      + '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onload="window.__pwned=4">'
      + '<table><tr><th>Address</th><td>' + 'averyveryverylongunbrokenaddress'.repeat(8) + '@example.com</td></tr></table></main>', 200));
    await tap(ROW);
    await until(`!!document.querySelector('#docpC h1')`, 4000);
    await sleep(300);
    const cr = await ev(`(() => { const c = document.getElementById('docpC'), h = c.querySelector('h1');
      return { h1: h && h.textContent, id: h && h.id, attrs: [...c.querySelectorAll('*')].flatMap((n) => [...n.attributes].map((a) => a.name)).filter((a) => /^on|^style$/.test(a)),
        code: c.querySelectorAll('script,style,iframe,object,embed,form,link,meta,base').length, hrefs: [...c.querySelectorAll('a')].map((a) => a.getAttribute('href')),
        pwned: window.__pwned || 0, shown: getComputedStyle(document.body).display,
        wide: c.scrollWidth - c.clientWidth + Math.max(0, document.getElementById('docpS').scrollWidth - document.getElementById('docpS').clientWidth) }; })()`);
    check('5 a page with script, handlers, styles, frames and a form in it comes across as words only: nothing ran, no link but ours survives',
      cr.h1 === 'Crafted' && cr.id === 'doc-top' && cr.attrs.length === 0 && cr.code === 0 && cr.hrefs.every((h) => h === null) && cr.hrefs.length === 3 && cr.pwned === 0 && cr.shown !== 'none', JSON.stringify(cr));
    check('5 a word longer than the screen breaks inside its table cell instead of widening the page', cr.wide <= 0, String(cr.wide));
    await tap('#docp [data-dp="close"]');
    await sleep(300);
    await ev(`(window.fetch = window.__fetch, true)`);
    await stayed('5 the refused and the crafted answers', d, url, before);
  }
  {
    // A slow first read must not land on whatever the panel shows by then.
    const d = await load(874, 402, IPHONE17);
    const url = await ev('location.href');
    const before = mark();
    await ev(`(() => { const real = window.fetch; let n = 0;
      window.fetch = (u, o) => (String(u).endsWith('privacy.html') && n++ === 0 ? new Promise((r) => setTimeout(r, 900)).then(() => real(u, o)) : real(u, o)); return true; })()`);
    await tap(ROW);
    await sleep(100);
    const opening = await ev(`document.getElementById('docpC').textContent`);
    await tap('#docp [data-dp="close"]');
    await sleep(300);
    const shut = await ev(`({ open: ${isOpen}, empty: !document.getElementById('docpC').firstChild })`);
    await tap(ROW);
    await until(`!!document.querySelector('#docpC h1')`, 4000);
    await tapLink('#docpC a[data-dpl="page"]');
    await until(`document.getElementById('docpT').textContent === 'Delete your account' && !!document.querySelector('#docpC h1')`, 4000);
    await sleep(1000);                      // the slow first read has landed by now
    const s = await ev(SHOWN);
    const end = await ev(`({ open: ${isOpen} })`);
    check(`5 while it reads the panel says "${opening}"; a slow read lands neither in a closed panel nor over the page shown by then`,
      opening === 'Opening' && !shut.open && shut.empty && end.open && s.title === 'Delete your account' && s.h1 === (await ev(fileH1(DELETE))), JSON.stringify({ opening, shut, s: { title: s.title, h1: s.h1 } }));
    await tap('#docp [data-dp="close"]');
    await sleep(300);
    await stayed('5 the slow read', d, url, before);
  }

  // ---- 6. offline for real ---------------------------------------------------
  {
    // From a clean slate -- no worker, no caches -- the page never reads the
    // policy, so it is in the worker's cache only because the worker precached it.
    await send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'service_workers,cache_storage' });
    await load(874, 402, IPHONE17);
    const controlled = await until(`!!(navigator.serviceWorker && navigator.serviceWorker.controller)`, 15000, 200)
      || (await ev(`(location.reload(), true)`).catch(() => true), await until(`!!(navigator.serviceWorker && navigator.serviceWorker.controller) && !!window.Bay`, 15000, 200));
    if (!controlled) throw new Error('the service worker never took control of the page');
    const HELD = `(async () => { const k = (await caches.keys()).find((n) => n.startsWith('cc-v')); if (!k) return []; const c = await caches.open(k);
      const out = []; for (const p of ['privacy.html', 'delete-account.html']) if (await c.match(new URL(p, location.href).href)) out.push(p); return out; })()`;
    await until(`${HELD}.then((h) => h.length === 2)`, 20000, 300);
    const held = await ev(HELD);
    check('6 the service worker precaches both pages at install, under the address the panel reads', held.length === 2, JSON.stringify(held));
    // The server is gone: every read fails but the worker's.
    srv.kill('SIGKILL'); srv = null;
    await sleep(300);
    await ev('window.__oldDoc = true').catch(() => {});
    await send('Page.reload', { ignoreCache: false });
    if (!(await until(`!window.__oldDoc && !!window.Bay && !!document.querySelector('#bay .launch')`, 20000))) throw new Error('offline: the bay did not come back up from the service worker');
    await ev(`(document.getElementById('sa') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'sa', textContent: ${JSON.stringify(IPHONE17)} })), window.showToast = () => {}, Bay.show('settings'), true)`);
    await settled();
    await tap(ROW);
    await until(`!!document.querySelector('#docpC h1') || !!document.querySelector('#docp [data-dp="retry"]')`, 6000);
    check('6 with the server gone, a reloaded game opens the whole policy from the service worker', (await ev(SHOWN)).text === (await ev(fileText(PRIVACY))));
    await tapLink('#docpC a[data-dpl="page"]');
    await until(`!!document.querySelector('#docpC h1') && document.getElementById('docpT').textContent === 'Delete your account' || !!document.querySelector('#docp [data-dp="retry"]')`, 6000);
    check('6 and the deletion page from it', (await ev(SHOWN)).text === (await ev(fileText(DELETE))));
  }

  if (pageErrors.length) fail('page errors: ' + JSON.stringify(pageErrors.slice(0, 5)));
  else ok('no page errors');
} catch (e) {
  fail('privacy_panel stopped: ' + (e && e.stack || e));
}

if (errors.length) { console.error(`\n${errors.length} privacy_panel check(s) failed`); process.exit(1); }
console.log('\nprivacy_panel: all checks passed');
process.exit(0);
