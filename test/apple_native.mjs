// Sign in with Apple, natively (iOS): the contract between app.js's
// appleNativeFn and GoTrue's id_token grant, pinned headlessly. cloud.js is a
// browser classic script, so it is evaluated here against stub globals with a
// recording fetch. No server, no network, no Supabase.
//
// WHY THIS EXISTS: this is the second path in the codebase that can mint or
// change WHICH account a device is signed into, and the link variant carries
// the guest's bearer token. Two mistakes here are silent in every manual test
// that succeeds: sending the link without the bearer (GoTrue mints a NEW
// account and the guest's row is orphaned), and treating a refused link as a
// reason to sign in fresh (same orphaning, reported as success).
import fs from 'node:fs';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };

const SRC = fs.readFileSync(new URL('../public/cloud.js', import.meta.url), 'utf8');
const SB = 'https://proj.supabase.co';
const GRANT = SB + '/auth/v1/token?grant_type=id_token';

function mkStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}
const reply = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => { if (body === undefined) throw new Error('not json'); return body; },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

// An isolated iOS "browser" whose fetch answers with `answer` and records
// every call. `guest` seeds a live anonymous session, as a real guest has.
function load({ answer, guest }) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (typeof answer === 'function') return answer(url, opts);
    return answer;
  };
  const window = {
    CC_SUPABASE_URL: SB, CC_SUPABASE_KEY: 'pk_test',
    CC_NATIVE_HOST: 'tanks.abarabrothers.com',
    CC_IOS_CALLBACK: 'com.abarabrothers.cannonsandcanyons://auth/callback',
    Capacitor: { getPlatform: () => 'ios', Plugins: { AppleSignIn: {}, CCWebAuth: {} } },
  };
  const local = mkStore(), sess = mkStore();
  window.localStorage = local; window.sessionStorage = sess;
  if (guest) {
    local.setItem('cc_session', JSON.stringify({
      access_token: 'guest_at', refresh_token: 'guest_rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user_id: 'guest_user',
    }));
  }
  const location = { origin: 'https://tanks.abarabrothers.com', href: '', hash: '', pathname: '/', search: '' };
  const history = { replaceState: () => {} };
  const fn = new Function('window', 'location', 'history', 'localStorage', 'sessionStorage', 'fetch', SRC);
  fn(window, location, history, local, sess, fetch);
  return { Cloud: window.Cloud, local, sess, calls };
}
const TOKENS = { access_token: 'at_apple', refresh_token: 'rt_apple', expires_in: 3600, user: { id: 'apple_user' } };
const stored = (b) => JSON.parse(b.local.getItem('cc_session') || 'null');
const flag = (b) => b.local.getItem('cc_oauth_pending') || b.sess.getItem('cc_oauth_pending');

// ---- 1. a fresh sign-in: the grant, exactly, and the session it mints ------
{
  const b = load({ answer: reply(200, TOKENS) });
  const r = await b.Cloud.signInWithApple('tok.en', 'rawnonce', false);
  const c = b.calls[0];
  if (r && r.ok === true) ok('fresh: resolves ok');
  else fail(`fresh: resolved ${JSON.stringify(r)}`);
  if (b.calls.length === 1 && c.url === GRANT && c.opts.method === 'POST') ok('fresh: ONE POST to the id_token grant');
  else fail(`fresh: calls were ${b.calls.map((x) => x.opts.method + ' ' + x.url).join(', ')}`);
  const body = JSON.parse(c.opts.body);
  if (body.provider === 'apple' && body.id_token === 'tok.en' && body.nonce === 'rawnonce') ok('fresh: body carries provider, the token and the RAW nonce');
  else fail(`fresh: body was ${c.opts.body}`);
  if (!('link_identity' in body) && !c.opts.headers.Authorization) ok('fresh: no link_identity and no bearer — a fresh sign-in must not be mistaken for a link');
  else fail(`fresh: link markers present (${c.opts.body}, auth=${c.opts.headers.Authorization})`);
  if (c.opts.headers.apikey === 'pk_test') ok('fresh: the publishable key is sent');
  else fail('fresh: apikey header missing');
  const s = stored(b);
  if (s && s.access_token === 'at_apple' && s.refresh_token === 'rt_apple' && s.user_id === 'apple_user') ok('fresh: the response became the stored session, user id included');
  else fail(`fresh: stored session is ${JSON.stringify(s)}`);
  if (flag(b) === null) ok('fresh: the native path never arms the OAuth pending flag');
  else fail('fresh: the pending flag was armed — a later crafted link would be accepted');
}

