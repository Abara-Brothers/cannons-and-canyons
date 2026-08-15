# Notes for App Review / Play review

> Paste the relevant part into the "Notes for Review" field at submission. Written
> 2026-08-15 from the shipping code, not from the marketing copy. Keep it short in the
> field itself — the detail below is here so whoever submits can answer follow-ups.

## The short version (safe to paste as-is)

> **No account is needed.** Every mode is reachable without signing in. Sign-in is
> optional and only saves progress across devices — there is no review test account
> because there is nothing to unlock.
>
> **The game is landscape-only by design.** Both builds are locked to landscape at the
> OS level, so the device will rotate the app for you.
>
> **You do not need a second device to review it.** Four of the five modes are playable
> solo: Duel against the computer, Boss Fight, Alien Invasion and Artillery Golf. Only
> Free-for-all needs a second human.
>
> **To play a full match in about a minute:** on the home screen tap **Duel** (already
> selected) → **Vs. Computer** → **START VS COMPUTER**. The Armoury opens first — tap
> **Save loadout** to accept the default five weapons. You always take the first shot.
> Use ANGLE and POWER in the CONTROLS drawer, then the red **FIRE** button.
>
> **There is no chat and no free-text input anywhere.** Player names are chosen from the
> game's own word lists — the field is read-only and re-rolled with the shuffle button —
> so nothing a player types can reach another player.
>
> **The game is free.** No ads, no in-app purchases, no analytics SDKs. Every cosmetic is
> earned by playing.
>
> **iOS build only:** this version ships **without push notifications**. There is no APNs
> entitlement and the "nudge me" option is hidden on iOS. Push is Android-only for now.

## If a reviewer asks

**Why does the app look sideways in a browser?** It won't in your build. The packaged
iOS and Android apps are OS-locked to landscape, so portrait never reaches the app. The
web version rotates its whole UI 90° instead of reflowing, which is deliberate — it is
the same game, and turning the device makes it upright. There is no "please rotate"
prompt by design.

**Where is the age gate?** It appears only when a player chooses to sign in with Google,
never at launch and never before play. It asks for a birth year, neutrally. The year is
**never stored and never transmitted** — only a local "this was answered" flag. Under 13,
the app explains that the player can keep playing as a guest.

**What data does the app collect?** For a guest: nothing personal — a random identifier,
a generated callsign, and gameplay counters. If a player links a Google account, the
OAuth scope also returns their email, Google id, name and picture; the scope cannot be
narrowed, and the name and picture are never displayed anywhere in the app. Crash reports
carry no account id and no IP address, and are deleted after 30 days. Match state lives
in server memory only and is never written to a database. Export and deletion are both
available in-app, and the deletion page is reachable without signing in.

**Multiplayer:** matches are joined with a 4-character code from an ambiguity-free
alphabet, shared as a link or typed in. A room is joinable only while it is waiting.
Disconnects are covered by a 2-minute grace period; duels can be resumed asynchronously
for 24 hours.

**Offline:** Vs. Computer and solo Golf run entirely on-device with no network — the same
match engine the server runs is loaded into the app. Every other mode says plainly that
it needs a connection rather than hanging.

## Things that look like bugs and are not

Worth knowing before a reviewer files them:

- **Portrait renders sideways** on the web build — by design (see above).
- **The callsign field is read-only.** Names are rolled, not typed. This is the reason
  there is no user-generated text in the product at all.
- **The controls drawer starts collapsed** every match; the CONTROLS tab nudges until it
  has been opened once.
- **The camera never follows a shot** — except the end-of-match killcam. This is
  deliberate: you aim by reading the whole battlefield.
- **There is no turn timer.** The only clock is the 25-second Armoury draft, which issues
  defaults if it expires.
- **Shells pass through teammates** in co-op modes; friendly fire is structurally zero.
- **The drive buttons do nothing in Golf.** Golf has no movement.
- **The Railgun never appears in the Armoury** — it only drops from supply crates.
- **Three tank paints start locked** and explain their unlock condition when tapped.
- **Supply crates can be shot open** to deny them to an opponent.
- **Sign-out and account deletion use the system confirm dialog** — deliberate, because
  they are destructive.
- **Answering "under 13" is recoverable** — re-opening sign-in restores the option, so a
  parent can complete it.
- **A deploy ends live matches** and the app says so rather than silently dropping you.
- **Offline lobbies show no room code**, because there is no room to join.
- The join field accepts a 3-character code although the label says 4. Cosmetic only.

## Known limitations we would rather disclose than have found

- **iPad orientation.** The app declares landscape-only for iPad but does not set
  `UIRequiresFullScreen`, so iPadOS treats it as resizable and will not enforce that. An
  iPad held in portrait shows the landscape UI rotated and letterboxed until it is
  turned. Under review before submission.
- **No screen-reader support for the battlefield.** It is a canvas game; the menus and
  panels are standard DOM and are labelled.
