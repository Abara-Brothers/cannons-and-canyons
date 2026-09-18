// server/store.js against a recording fake sbAdmin: the exact PostgREST path of
// every method, the uuid gate, the friendship pair ordering, the unique-violation
// to 'taken' translation, and the friend-code retry. No server, no network, no
// Supabase — the fake records (method, path, body, prefer) and returns canned rows.
//
// WHY THIS EXISTS: every path in the store splices a value that arrived on a socket
// into a query string. server.js's one unencoded interpolation (/profiles?id=in.(…)
// at ~line 961) is safe only because its ids come out of a uuid[] COLUMN; these come
// from a client frame. Check (l) at the bottom walks every path this suite produced
// and refuses a raw space or quote in any value, so a method added later that forgets
// encodeURIComponent cannot ship quietly.
import {
  createStore, isUuid, FRIEND_CODE_ALPHABET, FRIEND_CODE_LEN, FRIEND_CODE_TRIES,
} from '../server/store.js';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const A = '00000000-0000-4000-8000-00000000000a';   // sorts first
const B = 'ffffffff-0000-4000-8000-00000000000b';   // sorts last
const C = '7777aaaa-0000-4000-8000-00000000000c';   // sorts between
const COLS = 'id,callsign,friend_code,callsign_key,callsign_set_at';

const ALL = [];                                     // every call any case made
// routes: [RegExp tested against `METHOD path`, rows | Error | (nth) => rows|Error]
function mkSb(routes = []) {
  const calls = [];
  const sb = async (method, path, body, prefer) => {
    const rec = { method, path, body, prefer };
    calls.push(rec); ALL.push(rec);
    for (const [re, reply] of routes) {
      if (re.test(method + ' ' + path)) {
        const v = typeof reply === 'function' ? reply(calls.length) : reply;
        if (v instanceof Error) throw v;
        return v;
      }
    }
    return [];
  };
  return { sb, calls, store: createStore({ sbAdmin: sb }) };
}

// ---- (a) the injection guard -------------------------------------------------
{
  let threw = null;
  try { createStore({}); } catch (e) { threw = e; }
  if (threw instanceof TypeError) ok('(a) createStore rejects a missing sbAdmin');
  else fail('(a) createStore({}) threw: ' + threw);
  if (isUuid(A) && !isUuid('../rpc/drop') && !isUuid(null)) ok('(a) isUuid is exported and gates non-uuids');
  else fail('(a) isUuid: ' + [isUuid(A), isUuid('../rpc/drop'), isUuid(null)].join(','));
}

// ---- (b) profileById ---------------------------------------------------------
{
  const h = mkSb([[/^GET \/profiles\?id=eq\./, [{ id: A, callsign: 'Ghost', friend_code: 'ABC234', callsign_key: 'ghost', callsign_set_at: null }]]]);
  const p = await h.store.profileById(A.toUpperCase());
  const want = `/profiles?id=eq.${A}&select=${COLS}&limit=1`;
  if (h.calls.length === 1 && h.calls[0].method === 'GET' && h.calls[0].path === want) ok('(b) profileById path exact, and an upper-case id is lowered');
  else fail('(b) profileById path: ' + JSON.stringify(h.calls.map((c) => c.method + ' ' + c.path)));
  if (p && p.callsign === 'Ghost' && p.friend_code === 'ABC234') ok('(b) profileById returns the row');
  else fail('(b) profileById row: ' + JSON.stringify(p));

  const h2 = mkSb();
  let threw = null;
  try { await h2.store.profileById('../rpc/drop'); } catch (e) { threw = e; }
  if (threw && threw.message === 'bad uuid' && h2.calls.length === 0) ok('(b) a non-uuid id throws before any call is made');
  else fail('(b) non-uuid id: ' + (threw && threw.message) + ' calls=' + h2.calls.length);

  const h3 = mkSb([[/^GET/, []]]);
  if ((await h3.store.profileById(A)) === null) ok('(b) no row -> null'); else fail('(b) empty rows did not become null');
}

