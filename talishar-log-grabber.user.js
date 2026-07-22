// ==UserScript==
// @name         Talishar Log Grabber
// @namespace    camille.fab.tools
// @version      1.15.3
// @description  Capture le log COMPLET des parties Talishar + snapshots main/arsenal/terrain(permanents·tokens des 2 joueurs)/vie/deck à chaque tour + bloc META (héros, format, équipements, pseudos). v1.8 : lit directement le store Redux de Talishar via les fibres React (données exactes, plus de dépendance aux classes CSS), fallback DOM si indisponible. v1.10 : envoi direct de la partie dans le dépôt GitHub (Phase 3, API en CORS). v1.11 : capture des permanents/tokens en jeu (playerX.Permanents/Effects) pour les deux camps. v1.13 : @match sur tout le site + widget limité aux pages de partie — corrige la non-injection quand on charge Talishar sur la page d'accueil (SPA). Export texte / téléchargement + localStorage.
// @author       ColinCamille
// @match        *://talishar.net/*
// @match        *://www.talishar.net/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/ColinCamille/Fab-replay/main/talishar-log-grabber.user.js
// @updateURL    https://raw.githubusercontent.com/ColinCamille/Fab-replay/main/talishar-log-grabber.user.js
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.15.3';
  console.log('%c[TLG] userscript v' + VERSION + ' chargé — Alt+Shift+D = télécharger, Alt+Shift+C = copier, Alt+Shift+S = envoyer au compte, Alt+Shift+X = réduire',
              'color:#c9a227;font-weight:bold');

  const POLL_MS = 500;
  const LS_PREFIX = 'taliLog_';
  const LS_HAND_PREFIX = 'taliHand_';
  const LS_ARSENAL_PREFIX = 'taliArsenal_';
  const LS_OPPARS_PREFIX = 'taliOppArs_';
  const LS_FIELD_PREFIX = 'taliField_';
  const LS_GRAVE_PREFIX = 'taliGrave_';
  const LS_BANISH_PREFIX = 'taliBanish_';
  const LS_LIFE_PREFIX = 'taliLife_';
  const LS_META_PREFIX = 'taliMeta_';
  const LS_TS_PREFIX = 'taliTs_';
  const LS_ENDSTATS_PREFIX = 'taliEnd_';
  const LS_CHAIN_PREFIX = 'taliChain_';
  const FORCE_SELECTOR = '';

  let captured = [];
  let lastVisibleSig = '';
  let gameName = '';
  let boxLogged = false;
  let storeLogged = false;
  let logSource = 'dom';        // 'chatlog' (journal structuré) ou 'dom' (repli)
  let chatLogAdopted = false;   // a-t-on déjà basculé cette partie sur le chatLog ?
  let lastRawChatLog = null;    // dernier chatLog BRUT (verbatim) vu → conservé dans l'export
  let canaryIssues = [];        // hypothèses Talishar cassées détectées à la capture

  let handSnapshots = {};
  let arsenalSnapshots = {};
  let oppArsenalSnapshots = {};  // clé tour -> nombre de cartes en arsenal ADVERSE (face cachée : compte seul, jamais le nom)
  let fieldSnapshots = {};  // clé tour -> { me: [noms], opp: [noms] } (permanents/tokens en jeu)
  let graveSnapshots = {};  // clé tour -> { me, opp } (cimetière, zone publique)
  let banishSnapshots = {}; // clé tour -> { me, opp } (banni, zone publique)
  let lifeSnapshots = {};   // clé tour -> { me, opp, myDeck, oppDeck }
  let chainLinks = [];      // combats : [{turn, card, power, defense, prevent, target, kw:[]}] — attaque/défense EFFECTIVES (buffs compris), lues dans activeChainLink
  let pendingChain = null;  // lien de combat en cours de construction (figé quand la chaîne se ferme)
  let tsBatches = [];       // [{from, to, t}] : lignes captured[from..to] vues à l'epoch t (s)
  let meta = {};
  let endStats = null;       // { myPlayerID, byPlayer: {1:{...},2:{...}} } — stats officielles Talishar
  let endStatsLogged = false;
  let lastTurnKey = null;
  let openingSnapped = false;
  let autoPushedFor = null;  // gameName déjà auto-envoyé au dépôt (évite les doublons)
  let autoPushedCount = 0;   // nb de camps de stats déjà auto-envoyés (re-envoi si ↑)

  function now() { return Math.floor(Date.now() / 1000); }

  function currentGameName() {
    const m = location.pathname.match(/\/game\/play\/(\d+)/)
           || location.pathname.match(/(\d{5,})/);
    return m ? m[1] : 'unknown';
  }

  // Depuis v1.13, @match couvre tout le site (pour être injecté dès la page
  // d'accueil, Talishar étant une SPA). On restreint la capture ET le widget
  // aux pages de partie — comportement visible identique aux versions ≤ 1.12,
  // et pas de faux gameId tiré d'un nombre présent dans une autre URL.
  function onGamePage() { return /\/game\//.test(location.pathname); }

  // ============================================================
  // ACCÈS AU STORE REDUX (v1.8)
  // ------------------------------------------------------------
  // Talishar monte son app avec <Provider store={store}> (react-redux).
  // Depuis un userscript, on retrouve le store en remontant les fibres
  // React (__reactFiber$/__reactContainer$) jusqu'à l'élément Provider,
  // dont les props contiennent le store. Données exactes garanties :
  // state.game.playerOne = TOI, state.game.playerTwo = adversaire,
  // state.game.gameInfo = format, héros, turnNo, etc.
  // ============================================================
  let reduxStore = null;

  function findReduxStore() {
    if (reduxStore) return reduxStore;
    const root = document.getElementById('root') || document.body;
    if (!root) return null;
    const nodes = [root].concat(Array.from(root.querySelectorAll('*')).slice(0, 200));
    for (const node of nodes) {
      const fiberKey = Object.keys(node).find(k =>
        k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
      if (!fiberKey) continue;
      let fiber = node[fiberKey];
      let hops = 0;
      while (fiber && hops < 100) {
        const props = fiber.memoizedProps || fiber.pendingProps;
        const st = props && props.store;
        if (st && typeof st.getState === 'function') {
          reduxStore = st;
          if (!storeLogged) { console.log('[TLG] store Redux connecté ✔'); storeLogged = true; }
          return reduxStore;
        }
        fiber = fiber.return;
        hops++;
      }
    }
    return null;
  }

  function getGameState() {
    try {
      const store = findReduxStore();
      if (!store) return null;
      const s = store.getState();
      return (s && s.game) ? s.game : null;
    } catch (e) { return null; }
  }

  function getRootState() {
    try { const store = findReduxStore(); return store ? store.getState() : null; }
    catch (e) { return null; }
  }

  // Stats de fin de partie : Talishar les récupère via l'API GetPopupAPI
  // (popupType "myStatsPopup") et RTK Query les met en cache dans le store à
  // state.api.queries. On les lit là — pas de requête réseau supplémentaire,
  // pas d'URL backend à deviner. Elles n'existent qu'une fois le Game Summary
  // ouvert en fin de partie (c'est ce qui déclenche l'appel côté Talishar).
  function captureEndGameStats() {
    const s = getRootState();
    if (!s || !s.api || !s.api.queries) return;
    const queries = s.api.queries;
    const myPlayerID = (s.game && s.game.gameInfo && s.game.gameInfo.playerID) || null;
    let found = null;
    for (const key of Object.keys(queries)) {
      const entry = queries[key];
      if (!entry || entry.endpointName !== 'getPopUpContent') continue;
      if (entry.status !== 'fulfilled' || !entry.data) continue;
      const d = entry.data;
      // reconnait le bon popup : présence de stats de partie
      const looksLikeStats = d && (d.turnResults || d.totalDamageDealt != null || d.cardResults);
      if (!looksLikeStats) continue;
      const args = entry.originalArgs || {};
      const popup = args.popupType || (/myStatsPopup/.test(key) ? 'myStatsPopup' : null);
      if (popup && popup !== 'myStatsPopup') continue;
      // identifie le joueur concerné
      let pid = args.playerID != null ? args.playerID : (d.playerID != null ? d.playerID : null);
      if (pid == null) { const m = key.match(/"playerID":(\d+)/); if (m) pid = Number(m[1]); }
      if (pid == null) pid = myPlayerID || 1;
      if (!found) found = { myPlayerID, byPlayer: {} };
      found.byPlayer[pid] = d;
    }
    if (found && Object.keys(found.byPlayer).length) {
      endStats = found;
      if (!endStatsLogged) {
        console.log('[TLG] stats de fin de partie captées ✔ (joueurs: ' + Object.keys(found.byPlayer).join(', ') + ')');
        endStatsLogged = true;
      }
      // Auto-envoi au dépôt (si activé). Se déclenche à l'apparition des stats
      // (tes stats à l'ouverture du Game Summary), puis se RE-déclenche si les
      // stats de l'adversaire arrivent ensuite (après le swap) → le dépôt reçoit
      // la version complète, sans clic. Le garde est posé AVANT l'appel async
      // pour éviter les doublons entre deux ticks.
      // Envoi AUTO vers le COMPTE (Supabase) dès que le compte est appairé.
      // L'envoi GitHub (héritage) a été retiré : tout passe par le compte privé.
      if (sbConfigured()) {
        const nPlayers = Object.keys(found.byPlayer).length;
        if (autoPushedFor !== gameName || nPlayers > autoPushedCount) {
          autoPushedFor = gameName;
          autoPushedCount = nPlayers;
          console.log('[TLG] auto-envoi compte (' + nPlayers + ' camp(s) de stats)');
          pushGameToSupabase(true);
        }
      }
    }
  }

  // L'API Talishar renvoie certains nombres en string ("20") : on coerce.
  function asNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
    return null;
  }

  function cardLabel(card) {
    if (!card) return null;
    if (card.cardName) return card.cardName;
    if (card.cardNumber && card.cardNumber !== 'CardBack') return card.cardNumber;
    return null;
  }
  function cardLabelWithId(card) {
    if (!card) return null;
    const name = cardLabel(card);
    if (!name) return null;
    return (card.cardName && card.cardNumber && card.cardNumber !== 'CardBack')
      ? name + ' (' + card.cardNumber + ')' : name;
  }
  // NB : pas de déduplication par nom ici — chaque entrée du tableau
  // Hand/Arsenal est une carte physique distincte. Avoir deux fois
  // "Static Shock" en main est un cas normal (deux copies de la même
  // carte), et doit ressortir comme deux entrées, pas une seule.
  function cardListNames(cards) {
    if (!Array.isArray(cards)) return [];
    const out = [];
    cards.forEach(c => { const n = cardLabel(c); if (n) out.push(n); });
    return out;
  }

  // ============================================================
  // LOG (inchangé, + timestamps sur les batches fusionnés)
  // ============================================================
  function findLogBox() {
    if (FORCE_SELECTOR) return document.querySelector(FORCE_SELECTOR);
    const all = Array.from(document.querySelectorAll('[class*="chatBox"]'));
    let candidates = all.filter(el => {
      const c = el.className || '';
      return /chatBox/i.test(c) && !/Container/i.test(c) && !/Inner/i.test(c);
    });
    if (!candidates.length) candidates = all;
    candidates.sort((a, b) => b.childElementCount - a.childElementCount);
    return candidates[0] || null;
  }

  // Ligne condensée d'une chaîne repliée : quand une chaîne se résout, Talishar
  // remplace ses lignes détaillées par UN résumé collé « Chain Link N<joueur>
  // played …🎯…took N damage… » (sans séparateur). C'est un RE-RENDU de lignes
  // déjà captées en détaillé → illisible pour le parseur ET source de doublons.
  // On l'ignore à la lecture (les vraies parties n'en contiennent jamais).
  const CONDENSED_CHAIN_RE = /^Chain Link \d+/;
  function readVisibleLines(box) {
    return Array.from(box.children)
      .map(c => (c.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(l => l && !CONDENSED_CHAIN_RE.test(l));
  }

  // ── Lecture DIRECTE du journal structuré (state.game.chatLog) ──────────────
  // Talishar tient le journal dans un tableau d'état : chaque entrée y figure
  // UNE seule fois. Le panneau DOM, lui, se re-rend en entier à chaque action
  // (source de la duplication géante des logs). On lit donc ce tableau EN
  // PRIORITÉ. Deux traductions suffisent pour retomber pile sur le format que
  // le parseur attend déjà (celui du rendu DOM de Talishar) :
  //   · « Player N »            → nom du héros (substitution que fait Talishar) ;
  //   · « [[TURN_START:n:p]] »  → « <héros>'s turn n has begun. ».
  // Le n° de tour de Talishar est repris tel quel (l'ouverture n'a pas de
  // marqueur → le parseur la place en « Ouverture », comme pour un log normal).
  const TURN_START_RE = /\[\[TURN_START:(\d+):(\d+)\]\]/;
  function stripHtmlText(x) {
    return String(x == null ? '' : x).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }
  function heroCardOf(pl) {
    if (!pl) return null;
    const h = pl.Hero;
    return Array.isArray(h) ? h[0] : h;
  }
  // PURE (testable en Node) : chatLog brut + noms de héros par n° de joueur de
  // partie (1/2) → lignes texte au format attendu par le parseur.
  function chatLogToLines(rawChatLog, name1, name2) {
    if (!Array.isArray(rawChatLog)) return [];
    const out = [];
    for (const raw of rawChatLog) {
      const txt = stripHtmlText(raw);
      if (!txt) continue;
      const tm = txt.match(TURN_START_RE);
      if (tm) {
        const nm = tm[2] === '1' ? name1 : (tm[2] === '2' ? name2 : null);
        // Sans nom résolu on garde une forme que matchTurnHeader reconnaît quand
        // même (séparateur « Turn n<joueur> ») plutôt que de perdre le tour.
        out.push(nm ? (nm + "'s turn " + tm[1] + ' has begun.') : ('Turn ' + tm[1] + 'Player ' + tm[2]));
        continue;
      }
      let line = txt;
      if (name1) line = line.split('Player 1').join(name1);
      if (name2) line = line.split('Player 2').join(name2);
      out.push(line);
    }
    return out;
  }
  // Lit le journal structuré du store et le traduit ; null si indisponible.
  // Le mapping « Player N » → héros passe par gameInfo.playerID : playerOne du
  // store est le joueur LOCAL (celui dont on voit la perspective), pas forcément
  // « Player 1 » côté partie.
  function readChatLogLines() {
    const g = getGameState();
    if (!g || !Array.isArray(g.chatLog) || !g.chatLog.length) return null;
    const gi = g.gameInfo || {};
    const myNum = Number(gi.playerID) === 2 ? 2 : 1;
    const myHero = cardLabel(heroCardOf(g.playerOne));
    const oppHero = cardLabel(heroCardOf(g.playerTwo));
    // MIROIR (mêmes héros) : « Player 1 » et « Player 2 » deviendraient tous deux
    // « Aurora » → le parseur ne peut plus distinguer les camps (tours, vie et
    // même le VAINQUEUR se mélangent). On désambiguïse avec les PSEUDOS (distincts)
    // ; à défaut on suffixe le n° de joueur (« Aurora J1 » / « Aurora J2 »), en
    // gardant des caractères que le parseur reconnaît (pas de parenthèses).
    let meLabel = myHero, oppLabel = oppHero;
    const same = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase();
    if (same(myHero, oppHero)) {
      const myUser = g.playerOne && g.playerOne.Name, oppUser = g.playerTwo && g.playerTwo.Name;
      if (myUser && oppUser && !same(myUser, oppUser)) { meLabel = myUser; oppLabel = oppUser; }
      else { meLabel = myHero + ' J' + myNum; oppLabel = oppHero + ' J' + (myNum === 1 ? 2 : 1); }
    }
    const name1 = myNum === 1 ? meLabel : oppLabel;
    const name2 = myNum === 2 ? meLabel : oppLabel;
    lastRawChatLog = g.chatLog;                 // source PURE conservée (verbatim)
    runCanary(g, name1, name2);                 // Talishar a-t-il changé de format ?
    // Sans les DEUX noms de héros, la substitution « Player N » serait bancale →
    // on préfère retomber sur le DOM qu'émettre un log à moitié mappé.
    if (!name1 || !name2) return null;
    return chatLogToLines(g.chatLog, name1, name2);
  }

  // Canari : vérifie à la CAPTURE que les hypothèses sur l'état Talishar tiennent
  // toujours. But : être prévenu le JOUR où Talishar change quelque chose (message
  // dans le widget), avec le chatLog brut conservé pour déboguer — au lieu de le
  // découvrir des semaines plus tard sur une stat bizarre.
  function runCanary(g, name1, name2) {
    const issues = [];
    const gi = g.gameInfo || {};
    if (gi.playerID == null) issues.push('gameInfo.playerID absent');
    // Marqueur de tour : PLUSIEURS fins de tour SANS aucun [[TURN_START]] ⇒ le
    // format du marqueur a changé. On exige >= 2 fins (une seule = simple bord de
    // tour transitoire au moment de la capture, PAS une anomalie) → évite le faux
    // positif en début de partie / menu de sélection d'équipement. Le nom de héros
    // manquant n'est PAS signalé ici : c'est transitoire (adversaire pas encore
    // chargé), et readChatLogLines retombe déjà sur le DOM dans ce cas.
    const strip = x => String(x == null ? '' : x).replace(/<[^>]+>/g, '');
    let ends = 0, starts = 0;
    for (const e of g.chatLog) { const t = strip(e); if (/Attempting to end turn/.test(t)) ends++; if (TURN_START_RE.test(t)) starts++; }
    if (ends >= 2 && starts === 0) issues.push('marqueur de début de tour [[TURN_START]] introuvable (format changé ?)');
    canaryIssues = issues;
    if (issues.length && !runCanary._warned) {
      runCanary._warned = true;
      console.warn('[TLG] ⚠ hypothèses Talishar cassées :', issues.join(' · '));
    }
  }

  function recordTsBatch(fromIdx, toIdx) {
    if (toIdx < fromIdx) return;
    const t = now();
    const last = tsBatches[tsBatches.length - 1];
    if (last && last.t === t && last.to === fromIdx - 1) { last.to = toIdx; return; }
    tsBatches.push({ from: fromIdx, to: toIdx, t });
  }

  // Fusion PURE (testable en Node) d'un instantané `visible` du panneau de log
  // dans l'accumulé `captured`. Renvoie { lines, from } où `from` est l'indice
  // de départ du NOUVEAU contenu (pour l'horodatage), ou -1 si rien ajouté.
  //
  // Le panneau peut être rendu de deux façons selon Talishar :
  //   · FENÊTRE glissante : `visible` = dernières lignes → sa TÊTE recouvre la
  //     QUEUE de `captured` (cas historique) ;
  //   · JOURNAL COMPLET re-rendu à chaque action (parfois avec chaînes repliées)
  //     → `visible` recommence au MÊME début que `captured`.
  // L'ancien code ne gérait que le 1er cas : sur le 2e, faute de chevauchement
  // queue/tête, il RÉ-EMPILAIT tout le journal à chaque poll → logs géants
  // dupliqués (parties illisibles). On détecte donc le re-rendu complet et on
  // adopte le rendu le plus complet au lieu de le concaténer.
  function mergeLines(captured, visible) {
    if (!visible.length) return { lines: captured, from: -1 };
    if (!captured.length) return { lines: visible.slice(), from: 0 };
    // Cas 1 — fenêtre glissante : queue(captured) == tête(visible).
    const maxK = Math.min(captured.length, visible.length);
    for (let k = maxK; k > 0; k--) {
      let ok = true;
      for (let i = 0; i < k; i++) {
        if (captured[captured.length - k + i] !== visible[i]) { ok = false; break; }
      }
      if (ok) {
        const added = visible.slice(k);
        return added.length ? { lines: captured.concat(added), from: captured.length } : { lines: captured, from: -1 };
      }
    }
    // Cas 2 — re-rendu complet (même 1re ligne) : on ADOPTE le plus complet,
    // jamais on ne ré-empile (sinon duplication de tout l'historique).
    if (visible[0] === captured[0]) {
      return visible.length > captured.length ? { lines: visible.slice(), from: captured.length } : { lines: captured, from: -1 };
    }
    // Cas 3 — contenu réellement disjoint (ex. début décalé par un repli en
    // tête) : on ajoute.
    return { lines: captured.concat(visible), from: captured.length };
  }

  function merge(visible) {
    const r = mergeLines(captured, visible);
    captured = r.lines;
    if (r.from >= 0 && r.from <= captured.length - 1) recordTsBatch(r.from, captured.length - 1);
  }

  // ============================================================
  // PERSISTANCE
  // ============================================================
  function save() {
    try {
      localStorage.setItem(LS_PREFIX + gameName, JSON.stringify(captured));
      localStorage.setItem(LS_HAND_PREFIX + gameName, JSON.stringify(handSnapshots));
      localStorage.setItem(LS_ARSENAL_PREFIX + gameName, JSON.stringify(arsenalSnapshots));
      localStorage.setItem(LS_OPPARS_PREFIX + gameName, JSON.stringify(oppArsenalSnapshots));
      localStorage.setItem(LS_FIELD_PREFIX + gameName, JSON.stringify(fieldSnapshots));
      localStorage.setItem(LS_GRAVE_PREFIX + gameName, JSON.stringify(graveSnapshots));
      localStorage.setItem(LS_BANISH_PREFIX + gameName, JSON.stringify(banishSnapshots));
      localStorage.setItem(LS_LIFE_PREFIX + gameName, JSON.stringify(lifeSnapshots));
      localStorage.setItem(LS_META_PREFIX + gameName, JSON.stringify(meta));
      localStorage.setItem(LS_TS_PREFIX + gameName, JSON.stringify(tsBatches));
      localStorage.setItem(LS_CHAIN_PREFIX + gameName, JSON.stringify(chainLinks));
      if (endStats) localStorage.setItem(LS_ENDSTATS_PREFIX + gameName, JSON.stringify(endStats));
    } catch (e) {}
  }
  function loadExisting() {
    const read = (key, fallback) => {
      try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) || fallback) : fallback; }
      catch (e) { return fallback; }
    };
    captured = read(LS_PREFIX + gameName, []);
    handSnapshots = read(LS_HAND_PREFIX + gameName, {});
    arsenalSnapshots = read(LS_ARSENAL_PREFIX + gameName, {});
    oppArsenalSnapshots = read(LS_OPPARS_PREFIX + gameName, {});
    fieldSnapshots = read(LS_FIELD_PREFIX + gameName, {});
    graveSnapshots = read(LS_GRAVE_PREFIX + gameName, {});
    banishSnapshots = read(LS_BANISH_PREFIX + gameName, {});
    lifeSnapshots = read(LS_LIFE_PREFIX + gameName, {});
    meta = read(LS_META_PREFIX + gameName, {});
    tsBatches = read(LS_TS_PREFIX + gameName, []);
    chainLinks = read(LS_CHAIN_PREFIX + gameName, []); pendingChain = null;
    endStats = read(LS_ENDSTATS_PREFIX + gameName, null);
  }

  // ============================================================
  // EXTRACTION — Redux d'abord, DOM en secours (héritage v1.7)
  // ============================================================
  function slugToName(filename) {
    let s = filename.replace(/\.(webp|png|jpe?g)(\?.*)?$/i, '');
    s = s.replace(/_(red|yellow|blue)$/i, '');
    return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  // Même remarque que cardListNames : pas de dédoublonnage par nom, chaque
  // <img> correspond à une carte physique distincte dans la zone.
  function extractZoneCardsDOM(selector) {
    const imgs = Array.from(document.querySelectorAll(selector));
    const names = [];
    imgs.forEach(im => {
      const src = im.getAttribute('src') || '';
      const file = src.split('/').pop().split('?')[0];
      if (!file || /cardback/i.test(file)) return;
      names.push(slugToName(file));
    });
    return names;
  }

  function extractMyHandCards() {
    const g = getGameState();
    if (g && g.playerOne && Array.isArray(g.playerOne.Hand)) {
      const names = cardListNames(g.playerOne.Hand);
      if (names.length) return names;
    }
    // Fallback DOM (cascade v1.7)
    for (const sel of [
      '[class*="playerHand_" i] img, [class*="handRow" i] img',
      '[class*="handZone_" i][class*="isPlayer" i] img',
      '[class*="pOneHands_" i] img'
    ]) {
      const cards = extractZoneCardsDOM(sel);
      if (cards.length) return cards;
    }
    return [];
  }

  function extractMyArsenal() {
    const g = getGameState();
    if (g && g.playerOne && Array.isArray(g.playerOne.Arsenal)) {
      return cardListNames(g.playerOne.Arsenal);
    }
    return extractZoneCardsDOM('[class*="pOneArsenal_" i] img');
  }

  // Arsenal ADVERSE : la carte y est FACE CACHÉE → Talishar ne révèle jamais son
  // nom. On ne capte donc QUE le NOMBRE de cartes (0 ou 1), information publique,
  // pour afficher un dos de carte sur le plateau. Redux prioritaire, repli DOM.
  function extractOppArsenalCount() {
    const g = getGameState();
    if (g && g.playerTwo && Array.isArray(g.playerTwo.Arsenal)) return g.playerTwo.Arsenal.length;
    return document.querySelectorAll('[class*="pTwoArsenal_" i] img').length;
  }

  // Permanents / tokens en jeu (arène). Zone PUBLIQUE → on lit les DEUX joueurs.
  // Talishar range alliés / items / auras / tokens (ex. Embodiment of Lightning)
  // dans playerX.Permanents (parfois Effects). On renvoie les noms par camp.
  function permanentsOf(player) {
    const out = [];
    if (!player) return out;
    ['Permanents', 'Effects'].forEach(zone => {
      if (Array.isArray(player[zone])) player[zone].forEach(c => { const n = cardLabel(c); if (n) out.push(n); });
    });
    return out;
  }
  function extractField() {
    const g = getGameState();
    if (!g) return null;
    return { me: permanentsOf(g.playerOne), opp: permanentsOf(g.playerTwo) };
  }

  // Cimetière / banni : zones PUBLIQUES → lisibles pour les deux joueurs.
  function zoneNamesOf(player, zone) {
    return (player && Array.isArray(player[zone])) ? cardListNames(player[zone]) : [];
  }
  function extractTwoCamp(zone) {
    const g = getGameState();
    if (!g) return null;
    return { me: zoneNamesOf(g.playerOne, zone), opp: zoneNamesOf(g.playerTwo, zone) };
  }

  function extractLife() {
    const g = getGameState();
    const out = { me: null, opp: null, myDeck: null, oppDeck: null };
    if (g) {
      if (g.playerOne) {
        const h = asNum(g.playerOne.Health); if (h != null) out.me = h;
        const d = asNum(g.playerOne.DeckSize); if (d != null) out.myDeck = d;
      }
      if (g.playerTwo) {
        const h = asNum(g.playerTwo.Health); if (h != null) out.opp = h;
        const d = asNum(g.playerTwo.DeckSize); if (d != null) out.oppDeck = d;
      }
      if (out.me != null || out.opp != null) return out;
    }
    // Fallback DOM : widget central, [adversaire, toi] dans cet ordre
    const widget = document.querySelector('[class*="healthWidget" i], [class*="healthContainer" i]');
    if (widget) {
      const vals = Array.from(widget.querySelectorAll('[class*="health" i]'))
        .map(el => (el.innerText || '').trim())
        .map(t => { const m = t.match(/-?\d+/); return m ? parseInt(m[0], 10) : null; })
        .filter(v => v !== null);
      if (vals.length >= 2) { out.opp = vals[0]; out.me = vals[vals.length - 1]; }
      else if (vals.length === 1) { out.me = vals[0]; }
    }
    return out;
  }

  const EQ_FIELDS = [
    ['head', 'HeadEq'], ['chest', 'ChestEq'], ['arms', 'ArmsEq'],
    ['legs', 'LegsEq'], ['weaponL', 'WeaponLEq'], ['weaponR', 'WeaponREq']
  ];
  function extractEquipment(player) {
    const out = {};
    if (!player) return out;
    EQ_FIELDS.forEach(([key, field]) => {
      const label = cardLabelWithId(player[field]);
      if (label) out[key] = label;
    });
    return out;
  }

  // ============================================================
  // META : rempli progressivement, Redux d'abord.
  // ============================================================
  function maybeFillMeta() {
    if (!meta.captureVersion) meta.captureVersion = VERSION;
    if (!meta.capturedAt) meta.capturedAt = new Date().toISOString();
    // URL : on préfère la page de jeu à celle du lobby
    if (!meta.gameUrl || (/\/game\/play\//.test(location.pathname) && !/\/game\/play\//.test(meta.gameUrl))) {
      meta.gameUrl = location.href;
    }

    // Résolution des pseudos depuis le LOG (source la plus fiable) : le jet
    // de dé nomme explicitement l'adversaire et utilise "you" pour le joueur
    // local. Ça prime sur Redux/DOM, qui peuvent (rarement) capturer deux fois
    // le même nom. On complète aussi avec les en-têtes de tour.
    (function resolveNamesFromLog() {
      let oppFromRoll = null;
      const headerNames = [];
      for (const line of captured) {
        if (!oppFromRoll) {
          let m = line.match(/^🎲\s*(.+?) rolled \d+ and you rolled \d+/);
          if (m) oppFromRoll = m[1].trim();
          else { m = line.match(/^🎲\s*you rolled \d+ and (.+?) rolled \d+/); if (m) oppFromRoll = m[1].trim(); }
        }
        const h = line.match(/^(.+?)'s turn \d+ has begun\.$/);
        if (h && headerNames.indexOf(h[1].trim()) < 0) headerNames.push(h[1].trim());
      }
      if (oppFromRoll) {
        meta.oppName = oppFromRoll;                         // adversaire : autorité
        const other = headerNames.find(n => n !== oppFromRoll);
        if (other) meta.myName = other;                    // moi : l'autre en-tête
      }
    })();

    const g = getGameState();
    if (g) {
      const gi = g.gameInfo || {};
      if (!meta.format && gi.gameFormat) meta.format = gi.gameFormat;
      if (meta.isOpponentAI == null && typeof gi.isOpponentAI === 'boolean') meta.isOpponentAI = gi.isOpponentAI;

      if (!meta.myHero) {
        if (gi.heroName) meta.myHero = gi.heroName + (gi.yourHeroCardNumber ? ' (' + gi.yourHeroCardNumber + ')' : '');
        else if (g.playerOne && g.playerOne.Hero) meta.myHero = cardLabelWithId(g.playerOne.Hero);
      }
      if (!meta.oppHero) {
        if (gi.opponentHeroName) meta.oppHero = gi.opponentHeroName + (gi.opponentHeroCardNumber ? ' (' + gi.opponentHeroCardNumber + ')' : '');
        else if (g.playerTwo && g.playerTwo.Hero) meta.oppHero = cardLabelWithId(g.playerTwo.Hero);
      }

      // Redux ne comble que les trous, et jamais au prix de deux noms égaux.
      if (!meta.myName && g.playerOne && g.playerOne.Name && g.playerOne.Name !== meta.oppName) meta.myName = g.playerOne.Name;
      if (!meta.oppName && g.playerTwo && g.playerTwo.Name && g.playerTwo.Name !== meta.myName) meta.oppName = g.playerTwo.Name;


      if (meta.myStartLife == null || meta.oppStartLife == null
          || meta.myStartDeckSize == null || meta.oppStartDeckSize == null) {
        const l = extractLife();
        if (meta.myStartLife == null && l.me != null) meta.myStartLife = l.me;
        if (meta.oppStartLife == null && l.opp != null) meta.oppStartLife = l.opp;
        if (meta.myStartDeckSize == null && l.myDeck != null && l.myDeck > 0) meta.myStartDeckSize = l.myDeck;
        if (meta.oppStartDeckSize == null && l.oppDeck != null && l.oppDeck > 0) meta.oppStartDeckSize = l.oppDeck;
      }

      // Équipement de départ : on fige le premier relevé par slot
      // (une pièce détruite disparaît de l'état ensuite).
      meta.myEquipment = meta.myEquipment || {};
      meta.oppEquipment = meta.oppEquipment || {};
      const meEq = extractEquipment(g.playerOne), opEq = extractEquipment(g.playerTwo);
      Object.keys(meEq).forEach(k => { if (!meta.myEquipment[k]) meta.myEquipment[k] = meEq[k]; });
      Object.keys(opEq).forEach(k => { if (!meta.oppEquipment[k]) meta.oppEquipment[k] = opEq[k]; });
    }

    // Fallback DOM pour les pseudos si Redux indisponible (jamais deux égaux)
    if (!meta.myName || !meta.oppName) {
      const els = Array.from(document.querySelectorAll('[class*="playerName_" i]'));
      const texts = [];
      els.forEach(el => {
        const t = (el.innerText || '').trim().split('\n')[0].trim();
        if (t && t.length <= 40 && !texts.includes(t)) texts.push(t);
      });
      if (texts.length >= 2) {
        if (!meta.oppName && texts[0] !== meta.myName) meta.oppName = texts[0];
        if (!meta.myName && texts[1] !== meta.oppName) meta.myName = texts[1];
      }
    }
  }

  // ============================================================
  // SNAPSHOTS PAR TOUR (main + arsenal + vie/deck)
  // ============================================================
  const TURN_HEADER_RE = /^(.+?)'s turn (\d+) has begun\.$/;
  function maybeSnapshotState() {
    // Snapshot d'OUVERTURE : on garde la PLUS GRANDE main observée AVANT toute
    // action, puis on FIGE dès la 1re baisse de main (1er play/pitch/bloc) ou la
    // 1re fin de tour. Sinon, quand TU commences (pas d'en-tête « ton tour 1 »
    // avant ton tour 0), la fenêtre s'étendait jusqu'à ta re-pioche de fin de
    // tour et capturait la main du tour 1 (cartes en trop). On fige donc avant
    // la re-pioche. `openingSnapped` sert de verrou (réinitialisé au changement
    // de partie).
    if (!openingSnapped && captured.length > 0) {
      const endedTurn = captured.some(l => /Attempting to end turn/.test(l));
      const hand = extractMyHandCards();
      const prev = handSnapshots['__opening__'] || [];
      if (endedTurn) {
        openingSnapped = true;                              // fin de tour → fige (avant la re-pioche)
      } else if (hand.length > prev.length) {
        handSnapshots['__opening__'] = hand;                // la main grandit encore (rendu / pioche d'ouverture)
        arsenalSnapshots['__opening__'] = extractMyArsenal();
        oppArsenalSnapshots['__opening__'] = extractOppArsenalCount();
        lifeSnapshots['__opening__'] = extractLife();
        const f0 = extractField(); if (f0) fieldSnapshots['__opening__'] = f0;
        const gr0 = extractTwoCamp('Graveyard'); if (gr0) graveSnapshots['__opening__'] = gr0;
        const bn0 = extractTwoCamp('Banish'); if (bn0) banishSnapshots['__opening__'] = bn0;
      } else if (prev.length && hand.length < prev.length) {
        openingSnapped = true;                              // 1re baisse → main d'ouverture figée
      }
    }
    let key = null;
    for (let i = captured.length - 1; i >= 0; i--) {
      const m = captured[i].match(TURN_HEADER_RE);
      if (m) { key = m[1] + '#' + m[2]; break; }
    }
    if (key && key !== lastTurnKey) {
      lastTurnKey = key;
      const hand = extractMyHandCards(), arsenal = extractMyArsenal();
      if (hand.length) handSnapshots[key] = hand;
      arsenalSnapshots[key] = arsenal;
      oppArsenalSnapshots[key] = extractOppArsenalCount();
      const f = extractField(); if (f) fieldSnapshots[key] = f;
      const gr = extractTwoCamp('Graveyard'); if (gr) graveSnapshots[key] = gr;
      const bn = extractTwoCamp('Banish'); if (bn) banishSnapshots[key] = bn;
      lifeSnapshots[key] = extractLife();
    }
    captureCombatChain();
  }

  // Capture de l'attaque/défense EFFECTIVES (buffs compris) depuis la chaîne de
  // combat Talishar (state.game.activeChainLink.totalPower/totalDefense). On suit
  // le lien actif et on retient sa valeur la plus récente (les pumps s'ajoutent),
  // puis on le FIGE quand la chaîne se ferme (ou qu'un autre attaquant arrive).
  const CHAIN_KW = ['goAgain', 'dominate', 'overpower', 'piercing', 'combo', 'wager', 'phantasm', 'fusion', 'tower', 'highTide', 'confidence'];
  function captureCombatChain() {
    const g = getGameState(); if (!g) return;
    const acl = g.activeChainLink;
    const ac = acl && acl.attackingCard;
    let card = ac && (ac.cardName || ac.cardNumber);
    // « blank » = carte-fantôme de Talishar quand la chaîne est vide/en cours
    // d'initialisation → à ignorer (sinon un lien parasite power=0 pollue).
    if (card && /^blank$/i.test(String(card).trim())) card = null;
    if (card && acl.totalPower != null) {
      const turn = lastTurnKey || '__opening__';
      const kw = CHAIN_KW.filter(k => acl[k]);
      if (!pendingChain || pendingChain.card !== card || pendingChain.turn !== turn) {
        if (pendingChain) chainLinks.push(pendingChain);      // fige le lien précédent
        pendingChain = { turn: turn, card: card, power: acl.totalPower, defense: acl.totalDefense, prevent: acl.damagePrevention || 0, target: acl.attackTarget || null, kw: kw };
      } else {                                                 // même lien → valeur la plus récente
        pendingChain.power = acl.totalPower; pendingChain.defense = acl.totalDefense;
        pendingChain.prevent = acl.damagePrevention || 0; if (kw.length) pendingChain.kw = kw;
      }
    } else if (pendingChain) {                                 // chaîne fermée → fige
      chainLinks.push(pendingChain); pendingChain = null;
    }
  }

  function tick() {
    try {
      ensureUI();
      // Hors d'une page de partie (accueil, deckbuilder…) : le widget est masqué
      // par ensureUI et on n'effectue aucune capture. Le script reste vivant et
      // reprend automatiquement dès qu'on entre dans une partie (navigation SPA).
      if (!onGamePage()) return;
      const gn = currentGameName();
      if (gn !== gameName) {
        gameName = gn; lastVisibleSig = ''; lastTurnKey = null; openingSnapped = false; chatLogAdopted = false;
        meta = {}; endStats = null; endStatsLogged = false; autoPushedFor = null; autoPushedCount = 0;
        loadExisting(); updateUI();
      }
      // Priorité au journal structuré (state.game.chatLog) : chaque entrée y
      // figure une seule fois → fini la duplication née du re-rendu du DOM.
      // Repli sur le panneau DOM quand le store n'est pas accessible.
      let visible = readChatLogLines();
      if (visible) {
        logSource = 'chatlog';
        // Première lecture via chatLog pour cette partie : si l'accumulé provient
        // d'une capture DOM antérieure (format différent → pas de chevauchement),
        // on l'abandonne au profit du chatLog, complet et sans doublon. Gardé
        // par chatLogAdopted pour ne se produire qu'UNE fois (sinon un éventuel
        // fenêtrage du chatLog en live passerait pour un changement de format).
        if (!chatLogAdopted) {
          chatLogAdopted = true;
          if (captured.length && captured[0] !== visible[0]) {
            captured = []; tsBatches = []; lastVisibleSig = '';
          }
        }
      } else {
        logSource = 'dom';
        const box = findLogBox();
        if (box) {
          if (!boxLogged) { console.log('[TLG] panneau log détecté ✔'); boxLogged = true; }
          visible = readVisibleLines(box);
        }
      }
      if (visible) {
        const sig = visible.join('\n');
        if (sig !== lastVisibleSig) {
          lastVisibleSig = sig; merge(visible); save(); updateUI();
        }
      }
      maybeFillMeta();
      maybeSnapshotState();
      captureEndGameStats();
    } catch (e) { console.error('[TLG] erreur tick (boucle continue):', e); }
  }

  // ============ UI ============
  let ui = null, counter = null, fullBox = null, miniBox = null;
  let acctBtn = null, toolsRow = null;   // bouton compte contextuel + tiroir d'outils « ⋯ »
  let toolsOpen = false;
  const LS_COLLAPSED = 'tlg_collapsed';
  let collapsed = false;
  try { collapsed = localStorage.getItem(LS_COLLAPSED) === '1'; } catch (e) {}

  function setCollapsed(v) {
    collapsed = v;
    try { localStorage.setItem(LS_COLLAPSED, v ? '1' : '0'); } catch (e) {}
    applyCollapsed();
  }

  function applyCollapsed() {
    if (!ui) return;
    if (fullBox) fullBox.style.display = collapsed ? 'none' : 'block';
    if (miniBox) miniBox.style.display = collapsed ? 'flex' : 'none';
    applyStyle();
  }

  function buildUI() {
    ui = document.createElement('div');
    ui.id = 'tlg-widget';

    // --- Vue réduite : petite pastille tapable ---
    miniBox = document.createElement('div');
    miniBox.id = 'tlg-mini';
    miniBox.style.cssText = 'align-items:center;gap:6px;cursor:pointer';
    miniBox.title = 'Ouvrir le Log Grabber';
    miniBox.innerHTML = '<span style="font-size:14px">📜</span>' +
      '<span id="tlg-mini-count" style="font-weight:700">0</span>';
    miniBox.onclick = () => setCollapsed(false);

    // --- Vue complète ---
    fullBox = document.createElement('div');
    fullBox.id = 'tlg-full';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700';
    title.textContent = '📜 Log Grabber v' + VERSION;
    const collapseBtn = document.createElement('button');
    collapseBtn.textContent = '–';
    collapseBtn.title = 'Réduire';
    collapseBtn.style.cssText = 'width:22px;height:22px;line-height:1;padding:0;cursor:pointer;' +
      'background:#333;border:1px solid #c9a227;border-radius:5px;color:#eee;font-weight:700;flex-shrink:0';
    collapseBtn.onclick = () => setCollapsed(true);
    header.appendChild(title);
    header.appendChild(collapseBtn);
    fullBox.appendChild(header);

    const count = document.createElement('div');
    count.id = 'tlg-count';
    count.style.cssText = 'margin-bottom:6px;opacity:.85';
    count.textContent = '0 lignes';
    fullBox.appendChild(count);

    // Bouton doré (action principale) ou discret (outil secondaire).
    const mkBtn = (label, fn, subtle) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'margin:0 4px 0 0;padding:3px 8px;cursor:pointer;border-radius:5px;font-weight:700;' +
        (subtle ? 'background:#333;border:1px solid #555;color:#ddd' : 'background:#c9a227;border:0;color:#111');
      b.onclick = fn;
      return b;
    };
    // Rangée PRINCIPALE, minimale : bouton compte (seulement si à connecter, car
    // l'envoi est automatique une fois appairé) + « ⋯ » pour déplier les outils.
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;align-items:center;gap:4px';
    acctBtn = mkBtn('🔗 Connecter mon compte', () => sbConfigured() ? pushGameToSupabase(false) : pairOneClick());
    const moreBtn = mkBtn('⋯', () => { toolsOpen = !toolsOpen; if (toolsRow) toolsRow.style.display = toolsOpen ? 'flex' : 'none'; }, true);
    moreBtn.title = 'Outils (télécharger, diagnostic, ré-appairer, effacer…)';
    btnRow.appendChild(acctBtn);
    btnRow.appendChild(moreBtn);
    fullBox.appendChild(btnRow);

    // Tiroir d'OUTILS (masqué par défaut) : secours + débogage.
    toolsRow = document.createElement('div');
    toolsRow.style.cssText = 'display:none;flex-wrap:wrap;gap:4px;margin-top:6px';
    toolsRow.appendChild(mkBtn('⤓ Télécharger', downloadLog, true));
    toolsRow.appendChild(mkBtn('⧉ Copier', copyLog, true));
    toolsRow.appendChild(mkBtn('📤 Envoyer au compte', () => sbConfigured() ? pushGameToSupabase(false) : pairOneClick(), true));
    toolsRow.appendChild(mkBtn('🔍 Diag', downloadDiag, true));
    toolsRow.appendChild(mkBtn('⚙ Ré-appairer', () => sbConfigured() ? configurePairing() : pairOneClick(), true));
    toolsRow.appendChild(mkBtn('🗑 Effacer', clearLog, true));
    fullBox.appendChild(toolsRow);

    ui.appendChild(miniBox);
    ui.appendChild(fullBox);
    counter = count;
    applyStyle();
    applyCollapsed();
  }

  function applyStyle() {
    if (!ui) return;
    ui.style.cssText = [
      'position:fixed', 'left:8px', 'bottom:8px', 'z-index:2147483647',
      'font:12px/1.4 system-ui,sans-serif', 'color:#eee',
      'background:rgba(20,20,25,.95)', 'border:1px solid #c9a227',
      'border-radius:8px', collapsed ? 'padding:6px 10px' : 'padding:8px 10px',
      'user-select:none', 'box-shadow:0 2px 12px rgba(0,0,0,.6)',
      'pointer-events:auto', 'isolation:isolate'
    ].join(';');
  }

  function ensureUI() {
    if (!ui) buildUI();
    const root = document.documentElement || document.body;
    if (ui && ui.parentNode !== root && root) root.appendChild(ui);
    applyStyle();
    // Widget visible uniquement sur les pages de partie (cf. onGamePage).
    if (ui) ui.style.display = onGamePage() ? '' : 'none';
    updateUI();
  }

  function updateUI() {
    const nbHands = Object.keys(handSnapshots).length;
    if (counter) {
      const src = logSource === 'chatlog' ? '⚡ chatLog' : (reduxStore ? '⚡ redux' : '🔍 dom');
      const heroBit = (meta.myHero || '?') + ' vs ' + (meta.oppHero || '?');
      const fmtBit = meta.format ? ' · ' + meta.format : '';
      // Alerte canari : Talishar a change qqch → on prévient ICI, tout de suite.
      const canaryBit = canaryIssues.length
        ? '<br><span style="color:#ff6b6b;font-weight:700" title="' + canaryIssues.join(' · ').replace(/"/g, '') + '">⚠ format Talishar inattendu — préviens le mainteneur</span>'
        : '';
      counter.innerHTML = captured.length + ' lignes · ' + nbHands + ' mains · ' + src + fmtBit
        + '<br><span style="opacity:.7">' + heroBit + '</span>'
        + (sbConfigured() ? '<br><span style="opacity:.7;color:#7fd18a">✓ compte connecté · envoi automatique</span>' : '') + canaryBit;
    }
    // Bouton « Connecter » : montré UNIQUEMENT tant que le compte n'est pas
    // appairé. Une fois appairé, l'envoi est automatique → plus rien à cliquer
    // (l'envoi manuel reste dispo dans les outils « ⋯ »).
    if (acctBtn) acctBtn.style.display = sbConfigured() ? 'none' : '';
    // Compteur de la vue réduite : nombre de lignes capturées
    const mini = ui && ui.querySelector('#tlg-mini-count');
    if (mini) mini.textContent = captured.length;
  }

  // ============================================================
  // EXPORT — header + log brut + blocs HAND/ARSENAL (format v1.6,
  // compatibles viewer actuel) + LIFE / META / TIMESTAMPS.
  // ============================================================
  function snapshotBlockText(title, snapshots, fmt) {
    const keys = Object.keys(snapshots);
    if (!keys.length) return '';
    const lines = keys.map(k => {
      const label = k === '__opening__' ? 'OUVERTURE' : k.replace('#', ' #');
      return '[' + label + '] ' + fmt(snapshots[k]);
    });
    return '\n=== ' + title + ' ===\n' + lines.join('\n') + '\n';
  }

  // Bloc « 2 camps » (terrain / cimetière / banni) : [tour] me: … | opp: …
  function twoCampBlock(title, snaps) {
    const keys = Object.keys(snaps);
    if (!keys.length) return '';
    const fmt = v => (v && v.length) ? v.join(', ') : '(vide)';
    const lines = keys.map(k => {
      const label = k === '__opening__' ? 'OUVERTURE' : k.replace('#', ' #');
      const s = snaps[k] || {};
      return '[' + label + '] me: ' + fmt(s.me) + ' | opp: ' + fmt(s.opp);
    });
    return '\n=== ' + title + ' ===\n' + lines.join('\n') + '\n';
  }
  function fieldBlockText() { return twoCampBlock('FIELD SNAPSHOTS (permanents/tokens en jeu : toi | adversaire)', fieldSnapshots); }
  function graveBlockText() { return twoCampBlock('GRAVEYARD SNAPSHOTS (cimetière : toi | adversaire)', graveSnapshots); }
  function banishBlockText() { return twoCampBlock('BANISH SNAPSHOTS (banni : toi | adversaire)', banishSnapshots); }

  function metaBlockText() {
    const eqText = eq => {
      if (!eq) return '(non capté)';
      const parts = EQ_FIELDS.map(([k]) => eq[k] ? k + '=' + eq[k] : null).filter(Boolean);
      return parts.length ? parts.join(' | ') : '(non capté)';
    };
    const val = v => (v == null || v === '') ? '(non capté)' : v;
    const rows = [
      ['schema', 'v1'],
      ['captured_with', 'TLG v' + (meta.captureVersion || VERSION)],
      ['game_url', meta.gameUrl || location.href],
      ['captured_at', val(meta.capturedAt)],
      ['format', val(meta.format)],
      ['vs_ai', meta.isOpponentAI == null ? '(non capté)' : (meta.isOpponentAI ? 'oui' : 'non')],
      ['me', val(meta.myName)],
      ['opponent', val(meta.oppName)],
      ['my_hero', val(meta.myHero)],
      ['opp_hero', val(meta.oppHero)],
      ['my_start_life', val(meta.myStartLife)],
      ['opp_start_life', val(meta.oppStartLife)],
      ['my_start_deck_size', val(meta.myStartDeckSize)],
      ['opp_start_deck_size', val(meta.oppStartDeckSize)],
      ['my_equipment', eqText(meta.myEquipment)],
      ['opp_equipment', eqText(meta.oppEquipment)]
    ];
    return '\n=== META ===\n' + rows.map(([k, v]) => k + ': ' + v).join('\n') + '\n';
  }

  function tsBlockText() {
    if (!tsBatches.length) return '';
    const parts = tsBatches.map(b => b.from + '-' + b.to + ':' + b.t);
    return '\n=== TIMESTAMPS ===\n' + parts.join(',') + '\n';
  }

  function lifeLineFmt(v) {
    if (!v) return 'me=? opp=?';
    let s = 'me=' + (v.me != null ? v.me : '?') + ' opp=' + (v.opp != null ? v.opp : '?');
    if (v.myDeck != null || v.oppDeck != null) {
      s += ' myDeck=' + (v.myDeck != null ? v.myDeck : '?') + ' oppDeck=' + (v.oppDeck != null ? v.oppDeck : '?');
    }
    return s;
  }

  // Réconcilie les HÉROS depuis les stats officielles de fin de partie
  // (endStats), source faisant AUTORITÉ. `gameInfo.heroName` peut rester figé
  // sur une partie PRÉCÉDENTE quand la SPA Talishar ne réinitialise pas bien
  // son store entre deux parties : on a vu « Arakni » ressortir sur une partie
  // Oscilio. Les stats donnent le slot du joueur local (myPlayerID), l'id de
  // héros (yourHero/opponentHero) et un tableau character[] avec les noms
  // lisibles. On écrase donc meta.myHero (et oppHero si le nom est connu).
  function reconcileHeroesFromStats() {
    if (!endStats || !endStats.byPlayer) return;
    const bp = endStats.byPlayer;
    const mine = bp[endStats.myPlayerID] || bp[1] || bp[Object.keys(bp)[0]];
    if (!mine) return;
    const nameOfId = (stats, id) => {
      if (!id || !stats || !Array.isArray(stats.character)) return null;
      const hit = stats.character.find(c => c && c.cardId === id);
      return hit ? hit.cardName : null;
    };
    const label = (name, id) => name ? (id ? name + ' (' + id + ')' : name) : null;
    // Mon héros : id yourHero + nom lisible depuis MON character[] (1re entrée).
    const myId = mine.yourHero;
    const myName = nameOfId(mine, myId) || (mine.character && mine.character[0] && mine.character[0].cardName) || null;
    const myLabel = label(myName, myId);
    if (myLabel) meta.myHero = myLabel;
    // Héros adverse : on n'écrase QUE si on a un vrai nom lisible (le camp
    // adverse a été capté) — sinon on garde meta.oppHero déjà résolu (gi),
    // pour ne pas régresser sur un simple id brut.
    const oppId = mine.opponentHero;
    const otherPid = Object.keys(bp).find(k => String(k) !== String(endStats.myPlayerID));
    const oppName = nameOfId(otherPid ? bp[otherPid] : null, oppId)
      || (otherPid && bp[otherPid] && bp[otherPid].character && bp[otherPid].character[0] && bp[otherPid].character[0].cardName) || null;
    if (oppName) meta.oppHero = label(oppName, oppId);
  }

  // Réconcilie les PSEUDOS quand l'ancre fiable (le jet de dé « you rolled »)
  // est absente du log : dans ce cas resolveNamesFromLog n'a rien pu fixer et
  // on est retombé sur Redux, dont la perspective peut être inversée (on a vu
  // « me » = l'adversaire). La main capturée (DOM) est TOUJOURS la nôtre : le
  // joueur dont les cartes « played » figurent dans notre main est « moi ».
  function reconcileNamesFromHand() {
    if (captured.some(l => /rolled \d+/.test(l))) return;   // jet de dé présent → déjà fiable
    const headerNames = [];
    const played = {};
    for (const line of captured) {
      let m = line.match(/^(.+?)'s turn \d+ has begun\.$/);
      if (m && headerNames.indexOf(m[1].trim()) < 0) headerNames.push(m[1].trim());
      m = line.match(/^(.+?) played (.+?)(?: from arsenal)?$/);
      if (m) { const n = m[1].trim(); (played[n] = played[n] || []).push(m[2].trim().toLowerCase()); }
    }
    if (headerNames.length < 2) return;
    const myCards = new Set();
    Object.keys(handSnapshots).forEach(k => (handSnapshots[k] || []).forEach(c => myCards.add(String(c).toLowerCase())));
    if (!myCards.size) return;
    const score = n => (played[n] || []).reduce((s, c) => s + (myCards.has(c) ? 1 : 0), 0);
    const ranked = headerNames.slice().sort((a, b) => score(b) - score(a));
    const meName = ranked[0], oppName = ranked.find(n => n !== meName);
    if (meName && score(meName) > score(oppName)) {   // « moi » sans ambiguïté
      meta.myName = meName;
      if (oppName) meta.oppName = oppName;
    }
  }

  function logText() {
    reconcileHeroesFromStats();
    reconcileNamesFromHand();
    return '=== Talishar game ' + gameName + ' — ' + new Date().toLocaleString() + ' ===\n\n'
      + captured.join('\n') + '\n'
      + snapshotBlockText('HAND SNAPSHOTS (ta main, captée depuis le DOM — jamais celle de l\'adversaire)', handSnapshots,
          v => v.length ? v.join(', ') : '(vide)')
      + snapshotBlockText('ARSENAL SNAPSHOTS (ton arsenal, capté depuis le DOM — jamais celui de l\'adversaire)', arsenalSnapshots,
          v => v.length ? v.join(', ') : '(vide)')
      + snapshotBlockText('OPP ARSENAL COUNT (arsenal adverse : NOMBRE de cartes face cachée — le nom reste inconnu)', oppArsenalSnapshots,
          v => String(v == null ? 0 : v))
      + fieldBlockText()
      + graveBlockText()
      + banishBlockText()
      + snapshotBlockText('LIFE SNAPSHOTS (vie et taille de deck : toi / adversaire)', lifeSnapshots, lifeLineFmt)
      + metaBlockText()
      + tsBlockText()
      + chainBlockText()
      + endStatsBlockText()
      + rawChatLogBlockText();
  }

  // Combats : attaque/défense EFFECTIVES (buffs compris) lues dans la chaîne de
  // combat Talishar. Une ligne JSON par lien, dans l'ordre du jeu → le lecteur
  // les apparie aux combats du log (par tour + carte). Le lien en cours (non
  // encore figé) est inclus pour ne pas perdre le dernier combat à l'export.
  function chainBlockText() {
    const all = pendingChain ? chainLinks.concat([pendingChain]) : chainLinks;
    if (!all.length) return '';
    return '\n=== COMBAT CHAIN (attaque/défense effectives, buffs compris) ===\n'
      + all.map(l => JSON.stringify(l)).join('\n') + '\n';
  }

  // Journal STRUCTURÉ brut (state.game.chatLog) conservé verbatim, sur une seule
  // ligne JSON. C'est la SOURCE PURE : si un jour la traduction chatLog→texte se
  // trompe (changement Talishar), on peut ré-analyser à partir d'ici sans re-capture.
  function rawChatLogBlockText() {
    if (!Array.isArray(lastRawChatLog) || !lastRawChatLog.length) return '';
    let json; try { json = JSON.stringify(lastRawChatLog); } catch (e) { return ''; }
    return '\n=== RAW CHATLOG (state.game.chatLog, verbatim) ===\n' + json + '\n';
  }

  // Bloc JSON des stats officielles Talishar, si captées. Une seule ligne JSON
  // pour rester compatible avec le parsage par blocs (le lecteur fait un
  // JSON.parse du corps du bloc).
  function endStatsBlockText() {
    if (!endStats || !endStats.byPlayer || !Object.keys(endStats.byPlayer).length) return '';
    let json;
    try { json = JSON.stringify(endStats); } catch (e) { return ''; }
    return '\n=== END GAME STATS (Talishar, JSON) ===\n' + json + '\n';
  }
  function flash(msg) { if (counter) { counter.textContent = msg; setTimeout(updateUI, 1500); } }

  function copyLog() {
    navigator.clipboard.writeText(logText())
      .then(() => { flash('Copié ✔'); console.log('[TLG] log copié'); })
      .catch(() => flash('Copie refusée — Alt+Shift+D'));
  }
  function downloadLog() {
    const blob = new Blob([logText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const a = document.createElement('a');
    a.href = url; a.download = 'talishar_' + gameName + '_' + ts + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    flash('Téléchargé ✔');
    console.log('[TLG] log téléchargé');
  }

  // DIAGNOSTIC (mobile-friendly) : décrit la structure du store Redux de Talishar
  // et repère les tableaux qui ressemblent au journal de partie. Sert à savoir si
  // le log est disponible en données STRUCTURÉES (fiable) plutôt que gratté du DOM
  // (fragile face aux re-rendus). Téléchargé en .txt → l'utilisateur l'envoie.
  function reduxDiag() {
    const s = getRootState();
    if (!s) return 'store Redux introuvable (ouvre bien une PARTIE).';
    const g = s.game || {};
    const strip = x => String(x == null ? '' : x).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const zone = (pl, z) => { const a = pl && pl[z]; return Array.isArray(a) ? (a.map(c => c && (c.cardName || c.cardNumber)).filter(Boolean).join(', ') || '(vide)') : '(absent)'; };
    const out = [];
    out.push('STATE keys: ' + Object.keys(s).join(', '));
    out.push('GAME keys: ' + Object.keys(g).join(', '));
    try { out.push('', 'gameInfo: ' + JSON.stringify(g.gameInfo)); } catch (e) { /* ignore */ }
    // chatLog COMPLET, HTML retiré → est-ce le journal (avec tours/dégâts) ?
    if (Array.isArray(g.chatLog)) {
      out.push('', 'CHATLOG (' + g.chatLog.length + ' entrées, HTML retiré):');
      g.chatLog.forEach((e, i) => out.push('  [' + i + '] ' + strip(e)));
      // Dump VERBATIM (HTML NON retiré) des entrées carte (played/blocked/pitched)
      // → pour voir quel identifiant/couleur d'impression y est encodé.
      const rawHits = [];
      g.chatLog.forEach((e, i) => {
        const t = String(e == null ? '' : e);
        if (/\b(played|blocked with|pitched|activated)\b/i.test(strip(t)) && rawHits.length < 6) rawHits.push('  [' + i + '] ' + t);
      });
      if (rawHits.length) out.push('', 'CHATLOG BRUT (verbatim, entrées carte — HTML CONSERVÉ):', ...rawHits);
    } else out.push('', 'chatLog: ABSENT');
    // events structurés (peut contenir les tours / la structure de combat).
    if (g.events !== undefined) { try { out.push('', 'events: ' + JSON.stringify(g.events).slice(0, 1200)); } catch (e) { out.push('', 'events: (non sérialisable)'); } }
    out.push('', 'turnPlayer=' + g.turnPlayer + ' turnPhase=' + g.turnPhase + ' amIActivePlayer=' + g.amIActivePlayer);
    // Mains/arsenals des 2 joueurs → info cachée (main adverse) disponible ?
    ['playerOne', 'playerTwo'].forEach(pk => {
      const pl = g[pk];
      if (!pl) { out.push('', pk + ': absent'); return; }
      out.push('', pk + ' keys: ' + Object.keys(pl).join(', '));
      out.push('  Hand: ' + zone(pl, 'Hand'));
      out.push('  Arsenal: ' + zone(pl, 'Arsenal'));
    });
    // OBJET-CARTE COMPLET : tous les champs d'une carte (y a-t-il attaque/défense/
    // pitch/coût ?). On prend la 1re carte trouvée dans une zone quelconque.
    const firstCard = (() => {
      for (const pk of ['playerOne', 'playerTwo']) {
        const pl = g[pk]; if (!pl) continue;
        for (const z of ['Hand', 'Arsenal', 'Deck', 'Graveyard', 'Banish', 'Permanents']) {
          const a = pl[z]; if (Array.isArray(a) && a.length && typeof a[0] === 'object') return { where: pk + '.' + z, card: a[0] };
        }
      }
      return null;
    })();
    if (firstCard) { try { out.push('', 'CARTE COMPLÈTE (' + firstCard.where + '[0], TOUS les champs):', JSON.stringify(firstCard.card)); } catch (e) {} }
    // CHAÎNE DE COMBAT : c'est là que Talishar affiche la puissance EFFECTIVE
    // (attaque buffée) et la défense. Objectif : voir si atk/def/power y figurent.
    ['activeChainLink', 'oldCombatChain', 'activeLayers', 'combatChain', 'chainLinks'].forEach(k => {
      if (g[k] === undefined) return;
      try { out.push('', k + ': ' + JSON.stringify(g[k]).slice(0, 2000)); } catch (e) { out.push('', k + ': (non sérialisable)'); }
    });
    return out.join('\n');
  }
  function downloadDiag() {
    const txt = '=== TLG REDUX DIAG — grabber v' + VERSION + ' — ' + new Date().toISOString() + ' ===\n\n' + reduxDiag() + '\n';
    const blob = new Blob([txt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'tlg-diag_' + gameName + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    flash('Diagnostic téléchargé ✔');
  }
  function clearLog() {
    if (!confirm('Effacer le log, les snapshots et les métadonnées capturés de cette partie ?')) return;
    captured = []; lastVisibleSig = ''; handSnapshots = {}; arsenalSnapshots = {}; oppArsenalSnapshots = {};
    fieldSnapshots = {}; graveSnapshots = {}; banishSnapshots = {}; lifeSnapshots = {}; tsBatches = []; meta = {};
    chainLinks = []; pendingChain = null;
    lastTurnKey = null; openingSnapped = false;
    save(); updateUI();
  }

  // ============================================================
  // SYNCHRO DÉPÔT GITHUB (Phase 3)
  // ------------------------------------------------------------
  // Dépose le .txt brut dans data/raw/<id>.txt et met à jour le
  // manifeste data/raw/index.json. Le viewer l'ingère et le parse
  // au chargement (source unique du parseur = talishar-parser.js).
  // L'API GitHub est compatible CORS → simple fetch, aucun GM_*,
  // le script reste en contexte page (capture Redux intacte).
  // Config stockée en localStorage (token limité à ce dépôt).
  // ============================================================
  const SYNC = { owner: 'tlg_sync_owner', repo: 'tlg_sync_repo', branch: 'tlg_sync_branch', token: 'tlg_sync_token', auto: 'tlg_sync_auto' };
  function cfg(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function syncConfigured() { return !!(cfg(SYNC.owner) && cfg(SYNC.repo) && cfg(SYNC.token)); }

  // --- Compte Supabase (option C) : envoi privé via l'Edge Function ingest,
  // authentifié par un CODE D'APPAIRAGE généré dans l'app (pas de token GitHub).
  const SB_INGEST = 'https://alzldgpopmhxnlxafsrl.supabase.co/functions/v1/ingest';
  const SB = { token: 'tlg_sb_token' };
  function sbConfigured() { return !!cfg(SB.token); }
  // Appairage 1-clic : on ouvre l'app (même origine que ta session) qui nous
  // renvoie le code par postMessage. APP_ORIGIN sert à valider l'expéditeur.
  const APP_ORIGIN = 'https://colincamille.github.io';
  const APP_PAIR_URL = APP_ORIGIN + '/Fab-replay/#pair';

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToUtf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function ghHeaders() {
    return { 'Authorization': 'Bearer ' + cfg(SYNC.token), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  function ghUrl(path) { return 'https://api.github.com/repos/' + cfg(SYNC.owner) + '/' + cfg(SYNC.repo) + path; }

  async function ghDefaultBranch() {
    if (cfg(SYNC.branch)) return cfg(SYNC.branch);
    try { const r = await fetch(ghUrl(''), { headers: ghHeaders() }); if (r.ok) { const j = await r.json(); return j.default_branch || 'main'; } } catch (e) {}
    return 'main';
  }
  // Lit {sha, json} d'un fichier du dépôt ; {sha:null} si absent (404).
  async function ghReadContents(filePath, branch) {
    const r = await fetch(ghUrl('/contents/' + filePath + '?ref=' + encodeURIComponent(branch)), { headers: ghHeaders() });
    if (r.status === 404) return { sha: null, json: null };
    if (!r.ok) throw new Error('lecture ' + filePath + ': HTTP ' + r.status);
    const j = await r.json();
    let json = null;
    try { json = JSON.parse(base64ToUtf8(j.content)); } catch (e) {}
    return { sha: j.sha || null, json: json };
  }
  async function ghPut(filePath, contentText, message, sha, branch) {
    const body = { message: message, content: utf8ToBase64(contentText), branch: branch };
    if (sha) body.sha = sha;
    return fetch(ghUrl('/contents/' + filePath), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  }

  // Envoie la partie courante dans le dépôt. silent = pas d'ouverture auto
  // de la config si non configuré (utilisé par l'auto-envoi).
  async function pushGameToRepo(silent) {
    if (!syncConfigured()) {
      if (silent) return;
      configureSync();
      if (!syncConfigured()) { alert('Synchro non configurée : owner, repo ET token sont requis (le token n’a pas été enregistré ?).'); return; }
      // Configuré à l'instant → on enchaîne directement sur l'envoi (pas besoin de recliquer).
    }
    if (!captured.length) { flash('Rien à envoyer'); if (!silent) alert('Aucune ligne de log capturée pour cette partie.'); return; }
    const id = gameName;
    // Garde-fou anti-doublon fantôme : sans numéro de partie dans l'URL
    // (page fermée/périmée, /game/ sans id → gameName === 'unknown'), on
    // refuse d'envoyer. Une telle capture crée un enregistrement « unknown »
    // aux données corrompues qui se ré-injecte à chaque synchro et ne peut
    // pas être supprimé proprement par gameId. En auto (silencieux) on ignore
    // sans bruit ; en manuel on explique.
    if (!id || !/^\d+$/.test(String(id))) {
      if (silent) return;
      flash('Partie sans id — envoi ignoré');
      alert('Impossible d’identifier la partie : aucun numéro dans l’URL Talishar.\n\nOuvre la partie depuis talishar.net/game/play/<numéro> (partie en cours), puis réessaie. Une page fermée ou le lobby ne permettent pas un envoi fiable.');
      return;
    }
    const text = logText();
    flash('Envoi au dépôt…');
    console.log('[TLG] envoi: début — partie ' + id + ', dépôt ' + cfg(SYNC.owner) + '/' + cfg(SYNC.repo));
    try {
      const branch = await ghDefaultBranch();
      console.log('[TLG] envoi: branche = ' + branch);

      // 1. Dépose (ou écrase) le .txt brut.
      const rawPath = 'data/raw/' + id + '.txt';
      const existing = await ghReadContents(rawPath, branch);
      const rawRes = await ghPut(rawPath, text, 'grabber: log ' + id, existing.sha, branch);
      if (!rawRes.ok) throw new Error('dépôt du log: HTTP ' + rawRes.status + ' ' + (await rawRes.text().catch(() => '')).slice(0, 160));
      console.log('[TLG] envoi: log brut déposé (HTTP ' + rawRes.status + ')');

      // 2. Met à jour le manifeste (read-modify-write, retry sur conflit 409).
      const idxPath = 'data/raw/index.json';
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await ghReadContents(idxPath, branch);
        const arr = Array.isArray(cur.json) ? cur.json : ((cur.json && cur.json.raw) || []);
        const rest = arr.filter(e => String((e && (e.gameId || e.id)) || e) !== String(id));
        rest.push({ gameId: id, uploadedAt: new Date().toISOString(), me: meta.myName || null, opponent: meta.oppName || null, oppHero: meta.oppHero || null, format: meta.format || null });
        const idxRes = await ghPut(idxPath, JSON.stringify(rest), 'grabber: index +' + id, cur.sha, branch);
        if (idxRes.ok) { flash('Envoyé au dépôt ✔'); console.log('[TLG] partie ' + id + ' envoyée au dépôt'); return; }
        if (idxRes.status === 409 && attempt < 2) continue;
        throw new Error('mise à jour index: HTTP ' + idxRes.status);
      }
    } catch (e) {
      console.error('[TLG] envoi dépôt échoué:', e);
      flash('Envoi échoué (voir console)');
      if (!silent) alert('Envoi au dépôt échoué : ' + e.message
        + '\n\n(Si « Failed to fetch », c’est probablement la CSP de Talishar qui bloque l’appel — dis-le-moi, je passe le grabber en GM_xmlhttpRequest.)');
    }
  }

  // Envoi de la partie vers le COMPTE (Supabase) via l'Edge Function ingest.
  // Authentifié par le code d'appairage. Coexiste avec l'envoi GitHub le temps
  // de la transition.
  async function pushGameToSupabase(silent) {
    if (!sbConfigured()) { if (silent) return; configurePairing(); if (!sbConfigured()) return; }
    if (!captured.length) { if (!silent) alert('Aucune ligne de log capturée pour cette partie.'); return; }
    const id = gameName;
    if (!id || !/^\d+$/.test(String(id))) {
      if (silent) return;
      flash('Partie sans id — envoi ignoré');
      alert('Impossible d’identifier la partie (aucun numéro dans l’URL Talishar). Ouvre la partie depuis talishar.net/game/play/<numéro> puis réessaie.');
      return;
    }
    flash('Envoi au compte…');
    try {
      const res = await fetch(SB_INGEST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_token: cfg(SB.token),
          game_id: String(id),
          raw: logText(),
          my_hero: meta.myHero || null,     // MON héros (symétrique de opp_hero) — source du dashboard
          opp_hero: meta.oppHero || null,
          format: meta.format || null,
          captured_at: meta.capturedAt || new Date().toISOString()
        })
      });
      if (res.ok) { flash('Envoyé au compte ✔'); console.log('[TLG] partie ' + id + ' envoyée au compte'); return; }
      const t = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 180));
    } catch (e) {
      console.error('[TLG] envoi compte échoué:', e);
      flash('Envoi compte échoué');
      if (!silent) alert('Envoi au compte échoué : ' + e.message
        + '\n\nVérifie que : (1) l’Edge Function « ingest » est déployée avec JWT verification désactivée, (2) le code d’appairage est correct (régénère-le dans l’app → 🔗 Connecter le grabber).');
    }
  }

  // Appairage 1-CLIC : ouvre l'app en pop-up (elle partage ta session) → elle
  // génère un code et nous le renvoie par postMessage. Aucun copier-coller. Si
  // la pop-up est bloquée, on retombe sur la saisie manuelle du code.
  function pairOneClick() {
    let popup = null, done = false;
    const onMsg = (e) => {
      if (e.origin !== APP_ORIGIN) return;
      const t = e.data && e.data.fabPairToken;
      if (!t) return;
      done = true;
      try { localStorage.setItem(SB.token, String(t)); } catch (err) {}
      window.removeEventListener('message', onMsg);
      try { popup && popup.close(); } catch (err) {}
      flash('Compte connecté ✔ (envoi auto activé)');
      updateUI();
    };
    window.addEventListener('message', onMsg);
    popup = window.open(APP_PAIR_URL, 'fabPair', 'width=460,height=640');
    if (!popup) { window.removeEventListener('message', onMsg); return configurePairing(); }   // bloqué → repli collage
    flash('Fenêtre d’appairage ouverte…');
    setTimeout(() => {   // filet : si rien reçu, on nettoie et on propose le collage
      if (done || sbConfigured()) return;
      window.removeEventListener('message', onMsg);
      if (confirm('Appairage non reçu (fenêtre fermée ou non connecté ?).\n\nOK = coller le code à la main · Annuler = abandonner.')) configurePairing();
    }, 90000);
  }

  // Appairage MANUEL (repli) : coller le code généré dans l'app.
  function configurePairing() {
    const has = !!cfg(SB.token);
    const code = prompt('Colle le CODE D’APPAIRAGE de ton compte.\n\nGénère-le dans l’app (une fois connecté) : bouton « 🔗 Connecter le grabber ».'
      + (has ? '\n\n(Un code est déjà enregistré — laisse vide pour le garder.)' : ''), '');
    if (code == null) return;
    if (code.trim()) { try { localStorage.setItem(SB.token, code.trim()); } catch (e) {} }
    // Appairer = vouloir l'envoi auto : le compte est toujours envoyé en fin de
    // partie (pas de drapeau à gérer ici). Le bouton 🔗 Compte reste dispo pour
    // un envoi manuel immédiat.
    flash(sbConfigured() ? 'Compte connecté ✔ (envoi auto activé)' : 'Code manquant');
    updateUI();
  }

  function configureSync() {
    const owner = prompt('Propriétaire du dépôt GitHub (ex : colincamille) :', cfg(SYNC.owner));
    if (owner == null) return;
    const repo = prompt('Nom du dépôt (ex : fab-replay) :', cfg(SYNC.repo) || 'fab-replay');
    if (repo == null) return;
    const hasTok = !!cfg(SYNC.token);
    const token = prompt('Token GitHub « fine-grained » (Contents = Read and write, limité à ce dépôt).'
      + (hasTok ? '\n(Un token est déjà enregistré — laisse vide pour le conserver.)' : ''), '');
    if (token == null) return;   // Annuler = ne rien changer
    try {
      localStorage.setItem(SYNC.owner, owner.trim());
      localStorage.setItem(SYNC.repo, repo.trim());
      if (token.trim()) localStorage.setItem(SYNC.token, token.trim());
    } catch (e) {}
    const auto = confirm('Envoyer AUTOMATIQUEMENT la partie à l’ouverture du Game Summary de fin ?\n\nOK = auto · Annuler = manuel (bouton ☁ ou Alt+Shift+S)');
    try { localStorage.setItem(SYNC.auto, auto ? '1' : '0'); } catch (e) {}
    console.log('[TLG] config synchro:', { owner: cfg(SYNC.owner), repo: cfg(SYNC.repo), tokenPresent: !!cfg(SYNC.token), auto: cfg(SYNC.auto) });
    if (!syncConfigured()) alert('Config incomplète : le token n’a pas été enregistré. Reclique ⚙ et colle bien le token.');
    flash(syncConfigured() ? 'Synchro configurée ✔' : 'Config incomplète (token ?)');
    updateUI();
  }

  // ============ Raccourcis clavier ============
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === 'd') { e.preventDefault(); downloadLog(); }
    else if (k === 'c') { e.preventDefault(); copyLog(); }
    else if (k === 's') { e.preventDefault(); pushGameToSupabase(false); }
    else if (k === 'x') { e.preventDefault(); setCollapsed(!collapsed); }
  }, true);

  // ============ Démarrage ============
  gameName = currentGameName();
  loadExisting();
  ensureUI();

  try {
    const obs = new MutationObserver(() => {
      const root = document.documentElement || document.body;
      if (ui && ui.parentNode !== root) ensureUI();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { console.error('[TLG] observer KO:', e); }

  setInterval(tick, POLL_MS);
})();
