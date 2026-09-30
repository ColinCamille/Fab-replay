#!/usr/bin/env python3
"""Meilleurs joueurs d'un héros (données FaB Insights) + leurs listes, et comparaison
avec ta liste.

Source : API FaB Insights (https://github.com/AnoAn/talishar-data-downloader) —
un CSV par jour et par format, toutes les parties Talishar. Clé dans
$FABINSIGHTS_API_KEY (en-tête x-functions-key).

L'API ne filtre pas par héros : on télécharge chaque CSV quotidien (~50-150 Mo),
on n'en garde que les parties du héros demandé (cache JSONL compact par
héros/jour/format), puis on supprime le CSV. Les jours déjà en cache ne sont
pas re-téléchargés. Le jour courant (incomplet) n'est jamais mis en cache.

Limites des données : seul le deck de 60 JOUÉ dans chaque partie est connu (pas
la liste de 80) → la « réserve » est reconstituée à partir de toutes les
parties du joueur. Les pseudos sont hachés (SHA-256) : stables, mais anonymes.
"""
import argparse, ast, collections as C, concurrent.futures as cf, csv, datetime as dt
import json, os, re, sys, tempfile, urllib.request

API = 'https://fab-insights.azurewebsites.net/api/v1/download_csv'
FORMATS = {'0': 'CC', '1': 'CC compétitif', '2': 'Blitz', '3': 'Blitz compétitif',
           '4': 'Open CC', '5': 'Commoner', '8': 'LL CC', '9': 'LL Blitz',
           '13': 'LL compétitif', '14': 'Silver Age', '15': 'Silver Age compétitif',
           '16': 'Open Silver Age', '-1': 'Clash'}
PITCH = {'red': '🔴', 'yellow': '🟡', 'blue': '🔵'}
csv.field_size_limit(10**9)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def norm(name):
    """« Fyendal's Spring Tunic » / « Art of the Phoenix: War » → identifiant Talishar."""
    s = name.lower().replace("'", '').replace('’', '')
    return re.sub(r'[^a-z0-9]+', '_', s).strip('_')


def pretty(cid):
    base, _, col = cid.rpartition('_')
    if col in PITCH:
        return base.replace('_', ' ').title(), PITCH[col]
    return cid.replace('_', ' ').title(), ''


# ---------- téléchargement + cache ----------

def fetch_day(date, fmt, hero, cache, key, tries=3):
    # Le proxy / le blob Azure coupent parfois la connexion → quelques tentatives.
    for i in range(tries):
        try:
            return _fetch_day(date, fmt, hero, cache, key)
        except Exception as e:
            log(f'  ! {date} fmt {fmt} : {e} (tentative {i + 1}/{tries})')
    return None


def _fetch_day(date, fmt, hero, cache, key):
    out = os.path.join(cache, hero, f'{date}_{fmt}.jsonl')
    today = dt.date.today().isoformat()
    if os.path.exists(out) and date != today:
        return out
    req = urllib.request.Request(f'{API}?format={fmt}&date={date}', headers={'x-functions-key': key})
    meta = json.load(urllib.request.urlopen(req, timeout=60))
    fd, tmp = tempfile.mkstemp(suffix='.csv', dir=cache)
    os.close(fd)
    try:
        urllib.request.urlretrieve(meta['download_url'], tmp)
        rows = []
        with open(tmp, newline='') as f:
            for r in csv.DictReader(f):
                j1, j2 = r['deck1_json'], r['deck2_json']
                if f"'playerHero': '{hero}'" not in j1 and f"'playerHero': '{hero}'" not in j2:
                    continue
                try:
                    a, b = ast.literal_eval(j1), ast.literal_eval(j2)
                except Exception:
                    continue
                for me, op, idx in ((a, b, 1), (b, a, 2)):
                    if me.get('playerHero') != hero or not me.get('cardResults'):
                        continue
                    rows.append({
                        'gid': r['game_id'], 'date': date, 'fmt': fmt,
                        'won': me.get('winner') == idx, 'turns': me.get('turns'),
                        'player': r[f'player{idx}_name'], 'opp': op.get('playerHero'),
                        'deck': {c['cardId']: c['numCopies'] for c in me['cardResults']},
                        'equip': [c['cardId'] for c in me.get('character', [])[1:]],
                    })
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, 'w') as f:
            for x in rows:
                f.write(json.dumps(x) + '\n')
        log(f'  {date} {FORMATS.get(fmt, fmt)} : {len(rows)} parties')
        return out
    finally:
        os.remove(tmp)