// ---- (c) the two lookups that take opaque user text --------------------------
{
  const h = mkSb([[/^GET/, [{ id: B, callsign: 'Ghost Rider' }]]]);
  await h.store.profileByFriendCode('fr-abc234');
  if (h.calls[0].path === `/profiles?friend_code=eq.ABC234&select=${COLS}&limit=1`) ok('(c) profileByFriendCode trims, upper-cases and strips an FR- prefix');
  else fail('(c) friend-code path: ' + h.calls[0].path);

  const h2 = mkSb();
  const r1 = await h2.store.profileByFriendCode('AB&CD1');
  const r2 = await h2.store.profileByCallsignKey('a&b=1');
  if (r1 === null && r2 === null && h2.calls.length === 0) ok('(c) a code or key outside the allowed characters is null with NO query at all');
  else fail('(c) hostile lookups made ' + h2.calls.length + ' calls: ' + JSON.stringify([r1, r2]));

  const h3 = mkSb([[/^GET/, [{ id: C, callsign: 'Ghost Rider' }]]]);
  await h3.store.profileByCallsignKey('ghost rider');
  if (h3.calls[0].path === `/profiles?callsign_key=eq.ghost%20rider&select=${COLS}&limit=1`) ok('(c) the space in a callsign key is percent-encoded');
  else fail('(c) callsign-key path: ' + h3.calls[0].path);

  // BINDING.md resolution 21 admits combining marks into a callsign on purpose, so
  // that Devanagari, Thai, Arabic and pointed Hebrew names are legal rather than a
  // 'chars' error. server/callsign.js agrees: validateCallsign('हिन्दी') answers
  // { ok:true, key:'हिन्दी' }, and that key carries U+093F and U+0940 (Mc) and
  // U+094D (Mn). A key class of letters and digits alone would therefore let a
  // player SET such a name and then never FIND it — profileByCallsignKey would
  // answer null with no query issued and nothing logged, and a friend search for a
  // real player would report no such player. The lookup class must stay in step
  // with the callsign TOKEN it is reading back.
  const DEVANAGARI = 'हिन्दी';
  const h4 = mkSb([[/^GET/, [{ id: C, callsign: DEVANAGARI }]]]);
  const found = await h4.store.profileByCallsignKey(DEVANAGARI);
  if (h4.calls.length === 1 && found
    && h4.calls[0].path === `/profiles?callsign_key=eq.${encodeURIComponent(DEVANAGARI)}&select=${COLS}&limit=1`) ok('(c) a key carrying combining marks is looked up, not silently dropped (BINDING resolution 21)');
  else fail('(c) combining-mark key made ' + h4.calls.length + ' calls: ' + JSON.stringify(h4.calls.map((c) => c.path)));
}

// ---- (d) profilesByIds: the one method whose ids come straight off a socket ---
{
  const h = mkSb([[/^GET/, [{ id: A, callsign: 'One' }, { id: C, callsign: 'Three' }]]]);
  const m = await h.store.profilesByIds([A, 'not-a-uuid', C, A]);
  const want = `/profiles?id=in.(${A},${C})&select=id,callsign`;
  if (h.calls.length === 1 && h.calls[0].path === want) ok('(d) profilesByIds drops a junk id, collapses the duplicate, one exact path');
  else fail('(d) profilesByIds path: ' + JSON.stringify(h.calls.map((c) => c.path)));
  if (m instanceof Map && m.size === 2 && m.get(A).callsign === 'One' && m.get(C).id === C) ok('(d) profilesByIds returns a Map keyed by id');
  else fail('(d) profilesByIds map: ' + JSON.stringify([...(m || [])]));

  const h2 = mkSb();
  const m2 = await h2.store.profilesByIds(['x', 12, null, undefined]);
  if (m2.size === 0 && h2.calls.length === 0) ok('(d) an all-junk list makes no query at all');
  else fail('(d) all-junk list made ' + h2.calls.length + ' calls');

  const many = Array.from({ length: 120 }, (_, i) => '0000' + String(i).padStart(4, '0') + '-0000-4000-8000-00000000000a');
  const h3 = mkSb([[/^GET/, []]]);
  await h3.store.profilesByIds(many);
  if (h3.calls.length === 2) ok('(d) 120 ids go out in two calls of at most 100, so the query string stays bounded');
  else fail('(d) 120 ids produced ' + h3.calls.length + ' calls');
}

