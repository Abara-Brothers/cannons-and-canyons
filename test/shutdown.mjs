// Graceful shutdown (Phase 1b, ISSUE-019).
//
// Render restarts this process on every deploy and on every spin-up from idle.
// It used to be killed outright: everyone in every live match was dropped with
// no explanation and their resume token then failed against a room that no
// longer existed. The server must now announce itself and exit promptly.
//
// LOCAL ONLY, and deliberately so — it spawns its OWN server on its own port
// and sends it SIGTERM. It must never be pointed at a shared or deployed
// server, so unlike every other suite it ignores $WS.
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SHUTDOWN_PORT) || 3599;

const out = { steps: [], errors: [] };
const step = (m) => { out.steps.push(m); console.log('  ok — ' + m); };
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let child = null;
const finish = () => {
  if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
  process.exit(out.errors.length ? 1 : 0);
};
setTimeout(() => { fail('timeout'); finish(); }, 45000);

(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), BOT_FIRE_MS: '250', PICK_MS: '800' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stdout += d.toString(); });

  // Wait for it to listen.
  for (let i = 0; i < 60 && !/running at/.test(stdout); i++) await sleep(100);
  if (!/running at/.test(stdout)) { fail('server never reported listening'); return finish(); }

  // Two clients: one idle in the lobby, one in a live vs-CPU match.
  const idle = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise((res, rej) => { idle.on('open', res); idle.on('error', rej); });

  const player = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise((res, rej) => { player.on('open', res); player.on('error', rej); });

  let notifiedIdle = false, notifiedPlayer = false;
  let idleClose = null, playerClose = null;
  idle.on('message', (raw) => { if (JSON.parse(raw).type === 'serverRestart') notifiedIdle = true; });
  player.on('message', (raw) => { if (JSON.parse(raw).type === 'serverRestart') notifiedPlayer = true; });
  idle.on('close', (c) => { idleClose = c; });
  player.on('close', (c) => { playerClose = c; });

  player.send(JSON.stringify({
    type: 'ai', difficulty: 'easy', name: 'Shutdown', skin: 'olive',
    loadout: ['mortar', 'cluster', 'napalm', 'airstrike', 'volley'],
  }));
  await sleep(1500);   // let the match actually start

  // ---- The event under test -------------------------------------------------
  const t0 = Date.now();
  child.kill('SIGTERM');
  const exitCode = await new Promise((res) => {
    let done = false;
    child.on('exit', (c) => { if (!done) { done = true; res(c); } });
    setTimeout(() => { if (!done) { done = true; res(null); } }, 10000);
  });
  const took = Date.now() - t0;

  if (exitCode === null) fail('server did not exit within 10s of SIGTERM — a deploy would hang');
  else if (exitCode !== 0) fail(`server exited ${exitCode} on SIGTERM, expected 0 (clean)`);
  else step(`SIGTERM: exited cleanly (code 0) in ${took}ms`);

  await sleep(300);
  if (!notifiedPlayer) fail('a player in a live match was NOT told the server was restarting');
  else step('the player in a live match received serverRestart before the socket closed');
  if (!notifiedIdle) fail('an idle lobby client was NOT told the server was restarting');
  else step('the idle lobby client received serverRestart too');

  // 1012 = "Service Restart" — the standard code, so a client can tell a deploy
  // apart from a network drop.
  const codes = [playerClose, idleClose].filter((c) => c != null);
  if (!codes.length) fail('sockets never closed');
  else if (!codes.every((c) => c === 1012)) fail(`sockets closed with ${JSON.stringify(codes)}, expected 1012 (service restart)`);
  else step('sockets closed with 1012 (service restart), not an abrupt drop');

  if (!/\[shutdown\] SIGTERM/.test(stdout)) fail('no [shutdown] line was logged');
  else step('shutdown was logged with the socket/room counts');

  finish();
})().catch((e) => { fail('threw: ' + (e && e.message ? e.message : String(e))); finish(); });
