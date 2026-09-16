/* ============================================================
 * Couche de persistance IndexedDB — bibliothèque de parties
 * ------------------------------------------------------------
 * Base `fab`, store `games`, clé primaire = gameId (identifiant
 * unique de la partie → déduplication naturelle : ré-importer la
 * même partie fait un upsert, jamais un doublon).
 *
 * On stocke, pour chaque partie :
 *   - `record` : le record parsé complet (voir talishar-parser.js)
 *   - `raw`    : le .txt brut (pour re-parser si le parseur évolue)
 *   - `schemaVersion` / `parserVersion` : pour d'éventuelles migrations
 *
 * PERFORMANCE (v2 du schéma IndexedDB) : le `raw` est ÉNORME (souvent
 * plusieurs Mo) et le dashboard n'en a JAMAIS besoin — seul le `record`
 * l'intéresse. Il est donc rangé dans un store à part (`raws`) et
 * `getAllEntries()` (chemin du dashboard) ne le désérialise plus ; on ne
 * le relit qu'à la demande (`getRaw`, `getEntry`, export, re-parse).
 * Même logique pour `record.rawChatLog` : il ne sert QUE pendant le
 * parsing (couleurs des cartes) → on ne le persiste pas.
 * En mémoire, l'entrée garde la même forme qu'avant (`raw` inclus) : la
 * séparation est un détail de la couche de stockage.
 *
 * Une origine stable (GitHub Pages) rend IndexedDB fiable et
 * persistant entre sessions, y compris sur mobile — contrairement
 * à un fichier file:// dont le stockage est isolé/éphémère.
 * ============================================================ */
