// Web push is only ever SENT to a real push service (live hotfix, 2026-09-25).
// Headless: server/push-hosts.js is a pure module, no server, no network.
//
// WHY THIS EXISTS: a web push subscription is supplied by the client, and
// web-push POSTs to its endpoint and buffers the WHOLE reply into one string. An
// endpoint a player controls can answer 201 and stream forever: the string
// outgrows V8's limit, the RangeError escapes inside a socket handler, and
// 'uncaughtException' shuts the server down with every live match on it. One
// turn nudge was enough. webPushHostAllowed() is the gate in front of that send.
//
// THE PARSER THAT MATTERS IS NOT OURS. The module reads an endpoint with the
// WHATWG URL parser, but web-push 3.6.7 chooses the host it connects to with the
// LEGACY url.parse(), and the two disagree on hostile input. So section 6 does
// not trust the module's own reading at all: every string it accepts, from the
// cases below and from a fuzz around every legitimate shape, is handed to
// url.parse() exactly as web-push hands it, and the host THAT yields must be a
// push service. Section 7 pins that web-push still parses that way, and that
// server.js still sends web push through it, and only after the gate.
import url from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { webPushHostAllowed } from '../server/push-hosts.js';

// url.parse() is deprecated (DEP0169). This file calls it ON PURPOSE, because
// web-push does, so the one-time warning is noise here and nothing else.
process.noDeprecation = true;

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const show = (s) => (typeof s === 'string' ? JSON.stringify(s.length > 90 ? `${s.slice(0, 60)}...${s.slice(-25)}` : s) : String(s));

// Realistic tokens, invented: the shapes browsers hand out, not anyone's real
// subscription. A push endpoint is a capability URL.
const FCM_TOKEN = 'dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ-hQMRKRrZuJAEcl7B338qju59zJMjw2DELjzEvxwYv7hH5Ynpc1ODQ0aT4U4OFEeco8ohsN5PjL1iC2dNtk2BAokeMCg2ZXKqpc8FXKmhX94kIxQ';
const MOZ_TOKEN = 'gAAAAABmW3Fk2Qn0pPbV1xR8m9sA7kLh2cZ4tYwXeJq5uN3oGiD6fH1bC8vTzS0rMaEyKpWlOdUgIjBnQsRx';
const APPLE_TOKEN = 'QGuQyavXutnMH8kQ0ENWc4y2Zp7N1bTj5xRa3Lq9Fs6DhVw_KmYo4eJiPgUtCzXl';
const WNS_TOKEN = 'BQYAAABwIy0rCzA%2bHpEjL5a3oKmZcQ7Fz%2fYd2RyPbTnV4xUe8sWgLh1kAiOjCt6MqDfNvXlS9Gw%3d';

