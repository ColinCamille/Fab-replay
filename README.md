# FaB Analyzer — Chain Replay

Outil **personnel** d'analyse de parties de **Flesh and Blood** jouées sur
[talishar.net](https://talishar.net). Il rejoue une partie tour par tour et
agrège des **centaines** de parties dans un tableau de bord (winrate, matchups,
performance des cartes…).

Hébergé sur **GitHub Pages** → l'origine stable rend la persistance
**IndexedDB** fiable (y compris sur mobile), contrairement à un fichier `file://`.

## Composants

| Fichier | Rôle |
|---|---|
| `index.html` | Point d'entrée : routeur **2 modes** (tableau de bord / replay). |
| `talishar-parser.js` | **Parser** — source de vérité : `.txt` → record normalisé versionné. |
| `js/images.js` | Résolution des visuels de cartes ([goagain.dev](https://api.goagain.dev)), avec cache. |
| `js/db.js` | Couche **IndexedDB** (base `fab`, store `games`, clé = `gameId`) + export/import `.json`. |
| `js/sync.js` | **Synchro GitHub** — dépôt = base : lecture de `data/library.json` sans token, écriture par token perso (auto-détection du dépôt). |
| `data/library.json` | Bibliothèque **publiée** (servie en statique par Pages) — vierge dans le dépôt modèle. |
| `data/raw/` | Logs **bruts** déposés par le grabber (`<id>.txt` + `index.json`) — ingérés/parsés par le viewer (Phase 3). |
| `js/replay.js` | **Replay** d'une partie (extrait du standalone, comportement identique). |
| `js/dashboard.js` | **Agrégations** multi-parties + rendu (cœur pur testable en Node). |
| `css/style.css` | Styles (mobile-first). |
| `talishar-log-grabber_user.js` | **Grabber** (userscript Tampermonkey/Violentmonkey), v1.9.3. |
| `build/standalone.html` | Version fichier-unique régénérée (usage hors-ligne). |

## Utilisation

1. **Capturer** : installer le userscript `talishar-log-grabber_user.js`, jouer,
   puis exporter le `.txt` (Alt+Shift+D) en fin de partie (ouvrir le Game Summary
   pour capter les stats officielles).
2. **Importer** : ouvrir le site, déposer **un ou plusieurs** `.txt`.
   - 1 fichier → ouvre directement le **replay**.
   - N fichiers → alimente le **tableau de bord**.
3. Les parties sont **mémorisées** entre les sessions (IndexedDB) ; ré-importer
   la même partie ne crée pas de doublon (upsert par `gameId`).
4. **Sauvegarder / transférer** (hors-ligne) : le stockage IndexedDB est **local
   à un appareil**. **Exporter la bibliothèque** (`.json`) puis **Importer une
   sauvegarde** sur un autre appareil. L'import **fusionne** (dédup `gameId`).

## Synchro automatique entre appareils (GitHub comme base)

Le dépôt sert de base de données — **aucun service tiers**, données **publiques**.

- **Lecture** : `data/library.json` est servi en statique par Pages → chargé
  au démarrage **sans token**. Tes parties publiées apparaissent sur tous tes
  appareils, et se partagent par simple **URL**.
- **Écriture** : à l'import d'un log, la partie est poussée dans le dépôt via
  l'API GitHub avec **ton token** (bouton *☁ Connecter la synchro*, collé une
  fois par appareil ; stocké en local, **jamais commité**). Après l'import, Pages
  se redéploie (quelques dizaines de secondes) et les autres appareils voient la
  partie au prochain chargement.

> Le token donne un accès **en écriture** à ton dépôt : ne le partage jamais.
> Recommandé : un token **fine-grained** limité à ce seul dépôt, permission
> **Contents = Read and write**.

### Envoi direct depuis le grabber (Phase 3)

Le userscript peut publier la partie **sans passer par l'import manuel** :
- **⚙** (widget) → configurer le dépôt (`owner`, `repo`) + coller le token
  (fine-grained, **Contents = Read and write**), et choisir l'envoi manuel ou auto.
- **☁ Dépôt** / **Alt+Shift+S** → envoi manuel ; ou **auto** à l'ouverture du
  Game Summary de fin de partie.
- Le `.txt` brut est déposé dans `data/raw/<id>.txt` (+ `data/raw/index.json`).
  Le viewer l'ingère et le parse au chargement (le parseur reste **la seule
  source de vérité**, côté viewer). L'API GitHub est appelée en **CORS** (`fetch`),
  donc le userscript garde `@grant none`.

> Le token est stocké dans le `localStorage` de talishar.net : utilise un token
> **fine-grained limité à ce seul dépôt** (Contents R/W). Sa fuite éventuelle ne
> permettrait d'écrire que dans ce dépôt public, rien d'autre.

### Partager l'app à d'autres joueurs — modèle « 2 dépôts »

Ce dépôt est un **dépôt modèle** (Template repository) **vierge de parties**.
Chaque joueur crée sa **propre instance indépendante** (ses données, son URL) :

1. **Use this template** → dépôt neuf sous son compte (zéro partie).
2. **Settings → Pages** : activer Pages (choisir la branche par défaut).
3. Ouvrir son site → **☁ Connecter la synchro** → coller son token.
4. Importer ses logs → **son URL** (`https://<son-pseudo>.github.io/<repo>/`),
   qu'il peut partager. L'app **auto-détecte** son dépôt : rien à configurer.

## Développement

```bash
npm test      # tests parser + agrégation dashboard + clé DB (sans dépendance)
npm run check # node --check sur tous les modules JS
npm run build # régénère build/standalone.html
```

> **Convention** : la logique du parseur vit dans `talishar-parser.js` (chargé
> par `index.html`). Le standalone est **régénéré** par le build — ne pas
> l'éditer à la main.

## Feuille de route

- **Phase 1** (fait) : hébergement Pages, refactor dé-inliné, import multi + persistance, tableau de bord.
- **Phase 2** (fait) : synchro auto entre appareils via le dépôt GitHub (lecture sans token, écriture par token), export/import `.json`, modèle « 2 dépôts » pour le partage.
- **Phase 3** (fait, à tester en conditions réelles) : envoi direct de la partie dans le dépôt depuis le grabber (bouton `☁ Dépôt` / `Alt+Shift+S`, ou auto en fin de partie). Le `.txt` brut est déposé dans `data/raw/`, le viewer l'ingère et le parse au chargement. Voir `docs/PHASE3-grabber.md`.

---
Données non affiliées à Legend Story Studios. Images via goagain.dev.
