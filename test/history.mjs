// GET /history (Launch Bay "Recent sorties"). Self-hosted: spawns its own
// server against a mock Supabase, so nothing here can reach production.
//
// WHY THIS EXISTS: this is the ONLY read path into match_results, which is
// deny-all to clients by design. Three things must hold and none is visible
// from a green home screen: (1) the response never carries a uuid -- opponents
// are resolved to callsigns server-side; (2) every outcome the ledger can
// record maps to the right letter, including a loss to the computer, which
// arrives with NO winner_user; (3) the route is authenticated and rate-limited.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB   = '22222222-2222-2222-2222-222222222222';
const CAROL = '33333333-3333-3333-3333-333333333333';
const hits = { rows: 0, profiles: 0 };

const mockPort = await freePort();
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const J = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/auth/v1/user') {
    return req.headers.authorization === 'Bearer tok-alice' ? J(200, { id: ALICE }) : J(401, { msg: 'no' });
  }
  if (u.pathname === '/rest/v1/match_results') {
    hits.rows++;
    // the server must ask for ALICE's rows only, newest first, bounded
    if (!/players=cs\./.test(u.search) || !u.search.includes(ALICE)) return J(400, { msg: 'unscoped query' });
    return J(200, [
      { mode: 'duel', players: [ALICE, BOB],        winner_user: ALICE, winner_seat: 0,    vs_bot: false, ended_at: '2026-09-14T01:00:00Z' },
      { mode: 'ffa',  players: [ALICE, BOB, CAROL], winner_user: BOB,   winner_seat: 1,    vs_bot: false, ended_at: '2026-09-13T01:00:00Z' },
      { mode: 'duel', players: [ALICE],             winner_user: null,  winner_seat: 1,    vs_bot: true,  ended_at: '2026-09-12T01:00:00Z' },
      { mode: 'boss', players: [ALICE, BOB],        winner_user: null,  winner_seat: null, vs_bot: true,  ended_at: '2026-09-11T01:00:00Z' },
    ]);
  }
  if (u.pathname === '/rest/v1/profiles') {
    hits.profiles++;
    return J(200, [{ id: BOB, callsign: 'Rusty Gulch' }, { id: CAROL, callsign: 'Ashen Salvo' }]);
  }
  J(200, []);
});
await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

const port = await freePort();
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(port), SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_PUBLISHABLE_KEY: 'pk', SUPABASE_SECRET_KEY: 'sk' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); break; } catch {} await sleep(150); }
const H = `http://127.0.0.1:${port}/history`;

try {
  const pre = await fetch(H, { method: 'OPTIONS' });
  if (pre.status === 204 && /GET/.test(pre.headers.get('access-control-allow-methods') || '')) ok('preflight answers 204 with GET allowed (the shell calls cross-origin)');
  else fail(`preflight wrong: ${pre.status}`);

  if ((await fetch(H, { method: 'POST' })).status === 405) ok('POST is refused'); else fail('POST was not refused');
  if ((await fetch(H)).status === 401) ok('no token -> 401'); else fail('an unauthenticated call was served');
  if ((await fetch(H, { headers: { Authorization: 'Bearer tok-nobody' } })).status === 401) ok('an unknown token -> 401'); else fail('an unknown token was served');

  const r = await fetch(H, { headers: { Authorization: 'Bearer tok-alice' } });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (r.status === 200 && j && Array.isArray(j.rows) && j.rows.length === 4) ok('a signed-in player gets their rows');
  else fail(`history: ${r.status} ${text.slice(0, 200)}`);

  const rows = (j && j.rows) || [];
  const res = rows.map((x) => x.result), opp = rows.map((x) => x.opponent);
  if (JSON.stringify(res) === JSON.stringify(['W', 'L', 'L', ''])) ok('outcomes: human win W, human loss L, loss to the computer L, unattributed team end neither');
  else fail(`outcomes wrong: ${JSON.stringify(res)} (expected W,L,L,"")`);
  if (JSON.stringify(opp) === JSON.stringify(['Rusty Gulch', '2 commanders', 'Computer', 'Rusty Gulch'])) ok('opponents resolved to callsigns, the computer named, a crowd counted');
  else fail(`opponents wrong: ${JSON.stringify(opp)}`);
  if (!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) ok('no uuid anywhere in the response');
  else fail('a uuid LEAKED into the response — another player\'s account id reached the client');
  if (rows.every((x) => typeof x.when === 'string' && x.mode)) ok('every row carries mode and when'); else fail('rows missing mode/when');
  if (hits.profiles === 1) ok('opponents resolved in ONE profiles query'); else fail(`profiles queried ${hits.profiles} times`);

  const again = await fetch(H, { headers: { Authorization: 'Bearer tok-alice' } });
  if (again.status === 429) ok('an immediate repeat is rate-limited (429)'); else fail(`a repeat within 2s was served: ${again.status}`);
} catch (e) { fail('threw — ' + (e && e.message ? e.message : String(e))); }
finally { srv.kill(); mock.close(); }

if (out.errors.length) console.log('\n--- server output ---\n' + log.slice(-600));
console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
