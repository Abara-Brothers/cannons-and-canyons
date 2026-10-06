// The in-game controls remember up or down (owner, 2026-10-06), in a real page:
// "ensure that the player sees the controls in-game when he loads into the game
// but remember what state the player left his control window (either up or
// down) so that the player doesnt need to keep minimising when he enters a new
// game". Matches are started the way a player starts them (home's Launch, then
// Start Game) against a real server, left through the real Leave, resumed by a
// real reload, and the CONTROLS tab is pressed with a real mouse event at its
// centre. Headless Chrome over CDP; skips without Chrome.
//
// WHY THIS EXISTS: nothing else starts a match and looks at the dock. The rule
// it pins has three parts that fail silently in different places: the first
// match must open UP, only the tab may write the choice (a collapse the game
// makes for itself must not), and every new battle, golf round and cold resume
// must read it back while a resync and the next golf hole leave the dock alone.
//
// Self-hosted: spawns its own server on a free port with GOLF_HOLD_MS short, so
// a hole can be played out in a few seconds. Exit 3 = SKIP when Chrome is absent.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  dock tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// EVERY CDP CALL HAS A DEADLINE, AND SO DOES THE WHOLE RUN (fix wave A4). This
// suite runs in the pre-push hook: a Chrome or a server that stops answering
// must fail it loudly, never hang the push. And every way out -- the end, a
// throw, a signal, the watchdog -- takes Chrome and the server with it,
// registered before either is spawned. SIGKILL, because a frozen Chrome is the
// hang this exists for.
const CDP_MS = 15000;                                           // one call
const RUN_MS = 150000;                                          // the whole suite
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
let srv = null, chrome = null, prof = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog = setTimeout(() => { console.error(`FAIL dock overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

// ---- server ----------------------------------------------------------------
// GOLF_HOLD_MS: the server's hold between a golf stroke and the next turn. Short
// here so section 5 can cap out hole 1 and reach hole 2 without watching every
// putt roll; nothing else in this suite plays golf.
const appPort = await freePort();
srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort), GOLF_HOLD_MS: '40' }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { console.error('FAIL dock: server never came up'); process.exit(1); }

// ---- browser ---------------------------------------------------------------
const dbg = await freePort(); prof = join(tmpdir(), `cc-dock-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
if (!wsUrl) { console.error('FAIL dock: Chrome never offered a page to drive'); process.exit(1); }
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl);
await Promise.race([new Promise((r) => (ws.onopen = r)), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
// Uncaught page exceptions are collected, not ignored: a storage read or write
// that throws out of a socket frame or a tap is exactly what section 6 hunts.
const pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    pageErrors.push((d.exception && d.exception.description) || d.text || 'exception');
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
// The cold-start intro (public/intro.js) is off for this suite: it covers the bay
// with a pointer-catching canvas for six seconds on a fresh load. test/intro.mjs
// owns it. Scripts for new documents only run while the Page domain is enabled.
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__ccNoIntro = true;' });
// A current phone in landscape (iPhone 17 class).
await send('Emulation.setDeviceMetricsOverride', { width: 874, height: 402, deviceScaleFactor: 2, mobile: false });

// ---- helpers ---------------------------------------------------------------
const READY = `typeof intent === 'function' && typeof setDockCollapsed === 'function' && !!window.Bay && S.connected === true`;
// Every frame this document's socket delivers, by type, so a resync or a hole
// can be waited on by name, and the last real frame of each type, so section 4
// can hand the client a server's own restore at an exact moment. handle() is a
// classic-script global; ws.onmessage looks it up at call time, so the wrapper
// sees every frame.
const TAP_FRAMES = `(() => { if (window.__frames) return true; window.__frames = []; window.__last = {};
  const h = handle; window.handle = (m) => { __frames.push(m && m.type); if (m && m.type) __last[m.type] = m; return h(m); }; return true; })()`;
// A new document is told apart from the old one by a mark the old one carries.
async function newDocument(what) {
  const fresh = await until(`!window.__oldDoc && (${READY})`, 15000, 150);
  if (!fresh) throw new Error(what + ': the page never came back ready');
  await ev(TAP_FRAMES);
}
async function load() {
  await ev('window.__oldDoc = true').catch(() => {});
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await newDocument('load');
  await until(`!!document.querySelector('#bay .lbar')`, 8000);
}
// The real Leave (the confirm's Yes): clears the resume record, tells the
// server, and navigates home, so the next match is a brand-new battle.
async function leave() {
  await ev(`(window.__oldDoc = true, $('leaveYesBtn').click(), true)`);
  await newDocument('leave');
  if (!(await until(`!!document.querySelector('#bay .lbar') && !S.playing`, 8000))) throw new Error('leave: never landed on the bay home');
}
// A cold resume: the page reloads with the resume record still held, and the
// server answers the boot's resume with a 'restore'. That frame can land before
// this document's frame tap is installed, so the proof is the new document
// being in a battle that nobody launched in it.
async function reload() {
  await ev(`(window.__oldDoc = true, location.reload(), true)`);
  await newDocument('reload');
  if (!(await until(`S.playing === true && $('game').classList.contains('active') && !!loadResume()`, 10000))) throw new Error('reload: no cold resume');
}
// Home's Launch, then Match setup's Start Game, the way a player starts one.
async function launch(mode) {
  await ev(`(() => { ccMode = ${JSON.stringify(mode)}; Bay.show('home'); document.querySelector('#bay .launch').click();
    document.querySelector('#bay .pfoot [data-launch]').click(); return true; })()`);
  if (!(await until(`S.playing === true && S.mode === ${JSON.stringify(mode)} && $('game').classList.contains('active') && window.__frames.includes('start')`, 10000)))
    throw new Error('launch ' + mode + ': no match: ' + JSON.stringify(await ev(`({ playing: S.playing, mode: S.mode, frames: window.__frames })`)));
}
// The dock has landed: no slide in flight, the class agrees with the request,
// and a few frames have passed so a shut start's measured wait has run out.
async function settle() {
  await until(`!$('dock').classList.contains('dock-anim') && $('dock').classList.contains('collapsed') === dockShutReq`, 3000, 50);
  await ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => true)`);
  await sleep(350);
  await until(`!$('dock').classList.contains('dock-anim') && $('dock').classList.contains('collapsed') === dockShutReq`, 3000, 50);
}
const DOCK = `(() => { const t = $('dockTab'); let stored = null, learned = null;
  const get = window.__realGetItem || Storage.prototype.getItem;
  try { stored = get.call(localStorage, 'cc_dock_shut'); learned = get.call(localStorage, 'cc_dock_learned'); } catch {}
  return { shut: $('dock').classList.contains('collapsed'), req: dockShutReq, stored, learned, glowLearned: document.body.classList.contains('dock-learned'),
    expanded: t.getAttribute('aria-expanded'), label: t.getAttribute('aria-label') }; })()`;
const dock = async () => { await settle(); return ev(DOCK); };
const isUp = (d) => d && d.shut === false && d.req === false && d.expanded === 'true' && d.label === 'Collapse controls';
const isDown = (d) => d && d.shut === true && d.req === true && d.expanded === 'false' && d.label === 'Show controls';
// A real press: a mouse press and release at the element's centre, so whatever
// sits on top of it there would take the click instead.
async function tapEl(sel) {
  const c = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const top = document.elementFromPoint(x, y); return { x, y, hit: !!(top && top.closest(${JSON.stringify(sel)})), top: top ? (top.id || top.className || top.tagName) : null }; })()`);
  if (!c.hit) throw new Error(sel + ' is covered at its centre by ' + c.top);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
}
async function tapTab() { await tapEl('#dockTab'); return dock(); }
// Golf holes are capped out at par + 4 strokes with feather putts, and the
// server's short hold deals the next hole (a 'hole' frame) or ends the round
// (a 'gameover' frame) straight after. Extra fire frames inside the hold are
// refused by the server's one-shot gate, so a steady stream is safe.
const playGolfUntil = (cond, ms) => ev(`new Promise((done) => {
  const t0 = Date.now();
  const tick = () => {
    if (${cond}) return done(true);
    if (Date.now() - t0 > ${ms}) return done(false);
    sendMsg({ type: 'fire', weapon: 'putter', angle: 45, power: 1 });
    setTimeout(tick, 120);
  };
  tick();
})`);

try {
  // ---- 1. a device that has never chosen: the first match opens UP -----------
  await load();
  // The first-battle coach card is about aiming, not the dock; it stays off so
  // nothing but the dock is under test. cc_dock_learned is left unset on purpose.
  await ev(`(() => { localStorage.setItem('cc_coach', '1'); window.showToast = () => {}; return true; })()`);
  const before = await ev(DOCK);
  if (before.stored === null && before.learned === null) ok('1: a fresh device has no stored dock choice and has not learned the tab'); else fail('1: fresh storage ' + JSON.stringify(before));
  await launch('duel');
  const first = await dock();
  await sleep(600);
  const firstLater = await dock();
  if (isUp(first) && isUp(firstLater)) ok('1: the first match opens with the controls UP, and they stay up (no late tuck-away)');
  else fail('1: first match ' + JSON.stringify({ first, firstLater }));

  // ---- 2. close it with the tab: remembered, and the next match opens DOWN -----
  const closed = await tapTab();
  if (isDown(closed) && closed.stored === '1') ok("2: closing with the CONTROLS tab tucks the dock away and stores 'cc_dock_shut' = '1'");
  else fail('2: after the closing tap ' + JSON.stringify(closed));
  // THE LEARNED GLOW IS ITS OWN THING (8.40): one close proves nothing, so the
  // tab keeps teaching, whatever the stored choice says.
  if (closed.learned === null && !closed.glowLearned) ok('2: a single close does not mark the tab learned'); else fail('2: learned after one close ' + JSON.stringify(closed));
  await leave();
  await launch('duel');
  const second = await dock();
  if (isDown(second) && second.stored === '1') ok('2: the next match opens with the controls DOWN, the way the player left them');
  else fail('2: next match after closing ' + JSON.stringify(second));

  // ---- 3. open it again: remembered, and the next match opens UP ---------------
  const opened = await tapTab();
  if (isUp(opened) && opened.stored === '0') ok("3: opening with the tab brings the dock up and stores 'cc_dock_shut' = '0'");
  else fail('3: after the opening tap ' + JSON.stringify(opened));
  if (opened.learned === null && !opened.glowLearned) ok('3: opening alone does not mark the tab learned'); else fail('3: learned after an open ' + JSON.stringify(opened));
  // Opened by a tap and then closed again: NOW the tab is learned (8.40).
  const learnedClose = await tapTab();
  if (isDown(learnedClose) && learnedClose.stored === '1' && learnedClose.learned === '1' && learnedClose.glowLearned)
    ok('3: opened and then closed again by tap, the tab is learned and its glow stops (body.dock-learned), and the close is stored');
  else fail('3: learned glow ' + JSON.stringify(learnedClose));
  const reopened = await tapTab();
  if (isUp(reopened) && reopened.stored === '0' && reopened.learned === '1') ok('3: opened once more, the stored choice is UP and the tab stays learned');
  else fail('3: reopened ' + JSON.stringify(reopened));
  await leave();
  await launch('duel');
  const third = await dock();
  if (isUp(third) && third.stored === '0') ok('3: the next match opens with the controls UP again');
  else fail('3: next match after opening ' + JSON.stringify(third));

  // ---- 4. a collapse the game makes for itself writes nothing -----------------
  // setDockCollapsed is the call the resync path makes; animated or not, it is
  // not the player's choice and must leave the stored one exactly as it was.
  await ev(`(setDockCollapsed(true, true), true)`);
  const prog = await dock();
  if (isDown(prog) && prog.stored === '0') ok("4: a programmatic collapse (setDockCollapsed, animated) tucks the dock away and leaves the stored choice at '0'");
  else fail('4: programmatic collapse ' + JSON.stringify(prog));
  await ev(`(setDockCollapsed(false, false), setDockCollapsed(true, false), true)`);
  const prog2 = await dock();
  if (isDown(prog2) && prog2.stored === '0') ok('4: an unanimated programmatic open and collapse write nothing either');
  else fail('4: unanimated programmatic ' + JSON.stringify(prog2));
  // A SAME-MATCH RESYNC keeps the dock as it is: the socket drops and the
  // seat is resumed while this page is still in the battle (a warm restore).
  await ev(`(window.__frames.length = 0, S.ws.close(), true)`);
  const resynced = await until(`S.connected === true && S.playing === true && window.__frames.includes('restore')`, 10000);
  const warm = await dock();
  if (resynced && isDown(warm) && warm.stored === '0') ok('4: a same-match resync keeps the dock as it is (still down) and stores nothing');
  else fail('4: warm resync ' + JSON.stringify({ resynced, warm }));
  // A RESYNC IN THE MIDDLE OF A CLOSING SLIDE keeps the player's tap. The
  // 'collapsed' class lands only when the slide ends, and a restore can arrive
  // before that: a tap that focuses the window is enough, since focus asks for a
  // sync. The server's own restore from just now is handed to handle() in the
  // same task as the tap, so it lands mid-slide every time.
  const reopen = await tapTab();
  if (!(isUp(reopen) && reopen.stored === '0')) fail('4: could not open with the tab before the mid-slide resync ' + JSON.stringify(reopen));
  const mid = await ev(`(() => { $('dockTab').click(); const sliding = $('dock').classList.contains('dock-anim') && !$('dock').classList.contains('collapsed');
    handle(window.__last.restore); return { sliding, restored: !!window.__last.restore }; })()`);
  const afterMid = await dock();
  if (mid.sliding && mid.restored && isDown(afterMid) && afterMid.stored === '1') ok('4: a resync that lands while the dock is still sliding shut keeps it shut, as the tap asked');
  else fail('4: mid-slide resync ' + JSON.stringify({ mid, afterMid }));
  // Back to the state section 5 starts from: the stored choice UP, the dock
  // down on screen by the game's own hand.
  await tapTab();
  await ev(`(setDockCollapsed(true, false), true)`);
  const preCold = await dock();
  if (!(isDown(preCold) && preCold.stored === '0')) fail('4: could not set up the cold resume ' + JSON.stringify(preCold));

  // ---- 5. a cold resume follows the stored choice ----------------------------
  // Stored UP while the dock was down on screen: the reload's resume opens it.
  await reload();
  const coldUp = await dock();
  if (isUp(coldUp) && coldUp.stored === '0') ok('5: a cold resume (reload, restore frame) opens the controls UP when that is the stored choice');
  else fail('5: cold resume, stored up ' + JSON.stringify(coldUp));
  const shutAgain = await tapTab();
  if (!(isDown(shutAgain) && shutAgain.stored === '1')) fail('5: could not close with the tab before the second reload ' + JSON.stringify(shutAgain));
  await reload();
  const coldDown = await dock();
  if (isDown(coldDown) && coldDown.stored === '1') ok('5: a cold resume opens the controls DOWN when the player left them down');
  else fail('5: cold resume, stored down ' + JSON.stringify(coldDown));

  // ---- 6. golf: a new round reads the choice, the next hole leaves the dock ----
  await leave();
  await launch('golf');
  const round = await dock();
  if (isDown(round) && round.stored === '1') ok('6: a new golf round opens with the controls DOWN, the stored choice');
  else fail('6: new golf round ' + JSON.stringify(round));
  // Opened by the game, not the tab, so the dock now differs from the stored
  // choice: the next hole must leave it up rather than re-apply 'down'.
  await ev(`(setDockCollapsed(false, false), true)`);
  const holeBefore = await dock();
  const holed = await playGolfUntil(`S.golf && S.golf.hole >= 2 && window.__frames.includes('hole')`, 20000);
  const hole2 = await dock();
  if (holed && isUp(holeBefore) && isUp(hole2) && hole2.stored === '1')
    ok('6: the next golf hole (a hole frame) leaves the dock as it is: still up, though the stored choice is down');
  else fail('6: next hole ' + JSON.stringify({ holed, holeBefore, hole2, hole: await ev('S.golf && S.golf.hole') }));
  // A NEW ROUND IN THE SAME PAGE (Rematch) reads the choice again, and must
  // actively open the dock when the choice is UP, even though it is down on
  // screen: as it would be when another window of the game on this device
  // changed the choice, or a write was lost. Tab: close, then open (stored UP);
  // then the game's own collapse puts it down without a write.
  await tapTab();
  const golfUp = await tapTab();
  await ev(`(setDockCollapsed(true, false), true)`);
  const preRematch = await dock();
  if (!(isUp(golfUp) && golfUp.stored === '0' && isDown(preRematch) && preRematch.stored === '0')) fail('6: could not set up the rematch ' + JSON.stringify({ golfUp, preRematch }));
  const over = await playGolfUntil(`window.__frames.includes('gameover')`, 40000);
  const shown = over && await until(`!$('overlay').classList.contains('hidden') && $('rematchBtn').style.display !== 'none'`, 15000);
  if (!shown) throw new Error('the golf round never reached its Rematch: ' + JSON.stringify(await ev(`({ hole: S.golf && S.golf.hole, frames: window.__frames.slice(-6) })`)));
  await ev(`(window.__frames.length = 0, true)`);
  await tapEl('#rematchBtn');
  const again = await until(`window.__frames.includes('start') && S.playing === true && S.mode === 'golf' && S.golf && S.golf.hole === 1 && $('overlay').classList.contains('hidden')`, 10000);
  const rematched = await dock();
  if (again && isUp(rematched) && rematched.stored === '0') ok('6: a new golf round in the same page (Rematch) opens the controls UP, the stored choice, though they were down on screen');
  else fail('6: rematch round ' + JSON.stringify({ again, rematched }));

  // ---- 7. storage that throws: the controls still open UP ---------------------
  // Blocked site data (private browsing, a locked-down WebView): every read and
  // write of the choice throws. The stored value underneath says DOWN (the tab
  // closes it first), so UP here can only come from the read failing safe.
  const downFirst = await tapTab();
  if (!(isDown(downFirst) && downFirst.stored === '1')) fail('7: could not store DOWN first ' + JSON.stringify(downFirst));
  await leave();
  await ev(`(() => { const g = Storage.prototype.getItem, s = Storage.prototype.setItem; window.__realGetItem = g;
    const deny = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    Storage.prototype.getItem = function (k) { if (k === 'cc_dock_shut') deny(); return g.call(this, k); };
    Storage.prototype.setItem = function (k, v) { if (k === 'cc_dock_shut') deny(); return s.call(this, k, v); };
    return true; })()`);
  const errs0 = pageErrors.length;
  await launch('duel');
  const blocked = await dock();
  if (isUp(blocked) && blocked.stored === '1') ok('7: with the choice unreadable (the store says down), a new match still opens the controls UP');
  else fail('7: throwing storage, new match ' + JSON.stringify(blocked));
  const blockedTap = await tapTab();
  const newErrs = pageErrors.slice(errs0);
  if (isDown(blockedTap) && blockedTap.stored === '1') ok('7: the tab still tucks the dock away when the choice cannot be written');
  else fail('7: throwing storage, tab ' + JSON.stringify(blockedTap));
  if (newErrs.length === 0) ok('7: no exception escapes the start of the match or the tap'); else fail('7: page exceptions ' + JSON.stringify(newErrs));

  // ---- 8. the words match the rule --------------------------------------------
  // The first battle now opens with the controls UP, so the coach's fire step
  // must not send a first-timer to raise a panel that is already there, and the
  // field manual must say the dock is remembered, not that it starts hidden.
  const words = await ev(`(() => ({ combat: (COACH_COMBAT.find((s) => s.id === 'fire') || {}).body || '', golf: (COACH_GOLF.find((s) => s.id === 'fire') || {}).body || '',
    manual: [...document.querySelectorAll('#helpModal .hb-fact, .hb-fact')].map((f) => f.textContent.replace(/\\s+/g, ' ').trim()).find((t) => /Controls tuck away/.test(t)) || '' }))()`);
  if (/^Hit FIRE\./.test(words.combat) && /^Hit FIRE\./.test(words.golf) && !/bring the panel up|CONTROLS tab/i.test(words.combat + words.golf))
    ok("8: the coach's fire step says Hit FIRE, in combat and golf, and never tells the player to raise the panel");
  else fail('8: coach fire copy ' + JSON.stringify([words.combat, words.golf]));
  if (/opens the way you left it/.test(words.manual) && !/open with the dock hidden/i.test(words.manual))
    ok('8: the field manual says the next battle opens the way you left the dock');
  else fail('8: manual copy ' + JSON.stringify(words.manual));
} catch (e) {
  fail('dock suite stopped: ' + (e && e.message));
}

if (pageErrors.length) console.log('  (page exceptions seen during the run: ' + JSON.stringify(pageErrors.slice(0, 5)) + ')');
clearTimeout(watchdog);
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall dock checks passed');
process.exit(errors.length ? 1 : 0);
