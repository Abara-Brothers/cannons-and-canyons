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
  // Marks "this tab is expecting OAuth tokens back". See consumeRedirect.
  const PENDING = 'cc_oauth_pending';

  // ---- Where the provider sends the browser back to --------------------------
  // WEB: this origin, exactly as before.
  //
  // NATIVE, WITH the in-app sheet (iOS, once the shell has registered the
  // CCWebAuth plugin): the app's own scheme, CC_IOS_CALLBACK. The provider leg
  // runs inside ASWebAuthenticationSession, which intercepts the navigation to
  // that scheme within the session and hands the URL ONLY to the app that
  // started it. A scheme here is therefore not the takeover hole described
  // next: no other app is ever asked to open it, and it never reaches an
  // address bar.
  //
  // NATIVE, WITHOUT the sheet (Android, or an iOS shell whose plugin did not
  // register): an https:// URL on our own domain, claimed as a Universal Link
  // (iOS) / App Link (Android) and SCOPED to this one path. Deliberately NOT a
  // private-use scheme there — that is a security choice, not a style one. This
  // client uses the IMPLICIT flow (see the Google block below), so what comes
  // back in the fragment is a LIVE ACCESS TOKEN, not an authorization code that
  // is worthless without a verifier. When the OS is the one routing the reply,
  // any app on the device can register a scheme, iOS does not let the user
  // choose which wins, and a scheme callback would hand whoever claimed it a
  // working session — account takeover, not interception. A domain-bound link
  // cannot be claimed by an app that cannot serve files from the domain.
  //
  // The host MUST match the `applinks:` entry in ios/App/App/App.entitlements;
  // a mismatch means iOS never opens the app and the player is stranded in
  // Safari holding a token nothing will read. house-rules keeps them in step
  // (8b), and pins CC_IOS_CALLBACK to the bundle id and this same path (8d).
  const NATIVE = !!(window.Capacitor && window.Capacitor.getPlatform
    && window.Capacitor.getPlatform() !== 'web');
  const RETURN_PATH = '/auth/callback';
  // Decided at CALL time, not load time. The plugin object is defined by a
  // document-start script so it is there either way; reading it lazily costs
  // nothing and lets the headless test stand the plugin up per case.
  const inApp = () => !!(NATIVE && window.CC_IOS_CALLBACK
    && window.Capacitor.Plugins && window.Capacitor.Plugins.CCWebAuth);
  const redirectTarget = () => (inApp()
    ? window.CC_IOS_CALLBACK
    : NATIVE
      ? 'https://' + (window.CC_NATIVE_HOST || 'tanks.abarabrothers.com') + RETURN_PATH
      : location.origin + '/');

  // The anti-login-CSRF flag (see consumeRedirect). On WEB it lives in
  // sessionStorage: per-tab, dies with the tab, so a crafted #access_token link
  // opened anywhere else carries no flag. NATIVE has no tabs, and the WebView
  // is BACKGROUNDED for the whole provider leg while Safari runs it — iOS may
  // discard a backgrounded WebView's sessionStorage under memory pressure,
  // which would silently reject a legitimate return and look like a broken
  // button. localStorage there keeps the same guarantee (a flag this app set,
  // for a sign-in this app started) without losing it to a memory warning.
  // (With the in-app sheet the WebView is never backgrounded, but the same
  // store still holds: one store for both native carriers is one fewer branch
  // to get wrong, and localStorage loses nothing the sheet needs.)
  const pendStore = () => (NATIVE ? window.localStorage : window.sessionStorage);
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

  // Every request is bounded. Without a timeout, a black-holed connection (a
  // captive portal, a dead cell hand-off) left the single-flight latch pending
  // forever, and with it the account chip, Export and Delete — no error, no
  // recovery, for the life of the page.
  const REQ_TIMEOUT_MS = 12000;
  const timeout = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(REQ_TIMEOUT_MS) : undefined);

  async function authPost(path, body) {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeout(),
    });
    // A 4xx means the server looked and said no — those credentials are dead.
    // Anything else (5xx, offline, timeout) says nothing about them.
    if (!res.ok) {
      const e = new Error('auth ' + res.status);
      e.rejected = res.status >= 400 && res.status < 500;
      throw e;
    }
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
        catch (err) {
          // Distinguish REJECTED from UNREACHABLE. Discarding the stored pair
          // on any failure meant a single flaky moment — a tunnel, a dropped
          // wifi hop — silently orphaned the player's account: a fresh
          // anonymous one was minted, their cloud save became unreachable
          // forever, and Delete/Export then acted on the WRONG account. Only
          // a definitive rejection from the server may discard credentials;
          // a network error must leave them alone and fail this call.
          if (err && err.rejected) storeSession(null);
          else throw err;
        }
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
      signal: timeout(),
    });
    if (!res.ok) throw new Error('user ' + res.status);
    const u = await res.json();
    if (!u || !u.id) throw new Error('no user');
    session.user_id = u.id;
    storeSession(session);
  }

  async function rest(path, opts = {}) {
    const res = await fetch(BASE + '/rest/v1' + path, {
      signal: timeout(),
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

    // True when the shell can run the provider leg in an in-app sheet. app.js
    // routes goSignIn() through the CCWebAuth plugin when this says so and
    // through location.href otherwise; both MUST agree with redirectTarget(),
    // so the predicate lives here, once.
    inAppAuth() { return inApp(); },

    // The sheet was dismissed or failed to open: no reply is coming, so the
    // "expecting tokens" flag must not outlive the attempt. On native the flag
    // is in localStorage and would otherwise stay armed until the next reply of
    // ANY kind — a crafted Universal Link opened from a message included, which
    // is exactly what the flag exists to refuse.
    cancelPending() { try { pendStore().removeItem(PENDING); } catch {} },

    // ---- Sign in with Apple, natively (iOS) --------------------------------
    // The system sheet returns a signed identity token whose audience is the
    // bundle id; GoTrue's id_token grant verifies it against Apple's keys and
    // mints a session -- or, with link_identity and the guest's bearer, attaches
    // the Apple identity to the guest's EXISTING account and returns a session
    // for that same account (verified live: the bearer is checked only when
    // link_identity is sent). No redirect, no fragment, no pending flag: the
    // reply is a fetch response, and replay is refused by the nonce Apple
    // embedded. NEVER falls back from a failed link to a fresh sign-in -- that
    // mints a different account and orphans the guest's row, the trap linkUrl()
    // refuses for the same reason. Resolves { ok } or { ok:false, code }.
    async signInWithApple(idToken, nonce, link) {
      const headers = { apikey: KEY, 'Content-Type': 'application/json' };
      const body = { provider: 'apple', id_token: idToken, nonce };
      if (link) {
        try { await ensureSession(false); } catch { return { ok: false, code: 'no_session' }; }
        headers.Authorization = 'Bearer ' + session.access_token;
        body.link_identity = true;
      }
      let res, j = null;
      try {
        res = await fetch(BASE + '/auth/v1/token?grant_type=id_token', {
          method: 'POST', headers, body: JSON.stringify(body), signal: timeout(),
        });
        try { j = await res.json(); } catch { j = null; }
      } catch { return { ok: false, code: 'network' }; }
      if (!res.ok || !j || !j.access_token || !j.refresh_token) {
        return { ok: false, code: (j && (j.error_code || j.error)) || ('http_' + res.status) };
      }
      storeSession(fromTokenResponse(j));
      return { ok: true };
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
    signInUrl(provider) {
      try { pendStore().setItem(PENDING, '1'); } catch {}
      return BASE + '/auth/v1/authorize?provider=' + encodeURIComponent(provider || 'google')
        + '&redirect_to=' + encodeURIComponent(redirectTarget());
    },

    // Link Google to the CURRENT guest account, KEEPING its user id and row.
    // A plain redirect cannot carry the Authorization header this needs, so
    // skip_http_redirect asks GoTrue for the Google URL as JSON instead and
    // the caller navigates to it.
    async linkUrl(provider) {
      try {
        await ensureSession(false);
        const res = await fetch(BASE + '/auth/v1/user/identities/authorize'
          + '?provider=' + encodeURIComponent(provider || 'google')
          + '&skip_http_redirect=true&redirect_to='
          + encodeURIComponent(redirectTarget()), {
          headers: { apikey: KEY, Authorization: 'Bearer ' + session.access_token },
          signal: timeout(),
        });
        if (!res.ok) throw new Error('link ' + res.status);
        const j = await res.json();
        if (!j || !j.url) return null;
        try { pendStore().setItem(PENDING, '1'); } catch {}
        return j.url;
      } catch { return null; }
    },

    // Consume an OAuth return. Runs synchronously at boot, BEFORE restore():
    // stores the arriving tokens as the session and scrubs them from the
    // address bar (they must not survive into history or a shared link).
    // Returns 'ok', 'error' (user cancelled / provider error), or false.
    // `rawUrl` is the NATIVE carrier: either the scheme URL the in-app sheet
    // resolved with (iOS, handed over by goSignIn) or the Universal Link the
    // app was reopened with (handed over by the appUrlOpen listener). Same
    // tokens and the same guard as the web path — only the carrier differs,
    // because a packaged app has no address bar for the provider to redirect.
    consumeRedirect(rawUrl) {
      let frag;
      if (rawUrl) {
        const cut = String(rawUrl).indexOf('#');
        frag = cut === -1 ? '' : String(rawUrl).slice(cut + 1);
      } else {
        frag = location.hash ? location.hash.slice(1) : '';
      }
      if (frag.length < 2) return false;
      const p = new URLSearchParams(frag);
      // Nothing to scrub on native: the URL never reached an address bar or a
      // history entry — it arrived as an app activation and is already gone.
      const scrub = () => {
        if (rawUrl) return;
        history.replaceState(null, '', location.pathname + location.search);
      };
      // ONLY accept tokens for a sign-in THIS TAB started. Without this, any
      // link of the form https://…/#access_token=<attacker's token> silently
      // signed the visitor into the ATTACKER's account: their progress would
      // then sync into it, and the attacker could read it at will. A login
      // CSRF, exploitable by pasting a link. The flag lives in sessionStorage
      // so it is per-tab and dies with it; a crafted link opened anywhere else
      // has no flag and its tokens are discarded.
      let initiated = false;
      try { initiated = pendStore().getItem(PENDING) === '1'; } catch {}
      if (!initiated) { scrub(); return false; }
      try { pendStore().removeItem(PENDING); } catch {}
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
          signal: timeout(),
        });
        if (!res.ok) throw new Error('user ' + res.status);
        const u = await res.json();
        if (!u || !u.id) return null;
        if (!session.user_id) { session.user_id = u.id; storeSession(session); }
        const ident = u.identities || [];
        const g = ident.find((i) => i.provider === 'google');
        // Apple's "Hide My Email" returns a per-app relay address
        // (…@privaterelay.appleid.com) rather than the real one, and Apple
        // returns the user's NAME only on the very first authorization, never
        // again. Both are normal, neither is an error, and nothing here should
        // treat a relay address as less valid than any other.
        const a = ident.find((i) => i.provider === 'apple');
        return {
          id: u.id,
          anonymous: !!u.is_anonymous,
          google: !!g,
          apple: !!a,
          // Every linked provider with the address it carries, for the account
          // chip and the Bay controls row. Apple first, as the provider chooser
          // lists it, so the order never changes between renders.
          accounts: [['apple', a], ['google', g]]
            .filter((x) => x[1])
            .map((x) => ({ provider: x[0], email: (x[1].identity_data && x[1].identity_data.email) || null })),
          email: u.email
            || (g && g.identity_data && g.identity_data.email)
            || (a && a.identity_data && a.identity_data.email)
            || null,
        };
      } catch { return null; }
    },

    // A valid access token for the game server to verify (the ws 'hello' and
    // 'pushSub' messages carry it). create:true may mint the account first —
    // right for enabling nudges, an explicit act worth an account; wrong for
    // merely connecting, so the boot-time hello passes false.
    async token(create) {
      try { await ensureSession(!!create); return session.access_token; }
      catch { return null; }
    },

    // Sign out on the server (revokes the refresh token), then locally. The
    // next save simply mints a fresh guest — progress already saved to the
    // signed-out account stays there, waiting for its next sign-in.
    async signOut() {
      try {
        await fetch(BASE + '/auth/v1/logout', {
          method: 'POST',
          headers: { apikey: KEY, Authorization: 'Bearer ' + (session || {}).access_token },
          signal: timeout(),
        });
      } catch { /* revocation is best-effort; local clear is what matters */ }
      storeSession(null);
    },
  };
})();
