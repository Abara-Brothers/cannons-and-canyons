// server.js — the HOST. Serves public/ over HTTP, terminates WebSockets, owns
// web push, and shuts down cleanly. It does NOT know the rules of the game.
//
// Everything about rooms, turns, bots, damage and modes lives in
// public/room-engine.js, which is browser-safe so that an offline match runs the
// SAME engine rather than a second implementation of it (ADR-001 / BQ-007). The
// seam is narrow on purpose: this file parses and rate-limits frames, then hands
// them to handleClientMessage. It injects pushNudge back the other way, because
// VAPID keys and a Node push library are host concerns the browser copy has no
// business carrying.
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';   // FCM JWT signing — node:crypto, NOT the WebCrypto global
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import {
  rooms, send, handleClientMessage, handleClose,
  setPushNudge, setAuthSink, setPushSubSink,
} from './public/room-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
// Reported by /health so a deploy can be identified without guessing from
// asset contents. Read once at boot; a missing package.json must not be fatal.
let pkgVersion = 'unknown';
try {
  const pk = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  pkgVersion = `${pk.version}+${pk.build}`;
} catch {}

// ---- Static file server ----------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// ---- Web Push (turn nudges) ---------------------------------------------------
// VAPID keys come from env in production; otherwise they're generated once and
// persisted next to the process so subscriptions survive restarts on the same
// disk. If web-push is somehow unavailable, everything degrades to no-op.
let webpush = null, vapidPublicKey = '';
try {
  webpush = (await import('web-push')).default;
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const vf = path.join(process.cwd(), 'data', 'vapid.json');
    try {
      ({ pub, priv } = JSON.parse(fs.readFileSync(vf, 'utf8')));
    } catch {
      const k = webpush.generateVAPIDKeys();
      pub = k.publicKey; priv = k.privateKey;
      try { fs.mkdirSync(path.dirname(vf), { recursive: true }); fs.writeFileSync(vf, JSON.stringify({ pub, priv })); } catch {}
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:jordan@bluepixel.com.au', pub, priv);
  vapidPublicKey = pub;
} catch { webpush = null; }

// ---- Supabase (ADR-005) -------------------------------------------------------
// Two keys, two jobs, deliberately separated:
//   PUBLISHABLE verifies a client's access token (GET /auth/v1/user) — it can
//   see nothing a browser could not.
//   SECRET reads and writes push_subscriptions, a table whose RLS has NO
//   policies precisely so only this process can touch it. It must never
//   appear under public/ and never in a client-reachable response.
// All of it degrades to no-ops when the env is absent (local dev, CI).
const SB_URL = process.env.SUPABASE_URL || '';
const SB_PUB = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || '';

// Who does this access token belong to? null on any failure — a garbage or
// expired token must cost the sender nothing but the feature.
async function sbUserFromToken(token) {
  if (!SB_URL || !SB_PUB || typeof token !== 'string' || !token || token.length > 4096) return null;
  try {
    const res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_PUB, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const u = await res.json();
    return u && typeof u.id === 'string' ? u.id : null;
  } catch { return null; }
}

// Privileged PostgREST call. Body-parsing mirrors the client's hard-won
// lesson: return=minimal answers 2xx with an EMPTY body, so parse by content.
async function sbAdmin(method, path, body, prefer) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SB_SECRET,
      Authorization: `Bearer ${SB_SECRET}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`sb ${method} ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// A socket says hello with its account token: verify, remember. The userId
// rides on the socket object, so a resumed seat keeps its identity as long
// as the reconnecting socket says hello too (the client does, on every open).
setAuthSink((ws, token) => {
  sbUserFromToken(token).then((id) => { if (id) ws.userId = id; }).catch(() => {});
});

// A player registered a push subscription: persist it keyed to their account
// so it survives room teardown, deploys, and works from every device. The
// engine already stored the in-memory copy and sent pushOk; this is the
// durable half, best-effort by design (ISSUE-003).
setPushSubSink((ws, sub, token) => {
  (async () => {
    const id = ws.userId || await sbUserFromToken(token);
    if (id) ws.userId = id;
    if (!id || !SB_SECRET) return;
    // Web subscriptions carry a URL endpoint; native ones carry an FCM token
    // under `sub.token` with `sub.platform` naming the OS. One row shape, one
    // upsert — see the 8.57 migration for why endpoint holds both.
    const native = sub.platform === 'android' || sub.platform === 'ios';
    const endpoint = native ? sub.token : sub.endpoint;
    if (!endpoint) return;
    await sbAdmin('POST', '/push_subscriptions?on_conflict=endpoint', {
      user_id: id,
      endpoint,
      sub,
      platform: native ? sub.platform : 'web',
      last_seen_at: new Date().toISOString(),
    }, 'resolution=merge-duplicates,return=minimal');
  })().catch(() => {});
});

// ---- Firebase Cloud Messaging (native push, batch 8.57) ----------------------
// FCM's HTTP v1 API needs an OAuth2 access token, which means signing a JWT
// with the service account's private key. That is ~40 lines with node:crypto
// and zero dependencies — the same reasoning as ADR-007. The legacy server-key
// API would have been one header, but Google retired it.
//
// FIREBASE_SERVICE_ACCOUNT holds the service-account JSON as a single env
// string. It is a SECRET (it can mint tokens for the project): server-side
// only, never in public/, never logged. Absent it, native push degrades to a
// no-op and web push is unaffected.
let fcm = null;
try {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const sa = JSON.parse(raw);
    if (sa.client_email && sa.private_key && sa.project_id) {
      fcm = { email: sa.client_email, key: sa.private_key.replace(/\\n/g, '\n'), project: sa.project_id, token: null, exp: 0 };
    }
  }
} catch { fcm = null; }   // malformed JSON must not take the process down

