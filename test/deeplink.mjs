// Deep links, in a real page: the ONE parser behind ?room=, ?squad= and the
// native notification tap, and the precedence that decides which of the three
// claimants on boot wins.
//
// WHY THIS EXISTS. Four defects, none of which any other suite can see:
//   * the native tap parsed the URL with url.match(/room=([A-Z0-9]{4})/i). That
//     is blind to squad=, it MATCHES ?xroom=ABCD and ?notaroom=ABCD -- joining a
//     room the link never named -- and [A-Z0-9]{4} accepts five characters the
//     code alphabet does not contain (I, L, O, 0, 1).
//   * a ?squad= link fired from boot's 300 ms setTimeout reaches a socket that
//     is usually still CONNECTING. socialSend has no queue: it answers
//     { error: 'offline' } and sends nothing. On the starts where it DID land,
//     the hello had not resolved, so the server answered for a GUEST -- and a
//     guest row in someone's squad is not a thing the account can take back.
//   * with a held seat, ?room= and ?squad= all claiming the same boot, nothing
//     arbitrated.
//   * on Android a notification tap reached the game only in a session where
//     the player had pressed Nudges: that was the one place its listener was
//     added, and the plugin holds the tap that launched the app until a
//     listener exists. Part D launches the page through a fake Capacitor
//     bridge, with the tap already waiting.
//
// Headless Chrome over CDP against a REAL server on a free port; skips without
// Chrome, like the other client suites. THE SOCKET IS NOT STUBBED. A tap is
// installed over WebSocket.send before any page script runs, so every frame this
// page sends is recorded while the real socket still opens, says hello and is
// answered by the real server. A recorder that REPLACED the socket could not
// tell a frame that was sent from a frame that was merely attempted, and this
// suite's whole subject is which frames are sent.
//
// EVERY CDP CALL HAS A DEADLINE, and so does the whole run (fix wave A4): a
// Chrome that stops answering must fail this suite loudly, never hang the
// pre-push hook. Chrome and the server are SIGKILLed on every way out.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  deeplink tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));   // decoded: the path has spaces
const CDP_MS = 15000;                                           // one call
const RUN_MS = 240000;                                          // the whole suite
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });

let srv = null, chrome = null, prof = null;
// SIGKILL: a stopped process ignores SIGTERM until it is continued, so a frozen
// Chrome -- the hang the deadlines exist for -- would outlive a SIGTERM.
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
// Under Node's default handlers a signal kills the process without an 'exit'
// event, so a Ctrl-C of run-all.sh would leave server.js and Chrome running.
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
setTimeout(() => { console.error(`FAIL deeplink overran ${RUN_MS} ms — a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

const appPort = await freePort();
srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); break; } catch {} await sleep(150); }
const dbg = await freePort(); prof = join(tmpdir(), `cc-dl-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
if (!wsUrl) { console.error('FAIL deeplink: Chrome never offered a page to drive'); process.exit(1); }
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl);
await Promise.race([new Promise((r) => (ws.onopen = r)), sleep(CDP_MS).then(() => { throw new Error('CDP socket never opened'); })]);
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  const t = setTimeout(() => { pend.delete(i); rej(new Error(`CDP ${method} gave no answer in ${CDP_MS} ms`)); }, CDP_MS);
  pend.set(i, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };
await send('Page.enable'); await send('Runtime.enable');
// The cold-start intro (public/intro.js) is off for this suite: it covers the bay
// with a pointer-catching canvas for six seconds on a fresh load. test/intro.mjs
// owns it. Scripts for new documents only run while the Page domain is enabled.
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__ccNoIntro = true;' });
await send('Emulation.setDeviceMetricsOverride', { width: 932, height: 430, deviceScaleFactor: 2, mobile: true });

// THE TAP, not a stand-in. It wraps send() on the real WebSocket and forwards
// every byte, so the socket opens, the hello goes, the server answers, and
// S.connected becomes true exactly as in a browser. window.__tx is re-created on
// every new document, so each navigation starts with an empty ledger.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const Real = window.WebSocket;
  window.__tx = [];
  const Tap = function (url, proto) {
    const s = new Real(url, proto);
    const real = s.send.bind(s);
    s.send = (d) => { try { window.__tx.push(JSON.parse(d)); } catch {} real(d); };
    return s;
  };
  Tap.prototype = Real.prototype;
  Tap.OPEN = Real.OPEN; Tap.CONNECTING = Real.CONNECTING; Tap.CLOSING = Real.CLOSING; Tap.CLOSED = Real.CLOSED;
  window.WebSocket = Tap;
})();` });

// THE NATIVE PAGE'S FIRST CHECK, run on every navigation of part D before
// anything else is read. config.js aims any page that has window.Capacitor at
// PRODUCTION (CC_SERVER = CC_NATIVE_HOST). Part D's fake bridge pins CC_SERVER
// to null and refuses any socket or fetch to the production host; this proves
// the page really is native and really is talking to this suite's own server,
// and ends the run on the spot if either is not so.
let native = false;
const PROD_HOST = 'tanks.abarabrothers.com';
const assertLocal = async (q) => {
  const want = `ws://127.0.0.1:${appPort}/ws`;
  const s = await ev(`JSON.stringify({ server: window.CC_SERVER === null ? null : String(window.CC_SERVER),
    native: typeof IS_NATIVE !== 'undefined' && IS_NATIVE === true, url: S.ws && S.ws.url ? String(S.ws.url) : null,
    refused: Array.isArray(window.__prodBlocked) ? window.__prodBlocked : null })`).then(JSON.parse);
  if (s.server !== null || !s.native || s.url !== want || !s.refused || s.refused.length) {
    console.error(`FAIL D: ABORTED on /${q} -- the native page is not provably on the local server: ${JSON.stringify(s)}, want ${want}`);
    process.exit(1);
  }
};

