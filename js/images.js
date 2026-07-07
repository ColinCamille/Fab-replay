/* ============================================================
 * Résolution d'images de cartes (goagain.dev) — module partagé
 * ------------------------------------------------------------
 * Extrait du viewer standalone (inchangé sur le fond). Utilisé à
 * la fois par le replay (visuels de cartes/héros/équipement) et
 * par le dashboard (avatars de héros des matchups).
 *
 * Cache local (localStorage) pour ne pas re-questionner l'API à
 * chaque rendu — les métadonnées d'une carte ne changent pas.
 * ============================================================ */
(function (root) {
  'use strict';

  const cardMetaCache = (function () {
    try { return JSON.parse(localStorage.getItem('fabCardMetaCacheV1') || '{}'); }
    catch (e) { return {}; }
  })();
  function saveMetaCache() {
    try { localStorage.setItem('fabCardMetaCacheV1', JSON.stringify(cardMetaCache)); } catch (e) {}
  }

  function findImageUrl(obj, depth) {
    depth = depth || 0;
    if (!obj || depth > 5) return null;
    if (typeof obj === 'string') {
      if (/^https?:\/\//.test(obj) && /\.(png|jpe?g|webp|avif)(\?.*)?$/i.test(obj)) return obj;
      return null;
    }
    if (Array.isArray(obj)) { for (const it of obj) { const r = findImageUrl(it, depth + 1); if (r) return r; } return null; }
    if (typeof obj === 'object') {
      const keys = Object.keys(obj);
      const priority = keys.filter(k => /image|img|art|photo|picture|thumbnail/i.test(k));
      for (const k of priority) { const r = findImageUrl(obj[k], depth + 1); if (r) return r; }
      for (const k of keys) { if (priority.includes(k)) continue; const r = findImageUrl(obj[k], depth + 1); if (r) return r; }
    }
    return null;
  }

  const EQUIPMENT_RE = /\bequipment\b|\bhead\b|\bchest\b|\barms?\b|\blegs?\b|\boff-?hand\b|\bweapon\b/i;
  function findCardTypeInfo(obj, depth) {
    depth = depth || 0;
    if (!obj || depth > 5) return { isEquipment: false, label: null };
    if (typeof obj === 'object' && !Array.isArray(obj)) {
      const typeKeys = Object.keys(obj).filter(k => /^(type|types|category|categories|class|classes|slot)$/i.test(k));
      for (const k of typeKeys) {
        const v = obj[k];
        const asText = Array.isArray(v) ? v.join(' ') : String(v || '');
        if (EQUIPMENT_RE.test(asText)) return { isEquipment: true, label: asText };
      }
      for (const k of Object.keys(obj)) {
        if (typeKeys.includes(k)) continue;
        const r = findCardTypeInfo(obj[k], depth + 1);
        if (r.isEquipment) return r;
      }
    }
    if (Array.isArray(obj)) { for (const it of obj) { const r = findCardTypeInfo(it, depth + 1); if (r.isEquipment) return r; } }
    return { isEquipment: false, label: null };
  }

  async function resolveCardMeta(name) {
    if (!name) return { image: null, isEquipment: false };
    if (cardMetaCache[name]) return cardMetaCache[name];
    try {
      const res = await fetch('https://api.goagain.dev/v1/cards?name=' + encodeURIComponent(name) + '&limit=5');
      if (!res.ok) throw new Error('http ' + res.status);
      const json = await res.json();
      const list = json.data || json.cards || json.results || [];
      let best = list.find(c => (c.name || '').toLowerCase() === name.toLowerCase()) || list[0] || null;
      const image = best ? findImageUrl(best) : null;
      const typeInfo = best ? findCardTypeInfo(best) : { isEquipment: false, label: null };
      const meta = { image: image || null, isEquipment: typeInfo.isEquipment, typeLabel: typeInfo.label };
      cardMetaCache[name] = meta;
      saveMetaCache();
      return meta;
    } catch (e) {
      console.warn('[images] métadonnées introuvables pour', name, e);
      const meta = { image: null, isEquipment: false, typeLabel: null };
      cardMetaCache[name] = meta;
      saveMetaCache();
      return meta;
    }
  }
  async function resolveCardImage(name) { return (await resolveCardMeta(name)).image; }

  root.CardImages = { resolveCardMeta, resolveCardImage, findImageUrl, findCardTypeInfo };
})(typeof self !== 'undefined' ? self : this);
