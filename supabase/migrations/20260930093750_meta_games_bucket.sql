-- Bucket PRIVÉ pour la collecte quotidienne FaB Insights (méta Talishar).
-- Pas de policy : seul le service_role (GitHub Action) y lit/écrit.
insert into storage.buckets (id, name, public, file_size_limit)
values ('meta-games', 'meta-games', false, 52428800)
on conflict (id) do nothing;
