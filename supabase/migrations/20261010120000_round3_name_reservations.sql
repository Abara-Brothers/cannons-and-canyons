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
--   2. What it holds per player: the name they show, its look-alike key, a
--      SHA-256 of a random secret the game server gave their device (never
--      the secret itself), their account id once they have an account, whether
--      that account is linked, and when the row was made and last used.
--   3. That a row goes with its account (on delete cascade), and that the game
--      server deletes, once a day, every row of a player with no linked
--      account who has not connected for 90 days (server/reservations.js
--      sweep), so a guest's name is freed after 90 days unused.
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
-- name). name_key is server/callsign.js lookalikeSkeleton(name), computed by
-- the game server, so the UNIQUE constraint here is the authority on who
-- holds a name: of two players reserving the same one in the same moment,
-- one insert wins and the other is answered with a new default name.
--
-- THE KEY'S CAP IS 288, MEASURED, NOT GUESSED (the phase 6 lesson: a backstop
-- that refuses a legitimate name is a live failure nobody can explain). A
-- name is at most 16 code points (CALLSIGN_MAX), and a sweep of every letter,
-- digit and mark in the Unicode code space on this Node finds the longest
-- skeleton of one code point to be 18 (U+FDFA, which NFKD spells out as a
-- whole phrase), so 16 x 18 = 288 bounds every key the server can make.
-- server/store.js RES_KEY_MAX carries the same number. char_length counts
-- code points, as the server's [...s].length does.
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
  -- A row with no holder is a name nobody can ever claim or free.
  check (secret_hash is not null or user_id is not null)
);

comment on table public.name_reservations is
  'Every player''s one name (owner, 2026-10-10: no two players with the same name), reserved by the game server when the player first connects, guests included. Service-key only (RLS, no policies): no client may read who holds a name or write one. A row''s holder is a device (secret_hash) or an account (user_id), or both once a device''s row has moved to the account it got. Deleted with its account; a row whose holder has no linked account and has not connected for 90 days is deleted by the game server''s daily sweep.';

comment on column public.name_reservations.name is
  'The name as shown, 3 to 16 characters, as the game server normalised it. Never written by a client.';

comment on column public.name_reservations.name_key is
  'server/callsign.js lookalikeSkeleton(name): the name with case folded and look-alike letters read as the Latin letters they imitate. UNIQUE: the authority on who holds a name. Capped at 288, the measured bound for a 16-character name.';

comment on column public.name_reservations.secret_hash is
  'SHA-256 (hex) of a random 256-bit secret the game server issued to the device and the device keeps. The secret itself is never stored. NULL for an account''s row reserved on a device that already holds another row.';

comment on column public.name_reservations.user_id is
  'The account (anonymous or linked) the row belongs to, once the player has one. Cascades with account deletion.';

comment on column public.name_reservations.linked is
  'True when the holder is a linked (non-anonymous) account. A linked account''s row is never swept; every other row is, after 90 days unused.';

comment on column public.name_reservations.last_seen_at is
  'When the holder last connected, written at most once a day. The 90-day sweep reads it.';

alter table public.name_reservations enable row level security;

-- The daily sweep's one question: unlinked rows unused since a cutoff. A
-- partial index, because linked rows are never swept and need no entry.
create index name_reservations_sweep_idx on public.name_reservations (last_seen_at) where not linked;

-- Closes the `begin;` at the head of the file: all of it or none of it.
commit;
