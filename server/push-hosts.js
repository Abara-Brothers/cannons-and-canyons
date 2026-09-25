// server/push-hosts.js — the only hosts a web push may be SENT to.
//
// WHY THIS EXISTS (live hotfix, 2026-09-25). A web push subscription is supplied
// by the client: the engine accepts any https endpoint, hangs it on the seat, and
// the host persists it. On every turn nudge web-push POSTs to that endpoint and
// buffers the WHOLE reply into one string. An endpoint a player controls can
// answer 201 and never stop: the string outgrows V8's limit, the RangeError
// escapes inside a socket handler, and 'uncaughtException' shuts the server down
// with every live match on it. A reply that only drips never settles at all.
//
// THE RULE: a web push goes only to a real push service — Google (FCM and its
// legacy hosts), Mozilla, Apple, or Microsoft's WNS. Anything else is refused
// before a single byte leaves the server. The check belongs to the SEND, not to
// registration: a refused subscription stays stored, so a real service missing
// from this list can be added later without any player subscribing again.
//
// THE PARSER THAT MATTERS IS NOT THIS ONE. This file reads an endpoint with the
// WHATWG URL parser, but web-push 3.6.7 chooses the host it connects to with the
// LEGACY url.parse(), and the two disagree on hostile input. Measured on Node 26:
//   https://evil.com;.notify.windows.com/w/   WHATWG: a WNS host.  url.parse(): evil.com
//   https://fcm%2Egoogleapis.com/x            WHATWG: fcm.googleapis.com.  url.parse(): fcm
//   https:/fcm.googleapis.com/x               WHATWG: fcm.googleapis.com.  url.parse(): NO host,
//                                             and a request with no host goes to localhost
//   a hostname over 255 characters            url.parse() empties it: localhost again
// So an endpoint is accepted only when its authority is spelled LITERALLY as the
// host the parser reports (ASCII letters, digits, dots and hyphens, then '/'),
// with every label 1-63 characters and 253 in all. On a string like that the two
// parsers cannot disagree, and test/push_hosts.mjs proves it by handing every
// string this accepts to url.parse() itself.
//
// Pure and synchronous, and it imports NOTHING: server/ never imports
// public/room-engine.js or public/game-core.js.

// Exact hostnames. No suffix matching: a push service is a HOST, not a company.
const PUSH_SERVICE_HOSTS = new Set([
  'fcm.googleapis.com',                  // Chrome and most Chromium browsers (FCM)
  'android.googleapis.com',              // FCM's legacy GCM host
  'jmt17.google.com',                    // Google
  'updates.push.services.mozilla.com',   // Firefox
  'web.push.apple.com',                  // Safari, and home-screen web apps on iOS
]);
// Microsoft WNS (Edge on Windows) spreads across many hosts, such as
// wns2-by3p.notify.windows.com — the one suffix, and it needs a label before it.
const WNS_SUFFIX = '.notify.windows.com';
// The literal start of the endpoint: a scheme, '//', an authority of ASCII
// letters, digits, dots and hyphens with an optional numeric port, then '/'.
// No '@', '%', '\', ';', whitespace or anything non-ASCII can sit in it.
const LITERAL_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([a-z0-9.-]+(?::[0-9]+)?)\//i;

// `extraHosts` is for the test suite's own https inbox and nothing else (see
// PUSH_EXTRA_HOSTS in server.js). Each entry is compared, exactly, with the URL's
// host — hostname, plus ':port' when the port is not 443 — so an entry admits
// one host on one port: never a subdomain, a parent, or another port.
export function webPushHostAllowed(endpoint, extraHosts = []) {
  if (typeof endpoint !== 'string') return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username !== '' || u.password !== '') return false;
  // The authority as written must BE the host as parsed (see the header).
  const lit = LITERAL_AUTHORITY.exec(endpoint);
  if (!lit || lit[1].toLowerCase() !== u.host) return false;
  const host = u.hostname;
  if (host.length > 253 || !host.split('.').every((l) => l.length >= 1 && l.length <= 63)) return false;
  if (Array.isArray(extraHosts)
    && extraHosts.some((h) => typeof h === 'string' && h.toLowerCase() === u.host)) return true;
  if (u.port !== '') return false;
  if (PUSH_SERVICE_HOSTS.has(host)) return true;
  return host.endsWith(WNS_SUFFIX) && host.length > WNS_SUFFIX.length;
}
