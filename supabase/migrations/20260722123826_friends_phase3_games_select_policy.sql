-- ============================================================
-- Phase 3 — Un ami peut LIRE (seulement) toutes mes parties.
-- Policy permissive additionnelle : s'ajoute en OR à games_select_own.
-- Aucune policy d'écriture cross-user → parties d'un ami en lecture seule.
-- ============================================================
drop policy if exists games_select_friends on public.games;
create policy games_select_friends on public.games
  for select
  using (public.are_friends(auth.uid(), user_id));
