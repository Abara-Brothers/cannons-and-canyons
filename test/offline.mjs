// Offline play in the REAL page (items 2 + B + A's client half): the pending
// lobby, Play solo, Cancel, the header's Back arrow, and the three launch
// paths — driven over CDP against the real app.js / bay.js / room-engine.js.
//
// WHY THIS EXISTS: nothing else looks at the not-connected half of intent().
// The forbidden behaviour — an invite room silently turned into a solo game by
// a timer — is invisible in every test that has a server, and the two guards
// that keep the offer honest (Back IS Cancel; a queued create dies with the
// screen) failed by reading alone before this suite existed.
//
// HOW the server goes away: SIGSTOP on the spawned process. TCP still accepts,
// the WebSocket handshake never answers, so the client sits in CONNECTING —
// exactly a cold start or a deploy restart — and SIGCONT completes the very
// same handshake, so the queued create can be seen flushing into a real room.
// "Offline" additionally overrides navigator.onLine. The engine module is
// imported once per page BEFORE the cut, so a local start never waits on the
// stopped server (in production it comes from the service worker's precache).
//
// Self-hosted: spawns its own server on a free port. Exit 3 = SKIP when Chrome
// is absent, so a bare CI runner stays green but the skip is visible.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  offline tests — no Chrome at ${CHROME}`); process.exit(3); }

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// ---- server ----------------------------------------------------------------
const appPort = await freePort();
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { srv.kill(); console.error('FAIL  server never came up'); process.exit(1); }
let stopped = false;
const stopServer = () => { if (!stopped) { srv.kill('SIGSTOP'); stopped = true; } };
const resumeServer = () => { if (stopped) { srv.kill('SIGCONT'); stopped = false; } };

// ---- browser ---------------------------------------------------------------
const dbgPort = await freePort();
const profile = join(tmpdir(), `cc-offline-${dbgPort}`);
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try { const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json(); const page = list.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; } } catch {}
  await sleep(250);
}
const cleanup = () => { resumeServer(); try { chrome.kill(); } catch {} try { srv.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {} };
process.on('exit', cleanup);
if (!wsUrl) { console.error('FAIL  Chrome exposed no debugger'); process.exit(1); }

let id = 0; const pending = new Map();
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' :: ' + expression.slice(0, 120));
  return r.result.value;
}
async function until(expr, ms, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(step); } return ev(expr).catch(() => false); }
await send('Page.enable'); await send('Runtime.enable');

const STATE = `({ local: S.local, playing: S.playing, mode: S.mode, n: S.n, names: S.names, kinds: S.kinds, boss: S.boss, code: S.code, connected: S.connected,
  pend: (typeof pendingIntent === 'undefined' || !pendingIntent) ? null : pendingIntent.mode, lw: lobbyWait,
  text: document.getElementById('bay').textContent, wait: !!document.querySelector('#bay .seat.wait'),
  solo: !!document.querySelector('#bay [data-solo]'), home: !!document.querySelector('#bay .lbar'), back: !!document.querySelector('#bay .bk'),
  toasts: window.__toasts || [], waitSeen: !!window.__waitSeen })`;
const state = () => ev(STATE);

