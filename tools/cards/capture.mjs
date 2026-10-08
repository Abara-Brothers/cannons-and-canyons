// THE MODE CARDS, CAPTURED FROM THE GAME (owner, 2026-10-07: "Each game mode
// card on the home menu dashboard needs to be the actual game mode ... use
// actual game footage or as close as possible to the actual design of the
// game"; his answer: real game scenes, styled).
//
//   node tools/cards/capture.mjs [--port 3105] [--only duel,golf] [--out DIR]
//                                [--raw DIR] [--sheet FILE] [--subjects FILE]
//                                [--explore DIR] [--raw DIR --burst N]
//
// For each mode this starts its OWN server (server.js on --port, default 3105,
// never production) with Math.random seeded (seeded-random.mjs), opens the
// game in headless Chrome over CDP, starts a real match of that mode the way a
// player does (home's Launch, then Match setup's Start Game), and then directs
// one moment of it with tools/cards/studio.js: combatants stood where the shot
// needs them, real shells flown by game-core's simulateShot, the moment frozen
// and drawn by the game's own draw(). Every pixel of the scene is the game's.
// What is staged is said plainly: the combatants are stood closer together
// than a match deals them (a whole duel spans 12,500-20,000 units, and at a
// card's size a tank across that is a few pixels), on the real map, and the
// shells in the air at once were fired for the picture. Most stand near their
// real spawns; Boss Fight's WARLORD-7 is stood on ground above the player's
// tank, and Alien Invasion's fight is stood on a shelf west of the player's
// spawn (see each scene for why).
//
// Each moment is cropped three ways, one per place a mode card is shown, at
// twice the largest size that place is ever drawn (an iPad Pro 13" in
// landscape, u = 1376 / 932, the widest the bay's 932-unit frame gets):
//   board - the home screen's mode boards   170 x 90 u, armed x1.04
//   tall  - the Mission board's pictures     166 x 184 u, hover x1.05
//   wide  - Match setup's brief image        450 x 132 u
// graded (colour, glow, tone, vignette; studio.js finish) and written as WebP
// to public/bay/card-<mode>-<shape>.webp, each held to MAX_BYTES.
//
// THE NAMED SUBJECTS STAND CLEAR (owner, 2026-10-07: Boss Fight must read at
// once as a boss fight, FFA shows four tanks, Aliens shows saucers raining
// fire). The bay lays a players pill, an offline badge, the mode's icon, its
// name and its tag line over these pictures, and a crop that put WARLORD-7's
// head or a saucer under the pill showed the mode's very subject covered. So
// each scene names its subjects, and for every crop the tool records the box
// each one was drawn in (studio.js boxes) in tools/cards/subjects.json, with
// the sha256 of the picture it was measured in. test/mode_cards.mjs (6) holds
// every box clear of every pill, badge, icon and label on every screen, in
// every state a card is shown in. A crop frames its subjects in the room
// those leave: on a home board, below the pill and above the name, or beside
// the name where the words end.
//
// DETERMINISTIC: two runs write byte-identical files. The server's map, biome
// and bots come from the seed; once the match is live the page runs on the
// studio's clock (seeded Math.random, a performance.now that moves only with
// its fixed 60 fps steps); and the canvas is rasterised in software. A scene
// names the biome it was framed for; if a seed ever stops giving it (a change
// to map generation), the tool searches the next seeds and says which to pin.
// All of it holds only while the server answering is the tool's own seeded
// one, so a port another server still holds is refused (see portFree).
//
// --raw DIR       also write each crop ungraded as PNG (to compare the grade)
// --sheet FILE    also write a contact sheet of every card, labelled
// --explore DIR   write a full-screen render of each started match and a JSON
//                 of its field (where everyone stands), for framing a scene
// --burst N       with --raw: instead of the cards, N frames of each wide crop
//                 1/20 s apart from the staged moment, to choose the moment
// --subjects FILE where the subjects' boxes go (default: beside this tool for
//                 the pictures in public/bay, beside the pictures for --out)
// After a capture: a NEW file must be added to public/sw.js SHELL under the
// ?v= stamp (house rule 7e checks it); commit tools/cards/subjects.json with
// the pictures it was written for; then run test/mode_cards.mjs.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.error(`no Chrome at ${CHROME} (set CHROME_PATH)`); process.exit(1); }