let navs = 0;
const nav = async (q) => {
  // THE OLD DOCUMENT IS MARKED before it is left, so no check below can be
  // answered by the page this navigation is replacing.
  await ev('window.__stale = true').catch(() => {});
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/${q}` });
  // Ready means the NEW PAGE is up, never that a function under test exists: a
  // missing one must fail where it is called, not stall every navigation.
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await ev('!window.__stale && typeof handle === "function" && typeof connect === "function" && !!window.Bay').catch(() => false);
    if (!ready) await sleep(150);
  }
  if (ready && native) await assertLocal(q);
  // Wait for the SOCKET, not just the scripts. Every claim in parts B and C is
  // about a frame, and a frame cannot be sent down a socket that never opened;
  // a suite that only waited for the scripts would read an empty ledger and
  // call it "no frame sent", which is the answer half these cases want. So a
  // page that never connected ends the run, loudly.
  let up = false;
  for (let i = 0; ready && i < 100 && !up; i++) {
    up = await ev('!!(S.connected && S.ws && S.ws.readyState === 1)').catch(() => false);
    if (!up) await sleep(100);
  }
  if (!up) throw new Error(`navigation ${++navs} to /${q} never ${ready ? 'connected its socket' : 'became ready'}`);
  navs++;
  await sleep(700);        // boot's 300 ms room timer, plus the hello hook, plus slack
};
const tx = () => ev('JSON.stringify(window.__tx)').then(JSON.parse);
const squadJoins = (f) => f.filter((m) => m.type === 'squad' && m.op === 'join');
const roomJoins = (f) => f.filter((m) => m.type === 'join');
const seed = async (resume) => {
  await nav('');
  await ev(`(() => { localStorage.setItem('pt_name', 'Deep Linker');
    ${resume ? `localStorage.setItem('cc_resume', JSON.stringify({ code: 'WXYZ', token: 'seed-token' }));` : `localStorage.removeItem('cc_resume');`}
    return true; })()`);
};

// ---- A. THE PARSER ---------------------------------------------------------
// Pure, so it is driven directly with a table. Every row is a link somebody can
// actually produce: the server's two, a shared squad link, and the shapes the
// old regex got wrong.
const CASES = [
  ['/?room=ABCD',            { kind: 'room',  code: 'ABCD' }],
  ['/?squad=ABCD',           { kind: 'squad', code: 'ABCD' }],
  ['/?room=abcd',            { kind: 'room',  code: 'ABCD' }],
  ['/?squad=abcd',           { kind: 'squad', code: 'ABCD' }],
  ['/?squad=ABCD&room=WXYZ', { kind: 'room',  code: 'WXYZ' }],
  ['/?room=WXYZ&squad=ABCD', { kind: 'room',  code: 'WXYZ' }],
  ['/?xroom=ABCD',           null],
  ['/?notaroom=ABCD',        null],
  ['/?xsquad=ABCD',          null],
  ['/?room=ABCDE',           null],
  ['/?room=ABC',             null],
  ['/?room=ABIL',            null],
  ['/?squad=AB0O',           null],
  ['/?room=',                null],
  ['/',                      null],
  ['',                       null],
  ['#top',                   null],
  [null,                     null],
  [42,                       null],
];
{
  // READ ON A PAGE THAT WAS ITSELF BOOTED FROM A LINK. `new URL('', page)` and
  // `new URL('#top', page)` are the page's own URL, query included, so a parser
  // that resolved against the page would read this page's room off an empty
  // notification url. This is the profile's first page, with no saved name, so
  // boot follows neither link (hadName) and nothing is joined.
  await nav('?room=WXYZ&squad=WXYZ');
  const got = await ev(`JSON.stringify(${JSON.stringify(CASES.map((c) => c[0]))}.map((u) => deepLink(u)))`).then(JSON.parse);
  const wrong = [];
  CASES.forEach(([u, want], i) => {
    if (JSON.stringify(got[i]) !== JSON.stringify(want)) wrong.push(`${typeof u === 'string' ? (u || '<empty>') : String(u)} -> ${JSON.stringify(got[i])}, expected ${JSON.stringify(want)}`);
  });
  if (wrong.length) fail(`A: deepLink disagrees on ${wrong.length} of ${CASES.length} links: ${wrong.join(' | ')}`);
  else ok(`A: deepLink reads ?room= and ?squad= off ${CASES.length} links, room before squad, and refuses xroom, notaroom, the wrong length and the five characters the code alphabet does not have`);
}

// ---- A2. THE SQUAD LINK: ONE BUILDER, ONE READER (owner, 2026-10-10) --------
// squadLink builds what a squad's Share and Copy hand out; squadLinkCode reads
// the link iOS opens the app with. The builder never reads this page's origin
// (in the app that is capacitor://localhost, the link nobody could open), so
// on this page, http://127.0.0.1, the link is still the public one; and it
// follows config.js's CC_NATIVE_HOST. The reader takes only that exact shape.
const PUB = 'https://tanks.abarabrothers.com';
{
  const built = await ev(`JSON.stringify([squadLink('ABCD'), squadLink('abcd'), squadLink('ABIO'), squadLink(''), squadLink(null),
    (() => { const h = window.CC_NATIVE_HOST; window.CC_NATIVE_HOST = 'staging.example.test'; try { return squadLink('ABCD'); } finally { window.CC_NATIVE_HOST = h; } })()])`).then(JSON.parse);
  const want = [PUB + '/squad/ABCD', PUB + '/squad/ABCD', '', '', '', 'https://staging.example.test/squad/ABCD'];
  if (JSON.stringify(built) === JSON.stringify(want)) ok(`A2: squadLink builds ${PUB}/squad/CODE on a page served from 127.0.0.1 (never its origin), upper-cases the code, refuses a code outside the alphabet, and follows CC_NATIVE_HOST`);
  else fail(`A2: squadLink built ${JSON.stringify(built)}, expected ${JSON.stringify(want)}`);
  const READ = [
    [PUB + '/squad/ABCD', 'ABCD'],
    [PUB + '/squad/abcd', 'ABCD'],
    [PUB + '/squad/ABCD?x=1#access_token=t', 'ABCD'],
    ['http://tanks.abarabrothers.com/squad/ABCD', ''],
    ['https://evil.example/squad/ABCD', ''],
    ['https://tanks.abarabrothers.com.evil.example/squad/ABCD', ''],
    ['https://evil.example/https://tanks.abarabrothers.com/squad/ABCD', ''],
    ['capacitor://localhost/squad/ABCD', ''],
    [PUB + '/squad/ABCD/', ''],
    [PUB + '/squad/ABCD/x', ''],
    [PUB + '/squad/ABIO', ''],
    [PUB + '/squad/ABCDE', ''],
    [PUB + '/squads/ABCD', ''],
    [PUB + '/x/squad/ABCD', ''],
    [PUB + '/?squad=ABCD', ''],
    [PUB + '/auth/callback#access_token=t', ''],
    ['/squad/ABCD', ''],
    ['', ''], [null, ''], [42, ''],
  ];
  const got = await ev(`JSON.stringify(${JSON.stringify(READ.map((c) => c[0]))}.map((u) => squadLinkCode(u)))`).then(JSON.parse);
  const wrong = READ.map(([u, w], i) => [u, w, got[i]]).filter(([, w, g]) => g !== w).map(([u, w, g]) => `${String(u)} -> ${JSON.stringify(g)}, expected ${JSON.stringify(w)}`);
  if (!wrong.length) ok(`A2: squadLinkCode reads https://<public host>/squad/CODE and refuses ${READ.filter((c) => !c[1]).length} other shapes: http, another host, capacitor:, a trailing slash or path, a bad code, the old ?squad= and the OAuth return`);
  else fail(`A2: squadLinkCode disagrees on ${wrong.length} links: ${wrong.join(' | ')}`);
}

