/* ============================================================
 * Harnais de tests Node — SANS dépendance externe.
 * ------------------------------------------------------------
 * Vérifie :
 *   1. le parseur sur une fixture .txt fidèle au grabber ;
 *   2. le cœur d'agrégation du dashboard sur des records forgés ;
 *   3. la clé de déduplication de la couche DB.
 *
 * Lancement : `node tests/run.js` (ou `npm test`).
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { assert(a === b, msg + ' (attendu ' + JSON.stringify(b) + ', obtenu ' + JSON.stringify(a) + ')'); }

// ---------- 1. Parseur ----------
const Parser = require('../talishar-parser.js');
const raw = fs.readFileSync(path.join(__dirname, 'fixture-sample.txt'), 'utf8');
const rec = Parser.parse(raw);

console.log('Parseur —');
eq(rec.myName, 'Ehecalt', 'identité: myName');
eq(rec.oppName, 'Opponent', 'identité: oppName');
eq(rec.matchup, 'Briar vs Briar', 'matchup (miroir)');
eq(rec.format, 'blitz', 'format');
eq(rec.vsAI, false, 'vsAI');
eq(rec.source.gameId, '908070', 'gameId depuis en-tête');
assert(rec.result && rec.result.iWon === true, 'result.iWon = true');
assert(rec.result && rec.result.byConcession === true, 'result.byConcession = true (abandon)');
eq(rec.warnings.length, 0, 'aucun warning (identité cohérente)');
assert(rec.endStats && rec.endStats.me, 'endStats.me présent');
eq(rec.endStats.me.firstPlayer, true, 'endStats.me.firstPlayer');
eq(rec.endStats.me.won, true, 'endStats.me.won');
eq(rec.endStats.me.cards.length, 3, 'endStats.me.cards (3 cartes)');
assert(rec.endStats.opp && rec.endStats.opp.cards.length === 1, 'endStats.opp présent');
eq(rec.timeline.durationSec, 180, 'durée globale (timestamps)');

// Reconnaissance de la destruction (équipement/carte) — utilisée par la Table.
const dEq = Parser.classifyLine('Helm of Might and Magic was destroyed and prevented 1 arcane damage.');
eq(dEq.type, 'destroyed', 'classifyLine: type destroyed');
eq(dEq.card, 'Helm of Might and Magic', 'classifyLine: nom de l\'équipement détruit');
eq(Parser.classifyLine('Lightning Surge was destroyed from the arsenal').type, 'destroyed', 'classifyLine: destroyed (arsenal) aussi capté');
eq(Parser.classifyLine('Nimblism was banished.').type !== 'destroyed', true, 'classifyLine: « banished » ≠ destroyed');

// Arsenal adverse : 0 forcé à l'ouverture ; null quand non capté (fixture sans bloc).
eq(rec.turns[0].oppArsenalCount, 0, 'arsenal adverse : 0 forcé à l\'ouverture');
const tPlay = rec.turns.find(t => t.turnNumber > 0);
if (tPlay) eq(tPlay.oppArsenalCount, null, 'arsenal adverse : null si non capté (bloc absent du log)');

// Découpage des tours : le format « Turn N<joueur> » (séparateur collé, certains
// rendus Talishar) doit être reconnu comme « X's turn N has begun. » — sinon le
// log tombe « sans tour » → 1 seul point sur la courbe, main de départ gonflée…
const divLog = '=== Talishar game 42 — test ===\n\nTurn 1nissy\nnissy played Look Tuff\nEhecalt took 5 damage\nTurn 1Ehecalt\nEhecalt played Lightning Surge\nnissy took 3 damage\nTurn 2nissy\nnissy played Crash Down\nEhecalt took 2 damage\n';
const divRec = Parser.parse(divLog);
assert(divRec.turns.length >= 3, 'format « Turn N joueur » : tours segmentés (>=3, pas 1)');
eq(divRec.lifeSeries.me.length, divRec.turns.length, 'courbe = 1 point par tour (fini le point unique)');
assert(divRec.turns.some(t => t.player === 'nissy') && divRec.turns.some(t => t.player === 'Ehecalt'), 'joueurs déduits des séparateurs « Turn N joueur »');
// Régression : le format habituel « has begun » reste reconnu.
const hbRec = Parser.parse('=== Talishar game 43 — test ===\n\nnissy\'s turn 1 has begun.\nnissy played X\nEhecalt\'s turn 1 has begun.\nEhecalt played Y\n');
assert(hbRec.turns.length >= 3, 'format « has begun » toujours segmenté (régression)');

// Diagnostic de santé (garde-fou anti-format-cassé) :
assert(rec.health && rec.health.ok === true, 'santé : fixture normale → ok');
assert(divRec.health.ok === true, 'santé : format « Turn N joueur » reconnu → ok');
// Format de tour INCONNU + beaucoup d'actions → doit être signalé (pas silencieux).
let broken = '=== Talishar game 44 — test ===\n\n';
for (let k = 0; k < 30; k++) broken += 'nissy played Card' + k + '\nEhecalt took 1 damage\n';
broken += 'ROUND 1 :: nissy\nnissy played Late\n';   // en-tête d'un format non géré
const brokenRec = Parser.parse(broken);
assert(brokenRec.health.ok === false, 'santé : format de tour inconnu + 25+ actions → signalé');
assert(brokenRec.health.issues.some(i => /tour/i.test(i)), 'santé : le message mentionne les tours');
// Duplication du journal → signalée (une carte jouée un nombre improbable de fois).
let dup = '=== Talishar game 45 — test ===\n\nnissy\'s turn 1 has begun.\n';
for (let k = 0; k < 8; k++) dup += 'nissy played Harness Lightning\n';
dup += 'Ehecalt\'s turn 1 has begun.\nEhecalt played Y\n';
assert(Parser.parse(dup).health.issues.some(i => /[Dd]uplication/.test(i)), 'santé : duplication du journal signalée');

// MIROIR (mêmes héros) : la ligne « X won! » est ambiguë (les 2 = « Aurora ») →
// on doit se fier aux stats officielles (numéro de joueur). Ici myPlayerID=1 et
// winner=2 → j'ai PERDU, malgré « Aurora (...) won! ».
const mirror = '=== Talishar game 47 — test ===\n\n' +
  "Aurora's turn 1 has begun.\nAurora played Nova\nAurora took 4 damage\nAurora's turn 2 has begun.\nAurora played Bolt\n" +
  'Aurora (moi) won! 🎉\n' +
  '\n=== META ===\nschema: v1\nme: moi\nopp_hero: Aurora\nmy_hero: Aurora (aurora)\nopp_hero: Aurora (aurora)\n' +
  '\n=== END GAME STATS (Talishar, JSON) ===\n' +
  '{"myPlayerID":1,"byPlayer":{"1":{"winner":2,"turns":2},"2":{"winner":2,"turns":2}}}\n';
const mRec = Parser.parse(mirror);
assert(mRec.result && mRec.result.iWon === false, 'miroir : défaite correctement détectée via stats officielles (pas « victoire » à tort)');
// Sans stats officielles, on retombe sur la ligne « won! » (comportement hérité).
const noEs = Parser.parse('=== Talishar game 48 — test ===\n\nEhecalt\'s turn 1 has begun.\nEhecalt played X\nnissy\'s turn 1 has begun.\nnissy played Y\nEhecalt (u) won! 🎉\n\n=== META ===\nme: Ehecalt\n');
assert(noEs.result && noEs.result.iWon === true, 'sans stats officielles : résultat déduit de la ligne « won! » (régression)');

// COMBAT CHAIN : attaque effective (buffs) parsée, rattachée au tour, sans polluer.
const withChain = '=== Talishar game 49 — test ===\n\n' +
  "Ehecalt's turn 1 has begun.\nEhecalt played Fry\nnissy took 6 damage\nCombat resolved with a hit for 6 damage\n" +
  '\n=== META ===\nme: Ehecalt\n' +
  '\n=== COMBAT CHAIN (attaque/défense effectives, buffs compris) ===\n' +
  JSON.stringify({ turn: 'Ehecalt#1', card: 'Fry', power: 6, defense: 0, prevent: 0, target: 'nissy', kw: ['goAgain'] }) + '\n';
const chRec = Parser.parse(withChain);
assert(Array.isArray(chRec.chain) && chRec.chain.length === 1 && chRec.chain[0].power === 6, 'chain : lien parsé (power effectif 6)');
const chT1 = chRec.turns.find(t => t.turnNumber === 1);
assert(chT1 && chT1.chain && chT1.chain.length === 1, 'chain : rattaché au bon tour');
assert(chRec.health.ok === true && !chT1.events.some(e => e.card === 'Fry' && e.type === 'played' && e.power), 'chain : bloc n\'a pas pollué les événements');

// RAW CHATLOG : bloc verbatim retiré du corps (ne pollue PAS les événements) et exposé.
const withRaw = '=== Talishar game 46 — test ===\n\n' +
  "nissy's turn 1 has begun.\nnissy played Look Tuff\nEhecalt took 3 damage\nEhecalt's turn 1 has begun.\nEhecalt played Y\n" +
  '\n=== RAW CHATLOG (state.game.chatLog, verbatim) ===\n' +
  JSON.stringify(['Player 1 played A', 'Player 1 played A', 'Player 1 played A', 'Player 1 played A', 'Player 1 played A', 'Player 1 played A', 'Player 1 played A', '[[TURN_START:1:2]]']) + '\n';
const rawRec = Parser.parse(withRaw);
assert(rawRec.health.ok === true, 'RAW CHATLOG : le bloc verbatim ne pollue pas l\'analyse (santé ok)');
assert(Array.isArray(rawRec.rawChatLog) && rawRec.rawChatLog.length === 8, 'RAW CHATLOG : exposé et parsé (source pure conservée)');
assert(!rawRec.turns.some(t => (t.events || []).some(e => e.card === 'A')), 'RAW CHATLOG : « played A » du bloc brut n\'est pas compté comme événement');

// Miroir : la main ne doit PAS avoir été filtrée par les cartes adverses.
const t1 = rec.turns.find(t => t.player === 'Ehecalt' && t.turnNumber === 1);
assert(t1 && Array.isArray(t1.hand) && t1.hand.indexOf('Bloodrush Bellow') >= 0, 'main tour 1 conservée (miroir)');
// Arsenal d'ouverture forcé vide (règle FaB).
eq(rec.turns[0].arsenal.length, 0, 'arsenal ouverture vide');

// ---------- 2. Agrégation dashboard ----------
const Dashboard = require('../js/dashboard.js');
console.log('Dashboard —');

function mkRec(o) {
  return {
    result: { iWon: o.iWon },
    vsAI: !!o.ai,
    format: o.format || 'blitz',
    players: { me: { hero: o.myHero || 'Briar' }, opp: { hero: o.oppHero } },
    source: { capturedAt: o.date },
    endStats: o.first == null ? null : {
      me: {
        won: o.iWon, firstPlayer: o.first,
        cards: o.cards || [],
        averages: { dealtPerTurn: o.dpt || 5, threatenedPerTurn: 7, threatenedPerCard: 2.5, value: 3 },
        totals: { dealt: o.dealt || 10, threatened: 14, blocked: 3 }
      }, opp: null
    }
  };
}
const entries = [
  { gameId: 'g1', record: mkRec({ iWon: true, oppHero: 'Dorinthea', first: true, date: '2026-07-01T10:00:00Z', cards: [{ name: 'Brutal Assault', played: 2, blocked: 0, pitched: 0, timesHit: 1 }] }) },
  { gameId: 'g2', record: mkRec({ iWon: false, oppHero: 'Dorinthea', first: false, date: '2026-07-02T10:00:00Z', cards: [{ name: 'Brutal Assault', played: 1, blocked: 1, pitched: 0, timesHit: 0 }] }) },
  { gameId: 'g3', record: mkRec({ iWon: true, oppHero: 'Briar', first: true, date: '2026-07-03T10:00:00Z' }) },
  { gameId: 'g4', record: mkRec({ iWon: true, oppHero: 'Briar', first: false, date: '2026-07-04T10:00:00Z' }) },
  { gameId: 'gAI', record: mkRec({ iWon: false, oppHero: 'Kano', first: false, date: '2026-07-05T10:00:00Z', ai: true }) }
];

// IA exclue par défaut : 4 parties, 3 victoires → 75 %.
const agg = Dashboard.aggregate(entries, {});
eq(agg.global.games, 4, 'IA exclue par défaut (4 parties)');
eq(agg.global.wins, 3, 'victoires');
eq(agg.global.winrate, 75, 'winrate global 75%');

// IA incluse : 5 parties.
eq(Dashboard.aggregate(entries, { includeAI: true }).global.games, 5, 'IA incluse (5 parties)');

// Matchup Dorinthea : 2 parties, 1 victoire → 50 %.
const dor = agg.byMatchup.find(m => m.hero === 'Dorinthea');
assert(dor && dor.games === 2 && dor.winrate === 50, 'matchup Dorinthea 1-1 (50%)');
const bri = agg.byMatchup.find(m => m.hero === 'Briar');
assert(bri && bri.games === 2 && bri.winrate === 100, 'matchup Briar 2-0 (100%)');

// 1er vs 2e joueur : 1er = g1(V) g3(V) → 100% ; 2e = g2(D) g4(V) → 50%.
eq(agg.firstSecond.first.winrate, 100, 'winrate 1er joueur');
eq(agg.firstSecond.second.winrate, 50, 'winrate 2e joueur');

// Perf cartes agrégée : Brutal Assault joué 3 fois sur 2 parties.
const ba = agg.cardPerf.find(c => c.name === 'Brutal Assault');
assert(ba && ba.played === 3 && ba.games === 2, 'carte Brutal Assault agrégée (3 joués / 2 parties)');

// Régression perf cartes : compteurs en string + doublon dans une même partie.
// - played doit être SOMMÉ numériquement (3), pas concaténé ("0010000").
// - games doit compter les PARTIES distinctes (2), pas les entrées de cartes (3).
const cardBugEntries = [
  { gameId: 'c1', record: mkRec({ iWon: true, oppHero: 'Kano', first: true, date: '2026-07-01T10:00:00Z',
      cards: [ { name: 'Quick Succession', played: '0', pitched: '1' },
               { name: 'Quick Succession', played: '1', pitched: '0' } ] }) },
  { gameId: 'c2', record: mkRec({ iWon: true, oppHero: 'Kano', first: true, date: '2026-07-02T10:00:00Z',
      cards: [ { name: 'Quick Succession', played: '2', pitched: '0' } ] }) }
];
const qs = Dashboard.aggregate(cardBugEntries, {}).cardPerf.find(c => c.name === 'Quick Succession');
eq(qs && qs.played, 3, 'perf cartes : played sommé numériquement (pas de concaténation)');
eq(qs && qs.games, 2, 'perf cartes : games = parties distinctes (pas entrées de cartes)');

// Filtre héros adverse.
eq(Dashboard.aggregate(entries, { oppHero: 'Briar' }).global.games, 2, 'filtre héros adverse');

// Filtre « mon héros » + facette myHeroes.
const meEntries = [
  { gameId: 'm1', record: mkRec({ iWon: true, myHero: 'Briar', oppHero: 'Kano', first: true, date: '2026-07-01T10:00:00Z' }) },
  { gameId: 'm2', record: mkRec({ iWon: false, myHero: 'Dorinthea', oppHero: 'Kano', first: false, date: '2026-07-02T10:00:00Z' }) }
];
const aggMe = Dashboard.aggregate(meEntries, {});
assert(aggMe.facets.myHeroes.length === 2 && aggMe.facets.myHeroes.indexOf('Dorinthea') >= 0, 'facette « mes héros » (2 valeurs)');
eq(Dashboard.aggregate(meEntries, { myHero: 'Briar' }).global.games, 1, 'filtre « mon héros »');

// Winrate par héros joué (« tes decks »).
const briHero = aggMe.byMyHero.find(h => h.hero === 'Briar');
const dorHero = aggMe.byMyHero.find(h => h.hero === 'Dorinthea');
assert(briHero && briHero.games === 1 && briHero.winrate === 100, 'byMyHero Briar 1-0 (100%)');
assert(dorHero && dorHero.games === 1 && dorHero.winrate === 0, 'byMyHero Dorinthea 0-1 (0%)');

// 1er/2e joueur détaillé par matchup : Dorinthea → g1 1er(V), g2 2e(D).
const dorMu = agg.byMatchup.find(m => m.hero === 'Dorinthea');
assert(dorMu && dorMu.first.games === 1 && dorMu.first.winrate === 100, 'byMatchup Dorinthea 1er : 1-0 (100%)');
assert(dorMu && dorMu.second.games === 1 && dorMu.second.winrate === 0, 'byMatchup Dorinthea 2e : 0-1 (0%)');
// 1er/2e par héros joué : Briar joué 4 fois → 1er g1,g3 (2-0), 2e g2,g4 (1-1 → 50%).
const briMy = agg.byMyHero.find(h => h.hero === 'Briar');
assert(briMy && briMy.first.winrate === 100 && briMy.second.winrate === 50, 'byMyHero Briar 1er 100% / 2e 50%');

// Meilleurs / pires matchups : Briar (2-0, 100%) devant Dorinthea (1-1, 50%).
// Briar 2-0 (100%) est favorable ; Dorinthea est à 50 % (ni l'un ni l'autre),
// donc « pires » est vide ici.
assert(agg.bestMatchups[0].hero === 'Briar', 'meilleur matchup = Briar (100%)');
eq(agg.worstMatchups.length, 0, 'aucun pire matchup (pas de matchup < 50%)');

// Régression : un matchup à 100 % ne doit JAMAIS apparaître dans les pires.
// Seuls > 50 % → meilleurs, < 50 % → pires ; un matchup à 50 % (Fai) n'est
// dans aucune des deux colonnes.
const bwEntries = [
  { gameId: 'w1', record: mkRec({ iWon: true,  oppHero: 'Lexi', first: true,  date: '2026-07-01T10:00:00Z' }) },
  { gameId: 'w2', record: mkRec({ iWon: true,  oppHero: 'Lexi', first: false, date: '2026-07-02T10:00:00Z' }) },
  { gameId: 'w3', record: mkRec({ iWon: false, oppHero: 'Kano', first: true,  date: '2026-07-03T10:00:00Z' }) },
  { gameId: 'w4', record: mkRec({ iWon: false, oppHero: 'Kano', first: false, date: '2026-07-04T10:00:00Z' }) },
  { gameId: 'w5', record: mkRec({ iWon: true,  oppHero: 'Fai',  first: true,  date: '2026-07-05T10:00:00Z' }) },
  { gameId: 'w6', record: mkRec({ iWon: false, oppHero: 'Fai',  first: false, date: '2026-07-06T10:00:00Z' }) }
];
const bwAgg = Dashboard.aggregate(bwEntries, {});
assert(bwAgg.bestMatchups.length === 1 && bwAgg.bestMatchups[0].hero === 'Lexi', 'meilleur = Lexi (100%)');
assert(bwAgg.worstMatchups.length === 1 && bwAgg.worstMatchups[0].hero === 'Kano', 'pire = Kano (0%)');
assert(!bwAgg.worstMatchups.some(m => m.winrate >= 50), 'aucun matchup ≥ 50% dans les pires (régression Lexi)');
assert(!bwAgg.bestMatchups.concat(bwAgg.worstMatchups).some(m => m.hero === 'Fai'), 'matchup à 50% (Fai) dans aucune colonne');

// Cartes en victoire vs défaite : Brutal Assault en V (g1) et en D (g2) → 50%.
const baWL = agg.cardWinLoss.find(c => c.name === 'Brutal Assault');
assert(baWL && baWL.gamesWon === 1 && baWL.gamesLost === 1 && baWL.winrate === 50, 'carte V/D Brutal Assault 1V/1D (50%)');

// Tendance : un point par partie décidée (4 hors IA).
eq(agg.trend.length, 4, 'tendance : 4 points');

// ---------- Tags (métadonnées d'entrée, filtre dashboard) ----------
console.log('Tags —');
const tagEntries = [
  { gameId: 't1', tags: ['gone'],  record: mkRec({ iWon: true,  oppHero: 'Kano', first: true,  date: '2026-07-01T10:00:00Z' }) },
  { gameId: 't2', tags: ['Gone'],  record: mkRec({ iWon: false, oppHero: 'Kano', first: false, date: '2026-07-02T10:00:00Z' }) },
  { gameId: 't3', tags: ['spell'], record: mkRec({ iWon: true,  oppHero: 'Kano', first: true,  date: '2026-07-03T10:00:00Z' }) },
  { gameId: 't4',                  record: mkRec({ iWon: true,  oppHero: 'Kano', first: true,  date: '2026-07-04T10:00:00Z' }) }
];
const tagAll = Dashboard.aggregate(tagEntries, {});
eq(tagAll.global.games, 4, 'tags: sans filtre → 4 parties');
// Facette : « gone » (dédup insensible casse) + « spell » = 2 tags.
eq(tagAll.facets.tags.length, 2, 'facette tags dédupliquée (2)');
// Filtre tag « gone » insensible à la casse → t1 + t2 (1 victoire sur 2).
const goneAgg = Dashboard.aggregate(tagEntries, { tag: 'gone' });
eq(goneAgg.global.games, 2, 'filtre tag « gone » (insensible casse) → 2 parties');
eq(goneAgg.global.wins, 1, 'filtre tag « gone » → 1 victoire');
eq(Dashboard.aggregate(tagEntries, { tag: 'spell' }).global.games, 1, 'filtre tag « spell » → 1 partie');
eq(Dashboard.aggregate(tagEntries, { tag: 'inexistant' }).global.games, 0, 'filtre tag inconnu → 0 partie');

// ---------- Carrousel : le filtre format restreint la liste des héros joués ----------
// (byMyHero alimente le carrousel ; la facette formats doit rester complète.)
console.log('Carrousel/format —');
const fmtHeroEntries = [
  { gameId: 'f1', record: mkRec({ iWon: true, myHero: 'Briar',     oppHero: 'Kano', first: true, date: '2026-07-01T10:00:00Z', format: 'blitz' }) },
  { gameId: 'f2', record: mkRec({ iWon: true, myHero: 'Dorinthea', oppHero: 'Kano', first: true, date: '2026-07-02T10:00:00Z', format: 'cc' }) }
];
const ccAgg = Dashboard.aggregate(fmtHeroEntries, { format: 'cc' });
const ccHeroes = ccAgg.byMyHero.filter(m => m.hero !== '(inconnu)');
assert(ccHeroes.length === 1 && ccHeroes[0].hero === 'Dorinthea', 'byMyHero restreint au format (Briar exclu en cc)');
eq(ccAgg.facets.formats.length, 2, 'facette formats complète malgré le filtre (blitz + cc)');

// ---------- Board replay : équipement détruit retiré du plateau ----------
console.log('Board replay —');
const BR = require('../js/boardreplay.js');
const eqGame = {
  myName: 'Me', oppName: 'Opp',
  players: {
    me: { hero: 'Oscilio', equipment: { head: { name: 'Helm of Might and Magic' } } },
    opp: { hero: 'Kano', equipment: { arms: { name: 'Claw of Vynserakai' } } }
  },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: ['Card A'], arsenal: [], events: [
      { type: 'played', player: 'Me', card: 'Card A' },
      { type: 'destroyed', card: 'Helm of Might and Magic', detail: 'and prevented 1 arcane damage' },
      { type: 'combatResult', hit: false }
    ] }
  ]
};
const eqTl = BR.buildTimeline(eqGame);
const eqLast = eqTl.steps[eqTl.steps.length - 1];
assert(eqLast.state.meEquipGone.indexOf('helm of might and magic') >= 0, 'équipement détruit (moi) suivi dans l\'état final');
eq(eqLast.state.oppEquipGone.length, 0, 'équipement adverse intact (non retiré)');
eq(eqTl.steps[0].state.meEquipGone.length, 0, 'équipement présent avant sa destruction (bannière)');

// Fin de partie hors combat (dégâts d'arcane via activation) → étape terminale.
const winGame = {
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Bravo', equipment: {} } },
  lifeSeries: { me: [40], opp: [3] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], events: [
      { type: 'activated', player: 'Me', card: 'Volzar, Meteor Storm' },
      { type: 'damageTaken', player: 'Opp', amount: 3 },
      { type: 'gameWon', player: 'Me' }
    ] }
  ]
};
const winLast = BR.buildTimeline(winGame).steps.slice(-1)[0];
eq(winLast.stage.type, 'end', 'étape terminale de victoire poussée');
assert(/gagne/.test(winLast.stage.big) && /Oscilio/.test(winLast.stage.big), 'bannière de victoire nomme le vainqueur');
assert(/coup fatal\s*:\s*Volzar/.test(winLast.stage.sub), 'coup fatal = dernière action (Volzar)');
assert(/Bravo 0 PV/.test(winLast.stage.sub), 'perdant affiché à 0 PV');

// Équipement activé → marqué « utilisé » ce tour, réarmé au tour suivant.
const usedGame = {
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Oscilio', equipment: { legs: { name: 'Lightning Greaves' } } }, opp: { hero: 'Bravo', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], events: [ { type: 'activated', player: 'Me', card: 'Lightning Greaves' } ] },
    { player: 'Opp', label: 'Opp — Tour 2', hand: [], arsenal: [], events: [ { type: 'played', player: 'Opp', card: 'Some Attack' }, { type: 'combatResult', hit: false } ] }
  ]
};
const usedTl = BR.buildTimeline(usedGame);
assert(usedTl.steps.some(s => (s.state.meEquipUsed || []).indexOf('lightning greaves') >= 0), 'équipement activé marqué « utilisé » ce tour');
eq(usedTl.steps[usedTl.steps.length - 1].state.meEquipUsed.length, 0, '« utilisé » réarmé au tour suivant');

// Arme activée → NON grisée (exclue du « utilisé »).
const wpnTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Oscilio', equipment: { weaponL: { name: 'Anothos' } } }, opp: { hero: 'Bravo', equipment: {} } },
  lifeSeries: { me: [40], opp: [40] },
  turns: [ { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], events: [ { type: 'activated', player: 'Me', card: 'Anothos' } ] } ]
});
assert(wpnTl.steps.every(s => (s.state.meEquipUsed || []).indexOf('anothos') < 0), 'arme activée NON grisée');

// Détection AUTO d'un équipement détruit via le cimetière (sans liste de cartes) :
// une pièce qui apparaît au cimetière est retirée du plateau (ex. Crown de bloc).
const crownTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Oscilio', equipment: { head: { name: 'Crown of Providence' } } }, opp: { hero: 'Bravo', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: 'Opp', label: 'Opp — Tour 1', hand: [], arsenal: [], grave: { me: [], opp: [] }, events: [ { type: 'played', player: 'Opp', card: 'Big Attack' }, { type: 'blocked', player: 'Me', cards: ['Crown of Providence'] }, { type: 'combatResult', hit: false } ] },
    { player: 'Me', label: 'Me — Tour 2', hand: [], arsenal: [], grave: { me: ['Crown of Providence'], opp: [] }, events: [ { type: 'played', player: 'Me', card: 'Whatever' }, { type: 'combatResult', hit: false } ] }
  ]
});
assert(crownTl.steps[0].state.meEquipGone.indexOf('crown of providence') < 0, 'Crown présente tant qu\'elle n\'est pas au cimetière (tour du bloc)');
assert(crownTl.steps[crownTl.steps.length - 1].state.meEquipGone.indexOf('crown of providence') >= 0, 'Crown retirée auto dès son apparition au cimetière (sans liste)');

// Détection auto vaut aussi pour le banni.
const banishTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'X', equipment: { legs: { name: 'Nullrune Boots' } } }, opp: { hero: 'Y', equipment: {} } },
  lifeSeries: { me: [40], opp: [40] },
  turns: [ { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], banish: { me: ['Nullrune Boots'], opp: [] }, events: [] } ]
});
assert(banishTl.steps.slice(-1)[0].state.meEquipGone.indexOf('nullrune boots') >= 0, 'équipement banni détecté comme retiré');

// Arsenal adverse — chemin CAPTÉ : le compte du tour fait autorité.
const arsCap = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'A', equipment: {} }, opp: { hero: 'B', equipment: {} } },
  lifeSeries: { me: [40], opp: [40] },
  turns: [ { player: 'Opp', label: 'Opp — Tour 1', hand: [], arsenal: [], oppArsenalCount: 1, events: [] } ]
});
eq(arsCap.steps.slice(-1)[0].state.oppArsenalCount, 1, 'arsenal adverse capté (compte du tour) affiché');

// Arsenal adverse — chemin INFÉRÉ (vieux log, pas de compte) : l'adversaire joue
// depuis l'arsenal → dos de carte affiché ce tour, puis vidé quand il la joue.
const arsInf = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'A', equipment: {} }, opp: { hero: 'B', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], events: [ { type: 'played', player: 'Me', card: 'X' }, { type: 'combatResult', hit: false } ] },
    { player: 'Opp', label: 'Opp — Tour 2', hand: [], arsenal: [], events: [ { type: 'played', player: 'Opp', card: 'Y', fromArsenal: true }, { type: 'combatResult', hit: false } ] }
  ]
});
assert(arsInf.steps.some(s => s.turn === 'B — Tour 2' && s.stage.type === 'banner' && s.state.oppArsenalCount === 1), 'arsenal adverse inféré : dos affiché au tour où il joue depuis l\'arsenal');
eq(arsInf.steps.slice(-1)[0].state.oppArsenalCount, 0, 'arsenal adverse inféré : vidé après la carte jouée');

// Attaque effective + renfort : un pump joué SUR l'attaque (ciblant la carte
// d'attaque) reste un renfort ; la VRAIE carte d'attaque reste l'attaquant, avec
// sa puissance effective (buffs). Pas de doublon en « carte seule ».
const pumpTl = BR.buildTimeline({
  myName: 'Ehecalt', oppName: 'nissy',
  players: { me: { hero: 'Aurora', equipment: {} }, opp: { hero: 'Riptide', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [ { player: 'Ehecalt', label: 'Ehecalt — Tour 1', hand: [], arsenal: [],
    chain: [{ turn: 'Ehecalt#1', card: 'Fry', power: 6, defense: 0, prevent: 0, target: 'nissy', kw: ['goAgain'] }],
    events: [
      { type: 'played', player: 'Ehecalt', card: 'Fry' },
      { type: 'played', player: 'Ehecalt', card: 'Lightning Press' },
      { type: 'targetedSecondary', owner: 'Ehecalt', card: 'Fry' },
      { type: 'damageTaken', player: 'nissy', amount: 6 },
      { type: 'combatResult', hit: true, amount: 6 }
    ] } ]
});
const pumpClash = pumpTl.steps.map(s => s.stage).find(st => st && st.type === 'clash');
eq(pumpClash.atk.nm, 'Fry', 'renfort : la vraie carte d\'attaque (Fry) reste l\'attaquant');
eq(pumpClash.atk.power, 6, 'renfort : puissance effective (6) portée par l\'attaque');
eq((pumpClash.pumps || []).map(p => p.nm).join(','), 'Lightning Press', 'renfort : le pump reste visible sous l\'attaque');
assert(pumpTl.steps.map(s => s.stage).filter(st => st && st.type === 'play').every(st => st.card.nm !== 'Fry'), 'renfort : pas de doublon (Fry pas aussi en carte seule)');

// Attaque à l'ARME (activation) + réaction d'attaque qui NE cible PAS l'attaque
// (ex. Tarantula Toxin sur Hunter's Klaive) : la chaîne de combat fait autorité →
// l'arme reste l'attaquant, la réaction est un renfort. Gère aussi l'apostrophe
// (« Hunter's Klaive » dans le log vs « Hunters Klaive » dans la chaîne).
const klvTl = BR.buildTimeline({
  myName: 'Ehecalt', oppName: 'nissy',
  players: { me: { hero: 'Arakni', equipment: { weaponL: { name: "Hunter's Klaive" } } }, opp: { hero: 'Riptide', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [ { player: 'Ehecalt', label: 'Ehecalt — Tour 1', hand: [], arsenal: [],
    chain: [{ turn: 'Ehecalt#1', card: 'Hunters Klaive', power: 4, defense: 0, kw: ['goAgain', 'piercing'] }],
    events: [
      { type: 'activated', player: 'Ehecalt', card: "Hunter's Klaive" },
      { type: 'played', player: 'Ehecalt', card: 'Tarantula Toxin' },
      { type: 'damageTaken', player: 'nissy', amount: 4 },
      { type: 'combatResult', hit: true, amount: 4 }
    ] } ]
});
const klvClash = klvTl.steps.map(s => s.stage).find(st => st && st.type === 'clash');
eq(klvClash.atk.nm, "Hunter's Klaive", 'arme : l\'arme activée reste l\'attaquant (pas la réaction)');
eq(klvClash.atk.power, 4, 'arme : puissance effective (4) sur l\'attaque');
eq((klvClash.pumps || []).map(p => p.nm).join(','), 'Tarantula Toxin', 'arme : la réaction non-ciblante est un renfort');
eq((klvClash.atk.kw || []).join(','), 'goAgain,piercing', 'arme : mots-clés (go again, piercing) portés');

// ---------- Grabber : fusion des instantanés de log (anti-duplication) ----------
console.log('Grabber merge —');
(function () {
  // On extrait la fonction PURE mergeLines du userscript (sans exécuter le boot
  // navigateur) et on la teste sur des séquences d'instantanés.
  const src = fs.readFileSync(path.join(__dirname, '..', 'talishar-log-grabber.user.js'), 'utf8');
  const start = src.indexOf('function mergeLines');
  const braceStart = src.indexOf('{', start);
  let depth = 0, end = braceStart;
  for (; end < src.length; end++) { const c = src[end]; if (c === '{') depth++; else if (c === '}' && --depth === 0) { end++; break; } }
  const mergeLines = eval('(' + src.slice(start, end) + ')');
  const run = seq => { let cap = []; seq.forEach(v => { cap = mergeLines(cap, v).lines; }); return cap; };

  // Démarrage à vide.
  eq(mergeLines([], ['a', 'b']).lines.join('|'), 'a|b', 'merge: captured vide → adopte visible');
  // Fenêtre glissante : queue(captured)==tête(visible) → n'ajoute que le suffixe.
  eq(mergeLines(['a', 'b', 'c'], ['b', 'c', 'd']).lines.join('|'), 'a|b|c|d', 'merge: fenêtre glissante');
  // Journal complet qui grandit par la fin (préfixe) → suffixe seulement.
  eq(mergeLines(['T', 'a', 'b'], ['T', 'a', 'b', 'c']).lines.join('|'), 'T|a|b|c', 'merge: journal complet étendu');
  // Contenu disjoint (après repli en tête) → ajout.
  eq(mergeLines(['T', 'a'], ['U', 'b']).lines.join('|'), 'T|a|U|b', 'merge: contenu disjoint ajouté');

  // ANTI-DUPLICATION (le bug) : re-rendu du MÊME journal complet à répétition
  // ne doit PAS empiler des doublons.
  const full1 = ['Ehe passed', 'Turn 1nissy', 'nissy played Look Tuff'];
  const full2 = full1.concat(['Ehe blocked with Static Shock']);
  eq(run([full1, full2, full2, full2, full1, full2]).join('|'), full2.join('|'),
    'merge: re-rendus complets répétés → aucun doublon (journal = 1 seule copie)');
  // Re-rendu identique répété : longueur stable.
  eq(run([full2, full2, full2]).length, full2.length, 'merge: re-rendu identique → longueur stable');

  // ── chatLogToLines : journal structuré (state.game.chatLog) → format parseur.
  // Dépendances de la fonction (référencées par clôture lexicale à l'eval).
  const TURN_START_RE = /\[\[TURN_START:(\d+):(\d+)\]\]/;
  const stripHtmlText = x => String(x == null ? '' : x).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const cl0 = src.indexOf('function chatLogToLines');
  const clbs = src.indexOf('{', cl0);
  let cd = 0, cl1 = clbs;
  for (; cl1 < src.length; cl1++) { const c = src[cl1]; if (c === '{') cd++; else if (c === '}' && --cd === 0) { cl1++; break; } }
  const chatLogToLines = eval('(' + src.slice(cl0, cl1) + ')');

  // Échantillon réel (diag replay Oscilio vs Briar) : HTML, marqueurs de tour,
  // « Player N », ligne de victoire, entrée vide.
  const rawChat = [
    "<span style='color:#cb0202;'>Player 1 activated <b>Oscilio</b></span>",
    "Player 1 played <b>Nucleus Aetherbolt</b>",
    "Player 2's Briar was targeted",
    "Player 2 took 3 damage",
    "[[TURN_START:1:2]]",
    "Player 2 played Nimblism",
    "[[TURN_START:1:1]]",
    "Player 1 (-) won! 🎉",
    ""
  ];
  const lines = chatLogToLines(rawChat, 'Oscilio', 'Briar');
  eq(lines[0], 'Oscilio activated Oscilio', 'chatLog: HTML retiré + Player 1→héros');
  eq(lines[1], 'Oscilio played Nucleus Aetherbolt', 'chatLog: play mappé');
  eq(lines[3], 'Briar took 3 damage', 'chatLog: dégâts Player 2→héros');
  eq(lines[4], "Briar's turn 1 has begun.", 'chatLog: TURN_START:1:2 → en-tête Briar');
  eq(lines[6], "Oscilio's turn 1 has begun.", 'chatLog: TURN_START:1:1 → en-tête Oscilio');
  eq(lines[7], 'Oscilio (-) won! 🎉', 'chatLog: ligne de victoire mappée');
  eq(lines.length, 8, 'chatLog: entrée vide ignorée');
  eq(chatLogToLines('pas un tableau', 'A', 'B').length, 0, 'chatLog: entrée non-tableau → []');

  // Les en-têtes produits sont bien reconnus par le parseur (mêmes regex).
  const thRe = /^(.+?)'s turn (\d+) has begun\.$/;
  eq(thRe.test(lines[4]), true, 'chatLog: en-tête compatible turnHeaderRe du parseur');

  // Intégration : re-rendus complets répétés du chatLog (comme en live) → aucun
  // doublon via merge (le vrai correctif de la duplication).
  const g1 = chatLogToLines(rawChat.slice(0, 6), 'Oscilio', 'Briar');
  const g2 = chatLogToLines(rawChat, 'Oscilio', 'Briar');
  eq(run([g1, g2, g2, g1, g2]).join('\n'), g2.join('\n'),
    'chatLog+merge: journaux complets répétés → une seule copie');
})();

// ---------- 3. Clé DB ----------
const DB = require('../js/db.js').FabDB;
console.log('DB —');
eq(DB.keyFor(rec, raw), '908070', 'clé DB = gameId');
eq(DB.keyFor({ source: {} }, 'abc'), DB.keyFor({ source: {} }, 'abc'), 'clé de repli déterministe');

// normalizeTags : trim, dédup insensible à la casse (1ʳᵉ graphie gardée), tolérant.
eq(DB.normalizeTags(['  gone ', 'gone', 'GONE', 'spell']).join(','), 'gone,spell', 'normalizeTags: trim + dédup casse');
eq(DB.normalizeTags('mono').length, 1, 'normalizeTags: chaîne unique → 1 tag');
eq(DB.normalizeTags(null).length, 0, 'normalizeTags: null → []');
eq(DB.normalizeTags(['', '   ']).length, 0, 'normalizeTags: entrées vides ignorées');
assert(typeof DB.setMeta === 'function', 'DB.setMeta exposé');

// ---------- 4. Export / Import (sauvegarde multi-appareils) ----------
console.log('Export/Import —');
const backup = DB.buildExport([{ gameId: '908070', record: rec, raw }]);
eq(backup.kind, 'library', 'enveloppe: kind');
eq(backup.version, 1, 'enveloppe: version');
eq(backup.count, 1, 'enveloppe: count');
assert(Array.isArray(backup.games) && backup.games.length === 1, 'enveloppe: games[]');

// Réimport d'une enveloppe complète → entrée conservée telle quelle.
const roundtrip = DB.normalizeImport(backup);
eq(roundtrip.length, 1, 'normalize: enveloppe → 1 entrée');
eq(roundtrip[0].gameId, '908070', 'normalize: gameId préservé');

// Tolérance : tableau brut, entrée nue {record}, entrées invalides ignorées.
eq(DB.normalizeImport([{ gameId: 'x', record: rec }]).length, 1, 'normalize: tableau brut');
const nu = DB.normalizeImport({ record: rec, raw });
eq(nu.length, 1, 'normalize: {record} nu reconstruit');
eq(nu[0].gameId, '908070', 'normalize: gameId dérivé du record');
eq(DB.normalizeImport({ games: [{}, { foo: 1 }, null] }).length, 0, 'normalize: entrées sans record ignorées');
eq(DB.normalizeImport(null).length, 0, 'normalize: entrée nulle → []');

// ---------- 5. Couche de synchro (chargement + API) ----------
console.log('Sync —');
const Sync = require('../js/sync.js').FabSync;
['detectRepo', 'pull', 'push', 'getToken', 'setToken', 'clearToken', 'hasToken', 'canWrite', 'verifyToken']
  .forEach(fn => assert(typeof Sync[fn] === 'function', 'FabSync.' + fn + ' exposé'));

// ---------- Bilan ----------
console.log('\n' + passed + ' assertions OK, ' + failed + ' échec(s).');
process.exit(failed ? 1 : 0);
