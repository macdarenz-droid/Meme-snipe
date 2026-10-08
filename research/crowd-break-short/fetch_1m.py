"""Binance USD-M 1-minute klines from the public archive (data.binance.vision, keyless). Pre-wall only.

  python3 -I fetch_1m.py listing <data_dir>              # bn1m/listing.json: {SYMBOL: [YYYY-MM months with data]}
  python3 -I fetch_1m.py get <data_dir> <needs.json>     # needs.json: {SYMBOL: [YYYY-MM, ...]}

'get' downloads the monthly file of each needed month (daily files where no monthly file exists) and writes
bn1m/<SYMBOL>_<YYYY-MM>.csv with open_time_unix,open,high,low,close. Rows whose bar ends after the wall are dropped.
SHA-256 of every zip goes to bn1m/manifest.json (merged across runs). The listing reads file names only.
"""
import concurrent.futures as cf, csv, hashlib, io, json, os, re, sys, time, zipfile
import requests

WALL = 1789999200                      # 2026-09-21T14:00:00Z
S3 = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision'
DL = 'https://data.binance.vision/'
SYMS = ['WIFUSDT', 'POPCATUSDT', 'BOMEUSDT', 'MEWUSDT', 'GOATUSDT', 'PNUTUSDT', 'MOODENGUSDT', 'CHILLGUYUSDT',
        'FARTCOINUSDT', 'PENGUUSDT', 'ZEREBROUSDT', 'GRIFFAINUSDT', 'VINEUSDT', 'USELESSUSDT', '1000BONKUSDT',
        'SPXUSDT', 'TRUMPUSDT', 'MELANIAUSDT', 'YZYUSDT', 'AI16ZUSDT', 'MYROUSDT', 'LAUNCHCOINUSDT',
        'JELLYJELLYUSDT', 'DOODUSDT', 'SOLUSDT']
S = requests.Session()


def listing(prefix):
    keys, marker = [], ''
    while True:
        r = S.get(S3, params={'prefix': prefix, 'max-keys': 1000, 'marker': marker}, timeout=60)
        r.raise_for_status()
        ks = re.findall(r'<Key>([^<]+)</Key>', r.text)
        keys += [k for k in ks if k.endswith('.zip')]
        if '<IsTruncated>true</IsTruncated>' not in r.text or not ks:
            return keys
        marker = ks[-1]


def get(key, raw):
    p = os.path.join(raw, key.replace('/', '__'))
    if not os.path.exists(p):
        for i in range(6):
            try:
                r = S.get(DL + key, timeout=120)
                if r.status_code == 200:
                    open(p + '.tmp', 'wb').write(r.content); os.replace(p + '.tmp', p); break
            except Exception:
                pass
            time.sleep(2 ** i)
        else:
            raise RuntimeError('download failed ' + key)
    b = open(p, 'rb').read()
    return key, hashlib.sha256(b).hexdigest(), b


def keys_of(sym):
    mon = listing(f'data/futures/um/monthly/klines/{sym}/1m/')
    day = listing(f'data/futures/um/daily/klines/{sym}/1m/')
    return mon, day


def do_listing(d):
    out = os.path.join(d, 'bn1m'); os.makedirs(out, exist_ok=True)
    res = {}
    with cf.ThreadPoolExecutor(8) as ex:
        for sym, (mon, day) in zip(SYMS, ex.map(keys_of, SYMS)):
            ms = {k[-11:-4] for k in mon} | {k[-14:-7] for k in day}
            res[sym] = sorted(m for m in ms if m <= '2026-09')
    json.dump(res, open(os.path.join(out, 'listing.json'), 'w'), indent=0, sort_keys=True)
    print({k: (v[0], v[-1], len(v)) if v else None for k, v in res.items()})


def do_get(d, needs):
    out = os.path.join(d, 'bn1m'); raw = os.path.join(d, 'bn1m_raw')
    os.makedirs(out, exist_ok=True); os.makedirs(raw, exist_ok=True)
    mp = os.path.join(out, 'manifest.json')
    man = json.load(open(mp)) if os.path.exists(mp) else {}
    need = json.load(open(needs))
    with cf.ThreadPoolExecutor(12) as ex:
        for sym, months in sorted(need.items()):
            mon, day = keys_of(sym)
            mmap = {k[-11:-4]: k for k in mon}
            for m in sorted(months):
                dst = os.path.join(out, f'{sym}_{m}.csv')
                if os.path.exists(dst):
                    continue
                ks = [mmap[m]] if m in mmap else [k for k in day if k[-14:-7] == m and k[-14:-4] < '2026-09-22']
                rows = {}
                for key, h, b in ex.map(lambda k: get(k, raw), ks):
                    man[key] = h
                    z = zipfile.ZipFile(io.BytesIO(b))
                    for n in z.namelist():
                        for row in csv.reader(io.TextIOWrapper(z.open(n))):
                            if row and row[0][:1].isdigit():
                                t = int(row[0]) // 1000
                                if t + 60 <= WALL:
                                    rows[t] = row[1:5]
                with open(dst + '.tmp', 'w') as f:
                    for t in sorted(rows):
                        f.write(f"{t},{','.join(rows[t])}\n")
                os.replace(dst + '.tmp', dst)
                print(sym, m, len(ks), 'files', len(rows), 'rows', flush=True)
    json.dump(man, open(mp, 'w'), indent=0, sort_keys=True)


if __name__ == '__main__':
    if sys.argv[1] == 'listing':
        do_listing(sys.argv[2])
    else:
        do_get(sys.argv[2], sys.argv[3])
