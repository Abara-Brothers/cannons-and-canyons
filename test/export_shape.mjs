// The account data export's SHAPE. Nothing tested it before this file, and
// public/privacy.html lists its contents field by field — so a renamed or
// dropped key silently turns a privacy statement into a false one, and the only
// person who would ever notice is the person it was wrong for.
//
// WHY NOT test/account.mjs: that suite evaluates public/cloud.js, a
// self-contained classic script, against stub globals. exportMyData() lives in
// public/app.js, which wires DOM handlers at top level (the accExportBtn
// onclick, immediately above the function) and throws on load under Node. So
// this suite lifts the ONE function out of the source by brace-matching and
// runs that — the shipped code, not a copy of it.
import { readFileSync } from 'node:fs';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const HEAD = 'async function exportMyData() {';
const at = SRC.indexOf(HEAD);
if (at < 0) { fail('exportMyData() not found in public/app.js — renamed, or no longer a plain async function'); console.log('\n1 FAILED'); process.exit(1); }
let depth = 0, end = -1;
for (let i = at + HEAD.length - 1; i < SRC.length; i++) {
  const c = SRC[i];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
}
if (end < 0) { fail('exportMyData() body never closes — the brace scan ran off the end of app.js'); console.log('\n1 FAILED'); process.exit(1); }
const BODY = SRC.slice(at + HEAD.length, end);

// Run the real body with every browser thing it touches stubbed, and catch the
// JSON on its way into the Blob -- or, on a phone (IS_NATIVE), on its way into
// the panel bay.js draws it in (window.Bay.showData). Everything the player
// would see or get is recorded: Blobs made, links clicked, toasts said.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('Cloud', 'savedName', 'progressionSnapshot', 'Blob', 'document', 'URL', 'setTimeout', 'showToast', 'window', 'IS_NATIVE', BODY);

async function exportRun({ social, blocked, name = 'Iron Hare', who = { anonymous: false, google: true, apple: false, email: 'a@b.c' }, native = false, bay = true }) {
  const seen = { text: null, blobs: 0, clicks: [], toasts: [], shown: [] };
  class StubBlob { constructor(parts) { seen.blobs++; seen.text = parts.join(''); } }
  const doc = { createElement: () => { const a = { click() { seen.clicks.push(a.download); }, remove() {} }; return a; }, body: { appendChild() {} } };
  const url = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
  const Cloud = { restore: async () => ({ callsign: name, wins: 7 }), whoami: async () => who, userId: () => 'u-1111' };
  const win = {};
  if (social !== undefined) win.CC_SOCIAL = social;   // absent = a player who never opened Friends
  if (blocked !== undefined) win.CC_SOCIAL_BLOCKED = blocked;  // bay.js's guest-only blocked-list size
  if (bay) win.Bay = { showData: (t) => { seen.shown.push(t); } };
  await run(Cloud, () => name, () => ({ career: { wins: 7 } }), StubBlob, doc, url, () => {}, (m) => { seen.toasts.push(m); }, win, native);
  return seen;
}
async function exportWith(opts) {
  const seen = await exportRun(opts);
  if (seen.text === null) throw new Error('nothing reached the Blob — the download path changed');
  return JSON.parse(seen.text);
}

const SNAP = { friends: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], requests: { in: [], out: [] }, blocked: [{ id: 'z' }], friendCode: 'K7M2QP', callsign: 'Iron Hare' };
const KEYS = ['exported_at', 'account_id', 'account_type', 'sign_in', 'callsign', 'friend_code', 'friends_count', 'blocked_count', 'cloud_profile', 'local_progression', 'not_included'];

