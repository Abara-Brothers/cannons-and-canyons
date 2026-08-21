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

## Is this backup restorable? Run the drill and find out

```bash
bash tools/backup/restore-drill.sh          # newest backup; add a path for a specific one
```

It builds a throwaway PostgreSQL 17 cluster on port 55432, replays **exactly the
Case 2 sequence below** into it, and tears the cluster down afterwards. Nothing
touches production but one read (the `auth` schema DDL, standing in for what
Supabase creates automatically in a new project — our migrations do not create
`auth` and cannot).

**Result, 2026-08-18, against backup `20260818T052216Z`: PASSED.**

| Check | Result |
|---|---|
| roles → auth DDL → migrations → auth.sql → public.sql | all loaded |
| Row counts vs production | `auth.users` 16/16, `profiles` 14/14 |
| **Content** md5 of `auth.users` (id, role, email, created_at, is_anonymous) | **identical** |
| **Content** md5 of `profiles` (id, callsign, **progression**, version, created_at) | **identical** |
| `profiles` with no matching `auth.users` row — *the 2026-08-14 failure* | **0** |

The content hashes matter more than the counts: a restore can produce the right
number of rows and the wrong data in every one of them. The `progression` column
is in that hash, so **the actual game careers are verified, not just the account
shells**.

### Two things the drill will show you that are NOT faults

**`roles.sql` reports ~23 errors, and that is expected.** They are all
`already exists`, `permission denied to alter role`, and `permission denied to
grant privileges as role "supabase_admin"`. Supabase manages its own roles: they
exist before you restore, and the login you restore with is not `supabase_admin`.
The same refusals will appear against a real fresh Supabase project. The drill
classifies them and fails on anything else. **Do not "fix" them, and do not let
them stop you mid-restore** — the data steps after them are what matter.

**Timestamps must be compared in one timezone.** Supabase runs `UTC`; a local
cluster inherits the Mac's zone, so the same instant renders `+00` there and
`+10` here and every content hash differs for a reason that has nothing to do
with the backup. The drill exports `PGTZ=UTC` for both sides. This cost a
false failure before it was pinned.

## Getting a copy OFF this machine

The local dumps cover a bad migration or a mistaken delete. They do not cover a
lost, stolen or dead laptop — the disk holding the database copy is the same
disk holding the only copy of the copy.

```bash
bash tools/backup/offsite.sh                  # encrypt the newest backup
bash tools/backup/offsite.sh --verify <file>  # prove a copy is still good
bash tools/backup/offsite.sh --drill  <file>  # decrypt AND fully restore it
```

Output is one `.enc` file (12 KB for the current database) plus an unencrypted
`HOW-TO-DECRYPT.txt` — the command is not a secret, only the passphrase is.
Copy both anywhere: external disk, object storage, another machine.

**AES-256-CBC, PBKDF2-HMAC-SHA512, 600,000 iterations, random salt per archive.**
Plain `openssl`, deliberately: a recovery must never be blocked on installing
software, and `openssl` is already on every Mac and Linux box you might restore
from. The passphrase is fed on a file descriptor — never an argument (`ps` is
world-readable), never a temp file.

**Integrity is sealed inside the encryption.** `SHA256SUMS` is generated *before*
encrypting, so it travels within the ciphertext rather than beside it where
anyone could edit it to match altered content. Verified 2026-08-18 against all
four cases: correct passphrase passes; wrong passphrase, a **single flipped bit**,
and truncation all fail with exit 1 and a plain-language reason. The flipped-bit
case is the instructive one — CBC is malleable so the file still *decrypted*, and
the sealed checksum is what caught it. Treat the guarantee as "damage and
tampering are detected", not a formal AEAD; if an active attacker with write
access to your storage is the threat model, use `age` or `gpg` instead.

**Proven end to end, not assumed:** `--drill` decrypts an archive and runs the
full restore drill on its contents. Passed 2026-08-18 — 16/16 users, 14/14
profiles, zero orphaned foreign keys, content hashes identical to production.

### The passphrase is the whole thing — read this once, properly

It lives in your Keychain so the tooling can run unattended. **The Keychain is on
the laptop.** If the laptop is what you lost, that copy is gone with it and every
archive is unreadable permanently — there is no reset and no support line.

So create it in your password manager FIRST, save it there, and only then store
a copy for automation:

```bash
security add-generic-password -a "$USER" -s cc-backup-archive-passphrase -T /usr/bin/security -U -w
```

Nothing echoes as you paste. `offsite.sh` refuses to run until this exists, and
says exactly this if you try.

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
progression JSON.

**Compare against the `profiles_fingerprint` line in that backup's own
`MANIFEST.txt`** — it is computed at dump time, from the data actually in the
dump.

> **Corrected 2026-08-18.** This section used to quote a single hardcoded value,
> `66f62169a2d39b0fb7b871f77f3e2be0`, from the 2026-08-14 drill when there were
> **4** profiles. There are now 14, so that value **cannot match**, and the
> manifest it sent you to carried no fingerprint at all. A restore is done under
> pressure; meeting a mismatch you cannot explain is exactly when someone
> abandons a good backup. Run the query with `PGTZ=UTC` — `created_at` renders in
> the session timezone, and an unpinned comparison fails on formatting alone.

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