(function (root) {
  'use strict';

  const DB_NAME = 'fab';
  const DB_VERSION = 2;
  const STORE = 'games';
  const RAW_STORE = 'raws';   // { gameId, raw } — logs bruts, lus À LA DEMANDE

  // Clé stable d'une partie. gameId est la source normale ; à défaut
  // (vieux log sans en-tête), on retombe sur le numéro de l'URL, puis
  // sur une empreinte du texte brut pour ne jamais perdre une partie.
  function keyFor(record, raw) {
    const src = (record && record.source) || {};
    if (src.gameId) return String(src.gameId);
    if (src.gameUrl) { const m = String(src.gameUrl).match(/(\d{4,})/); if (m) return 'url-' + m[1]; }
    return 'hash-' + hashString(raw || JSON.stringify(record || {}));
  }

  // Empreinte déterministe (djb2) — suffisante pour dédupliquer un même
  // .txt ré-importé ; ce n'est pas de la crypto.
  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // ---------- Métadonnées utilisateur (tags libres, favori) ----------
  // Rangées AU NIVEAU DE L'ENTRÉE (à côté de gameId), pas dans le record :
  //   - elles se synchronisent « gratuitement » (cloudEntry recopie l'entrée),
  //   - elles survivent à un re-parsing du record (le record peut être régénéré).
  // Nettoie une liste de tags : chaîne(s) → tableau trimé, sans doublon
  // (comparaison insensible à la casse, on garde la 1ʳᵉ graphie vue), bornes
  // raisonnables. Pur → testable en Node.
  function normalizeTags(arr) {
    if (arr == null) arr = [];
    if (!Array.isArray(arr)) arr = [arr];
    const out = [], seen = new Set();
    for (const raw of arr) {
      const t = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!t) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= 20) break;
    }
    return out;
  }

  // ---------- Pierres tombales (suppressions persistantes) ----------
  // La suppression est locale, mais la synchro (sync.js pull) ré-injecte
  // sinon toute partie absente depuis le dépôt (library.json + data/raw du
  // grabber). On mémorise donc les gameId explicitement supprimés pour que
  // `pull` les ignore. Une réimportation VOLONTAIRE lève la pierre tombale.
  const DELETED_KEY = 'fabDeletedIds';
  function deletedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(DELETED_KEY) || '[]')); }
    catch (e) { return new Set(); }
  }
  function saveDeleted(set) {
    try { localStorage.setItem(DELETED_KEY, JSON.stringify(Array.from(set))); } catch (e) { /* quota / privé */ }
  }
  function markDeleted(id) { const s = deletedSet(); s.add(String(id)); saveDeleted(s); }
  function unmarkDeleted(id) { const s = deletedSet(); if (s.delete(String(id))) saveDeleted(s); }
  function isDeleted(id) { return deletedSet().has(String(id)); }
  function deletedIds() { return Array.from(deletedSet()); }
  function clearDeleted() { try { localStorage.removeItem(DELETED_KEY); } catch (e) { /* ignore */ } }

  let _dbPromise = null;
  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      // L'upgrade ne fait QUE créer les stores : c'est instantané. Déplacer les
      // logs bruts ici (transaction de version sur des centaines de Mo) bloquait
      // l'ouverture de la base — donc TOUTE l'app — et restait bloqué pour de bon
      // si un autre onglet du site tenait la base en v1. Le déplacement se fait
      // maintenant APRÈS ouverture, partie par partie (migrateRaws).
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'gameId' });
          // index utiles aux tris/filtres du dashboard
          store.createIndex('capturedAt', 'capturedAt', { unique: false });
          store.createIndex('oppHero', 'oppHero', { unique: false });
          store.createIndex('format', 'format', { unique: false });
        }
        if (!db.objectStoreNames.contains(RAW_STORE)) db.createObjectStore(RAW_STORE, { keyPath: 'gameId' });
      };
      // Un autre onglet garde l'ancienne version ouverte → l'upgrade attend. On le
      // DIT au lieu de rester sur une page vide (l'app reprend dès l'onglet fermé).
      req.onblocked = () => {
        console.warn('[db] mise à jour de la base bloquée par un autre onglet du site');
        if (typeof root.onFabDbBlocked === 'function') { try { root.onFabDbBlocked(); } catch (e) {} }
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        // Une autre page demande une nouvelle version : on libère la base, sinon
        // c'est NOUS qui la bloquerions.
        db.onversionchange = () => { try { db.close(); } catch (err) {} _dbPromise = null; };
        resolve(db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
    return _dbPromise;
  }

  // ---------- Migration v1 → v2, INCRÉMENTALE (hors transaction de version) ----------
  // Sort le log brut de chaque entrée vers le store `raws` (et jette
  // `record.rawChatLog`, inutile hors parsing), UNE PARTIE À LA FOIS : chaque pas
  // est une petite transaction, l'interface reste vivante, un échec sur une partie
  // n'empêche pas les autres, et l'espace disque ne double jamais.
  // Réexécutable : une entrée déjà migrée est simplement sautée.
  const MIGRATED_KEY = 'fabRawsMigratedV2';
  function needsRawMigration() {
    try { return localStorage.getItem(MIGRATED_KEY) !== '1'; } catch (e) { return true; }
  }
  function markRawMigrated() { try { localStorage.setItem(MIGRATED_KEY, '1'); } catch (e) {} }

  async function migrateRaws(onProgress) {
    const store = await tx('readonly');
    const ids = (await wrap(store.getAllKeys())) || [];
    let moved = 0, failed = 0, i = 0;
    for (const id of ids) {
      i++;
      try {
        const entry = await getMeta(id);
        if (!entry) continue;
        const hadRaw = entry.raw != null;
        const hadChat = !!(entry.record && entry.record.rawChatLog);
        if (!hadRaw && !hadChat) continue;                     // déjà migrée
        if (hadRaw) await putRaw(entry.gameId, entry.raw);     // 1) le brut à part…
        const st = await tx('readwrite');
        await wrap(st.put(slimEntry(entry)));                  // 2) …puis l'entrée allégée
        moved++;
      } catch (e) { failed++; console.error('[db] migration de', id, 'échouée', e); }
      if (typeof onProgress === 'function') { try { onProgress(i, ids.length); } catch (e) {} }
    }
    if (!failed) markRawMigrated();
    return { moved, failed, total: ids.length };
  }

  function tx(mode) {
    return open().then(db => db.transaction(STORE, mode).objectStore(STORE));
  }
  function rawTx(mode) {
    return open().then(db => db.transaction(RAW_STORE, mode).objectStore(RAW_STORE));
  }
  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ---------- Log brut : store séparé (voir l'en-tête) ----------
  // Lit le log brut d'une partie. Repli sur l'ancien emplacement (`entry.raw`)
  // au cas où une entrée n'aurait pas été migrée (base ouverte par une vieille
  // version de l'app dans un autre onglet, par ex.).
  async function getRaw(id) {
    const gid = String(id);
    const store = await rawTx('readonly');
    const row = await wrap(store.get(gid));
    if (row && row.raw) return row.raw;
    const games = await tx('readonly');
    const entry = await wrap(games.get(gid));
    return (entry && entry.raw) || null;
  }

  async function putRaw(id, raw) {
    const store = await rawTx('readwrite');
    return wrap(raw ? store.put({ gameId: String(id), raw: raw }) : store.delete(String(id)));
  }

  async function dropRaw(id) {
    const store = await rawTx('readwrite');
    return wrap(store.delete(String(id)));
  }

  // Version « de stockage » d'une entrée : sans le `raw` (rangé à part) et sans
  // `record.rawChatLog` (utile seulement pendant le parsing, énorme à stocker).
  function slimEntry(entry) {
    const e = Object.assign({}, entry);
    e.hasRaw = !!e.raw;
    delete e.raw;
    if (e.record && e.record.rawChatLog) {
      e.record = Object.assign({}, e.record);
      delete e.record.rawChatLog;
    }
    return e;
  }

  // Construit l'entrée stockée à partir d'un record parsé + txt brut.
  // `extra` fusionne des champs additionnels (ex. syncStamp : l'horodatage
  // `uploadedAt` du manifeste du dépôt, utilisé par la synchro pour détecter
  // qu'une partie a été corrigée en amont et doit être re-téléchargée).
  function toEntry(record, raw, extra) {
    const src = record.source || {};
    const entry = {
      gameId: keyFor(record, raw),
      record: record,
      raw: raw || null,
      schemaVersion: record.schemaVersion != null ? record.schemaVersion : null,
      parserVersion: src.parserVersion || null,
      capturedAt: src.capturedAt || null,
      gameDate: src.gameDate || null,
      oppHero: (record.players && record.players.opp && record.players.opp.hero) || null,
      format: record.format || null,
      savedAt: new Date().toISOString()
    };
    if (extra) Object.keys(extra).forEach(k => { entry[k] = extra[k]; });
    return entry;
  }

  // Upsert (put) : ré-importer la même partie écrase proprement.
  // On PRÉSERVE les métadonnées utilisateur (tags, favori) déjà posées :
  // un ré-import manuel ou un re-téléchargement d'une partie corrigée en amont
  // (synchro grabber) ne doit jamais effacer les étiquettes/favoris locaux —
  // sauf si l'appelant fournit explicitement ces champs via `extra`.
  // `opts.rawAlreadyStored` : le log brut vient d'être RELU depuis ce store (cas
  // du re-parse après évolution du parseur) → inutile de le réécrire (des Mo).
  async function putGame(record, raw, extra, opts) {
    const entry = toEntry(record, raw, extra);
    const prev = await getMeta(entry.gameId);           // tx séparée (évite un tx inactif)
    if (prev) {
      if (!(extra && 'tags' in extra) && prev.tags != null) entry.tags = prev.tags;
      if (!(extra && 'favorite' in extra) && prev.favorite != null) entry.favorite = prev.favorite;
      if (!(extra && 'metaUpdatedAt' in extra) && prev.metaUpdatedAt != null) entry.metaUpdatedAt = prev.metaUpdatedAt;
    }
    if (raw && !(opts && opts.rawAlreadyStored)) await putRaw(entry.gameId, raw);
    const store = await tx('readwrite');
    await wrap(store.put(slimEntry(entry)));
    return entry.gameId;
  }

  // Met à jour les métadonnées utilisateur d'une partie (tags et/ou favori),
  // en conservant le reste de l'entrée intacte. `patch` : { tags?, favorite? }.
  // Estampille `metaUpdatedAt` (ISO) → sert à la synchro pour propager la
  // dernière modification entre appareils. Renvoie l'entrée mise à jour (ou null).
  async function setMeta(id, patch) {
    const prev = await getMeta(id);
    if (!prev) return null;
    patch = patch || {};
    const entry = Object.assign({}, prev);
    if ('tags' in patch) entry.tags = normalizeTags(patch.tags);
    if ('favorite' in patch) entry.favorite = !!patch.favorite;
    entry.metaUpdatedAt = new Date().toISOString();
    const store = await tx('readwrite');
    await wrap(store.put(entry));
    return entry;
  }

  // Applique des métadonnées venues du COMPTE (tags/favori/metaUpdatedAt) en
  // dernier-écrit-gagne : on n'écrase que si l'estampille distante est plus
  // récente que la locale. Renvoie true si l'entrée a changé.
  async function applyCloudMeta(id, meta) {
    if (!meta) return false;
    const prev = await getMeta(id);
    if (!prev) return false;
    const local = prev.metaUpdatedAt || '';
    const remote = meta.metaUpdatedAt || '';
    if (remote && local && remote <= local) return false;   // local aussi/plus récent → garder
    const tags = normalizeTags(meta.tags || []);
    const favorite = !!meta.favorite;
    // Meta distante SANS estampille : la garde ci-dessus ne peut pas jouer. Sans
    // ce test d'égalité, on réécrivait l'entrée (et on signalait un changement)
    // à CHAQUE chargement, pour rien.
    if (!remote && favorite === !!prev.favorite
        && (prev.tags || []).join(' ') === tags.join(' ')) return false;
    const entry = Object.assign({}, prev);
    entry.tags = tags;
    entry.favorite = favorite;
    entry.metaUpdatedAt = remote || new Date().toISOString();
    const store = await tx('readwrite');
    await wrap(store.put(entry));
    return true;
  }

  // Toutes les entrées SANS les logs bruts (chemin du dashboard). C'est LA
  // lecture chaude de l'app : elle doit rester légère (cf. en-tête).
  async function getAllEntries() {
    const store = await tx('readonly');
    const all = await wrap(store.getAll());
    return all || [];
  }

  // Entrée telle que stockée (sans `raw`) — pour les mises à jour internes.
  async function getMeta(id) {
    const store = await tx('readonly');
    return wrap(store.get(String(id)));
  }

  // Entrée COMPLÈTE (avec le log brut recollé) : à la demande seulement.
  async function getEntry(id) {
    const entry = await getMeta(id);
    if (!entry) return entry;
    if (entry.raw) return entry;                       // entrée non migrée : déjà complète
    const raw = entry.hasRaw ? await getRaw(entry.gameId) : null;
    return raw ? Object.assign({}, entry, { raw: raw }) : entry;
  }

  async function removeGame(id) {
    const store = await tx('readwrite');
    const res = await wrap(store.delete(String(id)));
    await dropRaw(id);
    markDeleted(id);   // pose la pierre tombale → la synchro ne la ré-injectera plus
    return res;
  }

  // Retrait local SANS pierre tombale : pour la réconciliation depuis le compte
  // (une partie supprimée ailleurs). Pas de tombstone → si elle est re-ajoutée
  // au compte plus tard, elle pourra revenir normalement.
  async function dropGame(id) {
    const store = await tx('readwrite');
    const res = await wrap(store.delete(String(id)));
    await dropRaw(id);
    return res;
  }

  async function count() {
    const store = await tx('readonly');
    return wrap(store.count());
  }

  async function clearAll() {
    const store = await tx('readwrite');
    const res = await wrap(store.clear());
    const raws = await rawTx('readwrite');
    await wrap(raws.clear());
    clearDeleted();   // remise à zéro complète : on oublie aussi les suppressions
    return res;
  }

  // Écrit une entrée complète telle quelle (pour la restauration d'une
  // sauvegarde : on préserve gameId, capturedAt, savedAt… d'origine).
  async function putEntry(entry) {
    if (entry && entry.raw) await putRaw(entry.gameId, entry.raw);
    const store = await tx('readwrite');
    return wrap(store.put(slimEntry(entry || {})));
  }

  // ---------- Export / Import (sauvegarde multi-appareils) ----------
  // La persistance est locale à un appareil : ces helpers permettent de
  // transporter sa bibliothèque d'un PC vers un téléphone via un simple
  // fichier .json (aucun serveur requis, cohérent avec « chacun ses données »).

  // Enveloppe versionnée et sérialisable (pure — testable sans IndexedDB).
  function buildExport(entries) {
    return {
      app: 'fab',
      kind: 'library',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: (entries || []).length,
      games: entries || []
    };
  }

  // Normalise une sauvegarde importée en un tableau d'entrées prêtes au put.
  // Tolère : enveloppe {games:[…]}, tableau brut, ou entrée unique. Ignore
  // ce qui n'a pas de `record` exploitable ; reconstruit l'entrée si le
  // gameId manque (ancien export ou objet {record, raw} nu). Pure/testable.
  function normalizeImport(data) {
    let games;
    if (Array.isArray(data)) games = data;
    else if (data && Array.isArray(data.games)) games = data.games;
    else if (data && (data.gameId || data.record)) games = [data];
    else games = [];
    const out = [];
    for (const g of games) {
      if (!g || typeof g !== 'object') continue;
      if (g.gameId && g.record) { out.push(g); continue; }   // entrée déjà formée
      if (g.record) { out.push(toEntry(g.record, g.raw)); continue; } // à reconstruire
      // sinon : pas de record → inexploitable, on ignore
    }
    return out;
  }

  // La sauvegarde, elle, DOIT contenir les logs bruts → on les recolle ici
  // (seul endroit qui relit toute la bibliothèque en entier, à la demande).
  async function exportAll() {
    const entries = await getAllEntries();
    const full = [];
    for (const e of entries) {
      if (e.raw || !e.hasRaw) { full.push(e); continue; }
      const raw = await getRaw(e.gameId);
      full.push(raw ? Object.assign({}, e, { raw: raw }) : e);
    }
    return buildExport(full);
  }

  // Fusionne (upsert par gameId) une sauvegarde dans la bibliothèque locale.
  // opts.replace = true → vide d'abord la bibliothèque. Retourne un bilan.
  async function importEntries(data, opts) {
    opts = opts || {};
    const rawList = Array.isArray(data) ? data
      : (data && Array.isArray(data.games)) ? data.games
      : (data ? [data] : []);
    const entries = normalizeImport(data);
    if (opts.replace) await clearAll();
    let imported = 0;
    for (const e of entries) {
      try { await putEntry(e); unmarkDeleted(e.gameId); imported++; }   // restauration volontaire → lève la pierre tombale
      catch (err) { console.error(err); }
    }
    return { imported, skipped: Math.max(0, rawList.length - imported) };
  }

  root.FabDB = {
    open, keyFor, putGame, getAllEntries, getEntry, getMeta, getRaw, removeGame, dropGame, count, clearAll,
    putEntry, buildExport, normalizeImport, exportAll, importEntries,
    markDeleted, unmarkDeleted, isDeleted, deletedIds, clearDeleted,
    normalizeTags, setMeta, applyCloudMeta, slimEntry, migrateRaws, needsRawMigration
  };
})(typeof self !== 'undefined' ? self : this);
