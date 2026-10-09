// THE PLAYER'S NAME, EVERYWHERE (owner, 2026-10-10, item 27: "Ensure that the
// username for the person is accurately displayed across the whole game and
// every game mode"), in real pages against a real server.
//
// Every in-match surface that names a player (the HUD cards, the turn line,
// the kill line, the hole card, the scorecard, the end screen, the share card,
// the raid report) reads one array, S.names, which is the seat names the room
// engine sent. Every surface outside a match (the home chip, Service record,
// Paint shop, Bay controls, the Squad box's own row) reads myName(), this
// device's name. So the question for every mode is whether the seat the room
// gives the player carries the player's own name, and this suite asks it
// everywhere a player can start one:
//   A. OFFLINE, every mode, for a guest with the default name, a guest with a
//      name they typed, and a signed-in player with a chosen name: the page's
//      own engine seats the device's own name (app.js startLocal).
//   B. ONLINE AGAINST THE COMPUTER OR ALONE, every mode, the same three
//      players, with the end screens drawn and every screen outside a match.
//   C. A SIGNED-IN PLAYER WHOSE TAP BEATS THEIR OWN HELLO. A tap made while the
//      socket reopens, or in the moment after it opens, reached the room before
//      the server knew whose socket it was, and the server's name check
//      refused the account's own chosen name as "taken": the seat got a rolled
//      pair. And a second device whose page had not yet learned the account's
//      name presented its own default and was seated under that.
//   D. IN A SQUAD, two pages: the leader signed in, the member each kind, every
//      mode, the rows before the start and the seats after it on both pages.
//   E. RIGHT AFTER A RENAME: a guest's and a signed-in player's new name is on
//      their squad row on both pages at once and in the next match.
//   F. A NAME THE SERVER REFUSES (another account took it) is replaced, and the
//      player is told what they are called in that match.
//   G. ON THE WIRE, the server's half of C and F: a frame that seats a player
//      waits for the socket's hello, in order, for a limited time, and acts on
//      nothing once its socket has gone; and `renamed` is on the refused
//      seat's own frames and nobody else's.
//
// A local stand-in answers for Supabase (GoTrue and PostgREST), and the
// browser resolves no host but this machine, so nothing here can reach the
// real service. A signed-in page is made by replacing three of window.Cloud's
// answers as cloud.js defines it (enabled, token, whoami); the token is one
// only the stand-in knows. Self-hosted on free ports. Exit 3 = SKIP without
// Chrome. NAMES_ONLY=A,C runs some parts alone.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  names tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ONLY = new Set(String(process.env.NAMES_ONLY || 'A,B,C,D,E,F,G').split(',').map((s) => s.trim()));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const MODES = ['duel', 'ffa', 'boss', 'aliens', 'golf'];

