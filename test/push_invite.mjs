// test/push_invite.mjs — ONE TRANSPORT, TWO CALLERS.
//
// server.js has exactly one push sender, and squads gave it a second caller. The
// extraction that lets a turn nudge and a squad invite share it is the whole
// risk: three of its parts are NOT generic, and two of those three had no test
// at all before this file existed.
//
//   1. THE SEED. `pl.pushSub` hangs off the ROOM SEAT, not the account. It is the
//      subscription a player registered in this room whose persist may not have
//      landed — the in-memory sub still gets its chance. Drop it from the
//      extraction and every existing suite stays green, because the store row
//      normally carries the same endpoint. Here the store deliberately does NOT
//      carry it, so only the seed can produce that delivery.
//   2. THE SEAT HALF OF drop(). The Supabase DELETE is generic; `pl.pushSub =
//      null` belongs to the seat. Drop that and a dead endpoint is re-sent on
//      every later nudge in the room, forever, silently. Proved here by nudging
//      the same seat TWICE across a resume.
//   3. THE COLLAPSE KEY. APNs 'thread-id' + 'apns-collapse-id' and FCM
//      notification.tag were the constant 'cc-turn'. An invite reusing it
//      REPLACES an unread turn alert (R13). The invite must carry its own key on
//      all three transports while the nudge still carries 'cc-turn'.
//
// Self-hosted: spawns its OWN game servers with Supabase, both Apple hosts and
// FCM pointed at local mocks. Nothing here can reach production, Apple or Google.
import http from 'http';
import https from 'https';
import http2 from 'node:http2';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn, execFileSync } from 'child_process';
import WebSocket from 'ws';

const out = { errors: [] };
const step = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const children = [];
let log = '';
const finish = () => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  if (out.errors.length) console.log('\n--- server output ---\n' + log.slice(-1200));
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
  process.exit(out.errors.length ? 1 : 0);
};
setTimeout(() => { fail('timeout'); finish(); }, 90000);

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

// Real uuids: server/store.js's mustUuid refuses anything else, so the readable
// placeholder ids the older push suites use would throw before a query was made.
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB   = '22222222-2222-4222-8222-222222222222';
const TOKENS = { 'tok-alice': ALICE, 'tok-bob': BOB };
// displayName() proves a name by re-deriving callsign_key from callsign, so
// these pairs are what the server is entitled to believe.
const PROFILES = {
  [ALICE]: { id: ALICE, callsign: 'Ridge Hammer', callsign_key: 'ridge hammer', friend_code: 'AAAA22', callsign_set_at: '2026-01-01T00:00:00.000Z' },
  [BOB]:   { id: BOB,   callsign: 'Stone Falcon', callsign_key: 'stone falcon', friend_code: 'BBBB33', callsign_set_at: '2026-01-01T00:00:00.000Z' },
};
const FRIENDS = [[ALICE, BOB]];
const state = { blocks: [] };

const TEAM = 'ABCDE12345', KID = 'KEY1234567';
const { privateKey: APNS_P8 } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SA_KEYS = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'cc-test@cannons-and-canyons.iam.gserviceaccount.com',
  private_key: SA_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  project_id: 'cannons-and-canyons',
});
const FCM_TOKEN = 'fcm-token-alice-pixel-0001';
const IOS_TOKEN = 'apns-token-alice-iphone-0001';

// The TLS inbox, because the engine only accepts https:// web endpoints. Without
// openssl the web legs are SKIPPED LOUDLY, never faked (push_persist's rule).
let tlsOpts = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-inv-'));
  const key = path.join(dir, 'k.pem'), crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt',
    'ec_paramgen_curve:prime256v1', '-keyout', key, '-out', crt,
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  tlsOpts = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
} catch { /* the web legs are skipped */ }

const b64u = (b) => Buffer.from(b).toString('base64url');
// PHONE is the seat's in-memory subscription and is deliberately NEVER returned
// by the store. LAPTOP is store-only. One nudge must reach both.
const phoneEc = crypto.createECDH('prime256v1'); phoneEc.generateKeys();
const laptopEc = crypto.createECDH('prime256v1'); laptopEc.generateKeys();
const phoneAuth = crypto.randomBytes(16), laptopAuth = crypto.randomBytes(16);
let PHONE = null, LAPTOP = null;   // filled once the inbox port is known

