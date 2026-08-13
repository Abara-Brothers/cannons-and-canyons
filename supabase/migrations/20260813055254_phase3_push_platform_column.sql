-- Native push (FCM/APNs) joins web push in the same table (batch 8.57).
-- Applied to project onacdpaxcqdfxikxiecy on 2026-08-13 via MCP apply_migration;
-- this file is the tracked record of exactly what ran.
--
-- `endpoint` stays the unique delivery address and the upsert key, but its
-- CONTENT now depends on platform: for 'web' it is the browser push service
-- URL; for 'android'/'ios' it is the FCM registration token. One column, one
-- unique constraint, one upsert path — the alternative (a second nullable
-- token column plus a partial unique index) buys nothing and doubles the
-- number of states every query must consider.
alter table public.push_subscriptions
  add column platform text not null default 'web'
    check (platform in ('web', 'android', 'ios'));

comment on column public.push_subscriptions.platform is
  'web = endpoint is a browser push URL and sub holds the p256dh/auth keys; android/ios = endpoint is the FCM registration token and sub is the raw registration payload.';

create index push_subscriptions_platform_idx on public.push_subscriptions (platform);
