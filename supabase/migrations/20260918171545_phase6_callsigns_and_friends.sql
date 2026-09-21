-- Phase 6 (squads/friends design 2026-09-18, sections 3.1 and 3.2): chosen
-- callsigns, the friend graph, blocks and name reports.
--
-- NOT YET APPLIED at the time this file was committed. It is the tracked record
-- of exactly what must run against project onacdpaxcqdfxikxiecy
-- (ap-southeast-1), and it is applied BY HAND, one of two ways:
--   * through the Supabase connector's apply_migration, which runs this SQL and
--     records this file's name in the project's migration ledger; or
--   * by pasting it into the dashboard SQL editor, which runs the same SQL and
--     records NOTHING — after that route the ledger still believes this
--     migration is pending, so a later tooling run will try it again and fail.
-- Fill this line in when it is actually applied, and say which route:
--
--   APPLIED: <DATE> via <apply_migration | dashboard SQL editor>
--
-- WHY: a callsign today is ROLLED from two word lists and is not unique, so
-- there is nothing one player can type to find another. Friends therefore need
-- two things that do not exist yet — a stable handle per account (friend_code,
-- and for players who choose one, a unique callsign_key) and somewhere to record
-- who knows whom. Both are account-lifetime facts, so neither can live in the
-- game server's memory the way rooms and squads do: a restart must cost a player
-- their squad, never their friends.
--
-- ACCESS, the four new tables: service key only. RLS is enabled with NO
-- POLICIES, which denies anon and authenticated outright — the same shape as
-- push_subscriptions, error_reports and match_results. That is not belt and
-- braces here. These tables ARE the social graph, and a table with no policies
-- is the only version of it that no client can enumerate: not "who are my
-- friends", which is fine, but "who has blocked whom" and "who reported whom",
-- which are not. Every social action is a socket message the game server
-- executes with the secret key.
--
-- ACCESS, profiles: different, and this migration has to be careful with it,
-- because it is an EXISTING CLIENT-WRITABLE table. profiles_update_own lets a
-- signed-in player PATCH their own row with the publishable key, and
-- public/cloud.js save() does exactly that on every cloud save. An RLS policy
-- decides WHICH ROWS, never which COLUMNS. Without the column grants at the
-- bottom of this file the three new columns would be writable by the player they
-- describe: a browser could set callsign_key to any value it liked — taking
-- somebody else's name, skipping the blocklist and skipping the once-a-day rule
-- the server enforces — and rewrite its own friend_code at will. Column
-- privileges are the only mechanism that can say no, so they ship WITH the
-- columns rather than in a follow-up nobody writes.
--
-- friend_code is NULLABLE, against the design's `not null`. Three reasons, all
-- about the live database rather than the schema:
--   1. NOT NULL + UNIQUE must be filled for every existing row in the same
--      statement, and the value is random, so the backfill needs a collision
--      retry loop. A live database is the worst place to run one.
--   2. That backfill is an UPDATE, and profiles_set_updated_at fires on update.
--      Every profile row would come out with a fresh updated_at — and
--      tools/backup/restore-drill.sh excludes rows touched after the dump from
--      its content hash, so the drill would go on printing IDENTICAL while
--      hashing zero profiles.
--   3. The same drill restores a data-only pg_dump taken BEFORE this column
--      existed. Its COPY names the old column list, so a NOT NULL column with
--      no default makes every archived backup fail to load.
-- The server fills it on first use instead (ensureFriendCode), where the retry
-- on a unique violation is one catch block.
--
-- RUNNING THIS TWICE does nothing and says so: there is no `if not exists`
-- anywhere below, deliberately. Supabase runs a migration inside a transaction,
-- so a second run fails on the first ALTER and rolls the whole thing back,
-- leaving the database exactly as it was. That is the behaviour worth having on
-- a live database — an `if not exists` version would half-apply against a schema
-- that had drifted and report success.
--
-- LOCK_TIMEOUT, the first statement below, and it is here for the live database
-- rather than for correctness. The whole file is one transaction, so the ACCESS
-- EXCLUSIVE lock the first ALTER takes on profiles is held until COMMIT. If any
-- query is still running on profiles when that ALTER arrives, the ALTER WAITS —
-- and every cloud save and sign-in that arrives after it queues behind it too,
-- because a pending ACCESS EXCLUSIVE request blocks the readers behind it. That
-- is the bad outcome: a migration whose real work is milliseconds turns into a
-- live outage of unknown length. Five seconds makes it FAIL FAST instead. The
-- transaction rolls back whole, nothing is applied, nothing is half-applied,
-- and the answer is to run it again in a quieter moment. `set local` is scoped
-- to this transaction and cannot leak into the connection afterwards. (Run
-- outside a transaction block it is a no-op with a warning — the same safety as
-- not having it, never worse.)

