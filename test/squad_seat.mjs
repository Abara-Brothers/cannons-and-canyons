// Seating a whole squad into one room: the real seatSquad in server.js and the
// real abandonRoom in the engine (plan R2, R5, R6).
//
// WHY THIS FILE EXISTS AND test/squad.mjs IS NOT ENOUGH. seatSquad lives in
// server.js, which exports nothing and binds a port on import, so the only way
// to reach it is a real socket. test/squad.mjs injects a seatSquad of its own
// on purpose, to test the HANDLER — what it hands the seating and what it does
// with the answer — and a suite whose stub IS the thing under test proves only
// that something was called. This file drives the real one, over real
// sockets, into the real engine, so between the two nothing is invisible.
//
// SELF-HOSTED, like auth_sink.mjs, push_persist.mjs and code_frame.mjs: it
// spawns its own servers on free ports with SUPABASE_* pointed at a local mock
// of GoTrue and PostgREST. It never reaches a shared or a deployed server, so
// it ignores $WS.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
// SECTION A runs in THIS process against the real engine module — the idiom
// test/solo_engine.mjs and test/squad.mjs use. It touches the `rooms` Map of
// this process only; every server spawned below has its own.
import { rooms, handleClientMessage, abandonRoom } from '../public/room-engine.js';
import { LOADOUT_POOL } from '../public/game-core.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const FIVE = ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'];

// ---- SECTION A: abandonRoom, in process --------------------------------------
// A fake socket is all the engine needs: readyState for its send() gate, send()
// itself, and the roomCode/seat it hangs off the object.
const mkws = () => ({ readyState: 1, roomCode: null, seat: null, _rx: [], send(s) { this._rx.push(JSON.parse(s)); } });
const got = (ws, type) => ws._rx.filter((m) => m.type === type);
// A room built through the engine's own frames, then MARKED the way server.js's
// seatSquad marks the room it builds. The mark is what abandonRoom asks for:
// an ordinary player's room carries none, so the one door this project adds to
// the engine cannot be pointed at one.
const squadRoom = (mode, max, joiners) => {
  const host = mkws();
  handleClientMessage(host, { type: 'create', name: 'Ava', skin: 'olive', mode, max, loadout: FIVE });
  const guests = [];
  for (let i = 0; i < joiners; i++) {
    const g = mkws();
    handleClientMessage(g, { type: 'join', code: host.roomCode, name: 'Bo', skin: 'desert', loadout: FIVE });
    guests.push(g);
  }
  const room = rooms.get(host.roomCode);
  if (room) room.squad = 'SQD1';
  return { host, guests, code: host.roomCode, room };
};
const roomsAtStart = rooms.size;
{
  // A WAITING ROOM: a free-for-all for four with two seated, still in its lobby.
  const { host, guests: [guest], code, room } = squadRoom('ffa', 4, 1);
  if (!room || room.state !== 'waiting' || guest.roomCode !== code) {
    fail(`(A0) the fixture room was never built: code=${code} state=${room && room.state} seated=${guest.roomCode}`);
  } else {
    const r = abandonRoom(code, [host]);
    if (r === true && !rooms.has(code)) ok('(A1) abandonRoom deletes the squad room it is given and says so');
    else fail(`(A1) abandonRoom returned ${JSON.stringify(r)}, room still there: ${rooms.has(code)}`);
    // QUIET FOR OUR OWN, WHILE THE ROOM IS A LOBBY. The squad layer is about to
    // tell these sockets the real reason; an 'opponentLeft' on top of it is the
    // second, contradictory card public/app.js cannot dismiss (see the
    // engine's releasePriorRoom note), and a lobby has its own honest exit.
    if (got(host, 'opponentLeft').length === 0) ok('(A2) a socket listed in `own` is NOT sent opponentLeft while the room is still a lobby');
    else fail('(A2) the caller\'s own socket was sent opponentLeft: ' + JSON.stringify(host._rx.map((m) => m.type)));
    // LOUD FOR ANYONE ELSE. Nobody else is going to tell them the room is gone.
    if (got(guest, 'opponentLeft').length === 1) ok('(A3) a seat NOT in `own` is told the room went away, once');
    else fail('(A3) the outsider got ' + JSON.stringify(guest._rx.map((m) => m.type)));
    if (host.roomCode === null && host.seat === null && guest.roomCode === null && guest.seat === null)
      ok('(A4) every evicted socket is released — no client keeps a code that names nothing');
    else fail(`(A4) sockets still carry a code: host=${host.roomCode}/${host.seat} guest=${guest.roomCode}/${guest.seat}`);
  }
}
{
  // WHAT IT REFUSES. A code that names no room, and a code that is not a
  // string at all: the rooms Map is keyed by string and does not coerce, so an
  // array naming a live code must miss it — the class of hole task 3's review
  // found in the engine's mode lookup.
  const { host, code, room } = squadRoom('ffa', 4, 0);
  const odd = [['ZZZZ'], [[code]], [{ toString: () => code }], [123], [null], [undefined]];
  const said = odd.map(([c]) => abandonRoom(c, [host]));
  if (room && said.every((r) => r === false) && rooms.get(code) === room && host.roomCode === code && host._rx.every((m) => m.type !== 'opponentLeft'))
    ok('(A5) an unknown code, and a live code sent as an array, an object or a number, are refused and touch nothing');
  else fail('(A5) answers ' + JSON.stringify(said) + ' room kept ' + (rooms.get(code) === room) + ' host code ' + host.roomCode);
  abandonRoom(code, [host]);
}
{
  // AN ORDINARY PLAYER'S ROOM IS OUT OF REACH. A room nobody marked is not
  // one a squad start built, so it is refused whole: nothing torn down,
  // nobody told, nobody released.
  const host = mkws(), guest = mkws();
  handleClientMessage(host, { type: 'create', name: 'Ava', skin: 'olive', mode: 'ffa', max: 4, loadout: FIVE });
  const code = host.roomCode;
  handleClientMessage(guest, { type: 'join', code, name: 'Bo', skin: 'desert', loadout: FIVE });
  const room = rooms.get(code);
  const before = host._rx.length + guest._rx.length;
  const r = abandonRoom(code, [host, guest]);
  if (r === false && rooms.get(code) === room && room.state === 'waiting' && host.roomCode === code && guest.roomCode === code
    && host._rx.length + guest._rx.length === before)
    ok('(A6) a room no squad start built is refused: not torn down, nobody told, nobody released');
  else fail(`(A6) answered ${JSON.stringify(r)}, room kept ${rooms.get(code) === room}, codes ${host.roomCode}/${guest.roomCode}, frames +${host._rx.length + guest._rx.length - before}`);
  handleClientMessage(host, { type: 'leave' });
}
{
  // A ROOM THAT HAS ALREADY STARTED. A duel starts the instant its second seat
  // lands, so a squad room can be a live match by the time a later seat is
  // refused. Those clients are on the MATCH screen, where the squad's own
  // refusal is not drawn, and the one thing that takes them out of a match
  // whose room has gone is the 'Opponent left' card. So once the room is not
  // a lobby any more, everyone is told — our own sockets included.
  const { host, guests: [guest], code, room } = squadRoom('duel', 2, 1);
  if (!room || room.state !== 'playing') fail('(A7) the fixture duel never started: ' + (room && room.state));
  else {
    const r = abandonRoom(code, [host, guest]);
    if (r === true && !rooms.has(code) && got(host, 'opponentLeft').length === 1 && got(guest, 'opponentLeft').length === 1
      && host.roomCode === null && guest.roomCode === null)
      ok('(A7) a squad room that has already started tells every seat, its own included, and releases them');
    else fail(`(A7) answered ${JSON.stringify(r)}; opponentLeft host=${got(host, 'opponentLeft').length} guest=${got(guest, 'opponentLeft').length}; codes ${host.roomCode}/${guest.roomCode}`);
  }
}
{
  // `own` THAT IS NOT A LIST is nobody's: it must not throw out of the one
  // path that is cleaning up after a failure, and nobody is left untold.
  const said = [];
  for (const own of [5, 'x', null, { length: 1, 0: null }]) {
    const { host, code } = squadRoom('ffa', 4, 0);
    let r;
    try { r = abandonRoom(code, own); } catch (e) { r = 'threw ' + e.message; }
    said.push([r, rooms.has(code), got(host, 'opponentLeft').length]);
  }
  if (said.every(([r, kept, told]) => r === true && kept === false && told === 1))
    ok('(A8) an `own` that is not an array is treated as nobody\'s — no throw, the room goes, the seat is told');
  else fail('(A8) ' + JSON.stringify(said));
}
if (rooms.size === roomsAtStart) ok('(A9) section A leaves the rooms Map as it found it');
else fail(`(A9) rooms went from ${roomsAtStart} to ${rooms.size}`);