const hits = { user: [], subGet: [], subPost: [], del: [], inbox: [], fcm: [], apns: [] };
const webTo = (name) => hits.inbox.filter((h) => h.path.includes(name));

// ---- mock Supabase -----------------------------------------------------------
// Only the paths this suite's servers actually reach. Anything else answers []
// so an unexpected read degrades to "no rows" instead of a 500 that would put
// the social layer into its 'unavailable' arm and hide the thing under test.
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const json = (v, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (u.pathname === '/auth/v1/health') return json({ name: 'GoTrue' });
    if (u.pathname === '/auth/v1/user') {
      const tok = String(req.headers.authorization || '').replace('Bearer ', '');
      hits.user.push(tok);
      // is_anonymous:false is what requireLinked reads: squad create and
      // invite are linked-only, and an anonymous answer would turn every squad
      // op below into 'sign_in' and prove nothing.
      if (TOKENS[tok]) return json({ id: TOKENS[tok], aud: 'authenticated', is_anonymous: false });
      res.writeHead(401); return res.end('{}');
    }
    if (u.pathname === '/fcm-oauth') return json({ access_token: 'ya29.mock-access', expires_in: 3600 });
    if (u.pathname.includes('/messages:send')) {
      hits.fcm.push(JSON.parse(body || '{}').message || {});
      return json({ name: 'projects/x/messages/1' });
    }
    if (u.pathname === '/rest/v1/profiles') {
      const eq = (u.searchParams.get('id') || '');
      const rows = [];
      if (eq.startsWith('eq.')) { const r = PROFILES[eq.slice(3)]; if (r) rows.push(r); }
      else if (eq.startsWith('in.(')) {
        for (const id of eq.slice(4, -1).split(',')) { const r = PROFILES[id]; if (r) rows.push(r); }
      }
      return json(rows);
    }
    if (u.pathname === '/rest/v1/friendships') {
      if (req.method !== 'GET') { res.writeHead(204); return res.end(); }
      const me = ((u.searchParams.get('or') || '').match(/user_a\.eq\.([0-9a-f-]{36})/) || [])[1];
      return json(FRIENDS.filter((p) => p.includes(me)).map(([a, b]) => ({ user_a: a, user_b: b })));
    }
    if (u.pathname === '/rest/v1/blocks') {
      if (req.method !== 'GET') { res.writeHead(204); return res.end(); }
      const blocker = (u.searchParams.get('blocker') || '').slice(3);
      const blocked = (u.searchParams.get('blocked') || '').slice(3);
      if (blocker) return json(state.blocks.filter((b) => b.blocker === blocker).map((b) => ({ blocked: b.blocked })));
      if (blocked) return json(state.blocks.filter((b) => b.blocked === blocked).map((b) => ({ blocker: b.blocker })));
      return json([]);
    }
    if (u.pathname === '/rest/v1/push_subscriptions') {
      if (req.method === 'POST') { hits.subPost.push(JSON.parse(body || '{}')); res.writeHead(201); return res.end(); }
      if (req.method === 'DELETE') { hits.del.push(u.search); res.writeHead(204); return res.end(); }
      const uid = (u.searchParams.get('user_id') || '').slice(3);
      hits.subGet.push(uid);
      // ALICE'S LAPTOP, PIXEL AND IPHONE — and the phone browser is NOT here.
      // It is only ever the seat's in-memory sub, which is what makes the seed
      // and the seat cleanup observable at all.
      if (uid === ALICE) {
        return json([
          { endpoint: LAPTOP.endpoint, sub: LAPTOP, platform: 'web' },
          { endpoint: FCM_TOKEN, sub: { platform: 'android', token: FCM_TOKEN }, platform: 'android' },
          { endpoint: IOS_TOKEN, sub: { platform: 'ios', token: IOS_TOKEN }, platform: 'ios' },
        ]);
      }
      return json([]);
    }
    return json([]);
  });
});

// The web inbox. The LAPTOP endpoint stays alive; the PHONE endpoint is dead, so
// the drop path runs on it and both halves of the cleanup are exercised.
const inbox = tlsOpts ? https.createServer(tlsOpts, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    hits.inbox.push({ path: req.url, body: Buffer.concat(chunks) });
    const dead = req.url.includes('alice-phone');
    res.writeHead(dead ? 404 : 201); res.end();
  });
}) : null;