// ---- 1. every legitimate shape is accepted ----------------------------------
const LEGIT = [
  `https://fcm.googleapis.com/fcm/send/${FCM_TOKEN}`,                  // Chrome, most Chromium browsers
  `https://fcm.googleapis.com/wp/${FCM_TOKEN}`,                        // FCM's web-push path
  `https://android.googleapis.com/gcm/send/${FCM_TOKEN}`,              // FCM's legacy GCM host
  `https://jmt17.google.com/fcm/send/${FCM_TOKEN}`,
  `https://updates.push.services.mozilla.com/wpush/v2/${MOZ_TOKEN}`,   // Firefox
  `https://updates.push.services.mozilla.com/wpush/v1/${MOZ_TOKEN}`,
  `https://web.push.apple.com/${APPLE_TOKEN}`,                         // Safari, iOS home-screen apps
  // Apple tells servers that restrict push endpoints to allow ANY subdomain of
  // push.apple.com, not only today's host (WebKit, "Meet Web Push").
  `https://web2.push.apple.com/${APPLE_TOKEN}`,
  `https://a.b.push.apple.com/${APPLE_TOKEN}`,
  `https://wns2-by3p.notify.windows.com/w/?token=${WNS_TOKEN}`,        // Edge on Windows (WNS)
  `https://wns2-bl2p.notify.windows.com/w/?token=${WNS_TOKEN}`,
  `https://db5.notify.windows.com/w/?token=${WNS_TOKEN}`,
  `https://a.b.notify.windows.com/w/?token=${WNS_TOKEN}`,              // more than one label before the suffix
  // A host is case-insensitive, and the parser lowercases it: still the service.
  `https://FCM.GoogleAPIs.com/fcm/send/${FCM_TOKEN}`,
  `https://Updates.Push.Services.Mozilla.COM/wpush/v2/${MOZ_TOKEN}`,
  `https://Web.Push.Apple.Com/${APPLE_TOKEN}`,
  `https://WNS2-BY3P.Notify.Windows.COM/w/?token=${WNS_TOKEN}`,
  // The label-length boundary: 63 characters is a legal DNS label.
  `https://${'a'.repeat(63)}.notify.windows.com/w/?token=x`,
  // The total-length boundary: exactly 253 characters of hostname.
  `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(42)}.notify.windows.com/w/`,
];
{
  let bad = 0;
  for (const e of LEGIT) if (webPushHostAllowed(e) !== true) { bad++; fail(`(1) a real push endpoint was refused: ${show(e)}`); }
  if (!bad) ok(`(1) all ${LEGIT.length} legitimate endpoint shapes are accepted (FCM, GCM, jmt17, Mozilla, Apple, WNS, mixed case, both length boundaries)`);
  const h253 = new URL(LEGIT[LEGIT.length - 1]).hostname.length;
  if (h253 !== 253) fail(`(1) the 253-character fixture is ${h253} characters — the boundary is not being tested`);
}

