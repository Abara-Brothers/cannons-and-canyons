// The account chip and the Bay controls Account row, in a real page: every
// state the old #accountBtn can be in (out / guest / signed in with Apple,
// Google, both), the redraw on `cc:account`, the modal's per-provider lines,
// and the home-only type size. Headless Chrome over CDP; skips without Chrome.
//
// WHY THIS EXISTS: the chip is drawn from window.CC_ACCOUNT by bay.js and
// refreshed by an event from app.js — two files that only meet in a browser.
// A header that overflows its row, a mark that fails to draw, or a size bump
// leaking onto other screens are all invisible to the Node suites.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) { console.log(`SKIP  account_ui tests — no Chrome at ${CHROME}`); process.exit(3); }
const ROOT = fileURLToPath(new URL('..', import.meta.url));   // decoded: the path has spaces
const errors = [];
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const appPort = await freePort();
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${appPort}/health`); break; } catch {} await sleep(150); }
const dbg = await freePort(); const prof = join(tmpdir(), `cc-acc-${dbg}`); rmSync(prof, { recursive: true, force: true });
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

const ACC = {
  none:  'null',
  guest: `{anonymous:true,google:false,apple:false,email:null,accounts:[]}`,
  apple: `{anonymous:false,google:false,apple:true,email:'x7q2p@privaterelay.appleid.com',accounts:[{provider:'apple',email:'x7q2p@privaterelay.appleid.com'}]}`,
  both:  `{anonymous:false,google:true,apple:true,email:'me@gmail.example',accounts:[{provider:'apple',email:'x7q2p@privaterelay.appleid.com'},{provider:'google',email:'me@gmail.example'}]}`,
};
// Set the state exactly as refreshAccountChip() leaves it, then fire its event.
const setState = (st, acc, hidden = false) => ev(`(() => { const b = $('accountBtn'); b.classList.toggle('hidden', ${hidden}); b.dataset.state = '${st}'; window.CC_ACCOUNT = ${ACC[acc]}; document.dispatchEvent(new CustomEvent('cc:account')); return true; })()`);
const chip = () => ev(`(() => { const c = document.querySelector('#bay .top .chip.acc'); if (!c) return null; const top = document.querySelector('#bay .top').getBoundingClientRect(); const mark = document.querySelector('#bay .top .mark').getBoundingClientRect(); const kids = [...document.querySelector('#bay .top').children].filter((k) => k.classList.contains('chip')); const r = c.getBoundingClientRect(); return { text: c.textContent.trim(), svgs: c.querySelectorAll('svg').length, dim: c.classList.contains('dim'), old: c.dataset.old, fits: mark.right < Math.min(...kids.map((k) => k.getBoundingClientRect().left)) && Math.max(...kids.map((k) => k.getBoundingClientRect().right)) <= top.right + 0.5, clipped: c.scrollWidth > c.clientWidth + 1 }; })()`);
const settings = () => ev(`(() => { Bay.show('settings'); const r = [...document.querySelectorAll('#bay .row')].find((x) => x.querySelector('.rn2') && x.querySelector('.rn2').textContent === 'Account'); const out = { row: r ? r.querySelector('.rd').innerText.split('\\n').map((s) => s.trim()).filter(Boolean) : null, svgs: r ? r.querySelectorAll('.rd svg').length : -1, sub: (document.querySelector('#bay .ps') || {}).textContent || '' }; Bay.show('home'); return out; })()`);

for (const [w, h] of [[667, 375], [932, 430]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  let ready = false;
  for (let i = 0; i < 80; i++) { if (await ev('typeof refreshAccountChip === "function" && !!window.Bay && S.connected === true && !!document.querySelector("#bay .top")').catch(() => false)) { ready = true; break; } await sleep(200); }
  if (!ready) { fail(`${w}x${h}: page never became ready`); continue; }
  await ev(`(() => { window.showToast = () => {}; try { localStorage.setItem('cc_dock_learned', '1'); } catch {} Bay.show('home'); return true; })()`);
  const V = `${w}x${h}`;

  // 1. hidden button -> no chip at all
  await setState('out', 'none', true);
  if ((await chip()) === null) ok(`${V}: no chip while #accountBtn is hidden (no session, no way to start one)`); else fail(`${V}: chip drawn for a hidden account button`);
  // 2. out -> Sign in, dim, routed to the account button
  await setState('out', 'none');
  let c = await chip();
  if (c && c.text === 'Sign in' && c.svgs === 0 && c.dim && c.old === 'accountBtn' && c.fits && !c.clipped) ok(`${V}: signed out -> "Sign in" chip, quiet, taps the account button, row fits`); else fail(`${V}: out chip ${JSON.stringify(c)}`);
  // 3. guest -> Guest
  await setState('guest', 'guest');
  c = await chip();
  if (c && c.text === 'Guest' && c.svgs === 0 && c.dim && c.fits) ok(`${V}: guest -> "Guest" chip`); else fail(`${V}: guest chip ${JSON.stringify(c)}`);
  let s = await settings();
  if (s.row && s.row.join('|') === 'Guest — sign in to keep progress across devices' && s.svgs === 0) ok(`${V}: guest -> Account row unchanged`); else fail(`${V}: guest row ${JSON.stringify(s)}`);
  // 4. Apple only -> one mark
  await setState('in', 'apple');
  c = await chip();
  if (c && c.text === 'Signed in' && c.svgs === 1 && !c.dim && c.fits && !c.clipped) ok(`${V}: Apple -> "Signed in" with one mark`); else fail(`${V}: apple chip ${JSON.stringify(c)}`);
  s = await settings();
  if (s.row && s.row.length === 1 && s.row[0] === 'Apple · x7q2p@privaterelay.appleid.com' && s.svgs === 1 && s.sub.startsWith('Signed in with Apple —')) ok(`${V}: Apple -> Account row names Apple with the relay address; subtitle says with Apple`); else fail(`${V}: apple row ${JSON.stringify(s)}`);
  // 5. both -> two marks, two lines, both named
  await setState('in', 'both');
  c = await chip();
  if (c && c.text === 'Signed in' && c.svgs === 2 && c.fits && !c.clipped) ok(`${V}: Apple + Google -> two marks, row still fits`); else fail(`${V}: both chip ${JSON.stringify(c)}`);
  s = await settings();
  if (s.row && s.row.length === 2 && s.row[0] === 'Apple · x7q2p@privaterelay.appleid.com' && s.row[1] === 'Google · me@gmail.example' && s.svgs === 2 && s.sub.startsWith('Signed in with Apple and Google —')) ok(`${V}: both -> two lines, Apple first, each with its own address`); else fail(`${V}: both row ${JSON.stringify(s)}`);
  // 6. the marks are the two known shapes, in the chip's colour (fill inherits)
  const marks = await ev(`(() => [...document.querySelectorAll('#bay .top .chip.acc svg')].map((s) => ({ d: s.querySelector('path').getAttribute('d').slice(0, 14), fill: getComputedStyle(s).fill })))()`);
  if (marks.length === 2 && marks[0].d.startsWith('M17.05 20.28') && marks[1].d.startsWith('M12.48 10.92') && marks[0].fill === marks[1].fill) ok(`${V}: marks are the Apple and Google shapes, same fill`); else fail(`${V}: marks ${JSON.stringify(marks)}`);
  // 7. the account modal lists a line per provider, as text
  const modal = await ev(`(() => { $('accountBtn').onclick(); const t = $('accWho').innerText; $('accountModal').classList.add('hidden'); return { t, html: $('accWho').innerHTML.includes('<span') }; })()`);
  if (modal.t.split('\n').map((x) => x.trim()) .join('|') === 'Signed in with Apple · x7q2p@privaterelay.appleid.com|Signed in with Google · me@gmail.example' && !modal.html) ok(`${V}: account modal: one text line per provider`); else fail(`${V}: modal ${JSON.stringify(modal)}`);
  // 8. an address is provider input: markup in it must not become markup
  await ev(`(() => { $('accountBtn').dataset.state = 'in'; window.CC_ACCOUNT = {anonymous:false,google:true,apple:false,email:'x',accounts:[{provider:'google',email:'<img src=x onerror=window.__pwned=1>'}]}; document.dispatchEvent(new CustomEvent('cc:account')); return true; })()`);
  const esc = await ev(`(() => { Bay.show('settings'); const bad = !!document.querySelector('#bay .row .rd img'); Bay.show('home'); $('accountBtn').onclick(); const bad2 = !!$('accWho').querySelector('img'); $('accountModal').classList.add('hidden'); return { bad, bad2, pwned: !!window.__pwned }; })()`);
  if (!esc.bad && !esc.bad2 && !esc.pwned) ok(`${V}: a hostile address renders as text in the row and the modal`); else fail(`${V}: escaping ${JSON.stringify(esc)}`);
  // 9. the redraw only happens while the bay is on stage
  await setState('in', 'both');
  const stage = await ev(`(() => { $('bay').classList.remove('active'); const before = document.querySelector('#bay .top .chip.acc').outerHTML; $('accountBtn').dataset.state = 'guest'; window.CC_ACCOUNT = ${ACC.guest}; document.dispatchEvent(new CustomEvent('cc:account')); const after = document.querySelector('#bay .top .chip.acc').outerHTML; $('bay').classList.add('active'); document.dispatchEvent(new CustomEvent('cc:account')); const after2 = document.querySelector('#bay .top .chip.acc').textContent.trim(); return { same: before === after, after2 }; })()`);
  if (stage.same && stage.after2 === 'Guest') ok(`${V}: no repaint while the bay is off stage; repaint once it is back`); else fail(`${V}: stage guard ${JSON.stringify(stage)}`);
  // 10. home-only type size: the bumped classes on home, the originals elsewhere
  const sizes = await ev(`(() => { const u = (() => { const e = document.createElement('div'); e.style.cssText = 'position:absolute;width:calc(100 * var(--u))'; $('bay').appendChild(e); const w = e.getBoundingClientRect().width / 100; e.remove(); return w; })(); const fs = (sel) => { const e = document.querySelector(sel); return e ? +(parseFloat(getComputedStyle(e).fontSize) / u).toFixed(1) : null; }; Bay.show('home'); const home = { scr: $('bay').dataset.scr, btg: fs('#bay .board.on .btg'), ltg: fs('#bay .lbar .ltg'), chip: fs('#bay .top .chip'), ph: fs('#bay .pnl .ph'), std: fs('#bay .st .std'), rk: fs('#bay .ro .rk'), bof: fs('#bay .bof'), mark: fs('#bay .mark span') }; Bay.show('settings'); const set = { scr: $('bay').dataset.scr, ph: fs('#bay .ph'), lbl: fs('#bay .lbl') }; Bay.show('setup'); const setup = { scr: $('bay').dataset.scr, lbl: fs('#bay .lbl'), hint: fs('#bay .hint') }; Bay.show('career'); const career = { scr: $('bay').dataset.scr, lbl: fs('#bay .lbl'), ps: fs('#bay .ps'), pm: fs('#bay .pm'), bn: fs('#bay .bar .bn'), bv: fs('#bay .bar .bv'), ad: fs('#bay .b-ach .ad'), an: fs('#bay .b-ach .an'), bnClipped: [...document.querySelectorAll('#bay .bar .bn, #bay .bar .bv')].filter((e) => e.scrollWidth > e.clientWidth + 1).length }; Bay.show('join'); const joinScr = $('bay').dataset.scr; const joinChip = fs('#bay .top .chip'); Bay.show('home'); return { home, set, setup, career, joinScr, joinChip }; })()`);
  const H = sizes.home;
  if (H.scr === 'home' && H.btg === 9.5 && H.ltg === 10 && H.chip === 12 && H.ph === 10 && H.std === 9.5 && H.rk === 9.5 && H.bof === null && H.mark === 9.5) ok(`${V}: home type: tags 9.5u, launch tag 10u, chips 12u, panel heads 10u, no badge on the boards`); else fail(`${V}: home sizes ${JSON.stringify(H)}`);
  if (sizes.set.scr === 'settings' && sizes.set.lbl === 8.5 && sizes.setup.scr === 'setup' && sizes.setup.lbl === 8.5 && sizes.setup.hint === 8.5) ok(`${V}: other screens keep their sizes (labels 8.5u on settings and setup)`); else fail(`${V}: leak ${JSON.stringify({ set: sizes.set, setup: sizes.setup })}`);
  const C = sizes.career;
  if (C.scr === 'career' && C.lbl === 10 && C.ps === 10 && C.pm === 11 && C.bn === 10 && C.bv === 11 && C.ad === 11 && C.an === 12.5 && C.bnClipped === 0) ok(`${V}: service record type: labels 10u, values 11u, descriptions 11u, names 12.5u, bar names and values unclipped`); else fail(`${V}: career sizes ${JSON.stringify(C)}`);
  if (sizes.joinScr === 'home' && sizes.joinChip === 12) ok(`${V}: the join panel is stamped as home, so the home geometry and sizes hold under its overlay`); else fail(`${V}: join stamp ${JSON.stringify({ scr: sizes.joinScr, chip: sizes.joinChip })}`);
  // 11. tap targets (owner, 2026-09-18): every header chip is 55u tall, the square
  //     ones 55u wide, the header row 55u tall, and its bottom edge exactly 4u
  //     above the mode boards — all on home only. Measured as a gap, not an
  //     absolute y: the design frame is letterboxed at some viewports.
  const tap = await ev(`(() => { const u = (() => { const e = document.createElement('div'); e.style.cssText = 'position:absolute;width:calc(100 * var(--u))'; $('bay').appendChild(e); const w = e.getBoundingClientRect().width / 100; e.remove(); return w; })(); Bay.show('home'); const r = (el) => el.getBoundingClientRect(); const bay = r(document.querySelector('#bay .bay')); /* the design frame, letterboxed inside #bay at some sizes */ const top = r(document.querySelector('#bay .top')); const boards = r(document.querySelector('#bay .boards')); const chips = [...document.querySelectorAll('#bay .top .chip')]; return { n: chips.length, heights: chips.map((c) => +(r(c).height / u).toFixed(1)), sqWidths: chips.filter((c) => c.classList.contains('sq')).map((c) => +(r(c).width / u).toFixed(1)), topY: +((top.top - bay.top) / u).toFixed(1), topH: +(top.height / u).toFixed(1), gap: +((boards.top - top.bottom) / u).toFixed(1) }; })()`);
  if (tap.n === 5 && tap.heights.every((h) => h === 55) && tap.sqWidths.length === 2 && tap.sqWidths.every((w) => w === 55) && tap.topH === 55 && tap.gap === 4) ok(`${V}: five header chips 55u tall (44pt on the phone), square ones 55u wide, header 55u tall, exactly 4u clear of the boards`); else fail(`${V}: tap targets ${JSON.stringify(tap)}`);
  // 11b. nothing on the home header, boards, stations or launch bar clips after the bump
  const clips = await ev(`(() => [...document.querySelectorAll('#bay .top *, #bay .boards .blab *, #bay .pnl *, #bay .lbar .ltg, #bay .lbar .rk')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className))()`);
  if (clips.length === 0) ok(`${V}: no horizontal clipping in the header, board labels, stations or launch tags`); else fail(`${V}: clipped ${JSON.stringify(clips)}`);
}
// ---- the stranded OAuth return, in a real browser --------------------------
// The server answers /auth/callback with a 302 to "/" (see server.js). What only
// a browser can prove: the fragment (the provider's reply) is carried over to
// "/", cloud.js scrubs it there because this tab never started a flow, the game
// renders — and the same holds once the service worker controls the page, which
// is the case for every returning web player.
{
  await send('Emulation.setDeviceMetricsOverride', { width: 932, height: 430, deviceScaleFactor: 2, mobile: false });
  const FRAG = '#access_token=stranded_at&refresh_token=stranded_rt&expires_in=3600&token_type=bearer';
  const landed = async () => {
    for (let i = 0; i < 80; i++) { if (await ev('!!window.Bay && !!document.querySelector("#bay .top")').catch(() => false)) break; await sleep(200); }
    return ev(`({ path: location.pathname, hash: location.hash, bay: !!document.querySelector('#bay .top'), session: (() => { try { return JSON.parse(localStorage.getItem('cc_session') || 'null'); } catch { return 'unreadable'; } })(), sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller) })`);
  };
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/auth/callback${FRAG}` });
  const first = await landed();
  if (first.path === '/' && first.hash === '' && first.bay) ok('stranded return: /auth/callback#tokens lands on / with the tokens scrubbed and the game rendered');
  else fail('stranded return (first): ' + JSON.stringify(first));
  if (!(first.session && first.session.access_token === 'stranded_at')) ok('stranded return: the tokens are NOT adopted as a session (this tab never started a flow)');
  else fail('stranded return adopted the tokens: ' + JSON.stringify(first.session));
  // Now with the service worker in control: one plain navigation lets the
  // registered worker claim the page, then the same return again.
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  for (let i = 0; i < 100; i++) { if (await ev('!!(navigator.serviceWorker && navigator.serviceWorker.controller)').catch(() => false)) break; await sleep(200); }
  const controlled = await ev('!!(navigator.serviceWorker && navigator.serviceWorker.controller)');
  if (controlled) {
    await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/auth/callback${FRAG}` });
    const second = await landed();
    if (second.path === '/' && second.hash === '' && second.bay && second.sw) ok('stranded return under the service worker: the redirect passes through the worker, same landing');
    else fail('stranded return (service worker): ' + JSON.stringify(second));
  } else fail('service worker never took control of the page, so the pass-through was not proven');
}

cleanup();
console.log(errors.length ? `\n${errors.length} FAILED` : '\nall account_ui checks passed');
process.exit(errors.length ? 1 : 0);
