// cloud.js — Supabase session + profile sync, plain REST (ADR-007).
//
// This file owns the TRANSPORT: session lifecycle (anonymous sign-in, refresh,
// storage) and the two profile calls (fetch, upsert). app.js owns the MEANING:
// what progression is, how cloud and local merge, and when to queue a push.
//
// Design rules, each one load-bearing:
//
//   * NOTHING here may ever break the game. Every path is catch-and-dormant:
//     no throw escapes, no UI beyond what app.js chooses to show, no retry
//     loop that could hammer a dead network. Offline play (8.44) must work
//     with this file failing entirely.
//   * Sign-in is LAZY. Boot only restores a session that already exists; a
//     brand-new anonymous account is created on the first actual save. A
//     drive-by visitor who never fires a shot creates no auth row.
//   * The publishable key ships in config.js by design — it is public, like
//     the VAPID public key. Row security lives in Postgres RLS, not here.
//   * Refresh tokens rotate on use. The stored pair is replaced atomically
//     after each refresh; two tabs racing a refresh is tolerated by GoTrue's
//     short reuse window, and each tab re-reads storage before refreshing to
//     shrink that race rather than coordinate over BroadcastChannel.
window.Cloud = (() => {
  const BASE = window.CC_SUPABASE_URL || '';
  const KEY = window.CC_SUPABASE_KEY || '';
  const SKEY = 'cc_session';
  const REFRESH_SKEW_S = 60;          // refresh this long before expiry
  let session = null;                  // { access_token, refresh_token, expires_at, user_id }
  let refreshTimer = null;
  let signingIn = null;                // single-flight promise for signup/refresh

  const now = () => Math.floor(Date.now() / 1000);
  const enabled = () => !!(BASE && KEY);

  function loadSession() {
    try { session = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch { session = null; }
    return session;
  }
  function storeSession(s) {
    session = s;
    try { s ? localStorage.setItem(SKEY, JSON.stringify(s)) : localStorage.removeItem(SKEY); } catch {}
    armRefresh();
  }
  function fromTokenResponse(j) {
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at || (now() + (j.expires_in || 3600)),
      user_id: (j.user && j.user.id) || (session && session.user_id) || null,
    };
  }

  async function authPost(path, body) {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('auth ' + res.status);
    return res.json();
  }

  async function refresh() {
    // Re-read storage first: another tab may have rotated the pair already.
    loadSession();
    if (!session || !session.refresh_token) throw new Error('no session');
    const j = await authPost('/auth/v1/token?grant_type=refresh_token',
      { refresh_token: session.refresh_token });
    storeSession(fromTokenResponse(j));
  }

  async function signUpAnon() {
    const j = await authPost('/auth/v1/signup', {});
    storeSession(fromTokenResponse(j));
  }

  function armRefresh() {
    clearTimeout(refreshTimer);
    if (!session) return;
    const inMs = Math.max(5, session.expires_at - REFRESH_SKEW_S - now()) * 1000;
    refreshTimer = setTimeout(() => { refresh().catch(() => { /* next call retries */ }); }, inMs);
  }

  // A valid token, minting or refreshing as needed. Single-flight so a burst
  // of saves cannot fire parallel signups. `create` gates the lazy sign-up:
  // reads pass with create:false and simply report "no session" instead.
  //
  // The latch discipline here is deliberate and was got wrong once: an async
  // IIFE that throws BEFORE its first await settles synchronously, so a
  // `finally { signingIn = null }` inside it runs before the outer
  // `signingIn = (...)()` assignment lands — leaving the latch poisoned with
  // a rejected promise that every later call re-awaits and rethrows, killing
  // cloud sync for the whole page life with zero network activity. So: the
  // flight NEVER rejects for the ordinary "no session" case, the latch is
  // assigned before it is awaited, and it is cleared afterwards under an
  // identity check so a newer flight is never clobbered.
  async function ensureSession(create) {
    if (!enabled()) throw new Error('cloud disabled');
    if (signingIn) { try { await signingIn; } catch { /* that caller handled it */ } }
    loadSession();
    if (session && session.expires_at - REFRESH_SKEW_S > now()) return;
    const flight = (async () => {
      if (session && session.refresh_token) {
        try { await refresh(); return; }
        catch { storeSession(null); }   // rotten pair: fall through
      }
      if (create) await signUpAnon();
    })();
    signingIn = flight;
    try { await flight; }
    finally { if (signingIn === flight) signingIn = null; }
    if (!session) throw new Error('no session');
  }

  async function rest(path, opts = {}) {
    const res = await fetch(BASE + '/rest/v1' + path, {
      ...opts,
      headers: {
        apikey: KEY,
        Authorization: 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error('rest ' + res.status);
    // return=minimal answers 2xx with an EMPTY body (200/201/204 alike), and
    // res.json() on empty throws — which once made every successful write
    // report as a failure after the row had already landed. Parse by content,
    // not by status.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    enabled,
    userId: () => (session ? session.user_id : null),

    // Restore an existing session and fetch the profile row. Resolves null
    // when there is no session, no row, or no network — all equally fine.
    async restore() {
      try {
        await ensureSession(false);
        const rows = await rest('/profiles?id=eq.' + session.user_id
          + '&select=callsign,progression,progression_version');
        return rows && rows[0] ? rows[0] : null;
      } catch { return null; }
    },

    // Upsert the profile row, creating the anonymous account on first use.
    // Returns true on success so the caller can keep a dirty flag.
    async save(callsign, progression) {
      try {
        await ensureSession(true);
        await rest('/profiles?on_conflict=id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            id: session.user_id,
            callsign: callsign || null,
            progression,
            progression_version: 1,
          }),
        });
        return true;
      } catch { return false; }
    },
  };
})();
