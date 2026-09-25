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
// Then the invite's side of server/social.js's push seam: 'push' only for a
// device on a transport THIS host has; a DROPPED invite (D-BLOCK 4) makes the
// same one read, gets the same answer and sends nothing; and a read that
// outlives the seam's bound sends nothing once it lands.
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
import vm from 'node:vm';
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
const CAROL = '33333333-3333-4333-8333-333333333333';   // joins Bob's squad, is no friend of Alice
const DAVE  = '44444444-4444-4444-8444-444444444444';   // Bob's friend, never enabled notifications
const ERIN  = '55555555-5555-4555-8555-555555555555';   // Bob's friend, a browser and an iPhone only
const FRANK = '66666666-6666-4666-8666-666666666666';   // Bob's friend, an Android phone only
const TOKENS = { 'tok-alice': ALICE, 'tok-bob': BOB, 'tok-carol': CAROL };
// displayName() proves a name by re-deriving callsign_key from callsign, so
// these pairs are what the server is entitled to believe. `state.bobKey` is
// flipped later to break Bob's pair on purpose.
const profile = (id, callsign, code) => ({ id, callsign, callsign_key: callsign.toLowerCase(), friend_code: code, callsign_set_at: '2026-01-01T00:00:00.000Z' });
const PROFILES = {
  [ALICE]: profile(ALICE, 'Ridge Hammer', 'AAAA22'),
  [BOB]: profile(BOB, 'Stone Falcon', 'BBBB33'),
  [CAROL]: profile(CAROL, 'Dune Harrier', 'CCCC44'),
  [DAVE]: profile(DAVE, 'Iron Kestrel', 'DDDD55'),
  [ERIN]: profile(ERIN, 'Slate Viper', 'EEEE66'),
  [FRANK]: profile(FRANK, 'Ember Lynx', 'FFFF77'),
};
const FRIENDS = [[ALICE, BOB], [BOB, DAVE], [BOB, ERIN], [BOB, FRANK]];
// `holdSubs` parks Alice's next subscription read until the test releases it.
const state = { blocks: [], bobKey: 'stone falcon', holdSubs: false, parked: null };
const releaseSubs = () => { state.holdSubs = false; if (state.parked) state.parked(); state.parked = null; };

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

// http_ece is web-push's own encryption module, so decrypting with it is not a
// second implementation to drift. It is a TRANSITIVE dependency, so a missing
// one skips the payload-content leg loudly rather than pretending.
let ece = null;
try { ece = (await import('http_ece')).default; } catch { /* payload leg skipped */ }

