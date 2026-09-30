-- Jetons de LECTURE SEULE du bucket meta-games (collecte FaB Insights), pour
-- les sessions Claude (skill fab-top-lists) : ils ne donnent accès qu'à
-- l'Edge Function meta-read, jamais à la base ni aux autres buckets.
-- On ne stocke que le SHA-256 du jeton. RLS sans policy : service_role seul.
create table if not exists public.meta_read_tokens (
  token_hash   text primary key,
  label        text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.meta_read_tokens enable row level security;
