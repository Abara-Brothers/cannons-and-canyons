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
    // CHANGED BY TASK 9, which adds the Request and Friends rows under these
    // count lines (C11): the three lines are still the tab's opening words,
    // exactly, and + Add friend is still its last; what now sits between them
    // is task 9's own check's to read.
    if (fk && fk.text.startsWith('Your friends \u00b7 2 1 online now. 1 request waiting for an answer. ') && fk.text.endsWith(' + ADD FRIEND')
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

    // ---- 22. THE BAY NEVER FETCHES /history (review T8-R1-4, then Task 10).
    //       The recent-match panel went with Task 8, and its loader and the
    //       route it read went with Task 10. This check used to count ONE fetch
    //       on entering home and none on a repaint; with the loader gone it
    //       counts NONE either way, under the exact conditions in which the
    //       loader fired -- a Cloud session with a token, three repaints, then a
    //       fresh entry to home -- so putting the loader back fails it. The spy
    //       counts one probe of its own first, so a zero here is a count and not
    //       a harness that saw nothing. Run on the page check 21 reloaded: the
    //       earlier checks hold Cloud.token open.
    await ev(`(() => {
      window.__hist = 0;
      window.__fetch0 = window.__fetch0 || window.fetch;
      window.fetch = (u, o) => { if (String(u).includes('/history')) { window.__hist++; return Promise.resolve(new Response('', { status: 502 })); } return window.__fetch0(u, o); };
      window.__tok0 = Cloud.token; Cloud.token = async () => 'tok-h';
      return true; })()`);
    const histSpy = await ev(`(fetch('/history'), window.__hist)`);
    await ev(`(window.__hist = 0, true)`);
    for (let i = 0; i < 3; i++) { await ev(`(document.dispatchEvent(new Event('cc:social')), true)`); await sleep(80); }
    const histRepaint = await ev('window.__hist');
    await ev(`(Bay.go('career'), true)`); await sleep(60);
    await ev(`(Bay.go('home'), true)`); await sleep(150);
    const histEntry = (await ev('window.__hist')) - histRepaint;
    await ev(`(window.fetch = window.__fetch0, Cloud.token = window.__tok0, true)`);
    if (histSpy === 1 && histRepaint === 0 && histEntry === 0) ok(`${V}: /history is never fetched -- not on a repaint, not on entering home`);
    else fail(`${V}: /history fetched ${histRepaint} time(s) on three repaints, ${histEntry} on entering home (want 0 and 0; the spy counted ${histSpy} of its own probe, want 1)`);
  }
} catch (e) {
  fail('squad_ui stopped: ' + (e && e.message));
}

