"""Binance public archive (data.binance.vision, keyless) for FUND-SPREAD (PREREG.md). Pre-wall only.

  python3 -I fetch_fs.py <data_dir>

Downloads, for every symbol below, the USD-M funding settlement rows (monthly files) and USD-M daily klines (monthly
files, daily files for months without one), then writes:
  bnfs/fund_<SYM>.csv   calc_time_unix_ms,funding_interval_hours,last_funding_rate
  bnfs/d_<SYM>.csv      open_time_unix,open,high,low,close
and bnfs/manifest.json with the SHA-256 of every zip. Rows at or after the wall are dropped (a daily bar is kept
only if it closed before the wall).
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


def rows_of(b):
    z = zipfile.ZipFile(io.BytesIO(b))
    for n in z.namelist():
        for row in csv.reader(io.TextIOWrapper(z.open(n))):
            if row and row[0][:1].isdigit():
                yield row


def main(d):
    raw = os.path.join(d, 'bnfs_raw'); out = os.path.join(d, 'bnfs')
    os.makedirs(raw, exist_ok=True); os.makedirs(out, exist_ok=True)
    man = {}
    with cf.ThreadPoolExecutor(12) as ex:
        for s in SYMS:
            fk = [k for k in listing(f'data/futures/um/monthly/fundingRate/{s}/') if k[-11:-4] <= '2026-09']
            fr = {}
            for key, h, b in ex.map(lambda k: get(k, raw), fk):
                man[key] = h
                for row in rows_of(b):
                    if int(row[0]) // 1000 < WALL:
                        fr[int(row[0])] = (row[1], row[2])
            with open(os.path.join(out, f'fund_{s}.csv'), 'w') as f:
                for t in sorted(fr):
                    f.write(f'{t},{fr[t][0]},{fr[t][1]}\n')
            mon = [k for k in listing(f'data/futures/um/monthly/klines/{s}/1d/') if k[-11:-4] <= '2026-09']
            have = {k[-11:-4] for k in mon}
            day = [k for k in listing(f'data/futures/um/daily/klines/{s}/1d/')
                   if k[-14:-7] not in have and k[-14:-4] < '2026-09-21']
            kl = {}
            for key, h, b in ex.map(lambda k: get(k, raw), mon + day):
                man[key] = h
                for row in rows_of(b):
                    t = int(row[0]) // 1000
                    if t + 86400 <= WALL:
                        kl[t] = row[1:5]
            with open(os.path.join(out, f'd_{s}.csv'), 'w') as f:
                for t in sorted(kl):
                    f.write(f"{t},{','.join(kl[t])}\n")
            print(s, len(fk), 'funding files', len(fr), 'rows;', len(mon) + len(day), 'kline files', len(kl), 'days', flush=True)
    json.dump(man, open(os.path.join(out, 'manifest.json'), 'w'), indent=0, sort_keys=True)


if __name__ == '__main__':
    main(sys.argv[1])