// ---- (e) setChosenCallsign: the write is the authority ------------------------
{
  const h = mkSb([[/^PATCH/, [{ id: A }]]]);
  const r = await h.store.setChosenCallsign(A, 'Ghost Rider', 'ghost rider');
  const c = h.calls[0];
  if (h.calls.length === 1 && c.method === 'PATCH' && c.path === `/profiles?id=eq.${A}` && c.prefer === 'return=representation') ok('(e) setChosenCallsign: ONE write, no pre-check read, exact path, return=representation');
  else fail('(e) setChosenCallsign call: ' + JSON.stringify(h.calls));
  if (r.ok === true && c.body.callsign === 'Ghost Rider' && c.body.callsign_key === 'ghost rider' && typeof c.body.callsign_set_at === 'string') ok('(e) it writes callsign, callsign_key and callsign_set_at together');
  else fail('(e) body/result: ' + JSON.stringify(c.body) + ' -> ' + JSON.stringify(r));

  const h2 = mkSb([[/^PATCH/, new Error('sb PATCH 409')]]);
  // GUARDED ON PURPOSE. If the conflict translation regresses, the 409 comes back
  // out as a rejection; an unguarded `await` here would be an unhandled rejection
  // that kills the process on the spot, so the suite would report a stack trace
  // instead of a named check and every assertion after this one would be hidden.
  // Catching turns that regression into this suite's own FAIL line.
  let taken = null;
  try { taken = await h2.store.setChosenCallsign(A, 'Ghost', 'ghost'); } catch (e) { taken = 'threw ' + e.message; }
  if (same(taken, { ok: false, error: 'taken' })) ok('(e) a 409 from the unique index reads as taken');
  else fail('(e) a 409 did not become taken: ' + JSON.stringify(taken));

  const h3 = mkSb([[/^PATCH/, new Error('sb PATCH 500')]]);
  let t3 = null; try { await h3.store.setChosenCallsign(A, 'Ghost', 'ghost'); } catch (e) { t3 = e; }
  if (t3 && t3.message === 'sb PATCH 500') ok('(e) a 500 propagates — an outage is never reported to the player as taken');
  else fail('(e) a 500 became: ' + JSON.stringify(t3 && t3.message));

  const h4 = mkSb([[/^PATCH/, []]]);
  let t4 = null; try { await h4.store.setChosenCallsign(A, 'Ghost', 'ghost'); } catch (e) { t4 = e; }
  if (t4 && /0 rows/.test(t4.message)) ok('(e) a PATCH that matched no row is a failure, not a silent success');
  else fail('(e) zero-row PATCH: ' + JSON.stringify(t4 && t4.message));

  const h5 = mkSb([[/^PATCH/, [{ id: A }]]]);
  await h5.store.clearCallsignKey(A);
  if (h5.calls[0].path === `/profiles?id=eq.${A}` && same(h5.calls[0].body, { callsign_key: null })) ok('(e) clearCallsignKey nulls the key ONLY — callsign_set_at survives, so a roll is not a fresh daily allowance');
  else fail('(e) clearCallsignKey: ' + JSON.stringify(h5.calls[0]));
}

