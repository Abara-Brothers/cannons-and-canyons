// Direct-to-Apple push (iOS native nudges). Self-hosted: spawns its OWN game
// server with Supabase and BOTH Apple hosts pointed at local mocks, so nothing
// here can reach production or Apple.
//
// WHY THIS EXISTS, beyond "the sender should work":
//
//   1. APNs is HTTP/2 ONLY, and Node's global fetch() is HTTP/1.1. A sender
//      written in fcmSend's shape fails at the protocol layer, so the transport
//      itself needs exercising, not just the payload.
//   2. JWS ES256 requires a RAW r||s signature. node:crypto signs an EC key
//      into DER-wrapped ASN.1 unless told otherwise, and the difference is
//      invisible locally — it surfaces only as 403 InvalidProviderToken from
//      Apple, which reads like a wrong key and sends you to the portal. The
//      mock therefore VERIFIES the signature rather than merely parsing it.
//   3. The caller DELETES a subscription when the sender says 'gone'. A wrong
//      apns-topic answers 400 BadTopic for EVERY device equally, so treating
//      any 400 as a dead token would wipe every iOS subscription in the
//      database on the first nudge after a misconfiguration — silently, and
//      with no way back. That is the assertion that matters most here.
//
// One nudge fans out to FOUR tokens, each scripted to a different Apple
// response, so every outcome is attributable to its own token with no timing
// correlation to get wrong.
import http from 'http';
import http2 from 'node:http2';
import crypto from 'crypto';
import { spawn } from 'child_process';
import net from 'net';
import WebSocket from 'ws';

const out = { errors: [] };
const step = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
let child = null, log = '';
const finish = () => {
  try { if (child) child.kill('SIGKILL'); } catch {}
  if (out.errors.length) console.log('\n--- server output ---\n' + log.slice(-900));
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
  process.exit(out.errors.length ? 1 : 0);
};
setTimeout(() => { fail('timeout'); finish(); }, 60000);

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const USER = 'user-alice-0000-0000-000000000001';
const TEAM = 'ABCDE12345', KID = 'KEY1234567';
const TOPIC = 'com.abarabrothers.cannonsandcanyons';

// A REAL P-256 keypair. Apple's .p8 is exactly this: a PKCS#8 PEM. Signing is
// therefore genuinely exercised, not stubbed.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const TOKENS = {
  ok: 'tok-alice-iphone-delivers',
  badtopic: 'tok-alice-ipad-configfault',
  devbuild: 'tok-alice-xcode-devbuild',
  unreg: 'tok-alice-old-uninstalled',
};

const hits = { user: [], nudgeGet: [], del: [], apns: [], apnsFallback: [] };

// ---- mock Supabase ----------------------------------------------------------
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/auth/v1/user') {
      hits.user.push({ auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: USER }));
    }
    if (u.pathname === '/rest/v1/push_subscriptions') {
      if (req.method === 'GET') {
        hits.nudgeGet.push(u.search);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(Object.values(TOKENS).map((t) => (
          { endpoint: t, sub: { platform: 'ios', token: t }, platform: 'ios' }
        ))));
      }
      if (req.method === 'DELETE') { hits.del.push(u.search); res.writeHead(204); return res.end(); }
      res.writeHead(201); return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
});

