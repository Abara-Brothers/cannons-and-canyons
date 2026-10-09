# Notes for App Review / Play review

> Paste the relevant part into the "Notes for Review" field at submission. Written
> 2026-08-15 from the shipping code, not from the marketing copy. Keep it short in the
> field itself — the detail below is here so whoever submits can answer follow-ups.

> **OWNER — read this before you paste.** TWO things ARE behind sign-in from this release (Sign in
> with Apple or Google in the iOS app, Google on Android):
> the Friends screen (with a unique callsign other players can search for), and starting a squad or
> inviting friends to one (joining a squad by its code or link needs no account). Since build 8
> every player may type their own callsign, a guest included. Apple Guideline 2.1 expects working demo
> credentials for anything behind a login, so decide before submitting whether to supply a test
> account or to say you will provide one on request, and add that line to the block below.
> The sentence that used to stand here — "there is no review test account because there is nothing
> to unlock" — was true before 2026-09-18 and is false now.

## The short version (safe to paste as-is)

> **No account is needed to play**, and none is needed to report a callsign or block a player
> either. Every mode is reachable without signing in. Signing in is optional (in the iOS app with
> Sign in with Apple or Google; on Android with Google). It
> saves progress across devices and it adds exactly two things: the Friends screen, where friends
> find each other by a unique callsign or a friend code, and starting a squad or inviting friends to one.
> **Joining** a squad or a game by its code or link stays open to everyone, signed in or not. No
> mode, weapon, level or gameplay feature is behind it.
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
> 3 to 16 characters — letters, digits and spaces — and any player may set one, at most once a day;
> a player who does not is given a name rolled from the game's own word lists, once, and keeps it.
> A typed callsign is checked on our server against a blocklist before a signed-in player's is
> stored, and again every time any player's name enters a match, so a rejected name is never
> visible to anyone. Wherever another player is shown there is a menu with **Report
> name** and **Block**, and neither needs a signed-in account: the automatic account the game
> gives every player once they start playing is enough, so a guest can use both. There is no
> message field of any kind, in any mode: the callsign is the whole of what one player can put in
> front of another.
>
> **The game is free.** No ads, no in-app purchases, no analytics SDKs. Every cosmetic is
> earned by playing.
>
> **iOS build only:** this version does not offer notifications on iOS. The "nudge me" option is
> hidden there, so the app never asks for notification permission and no notification is sent to
> an iOS device. The Push Notifications entitlement is in the app, and our server can deliver
> through Apple's Push Notification service, for when that option is switched on in a later build.

## If a reviewer asks

**Why does the app look sideways in a browser?** It won't in your build. The packaged
iOS and Android apps are OS-locked to landscape, so portrait never reaches the app. The
web version rotates its whole UI 90° instead of reflowing, which is deliberate — it is
the same game, and turning the device makes it upright. There is no "please rotate"
prompt by design.

**Where is the age gate?** It appears only when a player chooses to sign in or link an account,
with Apple or Google, never at launch and never before play. It asks for a birth year, neutrally. The year is
**never stored and never transmitted** — only a local "this was answered" flag. Under 13,
the app explains that the player can keep playing as a guest.

**What data does the app collect?** For a player who never signs in: a random account identifier,
their callsign, and gameplay counters — nothing that identifies a person. That account can also
hold the blocks and the name reports that player made, since both tools work without signing in.
If a player links a Google account, the OAuth scope also returns their email, Google id, name and
picture; the scope cannot be narrowed, and the name and picture are never displayed anywhere in
the app. If a player signs in with Apple (iOS app only), the app asks Apple for the email scope
only: Apple's identity token carries the Apple account identifier and the email address (a private
relay address under Hide My Email) and no name, and it goes from the device straight to our
sign-in provider, never through the game server. A signed-in account additionally holds a 6-character friend code, the callsign they set
and the day they set it, their friends, their pending friend requests, their blocks, and any name
reports they filed or that were filed about them. Crash reports carry no account id and no IP
address, and are deleted after 30 days. The live match relay — shots, aim, movement and the names
on the seats — is held in server memory only and is discarded when the room ends; the RESULT of an
ONLINE match is a row in a server-side ledger, carrying the account identifier of every player who
had one (a guest's automatic account included) and who won, kept permanently, and readable only by
our server — it is the record that lets us verify anything a player earns by playing online. No
client can read it. Offline Vs. Computer and solo Golf never
reach a server and leave no row. Export and deletion are both available in-app, and the deletion
page is reachable without signing in; deletion erases everything except those ledger rows, which
keep the random identifier once everything that could join it to a person has gone.

**Multiplayer:** matches are joined with a 4-character code from an ambiguity-free
alphabet, shared as a link or typed in. A room is joinable only while it is waiting.
Disconnects are covered by a 2-minute grace period; duels can be resumed asynchronously
for 24 hours.

**Chosen callsigns, friends, reporting and blocking (new in this version):** any player may set
their own callsign instead of keeping the one rolled for them. It is 3 to 16 characters — Unicode
letters, digits and spaces — changeable once a day, and rejected if a folded form
of it (diacritics stripped, look-alikes mapped — 0/o, 1/i, 3/e, 4/a, 5/s, 7/t, @/a, $/s, |/i —
and everything but a letter removed) contains any term in the server's blocklist file, or if it
passes for one of the game's own names (a computer player's, such as "CPU 2"). A signed-in
player's callsign is also unique across the game; a guest's is kept on their own device, and may
not be a callsign a signed-in player holds. The check
runs on the server, before a signed-in player's name is stored and again at the door of every
match for every player's name, so a name that fails is never shown to anyone, including the
player's opponents. Players add
each other with a 6-character friend code or by searching for an exact callsign. Every player
card — friends list, search result, lobby seat, in-match card — carries a menu with **Report
name** and **Block**, so a player can report or block any player they are in a match with and not
only a friend. Report files the name exactly as it was seen. Block stops the blocked player
finding or contacting you — callsign search, add-by-code, friend requests, presence and the
friends panel, in both directions — and the Friends screen lists blocked players with an Unblock
control. Block does not exclude the two from being matched into the same battle, and the in-app
copy says so rather than letting a player assume otherwise. **Reporting and blocking do not need a
signed-in account**: the automatic account the game creates for every player is enough, so a guest
who sees an offensive name in a lobby can use both without ever signing in. That automatic account
is created lazily, on the first shot a player takes, so someone who has just installed the game and
joined a room without firing yet does not have one and the menu asks them to sign in until they do
— see the note in "Things that look like bugs and are not". Using friends does need a signed-in
account; setting a callsign does not. The published contact for any report or complaint is
support@abarabrothers.com.