// ---- 2. every trick is refused -----------------------------------------------
// Each entry is [why, endpoint]. The comment on each group names the trick.
const LONG_LABEL = `https://${'a'.repeat(64)}.notify.windows.com/w/?token=x`;
const LONG_HOST = `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(43)}.notify.windows.com/w/`;
const HUGE_HOST = `https://${('a'.repeat(63) + '.').repeat(4)}notify.windows.com/w/`;
const TRICKS = [
  // not a URL at all
  ['empty string', ''],
  ['not a URL', 'not a url'],
  ['no scheme', `fcm.googleapis.com/fcm/send/${FCM_TOKEN}`],
  // wrong scheme
  ['http', `http://fcm.googleapis.com/fcm/send/${FCM_TOKEN}`],
  ['wss', 'wss://fcm.googleapis.com/fcm/send/x'],
  ['ftp', 'ftp://fcm.googleapis.com/fcm/send/x'],
  ['javascript:', 'javascript:fetch("https://fcm.googleapis.com/")'],
  // userinfo
  ['userinfo: allowed host as the USERNAME', 'https://fcm.googleapis.com@evil.com/fcm/send/x'],
  ['userinfo: user:pass before an allowed host', 'https://user:pass@fcm.googleapis.com/fcm/send/x'],
  ['userinfo: user before an allowed host', 'https://user@fcm.googleapis.com/fcm/send/x'],
  ['userinfo: password only', 'https://:pass@fcm.googleapis.com/fcm/send/x'],
  ['userinfo: empty, bare @', 'https://@fcm.googleapis.com/fcm/send/x'],
  // subdomain / suffix tricks: exact hosts only, WNS and Apple the two suffixes
  ['subdomain trick: allowed host + attacker domain', 'https://fcm.googleapis.com.evil.com/fcm/send/x'],
  ['subdomain trick: apple', 'https://web.push.apple.com.evil.com/x'],
  ['subdomain trick: WNS suffix + attacker domain', 'https://wns2-by3p.notify.windows.com.evil.com/w/'],
  ['a subdomain of an exact host is not that host', 'https://x.fcm.googleapis.com/fcm/send/x'],
  ['a name that merely ENDS in an exact host', 'https://evil-fcm.googleapis.com/fcm/send/x'],
  ['a name that merely ends in the WNS suffix, no dot', 'https://evilnotify.windows.com/w/'],
  ['the bare WNS domain, no label before it', 'https://notify.windows.com/w/'],
  ['an empty label before the WNS suffix', 'https://.notify.windows.com/w/'],
  ['an empty label inside the WNS prefix', 'https://a..notify.windows.com/w/'],
  ['a name that merely ends in the Apple suffix, no dot', 'https://evilpush.apple.com/x'],
  ['the bare Apple push domain, no label before it', 'https://push.apple.com/x'],
  ['an empty label before the Apple suffix', 'https://.push.apple.com/x'],
  ['an empty label inside the Apple prefix', 'https://web..push.apple.com/x'],
  ['a port on an Apple host', 'https://web.push.apple.com:444/x'],
  ['trailing dot on Apple', 'https://web.push.apple.com./x'],
  ['IDN homograph in the Apple suffix (Cyrillic a)', 'https://web.push.\u0430pple.com/x'],
  ['differential: ; ends the host for url.parse() (Apple)', 'https://evil.com;.push.apple.com/x'],
  ['a parent domain of an exact host', 'https://googleapis.com/fcm/send/x'],
  // the allowed host only in the path, query or fragment
  ['fragment trick', 'https://evil.com/#fcm.googleapis.com'],
  ['query trick', 'https://evil.com/?fcm.googleapis.com'],
  ['path trick', 'https://evil.com/fcm.googleapis.com/fcm/send/x'],
  ['fragment + userinfo trick', 'https://evil.com#@fcm.googleapis.com/x'],
  // backslashes (WHATWG reads \ as / in an https URL)
  ['backslash trick: attacker host first', 'https://evil.com\\@fcm.googleapis.com/fcm/send/x'],
  ['backslash trick: allowed host first', 'https://fcm.googleapis.com\\@evil.com/fcm/send/x'],
  ['backslashes in place of //', 'https:\\\\fcm.googleapis.com/fcm/send/x'],
  // a non-canonical spelling of the scheme separator: WHATWG repairs these,
  // url.parse() finds NO host at all — and a request with no host goes to localhost
  ['one slash after the scheme', 'https:/fcm.googleapis.com/fcm/send/x'],
  ['no slash after the scheme', 'https:fcm.googleapis.com/fcm/send/x'],
  ['no path at all', 'https://fcm.googleapis.com'],
  ['a query straight after the host', 'https://wns2-by3p.notify.windows.com?token=x'],
  // ports
  ['a port on an allowed host', 'https://fcm.googleapis.com:8443/fcm/send/x'],
  ['a port on a WNS host', 'https://wns2-by3p.notify.windows.com:444/w/?token=x'],
  ['an explicit :443, which no browser ever writes', 'https://fcm.googleapis.com:443/fcm/send/x'],
  ['an empty port', 'https://fcm.googleapis.com:/fcm/send/x'],
  // trailing dot
  ['trailing dot', 'https://fcm.googleapis.com./fcm/send/x'],
  ['trailing dot on WNS', 'https://wns2-by3p.notify.windows.com./w/?token=x'],
  // IDN and every other spelling the WHATWG parser maps onto an allowed name
  ['IDN homograph (Cyrillic a)', 'https://fcm.google\u0430pis.com/fcm/send/x'],
  ['IDN homograph in the WNS suffix (Cyrillic o)', 'https://wns2-by3p.notify.windows.c\u043Em/w/'],
  ['fullwidth letter mapped to ASCII', 'https://\uFF46cm.googleapis.com/fcm/send/x'],
  ['Kelvin sign mapped to k', 'https://\u212A.notify.windows.com/w/'],
  ['ideographic full stops mapped to dots', 'https://fcm\u3002googleapis\u3002com/fcm/send/x'],
  ['a soft hyphen the parser deletes', 'https://fcm.google\u00ADapis.com/fcm/send/x'],
  ['an accented label (punycoded by the parser)', 'https://\u00E9vil.notify.windows.com/w/'],
  ['a percent-encoded dot', 'https://fcm%2Egoogleapis.com/fcm/send/x'],
  // IP literals
  ['IPv4 literal', 'https://127.0.0.1/fcm/send/x'],
  ['IPv4 literal of a Google address', 'https://142.250.70.170/fcm/send/x'],
  ['IPv4 as one integer', 'https://2130706433/fcm/send/x'],
  ['IPv4 in hex', 'https://0x7f.0.0.1/fcm/send/x'],
  ['IPv6 literal', 'https://[::1]/fcm/send/x'],
  // PARSER DIFFERENTIALS: WHATWG reads an allowed host, url.parse() — which is
  // what web-push actually connects with — reads the attacker's.
  ['differential: ; ends the host for url.parse()', 'https://evil.com;.notify.windows.com/w/?token=x'],
  ['differential: percent-encoded ;', 'https://evil.com%3B.notify.windows.com/w/'],
  ['differential: { ends the host for url.parse()', 'https://evil.com{.notify.windows.com/w/'],
  ['differential: a tab WHATWG deletes', 'https://evil.com\t.notify.windows.com/w/'],
  ['differential: a tab inside an exact host', 'https://fcm.googleapis.co\tm/fcm/send/x'],
  ['differential: a newline inside an exact host', 'https://fcm.googleapis.com\n/fcm/send/x'],
  ['leading whitespace WHATWG strips', ' https://fcm.googleapis.com/fcm/send/x'],
  // lengths: url.parse() empties a hostname over 255 characters, and a request
  // with an empty hostname goes to localhost — this very machine
  ['a 64-character label', LONG_LABEL],
  ['a 254-character hostname of legal labels', LONG_HOST],
  ['a 274-character hostname url.parse() empties', HUGE_HOST],
];
const NON_STRINGS = [
  ['undefined', undefined], ['null', null], ['a number', 42], ['true', true],
  ['a plain object', {}], ['a subscription object', { endpoint: `https://fcm.googleapis.com/fcm/send/${FCM_TOKEN}` }],
  ['a URL object for an allowed host', new URL(`https://fcm.googleapis.com/fcm/send/${FCM_TOKEN}`)],
  ['an array holding an allowed endpoint', [`https://fcm.googleapis.com/fcm/send/${FCM_TOKEN}`]],
  ['a String object', new String(`https://fcm.googleapis.com/fcm/send/${FCM_TOKEN}`)],
];
{
  let bad = 0;
  for (const [why, e] of [...TRICKS, ...NON_STRINGS]) {
    let r;
    try { r = webPushHostAllowed(e); } catch (err) { bad++; fail(`(2) THREW on ${why}: ${err && err.message}`); continue; }
    if (r !== false) { bad++; fail(`(2) ACCEPTED ${why}: ${show(e)}`); }
  }
  if (!bad) ok(`(2) all ${TRICKS.length} tricks and ${NON_STRINGS.length} non-strings are refused, without throwing`);
  const huge = new URL(LONG_HOST).hostname.length;
  if (huge !== 254) fail(`(2) the 254-character fixture is ${huge} characters — the boundary is not being tested`);
}

