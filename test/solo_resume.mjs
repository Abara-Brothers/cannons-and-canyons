// Come back to a match against the computer (owner, 2026-10-07: "the server
// keeps any match with no other HUMAN players for 24 hours in every mode;
// reopen -> back on your turn; if the room is gone (e.g. a deploy), a clear
// 'that match ended while you were away' message instead of a silent kick"),
// in a real page against a real server:
//   A. THE BUG: a free-for-all against three CPUs, the app closed on the
//      player's turn for longer than the old empty-room hold, then opened
//      again. It resumes onto the player's turn by the cc_resume token, and the
//      match plays on: their shot, the three CPUs, their turn again.
//   B. THE DAY RUNS OUT: closed for longer than the hold, then opened. The
//      menu says "That match ended while you were away." in a notice that
//      stays until OK, with nothing left saying Reconnecting; a reload after
//      OK says nothing.
//   C. A DEPLOY MID-MATCH: the server restarts under a live match. The page
//      goes home and says the same thing there, once.
//   D. ONE HELD MATCH PER PLAYER: with a held match on the server and its
//      record on the device, a new vs-Computer start carries the record's
//      token, the server ends the held match, and the record is let go.
//   E. Which frames carry that token, and when.
//   F. The notice itself: the words, legible and inside the safe area at
//      667x375, 812x375, 874x402 with an iPhone 17's safe areas, and 932x430;
//      OK, Escape (one layer only) and a tap outside close it; it is drawn
//      over the player menu and the privacy policy panel; the keyboard goes
//      back where it was; a match starting under it takes it down; an
//      ordinary launch never shows it.
// The server's own rules (a real day, every mode, the bounds) are
// test/solo_hold.mjs's, on a fake clock. Here the day is SOLO_HOLD_MS = 4 s
// and the old half hour is EMPTY_ROOM_GRACE_MS = 0.4 s, so a match the old
// rule would have reclaimed is the one this page must come back to.
//
// Self-hosted: spawns its own server on a free port (and, for C, restarts it
// on that port), never production. Headless Chrome over CDP; every CDP call has
// a deadline. Exit 3 = SKIP when Chrome is absent.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  solo_resume tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const CDP_MS = 15000;                                           // one call
const RUN_MS = 240000;                                          // the whole suite
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
let srv = null, chrome = null, prof = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog = setTimeout(() => { console.error(`FAIL solo_resume overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

// ---- server ----------------------------------------------------------------
const HOLD_MS = 4000;          // stands in for the day (SOLO_HOLD_MS)
const OLD_HOLD_MS = 400;       // stands in for the old half hour (EMPTY_ROOM_GRACE_MS)
const ENV = { SOLO_HOLD_MS: String(HOLD_MS), EMPTY_ROOM_GRACE_MS: String(OLD_HOLD_MS), BOT_FIRE_MS: '250', PICK_MS: '600' };
const appPort = await freePort();
async function startServer() {
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort), ...ENV }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); return true; } catch {} await sleep(150); }
  return false;
}
// A deploy: SIGTERM (the server tells every socket it is restarting and
// exits), then a new server on the same port, its rooms empty.
async function restartServer() {
  const old = srv;
  const exited = new Promise((r) => old.once('exit', r));
  old.kill('SIGTERM');
  await Promise.race([exited, sleep(6000)]);
  try { old.kill('SIGKILL'); } catch {}
  return startServer();
}
if (!(await startServer())) { console.error('FAIL solo_resume: server never came up'); process.exit(1); }

// ---- browser ---------------------------------------------------------------
// ONE TAB AT A TIME, AND "THE APP CLOSED" CLOSES IT. Navigating a tab away is
// not the same thing: Chrome can keep the old page alive in its back/forward
// cache with the socket still open, so the server never hears the player go
// and a resume "works" without the hold being involved at all (measured: the
// first draft of this suite did exactly that). Closing the tab destroys the
// page and its socket, as killing the app does. localStorage, where the resume
// record lives, belongs to the profile and survives, as it does on a phone.
const dbg = await freePort(); prof = join(tmpdir(), `cc-solo-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
const DEVTOOLS = `http://127.0.0.1:${dbg}`;
let firstTab = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`${DEVTOOLS}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { firstTab = p; break; } } catch {} await sleep(200); }
if (!firstTab) { console.error('FAIL solo_resume: Chrome never offered a page to drive'); process.exit(1); }
let cdp = null, tabId = null, id = 0;
const pend = new Map();
const pageErrors = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  const t = setTimeout(() => { pend.delete(i); rej(new Error(`CDP ${method} gave no answer in ${CDP_MS} ms`)); }, CDP_MS);
  pend.set(i, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  cdp.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };
const until = async (expr, ms, step = 100) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(step); } return ev(expr).catch(() => false); };
// A current phone in landscape (iPhone 17 class) unless a section says otherwise.
const VIEW = { width: 874, height: 402, deviceScaleFactor: 2, mobile: true };
let view = VIEW;
const setView = (v) => { view = v; return send('Emulation.setDeviceMetricsOverride', v); };
// Every new document: the intro off (test/intro.mjs owns it), the first-battle
// coach off, a full saved rack (so no draft modal), and THE TAP. The tap wraps
// the real WebSocket and forwards every byte, so the page talks to the real
// server exactly as it would; it records what was sent (__tx) and the type of
// everything received (__rx). One test switch: a stored flag drops the next
// 'resume' frame, so a page can boot with a held match's record and NOT take
// it back (section D).
const NEW_DOC = `(() => {
  window.__ccNoIntro = true;
  try { localStorage.setItem('cc_coach', '1'); localStorage.setItem('cc_loadout', JSON.stringify(['mortar', 'cluster', 'napalm', 'airstrike', 'volley'])); } catch (e) {}
  const Real = window.WebSocket;
  window.__tx = []; window.__rx = []; window.__dropped = null;
  const Tap = function (url, proto) {
    const s = new Real(url, proto);
    const real = s.send.bind(s);
    s.send = (d) => {
      let m = null; try { m = JSON.parse(d); } catch (e) {}
      if (m && m.type === 'resume') {
        try { if (localStorage.getItem('cc_test_drop_resume')) { localStorage.removeItem('cc_test_drop_resume'); window.__dropped = m; return; } } catch (e) {}
      }
      if (m) window.__tx.push(m);
      real(d);
    };
    s.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); window.__rx.push({ t: m.type, by: m.by, turn: m.turn }); } catch (x) {} });
    return s;
  };
  Tap.prototype = Real.prototype;
  Tap.OPEN = Real.OPEN; Tap.CONNECTING = Real.CONNECTING; Tap.CLOSING = Real.CLOSING; Tap.CLOSED = Real.CLOSED;
  window.WebSocket = Tap;
})();`;
async function attach(target) {
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await Promise.race([new Promise((r) => (sock.onopen = r)), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
  // Uncaught page exceptions are collected, not ignored.
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      pageErrors.push((d.exception && d.exception.description) || d.text || 'exception');
      return;
    }
    const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  };
  cdp = sock; tabId = target.id;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  // Nothing here may reach a real backend, production least of all.
  await send('Network.setBlockedURLs', { urls: ['*supabase.co*', '*googleapis*', '*abarabrothers.com*'] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: NEW_DOC });
  await setView(view);
}
await attach(firstTab);

// ---- helpers ---------------------------------------------------------------
const BASE = `http://127.0.0.1:${appPort}/`;
const READY = `typeof handle === 'function' && typeof sendMsg === 'function' && !!window.Bay`;
// A new document is told apart from the old one by a mark the old one carries.
async function newDocument(what) {
  if (!(await until(`!window.__oldDoc && (${READY})`, 15000, 150))) throw new Error(what + ': the page never came back ready');
}
async function load() {
  await ev('window.__oldDoc = true').catch(() => {});
  await send('Page.navigate', { url: BASE });
  await newDocument('load');
}
// THE APP CLOSED: a new blank tab to come back in, then the old tab is closed,
// page, socket and all, so the server sees the player leave exactly as it does
// when a phone kills the app. The next load() is the player opening it again.
async function away() {
  const t = await (await fetch(`${DEVTOOLS}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) })).json();
  const old = { sock: cdp, id: tabId };
  await attach(t);
  try { old.sock.close(); } catch {}
  await fetch(`${DEVTOOLS}/json/close/${old.id}`, { signal: AbortSignal.timeout(5000) });
  for (let i = 0; i < 40; i++) {
    const l = await (await get(`${DEVTOOLS}/json/list`)).json();
    if (!l.some((x) => x.id === old.id)) return;
    await sleep(100);
  }
  throw new Error('away: the old tab never closed');
}
// Home's Launch, then Match setup's Start Game, the way a player starts one.
async function launch(mode) {
  // Easy CPUs, so a round of three never ends the match on the player.
  await ev(`(() => { ccMode = ${JSON.stringify(mode)}; ccMax = 4; cpuDifficulty = 'easy'; Bay.show('home'); document.querySelector('#bay .launch').click();
    document.querySelector('#bay .pfoot [data-launch]').click(); return true; })()`);
  if (!(await until(`S.playing === true && S.mode === ${JSON.stringify(mode)} && $('game').classList.contains('active')`, 10000)))
    throw new Error('launch ' + mode + ': no match: ' + JSON.stringify(await ev(`({ playing: S.playing, mode: S.mode, rx: window.__rx.map((f) => f.t) })`)));
}
const MY_TURN = `S.playing === true && !S.picking && S.turn === S.you && $('game').classList.contains('active')`;
const record = () => ev(`(() => { try { return JSON.parse(localStorage.getItem('cc_resume') || 'null'); } catch (e) { return 'unreadable'; } })()`);
// The notice, as the player sees it: up, its words, and nothing else on stage
// still saying Reconnecting.
const NOTICE = `(() => { const m = document.getElementById('mgone'); const up = !!(m && !m.hidden && getComputedStyle(m).display !== 'none');
  return { up, text: up ? m.querySelector('.mgh').textContent : null, conn: !$('connErr').classList.contains('hidden'),
    playing: S.playing, home: !!document.querySelector('#bay .lbar') && !$('game').classList.contains('active') }; })()`;
const notice = () => ev(NOTICE);
const WORDS = 'That match ended while you were away.';
const shown = (n) => n && n.up && n.text === WORDS && !n.conn && n.playing === false && n.home;
// A real press: a mouse press and release at a point, so whatever sits on top
// there takes it.
async function press(x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
async function pressEl(sel) {
  const c = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const top = document.elementFromPoint(x, y); return { x, y, hit: !!(top && top.closest(${JSON.stringify(sel)})), top: top ? (top.id || top.className || top.tagName) : null }; })()`);
  if (!c) throw new Error(sel + ' is not on the page');
  if (!c.hit) throw new Error(sel + ' is covered at its centre by ' + c.top);
  await press(c.x, c.y);
}
async function key(k) {
  const code = k === 'Escape' ? 27 : k === 'Enter' ? 13 : 0;
  // Enter carries its text, so it activates a focused button the way a real key does.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(k === 'Enter' ? { text: '\r' } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}
// A second client, straight to the server: asks to resume a seat and reports
// the answer. Used only on a seat whose match should already be gone.
const probeResume = (code, token) => new Promise((res) => {
  const s = new WebSocket(`ws://127.0.0.1:${appPort}/ws`);
  const t = setTimeout(() => { try { s.close(); } catch {} res('no answer'); }, 5000);
  s.onopen = () => s.send(JSON.stringify({ type: 'resume', code, token }));
  s.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.type === 'restore' || m.type === 'resumeError') { clearTimeout(t); try { s.close(); } catch {} res(m.type); } };
  s.onerror = () => {};
});

