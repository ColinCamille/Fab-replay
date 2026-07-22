# Prompt de démarrage — nouvelle conversation LLM

Copie-colle l'un des blocs ci-dessous au **début** d'une nouvelle conversation,
puis décris ta demande. Le but : que le LLM soit **opérationnel tout de suite**
sans re-explorer le repo (donc moins de tokens consommés).

---

## A. Avec Claude Code / claude.ai (sur le dépôt Fab-replay)

> `CLAUDE.md` (à la racine) est **chargé automatiquement**. Prompt minimal :

```
Lis d'abord CLAUDE.md à la racine (contexte, archi, schéma BDD, conventions,
pièges) et respecte-le : réponses et commits en FRANÇAIS, bump du cache-bust
?v=N dans index.html à chaque modif JS/CSS, `npm test` + `npm run check` verts,
un test par correctif, push sur main (rebase avant push).

Ma demande : <DÉCRIS LE BUG / LA FEATURE ICI, avec les symptômes précis>.

Si c'est un bug propre à une partie, je peux te fournir le ⬇ Log brut (.txt).
Va droit au but : diagnostique, corrige, teste, commit, push.
```

---

## B. Avec un LLM générique (ChatGPT, etc.)

> Le fichier n'est pas chargé tout seul → **colle le contenu de `CLAUDE.md`**
> juste après cette consigne, puis ta demande :

```
Tu reprends un projet perso. Voici son contexte complet (à lire en entier avant
de répondre). Réponds en FRANÇAIS, propose des diffs minimaux et ciblés, et
respecte les conventions décrites (cache-bust ?v=N, tests, pas de bundler).

<COLLE ICI LE CONTENU DE CLAUDE.md>

Ma demande : <DÉCRIS LE BUG / LA FEATURE ICI>.
```

---

## Astuces pour économiser des tokens

- **Une conversation = un sujet.** Ouvre une nouvelle conversation par bug/feature
  plutôt qu'un fil géant (le contexte accumulé coûte cher à chaque message).
- **Donne les symptômes précis + une capture** si c'est visuel. Pour un bug de
  partie, joins le **⬇ Log brut** (contient tous les blocs nécessaires).
- **Ne demande pas au LLM de tout re-lire** : CLAUDE.md suffit ; il n'ouvre les
  fichiers que si nécessaire.
- Quand une réponse est bonne, **stoppe** — pas besoin de « merci » qui relance un
  tour de contexte.
- Si le LLM part explorer longtemps, rappelle-lui : « CLAUDE.md décrit déjà ça ».
- Pense à **mettre à jour CLAUDE.md** quand l'archi/les conventions changent (une
  ligne suffit) — c'est ce qui garde les futures sessions courtes.
