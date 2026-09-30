-- Correspondance compte FabReplay → pseudo(s) Talishar → pseudo haché FaB Insights.
-- Usage admin uniquement : RLS activée sans aucune policy (inaccessible depuis l'app).
-- Les données ne sont PAS versionnées (le dépôt est public).
create table public.player_links (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  talishar_names   text[] not null default '{}',
  fabinsights_hash text
);
alter table public.player_links enable row level security;