const b64u = (b) => Buffer.from(b).toString('base64url');
// PHONE is the seat's in-memory subscription and is deliberately NEVER returned
// by the store. LAPTOP is store-only. One nudge must reach both.
const phoneEc = crypto.createECDH('prime256v1'); phoneEc.generateKeys();
const laptopEc = crypto.createECDH('prime256v1'); laptopEc.generateKeys();
const phoneAuth = crypto.randomBytes(16), laptopAuth = crypto.randomBytes(16);
const erinEc = crypto.createECDH('prime256v1'); erinEc.generateKeys();
let PHONE = null, LAPTOP = null, ERIN_WEB = null;   // filled once the inbox port is known

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
      return json(rows.map((r) => (r.id === BOB ? { ...r, callsign_key: state.bobKey } : r)));
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
        const rows = [
          { endpoint: LAPTOP.endpoint, sub: LAPTOP, platform: 'web' },
          { endpoint: FCM_TOKEN, sub: { platform: 'android', token: FCM_TOKEN }, platform: 'android' },
          { endpoint: IOS_TOKEN, sub: { platform: 'ios', token: IOS_TOKEN }, platform: 'ios' },
        ];
        if (state.holdSubs) { state.parked = () => json(rows); return; }
        return json(rows);
      }
      if (uid === ERIN) {
        return json([
          { endpoint: ERIN_WEB.endpoint, sub: ERIN_WEB, platform: 'web' },
          { endpoint: 'apns-token-erin-iphone-0001', sub: { platform: 'ios', token: 'apns-token-erin-iphone-0001' }, platform: 'ios' },
        ]);
      }
      if (uid === FRANK) {
        return json([{ endpoint: 'fcm-token-frank-pixel-0001', sub: { platform: 'android', token: 'fcm-token-frank-pixel-0001' }, platform: 'android' }]);
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

// Every transport's traffic, and the subscription reads, as they stand; then
// what moved since.
const traffic = () => ({ fcm: hits.fcm.length, apns: hits.apns.length, web: hits.inbox.length, reads: hits.subGet.length });
const moved = (q) => `fcm +${hits.fcm.length - q.fcm}, apns +${hits.apns.length - q.apns}, web +${hits.inbox.length - q.web}, reads ${JSON.stringify(hits.subGet.slice(q.reads))}`;
const noSends = (q) => hits.fcm.length === q.fcm && hits.apns.length === q.apns && hits.inbox.length === q.web;
const readsSince = (q) => JSON.stringify(hits.subGet.slice(q.reads));

// A socket's squad frames, kept raw as well so two replies can be compared
// byte for byte, and a request that waits for the frame answering it.
function squadDriver(ws) {
  const says = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'squad') says.push({ m, raw: String(raw) }); });
  const ask = async (frame, what) => {
    send(ws, frame);
    if (!(await until(() => says.some((x) => x.m.id === frame.id), 8000, what))) return null;
    return says.find((x) => x.m.id === frame.id);
  };
  return { says, ask };
}
// Two answers are the same answer when they differ only in the request id.
const sameReply = (x, y) => x.raw.replace(`"id":"${x.m.id}"`, '') === y.raw.replace(`"id":"${y.m.id}"`, '');

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
  ERIN_WEB = { endpoint: `https://127.0.0.1:${INBOX}/push-inbox/erin-laptop`,
    keys: { p256dh: b64u(erinEc.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } };
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

  // ---- Part 2: an invite to a friend with no live socket ---------------------
  // Alice has no socket at all now (every one of hers was terminated above),
  // so the invite has nowhere in-app to go and must take the transport.
  await settle(600);
  const bob = squadDriver(b1);
  const made = await bob.ask({ type: 'squad', op: 'create', id: 'sq1' }, "Bob's squad");
  if (!made || !made.m.code) { fail(`squad create answered ${made && made.raw}`); return finish(); }
  const CODE = made.m.code;
  const KEY = `cc-squad-${CODE}`;
  const COPY = 'Stone Falcon invites you to their squad (1 of 4).';
  let q = traffic();
  const rep = await bob.ask({ type: 'squad', op: 'invite', to: ALICE, id: 'inv1' }, 'the invite reply');
  if (!rep) return finish();
  if (rep.m.ok === true && rep.m.delivered === 'push') step("an invite to an offline friend with devices answers delivered:'push'");
  else fail(`invite reply wrong: ${rep.raw}`);

  if (!(await until(() => hits.fcm.length > q.fcm, 10000, 'the invite over FCM'))) return finish();
  const ifcm = hits.fcm[hits.fcm.length - 1];
  if (ifcm.notification && ifcm.notification.title === 'Cannons & Canyons — squad invite'
    && ifcm.notification.body === COPY && ifcm.data && ifcm.data.url === `/?squad=${CODE}`) {
    step('FCM carries the invite copy and the /?squad= deep link');
  } else fail(`FCM invite payload wrong: ${JSON.stringify({ n: ifcm.notification, d: ifcm.data })}`);
  if (ifcm.android && ifcm.android.notification && ifcm.android.notification.tag === KEY) {
    step(`FCM collapses the invite under ${KEY}, not cc-turn`);
  } else fail(`FCM invite tag is ${JSON.stringify(ifcm.android && ifcm.android.notification && ifcm.android.notification.tag)} — it must not be cc-turn, or the invite replaces an unread turn alert`);

  if (!(await until(() => hits.apns.length > q.apns, 10000, 'the invite over APNs'))) return finish();
  const iap = hits.apns[hits.apns.length - 1];
  const ap = iap.payload || {};
  if (ap.aps && ap.aps.alert && ap.aps.alert.title === 'Cannons & Canyons — squad invite' && ap.aps.alert.body === COPY) {
    step('APNs carries the invite copy');
  } else fail(`APNs invite alert wrong: ${JSON.stringify(ap.aps)}`);
  // TOP LEVEL, beside aps. Capacitor surfaces only keys outside `aps` as
  // notification.data; nested inside, the deep link is simply never delivered
  // and the tap opens the home screen instead of the squad (R13).
  if (ap.url === `/?squad=${CODE}` && !(ap.aps && ap.aps.url)) {
    step('the squad deep link sits BESIDE aps, where Capacitor can surface it');
  } else fail(`squad deep link misplaced: top-level=${JSON.stringify(ap.url)} inside-aps=${JSON.stringify(ap.aps && ap.aps.url)}`);
  if (ap.aps && ap.aps['thread-id'] === KEY && iap.headers['apns-collapse-id'] === KEY) {
    step(`APNs collapses the invite under ${KEY} on BOTH surfaces`);
  } else fail(`APNs invite keys wrong: thread-id=${JSON.stringify(ap.aps && ap.aps['thread-id'])} collapse-id=${JSON.stringify(iap.headers['apns-collapse-id'])}`);

  if (!inbox || !ece) {
    step(`SKIPPED the web invite payload: ${!inbox ? 'no TLS inbox (openssl)' : 'http_ece unavailable'}`);
  } else {
    const laptopHit = () => hits.inbox.slice(q.web).find((h) => h.path.includes('alice-laptop'));
    if (!(await until(laptopHit, 10000, 'the invite over web push'))) return finish();
    let webPl = null;
    try {
      webPl = JSON.parse(ece.decrypt(laptopHit().body, { version: 'aes128gcm', privateKey: laptopEc, authSecret: laptopAuth }).toString());
    } catch (e) { fail('could not decrypt the web push body: ' + e.message); }
    if (webPl && webPl.title === 'Cannons & Canyons — squad invite' && webPl.body === COPY
      && webPl.url === `/?squad=${CODE}` && webPl.tag === KEY) {
      step('the web push payload carries the invite copy, the deep link AND its own tag');
    } else fail(`web invite payload wrong: ${JSON.stringify(webPl)}`);
  }
  // ONE READ: the seam's answer and the sends come from the same subscription
  // read, which is what lets a dry run cost exactly what a real invite does.
  if (readsSince(q) === JSON.stringify([ALICE])) step("the invite made exactly one subscription read, for the invitee's account");
  else fail(`the invite's subscription reads were ${readsSince(q)}`);

  // ---- Part 3: an online friend, and a friend who has blocked the inviter ------
  // ONLINE. Alice opens a bare socket and signs in; nothing else. The invite
  // must arrive in-app and the transports must stay silent.
  const a3 = await openWs(GAME);
  const alice = squadDriver(a3);
  send(a3, { type: 'hello', token: 'tok-alice' });
  // A social frame waits for its socket's hello, so this answer means Alice is
  // signed in and counted online. She holds no row, so the leave moves nothing.
  if (!(await alice.ask({ type: 'squad', op: 'leave', id: 'sync' }, "Alice's sign-in"))) return finish();
  q = traffic();
  const rep2 = await bob.ask({ type: 'squad', op: 'invite', to: ALICE, id: 'inv2' }, 'the online invite reply');
  if (!rep2) return finish();
  if (!(await until(() => alice.says.some((x) => x.m.op === 'invited'), 8000, "Alice's in-app invite"))) return finish();
  const inv = alice.says.find((x) => x.m.op === 'invited').m;
  if (rep2.m.delivered === 'online' && inv.code === CODE && inv.from && inv.from.callsign === 'Stone Falcon' && inv.size === 1 && inv.max === 4) {
    step('an online friend gets the invite in-app, with a proved callsign');
  } else fail(`online invite wrong: reply=${rep2.raw} frame=${JSON.stringify(inv)}`);
  await settle(1000);   // room for a push to have gone out anyway
  if (noSends(q) && hits.subGet.length === q.reads) step('no push, and not even a subscription lookup, for a player who is online');
  else fail(`an online player was pushed at: ${moved(q)}`);

  // ALICE HAS BLOCKED BOB and gone offline. Task 6 refuses the pair as
  // not_friend before the push seam is asked; what is pinned here is that no
  // notification leaves the building and no device is looked up.
  state.blocks = [{ blocker: ALICE, blocked: BOB }];
  a3.terminate();
  await settle(600);
  q = traffic();
  const rep3 = await bob.ask({ type: 'squad', op: 'invite', to: ALICE, id: 'inv3' }, 'the blocked invite reply');
  if (!rep3) return finish();
  await settle(1000);
  if (rep3.m.error === 'not_friend' && noSends(q) && hits.subGet.length === q.reads) {
    step('a player who has blocked the inviter is not pushed at, on any transport');
  } else fail(`a blocked player was pushed at: reply=${rep3.raw} ${moved(q)}`);
  state.blocks = [];

  // ---- Part 4: a name the server cannot vouch for ---------------------------
  // displayName() returns null for a callsign whose callsign_key does not
  // re-derive from it — the exact shape of a profile row the account itself
  // PATCHed. The row keeps its invite everywhere else in this build, so it
  // keeps it here; what must never happen is the word "null" landing on a
  // stranger's lock screen.
  state.bobKey = 'a key that does not match';
  q = traffic();
  const rep4 = await bob.ask({ type: 'squad', op: 'invite', to: ALICE, id: 'inv4' }, 'the unprovable-name invite reply');
  if (!rep4) return finish();
  // Every transport's send is waited for, so none of them lands in Part 5's count.
  if (!(await until(() => hits.fcm.length > q.fcm && hits.apns.length > q.apns && (!inbox || hits.inbox.length > q.web),
    10000, 'the unprovable-name invite on every transport'))) return finish();
  const nbody = (hits.fcm[hits.fcm.length - 1].notification || {}).body || '';
  if (rep4.m.delivered === 'push' && nbody === 'A player invites you to their squad (1 of 4).') {
    step('an unprovable callsign still sends, as "A player" — the row keeps its invite');
  } else fail(`unprovable-name invite wrong: reply=${rep4.raw} body=${JSON.stringify(nbody)}`);
  if (!/null|undefined/.test(nbody)) step('no "null" or "undefined" reached the notification body');
  else fail(`the notification body leaked a placeholder: ${JSON.stringify(nbody)}`);
  state.bobKey = 'stone falcon';

  // ---- Part 5: an invite a block drops (D-BLOCK 4), and a friend with no device -
  // Carol joins Bob's squad, and Alice and Carol have a block between them that
  // Bob knows nothing of. His invite to Alice is DROPPED: nothing reaches her,
  // and Bob is answered exactly what a real invite was — for an offline friend,
  // whatever the push seam's DRY RUN says: the same subscription read, no send.
  const c1 = await openWs(GAME);
  const carol = squadDriver(c1);
  send(c1, { type: 'hello', token: 'tok-carol' });
  const joined = await carol.ask({ type: 'squad', op: 'join', code: CODE, id: 'j1' }, "Carol's join");
  if (!joined || !Array.isArray(joined.m.members) || joined.m.members.length !== 2) { fail(`Carol did not join: ${joined && joined.raw}`); return finish(); }
  state.blocks = [{ blocker: ALICE, blocked: CAROL }];
  q = traffic();
  const drop1 = await bob.ask({ type: 'squad', op: 'invite', to: ALICE, id: 'inv5' }, 'the dropped invite reply');
  if (!drop1) return finish();
  await settle(1000);   // room for a send to have gone out anyway
  if (sameReply(drop1, rep)) step("a dropped invite is answered byte for byte what a real one was: delivered:'push'");
  else fail(`the dropped invite answered ${drop1.raw}; a real one answered ${rep.raw}`);
  if (noSends(q) && readsSince(q) === JSON.stringify([ALICE])) {
    step('a dropped invite sends NOTHING on any transport, and makes the one read a real invite makes');
  } else fail(`a dropped invite reached a transport or read differently: ${moved(q)}`);

  // NO DEVICE. Dave is Bob's friend and has never enabled notifications: 'none'
  // real or dropped, the same one read either way, and nothing sent.
  q = traffic();
  const dave1 = await bob.ask({ type: 'squad', op: 'invite', to: DAVE, id: 'inv6' }, 'the invite to a friend with no device');
  if (!dave1) return finish();
  state.blocks.push({ blocker: DAVE, blocked: CAROL });
  const dave2 = await bob.ask({ type: 'squad', op: 'invite', to: DAVE, id: 'inv7' }, 'the dropped invite to a friend with no device');
  if (!dave2) return finish();
  if (dave1.m.ok === true && dave1.m.delivered === 'none' && sameReply(dave1, dave2)
    && noSends(q) && readsSince(q) === JSON.stringify([DAVE, DAVE])) {
    step("a friend with no device is answered 'none', real or dropped, one read each");
  } else fail(`the no-device invites were wrong: real=${dave1.raw} dropped=${dave2.raw} ${moved(q)}`);
  state.blocks = [];

  // ---- Part 6: the seam's time runs out ---------------------------------------
  // squadInvite answers 'none' when the seam has not answered within
  // INVITE_PUSH_MS (4 s) and aborts the signal it handed over. Alice's
  // subscription read is held open past that point; when it lands, with three
  // devices on it, nothing may be sent — the inviter was told it did not go out.
  state.holdSubs = true;
  q = traffic();
  const late = await bob.ask({ type: 'squad', op: 'invite', to: ALICE, id: 'inv8' }, 'the timed-out invite reply');
  if (!late) return finish();
  const heldOpen = !!state.parked;
  releaseSubs();
  await settle(1500);   // the read has landed; room for a send to follow it
  if (late.m.delivered === 'none' && heldOpen && noSends(q)) {
    step('a read that outlives the seam sends nothing once it lands: the inviter was told none');
  } else fail(`the seam's lapse was not honoured: reply=${late.raw} read-held=${heldOpen} ${moved(q)}`);

  // ---- Part 7: hosts without every transport ----------------------------------
  // 'push' promises a device on a transport THIS host can reach. The worlds
  // below turn web push off (VAPID keys web-push refuses) and choose which
  // native senders exist; /health proves each world is the one intended.
  const NO_WEB = { VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'x' };
  const world = async (env, want, what) => {
    const port = await freePort();
    if (!(await boot(port, { ...SUPA, FIREBASE_SERVICE_ACCOUNT: '', APNS_KEY: '', ...NO_WEB, ...env }))) return null;
    const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => ({}));
    if (h.webpush !== want.webpush || h.fcm !== want.fcm || h.apns !== want.apns) {
      fail(`${what} is not the world intended: ${JSON.stringify({ webpush: h.webpush, fcm: h.fcm, apns: h.apns })}`);
      return null;
    }
    const ws = await openWs(port);
    const d = squadDriver(ws);
    send(ws, { type: 'hello', token: 'tok-bob' });
    const sq = await d.ask({ type: 'squad', op: 'create', id: 'w1' }, `a squad on ${what}`);
    if (!sq || !sq.m.code) { fail(`no squad on ${what}: ${sq && sq.raw}`); return null; }
    return d;
  };

  // One invite on a host with a single native sender: `want` is the answer, and
  // a 'push' must have gone out on `via` and on nothing else.
  const onlyVia = async (d, to, id, want, via, what) => {
    const q0 = traffic();
    const r = await d.ask({ type: 'squad', op: 'invite', to, id }, what);
    if (!r) return false;
    if (via && !(await until(() => (via === 'fcm' ? hits.fcm : hits.apns).length > q0[via], 10000, `${what} on ${via}`))) return false;
    await settle(1000);
    const sent = { fcm: hits.fcm.length - q0.fcm, apns: hits.apns.length - q0.apns, web: hits.inbox.length - q0.web };
    const ok = r.m.delivered === want && Object.entries(sent).every(([k, n]) => n === (k === via ? 1 : 0));
    if (!ok) fail(`${what}: reply=${r.raw} sent=${JSON.stringify(sent)}`);
    return ok;
  };

  // FCM ONLY. Erin has a browser and an iPhone, and this host can reach neither.
  const fcmOnly = await world({
    FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
    FCM_OAUTH_URL: `http://127.0.0.1:${MOCK}/fcm-oauth`, FCM_API_BASE: `http://127.0.0.1:${MOCK}`,
  }, { webpush: false, fcm: true, apns: false }, 'an FCM-only host');
  if (!fcmOnly) return finish();
  if (await onlyVia(fcmOnly, ERIN, 'w2', 'none', null, "the FCM-only host's invite to Erin")) {
    step("a browser and an iPhone on a host with neither sender are 'none', and nothing is sent");
  }
  // The control, and the web arm: Alice's browser row comes first, so a host
  // that counted it would fail on it before ever reaching her Android.
  if (await onlyVia(fcmOnly, ALICE, 'w3', 'push', 'fcm', "the FCM-only host's invite to Alice")) {
    step("the same host answers 'push' for Alice's Android and sends to it alone");
  }

  // APNS ONLY. Frank has an Android phone, and this host cannot reach it.
  const apnsOnly = await world({
    APNS_KEY: APNS_P8, APNS_KEY_ID: KID, APPLE_TEAM_ID: TEAM,
    APNS_HOST: `http://127.0.0.1:${APNS}`, APNS_FALLBACK_HOST: '',
  }, { webpush: false, fcm: false, apns: true }, 'an APNs-only host');
  if (!apnsOnly) return finish();
  if (await onlyVia(apnsOnly, FRANK, 'w4', 'none', null, "the APNs-only host's invite to Frank")) {
    step("an Android phone on a host with no FCM is 'none', and nothing is sent");
  }
  if (await onlyVia(apnsOnly, ALICE, 'w5', 'push', 'apns', "the APNs-only host's invite to Alice")) {
    step("the same host answers 'push' for Alice's iPhone and sends to it alone");
  }

  // NO TRANSPORT AT ALL.
  const bare = await world({}, { webpush: false, fcm: false, apns: false }, 'a host with no push transport');
  if (!bare) return finish();
  q = traffic();
  const none = await bare.ask({ type: 'squad', op: 'invite', to: ALICE, id: 'w6' }, "the bare host's invite");
  if (!none) return finish();
  await settle(1000);
  if (none.m.ok === true && none.m.delivered === 'none' && noSends(q)) step("a host with no push transport answers 'none' and sends nothing");
  else fail(`the bare host's invite was wrong: reply=${none.raw} ${moved(q)}`);

  // ---- Part 8: the web path consumes the tag --------------------------------
  // APNs and FCM take the collapse key as a wire field; the browser does not.
  // On web the key is chosen by the SERVICE WORKER when it shows the
  // notification, so sending `tag` is only half of R13 — sw.js has to read it.
  // No suite executes a service worker, so this runs the real file's push
  // listener against a stub ServiceWorkerGlobalScope and reads what it shows.
  {
    const shown = [];
    const handlers = {};
    const swSelf = {
      addEventListener: (k, fn) => { handlers[k] = fn; },
      registration: { showNotification: (title, opts) => { shown.push({ title, opts }); return Promise.resolve(); } },
    };
    vm.runInContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'),
      vm.createContext({ self: swSelf, caches: {}, clients: {}, fetch: () => {}, Response: {}, console }),
      { filename: 'sw.js' });
    if (typeof handlers.push !== 'function') { fail('public/sw.js registered no push listener'); return finish(); }
    const fire = (data) => { shown.length = 0; handlers.push({ data: { json: () => data }, waitUntil: (p) => p }); return shown[0]; };

    const invite = fire({ title: 'Cannons & Canyons — squad invite', body: COPY, url: `/?squad=${CODE}`, tag: KEY });
    if (invite && invite.opts.tag === KEY && invite.opts.data.url === `/?squad=${CODE}`) {
      step('the service worker shows a squad invite under its OWN tag, so it cannot replace a turn nudge');
    } else fail(`sw.js ignored data.tag: showed tag=${JSON.stringify(invite && invite.opts.tag)} for an invite tagged ${KEY}`);

    // A payload with no tag — an older server, or a cached worker meeting a new
    // one — must still collapse turn nudges the way it always has.
    const legacy = fire({ title: 'Cannons & Canyons — your move', body: 'Your turn is up.', url: '/?room=ABCD' });
    if (legacy && legacy.opts.tag === 'cc-turn') step('a payload with no tag still collapses under cc-turn');
    else fail(`sw.js lost the cc-turn default: ${JSON.stringify(legacy && legacy.opts.tag)}`);
  }

  finish();
})().catch((e) => { fail('threw — ' + (e && e.message ? e.message : String(e))); finish(); });
