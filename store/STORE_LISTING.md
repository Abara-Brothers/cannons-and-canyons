# Cannons & Canyons — App Store & Google Play Launch Kit

Made by **Abara Brothers**. App ID: `com.abarabrothers.cannonsandcanyons`.

**Current direction:** a store release is still the plan, and the app ships
**free — no ads, no in-app purchases, no analytics**. Monetisation is deferred to
a later release; see §6. Everything below assumes that.

---

## 1. How the mobile apps are built (Capacitor wrapper)

The game is a self-contained web app + Node multiplayer server. The mobile apps
are thin native wrappers around it, and **the assets are BUNDLED into the app,
not loaded from a URL.**

> **Rewritten 2026-08-15.** This section previously recommended a *remote
> wrapper* — pointing the shell at the deployed URL. **Do not do that.** It is
> ADR-006 option B, which was rejected: it kills offline play entirely and
> invites an App Store 4.2 rejection for shipping a repackaged website.
> `capacitor.config.json` carries a standing note forbidding `server.url` for
> exactly this reason. Updates reach shipped apps over the air (ADR-006 option
> C), not by pointing the app at a web server. The old text also told you to run
> `npx cap add` (both native projects already exist and are committed, with
> hand-tuned Info.plist and manifest entries that a re-add would discard) and to
> regenerate assets with `@capacitor/assets`, which would **overwrite the
> branded icon and the 8.60 splash screens**.

Both native projects are already in the repo. The normal build loop is:

```bash
npm run version:sync    # keeps package.json, iOS, Android and config.js in step
npx cap sync            # copies public/ into both shells

npx cap open ios        # → Xcode: set signing team, then Product ▸ Archive
npx cap open android    # → Android Studio: Build ▸ Generate Signed Bundle (.aab)
```

Gradle needs **JDK 21** (Capacitor 8 requires 21, not 17):

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  ./gradlew assembleDebug
```

The multiplayer host the shells talk to is `CC_NATIVE_HOST` in `public/config.js`
— that is the only place a server URL belongs.

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
  - **Native builds (updated 8.57):** Android now has REAL push via Firebase Cloud Messaging — the nudge button is back in the shell and registers an FCM token, stored in the same `push_subscriptions` table under `platform='android'`. So the push declarations above DO apply to an Android submission. **iOS still ships without push** (APNs needs the paid Apple account, BQ-005); leave push out of the first iOS submission unless it lands first. Firebase is a processor to disclose: Google, for message delivery only.
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
  today but would apply immediately on crossing $3M. **Highest residual risk: COPPA.** The
  recommended mitigation — a neutral age screen before Google sign-in — **shipped in batch
  8.55**: the game asks for a birth year before either Google entry point, stores and transmits
  nothing, and steers an under-13 answer back to guest play. It is described in the published
  privacy policy under *Children* (added 2026-08-15, so the policy matches what the code does
  and the mitigation can be cited to either store). Residual risk remains — an age screen is a
  declaration, not verification — and is accepted by the owner in `docs/LEGAL_POSITION.md` §3.

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
| Splash screens for the Capacitor wrapper | `bash tools/splash/make-splash.sh --install` | ✅ rendered + installed in both native projects (2026-08-14) |
| PWA manifest + icons (Android quality bar) | `public/manifest.webmanifest`, `public/icons/` | ✅ |

> **Do NOT run `npx capacitor-assets generate` for splashes.** It was listed here
> as the outstanding step, but the splash screens are already done and installed:
> `android/app/src/main/res/**/splash.png` and `ios/App/App/Assets.xcassets/Splash.imageset/`
> were written by `tools/splash/make-splash.sh --install` on 2026-08-14. That script
> renders the real template at every density; `capacitor-assets` would overwrite all
> of it with its own output from `resources/splash.svg`. Regenerate with the script.

> **Decision still open:** three app-icon concepts were rendered and compared; the
> export set is currently built from concept A. See §1 of `DESIGN-ASSETS.md`.

## 5. Device compatibility statement

The shipped minimums are **iOS 15.0** and **Android minSdk 24 (Android 7.0)**,
compiling and targeting API 36.

> **Corrected 2026-08-15.** This section previously said "iOS 14+ / Android 8+
> (API 26+)" — wrong in *both directions*, and the iOS one mattered: advertising
> iOS 14 support for a build with a 15.0 deployment target promises a device it
> cannot install on. Android was the opposite: the build supports API 24, two
> levels lower than the listing claimed. Take the numbers from
> `IPHONEOS_DEPLOYMENT_TARGET` and `android/variables.gradle`, never from here.

The game uses only broadly-supported web APIs: Canvas 2D, WebSocket, Pointer
Events, Web Audio, localStorage.

**The game is landscape-only by design**, and should be declared as such (iOS:
landscape-only orientations; Play: every listing screenshot is landscape). **There
is no rotate prompt** — the old one was retired when the CSS rotate shim replaced
it, and its stylesheet rule is now behind a media query that can never match. In
the packaged apps the OS locks orientation, so portrait never reaches the app at
all; on the web build the whole UI rotates 90° instead of reflowing.

Verified behaviours: safe-area insets (notches), touch drag/pinch, audio unlock on
first gesture, background-tab recovery, and automatic match resume after
disconnects.

Final certification requires running the store builds on physical devices via
Xcode/Android Studio — checklist: launch, **rotate (expect the layout to stay
upright and landscape — do NOT expect a rotate prompt; there isn't one, and the
old wording here would have had a tester file that as a bug)**,
background/foreground mid-match, network drop mid-match (should auto-resume),
notch overlap.

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
