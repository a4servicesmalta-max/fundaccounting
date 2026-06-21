-- THCP Autopilot — Supabase setup
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
--
-- It creates:
--   1. app_kv   — a tiny key/value table that holds the whole "books" JSON blob
--                 under the single key 'books'.
--   2. documents — a PRIVATE Storage bucket for the original uploaded files.
--
-- The app connects with the service_role key, which bypasses Row Level Security,
-- so no extra RLS policies are required for the server to work.

-- 1. Books blob table -------------------------------------------------------
create table if not exists public.app_kv (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

-- 2. Private bucket for uploaded document originals --------------------------
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;