const arg = (name, fb) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fb; };
const PORT = Number(arg('port', process.env.PORT || 3105));
const OUT = arg('out', join(ROOT, 'public', 'bay'));
const RAW = arg('raw', null);
const SHEET = arg('sheet', null);
const EXPLORE = arg('explore', null);
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const BURST = Number(arg('burst', 0));   // explore: N raw frames of the wide crop, 1/20 s apart
const MAX_BYTES = 120000;
// The subjects' boxes go beside the tool for the pictures the app ships, and
// beside the pictures for any other --out.
const SUBJECTS = arg('subjects', OUT === join(ROOT, 'public', 'bay') ? join(HERE, 'subjects.json') : join(OUT, 'subjects.json'));

// THE THREE SHAPES. `u` is the box in bay units (styles.css: .bcard, .mbi,
// .brief .bi at the 932 x 430 frame); `out` is the file's pixel size, the
// box at its largest (u = 1376 / 932 on an iPad Pro 13", times the card's own
// lift where it has one) at 2x.
const U_MAX = 1376 / 932;
const SHAPES = {
  board: { u: [169.6, 90], lift: 1.04 },
  tall:  { u: [165.8, 184], lift: 1.05 },
  wide:  { u: [450.3, 132], lift: 1 },
};
// 1% of headroom: a box's size in units drifts by a fraction with the screen
// (its 1px borders do not scale), and it is largest on the largest screen.
for (const s of Object.values(SHAPES)) s.out = s.u.map((v) => Math.ceil(v * s.lift * U_MAX * 2 * 1.01));

// The battlefield is rendered as the game draws it on the 932 x 430 design
// screen, at RENDER_SS device pixels per game pixel, and the card is a crop of
// that screen the size of its box (1 game pixel per bay unit, so the shells,
// trails and sparks the game draws at a fixed screen size keep their real
// proportion to the card). The crop is centred across the screen, so it never
// reaches the sun the game draws at 84% of the width.
const VIEW = [932, 430];
const RENDER_SS = 4;
const CROP_CY = 262;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });

