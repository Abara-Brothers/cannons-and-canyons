// Layout geometry regression — the SECOND client-side suite, and the first that
// looks at layout at all.
//
// WHY THIS EXISTS. public/styles.css carries a HARD LANDSCAPE LOCK: in portrait
// the whole <body> is laid out at landscape dimensions and rotated 90 degrees,
// and ~17 further media-query blocks each carry a "portrait twin" phrased
// against those swapped axes. Changing any of that is a wide, hand-edited,
// entirely untested operation — the iPad reflow (ISSUE-039) rewrites 21 media
// queries at once. Every other suite in this repo would stay green through a
// total layout collapse, because none of them render anything.
//
// So this pins the geometry. It drives the REAL bundle in headless Chrome at a
// list of exact CSS viewports, walks the Launch Bay's screens, and records the
// measured box of every element that matters plus the resolved axis variables.
// A committed baseline turns "does the phone still look right?" from an eyeball
// judgement into a diff.
//
// IT IS A CHANGE DETECTOR, NOT A CORRECTNESS ORACLE. It cannot tell you the
// layout is good — only that it is the same as when someone last looked. That
// is exactly what is wanted while rewriting the media queries underneath it:
// the phone tiers must not move, and the iPad shapes are expected to.
//
//   node test/layout.mjs              compare against the baseline
//   node test/layout.mjs --update     rewrite the baseline (review the diff!)
//   node test/layout.mjs --only 932x430   one viewport
//
// Self-hosted: spawns its own server on a free port. Skips cleanly (exit 3)
// when Chrome is absent, so CI on a bare runner stays green — exit 0 would make
// run-all.sh score a suite that never ran as a PASS, which is the trap
// test/merge.mjs documents at its head.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE = join(ROOT, 'test', 'fixtures', 'layout-baseline.json');
const UPDATE = process.argv.includes('--update');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1] : null;
})();

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  console.log(`SKIP  layout tests — no Chrome at ${CHROME}`);
  console.log('      (set CHROME_PATH to run them)');
  process.exit(3);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// ---- the viewports ---------------------------------------------------------
// PHONE tiers are the regression guard: every one of these must be byte-identical
// across a layout change, because the native iPhone app is pinned landscape and
// phone-web portrait is explicitly promised to be untouched.
// IPAD/WINDOW shapes are the subject: they are EXPECTED to change, and the
// baseline records what they became so the next change is also a diff.
const VIEWPORTS = [
  // --- phone, landscape (what the native iPhone app always is) ---
  { name: '932x430', w: 932, h: 430, note: 'iPhone 16/17 Pro Max landscape' },
  { name: '844x390', w: 844, h: 390, note: 'iPhone 14/15 landscape' },
  { name: '667x375', w: 667, h: 375, note: 'iPhone SE landscape — tightest shipped' },
  { name: '568x320', w: 568, h: 320, note: 'smallest tier the CSS still targets' },
  // --- phone, portrait web (the rotation shim MUST still fire here) ---
  { name: '390x844', w: 390, h: 844, note: 'iPhone 14/15 portrait web — shim on' },
  { name: '440x956', w: 440, h: 956, note: 'widest iPhone portrait — shim on' },
  // --- iPad and resizable windows (the subject of the reflow) ---
  { name: '834x1194', w: 834, h: 1194, note: 'iPad Pro 11in portrait' },
  { name: '1194x834', w: 1194, h: 834, note: 'iPad Pro 11in landscape' },
  { name: '1024x1366', w: 1024, h: 1366, note: 'iPad Pro 13in portrait' },
  { name: '820x1180', w: 820, h: 1180, note: 'iPad Air / 10th gen portrait' },
  { name: '744x1133', w: 744, h: 1133, note: 'iPad mini portrait' },
  { name: '507x1194', w: 507, h: 1194, note: 'iPad half Split View' },
  { name: '320x1194', w: 320, h: 1194, note: 'iPad Slide Over — narrowest real window' },
  { name: '450x550', w: 450, h: 550, note: 'small square-ish window' },
];

const SCREENS = ['home', 'modes', 'armoury', 'career', 'paint', 'settings'];

