// The iOS launch image: the cold-start intro's own frame 0, the sealed bay
// doors, rendered by public/intro.js itself on a 2732 square at 1x.
//
// WHY IT IS RENDERED, NOT DRAWN. iOS shows the launch image aspect-fill
// (centred, scaled from the screen's long side) and the intro lays its door
// texture out the same way, so on every iPhone and iPad the launch screen and
// the intro's first frame are the same picture and the hand-off is invisible.
// That only holds while this PNG is exactly what intro.js paints, so the PNG
// is produced by intro.js and nothing else. test/intro.mjs renders frame 0 the
// same way and fails if the committed image has drifted from it.
//
//   node tools/splash/render-doors.mjs
//
// Writes ios/App/App/Assets.xcassets/LaunchDoors.imageset/launch-doors.png (8-bit
// RGB, losslessly packed by doors-png.mjs) and points Contents.json at it. Re-run after any change to the door painter in
// intro.js, then rebuild the app. The old Splash imageset (tools/splash/
// make-splash.sh) is no longer used by the launch screen and cannot overwrite
// this one.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCanvasRGB, encodeRGB, decodeRGB } from './doors-png.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SET = join(ROOT, 'ios/App/App/Assets.xcassets/LaunchDoors.imageset');
const FILE = 'launch-doors.png';
const SIDE = 2732;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.error(`no Chrome at ${CHROME} (set CHROME_PATH)`); process.exit(1); }
if (!existsSync(SET)) { console.error(`no imageset at ${SET}`); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
let srv = null, chrome = null, profile = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {}
  try { srv && srv.kill('SIGTERM'); } catch {}
  try { profile && rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

const appPort = await freePort();
srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { console.error('server never came up'); process.exit(1); }

const dbg = await freePort();
profile = join(tmpdir(), `cc-doors-${dbg}`);
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--mute-audio', '--hide-scrollbars', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {}
  await sleep(250);
}
if (!wsUrl) { console.error('Chrome exposed no debugger'); process.exit(1); }
let id = 0; const pending = new Map();
const ws = new WebSocket(wsUrl); await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: SIDE, height: SIDE, deviceScaleFactor: 1, mobile: false });
// window.__ccIntroFrame0 makes intro.js draw frame 0 and never start its clock.
await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__ccIntroFrame0 = true; try { localStorage.setItem('pt_name', 'PILOT'); } catch (e) {}" });
await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
let state = null;
for (let i = 0; i < 100; i++) { state = await ev('window.__ccIntro && window.__ccIntro.state').catch(() => null); if (state === 'running') break; await sleep(100); }
if (state !== 'running') { console.error('the intro never started: ' + state); process.exit(1); }
await sleep(600);
const size = await ev("(() => { const cv = document.getElementById('intro'); return cv ? cv.width + 'x' + cv.height : 'missing'; })()");
if (size !== `${SIDE}x${SIDE}`) { console.error('the canvas is ' + size); process.exit(1); }
const { rgb, opaque } = await readCanvasRGB(ev, SIDE, SIDE);
if (!opaque) { console.error('frame 0 is not fully opaque'); process.exit(1); }
const png = encodeRGB(rgb, SIDE, SIDE);
// what goes into the app must read back as exactly the pixels Chrome painted
if (!decodeRGB(png).rgb.equals(rgb)) { console.error('the PNG does not round-trip'); process.exit(1); }
if (png.length < 100000) { console.error(`suspiciously small render (${png.length} bytes)`); process.exit(1); }
writeFileSync(join(SET, FILE), png);
writeFileSync(join(SET, 'Contents.json'), JSON.stringify({
  images: ['1x', '2x', '3x'].map((scale) => ({ idiom: 'universal', filename: FILE, scale })),
  info: { version: 1, author: 'xcode' },
}, null, 2) + '\n');
for (const f of readdirSync(SET)) if (f.endsWith('.png') && f !== FILE) unlinkSync(join(SET, f));
console.log(`wrote ${FILE} (${png.length} bytes, ${SIDE}x${SIDE}) and pointed Contents.json at it`);
cleanup();
process.exit(0);
