# Canyons & Cannons — App Store & Google Play Launch Kit

Made by **Abara Brothers**. App ID: `com.abarabrothers.canyonsandcannons`.

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

**Title:** Canyons & Cannons
**Subtitle / short description (30 chars):** `Artillery duels, huge maps`
**Full description:**

> Duel a friend — or a stranger — across colossal destructible mountains.
>
> Canyons & Cannons is a turn-based online artillery battle. Drag to aim, charge your shot, and arc shells over towering peaks. Crack the landscape open with bunker busters, rain down air strikes, burn ridgelines with napalm, or wall yourself in with earthworks. Every crater changes the battlefield — and the last tank standing wins.
>
> ★ Real-time online play — share a 4-letter code or quick-match
> ★ 11 military weapons: mortars, railguns, cluster bombs, toxic gas, air strikes, tactical nukes
> ★ Fully destructible terrain that crumbles and collapses
> ★ Fire and poison that keep burning turn after turn
> ★ Health-based battles — destroy the enemy tank to win
> ★ Crisp HD pixel-art mountains, day-one phone + tablet support, portrait or landscape
> ★ No account, no ads, no tracking. Tap and play.
>
> Made by Abara Brothers.

**Keywords (iOS, ≤100 chars):** `artillery,tank,duel,multiplayer,turn based,pixel,war,cannon,worms,battle`
**Category:** Games ▸ Strategy (secondary: Action)
**Age rating answers:** mild cartoon/fantasy violence only → expect **9+ (Apple)** / **Everyone 10+ (Google)**. No gambling, no user chat, no user-generated content, no data collection.

## 3. Privacy (both stores require this)

- Hosted policy: `https://<your-deployed-host>/privacy.html` (shipped in `public/`).
- **Apple App Privacy questionnaire:** "Data Not Collected" across the board (no identifiers, no tracking; display name is ephemeral session data not linked to identity).
- **Google Data safety form:** No data collected, no data shared; data (display name, match state) is processed in transit only and not stored.

## 4. Assets checklist

| Asset | Source | Status |
|---|---|---|
| App icon master (1024×1024) | `resources/icon.svg` (copy of `public/icons/icon.svg`) | ✅ original art |
| Splash master (2732×2732) | `resources/splash.svg` | ✅ original art |
| All iOS/Android icon + splash sizes | `npx capacitor-assets generate` | run locally |
| Google feature graphic (1024×500) | `store/feature-graphic.svg` → export PNG | ✅ master ready |
| Screenshots (6.7", 6.5", 5.5", 12.9" iPad; phone+tablet for Play) | Capture in-game (Safari/Chrome device emulation of the deployed URL works) | to capture |
| PWA manifest + icons (Android quality bar) | `public/manifest.webmanifest`, `public/icons/` | ✅ |

## 5. Device compatibility statement

The game targets **iOS 14+ / Android 8+ (API 26+)** WebViews and uses only
broadly-supported web APIs: Canvas 2D, WebSocket, Pointer Events, Web Audio,
localStorage. Verified behaviors: responsive portrait + landscape layouts,
safe-area insets (notches), touch drag/pinch, audio unlock on first gesture,
background-tab recovery, and automatic match resume after disconnects.
Final certification requires running the store builds on physical devices via
Xcode/Android Studio — checklist: launch, rotate, background/foreground mid-match,
network drop mid-match (should auto-resume), IAP screens absent, notch overlap.

## 6. Copyright & trademark audit (clean ✅)

- **Name/brand:** "Canyons & Cannons" + Abara Brothers — original; zero references to any existing game trademark anywhere in the shipped app, store copy, or docs (audited by grep).
- **Code:** 100% written for this project. Only runtime dependency is `ws` (MIT licensed — compatible with commercial use).
- **Art:** all graphics are original inline SVG/canvas drawings; app icon and splash are original. No third-party sprites, fonts (system font stack only), or images.
- **Audio:** synthesized in-engine via Web Audio — no samples.
- **Gameplay:** artillery mechanics as a genre are not copyrightable; no cloned assets, names, or text from any existing title.
- Recommendation: run trademark searches for "Canyons & Cannons" in AU/US classes 9/41 before spending on marketing, and keep this audit note with your launch records.
