// Set callsign, in a real page: the Bay controls row and its one button,
// Change (Roll is gone -- owner, 2026-10-07: names are permanent), the inline
// field and its rules, every error sentence the design names, the exact frames
// that reach the socket for a signed-in Set and for a guest's name check, the
// once-a-day countdown, and the landscape keyboard lift.
// Headless Chrome over CDP; skips without Chrome, like the other client suites.
// The socket is a STUB and Supabase is never reached — this suite is the CLIENT
// half of the callsign message, nothing else.
//
// WHY THIS EXISTS: the Set control spans four files that only ever meet in a
// browser — index.html's legacy rack, app.js's socket, bay.js's screen and
// styles.css's design frame. No Node suite can see any of it. Five of its
// rules are invisible in ordinary play and each is one line long:
//   * an ok reply with no name (the server's answer to an OLD build's roll)
//     carries callsign:null and must not reach setLocalName(), which would
//     rename the player "null" and push that to the cloud;
//   * accepting a CHOSEN name must never send a rolled frame, or the client
//     would clear the uniqueness key it just paid a day's quota for;
//   * a late reply to an abandoned try must not overwrite a newer one;
//   * a REFUSED friends frame must not be read as an empty panel, or a player
//     is told they hold no callsign because PostgREST was down;
//   * the sign-in refusal comes back as type:'social', not type:'callsign'
//     (Task 4's report, §2) — a client switching on the callsign type alone
//     waits for ever.
// And a sixth that only a phone would ever show: an inline field halfway down
// a landscape frame is typed into blind unless the frame lifts over the
// keyboard. All six fail silently in production.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  social_ui tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));   // decoded: the path has spaces
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
const RUN_MS = 150000;                                          // the whole suite
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });
let srv = null, chrome = null, prof = null;
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog = setTimeout(() => { console.error(`FAIL social_ui overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

const appPort = await freePort();
srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); break; } catch {} await sleep(150); }
const dbg = await freePort(); prof = join(tmpdir(), `cc-soc-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
if (!wsUrl) { console.error('FAIL social_ui: Chrome never offered a page to drive'); process.exit(1); }
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

// The copy, from its authorities, written with escapes so this file stays ASCII
// — public/bay.js emits the entities &ndash; and &mdash;, and textContent gives
// back the real characters.
//   design 5.6      : the rule, the hint, taken, not_allowed, too_soon
//   BINDING res. 16 : slow_down and sign_in, verbatim
//   the owner       : unavailable — his decision, replacing resolution 16's
//                     wording, which blamed the connection for a server-side
//                     fault and read almost exactly like the genuinely-offline
//                     sentence. It is what every player sees until the migration
//                     is applied, so it was sending them to check their wifi.
//   this task       : offline, checking, the catch-all and WAIT (see the report)
// EVERY SENTENCE IN THIS TABLE ENDS IN A FULL STOP. The error line used to
// change style with the code, because 5.6's fragments carried none and
// resolution 16's sentences did. Row descriptions still carry none.
// THE RULES, SAID PLAINLY (owner, 2026-10-07). This line pinned the old copy,
// '3-16 letters, digits or spaces. Unique. Once a day.', which the owner asked
// to have say what a name may be: letters, numbers or spaces, nothing
// offensive, one change a day.
const RULE = '3–16 letters, numbers or spaces. Nothing offensive. One change a day.';
// THE HINT IS GONE (round 3 fix, 2026-10-10): a signed-in account with no
// chosen callsign read 'Friends find you by code until you choose a callsign'
// and no name, though the server holds a reserved name for it. Its row shows
// that name now (check 3).
const WAIT = 'Not loaded yet — reopen this screen to retry';
const OUT = 'Sign in to choose a callsign.';
const CASES = [
  ['taken',        'Someone has that callsign.'],
  ['not_allowed',  'That callsign is not allowed.'],
  ['length',       RULE],
  ['chars',        RULE],
  ['too_soon',     'You can change it again tomorrow.'],
  ['slow_down',    'Too many tries. Wait a moment.'],
  ['unavailable',  'Callsigns are not available right now. Try again later.'],
  ['a_code_from_a_newer_server', 'That callsign could not be set.'],
];
// `id` is present because Cloud.whoami() always returns one (public/cloud.js:
// `return { id: u.id, anonymous: !!u.is_anonymous, … }`) and bay.js keys the
// guest blocked list on it — a fixture without one would let an unkeyed reset
// pass.
const LINKED = `{ id: '00000000-0000-4000-8000-0000000000aa', anonymous: false, google: true, apple: false, email: 'me@example.com', accounts: [{ provider: 'google', email: 'me@example.com' }] }`;
const GUEST = `{ id: '00000000-0000-4000-8000-0000000000bb', anonymous: true, google: false, apple: false, email: null, accounts: [] }`;

// ---- page helpers ----------------------------------------------------------
// Replace the live socket with a recorder. The real one is closed with its
// handlers detached first, and connect() is stubbed out, so neither its
// onclose nor the 1500 ms retry timer can swap a real socket back in under a
// check that has deliberately put the stub into readyState 3.
const stubSocket = () => ev(`(() => {
  const real = S.ws;
  if (real) { try { real.onclose = null; real.onmessage = null; real.onerror = null; real.close(); } catch {} }
  window.connect = () => {};
  window.__tx = [];
  S.ws = { readyState: 1, send(s) { window.__tx.push(JSON.parse(s)); } };
  // KEEP THE REAL ONE. Every "confirmed out loud" assertion in this suite reads
  // a recorder, which proves the function was CALLED and nothing whatever about
  // whether a player can see anything — and that is precisely how a toast that
  // rendered into a display:none subtree survived a full green suite. The real
  // showToast is measured on screen further down, on both screens.
  window.__realToast = window.showToast;
  window.showToast = () => {};
  window.__soc = 0;
  if (!window.__socHooked) { window.__socHooked = 1; document.addEventListener('cc:social', () => { window.__soc++; }); }
  window.CC_SOCIAL = null;
  window.CC_ACCOUNT = ${LINKED};
  document.dispatchEvent(new CustomEvent('cc:account'));
  // AND SETTLE THE READ THAT SIGN-IN NOW STARTS. app.js asks for the friends
  // frame once per connection and once per sign-in, because a CHOSEN CALLSIGN
  // BELONGS TO THE ACCOUNT and that frame is the only channel carrying it -- a
  // second device used to boot to the home screen and play its whole session
  // under its own rolled pair. The line above is a sign-in, so a request is now
  // in flight; left unanswered it holds socialAsking for twelve seconds and
  // every socialResync in this suite would return without sending. Settled here
  // the way the server would, and the refusal is wiped so the page starts in
  // exactly the state it started in before: no snapshot, no read out, no
  // sentence.
  const boot = window.__tx.filter((f) => f.type === 'friends');
  if (boot.length) handle({ type: 'friends', error: 'unavailable', id: boot[boot.length - 1].id });
  window.CC_SOCIAL_ERR = '';
  window.__tx.length = 0;
  return boot.length;
})()`);
const tx = () => ev('window.__tx.slice()');
const clearTx = () => ev('(window.__tx.length = 0, true)');
const calls = (t) => ev(`window.__tx.filter((f) => f.type === ${JSON.stringify(t)})`);
// The Callsign row, read the way the Account row is read in test/account_ui.mjs.
const rowInfo = () => ev(`(() => {
  Bay.show('settings');
  const rows = [...document.querySelectorAll('#bay .row')];
  const r = rows.find((x) => x.querySelector('.rn2') && x.querySelector('.rn2').textContent === 'Callsign');
  if (!r) return null;
  const b = [...r.querySelectorAll('.sbtn')];
  return {
    desc: r.querySelector('.rd').textContent,
    btns: b.map((x) => x.textContent),
    acts: b.map((x) => (x.hasAttribute('data-roll') ? 'data-roll' : 'data-cs=' + x.getAttribute('data-cs'))),
    dis: b.map((x) => x.hasAttribute('disabled')),
    wrapped: !!r.parentElement && r.parentElement.classList.contains('cs'),
    heights: rows.map((x) => Math.round(x.getBoundingClientRect().height)),
  };
})()`);
const editor = () => ev(`(() => {
  const i = document.getElementById('bayCall'), x = document.querySelector('#bay .csx');
  if (!i || !x) return null;
  const r = x.querySelector('.csr'), stage = document.querySelector('#bay .stage');
  return {
    max: i.maxLength, ph: i.placeholder, focused: document.activeElement === i,
    rule: r ? r.textContent : null, bad: r ? r.classList.contains('bad') : null,
    kids: r ? r.children.length : -1,
    btns: [...x.querySelectorAll('.sbtn')].map((b) => b.textContent),
    card: !!document.querySelector('#bay .pbody .card'),
    inStage: x.getBoundingClientRect().bottom <= stage.getBoundingClientRect().bottom + 0.5,
  };
})()`);
const openEditor = async () => { await ev(`(() => { Bay.show('settings'); document.querySelector('#bay [data-cs="open"]').click(); return true; })()`); await sleep(200); };
const closeCallsign = () => ev(`(() => { const c = document.querySelector('#bay [data-cs="cancel"]'); if (c) c.click(); return true; })()`);
const save = async (name) => { await ev(`(() => { const i = document.getElementById('bayCall'); i.value = ${JSON.stringify(name)}; document.querySelector('#bay [data-cs="save"]').click(); return true; })()`); await sleep(80); };
// Answer the LAST callsign frame the page sent. `type` is 'callsign' for every
// real reply and 'social' for the sign-in refusal (Task 4's report, §2).
const reply = async (type, patch) => {
  const r = await ev(`(() => {
    const q = window.__tx.filter((f) => f.type === 'callsign');
    const id = q.length ? q[q.length - 1].id : null;
    handle(Object.assign({ type: ${JSON.stringify(type)}, id }, ${JSON.stringify(patch)}));
    return id;
  })()`);
  await sleep(120); return r;
};
const SNAP = (patch) => `Object.assign({ type: 'friends', friends: [{ id: 'a', callsign: 'Dusty Crag', online: true }], requests: { in: [], out: [] }, blocked: [{ id: 'b', callsign: 'Steel Mule' }], friendCode: 'AB12CD', callsign: null }, ${JSON.stringify(patch || {})})`;

for (const [w, h] of [[932, 430], [667, 375]]) {
  const V = `${w}x${h}`;
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await send('Page.bringToFront').catch(() => {});
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (await ev('!!window.Bay && typeof handle === "function" && typeof sendCallsign === "function" && !!document.querySelector("#bay .top")').catch(() => false)) { ready = true; break; }
    await sleep(200);
  }
  if (!ready) { fail(`${V}: page never became ready (window.Bay / handle / sendCallsign)`); continue; }
  // ---- I9: A SOCKET THAT COMES BACK MUST REPAINT THE SCREENS THAT GREYED
  //      THEMSELVES OUT. bay.js's Friends screen captures wsReady() once per
  //      render and threads it into every control's `disabled` attribute; its
  //      only repaint is `cc:social`, and connect() dispatched nothing. So a
  //      screen opened in a tunnel stayed entirely grey after the signal came
  //      back -- Retry included -- and nothing on the page said that leaving and
  //      returning was the only thing that worked. Driven on the REAL socket,
  //      before it is stubbed: a real close, the real 1.5s retry, a real open.
  // UP BEFORE DOWN, OR THE DROP IS NOT A DROP. The readiness gate above waits
  // for this page's SCRIPTS, not for its SOCKET, and about one boot in ten
  // cleared it with the first WebSocket still CONNECTING. Closing there measured
  // nothing: app.js's onclose dispatches `cc:social` only `if (wasUp)`, so a
  // socket that never opened closes silently; `!S.connected` below was then
  // satisfied by a state that had never been left, `down` read true for the
  // wrong reason, and the reconnect's own dispatch was the only one counted --
  // exactly the {"down":true,"back":true,"conn":1} this suite failed with about
  // once in ten runs. Reproduced deterministically by closing at readyState 0.
  // The cure is to wait for the open that makes the close REAL, not to sleep
  // longer: a longer sleep is only a slower flake.
  let up = false;
  for (let i = 0; i < 100; i++) { if (await ev('!!(S.connected && S.ws && S.ws.readyState === 1)')) { up = true; break; } await sleep(100); }
  if (!up) fail(`${V}: reconnect repaint — the socket never opened, so there was no drop to measure`);
  else {
    await ev(`(() => { window.__conn = 0; document.addEventListener('cc:social', () => { window.__conn++; }); S.ws.close(); return true; })()`);
    // DOWN FIRST, THEN UP. close() is asynchronous: for a tick or two S.connected
    // is still true and the dying socket still reads readyState 1, so a single
    // "is it up again" poll can be satisfied by the socket that has not finished
    // closing and the check would pass or fail on timing rather than on behaviour.
    let down = false, back = false;
    for (let i = 0; i < 40; i++) { if (await ev('!S.connected')) { down = true; break; } await sleep(100); }
    for (let i = 0; i < 60; i++) { if (await ev('!!(S.connected && S.ws && S.ws.readyState === 1)')) { back = true; break; } await sleep(200); }
    const conn = await ev('window.__conn');
    if (down && back && conn >= 2) ok(`${V}: a socket that drops and comes back repaints the screens that disable themselves (${conn} cc:social)`);
    else fail(`${V}: reconnect repaint ${JSON.stringify({ down, back, conn })}`);
  }
  // AND A SIGN-IN ASKS FOR THE ACCOUNT'S OWN NAME. A CHOSEN CALLSIGN BELONGS TO
  // THE ACCOUNT, and the friends frame is the only channel that carries it
  // (BINDING resolution 13) -- until this existed the only two callers of
  // socialNeed() were entering Bay controls and entering Friends, so a second
  // device, a reinstall or cleared site data booted to the home screen and
  // played the whole session under its own rolled pair. stubSocket() signs in;
  // the read it starts is settled there so the rest of the suite is unaffected.
  const bootRead = await stubSocket();
  if (bootRead === 1) ok(`${V}: signing in asks for the read model once, without waiting for a screen that draws it`);
  else fail(`${V}: sign-in read ${JSON.stringify(bootRead)}`);

  // 0. WHERE THE TOAST HOST STARTS, before any toast has been raised. It lived
  //    inside #stage, which is inside #game, and showScreen() makes exactly one
  //    of #bay / #game `active` while `.screen { display: none }` hides the
  //    other — so every confirmation the Launch Bay raised went into a hidden
  //    subtree. showToast() parks the host where it is needed, but the MARKUP
  //    must not start inside a screen: index.html and app.js are separately
  //    cached assets, and a page that loads the new markup against an older
  //    cached script (or the reverse) must still not be able to hide a report's
  //    only confirmation.
  const host0 = await ev(`(() => { const t = document.getElementById('toast');
    return { parent: t && t.parentElement ? t.parentElement.id : null, inScreen: !!(t && t.closest('.screen')) }; })()`);
  if (host0.parent === 'app' && host0.inScreen === false)
    ok(`${V}: the toast host is a child of #app in the markup, outside both screens`);
  else fail(`${V}: toast host parent ${JSON.stringify(host0)}`);

  // 1. the row carries ONE button, Change, and its height still matches every
  //    other settings row — the closed screen must be geometrically identical
  //    to the one test/layout.mjs has a baseline for. CHANGED (owner,
  //    2026-10-07): it pinned 'Roll|Set'; Roll is gone, because "the player
  //    ID names need to be permanent, disable the ability to cycle through new
  //    names". Not on this row, not on the home chip, not anywhere in the Bay.
  await ev(`(() => { Bay.show('home'); return true; })()`);
  const homeRoll = await ev(`(() => { const c = document.querySelector('#bay .top [data-cs="name"]');
    return { roll: document.querySelectorAll('#bay [data-roll]').length, chip: !!c, title: c && c.title, hasName: !!(c && c.querySelector('b') && c.querySelector('b').textContent.trim()) }; })()`);
  let r = await rowInfo();
  const setRoll = await ev(`document.querySelectorAll('#bay [data-roll]').length + document.querySelectorAll('#rerollBtn').length`);
  if (r && r.btns.join('|') === 'Change' && r.acts.join('|') === 'data-cs=open' && r.wrapped
      && new Set(r.heights).size === 1 && homeRoll.roll === 0 && setRoll === 0
      && homeRoll.chip && homeRoll.title === 'Change your name' && homeRoll.hasName)
    ok(`${V}: no Roll anywhere (home, Bay controls, the legacy rack); the Callsign row carries Change alone, every settings row is one height, and the home name chip says it changes your name`);
  else fail(`${V}: row ${JSON.stringify({ r, homeRoll, setRoll })}`);

  // 2. entering Bay controls with no snapshot asks for one, so the row can be
  //    honest about a name chosen on ANOTHER device (BINDING resolution 13:
  //    the friends frame carries the account's own chosen callsign).
  let t = await calls('friends');
  if (t.length === 1 && Object.keys(t[0]).sort().join(',') === 'id,type' && typeof t[0].id === 'number')
    ok(`${V}: entering Bay controls signed in with no snapshot sends exactly {type:'friends', id}`);
  else fail(`${V}: friends request ${JSON.stringify(t)}`);
  // and an account event landing on the open screen — a token refresh, a resume
  // — does not ask a second time while the first is still out. The read model is
  // eight round trips on the server and twenty a minute on this socket.
  await ev(`(() => { document.dispatchEvent(new CustomEvent('cc:account')); return true; })()`);
  await sleep(60);
  t = await calls('friends');
  if (t.length === 1) ok(`${V}: an account event on the open screen does not ask a second time while the first request is out`);
  else fail(`${V}: duplicate friends request ${JSON.stringify(t)}`);
  // Refuse it, so the request is settled rather than left outstanding for the
  // rest of the run — an in-flight read model would mask every later check that
  // asks whether something ELSE would have been sent.
  await ev(`(() => { const q = window.__tx.filter((f) => f.type === 'friends'); handle({ type: 'friends', error: 'unavailable', id: q[0].id }); return true; })()`);
  await sleep(60);

  // 2c. THE THIRD STATE. A null snapshot means NOT KNOWN YET — never "you hold
  //     no callsign". Every returning player meets it on first paint, because
  //     the screen renders before the request that fills it, and while the
  //     migration is unapplied every social frame answers unavailable, so it is
  //     the state a player sits in for the whole visit. Set is withheld with it:
  //     a save made against a snapshot this client has never seen is a guess.
  r = await rowInfo();
  if (r && r.desc === WAIT && r.btns.join('|') === 'Change' && r.dis.join('|') === 'true'
      && new Set(r.heights).size === 1)
    ok(`${V}: an unknown snapshot says "${WAIT}" and withholds Change, instead of claiming there is no callsign`);
  else fail(`${V}: unknown snapshot ${JSON.stringify(r)}`);

  // 2d. THE HOME NAME CHIP, SIGNED IN, WITH NO SNAPSHOT. It used to roll a new
  //     name on every tap -- and, for an account holding a chosen callsign,
  //     send a frame giving the key back. It now opens Bay controls; with the
  //     snapshot not yet in hand it lands on the row (which says so) without
  //     opening the field, for the reason Change is withheld above. No
  //     callsign frame of any kind leaves the page.
  //     CHANGED (owner, 2026-10-07): this check proved a Roll with no snapshot
  //     still gave the key back; there is no Roll for it to prove that of.
  await clearTx();
  await ev(`(() => { Bay.show('home'); document.querySelector('#bay .top [data-cs="name"]').click(); return true; })()`);
  await sleep(120);
  const chipLinked = await ev(`({ scr: $('bay').dataset.scr, field: !!document.getElementById('bayCall') })`);
  t = await calls('callsign');
  if (chipLinked.scr === 'settings' && !chipLinked.field && t.length === 0)
    ok(`${V}: the home name chip, signed in with no snapshot, opens Bay controls on the row and sends no callsign frame`);
  else fail(`${V}: chip with no snapshot ${JSON.stringify({ chipLinked, t })}`);
  await ev(`(() => { const q = window.__tx.filter((f) => f.type === 'friends'); if (q.length) handle({ type: 'friends', error: 'unavailable', id: q[q.length - 1].id }); return true; })()`);
  await sleep(60);
  // AND AN ACCEPTED SET WITH NO SNAPSHOT FABRICATES NONE. `CC_SOCIAL === null`
  // means NOT KNOWN YET, never "empty": inventing a snapshot here would tell the
  // rest of the session that this account has no friends, no blocks and no
  // friend code, and socialNeed() would never ask again, because a snapshot
  // exists. (This was proved through a Roll's answer; it is the same guard in
  // socialCallsign(), reached now by the one answer that still writes it.)
  await clearTx();
  await ev(`(() => { sendCallsign('Tank Ace', () => {}); return true; })()`);
  await reply('callsign', { ok: true, callsign: 'Tank Ace' });
  const nofab = await ev('window.CC_SOCIAL');
  if (nofab === null) ok(`${V}: an accepted set with no snapshot fabricates none \u2014 null still means not known yet`);
  else fail(`${V}: fabricated snapshot ${JSON.stringify(nofab)}`);
  // Age that confirmation out of the bounded window, so check 3's null
  // snapshot is believed as it was before this line existed.
  await ev(`(() => { csHeldAt = Date.now() - 60000; return true; })()`);

  // 3. a snapshot that SAYS null is believed, and that is the difference: the
  //    row then shows the name the account plays under, the one the server
  //    reserved for it (the claim's answer put it on #nameInput), and Change
  //    is available. CHANGED (round 3 fix, 2026-10-10): it said 'Friends find
  //    you by code until you choose a callsign' and named nobody.
  await ev(`(() => { $('nameInput').value = 'Iron Ridge 12'; localStorage.setItem('pt_name', 'Iron Ridge 12'); handle(${SNAP({ callsign: null })}); return true; })()`);
  await sleep(60);
  r = await rowInfo();
  if (r && r.desc === 'Iron Ridge 12' && r.dis.join('|') === 'false') ok(`${V}: a signed-in account with no chosen callsign shows its reserved name ('Iron Ridge 12'), with Change offered`);
  else fail(`${V}: no chosen callsign ${JSON.stringify(r)}`);

  // 4. Set opens the field with the rules under it
  await openEditor();
  let e = await editor();
  // maxLength IS 32, NOT 16, AND THAT IS THE RULE BEING KEPT, not broken.
  // server/callsign.js counts CODE POINTS ([...name].length, 3 to 16); HTML
  // maxlength counts UTF-16 code UNITS. For every BMP script they agree; for a
  // non-BMP letter -- a CJK Extension B ideograph, Gothic, Deseret -- each
  // character is two units, so 16 stopped the player at 8 characters under a
  // rules line promising 16, with no error and nothing to act on. 16 code points
  // can never exceed 32 units, so doubling is exact, and the server still
  // answers 'length' for anything past the real rule.
  if (e && e.max === 32 && e.focused && e.rule === RULE && !e.bad && e.kids === 0
      && e.btns.join('|') === 'Cancel|Save' && !e.card && e.inStage)
    ok(`${V}: Change opens a focused field capped at 32 UTF-16 units (= 16 code points), the rules under it, Cancel and Save, all inside the design frame`);
  else fail(`${V}: editor ${JSON.stringify(e)}`);
  // 4a. EVERY ROW LEFT IN THE COLUMN IS WHOLE INSIDE THE PAGE BODY, and the
  //     rules line is the size of the row lines above it (owner, 2026-10-07:
  //     all text visible and easy to read). How to play stands down with the
  //     credit card while the field is open: it used to run past .pbody at
  //     every size and off the bottom of the screen at 812x375 and 932x430.
  const col = await ev(`(() => {
    const x = document.querySelector('#bay .csx'), pb = document.querySelector('#bay .pbody').getBoundingClientRect();
    const kids = [...x.closest('.cs').parentElement.children];
    const u = (() => { const el = document.createElement('div'); el.style.cssText = 'position:absolute;width:calc(100 * var(--u))'; $('bay').appendChild(el); const w = el.getBoundingClientRect().width / 100; el.remove(); return w; })();
    const csr = x.querySelector('.csr'), rd = document.querySelector('#bay .row .rd');
    return { names: kids.map((k) => (k.querySelector('.rn2') ? k.querySelector('.rn2').textContent : k.className)),
      out: kids.filter((k) => k.getBoundingClientRect().bottom > pb.bottom + 0.5 || k.getBoundingClientRect().bottom > innerHeight).length,
      fs: +(parseFloat(getComputedStyle(csr).fontSize) / u).toFixed(1), col: getComputedStyle(csr).color, rdCol: getComputedStyle(rd).color };
  })()`);
  if (col.out === 0 && !col.names.includes('How to play') && col.fs === 13 && col.col === col.rdCol)
    ok(`${V}: with the field open every row left in the column is whole inside the page body (${col.names.join(', ')}), and the rules line is 13u in the row lines' colour`);
  else fail(`${V}: open column ${JSON.stringify(col)}`);

  // 5. a valid name reaches the socket as exactly the Set frame, nothing more
  await clearTx();
  await save('Rusty Ridge');
  t = await tx();
  let f = t[t.length - 1];
  if (t.length === 1 && f && Object.keys(f).sort().join(',') === 'id,name,type' && f.type === 'callsign'
      && f.name === 'Rusty Ridge' && typeof f.id === 'number')
    ok(`${V}: Save sends exactly {type:'callsign', name, id} and nothing else`);
  else fail(`${V}: set frame ${JSON.stringify(t)}`);

  // 6. every error code renders its exact sentence, marked as an error, as TEXT
  let bad = 0;
  for (const [code, copy] of CASES) {
    await reply('callsign', { error: code });
    e = await editor();
    if (!(e && e.rule === copy && e.bad === true && e.kids === 0 && e.btns.join('|') === 'Cancel|Save')) {
      bad++; fail(`${V}: error ${code} rendered ${JSON.stringify(e && e.rule)} (want ${JSON.stringify(copy)}), bad=${e && e.bad}`);
    }
    await save('Rusty Ridge');
  }
  await reply('callsign', { error: 'taken' });     // settle the last try: Save is disabled while one is in flight
  if (!bad) ok(`${V}: all ${CASES.length} error codes render the exact copy, as text, in the error colour`);

  // 6b. A REFUSAL INSIDE THE DAY SAYS WHEN (owner, 2026-10-07: "You can change
  //     your name again in 7 hours"). server/social.js puts what is left of the
  //     account's day on too_soon as `wait`, in ms. Counted UP, so the time it
  //     names has always passed by then; bounded by a day; and a `wait` that is
  //     not a positive number falls back to the sentence with no time in it.
  const WAITS = [
    [7 * 3600000 - 1000, 'You can change your name again in 7 hours.'],
    [6 * 3600000 + 1, 'You can change your name again in 7 hours.'],
    [3600000 + 1, 'You can change your name again in 2 hours.'],
    [3600000, 'You can change your name again in 1 hour.'],
    [25 * 60000 - 5, 'You can change your name again in 25 minutes.'],
    [30000, 'You can change your name again in 1 minute.'],
    [10 * 86400000, 'You can change your name again in 24 hours.'],
    ['7', 'You can change it again tomorrow.'],
    [-5, 'You can change it again tomorrow.'],
    [null, 'You can change it again tomorrow.'],
  ];
  let badWait = 0;
  for (const [wait, copy] of WAITS) {
    await save('Rusty Ridge');
    await reply('callsign', { error: 'too_soon', wait });
    e = await editor();
    if (!(e && e.rule === copy && e.bad === true && e.kids === 0)) { badWait++; fail(`${V}: too_soon wait ${JSON.stringify(wait)} rendered ${JSON.stringify(e && e.rule)} (want ${JSON.stringify(copy)})`); }
  }
  if (!badWait) ok(`${V}: a too_soon carrying the server's wait says when, rounded up, bounded by a day, and falls back to "tomorrow" for a wait that is not a positive number (${WAITS.length} cases)`);

  // 7. an empty field is not worth a day's quota: nothing is sent and the rule
  //    is shown as the refusal it is. The one thing the client decides for
  //    itself, and it cannot drift — no minimum length is ever below 1.
  await clearTx();
  await save('   ');
  e = await editor();
  t = await tx();
  if (e && e.rule === RULE && e.bad === true && e.btns.join('|') === 'Cancel|Save' && t.length === 0)
    ok(`${V}: an empty field sends nothing and says so — the 3-a-minute bucket is not spent on it`);
  else fail(`${V}: empty save ${JSON.stringify({ e, t })}`);

  // 8. the sign-in refusal arrives as type:'social'. A client that BELIEVES it
  //    is signed in is not told to sign in: the server's hello budget can
  //    answer sign_in before the account has resolved (Task 4, concern 1), so
  //    the socket is re-introduced and the frame asked once more.
  await clearTx();
  await save('Rusty Ridge');
  await reply('social', { error: 'sign_in' });
  t = await calls('callsign');
  e = await editor();
  if (t.length === 2 && t[1].name === 'Rusty Ridge' && t[1].id !== t[0].id && e && e.rule === RULE && !e.bad)
    ok(`${V}: a sign_in refusal to a signed-in client is retried once, not reported as an error`);
  else fail(`${V}: sign_in retry ${JSON.stringify({ t, rule: e && e.rule, bad: e && e.bad })}`);
  await reply('social', { error: 'sign_in' });
  t = await calls('callsign');
  e = await editor();
  if (t.length === 2 && e && e.rule === 'Still checking your sign-in. Try again shortly.' && e.bad === true)
    ok(`${V}: a second sign_in refusal stops, and says what is actually true of a signed-in player`);
  else fail(`${V}: sign_in twice ${JSON.stringify({ n: t.length, rule: e && e.rule })}`);

  // 8a. AND THE RETRY IS GUARDED. It was the one path with no catch: a
  //     synchronous throw out of the socket's send (or a rejected hello) left
  //     the player on a disabled Save with Cancel as the only escape. The frame
  //     that throws must also leave no waiter behind, or the callback would run
  //     a second time when its own timeout came round.
  await ev(`(() => { const push = (x) => window.__tx.push(JSON.parse(x));
    window.__boom = false;
    S.ws = { readyState: 1, send(x) { if (window.__boom) throw new Error('send failed'); push(x); } };
    return true; })()`);
  await clearTx();
  await save('Jagged Fuse');
  await ev('(window.__boom = true, true)');
  await reply('social', { error: 'sign_in' });
  e = await editor();
  const stranded = await ev('socialWait.size');
  if (e && e.rule === 'Not connected. Try again in a moment.' && e.bad === true
      && e.btns.join('|') === 'Cancel|Save' && stranded === 0)
    ok(`${V}: a throw on the sign_in retry answers the player and leaves no waiter behind`);
  else fail(`${V}: retry throw ${JSON.stringify({ e, stranded })}`);
  await ev('(window.__boom = false, true)');

  // 9. ok:true closes the editor and lands everywhere the name has to land
  await save('Iron Bandit');
  await reply('callsign', { ok: true, callsign: 'Iron Bandit' });
  const after = await ev(`(() => { Bay.show('settings'); const rr = [...document.querySelectorAll('#bay .row')].find((x) => x.querySelector('.rn2').textContent === 'Callsign'); return {
    open: !!document.getElementById('bayCall'), name: $('nameInput').value,
    pt: localStorage.getItem('pt_name'),
    held: window.CC_SOCIAL && window.CC_SOCIAL.callsign, desc: rr.querySelector('.rd').textContent,
    soc: window.__soc, card: !!document.querySelector('#bay .pbody .card'),
    howto: [...document.querySelectorAll('#bay .row .rn2')].some((x) => x.textContent === 'How to play') }; })()`);
  if (!after.open && after.name === 'Iron Bandit' && after.pt === 'Iron Bandit'
      && after.held === 'Iron Bandit' && after.desc === 'Iron Bandit' && after.soc > 0 && after.card && after.howto)
    ok(`${V}: an accepted callsign closes the field, writes #nameInput, pt_name and CC_SOCIAL, fires cc:social and puts How to play and the Built by card back`);
  else fail(`${V}: accepted ${JSON.stringify(after)}`);

  // 10. accepting a chosen name must NOT look like a roll. The client used to
  //     give a key back whenever the name went off the held one, and a Set
  //     answered in the wrong order cleared the very key it had just paid for.
  //     There is no Roll now (owner, 2026-10-07) and nothing sends a rolled
  //     frame; this stays as the guard that nothing ever starts to again.
  t = await tx();
  if (t.filter((x) => x.rolled).length === 0) ok(`${V}: setting a callsign sends no rolled frame — the key it just took is not given back`);
  else fail(`${V}: a rolled frame followed an accepted Set: ${JSON.stringify(t)}`);

  // 9a. THE FIELD OPENS ON THE NAME THEY HOLD, selected end to end. Changing a
  //     callsign is the common second visit, and retyping sixteen characters on
  //     a landscape phone keyboard to alter one of them is worse than the
  //     accident a blank field prevents — the selection means the first
  //     keystroke still replaces the lot, so Save is still a decision.
  await openEditor();
  const pre = await ev(`(() => { const i = document.getElementById('bayCall');
    return { v: i.value, from: i.selectionStart, to: i.selectionEnd }; })()`);
  if (pre.v === 'Iron Bandit' && pre.from === 0 && pre.to === 'Iron Bandit'.length)
    ok(`${V}: Set opens on the callsign they hold, selected end to end`);
  else fail(`${V}: prefill ${JSON.stringify(pre)}`);
  await closeCallsign();

  // 10a. and CHANGING one is the case that really bites: the name going in is
  //      not the name held, which is exactly the shape a Roll had. A client
  //      that gave keys back on a name change would hand back the key to the
  //      name it had just spent the day's quota on.
  await clearTx();
  await openEditor();
  await save('Copper Spire');
  await reply('callsign', { ok: true, callsign: 'Copper Spire' });
  t = await tx();
  const swap = await ev(`({ held: window.CC_SOCIAL && window.CC_SOCIAL.callsign, name: $('nameInput').value })`);
  if (t.filter((x) => x.rolled).length === 0 && swap.held === 'Copper Spire' && swap.name === 'Copper Spire')
    ok(`${V}: changing one chosen callsign for another sends no rolled frame either`);
  else fail(`${V}: chosen-to-chosen ${JSON.stringify({ t, swap })}`);

  // 10b. ok:true with NO name is not a name. Only the rolled path should ever
  //      carry callsign:null, but this is the branch that would write it into
  //      #nameInput and let cloudQueue() push the player's new name, "null".
  await openEditor();
  await save('Basalt Rim');
  await reply('callsign', { ok: true, callsign: null });
  const nulled = await ev(`({ name: $('nameInput').value, pt: localStorage.getItem('pt_name'),
    held: window.CC_SOCIAL && window.CC_SOCIAL.callsign, open: !!document.getElementById('bayCall') })`);
  if (nulled.name === 'Copper Spire' && nulled.pt === 'Copper Spire' && nulled.held === 'Copper Spire' && nulled.open)
    ok(`${V}: an ok reply carrying no name renames nobody — "null" never reaches #nameInput or the cloud queue`);
  else fail(`${V}: nameless ok ${JSON.stringify(nulled)}`);

  // That nameless ok settles as the catch-all 'offline', which now RE-READS the
  // snapshot: a Set whose answer was lost looks exactly like this, and the
  // re-read is the only thing that would ever correct it. Settle the request, or
  // an outstanding read model masks every later "was anything sent?" assertion
  // — the trap FI-25 and FI-26 both fell into the first time.
  await ev(`(() => { const q = window.__tx.filter((f) => f.type === 'friends');
    if (q.length) handle({ type: 'friends', error: 'unavailable', id: q[q.length - 1].id });
    return q.length; })()`);

  // 11. a reply nobody is waiting on is ignored
  await closeCallsign();
  await openEditor();
  await save('Steel Mesa');
  await ev(`(() => { handle({ type: 'callsign', error: 'taken', id: 987654 }); return true; })()`);
  await sleep(80);
  e = await editor();
  if (e && e.rule === RULE && e.bad === false && e.btns.join('|') === 'Cancel|Saving')
    ok(`${V}: a reply with an id nobody is waiting on changes nothing — the try is still in flight`);
  else fail(`${V}: stale reply ${JSON.stringify(e)}`);
  await reply('callsign', { error: 'taken' });
  e = await editor();
  if (e && e.rule === 'Someone has that callsign.' && e.bad === true) ok(`${V}: the matching reply still lands after the stale one`);
  else fail(`${V}: matched reply after stale ${JSON.stringify(e)}`);

  // 12. a reply to a try the player has ABANDONED changes nothing. The editor
  //     is closed and reopened between the send and the answer, so the answer
  //     belongs to a field that is gone.
  await save('Amber Volley');
  await ev(`(() => { document.querySelector('#bay [data-cs="cancel"]').click(); return true; })()`);
  await openEditor();
  await reply('callsign', { error: 'taken' });
  e = await editor();
  if (e && e.rule === RULE && e.bad === false && e.btns.join('|') === 'Cancel|Save')
    ok(`${V}: an answer to an abandoned try does not mark the field the player has since reopened`);
  else fail(`${V}: abandoned try ${JSON.stringify(e)}`);

  // 13. socket down: say so, queue nothing
  await ev('(S.ws.readyState = 3, true)');
  await clearTx();
  await save('Amber Volley');
  e = await editor();
  t = await tx();
  if (e && e.rule === 'Not connected. Try again in a moment.' && e.bad === true && t.length === 0)
    ok(`${V}: with the socket down the field says so and nothing is queued`);
  else fail(`${V}: socket down ${JSON.stringify({ e, t })}`);
  await ev('(S.ws.readyState = 1, true)');
  await ev(`(() => { document.querySelector('#bay [data-cs="cancel"]').click(); return true; })()`);

  // 15. a friends snapshot is the AUTHORITY on this account's own chosen name
  //     (BINDING resolution 13), and a chosen name is adopted as the player's
  //     name — that is what makes it worth choosing on a second device.
  await clearTx();
  await ev(`(() => { window.__soc = 0; handle(${SNAP({ callsign: 'Flint Rim' })}); return true; })()`);
  await sleep(80);
  let snap = await ev('({ s: window.CC_SOCIAL, soc: window.__soc, name: $("nameInput").value, pt: localStorage.getItem("pt_name") })');
  t = await tx();
  if (snap.s && snap.s.friendCode === 'AB12CD' && snap.s.friends.length === 1 && snap.s.blocked.length === 1
      && snap.s.requests && Array.isArray(snap.s.requests.in) && snap.s.callsign === 'Flint Rim'
      && snap.name === 'Flint Rim' && snap.pt === 'Flint Rim' && snap.soc === 1 && t.length === 0)
    ok(`${V}: a snapshot fills CC_SOCIAL, fires cc:social once, and a callsign chosen elsewhere becomes this device's name without a rolled frame`);
  else fail(`${V}: snapshot ${JSON.stringify({ snap, t })}`);

  // 16. a REFUSED friends frame is not an empty panel. The server says so
  //     itself: "a panel that renders 'no friends yet' because PostgREST was
  //     down is worse than one that says it could not load."
  await ev(`(() => { handle({ type: 'friends', error: 'unavailable', id: 4242 }); return true; })()`);
  await sleep(60);
  snap = await ev('({ held: window.CC_SOCIAL && window.CC_SOCIAL.callsign, friends: window.CC_SOCIAL && window.CC_SOCIAL.friends.length })');
  if (snap.held === 'Flint Rim' && snap.friends === 1)
    ok(`${V}: a refused friends frame leaves the snapshot alone — it is an error, not an empty panel`);
  else fail(`${V}: refused friends frame ${JSON.stringify(snap)}`);

  // 17. a snapshot that is OLDER than an answer still in flight must not undo
  //     it. A push is built from a read the server began before the write
  //     landed; the reply to the frame the player is waiting on is newer.
  await openEditor();
  await save('Cobalt Salvo');
  await ev(`(() => { handle(${SNAP({ callsign: null })}); return true; })()`);
  await sleep(60);
  let mid = await ev('window.CC_SOCIAL && window.CC_SOCIAL.callsign');
  await reply('callsign', { ok: true, callsign: 'Cobalt Salvo' });
  const done = await ev('({ held: window.CC_SOCIAL && window.CC_SOCIAL.callsign, name: $("nameInput").value })');
  if (mid === 'Flint Rim' && done.held === 'Cobalt Salvo' && done.name === 'Cobalt Salvo')
    ok(`${V}: a snapshot arriving mid-Set cannot clear the name the answer is about to confirm`);
  else fail(`${V}: mid-flight snapshot ${JSON.stringify({ mid, done })}`);

  // 18. an id-less push still updates the panel and runs no callback
  await ev(`(() => { window.__soc = 0; handle(${SNAP({ callsign: 'Cobalt Salvo', friendCode: 'ZZ99ZZ' })}); return true; })()`);
  await sleep(60);
  snap = await ev('({ code: window.CC_SOCIAL && window.CC_SOCIAL.friendCode, soc: window.__soc })');
  if (snap.code === 'ZZ99ZZ' && snap.soc === 1) ok(`${V}: a push with no id updates the snapshot and runs no callback`);
  else fail(`${V}: id-less push ${JSON.stringify(snap)}`);

  // 18a. THE BOUNDED WINDOW. A push snapshot can be built from a read the server
  //      began BEFORE this player's write landed, and it can arrive after the
  //      answer to it; no frame carries a sequence, so nothing can order them.
  //      A null is the weakest claim on that field: for CALLSIGN_HOLD_MS after a
  //      name this client saw CONFIRMED, it is not believed. Bounded, so the
  //      cross-device case still works — set on one device, roll on another.
  await ev(`(() => { handle(${SNAP({ callsign: null })}); return true; })()`);
  await sleep(60);
  let win = await ev('window.CC_SOCIAL && window.CC_SOCIAL.callsign');
  if (win === 'Cobalt Salvo') ok(`${V}: a null snapshot landing just after a confirmed name is not believed`);
  else fail(`${V}: stale null snapshot ${JSON.stringify(win)}`);
  // and it EXPIRES. Age the confirmation past the window and the same frame is
  // believed, which is what keeps a roll on another device from being ignored
  // for ever.
  const aged = await ev(`(() => { try { csHeldAt = Date.now() - 60000; return true; } catch { return false; } })()`);
  await ev(`(() => { handle(${SNAP({ callsign: null })}); return true; })()`);
  await sleep(60);
  win = await ev('window.CC_SOCIAL && window.CC_SOCIAL.callsign');
  if (aged && win === null) ok(`${V}: and once the window is out the same null snapshot IS believed — the hold is bounded`);
  else fail(`${V}: window never expires ${JSON.stringify({ aged, win })}`);
  // (A check stood here that this client's own Roll ended the window early.
  // There is no Roll any more -- owner, 2026-10-07 -- so the window now ends
  // only by running out, as above, or by a snapshot that carries a name.)

  // 18b. THE TWELVE-SECOND TIMEOUT, and the repair that hangs off it. It is the
  //      single guard against waiting for ever and it had no test at all.
  //      setTimeout is intercepted rather than waited on, so the check is that
  //      the timer is armed for exactly SOCIAL_TIMEOUT_MS and that firing it
  //      answers the try. A LOST ANSWER IS NOT A LOST WRITE: the server may have
  //      taken the name, so the snapshot is re-asked, and that is the only thing
  //      in the session that would ever correct a successful save reported as a
  //      failure.
  await clearTx();
  await ev(`(() => {
    window.__t12 = null; window.__realTimeout = window.setTimeout;
    window.setTimeout = function (f, ms) { if (ms === 12000 && !window.__t12) { window.__t12 = f; return -1; } return window.__realTimeout.apply(window, arguments); };
    return true; })()`);
  await openEditor();
  await save('Granite Wash');
  const armed = await ev(`(() => { window.setTimeout = window.__realTimeout; return typeof window.__t12 === 'function'; })()`);
  await clearTx();
  // Guarded: with the timer armed for anything but SOCIAL_TIMEOUT_MS there is
  // nothing to fire, and this check has to REPORT that rather than throw out of
  // the suite — a crash is not a FAIL line.
  if (armed) await ev(`(() => { window.__t12(); return true; })()`);
  await sleep(120);
  e = await editor();
  t = await calls('friends');
  // AND IT DOES NOT BLAME THE PLAYER'S CONNECTION. The stub socket is open
  // (readyState 1), so this timeout is a server that did not answer in time --
  // which it can legitimately be, with social frames serialised per socket and
  // five store calls behind an 8s abort each. 'Not connected. Try again in a
  // moment.' sent a player with perfect signal to check their wifi for a fault
  // on the server. The re-read still has to happen: the write may have landed,
  // and that is the only thing in the session that would ever correct it.
  if (armed && e && e.rule === 'Callsigns are not available right now. Try again later.' && e.bad === true && t.length === 1)
    ok(`${V}: a reply that never comes on a LIVE socket is answered at 12000 ms in server-side words, and the snapshot is re-asked`);
  else fail(`${V}: timeout ${JSON.stringify({ armed, rule: e && e.rule, bad: e && e.bad, t })}`);
  // the repair lands: the server HAD taken the name the player was told to try
  // again for, and the row, the device name and pt_name all catch up.
  await ev(`(() => { const q = window.__tx.filter((f) => f.type === 'friends');
    if (q.length) handle(Object.assign(${SNAP({ callsign: 'Granite Wash' })}, { id: q[q.length - 1].id }));
    return q.length; })()`);
  await sleep(80);
  const repaired = await ev(`({ held: window.CC_SOCIAL && window.CC_SOCIAL.callsign, name: $('nameInput').value, pt: localStorage.getItem('pt_name') })`);
  if (repaired.held === 'Granite Wash' && repaired.name === 'Granite Wash' && repaired.pt === 'Granite Wash')
    ok(`${V}: and a Set that SUCCEEDED but lost its reply repairs itself from that snapshot`);
  else fail(`${V}: lost-reply repair ${JSON.stringify(repaired)}`);
  await closeCallsign();

  // 19. the landscape keyboard. visualViewport is stubbed BEFORE the editor
  //     opens, because that is when bay.js subscribes. The numbers are
  //     measured, never assumed: the keyboard height is derived from where the
  //     editor actually sits at this viewport.
  const vvOk = await ev(`(() => {
    const c = document.querySelector('#bay [data-cs="cancel"]'); if (c) c.click();
    const vv = { offsetTop: 0, height: window.innerHeight, _l: [],
      addEventListener(t, f) { this._l.push(f); }, removeEventListener(t, f) { this._l = this._l.filter((x) => x !== f); } };
    try { Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true }); } catch { return false; }
    return window.visualViewport === vv;
  })()`);
  if (!vvOk) fail(`${V}: visualViewport could not be stubbed — the keyboard lift is unproven`);
  else {
    await openEditor();
    const quiet = await ev(`({ kbd: $('bay').classList.contains('kbd'), lift: $('bay').style.getPropertyValue('--kbd'), bottom: document.querySelector('#bay .csx').getBoundingClientRect().bottom })`);
    if (!quiet.kbd && (quiet.lift === '' || quiet.lift === '0px')) ok(`${V}: no keyboard, no lift`);
    else fail(`${V}: lifted with no keyboard ${JSON.stringify(quiet)}`);
    const up = await ev(`(() => {
      const vv = window.visualViewport;
      vv.height = Math.round(${quiet.bottom} - 40);
      vv._l.forEach((f) => f());
      const host = $('bay');
      return { kbd: host.classList.contains('kbd'), lift: parseFloat(host.style.getPropertyValue('--kbd')),
               bottom: document.querySelector('#bay .csx').getBoundingClientRect().bottom, vh: vv.height,
               fieldTop: document.getElementById('bayCall').getBoundingClientRect().top };
    })()`);
    if (up.kbd && up.lift > 0 && up.bottom <= up.vh && up.fieldTop >= 0)
      ok(`${V}: the keyboard lifts the frame by ${Math.round(up.lift)}px — the field and its rules clear the keyboard and stay on screen`);
    else fail(`${V}: keyboard lift ${JSON.stringify(up)}`);
    // A keyboard too tall for the field to clear at all. The lift must stop at
    // the top of the visible band: going further would carry the field off the
    // top of the screen, which is the same blind typing by another route.
    const huge = await ev(`(() => {
      const host = $('bay'); host.classList.remove('kbd');
      const top = document.querySelector('#bay .csx').getBoundingClientRect().top;
      const vv = window.visualViewport;
      vv.height = 40;
      vv._l.forEach((f) => f());
      return { want: Math.round(top), lift: parseFloat(host.style.getPropertyValue('--kbd')),
               fieldTop: document.getElementById('bayCall').getBoundingClientRect().top };
    })()`);
    if (huge.lift === huge.want && huge.fieldTop >= 0)
      ok(`${V}: a keyboard the field cannot clear lifts it to the top of the visible band and no further (${huge.lift}px)`);
    else fail(`${V}: over-lift ${JSON.stringify(huge)}`);
    const down = await ev(`(() => { const vv = window.visualViewport; vv.height = window.innerHeight; vv._l.forEach((f) => f()); const host = $('bay'); return { kbd: host.classList.contains('kbd'), lift: host.style.getPropertyValue('--kbd') }; })()`);
    if (!down.kbd) ok(`${V}: the frame drops back when the keyboard goes`);
    else fail(`${V}: frame stayed lifted ${JSON.stringify(down)}`);

    // 19c. THE LIFT IS RE-MEASURED AFTER A RENDER, not only when the viewport
    //      moves. An error sentence can wrap where the one-line rule did not,
    //      which pushes the bottom of the editor past a lift measured before it
    //      — and the line that says what went wrong is the one that ends up
    //      under the keyboard. The BAND is moved here, with no viewport event
    //      fired, so the only thing that can bring the editor back inside it is
    //      the re-measure on the error path itself.
    await clearTx();
    await save('Molten Fuse');
    await ev(`(() => { const vv = window.visualViewport;
      vv.height = Math.round(document.querySelector('#bay .csx').getBoundingClientRect().bottom - 20); return vv.height; })()`);
    await reply('callsign', { error: 'taken' });
    const fit = await ev(`({ bottom: document.querySelector('#bay .csx').getBoundingClientRect().bottom,
      vh: window.visualViewport.height, rule: document.querySelector('#bay .csr').textContent })`);
    if (fit.rule === 'Someone has that callsign.' && fit.bottom <= fit.vh + 0.5)
      ok(`${V}: the error render re-measures the lift — the line the player needs cannot hide under the keyboard`);
    else fail(`${V}: no refit after an error ${JSON.stringify(fit)}`);
  }

  // 20. leaving Bay controls closes the editor and unsubscribes
  const left = await ev(`(() => { Bay.show('home'); return { field: !!document.getElementById('bayCall'), kbd: $('bay').classList.contains('kbd'), listeners: (window.visualViewport && window.visualViewport._l) ? window.visualViewport._l.length : -1 }; })()`);
  if (!left.field && !left.kbd && left.listeners === 0)
    ok(`${V}: leaving Bay controls closes the field, drops the lift and removes every viewport listener`);
  else fail(`${V}: leaving ${JSON.stringify(left)}`);

  // 20a. LEAVING INSIDE THE FOCUS TICK. openCallsign() defers the focus and the
  //      viewport watch by 60 ms; a player who taps Set and goes straight back
  //      had that timer land AFTER the close and re-subscribe the listener the
  //      close had just removed, leaving the watch running on a screen with no
  //      field on it.
  await ev(`(() => { Bay.show('settings'); document.querySelector('#bay [data-cs="open"]').click(); Bay.show('home'); return true; })()`);
  await sleep(220);
  const raced = await ev(`({ field: !!document.getElementById('bayCall'), kbd: $('bay').classList.contains('kbd'),
    listeners: (window.visualViewport && window.visualViewport._l) ? window.visualViewport._l.length : -1 })`);
  if (!raced.field && !raced.kbd && raced.listeners === 0)
    ok(`${V}: leaving inside the 60 ms focus tick cancels it — no listener is re-subscribed behind the close`);
  else fail(`${V}: focus race ${JSON.stringify(raced)}`);

  // 20b. AN ACCOUNT FLIP WHILE THE FIELD IS OPEN. csRow() returns the guest row
  //      early, before the editor's markup is built, so the field vanished while
  //      #bay was still shoved up over a keyboard that had gone with it, and the
  //      only way down was to leave the screen.
  //      Signing out also GIVES THE CHOSEN NAME UP. It belongs to the account,
  //      not to the device, so the device must not go on wearing a unique
  //      callsign its account has left. CHANGED (owner, 2026-10-07: names are
  //      permanent): what the device goes back to is ITS OWN name -- the
  //      default it was given once, or a name a guest set on it -- where it
  //      used to roll a fresh one. This pinned only "not the chosen name"; it
  //      now pins which name.
  const own0 = await ev(`localStorage.getItem('cc_name_own')`);
  await ev(`(() => { Bay.show('settings'); return true; })()`);
  await openEditor();
  const lifted = await ev(`(() => { const vv = window.visualViewport;
    vv.height = Math.round(document.querySelector('#bay .csx').getBoundingClientRect().bottom - 40);
    vv._l.forEach((f) => f());
    return { kbd: $('bay').classList.contains('kbd'), name: $('nameInput').value }; })()`);
  const flipped = await ev(`(() => {
    window.CC_ACCOUNT = ${GUEST};
    document.dispatchEvent(new CustomEvent('cc:account'));
    return { field: !!document.getElementById('bayCall'), kbd: $('bay').classList.contains('kbd'),
             lift: $('bay').style.getPropertyValue('--kbd'), social: window.CC_SOCIAL,
             listeners: window.visualViewport._l.length, name: $('nameInput').value,
             pt: localStorage.getItem('pt_name') }; })()`);
  if (lifted.kbd && lifted.name === 'Granite Wash' && !flipped.field && !flipped.kbd && flipped.lift === ''
      && flipped.listeners === 0 && flipped.social === null
      && flipped.name !== 'Granite Wash' && flipped.pt === flipped.name && !!own0 && flipped.name === own0)
    ok(`${V}: losing the account closes the open field, drops the lift and hands the chosen name back, returning the device to its own name ('${own0}'), not a fresh roll`);
  else fail(`${V}: account flip ${JSON.stringify({ lifted, flipped })}`);

  // 20c. A DEVICE THAT NEVER KEPT A NAME OF ITS OWN gets ONE default and keeps
  //      it. A device that came up from a build before 8 holds the account's
  //      chosen name in pt_name and nothing else; its first sign-out gives it a
  //      rolled default, and every later sign-out comes back to that same one
  //      -- never a second roll (owner, 2026-10-07: names are permanent).
  const pre8 = await ev(`(() => {
    const adopt = () => {
      window.CC_ACCOUNT = ${LINKED}; document.dispatchEvent(new CustomEvent('cc:account'));
      const q = window.__tx.filter((f) => f.type === 'friends');
      handle(Object.assign(${SNAP({ callsign: 'Flint Rim' })}, q.length ? { id: q[q.length - 1].id } : {}));
      return $('nameInput').value;
    };
    const leave = () => { window.CC_ACCOUNT = ${GUEST}; document.dispatchEvent(new CustomEvent('cc:account')); return $('nameInput').value; };
    const a1 = adopt(); localStorage.removeItem('cc_name_own');
    const first = leave(), own1 = localStorage.getItem('cc_name_own');
    const a2 = adopt(), second = leave();
    return { a1, a2, first, own1, second, rolled: rolledPair(first), own2: localStorage.getItem('cc_name_own') };
  })()`);
  await clearTx();
  if (pre8.a1 === 'Flint Rim' && pre8.a2 === 'Flint Rim' && pre8.rolled && pre8.own1 === pre8.first
      && pre8.second === pre8.first && pre8.own2 === pre8.first)
    ok(`${V}: a device with no name of its own is given one default on its first sign-out ('${pre8.first}') and comes back to that same name on the next`);
  else fail(`${V}: pre-build-8 sign-out ${JSON.stringify(pre8)}`);

  // 21. a guest's row names the guest and offers Change: a guest names
  //     themselves now (owner, 2026-10-07). CHANGED twice: this pinned the
  //     guest row as "Sign in to choose a callsign." with Roll alone, and then
  //     as 'Your name in every match'. CHANGED AGAIN (round 3, 2026-10-10):
  //     the server may now give a guest a new name and tell them "You can
  //     change it in Bay controls", so the row shows the name it means, the
  //     one this device plays under (myName). Signing out still drops the
  //     WHOLE snapshot — the friends and blocked lists belong to the account
  //     that left.
  await clearTx();
  const out = await ev(`(() => {
    window.CC_ACCOUNT = ${GUEST};
    document.dispatchEvent(new CustomEvent('cc:account'));
    return { social: window.CC_SOCIAL, me: myName() };
  })()`);
  await sleep(60);
  r = await rowInfo();
  t = await tx();
  if (out.social === null && r && out.me && r.desc === out.me && r.btns.join('|') === 'Change' && r.acts.join('|') === 'data-cs=open'
      && r.dis.join('|') === 'false' && new Set(r.heights).size === 1 && t.length === 0)
    ok(`${V}: a guest's row names the guest ('${out.me}') and offers Change, asks the server for nothing, and keeps no trace of the account that left`);
  else fail(`${V}: guest ${JSON.stringify({ social: out.social, r, t })}`);

  // 22. the outbox Task 8 inherits. BINDING resolution 3: block, report and
  //     friend remove spell their TARGET in `id`, so a frame that carries one
  //     must reach the wire with it — a correlation number minted over the top
  //     would address the operation at nobody.
  await clearTx();
  const uuid = '00000000-0000-4000-8000-0000ab000002';
  const outbox = await ev(`(() => {
    const a = socialSend({ type: 'block', op: 'add', id: ${JSON.stringify(uuid)} }, () => {});
    const b = socialSend({ type: 'report', handle: '1a2b3c4d' }, () => {});
    return { a, b, tx: window.__tx.slice() };
  })()`);
  if (outbox.a === uuid && outbox.tx[0].id === uuid && outbox.tx[0].op === 'add'
      && typeof outbox.b === 'number' && outbox.tx[1].id === outbox.b && outbox.tx[1].handle === '1a2b3c4d')
    ok(`${V}: socialSend keeps a target id on the wire and mints a correlation id only when the frame has none`);
  else fail(`${V}: outbox ${JSON.stringify(outbox)}`);
  // Settle both, or they sit in the waiter map and the next check answers THEM
  // instead of its own frames. Same trap as FI-25's, one map further down.
  await ev(`(() => { handle({ type: 'block', op: 'add', ok: true, id: ${JSON.stringify(uuid)} });
    handle({ type: 'report', ok: true, id: ${outbox.b} }); return socialWait.size; })()`);
  await clearTx();

  // 22a. AND TWO OPERATIONS ON ONE TARGET BOTH GET THEIR ANSWER. A target id is
  //      not unique per request, so a waiter map keyed on the frame's own id
  //      loses the first of them: its callback is orphaned and never runs on any
  //      path, and its timeout would later resolve somebody else's entry. Block
  //      add then block remove on one player is Task 8's first use of this
  //      helper, so the key has to be something the helper itself mints.
  const pair = await ev(`(() => {
    window.__cb = [];
    const before = socialWait.size;
    socialSend({ type: 'block', op: 'add', id: ${JSON.stringify(uuid)} }, (m) => window.__cb.push('a:' + (m.op || m.error || '?')));
    socialSend({ type: 'block', op: 'remove', id: ${JSON.stringify(uuid)} }, (m) => window.__cb.push('b:' + (m.op || m.error || '?')));
    const waiting = socialWait.size - before;
    handle({ type: 'block', op: 'add', ok: true, id: ${JSON.stringify(uuid)} });
    handle({ type: 'block', op: 'remove', ok: true, id: ${JSON.stringify(uuid)} });
    return { waiting, cb: window.__cb.slice(), left: socialWait.size - before };
  })()`);
  if (pair.waiting === 2 && pair.cb.join('|') === 'a:add|b:remove' && pair.left === 0)
    ok(`${V}: two operations on the SAME target are two waiters, answered oldest first, neither callback orphaned`);
  else fail(`${V}: same-target waiters ${JSON.stringify(pair)}`);
  await clearTx();

  // 23. A GUEST NAMES THEMSELVES (owner, 2026-10-07: "the player is given a
  //     default name and then they can change it to whatever they like, as long
  //     as it stays within the guidelines"; "once a day"). CHANGED: this check
  //     proved a guest's Roll renamed them locally and sent nothing; there is no
  //     Roll. A guest opens the same field, and the device asks the server's
  //     check -- {type:'callsign', op:'check'}, the test the lobby door applies
  //     -- before it keeps anything. The day is counted on the device.
  await ev(`(() => { localStorage.removeItem('cc_name_at'); setOwnName('Iron Ridge'); return true; })()`);
  await clearTx();
  // 23a. the field opens for a guest, EMPTY when the name is the rolled
  //      default (nobody picked it, so it is not offered to spend a day on).
  await openEditor();
  e = await editor();
  const g0 = await ev(`(() => { const i = document.getElementById('bayCall'), b = document.querySelector('#bay [data-cs="save"]');
    return { open: !!i, v: i ? i.value : null, dis: b ? b.disabled : null }; })()`);
  if (e && e.rule === RULE && !e.bad && e.btns.join('|') === 'Cancel|Save' && e.focused && e.inStage && g0.v === '' && !g0.dis)
    ok(`${V}: a guest's Change opens the field, empty over the rolled default, with the rules under it and Save ready`);
  else fail(`${V}: guest editor ${JSON.stringify({ e, g0 })}`);
  // Every step below types into that field. With no field there is nothing to
  // drive, so they are reported as one failure here instead of a crash that
  // ends the whole suite and hides every check after it.
  if (!g0.open) fail(`${V}: a guest's field never opened -- 23b to 23i not run`);
  else {
    // 23b. Save sends EXACTLY the check frame, the name as typed but for the
    //      ends (submitCallsign trims, as it does for a Set) -- the run of spaces
    //      inside is the server's to collapse, never the client's.
    await clearTx();
    await save('  Tank   Ace ');
    t = await tx();
    f = t[t.length - 1];
    if (t.length === 1 && f && Object.keys(f).sort().join(',') === 'id,name,op,type' && f.type === 'callsign'
        && f.op === 'check' && f.name === 'Tank   Ace' && typeof f.id === 'number')
      ok(`${V}: a guest's Save sends exactly {type:'callsign', op:'check', name, id}, the name as typed but for the ends`);
    else fail(`${V}: guest check frame ${JSON.stringify(t)}`);
    // 23c. every refusal is said, and NOTHING is kept: not the name, not the day.
    // CHANGED (round 2): 'taken' joins them -- a guest's check now refuses a
    // name an account holds as its chosen callsign, in the Set's own words.
    const GCASES = [['length', RULE], ['chars', RULE], ['not_allowed', 'That callsign is not allowed.'], ['taken', 'Someone has that callsign.'],
      ['slow_down', 'Too many tries. Wait a moment.'], ['unavailable', 'Callsigns are not available right now. Try again later.'],
      ['a_code_from_a_newer_server', 'That callsign could not be set.']];
    let gbad = 0;
    for (const [code, copy] of GCASES) {
      await reply('callsign', { op: 'check', error: code });
      e = await editor();
      const kept = await ev(`({ name: $('nameInput').value, pt: localStorage.getItem('pt_name'), own: localStorage.getItem('cc_name_own'), at: localStorage.getItem('cc_name_at') })`);
      if (!(e && e.rule === copy && e.bad === true && kept.name === 'Iron Ridge' && kept.pt === 'Iron Ridge' && kept.own === 'Iron Ridge' && kept.at === null)) {
        gbad++; fail(`${V}: guest refusal ${code} ${JSON.stringify({ rule: e && e.rule, bad: e && e.bad, kept })}`);
      }
      // Typed in a different case and spacing from the answer 23d gives, so
      // keeping the TYPED copy instead of the server's cannot pass by accident.
      await save('tank   ace');
    }
    if (!gbad) ok(`${V}: all ${GCASES.length} refusals of a guest's name say why, and keep nothing -- no name, no day spent`);
    // 23d. the answer is KEPT, and what is kept is the SERVER's normalised name.
    const t0 = await ev('Date.now()');
    await reply('callsign', { op: 'check', ok: true, name: 'Tank Ace' });
    const gk = await ev(`(() => { Bay.show('home'); const c = document.querySelector('#bay .top [data-cs="name"] b');
      return { field: !!document.getElementById('bayCall'), name: $('nameInput').value, pt: localStorage.getItem('pt_name'),
        own: localStorage.getItem('cc_name_own'), at: Number(localStorage.getItem('cc_name_at')), now: Date.now(), chip: c && c.textContent }; })()`);
    if (!gk.field && gk.name === 'Tank Ace' && gk.pt === 'Tank Ace' && gk.own === 'Tank Ace' && gk.chip === 'Tank Ace'
        && gk.at >= t0 && gk.at <= gk.now)
      ok(`${V}: an ok check keeps the server's 'Tank Ace' as the device's own name, on #nameInput, pt_name and the home chip, and stamps the day`);
    else fail(`${V}: guest kept ${JSON.stringify(gk)}`);
    // 23e. ONCE A DAY: the field says when (the row goes on naming the
    //      player), Save stands down, the field opens on the name they chose,
    //      and nothing at all is sent -- not by Save, not by Enter, not by
    //      calling the wire directly.
    r = await rowInfo();
    await clearTx();
    await openEditor();
    e = await editor();
    const g1 = await ev(`(() => { const i = document.getElementById('bayCall');
      return { v: i.value, focused: document.activeElement === i, kbd: $('bay').classList.contains('kbd'), dis: document.querySelector('#bay [data-cs="save"]').disabled }; })()`);
    await ev(`(() => { const i = document.getElementById('bayCall'); i.value = 'Other Name';
      document.querySelector('#bay [data-cs="save"]').click();
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await sleep(80);
    const enter = await editor();
    const direct = await ev(`new Promise((res) => sendGuestName('Other Name', res))`);
    t = await calls('callsign');
    if (r && r.desc === 'Tank Ace' && r.dis.join('|') === 'false'
        && e && e.rule === 'You can change your name again in 24 hours.' && !e.bad && g1.dis
        && g1.v === 'Tank Ace' && !g1.focused && !g1.kbd
        && enter && enter.rule === 'You can change your name again in 24 hours.'
        && direct && direct.ok === false && direct.error === 'too_soon' && direct.wait > 0 && t.length === 0)
      ok(`${V}: inside the day the row still names the player ('Tank Ace', round 3 fix: it said "Change it again in 24 hours" in its place), the field says when, Save stands down, the field shows 'Tank Ace' with no keyboard raised, and Save, Enter and the wire itself send nothing`);
    else fail(`${V}: guest day ${JSON.stringify({ r, e, g1, enter: enter && enter.rule, direct, t })}`);
    await closeCallsign();
    // 23f. COUNTED DOWN FROM THE STAMP, rounded up; and the day ENDS.
    const at = (ago) => ev(`(() => { localStorage.setItem('cc_name_at', String(Date.now() - ${ago})); return true; })()`);
    const lineAfter = async (ago) => { await at(ago); await openEditor(); const x = await editor(); const d = await ev(`document.querySelector('#bay [data-cs="save"]').disabled`); await closeCallsign(); return { rule: x && x.rule, bad: x && x.bad, dis: d }; };
    const L17 = await lineAfter(17 * 3600000);
    const L30 = await lineAfter(86400000 - 30 * 60000);
    const Lend = await lineAfter(86400000 + 1000);
    // A STAMP FROM THE FUTURE -- the clock set back -- opens the gate rather
    // than holding it shut for longer than a day.
    const Lfut = await lineAfter(-2 * 86400000);
    if (L17.rule === 'You can change your name again in 7 hours.' && L17.dis
        && L30.rule === 'You can change your name again in 30 minutes.' && L30.dis
        && Lend.rule === RULE && !Lend.dis && Lfut.rule === RULE && !Lfut.dis)
      ok(`${V}: the day counts down from the device's stamp ("in 7 hours", "in 30 minutes"), ends after 24 hours, and a stamp from the future opens the gate`);
    else fail(`${V}: guest countdown ${JSON.stringify({ L17, L30, Lend, Lfut })}`);
    // 23g. no connection -- the socket down, or the in-page offline engine in
    //      its place -- is said, and nothing is queued or kept.
    await ev(`(() => { localStorage.removeItem('cc_name_at'); return true; })()`);
    await clearTx();
    await openEditor();
    await ev('(S.ws.readyState = 3, true)');
    await save('Wren Hollow');
    const down = await editor();
    await ev('(S.ws.readyState = 1, S.local = true, true)');
    await save('Wren Hollow');
    const local = await editor();
    await ev('(S.local = false, true)');
    t = await tx();
    const keptName = await ev(`$('nameInput').value`);
    if (down && down.rule === 'Not connected. Try again in a moment.' && down.bad && local && local.rule === 'Not connected. Try again in a moment.'
        && t.length === 0 && keptName === 'Tank Ace')
      ok(`${V}: with no socket, or the offline engine in its place, a guest's Save says so and nothing is sent or kept`);
    else fail(`${V}: guest offline ${JSON.stringify({ down, local, t, keptName })}`);
    await closeCallsign();
    // 23h. THE HOME NAME CHIP, AS A GUEST: Bay controls with the field open on
    //      it -- the chip used to roll a new name on every tap.
    await clearTx();
    const chipGuest = await ev(`(() => { Bay.show('home'); document.querySelector('#bay .top [data-cs="name"]').click();
      return { scr: $('bay').dataset.scr, name: $('nameInput').value }; })()`);
    await sleep(150);
    const chipField = await ev(`({ field: !!document.getElementById('bayCall'), v: document.getElementById('bayCall') && document.getElementById('bayCall').value })`);
    t = await tx();
    if (chipGuest.scr === 'settings' && chipGuest.name === 'Tank Ace' && chipField.field && chipField.v === 'Tank Ace' && t.length === 0)
      ok(`${V}: the home name chip opens Bay controls with the field open on the name, renames nobody and sends nothing`);
    else fail(`${V}: guest chip ${JSON.stringify({ chipGuest, chipField, t })}`);
    // 23i. A SIGN-IN WHILE THE GUEST FIELD IS OPEN CLOSES IT: it was opened to
    //      keep a name on this device and must not save it as an account's
    //      chosen callsign, or the other way round.
    const signedIn = await ev(`(() => { window.CC_ACCOUNT = ${LINKED}; document.dispatchEvent(new CustomEvent('cc:account'));
      Bay.show('settings'); return { field: !!document.getElementById('bayCall'), kbd: $('bay').classList.contains('kbd') }; })()`);
    await ev(`(() => { const q = window.__tx.filter((f) => f.type === 'friends'); if (q.length) handle({ type: 'friends', error: 'unavailable', id: q[q.length - 1].id }); return true; })()`);
    if (!signedIn.field && !signedIn.kbd) ok(`${V}: a sign-in while a guest's field is open closes it`);
    else fail(`${V}: guest field survived a sign-in ${JSON.stringify(signedIn)}`);
    // 23j. A GUEST'S DAY DOES NOT HOLD AN ACCOUNT'S SAVE (round 2: the tests
    //      group found nameWait()'s signed-in guard untested). The guest kept
    //      a name today (cc_name_at stamped) and then signed in, the same
    //      day. The account's day is the SERVER's (callsign_set_at), so the
    //      device's stamp must not hold the account's Save: the field opens
    //      with the rules under it and Save ready, and Save sends the Set.
    await ev(`(() => { localStorage.setItem('cc_name_at', String(Date.now() - 3600000)); handle(${SNAP({ callsign: 'Anvil Six' })}); return true; })()`);
    await sleep(60);
    const r23j = await rowInfo();
    const w23j = await ev('nameWait()');
    await clearTx();
    await openEditor();
    const e23j = await editor();
    const s23j = await ev(`(() => { const b = document.querySelector('#bay [data-cs="save"]'); return b ? b.disabled : null; })()`);
    await save('Kestrel Bay');
    const f23j = (await calls('callsign')).pop();
    if (f23j) await reply('callsign', { error: 'unavailable' });
    await closeCallsign();
    if (w23j === 0 && r23j && r23j.desc === 'Anvil Six' && r23j.dis.join('|') === 'false'
        && e23j && e23j.rule === RULE && !e23j.bad && s23j === false
        && f23j && f23j.type === 'callsign' && f23j.name === 'Kestrel Bay' && f23j.op === undefined)
      ok(`${V}: a guest's day spent on this device does not hold a signed-in account's Save: nameWait() is 0, the field shows the rules, Save is ready and sends the Set`);
    else fail(`${V}: signed-in after a guest's day ${JSON.stringify({ w23j, r23j, e23j, s23j, f23j })}`);
  }
  // The device's own name and its day are this run's; the next viewport and
  // Task 8 start from a device that has not spent one.
  await ev(`(() => { localStorage.removeItem('cc_name_at'); window.CC_ACCOUNT = ${GUEST}; document.dispatchEvent(new CustomEvent('cc:account')); return true; })()`);
  await clearTx();

  // ==========================================================================
  // TASK 8 — THE FRIENDS SCREEN AND THE PLAYER MENU
  // ==========================================================================
  // Everything is driven from an INJECTED window.CC_SOCIAL and the stubbed
  // socket Task 7 installed, so nothing here needs a database or a session.
  // What is proven: the screen renders the snapshot honestly (a NULL snapshot
  // is "not known yet", never "you have no friends"), every control sends the
  // exact frame design 4.2 names, Report and Block ask first, the menu is
  // reachable from a LOBBY SEAT and from an IN-MATCH CARD through the seat
  // HANDLE (BINDING resolution 24 — no account id is ever on the wire), and a
  // GUEST can report, block and lift a block but not add friends
  // (resolution 18).
  const FSNAP = {
    empty: `{friends:[],requests:{in:[],out:[]},blocked:[],friendCode:'ABC234',callsign:'Anvil Six'}`,
    some: `{friends:[{id:'11111111-1111-4111-8111-111111111111',callsign:'Bunker Nine',online:true},{id:'22222222-2222-4222-8222-222222222222',callsign:'Crater Two',online:false}],requests:{in:[],out:[]},blocked:[],friendCode:'ABC234',callsign:'Anvil Six'}`,
    one: `{friends:[{id:'11111111-1111-4111-8111-111111111111',callsign:'Bunker Nine',online:false}],requests:{in:[],out:[]},blocked:[],friendCode:'ABC234',callsign:'Anvil Six'}`,
    reqs: `{friends:[],requests:{in:[{id:'33333333-3333-4333-8333-333333333333',callsign:'Dune Four'}],out:[{id:'44444444-4444-4444-8444-444444444444',callsign:'Echo Five'}]},blocked:[],friendCode:'ABC234',callsign:'Anvil Six'}`,
    blocked: `{friends:[],requests:{in:[],out:[]},blocked:[{id:'55555555-5555-4555-8555-555555555555',callsign:'Rude Name'}],friendCode:'ABC234',callsign:'Anvil Six'}`,
    hostile: `{friends:[{id:'66666666-6666-4666-8666-666666666666',callsign:'<img src=x onerror=window.__pwned=1>',online:false}],requests:{in:[],out:[]},blocked:[],friendCode:'ABC234',callsign:'Anvil Six'}`,
    // callsign NULL, which server/social.js really sends: displayName returns
    // null for a name it cannot prove and for one blocklisted after it was
    // stored — the very case the report path exists for.
    noname: `{friends:[{id:'77777777-7777-4777-8777-777777777777',callsign:null,online:false}],requests:{in:[],out:[]},blocked:[],friendCode:'ABC234',callsign:'Anvil Six'}`,
  };
  const NONAME = '77777777-7777-4777-8777-777777777777';
  const BOB = '11111111-1111-4111-8111-111111111111';
  const CARA = '22222222-2222-4222-8222-222222222222';
  // snapExpr may be the string 'null' — the third state, which is the whole point.
  const arm = async (snapExpr, who = 'in', connected = true) => {
    await ev(`(() => {
      window.__tx.length = 0; window.__toast = [];
      window.showToast = (x) => { window.__toast.push(x); };
      S.ws = { readyState: ${connected ? 1 : 3}, send(s) { window.__tx.push(JSON.parse(s)); } };
      S.connected = ${connected}; S.local = false;
      window.CC_ACCOUNT = ${who === 'in' ? LINKED : who === 'guest' ? GUEST : 'null'};
      const b = $('accountBtn'); b.classList.remove('hidden'); b.dataset.state = '${who}';
      window.CC_SOCIAL = ${snapExpr};
      $('bay').classList.add('active');
      window.__tx.length = 0;
      Bay.show('home'); Bay.show('friends');
      return true;
    })()`);
    await sleep(60);
  };
  const toasts = () => ev('window.__toast.slice()');
  const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'NO ' + ${JSON.stringify(sel)}; e.click(); return true; })()`);
  // A KEYBOARD PLAYER'S click: element.click() alone does not focus anything in
  // Chrome, so focus() first — that is what tabbing to a control and pressing
  // Enter actually does, and it is the only way to test where focus goes back to.
  const clickFocus = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'NO ' + ${JSON.stringify(sel)}; e.focus(); e.click(); return true; })()`);
  const escKey = () => ev(`(() => { (document.activeElement || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
  // Answer the LAST frame matching `pred`, echoing its id exactly as the server does.
  const answer = async (pred, frame) => {
    const r = await ev(`(() => {
      const fq = window.__tx.filter(${pred});
      if (!fq.length) return 'NOTHING SENT';
      handle(Object.assign({ id: fq[fq.length - 1].id }, ${JSON.stringify(frame)}));
      return fq[fq.length - 1].id;
    })()`);
    await sleep(80); return r;
  };
  const scr = () => ev(`(() => {
    const txt = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
    return {
      scr: $('bay').dataset.scr,
      title: txt('#bay .pt'), sub: txt('#bay .ps'), meta: txt('#bay .pm'),
      lbls: [...document.querySelectorAll('#bay .lbl')].map((e) => e.textContent.trim()),
      cards: [...document.querySelectorAll('#bay .pcd .sn')].map((e) => e.textContent.trim()),
      lit: document.querySelectorAll('#bay .pdot.on').length,
      lamps: document.querySelectorAll('#bay .pdot svg').length,
      lampText: [...document.querySelectorAll('#bay .pdot')].map((e) => e.textContent).join(''),
      menus: document.querySelectorAll('#bay .pcd [data-pmenu]').length,
      notes: [...document.querySelectorAll('#bay .fnote')].map((e) => e.textContent.trim()),
      errs: [...document.querySelectorAll('#bay .ferr')].map((e) => e.textContent.trim()).filter(Boolean),
      code: txt('#bay .frcode'),
      retry: !!document.querySelector('#bay [data-fr="retry"]'),
      share: !!document.querySelector('#bay [data-fr="share"]'),
      searchOff: !!(document.querySelector('#bay [data-fr="search"]') || {}).disabled,
      signin: [...document.querySelectorAll('#bay .pbody button')].map((e) => e.textContent.trim()).filter((x) => x === 'Sign in').length,
      body: txt('#bay .pbody'),
      pwned: !!window.__pwned, img: !!document.querySelector('#bay .pcd img'),
    };
  })()`);
  const menu = () => ev(`(() => {
    const m = document.getElementById('pmenu');
    const txt = (s) => { const e = m && m.querySelector(s); return e ? e.textContent.trim() : null; };
    return {
      open: !!(m && !m.hidden),
      head: txt('.pmh'),
      items: m ? [...m.querySelectorAll('.pmi')].map((e) => e.textContent.trim()) : [],
      note: txt('.pmn'),
      err: txt('.pme'),
      acts: m ? [...m.querySelectorAll('[data-pm]')].map((e) => e.getAttribute('data-pm')) : [],
      parent: m && m.parentElement ? m.parentElement.id : null,
      focus: document.activeElement ? (document.activeElement.textContent || '').trim() : null,
      focusIn: !!(m && document.activeElement && m.contains(document.activeElement)),
    };
  })()`);
  // THE TOAST, MEASURED, not recorded. Raises a real toast through app.js's own
  // showToast and reads the pill off the page: a stub cannot fail while the
  // thing it stands for is invisible.
  const realToast = (text) => ev(`(() => {
    const host = document.getElementById('toast');
    host.innerHTML = '';
    window.__realToast(${JSON.stringify(text)});
    const t = host.lastElementChild;
    if (!t) return { none: true };
    const r = t.getBoundingClientRect();
    const hud = document.getElementById('hud-top').getBoundingClientRect();
    return {
      parent: host.parentElement ? host.parentElement.id : null,
      rects: t.getClientRects().length, parented: !!t.offsetParent,
      w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
      text: t.textContent, seen: document.body.innerText.indexOf(${JSON.stringify(text)}) >= 0,
      hudBottom: Math.round(hud.bottom),
    };
  })()`);
  // The Retry button on the unknown branches: is it there, what does it say, is
  // it live? All three change between the five states a refused read passes
  // through, and before this pass all five rendered the same bytes.
  // WHICH COLUMN a red sentence landed in. The screen has three and the error
  // has to be next to the card that was tapped: before this pass every one of
  // them wrote into the search box in column 1, and a guest — who has no column
  // 1 — got no sentence at all.
  const errCols = () => ev(`(() => {
    const cols = [...document.querySelectorAll('#bay .fcol')];
    return [...document.querySelectorAll('#bay .ferr')].filter((e) => e.textContent.trim())
      .map((e) => ({ col: cols.findIndex((c) => c.contains(e)), text: e.textContent.trim() }));
  })()`);
  const waitState = () => ev(`(() => {
    const b = [...document.querySelectorAll('#bay [data-fr="retry"]')];
    return { n: b.length, labels: b.map((e) => e.textContent.trim()), off: b.map((e) => e.disabled),
             errs: [...document.querySelectorAll('#bay .ferr')].map((e) => e.textContent.trim()).filter(Boolean),
             notes: [...document.querySelectorAll('#bay .fnote')].map((e) => e.textContent.trim()) };
  })()`);

  // ---- 24. the empty snapshot: the spec 5.5 shell, the code, the empty lines
  await arm(FSNAP.empty);
  let fv = await scr();
  if (fv.scr === 'friends' && fv.title === 'Friends' && fv.sub === 'No friends yet' && fv.code === 'FR-ABC234'
      && fv.notes.includes('No friends yet. Share your friend code, or add a friend by theirs or by callsign.')
      && fv.notes.includes('Nobody is blocked.') && fv.cards.length === 0)
    ok(`${V}: friends — an empty snapshot renders the shell, the friend code and both empty lines`);
  else fail(`${V}: friends empty ${JSON.stringify(fv)}`);
  if (fv.lbls.includes('Find a friend') && fv.lbls.includes('Add by friend code') && fv.lbls.includes('Your friend code')
      && fv.lbls.includes('Your friends · 0') && fv.lbls.includes('Blocked · 0'))
    ok(`${V}: friends — the five section headings design 5.5 names`);
  else fail(`${V}: friends headings ${JSON.stringify(fv.lbls)}`);

  // ---- 25. THE THIRD STATE. A null snapshot is NOT KNOWN YET, never "empty".
  //      Task 7 shipped this bug once on the Callsign row; the same mistake here
  //      tells a player with fifty friends that they have none.
  await arm('null');
  fv = await scr();
  if (fv.sub === 'Friends list not loaded'
      && fv.notes.includes('Not loaded yet.') && fv.retry
      && !fv.notes.includes('No friends yet. Share your friend code, or add a friend by theirs or by callsign.')
      && !fv.notes.includes('Nobody is blocked.')
      && fv.lbls.includes('Your friends') && fv.lbls.includes('Blocked')
      && !fv.lbls.includes('Your friends · 0') && fv.code === 'FR-------')
    ok(`${V}: friends — an UNKNOWN snapshot says so and never claims the lists are empty`);
  else fail(`${V}: friends unknown ${JSON.stringify(fv)}`);
  // ---- 25b. AND WHY IT IS UNKNOWN. Five states reach this screen — a read in
  //      flight, a refusal, a retry in flight, a rate limit, and a request that
  //      is never answered at all — and every one of them rendered BYTE-
  //      IDENTICAL text, because the friends callback took no argument, threw
  //      the error away and dispatched no event. 'unavailable' is not an edge
  //      case: it is what the live server answers until the phase 6 migration
  //      is applied, so this is the state EVERY linked player is in today.
  //      Each state below is asserted on the rendered page, not on a variable.
  const UNAV = 'Friends are not available right now. Try again later.';
  const SLOW = 'Too many tries. Wait a moment.';
  const DEAD = 'Not connected. Try again in a moment.';
  // (1) IN FLIGHT: socialNeed() fired on entry and has not been answered.
  let wt = await waitState();
  if (wt.n === 2 && wt.labels.join('|') === 'Loading|Loading' && wt.off.join('|') === 'true|true' && wt.errs.length === 0)
    ok(`${V}: friends refused — in flight, both unknown sections say Loading and offer no live Retry`);
  else fail(`${V}: friends in flight ${JSON.stringify(wt)}`);
  // (2) UNAVAILABLE: the server refuses. A SENTENCE, and it does not blame the
  //     player's connection for a fault on the server (Task 7's discipline).
  await answer(`(fv) => fv.type === 'friends'`, { type: 'friends', error: 'unavailable' });
  wt = await waitState();
  if (wt.errs.filter((x) => x === UNAV).length === 2 && !wt.errs.includes(DEAD)
      && wt.labels.join('|') === 'Retry|Retry' && wt.off.join('|') === 'false|false'
      && wt.notes.filter((x) => x === 'Not loaded yet.').length === 3)
    ok(`${V}: friends refused — 'unavailable' is said in words beside every unknown section, and Retry comes back`);
  else fail(`${V}: friends unavailable ${JSON.stringify(wt)}`);
  // and the false promise about a code nobody has been shown is gone with it
  fv = await scr();
  if (fv.code === 'FR-------' && !fv.notes.includes('Anyone who enters this code is added as a friend straight away.'))
    ok(`${V}: friends refused — FR------- carries no promise about entering a code that is not shown`);
  else fail(`${V}: friends code promise ${JSON.stringify(fv.notes)}`);
  // (3) RETRY TAPPED: one frame out, the old sentence gone, the button changed.
  //     Before this pass the tap changed nothing on screen, ever, on any tap.
  await clearTx();
  await click('#bay [data-fr="retry"]');
  await sleep(60);
  let fq = await calls('friends');
  wt = await waitState();
  if (fq.length === 1 && wt.errs.length === 0 && wt.labels.join('|') === 'Loading|Loading' && wt.off.join('|') === 'true|true')
    ok(`${V}: friends refused — Retry asks again AND the screen says so: the old sentence goes, the button goes Loading`);
  else fail(`${V}: retry ${JSON.stringify({ fq, wt })}`);
  // (4) SLOW_DOWN: a different refusal gets a different sentence.
  await answer(`(fv) => fv.type === 'friends'`, { type: 'friends', error: 'slow_down' });
  wt = await waitState();
  if (wt.errs.filter((x) => x === SLOW).length === 2 && !wt.errs.includes(UNAV))
    ok(`${V}: friends refused — 'slow_down' reads as a rate limit, not as the server being down`);
  else fail(`${V}: friends slow_down ${JSON.stringify(wt)}`);
  // (5) NEVER ANSWERED: the 12-second timeout is the only thing between this
  //     screen and a permanent Loading. setTimeout is intercepted rather than
  //     waited on, as in section 18b.
  await ev(`(() => { window.__t12 = null; window.__realTimeout = window.setTimeout;
    window.setTimeout = function (f, ms) { if (ms === 12000 && !window.__t12) { window.__t12 = f; return -1; } return window.__realTimeout.apply(window, arguments); };
    return true; })()`);
  await clearTx();
  await click('#bay [data-fr="retry"]');
  await sleep(60);
  const armed12 = await ev(`(() => { window.setTimeout = window.__realTimeout; return typeof window.__t12 === 'function'; })()`);
  if (armed12) await ev(`(() => { window.__t12(); return true; })()`);
  await sleep(80);
  wt = await waitState();
  // UNAV, NOT DEAD: the socket in this fixture is open, so a request that was
  // never answered is the SERVER's silence and is said in the server's words.
  if (armed12 && wt.errs.filter((x) => x === UNAV).length === 2
      && wt.labels.join('|') === 'Retry|Retry' && wt.off.join('|') === 'false|false')
    ok(`${V}: friends refused — a request that is never answered on a live socket is given up at 12000 ms and said as the server's fault, with Retry live again`);
  else fail(`${V}: friends timeout ${JSON.stringify({ armed12, wt })}`);
  // and a snapshot that finally arrives clears the sentence rather than leaving
  // it under a list that loaded
  await ev(`(() => { window.CC_SOCIAL_ERR = 'unavailable'; document.dispatchEvent(new Event('cc:social')); return true; })()`);
  await clearTx();
  await click('#bay [data-fr="retry"]');
  await answer(`(fv) => fv.type === 'friends'`, { type: 'friends', friends: [], requests: { in: [], out: [] }, blocked: [], friendCode: 'ABC234', callsign: 'Anvil Six' });
  wt = await waitState();
  if (wt.errs.length === 0 && wt.n === 0 && (await ev('window.CC_SOCIAL_ERR')) === '')
    ok(`${V}: friends refused — a snapshot that finally arrives clears the refusal that came before it`);
  else fail(`${V}: stale sentence ${JSON.stringify({ wt, err: await ev('window.CC_SOCIAL_ERR') })}`);
  // AND SO DOES A PUSH, which has no waiter behind it at all — the server sends
  // one when somebody else accepts, removes or blocks. That is why the clear
  // lives in socialSnapshot and not only in the request's callback.
  await ev(`(() => { window.CC_SOCIAL = null; window.CC_SOCIAL_ERR = 'unavailable'; document.dispatchEvent(new Event('cc:social')); return true; })()`);
  const pushed = await ev(`(() => {
    const before = { err: window.CC_SOCIAL_ERR,
                     errs: [...document.querySelectorAll('#bay .ferr')].map((e) => e.textContent.trim()).filter(Boolean).length };
    handle({ type: 'friends', friends: [], requests: { in: [], out: [] }, blocked: [], friendCode: 'ABC234', callsign: 'Anvil Six' });
    return { before, after: window.CC_SOCIAL_ERR };
  })()`);
  await sleep(60);
  wt = await waitState();
  if (pushed.before.err === 'unavailable' && pushed.before.errs === 2 && pushed.after === ''
      && wt.errs.length === 0 && wt.n === 0)
    ok(`${V}: friends refused — a snapshot that arrives as a PUSH, with no waiter, clears the refusal too`);
  else fail(`${V}: stale sentence after a push ${JSON.stringify({ pushed, wt })}`);
  // and a refusal does not outlive the ACCOUNT that asked for it. SIGNING OUT is
  // the case that proves it: the clear has to happen BEFORE the early return
  // that fires when CC_SOCIAL is already null — which is exactly the state a
  // refusal leaves behind — and a signed-out session sends no new read that
  // would clear it on the way past.
  await arm('null');
  await answer(`(fv) => fv.type === 'friends'`, { type: 'friends', error: 'unavailable' });
  const carried = await ev(`(() => {
    const before = window.CC_SOCIAL_ERR;
    window.CC_ACCOUNT = null;
    $('accountBtn').dataset.state = 'out';
    document.dispatchEvent(new CustomEvent('cc:account'));
    return { before, after: window.CC_SOCIAL_ERR,
             errs: [...document.querySelectorAll('#bay .ferr')].map((e) => e.textContent.trim()).filter(Boolean) };
  })()`);
  await sleep(60);
  if (carried.before === 'unavailable' && carried.after === '' && carried.errs.length === 0)
    ok(`${V}: friends refused — the sentence goes with the account that asked, and a sign-out takes it`);
  else fail(`${V}: refusal outlived the account ${JSON.stringify(carried)}`);
  // ---- 25c. THE LAYOUT, in the state every player is in today. The frame is
  //      430u tall and the screen already ends at 419; three new lines must not
  //      push it out.
  await arm('null');
  await answer(`(fv) => fv.type === 'friends'`, { type: 'friends', error: 'unavailable' });
  const ugeo = await ev(`(() => {
    const body = document.querySelector('#bay .pbody').getBoundingClientRect();
    const cols = document.querySelector('#bay .cols').getBoundingClientRect();
    const bay = document.querySelector('#bay');
    return { inBody: cols.bottom <= body.bottom + 1 && cols.right <= body.right + 1,
             colOverflow: [...document.querySelectorAll('#bay .fcol')].filter((e) => e.scrollHeight > e.clientHeight + 1).length,
             page: [bay.scrollWidth > bay.clientWidth, bay.scrollHeight > bay.clientHeight],
             bottom: Math.round(cols.bottom), frame: Math.round(bay.getBoundingClientRect().bottom) };
  })()`);
  if (ugeo.inBody && ugeo.colOverflow === 0 && ugeo.page[0] === false && ugeo.page[1] === false)
    ok(`${V}: friends refused — the refused screen still fits the frame (ends at ${ugeo.bottom} of ${ugeo.frame})`);
  else fail(`${V}: refused geometry ${JSON.stringify(ugeo)}`);

  // ---- 26. two friends, one lit, a drawn lamp and a menu on each
  await arm(FSNAP.some);
  fv = await scr();
  if (fv.sub === '2 friends · 1 online' && fv.cards.join('|') === 'Bunker Nine|Crater Two' && fv.lit === 1 && fv.menus === 2)
    ok(`${V}: friends — two friends, one lit, a menu on each`);
  else fail(`${V}: friends list ${JSON.stringify(fv)}`);
  if (fv.lamps === 2 && fv.lampText === '')
    ok(`${V}: friends — the presence lamp is a drawn SVG, not a character (house rule 1 rejects Geometric Shapes)`);
  else fail(`${V}: friends lamp ${JSON.stringify({ lamps: fv.lamps, text: fv.lampText })}`);
  // one friend reads "1 friend", not "1 friends"
  await arm(FSNAP.one);
  if ((await scr()).sub === '1 friend · 0 online') ok(`${V}: friends — one friend is said in the singular`);
  else fail(`${V}: friends singular ${JSON.stringify((await scr()).sub)}`);
  // a presence push lights the lamp without a whole new snapshot
  await ev(`(() => { handle({ type: 'presence', id: ${JSON.stringify(BOB)}, online: true }); return true; })()`);
  await sleep(60);
  fv = await scr();
  if (fv.lit === 1 && fv.sub === '1 friend · 1 online') ok(`${V}: friends — a presence push lights the lamp`);
  else fail(`${V}: presence ${JSON.stringify({ lit: fv.lit, sub: fv.sub })}`);

  // ---- 27. requests
  await arm(FSNAP.reqs);
  fv = await scr();
  if (fv.lbls.includes('Requests · 1') && fv.cards.includes('Dune Four')
      && fv.notes.includes('1 request waiting for an answer.'))
    ok(`${V}: friends — an incoming request gets its own section, an outgoing one gets a line`);
  else fail(`${V}: friends requests ${JSON.stringify(fv)}`);
  await click('#bay [data-fr="acc:33333333-3333-4333-8333-333333333333"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'friend' && fq[0].op === 'accept' && fq[0].from === '33333333-3333-4333-8333-333333333333')
    ok(`${V}: friends — Accept sends {friend, accept, from}`);
  else fail(`${V}: accept frame ${JSON.stringify(fq)}`);
  await clearTx();
  await click('#bay [data-fr="dec:33333333-3333-4333-8333-333333333333"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'friend' && fq[0].op === 'decline' && fq[0].from === '33333333-3333-4333-8333-333333333333')
    ok(`${V}: friends — Ignore sends {friend, decline, from}`);
  else fail(`${V}: decline frame ${JSON.stringify(fq)}`);
  // ---- 27b. AND A REFUSAL LANDS IN THE COLUMN THAT WAS TAPPED. Every one of
  //      these wrote into fr.ferr, which only the Find-a-friend box in column 1
  //      renders — so a failed Accept reported itself two columns away from the
  //      card it answered.
  await answer(`(fv) => fv.type === 'friend' && fv.op === 'decline'`, { type: 'friend', op: 'decline', error: 'no_such_request' });
  let ec = await errCols();
  if (ec.length === 1 && ec[0].col === 1 && ec[0].text === 'That request is already gone.')
    ok(`${V}: friends — a refused Ignore is said in column 2, beside the request, and nowhere else`);
  else fail(`${V}: request error column ${JSON.stringify(ec)}`);
  // and it does not follow the player back in: entering re-reads the lists, so a
  // sentence about a card that may no longer be there is cleared with them
  await ev(`(() => { Bay.show('home'); Bay.show('friends'); return true; })()`);
  await sleep(60);
  ec = await errCols();
  if (ec.length === 0) ok(`${V}: friends — leaving the screen and coming back clears the column errors with the lists`);
  else fail(`${V}: error survived re-entry ${JSON.stringify(ec)}`);

  // ---- 27c. CANCEL, FOR A REQUEST YOU SENT (op 'withdraw', the hand twin of
  //      D-BLOCK-5 J). The count line stays and each request sits beneath it
  //      as a row with Cancel and the player menu; the tap sends exactly
  //      {friend, withdraw, to}; the row leaves on the server's panel push,
  //      as an answered request does; and a refusal is said in column 2,
  //      beside the requests, in this op's own words.
  const ECHO = '44444444-4444-4444-8444-444444444444';
  const outRows = () => ev(`(() => {
    const col = document.querySelectorAll('#bay .fcol')[1];
    const note = [...col.querySelectorAll('.fnote')].find((e) => /waiting for an answer/.test(e.textContent));
    const list = col.querySelector('.frlo');
    return {
      note: note ? note.textContent.trim() : null,
      after: !!(note && list && (note.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)),
      rows: list ? [...list.querySelectorAll('.pcd')].map((c) => {
        const b = c.querySelector('[data-fr^="wd:"]');
        return { name: c.querySelector('.sn').textContent.trim(), fr: b && b.getAttribute('data-fr'), text: b && b.textContent.trim(),
                 label: b && b.getAttribute('aria-label'), off: !!(b && b.disabled), menu: !!c.querySelector('[data-pmenu]'), dot: !!c.querySelector('.pdot') };
      }) : null,
      cancels: document.querySelectorAll('#bay [data-fr^="wd:"]').length,
    };
  })()`);
  await arm(FSNAP.reqs);
  let wo = await outRows();
  if (wo.note === '1 request waiting for an answer.' && wo.after
      && JSON.stringify(wo.rows) === JSON.stringify([{ name: 'Echo Five', fr: 'wd:' + ECHO, text: 'Cancel', label: 'Cancel request to Echo Five', off: false, menu: true, dot: false }]))
    ok(`${V}: friends — a request you sent is a row under its count line, with Cancel (named for the player) and the menu`);
  else fail(`${V}: outgoing rows ${JSON.stringify(wo)}`);
  await arm(FSNAP.reqs, 'in', false);
  wo = await outRows();
  if (wo.rows && wo.rows.length === 1 && wo.rows[0].off === true) ok(`${V}: friends — with no connection Cancel is disabled`);
  else fail(`${V}: outgoing rows offline ${JSON.stringify(wo)}`);
  await arm(FSNAP.reqs);
  await click(`#bay [data-fr="wd:${ECHO}"]`);
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'friend' && fq[0].op === 'withdraw' && fq[0].to === ECHO && fq[0].id != null && Object.keys(fq[0]).sort().join() === 'id,op,to,type')
    ok(`${V}: friends — Cancel sends {friend, withdraw, to}`);
  else fail(`${V}: withdraw frame ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'friend' && fv.op === 'withdraw'`, { type: 'friend', op: 'withdraw', ok: true });
  await ev(`(() => { handle({ type: 'friends', friends: [], requests: { in: [{ id: '33333333-3333-4333-8333-333333333333', callsign: 'Dune Four' }], out: [] }, blocked: [], friendCode: 'ABC234', callsign: 'Anvil Six' }); return true; })()`);
  await sleep(60);
  wo = await outRows();
  fv = await scr();
  // NOTHING IS SAID means neither place a word could go: no column error and
  // no toast. arm() emptied the toast ledger before the tap.
  const saidToasts = await toasts();
  if (wo.cancels === 0 && wo.rows === null && wo.note === null && !fv.cards.includes('Echo Five') && fv.cards.includes('Dune Four') && (await errCols()).length === 0
      && saidToasts.length === 0)
    ok(`${V}: friends — the row and its count line leave on the panel push, the incoming request stays, and nothing is said: no column error and no toast`);
  else fail(`${V}: outgoing row after the push ${JSON.stringify({ wo, cards: fv.cards, toasts: saidToasts })}`);
  // A REQUEST TO A PLAYER WITH NO NAME. callsign null is what the server
  // sends for a name it cannot prove (FSNAP.noname), and Cancel's label then
  // names no one rather than reading "Cancel request to null".
  await arm(`{friends:[],requests:{in:[],out:[{id:'${ECHO}',callsign:null}]},blocked:[],friendCode:'ABC234',callsign:'Anvil Six'}`);
  wo = await outRows();
  if (wo.rows && wo.rows.length === 1 && wo.rows[0].fr === 'wd:' + ECHO && wo.rows[0].label === 'Cancel request to this player')
    ok(`${V}: friends — Cancel on a request to a player with no name reads "Cancel request to this player"`);
  else fail(`${V}: nameless outgoing row ${JSON.stringify(wo)}`);
  for (const [code, words] of [['no_such_request', 'That request is already gone.'], ['unavailable', 'Friends are not available right now. Try again later.']]) {
    await arm(FSNAP.reqs);
    await click(`#bay [data-fr="wd:${ECHO}"]`);
    await answer(`(fv) => fv.type === 'friend' && fv.op === 'withdraw'`, { type: 'friend', op: 'withdraw', error: code });
    ec = await errCols();
    wo = await outRows();
    if (ec.length === 1 && ec[0].col === 1 && ec[0].text === words && wo.rows && wo.rows.length === 1)
      ok(`${V}: friends — a refused Cancel (${code}) is said in column 2, beside the requests, and the row stays until the panel says otherwise`);
    else fail(`${V}: withdraw refusal ${code} ${JSON.stringify({ ec, wo })}`);
  }
  // SEVERAL SENT REQUESTS. The friends list below takes only the height left
  // over, so the sent rows are capped at two and scroll: nothing overflows the
  // frame, and at least one friend card stays in view. Measured here and, on
  // the 667x375 pass, at 812x375 too (the iPhone X class landscape).
  const MANY = `{friends:[{id:'11111111-1111-4111-8111-111111111111',callsign:'Bunker Nine',online:true},{id:'22222222-2222-4222-8222-222222222222',callsign:'Crater Two',online:false},{id:'66666666-6666-4666-8666-666666666666',callsign:'Fjord Six',online:false}],requests:{in:[{id:'33333333-3333-4333-8333-333333333333',callsign:'Dune Four'}],out:[${[1, 2, 3, 4, 5].map((n) => `{id:'4444444${n}-4444-4444-8444-444444444444',callsign:'Sent Number ${n}'}`).join(',')}]},blocked:[],friendCode:'ABC234',callsign:'Anvil Six'}`;
  const manyGeo = () => ev(`(() => {
    const body = document.querySelector('#bay .pbody').getBoundingClientRect();
    const cols = document.querySelector('#bay .cols').getBoundingClientRect();
    const bay = document.querySelector('#bay');
    const col = document.querySelectorAll('#bay .fcol')[1];
    const out = col.querySelector('.frlo'), fl = col.querySelector('.frl2'), card = out && out.querySelector('.pcd');
    const step = card ? card.getBoundingClientRect().height + parseFloat(getComputedStyle(card).marginTop) : 0;
    return { inBody: cols.bottom <= body.bottom + 1 && cols.right <= body.right + 1,
             colOverflow: [...document.querySelectorAll('#bay .fcol')].filter((e) => e.scrollHeight > e.clientHeight + 1).length,
             page: [bay.scrollWidth > bay.clientWidth, bay.scrollHeight > bay.clientHeight],
             rows: out ? out.querySelectorAll('.pcd').length : 0, scrolls: !!(out && out.scrollHeight > out.clientHeight + 1),
             outH: out ? out.getBoundingClientRect().height : -1, step, friendsH: fl ? fl.getBoundingClientRect().height : -1 };
  })()`);
  const fitsMany = (g) => g.inBody && g.colOverflow === 0 && !g.page[0] && !g.page[1] && g.rows === 5 && g.scrolls
    && g.outH <= 2 * g.step + 1 && g.friendsH >= g.step;
  await arm(MANY);
  let mg = await manyGeo();
  if (fitsMany(mg)) ok(`${V}: friends — five sent requests scroll inside two rows, nothing overflows, and the friends list keeps a card in view`);
  else fail(`${V}: five sent requests geometry ${JSON.stringify(mg)}`);
  if (V === '667x375') {
    await send('Emulation.setDeviceMetricsOverride', { width: 812, height: 375, deviceScaleFactor: 2, mobile: true });
    await arm(MANY);
    mg = await manyGeo();
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
    await arm(FSNAP.empty);
    if (fitsMany(mg)) ok('812x375: friends — five sent requests scroll inside two rows, nothing overflows, and the friends list keeps a card in view');
    else fail(`812x375: five sent requests geometry ${JSON.stringify(mg)}`);
  }

  // ---- 28. search: the frame, 0 results, 1 result, Add friend, an error
  await arm(FSNAP.empty);
  await ev(`(() => { $('frQ').value = '  Crater Two '; return true; })()`);
  await click('#bay [data-fr="search"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'friend' && fq[0].op === 'search' && fq[0].q === 'Crater Two')
    ok(`${V}: friends — Search sends {friend, search, fq}, trimmed`);
  else fail(`${V}: search frame ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'friend' && fv.op === 'search'`, { type: 'friend', op: 'search', results: [] });
  if ((await scr()).notes.includes('No player with that callsign.')) ok(`${V}: friends — a 0-result search says so`);
  else fail(`${V}: search 0 ${JSON.stringify((await scr()).notes)}`);
  await clearTx();
  await click('#bay [data-fr="search"]');
  await answer(`(fv) => fv.type === 'friend' && fv.op === 'search'`, { type: 'friend', op: 'search', results: [{ id: CARA, callsign: 'Crater Two', skin: null }] });
  fv = await scr();
  // BINDING resolution 23: a search result carries no tank, because the paint is
  // not stored. The card shows the name.
  if (fv.cards.includes('Crater Two') && fv.menus === 1 && !fv.img)
    ok(`${V}: friends — a 1-result search renders one card with its menu and NO tank (resolution 23)`);
  else fail(`${V}: search 1 ${JSON.stringify(fv)}`);
  await clearTx();
  await click(`#bay [data-fr="req:${CARA}"]`);
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'friend' && fq[0].op === 'request' && fq[0].to === CARA)
    ok(`${V}: friends — Add friend on a search result sends {friend, request, to}`);
  else fail(`${V}: request frame ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'friend' && fv.op === 'request'`, { type: 'friend', op: 'request', ok: true, state: 'requested' });
  if ((await toasts()).includes('Request sent.')) ok(`${V}: friends — a sent request is confirmed out loud`);
  else fail(`${V}: request toast ${JSON.stringify(await toasts())}`);
  await clearTx();
  await click('#bay [data-fr="search"]');
  await answer(`(fv) => fv.type === 'friend' && fv.op === 'search'`, { type: 'friend', op: 'search', error: 'slow_down' });
  if ((await scr()).errs.includes('Too many tries. Wait a moment.')) ok(`${V}: friends — slow_down is said in words`);
  else fail(`${V}: search slow_down ${JSON.stringify((await scr()).errs)}`);

  // ---- 29. add by friend code
  await arm(FSNAP.empty);
  await ev(`(() => { $('frCode').value = 'fr-abc999'; return true; })()`);
  await click('#bay [data-fr="add"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'friend' && fq[0].op === 'add' && fq[0].code === 'FR-ABC999')
    ok(`${V}: friends — Add by code upper-cases and sends {friend, add, code}`);
  else fail(`${V}: add frame ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'friend' && fv.op === 'add'`, { type: 'friend', op: 'add', error: 'no_such_code' });
  if ((await scr()).errs.includes('No player has that friend code.')) ok(`${V}: friends — no_such_code is said in words`);
  else fail(`${V}: add error ${JSON.stringify((await scr()).errs)}`);
  await clearTx();
  await click('#bay [data-fr="add"]');
  await answer(`(fv) => fv.type === 'friend' && fv.op === 'add'`, { type: 'friend', op: 'add', ok: true, friend: { id: 'x', callsign: 'Nova Ten', online: true } });
  if ((await toasts()).includes('Added Nova Ten as a friend.')) ok(`${V}: friends — a successful code add toasts the new friend`);
  else fail(`${V}: add toast ${JSON.stringify(await toasts())}`);

  // ---- 30. the menu: three items on a friend, two on a stranger
  await arm(FSNAP.some);
  await click(`#bay .pcd [data-pmenu="${BOB}"]`);
  let mm = await menu();
  if (mm.open && mm.head === 'Bunker Nine' && mm.items.join('|') === 'Report name|Block|Remove friend')
    ok(`${V}: menu — a friend card offers Report name, Block and Remove friend`);
  else fail(`${V}: friend menu ${JSON.stringify(mm)}`);
  await click('#pmenu [data-pm="close"]');
  if (!(await menu()).open) ok(`${V}: menu — Close shuts it`);
  else fail(`${V}: menu close`);
  // ---- 30b. ESCAPE, and the keyboard. Nobody was trapped before this — there
  //      is a Close button and a backdrop tap — but the only Escape in bay.js
  //      served the callsign editor, and a sheet that takes focus and never
  //      gives it back leaves a keyboard player at the top of the document.
  await clickFocus(`#bay .pcd [data-pmenu="${BOB}"]`);
  let mfoc = await menu();
  if (mfoc.open && mfoc.focusIn && mfoc.focus === 'Report name')
    ok(`${V}: menu — opening it moves the keyboard into the sheet`);
  else fail(`${V}: menu focus ${JSON.stringify({ focus: mfoc.focus, focusIn: mfoc.focusIn })}`);
  await click('#pmenu [data-pm="report"]');
  await escKey();
  mfoc = await menu();
  if (mfoc.open && mfoc.items.length === 3 && mfoc.head === 'Bunker Nine')
    ok(`${V}: menu — Escape on the confirm sheet hands the player back to the menu, exactly as Cancel does`);
  else fail(`${V}: escape from sheet ${JSON.stringify(mfoc)}`);
  await escKey();
  const shut = await ev(`(() => {
    const m = document.getElementById('pmenu'), a = document.activeElement;
    return { open: !!(m && !m.hidden), back: a ? a.getAttribute('data-pmenu') : null };
  })()`);
  if (shut.open === false && shut.back === BOB)
    ok(`${V}: menu — Escape on the menu closes it and hands the keyboard back to the card that opened it`);
  else fail(`${V}: escape close ${JSON.stringify(shut)}`);
  await arm(FSNAP.empty);
  await click('#bay [data-fr="search"]');
  await answer(`(fv) => fv.type === 'friend' && fv.op === 'search'`, { type: 'friend', op: 'search', results: [{ id: CARA, callsign: 'Crater Two' }] });
  await click(`#bay .pcd [data-pmenu="${CARA}"]`);
  mm = await menu();
  if (mm.items.join('|') === 'Report name|Block')
    ok(`${V}: menu — a stranger offers Report name and Block, and no Remove friend`);
  else fail(`${V}: stranger menu ${JSON.stringify(mm)}`);
  await click('#pmenu [data-pm="close"]');

  // ---- 31. Report asks FIRST, then thanks (design 5.5, word for word)
  await arm(FSNAP.some);
  await clickFocus(`#bay .pcd [data-pmenu="${BOB}"]`);
  await clearTx();
  await click('#pmenu [data-pm="report"]');
  mm = await menu();
  fq = await tx();
  if (fq.length === 0 && mm.head === 'Report this name' && /Bunker Nine/.test(mm.note || ''))
    ok(`${V}: report — it asks first and names the callsign; nothing is sent yet`);
  else fail(`${V}: report confirm ${JSON.stringify({ fq, mm })}`);
  // THE COPY, and what it may claim. "Every report is read." was a moderation
  // commitment nobody has signed off, on a path whose only destination today is
  // a log line and a table row; and no response interval may be invented here —
  // the privacy policy states it (Task 9).
  if (mm.note === 'Report the callsign Bunker Nine. Reports go to Abara Brothers.'
      && !/read|reviewed|within|hours|days/i.test(mm.note || ''))
    ok(`${V}: report — the sheet says where a report goes and promises nothing about what happens next`);
  else fail(`${V}: report copy ${JSON.stringify(mm.note)}`);
  // FOCUS IS IN THE SHEET, and on CANCEL — the first control, so a stray Enter
  // cannot send a report.
  if (mm.focusIn && mm.focus === 'Cancel')
    ok(`${V}: report — opening the sheet moves the keyboard into it, onto Cancel`);
  else fail(`${V}: report focus ${JSON.stringify({ focus: mm.focus, focusIn: mm.focusIn })}`);
  await click('#pmenu [data-pm="cancel"]');
  mm = await menu();
  if ((await tx()).length === 0 && mm.open && mm.items.length === 3)
    ok(`${V}: report — Cancel sends nothing and hands the player back to the menu`);
  else fail(`${V}: report cancel ${JSON.stringify({ fq: await tx(), mm })}`);
  await click('#pmenu [data-pm="report"]');
  await click('#pmenu [data-pm="ok"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'report' && fq[0].id === BOB && fq[0].handle === undefined)
    ok(`${V}: report — confirming a friends-panel card sends {report, id} with the uuid the server gave us`);
  else fail(`${V}: report frame ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'report'`, { type: 'report', ok: true });
  if ((await toasts()).includes('Reported. Thank you.') && !(await menu()).open)
    ok(`${V}: report — the answer toasts exactly "Reported. Thank you." and the sheet closes`);
  else fail(`${V}: report toast ${JSON.stringify(await toasts())}`);
  // a SENT report is a close like any other, so the keyboard goes back to the
  // card it was sent from rather than to the top of the document
  const sentBack = await ev(`(() => { const a = document.activeElement; return a ? a.getAttribute('data-pmenu') : null; })()`);
  if (sentBack === BOB) ok(`${V}: report — a sent report hands the keyboard back to the card it was sent from`);
  else fail(`${V}: report focus return ${JSON.stringify(sentBack)}`);
  // ---- 31b. AND THE TOAST IS ACTUALLY ON SCREEN. The assertion above reads a
  //      RECORDER, so it cannot fail while the toast is invisible — which is
  //      exactly what it was: #toast lived inside #game, showScreen() makes
  //      exactly one of #bay / #game active, and `.screen { display: none }`
  //      hid every confirmation the Launch Bay ever raised. Six Task 8 actions
  //      have a toast as their ONLY confirmation and two of them are the
  //      Guideline 1.2 surface. Measured on the page, from the Friends screen.
  const tbay = await realToast('Reported. Thank you.');
  if (tbay.rects > 0 && tbay.parented && tbay.w > 0 && tbay.h > 0 && tbay.seen
      && tbay.text === 'Reported. Thank you.' && tbay.parent === 'app')
    ok(`${V}: report — the real toast is painted on the Friends screen: ${tbay.w}x${tbay.h} at y=${tbay.top}, and the page text carries it`);
  else fail(`${V}: real toast on the bay ${JSON.stringify(tbay)}`);
  // and a SECOND report of the same player is told what happened, in words
  await click(`#bay .pcd [data-pmenu="${BOB}"]`);
  await click('#pmenu [data-pm="report"]');
  await click('#pmenu [data-pm="ok"]');
  await answer(`(fv) => fv.type === 'report'`, { type: 'report', error: 'already' });
  mm = await menu();
  if (mm.open && mm.err === 'You have already reported this player in the past day.')
    ok(`${V}: report — reporting the same player twice says so instead of failing silently`);
  else fail(`${V}: report already ${JSON.stringify(mm)}`);
  await click('#pmenu [data-pm="cancel"]');
  await click('#pmenu [data-pm="close"]');
  // ---- 31b-ii. A LATE ANSWER SETTLES THE SHEET IT WAS SENT FROM, OR NOTHING.
  //      The callbacks guarded with `if (!pa) return;`, which only asks whether
  //      SOME sheet is open. Cancel a slow Report, open a Block on another card,
  //      and the report's answer closed THAT sheet and raised "Reported. Thank
  //      you." over an action the player had abandoned -- or wrote the report's
  //      red sentence into it.
  await arm(FSNAP.some);
  await click(`#bay .pcd [data-pmenu="${BOB}"]`);
  await click('#pmenu [data-pm="report"]');
  await click('#pmenu [data-pm="ok"]');
  await sleep(60);
  await click('#pmenu [data-pm="cancel"]');     // the report is still in flight
  await click('#pmenu [data-pm="block"]');      // a different sheet, a different act
  const opened = await menu();
  await answer(`(fv) => fv.type === 'report'`, { type: 'report', ok: true });
  const still = await menu();
  if (opened.head === 'Block this player' && still.open && still.head === 'Block this player'
      && !still.err && !(await toasts()).includes('Reported. Thank you.'))
    ok(`${V}: report — an answer to a sheet the player cancelled does not close, settle or toast over the sheet they are reading now`);
  else fail(`${V}: stale sheet ${JSON.stringify({ opened: opened.head, still, toasts: await toasts() })}`);
  await click('#pmenu [data-pm="cancel"]');
  await click('#pmenu [data-pm="close"]');

  // ---- 31c. A PLAYER WITH NO NAME TO QUOTE. nameOf()'s placeholder was being
  //      read as the name itself — "Report the callsign No callsign to Abara
  //      Brothers." The card still SAYS No callsign, because that is what the
  //      list has to show; the sentence names the act instead.
  await arm(FSNAP.noname);
  fv = await scr();
  await click(`#bay .pcd [data-pmenu="${NONAME}"]`);
  await click('#pmenu [data-pm="report"]');
  const anonRep = (await menu()).note;
  await click('#pmenu [data-pm="cancel"]');
  await click('#pmenu [data-pm="block"]');
  const anonBlk = (await menu()).note;
  await click('#pmenu [data-pm="cancel"]');
  await click('#pmenu [data-pm="close"]');
  if (fv.cards.join('|') === 'No callsign'
      && anonRep === 'Report this player. Reports go to Abara Brothers.'
      && /^Block this player\. They will not be able to find you/.test(anonBlk || '')
      && !/No callsign/.test((anonRep || '') + (anonBlk || '')))
    ok(`${V}: report — a player the server cannot name is reported and blocked as "this player", never as "the callsign No callsign"`);
  else fail(`${V}: nameless copy ${JSON.stringify({ cards: fv.cards, anonRep, anonBlk })}`);

  // ---- 32. Block asks FIRST, and the copy claims exactly what resolution 25 allows
  await arm(FSNAP.some);
  await click(`#bay .pcd [data-pmenu="${CARA}"]`);
  await clearTx();
  await click('#pmenu [data-pm="block"]');
  mm = await menu();
  if ((await tx()).length === 0 && mm.head === 'Block this player' && /Crater Two/.test(mm.note || ''))
    ok(`${V}: block — it asks first and names the callsign; nothing is sent yet`);
  else fail(`${V}: block confirm ${JSON.stringify({ fq: await tx(), mm })}`);
  // BINDING resolution 25: a block stops them finding or contacting you. It does
  // NOT promise the two are never matched together again, and the sheet must not
  // imply that it does.
  if (/will not be able to find you or contact you/.test(mm.note || '')
      && /still be matched/.test(mm.note || '') && !/never/.test(mm.note || ''))
    ok(`${V}: block — the sheet says what a block does and states the limit (resolution 25)`);
  else fail(`${V}: block copy ${JSON.stringify(mm.note)}`);
  await click('#pmenu [data-pm="ok"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'block' && fq[0].op === 'add' && fq[0].id === CARA)
    ok(`${V}: block — confirming sends {block, add, id}`);
  else fail(`${V}: block frame ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'block' && fv.op === 'add'`, { type: 'block', op: 'add', ok: true });
  if ((await toasts()).includes('Blocked.')) ok(`${V}: block — the answer is confirmed out loud`);
  else fail(`${V}: block toast ${JSON.stringify(await toasts())}`);

  // ---- 33. Remove friend does not confirm (design 5.5 names only Report and Block)
  await arm(FSNAP.some);
  await click(`#bay .pcd [data-pmenu="${BOB}"]`);
  await clearTx();
  await click('#pmenu [data-pm="unfriend"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'friend' && fq[0].op === 'remove' && fq[0].id === BOB)
    ok(`${V}: friends — Remove friend sends {friend, remove, id} straight away`);
  else fail(`${V}: remove frame ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'friend' && fv.op === 'remove'`, { type: 'friend', op: 'remove', ok: true });
  if ((await toasts()).includes('Friend removed.') && !(await menu()).open)
    ok(`${V}: friends — a removal is confirmed out loud and the menu closes`);
  else fail(`${V}: remove toast ${JSON.stringify(await toasts())}`);

  // ---- 34. the Blocked list and Unblock
  await arm(FSNAP.blocked);
  fv = await scr();
  if (fv.lbls.includes('Blocked · 1') && fv.cards.includes('Rude Name') && fv.menus === 0)
    ok(`${V}: friends — the blocked list names them and offers no menu (you have already acted)`);
  else fail(`${V}: blocked list ${JSON.stringify(fv)}`);
  await click('#bay [data-fr="unblock:55555555-5555-4555-8555-555555555555"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'block' && fq[0].op === 'remove' && fq[0].id === '55555555-5555-4555-8555-555555555555')
    ok(`${V}: friends — Unblock sends {block, remove, id}`);
  else fail(`${V}: unblock frame ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'block' && fv.op === 'remove'`, { type: 'block', op: 'remove', ok: true });
  if ((await toasts()).includes('Unblocked.')) ok(`${V}: friends — an unblock is confirmed out loud`);
  else fail(`${V}: unblock toast ${JSON.stringify(await toasts())}`);
  // and a REFUSED unblock is said in the blocked column, not two columns away
  await click('#bay [data-fr="unblock:55555555-5555-4555-8555-555555555555"]');
  await answer(`(fv) => fv.type === 'block' && fv.op === 'remove'`, { type: 'block', op: 'remove', error: 'unavailable' });
  ec = await errCols();
  // AND IT IS SAID AS AN UNBLOCK. 'block' was passed as the error kind for
  // op:'remove', so every failure fell through to 'block._' and a player who had
  // just tapped Unblock was told "Blocking is not available right now" -- the
  // game appearing to refuse to UNDO a block, which is what every player sees
  // while the migration is unapplied and the blocks table 404s.
  const uerr = ec.filter((x) => x.text === 'Unblocking is not available right now. Try again later.');
  if (uerr.length === 1 && uerr[0].col === 2 && !ec.some((x) => x.col === 0))
    ok(`${V}: friends — a refused Unblock is said in column 3 beside the blocked card, in unblocking words, and never in the search box`);
  else fail(`${V}: unblock error column ${JSON.stringify(ec)}`);

  // ---- 35. a callsign is player input: markup in it must not become markup
  await arm(FSNAP.hostile);
  fv = await scr();
  if (!fv.pwned && fv.cards.length === 1 && fv.cards[0].indexOf('<img') === 0)
    ok(`${V}: friends — a hostile callsign renders as text, not markup`);
  else fail(`${V}: friends escaping ${JSON.stringify({ pwned: fv.pwned, cards: fv.cards })}`);

  // ---- 36. THE LOBBY SEAT — the App Review path, through the seat handle.
  //      BINDING resolution 24: the payload carries an opaque per-room handle
  //      and NEVER an account id, so the menu sends `handle` and no uuid.
  const LOB = `{type:'lobby',code:'ABCD',mode:'duel',max:3,you:0,host:0,players:[{name:'Anvil Six',skin:'olive',handle:'aaaa1111'},{name:'Bunker Nine',skin:'desert',handle:'1a2b3c4d'},{name:'Rusty Recoil',skin:'olive'}]}`;
  await arm(FSNAP.empty);
  await ev(`(() => { renderLobby(${LOB}); Bay.show('lobby'); window.__tx.length = 0; return true; })()`);
  await sleep(60);
  const seats = await ev(`(() => ({
    menus: document.querySelectorAll('#bay .seat [data-pmenu]').length,
    keys: [...document.querySelectorAll('#bay .seat [data-pmenu]')].map((e) => e.dataset.pmenu),
  }))()`);
  if (seats.menus === 1 && seats.keys.join('|') === '1a2b3c4d')
    ok(`${V}: lobby — only the OTHER seat that carries a handle gets a menu; your own seat and an accountless seat do not`);
  else fail(`${V}: lobby seat menus ${JSON.stringify(seats)}`);
  await click('#bay .seat [data-pmenu]');
  mm = await menu();
  if (mm.open && mm.head === 'Bunker Nine' && mm.items.join('|') === 'Report name|Block')
    ok(`${V}: lobby — a seat offers Report name and Block right there in the lobby`);
  else fail(`${V}: lobby menu ${JSON.stringify(mm)}`);
  await click('#pmenu [data-pm="block"]');
  await click('#pmenu [data-pm="ok"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'block' && fq[0].op === 'add' && fq[0].handle === '1a2b3c4d'
      && typeof fq[0].id === 'number')
    ok(`${V}: lobby — blocking a seat sends {block, add, handle} and no account id, with a correlation id`);
  else fail(`${V}: lobby block frame ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'block' && fv.op === 'add'`, { type: 'block', op: 'add', ok: true });
  // a handle whose room has ended answers no_such_user, and that must read as
  // "that player is no longer here" (task 6b, section 10.3) — never "no such user"
  await click('#bay .seat [data-pmenu]');
  await click('#pmenu [data-pm="report"]');
  await click('#pmenu [data-pm="ok"]');
  await answer(`(fv) => fv.type === 'report'`, { type: 'report', error: 'no_such_user' });
  mm = await menu();
  if (mm.open && mm.err === 'That player is no longer here.')
    ok(`${V}: lobby — a dead handle is explained as a player who has gone, not as "no such user"`);
  else fail(`${V}: stale handle ${JSON.stringify(mm)}`);
  await click('#pmenu [data-pm="cancel"]');

  // ---- 37. THE IN-MATCH CARD. The same handle, carried by the snapshot
  //      (task 6b follow-up F6): a name is on screen for the whole match.
  await arm(FSNAP.empty);
  const hud = await ev(`(() => {
    // ON STAGE, which this section never did. showScreen() makes exactly one of
    // #bay / #game active and hides the other outright, so without this line
    // every geometry and visibility claim below was made against a display:none
    // subtree — "the menu opens over the battlefield" asserted about a
    // battlefield that was not being displayed.
    showScreen('game');
    // A REAL snapshot through applySnapshot, not a hand-set S.handles: the line
    // under test is the one that reads m.handles, and a test that writes the
    // field itself proves nothing about it.
    try {
      applySnapshot({ type: 'start', mode: 'ffa', code: 'ABCD', world: { w: 3000, h: 1400 },
        you: 0, n: 3, turn: 0, moveBudget: 0,
        names: ['Anvil Six', 'Bunker Nine', 'Rusty Recoil'],
        skins: ['olive', 'desert', 'olive'],
        handles: ['aaaa1111', '1a2b3c4d', null],
        weapons: [{ id: 'cannon', name: 'Cannon' }], ammo: { cannon: 99 },
        terrain: new Array(200).fill(900), trees: [], hazards: [], scorch: [],
        tanks: [{ x: 300, y: 900 }, { x: 1500, y: 900 }, { x: 2600, y: 900 }],
        hp: [100, 100, 100] });
    } catch (e) { return { err: String(e) }; }
    return {
      handles: (S.handles || []).slice(),
      cards: [...document.querySelectorAll('#scoreRow .pscore')].length,
      names: [...document.querySelectorAll('#scoreRow .pname')].map((e) => e.textContent.trim()),
      menus: [...document.querySelectorAll('#scoreRow [data-pmenu]')].map((e) => e.dataset.pmenu),
      onStage: $('game').classList.contains('active'),
      // the one thing a display:none subtree can never have
      seen: [...document.querySelectorAll('#scoreRow [data-pmenu]')].filter((e) => e.getClientRects().length).length,
    };
  })()`);
  if (hud.cards === 3 && hud.names[0] === 'Anvil Six (you)' && hud.menus.join('|') === '1a2b3c4d'
      && (hud.handles || []).length === 3 && hud.handles[2] === null
      && hud.onStage === true && hud.seen === 1)
    ok(`${V}: in match — the card of the one other player with an account carries a menu, and the names are unchanged`);
  else fail(`${V}: hud cards ${JSON.stringify(hud)}`);
  // THE TOAST THAT ALREADY WORKED, and must still. It is parked back under
  // #stage for a match, so it stays clear of the HUD exactly as before the move.
  const tgame = await realToast('Reported. Thank you.');
  if (tgame.rects > 0 && tgame.parented && tgame.seen && tgame.parent === 'stage' && tgame.top >= tgame.hudBottom)
    ok(`${V}: in match — the real toast is painted over the battlefield, below the HUD (y=${tgame.top}, HUD ends ${tgame.hudBottom})`);
  else fail(`${V}: real toast in match ${JSON.stringify(tgame)}`);
  await clearTx();
  await click('#scoreRow [data-pmenu]');
  mm = await menu();
  if (mm.open && mm.items.join('|') === 'Report name|Block')
    ok(`${V}: in match — the menu opens over the battlefield with Report name and Block`);
  else fail(`${V}: hud menu ${JSON.stringify(mm)}`);
  // AND A TOAST RAISED WHILE THE SHEET IS OPEN IS NOT PAINTED BEHIND IT. #pmenu
  // carries a dimming backdrop and a blur, so "behind" is not a subtlety. The
  // comparison is only real because both layers hang off #app: #app is
  // position:fixed, which is a stacking context, and a toast on <body>'s side of
  // that boundary lost to this sheet at ANY z-index. Hit-tested, not assumed.
  const over = await ev(`(() => {
    const host = document.getElementById('toast');
    host.innerHTML = '';
    window.__realToast('Reported. Thank you.');
    const t = host.lastElementChild;
    const r = t.getBoundingClientRect();
    t.style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    t.style.pointerEvents = '';
    const m = document.getElementById('pmenu');
    return { menu: !!(m && !m.hidden), mParent: m && m.parentElement ? m.parentElement.id : null,
             top: hit ? (hit.className || hit.id || hit.tagName) : null };
  })()`);
  if (over.menu && over.mParent === 'app' && over.top === 'toast-item')
    ok(`${V}: in match — a toast raised while the player menu is open is painted in front of it, not behind the backdrop`);
  else fail(`${V}: toast under the menu ${JSON.stringify(over)}`);
  await click('#pmenu [data-pm="report"]');
  await click('#pmenu [data-pm="ok"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'report' && fq[0].handle === '1a2b3c4d' && typeof fq[0].id === 'number')
    ok(`${V}: in match — reporting sends {report, handle} and no account id`);
  else fail(`${V}: hud report frame ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'report'`, { type: 'report', ok: true });
  await ev(`(() => { $('scoreRow').innerHTML = ''; S.handles = []; S.playing = false; showScreen('home'); $('bay').classList.add('active'); return true; })()`);

  // ---- 38. A GUEST (resolution 18): report and block YES, friends NO, and the
  //      blocked list is their own to see and to lift.
  await arm('null', 'guest');
  await sleep(60);
  fq = await ev(`window.__tx.slice()`);
  fv = await scr();
  if (fv.signin >= 1 && /Sign in to add friends/.test(fv.body || '') && fv.code === null
      && fq.filter((x) => x.type === 'friends').length === 0
      && fq.filter((x) => x.type === 'block' && x.op === 'list').length === 1)
    ok(`${V}: guest — no friends panel and no friend code, but their own blocked list IS asked for`);
  else fail(`${V}: guest screen ${JSON.stringify({ fv, fq })}`);
  // ---- 38a. AND WHILE THAT READ IS OUT, THE BUTTON SAYS SO. gbNeed() set
  //      gb.asking and sent without repainting, so the screen kept rendering
  //      "Not loaded yet." over an ENABLED Retry with the request already in
  //      flight -- and gbNeed's own guard returned at once on every further tap.
  //      A guest, for whom this list is the whole screen, could tap it four
  //      times on a slow connection and see nothing change by a pixel, while a
  //      linked account in the same position watched the button read Loading.
  const inflight = await waitState();
  // NOT clearTx() here: the answer below finds the frame it is replying to by
  // reading __tx, and emptying it would leave the read unanswerable.
  const sentBefore = (await tx()).length;
  await click('#bay [data-fr="retry"]');
  await sleep(60);
  if (inflight.labels.join('|') === 'Loading' && inflight.off.join('|') === 'true' && (await tx()).length === sentBefore)
    ok(`${V}: guest — while the blocked-list read is in flight Retry reads Loading and is dead, and a tap sends nothing`);
  else fail(`${V}: guest in-flight retry ${JSON.stringify({ inflight, sentBefore, tx: await tx() })}`);
  await answer(`(fv) => fv.type === 'block' && fv.op === 'list'`, { type: 'block', op: 'list', ok: true, blocked: [{ id: '55555555-5555-4555-8555-555555555555', callsign: 'Rude Name' }] });
  fv = await scr();
  if (fv.cards.includes('Rude Name') && fv.lbls.includes('Blocked · 1'))
    ok(`${V}: guest — the blocked list is rendered from block op:'list'`);
  else fail(`${V}: guest blocked ${JSON.stringify(fv)}`);
  // M3's other half: the ONE number the export needs out of a list app.js can
  // never see. A guest is refused the friends frame for ever, so CC_SOCIAL stays
  // null and blocked_count was exported as null under a sentence in the file
  // saying the device had not loaded it -- while this screen was showing it.
  if ((await ev('window.CC_SOCIAL_BLOCKED')) === 1)
    ok(`${V}: guest — the blocked list's size is published for exportMyData, which has no snapshot to count`);
  else fail(`${V}: guest blocked count ${JSON.stringify(await ev('window.CC_SOCIAL_BLOCKED'))}`);
  await clearTx();
  await click('#bay [data-fr="unblock:55555555-5555-4555-8555-555555555555"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'block' && fq[0].op === 'remove')
    ok(`${V}: guest — a guest can lift their own block`);
  else fail(`${V}: guest unblock ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'block' && fv.op === 'remove'`, { type: 'block', op: 'remove', ok: true });
  fq = await tx();
  if (fq.filter((x) => x.type === 'block' && x.op === 'list').length === 1)
    ok(`${V}: guest — lifting a block re-reads the list, because no snapshot is ever pushed to a guest`);
  else fail(`${V}: guest re-read ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'block' && fv.op === 'list'`, { type: 'block', op: 'list', ok: true, blocked: [{ id: '55555555-5555-4555-8555-555555555555', callsign: 'Rude Name' }] });
  // ---- 38b. A GUEST'S REFUSED UNBLOCK HAS SOMEWHERE TO LAND. It wrote into
  //      fr.ferr, and a guest is never shown the column that renders it: the
  //      button was simply dead, with no sentence anywhere on the page.
  await click('#bay [data-fr="unblock:55555555-5555-4555-8555-555555555555"]');
  await answer(`(fv) => fv.type === 'block' && fv.op === 'remove'`, { type: 'block', op: 'remove', error: 'unavailable' });
  ec = await errCols();
  const gberr = ec.filter((x) => x.text === 'Unblocking is not available right now. Try again later.');
  if (gberr.length === 1 && gberr[0].col === 1)
    ok(`${V}: guest — a refused Unblock is said beside the blocked list, the only column a guest has`);
  else fail(`${V}: guest unblock error ${JSON.stringify(ec)}`);
  // and a guest can report and block from a lobby seat
  await ev(`(() => { renderLobby(${LOB}); Bay.show('lobby'); window.__tx.length = 0; return true; })()`);
  await sleep(60);
  await click('#bay .seat [data-pmenu]');
  mm = await menu();
  if (mm.open && mm.items.join('|') === 'Report name|Block')
    ok(`${V}: guest — a lobby seat menu offers Report name and Block (resolution 18)`);
  else fail(`${V}: guest seat menu ${JSON.stringify(mm)}`);
  await click('#pmenu [data-pm="report"]');
  await click('#pmenu [data-pm="ok"]');
  await sleep(60);
  fq = await tx();
  if (fq.length === 1 && fq[0].type === 'report' && fq[0].handle === '1a2b3c4d')
    ok(`${V}: guest — the report really is sent`);
  else fail(`${V}: guest report ${JSON.stringify(fq)}`);
  await answer(`(fv) => fv.type === 'report'`, { type: 'report', ok: true });

  // ---- 38c. THE ACCOUNT EVENT. refreshAccountChip() fires cc:account on boot,
  //      on every resume and on every token refresh, so anything it resets must
  //      be KEYED. Unkeyed, each event nulled the guest's blocked list AND its
  //      in-flight flag and fired another `block op:'list'` — which spends the
  //      20-a-minute friend bucket, so a resume loop could rate-limit a guest
  //      out of their own blocked list. app.js keys its own handler for exactly
  //      this reason and says so in a comment; this is the copy that did not
  //      carry the lesson.
  // back to the Friends screen — the lobby check above left the bay on 'lobby',
  // and this event only re-reads for the screen that shows the list
  await arm('null', 'guest');
  // A REAL change first — a different anonymous account on the same device.
  // That half must keep working: the list belongs to the guest who asked for it.
  const flip = await ev(`(() => {
    window.__tx.length = 0;
    window.CC_ACCOUNT = Object.assign({}, window.CC_ACCOUNT, { id: 'ffffffff-0000-4000-8000-00000000ffff' });
    document.dispatchEvent(new CustomEvent('cc:account'));
    return { asked: window.__tx.filter((f) => f.type === 'block' && f.op === 'list').length,
             cards: [...document.querySelectorAll('#bay .pcd .sn')].map((e) => e.textContent.trim()) };
  })()`);
  await sleep(60);
  const flipRead = flip.asked === 1 && flip.cards.length === 0;
  // ---- 38c-i. AND THAT READ CAN BE REFUSED, which is the guest's own half of
  //      critical 2: the third state, the sentence, and a live Retry.
  await answer(`(fv) => fv.type === 'block' && fv.op === 'list'`, { type: 'block', op: 'list', error: 'unavailable' });
  const gw = await waitState();
  if (gw.notes.includes('Not loaded yet.') && gw.errs.length === 1
      && gw.errs[0] === 'Your blocked list is not available right now. Try again later.'
      && gw.n === 1 && gw.off[0] === false)
    ok(`${V}: guest — a refused blocked-list read says what is unknown AND why, with Retry live and the old action error cleared`);
  else fail(`${V}: guest list refusal ${JSON.stringify(gw)}`);
  await clearTx();
  await click('#bay [data-fr="retry"]');
  await answer(`(fv) => fv.type === 'block' && fv.op === 'list'`, { type: 'block', op: 'list', ok: true, blocked: [{ id: '55555555-5555-4555-8555-555555555555', callsign: 'Rude Name' }] });
  await clearTx();
  const resumes = await ev(`(() => {
    document.dispatchEvent(new CustomEvent('cc:account'));
    document.dispatchEvent(new CustomEvent('cc:account'));
    document.dispatchEvent(new CustomEvent('cc:account'));
    return { asked: window.__tx.filter((f) => f.type === 'block' && f.op === 'list').length,
             cards: [...document.querySelectorAll('#bay .pcd .sn')].map((e) => e.textContent.trim()) };
  })()`);
  if (flipRead && resumes.asked === 0 && resumes.cards.join('|') === 'Rude Name')
    ok(`${V}: guest — a DIFFERENT account drops the blocked list and re-reads; three token refreshes on the SAME account re-read nothing and keep it on screen`);
  else fail(`${V}: unkeyed account reset ${JSON.stringify({ flip, resumes })}`);
  // ---- 38d. AND THE CONFIRM SHEET DOES NOT OUTLIVE THE ACCOUNT. pmPaint()
  //      renders pmAsk() whenever `pa` is set and never consults pmItems(), so
  //      a sign-out with "Report this name" open left it up over an account
  //      that no longer exists, offering a Report the server would refuse. The
  //      comment there claimed "every item goes when the account does"; the bug
  //      was that the comment was false.
  await arm(FSNAP.some);
  await click(`#bay .pcd [data-pmenu="${BOB}"]`);
  await click('#pmenu [data-pm="report"]');
  const held = await menu();
  // signed out and back in as somebody else. A brand-new id, so this is a flip
  // whatever the checks above left behind.
  const dropped = await ev(`(() => {
    window.CC_ACCOUNT = Object.assign({}, ${LINKED}, { id: '00000000-0000-4000-8000-0000000000cc' });
    document.dispatchEvent(new CustomEvent('cc:account'));
    const m = document.getElementById('pmenu');
    return { open: !!(m && !m.hidden), html: m ? m.innerHTML.length : -1 };
  })()`);
  await sleep(60);
  if (held.head === 'Report this name' && dropped.open === false && dropped.html === 0)
    ok(`${V}: the confirm sheet goes when the account does — an account change closes it instead of leaving it up`);
  else fail(`${V}: sheet outlived the account ${JSON.stringify({ held: { head: held.head, open: held.open }, dropped })}`);
  // app.js drops CC_SOCIAL on that same event, so the screen re-asks; settle it
  await answer(`(fv) => fv.type === 'friends'`, { type: 'friends', error: 'unavailable' });

  // ---- 39. SIGNED OUT: every social frame is refused, so the menu says so and
  //      sends nothing rather than offering a control that can only fail.
  await arm('null', 'out');
  await ev(`(() => { renderLobby(${LOB}); Bay.show('lobby'); window.__tx.length = 0; return true; })()`);
  await sleep(60);
  await click('#bay .seat [data-pmenu]');
  mm = await menu();
  if (mm.open && (await tx()).length === 0 && mm.items.length === 0
      && /Sign in to report or block a player\./.test(mm.note || '') && mm.acts.includes('signin'))
    ok(`${V}: signed out — the menu asks them to sign in and sends nothing`);
  else fail(`${V}: signed-out menu ${JSON.stringify({ mm, fq: await tx() })}`);
  await click('#pmenu [data-pm="close"]');

  // ---- 40. offline: the snapshot stays on screen, the controls go quiet
  await arm(FSNAP.some, 'in', false);
  fv = await scr();
  if (fv.meta === 'Needs a connection' && fv.searchOff && fv.cards.length === 2)
    ok(`${V}: offline — the last snapshot stays, the controls are disabled, the header says why`);
  else fail(`${V}: offline state ${JSON.stringify(fv)}`);
  await clearTx();
  await click('#bay [data-fr="search"]');
  await sleep(60);
  if ((await tx()).length === 0) ok(`${V}: offline — a disabled Search sends nothing`);
  else fail(`${V}: offline send ${JSON.stringify(await tx())}`);
  await click(`#bay .pcd [data-pmenu="${BOB}"]`);
  mm = await menu();
  if (mm.items.length === 0 && /Reporting and blocking go through the server/.test(mm.note || ''))
    ok(`${V}: offline — the menu says why it cannot act instead of offering buttons that do nothing`);
  else fail(`${V}: offline menu ${JSON.stringify(mm)}`);
  await click('#pmenu [data-pm="close"]');

  // ---- 40b. THE IN-PAGE OFFLINE ENGINE. A solo match swaps the socket for a
  //      stand-in whose readyState is 1, and public/room-engine.js carries no
  //      social code — so a frame sent into it vanishes and the screen waits
  //      twelve seconds for an answer that cannot come. Enter in the search
  //      field is the one path with no disabled attribute in front of it.
  await arm(FSNAP.some);
  await ev(`(() => { S.local = true; $('frQ').value = 'Crater Two'; window.__tx.length = 0;
    $('frQ').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await sleep(60);
  fv = await scr();
  if ((await tx()).length === 0 && fv.errs.includes('Not connected. Try again in a moment.'))
    ok(`${V}: offline — a solo match's in-page engine is never handed a social frame, and the field says why`);
  else fail(`${V}: solo engine ${JSON.stringify({ fq: await tx(), errs: fv.errs })}`);
  await ev(`(() => { S.local = false; return true; })()`);

  // ---- 41. Share only where the browser has Web Share; Copy always
  await arm(FSNAP.empty);
  const had = await ev(`(() => { const h = typeof navigator.share === 'function'; window.__share = navigator.share; Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); Bay.show('home'); Bay.show('friends'); return h; })()`);
  const noShare = (await scr()).share;
  await ev(`(() => { Object.defineProperty(navigator, 'share', { value: () => Promise.resolve(), configurable: true }); Bay.show('home'); Bay.show('friends'); return true; })()`);
  const yesShare = (await scr()).share;
  await ev(`(() => { Object.defineProperty(navigator, 'share', { value: window.__share, configurable: true }); return typeof had; })()`);
  if (noShare === false && yesShare === true) ok(`${V}: friends — Share appears only where Web Share exists; Copy is always there`);
  else fail(`${V}: share button ${JSON.stringify({ noShare, yesShare })}`);

  // ---- 42. the entry point: Bay controls (design 9)
  await arm(FSNAP.some);
  const entry = await ev(`(() => {
    Bay.show('settings');
    const row = [...document.querySelectorAll('#bay .row')].find((x) => x.querySelector('.rn2') && x.querySelector('.rn2').textContent === 'Friends');
    if (!row) return { row: null };
    const btn = row.querySelector('.sbtn');
    const out = { desc: row.querySelector('.rd').textContent.trim(), go: btn && btn.dataset.go, label: btn && btn.textContent.trim(),
                  heights: [...document.querySelectorAll('#bay .row')].map((x) => Math.round(x.getBoundingClientRect().height)) };
    btn.click();
    out.scr = $('bay').dataset.scr;
    return out;
  })()`);
  if (entry.go === 'friends' && entry.label === 'Open' && entry.desc === '2 friends · 1 online'
      && entry.scr === 'friends' && new Set(entry.heights).size === 1)
    ok(`${V}: entry point — Bay controls carries a Friends row that counts the friends and opens the screen`);
  else fail(`${V}: entry point ${JSON.stringify(entry)}`);

  // ---- 42b. THE SQUAD'S FRIENDS (U4; owner, 2026-10-06). The home Squad box
  //      lists the friends who are online, and only them, each with Invite;
  //      the Manage squad window behind its Manage lists EVERY friend, online
  //      first (an offline friend's invite goes by push), and the requests
  //      waiting, with Accept and a drawn Decline. Its "+ Add friend" opens
  //      this screen, and this screen's Back goes back to the window. The
  //      window's Accept and Decline send exactly the frames this screen's
  //      Accept and Ignore send.
  //      CHANGED BY V3 (owner, 2026-10-07: "Start with two big buttons"): the
  //      window's friends column is the invite sheet's Friends tab, which an
  //      empty seat's "+ Invite" opens -- so the player is put in a squad of
  //      one first -- and Back from the Friends screen returns to that sheet.
  const MIXED = `{friends:[{id:'22222222-2222-4222-8222-222222222222',callsign:'Crater Two',online:false},{id:'11111111-1111-4111-8111-111111111111',callsign:'Bunker Nine',online:true},{id:'66666666-6666-4666-8666-666666666666',callsign:'Fjord Six',online:true}],requests:{in:[{id:'33333333-3333-4333-8333-333333333333',callsign:'Dune Four'}],out:[]},blocked:[],friendCode:'ABC234',callsign:'Anvil Six'}`;
  await arm(MIXED);
  const sqf = await ev(`(() => {
    Bay.show('home');
    const rows = (sel) => [...document.querySelectorAll(sel)].map((r) => ({ name: r.querySelector('.sqmt').textContent, lit: !!r.querySelector('.pdot.on'),
      inv: !!r.querySelector('[data-sq^="invite:"]'), acc: !!r.querySelector('[data-sq^="accept:"]'), dec: !!r.querySelector('[data-sq^="decline:"] svg') }));
    const out = { box: rows('#bay .sqx .sqbf .sqfr'), head: (document.querySelector('#bay .sqx .sqbf .sqh') || {}).textContent };
    document.querySelector('#bay .sqx [data-go="squad"]').click();
    out.scr1 = $('bay').dataset.scr;
    handle({ type: 'squad', op: 'state', code: 'QK7T', leader: '00000000-0000-4000-8000-0000000000aa', mode: 'duel', tees: null, max: null, you: 0, held: true,
      members: [{ id: '00000000-0000-4000-8000-0000000000aa', rid: 'a1000000000000000000000000000000', callsign: 'Anvil Six', guest: false, online: true, ready: false, dropped: false }],
      fits: { duel: false, ffa: false, boss: true, aliens: true, golf: true } });
    const seat = document.querySelector('#bay .sqopen [data-sq="sheet:friends"]');
    if (seat) seat.click();
    out.win = rows('#sqWin-friends .sqfr[data-row^="f:"]');
    out.req = rows('#sqWin-friends .sqfr[data-row^="r:"]');
    document.querySelector('#sqWin-friends [data-go="friends"]').click();
    out.scr2 = $('bay').dataset.scr;
    document.querySelector('#bay .phead [data-back]').click();
    out.scr3 = $('bay').dataset.scr;
    out.sheet3 = !!document.getElementById('sqWin-friends');
    return out;
  })()`);
  const SQ_WIN = [['Bunker Nine', true], ['Fjord Six', true], ['Crater Two', false]];
  if (sqf && JSON.stringify(sqf.box.map((r) => [r.name, r.inv])) === '[["Bunker Nine",true],["Fjord Six",true]]' && sqf.head === 'Friends online · 2'
      && sqf.scr1 === 'squad' && JSON.stringify(sqf.win.map((r) => [r.name, r.lit])) === JSON.stringify(SQ_WIN) && sqf.win.every((r) => r.inv)
      && sqf.req.length === 1 && sqf.req[0].name === 'Dune Four' && sqf.req[0].acc && sqf.req[0].dec
      && sqf.scr2 === 'friends' && sqf.scr3 === 'squad' && sqf.sheet3)
    ok(`${V}: the box lists the friends online with Invite; the window's invite sheet lists every friend online first, with Invite, and the request; Add friend opens Friends, whose Back returns to the sheet`);
  else fail(`${V}: squad friends ${JSON.stringify(sqf)}`);
  // The same frames as this screen's own Accept and Ignore.
  const DUNE = '33333333-3333-4333-8333-333333333333';
  await ev(`(window.__tx.length = 0, true)`);
  await click(`#sqWin-friends [data-sq="decline:${DUNE}"]`); await sleep(40);
  const winDec = await calls('friend');
  await answer((f) => f.type === 'friend', { type: 'friend', op: 'decline', ok: true }); await sleep(40);
  await click(`#sqWin-friends [data-sq="accept:${DUNE}"]`); await sleep(40);
  const winAcc = (await calls('friend')).slice(1);
  await answer((f) => f.type === 'friend', { type: 'friend', op: 'accept', ok: true }); await sleep(40);
  await arm(MIXED);
  await ev(`(window.__tx.length = 0, true)`);
  await click(`#bay [data-fr="dec:${DUNE}"]`); await sleep(40);
  await click(`#bay [data-fr="acc:${DUNE}"]`); await sleep(40);
  const scrFr = await calls('friend');
  const bare = (f) => JSON.stringify({ type: f.type, op: f.op, from: f.from, keys: Object.keys(f).filter((k) => k !== 'id').sort() });
  if (winDec.length === 1 && winAcc.length === 1 && scrFr.length === 2
      && bare(winDec[0]) === bare(scrFr[0]) && bare(winAcc[0]) === bare(scrFr[1]) && winDec[0].from === DUNE && winDec[0].op === 'decline' && winAcc[0].op === 'accept')
    ok(`${V}: the window's Decline and Accept send this screen's own decline and accept frames`);
  else fail(`${V}: window request frames ${JSON.stringify({ winDec, winAcc, scrFr })}`);
  await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(40);   // V3: out of the squad 42b made

  // ---- 43. layout: the three columns end inside the page body and nothing
  //      clips, at both shipped phone shapes, with a long name and twenty blocks
  await ev(`(() => {
    const many = [];
    for (let i = 0; i < 20; i++) many.push({ id: 'b' + i, callsign: 'Blocked Number ' + i });
    window.CC_SOCIAL = { friends: [{ id: ${JSON.stringify(BOB)}, callsign: 'Wolfe Ridgebacker Longname', online: true }],
      requests: { in: [], out: [] }, blocked: many, friendCode: 'ABC234', callsign: 'Anvil Six' };
    Bay.show('home'); Bay.show('friends');
    return true;
  })()`);
  await sleep(60);
  const geo = await ev(`(() => {
    const body = document.querySelector('#bay .pbody').getBoundingClientRect();
    const cols = document.querySelector('#bay .cols').getBoundingClientRect();
    const bay = document.querySelector('#bay');
    return {
      inBody: cols.bottom <= body.bottom + 1 && cols.right <= body.right + 1,
      colOverflow: [...document.querySelectorAll('#bay .fcol')].filter((e) => e.scrollWidth > e.clientWidth + 1).length,
      clipped: [...document.querySelectorAll('#bay .frcode, #bay .lbl')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className),
      scrolls: [...document.querySelectorAll('#bay .frl')].filter((e) => e.scrollHeight > e.clientHeight + 1).length,
      pageOverflow: [bay.scrollWidth > bay.clientWidth, bay.scrollHeight > bay.clientHeight],
    };
  })()`);
  if (geo.inBody && geo.colOverflow === 0 && geo.clipped.length === 0 && geo.scrolls === 1
      && geo.pageOverflow[0] === false && geo.pageOverflow[1] === false)
    ok(`${V}: friends — a long name and twenty blocks stay inside the frame; the list scrolls, the page does not`);
  else fail(`${V}: friends geometry ${JSON.stringify(geo)}`);

  // ---- 44. the landscape keyboard: focusing a friends field lifts the frame
  //      over it, exactly as the callsign editor does.
  await arm(FSNAP.empty);
  const quiet2 = await ev(`(() => {
    const vv = { offsetTop: 0, height: window.innerHeight, _l: [],
      addEventListener(t, f) { this._l.push(f); }, removeEventListener(t, f) { this._l = this._l.filter((x) => x !== f); } };
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    $('frCode').focus();
    const host = $('bay');
    return { kbd: host.classList.contains('kbd'), lift: host.style.getPropertyValue('--kbd'),
             bottom: document.querySelector('#frbCode').getBoundingClientRect().bottom };
  })()`);
  if (!quiet2.kbd && (quiet2.lift === '' || quiet2.lift === '0px')) ok(`${V}: friends — focusing a field with no keyboard lifts nothing`);
  else fail(`${V}: friends lifted with no keyboard ${JSON.stringify(quiet2)}`);
  const lift = await ev(`(() => {
    const vv = window.visualViewport;
    vv.height = Math.round(${quiet2.bottom} - 40);
    vv._l.forEach((f) => f());
    const host = $('bay'), box = document.querySelector('#frbCode').getBoundingClientRect();
    return { kbd: host.classList.contains('kbd'), lift: parseFloat(host.style.getPropertyValue('--kbd')),
             bottom: box.bottom, top: box.top, vh: vv.height };
  })()`);
  if (lift.kbd && lift.lift > 0 && lift.bottom <= lift.vh && lift.top >= 0)
    ok(`${V}: friends — a keyboard under the Add-by-code field lifts it clear and leaves it on screen`);
  else fail(`${V}: keyboard lift ${JSON.stringify(lift)}`);
  await ev(`(() => { $('frCode').blur(); return true; })()`);
  await sleep(20);
  await ev(`(() => { Bay.show('home'); return true; })()`);
  const gone = await ev(`(() => ({ kbd: $('bay').classList.contains('kbd'), lift: $('bay').style.getPropertyValue('--kbd') }))()`);
  if (gone.kbd === false) ok(`${V}: friends — leaving the screen drops the lift`);
  else fail(`${V}: lift left behind ${JSON.stringify(gone)}`);
}

// ---- 45. BOOT KEEPS THE ONE DEFAULT (owner, 2026-10-07: names are permanent).
//      A device with no name is given one at boot and remembers it as its own;
//      a device from before build 8 that holds a ROLLED pair has that pair
//      remembered as its own default; one holding anything else (an account's
//      chosen callsign, adopted) is not handed it as its own. Reloads, so it
//      runs once, after the viewports.
{
  const boot = async (setup) => {
    await ev(`(() => { ${setup} return true; })()`);
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    for (let i = 0; i < 80; i++) { if (await ev('!!window.Bay && typeof rolledPair === "function" && !!document.querySelector("#bay .top")').catch(() => false)) break; await sleep(200); }
    return ev(`({ pt: localStorage.getItem('pt_name'), own: localStorage.getItem('cc_name_own'), name: $('nameInput').value })`);
  };
  const fresh = await boot(`localStorage.removeItem('pt_name'); localStorage.removeItem('cc_name_own');`);
  const again = await boot('');
  const old7 = await boot(`localStorage.setItem('pt_name', 'Dusty Crag'); localStorage.removeItem('cc_name_own');`);
  const chosen = await boot(`localStorage.setItem('pt_name', 'Marguerite Vale'); localStorage.removeItem('cc_name_own');`);
  if (fresh.pt && fresh.own === fresh.pt && fresh.name === fresh.pt && again.pt === fresh.pt && again.own === fresh.pt
      && old7.own === 'Dusty Crag' && old7.name === 'Dusty Crag' && chosen.own === null && chosen.name === 'Marguerite Vale')
    ok(`boot: a new device keeps its one default ('${fresh.pt}') across a reload; a build-7 device's rolled name becomes its own; an adopted chosen name does not`);
  else fail(`boot own name ${JSON.stringify({ fresh, again, old7, chosen })}`);
}

clearTimeout(watchdog);
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall social_ui checks passed');
process.exit(errors.length ? 1 : 0);
