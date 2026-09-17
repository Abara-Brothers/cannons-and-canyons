// whoami()'s `accounts`: the list the account chip and the Bay controls row draw
// from. cloud.js is a browser classic script, evaluated here against stub
// globals with a recording fetch — same harness as apple_native.mjs. No server,
// no network, no Supabase.
//
// WHY THIS EXISTS: the chip shows a provider mark per entry and the row shows an
// address per entry. Both are provider-supplied data reshaped here; the two
// silent mistakes are dropping a linked provider (a player with Apple AND Google
// sees one) and reading the address off the wrong identity.
import fs from 'node:fs';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const SRC = fs.readFileSync(new URL('../public/cloud.js', import.meta.url), 'utf8');
const SB = 'https://proj.supabase.co';

function mkStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
function load(user) {
  const calls = [];
  const fetch = async (url, opts) => { calls.push({ url, opts }); return reply(200, user); };
  const window = { CC_SUPABASE_URL: SB, CC_SUPABASE_KEY: 'pk_test', CC_NATIVE_HOST: 'tanks.abarabrothers.com' };
  const local = mkStore(), sess = mkStore();
  window.localStorage = local; window.sessionStorage = sess;
  local.setItem('cc_session', JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600, user_id: user.id }));
  const location = { origin: 'https://tanks.abarabrothers.com', href: '', hash: '', pathname: '/', search: '' };
  const fn = new Function('window', 'location', 'history', 'localStorage', 'sessionStorage', 'fetch', SRC);
  fn(window, location, { replaceState: () => {} }, local, sess, fetch);
  return { Cloud: window.Cloud, calls };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1. a guest: nothing linked, and the existing fields are what they were
{
  const b = load({ id: 'u1', is_anonymous: true, identities: [] });
  const w = await b.Cloud.whoami();
  if (w && w.anonymous === true && w.google === false && w.apple === false && w.email === null) ok('guest: anonymous, no providers, no email');
  else fail('guest fields: ' + JSON.stringify(w));
  if (w && same(w.accounts, [])) ok('guest: accounts is an empty list'); else fail('guest accounts: ' + JSON.stringify(w && w.accounts));
  if (b.calls.length === 1 && b.calls[0].url === SB + '/auth/v1/user') ok('one GET /auth/v1/user'); else fail('calls: ' + JSON.stringify(b.calls.map((c) => c.url)));
}
// 2. Apple only, with Hide My Email: the relay address is the address
{
  const relay = 'x7q2p@privaterelay.appleid.com';
  const b = load({ id: 'u2', is_anonymous: false, email: relay, identities: [{ provider: 'apple', identity_data: { email: relay } }] });
  const w = await b.Cloud.whoami();
  if (w && w.apple === true && w.google === false && w.email === relay) ok('apple: flags and email as before');
  else fail('apple fields: ' + JSON.stringify(w));
  if (w && same(w.accounts, [{ provider: 'apple', email: relay }])) ok('apple: one account, the relay address');
  else fail('apple accounts: ' + JSON.stringify(w && w.accounts));
}
// 3. both linked, different addresses: two entries, Apple first, each with ITS address
{
  const b = load({ id: 'u3', is_anonymous: false, email: 'me@gmail.example', identities: [
    { provider: 'google', identity_data: { email: 'me@gmail.example' } },
    { provider: 'apple', identity_data: { email: 'q1@privaterelay.appleid.com' } },
  ] });
  const w = await b.Cloud.whoami();
  if (w && same(w.accounts, [{ provider: 'apple', email: 'q1@privaterelay.appleid.com' }, { provider: 'google', email: 'me@gmail.example' }]))
    ok('both: Apple first regardless of GoTrue order, each with its own address');
  else fail('both accounts: ' + JSON.stringify(w && w.accounts));
  if (w && w.google === true && w.apple === true && w.email === 'me@gmail.example') ok('both: flags and primary email as before');
  else fail('both fields: ' + JSON.stringify(w));
}
// 4. an identity with no address: the entry stays (the mark still shows), email null
{
  const b = load({ id: 'u4', is_anonymous: false, email: null, identities: [{ provider: 'google', identity_data: {} }] });
  const w = await b.Cloud.whoami();
  if (w && same(w.accounts, [{ provider: 'google', email: null }])) ok('no address: entry kept with email null');
  else fail('no-address accounts: ' + JSON.stringify(w && w.accounts));
}
// 5. an unknown provider is not listed (the UI has no mark for it), the known one is
{
  const b = load({ id: 'u5', is_anonymous: false, email: 'a@b.c', identities: [{ provider: 'github', identity_data: { email: 'a@b.c' } }, { provider: 'google', identity_data: { email: 'a@b.c' } }] });
  const w = await b.Cloud.whoami();
  if (w && same(w.accounts, [{ provider: 'google', email: 'a@b.c' }])) ok('unknown provider: skipped, known one listed');
  else fail('unknown-provider accounts: ' + JSON.stringify(w && w.accounts));
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall account checks passed');
process.exit(out.errors.length ? 1 : 0);