// Test seam. Google's real hosts are the defaults; test/push_persist.mjs points
// these at a local mock so the WHOLE FCM path — JWT signing, token caching,
// send shape, dead-token cleanup — is exercised without a Firebase project.
// Overriding them in production would send push tokens to a third party, so
// they are deliberately env-only and undocumented outside this comment.
const FCM_OAUTH_URL = process.env.FCM_OAUTH_URL || 'https://oauth2.googleapis.com/token';
const FCM_API_BASE = process.env.FCM_API_BASE || 'https://fcm.googleapis.com';

const b64url = (b) => Buffer.from(b).toString('base64url');

// Mint (and cache) a Google OAuth2 access token for the FCM scope.
async function fcmAccessToken() {
  if (!fcm) return null;
  const now = Math.floor(Date.now() / 1000);
  if (fcm.token && fcm.exp - 60 > now) return fcm.token;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: fcm.email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claim}`), fcm.key).toString('base64url');
  const res = await fetch(FCM_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(`fcm oauth ${res.status}`);
  const j = await res.json();
  fcm.token = j.access_token;
  fcm.exp = now + (j.expires_in || 3600);
  return fcm.token;
}

// Deliver one nudge to one native device. Resolves to 'gone' when FCM says the
// token is dead, so the caller can clean the row out — the same self-cleaning
// contract the web push path has.
async function fcmSend(token, title, body, url) {
  const access = await fcmAccessToken();
  if (!access) return 'skip';
  const res = await fetch(`${FCM_API_BASE}/v1/projects/${fcm.project}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data: { url: String(url || '/') },
        android: { priority: 'high', notification: { tag: 'cc-turn' } },
      },
    }),
  });
  if (res.ok) return 'ok';
  // 404 / UNREGISTERED / INVALID_ARGUMENT on the token all mean: stop trying.
  if (res.status === 404 || res.status === 400) return 'gone';
  throw new Error(`fcm send ${res.status}`);
}

