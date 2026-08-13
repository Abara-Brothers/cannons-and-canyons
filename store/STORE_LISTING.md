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
> ★ No sign-up needed, no ads, no in-app purchases, no tracking. Tap and play.
>
> Made by Abara Brothers.

**Keywords (iOS, ≤100 chars):** `artillery,tank,duel,multiplayer,turn based,pixel,war,cannon,golf,battle`
**Category:** Games ▸ Strategy (secondary: Action)
**Age rating answers:** mild cartoon/fantasy violence only → expect **9+ (Apple)** / **Everyone 10+ (Google)**. No gambling, no user chat, **no user-authored text of any kind** — callsigns are generated from the game's own word lists and the input is readonly (ISSUE-015), so nothing a player types can reach another player. (Note the distinction from Play's *Data safety* form, where the callsign and progression are still "user-generated content" as a DATA TYPE: that is about what we store, not about players publishing text to each other.)

## 3. Privacy (both stores require this)

> **Rewritten 2026-08-07 (batch 8.50).** The original answers said "no data collected" —
> true before accounts existed, FALSE since 8.46–8.48 (guest/Google accounts, cloud
> saves, persisted push subscriptions). Filing the old answers now would be a
> misdeclaration on both stores (was ISSUE-018).

> **Revised 2026-08-13 (batch 8.54)** after a full re-review against the code and both
> platforms' current published requirements. Three material corrections: Google sign-in
> also delivers **name and profile picture** (verified empirically — the authorize URL
> requests scope `email profile`, and Supabase's GoTrue APPENDS to that default, so it
> cannot be narrowed from our side); Play requires a **web deletion link** as well as the
> in-app path; and the push subscription is a stored identifier that both forms should name.

- Hosted policy: `https://tanks.abarabrothers.com/privacy.html` (shipped in `public/`, reachable in-app from the home screen).
- **Account deletion URL (Play Console → App content → Data safety → Data deletion):**
  `https://tanks.abarabrothers.com/delete-account.html`. Play's policy requires BOTH an
  in-app path and a web resource usable by someone who has uninstalled the app; the page
  offers the in-app route and an email request route, and states exactly what is erased.
- **Apple App Privacy questionnaire — purpose App Functionality only:**
  - Data Linked to You:
    - *Identifiers → User ID* — the random account identifier (guest accounts included), and the Google account id when linked.
    - *Contact Info → Email Address* — ONLY when the player links Google (optional).
    - *Contact Info → Name* — ONLY when the player links Google: Google's `profile` scope returns the account name and we cannot opt out of it. We never display or use it, but it IS stored, so it must be declared.
    - *User Content → Photos or Videos* — the Google profile **picture URL**, on the same condition as above. If Apple's console offers a closer-fitting bucket for a provider avatar, prefer it; the requirement is that it is declared somewhere, not that this exact bucket is used.
    - *User Content → Other User Content* — callsign + progression (wins, achievements, unlocks). Callsign is generated, never typed.
  - Data NOT Linked to You:
    - *Diagnostics → Crash Data* — anonymous crash reports (error text, build version, user-agent; no account id, no IP stored; 30-day retention, since 8.52).
  - **Tracking: NO** for every item (nothing is used for cross-app tracking or advertising; no ads SDK, no analytics).
- **Google Play Data safety form:**
  - Collected: *User IDs* (account identifier + Google account id); *Personal info → Email address* and *Personal info → Name* (both only on Google linking); *Photos and videos* — the Google profile picture URL, if the console has no closer category; *App activity → Other user-generated content* (callsign, progression); *App info and performance → Crash logs* (anonymous, 30-day retention).
  - Shared: **none**. Sold: **none**. Processed ephemerally: live match relay (names/shots/aim, server memory only).
  - Security practices: data encrypted in transit; **users can delete in-app AND request deletion via the web link above**; account deletion erases account, sign-in identity, cloud save and push subscriptions in one action. Data export is also in-app.
- **Push notifications** — opt-in turn nudges. Since 8.48 the subscription (endpoint + keys) persists in the database keyed to the account, which makes it a stored device-scoped identifier: declare it under Apple *Identifiers → Device ID* and Play *Device or other IDs*, both Linked/Collected, purpose App Functionality. It is deleted with the account, and when the push service reports it dead. Declare notifications as a capability in both consoles; the "Turn notifications" section of `privacy.html` is the reviewer-facing description.
  - **Native builds today:** the web-push button is hidden inside Capacitor shells (ISSUE-020, batch 8.51) because a WKWebView has no PushManager, so a native build ships with NO push. Do not declare push data for a native submission until APNs/FCM lands — and re-check these answers when it does.
- **Sign in with Apple (App Store Guideline 4.8):** offering Google sign-in on iOS triggers the requirement to also offer an equivalent privacy-focused option. This bites the FIRST iOS submission, not a later one — Sign in with Apple must ship in the same build as Google sign-in, or Google sign-in must be hidden on iOS. Blocked on BQ-005 (paid Apple account).
- **International transfers:** hosting is Singapore (Supabase + Render), which has no EU/UK adequacy decision. Both providers' DPAs incorporate the EU SCCs (verified 2026-08-13: Supabase's DPA states acceptance of the agreement has the same effect as signing the SCCs and includes the UK Addendum v B.1.0; Render's DPA defines and applies the EU SCCs per Commission Decision 2021/914). `privacy.html` states this under "Where your data lives, and transfers".
- **Processors to disclose if asked:** Supabase (database + auth, Singapore), Render (game server, Singapore), Apple/Google/Mozilla push services (delivery only).
- **Seller / developer identity (confirmed 2026-08-13):**
  - Name: **Abara Brothers** — ASIC-registered business name
  - **ABN 92 261 932 217** (checksum verified)
  - Address: **11 Anne St, Southport QLD 4215, Australia**
  - Support: support@abarabrothers.com · https://abarabrothers.com/support
  - **Before enrolling, check the exact entity string on abr.business.gov.au.** If the ABN is
    held by a family trust, the record reads "The Trustee for …" rather than plainly "Abara
    Brothers"; Apple and Google verify the legal entity against that record and a mismatch
    stalls enrolment. Use the lookup string verbatim for the developer account, while the
    store's public *seller name* can remain "Abara Brothers".
- **Legal review status — analysed in-house, NOT lawyer-reviewed (owner decision 2026-08-13).**
  A full compliance analysis against primary sources lives at `docs/LEGAL_POSITION.md`. Headline
  conclusions: the studio is very likely **exempt** from the Australian Privacy Act small
  business threshold ($3M turnover, no exception applies) and should **not** opt in; the
  **statutory tort** (from 10 June 2025) and **Australian Consumer Law** apply regardless, which
  is why privacy copy must stay true after every data-touching feature; the OAIC **Children's
  Online Privacy Code** (final by 10 Dec 2026) binds APP entities only, so it does not bind us
  today but would apply immediately on crossing $3M. **Highest residual risk: COPPA** — a child
  can link Google with no age gate; a neutral age screen before Google sign-in is the
  recommended mitigation and is not yet built.

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