// A fresh page: server resumed, page loaded and connected, engine module warm,
// toasts recorded, and a MutationObserver that notices any 'Open slot' seat.
async function fresh() {
  resumeServer();
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  const ready = await until(`typeof intent === 'function' && typeof playSolo === 'function' && !!window.Bay && S.connected === true && !!document.querySelector('#bay .lbar')`, 15000, 150);
  if (!ready) throw new Error('page never became ready (connected, on the bay home)');
  await ev(`import('./room-engine.js').then(() => true)`);
  await ev(`(() => { window.__toasts = []; const t = showToast; window.showToast = (x) => { __toasts.push(x); return t(x); };
    window.__waitSeen = false; new MutationObserver(() => { if (document.querySelector('#bay .seat.wait')) window.__waitSeen = true; }).observe(document.getElementById('bay'), { childList: true, subtree: true }); return true; })()`);
}
// Lose the server. Order matters: close the socket FIRST while the server can
// still answer the closing handshake (a stopped server leaves Chrome waiting on
// it, and onclose never fires), then freeze the server inside the 1.5 s
// reconnect window — the retry then hangs in CONNECTING, as a cold start does.
async function cut({ offline }) {
  await ev(`(() => { ${offline ? "Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });" : ''} S.ws.close(); return true; })()`);
  if (!(await until('S.connected === false', 4000, 25))) throw new Error('socket never reported closed');
  stopServer();
}
const createFrame = (mode) => `{ type: 'create', name: 'T', skin: 'olive', mode: '${mode}', max: ${mode === 'ffa' ? 4 : 2}, tees: 'mens' }`;
async function pendingOffer(mode, waitMs = 1500) {
  await fresh(); await cut({ offline: true });
  await ev(`(intent(${createFrame(mode)}), true)`);
  await sleep(waitMs);
  return state();
}
const NEED = { boss: 'Boss Fight needs a connection', aliens: 'Alien Invasion needs a connection', golf: 'Artillery Golf needs a connection', ffa: 'Free-for-all needs a connection' };

