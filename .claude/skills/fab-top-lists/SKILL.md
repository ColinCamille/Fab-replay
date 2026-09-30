---
name: fab-top-lists
description: Meilleurs joueurs d'un héros Flesh and Blood sur Talishar (données FaB Insights) avec leurs listes de 60, leur réserve reconstituée, leur side contre un adversaire donné, et comparaison avec la liste de l'utilisateur. À utiliser quand on demande « les meilleures listes de <héros> », « les meilleurs joueurs <héros> », « compare ma liste », « que side le top contre <héros> ».
---

# Meilleures listes d'un héros (FaB Insights)

Script : `.claude/skills/fab-top-lists/top_lists.py` (Python 3, stdlib seulement).
Sortie : Markdown sur stdout (progression sur stderr) → à restituer tel quel ou résumé.

## Prérequis

- `FABINSIGHTS_API_KEY` dans l'environnement (clé FaB Insights, obtenue via
  metafy.gg/@fabinsights). Si absente : le dire à l'utilisateur, ne rien deviner.
- Réseau : `fab-insights.azurewebsites.net` + `fabinsights.blob.core.windows.net`.

## Utilisation

```bash
python3 .claude/skills/fab-top-lists/top_lists.py --hero fai_rising_rebellion \
  [--vs jarl_vetreidi] [--game 2554674] [--compare ma_liste.txt] \
  [--days 21] [--formats 0,1] [--top 5] [--min-games 15]
```

- `--hero` / `--vs` : identifiants Talishar (snake_case, ex. `jarl_vetreidi`,
  `levia_shadowborn_abomination`). Les héros transformés apparaissent sous leur
  forme finale (ex. `blasmophet_levia_consumed`).
- `--vs` : ajoute le score de chaque top joueur contre ce héros, sa liste la plus
  récente contre lui (colonnes « X vs ») et le détail IN/OUT de chaque partie.
- `--game <game_id>` : une partie de l'utilisateur (ex. prise dans la table
  Supabase `games`) → sa liste = le deck joué dans cette partie, et on retrouve
  son pseudo haché (ligne « Toi »).
- `--compare <fichier>` : liste texte, une carte par ligne : `3 Ignite red`,
  `3x Art of the Phoenix: War (red)`, `2 sink_below_red` (couleur en anglais ou
  en français). Pour une liste Fabrary : la lire avec WebFetch (deck **et**
  inventaire/réserve), écrire le fichier dans le scratchpad, puis `--compare`.
- Formats : `0` CC, `1` CC compétitif, `2` Blitz, `3` Blitz comp., `8/9` LL,
  `14/15` Silver Age… (table complète dans le script).

## Performance / cache

L'API ne filtre pas par héros : chaque jour × format = un CSV de 50-150 Mo à
parser. 21 jours × 2 formats ≈ 1 à 2 min au premier lancement (4 téléchargements
en parallèle). Les parties du héros sont mises en cache (JSONL compact) dans
`$FAB_INSIGHTS_CACHE` (défaut : `/tmp/fab-insights-cache`) → relances instantanées.
**Mettre le cache dans le scratchpad de session**, jamais dans le repo.
Le lancer en arrière-plan si > 30 jours, et ne pas attendre avec une boucle
`pgrep -f <script>` (elle se détecte elle-même).

## Interpréter (à rappeler à l'utilisateur)

- Seul le **deck de 60 joué** est dans les données, pas la liste de 80 : la
  « réserve » est reconstituée à partir de toutes les parties du joueur.
- Pseudos **hachés** (anonymes) → joueurs nommés A, B, C…
- Classement = winrate lissé (20 parties fictives au winrate moyen du héros),
  pour ne pas surclasser un 5/5.
- Les stats par carte sur quelques dizaines de parties sont fragiles ; préférer
  ce que font **les meilleurs joueurs** à des corrélations globales (un side
  défensif peut avoir un winrate global bas mais être le choix du top).
