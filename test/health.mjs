// /health's THREE SUPABASE VERDICTS, one per probe group, driven through the
// REAL server against a mock Supabase that can be told to answer any status.
// Self-hosted like history.mjs: every server here is spawned by this file on a
// free port. Never aim it at a deployment.
//
// WHY THIS EXISTS: these three fields are what the deploy procedure tells the
// owner to read and act on, and until now only their happy path was asserted
// anywhere (push_persist.mjs proves supabase+supabaseAdmin read 'ok', and
// history.mjs proves supabaseSocial's three states). NOT ONE FAILURE VERDICT OF
// THE OTHER TWO WAS TESTED, which is how this shipped: `probes.every(r => r.ok)
// ? 'ok' : 'bad_secret_key'` collapsed a 500, a 503, a 429, a 404 and a 403 into
// "your secret key is wrong". Observed live on 2026-09-21 — one probe read
// bad_secret_key on a process whose uptime showed no restart, so no environment
// variable could have changed, and eleven samples over the following minutes all
// read 'ok'. A deploy restarts the server and the boot probes fire into the
// connection churn that follows, which is exactly when a transient 5xx is most
// likely and exactly when the owner is reading these fields.
//
// Each case boots its own server, because the verdicts are latched by the boot
// probe and re-probed at most once a minute (see the /health route): a second
// world needs a second process, not a second request.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const out = { errors: [] };
const ok = (m) => console.log('  ok — ' + m);
const fail = (m) => { out.errors.push(m); console.error('FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });

// ---- the mock ---------------------------------------------------------------
// The two PRIVILEGED tables (the base migration's) and the five phase 6 probes,
// named exactly as server.js asks for them. `profiles` is probed for the three
// NEW COLUMNS, so it belongs to the social group here even though the table
// itself predates phase 6 — an unknown column is a 400, which is the whole
// point of that probe.
const ADMIN_TABLES = ['push_subscriptions', 'error_reports'];
const SOCIAL_TABLES = ['profiles', 'friendships', 'friend_requests', 'blocks', 'name_reports'];

// What this world answers. A number applies to every probe in the group; an
// object keys a status per table (with `_` as that group's default), which is
// how the PRECEDENCE cases are built — one probe refused while another is merely
// having a bad second.
let world = { auth: 200, admin: 200, social: 200 };
const pick = (spec, table) => (typeof spec === 'number' ? spec : (spec[table] ?? spec._ ?? 200));

const mockPort = await freePort();
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    // PostgREST's own shapes for the two statuses that carry meaning: 42P01 for
    // a relation that is not in the schema cache, 42703 for a column that is not.
    if (code === 404) return res.end(JSON.stringify({ code: '42P01', message: 'relation does not exist' }));
    if (code === 400) return res.end(JSON.stringify({ code: '42703', message: 'column does not exist' }));
    if (code === 401) return res.end(JSON.stringify({ message: 'Invalid API key' }));
    return res.end(code >= 200 && code < 300 ? '[]' : JSON.stringify({ message: 'upstream' }));
  };
  if (u.pathname === '/auth/v1/health') return send(world.auth);
  const table = u.pathname.startsWith('/rest/v1/') ? u.pathname.slice('/rest/v1/'.length) : '';
  if (ADMIN_TABLES.includes(table)) return send(pick(world.admin, table));
  if (SOCIAL_TABLES.includes(table)) return send(pick(world.social, table));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('[]');
});
await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));

