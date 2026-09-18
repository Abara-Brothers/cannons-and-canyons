// Set callsign, in a real page: the Bay controls row that carries both Roll and
// Set, the inline field and its rules, every error sentence the design names,
// the exact frames that reach the socket, and the landscape keyboard lift.
// Headless Chrome over CDP; skips without Chrome, like the other client suites.
// The socket is a STUB and Supabase is never reached — this suite is the CLIENT
// half of the callsign message, nothing else.
//
// WHY THIS EXISTS: the Set control spans four files that only ever meet in a
// browser — index.html's legacy rack, app.js's socket, bay.js's screen and
// styles.css's design frame. No Node suite can see any of it. Five of its
// rules are invisible in ordinary play and each is one line long:
//   * a ROLLED reply carries callsign:null and must not reach setCallsign(),
//     which would rename the player "null" and push that to the cloud;
//   * accepting a CHOSEN name must not look like a roll, or the client would
//     immediately clear the uniqueness key it just paid a day's quota for;
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

const appPort = await freePort();
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${appPort}/health`); break; } catch {} await sleep(150); }
const dbg = await freePort(); const prof = join(tmpdir(), `cc-soc-${dbg}`); rmSync(prof, { recursive: true, force: true });
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
const RULE = '3–16 letters, digits or spaces. Unique. Once a day.';
const HINT = 'Friends find you by code until you choose a callsign';
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
const LINKED = `{ anonymous: false, google: true, apple: false, email: 'me@example.com', accounts: [{ provider: 'google', email: 'me@example.com' }] }`;
const GUEST = `{ anonymous: true, google: false, apple: false, email: null, accounts: [] }`;

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
  window.showToast = () => {};
  window.__soc = 0;
  if (!window.__socHooked) { window.__socHooked = 1; document.addEventListener('cc:social', () => { window.__soc++; }); }
  window.CC_SOCIAL = null;
  window.CC_ACCOUNT = ${LINKED};
  document.dispatchEvent(new CustomEvent('cc:account'));
  return true;
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
  await stubSocket();

  // 1. the row carries BOTH Roll and Set, and its height still matches every
  //    other settings row — the closed screen must be geometrically identical
  //    to the one test/layout.mjs has a baseline for.
  await ev(`(() => { Bay.show('home'); return true; })()`);
  let r = await rowInfo();
  if (r && r.btns.join('|') === 'Roll|Set' && r.acts.join('|') === 'data-roll|data-cs=open' && r.wrapped
      && new Set(r.heights).size === 1) ok(`${V}: Callsign row carries Roll and Set, and every settings row is still one height`);
  else fail(`${V}: row ${JSON.stringify(r)}`);

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
  if (r && r.desc === WAIT && r.btns.join('|') === 'Roll|Set' && r.dis.join('|') === 'false|true'
      && new Set(r.heights).size === 1)
    ok(`${V}: an unknown snapshot says "${WAIT}" and withholds Set, instead of claiming there is no callsign`);
  else fail(`${V}: unknown snapshot ${JSON.stringify(r)}`);

  // 2d. AND THE ROLL GUARD DOES NOT READ "no key" OUT OF IT EITHER. With no
  //     snapshot this client cannot know whether the account holds a name;
  //     rolling without giving the key back leaves that name reserved to an
  //     account that no longer shows it, with no way to learn it and no way to
  //     undo it. The server answers ok either way and does not touch the
  //     database when there was nothing to clear, so the safe guess is cheap.
  await clearTx();
  await ev(`(() => { Bay.show('settings'); document.querySelector('#bay [data-roll]').click(); return true; })()`);
  await sleep(80);
  t = await calls('callsign');
  if (t.length === 1 && t[0].rolled === true)
    ok(`${V}: rolling with NO snapshot still gives the key back — not knowing is not knowing there is none`);
  else fail(`${V}: unknown-snapshot roll ${JSON.stringify(t)}`);
  await reply('callsign', { ok: true, callsign: null });
  // AND THE ANSWER TO IT FABRICATES NOTHING. `CC_SOCIAL === null` means NOT KNOWN
  // YET, never "empty": inventing a snapshot here would tell the rest of the
  // session that this account has no friends, no blocks and no friend code, and
  // socialNeed() would never ask again, because a snapshot exists.
  const nofab = await ev('window.CC_SOCIAL');
  if (nofab === null) ok(`${V}: an accepted roll with no snapshot fabricates none \u2014 null still means not known yet`);
  else fail(`${V}: fabricated snapshot ${JSON.stringify(nofab)}`);
  await clearTx();
  await ev(`(() => { document.querySelector('#bay [data-roll]').click(); return true; })()`);
  await sleep(80);
  t = await calls('callsign');
  if (t.length === 0) ok(`${V}: and once one has been accepted the next Roll sends nothing — the bucket is not mashed`);
  else fail(`${V}: repeat unknown-snapshot roll ${JSON.stringify(t)}`);

  // 3. a snapshot that SAYS null is believed, and that is the difference: the
  //    row then says how friends find you, and Set is available.
  await ev(`(() => { handle(${SNAP({ callsign: null })}); return true; })()`);
  await sleep(60);
  r = await rowInfo();
  if (r && r.desc === HINT && r.dis.join('|') === 'false|false') ok(`${V}: a rolled name shows "${HINT}", with Set offered`);
  else fail(`${V}: rolled hint ${JSON.stringify(r)}`);

  // 4. Set opens the field with the rules under it
  await openEditor();
  let e = await editor();
  if (e && e.max === 16 && e.focused && e.rule === RULE && !e.bad && e.kids === 0
      && e.btns.join('|') === 'Cancel|Save' && !e.card && e.inStage)
    ok(`${V}: Set opens a focused 16-character field, the rules under it, Cancel and Save, all inside the design frame`);
  else fail(`${V}: editor ${JSON.stringify(e)}`);

  // 5. a valid name reaches the socket as exactly the Set frame, nothing more
  await clearTx();
  await save('Rusty Ridge');
  t = await tx();
  let f = t[t.length - 1];
  if (t.length === 1 && f && Object.keys(f).sort().join(',') === 'id,name,type' && f.type === 'callsign'
      && f.name === 'Rusty Ridge' && typeof f.id === 'number')
    ok(`${V}: Save sends exactly {type:'callsign', name, id} and nothing else`);
  else fail(`${V}: set frame ${JSON.stringify(t)}`);

  // 5a. ROLL STANDS DOWN WHILE THAT SET IS IN FLIGHT. A mis-tap on it hands back
  //     the very key being paid for with the day's one change, and the answer
  //     that would have confirmed the name arrives to a client that has just
  //     rolled off it.
  r = await rowInfo();
  if (r && r.dis.join('|') === 'true|false')
    ok(`${V}: Roll is disabled while a Set is in flight — a mis-tap cannot give back the name being paid for`);
  else fail(`${V}: roll during set ${JSON.stringify(r)}`);

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
    soc: window.__soc, card: !!document.querySelector('#bay .pbody .card') }; })()`);
  if (!after.open && after.name === 'Iron Bandit' && after.pt === 'Iron Bandit'
      && after.held === 'Iron Bandit' && after.desc === 'Iron Bandit' && after.soc > 0 && after.card)
    ok(`${V}: an accepted callsign closes the field, writes #nameInput, pt_name and CC_SOCIAL, fires cc:social and puts the Built by card back`);
  else fail(`${V}: accepted ${JSON.stringify(after)}`);

  // 10. accepting a chosen name must NOT look like a roll. setCallsign() fires
  //     on the way through; if CC_SOCIAL were updated after it rather than
  //     before, the client would clear the very key it just set.
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
  //      not the name held, which is exactly the shape a Roll has. If CC_SOCIAL
  //      were updated after setCallsign() rather than before, the client would
  //      hand back the key to the name it had just spent the day's quota on.
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

  // 14. Roll over a chosen name gives the key back — once, with no name field
  await clearTx();
  await ev(`(() => { Bay.show('settings'); document.querySelector('#bay [data-roll]').click(); return true; })()`);
  await sleep(80);
  t = await tx();
  f = t[0];
  if (t.length === 1 && f && Object.keys(f).sort().join(',') === 'id,rolled,type' && f.type === 'callsign' && f.rolled === true)
    ok(`${V}: Roll sends exactly {type:'callsign', rolled:true, id} — no name field`);
  else fail(`${V}: roll frame ${JSON.stringify(t)}`);
  await reply('callsign', { ok: true, callsign: null });
  const rolled = await ev(`({ held: window.CC_SOCIAL && window.CC_SOCIAL.callsign, name: $('nameInput').value })`);
  if (rolled.held === null && typeof rolled.name === 'string'
      && rolled.name.length >= 3 && rolled.name !== 'null' && rolled.name !== 'Copper Spire')
    ok(`${V}: the rolled reply (callsign:null) clears the held name without renaming the player "null"`);
  else fail(`${V}: rolled reply ${JSON.stringify(rolled)}`);
  await clearTx();
  await ev(`(() => { document.querySelector('#bay [data-roll]').click(); return true; })()`);
  await sleep(80);
  t = await tx();
  if (t.length === 0) ok(`${V}: a second Roll sends nothing — no chosen name is held, so the 3-per-minute bucket is never touched`);
  else fail(`${V}: second roll sent ${JSON.stringify(t)}`);

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

  // 15a. a roll the server REFUSES leaves the key on the books, which is the
  //      truth — the account still holds it. The next Roll asks again, rather
  //      than a name staying reserved by somebody who is no longer showing it.
  await clearTx();
  await ev(`(() => { Bay.show('settings'); document.querySelector('#bay [data-roll]').click(); return true; })()`);
  await sleep(80);
  await reply('callsign', { error: 'unavailable' });
  const kept = await ev(`window.CC_SOCIAL && window.CC_SOCIAL.callsign`);
  await ev(`(() => { document.querySelector('#bay [data-roll]').click(); return true; })()`);
  await sleep(80);
  t = await tx();
  await reply('callsign', { error: 'unavailable' });
  if (kept === 'Flint Rim' && t.filter((x) => x.rolled === true).length === 2)
    ok(`${V}: a refused Roll keeps the held name and the next Roll asks again — the key is never abandoned in silence`);
  else fail(`${V}: refused roll ${JSON.stringify({ kept, t })}`);

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
  // a snapshot carrying a NAME ends the window outright...
  await ev(`(() => { handle(${SNAP({ callsign: 'Cobalt Salvo' })}); return true; })()`);
  await sleep(60);
  // ...and so does this client rolling it away, even seconds after confirming it.
  await clearTx();
  await ev(`(() => { Bay.show('settings'); document.querySelector('#bay [data-roll]').click(); return true; })()`);
  await sleep(80);
  await reply('callsign', { ok: true, callsign: null });
  await ev(`(() => { handle(${SNAP({ callsign: null })}); return true; })()`);
  await sleep(60);
  win = await ev('window.CC_SOCIAL && window.CC_SOCIAL.callsign');
  if (win === null) ok(`${V}: this client's own Roll ends the window — a null snapshot after it is believed at once`);
  else fail(`${V}: roll did not end the window ${JSON.stringify(win)}`);

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
  if (armed && e && e.rule === 'Not connected. Try again in a moment.' && e.bad === true && t.length === 1)
    ok(`${V}: a reply that never comes is answered at 12000 ms, and the snapshot is re-asked`);
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
  //      not to the device: leaving it on the home screen while every lobby
  //      shows the rolled pair the server gives an unproven name is a mismatch
  //      that could not happen before this feature existed.
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
      && flipped.name !== 'Granite Wash' && flipped.pt === flipped.name)
    ok(`${V}: losing the account closes the open field, drops the lift and hands the chosen name back with it`);
  else fail(`${V}: account flip ${JSON.stringify({ lifted, flipped })}`);

  // 21. a guest is told the truth and is not handed a button that can only
  //     fail (BINDING resolution 2). Signing out drops the WHOLE snapshot —
  //     the friends and blocked lists belong to the account that left.
  await clearTx();
  const out = await ev(`(() => {
    window.CC_ACCOUNT = ${GUEST};
    document.dispatchEvent(new CustomEvent('cc:account'));
    return { social: window.CC_SOCIAL };
  })()`);
  await sleep(60);
  r = await rowInfo();
  t = await tx();
  if (out.social === null && r && r.desc === OUT && r.btns.join('|') === 'Roll' && r.acts.join('|') === 'data-roll'
      && new Set(r.heights).size === 1 && t.length === 0)
    ok(`${V}: a guest is told "${OUT}", is offered Roll alone, asks the server for nothing, and keeps no trace of the account that left`);
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

  // 23. and a guest's Roll is still a local roll, with no frame at all
  await ev(`(() => { document.querySelector('#bay [data-roll]').click(); return true; })()`);
  await sleep(80);
  t = await tx();
  const gname = await ev(`$('nameInput').value`);
  if (t.length === 0 && typeof gname === 'string' && gname.length >= 3 && gname !== flipped.name)
    ok(`${V}: a guest's Roll renames them on this device and sends nothing`);
  else fail(`${V}: guest roll ${JSON.stringify({ t, gname })}`);
}

cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall social_ui checks passed');
process.exit(errors.length ? 1 : 0);