// ---- A3. THE LINK'S OTHER END, IN A REAL BROWSER ----------------------------
// A browser that opens a squad link gets the download page (server.js
// /squad/:code; test/http_contract.mjs owns its words and headers). Measured
// here: it runs no script and links nowhere, the code is on it, and the QR is
// drawn on a computer's screen and an iPad's, never on a phone's, either way
// round, and nothing scrolls sideways.
{
  const look = async (w, h, mobile) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile });
    await ev('window.__stale = true').catch(() => {});
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/squad/QK7T` });
    for (let i = 0; i < 80; i++) {
      const r = await ev(`(!window.__stale && document.readyState === 'complete' && document.querySelector('.qr svg')) ? JSON.stringify((() => {
        const q = document.querySelector('.qr svg').getBoundingClientRect(), el = document.documentElement;
        return { qr: getComputedStyle(document.querySelector('.qr')).display, qw: Math.round(q.width), code: document.querySelector('.code').textContent,
          scripts: document.scripts.length, links: document.links.length, forms: document.forms.length, sideways: el.scrollWidth > el.clientWidth,
          game: !!document.getElementById('bay') || typeof window.Bay !== 'undefined' };
      })()) : ''`).catch(() => '');
      if (r) return JSON.parse(r);
      await sleep(100);
    }
    return null;
  };
  const sizes = { computer: await look(1280, 800, false), ipad: await look(820, 1180, true), phone: await look(390, 844, true), phoneLandscape: await look(932, 430, true) };
  await send('Emulation.setDeviceMetricsOverride', { width: 932, height: 430, deviceScaleFactor: 2, mobile: true });
  const plain = Object.values(sizes).every((v) => v && v.code === 'QK7T' && v.scripts === 0 && v.links === 0 && v.forms === 0 && !v.sideways && !v.game);
  const qr = sizes.computer && sizes.computer.qr === 'block' && sizes.computer.qw >= 200 && sizes.ipad && sizes.ipad.qr === 'block'
    && sizes.phone && sizes.phone.qr === 'none' && sizes.phoneLandscape && sizes.phoneLandscape.qr === 'none';
  if (plain && qr) ok('A3: /squad/CODE is the download page at every size (the code, no script, no link, not the game, nothing sideways), with the QR on a computer and an iPad and never on a phone');
  else fail(`A3: download page ${JSON.stringify(sizes)}`);
}

// ---- B. BOOT: THREE CLAIMANTS, ONE WINNER ----------------------------------
// The rule, in one line: THE MOST PERISHABLE CLAIM WINS. A held seat (120 s, or
// 24 h for an async duel) beats both links; ?room= (a lobby that is filling)
// beats ?squad= (a group that persists). The loser is dropped, not queued.
{
  await seed(true);
  await nav('?squad=ABCD');
  const f = await tx();
  if (!squadJoins(f).length) ok('B1: a held seat beats a ?squad= link — no squad join on boot');
  else fail(`B1: a held seat did not beat ?squad= — frames: ${JSON.stringify(squadJoins(f))}`);
}
{
  await seed(true);
  await nav('?room=ABCD');
  const f = await tx();
  if (!roomJoins(f).length) ok('B2: a held seat beats a ?room= link — no room join on boot');
  else fail(`B2: a held seat did not beat ?room= — frames: ${JSON.stringify(roomJoins(f))}`);
}
{
  await seed(false);
  await nav('?room=ABCD');
  const f = await tx();
  const r = roomJoins(f), s = squadJoins(f);
  if (r.length === 1 && r[0].code === 'ABCD' && !s.length) ok('B3: ?room= alone joins the room, once, and sends no squad frame');
  else fail(`B3: ?room= alone sent ${JSON.stringify({ room: r, squad: s })}`);
}
{
  await seed(false);
  await nav('?squad=ABCD');
  const f = await tx();
  const s = squadJoins(f), r = roomJoins(f);
  // AFTER the hello, not before it. socialSend has no queue, so a squad frame
  // sent while the socket is CONNECTING is simply lost; and one sent before the
  // hello settles is answered for a GUEST. The frame must therefore appear at
  // all, and it must appear after the hello when there is one to send.
  const helloAt = f.findIndex((m) => m.type === 'hello');
  const joinAt = f.findIndex((m) => m.type === 'squad' && m.op === 'join');
  const ordered = helloAt === -1 || joinAt > helloAt;
  if (s.length === 1 && s[0].code === 'ABCD' && s[0].name === 'Deep Linker' && typeof s[0].skin === 'string' && s[0].skin && !r.length && ordered) {
    ok('B4: ?squad= alone sends one squad join, with the saved name and a skin, after the hello and never through intent()');
  } else fail(`B4: ?squad= alone sent ${JSON.stringify({ squad: s, room: r, helloAt, joinAt })}`);
}
{
  await seed(false);
  await nav('?squad=ABCD&room=WXYZ');
  const f = await tx();
  const r = roomJoins(f), s = squadJoins(f);
  if (r.length === 1 && r[0].code === 'WXYZ' && !s.length) ok('B5: both params on one link — the room wins and the squad frame is never sent');
  else fail(`B5: both params sent ${JSON.stringify({ room: r, squad: s })}`);
}
{
  // THE SERVER ANSWERED, AND THE PLAYER WAS TOLD. This asserts three things at
  // once, and it is the one assertion in this suite that reaches past the
  // client: the frame left the page, server.js INTERCEPTED it before the engine
  // (only the interception answers 'unavailable'; the engine's switch has no
  // default and would answer nothing at all), and the reply reached a REAL
  // showToast that is REALLY on screen. Locally there is no Supabase secret, so
  // the social layer is not built and 'unavailable' is the correct answer by
  // construction (R14) -- which is exactly what makes it a usable probe. The
  // toast is found BY ITS TEXT: any other toast on screen proves nothing.
  const SAID = 'Squads need the account service, which is not answering.';
  await seed(false);
  await nav('?squad=ABCD');
  let shown = false;
  for (let i = 0; i < 40 && !shown; i++) {
    shown = await ev(`[...document.querySelectorAll('.toast-item')].some((t) => t.textContent === ${JSON.stringify(SAID)} && t.getClientRects().length > 0)`);
    if (!shown) await sleep(120);
  }
  if (shown) ok('B6: the squad frame reached server.js\'s interception (not the engine) and its refusal is on screen, in a toast with a box');
  else fail(`B6: squad refusal not shown — body=${JSON.stringify((await ev('document.body.innerText || ""')).slice(0, 200))}`);
}
{
  await nav('');
  await ev('localStorage.clear(); true');
  await nav('?squad=ABCD');
  const f = await tx();
  if (!squadJoins(f).length) ok('B7: a first-ever visit, with no saved name, follows no link — hadName gates a squad the same way it gates a room');
  else fail(`B7: a nameless first visit followed the link — ${JSON.stringify(squadJoins(f))}`);
}

// ---- C. THE NATIVE NOTIFICATION TAP ----------------------------------------
// Capacitor's pushNotificationActionPerformed does NOT navigate: it hands the
// url to the live page. So this path arbitrates against LIVE state. onPushTap(url)
// is the whole handler body, named so this drives the real function rather than
// a copy of it; the listener (listenForPushTaps) is one line that calls it, and
// part D drives that line through a fake Capacitor bridge.
{
  await seed(false);
  await nav('');
  await ev('window.__tx = []; S.playing = false; S.code = null; onPushTap("/?squad=ABCD"); true');
  await sleep(500);
  const s = squadJoins(await tx());
  if (s.length === 1 && s[0].code === 'ABCD') ok('C1: a tap on /?squad=CODE sends one squad join in the live page');
  else fail(`C1: tap on /?squad=ABCD sent ${JSON.stringify(s)}`);
}
{
  await ev('window.__tx = []; S.playing = false; S.code = null; onPushTap("/?room=ABCD"); true');
  await sleep(500);
  const f = await tx();
  const r = roomJoins(f);
  const field = await ev('($("codeInput") || {}).value || ""');
  if (r.length === 1 && r[0].code === 'ABCD' && field === 'ABCD') ok('C2: a tap on /?room=CODE joins the room and fills the legacy field, as it always did');
  else fail(`C2: tap on /?room=ABCD sent ${JSON.stringify(r)}, field=${JSON.stringify(field)}`);
}
{
  // THE REGRESSION THE REGEX WAS. /room=([A-Z0-9]{4})/i matches this and joined
  // a room the link never named.
  await ev('window.__tx = []; S.playing = false; S.code = null; onPushTap("/?xroom=ABCD"); true');
  await sleep(500);
  const f = await tx();
  if (!roomJoins(f).length && !squadJoins(f).length) ok('C3: a tap on /?xroom=CODE does nothing — the old regex joined a room off this link');
  else fail(`C3: tap on /?xroom=ABCD sent ${JSON.stringify(f.filter((m) => m.type === 'join' || m.type === 'squad'))}`);
}
{
  // A MATCH IN PROGRESS OUTRANKS A NOTIFICATION. The engine already refuses a
  // second seat for the same socket, so this is not the seat guard -- it is the
  // player's screen. A tap must not yank someone out of a turn they are lining
  // up, and a squad join mid-match would seat them twice over.
  await ev('window.__tx = []; S.playing = true; S.code = "WXYZ"; onPushTap("/?squad=ABCD"); true');
  let seen = '';
  for (let i = 0; i < 30; i++) { seen = await ev('document.body.innerText || ""'); if (seen.includes('Finish this match first')) break; await sleep(120); }
  const f = await tx();
  if (!squadJoins(f).length && !roomJoins(f).length && seen.includes('Finish this match first')) {
    ok('C4: a tap during a match sends nothing and says so out loud');
  } else fail(`C4: tap during a match sent ${JSON.stringify(f)}, body=${JSON.stringify(seen.slice(0, 160))}`);
}
{
  await ev('window.__tx = []; S.playing = false; S.code = "ABCD"; onPushTap("/?room=ABCD"); true');
  await sleep(500);
  const f = await tx();
  if (!roomJoins(f).length) ok('C5: a tap pointing at the room already open sends nothing — no second join for the seat you are in');
  else fail(`C5: tap on the current room re-joined it — ${JSON.stringify(roomJoins(f))}`);
  await ev('S.playing = false; S.code = null; true');
}
{
  // THE OFFLINE STAND-IN IS NOT A SOCKET. While S.local is set, S.ws is the
  // in-page face of room-engine.js (startLocal), which has no social code: a
  // squad frame fed to it vanishes, and its waiter blames the account service
  // twelve seconds later. So the code PARKS, and goes down the real socket once
  // that socket is S.ws again and its hello hook flushes it -- driven here by
  // putting the real socket back and calling that hook's flush for it.
  await ev(`(() => { window.__tx = []; window.__face = []; window.__realWs = S.ws;
    S.local = true; S.playing = false; S.code = null;
    S.ws = { readyState: 1, send: (d) => window.__face.push(JSON.parse(d)), close() {} };
    onPushTap("/?squad=ABCD"); return true; })()`);
  await sleep(500);
  const face = await ev('JSON.stringify(window.__face)').then(JSON.parse);
  const parked = await ev('pendingSquadJoin');
  await ev('S.ws = window.__realWs; S.local = false; flushSquadJoin(S.ws); true');
  await sleep(500);
  const s = squadJoins(await tx());
  if (!face.length && parked === 'ABCD' && s.length === 1 && s[0].code === 'ABCD') {
    ok('C6: a tap while the offline stand-in holds S.ws sends it nothing, parks the code, and the real socket\'s flush sends it once');
  } else fail(`C6: offline stand-in — face got ${JSON.stringify(face)}, parked=${JSON.stringify(parked)}, real socket then sent ${JSON.stringify(s)}`);
}
{
  // A HELLO THAT SETTLES FOR A SOCKET THAT HAS SINCE BEEN REPLACED flushes
  // nothing: the parked code would otherwise go down the NEW socket before that
  // socket's own hello, and be answered for a guest. The new socket's own hook
  // flushes it. Driven with the hook's own call, for a socket that is not S.ws.
  await ev(`(() => { window.__tx = []; pendingSquadJoin = 'ABCD'; flushSquadJoin({ readyState: 1 }); return true; })()`);
  await sleep(300);
  const stale = squadJoins(await tx()), still = await ev('pendingSquadJoin');
  await ev('flushSquadJoin(S.ws); true');
  await sleep(500);
  const s = squadJoins(await tx());
  if (!stale.length && still === 'ABCD' && s.length === 1 && s[0].code === 'ABCD') {
    ok('C7: a hello settling for a replaced socket leaves the code parked; the live socket\'s own flush sends it once');
  } else fail(`C7: stale-socket flush — sent ${JSON.stringify(stale)}, parked=${JSON.stringify(still)}, then the live flush sent ${JSON.stringify(s)}`);
}

// ---- D. THE TAP THAT LAUNCHED THE APP, THROUGH A FAKE CAPACITOR BRIDGE -------
// THE DEFECT. The only addListener for pushNotificationActionPerformed lived in
// enableNativePings, which runs when the player presses Nudges. Android's plugin
// fires that event with retainUntilConsumed=true and BridgeActivity.onCreate
// replays the launch intent through it, so a tap is HELD until a listener is
// added -- and in a session without a Nudges press, none ever was. Every tap
// opened the app and went nowhere.
//
// THE BRIDGE. Installed before any page script, after part C, so parts A-C stay
// plain web pages. getPlatform() answers 'android', so app.js takes every native
// branch. Its PushNotifications keeps a ledger of every call and models what
// Capacitor 8.5's Plugin.java does: an event fired with no listener is HELD, and
// the FIRST listener added for it drains what was held; delivery is async, as
// the bridge's is. A tap planted in sessionStorage is fired at document start,
// the moment BridgeActivity.onCreate fires the real one, before any listener.
//
// AND IT CANNOT REACH PRODUCTION. config.js sets CC_SERVER to the production
// host whenever window.Capacitor exists. CC_SERVER is pinned to null here (a
// getter, a setter that ignores config.js, not configurable); any socket or
// fetch aimed at the production host is refused and recorded; Chrome blocks
// the host as well; and every navigation proves the socket is this suite's own
// server before anything else is read (assertLocal), or ends the run. No other
// native branch reaches a host or needs a plugin at boot: errors.js reads the
// same pinned CC_SERVER, app.js's App, bay.js's Haptics and intro.js's CCLaunch
// are each behind a presence check, and Android cannot sign in.
await send('Network.enable');
await send('Network.setBlockedURLs', { urls: [`*${PROD_HOST}*`] });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  Object.defineProperty(window, 'CC_SERVER', { get: () => null, set: () => {}, configurable: false });
  const PROD = ${JSON.stringify(PROD_HOST)};
  window.__prodBlocked = [];
  // __sent records, for every frame, whether its socket's hello had settled
  // (socialIntro) at the moment it went: the B4 rule for a squad join, read off
  // the frame itself rather than inferred from the order of a hello frame that
  // a signed-out local run never sends.
  window.__sent = [];
  const Tap = window.WebSocket;
  const Guard = function (url, proto) {
    if (String(url).indexOf(PROD) !== -1) { window.__prodBlocked.push(String(url)); throw new Error('deeplink: refused a socket to production'); }
    const s = new Tap(url, proto);
    const inner = s.send;
    s.send = (d) => {
      try { const m = JSON.parse(d); window.__sent.push({ type: m.type, op: m.op || null, code: m.code || null, intro: typeof socialIntro === 'function' ? socialIntro() : -1 }); } catch {}
      inner(d);
    };
    return s;
  };
  Guard.prototype = Tap.prototype;
  Guard.OPEN = Tap.OPEN; Guard.CONNECTING = Tap.CONNECTING; Guard.CLOSING = Tap.CLOSING; Guard.CLOSED = Tap.CLOSED;
  window.WebSocket = Guard;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : String((input && input.url) || input);
    if (u.indexOf(PROD) !== -1) { window.__prodBlocked.push(u); return Promise.reject(new TypeError('deeplink: refused a fetch to production')); }
    return realFetch(input, init);
  };

  const calls = [], live = new Map(), held = new Map();
  window.__taps = [];
  // A case that is about the intro holds delivery until the intro is running,
  // so it proves the tap landing DURING the intro. On a device the bridge's own
  // round trip decides which side of intro.js's first line it lands on.
  let gate = false;
  const deliver = (ev, data, cbs) => {
    let n = 0;
    const go = () => {
      if (gate && !(window.__ccIntro && window.__ccIntro.state === 'running') && n++ < 300) { setTimeout(go, 10); return; }
      if (ev === 'pushNotificationActionPerformed') {
        let resume = null; try { resume = !!localStorage.getItem('cc_resume'); } catch {}
        // connected: whether this boot's socket was open when the tap landed.
        const connected = typeof S === 'object' && S ? !!S.connected : null;
        window.__taps.push({ intro: window.__ccIntro ? window.__ccIntro.state : null, resume, connected });
      }
      cbs.forEach((cb) => cb(data));
    };
    setTimeout(go, 0);
  };
  const notify = (ev, data) => {
    const l = live.get(ev);
    if (!l || !l.length) { if (!held.has(ev)) held.set(ev, []); held.get(ev).push(data); return; }
    deliver(ev, data, l.slice());
  };
  const Push = {
    addListener(ev, cb) {
      calls.push('addListener:' + ev);
      if (!live.has(ev)) live.set(ev, []);
      const l = live.get(ev);
      l.push(cb);
      if (l.length === 1 && held.has(ev)) { const q = held.get(ev); held.delete(ev); q.forEach((d) => notify(ev, d)); }
      return { remove: async () => { const i = l.indexOf(cb); if (i !== -1) l.splice(i, 1); } };
    },
    removeAllListeners: async () => { calls.push('removeAllListeners'); live.clear(); },
    checkPermissions: async () => { calls.push('checkPermissions'); return { receive: 'prompt' }; },
    requestPermissions: async () => { calls.push('requestPermissions'); return { receive: 'granted' }; },
    register: async () => { calls.push('register'); },
  };
  // THE APP PLUGIN'S appUrlOpen, as @capacitor/app 8 fires it for a link the
  // app was opened with (AppPlugin.swift: notifyListeners('appUrlOpen', ...,
  // retainUntilConsumed: true)): a link that opened the app before any
  // listener existed is HELD and handed, async, to the first one added.
  // window.__urls records each delivery and the state it landed in.
  const appLive = [], appHeld = [], appCalls = [];
  window.__urls = [];
  const openUrl = (url) => {
    if (!appLive.length) { appHeld.push(url); return; }
    setTimeout(() => {
      let resume = null; try { resume = !!localStorage.getItem('cc_resume'); } catch {}
      window.__urls.push({ url, resume, connected: typeof S === 'object' && S ? !!S.connected : null });
      appLive.slice().forEach((cb) => cb({ url }));
    }, 0);
  };
  const App = {
    addListener(ev, cb) {
      appCalls.push('addListener:' + ev);
      if (ev === 'appUrlOpen') { appLive.push(cb); if (appLive.length === 1) appHeld.splice(0).forEach(openUrl); }
      return { remove: async () => { const i = appLive.indexOf(cb); if (i !== -1) appLive.splice(i, 1); } };
    },
  };
  window.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: { PushNotifications: Push, App } };
  window.__cap = { calls, fire: notify, count: (ev) => (live.get(ev) || []).length, open: openUrl, appCalls };

  let tap = null, intro = null;
  try { tap = sessionStorage.getItem('cc_test_tap'); sessionStorage.removeItem('cc_test_tap'); } catch {}
  try { intro = sessionStorage.getItem('cc_test_intro'); sessionStorage.removeItem('cc_test_intro'); } catch {}
  // A case about the intro is a launch long after the app was last used: the
  // view this tab's earlier loads kept would make it a quick reopen (V9),
  // which gets the quick doors and never the intro.
  if (intro) { gate = true; window.__ccNoIntro = false; try { sessionStorage.removeItem('cc_intro'); localStorage.removeItem('cc_last_view'); } catch {} }
  if (tap) notify('pushNotificationActionPerformed', JSON.parse(tap));
  // A squad link that LAUNCHED the app, planted on the page before.
  let link = null;
  try { link = sessionStorage.getItem('cc_test_url'); sessionStorage.removeItem('cc_test_url'); } catch {}
  if (link) openUrl(link);
})();` });
// HOLDING THE SERVER'S ANSWER, AND HEARING WHAT THE PAGE SAYS. Two more
// recorders for part D, installed the same way and over the same socket.
//   * A case that plants a JSON list of frame types in sessionStorage
//     ('cc_test_hold') has every frame of those types that the server sends
//     HELD, on arrival, until window.__release() hands them to the page's own
//     handler. So a tap can be landed in the window between onopen sending a
//     resume and the server's answer, which on a local server is a few
//     milliseconds wide. The page sets ws.onmessage as it always does; the
//     setter is an own property of the socket, and the one message listener
//     calls whatever handler is set when the frame is delivered.
//   * window.__said records every toast the page shows and every text
//     written to #homeError, from document start, so a case can prove the
//     page SAID nothing: both are gone again a moment later (a toast after
//     1.9 s, #homeError when onopen clears it), so the end state cannot.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  let types = null;
  try { types = JSON.parse(sessionStorage.getItem('cc_test_hold') || 'null'); sessionStorage.removeItem('cc_test_hold'); } catch {}
  window.__held = Array.isArray(types) ? [] : null;
  window.__release = () => { const q = window.__held || []; window.__held = null; q.forEach((go) => go()); return q.length; };
  const Prev = window.WebSocket;
  const Hold = function (url, proto) {
    const s = new Prev(url, proto);
    let fn = null;
    Object.defineProperty(s, 'onmessage', { configurable: true, get: () => fn, set: (f) => { fn = f; } });
    s.addEventListener('message', (e) => {
      let t = null; try { t = JSON.parse(e.data).type; } catch {}
      if (window.__held && types.includes(t)) { window.__held.push(() => { if (fn) fn.call(s, e); }); return; }
      if (fn) fn.call(s, e);
    });
    return s;
  };
  Hold.prototype = Prev.prototype;
  Hold.OPEN = Prev.OPEN; Hold.CONNECTING = Prev.CONNECTING; Hold.CLOSING = Prev.CLOSING; Hold.CLOSED = Prev.CLOSED;
  window.WebSocket = Hold;
  window.__said = { toasts: [], homeError: [] };
  new MutationObserver((recs) => {
    for (const r of recs) {
      for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('toast-item')) window.__said.toasts.push(n.textContent);
      const el = r.target.nodeType === 1 ? r.target : r.target.parentNode;
      if (el && el.id === 'homeError' && el.textContent) window.__said.homeError.push(el.textContent);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
})();` });
native = true;

// The tap that will launch the NEXT page: planted on this one, read and fired
// by the bridge at the next document start.
const plant = (url, intro = false) => ev(`(() => {
  sessionStorage.setItem('cc_test_tap', ${JSON.stringify(JSON.stringify({ actionId: 'tap', notification: { data: { url } } }))});
  ${intro ? "sessionStorage.setItem('cc_test_intro', '1');" : ''}
  return true; })()`);
// The answers of these types that the NEXT page receives are held until
// release() (the second recorder above).
const holdNext = (types) => ev(`(() => { sessionStorage.setItem('cc_test_hold', ${JSON.stringify(JSON.stringify(types))}); return true; })()`);
const release = () => ev('window.__release()');
const said = () => ev('JSON.parse(JSON.stringify(window.__said))');
// A tap on the LIVE page, delivered by the bridge as a real one is.
const fire = (url) => ev(`(() => { window.__cap.fire('pushNotificationActionPerformed', ${JSON.stringify({ actionId: 'tap', notification: { data: { url } } })}); return true; })()`);
const capCalls = () => ev('JSON.stringify(window.__cap.calls)').then(JSON.parse);
const taps = () => ev('JSON.stringify(window.__taps)').then(JSON.parse);
const sentSquadJoins = () => ev('JSON.stringify(window.__sent)').then(JSON.parse).then((f) => f.filter((m) => m.type === 'squad' && m.op === 'join'));
const introState = () => ev('window.__ccIntro ? JSON.parse(JSON.stringify(window.__ccIntro)) : null');
const introLeft = () => ev("!!document.getElementById('intro') || document.getElementById('bay').inert");
// What boot itself may ask of the plugin: one tap listener, and nothing else.
// No permission prompt, no register(): those belong to the Nudges button.
const BOOT_ONLY = JSON.stringify(['addListener:pushNotificationActionPerformed']);
// A REAL WAITING ROOM, so a join can be followed all the way to a seat: a duel
// created by a plain socket from this process, which starts when the page joins.
const hostRoom = async () => {
  const h = new WebSocket(`ws://127.0.0.1:${appPort}/ws`);
  const code = await Promise.race([
    new Promise((res) => {
      h.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === 'created') res(m.code); } catch {} };
      h.onopen = () => h.send(JSON.stringify({ type: 'create', name: 'Host', skin: 'olive', mode: 'duel' }));
    }),
    sleep(CDP_MS).then(() => { throw new Error('the host socket never got a room'); }),
  ]);
  return { code, close: () => { try { h.close(); } catch {} } };
};
const seatedIn = async (code) => {
  for (let i = 0; i < 40; i++) { if (await ev(`S.playing === true && S.code === ${JSON.stringify(code)}`)) return true; await sleep(100); }
  return false;
};
const introEnded = async () => {
  let st = null;
  for (let i = 0; i < 150; i++) { st = await introState(); if (st && st.state === 'ended') break; await sleep(100); }
  return st;
};

