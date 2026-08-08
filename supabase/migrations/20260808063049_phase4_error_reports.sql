-- Phase 4 (ISSUE-006): minimal self-hosted crash/error reports.
-- Applied to project onacdpaxcqdfxikxiecy on 2026-08-07 via MCP apply_migration;
-- this file is the tracked record of exactly what ran.
-- Written ONLY by the game server with the secret key. No user identity is
-- ever stored — no account id, no IP — so a crash report can never become a
-- profile. Field caps are enforced here as well as server-side. Retention is
-- the server's nightly sweep (30 days).
create table public.error_reports (
  id bigint generated always as identity primary key,
  side text not null check (side in ('client', 'server')),
  message text not null check (char_length(message) <= 500),
  stack text check (stack is null or char_length(stack) <= 4000),
  source text check (source is null or char_length(source) <= 300),
  version text check (version is null or char_length(version) <= 40),
  platform text check (platform is null or char_length(platform) <= 200),
  created_at timestamptz not null default now()
);

comment on table public.error_reports is
  'Anonymous crash/error reports (ISSUE-006). Service-key only (RLS, no policies). No identity, no IP. 30-day retention swept by the game server.';

alter table public.error_reports enable row level security;

create index error_reports_created_at_idx on public.error_reports (created_at);
