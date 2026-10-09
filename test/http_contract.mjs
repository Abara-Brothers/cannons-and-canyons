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
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { qrMatrix, qrSvg } from '../server/qr.js';
import { squadPage, squadPathCode, APP_STORE_URL } from '../server/squad-page.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, sleep(ms).then(() => { throw new Error('timeout: ' + label); })]);

// NOTHING THIS FILE STARTS OUTLIVES IT, AND IT CANNOT HANG. This suite is
// plain top-level awaits: anything that threw between a spawn and its kill
// left that server.js running, and a response that never came waited out
// undici's 300 s default, so a pre-push run could stall for minutes. So:
//   * every server it spawns is registered, and killed on ANY exit — a
//     throw, a failed check, the watchdog, or a signal (SIGKILL: it also
//     ends one a hang left SIGSTOPped);
//   * every fetch carries a 10 s deadline (the module-scope `fetch` below
//     shadows the global one for this file);
//   * the whole run has a budget; overrun, it fails loudly and exits.
const children = [];
const spawnServer = (...a) => { const c = spawn(...a); children.push(c); return c; };
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch {} } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
const WATCHDOG_MS = 60000;
setTimeout(() => {
  console.log(`FAIL  timeout — the suite overran its ${WATCHDOG_MS / 1000} s budget`);
  process.exit(1);
}, WATCHDOG_MS).unref();
const FETCH_MS = 10000;
const globalFetch = globalThis.fetch;
const fetch = (url, opts = {}) => globalFetch(url, { signal: AbortSignal.timeout(FETCH_MS), ...opts });

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
    const srv = spawnServer('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
// (i) the OAuth return path is a redirect to the root, never the raw shell.
// redirect:'manual' so the 302 itself is observed; the fragment a browser would
// carry over cannot be sent to a server, which is exactly why Location must be
// fragment-less (RFC 7231 §7.1.2: the request's fragment is inherited).
const cbRaw = async (p) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, location: res.headers.get('location'), cache: res.headers.get('cache-control') || '', body, hsts: res.headers.get('strict-transport-security') || '' };
};
const cb = await cbRaw('/auth/callback');
const cbSlash = await cbRaw('/auth/callback/');
const cbErr = await cbRaw('/auth/callback?error=access_denied&error_description=probe');
const cbFollowed = await get('/auth/callback');          // default follow: lands on the game
const cbSibling = await get('/auth/callbackx');          // not the route: ordinary deep link

// ---- (j) /history is GONE, and gone means "not a route" ---------------------
// The Bay panel it fed was removed on 2026-09-30 when the Squad box took that
// slot, and match_results has no other client path: the table is service-key
// only, RLS on with no policies. A deleted route does NOT 404 here — /history
// carries no file extension, so it lands on the same SPA deep-link fallback as
// /some-deep-link above and answers 200 text/html. Asserting a 404 would fail
// for a reason that has nothing to do with the route, and asserting 200 alone
// would pass while the route was alive underneath. So this asserts the two
// things only a live route can produce, both of which it DID produce before it
// was removed: a 204 preflight carrying Access-Control-Allow-Methods, and a 401
// for a call with no Authorization header. Put the route back and both go red.
const histOpts = await fetch(`http://127.0.0.1:${port}/history`, { method: 'OPTIONS' })
  .then(async (r) => { await r.arrayBuffer(); return { status: r.status, acam: r.headers.get('access-control-allow-methods') }; });
