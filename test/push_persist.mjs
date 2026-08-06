// Push persistence (8.48 / ISSUE-003): the server verifies a ws token, keys
// the subscription to the account, nudges EVERY device from the store, and
// deletes dead endpoints. Supabase itself is mocked with a local HTTP server,
// so this asserts OUR wire shapes — the exact headers, bodies and query
// strings server.js emits — not Supabase's acceptance of them (the shapes
// mirror calls already proven live: /auth/v1/user and the profiles upsert).
//
// Self-hosted like shutdown.mjs: spawns its OWN game server with SUPABASE_*
// pointed at the mock. Never aim it at a deployment.
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import WebSocket from 'ws';

const out = { steps: [], errors: [] };
const step = (m) => { out.steps.push(m); console.log('  ok — ' + m); };
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
let child = null;
const finish = () => {
  try { if (child) child.kill('SIGKILL'); } catch {}
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
  process.exit(out.errors.length ? 1 : 0);
};
setTimeout(() => { fail('timeout'); finish(); }, 60000);

const MOCK_PORT = 9911, INBOX_PORT = 9912, GAME_PORT = 3105;
const USER = 'user-alice-0000-0000-000000000001';

// The engine only accepts https:// endpoints (real push services are TLS), so
// the push INBOX needs a TLS listener. Mint a throwaway loopback cert at
// runtime — nothing to commit, valid for a day, trusted by nobody (the game
// server child runs with NODE_TLS_REJECT_UNAUTHORIZED=0, test env only).
// Without openssl the delivery/cleanup legs are SKIPPED LOUDLY, never faked.
let tlsOpts = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-push-'));
  const key = path.join(dir, 'k.pem'), crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt',
    'ec_paramgen_curve:prime256v1', '-keyout', key, '-out', crt,
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  tlsOpts = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
} catch { /* legs 4-5 will be skipped */ }

// A subscription webpush can actually encrypt to: a REAL P-256 keypair.
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const b64u = (b) => Buffer.from(b).toString('base64url');
const SUB = {
  endpoint: `https://127.0.0.1:${INBOX_PORT}/push-inbox/alice-phone`,
  keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(crypto.randomBytes(16)) },
};

// ---- Mock Supabase + push endpoint ------------------------------------------
const hits = { user: [], upsert: [], nudgeGet: [], pushPost: [], del: [] };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
    if (u.pathname === '/auth/v1/user') {
      hits.user.push({ apikey: req.headers.apikey, auth: req.headers.authorization });
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      if (token === 'tok-alice') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: USER, aud: 'authenticated' }));
      }
      res.writeHead(401); return res.end('{}');
    }
    if (u.pathname === '/rest/v1/push_subscriptions') {
      if (req.method === 'POST') {
        hits.upsert.push({ query: u.search, prefer: req.headers.prefer, apikey: req.headers.apikey, body: JSON.parse(body || '{}') });
        res.writeHead(201); return res.end();
      }
      if (req.method === 'GET') {
        hits.nudgeGet.push({ query: u.search, apikey: req.headers.apikey });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify([{ endpoint: SUB.endpoint, sub: SUB }]));
      }
      if (req.method === 'DELETE') {
        hits.del.push({ query: u.search });
        res.writeHead(204); return res.end();
      }
    }
    res.writeHead(500); res.end();
  });
});

// The TLS push inbox: every delivery answers 404, so a correct server must
// then DELETE the endpoint from its store.
const inbox = tlsOpts ? https.createServer(tlsOpts, (req, res) => {
  hits.pushPost.push({ path: req.url });
  res.writeHead(404); res.end();
}) : null;

