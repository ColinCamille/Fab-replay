-- player_links : correspondance compte Fab-replay ↔ pseudos Talishar ↔ hash FaB Insights.
-- (Table créée hors migrations ; on la décrit ici pour l'historique.)
-- Un joueur SANS compte Fab-replay doit pouvoir y figurer (pseudo + hash seuls) :
-- user_id devient facultatif (toujours unique), la clé primaire passe sur un id.
create table if not exists public.player_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  talishar_names text[] not null default '{}',
  fabinsights_hash text
);
alter table public.player_links enable row level security;

alter table public.player_links add column if not exists id uuid not null default gen_random_uuid();
alter table public.player_links drop constraint if exists player_links_pkey;
alter table public.player_links add primary key (id);
alter table public.player_links alter column user_id drop not null;
alter table public.player_links add constraint player_links_user_id_key unique (user_id);