// ---- the scenes ---------------------------------------------------------------
// `stage` runs in the page once the match is live and it is the player's turn.
// It stands everyone, fires, steps to the moment and returns, per shape, the
// world point to centre (or the ground line and where it sits; see worldY),
// the zoom (game pixels per world unit) and `sy`, how far down the 430-high
// screen the crop sits, which picks the sky's band. `look` tunes the grade.
// It also returns `subjects`, the moment's named subjects (studio.js boxes:
// a seat, a shot or the cup), and a shape may list in `out` the ones its crop
// leaves wholly out; the test then holds those wholly out of that picture, so
// none is ever cut in half at its edge.
const SCENES = [
  // DUEL: two tanks trading shells. The foe's shell is over the top of its arc
  // and coming in; the player's gun has just answered.
  { mode: 'duel', biome: 'ice', seed: 11, look: { glow: 0.3, contrast: 1.14, saturate: 1.3 },
    stage: `(() => {
      const st = __studio, me = S.you, foe = 1 - me;
      const x0 = st.row([0, 4400], S.tanks[me].x), x1 = x0 + 4400;
      st.put(me, x0, { face: 1 }); st.put(foe, x1, { face: -1 });
      const b = st.solve(foe, 'cannon', [46, 42, 50], x0), a = st.solve(me, 'cannon', [44, 40, 48], x1);
      const D = Math.round(b.len * 0.5);
      st.fire([{ seat: foe, weapon: 'cannon', angle: b.angle, power: b.p }, { seat: me, weapon: 'cannon', angle: a.angle, power: a.p, delay: D }]);
      st.runTo(D); st.blastOf(me); st.run(0.12);
      const mx = (x0 + x1) / 2, gy = Math.min(S.tanks[me].y, S.tanks[foe].y);
      return { board: { x: mx, gy, g: 0.58, zoom: 0.03, sy: 150 }, tall: { x: mx, gy, g: 0.66, zoom: 0.0279, sy: 230 }, wide: { x: mx, gy, g: 0.74, zoom: 0.058, sy: 140 },
        subjects: [{ name: 'your tank', seat: me }, { name: "the computer's tank", seat: foe }, { name: "the computer's shell", shot: 0 }, { name: 'your shell', shot: 1 }] };
    })()` },
  // FREE-FOR-ALL: four tanks on one ridge line and a shell in the air from
  // each of them, both ways across the line, none of them landed yet: a
  // burst on a tank hid that tank, and the card is about four of them. They
  // stand 1,600 apart, on ground a little higher in the middle (the row's
  // `rise`), so on a home board the middle two stand above the name and the
  // end two beside it, below the icon and the players pill.
  { mode: 'ffa', biome: 'desert', seed: 22, look: { glow: 0.25 },
    stage: `(() => {
      const st = __studio, SP = 1600, a = st.row([0, SP, 2 * SP, 3 * SP], S.world.w / 2 - 1.5 * SP, 9000, [0, 250, 250, 0]), xs = [0, 1, 2, 3].map((k) => a + k * SP);
      xs.forEach((x, i) => st.put(i, x, { face: i < 2 ? 1 : -1 }));
      const plan = [[0, 'cannon', [42, 38, 46], 2, 0.56], [3, 'cannon', [44, 40, 48], 1, 0.44], [1, 'mortar', [52, 48, 56], 3, 0.34], [2, 'cannon', [40, 36, 44], 0, 0.66]];
      const sol = plan.map(([seat, w, angs, at]) => st.solve(seat, w, angs, xs[at]));
      const T = Math.max(...sol.map((q, k) => Math.round(q.len * plan[k][4])));
      st.fire(plan.map(([seat, w], k) => ({ seat, weapon: w, angle: sol[k].angle, power: sol[k].p, delay: T - Math.round(sol[k].len * plan[k][4]) })));
      st.runTo(T);
      const mx = (xs[0] + xs[3]) / 2, gy = Math.min(...xs.map((x) => st.groundAt(x)));
      return { board: { x: mx + 46, gy, g: 0.462, zoom: 0.026, sy: 170 }, tall: { x: mx, gy, g: 0.62, zoom: 0.0259, sy: 220 }, wide: { x: mx, gy, g: 0.5, zoom: 0.05, sy: 170 },
        subjects: xs.map((x, i) => ({ name: 'tank ' + (i + 1), seat: i })) };
    })()` },
  // BOSS FIGHT: WARLORD-7 towering over the player's tank from the ground
  // about 560 above it, its rocket rack raining down as the player's gun
  // fires back. They stand 1,450 apart so that on a home board WARLORD-7
  // fits whole between the icon and the players pill, above the name, with
  // the tank below it beside the name.
  { mode: 'boss', biome: 'volcanic', seed: 32,
    stage: `(() => {
      const st = __studio, me = S.you, B = S.boss, D = 1450;
      const x0 = st.row([0, D], S.tanks[B].x - D, 9000, [0, 630]), bx = x0 + D;
      st.put(me, x0, { face: 1 }); st.put(B, bx, { face: -1 });
      const c = st.solve(me, 'cannon', [52, 48, 56, 60, 44], bx), h = st.solve(B, 'b_hellstorm', [72, 68, 76, 64, 80], x0 - 500);
      const T = Math.round(h.len * 0.78);
      st.fire([{ seat: B, weapon: 'b_hellstorm', angle: h.angle, power: h.p }, { seat: me, weapon: 'cannon', angle: c.angle, power: c.p, delay: T }]);
      st.runTo(T); st.blastOf(me); st.run(0.1);
      const gy = S.tanks[B].y;
      return { board: { x: bx + 1200, gy, g: 0.505, zoom: 0.025, sy: 190 }, tall: { x: (x0 + bx) / 2 + 250, gy, g: 0.6, zoom: 0.045, sy: 230 }, wide: { x: (x0 + bx) / 2 + 600, gy, g: 0.56, zoom: 0.045, sy: 200 },
        subjects: [{ name: 'WARLORD-7', seat: B }, { name: 'your tank', seat: me }] };
    })()` },
  // ALIEN INVASION: the saucers hold the high ground and rain plasma down on
  // the player's tank, three bolts in the air at once, on low arcs coming in.
  // On a home board the saucers stand in the strip between the players pill
  // and the name, so they need a shelf where all three float within about 60
  // world units of one height. A search of the ruins maps of seeds 40 to 75
  // found the best one on seed 73, at x 3,100, west of the player's spawn.
  // The Mission board's tall crop holds two of the three, at a size that
  // reads, and the third is left wholly out of it.
  { mode: 'aliens', biome: 'ruins', seed: 73,
    stage: `(() => {
      const st = __studio, me = S.you;
      const al = S.kinds.map((k, i) => (k === 'alien' ? i : -1)).filter((i) => i >= 0);
      const offs = [0, 2400, 4000, 5450], x0 = st.row(offs, 3100, 300, [0, 450, 450, 450]);
      st.put(me, x0, { face: 1 });
      al.forEach((s, k) => st.put(s, x0 + offs[k + 1], { face: -1 }));
      const ang = [[38, 36, 40], [38, 36, 40], [40, 38, 42]], at = [x0 - 400, x0 + 300, x0 + 900], part = [0.92, 0.78, 0.72];
      const sol = al.map((s, k) => st.solve(s, 'a_plasma', ang[k], at[k]));
      const T = Math.max(...sol.map((q, k) => Math.round(q.len * part[k])));
      st.fire(al.map((s, k) => ({ seat: s, weapon: 'a_plasma', angle: sol[k].angle, power: sol[k].p, delay: T - Math.round(sol[k].len * part[k]) })));
      st.runTo(T);
      const y0 = S.tanks[me].y;
      return { board: { x: x0 + 2833, gy: y0, g: 0.627, zoom: 0.024, sy: 190 }, tall: { x: x0 + 2001, gy: y0, g: 0.64, zoom: 0.0302, sy: 230, out: ['saucer 3'] }, wide: { x: x0 + 3300, gy: y0, g: 0.65, zoom: 0.05, sy: 190 },
        subjects: al.map((s, k) => ({ name: 'saucer ' + (k + 1), seat: s })).concat(al.map((s, k) => ({ name: 'plasma bolt ' + (k + 1), shot: k })), [{ name: 'your tank', seat: me }]) };
    })()` },
  // ARTILLERY GOLF: the ball coming down out of its arc toward the flag, the
  // shot played with the Iron from the fairway past the water. The moment is
  // late in the flight, the ball low and near the flag, so on a home board
  // both stand left of the players pill and above the name.
  { mode: 'golf', biome: 'alpine', seed: 51, look: { glow: 0.3 },
    stage: `(() => {
      const st = __studio, me = S.you, cup = S.golf.cup;
      const x0 = st.row([0], cup.x - 3900, 600);
      st.put(me, x0, { face: 1 });
      const w = st.solve(me, 'golfball', [40, 36, 44], cup.x - 250, true);
      st.fire([{ seat: me, weapon: 'golfball', angle: w.angle, power: w.p }]);
      st.runTo(Math.round(w.land * 0.88));
      const gy = cup.y;
      return { board: { x: cup.x - 829, gy, g: 0.479, zoom: 0.03, sy: 170 }, tall: { x: cup.x - 388, gy, g: 0.678, zoom: 0.058, sy: 220 }, wide: { x: (x0 + cup.x) / 2, gy, g: 0.74, zoom: 0.058, sy: 170 },
        subjects: [{ name: 'the ball', shot: 0 }, { name: 'the flag', cup: true }] };
    })()` },
];

