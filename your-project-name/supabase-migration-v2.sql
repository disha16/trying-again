-- ─── Newsletter Digest — Supabase Schema v2 ──────────────────────────────────
-- Run this in the Supabase SQL editor after the initial migration.
-- Adds: issue_reports table + helper indexes.

-- Report-an-issue log (populated by the "Report an issue" button in the nav bar)
create table if not exists issue_reports (
  id          bigserial primary key,
  body        text not null,
  user_agent  text,
  url         text,
  created_at  timestamptz not null default now()
);
alter table issue_reports disable row level security;

-- Helpful index for TTL sweeps on read_stories
create index if not exists read_stories_read_at_idx on read_stories (read_at);

-- Helpful index for ran_at on digest_cache (for listDigests ordering + ttl)
create index if not exists digest_cache_ran_at_idx on digest_cache (ran_at);
