// Artillery Golf for four, in the real page: the Players choice in Match
// setup reaches the create frame, the home readout says the count, the
// boards say 1-4, and four seats render in the HUD cards and the scorecard.
// And golf's menus show the golf bag, never a weapon (section 6).
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

// EVERY CDP CALL HAS A DEADLINE, AND SO DOES THE WHOLE RUN (fix wave A4). This
// suite runs in the pre-push hook: a Chrome or a server that stops answering
// must fail it loudly, never hang the push. And every way out -- the end, a
// throw, a signal, the watchdog -- takes Chrome and the server with it,
// registered before either is spawned. SIGKILL, because a stopped process
// ignores SIGTERM until it is continued, and a frozen Chrome is the hang this
// exists for.
const CDP_MS = 15000;                                           // one call
const RUN_MS = 60000;                                          // the whole suite
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
let srv = null, chrome = null, prof = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog = setTimeout(() => { console.error(`FAIL golf_four_ui overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

const appPort = await freePort();
srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); break; } catch {} await sleep(150); }
const dbg = await freePort(); prof = join(tmpdir(), `cc-golf4-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
if (!wsUrl) { console.error('FAIL golf_four_ui: Chrome never offered a page to drive'); process.exit(1); }
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
  const before = seg.querySelector('.seg.on') && seg.querySelector('.seg.on').textContent.trim();   // the default, read before any tap
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
  return { opts, hidden, teeShown, before, after, frame, ffaFrame, readout, bpl, on };
})()`);
if (setup.opts && setup.opts.join(',') === '1,2,3,4' && setup.hidden === false && setup.teeShown) ok('setup: golf shows Players 1,2,3,4 beside the Tee set'); else fail('setup segment: ' + JSON.stringify(setup));
if (setup.before === '2') ok('setup: golf defaults to 2 players'); else fail('golf default: ' + setup.before);
if (setup.after === 3 && setup.on === '3') ok('setup: tapping 3 arms three seats'); else fail('setup: after tap ' + JSON.stringify({ after: setup.after, on: setup.on }));
if (setup.frame && setup.frame.type === 'create' && setup.frame.mode === 'golf' && setup.frame.max === 3 && setup.frame.tees) ok('launch: the golf create frame carries max 3 and the tee set'); else fail('golf frame: ' + JSON.stringify(setup.frame));
if (setup.ffaFrame && setup.ffaFrame.mode === 'ffa' && setup.ffaFrame.max === 4) ok('launch: the free-for-all count is untouched by the golf choice'); else fail('ffa frame: ' + JSON.stringify(setup.ffaFrame));
if (setup.readout && /Players\s*3/.test(setup.readout.replace(/\s+/g, ' '))) ok('home: the launch bar reads Players 3 for golf'); else fail('home readout: ' + String(setup.readout).slice(0, 80));
if (setup.bpl === '1-4') ok('home: the golf board says 1-4'); else fail('golf board players: ' + setup.bpl);
// 2. No other mode shows the golf Players segment (free-for-all has its own count segment under a different label).
const hiddenFor = await ev(`(() => { const out = {}; for (const m of ['duel', 'ffa', 'boss', 'aliens']) { ccMode = m; Bay.show('setup'); const seg = [...document.querySelectorAll('#bay .b-opt')].find((o) => o.querySelector('.lbl') && o.querySelector('.lbl').textContent === 'Players'); out[m] = seg ? seg.classList.contains('hidden') : 'absent'; Bay.show('home'); } ccMode = 'duel'; return out; })()`);
if (['duel', 'ffa', 'boss', 'aliens'].every((m) => hiddenFor[m] === true)) ok('setup: the golf Players segment is hidden for duel, free-for-all, boss and aliens'); else fail('Players segment hidden: ' + JSON.stringify(hiddenFor));

// 3. four golf seats in the HUD cards: strokes, IN for a holed seat, OUT for a
// seat scuttled by a forfeit, no hp bar.
// The cards (#p0..#p3) are built by buildScoreboard() at match start from S.n
// and S.names, so the injected state builds them too, and again on restore.
const hud = await ev(`(() => {
  const keep = { n: S.n, names: S.names, golf: S.golf, hp: S.hp.slice(), alive: S.alive.slice(), turn: S.turn, playing: S.playing };
  S.n = 4; S.names = ['Ash', 'Bay', 'Cal', 'Dee']; S.hp = [100, 100, 100, 100]; S.alive = [true, true, true, false]; S.turn = 2; S.playing = true;
  S.golf = { hole: 1, holes: 9, par: 4, cup: { x: 10000 }, strokes: [1, 2, 3, 4], totals: [1, 2, 3, 4], done: [false, false, true, false] };
  buildScoreboard(); updateHud();
  const cards = [0, 1, 2, 3].map((i) => { const el = $('p' + i); return el ? { score: el.querySelector('.score').textContent, shots: el.querySelector('.shots').textContent, bar: el.querySelector('.hpbar').style.display, acting: el.classList.contains('acting'), dead: el.classList.contains('dead') } : null; });
  S.n = keep.n; S.names = keep.names; S.golf = keep.golf; S.hp = keep.hp; S.alive = keep.alive; S.turn = keep.turn; S.playing = keep.playing; buildScoreboard(); updateHud();
  return cards;
})()`);
if (hud.every(Boolean) && hud[0].score === '1' && hud[3].score === '4' && hud[2].shots === 'IN' && hud[1].shots.startsWith('STR') && hud.every((c) => c.bar === 'none') && hud[2].acting
  && hud[3].shots === 'OUT' && hud[3].dead && !hud[3].acting && !hud[2].dead) ok('hud: four golf cards show strokes, IN for the holed seat, OUT for the scuttled one, no hp bars, the acting seat lit'); else fail('hud cards: ' + JSON.stringify(hud));

// 4. the scorecard lays out four rows with totals. golfCardHTML returns thead
// and tbody without a table wrapper; parsed into a div the parser drops every
// row, so the harness parses it into a table element.
const card = await ev(`(() => { const html = golfCardHTML({ grid: [[4,0,0,0,0,0,0,0,0],[5,0,0,0,0,0,0,0,0],[3,0,0,0,0,0,0,0,0],[6,0,0,0,0,0,0,0,0]], pars: [4,3,5,4,4,3,5,4,4], totals: [4,5,3,6], done: [true,true,true,true], hole: 1 }); const d = document.createElement('table'); d.innerHTML = html; const rows = [...d.querySelectorAll('tr')].filter((r) => !r.classList.contains('gc-parrow') && !r.querySelector('th')); return { rows: rows.length, text: rows.map((r) => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40)) }; })()`);
if (card.rows === 4) ok('scorecard: four player rows'); else fail('scorecard rows: ' + JSON.stringify(card));
// ...and the fourth seat, scuttled mid-round, must not read as a finished card:
// its 2 strokes would otherwise be the best total on the table while the title
// names somebody else the winner. The hole banner must leave it out too.
const outCard = await ev(`(() => {
  const keep = { alive: S.alive.slice(), n: S.n, names: S.names };
  S.alive = [true, true, true, false]; S.n = 4; S.names = ['Ash', 'Bay', 'Cal', 'Dee'];
  const html = golfCardHTML({ grid: [[4,0,0,0,0,0,0,0,0],[5,0,0,0,0,0,0,0,0],[3,0,0,0,0,0,0,0,0],[2,0,0,0,0,0,0,0,0]], pars: [4,3,5,4,4,3,5,4,4], totals: [4,5,3,2], done: [false,false,false,false], hole: 1 });
  const d = document.createElement('table'); d.innerHTML = html;
  const rows = [...d.querySelectorAll('tr')].filter((r) => !r.classList.contains('gc-parrow') && !r.querySelector('th'));
  const seats = rows.map((r) => ({ now: r.children[1].classList.contains('gc-now'), out: r.classList.contains('gc-out'), tot: r.querySelector('.gc-tot').textContent.trim() }));
  showHoleScore({ hole: 2, holes: 9, par: 3, pars: [4,3,5,4,4,3,5,4,4], grid: [[4],[5],[3],[2]] });
  const hs = { rows: document.querySelectorAll('#holeScore .hs-row').length, text: $('holeScore').textContent.replace(/\\s+/g, ' ') };
  clearTimeout(holeScoreTimer); $('holeScore').classList.remove('show');
  S.alive = keep.alive; S.n = keep.n; S.names = keep.names;
  return { seats, hs };
})()`);
if (outCard.seats && outCard.seats.length === 4 && outCard.seats.slice(0, 3).every((r) => r.now && !r.out)
  && !outCard.seats[3].now && outCard.seats[3].out && outCard.seats[3].tot === 'OUT') ok('scorecard: a scuttled seat reads OUT with no live-hole highlight; the three live seats keep theirs');
else fail('scorecard out row: ' + JSON.stringify(outCard.seats));
if (outCard.hs && outCard.hs.rows === 3 && !/Dee/.test(outCard.hs.text)) ok('hole banner: the scuttled seat is left out of the hole score');
else fail('hole banner: ' + JSON.stringify(outCard.hs));

// 6. GOLF MENUS SHOW THE BAG (owner, 2026-10-06): with golf armed, every place
// the bay shows weapons shows game-core's GOLF_BAG instead, read-only -- no
// picking, no Edit, and not one combat weapon's art. Read on the real screens:
// the home readout and station, the mission board card, Match setup's rack row,
// brief and footer, and the golf bag screen the Armoury's door opens. A duel
// keeps every one of them as it was.
const bag = await ev(`(async () => {
  const gc = await import('./game-core.js');
  const norm = (h) => { const t = document.createElement('template'); t.innerHTML = h || ''; return t.innerHTML; };
  const CLUBS = gc.GOLF_BAG.slice();
  const COMBAT = gc.WEAPONS.filter((w) => !w.golfOnly && !w.bossOnly && !w.aiOnly).map((w) => w.id);
  const combatArt = () => COMBAT.filter((id) => ICONS[id] && $('bay').innerHTML.includes(norm(ICONS[id])));
  const clubs = (root) => root ? [...root.querySelectorAll('.slot')].map((sl) => CLUBS.find((id) => !!ICONS[id] && sl.innerHTML === norm(ICONS[id])) || '?').join() : null;
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null);
  const lblRow = (re) => { const l = [...document.querySelectorAll('#bay .card .lbl')].find((x) => re.test(x.textContent)); return l ? l.parentElement.parentElement : null; };
  const screen = (mode) => {
    const o = {}; ccMode = mode;
    Bay.show('home');
    o.readout = txt(document.querySelector('#bay .lbar .ros'));
    o.station = txt([...document.querySelectorAll('#bay .st')].find((b) => b.dataset.go === 'armoury'));
    o.homeCombat = combatArt();
    Bay.show('modes');
    const card = [...document.querySelectorAll('#bay .mb')].find((b) => b.dataset.set === 'mode=' + mode);
    o.card = card ? [...card.querySelectorAll('.tagm')].map((t) => t.textContent).join('|') : null;
    o.blurb = card ? txt(card.querySelector('.mbb')) : null;
    Bay.show('setup');
    const row = lblRow(/Golf bag|Weapon rack/);
    o.rackLabel = row ? txt(row.querySelector('.lbl')) : null;
    o.rackClubs = clubs(row);
    o.edit = [...document.querySelectorAll('#bay .card button')].some((b) => b.textContent.trim() === 'Edit');
    o.brief = [...document.querySelectorAll('#bay .brief .brow')].map(txt).join('|');
    o.setupCombat = combatArt();
    o.setupGo = txt(document.querySelector('#bay .go[data-go="armoury"]'));
    Bay.show('armoury');
    o.gclubs = [...document.querySelectorAll('#bay .gclub .gcn')].map((n) => n.textContent).join();
    o.gclubArt = [...document.querySelectorAll('#bay .gclub .gct')].map((g) => CLUBS.find((id) => !!ICONS[id] && !!g.querySelector('svg') && norm(g.querySelector('svg').outerHTML) === norm(ICONS[id])) || '?').join();
    o.armSlots = clubs(document.querySelector('#bay .card'));
    o.picks = document.querySelectorAll('#bay [data-pick]').length;
    // Legible on a phone: in design units (the 932u stage), the words at 12u or
    // more, the names at 13u or more, and no card cutting its words off.
    const uPx = document.querySelector('#bay .stage').getBoundingClientRect().width / 932;
    const fsU = (sel) => Math.min(...[...document.querySelectorAll(sel)].map((e) => parseFloat(getComputedStyle(e).fontSize) / uPx));
    o.legible = document.querySelector('#bay .gclub') ? { body: fsU('#bay .gclub .gcd'), name: fsU('#bay .gclub .gcn'),
      cut: [...document.querySelectorAll('#bay .gclub')].some((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1) } : null;
    const launch = document.querySelector('#bay [data-launch]');
    o.launch = launch ? { t: txt(launch), dis: launch.disabled } : null;
    o.armCombat = combatArt();
    Bay.show('home');
    return o;
  };
  const golf = screen('golf'), duel = screen('duel');
  // A golf player whose saved rack is short: the bag screen still opens the doors.
  let shortLaunch = null;
  const kept = localStorage.getItem('cc_loadout');
  try {
    localStorage.setItem('cc_loadout', JSON.stringify(['mortar']));
    ccMode = 'golf'; Bay.show('armoury');
    const l = document.querySelector('#bay [data-launch]'); shortLaunch = l ? { t: txt(l), dis: l.disabled } : null;
  } finally { if (kept === null) localStorage.removeItem('cc_loadout'); else localStorage.setItem('cc_loadout', kept); ccMode = 'duel'; Bay.show('home'); }
  return { golf, duel, shortLaunch, bag: CLUBS.join() };
})()`);
const g = bag.golf, d = bag.duel;
if (bag.bag === 'driver,golfball,wedge,putter') ok('game-core\'s golf bag is Driver, Iron, Wedge, Putter'); else fail('GOLF_BAG: ' + bag.bag);
if (/Golf bag\s*4 clubs/i.test(g.readout) && !/Weapon draft/i.test(g.readout) && /Golf bag\s*4 clubs/i.test(g.station)) ok('home: the readout and the Bay stations row both say Golf bag, 4 clubs');
else fail('home golf: ' + JSON.stringify({ readout: g.readout, station: g.station }));
if (g.card === '1-4 players|4 clubs' && /Driver, Iron, Wedge, Putter\./.test(g.blurb)) ok('mission board: the golf card says 4 clubs and its blurb names all four');
else fail('golf card: ' + JSON.stringify({ card: g.card, blurb: g.blurb }));
if (/^Golf bag . 4 clubs$/.test(g.rackLabel) && g.rackClubs === bag.bag && !g.edit) ok('setup: the rack row is the golf bag, the four clubs in order, and no Edit');
else fail('setup golf rack: ' + JSON.stringify({ label: g.rackLabel, clubs: g.rackClubs, edit: g.edit }));
if (/Clubs in the bag\s*4/.test(g.brief) && !/Weapons to draft/.test(g.brief) && /golf bag/i.test(g.setupGo)) ok('setup: the brief says Clubs in the bag 4, and the door is To the golf bag');
else fail('setup golf brief: ' + JSON.stringify({ brief: g.brief, go: g.setupGo }));
if (g.gclubs === 'Driver,Iron,Wedge,Putter' && g.gclubArt === bag.bag && g.armSlots === bag.bag && g.picks === 0 && g.launch && !g.launch.dis && /Open the bay doors/.test(g.launch.t))
  ok('golf bag screen: the four clubs with their own art and words, nothing to pick, and the bay doors open');
else fail('golf bag screen: ' + JSON.stringify({ names: g.gclubs, art: g.gclubArt, slots: g.armSlots, picks: g.picks, launch: g.launch }));
if (g.legible && g.legible.body >= 12 && g.legible.name >= 13 && !g.legible.cut) ok(`golf bag screen: words at ${g.legible.body.toFixed(1)}u, names at ${g.legible.name.toFixed(1)}u, nothing cut off`);
else fail('golf bag legibility: ' + JSON.stringify(g.legible));
if (bag.shortLaunch && !bag.shortLaunch.dis) ok('golf bag screen: a short saved rack still opens the bay doors for golf'); else fail('golf short rack: ' + JSON.stringify(bag.shortLaunch));
if (!g.homeCombat.length && !g.setupCombat.length && !g.armCombat.length) ok('no combat weapon\'s art on home, Match setup or the golf bag screen while golf is armed');
else fail('combat art under golf: ' + JSON.stringify({ home: g.homeCombat, setup: g.setupCombat, bag: g.armCombat }));
if (/Weapon draft\s*5 picks/i.test(d.readout) && /Armoury/.test(d.station) && /\d+ weapons$/.test(d.card) && /^Weapon rack/.test(d.rackLabel) && d.edit && /Weapons to draft\s*5/.test(d.brief)
    && d.picks > 0 && !d.gclubs && /armoury/i.test(d.setupGo)) ok('duel: every one of those still shows the weapon draft, the rack with Edit and the Armoury');
else fail('duel menus: ' + JSON.stringify(d));

// 5. the ONLINE lobby, driven through the page's own create path (the real
// intent, on this suite's own server) rather than the stub used in check 1:
// golf for three tells the host to tee off, and a one-seat room never becomes
// a lobby at all — the server starts the round the moment it is created.
await ev(`(() => { ccMode = 'golf'; ccGolfMax = 3; Bay.show('setup'); $('createBtn').onclick(); return true; })()`);
let lobbyUp = false;
for (let i = 0; i < 60; i++) { if (await ev(`!!(S.code && S.code.length === 4 && /Tee off/.test($('bay').textContent))`).catch(() => false)) { lobbyUp = true; break; } await sleep(100); }
await sleep(250);                                  // the 'lobby' frame re-renders the bay with the real max
const bayTxt = await ev(`$('bay').textContent.replace(/\\s+/g, ' ')`).catch(() => '');
if (lobbyUp && /Tee off whenever you have enough players/.test(bayTxt)) ok('lobby: a golf room for three tells the host to tee off when ready');
else fail('golf lobby copy: up=' + lobbyUp + ' text=' + String(bayTxt).slice(0, 220));
// ...and its rack box is the golf bag: the four clubs, no Change, no weapons loaded.
const lobbyBag = await ev(`(() => { const l = [...document.querySelectorAll('#bay .ldt .lbl')].find((x) => /Golf bag/.test(x.textContent)); const box = l && l.closest('.ldt');
  return { slots: box ? box.querySelectorAll('.slot.f').length : -1, change: !!(box && box.querySelector('[data-go="armoury"]')), text: $('bay').textContent.replace(/\\s+/g, ' ') }; })()`).catch((e) => ({ err: e.message }));
if (lobbyBag.slots === 4 && !lobbyBag.change && /4 clubs in the bag/.test(lobbyBag.text) && !/weapons loaded/.test(lobbyBag.text)) ok('lobby: the golf room shows the golf bag, four clubs and no Change');
else fail('golf lobby bag: ' + JSON.stringify({ slots: lobbyBag.slots, change: lobbyBag.change, err: lobbyBag.err }));
// Leave it the way the page does: the lobby's Cancel carries data-old="cancelBtn".
await ev(`(document.querySelector('#bay [data-old="cancelBtn"]').click(), true)`);
let home = false;
for (let i = 0; i < 60; i++) { if (await ev(`!S.code && $('bay').dataset.scr === 'home'`).catch(() => false)) { home = true; break; } await sleep(100); }
if (!home) fail('lobby: Cancel never returned the bay to home');
// The one-seat room is started by the server right after the lobby frame, so
// the lobby paint can be gone before the next poll: watch the bay instead.
// Only frames painted from the NEW room's own lobby payload count. The
// 'created' handler shows the lobby screen one task earlier, before any
// payload has landed, and that frame still carries the PREVIOUS room (or, on
// a cold create, the 2-seat default) — its seat count gives it away, and no
// copy inside SCREENS.lobby can reach it.
await ev(`(() => {
  window.__lobbyText = null;
  window.__lobbyObs = new MutationObserver(() => {
    if (window.__lobbyText) return;
    const t = $('bay').textContent.replace(/\\s+/g, ' ');
    if (!/Players\\s*1\\s*\\/\\s*1/.test(t)) return;          // not this room's payload yet
    if (/Teeing off|Share this code/.test(t)) window.__lobbyText = t;
  });
  window.__lobbyObs.observe($('bay'), { childList: true, subtree: true, characterData: true });
  return true;
})()`);
await ev(`(() => { ccGolfMax = 1; Bay.show('setup'); $('createBtn').onclick(); return true; })()`);
let solo = null;
for (let i = 0; i < 30; i++) { solo = await ev(`({ playing: !!S.playing, n: S.n, mode: S.mode })`).catch(() => null); if (solo && solo.playing && solo.n === 1) break; await sleep(100); }
if (solo && solo.playing === true && solo.n === 1 && solo.mode === 'golf') ok('lobby: a one-seat golf room tees off on its own — no Tee off tap, one seat, already playing');
else fail('one-seat golf online: ' + JSON.stringify(solo));
const lobbyText = await ev(`window.__lobbyText`).catch(() => null);
await ev(`(window.__lobbyObs && window.__lobbyObs.disconnect(), true)`).catch(() => null);
if (lobbyText && /Teeing off/.test(lobbyText) && !/Share this code/.test(lobbyText)) ok('lobby: the one-seat golf room paints Teeing off, never the share-a-code lobby');
else fail('one-seat lobby paint: ' + JSON.stringify(lobbyText && String(lobbyText).slice(0, 220)));
await ev(`(() => { ccMode = 'duel'; ccGolfMax = 2; return true; })()`);
} catch (e) { fail('harness: ' + e.message); }

clearTimeout(watchdog);
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall golf_four_ui checks passed');
process.exit(errors.length ? 1 : 0);
