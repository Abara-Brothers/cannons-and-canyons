# Store screenshots — run 6 (Launch Bay)

**Why a new run:** the Launch Bay front end (concept 10) replaced the entire home
screen at cutover (`c6bf9de`). Frame `07-home` — *"Menu — five modes, join-by-code,
tank paint, career, sign-in"* in run 5 — no longer showed the game. Every other
frame is gameplay or the field manual, which the cutover did not touch.

## What changed, per device class

| class | `07-home` | frames 00–06, 08 |
|---|---|---|
| `iphone-6.9` | **re-shot natively** on the iPhone 17 Pro Max simulator, fresh install | **carried from run 5** via `assemble.sh --carry` |
| `iphone-6.5` | same master, resampled (as in run 5) | carried from run 5 |
| `ipad-13` | re-rendered | **re-rendered** — every web frame comes from the cutover build |
| `android-phone` | re-rendered | re-rendered |
| `android-tablet` | re-rendered | re-rendered |

The carry is deliberate and honest: the gameplay frames' *content* is identical
in the cutover build, their run-5 masters were shot in one continuous session
on one device, and re-driving the whole five-mode flow through a rotated
WebView by hand would add risk and no information. The web classes are cheap to
regenerate end to end, so they were — which also exercised the retargeted
screenshot tool through every mode.

## The home frame

The bay, in its fresh-install state: a rolled callsign, Olive fitted, five of
five drafted, no wins. That is what a new player sees, and it matches
`00-coach` being a first battle.

## A real bug this run found, and fixed

The first assembled `iphone-6.9/07-home` read **"NONS & CANYONS"** — the left
edge clipped, the Duel board and the launch-bar icon cut. The raw master was
fine, so the cause was `shot.swift`, whose own header states the premise:

> columns x0…x1 are rebuilt by interpolating between the clean columns either
> side of it … **the app keeps its content clear of that area via safe-area
> insets**, so the source columns are always background.

The old menu honoured that. The Launch Bay did not: its brand and first mode
board sat hard against the app's logical left edge, which in landscape is where
the Dynamic Island is — so the island patch interpolated across real content and
smeared it away. **That is a bug on every notched iPhone, not a capture
artefact**: with `viewport-fit=cover` the WebView draws under the island, and
only `env(safe-area-inset-*)` keeps content out.

Fixed in `styles.css`: the bay's design frame is now fitted to the SAFE box and
offset into it, using insets mapped onto the app's own axes. In portrait the
whole app is rotated 90° about its top-left, so logical **left ↔ physical top** —
the same swap `#game` and `#dock` already use. The insets are asymmetric (one
short edge carries the island, the other does not), so the frame is offset, not
merely shrunk and re-centred: centring would still leave content under the
island on the inset side.

## Two snags, recorded so the next run does not repeat them

1. **zsh does not word-split an unquoted variable.** A `for spec in "…"; set -- $spec`
   loop handed `render.mjs` a single argument and it printed usage three times
   with exit 0 from the loop. Same trap this project hit in the backup tooling.
   The three renders are written out literally now (see below).
2. **Tapping the armed mode board opens Setup.** Duel is the default, so the
   duel flow's board tap landed on Setup, where the launch bar's readouts (the
   other route into Setup) do not exist, and the next `tap()` threw. That tap is
   `optional` now: on home it opens Setup, on Setup it is skipped.

`render.mjs` was retargeted from the old menu's controls (`[data-mode]`,
`[data-opp]`, `#createBtn`, `#startMatchBtn`, `#helpHomeBtn` — now in a hidden
rack that its visible-only `tap()` cannot reach) to the bay's boards, Setup's
segments, the launch bar and Bay Controls.

## Rebuilding

```bash
npm start                                   # serve on :3000
node tools/shots/render.mjs 2752 2064 2 tools/shots/web/ipad-13
node tools/shots/render.mjs 1920 1080 3 tools/shots/web/android-phone
node tools/shots/render.mjs 2560 1600 2 tools/shots/web/android-tablet
# iPhone 17 Pro Max simulator: simctl uninstall + install the current build,
# let the home settle, then: bash tools/shots/cap.sh <udid> 07-home
#                             cp tools/shots/raw/07-home.png tools/shots/picks/
cd tools/shots && bash assemble.sh ../../store/screenshots/run6 --carry ../../store/screenshots/run5
```

`assemble.sh` **cd**s to its own directory, so paths are relative to
`tools/shots/`. Verification (exact size, RGB with no alpha, expected count per
folder) is part of the script and is what "43 files" below means.