// 1. the whole shape, in order — privacy.html names these one by one
{
  const d = await exportWith({ social: SNAP });
  const got = Object.keys(d);
  if (JSON.stringify(got) === JSON.stringify(KEYS)) ok('export has exactly the documented keys, in order');
  else fail('export keys drifted from the privacy policy:\n      want ' + KEYS.join(', ') + '\n      got  ' + got.join(', '));
}
// 2. the three new fields come off the snapshot, in the form the player sees
{
  const d = await exportWith({ social: SNAP });
  if (d.friend_code === 'FR-K7M2QP') ok('friend_code is the displayed form, FR- + code');
  else fail('friend_code: ' + JSON.stringify(d.friend_code) + ' (want "FR-K7M2QP")');
  if (d.friends_count === 3) ok('friends_count counts the snapshot'); else fail('friends_count: ' + JSON.stringify(d.friends_count));
  if (d.blocked_count === 1) ok('blocked_count counts the snapshot'); else fail('blocked_count: ' + JSON.stringify(d.blocked_count));
}
// 3. no snapshot yet (offline, a guest, or Friends never opened): the keys still
//    exist and read null. A key that comes and goes makes the file's shape depend
//    on timing, and an export that sometimes omits a field is only ever noticed by
//    the person it was wrong for.
{
  const d = await exportWith({ social: undefined });
  const bad = ['friend_code', 'friends_count', 'blocked_count'].filter((k) => !(k in d) || d[k] !== null);
  if (!bad.length) ok('no snapshot: friend_code / friends_count / blocked_count present and null');
  else fail('without a snapshot these are missing or not null: ' + bad.join(', '));
}
// 4. a half-built snapshot must not throw — the download is a rights mechanism,
//    and a throw here is a refusal of a GDPR request that nobody logs
{
  const d = await exportWith({ social: { friendCode: null } });
  if (d.friends_count === null && d.blocked_count === null && d.friend_code === null) ok('half-built snapshot: nulls, no throw');
  else fail('half-built snapshot produced ' + JSON.stringify({ c: d.friend_code, f: d.friends_count, b: d.blocked_count }));
}
// 4b. A GUEST'S BLOCKED LIST IS REAL, LOADED, AND ON SCREEN. `friends` is
//    refused to a guest (requireLinked), so CC_SOCIAL is null for them for ever
//    and blocked_count could never be anything but null -- while the Friends
//    screen was drawing the list, and while the file's own null_counts sentence
//    told them the device had not loaded it. bay.js owns that read (block
//    op:'list') and publishes its size; friends_count and friend_code stay null,
//    which for a guest is the truth.
{
  const guest = { anonymous: true, google: false, apple: false, email: null };
  const d = await exportWith({ social: undefined, blocked: 2, who: guest });
  if (d.account_type === 'guest' && d.blocked_count === 2 && d.friends_count === null && d.friend_code === null)
    ok('a guest exports the blocked list they can see, and nulls for what they genuinely do not have');
  else fail('guest export: ' + JSON.stringify({ t: d.account_type, b: d.blocked_count, f: d.friends_count, c: d.friend_code }));
}
// 4c. and a snapshot still wins: a linked account counts its own list, never a
//    stale number left behind by a guest session on the same device.
{
  const d = await exportWith({ social: SNAP, blocked: 99 });
  if (d.blocked_count === 1) ok('with a snapshot in hand blocked_count comes from it, not from the guest slot');
  else fail('snapshot precedence: ' + JSON.stringify(d.blocked_count));
}
// 5. the new fields cost NO read — they come off a snapshot already in memory
{
  if (/\bfetch\s*\(/.test(BODY) || /\/rest\/v1\//.test(BODY)) fail('exportMyData() now performs its own request — the social fields must come from window.CC_SOCIAL, not a fresh read');
  else ok('exportMyData() issues no request of its own');
}
// 6. the honesty clauses privacy.html points at are still in the file.
//    null_counts is not decoration: a null count and a zero count are three
//    characters apart and mean opposite things — "you have no friends" versus
//    "this device had not loaded them when you pressed the button" — and a
//    player may attach this file to a data request. Check 3 pins the null; this
//    pins the sentence that tells the reader what the null means.
{
  const d = await exportWith({ social: SNAP });
  const ni = d.not_included || {};
  if (ni.push_subscriptions && ni.crash_reports && ni.friends_list && ni.null_counts) {
    ok('not_included names push subscriptions, crash reports, the friends list, and what a null count means');
  } else {
    fail('not_included is missing an entry: ' + JSON.stringify(Object.keys(ni)));
  }
}

// 7. ON THE WEB, A DOWNLOAD, AS ALWAYS: one Blob, one click on a link that
//    saves cannons-and-canyons-data.json, then "Data downloaded", and the panel
//    is never asked for.
{
  const w = await exportRun({ social: SNAP });
  if (w.blobs === 1 && JSON.stringify(w.clicks) === JSON.stringify(['cannons-and-canyons-data.json']) && JSON.stringify(w.toasts) === JSON.stringify(['Data downloaded']) && !w.shown.length)
    ok('web: the file is saved through one link and the toast says "Data downloaded" (unchanged)');
  else fail('web export: ' + JSON.stringify({ blobs: w.blobs, clicks: w.clicks, toasts: w.toasts, shown: w.shown.length }));
}
// 8. IN THE APP NOTHING CAN BE DOWNLOADED (round 2 review, 2026-10-08): the
//    iOS WebView hands a blob: link to the system, which opens nothing, and the
//    Android shell has no download handler, yet the toast said "Data
//    downloaded". On a phone the SAME text goes to the panel (bay.js showData):
//    no Blob, no link, and nothing that says a file was downloaded.
{
  const w = await exportRun({ social: SNAP });
  const n = await exportRun({ social: SNAP, native: true });
  const strip = (t) => { const d = JSON.parse(t); delete d.exported_at; return JSON.stringify(d); };
  let same = false, keys = [];
  try { keys = Object.keys(JSON.parse(n.shown[0])); same = strip(n.shown[0]) === strip(w.text) && n.shown[0] === JSON.stringify(JSON.parse(n.shown[0]), null, 2); } catch {}
  if (n.shown.length === 1 && same && JSON.stringify(keys) === JSON.stringify(KEYS))
    ok('in the app: the panel is handed the very JSON the web saves, with every documented key, laid out the same');
  else fail('native export text: ' + JSON.stringify({ shown: n.shown.length, same, keys }));
  if (n.blobs === 0 && n.clicks.length === 0 && n.toasts.length === 0)
    ok('in the app: no Blob, no download link clicked, and no toast claims a download');
  else fail('native export side effects: ' + JSON.stringify({ blobs: n.blobs, clicks: n.clicks, toasts: n.toasts }));
  // bay.js not there to draw it: still no download and no claim of one.
  const x = await exportRun({ social: SNAP, native: true, bay: false });
  if (x.blobs === 0 && x.clicks.length === 0 && JSON.stringify(x.toasts) === JSON.stringify(['Your data could not be shown. Try again.']))
    ok('in the app without the panel: no download, and the toast says the data could not be shown');
  else fail('native export without Bay: ' + JSON.stringify({ blobs: x.blobs, clicks: x.clicks, toasts: x.toasts }));
  if (![...n.toasts, ...x.toasts].some((t) => /download|saved/i.test(t))) ok('in the app no toast says downloaded or saved');
  else fail('a native toast claims a download: ' + JSON.stringify([...n.toasts, ...x.toasts]));
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall export checks passed');
process.exit(out.errors.length ? 1 : 0);