def load(args, key):
    end = dt.date.fromisoformat(args.end) if args.end else dt.date.today() - dt.timedelta(days=1)
    days = [(end - dt.timedelta(days=i)).isoformat() for i in range(args.days)]
    jobs = [(d, f) for d in days for f in args.formats.split(',')]
    os.makedirs(os.path.join(args.cache, args.hero), exist_ok=True)
    with cf.ThreadPoolExecutor(args.workers) as ex:
        files = list(ex.map(lambda j: fetch_day(j[0], j[1], args.hero, args.cache, key), jobs))
    games = {}
    for fn in filter(None, files):
        for line in open(fn):
            g = json.loads(line)
            games[(g['gid'], g['player'])] = g  # l'export contient des doublons
    return list(games.values()), days


# ---------- analyse ----------

def mode_deck(gs):
    d, _ = C.Counter(json.dumps(sorted(g['deck'].items())) for g in gs).most_common(1)[0]
    return dict(json.loads(d))


def diff(main, deck):
    ins = {k: v - main.get(k, 0) for k, v in deck.items() if v > main.get(k, 0)}
    outs = {k: main[k] - deck.get(k, 0) for k in main if deck.get(k, 0) < main[k]}
    return ins, outs


def fmt_diff(d):
    return ', '.join(f'{v}× {pretty(k)[0]} {pretty(k)[1]}' for k, v in sorted(d.items())) or '—'


