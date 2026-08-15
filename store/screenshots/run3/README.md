# Store screenshots — run 3 (2026-08-14)

Real captures of the shipping app, HUD and controls included. This replaces
run1/run2, which were **composed marketing frames built from canvas-only
exports** and are now stale: they predate the dock rename, the armoury, the
account chip, the age gate and the 8.61 layout pass, and they show the
battlefield with no on-screen UI at all.

`DESIGN-ASSETS.md` §5 called for exactly this run:

> Screenshots show the battlefield only; the on-screen HUD and controls are DOM,
> not canvas, so they are not in these captures. If you want the real UI visible,
> the cleanest route is device screenshots from the iOS Simulator / an Android
> emulator once the app is wrapped — which is standard practice anyway.

It also flagged that the listing sells five modes while the screenshots covered
two. **Both gaps are closed here**: every frame shows the live UI, and Boss Fight
and Alien Invasion now have frames of their own.

## Frames

| | File | What it shows |
|---|---|---|
| 01 | `01-aim` | Duel — controls open: weapon strip with round counts, angle/power drums, fuel, FIRE |
| 02 | `02-strike` | Duel — a napalm salvo in the air, weapon and angle/power on the readout |
| 03 | `03-impact` | Duel — impact, SHIELD DOWN, fires on the ridge, enemy health dropping |
| 04 | `04-boss` | Boss Fight — WARLORD-7 with its own health bar, firing a rocket salvo |
| 05 | `05-aliens` | Alien Invasion — three xeno units on the HUD, `0/8 down · Wave 1` |
| 06 | `06-golf` | Artillery Golf — `Hole 1/9 · Par 3 · 15,180 to the pin`, flag on the green |
| 07 | `07-home` | Menu — five modes, join-by-code, tank paint, career, sign-in |

Seven frames fits both stores (App Store allows 10, Play allows 8).

## Sizes, and where each one came from

| Folder | Pixels | Source |
|---|---|---|
| `iphone-6.9` | 2868×1320 | iPhone 17 Pro Max simulator, **native — no resampling** |
| `iphone-6.5` | 2688×1242 | the same masters, resampled (aspect differs by 0.4%) |
| `ipad-13` | 2752×2064 | web build at 1376×1032 CSS, dpr 2 |
| `android-phone` | 1920×1080 | web build at 640×360 CSS, dpr 3 |
| `android-tablet` | 2560×1600 | web build at 1280×800 CSS, dpr 2 |

Every file was checked programmatically: exact dimensions, and PNG colour type 2
(RGB, **no alpha channel**) — App Store Connect rejects screenshots that carry
alpha.

### Why the iPad and Android sets come from the web build

- **Android**: there is no AVD installed on this machine and no system image
  downloaded. The Android shell is a Capacitor WebView around this exact bundle.
- **iPad**: the app supports iPad (`TARGETED_DEVICE_FAMILY = "1,2"`), so 13″
  screenshots are mandatory — but the iPad simulator cannot be rotated to
  landscape from the command line. `simctl` has no orientation subcommand, the
  Simulator's own Rotate menu needs assistive access that is not granted, and
  writing `SimulatorWindowOrientation` into the Simulator preferences did not
  move the simulated device. Rendering the bundle at 1376×1032 CSS / dpr 2 gives
  a true-resolution landscape frame with no upscaling.

The device-pixel-ratio matters as much as the output size: rendering 2752×2064
at dpr 1 makes the app lay out for a 2752-px-wide viewport and the result is a
tiny UI floating in empty space. The ratios above are what the real devices
report.

## Rebuilding

The tools are in `tools/shots/`. They need no `node_modules` — Swift plus the
Node standard library, so they are cheap to keep and rerunnable at the next UI
change (which is what made run1/run2 unrepeatable).

- `cap.sh <udid> <name>` — grab a raw simulator framebuffer.
- `shot.swift` — rotate that framebuffer, patch out the Dynamic Island, resize to
  the store size, write opaque PNG. Also `probe`, `crop`, `flat`, `sheet`.
- `render.mjs <w> <h> <dpr> <out>` — drives the live game over CDP (touch events
  at element centres, never guessed pixels) against `npm run dev` on :3000.
- `assemble.sh <dest>` — builds this tree and verifies every file.

```bash
npm run dev            # then, from tools/shots:
node render.mjs 2752 2064 2 web/ipad-13
bash assemble.sh out
```

Two things worth keeping if these are ever rerun:

- **The simulator composites the Dynamic Island as a black pill.** A real device
  screenshot does not contain it. `shot.swift` rebuilds those columns by
  interpolating between the clean columns either side; the app keeps its content
  clear of that area via safe-area insets, so nothing real is painted over.
- **FIRE needs a held press — from synthetic input only.** A zero-duration
  `simctl`/CDP tap does not fire; ~250 ms does, so every scripted tap holds.
  This is not an app defect: `fireBtn` fires on `click` (`public/app.js:2601`)
  and `pointerdown` only drives the press animation, so a real finger tap works.

## Known limitations of this set

- The **xeno units render very small** at phone scale — the Alien Invasion frame
  leans on the HUD (`XENO-SCOUT / XENO-REAVER / XENO-HARROW`, `0/8 down · Wave 1`)
  to say what the mode is.
- The **iPad frames carry a lot of empty sky.** The camera keeps a fixed world
  width, so a 4:3 screen gets the extra space as sky rather than more terrain.
- Free-for-all has no frame. Four-player FFA needs four clients; the five frames
  that carry the listing copy are covered.
