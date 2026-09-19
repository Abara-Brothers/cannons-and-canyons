// GET /history (Launch Bay "Recent sorties"). Self-hosted: spawns its own
// server against a mock Supabase, so nothing here can reach production.
//
// WHY THIS EXISTS: this is the ONLY read path into match_results, which is
// deny-all to clients by design. Four things must hold and none is visible
// from a green home screen: (1) the response never carries a uuid -- opponents
// are resolved to callsigns server-side; (2) every outcome the ledger can
// record maps to the right letter, including a loss to the computer, which
// arrives with NO winner_user; (3) the route is authenticated and rate-limited;
// (4) EVERY NAME IS ONE THE SERVER CAN VOUCH FOR. `profiles.callsign` is a
// column the account itself PATCHes on every cloud save, and this panel carries
// no seat handle, so a name shown here cannot even be reported or blocked from
// the screen it appears on. The three cases below are the whole rule, driven
// through the real server: a rolled pair is named, a CHOSEN name proven by its
// callsign_key is named, and the same chosen name worn by an account that does
// NOT hold the key reads 'Commander' (BINDING.md resolution 27).
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
const DAVE  = '44444444-4444-4444-4444-444444444444';
const hits = { rows: 0, profiles: 0 };
// The profiles query the server actually issued, kept so the SELECT LIST can be
// asserted. Without callsign_key in the row there is nothing to prove a chosen
// name against, and the check below would pass for the wrong reason: the mock
// answers whatever it likes regardless of what was asked for.
let profileQuery = '';

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
      { mode: 'duel', players: [ALICE, CAROL],      winner_user: CAROL, winner_seat: 1,    vs_bot: false, ended_at: '2026-09-10T01:00:00Z' },
      { mode: 'duel', players: [ALICE, DAVE],       winner_user: ALICE, winner_seat: 0,    vs_bot: false, ended_at: '2026-09-09T01:00:00Z' },
    ]);
  }
  if (u.pathname === '/rest/v1/profiles') {
    // Count RESOLUTION queries only. /health probes profiles too (phase 6 names
    // the three new columns there, so one request proves the migration landed),
    // and a probe is not an N+1 — which is the only thing this counter exists to
    // catch. Every probe in server.js asks for limit=0, i.e. no rows at all, so
    // that is the discriminator rather than the exact select list: a request
    // that fetches zero rows cannot be resolving anyone's callsign.
    if (u.searchParams.get('limit') !== '0') { hits.profiles++; profileQuery = u.search; }
    // BOB rolled his name; DAVE chose one and the server stored the key it
    // derived from it; CAROL PATCHed DAVE'S CHOSEN NAME into her own display
    // column and has no key, which is the whole attack -- a column she owns
    // against a column only the server may write.
    return J(200, [
      { id: BOB,   callsign: 'Rusty Gulch',    callsign_key: null },
      { id: CAROL, callsign: 'Wren Delacroix', callsign_key: null },
      { id: DAVE,  callsign: 'Wren Delacroix', callsign_key: 'wren delacroix' },
    ]);
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
  if (r.status === 200 && j && Array.isArray(j.rows) && j.rows.length === 6) ok('a signed-in player gets their rows');
  else fail(`history: ${r.status} ${text.slice(0, 200)}`);

  const rows = (j && j.rows) || [];
  const res = rows.map((x) => x.result), opp = rows.map((x) => x.opponent);
  if (JSON.stringify(res) === JSON.stringify(['W', 'L', 'L', '', 'L', 'W'])) ok('outcomes: human win W, human loss L, loss to the computer L, unattributed team end neither');
  else fail(`outcomes wrong: ${JSON.stringify(res)} (expected W,L,L,"",L,W)`);
  if (JSON.stringify(opp) === JSON.stringify(['Rusty Gulch', '2 commanders', 'Computer', 'Rusty Gulch', 'Commander', 'Wren Delacroix']))
    ok('opponents resolved to callsigns, the computer named, a crowd counted');
  else fail(`opponents wrong: ${JSON.stringify(opp)}`);
  // THE PROOF ITSELF, on the live route rather than in a unit test. Both names
  // are the same 14 characters; only one account holds the key behind them.
  if (opp[5] === 'Wren Delacroix') ok('a CHOSEN name whose row proves it against callsign_key is shown');
  else fail(`a proven chosen name was not shown: ${JSON.stringify(opp[5])}`);
  if (opp[4] === 'Commander') ok('the same chosen name worn WITHOUT the key reads Commander -- impersonation cannot reach the Recent sorties panel');
  else fail(`IMPERSONATION REACHED THE PANEL: ${JSON.stringify(opp[4])}`);
  if (opp[0] === 'Rusty Gulch') ok('a rolled pair still names its player, so proving names does not empty the panel');
  else fail(`a rolled pair lost its name: ${JSON.stringify(opp[0])}`);
  if (/(^|[?&])select=[^&]*\bcallsign_key\b/.test(profileQuery)) ok('the profiles query asks for callsign_key, so there is a key in the row to prove the name against');
  else fail(`the profiles select does not carry callsign_key -- nothing can be proven: ${profileQuery}`);
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
