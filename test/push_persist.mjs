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

// Web push is only ever SENT to a real push service (live hotfix, 2026-09-25).
// The inbox above is admitted by PUSH_EXTRA_HOSTS, the test-only escape hatch;
// 'localhost' is not, yet it reaches the very SAME inbox — so nothing but the
// server's host check can keep a request away from it. A player-chosen host
// could answer 201 and stream forever, and web-push buffers the whole reply.
const LOCAL_SUB = { endpoint: `https://localhost:${INBOX_PORT}/push-inbox/alice-laptop`, keys: SUB.keys };
// A stored row whose KEY is an admitted host but whose sub is not. web-push
// requests sub.endpoint, never the row's key, so the key must not be what is checked.
const SMUGGLE_KEY = `https://127.0.0.1:${INBOX_PORT}/push-inbox/smuggle-key`;
const SMUGGLE_SUB = { endpoint: `https://localhost:${INBOX_PORT}/push-inbox/smuggled`, keys: SUB.keys };
// More distinct refused hosts than the server will log, to prove the log is
// capped (100 lines) rather than a flood a stream of invented hosts could drive.
// .invalid never resolves (RFC 6761), so even a regression sends nothing anywhere.
const REFUSED_ROWS = Array.from({ length: 105 }, (_, i) => {
  const endpoint = `https://refused-${i}.example.invalid/push/${i}`;
  return { endpoint, sub: { endpoint, keys: SUB.keys }, platform: 'web' };
});

// ---- Mock Supabase + push endpoint ------------------------------------------
const hits = { user: [], upsert: [], nudgeGet: [], pushPost: [], del: [], adminDel: [], errIns: [],
               fcmOauth: [], fcmSend: [] };

