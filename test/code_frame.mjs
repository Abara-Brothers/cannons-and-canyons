// The "Enter a code" field's question, asked of the REAL server.js with the
// social layer OFF.
//
// WHY THIS EXISTS. `code` is a SOCIAL_TYPES frame, so server.js intercepts it
// before the engine — and on a deploy where the social layer was never built
// (no Supabase secret, a Supabase outage at boot, a blocklist that would not
// load) that interception used to answer every such frame
// { error: 'unavailable' }. For squads that is the accepted cost (plan R14).
// For a ROOM code it was a regression: joining a room by code has never
// touched the database, and the one field that now asks "squad or room?"
// would have refused a room the engine was holding open. server.js answers
// the code frame from `rooms` in that branch instead, and this suite drives
// that branch — the interception itself, over a real socket, against a server
// spawned with the Supabase env removed — because the social closure is
// exactly the code this branch runs WITHOUT, so test/squad.mjs cannot see it.
//
// It also asks the ENGINE the same question with the same string: a code this
// branch calls 'room' must be one the engine's own `join` seats a player
// with, and one it calls 'none' must be one `join` refuses. The two
// normalisations live in different files (see server/social.js's codeOf),
// and agreement is proved here rather than assumed.
//
// Self-hosted: spawns and kills its own server on a free port. No Chrome, no
// Supabase, no network beyond loopback.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let srv = null;
let log = '';
const finish = async () => {
  if (srv && srv.exitCode === null) {
    srv.kill('SIGTERM');
    for (let i = 0; i < 30 && srv.exitCode === null; i++) await sleep(100);
    if (srv.exitCode === null) srv.kill('SIGKILL');
  }
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall code-frame checks passed');
  process.exit(out.errors.length ? 1 : 0);
};
setTimeout(() => { fail('timeout — the suite did not finish in 30 s'); finish(); }, 30000).unref();

const open = (port) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws._rx = [];
  ws._closed = null;
  ws.on('message', (raw) => { try { ws._rx.push(JSON.parse(raw)); } catch {} });
  ws.on('close', (code) => { ws._closed = code; });
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
});
const tx = (ws, m) => ws.send(JSON.stringify(m));
// The first frame from index `from` on that matches, or null after `ms`.
const waitFor = async (ws, pred, from = 0, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = ws._rx.slice(from).find(pred);
    if (m) return m;
    await sleep(15);
  }
  return null;
};
// Ask one code frame and return the reply. Replies are matched on type alone
// because some probes deliberately carry no id, so each ask waits for the
// NEXT code frame after the ones already received.
const ask = async (ws, frame) => {
  const from = ws._rx.length;
  tx(ws, frame);
  return waitFor(ws, (m) => m.type === 'code', from);
};

