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
> **There is no chat. The only thing a player can type is their own callsign.** A callsign is
> 3 to 16 characters — letters, digits and spaces — and only a signed-in player can set one; a
> player who does not set one is given a name rolled from the game's own word lists. A typed
> callsign is checked on our server against a blocklist before it is stored, so a rejected name
> is never visible to anyone. Wherever another player is shown there is a menu with **Report
> name** and **Block**, and both work without an account. There is no message field of any kind,
> in any mode: the callsign is the whole of what one player can put in front of another.
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

**Chosen callsigns, friends, reporting and blocking (new in this version):** a signed-in player
may set their own callsign instead of rolling one. It is 3 to 16 characters — Unicode letters,
digits and spaces — unique across the game, changeable once a day, and rejected if a folded form
of it (diacritics stripped, look-alikes mapped — 0/o, 1/i, 3/e, 4/a, 5/s, 7/t, @/a, $/s, |/i —
and everything but a letter removed) contains any term in the server's blocklist file. The check
runs on the server before the name is stored, so a name that fails is never shown to anyone,
including the player's opponents. A player who has not signed in keeps a rolled name. Players add
each other with a 6-character friend code or by searching for an exact callsign. Every player
card — friends list, search result, lobby seat, in-match card — carries a menu with **Report
name** and **Block**, so a player can report or block any player they are in a match with and not
only a friend. Report files the name exactly as it was seen. Block stops the blocked player
finding or contacting you — callsign search, add-by-code, friend requests, presence and the
friends panel, in both directions — and the Friends screen lists blocked players with an Unblock
control. Block does not exclude the two from being matched into the same battle, and the in-app
copy says so rather than letting a player assume otherwise. **Reporting and blocking need no
account**: a guest who sees an offensive name in a lobby can use both. Setting a callsign and
using friends do need a signed-in account. The published contact for any report or complaint is
support@abarabrothers.com.

**Where do name reports actually go?** We would rather state this plainly than imply a mailbox
we do not have. The game has no email provider, so nothing is emailed. A report is written as a
row in our Supabase database — reporter, reported account, the callsign as seen, timestamp — and
printed to the game server's log. The owner reads new rows in the Supabase dashboard as part of
the same routine that checks the server, and acts within 7 days by clearing the offending
callsign, adding the term to the blocklist, or both. The two accounts' identifiers never leave
that table and that log.

**Offline:** Vs. Computer and solo Golf run entirely on-device with no network — the same
match engine the server runs is loaded into the app. Every other mode says plainly that
it needs a connection rather than hanging.

## Things that look like bugs and are not

Worth knowing before a reviewer files them:

- **Portrait renders sideways** on the web build — by design (see above).
- **The callsign row in Bay controls carries two buttons.** **Roll** takes a new name from the
  word lists; **Set** is how a signed-in player types one instead. A typed name goes through the
  server's blocklist check before it is stored, and can be changed again a day later. A guest is
  shown the rule rather than a Set button that could only ever fail.
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

- **iPhone only, deliberately, for this build.** `TARGETED_DEVICE_FAMILY` is `1` and the
  binary reports `UIDeviceFamily = [1]`, so the app installs on iPad in iPhone
  compatibility mode. This is a sequencing decision, not an omission. iPadOS 26 removed
  the ability for an iPad-capable app to opt out of being resizable — Apple's TN3192
  deprecates `UIRequiresFullScreen` and the system ignores it — so the landscape-only
  iPad configuration this app previously declared is no longer a supported one, and an
  iPad-capable bundle whose `~ipad` orientation list is not all four orientations is the
  ITMS-90474 rejection. Rather than ship an iPad build whose UI renders rotated in a
  portrait or Split View window, iPad support is held until the layout genuinely reflows
  on its true axes. The stale landscape-only `UISupportedInterfaceOrientations~ipad`
  array has been removed rather than left behind, because leaving it is exactly what
  would re-create ITMS-90474 the day the device family goes back to `1,2`.
- **No screen-reader support for the battlefield.** It is a canvas game; the menus and
  panels are standard DOM and are labelled.
