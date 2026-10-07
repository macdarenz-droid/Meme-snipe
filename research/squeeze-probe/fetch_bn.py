"""Binance public archive (data.binance.vision, keyless) for the squeeze probe. Pre-wall only.

  python3 -I fetch_bn.py <data_dir>

Downloads 5-minute OI metrics (USD-M, daily files) and 5-minute klines (spot or USD-M, monthly files plus daily
files for any month without a monthly file), then writes one compact CSV per series:
  bn/metrics_<SYM>.csv   create_time_unix,sum_open_interest
  bn/k_<market>_<SYM>.csv open_time_unix,close
and bn/manifest.json with the SHA-256 of every downloaded zip. Rows at or after the wall are dropped.
"""
import concurrent.futures as cf, csv, hashlib, io, json, os, re, sys, time, zipfile
from datetime import datetime, timezone
import requests

WALL = 1789999200
S3 = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision'
DL = 'https://data.binance.vision/'
METRICS = ['WIF', 'POPCAT', 'BOME', 'MEW', 'GOAT', 'PNUT', 'MOODENG', 'CHILLGUY', 'FARTCOIN', 'ZEREBRO',
           'GRIFFAIN', 'VINE', 'USELESS', 'SPX', 'JELLYJELLY', 'PENGU', 'TRUMP', 'MELANIA', 'AI16Z', 'MYRO',
           'DOOD', '1000BONK']
SPOT = ['WIF', 'BOME', 'BONK', 'PNUT', 'PENGU', 'TRUMP', 'SOL']
PERP = ['POPCAT', 'MEW', 'GOAT', 'MOODENG', 'CHILLGUY', 'FARTCOIN', 'ZEREBRO', 'GRIFFAIN', 'VINE', 'USELESS',
        'SPX', 'MELANIA', 'AI16Z', 'MYRO', 'JELLYJELLY', 'DOOD', 'SOL']
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


def ts(x):
    v = int(x)
    return v // 1000000 if v > 10 ** 14 else v // 1000          # microseconds (spot from 2025) or ms


def main(d):
    raw = os.path.join(d, 'bn_raw'); out = os.path.join(d, 'bn')
    os.makedirs(raw, exist_ok=True); os.makedirs(out, exist_ok=True)
    jobs = []                                                     # (series name, keys)
    for s in METRICS:
        ks = [k for k in listing(f'data/futures/um/daily/metrics/{s}USDT/') if k[-14:-4] < '2026-09-22']
        jobs.append((f'metrics_{s}', ks))
    for mk, syms, base in (('spot', SPOT, 'data/spot'), ('perp', PERP, 'data/futures/um')):
        for s in syms:
            mon = [k for k in listing(f'{base}/monthly/klines/{s}USDT/5m/') if k[-11:-4] <= '2026-09']
            have = {k[-11:-4] for k in mon}
            day = [k for k in listing(f'{base}/daily/klines/{s}USDT/5m/')
                   if k[-14:-7] not in have and k[-14:-4] < '2026-09-22']
            jobs.append((f'k_{mk}_{s}', mon + day))
    man = {}
    with cf.ThreadPoolExecutor(16) as ex:
        for name, keys in jobs:
            res = list(ex.map(lambda k: get(k, raw), keys))
            data = {}
            for key, h, b in res:
                man[key] = h
                for row in rows_of(b):
                    if name.startswith('metrics'):
                        t = int(datetime.strptime(row[0], '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc).timestamp())
                        if t < WALL and row[2] != '':
                            data[t] = row[2]
                    else:
                        t = ts(row[0])
                        if t + 300 <= WALL:
                            data[t] = row[4]
            with open(os.path.join(out, name + '.csv'), 'w') as f:
                for t in sorted(data):
                    f.write(f'{t},{data[t]}\n')
            print(name, len(keys), 'files', len(data), 'rows', flush=True)
    json.dump(man, open(os.path.join(out, 'manifest.json'), 'w'), indent=0, sort_keys=True)


if __name__ == '__main__':
    main(sys.argv[1])