set local lock_timeout = '5s';

-- ONE statement, three columns — and NOT because it takes the lock fewer times.
-- Inside one transaction the ACCESS EXCLUSIVE lock on profiles is taken once and
-- held to COMMIT either way. The reason is that one statement does ONE PASS over
-- the table: one rewrite if one were ever needed, one validation scan, one set of
-- catalog updates, instead of three of each while that lock is held. No DEFAULT
-- and no NOT NULL, so there is no table rewrite at all here; the two UNIQUE
-- constraints do each build an index, which is the only real work and is
-- milliseconds at this table's size.
--
-- No `callsign_key = lower(callsign_key)` check, deliberately. The key is
-- produced by JavaScript's toLowerCase(), and Postgres lower() does not agree
-- with it on every Unicode letter (dotted capitals are the classic case). A
-- CHECK that disagrees with its producer rejects a legitimate name at write
-- time — a live failure for one player and impossible to explain.
--
-- THE KEY IS CAPPED AT 32, NOT AT 16, AND THAT IS THE SAME LESSON APPLIED TWICE.
-- The sentence that stood here said "length is the part both sides compute
-- identically", and it was FALSE FOR THE VERY CHARACTER IT NAMES. The NAME is
-- capped at 16 code points by server/callsign.js (CALLSIGN_MAX); the KEY is
-- `name.toLowerCase()`, and JavaScript applies Unicode SpecialCasing, under
-- which 'İ' (U+0130) lowercases to TWO code points, U+0069 + U+0307. So the
-- 16-character Turkish name "İzmirli Kaptanım" produces a 17-character key,
-- char_length() counts 17, and a `between 3 and 16` CHECK rejects it — as
-- PostgREST 400/23514, which server/store.js's isConflict (anchored to 409) does
-- not recognise, so the player is told "Cannot reach the server", for ever, for
-- every name of that shape, with nothing in the log and /health reading ok.
-- Exactly the outcome the paragraph above says the design was avoiding.
--
-- 32 is the TIGHT bound, not a guess: a sweep of the entire Unicode code space
-- on this Node finds U+0130 to be the ONLY code point whose toLowerCase()
-- expands at all, and it expands to exactly two, so a 16-code-point name can
-- produce at most a 32-code-point key. toLowerCase() never shortens, so the
-- lower bound of 3 still follows from the name's own minimum. The cap the
-- PLAYER sees stays 16 and is enforced where a player can be told about it, in
-- the producer; this CHECK is the backstop against a runaway key, and a backstop
-- that refuses legitimate names is not one.
alter table public.profiles
  add column friend_code text unique
    check (friend_code is null or friend_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),
  add column callsign_key text unique
    check (callsign_key is null or char_length(callsign_key) between 3 and 32),
  add column callsign_set_at timestamptz;

comment on column public.profiles.friend_code is
  'Six characters from ABCDEFGHJKMNPQRSTUVWXYZ23456789 — no I, L, O, 0 or 1, because this gets read off one phone screen onto another. Stored bare, shown as FR-XXXXXX. Nullable: the game server generates it on first use (ensureFriendCode) and the client cannot write it (see the column grants below).';

comment on column public.profiles.callsign_key is
  'The CHOSEN callsign, lower-cased with whitespace collapsed: the uniqueness key. NULL for every ROLLED callsign, so rolled names never collide with anyone and are not searchable. Rolling again clears it back to NULL.';

comment on column public.profiles.callsign_set_at is
  'When the chosen callsign was last set; the once-per-day rule reads this. NULL means the player has never chosen one.';