const histGet = await get('/history');

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
let concurrentSpent = -1;
let csp2 = '';
let mockOrigin = '';
{
  const port2 = await freePort();
  // A SLOW mock upstream, not an unreachable one. The race being tested lives in
  // the gap between checking the budget and spending it, which is only open while
  // `sbUserFromToken` is awaited — point SUPABASE_URL at 127.0.0.1:1 and the
  // connection is refused almost instantly, the window never opens, and this check
  // PASSES against the very bug it exists to catch. That false pass was observed:
  // the broken ordering was restored and the assertion still went green.
  const mockPort = await freePort();
  const mock = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"msg":"no"}'); }, 80);
  });
  await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));
  const env2 = {
    ...process.env, PORT: String(port2),
    SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_PUBLISHABLE_KEY: 'fake', SUPABASE_SECRET_KEY: 'fake',
  };
  const srv2 = spawnServer('node', ['server.js'], { env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${port2}/health`); break; } catch {}
      await sleep(150);
    }
    // CONCURRENT junk must not drive the counter negative. The check and the spend
    // were once separated by the await on sbUserFromToken, so N concurrent junk
    // tokens all passed the check and all decremented after it: measured at 40
    // concurrent, every one got a 401 and every one relayed to GoTrue, against a
    // budget of 10 — and real deletions were denied for far longer than the refill
    // implies. Sequential requests CANNOT catch this; it needs true concurrency.
    const burst = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      fetch(`http://127.0.0.1:${port2}/account/delete`, {
        method: 'POST', headers: { Authorization: 'Bearer junk-' + i },
      }).then(async (r) => { await r.arrayBuffer(); return r.status; })));
    // Count what was SPENT, not what returned 401. Counting a specific status
    // meant any other status scored zero — and zero passes the <= 10 test, so
    // restoring the race AND changing the rejection status to 403 left this
    // assertion green with the bug live. Anything that is not a 429 consumed a
    // token, whatever status it ended with.
    concurrentSpent = burst.filter((s) => s !== 429).length;

    // Well past the bucket size of 10.
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`http://127.0.0.1:${port2}/account/delete`, { method: 'POST' });
      await r.arrayBuffer();
      delAllStatuses.push(r.status);
    }
    const r2 = await fetch(`http://127.0.0.1:${port2}/`);
    await r2.arrayBuffer();
    csp2 = r2.headers.get('content-security-policy') || '';
    mockOrigin = `http://127.0.0.1:${mockPort}`;
  } finally { srv2.kill(); mock.close(); }
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

// ---- (h) Universal Links / App Links association files ----------------------
// The whole security argument for the domain-bound OAuth return rests on these
// two files being served CORRECTLY, and every way of getting them wrong is
// silent: Apple ignores a wrong Content-Type without a diagnostic, and Android
// verification failure just means links open in Chrome. Nothing surfaces.
const aasaPath = '/.well-known/apple-app-site-association';
const alinkPath = '/.well-known/assetlinks.json';

// Unconfigured server: absence, not a placeholder. Apple's CDN caches what it
// fetches, so a file naming the wrong team would outlive the fix.
const aasaUnset = await fetch(`http://127.0.0.1:${port}${aasaPath}`).then(async (r) => { await r.arrayBuffer(); return r.status; });
const alinkUnset = await fetch(`http://127.0.0.1:${port}${alinkPath}`).then(async (r) => { await r.arrayBuffer(); return r.status; });

let aasaType = '', aasa = null, alinks = null, deleteStillWeb = 0;
{
  const port3 = await freePort();
  const srv3 = spawnServer('node', ['server.js'], {
    env: { ...process.env, PORT: String(port3),
           APPLE_TEAM_ID: 'ABCDE12345',
           ANDROID_CERT_SHA256: 'AA:BB:CC:DD, EE:FF:00:11' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`http://127.0.0.1:${port3}/health`); break; } catch {}
      await sleep(150);
    }
    const r = await fetch(`http://127.0.0.1:${port3}${aasaPath}`);
    aasaType = r.headers.get('content-type') || '';
    aasa = await r.json();
    alinks = await fetch(`http://127.0.0.1:${port3}${alinkPath}`).then((x) => x.json());
    // The page Play's policy requires to work for someone who UNINSTALLED the
    // app must still be an ordinary web page.
    deleteStillWeb = await fetch(`http://127.0.0.1:${port3}/delete-account.html`)
      .then(async (x) => { await x.arrayBuffer(); return x.status; });
  } finally { srv3.kill(); }
}

const details = (aasa && aasa.applinks && aasa.applinks.details) || [];
const comps = details.flatMap((d) => d.components || []);
// A component claiming the whole domain is the failure that breaks the two
// pages both stores require to open in a browser.
const claimsEverything = comps.some((c) => ['/', '*', '/*'].includes(c['/']));
const target = (alinks && alinks[0] && alinks[0].target) || {};

