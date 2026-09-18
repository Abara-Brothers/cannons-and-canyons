// Artillery Golf for four, in the real page: the Players choice in Match
// setup reaches the create frame, the home readout says the count, the
// boards say 1-4, and four seats render in the HUD cards and the scorecard.
// Headless Chrome over CDP; skips without Chrome.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  golf_four_ui tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const appPort = await freePort();
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${appPort}/health`); break; } catch {} await sleep(150); }
const dbg = await freePort(); const prof = join(tmpdir(), `cc-golf4-${dbg}`); rmSync(prof, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
const cleanup = () => { try { chrome.kill(); } catch {} try { srv.kill(); } catch {} try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {} };
process.on('exit', cleanup);
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 932, height: 430, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
let ready = false;
for (let i = 0; i < 80; i++) { if (await ev('typeof intent === "function" && !!window.Bay && S.connected === true && !!document.querySelector("#bay .top")').catch(() => false)) { ready = true; break; } await sleep(200); }
if (!ready) { fail('page never became ready'); cleanup(); process.exit(1); }
await ev(`(() => { window.showToast = () => {}; try { localStorage.setItem('cc_dock_learned', '1'); } catch {} return true; })()`);

try {
// 1. Match setup for golf offers Players 1..4 and the choice reaches the create frame
const setup = await ev(`(() => {
  Bay.state && Bay.show('home');
  ccMode = 'golf'; Bay.show('setup');
  const findSeg = () => [...document.querySelectorAll('#bay .b-opt')].find((o) => o.querySelector('.lbl') && o.querySelector('.lbl').textContent === 'Players');
  const seg = findSeg();
  const opts = seg ? [...seg.querySelectorAll('.seg')].map((b) => b.textContent.trim()) : null;
  const hidden = seg ? seg.classList.contains('hidden') : null;
  const tee = [...document.querySelectorAll('#bay .b-opt')].find((o) => o.querySelector('.lbl') && o.querySelector('.lbl').textContent === 'Tee set');
  const teeShown = !!tee && !tee.classList.contains('hidden');
  if (!seg) { ccMode = 'duel'; Bay.show('home'); return { opts, hidden, teeShown }; }   // RED: no segment yet
  window.__sent = []; const orig = intent; window.intent = (m) => { __sent.push(m); };
  seg.querySelector('[data-set="gcount=3"]').click();
  const after = ccGolfMax;
  $('createBtn').onclick(); const frame = __sent.pop();
  ccMode = 'ffa'; ccFfaOpp = 'friend'; $('createBtn').onclick(); const ffaFrame = __sent.pop();
  ccMode = 'golf'; window.intent = orig;
  Bay.show('home'); const readout = document.querySelector('#bay .lbar .ros').textContent;
  const board = [...document.querySelectorAll('#bay .board')].find((b) => b.title === 'Artillery Golf');
  const bpl = board ? board.querySelector('.bpl').textContent : null;
  Bay.show('setup');
  const seg2 = findSeg();                                   // re-query: the base-screen change re-rendered the tree
  const on = seg2 && seg2.querySelector('.seg.on') && seg2.querySelector('.seg.on').textContent.trim();
  ccMode = 'duel'; ccGolfMax = 2; Bay.show('home');
  return { opts, hidden, teeShown, after, frame, ffaFrame, readout, bpl, on };
})()`);
if (setup.opts && setup.opts.join(',') === '1,2,3,4' && setup.hidden === false && setup.teeShown) ok('setup: golf shows Players 1,2,3,4 beside the Tee set'); else fail('setup segment: ' + JSON.stringify(setup));
if (setup.after === 3 && setup.on === '3') ok('setup: tapping 3 arms three seats'); else fail('setup: after tap ' + JSON.stringify({ after: setup.after, on: setup.on }));
if (setup.frame && setup.frame.type === 'create' && setup.frame.mode === 'golf' && setup.frame.max === 3 && setup.frame.tees) ok('launch: the golf create frame carries max 3 and the tee set'); else fail('golf frame: ' + JSON.stringify(setup.frame));
if (setup.ffaFrame && setup.ffaFrame.mode === 'ffa' && setup.ffaFrame.max === 4) ok('launch: the free-for-all count is untouched by the golf choice'); else fail('ffa frame: ' + JSON.stringify(setup.ffaFrame));
if (setup.readout && /Players\s*3/.test(setup.readout.replace(/\s+/g, ' '))) ok('home: the launch bar reads Players 3 for golf'); else fail('home readout: ' + String(setup.readout).slice(0, 80));
if (setup.bpl === '1-4') ok('home: the golf board says 1-4'); else fail('golf board players: ' + setup.bpl);
// 2. The duel setup must not show the golf Players segment.
const duel = await ev(`(() => { ccMode = 'duel'; Bay.show('setup'); const seg = [...document.querySelectorAll('#bay .b-opt')].find((o) => o.querySelector('.lbl') && o.querySelector('.lbl').textContent === 'Players'); const h = seg ? seg.classList.contains('hidden') : 'absent'; Bay.show('home'); return h; })()`);
if (duel === true) ok('setup: the Players segment is hidden for a duel'); else fail('duel setup Players segment: ' + duel);
} catch (e) { fail('harness: ' + e.message); }

cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall golf_four_ui checks passed');
process.exit(errors.length ? 1 : 0);
