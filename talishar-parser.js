/* ============================================================
 * Talishar Parser v2 — module partagé
 * ------------------------------------------------------------
 * Transforme le texte brut exporté par le Log Grabber en un
 * "game record" NORMALISÉ et VERSIONNÉ (schemaVersion), utilisable
 * à la fois par le viewer (une partie) et par la future page
 * bibliothèque (agrégation multi-parties).
 *
 * Principes :
 *  - Le .txt brut reste la source de vérité ; ce module est une
 *    transformation rejouable (on peut re-parser tout l'historique
 *    quand le parseur s'améliore).
 *  - Rétro-compatible : un vieux log sans blocs META/LIFE/TIMESTAMPS
 *    est parsé quand même (champs à null, warnings renseignés).
 *  - Aucune dépendance : chargeable via <script src> (file://) ou
 *    require() en Node pour les tests.
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TalisharParser = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const PARSER_VERSION = '2.0.0';

  const EQ_SLOTS = ['head', 'chest', 'arms', 'legs', 'weaponL', 'weaponR'];

  // ----------------------------------------------------------
  // Classification d'une ligne de log en événement structuré.
  // (Porté depuis le viewer v3, inchangé sur le fond.)
  // ----------------------------------------------------------
  function classifyLine(line) {
    let m;
    // Règles structurelles prioritaires : ces lignes commencent par un mot-clé
    // ("Resolving", "Processing") et contiennent "played"/"activated" en milieu
    // de phrase, ce qui les ferait matcher par erreur les règles génériques
    // d'action plus bas. On les traite donc en premier.
    if ((m = line.match(/^Resolving (?:play|activated) ability of (.+)\.$/))) return { type: 'resolving', card: m[1], text: line };
    if ((m = line.match(/^Processing hit effect for (.+)$/))) return { type: 'hitEffect', card: m[1], text: line };
    if (/^Resolving /.test(line)) return { type: 'resolving', text: line };
    if ((m = line.match(/^🎲 you rolled (\d+) and (.+?) rolled (\d+)\.$/))) return { type: 'diceRoll', text: line };
    if (/^you chooses who goes first\.$/.test(line)) return { type: 'info', text: line };
    if ((m = line.match(/^(.+?) will go first\.$/))) return { type: 'firstPlayer', player: m[1], text: line };
    if ((m = line.match(/^(.+?) played (.+?) from arsenal$/))) return { type: 'played', player: m[1], card: m[2], fromArsenal: true, text: line };
    if ((m = line.match(/^(.+?) played (.+)$/))) return { type: 'played', player: m[1], card: m[2], fromArsenal: false, text: line };
    if ((m = line.match(/^(.+?) pitched (.+)$/))) return { type: 'pitched', player: m[1], card: m[2], text: line };
    if ((m = line.match(/^(.+?) activated (.+)$/))) return { type: 'activated', player: m[1], card: m[2], text: line };
    if ((m = line.match(/^(.+?) blocked with (.+)$/))) { const cards = m[2].replace(/,? and /g, ', ').split(',').map(s => s.trim()).filter(Boolean); return { type: 'blocked', player: m[1], cards, text: line }; }
    if ((m = line.match(/^(.+?) was discarded$/))) return { type: 'discarded', card: m[1], text: line };
    // Destruction (ex. armure/Nullrune détruite pour prévenir des dégâts arcaniques,
    // ou carte détruite depuis l'arsenal). `detail` garde le suffixe éventuel
    // (« and prevented 1 arcane damage », « from the arsenal »…). La vue Table
    // s'en sert pour retirer du plateau un ÉQUIPEMENT détruit (cf. boardreplay).
    if ((m = line.match(/^(.+?) was destroyed(?:\s+(.*?))?\.?$/))) return { type: 'destroyed', card: m[1], detail: (m[2] || null), text: line };
    if ((m = line.match(/^(.+?) took (\d+) damage$/))) return { type: 'damageTaken', player: m[1], amount: parseInt(m[2], 10), text: line };
    if ((m = line.match(/^(.+?) is about to take (\d+) damage from(?: (.+))?$/))) return { type: 'damageAnnounced', player: m[1], amount: parseInt(m[2], 10), source: m[3] || null, text: line };
    if ((m = line.match(/^(.+?) gained (\d+) life$/))) return { type: 'lifeGained', player: m[1], amount: parseInt(m[2], 10), text: line };
    if (/^Combat resolved with no hit$/.test(line)) return { type: 'combatResult', hit: false, text: line };
    if ((m = line.match(/^Combat resolved with a hit for (\d+) damage$/))) return { type: 'combatResult', hit: true, amount: parseInt(m[1], 10), text: line };
    if ((m = line.match(/^🎯(.+?) was chosen as the target\.$/))) return { type: 'targeted', target: m[1], text: line };
    if ((m = line.match(/^(.+?)'s (.+?) was targeted(?: by (.+))?$/))) return { type: 'targetedSecondary', owner: m[1], card: m[2], text: line };
    if ((m = line.match(/^👁️‍🗨️(.+?) reveals (.+)$/))) return { type: 'revealed', player: m[1], card: m[2], text: line };
    if ((m = line.match(/^Selected mode(?:s)? for (.+?) (?:is|are): (.+)$/))) return { type: 'modeSelected', card: m[1], mode: m[2], text: line };
    if ((m = line.match(/^(.+?) gains Go Again!$/))) return { type: 'goAgain', card: m[1], text: line };
    if ((m = line.match(/^(.+?) grants go again$/))) return { type: 'goAgain', card: m[1], text: line };
    if ((m = line.match(/^(.+?) auto-passed$/))) return { type: 'autoPassed', player: m[1], text: line };
    if ((m = line.match(/^(.+?) passed priority\. Attempting to end turn\.$/))) return { type: 'endTurn', player: m[1], text: line };
    if ((m = line.match(/^(.+?) passed$/))) return { type: 'passed', player: m[1], text: line };
    if ((m = line.match(/^(.+?) undid their last action$/))) return { type: 'undo', player: m[1], text: line };
    if ((m = line.match(/^(.+?) did not sink a card$/))) return { type: 'info', text: line };
    if ((m = line.match(/^(.+?) was put on the bottom of the deck!$/))) return { type: 'deckManipulation', card: m[1], text: line };
    if (/^⤵️ A card was put on the bottom of the deck\.$/.test(line)) return { type: 'deckManipulation', text: line };
    if ((m = line.match(/^🔄(.+?) deck was shuffled$/))) return { type: 'deckShuffled', text: line };
    if ((m = line.match(/^(.+?) conceded the game\.$/))) return { type: 'conceded', player: m[1], text: line };
    if ((m = line.match(/^(.+?)\s*\((.+?)\)\s*won! 🎉$/))) return { type: 'gameWon', player: m[1], text: line };
    if (/^📊 Sending game result/.test(line)) return { type: 'info', text: line };
    if (/^The chain link was resolved\.$/.test(line)) return { type: 'chainLinkResolved', text: line };
    if (/^The combat chain was closed\.$/.test(line)) return { type: 'chainClosed', text: line };
    if ((m = line.match(/^(.+?) is dealing (\d+) arcane damage(?: from (.+))?$/))) return { type: 'arcaneDamage', text: line };
    if (/is dealing \d+ arcane damage\.?$/.test(line)) return { type: 'info', text: line };
    return { type: 'unknown', text: line };
  }

  // ----------------------------------------------------------
  // Extraction d'un bloc de snapshot [LABEL] valeur -> { key: raw }
  // renvoie aussi le texte débarrassé du bloc.
  // ----------------------------------------------------------
  function labelToKey(label) {
    if (label === 'OUVERTURE') return '__opening__';
    const mm = label.match(/^(.+?) #(\d+)$/);
    return mm ? mm[1] + '#' + mm[2] : null;
  }

  function sliceBlock(text, marker) {
    const idx = text.indexOf(marker);
    if (idx < 0) return { rest: text, body: null };
    const nl = text.indexOf('\n', idx);
    const blockStart = nl >= 0 ? nl : idx;
    const nextBlock = text.indexOf('\n=== ', blockStart + 1);
    const blockEnd = nextBlock >= 0 ? nextBlock : text.length;
    const body = text.slice(blockStart, blockEnd);
    const rest = text.slice(0, idx) + text.slice(blockEnd);
    return { rest, body };
  }

  // Combats : attaque/défense EFFECTIVES (buffs compris) captées par le grabber
  // depuis la chaîne de combat Talishar. Une ligne JSON par lien, dans l'ordre.
  function parseChainBlock(text) {
    const { rest, body } = sliceBlock(text, '=== COMBAT CHAIN');
    if (body == null) return { rest: text, chain: [] };
    const chain = [];
    body.trim().split('\n').forEach(l => {
      l = l.trim(); if (!l || l[0] !== '{') return;
      // « blank » = carte-fantôme Talishar (chaîne vide) → ignorée (lien parasite).
      try { const o = JSON.parse(l); if (o && o.card && !/^blank$/i.test(String(o.card).trim())) chain.push(o); } catch (e) { /* ligne ignorée */ }
    });
    return { rest, chain };
  }

  // Stats officielles Talishar embarquées par le grabber (bloc JSON).
  function parseEndStatsBlock(text) {
    const marker = '=== END GAME STATS (Talishar';
    const idx = text.indexOf(marker);
    if (idx < 0) return { rest: text, endStats: null };
    const nl = text.indexOf('\n', idx);
    const nextBlock = text.indexOf('\n=== ', nl + 1);
    const end = nextBlock >= 0 ? nextBlock : text.length;
    const body = text.slice(nl + 1, end).trim();
    const rest = text.slice(0, idx) + text.slice(end);
    let payload = null;
    try { payload = JSON.parse(body.split('\n')[0]); } catch (e) { return { rest, endStats: null }; }
    if (!payload || !payload.byPlayer) return { rest, endStats: null };
    return { rest, endStats: mapEndStats(payload) };
  }

  // Convertit l'objet API Talishar (camelCase) en structure d'affichage
  // simple, du point de vue du joueur local (+ adversaire si dispo).
  function mapEndStats(payload) {
    const myId = payload.myPlayerID || Object.keys(payload.byPlayer)[0];
    const map = (d, pid) => {
      if (!d) return null;
      // Talishar compare winner/firstPlayer au playerID ; ici le playerID
      // fiable est la CLÉ de byPlayer (le champ d.playerID est souvent absent).
      const idN = Number(pid);
      const won = (d.winner != null) ? (Number(d.winner) === idN) : (d.result === 1);
      const firstPlayer = (d.firstPlayer != null) ? (Number(d.firstPlayer) === idN) : false;
      const turns = [];
      if (d.turnResults) {
        Object.keys(d.turnResults).forEach(k => {
          const t = d.turnResults[k];
          const turnNo = t.turnNo != null ? t.turnNo : Number(String(k).replace(/\D/g, ''));
          if (!(turnNo > 0)) return;
          turns.push({
            turn: turnNo, threatened: +t.damageThreatened || 0, dealt: +t.damageDealt || 0,
            taken: +t.damageTaken || 0, blocked: +t.damageBlocked || 0, prevented: +t.damagePrevented || 0,
            lifeGained: +t.lifeGained || 0, pitched: +t.cardsPitched || 0, played: +t.cardsUsed || 0,
            cardsLeft: t.cardsLeft != null ? +t.cardsLeft : null, resourcesUsed: +t.resourcesUsed || 0,
            resourcesLeft: t.resourcesLeft != null ? +t.resourcesLeft : null,
            lifeAtEnd: t.lifeAtTurnEnd != null ? +t.lifeAtTurnEnd : null
          });
        });
        turns.sort((a, b) => a.turn - b.turn);
      }
      // Talishar renvoie certains compteurs en string ("0","1"…) → on coerce en
      // nombre (comme pour turnResults), sinon les agrégations concatènent.
      const cards = (d.cardResults || []).map(c => ({
        name: c.cardName || c.cardId || c.name || '?',
        played: +c.played || 0, blocked: +c.blocked || 0, pitched: +c.pitched || 0,
        discarded: +c.discarded || 0, timesHit: +(c.hits != null ? c.hits : c.timesHit) || 0
      }));
      return {
        won: won, firstPlayer: firstPlayer,
        nbTurns: d.turns != null ? Number(d.turns) : null,
        yourTime: d.yourTime != null ? +d.yourTime : null,
        totalGameTime: d.totalGameTime != null ? +d.totalGameTime : null,
        totals: {
          dealt: d.totalDamageDealt, threatened: d.totalDamageThreatened,
          blocked: d.totalDamageBlocked, prevented: d.totalDamagePrevented,
          lifeGained: d.totalLifeGained, lifeLost: d.totalLifeLost
        },
        averages: {
          value: d.averageValuePerTurn, threatenedPerTurn: d.averageDamageThreatenedPerTurn,
          dealtPerTurn: d.averageDamageDealtPerTurn, threatenedPerCard: d.averageDamageThreatenedPerCard,
          resourcesPerTurn: d.averageResourcesUsedPerTurn, cardsLeftPerTurn: d.averageCardsLeftOverPerTurn,
          combatPerTurn: d.averageCombatValuePerTurn
        },
        turns: turns, cards: cards
      };
    };
    const otherId = Object.keys(payload.byPlayer).find(k => String(k) !== String(myId));
    return { me: map(payload.byPlayer[myId], myId), opp: otherId ? map(payload.byPlayer[otherId], otherId) : null };
  }

  function parseCardSnapshotBlock(text, marker) {
    const out = {};
    const { rest, body } = sliceBlock(text, marker);
    if (body == null) return { rest: text, snapshots: out };
    const lineRe = /^\[(.+?)\]\s*(.*)$/gm;
    let hm;
    while ((hm = lineRe.exec(body))) {
      const key = labelToKey(hm[1].trim());
      if (!key) continue;
      const val = hm[2].trim();
      out[key] = (!val || val === '(vide)') ? [] : val.split(',').map(s => s.trim()).filter(Boolean);
    }
    return { rest, snapshots: out };
  }

  // Bloc terrain : permanents/tokens en jeu, DEUX camps par tour.
  // Format d'une ligne : [LABEL] me: a, b | opp: c, d
  function parseFieldSnapshotBlock(text, marker) {
    const out = {};
    const { rest, body } = sliceBlock(text, marker);
    if (body == null) return { rest: text, snapshots: out };
    const lineRe = /^\[(.+?)\]\s*(.*)$/gm;
    const parseList = s => (!s || /^\(vide\)$/i.test(s.trim())) ? [] : s.split(',').map(x => x.trim()).filter(Boolean);
    let hm;
    while ((hm = lineRe.exec(body))) {
      const key = labelToKey(hm[1].trim());
      if (!key) continue;
      const mm = hm[2].match(/me:\s*(.*?)\s*\|\s*opp:\s*(.*)$/i);
      out[key] = mm ? { me: parseList(mm[1]), opp: parseList(mm[2]) } : { me: [], opp: [] };
    }
    return { rest, snapshots: out };
  }

  // Forme du héros par tour (Arakni se transforme en cours de partie). Valeur =
  // UN nom par camp — surtout PAS de split sur la virgule (« Arakni, Marionette »
  // en contient une). null si non capté / inconnu.
  function parseHeroFormBlock(text, marker) {
    const out = {};
    const { rest, body } = sliceBlock(text, marker);
    if (body == null) return { rest: text, snapshots: out };
    const lineRe = /^\[(.+?)\]\s*(.*)$/gm;
    const clean = s => { s = (s || '').trim(); return (!s || /^\((?:inconnu|vide|non capté)\)$/i.test(s)) ? null : s; };
    let hm;
    while ((hm = lineRe.exec(body))) {
      const key = labelToKey(hm[1].trim());
      if (!key) continue;
      const mm = hm[2].match(/me:\s*(.*?)\s*\|\s*opp:\s*(.*)$/i);
      out[key] = mm ? { me: clean(mm[1]), opp: clean(mm[2]) } : { me: null, opp: null };
    }
    return { rest, snapshots: out };
  }

  // Bloc de COMPTES par tour (ex. arsenal adverse : un entier par tour).
  function parseCountSnapshotBlock(text, marker) {
    const out = {};
    const { rest, body } = sliceBlock(text, marker);
    if (body == null) return { rest: text, snapshots: out };
    const lineRe = /^\[(.+?)\]\s*(.*)$/gm;
    let hm;
    while ((hm = lineRe.exec(body))) {
      const key = labelToKey(hm[1].trim());
      if (!key) continue;
      const n = parseInt(hm[2].trim(), 10);
      out[key] = isFinite(n) ? n : 0;
    }
    return { rest, snapshots: out };
  }

  function parseLifeSnapshotBlock(text, marker) {
    const out = {};
    const { rest, body } = sliceBlock(text, marker);
    if (body == null) return { rest: text, snapshots: out };
    const lineRe = /^\[(.+?)\]\s*(.*)$/gm;
    let hm;
    while ((hm = lineRe.exec(body))) {
      const key = labelToKey(hm[1].trim());
      if (!key) continue;
      const val = hm[2].trim();
      const grab = re => { const m = val.match(re); return m ? parseInt(m[1], 10) : null; };
      out[key] = {
        me: grab(/\bme=(-?\d+)/),
        opp: grab(/\bopp=(-?\d+)/),
        myDeck: grab(/\bmyDeck=(-?\d+)/),
        oppDeck: grab(/\boppDeck=(-?\d+)/)
      };
    }
    return { rest, snapshots: out };
  }

  function parseMetaBlock(text) {
    const meta = {};
    const { rest, body } = sliceBlock(text, '=== META ===');
    if (body == null) return { rest: text, meta };
    const clean = v => (v == null || v === '' || v === '(non capté)') ? null : v;
    const intOf = v => { v = clean(v); if (v == null) return null; const n = parseInt(v, 10); return isFinite(n) ? n : null; };
    const kv = {};
    body.replace(/^([a-z_]+):\s*(.*)$/gim, (_, k, v) => { kv[k.trim()] = v.trim(); return ''; });

    // Sépare "Nom (id)" -> { name, id }
    const splitId = s => {
      s = clean(s); if (!s) return { name: null, id: null };
      const m = s.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      return m ? { name: m[1].trim(), id: m[2].trim() } : { name: s, id: null };
    };
    // Quand une même arme est équipée deux fois (dual-wield), Talishar
    // distingue la copie de la main droite en ajoutant un "R" isolé en fin de
    // nom (ex. "Mark of the Huntsman R"). Ce nom-avec-R ne correspond à
    // aucune carte réelle : la recherche d'image échoue et affiche un
    // emplacement vide. On retire ce suffixe technique — uniquement ce motif
    // précis (un R majuscule isolé, précédé d'un espace, en toute fin) pour
    // ne jamais tronquer un nom de carte qui se terminerait légitimement
    // par R.
    const stripDualWieldSuffix = name => name ? name.replace(/\s+R$/, '') : name;
    // Parse "head=X (id) | chest=Y (id) | ..."
    const parseEq = s => {
      const out = {};
      s = clean(s); if (!s) return out;
      s.split('|').forEach(part => {
        const mm = part.trim().match(/^(\w+)=(.+)$/);
        if (mm && EQ_SLOTS.indexOf(mm[1]) >= 0) {
          const parsed = splitId(mm[2]);
          if (parsed.name) parsed.name = stripDualWieldSuffix(parsed.name);
          out[mm[1]] = parsed;
        }
      });
      return out;
    };

    const myHero = splitId(kv.my_hero), oppHero = splitId(kv.opp_hero);
    meta.capturedWith = clean(kv.captured_with);
    meta.capturedAt = clean(kv.captured_at);
    meta.gameUrl = clean(kv.game_url);
    meta.format = clean(kv.format);
    meta.vsAI = kv.vs_ai == null ? null : /^oui$/i.test(kv.vs_ai.trim());
    meta.myName = clean(kv.me);
    meta.oppName = clean(kv.opponent);
    meta.myHero = myHero.name; meta.myHeroId = myHero.id;
    meta.oppHero = oppHero.name; meta.oppHeroId = oppHero.id;
    meta.myStartLife = intOf(kv.my_start_life);
    meta.oppStartLife = intOf(kv.opp_start_life);
    meta.myStartDeckSize = intOf(kv.my_start_deck_size);
    meta.oppStartDeckSize = intOf(kv.opp_start_deck_size);
    meta.myEquipment = parseEq(kv.my_equipment);
    meta.oppEquipment = parseEq(kv.opp_equipment);
    return { rest, meta };
  }

  // "0-2:1783340536,3-5:1783340538,..." -> map ligne(index brut) -> epoch
  function parseTimestampBlock(text) {
    const { rest, body } = sliceBlock(text, '=== TIMESTAMPS ===');
    if (body == null) return { rest: text, lineTs: null };
    const lineTs = [];
    body.replace(/(\d+)-(\d+):(\d+)/g, (_, a, b, t) => {
      const from = parseInt(a, 10), to = parseInt(b, 10), epoch = parseInt(t, 10);
      for (let i = from; i <= to; i++) lineTs[i] = epoch;
      return '';
    });
    return { rest, lineTs };
  }

  // ----------------------------------------------------------
  // PARSE principal
  // ----------------------------------------------------------
  function parse(rawText) {
    const warnings = [];

    // 1) Extraire les blocs annexes (ordre : timestamps se réfèrent aux
    //    lignes du LOG BRUT, donc on les lit avant de retirer quoi que ce
    //    soit qui décalerait les index — le grabber compte les lignes du
    //    log seul, hors header/blocs, donc on isole d'abord le corps).
    let text = rawText.replace(/\r\n/g, '\n');

    const tsRes = parseTimestampBlock(text); text = tsRes.rest;
    const metaRes = parseMetaBlock(text); text = metaRes.rest;
    const lifeRes = parseLifeSnapshotBlock(text, '=== LIFE SNAPSHOTS'); text = lifeRes.rest;
    const handRes = parseCardSnapshotBlock(text, '=== HAND SNAPSHOTS'); text = handRes.rest;
    const arsRes = parseCardSnapshotBlock(text, '=== ARSENAL SNAPSHOTS'); text = arsRes.rest;
    const oppArsRes = parseCountSnapshotBlock(text, '=== OPP ARSENAL COUNT'); text = oppArsRes.rest;
    const fieldRes = parseFieldSnapshotBlock(text, '=== FIELD SNAPSHOTS'); text = fieldRes.rest;
    const graveRes = parseFieldSnapshotBlock(text, '=== GRAVEYARD SNAPSHOTS'); text = graveRes.rest;
    const banishRes = parseFieldSnapshotBlock(text, '=== BANISH SNAPSHOTS'); text = banishRes.rest;
    const heroFormRes = parseHeroFormBlock(text, '=== HERO FORMS'); text = heroFormRes.rest;
    const endStatsRes = parseEndStatsBlock(text); text = endStatsRes.rest;
    const chainRes = parseChainBlock(text); text = chainRes.rest;
    // Journal structuré brut conservé par le grabber : on le RETIRE du corps (sinon
    // son JSON polluerait les lignes d'événements) mais on le garde à disposition
    // (source pure pour une ré-analyse future si un format change).
    const rawChatRes = sliceBlock(text, '=== RAW CHATLOG'); text = rawChatRes.rest;
    let rawChatLog = null;
    if (rawChatRes.body) { try { rawChatLog = JSON.parse(rawChatRes.body.trim().split('\n')[0]); } catch (e) { /* garde null */ } }
    // Files couleur par nom (rouge/jaune/bleu…), extraites du chatLog brut. Vides
    // pour les vieilles parties (DOM, sans RAW CHATLOG) → repli sans couleur.
    const colorQueues = buildColorQueues(rawChatLog);

    const meta = metaRes.meta;
    const lineTs = tsRes.lineTs;                 // index brut -> epoch (ou null)
    const handSnapshots = handRes.snapshots;
    const arsenalSnapshots = arsRes.snapshots;
    const oppArsenalCounts = oppArsRes.snapshots;
    const fieldSnapshots = fieldRes.snapshots;
    const graveSnapshots = graveRes.snapshots;
    const banishSnapshots = banishRes.snapshots;
    const heroFormSnapshots = heroFormRes.snapshots;
    const lifeSnapshots = lifeRes.snapshots;

    // 2) Corps du log : header + lignes d'événements.
    //    IMPORTANT pour les timestamps : le grabber indexe les lignes
    //    NON VIDES du panneau de log, hors ligne d'en-tête "=== Talishar".
    //    On reconstruit donc le même indexage.
    const allLines = text.split('\n');
    let gameId = null, gameDate = null;
    // header éventuel
    for (const l of allLines) {
      const hm = l.match(/Talishar game (\S+)\s+—\s+(.+?)\s*===/);
      if (hm) { gameId = hm[1]; gameDate = hm[2]; break; }
    }

    // logLines = lignes du log telles que comptées par le grabber
    const logLines = [];
    for (const raw of allLines) {
      const l = raw.trim();
      if (!l) continue;
      if (/^=== Talishar game/.test(l)) continue;
      if (/^═+$/.test(l)) continue;
      logLines.push(l);
    }

    // 3) Découpage en tours
    // Talishar émet DEUX formats de marqueur de début de tour selon le rendu :
    //   · « <joueur>'s turn <n> has begun. »  (format habituel, ligne d'action)
    //   · « Turn <n><joueur> »                 (libellé du séparateur de tour du
    //       panneau, capté collé — nom accolé au numéro). Sur ce 2e format, si on
    //       ne le reconnaît pas, le log se retrouve « sans tour » : tout tombe
    //       dans l'Ouverture → courbe à 1 point, main de départ gonflée, attaques
    //       affichées en réaction. Les deux formats ne coexistent jamais dans un
    //       même log, donc les reconnaître tous les deux ne crée pas de doublon.
    const turnHeaderRe = /^(.+?)'s turn (\d+) has begun\.$/;
    const turnDividerRe = /^Turn (\d+)\s*(\S.*)$/;
    function matchTurnHeader(l) {
      let m = l.match(turnHeaderRe);
      if (m) return { player: m[1].trim(), turnNumber: parseInt(m[2], 10) };
      m = l.match(turnDividerRe);
      if (m) return { player: m[2].trim(), turnNumber: parseInt(m[1], 10) };
      return null;
    }
    const nameSet = new Set();
    const actionNameRe = /^([A-Za-zÀ-ÿ0-9_' .-]+?)\s+(?:played|pitched|passed|blocked with|activated|took \d+ damage|is about to take \d+ damage|auto-passed|conceded the game|gained \d+ life|undid their last action|did not sink a card)/;
    logLines.forEach(l => {
      const th = matchTurnHeader(l);
      if (th) nameSet.add(th.player);
      if (/^Resolving /.test(l)) return;
      const m = l.match(actionNameRe);
      if (m) nameSet.add(m[1].trim());
    });
    const names = Array.from(nameSet);

    const turns = [];
    let current = { player: null, turnNumber: 0, label: 'Ouverture', events: [], _lineIdx: [] };
    turns.push(current);
    const turnCounts = {};

    logLines.forEach((l, idx) => {
      const th = matchTurnHeader(l);
      if (th) {
        const player = th.player, turnNumber = th.turnNumber;
        const key = player + '#' + turnNumber;
        turnCounts[key] = (turnCounts[key] || 0) + 1;
        const suffix = turnCounts[key] > 1 ? ` (reprise ${turnCounts[key]})` : '';
        current = { player, turnNumber, label: `${player} — Tour ${turnNumber}${suffix}`, events: [], _lineIdx: [] };
        turns.push(current);
        return;
      }
      const evt = classifyLine(l);
      if (lineTs && lineTs[idx] != null) evt.ts = lineTs[idx];
      // Couleur exacte par occurrence : on dépile la file FIFO du nom concerné
      // (même ordre que le journal brut). played/pitched/activated = 1 carte ;
      // blocked = plusieurs. Absent → carte mono-couleur ou vieille partie.
      if (evt.type === 'played' || evt.type === 'pitched' || evt.type === 'activated') {
        const c = takeColor(colorQueues, evt.card);
        if (c) { evt.cardId = c.cardId; if (c.pitch) evt.pitch = c.pitch; }
      } else if (evt.type === 'blocked' && Array.isArray(evt.cards)) {
        evt.cardIds = evt.cards.map(nm => { const c = takeColor(colorQueues, nm); return c ? c.cardId : null; });
        evt.pitches = evt.cards.map((nm, i) => { const id = evt.cardIds[i]; return id ? pitchFromCardId(id) : null; });
      }
      current.events.push(evt);
      current._lineIdx.push(idx);
    });

    // 4) Résolution des identités me / opp
    // Ordre de fiabilité des signaux :
    //   1. jet de dé      — nomme l'adversaire, "you" = joueur local
    //   2. équipement     — un joueur qui met en jeu un équipement ADVERSE est
    //                       l'adversaire ; un équipement À MOI prouve que c'est
    //                       moi (utile quand il n'y a pas de jet de dé)
    //   3. META           — mais UNIQUEMENT des noms réels (présents dans les
    //                       en-têtes/actions) ; Talishar renvoie parfois des
    //                       placeholders ("Player 1/2") ou un nom inversé.
    // `names` = vrais joueurs (en-têtes de tour + lignes d'action).

    // 1) jet de dé
    let oppFromRoll = null;
    for (const l of logLines) {
      let m = l.match(/^🎲\s*(.+?) rolled \d+ and you rolled \d+/);   // "ADV rolled X and you rolled Y"
      if (m) { oppFromRoll = m[1].trim(); break; }
      m = l.match(/^🎲\s*you rolled \d+ and (.+?) rolled \d+/);        // "you rolled X and ADV rolled Y"
      if (m) { oppFromRoll = m[1].trim(); break; }
    }

    // 2) équipement (fallback fiable sans jet de dé)
    let oppFromEquip = null, meFromEquip = null;
    {
      const myEq = new Set(Object.values(meta.myEquipment || {}).map(e => e && e.name).filter(Boolean).map(normName));
      const opEq = new Set(Object.values(meta.oppEquipment || {}).map(e => e && e.name).filter(Boolean).map(normName));
      if (myEq.size || opEq.size) {
        for (const l of logLines) {
          const m = l.match(/^(.+?) (?:activated|blocked with) (.+)$/);
          if (!m) continue;
          const who = m[1].trim();
          if (names.indexOf(who) < 0) continue;
          const cards = m[2].split(/ and /).map(normName);
          if (cards.some(c => opEq.has(c))) { oppFromEquip = who; break; }
          if (cards.some(c => myEq.has(c))) { meFromEquip = who; break; }
        }
      }
    }

    const metaMy = meta.myName, metaOpp = meta.oppName;
    const metaMyReal = (metaMy && names.indexOf(metaMy) >= 0) ? metaMy : null;
    const metaOppReal = (metaOpp && names.indexOf(metaOpp) >= 0) ? metaOpp : null;

    let myName = null, oppName = null;
    if (oppFromRoll && names.indexOf(oppFromRoll) >= 0) oppName = oppFromRoll;   // 1
    if (!oppName && oppFromEquip) oppName = oppFromEquip;                        // 2a
    if (!oppName && meFromEquip) myName = meFromEquip;                          // 2b
    if (!oppName && !myName) {                                                  // 3
      if (metaOppReal && metaOppReal !== metaMyReal) oppName = metaOppReal;
      else if (metaMyReal && metaMyReal !== metaOppReal) myName = metaMyReal;
    }
    // dériver l'autre côté à partir des vrais noms
    if (oppName && !myName) myName = names.find(n => n !== oppName) || null;
    if (myName && !oppName) oppName = names.find(n => n !== myName) || null;
    // dernier recours
    if (!myName && names.length) myName = names[0] || null;
    if (!oppName && myName && names.length) oppName = names.find(n => n !== myName) || null;

    // Garde-fou : deux noms identiques = incohérence, on force la distinction
    if (myName && myName === oppName) {
      const other = names.find(n => n !== myName);
      if (other) oppName = other;
    }

    // Avertir si les noms de META étaient faux et ont dû être corrigés
    if (myName && metaMy && metaMy !== myName) {
      warnings.push('Le grabber avait mal identifié les joueurs (« ' + metaMy + ' » / « ' + (metaOpp || '?') + ' ») — identité reconstruite depuis le log : toi = ' + myName + ', adversaire = ' + (oppName || '?') + '.');
    }
    if (!myName) warnings.push('Pseudo du joueur non résolu — le viewer devra demander.');

    // "you" apparaît comme pseudo dans certaines lignes ("you will go first")
    // -> on le remplace par le vrai pseudo local partout où il a été capté.
    if (myName) {
      turns.forEach(t => {
        if (t.player === 'you') t.player = myName;
        t.events.forEach(e => { if (e.player === 'you') e.player = myName; });
      });
    }

    // Attribuer l'ouverture au joueur qui commence (déduction couleurs/arsenal)
    if (turns[0] && (turns[0].player === null || turns[0].player === 'you')) {
      const fpEvt = turns[0].events.find(e => e.type === 'firstPlayer');
      let fp = fpEvt ? fpEvt.player : null;
      if (fp === 'you') fp = myName;
      if (fp) { turns[0].player = fp; turns[0].label = fp + ' — Ouverture (joue en premier)'; }
    }

    // 5) Sanitize : un équipement porté (casque, torse, arme...) ne peut
    // structurellement jamais être une carte de main ou d'arsenal — on le
    // retire s'il s'y trouve. On NE retire RIEN d'autre : les instantanés de
    // main/arsenal viennent exclusivement de TA zone (le grabber ne lit
    // jamais celle de l'adversaire), donc ils ne contiennent que tes cartes.
    // Un ancien nettoyage retirait les cartes « prouvées adverses », mais en
    // miroir (même héros des deux côtés) l'adversaire joue des cartes du même
    // nom que les tiennes, ce qui supprimait à tort tes propres cartes.
    const myEquipNames = new Set(
      Object.values(meta.myEquipment || {}).map(e => e && e.name).filter(Boolean).map(normName)
    );
    if (myEquipNames.size) {
      [handSnapshots, arsenalSnapshots].forEach(snaps => {
        Object.keys(snaps).forEach(k => {
          snaps[k] = (snaps[k] || []).filter(c => !myEquipNames.has(normName(c)));
        });
      });
    }

    // 6) Enrichir chaque tour : snapshots (par nom+numéro du tour) + timing
    function snapKeyFor(t, i) {
      if (t.turnNumber === 0 && i === 0) return '__opening__';
      return (t.player || myName) + '#' + t.turnNumber;
    }
    turns.forEach((t, i) => {
      const key = snapKeyFor(t, i);
      t.snapshotKey = key;
      t.hand = (key in handSnapshots) ? handSnapshots[key] : null;
      t.arsenal = (key in arsenalSnapshots) ? arsenalSnapshots[key] : null;
      // Règle FaB : l'arsenal est toujours vide au tout début de partie (on
      // n'y place une carte qu'à la fin de son propre tour). Quand tu es 2e
      // joueur, le grabber capte l'instantané d'ouverture trop tard et peut y
      // voir une carte déjà arsenalée — on force donc le vide pour l'ouverture.
      if (t.turnNumber === 0) t.arsenal = [];
      // Arsenal ADVERSE : compte de cartes face cachée (0/1) capté par le grabber
      // (le NOM reste inconnu — zone privée). null si non capté (vieux logs).
      // Vide forcé à l'ouverture (même règle FaB que pour mon arsenal).
      t.oppArsenalCount = (t.turnNumber === 0) ? 0 : ((key in oppArsenalCounts) ? oppArsenalCounts[key] : null);
      // Permanents/tokens + cimetière + banni (2 camps) captés par le grabber.
      t.field = (key in fieldSnapshots) ? fieldSnapshots[key] : null;
      t.grave = (key in graveSnapshots) ? graveSnapshots[key] : null;
      t.banish = (key in banishSnapshots) ? banishSnapshots[key] : null;
      // Forme du héros à ce tour (Arakni se transforme) : { me, opp } ou null.
      t.heroForm = (key in heroFormSnapshots) ? heroFormSnapshots[key] : null;
      t.life = (key in lifeSnapshots) ? lifeSnapshots[key] : null;
      t.side = t.player === myName ? 'me' : (t.player === oppName ? 'opp' : null);
      // timing depuis les événements horodatés du tour
      const tss = t.events.map(e => e.ts).filter(v => v != null);
      t.startTs = tss.length ? Math.min.apply(null, tss) : null;
      t.endTs = tss.length ? Math.max.apply(null, tss) : null;
      t.durationSec = (t.startTs != null && t.endTs != null) ? (t.endTs - t.startTs) : null;
    });

    // 6bis) Annulations (undo) : « undid their last action » ANNULE la DERNIÈRE
    // action (jouée / activée / pitchée) du même joueur avant lui, non déjà
    // retirée. Un seul traitement couvre les deux cas Talishar :
    //   · annulation simple : action X puis undo → on retire X. (Avant, une
    //     action annulée UNE seule fois restait affichée — ex. « Flick Knives
    //     activé puis annulé » apparaissait à tort au tour 0.)
    //   · re-log : X, undo, X (rejouée) → on retire l'occurrence ANTÉRIEURE ;
    //     celle re-jouée APRÈS l'undo reste (comportement inchangé).
    turns.forEach(t => {
      const ev = t.events;
      const remove = new Set();
      const isAction = p => p.type === 'played' || p.type === 'activated' || p.type === 'pitched';
      ev.forEach((e, u) => {
        if (e.type !== 'undo') return;
        for (let i = u - 1; i >= 0; i--) {
          if (remove.has(i)) continue;
          const p = ev[i];
          if (isAction(p) && (!e.player || p.player === e.player)) { remove.add(i); break; }
        }
      });
      if (remove.size) t.events = ev.filter((_, i) => !remove.has(i));
    });

    // 7) Vie : série AUTORITÉ depuis les snapshots, fallback reconstruit.
    // startLife : META en priorité, sinon snapshot d'ouverture (qui EST la
    // vie de départ), sinon 40 par défaut (Classic Constructed).
    const openingLife = lifeSnapshots['__opening__'] || null;
    let startLifeMe = meta.myStartLife;
    let startLifeOpp = meta.oppStartLife;
    if (startLifeMe == null && openingLife && openingLife.me != null) startLifeMe = openingLife.me;
    if (startLifeOpp == null && openingLife && openingLife.opp != null) startLifeOpp = openingLife.opp;
    if (startLifeMe == null) startLifeMe = 40;
    if (startLifeOpp == null) startLifeOpp = 40;

    // 7a) reconstruction depuis dégâts/soins (sert de recoupement)
    const life = {}; names.forEach(n => { life[n] = 40; });
    if (myName) life[myName] = startLifeMe;
    if (oppName) life[oppName] = startLifeOpp;
    const lifeHistory = [];
    turns.forEach((t, ti) => {
      t.events.forEach(evt => {
        if (evt.type === 'damageTaken' && evt.amount > 0) {
          if (!(evt.player in life)) life[evt.player] = 40;
          life[evt.player] -= evt.amount;
          lifeHistory.push({ turnIndex: ti, player: evt.player, life: life[evt.player], delta: -evt.amount });
        }
        if (evt.type === 'lifeGained' && evt.amount > 0) {
          if (!(evt.player in life)) life[evt.player] = 40;
          life[evt.player] += evt.amount;
          lifeHistory.push({ turnIndex: ti, player: evt.player, life: life[evt.player], delta: evt.amount });
        }
      });
    });

    // 7b) série par tour : le snapshot (début de tour) fait autorité ; la
    // reconstruction par deltas sert de recoupement et de fallback quand un
    // tour n'a pas de snapshot (vieux logs). On compare le snapshot de début
    // de tour à la reconstruction de FIN du tour précédent (même instant),
    // pour ne pas produire de faux positif dû au décalage d'un tour.
    const lifeSeries = { me: [], opp: [] };
    let reconMe = startLifeMe, reconOpp = startLifeOpp;
    turns.forEach((t, ti) => {
      const snap = t.life;
      // recoupement (tolérance 2 : petits soins/effets non parsés tolérés)
      if (snap && snap.me != null && Math.abs(snap.me - reconMe) > 2)
        warnings.push(`Vie (toi) début tour ${ti} : relevé=${snap.me} vs calcul=${reconMe} — un effet a pu échapper au parseur.`);
      const meVal = (snap && snap.me != null) ? snap.me : reconMe;
      const oppVal = (snap && snap.opp != null) ? snap.opp : reconOpp;
      lifeSeries.me.push(meVal);
      lifeSeries.opp.push(oppVal);
      // base pour le tour suivant : snapshot (autorité) sinon valeur courante,
      // puis on applique les deltas de dégâts/soins du tour courant.
      reconMe = meVal; reconOpp = oppVal;
      lifeHistory.filter(h => h.turnIndex === ti).forEach(h => {
        if (h.player === myName) reconMe += h.delta;
        else if (h.player === oppName) reconOpp += h.delta;
      });
    });

    // 7c) dégâts par tour (pour la chain et les visuels)
    turns.forEach((t, ti) => {
      let dmgToMe = 0, dmgToOpp = 0;
      lifeHistory.forEach(h => {
        if (h.turnIndex !== ti || h.delta >= 0) return;
        if (h.player === myName) dmgToMe += -h.delta;
        else if (h.player === oppName) dmgToOpp += -h.delta;
      });
      t.damageToMe = dmgToMe;
      t.damageToOpp = dmgToOpp;
    });

    // Vie finale : dernier point de la série
    const finalLife = {};
    if (myName) finalLife[myName] = lifeSeries.me.length ? lifeSeries.me[lifeSeries.me.length - 1] : startLifeMe;
    if (oppName) finalLife[oppName] = lifeSeries.opp.length ? lifeSeries.opp[lifeSeries.opp.length - 1] : startLifeOpp;

    // 8) Résultat
    let result = null;
    const wonLine = logLines.find(l => /won! 🎉/.test(l));
    const concedeLine = logLines.find(l => /conceded the game\.$/.test(l));
    // Signal AUTORITAIRE : les stats officielles Talishar (endStats.me.won) se
    // basent sur le NUMÉRO de joueur → fiables même en MIROIR (héros identiques),
    // cas où la ligne « X won! » (par nom de héros) est ambiguë et donnait
    // systématiquement « victoire ». On les privilégie quand elles existent.
    const esMe = endStatsRes.endStats && endStatsRes.endStats.me;
    if (esMe && typeof esMe.won === 'boolean') {
      const iWon = esMe.won;
      result = { winner: iWon ? myName : oppName, loser: iWon ? oppName : myName, byConcession: !!concedeLine, iWon };
    } else if (wonLine) {
      const wm = wonLine.match(/^(.+?)\s*\(.+?\)\s*won! 🎉/);
      const winner = wm ? wm[1] : null;
      const loser = winner ? (winner === myName ? oppName : myName) : null;
      result = { winner, loser, byConcession: !!concedeLine, iWon: myName ? winner === myName : null };
    }

    // 8b) Liens de combat (attaque/défense EFFECTIVES, buffs compris) rattachés
    // aux tours dans l'ordre. Clé = « joueur#tour » (l'ouverture porte aussi la
    // clé grabber '__opening__'). L'appariement carte↔lien se fait à l'affichage.
    turns.forEach(t => {
      const key = (t.player || '') + '#' + t.turnNumber;
      t.chain = chainRes.chain.filter(c => c.turn === key || (t.turnNumber === 0 && c.turn === '__opening__'));
    });

    // 9) Cartes vues
    const cardsSeen = new Set();
    turns.forEach(t => t.events.forEach(e => { if (e.card) cardsSeen.add(e.card); if (e.cards) e.cards.forEach(c => cardsSeen.add(c)); }));

    // 10) Timeline globale
    let startTs = null, endTs = null;
    if (lineTs && lineTs.length) {
      const present = lineTs.filter(v => v != null);
      if (present.length) { startTs = Math.min.apply(null, present); endTs = Math.max.apply(null, present); }
    }
    const durationSec = (startTs != null && endTs != null) ? (endTs - startTs) : null;

    // 11) Stats de base
    let damageDealt = 0, damageTaken = 0, blocks = 0, pitches = 0;
    lifeHistory.forEach(h => { if (h.delta < 0) { if (h.player === myName) damageTaken += -h.delta; else if (h.player === oppName) damageDealt += -h.delta; } });
    turns.forEach(t => t.events.forEach(e => {
      if (e.type === 'blocked' && e.player === myName) blocks++;
      if (e.type === 'pitched' && e.player === myName) pitches++;
    }));
    const stats = {
      damageDealt, damageTaken, blocks, pitches,
      myTurns: turns.filter(t => t.player === myName).length,
      distinctCards: cardsSeen.size
    };

    // 11.5) DIAGNOSTIC DE SANTÉ — invariants qui signalent une partie
    // probablement MAL analysée (typiquement : Talishar change le format du
    // journal). Objectif : rendre la casse VISIBLE (bandeau côté vue) au lieu
    // de produire en silence des données fausses mais plausibles. Chaque test
    // est calibré pour un TAUX DE FAUX POSITIFS quasi nul.
    const health = { ok: true, issues: [] };
    const flagHealth = m => { if (health.issues.indexOf(m) < 0) { health.issues.push(m); health.ok = false; } };
    {
      const realTurns = turns.filter(t => t.turnNumber > 0).length;   // hors Ouverture
      const actionLines = logLines.filter(l => /\b(?:played|activated|pitched|blocked with)\b|took \d+ damage/.test(l)).length;
      // Lignes RESSEMBLANT à un début de tour (tous formats connus + à venir).
      const turnish = logLines.filter(l => /'s turn \d+ has begun|^Turn \d+\S|\[\[TURN_START/.test(l)).length;
      // A. Beaucoup d'actions mais aucun tour découpé → format de tour non reconnu.
      if (actionLines >= 25 && realTurns === 0)
        flagHealth('Aucun tour détecté malgré ' + actionLines + ' actions — le format de début de tour n\'est peut-être plus reconnu.');
      // B. Des marqueurs de tour existent mais n\'ont pas produit de tours.
      else if (turnish >= 2 && realTurns <= 1)
        flagHealth('Des débuts de tour ne sont pas reconnus (' + turnish + ' repérés, ' + realTurns + ' tour(s) construit(s)).');
      // C. Un tour attribué à un joueur inconnu.
      const known = new Set([myName, oppName].filter(Boolean));
      if (known.size === 2) turns.forEach(t => { if (t.player && !known.has(t.player)) flagHealth('Tour attribué à un joueur inattendu : « ' + t.player + ' ».'); });
      // D. Duplication probable du journal : une carte « jouée » un nombre
      //    improbable de fois (un playset = 3 max ; 6+ = journal dupliqué).
      const played = {};
      logLines.forEach(l => { const m = l.match(/ played (.{4,60})$/); if (m) { const k = normName(m[1]); played[k] = (played[k] || 0) + 1; } });
      let worst = 0, worstCard = '';
      for (const k in played) if (played[k] > worst) { worst = played[k]; worstCard = k; }
      if (worst >= 6) flagHealth('Duplication probable du journal : « ' + worstCard + ' » joué ' + worst + ' fois.');
      // E. Joueurs non résolus.
      if (!myName || !oppName) flagHealth('Joueurs non résolus (toi = ' + (myName || '?') + ', adversaire = ' + (oppName || '?') + ').');
    }

    // 12) Assemblage du record normalisé
    const mkPlayer = (name, side) => ({
      name: name || null,
      hero: side === 'me' ? meta.myHero : meta.oppHero,
      heroId: side === 'me' ? meta.myHeroId : meta.oppHeroId,
      startLife: side === 'me' ? startLifeMe : startLifeOpp,
      startDeckSize: side === 'me' ? meta.myStartDeckSize : meta.oppStartDeckSize,
      equipment: side === 'me' ? (meta.myEquipment || {}) : (meta.oppEquipment || {})
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      source: {
        parserVersion: PARSER_VERSION,
        parsedAt: new Date().toISOString(),
        capturedWith: meta.capturedWith || null,
        capturedAt: meta.capturedAt || null,
        gameId: gameId || (meta.gameUrl ? (meta.gameUrl.match(/(\d{4,})/) || [])[1] || null : null),
        gameUrl: meta.gameUrl || null,
        gameDate: gameDate || null
      },
      format: meta.format || null,
      vsAI: meta.vsAI,
      matchup: (meta.myHero && meta.oppHero) ? (meta.myHero + ' vs ' + meta.oppHero) : null,
      players: { me: mkPlayer(myName, 'me'), opp: mkPlayer(oppName, 'opp') },
      playersList: names,           // pour fallback viewer si me non résolu
      myName: myName || null,
      oppName: oppName || null,
      result,
      turns,
      lifeHistory,
      lifeSeries,
      life: finalLife,
      snapshots: { hand: handSnapshots, arsenal: arsenalSnapshots, field: fieldSnapshots, grave: graveSnapshots, banish: banishSnapshots, heroForm: heroFormSnapshots, life: lifeSnapshots },
      timeline: { startTs, endTs, durationSec, lineTs: lineTs || null },
      cardsSeen: Array.from(cardsSeen).sort(),
      stats,
      endStats: endStatsRes.endStats,
      warnings,
      health,
      rawChatLog,
      chain: chainRes.chain
    };
  }

  // Utilitaire d'affichage : "3 min 42 s"
  function formatDuration(sec) {
    if (sec == null) return null;
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m <= 0) return s + ' s';
    return m + ' min' + (s ? ' ' + s + ' s' : '');
  }

  // Comparaison de noms de cartes insensible à la casse, aux espaces, ET au
  // séparateur "//" des cartes à deux modes — Talishar écrit parfois le même
  // nom différemment selon la source interne :
  //  - casse : "Path of Same Ends" (log) vs "Path Of Same Ends" (main)
  //  - séparateur : "Arcane Seeds // Life" (log) vs "Arcane Seeds  Life"
  //    (main, le "//" a disparu et ne laisse que le double espace)
  // Sans cette normalisation, une même carte écrite différemment selon la
  // source est vue comme deux cartes distinctes.
  function normName(s) {
    return (s || '')
      .trim()
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/\s*\/\/?\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ----------------------------------------------------------
  // Couleur / impression exacte des cartes (rouge/jaune/bleu…)
  // ----------------------------------------------------------
  // Talishar identifie chaque impression par un cardId suffixé de la couleur
  // (« scar_for_a_scar_red », « ..._yellow », « ..._blue »). Le pitch en découle :
  // rouge=1, jaune=2, bleu=3. Les cartes mono-impression (armes, équipements,
  // héros, jetons) n'ont pas de suffixe → pitch inconnu (null), couleur unique.
  function pitchFromCardId(id) {
    if (!id) return null;
    if (/_red$/.test(id)) return 1;
    if (/_yellow$/.test(id)) return 2;
    if (/_blue$/.test(id)) return 3;
    return null;
  }

  // Construit, à partir du chatLog BRUT (verbatim, HTML conservé), une file FIFO
  // par nom de carte : chaque entrée d'ACTION (played/pitched/activated/blocked
  // with) porte le(s) <span onmouseover="ShowDetail(event,'…/<cardId>.webp')">Nom
  // </span> de la (des) carte(s) agie(s). On récupère { cardId, pitch } dans
  // l'ordre du journal → aligné 1:1 avec les événements (mêmes entrées, même
  // ordre), ce qui donne la couleur EXACTE par occurrence (gère la même carte
  // jouée en deux couleurs différentes dans la même partie).
  const SHOWDETAIL_RE = /ShowDetail\([^)]*?\/([a-z0-9_]+)\.webp[^)]*\)[^>]*>([^<]+)</gi;
  const ACTION_VERB_RE = /\b(?:played|pitched|activated|blocked with)\b/;
  function buildColorQueues(rawChatLog) {
    const queues = new Map();
    if (!Array.isArray(rawChatLog)) return queues;
    for (const entry of rawChatLog) {
      const raw = String(entry == null ? '' : entry);
      const plain = raw.replace(/<[^>]+>/g, '');
      if (!ACTION_VERB_RE.test(plain)) continue;   // seulement les vraies actions
      SHOWDETAIL_RE.lastIndex = 0;
      let m;
      while ((m = SHOWDETAIL_RE.exec(raw))) {
        const cardId = m[1], name = m[2];
        const key = normName(name);
        if (!key) continue;
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push({ cardId, pitch: pitchFromCardId(cardId) });
      }
    }
    return queues;
  }
  // Dépile la prochaine impression connue pour ce nom (ou null).
  function takeColor(queues, name) {
    const q = queues.get(normName(name));
    return (q && q.length) ? q.shift() : null;
  }

  return { SCHEMA_VERSION, PARSER_VERSION, parse, classifyLine, formatDuration, EQ_SLOTS, normName, pitchFromCardId };
});
