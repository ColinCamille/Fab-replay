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

// normName : tiret ≡ espace (« Under the Trap-Door » log vs « Under The Trap
// Door » repli DOM du grabber, qui perd le tiret) — sans ça, main dupliquée.
eq(Parser.normName('Under the Trap-Door'), Parser.normName('Under The Trap Door'), 'normName: tiret ≡ espace');
eq(Parser.normName('Orb-Weaver Spinneret'), 'orb weaver spinneret', 'normName: tiret replié en espace');

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

// Séparateur DOM EN MAJUSCULES + espace (« TURN 1 your opponent ») : l'UI
// Talishar rend le libellé de tour en capitales (text-transform → innerText) sur
// une capture en repli DOM. Sans reconnaissance, l'envoi était bloqué et le log
// tombait « sans tour » (cf. game 1977204). Doit se segmenter comme les autres.
const upLog = '=== Talishar game 46 — test ===\n\n'
  + 'you played Aethersling\n'   // ouverture : le joueur local agit d'abord (comme les vrais logs)
  + 'TURN 1 your opponent\nyour opponent played Unsheathed\nyou took 0 damage\n'
  + 'TURN 1 you\nyou played Sink Below\nyour opponent took 4 damage\n'
  + 'TURN 2 your opponent\nyour opponent played Slice and Dice\nyou took 2 damage\n';
const upRec = Parser.parse(upLog);
assert(upRec.turns.length >= 3, 'format MAJUSCULE « TURN N joueur » : tours segmentés (>=3, pas 1)');
assert(upRec.turns.some(t => t.player === 'you') && upRec.turns.some(t => t.player === 'your opponent'), 'joueurs déduits des séparateurs MAJUSCULE');
assert(upRec.health.ok === true, 'santé : format MAJUSCULE reconnu → ok (partie gardée)');

// Repli héros : capture dégradée SANS bloc META (« you / your opponent »). Les
// héros se déduisent du corps du log = la carte la plus CIBLÉE par camp
// (possessif « your opponent's X was targeted » pour l'adversaire ; 🎯 rattaché
// à l'acteur adverse pour moi). Rétablit le matchup au dashboard.
let heroLog = '=== Talishar game 47 — test ===\n\n';
for (let k = 0; k < 4; k++) {
  heroLog += 'your opponent activated Cintari Saber\n';                         // acteur = adversaire
  heroLog += '🎯Oscilio, Constella Intelligence was chosen as the target.\n';    // → cible = MON héros
  heroLog += 'you activated Oscilio, Constella Intelligence\n';                 // acteur = moi
  heroLog += "your opponent's Kassai of the Golden Sand was targeted\n";        // possessif → héros ADVERSE
}
const heroRec = Parser.parse(heroLog);
eq(heroRec.players.me.hero, 'Oscilio, Constella Intelligence', 'déduction héros : mon héros (le plus 🎯 ciblé)');
eq(heroRec.players.opp.hero, 'Kassai of the Golden Sand', 'déduction héros : héros adverse (possessif « was targeted »)');
assert(heroRec.matchup && /Oscilio.*vs.*Kassai/.test(heroRec.matchup), 'déduction héros : matchup reconstruit');
// Garde-fou : preuve insuffisante (1 seul ciblage) → héros reste inconnu (null),
// pas de faux héros posé « au cas où » (règle « pas de théâtre d'erreur »).
const weakRec = Parser.parse('=== Talishar game 48 — test ===\n\nyou played Aethersling\nyour opponent\'s Kassai of the Golden Sand was targeted\n\n=== META ===\nme: (non capté)\nopponent: Somebody\n');
eq(weakRec.players.opp.hero, null, 'déduction héros : sous le seuil (1 ciblage) → reste inconnu');

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

// Couleur/impression exacte des cartes (rouge/jaune/bleu) depuis le chatLog brut.
// Cas clé : la MÊME carte jouée en deux couleurs différentes dans la même partie
// → distinguée par occurrence (impossible avec un simple agrégat).
const sd = (id, nm) => "<span onmouseover=\"ShowDetail(event,'./WebpImages/" + id + ".webp')\">" + nm + "</span>";
const colorRaw = [
  'Player 1 played ' + sd('scar_for_a_scar_red', 'Scar for a Scar'),
  'Player 1 played ' + sd('lightning_press_red', 'Lightning Press'),
  'Player 1 pitched ' + sd('sink_below_blue', 'Sink Below'),
  'Player 1 played ' + sd('sink_below_yellow', 'Sink Below'),
  'Player 1 blocked with ' + sd('unmovable_red', 'Unmovable') + ', ' + sd('sink_below_red', 'Sink Below')
];
const withColor = '=== Talishar game 50 — test ===\n\n' +
  "Ehecalt's turn 1 has begun.\n" +
  'Ehecalt played Scar for a Scar\nEhecalt played Lightning Press\nEhecalt pitched Sink Below\nEhecalt played Sink Below\nEhecalt blocked with Unmovable, Sink Below\n' +
  '\n=== RAW CHATLOG (state.game.chatLog, verbatim) ===\n' + JSON.stringify(colorRaw) + '\n';
const colRec = Parser.parse(withColor);
const colEvs = [];
colRec.turns.forEach(t => (t.events || []).forEach(e => colEvs.push(e)));
const evScar = colEvs.find(e => e.type === 'played' && e.card === 'Scar for a Scar');
assert(evScar && evScar.cardId === 'scar_for_a_scar_red' && evScar.pitch === 1, 'couleur : Scar for a Scar → rouge (pitch 1)');
const evPitchSink = colEvs.find(e => e.type === 'pitched' && e.card === 'Sink Below');
assert(evPitchSink && evPitchSink.pitch === 3, 'couleur : Sink Below PITCHÉ → bleu (pitch 3)');
const evPlaySink = colEvs.find(e => e.type === 'played' && e.card === 'Sink Below');
assert(evPlaySink && evPlaySink.pitch === 2, 'couleur : Sink Below JOUÉ ensuite → jaune (pitch 2) — désambiguïsation par occurrence');
const evBlock = colEvs.find(e => e.type === 'blocked');
assert(evBlock && Array.isArray(evBlock.pitches) && evBlock.pitches[0] === 1 && evBlock.pitches[1] === 1, 'couleur : blocs (défense) colorés par carte (Unmovable rouge, Sink Below rouge)');
assert(Parser.pitchFromCardId('x_yellow') === 2 && Parser.pitchFromCardId('wrenchtastic') === null, 'couleur : pitchFromCardId (suffixe → pitch, mono-impression → null)');
assert(colRec.colorCoverageFromTurn === 0, 'couleur : chatLog complet → couverture couleur dès le début (fromTurn 0)');

// Garde-fou TRONCATURE couleur (game 2007166) : sur une longue partie le chatLog
// brut de Talishar est un tampon borné qui NE contient que les derniers tours,
// alors que le journal texte (recousu par le grabber) couvre toute la partie. Un
// simple FIFO collerait les couleurs des tours tardifs sur les premiers tours
// (Meteoric Impact rouge affiché en bleu). On ne colore donc QUE les tours
// réellement présents dans le chatLog brut ; avant, aucune couleur (pas de fausse).
const truncColorRaw = [
  '[[TURN_START:3:1]]',
  'Player 1 played ' + sd('meteoric_impact_blue', 'Meteoric Impact')   // tour 3 : bleu (le seul couvert)
];
const truncColor = '=== Talishar game 51 — test ===\n\n' +
  "Ehecalt's turn 1 has begun.\nEhecalt played Meteoric Impact\n" +          // tour 1 : rouge en vrai, MAIS hors fenêtre chatLog
  "Ehecalt's turn 2 has begun.\nEhecalt passed\n" +
  "Ehecalt's turn 3 has begun.\nEhecalt played Meteoric Impact\n" +          // tour 3 : couvert → bleu
  '\n=== RAW CHATLOG (state.game.chatLog, verbatim) ===\n' + JSON.stringify(truncColorRaw) + '\n';
const truncColRec = Parser.parse(truncColor);
assert(truncColRec.colorCoverageFromTurn === 3, 'couleur tronquée : couverture repérée au tour 3 (chatLog démarre à [[TURN_START:3]])');
const tcEvs = [];
truncColRec.turns.forEach(t => (t.events || []).forEach(e => { if (e.type === 'played' && e.card === 'Meteoric Impact') tcEvs.push({ turn: t.turnNumber, id: e.cardId }); }));
const tcT1 = tcEvs.find(e => e.turn === 1), tcT3 = tcEvs.find(e => e.turn === 3);
assert(tcT1 && tcT1.id == null, 'couleur tronquée : le tour 1 (hors fenêtre) N\'est PAS coloré (pas de fausse couleur bleue)');
assert(tcT3 && tcT3.id === 'meteoric_impact_blue', 'couleur tronquée : le tour 3 (couvert) est coloré correctement (bleu)');

// Contre-épreuve (ce que produit le grabber v1.25 recousu) : un chatLog brut
// COMPLET démarrant au tour 1 → couverture pleine (fromTurn 0), la carte du tour 1
// est bien coloriée malgré la même carte rejouée en une autre couleur au tour 3.
const fullColorRaw = [
  '[[TURN_START:1:1]]',
  'Player 1 played ' + sd('meteoric_impact_red', 'Meteoric Impact'),        // tour 1 : rouge
  '[[TURN_START:3:1]]',
  'Player 1 played ' + sd('meteoric_impact_blue', 'Meteoric Impact')         // tour 3 : bleu
];
const fullColor = '=== Talishar game 52 — test ===\n\n' +
  "Ehecalt's turn 1 has begun.\nEhecalt played Meteoric Impact\n" +
  "Ehecalt's turn 2 has begun.\nEhecalt passed\n" +
  "Ehecalt's turn 3 has begun.\nEhecalt played Meteoric Impact\n" +
  '\n=== RAW CHATLOG (state.game.chatLog, verbatim) ===\n' + JSON.stringify(fullColorRaw) + '\n';
const fullColRec = Parser.parse(fullColor);
assert(fullColRec.colorCoverageFromTurn === 0, 'couleur complète : chatLog brut depuis le tour 1 → couverture pleine (fromTurn 0)');
const fcEvs = [];
fullColRec.turns.forEach(t => (t.events || []).forEach(e => { if (e.type === 'played' && e.card === 'Meteoric Impact') fcEvs.push({ turn: t.turnNumber, id: e.cardId }); }));
const fcT1 = fcEvs.find(e => e.turn === 1), fcT3 = fcEvs.find(e => e.turn === 3);
assert(fcT1 && fcT1.id === 'meteoric_impact_red', 'couleur complète : le tour 1 est colorié (rouge) car le brut le couvre');
assert(fcT3 && fcT3.id === 'meteoric_impact_blue', 'couleur complète : le tour 3 conserve sa couleur par occurrence (bleu)');

// ── Journal TRONQUÉ (tampon roulant Talishar, longue partie) ─────────────────
// Le corps du log DÉMARRE au tour 3 (les tours 1-2 ont défilé hors du tampon)
// avec une fin de tour orpheline en tête, MAIS les instantanés (main/vie/formes)
// couvrent les tours 1-3. Le parseur doit : détecter la troncature (record.truncated
// sans health.ok=false → partie gardée au dashboard), reconstruire les tours 1-2,
// déplacer la fin orpheline hors de l'Ouverture, et NE PAS faire fuiter la main du
// tour 1 sur le tour 3 (bug d'origine : Sigil/Shelter en main au « tour 5 »).
console.log('Journal tronqué —');
const truncRaw = [
  '=== Talishar game 999 — 1/1/2026 ===',
  '',
  'Beta pitched Foo',                                    // fin orpheline du tour 2 (Alpha)
  'Alpha played Bolt',
  'Beta took 3 damage',
  'Alpha passed priority. Attempting to end turn.',
  "Beta's turn 3 has begun.",
  'Beta passed priority. Attempting to end turn.',
  "Alpha's turn 3 has begun.",
  'Alpha played Meteor',
  'Alpha pitched Ember',
  'Alpha passed priority. Attempting to end turn.',
  '',
  '=== HAND SNAPSHOTS (ta main) ===',
  '[OUVERTURE] Kindle, Snapback',
  '[Beta #1] Aaa, Bbb, Ccc',
  '[Alpha #1] Bbb, Ccc',
  '[Beta #2] Ddd, Eee',
  '[Alpha #2] Ddd, Eee',
  '[Beta #3] Meteor, Ember, Fff',
  '[Alpha #3] Meteor, Ember, Fff',
  '',
  '=== LIFE SNAPSHOTS (vie et deck : toi / adversaire) ===',
  '[OUVERTURE] me=40 opp=40 myDeck=60 oppDeck=60',
  '[Beta #1] me=40 opp=37 myDeck=59 oppDeck=60',
  '[Alpha #1] me=40 opp=37 myDeck=59 oppDeck=59',
  '[Beta #2] me=38 opp=37 myDeck=58 oppDeck=59',
  '[Alpha #2] me=38 opp=37 myDeck=58 oppDeck=58',
  '[Beta #3] me=38 opp=34 myDeck=57 oppDeck=58',
  '[Alpha #3] me=38 opp=34 myDeck=57 oppDeck=57',
  '',
  '=== HERO FORMS (forme du héros par tour : toi | adversaire) ===',
  '[OUVERTURE] me: Alpha | opp: Beta',
  '[Beta #1] me: Alpha | opp: Beta',
  '[Alpha #1] me: Alpha | opp: Beta',
  '[Beta #2] me: Alpha | opp: Beta',
  '[Alpha #2] me: Alpha | opp: Beta',
  '[Beta #3] me: Alpha | opp: Beta',
  '[Alpha #3] me: Alpha | opp: Beta',
  '',
  '=== META ===',
  'me: Alpha',
  ''
].join('\n');
const truncRec = Parser.parse(truncRaw);
assert(truncRec.truncated && truncRec.truncated.firstLoggedTurn === 3, 'tronqué : détecté, 1er tour loggé = 3');
eq(JSON.stringify(truncRec.truncated.missingTurns), '[1,2]', 'tronqué : tours manquants = [1,2]');
assert(truncRec.health.ok === true, 'tronqué : health.ok reste true (partie conservée au dashboard)');
assert(truncRec.warnings.some(w => /tronqué/i.test(w)), 'tronqué : un warning explicite est émis');
eq(truncRec.turns[0].events.length, 0, 'tronqué : l\'Ouverture ne contient plus la fin orpheline');
const t3Alpha = truncRec.turns.find(t => t.turnNumber === 3 && t.player === 'Alpha');
eq(JSON.stringify(t3Alpha.hand), '["Meteor","Ember","Fff"]', 'tronqué : main du tour 3 = instantané #3 (pas de fuite de la main du tour 1)');
const rBeta1 = truncRec.turns.find(t => t.turnNumber === 1 && t.player === 'Beta');
assert(rBeta1 && rBeta1.reconstructed && JSON.stringify(rBeta1.hand) === '["Aaa","Bbb","Ccc"]', 'tronqué : tour 1 reconstruit avec sa main d\'instantané');
const rAlpha2 = truncRec.turns.find(t => t.turnNumber === 2 && t.player === 'Alpha');
assert(rAlpha2 && rAlpha2.reconstructed && rAlpha2.truncatedTail && rAlpha2.events.length > 0, 'tronqué : la fin orpheline est rattachée au tour reconstruit (Alpha #2), marqué truncatedTail');
assert(truncRec.turns.filter(t => t.turnNumber > 0).every((t, i, a) => i === 0 || a[i - 1].turnNumber <= t.turnNumber), 'tronqué : tours dans l\'ordre chronologique');