try {
  // ---- 0. the three launch paths and the predicates, online ----------------
  await fresh();
  const r0 = await ev(`(() => {
    window.__sent = []; const orig = intent; window.intent = (m) => { __sent.push(m); };
    const snap = () => __sent.pop();
    ccMode = 'ffa'; ccFfaOpp = 'cpu'; ccMax = 4; $('createBtn').onclick(); const a = snap();
    ccFfaOpp = 'friend'; $('createBtn').onclick(); const b = snap();
    ccMode = 'duel'; ccOpp = 'cpu'; $('createBtn').onclick(); const c = snap();
    ccMode = 'ffa'; ccFfaOpp = 'friend'; $('createBtn').onclick(); const d = snap();   // ccOpp is still 'cpu': must not leak
    ccFfaOpp = 'cpu'; Bay.show('home'); document.querySelector('#bay [data-launch]').click(); const e = snap();
    const btn = document.createElement('button'); btn.dataset.rematch = 'ffa'; btn.dataset.vs = 'friend'; document.getElementById('bay').appendChild(btn);
    btn.click(); const f = snap(); btn.dataset.vs = 'cpu'; btn.click(); const g = snap(); btn.remove();
    const home = (() => { Bay.show('home'); return document.querySelector('#bay .lbar').textContent; })();
    const p = { offBoss: soloOfferable({ type: 'create', mode: 'boss' }), offGolf: soloOfferable({ type: 'create', mode: 'golf' }), offDuel: soloOfferable({ type: 'create', mode: 'duel' }),
      offAi: soloOfferable({ type: 'ai', mode: 'ffa' }), byAi: soloByConstruction({ type: 'ai' }), byCreate: soloByConstruction({ type: 'create', mode: 'golf' }),
      frame: soloFrameFor({ type: 'create', mode: 'ffa', max: 3, name: 'T', skin: 'olive' }), frameBoss: soloFrameFor({ type: 'create', mode: 'boss', max: 2 }) };
    ccMode = 'duel'; ccOpp = 'friend'; ccFfaOpp = 'friend'; window.intent = orig;
    return { a, b, c, d, e, f, g, p, home };
  })()`);
  const isAiFfa = (m) => m && m.type === 'ai' && m.mode === 'ffa' && m.max === 4 && typeof m.difficulty === 'string' && typeof m.name === 'string' && typeof m.skin === 'string';
  if (isAiFfa(r0.a)) ok('0: Launch with FFA + Computer sends the ai frame with mode and max'); else fail('0: ffa+cpu frame was ' + JSON.stringify(r0.a));
  if (r0.b && r0.b.type === 'create' && r0.b.mode === 'ffa' && r0.b.max === 4) ok('0: FFA + Friends sends a create, as before'); else fail('0: ffa+friend frame was ' + JSON.stringify(r0.b));
  if (r0.c && r0.c.type === 'ai' && !('mode' in r0.c) && !('max' in r0.c)) ok('0: Duel + Computer sends the historical ai frame, no mode or max keys'); else fail('0: duel+cpu frame was ' + JSON.stringify(r0.c));
  if (r0.d && r0.d.type === 'create') ok("0: a Duel 'Computer' choice does not leak into a Free-for-all Launch"); else fail('0: leak — ' + JSON.stringify(r0.d));
  if (isAiFfa(r0.e)) ok("0: the bay's Launch button reaches the same predicate"); else fail('0: bay launch frame was ' + JSON.stringify(r0.e));
  if (r0.f && r0.f.type === 'create' && isAiFfa(r0.g)) ok('0: a sortie rematch chip restores who it was against (friend -> create, Computer -> ai)'); else fail(`0: rematch frames were ${JSON.stringify(r0.f)} / ${JSON.stringify(r0.g)}`);
  if (/You \+ 3 CPU/.test(r0.home)) ok("0: with Computer picked the home launch bar says 'You + 3 CPU'"); else fail('0: home launch bar read: ' + r0.home.slice(0, 80));
  const p = r0.p;
  if (p.offBoss && p.offGolf && !p.offDuel && !p.offAi && p.byAi && !p.byCreate) ok('0: soloOfferable is the four invite-room modes on a create; soloByConstruction is exactly an ai frame');
  else fail('0: predicates were ' + JSON.stringify(p));
  if (p.frame.type === 'ai' && p.frame.mode === 'ffa' && p.frame.max === 3 && p.frameBoss.type === 'create') ok('0: soloFrameFor swaps an ffa create for the ai frame and leaves the others alone'); else fail('0: soloFrameFor gave ' + JSON.stringify([p.frame, p.frameBoss]));

  // ---- 1. an invite room never converts while offline -----------------------
  for (const mode of ['boss', 'aliens', 'golf', 'ffa']) {
    const s = await pendingOffer(mode, mode === 'boss' ? 5200 : 1500);   // boss waits out the old 4 s timer
    if (!s.local && !s.playing && s.pend === mode) ok(`1: ${mode} offline — nothing started, the create is queued`);
    else fail(`1: ${mode} offline — local=${s.local} playing=${s.playing} pend=${s.pend}`);
    if (s.solo && s.text.includes(NEED[mode]) && s.text.includes('No connection') && s.lw === 'offline') ok(`1: ${mode} offline — the lobby explains and offers Play solo`);
    else fail(`1: ${mode} offline — solo=${s.solo} lw=${s.lw} text=${s.text.slice(0, 120)}`);
    if (!s.wait && !s.waitSeen) ok(`1: ${mode} offline — no 'Open slot' seat, nobody is being waited for`); else fail(`1: ${mode} offline — an Open slot was rendered`);
  }

  // ---- 2. a vs-Computer tap starts at once while offline (regression guard) --
  await fresh(); await cut({ offline: true });
  await ev(`(intent({ type: 'ai', difficulty: 'easy', name: 'T', skin: 'olive' }), true)`);
  if (await until(`S.local === true && S.playing === true && S.mode === 'duel'`, 4000)) ok('2: Duel vs Computer starts locally at once when offline'); else fail('2: duel vs computer did not start locally: ' + JSON.stringify(await state()));
  await fresh(); await cut({ offline: true });
  await ev(`(intent({ type: 'ai', mode: 'ffa', max: 4, difficulty: 'easy', name: 'T', skin: 'olive' }), true)`);
  if (await until(`S.local === true && S.playing === true && S.mode === 'ffa' && S.n === 4 && S.names.slice(1).every((n) => /^CPU \\d$/.test(n))`, 4000)) ok('2: Free-for-all vs Computer starts locally at once when offline, three CPUs seated');
  else fail('2: ffa vs computer did not start locally: ' + JSON.stringify(await state()));

  // ---- 3. server unreachable: grace, then an offer, then the real room ------
  await fresh(); await cut({ offline: false });
  await ev(`(intent(${createFrame('boss')}), true)`);
  await sleep(1000);
  let s = await state();
  if (s.text.includes('Reaching the server') && !s.solo && !s.local && s.lw === 'connecting') ok("3: during the grace the lobby says 'Reaching the server' with no offer yet"); else fail('3: at 1 s — ' + JSON.stringify({ solo: s.solo, lw: s.lw, local: s.local, text: s.text.slice(0, 100) }));
  await sleep(4200);
  s = await state();
  if (s.solo && s.text.includes('Cannot reach the server') && !s.local && !s.playing && s.lw === 'unreachable') ok('3: after 4 s it offers Play solo and has started nothing'); else fail('3: at 5 s — ' + JSON.stringify({ solo: s.solo, lw: s.lw, local: s.local, playing: s.playing, text: s.text.slice(0, 100) }));
  resumeServer();
  if (await until(`S.connected === true && /^[A-Z0-9]{4}$/.test(S.code || '') && lobbyWait === null && document.getElementById('bay').textContent.includes(S.code)`, 10000)) ok('3: when the server answers, the queued create becomes a real room with a code (queue-and-tell kept)');
  else fail('3: the queued create never became a real room: ' + JSON.stringify(await state()));
  s = await state();
  if (!s.local && !s.solo) ok('3: the real room is not a local one and the offer is gone'); else fail('3: after flush local=' + s.local + ' solo=' + s.solo);

  // ---- 4. Play solo is one tap, for every mode ------------------------------
  for (const mode of ['boss', 'aliens', 'golf', 'ffa']) {
    await pendingOffer(mode);
    await ev(`(document.querySelector('#bay [data-solo]').click(), true)`);
    const started = await until(`S.local === true && S.playing === true`, 6000);
    s = await state();
    const shape = mode === 'boss' ? (s.mode === 'boss' && s.boss >= 0 && s.n === 2)
      : mode === 'aliens' ? (s.mode === 'aliens' && s.n === 4 && (s.kinds || []).some((k) => k !== 'tank'))
      : mode === 'golf' ? (s.mode === 'golf' && s.n === 1)
      : (s.mode === 'ffa' && s.n === 4 && (s.names || []).slice(1).every((n) => /^CPU \d$/.test(n)));
    if (started && shape) ok(`4: ${mode} — Play solo starts the match with one tap (${s.n} seat(s))`); else fail(`4: ${mode} — started=${started} ${JSON.stringify({ mode: s.mode, n: s.n, boss: s.boss, kinds: s.kinds, names: s.names })}`);
    if (!s.waitSeen) ok(`4: ${mode} — no 'Open slot' was ever written to the DOM`); else fail(`4: ${mode} — an Open slot seat appeared on the way in`);
    if (s.pend === null && s.lw === null) ok(`4: ${mode} — the queued create is consumed, nothing left to flush`); else fail(`4: ${mode} — pend=${s.pend} lw=${s.lw}`);
    if (s.toasts.includes('Playing offline')) ok(`4: ${mode} — the player is told it is offline play`); else fail(`4: ${mode} — toasts were ${JSON.stringify(s.toasts)}`);
  }

  // ---- 5. Cancel drops the queued create, and a later reconnect flushes nothing
  await pendingOffer('boss');
  await ev(`(document.querySelector('#bay [data-old="cancelBtn"]').click(), true)`);
  s = await state();
  if (s.pend === null && s.lw === null && s.home && !s.local) ok('5: Cancel clears the queued create and returns home'); else fail('5: after cancel — ' + JSON.stringify({ pend: s.pend, lw: s.lw, home: s.home, local: s.local }));
  resumeServer();
  await until('S.connected === true', 8000);
  await sleep(2500);
  s = await state();
  if (s.home && !s.solo && s.code === null) ok('5: after the server returns, no room appears — the cancelled create was really dropped'); else fail('5: after reconnect — ' + JSON.stringify({ home: s.home, solo: s.solo, code: s.code }));

  // ---- 6. the header's Back arrow IS Cancel on the lobby ----------------------
  await pendingOffer('boss');
  s = await state();
  if (s.back) ok('6: the pending lobby still has a Back arrow (chrome renders it on every screen)'); else fail('6: no Back arrow found — the test cannot prove the route');
  await ev(`(document.querySelector('#bay .bk').click(), true)`);
  s = await state();
  if (s.pend === null && s.lw === null && s.home) ok('6: Back from the offline offer clears the queued create and goes home'); else fail('6: after back — ' + JSON.stringify({ pend: s.pend, lw: s.lw, home: s.home }));
  await sleep(5200);
  s = await state();
  if (s.home && !s.solo) ok('6: five seconds later the bay is still home — no grace timer yanked it back'); else fail('6: the bay was pulled back: ' + JSON.stringify({ home: s.home, solo: s.solo }));
  // The unreachable variant: Back while the offer is up, then the server returns.
  await fresh(); await cut({ offline: false });
  await ev(`(intent(${createFrame('aliens')}), true)`);
  await sleep(5000);
  await ev(`(document.querySelector('#bay .bk').click(), true)`);
  resumeServer();
  await until('S.connected === true', 8000);
  await sleep(2500);
  s = await state();
  if (s.home && s.code === null && !s.solo) ok('6: Back from the unreachable offer, then the server returns — nothing flushes, still home'); else fail('6: unreachable+back — ' + JSON.stringify({ home: s.home, code: s.code, solo: s.solo }));

  // ---- 7. a refusal while the pending lobby is up is said out loud ------------
  await fresh();
  const r7 = await ev(`(() => { showLobby('connecting'); handle({ type: 'joinError', reason: 'The server is at capacity. Try again shortly.' });
    return { home: !!document.querySelector('#bay .lbar'), toast: __toasts.includes('The server is at capacity. Try again shortly.'), lw: lobbyWait }; })()`);
  if (r7.home && r7.toast && r7.lw === null) ok("7: a joinError while pending toasts the reason and returns home (no spinner forever)"); else fail('7: ' + JSON.stringify(r7));

  // ---- 8. the socket dies after the create flushed, before 'created' ---------
  await fresh();
  const r8 = await ev(`(() => { showLobby('connecting'); pendingIntent = null; S.ws.onclose();
    return { home: !!document.querySelector('#bay .lbar'), toast: __toasts.some((t) => /Connection dropped/.test(t)), lw: lobbyWait }; })()`);
  if (r8.home && r8.toast && r8.lw === null) ok('8: a drop after the flush says so and returns home instead of spinning'); else fail('8: ' + JSON.stringify(r8));
  const r8b = await ev(`(() => { __toasts.length = 0; showLobby('offline'); pendingIntent = { type: 'create', mode: 'boss' }; S.ws.onclose();
    const r = { lw: lobbyWait, toast: __toasts.length }; $('cancelBtn').onclick(); return r; })()`);
  if (r8b.lw === 'offline' && r8b.toast === 0) ok('8: while the create is still queued the same close is inert (the retry loop owns it)'); else fail('8: inert case — ' + JSON.stringify(r8b));

  // ---- 9. a double tap on Play solo boots exactly one match ------------------
  await pendingOffer('boss');
  await ev(`(() => { const b = document.querySelector('#bay [data-solo]'); b.click(); b.click(); return true; })()`);
  await until('S.playing === true', 6000);
  const rooms = await ev('engineMod && engineMod.rooms ? engineMod.rooms.size : -1');
  if (rooms === 1) ok('9: two taps, one room'); else fail(`9: engine rooms after a double tap: ${rooms}`);

  // ---- 10. a solo room never touches the online resume record (last: storage persists)
  await fresh();
  await ev(`(localStorage.setItem('cc_resume', JSON.stringify({ code: 'ZZZZ', token: 't' })), true)`);
  await cut({ offline: true });
  await ev(`(intent(${createFrame('boss')}), true)`);
  await sleep(800);
  await ev(`(document.querySelector('#bay [data-solo]').click(), true)`);
  await until('S.playing === true', 6000);
  const kept = await ev(`localStorage.getItem('cc_resume')`);
  if (kept === JSON.stringify({ code: 'ZZZZ', token: 't' })) ok('10: a solo start leaves cc_resume exactly as it was'); else fail('10: cc_resume became ' + kept);
  await ev(`(localStorage.removeItem('cc_resume'), true)`);
  if ((await ev(`localStorage.getItem('cc_resume')`)) === null) ok('10: the planted record is removed again'); else fail('10: could not clean cc_resume');
} catch (e) {
  fail('harness: ' + e.message);
}

cleanup();
console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
