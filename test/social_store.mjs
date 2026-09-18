// server/store.js against a recording fake sbAdmin: the exact PostgREST path of
// every method, the uuid gate, the friendship pair ordering, the unique-violation
// to 'taken' translation, and the friend-code retry. No server, no network, no
// Supabase — the fake records (method, path, body, prefer) and returns canned rows.
//
// WHY THIS EXISTS: every path in the store splices a value that arrived on a socket
// into a query string. server.js's one unencoded interpolation (/profiles?id=in.(…)
// at ~line 961) is safe only because its ids come out of a uuid[] COLUMN; these come
// from a client frame. Check (l) at the bottom walks every path this suite produced
// and refuses a raw space, quote, & = , ( ) or . in any value — the PostgREST filter
// grammar, not just the characters that look alarming — so a method added later that
// forgets encodeURIComponent cannot ship quietly.
import {
  createStore, isUuid, FRIEND_CODE_ALPHABET, FRIEND_CODE_LEN, FRIEND_CODE_TRIES,
  CALLSIGN_COL_MAX, NO_CALLSIGN,
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

  // THE READ PATH AND THE WRITE PATH MUST AGREE. profileByCallsignKey refuses to
  // look up a key outside KEY_RE; if the write does not run the same class, a key
  // the read can never match is still STORED — and the player who owns it is
  // permanently unfindable, with no query issued and nothing logged. Checking one
  // half is not checking this.
  const h6 = mkSb();
  let t6 = null; try { await h6.store.setChosenCallsign(A, 'Ghost', 'a&b=1'); } catch (e) { t6 = e; }
  if (t6 && t6.message === 'bad key' && h6.calls.length === 0) ok('(e) a callsign key outside the lookup class is refused on the WRITE path too, before any call');
  else fail('(e) hostile key on write: ' + (t6 && t6.message) + ' calls=' + h6.calls.length);

  // ...and the same class is wide enough to WRITE what resolution 21 made legal, so
  // the gate above cannot be satisfied by narrowing one half into agreement.
  const DEVANAGARI_KEY = 'हिन्दी';
  const h7 = mkSb([[/^PATCH/, [{ id: C }]]]);
  const r7 = await h7.store.setChosenCallsign(C, DEVANAGARI_KEY, DEVANAGARI_KEY);
  if (r7.ok === true && h7.calls.length === 1 && h7.calls[0].body.callsign_key === DEVANAGARI_KEY) ok('(e) a key carrying combining marks still writes — the two halves agree on the WIDE class, not a narrow one');
  else fail('(e) combining-mark write: ' + JSON.stringify(r7) + ' ' + JSON.stringify(h7.calls.map((c) => c.body)));
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

  // THE OTHER HALF OF THE SWEEP CASE, AND THE ONE WITH NO CHECK ON IT UNTIL NOW.
  // The two reads are bare awaits and correctly propagate, so this passes today —
  // but widen the try/catch below them by two lines and a missing table becomes
  // { incoming: [], outgoing: [] }: a wrong-looking SUCCESS on a read path, with
  // nothing logged, which is exactly the shape the failure rule exists to forbid.
  // The empty-array-means-the-table-is-missing path is now the one thing here that
  // cannot regress quietly.
  const h3 = mkSb([[/^GET/, new Error('sb GET 500')]]);
  let t3 = null; let got3 = null;
  try { got3 = await h3.store.requestsOf(A); } catch (e) { t3 = e; }
  if (t3 && t3.message === 'sb GET 500') ok('(h) a failing READ rejects — only the sweep may fail quietly, never the answer');
  else fail('(h) a failing read did not reject: threw=' + JSON.stringify(t3 && t3.message) + ' resolved=' + JSON.stringify(got3));
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
  if (t3 && /^bad since/.test(t3.message) && h3.calls.length === 0) ok('(j) an unparseable timestamp never reaches the query string');
  else fail('(j) bad since: ' + (t3 && t3.message) + ' calls=' + h3.calls.length);

  const h4 = mkSb([[/^GET/, []]]);
  await h4.store.reportedSince(A, B, Date.parse(since));
  if (h4.calls[0].path.includes('created_at=gte.2026-09-17T00%3A00%3A00.000Z')) ok('(j) a numeric timestamp is re-serialised to ISO by the store, not trusted');
  else fail('(j) numeric since: ' + h4.calls[0].path);

  // THE COLUMN IS `check (char_length(callsign) between 1 and 16)`. Everything below
  // is about a report that is refused by the DATABASE and shown to the reporter as
  // 'unavailable' — a moderation action failing with the wrong words.
  const h5 = mkSb();
  const LONG = 'Ghostrider Overflowing';                 // 22 characters
  await h5.store.addReport(A, B, LONG);
  const clamped = h5.calls[0]?.body?.callsign ?? '';
  if (clamped === LONG.slice(0, CALLSIGN_COL_MAX) && [...clamped].length === CALLSIGN_COL_MAX) ok('(j) a name longer than the column is clamped to 16, not sent for the CHECK to refuse');
  else fail('(j) long name: ' + JSON.stringify(clamped));

  // profiles.callsign is nullable and Task 6 passes it straight through
  // (addReport(ws.userId, id, who.callsign)), so a player who never chose a name is
  // the ORDINARY case here, not an edge — and '' is exactly what the CHECK refuses.
  // If this regresses, the one player nobody can report is the one with no name.
  const h6 = mkSb();
  await h6.store.addReport(A, B, null);
  await h6.store.addReport(A, C, '   ');
  const names = h6.calls.map((c) => c.body && c.body.callsign);
  if (names[0] === NO_CALLSIGN && names[1] === NO_CALLSIGN) ok('(j) a player with no callsign can still be reported: NO_CALLSIGN is stored, never the empty string');
  else fail('(j) nameless report: ' + JSON.stringify(names));
  if ([...NO_CALLSIGN].length >= 1 && [...NO_CALLSIGN].length <= CALLSIGN_COL_MAX) ok('(j) NO_CALLSIGN itself fits the 1..16 the column checks');
  else fail('(j) NO_CALLSIGN does not fit the column: ' + JSON.stringify(NO_CALLSIGN));

  // char_length() counts CHARACTERS and validateCallsign measures with
  // [...name].length, so a clamp that counts UTF-16 units would both cut a legal
  // astral name short and could leave half a surrogate pair — not valid UTF-8, and
  // the insert is refused for a reason nobody would find.
  const h7 = mkSb();
  const ASTRAL = '\u{1D400}'.repeat(20);                  // 20 code points, 40 UTF-16 units
  await h7.store.addReport(A, B, ASTRAL);
  const cut = h7.calls[0]?.body?.callsign ?? '';
  const lone = /[\uD800-\uDFFF]/.test(cut.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));
  if ([...cut].length === CALLSIGN_COL_MAX && !lone) ok('(j) the clamp counts code points like char_length() does, and never leaves half a surrogate');
  else fail('(j) astral clamp: ' + [...cut].length + ' code points, ' + cut.length + ' units, lone surrogate=' + lone);

  // Number.isFinite(-1) is true. A negative epoch is a 1969 timestamp and 0 is 1970:
  // either makes the once-a-day window "since the dawn of time", so reportedSince
  // answers true for any report ever filed and SUPPRESSES a legitimate one.
  for (const [label, v] of [['a negative', -1], ['an epoch-0', 0], ['a 1969', -86400000]]) {
    const hh = mkSb();
    let te = null; try { await hh.store.reportedSince(A, B, v); } catch (e) { te = e; }
    if (te && /^bad since/.test(te.message) && hh.calls.length === 0) ok(`(j) ${label} timestamp is refused before any call — a finiteness test is not a window`);
    else fail(`(j) ${label} since: ` + (te && te.message) + ' calls=' + hh.calls.length);
  }

  // Passing a Date is the obvious thing for the next caller to do, so it must not be
  // a trap; an Invalid Date still is not a date.
  const h8 = mkSb([[/^GET \/name_reports/, [{ id: 7 }]]]);
  // GUARDED: the regression this check exists for IS a rejection coming out of here,
  // and an unguarded await would end the run with a stack trace instead of naming
  // the check that failed.
  let viaDate = null;
  try { viaDate = await h8.store.reportedSince(A, B, new Date(since)); } catch (e) { viaDate = 'threw ' + e.message; }
  if (viaDate === true && h8.calls[0]?.path.includes('created_at=gte.2026-09-17T00%3A00%3A00.000Z')) ok('(j) a Date is accepted and re-serialised to the same ISO the string form produces');
  else fail('(j) Date since: ' + viaDate + ' ' + JSON.stringify(h8.calls.map((c) => c.path)));

  const h9 = mkSb();
  let t9 = null; try { await h9.store.reportedSince(A, B, new Date('nope')); } catch (e) { t9 = e; }
  if (t9 && /not a real date/.test(t9.message) && h9.calls.length === 0) ok('(j) an Invalid Date is refused, and the message says what it wanted');
  else fail('(j) invalid Date: ' + (t9 && t9.message) + ' calls=' + h9.calls.length);
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
  // THE CHARACTERS THAT MATTER ARE NOT THE ONES THAT LOOK ALARMING. This check used
  // to scan for [\s"'<>#\\] alone — and PostgREST filter injection is written with
  // & = , ( ) and ., none of which were in that class. A value carrying & or , would
  // have walked past it without a word, which is the one thing a standing guard must
  // not do. & starts another parameter; , ( ) . are the filter grammar itself, the
  // grammar or=(user_a.eq.X,user_b.eq.Y) is parsed with.
  //
  // NOTHING IN THIS SUITE CAN REACH IT TODAY: every value is enc()'d and every one
  // is shape-gated before that. This is a standing guard being STRENGTHENED, not a
  // live hole being closed. It exists for the method someone adds in six months that
  // forgets encodeURIComponent, and it is worth exactly as much as the characters it
  // knows to look for.
  //
  // To scan the operand, the grammar the store itself writes has to be parsed away
  // first — the eq./gte./lt./is. prefix, the parens and commas of in.(…) and or=(…),
  // the column list in select= — or the guard fails on its own legitimate paths. The
  // residual limitation, stated rather than hidden: a value that injected a COMPLETE,
  // well-formed filter into an or(…) could not be told apart from the real thing by
  // any scan of the finished path. What stops that is the uuid gate every or(…)
  // operand passes through before it gets here.
  const CONST_SHAPE = {                     // built from constants in store.js…
    select: /^[a-z_]+(?:,[a-z_]+)*$/,       // …but an injected & lands inside them
    on_conflict: /^[a-z_]+(?:,[a-z_]+)*$/,  //    just as easily, so they are held to
    limit: /^1$/,                           //    the exact shapes this store writes
  };
  // Every parameter name the store writes. An unknown one means a new method (add it
  // here, deliberately) or a raw & that split a value into a parameter of its own.
  const KEYS = new Set([
    'id', 'friend_code', 'callsign_key', 'or', 'user_a', 'user_b', 'from_user',
    'to_user', 'created_at', 'blocker', 'blocked', 'reporter', 'reported',
    ...Object.keys(CONST_SHAPE),
  ]);
  const RAW = /[\s"'<>#\\&=,()]/;
  // encodeURIComponent leaves . alone and an ISO timestamp legitimately carries one,
  // so the dot is allowed in that one shape and nowhere else.
  const TS = /^\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}\.\d{3}Z$/;
  const bad = [];
  for (const c of ALL) {
    const q = c.path.indexOf('?');
    if (q < 0) continue;
    const flag = (why) => bad.push(`${c.method} ${c.path} [${why}]`);
    const value = (v) => { if (RAW.test(v) || (v.includes('.') && !TS.test(v))) flag(`raw value "${v}"`); };
    for (const part of c.path.slice(q + 1).split('&')) {
      const eq = part.indexOf('=');
      const key = eq < 0 ? part : part.slice(0, eq);
      const rest = eq < 0 ? '' : part.slice(eq + 1);
      if (!KEYS.has(key)) { flag(`unknown parameter "${key}"`); continue; }
      if (CONST_SHAPE[key]) { if (!CONST_SHAPE[key].test(rest)) flag(`"${key}" is not the shape this store writes: "${rest}"`); continue; }
      if (key === 'or' || key === 'and') {
        if (!/^\([\s\S]*\)$/.test(rest)) { flag(`malformed ${key}(): "${rest}"`); continue; }
        for (const el of rest.slice(1, -1).split(',')) {
          const m = /^[a-z_]+\.[a-z]+\.([\s\S]*)$/.exec(el);
          if (!m) flag(`not a column.op.value inside ${key}(): "${el}"`); else value(m[1]);
        }
        continue;
      }
      const m = /^([a-z]+)\.([\s\S]*)$/.exec(rest);
      if (!m) { value(rest); continue; }
      if (m[1] === 'in') {
        if (!/^\([\s\S]*\)$/.test(m[2])) { flag(`malformed in(): "${m[2]}"`); continue; }
        for (const el of m[2].slice(1, -1).split(',')) value(el);
        continue;
      }
      value(m[2]);
    }
  }
  if (!bad.length) ok(`(l) none of the ${ALL.length} paths this suite produced carries a raw space, quote, & = , ( ) or . in a value`);
  else fail('(l) unencoded value in: ' + bad.join(' | '));
}

console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nall social_store checks passed');
process.exit(out.errors.length ? 1 : 0);