// Miroir : la main ne doit PAS avoir été filtrée par les cartes adverses.
const t1 = rec.turns.find(t => t.player === 'Ehecalt' && t.turnNumber === 1);
assert(t1 && Array.isArray(t1.hand) && t1.hand.indexOf('Bloodrush Bellow') >= 0, 'main tour 1 conservée (miroir)');
// Arsenal d'ouverture forcé vide (règle FaB).
eq(rec.turns[0].arsenal.length, 0, 'arsenal ouverture vide');

// ── Identité me/opp : tours PAS inversés (game 2018099) ──────────────────────
// Deux régressions du même symptôme (« les tours sont inversés ») quand
// l'ADVERSAIRE agit en premier dans le journal (names[0] = adversaire) :
//   A. Aucun jet de dé, pas d'équipement exploitable → HERO FORMS (capture DOM
//      locale : « me » = joueur local) doit primer sur le repli names[0].
//   B. Équipement PARTAGÉ (Fyendal's Spring Tunic, joué par les DEUX camps) :
//      il ne doit plus faire passer le joueur local pour l'adversaire ; seule une
//      pièce PROPRE à un camp (Storm Striders) tranche.
console.log('Identité tours (game 2018099) —');
const invA = Parser.parse([
  '=== Talishar game 2018099A — 1/1/2026 ===', '',
  'Beta played Aggro Attack',                         // l'adversaire agit en 1er
  'Alpha blocked with Guard',
  'Beta passed priority. Attempting to end turn.',
  "Alpha's turn 1 has begun.",
  'Alpha played Meteor',
  'Alpha passed priority. Attempting to end turn.',
  "Beta's turn 1 has begun.",
  'Beta played Coalescence',
  'Beta passed priority. Attempting to end turn.', '',
  '=== HERO FORMS (forme du héros par tour : toi | adversaire) ===',
  '[OUVERTURE] me: Alpha | opp: Beta',
  '[Alpha #1] me: Alpha | opp: Beta',
  '[Beta #1] me: Alpha | opp: Beta', '',
  '=== META ===', 'me: LocalUser', 'opponent: RemoteUser', ''
].join('\n'));
eq(invA.myName, 'Alpha', 'HERO FORMS prime : myName = Alpha (pas names[0]=Beta)');
eq(invA.oppName, 'Beta', 'HERO FORMS prime : oppName = Beta');
// META « me: » = pseudo Talishar (pas un nom de héros) → PAS d'avertissement
// « grabber mal identifié » (faux positif écarté).
assert(!invA.warnings.some(w => /mal identifié les joueurs/.test(w)),
  'pas de faux avertissement quand META « me: » est un pseudo, pas un nom de joueur');
const invAturn = invA.turns.find(t => t.player === 'Alpha' && t.turnNumber === 1);
eq(invAturn && invAturn.side, 'me', 'HERO FORMS prime : le tour d\'Alpha est bien « me »');

const invB = Parser.parse([
  '=== Talishar game 2018099B — 1/1/2026 ===', '',
  'Beta played Aggro Attack',                         // l'adversaire agit en 1er
  'Alpha blocked with Guard',
  'Beta passed priority. Attempting to end turn.',
  "Alpha's turn 1 has begun.",
  "Alpha activated Fyendal's Spring Tunic",           // équipement PARTAGÉ → ignoré
  'Alpha activated Storm Striders',                    // équipement PROPRE → tranche
  'Alpha passed priority. Attempting to end turn.',
  "Beta's turn 1 has begun.",
  'Beta activated Reality Refractor',
  'Beta passed priority. Attempting to end turn.', '',
  '=== META ===', 'me: LocalUser', 'opponent: RemoteUser',
  'my_equipment: chest=Fyendals Spring Tunic (fyendals_spring_tunic) | legs=Storm Striders (storm_striders)',
  'opp_equipment: chest=Fyendals Spring Tunic (fyendals_spring_tunic) | weaponL=Reality Refractor (reality_refractor)', ''
].join('\n'));
eq(invB.myName, 'Alpha', 'équipement partagé ignoré : myName = Alpha (via Storm Striders)');
eq(invB.oppName, 'Beta', 'équipement partagé ignoré : oppName = Beta');

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
// Fidélité navigateur : boardreplay lit `root.TalisharParser.normName` (fusion des
// « // », tirets, apostrophes…). En Node il capte `root = self` AU CHARGEMENT — on
// câble donc `self.TalisharParser` LE TEMPS du require, sinon la normalisation
// retombe sur un simple lowercase et masque les régressions liées aux noms (ex.
// carte double-face « Comet Storm // Shock » vs instantané « Comet Storm  Shock »).
// On restaure aussitôt `self` : les autres modules (db, sync, replay…) exportent
// via `root === module.exports` et cassent si `self` reste défini pendant leur require.
const _prevSelf = global.self;
global.self = { TalisharParser: Parser, CardImages: {} };
const BR = require('../js/boardreplay.js');
if (_prevSelf === undefined) delete global.self; else global.self = _prevSelf;
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

// ── Compteurs d'ÉQUIPEMENT par tour (Tunic 1/2/3, -1 counters) ────────────────
// A. Parser : le bloc EQUIP COUNTERS est extrait, exposé et rattaché par tour.
const ctrRaw = [
  '=== Talishar game 900 — test ===', '',
  "Me's turn 1 has begun.", 'Me played Card A',
  "Opp's turn 2 has begun.", 'Opp played Card B',
  "Me's turn 3 has begun.", 'Me played Card C', '',
  '=== EQUIP COUNTERS (compteurs d\'équipement par tour : toi | adversaire) ===',
  '[Me #1] me: chest=1 | opp: (aucun)',
  '[Opp #2] me: chest=2 | opp: arms=-1',
  '[Me #3] me: chest=3, weaponR=-2 | opp: arms=-1', '',
  '=== META ===', 'me: Me', 'opp: Opp', ''
].join('\n');
const ctrRec = Parser.parse(ctrRaw);
assert(ctrRec.snapshots && ctrRec.snapshots.equipCounters, 'EQUIP COUNTERS : bloc exposé dans record.snapshots');
assert(ctrRec.health.ok === true, 'EQUIP COUNTERS : le bloc ne casse pas l\'analyse (santé ok)');
// Version de schéma bumpée (≥2) → déclenche le re-parse des parties déjà en cache
// (mergeCloudGames) pour propager les compteurs aux parties captées avant la MAJ.
assert(Parser.SCHEMA_VERSION >= 2, 'schéma : SCHEMA_VERSION bumpée (≥2) pour l\'ajout des compteurs');
eq(ctrRec.schemaVersion, Parser.SCHEMA_VERSION, 'schéma : le record porte la version courante');
const ctrT3 = ctrRec.turns.find(t => t.turnNumber === 3 && t.player === 'Me');
assert(ctrT3 && ctrT3.equipCounters && ctrT3.equipCounters.me.chest === 3, 'EQUIP COUNTERS : Tunic (chest) captée à 3 au tour 3');
eq(ctrT3.equipCounters.me.weaponR, -2, 'EQUIP COUNTERS : arme à -2 (counter négatif) au tour 3');
eq(ctrT3.equipCounters.opp.arms, -1, 'EQUIP COUNTERS : équipement adverse à -1');

// B. buildTimeline : la valeur du compteur remonte dans l'état de chaque étape.
const ctrTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: {
    me: { hero: 'Oscilio', equipment: { chest: { name: 'Fyendal\'s Spring Tunic' } } },
    opp: { hero: 'Bravo', equipment: { arms: { name: 'Ironrot Legs' } } }
  },
  lifeSeries: { me: [40, 40, 40], opp: [40, 40, 40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], equipCounters: { me: { chest: 1 }, opp: {} }, events: [ { type: 'played', player: 'Me', card: 'Card A' } ] },
    { player: 'Opp', label: 'Opp — Tour 2', hand: [], arsenal: [], equipCounters: { me: { chest: 2 }, opp: { arms: -1 } }, events: [ { type: 'played', player: 'Opp', card: 'Card B' }, { type: 'combatResult', hit: false } ] },
    { player: 'Me', label: 'Me — Tour 3', hand: [], arsenal: [], equipCounters: { me: { chest: 3 }, opp: { arms: -1 } }, events: [ { type: 'played', player: 'Me', card: 'Card C' } ] }
  ]
});
eq(ctrTl.steps[0].state.meEquipCounters.chest, 1, 'compteur : Tunic (chest) à 1 dès la 1re étape');
const ctrLast = ctrTl.steps[ctrTl.steps.length - 1];
eq(ctrLast.state.meEquipCounters.chest, 3, 'compteur : Tunic (chest) à 3 à la dernière étape');
eq(ctrLast.state.oppEquipCounters.arms, -1, 'compteur : équipement adverse à -1 suivi par étape');

// C. Rétro-compat : une partie SANS bloc (vieux log) → aucun compteur, pas d'erreur.
assert(eqTl.steps.every(s => s.state.meEquipCounters && Object.keys(s.state.meEquipCounters).length === 0
  && s.state.oppEquipCounters && Object.keys(s.state.oppEquipCounters).length === 0),
  'compteur : bloc absent (vieux log) → maps vides, aucune erreur');

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

// ---------- Dual-wield : 2 dagues identiques, une seule détruite (partie ZUP) ----------
// Bug réel : dual-wield (weaponL+weaponR, même nom affiché « Hunters Klaive »)
// détruit → le cimetière nomme la copie exacte avec son suffixe « R »
// (« Hunters Klaive R »). Avant le fix, tout était indexé par nom AFFICHÉ
// (stripé) → les 2 dagues partageaient la même clé, donc soit les 2 soit
// aucune disparaissaient jamais. Avec rawName (nom brut, avant strip), chaque
// copie a sa propre clé d'identité.
const dwRaw = [
  '=== Talishar game 1750692 — test ===', '',
  "Arakni Marionette activated Flick Knives",
  "Arakni Marionette's Hunter's Klaive was targeted",
  "Valda Seismic Impact's turn 1 has begun.",
  '', '=== META ===', 'me: Arakni Marionette', 'opp: Valda Seismic Impact',
  'my_equipment: weaponL=Hunters Klaive (hunters_klaive) | weaponR=Hunters Klaive R (hunters_klaive_r)',
  '', '=== GRAVEYARD SNAPSHOTS (cimetière : toi | adversaire) ===',
  '[OUVERTURE] me: (vide) | opp: (vide)',
  '[Valda Seismic Impact #1] me: Hunters Klaive R | opp: (vide)'
].join('\n');
const dwRec = Parser.parse(dwRaw);
eq(dwRec.players.me.equipment.weaponL.name, 'Hunters Klaive', 'dual-wield: weaponL nom affiché');
eq(dwRec.players.me.equipment.weaponR.name, 'Hunters Klaive', 'dual-wield: weaponR nom affiché (identique à weaponL)');
eq(dwRec.players.me.equipment.weaponR.rawName, 'Hunters Klaive R', 'dual-wield: weaponR garde son nom BRUT (avec « R »)');
eq(dwRec.players.me.equipment.weaponL.rawName, 'Hunters Klaive', 'dual-wield: weaponL sans suffixe → rawName = name');
const dwTl = BR.buildTimeline(dwRec);
const dwLast = dwTl.steps.slice(-1)[0].state;
assert(dwLast.meEquipGone.indexOf('hunters klaive r') >= 0, 'dual-wield: SEULE la copie détruite (weaponR) est marquée partie');
assert(dwLast.meEquipGone.indexOf('hunters klaive') < 0, 'dual-wield: la copie intacte (weaponL) n\'est PAS marquée partie (clé distincte)');

// ---------- Arme CRÉÉE en jeu (ex. Graphene Chelicera, pouvoir Arakni Orb-Weaver) ----------
// Absente de l'équipement de départ (META) et des formes de héros connues, mais
// activée puis attaquante dans la COMBAT CHAIN (autoritaire, cf. CLAUDE.md §7)
// et jamais vue au cimetière → détectée comme arme créée, visible sur le
// plateau à partir de son activation.
const cwTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Arakni, Marionette', equipment: {} }, opp: { hero: 'Opp', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], grave: { me: [], opp: [] },
      heroForm: { me: 'Arakni, Orb-Weaver', opp: 'Opp' },
      chain: [{ turn: 'Me#1', card: 'Graphene Chelicera', power: 14, defense: 0, kw: ['goAgain'] }],
      events: [
        { type: 'activated', player: 'Me', card: 'Graphene Chelicera' },
        { type: 'damageTaken', player: 'Opp', amount: 14 },
        { type: 'combatResult', hit: true, amount: 14 }
      ] }
  ]
});
eq((cwTl.players.me.createdWeapons || []).map(w => w.name).join(','), 'Graphene Chelicera', 'arme créée : détectée (activée + attaquante de la chaîne + jamais au cimetière)');
const cwSteps = cwTl.steps;
assert(cwSteps[0].state.meBorn.indexOf('graphene chelicera') < 0, 'arme créée : absente du plateau AVANT son activation');
assert(cwSteps.slice(-1)[0].state.meBorn.indexOf('graphene chelicera') >= 0, 'arme créée : présente sur le plateau à partir de son activation');
// Une carte activée qui finit tout de même au cimetière (pas une arme
// permanente) n'est PAS détectée comme arme créée, même en attaquant via la
// chaîne — le passage au cimetière signale une carte à usage unique.
const gravedTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'X', equipment: {} }, opp: { hero: 'Y', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], grave: { me: ['One-Shot Trinket'], opp: [] },
      chain: [{ turn: 'Me#1', card: 'One-Shot Trinket', power: 9, defense: 0, kw: [] }],
      events: [
        { type: 'activated', player: 'Me', card: 'One-Shot Trinket' },
        { type: 'damageTaken', player: 'Opp', amount: 9 },
        { type: 'combatResult', hit: true, amount: 9 }
      ] }
  ]
});
eq((gravedTl.players.me.createdWeapons || []).length, 0, 'arme créée : une carte activée finissant au cimetière n\'est PAS une arme');
// Une carte simplement PLAYED (jamais activated) n'est jamais candidate, même
// si elle attaque via la chaîne (ex. Spinal Crush).
const actionTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'X', equipment: {} }, opp: { hero: 'Y', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], grave: { me: [], opp: [] },
      chain: [{ turn: 'Me#1', card: 'Spinal Crush', power: 9, defense: 0, kw: [] }],
      events: [
        { type: 'played', player: 'Me', card: 'Spinal Crush' },
        { type: 'damageTaken', player: 'Opp', amount: 9 },
        { type: 'combatResult', hit: true, amount: 9 }
      ] }
  ]
});
eq((actionTl.players.me.createdWeapons || []).length, 0, 'arme créée : une carte simplement JOUÉE (Spinal Crush) n\'est PAS une arme');

