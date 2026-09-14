# Store screenshots — run 5 (2026-09-14)

**Every iPhone frame is a fresh native capture.** Run 4 carried seven frames
forward from run 3 because their masters were not kept in the repo; this run
re-shoots all nine on the iPhone 17 Pro Max simulator, in one continuous
session on one build, so the whole set is internally consistent.

This supersedes run 4, which has been removed — it existed for under an hour
and was strictly worse. Run 3 is kept as history.

## Frames

| | File | What it shows |
|---|---|---|
| 00 | `00-coach` | **First battle — step 1 of 3** over a volcanic map: the ghost hand ringed, the pull arrow, the trajectory arrowhead, the live 42% readout, dock still tucked away |
| 01 | `01-aim` | Duel — controls open: weapon strip with round counts, ANGLE 45&deg; / POWER 79 drums, fuel, FIRE |
| 02 | `02-strike` | Duel — the shell leaving the muzzle with flash and smoke trail, tracer arc ahead, both tanks at full health |
| 03 | `03-impact` | Duel — **a cluster bomb detonating**, smoke plumes and a debris fountain, HUD at full brightness (see below) |
| 04 | `04-boss` | Boss Fight — WARLORD-7 with its own 400/400 bar in the HUD |
| 05 | `05-aliens` | Alien Invasion — three xeno units on the HUD, `0/8 down &middot; Wave 1` |
| 06 | `06-golf` | Artillery Golf — `Hole 1/9 &middot; Par 3 &middot; 15,180 to the pin`, flag on the green, scorecard button |
| 07 | `07-home` | Menu — five modes, join-by-code, tank paint, career, sign-in |
| 08 | `08-manual` | Field manual — the Weapons chapter: rail of six, the draft and weapon-strip facts, the arsenal list |

## Frame counts differ by store, deliberately

- **App Store** (`iphone-6.9`, `iphone-6.5`, `ipad-13`): all 9. The limit is 10.
- **Google Play** (`android-phone`, `android-tablet`): 8 — `08-manual` is dropped.
  The limit is 8, and of the two onboarding frames the manual is the reference
  screen while `00-coach` also shows gameplay. `tools/shots/assemble.sh` encodes
  this as `APPLE_FRAMES` / `PLAY_FRAMES`; it is not an oversight.

## Sizes and sources

| Folder | Pixels | Frames | Source |
|---|---|---|---|
| `iphone-6.9` | 2868&times;1320 | 9 | iPhone 17 Pro Max simulator, **native — no resampling** |
| `iphone-6.5` | 2688&times;1242 | 9 | the same masters, resampled (aspect differs by 0.4%) |
| `ipad-13` | 2752&times;2064 | 9 | web build at 1376&times;1032 CSS, dpr 2 |
| `android-phone` | 1920&times;1080 | 8 | web build at 640&times;360 CSS, dpr 3 |
| `android-tablet` | 2560&times;1600 | 8 | web build at 1280&times;800 CSS, dpr 2 |

All 43 files verified programmatically: exact dimensions, PNG colour type 2
(RGB, **no alpha** — App Store Connect rejects it), and expected count per folder.

## How the native frames were driven, and what it cost

There is no accessibility tree inside the WKWebView, so the app has to be driven
by tapping points in the simulator's **portrait** coordinate space while the app
renders **landscape** through its CSS rotate shim. The mapping, derived from two
known-good taps and used throughout:

```
x_portrait = 440 - y_landscape / 3        y_portrait = x_landscape / 3
```

Three things cost real time and are worth knowing before the next run:

1. **Simulator storage survives a reinstall.** The first attempt produced no
   coach marks and no ghost hand at all, because this simulator still held a
   `cc_career` from the run-3 session and `PROF.shots > 0` grandfathers both out.
   `simctl uninstall` before `install` — a plain reinstall is not enough.
2. **`simctl io screenshot` takes ~0.8s and a tight loop starves the renderer**,
   so consecutive frames come back identical. Space them ~0.3s, or better:
3. **Record video instead of bursting screenshots.** A shell is in the air for
   well under a second, which no screenshot loop can reliably catch.
   `simctl io recordVideo` plus `tools/shots/frames.swift` (AVFoundation) pulls
   every frame out afterwards; `02-strike` came from that. Confirm it is your
   turn immediately before tapping FIRE — a tap during the opponent's turn is
   silently ignored, which looks exactly like a missed tap.

## The impact frame is bright, and how

Firing passes the turn, so `#game.watching` drops the HUD to **16% opacity** for
the whole flight — which means *every* frame of your own shot landing carries a
ghost of a readout instead of a readout. Worth knowing: the battlefield is never
dimmed. Only `#hud-top`, `#dock` and the corner buttons are.

No game change was needed. `wakeHud()` already restores full opacity for 2.2s on
any touch of the HUD or dock, so the fix is to keep the HUD awake across the
capture window:

- **Web classes** — `render.mjs`'s `shotBusiest()` now takes a `keepHudAwake`
  flag and calls `wakeHud()` before each of its 14 samples. Repeatable, no
  manual timing. The android-phone frame that came out of this carries a live
  `-25` damage numeral on the enemy.
- **iPhone** — tap `#hud-top` (the health-bar strip; it holds no buttons)
  several times right after FIRE. One tap is not enough: the wake lasts 2.2s
  and the shell is still in the air. That strip is around `(433, 467)` in
  portrait points.

## Rebuilding

```bash
npm start                                   # serve on :3000
node tools/shots/render.mjs 2752 2064 2 tools/shots/web/ipad-13
node tools/shots/render.mjs 1920 1080 3 tools/shots/web/android-phone
node tools/shots/render.mjs 2560 1600 2 tools/shots/web/android-tablet
# iPhone: npx cap sync ios, build to the simulator, simctl uninstall + install,
# then drive the flow and capture into tools/shots/picks/
bash tools/shots/assemble.sh ../../store/screenshots/run6
```

`assemble.sh` **cd**s to its own directory, so `<destDir>` is relative to
`tools/shots/` — pass `../../store/screenshots/runN`, not a repo-root path.
`--carry <previousRun>` fills any frame with no master in `picks/`; this run
used none.
