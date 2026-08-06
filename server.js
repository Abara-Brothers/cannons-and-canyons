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
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import {
  rooms, send, handleClientMessage, handleClose, setPushNudge,
} from './public/room-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

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

function pushNudge(room, seat) {
  const pl = room.players[seat];
  if (!webpush || !pl || pl.bot || pl.connected || !pl.pushSub) return;
  const opp = room.players.find((p, i) => p && i !== seat && !p.bot);
  const payload = JSON.stringify({
    title: 'Cannons & Canyons — your move',
    body: opp ? `${opp.name} has taken their shot. Your turn.` : 'Your turn is up.',
    url: `/?room=${room.code}`,
  });
  webpush.sendNotification(pl.pushSub, payload).catch((err) => {
    if (err && (err.statusCode === 404 || err.statusCode === 410)) pl.pushSub = null;   // subscription expired
  });
}

// The one capability the engine cannot have: sending a push needs the VAPID keys
// and the Node library above. Injected rather than imported so the browser copy
// of the engine simply keeps its no-op default.
setPushNudge(pushNudge);

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
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
  shutdown('uncaughtException', 1);
});
// Do NOT exit on these: a rejected push send or a stray promise must not kill
// live matches. Log loudly so it is visible once telemetry exists (ISSUE-006).
process.on('unhandledRejection', (err) => {
  console.error('[warn] unhandledRejection:', err && err.stack ? err.stack : err);
});
