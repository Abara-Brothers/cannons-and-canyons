# Restore runbook — Cannons & Canyons

> Written after the **2026-08-14 restore drill**, which actually ran: the schema
> was rebuilt from the tracked migrations into an isolated schema, the live data
> was reloaded into it, and the fingerprints matched the originals exactly.
> Everything below is what that drill established, not what ought to work.

## What protects this data today

| | |
|---|---|
| Automatic daily backups | **NONE.** Confirmed 2026-08-15: this project is on the **FREE** plan |
| Point-in-time recovery | **NONE.** Paid add-on, Pro and above only |
| What we rely on | `tools/backup/backup-auto.sh` on a weekly schedule |

> **Confirmed 2026-08-15, and it was worse than this page assumed.** The plan is
> **free**, so there are no automatic backups and no PITR — and on the same day
> it emerged that `backup.sh` **had never been run**: there was no `backups/`
> directory, and the Supabase CLI was not installed, so it could not have run.
> The sentence that used to sit here — "`backup.sh` is the only thing standing
> between a mistake and permanent loss" — was true, and nothing was standing
> there. A backup procedure nobody runs is not a backup procedure.
>
> `backup-auto.sh` + `install-schedule.sh` now make it unattended, a weekly
> launchd job runs it, and both scripts **refuse loudly** rather than scheduling
> something that would fail silently every week. The dumps are still LOCAL —
> that covers a bad migration or a mistaken delete, not a lost laptop.
>
> **Setup is one command, and you never edit a connection string:**
>
> ```bash
> bash tools/backup/setup-credential.sh
> ```
>
> It takes the dashboard's URI pasted **unedited** (the password field in it is
> parsed out and thrown away) and then the password on its own, through macOS's
> hidden prompt. Host, port, user and database — none of them secret — go to
> `tools/backup/db.conf`; the password goes to the Keychain, and reaches
> `pg_dump` through `PGPASSWORD`. It is never in a file, an argument, `ps`, or
> shell history, and because it is not part of a URI it needs no percent-encoding.
>
> That design is the direct result of 2026-08-17: the previous instructions had a
> human splice the password into the URI by hand, which produced a value with the
> dashboard's square brackets still around it. `psql` rejected it **by quoting the
> password field back into the terminal**, and the credential had to be rotated.
> The editing step was the defect, so it no longer exists.

## The finding that matters most

**A `public`-only dump is NOT restorable.** Every row in `profiles` and
`push_subscriptions` has a foreign key to `auth.users`. Restoring `public` into
a fresh project fails immediately with a foreign-key violation — verified in the
drill by attempting exactly that insert:

```
REJECTED by FK — a public-only backup is NOT restorable without auth.users
```

So a backup **must** include the `auth` schema, and a restore **must** load it
first. `backup.sh` does this; a hand-rolled `pg_dump --schema=public` does not,
which is the trap this runbook exists to prevent.

## Restoring

### Case 1 — a bad migration or a bad delete, project intact

1. Stop writes: Render → the service → **Suspend** (players see the offline
   game; matches in progress are lost either way).
2. Restore in dependency order, always auth first:
   ```bash
   bash tools/backup/db-connect.sh -f <backup>/roles.sql
   bash tools/backup/db-connect.sh -f <backup>/auth.sql
   bash tools/backup/db-connect.sh -f <backup>/public.sql
   ```
   `db-connect.sh` is plain `psql` with the stored credential applied, so there
   is no URI to assemble while under pressure. Any psql argument passes through.
3. Verify before resuming — see **Verify** below.
4. Resume the Render service and check `/health` reports
   `supabase=ok supabaseAdmin=ok`.

### Case 2 — the project is gone, rebuild from scratch

1. Create a new Supabase project **in ap-southeast-1** (co-located with Render;
   the original was moved out of Mumbai for exactly this reason).
2. Rebuild the schema by replaying the tracked migrations, in filename order:
   ```bash
   bash tools/backup/setup-credential.sh   # re-point it at the NEW project first
   for f in supabase/migrations/*.sql; do bash tools/backup/db-connect.sh -f "$f"; done
   ```
   The drill proved these three files reconstruct every table, index, RLS
   policy and trigger with no manual steps.
3. Load `auth.sql`, then `public.sql`, as above.
4. Re-enable **anonymous sign-ins** and **Google** (Auth → Providers), and
   **manual linking** (Auth → settings) — none of this is in a SQL dump.
5. Update the three Render env vars to the new project — `SUPABASE_URL`,
   `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` — plus
   `public/config.js` (`CC_SUPABASE_URL`, `CC_SUPABASE_KEY`) and redeploy.
   **Getting one of these wrong is what caused ISSUE-035**, which silently
   broke accounts, push and deletion for nine batches. `/health` now catches it.
6. Google OAuth: add the new project's callback URL in the Google console.

## Verify — never assume a restore worked

Run this against the restored database and compare with the manifest / the
pre-restore values:

```sql
select
  (select count(*) from auth.users)                as auth_users,
  (select count(*) from public.profiles)           as profiles,
  (select count(*) from public.push_subscriptions) as push_subs,
  (select md5(coalesce(string_agg(
     p.id::text || coalesce(p.callsign,'') || p.progression::text, '|' order by p.id), ''))
   from public.profiles p)                         as profiles_fingerprint;
```

The fingerprint is the real test: equal counts can still hide corrupted
progression JSON. In the drill, original and restored both read
`66f62169a2d39b0fb7b871f77f3e2be0`.

Then exercise the app, not just the database:

- `curl -s https://tanks.abarabrothers.com/health` → `supabase` **and**
  `supabaseAdmin` both `ok`
- sign in, confirm the career numbers came back
- enable nudges, confirm a row appears in `push_subscriptions`

## Drill schedule

Re-run a drill **whenever a migration changes the schema**, and otherwise every
few months. A restore path that has not been exercised since the last schema
change is a guess. The drill is cheap: rebuild the migrations into a throwaway
schema, reload the data, compare fingerprints, drop the schema — it touches
nothing in `public` and took about two minutes.
