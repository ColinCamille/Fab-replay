-- ============================================================
-- Phase 1 — Profils + code d'ami
-- ============================================================
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  friend_code  text not null unique,
  created_at   timestamptz not null default now()
);

-- Génère un code d'ami unique (8 hex majuscules), avec anti-collision.
create or replace function public.gen_friend_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare code text;
begin
  loop
    code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from public.profiles where friend_code = code);
  end loop;
  return code;
end $$;

-- Création auto d'un profil à l'inscription (déclencheur sur auth.users).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, friend_code)
  values (new.id, public.gen_friend_code())
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill : profils pour les utilisateurs déjà existants.
insert into public.profiles (id, friend_code)
select u.id, public.gen_friend_code()
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

-- RLS : chacun ne voit/modifie QUE sa propre ligne (codes non énumérables).
alter table public.profiles enable row level security;
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- RPC client : lire mon profil, changer mon pseudo.
create or replace function public.get_my_profile()
returns table (id uuid, display_name text, friend_code text)
language sql stable security definer set search_path = public
as $$ select id, display_name, friend_code from public.profiles where id = auth.uid(); $$;

create or replace function public.set_display_name(p_name text)
returns void
language sql security definer set search_path = public
as $$ update public.profiles set display_name = left(nullif(trim(p_name), ''), 40) where id = auth.uid(); $$;

-- Fonctions internes : non exposées aux clients.
revoke all on function public.gen_friend_code() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
-- RPC client : réservées aux utilisateurs connectés.
revoke all on function public.get_my_profile() from public, anon;
grant execute on function public.get_my_profile() to authenticated;
revoke all on function public.set_display_name(text) from public, anon;
grant execute on function public.set_display_name(text) to authenticated;