// Défausse provoquée par une carte (ex. Golden Tipple) : la ligne « X was
// discarded » suit la résolution du jeu responsable → annotée sur l'étape de
// cette carte (petite pill Table) ET envoyée au cimetière du camp qui a joué.
// (1) Carte NON-attaque (tour sans combat) → étape « play ».
const discPlayTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'X', equipment: {} }, opp: { hero: 'Y', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], grave: { me: [], opp: [] },
      events: [
        { type: 'played', player: 'Me', card: 'Golden Tipple' },
        { type: 'resolving', card: 'Golden Tipple' },
        { type: 'discarded', card: 'Sawbones, Dock Hand' }
      ] }
  ]
});
const discPlayStep = discPlayTl.steps.map(s => s.stage).find(st => st.type === 'play' && st.card && st.card.nm === 'Golden Tipple');
assert(discPlayStep && (discPlayStep.discards || []).indexOf('Sawbones, Dock Hand') >= 0, 'défausse : annotée sur l\'étape de la carte responsable (play)');
assert(discPlayTl.steps.slice(-1)[0].state.meGrave.indexOf('Sawbones, Dock Hand') >= 0, 'défausse : carte envoyée au cimetière du joueur');

// (2) Carte d'ATTAQUE (chaîne) qui défausse en coût de jeu → l'annotation suit
// l'attaquant jusque dans l'échange (clash.atk.discards).
const discClashTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'X', equipment: {} }, opp: { hero: 'Y', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], grave: { me: [], opp: [] },
      chain: [{ turn: 'Me#1', card: 'Golden Tipple', power: 1, defense: 0, kw: [] }],
      events: [
        { type: 'played', player: 'Me', card: 'Golden Tipple' },
        { type: 'resolving', card: 'Golden Tipple' },
        { type: 'discarded', card: 'Sawbones, Dock Hand' },
        { type: 'damageTaken', player: 'Opp', amount: 1 },
        { type: 'combatResult', hit: true, amount: 1 }
      ] }
  ]
});
const discClashStep = discClashTl.steps.map(s => s.stage).find(st => st.type === 'clash' && st.atk && st.atk.nm === 'Golden Tipple');
assert(discClashStep && (discClashStep.atk.discards || []).indexOf('Sawbones, Dock Hand') >= 0, 'défausse : annotée sur l\'attaquant dans l\'échange (clash)');

// (3) Défausse par une capacité ACTIVÉE (ex. pouvoir de héros) → étape « play » activée.
const discActTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'X', equipment: {} }, opp: { hero: 'Y', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], grave: { me: [], opp: [] },
      events: [
        { type: 'activated', player: 'Me', card: 'Gravy Bones, Shipwrecked Looter' },
        { type: 'resolving', card: 'Gravy Bones, Shipwrecked Looter' },
        { type: 'discarded', card: 'Fiddler\'s Green' }
      ] }
  ]
});
const discActStep = discActTl.steps.map(s => s.stage).find(st => st.type === 'play' && st.act && st.card && st.card.nm === 'Gravy Bones, Shipwrecked Looter');
assert(discActStep && (discActStep.discards || []).indexOf('Fiddler\'s Green') >= 0, 'défausse : annotée sur une capacité activée');

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

// Arcane TOTALEMENT prévenu (game 1943702, T11 Snapback) : réel 0 mais menace + pitchs
// adverses doivent quand même s'afficher (comme la vue Déroulé). Régression : avant, la
// carte réduite à 0 perdait threat/prevent (takeArcane sortait sur total<=0). On teste
// aussi une prévention PARTIELLE (Meteoric Impact, réel > 0) → non-régression.
const arcPrevTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Pleiades', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [30, 30] },
  turns: [
    { player: 'Me', label: 'Me — Tour 11', hand: [], arsenal: [], grave: { me: [], opp: [] }, chain: [], events: [
      // Meteoric Impact : menacé 6 → réel 3 (prévention partielle, pitch Up on a Pedestal)
      { type: 'played', player: 'Me', card: 'Meteoric Impact' },
      { type: 'arcaneDamage', source: 'Meteoric Impact', amount: 6, actual: false },
      { type: 'pitched', player: 'Opp', card: 'Up on a Pedestal' },
      { type: 'arcaneDamage', dealer: 'Me', source: 'Meteoric Impact', amount: 3, actual: true },
      { type: 'damageTaken', player: 'Opp', amount: 3 },
      // Snapback : menacé 3 → réel 0 (prévention TOTALE, pitch Righteous Cleansing + Command and Conquer)
      { type: 'played', player: 'Me', card: 'Snapback' },
      { type: 'arcaneDamage', source: 'Snapback', amount: 3, actual: false },
      { type: 'pitched', player: 'Opp', card: 'Righteous Cleansing' },
      { type: 'pitched', player: 'Opp', card: 'Command and Conquer' },
      { type: 'arcaneDamage', dealer: 'Me', source: 'Snapback', amount: 0, actual: true },
      { type: 'damageTaken', player: 'Opp', amount: 0 }
    ] }
  ]
});
const findPlay = nm => arcPrevTl.steps.find(s => s.stage && s.stage.type === 'play' && s.stage.card && s.stage.card.nm === nm);
const snapStep = findPlay('Snapback');
assert(!!snapStep, 'arcane 0 : étape Snapback présente');
eq(snapStep.stage.threat, 3, 'arcane totalement prévenu : montant menacé (3) affiché sur Snapback');
eq((snapStep.stage.prevent || []).join(','), 'Righteous Cleansing,Command and Conquer', 'arcane totalement prévenu : pitchs de prévention adverse affichés');
eq(snapStep.stage.dmg, undefined, 'arcane totalement prévenu : aucun dégât réel (dmg non affiché)');
const metStep = findPlay('Meteoric Impact');
eq(metStep.stage.threat, 6, 'prévention partielle : menacé 6 conservé (non-régression)');
eq(metStep.stage.dmg, 3, 'prévention partielle : 3 dégâts réels');
eq((metStep.stage.prevent || []).join(','), 'Up on a Pedestal', 'prévention partielle : pitch de prévention affiché');

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

// Ouverture : une carte jouée APRÈS un buff (Scar for a Scar après Nimblism)
// doit rester en main tant qu'elle n'est pas jouée — la carte pré-attaque est
// « photographiée » au bon moment (pas à la résolution du combat).
const openHandTl = BR.buildTimeline({
  myName: 'Briar', oppName: 'Marlynn',
  players: { me: { hero: 'Briar', equipment: {} }, opp: { hero: 'Marlynn', equipment: {} } },
  lifeSeries: { me: [20, 20], opp: [19, 19] },
  turns: [{ player: null, label: 'Ouverture', turnNumber: 0, hand: ['Quick Succession'], arsenal: [],
    chain: [{ turn: '__opening__', card: 'Scar for a Scar', power: 6, defense: 0, kw: ['goAgain'] }],
    events: [
      { type: 'played', player: 'Briar', card: 'Nimblism' },
      { type: 'played', player: 'Briar', card: 'Scar for a Scar' },
      { type: 'combatResult', hit: true, amount: 6 }
    ] }]
});
const nimStep = openHandTl.steps.find(s => s.stage.type === 'play' && s.stage.card && s.stage.card.nm === 'Nimblism');
assert(nimStep && nimStep.state.meHandCards.some(c => /scar for a scar/i.test(c)), 'ouverture : Scar encore en main à l\'étape où Nimblism est joué (buff avant l\'attaque)');
const scarStep = openHandTl.steps.find(s => s.stage.type === 'clash');
assert(scarStep && !scarStep.state.meHandCards.some(c => /scar for a scar/i.test(c)), 'ouverture : Scar retiré de la main une fois joué (à l\'échange)');

// Ouverture : main de départ NON tronquée par la HAND TIMELINE quand son 1er
// instantané est tardif (reproduction game 1820277 : Persuasive Prognosis pitchée
// à la 1re action, puis un undo décale la vraie capture à 4 cartes loin dans le
// log → HT[0] est une capture post-pitch à 3 cartes). La bannière d'ouverture doit
// garder les 4 cartes du snapshot, pas rétrograder vers HT[0].
const openLateTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Arakni, Marionette', equipment: { weaponL: { name: 'Klaive' } } }, opp: { hero: 'Opp', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  handTimeline: [
    { pos: 3, cards: ['To The Point', 'Stains', 'Incision'] },   // 1re capture DISPO = post-pitch (3 cartes)
    { pos: 6, cards: ['To The Point', 'Stains'] }
  ],
  turns: [{ player: null, label: 'Ouverture', turnNumber: 0,
    hand: ['Persuasive Prognosis', 'To The Point', 'Stains', 'Incision'], arsenal: [],
    events: [
      { type: 'activated', player: 'Me', card: 'Klaive', _idx: 0 },   // 1re action (n'ôte pas de carte de main) → bannière _idx=0
      { type: 'pitched', player: 'Me', card: 'Persuasive Prognosis', _idx: 2 },
      { type: 'played', player: 'Me', card: 'To The Point', _idx: 5 }
    ] }]
});
const openBanner = openLateTl.steps.find(s => s.stage.type === 'banner' && /Début de la partie/.test(s.stage.big || ''));
assert(openBanner, 'ouverture (timeline tardive) : bannière de début présente');
eq(openBanner.state.meHandCards.length, 4, 'ouverture (timeline tardive) : main de départ à 4 cartes, non tronquée par HT[0]');
assert(openBanner.state.meHandCards.some(c => /persuasive prognosis/i.test(c)), 'ouverture (timeline tardive) : la carte pitchée d\'entrée figure encore dans la main de départ');
// Non-régression : une fois passé le 1er instantané (firstPos), la main suit bien
// la timeline (la carte pitchée a quitté la main, on ne reste pas bloqué à 4).
const lastOpen = openLateTl.steps[openLateTl.steps.length - 1];
assert(lastOpen && !lastOpen.state.meHandCards.some(c => /persuasive prognosis/i.test(c)), 'ouverture (timeline tardive) : la main suit la timeline après le 1er instantané (carte pitchée retirée)');

// Bannière de DÉBUT de tour : compte de main FIABLE, jamais tronqué par la HAND
// TIMELINE (reproduction game 1906591). L'instantané d'ouverture (4 cartes) est
// tagué à un `pos` élevé (capture tardive) et se retrouve après des instantanés
// post-pitch précoces ; le tour 1 a des instantanés dont le `pos` précède le
// `_idx` de l'en-tête. Les bannières doivent garder les snapshots fiables (4 puis 3).
const bannerTl = BR.buildTimeline({
  myName: 'Oscilio', oppName: 'Jarl',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Jarl', equipment: {} } },
  lifeSeries: { me: [40, 40, 40], opp: [40, 40, 40] },
  handTimeline: [
    // NB : instantané = « Comet Storm  Shock » (double espace, forme grabber) alors
    // que les events log = « Comet Storm // Shock » (slashs). normName doit fusionner
    // les deux, sinon la ré-intégration à l'ouverture duplique la carte (6 au lieu de 4).
    { pos: 258, cards: ['Comet Storm  Shock', 'Echoflash', 'Aether Flare', 'Comet Storm  Shock'] }, // ouverture captée TARD
    { pos: 1, cards: ['Echoflash', 'Aether Flare', 'Comet Storm  Shock'] },           // post-play précoce (3)
    { pos: 4, cards: ['Aether Flare', 'Comet Storm  Shock'] },                        // (2)
    { pos: 33, cards: ['Constella Uplift', 'Aether Flare', 'Kindle'] },               // vrai début tour 1 (3)
    { pos: 48, cards: ['Constella Uplift', 'Kindle'] },                               // plays tour 1 (2) — pos < _idx en-tête
    { pos: 50, cards: ['Kindle'] }                                                    // (1)
  ],
  turns: [
    { player: null, label: 'Ouverture', turnNumber: 0,
      hand: ['Comet Storm  Shock', 'Echoflash', 'Aether Flare', 'Comet Storm  Shock'], arsenal: [],
      events: [
        { type: 'played', player: 'Oscilio', card: 'Comet Storm // Shock', _idx: 2 },
        { type: 'pitched', player: 'Oscilio', card: 'Comet Storm // Shock', _idx: 3 },
        { type: 'pitched', player: 'Oscilio', card: 'Echoflash', _idx: 4 }
      ] },
    { player: 'Oscilio', label: 'Oscilio — Tour 1', turnNumber: 1,
      hand: ['Constella Uplift', 'Aether Flare', 'Kindle'], arsenal: [],
      events: [
        { type: 'played', player: 'Oscilio', card: 'Aether Flare', _idx: 50 },
        { type: 'pitched', player: 'Oscilio', card: 'Constella Uplift', _idx: 52 }
      ] }
  ]
});
const openBan = bannerTl.steps.find(s => s.stage.type === 'banner' && /Début de la partie/.test(s.stage.big || ''));
eq(openBan && openBan.state.meHandCards.length, 4, 'game 1906591 : bannière d\'ouverture à 4 cartes (non tronquée)');
const t1Ban = bannerTl.steps.find(s => s.stage.type === 'banner' && /Ton tour/.test(s.stage.big || ''));
eq(t1Ban && t1Ban.state.meHandCards.length, 3, 'game 1906591 : bannière tour 1 à 3 cartes (non tronquée à 2)');
assert(t1Ban && t1Ban.state.meHandCards.some(c => /constella uplift/i.test(c)), 'game 1906591 : Constella Uplift présente en main au début du tour 1');