// ---- (k) THE SQUAD LINK'S PAGE (owner, 2026-10-10) ---------------------------
// A squad's Share hands out https://tanks.abarabrothers.com/squad/CODE. Where
// the app is installed iOS opens it there (the AASA's /squad/* above); a
// browser gets THIS: a download page, never the game. "It must not link to the
// website if they dont have the app, it should prompt the user to download
// the app", and on a computer, the same page with a QR code to scan. Before
// this route, /squad/CODE had no file extension, so the SPA fallback answered
// it with the GAME (the (c) deep-link rule), which is exactly what the owner
// ruled out.
const SQ_LINK = 'https://tanks.abarabrothers.com/squad/QK7T';
const sqGet = async (p) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: r.status, type: r.headers.get('content-type') || '', robots: r.headers.get('x-robots-tag') || '',
    cache: r.headers.get('cache-control') || '', hsts: r.headers.get('strict-transport-security') || '',
    nosniff: r.headers.get('x-content-type-options') || '', referrer: r.headers.get('referrer-policy') || '',
    csp: r.headers.get('content-security-policy') || '', body: await r.text() };
};
const sqPage = await sqGet('/squad/QK7T');
const sqLower = await sqGet('/squad/qk7t');
// Every way a path under /squad can fail to name a code: none, the wrong
// length, a letter or digit the alphabet leaves out (I, O, 0, 1), a space,
// a trailing slash, anything after the code. Each is a plain 404, never html.
const SQ_BAD = ['/squad', '/squad/', '/squad/QK7', '/squad/QK7TT', '/squad/QK7I', '/squad/QK7O', '/squad/QK70',
  '/squad/QK71', '/squad/QK%20T', '/squad/QK7T/', '/squad/QK7T/x', '/squad/QK7T.html'];
