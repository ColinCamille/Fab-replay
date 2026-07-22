-- La colonne `me` était ambiguë (pseudo / héros / artefact) et n'est plus
-- écrite (ingest v3) ni lue par l'app (remplacée par my_hero). On la supprime.
alter table public.games drop column if exists me;