// ---- 3. extraHosts: an exact host or host:port, nothing more -----------------
// PUSH_EXTRA_HOSTS exists only for the test suite's own https inbox on
// 127.0.0.1, which listens on a port of its own; production never sets it.
{
  const cases = [
    // [why, endpoint, extraHosts, expected]
    ['an exact host:port entry admits that host and port', 'https://127.0.0.1:9912/push-inbox/x', ['127.0.0.1:9912'], true],
    ['a bare host entry does NOT admit a port', 'https://127.0.0.1:9912/push-inbox/x', ['127.0.0.1'], false],
    ['a bare host entry admits the default port', 'https://127.0.0.1/push-inbox/x', ['127.0.0.1'], true],
    ['the wrong port is refused', 'https://127.0.0.1:9913/push-inbox/x', ['127.0.0.1:9912'], false],
    ['a hostname entry, exact', 'https://push.example.test/x', ['push.example.test'], true],
    ['entries are compared lowercased', 'https://push.example.test/x', ['PUSH.Example.TEST'], true],
    ['and the endpoint host case does not matter', 'https://PUSH.example.test/x', ['push.example.test'], true],
    ['NO suffix match: a subdomain of an entry', 'https://evil.push.example.test/x', ['push.example.test'], false],
    ['NO suffix match: an entry as a parent', 'https://push.example.test/x', ['example.test'], false],
    ['NO suffix match: a name ending in the entry', 'https://evilpush.example.test/x', ['push.example.test'], false],
    ['NO prefix match: entry + attacker domain', 'https://push.example.test.evil.com/x', ['push.example.test'], false],
    ['NO substring match', 'https://push.example.test/x', ['example'], false],
    ['an entry does not bypass the scheme check', 'http://push.example.test/x', ['push.example.test'], false],
    ['an entry does not bypass the userinfo check', 'https://u@push.example.test/x', ['push.example.test'], false],
    ['an entry does not bypass the trailing-dot check', 'https://push.example.test./x', ['push.example.test'], false],
    ['an entry does not bypass the literal-authority check', 'https://push%2Eexample.test/x', ['push.example.test'], false],
    ['an entry does not bypass the literal-authority check (integer IPv4)', 'https://2130706433:9912/x', ['127.0.0.1:9912'], false],
    ['junk entries are ignored, not fatal', 'https://evil.com/x', [null, 42, '', '  ', {}, undefined], false],
    ['a STRING is not a list (no substring matching by accident)', 'https://evil.com/x', 'evil.com', false],
    ['a string list of one host still needs the array form', 'https://push.example.test/x', 'push.example.test', false],
    ['extraHosts omitted: the built-in list still works', `https://fcm.googleapis.com/fcm/send/${FCM_TOKEN}`, undefined, true],
    ['an entry does not narrow the built-in list', `https://web.push.apple.com/${APPLE_TOKEN}`, ['127.0.0.1:9912'], true],
  ];
  let bad = 0;
  for (const [why, e, extra, want] of cases) {
    let r;
    try { r = extra === undefined ? webPushHostAllowed(e) : webPushHostAllowed(e, extra); } catch (err) { bad++; fail(`(3) THREW: ${why}: ${err && err.message}`); continue; }
    if (r !== want) { bad++; fail(`(3) ${why}: ${show(e)} with ${JSON.stringify(extra)} gave ${r}, expected ${want}`); }
  }
  if (!bad) ok(`(3) extraHosts is exact-match only across ${cases.length} cases, and bypasses none of the other checks`);
}

