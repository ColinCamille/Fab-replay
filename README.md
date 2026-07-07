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
| `js/db.js` | Couche **IndexedDB** (base `fab`, store `games`, clé = `gameId`). |
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
- **Phase 2** (à venir) : dépôt automatique des logs depuis le grabber (API GitHub) + synchro auto du viewer.

---
Données non affiliées à Legend Story Studios. Images via goagain.dev.