// Tours SANS instantané par tour (grabber démarré/rechargé EN COURS de partie →
// t.hand/t.arsenal null) + HAND TIMELINE aux positions AGGLUTINÉES (le grabber a
// « adopté » d'un coup le chatLog déjà présent → toutes les positions early écrasées
// sur une même grande valeur, ici 90). Reproduction game 2017659 : mes tours
// affichaient « main vide » et la carte arsenalée (Comet Storm) n'apparaissait pas.
// La main doit être reconstruite par CONTENU depuis la timeline, l'arsenal inféré des
// jeux « from arsenal », sans jamais afficher une même carte en main ET en arsenal.
const noSnapTl = BR.buildTimeline({
  myName: 'Oscilio', oppName: 'Gravy',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Gravy', equipment: {} } },
  lifeSeries: { me: [36, 36, 36], opp: [40, 40, 40] },
  handTimeline: [
    { pos: 90, cards: ['Kindle', 'Comet Collision', 'Sigil Of Solace', 'Comet Storm  Shock'] }, // ouverture
    { pos: 90, cards: ['Comet Storm  Shock', 'Mental Block', 'Comet Collision', 'Aethersling'] }, // début tour 1 (moi)
    { pos: 90, cards: ['Comet Storm  Shock', 'Comet Collision', 'Aethersling'] },
    { pos: 90, cards: ['Comet Storm  Shock'] }
  ],
  turns: [
    { player: null, label: 'Ouverture', turnNumber: 0,
      hand: ['Kindle', 'Comet Collision', 'Sigil Of Solace', 'Comet Storm  Shock'], arsenal: [],
      events: [{ type: 'played', player: 'Oscilio', card: 'Sigil Of Solace', _idx: 1 }] },
    { player: 'Gravy', label: 'Gravy — Tour 1', turnNumber: 1, hand: null, arsenal: null,
      events: [{ type: 'played', player: 'Gravy', card: 'Riggermortis', _idx: 20 }] },
    { player: 'Oscilio', label: 'Oscilio — Tour 1', turnNumber: 1, hand: null, arsenal: null,
      events: [
        { type: 'played', player: 'Oscilio', card: 'Comet Storm // Shock', fromArsenal: true, _idx: 25 },
        { type: 'pitched', player: 'Oscilio', card: 'Mental Block', _idx: 27 },
        { type: 'played', player: 'Oscilio', card: 'Aethersling', _idx: 29 },
        { type: 'played', player: 'Oscilio', card: 'Comet Collision', _idx: 31 }
      ] }
  ]
});
const noSnapBan = noSnapTl.steps.find(s => s.stage.type === 'banner' && /Ton tour/.test(s.stage.big || ''));
assert(noSnapBan, 'no-snap : bannière de mon tour présente');
assert(noSnapBan.state.meHandCards.length > 0, 'no-snap : main de mon tour reconstruite (plus « main vide »)');
assert(noSnapBan.state.meArsenal.some(c => /comet storm/i.test(c)), 'no-snap : carte jouée depuis l\'arsenal (Comet Storm) visible en zone arsenal');
assert(!noSnapBan.state.meHandCards.some(c => /comet storm/i.test(c)), 'no-snap : la carte d\'arsenal n\'apparaît PAS aussi en main (pas de double zone)');
['Mental Block', 'Comet Collision', 'Aethersling'].forEach(nm =>
  assert(noSnapBan.state.meHandCards.some(c => Parser.normName(c) === Parser.normName(nm)), 'no-snap : ' + nm + ' présent en main au début du tour'));

// ── Vue DÉROULÉ : reconcileCertain ne gonfle plus la main de début de MON tour ──
// (game 1906591 : Oscilio pioche en cours de tour → une carte piochée puis jouée
// ne doit PAS compter dans la main de DÉBUT de tour). L'instantané fiable fait foi.
const Replay = require('../js/replay.js');
Replay._setTestContext(Parser, 'Oscilio', []);
const rcMine = Replay.reconcileCertain(
  ['Constella Uplift', 'Aether Flare', 'Kindle'],
  { player: 'Oscilio', side: 'me', turnNumber: 1, events: [
    { type: 'played', player: 'Oscilio', card: 'Aether Flare' },
    { type: 'pitched', player: 'Oscilio', card: 'Constella Uplift' },
    { type: 'played', player: 'Oscilio', card: 'Constella Contemplation' }   // PIOCHÉE en cours de tour
  ] }, 'hand');
eq(rcMine.length, 3, 'Déroulé : mon tour = instantané fiable (3), pas gonflé par une carte piochée+jouée');
assert(!rcMine.some(c => /contemplation/i.test(c)), 'Déroulé : la carte piochée en cours de tour est exclue de la main de début');
// Ouverture : reconstruction TOUJOURS active (l'instantané peut être capté tard).
const rcOpen = Replay.reconcileCertain(
  ['Aether Flare'],
  { player: 'Oscilio', side: 'me', turnNumber: 0, events: [
    { type: 'played', player: 'Oscilio', card: 'Comet Storm' }
  ] }, 'hand');
assert(rcOpen.some(c => /comet storm/i.test(c)), 'Déroulé : à l\'ouverture, la carte jouée est réintégrée à la main de départ');
// Tour ADVERSE : reconstruction conservée (ma main ne fait que décroître, jamais pioche).
const rcOpp = Replay.reconcileCertain(
  ['Aether Flare'],
  { player: 'Jarl', side: 'opp', turnNumber: 2, events: [
    { type: 'blocked', player: 'Oscilio', cards: ['Crown of Providence'] }
  ] }, 'hand');
assert(rcOpp.some(c => /crown/i.test(c)), 'Déroulé : sur le tour adverse, une carte de blocage est réintégrée à la main');

// Ordre : une réaction de DÉFENSE jouée pendant l'attaque adverse (arme) ne doit
// PAS apparaître en étape AVANT l'attaque — elle figure côté défense de l'échange.
const defTl = BR.buildTimeline({
  myName: 'Ziggy', oppName: 'Marilyn',
  players: { me: { hero: 'Ziggy', equipment: {} }, opp: { hero: 'Marilyn', equipment: { weaponL: { name: 'Harpoon' } } } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [{ player: 'Marilyn', label: 'Marilyn — Tour 1', hand: [], arsenal: [],
    chain: [{ turn: 'Marilyn#1', card: 'Harpoon', power: 4, defense: 0, kw: [] }],
    events: [
      { type: 'activated', player: 'Marilyn', card: 'Harpoon' },
      { type: 'played', player: 'Ziggy', card: 'Sink Below' },
      { type: 'combatResult', hit: false }
    ] }]
});
assert(!defTl.steps.some(s => s.stage.type === 'play' && s.stage.card && s.stage.card.nm === 'Sink Below'), 'défense : la réaction n\'apparaît pas en étape séparée avant l\'attaque');
const defClash = defTl.steps.map(s => s.stage).find(st => st.type === 'clash');
// Une carte « played » par le défenseur (instant/réaction) figure dans la rangée
// « réactions » du clash, PAS dans les blocs (elle n'a pas de valeur de défense).
assert(defClash && !(defClash.blocks || []).some(b => b.nm === 'Sink Below'), 'défense : la réaction « played » n\'est PAS comptée comme bloc');
assert(defClash && (defClash.reactions || []).some(b => b.nm === 'Sink Below'), 'défense : la réaction « played » figure dans la rangée réactions');

// Instants sans défense joués pendant un combat (reproduction game 1756262 : Murky
// Water bloquée par Comet Collision, puis 3 sigils joués). Seul « blocked with » est
// un bloc ; les sigils « played » vont dans la rangée réactions, pas dans la défense.
const instTl = BR.buildTimeline({
  myName: 'Oscilio', oppName: 'Riptide',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Riptide', equipment: {} } },
  lifeSeries: { me: [40, 31], opp: [40, 40] },
  turns: [{ player: 'Riptide', label: 'Riptide — Tour 1', hand: [], arsenal: [],
    chain: [{ turn: 'Riptide#1', card: 'Murky Water', power: 12, defense: 3, kw: [] }],
    events: [
      { type: 'played', player: 'Riptide', card: 'Murky Water' },
      { type: 'blocked', player: 'Oscilio', cards: ['Comet Collision'] },
      { type: 'played', player: 'Oscilio', card: 'Sigil of Solace' },
      { type: 'played', player: 'Oscilio', card: 'Sigil of Brilliance' },
      { type: 'played', player: 'Oscilio', card: 'Chromatic Refinement' },
      { type: 'combatResult', hit: true, amount: 9 }
    ] }]
});
const instClash = instTl.steps.map(s => s.stage).find(st => st.type === 'clash');
assert(instClash && (instClash.blocks || []).length === 1 && instClash.blocks[0].nm === 'Comet Collision', 'instants : seul « blocked with » (Comet Collision) est en défense');
assert(instClash && !(instClash.blocks || []).some(b => /Sigil|Chromatic/.test(b.nm)), 'instants : les sigils ne sont PAS des bloqueurs');
assert(instClash && ['Sigil of Solace', 'Sigil of Brilliance', 'Chromatic Refinement'].every(nm => (instClash.reactions || []).some(r => r.nm === nm)), 'instants : les 3 instants figurent dans la rangée réactions');

// « Card chosen: X » (pouvoir d'Oscilio) : annoté sur l'activation ET retiré de MA
// main affichée (sinon la carte bannie « traîne » jusqu'au tour suivant).
const chosenTl = BR.buildTimeline({
  myName: 'Oscilio', oppName: 'Riptide',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Riptide', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [{ player: 'Riptide', label: 'Riptide — Tour 1', hand: ['Flash Bolt', 'Comet Collision'], arsenal: [],
    events: [
      { type: 'activated', player: 'Oscilio', card: 'Oscilio, Constella Intelligence' },
      { type: 'cardChosen', card: 'Flash Bolt' }
    ] }]
});
const chosenStep = chosenTl.steps.map(s => s.stage).find(st => st.type === 'play' && st.act);
assert(chosenStep && chosenStep.chosen === 'Flash Bolt', 'card chosen : l\'activation porte la carte choisie');
assert(!chosenTl.steps.some(s => s.stage.type === 'play' && s.stage.card && s.stage.card.nm === 'Flash Bolt' && !s.stage.act), 'card chosen : « Card chosen: X » ne crée pas d\'étape parasite');
const lastChosen = chosenTl.steps.slice(-1)[0];
assert(lastChosen.state.meHandCards.indexOf('Flash Bolt') < 0, 'card chosen : Flash Bolt retirée de la main affichée');
assert(lastChosen.state.meHandCards.indexOf('Comet Collision') >= 0, 'card chosen : les autres cartes restent en main');

// Couleur (cp) propagée jusqu'à l'échange Table : attaquant + bloc portent leur pitch.
const sdBR = (id, nm) => "<span onmouseover=\"ShowDetail(event,'./WebpImages/" + id + ".webp')\">" + nm + "</span>";
const colGame = Parser.parse([
  '=== Talishar game 78 — test ===', '',
  "Ehecalt's turn 1 has begun.",
  'Ehecalt played Lightning Press', 'nissy blocked with Sink Below', 'Combat resolved with a hit for 2 damage',
  '', '=== META ===', 'me: Ehecalt', 'opp: nissy',
  '', '=== RAW CHATLOG (state.game.chatLog, verbatim) ===',
  JSON.stringify(['Player 1 played ' + sdBR('lightning_press_blue', 'Lightning Press'), 'Player 2 blocked with ' + sdBR('sink_below_yellow', 'Sink Below')])
].join('\n'));
const colClash = BR.buildTimeline(colGame).steps.map(s => s.stage).find(st => st.type === 'clash');
assert(colClash && colClash.atk && colClash.atk.cp === 3, 'couleur Table : attaquant Lightning Press → bleu (cp 3)');
assert(colClash && (colClash.blocks || []).some(b => b.nm === 'Sink Below' && b.cp === 2), 'couleur Table : bloc Sink Below → jaune (cp 2)');

// ---------- Dégâts d'arcane : capture + affichage + réactions non avalées ----------
console.log('Arcane —');
// classifyLine : forme RÉELLE (« from <src> ») vs MENACÉE.
const arcReal = Parser.classifyLine('Oscilio Constella Intelligence is dealing 1 arcane damage from Flash Bolt');
eq(arcReal.type, 'arcaneDamage', 'arcane réel : type');
eq(arcReal.actual, true, 'arcane réel : actual=true');
eq(arcReal.source, 'Flash Bolt', 'arcane réel : source = carte');
eq(arcReal.amount, 1, 'arcane réel : montant');
const arcThreat = Parser.classifyLine('Flash Bolt is dealing 3 arcane damage');
eq(arcThreat.type, 'arcaneDamage', 'arcane menacé : type');
eq(arcThreat.actual, false, 'arcane menacé : actual=false');
// Garde-fou coût passif : « X was played with a cost of N. » n'est PAS un « played ».
eq(Parser.classifyLine('Sonata Galaxia was played with a cost of 2.').type, 'info', 'coût passif → info (pas un faux played)');

// Tour SANS combat (sorts) : le sort apparaît avec ses dégâts d'arcane, la réaction
// adverse N'EST PAS avalée, et un dégât de jeton (Runechant) a son étape autonome.
const arcGame = {
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Vynnset', equipment: {} } },
  lifeSeries: { me: [40], opp: [40] },
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: ['Turn to Mindfire'], arsenal: [], events: [
      { type: 'played', player: 'Me', card: 'Turn to Mindfire' },
      { type: 'arcaneDamage', dealer: 'Me', source: 'Turn to Mindfire', amount: 6, actual: true },
      { type: 'damageTaken', player: 'Opp', amount: 6 },
      { type: 'played', player: 'Opp', card: 'Sink Below' },   // réaction adverse pendant mon tour (hors combat)
      { type: 'arcaneDamage', dealer: 'Me', source: 'Runechant', amount: 1, actual: true },   // jeton, non rattaché
      { type: 'damageTaken', player: 'Opp', amount: 1 }
    ] }
  ]
};
const arcSteps = BR.buildTimeline(arcGame).steps.map(s => s.stage);
const ttm = arcSteps.find(s => s.type === 'play' && s.card && s.card.nm === 'Turn to Mindfire');
assert(ttm && ttm.dmg === 6, 'sort d\'arcane : dégâts affichés sur l\'action (6)');
assert(arcSteps.some(s => s.type === 'play' && s.card && s.card.nm === 'Sink Below' && s.reaction), 'réaction adverse hors combat : montrée (pas avalée)');
const runeStep = arcSteps.find(s => s.token && s.card && s.card.nm === 'Runechant');
assert(runeStep && runeStep.dmg === 1, 'dégât de jeton (Runechant) : étape d\'arcane autonome');
// Vie : appliquée une seule fois (6 + 1 = 7 → 40 → 33), pas de double comptage.
eq(BR.buildTimeline(arcGame).steps.slice(-1)[0].state.life.opp, 33, 'arcane : vie à jour sans double comptage');