// Nudge every device the player has, not just the one that subscribed in this
// room's lifetime: the in-memory sub (if any) plus every persisted sub for
// the account. A push endpoint answering 404/410 is dead — drop it from both
// stores so the lists self-clean (ISSUE-002's cleanup requirement).
function pushNudge(room, seat) { pushNudgeAsync(room, seat).catch(() => {}); }
async function pushNudgeAsync(room, seat) {
  const pl = room.players[seat];
  // Either transport is enough to be worth trying: a web-only server (no FCM
  // key) still nudges browsers, and an FCM-only one still nudges phones.
  if ((!webpush && !fcm) || !pl || pl.bot || pl.connected) return;
  const targets = new Map();   // endpoint -> { sub, platform }
  if (pl.pushSub && pl.pushSub.endpoint) targets.set(pl.pushSub.endpoint, { sub: pl.pushSub, platform: 'web' });
  // The live socket first; the identity the engine carried over at disconnect
  // second — the disconnect case is precisely when a nudge matters.
  const uid = (pl.ws && pl.ws.userId) || pl.userId;
  if (uid && SB_SECRET) {
    try {
      const rows = await sbAdmin('GET',
        `/push_subscriptions?user_id=eq.${encodeURIComponent(uid)}&select=endpoint,sub,platform`);
      for (const r of rows || []) {
        if (r.endpoint) targets.set(r.endpoint, { sub: r.sub, platform: r.platform || 'web' });
      }
    } catch { /* the in-memory sub still gets its chance */ }
  }
  if (!targets.size) return;
  const opp = room.players.find((p, i) => p && i !== seat && !p.bot);
  const title = 'Cannons & Canyons — your move';
  const body = opp ? `${opp.name} has taken their shot. Your turn.` : 'Your turn is up.';
  const url = `/?room=${room.code}`;
  const payload = JSON.stringify({ title, body, url });

  const drop = (endpoint) => {
    if (pl.pushSub && pl.pushSub.endpoint === endpoint) pl.pushSub = null;
    if (SB_SECRET) {
      sbAdmin('DELETE', `/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`).catch(() => {});
    }
  };

  for (const [endpoint, { sub, platform }] of targets) {
    if (platform === 'web') {
      if (!webpush || !sub) continue;
      webpush.sendNotification(sub, payload).catch((err) => {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) drop(endpoint);
      });
    } else {
      // android / ios: the endpoint IS the FCM registration token.
      if (!fcm) continue;
      fcmSend(endpoint, title, body, url)
        .then((r) => { if (r === 'gone') drop(endpoint); })
        .catch(() => { /* transient: the next turn tries again */ });
    }
  }
}

// The one capability the engine cannot have: sending a push needs the VAPID keys
// and the Node library above. Injected rather than imported so the browser copy
// of the engine simply keeps its no-op default.
setPushNudge(pushNudge);

// ---- Account deletion (ADR-003; a hard store requirement on both platforms) --
// GoTrue has no self-serve delete, so this host brokers it: verify the
// caller's own access token, then delete that user with the secret key. The
// FK cascade wipes profiles and push_subscriptions with the auth row. Same
// verify-then-privileged pattern as the push sinks; degrades to 503 without
// env. The global limiter is deliberately crude — deletion is rare, and the
// cap's job is only to stop a junk-token flood from turning this endpoint
// into a relay that hammers GoTrue.
let delTokens = 10;
setInterval(() => { delTokens = Math.min(10, delTokens + 1); }, 6000).unref();

async function accountDelete(req, res, cors) {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify(obj));
  };
  if (!SB_URL || !SB_PUB || !SB_SECRET) return json(503, { error: 'accounts are not enabled on this server' });
  if (delTokens < 1) return json(429, { error: 'try again shortly' });
  delTokens -= 1;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const uid = await sbUserFromToken(token);
  if (!uid) return json(401, { error: 'invalid or expired session' });
  try {
    const del = await fetch(`${SB_URL}/auth/v1/admin/users/${encodeURIComponent(uid)}`, {
      method: 'DELETE',
      headers: { apikey: SB_SECRET, Authorization: `Bearer ${SB_SECRET}` },
    });
    // 404 = already gone (a retry after a dropped response) — that IS success.
    if (!del.ok && del.status !== 404) return json(502, { error: 'deletion failed upstream' });
    json(200, { ok: true });
  } catch { json(502, { error: 'deletion failed upstream' }); }
}

