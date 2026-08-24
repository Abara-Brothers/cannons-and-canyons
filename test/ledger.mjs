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
    // Everything else the server probes on boot / for /health.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(url.includes('/auth/v1/user') ? '{"id":"11111111-1111-1111-1111-111111111111"}' : '[]');
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
} catch (e) {
  fail('ledger: threw — ' + (e && e.message ? e.message : String(e)));
} finally {
  srv.kill(); mock.close();
}

if (out.errors.length) console.log('\n--- server output ---\n' + log.slice(-800));
console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