// ============================================================================
// TASK 9: THE SQUAD ITSELF -- the forming box, Ready, Leave, Start, the leader's
// Remove, the invite a connected player receives, and the Friends tab's rows.
// Its own viewport loop, on a freshly loaded page, so it shares no state with
// the checks above. Every roster below goes in through app.js's real handle(),
// so the real routing, the real CC_SQUAD write and the real bay.js render are
// what is measured; only the socket is a stub. Every control is pressed
// through the real delegated listener (click()), never by calling sqAct().
// A roster in these checks carries `held: true`, as every roster this server
// puts in the slot does (D-UI-1): the box gates every squad control on it.
try {
  const T9_MULE = '00000000-0000-4000-8000-0000000000cc';
  const T9_PIKE = '00000000-0000-4000-8000-0000000000dd';
  // D-UI-3 (task 9's fix pass): EVERY ROW CARRIES `rid`, the server's handle
  // for that row, kept while the row stands and never given to another. A
  // fixture row that is the SAME ROW across pushes keeps its handle -- the three
  // named players, and any row given one explicitly -- and an unnamed T9M() row
  // is a new row on every push, with a new handle, as the server would mint it.
  const T9R = (tag) => (tag + '0'.repeat(32)).slice(0, 32);
  const RID_YOU = T9R('a1'), RID_MULE = T9R('c1'), RID_PIKE = T9R('d1');
  let t9n = 0;
  const T9M = (o) => Object.assign({ id: null, rid: T9R('f' + (++t9n).toString(16)), callsign: null, guest: false, online: true, ready: false, dropped: false }, o);
  const T9YOU = (o) => T9M(Object.assign({ id: ME, rid: RID_YOU, callsign: 'Dusty Crag' }, o));
  const T9MULE = (o) => T9M(Object.assign({ id: T9_MULE, rid: RID_MULE, callsign: 'Steel Mule' }, o));
  const T9PIKE = (o) => T9M(Object.assign({ id: T9_PIKE, rid: RID_PIKE, callsign: 'Ridge Pike' }, o));
  // THE SERVER'S SEAT TABLE, for fixtures only (duel 2, ffa 2-4, boss 1-2,
  // aliens 1-2, golf 1-4). The box never computes this: it reads `fits`, and
  // check A2b hands it a `fits` this table would not produce to prove it.
  const t9fits = (n) => ({ duel: n === 2, ffa: n >= 2 && n <= 4, boss: n >= 1 && n <= 2, aliens: n >= 1 && n <= 2, golf: n >= 1 && n <= 4 });
  const t9rack = (picks) => ev(`(localStorage.setItem('cc_loadout', ${JSON.stringify(JSON.stringify(picks))}), true)`);
  const FIVE = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
  // A roster PUSH: no request id, exactly as the server fans one out.
  const t9state = async (patch) => {
    const n = (patch.members || []).length;
    await ev(`(handle(Object.assign({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)},
      mode: 'duel', tees: null, max: null, you: 0, held: true, members: [], fits: ${JSON.stringify(t9fits(n))} }, ${JSON.stringify(patch)})), true)`);
    await sleep(80);
  };
  // ONE READER FOR THE SQUAD PANE AND ONE FOR THE FRIENDS PANE. Visible means
  // rendered: a node carrying .hidden is in the tree for morphChildren's sake
  // and says nothing.
  const t9box = () => ev(`(() => {
    Bay.show('home');
    const pane = document.getElementById('sqPane-squad'), pnl = document.querySelector('#bay .pnl.sqx');
    if (!pane || !pnl) return null;
    const vis = (e) => !!e && !e.closest('.hidden') && e.getClientRects().length > 0;
    const q = (s, r) => (r || pane).querySelector(s);
    const btn = (s, r) => { const e = q(s, r); return vis(e) ? { t: e.textContent.trim(), dis: e.disabled, pressed: e.getAttribute('aria-pressed'), cy: e.classList.contains('cy') } : null; };
    const txt = (s) => { const e = q(s); return vis(e) ? e.textContent : ''; };
    const i = q('.sqi');
    const pr = pane.getBoundingClientRect();
    return {
      rows: [...pane.querySelectorAll('.sqml .sqm')].filter(vis).map((r) => ({
        name: (r.querySelector('.sqmt') || { textContent: null }).textContent, you: vis(r.querySelector('.sqmy')),
        lead: vis(r.querySelector('.sql')), tick: vis(r.querySelector('.sqr.on svg')),
        state: (r.querySelector('.sqr') || { textContent: '' }).textContent,
        dot: !!r.querySelector('.pdot svg'), lit: !!r.querySelector('.pdot.on'),
        menu: vis(r.querySelector('.pmb')), anon: !!r.querySelector('.pmb[data-pmanon="1"]'),
        kick: (() => { const k = r.querySelector('[data-sq^="kick:"]'); return vis(k) ? { v: k.dataset.sq, dis: k.disabled, label: k.getAttribute('aria-label') } : null; })(),
        over: r.scrollWidth > r.clientWidth + 1, imgs: r.querySelectorAll('img').length,
      })),
      summary: txt('.sqml .sqn'),
      add: vis(q('.sqadd')), invite: btn('.sqadd [data-sq="tab:friends"]'), link: btn('[data-sq="link"]'),
      seats: vis(q('.sqs')) ? [...pane.querySelectorAll('.sqs span')].map((s) => s.textContent + (s.classList.contains('on') ? '*' : '')) : [],
      note: txt('.sqnote'), line: txt('.sqft .sqfl'), foot: vis(q('.sqft')),
      start: btn('[data-sq="start"]'), ready: btn('[data-sq="ready"]'), leave: btn('[data-sq="leave"]'),
      kok: btn('[data-sq="kok"]'), kcancel: btn('[data-sq="kcancel"]'),
      aerr: txt('.sqft ~ .sqae, .sqml ~ .sqae'),
      rerr: (() => { const e = pane.querySelector(':scope > .sqe'); return vis(e) ? e.textContent : ''; })(),
      retry: btn('[data-sq="retry"]'),
      inv: vis(i) ? { t: (i.querySelector('.sqit') || { textContent: '' }).textContent, join: btn('[data-sq^="join:"]', i), ign: btn('[data-sq^="ignore:"]', i),
        err: (() => { const e = i.querySelector('.sqae'); return vis(e) ? e.textContent : ''; })() } : null,
      codes: document.querySelectorAll('#sqCode').length,
      codeInPane: !!pane.querySelector('#sqCode'),
      // THE SQUAD TAB (D-UI-4): its dot, its accessible name, and the invite
      // row's live region.
      tabDot: (() => { const t = document.getElementById('sqTab-squad'); return !!t && !t.querySelector('.sqd').classList.contains('hidden'); })(),
      tabLabel: (() => { const t = document.getElementById('sqTab-squad'); return t ? t.getAttribute('aria-label') : null; })(),
      invRole: (() => { const w = pane.querySelector('.sqiw'); return w ? w.getAttribute('role') : null; })(),
      invLive: !!(i && i.closest('[role="status"]')),
      // Where the one code field sits among the pane's own children: the typed
      // value survives a repaint only while this index does (morphChildren).
      codeAt: [...pane.children].findIndex((c) => c.querySelector && c.querySelector('#sqCode')),
      codeAfterRoster: (() => { const l = q('.sqml'), c = q('#sqCode'); return !!(l && c && (l.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)); })(),
      footIn: (() => { const f = q('.sqft'); if (!vis(f)) return null; const r = f.getBoundingClientRect(); return r.top >= pr.top - 0.5 && r.bottom <= pr.bottom + 0.5; })(),
      inside: pnl.getBoundingClientRect().bottom >= pr.bottom - 0.5,
      ownLaunch: !!pnl.querySelector('.launch, [data-launch]'),
      probeInBar: (() => { const lp = document.querySelector('#bay .launch, #bay [data-launch]'); return !!(lp && lp.closest('.lbar')); })(),
      bayOver: (() => { const b = document.getElementById('bay'); return b.scrollWidth > b.clientWidth || b.scrollHeight > b.clientHeight; })(),
    };
  })()`);
  const t9click = (sel) => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
  // A TAP ON A CONTROL THE RENDER HAS DISABLED, to prove the gate is in the
  // handler and not only in the attribute: a disabled attribute is a hint
  // about a DOM this client does not own for the whole of its life.
  const t9force = (sel) => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.removeAttribute('disabled'); b.click(); return true; })()`);
  // A BUTTON THE RENDER DID NOT DRAW, pressed through the real listener, in
  // either pane: the way to prove a handler refuses what a stale or forged DOM
  // asks of it.
  const t9press = (v, paneId = 'sqPane-squad') => ev(`(() => { const f = document.getElementById(${JSON.stringify(paneId)}); const b = document.createElement('button');
    b.dataset.sq = ${JSON.stringify(v)}; f.appendChild(b); b.click(); b.remove(); return true; })()`);
  // setTimeout, recorded while `fn` runs, so a check can see a timer a handler
  // set and fire it by hand rather than wait it out.
  const t9timers = async (fn) => {
    await ev(`(window.__t9timers = [], window.__st0 = window.setTimeout, window.setTimeout = (f, ms, ...a) => { window.__t9timers.push({ f, ms }); return window.__st0(f, ms, ...a); }, true)`);
    try { await fn(); } finally { await ev(`(window.setTimeout = window.__st0, true)`); }
  };
  // Every squad frame still out is answered, and the account starts over (a
  // fresh box), is introduced and is answered: nothing an earlier check left
  // in flight can hold `sq.busy` into the next block (review T9-R1-9).
  const t9settle = async () => {
    await ev(`(() => { for (const f of window.__tx.filter((x) => x.type === 'squad' && x.id != null)) handle({ type: 'squad', op: f.op === 'leave' ? 'left' : f.op, error: 'unavailable', id: f.id }); return true; })()`);
    await sleep(60);
    await setWho('out'); await setWho('in');
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    await clearTx();
  };

  for (const [w, h] of [[932, 430], [667, 375]]) {
    const V = `${w}x${h}`;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    let t9up = false;
    for (let i = 0; i < 80; i++) {
      if (await ev('!!window.Bay && typeof handle === "function" && !!document.querySelector("#bay .top")').catch(() => false)) { t9up = true; break; }
      await sleep(200);
    }
    if (!t9up) { fail(`${V}: page never became ready for the task 9 checks`); continue; }
    for (let k = 0; k < 40 && (await ev(`document.getElementById('bay').classList.contains('enter')`)); k++) await sleep(100);
    await ev(`(localStorage.removeItem('cc_squad'), true)`);
    await t9rack(FIVE);
    await stubSocket(); await setWho('in');
    // Introduced, then answered: this account holds no squad. The box KNOWS.
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    await clearTx();

    // ---- A1. THE LEADER'S FORMING BOX (design 5.1 state 3). Two of four, both
    //      ready, duel fits: rows with a DRAWN lamp, "(you)", Leader and the
    //      ready ticks, the dashed invite row carrying the code link, the Seats
    //      line lit by `fits`, the mode readout and a live Start -- and the
    //      one code field below the roster (D-UI-2).
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const a1 = await t9box();
    if (a1 && a1.rows.length === 2
        && a1.rows[0].name === 'Dusty Crag' && a1.rows[0].you && a1.rows[0].lead && a1.rows[0].tick && a1.rows[0].dot && a1.rows[0].lit
        && a1.rows[1].name === 'Steel Mule' && !a1.rows[1].you && !a1.rows[1].lead && a1.rows[1].tick
        && a1.add && a1.invite && !a1.invite.dis && a1.link && a1.link.t === 'Code QK7T' && !a1.link.dis
        && JSON.stringify(a1.seats) === JSON.stringify(['Duel 2*', 'FFA 2–4*', 'Boss 1–2*', 'Aliens 1–2*', 'Golf 1–4*'])
        && a1.line === 'Duel · 2' && a1.start && !a1.start.dis && a1.start.t === 'Start' && !a1.ready
        && a1.leave && !a1.leave.dis && a1.leave.t === 'Leave'
        && a1.codes === 1 && a1.codeInPane && a1.codeAfterRoster
        && !a1.ownLaunch && a1.probeInBar && a1.inside && !a1.bayOver && !a1.rows.some((r) => r.over))
      ok(`${V}: leader forming -- rows with a drawn lamp, (you), Leader and ticks, the dashed invite row with the code link, the Seats line lit by fits, Start and Leave live, and the one code field below the roster`);
    else fail(`${V}: leader forming ${JSON.stringify(a1)}`);
    // The leader's Remove and the player menu are on the OTHER row only.
    if (a1 && a1.rows.length === 2 && !a1.rows[0].menu && !a1.rows[0].kick && a1.rows[1].menu && a1.rows[1].kick && !a1.rows[1].kick.dis && a1.rows[1].kick.v === 'kick:' + RID_MULE)
      ok(`${V}: the leader sees Remove and the player menu on every row but their own`);
    else fail(`${V}: leader row controls ${JSON.stringify(a1 && a1.rows.map((r) => ({ menu: r.menu, kick: r.kick })))}`);

    // ---- A2. START REFUSED BY SEATS, BOTH WAYS (X6). Too big: three on a duel.
    //      Too small: one on a free-for-all. The footer keeps the spec's
    //      "<Mode> · seats N, squad M", which is true in both directions.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true }), T9PIKE({ ready: true })] });
    const a2 = await t9box();
    await t9state({ mode: 'ffa', members: [T9YOU({ ready: true })] });
    const a2s = await t9box();
    if (a2 && a2.start && a2.start.dis && a2.line === 'Duel · seats 2, squad 3'
        && JSON.stringify(a2.seats) === JSON.stringify(['Duel 2', 'FFA 2–4*', 'Boss 1–2', 'Aliens 1–2', 'Golf 1–4*'])
        && a2s && a2s.start && a2s.start.dis && a2s.line === 'Free-for-all · seats 2–4, squad 1')
      ok(`${V}: a squad too big or too small for the armed mode has a dead Start and a footer that says so`);
    else fail(`${V}: seats refusal ${JSON.stringify({ big: a2 && { dis: a2.start && a2.start.dis, line: a2.line, seats: a2.seats }, small: a2s && { dis: a2s.start && a2s.start.dis, line: a2s.line } })}`);
    // A2b. THE BOX READS `fits`, IT DOES NOT COUNT. Two members, which the seat
    //      table says fit a duel, and a frame that says they do not: the frame
    //      wins, because it is the one truth the boards read too.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })], fits: { duel: false, ffa: true, boss: true, aliens: true, golf: true } });
    const a2b = await t9box();
    if (a2b && a2b.start && a2b.start.dis && a2b.line === 'Duel · seats 2, squad 2' && a2b.seats[0] === 'Duel 2')
      ok(`${V}: Start and the Seats line follow the frame's fits, not a count of the rows`);
    else fail(`${V}: fits not read ${JSON.stringify(a2b && { dis: a2b.start && a2b.start.dis, line: a2b.line, seats: a2b.seats })}`);

    // ---- A3. START REFUSED BY READINESS. One flag different from A1. And a
    //      member who is DROPPED is not ready whatever their flag says (task 5:
    //      a dropped row can arrive ready, readied from another device before
    //      the drop): the row says Reconnecting, no tick, the lamp is dark.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: false })] });
    const a3 = await t9box();
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true, dropped: true })] });
    const a3d = await t9box();
    if (a3 && a3.rows.length === 2 && a3d && a3d.rows.length === 2 && a3.start && a3.start.dis && a3.line === 'Waiting for 1' && a3.rows[1].state === 'Not ready' && !a3.rows[1].tick
        && a3d && a3d.start && a3d.start.dis && a3d.line === 'Waiting for 1' && a3d.rows[1].state === 'Reconnecting' && !a3d.rows[1].tick && !a3d.rows[1].lit)
      ok(`${V}: a member not ready, or dropped though marked ready, holds Start and the footer counts them`);
    else fail(`${V}: readiness refusal ${JSON.stringify({ a3: a3 && { dis: a3.start && a3.start.dis, line: a3.line, row: a3.rows[1] }, a3d: a3d && { dis: a3d.start && a3d.start.dis, line: a3d.line, row: a3d.rows[1] } })}`);

    // ---- A4. THE RACK IS THE SQUAD MODE'S, NOT THE ARMED ONE'S. Five picks
    //      fill a duel; a Boss Fight squad drafts seven, whatever mode this
    //      device has armed on its own boards.
    await t9rack(['mortar', 'cluster', 'napalm']);
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const a4 = await t9box();
    await t9rack(FIVE);
    await t9state({ mode: 'boss', members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const a4b = await t9box();
    if (a4 && a4.start && a4.start.dis && a4.start.t === 'Pick 2 more' && a4b && a4b.start && a4b.start.dis && a4b.start.t === 'Pick 2 more'
        && (await ev('ccMode')) === 'duel')
      ok(`${V}: a rack short of the squad mode's draft holds Start and says how many more to pick`);
    else fail(`${V}: short rack ${JSON.stringify({ a4: a4 && a4.start, a4b: a4b && a4b.start, armed: await ev('ccMode') })}`);
    // AND THE OTHER WAY ROUND: seven picks stored, Duel armed on this device, a
    // Boss Fight squad. The rack is full for the squad's mode, so Start is live
    // and carries all seven -- read against the armed mode it would be cut to
    // five, and the leader could never start the mode their squad is in.
    const SEVEN = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley', 'buster', 'gas'];
    await t9rack(SEVEN);
    await t9state({ mode: 'boss', members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const a4c = await t9box();
    await clearTx(); await t9click('#bay [data-sq="start"]'); await sleep(40);
    const a4f = await squads();
    if (a4f.length) await reply({ op: 'start', error: 'capacity' });
    await t9rack(FIVE);
    if (a4c && a4c.start && !a4c.start.dis && a4c.start.t === 'Start' && a4f.length === 1 && JSON.stringify(a4f[0].loadout) === JSON.stringify(SEVEN)
        && (await ev('ccMode')) === 'duel')
      ok(`${V}: seven picks fill a Boss Fight squad's rack on a device armed on Duel, and Start carries all seven`);
    else fail(`${V}: full seven-pick rack ${JSON.stringify({ start: a4c && a4c.start, sent: a4f })}`);

    // ---- A5. THE MEMBER'S BOX (design 5.1 state 4): no Start, no Seats line,
    //      a cyan Ready toggle that carries its state as aria-pressed, Leave,
    //      and the sentence that names who decides. No Remove anywhere.
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: false }), T9MULE({ ready: true })] });
    const a5 = await t9box();
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const a5r = await t9box();
    if (a5 && a5.rows.length === 2 && !a5.start && a5.ready && a5.ready.cy && !a5.ready.dis && a5.ready.pressed === 'false' && a5.ready.t === 'Ready'
        && a5.leave && !a5.leave.dis && a5.leave.t === 'Leave'
        && !a5.rows[0].lead && a5.rows[1].lead && a5.seats.length === 0 && !a5.rows.some((r) => r.kick)
        && a5.note === 'Steel Mule picks the mode and starts. You will be placed in the room together.'
        && a5.line === 'Duel · 2'
        && a5r && a5r.ready && a5r.ready.pressed === 'true' && a5r.ready.t === 'Ready' && !a5r.ready.dis)
      ok(`${V}: member forming -- no Start, a cyan Ready toggle with its state in aria-pressed, Leave, the leader named, no Remove`);
    else fail(`${V}: member forming ${JSON.stringify({ a5, a5r: a5r && a5r.ready })}`);
    await t9rack(['mortar']);
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: false }), T9MULE({ ready: true })] });
    const a5s = await t9box();
    await t9rack(FIVE);
    if (a5s && a5s.ready && a5s.ready.dis && a5s.ready.t === 'Pick 4 more' && a5s.leave && !a5s.leave.dis)
      ok(`${V}: a member short of a full rack cannot stand up, and can still leave`);
    else fail(`${V}: member short rack ${JSON.stringify(a5s && { ready: a5s.ready, leave: a5s.leave })}`);

    // ---- A6. A FRAME THAT NAMES NO LEADER MUST NOT CROWN EVERY GUEST. A
    //      guest's id is null by construction, so a bare `p.id === leader`
    //      against a null leader would crown all of them at once.
    await t9state({ leader: null, members: [T9YOU({ ready: true }), T9M({ guest: true }), T9M({ guest: true })] });
    const a6 = await t9box();
    if (a6 && a6.rows.length === 3 && a6.rows.filter((r) => r.lead).length === 0 && !a6.start
        && a6.note === 'The squad leader picks the mode and starts. You will be placed in the room together.')
      ok(`${V}: a squad with no named leader crowns nobody, guests included, and gives nobody Start`);
    else fail(`${V}: leaderless squad ${JSON.stringify(a6 && { lead: a6.rows.map((r) => r.lead), start: a6.start, note: a6.note })}`);

    // ---- A7. A NULL CALLSIGN KEEPS ITS ROW, AND THE ROW STAYS ACTIONABLE.
    //      displayName() returns null legitimately and often; a blank row is a
    //      player nobody can report. A GUEST row has no id to report, but the
    //      leader can still remove it.
    const A7G = T9R('e7');
    await t9state({ members: [T9YOU({ ready: true }), T9M({ id: '00000000-0000-4000-8000-0000000000ee', callsign: null }), T9M({ guest: true, rid: A7G })] });
    const a7 = await t9box();
    if (a7 && a7.rows.length === 3 && a7.rows[1].name === 'No callsign' && a7.rows[1].menu && a7.rows[1].anon && a7.rows[1].kick
        && a7.rows[2].name === 'No callsign' && !a7.rows[2].menu && a7.rows[2].kick && a7.rows[2].kick.v === 'kick:' + A7G
        && a7.rows[1].kick.label === 'Remove this player from the squad' && a7.rows[2].kick.label === 'Remove this player from the squad'
        && !a7.rows[0].menu && !a7.rows.some((r) => r.over))
      ok(`${V}: a null callsign keeps its row, its menu and its placeholder mark; a guest row has Remove but no menu; Remove says "this player" to a screen reader; nothing overflows`);
    else fail(`${V}: null callsign ${JSON.stringify(a7 && a7.rows)}`);
    // A7b. A ROW THE SERVER GAVE NO HANDLE IS A ROW NO KICK CAN NAME (D-UI-3):
    //      it keeps its menu, and it has no Remove.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true, rid: undefined })] });
    const a7b = await t9box();
    if (a7b && a7b.rows.length === 2 && a7b.rows[1].name === 'Steel Mule' && a7b.rows[1].menu && !a7b.rows[1].kick)
      ok(`${V}: a row that carries no rid keeps its menu and offers no Remove`);
    else fail(`${V}: row without a rid ${JSON.stringify(a7b && a7b.rows[1])}`);

    // ---- A8. EVERY NAME GOES THROUGH esc(). Markup in a callsign arrives as text.
    await t9state({ members: [T9YOU({ ready: true }), T9M({ id: '00000000-0000-4000-8000-0000000000ff', callsign: '<img src=x onerror=1>' })] });
    const a8 = await t9box();
    if (a8 && a8.rows.length === 2 && a8.rows[1].name === '<img src=x onerror=1>' && a8.rows[1].imgs === 0)
      ok(`${V}: a callsign carrying markup renders as text, not as an element`);
    else fail(`${V}: esc ${JSON.stringify(a8 && a8.rows[1])}`);

    // ---- A9. EVERY SQUAD CONTROL WAITS FOR held === true (D-UI-1). A frame
    //      with no `held` (an older server) is still shown, and none of its
    //      controls are live: this socket may not be the one on the row.
    await ev(`(handle({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)}, mode: 'duel', tees: null, max: null, you: 0,
      members: [${JSON.stringify(T9YOU({ ready: true }))}, ${JSON.stringify(T9MULE({ ready: true }))}], fits: ${JSON.stringify(t9fits(2))} }), true)`);
    await sleep(80);
    const a9 = await t9box();
    if (a9 && a9.rows.length === 2 && a9.start && a9.start.dis && a9.rows[1].kick && a9.rows[1].kick.dis)
      ok(`${V}: a roster that does not say held:true shows its rows with every squad control dead`);
    else fail(`${V}: held gate ${JSON.stringify(a9 && { start: a9.start, kick: a9.rows[1] && a9.rows[1].kick })}`);

    // ---- A10. THE ONE CODE FIELD UNDER A SQUAD (D-UI-2). It is the pane's
    //       seventh child in every squad state -- with a refused re-ask and
    //       without -- so what the player typed survives a roster push, the
    //       refusal and its Retry (morphChildren is positional).
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await ev(`(document.getElementById('sqCode').value = 'RM4P', true)`);
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: false })] });
    const a10 = await t9box();
    const kept1 = await ev(`document.getElementById('sqCode').value`);
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);   // a new introduction asks again
    await reply({ error: 'unavailable' });
    const a10r = await t9box();
    const kept2 = await ev(`document.getElementById('sqCode').value`);
    await clearTx(); await t9click('#bay [data-sq="retry"]'); await sleep(60);
    await reply({ op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true,
      members: [T9YOU({ ready: true }), T9MULE({ ready: true })], fits: t9fits(2) });
    const a10b = await t9box();
    const kept3 = await ev(`document.getElementById('sqCode').value`);
    await ev(`(document.getElementById('sqCode').value = '', true)`);
    if (a10 && a10.codeAt === 6 && kept1 === 'RM4P'
        && a10r && a10r.codeAt === 6 && kept2 === 'RM4P' && a10r.rerr === 'Squads are not available right now. Try again later.'
        && a10r.retry && !a10r.retry.dis && !a10r.foot && !a10r.add && a10r.rows.length === 0
        && a10r.summary.includes('QK7T') && a10r.codes === 1
        && a10b && a10b.codeAt === 6 && kept3 === 'RM4P' && a10b.rerr === '' && !a10b.retry && a10b.foot && a10b.rows.length === 2)
      ok(`${V}: the code field keeps what was typed across a roster push, a refused re-ask and its Retry; under the refusal the squad is shown read-only, with no controls`);
    else fail(`${V}: code field under a squad ${JSON.stringify({ a10: a10 && a10.codeAt, kept1, a10r: a10r && { at: a10r.codeAt, rerr: a10r.rerr, retry: a10r.retry, foot: a10r.foot, add: a10r.add, rows: a10r.rows.length, summary: a10r.summary }, kept2, a10b: a10b && { at: a10b.codeAt, rerr: a10b.rerr, retry: a10b.retry, foot: a10b.foot }, kept3 })}`);

    // ---- A11. START STAYS IN VIEW. Four members overflow the pane, and the
    //       footer holding Start is pinned to its visible bottom rather than
    //       scrolled out of reach.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true }), T9PIKE({ ready: true }), T9M({ guest: true, ready: true })] });
    const a11 = await t9box();
    if (a11 && a11.rows.length === 4 && !a11.add && a11.footIn === true && a11.start && a11.inside && !a11.rows.some((r) => r.over))
      ok(`${V}: a full squad drops the invite row, and the footer holding Start stays inside the visible pane`);
    else fail(`${V}: full squad ${JSON.stringify(a11 && { rows: a11.rows.length, add: a11.add, footIn: a11.footIn, start: a11.start })}`);
    // ---- B1. READY SENDS ONE CORRELATED FRAME, WITH THE RACK, AND SAYS SO
    //      WHILE IT IS OUT. Standing down carries no rack: only standing up
    //      needs one (design 4.3). The server answers `ready` with its own op.
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: false }), T9MULE({ ready: true })] });
    await clearTx(); await t9click('#bay [data-sq="ready"]'); await sleep(60);
    const b1f = await squads(), b1 = await t9box();
    await reply({ op: 'ready', ok: true });
    const b1d = await t9box();
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await clearTx(); await t9click('#bay [data-sq="ready"]'); await sleep(60);
    const b1g = await squads();
    await reply({ op: 'ready', ok: true });
    if (b1f.length === 1 && b1f[0].op === 'ready' && b1f[0].ready === true && JSON.stringify(b1f[0].loadout) === JSON.stringify(FIVE)
        && typeof b1f[0].id === 'number' && b1 && b1.ready && b1.ready.t === 'Sending' && b1.ready.dis && b1.leave && b1.leave.dis
        && b1d && b1d.ready && !b1d.ready.dis && b1d.ready.t === 'Ready' && b1d.aerr === ''
        && b1g.length === 1 && b1g[0].op === 'ready' && b1g[0].ready === false && !('loadout' in b1g[0]))
      ok(`${V}: Ready sends one correlated frame carrying the rack, reads Sending while it is out, and standing down sends no rack`);
    else fail(`${V}: ready frames ${JSON.stringify({ b1f, b1g, out: b1 && { ready: b1.ready, leave: b1.leave }, back: b1d && b1d.ready })}`);
    // ---- B1b. STANDING DOWN NEVER NEEDS A RACK (review T9-R1-7): a member who
    //      is Ready and whose rack has since come up short can still stand down,
    //      with one frame that carries no rack.
    await t9rack(['mortar', 'cluster', 'napalm']);
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const b1s = await t9box();
    await clearTx(); await t9click('#bay [data-sq="ready"]'); await sleep(60);
    const b1sf = await squads();
    if (b1sf.length) await reply({ op: 'ready', ok: true });
    await t9rack(FIVE);
    if (b1s && b1s.ready && !b1s.ready.dis && b1s.ready.pressed === 'true' && b1sf.length === 1 && b1sf[0].op === 'ready' && b1sf[0].ready === false && !('loadout' in b1sf[0]))
      ok(`${V}: a Ready member whose rack has come up short can still stand down, with one frame and no rack`);
    else fail(`${V}: stand down, short rack ${JSON.stringify({ ready: b1s && b1s.ready, sent: b1sf })}`);

    // ---- B2. LEAVE. The server answers the leaver `left`, and the box says what
    //      the player did (task 8's end line), with the slot emptied.
    await clearTx(); await t9click('#bay [data-sq="leave"]'); await sleep(60);
    const b2f = await squads(), b2 = await t9box();
    await reply({ op: 'left', ok: true });
    const b2t = await ev(`(Bay.show('home'), document.getElementById('sqPane-squad').innerText)`);
    if (b2f.length === 1 && b2f[0].op === 'leave' && typeof b2f[0].id === 'number' && b2 && b2.leave && b2.leave.t === 'Leaving' && b2.leave.dis
        && b2t.includes('You left the squad.') && (await ev('window.CC_SQUAD')) === null)
      ok(`${V}: Leave sends one frame, reads Leaving while it is out, and the answer leaves the player out of the squad`);
    else fail(`${V}: leave ${JSON.stringify({ b2f, leave: b2 && b2.leave, text: b2t })}`);
    // ---- B2b. THE LEADER LEAVES TOO (D-UI-3). The same frame, the same answer:
    //      the server hands the lead to the earliest signed-in member (squads.js
    //      detach; test/squad.mjs (h3)). While it is out Start is dead as well.
    //      And the heir's box follows the roster that names them: a member told
    //      they now lead gets the leader's footer, Start and Leave.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await clearTx(); await t9click('#bay [data-sq="leave"]'); await sleep(60);
    const b2lf = await squads(), b2l = await t9box();
    await reply({ op: 'left', ok: true });
    const b2lt = await ev(`(Bay.show('home'), document.getElementById('sqPane-squad').innerText)`);
    const b2lslot = await ev('window.CC_SQUAD');
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const b2h0 = await t9box();
    await t9state({ leader: ME, members: [T9YOU({ ready: true })] });            // Steel Mule left: the lead is ours
    const b2h = await t9box();
    if (b2lf.length === 1 && b2lf[0].op === 'leave' && typeof b2lf[0].id === 'number' && Object.keys(b2lf[0]).sort().join() === 'id,op,type'
        && b2l && b2l.leave && b2l.leave.t === 'Leaving' && b2l.leave.dis && b2l.start && b2l.start.dis
        && b2lt.includes('You left the squad.') && b2lslot === null
        && b2h0 && !b2h0.start && b2h0.ready && b2h && b2h.start && b2h.leave && !b2h.leave.dis && !b2h.ready)
      ok(`${V}: the leader's Leave sends the one leave frame, holds Start while it is out, and a member the roster names leader gets Start and Leave`);
    else fail(`${V}: leader leave ${JSON.stringify({ b2lf, out: b2l && { leave: b2l.leave, start: b2l.start }, text: b2lt, slot: b2lslot, member: b2h0 && { start: b2h0.start, ready: b2h0.ready }, heir: b2h && { start: b2h.start, leave: b2h.leave, ready: b2h.ready } })}`);

    // ---- B3. START SENDS ONE FRAME WITH THE LEADER'S RACK (the server takes it
    //      as the leader's Ready for this start), and the box says Rolling out
    //      -- keeping every row on screen -- until the answer frees it.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await clearTx(); await t9click('#bay [data-sq="start"]'); await sleep(60);
    const b3f = await squads(), b3 = await t9box();
    await reply({ op: 'start', ok: true, code: 'RM7Q' });
    const b3d = await t9box();
    if (b3f.length === 1 && b3f[0].op === 'start' && JSON.stringify(b3f[0].loadout) === JSON.stringify(FIVE) && typeof b3f[0].id === 'number'
        && b3 && b3.line === 'Rolling out' && b3.start && b3.start.dis && b3.rows.length === 2
        && b3d && b3d.start && !b3d.start.dis && b3d.line === 'Duel · 2')
      ok(`${V}: Start sends one frame with the rack, says Rolling out with the rows kept, and the answer frees the footer`);
    else fail(`${V}: start ${JSON.stringify({ b3f, out: b3 && { line: b3.line, start: b3.start, rows: b3.rows.length }, back: b3d && { line: b3d.line, start: b3d.start } })}`);

    // ---- B4. EVERY REFUSAL OF A START SAYS ITS OWN SENTENCE, frees the footer,
    //      blames no connection for a server-side cause, and names nobody the
    //      server did not point at. `at` names the roster row at fault on
    //      member_offline and member_busy only; a null callsign there is never
    //      rendered as a name ("No callsign isn't ready" would be nonsense).
    //      member_offline is also what a live row gets while the server checks
    //      the blocks of a player who just signed in (task 6), so it must not
    //      say anyone disconnected.
    const NAMELESS = '00000000-0000-4000-8000-0000000000ee';
    const says = [
      ['member_offline', 1, "Steel Mule isn't ready to start yet."],
      ['member_offline', 2, "A player isn't ready to start yet."],
      ['member_offline', undefined, "A player isn't ready to start yet."],
      ['member_busy', 1, 'Steel Mule is still in a game or a lobby.'],
      ['member_busy', undefined, 'Someone in the squad is still in a game or a lobby.'],
      ['wrong_device', undefined, 'Start from the device you joined the squad on, or rejoin the squad on this one.'],
      ['not_leader', undefined, 'Only the squad leader can start.'],
      ['no_squad', undefined, 'Your squad has ended.'],
      ['no_rack', undefined, 'Your rack does not suit this mode. Check your weapons and try again.'],
      ['wont_fit', undefined, "Your squad does not fit this mode's seats."],
      ['not_ready', undefined, 'Not everyone in the squad is ready yet.'],
      ['capacity', undefined, 'The server is at capacity. Try again shortly.'],
      ['refused', undefined, 'That match could not be started. Try again.'],
      ['duplicate_member', 1, 'That match could not be started. Try again.'],
      ['slow_down', undefined, 'Too many tries. Wait a moment.'],
      ['unavailable', undefined, 'That match could not be started. Try again.'],
      ['a_code_from_a_newer_server', undefined, 'That match could not be started. Try again.'],
    ];
    const b4bad = [];
    for (const [code, at, line] of says) {
      await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true }), T9M({ id: NAMELESS, callsign: null, ready: true })],
        mode: 'ffa', fits: t9fits(3) });
      await clearTx(); await t9click('#bay [data-sq="start"]'); await sleep(40);
      const sent = (await squads()).length;
      await reply(at === undefined ? { op: 'start', error: code } : { op: 'start', error: code, at });
      const bx = await t9box();
      if (!(sent === 1 && bx && bx.aerr === line && bx.start && !bx.start.dis)) b4bad.push({ code, at, sent, aerr: bx && bx.aerr, start: bx && bx.start });
    }
    if (!b4bad.length) ok(`${V}: all ${says.length} start refusals say their own sentence and free Start`);
    else fail(`${V}: start refusals ${JSON.stringify(b4bad)}`);

    // ---- B5. THE LATCH. socialTx answers SYNCHRONOUSLY when the socket is down,
    //      so a busy flag set AFTER the call is set on top of the callback that
    //      already cleared it, and the control is dead for the rest of the
    //      session. Nothing is sent, the sentence is the offline one, and once
    //      the socket is back the control is usable.
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: false }), T9MULE({ ready: true })] });
    await clearTx(); await up(false);
    await t9force('#bay [data-sq="ready"]'); await sleep(60);
    const b5f = await squads();
    await up(true);
    const b5 = await t9box();
    if (b5f.length === 0 && b5 && b5.ready && !b5.ready.dis && b5.ready.t === 'Ready' && b5.aerr === 'Not connected. Try again in a moment.')
      ok(`${V}: a tap with the socket down sends nothing, says so, and leaves the control usable`);
    else fail(`${V}: offline latch ${JSON.stringify({ sent: b5f.length, ready: b5 && b5.ready, aerr: b5 && b5.aerr })}`);

    // ---- B6. THE GATES ARE IN THE HANDLER, NOT IN THE ATTRIBUTE. Each of these
    //      Starts and Readies is pressed with its disabled attribute stripped,
    //      and none may reach the server: a squad the mode has no seats for, a
    //      member not ready, a member dropped though ready, a short rack, a
    //      roster this socket does not say it holds, and a squad under a
    //      refused re-ask. The control run (B3) proves the same tap sends.
    const b6 = {};
    const gate = async (name, setup, sel) => { await setup(); await clearTx(); await t9force(sel); await sleep(50); b6[name] = (await squads()).length; };
    await gate('seats', () => t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true }), T9PIKE({ ready: true })] }), '#bay [data-sq="start"]');
    await gate('notReady', () => t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: false })] }), '#bay [data-sq="start"]');
    await gate('dropped', () => t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true, dropped: true })] }), '#bay [data-sq="start"]');
    await gate('shortStart', async () => { await t9rack(['mortar']); await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] }); }, '#bay [data-sq="start"]');
    await gate('shortReady', () => t9state({ leader: T9_MULE, members: [T9YOU({ ready: false }), T9MULE({ ready: true })] }), '#bay [data-sq="ready"]');
    await t9rack(FIVE);
    await gate('notHeld', async () => {
      await ev(`(handle({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)}, mode: 'duel', tees: null, max: null, you: 0,
        members: [${JSON.stringify(T9YOU({ ready: true }))}, ${JSON.stringify(T9MULE({ ready: true }))}], fits: ${JSON.stringify(t9fits(2))} }), true)`);
      await sleep(60);
    }, '#bay [data-sq="start"]');
    await gate('refused', async () => {
      await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
      await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
      await reply({ error: 'unavailable' });
    }, '#bay [data-sq="start"]');
    await clearTx(); await t9click('#bay [data-sq="retry"]'); await sleep(60);
    await reply({ op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true,
      members: [T9YOU({ ready: true }), T9MULE({ ready: true })], fits: t9fits(2) });
    // A MEMBER'S Start and a Leave on a roster this socket does not say it
    // holds: buttons the render never draws, pressed through the real listener.
    const pressed = async (name, setup, v) => {
      await setup(); await clearTx();
      await ev(`(() => { const b = document.createElement('button'); b.setAttribute('data-sq', ${JSON.stringify(v)});
        document.getElementById('sqPane-squad').appendChild(b); b.click(); b.remove(); return true; })()`);
      await sleep(50); b6[name] = (await squads()).length;
    };
    await pressed('memberStart', () => t9state({ leader: T9_MULE, members: [T9YOU({ ready: true }), T9MULE({ ready: true })] }), 'start');
    await pressed('leaderReady', () => t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] }), 'ready');
    await pressed('leaveNotHeld', async () => {
      await ev(`(handle({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(T9_MULE)}, mode: 'duel', tees: null, max: null, you: 0,
        members: [${JSON.stringify(T9YOU({ ready: true }))}, ${JSON.stringify(T9MULE({ ready: true }))}], fits: ${JSON.stringify(t9fits(2))} }), true)`);
      await sleep(60);
    }, 'leave');
    if (Object.keys(b6).length === 10 && Object.values(b6).every((n) => n === 0))
      ok(`${V}: Start, Ready and Leave pressed past a dead attribute send nothing: seats, readiness, a dropped member, a short rack, an unheld roster, a refused re-ask, a member's Start, a leader's Ready`);
    else fail(`${V}: handler gates ${JSON.stringify(b6)}`);

    // ---- B7. THE CODE LINK COPIES THE LINK, NOT THE CODE (design 4.4 / 5.7):
    //      /?squad=<code> is what an invite push opens. Nothing is sent.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await ev(`(window.__clip = null, navigator.clipboard.writeText = (t) => { window.__clip = t; return Promise.resolve(); }, true)`);
    await clearTx(); await t9click('#bay [data-sq="link"]'); await sleep(60);
    const clip = await ev('window.__clip'), b7f = await squads();
    if (clip === `http://127.0.0.1:${appPort}/?squad=QK7T` && b7f.length === 0)
      ok(`${V}: the code link copies /?squad=QK7T and sends nothing`);
    else fail(`${V}: code link copied ${JSON.stringify(clip)}, sent ${JSON.stringify(b7f)}`);
    // ---- C0. A CLEAN START FOR THE INVITE CHECKS (review T9-R1-9): a frame an
    //      earlier check left unanswered would keep the box busy, and every Join
    //      below would be dead for a reason that has nothing to do with invites.
    //      C1's live Join is what proves the box is idle.
    await t9settle();
    // ---- C1. THE INVITE YOU JUST RECEIVED (design 5.1 state 5), with no squad
    //      of your own. It is a PUSH with no request id (design 4.3), so it has
    //      to be routed ahead of socialReply's `if (m.id == null) return;` --
    //      left to fall through, the only invite a CONNECTED player ever got
    //      would be the push notification 4.4 declines to send them.
    const invite = (o) => ev(`(handle(Object.assign({ type: 'squad', op: 'invited', code: 'RM4P', from: { callsign: 'Steel Mule' }, size: 2, max: 4 }, ${JSON.stringify(o || {})})), true)`).then(() => sleep(80));
    // Out of the squad (a push the server sends a leaver's other tabs): the box
    // is in a no-squad state, with the code field.
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(60);
    await ev(`(document.getElementById('sqCode').value = 'ZX9K', true)`);
    const c1at = await ev(`[...document.getElementById('sqPane-squad').children].findIndex((c) => c.querySelector && c.querySelector('#sqCode'))`);
    const c1t = await ev('Date.now()');
    await invite();
    const c1 = await t9box();
    const c1slot = await ev('JSON.stringify(window.CC_SQUAD_INVITE)');
    const c1kept = await ev(`document.getElementById('sqCode').value`);
    const c1at2 = await ev(`[...document.getElementById('sqPane-squad').children].findIndex((c) => c.querySelector && c.querySelector('#sqCode'))`);
    await ev(`(document.getElementById('sqCode').value = '', true)`);
    if (c1 && c1.inv && c1.inv.t === 'Steel Mule invites you to their squad · 2 / 4' && c1.inv.join && !c1.inv.join.dis && c1.inv.join.t === 'Join'
        && c1.inv.ign && !c1.inv.ign.dis
        // CHANGED BY TASK 9's FIX PASS (D-UI-4): the slot also carries `at`, the
        // moment it arrived. Still read field by field: nothing else rides in.
        && (() => { const o = JSON.parse(c1slot || 'null'); return !!o && Object.keys(o).join() === 'code,from,size,max,at' && o.code === 'RM4P'
          && JSON.stringify(o.from) === '{"callsign":"Steel Mule"}' && o.size === 2 && o.max === 4 && Number.isFinite(o.at) && Math.abs(o.at - c1t) < 5000; })()
        && c1kept === 'ZX9K' && c1at === c1at2 && c1at >= 0)
      ok(`${V}: an invite from a connected friend lands as a row with Join and Ignore, and the code field keeps what was typed`);
    else fail(`${V}: invite row ${JSON.stringify({ inv: c1 && c1.inv, slot: c1slot, kept: c1kept, at: [c1at, c1at2] })}`);

    // ---- C2. THE SENDER'S NAME IS THE SERVER'S, AND IS TEXT. A callsign the
    //      server could not vouch for arrives null and is never shown as
    //      "No callsign"; markup arrives as text. A malformed frame is no invite.
    await invite({ code: 'RM5P', from: { callsign: null }, size: 3 });
    const c2a = await t9box();
    await invite({ code: 'RM6P', from: { callsign: '<img src=x onerror=1>' } });
    const c2b = await t9box();
    const c2imgs = await ev(`document.querySelectorAll('#bay .sqi img').length`);
    await invite({ code: 42 }); const c2c = await ev('window.CC_SQUAD_INVITE && window.CC_SQUAD_INVITE.code');
    await invite({ code: '<b>' }); const c2d = await ev('window.CC_SQUAD_INVITE && window.CC_SQUAD_INVITE.code');
    // A size or a seat count that is not one (review T9-R1-8, N05) reads the
    // defaults, one of four, rather than whatever the frame said.
    await invite({ code: 'RM6Q', size: 9, max: 0 }); const c2e = await t9box();
    await invite({ code: 'RM6R', size: 2.5, max: '4' }); const c2f = await t9box();
    if (c2a && c2a.inv && c2a.inv.t === 'A friend invites you to their squad · 3 / 4'
        && c2b && c2b.inv && c2b.inv.t === '<img src=x onerror=1> invites you to their squad · 2 / 4' && c2imgs === 0
        && c2c === 'RM6P' && c2d === 'RM6P'
        && c2e && c2e.inv && c2e.inv.t === 'Steel Mule invites you to their squad · 1 / 4' && c2f && c2f.inv && c2f.inv.t === 'Steel Mule invites you to their squad · 1 / 4')
      ok(`${V}: a nameless sender reads "A friend", a sender's markup is text, a malformed invite changes nothing, and a size or seat count out of bounds reads 1 / 4`);
    else fail(`${V}: invite names ${JSON.stringify({ a: c2a && c2a.inv, b: c2b && c2b.inv, imgs: c2imgs, c: c2c, d: c2d, e: c2e && c2e.inv, f: c2f && c2f.inv })}`);

    // ---- C3. IGNORE HIDES THIS INVITE, NOT INVITES, AND SENDS NOTHING. A
    //      different squad's invite still arrives; the ignored squad's does not.
    await invite();
    await clearTx(); await t9click('#bay [data-sq^="ignore:"]'); await sleep(60);
    const c3a = await t9box(), c3f = await squads();
    await invite({ code: 'QK7T', from: { callsign: 'Ridge Pike' }, size: 3 });
    const c3b = await t9box();
    await invite();
    const c3c = await t9box();
    if (c3a && !c3a.inv && c3f.length === 0 && c3b && c3b.inv && c3b.inv.t.indexOf('Ridge Pike') === 0 && c3c && !c3c.inv)
      ok(`${V}: Ignore hides that one squad's invite and sends nothing; another squad's still arrives, the ignored one does not`);
    else fail(`${V}: ignore ${JSON.stringify({ gone: c3a && !c3a.inv, sent: c3f.length, next: c3b && c3b.inv, again: c3c && c3c.inv })}`);

    // ---- C3b. A RECEIVED INVITE LASTS TEN MINUTES (D-UI-4; review T9-R1-4).
    //      Squad codes are four characters and minted again once free, so an
    //      invite kept for the life of the page could seat the player with
    //      strangers under a friend's name. It is stamped on arrival; an older
    //      one is not shown, lights nothing and joins nothing -- read by the
    //      render and the handler themselves -- and a timer set on arrival
    //      empties the slot when its time is up. The timer is caught as it is
    //      set and fired by hand; the clock is moved, never waited on.
    await t9timers(() => invite({ code: 'RM7P', from: { callsign: 'Ridge Pike' } }));
    const c3timer = await ev(`window.__t9timers.filter((t) => t.ms >= 600000 && t.ms <= 601000).length`);
    const c3new = await t9box();
    await ev(`(window.CC_SQUAD_INVITE.at = Date.now() - 599000, document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60);
    const c3old = await t9box();
    await ev(`(window.CC_SQUAD_INVITE.at = Date.now() + 60000, document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60);
    const c3ahead = await t9box();                // the clock set back since: an age that cannot be told is not offered
    await ev(`(window.CC_SQUAD_INVITE.at = Date.now() - 600001, document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60);
    const c3gone = await t9box();
    await clearTx(); await t9press('join:RM7P'); await sleep(50);
    const c3sent = await squads();
    if (c3sent.length) await reply({ op: 'join', error: 'full' });
    await ev(`(window.CC_SQUAD_INVITE.at = Date.now(), document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60);
    const c3back = await t9box();
    await ev(`(() => { const t = window.__t9timers.find((x) => x.ms >= 600000 && x.ms <= 601000); if (t) t.f(); return true; })()`); await sleep(60);
    const c3slot = await ev('window.CC_SQUAD_INVITE'), c3fired = await t9box();
    // A timer takes ITS OWN invite and nothing newer: a second invite has
    // arrived by the time the first one's ten minutes are up.
    await t9timers(() => invite({ code: 'RM7Q', from: { callsign: 'Ridge Pike' } }));
    await invite({ code: 'RM7R', from: { callsign: 'Steel Mule' } });
    await ev(`(() => { const t = window.__t9timers.find((x) => x.ms >= 600000 && x.ms <= 601000); if (t) t.f(); return true; })()`); await sleep(60);
    const c3kept = await ev('window.CC_SQUAD_INVITE && window.CC_SQUAD_INVITE.code'), c3keptRow = await t9box();
    if (c3timer === 1 && c3new && c3new.inv && c3new.tabDot && c3old && c3old.inv && c3ahead && !c3ahead.inv && c3gone && !c3gone.inv && !c3gone.tabDot && c3sent.length === 0
        && c3back && c3back.inv && c3slot === null && c3fired && !c3fired.inv && !c3fired.tabDot
        && c3kept === 'RM7R' && c3keptRow && c3keptRow.inv && c3keptRow.inv.t.indexOf('Steel Mule') === 0)
      ok(`${V}: an invite older than ten minutes is not shown, lights nothing and joins nothing, and the timer set on arrival empties the slot of that invite and no newer one`);
    else fail(`${V}: invite lifetime ${JSON.stringify({ timer: c3timer, fresh: c3new && [!!c3new.inv, c3new.tabDot], old: c3old && !!c3old.inv, ahead: c3ahead && !!c3ahead.inv, gone: c3gone && [!!c3gone.inv, c3gone.tabDot], sent: c3sent, back: c3back && !!c3back.inv, slot: c3slot, fired: c3fired && [!!c3fired.inv, c3fired.tabDot], kept: c3kept })}`);

    // ---- C3c. A PENDING INVITE LIGHTS THE SQUAD TAB'S DOT (D-UI-4; review
    //      T9-R1-6) -- seen from the Friends tab too, which is where a player
    //      building a squad is looking -- and the tab's name says it in words,
    //      because the dot is aria-hidden. The row is a status region, so a
    //      screen reader hears it arrive. Ignore puts the dot out.
    await invite({ code: 'RM8Q', from: { callsign: 'Steel Mule' }, size: 2 });
    await t9click('#bay [data-sq="tab:friends"]'); await sleep(40);
    const c3d = await t9box();
    await t9click('#bay [data-sq="tab:squad"]'); await sleep(40);
    const c3e = await t9box();
    await up(false);
    const c3off = await t9box();                  // no connection: the pane draws no row, so the tab points at none
    await up(true);
    await t9box();                                // repainted with the connection back
    await t9click('#bay [data-sq^="ignore:"]'); await sleep(40);
    const c3i = await t9box();
    if (c3d && c3d.tabDot && c3d.tabLabel === 'Squad, 0 of 4, invite waiting' && c3e && c3e.inv && c3e.invRole === 'status' && c3e.invLive
        && c3off && !c3off.inv && !c3off.tabDot && c3off.tabLabel === null
        && c3i && !c3i.inv && !c3i.tabDot && c3i.tabLabel === null && c3i.invRole === 'status')
      ok(`${V}: a pending invite lights the Squad tab's dot, from the Friends tab too, names it in the tab's label, sits in a status region, and Ignore puts it out`);
    else fail(`${V}: invite dot ${JSON.stringify({ fromFriends: c3d && [c3d.tabDot, c3d.tabLabel], row: c3e && [!!c3e.inv, c3e.invRole, c3e.invLive], offline: c3off && [!!c3off.inv, c3off.tabDot], ignored: c3i && [!!c3i.inv, c3i.tabDot, c3i.tabLabel] })}`);

    // ---- C4. JOIN SENDS ONE CORRELATED JOIN FRAME -- the code, this device's
    //      current name and paint -- and the row says so while it is out.
    await invite({ code: 'QK7T', from: { callsign: 'Steel Mule' }, size: 2 });
    await clearTx(); await t9click('#bay [data-sq^="join:"]'); await sleep(60);
    const c4f = await squads(), c4 = await t9box();
    // Ignore pressed while that Join is out (review T9-R1-8, N21): the row stays.
    await t9press('ignore:QK7T'); await sleep(40);
    const c4i = await t9box();
    const myName = await ev('myName()'), mySkin = await ev('mySkin()');
    if (c4f.length === 1 && c4f[0].op === 'join' && c4f[0].code === 'QK7T' && c4f[0].name === myName && typeof myName === 'string' && myName
        && c4f[0].skin === mySkin && typeof c4f[0].id === 'number'
        && c4 && c4.inv && c4.inv.join && c4.inv.join.t === 'Joining' && c4.inv.join.dis && c4.inv.ign && c4.inv.ign.dis
        && c4i && c4i.inv && c4i.inv.join && c4i.inv.join.t === 'Joining')
      ok(`${V}: Join sends one correlated join frame with the current name and paint, the row reads Joining while it is out, and an Ignore pressed meanwhile is refused`);
    else fail(`${V}: join frame ${JSON.stringify({ c4f, myName, mySkin, inv: c4 && c4.inv, ignored: c4i && c4i.inv })}`);
    // ---- C5. A REFUSED JOIN FREES THE ROW AND SAYS WHY INSIDE IT, in task 8's
    //      words for a join (the D-BLOCK line for no_such_squad).
    const joinSays = [['no_such_squad', 'No squad or game with that code.'], ['full', 'That squad is full.'],
      ['already_in', 'You are already in that squad on another device.'], ['unavailable', 'That squad could not be joined right now. Try again later.']];
    const c5bad = [];
    for (const [code, line] of joinSays) {
      if (code !== 'no_such_squad') { await clearTx(); await t9click('#bay [data-sq^="join:"]'); await sleep(40); }
      await reply({ op: 'join', error: code });
      const bx = await t9box();
      if (!(bx && bx.inv && bx.inv.err === line && bx.inv.join && !bx.inv.join.dis && bx.inv.join.t === 'Join')) c5bad.push({ code, inv: bx && bx.inv });
    }
    if (!c5bad.length) ok(`${V}: a refused join frees the row and says why inside it, for all ${joinSays.length} refusals`);
    else fail(`${V}: join refusals ${JSON.stringify(c5bad)}`);
    // ---- C6. A JOIN THAT LANDS. The roster reaches the slot first (the server
    //      answers the roster with the request's id), the box is the squad, and
    //      the invite it answered is spent: it does not come back when the
    //      player later leaves that squad.
    await clearTx(); await t9click('#bay [data-sq^="join:"]'); await sleep(40);
    await reply({ op: 'state', code: 'QK7T', leader: T9_MULE, mode: 'duel', tees: null, max: null, you: 1, held: true,
      members: [T9MULE({ ready: true }), T9YOU({ ready: false })], fits: t9fits(2) });
    const c6a = await t9box();
    await clearTx(); await t9click('#bay [data-sq="leave"]'); await sleep(40);
    await reply({ op: 'left', ok: true });
    const c6b = await t9box();
    if (c6a && c6a.rows.length === 2 && c6a.rows[1].you && !c6a.inv && c6a.ready && c6b && !c6b.inv && (await ev('window.CC_SQUAD')) === null)
      ok(`${V}: a join that lands shows the squad, and the invite it answered does not return after leaving`);
    else fail(`${V}: join landed ${JSON.stringify({ a: c6a && { rows: c6a.rows.length, inv: c6a.inv }, b: c6b && c6b.inv })}`);

    // ---- C7. AN INVITE WHILE IN ANOTHER SQUAD (design 7): it sits ABOVE the
    //      squad, and Join names the NEW squad. An invite to the squad you are
    //      standing in is not an invite.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await invite({ code: 'RM8P', from: { callsign: 'Ridge Pike' }, size: 3 });
    const c7a = await t9box();
    // Another action out (the leader's Start): Join waits for it (review
    // T9-R1-8, N14) -- the box has one action at a time.
    await clearTx(); await t9click('#bay [data-sq="start"]'); await sleep(40);
    const c7busy = await t9box();
    await reply({ op: 'start', error: 'refused' });
    await clearTx(); await t9click('#bay [data-sq^="join:"]'); await sleep(40);
    const c7f = await squads();
    await reply({ op: 'join', error: 'full' });
    await invite({ code: 'QK7T' });
    const c7b = await t9box();
    if (c7a && c7a.inv && c7a.inv.t.indexOf('Ridge Pike') === 0 && c7a.rows.length === 2 && c7f.length === 1 && c7f[0].code === 'RM8P'
        && c7b && !c7b.inv && c7busy && c7busy.line === 'Rolling out' && c7busy.inv && c7busy.inv.join && c7busy.inv.join.dis)
      ok(`${V}: an invite while in another squad sits above it and joins the new one, and waits while another action is out; an invite to your own squad is not shown`);
    else fail(`${V}: invite over a squad ${JSON.stringify({ a: c7a && { inv: c7a.inv, rows: c7a.rows.length }, busy: c7busy && { line: c7busy.line, inv: c7busy.inv }, sent: c7f, b: c7b && c7b.inv })}`);

    // ---- C8. AN INVITE BELONGS TO THE ACCOUNT IT WAS SENT TO. The same account
    //      again (a token refresh fires cc:account) keeps it; a sign-out drops it.
    await invite({ code: 'RM9P' });
    await ev(`(document.dispatchEvent(new CustomEvent('cc:account')), true)`); await sleep(40);
    const c8a = await ev('window.CC_SQUAD_INVITE && window.CC_SQUAD_INVITE.code');
    await setWho('out');
    const c8b = await ev('window.CC_SQUAD_INVITE');
    await setWho('in');
    const c8c = await t9box();
    if (c8a === 'RM9P' && c8b === null && c8c && !c8c.inv)
      ok(`${V}: a token refresh keeps the invite and a sign-out drops it`);
    else fail(`${V}: invite across accounts ${JSON.stringify({ same: c8a, out: c8b, back: c8c && c8c.inv })}`);
    // ---- C8b. AN INVITE THAT LANDS AFTER A SIGN-OUT IS NOT KEPT (review
    //      T9-R1-5). The server treats the socket as the old account until the
    //      sign-out's hello reaches it, so an invite can arrive AFTER the account
    //      event has cleared the slot. A page with no linked account on it holds
    //      no invite -- a guest can be neither invited nor the one an invite was
    //      for -- so it is dropped, even for a guest standing in a squad, where
    //      the row would be drawn.
    await setWho('guest');
    await t9state({ leader: T9_MULE, you: 1, members: [T9MULE({ ready: true }), T9M({ guest: true, rid: T9R('e8') })] });
    await invite({ code: 'RM2P' });
    const c8g = await t9box(), c8gs = await ev('window.CC_SQUAD_INVITE');
    await setWho('out');
    await invite({ code: 'RM2P' });
    const c8os = await ev('window.CC_SQUAD_INVITE');
    await setWho('in');
    if (c8g && c8g.rows.length === 2 && !c8g.inv && !c8g.tabDot && c8gs === null && c8os === null)
      ok(`${V}: an invite that lands on a page with no linked account -- a guest in a squad, or signed out -- is dropped`);
    else fail(`${V}: invite after a sign-out ${JSON.stringify({ guest: c8g && { rows: c8g.rows.length, inv: c8g.inv }, guestSlot: c8gs, outSlot: c8os })}`);
    // (C8 signed the account out and back in: introduce it and answer, so the
    //  box knows again.)
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    // A button the render did not draw, pressed through the real listener: the
    // way to prove a handler refuses what a stale or forged DOM asks of it.
    const t9inject = (sq9) => ev(`(() => { const f = document.getElementById('sqPane-squad'); const b = document.createElement('button');
      b.dataset.sq = ${JSON.stringify(sq9)}; f.appendChild(b); b.click(); b.remove(); return true; })()`);

    // ---- D1. THE LEADER'S REMOVE ASKS FIRST (C11): "Remove <name> from the
    //      squad?" in the footer, with Cancel -- which holds the keyboard, so a
    //      stray Enter removes nobody -- and Remove. Nothing is sent to ask.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await clearTx(); await t9click(`#bay [data-sq="kick:${RID_MULE}"]`); await sleep(60);
    const d1 = await t9box(), d1f = await squads(), d1focus = await ev(`document.activeElement && document.activeElement.getAttribute('data-sq')`);
    await t9click('#bay [data-sq="kcancel"]'); await sleep(60);
    const d1c = await t9box(), d1cf = await squads();
    if (d1 && d1.line === 'Remove Steel Mule from the squad?' && d1.kok && !d1.kok.dis && d1.kok.t === 'Remove' && d1.kcancel && !d1.start
        && d1f.length === 0 && d1focus === 'kcancel'
        && d1c && !d1c.kok && d1c.start && d1c.line === 'Duel · 2' && d1cf.length === 0)
      ok(`${V}: Remove asks "Remove Steel Mule from the squad?" with the keyboard on Cancel, and Cancel sends nothing`);
    else fail(`${V}: remove confirm ${JSON.stringify({ d1: d1 && { line: d1.line, kok: d1.kok, kcancel: d1.kcancel, start: d1.start }, sent: d1f, focus: d1focus, after: d1c && { kok: d1c.kok, line: d1c.line }, sent2: d1cf })}`);

    // ---- D2. A ROW IS NAMED BY ITS HANDLE, `rid` (D-UI-3; CHANGED BY TASK 9's
    //      FIX PASS: an account row was named by its id). The frame's `id` is only
    //      the correlation socialSend mints. The server answers the leader with
    //      the roster, and the confirm goes with the row.
    await clearTx(); await t9click(`#bay [data-sq="kick:${RID_MULE}"]`); await sleep(40);
    await t9click('#bay [data-sq="kok"]'); await sleep(60);
    const d2f = await squads(), d2 = await t9box();
    // Cancel pressed while that Remove is out (review T9-R1-8, N07): the
    // question stays until the answer comes.
    await t9press('kcancel'); await sleep(40);
    const d2k = await t9box();
    await reply({ op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true,
      members: [T9YOU({ ready: true })], fits: t9fits(1) });
    const d2d = await t9box();
    if (d2f.length === 1 && d2f[0].op === 'kick' && d2f[0].rid === RID_MULE && typeof d2f[0].id === 'number' && !('i' in d2f[0])
        && d2 && d2.kok && d2.kok.t === 'Removing' && d2.kok.dis && d2.kcancel && d2.kcancel.dis && d2k && d2k.kok && d2k.kok.t === 'Removing'
        && d2d && d2d.rows.length === 1 && !d2d.kok && d2d.start && d2d.aerr === '')
      ok(`${V}: Remove names an account row by its rid, reads Removing while out, and the roster that answers it closes the question`);
    else fail(`${V}: kick by rid ${JSON.stringify({ d2f, out: d2 && { kok: d2.kok, kcancel: d2.kcancel }, back: d2d && { rows: d2d.rows.length, kok: d2d.kok, aerr: d2d.aerr } })}`);

    // ---- D3. A GUEST ROW HAS NO ID, AND NEEDS NONE: it is named by its handle
    //      like any other row (CHANGED BY TASK 9's FIX PASS: it was its INDEX,
    //      `i`). The question never calls it "No callsign".
    const D3G = T9R('e3');
    await t9state({ members: [T9YOU({ ready: true }), T9M({ guest: true, rid: D3G, ready: true })] });
    await clearTx(); await t9click(`#bay [data-sq="kick:${D3G}"]`); await sleep(40);
    const d3 = await t9box();
    await t9click('#bay [data-sq="kok"]'); await sleep(60);
    const d3f = await squads();
    await reply({ op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true,
      members: [T9YOU({ ready: true })], fits: t9fits(1) });
    if (d3 && d3.line === 'Remove this player from the squad?' && d3f.length === 1 && d3f[0].op === 'kick' && d3f[0].rid === D3G && !('i' in d3f[0]) && typeof d3f[0].id === 'number')
      ok(`${V}: a guest row is removed by its rid, and the question says "this player"`);
    else fail(`${V}: kick a guest ${JSON.stringify({ line: d3 && d3.line, d3f })}`);

    // ---- D4. THE QUESTION IS PINNED TO ITS ROW'S HANDLE (D-UI-3). CHANGED BY
    //      TASK 9's FIX PASS: a guest's question used to die with the roster
    //      frame it was asked on, because an index was all the server took for a
    //      guest (task 2's review: an earlier row leaving shifts every later guest
    //      up one). Every row now has a `rid`, so the question follows its row
    //      wherever the roster moves it, and is withdrawn the moment that row is
    //      gone -- even when another guest, who looks the same on the wire, has
    //      taken its place. A Remove that arrives anyway sends nothing and says why.
    const G1 = T9R('e1'), G2 = T9R('e2'), G3 = T9R('e3');
    await t9state({ members: [T9YOU({ ready: true }), T9M({ guest: true, rid: G1, ready: true }), T9M({ guest: true, rid: G2, ready: false })] });
    await clearTx(); await t9click(`#bay [data-sq="kick:${G2}"]`); await sleep(40);
    const d4a = await t9box();
    await t9state({ members: [T9YOU({ ready: true }), T9M({ guest: true, rid: G2, ready: false })] });   // the first guest left
    const d4b = await t9box();
    await t9click('#bay [data-sq="kok"]'); await sleep(60);
    const d4f = await squads();
    await reply({ op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true,
      members: [T9YOU({ ready: true })], fits: t9fits(1) });
    if (d4a && d4a.line === 'Remove this player from the squad?' && d4b && d4b.kok && d4b.line === 'Remove this player from the squad?'
        && d4f.length === 1 && d4f[0].op === 'kick' && d4f[0].rid === G2)
      ok(`${V}: a guest's Remove survives a row above it leaving, and names that guest by its rid`);
    else fail(`${V}: moved guest remove ${JSON.stringify({ asked: d4a && d4a.line, after: d4b && { kok: d4b.kok, line: d4b.line }, sent: d4f })}`);
    // SAME SHAPE, ANOTHER GUEST: the guest asked about leaves and a new one
    // joins into their place. The question does not come back to them.
    await t9state({ members: [T9YOU({ ready: true }), T9M({ guest: true, rid: G1 }), T9M({ guest: true, rid: G2 })] });
    await clearTx(); await t9click(`#bay [data-sq="kick:${G2}"]`); await sleep(40);
    await t9state({ members: [T9YOU({ ready: true }), T9M({ guest: true, rid: G1 }), T9M({ guest: true, rid: G3 })] });
    const d4x = await t9box();
    await t9inject('kok'); await sleep(60);
    const d4xf = await squads(), d4xc = await t9box();
    if (d4xf.length) await reply({ op: 'kick', error: 'no_such_member' });   // an answer, so a red run does not cascade
    if (d4x && !d4x.kok && d4x.start && d4xf.length === 0 && d4xc && d4xc.aerr === 'The squad changed. Check the list and try again.')
      ok(`${V}: a guest's Remove is withdrawn when that guest goes, even with another guest in the same place, and a late Remove sends nothing and says why`);
    else fail(`${V}: guest remove came back ${JSON.stringify({ kok: d4x && d4x.kok, line: d4x && d4x.line, sent: d4xf, aerr: d4xc && d4xc.aerr })}`);
    // AN ACCOUNT ROW THE SAME WAY: an earlier row leaves, the question stays.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true }), T9PIKE({ ready: true })] });
    await clearTx(); await t9click(`#bay [data-sq="kick:${RID_PIKE}"]`); await sleep(40);
    await t9state({ members: [T9YOU({ ready: true }), T9PIKE({ ready: true })] });              // Steel Mule left
    const d4d = await t9box();
    await t9click('#bay [data-sq="kok"]'); await sleep(60);
    const d4g = await squads();
    await reply({ op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true,
      members: [T9YOU({ ready: true })], fits: t9fits(1) });
    // AND NOT INTO ANOTHER SQUAD: a question asked in one squad is not about a
    // row of the next one this tab holds, whatever that row carries.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await clearTx(); await t9click(`#bay [data-sq="kick:${RID_MULE}"]`); await sleep(40);
    await t9state({ code: 'RM4P', members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const d4e = await t9box();
    await t9inject('kok'); await sleep(60);
    const d4ef = await squads();
    if (d4ef.length) await reply({ op: 'kick', error: 'no_such_member' });
    if (d4d && d4d.line === 'Remove Ridge Pike from the squad?' && d4g.length === 1 && d4g[0].rid === RID_PIKE
        && d4e && !d4e.kok && d4e.start && d4ef.length === 0)
      ok(`${V}: an account's Remove survives the roster moving, and no question carries over into another squad`);
    else fail(`${V}: stale remove ${JSON.stringify({ acct: d4d && d4d.line, acctSent: d4g, other: d4e && { kok: d4e.kok, line: d4e.line }, otherSent: d4ef })}`);

    // ---- D5. EVERY REFUSAL OF A REMOVE SAYS ITS OWN SENTENCE, and the question
    //      closes. sign_in comes back as the sign-in gate's {type:'social'} frame.
    const kickSays = [['not_leader', 'Only the squad leader can remove a player.'], ['no_such_member', 'That player is no longer in your squad.'],
      ['slow_down', 'Too many tries. Wait a moment.'], ['unavailable', 'Squads are not available right now. Try again later.'],
      ['sign_in', 'Sign in to manage your squad.']];
    const d5bad = [];
    for (const [code, line] of kickSays) {
      await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
      await clearTx(); await t9click(`#bay [data-sq="kick:${RID_MULE}"]`); await sleep(40);
      await t9click('#bay [data-sq="kok"]'); await sleep(40);
      await reply(code === 'sign_in' ? { type: 'social', error: 'sign_in' } : { op: 'kick', error: code });
      const bx = await t9box();
      if (!(bx && bx.aerr === line && !bx.kok && bx.start)) d5bad.push({ code, aerr: bx && bx.aerr, kok: bx && bx.kok });
    }
    if (!d5bad.length) ok(`${V}: all ${kickSays.length} refusals of a Remove say their own sentence and close the question`);
    else fail(`${V}: remove refusals ${JSON.stringify(d5bad)}`);

    // ---- D6. ONLY THE LEADER, ONLY ANOTHER ROW, ONLY A ROSTER THIS SOCKET HOLDS.
    //      Each asked through a button the render never drew -- and then its
    //      Remove, too: the footer draws no question for a member at all, so
    //      what proves a question was never opened is that a Remove after it
    //      finds nothing to answer (nothing sent, nothing said).
    const d6 = {};
    const CHANGED = 'The squad changed. Check the list and try again.';
    const askNothing = async (name, setup, v) => {
      await setup(); await clearTx();
      await t9inject(v); await sleep(40);
      const a = await t9box();
      await t9inject('kok'); await sleep(40);
      const b = await t9box();
      d6[name] = { asked: !!(a && a.kok), said: !!(b && b.aerr === CHANGED), sent: (await squads()).length };
    };
    await askNothing('member', () => t9state({ leader: T9_MULE, members: [T9YOU({ ready: true }), T9MULE({ ready: true }), T9PIKE({ ready: true })] }), 'kick:' + RID_PIKE);
    await askNothing('self', () => t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] }), 'kick:' + RID_YOU);
    await askNothing('nobody', () => t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] }), 'kick:' + T9R('b7'));
    // The old form: a row's INDEX is no handle (D-UI-3), and opens nothing.
    await askNothing('index', () => t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] }), 'kick:1');
    await askNothing('notHeld', async () => {
      await ev(`(handle({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)}, mode: 'duel', tees: null, max: null, you: 0,
        members: [${JSON.stringify(T9YOU({ ready: true }))}, ${JSON.stringify(T9MULE({ ready: true }))}], fits: ${JSON.stringify(t9fits(2))} }), true)`);
      await sleep(60);
    }, 'kick:' + RID_MULE);
    if (Object.keys(d6).length === 5 && Object.values(d6).every((x) => !x.asked && !x.said && x.sent === 0))
      ok(`${V}: no question opens for a member, for your own row, for a handle that is not there, for an index, or on a roster not held`);
    else fail(`${V}: remove gates ${JSON.stringify(d6)}`);
    // ---- THE FRIENDS TAB'S ROWS (C11, design 5.1 "Friends tab states"), under
    //      task 8's count lines: a Request · n section with Accept and a drawn
    //      Decline, and a Friends · total section with the lamp, the callsign
    //      and either "In your squad" or Invite. Invite with no squad creates one
    //      first. The owner wants the inviter told whether the invite went out
    //      (D-BLOCK-2 E, revised): one line under that friend's row, and the
    //      button reads Invited until the next roster or thirty seconds.
    const T9_NIA = '00000000-0000-4000-8000-000000000011', T9_GHOST = '00000000-0000-4000-8000-000000000012';
    const FR9 = { friends: [{ id: T9_MULE, callsign: 'Steel Mule', online: true }, { id: T9_PIKE, callsign: 'Ridge Pike', online: false },
      { id: T9_GHOST, callsign: null, online: true }], requests: { in: [{ id: T9_NIA, callsign: 'Nia Vale' }], out: [] },
      blocked: [], friendCode: 'AB12CD', callsign: null };
    const t9fr = () => ev(`(() => {
      Bay.show('home');
      const p = document.getElementById('sqPane-friends'); if (!p) return null;
      const vis = (e) => !!e && !e.closest('.hidden') && e.getClientRects().length > 0;
      const btn = (e) => (vis(e) ? { t: e.textContent.trim(), dis: e.disabled, title: e.getAttribute('title'), label: e.getAttribute('aria-label') } : null);
      const rows = (k) => [...p.querySelectorAll('.sqfr[data-row^="' + k + ':"]')].map((r) => ({
        name: (r.querySelector('.sqmt') || { textContent: null }).textContent, lit: !!r.querySelector('.pdot.on'), dot: !!r.querySelector('.pdot'),
        inv: btn(r.querySelector('[data-sq^="invite:"]')), acc: btn(r.querySelector('[data-sq^="accept:"]')),
        desc: (() => { const b = r.querySelector('[data-sq^="invite:"]'); return b ? b.getAttribute('aria-describedby') : null; })(),
        dec: btn(r.querySelector('[data-sq^="decline:"]')), decSvg: !!r.querySelector('[data-sq^="decline:"] svg'),
        mine: vis(r.querySelector('.sqy')) ? r.querySelector('.sqy').textContent.trim() : '', tick: !!r.querySelector('.sqy svg'),
        menu: vis(r.querySelector('.pmb')), anon: !!r.querySelector('.pmb[data-pmanon="1"]'), over: r.scrollWidth > r.clientWidth + 1,
        line: (() => { const n = r.nextElementSibling; return n && (n.classList.contains('sqae') || n.classList.contains('sqnt')) && vis(n)
          ? { t: n.textContent, bad: n.classList.contains('sqae') } : null; })(),
      }));
      const why = p.querySelector('#sqInvWhy');
      return { heads: [...p.querySelectorAll('.sqh')].filter(vis).map((h) => h.textContent), req: rows('r'), fr: rows('f'),
        why: vis(why) ? why.textContent : '',
        text: p.innerText.replace(/\\s+/g, ' ').trim(), add: !!p.querySelector('[data-go="friends"]'), imgs: p.querySelectorAll('img').length };
    })()`);
    const friendsIn = async (snap9) => { await ev(`(window.CC_SOCIAL = ${JSON.stringify(snap9)}, document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60); };
    // Nothing an earlier check left out holds the box busy (review T9-R1-9).
    await t9settle();
    // Leave any squad: a push the server sends a leaver's other tabs.
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(60);
    await friendsIn(FR9);
    await t9click('#bay [data-sq="tab:friends"]'); await sleep(60);

    // ---- E1. THE ROWS. Task 8's count lines stay above them; every name is
    //      esc()'d; a nameless friend keeps a row with the placeholder mark; the
    //      Decline is drawn; nothing overflows the box.
    const e1 = await t9fr();
    const R = (list, i) => (list && list[i]) || {};
    if (e1 && e1.text.startsWith('Your friends · 3 2 online now. 1 request waiting for an answer.') && e1.add
        && JSON.stringify(e1.heads) === JSON.stringify(['Requests · 1', 'Friends · 3'])
        && e1.req.length === 1 && R(e1.req, 0).name === 'Nia Vale' && R(e1.req, 0).acc && !R(e1.req, 0).acc.dis
        && R(e1.req, 0).dec && !R(e1.req, 0).dec.dis && R(e1.req, 0).dec.label === 'Decline Nia Vale' && R(e1.req, 0).decSvg && R(e1.req, 0).menu
        && e1.fr.length === 3
        && R(e1.fr, 0).name === 'Steel Mule' && R(e1.fr, 0).lit && R(e1.fr, 0).inv && R(e1.fr, 0).inv.t === 'Invite' && !R(e1.fr, 0).inv.dis && R(e1.fr, 0).menu
        && R(e1.fr, 1).name === 'Ridge Pike' && !R(e1.fr, 1).lit && R(e1.fr, 1).dot && R(e1.fr, 1).inv && !R(e1.fr, 1).inv.dis
        && R(e1.fr, 2).name === 'No callsign' && R(e1.fr, 2).anon && R(e1.fr, 2).inv
        && !e1.req.concat(e1.fr).some((r) => r.over) && e1.why === '' && !e1.fr.some((r) => r.desc))
      ok(`${V}: the Friends tab lists the request with Accept and a drawn Decline, and each friend with a lamp, Invite and the menu, under the counts`);
    else fail(`${V}: friends rows ${JSON.stringify(e1)}`);
    // E1b. A REQUEST WITH NO NAME: Decline says "this player" to a screen reader,
    //      never "No callsign" (review T9-R1-12).
    await friendsIn({ ...FR9, requests: { in: [{ id: T9_NIA, callsign: null }], out: [] } });
    const e1b = await t9fr();
    await friendsIn(FR9);
    if (e1b && R(e1b.req, 0).dec && R(e1b.req, 0).dec.label === 'Decline this player' && R(e1b.req, 0).name === 'No callsign')
      ok(`${V}: a nameless request's Decline is labelled "Decline this player"`);
    else fail(`${V}: nameless decline ${JSON.stringify(e1b && e1b.req)}`);

    // ---- E2. INVITE WITH NO SQUAD CREATES ONE FIRST, and invites only once the
    //      squad it is for is in the slot. Then the owner's note, and Invited.
    await clearTx(); await t9click(`#bay [data-sq="invite:${T9_MULE}"]`); await sleep(60);
    const e2a = await squads(), e2ab = await t9fr();
    const e2name = await ev('myName()'), e2skin = await ev('mySkin()');
    await reply({ op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true,
      members: [T9YOU({ ready: false })], fits: t9fits(1) });
    const e2b = await squads();
    await t9timers(() => reply({ op: 'invite', ok: true, delivered: 'online' }));
    const e2 = await t9fr();
    // CHANGED BY TASK 9's FIX PASS (review T9-R1-1): the create carries this
    // device's current name and paint, as join does -- the leader's row is
    // built from this frame, and Start seats them under it.
    if (e2a.length === 1 && e2a[0].op === 'create' && typeof e2a[0].id === 'number'
        && typeof e2name === 'string' && e2name && e2a[0].name === e2name && typeof e2a[0].skin === 'string' && e2a[0].skin === e2skin && R(e2ab.fr, 0).inv && R(e2ab.fr, 0).inv.t === 'Inviting' && R(e2ab.fr, 0).inv.dis
        && e2b.length === 2 && e2b[1].op === 'invite' && e2b[1].to === T9_MULE && typeof e2b[1].id === 'number'
        && e2 && R(e2.fr, 0).line && R(e2.fr, 0).line.t === 'Invite sent to Steel Mule.' && !R(e2.fr, 0).line.bad
        && R(e2.fr, 0).inv && R(e2.fr, 0).inv.t === 'Invited' && R(e2.fr, 0).inv.dis
        && R(e2.fr, 1).inv && !R(e2.fr, 1).inv.dis)
      ok(`${V}: Invite with no squad creates it with this device's name and paint, invites once the squad is in the slot, says "Invite sent to Steel Mule." and marks that friend Invited`);
    else fail(`${V}: create then invite ${JSON.stringify({ name: e2name, skin: e2skin, first: e2a, then: e2b, during: R(e2ab && e2ab.fr, 0).inv, after: e2 && e2.fr.map((r) => ({ inv: r.inv, line: r.line })) })}`);

    // ---- E3a. THE THIRTY SECONDS END BY THEMSELVES (review T9-R1-8, N31): the
    //      invite's answer sets a timer, and that timer alone repaints the row.
    //      Fired by hand with the clock moved; the DOM is read without any other
    //      repaint.
    const e3timer = await ev(`window.__t9timers.filter((t) => t.ms > 30000 && t.ms < 31000).length`);
    await ev(`(() => { const t = window.__t9timers.find((x) => x.ms > 30000 && x.ms < 31000); const n0 = Date.now; Date.now = () => n0() + 31000;
      try { if (t) t.f(); } finally { Date.now = n0; } return true; })()`);
    const e3raw = await ev(`(() => { const b = document.querySelector('#sqPane-friends [data-sq="invite:${T9_MULE}"]'); return b ? { t: b.textContent.trim(), dis: b.disabled } : null; })()`);
    if (e3timer === 1 && e3raw && e3raw.t === 'Invite' && !e3raw.dis)
      ok(`${V}: the timer set with Invited repaints the row back to Invite by itself`);
    else fail(`${V}: invited timer ${JSON.stringify({ timers: e3timer, row: e3raw })}`);
    // ---- E3. INVITED LASTS UNTIL THE NEXT ROSTER OR THIRTY SECONDS. The clock
    //      is moved rather than waited on.
    await ev(`(window.__now0 = Date.now, Date.now = () => window.__now0() + 31000, true)`);
    const e3a = await t9fr();
    await ev(`(Date.now = window.__now0, true)`);
    const e3b = await t9fr();                                      // the same mark, back in its thirty seconds
    await t9state({ members: [T9YOU({ ready: true })] });          // any new roster
    const e3c = await t9fr();
    if (e3a && R(e3a.fr, 0).inv && R(e3a.fr, 0).inv.t === 'Invite' && !R(e3a.fr, 0).inv.dis
        && e3b && R(e3b.fr, 0).inv && R(e3b.fr, 0).inv.t === 'Invited' && e3c && R(e3c.fr, 0).inv && R(e3c.fr, 0).inv.t === 'Invite' && !R(e3c.fr, 0).inv.dis)
      ok(`${V}: Invited turns back into Invite after thirty seconds, and on the next roster`);
    else fail(`${V}: invited mark ${JSON.stringify({ later: R(e3a && e3a.fr, 0).inv, again: R(e3b && e3b.fr, 0).inv, roster: R(e3c && e3c.fr, 0).inv })}`);

    // ---- E4. THE OTHER TWO ANSWERS, word for word (the owner's three notes):
    //      a push handed to a device, and nobody reached. A friend with no name
    //      is never called "No callsign" in them.
    const sent = async (id, delivered) => {
      await t9state({ members: [T9YOU({ ready: true })] });
      await clearTx(); await t9click(`#bay [data-sq="invite:${id}"]`); await sleep(40);
      await reply({ op: 'invite', ok: true, delivered });
      const f = await t9fr();
      const row = f && f.fr.find((r) => (id === T9_GHOST ? r.name === 'No callsign' : r.name === (id === T9_PIKE ? 'Ridge Pike' : 'Steel Mule')));
      return row && row.line;
    };
    const e4 = { push: await sent(T9_PIKE, 'push'), none: await sent(T9_PIKE, 'none'), anonPush: await sent(T9_GHOST, 'push'), anonNone: await sent(T9_GHOST, 'none') };
    if (e4.push && e4.push.t === "Invite sent to Ridge Pike. They'll get a notification." && !e4.push.bad
        && e4.none && e4.none.t === "Ridge Pike is offline and can't be notified. Share your squad code instead." && !e4.none.bad
        && e4.anonPush && e4.anonPush.t === "Invite sent. They'll get a notification."
        && e4.anonNone && e4.anonNone.t === "That friend is offline and can't be notified. Share your squad code instead.")
      ok(`${V}: the push and nobody-reached notes read word for word, and a nameless friend is "That friend"`);
    else fail(`${V}: delivered notes ${JSON.stringify(e4)}`);

    // ---- E5. IN YOUR SQUAD. A friend who is a member gets the drawn tick and
    //      the words instead of Invite.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: false })] });
    const e5 = await t9fr();
    if (e5 && R(e5.fr, 0).mine === 'In your squad' && R(e5.fr, 0).tick && !R(e5.fr, 0).inv && R(e5.fr, 1).inv)
      ok(`${V}: a friend in your squad reads "In your squad" with a drawn tick, and has no Invite`);
    else fail(`${V}: in your squad ${JSON.stringify(e5 && e5.fr.slice(0, 2))}`);

    // ---- E6. EVERY REFUSAL OF AN INVITE SAYS ITS SENTENCE UNDER THAT ROW.
    //      `already` is TRUE whenever it comes (a friend on a row whose id the
    //      roster cannot show yet, task 6), so it is a plain note, not a failure.
    const invSays = [['not_friend', 'You can only invite friends.', true], ['full', 'Your squad is full.', true],
      ['already', 'They are already in your squad.', false], ['no_squad', 'Your squad has ended.', true],
      ['slow_down', 'Too many tries. Wait a moment.', true], ['sign_in', 'Sign in to invite friends.', true],
      ['unavailable', 'That invite could not be sent. Try again later.', true]];
    const e6bad = [];
    for (const [code, line, bad] of invSays) {
      await t9state({ members: [T9YOU({ ready: true })] });
      await clearTx(); await t9click(`#bay [data-sq="invite:${T9_PIKE}"]`); await sleep(40);
      await reply(code === 'sign_in' ? { type: 'social', error: 'sign_in' } : { op: 'invite', error: code });
      const f = await t9fr(), row = R(f && f.fr, 1);
      if (!(row.line && row.line.t === line && row.line.bad === bad && row.inv && row.inv.t === 'Invite' && !row.inv.dis)) e6bad.push({ code, line: row.line, inv: row.inv });
    }
    if (!e6bad.length) ok(`${V}: all ${invSays.length} refusals of an invite say their sentence under the row, and 'already' is a plain note`);
    else fail(`${V}: invite refusals ${JSON.stringify(e6bad)}`);

    // ---- E7. A REFUSED CREATE INVITES NOBODY.
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(60);
    await clearTx(); await t9click(`#bay [data-sq="invite:${T9_MULE}"]`); await sleep(40);
    await reply({ type: 'social', error: 'sign_in' });
    const e7f = await squads(), e7 = await t9fr();
    if (e7f.length === 1 && e7f[0].op === 'create' && R(e7 && e7.fr, 0).line && R(e7.fr, 0).line.t === 'Sign in to invite friends.' && R(e7.fr, 0).line.bad)
      ok(`${V}: a refused create sends no invite and says why under the row`);
    else fail(`${V}: refused create ${JSON.stringify({ sent: e7f, line: R(e7 && e7.fr, 0).line })}`);

    // ---- E8. WHEN INVITE IS DEAD, AND STAYS DEAD PAST ITS ATTRIBUTE: a full
    //      squad (the button says why), a roster this socket does not hold, a
    //      squad that is open on another device -- a create from here would pull
    //      the account out of it there -- and a box that has not been answered.
    const e8 = {};
    const deadInvite = async (name, setup) => {
      await setup();
      const f = await t9fr();
      await clearTx(); await t9force(`#bay [data-sq="invite:${T9_PIKE}"]`); await sleep(40);
      e8[name] = { dis: !!(R(f && f.fr, 1).inv && R(f.fr, 1).inv.dis), title: R(f && f.fr, 1).inv && R(f.fr, 1).inv.title, sent: (await squads()).length,
        why: f && f.why, desc: R(f && f.fr, 1).desc };
    };
    await deadInvite('full', () => t9state({ members: [T9YOU(), T9MULE(), T9M({ guest: true }), T9M({ guest: true })] }));
    await deadInvite('notHeld', async () => {
      await ev(`(handle({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)}, mode: 'duel', tees: null, max: null, you: 0,
        members: [${JSON.stringify(T9YOU({ ready: true }))}], fits: ${JSON.stringify(t9fits(1))} }), true)`); await sleep(60);
    });
    await deadInvite('open', async () => { await ev(`(handle({ type: 'squad', op: 'ended', reason: 'elsewhere' }), true)`); await sleep(60); });
    // Only looked at from here (D-UI-1): the server showed this socket the squad with held:false.
    await deadInvite('looked', async () => {
      await ev(`(handle({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)}, mode: 'duel', tees: null, max: null, you: 0, held: false,
        members: [${JSON.stringify(T9YOU({ ready: true }))}], fits: ${JSON.stringify(t9fits(1))} }), true)`); await sleep(60);
    });
    // A re-ask the server refused, under the squad this tab was showing.
    await deadInvite('refused', async () => {
      await t9state({ members: [T9YOU({ ready: true })] });
      await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
      await reply({ error: 'unavailable' });
    });
    // Unanswered: an account switch starts the box over, and nothing has asked yet.
    await deadInvite('unknown', async () => { await setWho('out'); await setWho('in'); await friendsIn(FR9); });
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    // CHANGED BY TASK 9's FIX PASS (review T9-R1-13): each dead state also says
    // WHY in one visible line above the rows -- a title is never shown on a
    // touch screen -- and each dead Invite points at that line.
    const E8WHY = { full: 'Your squad is full.', notHeld: 'Your squad is open on another device.',
      open: 'Your squad was changed in another tab or on another device.', unknown: 'Your squad has not loaded yet.',
      looked: 'Your squad is open on another device.', refused: 'Your squad could not be checked. Retry on the Squad tab.' };
    if (Object.values(e8).every((x) => x.dis && x.sent === 0) && e8.full.title === 'Your squad is full.'
        && Object.keys(E8WHY).every((k) => e8[k] && e8[k].why === E8WHY[k] && e8[k].desc === 'sqInvWhy'))
      ok(`${V}: Invite is dead, handler and all, for a full squad, an unheld roster, a squad changed or open elsewhere, a refused re-ask and an unanswered box, and a line above the rows says why`);
    else fail(`${V}: invite gates ${JSON.stringify(e8)}`);

    // ---- E9. ACCEPT AND DECLINE, from the box. Each sends its friend frame; a
    //      refusal is said under the request it answers.
    await t9state({ members: [T9YOU({ ready: true })] });
    // E9a. While another action is out (an Invite), Accept and Decline wait
    //      (review T9-R1-8, N02).
    await clearTx(); await t9click(`#bay [data-sq="invite:${T9_PIKE}"]`); await sleep(40);
    const e9busy = await t9fr();
    await reply({ op: 'invite', ok: true, delivered: 'online' });
    // E9b. A page whose account is no longer signed in sends no friend or
    //      squad frame from these rows, whatever is pressed (review T9-R1-8,
    //      N01 and N08): Accept, Decline and Invite are pressed through buttons
    //      the render did not draw, with the account chip saying "guest" and the
    //      rows still on screen.
    await ev(`($('accountBtn').dataset.state = 'guest', true)`);
    await clearTx();
    // (Steel Mule, not Ridge Pike: E9a has just marked Ridge Pike Invited, and
    // that mark alone would refuse the press.)
    await t9press(`accept:${T9_NIA}`, 'sqPane-friends'); await t9press(`decline:${T9_NIA}`, 'sqPane-friends'); await t9press(`invite:${T9_MULE}`, 'sqPane-friends');
    await sleep(60);
    const e9g = (await tx()).filter((f) => f.type === 'friend' || f.type === 'squad');
    await ev(`($('accountBtn').dataset.state = 'in', true)`);
    if (e9busy && R(e9busy.req, 0).acc && R(e9busy.req, 0).acc.dis && R(e9busy.req, 0).dec && R(e9busy.req, 0).dec.dis && e9busy.why === '' && e9g.length === 0)
      ok(`${V}: Accept and Decline wait while another action is out, and a page that is no longer signed in sends nothing from these rows`);
    else fail(`${V}: friend row gates ${JSON.stringify({ busy: e9busy && R(e9busy.req, 0), why: e9busy && e9busy.why, sent: e9g })}`);
    await clearTx(); await t9click(`#bay [data-sq="accept:${T9_NIA}"]`); await sleep(40);
    const e9a = await squads(), e9af = (await tx()).filter((f) => f.type === 'friend');
    await answer(e9af[0] && e9af[0].id, { type: 'friend', op: 'accept', error: 'no_such_request' });
    const e9 = await t9fr();
    await clearTx(); await t9click(`#bay [data-sq="decline:${T9_NIA}"]`); await sleep(40);
    const e9df = (await tx()).filter((f) => f.type === 'friend');
    await answer(e9df[0] && e9df[0].id, { type: 'friend', op: 'decline', ok: true });
    if (e9a.length === 0 && e9af.length === 1 && e9af[0].op === 'accept' && e9af[0].from === T9_NIA
        && R(e9 && e9.req, 0).line && R(e9.req, 0).line.t === 'That request is already gone.' && R(e9.req, 0).line.bad
        && e9df.length === 1 && e9df[0].op === 'decline' && e9df[0].from === T9_NIA)
      ok(`${V}: Accept and Decline send their friend frames, and a refusal is said under the request`);
    else fail(`${V}: accept/decline ${JSON.stringify({ e9af, line: R(e9 && e9.req, 0).line, e9df })}`);

    // ---- E10. EMPTY: the design's sentence and the player's own friend code
    //       with Copy, so there is somewhere to start.
    await friendsIn({ friends: [], requests: { in: [], out: [] }, blocked: [], friendCode: 'AB12CD', callsign: null });
    const e10 = await t9fr();
    const e10copy = await ev(`(() => { const b = document.querySelector('#sqPane-friends [data-fr="copy"]'); return b ? !b.disabled : null; })()`);
    if (e10 && e10.text.includes('No friends yet. Share your friend code, or add a friend by theirs or by callsign.') && e10.text.includes('FR-AB12CD')
        && e10copy === true && JSON.stringify(e10.heads) === JSON.stringify(['Friends · 0']))
      ok(`${V}: no friends yet says so, and shows the player's friend code with Copy`);
    else fail(`${V}: empty friends ${JSON.stringify({ text: e10 && e10.text, heads: e10 && e10.heads, copy: e10copy })}`);
    await friendsIn(FR9);
    // ---- E11. AN INVITE'S CREATE ANSWERED UNDER ANOTHER ACCOUNT INVITES NOBODY
    //      (review T9-R1-3; task 8's check 17 holds the same for resume and the
    //      code). The create goes out for this account; the page's account then
    //      changes; the old create's answer lands, a roster this socket holds.
    //      The invite belonged to the old account's box and is not sent from
    //      the new one.
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(60);
    await clearTx(); await t9click(`#bay [data-sq="invite:${T9_MULE}"]`); await sleep(40);
    const e11c = await squads();
    await setWho('out'); await setWho('in'); await friendsIn(FR9);
    await answer(e11c[0] && e11c[0].id, { type: 'squad', op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true,
      members: [T9YOU({ ready: false })], fits: t9fits(1) });
    await sleep(60);
    const e11f = await squads();
    if (e11c.length === 1 && e11c[0].op === 'create' && !e11f.some((f) => f.op === 'invite'))
      ok(`${V}: a create answered after the account changed sends no invite from the new account's box`);
    else fail(`${V}: create across an account switch ${JSON.stringify({ create: e11c, sent: e11f })}`);
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(60);
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    await t9click('#bay [data-sq="tab:squad"]'); await sleep(40);
    // ---- F. A START REFUSED AFTER THE ENGINE HAD SHOWN A LOBBY (task 4's
    //      client obligation). The seating builds the room seat by seat and,
    //      failing part-way, tears it down QUIETLY: the leader and every member
    //      seated so far are left on a lobby for a room that no longer exists,
    //      and the squad's refusal is the only word they get. On a refusal a
    //      client standing in an online lobby asks the server whether that room
    //      still exists (the code frame), and leaves only a lobby the server
    //      says is gone -- never a real one: a member's own room the seating
    //      never reached, or a busy member's game.
    const scr = () => ev(`document.getElementById('bay').dataset.scr`);
    const lobbyAt = async (code) => { await ev(`(handle({ type: 'created', code: ${JSON.stringify(code)} }), true)`); await sleep(80); };
    const kinds = async () => (await tx()).filter((f) => f.type === 'code' || f.type === 'leave');
    // F1. A member's push, the room gone: one question, then out to home.
    await lobbyAt('RM7Q');
    const f1s = await scr();
    await clearTx(); await ev(`(handle({ type: 'squad', op: 'start', error: 'refused' }), true)`); await sleep(60);
    const f1q = await kinds();
    await answer(f1q[0] && f1q[0].id, { type: 'code', kind: 'none' });
    const f1l = await kinds(), f1e = await scr();
    if (f1s === 'lobby' && f1q.length === 1 && f1q[0].type === 'code' && f1q[0].code === 'RM7Q'
        && f1l.some((f) => f.type === 'leave') && f1e === 'home')
      ok(`${V}: a refused start asks whether the lobby's room still exists, and leaves the lobby the server says is gone`);
    else fail(`${V}: dead lobby ${JSON.stringify({ before: f1s, asked: f1q, then: f1l, after: f1e })}`);
    // F2. The room is real (a member's own room the seating never reached): stay.
    await lobbyAt('RM8Q');
    await clearTx(); await ev(`(handle({ type: 'squad', op: 'start', error: 'member_busy', at: 1 }), true)`); await sleep(60);
    const f2q = await kinds();
    await answer(f2q[0] && f2q[0].id, { type: 'code', kind: 'room' });
    const f2l = await kinds(), f2e = await scr();
    if (f2q.length === 1 && f2q[0].code === 'RM8Q' && !f2l.some((f) => f.type === 'leave') && f2e === 'lobby')
      ok(`${V}: a lobby whose room the server still holds is left exactly as it is`);
    else fail(`${V}: real lobby left ${JSON.stringify({ asked: f2q, then: f2l, after: f2e })}`);
    await ev(`($('cancelBtn').onclick(), true)`); await sleep(80);
    // F3. Not in a lobby -- home, with the code of a room a finished match
    //     left in S.code -- or in a quick-match SEARCH (no room shown, whatever
    //     S.code still holds): nothing is asked, and nothing is cancelled.
    await ev(`(S.code = 'RM5Q', true)`);
    await clearTx(); await ev(`(handle({ type: 'squad', op: 'start', error: 'refused' }), true)`); await sleep(60);
    const f3a = await kinds();
    await ev(`(S.code = 'RM9Q', showLobby('search'), true)`); await sleep(80);
    await clearTx(); await ev(`(handle({ type: 'squad', op: 'start', error: 'refused' }), true)`); await sleep(60);
    const f3b = await kinds(), f3s = await scr();
    await ev(`($('cancelBtn').onclick(), true)`); await sleep(80);
    if (f3a.length === 0 && f3b.length === 0 && f3s === 'lobby' && (await ev('S.code')) === null)
      ok(`${V}: a refused start asks nothing from home, or from a quick-match search`);
    else fail(`${V}: needless lobby check ${JSON.stringify({ home: f3a, search: f3b, scr: f3s })}`);
    // F3b. THE GUARDS THAT KEEP A REAL LOBBY (review T9-R1-2). (a) The answer
    //      lands after the player has cancelled and gone home: nothing more is
    //      cancelled. (b) A refused start in an OFFLINE room's lobby asks
    //      nothing. (c) The player is in ANOTHER room's lobby by the time the
    //      answer about the first one lands: that lobby is kept.
    await lobbyAt('RM1Q');
    await clearTx(); await ev(`(handle({ type: 'squad', op: 'start', error: 'refused' }), true)`); await sleep(60);
    const fa = await kinds();
    await ev(`($('cancelBtn').onclick(), true)`); await sleep(80);
    await clearTx();
    await answer(fa[0] && fa[0].id, { type: 'code', kind: 'none' });
    const faAfter = await kinds(), faScr = await scr();
    await lobbyAt('RM2Q'); await ev(`(S.local = true, true)`);
    await clearTx(); await ev(`(handle({ type: 'squad', op: 'start', error: 'refused' }), true)`); await sleep(60);
    const fb = await kinds();
    await ev(`(S.local = false, $('cancelBtn').onclick(), true)`); await sleep(80);
    await lobbyAt('RM3Q');
    await clearTx(); await ev(`(handle({ type: 'squad', op: 'start', error: 'refused' }), true)`); await sleep(60);
    const fc = await kinds();
    await lobbyAt('RM4Q');
    await clearTx();
    await answer(fc[0] && fc[0].id, { type: 'code', kind: 'none' });
    const fcAfter = await kinds(), fcScr = await scr(), fcCode = await ev('S.code');
    await ev(`($('cancelBtn').onclick(), true)`); await sleep(80);
    if (fa.length === 1 && fa[0].code === 'RM1Q' && faAfter.length === 0 && faScr === 'home' && fb.length === 0
        && fc.length === 1 && fc[0].code === 'RM3Q' && fcAfter.length === 0 && fcScr === 'lobby' && fcCode === 'RM4Q')
      ok(`${V}: a late answer cancels nothing once the player has gone home or moved to another lobby, and an offline room's lobby asks nothing`);
    else fail(`${V}: real lobby guards ${JSON.stringify({ a: { asked: fa, then: faAfter, scr: faScr }, b: fb, c: { asked: fc, then: fcAfter, scr: fcScr, code: fcCode } })}`);
    // F4. The LEADER's own refused Start, answered after the engine's create:
    //     the same question, and the leader lands back on the box with the
    //     refusal said in it.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await clearTx(); await t9click('#bay [data-sq="start"]'); await sleep(40);
    const startId = ((await squads())[0] || {}).id;
    await lobbyAt('RM6Q');
    await answer(startId, { type: 'squad', op: 'start', error: 'refused' });
    const f4q = await kinds();
    const probe = f4q.find((f) => f.type === 'code');
    await answer(probe && probe.id, { type: 'code', kind: 'none' });
    const f4e = await scr(), f4 = await t9box();
    if (probe && probe.code === 'RM6Q' && f4e === 'home' && f4 && f4.aerr === 'That match could not be started. Try again.' && f4.start && !f4.start.dis)
      ok(`${V}: the leader's refused Start leaves the dead lobby too, and the box says why`);
    else fail(`${V}: leader dead lobby ${JSON.stringify({ asked: f4q, scr: f4e, aerr: f4 && f4.aerr })}`);

    // ---- F5. A JOIN FOR A CODE THE INVITE DOES NOT HOLD SENDS NOTHING: the
    //      frame takes the SLOT's code, never a button's word for it.
    await invite({ code: 'RM3P' });
    await clearTx(); await t9inject('join:ZZ9Z'); await sleep(50);
    const f5a = await squads();
    await t9inject('join:RM3P'); await sleep(50);
    const f5b = await squads();
    await reply({ op: 'join', error: 'full' });
    await t9click('#bay [data-sq^="ignore:"]'); await sleep(40);
    if (f5a.length === 0 && f5b.length === 1 && f5b[0].code === 'RM3P')
      ok(`${V}: a Join for a code the invite does not hold sends nothing`);
    else fail(`${V}: forged join ${JSON.stringify({ forged: f5a, real: f5b })}`);

    // ---- G. EVERY PLACE A PLAYER'S NAME REACHES MARKUP, fed markup (design 6.3:
    //      names are esc()'d everywhere). A member's name in a start refusal and
    //      in the Remove question, a leader's in the member's sentence, and a
    //      friend's and a requester's in the Friends tab's rows and in the note
    //      the inviter is told. The text must read back exactly, and no element
    //      may appear.
    const EVIL = '<img src=x onerror=1>';
    const imgs = () => ev(`document.querySelectorAll('#sqPane-squad img, #sqPane-friends img').length`);
    const g = {};
    await t9state({ members: [T9YOU({ ready: true }), T9PIKE({ callsign: EVIL, ready: true })] });
    await clearTx(); await t9click('#bay [data-sq="start"]'); await sleep(40);
    await reply({ op: 'start', error: 'member_offline', at: 1 });
    g.say = [(await t9box()).aerr === EVIL + " isn't ready to start yet.", await imgs()];
    await t9click(`#bay [data-sq="kick:${RID_PIKE}"]`); await sleep(40);
    g.ask = [(await t9box()).line === 'Remove ' + EVIL + ' from the squad?', await imgs()];
    await t9click('#bay [data-sq="kcancel"]'); await sleep(40);
    await t9state({ leader: T9_PIKE, members: [T9YOU({ ready: true }), T9PIKE({ callsign: EVIL, ready: true })] });
    g.lead = [(await t9box()).note === EVIL + ' picks the mode and starts. You will be placed in the room together.', await imgs()];
    await friendsIn({ friends: [{ id: T9_MULE, callsign: EVIL, online: false }], requests: { in: [{ id: T9_NIA, callsign: EVIL }], out: [] },
      blocked: [], friendCode: 'AB12CD', callsign: null });
    await t9click('#bay [data-sq="tab:friends"]'); await sleep(40);
    await clearTx(); await t9click(`#bay [data-sq="invite:${T9_MULE}"]`); await sleep(40);
    await reply({ op: 'invite', ok: true, delivered: 'online' });
    const gf = await t9fr();
    g.rows = [R(gf && gf.fr, 0).name === EVIL && R(gf && gf.req, 0).name === EVIL, await imgs()];
    g.note = [!!(R(gf && gf.fr, 0).line && R(gf.fr, 0).line.t === 'Invite sent to ' + EVIL + '.'), await imgs()];
    await friendsIn(FR9);
    await t9click('#bay [data-sq="tab:squad"]'); await sleep(40);
    if (Object.values(g).every(([same, n]) => same === true && n === 0))
      ok(`${V}: a name carrying markup reads back as text in a start refusal, the Remove question, the leader sentence, the friend and request rows and the invite note`);
    else fail(`${V}: names reaching markup ${JSON.stringify(g)}`);

    // ---- H. READABLE WORDS AND TAPPABLE CONTROLS (review T9-R1-10 and 11).
    //      Leader, Not ready, Reconnecting and In your squad are at least 7.5u
    //      (the brief's size; they were 6.5u, under 5 px on a 667x375 phone).
    //      Remove, Decline and the member menu each take a tap anywhere in a
    //      square at least 24 CSS px across -- 34u, which is 24.3 px on a
    //      667x375 phone: the target's size is read back from the layout, and
    //      its corners and edges are sampled 0.75 px in -- and no two of those
    //      squares, nor Decline's and Accept's, overlap: every sampled point
    //      lands on the control it belongs to. Between Decline and the menu there is dead
    //      ground (the larger gap): the point halfway between them lands on
    //      neither. Each control is scrolled to the middle of its pane first,
    //      so nothing else is on top of it.
    const t9hit = (sel, paneId) => ev(`(() => {
      const pane = document.getElementById(${JSON.stringify(paneId)});
      const vis = (e) => !!e && !e.closest('.hidden') && e.getClientRects().length > 0;
      const on = (e, b) => !!e && (e === b || b.contains(e));
      return [...pane.querySelectorAll(${JSON.stringify(sel)})].filter(vis).map((b) => {
        b.scrollIntoView({ block: 'center' });
        // THE TARGET is the control's own box and its transparent ::before
        // layer, placed from inside the border: read back from the layout.
        const r = b.getBoundingClientRect(), cs = getComputedStyle(b), ps = getComputedStyle(b, '::before');
        const px = (v) => parseFloat(v) || 0;
        const pl = r.left + px(cs.borderLeftWidth), pr = r.right - px(cs.borderRightWidth), pt = r.top + px(cs.borderTopWidth), pb = r.bottom - px(cs.borderBottomWidth);
        const t = ps.position === 'absolute'
          ? { x0: Math.min(r.left, pl + px(ps.left)), x1: Math.max(r.right, pr - px(ps.right)), y0: Math.min(r.top, pt + px(ps.top)), y1: Math.max(r.bottom, pb - px(ps.bottom)) }
          : { x0: r.left, x1: r.right, y0: r.top, y1: r.bottom };
        // Its corners and edge midpoints, 0.75 px in from the edge: the whole
        // square it claims, not only the middle of it.
        const cx = (t.x0 + t.x1) / 2, cy = (t.y0 + t.y1) / 2, E = 0.75;
        const xs = [t.x0 + E, cx, t.x1 - E], ys = [t.y0 + E, cy, t.y1 - E];
        const pts = xs.flatMap((x) => ys.map((y) => [x, y])).filter(([x, y]) => x !== cx || y !== cy);
        const miss = pts.filter(([x, y]) => !on(document.elementFromPoint(x, y), b));
        const prev = b.previousElementSibling, prr = prev && prev.matches('.sbtn') ? prev.getBoundingClientRect() : null;
        const prevKept = prr ? on(document.elementFromPoint(prr.right - 1, prr.y + prr.height / 2), prev) : null;
        // Halfway between Decline and the menu after it: a button there is no gap.
        const nx = b.nextElementSibling, dead = b.matches('.sqic') && nx && nx.matches('.pmb')
          ? (() => { const q = nx.getBoundingClientRect(), e = document.elementFromPoint((r.right + q.left) / 2, r.y + r.height / 2); return !(e && e.closest('button')); })() : null;
        return { v: b.getAttribute('data-sq') || 'menu', w: +(t.x1 - t.x0).toFixed(1), h: +(t.y1 - t.y0).toFixed(1), miss: miss.length, prevKept, dead };
      });
    })()`);
    const t9font = (sel) => ev(`(() => { const u = document.querySelector('#bay .stage').getBoundingClientRect().width / 932;
      return [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.closest('.hidden') && e.getClientRects().length > 0)
        .map((e) => +(parseFloat(getComputedStyle(e).fontSize) / u).toFixed(2)); })()`);
    await t9state({ mode: 'ffa', members: [T9YOU({ ready: true }), T9MULE({ ready: false }), T9PIKE({ ready: true, dropped: true })] });
    await t9box();
    const hSq = { hits: await t9hit('.sqm .pmb, .sqm .sqic', 'sqPane-squad'), sql: await t9font('#sqPane-squad .sql'), sqr: await t9font('#sqPane-squad .sqr:not(.on)') };
    await friendsIn({ ...FR9, friends: [{ id: T9_MULE, callsign: 'Steel Mule', online: true }, { id: T9_PIKE, callsign: 'Ridge Pike', online: false }] });
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await t9click('#bay [data-sq="tab:friends"]'); await sleep(60);
    await t9fr();
    const hFr = { hits: await t9hit('.sqm .pmb, .sqm .sqic', 'sqPane-friends'), sqy: await t9font('#sqPane-friends .sqy') };
    const hRows = await t9fr();
    await t9click('#bay [data-sq="tab:squad"]'); await sleep(40);
    await friendsIn(FR9);
    const fontsOk = [...hSq.sql, ...hSq.sqr, ...hFr.sqy];
    if (hSq.sql.length === 1 && hSq.sqr.length === 2 && hFr.sqy.length === 1 && fontsOk.every((f) => f >= 7.5)
        && hSq.hits.length === 4 && hFr.hits.length === 4 && hSq.hits.concat(hFr.hits).every((x) => x.w >= 24 && x.h >= 24 && x.miss === 0 && x.prevKept !== false)
        && hFr.hits.filter((x) => x.v.startsWith('decline:')).length === 1 && hFr.hits.find((x) => x.v.startsWith('decline:')).prevKept === true
        && hFr.hits.find((x) => x.v.startsWith('decline:')).dead === true
        && hRows && !hRows.req.concat(hRows.fr).some((r) => r.over))
      ok(`${V}: the squad's status words are at least 7.5u, and Remove, Decline and every member menu take a tap across about 24 px without overlapping each other or Accept`);
    else fail(`${V}: words and targets ${JSON.stringify({ squad: hSq, friends: hFr, over: hRows && hRows.req.concat(hRows.fr).map((r) => r.over) })}`);

    // ---- I. TWO-LINE ROWS (D-UI-5). A busy row carried its status words or its
    //      buttons on the name's line, and the name gave way: at a407cc1 a
    //      reconnecting member read "Rid..." and a request "Nia ..." at both
    //      phone viewports. The name now has the first line to itself and the
    //      status words sit beneath it.
    //  I1. EVERY FIXTURE NAME READS IN FULL, measured on the name itself: the
    //      ellipsis is drawn exactly when its scrollWidth passes its
    //      clientWidth. In the leader's view of a reconnecting member (menu and
    //      Remove on the row), in a member's view of a reconnecting leader
    //      (Leader, Reconnecting and the menu on one row) and on the Friends
    //      tab's request, In your squad and Invite rows. Every row's status
    //      words sit below its name, and no control's target (its box and its
    //      ::before layer, read back from the layout as H does) reaches up into
    //      the name's line.
    //  I2. A TAP ON THE STATUS WORDS OPENS NOTHING. The member menu's target
    //      reached 16u left over "Not ready" and "Reconnecting", and a friend's
    //      menu 3u over "In your squad", so a tap on the words opened that
    //      player's menu. Each status word -- Leader, the Ready tick, Not ready,
    //      Reconnecting, In your squad -- is sampled at its corners, edge
    //      midpoints and centre, 0.75 px in, and no sample lands on a control;
    //      then it is pressed for real (a CDP mouse press and release at its
    //      right edge, the point nearest the menu), and no menu opens, no Remove
    //      question opens and nothing is sent. A real press on a menu does open
    //      it, in both panes, so the presses do reach the controls.
    const t9names = (paneId) => ev(`(() => {
      const pane = document.getElementById(${JSON.stringify(paneId)});
      const vis = (e) => !!e && !e.closest('.hidden') && e.getClientRects().length > 0;
      const px = (v) => parseFloat(v) || 0;
      const top = (b) => { const r = b.getBoundingClientRect(), ps = getComputedStyle(b, '::before');
        return ps.position === 'absolute' ? Math.min(r.top, r.top + px(getComputedStyle(b).borderTopWidth) + px(ps.top)) : r.top; };
      return [...pane.querySelectorAll('.sqm')].filter(vis).map((r) => {
        const n = r.querySelector('.sqmt'), nb = n.getBoundingClientRect(), line = (r.querySelector('.sqm1') || n).getBoundingClientRect();
        const words = [...r.querySelectorAll('.sql, .sqr, .sqy')].filter(vis);
        const ctl = [...r.querySelectorAll('.pmb, .sqic, .sbtn')].filter(vis);
        return { name: n.textContent, cut: n.scrollWidth > n.clientWidth, sw: n.scrollWidth, cw: n.clientWidth, words: words.length,
          under: words.every((w) => w.getBoundingClientRect().top >= nb.bottom - 0.5),
          foot: ctl.every((b) => top(b) >= line.bottom - 0.5), ctl: ctl.map((b) => +(top(b) - line.bottom).toFixed(2)) };
      });
    })()`);
    const WORDS = '.sqm .sql, .sqm .sqr, .sqm .sqy';
    const t9tap = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(60);
    };
    // What a press opened, shut again: the player menu (by its own Close), or
    // the leader's Remove question in the footer.
    const t9shut = () => ev(`(() => {
      const m = document.getElementById('pmenu'), open = !!(m && !m.hidden);
      if (open) m.querySelector('[data-pm="close"]').click();
      const k = document.querySelector('#bay [data-sq="kcancel"]'), ask = !!(k && !k.closest('.hidden'));
      if (ask) k.click();
      return { open, ask };
    })()`);
    const t9words = async (paneId) => {
      const out = [], pick = `[...document.getElementById(${JSON.stringify(paneId)}).querySelectorAll(${JSON.stringify(WORDS)})].filter((x) => !x.closest('.hidden') && x.getClientRects().length > 0)`;
      const n = await ev(`${pick}.length`);
      for (let k = 0; k < n; k++) {
        const w = await ev(`(() => {
          const e = ${pick}[${k}];
          e.scrollIntoView({ block: 'center' });
          const r = e.getBoundingClientRect(), E = 0.75;
          const xs = [r.left + E, (r.left + r.right) / 2, r.right - E], ys = [r.top + E, (r.top + r.bottom) / 2, r.bottom - E];
          const hit = xs.flatMap((x) => ys.map((y) => { const b = document.elementFromPoint(x, y), c = b && b.closest('button'); return c ? (c.getAttribute('data-sq') || c.className) : ''; })).filter(Boolean);
          // Nothing left open over the rows: an open menu's sheet would take
          // every sample and every press, and prove nothing.
          const m = document.getElementById('pmenu'), clear = !(m && !m.hidden) && !document.querySelector('#bay [data-sq="kcancel"]');
          return { t: e.textContent.trim() || e.getAttribute('aria-label'), x: r.right - E, y: (r.top + r.bottom) / 2, hit, clear };
        })()`);
        const sent = (await tx()).length;
        await t9tap(w.x, w.y);
        const s = await t9shut();
        out.push({ t: w.t, hit: w.hit, clear: w.clear, open: s.open, ask: s.ask, sent: (await tx()).length - sent });
      }
      return out;
    };
    const t9menuTap = async (paneId) => {
      const c = await ev(`(() => { const b = [...document.getElementById(${JSON.stringify(paneId)}).querySelectorAll('.sqm .pmb')].find((x) => !x.closest('.hidden') && x.getClientRects().length > 0);
        if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!c) return null;
      await t9tap(c.x, c.y);
      return (await t9shut()).open;
    };
    const iN = {}, iW = {};
    await t9state({ mode: 'ffa', members: [T9YOU({ ready: true }), T9MULE({ ready: false }), T9PIKE({ ready: true, dropped: true })] });
    await t9box();
    iN.lead = await t9names('sqPane-squad'); iW.lead = await t9words('sqPane-squad');
    await t9state({ leader: T9_PIKE, mode: 'ffa', members: [T9YOU({ ready: false }), T9PIKE({ ready: true, dropped: true }), T9MULE({ ready: false })] });
    await t9box();
    iN.member = await t9names('sqPane-squad'); iW.member = await t9words('sqPane-squad');
    const iMenuSq = await t9menuTap('sqPane-squad');
    await friendsIn({ ...FR9, friends: [{ id: T9_MULE, callsign: 'Steel Mule', online: true }, { id: T9_PIKE, callsign: 'Ridge Pike', online: false }] });
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await t9click('#bay [data-sq="tab:friends"]'); await sleep(60);
    iN.friends = await t9names('sqPane-friends'); iW.friends = await t9words('sqPane-friends');
    const iMenuFr = await t9menuTap('sqPane-friends');
    const iShut = await ev(`(() => { const m = document.getElementById('pmenu'); return !(m && !m.hidden); })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await t9click('#bay [data-sq="tab:squad"]'); await sleep(40);
    await friendsIn(FR9);
    const iNamed = (rows, names, words) => Array.isArray(rows) && JSON.stringify(rows.map((r) => r.name)) === JSON.stringify(names)
      && JSON.stringify(rows.map((r) => r.words)) === JSON.stringify(words) && rows.every((r) => !r.cut && r.under && r.foot);
    if (iNamed(iN.lead, ['Dusty Crag', 'Steel Mule', 'Ridge Pike'], [2, 1, 1]) && iNamed(iN.member, ['Dusty Crag', 'Ridge Pike', 'Steel Mule'], [1, 2, 1])
        && iNamed(iN.friends, ['Nia Vale', 'Steel Mule', 'Ridge Pike'], [0, 1, 0]))
      ok(`${V}: every fixture name reads in full on a line of its own, the status words beneath it and no control's target reaching into it -- a reconnecting member, a reconnecting leader, a request, a squadmate and a friend to invite`);
    else fail(`${V}: two-line rows, names ${JSON.stringify(iN)}`);
    const iAll = [].concat(iW.lead, iW.member, iW.friends);
    if (iW.lead.length === 4 && iW.member.length === 4 && iW.friends.length === 1
        && iAll.every((w) => w.clear && w.hit.length === 0 && !w.open && !w.ask && w.sent === 0) && iMenuSq === true && iMenuFr === true && iShut)
      ok(`${V}: a tap anywhere on Leader, Ready, Not ready, Reconnecting or In your squad opens no menu and asks nothing, and a tap on a menu opens it`);
    else fail(`${V}: a tap on the status words ${JSON.stringify({ iW, iMenuSq, iMenuFr, iShut })}`);
  }
} catch (e) {
  fail('squad_ui task 9 stopped: ' + (e && e.message));
}

clearTimeout(watchdog);
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall squad_ui checks passed');
process.exit(errors.length ? 1 : 0);
