# Store screenshots — run 4 (2026-09-14)

Run 3 plus the onboarding. The game now coaches a player through their first
battle and ships a six-chapter field manual behind the help button, and neither
appeared in any screenshot. Two frames were added for them; the other seven are
run 3's, unchanged, because nothing in them changed.

## Frames

| | File | What it shows | New? |
|---|---|---|---|
| 00 | `00-coach` | **First battle — step 1 of 3 over the live board.** The ghost hand ringed, the pull arrow, the trajectory arrowhead, the live power %, dock still tucked away | **new** |
| 01 | `01-aim` | Duel — controls open: weapon strip with round counts, angle/power drums, fuel, FIRE | |
| 02 | `02-strike` | Duel — a napalm salvo in the air, weapon and angle/power on the readout | |
| 03 | `03-impact` | Duel — impact, SHIELD DOWN, fires on the ridge, enemy health dropping | |
| 04 | `04-boss` | Boss Fight — WARLORD-7 with its own health bar, firing a rocket salvo | |
| 05 | `05-aliens` | Alien Invasion — three xeno units on the HUD, `0/8 down · Wave 1` | |
| 06 | `06-golf` | Artillery Golf — `Hole 1/9 · Par 3 · 15,180 to the pin`, flag on the green | |
| 07 | `07-home` | Menu — five modes, join-by-code, tank paint, career, sign-in | |
| 08 | `08-manual` | **Field manual — the Weapons chapter**, rail of six chapters, the draft and weapon-strip facts, the arsenal list | **new** |

`00-coach` leads because it is literally the first thing a new player sees, and
because it is the only frame that shows the game *and* says "you will pick this
up in seconds".

## Frame counts differ by store, deliberately

- **App Store (iphone-6.9, iphone-6.5, ipad-13): all 9.** The limit is 10.
- **Google Play (android-phone, android-tablet): 8 — `08-manual` is dropped.**
  The limit is 8. Of the two new frames the manual is the reference screen and
  `00-coach` is the one that also shows gameplay, so the manual is the one to
  cut. `tools/shots/assemble.sh` encodes this in `APPLE_FRAMES` / `PLAY_FRAMES`;
  it is not an oversight and should not be "fixed" by adding a ninth Play frame.

## Sizes, and where each one came from

| Folder | Pixels | Frames | Source |
|---|---|---|---|
| `iphone-6.9` | 2868×1320 | 9 | iPhone 17 Pro Max simulator, **native — no resampling** |
| `iphone-6.5` | 2688×1242 | 9 | the same masters, resampled (aspect differs by 0.4%) |
| `ipad-13` | 2752×2064 | 9 | web build at 1376×1032 CSS, dpr 2 |
| `android-phone` | 1920×1080 | 8 | web build at 640×360 CSS, dpr 3 |
| `android-tablet` | 2560×1600 | 8 | web build at 1280×800 CSS, dpr 2 |

Every file was checked programmatically: exact dimensions, PNG colour type 2
(RGB, **no alpha channel** — App Store Connect rejects alpha), and the expected
frame count per folder.

### The seven carried-over iPhone frames

The iPhone masters are raw simulator framebuffers and are not kept in the repo,
so re-shooting all seven unchanged frames would have meant driving the whole
five-mode flow by hand through a rotated WebView with no accessibility tree.
Instead `assemble.sh` gained a `--carry <previousRun>` flag: any frame with no
master in `picks/` is copied from the previous run's already-processed output.
Only `00-coach` and `08-manual` were shot for this run. The carried frames are
still accurate — this batch changed the help modal and added the coach marks,
and touched nothing that appears in frames 01–07.

### Two bugs this run caught

1. **The coach card covered the hand it was pointing at.** It was bottom-left,
   matching the concept art, which placed the ghost hand mid-right. But the demo
   pulls back *away* from the enemy, so on a map with the enemy to your right
   the hand lands mid-**left** — measured at 640×360 CSS, hand at 42%/58% under
   a card spanning 2%–60% from 58% down. The card moved to the top centre and
   the demo's own caption is now suppressed while a step is showing, since the
   card says the same thing better.
2. **`.overlay` used a flat 22px padding, with no safe-area awareness.** In
   landscape the Dynamic Island physically occludes one short edge, and the
   full-screen manual put its chapter numbers and the "FIELD MANUAL" eyebrow
   straight under it. Found because `shot.swift`'s island patch smeared real
   content instead of background. Now `max(22px, env(safe-area-inset-*))` on
   every side — which fixes every other overlay on a notched phone too.

## Rebuilding

```bash
npm start                                   # serve on :3000
node tools/shots/render.mjs 2752 2064 2 tools/shots/web/ipad-13
node tools/shots/render.mjs 1920 1080 3 tools/shots/web/android-phone
node tools/shots/render.mjs 2560 1600 2 tools/shots/web/android-tablet
# iPhone: npx cap sync ios, build to the simulator, capture into tools/shots/picks/
bash tools/shots/assemble.sh store/screenshots/run5 --carry store/screenshots/run4
```

`render.mjs` parks the aim demo at a chosen point in its 3.8s loop
(`parkDemo`) so `00-coach` lands on the pressed phase with the ring and the pull
arrow drawn, instead of wherever an untimed capture happens to fall.