// ---------- Bugs vue Table (game 1923349) ----------
console.log('Bugs Table 1923349 —');

// #2 — Arcane MENACÉ + prévention adverse : « <src> is dealing N » (menacé, buffs
// compris), l'adversaire pitch pour prévenir, puis « … N-x from <src> » (réel).
// L'étape du sort doit porter le menacé ET les cartes pitchées pour prévenir.
const prevGame = {
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Lyath', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: null, label: 'Ouverture', turnNumber: 0, hand: [], arsenal: [], events: [] },
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], events: [
      { type: 'played', player: 'Me', card: 'Aether Flare', _idx: 0 },
      { type: 'arcaneDamage', source: 'Aether Flare', amount: 5, actual: false, _idx: 1 },       // menacé 5
      { type: 'pitched', player: 'Opp', card: 'Concealed Object', _idx: 2 },                      // prévention
      { type: 'arcaneDamage', dealer: 'Me', source: 'Aether Flare', amount: 3, actual: true, _idx: 3 }, // réel 3
      { type: 'damageTaken', player: 'Opp', amount: 3, _idx: 4 }
    ] }
  ]
};
const prevStep = BR.buildTimeline(prevGame).steps.map(s => s.stage).find(s => s.type === 'play' && s.card && s.card.nm === 'Aether Flare');
eq(prevStep && prevStep.dmg, 3, 'arcane prévention : dégât réel 3');
eq(prevStep && prevStep.threat, 5, 'arcane prévention : montant menacé 5 (buffs compris)');
assert(prevStep && prevStep.prevent && prevStep.prevent.join(',') === 'Concealed Object', 'arcane prévention : carte pitchée adverse listée');

// #2bis — Un pitch adverse payant un AUTRE effet (hors bloc menacé→réel) N'est PAS
// pris pour de la prévention (borne serrée entre la ligne menacée et le réel).
const prevGame2 = {
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Lyath', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [
    { player: null, label: 'Ouverture', turnNumber: 0, hand: [], arsenal: [], events: [] },
    { player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], events: [
      { type: 'played', player: 'Me', card: 'Aethersling', _idx: 0 },
      { type: 'played', player: 'Opp', card: 'Leave Them Hanging', _idx: 1 },
      { type: 'pitched', player: 'Opp', card: 'Two Steps Ahead', _idx: 2 },      // paie Leave Them Hanging (AVANT le menacé)
      { type: 'arcaneDamage', source: 'Aethersling', amount: 5, actual: false, _idx: 3 },  // menacé 5
      { type: 'pitched', player: 'Opp', card: 'Razor Reflex', _idx: 4 },         // VRAIE prévention
      { type: 'arcaneDamage', dealer: 'Me', source: 'Aethersling', amount: 4, actual: true, _idx: 5 },
      { type: 'damageTaken', player: 'Opp', amount: 4, _idx: 6 }
    ] }
  ]
};
const prevStep2 = BR.buildTimeline(prevGame2).steps.map(s => s.stage).find(s => s.type === 'play' && s.card && s.card.nm === 'Aethersling');
assert(prevStep2 && prevStep2.prevent && prevStep2.prevent.join(',') === 'Razor Reflex', 'arcane prévention : seul le pitch entre menacé et réel compte (pas Two Steps Ahead)');

// #6 — Tour REMBOBINÉ (undo re-loguant tout le tour) : un en-tête « turn N » qui
// réapparaît RECYCLE le tour existant (événements vidés) au lieu d'en créer un 2e.
const reRaw = [
  '=== Talishar game 55 — 1/1/2026 ===',
  "Me's turn 1 has begun.",
  'Me played Alpha',
  'Opp took 9 damage',
  "Me's turn 1 has begun.",
  'Me played Beta',
  ''
].join('\n');
const reRec = Parser.parse(reRaw);
const meTurns = reRec.turns.filter(t => t.turnNumber === 1 && t.player === 'Me');
eq(meTurns.length, 1, 'reprise : un seul tour 1 (le rembobiné est fusionné)');
assert(!/reprise/i.test(meTurns[0].label), 'reprise : plus de suffixe « (reprise) »');
const reCards = meTurns[0].events.filter(e => e.type === 'played').map(e => e.card);
assert(reCards.length === 1 && reCards[0] === 'Beta', 'reprise : seuls les événements finaux subsistent (Alpha rembobiné écarté)');

// #7 — Couleur en main : HAND TIMELINE/SNAPSHOTS « Nom (card_id) » → pitches par
// carte ; buildTimeline expose meHandPitches parallèle à meHandCards.
const hcRaw = [
  '=== Talishar game 66 — 1/1/2026 ===',
  "Me's turn 1 has begun.",
  'Me played Foo',
  '',
  '=== HAND SNAPSHOTS (ta main) ===',
  '[Me #1] Meteoric Impact (meteoric_impact_blue), Kindle (kindle_red), Burn Bare (burn_bare)',
  '',
  '=== HAND TIMELINE (main) ===',
  '[1] Meteoric Impact (meteoric_impact_blue), Kindle (kindle_red)',
  ''
].join('\n');
const hcRec = Parser.parse(hcRaw);
eq(JSON.stringify(hcRec.handTimeline[0].pitches), '[3,1]', 'couleur : HAND TIMELINE parse les pitches (bleu=3, rouge=1)');
const hcT1 = hcRec.turns.find(t => t.turnNumber === 1);
eq(JSON.stringify(hcT1.handPitches), '[3,1,null]', 'couleur : HAND SNAPSHOT pitches (bleu, rouge, mono→null)');
const hcBanners = BR.buildTimeline(hcRec).steps.filter(s => s.stage.type === 'banner');
assert(hcBanners.some(s => JSON.stringify(s.state.meHandPitches) === '[3,1,null]'), 'couleur : meHandPitches propagé à la main affichée');
// Rétro-compat : une main SANS « (card_id) » (vieux log) → pitches null.
const oldRec = Parser.parse(['=== Talishar game 67 — 1/1/2026 ===', "Me's turn 1 has begun.", 'Me played X', '', '=== HAND TIMELINE (main) ===', '[1] Alpha, Beta', ''].join('\n'));
eq(JSON.stringify(oldRec.handTimeline[0].pitches), '[null,null]', 'couleur : rétro-compat (nom seul → pitch null)');

// #1 — Main d'ouverture NON gonflée : avec une HAND TIMELINE présente, on n'ajoute
// PAS les cartes pitchées absentes du snapshot d'ouverture (entrées ensuite).
const openNoAddTl = BR.buildTimeline({
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Opp', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  handTimeline: [{ pos: 1, cards: ['A', 'B', 'C', 'D'] }],
  turns: [{ player: 'Me', label: 'Ouverture', turnNumber: 0, hand: ['A', 'B', 'C', 'D'], arsenal: [], events: [
    { type: 'played', player: 'Me', card: 'A', _idx: 0 },
    { type: 'pitched', player: 'Me', card: 'E', _idx: 1 }   // E PAS dans la main de départ (drawn ensuite)
  ] }]
});
const openNoAdd = openNoAddTl.steps.find(s => s.stage.type === 'banner');
eq(openNoAdd.state.meHandCards.length, 4, 'ouverture : main NON gonflée par une carte pitchée hors main de départ (HT présente)');

// #3 — Intimidation : « X banishes a card face down » → événement + étape explicative.
const intiRaw = [
  '=== Talishar game 88 — 1/1/2026 ===',
  "Opp's turn 1 has begun.",
  'Opp played Leave Them Hanging',
  'Me banishes a card face down',
  ''
].join('\n');
const intiRec = Parser.parse(intiRaw);
assert(intiRec.turns.some(t => t.events.some(e => e.type === 'intimidate' && e.player === 'Me')), 'intimidation : événement parsé');
const intiSteps = BR.buildTimeline(intiRec).steps.map(s => s.stage);
assert(intiSteps.some(s => s.type === 'intimidate'), 'intimidation : étape explicative poussée');

// ---------- HAND TIMELINE : main fidèle par position de log ----------
console.log('Hand timeline —');
const htRaw = [
  '=== Talishar game 42 — 1/1/2026 ===',
  'Me played Alpha',
  'Me played Beta',
  '',
  '=== HAND TIMELINE (main, à chaque changement | pos = ligne de log) ===',
  '[0] Alpha, Beta, Gamma',
  '[1] Beta, Gamma',
  '[2] (vide)',
  ''
].join('\n');
const htRec = Parser.parse(htRaw);
eq(htRec.handTimeline.length, 3, 'HAND TIMELINE : 3 entrées parsées');
eq(htRec.handTimeline[0].pos, 0, 'HAND TIMELINE : position');
eq(htRec.handTimeline[2].cards.length, 0, 'HAND TIMELINE : (vide) → []');
// Override dans buildTimeline : la main d'une étape = dernier instantané pos ≤ _idx+1.
const htGame = {
  myName: 'Me', oppName: 'Opp',
  players: { me: { hero: 'Oscilio', equipment: {} }, opp: { hero: 'Vynnset', equipment: {} } },
  lifeSeries: { me: [40], opp: [40] },
  handTimeline: [{ pos: 0, cards: ['Alpha', 'Beta', 'Gamma'] }, { pos: 1, cards: ['Beta', 'Gamma'] }, { pos: 2, cards: ['Gamma'] }],
  turns: [
    { player: 'Me', label: 'Me — Tour 1', hand: ['Alpha', 'Beta', 'Gamma'], arsenal: [], events: [
      { type: 'played', player: 'Me', card: 'Alpha', _idx: 0 },
      { type: 'played', player: 'Me', card: 'Beta', _idx: 1 }
    ] }
  ]
};
const htSteps = BR.buildTimeline(htGame).steps;
const aStep = htSteps.find(s => s.stage.type === 'play' && s.stage.card.nm === 'Alpha');
const bStep = htSteps.find(s => s.stage.type === 'play' && s.stage.card.nm === 'Beta');
eq(aStep.state.meHandCards.join(','), 'Beta,Gamma', 'HAND TIMELINE : main de l\'étape Alpha (pos≤1)');
eq(bStep.state.meHandCards.join(','), 'Gamma', 'HAND TIMELINE : main de l\'étape Beta (pos≤2)');
// Sans timeline (vieux logs) : repli sur la reconstruction (pas d\'exception).
const htNone = BR.buildTimeline(Object.assign({}, htGame, { handTimeline: [] }));
assert(htNone.steps.length > 0, 'HAND TIMELINE absente : repli sans erreur');

// ---------- Transformation de héros (Arakni) : instant exact + renfort ----------
console.log('Transform —');
(function () {
  eq(Parser.classifyLine('Arakni, Marionette becomes Arakni, Funnel Web').type, 'transform', 'classifyLine: « becomes » → transform');
  const trRaw = [
    '=== Talishar game 88 — test ===', '',
    "Ehecalt's turn 1 has begun.",
    'Ehecalt activated Hunters Klaive',
    'nissy auto-passed',
    'Ehecalt activated Flick Knives',                 // équipement activé PENDANT l'attaque
    "Ehecalt's Hunters Klaive was targeted",
    'nissy took 5 damage',
    'Combat resolved with a hit for 5 damage',
    'Arakni, Marionette becomes Arakni, Funnel Web',  // transformation en fin de tour
    '', '=== META ===', 'me: Ehecalt', 'opp: nissy',
    'my_hero: Arakni, Marionette (arakni_marionette)',
    'my_equipment: arms=Flick Knives (flick_knives) | weaponL=Hunters Klaive (hunters_klaive)',
    '', '=== COMBAT CHAIN (attaque/défense effectives, buffs compris) ===',
    JSON.stringify({ turn: 'Ehecalt#1', card: 'Hunters Klaive', power: 5, defense: 0, prevent: 0, target: 'nissy', kw: [] })
  ].join('\n');
  const tr = Parser.parse(trRaw);
  const stages = BR.buildTimeline(tr).steps.map(s => s.stage);
  // Flick Knives (réaction sur la dague) : PAS une étape isolée…
  assert(!stages.some(st => st.type === 'play' && st.card && st.card.nm === 'Flick Knives'), 'transform: Flick Knives pas en étape isolée avant l\'attaque');
  // …mais un renfort DANS l'échange de la dague.
  const clash = stages.find(st => st.type === 'clash');
  assert(clash && (clash.pumps || []).some(p => p.nm === 'Flick Knives'), 'transform: Flick Knives = renfort de l\'échange');
  // Une étape de transformation apparaît (à l'instant du « becomes »).
  assert(stages.some(st => st.type === 'transform' && /Funnel Web/.test(st.sub || '')), 'transform: étape de transformation présente');

  // Transformation SANS ligne « becomes » (ex. Levia) : détectée via le bloc
  // HERO FORMS (forme du héros par tour) — indépendant du phrasé du log.
  const levRaw = [
    '=== Talishar game 89 — test ===', '',
    "Levia's turn 1 has begun.", 'Levia played Bloodrush Bellow',
    "Levia's turn 2 has begun.", 'Levia played Barraging Beatdown',
    '', '=== META ===', 'me: Levia', 'opp: Dummy',
    '', '=== HERO FORMS (forme du héros par tour : toi | adversaire) ===',
    '[Levia #1] me: Levia | opp: Dummy',
    '[Levia #2] me: Blasmophet, the Soul Harvester | opp: Dummy'
  ].join('\n');
  const lev = Parser.parse(levRaw);
  const levSteps = BR.buildTimeline(lev).steps;
  const levStages = levSteps.map(s => s.stage);
  const levTrans = levStages.filter(st => st.type === 'transform');
  assert(levTrans.length === 1 && /Blasmophet/.test(levTrans[0].sub) && levTrans[0].side === 'me',
    'transform (Levia, sans « becomes ») : détecté via HERO FORMS, une seule bannière côté moi');
  assert(!levTrans.some(st => /null/.test(st.sub || '')), 'transform : pas de bannière parasite « null → … »');
  assert(/Blasmophet/.test(levSteps[levSteps.length - 1].form.me), 'transform (Levia) : forme finale = Blasmophet');

  // Transformation de l'ADVERSAIRE (je subis une Marionette qui se transforme) :
  // bannière côté opp + forme adverse mise à jour (symétrie me/opp).
  const oppRaw = [
    '=== Talishar game 90 — test ===', '',
    "Bravo's turn 1 has begun.", 'Bravo played Crush Confidence',
    "Arakni, Marionette's turn 1 has begun.", 'Arakni, Marionette played Sharpen Steel',
    'Arakni, Marionette becomes Arakni, Funnel Web',
    '', '=== META ===', 'me: Bravo', 'opp: Arakni, Marionette'
  ].join('\n');
  const oppSteps = BR.buildTimeline(Parser.parse(oppRaw)).steps;
  const oppTrans = oppSteps.map(s => s.stage).filter(st => st.type === 'transform');
  assert(oppTrans.length === 1 && oppTrans[0].side === 'opp' && /Funnel Web/.test(oppTrans[0].sub),
    'transform (adversaire) : bannière côté opp (Marionette → Funnel Web)');
  assert(/Funnel Web/.test(oppSteps[oppSteps.length - 1].form.opp), 'transform (adversaire) : forme adverse finale mise à jour');

  // Transformation DÉCLENCHÉE PAR UN BLOCAGE (ex. Mask of Deceit, trigger de
  // défense) : le log l'écrit ENTRE le blocage et la résolution du combat,
  // AVANT « Combat resolved » — mais dans la table elle doit apparaître APRÈS
  // le clash (le bloc au casque), pas avant (cas réel : partie 1750820, tour 1).
  const maskRaw = [
    '=== Talishar game 91 — test ===', '',
    "Bravo's turn 1 has begun.",
    'Bravo played Spinal Crush',
    "Arakni, Redback blocked with Mask of Deceit",
    'Arakni, Redback becomes Arakni, Orb-Weaver',
    'Arakni, Redback is about to take 3 damage from Spinal Crush',
    'Arakni, Redback took 3 damage',
    'Combat resolved with a hit for 3 damage',
    "Arakni, Redback's turn 2 has begun.",   // établit le nom de l'adversaire (résolution des joueurs)
    'Arakni, Redback played Sink Below',
    '', '=== META ===', 'me: Bravo', 'opp: Arakni, Redback'
  ].join('\n');
  const maskSteps = BR.buildTimeline(Parser.parse(maskRaw)).steps;
  const maskStages = maskSteps.map(s => s.stage);
  const clashIdx = maskStages.findIndex(st => st.type === 'clash');
  const transIdx = maskStages.findIndex(st => st.type === 'transform');
  assert(clashIdx >= 0 && transIdx >= 0 && clashIdx < transIdx,
    'transform (déclenchée par un blocage, ex. Mask of Deceit) : le clash apparaît AVANT la transformation');
})();