// ---- 2. a link: the guest's bearer and link_identity, keeping the account --
{
  const b = load({ answer: reply(200, { ...TOKENS, user: { id: 'guest_user' } }), guest: true });
  const r = await b.Cloud.signInWithApple('tok.en', 'rawnonce', true);
  const c = b.calls[0];
  if (r && r.ok === true) ok('link: resolves ok');
  else fail(`link: resolved ${JSON.stringify(r)}`);
  if (b.calls.length === 1 && c.url === GRANT) ok('link: ONE POST to the id_token grant (the live session needs no refresh first)');
  else fail(`link: calls were ${b.calls.map((x) => x.opts.method + ' ' + x.url).join(', ')}`);
  const body = JSON.parse(c.opts.body);
  if (body.link_identity === true) ok('link: link_identity is sent');
  else fail(`link: link_identity missing (${c.opts.body}) — GoTrue would mint a NEW account and orphan the guest`);
  if (c.opts.headers.Authorization === 'Bearer guest_at') ok("link: the GUEST's bearer goes with it, so the identity attaches to that account");
  else fail(`link: Authorization was ${c.opts.headers.Authorization}`);
  const s = stored(b);
  if (s && s.access_token === 'at_apple' && s.user_id === 'guest_user') ok('link: the returned session replaces the guest one, same user id');
  else fail(`link: stored session is ${JSON.stringify(s)}`);
}

// ---- 3. a refused link leaves the guest exactly as it was --------------------
{
  const b = load({ answer: reply(422, { code: 422, error_code: 'identity_already_exists', msg: 'Identity is already linked to another user' }), guest: true });
  const before = b.local.getItem('cc_session');
  const r = await b.Cloud.signInWithApple('tok.en', 'rawnonce', true);
  if (r && r.ok === false && r.code === 'identity_already_exists') ok("refused link: reports GoTrue's error_code, so the toast can be honest");
  else fail(`refused link: resolved ${JSON.stringify(r)}`);
  if (b.local.getItem('cc_session') === before) ok('refused link: the guest session is byte-identical — nothing was signed out or replaced');
  else fail('refused link: the guest session changed');
  if (b.calls.length === 1) ok('refused link: NO second attempt — a failed link is never retried as a fresh sign-in');
  else fail(`refused link: ${b.calls.length} requests were made`);
}

// ---- 4. a link with nothing to link to makes no request -------------------
{
  const b = load({ answer: reply(200, TOKENS), guest: false });
  const r = await b.Cloud.signInWithApple('tok.en', 'rawnonce', true);
  if (r && r.ok === false && r.code === 'no_session') ok('no-session link: refused up front');
  else fail(`no-session link: resolved ${JSON.stringify(r)}`);
  if (b.calls.length === 0) ok('no-session link: the grant was never sent (nothing to attach to, and no bearer to send)');
  else fail(`no-session link: ${b.calls.length} requests were made`);
  if (stored(b) === null) ok('no-session link: nothing was stored');
  else fail('no-session link: a session appeared from nowhere');
}

// ---- 5. the network says nothing about the credentials --------------------
{
  const b = load({ answer: () => { throw new Error('offline'); }, guest: true });
  const before = b.local.getItem('cc_session');
  const r = await b.Cloud.signInWithApple('tok.en', 'rawnonce', true);
  if (r && r.ok === false && r.code === 'network') ok('network failure: reported as network, not as a refusal');
  else fail(`network failure: resolved ${JSON.stringify(r)}`);
  if (b.local.getItem('cc_session') === before) ok('network failure: the guest session is untouched');
  else fail('network failure: the guest session changed');
}

// ---- 6. a broken reply is a failure, never a half-session ------------------
{
  const b = load({ answer: reply(500, undefined) });
  const r = await b.Cloud.signInWithApple('tok.en', 'rawnonce', false);
  if (r && r.ok === false && r.code === 'http_500') ok('non-JSON 500: reported by status');
  else fail(`non-JSON 500: resolved ${JSON.stringify(r)}`);
  const b2 = load({ answer: reply(200, { access_token: 'only' }) });
  const r2 = await b2.Cloud.signInWithApple('tok.en', 'rawnonce', false);
  if (r2 && r2.ok === false && stored(b2) === null) ok('a 200 without a refresh token is refused and stores nothing');
  else fail(`a tokenless 200 resolved ${JSON.stringify(r2)} and stored ${JSON.stringify(stored(b2))}`);
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
process.exit(out.errors.length ? 1 : 0);
