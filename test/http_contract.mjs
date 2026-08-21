// HTTP-layer contract tests (ISSUE-036 b + c). Self-hosted: spawns and kills
// its own server, so it must run with no shared server up.
//
// Two regressions, both of which reported success while being wrong — which is
// why they survived until an audit found them rather than a test:
//
//   (b) /errors decoded each TCP chunk on its own (`body += chunk`), so a
//       multi-byte UTF-8 character split across a chunk boundary tore into
//       replacement characters. Crash text is where non-ASCII actually shows
//       up, and a mangled report still looked like a delivered one.
//
//   (c) the SPA fallback answered 200 + text/html for ANY missing path, so a
//       typo'd <script src> handed HTML to a JS parser, read as 200 in the
//       network tab, and let the service worker cache the page under the
//       asset's URL.
//
// KNOWN LIMITATION, do not trust this blindly: check (b) needs the server to
// receive the body in at least two chunks, which is forced here with a delay
// between writes. If a future runtime coalesces them anyway the assertion still
// PASSES — it just stops exercising the split. That is a false pass, not a
// flake. Proving it properly would need the server to report how many 'data'
// events it saw. Until then, the negative test is the real evidence: revert
// ingestError() to `body += c` and this file must fail.
import { spawn } from 'node:child_process';
import net from 'node:net';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, sleep(ms).then(() => { throw new Error('timeout: ' + label); })]);

// Ask the OS for a free port rather than hardcoding one. run-all.sh's
// kill_server() only clears $PORT, so a hardcoded port left busy by a crashed
// run would fail here as "server never came up" — the exact misleading failure
// that script's header exists to prevent.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  // Retry: between freePort() closing and the server binding, something else
  // could take it. Rare, cheap to absorb.
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const env = { ...process.env, PORT: String(port) };
    delete env.SUPABASE_SECRET_KEY;          // force the console.error branch in ingestError
    delete env.SUPABASE_URL;
    const srv = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { log: '' };
    srv.stdout.on('data', (d) => { state.log += d; });
    srv.stderr.on('data', (d) => { state.log += d; });
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${port}/health`); return { srv, port, state }; } catch {}
      if (srv.exitCode !== null) break;      // died on bind — try another port
      await sleep(150);
    }
    srv.kill();
  }
  throw new Error('server never came up');
}

const { srv, port, state } = await startServer();

// ---- (b) split a multi-byte character across two writes ---------------------
const message = 'café — naïve ☠ 日本語';
const payload = Buffer.from(JSON.stringify({ message, source: 'http_contract' }), 'utf8');
const cut = payload.indexOf(Buffer.from('é', 'utf8')) + 1;   // land INSIDE the é

try {
  const sock = net.connect(port, '127.0.0.1');
  await withTimeout(new Promise((r) => sock.once('connect', r)), 5000, 'connect');
  sock.write(
    'POST /errors HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n'
    + `Content-Length: ${payload.length}\r\n\r\n`,
  );
  sock.write(payload.subarray(0, cut));      // first half ends mid-character
  await sleep(150);                          // force a separate 'data' event
  sock.write(payload.subarray(cut));
  await withTimeout(new Promise((r) => sock.once('data', r)), 5000, 'response');
  sock.destroy();
} catch (e) {
  console.log('split-write leg failed:', e.message);
}
await sleep(500);                            // let the child's stderr flush

const sawIntact = state.log.includes(message);
const sawMangled = /�/.test(state.log);

// ---- (c) missing asset vs extension-less deep link -------------------------
const get = async (p) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  await res.arrayBuffer();
  return { status: res.status, type: res.headers.get('content-type') || '' };
};
const missingAsset = await get('/definitely-not-here.js');
const missingImage = await get('/nope.png');
const deepLink = await get('/some-deep-link');
const realAsset = await get('/app.js');
const root = await get('/');

// ---- (d) an unauthenticated /account/delete must not spend the budget -------
// Until 2026-08-18 `delTokens -= 1` ran BEFORE the Authorization header was even
// read, so ten header-less requests emptied the bucket and one every six seconds
// held it at zero — denying real players a deletion that delete-account.html
// promises is "immediate and permanent" and that both stores require in-app.
//
// Needs Supabase env, which the server above deliberately lacks (it would 503),
// so this runs its own. The values are fake on purpose: a request with no Bearer
// token is refused before any network call, so nothing is ever contacted.
let delAllStatuses = [];
{
  const port2 = await freePort();
  const env2 = {
    ...process.env, PORT: String(port2),
    SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_PUBLISHABLE_KEY: 'fake', SUPABASE_SECRET_KEY: 'fake',
  };
  const srv2 = spawn('node', ['server.js'], { env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${port2}/health`); break; } catch {}
      await sleep(150);
    }
    // Well past the bucket size of 10.
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`http://127.0.0.1:${port2}/account/delete`, { method: 'POST' });
      await r.arrayBuffer();
      delAllStatuses.push(r.status);
    }
  } finally { srv2.kill(); }
}

// ---- (e) security response headers -----------------------------------------
// None of these were served before 2026-08-18. The Supabase session — refresh
// token included — sits in localStorage on this origin, and the game is played
// on public Wi-Fi, so a missing HSTS leaves one plaintext hop in which a hostile
// network serves script on the real origin and keeps the account.
const sec = await fetch(`http://127.0.0.1:${port}/`).then(async (r) => {
  await r.arrayBuffer();
  return {
    hsts: r.headers.get('strict-transport-security') || '',
    nosniff: r.headers.get('x-content-type-options') || '',
    referrer: r.headers.get('referrer-policy') || '',
    csp: r.headers.get('content-security-policy') || '',
  };
});

srv.kill();

const results = [
  ['(b) split multi-byte survives intact', sawIntact === true],
  ['(b) no replacement characters logged', sawMangled === false],
  ['(c) missing .js -> 404', missingAsset.status === 404],
  ['(c) missing .png -> 404', missingImage.status === 404],
  ['(c) missing .js NOT served as html', !missingAsset.type.includes('html')],
  ['(c) extension-less deep link still 200 html', deepLink.status === 200 && deepLink.type.includes('html')],
  ['(c) real asset still 200 js', realAsset.status === 200 && realAsset.type.includes('javascript')],
  ['(c) root still 200 html', root.status === 200 && root.type.includes('html')],
  ['(d) 15 header-less deletes all 401', delAllStatuses.length === 15 && delAllStatuses.every((s) => s === 401)],
  ['(d) none of them hit the 429 budget', !delAllStatuses.includes(429)],
  ['(e) HSTS present with a year max-age', /max-age=31536000/.test(sec.hsts)],
  ['(e) nosniff present', sec.nosniff === 'nosniff'],
  ['(e) Referrer-Policy present', sec.referrer === 'no-referrer'],
  ['(e) CSP blocks framing', /frame-ancestors 'none'/.test(sec.csp)],
  ['(e) CSP restricts scripts to self', /script-src 'self'/.test(sec.csp)],
  ['(e) CSP has no unsafe-inline for SCRIPT', !/script-src[^;]*unsafe-inline/.test(sec.csp)],
];

let bad = 0;
for (const [name, ok] of results) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); }
if (bad) {
  console.log('\n--- server output ---\n' + state.log.slice(-1200));
  console.log(`\n${bad} FAILED`);
  process.exit(1);
}
console.log('logged:', (state.log.match(/\[client-error\].*/) || ['(none)'])[0]);
console.log('all checks passed');
process.exit(0);