const sqBad = [];
for (const p of SQ_BAD) { const r = await sqGet(p); sqBad.push([p, r.status, r.type]); }
const sqBody = sqPage.body;
const sqQr = (sqBody.match(/<div class="qr">(<svg[\s\S]*?<\/svg>)/) || [])[1] || '';
const sqHrefs = [...sqBody.matchAll(/\b(?:href|src|action)="([^"]*)"/g)].map((m) => m[1]);
// THE QR, PINNED. This matrix is server/qr.js's encoding of the link above,
// and Apple's reader (CoreImage CIDetector, macOS, 2026-10-09) decoded it back
// to exactly that link, as it decoded versions 1 to 10 and all eight masks from
// the same encoder. A change to the encoder that changes the picture fails here.
const QR_GOLDEN = [
  '#######..####...#..##.#######',
  '#.....#....#..###...#.#.....#',
  '#.###.#.###.#..#..###.#.###.#',
  '#.###.#.#..###.#.#.#..#.###.#',
  '#.###.#.#..#.#..#####.#.###.#',
  '#.....#.#...#####.#...#.....#',
  '#######.#.#.#.#.#.#.#.#######',
  '........#..#..###.##.........',
  '#.#####...#.#.####..#.#####..',
  '..#.##..##....#.#.###.###...#',
  '...#.##...###..##....#.#.....',
  '.#.#....###...##...#..#..#.#.',
  '#.#####.##..#.####...#...##..',
  '.###.#..#..#.#..#..######...#',
  '#...#######.##.####.#.#..##..',
  '.##..#.#.#.#..#...#..###...#.',
  '#.##..##..####.###.......##..',
  '#.#.#...##.#..#.#..######.#.#',
  '#.#######...#######..#.##.#..',
  '#.##.#.#..###.#.#..#....#..#.',
  '#.#.#.#.#.##..#..##.#####.###',
  '........##.##.#..####...#####',
  '#######...##..####.##.#.###..',
  '#.....#.#.##...##.###...#..##',
  '#.###.#.#.##.....#..#####.###',
  '#.###.#.#.#.....#.##.....####',
  '#.###.#.#..##.#####..#######.',
  '#.....#..#.#..#.#...##..##.#.',
  '#######.######...#.#.######..',
];
const qm = qrMatrix(SQ_LINK);
// AND EVERY PATH THROUGH THE ENCODER the link above does not take: a 42-byte
// link fills version 3 exactly (no pad bytes) and scores only one mask. So the
// pictures of that link under each mask, and of texts that use the pad bytes,
// two and four blocks, the version bits and the 16-bit count, are pinned by
// the sha256 of their rows; CoreImage decoded each one when it was pinned.
const QR_PINS = [
  [SQ_LINK, 0, 3, '655d9fda436af118e4b986895e7d15fa031e4edeff617aae2f4c9d6aeb7e374b'],
  [SQ_LINK, 1, 3, 'cebfddd1705267bff8efba4ab3104880acbc7f9c41d17149d12b285881239c1a'],
  [SQ_LINK, 2, 3, '456f194db0ec66ab9feeaf0db01f4f76735633eb369f2e7f343b17289b024448'],
  [SQ_LINK, 3, 3, '1fc23610fa5c6f95fbb6ba2240dda487575d4633bafcfc9a8056715f11435243'],
  [SQ_LINK, 4, 3, 'df9b712ee8a2075b84775c8131a3ed7ed10b50c7a56f82c829da794210d5a8e3'],
  [SQ_LINK, 5, 3, 'aa375de699201d2200064791c2dece462c38bbf4dcde9604f653c8e9a6573e1f'],
  [SQ_LINK, 6, 3, '8ece16fb7bee06a89cc64939d45928bfff047028e1bbd0068a39f80a9623a5b4'],
  [SQ_LINK, 7, 3, '26d2a622c2af45496e84354cd5262c0458058c055ce1d8d692c7b7e9609e521e'],
  ['A', undefined, 1, 'c8529cd82afac26fa7f7b81f17fa4de152e3f53e14293727dece53aef0cfc86f'],
  ['y'.repeat(60), undefined, 4, '6b3dbc8f33b1ea074e8a909ced1b796a8f4a422201e89e7ca053eead08098641'],
  ['v'.repeat(110), undefined, 7, 'f15f16e406bef1ae6e5c597dc6ee0c1af65199e649020205b80064418d998853'],
  ['t'.repeat(213), undefined, 10, '0cfb07d0ea416105bd4d8b27506103b10f07884f68cbed408d1fd8f06d4fdbcd'],
];
const qrPinWrong = QR_PINS.filter(([t, k, v, sha]) => {
  const m = qrMatrix(t, k);
  const rows = m.modules.map((r) => r.map((d) => (d ? '#' : '.')).join('')).join('\n');
  return m.version !== v || crypto.createHash('sha256').update(rows).digest('hex') !== sha;
}).map(([t, k]) => `${t.slice(0, 12)}${t.length > 12 ? '...' : ''} mask ${k}`);
let qrTooLong = false;
try { qrMatrix('t'.repeat(214)); } catch (e) { qrTooLong = e instanceof RangeError; }
const qrRows = qm.modules.map((r) => r.map((d) => (d ? '#' : '.')).join(''));
// The SVG draws exactly that matrix: every run of its one path, offset by the
// four-module quiet zone, is a run of dark modules, and every dark module is
// in exactly one run.
const svgCells = (() => {
  const svg = qrSvg(SQ_LINK), cells = new Map();
  const d = (svg.match(/<path fill="#000" d="([^"]*)"/) || [])[1] || '';
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    const [x, y, w, back] = m.slice(1).map(Number);
    if (w !== back) return null;
    for (let k = 0; k < w; k++) { const key = `${x - 4 + k},${y - 4}`; cells.set(key, (cells.get(key) || 0) + 1); }
  }
  return { cells, view: (svg.match(/viewBox="0 0 (\d+) (\d+)"/) || []).slice(1).map(Number) };
})();
let darkCount = 0;
qm.modules.forEach((r) => r.forEach((dk) => { if (dk) darkCount++; }));
const svgExact = !!svgCells && svgCells.cells.size === darkCount
  && [...svgCells.cells].every(([k, n]) => { const [x, y] = k.split(',').map(Number); return n === 1 && qm.modules[y] && qm.modules[y][x] === true; })
  && svgCells.view[0] === qm.size + 8 && svgCells.view[1] === qm.size + 8;
