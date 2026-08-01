# Cannons & Canyons — App Store & Google Play Launch Kit

Made by **Abara Brothers**. App ID: `com.abarabrothers.cannonsandcanyons`.

**Current direction:** a store release is still the plan, and the app ships
**free — no ads, no in-app purchases, no analytics**. Monetisation is deferred to
a later release; see §6. Everything below assumes that.

---

## 1. How the mobile apps are built (Capacitor wrapper)

The game is a self-contained web app + Node multiplayer server. The mobile apps
are thin native wrappers around it. **Recommended setup — remote wrapper**: the
app loads your deployed game URL, so every game update ships instantly with no
store re-review.

```bash
# One-time (requires Node, Xcode for iOS, Android Studio for Android)
npm i -D @capacitor/cli @capacitor/core @capacitor/ios @capacitor/android
npx cap add ios
npx cap add android

# 1. Deploy the game (Render/Railway/Fly — see README.md) and note the URL.
# 2. In capacitor.config.json: rename "_url" to "url" and set your deployed
#    HTTPS URL (also set public/config.js CC_SERVER if you ever bundle locally).
npx cap sync

# Icons + splash screens for BOTH stores from the SVG masters:
npm i -D @capacitor/assets
npx capacitor-assets generate --iconBackgroundColor '#0b1020' --splashBackgroundColor '#0b1020'
#   (masters: resources/icon.svg + resources/splash.svg — see §4)

npx cap open ios       # → Xcode: set signing team, then Product ▸ Archive
npx cap open android   # → Android Studio: Build ▸ Generate Signed Bundle (.aab)
```

Store accounts you (Jordan) must create — these cannot be automated:
- **Apple Developer Program** — developer.apple.com, US$99/yr
- **Google Play Console** — play.google.com/console, US$25 once

## 2. Store listing copy (paste-ready)

**Title:** Cannons & Canyons
**Subtitle / short description (30 chars):** `Artillery duels, huge maps`
**Full description:**

> Duel a friend across colossal destructible mountains.
>
> Cannons & Canyons is a turn-based online artillery battle. Drag to aim, charge your shot, and arc shells over towering peaks. Crack the landscape open with bunker busters, rain down air strikes, burn ridgelines with napalm, or wall yourself in with earthworks. Every crater changes the battlefield — and the last tank standing wins.
>
> ★ Real-time online play — share a 4-letter code, or take on the computer
> ★ FIVE modes: duel, 4-player free-for-all, co-op boss fight, alien invasion, and nine holes of artillery golf
> ★ 13 military weapons — pick your five: mortars, railguns, cluster bombs, toxic gas, air strikes, tactical nukes
> ★ Fully destructible terrain that crumbles and collapses
> ★ Fire and poison that keep burning turn after turn
> ★ Health-based battles — destroy the enemy tank to win
> ★ Crisp HD pixel-art mountains across five biomes, phone + tablet, built for landscape
> ★ No account, no ads, no in-app purchases, no tracking. Tap and play.
>
> Made by Abara Brothers.

**Keywords (iOS, ≤100 chars):** `artillery,tank,duel,multiplayer,turn based,pixel,war,cannon,golf,battle`
**Category:** Games ▸ Strategy (secondary: Action)
**Age rating answers:** mild cartoon/fantasy violence only → expect **9+ (Apple)** / **Everyone 10+ (Google)**. No gambling, no user chat, no user-generated content, no data collection.

## 3. Privacy (both stores require this)

