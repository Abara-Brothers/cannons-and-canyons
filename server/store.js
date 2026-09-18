// server/store.js — the social data store: friend codes, chosen-callsign keys,
// friendships, requests, blocks and name reports. Server only. Static files are
// served from public/ alone with a containment check (server.js:1175-1176), so
// nothing in this directory is web-reachable.
//
// WHY A MODULE AND NOT MORE OF server.js: every call here interpolates a value
// that arrived on a socket into a PostgREST query string. Doing that in one file,
// behind one uuid gate and one encodeURIComponent convention, is what makes it
// reviewable. server.js's own /profiles?id=in.(…) batch (~line 961) skips the
// encode safely because its ids come out of a uuid[] COLUMN; ours come from a
// client frame, so they are checked here, every time, before they are spliced in.
//
// FAILURE RULE, ONE SENTENCE: a method either answers or throws. sbAdmin throws on
// any non-2xx and discards the body, and this module never swallows that — the
// social handlers catch it and answer error:'unavailable'. Two exceptions, both
// deliberate and both tested: setChosenCallsign turns a unique violation into
// { ok:false, error:'taken' } (an answer, not a failure), and requestsOf's 30-day
// sweep is housekeeping whose failure changes no returned value.
//
// This module does NOT check SB_SECRET. Every caller guards with `if (!SB_SECRET)`
// first, exactly as server.js's existing call sites do.
import { randomInt } from 'node:crypto';

export const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  // no I, L, O, 0, 1
export const FRIEND_CODE_LEN = 6;
export const FRIEND_CODE_TRIES = 8;
export const REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;                 // design section 3.2
export const IDS_PER_CALL = 100;

const PROFILE_COLS = 'id,callsign,friend_code,callsign_key,callsign_set_at';

// SHAPE, NOT RFC VERSION: eight-four-four-four-twelve hex. The job of this regex
// is that nothing but [0-9a-f-] ever reaches a query string — so a v7 id minted by
// a future Supabase still passes, and '../rpc/' still does not.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
// A callsign key is what server/callsign.js made: letters, digits, single spaces
// and the combining marks its TOKEN admits, lower-cased. Anything else is not a
// key we ever wrote, so it cannot match a row and there is no reason to send it.
//
// \p{Mn} AND \p{Mc} ARE HERE ON PURPOSE. BINDING.md resolution 21 widened the
// callsign class to admit combining marks precisely so that Devanagari, Thai,
// Arabic and pointed Hebrew names are legal instead of a 'chars' error, and
// server/callsign.js implements that (its MARK/TOKEN pair). हिन्दी carries U+094D
// (Mn) and U+093F/U+0940 (Mc). Drop the marks from this class and the two halves
// disagree: the player is allowed to SET such a name and is then never FOUND —
// this function answers null with no query issued and nothing logged, so a friend
// search for a real player reports no such player and there is no trace of why.
// Keep this class in step with that TOKEN. The security property is unchanged:
// marks are not quotes, spaces or separators, and every value is still encoded.
const KEY_RE = /^[\p{L}\p{N}\p{Mn}\p{Mc} ]{1,64}$/u;
// sbAdmin's message is exactly `sb ${method} ${status}`. Anchor both ends so a 409
// sitting inside some other error's text cannot be mistaken for a conflict.
const CONFLICT_RE = /^sb [A-Z]+ 409$/;
// The only string shape reportedSince will treat as a timestamp. See the long
// note at its parse for why `new Date(x)` cannot be asked this question itself.
const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/;

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v.toLowerCase());
}

function mustUuid(v) {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (!UUID_RE.test(s)) throw new Error('bad uuid');
  return s;
}

// Postgres orders the uuid type by bytes, which for the canonical text form is
// lower-case-hex lexicographic order — so this `<` is the SAME order as the
// table's `check (user_a < user_b)`. The lower-casing in mustUuid is what makes
// that true: an upper-case id sorts before every digit and would write the pair
// the wrong way round, to be refused by the CHECK at some unrelated hour.
function pair(a, b) {
  const x = mustUuid(a);
  const y = mustUuid(b);
  if (x === y) throw new Error('pair self');
  return x < y ? [x, y] : [y, x];
}