// ---- 4. the built-in list is exactly four hosts and two suffixes -------------
// Any other Google, Apple, Mozilla or Microsoft name is refused: a push service
// is a HOST, not a company. The two suffixes are the zones Microsoft and Apple
// themselves say a server must allow; their parents are refused.
{
  const near = ['https://www.googleapis.com/x', 'https://push.apple.com/x', 'https://apple.com/x',
    'https://www.apple.com/x', 'https://push.services.mozilla.com/x', 'https://services.mozilla.com/x',
    'https://google.com/x', 'https://windows.com/x', 'https://notify.windows.net/x', 'https://wns.windows.com/x',
    'https://jmt18.google.com/x'];
  const leaked = near.filter((e) => webPushHostAllowed(e));
  if (leaked.length) fail(`(4) names outside the list were accepted: ${leaked.join(', ')}`);
  else ok(`(4) ${near.length} neighbouring Google/Apple/Mozilla/Microsoft names are refused — hosts, not companies`);
}

// ---- 5. deterministic ---------------------------------------------------------
// No state: the same input gives the same verdict however often it is asked,
// and a verdict for one endpoint never changes another's.
{
  const a = `https://fcm.googleapis.com/fcm/send/${FCM_TOKEN}`, b = 'https://evil.com/x';
  const seq = [a, b, a, b, a].map((e) => webPushHostAllowed(e));
  if (JSON.stringify(seq) === '[true,false,true,false,true]') ok('(5) the verdict is stateless: interleaved calls agree');
  else fail(`(5) interleaved verdicts drifted: ${JSON.stringify(seq)}`);
}

