// The OAuth redirect contract (Sign in with Apple / Google, web and native).
// Headless: cloud.js is a browser classic script, so it is evaluated here
// against stub globals. No server, no network, no Supabase.
//
// WHY THIS EXISTS: adding a second provider and a second CARRIER for the reply
// touched the one function in this codebase where a mistake is a silent account
// takeover. consumeRedirect() accepts tokens only for a sign-in THIS client
// started, and the flag proving that moved from sessionStorage to localStorage
// on native — because the WebView is backgrounded for the whole provider leg and
// iOS may discard its sessionStorage. A guard that is right on one carrier and
// absent on the other looks identical in every manual test that signs in
// successfully: the CSRF case is the one nobody performs by hand.
//
// Also pinned here: the native reply must come back to a DOMAIN-BOUND URL, never
// a private-use scheme. This client uses the implicit flow, so the fragment
// carries a live access token; any app can register a scheme, so a scheme
// callback hands a working session to whoever claimed it.
import fs from 'node:fs';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };

const SRC = fs.readFileSync(new URL('../public/cloud.js', import.meta.url), 'utf8');
const SB = 'https://proj.supabase.co';

function mkStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

// Build an isolated "browser" and return its Cloud plus the stores, so a test
// can inspect exactly which storage the flag landed in.
function load({ native }) {
  const window = {
    CC_SUPABASE_URL: SB,
    CC_SUPABASE_KEY: 'pk_test',
    CC_NATIVE_HOST: 'tanks.abarabrothers.com',
  };
  if (native) window.Capacitor = { getPlatform: () => 'ios' };
  const local = mkStore(), sess = mkStore();
  window.localStorage = local;
  window.sessionStorage = sess;
  const location = { origin: 'https://tanks.abarabrothers.com', href: '', hash: '', pathname: '/', search: '' };
  const history = { replaceState: (_a, _b, url) => { history._last = url; location.hash = ''; } };
  const fn = new Function('window', 'location', 'history', 'localStorage', 'sessionStorage', 'fetch', SRC);
  fn(window, location, history, local, sess, async () => { throw new Error('no network in this test'); });
  return { Cloud: window.Cloud, local, sess, location, history };
}

const FRAG = 'access_token=at_fake&refresh_token=rt_fake&expires_in=3600';

// ---- 1. the authorize URL, per platform ------------------------------------
{
  const web = load({ native: false });
  const nat = load({ native: true });
  const wUrl = new URL(web.Cloud.signInUrl('google'));
  const aUrl = new URL(nat.Cloud.signInUrl('apple'));

  if (wUrl.searchParams.get('provider') === 'google') ok('web asks the provider it was given');
  else fail(`web provider was ${wUrl.searchParams.get('provider')}`);
  if (aUrl.searchParams.get('provider') === 'apple') ok('apple is a real provider choice, not a relabelled google');
  else fail(`apple provider was ${aUrl.searchParams.get('provider')}`);

  // An omitted provider must stay google: web and Android call it with none.
  if (new URL(web.Cloud.signInUrl()).searchParams.get('provider') === 'google') {
    ok('an omitted provider still means google, so web is unchanged');
  } else fail('the default provider changed — web sign-in would switch providers silently');

  if (wUrl.searchParams.get('redirect_to') === 'https://tanks.abarabrothers.com/') {
    ok('web comes back to its own origin, exactly as before');
  } else fail(`web redirect_to is ${wUrl.searchParams.get('redirect_to')}`);

  const back = aUrl.searchParams.get('redirect_to') || '';
  if (back === 'https://tanks.abarabrothers.com/auth/callback') {
    ok('native comes back to the claimed Universal Link path');
  } else fail(`native redirect_to is ${back}`);
  // The security decision, pinned so it cannot be "simplified" later.
  if (/^https:\/\//.test(back)) ok('the native return is https, NOT a private-use scheme');
  else fail(`the native return is not https (${back}) — any app could claim it and take the token`);
}

// ---- 2. the CSRF guard, on BOTH carriers -----------------------------------
{
  // WEB carrier, no flag: a pasted #access_token link must be discarded.
  const a = load({ native: false });
  a.location.hash = '#' + FRAG;
  const r1 = a.Cloud.consumeRedirect();
  if (r1 === false && a.local.getItem('cc_session') === null) {
    ok('web: a fragment this client did not ask for is discarded');
  } else fail(`web: an unsolicited fragment was accepted (${r1}) — login CSRF`);

  // NATIVE carrier, no flag: same rule must hold on the new path.
  const b = load({ native: true });
  const r2 = b.Cloud.consumeRedirect('https://tanks.abarabrothers.com/auth/callback#' + FRAG);
  if (r2 === false && b.local.getItem('cc_session') === null) {
    ok('native: a link this client did not ask for is discarded');
  } else fail(`native: an unsolicited Universal Link was accepted (${r2}) — login CSRF on the native path`);
}

// ---- 3. a sign-in this client DID start is accepted, once ------------------
{
  const n = load({ native: true });
  n.Cloud.signInUrl('apple');                       // sets the flag
  const url = 'https://tanks.abarabrothers.com/auth/callback#' + FRAG;
  const first = n.Cloud.consumeRedirect(url);
  const second = n.Cloud.consumeRedirect(url);      // replay
  if (first === 'ok') ok('native: the reply to a sign-in this client started is accepted');
  else fail(`native: a legitimate reply was refused (${first})`);
  if (second === false) ok('native: the flag is single-use, so a captured link cannot be replayed');
  else fail(`native: the same link was consumed twice (${second}) — the flag is not being cleared`);

  const w = load({ native: false });
  w.Cloud.signInUrl('google');
  w.location.hash = '#' + FRAG;
  if (w.Cloud.consumeRedirect() === 'ok') ok('web: a legitimate reply is still accepted');
  else fail('web: a legitimate reply was refused — web sign-in is broken');
  if (w.location.hash === '') ok('web: the tokens are scrubbed from the address bar');
  else fail('web: tokens were left in the address bar, where history and shares keep them');
}

// ---- 4. the flag lives where the platform can keep it ----------------------
{
  const w = load({ native: false });
  w.Cloud.signInUrl('google');
  if (w.sess.getItem('cc_oauth_pending') === '1' && w.local.getItem('cc_oauth_pending') === null) {
    ok('web keeps the flag per-TAB in sessionStorage, so another tab cannot be fed tokens');
  } else fail('web moved the flag out of sessionStorage — the guard is no longer per-tab');

  const n = load({ native: true });
  n.Cloud.signInUrl('apple');
  // Native has no tabs, and iOS can discard a backgrounded WebView's
  // sessionStorage while Safari runs the provider leg. In localStorage the flag
  // survives that; in sessionStorage a legitimate return is silently refused.
  if (n.local.getItem('cc_oauth_pending') === '1') {
    ok('native keeps the flag in localStorage, so it survives the app being backgrounded');
  } else fail('native put the flag in sessionStorage — a discarded WebView silently breaks sign-in');
}

// ---- 5. a provider error is reported, not swallowed ------------------------
{
  const n = load({ native: true });
  n.Cloud.signInUrl('apple');
  const r = n.Cloud.consumeRedirect('https://tanks.abarabrothers.com/auth/callback#error=access_denied');
  if (r === 'error') ok('a cancelled sign-in is reported as an error, not as silence');
  else fail(`a provider error returned ${r} — the player would be told nothing`);
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
