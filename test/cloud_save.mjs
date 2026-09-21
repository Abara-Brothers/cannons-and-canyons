// THE CLOUD SAVE MUST NOT BE ABLE TO DESTROY A CHOSEN CALLSIGN.
//
// WHY THIS SUITE EXISTS: public/cloud.js is not in the diff of the 27 commits
// that made `profiles.callsign` load-bearing, and that is exactly why nothing
// caught this. A chosen name is believed only while
// normaliseCallsign(callsign) === callsign_key (server/display-name.js); the
// phase 6 grants let this client write `callsign` but never `callsign_key`; and
// save() used to put this device's local name in the upsert body on every save.
// So a second device, a reinstall or cleared site data booted to the home screen
// and about four seconds later PATCHed its own rolled pair over the account's
// chosen name -- unprovable in every lobby, refused for 24 hours by the
// once-a-day gate, and the uniqueness key left reserved to an account that no
// longer showed it.
//
// The fix is a guard the database applies, not one this client decides, so what
// is pinned here is the SHAPE OF THE REQUESTS: no `callsign` in the upsert, and
// the name in its own write filtered on `callsign_key=is.null`.
//
// Headless, like test/account.mjs and test/apple_native.mjs: cloud.js is a
// browser classic script evaluated against stub globals with a recording fetch.
// No server, no network, no Supabase.
import fs from 'node:fs';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const SRC = fs.readFileSync(new URL('../public/cloud.js', import.meta.url), 'utf8');
const SB = 'https://proj.supabase.co';
const UID = '11111111-1111-4111-8111-111111111111';

function mkStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
// `answer` decides the reply per call, so a suite can make ONE of the two writes
// fail and watch what the other does.
function load(answer) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const call = { url, method: opts.method || 'GET', prefer: (opts.headers || {}).Prefer || '', body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    const r = answer(call, calls.length - 1) || {};
    const status = r.status || 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (r.text === undefined ? '' : r.text), json: async () => r.json };
  };
  const window = { CC_SUPABASE_URL: SB, CC_SUPABASE_KEY: 'pk_test', CC_NATIVE_HOST: 'tanks.abarabrothers.com' };
  const local = mkStore(), sess = mkStore();
  window.localStorage = local; window.sessionStorage = sess;
  local.setItem('cc_session', JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600, user_id: UID }));
  const location = { origin: 'https://tanks.abarabrothers.com', href: '', hash: '', pathname: '/', search: '' };
  const fn = new Function('window', 'location', 'history', 'localStorage', 'sessionStorage', 'fetch', SRC);
  fn(window, location, { replaceState: () => {} }, local, sess, fetch);
  return { Cloud: window.Cloud, calls };
}
const rest = (calls) => calls.filter((c) => c.url.includes('/rest/v1/'));
const path = (c) => c.url.slice((SB + '/rest/v1').length);

