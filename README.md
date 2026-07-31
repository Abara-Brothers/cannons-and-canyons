# Canyons & Cannons

*Made by Abara Brothers.*

A real-time, mobile-first artillery game across colossal destructible mountains —
arc your shells over the peaks to hit your opponents. Play a **2-player duel**, a
**4-player free-for-all**, a **co-op boss fight**, an **alien invasion**, or nine
holes of **artillery golf** — over a shared code, or against the CPU.

**The game is free. No ads, no in-app purchases, no tracking** — every unlockable
is earned by playing. Monetisation is deferred to a later release; nothing in the
codebase implements or prepares for it.

- **Landscape only.** The game is built for a phone held sideways and says so on
  every screen — there is no portrait layout.
- **Fast turn-based with a live feed** — every player watches each shell arc and
  land on the same board in real time. **No shot clock**: take as long as you
  like, turns advance when you fire.
- **Join by 4-letter code** (no accounts), or take on the **computer** at three
  difficulties.
- **Slingshot aiming** — touch any empty spot and pull back, away from your
  target: the shot flies opposite the pull, and pull distance sets power as a
  percentage. Fine-tune with the angle/power steppers.
- **Enormous map** — 48,000 × 13,500 world units of peaks you must lob over.
  **Gravity, no wind.** Drive left/right on your turn (limited fuel). The camera
  frames every tank rather than the whole map, and pinch/zoom is yours.
- **Destructible terrain** — explosions carve large craters and tanks drop into
  them. **Earthworks** builds walls or buries. Explosive barrels, bunkers and
  supply crates are destructible too; nothing on the field is indestructible.
- **Five biomes** — alpine, desert, ice, volcanic (with a lava floor that burns
  what falls in) and ruins. Each reshapes both the terrain generator and the way
  blast craters cut.
- **13 weapons**, of which you take **5 into a match**: Cannon, Heavy Mortar,
  Rocket Volley, Railgun, Cluster Bomb, Napalm, Toxic Gas, Air Strike, Bunker
  Buster, Earthworks, Teleport, Tactical Nuke and Minigun. Fire and gas keep
  working turn after turn; the Air Strike's first round is a smoke marker that
  calls in a plane.
- **300° of turret rotation** — fire forwards, straight up, backwards, or down
  off a cliff edge. The only dead zone is straight down at your own feet.
- **Health-based battles** — 150 HP per tank, no shot limit. Destroy the enemy to
  win. Destroyed players stay and spectate.
- **Career profile + 12 achievements**, stored on your own device. Two
  achievements and the WARLORD each hand over a tank paint.
- Synthesized sound, screen shake, shockwave rings and particle explosions. Every
  icon in the UI is hand-drawn SVG — **there are no emojis anywhere in the game**.

## The modes

| Mode | Players | How it works |
|---|---|---|
| **Duel** | 2 | Starts the moment your friend joins. |
| **Free-for-all** | 3–4 | Host starts when ready; last tank standing wins. |
| **Boss Fight** | 1–2 co-op | Bring down **WARLORD-7**, a mech that fights back. Beat it and the Midnight paint drops. |
| **Alien Invasion** | 1–2 co-op | Hold out against escalating waves of xeno saucers. |
| **Artillery Golf** | 1–2 | Nine holes, no damage. Three clubs — **Driver**, **Iron**, **Putter** — with real rolling physics, a scorecard and an end-of-round summary. |

## Play locally

```bash
npm install
npm start            # http://localhost:3000
```

Open the URL in two or more tabs (or on phones on the same Wi-Fi, using your
machine's LAN IP, e.g. `http://192.168.1.x:3000`). One player picks a mode, taps
**Create a game**, and shares the link/code; the others join. In a free-for-all
the host presses **Start battle** once enough players are in (or it starts itself
when the lobby fills).

## How it's built

- **`server.js`** — a single Node process that serves the static `public/` client
  **and** runs the WebSocket game server (`/ws`). Manages rooms, the free-for-all
  lobby, turn rotation, elimination, damage, and web-push match notifications.
  Dependencies: [`ws`](https://www.npmjs.com/package/ws) and
  [`web-push`](https://www.npmjs.com/package/web-push). It also still carries a
  dormant quick-match queue — the wire path works, but no client UI reaches it.
- **`game-core.js`** — authoritative, deterministic game logic (terrain
  generation, physics, weapons, hazards, damage). The server simulates each shot
  and broadcasts the resolved result; every client replays it identically, so
  screens never desync. World size is sent to clients on match start.
- **`public/`** — the client: vanilla HTML/CSS + a Canvas renderer (`app.js`). No
  build step, no framework. Ships as an installable PWA
  (`manifest.webmanifest`, service worker, `privacy.html`).
- **`test/`** — headless integration tests. Run the lot with **`bash
  test/run-all.sh`** (add `--remote` with `WS=wss://…/ws` to point them at a
  deployed server). Suites: `hitbox` (no server needed — fires every weapon on a
  flat map and asserts real damage lands), `sim`, `resume_test`,
  `resume_takeover`, `ffa`, `ffa_elim`, `boss`, `golf`, `horde`, `batch6`.
  `ffa_elim` needs a short grace period, so `run-all.sh` restarts the server with
  `RESUME_GRACE_MS` itself — it is local-only.

## Deploy (needs a host that runs a persistent Node/WebSocket process)

Static hosting (e.g. plain Netlify) can't run this — it needs a live Node server.

### Render (in use — `render.yaml` included)
Live at **https://canyons-and-cannons.onrender.com**, auto-deploying on every
push to `main`.

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com): **New +** → **Blueprint** → select the repo.
3. Render reads `render.yaml`, builds, and gives you a public `https://…onrender.com`
   URL with WebSockets working.

### Railway / Fly.io (alternatives)
- **Railway:** New Project → Deploy from GitHub repo. It auto-detects Node (`npm start`).
- **Fly.io:** `fly launch` (uses the included `Dockerfile`), then `fly deploy`.

> Note: free tiers sleep after inactivity, so the first visit after idle can take
> a few seconds to wake.

Mobile store wrappers, listing copy and art are in **`store/`**.

## Config knobs (`game-core.js`)

- `WORLD_W` / `WORLD_H` — map size (48,000 × 13,500)
- `SPEED_PER_POWER` / `GRAVITY` — tuned so a high-power lob clears the peaks
- `MAX_HP` — tank health (150); there is no shot clock and no shot limit
- `MOVE_BUDGET` — how far a tank can drive per turn (4,500)
- `LOADOUT_SIZE` — how many weapons a player takes into a match (5; Boss Fight
  and Alien Invasion draft 7 — see `loadoutSizeFor`)
- `CRATER_MUL` — how much larger craters/blasts are than the damage radius
- `AIM_MIN` / `AIM_MAX` — the 300° firing arc
- `LAVA_DPS` — damage per second while a tank sits in lava on volcanic maps
- `BIOMES` — per-biome terrain generation and crater shaping
- `WEAPONS` — the arsenal (damage, radius, ammo, spread, cluster splits, hazards)

## House rules for contributors

Three rules override anything else in this repo:

1. **No emojis in the game UI, ever.** Every icon is hand-authored inline SVG or
   drawn on the canvas. There is an emoji audit — run it before shipping.
2. **The tank design is locked.** Do not change `drawTank` in `public/app.js`,
   not even for an art-style pass.
3. **Landscape is absolute.** All viewport units go through `--vhu` / `--vwu` /
   `--dvhu` / `--dvwu`, and every media query needs a portrait twin on the
   effective axes.