// ---- SECTION B: the real seatSquad, end to end -------------------------------
// Every server below is this checkout's server.js, spawned on a free port with
// the social layer ON against a local mock of GoTrue and PostgREST. Nothing in
// the seating is stubbed: the squad handler in server/social.js, the seatSquad
// server.js injects into it, and the engine's own create/join/startMatch.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall squad-seat checks passed');
  process.exit(out.errors.length ? 1 : 0);
};
// A WATCHDOG THAT GROWS WITH EVERY BOOT, for code_frame.mjs's reason: a fixed
// budget times out a suite that is merely slow on a loaded machine, and that
// refuses the owner's push for nothing. A genuine hang still ends the run.
let deadline = Date.now() + 30000;
const watchdog = setInterval(() => {
  if (Date.now() <= deadline) return;
  clearInterval(watchdog);
  fail('timeout — the suite overran its budget');
  finish();
}, 250);
watchdog.unref();

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Seven linked accounts, one token each. is_anonymous:false is what the
// sign-in gate reads, so every one of them may lead a squad.
const ID = (n) => `00000000-0000-4000-8000-5ea700000${String(n).padStart(3, '0')}`;
const TOKENS = new Map(Array.from({ length: 7 }, (_, i) => [`tok-${i + 1}`, ID(i + 1)]));
const mockHandler = (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/auth/v1/user') {
    const id = TOKENS.get((req.headers.authorization || '').replace(/^Bearer /, ''));
    return id ? json(200, { id, is_anonymous: false }) : json(401, {});
  }
  // NOBODY HAS BLOCKED ANYBODY and nobody has a profile row: every read is an
  // empty list. Names are not this file's subject (test/squad.mjs proves them),
  // and a squad that could not form would make every check below pass for the
  // wrong reason — which is why each world proves its squad formed first.
  if (req.method === 'GET') return json(200, []);
  res.writeHead(204); res.end();
};

async function boot(extra = {}) {
  deadline += 20000;
  if (!mock) {
    mock = http.createServer(mockHandler);
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  }
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), SUPABASE_URL: `http://127.0.0.1:${mock.address().port}`,
    SUPABASE_PUBLISHABLE_KEY: 'pk_test', SUPABASE_SECRET_KEY: 'sk_test', SOCIAL_PRESENCE_MS: '600000', ...extra };
  const s = { port, log: '', proc: spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }) };
  s.proc.stdout.on('data', (d) => { s.log += d; });
  s.proc.stderr.on('data', (d) => { s.log += d; });
  servers.push(s);
  for (let i = 0; i < 100 && !/running at/.test(s.log); i++) await sleep(100);
  if (!/running at/.test(s.log)) { fail('a server never reported listening:\n' + s.log); return null; }
  // PRECONDITION: THE SOCIAL LAYER IS ON. A friends frame from a socket that
  // never said hello reaches the layer's own gate, which answers sign_in; the
  // layer-off branch in server.js would answer 'unavailable' instead, and then
  // every squad frame below would be refused for the wrong reason.
  const w = await open(port);
  put(w, { type: 'friends', id: 'pre' });
  const r = await wait(w, (m) => m.id === 'pre');
  w.close();
  if (!(r && r.type === 'social' && r.error === 'sign_in')) { fail('the social layer is not on in this server: friends answered ' + JSON.stringify(r)); return null; }
  return s;
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
const put = (ws, m) => ws.send(JSON.stringify(m));
// The first frame at or after index `from` that matches, or null after `ms`.
const wait = async (ws, pick, ms = 5000, from = 0) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = ws._rx.slice(from).find(pick);
    if (m) return m;
    await sleep(10);
  }
  return null;
};
const seen = (ws, type) => ws._rx.filter((m) => m.type === type);
const types = (ws) => ws._rx.map((m) => (m.type === 'squad' ? 'squad:' + m.op : m.type));
// Ask one squad op and wait for ITS answer, by request id.
let reqSeq = 0;
const ask = async (ws, frame, ms = 5000) => {
  const id = 'q' + (++reqSeq);
  put(ws, { type: 'squad', ...frame, id });
  return wait(ws, (m) => m.id === id, ms);
};
// Settle: nothing new arrives on any of these sockets for `quiet` ms. Used
// before asserting that something did NOT happen, so a late frame cannot be
// missed by looking too early.
const settle = async (socks, quiet = 250) => {
  let n = -1;
  for (let i = 0; i < 40; i++) {
    const now = socks.reduce((a, w) => a + w._rx.length, 0);
    if (now === n) return;
    n = now;
    await sleep(quiet);
  }
};
// A different rack for every seat, so each seat's rack can be told apart in
// the room the engine builds.
const RACK = (i, n = 5) => LOADOUT_POOL.slice(i, i + n);

