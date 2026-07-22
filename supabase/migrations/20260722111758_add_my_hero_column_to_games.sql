-- Colonne « mon héros » symétrique de opp_hero (format « Nom (id) »).
-- Remplace l'usage bancal de la colonne `me` (mélange pseudo/héros).
alter table public.games add column if not exists my_hero text;

-- Backfill depuis le log brut (champ my_hero: toujours présent et fiable).
update public.games
set my_hero = nullif(trim((regexp_match(raw, 'my_hero:\s*([^\n\r]*)'))[1]), '')
where my_hero is null;

-- Nettoie d'éventuels placeholders du grabber.
update public.games
set my_hero = null
where my_hero in ('(non capté)', '(vide)', '(non capturé)');
