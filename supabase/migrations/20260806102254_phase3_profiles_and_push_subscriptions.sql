-- Phase 3 foundation (ADR-003 / ADR-005): player profiles + persisted push subscriptions.
-- Applied to project onacdpaxcqdfxikxiecy (ap-southeast-1) on 2026-08-06 via MCP
-- apply_migration; this file is the tracked record of exactly what ran.
--
-- Verified live the same day (see docs/TESTING.md in the governance pack):
--   * anonymous user inserts/reads/updates ONLY their own profiles row
--   * cross-user UPDATE touches 0 rows; row-id hijack rejected 403 (WITH CHECK)
--   * push_subscriptions invisible to anon/authenticated (RLS, no policies)
--   * updated_at trigger fires on update

-- One row per auth user (anonymous guest or linked account), owner-access only.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  callsign text check (callsign is null or char_length(callsign) <= 14),
  progression jsonb not null default '{}'::jsonb check (pg_column_size(progression) <= 65536),
  progression_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per player (anonymous or linked). progression mirrors the client''s localStorage career/achievements/cosmetics; owner-only access via RLS. 64KB cap stops abuse.';

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- No DELETE policy on purpose: profile rows leave only via account deletion,
-- which cascades from auth.users.

-- Web-push subscriptions, persisted server-side (closes ISSUE-003's storage gap).
-- Written ONLY by the game server with the secret key: RLS is enabled with NO
-- policies, so anon/authenticated cannot reach it even though it sits in the
-- exposed public schema.
create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  sub jsonb not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

comment on table public.push_subscriptions is
  'Web-push subscriptions keyed to users; service-key access only. Survives room teardown and restarts; multiple devices per user; endpoint unique so a re-subscribe upserts.';

alter table public.push_subscriptions enable row level security;

create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

-- updated_at maintenance for profiles.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();
