-- ============================================================
-- Phase 2 — Amitiés (demandes + acceptation)
-- ============================================================
create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester    uuid not null references auth.users(id) on delete cascade,
  addressee    uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  constraint friendships_not_self check (requester <> addressee),
  constraint friendships_unique_pair unique (requester, addressee)
);
create index if not exists friendships_addressee_idx on public.friendships (addressee);
create index if not exists friendships_requester_idx on public.friendships (requester);

-- Deux utilisateurs sont-ils amis (accepté, dans un sens ou l'autre) ?
-- SECURITY DEFINER + STABLE : appelable dans une policy RLS sans récursion.
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester = a and f.addressee = b)
        or (f.requester = b and f.addressee = a))
  );
$$;

-- RLS : un participant voit ses lignes ; les écritures passent par les RPC.
alter table public.friendships enable row level security;
drop policy if exists friendships_select_participant on public.friendships;
create policy friendships_select_participant on public.friendships
  for select using (auth.uid() = requester or auth.uid() = addressee);

-- Envoyer une demande via un code d'ami. Renvoie un statut lisible.
create or replace function public.send_friend_request(p_code text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  target uuid;
  ex record;
begin
  if me is null then raise exception 'not authenticated'; end if;
  select id into target from public.profiles where friend_code = upper(trim(p_code));
  if target is null then return 'not_found'; end if;
  if target = me then return 'self'; end if;

  select * into ex from public.friendships
   where (requester = me and addressee = target)
      or (requester = target and addressee = me)
   limit 1;

  if found then
    if ex.status = 'accepted' then return 'already_friends'; end if;
    if ex.status = 'pending' then
      -- l'autre m'avait déjà demandé → on scelle l'amitié
      if ex.requester = target then
        update public.friendships set status = 'accepted', responded_at = now() where id = ex.id;
        return 'accepted';
      end if;
      return 'already_pending';
    end if;
    -- déclinée précédemment → on ré-ouvre de mon côté
    update public.friendships
       set requester = me, addressee = target, status = 'pending', created_at = now(), responded_at = null
     where id = ex.id;
    return 'pending';
  end if;

  insert into public.friendships (requester, addressee) values (me, target);
  return 'pending';
end $$;

-- Répondre à une demande reçue (seul le destinataire).
create or replace function public.respond_friend_request(p_id uuid, p_accept boolean)
returns text
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid(); r record;
begin
  if me is null then raise exception 'not authenticated'; end if;
  select * into r from public.friendships where id = p_id;
  if not found then return 'not_found'; end if;
  if r.addressee <> me then raise exception 'forbidden'; end if;
  if r.status <> 'pending' then return 'not_pending'; end if;
  update public.friendships
     set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now()
   where id = p_id;
  return case when p_accept then 'accepted' else 'declined' end;
end $$;

-- Retirer un ami (ou annuler une demande) — l'un ou l'autre participant.
create or replace function public.remove_friend(p_friend uuid)
returns void
language sql security definer set search_path = public
as $$
  delete from public.friendships
  where (requester = auth.uid() and addressee = p_friend)
     or (requester = p_friend and addressee = auth.uid());
$$;

-- Listes pour l'UI.
create or replace function public.list_friends()
returns table (friend_id uuid, display_name text, since timestamptz)
language sql stable security definer set search_path = public
as $$
  select
    case when f.requester = auth.uid() then f.addressee else f.requester end,
    p.display_name,
    f.responded_at
  from public.friendships f
  join public.profiles p
    on p.id = case when f.requester = auth.uid() then f.addressee else f.requester end
  where f.status = 'accepted'
    and (f.requester = auth.uid() or f.addressee = auth.uid());
$$;

create or replace function public.list_pending_requests()
returns table (request_id uuid, requester_id uuid, display_name text, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select f.id, f.requester, p.display_name, f.created_at
  from public.friendships f
  join public.profiles p on p.id = f.requester
  where f.addressee = auth.uid() and f.status = 'pending';
$$;

-- Grants : are_friends utilisée par la RLS (authenticated doit pouvoir l'exécuter) ;
-- les RPC client réservées aux connectés.
revoke all on function public.are_friends(uuid, uuid) from public, anon;
grant execute on function public.are_friends(uuid, uuid) to authenticated;
revoke all on function public.send_friend_request(text) from public, anon;
grant execute on function public.send_friend_request(text) to authenticated;
revoke all on function public.respond_friend_request(uuid, boolean) from public, anon;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
revoke all on function public.remove_friend(uuid) from public, anon;
grant execute on function public.remove_friend(uuid) to authenticated;
revoke all on function public.list_friends() from public, anon;
grant execute on function public.list_friends() to authenticated;
revoke all on function public.list_pending_requests() from public, anon;
grant execute on function public.list_pending_requests() to authenticated;
