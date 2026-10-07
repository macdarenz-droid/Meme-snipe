"""Execution pool map and on-chain fee reads (PREREG "Universe", executor Step 2).

  python3 -I pools.py gt <data_dir>          # GeckoTerminal pool lookups for the rule-2 coins (>= 7 s apart)
  python3 -I pools.py map <data_dir> <out>   # pool map: rule 1 / rule 2, vaults and fee read from the chain

Rule 1: the coin's pool in research/cheap-venue-probe/universe.json if it is Raydium AMM v4 or CPMM.
Rule 2: else the deepest Raydium AMM v4 or CPMM pool paired with wrapped SOL on the first page of GeckoTerminal
/networks/solana/tokens/{mint}/pools with reserve_in_usd >= $250,000 on the lookup date. Else the coin is out.
Fee: AMM v4 the trade/swap fee fields of the pool state (the larger, as an upper bound); CPMM trade_fee_rate of
its AmmConfig plus its creator_fee_rate, charged in full whatever the pool's flags (upper bound). Unreadable fee: out.
"""
import base64, json, os, struct, sys, time
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
WSOL = 'So11111111111111111111111111111111111111112'
AMMV4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
# Hyperliquid name -> Solana mint (classification.json, CoinGecko platform field; JELLY from universe.json)
COINS = ['WIF', 'POPCAT', 'BOME', 'MEW', 'GOAT', 'PNUT', 'MOODENG', 'CHILLGUY', 'FARTCOIN', 'PENGU', 'ZEREBRO',
         'GRIFFAIN', 'VINE', 'USELESS', 'kBONK', 'SPX', 'TRUMP', 'MELANIA', 'YZY', 'AI16Z', 'MYRO', 'LAUNCHCOIN',
         'JELLY', 'DOOD']
RULE2 = ['kBONK', 'FARTCOIN', 'PENGU', 'TRUMP', 'MELANIA', 'AI16Z', 'MYRO', 'DOOD']
MANUAL_MINT = {'kBONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
               'LAUNCHCOIN': 'BLVxek8YMXUQhcKmMvrFTrzh5FXg8ec88Crp6otEaCMf',
               'DOOD': 'DvjbEsdca43oQcw2h3HW1CT7N3x5vRcr3QrvTUHnXvgV',
               'AI16Z': 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
               'JELLY': 'FeR8VBqNRSUD5NtXAj2n3j1dAHkZHfyDktKuLXD4pump',
               'GRIFFAIN': 'KENJSUYLASHUMfHyy5o4Hp2FdNqZg1AsUPhfH2kYvEP',
               'SPX': 'J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr',
               'YZY': 'DrZ26cKJDksVRWib3DVVsjo9eeXccc7hKhDJviiYEEZY'}


def mints():
    cl = {r['hl']: r for r in json.load(open(os.path.join(HERE, 'classification.json')))}
    return {c: MANUAL_MINT.get(c) or cl[c].get('solana_mint') for c in COINS}


