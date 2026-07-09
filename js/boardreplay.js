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
  function resolveImg(name, hero) {
    const k = (hero ? 'H:' : '') + norm(name);
    if (_img[k] !== undefined) return Promise.resolve(_img[k]);
    const fn = hero ? (CI.resolveHeroCardImage || CI.resolveCardImage) : CI.resolveCardImage;
    if (!fn) return Promise.resolve(null);
    return fn(name).then(u => (_img[k] = u || null)).catch(() => (_img[k] = null));
  }
  function paintArt(scope) {
    scope.querySelectorAll('.br-art[data-card]').forEach(art => {
      if (art.dataset.painted) return;
      const name = art.getAttribute('data-card');
      if (!name) return;
      art.dataset.painted = '1';
      resolveImg(name, art.hasAttribute('data-hero')).then(u => { if (u) { art.style.backgroundImage = 'url("' + u + '")'; art.classList.add('has-img'); } });
    });
  }

  // ============================================================
  // RECONSTRUCTION — GAME parsé → liste d'étapes { turn, actor, stage, state }
  // ============================================================
  function equipSet(pl) { const s = {}; const e = (pl && pl.equipment) || {}; Object.keys(e).forEach(k => { if (e[k] && e[k].name) s[norm(e[k].name)] = 1; }); return s; }

  function buildTimeline(GAME) {
    const MY = GAME.myName, OPP = GAME.oppName;
    const HERO = { me: (GAME.players.me && GAME.players.me.hero) || MY, opp: (GAME.players.opp && GAME.players.opp.hero) || OPP };
    const EQ = { me: equipSet(GAME.players.me), opp: equipSet(GAME.players.opp) };
    const sideOf = p => (p === MY ? 'me' : 'opp');
    const isEquip = (side, card) => !!EQ[side][norm(card)];
    const ls = GAME.lifeSeries || { me: [], opp: [] };

    const st = {
      meHandCards: [], meHandCount: 0, meFaceUp: false, oppHandCount: 4,
      mePitch: [], oppPitch: [], meArsenal: [], oppArsenalCount: 0,
      meGrave: [], oppGrave: [], life: { me: 0, opp: 0 }
    };
    const steps = [];
    const snap = () => ({
      meHandCards: st.meHandCards.slice(), meHandCount: st.meHandCount, meFaceUp: st.meFaceUp, oppHandCount: st.oppHandCount,
      mePitch: st.mePitch.slice(), oppPitch: st.oppPitch.slice(), meArsenal: st.meArsenal.slice(), oppArsenalCount: st.oppArsenalCount,
      meGrave: st.meGrave.slice(), oppGrave: st.oppGrave.slice(), life: { me: st.life.me, opp: st.life.opp }
    });
    const push = (turn, actor, stage, hit) => steps.push({ turn, actor, stage, hit: hit || null, state: snap() });
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

      // Ouverture (pas de joueur de tour) : on montre juste la main de départ.
      if (!attacker) {
        st.meFaceUp = !!(t.hand && t.hand.length);
        if (st.meFaceUp) { st.meHandCards = (t.hand || []).slice(); st.meArsenal = (t.arsenal || []).slice(); }
        push(t.label || 'Ouverture', 'me', { type: 'banner', side: 'me', big: 'Début de la partie', sub: HERO.me + ' vs ' + HERO.opp });
        return;
      }
      const atkSide = sideOf(attacker);
      if (attacker === MY) { st.meFaceUp = true; st.meHandCards = (t.hand || []).slice(); st.meArsenal = (t.arsenal || []).slice(); st.oppHandCount = 4; }
      else { st.meFaceUp = false; st.meHandCount = 4; st.oppHandCount = (t.hand || []).length || 4; st.oppArsenalCount = (t.arsenal || []).length; }

      const label = String(t.label || '').replace(MY, HERO.me).replace(OPP, HERO.opp);
      push(label, atkSide, { type: 'banner', side: atkSide, big: attacker === MY ? 'Ton tour' : 'Tour adverse',
        sub: HERO[atkSide] + ' attaque · ' + HERO.me + ' ' + st.life.me + ' PV · ' + HERO.opp + ' ' + st.life.opp + ' PV' });

      const evs = t.events || [], consumed = {};
      let openAtk = null, curBlocks = [], curReactions = [];
      evs.forEach((e, i) => {
        if (consumed[i]) return;
        if (e.type === 'played') {
          const side = sideOf(e.player); removeCard(side, e.card);
          const pitches = [];
          for (let j = i + 1; j < evs.length; j++) { const f = evs[j]; if (f.type === 'played') break; if (f.type === 'pitched' && f.player === e.player) { pitches.push(f.card); consumed[j] = 1; addPitch(side, f.card); removeCard(side, f.card); } }
          const pTxt = pitches.length ? ' (pitch ' + pitches.join(', ') + ')' : '';
          if (side === atkSide) {
            openAtk = { nm: e.card, side };
            push(label, side, { type: 'play', side, card: { nm: e.card }, pitch: pitches.join(', '), text: HERO[side] + ' joue ' + e.card + pTxt });
          } else {
            curReactions.push({ card: e.card, owner: side });
            push(label, side, { type: 'play', side, card: { nm: e.card }, reaction: true, pitch: pitches.join(', '), text: HERO[side] + ' joue ' + e.card + ' en réaction' + pTxt });
          }
        } else if (e.type === 'pitched') {
          const s = sideOf(e.player); addPitch(s, e.card); removeCard(s, e.card);
        } else if (e.type === 'blocked') {
          const s = sideOf(e.player);
          (e.cards || []).forEach(c => { const eq = isEquip(s, c); if (!eq) removeCard(s, c); curBlocks.push({ card: c, owner: s, eq }); });
        } else if (e.type === 'damageTaken') {
          const s = sideOf(e.player); st.life[s] = Math.max(0, st.life[s] - (e.amount || 0));
        } else if (e.type === 'combatResult') {
          const dmg = e.hit ? (e.amount || 0) : 0;
          if (openAtk) toGrave(openAtk.side, openAtk.nm);
          curBlocks.forEach(b => { if (!b.eq) toGrave(b.owner, b.card); });
          curReactions.forEach(r => toGrave(r.owner, r.card));
          if (openAtk) {
            const defSide = openAtk.side === 'me' ? 'opp' : 'me';
            const defCards = curBlocks.map(b => ({ nm: b.card })).concat(curReactions.filter(r => r.owner === defSide).map(r => ({ nm: r.card })));
            const blockWho = curBlocks.length ? curBlocks[0].owner : defSide;
            const vt = dmg > 0 ? 'through' : 'blocked';
            const rtxt = dmg > 0 ? (dmg + ' dégât' + (dmg > 1 ? 's' : '') + ' pass' + (dmg > 1 ? 'ent' : 'e')) : '0 dégât — bloqué';
            const blkTxt = defCards.length ? ((blockWho === 'me' ? 'Tu défends' : HERO.opp + ' défend') + ' : ' + defCards.map(b => b.nm).join(', ')) : 'non bloqué';
            push(label, openAtk.side, { type: 'clash', atk: { nm: openAtk.nm, who: openAtk.side }, blocks: defCards, blockWho, verdict: vt, result: rtxt, text: blkTxt }, dmg > 0 ? defSide : null);
          }
          openAtk = null; curBlocks = []; curReactions = [];
        }
      });
    });
    return { players: GAME.players, myName: MY, oppName: OPP, hero: HERO, steps };
  }

  // ============================================================
  // RENDU
  // ============================================================
  function gcard(side, slot, label, name, hero) {
    return '<div class="br-gcard br-' + side + ' p-' + slot + (hero ? ' br-hero' : '') + '">' +
      '<span class="br-slot-t">' + esc(label) + '</span>' +
      '<div class="br-art" data-card="' + esc(name) + '"' + (hero ? ' data-hero' : '') + '></div>' +
      '<div class="br-lab">' + esc(name) + '</div></div>';
  }
  function buildZone(side, pl, mirror) {
    const e = pl.equipment || {};
    const nm = k => (e[k] && e[k].name) || '—';
    const equip = '<div class="br-equip">' + gcard(side, 'head', 'Tête', nm('head')) + gcard(side, 'chest', 'Torse', nm('chest')) +
      gcard(side, 'arms', 'Bras', nm('arms')) + gcard(side, 'legs', 'Jambes', nm('legs')) + '</div>';
    const arsId = side === 'me' ? 'mArsenal' : 'oArsenal';
    const arsenal = '<div class="br-slot br-arsenal" id="br-' + arsId + '">Arsenal</div>';
    const hero = '<div class="br-heroblk' + (mirror ? ' br-mir' : '') + '">' + (mirror ? arsenal : '') +
      gcard(side, 'hero', 'Héros', pl.hero || '?', true) +
      '<div class="br-gcard br-' + side + ' br-wpn"><span class="br-slot-t">Arme</span><div class="br-art" data-card="' + esc(nm('weaponL')) + '"></div><div class="br-lab">' + esc(nm('weaponL')) + '</div></div>' +
      (mirror ? '' : arsenal) + '</div>';
    const gId = side === 'me' ? 'mGrave' : 'oGrave', pId = side === 'me' ? 'mPitch' : 'oPitch';
    const deck = '<div class="br-deckrail' + (mirror ? ' br-mir' : '') + '">' +
      '<div class="br-slot p-grave" id="br-' + gId + '">Cimetière</div>' +
      '<div class="br-slot p-pitch" id="br-' + pId + '">Pitch</div>' +
      '<div class="br-deck p-deck" title="Deck"></div>' +
      '<div class="br-slot p-banish">Banish</div></div>';
    return equip + hero + deck;
  }

  function mount(container, GAME) {
    if (!container || !GAME || !GAME.turns) return;
    const data = buildTimeline(GAME), steps = data.steps, P = data.players;
    if (!steps.length) { container.innerHTML = '<div class="br-empty">Pas d\'action à rejouer pour cette partie.</div>'; return; }

    container.innerHTML =
      '<div class="br-wrap">' +
        '<div class="br-toolbar" role="group" aria-label="Contrôles de lecture">' +
          '<button class="br-tool" data-act="restart" title="Recommencer" aria-label="Recommencer">⏮</button>' +
          '<button class="br-tool" data-act="prev" title="Étape précédente" aria-label="Étape précédente">‹</button>' +
          '<button class="br-tool br-play" data-act="play" aria-label="Lecture automatique">▶ Lecture</button>' +
          '<button class="br-tool" data-act="next" title="Étape suivante" aria-label="Étape suivante">›</button>' +
        '</div>' +
        '<div class="br-table">' +
          '<div class="br-hand br-opp" id="br-oppHand"></div>' +
          '<div class="br-zone br-opp" id="br-zOpp">' + buildZone('opp', P.opp, true) + '</div>' +
          '<div class="br-mid">' +
            '<div class="br-stage" id="br-stage"></div>' +
            '<div class="br-lifecol">' +
              '<div class="br-lifebox br-opp" id="br-oLife"><div class="br-who">' + esc(data.hero.opp) + '</div><div class="br-n" id="br-oLifeN">0</div></div>' +
              '<div class="br-turnchip"><span id="br-turnPill"> </span></div>' +
              '<div class="br-lifebox br-me" id="br-mLife"><div class="br-who">' + esc(data.hero.me) + ' · toi</div><div class="br-n" id="br-mLifeN">0</div></div>' +
            '</div>' +
          '</div>' +
          '<div class="br-zone br-me br-active" id="br-zMe">' + buildZone('me', P.me, false) + '</div>' +
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

    const pcard = (c, side) => '<div class="br-pcard br-' + side + '" data-card="' + esc(c.nm) + '"><div class="br-art" data-card="' + esc(c.nm) + '"></div><div class="br-nm">' + esc(c.nm) + '</div></div>';
    function buildStage(s) {
      if (s.type === 'banner') return '<div class="br-banner br-' + s.side + '"><div class="br-big">' + esc(s.big) + '</div><div class="br-sub">' + esc(s.sub) + '</div></div>';
      if (s.type === 'play') return '<div class="br-phase">' + (s.reaction ? 'Réaction' : 'Action') + '</div><div class="br-duel"><div class="br-side">' + pcard(s.card, s.side) + (s.pitch ? '<span class="br-pitch-pill">🔷 pitch ' + esc(s.pitch) + '</span>' : '') + '</div></div><div class="br-banner br-' + s.side + '"><div class="br-sub" style="margin-top:8px">' + esc(s.text) + '</div></div>';
      if (s.type === 'clash') {
        const bl = s.blocks.length ? s.blocks.map(b => pcard(b, s.blockWho)).join('') : '<span class="br-noblock">Non bloqué</span>';
        return '<div class="br-phase">Combat</div><div class="br-duel"><div class="br-side"><span class="br-duel-who">Attaque</span>' + pcard(s.atk, s.atk.who) + '</div><span class="br-arrow">→</span><div class="br-side"><span class="br-duel-who">Défense</span><div class="br-cardrow">' + bl + '</div></div></div><div class="br-verdict br-' + s.verdict + '">' + (s.verdict === 'blocked' ? '✓ ' : '💥 ') + esc(s.result) + '</div>';
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
    function render(prev) {
      const s = steps[i], stt = s.state;
      stage.innerHTML = buildStage(s.stage);
      $('#br-mLifeN').textContent = stt.life.me; $('#br-oLifeN').textContent = stt.life.opp;
      $('#br-turnPill').textContent = s.turn;
      renderHands(stt);
      fillSlot('#br-mPitch', 'Pitch', stt.mePitch, 'me', 'up');
      fillSlot('#br-oPitch', 'Pitch', stt.oppPitch, 'opp', 'up');
      fillSlot('#br-mArsenal', 'Arsenal', stt.meArsenal, 'me', 'up');
      fillSlot('#br-oArsenal', 'Arsenal', stt.oppArsenalCount > 0 ? ['?'] : [], 'opp', 'back');
      fillSlot('#br-mGrave', 'Cimetière', stt.meGrave, 'me', 'grave');
      fillSlot('#br-oGrave', 'Cimetière', stt.oppGrave, 'opp', 'grave');
      $('#br-zMe').classList.toggle('br-active', s.actor === 'me');
      $('#br-zOpp').classList.toggle('br-active', s.actor === 'opp');
      slider.value = i; slider.style.setProperty('--pct', (steps.length > 1 ? i / (steps.length - 1) * 100 : 0) + '%');
      $('#br-stepN').textContent = i + 1; $('#br-turnLbl').textContent = s.turn;
      container.querySelector('[data-act="prev"]').disabled = (i === 0);
      container.querySelector('[data-act="next"]').disabled = (i === steps.length - 1);
      if (s.hit && prev != null && prev < i) { const el = $(s.hit === 'me' ? '#br-mLife' : '#br-oLife'); el.classList.remove('br-hit'); void el.offsetWidth; el.classList.add('br-hit'); }
      paintArt(container);
    }
    function go(n, prev) { i = Math.max(0, Math.min(steps.length - 1, n)); render(prev); container.__brIndex = i; }
    function stop() { playing = false; clearInterval(timer); $('.br-play').innerHTML = '▶ Lecture'; }
    function play() { if (i >= steps.length - 1) go(0); playing = true; $('.br-play').innerHTML = '❚❚ Pause'; timer = setInterval(() => { if (i >= steps.length - 1) { stop(); return; } go(i + 1, i); }, 1150); }

    container.querySelector('[data-act="next"]').addEventListener('click', () => { stop(); go(i + 1, i); });
    container.querySelector('[data-act="prev"]').addEventListener('click', () => { stop(); go(i - 1, i); });
    container.querySelector('[data-act="restart"]').addEventListener('click', () => { stop(); go(0, null); });
    $('.br-play').addEventListener('click', () => { playing ? stop() : play(); });
    slider.addEventListener('input', () => { stop(); go(parseInt(slider.value, 10), i); });

    go(0, null);
  }

  root.BoardReplay = { mount, buildTimeline };
  if (typeof module === 'object' && module.exports) module.exports = root.BoardReplay;
})(typeof self !== 'undefined' ? self : this);
