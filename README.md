# ⛰️ Canyons & Cannons

*Made by Abara Brothers.*

A real-time, mobile-first artillery game across mountainous canyons — arc your shells over the peaks to hit your opponents. Play a **2-player duel** or a **free-for-all with up to 4 players**, over a shared link, against a random stranger via quick match, or against the CPU.

- **Fast turn-based with a live feed** — every player watches each shell arc and land on the same board in real time. No shot clock: take as long as you like, turns advance when you fire.
- **Join by room link/code** (no accounts) **or Quick Match** with whoever else is looking.
- **Drag to aim + charge** — drag out from your tank in the direction you want to fire; pull distance sets power as a percentage (pull halfway → 50%). Fine-tune with the angle/power steppers.
- **Big, mountainous map** with peaks you must lob over. **Gravity, no wind.** Drive left/right on your turn (limited fuel).
- **Destructible terrain** — explosions carve large craters; tanks drop into them. The Dirt Mover builds walls or buries.
- **12 weapons** including mid-air **Cluster Bomb** and **Napalm** splits, a piercing **Railgun**, a one-shot **Tactical Nuke**, and a **Teleport** round that warps you to wherever the shell lands — most with limited ammo.
- **Two modes** — *Duel* (2 players, starts the moment your friend joins) and *Free-for-all* (3-4 players; the host starts when ready, last tank standing wins). Destroyed players stay and spectate.
- **300° of turret rotation** — fire forwards, straight up, backwards, or down off a cliff edge. The only dead zone is straight down at your own feet.
- **Live scoreboard** — one card per player, HP bars, and the acting player highlighted.
- Synthesized sound, screen shake, shockwave rings and particle explosions.

## Play locally

```bash
npm install
npm start            # http://localhost:3000
```

Open the URL in two or more tabs (or on phones on the same Wi-Fi, using your machine's LAN IP, e.g. `http://192.168.1.x:3000`). One player picks **Duel** or **Free-for-all**, taps **Create a game**, and shares the link/code; the others join. In a free-for-all the host presses **Start battle** once enough players are in (or it starts itself when the lobby fills).

## How it's built

- **`server.js`** — a single Node process that serves the static `public/` client **and** runs the WebSocket game server (`/ws`). Manages rooms, quick-match, the free-for-all lobby, turn rotation, elimination and damage. Only dependency: [`ws`](https://www.npmjs.com/package/ws).
- **`game-core.js`** — authoritative, deterministic game logic (mountainous terrain generation, physics, weapons, damage). The server simulates each shot and broadcasts the resolved result; both clients replay it identically, so screens never desync. World size is sent to clients on match start.
- **`public/`** — the client: vanilla HTML/CSS + a Canvas renderer (`app.js`). No build step, no framework.
- **`test/`** — headless integration tests. With the server up: `npm run test:sim` (two-client duel), `npm run test:resume` (drop + reconnect), `npm run test:ffa` (4-player lobby, N-wide payloads, late-join refusal). `npm run test:hitbox` needs no server — it fires every weapon on a flat map and asserts real damage lands. `npm run test:ffa-elim` exercises elimination and last-tank-standing; start the server with a short grace period first: `RESUME_GRACE_MS=1200 node server.js`.

## Deploy (needs a host that runs a persistent Node/WebSocket process)

Static hosting (e.g. plain Netlify) can't run this — it needs a live Node server. Good free options:

### Render (recommended — `render.yaml` included)
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com): **New +** → **Blueprint** → select the repo.
3. Render reads `render.yaml`, builds, and gives you a public `https://…onrender.com` URL with WebSockets working.

### Railway / Fly.io (alternatives)
- **Railway:** New Project → Deploy from GitHub repo. It auto-detects Node (`npm start`).
- **Fly.io:** `fly launch` (uses the included `Dockerfile`), then `fly deploy`.

> Note: free tiers sleep after inactivity, so the first visit after idle can take a few seconds to wake.

## Config knobs (`game-core.js`)

- `WORLD_W` / `WORLD_H` — map size (default 2600 × 1200)
- `SPEED_PER_POWER` / `GRAVITY` — tuned so a high-power lob clears the peaks and crosses the map
- `CRATER_MUL` — how much larger craters/blasts are than the damage radius
- `SHOT_CLOCK` — seconds per turn (default 45)
- `SHOTS_PER_PLAYER` — shots each before the match ends (default 10)
- `MOVE_BUDGET` — how far a tank can drive per turn
- `WEAPONS` — the arsenal (damage, radius, ammo, spread, cluster splits)