// ---- (f) ensureFriendCode -----------------------------------------------------
{
  const h = mkSb([[/^GET/, [{ friend_code: 'ABC234' }]]]);
  const c1 = await h.store.ensureFriendCode(A);
  if (c1 === 'ABC234' && h.calls.length === 1 && h.calls[0].method === 'GET') ok('(f) an existing friend code is returned with no write at all');
  else fail('(f) existing code: ' + c1 + ' calls=' + JSON.stringify(h.calls.map((c) => c.method)));

  const h2 = mkSb([[/^GET/, [{ friend_code: null }]], [/^PATCH/, [{ id: A }]]]);
  const c2 = await h2.store.ensureFriendCode(A);
  const patch = h2.calls.find((c) => c.method === 'PATCH');
  if (patch && patch.path === `/profiles?id=eq.${A}&friend_code=is.null`) ok('(f) the write is guarded by friend_code=is.null, so a second socket for the same player loses harmlessly');
  else fail('(f) patch path: ' + JSON.stringify(patch && patch.path));
  if (c2.length === FRIEND_CODE_LEN && [...c2].every((ch) => FRIEND_CODE_ALPHABET.includes(ch))) ok('(f) the code is 6 characters from the no-I-L-O-0-1 alphabet');
  else fail('(f) code shape: ' + JSON.stringify(c2));

  let n = 0;
  const h3 = mkSb([[/^GET/, [{ friend_code: null }]], [/^PATCH/, () => { n++; return n <= 2 ? new Error('sb PATCH 409') : [{ id: A }]; }]]);
  // Guarded for the same reason as (e)'s 409: if a collision stops being read as a
  // collision, ensureFriendCode rethrows and an unguarded await would end the run
  // here rather than report which check failed.
  let c3 = null;
  try { c3 = await h3.store.ensureFriendCode(A); } catch (e) { c3 = 'threw ' + e.message; }
  const tried = h3.calls.filter((c) => c.method === 'PATCH').map((c) => c.body.friend_code);
  if (tried.length === 3 && new Set(tried).size === 3 && c3 === tried[2]) ok('(f) two collisions retry with a FRESH code each time and the third wins');
  else fail('(f) retry: ' + JSON.stringify(tried) + ' -> ' + c3);

  const h4 = mkSb([[/^GET/, [{ friend_code: null }]], [/^PATCH/, new Error('sb PATCH 409')]]);
  let t4 = null; try { await h4.store.ensureFriendCode(A); } catch (e) { t4 = e; }
  const patches = h4.calls.filter((c) => c.method === 'PATCH').length;
  if (t4 && t4.message === 'friend code exhausted' && patches === FRIEND_CODE_TRIES) ok(`(f) ${FRIEND_CODE_TRIES} collisions in a row throw rather than loop for ever`);
  else fail('(f) exhaustion: ' + (t4 && t4.message) + ' patches=' + patches);

  const h5 = mkSb([[/^GET/, [{ friend_code: null }]], [/^PATCH/, new Error('sb PATCH 503')]]);
  let t5 = null; try { await h5.store.ensureFriendCode(A); } catch (e) { t5 = e; }
  if (t5 && t5.message === 'sb PATCH 503' && h5.calls.filter((c) => c.method === 'PATCH').length === 1) ok('(f) a 503 stops at once instead of burning eight codes against a dead database');
  else fail('(f) 503: ' + (t5 && t5.message) + ' patches=' + h5.calls.filter((c) => c.method === 'PATCH').length);

  const h6 = mkSb([[/^GET/, []], [/^POST/, null]]);
  const c6 = await h6.store.ensureFriendCode(A);
  const post = h6.calls.find((c) => c.method === 'POST');
  if (post && post.path === '/profiles' && post.body.id === A && post.body.friend_code === c6) ok('(f) a signed-in player with no profiles row gets one, with a code');
  else fail('(f) insert: ' + JSON.stringify(post));
}

// ---- (g) friendships: one row per pair, user_a < user_b ----------------------
{
  const h = mkSb([[/^GET \/friendships/, [{ user_a: A, user_b: B }, { user_a: C, user_b: A }]]]);
  const ids = await h.store.friendIdsOf(A);
  if (h.calls[0].path === `/friendships?or=(user_a.eq.${A},user_b.eq.${A})&select=user_a,user_b`) ok('(g) friendIdsOf path exact');
  else fail('(g) friendIdsOf path: ' + h.calls[0].path);
  if (same(ids, [B, C])) ok('(g) friendIdsOf returns the OTHER side of each row, whichever column it sits in');
  else fail('(g) friendIdsOf: ' + JSON.stringify(ids));

  const h2 = mkSb();
  await h2.store.addFriendship(B, A);
  if (h2.calls[0].path === '/friendships' && same(h2.calls[0].body, { user_a: A, user_b: B })
    && h2.calls[0].prefer === 'return=minimal,resolution=ignore-duplicates') ok('(g) addFriendship stores the LOW uuid in user_a whichever way round it is called, and is idempotent');
  else fail('(g) addFriendship: ' + JSON.stringify(h2.calls[0]));

  const h3 = mkSb();
  await h3.store.removeFriendship(B, A.toUpperCase());
  if (h3.calls[0].path === `/friendships?user_a=eq.${A}&user_b=eq.${B}`) ok('(g) removeFriendship filters on the same ordered pair, lower-cased');
  else fail('(g) removeFriendship path: ' + h3.calls[0].path);

  const h4 = mkSb();
  let t4 = null; try { await h4.store.addFriendship(A, A); } catch (e) { t4 = e; }
  if (t4 && t4.message === 'pair self' && h4.calls.length === 0) ok('(g) a self-pair never reaches the table (the CHECK would reject it at 3 a.m. instead)');
  else fail('(g) self-pair: ' + (t4 && t4.message) + ' calls=' + h4.calls.length);
}