// ---- Crash / error reports (ISSUE-006) ---------------------------------------
// Unauthenticated on purpose: crash reporting must work precisely when
// everything else (auth included) is broken. The defences are caps, not
// identity: a global rate bucket, an 8KB body ceiling, hard field truncation,
// and a 204 regardless of outcome so the endpoint leaks nothing. No IP and no
// account id are ever stored — privacy.html promises exactly that.
let errTokens = 30;
setInterval(() => { errTokens = Math.min(30, errTokens + 1); }, 2000).unref();

function ingestError(req, res, cors) {
  const done = () => { res.writeHead(204, cors); res.end(); };
  if (errTokens < 1) return done();
  errTokens -= 1;
  let body = '';
  let dead = false;
  req.on('data', (c) => {
    body += c;
    if (body.length > 8192) { dead = true; try { req.destroy(); } catch {} done(); }
  });
  req.on('end', () => {
    if (dead) return;
    try {
      const j = JSON.parse(body || '{}');
      const s = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
      const row = {
        side: 'client',
        message: s(j.message, 500) || 'unknown error',
        stack: s(j.stack, 4000),
        source: s(j.source, 300),
        version: s(j.version, 40),
        platform: s(j.platform, 200),
      };
      if (SB_SECRET) {
        sbAdmin('POST', '/error_reports', row, 'return=minimal').catch(() => {});
      } else {
        console.error('[client-error]', row.message, row.source || '');
      }
    } catch { /* malformed body: drop */ }
    done();
  });
}

// Server-side faults land in the same table, so one query shows both halves.
function reportServerError(kind, err) {
  if (!SB_SECRET) return;
  const msg = err && err.message ? err.message : String(err);
  sbAdmin('POST', '/error_reports', {
    side: 'server',
    message: `${kind}: ${msg}`.slice(0, 500),
    stack: err && err.stack ? String(err.stack).slice(0, 4000) : null,
    version: process.env.RENDER_GIT_COMMIT ? String(process.env.RENDER_GIT_COMMIT).slice(0, 40) : null,
    platform: `node ${process.version}`,
  }, 'return=minimal').catch(() => {});
}

// Retention is a promise in privacy.html, so it is enforced here: a daily
// sweep deletes reports older than 30 days. unref'd — housekeeping must never
// hold the process open.
if (SB_SECRET) {
  const sweep = () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    sbAdmin('DELETE', `/error_reports?created_at=lt.${encodeURIComponent(cutoff)}`).catch(() => {});
  };
  setTimeout(sweep, 60 * 1000).unref();                       // shortly after boot
  setInterval(sweep, 24 * 60 * 60 * 1000).unref();            // then daily
}

