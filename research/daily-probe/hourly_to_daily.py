"""Build daily-probe inputs from lottery-probe hourly files (see PREREG.md, survivorship-free check).

  python3 -I hourly_to_daily.py <sample.json> <hourlydir> <outdir>
"""
import json, os, sys
WALL = 1789999200
DUST_OPEN = 5 / 206_900_000

def main(sample, hdir, outdir):
    os.makedirs(os.path.join(outdir, 'daily'), exist_ok=True)
    uni = []
    for u in json.load(open(sample)):
        f = os.path.join(hdir, u['pool'] + '.json')
        if not os.path.exists(f):
            continue
        rows = sorted(r for r in json.load(open(f)) if int(r[0]) + 3600 <= WALL)
        if not rows or float(rows[0][1]) < DUST_OPEN:
            continue
        days = {}
        for t, o, h, l, c, v in rows:
            d = int(t) - int(t) % 86400
            if d not in days:
                days[d] = [d, float(o), float(h), float(l), float(c), float(v)]
            else:
                x = days[d]; x[2] = max(x[2], float(h)); x[3] = min(x[3], float(l)); x[4] = float(c); x[5] += float(v)
        full = [x for d, x in sorted(days.items()) if d + 86400 <= WALL]
        if not full:
            continue
        json.dump({'data': {'attributes': {'ohlcv_list': full[::-1]}}}, open(os.path.join(outdir, 'daily', u['pool'] + '.json'), 'w'))
        uni.append({'mint': u['mint'], 'symbol': u['mint'][:6], 'pool': u['pool']})
    json.dump(uni, open(os.path.join(outdir, 'universe.json'), 'w'))
    print(len(uni), 'non-dust coins with daily bars')

if __name__ == '__main__':
    main(*sys.argv[1:])