// ---- server ----------------------------------------------------------------
const appPort = await freePort();
const srv = spawn('node', ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverUp = false;
for (let i = 0; i < 80; i++) {
  try { await fetch(`http://127.0.0.1:${appPort}/health`); serverUp = true; break; } catch {}
  await sleep(150);
}
if (!serverUp) { srv.kill(); console.error('FAIL  server never came up'); process.exit(1); }

// ---- browser ---------------------------------------------------------------
const dbgPort = await freePort();
const profile = join(tmpdir(), `cc-layout-${dbgPort}`);
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  'about:blank',
], { stdio: 'ignore' });

// Idempotent and never throws: it runs both explicitly and from the exit hook,
// and Chrome is often still flushing its profile when the first call lands —
// rmSync then raises ENOTEMPTY and takes the whole run down AFTER the work is
// already done, turning a green run into a stack trace.
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { chrome.kill(); } catch {}
  try { srv.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch {}
  await sleep(250);
}
if (!wsUrl) { cleanup(); console.error('FAIL  Chrome exposed no debugger'); process.exit(1); }

let id = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');

// ---- the probe -------------------------------------------------------------
// Rounded to whole pixels on purpose: sub-pixel noise between Chrome builds
// would make the baseline flap, and nothing in this layout is decided by a
// fraction of a pixel. Every element is OPTIONAL — a screen that does not carry
// one records null rather than failing, so the same probe serves every screen.
const PROBE = (screen) => `(() => {
  const r = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    if (!b.width && !b.height) return 'hidden';
    return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
  };
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  // getPropertyValue on a custom property returns the SPECIFIED value, so --u
  // reads back as its literal min(calc(...)) expression at every viewport and
  // detects nothing. Resolve it by spending it on a real length and measuring.
  // NOTE --u is a LENGTH, not a ratio: it is --bay-aw (px) divided by 932, so it
  // carries px. Multiply by a bare number — 'var(--u) * 1000px' is px*px, which
  // is invalid, and the width silently falls back to auto and measures 0.
  const resolveU = () => {
    const p = document.createElement('div');
    p.style.cssText = 'position:absolute;left:-9999px;top:0;height:0;width:calc(var(--u) * 1000)';
    document.body.appendChild(p);
    // getBoundingClientRect reports VIEWPORT coordinates, so under the rotation
    // shim this zero-height strip comes back as width 0 / height 1000u. Take
    // whichever axis carries it — one of the two is always 0.
    const b = p.getBoundingClientRect();
    p.remove();
    return Math.round(Math.max(b.width, b.height)) / 1000;
  };
  const fs = (sel) => {
    const e = document.querySelector(sel);
    return e ? Math.round(parseFloat(getComputedStyle(e).fontSize) * 10) / 10 : null;
  };
  return {
    screen: ${JSON.stringify(screen)},
    bodyTransform: getComputedStyle(document.body).transform,
    bodyBox: (() => { const b = document.body.getBoundingClientRect();
                      return [Math.round(b.width), Math.round(b.height)]; })(),
    vars: { vhu: v('--vhu'), vwu: v('--vwu'), dvhu: v('--dvhu'), dvwu: v('--dvwu'),
            u: resolveU(), rotated: v('--rotated') || '(unset)' },
    boxes: {
      bay:      r('#bay'),
      stage:    r('#bay .stage'),
      top:      r('#bay .top'),
      boards:   r('#bay .boards'),
      lbar:     r('#bay .lbar'),
      pnl:      r('#bay .pnl:not(.hidden)'),
      tankw:    r('#bay .tankw'),
      launch:   r('#bay [data-launch]'),
    },
    // Type size is the thing that degrades invisibly when a design frame is
    // scaled down: the boxes can all be in proportion while the words become
    // unreadable. Measured on the real rendered nodes.
    type: {
      title:    fs('#bay .top'),
      boardName: fs('#bay .board.on .bnm'),
      boardTag:  fs('#bay .board.on .btg'),
      lbarName:  fs('#bay .lbar .lnm'),
      lbarTag:   fs('#bay .lbar .ltg'),
    },
    overflow: (() => {
      const b = document.querySelector('#bay');
      if (!b) return null;
      return [b.scrollWidth > b.clientWidth, b.scrollHeight > b.clientHeight];
    })(),
  };
})()`;