// ---- 6. what web-push would ACTUALLY connect to --------------------------------
// The property that matters, checked against the parser web-push uses rather
// than the one the module uses: for every string the module ACCEPTS, url.parse()
// — exactly as web-push's sendNotification calls it — must produce an https URL,
// no credentials, and a host:port that is a push service (or the named extra).
// A url.parse() that throws is safe (web-push rejects before any request).
const SERVICE = new Set(['fcm.googleapis.com', 'android.googleapis.com', 'jmt17.google.com',
  'updates.push.services.mozilla.com']);
const SUFFIXES = ['.notify.windows.com', '.push.apple.com'];
const legacyTargetOk = (s, extra) => {
  let p;
  try { p = url.parse(s); } catch { return true; }
  if (p.protocol !== 'https:' || p.auth) return false;
  const h = p.hostname || '';                     // '' or null: web-push would ask for localhost
  if (!h) return false;
  const hostPort = p.port ? `${h}:${p.port}` : h;
  if (extra.includes(hostPort)) return true;
  if (p.port && p.port !== '443') return false;
  if (SERVICE.has(h)) return true;
  const suffix = SUFFIXES.find((x) => h.endsWith(x));
  const pre = suffix ? h.slice(0, -suffix.length) : '';
  return !!pre && pre.split('.').every((l) => /^[a-z0-9-]{1,63}$/.test(l)) && h.length <= 253;
};
{
  const EXTRA = ['127.0.0.1:9912'];
  // Every ASCII code point, plus the non-ASCII ones WHATWG folds onto ASCII.
  const chars = [];
  for (let c = 0; c < 128; c++) chars.push(String.fromCharCode(c));
  chars.push('\u3002', '\uFF0E', '\uFF46', '\u212A', '\u0130', '\u00AD', '\u200B', '\u2028', '\u0430', '\u00E9');
  const bases = [
    `https://fcm.googleapis.com/fcm/send/${FCM_TOKEN.slice(0, 12)}`,
    `https://web.push.apple.com/${APPLE_TOKEN.slice(0, 12)}`,
    `https://updates.push.services.mozilla.com/wpush/v2/${MOZ_TOKEN.slice(0, 8)}`,
    'https://wns2-by3p.notify.windows.com/w/?token=AB',
    'https://127.0.0.1:9912/push-inbox/x',
  ];
  const corpus = new Set([...LEGIT, ...TRICKS.map((t) => t[1])]);
  for (const b of bases) {
    for (let i = 0; i <= b.length; i++) {
      for (const c of chars) {
        corpus.add(b.slice(0, i) + c + b.slice(i));                 // insert
        if (i < b.length) corpus.add(b.slice(0, i) + c + b.slice(i + 1)); // replace
      }
    }
    // An attacker domain spliced in front of every dot of the base's host.
    const hostEnd = b.indexOf('/', 8);
    for (let i = 8; i < hostEnd; i++) {
      if (b[i] !== '.') continue;
      for (const sep of [';', '{', '%3B', '\t', '|', '"', '`', '^', '}', "'", '<', '>', ' ', '*', '%', '_', '\\', '@', '#', '?']) {
        corpus.add(`${b.slice(0, 8)}evil.com${sep}${b.slice(i)}`);
      }
    }
  }
  let accepted = 0;
  const bad = [];
  for (const s of corpus) {
    if (!webPushHostAllowed(s, EXTRA)) continue;
    accepted++;
    if (!legacyTargetOk(s, EXTRA)) {
      let p = null;
      try { p = url.parse(s); } catch {}
      bad.push(`${show(s)} -> url.parse host ${JSON.stringify(p && p.hostname)} port ${p && p.port}`);
    }
  }
  if (bad.length) {
    fail(`(6) ${bad.length} ACCEPTED endpoint(s) would make web-push connect somewhere else:`);
    for (const l of bad.slice(0, 8)) console.error('      ' + l);
  } else if (accepted < 50) {
    fail(`(6) only ${accepted} of ${corpus.size} strings were accepted — the fuzz is not exercising the accept path`);
  } else {
    ok(`(6) ${corpus.size} strings fuzzed around every legitimate shape: all ${accepted} accepted ones send web-push to a push service by url.parse()'s own reading`);
  }
}