// One signed-in socket. Every squad frame after the hello waits on it in
// server.js (ws.authPending), so no sleep is needed between them.
async function pilot(port, n) {
  const ws = await open(port);
  if (n) put(ws, { type: 'hello', token: `tok-${n}` });
  return ws;
}
// A squad of the given pilots, leader first, the armed mode set, and every
// member ready with a rack of its own unless `ready` says otherwise. Every
// step is answered before the next is sent, and every answer is checked, so
// no world below can pass because its squad never formed.
async function squadUp(port, pilots, mode = 'duel', { ready = pilots.map(() => true), tees } = {}) {
  const ws = [];
  for (const n of pilots) ws.push(await pilot(port, n));
  const made = await ask(ws[0], { op: 'create' });
  if (!(made && made.op === 'state' && typeof made.code === 'string')) { fail('squad create was answered ' + JSON.stringify(made)); return null; }
  for (let i = 1; i < ws.length; i++) {
    const j = await ask(ws[i], { op: 'join', code: made.code, name: 'Pilot' + pilots[i], skin: 'desert' });
    if (!(j && j.op === 'state' && j.you === i)) { fail(`squad join for member ${i} was answered ` + JSON.stringify(j)); return null; }
  }
  if (mode !== 'duel') {
    const m = await ask(ws[0], { op: 'mode', mode, tees });
    if (!(m && m.ok === true)) { fail('squad mode was answered ' + JSON.stringify(m)); return null; }
  }
  const n = mode === 'boss' || mode === 'aliens' ? 7 : 5;
  for (let i = 0; i < ws.length; i++) {
    if (!ready[i]) continue;
    const r = await ask(ws[i], { op: 'ready', ready: true, loadout: RACK(i, n) });
    if (!(r && r.ok === true)) { fail(`squad ready for member ${i} was answered ` + JSON.stringify(r)); return null; }
  }
  await settle(ws, 100);
  return { ws, code: made.code, racks: ws.map((_, i) => RACK(i, n)) };
}
const closeAll = async (socks) => { for (const w of socks) try { w.close(); } catch {} await sleep(50); };
// EVERY ROOM CODE THESE SOCKETS WERE EVER SHOWN MUST BE DEAD, asked of the
// engine by a stranger's `join`. After a refused start there should be none at
// all; if a gate upstream ever lets a room be built, this is what says whether
// the refusal left it standing.
const liveCodes = async (port, socks) => {
  const codes = [...new Set(socks.flatMap((w) => seen(w, 'created').map((m) => m.code)))];
  const live = [];
  for (const code of codes) {
    const x = await open(port);
    put(x, { type: 'join', code, name: 'Nomad', skin: 'gold', loadout: RACK(0) });
    const r = await wait(x, (m) => m.type === 'joinError' || m.type === 'lobby' || m.type === 'start');
    if (!(r && r.type === 'joinError' && r.reason === 'No game with that code.')) live.push([code, r && (r.reason || r.type)]);
    x.close();
  }
  return live;
};
// Nothing on a server's output beyond its banner, the [boot] line, and the one
// expected warning (a local mock is never the browser's config.js Supabase).
const strayLines = (s, extra) => s.log.split('\n').filter((l) => l.trim()
  && !/running at|^\[boot\]|^\[shutdown\] SIGTERM|^\[csp\] WARNING: public\/config\.js points the browser at /.test(l)
  && !(extra && extra.test(l)));

