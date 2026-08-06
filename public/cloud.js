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

  // Some sessions arrive without a user id: a fragment login (OAuth return)
  // carries only tokens. One /user call fills it in; everything that writes
  // a row depends on it.
  async function hydrateUser() {
    if (session.user_id) return;
    const res = await fetch(BASE + '/auth/v1/user', {
      headers: { apikey: KEY, Authorization: 'Bearer ' + session.access_token },
    });
    if (!res.ok) throw new Error('user ' + res.status);
    const u = await res.json();
    if (!u || !u.id) throw new Error('no user');
    session.user_id = u.id;
    storeSession(session);
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
        await hydrateUser();
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
        await hydrateUser();
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

    // ---- Google sign-in (8.47) ----------------------------------------------
    // The IMPLICIT flow, chosen deliberately for a zero-build classic-script
    // client: the browser goes to /authorize, Google comes back to
    // redirect_to with tokens in the URL FRAGMENT — which never leaves the
    // browser (fragments are not sent to servers), and PKCE's code_verifier
    // bookkeeping never enters the codebase.

    // Fresh sign-in: any prior (guest) session on this DEVICE is replaced;
    // the local progression then merges into the Google account's row on
    // return, so nothing a player can see is lost.
    signInUrl() {
      return BASE + '/auth/v1/authorize?provider=google&redirect_to='
        + encodeURIComponent(location.origin + '/');
    },

    // Link Google to the CURRENT guest account, KEEPING its user id and row.
    // A plain redirect cannot carry the Authorization header this needs, so
    // skip_http_redirect asks GoTrue for the Google URL as JSON instead and
    // the caller navigates to it.
    async linkUrl() {
      try {
        await ensureSession(false);
        const res = await fetch(BASE + '/auth/v1/user/identities/authorize'
          + '?provider=google&skip_http_redirect=true&redirect_to='
          + encodeURIComponent(location.origin + '/'), {
          headers: { apikey: KEY, Authorization: 'Bearer ' + session.access_token },
        });
        if (!res.ok) throw new Error('link ' + res.status);
        const j = await res.json();
        return j && j.url ? j.url : null;
      } catch { return null; }
    },

    // Consume an OAuth return. Runs synchronously at boot, BEFORE restore():
    // stores the arriving tokens as the session and scrubs them from the
    // address bar (they must not survive into history or a shared link).
    // Returns 'ok', 'error' (user cancelled / provider error), or false.
    consumeRedirect() {
      if (!location.hash || location.hash.length < 2) return false;
      const p = new URLSearchParams(location.hash.slice(1));
      const scrub = () => history.replaceState(null, '', location.pathname + location.search);
      if (p.get('error')) { scrub(); return 'error'; }
      const at = p.get('access_token'), rt = p.get('refresh_token');
      if (!at || !rt) return false;
      storeSession({
        access_token: at,
        refresh_token: rt,
        expires_at: Number(p.get('expires_at')) || (now() + Number(p.get('expires_in') || 3600)),
        user_id: null,                 // hydrateUser fills this on first use
      });
      scrub();
      return 'ok';
    },

    // Who the session belongs to, for the account strip. Null when signed out.
    async whoami() {
      try {
        await ensureSession(false);
        const res = await fetch(BASE + '/auth/v1/user', {
          headers: { apikey: KEY, Authorization: 'Bearer ' + session.access_token },
        });
        if (!res.ok) throw new Error('user ' + res.status);
        const u = await res.json();
        if (!u || !u.id) return null;
        if (!session.user_id) { session.user_id = u.id; storeSession(session); }
        const g = (u.identities || []).find((i) => i.provider === 'google');
        return {
          id: u.id,
          anonymous: !!u.is_anonymous,
          google: !!g,
          email: u.email || (g && g.identity_data && g.identity_data.email) || null,
        };
      } catch { return null; }
    },

    // Sign out on the server (revokes the refresh token), then locally. The
    // next save simply mints a fresh guest — progress already saved to the
    // signed-out account stays there, waiting for its next sign-in.
    async signOut() {
      try {
        await fetch(BASE + '/auth/v1/logout', {
          method: 'POST',
          headers: { apikey: KEY, Authorization: 'Bearer ' + (session || {}).access_token },
        });
      } catch { /* revocation is best-effort; local clear is what matters */ }
      storeSession(null);
    },
  };
})();
