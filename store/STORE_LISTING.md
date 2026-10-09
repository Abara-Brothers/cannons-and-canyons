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
**Apple subtitle (≤ 30 chars):** `Artillery duels, huge maps`  
**Google Play short description (≤ 80 chars):** `Artillery duels on colossal destructible maps. Learn it in one battle.`

**Note — not copy, do not paste.** Those are two different fields with two
different limits. They were previously written as one 30-character line, which
spent a third of Play's field and left the rest empty. Play's extra room is the
right place for the pick-up-and-play promise, since that is the question a store
visitor actually has. Everything in a blockquote below IS paste-ready copy.

**Full description:**

> Duel a friend across colossal destructible mountains.
>
> Cannons & Canyons is a turn-based online artillery battle. Pull back like a slingshot to set your aim and power, then arc shells over towering peaks. Crack the landscape open with bunker busters, rain down air strikes, burn ridgelines with napalm, or wall yourself in with earthworks. Every crater changes the battlefield — and the last tank standing wins.
>
> ★ Real-time online play — share a 4-letter code, or take on the computer
> ★ FIVE modes: duel, 4-player free-for-all, co-op boss fight, alien invasion, and nine holes of artillery golf
> ★ 13 military weapons — pick your five: mortars, railguns, cluster bombs, toxic gas, air strikes, tactical nukes
> ★ Fully destructible terrain that crumbles and collapses
> ★ Fire and poison that keep burning turn after turn
> ★ Health-based battles — destroy the enemy tank to win
> ★ Crisp HD pixel-art mountains across five biomes, phone + tablet, built for landscape
> ★ Easy to pick up — your first battle walks you through the shot, and a six-chapter field manual is always on hand
> ★ No sign-up needed, no ads, no in-app purchases, no tracking. Tap and play.
>
> Made by Abara Brothers.

**Keywords (iOS, ≤100 chars):** `artillery,tank,duel,multiplayer,turn based,pixel,war,cannon,golf,battle`
**Category:** Games ▸ Strategy (secondary: Action)
**Age rating answers:** mild cartoon/fantasy violence only → expect **9+ (Apple)** / **Everyone 10+ (Google)**. No gambling and no chat. **A player CAN put text in front of other players, from this release on:** any player may type their own callsign (since build 8 a guest may too, at most once a day), and everyone they play sees it. That is the whole of it — there is no message field in any mode. Until a player types one, they carry the name rolled for them on their first launch, and keep it. A typed callsign is checked on our server against a blocklist before a signed-in player's is stored and again every time any player's name enters a match, so a rejected name is never shown to anyone. Because a typed callsign is user-generated content, Apple Guideline 1.2 applies and all four obligations are answered in §3 below: filtering, **Report name**, **Block**, and the published contact support@abarabrothers.com. Wherever a questionnaire asks whether players can create content or interact with each other, answer **yes**. (ISSUE-015 removed the typed field in August 2026 and was REVERSED on 2026-09-18; any answer filed from the old text is out of date, and `test/house-rules.mjs` section 15 now fails the build if a shipped document says otherwise.)

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
    - *Identifiers → User ID* — the random account identifier (guest accounts included), and the Google account id or the Apple account identifier when linked (Sign in with Apple is offered in the iOS app only).
    - *Identifiers → Device ID* — **the name-reservation key (round 3, build 9).** The game server gives every install a random 256-bit key so it can hold that player's callsign before they have any account (a guest's anonymous account needs a sign-in Supabase limits per IP address). The device keeps the key; the server stores only its SHA-256 (`name_reservations.secret_hash`), beside the callsign and, once there is one, the account id. It is deleted with the account, or after 90 days without the player connecting when no account is linked. Linked to You, App Functionality, no tracking.
    - *Contact Info → Email Address* — ONLY when the player links Google or, in the iOS app, Apple (both optional). With Apple's Hide My Email it is a private relay address, which is still an email address to declare.
    - *Contact Info → Name* — ONLY when the player links Google: Google's `profile` scope returns the account name and we cannot opt out of it. We never display or use it, but it IS stored, so it must be declared. Sign in with Apple adds no name: the iOS app asks Apple for the email scope only (`requestedScopes = [.email]` in `ios/App/App/SceneDelegate.swift`).
    - *User Content → Photos or Videos* — the Google profile **picture URL**, on the same condition as above. If Apple's console offers a closer-fitting bucket for a provider avatar, prefer it; the requirement is that it is declared somewhere, not that this exact bucket is used.
    - *User Content → Other User Content* — callsign + progression (wins, achievements, unlocks). A callsign is either rolled from the game's word lists or typed by the player, in which case the server blocklist-filters it before it is shown to any other player. Friend links, friend requests, blocks and name reports belong in this bucket too. **From build 9 every player's callsign is reserved on the server** (`name_reservations`), guests included, so no two players can hold the same one, ignoring capitals and look-alike letters; the first to reserve a name keeps it, and a player whose name was taken is given an unused default and told so. A reservation with no linked account is deleted after 90 days unused.
    - **Guideline 1.2 applies from this release on.** A typed callsign is user-generated content, so the four obligations are answered at submission: filtering (the server blocklist, applied before a signed-in player's name is stored and at the door of every match for every player's name), reporting (Report name → `name_reports`), blocking (Block, both directions, with an Unblock list), and the published contact support@abarabrothers.com. The reviewer-facing version of all four is in `store/REVIEW_NOTES.md`. Wherever a questionnaire asks whether players can create content or contact each other, the answer is **yes — a callsign, and nothing else**: there is no chat, no message field and no way to send a message to another player.
    - *Usage Data → Product Interaction* — the **match ledger**: one row per ONLINE match, holding the
      mode, the account identifier of every player who had one (a guest's automatic account
      included), who won, the player count, whether a computer opponent was involved, the golf card
      where there is one, and when it ended. Offline Vs. Computer and solo Golf never reach a server
      and are absent by design. It is **kept
      permanently and is not swept** (it is the evidence base for server-derived entitlement) and it
      is **not erased when an account is deleted** — see the deletion note below and the
      "How long we keep it" section of `privacy.html`. If Apple's console offers a closer bucket for
      a game-results history, prefer it; the requirement is that it is declared, and as Linked to You.
  - Data NOT Linked to You:
    - *Diagnostics → Crash Data* — anonymous crash reports (error text, build version, user-agent; no account id, no IP stored; 30-day retention, since 8.52).
  - **Tracking: NO** for every item (nothing is used for cross-app tracking or advertising; no ads SDK, no analytics).
