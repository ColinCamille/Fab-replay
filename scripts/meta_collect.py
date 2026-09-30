#!/usr/bin/env python3
"""Collecte quotidienne FaB Insights → Supabase Storage (bucket privé `meta-games`).

Pour chaque jour (terminé) et chaque format, télécharge le CSV FaB Insights
(toutes les parties publiques Talishar), le convertit en JSONL compact
(une partie par ligne, les deux decks : liste jouée après side, équipement,
stats par carte, par tour, turnLog…) compressé en xz, et l'envoie dans
`meta-games/<format>/<date>.jsonl.xz`.

- Idempotent : les fichiers déjà présents dans le bucket ne sont pas refaits
  → chaque exécution comble aussi les trous depuis --since (quota API de
  2 Go/jour : si HTTP 429, on s'arrête proprement, la suite passera demain).
- Rétention (--keep-days, 90 par défaut) : les jours plus anciens sont
  supprimés du bucket et ne sont pas recollectés.
- Le jour courant n'est jamais collecté (le CSV est mis à jour toutes les heures).
- Stdlib uniquement.

Env : FABINSIGHTS_API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY.
Sans SUPABASE_* (ou avec --out DIR) : écrit en local (test).
SUPABASE_SECRET_KEY = clé « secret » (sb_secret_…) ou ancienne clé service_role.
"""
import argparse, ast, csv, datetime as dt, json, lzma, os, sys, tempfile
import urllib.error, urllib.request

API = 'https://fab-insights.azurewebsites.net/api/v1/download_csv'
BUCKET = 'meta-games'
# Code format FaB Insights → dossier dans le bucket
FORMAT_DIRS = {'0': 'cc', '1': 'cc-comp', '2': 'blitz', '3': 'blitz-comp',
               '14': 'silver-age', '15': 'silver-age-comp'}
# Champs recalculables (moyennes, variantes « sans le dernier tour ») → retirés
DROP_PREFIX = ('average',)
DROP_SUFFIX = ('_NoLast',)
csv.field_size_limit(10**9)


class Quota(Exception):
    pass


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def slim_cards(lst):
    # cardName se déduit de cardId ; pitchValue aussi (suffixe _red/_yellow/_blue)
    return [{k: v for k, v in c.items() if k not in ('cardName', 'pitchValue')} for c in lst or []]


def slim_deck(d):
    out = {}
    for k, v in d.items():
        if k.startswith(DROP_PREFIX) or k.endswith(DROP_SUFFIX) or k in ('gameId', 'gameName'):
            continue
        if k in ('cardResults', 'arenaCardResults', 'tokenResults', 'character'):
            v = slim_cards(v)
        out[k] = v
    return out


def convert_row(r, date, fmt):
    """Ligne CSV FaB Insights → partie compacte (None si illisible)."""
    try:
        d1, d2 = ast.literal_eval(r['deck1_json']), ast.literal_eval(r['deck2_json'])
    except Exception:
        return None
    g = {'id': r['game_id'], 'date': date, 'fmt': fmt, 'at': r['created_at'],
         'conceded': r['conceded'] == 'True', 'public': r['is_public'] == 'True',
         'players': [r['player1_name'], r['player2_name']],
         'decks': [slim_deck(d1), slim_deck(d2)]}
    if r.get('game_guid'):
        g['guid'] = r['game_guid']
    return g


def convert_csv(path, date, fmt):
    lines, bad = [], 0
    with open(path, newline='') as f:
        for r in csv.DictReader(f):
            g = convert_row(r, date, fmt)
            if g is None:
                bad += 1
                continue
            lines.append(json.dumps(g, separators=(',', ':'), ensure_ascii=False))
    data = lzma.compress(('\n'.join(lines) + '\n').encode(), preset=9 | lzma.PRESET_EXTREME)
    return data, len(lines), bad


# ---------- FaB Insights ----------

def download_csv(date, fmt, key, dest):
    req = urllib.request.Request(f'{API}?format={fmt}&date={date}', headers={'x-functions-key': key})
    try:
        meta = json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise Quota(e.read().decode(errors='replace')[:200])
        if e.code == 404:
            return False
        raise
    urllib.request.urlretrieve(meta['download_url'], dest)
    return True


# ---------- Supabase Storage ----------

class Storage:
    def __init__(self, url, key):
        self.url, self.key = url.rstrip('/'), key

    def _req(self, method, path, body=None, headers=None):
        # Clé « secret » (sb_secret_…) : pas un JWT → en-tête apikey seul (la
        # passerelle Supabase en déduit le rôle service_role). Ancienne clé
        # service_role (JWT) : aussi en Authorization.
        h = {'apikey': self.key}
        if not self.key.startswith('sb_'):
            h['Authorization'] = f'Bearer {self.key}'
        h.update(headers or {})
        req = urllib.request.Request(f'{self.url}/storage/v1/{path}', data=body, method=method, headers=h)
        return urllib.request.urlopen(req, timeout=120).read()

    def existing(self, folder):
        body = json.dumps({'prefix': folder + '/', 'limit': 10000}).encode()
        res = json.loads(self._req('POST', f'object/list/{BUCKET}', body, {'Content-Type': 'application/json'}))
        return {o['name'] for o in res}

    def delete(self, names):
        body = json.dumps({'prefixes': names}).encode()
        self._req('DELETE', f'object/{BUCKET}', body, {'Content-Type': 'application/json'})

    def put(self, name, data):
        self._req('POST', f'object/{BUCKET}/{name}', data,
                  {'Content-Type': 'application/x-xz', 'x-upsert': 'true'})


