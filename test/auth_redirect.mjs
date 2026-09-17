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
// Also pinned here: WHICH return URL each carrier gets. This client uses the
// implicit flow, so the fragment carries a live access token. Where the OS
// routes the reply (a Universal Link / App Link reopening the app), the return
// must be DOMAIN-BOUND, never a private-use scheme: any app can register a
// scheme, so a scheme callback would hand a working session to whoever claimed
// it. Where the in-app sheet routes the reply (iOS, ASWebAuthenticationSession
// via the CCWebAuth plugin), the return is the app's own scheme — safe there,
// because the session hands the URL only to the app that opened it — and it
// must be used ONLY when that plugin is actually present.
import fs from 'node:fs';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };

const SRC = fs.readFileSync(new URL('../public/cloud.js', import.meta.url), 'utf8');
const SB = 'https://proj.supabase.co';
const CALLBACK = 'com.abarabrothers.cannonsandcanyons://auth/callback';

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
function load({ native, inApp }) {
  const window = {
    CC_SUPABASE_URL: SB,
    CC_SUPABASE_KEY: 'pk_test',
    CC_NATIVE_HOST: 'tanks.abarabrothers.com',
  };
  // config.js sets CC_IOS_CALLBACK on EVERY platform; what must decide the
  // route is the plugin's presence, so the stub carries the value everywhere.
  window.CC_IOS_CALLBACK = CALLBACK;
  if (native) window.Capacitor = { getPlatform: () => 'ios' };
  if (inApp && window.Capacitor) window.Capacitor.Plugins = { CCWebAuth: { start: async () => ({}) } };
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
    ok('native WITHOUT the in-app sheet comes back to the claimed Universal Link path');
  } else fail(`native redirect_to is ${back}`);
  // The security decision, pinned so it cannot be "simplified" later: when the
  // OS routes the reply, the return is domain-bound.
  if (/^https:\/\//.test(back)) ok('the OS-routed native return is https, NOT a private-use scheme');
  else fail(`the OS-routed native return is not https (${back}) — any app could claim it and take the token`);

  // WITH the in-app sheet, the return is the app's own scheme — exactly the
  // configured value, because that string is also what Supabase's redirect
  // allow-list holds, and a near-miss is a refused sign-in with no error here.
  const sheet = load({ native: true, inApp: true });
  const sUrl = new URL(sheet.Cloud.signInUrl('google'));
  const sBack = sUrl.searchParams.get('redirect_to') || '';
  if (sBack === CALLBACK) ok('native WITH the in-app sheet comes back to CC_IOS_CALLBACK, verbatim');
  else fail(`in-app redirect_to is ${sBack}, expected ${CALLBACK}`);
  if (sheet.Cloud.inAppAuth() === true) ok('inAppAuth() says yes when the plugin is present');
  else fail('inAppAuth() is false with the plugin present — goSignIn would leave for Safari and the scheme reply would be lost');
  if (nat.Cloud.inAppAuth() === false && web.Cloud.inAppAuth() === false) {
    ok('inAppAuth() says no without the plugin, so nothing is ever sent to a scheme the OS would route');
  } else fail('inAppAuth() is true without the plugin — a scheme return would be handed to the OS');
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

  // IN-APP carrier, no flag: a scheme reply nobody asked for.
  const c = load({ native: true, inApp: true });
  const r3 = c.Cloud.consumeRedirect(CALLBACK + '#' + FRAG);
  if (r3 === false && c.local.getItem('cc_session') === null) {
    ok('in-app: a reply this client did not ask for is discarded');
  } else fail(`in-app: an unsolicited scheme reply was accepted (${r3}) — login CSRF on the sheet path`);
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

  const s = load({ native: true, inApp: true });
  s.Cloud.signInUrl('google');
  const sUrl = CALLBACK + '#' + FRAG;
  const sFirst = s.Cloud.consumeRedirect(sUrl);
  const sSecond = s.Cloud.consumeRedirect(sUrl);
  if (sFirst === 'ok') ok('in-app: the reply to a sign-in this client started is accepted');
  else fail(`in-app: a legitimate scheme reply was refused (${sFirst})`);
  if (sSecond === false) ok('in-app: the flag is single-use on the sheet path too');
  else fail(`in-app: the same reply was consumed twice (${sSecond})`);

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

// ---- 6. a dismissed sheet disarms the flag ---------------------------------
// The in-app sheet gives a definite "no reply is coming" signal (cancelled, or
// failed to open), and goSignIn() calls cancelPending() on every one of them.
// On native the flag lives in localStorage, so without this it would stay
// armed until the next reply of ANY kind — a crafted Universal Link opened
// from a message included, which is precisely what the flag exists to refuse.
{
  const s = load({ native: true, inApp: true });
  s.Cloud.signInUrl('google');
  if (s.local.getItem('cc_oauth_pending') === '1') ok('starting a sign-in arms the flag on the sheet path');
  else fail('the sheet path did not arm the flag — its own reply would be refused');
  s.Cloud.cancelPending();
  if (s.local.getItem('cc_oauth_pending') === null) ok('cancelPending() disarms it');
  else fail('cancelPending() left the flag armed');
  const r = s.Cloud.consumeRedirect(CALLBACK + '#' + FRAG);
  if (r === false && s.local.getItem('cc_session') === null) ok('after a cancel, a late reply is refused');
  else fail(`after a cancel, a late reply was accepted (${r})`);
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