// ---------- Undo : action annulée retirée (+ re-log dédupliqué) ----------
console.log('Undo —');
(function () {
  const undoRaw = '=== Talishar game 77 — test ===\n\n' +
    "Ehecalt's turn 1 has begun.\n" +
    "Ehecalt activated Hunter's Klaive\n" +
    'Ehecalt activated Flick Knives\n' +
    'Ehecalt undid their last action\n' +   // annule Flick Knives (une seule fois)
    'Ehecalt played Tarantula Toxin\n' +
    'Ehecalt played Sting\n' +
    'Ehecalt undid their last action\n' +   // annule Sting…
    'Ehecalt played Sting\n' +              // …puis re-log de Sting
    '\n=== META ===\nme: Ehecalt\n';
  const ur = Parser.parse(undoRaw);
  const t1 = ur.turns.find(t => t.turnNumber === 1);
  const cards = (t1.events || []).filter(e => e.type === 'played' || e.type === 'activated').map(e => e.card);
  assert(!cards.includes('Flick Knives'), 'undo: action annulée une seule fois (Flick Knives) retirée');
  eq(cards.filter(c => c === 'Sting').length, 1, 'undo: re-log → une seule occurrence de Sting');
  assert(cards.includes("Hunter's Klaive") && cards.includes('Tarantula Toxin'), 'undo: les actions NON annulées restent');

  // Blocage annulé : « blocked with X » puis undo → X ne doit PAS rester comme
  // carte de défense fantôme (trouvé sur un corpus réel : 5 cas concrets où
  // seul played/activated/pitched était couvert, jamais blocked).
  const blockUndoRaw = '=== Talishar game 78 — test ===\n\n' +
    "Ehecalt's turn 1 has begun.\n" +
    'nissy played Bare Fangs\n' +
    'Ehecalt blocked with Sink Below\n' +
    'Ehecalt undid their last action\n' +   // annule le blocage
    'Ehecalt passed\n' +
    '\n=== META ===\nme: Ehecalt\nopp: nissy\n';
  const bur = Parser.parse(blockUndoRaw);
  const bt1 = bur.turns.find(t => t.turnNumber === 1);
  assert(!(bt1.events || []).some(e => e.type === 'blocked'), 'undo: blocage annulé retiré (plus de carte de défense fantôme)');

  // Annulation CONSENTIE (2 lignes : « requests to undo » + « allowed undoing »).
  // Talishar y révèle le JEU complet → on retire le played + son pitch de paiement,
  // pas seulement la dernière action. Sinon la carte annulée puis rejouée (Deathly
  // Wail) reste en double et apparaît en faux « renfort » (game 1925934, Vynnset T2).
  eq(Parser.classifyLine('Vynnset requests to undo the last action').type, 'undo', 'undo consenti: « requests to undo » → undo');
  eq(Parser.classifyLine('Vynnset requests to undo the last action').full, true, 'undo consenti: drapeau full');
  eq(Parser.classifyLine('Oscilio allowed undoing the last action').type, 'info', 'undo consenti: « allowed undoing » → info (no-op)');
  const consentRaw = '=== Talishar game 79 — test ===\n\n' +
    "Vynnset's turn 1 has begun.\n" +
    'Vynnset played Deathly Wail\n' +
    '🎯Oscilio was chosen as the target.\n' +
    'Vynnset pitched Fasting Carcass\n' +
    'Vynnset requests to undo the last action\n' +
    'Oscilio allowed undoing the last action\n' +
    'Vynnset played Deathly Wail\n' +               // rejeu après annulation
    'Vynnset pitched Fasting Carcass\n' +
    '\n=== META ===\nme: Oscilio\nopp: Vynnset\n';
  const cr = Parser.parse(consentRaw);
  const ct1 = cr.turns.find(t => t.turnNumber === 1);
  eq((ct1.events || []).filter(e => e.type === 'played' && e.card === 'Deathly Wail').length, 1, 'undo consenti: un seul Deathly Wail restant (le rejoué)');
  eq((ct1.events || []).filter(e => e.type === 'pitched').length, 1, 'undo consenti: un seul pitch restant (paiement du jeu annulé retiré)');
})();

// ---------- Bannissement : « <Carte> was banished. » → étape + jetons Runechant ----------
console.log('Banish / Runechant —');
(function () {
  eq(Parser.classifyLine('Deathly Wail was banished.').type, 'banished', 'banish: « was banished » classifié');
  eq(Parser.classifyLine('Deathly Wail was banished.').card, 'Deathly Wail', 'banish: nom de carte extrait');
  // « was played with a cost of N » ne doit PAS être capté comme banish/played.
  eq(Parser.classifyLine('Scour was played with a cost of 3.').type, 'info', 'banish: garde-fou « was played with a cost » intact');
  // Étape banish de début de tour adverse (Vynnset bannit une carte → moteur de
  // Runechant). Le Runechant qui inflige des dégâts CE tour doit figurer dans les
  // jetons adverses dès le début du tour (plancher prouvé, corrige le décalage).
  const banRec = {
    myName: 'Me', oppName: 'Vynnset',
    players: { me: { hero: 'Me', equipment: {} }, opp: { hero: 'Vynnset', equipment: {} } },
    lifeSeries: { me: [40, 40], opp: [40, 40] },
    turns: [
      { player: 'Vynnset', label: 'Vynnset — Tour 1', hand: [], arsenal: [], field: { me: [], opp: [] }, events: [
        { type: 'cardChosen', card: 'Deathly Wail', _idx: 1 },
        { type: 'banished', card: 'Deathly Wail', _idx: 2 },
        { type: 'played', player: 'Vynnset', card: 'Deathly Wail', _idx: 3 },
        { type: 'arcaneDamage', dealer: 'Vynnset', source: 'Runechant', amount: 1, actual: true, _idx: 4 },
        { type: 'damageTaken', player: 'Me', amount: 1, _idx: 5 },
        { type: 'combatResult', hit: true, amount: 6, _idx: 6 }
      ] }
    ]
  };
  const banSteps = BR.buildTimeline(banRec).steps;
  const banStep = banSteps.find(s => s.stage.banish);
  assert(banStep && /bannit Deathly Wail/.test(banStep.stage.text), 'banish: étape « bannit X » présente au début du tour adverse');
  assert(banSteps.some(s => (s.state.oppTokens || []).some(c => /runechant/i.test(c))), 'runechant: jeton présent côté adverse dès qu\'il frappe ce tour');
})();

// ---------- Assainissement main : artefacts DOM (HexagonRedGemGlow) écartés ----------
console.log('Assainissement main —');
(function () {
  const junkRaw = [
    '=== Talishar game 80 — test ===', '',
    "Me's turn 1 has begun.",
    'Me played Burn Bare',
    "Opp's turn 2 has begun.",
    'Opp played Sting',
    '', '=== META ===', 'me: Me', 'opp: Opp',
    'my_equipment: arms=Metacarpus Node (metacarpus_node)',
    '', '=== HAND SNAPSHOTS (ta main, captée depuis le DOM — jamais celle de l\'adversaire) ===',
    '[Me #1] Burn Bare, Scour',
    '[Opp #2] Metacarpus Node, HexagonRedGemGlow-HR6qHYfn',   // capture parasite (équipement + halo)
    '', '=== HAND TIMELINE (main, à chaque changement | pos = ligne de log) ===',
    '[3] Burn Bare, Scour',
    '[5] Metacarpus Node, HexagonRedGemGlow-HR6qHYfn',
    '[6] Scour'
  ].join('\n');
  const jr = Parser.parse(junkRaw);
  const junkInSnap = Object.values(jr.snapshots.hand).some(v => (v || []).some(c => /gemglow/i.test(c)));
  assert(!junkInSnap, 'assainissement: artefact HexagonRedGemGlow retiré des instantanés de main');
  assert(!jr.handTimeline.some(h => (h.cards || []).some(c => /gemglow/i.test(c))), 'assainissement: artefact retiré de la HAND TIMELINE');
  // L'instantané parasite (parasite SEUL) devient null → repli, pas une main d'équipement.
  eq(jr.snapshots.hand['Opp#2'], null, 'assainissement: instantané vidé par le filtrage → null (repli)');
  const jrSteps = BR.buildTimeline(jr).steps;
  assert(!jrSteps.some(s => (s.state.meHandCards || []).some(c => /gemglow/i.test(c))), 'assainissement: aucune étape n\'affiche l\'artefact en main');
  // Main de début de tour visible : Burn Bare est en main sur la bannière AVANT
  // d'être jouée (constat 3 — carte jamais vue en main).
  const meBanner = jrSteps.find(s => s.stage.type === 'banner' && /Ton tour|Début/.test(s.stage.big) && (s.state.meHandCards || []).indexOf('Burn Bare') >= 0);
  assert(meBanner && meBanner.state.meHandCards.indexOf('Scour') >= 0, 'main visible: Burn Bare ET Scour présents sur la bannière de début de tour');
})();