(async () => {
  // ---- a server with the social layer OFF -----------------------------------
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  // All three, not just the secret: this is the branch where server.js never
  // builds the layer, and a stray key in the caller's shell must not build it.
  delete env.SUPABASE_URL; delete env.SUPABASE_PUBLISHABLE_KEY; delete env.SUPABASE_SECRET_KEY;
  srv = spawn(process.execPath, ['server.js'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !/running at/.test(log); i++) await sleep(100);
  if (!/running at/.test(log)) { fail('server never reported listening:\n' + log); return finish(); }

  const w = await open(port);

  // PRECONDITION, or every check below passes for the wrong reason. With the
  // layer built, a `friends` frame from a socket that never said hello is
  // refused { type:'social', error:'sign_in' }; only the layer-off branch
  // answers it with its own type and 'unavailable'.
  {
    const from = w._rx.length;
    tx(w, { type: 'friends', id: 'f1' });
    const r = await waitFor(w, (m) => m.id === 'f1', from);
    if (same(r, { type: 'friends', error: 'unavailable', id: 'f1' }))
      ok('(0) the social layer is OFF on this server — a friends frame gets the layer-off answer');
    else { fail('(0) the social layer is not off, so this suite would test the wrong branch: friends answered ' + JSON.stringify(r)); return finish(); }
  }

  // ---- a live room ------------------------------------------------------------
  // A CODE WITH A LETTER IN IT, so the lower-case probes below can fail. Eight
  // of the 31 characters are digits and about one mint in 226 is digits alone;
  // for that code lower case is the same string. The engine is not reachable
  // from here, so re-create until one carries a letter.
  let host = null, A = '';
  for (let i = 0; i < 20 && !/[A-Z]/.test(A); i++) {
    if (host) { tx(host, { type: 'leave' }); host.close(); }
    host = await open(port);
    tx(host, { type: 'create', name: 'Host', skin: 'olive', mode: 'duel' });
    const cr = await waitFor(host, (m) => m.type === 'created');
    A = (cr && cr.code) || '';
  }
  if (!/^[A-Z2-9]{4}$/.test(A) || !/[A-Z]/.test(A)) { fail('(1) could not create a room whose code carries a letter; last code ' + JSON.stringify(A)); return finish(); }

  {
    const r = await ask(w, { type: 'code', code: A, id: 'c1' });
    if (same(r, { type: 'code', kind: 'room', id: 'c1' }))
      ok('(1) a live room code answers kind "room" with the social layer off, id echoed');
    else fail('(1) a live room code answered ' + JSON.stringify(r));
  }
  {
    // A NUMERIC id, which is what public/app.js's socialSend actually mints.
    const r = await ask(w, { type: 'code', code: A.toLowerCase(), id: 2 });
    if (same(r, { type: 'code', kind: 'room', id: 2 }))
      ok('(1) the same code in lower case answers "room", numeric id echoed');
    else fail('(1) lower case answered ' + JSON.stringify(r));
  }
  const PADDED = '  ' + A.toLowerCase() + ' ';
  {
    const r = await ask(w, { type: 'code', code: PADDED, id: 'c3' });
    if (same(r, { type: 'code', kind: 'room', id: 'c3' }))
      ok('(1) the same code, lower case with spaces round it, answers "room"');
    else fail('(1) a padded lower-case code answered ' + JSON.stringify(r));
  }

  // ---- codes that name nothing -------------------------------------------------
  // SQUAD-SHAPED: four characters from the shared alphabet, exactly what a
  // squad code looks like. No squad can exist while the layer is off, so the
  // honest answer is 'none'; 'squad' would send the client to a squad join
  // that is then refused 'unavailable'.
  const U = ['SQAD', 'SQDA', 'DQAS'].find((c) => c !== A);
  {
    const r = await ask(w, { type: 'code', code: U, id: 'c4' });
    if (same(r, { type: 'code', kind: 'none', id: 'c4' }))
      ok('(2) a squad-shaped code with no room behind it answers "none", never "squad"');
    else fail('(2) squad-shaped code ' + U + ' answered ' + JSON.stringify(r));
  }
  {
    const r = await ask(w, { type: 'code', code: 123, id: 'c5' });
    await sleep(100);
    if (same(r, { type: 'code', kind: 'none', id: 'c5' }) && w._closed === null && w.readyState === 1)
      ok('(2) a non-string code answers "none" and the socket stays open — nothing threw');
    else fail('(2) {code:123} answered ' + JSON.stringify(r) + ', socket close code ' + w._closed);
  }
  {
    const r = await ask(w, { type: 'code' });
    if (same(r, { type: 'code', kind: 'none' }))
      ok('(2) a frame with no code and no id answers exactly { type, kind:"none" } — no id is invented');
    else fail('(2) a bare code frame answered ' + JSON.stringify(r));
  }

  // ---- the special case is NARROW ---------------------------------------------
  // Only `code` is answered from memory. A squad frame still gets the
  // layer-off refusal (R14) — the id echoed, as it always was.
  {
    const from = w._rx.length;
    tx(w, { type: 'squad', op: 'join', code: A, id: 's1' });
    const r = await waitFor(w, (m) => m.id === 's1', from);
    if (same(r, { type: 'squad', error: 'unavailable', id: 's1' }))
      ok('(3) a squad frame is still refused "unavailable" with the layer off — only the code frame is answered from memory');
    else fail('(3) a squad frame answered ' + JSON.stringify(r));
  }

  // ---- the ENGINE agrees -------------------------------------------------------
  // Same strings, asked of the engine's own `join`. 'none' must be a code join
  // refuses, and 'room' must be a code join seats a player with — the padded
  // lower-case form, the one most likely to drift between the copies.
  {
    const j = await open(port);
    tx(j, { type: 'join', code: U, name: 'J', skin: 'olive' });
    const r = await waitFor(j, (m) => m.type === 'joinError' || m.type === 'start');
    if (r && r.type === 'joinError') ok('(4) the engine\'s join refuses the code that answered "none" (' + JSON.stringify(r.reason) + ')');
    else fail('(4) the engine\'s join did not refuse ' + U + ': ' + JSON.stringify(r));
    j.close();
  }
  {
    const from = w._rx.length;
    tx(w, { type: 'join', code: PADDED, name: 'W', skin: 'olive' });
    const r = await waitFor(w, (m) => m.type === 'joinError' || m.type === 'start', from);
    if (r && r.type === 'start') ok('(4) the engine\'s join seats a player with the padded lower-case string that answered "room"');
    else fail('(4) the engine\'s join did not seat ' + JSON.stringify(PADDED) + ': ' + JSON.stringify(r));
  }

  // ---- read, not remembered ----------------------------------------------------
  // A lobby whose lone host leaves is torn down; the same string must then
  // answer 'none'. A branch answering from a constant cannot give two answers.
  {
    const h = await open(port);
    tx(h, { type: 'create', name: 'Host', skin: 'olive', mode: 'duel' });
    const cr = await waitFor(h, (m) => m.type === 'created');
    const B = (cr && cr.code) || '';
    const q = await open(port);
    const before = await ask(q, { type: 'code', code: B, id: 'b1' });
    tx(h, { type: 'leave' });
    await waitFor(h, (m) => m.type === 'opponentLeft');
    const after = await ask(q, { type: 'code', code: B, id: 'b2' });
    if (same(before, { type: 'code', kind: 'room', id: 'b1' }) && same(after, { type: 'code', kind: 'none', id: 'b2' }))
      ok('(5) one code answers "room" while its lobby lives and "none" once it is torn down');
    else fail('(5) code ' + B + ' answered ' + JSON.stringify(before) + ' then ' + JSON.stringify(after));
    h.close(); q.close();
  }

  w.close(); host.close();
  await sleep(100);

  // Nothing unexpected on the server's own output: the run-all.sh benign set.
  const stray = log.split('\n').filter((l) => l.trim() && !/running at|^\[boot\]|^\[shutdown\] SIGTERM/.test(l));
  if (stray.length === 0) ok('(6) the server printed nothing but its banner');
  else fail('(6) the server printed:\n      ' + stray.join('\n      '));

  return finish();
})().catch((e) => { fail('threw: ' + (e && e.stack ? e.stack : e)); finish(); });