// ---- one server per world ---------------------------------------------------
// Polls for SETTLED values: 'unchecked' is every field's state while the boot
// probe is still in flight, and the listener is up before that promise resolves.
// That is itself a state the endpoint can return, and the reason the owner steps
// must say "read it again" rather than treating one reading as authoritative.
const kids = [];
async function boot(w, what) {
  world = w;
  const p = await freePort();
  const s = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(p), SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_PUBLISHABLE_KEY: 'pk', SUPABASE_SECRET_KEY: 'sk' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(s);
  let log = '';
  s.stdout.on('data', (d) => { log += d; });
  s.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${p}/health`)).json();
      if (j && j.supabase !== 'unchecked' && j.supabaseAdmin !== 'unchecked' && j.supabaseSocial !== 'unchecked') {
        await sleep(60);                    // let the boot line finish flushing
        s.kill();
        return { h: j, log };
      }
    } catch {}
    await sleep(150);
  }
  s.kill();
  fail(`${what}: /health never settled`);
  return { h: {}, log };
}

// field must equal `want`, and — separately and loudly — must not be the verdict
// that sends the owner to rotate a key that is fine.
const eq = (h, field, want, why) => {
  if (h[field] === want) ok(`${field} reads '${want}' ${why}`);
  else fail(`${field}: expected '${want}', got ${JSON.stringify(h[field])} — ${why}`);
};
// ONLY the instruction lines the boot verdict produced — the `<-- ` continuation
// lines under the '[boot]' line. Scoping matters: the whole log also carries the
// unrelated '[csp] WARNING' (public/config.js points the browser at the real
// project while these servers run against a mock, which is expected here and
// says SUPABASE_URL in passing). Asserting against the raw log made this suite
// fail for a reason that had nothing to do with the verdict under test.
const instructions = (log) => log.split('\n').filter((l) => l.includes('<--')).join('\n');
const notKeyBlame = (h, field, ctx) => {
  const v = h[field];
  if (v !== 'bad_secret_key' && v !== 'bad_key_or_url') ok(`and ${field} does NOT blame the key ${ctx}`);
  else fail(`${field} BLAMES THE KEY ${ctx}: ${JSON.stringify(v)} — this is the bug, a transient upstream fault reported as a credential fault`);
};

const timer = setTimeout(() => { fail('timeout'); done(); }, 180000);
function done() {
  clearTimeout(timer);
  for (const s of kids) { try { s.kill('SIGKILL'); } catch {} }
  mock.close();
  console.log(out.errors.length ? `\n${out.errors.length} FAILED` : '\nALL GOOD');
  process.exit(out.errors.length ? 1 : 0);
}

try {
  // ---- 1. everything answers ------------------------------------------------
  {
    const { h } = await boot({ auth: 200, admin: 200, social: 200 }, 'healthy');
    eq(h, 'supabase', 'ok', 'when the auth endpoint answers 200');
    eq(h, 'supabaseAdmin', 'ok', 'when both privileged tables answer 200');
    eq(h, 'supabaseSocial', 'ok', 'when all five phase 6 probes answer 200 — the state the ship procedure waits for');
  }

  // ---- 2. the key really is refused ----------------------------------------
  // The ONE status that means what the old code said everything meant.
  {
    const { h, log } = await boot({ auth: 401, admin: 401, social: 401 }, '401');
    eq(h, 'supabase', 'bad_key_or_url', 'when the auth endpoint refuses the publishable key');
    eq(h, 'supabaseAdmin', 'bad_secret_key', 'when the privileged tables refuse the secret key — 401 is the only status that means this');
    eq(h, 'supabaseSocial', 'bad_secret_key', 'when the phase 6 tables refuse the secret key');
    const i401 = instructions(log);
    if (/check SUPABASE_SECRET_KEY/.test(i401)) ok('and the boot line still names SUPABASE_SECRET_KEY for a real 401 — the instruction is kept where it is true');
    else fail(`the boot line stopped naming SUPABASE_SECRET_KEY on a genuine 401: ${JSON.stringify(i401)}`);
  }

  // ---- 3. Supabase is having a bad minute: 5xx ------------------------------
  // THE OBSERVED CASE. Every one of these read 'bad_secret_key' before.
  {
    const { h, log } = await boot({ auth: 500, admin: 500, social: 500 }, '500');
    eq(h, 'supabase', 'upstream_error', 'when the auth endpoint answers 500');
    notKeyBlame(h, 'supabase', 'on a 500');
    eq(h, 'supabaseAdmin', 'upstream_error', 'when a privileged table answers 500');
    notKeyBlame(h, 'supabaseAdmin', 'on a 500');
    eq(h, 'supabaseSocial', 'upstream_error', 'when a phase 6 probe answers 500');
    notKeyBlame(h, 'supabaseSocial', 'on a 500');
    // STEP 4 OF THE BRIEF, asserted on stderr rather than in the JSON: the boot
    // line is what a deploy log shows, and it must not send anyone to a variable.
    const i5xx = instructions(log);
    if (i5xx && !/SUPABASE_SECRET_KEY|SUPABASE_PUBLISHABLE_KEY|SUPABASE_URL/.test(i5xx))
      ok('and the boot line for an upstream fault names NO variable to change');
    else fail(`the boot line still names a variable for an upstream fault: ${JSON.stringify(i5xx)}`);
    if ((i5xx.match(/read \/health again in a minute/g) || []).length === 3)
      ok('and all three instruction lines say to read /health again in a minute instead');
    else fail(`the boot lines do not tell the reader to look again: ${JSON.stringify(i5xx)}`);
  }

  // ---- 4. 503 and 429, the other two ways upstream says "not now" -----------
  {
    const { h } = await boot({ auth: 503, admin: 503, social: 429 }, '503/429');
    eq(h, 'supabase', 'upstream_error', 'on a 503');
    eq(h, 'supabaseAdmin', 'upstream_error', 'on a 503');
    notKeyBlame(h, 'supabaseAdmin', 'on a 503');
    eq(h, 'supabaseSocial', 'upstream_error', 'on a 429 — a rate limit is not a credential fault');
    notKeyBlame(h, 'supabaseSocial', 'on a 429');
  }
  {
    const { h } = await boot({ auth: 429, admin: 429, social: 503 }, '429/503');
    eq(h, 'supabase', 'upstream_error', 'on a 429');
    eq(h, 'supabaseAdmin', 'upstream_error', 'on a 429 — a rate limit is not a credential fault');
    notKeyBlame(h, 'supabaseAdmin', 'on a 429');
    eq(h, 'supabaseSocial', 'upstream_error', 'on a 503');
  }

  // ---- 5. a table is not there ---------------------------------------------
  {
    const { h, log } = await boot({ auth: 404, admin: 404, social: 404 }, '404');
    // For the AUTH endpoint a 404 is a wrong URL, not a missing table — there is
    // no table involved — so the existing word is the right one.
    eq(h, 'supabase', 'bad_key_or_url', 'on a 404 from /auth/v1/health, which is a fixed endpoint: a 404 there IS a URL fault');
    eq(h, 'supabaseAdmin', 'tables_missing', 'when a privileged table 404s — the verdict names the TABLE, not the key');
    notKeyBlame(h, 'supabaseAdmin', 'on a 404');
    eq(h, 'supabaseSocial', 'migration_missing', 'when the phase 6 tables 404 — unchanged, and the state the ship procedure looks for');
    if (/push_subscriptions and\/or error_reports are missing/.test(instructions(log)))
      ok('and the admin boot line names those two tables instead of the secret key');
    else fail(`the admin boot line for a missing table: ${JSON.stringify(instructions(log))}`);
    // THE VERDICT IS NOT THE WHOLE INSTRUCTION. Step 7 of the ship procedure has
    // the owner read supabaseSocial, but what he sees FIRST, on the deploy log,
    // is this line — and it has to say the migration is missing in the words the
    // procedure uses, not "check SUPABASE_SECRET_KEY", which sends him to rotate
    // a key that is fine. This assertion is the one thing the ledger-route suite
    // deleted on 2026-09-30 carried that nothing else did; it was moved here
    // rather than dropped, and the overlap was proved before that suite went.
    if (/FRIENDS\/CALLSIGNS are dead: the phase 6 migration has not been applied/.test(instructions(log)))
      ok('and the social boot line says the migration is missing, in those words, on stderr');
    else fail(`the social boot line for a missing migration: ${JSON.stringify(instructions(log))}`);
  }

  // ---- 6. a column is not there, and a 403 ---------------------------------
  {
    const { h } = await boot({ auth: 200, admin: 403, social: { profiles: 400, _: 200 } }, '400/403');
    eq(h, 'supabaseSocial', 'migration_missing', 'when ONLY the three new columns 400 — the column half of the migration, unchanged');
    // 403 is a grant or RLS fault. The brief's rule, kept deliberately: anything
    // not positively identified stays with the key. This narrows what gets blamed
    // on the key; it does not widen what gets excused.
    eq(h, 'supabaseAdmin', 'bad_secret_key', 'on a 403 — the conservative fallback is kept for anything not positively identified');
  }

  // ---- 7. PRECEDENCE: 401 beats everything ---------------------------------
  // One probe refused, another merely having a bad second. The refusal is the
  // actionable truth, and it also makes the other answer untrustworthy: you
  // cannot tell whether a table is there through a key that may not look.
  {
    const { h } = await boot({
      auth: 200,
      admin: { push_subscriptions: 401, error_reports: 500 },
      social: { profiles: 401, friendships: 404, _: 200 },
    }, 'precedence 401');
    eq(h, 'supabaseAdmin', 'bad_secret_key', 'when one probe is refused (401) and another 500s — the refusal wins, because it is the only status that asks the owner to change a secret');
    eq(h, 'supabaseSocial', 'bad_secret_key', 'when one probe is refused (401) and another 404s — a 404 read through a refused key proves nothing about the migration');
  }

  // ---- 8. PRECEDENCE: 404/400 beats 5xx ------------------------------------
  // The migration gate must survive a coincident blip. A 404 is DURABLE — it
  // will still be 404 in a minute — where a 503 will not, and supabaseSocial is
  // the single field the ship procedure reads to decide the hand-applied
  // migration landed. This is also what the old expression already did.
  {
    const { h } = await boot({
      auth: 200,
      admin: { push_subscriptions: 404, error_reports: 503 },
      social: { profiles: 404, friendships: 500, _: 200 },
    }, 'precedence 404');
    eq(h, 'supabaseSocial', 'migration_missing', 'when the migration is absent AND one probe 5xxs — a blip must not hide a missing migration from the one field the ship procedure reads');
    eq(h, 'supabaseAdmin', 'tables_missing', 'when a table is absent AND another probe 5xxs — the durable answer wins over the transient one');
  }
} catch (e) { fail('threw — ' + (e && e.message ? e.message : String(e))); }
done();
