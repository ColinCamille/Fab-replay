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
  function toEntry(record, raw) {
    const src = record.source || {};
    return {
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
  }

  // Upsert (put) : ré-importer la même partie écrase proprement.
  async function putGame(record, raw) {
    const store = await tx('readwrite');
    const entry = toEntry(record, raw);
    await wrap(store.put(entry));
    return entry.gameId;
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
    return wrap(store.delete(String(id)));
  }

  async function count() {
    const store = await tx('readonly');
    return wrap(store.count());
  }

  async function clearAll() {
    const store = await tx('readwrite');
    return wrap(store.clear());
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
      try { await putEntry(e); imported++; } catch (err) { console.error(err); }
    }
    return { imported, skipped: Math.max(0, rawList.length - imported) };
  }

  root.FabDB = {
    open, keyFor, putGame, getAllEntries, getEntry, removeGame, count, clearAll,
    putEntry, buildExport, normalizeImport, exportAll, importEntries
  };
})(typeof self !== 'undefined' ? self : this);