// ---- mock APNs (HTTP/2, plaintext h2c) --------------------------------------
function apnsMock(record, reply) {
  return http2.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = req.headers[':path'] || '';
      const token = path.replace('/3/device/', '');
      let parsed = null; try { parsed = JSON.parse(body); } catch {}
      // Verify the provider token the way Apple does.
      const raw = String(req.headers.authorization || '').replace(/^bearer /i, '');
      const [h, c, sig] = raw.split('.');
      let header = null, claim = null, sigOk = false;
      try {
        header = JSON.parse(Buffer.from(h, 'base64url'));
        claim = JSON.parse(Buffer.from(c, 'base64url'));
        // ieee-p1363, matching what the signer must have produced. A DER
        // signature fails HERE, which is the whole point of verifying.
        sigOk = crypto.verify('sha256', Buffer.from(`${h}.${c}`),
          { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
      } catch {}
      record.push({ token, headers: req.headers, payload: parsed, header, claim, sigOk });
      const [status, reason] = reply(token);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(reason ? JSON.stringify({ reason }) : '');
    });
  });
}
const primary = apnsMock(hits.apns, (t) => {
  if (t === TOKENS.badtopic) return [400, 'BadTopic'];
  if (t === TOKENS.devbuild) return [400, 'BadDeviceToken'];
  if (t === TOKENS.unreg) return [410, 'Unregistered'];
  return [200, null];
});
// The sandbox host accepts the development-build token the production host
// refused — which is exactly the situation the fallback exists for.
const fallback = apnsMock(hits.apnsFallback, () => [200, null]);

const openWs = (port) => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('open', () => res(ws)); ws.on('error', rej);
});
const send = (ws, m) => ws.send(JSON.stringify(m));
const until = async (test, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (test()) return true; await new Promise((r) => setTimeout(r, 100)); }
  fail(`timed out waiting for ${what}`);
  return false;
};

