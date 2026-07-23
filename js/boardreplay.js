/* ============================================================
 * BOARD REPLAY — rejeu d'une partie sur une « table » façon Talishar,
 * avec une timeline (slider) qui déroule les actions une à une.
 *
 * API : BoardReplay.mount(container, GAME) → construit la table + la
 * timeline pour le record parsé courant. buildTimeline(GAME) reconstruit
 * l'état du plateau à chaque étape (main / pitch / arsenal / cimetière /
 * PV) à partir des événements du log.
 *
 * Deux garde-fous importants :
 *  - toutes les classes sont préfixées « br- » (le site a déjà .verdict,
 *    .card, .slot… : aucune collision possible) ;
 *  - la PROPRIÉTÉ d'une carte suit e.player (pas le joueur du tour) :
 *    une carte jouée en réaction par l'adversaire lui est bien attribuée.
 * ============================================================ */
(function (root) {
  'use strict';
  const CI = root.CardImages || {};
  const TP = root.TalisharParser || {};
  const norm = s => (TP.normName ? TP.normName(s) : String(s || '').trim().toLowerCase());
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- Images (cache local ; CardImages cache déjà côté réseau) ----------
  const _img = {};
  function resolveImg(name, hero, pitch) {
    pitch = (pitch === 1 || pitch === 2 || pitch === 3) ? pitch : null;
    const k = (hero ? 'H:' : '') + norm(name) + (pitch ? '#p' + pitch : '');
    if (_img[k] !== undefined) return Promise.resolve(_img[k]);
    const fn = hero ? (CI.resolveHeroCardImage || CI.resolveCardImage) : CI.resolveCardImage;
    if (!fn) return Promise.resolve(null);
    // Le héros n'a qu'une impression → on ne lui passe jamais de pitch.
    return fn(name, hero ? undefined : pitch).then(u => (_img[k] = u || null)).catch(() => (_img[k] = null));
  }
  function paintArt(scope) {
    scope.querySelectorAll('.br-art[data-card]').forEach(art => {
      if (art.dataset.painted) return;
      const name = art.getAttribute('data-card');
      if (!name) return;
      art.dataset.painted = '1';
      const pv = parseInt(art.getAttribute('data-pitch'), 10);
      resolveImg(name, art.hasAttribute('data-hero'), pv).then(u => {
        if (!u) return;
        art.style.backgroundImage = 'url("' + u + '")';
        art.classList.add('has-img');
        // La carte porte déjà son nom imprimé → on masque le nom en
        // surimpression (marqueur sur la tuile parente ; cf. CSS .br-imgok).
        const tile = art.closest('.br-gcard,.br-zcard,.br-pcard,.br-tok');
        if (tile) tile.classList.add('br-imgok');
      });
    });
  }

  // ============================================================
  // RECONSTRUCTION — GAME parsé → liste d'étapes { turn, actor, stage, state }
  // ============================================================
  function equipSet(pl) { const s = {}; const e = (pl && pl.equipment) || {}; Object.keys(e).forEach(k => { if (e[k] && e[k].name) s[norm(e[k].name)] = 1; }); return s; }
  // Noms normalisés des ARMES uniquement (slots weaponL/weaponR) — pour les
  // exclure du grisé « utilisé » (une arme qui attaque n'est pas « épuisée »).
  function weaponSet(pl) { const s = {}; const e = (pl && pl.equipment) || {}; ['weaponL', 'weaponR'].forEach(k => { if (e[k] && e[k].name) s[norm(e[k].name)] = 1; }); return s; }
  // Clé d'IDENTITÉ d'une pièce d'équipement : le nom BRUT (avant retrait du
  // suffixe « R » dual-wield par le parseur) si connu, sinon le nom affiché.
  // Sert à distinguer deux copies d'une même arme (ex. deux « Hunter's Klaive »
  // en weaponL/weaponR) — le cimetière nomme la copie détruite avec son « R »,
  // ce que le nom affiché (stripé) ne porte plus. Pièce à nom unique : identique
  // à norm(name) → comportement inchangé.
  function rawKey(it) { return it ? norm(it.rawName || it.name) : null; }
  // Set des clés d'identité (rawKey) de tout l'équipement d'un joueur — miroir
  // de equipSet() mais indexé pour matcher le cimetière/banni (qui peut nommer
  // une pièce avec son suffixe dual-wield).
  function equipRawSet(pl) { const s = {}; const e = (pl && pl.equipment) || {}; Object.keys(e).forEach(k => { const k2 = rawKey(e[k]); if (k2) s[k2] = 1; }); return s; }

  function buildTimeline(GAME) {
    const MY = GAME.myName, OPP = GAME.oppName;
    const HERO = { me: (GAME.players.me && GAME.players.me.hero) || MY, opp: (GAME.players.opp && GAME.players.opp.hero) || OPP };
    // Forme COURANTE du héros (certains — Arakni — se transforment en cours de
    // partie). Mise à jour tour par tour depuis t.heroForm ; chaque étape en
    // garde une copie pour que le plateau affiche la bonne forme.
    const curForm = { me: HERO.me, opp: HERO.opp };
    // Même héros ? Comparaison qui ignore virgule/apostrophe/casse/espaces :
    // « Arakni, Marionette » (méta) == « Arakni Marionette » (forme captée) →
    // pas de FAUSSE transformation au 1er tour. (norm() seul ne retire pas la virgule.)
    const sameHero = (a, b) => norm(a).replace(/[^a-z0-9]/g, '') === norm(b).replace(/[^a-z0-9]/g, '');
    const EQ = { me: equipSet(GAME.players.me), opp: equipSet(GAME.players.opp) };
    const WPN = { me: weaponSet(GAME.players.me), opp: weaponSet(GAME.players.opp) };
    // Clés d'identité (nom brut, avec suffixe dual-wield) : pour distinguer au
    // cimetière laquelle des deux copies d'une même arme a été détruite.
    const EQRAW = { me: equipRawSet(GAME.players.me), opp: equipRawSet(GAME.players.opp) };
    const sideOf = p => (p === MY ? 'me' : 'opp');
    // ------------------------------------------------------------------
    // ARMES CRÉÉES EN JEU (ex. Graphene Chelicera, pouvoir Arakni, Orb-Weaver) :
    // absentes de l'équipement de départ (META), elles n'apparaissent nulle part
    // sur un plateau construit une fois pour toutes depuis ce seul instantané.
    // Détection heuristique, la COMBAT CHAIN faisant autorité sur l'attaquant
    // (cf. CLAUDE.md §7) : une carte ACTIVÉE par un camp, absente de son
    // équipement connu ET de toutes ses formes de héros (Arakni…), qui apparaît
    // comme ATTAQUANT dans la chaîne de combat de CE tour ET n'est JAMAIS vue au
    // cimetière (sinon ce serait une carte-action jouée puis défaussée, pas une
    // arme qui reste en jeu) → traitée comme une arme créée. Une fois détectée,
    // fusionnée dans EQ/WPN/EQRAW : la destruction (cimetière/banni, ligne
    // « was destroyed ») et le non-grisage « arme active » la couvrent ensuite
    // automatiquement, comme n'importe quelle arme d'équipement.
    // ------------------------------------------------------------------
    const FORMS = { me: {}, opp: {} };
    const formKey = s => norm(s).replace(/[^a-z0-9]/g, '');
    const addForm = (sd, nm) => { if (nm) FORMS[sd][formKey(nm)] = 1; };
    addForm('me', HERO.me); addForm('opp', HERO.opp);
    (GAME.turns || []).forEach(t => { if (t.heroForm) { addForm('me', t.heroForm.me); addForm('opp', t.heroForm.opp); } });
    const everGrave = { me: {}, opp: {} };
    (GAME.turns || []).forEach(t => {
      if (!t.grave) return;
      (t.grave.me || []).forEach(c => { everGrave.me[norm(c)] = 1; });
      (t.grave.opp || []).forEach(c => { everGrave.opp[norm(c)] = 1; });
    });
    const createdWeapons = { me: [], opp: [] };
    const createdKeys = { me: {}, opp: {} };
    (GAME.turns || []).forEach(t => {
      const chainCards = {};
      (t.chain || []).forEach(c => { if (c && c.card) chainCards[norm(c.card)] = 1; });
      (t.events || []).forEach(e => {
        if (e.type !== 'activated' || !e.player) return;
        const sd = sideOf(e.player), k = norm(e.card);
        if (createdKeys[sd][k] || EQ[sd][k] || FORMS[sd][formKey(e.card)] || everGrave[sd][k] || !chainCards[k]) return;
        createdKeys[sd][k] = 1;
        createdWeapons[sd].push({ name: e.card, key: k });
      });
    });
    ['me', 'opp'].forEach(sd => {
      createdWeapons[sd].forEach(cw => { EQ[sd][cw.key] = 1; WPN[sd][cw.key] = 1; EQRAW[sd][cw.key] = 1; });
    });
    const isEquip = (side, card) => !!EQ[side][norm(card)];
    const ls = GAME.lifeSeries || { me: [], opp: [] };

    const st = {
      meHandCards: [], meHandCount: 0, meFaceUp: false, oppHandCount: 4,
      mePitch: [], oppPitch: [], meArsenal: [], oppArsenalCount: 0,
      meGrave: [], oppGrave: [], meBanish: [], oppBanish: [], meTokens: [], oppTokens: [],
      meEquipGone: [], oppEquipGone: [], meEquipUsed: [], oppEquipUsed: [], meBorn: [], oppBorn: [], life: { me: 0, opp: 0 }
    };
    const steps = [];
    const snap = () => ({
      meHandCards: st.meHandCards.slice(), meHandCount: st.meHandCount, meFaceUp: st.meFaceUp, oppHandCount: st.oppHandCount,
      mePitch: st.mePitch.slice(), oppPitch: st.oppPitch.slice(), meArsenal: st.meArsenal.slice(), oppArsenalCount: st.oppArsenalCount,
      meGrave: st.meGrave.slice(), oppGrave: st.oppGrave.slice(), meBanish: st.meBanish.slice(), oppBanish: st.oppBanish.slice(),
      meTokens: st.meTokens.slice(), oppTokens: st.oppTokens.slice(),
      meEquipGone: st.meEquipGone.slice(), oppEquipGone: st.oppEquipGone.slice(),
      meEquipUsed: st.meEquipUsed.slice(), oppEquipUsed: st.oppEquipUsed.slice(),
      meBorn: st.meBorn.slice(), oppBorn: st.oppBorn.slice(), life: { me: st.life.me, opp: st.life.opp }
    });
    const push = (turn, actor, stage, hit) => steps.push({ turn, actor, stage, hit: hit || null, form: { me: curForm.me, opp: curForm.opp }, state: snap() });
    const rm = (a, n) => { const k = a.findIndex(x => norm(x) === norm(n)); if (k >= 0) { a.splice(k, 1); return true; } return false; };
    const removeCard = (side, card) => {
      if (side === 'me') { if (st.meFaceUp) { if (!rm(st.meHandCards, card)) rm(st.meArsenal, card); } else st.meHandCount = Math.max(0, st.meHandCount - 1); }
      else st.oppHandCount = Math.max(0, st.oppHandCount - 1);
    };
    const addPitch = (side, c) => (side === 'me' ? st.mePitch : st.oppPitch).push(c);
    const toGrave = (side, c) => (side === 'me' ? st.meGrave : st.oppGrave).push(c);

    (GAME.turns || []).forEach((t, idx) => {
      const attacker = t.player;
      if (ls.me[idx] != null) st.life.me = ls.me[idx];
      if (ls.opp[idx] != null) st.life.opp = ls.opp[idx];
      st.mePitch = []; st.oppPitch = [];   // le pitch part au deck en fin de tour
      st.meEquipUsed = []; st.oppEquipUsed = [];   // « équipement utilisé » se réarme à chaque tour

      // t.hand / t.arsenal sont TOUJOURS les instantanés du joueur (moi), quel
      // que soit le tour. Mon arsenal est donc toujours à jour — y compris une
      // carte mise en arsenal en fin de mon tour, visible dès le tour suivant.
      st.meArsenal = (t.arsenal || []).slice();
      // Tokens/permanents en jeu : UNIQUEMENT les données réelles du terrain
      // captées par le grabber. On n'invente plus de tokens « par héros » : ça
      // affichait des auras (Embodiments de Briar…) dès le tour 0 alors qu'elles
      // ne sont créées qu'en jouant → trompeur. Sans capture : aucun token.
      if (t.field) { st.meTokens = (t.field.me || []).slice(); st.oppTokens = (t.field.opp || []).slice(); }
      else { st.meTokens = []; st.oppTokens = []; }
      // Cimetière/banni réels (2 camps) si captés : on cale l'état exact en début
      // de tour ; le cimetière continue de grandir via le log pendant le tour.
      // Sinon (vieux logs), on garde la reconstruction cumulée depuis le récit.
      if (t.grave) { st.meGrave = (t.grave.me || []).slice(); st.oppGrave = (t.grave.opp || []).slice(); }
      if (t.banish) { st.meBanish = (t.banish.me || []).slice(); st.oppBanish = (t.banish.opp || []).slice(); }

      // Détection AUTOMATIQUE des équipements détruits (sans liste de cartes) :
      // un équipement détruit part au cimetière (ou banni). Dès qu'une pièce
      // connue y apparaît, on la retire du plateau — de façon cumulative, donc
      // définitive. Couvre tout ce qui « casse » (Crown en bloquant, Nullrune,
      // armures…). Complète l'événement « was destroyed » (utile aux vieux logs
      // sans cimetière capté). NB : détecté en DÉBUT de tour → une pièce cassée
      // ce tour-ci reste visible pendant le tour, puis disparaît au suivant.
      // On matche par rawKey (nom brut, avec suffixe dual-wield le cas échéant) :
      // le cimetière nomme la copie détruite d'une arme dual-wield avec son « R »
      // (ex. « Hunter's Klaive R »), ce qui identifie SPÉCIFIQUEMENT cette copie —
      // sans quoi les deux copies (même nom affiché) seraient masquées ensemble.
      [['me', st.meGrave, st.meBanish, st.meEquipGone], ['opp', st.oppGrave, st.oppBanish, st.oppEquipGone]].forEach(([sd, grave, banish, gone]) => {
        (grave || []).concat(banish || []).forEach(c => { const k = norm(c); if (EQRAW[sd][k] && gone.indexOf(k) < 0) gone.push(k); });
      });

      // Joueur actif. Le tour d'ouverture (1er joueur) n'a souvent pas d'en-tête
      // → player=null : on déduit l'acteur (celui qui joue le plus ce tour-là).
      const opening = !attacker;
      let actor = attacker;
      if (opening) {
        // 1er joueur = le 1er à jouer (l'adversaire ne fait que réagir ensuite) ;
        // la majorité serait trompeuse s'il bloque beaucoup pendant l'ouverture.
        const first = (t.events || []).find(e => (e.type === 'played' || e.type === 'activated') && e.player);
        actor = first ? first.player : null;
      }
      const atkSide = actor === MY ? 'me' : 'opp';
      const label = String(t.label || '').replace(MY, HERO.me).replace(OPP, HERO.opp);

      // Transformation de héros (Arakni) : si la forme relevée en début de ce tour
      // diffère de la forme courante, on la met à jour ET on annonce le changement
      // par une étape dédiée (visible dans la timeline + le plateau qui suit).
      if (t.heroForm) {
        ['me', 'opp'].forEach(sd => {
          const nf = t.heroForm[sd];
          if (nf && !sameHero(nf, curForm[sd])) {
            const prev = curForm[sd];
            curForm[sd] = nf;
            // Bannière SEULEMENT si une forme antérieure était déjà connue (vraie
            // transformation). Sinon (forme initiale pas encore résolue au 1er
            // instantané) on l'établit en silence — pas de « null → X » parasite.
            if (prev) push(t.label || label, sd, { type: 'transform', side: sd, big: '🕷 Transformation', sub: prev + ' → ' + nf });
          }
        });
      }

      // Arsenal ADVERSE (dos de carte face cachée — nom inconnu par règle FaB) :
      //  · compte capté par le grabber (playerTwo.Arsenal) si disponible → fiable ;
      //  · sinon (vieux logs) inféré : si l'adversaire joue « depuis l'arsenal » ce
      //    tour, il en avait forcément une → on l'affiche jusqu'à ce qu'il la joue.
      if (t.oppArsenalCount != null) {
        st.oppArsenalCount = t.oppArsenalCount;
      } else {
        const oppFromArsenal = (t.events || []).some(e => e.type === 'played' && e.fromArsenal && e.player && e.player !== MY);
        st.oppArsenalCount = oppFromArsenal ? 1 : 0;
      }

      if (opening) {
        // Bannière de début PUIS on rejoue les actions du 1er tour (comme le
        // Déroulé) au lieu de sauter le tour. Main de départ affichée.
        // Reconstitution : le snapshot d'ouverture peut avoir été pris un peu
        // TARD (après tes 1ers plays) → des cartes jouées ce tour-là manquaient
        // (ex. Scar for a Scar joué après Nimblism). On rajoute les cartes venues
        // de TA main ce tour-ci (plays hors-arsenal + pitches) si elles manquent,
        // pour que la main de départ soit complète et visible AVANT d'être jouée.
        let hand0 = (t.hand || []).slice();
        if (actor === MY) {
          const cnt = {};
          (t.events || []).forEach(ev => {
            if (sideOf(ev.player) !== 'me') return;
            if ((ev.type === 'played' && !ev.fromArsenal) || ev.type === 'pitched') { const k = norm(ev.card); (cnt[k] = cnt[k] || { nm: ev.card, n: 0 }).n++; }
          });
          Object.keys(cnt).forEach(k => { const have = hand0.filter(c => norm(c) === k).length; for (let m = have; m < cnt[k].n; m++) hand0.push(cnt[k].nm); });
        }
        st.meFaceUp = !!hand0.length;
        if (st.meFaceUp) st.meHandCards = hand0;
        if (actor === MY) st.oppHandCount = 4;
        push(t.label || 'Ouverture', atkSide, { type: 'banner', side: 'me', big: 'Début de la partie', sub: HERO.me + ' vs ' + HERO.opp });
        if (!actor || !(t.events || []).some(e => e.type === 'played' || e.type === 'activated')) return;   // ouverture sans action → juste la bannière
      } else {
        // Règle FaB : on repioche à la FIN de son tour, pas au début. La main
        // adverse est donc remise à 4 au début de MON tour (l'adversaire a
        // repioché en fin du sien) — mais PAS au début du tour adverse : il
        // garde ce qu'il lui reste après ses blocs, et ne repioche qu'à la fin.
        // L'arsenal adverse n'est pas connu de façon fiable → on ne l'invente pas.
        if (actor === MY) { st.meFaceUp = true; st.meHandCards = (t.hand || []).slice(); st.oppHandCount = 4; }
        else {
          // Tour adverse : MA main m'est connue (instantané capté au début de
          // son tour) → je l'affiche face visible plutôt que des dos de cartes.
          // Repli sur un compteur (dos) seulement si l'instantané manque.
          if (t.hand && t.hand.length) { st.meFaceUp = true; st.meHandCards = t.hand.slice(); }
          else { st.meFaceUp = false; st.meHandCount = 4; }
        }
        // Sous-titre COMPACT (PV seuls) : le nom du héros est déjà dans les
        // encarts de PV latéraux et la pastille de tour ; le répéter 3× ici
        // (surtout en miroir « Aurora, Legacy of Tempest ») faisait une ligne
        // énorme qui gonflait la largeur mesurée du plateau et poussait tout
        // vers la droite sur mobile.
        push(label, atkSide, { type: 'banner', side: atkSide, big: actor === MY ? 'Ton tour' : 'Tour adverse',
          sub: 'Toi ' + st.life.me + ' · Adv ' + st.life.opp + ' PV' });
      }

      const evs = t.events || [], consumed = {};
      // Liens de combat de ce tour (attaque/défense EFFECTIVES, buffs compris),
      // consommés dans l'ordre au fil des attaques (appariés par nom de carte).
      const chainQ = (t.chain || []).slice();
      // Appariement : par nom de carte d'abord ; sinon 1er lien restant (repli
      // d'ordre — utile quand une carte de pump jouée PAR-DESSUS l'attaque devient
      // l'« attaquant » affiché alors que le lien porte la vraie carte d'attaque).
      const takeChain = nm => { const k = norm(nm); let i = chainQ.findIndex(c => norm(c.card) === k); if (i < 0 && chainQ.length) i = 0; return i >= 0 ? chainQ.splice(i, 1)[0] : null; };
      let openAtk = null, curBlocks = [], curReactions = [];
      let lastAction = null, ended = false;   // dernière carte jouée/activée (cause du coup fatal) ; fin de partie atteinte
      // Transformations survenues PENDANT un combat (ex. Mask of Deceit, trigger
      // de blocage) : le log les écrit avant « Combat resolved » mais elles ne
      // doivent apparaître qu'APRÈS l'échange qu'elles affectent. Mises en
      // attente ici, matérialisées par flushTransforms() une fois le clash poussé.
      let pendingTransforms = [];
      const flushTransforms = () => {
        pendingTransforms.forEach(({ sd, to }) => {
          if (!sameHero(to, curForm[sd])) {
            const prev = curForm[sd]; curForm[sd] = to;
            push(label, sd, { type: 'transform', side: sd, big: '🕷 Transformation', sub: prev + ' → ' + to });
          }
        });
        pendingTransforms = [];
      };
      // MODE CHAÎNE (v1.15.0+) : quand la chaîne de combat est captée, elle est
      // AUTORITAIRE sur l'attaquant. On met les cartes de l'attaquant du combat
      // courant en attente (atkBuf), et au combat on prend l'attaquant = carte de
      // la chaîne ; les cartes AVANT lui = actions préalables (cartes seules), les
      // cartes APRÈS lui = renforts (pumps/réactions d'attaque, ex. Tarantula Toxin
      // sur la dague — même sans qu'elles ciblent l'attaque). Sinon (vieux logs
      // sans chaîne) on garde l'ancien modèle openAtk.
      const hasChain = chainQ.length > 0;
      let atkBuf = [];
      const looseNorm = s => norm(s).replace(/[^a-z0-9]/g, '');   // tolère apostrophe/ponctuation (« Hunter's Klaive » vs « Hunters Klaive »)
      const bufEntryStep = x => ({ type: 'play', side: atkSide, card: { nm: x.nm, cp: x.cp }, act: !!x.act, pitch: x.pitch, text: HERO[atkSide] + (x.act ? ' active ' : ' joue ') + x.nm + (x.pTxt || '') });
      // Matérialise une carte en « carte seule » MAINTENANT (photo de la main
      // prise à cet instant → les cartes jouées ENSUITE y sont encore visibles).
      const materialize = x => { push(label, atkSide, bufEntryStep(x)); if (!isEquip(atkSide, x.nm)) toGrave(atkSide, x.nm); };
      const flushBuf = () => { atkBuf.forEach(materialize); atkBuf = []; };
      // La carte du PROCHAIN lien de combat = l'attaquant du combat en cours.
      const nextAtkCard = () => (chainQ.length ? chainQ[0].card : null);
      const isAtkCard = nm => { const nc = nextAtkCard(); return nc && looseNorm(nm) === looseNorm(nc); };
      // Affiche en carte SEULE une carte de l'attaquant restée sans combat
      // (action hors-combat). Une vraie carte d'ATTAQUE, elle, n'est montrée que
      // dans l'échange (clash) → plus de doublon « carte seule » puis « échange ».
      const flushAtk = () => {
        if (!openAtk) return;
        push(label, openAtk.side, { type: 'play', side: openAtk.side, card: { nm: openAtk.nm, cp: openAtk.cp }, pitch: openAtk.pitch, text: HERO[openAtk.side] + ' joue ' + openAtk.nm + openAtk.pTxt });
        // Renforts éventuels (attaque hors-combat) : affichés à part pour ne pas les perdre.
        (openAtk.pumps || []).forEach(p => push(label, openAtk.side, { type: 'play', side: openAtk.side, card: { nm: p.nm, cp: p.cp }, reaction: true, text: HERO[openAtk.side] + ' joue ' + p.nm + (p.pTxt || '') }));
        openAtk = null;
      };
      evs.forEach((e, i) => {
        if (consumed[i] || ended) return;
        if (e.type === 'played') {
          lastAction = e.card;
          const side = sideOf(e.player); removeCard(side, e.card);
          // Carte jouée depuis l'arsenal adverse → l'arsenal adverse se vide.
          if (e.fromArsenal && side === 'opp') st.oppArsenalCount = Math.max(0, st.oppArsenalCount - 1);
          const pitches = [];
          for (let j = i + 1; j < evs.length; j++) { const f = evs[j]; if (f.type === 'played') break; if (f.type === 'pitched' && f.player === e.player) { pitches.push(f.card); consumed[j] = 1; addPitch(side, f.card); removeCard(side, f.card); } }
          const pTxt = pitches.length ? ' (pitch ' + pitches.join(', ') + ')' : '';
          if (side === atkSide && hasChain) {
            const entry = { nm: e.card, cp: e.pitch, pitch: pitches.join(', '), pTxt: pTxt, act: false };
            if (atkBuf.length === 0 && isAtkCard(e.card)) atkBuf.push(entry);       // c'est l'attaquant
            else if (atkBuf.length > 0) atkBuf.push(entry);                          // renfort (joué APRÈS l'attaquant)
            else materialize(entry);                                                 // action PRÉ-attaque → carte seule, photo prise MAINTENANT
          } else if (side === atkSide) {
            // (vieux logs sans chaîne) Cette carte est-elle un RENFORT sur l'attaque
            // en cours (pump/réaction ciblant l'attaque, ex. Lightning Press sur Fry)
            // ou une NOUVELLE attaque ? Signal : « <camp>'s <attaque> was targeted ».
            let isReinforce = false;
            if (openAtk) {
              for (let j = i + 1; j < evs.length; j++) {
                const f = evs[j];
                if (f.type === 'played' || f.type === 'combatResult') break;
                if (f.type === 'targetedSecondary' && norm(f.card) === norm(openAtk.nm)) { isReinforce = true; break; }
              }
            }
            if (isReinforce) {
              (openAtk.pumps = openAtk.pumps || []).push({ nm: e.card, cp: e.pitch, pTxt: pTxt });
            } else {
              flushAtk();   // attaque précédente restée sans combat → carte seule
              openAtk = { nm: e.card, side, cp: e.pitch, pitch: pitches.join(', '), pTxt: pTxt, pumps: [] };
            }
          } else {
            curReactions.push({ card: e.card, owner: side, cp: e.pitch });
            // Réaction de défense PENDANT un combat (une attaque est en cours) :
            // on ne l'affiche PAS en étape séparée — sinon elle apparaît AVANT
            // l'attaque qu'elle pare (l'attaque, elle, n'est montrée qu'à l'échange).
            // Elle figure déjà côté DÉFENSE de l'échange. Hors combat seulement,
            // on la montre en carte seule.
            if (!atkBuf.length && !openAtk) {
              push(label, side, { type: 'play', side, card: { nm: e.card, cp: e.pitch }, reaction: true, pitch: pitches.join(', '), text: HERO[side] + ' joue ' + e.card + ' en réaction' + pTxt });
            }
          }
        } else if (e.type === 'activated') {
          // Activation d'une capacité (arme, héros, item/permanent, ex. Grasp of
          // the Arknight) : la carte reste en jeu → pas de removeCard ni toGrave.
          // Ce n'est pas une attaque → on l'affiche en carte seule immédiatement,
          // sans passer par le différé de combat (openAtk).
          lastAction = e.card;
          const side = sideOf(e.player);
          // Naissance d'une arme CRÉÉE en jeu (cf. prescan createdKeys, ex.
          // Graphene Chelicera) : apparaît sur le plateau à partir de CETTE
          // étape précise (cumulatif, jamais annulé).
          if (createdKeys[side][norm(e.card)]) { const b = side === 'me' ? st.meBorn : st.oppBorn; const bk = norm(e.card); if (b.indexOf(bk) < 0) b.push(bk); }
          // Si la carte activée est une pièce d'équipement NON-ARME (armure/item),
          // on la marque « utilisée » pour ce tour → grisée sur le plateau
          // (réarmée au tour suivant). Les armes et les activations de héros ne
          // sont pas grisées (une arme qui attaque n'est pas « épuisée »).
          if (EQ[side][norm(e.card)] && !WPN[side][norm(e.card)]) { const u = side === 'me' ? st.meEquipUsed : st.oppEquipUsed; if (u.indexOf(norm(e.card)) < 0) u.push(norm(e.card)); }
          const pitches = [];
          for (let j = i + 1; j < evs.length; j++) { const f = evs[j]; if (f.type === 'played' || f.type === 'activated') break; if (f.type === 'pitched' && f.player === e.player) { pitches.push(f.card); consumed[j] = 1; addPitch(side, f.card); removeCard(side, f.card); } }
          const pTxt = pitches.length ? ' (pitch ' + pitches.join(', ') + ')' : '';
          // Une ARME activée par l'attaquant EST une attaque (ex. Hunter's Klaive) :
          // en mode chaîne on la met en attente pour qu'elle devienne l'attaquant
          // du combat (au lieu d'une carte seule que la 1re réaction remplacerait).
          const wpnEntry = { nm: e.card, cp: e.pitch, pitch: pitches.join(', '), pTxt: pTxt, act: true };
          if (hasChain && side === atkSide && atkBuf.length > 0) {
            // Activation PENDANT l'attaque en cours (ex. Flick Knives, une réaction
            // sur la dague déjà déclarée) → c'est un RENFORT : il apparaît DANS
            // l'échange, plus en étape isolée AVANT l'attaque.
            atkBuf.push(wpnEntry);
          } else if (hasChain && side === atkSide && WPN[side][norm(e.card)] && (atkBuf.length === 0 ? (isAtkCard(e.card) || !nextAtkCard()) : true)) {
            atkBuf.push(wpnEntry);              // arme = attaquant
          } else {
            push(label, side, { type: 'play', side, card: { nm: e.card, cp: e.pitch }, act: true, pitch: pitches.join(', '), text: HERO[side] + ' active ' + e.card + pTxt });
          }
        } else if (e.type === 'destroyed') {
          // Un ÉQUIPEMENT détruit (armure/Nullrune cassée…) est retiré du plateau
          // à partir d'ici (effet cumulatif, jamais annulé). On identifie le camp
          // par correspondance avec l'équipement connu (META). La ligne ne nomme
          // pas le joueur ; si la même pièce est portée des deux côtés (rare), on
          // attribue au défenseur (l'autre camp que l'attaquant du tour). Les
          // cartes détruites hors-équipement (ex. « … from the arsenal ») ne
          // correspondent à aucune pièce → naturellement ignorées ici.
          const k = norm(e.card), inMe = !!EQ.me[k], inOpp = !!EQ.opp[k];
          const gside = (inMe && !inOpp) ? 'me' : (inOpp && !inMe) ? 'opp' : (inMe && inOpp) ? (atkSide === 'me' ? 'opp' : 'me') : null;
          if (gside) {
            const arr = gside === 'me' ? st.meEquipGone : st.oppEquipGone;
            const eq = (GAME.players[gside] && GAME.players[gside].equipment) || {};
            // Résout la COPIE exacte détruite (dual-wield, ex. deux dagues
            // identiques) : nom brut si la ligne le porte déjà (rawKey exact,
            // ex. « ...R »), sinon la 1re copie de ce nom affiché pas encore
            // marquée détruite. Pièce à copie unique : inchangé (rawKey===k).
            let key = k;
            if (!EQRAW[gside][k]) {
              const slot = Object.keys(eq).find(sk => norm(eq[sk] && eq[sk].name) === k && arr.indexOf(rawKey(eq[sk])) < 0);
              if (slot) key = rawKey(eq[slot]);
            }
            if (arr.indexOf(key) < 0) arr.push(key);
          }
        } else if (e.type === 'pitched') {
          const s = sideOf(e.player); addPitch(s, e.card); removeCard(s, e.card);
        } else if (e.type === 'transform') {
          // Transformation de héros (ex. Arakni) AU MOMENT EXACT où elle survient
          // dans le log (« <forme> becomes <nouvelle forme> »), pas seulement au
          // tour suivant. On identifie le camp par la forme de départ.
          // Si elle survient PENDANT un combat (trigger de blocage, ex. Mask of
          // Deceit) → mise en attente : elle ne doit s'afficher qu'APRÈS le clash
          // qu'elle affecte, alors que le log l'écrit avant « Combat resolved ».
          const sd = sameHero(e.from, curForm.me) ? 'me' : (sameHero(e.from, curForm.opp) ? 'opp' : null);
          if (sd) {
            const inCombat = !!(openAtk || atkBuf.length || curBlocks.length);
            if (inCombat) {
              pendingTransforms.push({ sd, to: e.to });
            } else {
              flushAtk(); flushBuf();
              if (e.to && !sameHero(e.to, curForm[sd])) {
                const prev = curForm[sd]; curForm[sd] = e.to;
                push(label, sd, { type: 'transform', side: sd, big: '🕷 Transformation', sub: prev + ' → ' + e.to });
              }
            }
          }
        } else if (e.type === 'blocked') {
          const s = sideOf(e.player);
          (e.cards || []).forEach((c, ci) => { const eq = isEquip(s, c); if (!eq) removeCard(s, c); curBlocks.push({ card: c, owner: s, eq, cp: (e.pitches && e.pitches[ci]) || null }); });
        } else if (e.type === 'damageTaken') {
          const s = sideOf(e.player); st.life[s] = Math.max(0, st.life[s] - (e.amount || 0));
        } else if (e.type === 'combatResult' && hasChain) {
          // MODE CHAÎNE : l'attaquant est la carte du lien de combat (autoritaire).
          // Les actions PRÉ-attaque ont déjà été affichées « en carte seule » au
          // moment où elles ont été jouées (photo correcte) → atkBuf ne contient
          // que l'attaquant (index 0) puis ses renforts.
          const dmg = e.hit ? (e.amount || 0) : 0;
          const link = chainQ.shift() || null;                 // un lien par combat, dans l'ordre
          const attacker = atkBuf[0] || (link ? { nm: link.card } : null);
          const after = atkBuf.slice(1);                        // renforts (pumps/réactions)
          if (attacker && !isEquip(atkSide, attacker.nm)) toGrave(atkSide, attacker.nm);
          after.forEach(x => { if (!isEquip(atkSide, x.nm)) toGrave(atkSide, x.nm); });
          curBlocks.forEach(b => { if (!b.eq) toGrave(b.owner, b.card); });
          curReactions.forEach(r => toGrave(r.owner, r.card));
          if (attacker) {
            const defSide = atkSide === 'me' ? 'opp' : 'me';
            const defCards = curBlocks.map(b => ({ nm: b.card, cp: b.cp })).concat(curReactions.filter(r => r.owner === defSide).map(r => ({ nm: r.card, cp: r.cp })));
            const blockWho = curBlocks.length ? curBlocks[0].owner : defSide;
            const vt = dmg > 0 ? 'through' : 'blocked';
            const rtxt = dmg > 0 ? (dmg + ' dégât' + (dmg > 1 ? 's' : '') + ' pass' + (dmg > 1 ? 'ent' : 'e')) : '0 dégât — bloqué';
            const blkTxt = defCards.length ? ((blockWho === 'me' ? 'Tu défends' : HERO.opp + ' défend') + ' : ' + defCards.map(b => b.nm).join(', ')) : 'non bloqué';
            push(label, atkSide, { type: 'clash', atk: { nm: attacker.nm, cp: attacker.cp, who: atkSide, power: link ? link.power : null, kw: link ? link.kw : [] }, pumps: after.map(x => ({ nm: x.nm, cp: x.cp })), blocks: defCards, blockWho, verdict: vt, result: rtxt, text: blkTxt }, dmg > 0 ? defSide : null);
          }
          flushTransforms();   // transfo déclenchée par ce combat (ex. Mask of Deceit) → juste après le clash
          atkBuf = []; curBlocks = []; curReactions = [];
        } else if (e.type === 'combatResult') {
          const dmg = e.hit ? (e.amount || 0) : 0;
          if (openAtk) { toGrave(openAtk.side, openAtk.nm); (openAtk.pumps || []).forEach(p => toGrave(openAtk.side, p.nm)); }
          curBlocks.forEach(b => { if (!b.eq) toGrave(b.owner, b.card); });
          curReactions.forEach(r => toGrave(r.owner, r.card));
          if (openAtk) {
            const defSide = openAtk.side === 'me' ? 'opp' : 'me';
            const defCards = curBlocks.map(b => ({ nm: b.card, cp: b.cp })).concat(curReactions.filter(r => r.owner === defSide).map(r => ({ nm: r.card, cp: r.cp })));
            const blockWho = curBlocks.length ? curBlocks[0].owner : defSide;
            const vt = dmg > 0 ? 'through' : 'blocked';
            const rtxt = dmg > 0 ? (dmg + ' dégât' + (dmg > 1 ? 's' : '') + ' pass' + (dmg > 1 ? 'ent' : 'e')) : '0 dégât — bloqué';
            const blkTxt = defCards.length ? ((blockWho === 'me' ? 'Tu défends' : HERO.opp + ' défend') + ' : ' + defCards.map(b => b.nm).join(', ')) : 'non bloqué';
            const lk = takeChain(openAtk.nm);   // attaque/défense effectives (buffs) de CETTE attaque
            const pumps = (openAtk.pumps || []).map(p => ({ nm: p.nm, cp: p.cp }));
            push(label, openAtk.side, { type: 'clash', atk: { nm: openAtk.nm, cp: openAtk.cp, who: openAtk.side, power: lk ? lk.power : null, kw: lk ? lk.kw : [] }, pumps: pumps, blocks: defCards, blockWho, verdict: vt, result: rtxt, text: blkTxt }, dmg > 0 ? defSide : null);
          }
          flushTransforms();   // transfo déclenchée par ce combat (ex. Mask of Deceit) → juste après le clash
          openAtk = null; curBlocks = []; curReactions = [];
        } else if (e.type === 'gameWon' || e.type === 'conceded') {
          // Fin de partie : on pousse une étape TERMINALE explicite. Beaucoup de
          // parties se finissent hors combat (dégâts d'arcane, effet, discard) —
          // le coup fatal n'apparaissait alors nulle part. On affiche le vainqueur,
          // les PV finaux (perdant à 0 sur une mort, PV réels sur un abandon) et
          // la dernière carte jouée/activée comme « coup fatal ».
          flushAtk(); flushBuf(); flushTransforms();
          const conceded = e.type === 'conceded';
          const winnerSide = conceded ? (sideOf(e.player) === 'me' ? 'opp' : 'me') : (e.player ? sideOf(e.player) : null);
          const meLife = (!conceded && winnerSide === 'opp') ? 0 : st.life.me;
          const oppLife = (!conceded && winnerSide === 'me') ? 0 : st.life.opp;
          const cause = conceded ? ' · abandon' : (lastAction ? ' · coup fatal : ' + lastAction : '');
          const big = winnerSide ? ('🏆 ' + HERO[winnerSide] + ' gagne') : 'Fin de la partie';
          const sub = HERO.me + ' ' + meLife + ' PV · ' + HERO.opp + ' ' + oppLife + ' PV' + cause;
          push(label, winnerSide || atkSide, { type: 'end', side: winnerSide || 'me', big: big, sub: sub });
          ended = true;
        }
      });
      flushAtk(); flushBuf(); flushTransforms();   // fin de tour : dernière action hors-combat / transfo orpheline affichée
    });
    // Clone superficiel des joueurs (on ne mute JAMAIS GAME.players, potentiellement
    // partagé/réutilisé ailleurs — ex. dashboard) pour y accrocher les armes créées
    // en jeu, lues par buildZone().
    const players = {
      me: Object.assign({}, GAME.players.me || {}, { createdWeapons: createdWeapons.me }),
      opp: Object.assign({}, GAME.players.opp || {}, { createdWeapons: createdWeapons.opp })
    };
    return { players, myName: MY, oppName: OPP, hero: HERO, steps };
  }

  // ============================================================
  // RENDU
  // ============================================================
  function gcard(side, slot, name, hero) {
    // data-equip = clé normalisée d'une pièce d'équipement (armure) : permet à
    // render() de la masquer quand elle est détruite. Le héros n'en porte pas.
    const eqAttr = (!hero && name && name !== '—') ? ' data-equip="' + esc(norm(name)) + '"' : '';
    return '<div class="br-gcard br-' + side + ' p-' + slot + (hero ? ' br-hero' : '') + '"' + eqAttr + '>' +
      '<div class="br-art" data-card="' + esc(name) + '"' + (hero ? ' data-hero' : '') + '></div>' +
      '<div class="br-lab">' + esc(name) + '</div></div>';
  }
  // Champ d'un joueur (tapis miroir) : rail cimetière·deck·pitch | héros entouré
  // de son équipement + arme | arsenal. Les IDs des emplacements dynamiques
  // (cimetière/pitch/arsenal) sont conservés pour que render() les remplisse.
  function buildZone(side, pl) {
    const e = pl.equipment || {};
    const nm = k => (e[k] && e[k].name) || '—';
    const gId = side === 'me' ? 'mGrave' : 'oGrave', pId = side === 'me' ? 'mPitch' : 'oPitch';
    const arsId = side === 'me' ? 'mArsenal' : 'oArsenal', bId = side === 'me' ? 'mBanish' : 'oBanish';
    const leftRail = '<div class="br-rail br-left">' +
      '<div class="br-slot p-grave" id="br-' + gId + '">Cimetière</div>' +
      '<div class="br-deck p-deck" title="Deck"></div>' +
      '<div class="br-slot p-pitch" id="br-' + pId + '">Pitch</div>' +
      '<div class="br-slot p-banish" id="br-' + bId + '" title="Banni">Banni</div>' +
      '</div>';
    const equip = '<div class="br-equip">' +
      gcard(side, 'head', nm('head')) + gcard(side, 'chest', nm('chest')) +
      gcard(side, 'arms', nm('arms')) + gcard(side, 'legs', nm('legs')) + '</div>';
    // Arme(s) : on affiche weaponL ET weaponR (main + main gauche/off-hand, ex.
    // « Arcane Lantern »), en sautant les slots vides — sinon la 2e arme adverse
    // n'apparaissait pas sur le plateau. data-equip = rawKey (nom BRUT, suffixe
    // dual-wield compris) : identifie la copie exacte, pas juste le nom affiché
    // — sinon deux dagues identiques (ex. deux « Hunter's Klaive ») partagent la
    // même clé et une seule destruction en masquerait deux (ou aucune).
    const wpnTile = it => (it && it.name)
      ? '<div class="br-gcard br-' + side + ' br-wpn" data-equip="' + esc(rawKey(it)) + '"><div class="br-art" data-card="' + esc(it.name) + '"></div><div class="br-lab">' + esc(it.name) + '</div></div>'
      : '';
    // Armes CRÉÉES en jeu (ex. Graphene Chelicera par le pouvoir d'Arakni,
    // Orb-Weaver) : absentes de l'équipement de départ, ajoutées par
    // buildTimeline() dans createdWeapons. Masquées tant que non « nées »
    // (br-unborn, cf. applyBornState) — data-equip pour qu'une destruction
    // ultérieure les masque aussi.
    const bornTile = cw => '<div class="br-gcard br-' + side + ' br-wpn br-unborn" data-equip="' + esc(cw.key) + '" data-born="' + esc(cw.key) + '"><div class="br-art" data-card="' + esc(cw.name) + '"></div><div class="br-lab">' + esc(cw.name) + '</div></div>';
    const createdWpns = ((pl.createdWeapons || [])).map(bornTile).join('');
    // Armes regroupées dans .br-wpns : avec l'équipement (à gauche du héros) et
    // les armes (à droite), le héros est l'ancre CENTRALE du cluster. Sans ce
    // regroupement, un joueur à 1 arme et un à 2 armes décalaient leur héros
    // (cluster centré de largeur variable) → les deux camps ne s'alignaient pas.
    const cluster = '<div class="br-cluster">' + equip +
      gcard(side, 'hero', pl.hero || '?', true) +
      '<div class="br-wpns">' + wpnTile(e.weaponL) + wpnTile(e.weaponR) + createdWpns + '</div>' +
      '</div>';
    const rightRail = '<div class="br-rail br-right">' +
      '<div class="br-zpair"><span class="br-zlbl">Arsenal</span>' +
        '<div class="br-slot br-arsenal" id="br-' + arsId + '">Arsenal</div></div>' +
      '</div>';
    return leftRail + cluster + rightRail;
  }

  function mount(container, GAME) {
    if (!container || !GAME || !GAME.turns) return;
    const data = buildTimeline(GAME), steps = data.steps, P = data.players;
    if (!steps.length) { container.innerHTML = '<div class="br-empty">Pas d\'action à rejouer pour cette partie.</div>'; return; }

    // Tokens/permanents qui RESTENT en jeu : affichés en ligne à droite du
    // compteur de vie de leur propriétaire (adversaire en haut, toi en bas —
    // miroir des PV). Conteneurs remplis à chaque étape depuis l'état (terrain
    // réel capté par le grabber, sinon repli par héros) ; vides = invisibles.

    container.innerHTML =
      '<div class="br-wrap">' +
        '<div class="br-toolbar" role="group" aria-label="Contrôles de lecture">' +
          '<button class="br-tool" data-act="restart" title="Recommencer" aria-label="Recommencer">⏮</button>' +
          '<button class="br-tool" data-act="prev" title="Étape précédente" aria-label="Étape précédente">‹</button>' +
          '<button class="br-tool br-play" data-act="play" title="Lecture automatique" aria-label="Lecture automatique">▶</button>' +
          '<button class="br-tool" data-act="next" title="Étape suivante" aria-label="Étape suivante">›</button>' +
        '</div>' +
        '<div class="br-mat">' +
          '<div class="br-hand br-opp" id="br-oppHand"></div>' +
          '<div class="br-field br-opp" id="br-fOpp">' + buildZone('opp', P.opp) + '</div>' +
          '<div class="br-mid">' +
            '<span class="br-turnchip" id="br-turnPill"> </span>' +
            '<div class="br-lifeside">' +
              '<div class="br-liferow br-opp">' +
                '<div class="br-life br-opp"><span class="br-life-who">' + esc(data.hero.opp) + '</span><span class="br-life-n" id="br-oLifeTok">0</span></div>' +
                '<div class="br-tokrow br-opp" id="br-oppTok"></div>' +
              '</div>' +
              '<div class="br-liferow br-me">' +
                '<div class="br-life br-me"><span class="br-life-who">' + esc(data.hero.me) + '</span><span class="br-life-n" id="br-mLifeTok">0</span></div>' +
                '<div class="br-tokrow br-me" id="br-meTok"></div>' +
              '</div>' +
            '</div>' +
            '<div class="br-lane" id="br-stage"></div>' +
          '</div>' +
          '<div class="br-field br-me br-active" id="br-fMe">' + buildZone('me', P.me) + '</div>' +
          '<div class="br-hand br-me" id="br-myHand"></div>' +
        '</div>' +
        '<div class="br-timeline">' +
          '<div class="br-tl-top"><span class="br-tl-lbl">Timeline</span>' +
            '<span class="br-info"><span id="br-turnLbl"> </span> · étape <b id="br-stepN">1</b>/<b id="br-stepTot">' + steps.length + '</b></span></div>' +
          '<input type="range" id="br-slider" min="0" max="' + (steps.length - 1) + '" value="0" aria-label="Position dans la partie">' +
          '<div class="br-ticks"><span>Début</span><span>Fin</span></div>' +
        '</div>' +
      '</div>';

    paintArt(container);   // équipement + héros (statique)

    const $ = s => container.querySelector(s);
    const slider = $('#br-slider'), stage = $('#br-stage');
    let i = 0, playing = false, timer = null; const prevCounts = {};

    // Libellés courts des mots-clés FaB portés par l'attaque (chaîne de combat).
    const KW_LABEL = { goAgain: 'Go again', dominate: 'Dominate', overpower: 'Overpower', piercing: 'Piercing', combo: 'Combo', wager: 'Wager', phantasm: 'Phantasm', fusion: 'Fusion', tower: 'Tower', highTide: 'High Tide', confidence: 'Confidence' };
    // Badge de puissance EFFECTIVE (buffs compris) affiché sur la carte d'attaque.
    const pwBadge = c => (c && c.power != null) ? '<span class="br-pw" title="Attaque effective (buffs compris)">' + c.power + '</span>' : '';
    const pitchAttr = c => (c && (c.cp === 1 || c.cp === 2 || c.cp === 3)) ? ' data-pitch="' + c.cp + '"' : '';
    const pcard = (c, side, lg) => '<div class="br-pcard br-' + side + (lg ? ' br-lg' : '') + '" data-card="' + esc(c.nm) + '"><div class="br-art" data-card="' + esc(c.nm) + '"' + pitchAttr(c) + '></div><div class="br-nm">' + esc(c.nm) + '</div>' + pwBadge(c) + '</div>';
    const kwLine = c => (c && c.kw && c.kw.length) ? '<div class="br-kwline">' + c.kw.map(k => '<span class="br-kw">' + esc(KW_LABEL[k] || k) + '</span>').join('') + '</div>' : '';
    function buildStage(s) {
      if (s.type === 'banner') return '<div class="br-banner br-' + s.side + '"><div class="br-big">' + esc(s.big) + '</div><div class="br-sub">' + esc(s.sub) + '</div></div>';
      if (s.type === 'end') return '<div class="br-banner br-end br-' + s.side + '"><div class="br-big">' + esc(s.big) + '</div><div class="br-sub">' + esc(s.sub) + '</div></div>';
      if (s.type === 'transform') return '<div class="br-banner br-transform br-' + s.side + '"><div class="br-big">' + esc(s.big) + '</div><div class="br-sub">' + esc(s.sub) + '</div></div>';
      if (s.type === 'play') return '<div class="br-playone br-' + s.side + '">' + pcard(s.card, s.side, true) + (s.act ? '<span class="br-act">⚡ activé</span>' : '') + (s.reaction ? '<span class="br-react">↩ réaction</span>' : '') + (s.pitch ? '<span class="br-pitch-pill">🔷 pitch ' + esc(s.pitch) + '</span>' : '') + '</div>';
      if (s.type === 'clash') {
        const bl = s.blocks.length ? s.blocks.map(b => pcard(b, s.blockWho)).join('') : '<span class="br-noblock">Non bloqué</span>';
        // Renforts (pumps/réactions d'attaque, ex. Lightning Press) : petites
        // cartes sous l'attaque, pour garder trace de ce qui a été joué dessus.
        const pumps = (s.pumps && s.pumps.length) ? '<div class="br-pumps"><span class="br-pumps-lbl">+ renfort</span><div class="br-cardrow">' + s.pumps.map(p => pcard(p, s.atk.who)).join('') + '</div></div>' : '';
        return '<div class="br-phase">Combat</div><div class="br-duel"><div class="br-side"><span class="br-duel-who">Attaque</span>' + pcard(s.atk, s.atk.who) + kwLine(s.atk) + pumps + '</div><span class="br-arrow">→</span><div class="br-side"><span class="br-duel-who">Défense</span><div class="br-cardrow">' + bl + '</div></div></div><div class="br-verdict br-' + s.verdict + '">' + (s.verdict === 'blocked' ? '✓ ' : '💥 ') + esc(s.result) + '</div>';
      }
      return '';
    }
    function fillSlot(sel, label, cards, side, mode) {
      const el = $(sel); if (!el) return; const n = cards ? cards.length : 0, key = sel;
      if (!n) { el.classList.remove('br-filled'); el.innerHTML = ''; el.textContent = label; prevCounts[key] = 0; return; }
      el.classList.add('br-filled');
      const top = cards[cards.length - 1];
      let inner = '<span class="br-slot-tag">' + label + '</span>';
      inner += mode === 'back' ? '<div class="br-zcard br-back"></div>'
        : '<div class="br-zcard br-' + side + (mode === 'grave' ? ' br-grave' : '') + '"><div class="br-art" data-card="' + esc(top) + '"></div><div class="br-nm">' + esc(top) + '</div></div>';
      if (n > 1) inner += '<span class="br-badge">×' + n + '</span>';
      el.innerHTML = inner;
      if (prevCounts[key] != null && n > prevCounts[key]) { el.classList.remove('br-bump'); void el.offsetWidth; el.classList.add('br-bump'); }
      prevCounts[key] = n;
    }
    function backs(el, count, emptyTxt) {
      el.innerHTML = '';
      const n = Math.min(count, 8);
      for (let k = 0; k < n; k++) { const b = document.createElement('div'); b.className = 'br-back'; el.appendChild(b); }
      if (!count) el.innerHTML = '<span class="br-handempty">' + emptyTxt + '</span>';
    }
    function renderHands(s) {
      backs($('#br-oppHand'), s.oppHandCount, 'main vide');
      const mh = $('#br-myHand');
      if (s.meFaceUp) {
        mh.innerHTML = '';
        if (!s.meHandCards.length) { mh.innerHTML = '<span class="br-handempty">main vide</span>'; return; }
        s.meHandCards.forEach(c => { const d = document.createElement('div'); d.className = 'br-pcard br-me br-inhand'; d.innerHTML = '<div class="br-art" data-card="' + esc(c) + '"></div><div class="br-nm">' + esc(c) + '</div>'; mh.appendChild(d); });
      } else backs(mh, s.meHandCount, 'main vide');
    }
    function applyEquipState(zoneSel, goneArr, usedArr) {
      const zone = $(zoneSel); if (!zone) return;
      const gone = goneArr || [], used = usedArr || [];
      zone.querySelectorAll('[data-equip]').forEach(el => {
        const k = el.getAttribute('data-equip'), broken = gone.indexOf(k) >= 0;
        el.classList.toggle('br-broken', broken);                       // détruit → masqué
        el.classList.toggle('br-used', !broken && used.indexOf(k) >= 0); // activé ce tour → grisé
      });
    }
    // Armes CRÉÉES en jeu (ex. Graphene Chelicera) : masquées (br-unborn) tant
    // qu'elles ne sont pas encore apparues à l'étape courante ; réversible en
    // scrubbant la timeline en arrière, comme applyEquipState().
    function applyBornState(zoneSel, bornArr) {
      const zone = $(zoneSel); if (!zone) return;
      const born = bornArr || [];
      zone.querySelectorAll('[data-born]').forEach(el => {
        el.classList.toggle('br-unborn', born.indexOf(el.getAttribute('data-born')) < 0);
      });
    }
    // Applique la forme courante du héros (Arakni se transforme) : nom dans le
    // panneau de vie + libellé/image de la carte-héros. paintArt() (fin de render)
    // repeint l'image de la nouvelle forme.
    function setHeroForm(side, name, fieldSel) {
      if (!name) return;
      const who = $('.br-liferow.br-' + side + ' .br-life-who');
      if (who && who.textContent !== name) who.textContent = name;
      const field = $(fieldSel); if (!field) return;
      const hero = field.querySelector('.br-hero'); if (!hero) return;
      const lab = hero.querySelector('.br-lab'); if (lab && lab.textContent !== name) lab.textContent = name;
      const art = hero.querySelector('.br-art');
      if (art && art.getAttribute('data-card') !== name) {
        art.setAttribute('data-card', name);
        delete art.dataset.painted;            // force le repaint de la nouvelle forme
        art.style.backgroundImage = ''; art.classList.remove('has-img');
        const tile = art.closest('.br-gcard'); if (tile) tile.classList.remove('br-imgok');
      }
    }
    function render(prev) {
      const s = steps[i], stt = s.state;
      stage.innerHTML = buildStage(s.stage);
      $('#br-mLifeTok').textContent = stt.life.me; $('#br-oLifeTok').textContent = stt.life.opp;
      $('#br-turnPill').textContent = s.turn;
      renderHands(stt);
      fillSlot('#br-mPitch', 'Pitch', stt.mePitch, 'me', 'up');
      fillSlot('#br-oPitch', 'Pitch', stt.oppPitch, 'opp', 'up');
      fillSlot('#br-mArsenal', 'Arsenal', stt.meArsenal, 'me', 'up');
      fillSlot('#br-oArsenal', 'Arsenal', stt.oppArsenalCount > 0 ? ['?'] : [], 'opp', 'back');
      fillSlot('#br-mGrave', 'Cimetière', stt.meGrave, 'me', 'grave');
      fillSlot('#br-oGrave', 'Cimetière', stt.oppGrave, 'opp', 'grave');
      fillSlot('#br-mBanish', 'Banni', stt.meBanish, 'me', 'grave');
      fillSlot('#br-oBanish', 'Banni', stt.oppBanish, 'opp', 'grave');
      // Tokens/permanents : on regroupe les exemplaires identiques en UNE tuile
      // avec un badge « ×N » (ordre de 1ʳᵉ apparition), au lieu d'empiler N
      // copies côte à côte (ex. Oscilio : plusieurs « Seismic Surge »).
      const tokHtml = (cards, side) => {
        const order = [], count = {};
        (cards || []).forEach(c => { const k = norm(c); if (count[k] == null) { count[k] = 0; order.push({ k: k, nm: c }); } count[k]++; });
        return order.map(o => '<div class="br-tok br-' + side + '" data-card="' + esc(o.nm) + '"><div class="br-art" data-card="' + esc(o.nm) + '"></div><div class="br-nm">' + esc(o.nm) + '</div>' + (count[o.k] > 1 ? '<span class="br-badge">×' + count[o.k] + '</span>' : '') + '</div>').join('');
      };
      const otk = $('#br-oppTok'); if (otk) otk.innerHTML = tokHtml(stt.oppTokens, 'opp');
      const mtk = $('#br-meTok'); if (mtk) mtk.innerHTML = tokHtml(stt.meTokens, 'me');
      // Équipements détruits : masqués à partir de l'étape courante (réversible en
      // scrubbant la timeline — on repositionne la classe selon l'état de l'étape).
      applyEquipState('#br-fMe', stt.meEquipGone, stt.meEquipUsed);
      applyEquipState('#br-fOpp', stt.oppEquipGone, stt.oppEquipUsed);
      applyBornState('#br-fMe', stt.meBorn);
      applyBornState('#br-fOpp', stt.oppBorn);
      $('#br-fMe').classList.toggle('br-active', s.actor === 'me');
      $('#br-fOpp').classList.toggle('br-active', s.actor === 'opp');
      slider.value = i; slider.style.setProperty('--pct', (steps.length > 1 ? i / (steps.length - 1) * 100 : 0) + '%');
      $('#br-stepN').textContent = i + 1; $('#br-turnLbl').textContent = s.turn;
      container.querySelector('[data-act="prev"]').disabled = (i === 0);
      container.querySelector('[data-act="next"]').disabled = (i === steps.length - 1);
      if (s.hit && prev != null && prev < i) { const el = $(s.hit === 'me' ? '#br-mLifeTok' : '#br-oLifeTok'); if (el) { el.classList.remove('br-hit'); void el.offsetWidth; el.classList.add('br-hit'); } }
      if (s.form) { setHeroForm('me', s.form.me, '#br-fMe'); setHeroForm('opp', s.form.opp, '#br-fOpp'); }
      paintArt(container);
    }
    function go(n, prev) { i = Math.max(0, Math.min(steps.length - 1, n)); render(prev); container.__brIndex = i; }
    function stop() { playing = false; clearInterval(timer); $('.br-play').innerHTML = '▶'; $('.br-play').title = 'Lecture automatique'; }
    function play() { if (i >= steps.length - 1) go(0); playing = true; $('.br-play').innerHTML = '❚❚'; $('.br-play').title = 'Pause'; timer = setInterval(() => { if (i >= steps.length - 1) { stop(); return; } go(i + 1, i); }, 1150); }

    container.querySelector('[data-act="next"]').addEventListener('click', () => { stop(); go(i + 1, i); });
    container.querySelector('[data-act="prev"]').addEventListener('click', () => { stop(); go(i - 1, i); });
    container.querySelector('[data-act="restart"]').addEventListener('click', () => { stop(); go(0, null); });
    $('.br-play').addEventListener('click', () => { playing ? stop() : play(); });
    slider.addEventListener('input', () => { stop(); go(parseInt(slider.value, 10), i); });

    // ---- Survol : aperçu de la carte en grand (lisibilité ; desktop) ----
    // L'aperçu vit DANS le conteneur : en plein écran NATIF (requestFullscreen
    // sur #boardReplay) seul le sous-arbre du conteneur est rendu — un aperçu
    // placé ailleurs (ex. <body>) n'apparaîtrait pas. Le conteneur n'est pas
    // transformé (seul .br-wrap l'est, et l'aperçu en est un frère), donc
    // position:fixed reste relative à la fenêtre. Recréé à chaque montage
    // (container.innerHTML l'a effacé) ; les écouteurs sont posés une seule fois
    // et retrouvent l'aperçu courant dynamiquement (pas de closure périmée).
    container.querySelectorAll('.br-preview').forEach(e => e.remove());   // pas de doublon résiduel
    const preview = document.createElement('div');
    preview.className = 'br-preview';
    container.appendChild(preview);
    const PW = 224, PH = 313;
    function showPreview(tile) {
      const pv = container.querySelector('.br-preview'); if (!pv) return;
      const art = tile.matches('.br-art') ? tile : tile.querySelector('.br-art');
      if (!art || !art.classList.contains('has-img') || !art.style.backgroundImage) return;
      pv.style.backgroundImage = art.style.backgroundImage;
      const r = tile.getBoundingClientRect();
      let left = r.left + r.width / 2 - PW / 2;
      let top = r.top - PH - 10;
      if (top < 8) top = Math.min(r.bottom + 10, window.innerHeight - PH - 8);
      left = Math.max(8, Math.min(left, window.innerWidth - PW - 8));
      pv.style.left = left + 'px';
      pv.style.top = Math.max(8, top) + 'px';
      pv.classList.add('show');
    }
    if (!container.__brHoverBound) {
      container.__brHoverBound = true;
      container.addEventListener('mouseover', e => { const t = e.target.closest('[data-card]'); if (t) showPreview(t); });
      container.addEventListener('mouseout', e => { const t = e.target.closest('[data-card]'); if (t) { const pv = container.querySelector('.br-preview'); if (pv) pv.classList.remove('show'); } });
    }

    // ---- Hauteur du stage figée : sinon la « carte d'action » change de taille
    // d'une étape à l'autre (bannière courte vs carte jouée haute vs combat) et
    // fait sauter la mise en page — sur mobile les boutons au-dessus finissaient
    // hors écran. On mesure le contenu le plus haut parmi TOUTES les étapes (les
    // dimensions sont fixées par le CSS, indépendamment du chargement des images)
    // et on fige cette hauteur. Recalculé si la largeur change (rotation, bascule
    // mobile/desktop) car le passage à la ligne des cartes dépend de la largeur.
    function stabilizeStage() {
      if (!stage.offsetParent) return;             // onglet caché → pas de layout fiable
      // Sur desktop, la piste est bornée à la LARGEUR du plus grand contenu pour
      // que les PV (à sa gauche) restent collés au combat au lieu de flotter au
      // bord ; sur mobile elle remplit l'espace restant (flex) → largeur libre.
      const wide = !!(window.matchMedia && window.matchMedia('(min-width: 900px)').matches);
      const savedH = stage.style.height, savedMin = stage.style.minHeight;
      stage.style.height = 'auto'; stage.style.minHeight = '0'; stage.style.width = 'auto';
      let maxH = 0, maxW = 0;
      for (const s of steps) { stage.innerHTML = buildStage(s.stage); if (stage.offsetHeight > maxH) maxH = stage.offsetHeight; if (stage.offsetWidth > maxW) maxW = stage.offsetWidth; }
      if (!maxH) { stage.style.height = savedH; stage.style.minHeight = savedMin; stage.style.width = ''; render(null); return; }
      stage.style.minHeight = '0';
      // PLAFOND (mobile) : une seule étape exceptionnellement haute (gros combat
      // avec beaucoup de blocs) ne doit pas réserver un centre géant qui gâche
      // l'espace sur les étapes courantes (bannières/plays) et écrase le plateau.
      // On borne la hauteur figée à une fraction de la fenêtre ; la rare étape
      // plus haute défile alors à l'intérieur (overflow). Desktop : pas de
      // plafond (la place verticale y est suffisante).
      const cap = wide ? maxH : Math.min(maxH, Math.round(window.innerHeight * 0.40));
      stage.style.height = cap + 'px';
      stage.style.overflowY = cap < maxH ? 'auto' : '';
      stage.style.width = wide && maxW ? maxW + 'px' : '';
      render(null);                                // ré-affiche l'étape courante dans la boîte figée
    }

    // ---- Ajustement à l'écran : on met TOUT le plateau à l'échelle pour qu'il
    // tienne dans la fenêtre (fini le zoom manuel). Le contenu vertical (2 mains
    // + 2 champs + combat + timeline) est trop dense pour tenir en réduisant
    // seulement les cartes ; on applique donc une échelle globale (comme un zoom
    // navigateur) — l'aperçu au survol reste pour lire une carte en détail.
    function fitBoard() {
      const wrap = container.querySelector('.br-wrap');
      if (!wrap || !wrap.offsetParent) return;
      const fs = container.classList.contains('br-fs');   // plein écran → toute la fenêtre
      wrap.style.transform = ''; wrap.style.marginRight = ''; wrap.style.marginBottom = ''; wrap.style.width = ''; container.style.height = '';   // remise à zéro pour mesurer
      // On prend l'EMPREINTE RÉELLE du contenu (scrollWidth/Height) et pas juste
      // offsetWidth : sur mobile la table peut être plus large que son cadre
      // (sinon, en plein écran, l'arsenal de droite était rogné).
      const natW = Math.max(wrap.offsetWidth, wrap.scrollWidth);
      const natH = Math.max(wrap.offsetHeight, wrap.scrollHeight);
      if (!natW || !natH) return;
      // On VERROUILLE la largeur mesurée : sinon la marge droite négative (ci-
      // dessous, qui retire le fantôme de transform) ré-élargit un wrap en largeur
      // auto (auto = conteneur − marges → +416px), le contenu se re-dispose plus
      // large et DÉBORDE une fois mis à l'échelle (bug PC/plein écran). Largeur
      // figée → la marge négative ne fait que retirer le fantôme, sans élargir.
      wrap.style.width = natW + 'px';
      const top = fs ? 0 : container.getBoundingClientRect().top;
      const availH = (fs ? window.innerHeight : window.innerHeight - top) - 12;
      // Largeur dispo = largeur de CONTENU (on retire le padding du conteneur,
      // ex. 6px en plein écran) → le plateau remplit pile la zone sans déborder.
      const _cs = window.getComputedStyle(container);
      const availW = container.clientWidth - (parseFloat(_cs.paddingLeft) || 0) - (parseFloat(_cs.paddingRight) || 0);
      // Hors plein écran (desktop ET mobile) : on remplit la LARGEUR, quitte à
      // défiler un peu verticalement. Sur mobile, dépendre de la hauteur rendait
      // le plateau étroit à l'ouverture (barre d'adresse visible → hauteur dispo
      // réduite → mise à l'échelle sur la hauteur), puis pleine largeur après un
      // scroll (barre repliée) — incohérent. La largeur ne dépend pas de la barre
      // d'adresse → plateau pleine largeur dès l'ouverture, partout.
      // On remplit la LARGEUR dans TOUS les cas (normal ET plein écran) : le
      // comportement est identique dans les deux modes (le plateau ne « bouge »
      // pas en basculant) et ne dépend JAMAIS de la hauteur → largeur stable dès
      // l'ouverture (barre d'adresse mobile sans effet) et d'une étape à l'autre.
      // SEUL le PLEIN ÉCRAN cale sur la hauteur (tout tient sans scroll, centré).
      // En FENÊTRÉ (PC comme mobile), on remplit la LARGEUR — cartes plus grandes,
      // quitte à défiler un peu verticalement (choix retenu : lisibilité > absence
      // de scroll ; le plein écran reste la vue « tout à l'écran »).
      const fitHeight = fs;
      const scale = fitHeight ? Math.min(availW / natW, availH / natH, 1) : Math.min(availW / natW, 1);
      const sw = natW * scale, sh = natH * scale;
      const dx = Math.max(0, (availW - sw) / 2);
      // Plein écran : on centre aussi VERTICALEMENT (on exploite l'espace en bas).
      // Hors plein écran : calé en haut (dy=0) — le plateau tient déjà dans la zone.
      const dy = fs ? Math.max(0, (availH - sh) / 2) : 0;
      wrap.style.transformOrigin = 'top left';
      wrap.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ')';
      // transform NE change PAS la taille de LAYOUT : le conteneur verrait sinon
      // une largeur/hauteur « fantôme » (= taille NON réduite) → barre de scroll
      // horizontale en plein écran + flux vertical faux. On retire cet espace
      // fantôme par des marges négatives : l'empreinte de layout = taille VISIBLE.
      wrap.style.marginRight = Math.round(sw - natW) + 'px';
      wrap.style.marginBottom = Math.round(sh - natH) + 'px';
    }
    // Ordre : figer la piste (hauteur stable), PUIS mettre à l'échelle l'ensemble.
    function relayout() { const w = container.querySelector('.br-wrap'); if (w) w.style.transform = ''; stabilizeStage(); fitBoard(); }

    if (window.ResizeObserver) {
      let raf = 0, lastW = -1;
      const ro = new ResizeObserver(() => {
        // Ne réagir qu'aux changements de LARGEUR : figer le stage change la
        // hauteur du conteneur, ce qui re-déclencherait l'observateur en boucle.
        const w = Math.round(container.clientWidth);
        if (w === lastW) return;
        lastW = w;
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; relayout(); });
      });
      ro.observe(container);
    }
    // Changements de hauteur du viewport (rotation, barre d'URL mobile, fenêtre) :
    let rraf = 0;
    window.addEventListener('resize', () => { if (rraf) return; rraf = requestAnimationFrame(() => { rraf = 0; relayout(); }); });

    // ---- Plein écran : agrandit le plateau pour la lisibilité (PC + mobile) ----
    // On combine l'API Fullscreen native (quand dispo : masque la barre du
    // navigateur) avec un repli CSS (.br-fs = position:fixed) qui, lui, marche
    // partout (dont iOS). Dans les deux cas fitBoard récupère toute la fenêtre.
    const fsBtn = document.createElement('button');
    fsBtn.className = 'br-fsbtn'; fsBtn.type = 'button';
    fsBtn.title = 'Plein écran'; fsBtn.setAttribute('aria-label', 'Plein écran');
    fsBtn.textContent = '⛶';
    container.appendChild(fsBtn);
    const inFs = () => container.classList.contains('br-fs');
    function paintFsBtn() { const on = inFs(); fsBtn.textContent = on ? '✕' : '⛶'; fsBtn.title = on ? 'Quitter le plein écran' : 'Plein écran'; fsBtn.setAttribute('aria-pressed', on); }
    function setFs(on) { container.classList.toggle('br-fs', on); paintFsBtn(); requestAnimationFrame(relayout); }
    function toggleFs() {
      if (!inFs()) {
        setFs(true);
        const req = container.requestFullscreen || container.webkitRequestFullscreen;
        if (req) { try { const r = req.call(container); if (r && r.catch) r.catch(() => {}); } catch (e) { /* repli CSS */ } }
      } else {
        setFs(false);
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if ((document.fullscreenElement || document.webkitFullscreenElement) && exit) { try { exit.call(document); } catch (e) { /* ignore */ } }
      }
    }
    fsBtn.addEventListener('click', toggleFs);
    // Sortie du plein écran natif (Échap, geste système) → on retire aussi la classe.
    const onFsChange = () => { if (!(document.fullscreenElement || document.webkitFullscreenElement) && inFs()) container.classList.remove('br-fs'); paintFsBtn(); requestAnimationFrame(relayout); };
    const onKey = e => { if (e.key === 'Escape' && inFs() && !(document.fullscreenElement || document.webkitFullscreenElement)) setFs(false); };
    // On nettoie les écouteurs du montage précédent (le plateau est reconstruit à
    // chaque partie ouverte) pour ne pas les empiler.
    if (container.__brFsCleanup) container.__brFsCleanup();
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    document.addEventListener('keydown', onKey);
    container.__brFsCleanup = () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      document.removeEventListener('keydown', onKey);
    };

    go(0, null);
    relayout();
  }

  root.BoardReplay = { mount, buildTimeline };
  if (typeof module === 'object' && module.exports) module.exports = root.BoardReplay;
})(typeof self !== 'undefined' ? self : this);
