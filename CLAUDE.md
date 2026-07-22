# CLAUDE.md — Chain Replay (Fab-replay)

> Contexte pour un LLM qui reprend le projet. **Lis ce fichier en entier avant
> d'agir** : il évite de re-explorer le repo à chaque session. Réponds et
> commente le code **en français** (c'est la langue du projet et de l'UI).

## 1. Le projet en une phrase

Outil **personnel** d'analyse de parties de **Flesh and Blood** jouées sur
[talishar.net](https://talishar.net) : un userscript capte le log de partie, un
back Supabase les stocke (compte privé par joueur), et une web app rejoue chaque
partie **tour par tour** (vues **Déroulé** et **Table**) + agrège des centaines
de parties dans un **tableau de bord** (winrate, matchups, perf des cartes).
Feature « amis » : voir les stats/parties d'amis (lecture seule).

## 2. Architecture — 1 dépôt Git, 2 moitiés

Tout est dans **`ColinCamille/Fab-replay`** (branche `main`).

**A. Front (GitHub Pages)** — `https://colincamille.github.io/Fab-replay/`
Site statique, **vanilla JS** (aucun build/bundler, aucun framework), chargé par
`<script src>` dans `index.html`. Persistance locale **IndexedDB**.

**B. Back (Supabase)** — auth par lien magique (email, sans mot de passe),
Postgres + RLS, Edge Functions (Deno/TS). Le dossier `supabase/` versionne les
migrations et les fonctions.

**Le grabber** est un **userscript Tampermonkey/Violentmonkey**
(`talishar-log-grabber.user.js`) qui tourne sur talishar.net (pas dans l'app).

### Dépôts Talishar (RÉFÉRENCE, pas les nôtres)
Pour comprendre le format des logs, on lit la source **open-source** de Talishar :
- `github.com/Talishar/Talishar` — **serveur de jeu** (PHP). C'est lui qui écrit
  le log (`WriteLog`, `CardLink`, dossiers `CardDictionaries/`).
- `github.com/Talishar/Talishar-FE` — **front React** (TypeScript). Il stocke le
  log dans le store Redux (`state.game`), que le grabber lit via les fibres React.

## 3. Flux de données

```
Talishar (partie)                    ← le grabber lit state.game (Redux) via fibres React
  └─ grabber (userscript)            → construit un LOG TEXTE (blocs ===…===) + snapshots par tour
       ├─ POST Edge Function `ingest` (avec device_token)   → upsert dans `games`
       └─ (ou) copie/téléchargement manuel du .txt
Supabase `games` (raw = log brut)    ← source de vérité
  └─ app (index.html)                → fetchGames() → IndexedDB → parse → dashboard/replay
```

- Le **`.txt` brut (`raw`) est la source de vérité.** `talishar-parser.js` est une
  transformation **rejouable** : on peut re-parser tout l'historique quand le
  parseur s'améliore. Ne jamais « corriger » des données dérivées à la main.

## 4. Fichiers clés

| Fichier | Rôle |
|---|---|
| `index.html` | App entière : routeur (dashboard/replay), UI compte+amis, import, cache-bust `?v=N`. |
| `talishar-parser.js` | **Pur, testable en Node.** Log brut → *game record* normalisé (`turns[].events`, `chain`, `heroForm`, `endStats`, `health`, `rawChatLog`…). `classifyLine()` = 1 ligne → événement. |
| `js/boardreplay.js` | Vue **Table** (plateau rejoué). `buildTimeline(GAME)` (pur, testable) → étapes ; `fitBoard()` (mise à l'échelle) ; transformations de héros. |
| `js/replay.js` | Vue **Déroulé** (fil tour par tour, passes d'armes). |
| `js/dashboard.js` | **Tableau de bord** (agrégations winrate/matchups/cartes). `aggregate()` pur. |
| `js/images.js` | Résolution d'images de cartes via **goagain.dev** (`resolveCardMeta(name, pitch)`, `resolveHeroCardImage(name)`). Cache localStorage. |
| `js/cloud.js` | Couche **Supabase** (auth, `fetchGames`, amis : profils/amitiés/RPC). |
| `js/db.js`, `js/sync.js` | IndexedDB ; synchro (héritage GitHub, en voie d'extinction). |
| `talishar-log-grabber.user.js` | Le **grabber** (userscript). Versionné (`@version`), auto-update via `@updateURL`/`@downloadURL` (raw GitHub). |
| `supabase/migrations/*.sql` | Schéma + RLS (voir §5). |
| `supabase/functions/{ingest,delete-account}/` | Edge Functions Deno. `ingest` = point d'entrée du grabber (auth par device_token, service_role). |
| `tests/run.js` | Suite de tests Node (assertions maison). `npm test`. |

## 5. Schéma BDD (Supabase / Postgres)

RLS activée partout. **Un utilisateur ne voit que ses données** (sauf lecture
des parties d'un **ami accepté**).

- **`games`** — une partie par (user_id, game_id).
  Colonnes : `user_id`, `game_id` (numérique, texte), `raw` (log brut — **source
  de vérité**), `my_hero`, `opp_hero`, `format`, `captured_at`, `meta`
  (`{tags, favorite, metaUpdatedAt}`).
  RLS : `select/insert/update/delete_own` (own = `auth.uid() = user_id`) **+**
  `games_select_friends` (permissive, en OR : un ami accepté peut **lire**).
  ⚠️ Comme la lecture amis s'ajoute en OR, **`fetchGames()` filtre EXPLICITEMENT
  `.eq('user_id', currentUser.id)`** — sinon les parties d'amis se mélangeraient
  aux tiennes.
- **`device_tokens`** — appairage du grabber : `token`, `user_id`, `label`,
  `last_used_at`. Le grabber envoie le token à `ingest` ; la fonction (service_role)
  résout `user_id` puis upsert dans `games`.
- **`profiles`** — `id` (=auth user), `display_name`, `friend_code` (8 hex,
  auto-généré à l'inscription, unique). RLS : soi uniquement (codes non
  énumérables). RPC : `get_my_profile`, `set_display_name`.
- **`friendships`** — `requester`, `addressee`, `status`
  (`pending`/`accepted`/`declined`). RPC `SECURITY DEFINER` :
  `send_friend_request(code)`, `respond_friend_request`, `remove_friend`,
  `list_friends`, `list_pending_requests`, helper `are_friends(a,b)` (utilisé par
  la policy `games_select_friends`).

> Les tables de base `games`/`device_tokens` ont été créées avant le suivi des
> migrations (setup Supabase initial) ; les migrations tracées ne couvrent que
> `my_hero` et la feature amis. Appliquer les migrations : `supabase db push`.

## 6. Conventions (IMPORTANTES)

- **Langue** : UI, commentaires et messages de commit **en français**.
- **Cache-bust** : à CHAQUE modif d'un `.js`/`.css`, **bumper le `?v=N`** de TOUS
  les `<script>`/`<link>` dans `index.html` (`sed -i 's/?v=157/?v=158/g' index.html`).
  Sans ça les navigateurs (surtout mobiles) gardent l'ancien cache. `N` actuel : voir `index.html`.
- **Tests** : `npm test` (doit rester 100% vert) et `npm run check` (syntaxe).
  Ajouter un test pour tout comportement corrigé. Le parseur, `buildTimeline` et
  `aggregate` sont **purs** → testables en Node sans navigateur.
- **Pas de build/bundler.** (Un ancien `build/standalone.html` a été **retiré** —
  ne pas le recréer.)
- **Grabber** : bumper `@version` (et le `VERSION` interne) à chaque modif pour
  déclencher l'auto-update chez les utilisateurs.
- **Git** : petits commits ciblés, message FR explicite. Pousser sur `main`
  (déploie GitHub Pages). Une **2ᵉ session Claude** travaille parfois en parallèle
  → **rebaser** avant de pousser (`git fetch origin main && git rebase origin/main`)
  et résoudre les conflits de `?v=` en gardant la version la plus haute.
- **Théâtre d'erreur** : ne jamais afficher une mauvaise donnée « au cas où » —
  mieux vaut pas d'image/pas de valeur qu'une fausse (cf. résolution d'images).
- **Scratchpad** : fichiers temporaires (scripts de test, screenshots Playwright,
  clones Talishar…) → dans le **scratchpad de session**, **JAMAIS** committés
  dans le repo (un dossier `undefined/` de screenshots s'y était glissé une fois).
- **Au démarrage d'une session** : `git log --oneline -20` pour voir le travail
  récent (une 2ᵉ session Claude avance parfois en parallèle sur `main`).

## 7. Savoir Talishar (durement acquis — ne pas re-deviner)

- Le **`chatLog`** du store React est un **tableau de chaînes HTML**. Chaque carte
  y est un `<span onmouseover="ShowDetail(event,'.../<cardId>.webp')">Nom</span>`.
  Le `<cardId>` porte la **couleur/impression** (`_red`=pitch 1, `_yellow`=2,
  `_blue`=3 ; pas de suffixe = mono-impression : arme/équipement/héros).
  → `talishar-parser.js` en extrait la couleur **par occurrence** (bloc
  `RAW CHATLOG`) et `images.js` choisit l'impression par **pitch** chez goagain.
- **`[[TURN_START:tour:joueur]]`** = marqueur de début de tour (le grabber le
  traduit en « `<héros>'s turn N has begun.` »). « Player 1/2 » → nom du héros via
  `gameInfo.playerID` + `playerOne/Two.Hero`.
- **Bloc `COMBAT CHAIN`** : attaque/défense **effectives** (buffs compris), lues
  dans `state.game.activeChainLink` (`attackingCard`, `totalPower`, `totalDefense`,
  mots-clés goAgain/dominate/…). Fait **autorité** sur l'attaquant.
- **Bloc `HERO FORMS`** : forme du héros **par tour** (les deux camps). Sert à
  détecter les **transformations** (Arakni, Levia…) **indépendamment du log** :
  certains héros loggent « X becomes Y » (Arakni, set Hunter), d'autres **non**
  (Levia → Blasmophet, set Dusk Till Dawn) — le snapshot par tour couvre les deux.
- **`END GAME STATS`** (JSON) : stats officielles Talishar de fin de partie
  (`byPlayer.{1,2}.cardResults` avec `cardId` coloré + `pitchValue`, résultat,
  tours…). Dispo seulement si la partie est **terminée** (écran « Game Summary »).
- **API goagain** (`api.goagain.dev/v1/cards?name=…`) — forme de la réponse :
  `data[]` avec **un objet par impression/couleur** d'un même nom (champs `color`,
  `pitch` en **chaîne** `"1"/"2"/"3"`, et images dans **`printings[].image_url`**).
  D'où : pour la couleur d'une carte, on filtre par `pitch` ; pour un héros
  multi-formes, plusieurs objets (« Arakni », « Arakni, Funnel Web »…, certains de
  type `Demi-Hero`). C'est notre SEULE source d'images. **Bloquée en sandbox**
  (cf. §8) → faire coller la réponse par l'utilisateur si besoin de vérifier.

## 8. Pièges connus

- **Miroir** (mêmes héros) : « Player 1/2 » deviennent le même nom → désambiguïser
  par **pseudo** puis n° de joueur. Le **vainqueur** se déduit de `endStats`
  (par n° de joueur), PAS de la ligne « won! 🎉 » (ambiguë en miroir).
- **`fitBoard`** (Table) : plein écran = mise à l'échelle sur la **hauteur**
  (tient sans scroll) ; fenêtré = remplit la **largeur** (scroll vertical léger).
  Verrouiller `wrap.style.width` avant la marge négative (sinon débordement).
- **Images héros multi-formes** : goagain renvoie plusieurs formes (« Arakni »,
  « Arakni, Funnel Web »… certaines de type **`Demi-Hero`**). Choisir par **mots
  distinctifs partagés**, jamais le préfixe (sinon on retombe sur la forme de base).
- **Réseau** : en environnement sandbox Claude, **goagain.dev et le CDN Talishar
  sont INJOIGNABLES** (curl 000/403). GitHub (raw + clone) marche. Pour vérifier
  une résolution d'image/couleur : demander à l'utilisateur de coller la réponse
  d'une URL goagain, ou tester la logique hors-ligne.
- **AskUserQuestion** est parfois instable → si échec, poser la question en texte.

## 9. Vérifier ses changements

- `npm test` + `npm run check` (obligatoire, vert).
- Rendus (Table/plateau, menus) : **Playwright + Chromium** est dispo
  (`/opt/pw-browsers/chromium-*/chrome-linux/chrome`,
  `NODE_PATH=<repo>/node_modules`). Monter un composant **isolé** dans une page de
  test (le boot complet de `index.html` **bloque** sans réseau). `buildTimeline`
  se teste directement en Node (`global.TalisharParser = require(...)`).

## 10. Pour communiquer avec le mainteneur (Camille)

- App perso, budget LLM limité → **aller droit au but**, corriger + tester +
  commit + push, pas de blabla. Français.
- Pour un bug spécifique à une partie, demander le **⬇ Log brut** (.txt) : il
  contient tous les blocs (`RAW CHATLOG`, `COMBAT CHAIN`, `HERO FORMS`, `END GAME
  STATS`) nécessaires pour reproduire.

## 11. Naviguer la source Talishar (on y va souvent)

Pour comprendre le format des logs, le comportement d'une carte, les mots-clés,
les transformations, etc., on lit la source **open-source** de Talishar. Le
réseau **GitHub marche** dans le sandbox → on peut cloner en shallow (mettre le
clone dans le scratchpad de session, PAS dans le repo Fab-replay) :

```
git clone --depth 1 https://github.com/Talishar/Talishar.git      # serveur (PHP)
git clone --depth 1 https://github.com/Talishar/Talishar-FE.git   # front (React/TS)
```

### Serveur `Talishar/Talishar` (PHP) — écrit le log
- `WriteLog.php` — `WriteLog()` écrit chaque ligne ; **`JSONLog()`** assemble le
  `chatLog` renvoyé au front (lignes jointes par `<br>`).
- `Libraries/UILibraries.php` — **`CardLink($cardNumber)`** : c'est ici que la
  **couleur** est encodée dans le log (pitch → couleur ; identifiant de carte
  coloré). Point d'entrée pour comprendre le format d'une carte dans le log.
- `BuildGameState.php` — construit l'état envoyé au front (`$isReactFE = true`,
  `$response->chatLog = JSONLog(...)`).
- `CardDictionaries/<Set>/…` — **logique par carte, par set**. Ex. décisifs pour
  les transformations de héros :
  - `Hunted/HNTShared.php` → `ChaosTransform()` (Arakni) **loggue** `X becomes Y`.
  - `DuskTillDawn/DTDShared.php` → `ResolveTransformHero()` (Levia) **ne loggue
    rien** (change juste le héros dans l'état) → d'où la détection par `HERO FORMS`.
- `GameLogic.php`, `CardLogic.php`, `CoreLogic.php`, `CombatChain.php` — moteur.

### Front `Talishar/Talishar-FE` (React/TS) — stocke/affiche le log
- `src/app/ParseGameState.ts` — ingère la réponse serveur ; garde le `chatLog`
  en **tableau de chaînes brutes** (ne résout PAS les marqueurs de carte).
- `src/routes/game/components/elements/chatBox/GameLogMessages.tsx` —
  `plainText()` : c'est **au rendu seulement** que les `<span>`/marqueurs de carte
  sont transformés en simple **nom**.
- `src/features/GameState.ts` — types (`chatLog?: string[]`, forme de `state.game`).
- `src/mocks/api/GetNextTurn3.ts` — un **vrai échantillon** de `state.game`
  (précieux pour voir le format réel d'un `chatLog` sans lancer de partie).
- `src/utils/multilanguage/multilanguage.ts` — `getCollectionCardImagePath()`
  (URL d'image par n° de collection).

> Rappel réseau : cloner Talishar via GitHub **marche** ; interroger **goagain.dev**
> ou le **CDN d'images** Talishar **ne marche pas** dans le sandbox (cf. §8).

## 12. Garde-fous « Talishar a changé de format » (existant — ne pas réinventer)

Le format des logs Talishar peut changer sans prévenir. Deux filets de sécurité
sont **déjà en place** — les maintenir/étendre plutôt que refaire :

- **Parser → `record.health`** : invariants vérifiés au parsing (ex. beaucoup
  d'actions mais **aucun tour** découpé, marqueur de tour non reconnu, joueur de
  tour inattendu, duplication du journal, joueurs non résolus). `health.ok=false`
  + `health.issues[]` si quelque chose cloche → l'app peut afficher un bandeau.
- **Grabber → `runCanary()`** : à la **capture**, vérifie les hypothèses sur
  `state.game` (ex. `gameInfo.playerID` présent, marqueur `[[TURN_START]]` présent
  quand il y a ≥2 fins de tour). Si cassé, message d'alerte dans le widget +
  le **chatLog brut est conservé** dans l'export pour déboguer.
- Débogage terrain : bouton **🔍 Diag** du grabber = dump de `state.game`
  (clés, `chatLog` verbatim des actions carte, objets carte complets,
  `activeChainLink`…) → c'est ce qu'il faut demander à l'utilisateur quand un
  format semble avoir changé.
