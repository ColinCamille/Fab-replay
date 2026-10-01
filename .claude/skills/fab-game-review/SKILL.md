---
name: fab-game-review
description: Analyse tour par tour d'une partie Flesh and Blood (Talishar) de Camille pour l'aider à progresser — valeur par cycle défense → attaque, meilleure ligne vs ligne jouée, écarts. Utiliser quand Camille demande de revoir / analyser / coacher une partie (« regarde ma dernière game », un game_id, un log brut .txt collé, « Boltyn contre Marlynn »…).
---

# Revue de partie FaB — valeur par cycle

Réponds en **français**, concis, sans préambule. Camille veut des **maths**, pas
des impressions : chaque recommandation est chiffrée.

## 1. Récupérer la partie

- **Log brut collé / .txt fourni** → l'utiliser tel quel.
- **Sinon, Edge Function `game-read`** (lecture seule, sans confirmation) — jeton
  dans la variable d'environnement `GAME_READ_TOKEN` :
  ```
  F=https://alzldgpopmhxnlxafsrl.supabase.co/functions/v1/game-read
  curl -s -H "x-read-token: $GAME_READ_TOKEN" "$F?hero=boltyn&opp=marlynn&limit=5"   # liste
  curl -s -H "x-read-token: $GAME_READ_TOKEN" "$F?game_id=2577664" -o <scratchpad>/game.txt
  ```
  Puis lire `game.txt` par blocs (`grep -n '^=== '` pour les repérer) : (1) le
  **journal** (début → HAND SNAPSHOTS), (2) les **snapshots** (→ COMBAT CHAIN),
  (3) **COMBAT CHAIN**. Le `RAW CHATLOG` est rarement utile. Filtres `hero`/`opp`
  larges (« Marlynn », pas « Marilyn »).
- Repli si `GAME_READ_TOKEN` absent : `execute_sql` sur `games` (demande confirmation).

## 2. Données utiles dans le log (grabber)

- `HAND SNAPSHOTS` / `HAND TIMELINE` : **ta main** au début de chaque tour (les deux
  camps) et à chaque changement → c'est la base de toute ligne alternative.
- `ARSENAL SNAPSHOTS`, `OPP ARSENAL COUNT`, `FIELD SNAPSHOTS/TIMELINE` (tokens, auras,
  Gold adverses), `SOUL SNAPSHOTS`, `EQUIP COUNTERS` (durabilité : `def=-1`…),
  `LIFE SNAPSHOTS` (PV + taille de deck), `META` (équipement de départ).
- `COMBAT CHAIN` : puissance/défense **effectives** et mots-clés (overpower, go again,
  wager) de chaque maillon — fait autorité.
- On ne voit **jamais** la main adverse : raisonner sur ce qu'elle a montré.

## 3. Textes de cartes (ne jamais deviner)

1. `curl -s -G https://api.goagain.dev/v1/cards --data-urlencode "name=<Nom>"` →
   `functional_text_plain`, `cost`, `power`, `defense`, `pitch` (un objet par couleur).
2. Absente (set très récent) → JSON `the-fab-cube/flesh-and-blood-cards`
   (`json/english/card.json` sur raw.githubusercontent, ~23 Mo, dans le scratchpad).
3. Toujours absente → image Talishar
   `https://images.talishar.net/public/cardimages/english/<cardId>.webp`
   (`<cardId>` = id coloré du log, ex. `bravery_of_the_blade_red`), téléchargée dans le
   **scratchpad** et **lue avec l'outil Read** (le texte est sur l'image).
- Récupérer aussi les **tokens** (Gold, Courage, Quicken, Ponder, Frailty…).
- Si un texte reste inconnu, le **dire** et préciser ce qui est déduit du log.

## 4. Méthode (règles de Camille — obligatoires)

**Valeur d'un cycle défense → attaque (additive)** :
- + dégâts **prévenus** en défense
- + dégâts **infligés** au tour d'attaque suivant (potentiel max ET réaliste après
  blocs adverses)
- + **1** par carte mise en **soul** (−1 par carte de soul dépensée : Beacon, go again
  de Boltyn, Celestial…)
- − **2** par **Gold** donné à l'adversaire (Go Fish, Gold-Baited Hook, wager…) ;
  vérifier quels Gold un blocage refuse **vraiment** (un on-hit qui se déclenche
  quand même avec moins de dégâts ne se refuse pas)
- + PV regagnés
- Comparer aussi la **valeur par carte dépensée**.

**Principes** :
- Ne jamais juger un blocage isolé : toujours le cycle complet (défense + tour suivant).
- **Équipement = ressource pour empêcher un on-hit.** Si le hit est inévitable
  (défense max + prévention < puissance), ne pas user l'armure pour grappiller des
  PV : la garder pour un tour où elle bloque complètement. Temper / Blade Break =
  coût futur.
- Overpower : **1 seule carte action** en blocage ; équipement et réactions de
  défense restent autorisés.
- Regarder ce que l'**on-hit** vole (Go Fish rouge/jaune/attaque, arsenal…) : charger
  en priorité la couleur ciblée pour vider la cible.
- Pour Boltyn : une charge **jaune** débloque Duty Bound Blitz, le +1 de Beaming, la
  pioche de Helm, le Quicken de Warpath, le Courage de Spirit of War → vérifier à
  chaque charge ce que la jaune débloque.
- Vérifier la **létalité** : si toutes les lignes perdent, le dire et privilégier la
  ligne à plus forte valeur / seule chance de victoire.

## 5. Déroulé de l'analyse

Pour **chaque tour** (les deux joueurs), à partir des snapshots :
1. État : PV des deux camps, **ta main + arsenal**, équipement restant (durabilité),
   soul, tokens, menace adverse (puissance, overpower, on-hit).
2. Lister les **lignes possibles** (blocages, charges, séquences d'attaque, pitch),
   en vérifiant les coûts, go again, conditions (« si tu as chargé ce tour »…).
3. Chiffrer chaque ligne avec le barème (sur le cycle défense → attaque).
4. Comparer à la ligne **jouée** (reconstituée depuis le journal ; attention aux
   `undo`).

## 6. Format de sortie

1. Une phrase de verdict (écart total, où la partie s'est perdue).
2. **Tableau** : `Tour | Ta main (+ars.) | Ta ligne | Val. | Meilleure ligne | Val. | Écart`
   (couleurs R/J/B ; ✓ quand c'est optimal ou forcé).
3. Les 2–4 erreurs principales, de la plus coûteuse à la moins coûteuse, chacune
   avec le calcul et la **leçon réutilisable**.
4. Hypothèses / textes non trouvés.
5. Proposer de creuser un tour en mode exercice (« voici ta main, que joues-tu ? »).

Camille peut contester un calcul ou une règle : si c'est juste, **corriger** et
ajouter la règle à la §4 de ce skill (et au §13 de `CLAUDE.md`).