def gt(data):
    out = os.path.join(data, 'gt')
    os.makedirs(out, exist_ok=True)
    m = mints()
    for c in RULE2:
        p = os.path.join(out, f'pools_{c}.json')
        if os.path.exists(p):
            continue
        for attempt in range(8):
            time.sleep(7.5 if attempt == 0 else 60)
            r = requests.get(f'https://api.geckoterminal.com/api/v2/networks/solana/tokens/{m[c]}/pools',
                             headers={'accept': 'application/json'}, timeout=60)
            if r.status_code == 200:
                d = r.json(); d['_fetched'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                json.dump(d, open(p, 'w')); print(c, 'ok', len(d['data'])); break
            print(c, 'http', r.status_code)


def b58(b):
    A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    n = int.from_bytes(b, 'big'); s = ''
    while n:
        n, r = divmod(n, 58); s = A[r] + s
    return '1' * (len(b) - len(b.lstrip(b'\0'))) + s


def acct(addr):
    sys.path.insert(0, HERE)
    import hel
    r = hel.account(addr)
    if not r or not r.get('value'):
        return None, None
    return r['value']['owner'], base64.b64decode(r['value']['data'][0])


def read_v4(d):
    u = struct.unpack_from('<32Q', d, 0)
    trade = (u[18], u[19]); swap = (u[22], u[23])
    pk = lambda o: b58(d[o:o + 32])
    return {'base_vault': pk(336), 'quote_vault': pk(368), 'base_mint': pk(400), 'quote_mint': pk(432),
            'fee_fields': {'trade': trade, 'swap': swap},
            'fee': max(trade[0] / trade[1], swap[0] / swap[1])}


def read_cpmm(d):
    pk = lambda o: b58(d[o:o + 32])
    st = {'amm_config': pk(8), 'token0_vault': pk(72), 'token1_vault': pk(104), 'token0_mint': pk(168),
          'token1_mint': pk(200)}
    if len(d) > 389:
        st['creator_fee_on'] = d[389]; st['enable_creator_fee'] = d[390]
    return st


def read_cfg(d):
    trade, proto, fund = struct.unpack_from('<3Q', d, 12)
    out = {'trade_fee_rate': trade, 'protocol_fee_rate': proto, 'fund_fee_rate': fund}
    if len(d) >= 116:
        out['creator_fee_rate'] = struct.unpack_from('<Q', d, 108)[0]
    return out


def build_map(data, outp):
    m = mints()
    uni = {p['mint']: p for p in json.load(open(os.path.join(HERE, '../cheap-venue-probe/universe.json')))['pools']}
    res = {}
    for c in COINS:
        row = {'mint': m[c]}
        u = uni.get(m[c])
        if u and u['venue'] in ('Raydium AMM v4', 'Raydium CPMM'):
            row.update(rule=1, pool=u['pool'], venue=u['venue'])
        elif c in RULE2:
            p = os.path.join(data, 'gt', f'pools_{c}.json')
            d = json.load(open(p))
            cands = []
            for x in d['data']:
                dex = x['relationships']['dex']['data']['id']
                base = x['relationships']['base_token']['data']['id'].split('_', 1)[1]
                quote = x['relationships']['quote_token']['data']['id'].split('_', 1)[1]
                rv = float(x['attributes'].get('reserve_in_usd') or 0)
                pair = {base, quote}
                if dex in ('raydium', 'raydium-cp-swap', 'raydium-cpmm') and pair == {m[c], WSOL} and rv >= 250000:
                    cands.append((rv, x['attributes']['address'], dex))
            row['gt_fetched'] = d.get('_fetched')
            row['gt_first_page'] = [(x['attributes']['address'], x['relationships']['dex']['data']['id'],
                                     float(x['attributes'].get('reserve_in_usd') or 0)) for x in d['data']]
            if cands:
                rv, addr, dex = max(cands)
                row.update(rule=2, pool=addr, gt_dex=dex,
                           reserve_usd_lookup=rv)
            else:
                row.update(rule=None, out='no Raydium AMM v4/CPMM pool paired with WSOL >= $250k on GT first page')
        else:
            row.update(rule=None, out='rule-1 pool is not Raydium AMM v4/CPMM and the coin is not a rule-2 coin'
                       if u else 'not in cheap-venue universe and not a rule-2 coin')
        if row.get('pool'):
            owner, d = acct(row['pool'])
            if owner == AMMV4:
                st = read_v4(d)
                if {st['base_mint'], st['quote_mint']} != {m[c], WSOL}:
                    row.update(out='pool mints do not match', state=st); res[c] = row; continue
                tv, sv = (st['base_vault'], st['quote_vault']) if st['base_mint'] == m[c] else (st['quote_vault'], st['base_vault'])
                row.update(program='amm_v4', venue='Raydium AMM v4', token_vault=tv, sol_vault=sv, fee=st['fee'], fee_fields=st['fee_fields'])
            elif owner == CPMM:
                st = read_cpmm(d)
                if {st['token0_mint'], st['token1_mint']} != {m[c], WSOL}:
                    row.update(out='pool mints do not match', state=st); res[c] = row; continue
                o2, cd = acct(st['amm_config'])
                cfg = read_cfg(cd) if o2 == CPMM else None
                if not cfg:
                    row.update(out='AmmConfig unreadable'); res[c] = row; continue
                creator = cfg.get('creator_fee_rate', 0)   # charged in full as an upper bound, whatever the pool's flags
                tv, sv = (st['token0_vault'], st['token1_vault']) if st['token0_mint'] == m[c] else (st['token1_vault'], st['token0_vault'])
                row.update(program='cpmm', venue='Raydium CPMM', token_vault=tv, sol_vault=sv, amm_config=st['amm_config'], cfg=cfg,
                           creator_fee_flags=[st.get('creator_fee_on'), st.get('enable_creator_fee')],
                           fee=(cfg['trade_fee_rate'] + creator) / 1e6)
            else:
                row.update(out=f'pool account owner {owner} is not AMM v4 or CPMM')
        res[c] = row
    json.dump(res, open(outp, 'w'), indent=1)
    for c, r in res.items():
        print(c, r.get('rule'), r.get('venue'), r.get('program'), r.get('fee'), r.get('out', ''))


if __name__ == '__main__':
    if sys.argv[1] == 'gt':
        gt(sys.argv[2])
    else:
        build_map(sys.argv[2], sys.argv[3])
