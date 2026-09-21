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
// server.js's own per-player limiter on this route. Kept here so the one place
// that has to wait it out says why, rather than sleeping on a bare number.
const HIST_MIN_MS = 2000;
// The profiles query the server actually issued, kept so the SELECT LIST can be
// asserted. Without callsign_key in the row there is nothing to prove a chosen
// name against, and the check below would pass for the wrong reason: the mock
// answers whatever it likes regardless of what was asked for.
let profileQuery = '';
// THE STATE THE SUITE COULD NOT PRODUCE BEFORE. The mock answered every
// /rest/v1/profiles query 200 whatever it asked for, so the assertion that the
// select carries callsign_key passed while the column DID NOT EXIST in the only
// database that matters -- the phase 6 migration is applied BY HAND, after the
// deploy. PostgREST answers an unknown column 400 with code 42703 (server.js's
// own /health comment says so in those words). 'no_key' is that database.
let profilesMode = 'ok';
// Which world the SOCIAL PROBES live in, for the supabaseSocial field the ship
// procedure reads. Read at BOOT by each spawned server, so it is set before the
// spawn and not during it.
//
//   'ok'          all five probes answer 200
//   'missing'     THE REAL UN-MIGRATED DATABASE, as the schema probe recorded it:
//                 the three new columns answer 400/42703 AND the four tables 404
//   'tables_only' the four tables 404, the columns are there — a PARTIAL apply,
//                 and the only world that pins the 404 arm of the classifier by
//                 itself, because in 'missing' the 400 arm would carry it
//   'cols_only'   the columns 400, the tables are there — the mirror, pinning
//                 the 400 arm by itself
//   'bad_key'     everything answers 401, which must NOT read migration_missing
let socialMode = 'ok';
const SOCIAL_TABLES = ['friendships', 'friend_requests', 'blocks', 'name_reports'];
const TABLES_404 = ['missing', 'tables_only'];
const COLS_400 = ['missing', 'cols_only'];

const mockPort = await freePort();
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const J = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  // The four phase-6 tables exist only for the /health probe here; nothing in
  // this suite reads them. limit=0 is how server.js probes, and it is the only
  // way they are ever asked for.
  if (SOCIAL_TABLES.includes(u.pathname.replace('/rest/v1/', ''))) {
    if (socialMode === 'bad_key') return J(401, { message: 'invalid key' });
    if (TABLES_404.includes(socialMode)) return J(404, { message: 'relation does not exist' });
    return J(200, []);
  }
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
    // The /health probe is a profiles read too, and it names the three NEW
    // COLUMNS on purpose -- so in the 'bad_key' and 'missing' worlds it has to
    // answer the way those worlds would, or supabaseSocial can never leave 'ok'.
    if (u.searchParams.get('limit') === '0') {
      if (socialMode === 'bad_key') return J(401, { message: 'invalid key' });
      if (COLS_400.includes(socialMode)) return J(400, { code: '42703', message: 'column profiles.callsign_key does not exist' });
      return J(200, []);
    }
    // A DATABASE WITHOUT THE MIGRATION. The select names callsign_key, so
    // PostgREST refuses the whole request: the route must degrade to
    // 'Commander' and keep serving, not 502 the panel away.
    if (profilesMode === 'no_key' && /\bcallsign_key\b/.test(u.searchParams.get('select') || '')) {
      return J(400, { code: '42703', message: 'column profiles.callsign_key does not exist' });
    }
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

const SRV_ENV = (p) => ({ ...process.env, PORT: String(p), SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_PUBLISHABLE_KEY: 'pk', SUPABASE_SECRET_KEY: 'sk' });