async function sectionB() {
  const S = await boot();
  if (!S) return;

  // ---- B1. four on a free-for-all: one room, sized to the squad, and the
  // LAST member is the seat that starts it (R5) -----------------------------
  {
    const s = await squadUp(S.port, [1, 2, 3, 4], 'ffa');
    if (s) {
      const answer = await ask(s.ws[0], { op: 'start' });
      const starts = [];
      for (const w of s.ws) starts.push(await wait(w, (m) => m.type === 'start'));
      if (answer && answer.ok === true && typeof answer.code === 'string' && starts.every((m) => m && m.code === answer.code))
        ok(`(B1) all four members are in the same room (${answer.code}) and the match is running`);
      else fail('(B1) answer=' + JSON.stringify(answer) + ' start codes=' + JSON.stringify(starts.map((m) => m && m.code)));
      const created = seen(s.ws[0], 'created')[0];
      if (created && created.mode === 'ffa' && created.max === 4 && seen(s.ws[1], 'created').length === 0)
        ok('(B1) the leader created the room, sized to the squad — max 4, so the fourth seat is the last seat');
      else fail('(B1) created frames: ' + JSON.stringify([created, seen(s.ws[1], 'created')]));
      // R5 MADE VISIBLE. The leader is seated first and watches the lobby
      // fill; the last member never sees a lobby at all, because their join
      // is the one that fills the room and the engine starts it on the spot.
      if (seen(s.ws[0], 'lobby').length === 3 && seen(s.ws[1], 'lobby').length === 2 && seen(s.ws[2], 'lobby').length === 1 && seen(s.ws[3], 'lobby').length === 0)
        ok('(B1) seated leader first and then in roster order: lobbies seen 3, 2, 1, 0 — the last member landed straight in the match');
      else fail('(B1) lobby counts ' + JSON.stringify(s.ws.map((w) => seen(w, 'lobby').length)));
      // EACH SEAT KEEPS ITS OWN RACK, in roster order, and nobody is sent to
      // the pick screen — the rack the squad readied with is the rack the
      // room was handed.
      const st = starts[0] || {};
      if (JSON.stringify(st.loadouts) === JSON.stringify(s.racks) && st.pick === undefined && starts.every((m, i) => m && m.you === i))
        ok('(B1) every seat carries its own member\'s rack, seat i is member i, and nobody drafts again');
      else fail('(B1) start: loadouts=' + JSON.stringify(st.loadouts) + ' pick=' + JSON.stringify(st.pick) + ' you=' + JSON.stringify(starts.map((m) => m && m.you)));
      // THE WIRE ORDER, for the client tasks: on every socket the engine's own
      // room frames come first and the squad's start frame after them; the
      // members' copy is unsolicited (no id), and then each is pushed the
      // roster, in which every Ready has been spent.
      await settle(s.ws);
      const order = s.ws.map((w) => {
        const t = types(w);
        const lastRoom = Math.max(t.lastIndexOf('created'), t.lastIndexOf('lobby'), t.lastIndexOf('start'));
        const sq = t.indexOf('squad:start');
        const st2 = w._rx.slice(sq + 1).find((m) => m.type === 'squad' && m.op === 'state');
        return { lastRoom, sq, n: t.filter((x) => x === 'squad:start').length, id: (w._rx[sq] || {}).id, spent: !!st2 && st2.members.every((m) => m.ready === false) };
      });
      if (order.every((o) => o.lastRoom >= 0 && o.sq > o.lastRoom && o.n === 1) && order[0].id !== undefined && order.slice(1).every((o) => o.id === undefined))
        ok('(B1) every member hears the room from the engine first and the squad\'s one start frame after it; only the leader\'s carries the id');
      else fail('(B1) wire order ' + JSON.stringify(order) + ' ' + JSON.stringify(s.ws.map(types)));
      // The leader's roster may come before its answer (pushSquad's order: the
      // answer is the send that can throw, so it goes last); the members'
      // comes after their start frame. Either way the Readies are spent.
      const leaderState = s.ws[0]._rx.filter((m) => m.type === 'squad' && m.op === 'state').pop();
      if (order.slice(1).every((o) => o.spent) && leaderState && leaderState.members.every((m) => m.ready === false))
        ok('(B1) the start spends every Ready — each member is pushed a roster with nobody ready');
      else fail('(B1) readies after the start: ' + JSON.stringify(order.map((o) => o.spent)) + ' leader ' + JSON.stringify(leaderState && leaderState.members));
      await closeAll(s.ws);
    }
  }

  // ---- B2. leader only, and a stale leader after a hand-off -----------------
  {
    const s = await squadUp(S.port, [1, 2], 'duel');
    if (s) {
      const [a, b] = s.ws;
      const x = await ask(b, { op: 'start' });
      await settle([a, b]);
      if (x && x.error === 'not_leader' && x.id) ok('(B2) a member pressing Start is refused not_leader, with the request id echoed');
      else fail('(B2) a member got ' + JSON.stringify(x));
      // THE CONTROL: nothing was built. Without it "always refuse" would pass.
      if (!types(a).concat(types(b)).some((t) => t === 'created' || t === 'lobby' || t === 'start'))
        ok('(B2) a refused start builds no room at all');
      else fail('(B2) room frames behind a refusal: ' + JSON.stringify([types(a), types(b)]));
      // THE HAND-OFF. The leader leaves, the member inherits, and the old
      // leader comes back as a member: their Start is refused like anyone's.
      const left = await ask(a, { op: 'leave' });
      const back = await ask(a, { op: 'join', code: s.code, name: 'Pilot1', skin: 'olive' });
      const rd = await ask(a, { op: 'ready', ready: true, loadout: RACK(3) });
      const stale = await ask(a, { op: 'start' });
      if (left && left.op === 'left' && back && back.op === 'state' && back.leader === ID(2) && rd && rd.ok && stale && stale.error === 'not_leader')
        ok('(B2) a stale leader after a hand-off gets not_leader');
      else fail('(B2) hand-off: ' + JSON.stringify({ left, leader: back && back.leader, rd, stale }));
      // And the new leader can, so the gate is about WHO and not about the op.
      const good = await ask(b, { op: 'start' });
      const aStart = await wait(a, (m) => m.type === 'start');
      if (good && good.ok === true && aStart && aStart.code === good.code && seen(a, 'lobby').length === 0 && seen(b, 'created').length === 1)
        ok('(B2) the new leader starts the duel, hosts it, and the second seat goes straight into the match');
      else fail('(B2) new leader start: ' + JSON.stringify(good) + ' second seat ' + JSON.stringify(aStart && aStart.code) + ' ' + JSON.stringify([types(a), types(b)]));
      await closeAll(s.ws);
    }
  }

  // ---- B13. the leader takes the host seat, wherever they sit in the roster --
  // Leadership passes to the earliest-joined SIGNED-IN member, so a guest who
  // joined earlier can sit above the leader in the roster. The host seat is the
  // leader's all the same: the create makes its socket seat 0, and a guest can
  // never hold what the host holds (startMatch, the rematch).
  {
    const a = await pilot(S.port, 1), g = await open(S.port), c = await pilot(S.port, 3);
    const made = await ask(a, { op: 'create' });
    const jg = await ask(g, { op: 'join', code: made && made.code, name: 'Guest', skin: 'gold' });
    const jc = await ask(c, { op: 'join', code: made && made.code, name: 'Pilot3', skin: 'olive' });
    await ask(a, { op: 'leave' });
    const rg = await ask(g, { op: 'ready', ready: true, loadout: RACK(1) });
    const rc = await ask(c, { op: 'ready', ready: true, loadout: RACK(2) });
    const roster = (c._rx.filter((m) => m.type === 'squad' && m.op === 'state').pop() || {});
    const go = await ask(c, { op: 'start' });
    const gs = await wait(g, (m) => m.type === 'start');
    const cs = await wait(c, (m) => m.type === 'start');
    if (jg && jg.you === 1 && jc && jc.you === 2 && rg && rg.ok && rc && rc.ok && roster.leader === ID(3) && roster.you === 1
      && go && go.ok && seen(c, 'created').length === 1 && seen(g, 'created').length === 0 && cs && cs.you === 0 && gs && gs.you === 1)
      ok('(B13) a leader who sits below a guest in the roster still takes the host seat, and the guest is seated after them');
    else fail('(B13) ' + JSON.stringify({ roster: [roster.leader, roster.you], go, c: types(c), g: types(g), cs: cs && cs.you, gs: gs && gs.you }));
    await closeAll([a, g, c]);
  }

  // ---- B3. every member ready, and the Readies are spent by the start --------
  {
    const s = await squadUp(S.port, [1, 2, 3], 'ffa', { ready: [true, true, false] });
    if (s) {
      const before = s.ws.map((w) => w._rx.length);
      const a = await ask(s.ws[0], { op: 'start' });
      await settle(s.ws);
      // NOTHING AT ALL reaches the members: a refusal before the seating
      // changes nothing, so there is nothing to push.
      if (a && a.error === 'not_ready' && s.ws[1]._rx.length === before[1] && s.ws[2]._rx.length === before[2]
        && !seen(s.ws[0], 'created').length && !seen(s.ws[0], 'lobby').length)
        ok('(B3) one member not ready refuses the start; nothing is built and the members are sent nothing');
      else fail('(B3) one not ready: ' + JSON.stringify(a) + ' ' + JSON.stringify(s.ws.map(types)));
      const r = await ask(s.ws[2], { op: 'ready', ready: true, loadout: RACK(2) });
      const b = await ask(s.ws[0], { op: 'start' });
      const made = await wait(s.ws[0], (m) => m.type === 'created');
      if (r && r.ok && b && b.ok === true && made && made.max === 3) ok('(B3) with all three ready the squad rolls out, into a free-for-all sized for three');
      else fail('(B3) the full squad: ' + JSON.stringify([r, b, made]));
      // THE READIES ARE SPENT (design 4.3), so a second Start with nobody
      // re-readying is refused for that reason — and builds nothing.
      await settle(s.ws);
      const createdBefore = s.ws.map((w) => seen(w, 'created').length);
      const c = await ask(s.ws[0], { op: 'start' });
      await settle(s.ws);
      if (c && c.error === 'not_ready' && JSON.stringify(s.ws.map((w) => seen(w, 'created').length)) === JSON.stringify(createdBefore))
        ok('(B3) a second Start with the Readies spent is not_ready — the next start needs fresh ones');
      else fail('(B3) second start: ' + JSON.stringify(c));
      await closeAll(s.ws);
    }
  }

  // ---- B4. the squad must fit the armed mode, and every seat must be live ----
  {
    // TOO MANY: three on a duel.
    const s = await squadUp(S.port, [1, 2, 3], 'duel');
    if (s) {
      const a = await ask(s.ws[0], { op: 'start' });
      await settle(s.ws);
      if (a && a.error === 'wont_fit' && !s.ws.some((w) => seen(w, 'created').length || seen(w, 'lobby').length || seen(w, 'start').length))
        ok('(B4) three on a duel is refused wont_fit, and no room is built to be wrong');
      else fail('(B4) three on a duel: ' + JSON.stringify(a) + ' ' + JSON.stringify(s.ws.map(types)));
      // AND NOBODY IS LEFT SEATED ANYWHERE, asked of the engine itself: `sync`
      // answers a seat in a live match with a `restore`, and nothing else.
      const from = s.ws.map((w) => w._rx.length);
      for (const w of s.ws) put(w, { type: 'sync' });
      await settle(s.ws);
      if (s.ws.every((w, i) => !w._rx.slice(from[i]).some((m) => m.type === 'restore' || m.type === 'opponentLeft')))
        ok('(B4) after the refusal no member holds a seat in any match');
      else fail('(B4) after the refusal: ' + JSON.stringify(s.ws.map((w, i) => w._rx.slice(from[i]).map((m) => m.type))));
      const left = await liveCodes(S.port, s.ws);
      if (left.length === 0) ok('(B4) and no room it was ever shown is left standing');
      else fail('(B4) rooms left standing after the refusal: ' + JSON.stringify(left));
      // A CLOSED SOCKET. Arm a mode the three fit, then one member's socket
      // goes. The engine's join would SEAT a closed socket — it never looks —
      // so this gate is the only thing between the squad and a ghost seat.
      const m = await ask(s.ws[0], { op: 'mode', mode: 'ffa' });
      s.ws[2].close();
      for (let i = 0; i < 100 && s.ws[2]._closed === null; i++) await sleep(10);
      const b = await ask(s.ws[0], { op: 'start' });
      await settle(s.ws.slice(0, 2));
      if (m && m.ok && s.ws[2]._closed !== null && b && b.error === 'member_offline'
        && !s.ws.slice(0, 2).some((w) => seen(w, 'created').length || seen(w, 'lobby').length))
        ok('(B4) a member whose socket has closed stops the start (member_offline), and nothing is built');
      else fail('(B4) closed member: ' + JSON.stringify([m, b]) + ' ' + JSON.stringify(s.ws.map(types)));
      await closeAll(s.ws);
    }
    // TOO FEW: fits is a MINIMUM too (plan X6). A squad of one does not start
    // a duel.
    const one = await squadUp(S.port, [4], 'duel');
    if (one) {
      const c = await ask(one.ws[0], { op: 'start' });
      await settle(one.ws);
      if (c && c.error === 'wont_fit' && seen(one.ws[0], 'created').length === 0) ok('(B4) a squad of one on a duel is refused wont_fit — fits has a minimum');
      else fail('(B4) one on a duel: ' + JSON.stringify(c) + ' ' + JSON.stringify(types(one.ws[0])));
      const left = await liveCodes(S.port, one.ws);
      if (left.length === 0) ok('(B4) and the squad of one is left in no room');
      else fail('(B4) rooms left standing after the one-on-a-duel refusal: ' + JSON.stringify(left));
      await closeAll(one.ws);
    }
  }

  // ---- B5. a member sitting alone in a lobby of their own is moved ----------
  // Seating a member who hosts an empty lobby ends that lobby, and quietly:
  // releasePriorRoom's lone-host branch is teardown(prev, FALSE), so no
  // 'Opponent left' card lands on top of the squad's match.
  {
    const s = await squadUp(S.port, [1, 2], 'duel');
    if (s) {
      const [a, b] = s.ws;
      put(b, { type: 'create', name: 'Pilot2', skin: 'desert', mode: 'ffa', max: 4, loadout: RACK(1) });
      const own = await wait(b, (m) => m.type === 'created');
      const go = await ask(a, { op: 'start' });
      const mine = await wait(b, (m) => m.type === 'start');
      if (own && go && go.ok && mine && mine.code === go.code && mine.code !== own.code)
        ok('(B5) a member hosting an empty lobby of their own is moved into the squad\'s room');
      else fail('(B5) member landed in ' + JSON.stringify(mine && mine.code) + ' (their own was ' + JSON.stringify(own && own.code) + ') answer ' + JSON.stringify(go));
      await settle(s.ws);
      if (seen(b, 'opponentLeft').length === 0) ok('(B5) and is told nothing about the lobby they left — no "Opponent left" card on the match');
      else fail('(B5) the member was sent opponentLeft: ' + JSON.stringify(types(b)));
      // AND IT REALLY IS GONE — the half a stale code would hide.
      const stranger = await open(S.port);
      put(stranger, { type: 'join', code: own && own.code, name: 'Nomad', skin: 'gold', loadout: RACK(0) });
      const refused = await wait(stranger, (m) => m.type === 'joinError');
      if (refused && refused.reason === 'No game with that code.') ok('(B5) the lobby they hosted was torn down, not orphaned');
      else fail('(B5) their old lobby still answers: ' + JSON.stringify(refused));
      // THE ORDINARY EXIT STILL WORKS: a squad-seated room is an ordinary room,
      // so the lobby Cancel's `leave` reaches the other seat.
      const from = a._rx.length;
      put(b, { type: 'leave' }); put(b, { type: 'cancelQuick' });
      const told = await wait(a, (m) => m.type === 'oppConn' || m.type === 'opponentLeft', 3000, from);
      if (told) ok('(B5) leaving a squad-seated room reaches the other seat like leaving any room');
      else fail('(B5) leaving told the other seat nothing');
      await closeAll([stranger, ...s.ws]);
    }
  }

  // ---- B7. nobody is pulled out of a game somebody else is in --------------
  // The engine treats a socket that creates or joins a room as LEAVING the one
  // it holds (releasePriorRoom). A player choosing that is one thing; a squad
  // Start choosing it for them is another: mid-match, their tank is scuttled
  // after the grace and the ledger records the loss; in a lobby with someone
  // else in it, that player's lobby is destroyed or loses a seat. So a member
  // who is in a game — a match in progress, or a lobby with anyone else in it —
  // stops the start, and their game is not touched.
  {
    const s = await squadUp(S.port, [1, 2], 'duel');
    if (s) {
      const [a, b] = s.ws;
      put(b, { type: 'ai', name: 'Pilot2', skin: 'desert', difficulty: 'easy', loadout: RACK(1) });
      const cpu = await wait(b, (m) => m.type === 'start');
      await settle(s.ws);
      const before = types(b).length;
      const x = await ask(a, { op: 'start' });
      await settle(s.ws);
      const after = b._rx.slice(before).map((m) => (m.type === 'squad' ? 'squad:' + m.op : m.type));
      put(b, { type: 'sync' });
      const still = await wait(b, (m) => m.type === 'restore', 3000, before);
      if (cpu && x && x.error === 'member_busy' && !after.some((t) => ['created', 'lobby', 'start', 'opponentLeft', 'oppConn'].includes(t))
        && still && still.code === cpu.code && seen(a, 'created').length === 0)
        ok('(B7) a member mid-match (against the CPU) stops the start: member_busy, and their match is untouched');
      else fail('(B7) mid-match member: answer ' + JSON.stringify(x) + ' member then got ' + JSON.stringify(after) + ' still in ' + JSON.stringify(still && still.code) + ' was in ' + JSON.stringify(cpu && cpu.code));
      await closeAll(s.ws);
    }
  }
  {
    const s = await squadUp(S.port, [1, 2], 'duel');
    if (s) {
      const [a, b] = s.ws;
      put(b, { type: 'create', name: 'Pilot2', skin: 'desert', mode: 'ffa', max: 4, loadout: RACK(1) });
      const own = await wait(b, (m) => m.type === 'created');
      const stranger = await open(S.port);
      put(stranger, { type: 'join', code: own && own.code, name: 'Nomad', skin: 'gold', loadout: RACK(0) });
      const inLobby = await wait(stranger, (m) => m.type === 'lobby');
      await settle([a, b, stranger]);
      const before = stranger._rx.length;
      const x = await ask(a, { op: 'start' });
      await settle([a, b, stranger]);
      const late = stranger._rx.slice(before).map((m) => m.type);
      const late2 = await open(S.port);
      put(late2, { type: 'join', code: own && own.code, name: 'Rover', skin: 'olive', loadout: RACK(2) });
      const lobby3 = await wait(late2, (m) => m.type === 'lobby' || m.type === 'joinError');
      if (inLobby && x && x.error === 'member_busy' && late.length === 0 && lobby3 && lobby3.type === 'lobby' && lobby3.players.filter(Boolean).length === 3)
        ok('(B7) a member hosting a lobby a stranger is in stops the start: member_busy, and the stranger\'s lobby is untouched');
      else fail('(B7) lobby with a stranger: answer ' + JSON.stringify(x) + ' stranger then got ' + JSON.stringify(late) + ' lobby now ' + JSON.stringify(lobby3));
      await closeAll([stranger, late2, ...s.ws]);
    }
  }

  // ---- B8. a member waiting in the quick-match queue leaves it --------------
  // The engine pairs whoever is in its one-socket queue with the next quick
  // seeker. A member seated into the squad's room while still queued would be
  // paired a moment later — and pairing is a create, so the squad's match
  // would lose them. Seating takes every seat out of the queue first.
  {
    const s = await squadUp(S.port, [1, 2], 'duel');
    if (s) {
      const [a, b] = s.ws;
      put(b, { type: 'quick', name: 'Pilot2', skin: 'desert', loadout: RACK(1) });
      const queued = await wait(b, (m) => m.type === 'queued');
      const go = await ask(a, { op: 'start' });
      const seated = await wait(b, (m) => m.type === 'start');
      const seeker = await open(S.port);
      put(seeker, { type: 'quick', name: 'Nomad', skin: 'gold', loadout: RACK(0) });
      const first = await wait(seeker, (m) => m.type === 'queued' || m.type === 'start');
      await settle([a, b, seeker]);
      if (queued && go && go.ok && seated && seated.code === go.code && first && first.type === 'queued'
        && seen(b, 'start').length === 1 && seen(b, 'oppConn').length === 0 && seen(a, 'oppConn').length === 0)
        ok('(B8) a queued member is seated and taken out of the queue — the next quick seeker waits instead of taking them');
      else fail('(B8) queue: ' + JSON.stringify({ queued: !!queued, go, seated: seated && seated.code, seeker: first && first.type, b: types(b), a: types(a) }));
      put(seeker, { type: 'cancelQuick' });
      await closeAll([seeker, ...s.ws]);
    }
  }

  // ---- B9. the match begins in every mode, a squad of one included ----------
  // R5's auto-start covers a duel's second seat and a full ffa or golf room.
  // A raid (boss, aliens) is seated at two and a squad of one leaves it one
  // short, so the engine would hold the leader in a lobby with an open seat.
  // The host's own `startMatch` is how a lone commander starts one anywhere
  // else, and seating sends it. Golf of one is the engine's solo round, and
  // the armed tee set is the one the room plays.
  for (const [mode, n, want] of [['boss', 1, 2], ['aliens', 1, 4], ['boss', 2, 3], ['golf', 1, 1], ['golf', 3, 3]]) {
    const s = await squadUp(S.port, [1, 2, 3].slice(0, n), mode, mode === 'golf' ? { tees: 'champ' } : {});
    if (!s) continue;
    const go = await ask(s.ws[0], { op: 'start' });
    const st = [];
    for (const w of s.ws) st.push(await wait(w, (m) => m.type === 'start'));
    const tee = mode === 'golf' ? st[0] && st[0].golf && st[0].golf.teeSet : 'n/a';
    if (go && go.ok === true && st.every((m) => m && m.code === go.code && m.n === want) && (mode !== 'golf' || tee === 'champ'))
      ok(`(B9) ${mode} for ${n}: the match is running as the start is answered (${want} seat(s)${mode === 'golf' ? ', champ tees' : ''})`);
    else fail(`(B9) ${mode} for ${n}: answer ${JSON.stringify(go)} starts ${JSON.stringify(st.map((m) => m && { code: m.code, n: m.n }))} tees ${JSON.stringify(tee)} ${JSON.stringify(s.ws.map(types))}`);
    await closeAll(s.ws);
  }

  // ---- B10. the leader's rack on the start frame -----------------------------
  // The Squad box sends the leader's picks WITH Start rather than a separate
  // Ready. They stand in for the leader's Ready, judged by the ready op's own
  // predicate, and are not kept: a refused start changes nothing.
  {
    const s = await squadUp(S.port, [1, 2, 3], 'ffa', { ready: [false, true, false] });
    if (s) {
      const [a, , c] = s.ws;
      const bad = await ask(a, { op: 'start', loadout: RACK(0, 7) });
      const bad2 = await ask(a, { op: 'start', loadout: ['junk'] });
      const bad3 = await ask(a, { op: 'start', loadout: 'mortar' });
      const early = await ask(a, { op: 'start', loadout: RACK(4) });
      const rc = await ask(c, { op: 'ready', ready: true, loadout: RACK(2) });
      const without = await ask(a, { op: 'start' });
      await settle(s.ws);
      const built = s.ws.some((w) => seen(w, 'created').length || seen(w, 'lobby').length);
      if ([bad, bad2, bad3].every((r) => r && r.error === 'no_rack') && early && early.error === 'not_ready' && rc && rc.ok
        && without && without.error === 'not_ready' && !built)
        ok('(B10) a start frame carrying something that is not a rack is no_rack; a refused start kept nothing — the leader is still not ready');
      else fail('(B10) refusals: ' + JSON.stringify({ bad, bad2, bad3, early, rc, without, built }));
      const go = await ask(a, { op: 'start', loadout: RACK(4) });
      const st = await wait(a, (m) => m.type === 'start');
      if (go && go.ok && st && JSON.stringify(st.loadouts) === JSON.stringify([RACK(4), RACK(1), RACK(2)]))
        ok('(B10) the leader\'s rack on the frame stands in for their Ready, and it is the rack their seat keeps');
      else fail('(B10) frame rack: ' + JSON.stringify(go) + ' loadouts ' + JSON.stringify(st && st.loadouts));
      await closeAll(s.ws);
    }
  }

  // ---- B11. ledSquad, both halves, over the wire -----------------------------
  {
    // THE ACCOUNT ALONE IS NOT LEADERSHIP. Squad Y is led by pilot 2 and is
    // ready to go. Socket g holds a GUEST row in squad X, then signs in as
    // pilot 2. Start from g must not start Y, which its account leads from
    // another device.
    const y = await squadUp(S.port, [2, 3], 'duel');
    const x = await squadUp(S.port, [1], 'duel');
    if (x && y) {
      const g = await open(S.port);
      const j = await ask(g, { op: 'join', code: x.code, name: 'Guest', skin: 'gold' });
      put(g, { type: 'hello', token: 'tok-2' });
      const r = await ask(g, { op: 'start' });
      await settle([g, ...x.ws, ...y.ws]);
      const built = [g, ...x.ws, ...y.ws].some((w) => seen(w, 'created').length || seen(w, 'start').length);
      if (j && j.op === 'state' && j.you === 1 && r && r.error === 'not_leader' && !built)
        ok('(B11) a socket holding a guest row cannot start the squad its account leads from another device');
      else fail('(B11) cross-squad start: ' + JSON.stringify({ j: j && j.you, r, built }));
      await closeAll([g, ...x.ws, ...y.ws]);
    }
  }
  {
    // THE ROW ALONE IS NOT LEADERSHIP. The leader's socket signs in as someone
    // else and still holds the leader's row.
    const s = await squadUp(S.port, [1, 2], 'duel');
    if (s) {
      put(s.ws[0], { type: 'hello', token: 'tok-5' });
      const r = await ask(s.ws[0], { op: 'start' });
      await settle(s.ws);
      if (r && r.error === 'not_leader' && !s.ws.some((w) => seen(w, 'created').length || seen(w, 'start').length))
        ok('(B11) a socket now signed in as someone else cannot start from the leader\'s row it still holds');
      else fail('(B11) account-switched start: ' + JSON.stringify(r) + ' ' + JSON.stringify(s.ws.map(types)));
      await closeAll(s.ws);
    }
  }

  // ---- B12. a second device of the leader starts the squad the rows hold -----
  // ledSquad lets a second device of the leader act as the leader (kick, mode,
  // and now start). The squad seats the sockets it KNOWS — the rows — so the
  // leader's seat is the socket on the leader's row, and the device that asked
  // is answered and seated nowhere.
  {
    const s = await squadUp(S.port, [1, 2], 'duel');
    if (s) {
      const other = await pilot(S.port, 1);
      const go = await ask(other, { op: 'start' });
      const host = await wait(s.ws[0], (m) => m.type === 'start');
      await settle([other, ...s.ws]);
      if (go && go.ok === true && host && host.code === go.code && seen(s.ws[0], 'created').length === 1
        && !types(other).some((t) => ['created', 'lobby', 'start'].includes(t)))
        ok('(B12) the leader\'s second device starts the squad; the leader\'s row socket takes the host seat, the asking device is only answered');
      else fail('(B12) second device: ' + JSON.stringify(go) + ' row got ' + JSON.stringify(types(s.ws[0])) + ' asker got ' + JSON.stringify(types(other)));
      await closeAll([other, ...s.ws]);
    }
  }

  const stray = strayLines(S);
  if (stray.length === 0) ok('(B*) the server printed nothing unexpected');
  else fail('(B*) the server printed:\n      ' + stray.join('\n      '));

  // ---- B6. R6 at capacity: nobody is half seated and everybody is told ------
  // A second server with MAX_ROOMS=1. One ordinary room fills the cap, so the
  // squad's create is refused by the engine and the whole start fails as one.
  {
    const C = await boot({ MAX_ROOMS: '1' });
    if (C) {
      const hog = await open(C.port);
      put(hog, { type: 'create', name: 'Hog', skin: 'olive', mode: 'ffa', max: 4, loadout: RACK(0) });
      const full = await wait(hog, (m) => m.type === 'created');
      const s = await squadUp(C.port, [5, 6], 'duel');
      if (full && s) {
        const [a, b] = s.ws;
        const x = await ask(a, { op: 'start' });
        const told = await wait(b, (m) => m.type === 'squad' && m.op === 'start');
        await settle(s.ws);
        if (x && x.error === 'capacity') ok('(B6) the leader is told capacity, with the id echoed');
        else fail('(B6) the leader got ' + JSON.stringify(x));
        // R6: EVERY member, not only the one who asked.
        if (told && told.error === 'capacity' && told.id === undefined) ok('(B6) the member who sent nothing is told the same, unsolicited');
        else fail('(B6) the member got ' + JSON.stringify(told));
        if (!s.ws.some((w) => seen(w, 'created').length || seen(w, 'lobby').length || seen(w, 'start').length))
          ok('(B6) no member is left standing in a room that half existed');
        else fail('(B6) room frames: ' + JSON.stringify(s.ws.map(types)));
        // A REFUSED START SPENDS NOTHING. Free the cap and the same squad
        // starts without anybody touching Ready again.
        put(hog, { type: 'leave' });
        await settle([hog]);
        const y = await ask(a, { op: 'start' });
        const st = await wait(b, (m) => m.type === 'start');
        if (y && y.ok === true && st && st.code === y.code) ok('(B6) once there is room, the same squad starts with the Readies it already had');
        else fail('(B6) retry: ' + JSON.stringify(y));
        await closeAll(s.ws);
      }
      await closeAll([hog]);
      // The one line this server is expected to print: the engine's capacity
      // sink, announcing the refusal B6 provoked.
      const strayC = strayLines(C, /^\[capacity\] room creation REFUSED — 1\/1 rooms in memory$/);
      if (strayC.length === 0) ok('(B6) the capped server printed nothing unexpected');
      else fail('(B6) the capped server printed:\n      ' + strayC.join('\n      '));
    }
  }

  // ---- B14. the next match: a member still on the last one's result screen --
  // The squad outlives every match (design 4.3), so the ordinary second Start
  // finds members still seated in the room of the match that has just ENDED.
  // That room holds nothing to protect, so it is not member_busy: the member
  // is moved, and quietly — an ended room is torn down without 'Opponent
  // left'. A third server with a short resume grace, so a dropped seat is
  // forfeited and a free-for-all for two reaches its gameover in a moment.
  {
    const R = await boot({ RESUME_GRACE_MS: '300' });
    if (R) {
      const s = await squadUp(R.port, [1, 2], 'ffa');
      if (s) {
        const [a, b] = s.ws;
        const first = await ask(a, { op: 'start' });
        const bIn = await wait(b, (m) => m.type === 'start');
        b.close();
        const over = await wait(a, (m) => m.type === 'gameover');
        // The member who left is kicked (their row still holds the closed
        // socket until the drop window exists), a new one joins, and both
        // ready again: the Readies were spent by the first start.
        const c = await pilot(R.port, 3);
        const j = await ask(c, { op: 'join', code: s.code, name: 'Pilot3', skin: 'olive' });
        // A kick names its target by `id` (Task 2's frame), which is also the
        // field a reply echoes — so it is sent as is, and its answer is the
        // roster that comes back carrying that id.
        put(a, { type: 'squad', op: 'kick', id: ID(2) });
        const k = await wait(a, (m) => m.type === 'squad' && m.id === ID(2));
        const ra = await ask(a, { op: 'ready', ready: true, loadout: RACK(0) });
        const rc = await ask(c, { op: 'ready', ready: true, loadout: RACK(2) });
        const from = a._rx.length;
        const again = await ask(a, { op: 'start' });
        const cs = await wait(c, (m) => m.type === 'start');
        await settle([a, c]);
        const aAfter = a._rx.slice(from).map((m) => m.type);
        if (first && first.ok && bIn && over && j && j.op === 'state' && k && k.op === 'state' && ra && ra.ok && rc && rc.ok
          && again && again.ok === true && again.code !== first.code && cs && cs.code === again.code && !aAfter.includes('opponentLeft'))
          ok('(B14) a leader still seated in the room of the match that just ended starts the next one — moved, quietly, not member_busy');
        else fail('(B14) next match: ' + JSON.stringify({ first, over: !!over, j: j && j.op, k: k && (k.op + (k.error || '')), ra, rc, again, c: cs && cs.code, aAfter }));
        await closeAll([a, c]);
      }
      const strayR = strayLines(R);
      if (strayR.length === 0) ok('(B14) the short-grace server printed nothing unexpected');
      else fail('(B14) the short-grace server printed:\n      ' + strayR.join('\n      '));
    }
  }
}

await sectionB();
await finish();