{
  await nav('');
  ok(`D0: the native page (getPlatform 'android') is on this suite's server, ws://127.0.0.1:${appPort}/ws, with CC_SERVER pinned null and nothing aimed at production; checked again on every navigation below`);
}
{
  const host = await hostRoom();
  await seed(false);
  await plant(`/?room=${host.code}`);
  await nav('');
  const seated = await seatedIn(host.code);
  const f = await tx(), r = roomJoins(f), s = squadJoins(f), t = await taps(), calls = await capCalls(), heard = await said();
  host.close();
  if (t.length === 1 && r.length === 1 && r[0].code === host.code && !s.length && seated) {
    ok('D1: a launch tap on /?room=CODE, with Nudges never pressed, is delivered once at boot and sends one join, and the player takes the seat');
  } else fail(`D1: launch tap on a waiting room — taps ${JSON.stringify(t)}, room ${JSON.stringify(r)}, squad ${JSON.stringify(s)}, seated ${seated}`);
  // A LAUNCH TAP IS QUIET. It landed before this boot's socket opened, and
  // through intent() that said 'Reconnecting' over the intro and wrote
  // 'Cannot reach the server' to #homeError, on a launch that was never
  // connected. It waits for the socket's hello instead, and says neither.
  if (t.length === 1 && t[0].connected === false && !heard.toasts.some((x) => /Reconnecting|No connection/.test(x)) && !heard.homeError.length) {
    ok('D1: and it is quiet: it landed before the socket opened, and the page showed no Reconnecting toast and wrote nothing to #homeError');
  } else fail(`D1: launch tap before the socket opened was not quiet — taps ${JSON.stringify(t)}, said ${JSON.stringify(heard)}`);
  if (JSON.stringify(calls) === BOOT_ONLY) ok('D2: boot added one tap listener and asked for nothing else: no permission prompt, no register()');
  else fail(`D2: boot's calls on the plugin were ${JSON.stringify(calls)}, expected ${BOOT_ONLY}`);
}
{
  await seed(false);
  await plant('/?squad=ABCD');
  await nav('');
  const f = await tx(), s = squadJoins(f), r = roomJoins(f), t = await taps(), m = await sentSquadJoins(), calls = await capCalls();
  if (t.length === 1 && s.length === 1 && s[0].code === 'ABCD' && !r.length && m.length === 1 && m[0].intro > 0 && JSON.stringify(calls) === BOOT_ONLY) {
    ok('D3: a launch tap on /?squad=CODE sends one squad join, on a socket whose hello had settled, and boot again asked for nothing');
  } else fail(`D3: launch tap on a squad — taps ${JSON.stringify(t)}, squad ${JSON.stringify(s)}, room ${JSON.stringify(r)}, sent ${JSON.stringify(m)}, calls ${JSON.stringify(calls)}`);
}
{
  // THE WINDOW A LAUNCH TAP CAN HIT AND BOOT'S OWN LINK CANNOT: the socket is
  // open, but its hello has not settled. Driven by unmarking the live socket,
  // then settling its hello the way onopen does and running onopen's flush.
  await ev(`(() => { window.__tx = []; window.__sent = []; helloWs = null; onPushTap('/?squad=ABCD'); return true; })()`);
  await sleep(300);
  const early = squadJoins(await tx()), parked = await ev('pendingSquadJoin');
  await ev('sendHello(S.ws).then(() => flushSquadJoin(S.ws)).then(() => true)');
  await sleep(500);
  const s = squadJoins(await tx()), m = await sentSquadJoins();
  if (!early.length && parked === 'ABCD' && s.length === 1 && s[0].code === 'ABCD' && m.length === 1 && m[0].intro > 0) {
    ok('D4: a tap landing on an open socket whose hello has not settled parks the code; the hello\'s own flush sends it once, introduced');
  } else fail(`D4: open-but-unintroduced socket — sent early ${JSON.stringify(early)}, parked=${JSON.stringify(parked)}, then ${JSON.stringify(m)}`);
}
for (const url of ['/?room=ABCD', '/?squad=ABCD']) {
  for (const when of ['connecting', 'open']) {
    // A HELD SEAT BEATS THE TAP, as it beats both links in boot (B1, B2), but
    // a tap has no address bar to come back from, so it WAITS for the
    // resume's answer instead of being dropped. The planted record names no
    // room on this server, so the resume is refused (resumeError) and the
    // tap then goes, once, after the resume. The answer is HELD so the wait
    // can be seen. D5 lands the tap while the socket is still CONNECTING;
    // D9 lands it after onopen has sent the resume and before the server
    // has answered it.
    const D = when === 'connecting' ? 'D5' : 'D9';
    await seed(true);
    await holdNext(['resumeError']);
    if (when === 'connecting') await plant(url);
    await nav('');
    if (when === 'open') {
      for (let i = 0; i < 30 && !(await tx()).some((m) => m.type === 'resume'); i++) await sleep(100);
      await fire(url);
      await sleep(400);
    }
    const t = await taps(), early = await tx(), parked = await ev('pendingPushTap'), held = await ev('window.__held ? window.__held.length : -1');
    const n = await release();
    await sleep(700);
    const f = await tx(), after = await ev('pendingPushTap'), rec = await ev(`localStorage.getItem('cc_resume')`);
    const joins = url.includes('room') ? roomJoins : squadJoins;
    const resumes = f.filter((m) => m.type === 'resume' && m.code === 'WXYZ');
    const at = (m) => f.indexOf(m);
    const j = joins(f);
    const waited = t.length === 1 && t[0].resume === true && t[0].connected === (when === 'open')
      && !joins(early).length && parked === url && held === 1 && n === 1;
    if (waited) ok(`${D}: a tap on ${url} landing ${when === 'open' ? 'after the resume went and before its answer' : 'while the socket is still connecting'}, with a held seat, sends nothing and waits`);
    else fail(`${D}: held seat + tap on ${url} (${when}) — taps ${JSON.stringify(t)}, early ${JSON.stringify(joins(early))}, parked ${JSON.stringify(parked)}, held ${held}, released ${n}`);
    if (resumes.length === 1 && j.length === 1 && j[0].code === 'ABCD' && at(j[0]) > at(resumes[0]) && after === '' && rec === null) {
      ok(`${D}: the resume is refused, so the record is cleared and the tap on ${url} goes once, after the resume`);
    } else fail(`${D}: after the refusal (${when}) — resumes ${JSON.stringify(resumes)}, joins ${JSON.stringify(j)}, parked ${JSON.stringify(after)}, record ${rec}`);
  }
}
{
  // A HELD SEAT THAT IS RESTORED WINS: the waiting tap is dropped, as boot
  // drops a link that loses to a held seat. A real seat this time: the page
  // takes one in a host's duel, then the app is launched again by a tap on
  // a squad, with the restore held until the tap has landed and waited.
  const host = await hostRoom();
  await seed(false);
  await plant(`/?room=${host.code}`);
  await nav('');
  const seated = await seatedIn(host.code);
  await holdNext(['restore']);
  await plant('/?squad=ABCD');
  await nav('');
  const t = await taps(), parked = await ev('pendingPushTap'), held = await ev('window.__held ? window.__held.length : -1');
  await release();
  const back = await seatedIn(host.code);
  await sleep(700);
  const f = await tx(), after = await ev('pendingPushTap');
  host.close();
  const resumes = f.filter((m) => m.type === 'resume' && m.code === host.code);
  if (seated && t.length === 1 && t[0].resume === true && parked === '/?squad=ABCD' && held === 1 && back
      && resumes.length === 1 && !squadJoins(f).length && !roomJoins(f).length && after === '') {
    ok('D10: a tap that waited on a held seat is dropped when the seat is restored: the player is back in the match and no join is sent');
  } else fail(`D10: restored seat + tap — seated ${seated}, taps ${JSON.stringify(t)}, parked ${JSON.stringify(parked)}, held ${held}, back ${back}, resumes ${JSON.stringify(resumes)}, joins ${JSON.stringify(f.filter((m) => m.type === 'join' || m.type === 'squad'))}, parked after ${JSON.stringify(after)}`);
}
{
  // ONE SLOT, AND THE NEWEST TAP WINS. Two taps wait on a held seat's resume:
  // once it is refused, only the second goes. And a tap that is acted on at
  // once spends one still waiting, so a later flush cannot drag the player
  // to the older one; driven, as D4 is, by putting a tap in the slot and
  // calling the hello hook's flush after a tap that goes straight out.
  await seed(true);
  await holdNext(['resumeError']);
  await nav('');
  for (let i = 0; i < 30 && !(await tx()).some((m) => m.type === 'resume'); i++) await sleep(100);
  await fire('/?room=ABCD');
  await sleep(200);
  await fire('/?squad=ABCD');
  await sleep(300);
  const parked = await ev('pendingPushTap');
  await release();
  await sleep(700);
  const f = await tx();
  await ev(`(() => { window.__tx = []; pendingPushTap = '/?squad=ABCD'; onPushTap('/?room=ABCD'); flushPushTap(S.ws); return true; })()`);
  await sleep(500);
  const g = await tx(), after = await ev('pendingPushTap');
  if (parked === '/?squad=ABCD' && !roomJoins(f).length && squadJoins(f).length === 1
      && roomJoins(g).length === 1 && !squadJoins(g).length && after === '') {
    ok('D11: one slot, the newest tap wins: of two taps waiting on a refused resume only the second goes, and a tap acted on at once spends the one still waiting');
  } else fail(`D11: newest tap — parked ${JSON.stringify(parked)}, after the refusal ${JSON.stringify(f.filter((m) => m.type === 'join' || m.type === 'squad'))}, after a direct tap and a flush ${JSON.stringify(g.filter((m) => m.type === 'join' || m.type === 'squad'))}, slot ${JSON.stringify(after)}`);
}
{
  await seed(false);
  await nav('');
  const before = await ev(`window.__cap.count('pushNotificationActionPerformed')`);
  await ev('enableNativePings().then(() => true)');
  const calls = await capCalls(), after = await ev(`window.__cap.count('pushNotificationActionPerformed')`);
  await ev(`(() => { window.__tx = []; window.__cap.fire('pushNotificationActionPerformed', { actionId: 'tap', notification: { data: { url: '/?room=ABCD' } } }); return true; })()`);
  await sleep(500);
  const r = roomJoins(await tx());
  const asked = ['removeAllListeners', 'requestPermissions', 'register'].every((c) => calls.includes(c));
  if (before === 1 && after === 1 && asked && r.length === 1 && r[0].code === 'ABCD') {
    ok('D6: Nudges (enableNativePings) clears every listener and re-adds exactly one tap listener; one tap then sends one join');
  } else fail(`D6: after Nudges — tap listeners ${before} -> ${after}, calls ${JSON.stringify(calls)}, joins ${JSON.stringify(r)}`);
}
{
  // THE INTRO (build 7) PLAYS ON A LAUNCH TAP: a tap is not in the URL, so
  // BOOT_CLAIM is null when intro.js decides. A squad invite keeps the player on
  // home, so the intro must run to its own end with the menu handed over intact.
  await seed(false);
  await plant('/?squad=ABCD', true);
  await nav('');
  const st = await introEnded();
  const t = await taps(), s = squadJoins(await tx()), left = await introLeft(), scr = await ev("document.getElementById('bay').dataset.scr");
  if (t.length === 1 && t[0].intro === 'running' && st && st.reason === 'done' && s.length === 1 && s[0].code === 'ABCD' && !left && scr === 'home') {
    ok('D7: a squad tap that lands while the intro plays sends one join, and the intro still runs to its end and hands over the menu');
  } else fail(`D7: squad tap during the intro — taps ${JSON.stringify(t)}, intro ${JSON.stringify(st)}, squad ${JSON.stringify(s)}, overlay or inert left ${left}, screen ${scr}`);
}
{
  // A room tap goes somewhere: the match starting takes the bay off screen, and
  // the intro's own abort hands over to the match with nothing left behind.
  const host = await hostRoom();
  await seed(false);
  await plant(`/?room=${host.code}`, true);
  await nav('');
  const seated = await seatedIn(host.code);
  const st = await introEnded();
  const t = await taps(), r = roomJoins(await tx()), left = await introLeft();
  host.close();
  if (t.length === 1 && t[0].intro === 'running' && seated && r.length === 1 && st && st.reason === 'abort' && !left) {
    ok('D8: a room tap that lands while the intro plays takes the seat, and the intro steps aside cleanly (abort, no overlay, nothing inert)');
  } else fail(`D8: room tap during the intro — taps ${JSON.stringify(t)}, seated ${seated}, joins ${JSON.stringify(r)}, intro ${JSON.stringify(st)}, overlay or inert left ${left}`);
}