// ---- one Chrome for the whole run --------------------------------------------
let chrome = null, prof = null, srv = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {}
  try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });

const dbg = await freePort();
prof = join(tmpdir(), `cc-cards-${dbg}`); rmSync(prof, { recursive: true, force: true });
// Software rendering: a GPU-rasterised canvas anti-aliases its edges a little
// differently from run to run, and the cards should not change when nothing
// in the game did.
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
  '--mute-audio', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-gpu', '--disable-accelerated-2d-canvas', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl; } catch {}
  if (!wsUrl) await sleep(200);
}
if (!wsUrl) { console.error('Chrome never offered a page'); process.exit(1); }
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
const pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails || {}; pageErrors.push((d.exception && d.exception.description) || d.text); return; }
  const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new Error(`CDP ${method} timed out`)); }, 60000);
  pend.set(i, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};
const until = async (expr, ms, step = 120) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(step); } return false; };

await send('Page.enable'); await send('Runtime.enable');
// No intro, no first-battle coaching, no aim demo, no resumed match: each would
// cover or replace the field. The page's Math.random is seeded like the
// server's, so sparks and smoke land the same way every run.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__ccNoIntro = true;
  try { localStorage.setItem('cc_coach', '1'); localStorage.setItem('cc_aim_guide', '1'); localStorage.removeItem('cc_resume'); } catch {}
  (() => { let a = 20261007; Math.random = function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();` });
await send('Emulation.setDeviceMetricsOverride', { width: 932, height: 430, deviceScaleFactor: 2, mobile: false });

// ---- a server per scene, on the one port --------------------------------------
// THE PORT IS TRIED THE WAY server.js TAKES IT: server.listen(PORT) with no
// host, every address. A check on 127.0.0.1 alone passes while a stale server
// still holds the port on every address (a crashed run's child, say); the new
// server then fails to start, the stale one answers /health, and the cards are
// drawn from its unseeded map, a different one every run.
async function portFree(port) {
  return new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port, () => s.close(() => res(true))); });
}
async function startServer(seed) {
  if (srv) { srv.kill('SIGKILL'); srv = null; }
  for (let i = 0; i < 50 && !(await portFree(PORT)); i++) await sleep(100);
  if (!(await portFree(PORT))) throw new Error(`port ${PORT} is busy: pass --port`);
  const me = spawn(process.execPath, ['--import', join(HERE, 'seeded-random.mjs'), 'server.js'],
    { cwd: ROOT, env: { ...process.env, PORT: String(PORT), CARD_SEED: String(seed) }, stdio: 'ignore' });
  let gone = false; me.once('exit', () => { gone = true; });
  srv = me;
  // Only OUR server may answer: one that exited (the port taken after all)
  // means whatever answers /health is somebody else's.
  for (let i = 0; i < 80; i++) {
    if (gone) throw new Error(`the seeded server exited before it answered: is port ${PORT} taken?`);
    try { await get(`http://127.0.0.1:${PORT}/health`); if (!gone) return; } catch {}
    await sleep(150);
  }
  throw new Error('server never came up');
}

