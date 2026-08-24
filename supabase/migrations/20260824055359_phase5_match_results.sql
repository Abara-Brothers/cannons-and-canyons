-- Phase 5 (RISK-004 steps 1–2): the match ledger.
--
-- WHY: the server already decides who won — `winner` is computed in
-- public/room-engine.js and broadcast — and then DISCARDS it. Entitlement can
-- only ever be derived from evidence the server witnessed, so without this table
-- there is nothing to derive from, and matches played before it exists can never
-- be reconstructed. That is why steps 1–2 are worth doing ahead of steps 3–4.
--
-- SCOPE, per the owner's decision of 2026-08-22 (option c, "trust offline,
-- verify online"): this records ONLINE matches only. Vs-CPU and solo Golf run
-- entirely in the browser and never reach a server, by design — no row can exist
-- for them, and progression earned there stays client-asserted on purpose.
--
-- ACCESS: service key only. RLS is enabled with NO POLICIES, which denies every
-- client outright — the same shape as error_reports. Players must never be able
-- to read or write the record that will later decide their entitlements.
--
-- NO RETENTION SWEEP, deliberately. error_reports is swept at 30 days because it
-- is diagnostics; this is the evidence base for entitlement and must be
-- permanent. Anything that deletes from here destroys the only proof a player
-- earned something.
-- Recreated once on 2026-08-22, before any row existed, to add vs_bot. Kept as a
-- single statement rather than a follow-up ALTER so the tracked file matches the
-- database exactly.
drop table if exists public.match_results;
create table public.match_results (
  id bigint generated always as identity primary key,
  mode text not null check (mode in ('duel', 'ffa', 'boss', 'golf', 'aliens')),
  -- Signed-in participants only. A seat whose socket never sent a valid token
  -- has no user id, so the array may be shorter than player_count — that is
  -- expected, not a defect, and is why both columns exist.
  players uuid[] not null default '{}',
  player_count smallint not null check (player_count between 1 and 8),
  -- A vs-CPU match played ONLINE is server-witnessed and lands here, but beating
  -- a bot must never later count as beating a human. Recorded now because the
  -- distinction cannot be recovered afterwards: once rows exist without this
  -- flag, nothing can say which were bot games.
  vs_bot boolean not null default false,
  -- null = draw, mutual destruction, or a match that ended with no single winner.
  winner_seat smallint check (winner_seat is null or winner_seat between 0 and 7),
  winner_user uuid,
  -- The golf card, where the mode has one. Capped like profiles.progression:
  -- an unbounded jsonb on a free-plan database is how a table becomes a problem.
  golf jsonb check (golf is null or pg_column_size(golf) <= 8192),
  ended_at timestamptz not null default now()
);

comment on table public.match_results is
  'Server-witnessed results of ONLINE matches (RISK-004 steps 1-2). Service-key only (RLS, no policies). The evidence base for server-derived entitlement -- never swept, never client-writable. Offline vs-CPU and solo Golf are absent by design (owner decision 2026-08-22, option c).';

alter table public.match_results enable row level security;

create index match_results_ended_at_idx on public.match_results (ended_at);
-- GIN so "which matches did this user play?" stays cheap once steps 3-4 derive
-- entitlement per player.
create index match_results_players_idx on public.match_results using gin (players);
