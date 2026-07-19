# 💥 Pocket Tanks Online

A real-time, mobile-first, 2-player artillery duel — a Pocket Tanks–style game you can play with a friend right now over a shared link, or against a random stranger via quick match.

- **Fast turn-based with a live feed** — both players watch every shell arc and land on the same board in real time. A short shot-clock keeps turns snappy.
- **Join by room link/code** (no accounts) **or Quick Match** with whoever else is looking.
- **Gravity, no wind.** Drive left/right on your turn (limited fuel), then aim and fire.
- **Destructible terrain** — explosions carve craters; tanks drop into them. The Dirt Mover builds walls or buries.
- **11 weapons** including mid-air **Cluster Bomb** and **Firestorm** splits, a one-shot **Nuke**, Sniper, Digger and more — with limited ammo.
- **Live scoreboard** — 10 shots each, highest score wins.
- Drag-to-aim (angle + power in one gesture), synthesized sound, screen shake, particles.

## Play locally

```bash
npm install
npm start            # http://localhost:3000
```

Open the URL in two tabs (or on two phones on the same Wi-Fi, using your machine's LAN IP, e.g. `http://192.168.1.x:3000`). One player taps **Create a game** and shares the link/code; the other joins.

## How it's built

- **`server.js`** — a single Node process that serves the static `public/` client **and** runs the WebSocket game server (`/ws`). Manages rooms, quick-match, turns, the shot-clock, and scoring. Only dependency: [`ws`](https://www.npmjs.com/package/ws).
- **`game-core.js`** — authoritative, deterministic game logic (terrain generation, physics, weapons, damage). The server simulates each shot and broadcasts the resolved result; both clients replay it identically, so screens never desync.
- **`public/`** — the client: vanilla HTML/CSS + a Canvas renderer (`app.js`). No build step, no framework.
- **`test/sim.mjs`** — a headless two-client match that plays a full game and checks the pipeline. Run with the server up: `node test/sim.mjs`.

## Deploy (needs a host that runs a persistent Node/WebSocket process)

Static hosting (e.g. plain Netlify) can't run this — it needs a live Node server. Good free options:

### Render (recommended — `render.yaml` included)
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com): **New +** → **Blueprint** → select the repo.
3. Render reads `render.yaml`, builds, and gives you a public `https://…onrender.com` URL with WebSockets working.

### Railway / Fly.io (alternatives)
- **Railway:** New Project → Deploy from GitHub repo. It auto-detects Node (`npm start`). Add nothing else.
- **Fly.io:** `fly launch` (uses the included `Dockerfile`), then `fly deploy`.

> Note: free tiers sleep after inactivity, so the first visit after idle can take a few seconds to wake.

## Config knobs (`game-core.js`)

- `SHOT_CLOCK` — seconds per turn (default 45)
- `SHOTS_PER_PLAYER` — shots each before the match ends (default 10)
- `MOVE_BUDGET` — how far a tank can drive per turn
- `WEAPONS` — the arsenal (damage, radius, ammo, spread, cluster splits)
