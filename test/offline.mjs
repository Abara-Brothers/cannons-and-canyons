// Offline play in the REAL page (items 2 + B + A's client half): the pending
// lobby, Play solo, Cancel, the header's Back arrow, and the two launch paths
// — driven over CDP against the real app.js / bay.js / room-engine.js.
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

// EVERY CDP CALL HAS A DEADLINE, AND SO DOES THE WHOLE RUN (fix wave A4). This
// suite runs in the pre-push hook: a Chrome or a server that stops answering
// must fail it loudly, never hang the push. And every way out -- the end, a
// throw, a signal, the watchdog -- takes Chrome and the server with it,
// registered before either is spawned. SIGKILL, because a stopped process
// ignores SIGTERM until it is continued: this suite freezes its own server on
// purpose, and a frozen Chrome is the hang this exists for.
const CDP_MS = 15000;                                           // one call
const RUN_MS = 180000;                                          // the whole suite
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
let srv = null, chrome = null, profile = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { profile && rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog = setTimeout(() => { console.error(`FAIL  offline overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

// ---- server ----------------------------------------------------------------
const appPort = await freePort();
srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { console.error('FAIL  server never came up'); process.exit(1); }
let stopped = false;
const stopServer = () => { if (!stopped) { srv.kill('SIGSTOP'); stopped = true; } };
const resumeServer = () => { if (stopped) { srv.kill('SIGCONT'); stopped = false; } };

// ---- browser ---------------------------------------------------------------
const dbgPort = await freePort();
profile = join(tmpdir(), `cc-offline-${dbgPort}`);
rmSync(profile, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try { const list = await (await get(`http://127.0.0.1:${dbgPort}/json/list`)).json(); const page = list.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; } } catch {}
  await sleep(250);
}
if (!wsUrl) { console.error('FAIL  Chrome exposed no debugger'); process.exit(1); }

let id = 0; const pending = new Map();
const ws = new WebSocket(wsUrl);
await Promise.race([new Promise((r) => { ws.onopen = r; }), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  const t = setTimeout(() => { pending.delete(i); reject(new Error(`CDP ${method} gave no answer in ${CDP_MS} ms`)); }, CDP_MS);
  pending.set(i, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' :: ' + expression.slice(0, 120));
  return r.result.value;
}
async function until(expr, ms, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(step); } return ev(expr).catch(() => false); }
await send('Page.enable'); await send('Runtime.enable');
// The cold-start intro (public/intro.js) is off for this suite: it covers the bay
// with a pointer-catching canvas for six seconds on a fresh load. test/intro.mjs
// owns it. Scripts for new documents only run while the Page domain is enabled.
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__ccNoIntro = true;' });

const STATE = `({ local: S.local, playing: S.playing, mode: S.mode, n: S.n, names: S.names, kinds: S.kinds, boss: S.boss, code: S.code, connected: S.connected,
  pend: (typeof pendingIntent === 'undefined' || !pendingIntent) ? null : pendingIntent.mode, lw: lobbyWait,
  text: document.getElementById('bay').textContent, wait: !!document.querySelector('#bay .seat.wait'),
  solo: !!document.querySelector('#bay [data-solo]'), soloLabel: (document.querySelector('#bay [data-solo]') || { textContent: null }).textContent, home: !!document.querySelector('#bay .lbar'), back: !!document.querySelector('#bay .bk'),
  toasts: window.__toasts || [], waitSeen: !!window.__waitSeen, meta: (document.querySelector('#bay .pm') || { textContent: null }).textContent })`;
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
const NEED = { duel: 'Duel needs a connection', boss: 'Boss Fight needs a connection', aliens: 'Alien Invasion needs a connection', golf: 'Artillery Golf needs a connection', ffa: 'Free-for-all needs a connection' };
const LABEL = { duel: 'Play vs Computer', ffa: 'Play vs Computer', boss: 'Play solo', aliens: 'Play solo', golf: 'Play solo' };

try {
  // ---- 0. Match setup's Start Game and the predicates, online ---------------
  // START GAME IS THE MATCH (owner, 2026-10-06): no Armoury step, no friend
  // room, no opponent remembered. Each mode is launched the way a player does
  // it -- home's Launch, then Start Game -- with intent() recording instead of
  // sending, and every screen the bay drew on the way is read off #bay's own
  // data-scr records, so an Armoury visit cannot hide.
  await fresh();
  const r0 = await ev(`(() => {
    window.__sent = []; const orig = intent; window.intent = (m) => { __sent.push(m); };
    const bay = $('bay'), ob = new MutationObserver(() => {});
    ob.observe(bay, { attributes: true, attributeFilter: ['data-scr'], attributeOldValue: true });
    const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; };
    const start = (mode, before) => {
      ccMode = mode; Bay.show('home');
      const readout = txt('#bay .lbar .ros');
      ob.takeRecords();
      document.querySelector('#bay .launch').click();
      if (before) before();
      const o = { readout, at: bay.dataset.scr, meta: txt('#bay .pm'), label: txt('#bay .pfoot [data-launch]'),
        play: [...document.querySelectorAll('#bay .b-opt')].filter((x) => x.querySelector('.lbl') && x.querySelector('.lbl').textContent === 'Play with')
          .map((x) => [...x.querySelectorAll('.seg')].map((b) => b.firstChild.textContent.trim() + (b.disabled ? '(off:' + (b.querySelector('.b-why') || {}).textContent + ')' : '') + (b.classList.contains('on') ? '*' : '')).join('|')).join(),
        groups: [...document.querySelectorAll('#bay .b-opt:not(.hidden) .lbl')].map((l) => l.textContent).join('|'),
        sets: [...document.querySelectorAll('#bay [data-set]')].map((b) => b.dataset.set.split('=')[0]).filter((k, i, a) => a.indexOf(k) === i).join('|'),
        friend: /friend|by code/i.test(bay.textContent),
        why: (() => { const w = document.querySelector('#bay .seg .b-why'); if (!w) return null; const uPx = document.querySelector('#bay .stage').getBoundingClientRect().width / 932;
          return { fs: +(parseFloat(getComputedStyle(w).fontSize) / uPx).toFixed(1), cut: w.scrollWidth > w.clientWidth + 1 || w.parentElement.scrollWidth > w.parentElement.clientWidth + 1 }; })() };
      soloRoom = false;
      document.querySelector('#bay .pfoot [data-launch]').click();
      o.seen = ob.takeRecords().map((r) => r.oldValue).concat(bay.dataset.scr);
      o.f = __sent.pop(); o.extra = __sent.length; o.solo = soloRoom; soloRoom = false;
      return o;
    };
    const duel = start('duel'), ffa = start('ffa'), ffa2 = start('ffa', () => document.querySelector('#bay [data-set="count=3"]').click());
    ccMax = 4;
    const boss = start('boss'), aliens = start('aliens'), golf = start('golf');
    Bay.show('modes'); const modesMeta = txt('#bay .pm');
    ob.disconnect(); Bay.show('home');
    const p = { offBoss: soloOfferable({ type: 'create', mode: 'boss' }), offGolf: soloOfferable({ type: 'create', mode: 'golf' }), offDuel: soloOfferable({ type: 'create', mode: 'duel' }),
      offAi: soloOfferable({ type: 'ai', mode: 'ffa' }), byAi: soloByConstruction({ type: 'ai' }), byCreate: soloByConstruction({ type: 'create', mode: 'golf' }),
      frame: soloFrameFor({ type: 'create', mode: 'ffa', max: 3, name: 'T', skin: 'olive' }), frameBoss: soloFrameFor({ type: 'create', mode: 'boss', max: 2 }),
      frameDuel: soloFrameFor({ type: 'create', mode: 'duel', max: 2, name: 'T', skin: 'olive' }) };
    ccMode = 'duel'; window.intent = orig;
    return { duel, ffa, ffa2, boss, aliens, golf, modesMeta, p };
  })()`);
  const isAiFfa = (m, max) => m && m.type === 'ai' && m.mode === 'ffa' && m.max === max && typeof m.difficulty === 'string' && typeof m.name === 'string' && typeof m.skin === 'string';
  const isSolo = (m, mode) => m && m.type === 'create' && m.mode === mode && m.max === 1 && typeof m.tees === 'string' && typeof m.name === 'string';
  const R0 = [['duel', r0.duel], ['ffa', r0.ffa], ['ffa2', r0.ffa2], ['boss', r0.boss], ['aliens', r0.aliens], ['golf', r0.golf]];
  if (R0.every(([, o]) => o.at === 'setup' && o.meta === 'Step 2 of 2' && /^Start Game$/i.test(o.label || '') && o.extra === 0 && o.seen.every((x) => x === 'setup' || x === 'home') && o.seen[o.seen.length - 1] === 'setup'))
    ok("0: in every mode home's Launch opens Match setup (Step 2 of 2), and its Start Game sends one frame without the bay ever drawing the Armoury");
  else fail('0: start paths ' + JSON.stringify(R0.map(([k, o]) => [k, o.at, o.meta, o.label, o.extra, o.seen])));
  if (r0.duel.f && r0.duel.f.type === 'ai' && !('mode' in r0.duel.f) && !('max' in r0.duel.f) && r0.duel.solo === false) ok('0: Duel + Computer sends the historical ai frame, no mode or max keys'); else fail('0: duel frame was ' + JSON.stringify(r0.duel.f));
  if (isAiFfa(r0.ffa.f, 4) && isAiFfa(r0.ffa2.f, 3)) ok('0: Free-for-all + Computer sends the ai frame with its mode and the CPU count (3 CPUs: max 4; 2 CPUs: max 3)'); else fail('0: ffa frames were ' + JSON.stringify([r0.ffa.f, r0.ffa2.f]));
  if (isSolo(r0.boss.f, 'boss') && isSolo(r0.aliens.f, 'aliens') && isSolo(r0.golf.f, 'golf') && r0.boss.solo && r0.aliens.solo && r0.golf.solo)
    ok('0: Boss Fight, Alien Invasion and golf send a Solo create, one seat asked for, marked as a room for one (soloRoom)');
  else fail('0: solo frames were ' + JSON.stringify([r0.boss, r0.aliens, r0.golf].map((o) => [o.f, o.solo])));
  if (/Players\s*You vs CPU/.test(r0.duel.readout) && /Players\s*You \+ 3 CPU/.test(r0.ffa.readout) && [r0.boss, r0.aliens, r0.golf].every((o) => /Players\s*Solo/.test(o.readout)))
    ok("0: home's Players readout says what Launch will do: You vs CPU, You + 3 CPU, Solo");
  else fail('0: readouts ' + JSON.stringify(R0.map(([k, o]) => [k, o.readout])));
  const OFF = '(off:Needs a squad of 2 or more)';
  if (r0.duel.play === 'Computer*|Your squad' + OFF && r0.ffa.play === 'Computer*|Your squad' + OFF
      && [r0.boss, r0.aliens, r0.golf].every((o) => o.play === 'Solo*|Your squad' + OFF))
    ok('0: Play with is Computer or Your squad for Duel and Free-for-all, Solo or Your squad for the rest; with no squad, Computer/Solo is on and Your squad is greyed out with its reason');
  else fail('0: play with ' + JSON.stringify(R0.map(([k, o]) => [k, o.play])));
  if (R0.every(([, o]) => !o.friend && !/opp|ffaOpp|gcount/.test(o.sets)) && r0.golf.groups === 'Play with|Tee set' && !/Players/.test(r0.golf.groups)
      && r0.duel.groups === 'Play with|Difficulty' && r0.ffa.groups === 'Play with|CPU commanders|Difficulty' && r0.boss.groups === 'Play with')
    ok('0: Friend by code is gone from every mode, golf has its Tee set and no Players picker, and Computer keeps the CPU count and Difficulty');
  else fail('0: setup groups ' + JSON.stringify(R0.map(([k, o]) => [k, o.groups, o.sets, o.friend])));
  if (r0.modesMeta === 'Step 1 of 2') ok('0: the Mission board is step 1 of 2'); else fail('0: mission meta ' + r0.modesMeta);
  if (R0.every(([, o]) => o.why && o.why.fs >= 12 && !o.why.cut)) ok(`0: Your squad's reason is legible on a phone: ${r0.duel.why.fs}u, never cut off`);
  else fail('0: reason legibility ' + JSON.stringify(R0.map(([k, o]) => [k, o.why])));
  // The offline badges: one per board, derived from the same predicates, so
  // what a board says and what a tap does can only ever agree.
  const badges = await ev(`(() => { Bay.show('home'); const home = [...document.querySelectorAll('#bay .board .bof')].map((e) => e.textContent);
    Bay.show('modes'); const modes = [...document.querySelectorAll('#bay .mb .bof')].map((e) => e.textContent); Bay.show('home');
    const kinds = ['duel', 'ffa', 'boss', 'aliens', 'golf'].map(offlineKind); return { home, modes, kinds }; })()`);
  const WANT = ['Offline vs CPU', 'Offline vs CPU', 'Offline solo', 'Offline solo', 'Offline solo'];
  if (badges.home.length === 0) ok('0: the home boards carry no offline badge (owner, 2026-09-18)'); else fail('0: home badges were ' + JSON.stringify(badges.home));
  if (JSON.stringify(badges.modes) === JSON.stringify(WANT)) ok('0: every Mission board card carries the same badge'); else fail('0: mission badges were ' + JSON.stringify(badges.modes));
  if (JSON.stringify(badges.kinds) === JSON.stringify(['cpu', 'cpu', 'solo', 'solo', 'solo'])) ok('0: offlineKind derives cpu/cpu/solo/solo/solo from the predicates'); else fail('0: offlineKind gave ' + JSON.stringify(badges.kinds));
  const p = r0.p;
  if (p.offBoss && p.offGolf && p.offDuel && !p.offAi && p.byAi && !p.byCreate) ok('0: soloOfferable is the five invite-room modes on a create (Duel joined 2026-09-18); soloByConstruction is exactly an ai frame');
  else fail('0: predicates were ' + JSON.stringify(p));
  const fd = p.frameDuel;
  if (fd && fd.type === 'ai' && !('mode' in fd) && !('max' in fd) && typeof fd.difficulty === 'string' && fd.name === 'T' && fd.skin === 'olive') ok("0: soloFrameFor swaps a Duel create for the historical ai frame — no mode, no max");
  else fail('0: duel solo frame was ' + JSON.stringify(fd));
  if (p.frame.type === 'ai' && p.frame.mode === 'ffa' && p.frame.max === 3 && p.frameBoss.type === 'create') ok('0: soloFrameFor swaps an ffa create for the ai frame and leaves the others alone'); else fail('0: soloFrameFor gave ' + JSON.stringify([p.frame, p.frameBoss]));

  // ---- 0b. the Armoury is a side trip, and a short rack never stops a match --
  // Reached only by Edit in Match setup and by the Bay stations row, its button
  // is Done and goes back where it came from; it never launches. A rack short
  // of the mode's draft is filled with standard weapons at Start Game and saved
  // as the player's (owner, 2026-10-06). A FRESH page, so the Armoury's working
  // copy starts from storage: the first check reads it before any fill.
  await fresh();
  const r0b = await ev(`(async () => {
    const gc = await import('./game-core.js');
    window.__sent = []; const orig = intent; window.intent = (m) => { __sent.push(m); };
    const bay = $('bay'), txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; };
    const stored = () => JSON.parse(localStorage.getItem('cc_loadout') || 'null');
    const put = (v) => (v === null ? localStorage.removeItem('cc_loadout') : localStorage.setItem('cc_loadout', JSON.stringify(v)));
    const armoury = () => ({ scr: bay.dataset.scr, meta: txt('#bay .pm'), hint: txt('#bay .pfoot .hint'), full: document.querySelectorAll('#bay .card .slots .slot.f').length,
      foot: [...document.querySelectorAll('#bay .pfoot button')].map((b) => ({ t: b.textContent.trim(), back: b.hasAttribute('data-back'), dis: b.disabled })),
      launch: !!document.querySelector('#bay [data-launch]') });
    const startIn = (mode) => { ccMode = mode; Bay.show('home'); document.querySelector('#bay .launch').click(); document.querySelector('#bay .pfoot [data-launch]').click(); return __sent.pop(); };
    const o = {};
    // THE WORKING COPY FOLLOWS THE FILL: one pick stored, the Armoury opened
    // and left, Start Game, then the Armoury again shows the filled rack, and a
    // toggle there stores the filled rack less that pick -- not the short one.
    put(['mortar']); ccMode = 'duel'; Bay.show('home'); document.querySelector('#bay .launch').click();
    o.setupShort = txt('#bay .pfoot .hint');
    document.querySelector('#bay .card [data-go="armoury"]').click();
    o.short = armoury();
    document.querySelector('#bay .pfoot [data-back]').click(); o.back = bay.dataset.scr;
    document.querySelector('#bay .pfoot [data-launch]').click(); __sent.pop();
    document.querySelector('#bay .card [data-go="armoury"]').click();
    o.filled = armoury();
    document.querySelector('#bay [data-pick="volley"]').click(); o.toggled = stored();
    // Each short rack, filled: the player's picks first, then the standard
    // draft, then the pool; never a pick twice; golf left alone.
    const fill = (mode, v) => { put(v); startIn(mode); const r = stored(); return { r, valid: r && mode !== 'golf' ? gc.validLoadout(r, gc.loadoutSizeFor(mode)) : null }; };
    o.duel1 = fill('duel', ['mortar']);
    o.boss1 = fill('boss', ['mortar']);
    o.none = fill('duel', null);
    o.seven = fill('duel', ['wall', 'teleport', 'minigun', 'gas', 'buster', 'mortar', 'volley']);
    o.dup = fill('duel', ['gas', 'gas', 'minigun']);
    o.dupFull = fill('duel', ['gas', 'gas', 'minigun', 'mortar', 'cluster', 'napalm']);
    o.golf = fill('golf', ['mortar']);
    // The Bay stations row's Armoury, and golf's bag behind the same door: Done
    // goes home, and neither offers a launch.
    put(['mortar', 'cluster', 'napalm', 'airstrike', 'volley']);
    ccMode = 'duel'; Bay.show('home'); document.querySelector('#bay .st[data-go="armoury"]').click();
    o.station = armoury(); document.querySelector('#bay .pfoot [data-back]').click(); o.stationBack = bay.dataset.scr;
    ccMode = 'golf'; Bay.show('home'); document.querySelector('#bay .st[data-go="armoury"]').click();
    o.bag = armoury(); document.querySelector('#bay .pfoot [data-back]').click(); o.bagBack = bay.dataset.scr;
    o.sent = __sent.length;
    ccMode = 'duel'; window.intent = orig; Bay.show('home');
    return o;
  })()`);
  const DONE = [{ t: 'Done', back: true, dis: false }];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (r0b.short.scr === 'armoury' && r0b.short.meta === 'Your rack' && r0b.short.full === 1 && eq(r0b.short.foot, DONE) && !r0b.short.launch && r0b.back === 'setup'
      && /Empty slots are filled with standard weapons/i.test(r0b.setupShort || '') && /Empty slots are filled with standard weapons/i.test(r0b.short.hint || '')
      && /Railgun only drops in crates/.test(r0b.filled.hint || ''))
    ok("0b: Edit opens the Armoury (Your rack), whose only button is Done -- live on a short rack, never a launch -- and Done goes back to Match setup; both say a short rack's empty slots are filled");
  else fail('0b: armoury from setup ' + JSON.stringify({ short: r0b.short, back: r0b.back, hint: r0b.setupShort, filled: r0b.filled.hint }));
  if (r0b.filled.full === 5 && eq(r0b.toggled, ['mortar', 'cluster', 'napalm', 'airstrike']))
    ok("0b: after Start Game fills the rack, the Armoury shows it full and edits the filled rack, never the short one");
  else fail('0b: working copy ' + JSON.stringify({ filled: r0b.filled, toggled: r0b.toggled }));
  if (eq(r0b.duel1.r, ['mortar', 'cluster', 'napalm', 'airstrike', 'volley']) && r0b.duel1.valid
      && eq(r0b.boss1.r, ['mortar', 'cluster', 'napalm', 'airstrike', 'volley', 'gas', 'buster']) && r0b.boss1.valid
      && eq(r0b.none.r, ['mortar', 'cluster', 'napalm', 'airstrike', 'volley']) && r0b.none.valid
      && eq(r0b.dup.r, ['gas', 'minigun', 'mortar', 'cluster', 'napalm']) && r0b.dup.valid)
    ok('0b: a short rack is filled and saved -- the picks, then the standard draft, then the pool -- a valid rack every time, a repeat counted once, nothing stored filled with the standard draft');
  else fail('0b: fills ' + JSON.stringify([r0b.duel1, r0b.boss1, r0b.none, r0b.dup]));
  if (eq(r0b.seven.r, ['wall', 'teleport', 'minigun', 'gas', 'buster', 'mortar', 'volley']) && eq(r0b.golf.r, ['mortar']))
    ok('0b: a rack already full for the mode is left exactly as stored, and golf, which drafts nothing, touches no rack');
  else fail('0b: untouched racks ' + JSON.stringify([r0b.seven, r0b.golf]));
  if (eq(r0b.dupFull.r, ['gas', 'minigun', 'mortar', 'cluster', 'napalm']) && r0b.dupFull.valid)
    ok('0b: a stored rack with a repeat is saved without it, so the match never submits a rack the server refuses');
  else fail('0b: stored repeat ' + JSON.stringify(r0b.dupFull));
  if (r0b.station.scr === 'armoury' && eq(r0b.station.foot, DONE) && !r0b.station.launch && r0b.stationBack === 'home'
      && r0b.bag.scr === 'armoury' && r0b.bag.meta === 'No draft' && eq(r0b.bag.foot, DONE) && !r0b.bag.launch && r0b.bagBack === 'home' && r0b.sent === 0)
    ok("0b: from the Bay stations row the Armoury and golf's bag both offer Done, which goes home, and neither starts anything");
  else fail('0b: from home ' + JSON.stringify({ station: r0b.station, back: r0b.stationBack, bag: r0b.bag, bagBack: r0b.bagBack, sent: r0b.sent }));

  // ---- 0s. a room for one, and the rooms that are not ----------------------
  // Driven through app.js's own handle() with sendMsg recording. A Solo
  // create's room is started by this page once its lobby frame lands -- only a
  // room it hosts with a seat past its own -- and drawn as a run for one; a
  // room somebody else made (an older build's ?room= link) is drawn Standing
  // by, with no code to share and no Armoury door. A 'created' never wears the
  // previous room's payload. The legacy rack's button names what it starts.
  await fresh();
  const r0s = await ev(`(() => {
    const sent = [], orig = sendMsg; window.sendMsg = (m) => { sent.push(m.type); };
    const bay = $('bay'), txt = () => bay.textContent.replace(/\\s+/g, ' ');
    const lob = (o) => Object.assign({ type: 'lobby', code: 'QQQQ', mode: 'boss', max: 2, you: 0, host: 0, players: [{ name: 'T' }, null] }, o);
    const look = () => ({ title: (document.querySelector('#bay .pt') || {}).textContent, meta: (document.querySelector('#bay .pm') || {}).textContent,
      code: /Share this code|Copy code|Copy link|QQQQ|ZZZZ/.test(txt()), door: !!document.querySelector('#bay [data-go="armoury"]'),
      start: !!document.querySelector('#bay .pfoot [data-old="startMatchBtn"]:not(.hidden)'), wait: !!document.querySelector('#bay .seat.wait'), text: txt().slice(0, 300) });
    const run = (solo, o) => { sent.length = 0; soloRoom = solo; handle(lob(o)); return Object.assign({ starts: sent.filter((t) => t === 'startMatch').length }, look()); };
    const out = {};
    ccMode = 'boss';
    out.mine = run(true);
    out.notSolo = run(false);
    out.notHost = run(true, { mode: 'ffa', max: 4, you: 1, players: [{ name: 'H' }, { name: 'T' }, null, null] });
    out.oneSeat = run(true, { mode: 'golf', max: 1, players: [{ name: 'T' }] });
    // A 'created' for a Solo raid, landing while the bay still holds the joined
    // room's payload (mode ffa, somebody else the host).
    handle(lob({ mode: 'ffa', max: 4, you: 1, players: [{ name: 'H' }, { name: 'T' }, null, null] }));
    soloRoom = true; handle({ type: 'created', code: 'ZZZZ', mode: 'boss', max: 2 });
    out.created = look();
    soloRoom = true; handle({ type: 'joinError', reason: 'The server is at capacity. Try again shortly.' }); out.afterRefusal = soloRoom;
    soloRoom = true; $('cancelBtn').onclick(); out.afterCancel = soloRoom;
    window.sendMsg = orig;
    const legacy = (mode) => { ccMode = mode; syncCreateRow(); return [$('createBtn').textContent, $('diffWrap').classList.contains('hidden')]; };
    out.legacy = { duel: legacy('duel'), ffa: legacy('ffa'), boss: legacy('boss'), golf: legacy('golf') };
    ccMode = 'duel'; syncCreateRow(); soloRoom = false;
    return out;
  })()`);
  if (r0s.mine.starts === 1 && r0s.mine.title === 'Deploying' && r0s.mine.meta === 'Solo run' && !r0s.mine.wait && !r0s.mine.code && /Players\s*1\s*Paint/.test(r0s.mine.text)
      && r0s.oneSeat.starts === 0 && r0s.oneSeat.title === 'Teeing off')
    ok("0s: a Solo create's raid room is started by this page the moment its lobby lands, drawn as Deploying (Solo run) with no open seat; a one-seat golf room, which the server starts, is not sent a second start");
  else fail('0s: solo rooms ' + JSON.stringify({ mine: r0s.mine, oneSeat: r0s.oneSeat }));
  if (r0s.notHost.starts === 0 && r0s.notHost.title === 'Standing by' && r0s.notHost.meta === 'Friend room' && /Joined\s*STAND BY\s*Waiting for the host to start the battle/.test(r0s.notHost.text)
      && !r0s.notHost.code && !r0s.notHost.door && !r0s.notHost.start
      && r0s.notSolo.starts === 0 && r0s.notSolo.title === 'Standing by' && /Your room\s*STAND BY\s*Start whenever you are ready\./.test(r0s.notSolo.text) && !r0s.notSolo.code && r0s.notSolo.start)
    ok('0s: a room somebody else hosts is never started or called solo: it reads Standing by, Waiting for the host, with no code to share and no Armoury door; a host room not asked as Solo keeps its Start and offers no code either');
  else fail('0s: other rooms ' + JSON.stringify({ notHost: r0s.notHost, notSolo: r0s.notSolo }));
  if (r0s.created.title === 'Deploying' && !r0s.created.wait && !r0s.created.code && /Boss Fight/.test(r0s.created.text))
    ok("0s: a Solo raid's 'created' is drawn as its own Deploying run, never in the previous room's payload");
  else fail('0s: created ' + JSON.stringify(r0s.created));
  if (r0s.afterRefusal === false && r0s.afterCancel === false) ok('0s: a refusal and a Cancel both end the room-for-one mark'); else fail('0s: mark ' + JSON.stringify([r0s.afterRefusal, r0s.afterCancel]));
  const LEG = { duel: ['START VS COMPUTER', false], ffa: ['START VS COMPUTER', false], boss: ['START SOLO', true], golf: ['START SOLO', true] };
  if (JSON.stringify(r0s.legacy) === JSON.stringify(LEG)) ok('0s: the hidden legacy button names what the create path now starts, with Difficulty for the computer modes only');
  else fail('0s: legacy rack ' + JSON.stringify(r0s.legacy));

  // ---- 0c. a Solo raid online: the room is started the moment it exists ----
  // A raid is always seated at two, so the room this page asks for as one seat
  // would wait on its host's start with a seat open -- the waiting room the
  // owner removed. The page starts it itself; what the bay drew on the way is
  // recorded, and nothing of a lobby with an open seat or a code may appear.
  await fresh();
  await ev(`(() => {
    localStorage.setItem('cc_loadout', JSON.stringify(['mortar']));
    window.__lob = []; const bay = $('bay');
    window.__lobObs = new MutationObserver(() => {
      if (bay.dataset.scr !== 'lobby') return;
      const t = bay.textContent.replace(/\\s+/g, ' ');
      __lob.push({ title: (document.querySelector('#bay .pt') || {}).textContent, meta: (document.querySelector('#bay .pm') || {}).textContent, one: /Players\\s*1\\s*Paint/.test(t),
        wait: !!document.querySelector('#bay .seat.wait'), code: /Share this code|Copy code|Copy link|Bay doors sealed|Standing by/.test(t) });
    });
    __lobObs.observe(bay, { childList: true, subtree: true, characterData: true, attributes: true });
    ccMode = 'boss'; Bay.show('home'); document.querySelector('#bay .launch').click(); document.querySelector('#bay .pfoot [data-launch]').click();
    return true;
  })()`);
  const up0c = await until(`S.playing === true && S.mode === 'boss'`, 6000);
  const r0c = await ev(`(() => { __lobObs.disconnect(); return { local: S.local, n: S.n, lob: __lob, modal: $('armouryModal').classList.contains('hidden'),
    toasts: __toasts.slice(), solo: soloRoom, rack: JSON.parse(localStorage.getItem('cc_loadout') || 'null') }; })()`);
  await ev(`(localStorage.removeItem('cc_resume'), localStorage.removeItem('cc_loadout'), true)`);
  if (up0c && r0c.local === false && r0c.lob.length > 0 && r0c.lob.every((x) => x.title === 'Deploying' && x.meta === 'Solo run' && x.one && !x.wait && !x.code) && r0c.solo === false)
    ok('0c: Start Game for a Solo Boss Fight online starts the run on the server at once, drawn as Deploying, never as a lobby with an open seat or a code');
  else fail('0c: solo raid online ' + JSON.stringify({ up0c, r0c }));
  if (r0c.modal && r0c.toasts.some((t) => /^Rack loaded/.test(t)) && Array.isArray(r0c.rack) && r0c.rack.length === 7)
    ok("0c: the one-pick rack was filled to the raid's seven and submitted at once: no draft raised over the battlefield");
  else fail('0c: draft ' + JSON.stringify({ modal: r0c.modal, toasts: r0c.toasts, rack: r0c.rack }));

  // ---- 1. an invite room never converts while offline -----------------------
  for (const mode of ['duel', 'boss', 'aliens', 'golf', 'ffa']) {
    const s = await pendingOffer(mode, mode === 'boss' ? 5200 : 1500);   // boss waits out the old 4 s timer
    if (s.soloLabel === LABEL[mode]) ok(`1: ${mode} offline — the offer reads '${LABEL[mode]}'`); else fail(`1: ${mode} offline — the offer reads '${s.soloLabel}'`);
    if (!s.local && !s.playing && s.pend === mode) ok(`1: ${mode} offline — nothing started, the create is queued`);
    else fail(`1: ${mode} offline — local=${s.local} playing=${s.playing} pend=${s.pend}`);
    if (s.solo && s.text.includes(NEED[mode]) && s.text.includes('No connection') && s.lw === 'offline' && s.meta === 'Offline') ok(`1: ${mode} offline — the lobby explains, wears the Offline chip and offers Play solo`);
    else fail(`1: ${mode} offline — solo=${s.solo} lw=${s.lw} meta=${s.meta} text=${s.text.slice(0, 120)}`);
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

  // ---- 2b. THE PLAYER'S OWN NAME, OFFLINE (owner, 2026-10-07) ----------------
  // Every player may now set a name of their own. Online the server's name
  // check admits it at the door; offline there is no server and no check, so
  // the page hands the engine its own player's name as `allowed` (app.js
  // startLocal). Without that, a name the player SET was swapped for a rolled
  // pair in their own offline match. Only THAT name: any other typed name is
  // still kept out, because the offline door is otherwise shut as it was.
  // CHANGED (owner, 2026-10-10, item 27): the page's own name is now the
  // seat's name whatever the frame carries (room-engine.js nameAtDoor), so a
  // frame carrying another typed name seats the player under their own name,
  // where it used to seat them under a rolled pair. The typed name still never
  // reaches the match.
  await fresh(); await cut({ offline: true });
  await ev(`(setOwnName('Tank Ace'), intent({ type: 'ai', difficulty: 'easy', name: myName(), skin: 'olive' }), true)`);
  const own2b = (await until(`S.local === true && S.playing === true`, 4000)) ? await ev('({ me: S.names[S.you], name: myName() })') : null;
  await fresh(); await cut({ offline: true });
  await ev(`(setOwnName('Tank Ace'), intent({ type: 'ai', difficulty: 'easy', name: 'Somebody Else', skin: 'olive' }), true)`);
  const other2b = (await until(`S.local === true && S.playing === true`, 4000)) ? await ev('S.names[S.you]') : null;
  if (own2b && own2b.me === 'Tank Ace' && own2b.name === 'Tank Ace' && other2b === 'Tank Ace')
    ok("2b: offline, the player's own name ('Tank Ace') is the name in their match, and a frame carrying any other typed name seats them under it too");
  else fail('2b: offline own name ' + JSON.stringify({ own2b, other2b }));
  await ev(`(localStorage.removeItem('cc_name_own'), localStorage.removeItem('pt_name'), true)`);

  // ---- 3. server unreachable: grace, then an offer, then the real room ------
  // CHANGED (owner, 2026-10-06): the create is Match setup's own, a Solo Boss
  // Fight from Start Game, and when the server answers it becomes a run that
  // STARTS -- the waiting room with a code it used to become is gone.
  await fresh(); await cut({ offline: false });
  await ev(`(ccMode = 'boss', Bay.show('home'), document.querySelector('#bay .launch').click(), document.querySelector('#bay .pfoot [data-launch]').click(), true)`);
  await sleep(1000);
  let s = await state();
  // Its chip names the state, never a room (update 8 review): the waiting
  // room is gone, and nothing has been made yet.
  if (s.text.includes('Reaching the server') && !s.solo && !s.local && s.lw === 'connecting' && s.meta === 'Connecting' && !/waiting room/i.test(s.text))
    ok("3: during the grace the lobby says 'Reaching the server' under a Connecting chip, with no offer yet and no waiting room");
  else fail('3: at 1 s — ' + JSON.stringify({ solo: s.solo, lw: s.lw, local: s.local, meta: s.meta, text: s.text.slice(0, 100) }));
  await sleep(4200);
  s = await state();
  if (s.solo && s.text.includes('Cannot reach the server') && !s.local && !s.playing && s.lw === 'unreachable' && s.meta === 'Retrying') ok('3: after 4 s it offers Play solo under a Retrying chip and has started nothing'); else fail('3: at 5 s — ' + JSON.stringify({ solo: s.solo, lw: s.lw, local: s.local, playing: s.playing, meta: s.meta, text: s.text.slice(0, 100) }));
  if (s.text.includes('Your solo run starts as soon as the server can be reached. We keep trying in the background.') && !s.text.includes('second commander'))
    ok('3: the offer says the Solo run waits for the server, never that it needs a second commander');
  else fail('3: solo copy — ' + s.text.slice(0, 220));
  resumeServer();
  if (await until(`S.connected === true && S.playing === true && S.mode === 'boss' && /^[A-Z0-9]{4}$/.test(S.code || '') && lobbyWait === null`, 10000)) ok('3: when the server answers, the queued Solo create becomes a real run on the server and starts at once (queue-and-tell kept)');
  else fail('3: the queued create never became a real run: ' + JSON.stringify(await state()));
  s = await state();
  if (!s.local && !s.solo && !s.waitSeen) ok('3: the real run is not a local one, the offer is gone, and no open seat was ever drawn'); else fail('3: after flush local=' + s.local + ' solo=' + s.solo + ' waitSeen=' + s.waitSeen);
  // The run is live on the server: the next fresh page must not resume it.
  await ev(`(localStorage.removeItem('cc_resume'), true)`);

  // ---- 4. Play solo is one tap, for every mode ------------------------------
  for (const mode of ['duel', 'boss', 'aliens', 'golf', 'ffa']) {
    await pendingOffer(mode);
    await ev(`(document.querySelector('#bay [data-solo]').click(), true)`);
    const started = await until(`S.local === true && S.playing === true`, 6000);
    s = await state();
    const shape = mode === 'duel' ? (s.mode === 'duel' && s.n === 2)
      : mode === 'boss' ? (s.mode === 'boss' && s.boss >= 0 && s.n === 2)
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

  // ---- 9b. Start Game with no connection --------------------------------------
  // Computer (Duel, Free-for-all) starts on this device at once. CHANGED BY
  // THE UPDATE 8 REVIEW: so does Solo (Boss, Aliens, golf). Its create is a
  // room for one that nobody is invited into, so with the device known to be
  // offline the pending lobby's question has one answer, and Start Game plays
  // it here through Play solo's own door: the pending lobby is never drawn
  // and nothing is left queued. A server that merely cannot be raised still
  // gets the pending lobby, which says the run waits for the server -- never
  // that it needs a second player -- counts one seat of one, and offers Play
  // solo, which starts it here.
  await fresh(); await cut({ offline: true });
  await ev(`(ccMode = 'duel', Bay.show('home'), document.querySelector('#bay .launch').click(), document.querySelector('#bay .pfoot [data-launch]').click(), true)`);
  if (await until(`S.local === true && S.playing === true && S.mode === 'duel'`, 4000)) ok('9b: Start Game for Duel with no connection starts against the computer on this device at once');
  else fail('9b: duel offline start — ' + JSON.stringify(await state()));
  for (const mode of ['boss', 'aliens', 'golf']) {
    await fresh(); await cut({ offline: true });
    // Every title the pending lobby has, and its Play solo, noticed the
    // moment either is written to the bay, however briefly.
    await ev(`(() => {
      window.__pend = [];
      const look = () => { const t = (document.querySelector('#bay .pt') || {}).textContent || '';
        if (document.querySelector('#bay [data-solo]') || /^(No connection|Reaching the server|Cannot reach the server)$/.test(t)) __pend.push(t); };
      window.__pendObs = new MutationObserver(look);
      __pendObs.observe($('bay'), { childList: true, subtree: true, characterData: true });
      ccMode = '${mode}'; Bay.show('home'); document.querySelector('#bay .launch').click(); document.querySelector('#bay .pfoot [data-launch]').click();
      look();
      return true; })()`);
    const started = await until(`S.local === true && S.playing === true && S.mode === '${mode}'`, 6000);
    const r9 = await ev(`(() => { __pendObs.disconnect(); return { pend: __pend.slice(), lw: lobbyWait, queued: pendingIntent, toasts: __toasts.slice(), wait: !!window.__waitSeen }; })()`);
    // A create left queued would flush into a real room the moment the server
    // is resumed, and the next fresh page would resume into it: cancelled here,
    // so a failure above stays one failure.
    await ev(`(pendingIntent ? $('cancelBtn').onclick() : 0, localStorage.removeItem('cc_resume'), true)`);
    if (started && r9.pend.length === 0 && r9.lw === null && r9.queued === null && r9.toasts.includes('Playing offline') && !r9.wait)
      ok(`9b: ${mode} Start Game with no connection plays it on this device at once — no pending lobby drawn, nothing left queued`);
    else fail(`9b: ${mode} offline — ` + JSON.stringify({ started, r9, s: await state() }));
  }
  await fresh(); await cut({ offline: false });
  await ev(`(ccMode = 'golf', Bay.show('home'), document.querySelector('#bay .launch').click(), document.querySelector('#bay .pfoot [data-launch]').click(), true)`);
  await sleep(4800);
  s = await state();
  {
    const line = 'Your solo round starts as soon as the server can be reached.';
    const seats = await ev(`[...document.querySelectorAll('#bay .ro')].map((r) => r.textContent).join('|')`);
    if (s.lw === 'unreachable' && s.pend === 'golf' && s.solo && s.text.includes(line) && !/second commander|invite other players/.test(s.text) && !s.waitSeen && /Players1 \/ 1/.test(seats))
      ok('9b: golf Start Game with the server unreachable — the pending lobby says the solo round waits for the server, counts 1 / 1 and offers Play solo');
    else fail('9b: golf unreachable — ' + JSON.stringify({ lw: s.lw, pend: s.pend, solo: s.solo, waitSeen: s.waitSeen, seats, text: s.text.slice(0, 200) }));
  }
  await ev(`(document.querySelector('#bay [data-solo]').click(), true)`);
  if (await until(`S.local === true && S.playing === true && S.mode === 'golf'`, 6000)) ok('9b: golf — Play solo starts it on this device');
  else fail('9b: golf Play solo — ' + JSON.stringify(await state()));

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

clearTimeout(watchdog);
cleanup();
console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