// /health, read from a server that booted into whatever world `socialMode`
// describes RIGHT NOW. supabaseSocial is latched by the boot probe and re-probed
// at most once a minute, so a second world needs a second process rather than a
// second request -- and a whole suite is shorter than that minute.
//
// It POLLS for a settled value: 'unchecked' is the field's state while the boot
// probe is still in flight, and the listener is up before that promise resolves.
const extras = [];
async function bootHealth() {
  const p = await freePort();
  const s = spawn('node', ['server.js'], { env: SRV_ENV(p), stdio: ['ignore', 'pipe', 'pipe'] });
  extras.push(s);
  let out = ''; s.stdout.on('data', (d) => { out += d; }); s.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 80; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${p}/health`)).json();
      if (j && j.supabaseSocial && j.supabaseSocial !== 'unchecked') return { health: j, log: () => out };
    } catch {}
    await sleep(150);
  }
  return { health: null, log: () => out };
}

const port = await freePort();
const srv = spawn('node', ['server.js'], {
  env: SRV_ENV(port),
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

  // ---- the panel OUTLIVES the name lookup ----------------------------------
  // The one state this file could never produce, and the one production is in
  // until the owner applies the phase 6 migration by hand: the column named in
  // the select does not exist, PostgREST answers 400, and sbAdmin throws on any
  // non-2xx. Inside the route's single outer try that was a 502 for the WHOLE
  // response -- including mode, result and date, which need no profile at all --
  // and public/bay.js's `if (!r.ok) return;` turns a 502 into the Recent sorties
  // panel silently VANISHING, with no error, no empty state and no retry.
  //
  // What must hold instead: the rows still serve, and every name the server
  // cannot prove falls back to 'Commander' -- the same fail-closed outcome the
  // route already uses when the name proofs are unavailable. THE PROOF IS NOT
  // WEAKENED BY THIS: no name is shown at all, so no unproven name can be.
  await sleep(HIST_MIN_MS + 150);          // the 2s per-player limiter, waited out honestly
  profilesMode = 'no_key';
  const deg = await fetch(H, { headers: { Authorization: 'Bearer tok-alice' } });
  const degText = await deg.text();
  let dj = null; try { dj = JSON.parse(degText); } catch {}
  if (deg.status === 200 && dj && Array.isArray(dj.rows) && dj.rows.length === 6)
    ok('a database WITHOUT the phase 6 migration still serves the panel — the 400 on the name lookup is not the whole response');
  else fail(`the panel died with the migration unapplied: ${deg.status} ${degText.slice(0, 200)}`);
  const dopp = ((dj && dj.rows) || []).map((x) => x.opponent);
  if (JSON.stringify(dopp) === JSON.stringify(['Commander', '2 commanders', 'Computer', 'Commander', 'Commander', 'Commander']))
    ok('and every unresolvable opponent degrades to the existing \'Commander\' fallback — a name is lost, never invented');
  else fail(`degraded opponents wrong: ${JSON.stringify(dopp)}`);
  const dres = ((dj && dj.rows) || []).map((x) => x.result);
  if (JSON.stringify(dres) === JSON.stringify(['W', 'L', 'L', '', 'L', 'W']))
    ok('and the half of the row that never needed a profile — mode, result, date — is unaffected');
  else fail(`degraded outcomes wrong: ${JSON.stringify(dres)}`);
  if (!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(degText))
    ok('and the degraded response still carries no uuid');
  else fail('a uuid leaked into the degraded response');
  profilesMode = 'ok';

  // ---- supabaseSocial, in all three of the states the owner acts on --------
  // Step 7 of the ship procedure is "read supabaseSocial; it must be 'ok'; if it
  // reads migration_missing, wait and read again". That single field is the gate
  // between "the migration landed" and "do not proceed", and until now NOTHING in
  // test/ named it: its only observable state in the whole suite was the wrong
  // one, because push_persist's mock has no route for these tables and every
  // probe there fell to a 500. A classifier that is wrong in either direction
  // sends the owner to the wrong conclusion on a live deploy -- told to rotate a
  // key that is fine, or told 'ok' when the tables are absent.
  const hOk = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  if (hOk && hOk.supabaseSocial === 'ok') ok("supabaseSocial reads 'ok' when all five phase 6 probes answer — the state the ship procedure waits for");
  else fail(`supabaseSocial with every table present: ${JSON.stringify(hOk && hOk.supabaseSocial)}`);

  // THE REAL UN-MIGRATED DATABASE FIRST: the columns 400 and the tables 404
  // together, which is what the live schema probe actually records today.
  socialMode = 'missing';
  const missing = await bootHealth();
  if (missing.health && missing.health.supabaseSocial === 'migration_missing')
    ok("supabaseSocial reads 'migration_missing' against the real un-migrated database — NOT bad_secret_key, which would send the owner to rotate a key that is fine");
  else fail(`supabaseSocial with the migration unapplied: ${JSON.stringify(missing.health && missing.health.supabaseSocial)}`);
  if (/FRIENDS\/CALLSIGNS are dead: the phase 6 migration has not been applied/.test(missing.log()))
    ok('and the boot line says the migration is missing, in those words, on stderr');
  else fail(`boot line for a missing migration: ${missing.log().slice(-300)}`);

  // ...then each ARM of the classifier on its own. In the world above both fire
  // at once, so either one alone would carry the verdict and neither is pinned
  // by it. These two are the halves, and they are also the two PARTIAL applies
  // the owner can actually land: tables without columns, columns without tables.
  socialMode = 'tables_only';
  const tOnly = await bootHealth();
  if (tOnly.health && tOnly.health.supabaseSocial === 'migration_missing')
    ok("a 404 ALONE (the four tables absent, the columns present) reads 'migration_missing' — the 404 arm is load-bearing");
  else fail(`supabaseSocial with only the tables absent: ${JSON.stringify(tOnly.health && tOnly.health.supabaseSocial)}`);

  socialMode = 'cols_only';
  const cOnly = await bootHealth();
  if (cOnly.health && cOnly.health.supabaseSocial === 'migration_missing')
    ok("a 400 ALONE (the columns absent, the tables present) reads 'migration_missing' — the 400 arm is load-bearing too, which is what makes one probe cover the column half of the migration");
  else fail(`supabaseSocial with only the columns absent: ${JSON.stringify(cOnly.health && cOnly.health.supabaseSocial)}`);

  socialMode = 'bad_key';
  const badKey = await bootHealth();
  if (badKey.health && badKey.health.supabaseSocial === 'bad_secret_key')
    ok("supabaseSocial reads 'bad_secret_key' when the tables refuse the key — the other verdict, and it is reachable");
  else fail(`supabaseSocial with a refused key: ${JSON.stringify(badKey.health && badKey.health.supabaseSocial)}`);
  socialMode = 'ok';
} catch (e) { fail('threw — ' + (e && e.message ? e.message : String(e))); }
finally { srv.kill(); for (const s of extras) s.kill(); mock.close(); }

if (out.errors.length) console.log('\n--- server output ---\n' + log.slice(-600));
console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