class LocalDir:
    def __init__(self, root):
        self.root = root

    def existing(self, folder):
        p = os.path.join(self.root, folder)
        return set(os.listdir(p)) if os.path.isdir(p) else set()

    def delete(self, names):
        for n in names:
            os.remove(os.path.join(self.root, n))

    def put(self, name, data):
        p = os.path.join(self.root, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(data)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--since', default='2026-09-25', help='premier jour à collecter (AAAA-MM-JJ)')
    ap.add_argument('--until', help='dernier jour (défaut : hier, UTC)')
    ap.add_argument('--formats', default='0,1', help='codes FaB Insights, ex. 0,1')
    ap.add_argument('--keep-days', type=int, default=90,
                    help='rétention : supprime les jours plus anciens et ne les recollecte pas (0 = illimitée)')
    ap.add_argument('--max-files', type=int, default=0, help='limite de fichiers par exécution (0 = aucune)')
    ap.add_argument('--out', help='écrire en local dans ce dossier au lieu de Supabase')
    ap.add_argument('--from-csv', help='test : convertir ce CSV local (avec --date/--format), sans API')
    ap.add_argument('--date'), ap.add_argument('--format', default='0')
    a = ap.parse_args()

    if a.from_csv:
        data, n, bad = convert_csv(a.from_csv, a.date, a.format)
        LocalDir(a.out or '.').put(f'{FORMAT_DIRS.get(a.format, a.format)}/{a.date}.jsonl.xz', data)
        log(f'{n} parties ({bad} illisibles) → {len(data) / 1e6:.2f} Mo')
        return

    key = os.environ.get('FABINSIGHTS_API_KEY')
    if not key:
        sys.exit('FABINSIGHTS_API_KEY manquante')
    if a.out:
        store = LocalDir(a.out)
    else:
        url, sk = os.environ.get('SUPABASE_URL'), os.environ.get('SUPABASE_SECRET_KEY')
        if not (url and sk):
            sys.exit('SUPABASE_URL / SUPABASE_SECRET_KEY manquantes (ou utiliser --out)')
        store = Storage(url, sk)

    until = dt.date.fromisoformat(a.until) if a.until else dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)
    days = []
    since = dt.date.fromisoformat(a.since)
    oldest = until - dt.timedelta(days=a.keep_days - 1) if a.keep_days else None
    if oldest and since < oldest:
        since = oldest  # hors rétention : ne pas re-télécharger ce qu'on supprime
    d = since
    while d <= until:
        days.append(d.isoformat())
        d += dt.timedelta(days=1)
    days.reverse()  # le plus récent d'abord, puis on comble les trous en remontant

    todo = []
    for fmt in a.formats.split(','):
        folder = FORMAT_DIRS.get(fmt, fmt)
        have = store.existing(folder)
        if oldest:
            old = sorted(n for n in have if n.endswith('.jsonl.xz') and n[:10] < oldest.isoformat())
            if old:
                store.delete([f'{folder}/{n}' for n in old])
                have -= set(old)
                log(f'🗑 {folder} : {len(old)} fichier(s) de plus de {a.keep_days} jours supprimé(s) ({old[0][:10]} → {old[-1][:10]})')
        todo += [(day, fmt, folder) for day in days if f'{day}.jsonl.xz' not in have]
    todo.sort(key=lambda t: t[0], reverse=True)
    if a.max_files:
        todo = todo[:a.max_files]
    log(f'{len(todo)} fichier(s) à collecter')

    done = 0
    for day, fmt, folder in todo:
        fd, tmp = tempfile.mkstemp(suffix='.csv')
        os.close(fd)
        try:
            if not download_csv(day, fmt, key, tmp):
                log(f'- {folder}/{day} : pas de données (404)')
                continue
            data, n, bad = convert_csv(tmp, day, fmt)
            store.put(f'{folder}/{day}.jsonl.xz', data)
            done += 1
            log(f'✓ {folder}/{day} : {n} parties ({bad} illisibles), CSV {os.path.getsize(tmp) / 1e6:.0f} Mo → {len(data) / 1e6:.2f} Mo')
        except Quota as e:
            log(f'⏸ quota FaB Insights atteint ({e}) → suite à la prochaine exécution')
            break
        finally:
            os.remove(tmp)
    log(f'{done} fichier(s) collecté(s)')


if __name__ == '__main__':
    main()