const openWs = () => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${GAME_PORT}/ws`);
  ws.on('open', () => res(ws));
  ws.on('error', rej);
});
const send = (ws, m) => ws.send(JSON.stringify(m));
const until = async (test, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`timed out waiting for ${what}`);
  return false;
};

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  if (inbox) await new Promise((r) => inbox.listen(INBOX_PORT, r));
  child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(GAME_PORT),
      SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      SUPABASE_PUBLISHABLE_KEY: 'pk_test',
      SUPABASE_SECRET_KEY: 'sk_test',
      // Test-only: lets the child trust the throwaway loopback cert.
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      BOT_FIRE_MS: '150', PICK_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  child.stdout.on('data', (d) => { if (String(d).includes('running at')) ready = true; });
  if (!(await until(() => ready, 8000, 'game server boot'))) return finish();

  // Two humans in an invited duel; both say hello with their tokens.
  const a = await openWs(), b = await openWs();
  send(a, { type: 'hello', token: 'tok-alice' });
  send(a, { type: 'create', name: 'Iron Ridge', skin: 'olive', mode: 'duel' });
  const created = await new Promise((res) => {
    a.on('message', function on(raw) { const m = JSON.parse(raw); if (m.type === 'created') { a.off('message', on); res(m); } });
  });
  if (!(await until(() => hits.user.length >= 1, 5000, 'token verification'))) return finish();
  const v = hits.user[0];
  if (v.apikey === 'pk_test' && v.auth === 'Bearer tok-alice') step('hello verified with the PUBLISHABLE key, never the secret');
  else fail(`verification headers wrong: ${JSON.stringify(v)}`);

  // Alice registers her subscription; the server must persist it for her.
  send(a, { type: 'pushSub', sub: SUB, token: 'tok-alice' });
  if (!(await until(() => hits.upsert.length >= 1, 5000, 'subscription upsert'))) return finish();
  const up = hits.upsert[0];
  if (up.query.includes('on_conflict=endpoint') && /merge-duplicates/.test(up.prefer || '')
    && up.apikey === 'sk_test' && up.body.user_id === USER && up.body.endpoint === SUB.endpoint) {
    step('subscription upserted with the SECRET key, keyed to the verified user');
  } else fail(`upsert shape wrong: ${JSON.stringify({ q: up.query, prefer: up.prefer, body: up.body })}`);

  // Bob joins; Alice fires ONCE and vanishes; Bob keeps playing. There is no
  // shot clock, so the choreography matters: Alice must leave with the turn
  // already handed over, or the match stalls on her seat and beginTurn never
  // fires again. When her next turn comes up the server must look her
  // subscriptions up BY ACCOUNT and push to her device.
  let started = null;
  let aSeat = -1, aFired = false;
  a.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'start') aSeat = m.you;
    if (m.type === 'turn' && m.turn === aSeat && !aFired) {
      aFired = true;
      send(a, { type: 'fire', weapon: 'cannon', angle: 45, power: 55 });
      // Gone almost immediately: measured locally, the full turn cycle is
      // ~2.5s, and an 800ms exit LOST the race — beginTurn(A) ran while A
      // still looked connected and the nudge was skipped. 150ms lets the ws
      // library flush the fire frame and nothing more.
      setTimeout(() => a.terminate(), 150);
    }
  });
  let bSeat = -1, bShots = 0;
  b.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'start') { started = m; bSeat = m.you; }
    if (m.type === 'turn' && m.turn === bSeat && bShots < 8) {
      bShots++;
      send(b, { type: 'fire', weapon: 'cannon', angle: 45, power: 55 });
    }
  });
  send(b, { type: 'join', code: created.code, name: 'Stone Falcon', skin: 'desert' });
  if (!(await until(() => !!started, 8000, 'duel start'))) return finish();
  if (!(await until(() => hits.nudgeGet.length >= 1, 30000, 'nudge subscription lookup'))) return finish();
  const g = hits.nudgeGet[0];
  if (g.query.includes(`user_id=eq.${USER}`) && g.apikey === 'sk_test') step('nudge looks subscriptions up by account with the secret key');
  else fail(`nudge lookup wrong: ${JSON.stringify(g)}`);
  if (!inbox) {
    step('SKIPPED delivery + cleanup legs: openssl unavailable for the TLS inbox');
  } else {
    if (!(await until(() => hits.pushPost.length >= 1, 10000, 'web push delivery'))) return finish();
    step('an encrypted web push reached the stored endpoint');
    if (!(await until(() => hits.del.length >= 1, 10000, 'dead-endpoint cleanup'))) return finish();
    if (hits.del[0].query.includes('endpoint=eq.')) step('a 404 endpoint was deleted from the store (self-cleaning)');
    else fail(`cleanup query wrong: ${hits.del[0].query}`);
  }

  try { b.close(); } catch {}
  mock.close();
  if (inbox) inbox.close();
  finish();
})().catch((e) => { fail('threw: ' + (e && e.message ? e.message : String(e))); finish(); });