// ---- Health / readiness (batch 8.58) -----------------------------------------
// This exists because a real failure hid for nine batches. Push-subscription
// persistence (8.48) was verified only against a mock; in production every
// upsert was silently dropped because the server could not verify a player's
// token — one wrong Supabase env var — and NOTHING said so. The sink is
// best-effort by design, so it swallowed the error exactly as written.
//
// So: report readiness, out loud at boot and on demand here. No secrets, no
// URLs, no key prefixes — booleans and one probe result. `supabase` is the one
// that matters: 'ok' means this server can actually verify a player token,
// which is the precondition for cloud saves, push persistence and deletion.
// TWO keys, two jobs, two ways to be wrong — and the first version of this
// check only tested one of them. With a correct publishable key and a stale
// SECRET key, everything a player does directly (sign-in, cloud save) works
// while everything the SERVER does on their behalf (push storage, deletion,
// crash reports) fails silently. That is exactly the state production was found
// in, one fix after the URL. Both are probed now.
let supabaseHealth = 'unchecked';        // auth/client path: publishable key
let supabaseAdminHealth = 'unchecked';   // privileged path: secret key
async function checkSupabase() {
  if (!SB_URL || !SB_PUB || !SB_SECRET) {
    supabaseHealth = supabaseAdminHealth = 'unconfigured';
    return supabaseHealth;
  }
  try {
    // /auth/v1/health is the endpoint that actually DISCRIMINATES: with a valid
    // apikey it answers 200, with a wrong one 401. (/auth/v1/user does not —
    // it answers 401 either way when there is no user token, which is exactly
    // the false negative this check was written wrong with the first time.)
    const res = await fetch(`${SB_URL}/auth/v1/health`, { headers: { apikey: SB_PUB } });
    supabaseHealth = res.ok ? 'ok' : 'bad_key_or_url';
  } catch { supabaseHealth = 'unreachable'; }
  try {
    // A zero-row read of a table whose RLS has NO policies: only a key that
    // bypasses RLS gets 200, so this proves the secret key without returning
    // any data or writing anything.
    const res = await fetch(`${SB_URL}/rest/v1/push_subscriptions?select=id&limit=0`, {
      headers: { apikey: SB_SECRET, Authorization: `Bearer ${SB_SECRET}` },
    });
    supabaseAdminHealth = res.ok ? 'ok' : 'bad_secret_key';
  } catch { supabaseAdminHealth = 'unreachable'; }
  return supabaseHealth;
}
checkSupabase().then(() => {
  const line = `[boot] supabase=${supabaseHealth} supabaseAdmin=${supabaseAdminHealth}`
    + ` webpush=${!!webpush} fcm=${!!fcm}`;
  // 'unconfigured' is the NORMAL state for local dev and CI, which have no
  // Supabase env by design — shouting there would train everyone to ignore
  // this line, which is precisely the failure being fixed. The states that
  // mean something is WIRED WRONG get stderr and an instruction naming the
  // variable to check, because "supabase is broken" cost two round trips.
  const bad = [];
  if (supabaseHealth !== 'ok' && supabaseHealth !== 'unconfigured') {
    bad.push('SIGN-IN/CLOUD SAVES are broken: check SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY');
  }
  if (supabaseAdminHealth !== 'ok' && supabaseAdminHealth !== 'unconfigured') {
    bad.push('PUSH STORAGE/ACCOUNT DELETION/CRASH REPORTS are broken: check SUPABASE_SECRET_KEY');
  }
  if (!bad.length) console.log(line);
  else console.error(`${line}\n       <-- ${bad.join('\n       <-- ')}`);
});

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      version: pkgVersion,
      rooms: rooms.size,
      supabase: supabaseHealth,            // ok | unconfigured | bad_key_or_url | unreachable
      supabaseAdmin: supabaseAdminHealth,  // ok | unconfigured | bad_secret_key | unreachable
      webpush: !!webpush,
      fcm: !!fcm,
    }));
  }
  if (urlPath === '/errors') {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }
    ingestError(req, res, cors);
    return;
  }
  if (urlPath === '/account/delete') {
    // CORS like /push/key: a packaged build calls cross-origin, and the
    // Authorization header forces a preflight. The header is the whole auth
    // story — the wildcard origin exposes nothing a stolen token would not.
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, cors); return res.end(); }
    accountDelete(req, res, cors);
    return;
  }
  if (urlPath === '/push/key') {
    // CORS, narrowly: a packaged Capacitor build fetches this cross-origin
    // (its own origin is capacitor://localhost or https://localhost), so
    // without the header the native app cannot read its own push key. The
    // VAPID *public* key is public by definition — it ships to every browser
    // already — so `*` costs nothing here. Do NOT copy this onto any endpoint
    // that returns player or match data.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ key: vapidPublicKey }));
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback so /?room=CODE deep links still load.
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- WebSocket wiring -------------------------------------------------------
// maxPayload caps a single frame. Game messages are tiny (the largest inbound
// is a 7-id loadout); 64 KB is generous and stops a single socket buffering
// megabytes into the process.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

// Per-socket message rate limit. maxPayload caps how BIG one frame may be;
// nothing capped how MANY. Legitimate play peaks around 40/s (drive ticks every
// 45ms plus aim relay every 55ms), so 60/s sustained with a 120 burst leaves
// real headroom for a laggy client whose messages arrive bunched, while still
// stopping a flood dead. Breaching it closes the socket — the client's existing
// reconnect path handles that cleanly.
//
// This stays HERE, not in the engine: it is a property of an untrusted network
// peer, and an offline match has no peer to distrust.
const MSG_RATE = Number(process.env.MSG_RATE) || 60;      // sustained messages/second
const MSG_BURST = Number(process.env.MSG_BURST) || 120;   // bucket capacity

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.tokens = MSG_BURST;
  ws.lastRefill = Date.now();

  ws.on('message', (raw) => {
    // Refill before spending, so an idle socket recovers its burst allowance.
    const now = Date.now();
    ws.tokens = Math.min(MSG_BURST, ws.tokens + ((now - ws.lastRefill) / 1000) * MSG_RATE);
    ws.lastRefill = now;
    if (ws.tokens < 1) { try { ws.close(4029, 'rate limit'); } catch {} return; }
    ws.tokens -= 1;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    handleClientMessage(ws, msg);
  });

  ws.on('close', () => handleClose(ws));
  ws.on('error', () => {});
});