-- The display-name cap moves from 14 to 16: CHOSEN callsigns are CALLSIGN_MAX =
-- 16, while ROLLED ones stay inside NAME_MAX = 14 because the word lists are
-- built for it. The 2026-08-06 migration wrote this check INLINE and UNNAMED, so
-- Postgres generated its name, and a column CHECK can only be dropped by name.
--
-- Rather than hardcode profiles_callsign_check — which is only the name Postgres
-- HAPPENS to generate, and is wrong the moment anyone has renamed it — find it by
-- what it CONSTRAINS and refuse to guess. The match is on con.conkey, the exact
-- set of columns the check covers, not on the text of its definition. Two
-- reasons, and the second one is why this is not the obvious version:
--
--   * pg_get_constraintdef re-renders the grammar, so char_length(x) comes back
--     as length(x) and searching for the text that was written in 2026-08-06
--     finds nothing at all;
--   * searching instead for the substring 'callsign' finds TWO rows by the time
--     this block runs, because the ALTER above has just added
--     `check (callsign_key is null or ...)`, whose definition also contains
--     'callsign'. A substring match would count 2, raise, and abort a migration
--     that is perfectly correct. conkey cannot be fooled that way: the old check
--     covers {callsign}, the new one covers {callsign_key}, and they are
--     different columns.
--
-- Doing nothing silently is the outcome being designed against. It would leave
-- the 14 in place and make every chosen callsign of 15 or 16 characters fail on
-- production, which the player would see as "unavailable" and nobody would be
-- able to explain.
do $$
declare
  n integer;
  c text;
begin
  select count(*), min(con.conname)
    into n, c
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    join pg_attribute att on att.attrelid = rel.oid
                         and att.attname = 'callsign'
                         and not att.attisdropped
   where ns.nspname = 'public'
     and rel.relname = 'profiles'
     and con.contype = 'c'
     and con.conkey = array[att.attnum];
  if n <> 1 then
    raise exception 'expected exactly 1 CHECK constraint covering public.profiles.callsign, found % — stop and look before changing it', n;
  end if;
  execute format('alter table public.profiles drop constraint %I', c);
end
$$;

-- Named from here on, so the next change to the cap is one line and no lookup.
alter table public.profiles
  add constraint profiles_callsign_len
  check (callsign is null or char_length(callsign) <= 16);

-- One row per PAIR, stored in uuid order, so a friendship has exactly one
-- representation and "are these two friends?" is one primary-key lookup rather
-- than two. The CHECK is what makes that invariant real: without it the same
-- pair can be inserted both ways round, and the unfriend path then leaves the
-- mirror row behind — two people who cannot see each other in their own lists
-- and cannot remove what is left.
create table public.friendships (
  user_a uuid not null references auth.users (id) on delete cascade,
  user_b uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);

comment on table public.friendships is
  'Mutual friend links, one row per pair in uuid order (user_a < user_b). Service-key only (RLS, no policies): the friend graph must not be enumerable by any client. Cascades with account deletion, so a deleted account leaves no trace in anyone else''s list.';

alter table public.friendships enable row level security;

-- The primary key indexes (user_a, user_b), which answers "my friends" only when
-- I am user_a. Half of every player's friendships have them as user_b.
create index friendships_user_b_idx on public.friendships (user_b);

-- A request is a PROPOSAL, not a relationship: directional, at most one per
-- ordered pair, and deleted the moment it is accepted or declined. The unique
-- constraint is what makes "request again" idempotent instead of a pile of rows;
-- the self-check refuses the nonsense case in the database as well as the server,
-- because a row nobody can accept would sit in the recipient's list forever.
create table public.friend_requests (
  id bigint generated always as identity primary key,
  from_user uuid not null references auth.users (id) on delete cascade,
  to_user uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (from_user, to_user),
  check (from_user <> to_user)
);

comment on table public.friend_requests is
  'Pending friend requests, one per ordered pair. Service-key only (RLS, no policies). A request older than 30 days is ignored and deleted the next time it is read — there is no sweep, because nobody is harmed by a stale row nobody can see.';

alter table public.friend_requests enable row level security;