// ---- run -------------------------------------------------------------------
const snapshot = {};
const targets = ONLY ? VIEWPORTS.filter((v) => v.name === ONLY) : VIEWPORTS;
if (!targets.length) { cleanup(); console.error(`FAIL  no viewport named ${ONLY}`); process.exit(1); }

for (const vp of targets) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: true,
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    ready = await evalJs('!!document.querySelector("#bay .stage") && typeof showScreen === "function"')
      .catch(() => false);
    if (ready) break;
    await sleep(200);
  }
  if (!ready) { cleanup(); console.error(`FAIL  ${vp.name} — app never booted`); process.exit(1); }
  await sleep(350);   // let fonts settle; a fallback face measures differently

  // FREEZE. The bay transitions its boards and stage (`transition: all`), and
  // the hero tank is a live canvas. Measuring mid-transition produced 1-2px
  // run-to-run drift on .tankw and [data-launch] — enough to fail five
  // viewports against a baseline captured minutes earlier from identical code.
  // A tolerance would have hidden real 1px regressions too, so kill the motion
  // instead of widening the assertion.
  await evalJs(`(() => {
    if (document.getElementById('cc-layout-freeze')) return;
    const st = document.createElement('style');
    st.id = 'cc-layout-freeze';
    st.textContent = '*,*::before,*::after{transition:none !important;animation:none !important;' +
                     'animation-duration:0s !important;transition-duration:0s !important;}';
    document.head.appendChild(st);
  })()`);
  await sleep(120);

  const perScreen = {};
  for (const s of SCREENS) {
    // Bay.show is the bay's own router (window.Bay = { show: render, ... }).
    await evalJs(`(() => { try { window.Bay && window.Bay.show(${JSON.stringify(s)}); } catch (e) {} })()`);
    await sleep(160);
    // Record only a measurement that REPEATS. Freezing motion removes the
    // cause; requiring two identical reads proves it for this run rather than
    // assuming it, and turns any residual nondeterminism into a loud failure
    // here instead of a mystery diff in someone's pull request.
    let prev = await evalJs(PROBE(s)), settled = null;
    for (let i = 0; i < 6; i++) {
      await sleep(140);
      const next = await evalJs(PROBE(s));
      if (JSON.stringify(next) === JSON.stringify(prev)) { settled = next; break; }
      prev = next;
    }
    if (!settled) {
      cleanup();
      console.error(`FAIL  ${vp.name}/${s} — geometry never settled across 6 reads.`);
      console.error('      Something is still animating or re-laying-out. Do not add a');
      console.error('      tolerance to hide this; find what is moving.');
      process.exit(1);
    }
    perScreen[s] = settled;
  }
  snapshot[vp.name] = { note: vp.note, screens: perScreen };
  console.log(`      captured ${vp.name.padEnd(10)} ${vp.note}`);
}

// ---- compare or write ------------------------------------------------------
cleanup();

if (UPDATE) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`\nWROTE baseline for ${Object.keys(snapshot).length} viewports -> test/fixtures/layout-baseline.json`);
  console.log('      Review the diff before committing. This file IS the assertion.');
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('FAIL  no baseline — run: node test/layout.mjs --update');
  process.exit(1);
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));

let pass = 0, fail = 0;
const diffs = [];
const walk = (a, b, path) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${path}.${k}`);
    return;
  }
  diffs.push(`${path}\n        baseline: ${JSON.stringify(a)}\n        now:      ${JSON.stringify(b)}`);
};

for (const vp of targets) {
  const want = base[vp.name], got = snapshot[vp.name];
  if (!want) {
    console.log(`SKIP  ${vp.name} — not in baseline (new viewport; run --update)`);
    continue;
  }
  const before = diffs.length;
  walk(want.screens, got.screens, vp.name);
  if (diffs.length === before) { pass++; console.log(`PASS  ${vp.name}  ${vp.note}`); }
  else { fail++; console.log(`FAIL  ${vp.name}  ${vp.note}`); }
}

if (diffs.length) {
  console.log('\n  differences:');
  for (const d of diffs.slice(0, 40)) console.log('    ' + d);
  if (diffs.length > 40) console.log(`    ... and ${diffs.length - 40} more`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
