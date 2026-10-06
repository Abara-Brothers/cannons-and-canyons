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
const RUN_MS = 300000;                                          // the whole suite
const errors = [];
const ok = (m) => console.log('  ok -- ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const get = (url) => fetch(url, { signal: AbortSignal.timeout(2000) });

let srv = null, chrome = null, prof = null;
// SIGKILL (fix wave A4): a stopped process ignores SIGTERM until it is
// continued, so a frozen Chrome -- the hang the deadlines exist for -- outlived
// the SIGTERM this sent.
const cleanup = () => {
  try { chrome && chrome.kill('SIGKILL'); } catch {} try { srv && srv.kill('SIGKILL'); } catch {}
  try { prof && rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); } catch {}
};
process.on('exit', cleanup);
// AN INTERRUPTED RUN CLEANS UP TOO (review T8-R1-7). Under Node's default
// handlers a signal kills the process without an 'exit' event, so a Ctrl-C of
// run-all.sh or a watchdog's SIGTERM left server.js and Chrome running under
// PID 1, with the profile directory behind. Exit as a shell reports a signal.
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { cleanup(); process.exit(128 + n); });
const watchdog =setTimeout(() => { console.error(`FAIL squad_ui overran ${RUN_MS} ms -- a CDP peer stopped answering`); process.exit(1); }, RUN_MS);

// ONE BLOCK AT A TIME, ON REQUEST: SQUAD_UI_ONLY=t9,u4 runs only those blocks
// (t8 task 8, t9 task 9, t11 task 11, w the fix waves, u3, u4, u8). Each block
// loads its own page and shares no state with the others, so a mutation run
// can take the one block that pins the line it changed. Unset, everything runs.
const ONLY = (process.env.SQUAD_UI_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);
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

// The cold-start intro (public/intro.js) is off for this suite: it covers the bay
// with a pointer-catching canvas for six seconds on a fresh load, and these checks
// hit-test and press the bay from the first second. test/intro.mjs owns it. A
// script for new documents only runs while the Page domain is enabled, so it is
// enabled here, before any load, and never disabled again.
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__ccNoIntro = true;' });

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
// CHANGED BY U4 (owner, 2026-10-06: the box shows the squad and the friends
// online, behind a "Squad 2/4" header and Manage). The tabs went, and with
// them the panes this read: `text` is the squad part of the box's list (the
// invite row, the squad's state and lines), `ftext` the friends part, and
// `count` the header's "2/4" -- the Squad tab's pill, which read "2 / 4".
// The code field moved into the Manage squad window, which win() reads.
const box = () => ev(`(() => {
  Bay.show('home');
  const p = document.querySelector('#bay .pnl.sqx');
  if (!p) return null;
  const stg = document.querySelector('#bay .stage').getBoundingClientRect();
  const u = stg.width / 932, r = p.getBoundingClientRect();
  const vis = (e) => !!e && !e.closest('.hidden') && e.getClientRects().length > 0;
  const list = p.querySelector('.sqb'), fr = list && list.querySelector(':scope > .sqbf');
  const own = list ? [...list.children].filter((c) => c !== fr && !c.classList.contains('sqfade')) : [];
  const e = own.find((c) => c.classList.contains('sqe') && !c.classList.contains('hidden'));
  const cnt = p.querySelector('.sqhc'), mg = p.querySelector('.sqmg');
  return {
    geom: [Math.round((r.x - stg.x) / u), Math.round((r.y - stg.y) / u), Math.round(r.width / u), Math.round(r.height / u)],
    // Where the box's neighbours stand, in the same units (U5: the box spans
    // from under the boards to the ribbon, however tall the safe box is).
    boardsTop: (document.querySelector('#bay .boards').getBoundingClientRect().y - stg.y) / u,
    lbarTop: (document.querySelector('#bay .lbar').getBoundingClientRect().y - stg.y) / u,
    shape: [...p.children].map((c) => c.tagName + '.' + c.className),
    count: cnt && !cnt.classList.contains('hidden') ? cnt.firstElementChild.textContent : null,
    manage: mg ? { t: mg.firstChild.textContent, dis: mg.disabled, go: mg.getAttribute('data-go'), label: mg.getAttribute('aria-label'),
      dot: !mg.querySelector('.sqd').classList.contains('hidden') } : null,
    text: own.map((c) => c.innerText || '').join(' ').replace(/\\s+/g, ' ').trim(),
    ftext: fr ? fr.innerText.replace(/\\s+/g, ' ').trim() : '',
    err: e ? e.textContent : '',
    btns: list ? [...list.querySelectorAll('button')].filter(vis).map((b) => ({ t: b.textContent.trim(), sq: b.getAttribute('data-sq'), go: b.getAttribute('data-go'), old: b.getAttribute('data-old'), dis: b.disabled })) : [],
    field: p.querySelector('input') ? true : null,
    over: [p.scrollWidth > p.clientWidth, p.scrollHeight > p.clientHeight],
    bayOver: (() => { const b = document.getElementById('bay'); return [b.scrollWidth > b.clientWidth, b.scrollHeight > b.clientHeight]; })(),
  };
})()`);
// THE MANAGE SQUAD WINDOW (U4), the same way: its three columns -- the code
// column (`ctext`, the one code field, its error line `cerr`), the squad
// column (`text`, the re-ask's refusal `err`) and the friends column
// (`ftext`) -- its chrome, and every button it draws. The field is read where
// it is: `fold` is whether it sits inside its column's visible box.
const win = () => ev(`(() => {
  Bay.show('squad');
  const c = document.getElementById('sqWin-code'), q = document.getElementById('sqWin-squad'), f = document.getElementById('sqWin-friends');
  if (!c || !q || !f) return null;
  const vis = (e) => !!e && !e.closest('.hidden') && e.getClientRects().length > 0;
  const i = document.getElementById('sqCode');
  const ce = c.querySelector('.sqcr + .sqe'), qe = [...q.children].find((x) => x.classList.contains('sqe'));
  const t = (x) => x.innerText.replace(/\\s+/g, ' ').trim();
  const ir = i && i.getBoundingClientRect(), cr = c.getBoundingClientRect();
  return {
    title: (document.querySelector('#bay .phead .pt') || {}).textContent || null,
    sub: (document.querySelector('#bay .phead .ps') || {}).textContent || null,
    back: !!document.querySelector('#bay .phead [data-back]'),
    text: t(q), ctext: t(c), ftext: t(f),
    err: qe && vis(qe) ? qe.textContent : '',
    cerr: ce && vis(ce) ? ce.textContent : '',
    field: i ? { on: !i.disabled, val: i.value } : null,
    fields: document.querySelectorAll('#sqCode').length,
    fieldIn: !!(i && c.contains(i)),
    codeAt: [...c.children].findIndex((x) => x === i || (x.querySelector && x.querySelector('#sqCode'))),
    fold: i ? ir.top >= cr.top - 0.5 && ir.bottom <= cr.bottom + 0.5 : null,
    code: (c.querySelector('.sqcd') || { textContent: '' }).textContent,
    btns: [...document.querySelectorAll('#bay .pbody button')].filter(vis).map((b) => ({ t: b.textContent.trim(), sq: b.getAttribute('data-sq'), go: b.getAttribute('data-go'), old: b.getAttribute('data-old'), dis: b.disabled })),
    bayOver: (() => { const b = document.getElementById('bay'); return [b.scrollWidth > b.clientWidth, b.scrollHeight > b.clientHeight]; })(),
  };
})()`);
const click = (sel) => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);