// ---- (h) requests: two directions, a 30-day floor, a sweep that may fail ------
{
  const h = mkSb([
    [/to_user=eq\./, [{ from_user: B }]],
    [/from_user=eq\./, [{ to_user: C }]],
    [/^DELETE/, new Error('sb DELETE 500')],
  ]);
  // Guarded for the same reason as (e) and (f): the whole point of this case is
  // that the sweep's failure must NOT escape, so the regression under test is
  // exactly a rejection coming out of here. Unguarded, that would be an unhandled
  // rejection that ends the run; caught, it is a FAIL line naming this check.
  let r = null;
  try { r = await h.store.requestsOf(A); } catch (e) { r = 'threw ' + e.message; }
  if (same(r, { incoming: [B], outgoing: [C] })) ok('(h) requestsOf splits the two directions AND answered although the sweep threw — housekeeping never fails the panel');
  else fail('(h) requestsOf: ' + JSON.stringify(r));
  const paths = h.calls.map((c) => c.method + ' ' + c.path);
  if (paths[0].startsWith(`GET /friend_requests?to_user=eq.${A}&created_at=gte.`) && paths[0].endsWith('&select=from_user')) ok('(h) the incoming read is bounded by created_at=gte.<cutoff>');
  else fail('(h) incoming path: ' + paths[0]);
  if (paths[1].startsWith(`GET /friend_requests?from_user=eq.${A}&created_at=gte.`) && paths[1].endsWith('&select=to_user')) ok('(h) the outgoing read is bounded the same way');
  else fail('(h) outgoing path: ' + paths[1]);
  const m = paths[0].match(/created_at=gte\.([^&]+)/);
  const age = Date.now() - Date.parse(decodeURIComponent(m[1]));
  if (Math.abs(age - 30 * 24 * 3600 * 1000) < 60000) ok('(h) the cutoff really is 30 days old');
  else fail('(h) cutoff age ms: ' + age);
  if (paths[2] && paths[2].startsWith('DELETE /friend_requests?created_at=lt.')) ok('(h) the stale sweep runs on read, as section 3.2 requires');
  else fail('(h) sweep: ' + paths[2]);

  const h2 = mkSb();
  await h2.store.addRequest(B, A);
  await h2.store.deleteRequest(B, A);
  if (h2.calls[0].path === '/friend_requests?on_conflict=from_user,to_user' && same(h2.calls[0].body, { from_user: B, to_user: A })) ok('(h) addRequest keeps its direction and names the unique constraint, because the PK here is the identity column');
  else fail('(h) addRequest: ' + JSON.stringify(h2.calls[0]));
  if (h2.calls[1].path === `/friend_requests?from_user=eq.${B}&to_user=eq.${A}`) ok('(h) deleteRequest path exact');
  else fail('(h) deleteRequest path: ' + h2.calls[1].path);
}

// ---- (i) blocks: direction is the whole point, never reordered ----------------
{
  const h = mkSb([[/blocker=eq\./, [{ blocked: B }]], [/blocked=eq\./, [{ blocker: C }]]]);
  const b = await h.store.blockIdsOf(A);
  if (same(b, { blocked: [B], blockedBy: [C] })) ok('(i) blockIdsOf reports both directions separately');
  else fail('(i) blockIdsOf: ' + JSON.stringify(b));
  if (h.calls[0].path === `/blocks?blocker=eq.${A}&select=blocked` && h.calls[1].path === `/blocks?blocked=eq.${A}&select=blocker`) ok('(i) both block read paths exact');
  else fail('(i) block paths: ' + JSON.stringify(h.calls.map((c) => c.path)));

  const h2 = mkSb();
  await h2.store.addBlock(B, A);
  await h2.store.removeBlock(B, A);
  if (same(h2.calls[0].body, { blocker: B, blocked: A }) && h2.calls[1].path === `/blocks?blocker=eq.${B}&blocked=eq.${A}`) ok('(i) a block is NOT sorted into pair order — who blocked whom is the record');
  else fail('(i) block writes: ' + JSON.stringify(h2.calls));
}

