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
// HOW OFTEN THE STALE-REQUEST SWEEP MAY COST A ROUND TRIP. The sweep is
// housekeeping, not an answer: the two reads in requestsOf already ignore
// anything older than the cutoff, so nothing a caller sees depends on when the
// DELETE runs. It used to run on EVERY requestsOf, which is once in relationTo
// plus once in each of the two snapshots a fan-out builds — two or three
// DELETEs per friend operation, and one on every friends frame. Once an hour
// per store instance collects the same rows for a fraction of the traffic.
export const SWEEP_MIN_MS = 60 * 60 * 1000;
export const IDS_PER_CALL = 100;
// name_reports.callsign is `check (char_length(callsign) between 1 and 16)`, the
// same 16 as CALLSIGN_MAX in server/callsign.js. A value outside 1..16 is not a
// long name, it is a REFUSED REPORT. See addReport.
export const CALLSIGN_COL_MAX = 16;
// What a report about a player who never chose a callsign stores. Parentheses are
// the point: server/callsign.js's TOKEN is letters, digits and marks separated by
// single spaces, so no real name can ever be this string.
export const NO_CALLSIGN = '(no name)';

// WHAT A name_reports ROW ACTUALLY HOLDS, as one function, because two callers
// need the same answer and a second copy of it would drift. addReport below
// applies it on the way to PostgREST; server/social.js applies it before its
// log line, so THE LINE IN THE LOG AND THE ROW IN THE TABLE ARE THE SAME
// STRING. Without that the obvious log line — the reported player's callsign,
// straight off the profile — prints `null` for the one player the sentinel
// exists for, and a moderation queue you cannot reconcile against the log is
// worth less than no log at all.
//
// CODE POINTS, NOT CODE UNITS: see the note in addReport.
export function reportCallsign(raw) {
  const seen = [...String(raw ?? '').trim()].slice(0, CALLSIGN_COL_MAX).join('');
  return seen || NO_CALLSIGN;
}

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
// No row in name_reports can predate the table, so a `since` earlier than this is
// not a window any caller could mean — it is the "dawn of time" bug. See the note
// in reportedSince for why a shape check alone does not catch it.
const SINCE_FLOOR_MS = Date.UTC(2025, 0, 1);            // 2025-01-01T00:00:00.000Z

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

  // When the stale-request sweep last cost a round trip. 0, not Date.now(), so a
  // freshly built store still sweeps on its FIRST read — the sweep is not
  // deferred, only stopped from repeating. A process that starts and is
  // restarted hourly therefore still sweeps exactly as often as before.
  let sweptAt = 0;

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

  // CALLSIGN_KEY IS SELECTED BESIDE THE NAME, AND THAT IS THE WHOLE POINT OF THIS
  // METHOD'S SHAPE. profiles.callsign is PATCHed by the account itself on every
  // cloud save (profiles_update_own); callsign_key beside it has update revoked
  // from the authenticated role by the phase 6 migration, so it is the only part
  // of the row the server is entitled to believe. Every name in a friends panel
  // — friends, both request directions and the blocked list — is resolved here,
  // so selecting `id,callsign` alone left the caller with no way to prove any of
  // them: an account holding only a rolled name could write another player's
  // chosen callsign into its display column and render identically in every
  // panel, and a name report would then point at the wrong account.
  // server/social.js's provenName re-derives the key from the name and refuses
  // the pair when they disagree. Two columns, not one, or that check cannot run.
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
      const rows = await sbAdmin('GET', `/profiles?id=in.(${chunk})&select=id,callsign,callsign_key`);
      for (const r of rows || []) if (r && r.id) out.set(r.id, { id: r.id, callsign: r.callsign || null, callsign_key: r.callsign_key || null });
    }
    return out;
  }

  async function setChosenCallsign(userId, name, key) {
    const id = mustUuid(userId);
    // THE SAME KEY_RE THE READ PATH USES, AND THAT IS THE WHOLE POINT.
    // profileByCallsignKey refuses to look up a key outside this class; checking it
    // only there would leave the write side open, so a key the read path can never
    // match gets STORED and the player who owns it is permanently unfindable — the
    // lookup answers null with no query issued and nothing logged, which is the
    // exact silence this class was widened (BINDING resolution 21) to prevent.
    // Whatever can be written must be findable: one class, tested on both halves.
    const k = String(key);
    if (!KEY_RE.test(k)) throw new Error('bad key');
    const body = { callsign: String(name), callsign_key: k, callsign_set_at: new Date().toISOString() };
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
    // CONCURRENT, NOT SEQUENTIAL. These two reads do not depend on each other, and
    // one Friends frame is EIGHT round trips — nine on the turn of the hour, when
    // the sweep below runs — behind the 8s timeout Task 4 adds, so better than a
    // minute of a pending handler against a degraded upstream. One leg instead of
    // two. Both are still BARE: Promise.all rejects if either does, so a missing
    // table still reaches the caller. Only the sweep below may fail quietly.
    // THE CALL ORDER IS UNCHANGED: the arguments are evaluated left to right and
    // sbAdmin records before its first await, so to_user still goes out first.
    const [inc, outg] = await Promise.all([
      sbAdmin('GET', `/friend_requests?to_user=eq.${enc(id)}&created_at=gte.${enc(cut)}&select=from_user`),
      sbAdmin('GET', `/friend_requests?from_user=eq.${enc(id)}&created_at=gte.${enc(cut)}&select=to_user`),
    ]);
    // AT MOST ONCE AN HOUR, NOT ONCE PER READ. Stamped BEFORE the await so two
    // concurrent requestsOf calls — which is what one friend operation makes,
    // relationTo plus a snapshot for each side — cannot both decide to sweep.
    // A failed sweep does not un-stamp: the rows are still ignored by the reads
    // above, and the next hour's sweep collects them.
    if (Date.now() - sweptAt >= SWEEP_MIN_MS) {
      sweptAt = Date.now();
      try {
        // Housekeeping, not an answer: "a request older than 30 days is ignored and
        // deleted when next read" (design 3.2). The two reads above already ignored
        // them, so a sweep that fails costs nothing and must not fail the panel.
        // THIS IS THE ONLY SWALLOWED CALL IN THE FILE.
        await sbAdmin('DELETE', `/friend_requests?created_at=lt.${enc(cut)}`, undefined, 'return=minimal');
      } catch { /* swept on the next read */ }
    }
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
    // Concurrent for the same reason as requestsOf: two independent reads, one leg,
    // same order on the wire, and a failure in either still reaches the caller.
    const [mine, theirs] = await Promise.all([
      sbAdmin('GET', `/blocks?blocker=eq.${enc(id)}&select=blocked`),
      sbAdmin('GET', `/blocks?blocked=eq.${enc(id)}&select=blocker`),
    ]);
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
    // THE NAME AS SEEN, CLAMPED TO THE COLUMN. name_reports.callsign is
    // `check (char_length(callsign) between 1 and 16)`. A cap above that does not
    // protect the table — the CHECK already does — it only turns a legitimate
    // report into a 400 that the handler shows the reporter as 'unavailable'. The
    // entire moderation case rests on this one call working, so the clamp is 16.
    //
    // CODE POINTS, NOT CODE UNITS: char_length() counts characters and
    // validateCallsign measures with [...name].length, so slicing UTF-16 units here
    // would cut a legal astral name short and could leave a lone surrogate, which is
    // not valid UTF-8 for Postgres to accept.
    //
    // AND A PLAYER WITH NO NAME IS STILL REPORTABLE. profiles.callsign is nullable,
    // and server/social.js's handleReport hands over whatever displayName could
    // vouch for — null for a player who never chose a name, and null again for a
    // display column holding text no proof stands behind — so null arrives here as
    // the ORDINARY case, not an edge. '' fails the CHECK, so the empty string is
    // never sent: NO_CALLSIGN goes in instead and the report lands. Refusing
    // would make a never-named player the one player nobody can report — and
    // would need a fourth player-visible error string while BINDING
    // resolution 16 is still open. The name is evidence, not an identifier; the
    // reported uuid is what identifies the account.
    await sbAdmin('POST', '/name_reports', { reporter: r, reported: t, callsign: reportCallsign(callsign) }, 'return=minimal');
  }

  async function reportedSince(reporter, reported, since) {
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
    // A timestamp is therefore accepted in exactly three shapes: a Date, a finite
    // count of epoch milliseconds, or a strict ISO-8601 string — and then it is
    // bounded below, because a shape check does not make a value sane.
    //
    // A DATE IS ACCEPTED because the parameter used to be named sinceIso and threw on
    // the one thing a caller is most likely to reach for; a guard that is right and
    // surprising is still a trap for the next task. The brand check rather than
    // `instanceof` so a Date built in another realm (a vm context, a worker) is not
    // refused for a reason that has nothing to do with the value.
    let d;
    if (Object.prototype.toString.call(since) === '[object Date]') d = new Date(since.getTime());
    else if (typeof since === 'number' && Number.isFinite(since)) d = new Date(since);
    else if (typeof since === 'string' && ISO_RE.test(since.trim())) d = new Date(since.trim());
    // The message names the three shapes, because the next thing whoever hits this
    // does is guess at a fourth.
    else throw new Error('bad since: want a Date, epoch milliseconds, or an ISO-8601 string');
    // Shape is not existence: '2026-13-45T00:00:00Z' passes the regex and is still
    // not a date.
    const ms = d.getTime();
    if (Number.isNaN(ms)) throw new Error('bad since: not a real date');
    // A FLOOR, BECAUSE Number.isFinite ACCEPTS -1. A negative epoch is a 1969
    // timestamp and 0 is 1970: either turns the once-a-day window into "since the
    // dawn of time", so this answers true for any report ever filed and SUPPRESSES
    // a real one — the same failure the shape gate above exists to eliminate,
    // reached through another door. Task 6 computes the window server-side from
    // now(), so nothing reaches this today; it is shut before something does.
    if (ms < SINCE_FLOOR_MS) throw new Error('bad since: earlier than ' + new Date(SINCE_FLOOR_MS).toISOString() + ', which is not a window');
    // RE-SERIALISE RATHER THAN TRUST: whatever the caller passed, what reaches the
    // query string is an ISO timestamp this line produced.
    const sinceIso = d.toISOString();
    const rows = await sbAdmin('GET', `/name_reports?reporter=eq.${enc(r)}&reported=eq.${enc(t)}&created_at=gte.${enc(sinceIso)}&select=id&limit=1`);
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