def read_compare(path):
    """Liste texte : « 3 Ignite (red) », « 3x Art of the Phoenix: War red », « 2 sink_below_red »…"""
    deck = {}
    for line in open(path):
        line = line.split('#')[0].strip()
        m = re.match(r'^(\d+)\s*x?\s+(.+)$', line, re.I)
        if not m:
            continue
        n, name = int(m.group(1)), m.group(2)
        col = re.search(r'\b(red|yellow|blue|rouge|jaune|bleu)\b', name, re.I)
        name = re.sub(r'[()\[\]]|\b(red|yellow|blue|rouge|jaune|bleu)\b', '', name, flags=re.I)
        cid = norm(name)
        if col:
            cid += '_' + {'rouge': 'red', 'jaune': 'yellow', 'bleu': 'blue'}.get(col.group(1).lower(), col.group(1).lower())
        deck[cid] = deck.get(cid, 0) + n
    return deck


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--hero', required=True, help='identifiant Talishar, ex. fai_rising_rebellion')
    ap.add_argument('--vs', help='héros adverse : config (side) de chaque top joueur contre lui')
    ap.add_argument('--days', type=int, default=21)
    ap.add_argument('--end', help='dernier jour AAAA-MM-JJ (défaut : hier)')
    ap.add_argument('--formats', default='0,1', help='codes format, défaut 0,1 (CC + CC compétitif)')
    ap.add_argument('--top', type=int, default=5)
    ap.add_argument('--min-games', type=int, default=15)
    ap.add_argument('--compare', help='fichier texte de TA liste (une carte par ligne : « 3 Ignite red »)')
    ap.add_argument('--game', help='game_id Talishar d\'une de tes parties : ta liste = le deck joué + tes stats')
    ap.add_argument('--cache', default=os.environ.get('FAB_INSIGHTS_CACHE', os.path.join(tempfile.gettempdir(), 'fab-insights-cache')))
    ap.add_argument('--workers', type=int, default=4)
    args = ap.parse_args()

    key = os.environ.get('FABINSIGHTS_API_KEY')
    if not key:
        sys.exit('FABINSIGHTS_API_KEY absent de l\'environnement.')
    log(f'Chargement {args.hero} sur {args.days} jours, formats {args.formats} (cache {args.cache})…')
    G, days = load(args, key)
    if not G:
        sys.exit(f'Aucune partie trouvée pour {args.hero}. Vérifie l\'identifiant (ex. fai_rising_rebellion).')

    P = C.defaultdict(list)
    for g in G:
        P[g['player']].append(g)
    base = sum(g['won'] for g in G) / len(G)
    me_hash, my_deck = None, None
    if args.game:
        mine = [g for g in G if g['gid'] == str(args.game)]
        if mine:
            me_hash, my_deck = mine[0]['player'], mine[0]['deck']
        else:
            log(f'  ! partie {args.game} introuvable pour {args.hero} sur la période.')
    if args.compare:
        my_deck = read_compare(args.compare)

    # classement : winrate lissé (bayésien, 20 parties « fictives » au winrate moyen du héros)
    ranked = sorted(((h, gs) for h, gs in P.items() if len(gs) >= args.min_games),
                    key=lambda x: -(sum(g['won'] for g in x[1]) + base * 20) / (len(x[1]) + 20))
    top = ranked[:args.top]
    L = 'ABCDEFGHIJ'

    print(f'# {pretty(args.hero)[0]} — meilleurs joueurs')
    print(f'\n{len(G)} parties, {days[-1]} → {days[0]}, formats : '
          + ', '.join(FORMATS.get(f, f) for f in args.formats.split(',')) + f'. Winrate moyen du héros : **{base:.0%}**.')
    print('Classement = winrate lissé (≥ %d parties). Pseudos hachés → lettres.\n' % args.min_games)
    print('| | Parties | WR | ' + (f'vs {pretty(args.vs)[0]} | ' if args.vs else '') + 'Équipement le plus porté |')
    print('|---|--:|--:|' + ('--:|' if args.vs else '') + '---|')
    for i, (h, gs) in enumerate(top):
        w = sum(g['won'] for g in gs)
        eq = C.Counter(tuple(g['equip']) for g in gs).most_common(1)[0][0]
        vs = ''
        if args.vs:
            v = [g for g in gs if g['opp'] == args.vs]
            vs = f'{sum(g["won"] for g in v)}/{len(v)} | '
        tag = ' (toi)' if h == me_hash else ''
        print(f'| **{L[i]}**{tag} | {len(gs)} | {w/len(gs):.0%} | {vs}{", ".join(pretty(e)[0] for e in eq)} |')
    if me_hash and me_hash not in [h for h, _ in top]:
        gs = P[me_hash]
        print(f'| Toi | {len(gs)} | {sum(g["won"] for g in gs)/len(gs):.0%} | ' + ('| ' if args.vs else '') + '|')

    # listes principales (+ config vs adversaire) côte à côte
    mains = [mode_deck(gs) for _, gs in top]
    cols = list(mains)
    heads = [L[i] for i in range(len(top))]
    if args.vs:
        for i, (h, gs) in enumerate(top):
            v = sorted((g for g in gs if g['opp'] == args.vs), key=lambda g: g['date'], reverse=True)
            if v:
                cols.append(v[0]['deck'])
                heads.append(f'{L[i]} vs')
    if my_deck:
        cols.append(my_deck)
        heads.append('Toi')
    order = {'red': 0, 'yellow': 1, 'blue': 2}
    cards = sorted(set().union(*cols), key=lambda c: (-sum(c in d for d in mains), order.get(c.rpartition('_')[2], 3), c))
    print('\n## Listes (deck de 60 joué' + (' ; « X vs » = sa partie la plus récente contre ' + pretty(args.vs)[0] if args.vs else '') + ')\n')
    print('| Carte | | ' + ' | '.join(heads) + ' |')
    print('|---|:-:|' + ':-:|' * len(heads))
    for c in cards:
        n, p = pretty(c)
        vals = [str(d.get(c, '–')) for d in cols]
        if my_deck:
            ref = C.Counter(d.get(c, 0) for d in mains).most_common(1)[0][0]
            if my_deck.get(c, 0) != ref:
                vals[-1] = f'**{my_deck.get(c, 0)}**'
        print(f'| {n} | {p} | ' + ' | '.join(vals) + ' |')
    print('| **Total** | | ' + ' | '.join(str(sum(d.values())) for d in cols) + ' |')
    if my_deck:
        print('\nEn **gras** : ta quantité diffère de la majorité des listes principales du top.')

    # réserve reconstituée + side par adversaire
    print('\n## Réserve observée et side\n')
    for i, (h, gs) in enumerate(top):
        pool = C.Counter()
        for g in gs:
            for k, v in g['deck'].items():
                pool[k] = max(pool[k], v)
        side = {k: v - mains[i].get(k, 0) for k, v in pool.items() if v > mains[i].get(k, 0)}
        eqs = sorted({e for g in gs for e in g['equip']} - set(C.Counter(tuple(g['equip']) for g in gs).most_common(1)[0][0]))
        print(f'**{L[i]}** — réserve ({sum(side.values())} cartes vues) : {fmt_diff(side)}'
              + (f' · équipements alternatifs : {", ".join(pretty(e)[0] for e in eqs)}' if eqs else ''))
        if args.vs:
            for g in sorted((g for g in gs if g['opp'] == args.vs), key=lambda g: g['date'], reverse=True):
                ins, outs = diff(mains[i], g['deck'])
                print(f'- vs {pretty(args.vs)[0]} {g["date"]} ({"V" if g["won"] else "D"}, {g["turns"]} tours) : '
                      + ('liste principale' if not ins and not outs else f'IN {fmt_diff(ins)} · OUT {fmt_diff(outs)}'))
        print()


if __name__ == '__main__':
    main()
