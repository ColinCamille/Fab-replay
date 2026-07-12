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
 * Une origine stable (GitHub Pages) rend IndexedDB fiable et
 * persistant entre sessions, y compris sur mobile — contrairement
 * à un fichier file:// dont le stockage est isolé/éphémère.
 * ============================================================ */
(function (root) {
  'use strict';

  const DB_NAME = 'fab';
  const DB_VERSION = 1;
  const STORE = 'games';

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
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'gameId' });
          // index utiles aux tris/filtres du dashboard
          store.createIndex('capturedAt', 'capturedAt', { unique: false });
          store.createIndex('oppHero', 'oppHero', { unique: false });
          store.createIndex('format', 'format', { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return _dbPromise;
  }

  function tx(mode) {
    return open().then(db => db.transaction(STORE, mode).objectStore(STORE));
  }
  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
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
  async function putGame(record, raw, extra) {
    const entry = toEntry(record, raw, extra);
    const prev = await getEntry(entry.gameId);          // tx séparée (évite un tx inactif)
    if (prev) {
      if (!(extra && 'tags' in extra) && prev.tags != null) entry.tags = prev.tags;
      if (!(extra && 'favorite' in extra) && prev.favorite != null) entry.favorite = prev.favorite;
      if (!(extra && 'metaUpdatedAt' in extra) && prev.metaUpdatedAt != null) entry.metaUpdatedAt = prev.metaUpdatedAt;
    }
    const store = await tx('readwrite');
    await wrap(store.put(entry));
    return entry.gameId;
  }

  // Met à jour les métadonnées utilisateur d'une partie (tags et/ou favori),
  // en conservant le reste de l'entrée intacte. `patch` : { tags?, favorite? }.
  // Estampille `metaUpdatedAt` (ISO) → sert à la synchro pour propager la
  // dernière modification entre appareils. Renvoie l'entrée mise à jour (ou null).
  async function setMeta(id, patch) {
    const prev = await getEntry(id);
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

  async function getAllEntries() {
    const store = await tx('readonly');
    const all = await wrap(store.getAll());
    return all || [];
  }

  async function getEntry(id) {
    const store = await tx('readonly');
    return wrap(store.get(String(id)));
  }

  async function removeGame(id) {
    const store = await tx('readwrite');
    const res = await wrap(store.delete(String(id)));
    markDeleted(id);   // pose la pierre tombale → la synchro ne la ré-injectera plus
    return res;
  }

  // Retrait local SANS pierre tombale : pour la réconciliation depuis le compte
  // (une partie supprimée ailleurs). Pas de tombstone → si elle est re-ajoutée
  // au compte plus tard, elle pourra revenir normalement.
  async function dropGame(id) {
    const store = await tx('readwrite');
    return wrap(store.delete(String(id)));
  }

  async function count() {
    const store = await tx('readonly');
    return wrap(store.count());
  }

  async function clearAll() {
    const store = await tx('readwrite');
    const res = await wrap(store.clear());
    clearDeleted();   // remise à zéro complète : on oublie aussi les suppressions
    return res;
  }

  // Écrit une entrée complète telle quelle (pour la restauration d'une
  // sauvegarde : on préserve gameId, capturedAt, savedAt… d'origine).
  async function putEntry(entry) {
    const store = await tx('readwrite');
    return wrap(store.put(entry));
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

  async function exportAll() {
    const entries = await getAllEntries();
    return buildExport(entries);
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
    open, keyFor, putGame, getAllEntries, getEntry, removeGame, dropGame, count, clearAll,
    putEntry, buildExport, normalizeImport, exportAll, importEntries,
    markDeleted, unmarkDeleted, isDeleted, deletedIds, clearDeleted,
    normalizeTags, setMeta
  };
})(typeof self !== 'undefined' ? self : this);