**Squads and invites (new in this version):** a signed-in player can gather up to three friends into a
squad — a group of at most four that persists across matches. The leader picks a mode the squad fits
(Duel seats two, Free-for-all two to four, Boss Fight and Alien Invasion one or two, Artillery Golf one
to four) and, once every member is ready, starts; the server places every member in the same room in one
step, and after the match they are back in the squad. A squad has a 4-character code and a link, from
the same ambiguity-free alphabet as a game code, and the one code field in the Squad box takes either
kind of code and opens whichever it turns out to be. **A player who has not signed in can join a squad
or a game by its code or link, but cannot start a squad, invite anyone or be invited.**

An invite goes to a friend, or to a signed-in player whose exact callsign the inviter types, and it
is never delivered to a player who has blocked, or been blocked by, anyone in the squad. If a friend
has the game open, the invite appears there; if not, and they have turned notifications on, it
arrives as a notification reading `<callsign> invites you to their squad (n of 4).` It carries the
squad's link and no personal data beyond the inviter's callsign, which is already public inside the
game, and it has its own notification key, so it does not replace an unread turn alert. An invite
from a player who is NOT a friend is never sent as a notification: it appears only if the player has
the game open at that moment, the inviter is told the same thing whether or not anyone saw it (so it
reveals nothing about who is online), and the invite carries the same Report name and Block menu as
every other player card. Squads live only in the game server's
memory: there is no squad table, nothing about a squad itself is written to the database (a match a
squad plays is recorded like any other online match), and every squad ends when the server restarts,
which the app says plainly rather than leaving a stale group on screen. Friends are unaffected by that
and are stored, as before, only as links between accounts.

Every signed-in squad member, and every row on the Squad box's Friends tab, carries the same
menu as every other player card, with **Report name** and **Block**, and the leader can remove any
member. A member who has not signed in is listed by the name the game shows them by in a match, held
to the same server checks, or as "No callsign" when there is none. Blocking someone you share a squad with removes one of you from it immediately: if you
lead the squad they are removed as if kicked, otherwise you leave it. Neither player is told that a
block caused it, and the blocked account cannot rejoin by code, be invited back, or sign in to a squad
seat beside you. Squad members are shown by callsign only: another player's app receives each
signed-in member's random account identifier, which the menu needs in order to report or block them
(an invite from a player who is not a friend carries the inviter's, for the same menu), and never an
email address or any Google or Apple sign-in detail.

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
- **Report and Block can ask a brand-new player to sign in.** The game creates its automatic
  account lazily — on the first shot that resolves — so a player who installed the game, joined an
  online room and has not fired yet has no account at all, and the seat menu says "Sign in to report
  or block a player." rather than offering a button that could only fail. After the first shot both
  work with no sign-in. **OWNER, BEFORE SUBMITTING:** in that same first-run state on ANDROID the
  "Sign in" button that menu offers does nothing, because `SIGNIN_PLATFORMS` is `['web','ios']` and
  `accountBtn.onclick` returns immediately when it cannot sign in (`public/app.js`). A dead control
  in the Guideline 1.2 path is the one a reviewer is most likely to press. The fix is client-side and
  was not in this group's scope: either mint the automatic account when a player joins an online
  room, or hide the button where it cannot work.
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