// ---------- Formes de héros par tour (Arakni se transforme) ----------
console.log('Hero forms —');
(function () {
  const rawHF = [
    '=== Talishar game 999 — test ===',
    '',
    '🎲 you rolled 5 and Gravy Bones rolled 3.',
    "Arakni Marionette's turn 1 has begun.",
    'Arakni Marionette played Sharpen',
    "Gravy Bones's turn 2 has begun.",
    'Gravy Bones played Rig',
    "Arakni Orb Weaver's turn 3 has begun.",
    'Arakni Orb Weaver played Web',
    'Arakni Orb Weaver (Zup) won! 🎉',
    '',
    '=== HERO FORMS (forme du héros par tour : toi | adversaire) ===',
    '[Arakni Marionette #1] me: Arakni, Marionette | opp: Gravy Bones, Shipwrecked Looter',
    '[Arakni Orb Weaver #3] me: Arakni, Orb Weaver | opp: Gravy Bones, Shipwrecked Looter',
  ].join('\n');
  const hf = Parser.parse(rawHF);
  // Nom de héros avec virgule (« Arakni, Marionette ») : surtout PAS de split.
  eq((hf.snapshots.heroForm['Arakni Marionette#1'] || {}).me, 'Arakni, Marionette', 'hero forms: forme de départ, virgule préservée');
  eq((hf.snapshots.heroForm['Arakni Orb Weaver#3'] || {}).me, 'Arakni, Orb Weaver', 'hero forms: forme après transformation captée');
  const t3 = (hf.turns || []).find(t => t.turnNumber === 3);
  assert(t3 && t3.heroForm && t3.heroForm.me === 'Arakni, Orb Weaver', 'hero forms: forme attachée au bon tour');
})();

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

  // RECOUSE du chatLog BRUT (v1.25) : le grabber accumule la fenêtre chatLog
  // verbatim tick-par-tick avec CETTE MÊME fonction. Le tampon roulant borné de
  // Talishar fait glisser la fenêtre (tours anciens qui sortent) ; l'accumulation
  // doit reconstituer le chatLog COMPLET (sinon couleurs des 1ers tours perdues).
  const w1 = ['[[TURN_START:1:1]]', 'P1 played Foo', 'P1 pitched Bar'];
  const w2 = ['P1 pitched Bar', '[[TURN_START:2:1]]', 'P2 played Baz'];        // glisse d'1 cran
  const w3 = ['[[TURN_START:2:1]]', 'P2 played Baz', '[[TURN_START:3:1]]'];    // glisse encore
  eq(run([w1, w1, w2, w3]).join('|'),
    '[[TURN_START:1:1]]|P1 played Foo|P1 pitched Bar|[[TURN_START:2:1]]|P2 played Baz|[[TURN_START:3:1]]',
    'raw: fenêtres chatLog glissantes recousues → chatLog complet (tous tours)');

  // ── stitchAdopt : adoption du chatLog sans perdre les 1ers tours (anti-troncature).
  const sa0 = src.indexOf('function stitchAdopt');
  const sabs = src.indexOf('{', sa0);
  let sad = 0, sa1 = sabs;
  for (; sa1 < src.length; sa1++) { const c = src[sa1]; if (c === '{') sad++; else if (c === '}' && --sad === 0) { sa1++; break; } }
  const stitchAdopt = eval('(' + src.slice(sa0, sa1) + ')');
  // Fenêtre chatLog TRONQUÉE (démarre au tour 3) alors que l'accumulé a les tours
  // 1-2 → on préserve le préfixe puis on bascule (bug : la partie « commençait au
  // tour 3 »). Aucune duplication (pas de chevauchement de n° de tour).
  const capPrefix = ["Alpha's turn 1 has begun.", 'Alpha played A', "Beta's turn 2 has begun.", 'Beta played B'];
  const visTrunc = ["Alpha's turn 3 has begun.", 'Alpha played C'];
  eq(stitchAdopt(capPrefix, visTrunc).join('|'), capPrefix.concat(visTrunc).join('|'),
    'stitchAdopt: fenêtre chatLog tronquée → préfixe (tours 1-2) préservé + fenêtre');
  // Chevauchement complet (le chatLog démarre AUSSI au tour 1) → on adopte la
  // fenêtre seule, pas de doublon des premiers tours.
  const visFull = ["Alpha's turn 1 has begun.", 'Alpha played A', "Beta's turn 2 has begun.", 'Beta played B', "Alpha's turn 3 has begun."];
  eq(stitchAdopt(capPrefix, visFull).join('|'), visFull.join('|'),
    'stitchAdopt: chatLog complet (démarre au tour 1) → adopté seul (aucun doublon)');
  // Chevauchement PARTIEL : accumulé tours 1-5, fenêtre tours 3-4 → on garde 1-2
  // puis la fenêtre (3-4), sans dupliquer 3.
  const capLong = ["A's turn 1 has begun.", "A's turn 2 has begun.", "A's turn 3 has begun.", "A's turn 4 has begun.", "A's turn 5 has begun."];
  const visMid = ["A's turn 3 has begun.", "A's turn 4 has begun."];
  eq(stitchAdopt(capLong, visMid).join('|'), ["A's turn 1 has begun.", "A's turn 2 has begun.", "A's turn 3 has begun.", "A's turn 4 has begun."].join('|'),
    'stitchAdopt: chevauchement partiel → préfixe (1-2) + fenêtre (3-4), tour 3 non dupliqué');
  // Format DOM (« Turn N<joueur> ») pour l'accumulé, chatLog pour la fenêtre.
  eq(stitchAdopt(['Turn 1Alpha', 'Alpha played A'], visTrunc).join('|'), ['Turn 1Alpha', 'Alpha played A'].concat(visTrunc).join('|'),
    'stitchAdopt: préfixe au format DOM (Turn N<joueur>) reconnu et préservé');
  // Accumulé vide → adopte la fenêtre.
  eq(stitchAdopt([], visTrunc).join('|'), visTrunc.join('|'), 'stitchAdopt: accumulé vide → fenêtre');

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

  // ── Pseudos : « adversaire non nommé » (your opponent) ne bloque plus l'envoi.
  // On extrait les 2 helpers PURS du userscript (slice+eval, comme mergeLines).
  const evalFn = name => {
    const s0 = src.indexOf('function ' + name);
    const sbs = src.indexOf('{', s0);
    let d = 0, s1 = sbs;
    for (; s1 < src.length; s1++) { const c = src[s1]; if (c === '{') d++; else if (c === '}' && --d === 0) { s1++; break; } }
    return eval('(' + src.slice(s0, s1) + ')');
  };
  const isPlaceholderName = evalFn('isPlaceholderName');
  const isUiGarbageName = evalFn('isUiGarbageName');

  // Placeholder = libellé générique quand le pseudo n'est pas exposé (à nuller).
  eq(isPlaceholderName('your opponent'), true, 'placeholder: « your opponent »');
  eq(isPlaceholderName('You'), true, 'placeholder: « You » (insensible casse)');
  eq(isPlaceholderName(' opponent '), true, 'placeholder: espaces tolérés');
  eq(isPlaceholderName('Waouh'), false, 'placeholder: vrai pseudo « Waouh » non touché');
  eq(isPlaceholderName('SpicyNoodles'), false, 'placeholder: vrai pseudo « SpicyNoodles » non touché');
  eq(isPlaceholderName(null), false, 'placeholder: null → false');

  // UI garbage = vrai signe de capture dégradée (à bloquer). « your opponent »
  // n'en fait PLUS partie → ne bloque plus.
  eq(isUiGarbageName('your opponent'), false, 'ui-garbage: « your opponent » ne bloque plus');
  eq(isUiGarbageName('you'), false, 'ui-garbage: « you » ne bloque plus');
  eq(isUiGarbageName('PRIORITY'), true, 'ui-garbage: « PRIORITY » bloque toujours');
  eq(isUiGarbageName("Unknown's Turn"), true, 'ui-garbage: « Unknown’s Turn » bloque toujours');
  eq(isUiGarbageName('Betsy'), false, 'ui-garbage: vrai pseudo non bloqué');

  // Intention (le bug corrigé) : une partie complète dont l'adversaire est
  // « your opponent » ne doit produire AUCUN issue de pseudo.
  const nameIssues = ['your opponent', 'SpicyNoodles'].filter(n => isUiGarbageName(n));
  eq(nameIssues.length, 0, 'régression 1946448: « your opponent » n’ajoute plus d’issue → envoi débloqué');
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

// ---------- Garde-fou : nom de héros incohérent avec son ID ----------
// Observé sur 2 parties réelles distinctes de ZUP (#1683807, #1678913) : une
// capture dégradée avait recopié le héros du MAUVAIS camp dans le nom affiché,
// alors que l'ID (fiable) restait correct. Contrairement au diagnostic de
// santé général, CE cas-là peut survenir sur une partie par ailleurs SAINE
// (#1683807 : 29 tours, rien à redire côté log) → on corrige juste le
// libellé (dérivé de l'ID) sans exclure la partie du dashboard (warning, pas
// health.ok=false).
console.log('Garde-fou nom/id héros —');
(function () {
  const mkMetaRaw = (my, opp) => '=== Talishar game 1 — test ===\n\n'
    + "Me's turn 1 has begun.\nMe played X\nOpp took 1 damage\nOpp's turn 1 has begun.\nOpp played Y\n"
    + '\n=== META ===\nme: Me\nopponent: Opp\nmy_hero: ' + my + '\nopp_hero: ' + opp + '\n';
  const bad = Parser.parse(mkMetaRaw(
    'Oscilio, Constella Intelligence (oscilio_constella_intelligence)',
    'Oscilio, Constella Intelligence (arakni_huntsman)'
  ));
  eq(bad.matchup, 'Oscilio, Constella Intelligence vs Arakni Huntsman', 'nom/id : libellé corrigé depuis l\'ID (adversaire)');
  assert(bad.warnings.some(w => /incohérent/.test(w)), 'nom/id : avertissement émis (pas health.ok=false)');
  assert(bad.health.ok === true, 'nom/id : partie par ailleurs saine → PAS exclue du dashboard');
  // Faux positifs à éviter : diacritique isolé (Jarl Vetreiði), apostrophes
  // (Maxx 'The Hype' Nitro), et ID « numéro de carte » (ELE001, sans rapport
  // textuel avec le nom — format legacy, ne doit jamais être comparé).
  const okDiacritic = Parser.parse(mkMetaRaw('Jarl Vetreiði (jarl_vetreidi)', 'Fai Rising Rebellion (fai_rising_rebellion)'));
  assert(!okDiacritic.warnings.some(w => /incohérent/.test(w)), 'nom/id : accent isolé (Vetreiði) → pas de faux positif');
  const okApostrophe = Parser.parse(mkMetaRaw("Maxx 'The Hype' Nitro (maxx_the_hype_nitro)", 'Briar (briar)'));
  assert(!okApostrophe.warnings.some(w => /incohérent/.test(w)), 'nom/id : apostrophes → pas de faux positif');
  const okCardNumber = Parser.parse(mkMetaRaw('Briar (ELE001)', 'Briar (ELE001)'));
  assert(!okCardNumber.warnings.some(w => /incohérent/.test(w)), 'nom/id : ID numéro de carte (legacy) jamais comparé');
})();

// ---------- Régression : capture fantôme réelle (ZUP, game #1750820) ----------
// Une même partie (Arakni, Marionette vs Valda) capturée 2 FOIS côté grabber :
// #1750692 saine, puis #1750820 22 min plus tard depuis un état Talishar
// dégradé (probablement l'écran replay/résumé) — méta polluée par du TEXTE D'UI
// (« Unknown's Turn », « PRIORITY ») scrapé comme pseudos. C'est CE signal (et
// non le format de tour) qui distingue un fantôme d'une vraie capture en repli
// DOM : les séparateurs MAJUSCULES « TURN N <joueur> » sont désormais reconnus
// (game 1977204, légitime), donc le rejet passe par le nom d'UI parasite (santé,
// test F). Extrait AUTHENTIQUE du vrai log. Doit rester exclu du dashboard.
console.log('Capture fantôme (ZUP #1750820) —');
(function () {
  const ghostBody = [
    "your opponent activated Hunter's Klaive",
    "🎯Valda, Seismic Impact was chosen as the target.",
    'your opponent pitched Under the Trap-Door',
    "Resolving activated ability of Hunter's Klaive.",
    'you passed',
    'your opponent activated Flick Knives',
    "you is about to take 1 damage from Hunter's Klaive",
    'you took 1 damage',
    'you played Sink Below',
    'Resolving play ability of Sink Below.',
    'your opponent passed (x2)',
    'TURN 1 you',
    'you activated Tectonic Plating',
    'you pitched Roiling Fissure',
    'your opponent passed (x2)',
    'TURN 1 your opponent',
    'your opponent played Cut'
  ];
  for (let k = 0; k < 15; k++) ghostBody.push('your opponent played Filler Card ' + k, 'you took 1 damage');
  const ghostRaw = '=== Talishar game 1750820 — test ===\n\n' + ghostBody.join('\n')
    + '\n\n=== META ===\nme: Unknown\'s Turn\nopponent: PRIORITY\n'
    + 'my_hero: Arakni, Marionette (arakni_marionette)\nopp_hero: Arakni, Marionette (valda_seismic_impact)\n';
  const ghost = Parser.parse(ghostRaw);
  assert(ghost.health.ok === false, 'fantôme ZUP : health.ok=false (nom d’UI parasite en méta)');
  assert(ghost.health.issues.some(i => /suspect|UI|replay/i.test(i)), 'fantôme ZUP : le message pointe le nom d’UI parasite');

  const ghostEntries = [
    { gameId: '1750692', record: mkRec({ iWon: true, myHero: 'Arakni, Marionette', oppHero: 'Valda, Seismic Impact', date: '2026-07-22T22:28:31Z' }) },
    { gameId: '1750820', record: ghost }
  ];
  const ghostAgg = Dashboard.aggregate(ghostEntries, {});
  eq(ghostAgg.global.games, 1, 'dashboard : la capture fantôme est exclue de l\'agrégation (1 partie sur 2)');
})();

// ---------- Régression : faux joueur « <Carte> was played… » (game #1906667) ----------
// Quand l'adversaire pose une carte en OUVERTURE (avant le tour 1 local), la
// ligne SYSTÈME « <Carte> was played with a cost of N. » matche actionNameRe
// (via « played ») et injectait un faux joueur « <Carte> was » dans `names`.
// Ce fantôme, ajouté AVANT le vrai héros local, était alors choisi comme myName
// → le tour local n'était plus dans `known` → health.ok=false → partie masquée
// du dashboard (cas réel Oscilio vs Valda). Le garde-fou « / was$/ » l'exclut.
console.log('Faux joueur "<Carte> was played…" (#1906667) —');
(function () {
  const raw = '=== Talishar game 1906667 — test ===\n\n'
    + 'Valda Seismic Impact played Imposing Visage\n'
    + 'Valda Seismic Impact pitched Aftershock\n'
    + 'Imposing Visage was played with a cost of 3.\n'
    + 'Resolving play ability of Imposing Visage.\n'
    + 'Valda Seismic Impact passed\n'
    + 'Oscilio Constella Intelligence\'s turn 1 has begun.\n'
    + 'Oscilio Constella Intelligence played Scour\n'
    + 'Scour was played with a cost of 3.\n'
    + 'Valda Seismic Impact took 3 damage\n'
    + 'Valda Seismic Impact\'s turn 1 has begun.\n'
    + 'Valda Seismic Impact played Crash and Bash\n'
    + 'Valda Seismic Impact conceded the game.\n'
    + 'Oscilio Constella Intelligence (Ehecalt) won! 🎉\n'
    + '\n=== META ===\nme: Oscilio Constella Intelligence\nopponent: Valda Seismic Impact\n'
    + 'my_hero: Oscilio, Constella Intelligence (oscilio_constella_intelligence)\n'
    + 'opp_hero: Valda Seismic Impact (valda_seismic_impact)\n';
  const rec = Parser.parse(raw);
  assert(rec.health.ok === true, 'faux joueur "was" : partie saine → PAS exclue du dashboard');
  eq(rec.myName, 'Oscilio Constella Intelligence', 'faux joueur "was" : myName = héros local (pas « Imposing Visage was »)');
  assert(rec.myName !== 'Imposing Visage was' && rec.oppName !== 'Imposing Visage was', 'faux joueur "was" : le fantôme n\'est jamais un joueur');
  assert(rec.result && rec.result.iWon === true, 'faux joueur "was" : victoire correctement attribuée au joueur local');
})();

// ---------- Bugs vue Table (game 1930124, Oscilio vs Hala) ----------
console.log('Bugs Table 1930124 —');

