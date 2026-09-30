// Deep links, in a real page: the ONE parser behind ?room=, ?squad= and the
// native notification tap, and the precedence that decides which of the three
// claimants on boot wins.
//
// WHY THIS EXISTS. Three defects, none of which any other suite can see:
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

console.log(errors.length ? `\n${errors.length} FAILED` : '\nall deeplink checks passed');
process.exit(errors.length ? 1 : 0);
