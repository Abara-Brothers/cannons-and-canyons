// The match ledger (RISK-004 steps 1–2). Self-hosted: spawns its own server and
// its own mock Supabase, so nothing here can reach production.
//
// WHY THIS EXISTS: the ledger is the ONLY evidence server-derived entitlement
// will ever be able to draw on, and it cannot be backfilled — a match played
// before a row exists is gone. So the failure that matters is not "the write
// errored", it is "the write silently never happened", which looks identical to
// a quiet week. This asserts the row is actually produced, with the right shape.
//
// Deliberately NOT asserted against the real database: writing test rows into the
// evidence base would corrupt the thing it exists to protect.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const ledgerWrites = [];
// ONE ACCOUNT PER TOKEN, so a row can be checked for WHO played and who won,
// not just that it exists. A token this map does not know verifies as nobody.
const ACCT = {
  'tok-a': 'aaaaaaaa-0000-4000-8000-00000000000a',
  'tok-b': 'bbbbbbbb-0000-4000-8000-00000000000b',
};
const verified = [];
const mockPort = await freePort();
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = req.url || '';
    if (url.startsWith('/rest/v1/match_results') && req.method === 'POST') {
      try { ledgerWrites.push(JSON.parse(body)); } catch { ledgerWrites.push({ unparseable: body }); }
      res.writeHead(201); return res.end();
    }
    if (url.includes('/auth/v1/user')) {
      const tok = String(req.headers.authorization || '').replace('Bearer ', '');
      verified.push(tok);
      if (!ACCT[tok]) { res.writeHead(401); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: ACCT[tok], is_anonymous: false }));
    }
    // Everything else the server probes on boot / for /health.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
});
await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

const port = await freePort();
// No `cwd`: run-all.sh chdirs to the repo root first, and the other self-hosted
// suites rely on the same. Deriving it from import.meta.url gives a URL-ENCODED
// path — this project lives under "Pocket Tanks Online", so the spaces arrive as
// %20 and the spawn fails with ENOENT.
const srv = spawn('node', ['server.js'], {
  env: {
    ...process.env, PORT: String(port),
    SUPABASE_URL: `http://127.0.0.1:${mockPort}`,
    SUPABASE_PUBLISHABLE_KEY: 'fake', SUPABASE_SECRET_KEY: 'fake',
    // Short graces so a disconnect resolves into a real forfeit quickly. A duel
    // is asyncOk, so RESUME_GRACE_MS alone is not enough — it would wait a day.
    RESUME_GRACE_MS: '300', ASYNC_GRACE_MS: '300', EMPTY_ROOM_GRACE_MS: '300',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 80; i++) {
  try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch {}
  await sleep(150);
}

const open = () => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('open', () => res(ws)); ws.on('error', rej);
});
const wait = (ws, type, ms = 8000) => new Promise((res) => {
  const t = setTimeout(() => res(null), ms);
  const on = (raw) => { const m = JSON.parse(raw); if (m.type !== type) return; clearTimeout(t); ws.off('message', on); res(m); };
  ws.on('message', on);
});
const send = (ws, m) => ws.send(JSON.stringify(m));