// A+B+D+G — Tour adverse où le DÉFENSEUR (moi) réagit en brûlant l'attaquant à
// l'arcane, active Volzar (arme-buff, loggée APRÈS le sort) et se soigne (Sigil) :
//  · les réactions d'arcane/soin s'affichent en ÉTAPES PROPRES (pas noyées nues
//    dans la rangée « réactions » du clash) ;
//  · Volzar est RÉORDONNÉ juste AVANT le sort qu'il renforce ;
//  · le gain de vie porte « heal ».
const t1930 = BR.buildTimeline({
  myName: 'Osc', oppName: 'Hala',
  players: { me: { hero: 'Osc', equipment: { weaponL: { name: 'Volzar Meteor Storm' } } }, opp: { hero: 'Hala', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  turns: [{ player: 'Hala', label: 'Hala — Tour 1', turnNumber: 1, hand: [], arsenal: [],
    chain: [{ turn: 'Hala#1', card: 'Command and Conquer', power: 6, defense: 0, kw: [] }],
    events: [
      { type: 'played', player: 'Hala', card: 'Command and Conquer', _idx: 0 },
      { type: 'played', player: 'Osc', card: 'Echoflash', _idx: 1 },
      { type: 'arcaneDamage', dealer: 'Osc', source: 'Echoflash', amount: 1, actual: true, _idx: 2 },
      { type: 'damageTaken', player: 'Hala', amount: 1, _idx: 3 },
      { type: 'played', player: 'Osc', card: 'Constella Contemplation', _idx: 4 },
      { type: 'activated', player: 'Osc', card: 'Volzar, Meteor Storm', _idx: 5 },        // arme-buff loggée APRÈS le sort
      { type: 'arcaneDamage', dealer: 'Osc', source: 'Constella Contemplation', amount: 2, actual: true, _idx: 6 },
      { type: 'damageTaken', player: 'Hala', amount: 2, _idx: 7 },
      { type: 'played', player: 'Osc', card: 'Sigil of Solace', _idx: 8 },
      { type: 'lifeGained', player: 'Osc', amount: 3, _idx: 9 },
      { type: 'damageTaken', player: 'Osc', amount: 6, _idx: 10 },   // « took 6 damage » du coup encaissé
      { type: 'combatResult', hit: true, amount: 6, _idx: 11 }
    ] }]
});
const st1930 = t1930.steps.map(s => s.stage);
const echoStep = st1930.find(s => s.type === 'play' && s.card && s.card.nm === 'Echoflash');
assert(echoStep && echoStep.dmg === 1 && echoStep.reaction, 'défenseur arcane : Echoflash en étape propre avec ses dégâts (1)');
const constStep = st1930.find(s => s.type === 'play' && s.card && s.card.nm === 'Constella Contemplation');
assert(constStep && constStep.dmg === 2, 'défenseur arcane : Constella Contemplation en étape propre (dégât 2)');
const sigilStep = st1930.find(s => s.type === 'play' && s.card && s.card.nm === 'Sigil of Solace');
assert(sigilStep && sigilStep.heal === 3, 'gain de vie : Sigil of Solace porte « heal » (+3)');
const clash1930 = st1930.find(s => s.type === 'clash');
assert(clash1930 && !(clash1930.reactions || []).some(r => /Echoflash|Constella|Sigil/.test(r.nm)), 'défenseur arcane : les réactions à effet ne restent PAS nues dans le clash');
const iVolzar = st1930.findIndex(s => s.type === 'play' && s.card && /Volzar/.test(s.card.nm));
const iConst = st1930.findIndex(s => s.type === 'play' && s.card && s.card.nm === 'Constella Contemplation');
assert(iVolzar >= 0 && iConst >= 0 && iVolzar < iConst, 'Volzar : affiché AVANT le sort qu\'il renforce');
// Vie : Hala −1 −2 (arcane) = 37 ; moi +3 (Sigil) −6 (C&C) = 37 en fin de tour.
const last1930 = t1930.steps.slice(-1)[0];
eq(last1930.state.life.opp, 37, 'arcane défenseur : vie adverse à jour (−3)');
eq(last1930.state.life.me, 37, 'gain de vie appliqué mid-tour (+3) puis coup encaissé (−6)');

// G — Un tour SANS aucun jeu (que des passes) le signale dans la bannière.
const passTl = BR.buildTimeline({
  myName: 'Osc', oppName: 'Hala',
  players: { me: { hero: 'Osc', equipment: {} }, opp: { hero: 'Hala', equipment: {} } },
  lifeSeries: { me: [40, 40, 40], opp: [40, 40, 40] },
  turns: [
    { player: 'Hala', label: 'Hala — Tour 1', turnNumber: 1, hand: [], arsenal: [], events: [{ type: 'played', player: 'Hala', card: 'Sink Below', _idx: 0 }] },
    { player: 'Osc', label: 'Osc — Tour 1', turnNumber: 1, hand: [], arsenal: [], events: [{ type: 'passed', player: 'Osc', _idx: 1 }] }
  ]
});
const passBanner = passTl.steps.find(s => s.stage.type === 'banner' && s.turn.indexOf('Osc') >= 0);
assert(passBanner && /passe/.test(passBanner.stage.sub), 'tour sans action : la bannière signale « passe »');

// C — Undo CONSENTI dont l'action annulée appartient à l'AUTRE joueur que le
// demandeur (Hala demande, l'activation de Volzar d'Osc est annulée) : une seule
// activation restante ET une seule ligne d'arcane menacée (pas 6+6=12).
const undoOtherRaw = [
  '=== Talishar game 80 — test ===', '',
  "Osc's turn 1 has begun.",
  'Osc played Meteoric Impact',
  'Osc activated Volzar, Meteor Storm',
  'Meteoric Impact is dealing 6 arcane damage',
  'Hala requests to undo the last action',
  'Osc allowed undoing the last action',
  'Osc activated Volzar, Meteor Storm',
  'Meteoric Impact is dealing 6 arcane damage',
  'Osc is dealing 6 arcane damage from Meteoric Impact',
  'Hala took 6 damage',
  '', '=== META ===', 'me: Osc', 'opp: Hala'
].join('\n');
const uor = Parser.parse(undoOtherRaw);
const uot1 = uor.turns.find(t => t.turnNumber === 1);
eq((uot1.events || []).filter(e => e.type === 'activated' && /Volzar/.test(e.card)).length, 1, 'undo consenti (action adverse) : une seule activation Volzar');
eq((uot1.events || []).filter(e => e.type === 'arcaneDamage' && !e.actual).length, 1, 'undo consenti (action adverse) : une seule ligne d\'arcane menacée (pas doublée)');

// F — Main RÉCONCILIÉE : un instantané périmé du grabber liste encore une carte que
// J'AI déjà jouée (réaction de défense non re-captée) → elle est retirée de la main.
const reconcileTl = BR.buildTimeline({
  myName: 'Osc', oppName: 'Hala',
  players: { me: { hero: 'Osc', equipment: {} }, opp: { hero: 'Hala', equipment: {} } },
  lifeSeries: { me: [40, 40], opp: [40, 40] },
  handTimeline: [{ pos: 1, cards: ['Shelter from the Storm', 'Sink Below'] }],   // périmé : Shelter encore listée
  turns: [{ player: 'Hala', label: 'Hala — Tour 1', turnNumber: 1, hand: ['Shelter from the Storm', 'Sink Below'], arsenal: [],
    chain: [{ turn: 'Hala#1', card: 'Zenith Blade', power: 5, defense: 0, kw: [] }],
    events: [
      { type: 'activated', player: 'Hala', card: 'Zenith Blade', _idx: 2 },
      { type: 'played', player: 'Osc', card: 'Shelter from the Storm', _idx: 5 },   // jouée APRÈS l'instantané (pos 1)
      { type: 'combatResult', hit: false, _idx: 8 }
    ] }]
});
const lastRec = reconcileTl.steps.slice(-1)[0];
assert(lastRec.state.meHandCards.indexOf('Shelter from the Storm') < 0, 'réconciliation main : la carte déjà jouée est retirée de la main affichée');
assert(lastRec.state.meHandCards.indexOf('Sink Below') >= 0, 'réconciliation main : les cartes non jouées restent en main');

// ---------- Bugs Table 1945057 (Oscilio vs Arakni qui se transforme) ----------
console.log('Bugs Table 1945057 —');
(function () {
  // A — Résolution d'instantané TOLÉRANTE À LA FORME : l'en-tête de tour porte le
  // nom figé (« Arakni Trap Door »), les libellés d'instantanés la forme du moment
  // (« Arakni Marionette #1 »). La clé exacte échoue → on retombe par côté+tour.
  const formRaw = [
    '=== Talishar game 100 — test ===', '',
    "Arakni Trap Door's turn 1 has begun.",
    'Arakni Trap Door played Kiss of Death',
    "Oscilio's turn 1 has begun.",
    'Oscilio played Burn Bare',
    '', '=== HAND SNAPSHOTS ===',
    '[Arakni Marionette #1] Comet Storm, Shelter, Sigil, Swell',   // libellé = forme du moment
    '[Oscilio #1] Alpha, Beta',
    '', '=== ARSENAL SNAPSHOTS ===',
    '[Arakni Marionette #1] Burn Bare',
    '[Oscilio #1] (vide)',
    '', '=== HERO FORMS (forme du héros par tour : toi | adversaire) ===',
    '[Arakni Marionette #1] me: Oscilio | opp: Arakni Marionette',
    '[Oscilio #1] me: Oscilio | opp: Arakni Marionette',
    '', '=== META ===', 'me: Oscilio', 'opp: Arakni Trap Door',
    'my_hero: Oscilio (oscilio)', 'opp_hero: Arakni, Marionette (arakni_marionette)'
  ].join('\n');
  const formRec = Parser.parse(formRaw);
  const arakT1 = formRec.turns.find(t => t.player === 'Arakni Trap Door' && t.turnNumber === 1);
  assert(arakT1 && Array.isArray(arakT1.hand) && arakT1.hand.length === 4,
    'instantané par forme : main de début de tour adverse résolue malgré le nom de forme différent (bug 1)');
  assert(arakT1 && Array.isArray(arakT1.arsenal) && arakT1.arsenal.indexOf('Burn Bare') >= 0,
    'instantané par forme : arsenal (Burn Bare) résolu malgré le nom de forme différent (bug 2)');

  // B — Combat INTERROMPU par un abandon (aucun « Combat resolved ») : l'échange
  // doit quand même être rendu, avec la puissance de chaîne (11) et le bloc
  // ÉQUIPEMENT (Crown of Providence) — sinon tous deux perdus (bugs 5 & 6).
  const concedeTl = BR.buildTimeline({
    myName: 'Osc', oppName: 'Arak',
    players: { me: { hero: 'Osc', equipment: { head: { name: 'Crown of Providence' } } }, opp: { hero: 'Arak', equipment: {} } },
    lifeSeries: { me: [40], opp: [40] },
    turns: [{ player: 'Arak', label: 'Arak — Tour 4', turnNumber: 4, hand: [], arsenal: [],
      chain: [{ turn: 'Arak#4', card: 'Kiss of Death', power: 11, defense: 6, kw: [] }],
      events: [
        { type: 'played', player: 'Arak', card: 'Kiss of Death', _idx: 1 },
        { type: 'blocked', player: 'Osc', cards: ['Crown of Providence'] },
        { type: 'conceded', player: 'Arak', _idx: 3 }
      ] }]
  });
  const interClash = concedeTl.steps.map(s => s.stage).find(st => st.type === 'clash' && st.verdict === 'interrupted');
  assert(interClash, 'combat interrompu : un échange « interrupted » est rendu malgré l\'abandon (bug 5)');
  assert(interClash && interClash.atk.nm === 'Kiss of Death' && interClash.atk.power === 11,
    'combat interrompu : puissance effective de chaîne (11) conservée (bug 6)');
  assert(interClash && interClash.blocks.some(b => b.nm === 'Crown of Providence'),
    'combat interrompu : le bloc ÉQUIPEMENT (Crown of Providence) est affiché en défense (bug 5)');

  // C — Transfo de DÉBUT de tour : elle porte la main de DÉBUT de tour (comme la
  // bannière), pas une main intermédiaire de la HAND TIMELINE (bug 3 : plus de
  // flicker 2→3). L'étape transfo est marquée startOfTurn.
  const transHandTl = BR.buildTimeline({
    myName: 'Osc', oppName: 'Arak',
    players: { me: { hero: 'Osc', equipment: {} }, opp: { hero: 'Arakni, Trap-Door', equipment: {} } },
    lifeSeries: { me: [40, 40], opp: [40, 40] },
    handTimeline: [{ pos: 3, cards: ['Solo'] }, { pos: 11, cards: ['A', 'B', 'C'] }],
    turns: [
      { player: 'Arak', label: 'Arak — Tour 3', turnNumber: 3, hand: [], arsenal: [],
        heroForm: { me: 'Osc', opp: 'Arakni, Trap-Door' },   // = forme courante → pas de transfo ici
        events: [{ type: 'played', player: 'Arak', card: 'Zap', _idx: 4 }] },
      { player: 'Osc', label: 'Osc — Tour 4', turnNumber: 4, hand: ['A', 'B', 'C'], arsenal: [],
        heroForm: { me: 'Osc', opp: 'Arakni, Marionette' },   // Trap-Door → Marionette au début de MON tour
        events: [{ type: 'played', player: 'Osc', card: 'A', _idx: 12 }] }
    ]
  });
  const startTrans = transHandTl.steps.find(s => s.stage.type === 'transform' && s.stage.startOfTurn);
  assert(startTrans && /Marionette/.test(startTrans.stage.sub), 'transfo début de tour : marquée startOfTurn (Trap-Door → Marionette)');
  eq(startTrans.state.meHandCards.length, 3, 'transfo début de tour : montre la main de début de tour (3), pas une main intermédiaire (bug 3)');
})();

// ---------- FIELD TIMELINE : terrain fidèle par position (jetons éphémères) ----------
console.log('Field timeline —');
(function () {
  const ftRaw = [
    '=== Talishar game 101 — test ===', '',
    'Me played Turn to Mindfire',
    'Me played Snapback',
    '', '=== FIELD TIMELINE (terrain, à chaque changement | pos = ligne de log) ===',
    '[0] me: (vide) | opp: (vide)',
    '[1] me: Ponder | opp: (vide)',
    '[2] me: (vide) | opp: (vide)',
    ''
  ].join('\n');
  const ftRec = Parser.parse(ftRaw);
  eq(ftRec.fieldTimeline.length, 3, 'FIELD TIMELINE : 3 entrées parsées');
  eq(ftRec.fieldTimeline[1].me.join(','), 'Ponder', 'FIELD TIMELINE : jeton éphémère capté (me: Ponder)');
  // Override dans buildTimeline : tokens d'une étape = dernier instantané pos ≤ _idx+1.
  const ftGame = {
    myName: 'Me', oppName: 'Opp',
    players: { me: { hero: 'Osc', equipment: {} }, opp: { hero: 'Arak', equipment: {} } },
    lifeSeries: { me: [40], opp: [40] },
    fieldTimeline: [{ pos: 0, me: [], opp: [] }, { pos: 1, me: ['Ponder'], opp: [] }, { pos: 2, me: [], opp: [] }],
    turns: [{ player: 'Me', label: 'Me — Tour 1', hand: [], arsenal: [], events: [
      { type: 'played', player: 'Me', card: 'Turn to Mindfire', _idx: 0 },
      { type: 'played', player: 'Me', card: 'Snapback', _idx: 1 }
    ] }]
  };
  const ftSteps = BR.buildTimeline(ftGame).steps;
  const tmStep = ftSteps.find(s => s.stage.type === 'play' && s.stage.card.nm === 'Turn to Mindfire');
  assert(tmStep && (tmStep.state.meTokens || []).indexOf('Ponder') >= 0,
    'FIELD TIMELINE : le jeton créé (Ponder) apparaît sur l\'étape correspondante (bug 4)');
  // Sans FIELD TIMELINE (vieux logs) : repli sans erreur, pas de surcharge.
  const ftNone = BR.buildTimeline(Object.assign({}, ftGame, { fieldTimeline: [] }));
  assert(ftNone.steps.length > 0, 'FIELD TIMELINE absente : repli sans erreur');
})();

// ---------- Bilan ----------
console.log('\n' + passed + ' assertions OK, ' + failed + ' échec(s).');
process.exit(failed ? 1 : 0);