try {
  await load();
  await until('S.connected === true', 8000);
  {
    const n = await notice();
    if (!n.up) ok('an ordinary launch shows no notice'); else fail('an ordinary launch shows the notice: ' + JSON.stringify(n));
  }

  // ---- A. the bug: a free-for-all left longer than the old hold --------------
  await launch('ffa');
  if (!(await until(MY_TURN, 15000))) throw new Error('A: never reached the player\'s turn');
  const a = await record();
  const aNames = await ev('S.names.slice()');
  await away();
  await sleep(OLD_HOLD_MS + 1100);
  await load();
  const back = await until(`${MY_TURN} && S.mode === 'ffa' && S.code === ${JSON.stringify(a.code)}`, 12000);
  const aTx = await ev(`window.__tx.filter((m) => m.type === 'resume')`), aRx = await ev('window.__rx.map((f) => f.t)');
  if (back && aTx.length === 1 && aTx[0].code === a.code && aTx[0].token === a.token && aRx.includes('restore') && !aRx.includes('resumeError')
      && JSON.stringify(await ev('S.names.slice()')) === JSON.stringify(aNames)) {
    ok(`A: a free-for-all against three CPUs, closed on the player's turn for ${OLD_HOLD_MS + 1100} ms (past the old hold), resumes by its token onto the player's turn`);
  } else fail(`A: reopen — back ${back}, resume frames ${JSON.stringify(aTx)}, record ${JSON.stringify(a)}, received ${JSON.stringify(aRx)}`);
  {
    const n = await notice();
    if (!n.up) ok('A: and no notice, because nothing ended'); else fail('A: a notice over a resumed match: ' + JSON.stringify(n));
  }
  // It plays on: the player's shot, each CPU's, and the turn comes home.
  const me = await ev('S.you');
  await ev(`(window.__rx = [], sendMsg({ type: 'fire', weapon: 'cannon', angle: 45, power: 55 }), true)`);
  const round = await until(`(() => { const r = window.__rx; const i = r.findIndex((f) => f.t === 'shot' && f.by === ${me});
    if (i < 0) return false; const after = r.slice(i + 1); const cpus = new Set(after.filter((f) => f.t === 'shot').map((f) => f.by));
    return cpus.size === 3 && !cpus.has(${me}) && after.some((f) => f.t === 'turn' && f.turn === ${me}) && ${MY_TURN}; })()`, 45000, 150);
  if (round) ok('A: and the match plays on: the player\'s shot is taken, the three CPUs take theirs, and it is the player\'s turn again');
  else fail('A: after the resume the round did not come home: ' + JSON.stringify(await ev('window.__rx')));

  // ---- B. the day runs out ----------------------------------------------------
  await away();
  await sleep(HOLD_MS + 1500);
  await load();
  const bUp = await until(`(${NOTICE}).up`, 10000);
  const bn = await notice();
  const bRec = await record(), bRx = await ev('window.__rx.map((f) => f.t)');
  if (bUp && shown(bn) && bRec === null && bRx.includes('resumeError') && !bRx.includes('restore')) {
    ok('B: reopened after the hold ran out, the menu says "That match ended while you were away." with nothing still saying Reconnecting, and the record is gone');
  } else fail(`B: ${JSON.stringify({ bUp, bn, bRec, bRx })}`);
  await sleep(1800);
  if (shown(await notice())) ok('B: the notice stays up until the player puts it away'); else fail('B: the notice went by itself');
  await pressEl('#mgone .mgo');
  if (!(await notice()).up) ok('B: OK puts it away'); else fail('B: OK did not close the notice');
  await load();
  await sleep(1200);
  {
    const n = await notice(), tx = await ev(`window.__tx.filter((m) => m.type === 'resume').length`);
    if (!n.up && tx === 0) ok('B: a reload after that says nothing and asks to resume nothing'); else fail(`B: after a reload — notice ${JSON.stringify(n)}, resumes sent ${tx}`);
  }

  // ---- C. a deploy mid-match ---------------------------------------------------
  await until('S.connected === true', 8000);
  await launch('duel');
  if (!(await until(MY_TURN, 15000))) throw new Error('C: never reached the player\'s turn');
  await ev('window.__oldDoc = true');
  if (!(await restartServer())) throw new Error('C: the server did not come back');
  const cUp = await until(`!window.__oldDoc && (${READY}) && (${NOTICE}).up`, 20000, 150);
  const cn = await notice();
  const cFlag = await ev(`(() => { try { return sessionStorage.getItem('cc_match_gone'); } catch (e) { return 'unreadable'; } })()`);
  if (cUp && shown(cn) && cFlag === null && (await record()) === null) ok('C: a server restart under a live match goes home and says "That match ended while you were away." there, and the flag that carried it is spent');
  else fail(`C: ${JSON.stringify({ cUp, cn, cFlag, rec: await record() })}`);
  await pressEl('#mgone .mgo');
  await load();
  await sleep(1000);
  if (!(await notice()).up) ok('C: once only: a reload after OK says nothing'); else fail('C: the notice came back on a reload');
  // WITHOUT SESSION STORAGE the notice cannot cross the reload, so the match
  // screen says the same words itself before it goes home.
  await until('S.connected === true', 8000);
  await launch('duel');
  if (!(await until(MY_TURN, 15000))) throw new Error('C: never reached the player\'s turn (no session storage)');
  await ev(`(() => { const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (this === sessionStorage) throw new Error('blocked'); return real.call(this, k, v); };
    window.__oldDoc = true; handle({ type: 'resumeError' }); return true; })()`);
  const c2 = await ev(`({ toast: [...document.querySelectorAll('.toast-item')].map((t) => t.textContent).pop() || null, playing: S.playing })`);
  await newDocument('the reload after a refused resume');
  await sleep(600);
  if (c2.toast === WORDS && !(await notice()).up) ok('C: with session storage refused, the match says "That match ended while you were away." in its toast before going home, and home has nothing left to say');
  else fail(`C: no session storage — toast ${JSON.stringify(c2)}, notice after ${JSON.stringify(await notice())}`);

  // ---- D. a new match lets go of the held one -----------------------------------
  await until('S.connected === true', 8000);
  await launch('ffa');
  if (!(await until(MY_TURN, 15000))) throw new Error('D: never reached the player\'s turn');
  const d = await record();
  await ev(`(localStorage.setItem('cc_test_drop_resume', '1'), true)`);
  await away();
  await sleep(800);
  await load();
  await until('S.connected === true && !!window.__dropped', 8000);
  const dKept = await record();
  if (dKept && dKept.code === d.code && !(await ev('S.playing'))) ok('D: (set-up) the page is on the menu with the held match\'s record, its resume held back');
  else fail(`D: set-up — record ${JSON.stringify(dKept)}, playing ${await ev('S.playing')}`);
  await launch('duel');
  const dAi = await ev(`window.__tx.filter((m) => m.type === 'ai')`);
  const dNow = await record();
  if (dAi.length === 1 && dAi[0].held === d.token && dNow && dNow.code !== d.code) ok('D: the vs-Computer start carries the held match\'s token as `held`, and the record now names the new match');
  else fail(`D: ai frames ${JSON.stringify(dAi.map((m) => ({ held: m.held })))}, record ${JSON.stringify(dNow)}, held match ${d.code}`);
  const probe = await probeResume(d.code, d.token);
  if (probe === 'resumeError') ok('D: and the server has ended the held match: its own token can no longer resume it');
  else fail('D: the held match is still on the server: a resume by its token answered ' + probe);

  // ---- E. which frames carry the token ------------------------------------------
  {
    const r = await ev(`(() => {
      const realWs = S.ws, wasPlaying = S.playing, wasLocal = S.local, out = [];
      const sent = [];
      S.ws = { readyState: 1, send: (d) => sent.push(JSON.parse(d)) };
      const rec = () => localStorage.getItem('cc_resume');
      const plant = () => localStorage.setItem('cc_resume', JSON.stringify({ code: 'WXYZ', token: 'tok-held' }));
      try {
        S.playing = false; S.local = false;
        plant();
        for (const t of ['join', 'quick', 'resume', 'sync', 'squad']) { sendMsg({ type: t, code: 'ABCD' }); out.push([t, 'held' in sent[sent.length - 1], !!rec()]); }
        S.playing = true; sendMsg({ type: 'ai', difficulty: 'easy' }); out.push(['ai while playing', 'held' in sent[sent.length - 1], !!rec()]); S.playing = false;
        S.local = true; sendMsg({ type: 'create', mode: 'golf' }); out.push(['create while local', 'held' in sent[sent.length - 1], !!rec()]); S.local = false;
        const f = { type: 'create', mode: 'golf', max: 1 };
        sendMsg(f);
        const c = sent[sent.length - 1];
        out.push(['create', c.held === 'tok-held', !!rec(), 'held' in f]);
        sendMsg({ type: 'ai', difficulty: 'easy' }); out.push(['ai after', 'held' in sent[sent.length - 1], !!rec()]);
        plant();
        sendMsg({ type: 'ai', difficulty: 'easy' }); out.push(['ai', sent[sent.length - 1].held === 'tok-held', !!rec()]);
      } finally { S.ws = realWs; S.playing = wasPlaying; S.local = wasLocal; localStorage.removeItem('cc_resume'); }
      return out;
    })()`);
    const want = [['join', false, true], ['quick', false, true], ['resume', false, true], ['sync', false, true], ['squad', false, true],
      ['ai while playing', false, true], ['create while local', false, true], ['create', true, false, false], ['ai after', false, false], ['ai', true, false]];
    if (JSON.stringify(r) === JSON.stringify(want)) ok('E: only a create or a vs-Computer start carries the record\'s token, never during a match or offline, the caller\'s frame is not changed, and the record goes when it is sent');
    else fail('E: ' + JSON.stringify(r));
  }
  await ev(`(window.__oldDoc = true, $('leaveYesBtn').click(), true)`);
  await newDocument('leave');

  // ---- F. the notice itself ---------------------------------------------------------
  const IPHONE17 = ':root{--sa-l:62px;--sa-r:62px;--sa-b:21px;--sa-t:0px}';
  const VIEWS = [
    { name: '667x375', w: 667, h: 375 },
    { name: '812x375', w: 812, h: 375 },
    { name: '874x402 iPhone 17 safe areas', w: 874, h: 402, css: IPHONE17 },
    { name: '932x430', w: 932, h: 430 },
  ];
  for (const v of VIEWS) {
    await setView({ width: v.w, height: v.h, deviceScaleFactor: 2, mobile: true });
    await load();
    if (v.css) await ev(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(v.css)}; document.head.appendChild(s); return true; })()`);
    await ev('(matchGone(), true)');
    await sleep(150);
    const m = await ev(`(() => {
      const len = (css) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:-9999px;top:0;height:0;width:' + css; document.body.appendChild(d); const w = d.getBoundingClientRect().width; d.remove(); return w; };
      const u = len('calc(var(--u) * 1000)') / 1000;
      const sa = { l: len('var(--sa-l)'), r: len('var(--sa-r)'), t: len('var(--sa-t)'), b: len('var(--sa-b)') };
      const card = document.querySelector('#mgone .mgw'), h = document.querySelector('#mgone .mgh'), b = document.querySelector('#mgone .mgo');
      const R = (e) => { const x = e.getBoundingClientRect(); return { l: x.left, t: x.top, r: x.right, b: x.bottom, w: x.width, h: x.height }; };
      const c = R(card), br = R(b);
      const top = document.elementFromPoint(br.l + br.w / 2, br.t + br.h / 2);
      const rgb = (s) => (s.match(/[\\d.]+/g) || []).map(Number);
      const lum = ([r, g, bl]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
      const L1 = lum(rgb(getComputedStyle(h).color)), L2 = lum(rgb(getComputedStyle(card).backgroundColor));
      return { u, sa, W: innerWidth, H: innerHeight, c, br, text: h.textContent, ok: b.textContent,
        hpx: parseFloat(getComputedStyle(h).fontSize), bpx: parseFloat(getComputedStyle(b).fontSize),
        clipped: h.scrollWidth > h.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1,
        okOnTop: !!(top && top.closest('#mgone .mgo')), focus: document.activeElement === b,
        contrast: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05) };
    })()`);
    const inside = m.c.l >= m.sa.l - 0.5 && m.c.r <= m.W - m.sa.r + 0.5 && m.c.t >= m.sa.t - 0.5 && m.c.b <= m.H - m.sa.b + 0.5;
    const legible = m.hpx / m.u >= 13 && m.bpx / m.u >= 13 && m.br.h >= 44 && m.contrast >= 4.5;
    if (m.text === WORDS && m.ok === 'OK' && inside && legible && !m.clipped && m.okOnTop && m.focus) {
      ok(`F ${v.name}: the words, whole, at ${(m.hpx / m.u).toFixed(1)}u (OK ${(m.bpx / m.u).toFixed(1)}u, ${m.br.h.toFixed(0)} px tall, contrast ${m.contrast.toFixed(1)}:1), inside the safe area, OK on top and focused`);
    } else fail(`F ${v.name}: ${JSON.stringify({ text: m.text, ok: m.ok, inside, c: m.c, sa: m.sa, W: m.W, H: m.H, u: m.u, hpx: m.hpx, bpx: m.bpx, okH: m.br.h, contrast: m.contrast, clipped: m.clipped, okOnTop: m.okOnTop, focus: m.focus })}`);
    await pressEl('#mgone .mgo');
    if (!(await notice()).up) ok(`F ${v.name}: OK puts it away`); else fail(`F ${v.name}: OK did not close it`);
  }
  await setView(VIEW);
  await load();
  // A tap outside the card puts it away; a tap on the card's words does not.
  await ev('(matchGone(), true)');
  {
    const w = await ev(`(() => { const b = document.querySelector('#mgone .mgh').getBoundingClientRect(); return { x: b.left + 4, y: b.top + b.height / 2 }; })()`);
    await press(w.x, w.y);
    const stays = (await notice()).up;
    await press(8, 8);
    if (stays && !(await notice()).up) ok('F: a tap outside the card puts it away; a tap on its words does not'); else fail(`F: tap on the words kept it ${stays}, tap outside closed it ${!(await notice()).up}`);
  }
  // THE KEYBOARD GOES BACK where it was, as the player menu does.
  {
    await ev(`(() => { const b = document.querySelector('#bay .launch'); b.focus(); window.__from = b; return true; })()`);
    await ev('(matchGone(), true)');
    const onOk = await ev(`document.activeElement === document.querySelector('#mgone .mgo')`);
    await key('Enter');
    const r = await ev(`({ shut: !(${NOTICE}).up, back: document.activeElement === window.__from })`);
    if (onOk && r.shut && r.back) ok('F: the keyboard lands on OK, Enter puts the notice away, and the keyboard goes back to where it was');
    else fail(`F: focus — on OK ${onOk}, ${JSON.stringify(r)}`);
  }
  // OVER THE PLAYER MENU, AND ESCAPE TAKES ONE LAYER. The menu is opened by its
  // own click door after the notice's layer already exists, so the notice must
  // win by its own z-index, not by being the newer element.
  {
    await ev(`(() => { const b = document.createElement('button'); b.id = 'tpm'; b.dataset.pmenu = '00000000-0000-4000-8000-000000000000'; b.dataset.pmkind = 'id'; b.dataset.pmname = 'Test Pilot';
      b.textContent = 'menu'; document.getElementById('bay').appendChild(b); b.click(); return true; })()`);
    const pmUp = `(() => { const p = document.getElementById('pmenu'); return !!(p && !p.hidden && p.querySelector('.pmw')); })()`;
    const before = await ev(pmUp);
    await ev('(matchGone(), true)');
    const onTop = await ev(`(() => { const b = document.querySelector('#mgone .mgo').getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!(t && t.closest('#mgone')); })()`);
    await key('Escape');
    const one = await ev(`({ notice: (${NOTICE}).up, menu: ${pmUp} })`);
    await key('Escape');
    const two = await ev(`({ notice: (${NOTICE}).up, menu: ${pmUp} })`);
    if (before && onTop && !one.notice && one.menu && !two.menu) ok('F: drawn over the player menu; Escape puts away the notice only, and a second Escape the menu');
    else fail(`F: over the menu — menu open ${before}, notice on top ${onTop}, first Escape ${JSON.stringify(one)}, second ${JSON.stringify(two)}`);
    await ev(`(document.getElementById('tpm').remove(), true)`);
  }
  // OVER THE PRIVACY POLICY PANEL TOO (bay.js docOpen, #docp), opened the way a
  // player opens it, from Bay controls; and Escape again takes one layer.
  {
    await ev(`(Bay.show('settings'), document.querySelector('#bay [data-doc="privacy.html"]').click(), true)`);
    const dpUp = `(() => { const d = document.getElementById('docp'); return !!(d && !d.hidden); })()`;
    const before = await until(dpUp, 3000);
    await ev('(matchGone(), true)');
    const onTop = await ev(`(() => { const b = document.querySelector('#mgone .mgo').getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!(t && t.closest('#mgone')); })()`);
    await key('Escape');
    const one = await ev(`({ notice: (${NOTICE}).up, panel: ${dpUp} })`);
    await key('Escape');
    const two = await ev(`({ notice: (${NOTICE}).up, panel: ${dpUp} })`);
    if (before && onTop && !one.notice && one.panel && !two.panel) ok('F: drawn over the privacy policy panel; Escape puts away the notice only, and a second Escape the panel');
    else fail(`F: over the policy panel — panel open ${before}, notice on top ${onTop}, first Escape ${JSON.stringify(one)}, second ${JSON.stringify(two)}`);
    await ev(`(Bay.show('home'), true)`);
  }
  // A NOTICE STILL WAITING FOR THE LAUNCH'S DOORS (bay.js mgRaise) is dropped
  // by a match starting under them: once they go, the match is what they open
  // onto, and nothing is drawn over it. The doors are stood in for by their two
  // signals (intro.js CC_DOORS_UP and cc:doorsgone); test/intro.mjs A5 drives
  // the real doors.
  {
    await until('S.connected === true', 8000);
    await ev('(window.CC_DOORS_UP = true, matchGone(), true)');
    const waited = !(await notice()).up;
    await launch('duel');
    await ev(`(window.CC_DOORS_UP = false, document.dispatchEvent(new Event('cc:doorsgone')), true)`);
    await sleep(150);
    const after = await notice();
    if (waited && !after.up && after.playing) ok('F: a notice waiting for the doors is dropped by a match starting under them, and never drawn over the match');
    else fail(`F: waiting notice — held back ${waited}, after the doors ${JSON.stringify(after)}`);
    await ev(`(window.__oldDoc = true, $('leaveYesBtn').click(), true)`);
    await newDocument('leave');
  }
  // A MATCH STARTING UNDER IT takes it down: the battlefield is the newer news.
  {
    await until('S.connected === true', 8000);
    await ev('(matchGone(), true)');
    const up = (await notice()).up;
    await launch('duel');
    if (up && !(await notice()).up) ok('F: a match starting under the notice takes it down'); else fail(`F: match start — up before ${up}, after ${JSON.stringify(await notice())}`);
  }
} catch (e) {
  fail('solo_resume suite stopped: ' + (e && e.message));
}

if (pageErrors.length) fail('page exceptions: ' + JSON.stringify(pageErrors.slice(0, 5)));
clearTimeout(watchdog);
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall solo_resume checks passed');
process.exit(errors.length ? 1 : 0);