// ---- 7. web-push still chooses its host with url.parse() ------------------------
// Section 6 models web-push 3.6.7's sendNotification. If a web-push upgrade
// changes how the host is chosen, the model is stale and must be re-derived —
// so a change there is a failure here, not a surprise in production.
{
  const require = createRequire(import.meta.url);
  const lib = path.join(path.dirname(require.resolve('web-push')), 'web-push-lib.js');
  const src = readFileSync(lib, 'utf8');
  const pinned = /const urlParts = url\.parse\(requestDetails\.endpoint\);\s*httpsOptions\.hostname = urlParts\.hostname;\s*httpsOptions\.port = urlParts\.port;/
    .test(src) && /requestDetails\.endpoint = subscription\.endpoint;/.test(src);
  if (pinned) ok('(7) web-push still connects to url.parse(subscription.endpoint) — section 6 models the real request');
  else fail(`(7) ${lib} no longer picks its host with url.parse(subscription.endpoint) — re-derive section 6 before trusting it`);
  // And the model only matters while server.js sends web push THROUGH web-push:
  // one call, straight after the gate. A rewritten or second sender would skip
  // the gate and connect in a way section 6 never modelled, so it fails here
  // until it is gated and section 6 is re-derived for what it connects with.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const sends = server.split('webpush.sendNotification(').length - 1;
  const gated = /if \(!webPushHostAllowed\(sub\.endpoint, PUSH_EXTRA_HOSTS\)\) \{ noteRefusedPushHost\(sub\.endpoint\); continue; \}\n[ \t]*webpush\.sendNotification\(sub, /
    .test(server);
  if (sends === 1 && gated) ok('(7) server.js sends web push through exactly one webpush.sendNotification(sub, ...), straight after the gate on sub.endpoint');
  else fail(`(7) server.js has ${sends} webpush.sendNotification call(s)${gated ? '' : ', and none straight after webPushHostAllowed(sub.endpoint, ...)'} — every web push send must be gated, and section 6 re-derived for a new sender`);
}

// ---- 8. production never sets PUSH_EXTRA_HOSTS ---------------------------------
// The escape hatch exists for push_persist's local inbox alone. A deploy config
// that named it would widen the list on the live server.
{
  const named = [];
  for (const f of ['render.yaml', 'Dockerfile']) {
    let src = null;
    try { src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'); } catch {}
    if (src === null && f === 'render.yaml') fail('(8) render.yaml not found — the deploy config this check guards has moved');
    if (src && src.includes('PUSH_EXTRA_HOSTS')) named.push(f);
  }
  if (named.length) fail(`(8) ${named.join(' and ')} ${named.length > 1 ? 'name' : 'names'} PUSH_EXTRA_HOSTS — it is for the test suite's local inbox only`);
  else ok('(8) no deploy config (render.yaml, Dockerfile) names PUSH_EXTRA_HOSTS');
}

// ---- 9. every test input in this file is written as an escape ------------------
// The tricks and the fuzz alphabet rely on invisible and look-alike code points
// (a soft hyphen, a zero-width space, a line separator, the Kelvin sign). Written
// raw, an editor or formatter that normalises or strips them would change what
// is tested, silently. So nothing outside printable ASCII may appear in this
// file but the em dash of its prose.
{
  const raw = [];
  readFileSync(new URL(import.meta.url), 'utf8').split('\n').forEach((line, i) => {
    for (const ch of line) {
      if (!/^[\t\x20-\x7e\u2014]$/u.test(ch)) raw.push(`line ${i + 1} U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    }
  });
  if (raw.length) fail(`(9) raw non-ASCII code points in this file, write them as \\u escapes: ${raw.slice(0, 8).join(', ')}`);
  else ok('(9) every non-ASCII test input in this file is a \\u escape');
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall push host checks passed');
process.exit(out.errors.length ? 1 : 0);