// 1. THE UPSERT NO LONGER CARRIES A NAME. This is the whole defect: a key
//    present in a merge-duplicates body IS written, so `callsign: null` would
//    have nulled the column just as surely as a rolled pair overwrote it.
//    Omission is the only way to leave it alone.
{
  const b = load(() => ({ status: 204 }));
  const okr = await b.Cloud.save('Steel Mesa', { career: { wins: 1 } });
  const up = rest(b.calls)[0];
  if (okr === true) ok('save() reports success'); else fail('save() returned ' + JSON.stringify(okr));
  if (up && up.method === 'POST' && path(up) === '/profiles?on_conflict=id') ok('the upsert is the first write, at the same path as before');
  else fail('upsert: ' + JSON.stringify(up && [up.method, up && path(up)]));
  if (up && up.body && !('callsign' in up.body)) ok('the upsert body carries NO `callsign` key at all — not the name, and not a null');
  else fail('upsert body still names callsign: ' + JSON.stringify(up && up.body));
  if (up && up.body && up.body.id === UID && up.body.progression_version === 1 && up.body.progression) ok('the upsert still carries id, progression and progression_version');
  else fail('upsert body: ' + JSON.stringify(up && up.body));
}
// 2. THE NAME GOES UP GUARDED, IN THE DATABASE. Only the database knows at the
//    instant of the write whether the account holds a chosen name; every
//    client-side answer can be hours stale.
{
  const b = load(() => ({ status: 204 }));
  await b.Cloud.save('Steel Mesa', {});
  const w = rest(b.calls)[1];
  if (w && w.method === 'PATCH' && path(w) === `/profiles?id=eq.${UID}&callsign_key=is.null`)
    ok('the display name is a second, separate PATCH filtered on callsign_key=is.null');
  else fail('name write: ' + JSON.stringify(w && [w.method, path(w)]));
  if (w && w.body && w.body.callsign === 'Steel Mesa' && Object.keys(w.body).length === 1)
    ok('the name write sets `callsign` and nothing else');
  else fail('name body: ' + JSON.stringify(w && w.body));
  if (rest(b.calls).length === 2) ok('two writes, no read — save() still asks the database nothing');
  else fail('rest calls: ' + JSON.stringify(rest(b.calls).map(path)));
}
// 3. NO NAME, NO WRITE. savedName() is '' before boot() has rolled one, and an
//    empty string must not reach the column.
for (const empty of [null, '', undefined]) {
  const b = load(() => ({ status: 204 }));
  await b.Cloud.save(empty, {});
  if (rest(b.calls).length === 1) ok(`a ${JSON.stringify(empty)} name writes the progression only`);
  else fail(`${JSON.stringify(empty)} produced ${rest(b.calls).length} writes: ` + JSON.stringify(rest(b.calls).map(path)));
}
// 4. THE UNAPPLIED MIGRATION. A filter on a column that does not exist answers
//    400 (PostgREST 42703). No column means no account can hold a chosen
//    callsign either, so the unguarded write is exactly what shipped before and
//    can void nothing — and the rolled name must keep syncing in that window,
//    because it is the only name there is until the migration lands.
{
  const b = load((c) => (c.url.includes('callsign_key=is.null') ? { status: 400, text: '{"code":"42703"}' } : { status: 204 }));
  const okr = await b.Cloud.save('Steel Mesa', {});
  const w = rest(b.calls);
  if (w.length === 3 && path(w[2]) === `/profiles?id=eq.${UID}` && w[2].method === 'PATCH' && w[2].body.callsign === 'Steel Mesa')
    ok('a 400 on the guarded write falls back to the unguarded one — the pre-migration behaviour, exactly');
  else fail('no fallback: ' + JSON.stringify(w.map((c) => [c.method, path(c)])));
  if (okr === true) ok('and the save still reports success');
  else fail('save() returned ' + JSON.stringify(okr));
}
// 5. AND ONLY ON A 400. A 500, a 429 or a timeout is an ordinary failure of a
//    write that would have been guarded; retrying it WITHOUT the guard would
//    reintroduce the entire defect on any upstream wobble.
for (const status of [401, 403, 404, 429, 500, 503]) {
  const b = load((c) => (c.url.includes('callsign_key=is.null') ? { status } : { status: 204 }));
  const okr = await b.Cloud.save('Steel Mesa', {});
  const w = rest(b.calls);
  if (w.length === 2 && okr === true) ok(`a ${status} on the guarded write is left alone — no unguarded retry, and the save still succeeds`);
  else fail(`${status}: ${JSON.stringify(w.map((c) => [c.method, path(c)]))} returned ${JSON.stringify(okr)}`);
}
// 6. A FAILED NAME IS NOT A FAILED SAVE. cloudDirty exists for progression; a
//    name that did not land is retried by the next save like any other, and
//    leaving the dirty flag set for it would re-push the whole profile for ever.
{
  const b = load((c) => (c.method === 'PATCH' ? { status: 500 } : { status: 204 }));
  if ((await b.Cloud.save('Steel Mesa', {})) === true) ok('the name write cannot fail the save');
  else fail('a failed name write reported the save as failed');
}
// 7. AND THE UPSERT STILL CAN. A progression write that failed must keep the
//    dirty flag set, or the next boot is the first thing that heals it.
{
  const b = load((c) => (c.method === 'POST' ? { status: 500 } : { status: 204 }));
  if ((await b.Cloud.save('Steel Mesa', {})) === false) ok('a failed upsert still reports failure, so cloudDirty stays set');
  else fail('a failed upsert reported success');
}
// 8. restore() IS UNTOUCHED, and must stay that way: it is the progression sync
//    on every boot. It must NOT start naming a phase 6 column — a 400 there
//    would be caught and answered null, silently turning the cloud merge off
//    for every player in the window before the migration is applied.
{
  const b = load(() => ({ status: 200, text: JSON.stringify([{ callsign: 'Steel Mesa', progression: { career: {} }, progression_version: 1 }]) }));
  const row = await b.Cloud.restore();
  const r = rest(b.calls)[0];
  if (r && r.method === 'GET' && path(r) === `/profiles?id=eq.${UID}&select=callsign,progression,progression_version`)
    ok('restore() reads the same three columns it always has, and no phase 6 column');
  else fail('restore path: ' + JSON.stringify(r && [r.method, path(r)]));
  if (row && row.callsign === 'Steel Mesa') ok('restore() still returns the row'); else fail('restore row: ' + JSON.stringify(row));
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall cloud save checks passed');
process.exit(out.errors.length ? 1 : 0);