- Hosted policy: `https://<your-deployed-host>/privacy.html` (shipped in `public/`).
- **Apple App Privacy questionnaire:** "Data Not Collected" across the board (no identifiers, no tracking, no ads SDK; display name is ephemeral session data not linked to identity).
- **Google Data safety form:** No data collected, no data shared; data (display name, match state) is processed in transit only and not stored.
- **Push notifications** — the game offers opt-in turn nudges via the Web Push API. The subscription is held in server memory for the life of the match and discarded with it; nothing is written to disk (only the server's own VAPID keypair is). This does not change either answer above, but declare notifications as a capability in both consoles, and be ready to point a reviewer at the "Turn notifications" paragraph of `privacy.html`.

## 4. Assets checklist

Full detail — concepts, sizes, and how each was produced — is in
[`DESIGN-ASSETS.md`](DESIGN-ASSETS.md).

| Asset | Source | Status |
|---|---|---|
| App icon master (1024×1024) | `resources/icon.svg` (copy of `public/icons/icon.svg`) | ✅ original art |
| Splash master (2732×2732) | `resources/splash.svg` | ✅ original art |
| Production icon set (iOS 1024, Play 512, adaptive, PWA) | `store/export/` | ✅ rendered + verified |
| Google feature graphic (1024×500) | `store/export/android/feature-graphic-1024x500.png` | ✅ rendered |
| Screenshots (iPhone 6.9"/6.5", iPad 13", Play phone + tablet) | `store/screenshots/run2/` — 5 frames per device class, captured from the live canvas | ✅ rendered |
| Splash screens for the Capacitor wrapper | `npx capacitor-assets generate` | ⬜ outstanding — needs the icon concept locked first |
| PWA manifest + icons (Android quality bar) | `public/manifest.webmanifest`, `public/icons/` | ✅ |

> **Decision still open:** three app-icon concepts were rendered and compared; the
> export set is currently built from concept A. See §1 of `DESIGN-ASSETS.md`.

## 5. Device compatibility statement

The game targets **iOS 14+ / Android 8+ (API 26+)** WebViews and uses only
broadly-supported web APIs: Canvas 2D, WebSocket, Pointer Events, Web Audio,
localStorage. **The game is landscape-only by design** — held in portrait it
shows a rotate prompt rather than a reflowed layout, which is deliberate and
should be declared as such (iOS: landscape-only orientations; Play: the listing
screenshots are all landscape). Verified behaviors: safe-area insets (notches),
touch drag/pinch, audio unlock on first gesture, background-tab recovery, and
automatic match resume after disconnects.
Final certification requires running the store builds on physical devices via
Xcode/Android Studio — checklist: launch, rotate (expect the rotate prompt in
portrait), background/foreground mid-match, network drop mid-match (should
auto-resume), notch overlap.

## 6. Monetisation: none in this release

The app ships **free with no ads, no in-app purchases and no analytics SDKs**.
Answer both stores' commerce questions accordingly — no IAP products to
configure, no ad network disclosures, and Google Play's "Contains ads" flag stays
off. Every cosmetic in the game is earned by playing (see the achievements and
the WARLORD paint drop); nothing in the build references a shop, a price or a
purchase, and there is no dormant purchase code to explain to a reviewer.

Monetisation is deferred to a later release. When it is revisited it will be a
deliberate decision made against a shipped, played game — at which point this
section is the place to write down what was chosen and why.

## 7. Copyright & trademark audit (clean ✅)

- **Name/brand:** "Cannons & Canyons" + Abara Brothers — original; zero references to any existing game trademark anywhere in the shipped app, store copy, or docs (audited by grep). *2026-07-28: the iOS keyword list previously carried a competitor's trademark; it was removed. Keyword fields count as store copy — re-grep them, not just the app.*
- **Code:** 100% written for this project. Runtime dependencies are `ws` and `web-push` (both MIT licensed — compatible with commercial use).
- **Art:** all graphics are original inline SVG/canvas drawings; app icon and splash are original. No third-party sprites, fonts (system font stack only), or images.
- **Audio:** synthesized in-engine via Web Audio — no samples.
- **Gameplay:** artillery mechanics as a genre are not copyrightable; no cloned assets, names, or text from any existing title.
- Recommendation: run trademark searches for "Cannons & Canyons" in AU/US classes 9/41 before spending on marketing, and keep this audit note with your launch records.