const READY = `typeof intent === 'function' && typeof draw === 'function' && !!window.Bay && S.connected === true`;
async function startMatch(scene, seed) {
  await startServer(seed);
  await ev('window.__oldDoc = true').catch(() => {});
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  if (!(await until(`!window.__oldDoc && (${READY})`, 20000))) throw new Error('the page never came up ready');
  await until(`!!document.querySelector('#bay .launch')`, 8000);
  await ev(`(window.showToast = () => {}, true)`);
  // Home's Launch, then Match setup's Start Game: Computer for a duel and a
  // free-for-all (three CPUs), a run alone for the rest.
  await ev(`(() => { ccMode = ${JSON.stringify(scene.mode)}; ccMax = 4; Bay.show('home'); document.querySelector('#bay .launch').click();
    document.querySelector('#bay .pfoot [data-launch]').click(); return true; })()`);
  const live = `S.playing === true && S.mode === ${JSON.stringify(scene.mode)} && !S.picking && S.turn === S.you && !S.anim`;
  if (!(await until(live, 30000))) throw new Error(`${scene.mode}: the match never came round to the player: ` + JSON.stringify(await ev(`({ playing: S.playing, mode: S.mode, turn: S.turn, you: S.you, picking: S.picking })`)));
  return ev('S.biome');
}

// A frame names the world point at the crop's centre (x, y), or, instead of
// y, the ground line `gy` and the fraction `g` of the crop's height it should
// sit at: the bay lays each card's name over the bottom of its picture, so a
// scene stands its combatants just above that strip.
const worldY = (f, ch) => (f.y != null ? f.y : f.gy - (f.g - 0.5) * ch / f.zoom);