(async () => {
  const MOCK = await freePort(), P1 = await freePort(), P2 = await freePort(), GAME = await freePort();
  await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));
  await new Promise((r) => primary.listen(P1, '127.0.0.1', r));
  await new Promise((r) => fallback.listen(P2, '127.0.0.1', r));

  child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(GAME),
      SUPABASE_URL: `http://127.0.0.1:${MOCK}`,
      SUPABASE_PUBLISHABLE_KEY: 'pk_test', SUPABASE_SECRET_KEY: 'sk_test',
      APNS_KEY: privateKey, APNS_KEY_ID: KID, APPLE_TEAM_ID: TEAM,
      APNS_HOST: `http://127.0.0.1:${P1}`,
      APNS_FALLBACK_HOST: `http://127.0.0.1:${P2}`,
      BOT_FIRE_MS: '150', PICK_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  if (!(await until(() => /running at/.test(log), 8000, 'game server boot'))) return finish();

  const health = await fetch(`http://127.0.0.1:${GAME}/health`).then((r) => r.json()).catch(() => ({}));
  if (health.apns === true) step('/health reports the Apple push path as configured');
  else fail('/health does not report apns:true — the sender would be a silent no-op');

  // Alice signs in and hosts; Bob joins. Alice fires once then vanishes, so when
  // her turn comes round again the server must nudge every device on her ACCOUNT.
  const a = await openWs(GAME), b = await openWs(GAME);
  send(a, { type: 'hello', token: 'tok-alice' });
  send(a, { type: 'create', name: 'Iron Ridge', skin: 'olive', mode: 'duel' });
  const created = await new Promise((res) => {
    a.on('message', function on(raw) { const m = JSON.parse(raw); if (m.type === 'created') { a.off('message', on); res(m); } });
  });
  if (!(await until(() => hits.user.length >= 1, 5000, 'token verification'))) return finish();

  let aSeat = -1, aFired = false;
  a.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'start') aSeat = m.you;
    if (m.type === 'turn' && m.turn === aSeat && !aFired) {
      aFired = true;
      send(a, { type: 'fire', weapon: 'cannon', angle: 45, power: 55 });
      setTimeout(() => a.terminate(), 150);   // leave with the turn already handed over
    }
  });
  let bSeat = -1, bShots = 0;
  b.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'start') bSeat = m.you;
    if (m.type === 'turn' && m.turn === bSeat && bShots < 8) {
      bShots++; send(b, { type: 'fire', weapon: 'cannon', angle: 45, power: 55 });
    }
  });
  send(b, { type: 'join', code: created.code, name: 'Stone Falcon', skin: 'desert' });

  // ---- the four outcomes ----------------------------------------------------
  const seen = (t) => hits.apns.find((r) => r.token === t);
  if (!(await until(() => Object.values(TOKENS).every(seen), 20000, 'a push to every iOS device'))) return finish();
  step('one nudge fans out to every iOS device on the account');

  const d = seen(TOKENS.ok);
  if (d.sigOk) step('the ES256 provider token VERIFIES — the r||s encoding is right, not DER');
  else fail('the provider token signature did not verify: Apple would answer 403 InvalidProviderToken for every push');
  if (d.header && d.header.alg === 'ES256' && d.header.kid === KID) step('the JWT header carries alg ES256 and the key id');
  else fail(`JWT header wrong: ${JSON.stringify(d.header)}`);
  if (d.claim && d.claim.iss === TEAM && typeof d.claim.iat === 'number') step('the JWT claim carries the team id and an issued-at');
  else fail(`JWT claim wrong: ${JSON.stringify(d.claim)}`);

  const h = d.headers || {};
  if (h[':path'] === `/3/device/${TOKENS.ok}` && h[':method'] === 'POST'
    && h['apns-topic'] === TOPIC && h['apns-push-type'] === 'alert'
    && h['apns-priority'] === '10' && h['apns-collapse-id'] === 'cc-turn'
    && Number(h['apns-expiration']) > Math.floor(Date.now() / 1000)) {
    step('the request is addressed and headed exactly as APNs requires');
  } else fail(`APNs request headers wrong: ${JSON.stringify({
    path: h[':path'], topic: h['apns-topic'], type: h['apns-push-type'],
    pri: h['apns-priority'], collapse: h['apns-collapse-id'], exp: h['apns-expiration'] })}`);

  const pl = d.payload || {};
  if (pl.aps && pl.aps.alert && /your move/i.test(pl.aps.alert.title || '') && pl.aps.alert.body) {
    step('the alert carries a title and a body');
  } else fail(`alert shape wrong: ${JSON.stringify(pl.aps)}`);
  // Capacitor surfaces only keys OUTSIDE `aps` as notification.data, and the
  // client reads `url` from there to deep-link into the room. Nested inside
  // `aps` it is simply never delivered, and the notification opens the home
  // screen instead of the match it is about.
  if (typeof pl.url === 'string' && /room=/.test(pl.url) && !(pl.aps && pl.aps.url)) {
    step('the deep-link url sits BESIDE aps, where Capacitor can surface it');
  } else fail(`deep-link url misplaced: top-level=${JSON.stringify(pl.url)} inside-aps=${JSON.stringify(pl.aps && pl.aps.url)}`);

  if (!(await until(() => hits.del.some((q) => q.includes(encodeURIComponent(TOKENS.unreg))),
    10000, 'the uninstalled device to be cleaned up'))) return finish();
  step('a 410 Unregistered device is deleted from the store');

  if (!(await until(() => hits.apnsFallback.some((r) => r.token === TOKENS.devbuild),
    10000, 'the sandbox retry'))) return finish();
  step('a BadDeviceToken is retried against the sandbox host, so development builds still nudge');

  // THE ONE THAT MATTERS. Give the loop room to have done the wrong thing.
  await new Promise((r) => setTimeout(r, 1500));
  const wronglyDeleted = Object.entries(TOKENS)
    .filter(([k]) => k !== 'unreg')
    .filter(([, t]) => hits.del.some((q) => q.includes(encodeURIComponent(t))));
  if (wronglyDeleted.length === 0) {
    step('a 400 BadTopic does NOT delete the device — a misconfiguration cannot wipe the table');
  } else {
    fail(`these live subscriptions were DELETED over a non-fatal Apple response: ${wronglyDeleted.map(([k]) => k).join(', ')}`);
  }

  finish();
})().catch((e) => { fail('threw — ' + (e && e.message ? e.message : String(e))); finish(); });