// A throwaway RSA key so the server can really sign the OAuth2 JWT — the test
// verifies the signature, so a broken signing path (wrong crypto, wrong
// encoding) fails here rather than in production.
const SA_KEYS = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'cc-test@cannons-and-canyons.iam.gserviceaccount.com',
  private_key: SA_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  project_id: 'cannons-and-canyons',
});
const FCM_TOKEN = 'fcm-token-alice-pixel-0001';
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
    // The readiness probe (8.58): a valid apikey gets 200 here, a wrong one 401.
    if (u.pathname === '/auth/v1/health') {
      if (req.headers.apikey !== 'pk_test') { res.writeHead(401); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ name: 'GoTrue', version: 'mock' }));
    }
    if (u.pathname === '/auth/v1/user') {
      hits.user.push({ apikey: req.headers.apikey, auth: req.headers.authorization });
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      if (token === 'tok-alice') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: USER, aud: 'authenticated' }));
      }
      res.writeHead(401); return res.end('{}');
    }
    // ---- FCM mock: OAuth2 token exchange, then the send endpoint ----
    if (u.pathname === '/fcm-oauth') {
      const assertion = new URLSearchParams(body).get('assertion') || '';
      const [h, c, s] = assertion.split('.');
      let sigOk = false, claim = {};
      try {
        sigOk = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), SA_KEYS.publicKey,
          Buffer.from(s, 'base64url'));
        claim = JSON.parse(Buffer.from(c, 'base64url').toString());
      } catch { /* leave sigOk false */ }
      hits.fcmOauth.push({ sigOk, claim });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'ya29.mock-access', expires_in: 3600 }));
    }
    if (u.pathname.includes('/messages:send')) {
      const parsed = JSON.parse(body || '{}');
      hits.fcmSend.push({ path: u.pathname, auth: req.headers.authorization, msg: parsed.message });
      // Always UNREGISTERED. There is no shot clock, so a match legitimately
      // STALLS on the disconnected player's turn — exactly one nudge is ever
      // sent per disconnect, and a test that waited for a second one would
      // wait forever. Answering dead on the first send exercises the send
      // shape and the cleanup path from that single opportunity.
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { status: 'UNREGISTERED' } }));
    }
    if (u.pathname === '/rest/v1/error_reports' && req.method === 'POST') {
      hits.errIns.push({ apikey: req.headers.apikey, body: JSON.parse(body || '{}') });
      res.writeHead(201); return res.end();
    }
    if (u.pathname === '/rest/v1/error_reports' && req.method === 'DELETE') {
      res.writeHead(204); return res.end();       // the retention sweep
    }
    if (u.pathname === '/rest/v1/error_reports' && req.method === 'GET') {
      // The /health admin probe. It watches BOTH privileged tables now (2026-08-22):
      // watching push_subscriptions alone left a grant/RLS/schema fault confined to
      // error_reports invisible, while that is the table crash reporting depends on
      // and its insert path swallows failures. A zero-row select proves the secret
      // key and the table's reachability without reading anyone's data.
      hits.errProbe = (hits.errProbe || 0) + 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('[]');
    }
    if (u.pathname.startsWith('/auth/v1/admin/users/') && req.method === 'DELETE') {
      hits.adminDel.push({ path: u.pathname, apikey: req.headers.apikey, auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    if (u.pathname === '/rest/v1/push_subscriptions') {
      if (req.method === 'POST') {
        hits.upsert.push({ query: u.search, prefer: req.headers.prefer, apikey: req.headers.apikey, body: JSON.parse(body || '{}') });
        res.writeHead(201); return res.end();
      }
      if (req.method === 'GET') {
        hits.nudgeGet.push({ query: u.search, apikey: req.headers.apikey });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // The player has BOTH: a browser subscription and a phone. One nudge
        // must fan out across both transports.
        return res.end(JSON.stringify([
          { endpoint: SUB.endpoint, sub: SUB, platform: 'web' },
          { endpoint: FCM_TOKEN, sub: { platform: 'android', token: FCM_TOKEN }, platform: 'android' },
          { endpoint: SMUGGLE_KEY, sub: SMUGGLE_SUB, platform: 'web' },
          ...REFUSED_ROWS,
        ]));
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
  hits.pushPost.push({ path: req.url, host: req.headers.host || '' });
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
  // POSITIVE CONTROL for the zero-request proof below: on the machine running
  // this, 'localhost' must reach this very inbox. If it did not, "no request
  // reached localhost" would hold whether or not the server ever tried.
  if (inbox) {
    const probe = await new Promise((res) => {
      const r = https.request({ host: 'localhost', port: INBOX_PORT, path: '/probe', method: 'POST', rejectUnauthorized: false },
        (resp) => { resp.resume(); resp.on('end', () => res(resp.statusCode)); });
      r.setTimeout(3000, () => r.destroy(new Error('timeout')));
      r.on('error', (e) => res(e.code || e.message));
      r.end();
    });
    if (hits.pushPost.some((p) => p.path === '/probe' && p.host === `localhost:${INBOX_PORT}`)) {
      step('positive control: "localhost" reaches the push inbox on this machine');
    } else fail(`"localhost" does not reach the push inbox here (${probe}): the zero-request proof would be vacuous`);
  }
  child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(GAME_PORT),
      SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      SUPABASE_PUBLISHABLE_KEY: 'pk_test',
      SUPABASE_SECRET_KEY: 'sk_test',
      // Native push: a real (throwaway) service account plus the FCM seam
      // pointed at the mock above.
      FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
      FCM_OAUTH_URL: `http://127.0.0.1:${MOCK_PORT}/fcm-oauth`,
      FCM_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      // Test-only: lets the child trust the throwaway loopback cert.
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      // Test-only: admits this inbox as a push host, by exact host:port. The
      // stray spaces are deliberate: the control push below arrives only if the
      // parse trims them. The empty entry must simply be harmless. Production
      // never sets this.
      PUSH_EXTRA_HOSTS: ` 127.0.0.1:${INBOX_PORT} ,`,
      BOT_FIRE_MS: '150', PICK_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  child.stdout.on('data', (d) => { if (String(d).includes('running at')) ready = true; });
  let serverOut = '';
  child.stdout.on('data', (d) => { serverOut += d; });
  child.stderr.on('data', (d) => { serverOut += d; });
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

  // A second subscription, at a host that is not a push service. Registering it
  // is deliberately unchanged: accepted and persisted like any other, because
  // only SENDING is gated — a real service missing from the list can be added
  // later without a single player having to subscribe again. It also becomes
  // the seat's in-memory sub, the other route a nudge sends by.
  send(a, { type: 'pushSub', sub: LOCAL_SUB, token: 'tok-alice' });
  if (!(await until(() => hits.upsert.length >= 2, 5000, 'second subscription upsert'))) return finish();
  if (hits.upsert[1].body.endpoint === LOCAL_SUB.endpoint) {
    step('an endpoint at a non-push-service host is still registered and persisted (only sending is gated)');
  } else fail(`second upsert wrong: ${JSON.stringify(hits.upsert[1].body)}`);

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
  // Pick the NUDGE lookup specifically: /health's readiness probe (8.59) also
  // GETs this table, so index 0 is not reliably the one under test.
  const isNudge = (h) => h.query.includes('user_id=eq.');
  if (!(await until(() => hits.nudgeGet.some(isNudge), 30000, 'nudge subscription lookup'))) return finish();
  const g = hits.nudgeGet.find(isNudge);
  if (g.query.includes(`user_id=eq.${USER}`) && g.apikey === 'sk_test') step('nudge looks subscriptions up by account with the secret key');
  else fail(`nudge lookup wrong: ${JSON.stringify(g)}`);
  // Every inbox request not addressed to the admitted host, bar the test's own probe.
  const offList = () => hits.pushPost.filter((p) => p.host !== `127.0.0.1:${INBOX_PORT}` && p.path !== '/probe');
  if (!inbox) {
    step('SKIPPED delivery, cleanup and zero-request legs: openssl unavailable for the TLS inbox');
  } else {
    // The CONTROL: the admitted host still gets its push, so what follows is a
    // refusal of the other host and not a web push path that simply went dead.
    if (!(await until(() => hits.pushPost.some((p) => p.path === '/push-inbox/alice-phone'
      && p.host === `127.0.0.1:${INBOX_PORT}`), 10000, 'web push delivery'))) return finish();
    step('an encrypted web push reached the stored endpoint');
    if (!(await until(() => hits.del.length >= 1, 10000, 'dead-endpoint cleanup'))) return finish();
    if (hits.del[0].query.includes('endpoint=eq.')) step('a 404 endpoint was deleted from the store (self-cleaning)');
    else fail(`cleanup query wrong: ${hits.del[0].query}`);
  }

  // The refusal legs below need no inbox, so they run with or without openssl.
  // One nudge refuses every endpoint in a single synchronous loop; wait for its
  // last log line, then a margin for anything a refusal might wrongly set off.
  // The zero-request check runs again at the very end of this file.
  const HOST_LINE = /^\[push\] web push not sent: endpoint not allowed \(host "[^"]*"\)$/;
  const CAP_LINE = /^\[push\] refusal log full at 100 hosts: /;
  const pushLines = () => serverOut.split('\n').filter((l) => l.startsWith('[push]'));
  const logWait0 = Date.now();
  while (Date.now() - logWait0 < 10000 && !pushLines().some((l) => CAP_LINE.test(l))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 1500));
  if (inbox) {
    const stray = offList();
    if (stray.length === 0) {
      step('ZERO requests reached a non-push-service host — neither the in-memory sub nor a stored row whose key looked admitted');
    } else fail(`a nudge sent ${stray.length} request(s) to a host that is not a push service: ${JSON.stringify(stray.slice(0, 4))}`);
  }
  // Refused is not dead: nothing was asked, so nothing may be deleted.
  const dels = hits.del.map((d) => decodeURIComponent(d.query));
  const wrongDel = [LOCAL_SUB.endpoint, SMUGGLE_KEY, REFUSED_ROWS[0].endpoint].filter((e) => dels.some((q) => q.includes(e)));
  if (wrongDel.length === 0) step('a refused endpoint is skipped, NOT deleted — adding its host later loses nobody');
  else fail(`a refused endpoint was deleted from the store: ${wrongDel.join(', ')}`);
  // One line per distinct refused host, worded so it never claims the host is
  // not a push service (an endpoint can be refused for its port or spelling at
  // a real service's host), capped at 100, then ONE line saying the log is full
  // so a reader knows it is incomplete. Never the endpoint itself (a push
  // endpoint is a capability URL).
  const lines = pushLines();
  const hostLines = lines.filter((l) => HOST_LINE.test(l));
  const capLines = lines.filter((l) => CAP_LINE.test(l));
  const otherLines = lines.filter((l) => !HOST_LINE.test(l) && !CAP_LINE.test(l));
  if (otherLines.length === 0) step('every refusal line reads "endpoint not allowed (host ...)", or says the log is full');
  else fail(`a [push] line is worded otherwise: ${JSON.stringify(otherLines.slice(0, 2))}`);
  const localLines = hostLines.filter((l) => l.includes('(host "localhost")'));
  if (localLines.length === 1) step('the refused host is logged exactly once for its two endpoints');
  else fail(`expected one log line for the refused host "localhost", got ${localLines.length}: ${JSON.stringify(localLines)}`);
  if (hostLines.length === 100 && capLines.length === 1 && lines.length === 101 && CAP_LINE.test(lines[100])) {
    step(`the refusal log is capped: ${1 + REFUSED_ROWS.length} distinct refused hosts, 100 host lines, then one "log full" line`);
  } else fail(`expected 100 host lines then one "log full" line for ${1 + REFUSED_ROWS.length} distinct hosts, got ${hostLines.length} host line(s) and ${capLines.length} "log full" line(s) of ${lines.length}`);
  const leakedEndpoint = serverOut.split('\n').filter((l) => l.includes('/push-inbox/') || l.includes('/push/0'));
  if (leakedEndpoint.length === 0) step('no log line carries an endpoint — hostnames only');
  else fail(`the server logged a push endpoint: ${JSON.stringify(leakedEndpoint.slice(0, 2))}`);

  // ---- Health readiness (8.58) ----------------------------------------------
  // Production silently dropped every push subscription for nine batches
  // because one Supabase env var was wrong and nothing reported it. /health is
  // the fix; this asserts it tells the truth in the configured case AND that it
  // leaks nothing.
  const health = await new Promise((res) => {
    http.get({ host: '127.0.0.1', port: GAME_PORT, path: '/health' }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    }).on('error', () => res(null));
  });
  // supabaseAdmin is the leg that matters most: with a good publishable key and
  // a stale SECRET key, sign-in and cloud saves work while push storage,
  // deletion and crash reports fail silently — production's exact state on
  // 2026-08-13, which the first version of this endpoint reported as healthy.
  if (health && health.supabase === 'ok' && health.supabaseAdmin === 'ok'
    && health.fcm === true && health.webpush === true) {
    step(`/health reports readiness truthfully (supabase+admin ok, fcm=true, version ${health.version})`);
  } else fail(`/health wrong: ${JSON.stringify(health)}`);
  // Look for the ACTUAL secrets this server holds, not the word "key" — the
  // first version of this check flagged its own healthy output, because the
  // value `bad_key_or_url` contains "key".
  const leaked = JSON.stringify(health || {});
  const secrets = ['sk_test', 'pk_test', 'BEGIN ', 'PRIVATE KEY', SERVICE_ACCOUNT.slice(0, 40),
    FCM_TOKEN, `127.0.0.1:${MOCK_PORT}`, 'iam.gserviceaccount.com'];
  const found = secrets.filter(s => leaked.includes(s));
  if (found.length) fail(`/health leaks configuration: ${found.join(', ')}`);
  else step('/health exposes booleans only — no keys, URLs or tokens');

  // The admin probe must touch BOTH privileged tables. Watching push_subscriptions
  // alone left a grant/RLS/schema fault confined to error_reports invisible to
  // every signal the server emits — while that is the table crash reporting
  // depends on, and its insert path swallows failures (2026-08-22).
  if (!hits.errProbe) fail('/health never probed error_reports — an error_reports-only fault would be invisible');
  else step('/health probes error_reports as well as push_subscriptions');

  // ---- Native push via FCM (8.57) -------------------------------------------
  // The same nudge that reached the browser must also reach the phone, through
  // a genuinely signed OAuth2 exchange.
  if (!(await until(() => hits.fcmOauth.length >= 1, 10000, 'FCM OAuth2 token exchange'))) return finish();
  const oa = hits.fcmOauth[0];
  if (oa.sigOk) step('the OAuth2 JWT is signed correctly (verified against the service-account public key)');
  else fail('the OAuth2 JWT signature did not verify — the FCM path would never authenticate');
  if (oa.claim.iss === 'cc-test@cannons-and-canyons.iam.gserviceaccount.com'
    && oa.claim.scope === 'https://www.googleapis.com/auth/firebase.messaging') {
    step('JWT claims name the service account and the messaging scope');
  } else fail(`JWT claims wrong: ${JSON.stringify(oa.claim)}`);

  if (!(await until(() => hits.fcmSend.length >= 1, 10000, 'FCM send'))) return finish();
  const fs1 = hits.fcmSend[0];
  if (fs1.path.includes('/v1/projects/cannons-and-canyons/messages:send')
    && fs1.auth === 'Bearer ya29.mock-access'
    && fs1.msg.token === FCM_TOKEN
    && fs1.msg.notification && /your move/i.test(fs1.msg.notification.title)
    && fs1.msg.data && /room=/.test(fs1.msg.data.url)) {
    step('the phone gets a correctly addressed FCM message with the minted token');
  } else fail(`FCM send shape wrong: ${JSON.stringify(fs1).slice(0, 300)}`);

  // The mock answered UNREGISTERED, so the row must be deleted — the native
  // half of the self-cleaning contract that ISSUE-002 asked for.
  if (await until(() => hits.del.some(d => d.query.includes(encodeURIComponent(FCM_TOKEN))),
    10000, 'dead FCM token cleanup')) {
    step('an UNREGISTERED token is deleted from the store (self-cleaning)');
  }
  // NOT COVERED HERE, deliberately: access-token CACHING across many sends.
  // One disconnect produces exactly one nudge (no shot clock — the match stalls
  // on the absent player's turn), so this suite has no second send to prove the
  // cache with. The cache is a 60-second-skew expiry check in fcmAccessToken().

  // ---- Account deletion endpoint (8.49) -------------------------------------
  // Same verify-then-privileged pattern over HTTP: the caller's own token is
  // verified with the publishable key, the delete lands on the admin API with
  // the secret key. Junk tokens and wrong methods are turned away.
  const httpReq = (method, headers) => new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: GAME_PORT, path: '/account/delete', method, headers }, (resp) => {
      let body = ''; resp.on('data', (c) => { body += c; }); resp.on('end', () => res({ status: resp.statusCode, body }));
    });
    r.on('error', () => res({ status: 0 })); r.end();
  });
  const wrongMethod = await httpReq('GET', {});
  if (wrongMethod.status === 405) step('account delete rejects non-POST (405)');
  else fail(`GET /account/delete answered ${wrongMethod.status}, expected 405`);
  const junk = await httpReq('POST', { Authorization: 'Bearer not-a-real-token' });
  if (junk.status === 401 && hits.adminDel.length === 0) step('a junk token gets 401 and never reaches the admin API');
  else fail(`junk-token delete: status ${junk.status}, adminDel hits ${hits.adminDel.length}`);
  const real = await httpReq('POST', { Authorization: 'Bearer tok-alice' });
  if (real.status === 200 && hits.adminDel.length === 1) {
    const d = hits.adminDel[0];
    if (d.path.endsWith(`/${USER}`) && d.apikey === 'sk_test' && d.auth === 'Bearer sk_test') {
      step('a valid token deletes exactly its OWN user via the admin API with the secret key');
    } else fail(`admin delete shape wrong: ${JSON.stringify(d)}`);
  } else fail(`valid-token delete: status ${real.status}, adminDel hits ${hits.adminDel.length}`);

  // ---- Crash-report ingestion (8.52) ----------------------------------------
  // Unauthenticated but capped: fields truncate server-side, giant bodies are
  // cut off, non-POST is refused, and nothing identifying is stored.
  const errReq = (method, payload) => new Promise((res) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: GAME_PORT, path: '/errors', method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (resp) => { resp.resume(); resp.on('end', () => res({ status: resp.statusCode })); });
    r.on('error', () => res({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
  const wrongErrMethod = await errReq('GET');
  if (wrongErrMethod.status === 405) step('/errors rejects non-POST (405)');
  else fail(`GET /errors answered ${wrongErrMethod.status}, expected 405`);
  const before = hits.errIns.length;
  await errReq('POST', { message: 'x'.repeat(600), stack: 'at boom()', source: 'app.js:1:1', version: '1.0.0+1', platform: 'test-agent', account: 'should-be-ignored' });
  await new Promise((r) => setTimeout(r, 800));
  const ins = hits.errIns[before];
  if (ins && ins.apikey === 'sk_test' && ins.body.side === 'client'
    && ins.body.message.length === 500 && ins.body.account === undefined) {
    step('a client report lands with the secret key, truncated, with unknown fields dropped');
  } else fail(`error insert wrong: ${JSON.stringify(ins && ins.body ? { len: ins.body.message.length, side: ins.body.side, extra: 'account' in ins.body } : ins)}`);
  const giant = await errReq('POST', { message: 'y'.repeat(20000) });
  await new Promise((r) => setTimeout(r, 500));
  if (hits.errIns.length === before + 1) step('an oversized body is cut off and never stored');
  else fail(`oversized body produced ${hits.errIns.length - before - 1} extra insert(s)`);

  // The refusal must hold for the whole run, not just the moment it was checked.
  if (inbox) {
    const late = offList();
    if (late.length === 0) step('still zero requests to a non-push-service host at the end of the run');
    else fail(`a request reached a non-push-service host after all: ${JSON.stringify(late.slice(0, 4))}`);
  }

  try { b.close(); } catch {}
  mock.close();
  if (inbox) inbox.close();
  finish();
})().catch((e) => { fail('threw: ' + (e && e.message ? e.message : String(e))); finish(); });
