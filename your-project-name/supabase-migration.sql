-- ─── Newsletter Digest — Supabase Schema ──────────────────────────────────────
-- Run this in the Supabase SQL editor once before deploying.

-- 1. Generic key-value store (replaces data.json / Vercel KV)
create table if not exists kv_store (
  key   text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- 2. Daily digest cache (one row per date, stores the full processed digest)
create table if not exists digest_cache (
  date_key   text primary key,          -- e.g. "2026-04-29"
  digest     jsonb not null,
  ran_at     timestamptz not null default now(),
  enriched   boolean not null default false
);

-- 3. Read stories (already exists — kept here for reference)
create table if not exists read_stories (
  id               bigserial primary key,
  headline         text not null,
  cluster_keywords text[] default '{}',
  category         text,
  source           text,
  read_at          timestamptz not null default now()
);

-- Disable RLS so the service-role key can read/write freely
alter table kv_store     disable row level security;
alter table digest_cache disable row level security;
alter table read_stories disable row level security;
