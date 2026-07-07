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

    // Par matchup (héros adverse)
    const muMap = {};
    kept.forEach(e => {
      const hero = oppHeroOf(e.record) || '(inconnu)';
      const o = outcome(e.record);
      const m = muMap[hero] || (muMap[hero] = { hero, games: 0, wins: 0, decided: 0 });
      m.games++;
      if (o != null) { m.decided++; if (o) m.wins++; }
    });
    const byMatchup = Object.values(muMap)
      .map(m => ({ hero: m.hero, games: m.games, wins: m.wins, losses: m.decided - m.wins, decided: m.decided, winrate: winrate(m.wins, m.decided) }))
      .sort((a, b) => b.games - a.games || (b.winrate || 0) - (a.winrate || 0));

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
    kept.forEach(e => {
      const cards = (e.record.endStats && e.record.endStats.me && e.record.endStats.me.cards) || [];
      cards.forEach(c => {
        const key = norm(c.name);
        const agg = cardMap[key] || (cardMap[key] = { name: c.name, played: 0, blocked: 0, pitched: 0, discarded: 0, timesHit: 0, games: 0 });
        agg.played += c.played || 0; agg.blocked += c.blocked || 0; agg.pitched += c.pitched || 0;
        agg.discarded += c.discarded || 0; agg.timesHit += c.timesHit || 0; agg.games++;
      });
    });
    const cardPerf = Object.values(cardMap).sort((a, b) => b.played - a.played);

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
      byMatchup, firstSecond, trend, cardPerf, offAverages
    };
  }

  // ============================================================
  // RENDU (navigateur uniquement)
  // ============================================================
  let _entries = [];
  let _onOpen = null, _onDelete = null;

  const $ = sel => document.querySelector(sel);
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function mount(opts) {
    _entries = opts.entries || [];
    _onOpen = opts.onOpen || null;
    _onDelete = opts.onDelete || null;
    buildFilters();
    refresh();
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

  function buildFilters() {
    const host = $('#dashFilters');
    if (!host) return;
    // Facettes calculées sur l'ensemble (indépendamment des filtres courants).
    const agg = aggregate(_entries, { includeAI: true, period: 'all' });
    const fmtOpts = ['<option value="">Tous formats</option>']
      .concat(agg.facets.formats.map(x => `<option value="${esc(x)}">${esc(x)}</option>`)).join('');
    const heroOpts = ['<option value="">Tous adversaires</option>']
      .concat(agg.facets.oppHeroes.map(x => `<option value="${esc(x)}">${esc(x)}</option>`)).join('');
    const myHeroOpts = ['<option value="">Tous mes héros</option>']
      .concat(agg.facets.myHeroes.map(x => `<option value="${esc(x)}">${esc(x)}</option>`)).join('');
    host.innerHTML =
      `<div class="field"><label>Format</label><select id="fltFormat">${fmtOpts}</select></div>` +
      `<div class="field"><label>Mon héros</label><select id="fltMyHero">${myHeroOpts}</select></div>` +
      `<div class="field"><label>Héros adverse</label><select id="fltHero">${heroOpts}</select></div>` +
      `<div class="field"><label>Période</label><select id="fltPeriod">` +
        `<option value="all">Tout l'historique</option>` +
        `<option value="7d">7 derniers jours</option>` +
        `<option value="30d">30 derniers jours</option>` +
        `<option value="90d">90 derniers jours</option></select></div>` +
      `<div class="field chk"><input type="checkbox" id="fltAI"><label for="fltAI">Inclure les parties vs IA</label></div>`;
    ['#fltFormat', '#fltMyHero', '#fltHero', '#fltPeriod', '#fltAI'].forEach(sel => {
      const el = $(sel); if (el) el.addEventListener('change', refresh);
    });
  }

  function refresh() {
    const agg = aggregate(_entries, currentFilters());
    renderKpis(agg);
    renderMatchups(agg);
    renderTrend(agg);
    renderGames(agg);
    renderCardPerf(agg);
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

  function renderGames(agg) {
    const host = $('#dashGames');
    if (!host) return;
    // Affichage du plus récent au plus ancien.
    const rows = agg.kept.slice().reverse();
    if (!rows.length) { host.innerHTML = '<div class="board-empty" style="padding:12px 16px">Aucune partie pour ces filtres.</div>'; return; }
    host.innerHTML = '';
    rows.forEach(e => {
      const rec = e.record;
      const o = outcome(rec);
      const cls = o == null ? '' : (o ? 'win' : 'loss');
      const verdict = o == null ? 'En cours' : (o ? 'Victoire' : 'Défaite');
      const matchup = rec.matchup || ((rec.players && rec.players.me && rec.players.me.hero) + ' vs ' + (oppHeroOf(rec) || '?'));
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
      host.appendChild(row);
    });
  }

  function renderCardPerf(agg) {
    const host = $('#dashCards');
    if (!host) return;
    const top = agg.cardPerf.filter(c => c.played || c.blocked || c.timesHit).slice(0, 20);
    if (!top.length) { host.innerHTML = '<div class="board-empty" style="padding:10px 16px">Aucune stat de carte agrégée (nécessite les stats officielles Talishar).</div>'; return; }
    host.innerHTML = '<table class="off-table"><tr><th>Carte</th><th>Parties</th><th>Jouée</th><th>Bloquée</th><th>Pitch</th><th>Touché</th></tr>'
      + top.map(c => `<tr><td>${esc(c.name)}</td><td>${c.games}</td><td>${c.played || '<span class="muted">·</span>'}</td>`
        + `<td>${c.blocked || '<span class="muted">·</span>'}</td><td>${c.pitched || '<span class="muted">·</span>'}</td>`
        + `<td class="${c.timesHit ? 'hit' : 'muted'}">${c.timesHit || '·'}</td></tr>`).join('')
      + '</table>';
  }

  // Exports : cœur d'agrégation (Node + navigateur) + API de rendu (navigateur).
  root.Dashboard = { aggregate, outcome, oppHeroOf, dateOf, mount, refresh };
  if (typeof module === 'object' && module.exports) module.exports = root.Dashboard;
})(typeof self !== 'undefined' ? self : this);
