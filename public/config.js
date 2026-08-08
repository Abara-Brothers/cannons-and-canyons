// Runtime configuration for Cannons & Canyons.
//
// CC_SERVER is the host the client talks to. On the web the page is served BY
// the game server, so same-origin is correct and this stays null.
//
// In a packaged Capacitor build the page is loaded from the app bundle — the
// origin is `capacitor://localhost` (iOS) or `https://localhost` (Android) —
// so same-origin would aim the WebSocket and the push-key fetch at the device
// itself, and every mode would fail on first launch. Capacitor injects
// `window.Capacitor`, so the shell detects itself; no separate build of this
// file is needed, and the web path is unchanged.
//
// To point a build at staging instead, override CC_NATIVE_HOST before app.js
// runs (this file is loaded first in index.html).
window.CC_NATIVE_HOST = 'tanks.abarabrothers.com';
window.CC_SERVER = window.Capacitor ? window.CC_NATIVE_HOST : null;

// Stamped by `npm run version:sync` from package.json — do not edit by hand.
// Crash reports carry it so a stack trace names the build it came from.
window.CC_VERSION = '1.0.0+1';

// Supabase (ADR-005/007): cloud saves and, later, accounts. The publishable
// key is PUBLIC by design — like the VAPID public key, it ships to every
// browser; row access is enforced by RLS in Postgres, not by hiding this.
// The secret key never appears anywhere under public/.
window.CC_SUPABASE_URL = 'https://onacdpaxcqdfxikxiecy.supabase.co';
window.CC_SUPABASE_KEY = 'sb_publishable_vrr31p7LCyzxygy6lb0ujQ_eqrlpmmR';
