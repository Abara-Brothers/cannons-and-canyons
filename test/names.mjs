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
//   H. EVERY NAME RESERVED (owner, 2026-10-10, item 28). Parts A to G run with
//      the stand-in's name_reservations table MISSING, which is the state the
//      server ships into before the owner applies its migration: the old name
//      rules, end to end. Then the table appears, the server turns unique names
//      on with no restart, and two real pages are reserved their names, a
//      duplicate from before is moved to an unused default and told once,
//      Bay controls and the home chip show the new name, a match seats it
//      whatever name a frame carries, the move to an account keeps it, and a
//      rename frees the old one.
//   W. EVERY NAME WHOLE (round 3 fix, 2026-10-10). The right name, cut, is
//      not the name: in the compact in-match HUD the player's own name and
//      "(you)" ended in an ellipsis past 84px (62px on a four-player card),
//      and the server's numbered default names were cut in the home Squad box
//      and on a Friends card. At the owner's two phone shapes (667x375, and
//      874x402 with the iPhone 17's safe areas), every surface that draws a
//      name is drawn with the widest default names the server can hand out,
//      measured in that surface's own face, and every letter of each must be
//      on the screen: no ellipsis, nothing clipped by a box, nothing off the
//      screen. The HUD's cards are read for every seat of a duel, a
//      three-player and a four-player match and a raid, with "(you)" on the
//      player's own.
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
// A socket with headers of its own (H15: the edge's CF-Connecting-IP).
import NodeWS from 'ws';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  names tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ONLY = new Set(String(process.env.NAMES_ONLY || 'A,B,C,D,E,F,G,H,W').split(',').map((s) => s.trim()));
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
// An ANONYMOUS account, for part H's move: a guest's first save.
const ANON_ID = '33333333-3333-4333-8333-333333333333';
// Two more anonymous accounts, for H7's change of account on one socket.
const ANON2_ID = '44444444-4444-4444-8444-444444444444', ANON3_ID = '55555555-5555-4555-8555-555555555555';
const ANONS = new Set([ANON_ID, ANON2_ID, ANON3_ID]);
const TOKENS = { 'tok-chosen': CHOSEN_ID, 'tok-other': OTHER_ID, 'tok-late': OTHER_ID, 'tok-slow2': OTHER_ID, 'tok-anon': ANON_ID, 'tok-anon2': ANON2_ID, 'tok-anon3': ANON3_ID };
// ROUND 3'S TABLE, name_reservations, as the migration makes it: name_key,
// secret_hash and user_id each unique (a 409 on a clash), answered the way
// PostgREST answers server/store.js's paths. OFF (a 404, the migration not
// applied) until part H turns it on.
// `failFor` makes that many reads by one secret's hash answer 503, as a store
// that is down does (H13), and `readsFor` keeps when each read by a hash came.
// `slowUser` holds the read of that account's row for 600 ms (H15c), so a
// frame can land while a claim is out.
const RES = { on: false, rows: [], seq: 0, refused: 0, failFor: {}, readsFor: {}, slowUser: null };
const resClash = (r, self) => RES.rows.some((o) => o !== self && (o.name_key === r.name_key || (r.secret_hash && o.secret_hash === r.secret_hash) || (r.user_id && o.user_id === r.user_id)));
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
      return id ? json(200, { id, aud: 'authenticated', is_anonymous: ANONS.has(id) }, DELAY[tok] ?? USER_MS) : json(401, {});
    }
    if (u.pathname === '/rest/v1/name_reservations') {
      // `refused` counts the server's reads of the table into memory (its
      // keys), not /health's probe, which reads every column.
      if (!RES.on) { if (u.searchParams.get('select') === 'name_key') RES.refused++; return json(404, { code: '42P01', message: 'relation does not exist' }); }
      const q = (k) => u.searchParams.get(k) || '';
      const eqv = (k) => (q(k).startsWith('eq.') ? q(k).slice(3) : null);
      const at = new Date().toISOString();
      let b = {}; try { b = body ? JSON.parse(body) : {}; } catch {}
      if (req.method === 'GET' && eqv('secret_hash') !== null) {
        const h = eqv('secret_hash');
        (RES.readsFor[h] = RES.readsFor[h] || []).push(Date.now());
        if (RES.failFor[h] > 0) { RES.failFor[h]--; return json(503, { message: 'upstream down' }); }
      }
      if (req.method === 'GET' && q('select') === 'name_key' && eqv('name_key') === null) {
        const after = q('name_key').startsWith('gt.') ? q('name_key').slice(3) : '';
        return json(200, RES.rows.map((r) => r.name_key).sort().filter((k) => !after || k > after).slice(0, +q('limit') || 1000).map((k) => ({ name_key: k })));
      }
      let rows = RES.rows;
      for (const k of ['id', 'user_id', 'secret_hash', 'name_key']) if (eqv(k) !== null) rows = rows.filter((r) => String(r[k]) === eqv(k));
      if (q('user_id') === 'is.null') rows = rows.filter((r) => !r.user_id);
      if (q('secret_hash') === 'is.null') rows = rows.filter((r) => !r.secret_hash);
      if (req.method === 'GET') return json(200, rows.slice(0, 1), RES.slowUser && eqv('user_id') === RES.slowUser ? 600 : 0);
      if (req.method === 'POST') {
        const r = { id: ++RES.seq, secret_hash: null, user_id: null, linked: false, reused: false, ...b, created_at: at, last_seen_at: at };
        if (resClash(r)) return json(409, { code: '23505' });
        RES.rows.push(r);
        return json(201, [r]);
      }
      if (req.method === 'PATCH') {
        for (const r of rows) if (resClash({ ...r, ...b }, r)) return json(409, { code: '23505' });
        for (const r of rows) Object.assign(r, b);
        return json(200, rows);
      }
      if (req.method === 'DELETE') {
        if (q('linked') === 'is.false') rows = rows.filter((r) => !r.linked && r.last_seen_at < q('last_seen_at').slice(3));
        RES.rows = RES.rows.filter((r) => !rows.includes(r));
        return json(200, rows.map((r) => ({ name_key: r.name_key })));
      }
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
  // EVERY FRAME THE PAGE SENDS, kept (part H asks what a claim carried).
  const sendWs = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) { try { (window.__sent = window.__sent || []).push(JSON.parse(d)); } catch {} return sendWs.call(this, d); };
  // AND EVERY TOAST, from the moment the page starts: a claim's answer can
  // land before nav() has wrapped showToast.
  // The DOCUMENT is observed, not its root element: at document start there is
  // no root element yet, and a throw here would take the stand-in below with it.
  window.__toastsDom = [];
  try {
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList && n.classList.contains('toast-item')) window.__toastsDom.push(n.textContent); })
      .observe(document, { childList: true, subtree: true });
  } catch {}
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
    tag, ev, until, metrics, send,
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
async function leave(p, opts) {
  await p.ev(`(document.getElementById('leaveYesBtn').onclick(), true)`).catch(() => {});
  await sleep(300);
  await p.nav(opts);
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

  // ==== H. EVERY NAME RESERVED =================================================================
  if (ONLY.has('H')) {
    const { createHash } = await import('node:crypto');
    const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
    SB.rows = fresh();
    if (!B) B = await openChrome('B');
    // THE MIGRATION LANDS while the server runs: within its thirty-second
    // retry it reads the table and turns unique names on, with no restart.
    const before = await (await get(`${ORIGIN}health`)).json();
    // THE MISSING TABLE IS SAID ONCE, however often the server tries it: wait
    // for its first retry (thirty seconds after boot), then count the lines.
    for (let i = 0; i < 90 && RES.refused < 2; i++) await sleep(500);
    const offLines = (srvLog.match(/\[names\] reservations OFF: name_reservations is not there yet/g) || []).length;
    if (RES.refused >= 2 && offLines === 1) ok(`H: the server was refused the missing table ${RES.refused} times and said so once in its log`);
    else fail('H: the missing table in the log: ' + JSON.stringify({ refused: RES.refused, offLines }));
    RES.on = true;
    let on = false;
    for (let i = 0; i < 80 && !on; i++) { on = (await (await get(`${ORIGIN}health`)).json()).nameReservations === 'on'; if (!on) await sleep(500); }
    if (before.nameReservations === 'off' && on) ok('H: with the table missing the server ran parts A to G on the old rules (nameReservations off), and turned unique names on within its retry once the table appeared, with no restart');
    else fail('H: turning on: ' + JSON.stringify({ before: before.nameReservations, on }));
    // H1. A NEW DEVICE: its first default is reserved, silently.
    const nameA = await become(A, KINDS.default);
    await A.until(`!!localStorage.getItem('cc_name_secret')`, 5000);
    const secA = await A.ev(`localStorage.getItem('cc_name_secret')`);
    const rowA = RES.rows.find((r) => r.name === nameA);
    const toastsA = await A.ev('(window.__toastsDom || []).slice()');
    const claimA = (await A.ev(`(window.__sent || []).filter((f) => f.type === 'name')`))[0];
    if (rowA && secA && rowA.secret_hash === sha(secA) && !RES.rows.some((r) => JSON.stringify(r).includes(secA)) && !toastsA.some((t) => /your name/i.test(t))
        && claimA && claimA.name === nameA && claimA.fresh === true && !('secret' in claimA))
      ok(`H1: a new device's default ('${nameA}') is reserved on its first connect (its claim marked fresh, with no secret), the device keeps the server's secret and the table only its SHA-256, and nothing is said`);
    else fail('H1: ' + JSON.stringify({ nameA, secA: !!secA, rowA, toastsA, claimA }));
    // H2. A DUPLICATE FROM BEFORE THIS SHIPPED: a device that has carried the
    // same default for weeks, with no secret. The first to reserve keeps it.
    await B.nav();
    // And it changed its name an hour ago, so its day is still running (H2's
    // day check, below).
    await B.ev(`(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('pt_name', ${JSON.stringify(nameA)}); localStorage.setItem('cc_name_own', ${JSON.stringify(nameA)});
      localStorage.setItem('cc_name_at', String(Date.now() - 3600000)); return true; })()`);
    await B.nav();
    const moved = await B.until(`myName() !== ${JSON.stringify(nameA)} && !!localStorage.getItem('cc_name_secret')`, 6000);
    const nameB = await B.ev('myName()');
    const toldB = await B.until(`(window.__toastsDom || []).some((t) => t.startsWith('Your name was taken'))`, 3000);
    const saidB = (await B.ev('(window.__toastsDom || []).slice()')).filter((t) => /your name/i.test(t));
    const scrB = await B.ev(SCREENS);
    const ownB = await B.ev('ownName()');
    const rowB = RES.rows.find((r) => r.name === nameB);
    const claimB = (await B.ev(`(window.__sent || []).filter((f) => f.type === 'name')`))[0];
    if (claimB && claimB.name === nameA && !('fresh' in claimB) && !('secret' in claimB)) ok(`H2: a device that has carried its name before claims it plainly: '${nameA}', not fresh, no secret`);
    else fail('H2: the old device\'s claim: ' + JSON.stringify(claimB));
    const want = `Your name was taken, so you're now ${nameB}. You can change it in Bay controls.`;
    if (moved && toldB && same(saidB, [want]) && nameB !== nameA && /^[A-Z][a-z]+ [A-Z][a-z]+( [2-9])?$/.test(nameB) && ownB === nameB && rowB && !rowB.user_id
        && scrB.chip === nameB && scrB.controls.includes(nameB) && RES.rows.filter((r) => r.name === nameA).length === 1)
      ok(`H2: a second device carrying '${nameA}' from before is moved to an unused default ('${nameB}') and told, in the owner's words: "${want}"; the home chip and Bay controls show '${nameB}'`);
    else fail('H2: ' + JSON.stringify({ moved, nameB, toldB, saidB, ownB, rowB, chip: scrB.chip, controls: scrB.controls.includes(nameB) }));
    // THE MOVE IS NOT THE PLAYER'S CHANGE (round 3 fix, 2026-10-10). The
    // device had changed its name an hour before, so its day was running; the
    // notice says "You can change it in Bay controls", and it can: the move
    // cleared the day, the Callsign row names the new name (not "Change it
    // again in 23 hours"), and Change opens on the rules with Save live.
    const dayB = await B.ev(`new Promise((r) => { Bay.show('settings');
      const row = [...document.querySelectorAll('#bay .row')].find((x) => x.querySelector('.rn2') && x.querySelector('.rn2').textContent === 'Callsign');
      const desc = row ? row.querySelector('.rd').textContent : null;
      document.querySelector('#bay [data-cs="open"]').click();
      setTimeout(() => { const save = document.querySelector('#bay [data-cs="save"]'), line = document.querySelector('#bay .csr');
        const o = { at: localStorage.getItem('cc_name_at'), wait: nameWait(), desc, save: save ? !save.disabled : null, line: line ? line.textContent : null };
        const c = document.querySelector('#bay [data-cs="cancel"]'); if (c) c.click(); Bay.show('home'); r(o); }, 150); })`);
    if (dayB.at === null && dayB.wait === 0 && dayB.desc === nameB && dayB.save === true && /^3.16 letters/.test(dayB.line || ''))
      ok(`H2: the move does not spend the player's change: a day that was running is cleared, Bay controls names '${nameB}', and Change opens on the rules with Save live`);
    else fail('H2 day: ' + JSON.stringify(dayB));
    // Told once: a reload says nothing more, and the name stays.
    await B.nav();
    await sleep(800);
    const again = (await B.ev('(window.__toastsDom || []).slice()')).filter((t) => /your name/i.test(t));
    const claimB2 = (await B.ev(`(window.__sent || []).filter((f) => f.type === 'name')`))[0];
    // And an answer that arrives twice says it once.
    const twice = await B.ev(`new Promise((r) => { const m = { type: 'name', ok: true, name: myName(), moved: 'taken' }; nameMovedTold = ''; window.__toastsDom = [];
      nameClaimed(m); nameClaimed(m); setTimeout(() => r(window.__toastsDom.filter((t) => t.startsWith('Your name was taken')).length), 50); })`);
    if (!again.length && (await B.ev('myName()')) === nameB && claimB2 && claimB2.secret && !('fresh' in claimB2) && twice === 1)
      ok('H2: told once: the next load claims with the device\'s secret, is answered the same name and says nothing, and an answer that arrives twice is said once');
    else fail('H2 once: ' + JSON.stringify({ again, me: await B.ev('myName()'), claimB2, twice }));
    // The notice, legible: on screen, whole, at least 14px, at the two phone
    // shapes the layout suite holds, on top of the home screen.
    const NOTICE = `(() => { const t = [...document.querySelectorAll('.toast-item')].find((e) => e.textContent.startsWith('Your name was taken')); if (!t) return null;
      const r = t.getBoundingClientRect(), fs = parseFloat(getComputedStyle(t).fontSize), lh = parseFloat(getComputedStyle(t).lineHeight) || fs * 1.2;
      return { inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, fs, lines: Math.round((t.clientHeight - parseFloat(getComputedStyle(t).paddingTop) - parseFloat(getComputedStyle(t).paddingBottom)) / lh), w: Math.round(r.width), vw: innerWidth,
        whole: t.scrollWidth <= t.clientWidth + 1 && t.scrollHeight <= t.clientHeight + 1 }; })()`;
    const legible = [];
    for (const [w, h] of [[874, 402], [667, 375]]) {
      await B.metrics(w, h);
      await B.ev(`(nameMovedTold = '', tellNameMoved('taken', 'Scorched Turret 9'), true)`);
      await sleep(150);
      legible.push(await B.ev(NOTICE));
    }
    await B.metrics(874, 402);
    if (legible.every((v) => v && v.inView && v.whole && v.fs >= 14 && v.lines <= 2))
      ok(`H2: the notice with the longest default name is whole, inside the screen and ${legible[0].fs}px at 874x402 (${legible[0].lines} line, ${legible[0].w}px) and 667x375 (${legible[1].lines} lines, ${legible[1].w}px)`);
    else fail('H2 legible: ' + JSON.stringify(legible));
    // H3. A MATCH SEATS THE RESERVED NAME, and a frame carrying another
    // player's name is seated under this player's own.
    await B.nav();
    await B.ev(LAUNCH('duel'));
    const sB = (await B.until(PLAYING('duel'), 8000)) ? await B.ev(SEEN) : null;
    await leave(B);
    await B.ev(`(intent({ type: 'ai', difficulty: 'easy', name: ${JSON.stringify(nameA)}, skin: mySkin() }), true)`);
    const sF = (await B.until(PLAYING('duel'), 8000)) ? await B.ev(SEEN) : null;
    await leave(B);
    if (sB && sB.me === nameB && sB.card === `${nameB} (you)` && !sB.toasts.some((t) => /could not be used/.test(t)) && sF && sF.me === nameB)
      ok(`H3: a match seats '${nameB}', the reserved name, and a frame that carries '${nameA}' is seated as '${nameB}' too`);
    else fail('H3: ' + JSON.stringify({ sB, sF }));
    // H4. THE MOVE TO AN ACCOUNT KEEPS THE NAME: the guest's first save makes
    // an anonymous account, and the device's row becomes the account's.
    const rowIdB = RES.rows.find((r) => r.name === nameB).id;
    await B.ev(`(() => { localStorage.setItem('__ccTestTok', 'tok-anon'); localStorage.setItem('__ccTestWho', ${JSON.stringify(JSON.stringify({ id: ANON_ID, anonymous: true, google: false, apple: false, email: null, accounts: [] }))}); return true; })()`);
    // An anonymous account has no friends snapshot to wait for.
    await B.nav({ settle: false });
    let rowAcct = null;
    for (let i = 0; i < 40 && !rowAcct; i++) { rowAcct = RES.rows.find((r) => r.id === rowIdB && r.user_id === ANON_ID) || null; if (!rowAcct) await sleep(100); }
    const meAcct = await B.ev('myName()');
    const saidAcct = (await B.ev('(window.__toastsDom || []).slice()')).filter((t) => /your name/i.test(t));
    if (rowAcct && rowAcct.name === nameB && meAcct === nameB && !saidAcct.length && RES.rows.filter((r) => r.user_id === ANON_ID).length === 1 && rowAcct.secret_hash === null)
      ok(`H4: a guest who gets an account keeps '${nameB}': the same row moved to the account, the device's secret came off it, and nothing was said`);
    else fail('H4: ' + JSON.stringify({ rowAcct, meAcct, saidAcct, rows: RES.rows }));
    // H5. A RENAME frees the old name and holds the new one, for everyone.
    const r1 = await typeName(B, 'Quiet Dawn');
    const r2 = await typeName(A, 'QUIET DAWN');
    const r3 = await typeName(A, nameB);
    const rowNow = RES.rows.find((r) => r.id === rowIdB);
    if (r1 && r1.ok && rowNow && rowNow.name === 'Quiet Dawn' && r2 && r2.error === 'taken' && r3 && r3.ok && RES.rows.find((r) => r.name === nameB && r.secret_hash === sha(secA)))
      ok(`H5: B's rename to 'Quiet Dawn' moves B's row; A is refused 'QUIET DAWN' ("taken") and may now take '${nameB}', which B gave up`);
    else fail('H5: ' + JSON.stringify({ r1, r2, r3, rowNow, rows: RES.rows.map((r) => r.name) }));
    // H12. A claim's answer lands while a player is typing in Bay controls'
    // Callsign field (their socket reconnected): the screen repaints in place
    // and the field keeps what they typed.
    const h12 = await A.ev(`new Promise((r) => { Bay.show('settings'); document.querySelector('#bay [data-cs="open"]').click();
      setTimeout(() => { const i = document.getElementById('bayCall'); if (!i) return r(null); i.value = 'Half Typed';
        nameClaimed({ type: 'name', ok: true, name: myName() });
        setTimeout(() => { const j = document.getElementById('bayCall'); r({ same: j === i, value: j && j.value }); closeCallsign(); Bay.show('home'); }, 100); }, 120); })`);
    if (h12 && h12.same && h12.value === 'Half Typed') ok('H12: a claim\'s answer arriving under an open Callsign field leaves the field, and the half-typed name in it, as it was');
    else fail('H12: ' + JSON.stringify(h12));
    // ON THE WIRE (server.js): A holds '${nameB}' (a rolled pair) and B holds
    // 'Quiet Dawn' (a typed name) from here on.
    const WS_URL = `ws://127.0.0.1:${appPort}/ws`;
    const sock = () => new Promise((res, rej) => { const w = new WebSocket(WS_URL); w.rx = []; w.onmessage = (e) => { try { w.rx.push(JSON.parse(e.data)); } catch {} }; w.onopen = () => res(w); w.onerror = rej; });
    const tx = (w, m) => w.send(JSON.stringify(m));
    const wait = async (w, pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = w.rx.find(pred); if (m) return m; await sleep(20); } return null; };
    const AI = (name) => ({ type: 'ai', difficulty: 'easy', name, skin: 'olive' });
    const seatOf = (st) => st && { me: st.names[st.you], renamed: st.renamed === true };
    // H6. A seat sent straight behind its claim waits for the claim. The
    // claim follows a guest's hello, as the page sends it (round 3 fix: a
    // claim with no hello makes no row, H15).
    {
      const w = await sock();
      tx(w, { type: 'hello' }); tx(w, { type: 'name', name: 'Grim Raven' }); tx(w, AI('Steady Hammer'));
      const st = seatOf(await wait(w, (m) => m.type === 'start', 5000));
      const ans = w.rx.find((m) => m.type === 'name');
      if (ans && ans.ok && ans.name === 'Grim Raven' && st && st.me === 'Grim Raven' && !st.renamed) ok('H6: a seat sent straight behind its claim waits for it, and is the reserved name (\'Grim Raven\'), not the name the frame carried');
      else fail('H6: ' + JSON.stringify({ ans, st }));
      tx(w, { type: 'leave' }); w.close();
    }
    // H7. A socket that changes account lets go of the name it reserved for the
    // last one: without a new claim, a seat no longer wears it.
    {
      const w = await sock();
      tx(w, { type: 'hello', token: 'tok-anon2' }); tx(w, { type: 'name', name: 'Ashen Spire' });
      const ans = await wait(w, (m) => m.type === 'name', 4000);
      tx(w, { type: 'hello', token: 'tok-anon3' });
      await sleep(USER_MS + 300);
      tx(w, AI('Ashen Spire'));
      const st = seatOf(await wait(w, (m) => m.type === 'start', 5000));
      if (ans && ans.name === 'Ashen Spire' && RES.rows.some((r) => r.name === 'Ashen Spire' && r.user_id === ANON2_ID) && st && st.me !== 'Ashen Spire' && st.renamed)
        ok(`H7: after a hello for another account, the socket no longer carries the first account's name: a seat presenting it is refused ('${st.me}', renamed)`);
      else fail('H7: ' + JSON.stringify({ ans, st }));
      tx(w, { type: 'leave' }); w.close();
    }
    // H7b. A sign-out with no claim after it (an old build's) leaves the
    // socket without the account's name too.
    {
      const w = await sock();
      tx(w, { type: 'hello', token: 'tok-anon2' }); tx(w, { type: 'name', name: 'x' });
      const ans = await wait(w, (m) => m.type === 'name', 4000);
      tx(w, { type: 'hello', token: null });
      tx(w, AI('Ashen Spire'));
      const st = seatOf(await wait(w, (m) => m.type === 'start', 5000));
      if (ans && ans.name === 'Ashen Spire' && st && st.me !== 'Ashen Spire' && st.renamed)
        ok(`H7b: an account answered its own name ('Ashen Spire') on any socket; after a sign-out with no new claim, that socket cannot wear it ('${st.me}', renamed)`);
      else fail('H7b: ' + JSON.stringify({ ans, st }));
      tx(w, { type: 'leave' }); w.close();
    }
    // H8 and H9. A socket that never claimed (an old build) cannot show a
    // reserved name: a rolled pair (the door's own question, setNameFree) and
    // a typed one (the name check, which now asks the reservations too).
    for (const [tag, n, how] of [['H8', nameB, 'a reserved rolled pair'], ['H9', 'Quiet Dawn', 'a reserved typed name']]) {
      const w = await sock();
      tx(w, AI(n));
      const st = seatOf(await wait(w, (m) => m.type === 'start', 5000));
      if (st && st.me !== n && st.renamed && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(st.me) && !RES.rows.some((r) => r.name === st.me))
        ok(`${tag}: a socket that never claimed, presenting ${how} ('${n}'), is seated under an unused name ('${st.me}') and told`);
      else fail(`${tag}: ` + JSON.stringify({ n, st }));
      tx(w, { type: 'leave' }); w.close();
    }
    // H10. A tap made while the page's socket was down goes out behind the
    // claim, so it is seated under the reserved name, not refused for it.
    await B.nav({ settle: false });
    await B.ev(`(window.__toasts = [], S.ws.close(), true)`);
    await B.until('S.connected === false', 4000, 10);
    await B.ev(LAUNCH('duel'));
    const s10 = (await B.until(PLAYING('duel'), 10000)) ? await B.ev(SEEN) : null;
    const order = await B.ev(`(() => { const f = (window.__sent || []).map((x) => x.type); const last = f.lastIndexOf('name'); return { claim: last, ai: f.indexOf('ai', last) }; })()`);
    await leave(B, { settle: false });
    if (s10 && s10.me === 'Quiet Dawn' && !s10.toasts.some((t) => /could not be used/.test(t)) && order.claim >= 0 && order.ai > order.claim)
      ok('H10: a tap made while the socket reopened is sent behind the socket\'s claim and seated as \'Quiet Dawn\', with nothing said');
    else fail('H10: ' + JSON.stringify({ s10, order }));
    // H11. Signing out claims again, as this device, straight after the hello
    // that drops the account. CHANGED (round 3 fix, 2026-10-10: a device's
    // secret never confers an account's name): the device's row went to the
    // account in H4 and gave up its secret, so 'Quiet Dawn' stays with the
    // account, and the signed-out device is given a new unused default of its
    // own, silently (the sign-out said it starts a fresh guest), which the
    // next match seats.
    const secOld = await B.ev(`localStorage.getItem('cc_name_secret')`);
    await B.ev(`(window.__toasts = [], window.__toastsDom = [], window.confirm = () => true, document.getElementById('accSignOutBtn').onclick(), true)`);
    await B.until(`(window.__sent || []).some((f) => f.type === 'hello' && f.token === null)`, 4000, 20);
    await B.until(`localStorage.getItem('cc_name_secret') !== ${JSON.stringify(secOld)}`, 5000, 20);
    await B.ev(LAUNCH('duel'));
    const s11 = (await B.until(PLAYING('duel'), 10000)) ? await B.ev(SEEN) : null;
    const after = await B.ev(`(() => { const f = (window.__sent || []); const out = f.findIndex((x) => x.type === 'hello' && x.token === null); return f.slice(out).map((x) => x.type); })()`);
    const claim11 = await B.ev(`(() => { const f = (window.__sent || []); const out = f.findIndex((x) => x.type === 'hello' && x.token === null); return f.slice(out).find((x) => x.type === 'name') || null; })()`);
    const me11 = await B.ev('myName()');
    const sec11 = await B.ev(`localStorage.getItem('cc_name_secret')`);
    const said11 = (await B.ev('(window.__toastsDom || []).slice()')).filter((t) => /your name/i.test(t));
    // Signed out stays signed out: the stand-in's session goes too, so the
    // reload below is this device's guest.
    await B.ev(`(localStorage.removeItem('__ccTestTok'), localStorage.removeItem('__ccTestWho'), true)`);
    await leave(B, { settle: false });
    const row11 = RES.rows.find((r) => r.name === me11);
    if (s11 && s11.me === me11 && me11 !== 'Quiet Dawn' && !s11.toasts.some((t) => /could not be used/.test(t)) && after[1] === 'name'
        && claim11 && claim11.fresh === true && !claim11.account && !said11.length && row11 && row11.user_id === null && row11.secret_hash === sha(sec11)
        && RES.rows.find((r) => r.name === 'Quiet Dawn' && r.user_id === ANON_ID && r.secret_hash === null))
      ok(`H11: signing out claims as the device straight after the hello that drops the account; 'Quiet Dawn' stays with the account, and the device is given its own name ('${me11}') on a row of its own, silently, which the next match seats`);
    else fail('H11: ' + JSON.stringify({ s11, after, claim11, me11, said11, row11, rows: RES.rows.map((r) => [r.name, r.user_id, !!r.secret_hash]) }));
    // H13. A CLAIM THAT FAILS IS ASKED AGAIN ON THE SAME SOCKET, and until it
    // is answered the player is seated under their own name (round 3 fix,
    // 2026-10-10). The store answers this device's next two reads by its
    // secret with a 503: the page's claim and its first retry fail, the
    // second retry is answered, and a match started in between seats the
    // device's own reserved name, not a stand-in.
    const own13 = await B.ev('myName()');
    const h13 = sha(sec11);
    RES.failFor[h13] = 2;
    RES.readsFor[h13] = [];
    await B.nav({ settle: false });
    await B.ev(`(window.__ws13 = S.ws, window.__toastsDom = [], true)`);
    await B.ev(LAUNCH('duel'));
    const s13 = (await B.until(PLAYING('duel'), 10000)) ? await B.ev(SEEN) : null;
    // The retries go on the socket the match is on: it is not left (which
    // reloads the page) until they are answered.
    const answered = await B.until(`S.ws === window.__ws13 && claimTries === 0 && (window.__sent || []).filter((f) => f.type === 'name').length >= 3`, 15000, 100);
    const claims13 = await B.ev(`(window.__sent || []).filter((f) => f.type === 'name')`);
    const me13 = await B.ev('myName()');
    await leave(B, { settle: false });
    const reads = RES.readsFor[h13];
    const gaps = reads.slice(1).map((t, i) => t - reads[i]);
    if (s13 && s13.me === own13 && !s13.toasts.some((t) => /could not be used/.test(t)) && answered && RES.failFor[h13] === 0
        && claims13.length === 3 && claims13.every((f) => f.secret === sec11 && f.name === own13) && me13 === own13
        && reads.length >= 3 && gaps[0] >= 1400 && gaps[1] >= 2900)
      ok(`H13: a claim the store failed is asked again on the same socket, backing off (${gaps.slice(0, 2).map((g) => (g / 1000).toFixed(1) + ' s').join(', then ')}), until it is answered (3 claims); a match started meanwhile seats the player's own '${own13}', not a stand-in`);
    else fail('H13: ' + JSON.stringify({ s13, answered, left: RES.failFor[h13], claims13, me13, gaps }));
    // H14. A SIGNED-IN PLAYER WHOSE TOKEN IS LATE IS NOT CLAIMED FOR AS THE
    // DEVICE (round 3 fix, 2026-10-10). The anonymous account holding 'Quiet
    // Dawn' is signed in on B again; its socket reopens while the session's
    // refresh cannot reach the server (a session kept, no token). No claim
    // goes then (a guest claim would answer the device's own name, or refuse
    // the account's as 'taken'); when the token comes, the hello goes and the
    // account's claim after it, and the page is 'Quiet Dawn' throughout.
    await B.ev(`(() => { localStorage.setItem('__ccTestTok', 'tok-anon'); localStorage.setItem('__ccTestWho', ${JSON.stringify(JSON.stringify({ id: ANON_ID, anonymous: true, google: false, apple: false, email: null, accounts: [] }))}); return true; })()`);
    await B.nav({ settle: false });
    await B.until(`myName() === 'Quiet Dawn'`, 5000);
    const rows14 = RES.rows.length;
    await B.ev(`(() => { window.__late = true; const real = Cloud.token; window.__realToken = real; Cloud.token = async () => (window.__late ? null : real()); Cloud.hasSession = () => true;
      window.__sent = []; window.__toastsDom = []; S.ws.close(); return true; })()`);
    await B.until(`S.connected === true && socialIntro() > 0`, 8000, 50);
    await sleep(900);
    const before14 = await B.ev(`(window.__sent || []).map((f) => f.type)`);
    await B.ev(`(window.__late = false, true)`);
    const came = await B.until(`(window.__sent || []).some((f) => f.type === 'name')`, 8000, 50);
    const after14 = await B.ev(`(window.__sent || []).map((f) => f.type === 'name' ? 'name' + (f.account ? '+account' : '') : f.type)`);
    await sleep(400);
    const me14 = await B.ev('myName()');
    const said14 = (await B.ev('(window.__toastsDom || []).slice()')).filter((t) => /your name/i.test(t));
    if (!before14.includes('name') && !before14.includes('hello') && came && after14.indexOf('hello') >= 0 && after14.indexOf('name+account') === after14.indexOf('hello') + 1
        && !after14.includes('name') && me14 === 'Quiet Dawn' && !said14.length && RES.rows.length === rows14)
      ok('H14: a signed-in player whose token is late sends no claim (it would be the device\'s); when the token comes, the hello goes and the account\'s claim straight after it, and the player stays \'Quiet Dawn\' with nothing said and no row made');
    else fail('H14: ' + JSON.stringify({ before14, came, after14, me14, said14, rows: RES.rows.length - rows14 }));
    // H15. NEW NAMES HANDED OUT FAIRLY, ON THE WIRE (round 3 fix, 2026-10-10;
    // server/reservations.js, server/client-address.js). (a) A claim from a
    // socket that has said no hello makes no row; the token-less hello a
    // guest's page sends, and the same claim makes it. (b) Thirty new names an
    // hour from one address, the address read from CF-Connecting-IP: the 31st
    // makes nothing, another address is answered, and an X-Forwarded-For the
    // client wrote changes nothing. (c) A token-less hello on a socket that
    // has an account changes nothing: a claim in flight on it is answered.
    {
      const edge = (ip, extra = {}) => new Promise((res, rej) => {
        const w = new NodeWS(WS_URL, { headers: { 'cf-connecting-ip': ip, ...extra } });
        w.rx = []; w.on('message', (d) => { try { w.rx.push(JSON.parse(String(d))); } catch {} });
        w.on('open', () => res(w)); w.on('error', rej);
      });
      const send15 = (w, m) => w.send(JSON.stringify(m));
      const rows0 = RES.rows.length;
      const bare = await sock();
      tx(bare, { type: 'name', name: 'Hollow Spire' });
      const a1 = await wait(bare, (m) => m.type === 'name', 4000);
      const rowsBare = RES.rows.length;
      tx(bare, { type: 'hello' }); tx(bare, { type: 'name', name: 'Hollow Spire' });
      const a2 = await wait(bare, (m) => m.type === 'name' && m.ok, 4000);
      bare.close();
      const okA = a1 && a1.error === 'unavailable' && rowsBare === rows0 && a2 && a2.name === 'Hollow Spire' && /^[A-Za-z0-9_-]{43}$/.test(a2.secret || '') && RES.rows.some((r) => r.name === 'Hollow Spire');
      if (okA) ok('H15a: on the wire, a claim with no hello is "unavailable" and makes no row; after the guest\'s token-less hello the same claim makes it');
      else fail('H15a: ' + JSON.stringify({ a1, rowsBare, rows0, a2 }));
      const answers = [];
      for (let i = 0; i < 31; i++) {
        const w = await edge('198.51.100.7');
        send15(w, { type: 'hello' }); send15(w, { type: 'name', name: `Edge Gulch ${i}` });
        answers.push(await wait(w, (m) => m.type === 'name', 4000));
        w.close();
      }
      const before31 = RES.rows.length;
      const spoof = await edge('198.51.100.7', { 'x-forwarded-for': '203.0.113.200' });
      send15(spoof, { type: 'hello' }); send15(spoof, { type: 'name', name: 'Edge Spoof' });
      const sp = await wait(spoof, (m) => m.type === 'name', 4000);
      spoof.close();
      const other = await edge('198.51.100.8');
      send15(other, { type: 'hello' }); send15(other, { type: 'name', name: 'Edge Other' });
      const ot = await wait(other, (m) => m.type === 'name', 4000);
      other.close();
      const made = answers.filter((m) => m && m.ok).length;
      if (made === 30 && answers[30] && answers[30].error === 'unavailable' && sp && sp.error === 'unavailable' && RES.rows.length === before31 + 1
          && ot && ot.ok && ot.name === 'Edge Other' && !RES.rows.some((r) => r.name === 'Edge Spoof' || r.name === 'Edge Gulch 30'))
        ok('H15b: one CF-Connecting-IP address makes 30 new names and the 31st is "unavailable"; a spoofed X-Forwarded-For on the same address is still refused, and another address is answered');
      else fail('H15b: ' + JSON.stringify({ made, last: answers[30], sp, ot }));
      const acct = await sock();
      tx(acct, { type: 'hello', token: 'tok-anon2' });
      await sleep(USER_MS + 300);
      // The claim's read of the account's row is held, and the token-less
      // hello lands while it is out.
      RES.slowUser = ANON2_ID;
      tx(acct, { type: 'name', name: 'Ashen Spire', account: true });
      await sleep(200);
      tx(acct, { type: 'hello' });
      const a3 = await wait(acct, (m) => m.type === 'name', 4000);
      RES.slowUser = null;
      acct.close();
      if (a3 && a3.ok && a3.linked !== true && a3.name === 'Ashen Spire') ok('H15c: a token-less hello on a socket that has an account changes nothing: the claim in flight on it is answered (\'Ashen Spire\')');
      else fail('H15c: ' + JSON.stringify(a3));
    }
  }

  // ==== W. EVERY NAME WHOLE =====================================================================
  if (ONLY.has('W')) {
    // THE PAGE'S HALF. pool(): every default name the server can hand out, by
    // its own rule (server/reservations.js DEFAULT_TIERS and WIDE_DEFAULTS,
    // from the same word lists), with the pairs. widest(face, k): the k
    // widest of them in one face (font, capitals, letter spacing), by a
    // canvas's measure. whole(root, text): every place `text` is drawn under
    // `root`, and what cuts it: an ellipsis (a box narrower than its text), a
    // box with its overflow hidden that a line of it stands past (on the
    // other axis, past by more than the face's own room over a tight line),
    // or the edge of the screen. A box that scrolls on its own hides nothing
    // on its axis: what it holds there is a scroll away.
    const W_JS = `(() => {
      const pool = () => {
        const pairs = []; for (const nn of CALL_NOUN) for (const a of CALL_ADJ) if (a.length + 1 + nn.length <= NAME_MAX) pairs.push(a + ' ' + nn);
        const out = pairs.slice(); for (const d of ['2', '3', '4', '5', '6', '7', '8', '9']) for (const q of pairs) out.push(q + ' ' + d);
        for (const q of pairs.filter((x) => x.length + 3 <= CALLSIGN_MAX)) for (let i = 10; i < 100; i++) out.push(q + ' ' + i);
        for (const q of pairs.filter((x) => x.length + 4 <= CALLSIGN_MAX)) for (let i = 100; i < 1000; i++) out.push(q + ' ' + i);
        return out;
      };
      const all = pool();
      const widest = (face, k) => {
        const cv = document.createElement('canvas').getContext('2d'); cv.font = face.font; try { cv.letterSpacing = face.ls; } catch (e) {}
        const best = [];
        for (const s of all) { const w = cv.measureText(face.upper ? s.toUpperCase() : s).width; if (best.length < k || w > best[best.length - 1][1]) { best.push([s, w]); best.sort((a, b) => b[1] - a[1]); if (best.length > k) best.length = k; } }
        return best.map((x) => x[0]);
      };
      const faceOf = (e) => { const cs = getComputedStyle(e); return { font: cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily, upper: cs.textTransform === 'uppercase', ls: cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing }; };
      const nodesWith = (root, text) => { const out = [], tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = tw.nextNode(); n; n = tw.nextNode()) { let i = n.data.indexOf(text); while (i >= 0) { out.push([n, i]); i = n.data.indexOf(text, i + 1); } } return out; };
      const whole = (root, text) => {
        const bad = []; let drawn = 0;
        for (const [n, i] of nodesWith(root, text)) {
          const e0 = n.parentElement, st0 = getComputedStyle(e0);
          // Not drawn: no box, hidden, or see-through (a card put away fades out).
          if (!e0.getClientRects().length || !e0.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
          drawn++;
          const g = document.createRange(); g.setStart(n, i); g.setEnd(n, i + text.length);
          const rects = [...g.getClientRects()].filter((q) => q.width > 0.5);
          const slack = 0.5 + 0.3 * (parseFloat(st0.fontSize) || 10);
          let freeX = false, freeY = false;
          for (let e = e0; e && e !== document.documentElement; e = e.parentElement) {
            const cs = getComputedStyle(e), b = e.getBoundingClientRect();
            if (cs.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 0.5) bad.push('ellipsis on ' + (e.id || e.className));
            const L = b.left + e.clientLeft, T = b.top + e.clientTop, R = L + e.clientWidth, Bo = T + e.clientHeight;
            const hx = cs.overflowX === 'hidden' || cs.overflowX === 'clip', hy = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
            for (const q of rects) {
              if (hx && !freeX && (q.left < L - 0.5 || q.right > R + 0.5)) bad.push('clipped across by ' + (e.id || e.className));
              if (hy && !freeY && (q.top < T - slack || q.bottom > Bo + slack)) bad.push('clipped down by ' + (e.id || e.className));
            }
            if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') freeX = true;
            if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') freeY = true;
          }
          for (const q of rects) if (q.left < -0.5 || q.right > innerWidth + 0.5 || (!freeY && (q.top < -0.5 || q.bottom > innerHeight + 0.5))) bad.push('off the screen');
          // Which drawing of the name it was, for the report.
          if (bad.length && !bad.some((x) => x.startsWith('in '))) bad.push('in ' + (e0.id || e0.className || e0.tagName) + ' at ' + rects.map((q) => Math.round(q.top) + '-' + Math.round(q.bottom)).join(','));
        }
        return { drawn, bad: [...new Set(bad)] };
      };
      window.__W = { all, widest, faceOf, nodesWith, whole };
      return all.length;
    })()`;
    const ME_W = '00000000-0000-4000-8000-0000000000aa';
    const LINKED_W = { id: ME_W, anonymous: false, google: true, apple: false, email: 'me@example.test', accounts: [{ provider: 'google', email: 'me@example.test' }] };
    // Every surface, drawn with `C` (a list of names), checked for each name
    // it should carry. `own` is the device's name. Returns what was cut.
    const W_SURFACES = (C) => `(async () => {
      const C = ${JSON.stringify(C)}, out = [], seen = {};
      const chk = (where, root, names) => { for (const N of names) { const r = __W.whole(root, N); seen[where] = (seen[where] || 0) + r.drawn; if (r.bad.length || !r.drawn) out.push({ where, N, bad: r.bad.length ? r.bad : ['not drawn'] }); } };
      const pause = () => new Promise((r) => setTimeout(r, 30));
      const ID = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
      // ---- outside a match: the device's own name, then other players' ----
      for (let k = 0; k < C.length; k++) {
        const names = [0, 1, 2, 3].map((i) => C[(k + i) % C.length]);
        $('nameInput').value = names[0]; localStorage.setItem('pt_name', names[0]);
        for (const scr of ['home', 'career', 'paint', 'settings', 'setup']) { Bay.show(scr); await pause(); chk('screen ' + scr, document.getElementById('bay'), [names[0]]); }
        window.CC_SOCIAL = { friends: [{ id: ID(101), callsign: names[1], online: true }, { id: ID(102), callsign: names[2], online: false }],
          requests: { in: [{ id: ID(200), callsign: names[3] }], out: [{ id: ID(201), callsign: names[1] }] }, blocked: [{ id: 'bk0000000000000000000000000000000', callsign: names[2] }], friendCode: 'AB12CD', callsign: null };
        document.dispatchEvent(new Event('cc:social'));
        Bay.show('friends'); await pause(); chk('Friends cards', document.getElementById('bay'), names.slice(1));
        handle({ type: 'squad', op: 'state', code: 'QK7T', leader: '${ME_W}', mode: 'ffa', tees: null, max: null, you: 0, held: true,
          members: names.map((nm, i) => ({ id: i ? ID(100 + i) : '${ME_W}', rid: ('r' + i + '0'.repeat(32)).slice(0, 32), callsign: nm, guest: false, online: true, ready: i % 2 === 1, dropped: false })),
          fits: { duel: false, ffa: true, boss: false, aliens: false, golf: true } });
        await pause();
        Bay.show('home'); await pause(); chk('home Squad box', document.querySelector('#bay .sqx'), names);
        Bay.show('squad'); await pause(); chk('Your squad seats', document.getElementById('bay'), names);
        // Two of four, so a seat is open: its "+ Invite" opens the sheet of
        // friends and requests over the page.
        handle({ type: 'squad', op: 'state', code: 'QK7T', leader: '${ME_W}', mode: 'ffa', tees: null, max: null, you: 0, held: true,
          members: [{ id: '${ME_W}', rid: 'r'.repeat(32), callsign: names[0], guest: false, online: true, ready: false, dropped: false }],
          fits: { duel: false, ffa: false, boss: true, aliens: true, golf: true } });
        await pause(); Bay.show('squad'); await pause();
        const sheet = document.querySelector('#bay .sqseat.sqopen [data-sq^="sheet:"]'); if (sheet) sheet.click(); await pause();
        chk('invite sheet', document.querySelector('#bay .sqsh') || document.createElement('i'), names.slice(1));
        const shut = document.querySelector('#bay .sqshx'); if (shut) shut.click();
        handle({ type: 'squad', op: 'ended', reason: 'left' });
        squadInviteSet({ code: 'ZZ9Q', from: { callsign: names[2] }, size: 2, max: 4 }, Date.now(), 60000);
        Bay.show('home'); await pause(); chk('invite card', document.getElementById('bay'), [names[2]]);
        window.CC_SQUAD_INVITE = null;
        renderLobby({ code: 'ABCD', mode: 'ffa', max: 4, you: 0, host: 0, players: names.map((nm, i) => ({ name: nm, handle: i ? 'h' + i : null })) });
        Bay.show('lobby'); await pause(); chk('lobby seats', document.getElementById('bay'), names);
        Bay.show('home');
      }
      // ---- in a match: every seat's card, "(you)" on the player's own -------
      showScreen('game');
      for (const [mode, n] of [['duel', 2], ['ffa', 3], ['ffa', 4], ['boss', 3]]) for (let you = 0; you < n; you++) for (let k = 0; k < C.length; k++) {
        const names = Array.from({ length: n }, (_, i) => C[(k + i) % C.length]);
        S.mode = mode; S.n = n; S.you = you; S.names = names; S.hp = Array(n).fill(100); S.alive = Array(n).fill(true);
        S.handles = names.map((_, i) => (i % 2 ? 'h' + i : null)); S.boss = mode === 'boss' ? n - 1 : -1; S.turn = (you + 1) % n; S.playing = true; S.golf = null;
        buildScoreboard(); updateHud();
        const hud = document.getElementById('hud-top');
        chk('HUD ' + mode + ' ' + n + ' (own card)', hud, [names[you] + ' (you)']);
        chk('HUD ' + mode + ' ' + n, hud, names.filter((_, i) => i !== you && i !== S.boss));
        // A NAME WRAPS ONLY ONCE THE BAR HAS GIVEN WAY, and its lines end
        // clear of the acting player's 2px underline at the card's foot.
        for (const card of document.querySelectorAll('#scoreRow .pscore')) {
          const nm = card.querySelector('.pnm'), bar = card.querySelector('.hpbar'), g = document.createRange(); g.selectNodeContents(nm);
          const lines = new Set([...g.getClientRects()].map((q) => Math.round(q.top))).size;
          const foot = nm.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(nm).paddingBottom) || 0), cb = card.getBoundingClientRect().bottom;
          if (lines > 1 && bar.getBoundingClientRect().width > 24.5) out.push({ where: 'HUD ' + mode + ' ' + n, N: nm.textContent, bad: ['wrapped while its bar had room: ' + bar.getBoundingClientRect().width] });
          if (lines > 1 && foot > cb - 2 + 0.25) out.push({ where: 'HUD ' + mode + ' ' + n, N: nm.textContent, bad: ['its lines run into the underline: ' + (cb - foot)] });
          if (lines > 1) seen['HUD names on two lines'] = (seen['HUD names on two lines'] || 0) + 1;
          // And the card holds what it draws: a name too long for its card
          // must not run past it into the next player's.
          const cr = card.getBoundingClientRect();
          for (const part of card.querySelectorAll('.pname, .pval, .hpbar, .pmb')) { const b = part.getBoundingClientRect(); if (b.width && (b.left < cr.left - 0.5 || b.right > cr.right + 0.5)) out.push({ where: 'HUD ' + mode + ' ' + n, N: nm.textContent, bad: ['runs out of its card: ' + part.className] }); }
          const g2 = document.createRange(); g2.selectNodeContents(nm);
          if ([...g2.getClientRects()].some((q) => q.right > cr.right + 0.5)) out.push({ where: 'HUD ' + mode + ' ' + n, N: nm.textContent, bad: ['its letters run out of its card'] });
        }
      }
      // ---- the ends, the turn line, golf's cards ----------------------------
      for (const mode of ['duel', 'ffa', 'golf', 'boss']) for (let k = 0; k < C.length; k++) {
        const n = mode === 'duel' ? 2 : 4, names = Array.from({ length: n }, (_, i) => C[(k + i) % C.length]);
        showScreen('game');
        S.mode = mode; S.n = n; S.you = 0; S.names = names; S.hp = Array(n).fill(100); S.alive = Array(n).fill(true); S.handles = Array(n).fill(null);
        S.boss = mode === 'boss' ? n - 1 : -1; S.turn = 1; S.playing = true;
        S.golf = mode === 'golf' ? { hole: 2, holes: 9, par: 4, pars: [4, 4, 4, 4, 4, 4, 4, 4, 4], cup: { x: 10000 }, strokes: names.map(() => 1), totals: names.map(() => 4), done: names.map(() => false), grid: names.map(() => [4, 0, 0, 0, 0, 0, 0, 0, 0]) } : null;
        buildScoreboard(); updateHud(); updateDock();
        if (mode !== 'boss') chk('turn line', document.getElementById('turnLabel'), [names[1]]);
        if (mode === 'golf') {
          // Each card is put away once read, as its own timer would, so none
          // stands over the next surface.
          showHoleScore({ hole: 2, holes: 9, par: 4, pars: [4], grid: names.map(() => [4]) }); chk('hole card', document.getElementById('holeScore'), names);
          clearTimeout(holeScoreTimer); document.getElementById('holeScore').classList.remove('show');
          openGolfCard(); chk('scorecard', document.getElementById('golfCard'), names); document.getElementById('golfCard').classList.add('hidden');
          showOBBanner('OUT OF BOUNDS', 1, false); chk('out-of-bounds banner', document.getElementById('obBanner'), [names[1]]);
          clearTimeout(obBannerTimer); document.getElementById('obBanner').classList.remove('show');
          onGameOver({ type: 'gameover', winner: 1, golf: { totals: names.map(() => 36), parTotal: 36, strokes: names.map(() => [4, 4, 4, 4, 4, 4, 4, 4, 4]), pars: [4, 4, 4, 4, 4, 4, 4, 4, 4] } });
        } else if (mode === 'boss') onGameOver({ type: 'gameover', team: 'players', hp: S.hp.slice(), stats: { dealt: names.map(() => 10), received: names.map(() => 2) } });
        else onGameOver({ type: 'gameover', winner: 1, hp: S.hp.slice() });
        await pause();
        chk(mode + ' end screen', document.getElementById('game'), mode === 'boss' ? names.slice(0, n - 1) : names);
        const rep = document.getElementById('battleReport'); if (rep) rep.remove();
      }
      S.playing = false; showScreen('lobby'); Bay.show('home');
      return { out, seen };
    })()`;
    const shapes = [['667x375', 667, 375, { top: 0, left: 0, bottom: 0, right: 0 }], ['874x402 iPhone 17', 874, 402, { top: 0, left: 62, bottom: 21, right: 62 }]];
    const cut = [], seenAll = {}, cands = {};
    for (const [V, w, h, insets] of shapes) {
      await A.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
      await A.send('Emulation.setSafeAreaInsetsOverride', { insets });
      await A.nav();
      await A.ev(`(localStorage.clear(), sessionStorage.clear(), true)`);
      await A.nav();
      await A.ev(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
      // A signed-in page whose socket is a recorder: nothing the screens send
      // reaches the server, and nothing it answers repaints them under a read.
      await A.ev(`(() => {
        const real = S.ws; if (real) { try { real.onclose = null; real.onmessage = null; real.onerror = null; real.close(); } catch {} }
        window.connect = () => {}; S.ws = { readyState: 1, send() {} }; S.connected = true; S.local = false;
        window.showToast = () => {};
        const b = $('accountBtn'); b.classList.remove('hidden'); b.dataset.state = 'in';
        window.CC_ACCOUNT = ${JSON.stringify(LINKED_W)}; document.dispatchEvent(new CustomEvent('cc:account'));
        const s = document.createElement('style'); s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important;}'; document.head.appendChild(s);
        return true; })()`);
      const poolN = await A.ev(W_JS);
      // THE NAMES: the widest of the whole pool in every face a name is drawn
      // in on these surfaces (read off a first drawing with a marker name),
      // three a face, and the widest rolled pair the S8 check started from.
      const faceList = await A.ev(`(async () => {
        const f = {}, M = 'Qzx Marker';
        const note = () => { for (const [n] of __W.nodesWith(document.body, M)) { const x = __W.faceOf(n.parentElement); f[JSON.stringify(x)] = x; } };
        $('nameInput').value = M; localStorage.setItem('pt_name', M);
        for (const scr of ['home', 'career', 'paint', 'settings', 'setup']) { Bay.show(scr); note(); }
        window.CC_SOCIAL = { friends: [{ id: '00000000-0000-4000-8000-000000000101', callsign: M, online: true }], requests: { in: [{ id: '00000000-0000-4000-8000-000000000200', callsign: M }], out: [] }, blocked: [], friendCode: 'AB12CD', callsign: null };
        document.dispatchEvent(new Event('cc:social')); Bay.show('friends'); note();
        handle({ type: 'squad', op: 'state', code: 'QK7T', leader: '${ME_W}', mode: 'ffa', tees: null, max: null, you: 0, held: true,
          members: [{ id: '${ME_W}', rid: 'r'.repeat(32), callsign: M, guest: false, online: true, ready: false, dropped: false }, { id: '00000000-0000-4000-8000-000000000101', rid: 's'.repeat(32), callsign: M, guest: false, online: true, ready: true, dropped: false }],
          fits: { duel: true, ffa: true, boss: true, aliens: true, golf: true } });
        Bay.show('home'); note(); Bay.show('squad'); note(); handle({ type: 'squad', op: 'ended', reason: 'left' });
        renderLobby({ code: 'ABCD', mode: 'ffa', max: 2, you: 0, host: 0, players: [{ name: M, handle: null }, { name: M, handle: 'h1' }] }); Bay.show('lobby'); note();
        showScreen('game'); S.mode = 'ffa'; S.n = 4; S.you = 0; S.names = [M, M, M, M]; S.hp = [100, 100, 100, 100]; S.alive = [true, true, true, true]; S.handles = [null, 'h1', null, 'h3']; S.boss = -1; S.turn = 1; S.playing = true; S.golf = null;
        buildScoreboard(); updateHud(); note();
        S.playing = false; showScreen('lobby'); Bay.show('home');
        return Object.values(f);
      })()`);
      const set = new Set(['Steel Howitzer']);
      for (const face of faceList) for (const s of await A.ev(`__W.widest(${JSON.stringify(face)}, 3)`)) set.add(s);
      cands[V] = { pool: poolN, faces: faceList.length, names: [...set] };
      const r = await A.ev(W_SURFACES([...set]));
      for (const x of r.out) cut.push({ V, ...x });
      for (const [k, v] of Object.entries(r.seen)) seenAll[k] = (seenAll[k] || 0) + v;
    }
    await A.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, bottom: 0, right: 0 } });
    await A.metrics(874, 402);
    const SURF = ['screen home', 'screen career', 'screen paint', 'screen settings', 'screen setup', 'Friends cards', 'home Squad box', 'Your squad seats', 'invite sheet', 'invite card', 'lobby seats',
      'HUD duel 2 (own card)', 'HUD ffa 3 (own card)', 'HUD ffa 4 (own card)', 'HUD boss 3 (own card)', 'HUD duel 2', 'HUD ffa 4', 'turn line', 'hole card', 'scorecard', 'out-of-bounds banner',
      'duel end screen', 'ffa end screen', 'golf end screen', 'boss end screen', 'HUD names on two lines'];
    const missing = SURF.filter((k) => !seenAll[k]);
    const poolOk = Object.values(cands).every((c) => c.pool === 1454 + 1086682 && c.faces >= 4 && c.names.length >= 6);
    if (!cut.length && !missing.length && poolOk)
      ok(`W: every name is whole wherever it is drawn: the widest of the ${(1454 + 1086682).toLocaleString('en')} default names in each face a name is drawn in (${cands['667x375'].names.join(', ')}), on ${SURF.length} surfaces (${SURF.join('; ')}), at 667x375 and at 874x402 with the iPhone 17's safe areas: no ellipsis, nothing clipped, nothing off the screen, "(you)" whole on the player's own HUD card in every seat; and a HUD name goes on to a second line (${seenAll['HUD names on two lines']} times here) only once its card's bar is down to its 24px, its lines ending clear of the acting player's underline, every card holding all it draws`);
    else fail('W: names cut ' + JSON.stringify({ cut: cut.slice(0, 16), more: Math.max(0, cut.length - 16), missing, cands }));
  }
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
}

console.log('\n  THE NAME AUDIT (part | mode | player | wanted | seated | note)');
for (const r of matrix) console.log('   ' + r.map((x) => String(x)).join(' | '));
console.log(errors.length ? `\n${errors.length} FAILED` : '\nALL GOOD');
cleanup();
process.exit(errors.length ? 1 : 0);