try {
  const a = await open();
  const b = await open();
  send(a, { type: 'create', mode: 'duel', name: 'A', skin: 'olive' });
  const made = await wait(a, 'created', 6000);
  if (!made) throw new Error('no room created');
  send(b, { type: 'join', code: made.code, name: 'B', skin: 'desert' });
  if (!await wait(a, 'start', 8000)) throw new Error('match never started');

  b.close();                                   // forfeit
  const over = await wait(a, 'gameover', 8000);
  if (!over) fail('ledger: the match never reached gameover, so nothing was witnessed');

  // The write is fire-and-forget, so give it a moment to land.
  for (let i = 0; i < 40 && ledgerWrites.length === 0; i++) await sleep(100);

  if (ledgerWrites.length === 0) {
    fail('ledger: a completed online match produced NO row — the evidence base is silently empty');
  } else {
    const row = ledgerWrites[0];
    ok('a completed online match writes exactly one ledger row');
    if (row.mode === 'duel') ok(`the row records the mode (${row.mode})`);
    else fail(`ledger: wrong mode recorded: ${JSON.stringify(row.mode)}`);
    if (row.player_count === 2) ok('the row records how many humans played');
    else fail(`ledger: player_count was ${JSON.stringify(row.player_count)}, expected 2`);
    if (row.vs_bot === false) ok('a human match is not flagged as a bot game');
    else fail('ledger: a two-human match was flagged vs_bot — bot and human wins would be indistinguishable');
    if (Object.prototype.hasOwnProperty.call(row, 'winner_seat')) ok('the row records the winning seat');
    else fail('ledger: no winner_seat on the row');
  }
  try { a.close(); } catch {}

  // WHO PLAYED AND WHO WON. Two signed-in accounts, one match each way round,
  // so a row that always named seat 0's account, dropped `players`, or wrote
  // winner_user as null would each be caught: the ledger is the only evidence
  // a player's earnings will ever be derived from.
  const A = ACCT['tok-a'], B = ACCT['tok-b'];
  const signedIn = async (tok) => {
    const ws = await open();
    const seen = verified.length;
    send(ws, { type: 'hello', token: tok });
    for (let i = 0; i < 50 && !verified.slice(seen).includes(tok); i++) await sleep(50);
    await sleep(150);                           // the verified id lands on the socket
    return ws;
  };
  // host creates, guest joins, `loser` forfeits by closing; resolves with the
  // rows written by the time the ledger has had a moment to land.
  const duel = async (hostTok, guestTok, loser) => {
    const host = await signedIn(hostTok), guest = await signedIn(guestTok);
    const before = ledgerWrites.length;
    send(host, { type: 'create', mode: 'duel', name: 'Host', skin: 'olive' });
    const m = await wait(host, 'created', 6000);
    if (!m) throw new Error('no room created');
    send(guest, { type: 'join', code: m.code, name: 'Guest', skin: 'desert' });
    if (!await wait(host, 'start', 8000)) throw new Error('match never started');
    const winner = loser === 'guest' ? host : guest;
    (loser === 'guest' ? guest : host).close();
    const over = await wait(winner, 'gameover', 8000);
    for (let i = 0; i < 40 && ledgerWrites.length === before; i++) await sleep(100);
    await sleep(600);                           // room for a second, wrong row
    try { winner.close(); } catch {}
    return { over, rows: ledgerWrites.slice(before) };
  };

  const m1 = await duel('tok-a', 'tok-b', 'guest');
  const r1 = m1.rows[0] || {};
  if (m1.rows.length === 1 && JSON.stringify(r1.players) === JSON.stringify([A, B]))
    ok('a signed-in match records both accounts, in seat order');
  else fail(`ledger: players for A (seat 0) v B (seat 1) were ${JSON.stringify(m1.rows.map((r) => r.players))}`);
  if (r1.winner_seat === 0 && r1.winner_user === A) ok('the host winning is recorded as the host\'s account, on seat 0');
  else fail(`ledger: B forfeited to A, but the row says seat ${JSON.stringify(r1.winner_seat)} / ${JSON.stringify(r1.winner_user)}`);

  const m2 = await duel('tok-a', 'tok-b', 'host');
  const r2 = m2.rows[0] || {};
  if (m2.rows.length === 1 && JSON.stringify(r2.players) === JSON.stringify([A, B]) && r2.winner_seat === 1 && r2.winner_user === B)
    ok('the guest winning is recorded as the guest\'s account, on seat 1 — not always seat 0\'s');
  else fail(`ledger: A forfeited to B, but the rows were ${JSON.stringify(m2.rows)}`);

  // ONE ACCOUNT ON BOTH SEATS IS NOT A MATCH. Two tabs of one account: one
  // creates, the other joins by code, one of them forfeits. The match plays,
  // but the ledger must not record the account winning against itself — not
  // as a two-player row, and not stripped down to a solo win either.
  const m3 = await duel('tok-a', 'tok-a', 'guest');
  if (m3.over && m3.rows.length === 0)
    ok('one account on both seats plays out, and the ledger records nothing: no win against itself');
  else fail(`ledger: one account on both seats (gameover=${!!m3.over}) wrote ${JSON.stringify(m3.rows)}`);
} catch (e) {
  fail('ledger: threw — ' + (e && e.message ? e.message : String(e)));
} finally {
  srv.kill(); mock.close();
}

if (out.errors.length) console.log('\n--- server output ---\n' + log.slice(-800));
console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