const files = [];
for (const scene of SCENES) {
  if (ONLY && !ONLY.includes(scene.mode)) continue;
  let seed = scene.seed, biome = await startMatch(scene, seed);
  for (let tries = 0; biome !== scene.biome && tries < 40; tries++) biome = await startMatch(scene, ++seed);
  if (biome !== scene.biome) throw new Error(`${scene.mode}: no seed from ${scene.seed} gives ${scene.biome}`);
  if (seed !== scene.seed) console.log(`NOTE ${scene.mode}: seed ${scene.seed} no longer gives ${scene.biome}; ${seed} does -- pin it in SCENES`);
  await ev(readFileSync(join(HERE, 'studio.js'), 'utf8'));
  await ev('__studio.init()');
  if (EXPLORE) {
    mkdirSync(EXPLORE, { recursive: true });
    const field = await ev(`({ you: S.you, n: S.n, biome: S.biome, tanks: S.tanks, kinds: S.kinds, boss: S.boss, world: S.world, golf: S.golf && { cup: S.golf.cup, tee: S.golf.tee, hazards: S.golf.hazards } })`);
    writeFileSync(join(EXPLORE, `${scene.mode}-field.json`), JSON.stringify(field, null, 1));
    const me = field.tanks[field.you];
    const url = await ev(`__studio.raw(__studio.render(${me.x + 6000}, ${me.y - 2500}, 0.012, 932, 430, 2), { x: 0, y: 0, w: 1864, h: 860 }, 1864, 860)`);
    writeFileSync(join(EXPLORE, `${scene.mode}-field.png`), Buffer.from(url.split(',')[1], 'base64'));
    console.log(`explore ${scene.mode}: biome ${field.biome}`);
    continue;
  }
  const frames = await ev(scene.stage);
  if (BURST && RAW) {
    mkdirSync(RAW, { recursive: true });
    const f = frames.wide, [cw, ch] = SHAPES.wide.u, sy = Math.max(ch / 2, Math.min(VIEW[1] - ch / 2, f.sy ?? CROP_CY));
    const crop = { x: (VIEW[0] - cw) / 2 * RENDER_SS, y: (sy - ch / 2) * RENDER_SS, w: cw * RENDER_SS, h: ch * RENDER_SS };
    for (let k = 0; k < BURST; k++) {
      const png = await ev(`__studio.raw(__studio.render(${f.x}, ${worldY(f, ch) - (sy - VIEW[1] / 2) / f.zoom}, ${f.zoom}, ${VIEW[0]}, ${VIEW[1]}, ${RENDER_SS}, ${!!scene.aim}), ${JSON.stringify(crop)}, 665, 195)`);
      writeFileSync(join(RAW, `${scene.mode}-burst-${k}.png`), Buffer.from(png.split(',')[1], 'base64'));
      await ev('__studio.run(0.05)');
    }
    continue;
  }
  for (const [shape, S0] of Object.entries(SHAPES)) {
    const f = frames[shape];
    const [cw, ch] = S0.u;
    // The world point f sits at the crop's centre: the crop is centred
    // across the screen and `sy` (default CROP_CY) down it. The sky is drawn
    // in bands down the screen, darkest at the top, so `sy` picks the band.
    const sy = Math.max(ch / 2, Math.min(VIEW[1] - ch / 2, f.sy ?? CROP_CY));
    const cx = f.x, cy = worldY(f, ch) - (sy - VIEW[1] / 2) / f.zoom;
    const crop = { x: (VIEW[0] - cw) / 2 * RENDER_SS, y: (sy - ch / 2) * RENDER_SS, w: cw * RENDER_SS, h: ch * RENDER_SS };
    const name = `card-${scene.mode}-${shape}`;
    const render = `__studio.render(${cx}, ${cy}, ${f.zoom}, ${VIEW[0]}, ${VIEW[1]}, ${RENDER_SS}, ${!!scene.aim})`;
    let q = 0.94, url = null, bytes = Infinity;
    for (; q >= 0.5; q -= 0.04) {
      url = await ev(`__studio.finish(${render}, ${JSON.stringify(crop)}, ${S0.out[0]}, ${S0.out[1]}, ${JSON.stringify(Object.assign({}, scene.look, f.look))}, ${q})`);
      bytes = Buffer.from(url.split(',')[1], 'base64').length;
      if (bytes <= MAX_BYTES) break;
    }
    if (bytes > MAX_BYTES) throw new Error(`${name}: ${bytes} bytes even at q ${q.toFixed(2)}`);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, name + '.webp'), Buffer.from(url.split(',')[1], 'base64'));
    files.push({ name, mode: scene.mode, shape, w: S0.out[0], h: S0.out[1], bytes, q: +q.toFixed(2), path: join(OUT, name + '.webp') });
    console.log(`${name}.webp  ${S0.out[0]}x${S0.out[1]}  ${(bytes / 1024).toFixed(1)} KB  q${q.toFixed(2)}`);
    if (RAW) {
      mkdirSync(RAW, { recursive: true });
      const png = await ev(`__studio.raw(${render}, ${JSON.stringify(crop)}, ${S0.out[0]}, ${S0.out[1]})`);
      writeFileSync(join(RAW, name + '.png'), Buffer.from(png.split(',')[1], 'base64'));
    }
    // Where the scene's named subjects landed in this crop (studio.js boxes).
    const boxes = await ev(`__studio.boxes(${cx}, ${cy}, ${f.zoom}, ${VIEW[0]}, ${VIEW[1]}, ${RENDER_SS}, ${!!scene.aim}, ${JSON.stringify(crop)}, ${JSON.stringify(frames.subjects)})`);
    const outs = f.out || [];
    files[files.length - 1].subjects = boxes.filter((b) => !outs.includes(b.name));
    files[files.length - 1].out = boxes.filter((b) => outs.includes(b.name));
    for (const b of boxes) {
      const off = b.box && (b.box[0] < 0 || b.box[1] < 0 || b.box[2] > 1 || b.box[3] > 1);
      const gone = !b.box || b.box[2] <= 0 || b.box[0] >= 1 || b.box[3] <= 0 || b.box[1] >= 1;
      if (outs.includes(b.name)) { if (!gone) console.log(`  WARN ${name}: ${b.name} should be out of the picture ${JSON.stringify(b.box)}`); }
      else if (!b.box) console.log(`  WARN ${name}: ${b.name} is not in the picture`);
      else if (off) console.log(`  WARN ${name}: ${b.name} runs off the picture ${JSON.stringify(b.box)}`);
    }
  }
}