const CDP_MS = 15000;
const RUN_MS = 600000;
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
let srv = null, mock = null;
const chromes = [], profiles = [];
const cleanup = () => {
  for (const c of chromes) { try { c.kill('SIGKILL'); } catch {} }
  try { srv && srv.kill('SIGKILL'); } catch {}
  try { mock && mock.close(); } catch {}
  for (const p of profiles) { try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {} }
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
setTimeout(() => { console.error(`FAIL names overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS).unref();

// ---- the Supabase stand-in ---------------------------------------------------
// Two linked accounts, each holding a chosen callsign. Verifying a token takes
// USER_MS, as a real round trip to GoTrue does, so a frame sent straight after
// a hello lands while the hello is still being verified.
const USER_MS = 400;
const CHOSEN_ID = '11111111-1111-4111-8111-111111111111', OTHER_ID = '22222222-2222-4222-8222-222222222222';
const CHOSEN = 'Marguerite Vale', OTHER = 'Wren Delacroix';
const fresh = () => ({
  [CHOSEN_ID]: { id: CHOSEN_ID, callsign: CHOSEN, friend_code: 'ABC234', callsign_key: CHOSEN.toLowerCase(), callsign_set_at: null },
  [OTHER_ID]: { id: OTHER_ID, callsign: OTHER, friend_code: 'ABC235', callsign_key: OTHER.toLowerCase(), callsign_set_at: null },
});
const SB = { rows: fresh(), friendsMs: 0 };
const TOKENS = { 'tok-chosen': CHOSEN_ID, 'tok-other': OTHER_ID, 'tok-late': OTHER_ID, 'tok-slow2': OTHER_ID };
// Two hellos slower than the rest, for G6: one that settles after the server's
// hold has given up on it, and one that settles a little after that.
const DELAY = { 'tok-late': 3500, 'tok-slow2': 1000 };
const mockPort = await freePort();
mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const json = (code, v, ms = 0) => setTimeout(() => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); }, ms);
    if (u.pathname === '/auth/v1/health') return json(200, { name: 'GoTrue' });
    if (u.pathname === '/auth/v1/user') {
      // A GoTrue that never answers this one (part G): the server gives up on
      // it after its own 8 s timeout.
      if ((req.headers.authorization || '') === 'Bearer tok-hang') return;
      const id = TOKENS[(req.headers.authorization || '').replace('Bearer ', '')];
      const tok = (req.headers.authorization || '').replace('Bearer ', '');
      return id ? json(200, { id, aud: 'authenticated', is_anonymous: false }, DELAY[tok] ?? USER_MS) : json(401, {});
    }
    const rows = Object.values(SB.rows);
    if (u.pathname === '/rest/v1/profiles' && req.method === 'GET' && u.searchParams.get('select') === 'callsign_key') {
      const ck = u.searchParams.get('callsign_key') || '';
      const after = /^gt\./.test(ck) ? ck.slice(3) : '';
      const keys = [...new Set(rows.map((r) => r.callsign_key).filter(Boolean))].sort().filter((k) => !after || k > after);
      return json(200, keys.map((k) => ({ callsign_key: k })));
    }
    if (u.pathname === '/rest/v1/profiles' && req.method === 'PATCH') {
      const id = (u.searchParams.get('id') || '').replace(/^eq\./, '');
      let b = {}; try { b = JSON.parse(body); } catch {}
      if (SB.rows[id]) Object.assign(SB.rows[id], b);
      return json(200, SB.rows[id] ? [SB.rows[id]] : []);
    }
    if (u.pathname === '/rest/v1/profiles' && req.method === 'GET') {
      const q = u.searchParams.get('id') || '';
      const inList = /^in\.\((.*)\)$/.exec(q);
      if (inList) {
        const want = inList[1].split(',').map((s) => decodeURIComponent(s.trim()));
        return json(200, want.filter((id) => SB.rows[id]).map((id) => ({ id, callsign: SB.rows[id].callsign, callsign_key: SB.rows[id].callsign_key })));
      }
      const ck = (u.searchParams.get('callsign_key') || '').replace(/^eq\./, '');
      if (ck) return json(200, rows.filter((r) => r.callsign_key === ck));
      const id = q.replace(/^eq\./, '');
      return json(200, SB.rows[id] ? [SB.rows[id]] : []);
    }
    // The friends read starts here (store.friendIdsOf), so holding this one
    // answer holds the whole snapshot, which is how a second device's page goes
    // on presenting its own default for a while after its hello has settled.
    if (u.pathname === '/rest/v1/friendships' && req.method === 'GET') return json(200, [], SB.friendsMs);
    if (req.method === 'GET') return json(200, []);
    res.writeHead(204); res.end();
  });
});
await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

// ---- the server --------------------------------------------------------------
// Bots never fire while a match is read (BOT_FIRE_MS), and a squad whose
// members are all ready starts at once (SQUAD_COUNTDOWN_MS).
const appPort = await freePort();
let srvLog = '';
srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(appPort), SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_PUBLISHABLE_KEY: 'pk_test', SUPABASE_SECRET_KEY: 'sk_test',
    BOT_FIRE_MS: '600000', PICK_MS: '600000', SQUAD_COUNTDOWN_MS: '100' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
let up = false;
for (let i = 0; i < 100; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); up = true; break; } catch {} await sleep(150); }
if (!up) { console.error('FAIL server never came up\n' + srvLog); process.exit(1); }
if (/\[boot\] social off/.test(srvLog)) { console.error('FAIL the social layer did not boot: ' + srvLog); process.exit(1); }
let stopped = false;
const stopServer = () => { if (!stopped) { srv.kill('SIGSTOP'); stopped = true; } };
const resumeServer = () => { if (stopped) { srv.kill('SIGCONT'); stopped = false; } };
const ORIGIN = `http://127.0.0.1:${appPort}/`;

// ---- pages ---------------------------------------------------------------------
// THE SIGNED-IN STAND-IN: a page whose storage holds a test token gets a Cloud
// that answers enabled, token and whoami for that account and touches no
// network. cloud.js assigns window.Cloud once, and this setter amends it there.
const STUB = `(() => {
  window.__ccNoIntro = true;
  let tok = null, who = null;
  try { tok = localStorage.getItem('__ccTestTok'); who = JSON.parse(localStorage.getItem('__ccTestWho') || 'null'); } catch {}
  if (!tok || !who) return;
  let real;
  Object.defineProperty(window, 'Cloud', { configurable: true, enumerable: true, get() { return real; },
    // __ccTokMs: how long the session's token takes to read (part C), as a
    // refresh over a slow network does.
    set(v) { real = Object.assign(v, { enabled: () => true, whoami: async () => who, restore: async () => null,
      token: async () => { let ms = 0; try { ms = +localStorage.getItem('__ccTokMs') || 0; } catch {} if (ms) await new Promise((r) => setTimeout(r, ms)); return tok; },
      save: async () => true, userId: () => who.id, consumeRedirect: () => null }); } });
})();`;
async function openChrome(tag) {
  const dbg = await freePort();
  const profile = join(tmpdir(), `cc-names-${tag}-${dbg}`);
  rmSync(profile, { recursive: true, force: true }); profiles.push(profile);
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=874,402',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  chromes.push(chrome);
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { const list = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = list.find((t) => t.type === 'page'); if (p && p.webSocketDebuggerUrl) wsUrl = p.webSocketDebuggerUrl; } catch {}
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error(`Chrome ${tag} exposed no debugger`);
  const ws = new WebSocket(wsUrl);
  await Promise.race([new Promise((r) => { ws.onopen = r; }), sleep(CDP_MS).then(() => { throw new Error('CDP never opened'); })]);
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); reject(new Error(`CDP ${method} gave no answer in ${CDP_MS} ms`)); }, CDP_MS);
    pending.set(i, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (er) => { clearTimeout(t); reject(er); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(tag + ': ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' :: ' + expression.slice(0, 140));
    return r.result.value;
  };
  const until = async (expr, ms, step = 50) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(step); } return ev(expr).catch(() => false); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  // An iPhone 17 in landscape, the phone the owner plays on.
  const metrics = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await metrics(874, 402);
  const READY = `typeof intent === 'function' && !!window.Bay && S.connected === true && !S.local && !!document.querySelector('#bay .lbar') && socialIntro() > 0`;
  const page = {
    tag, ev, until, metrics,
    // SETTLED, unless asked otherwise: a signed-in page is ready once its
    // account's friends snapshot is in, which the server answers only after
    // the socket's hello has been verified. Part C asks for the moment before.
    async nav({ settle = true } = {}) {
      await send('Page.navigate', { url: ORIGIN });
      if (!(await until(READY, 15000, 100))) throw new Error(`${tag}: page never became ready`);
      if (settle && !(await until(`!localStorage.getItem('__ccTestTok') || !!window.CC_SOCIAL`, 10000, 50))) throw new Error(`${tag}: the signed-in page never settled`);
      // Every toast the page shows, kept, so a test can ask what it was told.
      await ev(`(() => { window.__toasts = []; const t = showToast; window.showToast = function (x) { __toasts.push(String(x)); return t.apply(this, arguments); }; return true; })()`);
    },
  };
  return page;
}

// ---- who the page is -------------------------------------------------------------
const who = (id, email) => ({ id, anonymous: false, google: false, apple: true, email, accounts: [{ provider: 'apple', email }] });
const KINDS = {
  default: { label: 'a guest with the default name' },
  typed: { label: 'a guest with a typed name', name: 'Tank Ace' },
  chosen: { label: 'a signed-in player with a chosen name', name: CHOSEN, tok: 'tok-chosen', who: who(CHOSEN_ID, 'mv@example.test') },
  other: { label: 'a second signed-in player', name: OTHER, tok: 'tok-other', who: who(OTHER_ID, 'wd@example.test') },
};
// A guest names themselves the one way the game offers: the Bay editor's
// wire, which asks the server's check and keeps the server's answer.
const typeName = (p, name) => p.ev(`new Promise((r) => { try { localStorage.removeItem('cc_name_at'); } catch {} sendGuestName(${JSON.stringify(name)}, r); })`);
// Become a kind of player on a clean device. Returns the name the player has.
async function become(p, kind) {
  await p.nav();
  await p.ev(`(() => { localStorage.clear(); sessionStorage.clear();
    ${kind.tok ? `localStorage.setItem('__ccTestTok', ${JSON.stringify(kind.tok)}); localStorage.setItem('__ccTestWho', ${JSON.stringify(JSON.stringify(kind.who))});` : ''}
    return true; })()`);
  await p.nav();
  if (kind.tok) {
    if (!(await p.until(`myName() === ${JSON.stringify(kind.name)} && !!window.CC_SOCIAL`, 10000))) throw new Error(`${p.tag}: the account's name was never adopted (${await p.ev('myName()')})`);
  } else if (kind.name) {
    const r = await typeName(p, kind.name);
    if (!r || !r.ok) throw new Error(`${p.tag}: the guest could not keep ${kind.name}: ${JSON.stringify(r)}`);
  }
  return p.ev('myName()');
}

// ---- a match, and what it shows -----------------------------------------------------
// The player's own path: home's Launch, then Match setup's Start Game.
const LAUNCH = (mode) => `(() => { ccMode = ${JSON.stringify(mode)}; ccMax = 4; Bay.show('home');
  document.querySelector('#bay .launch').click(); document.querySelector('#bay .pfoot [data-launch]').click(); return true; })()`;
const PLAYING = (mode) => `S.playing === true && S.mode === ${JSON.stringify(mode)} && Array.isArray(S.names) && S.names.length > 0 && !!document.querySelector('#p' + S.you + ' .pnm')`;
const SEEN = `(() => ({ me: S.names[S.you], you: S.you, names: S.names.slice(), local: !!S.local, mode: S.mode,
  card: document.querySelector('#p' + S.you + ' .pnm').textContent, toasts: (window.__toasts || []).slice() }))()`;
// THE END OF THE MATCH, drawn by the real renderers for this mode with the
// seat names the room sent: the golf hole card and the in-match scorecard,
// then the end screen (and the share card's lines, and the raid's report).
const ENDS = `(() => {
  const out = {};
  if (S.mode === 'golf') {
    showHoleScore({ hole: 2, holes: 9, par: 4, pars: [4], grid: S.names.map(() => [4]) });
    out.hole = document.getElementById('holeScore').textContent;
    out.card = golfCardHTML(S.golf);
    onGameOver({ type: 'gameover', winner: S.you, golf: { totals: S.names.map(() => 36), parTotal: 36, strokes: S.names.map(() => [4, 4, 4, 4, 4, 4, 4, 4, 4]), pars: [4, 4, 4, 4, 4, 4, 4, 4, 4] } });
  } else if (S.mode === 'boss' || S.mode === 'aliens') {
    onGameOver({ type: 'gameover', team: 'players', hp: S.hp.slice(), stats: { dealt: S.names.map(() => 10), received: S.names.map(() => 2) } });
    out.report = (document.getElementById('battleReport') || { textContent: '' }).textContent;
  } else onGameOver({ type: 'gameover', winner: S.you, hp: S.hp.slice() });
  out.scores = document.getElementById('finalScores').textContent;
  out.share = S.lastResult ? S.lastResult.lines.filter((l) => l.me).map((l) => l.text).join() : null;
  return out;
})()`;
const endsShow = (e, me) => {
  const want = [e.scores];
  if (e.hole !== undefined) want.push(e.hole, e.card);
  if (e.report !== undefined) want.push(e.report);
  if (e.share !== null && e.share !== undefined) want.push(e.share);
  return want.every((t) => typeof t === 'string' && t.includes(me));
};
// Leave the way a player does (Leave, then Yes): the page goes home.
async function leave(p) {
  await p.ev(`(document.getElementById('leaveYesBtn').onclick(), true)`).catch(() => {});
  await sleep(300);
  await p.nav();
}
// The screens outside a match that name the player.
const SCREENS = `(() => {
  const read = (scr) => { Bay.show(scr); return document.getElementById('bay').textContent.replace(/\\s+/g, ' '); };
  const o = { chip: (Bay.show('home'), (document.querySelector('#bay .chip[data-cs="name"] b') || { textContent: null }).textContent),
    record: read('career'), paint: read('paint'), controls: read('settings') };
  Bay.show('home');
  return o;
})()`;

// Offline: the device knows it is offline and the server stops answering.
async function cut(p) {
  await p.ev(`(() => { Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }); S.ws.close(); return true; })()`);
  if (!(await p.until('S.connected === false', 4000, 25))) throw new Error('socket never reported closed');
  stopServer();
}

const A = await openChrome('A');
let B = null;
const matrix = [];
const note = (part, mode, kind, want, got, extra = '') => matrix.push([part, mode, kind, want, got, extra]);

try {
  // ==== A. OFFLINE, every mode, three players ===================================
  if (ONLY.has('A')) {
    for (const k of ['default', 'typed', 'chosen']) {
      const want = await become(A, KINDS[k]);
      const bad = [];
      for (const mode of MODES) {
        await A.nav();
        await cut(A);
        await A.ev(LAUNCH(mode));
        const playing = await A.until(`S.local === true && ${PLAYING(mode)}`, 8000);
        const s = playing ? await A.ev(SEEN) : null;
        const e = playing ? await A.ev(ENDS) : null;
        resumeServer();
        note('A offline', mode, k, want, s && s.me);
        if (!s || s.me !== want || s.card !== `${want} (you)` || !endsShow(e, want)) bad.push({ mode, s, e });
        await leave(A);
      }
      if (!bad.length) ok(`A: offline, ${KINDS[k].label} ('${want}') is the name in every mode: the HUD card, the hole card, the scorecard, the end screen, the share card and the raid report`);
      else fail(`A: offline, ${KINDS[k].label} ('${want}'): ` + JSON.stringify(bad));
    }
    // The page's stand-in socket has no hello, so a frame sent through
    // intent() while it is the transport goes straight to the page's engine
    // and is never parked waiting for one.
    await A.nav();
    await cut(A);
    await A.ev(LAUNCH('duel'));
    const first = (await A.until(`S.local === true && ${PLAYING('duel')}`, 8000)) ? await A.ev('S.code') : null;
    await A.ev(`(intent({ type: 'ai', difficulty: 'easy', name: myName(), skin: mySkin() }), true)`);
    const again = await A.until(`S.local === true && S.playing === true && S.code !== ${JSON.stringify(first)} && !pendingIntent`, 4000);
    resumeServer();
    if (first && again) ok('A: offline, a frame sent through intent() goes straight to the page\'s own engine, never parked for a hello');
    else fail('A: offline intent: ' + JSON.stringify({ first, again, pend: await A.ev('!!pendingIntent'), code: await A.ev('S.code') }));
    await leave(A);
  }

  // ==== B. ONLINE, alone or against the computer, every mode, three players =======
  if (ONLY.has('B')) {
    for (const k of ['default', 'typed', 'chosen']) {
      const want = await become(A, KINDS[k]);
      const scr = await A.ev(SCREENS);
      // Bay controls names a signed-in player's chosen name on its Callsign
      // row; a guest's row says what the name is for ('Your name in every
      // match') and names nobody, so it is asked only of the signed-in player.
      if (scr.chip === want && [scr.record, scr.paint].every((t) => t.includes(want)) && (!KINDS[k].tok || scr.controls.includes(want)))
        ok(`B: ${KINDS[k].label} is '${want}' on the home chip, Service record and Paint shop${KINDS[k].tok ? ', and Bay controls' : ''}`);
      else fail(`B: screens for ${k}: ` + JSON.stringify({ want, chip: scr.chip, record: scr.record.includes(want), paint: scr.paint.includes(want), controls: scr.controls.includes(want) }));
      const bad = [];
      for (const mode of MODES) {
        await A.ev(LAUNCH(mode));
        const s = (await A.until(PLAYING(mode), 8000)) ? await A.ev(SEEN) : null;
        const e = s ? await A.ev(ENDS) : null;
        note('B online', mode, k, want, s && s.me);
        if (!s || s.local || s.me !== want || s.card !== `${want} (you)` || !endsShow(e, want)) bad.push({ mode, s, e });
        await leave(A);
      }
      if (!bad.length) ok(`B: online, ${KINDS[k].label} ('${want}') is the name in every mode, on every surface of the match`);
      else fail(`B: online, ${KINDS[k].label} ('${want}'): ` + JSON.stringify(bad));
    }
  }

  // ==== C. A SIGNED-IN TAP THAT BEATS ITS OWN HELLO ================================
  if (ONLY.has('C')) {
    const want = await become(A, KINDS.chosen);
    // C1. The socket drops and the player taps Start while it reopens: the tap
    // waits for the socket, and the socket's hello is verified in USER_MS.
    const c1 = [];
    for (const mode of MODES) {
      await A.ev(`(S.ws.close(), true)`);
      await A.until('S.connected === false', 4000, 10);
      await A.ev(LAUNCH(mode));
      const s = (await A.until(PLAYING(mode), 10000)) ? await A.ev(SEEN) : null;
      note('C1 tap while reconnecting', mode, 'chosen', want, s && s.me);
      if (!s || s.me !== want) c1.push({ mode, me: s && s.me });
      await leave(A);
    }
    if (!c1.length) ok(`C1: a signed-in player who taps Start while the socket reopens is seated as '${want}' in every mode`);
    else fail(`C1: a tap while the socket reopened was seated under another name: ` + JSON.stringify(c1));
    // C2. The socket has just opened and said hello; the tap lands while the
    // server is still verifying it.
    const c2 = [];
    for (const mode of MODES) {
      await A.ev(`(S.ws.close(), true)`);
      await A.until('S.connected === false', 4000, 10);
      await A.until('S.connected === true && socialIntro() > 0', 6000, 5);
      await A.ev(LAUNCH(mode));
      const s = (await A.until(PLAYING(mode), 10000)) ? await A.ev(SEEN) : null;
      note('C2 tap during hello', mode, 'chosen', want, s && s.me);
      if (!s || s.me !== want) c2.push({ mode, me: s && s.me });
      await leave(A);
    }
    if (!c2.length) ok(`C2: a signed-in player who taps Start while their hello is being verified is seated as '${want}' in every mode`);
    else fail(`C2: a tap during the hello was seated under another name: ` + JSON.stringify(c2));
    // C3. A second device: signed in, its page has not yet learned the
    // account's name (the friends read is slow), so it still presents its own
    // default. The seat is the account's name, which the page then adopts.
    SB.friendsMs = 3000;
    const c3 = [];
    for (const mode of ['ffa', 'aliens']) {
      await A.ev(`(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('__ccTestTok', 'tok-chosen');
        localStorage.setItem('__ccTestWho', ${JSON.stringify(JSON.stringify(KINDS.chosen.who))}); return true; })()`);
      await A.nav({ settle: false });
      const before = await A.ev('myName()');
      await sleep(USER_MS + 500);                      // the hello has settled; the friends read has not
      await A.ev(LAUNCH(mode));
      const s = (await A.until(PLAYING(mode), 10000)) ? await A.ev(SEEN) : null;
      note('C3 second device', mode, 'chosen', want, s && s.me, `device presented '${before}'`);
      if (!s || before === want || s.me !== want || s.card !== `${want} (you)`) c3.push({ mode, before, me: s && s.me });
      await leave(A);
    }
    SB.friendsMs = 0;
    if (!c3.length) ok(`C3: a second device still presenting its own default is seated under the account's name ('${want}') in every mode tried`);
    else fail(`C3: a second device was seated under its own default: ` + JSON.stringify(c3));
    // C4-C6. The page's own wait: the socket is open, but its hello has not
    // gone out because the session's token is slow to read.
    await become(A, KINDS.chosen);
    const reopenSlow = async (ms) => {
      await A.ev(`(localStorage.setItem('__ccTokMs', '${ms}'), S.ws.close(), true)`);
      await A.until('S.connected === false', 4000, 10);
      if (!(await A.until('S.connected === true && socialIntro() === 0', 6000, 5))) throw new Error('the socket never reopened ahead of its hello');
      return Date.now();
    };
    // C4. A tap in that moment waits for the hello and goes behind it.
    {
      await reopenSlow(800);
      await A.ev(LAUNCH('duel'));
      const s = (await A.until(PLAYING('duel'), 10000)) ? await A.ev(SEEN) : null;
      note('C4 tap before the hello is out', 'duel', 'chosen', want, s && s.me);
      if (s && s.me === want) ok(`C4: a tap made before the socket's hello has gone out waits for it, and is seated as '${want}'`);
      else fail('C4: ' + JSON.stringify(s));
      await A.ev(`(localStorage.removeItem('__ccTokMs'), true)`);
      await leave(A);
    }
    // C5. But not for ever: a token that takes four seconds lets the tap go at
    // HELLO_WAIT_MS (2.5 s) without it, and the name the server could not use
    // is said.
    {
      const t0 = await reopenSlow(4000);
      await A.ev(LAUNCH('duel'));
      const s = (await A.until(PLAYING('duel'), 10000)) ? await A.ev(SEEN) : null;
      const ms = Date.now() - t0;
      const told = s ? await A.until(`(window.__toasts || []).some((t) => /your name/i.test(t) && t.includes(S.names[S.you]))`, 2000) : false;
      note('C5 hello 4 s late', 'duel', 'chosen', 'within 3.6 s, told', s && s.me, `${ms} ms`);
      if (s && ms >= 2400 && ms < 3600 && (s.me === want || told)) ok(`C5: when the hello is four seconds late the tap goes after ${ms} ms, and the player is told what they are called ('${s.me}')`);
      else fail('C5: ' + JSON.stringify({ ms, s, told }));
      await A.ev(`(localStorage.removeItem('__ccTokMs'), true)`);
      await leave(A);
    }
    // C6. And a tap made after that limit, with the hello still not out, goes
    // at once.
    {
      const t0 = await reopenSlow(6000);
      await sleep(Math.max(0, 2700 - (Date.now() - t0)));
      const t1 = Date.now();
      await A.ev(LAUNCH('duel'));
      const s = (await A.until(PLAYING('duel'), 10000)) ? await A.ev(SEEN) : null;
      const ms = Date.now() - t1;
      note('C6 tap after the wait', 'duel', 'chosen', 'at once', s && s.me, `${ms} ms`);
      if (s && ms < 1200) ok(`C6: a tap made after the wait, with the hello still out, goes at once (${ms} ms)`);
      else fail('C6: ' + JSON.stringify({ ms, s }));
      await A.ev(`(localStorage.removeItem('__ccTokMs'), true)`);
      await leave(A);
    }
  }

  // ==== D. SQUADS, two pages ===========================================================
  // The leader (signed in) makes a squad, the member joins by its code, the
  // leader arms the mode, both ready, and the squad starts itself.
  const RACK = `(async () => { const g = await import('./game-core.js'); const n = g.loadoutSizeFor(CC_SQUAD.mode) || 5;
    return ['mortar', 'cluster', 'napalm', 'airstrike', 'volley', 'buster', 'gas'].slice(0, n); })()`;
  const sq = (p, frame) => p.ev(`new Promise((r) => socialSend(${frame}, r))`);
  const rows = (p) => p.ev(`(Bay.show('home'), [...document.querySelectorAll('#bay .sqm')].map((e) => ({ name: (e.querySelector('.sqmt') || {}).textContent, you: !!e.querySelector('.sqmy') })))`);
  async function squadUp(lead, member) {
    const made = await sq(lead, `{ type: 'squad', op: 'create', name: myName(), skin: mySkin() }`);
    const code = made && made.code;
    if (!code) throw new Error('no squad was made: ' + JSON.stringify(made));
    await member.ev(`(joinSquadByCode(${JSON.stringify(code)}), true)`);
    const both = `!!window.CC_SQUAD && CC_SQUAD.code === ${JSON.stringify(code)} && CC_SQUAD.members.length === 2`;
    if (!(await lead.until(both, 6000)) || !(await member.until(both, 6000))) throw new Error('the member never joined');
    return code;
  }
  async function squadStart(lead, member, mode) {
    const tees = mode === 'golf' ? `'mens'` : 'null';
    await sq(lead, `{ type: 'squad', op: 'mode', mode: ${JSON.stringify(mode)}, tees: ${tees}, max: null }`);
    const armed = `!!window.CC_SQUAD && CC_SQUAD.mode === ${JSON.stringify(mode)}`;
    if (!(await lead.until(armed, 5000)) || !(await member.until(armed, 5000))) throw new Error('the mode never armed');
    for (const p of [member, lead]) { const rack = await p.ev(RACK); await sq(p, `{ type: 'squad', op: 'ready', ready: true, loadout: ${JSON.stringify(rack)} }`); }
    const okL = await lead.until(PLAYING(mode), 8000), okM = await member.until(PLAYING(mode), 8000);
    return { lead: okL ? await lead.ev(SEEN) : null, member: okM ? await member.ev(SEEN) : null };
  }
  async function squadDone(lead, member) {
    for (const p of [member, lead]) { await sq(p, `{ type: 'squad', op: 'leave' }`).catch(() => {}); await leave(p); }
  }
  const seatOk = (s, me, them) => !!s && s.me === me && s.card === `${me} (you)` && s.names.includes(them);
  if (ONLY.has('D') || ONLY.has('E') || ONLY.has('F')) B = await openChrome('B');
  if (ONLY.has('D')) {
    const plan = [['typed', ['duel', 'golf']], ['default', ['ffa', 'aliens']], ['other', ['boss']]];
    const lead = await become(A, KINDS.chosen);
    for (const [k, modes] of plan) {
      const mem = await become(B, KINDS[k]);
      for (const mode of modes) {
        await A.nav();
        await squadUp(A, B);
        const ra = await rows(A), rb = await rows(B);
        const rowsOk = ra.some((r) => r.you && r.name === lead) && ra.some((r) => !r.you && r.name === mem)
          && rb.some((r) => r.you && r.name === mem) && rb.some((r) => !r.you && r.name === lead);
        const s = await squadStart(A, B, mode);
        note('D squad (leader)', mode, 'chosen', lead, s.lead && s.lead.me);
        note('D squad (member)', mode, k, mem, s.member && s.member.me);
        if (rowsOk && seatOk(s.lead, lead, mem) && seatOk(s.member, mem, lead))
          ok(`D: ${mode} squad — the leader '${lead}' and ${KINDS[k].label} '${mem}' are named on both pages' squad rows and seated under those names on both pages`);
        else fail(`D: ${mode} squad with ${k}: ` + JSON.stringify({ lead, mem, ra, rb, s }));
        await squadDone(A, B);
      }
    }
  }

  // ==== E. RIGHT AFTER A RENAME ==========================================================
  if (ONLY.has('E')) {
    SB.rows = fresh();
    const lead0 = await become(A, KINDS.chosen);
    const mem0 = await become(B, KINDS.typed);
    await squadUp(A, B);
    // E1. The guest renames: both pages' rows say the new name at once.
    const NEWG = 'Sand Rider';
    const g = await typeName(B, NEWG);
    const gRows = g && g.ok && (await A.until(`[...document.querySelectorAll('#bay .sqm .sqmt')].some((e) => e.textContent === ${JSON.stringify(NEWG)})`, 4000))
      && (await B.until(`(Bay.show('home'), [...document.querySelectorAll('#bay .sqm')].some((e) => !!e.querySelector('.sqmy') && e.querySelector('.sqmt').textContent === ${JSON.stringify(NEWG)}))`, 4000));
    // E2. The signed-in leader renames: both pages' rows say the new name at once.
    const NEWS = 'Marguerite Two';
    const set = await A.ev(`new Promise((r) => sendCallsign(${JSON.stringify(NEWS)}, r))`);
    const sRowsA = set && set.ok && (await A.until(`(Bay.show('home'), [...document.querySelectorAll('#bay .sqm')].some((e) => !!e.querySelector('.sqmy') && e.querySelector('.sqmt').textContent === ${JSON.stringify(NEWS)}))`, 4000));
    const sRowsB = await B.until(`[...document.querySelectorAll('#bay .sqm')].some((e) => !e.querySelector('.sqmy') && e.querySelector('.sqmt').textContent === ${JSON.stringify(NEWS)})`, 4000);
    const chips = await A.ev(`(Bay.show('home'), document.querySelector('#bay .chip[data-cs="name"] b').textContent)`);
    if (gRows) ok(`E1: a guest who renames ('${mem0}' -> '${NEWG}') is named so on their own squad row and on the leader's page at once`);
    else fail(`E1: after the guest's rename the rows say ` + JSON.stringify({ a: await rows(A), b: await rows(B), g }));
    if (sRowsA && sRowsB && chips === NEWS) ok(`E2: a signed-in player who renames ('${lead0}' -> '${NEWS}') is named so on the home chip, on their own squad row and on the member's page at once`);
    else fail(`E2: after the signed-in rename: ` + JSON.stringify({ set, chips, a: await rows(A), b: await rows(B) }));
    // E3. And the next match, the squad's, seats both new names.
    const s = await squadStart(A, B, 'duel');
    note('E rename (leader)', 'duel', 'chosen', NEWS, s.lead && s.lead.me);
    note('E rename (member)', 'duel', 'typed', NEWG, s.member && s.member.me);
    if (seatOk(s.lead, NEWS, NEWG) && seatOk(s.member, NEWG, NEWS)) ok(`E3: the next match seats both new names, '${NEWS}' and '${NEWG}', on both pages`);
    else fail('E3: the match after the renames seated ' + JSON.stringify(s));
    await squadDone(A, B);
    SB.rows = fresh();
  }

  // ==== F. A NAME THE SERVER REFUSES ========================================================
  if (ONLY.has('F')) {
    SB.rows = fresh();
    // The guest keeps a name while it is free; then an account takes it.
    const X = 'Dune Viper';
    await become(B, KINDS.typed);
    const kept = await typeName(B, X);
    await become(A, KINDS.chosen);
    const took = await A.ev(`new Promise((r) => sendCallsign(${JSON.stringify(X)}, r))`);
    if (!(kept && kept.ok && took && took.ok)) fail('F: setup ' + JSON.stringify({ kept, took }));
    await B.nav();
    await B.ev(LAUNCH('duel'));
    const s = (await B.until(PLAYING('duel'), 8000)) ? await B.ev(SEEN) : null;
    const told = s ? await B.until(`(window.__toasts || []).some((t) => t.includes(S.names[S.you]) && /your name/i.test(t))`, 3000) : false;
    const said = await B.ev('(window.__toasts || []).slice()');
    // ON SCREEN AND ON TOP, over the draft that opens with a duel, and still
    // there four seconds on: a sentence to read, not a flash.
    const SEEN_TOAST = `(() => { const t = [...document.querySelectorAll('.toast-item')].find((e) => /your name/i.test(e.textContent)); if (!t) return null;
      // #toast takes no pointer events, which hides it from elementFromPoint,
      // so it takes them for the one question and gives them back.
      const host = document.getElementById('toast'), pe = host.style.pointerEvents; host.style.pointerEvents = 'auto'; t.style.pointerEvents = 'auto';
      const r = t.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      host.style.pointerEvents = pe; t.style.pointerEvents = '';
      const fs = parseFloat(getComputedStyle(t).fontSize);
      return { top: !!at && t.contains(at), over: at ? (at.id || at.className || at.tagName) : null, fs, op: +getComputedStyle(t).opacity,
        inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, oneLine: r.height < fs * 3, w: Math.round(r.width), vw: innerWidth }; })()`;
    const v0 = told ? await B.ev(SEEN_TOAST) : null;
    await B.metrics(667, 375);                          // the smallest landscape phone the layout suite holds
    await sleep(100);
    const v1 = told ? await B.ev(SEEN_TOAST) : null;
    await B.metrics(874, 402);
    await sleep(3900);
    const v4 = told ? await B.ev(SEEN_TOAST) : null;
    const shown = (v) => !!v && v.top && v.inView && v.oneLine && v.fs >= 14;
    if (shown(v0) && shown(v1) && v4 && v4.top && v4.op > 0.5) ok(`F: the sentence is on screen, on top of the battlefield, whole and on one line (${v0.w}px at 874x402, ${v1.w}px at 667x375), ${v0.fs}px, and still up four seconds later`);
    else fail('F: the sentence on screen: ' + JSON.stringify({ v0, v1, v4 }));
    note('F refused', 'duel', 'typed', `a default name, and told`, s && s.me, said.join(' / '));
    if (s && s.me !== X && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(s.me) && s.card === `${s.me} (you)` && told)
      ok(`F: a guest whose name ('${X}') an account has since taken is seated as '${s.me}' and told so: ${JSON.stringify(said.find((t) => /your name/i.test(t)))}`);
    else fail('F: a refused name: ' + JSON.stringify({ s, said }));
    // Told once: the same match's next snapshot says nothing more.
    if (s) {
      const n0 = said.filter((t) => /your name/i.test(t)).length;
      await B.ev(`(sendMsg({ type: 'sync' }), true)`);
      await sleep(800);
      const n1 = (await B.ev('(window.__toasts || []).slice()')).filter((t) => /your name/i.test(t)).length;
      if (n0 === 1 && n1 === 1) ok('F: told once for the match, not again on its next snapshot');
      else fail(`F: told ${n0} time(s) at the start and ${n1} after a sync`);
    }
    await leave(B);
    // Behind the quick doors (a reopen into a held match whose seat was
    // renamed), the sentence waits for the doors like every toast, and comes
    // out after them as the same five-second sentence.
    const held = await B.ev(`(() => {
      window.CC_DOORS = 'quick'; window.CC_DOORS_UP = true;
      tellRenamed(true, 'HELD', 'Iron Ridge');
      const during = [...document.querySelectorAll('.toast-item')].some((t) => /your name/i.test(t.textContent));
      window.CC_DOORS_UP = false; document.dispatchEvent(new Event('cc:doorsgone'));
      const t = [...document.querySelectorAll('.toast-item')].find((x) => /Iron Ridge/.test(x.textContent));
      window.CC_DOORS = null;
      return { during, after: !!t, long: !!t && t.classList.contains('long') };
    })()`);
    if (!held.during && held.after && held.long) ok('F: behind the quick doors the sentence waits, and comes out after them as the same five-second sentence');
    else fail('F: behind the doors: ' + JSON.stringify(held));
    // An account's own name is never "refused" to it: the leader's next match.
    await A.nav();
    await A.ev(LAUNCH('duel'));
    const sa = (await A.until(PLAYING('duel'), 8000)) ? await A.ev(SEEN) : null;
    if (sa && sa.me === X && !sa.toasts.some((t) => /your name/i.test(t))) ok(`F: the account that took '${X}' is seated under it and told nothing`);
    else fail('F: the account that took the name: ' + JSON.stringify(sa));
    await leave(A);
    SB.rows = fresh();
  }
  // ==== G. ON THE WIRE ====================================================================
  if (ONLY.has('G')) {
    const WS_URL = `ws://127.0.0.1:${appPort}/ws`;
    const sock = () => new Promise((res, rej) => { const w = new WebSocket(WS_URL); w.rx = []; w.onmessage = (e) => { try { w.rx.push(JSON.parse(e.data)); } catch {} }; w.onopen = () => res(w); w.onerror = rej; });
    const tx = (w, m) => w.send(JSON.stringify(m));
    const wait = async (w, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = w.rx.find(pred); if (m) return m; await sleep(20); } return null; };
    const rooms = async () => (await (await get(`http://127.0.0.1:${appPort}/health`)).json()).rooms;
    const AI = (name) => ({ type: 'ai', difficulty: 'easy', name, skin: 'olive' });
    // G1. hello, then a seat at once: the seat waits for the hello.
    {
      const w = await sock();
      tx(w, { type: 'hello', token: 'tok-chosen' }); tx(w, AI(CHOSEN));
      const st = await wait(w, (m) => m.type === 'start', 5000);
      if (st && st.names[st.you] === CHOSEN && !('renamed' in st)) ok(`G1: a seat sent straight behind its hello waits for it and is '${CHOSEN}'`);
      else fail('G1: ' + JSON.stringify(st && { me: st.names[st.you], renamed: st.renamed }));
      tx(w, { type: 'leave' }); w.close();
    }
    // G2. A hello GoTrue never answers holds the seat for HELLO_HOLD_MS (3 s),
    // not for the server's 8 s timeout: then the name is judged by what is
    // known (a name an account holds is refused) and the seat is told so.
    // OTHER is the account name no part renames: the server's name index,
    // unlike the stand-in's rows, keeps every rename the parts above made.
    {
      const w = await sock();
      const t0 = Date.now();
      tx(w, { type: 'hello', token: 'tok-hang' }); tx(w, AI(OTHER));
      const st = await wait(w, (m) => m.type === 'start', 9000);
      const ms = Date.now() - t0;
      if (st && ms >= 2700 && ms < 6000 && st.names[st.you] !== OTHER && st.renamed === true) ok(`G2: behind a hello that never settles, the seat goes after ${ms} ms under a default name ('${st.names[st.you]}'), marked renamed`);
      else fail('G2: ' + JSON.stringify({ ms, st: st && { me: st.names[st.you], renamed: st.renamed } }));
      tx(w, { type: 'leave' }); w.close();
    }
    // G3. Frames behind a held one keep their order: a raid's create, then its
    // host's start, both sent while the hello is out.
    {
      const w = await sock();
      tx(w, { type: 'hello', token: 'tok-chosen' });
      tx(w, { type: 'create', name: CHOSEN, skin: 'olive', mode: 'boss', max: 1 });
      tx(w, { type: 'startMatch' });
      const st = await wait(w, (m) => m.type === 'start', 5000);
      if (st && st.mode === 'boss' && st.names[st.you] === CHOSEN) ok('G3: a start sent behind a held create waits behind it, so the raid starts');
      else fail('G3: ' + JSON.stringify({ st: st && st.names, rx: w.rx.map((m) => m.type) }));
      tx(w, { type: 'leave' }); w.close();
    }
    // G4. A socket that closes while its seat waits leaves no room behind.
    {
      await sleep(300);
      const before = await rooms();
      const w = await sock();
      tx(w, { type: 'hello', token: 'tok-chosen' }); tx(w, AI(CHOSEN));
      w.close();
      await sleep(USER_MS + 900);
      const after = await rooms();
      if (after === before) ok(`G4: a socket that closed while its seat waited left no room behind (${before} -> ${after})`);
      else fail(`G4: rooms ${before} -> ${after} after a socket closed with a seat waiting`);
    }
    // G5. `renamed` is on the refused seat's own match frames only, and no
    // lobby frame moves: a guest who presents an account's name hosts a
    // free-for-all room, another guest joins.
    {
      const h = await sock(), j = await sock();
      tx(h, { type: 'create', name: OTHER, skin: 'olive', mode: 'ffa', max: 2 });
      const lh = await wait(h, (m) => m.type === 'lobby', 4000);
      tx(j, { type: 'join', code: lh && lh.code, name: 'Tank Ace', skin: 'olive' });
      const sh = await wait(h, (m) => m.type === 'start', 5000), sj = await wait(j, (m) => m.type === 'start', 5000);
      const lj = j.rx.find((m) => m.type === 'lobby');
      if (lh && !('renamed' in lh) && lh.players[0].name !== OTHER && (!lj || !('renamed' in lj)) && sh && sh.renamed === true && sh.names[sh.you] !== OTHER && sj && !('renamed' in sj) && sj.names[sj.you] === 'Tank Ace')
        ok(`G5: the refused seat's own start frame carries renamed; the other player's carries nothing new, and no lobby frame moves`);
      else fail('G5: ' + JSON.stringify({ lh: lh && { r: lh.renamed, n: lh.players }, lj: lj && lj.renamed, sh: sh && sh.renamed, sj: sj && { r: sj.renamed, me: sj.names[sj.you] } }));
      for (const w of [h, j]) { tx(w, { type: 'leave' }); w.close(); }
    }
    // G6. A hold that gave up on one hello does not take a seat waiting on the
    // next: the first hello settles (3.5 s) after its hold let go (3 s), while
    // a second hello, sent after that, is still being verified (1 s).
    {
      const w = await sock();
      tx(w, { type: 'hello', token: 'tok-late' }); tx(w, AI(OTHER));
      const st1 = await wait(w, (m) => m.type === 'start', 6000);
      tx(w, { type: 'leave' });
      tx(w, { type: 'hello', token: 'tok-slow2' }); tx(w, AI(OTHER));
      const st2 = await wait(w, (m) => m.type === 'start' && m !== st1, 6000);
      if (st1 && st1.renamed === true && st2 && st2.names[st2.you] === OTHER && !('renamed' in st2))
        ok(`G6: a seat waiting on a second hello is not let go when the first one settles late; it is seated as '${OTHER}'`);
      else fail('G6: ' + JSON.stringify({ st1: st1 && { me: st1.names[st1.you], r: st1.renamed }, st2: st2 && { me: st2.names[st2.you], r: st2.renamed } }));
      tx(w, { type: 'leave' }); w.close();
    }
  }
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
}

console.log('\n  THE NAME AUDIT (part | mode | player | wanted | seated | note)');
for (const r of matrix) console.log('   ' + r.map((x) => String(x)).join(' | '));
console.log(errors.length ? `\n${errors.length} FAILED` : '\nALL GOOD');
cleanup();
process.exit(errors.length ? 1 : 0);
