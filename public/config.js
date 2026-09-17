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

// Where the IN-APP sign-in sheet on iOS hands the provider's reply back. Used
// ONLY when the native shell has registered the CCWebAuth plugin (cloud.js
// redirectTarget decides): the sheet is ASWebAuthenticationSession, which
// intercepts a navigation to this scheme INSIDE the app that opened it, so no
// other app is ever asked to open it. The scheme is the bundle id and the path
// mirrors the Universal Link one; house rule 8d pins both. This exact string
// must ALSO be listed under Supabase > Authentication > URL Configuration >
// Redirect URLs, or GoTrue refuses to send the player here.
window.CC_IOS_CALLBACK = 'com.abarabrothers.cannonsandcanyons://auth/callback';

// Stamped by `npm run version:sync` from package.json — do not edit by hand.
// Crash reports carry it so a stack trace names the build it came from.
window.CC_VERSION = '1.0.0+3';

// Supabase (ADR-005/007): cloud saves and, later, accounts. The publishable
// key is PUBLIC by design — like the VAPID public key, it ships to every
// browser; row access is enforced by RLS in Postgres, not by hiding this.
// The secret key never appears anywhere under public/.
window.CC_SUPABASE_URL = 'https://onacdpaxcqdfxikxiecy.supabase.co';
window.CC_SUPABASE_KEY = 'sb_publishable_vrr31p7LCyzxygy6lb0ujQ_eqrlpmmR';

// ---- iPad latch (ISSUE-039) ------------------------------------------------
// The HARD LANDSCAPE LOCK in styles.css rotates the whole page 90 degrees in a
// portrait window. That is right for a phone browser and WRONG on an iPad,
// where iPadOS 26 makes every app resizable and a rotated UI simply reads as
// broken. The CSS gates the shim off above 500px wide, which covers an iPad in
// portrait — but NOT a narrow Split View or Slide Over column, which is
// phone-width on a device that is emphatically not a phone.
//
// This closes that gap with the one inference the native shells make available
// for free: iOS pins the iPhone to landscape via UISupportedInterfaceOrientations
// and Android pins it via android:screenOrientation="sensorLandscape", so a
// portrait-SHAPED window in a NATIVE build can only be an iPad.
//
// LATCHED on purpose — the class is added, never removed. Dragging a Stage
// Manager window narrow must not flip the interface 90 degrees mid-drag, and a
// window that was once portrait tells us the device for the rest of the session.
//
// No Capacitor plugin, no Swift, no npm dependency, no inline script: this file
// is already the first script in index.html and already reads window.Capacitor.
try {
  var ccPlatform = (window.Capacitor && window.Capacitor.getPlatform
    && window.Capacitor.getPlatform()) || 'web';
  var ccNative = (ccPlatform === 'ios' || ccPlatform === 'android');
  var ccLatch = function () {
    if (ccNative && window.innerHeight > window.innerWidth) {
      document.documentElement.classList.add('cc-free');
    }
  };
  ccLatch();
  window.addEventListener('resize', ccLatch);
  window.addEventListener('orientationchange', ccLatch);
} catch (e) { /* leave the shim available — today's behaviour */ }