const enc = (v) => encodeURIComponent(v);
const one = (rows) => (Array.isArray(rows) && rows[0] ? rows[0] : null);
const isConflict = (e) => !!e && CONFLICT_RE.test(String((e && e.message) || ''));

// randomInt, not Math.random: Math.random is a seeded xorshift shared with every
// other caller in the process and its stream is recoverable from a handful of
// samples. A friend code is a capability — whoever holds it becomes your friend on
// entry (design D2) — so it comes from the CSPRNG.
function makeFriendCode() {
  let s = '';
  for (let i = 0; i < FRIEND_CODE_LEN; i++) s += FRIEND_CODE_ALPHABET[randomInt(FRIEND_CODE_ALPHABET.length)];
  return s;
}

export function createStore({ sbAdmin } = {}) {
  if (typeof sbAdmin !== 'function') throw new TypeError('createStore needs sbAdmin');

  // ---- profiles -------------------------------------------------------------
  async function profileById(userId) {
    const id = mustUuid(userId);
    return one(await sbAdmin('GET', `/profiles?id=eq.${enc(id)}&select=${PROFILE_COLS}&limit=1`));
  }

  async function profileByFriendCode(code) {
    const c = String(code ?? '').trim().toUpperCase().replace(/^FR-/, '');
    if (!CODE_RE.test(c)) return null;          // not a code this server could have minted
    return one(await sbAdmin('GET', `/profiles?friend_code=eq.${enc(c)}&select=${PROFILE_COLS}&limit=1`));
  }

  async function profileByCallsignKey(key) {
    const k = String(key ?? '');
    if (!KEY_RE.test(k)) return null;
    return one(await sbAdmin('GET', `/profiles?callsign_key=eq.${enc(k)}&select=${PROFILE_COLS}&limit=1`));
  }

  async function profilesByIds(ids) {
    const out = new Map();
    const seen = new Set();
    for (const v of Array.isArray(ids) ? ids : []) {
      const s = typeof v === 'string' ? v.toLowerCase() : '';
      // DROPPED, not thrown: this list is a friends panel's worth of ids and one
      // stale entry must not blank the whole panel.
      if (UUID_RE.test(s)) seen.add(s);
    }
    const list = [...seen];
    for (let i = 0; i < list.length; i += IDS_PER_CALL) {
      const chunk = list.slice(i, i + IDS_PER_CALL).map((v) => enc(v)).join(',');
      const rows = await sbAdmin('GET', `/profiles?id=in.(${chunk})&select=id,callsign`);
      for (const r of rows || []) if (r && r.id) out.set(r.id, { id: r.id, callsign: r.callsign || null });
    }
    return out;
  }

  async function setChosenCallsign(userId, name, key) {
    const id = mustUuid(userId);
    const body = { callsign: String(name), callsign_key: String(key), callsign_set_at: new Date().toISOString() };
    let rows;
    try {
      rows = await sbAdmin('PATCH', `/profiles?id=eq.${enc(id)}`, body, 'return=representation');
    } catch (e) {
      // THE WRITE IS THE AUTHORITY. There is deliberately no pre-check read:
      // between a read and a write two players can both be told the name is free.
      // The unique index on callsign_key settles it and PostgREST answers 23505
      // with 409. sbAdmin threw the body away, so the status in its message is all
      // we have. If PostgREST ever stops answering 409 for a unique violation this
      // stops matching, the error propagates, and the player sees 'unavailable'
      // instead of 'taken' — the wrong words, never a duplicate name, because the
      // index and not this line is what refuses the write.
      if (isConflict(e)) return { ok: false, error: 'taken' };
      throw e;
    }
    // return=representation so a PATCH that matched NOTHING is visible: with
    // return=minimal PostgREST answers 204 for zero rows and this would report
    // success on a profile that does not exist.
    if (!Array.isArray(rows) || !rows.length) throw new Error('sb PATCH 0 rows');
    return { ok: true };
  }

  async function clearCallsignKey(userId) {
    const id = mustUuid(userId);
    // callsign_set_at is deliberately NOT cleared: rolling a name must not hand
    // back a fresh once-a-day allowance for chosen names.
    await sbAdmin('PATCH', `/profiles?id=eq.${enc(id)}`, { callsign_key: null }, 'return=minimal');
  }

  async function ensureFriendCode(userId) {
    const id = mustUuid(userId);
    for (let attempt = 0; attempt < FRIEND_CODE_TRIES; attempt++) {
      const have = one(await sbAdmin('GET', `/profiles?id=eq.${enc(id)}&select=friend_code&limit=1`));
      if (have && have.friend_code) return have.friend_code;
      const code = makeFriendCode();
      try {
        if (have) {
          // friend_code=is.null makes this write lose harmlessly when another
          // socket of the same player got there first; representation says which
          // happened, and the next turn of the loop reads the winner's code.
          const done = await sbAdmin('PATCH', `/profiles?id=eq.${enc(id)}&friend_code=is.null`, { friend_code: code }, 'return=representation');
          if (Array.isArray(done) && done.length) return code;
        } else {
          await sbAdmin('POST', '/profiles', { id, friend_code: code }, 'return=minimal');
          return code;
        }
      } catch (e) {
        // A collision (on friend_code, or on the primary key if the row appeared
        // between the read and the insert) is worth another draw. An outage is
        // not: say so now rather than burn eight codes against a dead database.
        if (!isConflict(e)) throw e;
      }
    }
    // 31^6 = 887,503,681 codes. Eight independent draws all colliding is not a
    // thing that happens; if it does, something is wrong that a ninth draw will
    // not fix, and the handler answers 'unavailable'.
    throw new Error('friend code exhausted');
  }

  // ---- friendships ----------------------------------------------------------
  async function friendIdsOf(userId) {
    const id = mustUuid(userId);
    const rows = await sbAdmin('GET', `/friendships?or=(user_a.eq.${enc(id)},user_b.eq.${enc(id)})&select=user_a,user_b`);
    const out = [];
    for (const r of rows || []) {
      const other = r.user_a === id ? r.user_b : r.user_a;
      if (other && other !== id) out.push(other);
    }
    return out;
  }

  async function addFriendship(a, b) {
    const [lo, hi] = pair(a, b);
    await sbAdmin('POST', '/friendships', { user_a: lo, user_b: hi }, 'return=minimal,resolution=ignore-duplicates');
  }

  async function removeFriendship(a, b) {
    const [lo, hi] = pair(a, b);
    await sbAdmin('DELETE', `/friendships?user_a=eq.${enc(lo)}&user_b=eq.${enc(hi)}`, undefined, 'return=minimal');
  }

  // ---- requests -------------------------------------------------------------
  async function requestsOf(userId) {
    const id = mustUuid(userId);
    const cut = new Date(Date.now() - REQUEST_TTL_MS).toISOString();
    const inc = await sbAdmin('GET', `/friend_requests?to_user=eq.${enc(id)}&created_at=gte.${enc(cut)}&select=from_user`);
    const outg = await sbAdmin('GET', `/friend_requests?from_user=eq.${enc(id)}&created_at=gte.${enc(cut)}&select=to_user`);
    try {
      // Housekeeping, not an answer: "a request older than 30 days is ignored and
      // deleted when next read" (design 3.2). The two reads above already ignored
      // them, so a sweep that fails costs nothing and must not fail the panel.
      // THIS IS THE ONLY SWALLOWED CALL IN THE FILE.
      await sbAdmin('DELETE', `/friend_requests?created_at=lt.${enc(cut)}`, undefined, 'return=minimal');
    } catch { /* swept on the next read */ }
    return {
      incoming: (inc || []).map((r) => r.from_user).filter(Boolean),
      outgoing: (outg || []).map((r) => r.to_user).filter(Boolean),
    };
  }

  async function addRequest(from, to) {
    const f = mustUuid(from);
    const t = mustUuid(to);
    if (f === t) throw new Error('pair self');
    // A request is directional, so it is NOT sorted into pair order. The PK here
    // is the identity column, so ignore-duplicates has to be told which unique
    // constraint to resolve against or a re-send inserts a second row.
    await sbAdmin('POST', '/friend_requests?on_conflict=from_user,to_user', { from_user: f, to_user: t }, 'return=minimal,resolution=ignore-duplicates');
  }

  async function deleteRequest(from, to) {
    const f = mustUuid(from);
    const t = mustUuid(to);
    await sbAdmin('DELETE', `/friend_requests?from_user=eq.${enc(f)}&to_user=eq.${enc(t)}`, undefined, 'return=minimal');
  }

  // ---- blocks ---------------------------------------------------------------
  async function blockIdsOf(userId) {
    const id = mustUuid(userId);
    const mine = await sbAdmin('GET', `/blocks?blocker=eq.${enc(id)}&select=blocked`);
    const theirs = await sbAdmin('GET', `/blocks?blocked=eq.${enc(id)}&select=blocker`);
    return {
      blocked: (mine || []).map((r) => r.blocked).filter(Boolean),
      blockedBy: (theirs || []).map((r) => r.blocker).filter(Boolean),
    };
  }

  async function addBlock(blocker, blocked) {
    const b = mustUuid(blocker);
    const t = mustUuid(blocked);
    if (b === t) throw new Error('pair self');
    // Direction is the record here: (blocker, blocked) is the primary key, so
    // ignore-duplicates needs no on_conflict, and the pair is never sorted.
    await sbAdmin('POST', '/blocks', { blocker: b, blocked: t }, 'return=minimal,resolution=ignore-duplicates');
  }

  async function removeBlock(blocker, blocked) {
    const b = mustUuid(blocker);
    const t = mustUuid(blocked);
    await sbAdmin('DELETE', `/blocks?blocker=eq.${enc(b)}&blocked=eq.${enc(t)}`, undefined, 'return=minimal');
  }

  // ---- reports --------------------------------------------------------------
  async function addReport(reporter, reported, callsign) {
    const r = mustUuid(reporter);
    const t = mustUuid(reported);
    if (r === t) throw new Error('pair self');
    // The name as seen, capped well above CALLSIGN_MAX so a lying caller cannot
    // push a novel into the table.
    await sbAdmin('POST', '/name_reports', { reporter: r, reported: t, callsign: String(callsign ?? '').slice(0, 64) }, 'return=minimal');
  }

  async function reportedSince(reporter, reported, sinceIso) {
    const r = mustUuid(reporter);
    const t = mustUuid(reported);
    // `new Date(x)` IS NOT A VALIDATOR, and a NaN check alone is not this guard.
    // Verified on Node v26.4.0: new Date("now' or 1=1") is NOT NaN — V8's legacy
    // string parser picks the digits out and answers 2001-01-01. So the obvious
    // version of this guard never fires on exactly the input it was written for,
    // and the once-a-day report window silently becomes "since the year 2000",
    // which makes reportedSince answer true for a report it should never have
    // counted and suppresses a legitimate one. Nothing is INJECTED either way —
    // what reaches the URL is always this function's own toISOString output — but
    // the window is wrong, and wrong quietly, on the moderation path.
    //
    // A timestamp is therefore accepted in exactly two shapes: a finite count of
    // epoch milliseconds, or a strict ISO-8601 string. Both are what a caller in
    // this codebase actually passes (Date.now() arithmetic, or .toISOString()).
    let d;
    if (typeof sinceIso === 'number' && Number.isFinite(sinceIso)) d = new Date(sinceIso);
    else if (typeof sinceIso === 'string' && ISO_RE.test(sinceIso.trim())) d = new Date(sinceIso.trim());
    else throw new Error('bad since');
    // Shape is not existence: '2026-13-45T00:00:00Z' passes the regex and is still
    // not a date.
    if (Number.isNaN(d.getTime())) throw new Error('bad since');
    // RE-SERIALISE RATHER THAN TRUST: whatever the caller passed, what reaches the
    // query string is an ISO timestamp this line produced.
    const since = d.toISOString();
    const rows = await sbAdmin('GET', `/name_reports?reporter=eq.${enc(r)}&reported=eq.${enc(t)}&created_at=gte.${enc(since)}&select=id&limit=1`);
    return Array.isArray(rows) && rows.length > 0;
  }

  return {
    ensureFriendCode, profileById, profileByFriendCode, profileByCallsignKey, profilesByIds,
    setChosenCallsign, clearCallsignKey,
    friendIdsOf, addFriendship, removeFriendship,
    requestsOf, addRequest, deleteRequest,
    blockIdsOf, addBlock, removeBlock,
    addReport, reportedSince,
  };
}
