"""Arm B input: Hyperliquid daily OI in tokens (PREREG "Secondary arms", B).

  python3 -I arm_b.py fetch <data_dir>     # Hyperliquid 1d candles for the arm-B coins (keyless info API)

hl/open_interest.json (stats backend, https://d2v1fiwobg9w6.cloudfront.net/open_interest) holds a daily USD
value per coin (the daily average OI times the daily average oracle price, per the scout). Tokens = USD /
that day's typical price (o + h + l + c) / 4 from the Hyperliquid daily candle. Data ends 2026-04-03.
"""
import json, os, sys, time
from datetime import datetime, timezone

COINS = ['WIF', 'POPCAT', 'BOME', 'MEW', 'GOAT', 'PNUT', 'MOODENG', 'CHILLGUY', 'FARTCOIN', 'ZEREBRO',
         'GRIFFAIN', 'VINE', 'USELESS', 'SPX', 'JELLY']
WALL_MS = 1789999200 * 1000


def fetch(d):
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'short-probe'))
    from fetch_hl import post
    for c in COINS:
        p = os.path.join(d, 'hl', f'c_{c}.json')
        if os.path.exists(p):
            continue
        x = post({'type': 'candleSnapshot', 'req': {'coin': c, 'interval': '1d', 'startTime': 1672531200000,
                                                    'endTime': WALL_MS}})
        json.dump(x, open(p, 'w')); print(c, len(x)); time.sleep(0.5)


def daily_oi_tokens(d):
    rows = json.load(open(os.path.join(d, 'hl', 'open_interest.json')))['chart_data']
    out = {}
    for c in COINS:
        p = os.path.join(d, 'hl', f'c_{c}.json')
        if not os.path.exists(p):
            continue
        tp = {}
        for k in json.load(open(p)):
            day = int(k['t']) // 1000 // 86400
            tp[day] = (float(k['o']) + float(k['h']) + float(k['l']) + float(k['c'])) / 4
        s = {}
        for r in rows:
            if r['coin'] != c:
                continue
            day = int(datetime.fromisoformat(r['time']).replace(tzinfo=timezone.utc).timestamp()) // 86400
            if day in tp and tp[day] > 0 and r['open_interest'] is not None:
                s[day] = float(r['open_interest']) / tp[day]
        out[c] = s
    return out


if __name__ == '__main__':
    fetch(sys.argv[2])