// ---- the subjects' boxes ----------------------------------------------------
// One file for every card the bay can show, kept beside this tool (or beside
// --out's pictures): each card's size, the sha256 of its exact bytes and the
// box of each named subject in it. A run with --only updates its own modes and
// keeps the rest. test/mode_cards.mjs reads it, checks every hash against the
// picture in public/bay, and holds each box clear of the bay's overlays.
if (files.length) {
  const path = SUBJECTS;
  let rec = { cards: {} };
  try { rec = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  rec.about = 'Written by tools/cards/capture.mjs: where each mode card\'s named subjects are drawn in its picture, in fractions of the picture [x0, y0, x1, y1]. Read by test/mode_cards.mjs.';
  for (const f of files) {
    rec.cards[f.name] = { w: f.w, h: f.h, sha256: createHash('sha256').update(readFileSync(f.path)).digest('hex'), subjects: f.subjects, out: f.out };
  }
  rec.cards = Object.fromEntries(Object.entries(rec.cards).sort(([a], [b]) => a.localeCompare(b)));
  // One line per box, so a change to a card reads as a change to its boxes.
  const text = JSON.stringify({ about: rec.about, cards: rec.cards }, null, 1).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2, $3, $4]');
  writeFileSync(path, text + '\n');
  console.log('subject boxes ->', path);
}

// ---- the contact sheet --------------------------------------------------------
if (SHEET && files.length) {
  const b64 = (p) => 'data:image/webp;base64,' + readFileSync(p).toString('base64');
  const rows = [...new Set(files.map((f) => f.mode))].map((mode) => {
    const of = (shape) => files.find((f) => f.mode === mode && f.shape === shape);
    const cell = (f, w) => f ? `<figure><img src="${b64(f.path)}" style="width:${w}px"><figcaption>${f.name}.webp ${f.w}x${f.h} ${(f.bytes / 1024).toFixed(1)} KB</figcaption></figure>` : '';
    return `<section><h2>${mode}</h2><div class="r">${cell(of('board'), 261)}${cell(of('tall'), 171)}${cell(of('wide'), 665)}</div></section>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#0b1020;color:#cdd6ee;font:13px/1.3 system-ui,sans-serif}
    h2{margin:18px 0 8px;font:600 18px system-ui;text-transform:uppercase;letter-spacing:.06em;color:#ffb46b}.r{display:flex;gap:18px;align-items:flex-start}
    figure{margin:0}img{display:block;border-radius:6px;border:1px solid rgba(140,168,214,.3)}figcaption{margin-top:5px;color:#8798bd;font:11px ui-monospace,monospace}</style>
    <h1 style="font:700 22px system-ui;margin:0">Mode cards: board (home), tall (Mission board), wide (Match setup), shown at half size</h1>${rows}`;
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: 'about:blank' }); await sleep(300);
  await ev(`(document.open(), document.write(${JSON.stringify(html)}), document.close(), true)`);
  await sleep(500);
  const h = await ev('document.documentElement.scrollHeight');
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: h, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(SHEET), { recursive: true });
  writeFileSync(SHEET, Buffer.from(data, 'base64'));
  console.log('contact sheet ->', SHEET);
}
if (pageErrors.length) { console.error('page errors:\n  ' + pageErrors.join('\n  ')); process.exitCode = 1; }
ws.close();
cleanup();
process.exit(process.exitCode || 0);