-- The unique constraint indexes (from_user, to_user), so "requests I sent" is
-- covered and "requests I received" is not. The incoming list is the one a
-- player actually looks at.
create index friend_requests_to_user_idx on public.friend_requests (to_user);
-- created_at is read on its OWN by the 30-day expiry described in the table
-- comment: "older than 30 days" is a range over this column across the whole
-- table, not within one player's rows, so neither the unique constraint nor the
-- to_user index covers it.
create index friend_requests_created_at_idx on public.friend_requests (created_at);

-- Blocks are DIRECTIONAL and stay that way: A blocking B is not B blocking A,
-- and the unblock path must remove exactly the one row its owner created. So no
-- ordering check here, unlike friendships — the pair order IS the meaning.
create table public.blocks (
  blocker uuid not null references auth.users (id) on delete cascade,
  blocked uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);

comment on table public.blocks is
  'Directional blocks (blocker hides blocked). Service-key only (RLS, no policies) — a client that could read this learns who has blocked it, which is the one fact a block must never leak. Every friend, request, search and invite path checks BOTH directions.';

alter table public.blocks enable row level security;

-- The primary key covers "who have I blocked"; this covers "who has blocked
-- me", which every search and invite path asks just as often.
create index blocks_blocked_idx on public.blocks (blocked);

-- Reports of an offensive callsign. The name is stored AS SEEN, not joined at
-- review time: the reported player can change it a minute later, and a report
-- that no longer says what was reported is not evidence of anything. Capped at
-- the same 16 as the column it copies.
create table public.name_reports (
  id bigint generated always as identity primary key,
  reporter uuid not null references auth.users (id) on delete cascade,
  reported uuid not null references auth.users (id) on delete cascade,
  callsign text not null check (char_length(callsign) between 1 and 16),
  created_at timestamptz not null default now()
);

comment on table public.name_reports is
  'Player reports of an offensive callsign, with the name as it stood when reported. Service-key only (RLS, no policies). Reviewed by the owner in the Supabase dashboard; the server also logs the event. There is NO email delivery — the game has no email provider (design section 10). Rate-limited to one report per reporter per reported per day by the server. BOTH user columns cascade on account deletion, so deleting a reported account also erases every report made ABOUT it — if a report is wanted as evidence, copy it out before the account goes.';

alter table public.name_reports enable row level security;

-- Review order: everything reported about one player, newest first.
create index name_reports_reported_idx on public.name_reports (reported, created_at desc);
-- The once-a-day dedupe (reportedSince) filters on all three columns at once.
create index name_reports_reporter_idx on public.name_reports (reporter, reported, created_at desc);

-- Column privileges on profiles. RLS decides WHICH ROWS a client may touch; it
-- cannot decide which COLUMNS, and profiles_update_own already lets a signed-in
-- player write their own row straight from the browser. So the three new columns
-- are taken out of what the client may write, by replacing the table-wide grant
-- with a column list.
--
-- Note the order. REVOKE of a single column does NOTHING while a table-level
-- grant exists — Postgres only warns — so the table-level privilege has to go
-- first and the columns be granted back. Getting that backwards produces a
-- migration that succeeds, prints a warning nobody reads, and changes nothing.
--
-- `id` stays in both lists ON PURPOSE. PostgREST's upsert writes every column in
-- the payload, the conflict column included, and public/cloud.js save() is an
-- upsert on id — dropping it here breaks cloud saves for every player. Setting
-- it to somebody else's id is already refused by the WITH CHECK on
-- profiles_update_own (verified 2026-08-06: row-id hijack -> 403).
--
-- created_at and updated_at are absent from both lists and stay that way. The
-- client never writes either, and profiles_set_updated_at sets updated_at from
-- inside a BEFORE trigger, where column privileges are not rechecked — the check
-- is against the columns named in the statement, not against what a trigger
-- assigns to NEW.
--
-- SELECT is untouched: the client still reads callsign, progression and
-- progression_version on restore(), and reading its own friend_code is how the
-- Friends screen will show it. Only writing is being taken away.
--
-- anon is untouched: every profiles policy is `to authenticated`, so RLS already
-- denies anon every row. An anonymous PLAYER is the authenticated role with an
-- is_anonymous claim, not the anon role.
revoke insert, update on public.profiles from authenticated;
grant insert (id, callsign, progression, progression_version) on public.profiles to authenticated;
grant update (id, callsign, progression, progression_version) on public.profiles to authenticated;
