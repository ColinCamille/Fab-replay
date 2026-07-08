/* ============================================================
 * DASHBOARD — tableau de bord multi-parties.
 * ------------------------------------------------------------
 * Deux parties nettement séparées :
 *   1. Un CŒUR D'AGRÉGATION pur (aggregate) — aucune dépendance
 *      au DOM, exportable en Node → testé unitairement.
 *   2. Une couche de RENDU (mount/refresh) qui lit les filtres,
 *      appelle aggregate et peint les sections.
 *
 * Toutes les agrégations sont dérivées du record parsé (voir §7
 * de la passation). On travaille sur des « entrées » de la DB :
 *   { gameId, record, ... }  (voir js/db.js)
 * ============================================================ */
(function (root) {
  'use strict';

  const norm = s => {
    if (root.TalisharParser && root.TalisharParser.normName) return root.TalisharParser.normName(s);
    return String(s || '').trim().toLowerCase();
  };

  // ---------- Extracteurs élémentaires ----------

  // Issue de la partie du point de vue du joueur local : true/false/null.
  // result.iWon fait autorité ; à défaut on retombe sur endStats.me.won.
  function outcome(rec) {
    if (rec.result && rec.result.iWon != null) return !!rec.result.iWon;
    if (rec.endStats && rec.endStats.me && rec.endStats.me.won != null) return !!rec.endStats.me.won;
    return null;
  }
  function isVsAI(rec) { return rec.vsAI === true; }
  function oppHeroOf(rec) { return (rec.players && rec.players.opp && rec.players.opp.hero) || null; }
  function myHeroOf(rec) { return (rec.players && rec.players.me && rec.players.me.hero) || null; }
  // Axe temporel : capturedAt (ISO, triable) prioritaire, sinon parsedAt.
  function dateOf(rec) {
    const src = rec.source || {};
    return src.capturedAt || src.parsedAt || null;
  }
  function firstPlayerOf(rec) {
    if (rec.endStats && rec.endStats.me && rec.endStats.me.firstPlayer != null) return !!rec.endStats.me.firstPlayer;
    return null;
  }

  function passesFilters(rec, f) {
    if (!f.includeAI && isVsAI(rec)) return false;
    if (f.format && (rec.format || null) !== f.format) return false;
    if (f.myHero && myHeroOf(rec) !== f.myHero) return false;
    if (f.oppHero && oppHeroOf(rec) !== f.oppHero) return false;
    if (f.period && f.period !== 'all') {
      const d = dateOf(rec);
      if (!d) return false;
      const days = { '7d': 7, '30d': 30, '90d': 90 }[f.period];
      if (days) {
        const t = Date.parse(d);
        if (!isFinite(t)) return false;
        if (Date.now() - t > days * 86400000) return false;
      }
    }
    return true;
  }

  function winrate(wins, decided) { return decided > 0 ? Math.round(wins / decided * 100) : null; }

  // ---------- Cœur d'agrégation ----------
  // entries : [{ gameId, record }] ; filters : { includeAI, format, oppHero, period }
  function aggregate(entries, filters) {
    const f = Object.assign({ includeAI: false, format: null, myHero: null, oppHero: null, period: 'all' }, filters || {});

    // Facettes (listes de valeurs) calculées sur TOUT, pour peupler les filtres.
    const formats = new Set(), oppHeroes = new Set(), myHeroes = new Set();
    entries.forEach(e => {
      if (e.record.format) formats.add(e.record.format);
      const oh = oppHeroOf(e.record); if (oh) oppHeroes.add(oh);
      const mh = myHeroOf(e.record); if (mh) myHeroes.add(mh);
    });

    const kept = entries.filter(e => passesFilters(e.record, f));

    // Tri chronologique (ancien → récent) pour la tendance ;
    // l'affichage de la liste se fait ensuite en ordre inverse.
    kept.sort((a, b) => {
      const da = Date.parse(dateOf(a.record) || '') || 0;
      const db = Date.parse(dateOf(b.record) || '') || 0;
      return da - db;
    });

    // Global
    let wins = 0, decided = 0;
    kept.forEach(e => { const o = outcome(e.record); if (o != null) { decided++; if (o) wins++; } });

    // Accumulateur héros → { games, wins, decided, first/second }, chaque entrée
    // portant aussi le détail 1er vs 2e joueur (pour l'avantage d'initiative).
    function heroBreakdown(heroPick) {
      const map = {};
      kept.forEach(e => {
        const hero = heroPick(e.record) || '(inconnu)';
        const o = outcome(e.record);
        const fp = firstPlayerOf(e.record);
        const m = map[hero] || (map[hero] = { hero, games: 0, wins: 0, decided: 0, first: { games: 0, wins: 0 }, second: { games: 0, wins: 0 } });
        m.games++;
        if (o != null) {
          m.decided++; if (o) m.wins++;
          if (fp != null) { const s = fp ? m.first : m.second; s.games++; if (o) s.wins++; }
        }
      });
      return Object.values(map)
        .map(m => ({
          hero: m.hero, games: m.games, wins: m.wins, losses: m.decided - m.wins, decided: m.decided, winrate: winrate(m.wins, m.decided),
          first: { games: m.first.games, wins: m.first.wins, winrate: winrate(m.first.wins, m.first.games) },
          second: { games: m.second.games, wins: m.second.wins, winrate: winrate(m.second.wins, m.second.games) }
        }))
        .sort((a, b) => b.games - a.games || (b.winrate || 0) - (a.winrate || 0));
    }

    // Par matchup (héros adverse) et par héros joué (« tes decks »).
    const byMatchup = heroBreakdown(oppHeroOf);
    const byMyHero = heroBreakdown(myHeroOf);

    // Meilleurs / pires matchups : on classe par winrate, en excluant les héros
    // inconnus et en exigeant un minimum de parties décidées pour éviter le
    // bruit d'un 1-0 ou 0-1. Le seuil s'abaisse à 1 s'il n'y a pas assez de
    // données, pour toujours montrer quelque chose d'utile.
    // IMPORTANT : « meilleurs » = winrate > 50 % SEULEMENT, « pires » = < 50 %
    // seulement. Un matchup gagné (p.ex. 100 %) ne doit jamais tomber côté
    // « pires » sous prétexte qu'il est un peu moins bon que les autres ; les
    // matchups à exactement 50 % n'apparaissent dans aucune des deux colonnes.
    const rankable0 = byMatchup.filter(m => m.hero !== '(inconnu)' && m.winrate != null);
    const minGames = rankable0.some(m => m.decided >= 2) ? 2 : 1;
    const rankable = rankable0.filter(m => m.decided >= minGames);
    const bestMatchups = rankable.filter(m => m.winrate > 50)
      .sort((a, b) => b.winrate - a.winrate || b.decided - a.decided).slice(0, 5);
    const worstMatchups = rankable.filter(m => m.winrate < 50)
      .sort((a, b) => a.winrate - b.winrate || b.decided - a.decided).slice(0, 5);

    // 1er vs 2e joueur
    const fs = { first: { games: 0, wins: 0 }, second: { games: 0, wins: 0 } };
    kept.forEach(e => {
      const fp = firstPlayerOf(e.record);
      const o = outcome(e.record);
      if (fp == null || o == null) return;
      const slot = fp ? fs.first : fs.second;
      slot.games++; if (o) slot.wins++;
    });
    const firstSecond = {
      first: { games: fs.first.games, wins: fs.first.wins, winrate: winrate(fs.first.wins, fs.first.games) },
      second: { games: fs.second.games, wins: fs.second.wins, winrate: winrate(fs.second.wins, fs.second.games) }
    };

    // Tendance : winrate cumulé au fil des parties décidées (ordre chrono).
    const trend = [];
    let cw = 0, cd = 0;
    kept.forEach(e => {
      const o = outcome(e.record);
      if (o == null) return;
      cd++; if (o) cw++;
      trend.push({ date: dateOf(e.record), winrate: Math.round(cw / cd * 100), n: cd });
    });

    // Performance des cartes agrégée (endStats.me.cards sommé sur toutes les parties)
    const cardMap = {};
    const num = v => Number(v) || 0;   // défensif : d'anciennes parties peuvent avoir des compteurs en string
    kept.forEach(e => {
      const cards = (e.record.endStats && e.record.endStats.me && e.record.endStats.me.cards) || [];
      const o = outcome(e.record);
      const seenThisGame = new Set();  // une carte ne compte qu'une fois par partie
      cards.forEach(c => {
        const key = norm(c.name);
        const agg = cardMap[key] || (cardMap[key] = { name: c.name, played: 0, blocked: 0, pitched: 0, discarded: 0, timesHit: 0, games: 0, gamesWon: 0, gamesLost: 0 });
        agg.played += num(c.played); agg.blocked += num(c.blocked); agg.pitched += num(c.pitched);
        agg.discarded += num(c.discarded); agg.timesHit += num(c.timesHit);
        if (!seenThisGame.has(key)) {
          agg.games++;
          if (o === true) agg.gamesWon++; else if (o === false) agg.gamesLost++;
          seenThisGame.add(key);
        }
      });
    });
    const cardPerf = Object.values(cardMap).sort((a, b) => b.played - a.played);

    // Cartes en victoire vs défaite : pour chaque carte présente dans au moins
    // une partie décidée, winrate quand elle est jouée. Trié par winrate (les
    // « cartes qui gagnent » en tête), avec un seuil dynamique de parties
    // décidées pour limiter le bruit statistique.
    const cwlAll = cardPerf.map(c => {
      const dec = c.gamesWon + c.gamesLost;
      return { name: c.name, gamesWon: c.gamesWon, gamesLost: c.gamesLost, decided: dec, winrate: winrate(c.gamesWon, dec) };
    }).filter(c => c.decided > 0);
    const cwlMin = cwlAll.some(c => c.decided >= 3) ? 3 : (cwlAll.some(c => c.decided >= 2) ? 2 : 1);
    const cardWinLoss = cwlAll.filter(c => c.decided >= cwlMin)
      .sort((a, b) => b.winrate - a.winrate || b.decided - a.decided || a.name.localeCompare(b.name));

    // Moyennes offensives : moyenne des moyennes/totaux Talishar sur les
    // parties qui ont un bloc de stats officielles.
    const offRecs = kept.map(e => e.record.endStats && e.record.endStats.me).filter(Boolean);
    const avgOf = (arr, pick) => {
      const vals = arr.map(pick).map(Number).filter(v => isFinite(v));
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const round1 = v => v == null ? null : Math.round(v * 10) / 10;
    const offAverages = offRecs.length ? {
      games: offRecs.length,
      dealtPerTurn: round1(avgOf(offRecs, o => o.averages && o.averages.dealtPerTurn)),
      threatenedPerTurn: round1(avgOf(offRecs, o => o.averages && o.averages.threatenedPerTurn)),
      threatenedPerCard: round1(avgOf(offRecs, o => o.averages && o.averages.threatenedPerCard)),
      value: round1(avgOf(offRecs, o => o.averages && o.averages.value)),
      dealt: round1(avgOf(offRecs, o => o.totals && o.totals.dealt)),
      threatened: round1(avgOf(offRecs, o => o.totals && o.totals.threatened)),
      blocked: round1(avgOf(offRecs, o => o.totals && o.totals.blocked))
    } : null;

    return {
      filters: f,
      facets: { formats: Array.from(formats).sort(), myHeroes: Array.from(myHeroes).sort(), oppHeroes: Array.from(oppHeroes).sort() },
      kept,                                   // ordre chrono (ancien → récent)
      global: { games: kept.length, decided, wins, losses: decided - wins, winrate: winrate(wins, decided) },
      byMatchup, byMyHero, firstSecond, bestMatchups, worstMatchups, cardWinLoss, cwlMin, trend, cardPerf, offAverages
    };
  }

  // ============================================================
  // RENDU (navigateur uniquement) — tableau de bord héros-centré.
  // Tout le DOM est construit dans #dashboardBody ; le CSS est scopé
  // sous #dashboardBody pour ne jamais entrer en collision avec le
  // reste de l'app (replay, header…).
  // ============================================================
  let _entries = [], _onOpen = null, _onDelete = null, _built = false, _A = null, _L = null, _trendGeom = null;
  const DEFAULT_ACCENT = '#c9a227';
  const state = {
    hero: null, format: '', opp: '', period: 'all', includeAI: false,
    tab: 'stats', sub: 'overview', histView: 'detailed', res: 'all', q: '',
    cardQ: '', cardMode: 'total', cardCap: 20, cardSort: { key: 'played', dir: 'desc' }
  };
  const CARD_COLS = [
    { key: 'name', label: 'Carte' },
    { key: 'games', label: 'Parties', count: true },
    { key: 'played', label: 'Jouée' },
    { key: 'blocked', label: 'Défense', tip: 'Fois utilisée pour bloquer' },
    { key: 'pitched', label: 'Pitch' },
    { key: 'timesHit', label: 'Coups', hit: true, tip: 'Coups portés (attaque non bloquée)' }
  ];
  const MUTED = '<span class="muted">·</span>';

  const D = (typeof document !== 'undefined') ? document : null;
  const esc2 = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wrCls = w => w == null ? '' : (w >= 55 ? 'good' : (w <= 45 ? 'bad' : 'mid'));
  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; }
  function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255); }
  function avBg(color) { return 'radial-gradient(circle at 50% 22%,' + hexA(color, .95) + ',' + hexA(color, .3) + ' 68%,rgba(8,10,16,.95))'; }
  const heroColor = name => (root.CardImages && root.CardImages.heroColorSync) ? root.CardImages.heroColorSync(name) : '#7a7f96';
  const fmtDate = d => { const t = new Date(d); return isNaN(t) ? '?' : t.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }); };
  const fmtDay = d => { const t = new Date(d); return isNaN(t) ? '?' : t.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); };
  const turnsOf = rec => (rec.turns && rec.turns.length) || 0;

  // Avatars : dégradé coloré (repli) + illustration réelle chargée en fond (async).
  function avatarHTML(name, cls) {
    const c = heroColor(name);
    return '<div class="' + cls + '" data-hero-bg="' + esc2(name) + '" style="background-image:' + avBg(c) + '"><span class="mono">' + esc2((name || '?').charAt(0)) + '</span></div>';
  }
  function hydrateBg(scope) {
    if (!root.CardImages) return;
    (scope || D).querySelectorAll('[data-hero-bg]').forEach(el => {
      const h = el.getAttribute('data-hero-bg');
      if (!h || h === '(inconnu)' || el._hy) return;
      el._hy = 1;
      root.CardImages.resolveCardImage(h).then(url => { if (url) { el.style.backgroundImage = 'url("' + url + '")'; el.classList.add('has-img'); } });
    });
  }

  // ---------- Theming ----------
  function applyAccent(color) {
    const s = D.documentElement.style;
    s.setProperty('--accent', color); s.setProperty('--accent-rgb', hexRgb(color)); s.setProperty('--accent-dim', color);
  }
  function themeHero() {
    if (!state.hero) { applyAccent(DEFAULT_ACCENT); return; }
    applyAccent(heroColor(state.hero));                 // couleur déterministe instantanée
    if (root.CardImages && root.CardImages.resolveHeroColor) {
      const target = state.hero;
      root.CardImages.resolveHeroColor(target).then(col => { if (col && state.hero === target) { applyAccent(col); renderTrend(); } });
    }
  }

  // ---------- Agrégations ----------
  function statsAgg() { return aggregate(_entries, { includeAI: state.includeAI, format: state.format || null, myHero: state.hero || null, oppHero: state.opp || null, period: state.period }); }
  function lifeAgg() { return aggregate(_entries, { includeAI: state.includeAI }); }

  // ---------- Squelette ----------
  function buildSkeleton(host) {
    host.innerHTML =
      '<div class="hxwrap">' +
      '<div class="caro-head"><span class="lbl">Choisis ton héros</span><span class="cur" id="hxCur">Tous les héros</span></div>' +
      '<div class="caro" id="hxCaro"></div>' +
      '<div class="filters-row">' +
        '<span class="fchip"><select id="hxFormat"></select></span>' +
        '<span class="fchip"><select id="hxOpp"></select></span>' +
        '<div class="pseg" id="hxPeriod">' +
          '<button data-p="all" aria-pressed="true">Tout</button>' +
          '<button data-p="30d" aria-pressed="false">30 j</button>' +
          '<button data-p="90d" aria-pressed="false">90 j</button></div>' +
        '<button class="fai" id="hxAI" aria-pressed="false" title="Par défaut, les parties contre l\'IA sont exclues des stats.">🤖 IA exclue</button>' +
        '<button class="freset" id="hxReset" hidden>↺ Réinitialiser</button>' +
      '</div>' +
      '<div class="tabs" id="hxTabs">' +
        '<button data-tab="stats" aria-pressed="true">📊 Statistiques</button>' +
        '<button data-tab="hist" aria-pressed="false">🗒 Historique <span id="hxHistCount" class="dcount"></span></button>' +
      '</div>' +
      '<section class="panel active" id="hxPanelStats">' +
        '<div class="substat" id="hxSubstat">' +
          '<button data-sub="overview" aria-pressed="true">Vue d\'ensemble</button>' +
          '<button data-sub="matchups" aria-pressed="false">Matchups</button>' +
          '<button data-sub="cards" aria-pressed="false">Cartes</button></div>' +
        '<div class="subpanel active" id="hxSubOverview">' +
          '<div class="idcard"><div id="hxIdBody"></div><div class="kpis" id="hxKpis"></div></div>' +
          '<div class="card trendcard"><h2>Tendance du winrate</h2><div class="cbody">' +
            '<div class="trend-holder" id="hxTrendHolder">' +
              '<svg class="trend-svg" id="hxTrendSvg" viewBox="0 0 400 150" preserveAspectRatio="none"></svg>' +
              '<div class="trend-guide" id="hxTrendGuide"></div>' +
              '<div class="trend-dot" id="hxTrendDot"></div>' +
              '<div class="trend-tip" id="hxTrendTip"></div>' +
            '</div>' +
            '<div class="trend-leg" id="hxTrendLeg"></div></div></div>' +
        '</div>' +
        '<div class="subpanel" id="hxSubMatchups">' +
          '<div class="card"><h2>Winrate par matchup <span class="scope" id="hxMuScope"></span></h2><div class="cbody" id="hxMuBody"></div></div></div>' +
        '<div class="subpanel" id="hxSubCards">' +
          '<div class="card"><h2>Cartes en victoire vs défaite <span class="scope" id="hxCwlScope"></span></h2><div class="cbody" id="hxCwlBody"></div></div>' +
          '<div class="card"><h2>Performance des cartes</h2><div class="cbody">' +
            '<div class="cards-controls">' +
              '<input class="search" id="hxCardSearch" type="search" placeholder="Filtrer une carte…">' +
              '<span class="fchip"><select id="hxCardMode"><option value="total">Total</option><option value="pergame">Par partie</option><option value="pct">%</option></select></span>' +
              '<span class="fchip"><select id="hxCardCap"><option value="20">Top 20</option><option value="50">Top 50</option><option value="100">Top 100</option><option value="0">Tout</option></select></span>' +
              '<span class="cards-count" id="hxCardCount"></span></div>' +
            '<div class="tbl-scroll" id="hxCardTbl"></div></div></div>' +
        '</div>' +
      '</section>' +
      '<section class="panel" id="hxPanelHist">' +
        '<div class="controls">' +
          '<input class="search" id="hxSearch" type="search" placeholder="Rechercher (adversaire, format…)">' +
          '<div class="seg" id="hxHistView">' +
            '<button data-hv="detailed" aria-pressed="true">Détaillé</button>' +
            '<button data-hv="compact" aria-pressed="false">Compact</button></div>' +
        '</div>' +
        '<div class="resfilter" id="hxRes">' +
          '<button class="chip" data-res="all" aria-pressed="true">Toutes</button>' +
          '<button class="chip win" data-res="win" aria-pressed="false">Victoires</button>' +
          '<button class="chip loss" data-res="loss" aria-pressed="false">Défaites</button></div>' +
        '<div class="listmeta" id="hxMeta"></div>' +
        '<div id="hxList" class="grouped"></div>' +
      '</section>' +
      '</div>';
  }
  function ensureToast() { if (!D.getElementById('hxToast')) { const t = D.createElement('div'); t.id = 'hxToast'; t.className = 'hx-toast'; D.body.appendChild(t); } }
  let _toastT = null;
  function toast(msg) { const t = D.getElementById('hxToast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(_toastT); _toastT = setTimeout(() => t.classList.remove('show'), 1600); }

  // ---------- Carrousel ----------
  function hcardHTML(o) {
    const wr = o.wr == null ? 0 : o.wr, wl = o.wins + '–' + o.losses;
    let frame;
    if (o.all) {
      frame = '<div class="frame all"><span class="mono">Σ</span>';
    } else {
      frame = '<div class="frame" data-hero-bg="' + esc2(o.name) + '" style="background-image:' + avBg(heroColor(o.name)) + '"><span class="mono">' + esc2(o.name.charAt(0)) + '</span>';
    }
    frame += '<div class="rec"><div class="wr ' + wrCls(o.wr) + '">' + (o.wr == null ? '—' : wr + '%') + '</div><div class="wl">' + wl + '</div></div></div>';
    return '<button class="hcard' + (o.all ? ' isall' : '') + '" data-key="' + esc2(o.key) + '" aria-pressed="' + o.sel + '">' + frame + '<div class="name">' + esc2(o.name) + '</div></button>';
  }
  function renderCarousel() {
    const rows = _L.byMyHero.filter(m => m.hero !== '(inconnu)' && m.games > 0).sort((a, b) => b.games - a.games);
    const g = _L.global;
    let html = hcardHTML({ all: true, name: 'Tous', wins: g.wins, losses: g.losses, wr: g.winrate, sel: !state.hero, key: '__all__' });
    rows.forEach(m => html += hcardHTML({ all: false, name: m.hero, wins: m.wins, losses: m.losses, wr: m.winrate, sel: state.hero === m.hero, key: m.hero }));
    const host = D.getElementById('hxCaro'); host.innerHTML = html; hydrateBg(host);
    D.getElementById('hxCur').textContent = state.hero || 'Tous les héros';
  }

  // ---------- Vue d'ensemble : identité + KPIs ----------
  function renderId() {
    const g = _A.global, ongoing = g.games - g.decided;
    const t = _A.trend, half = Math.floor(t.length / 2);
    const early = half ? t[half - 1].winrate : null, late = t.length ? t[t.length - 1].winrate : null;
    let trend = '<span class="trend flat">— stable</span>';
    if (early != null && late != null && Math.abs(late - early) >= 6) trend = late > early ? '<span class="trend up">▲ en progrès</span>' : '<span class="trend down">▼ en baisse</span>';
    const hero = state.hero;
    const full = hero || 'Toutes les parties';
    const sub = hero ? '' : (_L.byMyHero.filter(m => m.hero !== '(inconnu)').length + ' héros joués');
    const avatar = hero
      ? '<div class="idavatar" data-hero-bg="' + esc2(hero) + '" style="background-image:' + avBg(heroColor(hero)) + '"><span class="mono">' + esc2(hero.charAt(0)) + '</span></div>'
      : '<div class="idavatar isall"><span class="mono">Σ</span></div>';
    const wm = '<div class="idwm">' + esc2(hero ? hero.charAt(0) : 'Σ') + '</div>';
    D.getElementById('hxIdBody').innerHTML =
      '<div class="idtop">' + wm + avatar +
        '<div class="idmeta"><div class="iname">' + esc2(full) + '</div>' + (sub ? '<div class="icls">' + esc2(sub) + '</div>' : '<div class="icls">deck</div>') +
        '<div class="irec"><b class="green">' + g.wins + 'V</b> · <b class="red">' + g.losses + 'D</b> · ' + g.games + ' parties' + (ongoing ? ' · ' + ongoing + ' en cours' : '') + '</div></div>' +
        '<div class="idwr"><div class="big ' + (g.winrate >= 50 ? 'good' : 'bad') + '">' + (g.winrate == null ? '—' : g.winrate + '%') + '</div><div class="cap">winrate</div>' + trend + '</div></div>';
    hydrateBg(D.getElementById('hxIdBody'));

    const fs = _A.firstSecond;
    let streak = 0, sign = null;
    for (let i = _A.kept.length - 1; i >= 0; i--) { const o = outcome(_A.kept[i].record); if (o == null) continue; if (sign === null) { sign = o; streak = 1; } else if (o === sign) streak++; else break; }
    let ts = 0, tc = 0; _A.kept.forEach(e => { const n = turnsOf(e.record); if (n) { ts += n; tc++; } });
    const avgT = tc ? Math.round(ts / tc) : '—';
    const kpi = (v, cls, k, sub) => '<div class="kpi"><div class="v ' + (cls || '') + '">' + v + '</div><div class="k">' + k + '</div>' + (sub ? '<div class="ksub">' + sub + '</div>' : '') + '</div>';
    const cnt = s => s.games ? s.wins + '/' + s.games : '';
    D.getElementById('hxKpis').innerHTML =
      kpi(fs.first.winrate == null ? '—' : fs.first.winrate + '<small>%</small>', 'violet', 'Winrate premier', cnt(fs.first)) +
      kpi(fs.second.winrate == null ? '—' : fs.second.winrate + '<small>%</small>', 'violet', 'Winrate second', cnt(fs.second)) +
      kpi(g.decided ? streak + (sign ? ' V' : ' D') : '—', sign ? 'green' : 'red', 'Série en cours') +
      kpi(avgT + (tc ? '<small> t</small>' : ''), '', 'Durée moyenne');
  }

  // ---------- Tendance ----------
  function renderTrend() {
    const raw = _A ? _A.trend : [], pts = raw.map(p => p.winrate);
    const svg = D.getElementById('hxTrendSvg'), leg = D.getElementById('hxTrendLeg'), dot = D.getElementById('hxTrendDot');
    if (!svg) return;
    _trendGeom = null; if (dot) dot.style.display = 'none';
    if (pts.length < 3) { svg.innerHTML = ''; if (leg) leg.textContent = 'Trop peu de parties décidées pour une tendance fiable (' + pts.length + ').'; return; }
    const W = 400, H = 150, padL = 26, padR = 8, padT = 10, padB = 14, plotW = W - padL - padR, plotH = H - padT - padB;
    const x = i => padL + i / (pts.length - 1) * plotW, y = v => padT + plotH - (v / 100) * plotH;
    const line = pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const area = line + ' L' + x(pts.length - 1).toFixed(1) + ',' + (padT + plotH) + ' L' + padL + ',' + (padT + plotH) + ' Z';
    const grid = [0, 50, 100].map(v => '<line x1="' + padL + '" y1="' + y(v).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(v).toFixed(1) + '" stroke="#262c3d"/><text x="' + (padL - 4) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end" font-size="8.5" fill="#565b6e">' + v + '</text>').join('');
    // Couleur d'accent courante (réelle si posée sur :root, sinon table du héros).
    const acc = (D.documentElement.style.getPropertyValue('--accent') || '').trim();
    const col = acc[0] === '#' ? acc : (state.hero ? heroColor(state.hero) : DEFAULT_ACCENT);
    // vector-effect : le trait garde une épaisseur constante malgré l'étirement horizontal (fini l'aspect « tassé »).
    svg.innerHTML = grid + '<line x1="' + padL + '" y1="' + y(50).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(50).toFixed(1) + '" stroke="rgba(139,107,255,.4)" stroke-dasharray="3,4"/>' +
      '<path d="' + area + '" fill="' + hexA(col, .16) + '" stroke="none"/>' +
      '<path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="2" vector-effect="non-scaling-stroke"/>';
    // Géométrie pour l'overlay HTML (point + survol) — coordonnées en % (x) et px (y, hauteur = 150).
    _trendGeom = { pts: pts.map((v, i) => ({ leftPct: x(i) / W * 100, topPx: y(v), wr: Math.round(v), n: raw[i].n })), col };
    if (dot) { const l = _trendGeom.pts[_trendGeom.pts.length - 1]; dot.style.display = 'block'; dot.style.left = l.leftPct + '%'; dot.style.top = l.topPx + 'px'; dot.style.background = col; }
    if (leg) leg.textContent = 'Winrate cumulé sur ' + pts.length + ' parties (ancien → récent) · actuel ' + Math.round(pts[pts.length - 1]) + '%';
  }
  // Survol du graphe de tendance : point + repère + infobulle (overlay HTML, non déformé).
  function trendHover(clientX) {
    if (!_trendGeom) return;
    const holder = D.getElementById('hxTrendHolder'); if (!holder) return;
    const rect = holder.getBoundingClientRect(); if (!rect.width) return;
    const relPct = (clientX - rect.left) / rect.width * 100;
    let best = _trendGeom.pts[0], bd = 1e9;
    for (const p of _trendGeom.pts) { const d = Math.abs(p.leftPct - relPct); if (d < bd) { bd = d; best = p; } }
    const dot = D.getElementById('hxTrendDot'), guide = D.getElementById('hxTrendGuide'), tip = D.getElementById('hxTrendTip');
    dot.style.display = 'block'; dot.style.left = best.leftPct + '%'; dot.style.top = best.topPx + 'px'; dot.style.background = _trendGeom.col;
    guide.style.left = best.leftPct + '%'; guide.classList.add('show');
    tip.style.left = best.leftPct + '%'; tip.style.top = best.topPx + 'px';
    tip.innerHTML = '<b>' + best.wr + '%</b> · partie ' + best.n; tip.classList.add('show');
    tip.classList.toggle('flipL', best.leftPct > 78);
  }
  function trendLeave() {
    if (!_trendGeom) return;
    const dot = D.getElementById('hxTrendDot'), l = _trendGeom.pts[_trendGeom.pts.length - 1];
    if (l) { dot.style.left = l.leftPct + '%'; dot.style.top = l.topPx + 'px'; }
    D.getElementById('hxTrendGuide').classList.remove('show');
    D.getElementById('hxTrendTip').classList.remove('show');
  }

  // ---------- Matchups (best/worst + liste triée) ----------
  function renderMatchups() {
    const rows = _A.byMatchup.filter(m => m.hero !== '(inconnu)' && m.winrate != null).sort((a, b) => (b.winrate - a.winrate) || (b.decided - a.decided));
    D.getElementById('hxMuScope').textContent = state.hero ? ('· en ' + state.hero) : '· tous héros';
    const host = D.getElementById('hxMuBody');
    if (!rows.length) { host.innerHTML = '<div class="empty">Aucun matchup.</div>'; return; }
    const best = (_A.bestMatchups || [])[0], worst = (_A.worstMatchups || [])[0];
    const hl = (r, kind) => '<div class="hl ' + kind + '">' + avatarHTML(r.hero, 'mu-av') +
      '<div class="info"><div class="htag">' + (kind === 'best' ? '✅ Meilleur' : '⚠️ Pire') + '</div><div class="hnm">' + esc2(r.hero) + '</div></div>' +
      '<div class="hrt"><div class="hpc">' + r.winrate + '%</div><div class="hvl">' + r.wins + '/' + r.decided + '</div></div></div>';
    const highlight = (best && worst && best.hero !== worst.hero) ? '<div class="muhl">' + hl(best, 'best') + hl(worst, 'worst') + '</div>' : '';
    host.innerHTML = highlight + rows.map(r =>
      '<div class="mu-row' + (r.decided < 2 ? ' mu-low' : '') + '">' + avatarHTML(r.hero, 'mu-av') +
      '<div class="mu-nm">' + esc2(r.hero) + '</div><div class="mu-track"><div class="fill" style="width:' + r.winrate + '%"></div><div class="mid"></div></div>' +
      '<div class="mu-pc ' + wrCls(r.winrate) + '">' + r.winrate + '%</div><div class="mu-vl">' + r.wins + '/' + r.decided + '</div></div>').join('');
    hydrateBg(host);
  }

  // ---------- Cartes ----------
  function renderCardsWL() {
    D.getElementById('hxCwlScope').textContent = state.hero ? ('· en ' + state.hero) : '· tous héros';
    const list = (_A.cardWinLoss || []).slice();
    const host = D.getElementById('hxCwlBody');
    if (!list.length) { host.innerHTML = '<div class="empty">Pas assez de données de cartes (nécessite les stats officielles Talishar).</div>'; return; }
    const top = list.slice(0, 6), bottom = list.slice(-4).filter(c => top.indexOf(c) < 0), show = top.concat(bottom);
    host.innerHTML = show.map(c => {
      const d = c.winrate - 50, pos = d >= 0, segW = Math.min(50, Math.abs(d) / 50 * 50);
      return '<div class="dv"><div class="dv-nm">' + esc2(c.name) + '</div>' +
        '<div class="dv-track"><div class="mid"></div><div class="dv-seg ' + (pos ? 'pos' : 'neg') + '" style="width:' + segW + '%"></div></div>' +
        '<div class="dv-pc ' + (pos ? 'good' : 'bad') + '">' + c.winrate + '%</div><div class="dv-vl">' + c.gamesWon + 'V·' + c.gamesLost + 'D</div></div>';
    }).join('') + '<div class="note">Winrate des parties où la carte a été jouée (min. ' + _A.cwlMin + ' partie' + (_A.cwlMin > 1 ? 's' : '') + '). À lire avec prudence sur de faibles échantillons.</div>';
  }
  const pct1 = v => Math.round(v * 10) / 10 + '%';
  function fmtCell(col, c) {
    const raw = c[col.key] || 0;
    if (col.count || state.cardMode === 'total') return raw ? String(raw) : MUTED;
    if (state.cardMode === 'pergame') { const tg = _A.global.games || 0, v = tg ? raw / tg : 0; return v ? String(Math.round(v * 100) / 100) : MUTED; }
    if (col.key === 'timesHit') { const p = c.played || 0; return (p && raw) ? pct1(raw / p * 100) : MUTED; }
    const usage = (c.played || 0) + (c.blocked || 0) + (c.pitched || 0);
    return (usage && raw) ? pct1(raw / usage * 100) : MUTED;
  }
  function renderCardPerf() {
    const total = (_A.cardPerf || []).filter(c => c.played || c.blocked || c.timesHit);
    const qn = norm(state.cardQ);
    const filtered = qn ? total.filter(c => norm(c.name).indexOf(qn) >= 0) : total;
    const sorted = filtered.slice().sort((a, b) => state.cardSort.key === 'name' ? String(a.name).localeCompare(String(b.name)) : (a[state.cardSort.key] || 0) - (b[state.cardSort.key] || 0));
    if (state.cardSort.dir === 'desc') sorted.reverse();
    const shown = state.cardCap > 0 ? sorted.slice(0, state.cardCap) : sorted;
    const cntEl = D.getElementById('hxCardCount');
    if (cntEl) cntEl.textContent = filtered.length === total.length ? total.length + ' cartes' : filtered.length + ' / ' + total.length + ' cartes';
    const host = D.getElementById('hxCardTbl');
    if (!total.length) { host.innerHTML = '<div class="empty">Aucune stat de carte agrégée (nécessite les stats officielles Talishar).</div>'; return; }
    if (!shown.length) { host.innerHTML = '<div class="empty">Aucune carte ne correspond.</div>'; return; }
    const head = CARD_COLS.map(col => {
      const arrow = state.cardSort.key === col.key ? (state.cardSort.dir === 'desc' ? ' ▼' : ' ▲') : '';
      return '<th class="sortable" data-key="' + col.key + '"' + (col.tip ? ' title="' + esc2(col.tip) + '"' : '') + '>' + esc2(col.label) + arrow + '</th>';
    }).join('');
    const body = shown.map(c => '<tr>' + CARD_COLS.map(col => col.key === 'name' ? '<td>' + esc2(c.name) + '</td>' : '<td' + (col.hit && c.timesHit ? ' class="hit"' : '') + '>' + fmtCell(col, c) + '</td>').join('') + '</tr>').join('');
    const note = state.cardMode === 'pct' ? '<div class="note">Par ligne : <b>Jouée + Défense + Pitch ≈ 100 %</b> (à quoi sert la carte). <b>Coups</b> = taux de coups portés (touché ÷ jouée).</div>' : '';
    host.innerHTML = '<table class="tbl"><tr>' + head + '</tr>' + body + '</table>' + note;
  }

  // ---------- Historique ----------
  function verdictCls(o) { return o == null ? 'pending' : (o ? 'win' : 'loss'); }
  function verdictLbl(o) { return o == null ? 'En cours' : (o ? 'Victoire' : 'Défaite'); }
  function gcardHTML(e) {
    const rec = e.record, me = myHeroOf(rec) || '?', op = oppHeroOf(rec) || '?', o = outcome(rec), cls = verdictCls(o);
    const sub = [rec.format, fmtDate(dateOf(rec)), turnsOf(rec) + ' t', firstPlayerOf(rec) === false ? '2e' : (firstPlayerOf(rec) ? 'init.' : null)].filter(Boolean).concat(isVsAI(rec) ? ['🤖'] : []).join(' · ');
    return '<div class="gcard ' + cls + '" data-id="' + esc2(e.gameId) + '"><div class="duo">' + avatarHTML(me, 'mini') + avatarHTML(op, 'mini opp') + '</div>' +
      '<div class="body"><div class="mu"><span class="me">' + esc2(me) + '</span><span class="vs">vs</span><span>' + esc2(op) + '</span></div>' +
      '<div class="gsub">' + esc2(sub) + '</div></div><div class="verdict ' + cls + '">' + verdictLbl(o) + '</div>' +
      '<button class="gdel" data-del="' + esc2(e.gameId) + '" title="Supprimer cette partie" aria-label="Supprimer">✕</button></div>';
  }
  function crowHTML(e) {
    const rec = e.record, me = myHeroOf(rec) || '?', op = oppHeroOf(rec) || '?', o = outcome(rec), cls = verdictCls(o);
    return '<div class="crow ' + cls + '" data-id="' + esc2(e.gameId) + '"><span class="cdot"></span>' +
      '<span class="cmatch"><b>' + esc2(me) + '</b><span class="vs">vs</span>' + esc2(op) + '</span>' +
      '<span class="cmeta">' + fmtDate(dateOf(rec)) + ' · ' + turnsOf(rec) + 't</span>' +
      '<span class="cv">' + (o == null ? '·' : (o ? 'V' : 'D')) + '</span>' +
      '<button class="gdel" data-del="' + esc2(e.gameId) + '" title="Supprimer cette partie" aria-label="Supprimer">✕</button></div>';
  }
  function histList() {
    const qn = norm(state.q);
    return _A.kept.slice().sort((a, b) => (Date.parse(dateOf(b.record) || '') || 0) - (Date.parse(dateOf(a.record) || '') || 0)).filter(e => {
      const o = outcome(e.record);
      if (state.res === 'win' && o !== true) return false;
      if (state.res === 'loss' && o !== false) return false;
      if (qn) { const hay = norm([myHeroOf(e.record), oppHeroOf(e.record), e.record.format].filter(Boolean).join(' ')); if (hay.indexOf(qn) < 0) return false; }
      return true;
    });
  }
  function renderHistory() {
    const list = D.getElementById('hxList'), gs = histList();
    list.className = state.histView === 'compact' ? 'compact' : 'grouped';
    const w = gs.filter(e => outcome(e.record) === true).length, l = gs.filter(e => outcome(e.record) === false).length, ong = gs.filter(e => outcome(e.record) == null).length;
    D.getElementById('hxMeta').textContent = gs.length + ' partie' + (gs.length > 1 ? 's' : '') + (gs.length ? '  ·  ' + w + 'V / ' + l + 'D' + (ong ? ' · ' + ong + ' en cours' : '') : '');
    const hc = D.getElementById('hxHistCount'); if (hc) hc.textContent = '(' + _A.kept.length + ')';
    if (!gs.length) { list.innerHTML = '<div class="empty">Aucune partie ne correspond.</div>'; return; }
    if (state.histView === 'compact') {
      list.innerHTML = gs.map(crowHTML).join('');
    } else {
      const grp = {}, order = [];
      gs.forEach(e => { const k = new Date(dateOf(e.record)).toDateString(); if (!grp[k]) { grp[k] = []; order.push(k); } grp[k].push(e); });
      list.innerHTML = order.map(k => { const a = grp[k], ww = a.filter(e => outcome(e.record) === true).length, ll = a.filter(e => outcome(e.record) === false).length;
        return '<div class="daygroup"><div class="dayhead"><span>' + esc2(fmtDay(dateOf(a[0].record))) + '</span><span>' + ww + 'V · ' + ll + 'D</span></div>' + a.map(gcardHTML).join('') + '</div>'; }).join('');
    }
    hydrateBg(list);
  }

  // ---------- Facettes / synchro contrôles ----------
  function updateOppFacets() {
    const sel = D.getElementById('hxOpp'); if (!sel) return;
    const set = new Set();
    _entries.forEach(e => { if ((!state.hero || myHeroOf(e.record) === state.hero) && (state.includeAI || !isVsAI(e.record))) { const o = oppHeroOf(e.record); if (o) set.add(o); } });
    const opps = Array.from(set).sort();
    if (state.opp && opps.indexOf(state.opp) < 0) state.opp = '';
    sel.innerHTML = '<option value="">Tous adversaires</option>' + opps.map(o => '<option value="' + esc2(o) + '">' + esc2(o) + '</option>').join('');
    sel.value = state.opp;
  }
  function updateFormatFacets() {
    const sel = D.getElementById('hxFormat'); if (!sel) return;
    const fmts = _L.facets.formats;
    sel.innerHTML = '<option value="">Tous formats</option>' + fmts.map(f => '<option value="' + esc2(f) + '">' + esc2(f) + '</option>').join('');
    sel.value = state.format;
  }
  function syncFilters() {
    const ff = D.getElementById('hxFormat'); if (ff) { ff.value = state.format; ff.parentElement.classList.toggle('active', !!state.format); }
    const fo = D.getElementById('hxOpp'); if (fo) fo.parentElement.classList.toggle('active', !!state.opp);
    D.getElementById('hxPeriod').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x.dataset.p === state.period));
    const ai = D.getElementById('hxAI'); if (ai) { ai.setAttribute('aria-pressed', state.includeAI); ai.textContent = '🤖 IA ' + (state.includeAI ? 'incluse' : 'exclue'); }
    const active = !!state.format || !!state.opp || state.period !== 'all' || state.includeAI;
    const r = D.getElementById('hxReset'); if (r) r.hidden = !active;
  }

  // ---------- Orchestration ----------
  function renderStats() { renderId(); renderTrend(); renderMatchups(); renderCardsWL(); renderCardPerf(); }
  function renderAll() {
    _L = lifeAgg();
    const heroes = _L.byMyHero.filter(m => m.hero !== '(inconnu)' && m.games > 0).map(m => m.hero);
    if (state.hero && heroes.indexOf(state.hero) < 0) state.hero = null;
    _A = statsAgg();
    themeHero(); updateFormatFacets(); updateOppFacets(); syncFilters();
    renderCarousel(); renderStats(); renderHistory();
  }

  // ---------- Câblage (une seule fois) ----------
  function wire(host) {
    host.querySelector('#hxTabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      state.tab = b.dataset.tab; host.querySelector('#hxTabs').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
      host.querySelector('#hxPanelStats').classList.toggle('active', state.tab === 'stats');
      host.querySelector('#hxPanelHist').classList.toggle('active', state.tab === 'hist'); window.scrollTo(0, 0);
    }));
    host.querySelector('#hxSubstat').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      state.sub = b.dataset.sub; host.querySelector('#hxSubstat').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
      host.querySelector('#hxSubOverview').classList.toggle('active', state.sub === 'overview');
      host.querySelector('#hxSubMatchups').classList.toggle('active', state.sub === 'matchups');
      host.querySelector('#hxSubCards').classList.toggle('active', state.sub === 'cards');
    }));
    host.querySelector('#hxCaro').addEventListener('click', e => {
      const c = e.target.closest('.hcard'); if (!c) return;
      const k = c.dataset.key; state.hero = (k === '__all__') ? null : (state.hero === k ? null : k);
      state.res = 'all'; renderAll();
    });
    host.querySelector('#hxFormat').addEventListener('change', e => { state.format = e.target.value; syncFilters(); _A = statsAgg(); renderStats(); renderHistory(); });
    host.querySelector('#hxOpp').addEventListener('change', e => { state.opp = e.target.value; syncFilters(); _A = statsAgg(); renderStats(); renderHistory(); });
    host.querySelector('#hxPeriod').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.period = b.dataset.p; syncFilters(); _A = statsAgg(); renderStats(); renderHistory(); }));
    host.querySelector('#hxAI').addEventListener('click', () => { state.includeAI = !state.includeAI; renderAll(); });
    host.querySelector('#hxReset').addEventListener('click', () => { state.format = ''; state.opp = ''; state.period = 'all'; state.includeAI = false; renderAll(); });
    host.querySelector('#hxCardSearch').addEventListener('input', e => { state.cardQ = e.target.value; renderCardPerf(); });
    host.querySelector('#hxCardMode').addEventListener('change', e => { state.cardMode = e.target.value; renderCardPerf(); });
    host.querySelector('#hxCardCap').addEventListener('change', e => { state.cardCap = Number(e.target.value) || 0; renderCardPerf(); });
    host.querySelector('#hxCardTbl').addEventListener('click', e => {
      const th = e.target.closest('th.sortable'); if (!th) return; const k = th.dataset.key;
      if (state.cardSort.key === k) state.cardSort.dir = state.cardSort.dir === 'desc' ? 'asc' : 'desc';
      else { state.cardSort.key = k; state.cardSort.dir = k === 'name' ? 'asc' : 'desc'; }
      renderCardPerf();
    });
    const th = host.querySelector('#hxTrendHolder');
    if (th) {
      th.addEventListener('mousemove', e => trendHover(e.clientX));
      th.addEventListener('mouseleave', trendLeave);
      th.addEventListener('touchstart', e => { if (e.touches[0]) trendHover(e.touches[0].clientX); }, { passive: true });
      th.addEventListener('touchmove', e => { if (e.touches[0]) trendHover(e.touches[0].clientX); }, { passive: true });
      th.addEventListener('touchend', trendLeave);
    }
    host.querySelector('#hxHistView').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.histView = b.dataset.hv; host.querySelector('#hxHistView').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderHistory(); }));
    host.querySelector('#hxRes').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.res = b.dataset.res; host.querySelector('#hxRes').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderHistory(); }));
    host.querySelector('#hxSearch').addEventListener('input', e => { state.q = e.target.value; renderHistory(); });
    host.querySelector('#hxList').addEventListener('click', e => {
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); if (_onDelete) _onDelete(del.dataset.del); return; }
      const item = e.target.closest('[data-id]');
      if (item) { const en = _entries.find(x => String(x.gameId) === item.dataset.id); if (en && _onOpen) _onOpen(en); }
    });
  }

  function mount(opts) {
    _entries = (opts && opts.entries) || [];
    _onOpen = (opts && opts.onOpen) || null;
    _onDelete = (opts && opts.onDelete) || null;
    const host = D.getElementById('dashboardBody');
    if (!host) return;
    if (!_built) { buildSkeleton(host); wire(host); ensureToast(); _built = true; }
    renderAll();
  }
  function refresh() { if (_built) renderAll(); }

  // Exports : cœur d'agrégation (Node + navigateur) + API de rendu (navigateur).
  root.Dashboard = { aggregate, outcome, oppHeroOf, dateOf, mount, refresh };
  if (typeof module === 'object' && module.exports) module.exports = root.Dashboard;
})(typeof self !== 'undefined' ? self : this);
