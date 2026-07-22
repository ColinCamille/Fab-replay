# FaB Analyzer — Chain Replay

Outil **personnel** d'analyse de parties de **Flesh and Blood** jouées sur
[talishar.net](https://talishar.net). Il rejoue une partie tour par tour et
agrège des **centaines** de parties dans un tableau de bord (winrate, matchups,
performance des cartes…).

Chaque joueur a un **compte privé** (connexion par email, sans mot de passe) :
tes parties s'enregistrent toutes seules et **toi seul les vois**, consultables
sur tous tes appareils.

---

## 🎮 Installation (pour jouer) — ~5 minutes

Tes parties Talishar s'enregistrent toutes seules dans **ton compte privé**
(toi seul les vois), consultables partout. Il te faut juste un **email** et le
navigateur **Chrome**, **Edge** ou **Firefox** (sur Android : **Firefox**).

### 1) Ouvrir l'app et se connecter
1. Ouvre **https://colincamille.github.io/Fab-replay/** — **mets-la en favori** (PC **et** téléphone).
2. En bas de page : **🔑 Se connecter** → entre ton **email**.
3. Tu reçois un **lien de connexion** par email (vérifie les spams) → clique-le → tu reviens **connecté**. **Aucun mot de passe.**

### 2) Installer un gestionnaire de userscripts
Un petit script (« grabber ») lit tes parties sur Talishar. Installe-en **un seul** :
- **Tampermonkey** → **https://www.tampermonkey.net** (Chrome, Edge, Firefox)
- **Violentmonkey** → **https://violentmonkey.github.io** (Chrome, Edge, Firefox)
- **Android** : appli **Firefox**, puis l'un des deux dedans.
- *iPhone : non garanti (les userscripts sont difficiles sur iOS).*

### 3) Installer le grabber (un clic)
1. Ouvre **https://raw.githubusercontent.com/ColinCamille/Fab-replay/main/talishar-log-grabber.user.js**
2. Ton gestionnaire propose **Installer** → confirme. *(Il se met à jour tout seul ensuite.)*

### 4) Connecter le grabber à ton compte (une fois, en 1 clic)
1. Assure-toi d'être **connecté dans l'app** (même navigateur).
2. Ouvre une **partie sur Talishar** → widget **📜 Log Grabber** (en bas à gauche) → clique **🔗 Compte**.
3. Une petite fenêtre de l'app s'ouvre, se connecte **toute seule** et se ferme (« Compte connecté ✔ »). **Rien à copier.**

> Si la fenêtre est bloquée (bloqueur de pop-up) : autorise-la et réessaie, ou
> clique **🔗 Connecter le grabber** dans l'app pour obtenir un **code** à coller
> manuellement (bouton **⚙** du grabber).

### 5) Jouer et consulter
1. **Joue** normalement.
2. À la fin, **ouvre le « Game Summary »** (récap de fin) — 💡 clique aussi pour voir **les stats de l'adversaire** (capte les deux camps). Ta partie **part toute seule** dans ton compte.
3. Reviens sur l'app → onglet **🗒 Historique** → clique une partie : **⚔ Déroulé** (tour par tour) et **🎴 Table** (le plateau). Sur PC, **survole une carte** pour l'agrandir.

### En cas de pépin
- **Le lien de connexion n'arrive pas** → vérifie les spams ; réessaie dans 1-2 min (limite d'envoi email).
- **La partie ne remonte pas** → tu n'as pas ouvert le **Game Summary** (c'est ce qui déclenche l'envoi). Tu peux forcer avec **🔗 Compte** dans le widget.
- **« Partie sans id — envoi ignoré »** → page sans partie en cours ; ouvre `talishar.net/game/play/<numéro>` puis réessaie.
- **Version du grabber** : affichée dans le widget (**📜 Log Grabber vX.Y.Z**) ; il s'actualise seul, ou force via le menu de l'extension → « Rechercher des mises à jour ».