// ---- (j) reports --------------------------------------------------------------
{
  const since = '2026-09-17T00:00:00.000Z';
  const h = mkSb([[/^GET \/name_reports/, [{ id: 7 }]]]);
  await h.store.addReport(A, B, 'Ghost Rider');
  if (h.calls[0].method === 'POST' && h.calls[0].path === '/name_reports'
    && same(h.calls[0].body, { reporter: A, reported: B, callsign: 'Ghost Rider' })) ok('(j) addReport stores the name as seen');
  else fail('(j) addReport: ' + JSON.stringify(h.calls[0]));
  const yes = await h.store.reportedSince(A, B, since);
  const want = `/name_reports?reporter=eq.${A}&reported=eq.${B}&created_at=gte.2026-09-17T00%3A00%3A00.000Z&select=id&limit=1`;
  if (yes === true && h.calls[1].path === want) ok('(j) reportedSince path exact, colons encoded, true when a row comes back');
  else fail('(j) reportedSince: ' + yes + ' ' + h.calls[1].path);

  const h2 = mkSb([[/^GET/, []]]);
  if ((await h2.store.reportedSince(A, B, since)) === false) ok('(j) no rows -> false');
  else fail('(j) empty rows did not become false');

  const h3 = mkSb();
  let t3 = null; try { await h3.store.reportedSince(A, B, "now' or 1=1"); } catch (e) { t3 = e; }
  if (t3 && t3.message === 'bad since' && h3.calls.length === 0) ok('(j) an unparseable timestamp never reaches the query string');
  else fail('(j) bad since: ' + (t3 && t3.message) + ' calls=' + h3.calls.length);

  const h4 = mkSb([[/^GET/, []]]);
  await h4.store.reportedSince(A, B, Date.parse(since));
  if (h4.calls[0].path.includes('created_at=gte.2026-09-17T00%3A00%3A00.000Z')) ok('(j) a numeric timestamp is re-serialised to ISO by the store, not trusted');
  else fail('(j) numeric since: ' + h4.calls[0].path);
}

// ---- (k) a failing sbAdmin propagates from every read-and-answer method -------
{
  const boom = new Error('sb GET 502');
  const h = mkSb([[/./, boom]]);
  const tries = [
    ['profileById', () => h.store.profileById(A)],
    ['profileByFriendCode', () => h.store.profileByFriendCode('ABC234')],
    ['profileByCallsignKey', () => h.store.profileByCallsignKey('ghost')],
    ['profilesByIds', () => h.store.profilesByIds([A])],
    ['friendIdsOf', () => h.store.friendIdsOf(A)],
    ['blockIdsOf', () => h.store.blockIdsOf(A)],
    ['addFriendship', () => h.store.addFriendship(A, B)],
    ['removeFriendship', () => h.store.removeFriendship(A, B)],
    ['addRequest', () => h.store.addRequest(A, B)],
    ['deleteRequest', () => h.store.deleteRequest(A, B)],
    ['addBlock', () => h.store.addBlock(A, B)],
    ['removeBlock', () => h.store.removeBlock(A, B)],
    ['addReport', () => h.store.addReport(A, B, 'x')],
    ['reportedSince', () => h.store.reportedSince(A, B, '2026-09-17T00:00:00.000Z')],
    ['clearCallsignKey', () => h.store.clearCallsignKey(A)],
  ];
  const swallowed = [];
  for (const [name, run] of tries) {
    let threw = null;
    try { await run(); } catch (e) { threw = e; }
    if (threw !== boom) swallowed.push(name);
  }
  if (!swallowed.length) ok(`(k) all ${tries.length} answering methods propagate an sbAdmin failure, so Task 4 can answer error:'unavailable'`);
  else fail('(k) these swallowed the failure: ' + swallowed.join(', '));
}

// ---- (l) the standing guard: nothing raw ever lands in a query value ---------
{
  const bad = [];
  for (const c of ALL) {
    const q = c.path.indexOf('?');
    if (q < 0) continue;
    for (const part of c.path.slice(q + 1).split('&')) {
      const eq = part.indexOf('=');
      const v = eq < 0 ? part : part.slice(eq + 1);
      if (/[\s"'<>#\\]/.test(v)) bad.push(c.method + ' ' + c.path);
    }
  }
  if (!bad.length) ok(`(l) none of the ${ALL.length} paths this suite produced carries a raw space, quote or angle bracket in a value`);
  else fail('(l) unencoded value in: ' + bad.join(' | '));
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall social_store checks passed');
process.exit(out.errors.length ? 1 : 0);
