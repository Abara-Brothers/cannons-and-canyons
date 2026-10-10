-- Round 3 (owner, 2026-10-10, item 28): every player's name is reserved on
-- the server, so no two players can hold the same name.
--
-- NOT APPLIED. This file is the tracked record of exactly what must run
-- against project onacdpaxcqdfxikxiecy (ap-southeast-1), BY HAND, after the
-- owner approves it, the same two ways the phase 6 file names: the Supabase
-- connector's apply_migration (which records it in the project's ledger), or
-- the dashboard SQL editor (which records nothing). The game server ships
-- BEFORE this and runs safely without it: until the table answers, unique
-- names are OFF and the old name rules apply (server/reservations.js), and
-- /health reads supabaseNames: 'migration_missing' and nameReservations:
-- 'off'. Within thirty seconds of this being applied, with no restart, the
-- server reads the table, nameReservations reads 'on', and every player is
-- reserved their name the next time they connect.
--
-- WHAT THE OWNER IS APPROVING, in full:
--   1. One NEW table, public.name_reservations, with RLS on and no policies:
--      no client can read or write it; only the game server's secret key can.
--   2. What it holds per player: the name they show, its key (the name in
--      lower case), its ONE holder, which is either a SHA-256 of a random
--      secret the game server gave their device (never the secret itself) or,
--      once they have an account, their account id instead, whether that
--      account is linked, when the row was made and last used, and whether its
--      holder has ever come back on a later day.
--   3. That a row goes with its account (on delete cascade), and that the game
--      server deletes, once a day, every row of a player with no linked
--      account who has not connected for 90 days (server/reservations.js
--      sweep), so a guest's name is freed after 90 days unused. And that, only
--      when the table has reached the server's ceiling of 100,000 rows, the
--      server deletes the oldest rows that no linked account holds, that
--      nobody ever came back to and that are more than a day old, a thousand
--      at most a minute (server/reservations.js prune), which is what a flood
--      of throwaway names leaves behind.
--   4. Nothing else: no existing table, column, grant or row is touched, and
--      no data is copied in. Existing players are reserved their names as
--      they connect, first come first kept (the owner's "First keeps it").
--
-- WHY A TABLE OF ITS OWN, and not a column on profiles: a guest who has
-- never saved has no profile row (and may never get one: the anonymous
-- sign-in that makes one is limited per IP address, and a mobile carrier puts
-- many phones behind one address). The reservation must exist for every
-- player who reaches the game server, so its holder is the server's own
-- device secret first and an account second. And profiles is a CLIENT-
-- WRITABLE table (profiles_update_own); a name the server vouches for cannot
-- live in a row the player may PATCH.
--
-- WHY name_key IS UNIQUE AND NOT name: names are unique ignoring capitals and
-- look-alike letters ('Viper', 'viper' and 'Viper' with a Cyrillic i are one
-- name). name_key is the name in lower case, computed by the game server
-- exactly as profiles.callsign_key is, so the UNIQUE constraint here is the
-- authority on the same name in other capitals, in every script: of two
-- players reserving it in the same moment, one insert wins and the other is
-- answered with a new default name. Look-alike letters are kept apart by the
-- game server before it writes, from every reading of every key it holds in
-- memory (server/callsign.js keyReadings), as chosen callsigns always have
-- been. (The key was a look-alike skeleton of one spelling in an earlier
-- draft of this file, and a Greek name in capitals reads as different
-- letters from the same name in lower case, so 'Αννα' and 'ΑΝΝΑ' were two
-- keys: two players could hold one name.)
--
-- EXACTLY ONE HOLDER PER ROW: a device's secret or an account, never both.
-- When a guest gets an account, the server moves the device's row to the
-- account and takes the secret off it in the same write, so a device's
-- secret can never name an account: a signed-out device, or another person
-- on a shared one, gets a name of its own, and cannot rename the account's.
--
-- THE KEY'S CAP IS 288, MEASURED, NOT GUESSED (the phase 6 lesson: a backstop
-- that refuses a legitimate name is a live failure nobody can explain). A
-- name is at most 16 code points (CALLSIGN_MAX), and a sweep of every code
-- point on this Node finds the longest lower case of one to be 2 (U+0130), so
-- a key is at most 32. The cap was set at 16 x 18 = 288 when the key was a
-- look-alike skeleton (U+FDFA's NFKD is 18), and it still bounds every key
-- with room to spare. server/store.js RES_KEY_MAX carries the same number.
-- char_length counts code points, as the server's [...s].length does.
--
-- RUNNING THIS TWICE fails on the CREATE TABLE and rolls back whole, leaving
-- the database as it was: no `if not exists`, for the phase 6 file's reason.
-- LOCK_TIMEOUT for that file's reason too, although a new table takes no lock
-- any live query is waiting on: the foreign key to auth.users takes a SHARE
-- ROW EXCLUSIVE lock on auth.users while it is created, and a sign-in queued
-- behind a waiting lock is the outage that setting exists to prevent.
begin;

set local lock_timeout = '5s';

create table public.name_reservations (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 3 and 16),
  name_key text not null unique check (char_length(name_key) between 1 and 288),
  secret_hash text unique check (secret_hash is null or secret_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid unique references auth.users (id) on delete cascade,
  linked boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  reused boolean not null default false,
  -- Exactly one holder. A row with none is a name nobody can ever claim or
  -- free; a row with both is an account's name that a device's secret would
  -- also answer for.
  check ((secret_hash is null) <> (user_id is null))
);

comment on table public.name_reservations is
  'Every player''s one name (owner, 2026-10-10: no two players with the same name), reserved by the game server when the player first connects, guests included. Service-key only (RLS, no policies): no client may read who holds a name or write one. A row''s one holder is a device (secret_hash) or an account (user_id), never both: a device''s row that moves to the account it got gives up its secret in the same write. Deleted with its account; a row whose holder has no linked account and has not connected for 90 days is deleted by the game server''s daily sweep; at the server''s ceiling of 100,000 rows the oldest unlinked rows nobody ever came back to, over a day old, are deleted first.';

comment on column public.name_reservations.name is
  'The name as shown, 3 to 16 characters, as the game server normalised it. Never written by a client.';

comment on column public.name_reservations.name_key is
  'The name in lower case, exactly as profiles.callsign_key is made. UNIQUE: the authority on who holds a name in any capitals, in every script. Look-alike letters are refused by the game server from every reading of every key before it writes. Capped at 288, a bound with room to spare (a 16-character name lower-cases to at most 32).';

comment on column public.name_reservations.secret_hash is
  'SHA-256 (hex) of a random 256-bit secret the game server issued to the device and the device keeps. The secret itself is never stored. Set on a device''s row only; NULL on every account''s row, so a device''s secret never names an account.';

comment on column public.name_reservations.user_id is
  'The account (anonymous or linked) the row belongs to, once the player has one; NULL on a device''s row. Cascades with account deletion.';

comment on column public.name_reservations.linked is
  'True when the holder is a linked (non-anonymous) account. A linked account''s row is never swept; every other row is, after 90 days unused.';

comment on column public.name_reservations.last_seen_at is
  'When the holder last connected, written at most once a day. The 90-day sweep reads it.';

comment on column public.name_reservations.reused is
  'True once the holder came back: a claim found the row a day or more after it was made, or the row moved to an account. Never set back to false. Only rows where it is false are pruned at the ceiling.';

alter table public.name_reservations enable row level security;

-- The daily sweep's one question: unlinked rows unused since a cutoff. A
-- partial index, because linked rows are never swept and need no entry.
create index name_reservations_sweep_idx on public.name_reservations (last_seen_at) where not linked;

-- The prune's one question, asked only at the ceiling: the oldest unlinked
-- rows nobody came back to. Partial for the same reason, and its predicate
-- spelt as PostgREST spells the server's filters (linked=is.false,
-- reused=is.false), so the planner can prove the query lies inside it.
create index name_reservations_prune_idx on public.name_reservations (id) where linked is false and reused is false;

-- Closes the `begin;` at the head of the file: all of it or none of it.
commit;