- **Google Play Data safety form:**
  - Collected: *User IDs* (account identifier + Google account id); *Device or other IDs* (from build 9: the SHA-256 of the random name-reservation key the server gives each install, beside that player's reserved callsign; deleted with the account, or after 90 days unused when no account is linked); *Personal info → Email address* and *Personal info → Name* (both only on Google linking); *Photos and videos* — the Google profile picture URL, if the console has no closer category; *App activity → Other user-generated content* (callsign — rolled or typed; progression; and, per account, the friend code, friend links, friend requests, blocks and name reports); *App info and performance → Crash logs* (anonymous, 30-day retention).
  - Collected (continued): *App activity → Other actions* (or the console's closest category for a
    game-results history) — the **match ledger**: one row per ONLINE match with the mode, the account
    identifier of every player who had one (a guest's automatic account included), the winner, the
    player count, whether a computer opponent was involved, the golf card where there is one, and the
    end time. The ledger is server-side only and no client can read it; it is the record that lets
    us verify anything a player earns by playing online. Kept permanently; see the deletion note
    below.
  - Shared: **none** with any third party. Sold: **none**. Processed ephemerally: the live match relay
    itself (shots, aim, movement and the names on the seats, in server memory only, discarded when the
    room ends) — the RESULT of an online match is not ephemeral, it is the ledger row above.
  - **Players can interact with each other: YES** (new with the friends release — wherever a console asks whether users can interact, share content or find one another, this answer was NO and must be changed before the next submission). Players add friends, search for a callsign, block and report. What one player ever sees about another is the **callsign**, the tank paint that player is using in a match with them, and whether that friend is online: never an email address, a real name, a Google profile, a friend code they were not given, or an account identifier. There is still no chat, no message field and no way to send a message to another player, so "users can share user-generated content" is answered as: the callsign, and nothing else. The moderation answer is filtering + report + block + support@abarabrothers.com, described in `store/REVIEW_NOTES.md`.
  - Security practices: data encrypted in transit; **users can delete in-app AND request deletion via the web link above**; account deletion erases account, sign-in identity, cloud save, push subscriptions, reserved callsign, friend code, friends, friend requests, blocks and name reports in one action. Data export is also in-app.
  - **What deletion does NOT erase, and both forms must say so:** the match-ledger rows above survive,
    still carrying the random account identifier. Everything that could join that identifier to a person
    — the account itself, the email address and the Google or Apple sign-in details held against it, the callsign, the
    progression, the friends, blocks and reports — is deleted, so nothing left in the database connects a
    surviving row to the player. State it this way rather than claiming deletion is total; `privacy.html`
    and `delete-account.html` carry the same sentence. **OWNER: the alternative is a code change** —
    strip the uuid from `players` and null `winner_user` inside `accountDelete` before the auth user
    goes — which would let all three documents claim total erasure. Not done here; this is the
    declared position until you choose otherwise.
- **Push notifications** — opt-in nudges for your turn and for squad invites from friends (one consent covers both; an invite shows the friend's callsign and the squad's size). Since 8.48 the subscription (endpoint + keys) persists in the database keyed to the account, which makes it a stored device-scoped identifier: declare it under Apple *Identifiers → Device ID* and Play *Device or other IDs*, both Linked/Collected, purpose App Functionality. It is deleted with the account, and when the push service reports it dead. Declare notifications as a capability in both consoles; the "Notifications" section of `privacy.html` is the reviewer-facing description.
  - **Native builds (updated 8.57):** Android now has REAL push via Firebase Cloud Messaging — the nudge button is back in the shell and registers an FCM token, stored in the same `push_subscriptions` table under `platform='android'`. So the push declarations above DO apply to an Android submission. Firebase is a processor to disclose: Google, for message delivery only.
  - **iOS (corrected 2026-10-09):** the server delivers iOS nudges straight to Apple's Push Notification service (APNs, over HTTP/2, not through Firebase), and the app carries the `aps-environment` entitlement, so push for iOS is built and `privacy.html` names APNs as the iOS route. **In build 1.0.0 (8) the opt-in is still hidden on iOS** (the `notifyBtn` gate in `public/app.js`, kept until a device has been seen to receive a nudge): this build never asks an iOS player for notification permission and stores no iOS device token. **OWNER:** build 8 on iOS collects no push token, so its App Privacy answers need not list one; the release that unhides the opt-in must add it, with Apple (APNs) as the processor, for message delivery only.
- **Sign in with Apple (App Store Guideline 4.8):** offering Google sign-in on iOS triggers the requirement to also offer an equivalent privacy-focused option. This bites the FIRST iOS submission, not a later one — Sign in with Apple must ship in the same build as Google sign-in, or Google sign-in must be hidden on iOS. **It ships (corrected 2026-10-09):** the iOS app offers Sign in with Apple first and Google second (`PROVIDERS` in `public/app.js`); web and Android offer Google only. Apple's native sheet asks for the email scope only, so Apple returns an identity token carrying the Apple account identifier and the email (a private relay address under Hide My Email), which goes from the device straight to Supabase's sign-in service and never through the game server. The birth-year check runs before an Apple sign-in or link exactly as before a Google one. The App Privacy answers above cover it (User ID, Email Address).
- **International transfers:** hosting is Singapore (Supabase + Render), which has no EU/UK adequacy decision. Both providers' DPAs incorporate the EU SCCs (verified 2026-08-13: Supabase's DPA states acceptance of the agreement has the same effect as signing the SCCs and includes the UK Addendum v B.1.0; Render's DPA defines and applies the EU SCCs per Commission Decision 2021/914). `privacy.html` states this under "Where your data lives, and transfers".
- **Processors to disclose if asked:** Supabase (database + auth, Singapore), Render (game server, Singapore), Apple/Google/Microsoft/Mozilla push services (delivery only; Microsoft's Windows Push Notification Services serves Edge; Apple's Push Notification service is also the iOS app's route, and Firebase Cloud Messaging, Google's, the Android app's).
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
  recommended mitigation — a neutral age screen before sign-in — **shipped in batch
  8.55**: the game asks for a birth year before every sign-in and every link, Google's and, in
  the iOS app, Apple's, stores and transmits nothing, and steers an under-13 answer back to
  guest play. It is described in the published
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
| Screenshots (iPhone 6.9"/6.5", iPad 13", Play phone + tablet) | `store/screenshots/run6/` — **9 frames for the App Store, 8 for Play** (Play caps at 8; `08-manual` is the one dropped). Run 6 re-shoots `07-home` for the Launch Bay front end: natively on the iPhone 17 Pro Max simulator, and web-rendered for iPad and Play; the eight gameplay/manual iPhone frames are carried from run 5's single-session masters (their content did not change), while every iPad and Play frame is re-rendered from the cutover build at exact store sizes. Includes the first-battle coach marks and the field manual. Supersedes run 5 | ✅ rendered + verified — **but do NOT upload the `ipad-13` set for build 1**: that build is iPhone-only (`UIDeviceFamily = [1]`), so App Store Connect has no iPad size class to accept them. Keep the frames; they become valid again when iPad ships. |
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