// ---- D12-D16. A SQUAD LINK THAT OPENS THE APP (owner, 2026-10-10) ----------
// "Tapping the link opens the app straight into the squad if your friend has
// it." iOS opens the app with https://<host>/squad/CODE (the AASA claims
// /squad/*), cold or warm, through @capacitor/app's appUrlOpen, and the app
// joins it by the push tap's rules (onPushTap): it waits for the socket's
// hello, a held seat's resume wins, a match in progress says so. Every frame
// goes to this suite's own server; the link's host is only ever a string here.
const SQ_URL = PUB + '/squad/ABCD';
const plantUrl = (u) => ev(`(sessionStorage.setItem('cc_test_url', ${JSON.stringify(u)}), true)`);
const openNow = (u) => ev(`(window.__cap.open(${JSON.stringify(u)}), true)`);
const urls = () => ev('JSON.stringify(window.__urls)').then(JSON.parse);
const appCalls = () => ev('JSON.stringify(window.__cap.appCalls)').then(JSON.parse);
{
  await seed(false);
  await plantUrl(SQ_URL);
  await nav('');
  const f = await tx(), s = squadJoins(f), r = roomJoins(f), u = await urls(), m = await sentSquadJoins(), calls = await appCalls(), heard = await said();
  if (u.length === 1 && u[0].connected === false && s.length === 1 && s[0].code === 'ABCD' && !r.length && m.length === 1 && m[0].intro > 0
      && JSON.stringify(calls) === '["addListener:appUrlOpen"]' && !heard.toasts.some((x) => /Reconnecting|No connection|Sign/.test(x)) && !heard.homeError.length) {
    ok('D12: a squad link that launched the app (cold) is held until boot listens, lands before the socket opens, and sends one squad join once the hello has settled, quietly');
  } else fail(`D12: cold squad link — urls ${JSON.stringify(u)}, squad ${JSON.stringify(s)}, room ${JSON.stringify(r)}, sent ${JSON.stringify(m)}, plugin calls ${JSON.stringify(calls)}, said ${JSON.stringify(heard)}`);
}
{
  // WARM: the app is open and connected. A squad link joins; a link of any
  // other shape opens the app and does nothing, as before (the old ?squad=
  // shape included: iOS never opens the app with it, and the web reads it at
  // boot, unchanged); a squad link carrying a fragment is still a squad link.
  await ev('(window.__tx = [], window.__sent = [], true)');
  await openNow(SQ_URL);
  await sleep(500);
  const a = squadJoins(await tx());
  await ev('(window.__tx = [], true)');
  for (const u of ['https://evil.example/squad/WXYZ', 'http://tanks.abarabrothers.com/squad/WXYZ', PUB + '/?squad=WXYZ', 'capacitor://localhost/squad/WXYZ', PUB + '/squad/WXYZ/x']) await openNow(u);
  await sleep(500);
  const b = await tx();
  await ev('(window.__tx = [], true)');
  await openNow(PUB + '/squad/WXYZ#access_token=t&refresh_token=r');
  await sleep(500);
  const c = squadJoins(await tx());
  if (a.length === 1 && a[0].code === 'ABCD' && !squadJoins(b).length && !roomJoins(b).length && c.length === 1 && c[0].code === 'WXYZ') {
    ok('D13: a squad link opening the running app (warm) sends one join; five other shapes send nothing; a squad link with a fragment is still read as the squad');
  } else fail(`D13: warm — squad link ${JSON.stringify(a)}, other shapes ${JSON.stringify(b.filter((x) => x.type === 'join' || x.type === 'squad'))}, with a fragment ${JSON.stringify(c)}`);
}
{
  // A HELD SEAT'S RESUME WINS, as it does over a push tap (D5): the link waits
  // for the answer, and goes once the resume is refused.
  await seed(true);
  await holdNext(['resumeError']);
  await plantUrl(SQ_URL);
  await nav('');
  const u = await urls(), early = squadJoins(await tx()), parked = await ev('pendingPushTap'), held = await ev('window.__held ? window.__held.length : -1');
  const n = await release();
  await sleep(700);
  const f = await tx(), j = squadJoins(f), resumes = f.filter((m) => m.type === 'resume' && m.code === 'WXYZ');
  const after = await ev('pendingPushTap'), rec = await ev(`localStorage.getItem('cc_resume')`);
  if (u.length === 1 && u[0].resume === true && !early.length && parked === '/?squad=ABCD' && held === 1 && n === 1
      && resumes.length === 1 && j.length === 1 && j[0].code === 'ABCD' && f.indexOf(j[0]) > f.indexOf(resumes[0]) && after === '' && rec === null) {
    ok('D14: a squad link landing while a held seat\'s resume is unanswered waits; the resume is refused, and the link then joins once, after it');
  } else fail(`D14: held seat + squad link — urls ${JSON.stringify(u)}, early ${JSON.stringify(early)}, parked ${JSON.stringify(parked)}, held ${held}, released ${n}, resumes ${JSON.stringify(resumes)}, joins ${JSON.stringify(j)}, parked after ${JSON.stringify(after)}, record ${rec}`);
}
{
  // AND A HELD SEAT THAT IS RESTORED KEEPS THE PLAYER IN THE MATCH (D10): the
  // waiting link is dropped and no join is sent.
  const host = await hostRoom();
  await seed(false);
  await plant(`/?room=${host.code}`);
  await nav('');
  const seated = await seatedIn(host.code);
  await holdNext(['restore']);
  await plantUrl(SQ_URL);
  await nav('');
  const u = await urls(), parked = await ev('pendingPushTap');
  await release();
  const back = await seatedIn(host.code);
  await sleep(700);
  const f = await tx(), after = await ev('pendingPushTap');
  host.close();
  if (seated && u.length === 1 && u[0].resume === true && parked === '/?squad=ABCD' && back && !squadJoins(f).length && !roomJoins(f).length && after === '') {
    ok('D15: a squad link that waited on a held seat is dropped when the seat is restored: the player is back in the match and no join is sent');
  } else fail(`D15: restored seat + squad link — seated ${seated}, urls ${JSON.stringify(u)}, parked ${JSON.stringify(parked)}, back ${back}, joins ${JSON.stringify(f.filter((m) => m.type === 'join' || m.type === 'squad'))}, parked after ${JSON.stringify(after)}`);
}
{
  // A MATCH IN PROGRESS OUTRANKS THE LINK, and says so (C4).
  await seed(false);
  await nav('');
  await ev('(window.__tx = [], S.playing = true, S.code = "WXYZ", true)');
  await openNow(SQ_URL);
  let seen = '';
  for (let i = 0; i < 30; i++) { seen = await ev('document.body.innerText || ""'); if (seen.includes('Finish this match first')) break; await sleep(120); }
  const f = await tx();
  await ev('(S.playing = false, S.code = null, true)');
  if (!squadJoins(f).length && !roomJoins(f).length && seen.includes('Finish this match first')) ok('D16: a squad link during a match sends nothing and says so out loud');
  else fail(`D16: squad link during a match sent ${JSON.stringify(f.filter((m) => m.type === 'join' || m.type === 'squad'))}, body=${JSON.stringify(seen.slice(0, 160))}`);
}
{
  // THE NATIVE PAGE BUILDS THE SAME PUBLIC LINK: the app's origin is never in it.
  const l = await ev(`JSON.stringify({ native: IS_NATIVE, link: squadLink('abcd') })`).then(JSON.parse);
  if (l.native === true && l.link === SQ_URL) ok(`D17: in the native page squadLink builds ${SQ_URL}, never the app's own origin`);
  else fail(`D17: native squadLink ${JSON.stringify(l)}`);
}

console.log(errors.length ? `\n${errors.length} FAILED` : '\nall deeplink checks passed');
process.exit(errors.length ? 1 : 0);
