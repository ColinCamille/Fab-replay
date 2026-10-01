-- Jetons de LECTURE SEULE des parties (`games`) d'UN joueur, pour les sessions
-- Claude (skill fab-game-review) : ils ne donnent accès qu'à l'Edge Function
-- game-read (lecture des parties du user_id associé), jamais en écriture.
-- On ne stocke que le SHA-256 du jeton. RLS sans policy : service_role seul.
create table if not exists public.game_read_tokens (
  token_hash   text primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  label        text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.game_read_tokens enable row level security;