if (want('t8')) try {
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
    //      CHANGED BY U4: its two children are the header and the list, where
    //      they were the tab bar and the panes.
    //      CHANGED BY U5 (owner, 2026-10-06: home reaches the safe box's top
    //      and bottom, and the boards came up under a smaller top row): the
    //      slot was a fixed 18,174 196x192u. It is still the left slot, 196u
    //      wide at 18u, but it now spans from 115u under the boards' top to 4u
    //      above the ribbon -- 171u and 195u tall on a 932x430 page, taller
    //      wherever the safe box has height to spare (667x375).
    const b1 = await box();
    const slotOk = b1 && b1.geom[0] === 18 && b1.geom[2] === 196 && Math.abs(b1.geom[1] - (b1.boardsTop + 115)) <= 1
      && Math.abs(b1.geom[1] + b1.geom[3] - (b1.lbarTop - 4)) <= 1 && b1.geom[3] >= 195;
    if (slotOk && JSON.stringify(b1.shape) === '["DIV.sqhd","DIV.sqb"]'
        && JSON.stringify(b1.bayOver) === '[false,false]' && JSON.stringify(b1.over) === '[false,false]'
        && (await ev(`document.querySelector('#bay .pnl').classList.contains('sqx')`)))
      ok(`${V}: the Squad box holds the left slot, ${b1.geom.join(',')}u: 115u under the boards to 4u above the ribbon, a header and a list, and nothing overflows`);
    else fail(`${V}: slot ${JSON.stringify(b1 && { geom: b1.geom, boardsTop: b1.boardsTop, lbarTop: b1.lbarTop, shape: b1.shape, over: b1.over, bayOver: b1.bayOver })}`);

    // ---- 2. MANAGE OPENS THE WINDOW (U4; owner, 2026-10-06: "replace Invite
    //      friends with a button that opens a window to manage the squad").
    //      REPLACES the tab bar's checks (tab switch, tab/panel wiring, the
    //      tab's 22u bar and wider target, the field kept across a tab switch):
    //      the tabs are gone. Clicked through the REAL delegated listener,
    //      never by calling the handler: a data-* attribute that is not in the
    //      one closest() list produces a completely dead button with no error.
    //      The window is a bay screen with the standard chrome -- the title, a
    //      Back that comes home -- and its code field keeps what the player
    //      typed across an in-place repaint. Driven as a GUEST, whose window
    //      offers the field before any answer.
    await setWho('guest');
    await click('#bay .sqx [data-go="squad"]'); await sleep(60);
    const w2 = await ev(`(() => ({ scr: document.getElementById('bay').dataset.scr, title: (document.querySelector('#bay .phead .pt') || {}).textContent,
      back: !!document.querySelector('#bay .phead [data-back]'), cols: ['sqWin-code', 'sqWin-squad', 'sqWin-friends'].map((x) => !!document.getElementById(x)) }))()`);
    await ev(`(() => { const i = document.getElementById('sqCode'); if (i) i.value = 'WXYZ'; document.dispatchEvent(new Event('cc:social')); return true; })()`);
    await sleep(60);
    const kept = await ev(`(() => { const i = document.getElementById('sqCode'); return i ? i.value : null; })()`);
    await click('#bay .phead [data-back]'); await sleep(60);
    const w2back = await ev(`document.getElementById('bay').dataset.scr`);
    if (w2 && w2.scr === 'squad' && w2.title === 'Your squad' && w2.back && w2.cols.every(Boolean) && w2back === 'home')
      ok(`${V}: Manage opens "Your squad" through the delegated listener, with the chrome's Back, and Back comes home`);
    else fail(`${V}: Manage ${JSON.stringify({ w2, back: w2back })}`);
    if (kept === 'WXYZ') ok(`${V}: the window repaints in place and keeps what the player typed in the code field`);
    else fail(`${V}: the code field lost its value across a repaint (${JSON.stringify(kept)})`);
    // MANAGE IS EASIER TO HIT THAN IT LOOKS, and its target stays off the list:
    // a tap 3u below it, over the header's own padding, lands on it; with the
    // list scrolled, a tap 1u into the list is the list's.
    await setWho('in');
    await ev(`(() => { for (let k = 0; k < 2; k++) handle({ type: 'squad', op: 'invited', code: 'RM4P', from: { callsign: 'Steel Mule' }, size: 2, max: 4 }); return true; })()`);
    const mhit = await ev(`(() => {
      Bay.show('home');
      const u = document.querySelector('#bay .stage').getBoundingClientRect().width / 932;
      const m = document.querySelector('#bay .sqmg'), l = document.querySelector('#bay .sqb');
      if (!m || !l) return null;
      const r = m.getBoundingClientRect(), below = document.elementFromPoint(r.x + r.width / 2, r.bottom + 3 * u);
      l.scrollTop = l.scrollHeight;
      const lr = l.getBoundingClientRect(), into = document.elementFromPoint(r.x + r.width / 2, lr.top + 1 * u);
      const scrolled = l.scrollTop > 0; l.scrollTop = 0;
      return { below: !!(below && below.closest('.sqmg')), into: !!(into && l.contains(into)), scrolled, h: +((r.height + 12 * u) / u).toFixed(1) };
    })()`);
    await ev(`(window.CC_SQUAD_INVITE = null, document.dispatchEvent(new Event('cc:social')), true)`);
    if (mhit && mhit.below && mhit.into && mhit.scrolled)
      ok(`${V}: a tap just below Manage still lands on it, and its target never covers the scrolled list`);
    else fail(`${V}: Manage target ${JSON.stringify(mhit)}`);

    // ---- 3. GUEST (D11). What a guest can do NOW, then the door to an account.
    //      CHANGED BY U4 (owner: a guest's box is "Squad 0/4" + Manage + a line
    //      that friends need an account + Sign in): the box no longer carries
    //      the code field -- the window does -- so the box's lead sentence
    //      sends the guest to Manage, and the window's says what it always
    //      said beside the field.
    const G1 = 'You can play right now. Got a squad code from a friend? Tap Manage to join, as a guest.';
    const G1W = 'You can play right now. Got a squad code from a friend? Enter it and you are in, as a guest.';
    const G2 = 'Sign in to add friends and keep your progress across devices. Your guest progress on this device comes with you when you do.';
    for (const who of ['guest', 'out']) {
      await setWho(who);
      const g = await box();
      // innerText is what a player sees, so the heading and the button read in
      // capitals: .sqh, .sbtn and .ghost set text-transform:uppercase.
      if (g && g.count === '0/4' && g.manage && !g.manage.dis && g.manage.go === 'squad' && g.text === G1
          && g.ftext === 'FRIENDS Sign in to add friends. SIGN IN' && g.btns.some((b) => b.old === 'accountBtn' && !b.dis) && g.field === null)
        ok(`${V}: ${who} -- the box reads Squad 0/4 with Manage, says what a guest can do, and that friends need an account, with Sign in`);
      else fail(`${V}: ${who} box ${JSON.stringify(g && { count: g.count, manage: g.manage, text: g.text, ftext: g.ftext, btns: g.btns, field: g.field })}`);
      const gw = await win();
      if (gw && gw.text === G1W && gw.ftext === G2 + ' SIGN IN' && gw.field && gw.field.on && gw.fieldIn && gw.ctext.endsWith('A squad you join shows its code here.')
          && gw.btns.some((b) => b.old === 'accountBtn' && !b.dis) && gw.btns.some((b) => b.sq === 'code' && !b.dis && b.t === 'Join'))
        ok(`${V}: ${who} -- the window offers the code field and Join, D11's sentence beside it, and Sign in with what it is for`);
      else fail(`${V}: ${who} window ${JSON.stringify(gw && { text: gw.text, ftext: gw.ftext, field: gw.field, btns: gw.btns })}`);
      // THE FIELD IS ABOVE THE FOLD: it is the one thing D11 asks for first.
      if (gw && gw.fold === true && gw.codeAt === 1 && JSON.stringify(gw.bayOver) === '[false,false]')
        ok(`${V}: ${who} -- the code field is the code column's second node, inside the visible column, and #bay never scrolls`);
      else fail(`${V}: ${who} fold ${JSON.stringify(gw && { fold: gw.fold, at: gw.codeAt, bayOver: gw.bayOver })}`);
    }
    // NO ACCOUNT BUTTON, NO SIGN-IN OFFER. accountChip() already drops the chip
    // when #accountBtn is hidden ("no session and no way to start one"); the box
    // and the window must not offer a door that is not there.
    await setWho('guest', true);
    const gh = await box(), ghw = await win();
    if (gh && !gh.btns.some((b) => b.old === 'accountBtn') && gh.text === G1 && gh.ftext === 'FRIENDS Friends need an account.' && !/sign in/i.test(gh.ftext)
        && ghw && !ghw.btns.some((b) => b.old === 'accountBtn') && ghw.ftext === 'Friends need an account.')
      ok(`${V}: guest -- no Sign in offered while #accountBtn is hidden: friends need an account, said plainly`);
    else fail(`${V}: hidden-account guest ${JSON.stringify({ box: gh && [gh.text, gh.ftext], win: ghw && ghw.ftext })}`);
    await setWho('in');

    // ---- 4. OFFLINE (design 5.1 state 6). Every squad control needs the
    //      socket -- the code field asks the server which KIND of code it is,
    //      Invite needs the friend graph, and signing in needs the network too.
    //      So the refusal is said once, at the top, for every kind of account:
    //      a guest offered a dead field and a dead Sign in button is the exact
    //      lie this box exists to avoid. CHANGED BY U4: the field is the
    //      window's, so the window is read for it; the box keeps Manage, which
    //      is a way to a screen, not a squad action.
    for (const who of ['in', 'guest', 'out']) {
      await setWho(who); await up(false);
      const o = await box(), ow = await win();
      await ev(`(Bay.show('home'), true)`);
      if (o && o.text.startsWith('Needs a connection.') && o.btns.length === 0 && o.manage && !o.manage.dis
          && ow && ow.text.startsWith('Needs a connection.') && ow.ftext.startsWith('Needs a connection.')
          && ow.field && ow.field.on === false && ow.btns.length > 0 && ow.btns.every((b) => b.dis))
        ok(`${V}: offline (${who}) -- "Needs a connection" in the box and the window, the field and every window control dead`);
      else fail(`${V}: offline (${who}) ${JSON.stringify({ box: o && { text: o.text, btns: o.btns, manage: o.manage }, win: ow && { text: ow.text, ftext: ow.ftext, field: ow.field, btns: ow.btns } })}`);
      await up(true);
    }
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
        && w0.btns.some((b) => b.sq === 'retry' && b.dis && b.t === 'Loading') && w0.count === null)
      ok(`${V}: before any answer the box says "Not loaded yet.", holds Retry (Loading) until the hello, and asks nothing before it`);
    else fail(`${V}: third state ${JSON.stringify(w0 && { text: w0.text, btns: w0.btns, count: w0.count, sent: q0 })}`);
    // THE CODE FIELD DOES NOT WAIT FOR THE SQUAD ANSWER (review T8-R1-2). The
    // code frame is answered from memory, before any sign-in and with the
    // social layer off. CHANGED BY U4: the field is the window's.
    const w0w = await win(); await ev(`(Bay.show('home'), true)`);
    if (w0w && w0w.field && w0w.field.on && w0w.btns.some((b) => b.sq === 'code' && !b.dis) && w0w.fold === true && w0w.text.startsWith('Not loaded yet.'))
      ok(`${V}: the unanswered window still offers a live code field, above the fold`);
    else fail(`${V}: unanswered code field ${JSON.stringify(w0w && { field: w0w.field, btns: w0w.btns, fold: w0w.fold, text: w0w.text })}`);
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
        && w1 && w1.text.startsWith('Not loaded yet.') && w1.btns.some((b) => b.sq === 'retry' && b.dis) && w1.count === null)
      ok(`${V}: once introduced the box sends one bare {type:'squad',op:'resume'} and waits, still not claiming anything`);
    else fail(`${V}: bare resume frame ${JSON.stringify(f0)} box ${JSON.stringify(w1 && { text: w1.text, btns: w1.btns, count: w1.count })}`);

    // ---- 6. THE TWO ANSWERS TO `gone`. The mock answers the SAME frame the
    //      same way whatever this device remembered, so the suite cannot be
    //      green both with and without the bug.
    await reply({ op: 'gone' });
    const n = await box();
    if (n && n.text.startsWith(NOSQ) && !n.text.includes('ended') && n.count === '0/4')
      ok(`${V}: gone with nothing remembered is "No squad yet", and the box reads Squad 0/4 (D10)`);
    else fail(`${V}: no-squad ${JSON.stringify(n && { text: n.text, count: n.count })}`);
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
        && x.btns.some((b) => b.sq === 'retry' && !b.dis) && x.count === null)
      ok(`${V}: a refused resume says so, leaves the count out, and offers a live Retry`);
    else fail(`${V}: refusal ${JSON.stringify(x && { text: x.text, err: x.err, count: x.count, btns: x.btns })}`);
    // A REFUSED RESUME KEEPS THE CODE FIELD (review T8-R1-2): the code frame is
    // answered from memory while squads are refused. CHANGED BY U4: in the
    // window, which says the refusal too, with its own Retry. What the player
    // types there must outlive the answer that Retry brings back, so the rest
    // of this check is driven from the window.
    const xw = await win();
    if (xw && xw.field && xw.field.on && xw.btns.some((b) => b.sq === 'code' && !b.dis) && xw.fold === true
        && xw.err === 'Squads are not available right now. Try again later.' && xw.btns.some((b) => b.sq === 'retry' && !b.dis))
      ok(`${V}: a refused resume still offers a live code field in the window, above the fold, under the refusal and its Retry`);
    else fail(`${V}: refused code field ${JSON.stringify(xw && { field: xw.field, btns: xw.btns, fold: xw.fold, err: xw.err })}`);
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
    // WHILE RETRY'S QUESTION IS OUT THE WINDOW KNOWS NOTHING (review T8-R1-6):
    // Retry drops the old answer along with the refusal, so the wait reads
    // "Not loaded yet." and never "No squad yet".
    const inflight = await win();
    if (still.length === 0 && again.length === 1 && again[0].op === 'resume') ok(`${V}: Retry clears the refusal and asks again; a repaint does not`);
    else fail(`${V}: Retry sent ${JSON.stringify(again)} (a repaint sent ${still.length})`);
    if (inflight && inflight.text.startsWith('Not loaded yet.') && !inflight.text.includes(NOSQ))
      ok(`${V}: while Retry's question is out the box says "Not loaded yet.", not "No squad yet"`);
    else fail(`${V}: Retry in flight ${JSON.stringify(inflight && inflight.text)}`);
    await reply({ op: 'gone' });
    // THE ANSWER REPAINTS IN PLACE: the code field sits at the same place in
    // its column before and after it, so morphChildren keeps the node and the
    // player's typing (morphNode never touches an INPUT's value).
    const kept7 = await ev(`(() => { const i = document.getElementById('sqCode'); return i ? i.value : null; })()`);
    if (kept7 === 'MNPQ') ok(`${V}: the answer to Retry repaints the window and keeps what was typed in the code field`);
    else fail(`${V}: the answer dropped the typed code (${JSON.stringify(kept7)})`);
    await ev(`(() => { const i = document.getElementById('sqCode'); if (i) i.value = ''; Bay.show('home'); return true; })()`);

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
          && y.btns.some((b) => b.sq === 'retry' && !b.dis) && y.count === null)
        ok(`${V}: a resume answered ${JSON.stringify(ans7)} says "${line}", leaves the count out and offers Retry`);
      else fail(`${V}: resume answered ${JSON.stringify(ans7)} ${JSON.stringify(y && { text: y.text, err: y.err, count: y.count, btns: y.btns })}`);
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
    const s = await box(), sw = await win();
    await ev(`(Bay.show('home'), true)`);
    // CHANGED BY U4: the box shows the members, not the code; the code is the
    // window's, under "Your squad code".
    if (s && !s.text.includes(NOSQ) && !s.text.includes('ended') && !s.text.includes('Not loaded yet')
        && s.text.includes('Dusty Crag') && s.count === '2/4' && sw && sw.code === 'BKPQ' && (await stored()) === 'BKPQ'
        && JSON.stringify(await slot()) === '{"code":"BKPQ","n":2}')
      ok(`${V}: a snapshot renders as a squad -- Squad 2/4 and its members in the box, its code in the window -- lands in window.CC_SQUAD and is remembered`);
    else fail(`${V}: snapshot ${JSON.stringify(s && { text: s.text, count: s.count, code: sw && sw.code })} held=${JSON.stringify(await stored())} slot=${JSON.stringify(await slot())}`);

    // ---- 9. PUSHES (plan X7). The server sends the roster with NO request id
    //      when somebody else acts, and app.js's socialReply used to drop every
    //      id-less frame. A box that only reads its own answers never sees a
    //      friend join.
    const push = async (patch) => { await ev(`(handle(Object.assign({ type: 'squad' }, ${JSON.stringify(patch)})), true)`); await sleep(80); };
    const THIRD = M({ id: '00000000-0000-4000-8000-0000000000cc', callsign: 'Steel Mule' });
    await push({ ...SNAP, members: [...SNAP.members, THIRD] });
    const p1 = await box();
    if (p1 && p1.count === '3/4' && p1.text.includes('Steel Mule') && JSON.stringify(await slot()) === '{"code":"BKPQ","n":3}')
      ok(`${V}: an id-less roster push reaches the slot and repaints the box (3/4)`);
    else fail(`${V}: roster push ${JSON.stringify(p1 && { text: p1.text, count: p1.count })} slot=${JSON.stringify(await slot())}`);
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
    if (JSON.stringify(await slot()) === '{"code":"BKPQ","n":3}' && same && same.text.includes('Steel Mule') && same.count === '3/4'
        && (await squads()).length === 0)
      ok(`${V}: cc:account for the account already signed in keeps the squad and asks nothing`);
    else fail(`${V}: same-account cc:account ${JSON.stringify(same && { text: same.text, count: same.count })} slot=${JSON.stringify(await slot())} sent=${JSON.stringify(await squads())}`);

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
    if (kb && kb.text.includes('Dusty Crag') && kb.count === '2/4') ok(`${V}: the box keeps the squad on screen while a reconnect asks again`);
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
    if (kr && kr.text.includes('Dusty Crag') && kr.err === 'Squads are not available right now. Try again later.'
        && kr.btns.some((b) => b.sq === 'retry' && !b.dis) && kr.count === '2/4'
        && kq.length === 1 && kq[0].op === 'resume' && kq[0].code === 'BKPQ'
        && kk && kk.text.includes('Dusty Crag') && kk.err === '' && !kk.btns.some((b) => b.sq === 'retry'))
      ok(`${V}: a refused reconnect resume is said under the squad, and its Retry asks again by code`);
    else fail(`${V}: refused reconnect ${JSON.stringify({ kr: kr && { text: kr.text, err: kr.err, btns: kr.btns, count: kr.count }, kq, kk: kk && { text: kk.text, err: kk.err, btns: kk.btns } })}`);
    // THE CODE FIELD STAYS UNDER A SQUAD WHOSE RE-ASK WAS REFUSED (D-UI-2;
    // review T8-R1-5): #sqCode is the one code field (X8). CHANGED BY U4: the
    // window's, read after the same refusal.
    await reconnect(); await token();
    await reply({ error: 'unavailable' }); await settleFriends();
    const krw = await win();
    await clearTx(); await click('#bay [data-sq="retry"]'); await sleep(60);
    await reply(SNAP); await ev(`(Bay.show('home'), true)`);
    if (krw && krw.field && krw.field.on && krw.btns.some((b) => b.sq === 'code' && !b.dis) && krw.fold === true && krw.text.includes('BKPQ'))
      ok(`${V}: a squad whose re-ask was refused still offers a live code field in the window, above the fold`);
    else fail(`${V}: refused re-ask under a squad: code field ${JSON.stringify(krw && { field: krw.field, btns: krw.btns, fold: krw.fold, text: krw.text })}`);

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
    if (nb && nb.text.startsWith(NOSQ) && nq.length === 1 && nq[0].op === 'resume' && !('code' in nq[0]) && ns && ns.text.includes('Dusty Crag') && ns.count === '2/4')
      ok(`${V}: \`gone\` to a tab that held nothing is "No squad yet", and its next return asks once more`);
    else fail(`${V}: held-nothing return ${JSON.stringify({ nb: nb && nb.text, nq, ns: ns && ns.text })}`);

    // ---- 12. HOW A SQUAD ENDS FOR THIS TAB. Every way a connected member's
    //       membership ends sends them a frame (D-BLOCK), and the box says what
    //       it says -- never why. A block that removes a player sends EXACTLY
    //       the kick frame, so it reads exactly as a kick.
    // CHANGED BY U4: the fourth column was whether Invite friends was offered
    // under the line; that button went with the tabs, and the friends online
    // carry their own Invite, live or dead by sqCanInvite (E8 pins it). The
    // code field is in the window under every line, read once below.
    const ENDS = [
      [{ op: 'ended', reason: 'kicked' }, 'You were removed from the squad.', null, true, '0/4'],
      [{ op: 'ended', reason: 'left' }, 'You left the squad.', null, true, '0/4'],
      [{ op: 'left', ok: true, id: 987654 }, 'You left the squad.', null, true, '0/4'],
      [{ op: 'ended', reason: 'no_leader' }, 'Your squad has ended. Squad up again.', null, true, '0/4'],
      [{ op: 'ended', reason: 'constructor' }, 'Your squad has ended. Squad up again.', null, true, '0/4'],
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
    for (const [frame, line, keep, , count] of ENDS) {
      await push(SNAP);
      await push(frame);
      const e = await box();
      const word = await ev('window.CC_SQUAD_END');
      if (e && e.text.startsWith(line)
          && (await slot()) === null && (await stored()) === keep && e.count === count
          && word === (frame.op === 'left' ? 'left' : endWord[frame.reason]))
        ok(`${V}: ${frame.op}${frame.reason ? ':' + frame.reason : ''} -- "${line}", the slot is empty and the code is ${keep ? 'kept' : 'forgotten'}`);
      else fail(`${V}: ${JSON.stringify(frame)} ${JSON.stringify(e && { text: e.text, btns: e.btns, count: e.count })} slot=${JSON.stringify(await slot())} held=${JSON.stringify(await stored())} end=${JSON.stringify(word)}`);
    }
    // The window under the last line, `elsewhere`: the same line, and the code
    // field live (it was offered under every line in the box).
    const eW = await win(); await ev(`(Bay.show('home'), true)`);
    if (eW && eW.text.startsWith('Your squad was changed in another tab or on another device.') && eW.field && eW.field.on && eW.sub === 'Open on another tab or device')
      ok(`${V}: under "elsewhere" the window says the same line and still offers the code field`);
    else fail(`${V}: window under elsewhere ${JSON.stringify(eW && { text: eW.text, field: eW.field, sub: eW.sub })}`);
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
        && b2 && b2.text.includes('Dusty Crag') && b2.count === '1/4' && settled.length === 0)
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
    //      CHANGED BY U4 (owner, 2026-10-06: the field moves into the Manage
    //      squad window, and joins squads only -- game codes are retired): the
    //      field is driven in the window, where its error line is `cerr`; a
    //      room's code is said to be a game's and joins nothing (it went down
    //      #codeInput/#joinBtn); and an unknown code is "No squad with that
    //      code." (it was "No squad or game with that code.").
    const SQ_NONE = 'No squad with that code.';
    const SQ_GAME = 'That is a game code. Only squad codes join here.';
    const typeCode = (v) => ev(`(() => { if (document.getElementById('bay').dataset.scr !== 'squad') Bay.show('squad'); const i = document.getElementById('sqCode'); if (!i) return false; i.value = ${JSON.stringify(v)}; return true; })()`);
    const codeReply = async (patch) => { const r = await ev(`(() => {
      const q = window.__tx.filter((f) => f.type === 'code'); const i = q.length ? q[q.length - 1].id : null;
      handle(Object.assign({ type: 'code', id: i }, ${JSON.stringify(patch)})); return i; })()`); await sleep(120); return r; };
    const enterCode = async (v) => { await typeCode(v); await clearTx(); await click('#bay [data-sq="code"]'); await sleep(40); };
    // (a) too short -- refused on this side, no frame at all
    await enterCode('AB');
    const short = await win();
    if ((await tx()).length === 0 && short && short.cerr === 'Enter the 4-letter code.')
      ok(`${V}: a short code is refused here and never reaches the socket`);
    else fail(`${V}: short code ${JSON.stringify({ tx: await tx(), err: short && short.cerr })}`);
    // (b) A GAME'S CODE JOINS NOTHING (U4): it is asked about, upper-cased, and
    //     said to be a game's; #codeInput/#joinBtn are never touched.
    await ev(`(() => { window.__joined = null; const b = $('joinBtn'); window.__joinFn = b.onclick; b.onclick = () => { window.__joined = $('codeInput').value || 'pressed'; }; return true; })()`);
    await enterCode('mnpq');
    const asked = (await tx()).filter((f) => f.type === 'code');
    await codeReply({ kind: 'room' });
    const joined = await ev('window.__joined'), gw14 = await win();
    await ev(`($('joinBtn').onclick = window.__joinFn, true)`);
    if (asked.length === 1 && asked[0].code === 'MNPQ' && joined === null && gw14 && gw14.cerr === SQ_GAME
        && !(await tx()).some((f) => f.type === 'join' || (f.type === 'squad' && f.op === 'join')))
      ok(`${V}: a game's code is upper-cased and asked about, then said to be a game's -- nothing joins`);
    else fail(`${V}: game code asked=${JSON.stringify(asked)} joined=${JSON.stringify(joined)} said=${JSON.stringify(gw14 && gw14.cerr)}`);
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
    const jn = await win();
    if (j.length === 1 && j[0].code === 'BKPQ' && j[0].name === who.name && j[0].skin === who.skin)
      ok(`${V}: a squad code sends squad op:'join' with this player's callsign and paint`);
    else fail(`${V}: squad branch ${JSON.stringify(j)} want ${JSON.stringify(who)}`);
    // D-BLOCK-2 A: a refused join reads EXACTLY as an unknown code does, so a
    // join a block refuses shows the ordinary view.
    if (jn && jn.cerr === SQ_NONE) ok(`${V}: a join refused no_such_squad says what an unknown code says`);
    else fail(`${V}: join no_such_squad ${JSON.stringify(jn && jn.cerr)}`);
    // EVERY DECIDED JOIN REFUSAL, one row each (review T8-R1-12): a key edited
    // or deleted in SOC_ERR reads the generic fallback, and only a row per key
    // can see that. The last row is a code this build does not know.
    for (const [code, line] of [['already_in', 'You are already in that squad on another device.'], ['full', 'That squad is full.'],
      ['slow_down', 'Too many tries. Wait a moment.'], ['offline', 'Not connected. Try again in a moment.'],
      ['unavailable', 'That squad could not be joined right now. Try again later.'],
      ['not_a_code_this_build_knows', 'That squad could not be joined right now. Try again later.']]) {
      await joinWith({ op: 'join', error: code });
      const jx = await win();
      if (jx && jx.cerr === line) ok(`${V}: a join refused ${code} says "${line}"`);
      else fail(`${V}: join ${code} ${JSON.stringify(jx && jx.cerr)}`);
    }
    // And a join that lands: the roster is the answer, the box shows it, and
    // this tab's next reconnect takes its row back WITH the code again.
    await joinWith(SNAP);
    const jok = await win(), jokb = await box();
    await reconnect(); await token();
    const coded = await squads();
    await reply(SNAP); await settleFriends();
    if (jok && jok.text.includes('Dusty Crag') && !jok.cerr && jokb && jokb.count === '2/4' && (await stored()) === 'BKPQ' && coded.length === 1 && coded[0].code === 'BKPQ')
      ok(`${V}: a join that lands shows the squad, and a reconnect resumes it by code`);
    else fail(`${V}: join landed ${JSON.stringify(jok && { text: jok.text, err: jok.cerr, count: jokb && jokb.count })} reconnect=${JSON.stringify(coded)}`);
    // A SQUAD ON SCREEN IS A SQUAD THIS TAB HAD (review T8-R1-13). After a
    // `gone` the tab's next return owes one more question, BARE; the player may
    // join a squad by code meanwhile. If that squad has ended by the time the
    // return asks, the bare question presents no code, and the squad on screen
    // alone makes "has ended" the true line.
    // CHANGED BY FIX WAVE W2 (E9, the Invite that flipped back). A squad this
    // tab joined since a `gone` has answered the question that `gone` left
    // owing: the return asks NOTHING, and roster pushes keep the box true from
    // here. (What this check pinned before -- a BARE question answered `gone`
    // while a squad is on screen reads "has ended" -- can no longer be reached:
    // a tab with a squad on screen holds its row and asks by code, and the
    // coded path's "has ended" is pinned by the reconnect checks above.)
    // Proved red with the fix's `sq.again = false` taken out of the cc:squad
    // listener: the return then asks bare again.
    await ask(''); await reply({ op: 'gone' });
    await joinWith(SNAP);
    await clearTx(); await focus();
    const hq = await squads();
    if (hq.length === 0)
      ok(`${V}: a return after joining a squad asks nothing more of the server`);
    else fail(`${V}: gone with a squad on screen ${JSON.stringify({ hq })}`);
    // (d) NONE
    await push({ op: 'ended', reason: 'left' });
    await enterCode('ZZZZ'); await codeReply({ kind: 'none' });
    const none = await win();
    if (none && none.cerr === SQ_NONE) ok(`${V}: an unknown code is told the truth (5.3)`);
    else fail(`${V}: none branch ${JSON.stringify(none && none.cerr)}`);
    await up(false); const noneOff = await win(); await up(true);
    if (noneOff && noneOff.cerr === '' && noneOff.field && !noneOff.field.on) ok(`${V}: offline, the field's last answer is not left under a dead field`);
    else fail(`${V}: offline code error ${JSON.stringify(noneOff && { err: noneOff.cerr, field: noneOff.field })}`);
    // A REFUSED CODE FRAME IS NOT AN UNKNOWN CODE (review T8-R1-11): a timeout
    // on a live socket answers 'unavailable', and telling that player a valid
    // code does not exist is the lie. Each refusal says its own decided
    // sentence (review T8-R1-12).
    await win();                                                // repaint: the socket coming back is not one by itself here
    for (const [cerr, line] of [['unavailable', 'That code could not be checked right now. Try again later.'],
      ['offline', 'Not connected. Try again in a moment.']]) {
      await enterCode('MNPQ'); await codeReply({ error: cerr });
      const cx = await win();
      if (cx && cx.cerr === line) ok(`${V}: a code frame refused ${cerr} says "${line}", not that the code does not exist`);
      else fail(`${V}: code frame refused ${cerr} ${JSON.stringify(cx && cx.cerr)}`);
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
    await ev(`(() => { const i = document.getElementById('sqCode'); if (i) { i.value = ''; i.blur(); } return true; })()`);
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
    if (outAsk.length === 0 && gj.length === 1 && gin && gin.text.includes('Steel Mule') && gin.count === '2/4' && !gin.text.includes('You can play right now'))
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
    if (JSON.stringify(minted) === '{"code":"BKPQ","n":2}' && gmint && gmint.text.includes('Steel Mule') && gmint.count === '2/4')
      ok(`${V}: an anonymous account minted mid-squad keeps the squad`);
    else fail(`${V}: minted account dropped the squad ${JSON.stringify(gmint && gmint.text)} slot=${JSON.stringify(minted)}`);
    // And a guest who is kicked is told so, above everything a guest can do.
    await push({ op: 'ended', reason: 'kicked' });
    const gk = await box();
    if (gk && gk.text.startsWith('You were removed from the squad. ' + G1)) ok(`${V}: a kicked guest is told, and offered the way to a squad code again`);
    else fail(`${V}: kicked guest ${JSON.stringify(gk && gk.text)}`);
    await setWho('in');
    await ask(''); await reply(SNAP);

    // ---- 15. TWO EVENTS. cc:social is what a fresh friends snapshot rides, and
    //      'home' was not in bay.js's repaint list. cc:account is where a squad
    //      that belonged to somebody else must be dropped.
    const FRIENDS = `{ friends: [{ id: 'a', callsign: 'Dusty Crag', online: true }, { id: 'b', callsign: null, online: false }],
      requests: { in: [{ id: 'c', callsign: 'Steel Mule' }], out: [] }, blocked: [], friendCode: 'AB12CD', callsign: null }`;
    await ev(`(Bay.show('home'), window.CC_SOCIAL = ${FRIENDS}, document.dispatchEvent(new Event('cc:social')), true)`);
    await sleep(60);
    // CHANGED BY U4: the Friends tab, its count pill and its request lamp went
    // with the tabs. The box's friends part reads "Friends online · 1", and the
    // lamp is on Manage, which is where a request is answered now.
    const fr1 = await ev(`(() => { const f = document.querySelector('#bay .sqx .sqbf'), m = document.querySelector('#bay .sqmg');
      return f && m ? { head: (f.querySelector('.sqh') || {}).textContent, dot: !m.querySelector('.sqd').classList.contains('hidden') } : null; })()`);
    if (fr1 && fr1.head === 'Friends online \u00b7 1' && fr1.dot === true)
      ok(`${V}: cc:social repaints home -- "Friends online · 1", and Manage carries the waiting-request lamp`);
    else fail(`${V}: friends online ${JSON.stringify(fr1)}`);
    // THE LAMP IS NOT THE ONLY WAY TO KNOW (review T8-R1-17): it is aria-hidden,
    // so Manage's name says the waiting request in words.
    const frName = await ev(`(() => { const t = document.querySelector('#bay .sqmg'); return t ? t.getAttribute('aria-label') : null; })()`);
    if (frName === 'Manage squad, 1 friend request waiting') ok(`${V}: Manage's name says 1 friend request waiting`);
    else fail(`${V}: Manage name ${JSON.stringify(frName)}`);
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
    if (flip && flip.text.startsWith('Not loaded yet.') && !flip.text.includes('Dusty Crag') && flip.count === null && (await stored()) === null && (await slot()) === null
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

    // ---- 16. THE FRIENDS, v1 (design 5.1): the counts D13 asks for and the
    //      door to the full screen. Task 9 adds the rows and Invite under them.
    //      A count must be ABSENT, not zero, while CC_SOCIAL is null.
    //      CHANGED BY U4: the Friends tab became the box's "Friends online"
    //      part (its unknown, refused and Retry states) and the window's
    //      friends column (the counts and the door to the Friends screen).
    await ev(`(window.CC_SOCIAL = null, window.CC_SOCIAL_ERR = '', window.CC_SOCIAL_ASKING = false, document.dispatchEvent(new Event('cc:social')), true)`);
    const fu = await box();
    if (fu && fu.ftext.startsWith('FRIENDS ONLINE Not loaded yet.') && !/\d/.test(fu.ftext) && !fu.ftext.includes('No friends'))
      ok(`${V}: the box's friends with no snapshot say "Not loaded yet.", and the count is absent rather than 0`);
    else fail(`${V}: friends unknown ${JSON.stringify(fu && fu.ftext)}`);
    // A REFUSED FRIENDS READ HAS A RETRY (review T8-R1-7). Nothing re-asks it by
    // itself -- it is eight round trips on the server, asked once per
    // connection and per sign-in -- so the box offers the tap, and says Loading
    // while that question is out.
    await ev(`(window.CC_SOCIAL_ERR = 'unavailable', document.dispatchEvent(new Event('cc:social')), true)`);
    const fe = await box();
    await clearTx(); await click('#bay [data-sq="fretry"]'); await sleep(60);
    const fq = (await tx()).filter((f) => f.type === 'friends');
    const fl = await box();
    await ev(`(() => { for (const f of window.__tx.filter((x) => x.type === 'friends')) handle({ type: 'friends', error: 'unavailable', id: f.id }); window.CC_SOCIAL_ERR = ''; document.dispatchEvent(new Event('cc:social')); return true; })()`);
    await sleep(60);
    if (fe && fe.ftext.includes('Friends are not available right now. Try again later.') && fe.btns.some((b) => b.sq === 'fretry' && !b.dis && b.t === 'Retry')
        && fq.length === 1 && fl && fl.btns.some((b) => b.sq === 'fretry' && b.dis && b.t === 'Loading'))
      ok(`${V}: a refused friends read offers Retry, which asks once and says Loading while it waits`);
    else fail(`${V}: friends retry ${JSON.stringify({ fe: fe && { ftext: fe.ftext, btns: fe.btns }, fq, fl: fl && fl.btns })}`);
    await ev(`(window.CC_SOCIAL = ${FRIENDS}, document.dispatchEvent(new Event('cc:social')), true)`);
    await sleep(60);
    const fk = await win(), fkb = await box();
    // CHANGED BY TASK 9, which adds the Request and Friends rows under these
    // count lines (C11): the three lines are still the column's opening words,
    // exactly, and + Add friend is still its last; what now sits between them
    // is task 9's own check's to read.
    if (fk && fk.ftext.startsWith('Your friends · 2 1 online now. 1 request waiting for an answer. ') && fk.ftext.endsWith(' + ADD FRIEND')
        && fk.btns.some((b) => b.go === 'friends' && !b.dis)
        && fkb && fkb.ftext.startsWith('FRIENDS ONLINE · 1 ') && fkb.ftext.includes('Dusty Crag'))
      ok(`${V}: the window reads 2 friends, 1 online, 1 request, and offers the door to the screen; the box lists the one online`);
    else fail(`${V}: friends known ${JSON.stringify({ win: fk && { text: fk.ftext, btns: fk.btns }, box: fkb && fkb.ftext })}`);

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
    const iso2 = await win();
    await reply({ op: 'gone' });
    if (cq.length === 1 && iso2 && iso2.text.startsWith('Not loaded yet.') && iso2.cerr === '')
      ok(`${V}: the old account's code answer does not land on the new account's field`);
    else fail(`${V}: code answer crossed accounts ${JSON.stringify({ cq, iso2: iso2 && [iso2.text, iso2.cerr] })}`);
    await typeCode(''); await ev(`(Bay.show('home'), true)`);

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
    // AND SO DOES ENTERING THE MANAGE SQUAD WINDOW (U4), which draws the same
    // state: a player who goes straight there must not sit on "Not loaded yet."
    // A repaint of it asks nothing.
    await ev(`(Bay.go('career'), true)`);
    await clearTx();
    await ev(`(helloWs = S.ws, helloN++, true)`);
    await sleep(60);
    const unheardW = await squads();
    await ev(`(Bay.go('squad'), true)`); await sleep(60);
    const onEntryW = await squads();
    await clearTx(); await ev(`(document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60);
    const repaintW = await squads();
    await answer(onEntryW[0] && onEntryW[0].id, { type: 'squad', ...SNAP }); await ev(`(Bay.show('home'), true)`);
    if (unheardW.length === 0 && onEntryW.length === 1 && onEntryW[0].op === 'resume' && repaintW.length === 0)
      ok(`${V}: entering the Manage squad window asks about an introduction no event announced, and a repaint of it does not`);
    else fail(`${V}: window entry hook: before ${JSON.stringify(unheardW)}, on entry ${JSON.stringify(onEntryW)}, on a repaint ${JSON.stringify(repaintW)}`);

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
    const lb = await box(), lw = await win();
    await ev(`(Bay.show('home'), true)`);
    const lookEnd = await ev('window.CC_SQUAD_END');
    // AND THE SQUAD COUNT IS LEFT OUT (review T8-R1-6): the account has a
    // squad, on another socket, so "0/4" would be false and a count this tab
    // has not been told is not a count. CHANGED BY U4: the code field is the
    // window's, and no squad control there either -- Copy, Ready, Leave.
    if (lk.length === 1 && !('code' in lk[0]) && lb && lb.text.startsWith(OPEN) && !lb.text.includes('BKPQ') && !lb.text.includes('Dusty Crag') && lb.count === null
        && (await slot()) === null && lookEnd === 'open' && (await stored()) === null
        && lw && lw.text.startsWith(OPEN) && lw.field && lw.field.on && lw.btns.some((b) => b.sq === 'code' && !b.dis)
        && !lw.btns.some((b) => ['ready', 'leave'].includes(b.sq) || (b.sq === 'link' && !b.dis)))
      ok(`${V}: a held:false roster reads "${OPEN}", with no squad control and the code field, and is neither in the slot nor stored`);
    else fail(`${V}: look-only answer ${JSON.stringify({ box: lb && { text: lb.text, btns: lb.btns, count: lb.count }, win: lw && { text: lw.text, btns: lw.btns, field: lw.field } })} slot=${JSON.stringify(await slot())} end=${JSON.stringify(lookEnd)} held=${JSON.stringify(await stored())} asked=${JSON.stringify(lk)}`);
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
    if (lh && lh.text.includes('Dusty Crag') && lh.count === '2/4' && !lh.text.includes(OPEN) && JSON.stringify(await slot()) === '{"code":"BKPQ","n":2}'
        && lcoded.length === 1 && lcoded[0].op === 'resume' && lcoded[0].code === 'BKPQ')
      ok(`${V}: a held:true answer makes the squad this tab's again, and its next reconnect resumes by code`);
    else fail(`${V}: held again ${JSON.stringify(lh && lh.text)} slot=${JSON.stringify(await slot())} reconnect=${JSON.stringify(lcoded)}`);
    // A held:false frame never writes over the slot, even one holding a
    // roster, and never spends the device's code: the account's squad lives.
    await push(LOOK);
    const lp = await box();
    if ((await slot()) === null && (await ev('window.CC_SQUAD_END')) === 'open' && (await stored()) === 'BKPQ' && lp && lp.text.startsWith(OPEN)
        && lp.count === null)
      ok(`${V}: a held:false push empties the slot, says the squad is open elsewhere, leaves the count out, and keeps the code`);
    else fail(`${V}: held:false push ${JSON.stringify(lp && { text: lp.text, count: lp.count })} slot=${JSON.stringify(await slot())} held=${JSON.stringify(await stored())}`);
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
    // CHANGED BY U4: Invite friends was offered under the line; that button
    // went with the tabs (the friends online carry their own Invite).
    if (s21 && s21.text.startsWith('Your squad has ended. Squad up again.') && s21.count === '0/4' && spent21 === null)
      ok(`${V}: gone with a remembered code is the neutral "has ended" line, and the code is spent`);
    else fail(`${V}: squad-gone ${JSON.stringify(s21 && { text: s21.text, count: s21.count })} held=${JSON.stringify(spent21)}`);
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
if (want('t9')) try {
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
  // ONE READER FOR THE SQUAD COLUMN AND ONE FOR THE FRIENDS COLUMN. Visible
  // means rendered: a node carrying .hidden is in the tree for
  // morphChildren's sake and says nothing.
  // CHANGED BY U4: the squad and its controls moved from the box's Squad pane
  // into the Manage squad window's middle column (#sqWin-squad), and the
  // friend rows into its right-hand column (#sqWin-friends); the code field
  // into its left-hand column (#sqWin-code). The dashed "+ Invite a friend"
  // row went (the friends are in the next column) and the Squad tab's dot and
  // label with the tabs. The rest reads as it did.
  const t9box = () => ev(`(() => {
    Bay.show('squad');
    const pane = document.getElementById('sqWin-squad'), pnl = pane, cc = document.getElementById('sqWin-code');
    if (!pane || !cc) return null;
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
      head: txt(':scope > .sqh'),
      summary: txt('.sqml .sqn'),
      add: vis(q('.sqadd')), link: btn('[data-sq="link"]', cc),
      seats: vis(q('.sqs')) ? [...pane.querySelectorAll('.sqs span')].map((s) => s.textContent + (s.classList.contains('on') ? '*' : '')) : [],
      note: txt('.sqnote'), line: txt('.sqft .sqfl'), foot: vis(q('.sqft')),
      start: btn('[data-sq="start"]'), ready: btn('[data-sq="ready"]'), leave: btn('[data-sq="leave"]'), rack: btn('[data-sq="rack"]'),
      kok: btn('[data-sq="kok"]'), kcancel: btn('[data-sq="kcancel"]'),
      aerr: txt('.sqft ~ .sqae, .sqml ~ .sqae'),
      rerr: (() => { const e = pane.querySelector(':scope > .sqe'); return vis(e) ? e.textContent : ''; })(),
      retry: btn('[data-sq="retry"]'),
      inv: vis(i) ? { t: (i.querySelector('.sqit') || { textContent: '' }).textContent, join: btn('[data-sq^="join:"]', i), ign: btn('[data-sq^="ignore:"]', i),
        err: (() => { const e = i.querySelector('.sqae'); return vis(e) ? e.textContent : ''; })() } : null,
      codes: document.querySelectorAll('#sqCode').length,
      codeInPane: !!pane.querySelector('#sqCode'), codeInCol: !!cc.querySelector('#sqCode'),
      invRole: (() => { const w = pane.querySelector('.sqiw'); return w ? w.getAttribute('role') : null; })(),
      invLive: !!(i && i.closest('[role="status"]')),
      // Where the one code field sits among its column's own children: the
      // typed value survives a repaint only while this index does.
      codeAt: [...cc.children].findIndex((c) => c.id === 'sqCode' || (c.querySelector && c.querySelector('#sqCode'))),
      footIn: (() => { const f = q('.sqft'); if (!vis(f)) return null; const r = f.getBoundingClientRect(); return r.top >= pr.top - 0.5 && r.bottom <= pr.bottom + 0.5; })(),
      // How far above the column's inner bottom edge the pinned footer sits,
      // in px: rows scrolling past would show through any strip below it.
      footGap: (() => { const f = q('.sqft'); if (!vis(f)) return null; return +(pr.bottom - parseFloat(getComputedStyle(pane).borderBottomWidth) - f.getBoundingClientRect().bottom).toFixed(2); })(),
      // The column ends inside the page body: it scrolls, it never spills.
      inside: (() => { const b = document.querySelector('#bay .pbody'); return !!b && pr.bottom <= b.getBoundingClientRect().bottom + 0.5; })(),
      ownLaunch: !!pane.querySelector('.launch, [data-launch], [data-rdy]'),
      bayOver: (() => { const b = document.getElementById('bay'); return b.scrollWidth > b.clientWidth || b.scrollHeight > b.clientHeight; })(),
    };
  })()`);
  // THE HOME BOX, for the checks that read what U4 left there: its member
  // rows (name and status), the action line under them, and the invite row.
  const t9home = () => ev(`(() => {
    Bay.show('home');
    const p = document.querySelector('#bay .sqx'); if (!p) return null;
    const vis = (e) => !!e && !e.closest('.hidden') && e.getClientRects().length > 0;
    const i = p.querySelector('.sqi');
    const ae = p.querySelector('.sqml ~ .sqae');
    return {
      rows: [...p.querySelectorAll('.sqml .sqm')].filter(vis).map((r) => ({ name: r.querySelector('.sqmt').textContent, state: (r.querySelector('.sqr') || { textContent: '' }).textContent,
        tick: vis(r.querySelector('.sqr.on svg')), lead: vis(r.querySelector('.sql')), kick: !!r.querySelector('[data-sq^="kick:"]'), menu: vis(r.querySelector('.pmb')) })),
      aerr: vis(ae) ? ae.textContent : '',
      inv: vis(i) ? { t: (i.querySelector('.sqit') || { textContent: '' }).textContent, join: !!i.querySelector('[data-sq^="join:"]'), ign: !!i.querySelector('[data-sq^="ignore:"]') } : null,
      invRole: (() => { const w = p.querySelector('.sqb > .sqiw'); return w ? w.getAttribute('role') : null; })(),
      say: (document.querySelector('#bay .lbar .rdy .rdys') || {}).textContent || null,
      text: p.querySelector('.sqb').innerText.replace(/\\s+/g, ' ').trim(),
      ctl: [...p.querySelectorAll('[data-sq]')].map((b) => b.getAttribute('data-sq')),
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
  const t9press = (v, paneId = 'sqWin-squad') => ev(`(() => { const f = document.getElementById(${JSON.stringify(paneId)}); const b = document.createElement('button');
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
    //      line lit by `fits`, the mode readout and a live Ready -- and the
    //      one code field below the roster (D-UI-2).
    //      CHANGED BY U3 (owner, 2026-10-06: every player readies, the leader
    //      too, and nobody starts): the leader's row carries its own tick, as
    //      every row does (it said only Leader since fix wave E9), and the
    //      leader's footer has Ready where Start was. Start is gone.
    //      CHANGED BY U4: read in the Manage squad window. The dashed invite
    //      row is gone -- the friends column stands beside the squad -- and its
    //      code link is the code column's Copy, under the code itself; the
    //      one code field is in the code column, not under the roster; the
    //      column has a "Members 2/4" heading; Ready reads as a word as well
    //      as a tick (row state "Ready").
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const a1 = await t9box();
    if (a1 && a1.rows.length === 2 && a1.head === 'Members \u00b7 2/4'
        && a1.rows[0].name === 'Dusty Crag' && a1.rows[0].you && a1.rows[0].lead && a1.rows[0].tick && a1.rows[0].state === 'Ready' && a1.rows[0].dot && a1.rows[0].lit
        && a1.rows[1].name === 'Steel Mule' && !a1.rows[1].you && !a1.rows[1].lead && a1.rows[1].tick
        && !a1.add && a1.link && a1.link.t === 'Copy' && !a1.link.dis
        && JSON.stringify(a1.seats) === JSON.stringify(['Duel 2*', 'FFA 2–4*', 'Boss 1–2*', 'Aliens 1–2*', 'Golf 1–4*'])
        && a1.line === 'Duel · 2' && !a1.start && a1.ready && !a1.ready.dis && a1.ready.t === 'Ready' && a1.ready.pressed === 'true'
        && a1.leave && !a1.leave.dis && a1.leave.t === 'Leave'
        && a1.codes === 1 && !a1.codeInPane && a1.codeInCol && a1.codeAt === 1
        && !a1.ownLaunch && a1.inside && !a1.bayOver && !a1.rows.some((r) => r.over))
      ok(`${V}: leader forming -- rows with a drawn lamp, (you), Leader and a tick on every ready row, the Seats line lit by fits, Ready (no Start) and Leave live, Copy beside the code, and the one code field in the code column`);
    else fail(`${V}: leader forming ${JSON.stringify(a1)}`);
    // The leader's Remove and the player menu are on the OTHER row only.
    if (a1 && a1.rows.length === 2 && !a1.rows[0].menu && !a1.rows[0].kick && a1.rows[1].menu && a1.rows[1].kick && !a1.rows[1].kick.dis && a1.rows[1].kick.v === 'kick:' + RID_MULE)
      ok(`${V}: the leader sees Remove and the player menu on every row but their own`);
    else fail(`${V}: leader row controls ${JSON.stringify(a1 && a1.rows.map((r) => ({ menu: r.menu, kick: r.kick })))}`);

    // ---- A2. NO READY UP WHERE THE SEATS REFUSE, BOTH WAYS (X6). Too big:
    //      three on a duel. Too small: one on a free-for-all. The footer keeps
    //      the spec's "<Mode> · seats N, squad M", which is true in both
    //      directions. CHANGED BY U3: the leader's dead control was Start; it is
    //      the leader's own Ready now, dead for standing UP (sqUpWhy). CHANGED
    //      BY THE UPDATE 8 REVIEW: the squad of one has no Ready at all (owner:
    //      ready-up appears once a second player joins); its footer still says
    //      why the seats refuse.
    await t9state({ members: [T9YOU(), T9MULE({ ready: true }), T9PIKE({ ready: true })] });
    const a2 = await t9box();
    await t9state({ mode: 'ffa', members: [T9YOU()] });
    const a2s = await t9box();
    if (a2 && !a2.start && a2.ready && a2.ready.dis && a2.line === 'Duel · seats 2, squad 3'
        && JSON.stringify(a2.seats) === JSON.stringify(['Duel 2', 'FFA 2–4*', 'Boss 1–2', 'Aliens 1–2', 'Golf 1–4*'])
        && a2s && !a2s.ready && a2s.line === 'Free-for-all · seats 2–4, squad 1')
      ok(`${V}: a squad too big for the armed mode has a dead Ready, a squad of one none, and the footer says why the seats refuse`);
    else fail(`${V}: seats refusal ${JSON.stringify({ big: a2 && { ready: a2.ready, line: a2.line, seats: a2.seats }, small: a2s && { ready: a2s.ready, line: a2s.line } })}`);
    // A2b. THE BOX READS `fits`, IT DOES NOT COUNT. Two members, which the seat
    //      table says fit a duel, and a frame that says they do not: the frame
    //      wins, because it is the one truth the boards read too.
    await t9state({ members: [T9YOU(), T9MULE({ ready: true })], fits: { duel: false, ffa: true, boss: true, aliens: true, golf: true } });
    const a2b = await t9box();
    if (a2b && a2b.ready && a2b.ready.dis && a2b.line === 'Duel · seats 2, squad 2' && a2b.seats[0] === 'Duel 2')
      ok(`${V}: Ready and the Seats line follow the frame's fits, not a count of the rows`);
    else fail(`${V}: fits not read ${JSON.stringify(a2b && { ready: a2b.ready, line: a2b.line, seats: a2b.seats })}`);

    // ---- A3. WAITING ON READINESS. One flag different from A1: the footer
    //      counts the member it waits for, and the ready leader can still stand
    //      down. And a member who is DROPPED is not ready whatever their flag
    //      says (task 5: a dropped row can arrive ready, readied from another
    //      device before the drop): the row says Reconnecting, no tick, the
    //      lamp is dark, and nobody can ready up beside them.
    //      CHANGED BY U3: this held the leader's Start; the leader readies now.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: false })] });
    const a3 = await t9box();
    await t9state({ members: [T9YOU(), T9MULE({ ready: true, dropped: true })] });
    const a3d = await t9box();
    if (a3 && a3.rows.length === 2 && a3d && a3d.rows.length === 2 && a3.ready && !a3.ready.dis && a3.ready.pressed === 'true' && a3.line === 'Waiting for 1' && a3.rows[1].state === 'Not ready' && !a3.rows[1].tick
        && a3d && a3d.ready && a3d.ready.dis && a3d.line === 'Waiting for 1' && a3d.rows[1].state === 'Reconnecting' && !a3d.rows[1].tick && !a3d.rows[1].lit)
      ok(`${V}: a member not ready, or dropped though marked ready, is counted on the footer; a ready leader can stand down, and nobody can ready up beside a dropped member`);
    else fail(`${V}: readiness refusal ${JSON.stringify({ a3: a3 && { ready: a3.ready, line: a3.line, row: a3.rows[1] }, a3d: a3d && { ready: a3d.ready, line: a3d.line, row: a3d.rows[1] } })}`);

    // ---- A4. THE RACK IS THE SQUAD MODE'S, NOT THE ARMED ONE'S, AND A SHORT
    //      ONE NEVER STOPS A READY. CHANGED BY U3 (owner, 2026-10-06: a short
    //      rack is filled with standard weapons, never a reason a start fails):
    //      a short rack put the Armoury's "Pick N more" door where Start or
    //      Ready stood (task 11, D-UI-3); now Ready is live and sends the
    //      stored picks with the empty slots filled from the standard draft and
    //      then the pool, and that rack is saved. Five picks fill a duel; a
    //      Boss Fight squad drafts seven, whatever mode this device has armed
    //      on its own boards. The leader readies here, as every player does.
    const t9ready = async () => {
      await clearTx(); await t9click('#bay [data-sq="ready"]'); await sleep(40);
      const f = (await squads()).filter((x) => x.op === 'ready');
      if (f.length) await reply({ op: 'ready', error: 'unavailable' });
      return f;
    };
    const t9stored = () => ev(`JSON.parse(localStorage.getItem('cc_loadout'))`);
    await t9rack(['mortar', 'cluster', 'napalm']);
    await t9state({ members: [T9YOU(), T9MULE({ ready: true })] });
    const a4 = await t9box(), a4f = await t9ready(), a4s = await t9stored();
    await t9rack(FIVE);
    await t9state({ mode: 'boss', members: [T9YOU(), T9MULE({ ready: true })] });
    const a4b = await t9box(), a4bf = await t9ready(), a4bs = await t9stored();
    const BOSS7 = FIVE.concat(['gas', 'buster']);
    if (a4 && !a4.rack && !a4.start && a4.ready && !a4.ready.dis && a4f.length === 1 && a4f[0].ready === true && JSON.stringify(a4f[0].loadout) === JSON.stringify(FIVE)
        && JSON.stringify(a4s) === JSON.stringify(FIVE)
        && a4b && !a4b.rack && a4b.ready && !a4b.ready.dis && a4bf.length === 1 && JSON.stringify(a4bf[0].loadout) === JSON.stringify(BOSS7)
        && JSON.stringify(a4bs) === JSON.stringify(BOSS7) && (await ev('ccMode')) === 'duel')
      ok(`${V}: a rack short of the squad mode's draft readies anyway, filled with standard weapons and saved -- three to a duel's five, five to a Boss Fight's seven`);
    else fail(`${V}: short rack ${JSON.stringify({ a4: a4 && { ready: a4.ready, rack: a4.rack }, a4f, a4s, a4b: a4b && { ready: a4b.ready, rack: a4b.rack }, a4bf, a4bs, armed: await ev('ccMode') })}`);
    // AND THE OTHER WAY ROUND: seven picks stored, Duel armed on this device, a
    // Boss Fight squad. The rack is full for the squad's mode, so Ready carries
    // all seven -- read against the armed mode it would be cut to five.
    const SEVEN = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley', 'buster', 'gas'];
    await t9rack(SEVEN);
    await t9state({ mode: 'boss', members: [T9YOU(), T9MULE({ ready: true })] });
    const a4c = await t9box(), a4cf = await t9ready();
    await t9rack(FIVE);
    if (a4c && a4c.ready && !a4c.ready.dis && a4cf.length === 1 && JSON.stringify(a4cf[0].loadout) === JSON.stringify(SEVEN)
        && (await ev('ccMode')) === 'duel')
      ok(`${V}: seven picks fill a Boss Fight squad's rack on a device armed on Duel, and Ready carries all seven`);
    else fail(`${V}: full seven-pick rack ${JSON.stringify({ ready: a4c && a4c.ready, sent: a4cf })}`);
    // AND GOLF ASKS FOR NO RACK (owner, 2026-10-06: golf menus show the bag,
    // never a weapon). One stored pick and a golf squad: the leader's Ready and
    // a member's each carry a full five, the stored pick first and then the
    // standard draft, because the server still checks a golf seat's rack --
    // and the stored preference is untouched, since golf drafts nothing.
    const GOLF5 = ['buster', 'mortar', 'cluster', 'napalm', 'airstrike'];
    await t9rack(['buster']);
    await t9state({ mode: 'golf', tees: 'mens', max: 2, members: [T9YOU(), T9MULE({ ready: true })] });
    const a4g = await t9box(), a4gf = await t9ready();
    await t9state({ leader: T9_MULE, mode: 'golf', tees: 'mens', max: 2, members: [T9YOU({ ready: false }), T9MULE({ ready: true })] });
    const a4gm = await t9box(), a4gr = await t9ready();
    const a4gStored = await ev(`localStorage.getItem('cc_loadout')`);
    await t9rack(FIVE);
    await ev(`(ccMode = 'duel', true)`);
    if (a4g && !a4g.rack && a4g.ready && !a4g.ready.dis && a4gf.length === 1 && JSON.stringify(a4gf[0].loadout) === JSON.stringify(GOLF5)
        && a4gm && !a4gm.rack && a4gm.ready && !a4gm.ready.dis && a4gr.length === 1 && a4gr[0].ready === true
        && JSON.stringify(a4gr[0].loadout) === JSON.stringify(GOLF5) && a4gStored === '["buster"]')
      ok(`${V}: a golf squad never asks for a rack: one stored pick still gives the leader and a member a Ready, each sending a full five, the stored pick untouched`);
    else fail(`${V}: golf rack ${JSON.stringify({ lead: a4g && { rack: a4g.rack, ready: a4g.ready }, sent: a4gf, member: a4gm && { rack: a4gm.rack, ready: a4gm.ready }, readied: a4gr, stored: a4gStored })}`);

    // ---- A5. THE MEMBER'S BOX (design 5.1 state 4): no Start, no Seats line,
    //      a cyan Ready toggle that carries its state as aria-pressed, Leave,
    //      and the sentence that names who decides. No Remove anywhere.
    //      CHANGED BY U3: the sentence said the leader "picks the mode and
    //      starts"; the leader picks the mode, and the last Ready starts it.
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: false }), T9MULE({ ready: true })] });
    const a5 = await t9box();
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const a5r = await t9box();
    if (a5 && a5.rows.length === 2 && !a5.start && a5.ready && a5.ready.cy && !a5.ready.dis && a5.ready.pressed === 'false' && a5.ready.t === 'Ready'
        && a5.leave && !a5.leave.dis && a5.leave.t === 'Leave'
        && !a5.rows[0].lead && a5.rows[1].lead && a5.seats.length === 0 && !a5.rows.some((r) => r.kick)
        && a5.note === 'Steel Mule picks the mode. The match starts when everyone is ready.'
        && a5.line === 'Duel · 2'
        && a5r && a5r.ready && a5r.ready.pressed === 'true' && a5r.ready.t === 'Ready' && !a5r.ready.dis)
      ok(`${V}: member forming -- no Start, a cyan Ready toggle with its state in aria-pressed, Leave, the leader named, no Remove`);
    else fail(`${V}: member forming ${JSON.stringify({ a5, a5r: a5r && a5r.ready })}`);
    await t9rack(['mortar']);
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: false }), T9MULE({ ready: true })] });
    const a5s = await t9box(), a5sf = await t9ready();
    await t9rack(FIVE);
    // CHANGED BY U3, as A4 (it was task 11's "Pick 4 more" door, D-UI-3): a
    // member one pick short readies with the four empty slots filled.
    if (a5s && a5s.ready && !a5s.ready.dis && !a5s.rack && a5s.leave && !a5s.leave.dis
        && a5sf.length === 1 && JSON.stringify(a5sf[0].loadout) === JSON.stringify(['mortar', 'cluster', 'napalm', 'airstrike', 'volley']))
      ok(`${V}: a member short of a full rack still has Ready, which fills the rack with standard weapons, and can leave`);
    else fail(`${V}: member short rack ${JSON.stringify(a5s && { ready: a5s.ready, rack: a5s.rack, leave: a5s.leave, sent: a5sf })}`);

    // ---- A6. A FRAME THAT NAMES NO LEADER MUST NOT CROWN EVERY GUEST. A
    //      guest's id is null by construction, so a bare `p.id === leader`
    //      against a null leader would crown all of them at once.
    await t9state({ leader: null, members: [T9YOU({ ready: true }), T9M({ guest: true }), T9M({ guest: true })] });
    const a6 = await t9box();
    if (a6 && a6.rows.length === 3 && a6.rows.filter((r) => r.lead).length === 0 && !a6.start
        && a6.note === 'The squad leader picks the mode. The match starts when everyone is ready.')
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
    // CHANGED BY U3: the leader's control here was Start; it is Ready.
    if (a9 && a9.rows.length === 2 && !a9.start && a9.ready && a9.ready.dis && a9.rows[1].kick && a9.rows[1].kick.dis)
      ok(`${V}: a roster that does not say held:true shows its rows with every squad control dead`);
    else fail(`${V}: held gate ${JSON.stringify(a9 && { ready: a9.ready, kick: a9.rows[1] && a9.rows[1].kick })}`);

    // ---- A10. THE ONE CODE FIELD UNDER A SQUAD (D-UI-2). It is the code
    //       column's second child in every squad state -- with a refused re-ask
    //       and without -- so what the player typed survives a roster push, the
    //       refusal and its Retry (morphChildren is positional). CHANGED BY U4:
    //       it was the Squad pane's seventh child, under the roster.
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
    if (a10 && a10.codeAt === 1 && kept1 === 'RM4P'
        && a10r && a10r.codeAt === 1 && kept2 === 'RM4P' && a10r.rerr === 'Squads are not available right now. Try again later.'
        && a10r.retry && !a10r.retry.dis && !a10r.foot && !a10r.add && a10r.rows.length === 0
        && a10r.summary.includes('QK7T') && a10r.codes === 1
        && a10b && a10b.codeAt === 1 && kept3 === 'RM4P' && a10b.rerr === '' && !a10b.retry && a10b.foot && a10b.rows.length === 2)
      ok(`${V}: the code field keeps what was typed across a roster push, a refused re-ask and its Retry; under the refusal the squad is shown read-only, with no controls`);
    else fail(`${V}: code field under a squad ${JSON.stringify({ a10: a10 && a10.codeAt, kept1, a10r: a10r && { at: a10r.codeAt, rerr: a10r.rerr, retry: a10r.retry, foot: a10r.foot, add: a10r.add, rows: a10r.rows.length, summary: a10r.summary }, kept2, a10b: a10b && { at: a10b.codeAt, rerr: a10b.rerr, retry: a10b.retry, foot: a10b.foot }, kept3 })}`);

    // ---- A11. READY STAYS IN VIEW. Four members overflow the pane, and the
    //       footer holding Ready (Start until U3) is pinned to its visible
    //       bottom rather than scrolled out of reach.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true }), T9PIKE({ ready: true }), T9M({ guest: true, ready: true })] });
    const a11 = await t9box();
    // U4: and the footer sits on the column's own bottom edge, with no strip
    // under it for the rows scrolling past to show through.
    if (a11 && a11.rows.length === 4 && !a11.add && a11.footIn === true && Math.abs(a11.footGap) < 1.5 && a11.ready && a11.inside && !a11.rows.some((r) => r.over))
      ok(`${V}: a full squad keeps the footer holding Ready inside the visible column, on its bottom edge`);
    else fail(`${V}: full squad ${JSON.stringify(a11 && { rows: a11.rows.length, add: a11.add, footIn: a11.footIn, footGap: a11.footGap, ready: a11.ready })}`);
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
    const b2t = await ev(`(() => { Bay.show('home'); const t = document.querySelector('#bay .sqx .sqb').innerText; Bay.show('squad'); return t; })()`);   // U4: the box's list
    if (b2f.length === 1 && b2f[0].op === 'leave' && typeof b2f[0].id === 'number' && b2 && b2.leave && b2.leave.t === 'Leaving' && b2.leave.dis
        && b2t.includes('You left the squad.') && (await ev('window.CC_SQUAD')) === null)
      ok(`${V}: Leave sends one frame, reads Leaving while it is out, and the answer leaves the player out of the squad`);
    else fail(`${V}: leave ${JSON.stringify({ b2f, leave: b2 && b2.leave, text: b2t })}`);
    // ---- B2b. THE LEADER LEAVES TOO (D-UI-3). The same frame, the same answer:
    //      the server hands the lead to the earliest signed-in member (squads.js
    //      detach; test/squad.mjs (h3)). While it is out Ready is dead as well.
    //      And the heir's box follows the roster that names them: a member told
    //      they now lead gets the leader's Seats line in place of who decides.
    //      CHANGED BY U3: the leader's footer had Start where a member's had
    //      Ready; every footer has Ready and Leave now. CHANGED BY THE UPDATE 8
    //      REVIEW: an heir left alone leads a squad of one, which has no Ready.
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await clearTx(); await t9click('#bay [data-sq="leave"]'); await sleep(60);
    const b2lf = await squads(), b2l = await t9box();
    await reply({ op: 'left', ok: true });
    const b2lt = await ev(`(() => { Bay.show('home'); const t = document.querySelector('#bay .sqx .sqb').innerText; Bay.show('squad'); return t; })()`);
    const b2lslot = await ev('window.CC_SQUAD');
    await t9state({ leader: T9_MULE, members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    const b2h0 = await t9box();
    await t9state({ leader: ME, members: [T9YOU({ ready: true })] });            // Steel Mule left: the lead is ours
    const b2h = await t9box();
    if (b2lf.length === 1 && b2lf[0].op === 'leave' && typeof b2lf[0].id === 'number' && Object.keys(b2lf[0]).sort().join() === 'id,op,type'
        && b2l && b2l.leave && b2l.leave.t === 'Leaving' && b2l.leave.dis && b2l.ready && b2l.ready.dis && !b2l.start
        && b2lt.includes('You left the squad.') && b2lslot === null
        && b2h0 && !b2h0.start && b2h0.ready && b2h0.seats.length === 0 && b2h0.note !== ''
        && b2h && !b2h.start && !b2h.ready && b2h.leave && !b2h.leave.dis && b2h.seats.length === 5 && b2h.note === '')
      ok(`${V}: the leader's Leave sends the one leave frame, holds Ready while it is out, and a member the roster names leader of a squad of one gets the Seats line and Leave`);
    else fail(`${V}: leader leave ${JSON.stringify({ b2lf, out: b2l && { leave: b2l.leave, ready: b2l.ready }, text: b2lt, slot: b2lslot, member: b2h0 && { start: b2h0.start, ready: b2h0.ready, note: b2h0.note }, heir: b2h && { start: b2h.start, leave: b2h.leave, ready: b2h.ready, seats: b2h.seats, note: b2h.note } })}`);

    // ---- B3. THE LEADER READIES, AND NOTHING EVER SENDS START. CHANGED BY U3
    //      (owner, 2026-10-06: "the leader does not need to initiate the game
    //      start"): this pinned the leader's Start -- one frame with the rack,
    //      Rolling out while it was out. The leader's Ready now sends the one
    //      ready frame with the rack, reads Sending while it is out, and the
    //      answer frees it; no frame of this client is ever a start.
    await t9state({ members: [T9YOU(), T9MULE({ ready: true })] });
    await clearTx(); await t9click('#bay [data-sq="ready"]'); await sleep(60);
    const b3f = await squads(), b3 = await t9box();
    await reply({ op: 'ready', ok: true });
    const b3d = await t9box();
    if (b3f.length === 1 && b3f[0].op === 'ready' && b3f[0].ready === true && JSON.stringify(b3f[0].loadout) === JSON.stringify(FIVE) && typeof b3f[0].id === 'number'
        && b3 && b3.ready && b3.ready.t === 'Sending' && b3.ready.dis && b3.rows.length === 2 && !b3.start
        && b3d && b3d.ready && !b3d.ready.dis && b3d.line === 'Duel · 2')
      ok(`${V}: the leader's Ready sends one ready frame with the rack, says Sending with the rows kept, and the answer frees the footer -- no Start anywhere`);
    else fail(`${V}: leader ready ${JSON.stringify({ b3f, out: b3 && { line: b3.line, ready: b3.ready, rows: b3.rows.length }, back: b3d && { line: b3d.line, ready: b3d.ready } })}`);

    // ---- B4. EVERY REFUSAL OF A START SAYS ITS OWN SENTENCE, blames no
    //      connection for a server-side cause, and names nobody the server did
    //      not point at. CHANGED BY U3: these were the answers to the leader's
    //      own Start, which this client no longer sends; the same refusals now
    //      reach EVERY member as a push (the countdown's end, or an old
    //      leader's Start the seating refused, R6), and each is said on the
    //      box's action line and on the ready control, with nothing sent. `at` names the roster row at fault on
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
      ['duplicate_member', 1, 'Steel Mule is in the squad twice. Remove one and try again.'],   // fix wave E9
      ['duplicate_member', undefined, 'One player is in the squad twice. Remove one and try again.'],
      ['slow_down', undefined, 'Too many tries. Wait a moment.'],
      ['unavailable', undefined, 'That match could not be started. Try again.'],
      ['a_code_from_a_newer_server', undefined, 'That match could not be started. Try again.'],
    ];
    const b4bad = [];
    for (const [code, at, line] of says) {
      await t9state({ members: [T9YOU(), T9MULE(), T9M({ id: NAMELESS, callsign: null })], mode: 'ffa', fits: t9fits(3) });
      await clearTx();
      await ev(`(handle(${JSON.stringify(at === undefined ? { type: 'squad', op: 'start', error: code } : { type: 'squad', op: 'start', error: code, at })}), true)`);
      await sleep(60);
      // CHANGED BY U4: the window is read for the action line and Ready, and
      // home for the box's own action line and the ribbon's.
      const bx = await t9box(), sent = (await tx()).length, hb = await t9home();
      const say = hb && hb.say;
      if (!(sent === 0 && bx && bx.aerr === line && hb.aerr === line && say === line && bx.ready && !bx.ready.dis)) b4bad.push({ code, at, sent, aerr: bx && bx.aerr, home: hb && hb.aerr, say, ready: bx && bx.ready });
    }
    await t9box();                                // back to the window, where the checks below press
    if (!b4bad.length) ok(`${V}: all ${says.length} start refusals pushed to the squad say their own sentence in the window, in the box and on the ready control, and send nothing`);
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
    //      Readies is pressed with its disabled attribute stripped, and none may
    //      reach the server: standing up in a squad the mode has no seats for,
    //      in a squad of one, beside a dropped member, on a roster this socket
    //      does not say it holds, and under a refused re-ask. The control run
    //      (B3) proves the same tap sends.
    //      CHANGED BY U3: these were the leader's Start gates (seats, readiness,
    //      a dropped member) and a short rack's; Start is gone, a short rack
    //      readies (A4), and so does the leader. What this client must never
    //      send is a start, pressed on a button the render never drew.
    const b6 = {};
    const gate = async (name, setup, sel) => { await setup(); await clearTx(); await t9force(sel); await sleep(50); b6[name] = (await squads()).length; };
    await gate('seats', () => t9state({ members: [T9YOU(), T9MULE({ ready: true }), T9PIKE({ ready: true })] }), '#bay [data-sq="ready"]');
    await gate('alone', () => t9state({ mode: 'boss', members: [T9YOU()] }), '#bay [data-sq="ready"]');
    await gate('dropped', () => t9state({ members: [T9YOU(), T9MULE({ ready: true, dropped: true })] }), '#bay [data-sq="ready"]');
    await gate('notHeld', async () => {
      await ev(`(handle({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)}, mode: 'duel', tees: null, max: null, you: 0,
        members: [${JSON.stringify(T9YOU())}, ${JSON.stringify(T9MULE({ ready: true }))}], fits: ${JSON.stringify(t9fits(2))} }), true)`);
      await sleep(60);
    }, '#bay [data-sq="ready"]');
    await gate('refused', async () => {
      await t9state({ members: [T9YOU(), T9MULE({ ready: true })] });
      await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
      await reply({ error: 'unavailable' });
    }, '#bay [data-sq="ready"]');
    await clearTx(); await t9click('#bay [data-sq="retry"]'); await sleep(60);
    await reply({ op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true,
      members: [T9YOU({ ready: true }), T9MULE({ ready: true })], fits: t9fits(2) });
    // A Start, a leader's or a member's, and a Leave on a roster this socket
    // does not say it holds: buttons the render never draws, pressed through
    // the real listener.
    const pressed = async (name, setup, v) => {
      await setup(); await clearTx();
      await ev(`(() => { const b = document.createElement('button'); b.setAttribute('data-sq', ${JSON.stringify(v)});
        document.getElementById('sqWin-squad').appendChild(b); b.click(); b.remove(); return true; })()`);
      await sleep(50); b6[name] = (await squads()).length;
    };
    await pressed('leaderStart', () => t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] }), 'start');
    await pressed('memberStart', () => t9state({ leader: T9_MULE, members: [T9YOU({ ready: true }), T9MULE({ ready: true })] }), 'start');
    await pressed('leaveNotHeld', async () => {
      await ev(`(handle({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(T9_MULE)}, mode: 'duel', tees: null, max: null, you: 0,
        members: [${JSON.stringify(T9YOU({ ready: true }))}, ${JSON.stringify(T9MULE({ ready: true }))}], fits: ${JSON.stringify(t9fits(2))} }), true)`);
      await sleep(60);
    }, 'leave');
    if (Object.keys(b6).length === 8 && Object.values(b6).every((n) => n === 0))
      ok(`${V}: Ready and Leave pressed past a dead attribute send nothing -- seats, a squad of one, a dropped member, an unheld roster, a refused re-ask -- and a Start pressed by anyone sends nothing at all`);
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
    // ---- B7b. SHARE (U4; owner, 2026-10-06: the squad code with Copy and
    //       Share). Offered only where the device has a share sheet, as the
    //       Friends screen's is, and it shares the same link, with the code in
    //       words. A squad with no code to share offers it dead. Nothing is sent.
    await ev(`(window.__shareHad = Object.getOwnPropertyDescriptor(navigator, 'share'), Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }), true)`);
    const b7none = await ev(`(Bay.show('squad'), document.dispatchEvent(new Event('cc:social')), !!document.querySelector('#bay [data-sq="share"]'))`);
    await ev(`(window.__shared = null, Object.defineProperty(navigator, 'share', { value: (o) => { window.__shared = o; return Promise.resolve(); }, configurable: true }), document.dispatchEvent(new Event('cc:social')), true)`);
    await sleep(40);
    const b7live = await ev(`(() => { const b = document.querySelector('#bay [data-sq="share"]'); return b ? !b.disabled : null; })()`);
    await clearTx(); await t9click('#bay [data-sq="share"]'); await sleep(60);
    const shared = await ev('window.__shared'), b7sf = await squads();
    await ev(`(() => { const d = window.__shareHad; if (d) Object.defineProperty(navigator, 'share', d); else delete navigator.share; document.dispatchEvent(new Event('cc:social')); return true; })()`);
    if (b7none === false && b7live === true && shared && shared.url === `http://127.0.0.1:${appPort}/?squad=QK7T`
        && shared.text === 'Join my squad in Cannons and Canyons. Squad code QK7T.' && b7sf.length === 0)
      ok(`${V}: Share is offered only with a share sheet, and shares /?squad=QK7T with the code in words, sending nothing`);
    else fail(`${V}: share ${JSON.stringify({ none: b7none, live: b7live, shared, sent: b7f })}`);
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
    // Out of the squad (a push the server sends a leaver's other tabs): the
    // window is in a no-squad state, with the code field.
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), Bay.show('squad'), true)`); await sleep(60);
    await ev(`(document.getElementById('sqCode').value = 'ZX9K', true)`);
    const c1at = await ev(`[...document.getElementById('sqWin-code').children].findIndex((c) => c.id === 'sqCode' || (c.querySelector && c.querySelector('#sqCode')))`);
    const c1t = await ev('Date.now()');
    await invite();
    const c1 = await t9box();
    const c1slot = await ev('JSON.stringify(window.CC_SQUAD_INVITE)');
    const c1kept = await ev(`document.getElementById('sqCode').value`);
    const c1at2 = await ev(`[...document.getElementById('sqWin-code').children].findIndex((c) => c.id === 'sqCode' || (c.querySelector && c.querySelector('#sqCode')))`);
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
    const c3new = await t9box(), c3newH = await t9home();
    await ev(`(window.CC_SQUAD_INVITE.at = Date.now() - 599000, document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60);
    const c3old = await t9box();
    await ev(`(window.CC_SQUAD_INVITE.at = Date.now() + 60000, document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60);
    const c3ahead = await t9box();                // the clock set back since: an age that cannot be told is not offered
    await ev(`(window.CC_SQUAD_INVITE.at = Date.now() - 600001, document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60);
    const c3gone = await t9box(), c3goneH = await t9home();
    await clearTx(); await t9press('join:RM7P', 'sqBox'); await sleep(50);
    const c3sent = await squads();
    if (c3sent.length) await reply({ op: 'join', error: 'full' });
    await ev(`(window.CC_SQUAD_INVITE.at = Date.now(), document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60);
    const c3back = await t9box();
    await ev(`(() => { const t = window.__t9timers.find((x) => x.ms >= 600000 && x.ms <= 601000); if (t) t.f(); return true; })()`); await sleep(60);
    const c3slot = await ev('window.CC_SQUAD_INVITE'), c3fired = await t9box(), c3firedH = await t9home();
    // A timer takes ITS OWN invite and nothing newer: a second invite has
    // arrived by the time the first one's ten minutes are up.
    await t9timers(() => invite({ code: 'RM7Q', from: { callsign: 'Ridge Pike' } }));
    await invite({ code: 'RM7R', from: { callsign: 'Steel Mule' } });
    await ev(`(() => { const t = window.__t9timers.find((x) => x.ms >= 600000 && x.ms <= 601000); if (t) t.f(); return true; })()`); await sleep(60);
    const c3kept = await ev('window.CC_SQUAD_INVITE && window.CC_SQUAD_INVITE.code'), c3keptRow = await t9box();
    // CHANGED BY U4: "lights nothing" was the Squad tab's dot; the tabs are
    // gone, and the invite is shown on home itself -- the box's row -- which
    // is read beside the window's.
    if (c3timer === 1 && c3new && c3new.inv && c3newH && c3newH.inv && c3old && c3old.inv && c3ahead && !c3ahead.inv && c3gone && !c3gone.inv && c3goneH && !c3goneH.inv && c3sent.length === 0
        && c3back && c3back.inv && c3slot === null && c3fired && !c3fired.inv && c3firedH && !c3firedH.inv
        && c3kept === 'RM7R' && c3keptRow && c3keptRow.inv && c3keptRow.inv.t.indexOf('Steel Mule') === 0)
      ok(`${V}: an invite older than ten minutes is not shown, on home or in the window, and joins nothing, and the timer set on arrival empties the slot of that invite and no newer one`);
    else fail(`${V}: invite lifetime ${JSON.stringify({ timer: c3timer, fresh: c3new && [!!c3new.inv, !!(c3newH && c3newH.inv)], old: c3old && !!c3old.inv, ahead: c3ahead && !!c3ahead.inv, gone: c3gone && [!!c3gone.inv, !!(c3goneH && c3goneH.inv)], sent: c3sent, back: c3back && !!c3back.inv, slot: c3slot, fired: c3fired && [!!c3fired.inv, !!(c3firedH && c3firedH.inv)], kept: c3kept })}`);

    // ---- C3c. A PENDING INVITE STAYS ON HOME (U4; D-UI-4, review T9-R1-6). An
    //      invite lasts ten minutes, so its row is not only behind Manage: the
    //      box draws it at the top of its list, in a status region a screen
    //      reader hears it arrive in, with Join and Ignore. Join pressed ON
    //      HOME sends the window's join frame, word for word; Ignore pressed on
    //      home hides it and sends nothing. No connection draws no row.
    //      REPLACES the Squad tab's dot and label: the tabs are gone, and the
    //      row itself is on home.
    await invite({ code: 'RM8Q', from: { callsign: 'Steel Mule' }, size: 2 });
    const c3h = await t9home();
    await clearTx(); await t9click('#bay .sqx [data-sq^="join:"]'); await sleep(40);
    const c3hj = await squads(), c3hName = await ev('myName()'), c3hSkin = await ev('mySkin()');
    await reply({ op: 'join', error: 'full' });
    const c3e = await t9box();
    await up(false);
    const c3off = await t9home();                 // no connection: the box draws no row
    await up(true);
    await t9home();                               // repainted with the connection back
    await clearTx(); await t9click('#bay .sqx [data-sq^="ignore:"]'); await sleep(40);
    const c3i = await t9home(), c3is = await squads(), c3iw = await t9box();
    if (c3h && c3h.inv && c3h.inv.t === 'Steel Mule invites you to their squad \u00b7 2 / 4' && c3h.inv.join && c3h.inv.ign && c3h.invRole === 'status'
        && c3hj.length === 1 && c3hj[0].op === 'join' && c3hj[0].code === 'RM8Q' && c3hj[0].name === c3hName && c3hj[0].skin === c3hSkin
        && c3e && c3e.inv && c3e.inv.err === 'That squad is full.' && c3e.invRole === 'status' && c3e.invLive
        && c3off && !c3off.inv && c3off.invRole === 'status'
        && c3i && !c3i.inv && c3i.invRole === 'status' && c3is.length === 0 && c3iw && !c3iw.inv)
      ok(`${V}: a pending invite sits on home in a status region with Join and Ignore; Join there sends the join frame, Ignore there hides it and sends nothing`);
    else fail(`${V}: invite on home ${JSON.stringify({ home: c3h, join: c3hj, win: c3e && [c3e.inv, c3e.invRole, c3e.invLive], offline: c3off && c3off.inv, ignored: c3i && c3i.inv, sent: c3is })}`);

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
    const joinSays = [['no_such_squad', 'No squad with that code.'], ['full', 'That squad is full.'],   // U4: squad codes only
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
    // Another action out (the leader's Ready -- the leader's Start until U3):
    // Join waits for it (review T9-R1-8, N14) -- the box has one action at a
    // time.
    await clearTx(); await t9click('#bay [data-sq="ready"]'); await sleep(40);
    const c7busy = await t9box();
    await reply({ op: 'ready', error: 'unavailable' });
    await clearTx(); await t9click('#bay [data-sq^="join:"]'); await sleep(40);
    const c7f = await squads();
    await reply({ op: 'join', error: 'full' });
    await invite({ code: 'QK7T' });
    const c7b = await t9box();
    if (c7a && c7a.inv && c7a.inv.t.indexOf('Ridge Pike') === 0 && c7a.rows.length === 2 && c7f.length === 1 && c7f[0].code === 'RM8P'
        && c7b && !c7b.inv && c7busy && c7busy.ready && c7busy.ready.t === 'Sending' && c7busy.inv && c7busy.inv.join && c7busy.inv.join.dis)
      ok(`${V}: an invite while in another squad sits above it and joins the new one, and waits while another action is out; an invite to your own squad is not shown`);
    else fail(`${V}: invite over a squad ${JSON.stringify({ a: c7a && { inv: c7a.inv, rows: c7a.rows.length }, busy: c7busy && { ready: c7busy.ready, inv: c7busy.inv }, sent: c7f, b: c7b && c7b.inv })}`);

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
    if (c8g && c8g.rows.length === 2 && !c8g.inv && c8gs === null && c8os === null)
      ok(`${V}: an invite that lands on a page with no linked account -- a guest in a squad, or signed out -- is dropped`);
    else fail(`${V}: invite after a sign-out ${JSON.stringify({ guest: c8g && { rows: c8g.rows.length, inv: c8g.inv }, guestSlot: c8gs, outSlot: c8os })}`);
    // (C8 signed the account out and back in: introduce it and answer, so the
    //  box knows again.)
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    // A button the render did not draw, pressed through the real listener: the
    // way to prove a handler refuses what a stale or forged DOM asks of it.
    const t9inject = (sq9) => ev(`(() => { const f = document.getElementById('sqWin-squad'); const b = document.createElement('button');
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
        && d1c && !d1c.kok && d1c.ready && d1c.line === 'Duel · 2' && d1cf.length === 0)   // Ready: Start until U3
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
        && d2d && d2d.rows.length === 1 && !d2d.kok && !d2d.ready && d2d.aerr === '')   // alone now: no Ready (update 8 review)
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
    if (d4x && !d4x.kok && d4x.ready && d4xf.length === 0 && d4xc && d4xc.aerr === 'The squad changed. Check the list and try again.')   // Ready: Start until U3
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
        && d4e && !d4e.kok && d4e.ready && d4ef.length === 0)   // Ready: Start until U3
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
      if (!(bx && bx.aerr === line && !bx.kok && bx.ready)) d5bad.push({ code, aerr: bx && bx.aerr, kok: bx && bx.kok });   // Ready: Start until U3
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
    //      CHANGED BY U4: the rows are the Manage squad window's friends column
    //      (#sqWin-friends), and every friend is listed ONLINE FIRST (owner,
    //      2026-10-06), the server's order kept within each half -- so a row is
    //      found by its name below, never by the server's position.
    const T9_NIA = '00000000-0000-4000-8000-000000000011', T9_GHOST = '00000000-0000-4000-8000-000000000012';
    const FR9 = { friends: [{ id: T9_MULE, callsign: 'Steel Mule', online: true }, { id: T9_PIKE, callsign: 'Ridge Pike', online: false },
      { id: T9_GHOST, callsign: null, online: true }], requests: { in: [{ id: T9_NIA, callsign: 'Nia Vale' }], out: [] },
      blocked: [], friendCode: 'AB12CD', callsign: null };
    const t9fr = () => ev(`(() => {
      Bay.show('squad');
      const p = document.getElementById('sqWin-friends'); if (!p) return null;
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
    // DUEL ARMED, the board a new squad starts on, so an Invite's create sends
    // no mode before its invite (E2). Since U4 these checks read the window,
    // which never re-arms the boards, so a leader's one follow after a resume
    // (sqFollow) waits for the first home render -- B4's, on a free-for-all.
    await ev(`(ccMode = 'duel', true)`);
    await friendsIn(FR9);

    // ---- E1. THE ROWS. Task 8's count lines stay above them; every name is
    //      esc()'d; a nameless friend keeps a row with the placeholder mark; the
    //      Decline is drawn; nothing overflows the column. CHANGED BY U4: the
    //      two online friends come first (Steel Mule, then the nameless one),
    //      and Ridge Pike, offline, last -- with Invite all the same: an
    //      offline friend's invite goes by push.
    const e1 = await t9fr();
    const R = (list, i) => (list && list[i]) || {};
    const PIKE = (f) => R(f && f.fr, (f && f.fr ? f.fr.findIndex((r) => r.name === 'Ridge Pike') : -1));
    if (e1 && e1.text.startsWith('Your friends · 3 2 online now. 1 request waiting for an answer.') && e1.add
        && JSON.stringify(e1.heads) === JSON.stringify(['Requests · 1', 'Friends · 3'])
        && e1.req.length === 1 && R(e1.req, 0).name === 'Nia Vale' && R(e1.req, 0).acc && !R(e1.req, 0).acc.dis
        && R(e1.req, 0).dec && !R(e1.req, 0).dec.dis && R(e1.req, 0).dec.label === 'Decline Nia Vale' && R(e1.req, 0).decSvg && R(e1.req, 0).menu
        && e1.fr.length === 3
        && R(e1.fr, 0).name === 'Steel Mule' && R(e1.fr, 0).lit && R(e1.fr, 0).inv && R(e1.fr, 0).inv.t === 'Invite' && !R(e1.fr, 0).inv.dis && R(e1.fr, 0).menu
        && R(e1.fr, 1).name === 'No callsign' && R(e1.fr, 1).lit && R(e1.fr, 1).anon && R(e1.fr, 1).inv
        && R(e1.fr, 2).name === 'Ridge Pike' && !R(e1.fr, 2).lit && R(e1.fr, 2).dot && R(e1.fr, 2).inv && !R(e1.fr, 2).inv.dis
        && !e1.req.concat(e1.fr).some((r) => r.over) && e1.why === '' && !e1.fr.some((r) => r.desc))
      ok(`${V}: the window lists the request with Accept and a drawn Decline, and each friend, online first, with a lamp, Invite and the menu, under the counts`);
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
    const e3raw = await ev(`(() => { const b = document.querySelector('#sqWin-friends [data-sq="invite:${T9_MULE}"]'); return b ? { t: b.textContent.trim(), dis: b.disabled } : null; })()`);
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
      const f = await t9fr(), row = PIKE(f);
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
      e8[name] = { dis: !!(PIKE(f).inv && PIKE(f).inv.dis), title: PIKE(f).inv && PIKE(f).inv.title, sent: (await squads()).length,
        why: f && f.why, desc: PIKE(f).desc };
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
      looked: 'Your squad is open on another device.', refused: 'Your squad could not be checked. Tap Retry to check again.' };   // U4: there is no Squad tab
    if (Object.values(e8).every((x) => x.dis && x.sent === 0) && e8.full.title === 'Your squad is full.'
        && Object.keys(E8WHY).every((k) => e8[k] && e8[k].why === E8WHY[k] && e8[k].desc === 'sqInvWhy'))
      ok(`${V}: Invite is dead, handler and all, for a full squad, an unheld roster, a squad changed or open elsewhere, a refused re-ask and an unanswered box, and a line above the rows says why`);
    else fail(`${V}: invite gates ${JSON.stringify(e8)}`);

    // ---- E9. ACCEPT AND DECLINE, from the window. Each sends its friend frame; a
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
    await t9press(`accept:${T9_NIA}`, 'sqWin-friends'); await t9press(`decline:${T9_NIA}`, 'sqWin-friends'); await t9press(`invite:${T9_MULE}`, 'sqWin-friends');
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
    const e10copy = await ev(`(() => { const b = document.querySelector('#sqWin-friends [data-fr="copy"]'); return b ? !b.disabled : null; })()`);
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
    // F4. A COUNTDOWN THAT ENDED IN A REFUSAL after the engine's create had
    //     seated this player (U3: the server tells every member, R6's frame):
    //     the same question, and the player lands back on the box with the
    //     refusal said in it, and on the ready control, free to ready again.
    //     CHANGED BY U3: this was the leader's own refused Start, answered by
    //     id; this client sends no Start, and the refusal is a push.
    await t9state({ members: [T9YOU(), T9MULE()] });
    await lobbyAt('RM6Q');
    await clearTx(); await ev(`(handle({ type: 'squad', op: 'start', error: 'refused' }), true)`); await sleep(60);
    const f4q = await kinds();
    const probe = f4q.find((f) => f.type === 'code');
    await answer(probe && probe.id, { type: 'code', kind: 'none' });
    const f4e = await scr(), f4 = await t9box();
    const f4say = (await t9home() || {}).say || null;   // U4: the window has no ribbon; home's is read
    await t9box();
    if (probe && probe.code === 'RM6Q' && f4e === 'home' && f4 && f4.aerr === 'That match could not be started. Try again.'
        && f4say === 'That match could not be started. Try again.' && f4.ready && !f4.ready.dis)
      ok(`${V}: a countdown refused after the room was built leaves the dead lobby too, and the box and the ready control say why`);
    else fail(`${V}: leader dead lobby ${JSON.stringify({ asked: f4q, scr: f4e, aerr: f4 && f4.aerr, say: f4say })}`);

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
    // CHANGED BY U4: the window's two columns, and the home box, which draws
    // the members' names too.
    const imgs = () => ev(`document.querySelectorAll('#sqWin-squad img, #sqWin-friends img, #bay .sqx img').length`);
    const g = {};
    await t9state({ members: [T9YOU({ ready: true }), T9PIKE({ callsign: EVIL, ready: true })] });
    await ev(`(handle({ type: 'squad', op: 'start', error: 'member_offline', at: 1 }), true)`); await sleep(60);   // a push since U3
    g.say = [(await t9box()).aerr === EVIL + " isn't ready to start yet.", await imgs()];
    await t9click(`#bay [data-sq="kick:${RID_PIKE}"]`); await sleep(40);
    g.ask = [(await t9box()).line === 'Remove ' + EVIL + ' from the squad?', await imgs()];
    await t9click('#bay [data-sq="kcancel"]'); await sleep(40);
    await t9state({ leader: T9_PIKE, members: [T9YOU({ ready: true }), T9PIKE({ callsign: EVIL, ready: true })] });
    g.lead = [(await t9box()).note === EVIL + ' picks the mode. The match starts when everyone is ready.', await imgs()];
    g.home = [((await t9home()) || { rows: [] }).rows.some((r) => r.name === EVIL), await imgs()];
    await friendsIn({ friends: [{ id: T9_MULE, callsign: EVIL, online: false }], requests: { in: [{ id: T9_NIA, callsign: EVIL }], out: [] },
      blocked: [], friendCode: 'AB12CD', callsign: null });
    await t9fr();
    await clearTx(); await t9click(`#bay [data-sq="invite:${T9_MULE}"]`); await sleep(40);
    await reply({ op: 'invite', ok: true, delivered: 'online' });
    const gf = await t9fr();
    g.rows = [R(gf && gf.fr, 0).name === EVIL && R(gf && gf.req, 0).name === EVIL, await imgs()];
    g.note = [!!(R(gf && gf.fr, 0).line && R(gf.fr, 0).line.t === 'Invite sent to ' + EVIL + '.'), await imgs()];
    await friendsIn(FR9);
    if (Object.values(g).every(([same, n]) => same === true && n === 0))
      ok(`${V}: a name carrying markup reads back as text in a start refusal, the Remove question, the leader sentence, the home box, the friend and request rows and the invite note`);
    else fail(`${V}: names reaching markup ${JSON.stringify(g)}`);

    // ---- H. READABLE WORDS AND TAPPABLE CONTROLS (review T9-R1-10 and 11).
    //      Leader, Not ready, Reconnecting and In your squad are at least 13u
    //      (CHANGED BY U4, owner 2026-10-06: "all text easily legible"; the
    //      floor was 7.5u, the brief's size, and they were 6.5u before that).
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
    const hSq = { hits: await t9hit('.sqm .pmb, .sqm .sqic', 'sqWin-squad'), sql: await t9font('#sqWin-squad .sql'), sqr: await t9font('#sqWin-squad .sqr:not(.on)') };
    await friendsIn({ ...FR9, friends: [{ id: T9_MULE, callsign: 'Steel Mule', online: true }, { id: T9_PIKE, callsign: 'Ridge Pike', online: false }] });
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await t9fr();
    const hFr = { hits: await t9hit('.sqm .pmb, .sqm .sqic', 'sqWin-friends'), sqy: await t9font('#sqWin-friends .sqy') };
    const hRows = await t9fr();
    await friendsIn(FR9);
    const fontsOk = [...hSq.sql, ...hSq.sqr, ...hFr.sqy];
    if (hSq.sql.length === 1 && hSq.sqr.length === 2 && hFr.sqy.length === 1 && fontsOk.every((f) => f >= 13)
        && hSq.hits.length === 4 && hFr.hits.length === 4 && hSq.hits.concat(hFr.hits).every((x) => x.w >= 24 && x.h >= 24 && x.miss === 0 && x.prevKept !== false)
        && hFr.hits.filter((x) => x.v.startsWith('decline:')).length === 1 && hFr.hits.find((x) => x.v.startsWith('decline:')).prevKept === true
        && hFr.hits.find((x) => x.v.startsWith('decline:')).dead === true
        && hRows && !hRows.req.concat(hRows.fr).some((r) => r.over))
      ok(`${V}: the squad's status words are at least 13u, and Remove, Decline and every member menu take a tap across about 24 px without overlapping each other or Accept`);
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
    iN.lead = await t9names('sqWin-squad'); iW.lead = await t9words('sqWin-squad');
    await t9state({ leader: T9_PIKE, mode: 'ffa', members: [T9YOU({ ready: false }), T9PIKE({ ready: true, dropped: true }), T9MULE({ ready: false })] });
    await t9box();
    iN.member = await t9names('sqWin-squad'); iW.member = await t9words('sqWin-squad');
    const iMenuSq = await t9menuTap('sqWin-squad');
    await friendsIn({ ...FR9, friends: [{ id: T9_MULE, callsign: 'Steel Mule', online: true }, { id: T9_PIKE, callsign: 'Ridge Pike', online: false }] });
    await t9state({ members: [T9YOU({ ready: true }), T9MULE({ ready: true })] });
    await t9fr();
    iN.friends = await t9names('sqWin-friends'); iW.friends = await t9words('sqWin-friends');
    const iMenuFr = await t9menuTap('sqWin-friends');
    const iShut = await ev(`(() => { const m = document.getElementById('pmenu'); return !(m && !m.hidden); })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await friendsIn(FR9);
    const iNamed = (rows, names, words) => Array.isArray(rows) && JSON.stringify(rows.map((r) => r.name)) === JSON.stringify(names)
      && JSON.stringify(rows.map((r) => r.words)) === JSON.stringify(words) && rows.every((r) => !r.cut && r.under && r.foot);
    // The leader's row: Leader and its tick (U3; fix wave E9 had taken the tick
    // off). The member view's check sat behind that comment on this line, and
    // so was never asked: it is a condition again.
    if (iNamed(iN.lead, ['Dusty Crag', 'Steel Mule', 'Ridge Pike'], [2, 1, 1]) && iNamed(iN.member, ['Dusty Crag', 'Ridge Pike', 'Steel Mule'], [1, 2, 1])
        && iNamed(iN.friends, ['Nia Vale', 'Steel Mule', 'Ridge Pike'], [0, 1, 0]))
      ok(`${V}: every fixture name reads in full on a line of its own, the status words beneath it and no control's target reaching into it -- a reconnecting member, a reconnecting leader, a request, a squadmate and a friend to invite`);
    else fail(`${V}: two-line rows, names ${JSON.stringify(iN)}`);
    const iAll = [].concat(iW.lead, iW.member, iW.friends);
    if (iW.lead.length === 4 && iW.member.length === 4 && iW.friends.length === 1   // the leader's tick is a status word again (U3)
        && iAll.every((w) => w.clear && w.hit.length === 0 && !w.open && !w.ask && w.sent === 0) && iMenuSq === true && iMenuFr === true && iShut)
      ok(`${V}: a tap anywhere on Leader, Ready, Not ready, Reconnecting or In your squad opens no menu and asks nothing, and a tap on a menu opens it`);
    else fail(`${V}: a tap on the status words ${JSON.stringify({ iW, iMenuSq, iMenuFr, iShut })}`);
  }
} catch (e) {
  fail('squad_ui task 9 stopped: ' + (e && e.message));
}

// ============================================================================
// TASK 11: THE BOARDS DIM FROM THE SQUAD'S `fits`, the leader's boards are the
// squad's mode control (D7), the Armoury fills the squad's rack (D-UI-3), the
// one code field (X8: #sqCode, task 8's) gets its busy guard and says a room's
// refusal, and the join screen goes. Its own viewport loop on a freshly loaded
// page, so it shares no state with the checks above. Every roster goes in
// through app.js's real handle() -- the real CC_SQUAD write and the real
// cc:squad repaint -- with `held: true`, as every roster this server puts in
// the slot carries it (D-UI-1). Every control is pressed through the real
// delegated listener. Frames are filtered by TYPE, never counted whole: a
// sign-in also starts a friends read that lands in the same recorder.
if (want('t11')) try {
  const T11_MULE = '00000000-0000-4000-8000-0000000000cc';
  const T11_PIKE = '00000000-0000-4000-8000-0000000000dd';
  const T11R = (tag) => (tag + '0'.repeat(32)).slice(0, 32);
  const t11m = (id, callsign, rid, o) => Object.assign({ id, rid: T11R(rid), callsign, guest: false, online: true, ready: false, dropped: false }, o);
  const T11YOU = (o) => t11m(ME, 'Dusty Crag', 'a1', o);
  const T11MULE = (o) => t11m(T11_MULE, 'Steel Mule', 'c1', o);
  const T11PIKE = (o) => t11m(T11_PIKE, 'Ridge Pike', 'd1', o);
  // THE SERVER'S SEAT TABLE, for fixtures only (duel 2, ffa 2-4, boss 1-2,
  // aliens 1-2, golf 1-4). The client never computes this: it reads `fits`,
  // and check B2c hands it a `fits` this table would not produce to prove it.
  const t11fits = (n) => ({ duel: n === 2, ffa: n >= 2 && n <= 4, boss: n >= 1 && n <= 2, aliens: n >= 1 && n <= 2, golf: n >= 1 && n <= 4 });
  // A roster PUSH, exactly as the server fans one out: no request id.
  const t11state = async (patch) => {
    const n = (patch.members || []).length;
    await ev(`(handle(Object.assign({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)},
      mode: 'duel', tees: null, max: null, you: 0, held: true, members: [], fits: ${JSON.stringify(t11fits(n))} }, ${JSON.stringify(patch)})), true)`);
    await sleep(80);
  };
  const t11rack = (picks) => ev(`(localStorage.setItem('cc_loadout', ${JSON.stringify(JSON.stringify(picks))}), true)`);
  const FIVE11 = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
  // The home boards and the Mission board cards, as a player sees them.
  const t11boards = (sel) => ev(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(sel)})];
    return { cls: b.map((x) => x.className), nofit: b.map((x) => x.classList.contains('nofit')),
      pills: b.map((x) => { const p = x.querySelector('.bnf'); return p ? p.textContent : null; }),
      bof: b.map((x) => !!x.querySelector('.bof')) };
  })()`);

  // How long the leader's coalesced mode send waits after the last tap
  // (bay.js SQ_MODE_MS, 250 ms), with room to spare.
  const MODE_WAIT0 = 450;
  for (const [w, h] of [[932, 430], [667, 375]]) {
    const V = `${w}x${h}`;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    let t11up = false;
    for (let i = 0; i < 80; i++) {
      if (await ev('!!window.Bay && typeof handle === "function" && !!document.querySelector("#bay .boards")').catch(() => false)) { t11up = true; break; }
      await sleep(200);
    }
    if (!t11up) { fail(`${V}: page never became ready for the task 11 checks`); continue; }
    for (let k = 0; k < 40 && (await ev(`document.getElementById('bay').classList.contains('enter')`)); k++) await sleep(100);
    await ev(`(localStorage.removeItem('cc_squad'), true)`);
    await t11rack(FIVE11);
    // S.connected and S.local are set by stubSocket, so wsReady() does not
    // depend on whether the real socket had opened first; the account button's
    // state is set by setWho, which is what acctState() reads.
    await stubSocket(); await setWho('in');
    await ev(`(ccMode = 'duel', ccMax = 4, ccTees = 'mens', true)`);
    // Introduced, then answered: this account holds no squad. The box KNOWS.
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    await clearTx();
    await ev(`(Bay.show('home'), true)`);

    // ---- B1. NO SQUAD, NO CHANGE. Every player who never squads up must get
    //      the board that shipped -- so this reads every board's whole class
    //      list, not a flag -- and still no offline badge on home (owner,
    //      2026-09-18; test/offline.mjs asserts the same).
    const b1 = await t11boards('#bay .board');
    if (JSON.stringify(b1.cls) === JSON.stringify(['board on', 'board', 'board', 'board', 'board'])
        && b1.pills.every((p) => p === null) && b1.bof.every((x) => !x))
      ok(`${V}: no squad -- the five home boards are exactly as they shipped, no pill and still no offline badge`);
    else fail(`${V}: plain boards ${JSON.stringify(b1)}`);

    // ---- B2. `fits` FROM THE SERVER DIMS EXACTLY THE MODES IT NAMES. Three
    //      strong: duel (2), boss (1-2) and aliens (1-2) cannot seat them.
    await t11state({ leader: T11_MULE, members: [T11YOU(), T11MULE(), T11PIKE()] });
    const b2 = await t11boards('#bay .board');
    if (JSON.stringify(b2.nofit) === JSON.stringify([true, false, true, true, false])
        && JSON.stringify(b2.pills) === JSON.stringify(['Squad too big', null, 'Squad too big', 'Squad too big', null]))
      ok(`${V}: a squad of three dims duel, boss and aliens with "Squad too big"; free-for-all and golf are untouched`);
    else fail(`${V}: too big ${JSON.stringify(b2)}`);
    // B2b. SQUAD 1/4 IS NO SQUAD (owner, update 8: "a squad of one behaves as
    //      no squad"). CHANGED: since 7302835 a squad of one -- whose `fits`
    //      says no duel and no free-for-all, X6 checking the minimum -- dimmed
    //      Duel and Free-for-all "Needs 2 players" while the ribbon's ordinary
    //      Launch played Duel vs the computer. Now every board is live: the
    //      class lists exactly as with no squad (B1), no pill, no grey, the
    //      box saying 1/4 and the ribbon the ordinary Launch.
    await t11state({ members: [T11YOU()] });
    const b2b = await t11boards('#bay .board');
    await sleep(400);                              // B2's grey has eased off (.22s), as B3 measures it
    const b2bLook = await ev(`(() => ({ grey: [...document.querySelectorAll('#bay .board .bcard img')].map((i) => /grayscale/.test(getComputedStyle(i).filter)),
      count: (document.querySelector('#bay .sqx .sqhc [aria-hidden]') || {}).textContent,
      launch: (() => { const l = document.querySelector('#bay .lbar .launch'); return l ? [l.textContent.trim(), l.getAttribute('data-go'), l.classList.contains('rdy')] : null; })() }))()`);
    if (JSON.stringify(b2b.cls) === JSON.stringify(['board on', 'board', 'board', 'board', 'board']) && b2b.pills.every((p) => p === null)
        && b2bLook.grey.length === 5 && b2bLook.grey.every((g) => !g) && b2bLook.count === '1/4'
        && JSON.stringify(b2bLook.launch) === JSON.stringify(['Launch', 'setup', false]))
      ok(`${V}: Squad 1/4 is no squad -- every board live, no pill and no grey on Duel or Free-for-all, and the ribbon the ordinary Launch`);
    else fail(`${V}: squad of one ${JSON.stringify({ b2b, b2bLook })}`);
    // B2c. THE BOARDS READ `fits`, THEY DO NOT COUNT. Two members, which the
    //      seat table says fit everything, and a frame that says duel does
    //      not: the frame wins, because it is the one truth Start reads too.
    await t11state({ leader: T11_MULE, members: [T11YOU(), T11MULE()], fits: { duel: false, ffa: true, boss: true, aliens: true, golf: true } });
    const b2c = await t11boards('#bay .board');
    if (JSON.stringify(b2c.nofit) === JSON.stringify([true, false, false, false, false]) && b2c.pills[0] === 'Squad too big' && b2c.pills.slice(1).every((p) => p === null))
      ok(`${V}: the boards follow the frame's fits, not a count of the rows`);
    else fail(`${V}: fits not read ${JSON.stringify(b2c)}`);
    // B2d. SQUAD 2/4 IN BOSS: TWO OR MORE GET THE PILLS AS BEFORE (B2b stops
    //      only a squad of one). Steel Mule leads on Boss Fight and this page
    //      follows. The server's own `fits` for two seats every mode, so no
    //      board dims; and a frame whose `fits` says no to Duel and
    //      Free-for-all dims exactly those two, "Squad too big", with Boss
    //      Fight lit and untouched.
    await t11state({ leader: T11_MULE, mode: 'boss', members: [T11YOU(), T11MULE()] });
    const b2d = await t11boards('#bay .board');
    const b2dAt = await ev(`({ armed: Bay.state().mode.id, count: (document.querySelector('#bay .sqx .sqhc [aria-hidden]') || {}).textContent })`);
    await t11state({ leader: T11_MULE, mode: 'boss', members: [T11YOU(), T11MULE()], fits: { duel: false, ffa: false, boss: true, aliens: true, golf: true } });
    const b2e = await t11boards('#bay .board');
    if (b2dAt.armed === 'boss' && b2dAt.count === '2/4' && JSON.stringify(b2d.cls) === JSON.stringify(['board', 'board', 'board on', 'board', 'board']) && b2d.pills.every((p) => p === null)
        && JSON.stringify(b2e.cls) === JSON.stringify(['board nofit', 'board nofit', 'board on', 'board', 'board'])
        && JSON.stringify(b2e.pills) === JSON.stringify(['Squad too big', 'Squad too big', null, null, null]))
      ok(`${V}: Squad 2/4 in Boss Fight keeps the pills as before -- none while two fit every mode, and "Squad too big" on exactly the boards the frame's fits refuses`);
    else fail(`${V}: squad of two in Boss ${JSON.stringify({ b2dAt, b2d, b2e })}`);

    // ---- B3. A DIM IS A DIM, AND IT MUST NOT LIFT. .board.on raises .bcard,
    //      and a board that greys out while rising reads as a press rather
    //      than a refusal. Measured once the .22s transitions have settled.
    //      AND THE PILL IS NOT DIMMED WITH IT: no filter anywhere between the
    //      pill and its board, or the one thing that says why goes grey too.
    await t11state({ leader: T11_MULE, members: [T11YOU(), T11MULE(), T11PIKE()] });
    await sleep(400);
    const look = await ev(`(() => {
      const b = [...document.querySelectorAll('#bay .board')];
      const img = (i) => getComputedStyle(b[i].querySelector('.bcard img')).filter;
      const p = b[0].querySelector('.bnf'), chain = [];
      for (let e = p; e && e !== b[0].parentNode; e = e.parentNode) chain.push(getComputedStyle(e).filter);
      return { duelOn: b[0].classList.contains('on'), duelImg: img(0), ffaImg: img(1), pillChain: chain,
        duelLift: getComputedStyle(b[0].querySelector('.bcard')).transform };
    })()`);
    if (look.duelOn && /grayscale/.test(look.duelImg) && !/grayscale/.test(look.ffaImg) && look.duelLift === 'none'
        && look.pillChain.length >= 3 && look.pillChain.every((f) => f === 'none'))
      ok(`${V}: the armed board the squad does not fit is dimmed and does not lift, its pill is not dimmed, and a board that fits is untouched`);
    else fail(`${V}: dim look ${JSON.stringify(look)}`);

    // ---- B4. THE PILL MUST NOT EAT THE TAP, CLIP ITS TEXT OR LEAVE ITS BOARD,
    //      at the point a finger lands. CHANGED with B2b: the squad of one's
    //      "Needs 2 players" pills are gone, so a squad of one is read for no
    //      pill at all, and the three are put back for B5.
    const t11pillHit = () => ev(`(() => [...document.querySelectorAll('#bay .board .bnf')].map((p) => {
      const r = p.getBoundingClientRect(), bd = p.closest('.board').getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const b = el && el.closest ? el.closest('.board') : null;
      return { set: b ? b.dataset.set : null, own: p.closest('.board').dataset.set, clipped: p.scrollWidth > p.clientWidth + 1,
        inside: r.left >= bd.left - 0.5 && r.right <= bd.right + 0.5 && r.top >= bd.top - 0.5 && r.bottom <= bd.bottom + 0.5 };
    }))()`);
    const hitBig = await t11pillHit();
    await t11state({ members: [T11YOU()] });
    const hitSmall = await t11pillHit();
    await t11state({ leader: T11_MULE, members: [T11YOU(), T11MULE(), T11PIKE()] });
    const pillOk = (a) => a.length > 0 && a.every((x) => x.set === x.own && !x.clipped && x.inside);
    if (hitBig.length === 3 && hitSmall.length === 0 && pillOk(hitBig))
      ok(`${V}: a tap on a pill lands on its board, and no pill clips its text or leaves its board (a squad of one has none)`);
    else fail(`${V}: pill hit test ${JSON.stringify({ hitBig, hitSmall })}`);

    // ---- B5. THE HOME TYPE-SIZE HOLE. styles.css makes the home screen's small
    //      mono text a fifth larger and left .bof out, because home has no
    //      offline badge. A pill in that slot needs its own home rule: 7.5 x
    //      1.2 = 9. In design units, like every other size check in the tree.
    const size = await ev(`(() => {
      const e = document.createElement('div'); e.style.cssText = 'position:absolute;width:calc(100 * var(--u))';
      $('bay').appendChild(e); const u = e.getBoundingClientRect().width / 100; e.remove();
      const p = document.querySelector('#bay .board .bnf');
      return { scr: $('bay').dataset.scr, pill: p ? +(parseFloat(getComputedStyle(p).fontSize) / u).toFixed(1) : null };
    })()`);
    if (size.scr === 'home' && size.pill === 9) ok(`${V}: the pill takes the home type bump (9u), not the 7.5u hole .bof sits in`);
    else fail(`${V}: pill size ${JSON.stringify(size)}`);

    // ---- B6. A DIMMED BOARD IS ADVICE, NOT A REFUSAL (design 5.2), and since
    //      U3 a MEMBER'S boards are the squad's mode, which only the leader
    //      picks (owner, 2026-10-06). CHANGED BY U3: a member's tap on another
    //      board armed it (fix wave E5); now it arms nothing, sends nothing and
    //      is explained ("The squad leader picks the mode."), and the board
    //      that stays lit is the squad's, dimmed or not. A tap on the squad's
    //      own board still opens Match setup. Three strong on a duel: the lit
    //      board is the squad's Duel, dimmed.
    await t11state({ leader: T11_MULE, members: [T11YOU(), T11MULE(), T11PIKE()] });
    await ev(`(Bay.show('home'), window.__t11toast = [], window.__t11st = showToast, window.showToast = (t) => { __t11toast.push(t); }, true)`);
    await clearTx();
    const tap = await ev(`(() => {
      const boards = () => [...document.querySelectorAll('#bay .board')];
      boards()[2].click();
      const armed = Bay.state().mode.id, boss = boards()[2].className, duel = boards()[0].className, said = __t11toast.slice();
      boards()[0].click();
      const scr = $('bay').dataset.scr;
      Bay.show('home');
      return { armed, boss, duel, said, scr };
    })()`);
    await sleep(MODE_WAIT0);
    const tapSent = (await squads()).length;
    await ev(`(window.showToast = window.__t11st, ccMode = 'duel', Bay.show('home'), true)`);
    if (tap.armed === 'duel' && !/\bon\b/.test(tap.boss) && /\bnofit\b/.test(tap.boss) && /\bon\b/.test(tap.duel) && /\bnofit\b/.test(tap.duel)
        && JSON.stringify(tap.said) === JSON.stringify(['The squad leader picks the mode.']) && tap.scr === 'setup' && tapSent === 0)
      ok(`${V}: a member's tap on another board arms nothing, sends nothing and says the leader picks; the squad's own board, dimmed, opens Match setup`);
    else fail(`${V}: dimmed tap ${JSON.stringify({ tap, tapSent })}`);

    // ---- B7. THE MISSION BOARD SHOWS THE SAME PILL (design 5.2), keeps every
    //      offline badge test/offline.mjs asserts on its five cards, and the
    //      two do not overlap: .mbi .bof sits at 8u, the pill beneath it.
    const t11mission = () => ev(`(() => {
      const c = [...document.querySelectorAll('#bay .mb')];
      return { nofit: c.map((x) => x.classList.contains('nofit')),
        pills: c.map((x) => { const p = x.querySelector('.bnf'); return p ? p.textContent : null; }),
        bof: c.map((x) => !!x.querySelector('.bof')),
        clear: c.filter((x) => x.querySelector('.bnf')).every((x) => x.querySelector('.bnf').getBoundingClientRect().top >= x.querySelector('.bof').getBoundingClientRect().bottom - 0.5),
        clipped: [...document.querySelectorAll('#bay .mb .bnf')].some((p) => p.scrollWidth > p.clientWidth + 1),
        through: [...document.querySelectorAll('#bay .mb .bnf')].every((p) => { const r = p.getBoundingClientRect();
          const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(el && el.closest && el.closest('.mb') === p.closest('.mb')); }) };
    })()`);
    await ev(`(Bay.show('modes'), true)`); await sleep(450);
    const mis = await t11mission();
    // AND IT FOLLOWS THE SQUAD WHILE IT IS ON SCREEN: a roster that lands while
    // the Mission board is up repaints it, with no tap in between. CHANGED with
    // B2b: the roster is a squad of one, which takes every pill and dim off
    // the five cards (it put "Needs 2 players" on Duel and Free-for-all).
    await t11state({ members: [T11YOU()] });
    const misLive = await t11mission();
    await ev(`(Bay.show('home'), true)`);
    if (JSON.stringify(mis.nofit) === JSON.stringify([true, false, true, true, false])
        && JSON.stringify(mis.pills) === JSON.stringify(['Squad too big', null, 'Squad too big', 'Squad too big', null])
        && mis.bof.every(Boolean) && mis.clear && !mis.clipped && mis.through)
      ok(`${V}: the Mission board carries the same pill, keeps every offline badge, and the two do not overlap`);
    else fail(`${V}: mission ${JSON.stringify(mis)}`);
    if (misLive.pills.length === 5 && misLive.pills.every((p) => p === null) && misLive.nofit.every((x) => !x) && misLive.bof.every(Boolean))
      ok(`${V}: a roster that lands while the Mission board is up repaints its pills: Squad 1/4 leaves every card live`);
    else fail(`${V}: mission repaint ${JSON.stringify(misLive)}`);

    // ---- B8. AND WHEN THE SQUAD IS OVER, THE DIM GOES WITH IT: a board left
    //      grey after a leave would refuse a mode nobody is refusing.
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(80);
    const b8 = await t11boards('#bay .board');
    if (JSON.stringify(b8.cls) === JSON.stringify(['board on', 'board', 'board', 'board', 'board']) && b8.pills.every((p) => p === null))
      ok(`${V}: a squad that ends takes every dim and pill with it`);
    else fail(`${V}: after the squad ${JSON.stringify(b8)}`);

    // ---- M1. THE LEADER'S BOARDS ARE THE SQUAD'S MODE CONTROL (D7). This page
    //      leads (you 0, leader ME, held). Golf is tapped, and once the taps
    //      stop the server is asked ONCE, with the tee set and NO seat count:
    //      golf's Players picker is gone (owner, 2026-10-06) and the server
    //      sizes a squad's room to the squad. CHANGED FROM max 2 with that
    //      picker. The free-for-all still sends one, and it is a NUMBER, never a
    //      string (the server refuses '4' as bad_max): M1b.
    const t11board = (...idx) => ev(`(() => { const b = () => [...document.querySelectorAll('#bay .board')]; for (const i of ${JSON.stringify(idx)}) b()[i].click(); return true; })()`);
    const t11modes = async () => (await squads()).filter((f) => f.op === 'mode');
    // The box's action line (U4: the box's list, under its member rows).
    const t11aerr = () => ev(`(() => { Bay.show('home'); const e = document.querySelector('#bay .sqx .sqml ~ .sqae'); return e && !e.classList.contains('hidden') ? e.textContent : ''; })()`);
    const MODE_WAIT = MODE_WAIT0;
    await t11state({ members: [T11YOU(), T11MULE()] });
    await clearTx();
    await t11board(4); await sleep(MODE_WAIT);
    const m1 = await t11modes();
    if (m1.length === 1 && m1[0].mode === 'golf' && m1[0].tees === 'mens' && m1[0].max === null && typeof m1[0].id === 'number')
      ok(`${V}: the leader arming golf sends one squad mode frame carrying the tee set and no seat count`);
    else fail(`${V}: leader mode ${JSON.stringify(m1)}`);
    await reply({ op: 'mode', ok: true });
    await t11state({ mode: 'golf', tees: 'mens', max: null, members: [T11YOU(), T11MULE()] });
    // ---- M1b. THE FREE-FOR-ALL SENDS NO SEAT COUNT EITHER, and golf is put
    //      back for M2. CHANGED BY U3: it sent this device's CPU count as the
    //      number 4; a squad's room is sized to the squad, and every change of
    //      the squad's settings now stands every member down, so a count that
    //      seats nobody must not.
    await clearTx();
    await t11board(1); await sleep(MODE_WAIT);
    const m1b = await t11modes();
    await reply({ op: 'mode', ok: true });
    await t11state({ mode: 'ffa', max: null, members: [T11YOU(), T11MULE()] });
    await clearTx();
    await t11board(4); await sleep(MODE_WAIT);
    await reply({ op: 'mode', ok: true });
    await t11state({ mode: 'golf', tees: 'mens', max: null, members: [T11YOU(), T11MULE()] });
    if (m1b.length === 1 && m1b[0].mode === 'ffa' && m1b[0].tees === null && m1b[0].max === null)
      ok(`${V}: the leader arming the free-for-all sends no seat count and no tee set`);
    else fail(`${V}: leader ffa mode ${JSON.stringify(m1b)}`);
    // ---- M2. A RUN OF TAPS IS ONE FRAME, the last one. Every squad op spends
    //      from one bucket of twenty a minute (server/social.js LIMITS.squad),
    //      Start's included, so reading the boards must not spend it.
    await clearTx();
    await t11board(1, 2, 3); await sleep(MODE_WAIT);
    const m2 = await t11modes();
    if (m2.length === 1 && m2[0].mode === 'aliens' && m2[0].tees === null && m2[0].max === null)
      ok(`${V}: three quick taps send one frame, for the board the leader stopped on, with no tee set and no seat count`);
    else fail(`${V}: coalesced taps ${JSON.stringify(m2)}`);
    await reply({ op: 'mode', ok: true });
    await t11state({ mode: 'aliens', members: [T11YOU(), T11MULE()] });
    // ---- M3. ONLY WHAT THE SQUAD DOES NOT ALREADY SAY. Away and back to the
    //      squad's own mode: nothing to ask, so nothing is sent.
    await clearTx();
    await t11board(1, 3); await sleep(MODE_WAIT);
    const m3 = await t11modes();
    if (m3.length === 0 && (await ev('Bay.state().mode.id')) === 'aliens')
      ok(`${V}: taps that end on the squad's own mode send nothing`);
    else fail(`${V}: nothing to send ${JSON.stringify(m3)}`);
    // ---- M4. THE LIT BOARD STILL SPEAKS FOR THE SQUAD. A second tap on the
    //      armed board opens Match setup -- and for a leader whose squad is on
    //      another mode (a squad starts on Duel, whatever was lit), it is the
    //      only tap there is on that board, so it is sent too.
    await ev(`(ccMode = 'golf', Bay.show('home'), true)`);
    await clearTx();
    await t11board(4); await sleep(MODE_WAIT);
    const m4 = await t11modes(), m4scr = await ev(`$('bay').dataset.scr`);
    await ev(`(Bay.show('home'), true)`);
    // CHANGED (owner, 2026-10-06): golf carries no seat count (max null, was 2).
    if (m4.length === 1 && m4[0].mode === 'golf' && m4[0].tees === 'mens' && m4[0].max === null && m4scr === 'setup')
      ok(`${V}: a second tap on the lit board opens Match setup and puts that board to the squad`);
    else fail(`${V}: lit board ${JSON.stringify({ m4, m4scr })}`);
    await reply({ op: 'mode', ok: true });
    await t11state({ mode: 'golf', tees: 'mens', max: null, members: [T11YOU(), T11MULE()] });
    // ---- M5. MATCH SETUP'S TEE SET IS THE SQUAD'S TOO, and the only place it
    //      changes. CHANGED (owner, 2026-10-06): golf's Players picker, whose
    //      count rode in the same frame, is gone from Match setup.
    await clearTx();
    const m5gcount = await ev(`(() => { Bay.show('setup'); const g = document.querySelectorAll('#bay [data-set^="gcount="]').length; document.querySelector('#bay [data-set="tees=champ"]').click(); return g; })()`);
    await sleep(MODE_WAIT);
    const m5 = await t11modes();
    await ev(`(Bay.show('home'), true)`);
    if (m5.length === 1 && m5[0].mode === 'golf' && m5[0].tees === 'champ' && m5[0].max === null && m5gcount === 0)
      ok(`${V}: the tee set chosen in Match setup reaches the squad in one frame, and there is no golf seat count to send`);
    else fail(`${V}: setup push ${JSON.stringify({ m5, m5gcount })}`);
    await reply({ op: 'mode', ok: true });
    await t11state({ mode: 'golf', tees: 'champ', max: null, members: [T11YOU(), T11MULE()] });
    // ---- M6. A MEMBER'S BOARDS ARE THE SQUAD'S MODE. The server would answer
    //      'not_leader' every time, so the tap is never sent. CHANGED BY U3:
    //      the tap armed the member's own board; it arms nothing now (B6).
    await t11state({ leader: T11_MULE, members: [T11YOU(), T11MULE()] });
    await clearTx();
    await t11board(1); await sleep(MODE_WAIT);
    const m6 = await t11modes();
    if (m6.length === 0 && (await ev('Bay.state().mode.id')) === 'duel')
      ok(`${V}: a member's tap on a board leaves the squad's mode armed and sends the squad nothing`);
    else fail(`${V}: member mode ${JSON.stringify({ m6, armed: await ev('Bay.state().mode.id') })}`);
    // ---- M7. A ROSTER THIS SOCKET DOES NOT SAY IT HOLDS (D-UI-1) commands
    //      nothing: a frame with no `held` is shown, and its leader's taps stay
    //      on this device.
    await ev(`(handle({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)}, mode: 'duel', tees: null, max: null, you: 0,
      members: [${JSON.stringify(T11YOU())}, ${JSON.stringify(T11MULE())}], fits: ${JSON.stringify(t11fits(2))} }), true)`);
    await sleep(80);
    await clearTx();
    await t11board(2); await sleep(MODE_WAIT);
    const m7 = await t11modes();
    if (m7.length === 0) ok(`${V}: a leader's tap on a roster this socket does not hold sends nothing`);
    else fail(`${V}: not held ${JSON.stringify(m7)}`);
    // ---- M8. A REFUSAL IS SAID ON THE BOX'S ACTION LINE, in this project's
    //      words, and the footer keeps the squad's mode. bad_max is a client
    //      bug more than a player's, so its sentence blames nobody. An answer
    //      to an EARLIER send says nothing once a later one is out.
    await t11state({ members: [T11YOU(), T11MULE({ ready: true })] });
    const m8 = {};
    for (const [i, code] of [[4, 'bad_max'], [1, 'slow_down'], [2, 'not_leader'], [3, 'no_such_thing']]) {
      await clearTx(); await t11board(i); await sleep(MODE_WAIT);
      await reply({ op: 'mode', error: code });
      m8[code] = await t11aerr();
    }
    // The footer is the Manage squad window's (U4).
    const m8foot = await ev(`(Bay.show('squad'), (document.querySelector('#sqWin-squad .sqft .sqfl') || {}).textContent)`);
    await ev(`(Bay.show('home'), true)`);
    await clearTx(); await t11board(4); await sleep(MODE_WAIT);
    const first = (await t11modes())[0];
    await clearTx(); await t11board(1); await sleep(MODE_WAIT);
    const second = (await t11modes())[0];
    const m8wait = await t11aerr();
    await answer(first && first.id, { type: 'squad', op: 'mode', error: 'bad_max' });
    const m8stale = await t11aerr();
    await answer(second && second.id, { type: 'squad', op: 'mode', ok: true });
    const m8ok = await t11aerr();
    if (m8.bad_max === 'That seat count could not be set for the squad. Try again.'
        && m8.slow_down === 'Too many tries. Wait a moment.'
        && m8.not_leader === 'Only the squad leader can pick the mode.'
        && m8.no_such_thing === 'The squad could not change modes right now. Try again.'
        && m8foot === 'Duel · 2')
      ok(`${V}: a refused mode says its own sentence on the action line, and the footer keeps the squad's mode`);
    else fail(`${V}: mode refusals ${JSON.stringify({ m8, m8foot })}`);
    if (first && second && first.id !== second.id && m8wait === '' && m8stale === '' && m8ok === '')
      ok(`${V}: a new send clears the last refusal, and an answer to a send that was overtaken says nothing`);
    else fail(`${V}: stale mode answer ${JSON.stringify({ first, second, m8wait, m8stale, m8ok })}`);
    // ---- M9. A TAP WITH THE SOCKET DOWN IS THIS DEVICE'S ALONE, and leaves
    //      nothing behind: no "Not connected" line waiting under the squad for
    //      the connection to come back to.
    await ev(`(ccMode = 'duel', Bay.show('home'), true)`);
    await up(false);
    await t11board(2); await sleep(MODE_WAIT);
    await up(true);
    const m9 = await t11aerr(), m9armed = await ev('Bay.state().mode.id');
    if (m9 === '' && m9armed === 'boss') ok(`${V}: a leader's tap with the socket down arms this device and leaves no refusal behind`);
    else fail(`${V}: offline tap ${JSON.stringify({ m9, m9armed })}`);
    await ev(`(ccMode = 'duel', ccTees = 'mens', Bay.show('home'), true)`);
    // ---- R1-R3, R5, R6 (task 11, D-UI-3) ARE GONE WITH THE SQUAD'S OWN
    //      ARMOURY (U3). A rack too short for the squad's mode put "Pick N
    //      more" in Ready's (or Start's) place, and that door opened an Armoury
    //      that drafted for the squad's mode and went "Back to the squad". A
    //      Ready now fills a short rack with standard weapons itself (owner,
    //      2026-10-06: a short rack never stops a start), so there is no door
    //      and no squad Armoury; task 9's A4 and A5 pin the filled Ready.
    const t11arm = () => ev(`(() => {
      const q = (s) => document.querySelector(s), foot = q('#bay .pfoot');
      return { scr: $('bay').dataset.scr, title: (q('#bay .card .lbl + div') || {}).textContent || null,
        slots: document.querySelectorAll('#bay .card .slots .slot').length, full: document.querySelectorAll('#bay .card .slots .slot.f').length,
        meta: (q('#bay .pm') || {}).textContent, launch: !!q('#bay [data-launch]'),
        foot: foot ? [...foot.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), dis: b.disabled, back: b.hasAttribute('data-back') })) : null };
    })()`);
    // ---- R4. THE ARMOURY REACHED FROM MATCH SETUP drafts for the armed mode,
    //      which for a member is the squad's (fix wave E3: a member's device
    //      follows the squad's mode). CHANGED (owner, 2026-10-06): it is Edit's
    //      side trip, not step 3 of 3, and it never launches -- its Done goes
    //      back to Match setup. CHANGED BY U3: the member was put on the
    //      squad's Boss by R3's walk through the squad's Armoury; R4 now puts
    //      itself there, a member of a Boss Fight squad shown home.
    await t11rack(FIVE11);
    await t11state({ leader: T11_MULE, mode: 'boss', members: [T11YOU(), T11MULE({ ready: true })] });
    await ev(`(Bay.show('home'), Bay.show('setup'), true)`);
    await click('#bay .card [data-go="armoury"]'); await sleep(80);
    const r4 = await t11arm();
    await click('#bay .pfoot [data-back]'); await sleep(80);
    const r4back = await ev(`$('bay').dataset.scr`);
    await ev(`(Bay.show('home'), true)`);
    if (r4.scr === 'armoury' && r4.title === 'Boss Fight' && r4.slots === 7 && r4.meta === 'Your rack' && !r4.launch
        && JSON.stringify(r4.foot) === JSON.stringify([{ t: 'Done', dis: false, back: true }]) && r4back === 'setup')
      ok(`${V}: the Armoury reached from Match setup's Edit drafts for the armed mode, never launches, and its Done goes back to Match setup`);
    else fail(`${V}: launch-flow armoury ${JSON.stringify({ r4, r4back })}`);
    await t11rack(FIVE11);
    // ---- S1. MATCH SETUP'S PLAY WITH (owner, 2026-10-06). Friend games are
    //      squads only: Computer (or Solo) and Your squad. Setup opens on Your
    //      squad in a squad of two or more and on Computer otherwise, on every
    //      entry from home; a choice survives Edit's Armoury, Repaint's Paint
    //      shop and Change mode's Mission board, and never a visit. Your squad
    //      is shown but disabled, with its one line, outside a squad of two.
    //      While it is the choice Start Game is the squad's Ready, and never
    //      makes a room of its own. CHANGED BY U3: home's Launch is the squad's
    //      Ready in a squad of two, so Match setup is opened here by its other
    //      door, the readouts; Start Game reads "Ready up 0/2" and sends the
    //      squad's Ready, where U2's hook sent nothing.
    const s1with = () => ev(`(() => {
      const o = [...document.querySelectorAll('#bay .b-opt')].find((x) => x.querySelector('.lbl') && x.querySelector('.lbl').textContent === 'Play with');
      const st = document.querySelector('#bay .pfoot [data-launch]');
      return { scr: $('bay').dataset.scr, opts: o ? [...o.querySelectorAll('.seg')].map((b) => ({ t: b.firstChild.textContent.trim(), on: b.classList.contains('on'), dis: b.disabled,
        why: b.querySelector('.b-why') ? b.querySelector('.b-why').textContent : null })) : null,
        play: (document.querySelector('#bay .brief .brow:last-child b') || {}).textContent || null, start: st ? st.textContent.trim() : null };
    })()`);
    const s1on = (r) => (r.opts || []).filter((o) => o.on).map((o) => o.t).join();
    const s1readout = () => ev(`(() => { Bay.show('home'); return document.querySelector('#bay .lbar .ros').textContent.replace(/\\s+/g, ' '); })()`);
    await ev(`(ccMode = 'duel', true)`);
    await t11state({ members: [T11YOU(), T11MULE()] });
    const s1 = {};
    s1.readout2 = await s1readout();
    await click('#bay .lbar .ros'); await sleep(60);
    s1.open = await s1with();
    await click('#bay [data-set="with=cpu"]'); await sleep(40);
    s1.cpu = await s1with();
    await click('#bay .card [data-go="armoury"]'); await sleep(40); await click('#bay .pfoot [data-back]'); await sleep(40);
    s1.armoury = await s1with();
    await click('#bay [data-go="paint"]'); await sleep(40); await click('#bay .go[data-back]'); await sleep(40);
    s1.paint = await s1with();
    await click('#bay .pfoot [data-go="modes"]'); await sleep(40); await click('#bay .mb[data-set="mode=duel"]'); await sleep(40);
    s1.modes = await s1with();
    // START GAME WITH COMPUTER, IN A SQUAD: the player's own vs-Computer game.
    await ev(`(window.__s1sent = [], window.__s1intent = intent, window.intent = (m) => { __s1sent.push(m); }, true)`);
    await clearTx(); await click('#bay .pfoot [data-launch]'); await sleep(40);
    s1.cpuStart = { sent: await ev('__s1sent.slice()'), squad: (await squads()).length };
    // AND BACK ON HOME, A NEW VISIT OPENS ON THE SQUAD AGAIN.
    await ev(`(Bay.show('home'), true)`);
    await click('#bay .lbar .ros'); await sleep(60);
    s1.again = await s1with();
    await ev(`(__s1sent.length = 0, true)`); await clearTx();
    await click('#bay .pfoot [data-launch]'); await sleep(40);
    s1.sqStart = { sent: await ev('__s1sent.slice()'), squad: await squads(), scr: await ev(`$('bay').dataset.scr`) };
    if (s1.sqStart.squad.length) await reply({ op: 'ready', error: 'unavailable' });
    // A SQUAD'S FREE-FOR-ALL HAS NO CPU COUNT AND NO DIFFICULTY: the server
    // sizes its room to the squad, and nobody is the computer.
    s1.ffa = await ev(`(() => { ccMode = 'ffa'; Bay.show('home'); document.querySelector('#bay .lbar .ros').click();
      const g = [...document.querySelectorAll('#bay .b-opt:not(.hidden) .lbl')].map((l) => l.textContent).join('|');
      ccMode = 'duel'; Bay.show('home'); document.querySelector('#bay .lbar .ros').click(); return g; })()`);
    // THE SQUAD DROPS TO ONE UNDER THE SCREEN: Your squad greys out, with its
    // line, and the untouched default is Computer; it comes back when a second
    // player does.
    await t11state({ members: [T11YOU()] });
    s1.one = await s1with();
    await t11state({ members: [T11YOU(), T11MULE()] });
    s1.two = await s1with();
    await t11state({ members: [T11YOU()] });
    s1.readout1 = await s1readout();
    await ev(`(window.intent = window.__s1intent, true)`);
    const S1SQ = [{ t: 'Computer', on: false, dis: false, why: null }, { t: 'Your squad', on: true, dis: false, why: null }];
    const S1CPU = [{ t: 'Computer', on: true, dis: false, why: null }, { t: 'Your squad', on: false, dis: false, why: null }];
    const S1OFF = [{ t: 'Computer', on: true, dis: false, why: null }, { t: 'Your squad', on: false, dis: true, why: 'Needs a squad of 2 or more' }];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (s1.open.scr === 'setup' && same(s1.open.opts, S1SQ) && s1.open.play === 'Your squad' && s1.open.start === 'Ready up 0/2Waiting for you, Steel Mule' && /Players\s*Squad of 2/.test(s1.readout2))
      ok(`${V}: in a squad of two, home's Players reads Squad of 2 and Match setup opens on Your squad, Start Game reading "Ready up 0/2" and who it waits for`);
    else fail(`${V}: setup squad default ${JSON.stringify({ open: s1.open, readout: s1.readout2 })}`);
    if (same(s1.cpu.opts, S1CPU) && s1.cpu.play === 'Computer \u00b7 Medium' && s1on(s1.armoury) === 'Computer' && s1.armoury.scr === 'setup'
        && s1on(s1.paint) === 'Computer' && s1.paint.scr === 'setup' && s1on(s1.modes) === 'Computer' && s1.modes.scr === 'setup')
      ok(`${V}: Computer, once chosen, survives Edit's Armoury, Repaint's Paint shop and Change mode's Mission board`);
    else fail(`${V}: setup choice round trips ${JSON.stringify({ cpu: s1.cpu, armoury: s1.armoury, paint: s1.paint, modes: s1.modes })}`);
    if (s1.cpuStart.sent.length === 1 && s1.cpuStart.sent[0].type === 'ai' && s1.cpuStart.squad === 0)
      ok(`${V}: Start Game with Computer, in a squad, starts the player's own game against the computer and sends the squad nothing`);
    else fail(`${V}: computer start in a squad ${JSON.stringify(s1.cpuStart)}`);
    if (same(s1.again.opts, S1SQ))
      ok(`${V}: the next visit from home opens on Your squad again: nothing remembered the choice`);
    else fail(`${V}: setup reset ${JSON.stringify(s1.again)}`);
    if (s1.ffa === 'Play with') ok(`${V}: a squad's Free-for-all shows no CPU count and no Difficulty`);
    else fail(`${V}: squad ffa groups ${s1.ffa}`);
    if (s1.sqStart.sent.length === 0 && s1.sqStart.squad.length === 1 && s1.sqStart.squad[0].op === 'ready' && s1.sqStart.squad[0].ready === true
        && JSON.stringify(s1.sqStart.squad[0].loadout) === JSON.stringify(FIVE11) && s1.sqStart.scr === 'setup')
      ok(`${V}: Start Game with Your squad sends the squad's Ready with the rack and makes no room of its own`);
    else fail(`${V}: squad start ${JSON.stringify(s1.sqStart)}`);
    if (same(s1.one.opts, S1OFF) && s1.one.play === 'Computer \u00b7 Medium' && same(s1.two.opts, S1SQ) && /Players\s*You vs CPU/.test(s1.readout1))
      ok(`${V}: a squad of one greys Your squad out with "Needs a squad of 2 or more" and the default is Computer, live; a second player brings Your squad back`);
    else fail(`${V}: squad of one ${JSON.stringify({ one: s1.one, two: s1.two, readout: s1.readout1 })}`);
    await ev(`(Bay.show('home'), true)`);
    // ---- C1. THE ONE CODE FIELD IS TASK 8's (#sqCode, X8); what it still owed
    //      is here. ONE CODE AT A TIME (review T8-R1-10): two presses before the
    //      server has answered are one code frame, the Join button is held
    //      while it is out, and every way it can settle frees it again.
    //      CHANGED BY U4: the field is the Manage squad window's (its button
    //      reads Join), and an unknown code is "No squad with that code."
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), Bay.show('squad'), true)`); await sleep(80);
    const SQ_NONE11 = 'No squad with that code.';
    const SQ_GAME11 = 'That is a game code. Only squad codes join here.';
    const t11code = (v) => ev(`(() => { if (document.getElementById('bay').dataset.scr !== 'squad') Bay.show('squad'); const i = document.getElementById('sqCode'); if (!i) return false; i.value = ${JSON.stringify(v)}; return true; })()`);
    // Pressed through the real listener, twice, and with Enter on the field --
    // a disabled button swallows a click, so the second press is also made on
    // a button the render never drew, to prove the guard is in the handler.
    const t11press = () => ev(`(() => { const p = document.getElementById('sqWin-code'); const b = document.createElement('button');
      b.setAttribute('data-sq', 'code'); p.appendChild(b); b.click(); b.remove(); return true; })()`);
    const t11codes = async () => (await tx()).filter((f) => f.type === 'code');
    const t11joins = async () => (await squads()).filter((f) => f.op === 'join');
    const t11enter = () => ev(`(() => { Bay.show('squad'); const b = document.querySelector('#sqWin-code [data-sq="code"]'); return b ? b.disabled : null; })()`);
    const t11cerr = () => ev(`(() => { Bay.show('squad'); const r = document.querySelector('#sqWin-code .sqcr'); const e = r && r.nextElementSibling; return e && e.classList.contains('sqe') && !e.classList.contains('hidden') ? e.textContent : ''; })()`);
    const t11codeAnswer = async (patch) => { await ev(`(() => { const q = window.__tx.filter((f) => f.type === 'code'); handle(Object.assign({ type: 'code', id: q.length ? q[q.length - 1].id : null }, ${JSON.stringify(patch)})); return true; })()`); await sleep(100); };
    const c1 = {};
    await t11code('MNPQ'); await clearTx();
    await click('#sqWin-code [data-sq="code"]'); c1.held = await t11enter();
    await t11press();
    await ev(`(() => { const i = document.getElementById('sqCode'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await sleep(60);
    c1.out = (await t11codes()).length;
    await t11codeAnswer({ kind: 'none' });
    c1.freed = await t11enter(); c1.err = await t11cerr();
    await clearTx(); await t11press(); await sleep(60);
    c1.again = (await t11codes()).length;
    await t11codeAnswer({ kind: 'none' });
    if (c1.held === true && c1.out === 1 && c1.freed === false && c1.err === SQ_NONE11 && c1.again === 1)
      ok(`${V}: three presses while a code is out send one code frame, Join is held until the answer, and the answer frees it`);
    else fail(`${V}: code busy guard ${JSON.stringify(c1)}`);
    // ---- C2. THE GUARD SPANS THE SQUAD JOIN: a press between the code's answer
    //      and the join's sends neither another code nor another join, and the
    //      join's answer -- a refusal here -- frees it.
    await t11code('BKPQ'); await clearTx();
    await t11press(); await sleep(60);
    await t11codeAnswer({ kind: 'squad' });
    const c2j = (await t11joins()).length;
    await t11press(); await sleep(60);
    const c2 = { joins: (await t11joins()).length, codes: (await t11codes()).length, held: await t11enter() };
    await reply({ op: 'join', error: 'full' });
    c2.err = await t11cerr(); c2.freed = await t11enter();
    await clearTx(); await t11press(); await sleep(60);
    c2.again = (await t11codes()).length;
    await t11codeAnswer({ kind: 'none' });
    if (c2j === 1 && c2.joins === 1 && c2.codes === 1 && c2.held === true && c2.err === 'That squad is full.' && c2.freed === false && c2.again === 1)
      ok(`${V}: a press while the squad join is out sends nothing, and the join's refusal frees the field`);
    else fail(`${V}: busy through the join ${JSON.stringify({ c2j, c2 })}`);
    // ---- C3. A REFUSED CODE FRAME AND A GAME'S CODE FREE IT TOO, and a dead
    //      socket -- answered synchronously by socialTx -- never latches it.
    //      CHANGED BY U4: the room branch is a game's code, said and joined
    //      nowhere.
    const c3 = {};
    await t11code('MNPQ'); await clearTx(); await t11press(); await sleep(60);
    await t11codeAnswer({ error: 'unavailable' });
    await clearTx(); await t11press(); await sleep(60); c3.afterErr = (await t11codes()).length;
    await t11codeAnswer({ kind: 'room' });
    await clearTx(); await t11press(); await sleep(60); c3.afterRoom = (await t11codes()).length;
    await t11codeAnswer({ kind: 'none' });
    await up(false); await t11press(); await sleep(60); await up(true);
    await t11code('MNPQ'); await clearTx(); await t11press(); await sleep(60); c3.afterDead = (await t11codes()).length;
    await t11codeAnswer({ kind: 'none' });
    if (c3.afterErr === 1 && c3.afterRoom === 1 && c3.afterDead === 1)
      ok(`${V}: a refused code frame, a game's code and a dead socket each leave the field free for the next code`);
    else fail(`${V}: busy release ${JSON.stringify(c3)}`);
    // ---- C4. GAME CODES ARE RETIRED (U4; owner, 2026-10-06: the field joins
    //      squads only). REPLACES task 11's room-refusal checks (C4, the room
    //      join through the legacy rack with its refusal read back from
    //      #homeError, and C5, that read-back's bounds): a game's code is said
    //      to be one, in the field, and NOTHING joins -- no join frame, the
    //      legacy #codeInput untouched, #joinBtn never pressed -- and nothing a
    //      later flow writes into #homeError is said in the field.
    await ev(`(() => { $('codeInput').value = ''; $('homeError').textContent = ''; window.__j11 = 0; const b = $('joinBtn'); window.__j11fn = b.onclick; b.onclick = () => { window.__j11++; }; return true; })()`);
    await t11code('zz9q'); await clearTx(); await t11press(); await sleep(60);
    const c4asked = await t11codes();
    await t11codeAnswer({ kind: 'room' });
    await sleep(100);
    await ev(`(handle({ type: 'joinError', reason: 'That room is full.' }), $('homeError').textContent = 'Something else entirely', true)`); await sleep(80);
    const c4 = { err: await t11cerr(), joins: (await tx()).filter((f) => f.type === 'join' || (f.type === 'squad' && f.op === 'join')).length,
      field: await ev(`$('codeInput').value`), pressed: await ev('window.__j11'), freed: await t11enter() };
    await ev(`(() => { $('joinBtn').onclick = window.__j11fn; $('homeError').textContent = ''; return true; })()`);
    if (c4asked.length === 1 && c4asked[0].code === 'ZZ9Q' && c4.err === SQ_GAME11 && c4.joins === 0 && c4.field === '' && c4.pressed === 0 && c4.freed === false)
      ok(`${V}: a game's code is said to be one, in the field, and joins nothing -- no frame, no legacy join, no read-back of #homeError`);
    else fail(`${V}: game code ${JSON.stringify({ c4asked, c4 })}`);
    // ---- J1. THE JOIN SCREEN IS GONE (design 5.3, R10). render() falls back to
    //      home for an unknown name, so the stamp alone would pass either way:
    //      what proves the removal is that no overlay is built, the launch bar
    //      has lost its button (and kept Launch), and the page holds ONE code
    //      field where the overlay used to add a second. CHANGED BY U4: that
    //      field is the Manage squad window's, so home holds none.
    const gone = await ev(`(() => {
      Bay.show('join');
      const out = { scr: $('bay').dataset.scr, overlay: !!document.querySelector('#bay .jn'),
        bar: [...document.querySelectorAll('#bay .lbar button')].map((b) => b.textContent.trim()),
        fields: document.querySelectorAll('#bay input[maxlength="4"]').length, sqCode: document.querySelectorAll('#sqCode').length,
        old: !!document.getElementById('bayCode') };
      Bay.show('squad');
      out.winFields = document.querySelectorAll('#bay input[maxlength="4"]').length;
      out.winCode = document.querySelectorAll('#sqWin-code #sqCode').length;
      Bay.show('home');
      return out;
    })()`);
    if (gone.scr === 'home' && !gone.overlay && !gone.bar.some((t) => /join/i.test(t)) && gone.bar.some((t) => /Launch/.test(t))
        && gone.fields === 0 && gone.sqCode === 0 && gone.winFields === 1 && gone.winCode === 1 && !gone.old)
      ok(`${V}: no join screen, no Join code button beside Launch, no code field on home, and one in the Manage squad window`);
    else fail(`${V}: join leftovers ${JSON.stringify(gone)}`);
  }
} catch (e) {
  fail('squad_ui task 11 stopped: ' + (e && e.message));
}

// ============================================================================
// FIX WAVE W2 (client half of the whole-branch fix wave; .superpowers/sdd3/
// final-wave.md). Each check pins one decided behaviour through what the page
// shows, stores and sends -- bay.js keeps its internals private -- and was
// shown RED with the matching part of the fix reverted. One viewport: these are
// behaviours, not layout.
if (want('w')) try {
  const W2_MULE = '00000000-0000-4000-8000-0000000000cc';
  const W2R = (tag) => (tag + '0'.repeat(32)).slice(0, 32);
  const W2GK = 'ab'.repeat(16);
  const w2m = (id, callsign, rid, o) => Object.assign({ id, rid: W2R(rid), callsign, guest: id === null, online: true, ready: false, dropped: false }, o);
  const w2fits = (n) => ({ duel: n === 2, ffa: n >= 2 && n <= 4, boss: n >= 1 && n <= 2, aliens: n >= 1 && n <= 2, golf: n >= 1 && n <= 4 });
  const w2state = async (patch) => {
    const n = (patch.members || []).length;
    await ev(`(handle(Object.assign({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)},
      mode: 'duel', tees: null, max: null, you: 0, held: true, members: [], fits: ${JSON.stringify(w2fits(n))} }, ${JSON.stringify(patch)})), true)`);
    await sleep(80);
  };
  // A fresh page in the SAME tab, as the reload after a match gives: the same
  // sessionStorage.
  const w2load = async () => {
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    for (let i = 0; i < 80; i++) {
      if (await ev('!!window.Bay && typeof handle === "function" && !!document.querySelector("#bay .boards")').catch(() => false)) {
        for (let k = 0; k < 40 && (await ev(`document.getElementById('bay').classList.contains('enter')`)); k++) await sleep(100);
        return true;
      }
      await sleep(200);
    }
    return false;
  };
  const w2hello = async () => { await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(80); };
  const w2hide = () => ev(`(window.dispatchEvent(new Event('pagehide')), true)`);
  // The home box's list (U4: what the Squad pane said, the box says).
  const w2pane = () => ev(`(() => { Bay.show('home'); const p = document.querySelector('#bay .sqx .sqb'); return p ? p.textContent.replace(/\\s+/g, ' ') : ''; })()`);
  const V = '667x375';
  await send('Emulation.setDeviceMetricsOverride', { width: 667, height: 375, deviceScaleFactor: 2, mobile: true });
  if (!(await w2load())) throw new Error('page never became ready for the fix-wave checks');
  await ev(`(localStorage.removeItem('cc_squad'), sessionStorage.clear(), true)`);

  // ---- W1. A GUEST ROW'S SECRET RIDES THE RELOAD (E1). Written to this
  //      tab's sessionStorage only on pagehide; the next page takes it OUT of
  //      storage (a duplicated tab copies nothing), presents it on its first
  //      ask, and a `gone` spends it.
  await stubSocket(); await setWho('guest'); await w2hello();
  await w2state({ leader: W2_MULE, you: 0, gk: W2GK, members: [w2m(null, null, 'g1'), w2m(W2_MULE, 'Steel Mule', 'c1')] });
  const w1before = await ev(`sessionStorage.getItem('cc_squad_gk')`);
  await w2hide();
  const w1stored = await ev(`sessionStorage.getItem('cc_squad_gk')`);
  if (!(await w2load())) throw new Error('page never came back after the reload');
  const w1left = await ev(`sessionStorage.getItem('cc_squad_gk')`);
  await stubSocket(); await setWho('guest'); await w2hello();
  const w1ask = await squads();
  await reply({ op: 'gone' });
  await w2hide();
  const w1spent = await ev(`sessionStorage.getItem('cc_squad_gk')`);
  if (w1before === null && w1stored === JSON.stringify({ code: 'QK7T', gk: W2GK }) && w1left === null
      && w1ask.length === 1 && w1ask[0].op === 'resume' && w1ask[0].code === 'QK7T' && w1ask[0].gk === W2GK && w1spent === null)
    ok(`${V}: a guest row's secret goes to sessionStorage only on pagehide, the next page takes it out, asks {resume, code, gk}, and a gone spends it`);
  else fail(`${V}: guest secret across a reload ${JSON.stringify({ w1before, w1stored, w1left, w1ask, w1spent })}`);

  // ---- W2. AN INVITE RIDES THE RELOAD TO ITS OWN ACCOUNT ONLY (E2), with its
  //      own arrival time, and not once it is ten minutes old.
  await stubSocket(); await setWho('in'); await w2hello(); await reply({ op: 'gone' });
  await ev(`(handle({ type: 'squad', op: 'invited', code: 'ZK4P', from: { callsign: 'Steel Mule' }, size: 2, max: 4 }), true)`); await sleep(80);
  const w2at = await ev('window.CC_SQUAD_INVITE && window.CC_SQUAD_INVITE.at');
  await w2hide();
  const w2carry = JSON.parse((await ev(`sessionStorage.getItem('cc_squad_invite')`)) || 'null');
  if (!(await w2load())) throw new Error('page never came back after the invite reload');
  await stubSocket(); await setWho('in');
  const w2back = await ev('window.CC_SQUAD_INVITE && { code: window.CC_SQUAD_INVITE.code, at: window.CC_SQUAD_INVITE.at, from: window.CC_SQUAD_INVITE.from.callsign }');
  if (w2carry && w2carry.acct === ME && w2carry.code === 'ZK4P' && w2back && w2back.code === 'ZK4P' && w2back.at === w2at && w2back.from === 'Steel Mule')
    ok(`${V}: an invite that arrived before a reload is offered again after it, to the same account, with its own arrival time`);
  else fail(`${V}: invite carry ${JSON.stringify({ w2carry, w2back, w2at })}`);
  // The page being left writes its OWN carry on pagehide and visibilitychange,
  // so the planted one goes in from listeners registered after bay.js's, which
  // run last.
  const w2try = async (carry) => {
    await ev(`(() => { const put = () => sessionStorage.setItem('cc_squad_invite', ${JSON.stringify(JSON.stringify(carry))});
      window.addEventListener('pagehide', put); document.addEventListener('visibilitychange', put); return true; })()`);
    if (!(await w2load())) return 'no page';
    await stubSocket();
    // Read in the SAME turn as the account event: a stale invite let through
    // would be emptied again by its own zero-length timer a moment later, and a
    // later read could not tell it was ever offered.
    const got = await ev(`(() => { const b = $('accountBtn'); b.classList.remove('hidden'); b.dataset.state = 'in';
      window.CC_ACCOUNT = ${ACC.in}; document.dispatchEvent(new CustomEvent('cc:account')); return window.CC_SQUAD_INVITE; })()`);
    await setWho('in');
    return got;
  };
  const w2other = await w2try({ code: 'ZK4P', from: { callsign: 'Steel Mule' }, size: 2, max: 4, at: Date.now(), acct: W2_MULE });
  const w2old = await w2try({ code: 'ZK4P', from: { callsign: 'Steel Mule' }, size: 2, max: 4, at: Date.now() - 11 * 60 * 1000, acct: ME });
  if (w2other === null && w2old === null)
    ok(`${V}: a carried invite is refused for another account, and once it is older than ten minutes`);
  else fail(`${V}: invite carry guards ${JSON.stringify({ w2other, w2old })}`);

  // ---- W3. A MEMBER'S BOARDS FOLLOW THE SQUAD'S MODE (E3).
  await stubSocket(); await setWho('in'); await w2hello(); await reply({ op: 'gone' });
  // CHANGED (owner, 2026-10-06): golf has no seat count on this client any
  // more, so a golf squad's `max` (an older leader's build may still send one)
  // is not followed; the lit board and the tee set are.
  await ev(`(ccMode = 'duel', ccTees = 'mens', true)`);
  await w2state({ leader: W2_MULE, you: 1, mode: 'golf', tees: 'womens', max: 3,
    members: [w2m(W2_MULE, 'Steel Mule', 'c1'), w2m(ME, 'Dusty Crag', 'a1')] });
  await ev(`(Bay.show('home'), true)`); await sleep(60);
  const w3 = await ev('({ mode: ccMode, tees: ccTees, golfMax: typeof ccGolfMax })');
  if (w3.mode === 'golf' && w3.tees === 'womens' && w3.golfMax === 'undefined')
    ok(`${V}: a member's lit board and tees follow the squad's mode, and a golf seat count is written nowhere`);
  else fail(`${V}: member follows squad ${JSON.stringify(w3)}`);

  // ---- W4. A READY REFUSED 'dropped' SAYS SO (E9), and names no block.
  await clearTx();
  await ev(`(() => { Bay.show('squad'); const b = document.querySelector('#sqWin-squad [data-sq="ready"]'); if (b) { b.removeAttribute('disabled'); b.click(); } return !!b; })()`); await sleep(60);
  const w4sent = (await squads()).filter((f) => f.op === 'ready').length;
  if (w4sent) await reply({ op: 'ready', error: 'dropped' });
  const w4 = await w2pane();
  if (w4sent === 1 && w4.includes('You are reconnecting to the squad. Try again in a moment.') && !/block/i.test(w4))
    ok(`${V}: a Ready refused 'dropped' reads "You are reconnecting to the squad. Try again in a moment."`);
  else fail(`${V}: ready dropped ${JSON.stringify({ w4sent, w4: w4.slice(0, 200) })}`);

  // ---- W5. "You left the squad." IS READ, THEN GOES (E9): five seconds on the
  //      home screen, and it is gone.
  await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(80);
  const w5a = await w2pane();
  await sleep(5400);
  const w5b = await w2pane();
  if (/You left the squad\./.test(w5a) && !/You left the squad\./.test(w5b))
    ok(`${V}: "You left the squad." shows, and is gone five seconds later`);
  else fail(`${V}: left line ${JSON.stringify({ w5a: w5a.slice(0, 120), w5b: w5b.slice(0, 120) })}`);

  // ---- W6. A GUEST'S COUNT IS KNOWN (E9, spec D10): "Squad 0/4". CHANGED BY
  //      U4: the tabs read "0 / 4" and "0"; the box's header reads "Squad
  //      0/4" (owner, 2026-10-06), and a guest's friends part says friends
  //      need an account, with no count to give.
  await stubSocket(); await setWho('guest'); await w2hello();
  const w6 = await ev(`(() => { Bay.show('home'); const h = document.querySelector('#bay .sqx .sqhd'); const c = h && h.querySelector('.sqhc');
    return h ? { head: h.querySelector('.sqhn').textContent, count: c && !c.classList.contains('hidden') ? c.firstElementChild.textContent : null,
      friends: (document.querySelector('#bay .sqx .sqbf') || {}).textContent || '' } : null; })()`);
  if (w6 && w6.head === 'Squad' && w6.count === '0/4' && w6.friends.includes('Sign in to add friends.'))
    ok(`${V}: a guest with no squad sees "Squad 0/4", and that friends need an account`);
  else fail(`${V}: guest counts ${JSON.stringify(w6)}`);

  // ---- W7. INVITE THAT CREATES THE SQUAD SENDS THE LIT BOARD FIRST (B3).
  await stubSocket(); await setWho('in'); await w2hello(); await reply({ op: 'gone' });
  await ev(`(ccMode = 'boss', true)`);
  await ev(`(window.CC_SOCIAL = ${JSON.stringify({ friends: [{ id: W2_MULE, callsign: 'Steel Mule', online: true }], requests: { in: [], out: [] }, blocked: [], friendCode: 'AB12CD', callsign: null })}, document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60);
  // U4: the friend online, and its Invite, are in the home box itself.
  await clearTx();
  await ev(`(() => { Bay.show('home'); const b = document.querySelector('#bay .sqx [data-sq="invite:${W2_MULE}"]'); if (b) b.click(); return !!b; })()`); await sleep(60);
  await reply({ op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true, members: [w2m(ME, 'Dusty Crag', 'a1')], fits: w2fits(1) });
  await sleep(400);
  const w7 = (await squads()).map((f) => f.op + (f.mode ? ':' + f.mode : ''));
  if (w7[0] === 'create' && w7.indexOf('mode:boss') > 0 && w7.indexOf('invite') > w7.indexOf('mode:boss'))
    ok(`${V}: Invite that creates the squad sets the leader's lit board before it invites`);
  else fail(`${V}: create, mode, invite order ${JSON.stringify(w7)}`);
} catch (e) {
  fail('squad_ui fix wave W2 stopped: ' + (e && e.message));
}
// ============================================================================
// U3: THE SQUAD'S READY CONTROL (owner, 2026-10-06). "All players must ready
// up and then the game starts ... easy for new players to pick up on straight
// away ... the launch button greyed out with 0/2 or 1/2 players ready (the
// group size and how many players are ready must be displayed correctly)."
// In a squad of two or more, home's Launch and Match setup's Start Game (with
// Your squad) are the squad's Ready: the count, who it waits for, the
// countdown, and why it cannot start; a squad of one keeps the ordinary
// Launch; a member's boards and tee set are the leader's to change. Every
// roster goes in through the real handle(), every tap through the real
// delegated listener.
if (want('u3')) try {
  const U3_MULE = '00000000-0000-4000-8000-0000000000cc';
  const U3_PIKE = '00000000-0000-4000-8000-0000000000dd';
  const U3_NAMELESS = '00000000-0000-4000-8000-0000000000ee';
  const U3R = (tag) => (tag + '0'.repeat(32)).slice(0, 32);
  const u3m = (id, callsign, rid, o) => Object.assign({ id, rid: U3R(rid), callsign, guest: false, online: true, ready: false, dropped: false }, o);
  const U3YOU = (o) => u3m(ME, 'Dusty Crag', 'a1', o);
  const U3MULE = (o) => u3m(U3_MULE, 'Steel Mule', 'c1', o);
  const U3PIKE = (o) => u3m(U3_PIKE, 'Ridge Pike', 'd1', o);
  const U3GUEST = (o) => u3m(null, null, 'e1', Object.assign({ guest: true }, o));
  const U3NONAME = (o) => u3m(U3_NAMELESS, null, 'f1', o);
  const u3fits = (n) => ({ duel: n === 2, ffa: n >= 2 && n <= 4, boss: n >= 1 && n <= 2, aliens: n >= 1 && n <= 2, golf: n >= 1 && n <= 4 });
  const u3state = async (patch) => {
    const n = (patch.members || []).length;
    await ev(`(handle(Object.assign({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)},
      mode: 'duel', tees: null, max: null, you: 0, held: true, members: [], fits: ${JSON.stringify(u3fits(n))} }, ${JSON.stringify(patch)})), true)`);
    await sleep(80);
  };
  const FIVE3 = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
  // The leader's coalesced mode send waits 250 ms after the last tap
  // (bay.js SQ_MODE_MS); a check that nothing was sent waits past it.
  const MODE_WAIT3 = 450;
  // THE RIBBON'S CONTROL as a player meets it: its two lines, its state class,
  // whether it is live, aria-pressed, the drawn tick, its look (whether its
  // face is the live orange, and its border), and the type in design units.
  // U8's F2 reads the grey itself, stop by stop.
  const u3launch = (sel = '#bay .lbar .launch') => ev(`(() => {
    const b = document.querySelector(${JSON.stringify(sel)});
    if (!b) return null;
    const u = document.querySelector('#bay .stage').getBoundingClientRect().width / 932;
    const t = b.querySelector('.rdyt'), y = b.querySelector('.rdys'), cs = getComputedStyle(b);
    return { label: t ? t.textContent : null, say: y ? y.textContent : null, text: b.textContent.trim(),
      cls: b.className, dis: b.disabled, pressed: b.getAttribute('aria-pressed'), tick: !!(t && t.querySelector('svg')),
      go: b.getAttribute('data-go'), rdy: b.hasAttribute('data-rdy'),
      bg: cs.backgroundImage === 'none' ? cs.backgroundColor : 'gradient', color: cs.color,
      orange: /rgb\\(255, 160, 85\\)/.test(cs.backgroundImage), bw: parseFloat(cs.borderTopWidth) || 0,
      tU: t ? +(parseFloat(getComputedStyle(t).fontSize) / u).toFixed(2) : null, yU: y ? +(parseFloat(getComputedStyle(y).fontSize) / u).toFixed(2) : null };
  })()`);
  const u3home = () => ev(`(Bay.show('home'), true)`);
  // The squad footer's line, which moved from the box into the Manage squad
  // window (U4): read there, then home again, where u3launch reads.
  const u3winLine = () => ev(`(() => { Bay.show('squad'); const t = (document.querySelector('#sqWin-squad .sqft .sqfl') || {}).textContent; Bay.show('home'); return t; })()`);
  const u3tap = async (sel = '#bay .lbar .launch') => { await clearTx(); await click(sel); await sleep(50); return (await squads()).filter((f) => f.op === 'ready'); };
  const u3force = async (sel = '#bay .lbar .launch') => {
    await clearTx();
    await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) { b.removeAttribute('disabled'); b.click(); } return true; })()`);
    await sleep(50);
    return (await squads()).length;
  };

  for (const [w, h] of [[932, 430], [667, 375]]) {
    const V = `${w}x${h}`;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    let u3up = false;
    for (let i = 0; i < 80; i++) {
      if (await ev('!!window.Bay && typeof handle === "function" && !!document.querySelector("#bay .lbar")').catch(() => false)) { u3up = true; break; }
      await sleep(200);
    }
    if (!u3up) { fail(`${V}: page never became ready for the U3 checks`); continue; }
    for (let k = 0; k < 40 && (await ev(`document.getElementById('bay').classList.contains('enter')`)); k++) await sleep(100);
    await ev(`(localStorage.removeItem('cc_squad'), localStorage.setItem('cc_loadout', ${JSON.stringify(JSON.stringify(FIVE3))}), ccMode = 'duel', ccTees = 'mens', true)`);
    await stubSocket(); await setWho('in');
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    await clearTx(); await u3home();

    // ---- U1. THE COUNT AND THE NAMES. The squad's size and how many are
    //      ready, always; who it waits for, "you" first, two names at most and
    //      then "+k"; a guest and a nameless player in words, never "No
    //      callsign". CHANGED BY THE UPDATE 8 REVIEW (owner: "greyed out with
    //      0/2 or 1/2 players ready"): a live grey with a border to ready up,
    //      and the same grey with a drawn tick once ready -- never orange.
    const u1 = {};
    await u3state({ members: [U3YOU(), U3MULE()] });
    u1.two0 = await u3launch();
    await u3state({ members: [U3YOU({ ready: true }), U3MULE()] });
    u1.two1 = await u3launch();
    await u3state({ mode: 'ffa', members: [U3YOU({ ready: true }), U3MULE({ ready: true }), U3PIKE()] });
    u1.three = await u3launch();
    await u3state({ mode: 'ffa', members: [U3YOU(), U3MULE(), U3PIKE(), U3GUEST()] });
    u1.four = await u3launch();
    await u3state({ mode: 'ffa', members: [U3YOU({ ready: true }), U3MULE({ ready: true }), U3GUEST(), U3NONAME()] });
    u1.words = await u3launch();
    const okU1 = u1.two0 && u1.two0.rdy && !u1.two0.go && u1.two0.label === 'Ready up 0/2' && u1.two0.say === 'Waiting for you, Steel Mule'
        && / up\b/.test(u1.two0.cls) && !u1.two0.dis && u1.two0.pressed === 'false' && !u1.two0.tick && !u1.two0.orange && u1.two0.bw >= 1
      && u1.two1 && u1.two1.label === 'Ready 1/2' && u1.two1.say === 'Waiting for Steel Mule' && / on\b/.test(u1.two1.cls) && !u1.two1.dis
        && u1.two1.pressed === 'true' && u1.two1.tick && !u1.two1.orange && u1.two1.bw >= 1
      && u1.three && u1.three.label === 'Ready 2/3' && u1.three.say === 'Waiting for Ridge Pike'
      && u1.four && u1.four.label === 'Ready up 0/4' && u1.four.say === 'Waiting for you, Steel Mule +2'
      && u1.words && u1.words.label === 'Ready 2/4' && u1.words.say === 'Waiting for a guest, a player'
      && [u1.two0, u1.two1, u1.three, u1.four, u1.words].every((x) => x.tU >= 13 && x.yU >= 13);
    if (okU1) ok(`${V}: Launch in a squad reads Ready up 0/2, Ready 1/2, Ready 2/3, Ready up 0/4 and who it waits for -- you first, two names, then +k, a guest and a nameless player in words -- a bordered grey, never orange, to ready up and with a tick once ready, every line at least 13u`);
    else fail(`${V}: ready counts ${JSON.stringify(u1)}`);

    // ---- U2. THE TAP READIES WITH THE RACK; THE NEXT ONE STANDS DOWN. One
    //      frame each, the first carrying the rack and the second none; while
    //      the first is out the control is dead, and the count is still shown.
    await u3state({ members: [U3YOU(), U3MULE({ ready: true })] });
    const u2up = await u3tap();
    const u2busy = await u3launch();
    await reply({ op: 'ready', ok: true });
    await u3state({ members: [U3YOU({ ready: true }), U3MULE()] });
    const u2down = await u3tap();
    await reply({ op: 'ready', ok: true });
    if (u2up.length === 1 && u2up[0].ready === true && JSON.stringify(u2up[0].loadout) === JSON.stringify(FIVE3) && typeof u2up[0].id === 'number'
        && u2busy && u2busy.dis && u2busy.label === 'Ready up 1/2'
        && u2down.length === 1 && u2down[0].ready === false && !('loadout' in u2down[0]))
      ok(`${V}: a tap on Launch readies with the rack, the control is held while it is out and still shows the count, and a tap when ready stands down with no rack`);
    else fail(`${V}: ready taps ${JSON.stringify({ u2up, u2busy, u2down })}`);

    // ---- U3. THE COUNTDOWN, counted from the moment the roster ARRIVED: a
    //      device clock a day out still shows 3, 2, 1. The box's line says it
    //      too. A tap during it stands down; the roster that stops it takes
    //      the countdown off every line.
    //      THE PAGE'S CLOCK IS HELD, AND MOVED BY HAND. The countdown runs on
    //      performance.now(), stamped as the roster arrives (app.js
    //      CC_SQUAD_STARTS). On the real clock, "1" had to be read before
    //      2.5 s while 1980 ms of sleeps and five CDP round trips went by, so
    //      a loaded machine read "Starting" and failed the suite. Held, the
    //      roster arrives at t0 and the clock is set to t0 + 0.9 s and then
    //      t0 + 1.9 s: "2" and "1" exactly, however slow the machine. The
    //      repaint is still the page's own once-a-second tick (bay.js sqTick,
    //      on real timers), so each read waits for the tick to show its step.
    //      The clock is let go only once the roster without a countdown is in.
    const u3hold = await ev(`(() => { const t = performance.now(); window.__u3clock = t; performance.now = () => window.__u3clock; return t; })()`);
    const u3at = async (ms, label) => {
      await ev(`(window.__u3clock = ${u3hold} + ${ms}, true)`);
      for (let k = 0; k < 100 && (await ev(`((document.querySelector('#bay .lbar .launch .rdyt') || {}).textContent || null)`)) !== label; k++) await sleep(50);
      return u3launch();
    };
    let u3a, u3line, u3b, u3c, u3cancel, u3d, u3dline;
    try {
      await ev(`(window.__u3now = Date.now, Date.now = () => window.__u3now() + 86400000, true)`);
      await u3state({ startsIn: 2500, members: [U3YOU({ ready: true }), U3MULE({ ready: true })] });
      u3a = await u3launch();
      await ev(`(Date.now = window.__u3now, true)`);
      u3line = await u3winLine();
      u3b = await u3at(900, 'Starting in 2');
      u3c = await u3at(1900, 'Starting in 1');
      u3cancel = await u3tap();
      await reply({ op: 'ready', ok: true });
      await u3state({ members: [U3YOU(), U3MULE({ ready: true })] });
      u3d = await u3launch(); u3dline = await u3winLine();
    } finally {
      await ev(`(delete performance.now, Date.now = window.__u3now || Date.now, true)`).catch(() => {});
    }
    await sleep(1200);
    const u3e = await u3launch();
    if (u3a && u3a.label === 'Starting in 3' && u3a.say === 'Everyone is ready' && / cd\b/.test(u3a.cls) && !u3a.dis && u3a.orange && u3line === 'Starting in 3'
        && u3b && u3b.label === 'Starting in 2' && u3c && u3c.label === 'Starting in 1'
        && u3cancel.length === 1 && u3cancel[0].ready === false
        && u3d && u3d.label === 'Ready up 1/2' && u3dline === 'Duel · 2' && u3e && u3e.label === 'Ready up 1/2')
      ok(`${V}: everyone ready, Launch counts Starting in 3, 2, 1 from the roster's arrival whatever the device clock says, the window's squad line with it; a tap stands down and the next roster takes the countdown away`);
    else fail(`${V}: countdown ${JSON.stringify({ u3a, u3line, u3b: u3b && u3b.label, u3c: u3c && u3c.label, u3cancel, u3d, u3dline, u3e: u3e && u3e.label })}`);

    // ---- U4. GREY, WITH THE REASON, WHILE THE SQUAD COULD NOT START. Three on
    //      a duel; a member offline; a member reconnecting. Standing UP is
    //      dead -- in the handler too -- and standing down never is.
    const u4 = {};
    await u3state({ members: [U3YOU(), U3MULE({ ready: true }), U3PIKE()] });
    u4.big = await u3launch(); u4.bigSent = await u3force();
    await u3state({ members: [U3YOU(), U3MULE({ online: false })] });
    u4.off = await u3launch(); u4.offSent = await u3force();
    await u3state({ members: [U3YOU(), U3MULE({ ready: true, dropped: true })] });
    u4.drop = await u3launch();
    await u3state({ members: [U3YOU({ ready: true }), U3MULE({ dropped: true })] });
    u4.mine = await u3launch();
    const u4down = await u3tap();
    await reply({ op: 'ready', ok: true });
    if (u4.big && u4.big.dis && u4.big.label === 'Ready up 1/3' && u4.big.say === 'Duel needs 2 players' && u4.big.bg === 'rgb(31, 39, 64)' && u4.bigSent === 0
        && u4.off && u4.off.dis && u4.off.say === 'Steel Mule is offline' && u4.offSent === 0
        && u4.drop && u4.drop.dis && u4.drop.label === 'Ready up 0/2' && u4.drop.say === 'Steel Mule is reconnecting'
        && u4.mine && !u4.mine.dis && u4.mine.label === 'Ready 1/2' && u4.mine.say === 'Steel Mule is reconnecting' && u4down.length === 1 && u4down[0].ready === false)
      ok(`${V}: a squad that cannot start greys Launch out, distinct from orange, saying why -- "Duel needs 2 players", offline, reconnecting -- sends nothing even past the attribute, and a ready player can still stand down`);
    else fail(`${V}: grey with a reason ${JSON.stringify({ u4, u4down })}`);

    // ---- U5. A SQUAD OF ONE IS NO SQUAD: the ordinary Launch, which opens
    //      Match setup and sends the squad nothing.
    await u3state({ mode: 'boss', members: [U3YOU()] });
    const u5 = await u3launch();
    await clearTx(); await click('#bay .lbar .launch'); await sleep(60);
    const u5scr = await ev(`$('bay').dataset.scr`), u5sent = (await squads()).length;
    await u3home();
    if (u5 && u5.text === 'Launch' && u5.go === 'setup' && !u5.rdy && !/\brdy\b/.test(u5.cls) && u5scr === 'setup' && u5sent === 0)
      ok(`${V}: in a squad of one Launch is the ordinary Launch: it opens Match setup and sends the squad nothing`);
    else fail(`${V}: squad of one ${JSON.stringify({ u5, u5scr, u5sent })}`);

    // ---- U6. MATCH SETUP'S START GAME IS THE SAME CONTROL with Your squad, and
    //      playing alone from a squad stands this player down first: Computer,
    //      Start Game, one ready:false and the player's own vs-Computer game.
    await u3state({ leader: U3_MULE, members: [U3YOU({ ready: true }), U3MULE()] });
    await click('#bay .lbar .ros'); await sleep(60);
    const u6sq = await u3launch('#bay .pfoot [data-launch]');
    await click('#bay [data-set="with=cpu"]'); await sleep(40);
    await ev(`(window.__u6sent = [], window.__u6intent = intent, window.intent = (m) => { __u6sent.push(m); }, true)`);
    await clearTx(); await click('#bay .pfoot [data-launch]'); await sleep(50);
    const u6f = (await squads()).filter((f) => f.op === 'ready'), u6ai = await ev('__u6sent.slice()');
    if (u6f.length) await reply({ op: 'ready', ok: true });
    await ev(`(window.intent = window.__u6intent, Bay.show('home'), true)`);
    if (u6sq && u6sq.label === 'Ready 1/2' && u6sq.say === 'Waiting for Steel Mule' && / on\b/.test(u6sq.cls) && u6sq.tU >= 13 && u6sq.yU >= 13
        && u6f.length === 1 && u6f[0].ready === false && u6ai.length === 1 && u6ai[0].type === 'ai')
      ok(`${V}: Start Game with Your squad is the same Ready control, and a member who plays the computer alone is stood down first`);
    else fail(`${V}: setup control ${JSON.stringify({ u6sq, u6f, u6ai })}`);

    // ---- U7. THE SETTINGS ARE THE LEADER'S. A member playing with the squad
    //      is shown the squad's tee set, and a tap on another is explained and
    //      changes nothing; a leader playing golf alone (Solo) changes their
    //      own tee set without touching the squad's.
    await ev(`(window.__u7toast = [], window.__u7st = showToast, window.showToast = (t) => { __u7toast.push(t); }, ccTees = 'mens', true)`);
    await u3state({ leader: U3_MULE, mode: 'golf', tees: 'champ', members: [U3YOU(), U3MULE()] });
    await ev(`(Bay.show('home'), true)`);
    await click('#bay .lbar .ros'); await sleep(60);
    const u7tees = () => ev(`(() => { const o = [...document.querySelectorAll('#bay .b-opt')].find((x) => x.querySelector('.lbl') && x.querySelector('.lbl').textContent === 'Tee set');
      return o ? [...o.querySelectorAll('.seg.on')].map((b) => b.dataset.set).join() : null; })()`);
    // This device's own tee set differs from the squad's while setup is up
    // (home's follow is what set it to the squad's), and the next roster
    // repaints setup in place: the squad's is what it must show.
    await ev(`(ccTees = 'mens', true)`);
    await u3state({ leader: U3_MULE, mode: 'golf', tees: 'champ', members: [U3YOU(), U3MULE()] });
    const u7on = await u7tees();
    await clearTx(); await click('#bay [data-set="tees=junior"]'); await sleep(MODE_WAIT3);
    const u7after = { on: await u7tees(), tees: await ev('ccTees'), said: await ev('__u7toast.slice()'), sent: (await squads()).filter((f) => f.op === 'mode').length };
    await u3state({ mode: 'golf', tees: 'champ', members: [U3YOU(), U3MULE()] });
    await ev(`(Bay.show('home'), true)`);
    await click('#bay .lbar .ros'); await sleep(60);
    await click('#bay [data-set="with=cpu"]'); await sleep(40);
    await clearTx(); await click('#bay [data-set="tees=junior"]'); await sleep(MODE_WAIT3);
    const u7lead = { tees: await ev('ccTees'), sent: (await squads()).filter((f) => f.op === 'mode').length };
    await ev(`(window.showToast = window.__u7st, ccTees = 'mens', Bay.show('home'), true)`);
    if (u7on === 'tees=champ' && u7after.on === 'tees=champ' && u7after.tees === 'mens' && JSON.stringify(u7after.said) === JSON.stringify(['The squad leader picks the tee set.']) && u7after.sent === 0
        && u7lead.tees === 'junior' && u7lead.sent === 0)
      ok(`${V}: a member with the squad sees the squad's tee set and a tap on another is explained and changes nothing; a leader playing alone changes only their own`);
    else fail(`${V}: tee set lock ${JSON.stringify({ u7on, u7after, u7lead })}`);

    // ---- U8. NOTHING SPILLS: four long callsigns waited for, on the longest
    //      mode name, and the ribbon still fits its frame, the second line
    //      ending in an ellipsis rather than pushing the readouts.
    await ev(`(ccMode = 'aliens', true)`);
    await u3state({ mode: 'aliens', fits: { duel: false, ffa: true, boss: false, aliens: true, golf: true },
      members: [U3YOU({ ready: true }), U3MULE({ callsign: 'WWWWWWWWWWWWWWWW' }), U3PIKE({ callsign: 'MMMMMMMMMMMMMMMM' }), U3GUEST()] });
    const u8 = await ev(`(() => { Bay.show('home'); const bar = document.querySelector('#bay .lbar'), b = bar.querySelector('.launch'), r = bar.querySelector('.ros').getBoundingClientRect(),
      br = b.getBoundingClientRect(), bay = document.getElementById('bay');
      return { barOver: bar.scrollWidth > bar.clientWidth + 1, clear: br.left >= r.right, inBar: br.right <= bar.getBoundingClientRect().right + 0.5,
        bayOver: bay.scrollWidth > bay.clientWidth || bay.scrollHeight > bay.clientHeight,
        // The LINES the text is laid out in, read off a Range over it: a block
        // element answers one rect however many lines its text wraps to.
        oneLine: (() => { const y = b.querySelector('.rdys'), rg = document.createRange(); rg.selectNodeContents(y);
          return new Set([...rg.getClientRects()].map((x) => Math.round(x.top))).size === 1; })() }; })()`);
    await ev(`(ccMode = 'duel', true)`);
    if (u8 && !u8.barOver && u8.clear && u8.inBar && !u8.bayOver && u8.oneLine)
      ok(`${V}: four long callsigns waited for on Alien Invasion keep the ribbon inside its frame, the control clear of the readouts and its second line on one line`);
    else fail(`${V}: ribbon fit ${JSON.stringify(u8)}`);
    await u3state({ members: [U3YOU()] });
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), Bay.show('home'), true)`); await sleep(60);
  }
} catch (e) {
  fail('squad_ui U3 stopped: ' + (e && e.message));
}
// ============================================================================
// U4: THE SQUAD BOX AND THE MANAGE SQUAD WINDOW (owner, 2026-10-06). "Replace
// Invite friends with a button that opens a window to manage the squad; the
// main-menu squad box shows only the squad (how many in the party / how many
// it can hold) and the friends online; all text easily legible." The box is
// "Squad N/4" and Manage, each member's name and ready status, the invite just
// received, and the friends online, each with Invite; the window is the code
// with Copy and Share, the code field, the squad with Ready, Leave and the
// leader's Remove, and every friend. The phone sizes the owner reads on:
// 874x402 (iPhone landscape) and 667x375 (the smallest). Every roster goes in
// through the real handle(), every tap through the real delegated listener.
if (want('u4')) try {
  const U4_MULE = '00000000-0000-4000-8000-0000000000cc';
  const U4_PIKE = '00000000-0000-4000-8000-0000000000dd';
  const U4_NIA = '00000000-0000-4000-8000-000000000011';
  const U4_KIT = '00000000-0000-4000-8000-000000000013';
  const U4R = (tag) => (tag + '0'.repeat(32)).slice(0, 32);
  const u4m = (id, callsign, rid, o) => Object.assign({ id, rid: U4R(rid), callsign, guest: false, online: true, ready: false, dropped: false }, o);
  const U4YOU = (o) => u4m(ME, 'Dusty Crag', 'a1', o);
  const U4MULE = (o) => u4m(U4_MULE, 'Steel Mule', 'c1', o);
  const U4PIKE = (o) => u4m(U4_PIKE, 'Ridge Pike', 'd1', o);
  const U4GUEST = (o) => u4m(null, null, 'e1', Object.assign({ guest: true }, o));
  const u4fits = (n) => ({ duel: n === 2, ffa: n >= 2 && n <= 4, boss: n >= 1 && n <= 2, aliens: n >= 1 && n <= 2, golf: n >= 1 && n <= 4 });
  const u4state = async (patch) => {
    const n = (patch.members || []).length;
    await ev(`(handle(Object.assign({ type: 'squad', op: 'state', code: 'QK7T', leader: ${JSON.stringify(ME)},
      mode: 'ffa', tees: null, max: null, you: 0, held: true, members: [], fits: ${JSON.stringify(u4fits(n))} }, ${JSON.stringify(patch)})), true)`);
    await sleep(80);
  };
  // Two friends online and one not, and a request waiting.
  const U4FR = { friends: [{ id: U4_MULE, callsign: 'Steel Mule', online: true }, { id: U4_PIKE, callsign: 'Ridge Pike', online: false },
    { id: U4_NIA, callsign: 'Nia Vale', online: true }], requests: { in: [{ id: U4_KIT, callsign: 'Kit Harrow' }], out: [] },
    blocked: [], friendCode: 'AB12CD', callsign: null };
  const u4friends = async (f) => { await ev(`(window.CC_SOCIAL = ${JSON.stringify(f)}, document.dispatchEvent(new Event('cc:social')), true)`); await sleep(60); };
  // The home box, row by row, and the controls it carries.
  const u4box = () => ev(`(() => {
    Bay.show('home');
    const p = document.querySelector('#bay .sqx'); if (!p) return null;
    const vis = (e) => !!e && !e.closest('.hidden') && e.getClientRects().length > 0;
    const c = p.querySelector('.sqhc'), m = p.querySelector('.sqmg'), fr = p.querySelector('.sqbf');
    const row = (r) => ({ name: r.querySelector('.sqmt').textContent, you: vis(r.querySelector('.sqmy')), lead: vis(r.querySelector('.sql')),
      state: (r.querySelector('.sqr') || { textContent: '' }).textContent, tick: vis(r.querySelector('.sqr.on svg')), menu: vis(r.querySelector('.pmb')),
      inv: (() => { const b = r.querySelector('[data-sq^="invite:"]'); return vis(b) ? { t: b.textContent.trim(), dis: b.disabled, v: b.getAttribute('data-sq') } : null; })() });
    return {
      head: p.querySelector('.sqhn').textContent, count: c && !c.classList.contains('hidden') ? c.firstElementChild.textContent : null,
      manage: m ? { t: m.firstChild.textContent, go: m.getAttribute('data-go'), dis: m.disabled } : null,
      members: [...p.querySelectorAll('.sqml .sqm')].filter(vis).map(row),
      friends: fr ? [...fr.querySelectorAll('.sqm')].filter(vis).map(row) : [],
      fhead: fr && fr.querySelector('.sqh') ? fr.querySelector('.sqh').textContent : null,
      text: p.querySelector('.sqb').innerText.replace(/\\s+/g, ' ').trim(),
      ops: [...p.querySelectorAll('[data-sq]')].filter(vis).map((b) => b.getAttribute('data-sq').split(':')[0]),
      tabs: p.querySelectorAll('[role="tab"], [role="tablist"], [role="tabpanel"]').length,
      field: !!p.querySelector('input'), foot: !!p.querySelector('.sqft'),
      vh: (p.querySelector('.sqhc .sqvh') || {}).textContent || null,
    };
  })()`);
  // EVERY WORD ON SCREEN in a container, by computed font-size in design
  // units: each visible text node is read off its own element. `names` are the
  // player names (.sqmt), which have their own floor.
  const u4type = (sel) => ev(`(() => {
    const u = document.querySelector('#bay .stage').getBoundingClientRect().width / 932;
    const root = document.querySelector(${JSON.stringify(sel)}); if (!root) return null;
    const out = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const e = n.parentElement;
      if (!n.data.trim() || !e || e.closest('.hidden') || !e.getClientRects().length || e.closest('.sqvh')) continue;
      out.push({ t: n.data.trim().slice(0, 24), u: +(parseFloat(getComputedStyle(e).fontSize) / u).toFixed(2), name: !!e.closest('.sqmt') });
    }
    // The code field's own type (its value is not a text node).
    const i = root.querySelector('input');
    if (i && i.getClientRects().length) out.push({ t: 'input', u: +(parseFloat(getComputedStyle(i).fontSize) / u).toFixed(2), name: false });
    return out;
  })()`);
  const u4small = (list) => (list || []).filter((x) => x.u < (x.name ? 15 : 13));

  for (const [w, h] of [[874, 402], [667, 375]]) {
    const V = `${w}x${h}`;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    let u4up = false;
    for (let i = 0; i < 80; i++) {
      if (await ev('!!window.Bay && typeof handle === "function" && !!document.querySelector("#bay .sqx")').catch(() => false)) { u4up = true; break; }
      await sleep(200);
    }
    if (!u4up) { fail(`${V}: page never became ready for the U4 checks`); continue; }
    for (let k = 0; k < 40 && (await ev(`document.getElementById('bay').classList.contains('enter')`)); k++) await sleep(100);
    await ev(`(localStorage.removeItem('cc_squad'), localStorage.setItem('cc_loadout', ${JSON.stringify(JSON.stringify(['mortar', 'cluster', 'napalm', 'airstrike', 'volley']))}), ccMode = 'ffa', true)`);
    await stubSocket(); await setWho('in');
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    await clearTx();

    // ---- N0. AN ACCOUNT CHANGE ALONE REPAINTS THE OPEN WINDOW. With no friends
    //      snapshot, no refusal and no squad standing, a sign-out changes
    //      nothing app.js would announce (no cc:social, no cc:squad): only the
    //      bay's own cc:account listener can turn the window's friends column
    //      into the sign-in offer. Read straight off the DOM.
    await ev(`(Bay.show('squad'), true)`);
    const n0a = await ev(`document.getElementById('sqWin-friends').innerText.replace(/\\s+/g, ' ').trim()`);
    await ev(`(() => { const b = $('accountBtn'); b.dataset.state = 'guest'; window.CC_ACCOUNT = ${GUEST}; document.dispatchEvent(new CustomEvent('cc:account')); return true; })()`);
    await sleep(60);
    const n0b = await ev(`({ scr: document.getElementById('bay').dataset.scr, f: document.getElementById('sqWin-friends').innerText.replace(/\\s+/g, ' ').trim() })`);
    await setWho('in');
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    await clearTx(); await ev(`(Bay.show('home'), true)`);
    if (n0a.startsWith('Not loaded yet.') && n0b.scr === 'squad' && n0b.f.startsWith('Sign in to add friends and keep your progress'))
      ok(`${V}: a sign-out while the window is open repaints it in place, though nothing else announced it`);
    else fail(`${V}: account change on the window ${JSON.stringify({ n0a, n0b })}`);
    await u4friends(U4FR);

    // ---- N1. NO SQUAD: "Squad 0/4" and Manage, "No squad yet.", and the
    //      friends who are online -- only them -- each with a live Invite. No
    //      tabs, no code field, no footer: the box shows the squad and the
    //      friends online and nothing else.
    const n1 = await u4box();
    // And the window's code column, with no squad: no code yet, and what gives
    // one -- an Invite creates the squad.
    const n1code = await ev(`(() => { Bay.show('squad'); const c = document.getElementById('sqWin-code'); const t = { code: c.querySelector('.sqcd').textContent,
      link: c.querySelector('[data-sq="link"]').disabled, note: c.lastElementChild.textContent }; Bay.show('home'); return t; })()`);
    if (n1code.code === '\u2014' && n1code.link === true && n1code.note === 'Your squad gets its code when you invite a friend.'
        && n1 && n1.head === 'Squad' && n1.count === '0/4' && n1.manage && n1.manage.t === 'Manage' && n1.manage.go === 'squad' && !n1.manage.dis
        && n1.text.startsWith('No squad yet.') && n1.members.length === 0
        && n1.fhead === 'Friends online · 2' && JSON.stringify(n1.friends.map((f) => f.name)) === '["Steel Mule","Nia Vale"]'
        && n1.friends.every((f) => f.inv && f.inv.t === 'Invite' && !f.inv.dis && f.menu) && !n1.text.includes('Ridge Pike') && !n1.text.includes('Kit Harrow')
        && n1.tabs === 0 && !n1.field && !n1.foot && n1.vh === ', 0 of 4')
      ok(`${V}: no squad -- the box reads Squad 0/4 with Manage (", 0 of 4" in words for a screen reader), "No squad yet.", and the two friends online with Invite; nobody offline, no request, no tabs, no field, no footer`);
    else fail(`${V}: no-squad box ${JSON.stringify({ n1, n1code })}`);

    // ---- N2. A SQUAD OF ONE TO FOUR: the count and every member's name with
    //      their ready status -- Ready (a drawn tick and the word), Not ready,
    //      Reconnecting -- the leader marked, and NO squad control in the box:
    //      no Ready, Leave, Remove, Copy or code. Each member but you carries
    //      the player menu (design 5.5). CHANGED BY THE UPDATE 8 REVIEW: a
    //      squad of one has no ready status at all, even a Ready left over
    //      (owner: ready-up appears once a second player joins).
    const N2 = [
      [U4YOU({ ready: true })],
      [U4YOU({ ready: true }), U4MULE()],
      [U4YOU(), U4MULE({ ready: true }), U4PIKE({ ready: true, dropped: true })],
      [U4YOU({ ready: true }), U4MULE(), U4PIKE({ ready: true }), U4GUEST({ ready: true })],
    ];
    const n2bad = [];
    for (const members of N2) {
      await u4state({ members });
      const b = await u4box(), n = members.length;
      const want = members.map((m) => (n < 2 ? '' : m.dropped ? 'Reconnecting' : m.ready ? 'Ready' : 'Not ready'));
      const good = b && b.count === n + '/4' && b.members.length === n
        && JSON.stringify(b.members.map((r) => r.name)) === JSON.stringify(members.map((m) => m.callsign || 'No callsign'))
        && JSON.stringify(b.members.map((r) => r.state)) === JSON.stringify(want)
        && b.members.every((r, i) => r.tick === (want[i] === 'Ready')) && b.members[0].you && b.members[0].lead && !b.members.slice(1).some((r) => r.lead)
        && !b.members[0].menu && b.members.slice(1).every((r, i) => r.menu === !!members[i + 1].id)
        && !b.ops.some((o) => ['ready', 'leave', 'kick', 'kok', 'link', 'share', 'code', 'start'].includes(o)) && !b.field && !b.foot;
      if (!good) n2bad.push({ n, b });
    }
    if (!n2bad.length) ok(`${V}: a squad of 1, 2, 3 and 4 reads Squad N/4 with each member's name and, from two up, Ready, Not ready or Reconnecting, the leader marked, and no squad control in the box`);
    else fail(`${V}: squad box ${JSON.stringify(n2bad)}`);

    // ---- N3. THE BOX'S INVITE IS THE WINDOW'S INVITE: the same one frame,
    //      `{type:'squad', op:'invite', to}`, the owner's note under that row
    //      in the box, and Invited until the next roster.
    await u4state({ members: [U4YOU({ ready: true }), U4MULE()] });
    await clearTx(); await click(`#bay .sqx [data-sq="invite:${U4_NIA}"]`); await sleep(50);
    const n3f = await squads();
    await reply({ op: 'invite', ok: true, delivered: 'push' });
    const n3 = await ev(`(() => { const r = document.querySelector('#bay .sqx [data-row="f:${U4_NIA}"]'); const n = r && r.nextElementSibling;
      const b = r && r.querySelector('[data-sq^="invite:"]'); return { line: n && n.classList.contains('sqnt') ? n.textContent : null, btn: b ? [b.textContent.trim(), b.disabled] : null }; })()`);
    if (n3f.length === 1 && JSON.stringify(Object.keys(n3f[0]).sort()) === '["id","op","to","type"]' && n3f[0].op === 'invite' && n3f[0].to === U4_NIA
        && n3.line === "Invite sent to Nia Vale. They'll get a notification." && JSON.stringify(n3.btn) === '["Invited",true]')
      ok(`${V}: Invite in the box sends the one invite frame, says the owner's note under the row and marks the friend Invited`);
    else fail(`${V}: box invite ${JSON.stringify({ n3f, n3 })}`);

    // ---- N4. THE BOX SCROLLS, WITH THE FADE, AND NO ROW IS HIDDEN UNDER A
    //      FOOTER (fix wave B1, U4). Four members and two friends online are
    //      more than 150u: the list scrolls under a header that stays put, the
    //      fade sits at the foot of what is visible, over the rows passing
    //      under it, and at the end of the list it stands in its own strip
    //      below the last row, covering none. It takes no taps.
    await u4state({ members: [U4YOU({ ready: true }), U4MULE(), U4PIKE({ ready: true }), U4GUEST({ ready: true })] });
    const n4 = await ev(`(() => {
      Bay.show('home');
      const l = document.querySelector('#bay .sqx .sqb'), f = l && l.querySelector(':scope > .sqfade'), hd = document.querySelector('#bay .sqx .sqhd');
      if (!l || !f) return null;
      const lr = l.getBoundingClientRect(), h0 = hd.getBoundingClientRect().top;
      const rows = () => [...l.querySelectorAll('.sqm')].map((r) => r.getBoundingClientRect());
      const atRest = f.getBoundingClientRect(), covers = rows().some((r) => r.bottom > atRest.top + 0.5 && r.top < atRest.bottom - 0.5);
      l.scrollTop = l.scrollHeight;
      const end = f.getBoundingClientRect(), last = rows().pop();
      const clear = !rows().some((r) => r.bottom > end.top + 0.5 && r.top < end.bottom - 0.5) && last.bottom <= end.top + 0.5;
      const kept = Math.abs(hd.getBoundingClientRect().top - h0) < 0.5, scrolled = l.scrollTop > 0;
      l.scrollTop = 0;
      return { over: l.scrollHeight > l.clientHeight, foot: Math.abs(atRest.bottom - lr.bottom) < 1.5, covers, clear, kept, scrolled,
        sticky: getComputedStyle(f).position, taps: getComputedStyle(f).pointerEvents, last: l.lastElementChild === f, footer: !!l.querySelector('.sqft') };
    })()`);
    if (n4 && n4.over && n4.scrolled && n4.foot && n4.covers && n4.clear && n4.kept && n4.sticky === 'sticky' && n4.taps === 'none' && n4.last && !n4.footer)
      ok(`${V}: a full squad and the friends online scroll under a fixed header, the fade marks more below and, at the end, covers no row; no footer`);
    else fail(`${V}: box scroll ${JSON.stringify(n4)}`);

    // ---- N5. LEGIBLE ON A PHONE (owner, 2026-10-06: "all text easily
    //      legible"). Every word in the box and in the window is measured by
    //      its computed font-size: names at least 15u, everything else at
    //      least 13u. The busiest states: the box with a full squad, an
    //      invite just received, a refused action and the friends online; the
    //      window as the leader, with requests, every friend and the Remove
    //      question open; a guest's box and window.
    await ev(`(handle({ type: 'squad', op: 'invited', code: 'RM4P', from: { callsign: 'Ridge Pike' }, size: 2, max: 4 }), true)`); await sleep(60);
    await ev(`(handle({ type: 'squad', op: 'start', error: 'member_busy', at: 1 }), true)`); await sleep(60);
    const n5 = {};
    n5.box = await ev(`(Bay.show('home'), true)`).then(() => u4type('#bay .sqx'));
    await ev(`(Bay.show('squad'), true)`);
    n5.win = await u4type('#bay .pbody');
    await click(`#bay [data-sq="kick:${U4R('c1')}"]`); await sleep(40);
    n5.ask = await u4type('#sqWin-squad .sqft');
    await click('#bay [data-sq="kcancel"]'); await sleep(40);
    await setWho('guest');
    n5.guestWin = await u4type('#bay .pbody');
    n5.guestBox = await ev(`(Bay.show('home'), true)`).then(() => u4type('#bay .sqx'));
    await setWho('in');
    const n5names = (n5.box || []).filter((x) => x.name).length, n5small = Object.fromEntries(Object.entries(n5).map(([k, v]) => [k, v ? u4small(v) : null]));
    if (Object.values(n5).every((v) => Array.isArray(v) && v.length > 0) && Object.values(n5small).every((v) => v && v.length === 0) && n5names >= 4
        && (n5.ask || []).some((x) => x.t.startsWith('Remove Steel Mule')))
      ok(`${V}: every word in the box and the window is at least 13u and every name at least 15u -- the full box, the leader's window, the Remove question, and a guest's`);
    else fail(`${V}: type below the floor ${JSON.stringify(n5small)} (names in the box: ${n5names})`);

    // ---- N6. A JOIN BY LINK LANDS WHERE THE SQUAD IS SHOWN (U4): a ?squad=
    //      link, or the notification tap an invite sends, joins and takes the
    //      bay home, where the box draws the squad and the ribbon is its Ready.
    //      Not from the Manage squad window, which draws it already, and not
    //      on a refusal, which is said in a toast where the player is.
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(60);
    // The page's own socket opened at boot, which is what lets a tap go at
    // once (app.js wsOpened); set here as well, so the check never depends on
    // how fast that socket opened before the stub replaced it.
    await ev(`(wsOpened = true, window.__u4toast = [], window.__u4st = window.showToast, window.showToast = (t) => { window.__u4toast.push(t); }, true)`);
    const land = async (from, answer) => {
      await ev(`(Bay.go(${JSON.stringify(from)}), true)`); await sleep(40);
      await clearTx(); await ev(`(onPushTap('/?squad=QK7T'), true)`); await sleep(60);
      const j = (await squads()).filter((f) => f.op === 'join');
      await reply(answer);
      return { sent: j.length, code: j[0] && j[0].code, scr: await ev(`document.getElementById('bay').dataset.scr`) };
    };
    const ROSTER = { op: 'state', code: 'QK7T', leader: U4_MULE, mode: 'ffa', tees: null, max: null, you: 1, held: true,
      members: [U4MULE({ ready: true }), U4YOU()], fits: u4fits(2) };
    const n6 = {};
    n6.career = await land('career', ROSTER);
    n6.box = await u4box();
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(60);
    n6.armoury = await land('armoury', ROSTER);
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(60);
    n6.window = await land('squad', ROSTER);
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(60);
    n6.refused = await land('career', { op: 'join', error: 'no_such_squad' });
    n6.said = await ev('window.__u4toast.slice()');
    await ev(`(window.showToast = window.__u4st, Bay.show('home'), true)`);
    if (n6.career.sent === 1 && n6.career.code === 'QK7T' && n6.career.scr === 'home'
        && n6.box && n6.box.count === '2/4' && n6.box.members.length === 2
        && n6.armoury.sent === 1 && n6.armoury.scr === 'home' && n6.window.sent === 1 && n6.window.scr === 'squad'
        && n6.refused.sent === 1 && n6.refused.scr === 'career' && n6.said.includes('No squad with that code.'))
      ok(`${V}: a squad link's join lands home, where the box shows the squad -- from the record or the Armoury; the window keeps its place, and a refusal stays put and says why`);
    else fail(`${V}: link landing ${JSON.stringify(n6)}`);

    // ---- N7. THE WINDOW FOLLOWS WHAT THE BOX FOLLOWS, IN PLACE: its title
    //      line says the squad and its mode; an account change repaints it
    //      while it is open (cc:account), as a friends snapshot does
    //      (cc:social); the field is named for a screen reader as a squad
    //      code. A line about an action on a friend who is offline belongs
    //      under that friend's row in the window, and is not left at the foot
    //      of the box, which does not list them.
    await u4friends(U4FR);                          // N5's account changes dropped the snapshot
    await u4state({ members: [U4YOU({ ready: true }), U4MULE()] });
    await ev(`(Bay.show('squad'), true)`);
    const n7a = await ev(`({ sub: document.querySelector('#bay .phead .ps').textContent, label: document.getElementById('sqCode').getAttribute('aria-label') })`);
    // A roster pushed while the window is open repaints it IN PLACE: read
    // straight off the DOM, with no render of the test's own.
    await u4state({ members: [U4YOU({ ready: true }), U4MULE(), U4PIKE()] });
    const n7push = await ev(`({ scr: document.getElementById('bay').dataset.scr, rows: [...document.querySelectorAll('#sqWin-squad .sqml .sqmt')].map((e) => e.textContent),
      sub: document.querySelector('#bay .phead .ps').textContent })`);
    await u4state({ members: [U4YOU({ ready: true }), U4MULE()] });
    await clearTx(); await click(`#sqWin-friends [data-sq="invite:${U4_PIKE}"]`); await sleep(40);
    await reply({ op: 'invite', ok: true, delivered: 'none' });
    const n7line = await ev(`(() => { const r = document.querySelector('#sqWin-friends [data-row="f:${U4_PIKE}"]'), n = r && r.nextElementSibling; return n ? n.textContent : null; })()`);
    const n7box = await u4box();
    await ev(`(Bay.show('squad'), true)`);
    await setWho('guest');
    const n7guest = await ev(`document.getElementById('sqWin-friends').innerText.replace(/\\s+/g, ' ').trim()`);
    await setWho('in'); await u4friends(U4FR);
    if (n7a.sub === 'Squad 2/4 \u00b7 Free-for-all' && n7a.label === 'Squad code'
        && n7push.scr === 'squad' && JSON.stringify(n7push.rows) === '["Dusty Crag","Steel Mule","Ridge Pike"]' && n7push.sub === 'Squad 3/4 \u00b7 Free-for-all'
        && n7line === "Ridge Pike is offline and can't be notified. Share your squad code instead."
        && n7box && !n7box.text.includes('Ridge Pike') && !n7box.text.includes('offline and can')
        && n7guest.startsWith('Sign in to add friends'))
      ok(`${V}: the window's title line names the squad and its mode, the field is a squad code, a roster push and an account change repaint the open window, and a line about an offline friend stays in the window`);
    else fail(`${V}: window follows ${JSON.stringify({ n7a, n7push, n7line, box: n7box && n7box.text, n7guest })}`);

    // ---- N8. A START REFUSED WHILE THE WINDOW IS OPEN is said on its action
    //      line and on the ready control, and is no toast: the window is
    //      where the squad is shown, as home is (U3's cc:squadrefused).
    await u4state({ members: [U4YOU({ ready: true }), U4MULE({ ready: true })] });
    await ev(`(Bay.show('squad'), window.__u4toast = [], window.__u4st = window.showToast, window.showToast = (t) => { window.__u4toast.push(t); }, true)`);
    await ev(`(handle({ type: 'squad', op: 'start', error: 'capacity' }), true)`); await sleep(60);
    const n8 = await ev(`(() => { const e = document.querySelector('#sqWin-squad .sqml ~ .sqae'); return { line: e && !e.classList.contains('hidden') ? e.textContent : '', toasts: window.__u4toast.slice() }; })()`);
    await ev(`(window.showToast = window.__u4st, true)`);
    if (n8.line === 'The server is at capacity. Try again shortly.' && n8.toasts.length === 0)
      ok(`${V}: a start refused while the window is open is said on its action line, not in a toast`);
    else fail(`${V}: refusal in the window ${JSON.stringify(n8)}`);
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), Bay.show('home'), true)`); await sleep(60);
  }
} catch (e) {
  fail('squad_ui U4 stopped: ' + (e && e.message));
}
// ============================================================================
// U8: THE UPDATE 8 REVIEW'S CLIENT FIXES (2026-10-06), each where a player
// meets it, at the phone sizes the owner reads on (874x402, 667x375):
//   F1  a member's Match setup and Armoury follow a leader's change of mode
//       or tee set at once -- the push alone repaints them -- and a Ready
//       never readies anyone for a mode their screen is not showing, member
//       or leader;
//   F2  "the launch button greyed out with 0/2 or 1/2 players ready" (owner):
//       the ribbon's Launch and setup's Start Game are a live GREY while
//       anyone is still to ready -- a button, with a border and the count --
//       and the live ORANGE only for the countdown; a control that cannot
//       ready is the dead grey, distinct from both. Read off computed style;
//   F3  offline, a remembered squad is no squad: the ordinary Launch,
//       Computer on setup, Your squad dead with "Needs a connection", the
//       offline game one tap away, no squad pills; and the squad is back the
//       moment the socket is, a member's offline mode with it -- through
//       app.js's own ws.onclose and ws.onopen, on a stand-in socket;
//   F5  a squad of one shows no ready-up state: nothing under your name but
//       Leader, no Ready in the window; and a Ready left over from a bigger
//       squad is stood down when the player starts a game alone;
//   F6  the window's dead Copy and Share look dead;
//   F7  the field manual's player counts are the modes' own (golf 1-4).
if (want('u8')) try {
  const U8_MULE = '00000000-0000-4000-8000-0000000000cc';
  const U8_PIKE = '00000000-0000-4000-8000-0000000000dd';
  const U8R = (tag) => (tag + '0'.repeat(32)).slice(0, 32);
  const u8m = (id, callsign, rid, o) => Object.assign({ id, rid: U8R(rid), callsign, guest: false, online: true, ready: false, dropped: false }, o);
  const U8YOU = (o) => u8m(ME, 'Dusty Crag', 'a1', o);
  const U8MULE = (o) => u8m(U8_MULE, 'Steel Mule', 'c1', o);
  const U8PIKE = (o) => u8m(U8_PIKE, 'Ridge Pike', 'd1', o);
  const u8fits = (n) => ({ duel: n === 2, ffa: n >= 2 && n <= 4, boss: n >= 1 && n <= 2, aliens: n >= 1 && n <= 2, golf: n >= 1 && n <= 4 });
  const U8BASE = (patch) => Object.assign({ type: 'squad', op: 'state', code: 'QK7T', leader: ME, mode: 'duel', tees: null, max: null, you: 0, held: true,
    members: [], fits: u8fits((patch.members || []).length) }, patch);
  // A roster PUSHED, as the server sends one whenever somebody else acts: no
  // request id, straight into the real handle().
  const u8state = async (patch) => { await ev(`(handle(${JSON.stringify(U8BASE(patch))}), true)`); await sleep(80); };
  // Past bay.js's SQ_MODE_MS (250 ms), the wait before a leader's mode goes.
  const MODE_WAIT8 = 450;
  // Past Match setup's .go transition (.15s on every property): a control
  // repainted in place is read once it has finished changing colour.
  const SETTLE8 = 250;
  const FIVE8 = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];
  const vis8 = `((e) => !!e && !e.closest('.hidden') && e.getClientRects().length > 0)`;
  const readyFrames = async () => (await squads()).filter((f) => f.op === 'ready');

  // A READY CONTROL'S LOOK, off its computed style: every colour its face is
  // painted with (the gradient's stops, or the flat colour), its border, its
  // type's contrast against the face, its cursor and whether it is live.
  //   orange  the live orange, #ffa055 at the top of the gradient
  //   grey    every stop a grey (channels within 40 of each other), a border
  //           of 1px or more in a light colour, type at 4.5:1 or better, a
  //           pointer, and live: the button to tap
  //   dead    the disabled grey #1f2740: no border, not-allowed, disabled
  const u8look = (sel) => ev(`(() => {
    const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null;
    const cs = getComputedStyle(b);
    const cols = (s) => (s.match(/rgba?\\([^)]*\\)/g) || []).map((c) => c.match(/[\\d.]+/g).map(Number));
    const img = cs.backgroundImage, face = img !== 'none' ? cols(img) : cols(cs.backgroundColor);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const fg = cols(cs.color)[0], bc = cols(cs.borderTopColor)[0], bw = parseFloat(cs.borderTopWidth) || 0;
    const ratio = Math.min(...face.map((c) => { const a = lum(fg), z = lum(c); return (Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05); }));
    const greyFace = face.length > 0 && face.every((c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) <= 40);
    const t = b.querySelector('.rdyt'), y = b.querySelector('.rdys');
    const look = /rgb\\(255, 160, 85\\)/.test(img) ? 'orange'
      : greyFace && b.disabled && bw === 0 && cs.cursor === 'not-allowed' && cs.backgroundColor === 'rgb(31, 39, 64)' ? 'dead'
      : greyFace && !b.disabled && bw >= 1 && !!bc && lum(bc) >= 0.25 && ratio >= 4.5 && cs.cursor === 'pointer' ? 'grey'
      : 'other';
    return { look, label: t ? t.textContent : b.textContent.trim(), say: y ? y.textContent : null, tick: !!(t && t.querySelector('svg')),
      dis: b.disabled, face: img !== 'none' ? img : cs.backgroundColor, bw, ratio: +ratio.toFixed(2), cursor: cs.cursor };
  })()`);
  // MATCH SETUP as a player reads it: the title, the armed mode, the brief's
  // draft or clubs, the rack's slots, the Play with and Tee set choices, and
  // what Start Game says. Read straight off the DOM, never rendered here.
  const u8setup = () => ev(`(() => {
    const q = (s) => document.querySelector(s);
    const brow = (k) => { const r = [...document.querySelectorAll('#bay .brief .brow')].find((x) => x.querySelector('.lbl').textContent === k); return r ? r.querySelector('b').textContent : null; };
    const opt = (k) => { const o = [...document.querySelectorAll('#bay .b-opt')].find((x) => x.querySelector('.lbl') && x.querySelector('.lbl').textContent === k);
      return o && !o.classList.contains('hidden') ? [...o.querySelectorAll('.seg.on')].map((b) => b.dataset.set).join() : null; };
    const why = (k) => { const o = [...document.querySelectorAll('#bay .b-opt')].find((x) => x.querySelector('.lbl') && x.querySelector('.lbl').textContent === k);
      const b = o && o.querySelector('.seg[data-set="with=squad"]'); return b ? { dis: b.disabled, why: (b.querySelector('.b-why') || { textContent: null }).textContent } : null; };
    const r = q('#bay .pfoot [data-launch]'), t = r && r.querySelector('.rdyt');
    return { scr: $('bay').dataset.scr, title: (q('#bay .phead .pt') || {}).textContent, armed: Bay.state().mode.id,
      draft: brow('Weapons to draft'), clubs: brow('Clubs in the bag'), slots: document.querySelectorAll('#bay .card .slots .slot').length,
      with: opt('Play with'), squad: why('Play with'), tees: opt('Tee set'),
      start: r ? { text: t ? t.textContent : r.textContent.trim(), rdy: r.classList.contains('rdy'), dis: r.disabled } : null };
  })()`);
  // The ARMOURY, the same way.
  const u8arm = () => ev(`({ scr: $('bay').dataset.scr, meta: (document.querySelector('#bay .pm') || {}).textContent,
    title: (document.querySelector('#bay .phead .pt') || {}).textContent, slots: document.querySelectorAll('#bay .card .slots .slot').length,
    armed: Bay.state().mode.id })`);
  // HOME's ribbon and boards, read where they stand.
  const u8ribbon = () => ev(`(() => { const l = document.querySelector('#bay .lbar .launch');
    return { scr: $('bay').dataset.scr, text: l ? l.textContent.trim() : null, go: l && l.getAttribute('data-go'), rdy: !!(l && l.classList.contains('rdy')), dis: !!(l && l.disabled),
      players: (document.querySelector('#bay .lbar .ros .rv') || {}).textContent, pills: document.querySelectorAll('#bay .board .bnf').length,
      nofit: document.querySelectorAll('#bay .board.nofit').length, armed: Bay.state().mode.id }; })()`);
  // A squad's rows, in the box or the window: each name, Leader or not, the
  // ready word, and everything on the row's second line.
  const u8rows = (sel) => ev(`[...document.querySelectorAll(${JSON.stringify(sel + ' .sqml .sqm')})].filter(${vis8}).map((r) => ({
    name: r.querySelector('.sqmt').textContent, lead: ${vis8}(r.querySelector('.sql')), state: (r.querySelector('.sqr') || { textContent: '' }).textContent,
    line: r.querySelector('.sqm2').innerText.replace(/\\s+/g, ' ').trim() }))`);
  // The socket goes and comes back through app.js's OWN handlers, on a
  // stand-in socket that connect() builds: ws.onclose flips S.connected and
  // dispatches cc:social on a real transition; ws.onopen sets it, dispatches
  // cc:social and sends the hello, which asks the squad again. connect() is
  // stubbed for the retry loop (stubSocket), and only __connect builds one.
  const u8sock = (open) => ev(`(() => {
    const Real = window.WebSocket;
    window.WebSocket = function () { this.readyState = 0; this.send = (s) => window.__tx.push(JSON.parse(s)); this.close = () => {}; };
    try { S.ws.readyState = 3; window.__connect(); } finally { window.WebSocket = Real; }
    if (${open}) { S.ws.readyState = 1; S.ws.onopen(); }
    else { S.connected = true; S.ws.readyState = 3; S.ws.onclose(); }
    return { connected: S.connected, ready: S.ws.readyState };
  })()`);

  for (const [w, h] of [[874, 402], [667, 375]]) {
    const V = `${w}x${h}`;
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
    let u8up = false;
    for (let i = 0; i < 80; i++) {
      if (await ev('!!window.Bay && typeof handle === "function" && !!document.querySelector("#bay .lbar")').catch(() => false)) { u8up = true; break; }
      await sleep(200);
    }
    if (!u8up) { fail(`${V}: page never became ready for the U8 checks`); continue; }
    for (let k = 0; k < 40 && (await ev(`document.getElementById('bay').classList.contains('enter')`)); k++) await sleep(100);
    await ev(`(localStorage.removeItem('cc_squad'), localStorage.setItem('cc_loadout', ${JSON.stringify(JSON.stringify(FIVE8))}), ccMode = 'duel', ccTees = 'mens', ccMax = 4, true)`);
    await stubSocket(); await setWho('in');
    await clearTx(); await ev('sendHello(S.ws).then(() => true)'); await sleep(60);
    await reply({ op: 'gone' });
    await clearTx(); await ev(`(Bay.show('home'), true)`);

    // ---- F7. THE FIELD MANUAL'S PLAYER COUNTS ARE THE MODES' OWN: each
    //      mode card's count, en dash and "players" aside, is the bay's mode
    //      table's -- Artillery Golf seats one to four, not "1-2 players".
    const f7 = await ev(`(() => {
      const cards = [...document.querySelectorAll('#helpModal .hm-card .hm-top')].map((t) => ({ name: t.querySelector('b').textContent, n: t.querySelector('i').textContent }));
      return { cards, modes: Bay.MODES.map((m) => ({ name: m.name, players: m.players })) };
    })()`);
    const f7bad = f7.modes.filter((m) => { const c = f7.cards.find((x) => x.name === m.name); return !c || c.n.replace(/\u2013/g, '-').replace(/ players$/, '') !== m.players; });
    if (f7.cards.length === 5 && f7bad.length === 0 && f7.cards.some((c) => c.name === 'Artillery Golf' && c.n === '1\u20134 players'))
      ok(`${V}: the field manual's five mode cards give each mode's own player count -- Artillery Golf 1\u20134 players`);
    else fail(`${V}: field manual counts ${JSON.stringify({ f7bad, cards: f7.cards })}`);

    // ---- F2. GREY UNTIL EVERYONE IS READY. This player leads a squad of two
    //      on Duel: home's ribbon at 0/2 and 1/2, the countdown, and a member
    //      offline; then Match setup's Start Game, with Your squad, the same.
    const f2 = {};
    const f2read = async (sel, key) => {
      await u8state({ members: [U8YOU(), U8MULE()] }); await sleep(SETTLE8);
      f2[key + '0'] = await u8look(sel);
      await u8state({ members: [U8YOU({ ready: true }), U8MULE()] }); await sleep(SETTLE8);
      f2[key + '1'] = await u8look(sel);
      // THE PAGE'S CLOCK IS HELD FOR THE COUNTDOWN'S READ, as U3 holds it.
      // The countdown runs on performance.now(), stamped as the roster
      // arrives (app.js CC_SQUAD_STARTS), and "Starting in 3" lasts one
      // second: on the real clock the 80 ms after the roster, SETTLE8's
      // 250 ms and the CDP round trips left about 650 ms of slack, so a
      // loaded machine read "Starting in 2". Held, the roster lands and is
      // read at t0, however slow the machine; the colour transition SETTLE8
      // waits out runs on the browser's own clock, which replacing the
      // page's performance.now does not touch. Let go in a finally, before
      // the roster that ends the countdown.
      await ev(`(window.__f2clock = performance.now(), performance.now = () => window.__f2clock, true)`);
      try {
        await u8state({ startsIn: 3000, members: [U8YOU({ ready: true }), U8MULE({ ready: true })] }); await sleep(SETTLE8);
        f2[key + '2'] = await u8look(sel);
      } finally {
        await ev(`(delete performance.now, true)`).catch(() => {});
      }
      await u8state({ members: [U8YOU(), U8MULE({ online: false })] }); await sleep(SETTLE8);
      f2[key + 'X'] = await u8look(sel);
      await u8state({ members: [U8YOU(), U8MULE()] });
    };
    await f2read('#bay .lbar .launch', 'home');
    await click('#bay .lbar .ros'); await sleep(80);
    f2.setupScr = await ev(`$('bay').dataset.scr`);
    await f2read('#bay .pfoot [data-launch]', 'setup');
    await ev(`(Bay.show('home'), true)`);
    const f2ok = (k) => {
      const a = f2[k + '0'], b = f2[k + '1'], c = f2[k + '2'], x = f2[k + 'X'];
      return a && a.look === 'grey' && a.label === 'Ready up 0/2' && a.say === 'Waiting for you, Steel Mule' && !a.tick
        && b && b.look === 'grey' && b.label === 'Ready 1/2' && b.say === 'Waiting for Steel Mule' && b.tick
        && c && c.look === 'orange' && c.label === 'Starting in 3' && c.say === 'Everyone is ready'
        && x && x.look === 'dead' && x.label === 'Ready up 0/2' && x.say === 'Steel Mule is offline'
        && a.face !== x.face;
    };
    if (f2ok('home') && f2.setupScr === 'setup' && f2ok('setup'))
      ok(`${V}: Launch and Start Game are a live grey with a border at Ready up 0/2 and Ready 1/2 (tick), type ${f2.home0.ratio}:1, orange only for Starting in 3, and the dead grey while a member is offline`);
    else fail(`${V}: ready colours ${JSON.stringify(f2)}`);

    // ---- F1. A MEMBER'S MATCH SETUP FOLLOWS THE SQUAD. Steel Mule leads on
    //      Duel and this player opens setup through the readouts, on Your
    //      squad. The leader picks Boss Fight: the push alone puts setup on
    //      Boss Fight -- title, draft, seven slots -- and Ready readies with
    //      the seven-weapon rack the screen shows. Then golf, and its tee set.
    await u8state({ leader: U8_MULE, members: [U8YOU(), U8MULE()] });
    await ev(`(ccMode = 'duel', Bay.show('home'), true)`);
    await click('#bay .lbar .ros'); await sleep(80);
    const f1a = await u8setup();
    await u8state({ leader: U8_MULE, mode: 'boss', members: [U8YOU(), U8MULE()] });
    const f1b = await u8setup();
    await clearTx(); await click('#bay .pfoot [data-launch]'); await sleep(60);
    const f1tap = await readyFrames();
    if (f1tap.length) await reply({ op: 'ready', ok: true });
    await u8state({ leader: U8_MULE, mode: 'golf', tees: 'champ', members: [U8YOU(), U8MULE()] });
    const f1c = await u8setup();
    await u8state({ leader: U8_MULE, mode: 'golf', tees: 'junior', members: [U8YOU(), U8MULE()] });
    const f1d = await u8setup();
    const r7 = f1tap[0] && f1tap[0].loadout;
    if (f1a.scr === 'setup' && f1a.title === 'Duel' && f1a.armed === 'duel' && f1a.draft === '5' && f1a.slots === 5 && f1a.with === 'with=squad'
        && f1b.scr === 'setup' && f1b.title === 'Boss Fight' && f1b.armed === 'boss' && f1b.draft === '7' && f1b.slots === 7 && f1b.with === 'with=squad'
        && f1b.start && f1b.start.text === 'Ready up 0/2'
        && f1tap.length === 1 && f1tap[0].ready === true && Array.isArray(r7) && r7.length === 7 && new Set(r7).size === 7
        && f1c.title === 'Artillery Golf' && f1c.armed === 'golf' && f1c.clubs === '4' && f1c.draft === null && f1c.tees === 'tees=champ'
        && f1d.title === 'Artillery Golf' && f1d.tees === 'tees=junior')
      ok(`${V}: a member's open Match setup follows the leader -- Duel to Boss Fight with seven slots, then golf and each tee set -- and its Ready readies with the seven-weapon rack it shows`);
    else fail(`${V}: member setup follows ${JSON.stringify({ f1a, f1b, f1tap, f1c, f1d })}`);

    // ---- F1, THE ARMOURY reached from that setup's Edit: Duel's five slots,
    //      Boss Fight's seven the moment the leader picks it, and golf's bag
    //      when golf is picked; Done goes back to a setup that says golf.
    await u8state({ leader: U8_MULE, mode: 'duel', members: [U8YOU(), U8MULE()] });
    await ev(`(Bay.show('home'), true)`);
    await click('#bay .lbar .ros'); await sleep(60);
    await click('#bay .card [data-go="armoury"]'); await sleep(80);
    const f1e = await u8arm();
    await u8state({ leader: U8_MULE, mode: 'boss', members: [U8YOU(), U8MULE()] });
    const f1f = await u8arm();
    await u8state({ leader: U8_MULE, mode: 'golf', tees: 'mens', members: [U8YOU(), U8MULE()] });
    const f1g = await u8arm();
    await click('#bay .pfoot [data-back]'); await sleep(80);
    const f1h = await u8setup();
    if (f1e.scr === 'armoury' && f1e.meta === 'Your rack' && f1e.slots === 5
        && f1f.scr === 'armoury' && f1f.meta === 'Your rack' && f1f.slots === 7 && f1f.armed === 'boss'
        && f1g.scr === 'armoury' && f1g.title === 'Golf bag' && f1g.meta === 'No draft' && f1g.armed === 'golf'
        && f1h.scr === 'setup' && f1h.title === 'Artillery Golf')
      ok(`${V}: a member's open Armoury follows the leader too -- five slots, then seven, then golf's bag -- and Done goes back to a setup on golf`);
    else fail(`${V}: member armoury follows ${JSON.stringify({ f1e, f1f, f1g, f1h })}`);

    // ---- F1, THE LAST WORD. A Ready never readies for a mode the screen is
    //      not showing. The squad's slot moves to Boss Fight with no event, so
    //      setup still says Duel: the tap readies nobody and puts the screen
    //      on Boss Fight, and the next tap readies with its seven. A LEADER's
    //      tap between a board and its mode frame readies nobody either: it
    //      puts the mode to the squad, one frame, and nothing else -- and so
    //      does a leader's tap after the squad refused that mode, which puts
    //      it again.
    await u8state({ leader: U8_MULE, mode: 'duel', members: [U8YOU(), U8MULE()] });
    await ev(`(Bay.show('home'), true)`);
    await click('#bay .lbar .ros'); await sleep(60);
    await ev(`(window.CC_SQUAD = Object.assign({}, window.CC_SQUAD, { mode: 'boss' }), true)`);
    const f1i0 = await u8setup();
    await clearTx(); await click('#bay .pfoot [data-launch]'); await sleep(60);
    const f1i = { sent: (await readyFrames()).length, after: await u8setup() };
    if (f1i.sent) await reply({ op: 'ready', ok: true });
    await clearTx(); await click('#bay .pfoot [data-launch]'); await sleep(60);
    const f1j = await readyFrames();
    if (f1j.length) await reply({ op: 'ready', ok: true });
    await u8state({ members: [U8YOU(), U8MULE()] });
    await ev(`(ccMode = 'duel', Bay.show('home'), true)`);
    await clearTx();
    await ev(`(() => { [...document.querySelectorAll('#bay .board')].find((b) => b.getAttribute('data-set') === 'mode=boss').click();
      document.querySelector('#bay .lbar .launch').click(); return true; })()`);
    await sleep(MODE_WAIT8);
    const ops8 = async () => (await squads()).map((f) => f.op + (f.op === 'mode' ? ':' + f.mode : ''));
    const f1k = await ops8();
    if (f1k.includes('mode:boss')) await reply({ op: 'mode', ok: true });
    await u8state({ mode: 'boss', members: [U8YOU(), U8MULE()] });
    await ev(`(ccMode = 'duel', true)`);
    await u8state({ members: [U8YOU(), U8MULE()] });
    await ev(`(Bay.show('home'), true)`);
    await clearTx();
    await ev(`[...document.querySelectorAll('#bay .board')].find((b) => b.getAttribute('data-set') === 'mode=boss').click()`);
    await sleep(MODE_WAIT8);
    const f1l0 = await ops8();
    if (f1l0.length) await reply({ op: 'mode', error: 'slow_down' });
    await clearTx(); await click('#bay .lbar .launch'); await sleep(MODE_WAIT8);
    const f1l = await ops8();
    if (f1l.includes('mode:boss')) await reply({ op: 'mode', ok: true });
    else if (f1l.includes('ready')) await reply({ op: 'ready', ok: true });
    await u8state({ mode: 'boss', members: [U8YOU(), U8MULE()] });
    await ev(`(ccMode = 'duel', true)`);
    await u8state({ members: [U8YOU(), U8MULE()] });
    if (f1i0.title === 'Duel' && f1i.sent === 0 && f1i.after.title === 'Boss Fight' && f1i.after.armed === 'boss'
        && f1j.length === 1 && Array.isArray(f1j[0].loadout) && f1j[0].loadout.length === 7
        && JSON.stringify(f1k) === '["mode:boss"]' && JSON.stringify(f1l0) === '["mode:boss"]' && JSON.stringify(f1l) === '["mode:boss"]')
      ok(`${V}: a Ready under a screen that is not on the squad's mode readies nobody and puts the screen right; a leader's Ready while their mode is on its way, or after the squad refused it, sends the mode and nothing else`);
    else fail(`${V}: ready for the mode on screen ${JSON.stringify({ f1i0, f1i, f1j, f1k, f1l0, f1l })}`);

    // ---- F5. A SQUAD OF ONE SHOWS NO READY-UP STATE: this player alone,
    //      still ready from a squad that shrank around them. Nothing under
    //      their name but Leader, in the box and the window, and no Ready in
    //      the window's footer. Starting a game alone stands that Ready down
    //      first. A second player brings every ready word back.
    await u8state({ members: [U8YOU({ ready: true })] });
    await ev(`(Bay.show('home'), true)`);
    const f5 = { box: await u8rows('#bay .sqx'), boxText: await ev(`document.querySelector('#bay .sqx .sqb').innerText.replace(/\\s+/g, ' ')`) };
    await ev(`(Bay.show('squad'), true)`);
    f5.win = await u8rows('#sqWin-squad');
    f5.foot = await ev(`[...document.querySelectorAll('#sqWin-squad .sqft button')].filter(${vis8}).map((b) => b.getAttribute('data-sq'))`);
    await ev(`(Bay.show('home'), true)`);
    await click('#bay .lbar .launch'); await sleep(60);
    f5.setup = await u8setup();
    await ev(`(window.__u8sent = [], window.__u8intent = intent, window.intent = (m) => { __u8sent.push(m); }, true)`);
    await clearTx(); await click('#bay .pfoot [data-launch]'); await sleep(60);
    f5.down = await readyFrames(); f5.ai = await ev('__u8sent.slice()');
    if (f5.down.length) await reply({ op: 'ready', ok: true });
    await ev(`(window.intent = window.__u8intent, Bay.show('home'), true)`);
    await u8state({ members: [U8YOU(), U8MULE()] });
    f5.two = await u8rows('#bay .sqx');
    await ev(`(Bay.show('squad'), true)`);
    f5.twoFoot = await ev(`[...document.querySelectorAll('#sqWin-squad .sqft button')].filter(${vis8}).map((b) => b.getAttribute('data-sq'))`);
    await ev(`(Bay.show('home'), true)`);
    const one = (r) => Array.isArray(r) && r.length === 1 && r[0].name === 'Dusty Crag' && r[0].lead && r[0].state === '' && r[0].line === 'Leader';
    if (one(f5.box) && one(f5.win) && !/ready/i.test(f5.boxText) && JSON.stringify(f5.foot) === '["leave"]'
        && f5.setup.with === 'with=cpu' && f5.setup.start && !f5.setup.start.rdy
        && f5.down.length === 1 && f5.down[0].ready === false && f5.ai.length === 1 && f5.ai[0].type === 'ai'
        && Array.isArray(f5.two) && f5.two.length === 2 && f5.two.every((r) => r.state === 'Not ready') && JSON.stringify(f5.twoFoot) === '["ready","leave"]')
      ok(`${V}: a squad of one shows no ready-up state -- only Leader under your name, no Ready in the window -- a leftover Ready is stood down when you play alone, and a second player brings it all back`);
    else fail(`${V}: squad of one ${JSON.stringify(f5)}`);

    // ---- F6. THE WINDOW'S DEAD COPY AND SHARE LOOK DEAD. No squad, so no
    //      code: both dimmed, as the window's other dead buttons are, and no
    //      pointer; with a squad's code, both live. Share is drawn only where
    //      the device has a share sheet, so this page is given one.
    await ev(`(Object.defineProperty(navigator, 'share', { value: () => Promise.resolve(), configurable: true }), true)`);
    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), true)`); await sleep(60);
    const f6read = () => ev(`['link', 'share'].map((k) => { const b = document.querySelector('#sqWin-code [data-sq="' + k + '"]'); if (!b) return null;
      const cs = getComputedStyle(b); return { k, dis: b.disabled, op: +cs.opacity, cursor: cs.cursor }; })`);
    await ev(`(Bay.show('squad'), true)`); await sleep(SETTLE8);
    const f6dead = await f6read();
    await u8state({ members: [U8YOU(), U8MULE()] }); await sleep(SETTLE8);
    const f6live = await f6read();
    await ev(`(delete navigator.share, Bay.show('home'), true)`);
    if (f6dead.every((x) => x && x.dis && x.op <= 0.5 && x.cursor !== 'pointer') && f6live.every((x) => x && !x.dis && x.op === 1 && x.cursor === 'pointer'))
      ok(`${V}: with no squad code the window's Copy and Share are dimmed to ${f6dead[0].op} with no pointer, and live at full strength once there is a code`);
    else fail(`${V}: copy and share ${JSON.stringify({ f6dead, f6live })}`);

    // ---- F3. OFFLINE, A REMEMBERED SQUAD IS NO SQUAD. A member of three on
    //      a free-for-all, which Duel, Boss and Aliens do not fit, with Match
    //      setup open on Your squad. The socket drops through app.js's own
    //      ws.onclose, and setup -- repainted by that alone -- is Computer,
    //      Your squad dead with "Needs a connection", and a plain Start Game
    //      that sends the vs-Computer frame and nothing to the squad; home is
    //      the ordinary Launch with no squad pills, and its boards are the
    //      player's own: Boss Fight arms. Then ws.onopen with setup open on
    //      that Boss Fight: the squad's Free-for-all, Your squad and its Ready
    //      are back at once, before the squad has even answered. The Mission
    //      board, open across a second drop, loses its pills and gets them
    //      back the same way.
    const F3 = { leader: U8_MULE, mode: 'ffa', members: [U8YOU(), U8MULE(), U8PIKE()] };
    // What the new socket asked, settled as the server would: the hello's
    // squad resume gets the roster, and the friends read a refusal.
    const u8settle = async () => {
      await sleep(250);
      const res = (await squads()).filter((f) => f.op === 'resume');
      if (res.length) await answer(res[res.length - 1].id, U8BASE(F3));
      await ev(`(() => { for (const f of window.__tx.filter((x) => x.type === 'friends')) handle({ type: 'friends', error: 'unavailable', id: f.id }); window.CC_SOCIAL_ERR = ''; return true; })()`);
      return res.length;
    };
    const mbPills = () => ev(`document.querySelectorAll('#bay .mb .bnf').length`);
    await u8state(F3);
    await ev(`(Bay.show('home'), true)`);
    const f3on = await u8ribbon();
    await click('#bay .lbar .ros'); await sleep(80);
    const f3setOn = await u8setup();
    await clearTx();
    const f3drop = await u8sock(false);
    const f3setup = await u8setup();
    await ev(`(window.__u8sent = [], window.__u8intent = intent, window.intent = (m) => { __u8sent.push(m); }, true)`);
    await click('#bay .pfoot [data-launch]'); await sleep(60);
    const f3sent = { ai: await ev('__u8sent.slice()'), squad: (await squads()).length };
    await ev(`(window.intent = window.__u8intent, Bay.show('home'), true)`);
    const f3off = await u8ribbon();
    await ev(`[...document.querySelectorAll('#bay .board')].find((b) => b.getAttribute('data-set') === 'mode=boss').click()`);
    await sleep(60);
    const f3armed = await ev('Bay.state().mode.id');
    await click('#bay .lbar .launch'); await sleep(80);
    const f3boss = await u8setup();
    await clearTx();
    const f3open = await u8sock(true);
    const f3back = await u8setup();
    const f3res = await u8settle();
    await ev(`(Bay.show('home'), true)`);
    const f3home = await u8ribbon();
    await ev(`(Bay.show('modes'), true)`);
    const f3m = { on: await mbPills() };
    await clearTx();
    await u8sock(false);
    f3m.off = await mbPills();
    await clearTx();
    await u8sock(true);
    f3m.back = await mbPills();
    f3m.res = await u8settle();
    await ev(`(Bay.show('home'), true)`);
    if (f3on.rdy && !f3on.dis && f3on.pills === 3 && f3on.players === 'Squad of 3'
        && f3setOn.scr === 'setup' && f3setOn.with === 'with=squad' && f3setOn.start && f3setOn.start.rdy
        && f3drop.connected === false && f3setup.scr === 'setup' && f3setup.title === 'Free-for-all' && f3setup.with === 'with=cpu'
        && f3setup.squad && f3setup.squad.dis && f3setup.squad.why === 'Needs a connection'
        && f3setup.start && f3setup.start.text === 'Start Game' && !f3setup.start.rdy && !f3setup.start.dis
        && f3sent.ai.length === 1 && f3sent.ai[0].type === 'ai' && f3sent.ai[0].mode === 'ffa' && f3sent.squad === 0
        && f3off.scr === 'home' && f3off.text === 'Launch' && f3off.go === 'setup' && !f3off.rdy && !f3off.dis
        && f3off.players === 'You + 3 CPU' && f3off.pills === 0 && f3off.nofit === 0
        && f3armed === 'boss' && f3boss.title === 'Boss Fight' && f3boss.with === 'with=cpu'
        && f3open.connected === true && f3back.scr === 'setup' && f3back.title === 'Free-for-all' && f3back.armed === 'ffa' && f3back.with === 'with=squad'
        && f3back.start && f3back.start.rdy && !f3back.start.dis && f3back.start.text === 'Ready up 0/3'
        && f3res === 1 && f3home.rdy && f3home.pills === 3
        && f3m.on === 3 && f3m.off === 0 && f3m.back === 3 && f3m.res === 1)
      ok(`${V}: offline a remembered squad is no squad -- open setup drops to Computer with Your squad dead for "Needs a connection" and Start Game the vs-Computer frame, home is the ordinary Launch with no pills -- and the socket's return puts the squad's mode, Your squad and Ready up 0/3 back at once; the Mission board's pills go and come back with it`);
    else fail(`${V}: offline squad ${JSON.stringify({ f3on, f3setOn, f3drop, f3setup, f3sent, f3off, f3armed, f3boss, f3open, f3back, f3res, f3home, f3m })}`);

    await ev(`(handle({ type: 'squad', op: 'ended', reason: 'left' }), ccMode = 'duel', Bay.show('home'), true)`); await sleep(60);
  }
} catch (e) {
  fail('squad_ui U8 stopped: ' + (e && e.message));
}
clearTimeout(watchdog);
cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall squad_ui checks passed');
process.exit(errors.length ? 1 : 0);
