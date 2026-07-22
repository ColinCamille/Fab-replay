# Démarrer une nouvelle conversation Claude — économiser des tokens

## Tu n'as RIEN à copier-coller

`CLAUDE.md` (à la racine) est **chargé automatiquement** par Claude quand la
session travaille sur ce dépôt. Ouvre une nouvelle conversation et **décris
directement ta demande** — Claude a déjà tout le contexte (archi, schéma BDD,
conventions, savoir Talishar, pièges).

Exemple de demande :

```
Bug dans la vue Table : <symptômes précis>. (capture jointe si visuel,
ou ⬇ Log brut .txt si c'est propre à une partie)
```

## Astuces pour économiser des tokens

- **Une conversation = un sujet.** Ouvre une nouvelle conversation par
  bug/feature plutôt qu'un fil géant : le contexte accumulé est renvoyé à chaque
  message, donc un long fil coûte de plus en plus cher.
- **Donne les symptômes précis + une capture** si c'est visuel. Pour un bug de
  partie, joins le **⬇ Log brut** (il contient tous les blocs nécessaires).
- Quand une réponse te convient, **stoppe** — pas besoin de « merci » qui
  relance un tour de contexte.
- Si Claude part explorer longtemps, rappelle-lui : « c'est déjà dans CLAUDE.md ».
- **Garde CLAUDE.md à jour** quand l'archi ou les conventions changent (une ligne
  suffit) : c'est LUI qui garde les futures sessions courtes.
