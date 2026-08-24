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

  const SCHEMA_VERSION = 2;   // v2 : ajout de turns[].equipCounters + snapshots.equipCounters
  const PARSER_VERSION = '2.2.0';

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
    // Annotation de coût (voix passive) : « <Carte> was played with a cost of N. »
    // — PAS une action « <joueur> played <carte> ». Sans ce garde-fou, la règle
    // générique plus bas en fait un faux jeu (player=« <Carte> was », card=« with a
    // cost of N. ») qui apparaissait en étape parasite dans la vue Table.
    if (/ was played with a cost of \d+\.?$/.test(line)) return { type: 'info', text: line };
    if ((m = line.match(/^(.+?) played (.+?) from arsenal$/))) return { type: 'played', player: m[1], card: m[2], fromArsenal: true, text: line };
    if ((m = line.match(/^(.+?) played (.+)$/))) return { type: 'played', player: m[1], card: m[2], fromArsenal: false, text: line };
    if ((m = line.match(/^(.+?) pitched (.+)$/))) return { type: 'pitched', player: m[1], card: m[2], text: line };
    if ((m = line.match(/^(.+?) activated (.+)$/))) return { type: 'activated', player: m[1], card: m[2], text: line };
    if ((m = line.match(/^(.+?) blocked with (.+)$/))) { const cards = m[2].replace(/,? and /g, ', ').split(',').map(s => s.trim()).filter(Boolean); return { type: 'blocked', player: m[1], cards, text: line }; }
    if ((m = line.match(/^(.+?) was discarded$/))) return { type: 'discarded', card: m[1], text: line };
    // Bannissement (« <Carte> was banished. ») : Vynnset bannit une carte en début
    // de tour (moteur de Runechant), ou un effet (Cull…) bannit une carte. La ligne
    // ne nomme pas le joueur → la vue Table attribue le camp au joueur actif (ou à
    // MOI si la carte est dans ma main affichée). Sert à matérialiser l'étape banish.
    if ((m = line.match(/^(.+?) was banished\.?$/))) return { type: 'banished', card: m[1].trim(), text: line };
    // Intimidation (ex. Leave Them Hanging) : le camp ciblé bannit une carte FACE
    // CACHÉE (nom masqué par la règle) qui REVIENT en fin de tour. Sans étape
    // explicite, la carte « disparaît » de la main affichée sans raison (game
    // 1923349 : Kindle au tour 1 de Lyath). On matérialise une étape explicative.
    if ((m = line.match(/^(.+?) banishes a card face down$/))) return { type: 'intimidate', player: m[1].trim(), text: line };
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
    // Carte choisie par une capacité (ex. pouvoir d'Oscilio, Constella Intelligence :
    // « Card chosen: <carte> »). La ligne ne nomme pas le joueur → rattachée à
    // l'activation qui précède dans buildTimeline (annotation + retrait de la main).
    if ((m = line.match(/^Card chosen: (.+)$/))) return { type: 'cardChosen', card: m[1].trim(), text: line };
    if ((m = line.match(/^Selected mode(?:s)? for (.+?) (?:is|are): (.+)$/))) return { type: 'modeSelected', card: m[1], mode: m[2], text: line };
    if ((m = line.match(/^(.+?) gains Go Again!$/))) return { type: 'goAgain', card: m[1], text: line };
    if ((m = line.match(/^(.+?) grants go again$/))) return { type: 'goAgain', card: m[1], text: line };
    if ((m = line.match(/^(.+?) auto-passed$/))) return { type: 'autoPassed', player: m[1], text: line };
    if ((m = line.match(/^(.+?) passed priority\. Attempting to end turn\.$/))) return { type: 'endTurn', player: m[1], text: line };
    if ((m = line.match(/^(.+?) passed$/))) return { type: 'passed', player: m[1], text: line };
    if ((m = line.match(/^(.+?) undid their last action$/))) return { type: 'undo', player: m[1], text: line };
    // Annulation CONSENTIE (nécessite l'accord adverse) loggée en 2 lignes :
    //   « X requests to undo the last action » puis « Y allowed undoing the last action ».
    // Talishar y révèle le JEU complet (carte + paiement) → `full:true` demande à la
    // passe d'annulation de retirer le dernier played/activated + ses pitches, pas
    // seulement la dernière action (LIFO). Sans ça, une carte annulée puis rejouée
    // (ex. Deathly Wail) reste en double et apparaît en faux « renfort ».
    if ((m = line.match(/^(.+?) requests to undo the last action$/))) return { type: 'undo', player: m[1], full: true, text: line };
    if (/ allowed undoing the last action$/.test(line)) return { type: 'info', text: line };
    if ((m = line.match(/^(.+?) did not sink a card$/))) return { type: 'info', text: line };
    if ((m = line.match(/^(.+?) was put on the bottom of the deck!$/))) return { type: 'deckManipulation', card: m[1], text: line };
    if (/^⤵️ A card was put on the bottom of the deck\.$/.test(line)) return { type: 'deckManipulation', text: line };
    if ((m = line.match(/^🔄(.+?) deck was shuffled$/))) return { type: 'deckShuffled', text: line };
    if ((m = line.match(/^(.+?) conceded the game\.$/))) return { type: 'conceded', player: m[1], text: line };
    if ((m = line.match(/^(.+?)\s*\((.+?)\)\s*won! 🎉$/))) return { type: 'gameWon', player: m[1], text: line };
    if (/^📊 Sending game result/.test(line)) return { type: 'info', text: line };
    if (/^The chain link was resolved\.$/.test(line)) return { type: 'chainLinkResolved', text: line };
    if (/^The combat chain was closed\.$/.test(line)) return { type: 'chainClosed', text: line };
    // Dégâts d'arcane. Deux formes :
    //  · « <carte> is dealing N arcane damage »            → dégâts MENACÉS (avant prévention), source = la carte.
    //  · « <joueur> is dealing N arcane damage from <src> » → dégâts RÉELS (après prévention), source = <src>.
    // La vue Table n'affiche que les RÉELS (actual) sur l'action responsable.
    if ((m = line.match(/^(.+?) is dealing (\d+) arcane damage(?: from (.+))?$/)))
      return m[3]
        ? { type: 'arcaneDamage', dealer: m[1].trim(), source: m[3].trim(), amount: parseInt(m[2], 10), actual: true, text: line }
        : { type: 'arcaneDamage', source: m[1].trim(), amount: parseInt(m[2], 10), actual: false, text: line };
    if (/is dealing \d+ arcane damage\.?$/.test(line)) return { type: 'info', text: line };
    // Transformation de héros (ex. Arakni) : « <forme> becomes <nouvelle forme> ».
    // Placée en dernier : aucune autre règle ne matche « becomes ».
    if ((m = line.match(/^(.+?) becomes (.+?)\.?$/))) return { type: 'transform', from: m[1].trim(), to: m[2].trim(), text: line };
    return { type: 'unknown', text: line };
  }

  // ----------------------------------------------------------
  // Repli héros : déduire les héros du CORPS du log quand le bloc META ne les
  // donne pas (capture dégradée en repli DOM : « you / your opponent », aucun
  // héros résolu depuis le store). Signal FIABLE : le héros est ce qui se fait
  // CIBLER (les attaques visent le héros par défaut) — les armes/équipements sont
  // des SOURCES de dégâts, pas des cibles. On compte les ciblages par camp :
  //   · « your opponent's <X> was targeted »  → propriétaire nommé ⇒ camp SÛR.
  //   · « 🎯<X> was chosen as the target. »    → sans propriétaire ⇒ rattaché au
  //       camp ADVERSE de l'acteur courant (celui qui vient de jouer/activer).
  // Garde-fou (pas de théâtre d'erreur) : on ne renvoie un héros que s'il est
  // ciblé ≥ 3 fois ET nettement en tête (≥ 2× le 2e) ; sinon null (« inconnu »).
  // PUR (testable en Node). L'activation n'est PAS un signal de héros (les armes
  // s'activent tout autant) — elle sert seulement à savoir qui est l'acteur.
  function deriveHeroesFromLog(logLines) {
    const sideOf = p => {
      p = String(p || '').trim().toLowerCase();
      if (p === 'you') return 'me';
      if (p === 'your opponent') return 'opp';
      return null;
    };
    const tgt = { me: {}, opp: {} };
    const bump = (side, card) => {
      if (!side || !card) return;
      const k = String(card).trim();
      if (k) tgt[side][k] = (tgt[side][k] || 0) + 1;
    };
    let lastActor = null;
    (logLines || []).forEach(l => {
      const e = classifyLine(l);
      if (!e) return;
      if (e.type === 'played' || e.type === 'pitched' || e.type === 'activated' || e.type === 'blocked') {
        const s = sideOf(e.player); if (s) lastActor = s;
      }
      if (e.type === 'targetedSecondary') bump(sideOf(e.owner), e.card);
      else if (e.type === 'targeted' && lastActor) bump(lastActor === 'me' ? 'opp' : 'me', e.target);
    });
    const pick = side => {
      const m = tgt[side];
      let best = null, bestN = 0, second = 0;
      for (const k in m) {
        const v = m[k];
        if (v > bestN) { second = bestN; bestN = v; best = k; }
        else if (v > second) second = v;
      }
      return (best && bestN >= 3 && bestN >= 2 * second) ? best : null;
    };
    return { me: pick('me'), opp: pick('opp') };
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

  // Découpe une liste « a, b, c » où chaque carte peut porter son IMPRESSION sous
  // la forme « Nom (card_id) » (grabber v1.20+, card_id = slug coloré, ex.
  // « meteoric_impact_blue »). Renvoie les NOMS (rétro-compat : logique aval
  // inchangée) ET un tableau parallèle de pitches (1/2/3 ou null). Vieux logs
  // (nom seul) → pitch null. Le motif exige un slug minuscule_underscore, donc
  // une vraie parenthèse de nom (« (…) » avec espaces/majuscules) n'est pas prise.
  function splitCardListWithPitch(val) {
    const names = [], pitches = [];
    if (!val || val === '(vide)') return { names, pitches };
    val.split(',').map(s => s.trim()).filter(Boolean).forEach(tok => {
      const m = tok.match(/^(.*?)\s*\(([a-z0-9_]+)\)$/);
      if (m) { names.push(m[1].trim()); pitches.push(pitchFromCardId(m[2])); }
      else { names.push(tok); pitches.push(null); }
    });
    return { names, pitches };
  }

  function parseCardSnapshotBlock(text, marker) {
    const out = {}, pitchOut = {};
    const { rest, body } = sliceBlock(text, marker);
    if (body == null) return { rest: text, snapshots: out, pitches: pitchOut };
    const lineRe = /^\[(.+?)\]\s*(.*)$/gm;
    let hm;
    while ((hm = lineRe.exec(body))) {
      const key = labelToKey(hm[1].trim());
      if (!key) continue;
      const { names, pitches } = splitCardListWithPitch(hm[2].trim());
      out[key] = names;
      pitchOut[key] = pitches;
    }
    return { rest, snapshots: out, pitches: pitchOut };
  }

  // TIMELINE de MA main : un instantané À CHAQUE CHANGEMENT (dédupliqué par le
  // grabber), clé = POSITION dans le log (nombre de lignes déjà capturées). Sert
  // à la vue Table pour afficher la main fidèle à chaque étape (pioches, filtre
  // du pouvoir de héros, cartes jouées hors main…). Format : [pos] a, b, c.
  // Renvoie un tableau trié par position ; bloc absent (vieux logs) → [].
  function parseHandTimelineBlock(text, marker) {
    const out = [];
    const { rest, body } = sliceBlock(text, marker);
    if (body == null) return { rest: text, timeline: out };
    const lineRe = /^\[(\d+)\]\s*(.*)$/gm;
    let hm;
    while ((hm = lineRe.exec(body))) {
      const pos = parseInt(hm[1], 10);
      if (!isFinite(pos)) continue;
      const { names, pitches } = splitCardListWithPitch(hm[2].trim());
      out.push({ pos, cards: names, pitches });
    }
    out.sort((a, b) => a.pos - b.pos);
    return { rest, timeline: out };
  }

  // TIMELINE du TERRAIN (permanents/tokens en jeu, DEUX camps) à chaque changement.
  // Clé = position de log (comme HAND TIMELINE). Sert à révéler les jetons/auras
  // créés PUIS consommés dans un même tour (ex. Ponder de Turn to Mindfire), que
  // l'instantané par-tour (pris aux frontières de tour) rate. Format d'une ligne :
  //   [pos] me: a, b | opp: c, d
  function parseFieldTimelineBlock(text, marker) {
    const out = [];
    const { rest, body } = sliceBlock(text, marker);
    if (body == null) return { rest: text, timeline: out };
    const lineRe = /^\[(\d+)\]\s*(.*)$/gm;
    const parseList = s => (!s || /^\(vide\)$/i.test(s.trim())) ? [] : s.split(',').map(x => x.trim()).filter(Boolean);
    let hm;
    while ((hm = lineRe.exec(body))) {
      const pos = parseInt(hm[1], 10);
      if (!isFinite(pos)) continue;
      const mm = hm[2].match(/me:\s*(.*?)\s*\|\s*opp:\s*(.*)$/i);
      out.push({ pos, me: mm ? parseList(mm[1]) : [], opp: mm ? parseList(mm[2]) : [] });
    }
    out.sort((a, b) => a.pos - b.pos);
    return { rest, timeline: out };
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

  // Compteurs d'ÉQUIPEMENT par tour (Tunic 1/2/3, -1 counters, jetons de vapeur…),
  // DEUX camps. Valeur = map slot -> entier signé (slots : head/chest/arms/legs/
  // weaponL/weaponR). Format d'une ligne : [LABEL] me: weaponR=2, chest=1 | opp: legs=3
  // Bloc absent (vieux logs) → {} → aucun compteur (rétro-compat, pas d'erreur).
  function parseEquipCounterBlock(text, marker) {
    const out = {};
    const { rest, body } = sliceBlock(text, marker);
    if (body == null) return { rest: text, snapshots: out };
    const lineRe = /^\[(.+?)\]\s*(.*)$/gm;
    const parseMap = s => {
      const m = {};
      if (!s || /^\(aucun\)$/i.test(s.trim())) return m;
      s.split(',').map(x => x.trim()).filter(Boolean).forEach(tok => {
        const mm = tok.match(/^(\w+)\s*=\s*(-?\d+)$/);
        if (mm) { const v = parseInt(mm[2], 10); if (isFinite(v)) m[mm[1]] = v; }
      });
      return m;
    };
    let hm;
    while ((hm = lineRe.exec(body))) {
      const key = labelToKey(hm[1].trim());
      if (!key) continue;
      const mm = hm[2].match(/me:\s*(.*?)\s*\|\s*opp:\s*(.*)$/i);
      out[key] = mm ? { me: parseMap(mm[1]), opp: parseMap(mm[2]) } : { me: {}, opp: {} };
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
          // rawName garde le nom AVANT le retrait du suffixe « R » (dual-wield) :
          // sert d'identité distincte pour la 2e copie d'une même arme (ex. deux
          // « Hunter's Klaive »), le cimetière la nommant aussi avec le « R ».
          if (parsed.name) { parsed.rawName = parsed.name; parsed.name = stripDualWieldSuffix(parsed.name); }
          out[mm[1]] = parsed;
        }
      });
      return out;
    };

    let myHero = splitId(kv.my_hero), oppHero = splitId(kv.opp_hero);
    // Garde-fou : le NOM d'un héros peut être incohérent avec son ID (observé
    // sur une capture dégradée où le grabber a recopié le héros du mauvais
    // camp — l'ID, lui, reste correct). On compare des jetons ≥3 caractères
    // (name normalisé vs id avec « _ » → espace) ; un diacritique isolé (« ð »
    // de Vetreiði) peut casser UN jeton sans casser les autres (« jarl » reste
    // commun) → pas de faux positif. Aucun jeton commun ⇒ le nom ment, on
    // affiche un libellé dérivé de l'ID (qui, lui, fait autorité) à la place.
    // Volontairement PAS un test `health` (health.ok=false exclurait la partie
    // du dashboard) : ici la partie elle-même peut être parfaitement saine
    // (cf. partie réelle #1683807, adversaire juste mal étiqueté) — signalé en
    // `warnings` seulement, la partie reste comptée avec le libellé corrigé.
    const heroLabelIssues = [];
    const heroKeyTokens = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length >= 3);
    const idToTitle = id => id.split('_').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    // Les IDs ne sont pas tous des « slugs » lisibles (« arakni_marionette ») :
    // certaines captures utilisent le numéro de carte Talishar (« ELE001 »),
    // sans rapport textuel avec le nom → on ne compare que les IDs-slugs
    // (minuscules/chiffres/underscores), seul format où l'id « raconte » le nom.
    const isSlugId = id => /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(id || '');
    const fixHeroLabel = (hero, side) => {
      if (!hero.id || !hero.name || !isSlugId(hero.id)) return hero;
      const nameToks = heroKeyTokens(hero.name), idToks = heroKeyTokens(hero.id);
      if (!nameToks.length || !idToks.length) return hero;
      if (nameToks.some(t => idToks.indexOf(t) >= 0)) return hero;
      const fixed = idToTitle(hero.id);
      heroLabelIssues.push('Nom de héros incohérent avec son identifiant (' + side + ') : « ' + hero.name + ' » ne correspond pas à « ' + hero.id + ' » — affiché « ' + fixed + ' » à la place.');
      return { name: fixed, id: hero.id };
    };
    myHero = fixHeroLabel(myHero, 'moi');
    oppHero = fixHeroLabel(oppHero, 'adversaire');
    if (heroLabelIssues.length) meta.heroLabelIssues = heroLabelIssues;
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
    if (metaRes.meta.heroLabelIssues) metaRes.meta.heroLabelIssues.forEach(w => warnings.push(w));
    const lifeRes = parseLifeSnapshotBlock(text, '=== LIFE SNAPSHOTS'); text = lifeRes.rest;
    const handRes = parseCardSnapshotBlock(text, '=== HAND SNAPSHOTS'); text = handRes.rest;
    const handTlRes = parseHandTimelineBlock(text, '=== HAND TIMELINE'); text = handTlRes.rest;
    const fieldTlRes = parseFieldTimelineBlock(text, '=== FIELD TIMELINE'); text = fieldTlRes.rest;
    const arsRes = parseCardSnapshotBlock(text, '=== ARSENAL SNAPSHOTS'); text = arsRes.rest;
    const oppArsRes = parseCountSnapshotBlock(text, '=== OPP ARSENAL COUNT'); text = oppArsRes.rest;
    const fieldRes = parseFieldSnapshotBlock(text, '=== FIELD SNAPSHOTS'); text = fieldRes.rest;
    const graveRes = parseFieldSnapshotBlock(text, '=== GRAVEYARD SNAPSHOTS'); text = graveRes.rest;
    const banishRes = parseFieldSnapshotBlock(text, '=== BANISH SNAPSHOTS'); text = banishRes.rest;
    const heroFormRes = parseHeroFormBlock(text, '=== HERO FORMS'); text = heroFormRes.rest;
    const eqCtrRes = parseEquipCounterBlock(text, '=== EQUIP COUNTERS'); text = eqCtrRes.rest;
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
    // `colorCoverage.fromTurn` = 1er tour réellement présent dans le chatLog brut
    // (0 = complet). Sur une longue partie le chatLog est tronqué en tête : on ne
    // colore qu'à partir de ce tour (cf. rawChatCoverage) pour ne pas coller de
    // fausses couleurs sur les premiers tours.
    const colorCoverage = rawChatCoverage(rawChatLog);
    const colorQueues = buildColorQueues(rawChatLog, colorCoverage.startIndex);

    const meta = metaRes.meta;
    const lineTs = tsRes.lineTs;                 // index brut -> epoch (ou null)
    const handSnapshots = handRes.snapshots;
    const handPitchSnapshots = handRes.pitches;   // impression (1/2/3|null) parallèle à handSnapshots
    const handTimeline = handTlRes.timeline;
    const fieldTimeline = fieldTlRes.timeline;
    const arsenalSnapshots = arsRes.snapshots;
    const oppArsenalCounts = oppArsRes.snapshots;
    const fieldSnapshots = fieldRes.snapshots;
    const graveSnapshots = graveRes.snapshots;
    const banishSnapshots = banishRes.snapshots;
    const heroFormSnapshots = heroFormRes.snapshots;
    const equipCounterSnapshots = eqCtrRes.snapshots;
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
      // Résumé de chaîne condensé « CHAIN LINK N <joueur> played … took N … » :
      // re-rendu collé d'une chaîne repliée (capture DOM dégradée). Multi-actions
      // sur une ligne → illisible et polluant (faux « joueur » = « CHAIN LINK N
      // your opponent »). Le grabber le filtre déjà à la capture ; on le refait
      // ici au cas où un raw ancien déjà stocké serait ré-importé.
      if (/^chain link \d+/i.test(l)) continue;
      logLines.push(l);
    }

    // 2 bis) Repli héros : capture dégradée (DOM) sans bloc META → déduire les
    // héros du corps du log (le plus ciblé par camp). Rétroactif au re-parse :
    // récupère le matchup des parties captées « you / your opponent ». On ne
    // renseigne QUE ce qui manque (META fait autorité quand elle est présente).
    if (!meta.myHero || !meta.oppHero) {
      const dh = deriveHeroesFromLog(logLines);
      if (!meta.myHero && dh.me) { meta.myHero = dh.me; meta.myHeroId = null; }
      if (!meta.oppHero && dh.opp) { meta.oppHero = dh.opp; meta.oppHeroId = null; }
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
    // Insensible à la casse : l'UI Talishar rend parfois le séparateur EN
    // MAJUSCULES (« TURN 1 your opponent », via text-transform CSS → innerText).
    const turnDividerRe = /^turn (\d+)\s*(\S.*)$/i;
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
      // Rejeter les lignes SYSTÈME en voix passive « <Carte> was played with a
      // cost of N. » (matchent actionNameRe via « played ») : « X was » n'est
      // jamais un vrai joueur. Sans ça ce fantôme peut être choisi comme myName
      // quand l'adversaire pose une carte en ouverture avant le tour 1 local.
      if (m && !/ was$/.test(m[1].trim())) nameSet.add(m[1].trim());
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
        // Un même en-tête « <joueur>'s turn N has begun » qui RÉAPPARAÎT = le tour a
        // été REMBOBINÉ (undo remontant au début du tour ; Talishar re-logue tout le
        // tour). Les événements déjà captés pour ce tour sont donc CADUQUES (ex.
        // Oscilio T7, game 1923349 : un Short Shrift re-résolu faisait chuter les PV
        // à 0 avant que la « reprise » ne les réaligne à 2). On RECYCLE le tour
        // existant de même clé (on vide ses événements) au lieu d'en créer un 2e :
        // un seul tour, ne contenant que les événements finaux, et des snapshots
        // (keyés par player#turnNumber) qui restent cohérents.
        if (turnCounts[key] > 1) {
          let prior = null;
          for (let k = turns.length - 1; k >= 0; k--) { if (turns[k].player === player && turns[k].turnNumber === turnNumber) { prior = turns[k]; break; } }
          if (prior) { prior.events = []; prior._lineIdx = []; current = prior; return; }
        }
        current = { player, turnNumber, label: `${player} — Tour ${turnNumber}`, events: [], _lineIdx: [] };
        turns.push(current);
        return;
      }
      const evt = classifyLine(l);
      if (lineTs && lineTs[idx] != null) evt.ts = lineTs[idx];
      // Index de ligne d'origine posé DIRECTEMENT sur l'événement (survit au
      // filtrage undo/dedup, contrairement au tableau parallèle _lineIdx). Sert à
      // corréler chaque étape de la vue Table à la HAND TIMELINE (position = ligne).
      evt._idx = idx;
      // Couleur exacte par occurrence : on dépile la file FIFO du nom concerné
      // (même ordre que le journal brut). played/pitched/activated = 1 carte ;
      // blocked = plusieurs. Absent → carte mono-couleur ou vieille partie.
      // NB : PAS les `discarded` — buildColorQueues n'indexe que les lignes
      // d'ACTION (played/pitched/activated/blocked), pas « X was discarded » ;
      // dépiler pour une défausse volerait la couleur d'un vrai jeu du même nom
      // et désynchroniserait la file (défausse affichée en texte seul, cf. Table).
      // Garde-fou TRONCATURE : n'attribuer une couleur QUE si le tour courant est
      // couvert par le chatLog brut. Avant `colorCoverage.fromTurn`, la file
      // décrirait des occurrences d'autres tours (décalage FIFO) → on s'abstient.
      const colorCovered = current.turnNumber >= colorCoverage.fromTurn;
      if (colorCovered && (evt.type === 'played' || evt.type === 'pitched' || evt.type === 'activated')) {
        const c = takeColor(colorQueues, evt.card);
        if (c) { evt.cardId = c.cardId; if (c.pitch) evt.pitch = c.pitch; }
      } else if (colorCovered && evt.type === 'blocked' && Array.isArray(evt.cards)) {
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
      // Écarter l'équipement PARTAGÉ (les deux camps jouent la même pièce, ex.
      // Fyendal's Spring Tunic, quasi universel) : ambigu, il ferait passer le
      // joueur local pour l'adversaire — c'est CE bug qui inversait les tours de
      // game 2018099 (Fyendal's activé par Oscilio → « opp » car présent aussi
      // côté adverse). On ne garde que les pièces PROPRES à un camp.
      for (const c of Array.from(myEq)) { if (opEq.has(c)) { myEq.delete(c); opEq.delete(c); } }
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

    // 0) HERO FORMS — signal le plus direct : le grabber ne capte QUE la
    //    perspective LOCALE (« me » = joueur local, main/arsenal jamais ceux de
    //    l'adversaire). Plus fiable que l'heuristique d'équipement (qui peut se
    //    tromper sur une pièce partagée — cf. game 2018099). On lit l'ouverture
    //    (forme de base du héros, alignée sur les noms du journal ; les
    //    transformations viennent après) et on n'assigne QUE si me/opp sont
    //    distincts et correspondent à de vrais noms — un miroir (formes
    //    identiques) laisse les autres signaux trancher.
    let myName = null, oppName = null;
    {
      const snaps = heroFormSnapshots || {};
      const keys = Object.keys(snaps);
      const openKey = keys.indexOf('__opening__') >= 0 ? '__opening__' : keys[0];
      const hf = openKey ? snaps[openKey] : null;
      if (hf) {
        const meMatch = hf.me && names.find(n => normName(n) === normName(hf.me));
        const oppMatch = hf.opp && names.find(n => normName(n) === normName(hf.opp));
        if (meMatch && oppMatch && meMatch !== oppMatch) { myName = meMatch; oppName = oppMatch; }
      }
    }
    if (!oppName && !myName && oppFromRoll && names.indexOf(oppFromRoll) >= 0) oppName = oppFromRoll;  // 1
    if (!oppName && !myName && oppFromEquip) oppName = oppFromEquip;             // 2a
    if (!oppName && !myName && meFromEquip) myName = meFromEquip;               // 2b
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

    // Avertir si les noms de META étaient faux et ont dû être corrigés.
    // On ne compare QUE des VRAIS noms de joueurs (metaMyReal, présent dans le
    // journal) : le champ META « me: » vaut souvent le PSEUDO Talishar
    // (« Epitrochasme ») alors que myName est le nom du HÉROS (« Oscilio… ») —
    // deux référentiels distincts qui ne coïncident jamais, ce n'est PAS une
    // mauvaise identification (faux positif écarté).
    if (myName && metaMyReal && metaMyReal !== myName) {
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

    // 4bis) TRONCATURE DU JOURNAL (tampon roulant Talishar)
    // Le `state.game.chatLog` de Talishar est un tampon BORNÉ : sur une partie
    // longue, ses premières lignes défilent hors du tampon avant la capture. Le
    // corps du log DÉMARRE alors en plein milieu (ex. « turn 5 »), la fin du tour
    // précédent reste orpheline (sans en-tête) dans l'Ouverture, et les tours
    // antérieurs n'ont plus de texte — ALORS QUE les instantanés (main/vie/arsenal/
    // formes) et END GAME STATS, eux, couvrent la partie depuis le tour 1. On
    // détecte l'écart et on RECONSTRUIT les tours manquants depuis les instantanés,
    // au lieu de laisser la fin orpheline polluer l'Ouverture (« tour 0 » incohérent :
    // sort sans pitch, Volzar sans cimetière, carte hors main de départ, PV en moins…).
    // NB : on NE marque PAS health.ok=false (la partie est légitime, résultat +
    // endStats complets) pour la garder dans le tableau de bord ; simple `warnings`.
    let truncated = null;
    {
      const realTurns0 = turns.filter(t => t.turnNumber > 0);
      const firstLoggedTurn = realTurns0.length ? Math.min.apply(null, realTurns0.map(t => t.turnNumber)) : 0;
      // n° de tour connus des instantanés (clés « Nom#N »), hors ouverture.
      const snapTurnNos = new Set();
      const collectNos = obj => Object.keys(obj || {}).forEach(k => { const mm = k.match(/#(\d+)$/); if (mm) snapTurnNos.add(parseInt(mm[1], 10)); });
      collectNos(lifeSnapshots); collectNos(handSnapshots); collectNos(heroFormSnapshots);
      const missingTurns = [];
      for (let n = 1; n < firstLoggedTurn; n++) if (snapTurnNos.has(n)) missingTurns.push(n);
      // On ne reconstruit que si les deux joueurs (donc l'ordre de manche) sont connus.
      if (missingTurns.length && myName && oppName) {
        // Ordre intra-manche : 1re manche loggée COMPLÈTE (2 tours consécutifs de
        // même n°). Repli : le 1er tour loggé ouvre la manche.
        let roundOrder = [realTurns0[0].player, realTurns0[0].player === myName ? oppName : myName];
        for (let i = 0; i < realTurns0.length - 1; i++) {
          if (realTurns0[i + 1].turnNumber === realTurns0[i].turnNumber) { roundOrder = [realTurns0[i].player, realTurns0[i + 1].player]; break; }
        }
        // Tour immédiatement AVANT le 1er tour loggé : c'est SA fin orpheline qui est
        // retombée dans l'Ouverture (turns[0]).
        const firstReal = realTurns0[0];
        let precPlayer, precTurn;
        if (firstReal.player === roundOrder[0]) { precPlayer = roundOrder[1]; precTurn = firstLoggedTurn - 1; }
        else { precPlayer = roundOrder[0]; precTurn = firstLoggedTurn; }
        // Fabrique des tours reconstruits (VIDES ; les instantanés les rempliront au
        // §6 via la clé « joueur#tour »). Deux par manche manquante, dans l'ordre.
        const mk = (pl, n) => ({ player: pl, turnNumber: n, label: pl + ' — Tour ' + n + ' (reconstruit)', events: [], _lineIdx: [], reconstructed: true });
        const synth = [];
        missingTurns.forEach(n => { roundOrder.forEach(pl => { synth.push(mk(pl, n)); }); });
        // Le tour « précédent » (fin orpheline) n'est pas toujours dans missingTurns
        // (démarrage en MILIEU de manche) : on l'ajoute alors explicitement.
        let precTurnObj = synth.find(t => t.player === precPlayer && t.turnNumber === precTurn);
        if (!precTurnObj) { precTurnObj = mk(precPlayer, precTurn); synth.push(precTurnObj); }
        // Déplacer la fin orpheline (événements retombés dans l'Ouverture) vers ce
        // tour reconstruit, et rendre à l'Ouverture son seul rôle : la main de départ.
        if (turns[0] && turns[0].events.length) {
          precTurnObj.events = turns[0].events;
          precTurnObj._lineIdx = turns[0]._lineIdx || [];
          precTurnObj.truncatedTail = true;   // début du tour perdu, seule la fin subsiste
          turns[0].events = [];
          turns[0]._lineIdx = [];
        }
        // Insérer entre l'Ouverture et le 1er tour loggé, dans l'ordre chronologique.
        synth.sort((a, b) => (a.turnNumber - b.turnNumber) || (roundOrder.indexOf(a.player) - roundOrder.indexOf(b.player)));
        turns.splice(1, 0, ...synth);
        truncated = { firstLoggedTurn, missingTurns: missingTurns.slice(), count: firstLoggedTurn - 1 };
        warnings.push('Log tronqué par Talishar : le texte des tours 1–' + (firstLoggedTurn - 1) +
          ' manque (tampon de journal roulant, partie longue). Replay partiel — ces tours sont reconstruits depuis les instantanés.');
      }
    }

    // 5) Sanitize : un équipement porté (casque, torse, arme...) ne peut
    // structurellement jamais être une carte de main ou d'arsenal — on le
    // retire s'il s'y trouve. On NE retire RIEN d'autre : les instantanés de
    // main/arsenal viennent exclusivement de TA zone (le grabber ne lit
    // jamais celle de l'adversaire), donc ils ne contiennent que tes cartes.
    // Un ancien nettoyage retirait les cartes « prouvées adverses », mais en
    // miroir (même héros des deux côtés) l'adversaire joue des cartes du même
    // nom que les tiennes, ce qui supprimait à tort tes propres cartes.
    // On retire AUSSI les jetons-artefacts du DOM Talishar : par moments le grabber
    // capte l'emplacement d'ÉQUIPEMENT à la place de la main (ex. « HexagonRedGemGlow-…
    // », le halo de gemme hexagonal superposé aux pièces). Ces captures parasites
    // (équipement + artefact) polluaient la main de certains tours et la HAND
    // TIMELINE. Signature stable : nom normalisé contenant « gemglow ».
    const myEquipNames = new Set(
      Object.values(meta.myEquipment || {}).map(e => e && e.name).filter(Boolean).map(normName)
    );
    const isJunkCard = c => { const n = normName(c); return myEquipNames.has(n) || /gemglow/.test(n); };
    // Instantanés main/arsenal : on filtre le parasite ; un instantané VIDÉ par ce
    // filtrage (il ne contenait QUE du parasite) → null, pour que buildTimeline
    // retombe sur la reconstruction/timeline au lieu d'afficher une main vide.
    [handSnapshots, arsenalSnapshots].forEach(snaps => {
      Object.keys(snaps).forEach(k => {
        const before = snaps[k] || [];
        // Impressions parallèles (main uniquement) : filtrées AUX MÊMES index pour
        // rester alignées sur les noms.
        const pitchArr = (snaps === handSnapshots && Array.isArray(handPitchSnapshots[k])) ? handPitchSnapshots[k] : null;
        const after = [], afterP = [];
        before.forEach((c, ci) => { if (!isJunkCard(c)) { after.push(c); if (pitchArr) afterP.push(pitchArr[ci]); } });
        const emptied = before.length > 0 && after.length === 0;
        snaps[k] = emptied ? null : after;
        if (pitchArr) handPitchSnapshots[k] = emptied ? null : afterP;
      });
    });
    // HAND TIMELINE (fidélité par position, vue Table) : jamais assainie jusqu'ici.
    // On filtre le parasite ET on SUPPRIME les entrées vidées (elles écrasaient la
    // main en cours de tour avec de l'équipement) pour que handAt() garde la
    // dernière main valide.
    for (let i = handTimeline.length - 1; i >= 0; i--) {
      const before = handTimeline[i].cards || [];
      const beforeP = handTimeline[i].pitches || [];
      const after = [], afterP = [];
      before.forEach((c, ci) => { if (!isJunkCard(c)) { after.push(c); afterP.push(beforeP[ci] != null ? beforeP[ci] : null); } });
      if (before.length > 0 && after.length === 0) handTimeline.splice(i, 1);
      else { handTimeline[i].cards = after; handTimeline[i].pitches = afterP; }
    }

    // 6) Enrichir chaque tour : snapshots (par nom+numéro du tour) + timing
    function snapKeyFor(t, i) {
      if (t.turnNumber === 0 && i === 0) return '__opening__';
      return (t.player || myName) + '#' + t.turnNumber;
    }
    // Résumé officiel Talishar par tour (mon côté SEULEMENT — endStats ne couvre
    // que le joueur local). Rattaché à chaque tour ci-dessous ; sert surtout à
    // renseigner les tours reconstruits (dégâts/pitchs/vie sans texte de journal).
    const esMe0 = (endStatsRes.endStats && endStatsRes.endStats.me) || null;

    // Résolution d'instantané TOLÉRANTE À LA FORME du héros. Le grabber écrit le nom
    // des en-têtes de tour en résolvant [[TURN_START]] une fois (forme figée, ex.
    // « Arakni Trap Door » PARTOUT), alors que les libellés d'instantanés portent la
    // forme du MOMENT (« Arakni Marionette #1 »…). Dès qu'Arakni se transforme, la
    // clé exacte (snapKeyFor = player#tour) ne trouve plus l'instantané rangé sous
    // l'ancienne forme → hand/arsenal/vie… null aux tours concernés. On mappe donc
    // le nom de forme d'un libellé vers un CÔTÉ (me/opp) et on retombe, à défaut de
    // clé exacte, sur une clé « X#même-tour » du bon côté.
    const normLoose = s => normName(s || '').replace(/[^a-z0-9]/g, '');
    const formsBySide = { me: new Set(), opp: new Set() };
    const seedForm = (side, n) => { const k = normLoose(n); if (k) formsBySide[side].add(k); };
    seedForm('me', myName); seedForm('opp', oppName);
    if (meta.myHero && meta.myHero.name) seedForm('me', meta.myHero.name);
    if (meta.oppHero && meta.oppHero.name) seedForm('opp', meta.oppHero.name);
    Object.keys(heroFormSnapshots).forEach(k => { const hf = heroFormSnapshots[k]; if (!hf) return; seedForm('me', hf.me); seedForm('opp', hf.opp); });
    // Côté d'un nom de forme : 'me'/'opp'/null. Ambigu (même forme des deux côtés,
    // ex. miroir) → null (on ne devine pas, on garde le comportement exact).
    const sideOfName = n => { const k = normLoose(n); const inMe = formsBySide.me.has(k), inOpp = formsBySide.opp.has(k); return (inMe && !inOpp) ? 'me' : (inOpp && !inMe) ? 'opp' : null; };
    // Renvoie la valeur d'instantané pour ce tour, ou `dflt` si introuvable : clé
    // exacte d'abord, sinon clé de même n° de tour dont le nom mappe sur le même côté.
    const resolveSnap = (map, t, i, dflt) => {
      const key = snapKeyFor(t, i);
      if (key in map) return map[key];
      if (t.turnNumber === 0) return dflt;                        // ouverture : clé unique
      const want = t.player === myName ? 'me' : (t.player === oppName ? 'opp' : null);
      if (!want) return dflt;
      for (const k in map) {
        const mm = k.match(/^(.+)#(\d+)$/);
        if (!mm || parseInt(mm[2], 10) !== t.turnNumber) continue;
        if (sideOfName(mm[1]) === want) return map[k];
      }
      return dflt;
    };

    turns.forEach((t, i) => {
      const key = snapKeyFor(t, i);
      t.snapshotKey = key;
      t.hand = resolveSnap(handSnapshots, t, i, null);
      t.handPitches = resolveSnap(handPitchSnapshots, t, i, null);   // impression parallèle à t.hand
      t.arsenal = resolveSnap(arsenalSnapshots, t, i, null);
      // Règle FaB : l'arsenal est toujours vide au tout début de partie (on
      // n'y place une carte qu'à la fin de son propre tour). Quand tu es 2e
      // joueur, le grabber capte l'instantané d'ouverture trop tard et peut y
      // voir une carte déjà arsenalée — on force donc le vide pour l'ouverture.
      if (t.turnNumber === 0) t.arsenal = [];
      // Arsenal ADVERSE : compte de cartes face cachée (0/1) capté par le grabber
      // (le NOM reste inconnu — zone privée). null si non capté (vieux logs).
      // Vide forcé à l'ouverture (même règle FaB que pour mon arsenal).
      t.oppArsenalCount = (t.turnNumber === 0) ? 0 : resolveSnap(oppArsenalCounts, t, i, null);
      // Permanents/tokens + cimetière + banni (2 camps) captés par le grabber.
      t.field = resolveSnap(fieldSnapshots, t, i, null);
      t.grave = resolveSnap(graveSnapshots, t, i, null);
      t.banish = resolveSnap(banishSnapshots, t, i, null);
      // Forme du héros à ce tour (Arakni se transforme) : { me, opp } ou null.
      t.heroForm = resolveSnap(heroFormSnapshots, t, i, null);
      // Compteurs d'équipement à ce tour (Tunic 1/2/3, -1 counters…) :
      // { me:{slot:val}, opp:{slot:val} } ou null (vieux logs sans le bloc).
      t.equipCounters = resolveSnap(equipCounterSnapshots, t, i, null);
      t.life = resolveSnap(lifeSnapshots, t, i, null);
      t.side = t.player === myName ? 'me' : (t.player === oppName ? 'opp' : null);
      // Stats officielles de CE tour (mon côté) — endStats.turns est numéroté comme
      // le journal (turn_5 = mon tour 5). null côté adverse / vieux logs.
      t.endStatsTurn = (t.side === 'me' && esMe0 && Array.isArray(esMe0.turns))
        ? (esMe0.turns.find(x => x.turn === t.turnNumber) || null) : null;
      // timing depuis les événements horodatés du tour
      const tss = t.events.map(e => e.ts).filter(v => v != null);
      t.startTs = tss.length ? Math.min.apply(null, tss) : null;
      t.endTs = tss.length ? Math.max.apply(null, tss) : null;
      t.durationSec = (t.startTs != null && t.endTs != null) ? (t.endTs - t.startTs) : null;
    });

    // 6bis) Annulations (undo) : « undid their last action » ANNULE la DERNIÈRE
    // action (jouée / activée / pitchée / bloquée) du même joueur avant lui, non
    // déjà retirée. Un seul traitement couvre les cas Talishar observés :
    //   · annulation simple : action X puis undo → on retire X. (Avant, une
    //     action annulée UNE seule fois restait affichée — ex. « Flick Knives
    //     activé puis annulé » apparaissait à tort au tour 0.)
    //   · re-log : X, undo, X (rejouée) → on retire l'occurrence ANTÉRIEURE ;
    //     celle re-jouée APRÈS l'undo reste (comportement inchangé).
    //   · blocage annulé : « blocked with X » puis undo → X reste sinon une
    //     carte de défense fantôme (validé sur un corpus réel : 5 cas concrets).
    // NB : un undo qui n'a plus rien à annuler (clics répétés, ou annulation
    // d'un simple « passed ») ne trouve aucune candidate — c'est attendu (rien
    // à l'écran ne dépendait de ce « passed »), pas une erreur.
    turns.forEach(t => {
      const ev = t.events;
      const remove = new Set();
      const isAction = p => p.type === 'played' || p.type === 'activated' || p.type === 'pitched' || p.type === 'blocked';
      ev.forEach((e, u) => {
        if (e.type !== 'undo') return;
        if (e.full) {
          // Annulation consentie : revert du JEU complet. On remonte au dernier
          // played/activated à annuler et on retire ce jeu + les effets de sa
          // résolution (menace/dégâts d'arcane, dégâts subis, gain de vie, carte
          // choisie, pitch de paiement) situés entre lui et l'undo — sinon une
          // résolution annulée PUIS rejouée est comptée deux fois (ex. game 1930124
          // T8 : Volzar en double + arcane « menacé » cumulé 6+6=12 au lieu de 6).
          // L'action annulée n'appartient PAS forcément au demandeur : dans une
          // annulation consentie l'adversaire peut demander à l'actif d'annuler SON
          // jeu (Hala demande, l'activation de Volzar d'Oscilio est annulée). On
          // vise donc la dernière action DU DEMANDEUR si elle existe (cas game 79),
          // sinon la dernière action de N'IMPORTE QUEL joueur (cas ci-dessus).
          const isPlay = p => p.type === 'played' || p.type === 'activated';
          const isEffect = q => q.type === 'pitched' || q.type === 'arcaneDamage' || q.type === 'damageTaken' || q.type === 'lifeGained' || q.type === 'cardChosen';
          let target = -1;
          if (e.player) { for (let i = u - 1; i >= 0; i--) { if (!remove.has(i) && isPlay(ev[i]) && ev[i].player === e.player) { target = i; break; } } }
          if (target < 0) { for (let i = u - 1; i >= 0; i--) { if (!remove.has(i) && isPlay(ev[i])) { target = i; break; } } }
          if (target >= 0) {
            remove.add(target);
            for (let j = target + 1; j < u; j++) { if (!remove.has(j) && isEffect(ev[j])) remove.add(j); }
          }
          return;
        }
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
      // recoupement (tolérance 2 : petits soins/effets non parsés tolérés). Les
      // tours RECONSTRUITS n'ont pas d'événements → la reconstruction par deltas
      // diverge forcément du snapshot : on ne recoupe pas (faux positifs garantis).
      if (!t.reconstructed && snap && snap.me != null && Math.abs(snap.me - reconMe) > 2)
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
      const turnish = logLines.filter(l => /'s turn \d+ has begun|^turn \d+\s*\S|\[\[TURN_START/i.test(l)).length;
      // A. Beaucoup d'actions mais aucun tour découpé → format de tour non reconnu.
      if (actionLines >= 25 && realTurns === 0)
        flagHealth('Aucun tour détecté malgré ' + actionLines + ' actions — le format de début de tour n\'est peut-être plus reconnu.');
      // B. Des marqueurs de tour existent mais n\'ont pas produit de tours.
      else if (turnish >= 2 && realTurns <= 1)
        flagHealth('Des débuts de tour ne sont pas reconnus (' + turnish + ' repérés, ' + realTurns + ' tour(s) construit(s)).');
      // C. Un tour attribué à un joueur inconnu.
      const known = new Set([myName, oppName].filter(Boolean));
      if (known.size === 2) turns.forEach(t => { if (t.player && !known.has(t.player)) flagHealth('Tour attribué à un joueur inattendu : « ' + t.player + ' ».'); });
      // D. Duplication probable du journal : le grabber a pu RÉ-EMPILER tout le
      //    journal (bug historique « logs géants » où chaque poll ré-append tout).
      //    Signature = de la LARGEUR : BEAUCOUP de cartes distinctes jouées un
      //    nombre improbable de fois. On exige ≥3 cartes à 6+ plays. Une SEULE
      //    carte qui pique (ex. « Gone in a Flash », un instant rejoué des deux
      //    côtés d'un miroir arcane — game 2112693) est LÉGITIME : le compte est
      //    tous joueurs confondus et certaines cartes récurrent → ne PAS exclure
      //    la partie du dashboard pour ça.
      const played = {};
      logLines.forEach(l => { const m = l.match(/ played (.{4,60})$/); if (m) { const k = normName(m[1]); played[k] = (played[k] || 0) + 1; } });
      const heavy = Object.keys(played).filter(k => played[k] >= 6).sort((a, b) => played[b] - played[a]);
      if (heavy.length >= 3)
        flagHealth('Duplication probable du journal : ' + heavy.length + ' cartes jouées 6+ fois (ex. « ' + heavy[0] + ' » ×' + played[heavy[0]] + ').');
      // E. Joueurs non résolus.
      if (!myName || !oppName) flagHealth('Joueurs non résolus (toi = ' + (myName || '?') + ', adversaire = ' + (oppName || '?') + ').');
      // F. Nom de joueur = TEXTE D'UI parasite (« Unknown's Turn », « PRIORITY »)
      //    scrapé par erreur : signature d'une capture prise sur l'écran replay/
      //    résumé Talishar, où l'état n'est plus lisible (game fantôme #1750820).
      //    À NE PAS confondre avec « (non capté) »/« you »/« your opponent », qui
      //    sont légitimes (adversaire anonyme, repli DOM d'une VRAIE partie —
      //    game 1977204). Miroir du garde-fou `isUiGarbageName` du grabber.
      const isUiGarbageName = n => /^(?:unknown'?s turn|priority)$/i.test(String(n == null ? '' : n).trim());
      [meta.myName, meta.oppName, myName, oppName].forEach(n => {
        if (isUiGarbageName(n)) flagHealth('Nom de joueur suspect « ' + String(n).trim() + ' » (texte d’UI) — capture probablement prise sur l’écran replay/résumé.');
      });
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
      handTimeline,                 // [{ pos, cards }] triés — main fidèle par position de log (vue Table)
      fieldTimeline,                // [{ pos, me, opp }] triés — terrain fidèle par position (jetons éphémères)
      lifeHistory,
      lifeSeries,
      life: finalLife,
      snapshots: { hand: handSnapshots, arsenal: arsenalSnapshots, field: fieldSnapshots, grave: graveSnapshots, banish: banishSnapshots, heroForm: heroFormSnapshots, equipCounters: equipCounterSnapshots, life: lifeSnapshots },
      timeline: { startTs, endTs, durationSec, lineTs: lineTs || null },
      cardsSeen: Array.from(cardsSeen).sort(),
      stats,
      endStats: endStatsRes.endStats,
      truncated,                    // { firstLoggedTurn, missingTurns, count } si journal tronqué, sinon null
      warnings,
      health,
      rawChatLog,
      colorCoverageFromTurn: colorCoverage.fromTurn,   // 0 = complet ; >0 = couleurs indisponibles avant ce tour (chatLog tronqué)
      chain: chainRes.chain
    };
  }

  // Rapproche le nom d'une carte-héros du libellé de héros (tolérant au préfixe
  // et à la virgule) : couvre les formes blitz/adulte (« Oscilio » ⊂ « Oscilio,
  // Constella Intelligence »). Même logique que côté dashboard (Oscilio).
  function heroCardMatch(cardName, heroName) {
    const clean = s => normName(s).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const a = clean(cardName), b = clean(heroName);
    if (!a || !b) return false;
    return a === b || (b + ' ').indexOf(a + ' ') === 0 || (a + ' ').indexOf(b + ' ') === 0;
  }

  // STATS PAR PARTIE (pures, testables) dérivées du record normalisé. Conscientes
  // du CAMP : une même carte (Symbiosis Shot, Valiant Dynamo) peut être jouée par
  // TOI ou par l'ADVERSAIRE — on la détecte des deux côtés. Renvoie :
  //  - weapons : [{ side:'me'|'opp', name, count }] — attaques faites avec une arme
  //    équipée (weaponL/weaponR), = liens de chaîne sur les tours de ce camp dont
  //    l'attaquant est cette arme. Générique tous héros ; pour Dash I/O = tirs de
  //    Symbiosis Shot. Seules les armes ayant ≥1 attaque figurent.
  //  - heroPowerActivations : nb de fois où TOI tu as activé ton pouvoir de héros
  //    (event « activated » dont la carte = ta carte-héros, quel que soit le tour).
  //  - dynamo : [{ side, resets }] — resets de Valiant Dynamo par camp qui l'équipe.
  //    Reconstruit depuis le journal (lignes « X blocked with Valiant Dynamo »,
  //    natives du chatlog, présentes quelle que soit la version du grabber) : chaque
  //    blocage pose un marqueur -1 ; un tour du porteur avec ≥2 attaques à l'arme en
  //    retire UN seul (le compteur remonte). resets = nb de retraits effectifs.
  // Source de vérité = log parsé ; rien d'applicable → listes vides (pas d'erreur).
  function computeGameStats(rec) {
    const out = { weapons: [], heroPowerActivations: 0, dynamo: [] };
    if (!rec) return out;
    const players = rec.players || {};
    const sides = [
      { key: 'me', name: rec.myName || null, hero: players.me && players.me.hero, eq: (players.me && players.me.equipment) || {} },
      { key: 'opp', name: rec.oppName || null, hero: players.opp && players.opp.hero, eq: (players.opp && players.opp.equipment) || {} }
    ];
    const turns = Array.isArray(rec.turns) ? rec.turns : [];

    sides.forEach(side => {
      // Armes équipées (weaponL/weaponR) de ce camp : normName -> nom affiché.
      const weapons = new Map();
      ['weaponL', 'weaponR'].forEach(slot => {
        const nm = side.eq[slot] && side.eq[slot].name;
        if (nm) weapons.set(normName(nm), nm);
      });
      const wCount = {};   // normName -> nb d'attaques (total)
      // Ce camp équipe-t-il Valiant Dynamo ?
      const hasDynamo = Object.keys(side.eq).some(slot => {
        const nm = side.eq[slot] && side.eq[slot].name;
        return nm && normName(nm) === 'valiant dynamo';
      });
      let dynMarkers = 0, dynResets = 0;

      turns.forEach(t => {
        // Nb d'attaques à l'arme de CE camp SUR CE TOUR (liens de chaîne).
        let turnWeaponAtk = 0;
        if (weapons.size && side.name && t.player === side.name) {
          (t.chain || []).forEach(link => {
            const key = normName(link && link.card || '');
            if (weapons.has(key)) { wCount[key] = (wCount[key] || 0) + 1; turnWeaponAtk++; }
          });
        }
        // Pouvoir de héros : seulement pour MON camp (« à chaque fois que TU l'actives »).
        if (side.key === 'me' && side.hero) {
          (t.events || []).forEach(e => {
            if (e.type === 'activated' && (!side.name || e.player === side.name) && heroCardMatch(e.card, side.hero)) {
              out.heroPowerActivations++;
            }
          });
        }
        // Valiant Dynamo : marqueur -1 à chaque blocage AVEC (n'importe quel tour) ;
        // un reset quand le porteur attaque ≥2 fois à l'arme dans son tour (retire un
        // seul marqueur s'il en reste). Ordre du journal respecté (bloc puis attaques).
        if (hasDynamo) {
          (t.events || []).forEach(e => {
            if (e.type === 'blocked' && Array.isArray(e.cards) && e.cards.some(c => normName(c) === 'valiant dynamo')) dynMarkers++;
          });
          if (side.name && t.player === side.name && turnWeaponAtk >= 2 && dynMarkers > 0) { dynMarkers--; dynResets++; }
        }
      });

      weapons.forEach((name, key) => {
        if (wCount[key]) out.weapons.push({ side: side.key, name, count: wCount[key] });
      });
      if (hasDynamo) out.dynamo.push({ side: side.key, resets: dynResets });
    });
    return out;
  }

  // Utilitaire d'affichage : "3 min 42 s"
  function formatDuration(sec) {
    if (sec == null) return null;
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m <= 0) return s + ' s';
    return m + ' min' + (s ? ' ' + s + ' s' : '');
  }

  // Comparaison de noms de cartes insensible à la casse, aux espaces, au
  // séparateur "//" des cartes à deux modes, ET au tiret — Talishar écrit
  // parfois le même nom différemment selon la source interne :
  //  - casse : "Path of Same Ends" (log) vs "Path Of Same Ends" (main)
  //  - séparateur : "Arcane Seeds // Life" (log) vs "Arcane Seeds  Life"
  //    (main, le "//" a disparu et ne laisse que le double espace)
  //  - tiret : "Under the Trap-Door" (log) vs "Under The Trap Door" (repli
  //    DOM du grabber, qui reconstruit le nom depuis le fichier image et
  //    remplace le tiret par un espace — cf. slugToName côté grabber)
  // Sans cette normalisation, une même carte écrite différemment selon la
  // source est vue comme deux cartes distinctes.
  function normName(s) {
    return (s || '')
      .trim()
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/\s*\/\/?\s*/g, ' ')
      .replace(/-/g, ' ')
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
  const RAW_TURN_START_RE = /\[\[TURN_START:(\d+):\d+\]\]/;

  // Le `chatLog` de Talishar (state.game) est un TAMPON BORNÉ : sur une longue
  // partie il ne conserve que les DERNIERS tours — les premiers ont défilé. Le
  // journal TEXTE, lui, est recousu par le grabber (stitch, cf. user-script) et
  // reste complet. Résultat : la file couleur (bâtie sur le chatLog brut) ne
  // couvre QUE les tours encore présents, alors que les événements couvrent TOUTE
  // la partie → un simple FIFO colle les couleurs des tours tardifs sur les tours
  // du début (Meteoric Impact rouge affiché en bleu, etc.). On situe donc la
  // FENÊTRE couverte par le chatLog brut : `fromTurn` = 1er tour réellement
  // présent ; `startIndex` = 1re entrée à ce tour (on ignore un éventuel fragment
  // de tour partiel en tête). Les événements AVANT `fromTurn` n'ont pas de couleur
  // fiable → on ne colore pas (mieux vaut aucune couleur qu'une fausse).
  function rawChatCoverage(rawChatLog) {
    if (!Array.isArray(rawChatLog) || !rawChatLog.length) return { fromTurn: 0, startIndex: 0 };
    let firstIdx = -1, firstTurn = null;
    for (let i = 0; i < rawChatLog.length; i++) {
      const m = String(rawChatLog[i] == null ? '' : rawChatLog[i]).match(RAW_TURN_START_RE);
      if (m) { firstIdx = i; firstTurn = +m[1]; break; }
    }
    // Aucun marqueur repérable, ou fenêtre COMPLÈTE (démarre au tour 1 / à
    // l'ouverture) → on colore partout, file bâtie sur tout le chatLog.
    if (firstTurn == null || firstTurn <= 1) return { fromTurn: 0, startIndex: 0 };
    // Fenêtre TRONQUÉE : on ne colore qu'à partir de `firstTurn`, et la file
    // démarre au 1er marqueur (le fragment de tour partiel éventuel avant lui est
    // ignoré pour rester aligné 1:1 avec les événements des tours couverts).
    return { fromTurn: firstTurn, startIndex: firstIdx };
  }

  function buildColorQueues(rawChatLog, startIndex) {
    const queues = new Map();
    if (!Array.isArray(rawChatLog)) return queues;
    const from = startIndex > 0 ? startIndex : 0;
    for (let i = from; i < rawChatLog.length; i++) {
      const entry = rawChatLog[i];
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

  return { SCHEMA_VERSION, PARSER_VERSION, parse, classifyLine, formatDuration, EQ_SLOTS, normName, pitchFromCardId, computeGameStats, heroCardMatch };
});
