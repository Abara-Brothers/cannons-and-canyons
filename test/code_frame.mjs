// The "Enter a code" field's question, asked of the REAL server.js, in both
// states the social layer can be in: never built, and built against a
// Supabase that is hanging.
//
// WHY THIS EXISTS. `code` is a SOCIAL_TYPES frame, so server.js intercepts it
// before the engine. Two ways it used to fail a player holding a live room's
// code, neither visible to test/squad.mjs, which drives the social closure in
// process and never runs server.js's interception at all:
//
//   * LAYER OFF (no Supabase secret, an outage at boot, a blocklist that would
//     not load): the interception answered every such frame 'unavailable'.
//     Joining a room by code has never touched the database, so the one code
//     field would have refused a room the engine was holding open.
//   * LAYER ON, SUPABASE SLOW: the frame waited on the socket's pending hello
//     (up to 8 s) and then queued behind any social frame already running on
//     that socket (a friends read is up to five 8 s store calls). The answer
//     is two Map lookups, but it arrived after the client's 12 s waiter had
//     given up — the same refusal, on the deploys that are merely degraded.
//
// server.js now answers the code frame FIRST, before the layer-off branch,
// the hello wait and the per-socket queue. Each world below spawns its own
// server.js and asserts against it over a real socket, and each proves its
// precondition first — the layer really is off, the hello really is pending,
// the friends read really is hung — so no check can pass for the wrong reason.
//
// It also asks the ENGINE the same question with the same string: a code this
// branch calls 'room' must be one the engine's own `join` seats a player
// with, and one it calls 'none' must be one `join` refuses. The two
// normalisations live in different files (see server/social.js's codeOf),
// and agreement is proved here rather than assumed.
//
// Self-hosted: spawns and kills its own servers on free ports, and the layer-on
// world talks to a local mock of GoTrue and PostgREST. No Chrome, no real
// Supabase, no network beyond loopback.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const servers = [];
let mock = null;
const finish = async () => {
  for (const s of servers) {
    if (s.proc.exitCode !== null) continue;
    s.proc.kill('SIGTERM');
    for (let i = 0; i < 30 && s.proc.exitCode === null; i++) await sleep(100);
    if (s.proc.exitCode === null) s.proc.kill('SIGKILL');
  }
  if (mock) { try { mock.closeAllConnections(); } catch {} try { mock.close(); } catch {} }
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall code-frame checks passed');
  process.exit(out.errors.length ? 1 : 0);
};
setTimeout(() => { fail('timeout — the suite did not finish in 45 s'); finish(); }, 45000).unref();

// Spawn this checkout's server.js with the Supabase env REPLACED by `sb` (all
// three keys deleted first, so a stray key in the caller's shell can never
// decide which world this is).
async function boot(sb, extra = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  delete env.SUPABASE_URL; delete env.SUPABASE_PUBLISHABLE_KEY; delete env.SUPABASE_SECRET_KEY;
  Object.assign(env, sb, extra);
  const s = { port, log: '', proc: spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }) };
  s.proc.stdout.on('data', (d) => { s.log += d; });
  s.proc.stderr.on('data', (d) => { s.log += d; });
  servers.push(s);
  for (let i = 0; i < 100 && !/running at/.test(s.log); i++) await sleep(100);
  return /running at/.test(s.log) ? s : null;
}

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
const ask = async (ws, frame, ms = 3000) => {
  const from = ws._rx.length;
  tx(ws, frame);
  return waitFor(ws, (m) => m.type === 'code', from, ms);
};
// A live room whose code carries a LETTER, so a lower-case probe can fail.
// Eight of the 31 characters are digits and about one mint in 226 is digits
// alone; for that code lower case is the same string. The engine is not
// reachable from here, so re-create until one carries a letter.
async function letteredRoom(port) {
  let host = null, code = '';
  for (let i = 0; i < 20 && !/[A-Z]/.test(code); i++) {
    if (host) { tx(host, { type: 'leave' }); host.close(); }
    host = await open(port);
    tx(host, { type: 'create', name: 'Host', skin: 'olive', mode: 'duel' });
    const cr = await waitFor(host, (m) => m.type === 'created');
    // No answer at all is not a digits-only code to retry: the engine did not
    // mint, and retrying would only spend the suite's time limit.
    if (!cr) { code = ''; break; }
    code = cr.code || '';
  }
  return { host, code: /^[A-Z2-9]{4}$/.test(code) && /[A-Z]/.test(code) ? code : '' };
}
// Nothing on a server's own output beyond the run-all.sh benign set, plus any
// line the caller names as expected.
const strayLines = (s, extra) => s.log.split('\n').filter((l) => l.trim()
  && !/running at|^\[boot\]|^\[shutdown\] SIGTERM/.test(l) && !(extra && extra.test(l)));

