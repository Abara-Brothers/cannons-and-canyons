// The Squad box, in a real page: the slot it took over from Recent sorties,
// the bay's first tab bar, the ONE client squad read model (plan X7) and every
// state the box has before a squad is drawn -- guest, offline, not answered
// yet, a squad that has ended, a squad this tab was told about, and no squad.
// Headless Chrome over CDP; skips without Chrome like the other client suites.
// The socket is a STUB: nothing here reaches a real squad server.
//
// WHY THIS EXISTS. Most of these states are invisible in ordinary play and
// each is one line of code:
//   * `sq.known === false` means NOT ANSWERED YET. Rendering "No squad yet"
//     for an answer that never arrived is the bug this project has already
//     shipped twice (public/app.js's socialCallsign comment names both).
//   * a REFUSED resume is not an empty squad either, and its Retry must work.
//   * "your squad has ended" is only true if this device actually held one.
//   * the server PUSHES a roster with no request id whenever somebody else
//     acts; a client that only reads replies never sees a friend join.
//   * a resume sent before the socket's hello is answered for nobody.
// And two that a browser alone can show: a new data-* attribute is dead until
// it is in the one delegated closest() list, and morphChildren is POSITIONAL,
// so a tab switch that changes the node count reuses nodes across tabs.
//
// EVERY CDP CALL HAS A DEADLINE, and so does the whole run: a Chrome that
// stops answering must fail this suite loudly, never hang the pre-push hook.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  squad_ui tests -- no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));   // decoded: the path has spaces
const CDP_MS = 15000;                                           // one call
const RUN_MS = 240000;                                          // the whole suite
const errors = [];
const ok = (m) => console.log('  ok -- ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });

let srv = null, chrome = null, prof = null;
const cleanup = () => {
  try { chrome && chrome.kill(); } catch {} try { srv && srv.kill(); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
// AN INTERRUPTED RUN CLEANS UP TOO (review T8-R1-7). Under Node's default
// handlers a signal kills the process without an 'exit' event, so a Ctrl-C of
// run-all.sh or a watchdog's SIGTERM left server.js and Chrome running under
// PID 1, with the profile directory behind. Exit as a shell reports a signal.
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog =setTimeout(() => { console.error(`FAIL squad_ui overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

const appPort = await freePort();
srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { await get(`http://127.0.0.1:${appPort}/health`); break; } catch {} await sleep(150); }
const dbg = await freePort(); prof = join(tmpdir(), `cc-sq-${dbg}`); rmSync(prof, { recursive: true, force: true });
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, '--no-first-run', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 60; i++) { try { const l = await (await get(`http://127.0.0.1:${dbg}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break; } } catch {} await sleep(200); }
if (!wsUrl) { console.error('FAIL squad_ui: Chrome never offered a page to drive'); process.exit(1); }
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

const ME = '00000000-0000-4000-8000-0000000000aa';
const LINKED = `{ id: '${ME}', anonymous: false, google: true, apple: false, email: 'me@example.com', accounts: [{ provider: 'google', email: 'me@example.com' }] }`;
const GUEST  = `{ id: '00000000-0000-4000-8000-0000000000bb', anonymous: true, google: false, apple: false, email: null, accounts: [] }`;
const ACC = { in: LINKED, guest: GUEST, out: 'null' };

// The socket becomes a recorder. The real one is closed with its handlers
// detached and connect() is stubbed out, so neither its onclose nor the
// 1500 ms retry can swap a live socket back in under a check that has
// deliberately put the stub into readyState 3. The real connect() is kept,
// because one check drives the real ws.onopen on a stand-in socket.
const stubSocket = () => ev(`(() => {
  const real = S.ws;
  if (real) { try { real.onclose = null; real.onmessage = null; real.onerror = null; real.close(); } catch {} }
  window.__connect = window.__connect || connect;
  window.connect = () => {};
  window.__tx = [];
  S.ws = { readyState: 1, send(s) { window.__tx.push(JSON.parse(s)); } };
  S.connected = true; S.local = false;
  window.CC_SOCIAL = null; window.CC_SOCIAL_ERR = ''; window.CC_SOCIAL_ASKING = false;
  return true;
})()`);
const tx = () => ev('window.__tx.slice()');
const clearTx = () => ev('(window.__tx.length = 0, true)');
const squads = async () => (await tx()).filter((f) => f.type === 'squad');
const up = (on) => ev(`(S.ws.readyState = ${on ? 1 : 3}, true)`);
// Answer the LAST squad frame this page sent, the way the server would.
const reply = async (patch) => {
  const r = await ev(`(() => {
    const q = window.__tx.filter((f) => f.type === 'squad');
    const i = q.length ? q[q.length - 1].id : null;
    handle(Object.assign({ type: 'squad', id: i }, ${JSON.stringify(patch)}));
    return i;
  })()`);
  await sleep(120); return r;
};
// Answer ONE frame by its id, whatever was sent since: the checks that race two
// questions must say which one the server is answering.
const answer = async (i, patch) => { await ev(`(handle(Object.assign({ id: ${JSON.stringify(i)} }, ${JSON.stringify(patch)})), true)`); await sleep(120); };
// Exactly one frame was sent, and it is a BARE resume: no code in it.
const bare1 = (q) => q.length === 1 && q[0].op === 'resume' && !('code' in q[0]);
// A SIGN-IN STARTS A FRIENDS READ (app.js asks once per sign-in), and left
// unanswered it holds socialAsking for twelve seconds and then writes a refusal
// into the Friends tab mid-check. Settled here the way the server would, and
// the refusal wiped, so the page is left exactly as it was: no snapshot.
const setWho = (who, hidden = false) => ev(`(() => {
  const b = $('accountBtn'); b.classList.toggle('hidden', ${hidden}); b.dataset.state = ${JSON.stringify(who)};
  window.CC_ACCOUNT = ${ACC[who]}; document.dispatchEvent(new CustomEvent('cc:account'));
  for (const f of window.__tx.filter((x) => x.type === 'friends')) handle({ type: 'friends', error: 'unavailable', id: f.id });
  window.CC_SOCIAL_ERR = '';
  return true; })()`);
// ONE READER FOR THE WHOLE BOX, so no check can quietly measure something
// else. Geometry is normalised by the STAGE's own width, never by the box's,
// or a box of the wrong size would measure as the right one.
const box = () => ev(`(() => {
  Bay.show('home');
  const p = document.querySelector('#bay .pnl.sqx');
  if (!p) return null;
  const stg = document.querySelector('#bay .stage').getBoundingClientRect();
  const u = stg.width / 932, r = p.getBoundingClientRect();
  const panes = [...p.querySelectorAll('.sqp')];
  const live = panes.find((x) => !x.classList.contains('hidden')) || null;
  const i = p.querySelector('#sqCode');
  const e = live && live.querySelector('.sqe');
  return {
    geom: [Math.round((r.x - stg.x) / u), Math.round((r.y - stg.y) / u), Math.round(r.width / u), Math.round(r.height / u)],
    shape: [...p.children].map((c) => c.tagName + '.' + c.className),
    panes: panes.length, live: panes.indexOf(live),
    tabs: [...p.querySelectorAll('.sqtb')].map((t) => ({
      name: t.querySelector('.sqtn').textContent, on: t.classList.contains('on'), kids: t.children.length,
      pill: t.querySelector('.sqc').classList.contains('hidden') ? null : t.querySelector('.sqc').textContent.trim(),
      dot: !t.querySelector('.sqd').classList.contains('hidden'),
    })),
    text: live ? live.innerText.replace(/\\s+/g, ' ').trim() : '',
    err: e && !e.classList.contains('hidden') ? e.textContent : '',
    field: i ? { on: !i.disabled, val: i.value } : null,
    btns: live ? [...live.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), sq: b.getAttribute('data-sq'), go: b.getAttribute('data-go'), old: b.getAttribute('data-old'), dis: b.disabled })) : [],
    fold: i && live ? i.getBoundingClientRect().bottom <= live.getBoundingClientRect().bottom + 0.5 : null,
    over: [p.scrollWidth > p.clientWidth, p.scrollHeight > p.clientHeight],
    bayOver: (() => { const b = document.getElementById('bay'); return [b.scrollWidth > b.clientWidth, b.scrollHeight > b.clientHeight]; })(),
  };
})()`);
const click = (sel) => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);

try {
  for (const [w, h] of [[932, 430], [667, 375]]) {
    const V = `${w}x${h}`;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
    const load = async () => {
      await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
      await send('Page.bringToFront').catch(() => {});
      for (let i = 0; i < 80; i++) {
        if (await ev('!!window.Bay && typeof handle === "function" && !!document.querySelector("#bay .top")').catch(() => false)) {
          // THE ENTRANCE MUST BE OVER before anything is measured: #bay.enter
          // slides every .pnl up from below for about half a second.
          for (let k = 0; k < 40 && (await ev(`document.getElementById('bay').classList.contains('enter')`)); k++) await sleep(100);
          return true;
        }
        await sleep(200);
      }
      return false;
    };
    // A DEVICE THAT HELD A SQUAD, RELOADED: its code is in storage before boot.
    if (!(await load())) { fail(`${V}: page never became ready`); continue; }
    await ev(`(localStorage.setItem('cc_squad', 'QRST'), true)`);
    if (!(await load())) { fail(`${V}: page never became ready after a reload`); continue; }
    await stubSocket(); await setWho('in'); await clearTx();

    // ---- 0. THE BOOT'S FIRST ACCOUNT IS NOT A SWITCH AWAY FROM ANYBODY. The
    //      first cc:account that names a signed-in player must keep the code
    //      this device holds, or "your squad has ended" can never be told and
    //      a reload's resume can never take its row back from a dead socket.
    if ((await ev(`localStorage.getItem('cc_squad')`)) === 'QRST') ok(`${V}: the boot's first sign-in keeps the device's squad code`);
    else fail(`${V}: the boot's first cc:account dropped the stored code (${JSON.stringify(await ev(`localStorage.getItem('cc_squad')`))})`);

    // ---- 1. THE SLOT. The box takes over Recent sorties' geometry exactly, and
    //      it is the FIRST .pnl on home -- which is what moves test/layout.mjs's
    //      baseline (R7), so it is asserted here rather than left to that diff.
    const b1 = await box();
    if (b1 && JSON.stringify(b1.geom) === '[18,174,196,192]'
        && JSON.stringify(b1.bayOver) === '[false,false]' && JSON.stringify(b1.over) === '[false,false]'
        && (await ev(`document.querySelector('#bay .pnl').classList.contains('sqx')`)))
      ok(`${V}: the Squad box holds the left slot at 18,174 196x192u and nothing overflows`);
    else fail(`${V}: slot ${JSON.stringify(b1 && { geom: b1.geom, over: b1.over, bayOver: b1.bayOver })}`);

    // ---- 2. THE BAY'S FIRST TAB BAR. Clicked through the REAL delegated
    //      listener, never by calling sqAct(): a data-* attribute that is not in
    //      the one closest() list produces a completely dead button with no
    //      error, and a check that calls the handler directly cannot see that.
    //      Driven as a GUEST, whose pane carries the code field before any
    //      answer; a signed-in pane says "Not loaded yet." until it is answered.
    await setWho('guest');
    await ev(`(() => { const i = document.getElementById('sqCode'); if (i) i.value = 'WXYZ'; return true; })()`);
    const before = await box();
    await click('#bay [data-sq="tab:friends"]');
    const after = await box();
    if (after && after.tabs[1] && after.tabs[1].on && !after.tabs[0].on && after.live === 1)
      ok(`${V}: tapping Friends switches the tab through the delegated listener`);
    else fail(`${V}: tab tap did nothing -- is data-sq in bay.js's closest() list? ${JSON.stringify(after && after.tabs)}`);
    // morphChildren is positional: the panel's own children, and each tab's,
    // must be identical across a switch or nodes are reused across identities.
    if (before && after && JSON.stringify(before.shape) === JSON.stringify(after.shape)
        && before.panes === 2 && after.panes === 2
        && JSON.stringify(before.tabs.map((t) => t.kids)) === JSON.stringify(after.tabs.map((t) => t.kids)))
      ok(`${V}: the box keeps the same node shape across a tab switch`);
    else fail(`${V}: node shape moved ${JSON.stringify(before && [before.shape, before.panes])} -> ${JSON.stringify(after && [after.shape, after.panes])}`);
    // THE TABS NAME THEIR PANELS (review T8-R1-17): each tab controls a
    // role=tabpanel that is labelled by it, so a screen reader hears which
    // panel a tab opens.
    const wired = await ev(`[...document.querySelectorAll('#bay .sqtb')].map((t) => {
      const p = document.getElementById(t.getAttribute('aria-controls') || '');
      return !!(t.id && p && p.classList.contains('sqp') && p.getAttribute('role') === 'tabpanel' && p.getAttribute('aria-labelledby') === t.id);
    })`);
    if (JSON.stringify(wired) === '[true,true]') ok(`${V}: each tab controls a role=tabpanel pane that is labelled by it`);
    else fail(`${V}: tab/panel wiring ${JSON.stringify(wired)}`);
    // A TAB IS EASIER TO HIT THAN IT LOOKS (review T8-R1-17): the bar stays
    // 22u, but a tap 5u below it -- over the pane's own top padding, where no
    // control sits -- still lands on the tab above.
    const hit = await ev(`(() => {
      const u = document.querySelector('#bay .stage').getBoundingClientRect().width / 932;
      const bar = document.querySelector('#bay .sqt'), t = document.querySelector('#bay .sqtb[data-sq="tab:squad"]');
      if (!bar || !t) return null;
      const r = t.getBoundingClientRect(), el = document.elementFromPoint(r.x + r.width / 2, r.bottom + 5 * u);
      const tab = el && el.closest('.sqtb');
      return { bar: Math.round(bar.getBoundingClientRect().height / u), at: tab ? tab.getAttribute('data-sq') : (el && el.className) || null };
    })()`);
    if (hit && hit.bar === 22 && hit.at === 'tab:squad') ok(`${V}: the tab bar stays 22u, and a tap just below a tab still lands on it`);
    else fail(`${V}: tab hit area ${JSON.stringify(hit)}`);
    // And the code field is an INPUT, which morphNode never touches.
    const kept = await ev(`(() => { const i = document.getElementById('sqCode'); return i ? i.value : null; })()`);
    if (kept === 'WXYZ') ok(`${V}: a tab switch repaints in place and keeps what the player typed`);
    else fail(`${V}: the code field lost its value across a tab switch (${JSON.stringify(kept)})`);
    await click('#bay [data-sq="tab:squad"]');
    await ev(`(() => { const i = document.getElementById('sqCode'); if (i) i.value = ''; return true; })()`);
    await setWho('in');

    // ---- 3. GUEST (D11). The lead sentence, then the code field, then "or",
    //      then Sign in, then what signing in is for. The order is the decision:
    //      a guest is told they can play NOW, before they are sold an account.
    const G1 = 'You can play right now. Got a code from a friend? Enter it and you are in, as a guest.';
    const G2 = 'Sign in to add friends and keep your progress across devices. Your guest progress on this device comes with you when you do.';
    for (const who of ['guest', 'out']) {
      await setWho(who);
      const g = await box();
      // innerText is what a player sees, so the two buttons read in capitals:
      // .sbtn and .ghost both set text-transform:uppercase.
      const gWant = G1 + ' ENTER \u2014 or \u2014 SIGN IN ' + G2;
      if (g && g.text === gWant) ok(`${V}: ${who} -- D11's copy, in D11's order`);
      else fail(`${V}: ${who} copy ${JSON.stringify(g && g.text)}`);
      if (g && g.field && g.field.on && g.btns.some((b) => b.old === 'accountBtn' && !b.dis) && g.btns.some((b) => b.sq === 'code' && !b.dis))
        ok(`${V}: ${who} -- the code field works and Sign in taps the account button`);
      else fail(`${V}: ${who} controls ${JSON.stringify(g && { field: g.field, btns: g.btns })}`);
      // THE FIELD IS ABOVE THE FOLD. The pane scrolls (the closing sentence runs
      // past it) and that is fine, but a code field a guest has to find by
      // scrolling is the one thing D11 asks for first.
      if (g && g.fold === true && JSON.stringify(g.bayOver) === '[false,false]')
        ok(`${V}: ${who} -- the code field is inside the visible pane and #bay never scrolls`);
      else fail(`${V}: ${who} fold ${JSON.stringify(g && { fold: g.fold, bayOver: g.bayOver })}`);
    }
    // NO ACCOUNT BUTTON, NO SIGN-IN OFFER. accountChip() already drops the chip
    // when #accountBtn is hidden ("no session and no way to start one"); the box
    // must not offer a door that is not there.
    await setWho('guest', true);
    const gh = await box();
    if (gh && !gh.btns.some((b) => b.old === 'accountBtn') && gh.text.startsWith(G1) && !/sign in/i.test(gh.text))
      ok(`${V}: guest -- no Sign in offered while #accountBtn is hidden`);
    else fail(`${V}: hidden-account guest ${JSON.stringify(gh && gh.text)}`);
    // THE TABS' WIDER TARGET NEVER COVERS THE PANE'S CONTENT (review T8-R1-15).
    // The guest pane scrolls, and scrolled, its content passes under the top of
    // the pane: a tap there must reach what is drawn there, never the tab above.
    await setWho('guest');
    const cover = await ev(`(() => {
      const u = document.querySelector('#bay .stage').getBoundingClientRect().width / 932;
      const p = document.getElementById('sqPane-squad'); if (!p) return null;
      p.scrollTop = p.scrollHeight;
      const r = p.getBoundingClientRect(), hits = [];
      for (const k of [0.5, 1, 2, 3, 4]) {
        const el = document.elementFromPoint(r.x + r.width / 2, r.top + k * u);
        hits.push(el && el.closest('.sqtb') ? 'tab' : el && p.contains(el) ? 'pane' : (el && el.className) || null);
      }
      const scrolled = p.scrollTop > 0; p.scrollTop = 0;
      return { scrolled, hits };
    })()`);
    if (cover && cover.scrolled && cover.hits.every((h) => h === 'pane'))
      ok(`${V}: scrolled, the top of the pane is the pane's -- the tabs' wider target does not cover it`);
    else fail(`${V}: the tab target covers the scrolled pane ${JSON.stringify(cover)}`);
    await setWho('in');

    // ---- 4. OFFLINE (design 5.1 state 6). Every control in this box needs the
    //      socket -- the code field asks the server which KIND of code it is,
    //      Invite needs the friend graph, and signing in needs the network too.
    //      So the refusal is said once, at the top, for every kind of account:
    //      a guest offered a dead field and a dead Sign in button is the exact
    //      lie this box exists to avoid.
    for (const who of ['in', 'guest', 'out']) {
      await setWho(who); await up(false);
      const o = await box();
      if (o && o.text.startsWith('Needs a connection.') && o.field && o.field.on === false
          && o.btns.length > 0 && o.btns.every((b) => b.dis))
        ok(`${V}: offline (${who}) -- "Needs a connection", the field and every control dead`);
      else fail(`${V}: offline (${who}) ${JSON.stringify(o && { text: o.text, field: o.field, btns: o.btns })}`);
      await up(true);
    }
    // The Friends tab says the same thing, first, for the same reason.
    await up(false); await click('#bay [data-sq="tab:friends"]');
    const of = await box();
    if (of && of.text.startsWith('Needs a connection.') && of.btns.every((b) => b.dis))
      ok(`${V}: offline -- the Friends tab says "Needs a connection" too`);
    else fail(`${V}: offline friends ${JSON.stringify(of && { text: of.text, btns: of.btns })}`);
    await up(true); await click('#bay [data-sq="tab:squad"]');
    await setWho('in');

    // ---- 5. THE THIRD STATE. This is the assertion the whole task turns on:
    //      before the server has answered, the box knows NOTHING, and the only
    //      honest thing it can say is so. Two criticals have shipped on this
    //      project from exactly this confusion.
    //      AND NOTHING IS ASKED BEFORE THE HELLO. The stub socket has never been
    //      introduced, and a resume sent on it now would be answered for nobody.
    const NOSQ = 'No squad yet.';
    //      RETRY IS HELD UNTIL THE HELLO (review T8-R1-5): sqAsk refuses to ask
    //      before it, so a live Retry here was a button that did nothing when
    //      tapped. It says Loading, because the box is; the hello asks by itself.
    const w0 = await box(), q0 = await squads();
    if (w0 && w0.text.startsWith('Not loaded yet.') && !w0.text.includes(NOSQ) && q0.length === 0
        && w0.btns.some((b) => b.sq === 'retry' && b.dis && b.t === 'Loading') && w0.tabs[0].pill === null)
      ok(`${V}: before any answer the box says "Not loaded yet.", holds Retry (Loading) until the hello, and asks nothing before it`);
    else fail(`${V}: third state ${JSON.stringify(w0 && { text: w0.text, btns: w0.btns, pill: w0.tabs[0].pill, sent: q0 })}`);
    // THE CODE FIELD DOES NOT WAIT FOR THE SQUAD ANSWER (review T8-R1-2). The
    // code frame is answered from memory, before any sign-in and with the
    // social layer off, and after Task 11 this is the one field a room code
    // goes in.
    if (w0 && w0.field && w0.field.on && w0.btns.some((b) => b.sq === 'code' && !b.dis) && w0.fold === true)
      ok(`${V}: the unanswered box still offers a live code field, above the fold`);
    else fail(`${V}: unanswered code field ${JSON.stringify(w0 && { field: w0.field, btns: w0.btns, fold: w0.fold })}`);
    // The introduction: the real sendHello, which finds no session to send
    // here and marks the socket anyway. The ask follows it, once.
    const ask = async (stored) => {
      await ev(`(() => { try { ${stored ? `localStorage.setItem('cc_squad', ${JSON.stringify(stored)})` : `localStorage.removeItem('cc_squad')`}; } catch {} return true; })()`);
      await clearTx();
      await ev('sendHello(S.ws).then(() => true)');
      await sleep(60);
      return squads();
    };
    const f0 = await ask('');
    const w1 = await box();
    if (f0.length === 1 && f0[0].op === 'resume' && !('code' in f0[0]) && typeof f0[0].id === 'number'
        && w1 && w1.text.startsWith('Not loaded yet.') && w1.btns.some((b) => b.sq === 'retry' && b.dis) && w1.tabs[0].pill === null)
      ok(`${V}: once introduced the box sends one bare {type:'squad',op:'resume'} and waits, still not claiming anything`);
    else fail(`${V}: bare resume frame ${JSON.stringify(f0)} box ${JSON.stringify(w1 && { text: w1.text, btns: w1.btns, pill: w1.tabs[0].pill })}`);

    // ---- 6. THE TWO ANSWERS TO `gone`. The mock answers the SAME frame the
    //      same way whatever this device remembered, so the suite cannot be
    //      green both with and without the bug.
    await reply({ op: 'gone' });
    const n = await box();
    if (n && n.text.startsWith(NOSQ) && !n.text.includes('ended') && n.tabs[0].pill === '0 / 4')
      ok(`${V}: gone with nothing remembered is "No squad yet", and the pill is 0 / 4 (D10)`);
    else fail(`${V}: no-squad ${JSON.stringify(n && { text: n.text, pill: n.tabs[0].pill })}`);
    // A CODE THIS TAB NEVER HELD IS NOT ITS TO PRESENT (D-UI-2; review
    // T8-R1-1). Storage is shared by every tab on the device, so the code in it
    // may be one ANOTHER tab joined, and a resume that names it takes the
    // account's row off the tab in use, even off a live socket (task 5). This
    // tab has held nothing, so its next introduction asks bare, `gone` to that
    // reads "No squad yet", and the other tab's code stays where it is. A
    // reload's FIRST ask is the one that presents a stored code (check 21).
    const f1 = await ask('QRST');
    await reply({ op: 'gone' });
    const r = await box();
    const kept6 = await ev(`(() => { try { return localStorage.getItem('cc_squad'); } catch { return 'ERR'; } })()`);
    if (bare1(f1)) ok(`${V}: a code in storage this tab never held rides no resume -- a new introduction asks bare`);
    else fail(`${V}: a bystander tab presented another tab's code ${JSON.stringify(f1)}`);
    if (r && r.text.startsWith(NOSQ) && !r.text.includes('ended') && kept6 === 'QRST')
      ok(`${V}: \`gone\` to that bare question is "No squad yet", and the other tab's code is not spent`);
    else fail(`${V}: bystander gone ${JSON.stringify(r && r.text)} held=${JSON.stringify(kept6)}`);
    await ask(''); await reply({ op: 'gone' });
    const answered = await squads();           // since ask() cleared: the one resume, and nothing its answer set off
    // IDEMPOTENCE. An answer, a presence push or any other repaint must not
    // re-ask a question this socket has already had answered.
    await clearTx();
    await ev(`(() => { for (const t of ['cc:social', 'cc:social', 'cc:squad', 'cc:squad']) document.dispatchEvent(new Event(t)); return true; })()`);
    await sleep(60);
    const quiet = await squads();
    if (answered.length === 1 && quiet.length === 0) ok(`${V}: neither the answer nor a repaint re-asks a question this socket has had answered`);
    else fail(`${V}: sqNeed re-asked: one question sent ${answered.length} resume frame(s), want 1; a repaint sent ${quiet.length}`);
    // A HELLO THAT LANDS WHILE AN ASK IS OUT (review T8-R1-3, both rounds). The
    // new introduction asks AT ONCE: the ask still out belongs to the old one,
    // whose answer is about an identity the socket no longer has -- or, after a
    // blip, about a dead socket, and then it is only the twelve-second timeout
    // (check 10c). When that old answer comes, the box does not use it.
    const h1 = await ask('');                                   // introduction 1: its resume is out
    await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    const h2 = await squads();                                  // introduction 2 asks at once
    await clearTx();
    await answer(h1[0] && h1[0].id, { type: 'squad', error: 'unavailable' });
    const h3 = await squads(), hb = await box();                // the old answer: nothing set off, nothing said
    await reply({ op: 'gone' });
    if (h1.length === 1 && h2.length === 2 && h2[1].op === 'resume' && h3.length === 0
        && hb && hb.text.startsWith(NOSQ) && hb.err === '')
      ok(`${V}: a hello that lands while a resume is out asks at once, and the old question's answer is not used`);
    else fail(`${V}: hello during an ask: first ${JSON.stringify(h1)}, during ${JSON.stringify(h2)}, after the old answer ${JSON.stringify(h3)} box ${JSON.stringify(hb && { text: hb.text, err: hb.err })}`);

    // ---- 7. A REFUSAL. On the live build every linked player meets this path
    //      until the phase 6 migration is applied, so it is the shipped state,
    //      not an edge case.
    await ask(''); await reply({ error: 'unavailable' });
    const x = await box();
    if (x && x.text.startsWith('Not loaded yet.') && !x.text.includes(NOSQ)
        && x.err === 'Squads are not available right now. Try again later.'
        && x.btns.some((b) => b.sq === 'retry' && !b.dis) && x.tabs[0].pill === null)
      ok(`${V}: a refused resume says so, keeps the pill empty, and offers a live Retry`);
    else fail(`${V}: refusal ${JSON.stringify(x && { text: x.text, err: x.err, pill: x.tabs[0].pill, btns: x.btns })}`);
    // A REFUSED RESUME KEEPS THE CODE FIELD (review T8-R1-2): while squads are
    // refused -- every linked player on the live build -- a room code must
    // still join from the box, as it did in any outage before this project.
    if (x && x.field && x.field.on && x.btns.some((b) => b.sq === 'code' && !b.dis) && x.fold === true)
      ok(`${V}: a refused resume still offers a live code field, above the fold`);
    else fail(`${V}: refused code field ${JSON.stringify(x && { field: x.field, btns: x.btns, fold: x.fold })}`);
    // A refusal is Retry's to clear: a repaint does not re-ask a server saying no.
    await clearTx();
    await ev(`(() => { document.dispatchEvent(new Event('cc:social')); return true; })()`);
    await sleep(60);
    const still = await squads();
    // What the player has typed must outlive the answer Retry brings back.
    await ev(`(() => { const i = document.getElementById('sqCode'); if (i) i.value = 'MNPQ'; return true; })()`);
    // AND RETRY REALLY RE-ASKS. Clicked through the real listener.
    await click('#bay [data-sq="retry"]');
    await sleep(60);
    const again = await squads();
    // WHILE RETRY'S QUESTION IS OUT THE BOX KNOWS NOTHING (review T8-R1-6):
    // Retry drops the old answer along with the refusal, so the wait reads
    // "Not loaded yet." and never "No squad yet".
    const inflight = await box();
    if (still.length === 0 && again.length === 1 && again[0].op === 'resume') ok(`${V}: Retry clears the refusal and asks again; a repaint does not`);
    else fail(`${V}: Retry sent ${JSON.stringify(again)} (a repaint sent ${still.length})`);
    if (inflight && inflight.text.startsWith('Not loaded yet.') && !inflight.text.includes(NOSQ))
      ok(`${V}: while Retry's question is out the box says "Not loaded yet.", not "No squad yet"`);
    else fail(`${V}: Retry in flight ${JSON.stringify(inflight && inflight.text)}`);
    await reply({ op: 'gone' });
    // THE ANSWER REPAINTS IN PLACE: the code field sits at the same place in
    // the pane before and after it, so morphChildren keeps the node and the
    // player's typing (morphNode never touches an INPUT's value).
    const kept7 = await ev(`(() => { const i = document.getElementById('sqCode'); return i ? i.value : null; })()`);
    if (kept7 === 'MNPQ') ok(`${V}: the answer to Retry repaints the box and keeps what was typed in the code field`);
    else fail(`${V}: the answer dropped the typed code (${JSON.stringify(kept7)})`);
    await ev(`(() => { const i = document.getElementById('sqCode'); if (i) i.value = ''; return true; })()`);

    // ---- 7b. EVERY REFUSAL OF A RESUME SAYS ITS OWN DECIDED SENTENCE (review
    //       T8-R1-12), and AN OP THIS BUILD DOES NOT KNOW IS NOT AN EMPTY SQUAD
    //       (review T8-R1-10): a newer server's answer reads as a refusal, with
    //       Retry, never as "No squad yet" -- the null-is-not-empty bug again.
    const SQ_UNAV = 'Squads are not available right now. Try again later.';
    for (const [ans7, line] of [
      [{ error: 'slow_down' }, 'Too many tries. Wait a moment.'],
      [{ error: 'offline' }, 'Not connected. Try again in a moment.'],
      [{ error: 'unavailable' }, SQ_UNAV],
      [{ error: 'not_a_code_this_build_knows' }, SQ_UNAV],
      [{ op: 'not_an_op_this_build_knows' }, SQ_UNAV],
    ]) {
      // Each row starts from a clean answer: a refusal left standing by the row
      // before would pass for this row's own.
      await ask(''); await reply({ op: 'gone' });
      await ask(''); await reply(ans7);
      const y = await box();
      if (y && y.text.startsWith('Not loaded yet.') && !y.text.includes(NOSQ) && y.err === line
          && y.btns.some((b) => b.sq === 'retry' && !b.dis) && y.tabs[0].pill === null)
        ok(`${V}: a resume answered ${JSON.stringify(ans7)} says "${line}", keeps the pill empty and offers Retry`);
      else fail(`${V}: resume answered ${JSON.stringify(ans7)} ${JSON.stringify(y && { text: y.text, err: y.err, pill: y.tabs[0].pill, btns: y.btns })}`);
    }

    // ---- 8. A SQUAD THIS CLIENT HAS BEEN TOLD ABOUT must never read "No squad
    //      yet", and it lives in ONE slot (plan X7): window.CC_SQUAD.
    const M = (over) => Object.assign({ id: null, callsign: null, guest: false, online: true, ready: false, dropped: false }, over);
    const SNAP = { op: 'state', code: 'BKPQ', leader: ME, mode: 'duel', tees: null, max: null, you: 0,
      members: [M({ id: ME, callsign: 'Dusty Crag' }), M({ guest: true })],
      fits: { duel: true, ffa: false, boss: true, aliens: true, golf: true } };
    const stored = () => ev(`(() => { try { return localStorage.getItem('cc_squad'); } catch { return 'ERR'; } })()`);
    const slot = () => ev('window.CC_SQUAD && { code: window.CC_SQUAD.code, n: window.CC_SQUAD.members.length }');
    await ask(''); await reply(SNAP);
    const s = await box();
    if (s && !s.text.includes(NOSQ) && !s.text.includes('ended') && !s.text.includes('Not loaded yet')
        && s.text.includes('BKPQ') && s.tabs[0].pill === '2 / 4' && (await stored()) === 'BKPQ'
        && JSON.stringify(await slot()) === '{"code":"BKPQ","n":2}')
      ok(`${V}: a snapshot renders as a squad, pills 2 / 4, lands in window.CC_SQUAD and is remembered`);
    else fail(`${V}: snapshot ${JSON.stringify(s && { text: s.text, pill: s.tabs[0].pill })} held=${JSON.stringify(await stored())} slot=${JSON.stringify(await slot())}`);

    // ---- 9. PUSHES (plan X7). The server sends the roster with NO request id
    //      when somebody else acts, and app.js's socialReply used to drop every
    //      id-less frame. A box that only reads its own answers never sees a
    //      friend join.
    const push = async (patch) => { await ev(`(handle(Object.assign({ type: 'squad' }, ${JSON.stringify(patch)})), true)`); await sleep(80); };
    const THIRD = M({ id: '00000000-0000-4000-8000-0000000000cc', callsign: 'Steel Mule' });
    await push({ ...SNAP, members: [...SNAP.members, THIRD] });
    const p1 = await box();
    if (p1 && p1.tabs[0].pill === '3 / 4' && p1.text.includes('Steel Mule') && JSON.stringify(await slot()) === '{"code":"BKPQ","n":3}')
      ok(`${V}: an id-less roster push reaches the slot and repaints the box (3 / 4)`);
    else fail(`${V}: roster push ${JSON.stringify(p1 && { text: p1.text, pill: p1.tabs[0].pill })} slot=${JSON.stringify(await slot())}`);
    // NOT OURS: `you` -1 (a join answered after its player was kicked) and a
    // roster whose own row names another account are never written.
    await push({ ...SNAP, code: 'ZZZZ', you: -1 });
    await push({ ...SNAP, code: 'YYYY', members: [THIRD, M({ guest: true })] });
    if (JSON.stringify(await slot()) === '{"code":"BKPQ","n":3}' && (await stored()) === 'BKPQ')
      ok(`${V}: a roster this socket is not in, or that names another account as us, is ignored`);
    else fail(`${V}: a foreign roster was written: slot=${JSON.stringify(await slot())} held=${JSON.stringify(await stored())}`);
    // THE SAME ACCOUNT AGAIN IS NOT A SWITCH (review T8-R1-4). app.js's
    // refreshAccountChip fires cc:account on boot, on every resume and on every
    // token refresh; a squad in hand must survive all of them.
    await clearTx();
    await ev(`(document.dispatchEvent(new CustomEvent('cc:account')), true)`); await sleep(60);
    const same = await box();
    if (JSON.stringify(await slot()) === '{"code":"BKPQ","n":3}' && same && same.text.includes('BKPQ') && same.tabs[0].pill === '3 / 4'
        && (await squads()).length === 0)
      ok(`${V}: cc:account for the account already signed in keeps the squad and asks nothing`);
    else fail(`${V}: same-account cc:account ${JSON.stringify(same && { text: same.text, pill: same.tabs[0].pill })} slot=${JSON.stringify(await slot())} sent=${JSON.stringify(await squads())}`);

    // ---- 10. A RECONNECT, through the REAL ws.onopen. A member whose socket
    //      blips is dropped and removed a minute later unless the new socket
    //      resumes (task 5) -- from whatever screen the player is on -- and
    //      that resume must go out AFTER the socket's hello, or the server
    //      answers it for nobody. onopen dispatches cc:social first and reads
    //      the hello's token asynchronously, so the token is held back here
    //      until the check has looked.
    const reconnect = () => ev(`(() => {
      window.__tx.length = 0;
      S.ws.readyState = 3;
      const Real = window.WebSocket;
      window.WebSocket = function () { this.readyState = 0; this.send = (s) => window.__tx.push(JSON.parse(s)); this.close = () => {}; };
      try { window.__connect(); } finally { window.WebSocket = Real; }
      window.__realToken = window.__realToken || Cloud.token;
      Cloud.token = () => new Promise((r) => { window.__tok = r; });
      S.ws.readyState = 1; S.ws.onopen();
      return true; })()`);
    const token = async () => { await ev(`(window.__tok('tok-1'), Cloud.token = window.__realToken, true)`); await sleep(80); };
    const settleFriends = () => ev(`(() => { for (const f of window.__tx.filter((x) => x.type === 'friends')) handle({ type: 'friends', error: 'unavailable', id: f.id }); window.CC_SOCIAL_ERR = ''; return true; })()`);
    // Back to this tab: what the browser fires when a tab or app returns.
    const focus = async () => { await ev(`(window.dispatchEvent(new Event('focus')), window.dispatchEvent(new Event('visibilitychange')), true)`); await sleep(60); };
    await push(SNAP);
    await ev(`(Bay.go('career'), true)`);
    await reconnect(); await sleep(60);
    const early = await tx();
    await token();
    const seq = await tx();
    const hi = seq.findIndex((f) => f.type === 'hello'), rs = seq.filter((f) => f.type === 'squad');
    const ri = seq.findIndex((f) => f.type === 'squad');
    if (!early.some((f) => f.type === 'squad') && hi >= 0 && ri > hi && rs.length === 1 && rs[0].op === 'resume' && rs[0].code === 'BKPQ')
      ok(`${V}: a reconnect resumes with the remembered code, from any screen, and only after the hello`);
    else fail(`${V}: reconnect sent ${JSON.stringify(early.map((f) => f.type))} then ${JSON.stringify(seq.map((f) => f.type + (f.op ? ':' + f.op : '') + (f.code ? ':' + f.code : '')))}`);
    // The squad stays on screen while the new socket asks: known outlives it.
    const kb = await box();
    if (kb && kb.text.includes('BKPQ')) ok(`${V}: the box keeps the squad on screen while a reconnect asks again`);
    else fail(`${V}: reconnect blanked the box ${JSON.stringify(kb && kb.text)}`);
    await reply(SNAP); await settleFriends();
    // A RECONNECT'S RESUME REFUSED. The row the blip dropped comes back only
    // through a resume, so the refusal is said under the squad with a live
    // Retry: a squad shown as if nothing were wrong is swept from under the
    // player a minute later (task 5).
    await reconnect(); await token();
    await reply({ error: 'unavailable' }); await settleFriends();
    const kr = await box();
    await clearTx(); await click('#bay [data-sq="retry"]'); await sleep(60);
    const kq = await squads();
    await reply(SNAP);
    const kk = await box();
    if (kr && kr.text.includes('BKPQ') && kr.err === 'Squads are not available right now. Try again later.'
        && kr.btns.some((b) => b.sq === 'retry' && !b.dis) && kr.tabs[0].pill === '2 / 4'
        && kq.length === 1 && kq[0].op === 'resume' && kq[0].code === 'BKPQ'
        && kk && kk.text.includes('BKPQ') && kk.err === '' && !kk.btns.some((b) => b.sq === 'retry'))
      ok(`${V}: a refused reconnect resume is said under the squad, and its Retry asks again by code`);
    else fail(`${V}: refused reconnect ${JSON.stringify({ kr: kr && { text: kr.text, err: kr.err, btns: kr.btns, pill: kr.tabs[0].pill }, kq, kk: kk && { text: kk.text, err: kk.err, btns: kk.btns } })}`);
    // THE CODE FIELD STAYS UNDER A SQUAD WHOSE RE-ASK WAS REFUSED (D-UI-2;
    // review T8-R1-5): #sqCode is the one code field (X8), and a room code
    // needs no squad.
    if (kr && kr.field && kr.field.on && kr.btns.some((b) => b.sq === 'code' && !b.dis) && kr.fold === true)
      ok(`${V}: a squad whose re-ask was refused still offers a live code field, above the fold`);
    else fail(`${V}: refused re-ask under a squad: code field ${JSON.stringify(kr && { field: kr.field, btns: kr.btns, fold: kr.fold })}`);

    // ---- 10b. A LATE HELLO FROM A REPLACED SOCKET (review T8-R1-9). The token
    //       read is async, so the old socket's sendHello can finish after the
    //       new socket's. Its mark must not land: the new socket would read as
    //       never introduced, and every later ask on it -- Retry after a
    //       refusal, a return to the tab -- would be refused for good.
    await ev(`(Cloud.token = () => new Promise((r) => { window.__tokOld = r; }), window.__helloOld = sendHello(S.ws), true)`);
    await reconnect();                                          // the new socket's own token read is held too
    await token();                                              // the new socket's hello lands first, and asks
    const lh1 = (await tx()).filter((f) => f.type === 'squad');
    await ev(`(window.__tokOld('tok-0'), window.__helloOld.then(() => true))`); await sleep(60);
    await reply({ error: 'unavailable' }); await settleFriends();
    const lhb = await box();
    await clearTx(); await click('#bay [data-sq="retry"]'); await sleep(60);
    const lh2 = await squads();
    await reply(SNAP);
    if (lh1.length === 1 && lh1[0].op === 'resume' && lhb && lhb.btns.some((b) => b.sq === 'retry' && !b.dis && b.t === 'Retry')
        && lh2.length === 1 && lh2[0].op === 'resume')
      ok(`${V}: a replaced socket's late hello leaves the new socket introduced: Retry stays live and asks on it`);
    else fail(`${V}: late old hello ${JSON.stringify({ lh1, retry: lhb && lhb.btns, lh2 })}`);

    // ---- 10c. A RESUME OUT WHEN THE SOCKET DIES (review T8-R1-3). A return to
    //       the tab asks, and the socket blips before the answer. That answer
    //       never comes: socialSend keeps the waiter until its twelve-second
    //       timeout, which then reports 'unavailable' because the NEW socket is
    //       up. The new socket's resume goes right after its hello, not after
    //       that timeout, and the timeout's error is not said.
    await push({ op: 'ended', reason: 'elsewhere' });           // so a return asks
    await clearTx(); await focus();
    const d1 = await squads();                                  // the return's resume, never to be answered
    await reconnect(); await token();
    const dseq = await tx(), d2 = dseq.filter((f) => f.type === 'squad');
    const dh = dseq.findIndex((f) => f.type === 'hello'), ds = dseq.findIndex((f) => f.type === 'squad');
    await answer(d1[0] && d1[0].id, { type: 'squad', error: 'unavailable', timedOut: true });
    const db = await box();
    await reply(SNAP); await settleFriends();
    if (d1.length === 1 && d2.length === 1 && d2[0].op === 'resume' && dh >= 0 && ds > dh
        && db && db.err === '' && !db.btns.some((b) => b.sq === 'retry'))
      ok(`${V}: a resume lost with its socket does not hold up the reconnect's, and its timeout says nothing`);
    else fail(`${V}: resume lost with its socket: first ${JSON.stringify(d1)}, reconnect ${JSON.stringify(dseq.map((f) => f.type + (f.op ? ':' + f.op : '')))} box ${JSON.stringify(db && { text: db.text, err: db.err, btns: db.btns })}`);

    // ---- 11. THE SQUAD WAS LOST WHILE THE SOCKET WAS DOWN: `gone` to a tab
    //      that held one is the neutral "has ended" line. It is NOT FINAL: the
    //      sign-in door answers an account's other devices `gone` until it has
    //      read the account's blocks (task 6), so the tab's next return asks
    //      once more, bare -- and a `gone` to THAT keeps the line and asks
    //      nothing further until the socket is introduced again.
    //      Storage is cleared first (blocked, or wiped): the squad this TAB was
    //      showing is evidence enough on its own.
    await ev(`(localStorage.removeItem('cc_squad'), true)`);
    await reconnect(); await token();
    // The reconnect's friends read is answered HERE, before anything clears the
    // frame log: left out, it stays in flight for twelve seconds and a later
    // check's friends Retry finds a read already out.
    await reply({ op: 'gone' }); await settleFriends();
    const lost = await box();
    // Another tab of this account, on this device, joins a squad meanwhile and
    // stores its code. The return here must still ask BARE: with that code it
    // would pull the row off the tab in use.
    await ev(`(localStorage.setItem('cc_squad', 'BKPQ'), true)`);
    await clearTx(); await focus();
    const retryBack = await squads();
    await reply({ op: 'gone' });
    const after2 = await box();
    await clearTx(); await focus();
    const none2 = await squads();
    if (lost && lost.text.startsWith('Your squad has ended.')
        && retryBack.length === 1 && !('code' in retryBack[0]) && after2 && after2.text.startsWith('Your squad has ended.') && none2.length === 0)
      ok(`${V}: a squad lost across a reconnect "has ended"; a return asks once, bare, and the line stands`);
    else fail(`${V}: lost across reconnect ${JSON.stringify({ lost: lost && lost.text, retryBack, after2: after2 && after2.text, none2 })}`);
    await settleFriends();
    // A TAB THAT HELD NOTHING is told "No squad yet" -- and its `gone` is not
    // final either: this may be the account's other device, which the door
    // answers `gone` while it reads. The first return asks once more.
    await ask(''); await reply({ op: 'gone' });
    const nb = await box();
    await clearTx(); await focus();
    const nq = await squads();
    await reply(SNAP);
    const ns = await box();
    if (nb && nb.text.startsWith(NOSQ) && nq.length === 1 && nq[0].op === 'resume' && !('code' in nq[0]) && ns && ns.text.includes('BKPQ'))
      ok(`${V}: \`gone\` to a tab that held nothing is "No squad yet", and its next return asks once more`);
    else fail(`${V}: held-nothing return ${JSON.stringify({ nb: nb && nb.text, nq, ns: ns && ns.text })}`);

    // ---- 12. HOW A SQUAD ENDS FOR THIS TAB. Every way a connected member's
    //       membership ends sends them a frame (D-BLOCK), and the box says what
    //       it says -- never why. A block that removes a player sends EXACTLY
    //       the kick frame, so it reads exactly as a kick.
    // The fourth column: Invite friends is offered under the line. Not under
    // `elsewhere`, whose squad may still be the account's on the other tab or
    // device: every squad control belongs to the socket on the row (D-UI-1,
    // review T8-R1-9). The code field is offered under every line.
    const ENDS = [
      [{ op: 'ended', reason: 'kicked' }, 'You were removed from the squad.', null, true, '0 / 4'],
      [{ op: 'ended', reason: 'left' }, 'You left the squad.', null, true, '0 / 4'],
      [{ op: 'left', ok: true, id: 987654 }, 'You left the squad.', null, true, '0 / 4'],
      [{ op: 'ended', reason: 'no_leader' }, 'Your squad has ended. Squad up again.', null, true, '0 / 4'],
      [{ op: 'ended', reason: 'constructor' }, 'Your squad has ended. Squad up again.', null, true, '0 / 4'],
      // Another tab or device of this account took the row, or left, created
      // or joined from there (server/social.js endedElsewhere). A second tab on
      // THIS device is the common case, so the line names both (review
      // T8-R1-9). The squad is not over for the ACCOUNT, so its code stays --
      // and the Squad pill is EMPTY: the account's squad is on another socket,
      // and a count this tab has not been told is not a count (review T8-R1-6).
      [{ op: 'ended', reason: 'elsewhere' }, 'Your squad was changed in another tab or on another device.', 'BKPQ', false, null],
    ];
    // window.CC_SQUAD_END is a CLOSED vocabulary: a reason this build does not
    // know is 'ended', never the server's own word.
    const endWord = { kicked: 'kicked', left: 'left', no_leader: 'no_leader', constructor: 'ended', elsewhere: 'elsewhere' };
    for (const [frame, line, keep, invite, pill] of ENDS) {
      await push(SNAP);
      await push(frame);
      const e = await box();
      const word = await ev('window.CC_SQUAD_END');
      if (e && e.text.startsWith(line) && e.field && e.field.on && e.btns.some((b) => b.sq === 'tab:friends') === invite
          && (await slot()) === null && (await stored()) === keep && e.tabs[0].pill === pill
          && word === (frame.op === 'left' ? 'left' : endWord[frame.reason]))
        ok(`${V}: ${frame.op}${frame.reason ? ':' + frame.reason : ''} -- "${line}", the slot is empty and the code is ${keep ? 'kept' : 'forgotten'}`);
      else fail(`${V}: ${JSON.stringify(frame)} ${JSON.stringify(e && { text: e.text, field: e.field, btns: e.btns, pill: e.tabs[0].pill })} slot=${JSON.stringify(await slot())} held=${JSON.stringify(await stored())} end=${JSON.stringify(word)}`);
    }
    // ELSEWHERE IS NOT FINAL FOR THIS TAB: coming back to it asks once more --
    // WITHOUT the code, so a glance at a background tab never pulls the squad
    // off the device in use (the server moves the row to a bare resume only
    // when no live socket holds it).
    await clearTx(); await focus();
    const back = await squads();
    // A REFUSAL IS RETRY'S TO CLEAR: the next return asks nothing, and Retry
    // asks -- still bare, because this tab gave the squad up.
    await reply({ error: 'unavailable' });
    await clearTx(); await focus();
    const quietBack = await squads();
    await clearTx(); await click('#bay [data-sq="retry"]'); await sleep(60);
    const viaRetry = await squads();
    await reply({ ...SNAP, members: [M({ id: ME, callsign: 'Dusty Crag', online: true })] });
    const b2 = await box();
    await clearTx(); await focus();
    const settled = await squads();
    if (back.length === 1 && back[0].op === 'resume' && !('code' in back[0]) && quietBack.length === 0
        && viaRetry.length === 1 && viaRetry[0].op === 'resume' && !('code' in viaRetry[0])
        && b2 && b2.text.includes('BKPQ') && settled.length === 0)
      ok(`${V}: after "elsewhere" a return asks once, bare; a refusal waits for Retry; what it is told is shown, then nothing more is asked`);
    else fail(`${V}: return after elsewhere sent ${JSON.stringify(back)}, after a refusal ${JSON.stringify(quietBack)}, Retry ${JSON.stringify(viaRetry)}, box ${JSON.stringify(b2 && b2.text)} then ${JSON.stringify(settled)}`);
    // A KICK IS FINAL: a return to the tab asks nothing.
    await push({ op: 'ended', reason: 'kicked' });
    await clearTx(); await focus();
    if ((await squads()).length === 0) ok(`${V}: after a kick a return to the tab asks nothing`);
    else fail(`${V}: a kicked tab re-asked on return ${JSON.stringify(await squads())}`);
    // AN END IS ACTED ON ONCE. Storage is shared by every tab on the device, so
    // a kick this tab has already acted on must not delete the code another tab
    // has stored since, the next time this tab's slot event fires.
    await ev(`(localStorage.setItem('cc_squad', 'WXYZ'), document.dispatchEvent(new Event('cc:squad')), true)`);
    if ((await stored()) === 'WXYZ') ok(`${V}: an end already acted on leaves another tab's code alone`);
    else fail(`${V}: a repaint after a kick deleted another tab's code (${JSON.stringify(await stored())})`);

    // ---- 13. A TAB THAT GAVE ITS SQUAD UP ("elsewhere") keeps the code for the
    //      account but never uses it again: its reconnect resumes bare, so a
    //      background tab waking up cannot pull the squad off the device in use.
    //      And a return to the tab while the new socket's hello is still out
    //      asks nothing early: no path may send a resume ahead of the hello.
    await push(SNAP); await push({ op: 'ended', reason: 'elsewhere' });
    await reconnect(); await focus(); await token();
    const reSeq = await tx(), bareRe = reSeq.filter((f) => f.type === 'squad');
    const hello13 = reSeq.findIndex((f) => f.type === 'hello'), first13 = reSeq.findIndex((f) => f.type === 'squad');
    if (bareRe.length === 1 && bareRe[0].op === 'resume' && !('code' in bareRe[0]) && hello13 >= 0 && first13 > hello13 && (await stored()) === 'BKPQ')
      ok(`${V}: after "elsewhere" a reconnect resumes bare, after the hello, and the device keeps the code`);
    else fail(`${V}: reconnect after elsewhere sent ${JSON.stringify(reSeq.map((f) => f.type + (f.op ? ':' + f.op : '') + (f.code ? ':' + f.code : '')))} held=${JSON.stringify(await stored())}`);
    await reply({ op: 'gone' }); await settleFriends();
    const g13 = await box();
    // THIS TAB HELD A SQUAD until another tab or device took it, so the bare
    // question's `gone` is the neutral "has ended" line (sheet "FROM TASK 6"
    // note 4; review T8-R1-8) -- and the code it did not present is not spent.
    if (g13 && g13.text.startsWith('Your squad has ended. Squad up again.') && (await stored()) === 'BKPQ')
      ok(`${V}: \`gone\` to a tab that gave its squad up elsewhere is "has ended", and spends no code the tab did not present`);
    else fail(`${V}: bare gone ${JSON.stringify(g13 && g13.text)} held=${JSON.stringify(await stored())}`);

    // ---- 14. ONE CODE FIELD (D8/5.3). It asks the server which kind of code it
    //      is and then does the one thing that matches. Each branch is driven
    //      separately: a mock that answered all three the same way would be
    //      green with and without the bug.
    const SQ_NONE = 'No squad or game with that code.';
    const typeCode = (v) => ev(`(() => { const i = document.getElementById('sqCode'); if (!i) return false; i.value = ${JSON.stringify(v)}; return true; })()`);
    const codeReply = async (patch) => { const r = await ev(`(() => {
      const q = window.__tx.filter((f) => f.type === 'code'); const i = q.length ? q[q.length - 1].id : null;
      handle(Object.assign({ type: 'code', id: i }, ${JSON.stringify(patch)})); return i; })()`); await sleep(120); return r; };
    const enterCode = async (v) => { await typeCode(v); await clearTx(); await click('#bay [data-sq="code"]'); await sleep(40); };
    // (a) too short -- refused on this side, no frame at all
    await enterCode('AB');
    const short = await box();
    if ((await tx()).length === 0 && short && short.err === 'Enter the 4-letter code.')
      ok(`${V}: a short code is refused here and never reaches the socket`);
    else fail(`${V}: short code ${JSON.stringify({ tx: await tx(), err: short && short.err })}`);
    // (b) a ROOM code goes down the join path that already exists
    await ev(`(() => { window.__joined = null; const b = $('joinBtn'); window.__joinFn = b.onclick; b.onclick = () => { window.__joined = $('codeInput').value; }; return true; })()`);
    await enterCode('mnpq');
    const asked = (await tx()).filter((f) => f.type === 'code');
    await codeReply({ kind: 'room' });
    const joined = await ev('window.__joined');
    await ev(`($('joinBtn').onclick = window.__joinFn, true)`);
    if (asked.length === 1 && asked[0].code === 'MNPQ' && joined === 'MNPQ')
      ok(`${V}: a room code is upper-cased, asked about, then joined through #codeInput/#joinBtn`);
    else fail(`${V}: room branch asked=${JSON.stringify(asked)} joined=${JSON.stringify(joined)}`);
    // (c) a SQUAD code sends squad op:'join' with this player's CURRENT callsign
    //     and paint (task 4: a seat's name is whatever the join frame carried).
    const who = await ev('({ name: myName(), skin: mySkin() })');
    const joinWith = async (answer) => {
      await enterCode('BKPQ'); await codeReply({ kind: 'squad' });
      const j = (await squads()).filter((f) => f.op === 'join');
      await reply(answer);
      return j;
    };
    const j = await joinWith({ op: 'join', error: 'no_such_squad' });
    const jn = await box();
    if (j.length === 1 && j[0].code === 'BKPQ' && j[0].name === who.name && j[0].skin === who.skin)
      ok(`${V}: a squad code sends squad op:'join' with this player's callsign and paint`);
    else fail(`${V}: squad branch ${JSON.stringify(j)} want ${JSON.stringify(who)}`);
    // D-BLOCK-2 A: a refused join reads EXACTLY as an unknown code does, so a
    // join a block refuses shows the ordinary view.
    if (jn && jn.err === SQ_NONE) ok(`${V}: a join refused no_such_squad says what an unknown code says`);
    else fail(`${V}: join no_such_squad ${JSON.stringify(jn && jn.err)}`);
    // EVERY DECIDED JOIN REFUSAL, one row each (review T8-R1-12): a key edited
    // or deleted in SOC_ERR reads the generic fallback, and only a row per key
    // can see that. The last row is a code this build does not know.
    for (const [code, line] of [['already_in', 'You are already in that squad on another device.'], ['full', 'That squad is full.'],
      ['slow_down', 'Too many tries. Wait a moment.'], ['offline', 'Not connected. Try again in a moment.'],
      ['unavailable', 'That squad could not be joined right now. Try again later.'],
      ['not_a_code_this_build_knows', 'That squad could not be joined right now. Try again later.']]) {
      await joinWith({ op: 'join', error: code });
      const jx = await box();
      if (jx && jx.err === line) ok(`${V}: a join refused ${code} says "${line}"`);
      else fail(`${V}: join ${code} ${JSON.stringify(jx && jx.err)}`);
    }
    // And a join that lands: the roster is the answer, the box shows it, and
    // this tab's next reconnect takes its row back WITH the code again.
    await joinWith(SNAP);
    const jok = await box();
    await reconnect(); await token();
    const coded = await squads();
    await reply(SNAP); await settleFriends();
    if (jok && jok.text.includes('BKPQ') && !jok.err && (await stored()) === 'BKPQ' && coded.length === 1 && coded[0].code === 'BKPQ')
      ok(`${V}: a join that lands shows the squad, and a reconnect resumes it by code`);
    else fail(`${V}: join landed ${JSON.stringify(jok && { text: jok.text, err: jok.err })} reconnect=${JSON.stringify(coded)}`);
    // A SQUAD ON SCREEN IS A SQUAD THIS TAB HAD (review T8-R1-13). After a
    // `gone` the tab's next return owes one more question, BARE; the player may
    // join a squad by code meanwhile. If that squad has ended by the time the
    // return asks, the bare question presents no code, and the squad on screen
    // alone makes "has ended" the true line.
    await ask(''); await reply({ op: 'gone' });
    await joinWith(SNAP);
    await clearTx(); await focus();
    const hq = await squads();
    await reply({ op: 'gone' });
    const hg = await box();
    if (bare1(hq) && hg && hg.text.startsWith('Your squad has ended. Squad up again.'))
      ok(`${V}: a bare question asked with a squad on screen, answered \`gone\`, reads "has ended"`);
    else fail(`${V}: gone with a squad on screen ${JSON.stringify({ hq, text: hg && hg.text })}`);
    // (d) NONE
    await push({ op: 'ended', reason: 'left' });
    await enterCode('ZZZZ'); await codeReply({ kind: 'none' });
    const none = await box();
    if (none && none.err === SQ_NONE) ok(`${V}: an unknown code is told the truth (5.3)`);
    else fail(`${V}: none branch ${JSON.stringify(none && none.err)}`);
    await up(false); const noneOff = await box(); await up(true);
    if (noneOff && noneOff.err === '' && noneOff.field && !noneOff.field.on) ok(`${V}: offline, the field's last answer is not left under a dead field`);
    else fail(`${V}: offline code error ${JSON.stringify(noneOff && { err: noneOff.err, field: noneOff.field })}`);
    // A REFUSED CODE FRAME IS NOT AN UNKNOWN CODE (review T8-R1-11): a timeout
    // on a live socket answers 'unavailable', and telling that player a valid
    // code does not exist is the lie. Each refusal says its own decided
    // sentence (review T8-R1-12).
    await box();                                                // repaint: the socket coming back is not one by itself here
    for (const [cerr, line] of [['unavailable', 'That code could not be checked right now. Try again later.'],
      ['offline', 'Not connected. Try again in a moment.']]) {
      await enterCode('MNPQ'); await codeReply({ error: cerr });
      const cx = await box();
      if (cx && cx.err === line) ok(`${V}: a code frame refused ${cerr} says "${line}", not that the code does not exist`);
      else fail(`${V}: code frame refused ${cerr} ${JSON.stringify(cx && cx.err)}`);
    }
    // (e) ENTER. The join panel never had one despite a comment saying it did;
    //     a 4-letter code on a phone keyboard ends with the Go key.
    await typeCode('MNPQ'); await clearTx();
    await ev(`(() => { const i = document.getElementById('sqCode'); if (!i) return false; i.focus();
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await sleep(40);
    if ((await tx()).filter((f) => f.type === 'code').length === 1) ok(`${V}: Enter in the code field commits it`);
    else fail(`${V}: Enter sent ${JSON.stringify(await tx())}`);
    await codeReply({ kind: 'none' });
    // A HELD KEY IS ONE PRESS (review T8-R1-10): an autorepeated Enter sends
    // nothing, or a held Go key pours code and join frames into the socket's
    // message limiter, which closes the socket.
    await typeCode('MNPQ'); await clearTx();
    await ev(`(() => { const i = document.getElementById('sqCode'); if (!i) return false; i.focus();
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true })); return true; })()`);
    await sleep(40);
    const rep = (await tx()).filter((f) => f.type === 'code');
    if (rep.length === 0) ok(`${V}: an autorepeated Enter sends nothing`);
    else { fail(`${V}: an autorepeated Enter sent ${JSON.stringify(rep)}`); await codeReply({ kind: 'none' }); }
    // (f) A PLAYER WITH NO ACCOUNT WHO ENTERS A SQUAD CODE IS IN IT (D11), and
    //     sees it. With no squad in hand such a player asks nothing: their
    //     squad is keyed to the socket they joined on.
    const GSNAP = { ...SNAP, you: 1, members: [M({ id: '00000000-0000-4000-8000-0000000000cc', callsign: 'Steel Mule' }), M({ guest: true })] };
    await clearTx(); await setWho('out');
    const outAsk = await squads();
    await enterCode('BKPQ'); await codeReply({ kind: 'squad' });
    const gj = (await squads()).filter((f) => f.op === 'join');
    await reply(GSNAP);
    const gin = await box();
    if (outAsk.length === 0 && gj.length === 1 && gin && gin.text.includes('BKPQ') && !gin.text.includes('You can play right now'))
      ok(`${V}: a player with no account asks nothing, enters a squad code, and sees the squad they are in`);
    else fail(`${V}: no-account join asked=${JSON.stringify(outAsk)} join=${JSON.stringify(gj)} ${JSON.stringify(gin && gin.text)}`);
    // A FIRST SAVE MINTS AN ANONYMOUS ACCOUNT, maybe mid-squad. Nobody is being
    // left: the row is the socket's, and the squad stays on screen. The slot is
    // read BEFORE anything is answered, so no reply can put back what the
    // account event took away.
    await setWho('guest');
    const minted = await slot();
    await reply(GSNAP);
    const gmint = await box();
    if (JSON.stringify(minted) === '{"code":"BKPQ","n":2}' && gmint && gmint.text.includes('BKPQ'))
      ok(`${V}: an anonymous account minted mid-squad keeps the squad`);
    else fail(`${V}: minted account dropped the squad ${JSON.stringify(gmint && gmint.text)} slot=${JSON.stringify(minted)}`);
    // And a guest who is kicked is told so, above everything a guest can do.
    await push({ op: 'ended', reason: 'kicked' });
    const gk = await box();
    if (gk && gk.text.startsWith('You were removed from the squad. ' + G1)) ok(`${V}: a kicked guest is told, and offered the code field again`);
    else fail(`${V}: kicked guest ${JSON.stringify(gk && gk.text)}`);
    await setWho('in');
    await ask(''); await reply(SNAP);

    // ---- 15. TWO EVENTS. cc:social is what a fresh friends snapshot rides, and
    //      'home' was not in bay.js's repaint list. cc:account is where a squad
    //      that belonged to somebody else must be dropped.
    const FRIENDS = `{ friends: [{ id: 'a', callsign: 'Dusty Crag', online: true }, { id: 'b', callsign: null, online: false }],
      requests: { in: [{ id: 'c', callsign: 'Steel Mule' }], out: [] }, blocked: [], friendCode: 'AB12CD', callsign: null }`;
    await ev(`(window.CC_SOCIAL = ${FRIENDS}, document.dispatchEvent(new Event('cc:social')), true)`);
    await sleep(60);
    const fr1 = await ev(`(() => { const t = document.querySelectorAll('#bay .sqtb')[1]; if (!t) return null; const c = t.querySelector('.sqc');
      return { pill: c.classList.contains('hidden') ? null : c.textContent.trim(), dot: !t.querySelector('.sqd').classList.contains('hidden') }; })()`);
    if (fr1 && fr1.pill === '1' && fr1.dot === true)
      ok(`${V}: cc:social repaints home -- Friends reads 1 online with the waiting-request lamp`);
    else fail(`${V}: friends tab ${JSON.stringify(fr1)}`);
    // THE LAMP IS NOT THE ONLY WAY TO KNOW (review T8-R1-17): it is aria-hidden,
    // so the tab's name says the waiting request in words.
    const frName = await ev(`(() => { const t = document.querySelectorAll('#bay .sqtb')[1]; return t ? t.getAttribute('aria-label') : null; })()`);
    if (frName === 'Friends, 1 online, 1 request waiting') ok(`${V}: the Friends tab's name says 1 online and 1 request waiting`);
    else fail(`${V}: Friends tab name ${JSON.stringify(frName)}`);
    // A DIFFERENT ACCOUNT IS NOT YOUR SQUAD -- AND IT IS NOT ASKED ABOUT UNTIL
    // ITS OWN HELLO (review T8-R1-2). An in-page sign-in fires cc:account from
    // cloudBoot BEFORE app.js sends the new identity's hello, and the server
    // answers a frame for whoever the socket was when it arrived: a resume sent
    // on the account event is answered for the account being left.
    const OTHER = `{ id: '00000000-0000-4000-8000-0000000000cc', anonymous: false, google: true, apple: false, email: 'other@example.com', accounts: [{ provider: 'google', email: 'other@example.com' }] }`;
    const flipTo = (acc) => ev(`(() => { const b = $('accountBtn'); b.classList.remove('hidden'); b.dataset.state = 'in';
      window.CC_ACCOUNT = ${acc}; document.dispatchEvent(new CustomEvent('cc:account'));
      for (const f of window.__tx.filter((x) => x.type === 'friends')) handle({ type: 'friends', error: 'unavailable', id: f.id });
      window.CC_SOCIAL_ERR = ''; return true; })()`);
    const hello = async () => { await ev('sendHello(S.ws).then(() => true)'); await sleep(60); };
    await clearTx();
    await flipTo(OTHER);
    await sleep(60);
    const flip = await box();
    const flipAsk = await squads();
    await hello();
    const helloAsk = await squads();
    if (flip && flip.text.startsWith('Not loaded yet.') && !flip.text.includes('BKPQ') && (await stored()) === null && (await slot()) === null
        && flipAsk.length === 0 && bare1(helloAsk))
      ok(`${V}: a different account drops the squad, the code and the answer, asks nothing on the switch, and asks bare after its hello`);
    else fail(`${V}: account flip ${JSON.stringify(flip && flip.text)} held=${JSON.stringify(await stored())} slot=${JSON.stringify(await slot())} on the switch=${JSON.stringify(flipAsk)} after the hello=${JSON.stringify(helloAsk)}`);
    await reply({ op: 'gone' });
    // AN END STANDING WITH NO ROSTER BELONGS TO THE ACCOUNT TOO (review
    // T8-R1-8). A kicked player's line is theirs: whoever signs in next on this
    // device, or plays on as a guest, is not told it.
    const kickedThen = async () => { await setWho('in'); await hello(); await reply(SNAP); await push({ op: 'ended', reason: 'kicked' }); };
    await kickedThen();
    const endWas = await ev('window.CC_SQUAD_END');
    await flipTo(OTHER); await hello(); await reply({ op: 'gone' });
    const endB = await ev('window.CC_SQUAD_END'), eb = await box();
    await kickedThen();
    await setWho('guest');
    const endG = await ev('window.CC_SQUAD_END'), eg = await box();
    if (endWas === 'kicked' && endB === '' && eb && eb.text.startsWith(NOSQ) && endG === '' && eg && eg.text.startsWith(G1))
      ok(`${V}: a kick standing with no roster is dropped with its account: the next account, or a guest, is not told it`);
    else fail(`${V}: an end outlived its account: before=${JSON.stringify(endWas)} next account=${JSON.stringify(endB)} ${JSON.stringify(eb && eb.text)} guest=${JSON.stringify(endG)} ${JSON.stringify(eg && eg.text)}`);
    await setWho('in'); await hello(); await reply({ op: 'gone' }); await settleFriends();

    // ---- 16. THE FRIENDS TAB, v1 (design 5.1): the counts D13 asks for and the
    //      door to the full screen. Task 9 adds the rows and Invite under them.
    //      The pill must be ABSENT, not zero, while CC_SOCIAL is null.
    await ev(`(window.CC_SOCIAL = null, window.CC_SOCIAL_ERR = '', window.CC_SOCIAL_ASKING = false, document.dispatchEvent(new Event('cc:social')), true)`);
    await click('#bay [data-sq="tab:friends"]');
    const fu = await box();
    if (fu && fu.tabs[1].pill === null && fu.text.startsWith('Not loaded yet.') && !fu.text.includes('No friends'))
      ok(`${V}: Friends with no snapshot says "Not loaded yet.", and the pill is absent rather than 0`);
    else fail(`${V}: friends unknown ${JSON.stringify(fu && { pill: fu.tabs[1].pill, text: fu.text })}`);
    // A REFUSED FRIENDS READ HAS A RETRY (review T8-R1-7). Nothing re-asks it by
    // itself -- it is eight round trips on the server, asked once per
    // connection and per sign-in -- so the tab offers the tap, and says Loading
    // while that question is out.
    await ev(`(window.CC_SOCIAL_ERR = 'unavailable', document.dispatchEvent(new Event('cc:social')), true)`);
    const fe = await box();
    await clearTx(); await click('#bay [data-sq="fretry"]'); await sleep(60);
    const fq = (await tx()).filter((f) => f.type === 'friends');
    const fl = await box();
    await ev(`(() => { for (const f of window.__tx.filter((x) => x.type === 'friends')) handle({ type: 'friends', error: 'unavailable', id: f.id }); window.CC_SOCIAL_ERR = ''; document.dispatchEvent(new Event('cc:social')); return true; })()`);
    await sleep(60);
    if (fe && fe.err === 'Friends are not available right now. Try again later.' && fe.btns.some((b) => b.sq === 'fretry' && !b.dis && b.t === 'Retry')
        && fq.length === 1 && fl && fl.btns.some((b) => b.sq === 'fretry' && b.dis && b.t === 'Loading'))
      ok(`${V}: a refused friends read offers Retry, which asks once and says Loading while it waits`);
    else fail(`${V}: friends retry ${JSON.stringify({ fe: fe && { err: fe.err, btns: fe.btns }, fq, fl: fl && fl.btns })}`);
    await ev(`(window.CC_SOCIAL = ${FRIENDS}, document.dispatchEvent(new Event('cc:social')), true)`);
    await sleep(60);
    const fk = await box();
    if (fk && fk.text === 'Your friends \u00b7 2 1 online now. 1 request waiting for an answer. + ADD FRIEND'
        && fk.btns.some((b) => b.go === 'friends' && !b.dis))
      ok(`${V}: Friends reads 2 friends, 1 online, 1 request, and offers the door to the screen`);
    else fail(`${V}: friends known ${JSON.stringify(fk && { text: fk.text, btns: fk.btns })}`);
    await click('#bay [data-sq="tab:squad"]');

    // ---- 17. AN ANSWER SETTLES THE ACCOUNT THAT ASKED (review T8-R1-13). An
    //       account switch replaces the box's state; the answer to the old
    //       account's question lands on the old state, never on the new one,
    //       whose own question is still out. Both of the box's questions: the
    //       resume and the code.
    const ra = await ask('');                                   // this account's resume is out
    await clearTx(); await flipTo(OTHER); await hello();         // the new account's hello asks for it
    const rb = await squads();
    await answer(ra[0] && ra[0].id, { type: 'squad', op: 'gone' });
    const iso = await box();
    await reply({ op: 'gone' });                                 // the new account's own answer
    if (ra.length === 1 && rb.length === 1 && rb[0].op === 'resume' && iso && iso.text.startsWith('Not loaded yet.') && !iso.text.includes(NOSQ)
        && iso.btns.some((b) => b.sq === 'retry' && b.dis))
      ok(`${V}: the old account's resume answer does not settle the new account's box`);
    else fail(`${V}: resume answer crossed accounts ${JSON.stringify({ ra, rb, iso: iso && { text: iso.text, btns: iso.btns } })}`);
    await typeCode('ZZZZ'); await clearTx(); await click('#bay [data-sq="code"]'); await sleep(40);
    const cq = (await tx()).filter((f) => f.type === 'code');
    await clearTx(); await setWho('in'); await hello();          // back to the first account; its hello asks
    await answer(cq[0] && cq[0].id, { type: 'code', kind: 'none' });
    const iso2 = await box();
    await reply({ op: 'gone' });
    if (cq.length === 1 && iso2 && iso2.text.startsWith('Not loaded yet.') && !iso2.text.includes(SQ_NONE))
      ok(`${V}: the old account's code answer does not land on the new account's field`);
    else fail(`${V}: code answer crossed accounts ${JSON.stringify({ cq, iso2: iso2 && iso2.text })}`);
    await typeCode('');

    // ---- 18. BACK TO THE TAB, one event at a time (review T8-R1-14). A phone
    //       fires visibilitychange on the way OUT, while the page is hidden: an
    //       ask then would spend the return's question as the app goes to the
    //       background. And either event alone is a return.
    const arm = async () => { await push(SNAP); await push({ op: 'ended', reason: 'elsewhere' }); };
    const visib = () => ev(`(document.dispatchEvent(new Event('visibilitychange', { bubbles: true })), true)`);
    await arm();
    await ev(`(Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }), true)`);
    await clearTx(); await visib(); await sleep(60);
    const whileHidden = await squads();
    await ev(`(delete document.hidden, document.hidden)`);
    await clearTx(); await ev(`(window.dispatchEvent(new Event('focus')), true)`); await sleep(60);
    const byFocus = await squads();
    await reply(SNAP);
    await arm();
    await clearTx(); await visib(); await sleep(60);
    const byVis = await squads();
    await reply(SNAP);
    if (whileHidden.length === 0) ok(`${V}: a visibilitychange while the page is hidden asks nothing`);
    else fail(`${V}: asked while hidden ${JSON.stringify(whileHidden)}`);
    if (bare1(byFocus)) ok(`${V}: focus alone is a return: it asks once, bare`);
    else fail(`${V}: focus alone sent ${JSON.stringify(byFocus)}`);
    if (bare1(byVis)) ok(`${V}: visibilitychange alone is a return: it asks once, bare`);
    else fail(`${V}: visibilitychange alone sent ${JSON.stringify(byVis)}`);

    // ---- 19. ENTERING HOME ASKS what nothing else asked (review T8-R1-15).
    //       Every introduction, account change and return already asks, from
    //       any screen; the entry hook is the belt under them. Driven alone: an
    //       introduction whose cc:squad never fired is asked about the moment
    //       home is entered, and not before.
    await ev(`(Bay.go('career'), true)`);
    await clearTx();
    await ev(`(helloWs = S.ws, helloN++, true)`);               // a mark nobody announced
    await sleep(60);
    const unheard = await squads();
    await ev(`(Bay.go('home'), true)`); await sleep(60);
    const onEntry = await squads();
    await reply(SNAP);
    if (unheard.length === 0 && onEntry.length === 1 && onEntry[0].op === 'resume')
      ok(`${V}: entering home asks about an introduction no event announced`);
    else fail(`${V}: entry hook: before ${JSON.stringify(unheard)}, on entry ${JSON.stringify(onEntry)}`);

    // ---- 20. A ROSTER THIS SOCKET WAS ONLY SHOWN (D-UI-1; review T8-R1-1). A
    //       bare resume from a second tab or device, while a live socket
    //       elsewhere holds the account's row, is answered the roster with
    //       held:false: the row stays where it is and no push will ever reach
    //       this socket. The box says where the squad is, keeps it out of the
    //       slot and out of storage, offers no squad control -- the code field
    //       stays -- and asks again, bare, on a return and on a reconnect,
    //       exactly as after `elsewhere`. A roster it HOLDS is its own again.
    const OPEN = 'Your squad is open on another device.';
    const LOOK = { ...SNAP, held: false }, HELD = { ...SNAP, held: true };
    // A tab with no squad of its own on a device that remembers no code: the
    // laptop opened while the phone holds the squad. (The squad this tab held
    // is answered `gone` first, so it holds nothing: a `gone` PUSH would not
    // do -- the server sends `gone` only as the answer to a resume.)
    await ask(''); await reply({ op: 'gone' });
    const lk = await ask('');
    await reply(LOOK);
    const lb = await box();
    const lookEnd = await ev('window.CC_SQUAD_END');
    // AND THE SQUAD PILL IS EMPTY (review T8-R1-6): the account has a squad,
    // on another socket, so "0 / 4" would be false and a count this tab has
    // not been told is not a count.
    if (lk.length === 1 && !('code' in lk[0]) && lb && lb.text.startsWith(OPEN) && !lb.text.includes('BKPQ') && !lb.text.includes('Dusty Crag') && lb.tabs[0].pill === null
        && (await slot()) === null && lookEnd === 'open' && (await stored()) === null
        && !lb.btns.some((b) => b.sq === 'tab:friends') && lb.field && lb.field.on && lb.btns.some((b) => b.sq === 'code' && !b.dis))
      ok(`${V}: a held:false roster reads "${OPEN}", with no squad control and the code field, and is neither in the slot nor stored`);
    else fail(`${V}: look-only answer ${JSON.stringify(lb && { text: lb.text, btns: lb.btns, field: lb.field, pill: lb.tabs[0].pill })} slot=${JSON.stringify(await slot())} end=${JSON.stringify(lookEnd)} held=${JSON.stringify(await stored())} asked=${JSON.stringify(lk)}`);
    // A RETURN ASKS AGAIN, BARE -- even with a code another tab has stored
    // meanwhile, which would pull the row off the socket in use -- and each
    // return asks once, whatever the answer was.
    await ev(`(localStorage.setItem('cc_squad', 'BKPQ'), true)`);
    await clearTx(); await focus();
    const lr1 = await squads();
    await reply(LOOK);
    await clearTx(); await focus();
    const lr2 = await squads();
    await reply(LOOK);
    // A RECONNECT ASKS AGAIN, BARE, after the hello.
    await reconnect(); await token();
    const lseq = await tx(), lre = lseq.filter((f) => f.type === 'squad');
    await reply(LOOK); await settleFriends();
    const lhi = lseq.findIndex((f) => f.type === 'hello'), lsi = lseq.findIndex((f) => f.type === 'squad');
    if (bare1(lr1) && bare1(lr2) && bare1(lre) && lhi >= 0 && lsi > lhi
        && (await stored()) === 'BKPQ')
      ok(`${V}: after a held:false answer every return and a reconnect ask again, bare, and the device's code is kept`);
    else fail(`${V}: re-ask after held:false: returns ${JSON.stringify([lr1, lr2])} reconnect ${JSON.stringify(lseq.map((f) => f.type + (f.op ? ':' + f.op : '') + (f.code ? ':' + f.code : '')))} held=${JSON.stringify(await stored())}`);
    // THE OTHER SOCKET LET GO: the next return is answered held:true, and the
    // squad is this tab's -- shown, in the slot, and its reconnect carries the
    // code again, to take its row back from a dead socket a proxy holds open.
    await clearTx(); await focus();
    await reply(HELD);
    const lh = await box();
    await reconnect(); await token();
    const lcoded = (await tx()).filter((f) => f.type === 'squad');
    await reply(HELD); await settleFriends();
    if (lh && lh.text.includes('BKPQ') && !lh.text.includes(OPEN) && JSON.stringify(await slot()) === '{"code":"BKPQ","n":2}'
        && lcoded.length === 1 && lcoded[0].op === 'resume' && lcoded[0].code === 'BKPQ')
      ok(`${V}: a held:true answer makes the squad this tab's again, and its next reconnect resumes by code`);
    else fail(`${V}: held again ${JSON.stringify(lh && lh.text)} slot=${JSON.stringify(await slot())} reconnect=${JSON.stringify(lcoded)}`);
    // A held:false frame never writes over the slot, even one holding a
    // roster, and never spends the device's code: the account's squad lives.
    await push(LOOK);
    const lp = await box();
    if ((await slot()) === null && (await ev('window.CC_SQUAD_END')) === 'open' && (await stored()) === 'BKPQ' && lp && lp.text.startsWith(OPEN)
        && lp.tabs[0].pill === null)
      ok(`${V}: a held:false push empties the slot, says the squad is open elsewhere, empties the pill, and keeps the code`);
    else fail(`${V}: held:false push ${JSON.stringify(lp && { text: lp.text, pill: lp.tabs[0].pill })} slot=${JSON.stringify(await slot())} held=${JSON.stringify(await stored())}`);
    // THE SQUAD ENDED ON THE OTHER DEVICE: this tab showed it, so the answer to
    // the next return is the neutral "has ended" line, and the code the bare
    // question did not present is not spent.
    await clearTx(); await focus();
    await reply({ op: 'gone' });
    const lg = await box();
    if (lg && lg.text.startsWith('Your squad has ended. Squad up again.') && (await stored()) === 'BKPQ')
      ok(`${V}: \`gone\` after a held:false answer is "has ended", and spends no code the tab did not present`);
    else fail(`${V}: gone after held:false ${JSON.stringify(lg && lg.text)} held=${JSON.stringify(await stored())}`);

    // ---- 21. A RELOADED TAB PRESENTS THE CODE IT STORED -- its FIRST ask, and
    //       only that one, reads the device's code (D-UI-2; review T8-R1-1) --
    //       AND ITS FIRST ACCOUNT EVENT ASKS (review T8-R1-2). At boot the hello
    //       reads the session's token on its own, so it can mark the socket
    //       before refreshAccountChip has said who the player is; that account
    //       event is then the only thing left to ask on. Here the boot's
    //       account read is held until the check has looked, so the hello
    //       really does win the race, and then the real refreshAccountChip
    //       names a signed-in player.
    await send('Page.enable');                                  // or a script added for new documents never runs
    const hold = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      let C;
      Object.defineProperty(window, 'Cloud', { configurable: true, get: () => C, set: (v) => {
        C = v;
        if (v && typeof v.whoami === 'function') v.whoami = () => new Promise((r) => { window.__who = r; });
      } });
    })();` });
    await ev(`(localStorage.setItem('cc_squad', 'QRST'), true)`);
    const booted = await load();
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hold.identifier });
    await send('Page.disable');
    if (!booted) { fail(`${V}: page never became ready for the reload check`); continue; }
    for (let i = 0; i < 40 && !(await ev('typeof window.__who === "function"')); i++) await sleep(100);
    await stubSocket();
    await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    const early21 = await squads();                             // introduced while nobody is known: nothing
    await ev(`(window.__who(${LINKED}), true)`); await sleep(150);
    const seeded = await squads();
    await reply({ op: 'gone' });
    const s21 = await box();
    const spent21 = await stored();
    await ask(''); await reply({ op: 'gone' });
    const s21b = await box();
    await settleFriends();
    if (early21.length === 0 && seeded.length === 1 && seeded[0].op === 'resume' && seeded[0].code === 'QRST')
      ok(`${V}: a reloaded tab whose hello came first asks on its first account event, presenting the code it stored`);
    else fail(`${V}: reload: before the account ${JSON.stringify(early21)}, on it ${JSON.stringify(seeded)}`);
    // C3: the line is CAUSE-NEUTRAL. A kick, the drop window, a block and a
    // restart all answer the same `gone`, and naming one of them would tell a
    // player removed by a block what happened to them.
    if (s21 && s21.text.startsWith('Your squad has ended. Squad up again.')
        && s21.btns.some((b) => b.sq === 'tab:friends' && /invite friends/i.test(b.t)) && spent21 === null)
      ok(`${V}: gone with a remembered code is the neutral "has ended" line, and the code is spent`);
    else fail(`${V}: squad-gone ${JSON.stringify(s21 && { text: s21.text, btns: s21.btns })} held=${JSON.stringify(spent21)}`);
    // AND IT IS SPENT. The next introduction has nothing to remember and says so.
    if (s21b && s21b.text.startsWith(NOSQ)) ok(`${V}: the "has ended" line is not repeated on the next answer`);
    else fail(`${V}: ended line stuck ${JSON.stringify(s21b && s21b.text)}`);

    // ---- 22. RECENT SORTIES IS FETCHED ON ENTERING HOME ONLY (review T8-R1-4).
    //       Its panel is gone -- this box took its slot -- and Task 10 removes
    //       loadSorties. Until then it must not run on a repaint: home now
    //       repaints on every presence push and every squad frame, and while
    //       /history is failing each run is one more request, and one more token
    //       check on the server, for a panel nobody can see. Run on the page
    //       check 21 reloaded: the earlier checks hold Cloud.token open, and a
    //       fetch parked on a token that never comes keeps loadSorties busy.
    await ev(`(() => {
      window.__hist = 0;
      window.__fetch0 = window.__fetch0 || window.fetch;
      window.fetch = (u, o) => { if (String(u).includes('/history')) { window.__hist++; return Promise.resolve(new Response('', { status: 502 })); } return window.__fetch0(u, o); };
      window.__tok0 = Cloud.token; Cloud.token = async () => 'tok-h';
      return true; })()`);
    for (let i = 0; i < 3; i++) { await ev(`(document.dispatchEvent(new Event('cc:social')), true)`); await sleep(80); }
    const histRepaint = await ev('window.__hist');
    await ev(`(Bay.go('career'), true)`); await sleep(60);
    await ev(`(Bay.go('home'), true)`); await sleep(150);
    const histEntry = (await ev('window.__hist')) - histRepaint;
    await ev(`(window.fetch = window.__fetch0, Cloud.token = window.__tok0, true)`);
    if (histRepaint === 0 && histEntry === 1) ok(`${V}: /history is fetched once on entering home, and never on a repaint`);
    else fail(`${V}: /history fetched ${histRepaint} time(s) on three repaints, ${histEntry} on entering home (want 0 and 1)`);
  }
} catch (e) {
  fail('squad_ui stopped: ' + (e && e.message));
}

clearTimeout(watchdog);
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall squad_ui checks passed');
process.exit(errors.length ? 1 : 0);
