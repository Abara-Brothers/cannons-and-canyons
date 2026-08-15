// Store-screenshot renderer for the iPad and Android sizes.
//
//   node render.mjs <width> <height> <outDir> [--keep]
//
// The Android and iPad shells are Capacitor WebViews around the same bundle the
// dev server serves, so rendering that bundle at the exact store viewport gives
// a native-resolution frame with no upscaling — which is the only way to hit
// 2752x2064 and 2560x1600 without an iPad in landscape or an Android AVD.
//
// Drives the real UI through CDP touch events at element centres (never guessed
// pixels), so the flow is the same one a player walks through.

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The store size is in DEVICE pixels; the layout is driven by CSS pixels, so the
// device-pixel-ratio matters as much as the output size. Rendering 2752x2064 at
// dpr 1 makes the app believe it has a 2752px-wide viewport and it lays out for
// a wall, not an iPad. Render at cssW x cssH and let dpr scale it up instead.
const [W, H, DPR, OUT] =
  [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4]), process.argv[5]];
if (!W || !H || !DPR || !OUT) {
  console.error('usage: render.mjs <deviceW> <deviceH> <dpr> <outDir>'); process.exit(1);
}
const CSS_W = Math.round(W / DPR), CSS_H = Math.round(H / DPR);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = 'http://localhost:3000';
const PORT = 9222 + (W % 37) + (DPR * 3);
const PROFILE = join(tmpdir(), `cc-shot-${W}x${H}x${DPR}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// A crashed run leaves Chrome holding the debug port; the next launch then
// silently attaches to that stale browser and drives whatever it was doing.
try { execSync(`pkill -f 'cc-shot-${W}x${H}x${DPR}'`, { stdio: 'ignore' }); } catch {}
await sleep(600);
rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  `--window-size=${CSS_W},${CSS_H}`, '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  // rAF stops in a backgrounded renderer and the canvas comes back blank.
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  'about:blank',
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
const events = [];

function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error('Chrome did not expose a debugger target');
}

const url = await connect();
ws = new WebSocket(url);
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  } else if (m.method) events.push(m);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: CSS_W, height: CSS_H, deviceScaleFactor: DPR, mobile: true,
  screenWidth: CSS_W, screenHeight: CSS_H,
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
// Without this the page reports itself hidden and the game loop never advances.
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
  return r.result.value;
}

/** Centre of the first element matching sel, in viewport CSS px, or null. */
async function centre(sel, index = 0) {
  return evalJs(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
    const el = els[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

async function tap(sel, { hold = 60, index = 0, optional = false, timeout = 8000 } = {}) {
  // Poll: modals animate in and the menu is built after the bundle boots, so a
  // one-shot lookup is a coin flip.
  let c = null;
  for (let waited = 0; waited <= timeout; waited += 250) {
    c = await centre(sel, index);
    if (c) break;
    if (optional && waited >= 1500) break;
    await sleep(250);
  }
  if (!c) {
    if (optional) return false;
    throw new Error(`no visible element for ${sel}[${index}]`);
  }
  const pt = [{ x: c.x, y: c.y, radiusX: 12, radiusY: 12, force: 1 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await sleep(hold);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(180);
  return true;
}

async function grab() {
  const { data } = await send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false, fromSurface: true, optimizeForSpeed: false });
  return Buffer.from(data, 'base64');
}

async function shot(name) {
  writeFileSync(join(OUT, `${name}.png`), await grab());
  console.log(`  ${name}.png`);
}

/**
 * Explosions last a few frames and a single timed capture usually misses them.
 * Sample the window and keep the busiest frame — PNG size tracks detail, so the
 * blast is reliably the largest buffer in the set.
 */
async function shotBusiest(name, count, gapMs) {
  let best = null;
  for (let i = 0; i < count; i++) {
    const buf = await grab();
    if (!best || buf.length > best.length) best = buf;
    if (i < count - 1) await sleep(gapMs);
  }
  writeFileSync(join(OUT, `${name}.png`), best);
  console.log(`  ${name}.png (busiest of ${count})`);
}

/** Land on the menu. The app resumes an unfinished match, so clear state first. */
async function go() {
  await send('Page.navigate', { url: ORIGIN });
  await sleep(1200);
  // Drop only the resume token — wiping all of localStorage would also reset the
  // callsign and re-arm first-run state on every mode.
  await evalJs(`try { localStorage.removeItem('cc_resume'); } catch(e) {} 1`).catch(() => {});
  await send('Page.navigate', { url: ORIGIN });
  await sleep(3500);
  const ok = await evalJs(`!!document.querySelector('[data-mode="duel"]')`).catch(() => false);
  if (!ok) { await sleep(2500); }
}

/** Fill the armoury when the modal demands more picks, then close it. */
async function armoury() {
  const need = await evalJs(`(() => {
    const m = document.getElementById('armouryModal');
    if (!m || m.classList.contains('hidden') || !m.offsetParent) return 0;
    const btn = document.getElementById('armouryCloseBtn');
    const t = (btn?.textContent || '').match(/Pick (\\d+) more/);
    return t ? Number(t[1]) : 0;
  })()`);
  for (let i = 0; i < need; i++) {
    // Selected cells carry `.picked`; anything else in the grid is still free.
    const ok = await tap('#armouryGrid .arm-cell:not(.picked)', { optional: true });
    if (!ok) break;
    await sleep(200);
  }
  await tap('#armouryCloseBtn', { optional: true });
  // The first turn plays a canvas-drawn aim demo (hand + "LONGER PULL = MORE
  // POWER"). It is not DOM, so it cannot be hidden — just let it finish.
  await sleep(4200);
}

const log = (s) => console.log(`[${W}x${H}] ${s}`);
/** Hold a dock stepper (0 ‹ angle, 1 › angle, 2 – power, 3 + power) for its repeat. */
const step = (i, hold) => tap('#dock .mini', { index: i, hold, optional: true });

// ---------------------------------------------------------------- home
log('home');
await go();
await shot('07-home');

// ---------------------------------------------------------------- duel vs CPU
log('duel');
await tap('[data-mode="duel"]');
await tap('[data-opp="cpu"]');
await tap('#createBtn');
await sleep(1400);
await armoury();
await tap('#dockTab', { optional: true });          // open angle/power/weapons
await sleep(600);
await step(3, 1400);                                 // wind the power up for a long arc
await sleep(400);
await shot('01-aim');

// close the dock, load napalm, fire, and grab the flight and the impact
await tap('#dockTab', { optional: true });
await sleep(400);
await tap('#weaponStrip [data-wid="napalm"]', { optional: true });
await sleep(400);
await tap('#fireBtn', { hold: 260 });
await sleep(700);
await shot('02-strike');                             // salvo still in the air
await shotBusiest('03-impact', 14, 320);             // ~4.5s window over the blast

// ---------------------------------------------------------------- boss
log('boss');
await go();                                          // a reload lands on the menu, no forfeit dance
await tap('[data-mode="boss"]');
await tap('#createBtn');
await sleep(900);
await tap('#startMatchBtn', { optional: true });
await sleep(1400);
await armoury();
await sleep(800);
await tap('#dockTab', { optional: true });
await step(3, 1400);
await tap('#dockTab', { optional: true });
await sleep(300);
await tap('#fireBtn', { hold: 260, optional: true });
await sleep(2800);
await shot('04-boss');

// ---------------------------------------------------------------- aliens
log('aliens');
await go();
await tap('[data-mode="aliens"]');
await tap('#createBtn');
await sleep(900);
await tap('#startMatchBtn', { optional: true });
await sleep(1400);
await armoury();
await sleep(900);
// The xeno line spawns off to the right of the opening view; #zoomctl is already
// on screen in a match, so pan straight across until the wave is in frame.
for (let i = 0; i < 4; i++) { await tap('#panRight', { hold: 420, optional: true }); }
await sleep(700);
await shot('05-aliens');

// ---------------------------------------------------------------- golf
log('golf');
await go();
await tap('[data-mode="golf"]');
await tap('#createBtn');
await sleep(900);
await tap('#startMatchBtn', { optional: true });
await sleep(5200);                                   // let the aim demo clear
await shot('06-golf');

ws.close();
chrome.kill();
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
console.log(`[${W}x${H}] done -> ${OUT}`);
process.exit(0);