// THE ALPHABET IS THE ENGINE'S: every character of room-engine's CODE_CHARS
// names a code, and no other letter or digit does.
const engineChars = (fs.readFileSync(new URL('../public/room-engine.js', import.meta.url), 'utf8').match(/const CODE_CHARS = '([A-Z0-9]+)';/) || [])[1] || '';
const alphaWrong = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].filter((ch) => (squadPathCode('/squad/' + ch.repeat(4)) === ch.repeat(4)) !== engineChars.includes(ch));
// THE APP STORE LINE IS ONE CONSTANT: empty today (coming soon); a listing
// turns the line into a Download button and the coming-soon line goes.
const STORE = 'https://apps.apple.com/app/id1234567890';
const sqStore = squadPage({ code: 'QK7T', origin: 'https://tanks.abarabrothers.com', appStoreUrl: STORE });
// THE SERVICE WORKER LEAVES /squad/ TO THE NETWORK. Its navigation handler
// falls back to the cached GAME offline, so it must not take a squad page at
// all. Driven through sw.js's own fetch listener: respondWith is the whole
// difference between handling a request and leaving it to the browser.
const swTook = (() => {
  const handlers = {};
  const self = { location: { origin: 'https://tanks.abarabrothers.com' }, addEventListener: (t, f) => { handlers[t] = f; },
    skipWaiting() {}, clients: { claim: async () => {} }, registration: {} };
  vm.runInContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), vm.createContext({
    self, URL, console, clients: {}, Response: { error: () => null },
    caches: { open: async () => ({ put() {}, match: async () => null }), match: async () => null, keys: async () => [] },
    fetch: () => new Promise(() => {}),
  }), { filename: 'sw.js' });
  const took = (p, mode) => {
    let n = 0;
    handlers.fetch({ request: { method: 'GET', url: 'https://tanks.abarabrothers.com' + p, mode }, respondWith: () => { n++; } });
    return n;
  };
  return { squad: took('/squad/QK7T', 'navigate'), bare: took('/squad', 'navigate'), sub: took('/squad/QK7T/x.png', 'no-cors'),
    game: took('/', 'navigate'), privacy: took('/privacy.html', 'navigate'), asset: took('/app.js?v=14', 'no-cors') };
})();

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
  ['(j) /history answers no CORS preflight — it is not a route any more',
    histOpts.status === 200 && histOpts.acam === null],
  ['(j) an unauthenticated GET /history is an ordinary deep link, not a 401 from a live route',
    histGet.status === 200 && histGet.type.includes('html')],
  ['(i) /auth/callback -> 302', cb.status === 302],
  ['(i) Location is exactly "/" (no fragment, so the browser inherits the request\'s)', cb.location === '/'],
  ['(i) redirect body is empty', cb.body === ''],
  ['(i) redirect is never cached', /no-store/.test(cb.cache)],
  ['(i) redirect still carries the security headers', /max-age=31536000/.test(cb.hsts)],
  ['(i) trailing slash form redirects too', cbSlash.status === 302 && cbSlash.location === '/'],
  ['(i) a provider-error return (query) redirects too, query dropped', cbErr.status === 302 && cbErr.location === '/'],
  ['(i) followed, it lands on the game page', cbFollowed.status === 200 && cbFollowed.type.includes('html')],
  ['(i) only the exact path: /auth/callbackx is still an ordinary deep link', cbSibling.status === 200],
  ['(d) 15 header-less deletes all 401', delAllStatuses.length === 15 && delAllStatuses.every((s) => s === 401)],
  ['(d) none of them hit the 429 budget', !delAllStatuses.includes(429)],
  ['(e) HSTS present with a year max-age', /max-age=31536000/.test(sec.hsts)],
  ['(e) nosniff present', sec.nosniff === 'nosniff'],
  ['(e) Referrer-Policy present', sec.referrer === 'no-referrer'],
  ['(e) CSP blocks framing', /frame-ancestors 'none'/.test(sec.csp)],
  // Anchored, not a substring. `/script-src 'self'/` matches a PREFIX, so
  // `script-src 'self' https://cdn.example.com 'unsafe-eval' data: blob:` passed
  // both of these — arbitrary remote script and eval() on the origin whose
  // localStorage holds the Supabase refresh token. The sibling negation is also
  // vacuously true when the header is missing entirely; anchoring fixes both.
  ['(e) CSP restricts scripts to EXACTLY self',
    /(?:^|;)\s*script-src 'self'\s*(?:;|$)/.test(sec.csp)],
  ['(e) CSP has no unsafe-inline for SCRIPT',
    /script-src/.test(sec.csp) && !/script-src[^;]*unsafe-inline/.test(sec.csp)],
  ['(f) 40 CONCURRENT junk deletes cannot exceed the budget of 10',
    concurrentSpent >= 1 && concurrentSpent <= 10],
  // The (e) block asserted five directives and never the one that decides whether
  // the game can talk to anything. A scratch build set to `connect-src 'none'`
  // passed every (e) assertion and printed "all checks passed" while real Chrome
  // refused the game's own WebSocket — multiplayer dead, gate green.
  ['(g) CSP allows same-origin connect (the game WebSocket)', /connect-src[^;]*'self'/.test(sec.csp)],
  // This server has SUPABASE_URL DELETED, so connect-src can only carry the
  // Supabase origin if the server also reads the client's own public/config.js.
  // Without that, running locally per the README silently kills sign-in, cloud
  // save and account deletion while multiplayer keeps working.
  ['(g) CSP carries the CLIENT config.js Supabase origin even with no env',
    /connect-src[^;]*https:\/\/[a-z0-9]+\.supabase\.co/.test(sec.csp)],
  ['(g) CSP carries the SERVER env origin when one is set',
    csp2.includes(mockOrigin)],
  // (h) — see the block above.
  ['(h) unconfigured team id -> AASA 404, never a placeholder', aasaUnset === 404],
  ['(h) unconfigured fingerprint -> assetlinks 404', alinkUnset === 404],
  // THE one that the static handler would have failed. `apple-app-site-association`
  // has no file extension, so served from public/ it went out as
  // application/octet-stream and Apple would have ignored it in silence.
  ['(h) AASA served as application/json', aasaType.includes('application/json')],
  ['(h) AASA appID is TEAMID.bundleid',
    details.some((d) => (d.appIDs || []).includes('ABCDE12345.com.abarabrothers.cannonsandcanyons'))],
  ['(h) AASA scoped to the OAuth callback', comps.some((c) => c['/'] === '/auth/callback')],
  // (owner, 2026-10-10) and to the squad link, so iOS opens the app for one.
  ['(h) AASA keeps the OAuth callback exactly and adds the squad link: two components, nothing else',
    JSON.stringify(comps.map((c) => c['/'])) === JSON.stringify(['/auth/callback', '/squad/*'])],
  ['(h) AASA does NOT claim the whole domain', claimsEverything === false],
  ['(h) delete-account.html is still an ordinary web page', deleteStillWeb === 200],
  ['(h) assetlinks names the package', target.package_name === 'com.abarabrothers.cannonsandcanyons'],
  ['(h) assetlinks carries every fingerprint, trimmed',
    JSON.stringify(target.sha256_cert_fingerprints) === JSON.stringify(['AA:BB:CC:DD', 'EE:FF:00:11'])],
  ['(k) /squad/CODE -> 200 html', sqPage.status === 200 && sqPage.type.includes('text/html')],
  ['(k) it is the download page, never the game: no script, none of the game\'s files, the invite heading',
    !/<script/i.test(sqBody) && !/app\.js|bay\.js|intro\.js|id="bay"|manifest/.test(sqBody) && sqBody.includes('<h1>You&#39;ve been invited to a squad</h1>')],
  ['(k) the game is named and shown: its name, its icon and a still from the game',
    sqBody.includes('<span>Cannons &amp; Canyons</span>') && sqHrefs.includes('/icons/icon-180.png') && sqHrefs.includes('/bay/card-duel-wide.webp')],
  ['(k) the code is shown large', sqBody.includes('<p class="code">QK7T</p>')],
  ['(k) coming soon to the App Store, from the one constant', APP_STORE_URL === '' && sqBody.includes('<p class="soon">Cannons &amp; Canyons is coming soon to the App Store.</p>') && !/<a\b/i.test(sqBody)],
  ['(k) it links to nothing: no anchor, no form, and the only href is its favicon',
    !/<a\b|<form\b/i.test(sqBody) && JSON.stringify(sqHrefs.filter((h) => !/^\/(icons|bay)\//.test(h))) === '[]' && JSON.stringify([...sqBody.matchAll(/href="([^"]*)"/g)].map((m) => m[1])) === '["/icons/icon-32.png"]'],
  ['(k) noindex, in the header and the page', /noindex/.test(sqPage.robots) && sqBody.includes('<meta name="robots" content="noindex, nofollow">')],
  ['(k) never cached', /no-store/.test(sqPage.cache)],
  ['(k) the same security headers as every page (HSTS, nosniff, Referrer-Policy, the one CSP)',
    /max-age=31536000/.test(sqPage.hsts) && sqPage.nosniff === 'nosniff' && sqPage.referrer === 'no-referrer' && sqPage.csp === sec.csp && sec.csp !== ''],
  ['(k) the QR is the shared public link, not this server\'s own host', sqQr !== '' && sqQr === qrSvg(SQ_LINK)],
  // Hidden by default, shown inside the large-screen query (deeplink.mjs A2
  // measures it in a real browser at a computer's size and a phone's).
  ['(k) the QR is for a large screen only', (() => {
    const off = sqBody.indexOf('.qr{display:none}'), q = sqBody.indexOf('@media (min-width:700px) and (min-height:500px){');
    const on = sqBody.indexOf('.qr{display:block'), close = sqBody.indexOf('\n}\n', q);
    return off !== -1 && q > off && on > q && close > on;
  })()],
  ['(k) a lower-case link is the same squad', sqLower.status === 200 && sqLower.body === sqBody],
  ['(k) every path under /squad that names no code is a plain 404, never the game',
    sqBad.every(([, st, ty]) => st === 404 && !ty.includes('html'))],
  ['(k) the codes it answers are exactly the engine\'s alphabet', engineChars.length === 31 && alphaWrong.length === 0],
  ['(k) the QR matrix is the decoded, pinned one (version 3, level M)', qm.version === 3 && JSON.stringify(qrRows) === JSON.stringify(QR_GOLDEN)],
  ['(k) the SVG draws exactly that matrix, in a four-module quiet zone', svgExact],
  ['(k) every mask, the pad bytes, several blocks, the version bits and the 16-bit count draw their pinned, decoded pictures',
    qrPinWrong.length === 0],
  ['(k) text longer than version 10 holds is refused, never drawn wrong', qrTooLong],
  ['(k) an App Store link turns the line into a Download button, and the coming-soon line goes',
    sqStore.includes(`<a class="store" href="${STORE}">Download on the App Store</a>`) && !sqStore.includes('coming soon')],
  ['(k) the service worker leaves /squad/ to the network, and still serves the game, its pages and its assets',
    swTook.squad === 0 && swTook.bare === 0 && swTook.sub === 0 && swTook.game === 1 && swTook.privacy === 1 && swTook.asset === 1],
  ['(h) assetlinks uses the handle_all_urls relation',
    !!(alinks && alinks[0] && (alinks[0].relation || []).includes('delegate_permission/common.handle_all_urls'))],
];

let bad = 0;
for (const [name, ok] of results) { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); }
if (bad) {
  console.log('(k) /squad paths:', JSON.stringify(sqBad), 'alphabet wrong:', JSON.stringify(alphaWrong), 'sw:', JSON.stringify(swTook), 'qr pins wrong:', JSON.stringify(qrPinWrong));
  console.log('\n--- server output ---\n' + state.log.slice(-1200));
  console.log(`\n${bad} FAILED`);
  process.exit(1);
}
console.log('logged:', (state.log.match(/\[client-error\].*/) || ['(none)'])[0]);
console.log('all checks passed');
process.exit(0);
