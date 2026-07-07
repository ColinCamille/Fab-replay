/* ============================================================
 * REPLAY — replay d'UNE partie, tour par tour.
 * ------------------------------------------------------------
 * Extrait tel quel du viewer standalone (v4). Le comportement de
 * replay est IDENTIQUE : seule la source des images a changé
 * (module partagé CardImages au lieu de fonctions inline).
 *
 * API publique :
 *   Replay.show(record)  → affiche le record parsé (venu de la DB
 *                          ou d'un import direct) dans #replayView.
 *   Replay.reset()       → vide l'affichage.
 *
 * Le parsing vit dans talishar-parser.js ; ce module ne fait que
 * du rendu + de la résolution d'images.
 * ============================================================ */
(function (root) {
  'use strict';

  const resolveCardImage = (n) => root.CardImages.resolveCardImage(n);
  const resolveCardMeta = (n) => root.CardImages.resolveCardMeta(n);

  // ============================================================
  // ÉTAT
  // ============================================================
  let GAME = null;
  let myName = null, oppName = null;
  let myEquipNamesNorm = new Set(); // noms d'équipement (normalisés) — jamais des cartes de main/arsenal
  let currentTurnIndex = 0;
  let showTechnical = false;
  let maxLife = 40; // échelle de la courbe (déduit du record)
  let inited = false;

  const $ = sel => document.querySelector(sel);

  function init() {
    if (inited) return;
    inited = true;
    $('#prevTurn').addEventListener('click', () => { if (currentTurnIndex > 0) { currentTurnIndex--; renderChainActive(); renderTurn(); } });
    $('#nextTurn').addEventListener('click', () => { if (currentTurnIndex < GAME.turns.length - 1) { currentTurnIndex++; renderChainActive(); renderTurn(); } });
    $('#detailToggle').addEventListener('change', e => { showTechnical = e.target.checked; renderTurn(); });
  }

  // ============================================================
  // POINT D'ENTRÉE
  // ============================================================
  function show(record) {
    init();
    GAME = record;
    myName = GAME.myName;
    oppName = GAME.oppName;
    // Sécurité : record ancien sans identité résolue → repli sur la liste.
    if (!myName && GAME.playersList && GAME.playersList.length) {
      myName = GAME.playersList[0];
      oppName = GAME.playersList.find(p => p !== myName) || null;
    }
    myEquipNamesNorm = new Set(
      Object.values((GAME.players.me && GAME.players.me.equipment) || {}).map(e => e && e.name).filter(Boolean).map(root.TalisharParser.normName)
    );
    maxLife = Math.max(40,
      GAME.players.me.startLife || 0, GAME.players.opp.startLife || 0,
      ...GAME.lifeSeries.me, ...GAME.lifeSeries.opp);
    currentTurnIndex = 0;
    showTechnical = $('#detailToggle') ? $('#detailToggle').checked : false;
    render();
  }

  function reset() {
    GAME = null;
    const sb = $('#scoreboard'); if (sb) sb.style.display = 'none';
    const es = $('#replayEmpty'); if (es) es.style.display = 'block';
  }

  // ============================================================
  // RENDU
  // ============================================================
  function render() {
    const es = $('#replayEmpty'); if (es) es.style.display = 'none';
    $('#scoreboard').style.display = 'block';
    ARSENAL_BACKFILL = computeArsenalBackfill();
    renderMatchBanner();
    renderCurve();
    renderChain();
    renderTurn();
    renderStats();
  }

  function renderMatchBanner() {
    const el = $('#matchBanner');
    const me = GAME.players.me, opp = GAME.players.opp;
    const dur = root.TalisharParser.formatDuration(GAME.timeline.durationSec);
    const curMe = GAME.life[myName] != null ? GAME.life[myName] : (me.startLife || maxLife);
    const curOpp = GAME.life[oppName] != null ? GAME.life[oppName] : (opp.startLife || maxLife);

    // Verdict (filigrane diagonal)
    let verdict = '<span class="verdict unknown">En cours</span>';
    if (GAME.result) {
      verdict = GAME.result.iWon
        ? '<span class="verdict win">Victoire' + (GAME.result.byConcession ? '·abandon' : '') + '</span>'
        : '<span class="verdict loss">Défaite' + (GAME.result.byConcession ? '·abandon' : '') + '</span>';
    }

    const chips = [];
    if (GAME.format) chips.push('<span class="match-chip">🎮 ' + escapeHtml(GAME.format) + '</span>');
    if (dur) chips.push('<span class="match-chip">⏱ ' + dur + '</span>');
    chips.push('<span class="match-chip">🔁 ' + GAME.turns.length + ' tours</span>');
    if (GAME.vsAI) chips.push('<span class="match-chip ai">🤖 vs IA</span>');
    if (GAME.warnings && GAME.warnings.length) chips.push('<span class="match-chip warn" title="' + escapeHtml(GAME.warnings.join(' | ')) + '">⚠ ' + GAME.warnings.length + '</span>');

    const sideHtml = (p, cur, side) => {
      const initial = escapeHtml((p.hero || p.name || '?').charAt(0).toUpperCase());
      const low = cur <= 10 ? ' low' : '';
      return '<div class="match-side ' + side + '">' +
        '<div class="hero-avatar" data-hero="' + escapeHtml(p.hero || '') + '">' + initial + '</div>' +
        '<div class="hero-meta">' +
          '<div class="hname">' + escapeHtml(p.hero || '?') + '</div>' +
          '<div class="pname">' + escapeHtml(p.name || '?') + (side === 'me' ? ' (toi)' : '') + '</div>' +
          '<div class="plife' + low + '">' + cur + ' pv</div>' +
        '</div></div>';
    };

    const eqStrip = (p, side) => {
      const slots = root.TalisharParser.EQ_SLOTS
        .map(s => p.equipment && p.equipment[s] ? p.equipment[s] : null)
        .filter(Boolean);
      const label = '<div class="eq-label ' + side + '">' + (side === 'me' ? 'Toi' : 'Adv') + '</div>';
      if (!slots.length) return '<div class="eq-strip">' + label + '<div class="eq-empty">équipement non capté</div></div>';
      const cells = slots.map(eq =>
        '<div class="eq-slot" data-card="' + escapeHtml(eq.name) + '" title="' + escapeHtml(eq.name) + '">' +
        '<div class="eq-ph">🛡</div></div>').join('');
      return '<div class="eq-strip">' + label + '<div class="eq-slots">' + cells + '</div></div>';
    };

    el.innerHTML =
      '<div class="match-card">' +
        verdict +
        '<div class="match-heroes">' +
          sideHtml(me, curMe, 'me') +
          '<div class="match-mid"><span class="vs">VS</span></div>' +
          sideHtml(opp, curOpp, 'opp') +
        '</div>' +
        '<div class="match-meta">' + chips.join('') + '</div>' +
        eqStrip(me, 'me') +
        eqStrip(opp, 'opp') +
      '</div>';

    // Charger les portraits de héros (async)
    el.querySelectorAll('.hero-avatar[data-hero]').forEach(av => {
      const hero = av.getAttribute('data-hero');
      if (!hero) return;
      resolveCardImage(hero).then(url => { if (url) av.innerHTML = '<img src="' + url + '" alt="' + escapeHtml(hero) + '" loading="lazy">'; });
    });
    // Charger les visuels d'équipement (async)
    el.querySelectorAll('.eq-slot[data-card]').forEach(slot => {
      const card = slot.getAttribute('data-card');
      resolveCardImage(card).then(url => { if (url) slot.innerHTML = '<img src="' + url + '" alt="' + escapeHtml(card) + '" loading="lazy">'; });
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function renderCurve() {
    const svg = $('#curveSvg');
    const seriesMe = GAME.lifeSeries.me, seriesOpp = GAME.lifeSeries.opp;
    const n = GAME.turns.length;
    const W = 400, H = 132;
    const padL = 26, padR = 8, padTop = 10, padBot = 20;
    const plotW = W - padL - padR, plotH = H - padTop - padBot;
    const x = i => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = v => padTop + plotH - (Math.max(0, v) / maxLife) * plotH;
    const line = arr => arr.map((v, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const area = arr => line(arr) + ' L' + x(n - 1).toFixed(1) + ',' + y(0).toFixed(1) + ' L' + x(0).toFixed(1) + ',' + y(0).toFixed(1) + ' Z';
    const dots = (arr, color) => arr.map((v, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${i === currentTurnIndex ? 3.2 : 1.8}" fill="${color}" ${i === currentTurnIndex ? 'stroke="#e9e6da" stroke-width="1"' : ''}/>`
    ).join('');

    // ---- Axe Y : repères de vie (0, moitié, max) ----
    const yTicks = [0, Math.round(maxLife / 2), maxLife];
    const yAxis = yTicks.map(v =>
      `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="#262c3d" stroke-width="1"/>` +
      `<text class="curve-axis-label" x="${padL - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`
    ).join('');

    // ---- Axe X : numéros de tour, avec espacement adaptatif ----
    const step = n <= 11 ? 1 : Math.ceil(n / 11);
    let xAxis = '';
    for (let i = 0; i < n; i += step) {
      const t = GAME.turns[i];
      const label = (t.turnNumber === 0 && i === 0) ? '⚡' : String(t.turnNumber);
      xAxis += `<text class="curve-axis-label" x="${x(i).toFixed(1)}" y="${H - 4}" text-anchor="middle">${label}</text>`;
    }
    // seuil zone critique (10 pv)
    const critY = y(10);
    const endMe = seriesMe[seriesMe.length - 1], endOpp = seriesOpp[seriesOpp.length - 1];

    svg.innerHTML = `
      <defs>
        <linearGradient id="gradMe" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#c9a227" stop-opacity=".28"/>
          <stop offset="100%" stop-color="#c9a227" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="gradOpp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#8b6bff" stop-opacity=".22"/>
          <stop offset="100%" stop-color="#8b6bff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect x="${padL}" y="${critY.toFixed(1)}" width="${plotW}" height="${(padTop + plotH - critY).toFixed(1)}" fill="rgba(224,85,90,.07)"/>
      <line x1="${padL}" y1="${critY.toFixed(1)}" x2="${W - padR}" y2="${critY.toFixed(1)}" stroke="rgba(224,85,90,.35)" stroke-width="1" stroke-dasharray="3,4"/>
      ${yAxis}
      ${xAxis}
      <path d="${area(seriesOpp)}" fill="url(#gradOpp)"/>
      <path d="${area(seriesMe)}" fill="url(#gradMe)"/>
      <path d="${line(seriesOpp)}" fill="none" stroke="#8b6bff" stroke-width="2" opacity=".9"/>
      <path d="${line(seriesMe)}" fill="none" stroke="#c9a227" stroke-width="2.5"/>
      ${dots(seriesOpp, '#8b6bff')}
      ${dots(seriesMe, '#c9a227')}
      <line x1="${x(currentTurnIndex).toFixed(1)}" y1="${padTop - 6}" x2="${x(currentTurnIndex).toFixed(1)}" y2="${padTop + plotH}" stroke="#e9e6da" stroke-width="1" stroke-dasharray="2,3" opacity=".4"/>
      <text x="${(x(n - 1) - 2).toFixed(1)}" y="${(y(endMe) - 5).toFixed(1)}" text-anchor="end" font-family="'JetBrains Mono',monospace" font-size="10" font-weight="700" fill="#c9a227">${endMe}</text>
      <text x="${(x(n - 1) - 2).toFixed(1)}" y="${(y(endOpp) + 12).toFixed(1)}" text-anchor="end" font-family="'JetBrains Mono',monospace" font-size="10" font-weight="700" fill="#8b6bff">${endOpp}</text>
    `;

    // ---- Lecteur de valeurs pour le tour sélectionné ----
    const ro = $('#curveReadout');
    const curMe = seriesMe[currentTurnIndex], curOpp = seriesOpp[currentTurnIndex];
    const t = GAME.turns[currentTurnIndex];
    const tlabel = (t.turnNumber === 0 && currentTurnIndex === 0) ? 'Ouverture' : 'Tour ' + t.turnNumber;
    ro.innerHTML =
      '<span class="turnlbl">' + tlabel + '</span>' +
      '<span class="who"><span class="dot me"></span>Toi <span class="val">' + curMe + '</span></span>' +
      '<span class="who"><span class="dot opp"></span>Adv <span class="val">' + curOpp + '</span></span>';
  }

  function renderChain() {
    const chain = $('#chain');
    chain.innerHTML = '';
    // échelle des sparks : dégât max sur un tour
    let maxDmg = 1;
    GAME.turns.forEach(t => { maxDmg = Math.max(maxDmg, t.damageToMe || 0, t.damageToOpp || 0); });

    GAME.turns.forEach((t, i) => {
      const div = document.createElement('div');
      div.className = 'link' + (i === currentTurnIndex ? ' active' : '') + (t.player === myName ? ' me' : t.player === oppName ? ' opp' : '');

      // spark : on montre le flux de dégâts dominant du tour
      const dOpp = t.damageToOpp || 0, dMe = t.damageToMe || 0;
      let sparkHtml = '<div class="spark"></div>';
      if (dOpp > 0 || dMe > 0) {
        const toOpp = dOpp >= dMe;           // dégâts que TU infliges = positif (or)
        const val = toOpp ? dOpp : dMe;
        const hPct = Math.max(12, Math.round(val / maxDmg * 100));
        sparkHtml =
          '<div class="spark"><div class="bar ' + (toOpp ? 'toOpp' : 'toMe') + '" style="height:' + hPct + '%"></div></div>' +
          '<div class="dval ' + (toOpp ? 'toOpp' : 'toMe') + '">' + (toOpp ? '−' : '−') + val + '</div>';
      }

      div.innerHTML =
        '<div class="ring">' + (t.turnNumber === 0 && i === 0 ? '⚡' : t.turnNumber) + '</div>' +
        '<div class="lbl">' + (t.player || 'Début') + '</div>' +
        sparkHtml;
      div.addEventListener('click', () => { currentTurnIndex = i; render(); });
      chain.appendChild(div);
    });
  }

  const PRIMARY_TYPES = new Set(['played', 'pitched', 'activated', 'blocked', 'discarded', 'damageTaken', 'lifeGained', 'targeted', 'revealed', 'modeSelected', 'goAgain', 'undo', 'conceded', 'gameWon', 'combatResult']);

  function eventLine(e) {
    switch (e.type) {
      case 'played': return { badge: ['JOUE', 'b-played'], html: `<b>${e.player}</b> joue <b>${e.card}</b>${e.fromArsenal ? ' <span style="color:var(--text-faint)">(arsenal)</span>' : ''}`, card: e.card };
      case 'pitched': return { badge: ['PITCH', 'b-pitch'], html: `<b>${e.player}</b> pitch ${e.card}`, card: e.card };
      case 'activated': return { badge: ['ACTIVE', 'b-played'], html: `<b>${e.player}</b> active ${e.card}`, card: e.card };
      case 'blocked': return { badge: ['BLOQUE', 'b-block'], html: `<b>${e.player}</b> bloque avec ${e.cards.join(', ')}`, card: e.cards[0] };
      case 'discarded': return { badge: ['DÉFAUSSE', 'b-warn'], html: `${e.card} défaussée`, card: e.card };
      case 'damageTaken': return e.amount > 0 ? { badge: ['DÉGÂTS', 'b-dmg'], html: `<b>${e.player}</b> encaisse <b>${e.amount}</b> dégâts` } : { badge: ['0 DMG', 'b-info'], html: `${e.player} — 0 dégât (entièrement bloqué)`, secondary: true };
      case 'lifeGained': return { badge: ['SOIN', 'b-life'], html: `<b>${e.player}</b> regagne ${e.amount} pv` };
      case 'combatResult': return e.hit ? { badge: ['TOUCHÉ', 'b-dmg'], html: `Combat résolu — touché pour ${e.amount}` } : { badge: ['BLOQUÉ', 'b-block'], html: `Combat résolu — aucun dégât` };
      case 'targeted': return { badge: ['CIBLE', 'b-info'], html: `Cible : ${e.target}`, secondary: true };
      case 'revealed': return { badge: ['RÉVÈLE', 'b-info'], html: `<b>${e.player}</b> révèle ${e.card}`, card: e.card };
      case 'modeSelected': return { badge: ['MODE', 'b-info'], html: `Mode de ${e.card} : ${e.mode}` };
      case 'goAgain': return { badge: ['GO AGAIN', 'b-life'], html: `${e.card} — rejoue` };
      case 'undo': return { badge: ['ANNULE', 'b-warn'], html: `<b>${e.player}</b> annule sa dernière action` };
      case 'conceded': return { badge: ['ABANDON', 'b-warn'], html: `<b>${e.player}</b> abandonne` };
      case 'gameWon': return { badge: ['VICTOIRE', 'b-win'], html: `<b>${e.player}</b> remporte la partie` };
      case 'passed': return { badge: ['PASSE', 'b-info'], html: `${e.player} passe`, secondary: true };
      case 'autoPassed': return { badge: ['AUTO', 'b-info'], html: `${e.player} passe (auto)`, secondary: true };
      case 'endTurn': return { badge: ['FIN', 'b-info'], html: `${e.player} termine son tour`, secondary: true };
      case 'resolving': return { badge: ['RÉSOUT', 'b-info'], html: e.card ? `Résolution de ${e.card}` : e.text, secondary: true };
      case 'chainLinkResolved': return { badge: ['CHAÎNE', 'b-info'], html: `Maillon résolu`, secondary: true };
      case 'chainClosed': return { badge: ['CHAÎNE', 'b-info'], html: `Chaîne fermée`, secondary: true };
      case 'hitEffect': return { badge: ['EFFET', 'b-info'], html: `Effet de coup : ${e.card}`, secondary: true };
      case 'deckManipulation': return { badge: ['DECK', 'b-info'], html: e.card ? `${e.card} renvoyée dans le deck` : `Carte renvoyée dans le deck`, secondary: true };
      case 'deckShuffled': return { badge: ['DECK', 'b-info'], html: `Deck mélangé`, secondary: true };
      case 'targetedSecondary': return { badge: ['CIBLE', 'b-info'], html: `${e.owner}'s ${e.card} ciblée`, secondary: true };
      case 'damageAnnounced': return { badge: ['ANNONCE', 'b-info'], html: `${e.player} va prendre ${e.amount} dégâts`, secondary: true };
      case 'arcaneDamage': case 'info': case 'diceRoll': case 'firstPlayer':
        return { badge: ['INFO', 'b-info'], html: e.text, secondary: true };
      case 'unknown': return { badge: ['?', 'b-warn'], html: e.text, secondary: true };
      default: return { badge: ['·', 'b-info'], html: e.text || '', secondary: true };
    }
  }

  function extractTurnCards(turn) {
    const byPlayer = {};
    const ensure = p => { if (!byPlayer[p]) byPlayer[p] = []; return byPlayer[p]; };
    let lastKnownPlayer = turn.player;
    turn.events.forEach(e => {
      if (e.player) lastKnownPlayer = e.player;
      if (e.type === 'played') ensure(e.player).push({ card: e.card, action: 'play' });
      else if (e.type === 'pitched') ensure(e.player).push({ card: e.card, action: 'pitch' });
      else if (e.type === 'activated') ensure(e.player).push({ card: e.card, action: 'play' });
      else if (e.type === 'blocked') e.cards.forEach(c => ensure(e.player).push({ card: c, action: 'block' }));
      else if (e.type === 'revealed') ensure(e.player).push({ card: e.card, action: 'reveal' });
      else if (e.type === 'discarded') ensure(lastKnownPlayer).push({ card: e.card, action: 'discard' });
    });
    return byPlayer;
  }

  const ACTION_META = {
    play: { icon: '▶', cls: 'tag-play' },
    pitch: { icon: '🔥', cls: 'tag-pitch' },
    block: { icon: '🛡', cls: 'tag-block' },
    reveal: { icon: '👁', cls: 'tag-reveal' },
    discard: { icon: '🗑', cls: 'tag-discard' },
  };

  function prevOwnTurnIndex(i, player) {
    for (let j = i - 1; j >= 0; j--) if (GAME.turns[j].player === player) return j;
    return -1;
  }

  let ARSENAL_BACKFILL = {};
  function computeArsenalBackfill() {
    const map = {};
    GAME.turns.forEach((t, i) => {
      t.events.forEach(e => {
        if (e.type === 'played' && e.fromArsenal) {
          const j = prevOwnTurnIndex(i, e.player);
          if (j >= 0) {
            map[j] = map[j] || {};
            map[j][e.player] = map[j][e.player] || [];
            if (!map[j][e.player].some(g => g.card === e.card))
              map[j][e.player].push({ card: e.card, revealedLabel: t.label });
          }
        }
      });
    });
    return map;
  }

  function makeGhostChip(card, revealedLabel) {
    const chip = document.createElement('div');
    chip.className = 'card-chip ghost';
    chip.innerHTML = `<div class="art">${card}</div><span class="tag tag-arsenal">🔮</span><div class="cname">${card}</div>`;
    chip.title = 'Déduction certaine : posée en arsenal ce tour-là, révélée au ' + revealedLabel;
    const art = chip.querySelector('.art');
    resolveCardImage(card).then(url => { if (url) art.innerHTML = `<img src="${url}" alt="${card}" loading="lazy">`; });
    return chip;
  }

  function makeCardChip(card, action, small) {
    const chip = document.createElement('div');
    chip.className = 'card-chip';
    const meta = ACTION_META[action] || ACTION_META.play;
    chip.innerHTML = `
      <div class="art shimmer">${small ? '' : card}</div>
      <span class="tag ${meta.cls}">${meta.icon}</span>
      ${small ? '' : `<div class="cname">${card}</div>`}
    `;
    const artEl = chip.querySelector('.art');
    resolveCardImage(card).then(url => { artEl.classList.remove('shimmer'); if (url) artEl.innerHTML = `<img src="${url}" alt="${card}" loading="lazy">`; });
    return chip;
  }

  // Une carte jouée (hors arsenal) / pitchée / bloquée / défaussée ce tour
  // était forcément en main avant le début du tour — SAUF si c'est un
  // équipement connu (casque, torse, arme...) : on peut bloquer directement
  // avec de l'équipement déjà porté, sans qu'il soit jamais passé par la
  // main. On exclut donc systématiquement les noms d'équipement connus de
  // cette déduction, quelle que soit l'action qui les mentionne.
  function reconcileCertain(list, t, kind) {
    const norm = root.TalisharParser.normName;
    const result = (list || []).slice();
    const seen = new Set(result.map(norm));
    const tryAdd = c => {
      if (!c) return;
      const nc = norm(c);
      if (seen.has(nc) || myEquipNamesNorm.has(nc)) return;
      seen.add(nc); result.push(c);
    };
    let lastKnownPlayer = t.player;
    t.events.forEach(e => {
      if (e.player) lastKnownPlayer = e.player;
      if (kind === 'hand') {
        const owner = e.player || (e.type === 'discarded' ? lastKnownPlayer : null);
        if (owner !== myName) return;
        if (e.type === 'played' && !e.fromArsenal) tryAdd(e.card);
        if (e.type === 'pitched') tryAdd(e.card);
        // Blocages : ils prouvent qu'une carte était en main AU DÉBUT du tour —
        // sauf au tour d'ouverture. Quand tu es 2e joueur, l'« ouverture »
        // englobe le tour de l'adversaire pendant lequel tu ne fais que bloquer,
        // et l'instantané de main est pris à un autre moment que ces blocages :
        // les empiler gonfle la main (5 cartes au lieu de 4). On ignore donc les
        // blocages pour le seul tour d'ouverture.
        if (e.type === 'blocked' && e.cards && t.turnNumber !== 0) e.cards.forEach(tryAdd);
        // Une carte défaussée (coût, effet adverse forcé, etc.) vient de la
        // main dans l'immense majorité des cas du jeu — seule une carte jouée
        // depuis l'arsenal peut être détruite sans passer par la main, et ce
        // cas est déjà tracé séparément via l'événement 'played'.
        if (e.type === 'discarded') tryAdd(e.card);
      } else if (kind === 'arsenal') {
        if (e.player !== myName) return;
        if (e.type === 'played' && e.fromArsenal) tryAdd(e.card);
      }
    });
    return result;
  }

  function renderTurnBoard(t, buckets) {
    const wrap = $('#turnBoard');
    wrap.innerHTML = '';

    const meRow = document.createElement('div');
    meRow.className = 'board-row';
    const meTitle = document.createElement('div');
    meTitle.className = 'who me';
    meTitle.textContent = myName + ' (toi)';
    meRow.appendChild(meTitle);

    // Snapshots directement portés par le tour (résolus par le parseur),
    // complétés par les certitudes déduites du log (voir reconcileCertain).
    const rawHand = t.hand;   // tableau | null
    const hand = reconcileCertain(rawHand, t, 'hand');
    const handSub = document.createElement('div');
    handSub.className = 'captured-note';
    handSub.textContent = hand.length ? `✋ Main en début de tour (${hand.length})` : (rawHand === null ? '✋ Main — non capturée pour ce tour' : '✋ Main vide');
    meRow.appendChild(handSub);
    const handScroll = document.createElement('div');
    handScroll.className = 'board-scroll';
    handScroll.style.marginBottom = '10px';
    if (hand.length) {
      hand.forEach(c => { const chip = makeCardChip(c, 'play', false); chip.classList.add('captured'); chip.querySelector('.tag').remove(); handScroll.appendChild(chip); });
    } else {
      handScroll.innerHTML = '<div class="board-empty">' + (rawHand === null ? 'Non capturée pour ce tour' : 'Main vide') + '</div>';
    }
    meRow.appendChild(handScroll);

    const rawArsenal = t.arsenal;
    const arsenal = reconcileCertain(rawArsenal, t, 'arsenal');
    const arsenalSub = document.createElement('div');
    arsenalSub.className = 'captured-note';
    arsenalSub.textContent = arsenal.length ? `🎴 Arsenal en début de tour (${arsenal.length})` : (rawArsenal === null ? '🎴 Arsenal — non capturé pour ce tour' : '🎴 Arsenal vide');
    meRow.appendChild(arsenalSub);
    const arsenalScroll = document.createElement('div');
    arsenalScroll.className = 'board-scroll';
    arsenalScroll.style.marginBottom = '10px';
    if (arsenal.length) {
      arsenal.forEach(c => { const chip = makeCardChip(c, 'play', false); chip.classList.add('captured'); chip.querySelector('.tag').remove(); arsenalScroll.appendChild(chip); });
    } else {
      arsenalScroll.innerHTML = '<div class="board-empty">' + (rawArsenal === null ? 'Non capturé' : 'Arsenal vide') + '</div>';
    }
    meRow.appendChild(arsenalScroll);

    // Déroulé chronologique du tour, à la suite immédiate de la main et de
    // l'arsenal — on part de ce que tu avais, puis on déroule ce qui s'est
    // passé, sans dupliquer les cartes dans un bloc séparé.
    appendNarrative(meRow, 'me', buckets[myName] || []);
    wrap.appendChild(meRow);

    // ADVERSAIRE : déductions certaines (arsenal remonté depuis un tour futur)
    // puis, à la suite, son propre déroulé chronologique.
    const oppRow = document.createElement('div');
    oppRow.className = 'board-row';
    const oppTitle = document.createElement('div');
    oppTitle.className = 'who opp';
    oppTitle.textContent = oppName + ' — déductions certaines';
    oppRow.appendChild(oppTitle);

    const ghosts = (ARSENAL_BACKFILL[currentTurnIndex] && ARSENAL_BACKFILL[currentTurnIndex][oppName]) || [];
    if (ghosts.length) {
      const note = document.createElement('div');
      note.className = 'ghost-note';
      note.textContent = '🔮 Tenu en arsenal ce tour-là, révélé plus tard (certain)';
      oppRow.appendChild(note);
      const gScroll = document.createElement('div');
      gScroll.className = 'board-scroll';
      ghosts.forEach(g => gScroll.appendChild(makeGhostChip(g.card, g.revealedLabel)));
      oppRow.appendChild(gScroll);
    } else {
      const empty = document.createElement('div');
      empty.className = 'board-empty';
      empty.textContent = 'Aucune déduction certaine pour ce tour';
      oppRow.appendChild(empty);
    }

    appendNarrative(oppRow, 'opp', buckets[oppName] || []);
    wrap.appendChild(oppRow);
  }

  // Ajoute le fil chronologique (événements filtrés) d'un côté donné, à la
  // suite de ce qui a déjà été rendu pour ce côté (main+arsenal, ou
  // déductions certaines).
  function appendNarrative(container, side, events) {
    const visible = events.filter(passesFilter);
    const header = document.createElement('div');
    header.className = 'who ' + side;
    header.style.marginTop = '12px';
    header.textContent = '▶ Déroulé du tour (' + visible.length + ')';
    container.appendChild(header);
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-faint);font-size:.8rem;padding:6px 0 4px';
      empty.textContent = showTechnical ? 'Rien ce tour' : 'Rien de notable (active le détail technique pour tout voir)';
      container.appendChild(empty);
    } else {
      visible.forEach(e => container.appendChild(buildEventRow(e)));
    }
  }

  async function renderKnownCards() {
    const body = $('#knownCardsBody');
    const requestToken = ++renderKnownCards._token;
    const cumulative = { [myName]: [], [oppName]: [] };
    const seen = { [myName]: new Set(), [oppName]: new Set() };

    for (let ti = 0; ti <= currentTurnIndex; ti++) {
      const byPlayer = extractTurnCards(GAME.turns[ti]);
      [myName, oppName].forEach(player => {
        (byPlayer[player] || []).forEach(({ card, action }) => {
          if (!seen[player].has(card)) { seen[player].add(card); cumulative[player].push({ card, action }); }
        });
      });
    }

    body.innerHTML = '<div class="board-empty">Identification des équipements…</div>';
    const metaFor = {};
    const allCards = [...cumulative[myName], ...cumulative[oppName]].map(c => c.card);
    await Promise.all(allCards.map(async c => { metaFor[c] = await resolveCardMeta(c); }));
    if (requestToken !== renderKnownCards._token) return;

    body.innerHTML = '';
    [[myName, 'me'], [oppName, 'opp']].forEach(([player, side]) => {
      const list = cumulative[player];
      const equip = list.filter(c => metaFor[c.card] && metaFor[c.card].isEquipment);
      const other = list.filter(c => !(metaFor[c.card] && metaFor[c.card].isEquipment));
      const color = side === 'me' ? 'var(--gold)' : 'var(--violet)';

      const equipBlock = document.createElement('div');
      equipBlock.className = 'known-block';
      equipBlock.innerHTML = `<div class="who" style="color:${color}">🛡 ${player}${side === 'me' ? ' (toi)' : ''} — équipement en jeu (${equip.length})</div>`;
      const equipGrid = document.createElement('div'); equipGrid.className = 'known-grid';
      if (!equip.length) equipGrid.innerHTML = '<div class="board-empty">Aucun équipement identifié pour l\'instant</div>';
      else equip.forEach(({ card, action }) => equipGrid.appendChild(makeCardChip(card, action, true)));
      equipBlock.appendChild(equipGrid);
      body.appendChild(equipBlock);

      const otherBlock = document.createElement('div');
      otherBlock.className = 'known-block';
      otherBlock.innerHTML = `<div class="who" style="color:${color}">${player}${side === 'me' ? ' (toi)' : ''} — autres cartes vues (${other.length})</div>`;
      const otherGrid = document.createElement('div'); otherGrid.className = 'known-grid';
      if (!other.length) otherGrid.innerHTML = '<div class="board-empty">Aucune carte vue pour l\'instant</div>';
      else other.forEach(({ card, action }) => otherGrid.appendChild(makeCardChip(card, action, true)));
      otherBlock.appendChild(otherGrid);
      body.appendChild(otherBlock);
    });
  }
  renderKnownCards._token = 0;

  function buildEventRow(e) {
    const info = eventLine(e);
    const row = document.createElement('div');
    row.className = 'event' + (info.secondary ? ' secondary' : '');
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    row.appendChild(thumb);
    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.innerHTML = `<span class="badge ${info.badge[1]}">${info.badge[0]}</span>${info.html}`;
    row.appendChild(txt);
    if (info.card) {
      resolveCardImage(info.card).then(url => {
        if (url) thumb.innerHTML = `<img src="${url}" alt="${info.card}" loading="lazy">`;
        else thumb.textContent = '—';
      });
    } else {
      thumb.style.display = 'none';
    }
    return row;
  }

  function passesFilter(e) {
    const info = eventLine(e);
    if (!showTechnical && (info.secondary || !PRIMARY_TYPES.has(e.type)) && !['played', 'pitched', 'activated', 'blocked', 'discarded', 'damageTaken', 'lifeGained', 'modeSelected', 'goAgain', 'undo', 'conceded', 'gameWon', 'combatResult'].includes(e.type)) {
      return false;
    }
    return true;
  }

  function computeBuckets(t) {
    let lastKnownPlayer = t.player || myName;
    const buckets = { [myName]: [], [oppName]: [] };
    t.events.forEach(e => {
      if (e.player) lastKnownPlayer = e.player;
      let who = e.player || (e.type === 'targetedSecondary' ? e.owner : null) || lastKnownPlayer;
      if (who !== myName && who !== oppName) who = lastKnownPlayer === myName ? myName : oppName;
      (buckets[who] || buckets[myName]).push(e);
    });
    return buckets;
  }

  function renderTurn() {
    const t = GAME.turns[currentTurnIndex];
    $('#turnLabel').textContent = t.label + (t.durationSec != null ? ' · ' + root.TalisharParser.formatDuration(t.durationSec) : '');
    $('#prevTurn').disabled = currentTurnIndex === 0;
    $('#nextTurn').disabled = currentTurnIndex === GAME.turns.length - 1;

    const buckets = computeBuckets(t);
    renderTurnBoard(t, buckets);

    renderCurve();
    renderKnownCards();
  }

  function renderChainActive() { renderChain(); const active = document.querySelector('.link.active'); if (active && typeof active.scrollIntoView === 'function') { try { active.scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' }); } catch (e) {} } }

  // ---- Helpers graphes pour les stats ----
  // Barres groupées (ex. menacé/infligé/subi par tour)
  function svgGroupedBars(rows, series) {
    const W = 400, H = 150, padL = 22, padR = 6, padTop = 10, padBot = 20;
    const plotW = W - padL - padR, plotH = H - padTop - padBot, n = rows.length || 1;
    let max = 1; rows.forEach(r => series.forEach(s => { if ((r[s.key] || 0) > max) max = r[s.key] || 0; }));
    const groupW = plotW / n, barW = Math.min(9, (groupW - 2) / series.length);
    const y = v => padTop + plotH - (Math.max(0, v || 0) / max) * plotH;
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
    [0, Math.round(max / 2), max].forEach(v => { svg += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="#262c3d"/><text x="${padL - 3}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-family="'JetBrains Mono',monospace" font-size="8" fill="#565b6e">${v}</text>`; });
    rows.forEach((r, i) => {
      const cx = padL + groupW * i + groupW / 2, totalW = barW * series.length + (series.length - 1);
      series.forEach((s, j) => {
        const val = r[s.key] || 0, x = cx - totalW / 2 + j * (barW + 1);
        svg += `<rect x="${x.toFixed(1)}" y="${y(val).toFixed(1)}" width="${barW.toFixed(1)}" height="${(padTop + plotH - y(val)).toFixed(1)}" fill="${s.color}" rx="1"/>`;
      });
      svg += `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="8" fill="#565b6e">${r.turn}</text>`;
    });
    return svg + '</svg>';
  }
  // Barres de tempo : durée par tour, couleur par côté, plus long en rouge
  function svgTempoBars(turns) {
    const rows = turns.filter(t => t.durationSec != null && t.turnNumber > 0);
    if (!rows.length) return null;
    const W = 400, H = 150, padL = 26, padR = 6, padTop = 12, padBot = 20;
    const plotW = W - padL - padR, plotH = H - padTop - padBot, n = rows.length;
    let max = 1; rows.forEach(t => { if (t.durationSec > max) max = t.durationSec; });
    const groupW = plotW / n, barW = Math.min(16, groupW * 0.62);
    const y = v => padTop + plotH - (v / max) * plotH;
    const maxIdx = rows.reduce((mi, t, i, a) => t.durationSec > a[mi].durationSec ? i : mi, 0);
    const fmt = s => { const m = Math.floor(s / 60), ss = s % 60; return m ? m + 'm' + String(ss).padStart(2, '0') : s + 's'; };
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
    [0, Math.round(max / 2), max].forEach(v => { svg += `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" stroke="#262c3d"/><text x="${padL - 3}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-family="'JetBrains Mono',monospace" font-size="8" fill="#565b6e">${fmt(v)}</text>`; });
    rows.forEach((t, i) => {
      const cx = padL + groupW * i + groupW / 2, x = cx - barW / 2;
      const col = i === maxIdx ? '#e0555a' : (t.side === 'me' ? '#c9a227' : '#8b6bff');
      svg += `<rect x="${x.toFixed(1)}" y="${y(t.durationSec).toFixed(1)}" width="${barW.toFixed(1)}" height="${(padTop + plotH - y(t.durationSec)).toFixed(1)}" fill="${col}" rx="1.5"/>`;
      svg += `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="8" fill="#565b6e">${t.turnNumber}</text>`;
    });
    return svg + '</svg>';
  }
  // Barres de comparaison toi vs adversaire
  function cmpBars(me, opp) {
    const rows = [['Dégâts infligés', 'dealt'], ['Menace totale', 'threatened'], ['Dégâts bloqués', 'blocked'], ['Vie gagnée', 'lifeGained']];
    return rows.map(([lbl, key]) => {
      const mv = me.totals[key] || 0, ov = opp.totals[key] || 0, mx = Math.max(1, mv, ov);
      const bar = (v, cls) => `<div class="cmp-bar ${cls}" style="width:${(v / mx * 100).toFixed(1)}%"><span class="n ${v / mx < 0.28 ? 'out' : ''}">${v}</span></div>`;
      return `<div class="cmp-row"><div class="lbl">${lbl}</div><div class="bars">${bar(mv, 'me')}${bar(ov, 'opp')}</div></div>`;
    }).join('');
  }
  function cardTableHtml(cards) {
    const top = cards.filter(c => c.played || c.blocked || c.pitched || c.timesHit).sort((a, b) => b.played - a.played).slice(0, 14);
    return '<table class="off-table"><tr><th>Carte</th><th>Jouée</th><th>Bloquée</th><th>Pitch</th><th>Touché</th></tr>'
      + top.map(c => '<tr><td>' + c.name + '</td>'
        + '<td>' + (c.played || '<span class="muted">·</span>') + '</td>'
        + '<td>' + (c.blocked || '<span class="muted">·</span>') + '</td>'
        + '<td>' + (c.pitched || '<span class="muted">·</span>') + '</td>'
        + '<td class="' + (c.timesHit ? 'hit' : 'muted') + '">' + (c.timesHit || '·') + '</td></tr>').join('')
      + '</table>';
  }

  function renderStats() {
    const grid = $('#statGrid');
    const wrap = $('#statsWrap');
    const off = GAME.endStats && GAME.endStats.me;

    const extra = wrap.querySelector('#offExtra');
    if (extra) extra.remove();

    if (off) {
      wrap.querySelector('h3').textContent = 'Stats de la partie — officielles Talishar';
      const num = v => (v == null ? '—' : v);
      // efficacité offensive : part de la menace réellement infligée
      const eff = (off.totals.threatened && off.totals.dealt != null)
        ? Math.round(off.totals.dealt / off.totals.threatened * 100) + '%' : '—';
      const cards = [
        [num(off.totals.dealt), 'Dégâts infligés', 'gold'],
        [num(off.totals.threatened), 'Menace totale', 'violet'],
        [eff, 'Efficacité (infligé/menacé)', 'gold'],
        [num(off.totals.blocked), 'Dégâts bloqués', 'green'],
        [num(off.averages.dealtPerTurn), 'Dégâts infligés / tour', 'gold'],
        [num(off.averages.threatenedPerTurn), 'Menace / tour', 'violet'],
        [num(off.averages.threatenedPerCard), 'Menace / carte', 'violet'],
        [num(off.averages.value), 'Valeur / tour', ''],
        [num(off.averages.combatPerTurn), 'Valeur combat / tour', ''],
        [num(off.averages.resourcesPerTurn), 'Ressources / tour', ''],
        [num(off.totals.prevented), 'Dégâts prévenus', 'green'],
        [num(off.totals.lifeGained), 'Vie gagnée', 'green'],
      ];
      grid.innerHTML = cards.map(([v, k, c]) => `<div class="stat-card"><div class="v mono ${c}">${v}</div><div class="k">${k}</div></div>`).join('');

      const box = document.createElement('div');
      box.id = 'offExtra';
      let html = '<div class="off-note">Chiffres calculés par Talishar (fiables), intégrés à ton log par le grabber.</div>';

      // POINT 1 — déroulé tour par tour officiel
      if (off.turns && off.turns.length) {
        html += '<div class="off-chart"><h4>Déroulé tour par tour</h4>'
          + svgGroupedBars(off.turns, [
            { key: 'threatened', color: '#8b6bff' },
            { key: 'dealt', color: '#c9a227' },
            { key: 'taken', color: '#e0555a' }
          ])
          + '<div class="off-legend">'
          + '<span><span class="dot" style="background:#8b6bff"></span>Menacé</span>'
          + '<span><span class="dot" style="background:#c9a227"></span>Infligé</span>'
          + '<span><span class="dot" style="background:#e0555a"></span>Subi</span></div></div>';
      }

      // POINT 3 — tempo : durée de chaque tour (depuis les timestamps du log)
      const tempo = svgTempoBars(GAME.turns);
      if (tempo) {
        html += '<div class="off-chart"><h4>Tempo — durée de chaque tour</h4>' + tempo
          + '<div class="off-legend">'
          + '<span><span class="dot" style="background:#c9a227"></span>Ton tour</span>'
          + '<span><span class="dot" style="background:#8b6bff"></span>Tour adverse</span>'
          + '<span><span class="dot" style="background:#e0555a"></span>Le plus long</span></div>'
          + '<div class="off-note" style="margin-top:6px">Temps réel écoulé par tour (inclut les réactions de l\'adversaire).</div></div>';
      }

      // POINT 2 — comparaison toi vs adversaire (si dispo via swap)
      const opp = GAME.endStats.opp;
      if (opp) {
        html += '<div class="off-chart"><h4>Toi vs adversaire</h4>' + cmpBars(off, opp)
          + '<div class="off-legend">'
          + '<span><span class="dot" style="background:#c9a227"></span>Toi</span>'
          + '<span><span class="dot" style="background:#8b6bff"></span>Adversaire</span></div></div>';
      }

      // Tableau des cartes (toi)
      if (off.cards && off.cards.length) html += '<h4 style="font-family:\'Cinzel\',serif;font-size:.8rem;color:var(--text-dim);margin:16px 0 4px;font-weight:600">Tes cartes</h4>' + cardTableHtml(off.cards);
      box.innerHTML = html;
      wrap.appendChild(box);

      // Bloc adverse détaillé (grille + cartes) si dispo
      if (opp) {
        let oh = '<h3 style="margin-top:20px">Adversaire — stats officielles</h3>'
          + '<div class="off-note">Capturées grâce à « Switch Player Stats ».</div>';
        const num2 = v => (v == null ? '—' : v);
        const ocards = [
          [num2(opp.totals.dealt), 'Dégâts infligés', 'gold'],
          [num2(opp.totals.threatened), 'Menace totale', 'violet'],
          [num2(opp.totals.blocked), 'Dégâts bloqués', 'green'],
        ];
        oh += '<div class="stat-grid">' + ocards.map(([v, k, c]) => `<div class="stat-card"><div class="v mono ${c}">${v}</div><div class="k">${k}</div></div>`).join('') + '</div>';
        if (opp.cards && opp.cards.length) oh += cardTableHtml(opp.cards);
        const holder = document.createElement('div');
        holder.innerHTML = oh;
        box.appendChild(holder);
      }
      return;
    }

    // Repli : stats reconstruites depuis le log (si pas de bloc officiel)
    wrap.querySelector('h3').textContent = 'Stats de la partie';
    const s = GAME.stats;
    const cards = [
      [s.damageDealt, 'Dégâts infligés'],
      [s.damageTaken, 'Dégâts encaissés'],
      [s.blocks, 'Blocages effectués'],
      [s.pitches, 'Cartes pitchées'],
      [s.myTurns, 'Tes tours'],
      [s.distinctCards, 'Cartes distinctes vues'],
    ];
    grid.innerHTML = cards.map(([v, k]) => `<div class="stat-card"><div class="v mono">${v}</div><div class="k">${k}</div></div>`).join('');
  }

  root.Replay = { show, reset };
})(typeof self !== 'undefined' ? self : this);