### C'est privé
Tes parties ne sont visibles **que par toi** (via ton compte). Rien n'est public. Tu peux tout effacer d'un clic : **🗑 Supprimer mon compte** (dans l'app).

---

## Composants

| Fichier | Rôle |
|---|---|
| `index.html` | Point d'entrée : routeur **2 modes** (tableau de bord / replay). |
| `talishar-parser.js` | **Parser** — source de vérité : `.txt` → record normalisé versionné. |
| `js/images.js` | Résolution des visuels de cartes ([goagain.dev](https://api.goagain.dev)), avec cache. |
| `js/db.js` | Couche **IndexedDB** (base `fab`, store `games`, clé = `gameId`) + export/import `.json`. |
| `js/cloud.js` | **Backend Supabase** : login lien magique, lecture/écriture des parties (RLS), appairage grabber, migration, suppression RGPD. |
| `js/cloud-config.js` | URL du projet Supabase + clé **publishable** (publiques). |
| `supabase/functions/` | Edge Functions : **`ingest`** (réception grabber) et **`delete-account`** (RGPD). |
| `js/sync.js` | Synchro GitHub — **héritage désactivé** (`LEGACY_GITHUB=false`), remplacé par Supabase. |
| `data/` | Anciens fichiers de synchro GitHub (vidés) — plus utilisés dans le modèle Supabase. |
| `js/replay.js` | **Replay** d'une partie (onglet **Déroulé**, extrait du standalone, comportement identique). |
| `js/boardreplay.js` | Vue **Table** (« tapis miroir ») : rejoue le combat sur un plateau, tour par tour. |
| `js/dashboard.js` | **Agrégations** multi-parties + rendu (cœur pur testable en Node). |
| `css/style.css` | Styles (mobile-first). |
| `talishar-log-grabber.user.js` | **Grabber** (userscript Tampermonkey/Violentmonkey) — envoie la partie dans **ton compte Supabase** (auto-update). |

## Utilisation

1. **Capturer** : installer le userscript `talishar-log-grabber.user.js`, jouer,
   ouvrir le **Game Summary** en fin de partie (capte les stats officielles) → la
   partie part **automatiquement dans ton compte** (bouton `🔗 Compte` /
   `Alt+Shift+S` pour un envoi manuel ; `Alt+Shift+D` pour un export `.txt`).
2. **Importer** : ouvrir le site, déposer **un ou plusieurs** `.txt`.
   - 1 fichier → ouvre directement le **replay**.
   - N fichiers → alimente le **tableau de bord**.
3. Les parties sont **mémorisées** entre les sessions (IndexedDB) ; ré-importer
   la même partie ne crée pas de doublon (upsert par `gameId`).
4. **Sauvegarder / transférer** (hors-ligne) : le stockage IndexedDB est **local
   à un appareil**. **Exporter la bibliothèque** (`.json`) puis **Importer une
   sauvegarde** sur un autre appareil. L'import **fusionne** (dédup `gameId`).

## Pour l'hébergeur — backend Supabase (option C)

L'app est servie **une seule fois** (GitHub Pages) et tout le monde utilise la
**même URL**. Les parties sont stockées dans **Supabase** (Postgres + Auth),
privées par utilisateur grâce à la **Row-Level Security**. Avantages : install
minimale pour les joueurs (pas de compte GitHub, pas de token), mises à jour de
code **automatiques** pour tous, et données **privées**.

Mise en place (une fois) :
1. Créer un projet **Supabase** (région UE pour le RGPD).
2. Coller le SQL (tables `games` + `device_tokens`, policies RLS).
3. Déployer les Edge Functions **`ingest`** (réception des parties du grabber,
   *Verify JWT désactivé*) et **`delete-account`** (RGPD). Voir
   `supabase/functions/*/index.ts`.
4. **Authentication → Email** (lien magique) + **URL Configuration** (Site URL =
   l'URL de l'app).
5. Renseigner l'URL du projet + la clé **publishable** dans `js/cloud-config.js`
   (valeurs publiques ; la sécurité vient de la RLS).

> L'ancienne synchro GitHub (dépôt = base) est conservée en code mais
> **désactivée** (`LEGACY_GITHUB = false` dans `index.html`). Le grabber envoie
> désormais **uniquement** au compte Supabase.

## Développement

```bash
npm test      # tests parser + agrégation dashboard + clé DB (sans dépendance)
npm run check # node --check sur tous les modules JS
```

> **Convention** : la logique du parseur vit dans `talishar-parser.js` (chargé
> par `index.html`) ; c'est la source de vérité, réutilisée par le replay, la
> Table et le tableau de bord.

## Feuille de route

- **Phase 1** (fait) : hébergement Pages, refactor dé-inliné, import multi + persistance, tableau de bord.
- **Phase 2** (fait) : synchro auto entre appareils via le dépôt GitHub (lecture sans token, écriture par token), export/import `.json`, modèle « 2 dépôts » pour le partage.
- **Phase 3** (fait, validé en conditions réelles) : envoi direct de la partie dans le dépôt depuis le grabber (bouton `☁ Dépôt` / `Alt+Shift+S`, ou auto en fin de partie, avec re-envoi après le swap pour les stats adverses). Le `.txt` brut est déposé dans `data/raw/`, le viewer l'ingère et le parse au chargement. Voir `docs/PHASE3-grabber.md`.
- **Phase 4** (fait) : vue **Table** (« tapis miroir ») rejouant le combat sur un plateau (mains, arsenal, cimetière, banni, pitch, permanents/tokens des 2 camps, activations) ; capture des terrains/héros fiabilisée côté grabber (héros issus des stats officielles) ; synchro qui **met à jour** une partie déjà en cache quand elle est corrigée en amont.
- **Phase 5** (fait) : **tags libres** et **favoris** par partie (depuis l'onglet Historique — ⭐ + éditeur de tags avec auto-complétion). Un **filtre « tag »** dans le tableau de bord segmente toutes les stats par variante de deck (ex. Oscilio « gone » vs « spell ») ; un filtre **⭐ favoris** dans l'historique. Ces métadonnées sont rangées au niveau de l'entrée (à côté de `gameId`).
- **Phase 6** (fait) : **backend Supabase** (option C) — connexion par **lien magique** (email, sans mot de passe), parties **privées** par utilisateur (Row-Level Security), capture envoyée au compte via l'Edge Function `ingest` (appairage 1-code du grabber), migration des parties existantes, suppression RGPD (`delete-account`). L'app devient **centrale** (une URL, mises à jour auto pour tous) ; l'ancienne voie GitHub est désactivée. Install joueur réduite à : ouvrir l'app → se connecter → installer le grabber → coller le code.

---
Données non affiliées à Legend Story Studios. Images via goagain.dev.
