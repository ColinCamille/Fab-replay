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
  // RENDU (navigateur uniquement)
  // ============================================================
  let _entries = [];
  let _onOpen = null, _onDelete = null;
  let _histSearch = '';   // recherche de l'onglet Historique
  let _wired = false;     // écouteurs onglets/recherche posés une seule fois
  // État UI de la table « performance des cartes » (persiste entre refresh).
  let _cardSearch = '';
  let _cardPerfAll = [];
  let _cardSort = { key: 'played', dir: 'desc' };
  let _cardMode = 'total';   // 'total' | 'pergame' | 'pct'
  let _cardCap = 20;         // 0 = tout
  let _cardTotalGames = 0;   // parties filtrées (dénominateur « par partie »)

  const $ = sel => document.querySelector(sel);
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function mount(opts) {
    _entries = opts.entries || [];
    _onOpen = opts.onOpen || null;
    _onDelete = opts.onDelete || null;
    wireDashOnce();
    buildFilters();
    buildHistFilters();
    refresh();
    renderHistory();
  }

  function currentFilters() {
    return {
      includeAI: $('#fltAI') ? $('#fltAI').checked : false,
      format: $('#fltFormat') && $('#fltFormat').value ? $('#fltFormat').value : null,
      myHero: $('#fltMyHero') && $('#fltMyHero').value ? $('#fltMyHero').value : null,
      oppHero: $('#fltHero') && $('#fltHero').value ? $('#fltHero').value : null,
      period: $('#fltPeriod') ? $('#fltPeriod').value : 'all'
    };
  }

  // HTML des champs de filtre (réutilisé par les onglets Statistiques ET
  // Historique) — `ids` porte les identifiants distincts de chaque instance.
  function filtersHtml(ids) {
    const agg = aggregate(_entries, { includeAI: true, period: 'all' });
    const opt = (arr, first) => ['<option value="">' + first + '</option>']
      .concat(arr.map(x => `<option value="${esc(x)}">${esc(x)}</option>`)).join('');
    return `<div class="field"><label>Format</label><select id="${ids.format}">${opt(agg.facets.formats, 'Tous formats')}</select></div>` +
      `<div class="field"><label>Mon héros</label><select id="${ids.myHero}">${opt(agg.facets.myHeroes, 'Tous mes héros')}</select></div>` +
      `<div class="field"><label>Héros adverse</label><select id="${ids.oppHero}">${opt(agg.facets.oppHeroes, 'Tous adversaires')}</select></div>` +
      `<div class="field"><label>Période</label><select id="${ids.period}">` +
        `<option value="all">Tout l'historique</option>` +
        `<option value="7d">7 derniers jours</option>` +
        `<option value="30d">30 derniers jours</option>` +
        `<option value="90d">90 derniers jours</option></select></div>` +
      `<div class="field chk"><input type="checkbox" id="${ids.ai}"><label for="${ids.ai}">Inclure les parties vs IA</label></div>`;
  }
  function readFilters(ids) {
    return {
      includeAI: $('#' + ids.ai) ? $('#' + ids.ai).checked : false,
      format: $('#' + ids.format) && $('#' + ids.format).value ? $('#' + ids.format).value : null,
      myHero: $('#' + ids.myHero) && $('#' + ids.myHero).value ? $('#' + ids.myHero).value : null,
      oppHero: $('#' + ids.oppHero) && $('#' + ids.oppHero).value ? $('#' + ids.oppHero).value : null,
      period: $('#' + ids.period) ? $('#' + ids.period).value : 'all'
    };
  }
  const STAT_IDS = { format: 'fltFormat', myHero: 'fltMyHero', oppHero: 'fltHero', period: 'fltPeriod', ai: 'fltAI' };
  const HIST_IDS = { format: 'hFltFormat', myHero: 'hFltMyHero', oppHero: 'hFltHero', period: 'hFltPeriod', ai: 'hFltAI' };

  function buildFilters() {
    const host = $('#dashFilters');
    if (!host) return;
    host.innerHTML = filtersHtml(STAT_IDS);
    Object.values(STAT_IDS).forEach(id => { const el = $('#' + id); if (el) el.addEventListener('change', refresh); });
  }
  function buildHistFilters() {
    const host = $('#histFilters');
    if (!host) return;
    host.innerHTML = filtersHtml(HIST_IDS);
    Object.values(HIST_IDS).forEach(id => { const el = $('#' + id); if (el) el.addEventListener('change', renderHistory); });
  }

  function refresh() {
    const agg = aggregate(_entries, currentFilters());
    renderKpis(agg);
    renderMyHeroes(agg);
    renderInitiative(agg);
    renderBestWorst(agg);
    renderMatchups(agg);
    renderTrend(agg);
    renderCardWinLoss(agg);
    renderCardPerf(agg);
    // La liste des parties (onglet Historique) est indépendante des filtres de
    // stats : elle montre TOUTES les parties, avec sa propre recherche texte.
  }

  // ---------- Onglets du tableau de bord (Statistiques / Historique) ----------
  function setDashTab(name) {
    document.querySelectorAll('.dash-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.dtab === name));
    const st = $('#dtab-stats'), hi = $('#dtab-history');
    if (st) st.classList.toggle('active', name === 'stats');
    if (hi) hi.classList.toggle('active', name === 'history');
    window.scrollTo(0, 0);
  }
  function wireDashOnce() {
    if (_wired) return; _wired = true;
    const s = $('#histSearch');
    if (s) s.addEventListener('input', () => { _histSearch = s.value; renderHistory(); });
    document.querySelectorAll('.dash-tab-btn').forEach(b => b.addEventListener('click', () => setDashTab(b.dataset.dtab)));
  }

  function renderKpis(agg) {
    const host = $('#dashKpis');
    if (!host) return;
    const g = agg.global, fs = agg.firstSecond;
    const wr = g.winrate == null ? '—' : g.winrate + '%';
    const wrCls = g.winrate == null ? '' : (g.winrate >= 50 ? 'green' : 'red');
    const cell = (v, cls, k, sub) =>
      `<div class="kpi${cls === 'hero' ? ' hero' : ''}"><div class="v ${cls === 'hero' ? '' : cls}">${v}</div><div class="k">${k}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
    host.innerHTML =
      cell(wr, wrCls || 'hero', 'Winrate global', `${g.wins}V / ${g.losses}D sur ${g.decided} décidées`) +
      cell(String(g.games), 'hero', 'Parties (filtrées)', agg.filters.includeAI ? 'IA incluse' : 'IA exclue') +
      cell(fs.first.winrate == null ? '—' : fs.first.winrate + '%', 'violet', 'Winrate 1er joueur', `${fs.first.wins}/${fs.first.games}`) +
      cell(fs.second.winrate == null ? '—' : fs.second.winrate + '%', 'violet', 'Winrate 2e joueur', `${fs.second.wins}/${fs.second.games}`);
  }

  // Winrate par héros joué (« tes decks ») — même présentation que les matchups.
  function renderMyHeroes(agg) {
    const host = $('#dashMyHeroes');
    if (!host) return;
    const rows = agg.byMyHero || [];
    // On ne montre la section que si tu as joué au moins 2 héros différents
    // (sinon c'est juste le winrate global, déjà affiché plus haut).
    const wrap = host.closest ? host.closest('.section-block') : null;
    if (rows.length < 2) { host.innerHTML = ''; if (wrap) wrap.style.display = 'none'; return; }
    if (wrap) wrap.style.display = '';
    host.innerHTML = rows.map(m => {
      const pct = m.winrate == null ? 0 : m.winrate;
      const pctTxt = m.winrate == null ? '—' : m.winrate + '%';
      const initial = esc((m.hero || '?').charAt(0).toUpperCase());
      return `<div class="matchup-row">` +
        `<div class="mu-hero"><div class="mu-avatar" data-hero="${esc(m.hero)}">${initial}</div>` +
        `<div class="mu-name">${esc(m.hero)}</div></div>` +
        `<div class="mu-bar"><div style="width:${pct}%"></div></div>` +
        `<div class="mu-pct">${pctTxt}</div>` +
        `<div class="mu-vol">${m.wins}-${m.losses}</div></div>`;
    }).join('');
    if (root.CardImages) {
      host.querySelectorAll('.mu-avatar[data-hero]').forEach(av => {
        const hero = av.getAttribute('data-hero');
        if (!hero || hero === '(inconnu)') return;
        root.CardImages.resolveCardImage(hero).then(url => { if (url) av.innerHTML = `<img src="${url}" alt="${esc(hero)}" loading="lazy">`; });
      });
    }
  }

  function renderMatchups(agg) {
    const host = $('#dashMatchups');
    if (!host) return;
    if (!agg.byMatchup.length) { host.innerHTML = '<div class="board-empty" style="padding:10px 16px">Aucun matchup pour ces filtres.</div>'; return; }
    host.innerHTML = agg.byMatchup.map(m => {
      const pct = m.winrate == null ? 0 : m.winrate;
      const pctTxt = m.winrate == null ? '—' : m.winrate + '%';
      const initial = esc((m.hero || '?').charAt(0).toUpperCase());
      return `<div class="matchup-row">` +
        `<div class="mu-hero"><div class="mu-avatar" data-hero="${esc(m.hero)}">${initial}</div>` +
        `<div class="mu-name">${esc(m.hero)}</div></div>` +
        `<div class="mu-bar"><div style="width:${pct}%"></div></div>` +
        `<div class="mu-pct">${pctTxt}</div>` +
        `<div class="mu-vol">${m.wins}-${m.losses}</div></div>`;
    }).join('');
    // Avatars de héros (async, via le module partagé si présent)
    if (root.CardImages) {
      host.querySelectorAll('.mu-avatar[data-hero]').forEach(av => {
        const hero = av.getAttribute('data-hero');
        if (!hero || hero === '(inconnu)') return;
        root.CardImages.resolveCardImage(hero).then(url => { if (url) av.innerHTML = `<img src="${url}" alt="${esc(hero)}" loading="lazy">`; });
      });
    }
  }

  // ---------- Avantage d'initiative détaillé (1er vs 2e, par héros/matchup) ----------
  let _initMode = 'mine';   // 'mine' = par mon héros | 'opp' = par adversaire
  function initRows(agg) { return _initMode === 'opp' ? (agg.byMatchup || []) : (agg.byMyHero || []); }
  function renderInitiative(agg) {
    const host = $('#dashInit');
    if (!host) return;
    const wrap = host.closest ? host.closest('.section-block') : null;
    const rows = initRows(agg).filter(m => m.hero !== '(inconnu)' && (m.first.games + m.second.games) > 0);
    // On ne montre la section que s'il existe au moins une partie où l'ordre
    // du tour est connu (les vieilles parties sans endStats ne l'ont pas).
    if (!rows.length) { host.innerHTML = ''; if (wrap) wrap.style.display = 'none'; return; }
    if (wrap) wrap.style.display = '';
    const cell = s => s.games ? `<b class="${s.winrate == null ? '' : (s.winrate >= 50 ? 'green' : 'red')}">${s.winrate == null ? '—' : s.winrate + '%'}</b> <span class="muted">${s.wins}/${s.games}</span>` : MUTED;
    const label = _initMode === 'opp' ? 'Adversaire' : 'Mon héros';
    const body = rows.map(m => `<tr><td>${esc(m.hero)}</td><td>${cell(m.first)}</td><td>${cell(m.second)}</td></tr>`).join('');
    host.innerHTML =
      '<div class="init-toggle">' +
        `<button data-im="mine" class="${_initMode === 'mine' ? 'active' : ''}">Par mon héros</button>` +
        `<button data-im="opp" class="${_initMode === 'opp' ? 'active' : ''}">Par adversaire</button>` +
      '</div>' +
      `<div class="table-scroll"><table class="off-table init-table"><tr><th>${label}</th><th title="Winrate quand tu commences (1er joueur)">En 1er</th><th title="Winrate quand tu joues en second (2e joueur)">En 2e</th></tr>${body}</table></div>`;
    host.querySelectorAll('.init-toggle button').forEach(b => b.addEventListener('click', () => {
      _initMode = b.getAttribute('data-im'); renderInitiative(agg);
    }));
  }

  // ---------- Meilleurs / pires matchups ----------
  function bwList(rows, kind) {
    if (!rows.length) {
      const msg = kind === 'best' ? 'Aucun matchup favorable (> 50 %) pour l\'instant.'
        : 'Aucun matchup défavorable (< 50 %). 💪';
      return `<div class="board-empty" style="padding:8px 12px">${msg}</div>`;
    }
    return rows.map(m => {
      const initial = esc((m.hero || '?').charAt(0).toUpperCase());
      const cls = m.winrate == null ? '' : (m.winrate >= 50 ? 'green' : 'red');
      return `<div class="bw-row"><div class="mu-avatar" data-hero="${esc(m.hero)}">${initial}</div>` +
        `<div class="bw-name">${esc(m.hero)}</div>` +
        `<div class="bw-pct ${cls}">${m.winrate}%</div>` +
        `<div class="bw-vol">${m.wins}-${m.losses}</div></div>`;
    }).join('');
  }
  function renderBestWorst(agg) {
    const host = $('#dashBestWorst');
    if (!host) return;
    const wrap = host.closest ? host.closest('.section-block') : null;
    const best = agg.bestMatchups || [], worst = agg.worstMatchups || [];
    if (!best.length && !worst.length) { host.innerHTML = ''; if (wrap) wrap.style.display = 'none'; return; }
    if (wrap) wrap.style.display = '';
    host.innerHTML =
      `<div class="bw-col"><h3 class="bw-title good">✅ Meilleurs matchups</h3>${bwList(best, 'best')}</div>` +
      `<div class="bw-col"><h3 class="bw-title bad">⚠️ Pires matchups</h3>${bwList(worst, 'worst')}</div>`;
    if (root.CardImages) {
      host.querySelectorAll('.mu-avatar[data-hero]').forEach(av => {
        const hero = av.getAttribute('data-hero');
        if (!hero || hero === '(inconnu)') return;
        root.CardImages.resolveCardImage(hero).then(url => { if (url) av.innerHTML = `<img src="${url}" alt="${esc(hero)}" loading="lazy">`; });
      });
    }
  }

  // ---------- Cartes en victoire vs défaite ----------
  function renderCardWinLoss(agg) {
    const host = $('#dashCardWL');
    if (!host) return;
    const wrap = host.closest ? host.closest('.section-block') : null;
    const rows = agg.cardWinLoss || [];
    if (!rows.length) { host.innerHTML = ''; if (wrap) wrap.style.display = 'none'; return; }
    if (wrap) wrap.style.display = '';
    const body = rows.map(c => {
      const cls = c.winrate == null ? '' : (c.winrate >= 50 ? 'green' : 'red');
      return `<tr><td>${esc(c.name)}</td>` +
        `<td class="green">${c.gamesWon || MUTED}</td>` +
        `<td class="red">${c.gamesLost || MUTED}</td>` +
        `<td><b class="${cls}">${c.winrate}%</b></td></tr>`;
    }).join('');
    host.innerHTML =
      `<div class="table-scroll"><table class="off-table"><tr><th>Carte</th><th title="Parties gagnées où la carte a été jouée">En V</th><th title="Parties perdues où la carte a été jouée">En D</th><th title="Winrate des parties où cette carte a été jouée">Winrate</th></tr>${body}</table></div>` +
      `<div class="cwl-note">Winrate des parties où la carte a été jouée (min. ${agg.cwlMin} partie${agg.cwlMin > 1 ? 's' : ''} décidée${agg.cwlMin > 1 ? 's' : ''}). À lire avec prudence sur de faibles échantillons.</div>`;
  }

  function renderTrend(agg) {
    const wrap = $('#trendWrap');
    if (!wrap) return;
    const pts = agg.trend;
    const svg = $('#trendSvg');
    const legend = $('#trendLegend');
    if (!pts.length) { if (svg) svg.innerHTML = ''; if (legend) legend.textContent = 'Pas encore de partie décidée à tracer.'; return; }
    const W = 400, H = 120, padL = 26, padR = 8, padTop = 10, padBot = 18;
    const plotW = W - padL - padR, plotH = H - padTop - padBot, n = pts.length;
    const x = i => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = v => padTop + plotH - (v / 100) * plotH;
    const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(p.winrate).toFixed(1)).join(' ');
    const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.winrate).toFixed(1)}" r="2" fill="#c9a227"/>`).join('');
    const grid = [0, 50, 100].map(v =>
      `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="#262c3d"/>` +
      `<text class="curve-axis-label" x="${padL - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`).join('');
    if (svg) svg.innerHTML =
      `<line x1="${padL}" y1="${y(50).toFixed(1)}" x2="${W - padR}" y2="${y(50).toFixed(1)}" stroke="rgba(139,107,255,.35)" stroke-dasharray="3,4"/>` +
      grid +
      `<path d="${line}" fill="none" stroke="#c9a227" stroke-width="2"/>` + dots;
    if (legend) legend.textContent = `Winrate cumulé au fil de ${n} partie${n > 1 ? 's' : ''} décidée${n > 1 ? 's' : ''} (ancien → récent).`;
  }

  // Construit une ligne de partie (cliquable → ouvre le replay).
  function gameRowEl(e) {
    const rec = e.record;
    const o = outcome(rec);
    const cls = o == null ? '' : (o ? 'win' : 'loss');
    const verdict = o == null ? 'En cours' : (o ? 'Victoire' : 'Défaite');
    const subBits = [];
    if (rec.format) subBits.push(esc(rec.format));
    const d = dateOf(rec);
    if (d) { const dt = new Date(d); if (!isNaN(dt)) subBits.push(dt.toLocaleDateString('fr-FR')); }
    if (rec.turns) subBits.push(rec.turns.length + ' tours');
    if (isVsAI(rec)) subBits.push('<span class="tag-ai">🤖 IA</span>');
    const row = document.createElement('div');
    row.className = 'game-row';
    row.innerHTML =
      `<div class="gr-result ${cls}"></div>` +
      `<div class="gr-main"><div class="gr-matchup"><b>${esc((rec.players && rec.players.me && rec.players.me.hero) || '?')}</b> vs ${esc(oppHeroOf(rec) || '?')}</div>` +
      `<div class="gr-sub">${subBits.join(' · ')}</div></div>` +
      `<div class="gr-verdict ${cls}">${verdict}</div>` +
      `<button class="gr-del" title="Supprimer cette partie">✕</button>`;
    row.querySelector('.gr-main').addEventListener('click', () => { if (_onOpen) _onOpen(e); });
    row.querySelector('.gr-result').addEventListener('click', () => { if (_onOpen) _onOpen(e); });
    row.querySelector('.gr-verdict').addEventListener('click', () => { if (_onOpen) _onOpen(e); });
    row.querySelector('.gr-del').addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (_onDelete) _onDelete(e.gameId);
    });
    return row;
  }

  // Texte indexé pour la recherche d'une partie (héros, adversaire, format…).
  function histText(rec) {
    return norm([
      (rec.players && rec.players.me && rec.players.me.hero), oppHeroOf(rec),
      rec.oppName, rec.myName, rec.format
    ].filter(Boolean).join(' '));
  }

  // Onglet Historique : TOUTES les parties (récent → ancien) + recherche texte.
  function renderHistory() {
    const host = $('#dashGames');
    if (!host) return;
    const all = _entries.slice().sort((a, b) =>
      (Date.parse(dateOf(b.record) || '') || 0) - (Date.parse(dateOf(a.record) || '') || 0));
    // Filtres rapides (format, héros, période, IA) + recherche texte.
    const hf = readFilters(HIST_IDS);
    const q = norm(_histSearch);
    const list = all.filter(e => passesFilters(e.record, hf) && (!q || histText(e.record).indexOf(q) >= 0));

    const narrowed = list.length !== all.length;
    const gc = $('#gamesCount');
    if (gc) gc.textContent = narrowed ? '(' + list.length + ' / ' + all.length + ')' : '(' + all.length + ')';
    const hc = $('#histCount');
    if (hc) hc.textContent = '(' + all.length + ')';

    host.innerHTML = '';
    if (!list.length) {
      host.innerHTML = '<div class="board-empty" style="padding:12px 16px">' +
        (narrowed ? 'Aucune partie ne correspond aux filtres / à la recherche.' : 'Aucune partie.') + '</div>';
      return;
    }
    list.forEach(e => host.appendChild(gameRowEl(e)));
  }

  // Colonnes de la table (ordre = affichage). `count` = toujours en compte brut ;
  // `hit` = colonne « Touché » (mise en évidence). Toutes triables.
  const CARD_COLS = [
    { key: 'name', label: 'Carte' },
    { key: 'games', label: 'Parties', count: true },
    { key: 'played', label: 'Jouée' },
    { key: 'blocked', label: 'Défense', tip: 'Fois utilisée pour bloquer' },
    { key: 'pitched', label: 'Pitch' },
    { key: 'timesHit', label: 'Coups', hit: true, tip: 'Coups portés (attaque non bloquée)' }
  ];
  const MUTED = '<span class="muted">·</span>';

  // Formate une cellule numérique selon le mode d'affichage courant.
  // Mode « % » = lecture PAR LIGNE (à quoi sert la carte) :
  //   - Jouée / Défense / Pitch : part de l'usage de la carte → somme ≈ 100 %.
  //   - Coups : cas à part, taux de coups portés = touché ÷ jouée × 100
  //     (à quel point la carte connecte quand tu l'attaques).
  const pct1 = v => Math.round(v * 10) / 10 + '%';
  function fmtCardCell(col, c) {
    const raw = c[col.key] || 0;
    if (col.count || _cardMode === 'total') return raw ? String(raw) : MUTED;   // compte brut
    if (_cardMode === 'pergame') {                                              // moyenne / partie
      const v = _cardTotalGames ? raw / _cardTotalGames : 0;
      return v ? String(Math.round(v * 100) / 100) : MUTED;
    }
    // Mode % (les zéros restent « · » comme dans les autres modes).
    if (col.key === 'timesHit') {                                               // taux de coups portés
      const played = c.played || 0;
      return (played && raw) ? pct1(raw / played * 100) : MUTED;
    }
    const usage = (c.played || 0) + (c.blocked || 0) + (c.pitched || 0);        // répartition d'usage
    return (usage && raw) ? pct1(raw / usage * 100) : MUTED;
  }

  function renderCardPerf(agg) {
    const host = $('#dashCards');
    if (!host) return;
    _cardPerfAll = agg.cardPerf.filter(c => c.played || c.blocked || c.timesHit);
    _cardTotalGames = agg.global.games || 0;
    if (!_cardPerfAll.length) { host.innerHTML = '<div class="board-empty" style="padding:10px 16px">Aucune stat de carte agrégée (nécessite les stats officielles Talishar).</div>'; return; }
    host.innerHTML =
      '<div class="cards-controls">' +
        `<input type="search" id="cardSearch" class="cards-search" placeholder="Rechercher une carte…" value="${esc(_cardSearch)}">` +
        '<select id="cardMode" class="cards-mini" title="Affichage des valeurs">' +
          '<option value="total">Total</option><option value="pergame">Par partie</option><option value="pct">%</option></select>' +
        '<select id="cardCap" class="cards-mini" title="Cartes affichées">' +
          '<option value="20">Top 20</option><option value="50">Top 50</option><option value="100">Top 100</option><option value="0">Tout</option></select>' +
        '<span class="cards-count" id="cardCount"></span>' +
      '</div>' +
      '<div id="cardTableWrap"></div>';
    const search = $('#cardSearch'), modeSel = $('#cardMode'), capSel = $('#cardCap');
    if (modeSel) modeSel.value = _cardMode;
    if (capSel) capSel.value = String(_cardCap);
    // Taper ne re-render QUE la table (préserve le focus/curseur de la recherche).
    if (search) search.addEventListener('input', () => { _cardSearch = search.value; renderCardTable(); });
    if (modeSel) modeSel.addEventListener('change', () => { _cardMode = modeSel.value; renderCardTable(); });
    if (capSel) capSel.addEventListener('change', () => { _cardCap = Number(capSel.value) || 0; renderCardTable(); });
    renderCardTable();
  }

  function renderCardTable() {
    const wrap = $('#cardTableWrap');
    if (!wrap) return;
    const q = norm(_cardSearch);
    const filtered = q ? _cardPerfAll.filter(c => norm(c.name).indexOf(q) >= 0) : _cardPerfAll;
    const sorted = filtered.slice().sort((a, b) => {
      if (_cardSort.key === 'name') return String(a.name).localeCompare(String(b.name));
      return (a[_cardSort.key] || 0) - (b[_cardSort.key] || 0);
    });
    if (_cardSort.dir === 'desc') sorted.reverse();
    const shown = _cardCap > 0 ? sorted.slice(0, _cardCap) : sorted;

    const count = $('#cardCount');
    if (count) count.textContent = filtered.length === _cardPerfAll.length
      ? _cardPerfAll.length + ' cartes'
      : filtered.length + ' / ' + _cardPerfAll.length + ' cartes';

    if (!shown.length) {
      wrap.innerHTML = `<div class="board-empty" style="padding:10px 16px">Aucune carte ne correspond à « ${esc(_cardSearch)} ».</div>`;
      return;
    }
    const head = CARD_COLS.map(col => {
      const arrow = _cardSort.key === col.key ? (_cardSort.dir === 'desc' ? ' ▼' : ' ▲') : '';
      const tip = col.tip ? ` title="${esc(col.tip)}"` : '';
      return `<th class="sortable" data-key="${col.key}"${tip}>${esc(col.label)}${arrow}</th>`;
    }).join('');
    const body = shown.map(c => '<tr>' + CARD_COLS.map(col => {
      if (col.key === 'name') return `<td>${esc(c.name)}</td>`;
      const cls = col.hit && c.timesHit ? ' class="hit"' : '';
      return `<td${cls}>${fmtCardCell(col, c)}</td>`;
    }).join('') + '</tr>').join('');
    const note = _cardMode === 'pct'
      ? `<div class="cwl-note">Par ligne : <b>Jouée + Défense + Pitch = 100 %</b> (à quoi sert la carte). <b>Coups</b> = taux de coups portés (touché ÷ jouée).</div>`
      : '';
    wrap.innerHTML = `<div class="table-scroll"><table class="off-table"><tr>${head}</tr>${body}</table></div>` + note;

    // Tri au clic sur un en-tête (même colonne → inverse le sens).
    wrap.querySelectorAll('th.sortable').forEach(th => th.addEventListener('click', () => {
      const key = th.getAttribute('data-key');
      if (_cardSort.key === key) _cardSort.dir = _cardSort.dir === 'desc' ? 'asc' : 'desc';
      else { _cardSort.key = key; _cardSort.dir = key === 'name' ? 'asc' : 'desc'; }
      renderCardTable();
    }));
  }

  // Exports : cœur d'agrégation (Node + navigateur) + API de rendu (navigateur).
  root.Dashboard = { aggregate, outcome, oppHeroOf, dateOf, mount, refresh };
  if (typeof module === 'object' && module.exports) module.exports = root.Dashboard;
})(typeof self !== 'undefined' ? self : this);