// mock APNs (HTTP/2, plaintext h2c), always accepting: this suite is about the
// PAYLOAD and the COLLAPSE KEY. push_apns.mjs owns the dead-token contract.
const apnsMock = http2.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = null; try { parsed = JSON.parse(body); } catch {}
    hits.apns.push({ token: (req.headers[':path'] || '').replace('/3/device/', ''), headers: req.headers, payload: parsed });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('');
  });
});

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
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// One game server against the mocks. `env` adds to or overrides the transport
// settings; the log of every server is kept for the failure dump.
async function boot(port, env) {
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), BOT_FIRE_MS: '150', PICK_MS: '300', SOCIAL_PUSH_MS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let own = '';
  const take = (d) => { own += d; log += d; };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  if (!(await until(() => /running at/.test(own), 8000, 'game server boot'))) return false;
  // The social layer catches its own boot throw and logs "[boot] social off",
  // leaving every squad frame answered 'unavailable' — which would make every
  // invite assertion below fail for a reason that has nothing to do with push.
  if (/social off/.test(own)) { fail(`the social layer did not build: ${own.match(/\[boot\] social off.*/)?.[0]}`); return false; }
  return true;
}

(async () => {
  const MOCK = await freePort(), INBOX = await freePort(), APNS = await freePort(), GAME = await freePort();
  PHONE = { endpoint: `https://127.0.0.1:${INBOX}/push-inbox/alice-phone`,
    keys: { p256dh: b64u(phoneEc.getPublicKey()), auth: b64u(phoneAuth) } };
  LAPTOP = { endpoint: `https://127.0.0.1:${INBOX}/push-inbox/alice-laptop`,
    keys: { p256dh: b64u(laptopEc.getPublicKey()), auth: b64u(laptopAuth) } };
  await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));
  if (inbox) await new Promise((r) => inbox.listen(INBOX, '127.0.0.1', r));
  await new Promise((r) => apnsMock.listen(APNS, '127.0.0.1', r));

  const SUPA = {
    SUPABASE_URL: `http://127.0.0.1:${MOCK}`,
    SUPABASE_PUBLISHABLE_KEY: 'pk_test', SUPABASE_SECRET_KEY: 'sk_test',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  };
  const ALL_TRANSPORTS = {
    ...SUPA,
    FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
    FCM_OAUTH_URL: `http://127.0.0.1:${MOCK}/fcm-oauth`,
    FCM_API_BASE: `http://127.0.0.1:${MOCK}`,
    APNS_KEY: APNS_P8, APNS_KEY_ID: KID, APPLE_TEAM_ID: TEAM,
    APNS_HOST: `http://127.0.0.1:${APNS}`, APNS_FALLBACK_HOST: '',
  };
  if (!(await boot(GAME, ALL_TRANSPORTS))) return finish();
  step('server up with all three push transports and the social layer built');

  // ---- Part 1: the nudge caller -------------------------------------------
  const a1 = await openWs(GAME);
  send(a1, { type: 'hello', token: 'tok-alice' });
  send(a1, { type: 'create', name: 'Ridge Hammer', skin: 'olive', mode: 'duel' });
  const created = await new Promise((res) => {
    a1.on('message', function on(raw) { const m = JSON.parse(raw); if (m.type === 'created') { a1.off('message', on); res(m); } });
  });
  if (!(await until(() => hits.user.includes('tok-alice'), 5000, "Alice's token verification"))) return finish();
  // The seat's own subscription. The store's GET above deliberately omits it.
  send(a1, { type: 'pushSub', sub: PHONE, token: 'tok-alice' });
  if (!(await until(() => hits.subPost.some((b) => b.endpoint === PHONE.endpoint), 5000, 'the phone upsert'))) return finish();

  let aSeat = -1, aFired = false, aToken = null;
  a1.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'start') { aSeat = m.you; aToken = m.token; }
    if (m.type === 'turn' && m.turn === aSeat && !aFired) {
      aFired = true;
      send(a1, { type: 'fire', weapon: 'cannon', angle: 45, power: 55 });
      // 150ms: enough for ws to flush the fire frame, not enough for beginTurn
      // to run while the seat still looks connected (push_persist measured this).
      setTimeout(() => a1.terminate(), 150);
    }
  });
  const b1 = await openWs(GAME);
  send(b1, { type: 'hello', token: 'tok-bob' });
  let bSeat = -1, bShots = 0;
  b1.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'start') bSeat = m.you;
    if (m.type === 'turn' && m.turn === bSeat && bShots < 8) { bShots++; send(b1, { type: 'fire', weapon: 'cannon', angle: 45, power: 55 }); }
  });
  send(b1, { type: 'join', code: created.code, name: 'Stone Falcon', skin: 'desert' });

  if (!(await until(() => hits.fcm.length >= 1 && hits.apns.length >= 1, 30000, 'the first nudge'))) return finish();
  if (hits.fcm[0].android && hits.fcm[0].android.notification && hits.fcm[0].android.notification.tag === 'cc-turn') {
    step('the turn nudge still collapses under cc-turn on FCM');
  } else fail(`turn nudge FCM tag wrong: ${JSON.stringify(hits.fcm[0].android)}`);
  const na = hits.apns[0];
  if (na.payload && na.payload.aps && na.payload.aps['thread-id'] === 'cc-turn'
    && na.headers['apns-collapse-id'] === 'cc-turn') {
    step('the turn nudge still collapses under cc-turn on BOTH Apple surfaces');
  } else fail(`turn nudge Apple keys wrong: thread-id=${JSON.stringify(na.payload && na.payload.aps && na.payload.aps['thread-id'])} collapse-id=${JSON.stringify(na.headers['apns-collapse-id'])}`);

  if (!inbox) {
    step('SKIPPED the web legs of Part 1: openssl unavailable for the TLS inbox');
  } else {
    if (!(await until(() => webTo('alice-laptop').length >= 1, 15000, 'the stored web endpoint'))) return finish();
    step('the nudge reached the PERSISTED web endpoint (the store union survived)');
    // THE SEED. alice-phone is in no store row. If the sender stops being
    // handed pl.pushSub, this is the only assertion in the tree that notices.
    if (!(await until(() => webTo('alice-phone').length >= 1, 15000, "the seat's in-memory web endpoint"))) return finish();
    step("the nudge reached the SEAT's in-memory subscription, which no store row carries");
    if (!(await until(() => hits.del.some((q) => q.includes(encodeURIComponent(PHONE.endpoint))), 10000, 'the dead phone endpoint DELETE'))) return finish();
    step('the 404 web endpoint was DELETEd from Supabase (the generic half of drop)');

    // THE SEAT HALF OF drop(). Alice takes her seat back, fires, and vanishes
    // again, so beginTurn nudges the SAME seat a second time. pl.pushSub must
    // have been cleared by the first drop, so alice-phone must never be
    // contacted twice — there is no store row to re-supply it.
    const before = webTo('alice-laptop').length;
    const a2 = await openWs(GAME);
    send(a2, { type: 'hello', token: 'tok-alice' });
    send(a2, { type: 'resume', code: created.code, token: aToken });
    let restored = false, a2Fired = false;
    const fireAndVanish = () => {
      if (a2Fired) return;
      a2Fired = true;
      send(a2, { type: 'fire', weapon: 'cannon', angle: 45, power: 55 });
      setTimeout(() => a2.terminate(), 150);
    };
    a2.on('message', (raw) => {
      const m = JSON.parse(raw);
      // The game has been waiting on Alice since the first nudge, so the turn
      // is hers in the restore snapshot itself: no fresh 'turn' frame comes.
      if (m.type === 'restore') { restored = true; if (m.turn === aSeat) fireAndVanish(); }
      if (m.type === 'turn' && m.turn === aSeat && restored) fireAndVanish();
    });
    if (!(await until(() => restored, 10000, "Alice's seat to be restored"))) return finish();
    if (!(await until(() => webTo('alice-laptop').length > before, 30000, 'the second nudge'))) return finish();
    await settle(1500);   // room for the wrong thing to have happened
    const phoneHits = webTo('alice-phone').length;
    if (phoneHits === 1) step('the dead endpoint was cleared from the SEAT too — a second nudge never re-sent to it');
    else fail(`the seat's pushSub was not cleared: alice-phone was contacted ${phoneHits} times across two nudges`);
  }
  step('Part 1 complete');
  finish();
})().catch((e) => { fail('threw — ' + (e && e.message ? e.message : String(e))); finish(); });
