/* ============================================================
 * Cloud — couche Supabase (auth par lien magique + parties).
 * ------------------------------------------------------------
 * Backend « option C » : login sans mot de passe, parties privées
 * (RLS). Ce module est ADDITIF — il ne remplace pas encore la
 * synchro GitHub ; tant que l'utilisateur n'est pas connecté, l'app
 * fonctionne exactement comme avant (IndexedDB + éventuel GitHub).
 *
 * Dépendances chargées avant ce fichier dans index.html :
 *   - supabase-js (UMD, expose window.supabase)
 *   - window.CLOUD_CONFIG = { url, key }
 *
 * API exposée (window.Cloud) :
 *   available()            → bool (lib + config présentes)
 *   init()                 → crée le client, branche l'écoute d'auth
 *   onChange(cb)           → cb(user|null) à chaque changement de session
 *   getUser()              → user courant (ou null)
 *   signIn(email)          → envoie le lien magique
 *   signOut()              → déconnecte
 *   fetchGames()           → [{game_id, raw, me, opp_hero, format, captured_at}]
 *   createPairing(label)   → { token } (appairage 1-clic du grabber, phase 2)
 * ============================================================ */
(function (root) {
  'use strict';

  let client = null;
  let currentUser = null;
  const listeners = [];

  function cfg() { return root.CLOUD_CONFIG || null; }
  function available() {
    return !!(root.supabase && root.supabase.createClient && cfg() && cfg().url && cfg().key);
  }

  // URL de retour du lien magique : la page courante SANS le hash (le hash
  // sert aux liens profonds #game=… et au jeton renvoyé par Supabase).
  function redirectTo() {
    return location.origin + location.pathname + location.search;
  }

  function notify() { listeners.forEach(cb => { try { cb(currentUser); } catch (e) { console.error(e); } }); }

  function init() {
    if (client || !available()) return client;
    client = root.supabase.createClient(cfg().url, cfg().key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    // État initial + écoute des changements (connexion via lien, déconnexion,
    // rafraîchissement du jeton…).
    client.auth.getSession().then(({ data }) => {
      currentUser = (data && data.session && data.session.user) || null;
      notify();
    });
    client.auth.onAuthStateChange((_event, session) => {
      currentUser = (session && session.user) || null;
      notify();
    });
    return client;
  }

  function onChange(cb) { if (typeof cb === 'function') { listeners.push(cb); cb(currentUser); } }
  function getUser() { return currentUser; }

  async function signIn(email) {
    if (!available()) throw new Error('Cloud indisponible (config manquante).');
    init();
    const { error } = await client.auth.signInWithOtp({
      email: String(email || '').trim(),
      options: { emailRedirectTo: redirectTo() }
    });
    if (error) throw error;
    return true;
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
    currentUser = null;
    notify();
  }

  // Lecture des parties de l'utilisateur connecté. La RLS garantit qu'on ne
  // reçoit QUE les siennes — pas besoin de filtrer par user_id côté client.
  async function fetchGames() {
    if (!client || !currentUser) return [];
    const { data, error } = await client
      .from('games')
      .select('game_id, raw, me, opp_hero, format, captured_at')
      .order('captured_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // Appairage du grabber (phase 2) : génère un jeton d'appareil aléatoire et
  // l'enregistre. La RLS (insert_own) garantit qu'il est lié à CET utilisateur.
  async function createPairing(label) {
    if (!client || !currentUser) throw new Error('Non connecté.');
    const token = randomToken();
    // user_id explicite : la policy RLS (insert) vérifie auth.uid() = user_id ;
    // sans lui, la ligne (user_id NULL) est refusée.
    const { error } = await client.from('device_tokens').insert({ token, user_id: currentUser.id, label: label || null });
    if (error) throw error;
    return { token };
  }

  // Migration : envoie une liste de parties locales vers le compte. L'app est
  // authentifiée → insertion directe dans `games` (RLS insert_own : user_id =
  // auth.uid()). Upsert par lots, dédup par (user_id, game_id) → réexécutable
  // sans créer de doublon. `list` = [{game_id, raw, me, opp_hero, format, captured_at}].
  async function uploadGames(list) {
    if (!client || !currentUser) throw new Error('Non connecté.');
    const rows = (list || [])
      .map(g => ({
        user_id: currentUser.id,
        game_id: String(g.game_id || ''),
        raw: g.raw,
        me: g.me || null,
        opp_hero: g.opp_hero || null,
        format: g.format || null,
        captured_at: g.captured_at || null
      }))
      .filter(r => r.raw && /^\d+$/.test(r.game_id));   // ids non numériques ignorés
    let done = 0;
    const CHUNK = 20;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const batch = rows.slice(i, i + CHUNK);
      const { error } = await client.from('games').upsert(batch, { onConflict: 'user_id,game_id' });
      if (error) throw error;
      done += batch.length;
    }
    return done;
  }

  // Supprime UNE partie du compte (RLS delete_own). Utilisé quand on supprime
  // une partie dans la bibliothèque, pour que ça se propage à tous les appareils.
  async function deleteGame(gameId) {
    if (!client || !currentUser) return false;
    const { error } = await client.from('games').delete()
      .eq('user_id', currentUser.id).eq('game_id', String(gameId));
    if (error) throw error;
    return true;
  }

  // RGPD : supprime le compte + toutes les données (via l'Edge Function
  // delete-account, qui appelle l'API admin ; cascade sur games/device_tokens).
  async function deleteAccount() {
    if (!client || !currentUser) throw new Error('Non connecté.');
    const { data, error } = await client.functions.invoke('delete-account', { method: 'POST' });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error + (data.detail ? ' — ' + data.detail : ''));
    try { await client.auth.signOut(); } catch (e) {}
    currentUser = null; notify();
    return true;
  }

  function randomToken() {
    const a = new Uint8Array(24);
    (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = (i * 40503) & 255);
    return 'dt_' + Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  root.Cloud = { available, init, onChange, getUser, signIn, signOut, fetchGames, createPairing, uploadGames, deleteGame, deleteAccount };
})(typeof self !== 'undefined' ? self : this);