// =============================================================================
// WORLD 1: the social layer was never built.
// =============================================================================
async function layerOff() {
  console.log('== layer OFF (no Supabase env) ==');
  const s = await boot({});
  if (!s) { fail('server never reported listening'); return; }
  const w = await open(s.port);

  // PRECONDITION. With the layer built, a `friends` frame from a socket that
  // never said hello is refused { type:'social', error:'sign_in' }; only the
  // layer-off branch answers it with its own type and 'unavailable'.
  {
    const from = w._rx.length;
    tx(w, { type: 'friends', id: 'f1' });
    const r = await waitFor(w, (m) => m.id === 'f1', from);
    if (same(r, { type: 'friends', error: 'unavailable', id: 'f1' }))
      ok('(0) the social layer is OFF on this server — a friends frame gets the layer-off answer');
    else { fail('(0) the social layer is not off, so this world would test the wrong branch: friends answered ' + JSON.stringify(r)); return; }
  }

  const { host, code: A } = await letteredRoom(s.port);
  if (!A) { fail('(1) could not create a room whose code carries a letter'); return; }

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

  // THE ANSWER FROM MEMORY IS NARROW. A squad frame still gets the layer-off
  // refusal (R14) — and it carries its OP, for the reason handleSquad's own
  // replies do: a client with two squad answers outstanding cannot tell which
  // one failed from { type:'squad', error } alone. A frame with no op answers
  // op 'unknown', the layer's own spelling.
  {
    const from = w._rx.length;
    tx(w, { type: 'squad', op: 'join', code: A, id: 's1' });
    const r = await waitFor(w, (m) => m.id === 's1', from);
    if (same(r, { type: 'squad', op: 'join', error: 'unavailable', id: 's1' }))
      ok('(3) a squad frame is still refused "unavailable" with the layer off, carrying its op and id');
    else fail('(3) a squad frame answered ' + JSON.stringify(r));
  }
  {
    const from = w._rx.length;
    tx(w, { type: 'squad', id: 's2' });
    const r = await waitFor(w, (m) => m.id === 's2', from);
    if (same(r, { type: 'squad', op: 'unknown', error: 'unavailable', id: 's2' }))
      ok('(3) a squad frame with no op is refused with op "unknown"');
    else fail('(3) a squad frame with no op answered ' + JSON.stringify(r));
  }

  // THE ENGINE AGREES. Same strings, asked of the engine's own `join`. 'none'
  // must be a code join refuses, and 'room' must be a code join seats a player
  // with — the padded lower-case form, the one most likely to drift between
  // the two copies of the rule.
  {
    const j = await open(s.port);
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

  // READ, NOT REMEMBERED. A lobby whose lone host leaves is torn down; the same
  // string must then answer 'none'.
  {
    const h = await open(s.port);
    tx(h, { type: 'create', name: 'Host', skin: 'olive', mode: 'duel' });
    const cr = await waitFor(h, (m) => m.type === 'created');
    const B = (cr && cr.code) || '';
    const q = await open(s.port);
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
  const stray = strayLines(s);
  if (stray.length === 0) ok('(6) the server printed nothing but its banner');
  else fail('(6) the server printed:\n      ' + stray.join('\n      '));
}

// =============================================================================
// WORLD 2: the social layer is BUILT, against a Supabase that hangs.
// =============================================================================
// The mock answers exactly what boot and the auth sink need, and HANGS the two
// requests this world is about: GoTrue for one token (so that socket's hello
// stays pending), and the friends read model's friendship query (so a friends
// frame stays running in the socket's queue). Hung requests are held open, not
// refused, because a hang is the case the client's 12 s waiter cannot survive.
const LINKED = '00000000-0000-4000-8000-c0de00000001';
const hung = { auth: 0, friends: 0 };
const mockHandler = (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/auth/v1/user') {
    const auth = req.headers.authorization || '';
    if (auth === 'Bearer tok-hang') { hung.auth++; return; }          // never answered
    if (auth === 'Bearer tok-linked') return json(200, { id: LINKED, is_anonymous: false });
    return json(401, {});
  }
  // friendIdsOf's shape — the read model's first query — and nothing else:
  // boot's own probe of the same table (`select=user_a&limit=0`) must answer.
  if (u.pathname === '/rest/v1/friendships' && (u.searchParams.get('or') || '').startsWith('(user_a.eq.')) { hung.friends++; return; }
  if (req.method === 'GET') return json(200, []);
  res.writeHead(204); res.end();
};

async function layerOn() {
  console.log('== layer ON, Supabase hanging (local mock) ==');
  mock = http.createServer(mockHandler);
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const MOCK = `http://127.0.0.1:${mock.address().port}`;
  // SOCIAL_PRESENCE_MS pushed out of the window: a presence flush reads the
  // same friendship query this world hangs, and must not be what it observes.
  const s = await boot({ SUPABASE_URL: MOCK, SUPABASE_PUBLISHABLE_KEY: 'pk_test', SUPABASE_SECRET_KEY: 'sk_test' }, { SOCIAL_PRESENCE_MS: '600000' });
  if (!s) { fail('server never reported listening'); return; }

  // PRECONDITION: the layer is ON. A friends frame from a socket that never
  // said hello reaches the layer's own gate, which answers sign_in — the
  // layer-off branch would have answered { type:'friends', error:'unavailable' }.
  {
    const w = await open(s.port);
    tx(w, { type: 'friends', id: 'g1' });
    const r = await waitFor(w, (m) => m.id === 'g1');
    w.close();
    if (same(r, { type: 'social', error: 'sign_in', id: 'g1' }))
      ok('(7) the social layer is ON on this server — a friends frame reaches its sign-in gate');
    else { fail('(7) the social layer is not on, so this world would test the wrong branch: friends answered ' + JSON.stringify(r)); return; }
  }

  // A live room, minted with setCodeTaken(social.hasSquad) wired at boot: the
  // engine's loop still terminates and mints, and the code frame's squad arm
  // (social.hasSquad) is consulted without throwing.
  const { host, code: A } = await letteredRoom(s.port);
  if (!A) { fail('(8) could not create a room with the layer on — makeCode under the wired codeTaken did not mint'); return; }
  {
    const w = await open(s.port);
    const r1 = await ask(w, { type: 'code', code: A.toLowerCase(), id: 'n1' });
    const r2 = await ask(w, { type: 'code', code: 'SQAD' === A ? 'SQDA' : 'SQAD', id: 'n2' });
    const r3 = await ask(w, { type: 'code', code: 123, id: 'n3' });
    await sleep(100);
    if (same(r1, { type: 'code', kind: 'room', id: 'n1' }) && same(r2, { type: 'code', kind: 'none', id: 'n2' })
      && same(r3, { type: 'code', kind: 'none', id: 'n3' }) && w._closed === null)
      ok('(8) with the layer on: a live room (lower case) answers "room", a squad-shaped stranger and {code:123} "none", socket open');
    else fail('(8) with the layer on: ' + JSON.stringify([r1, r2, r3]) + ' close ' + w._closed);
    // The squad frame still goes THROUGH the layer — only `code` is answered
    // ahead of it.
    const from = w._rx.length;
    tx(w, { type: 'squad', op: 'nope', id: 'n4' });
    const r4 = await waitFor(w, (m) => m.id === 'n4', from);
    if (same(r4, { type: 'squad', op: 'nope', error: 'unavailable', id: 'n4' }))
      ok('(8) a squad frame is still answered by the layer\'s own handleSquad');
    else fail('(8) a squad frame with the layer on answered ' + JSON.stringify(r4));
    w.close();
  }

  // ---- (9) a HELLO THAT HANGS ----------------------------------------------
  // hello, then friends, then code, on ONE socket. friends waits on the
  // pending hello — that is its job — and the code frame must not.
  {
    const w = await open(s.port);
    const authBefore = hung.auth;
    tx(w, { type: 'hello', token: 'tok-hang' });
    tx(w, { type: 'friends', id: 'fa' });
    for (let i = 0; i < 100 && hung.auth === authBefore; i++) await sleep(20);
    if (hung.auth === authBefore) fail('(9) the hello never reached GoTrue, so nothing below is pending');
    const t0 = Date.now();
    const r = await ask(w, { type: 'code', code: A, id: 'ka' }, 1500);
    const ms = Date.now() - t0;
    const friendsYet = w._rx.find((m) => m.id === 'fa');
    if (same(r, { type: 'code', kind: 'room', id: 'ka' }) && !friendsYet)
      ok(`(9) the code frame is answered in ${ms} ms while the hello is still pending (the friends frame behind it is unanswered)`);
    else fail('(9) with a hello pending, code answered ' + JSON.stringify(r) + ' and friends ' + JSON.stringify(friendsYet || null));
    w.close();
  }

  // ---- (10) a FRIENDS READ THAT HANGS ---------------------------------------
  // A signed-in socket whose friends frame is RUNNING — its hello has settled
  // and its first store query is held open — and then a code frame. A queued
  // frame would wait out every one of the read's store timeouts.
  {
    const w = await open(s.port);
    const before = hung.friends;
    tx(w, { type: 'hello', token: 'tok-linked' });
    tx(w, { type: 'friends', id: 'fq' });
    for (let i = 0; i < 150 && hung.friends === before; i++) await sleep(20);
    if (hung.friends === before) fail('(10) the friends read never reached PostgREST, so nothing below is queued behind it');
    const t0 = Date.now();
    const r = await ask(w, { type: 'code', code: A, id: 'kq' }, 1500);
    const ms = Date.now() - t0;
    const friendsYet = w._rx.find((m) => m.id === 'fq');
    if (same(r, { type: 'code', kind: 'room', id: 'kq' }) && !friendsYet)
      ok(`(10) the code frame is answered in ${ms} ms while a friends read on the same socket is still running`);
    else fail('(10) behind a running friends read, code answered ' + JSON.stringify(r) + ' and friends ' + JSON.stringify(friendsYet || null));
    w.close();
  }

  host.close();
  await sleep(100);
  // The one expected line: server.js warns when SUPABASE_URL differs from the
  // browser's config.js, which a local mock always does.
  const stray = strayLines(s, /^\[csp\] WARNING: public\/config\.js points the browser at /);
  if (stray.length === 0) ok('(11) the layer-on server printed nothing unexpected');
  else fail('(11) the layer-on server printed:\n      ' + stray.join('\n      '));
}

(async () => {
  await layerOff();
  await layerOn();
  return finish();
})().catch((e) => { fail('threw: ' + (e && e.stack ? e.stack : e)); finish(); });
