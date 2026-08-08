// errors.js — minimal crash reporting (ISSUE-006), the self-hosted route.
//
// No SDK, by decision: the whole client surface is ~50 lines against a tiny
// endpoint we own. Loaded BEFORE app.js so a parse or boot error in the main
// script is still caught — a crash reporter that loads after the crash
// reports nothing.
//
// Privacy posture, load-bearing (privacy.html describes exactly this):
//   * NOTHING identifying is sent — no account id, no callsign, no cookies.
//     The payload is the technical error text, where it happened, the build
//     version and the browser's user-agent string. The server stores no IP.
//   * At most 5 reports per page load, each distinct message once — a crash
//     loop must not become a data firehose.
//   * The reporter itself may never throw or slow the game; every path is
//     wrapped, and delivery is fire-and-forget with keepalive so a crash
//     during page teardown still gets out.
(() => {
  const MAX_PER_LOAD = 5;
  let sent = 0;
  const seen = new Set();

  function report(message, source, stack) {
    try {
      if (sent >= MAX_PER_LOAD) return;
      const key = String(message).slice(0, 120);
      if (seen.has(key)) return;
      seen.add(key);
      sent += 1;
      const remote = window.CC_SERVER;             // same host rule as the WebSocket
      const body = JSON.stringify({
        message: String(message || 'unknown error').slice(0, 500),
        stack: stack ? String(stack).slice(0, 4000) : null,
        source: source ? String(source).slice(0, 300) : null,
        version: window.CC_VERSION || null,
        platform: (navigator.userAgent || '').slice(0, 200),
      });
      fetch((remote ? `https://${remote}` : '') + '/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch { /* the reporter must never be the second crash */ }
  }

  window.addEventListener('error', (e) => {
    report(
      e.message || 'unknown error',
      `${e.filename || ''}:${e.lineno || 0}:${e.colno || 0}`,
      e.error && e.error.stack
    );
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    report((r && r.message) || String(r), null, r && r.stack);
  });
})();