// Drop dead sockets so abandoned rooms get cleaned up.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Cannons & Canyons running at http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
// Render restarts this process on every deploy and whenever a free instance
// spins back up. Previously the process was simply killed: every player in
// every live match was dropped with no explanation, mid-animation, and their
// resume token then failed against a room that no longer existed.
//
// This does NOT save matches — all room state is in memory, and surviving a
// restart needs the persistence layer that ADR-005 is still deciding (see
// ISSUE-003/005). What it does is make the loss HONEST and fast: everyone is
// told before the lights go out, sockets close with the standard 1012
// "service restart" code, and the process exits promptly instead of being
// SIGKILLed part-way through a write.
let shuttingDown = false;
function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${reason} — notifying ${wss.clients.size} socket(s), ${rooms.size} room(s) in memory`);
  for (const client of wss.clients) {
    try { send(client, { type: 'serverRestart' }); } catch {}
  }
  clearInterval(heartbeat);
  try { wss.close(); } catch {}          // stop accepting new sockets
  try { server.close(); } catch {}       // stop accepting new HTTP
  // Let the notice flush, then close sockets and go.
  setTimeout(() => {
    for (const client of wss.clients) {
      try { client.close(1012, 'server restarting'); } catch {}
    }
    setTimeout(() => process.exit(code), 150);
  }, 250);
  // Backstop: a shutdown must never hang a deploy. unref'd so it cannot itself
  // hold the process open.
  const hard = setTimeout(() => process.exit(code), 4000);
  if (hard.unref) hard.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A crash used to take the process down silently. Tell the players first, then
// exit non-zero so the host restarts us.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err && err.stack ? err.stack : err);
  reportServerError('uncaughtException', err);   // best-effort: shutdown's 4s backstop may cut it off
  shutdown('uncaughtException', 1);
});
// Do NOT exit on these: a rejected push send or a stray promise must not kill
// live matches. Since 8.52 they also land in error_reports (ISSUE-006).
process.on('unhandledRejection', (err) => {
  console.error('[warn] unhandledRejection:', err && err.stack ? err.stack : err);
  reportServerError('unhandledRejection', err);
});
