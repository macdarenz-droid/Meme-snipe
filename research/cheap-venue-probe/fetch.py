"""Cheap-venue probe data fetch (see PREREG.md). Pre-wall prices only; no pump.fun requests.

  python3 -I fetch.py discover <outdir>             # top pools per venue from GeckoTerminal listings
  python3 -I fetch.py tokens <outdir> <seeds.json>  # token info and token pool lists for every candidate token
  python3 -I fetch.py fees <outdir>                 # fee tier per candidate pool (Raydium API, Orca/Meteora on chain)
  python3 -I fetch.py bars <universe.json> <outdir> # 5-minute OHLCV per chosen pool, 2026-07-19 to the wall

Downloads go to <outdir>, outside the repo.
"""
import base64, json, os, ssl, struct, sys, time, urllib.error, urllib.request

WALL = 1789999200            # 2026-09-21T14:00:00Z
START = 1784419200           # 2026-07-19T00:00:00Z (3-day look-back before 07-22)
GTB = 'https://api.geckoterminal.com/api/v2/networks/solana'
OHLCV = GTB + '/pools/{}/ohlcv/minute?aggregate=5&before_timestamp={}&limit=1000&currency=token&token={}'
WSOL = 'So11111111111111111111111111111111111111112'
VENUES = ('raydium', 'raydium-clmm', 'orca', 'meteora', 'meteora-damm-v2')
PAGES = 10                   # GeckoTerminal serves at most 10 pages of 20 per listing
MIN_RESERVE = 250_000
RPC = 'https://api.mainnet-beta.solana.com'

def ctx():
    for f in (os.environ.get('SSL_CERT_FILE'), '/root/.ccr/ca-bundle.crt'):
        if f and os.path.exists(f):
            return ssl.create_default_context(cafile=f)
    return ssl.create_default_context()

CTX = ctx()

def get(url, data=None, pace=6.5):
    """JSON body; None on 404. Backs off on 429 and network errors."""
    for attempt in range(8):
        try:
            hdr = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'}
            if data is not None:
                hdr['Content-Type'] = 'application/json'
            req = urllib.request.Request(url, data=data, headers=hdr)
            with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
                out = json.load(r)
            time.sleep(pace)
            return out
        except urllib.error.HTTPError as e:
            if e.code == 404:
                time.sleep(pace)
                return None
            time.sleep(20 * (attempt + 1))
        except Exception:
            time.sleep(10 * (attempt + 1))
    raise RuntimeError('failed: ' + url)

def pool_row(p):
    a, r = p['attributes'], p['relationships']
    tid = lambda k: r[k]['data']['id'].split('_', 1)[1]
    return {'pool': a['address'], 'dex': r['dex']['data']['id'], 'name': a['name'],
            'base': tid('base_token'), 'quote': tid('quote_token'),
            'reserve_usd': float(a.get('reserve_in_usd') or 0), 'created': a.get('pool_created_at'),
            'vol24_usd': float((a.get('volume_usd') or {}).get('h24') or 0)}

def discover(outdir):
    os.makedirs(outdir, exist_ok=True)
    p = os.path.join(outdir, 'listing.json')
    rows = json.load(open(p)) if os.path.exists(p) else {}
    for dex in VENUES:
        for sort in ('h24_volume_usd_desc', 'h24_tx_count_desc'):
            for page in range(1, PAGES + 1):
                key = f'{dex}|{sort}|{page}'
                if key in rows:
                    continue
                d = get(f'{GTB}/dexes/{dex}/pools?page={page}&sort={sort}') or {}
                rows[key] = [pool_row(x) for x in d.get('data') or []]
                json.dump(rows, open(p, 'w'))
                if not rows[key]:
                    break
    print(sum(len(v) for v in rows.values()), 'listing rows')

def candidate_tokens(outdir, seeds):
    """Non-SOL side of every SOL-paired pool on a listed venue with reserve >= MIN_RESERVE, plus the seed mints."""
    toks = set(seeds)
    for v in json.load(open(os.path.join(outdir, 'listing.json'))).values():
        for r in v:
            if r['dex'] in VENUES and r['reserve_usd'] >= MIN_RESERVE and WSOL in (r['base'], r['quote']):
                toks.add(r['quote'] if r['base'] == WSOL else r['base'])
    toks.discard(WSOL)
    return sorted(toks)

def tokens(outdir, seeds_path):
    seeds = json.load(open(seeds_path))
    seeds = [s['mint'] for s in seeds] if seeds and isinstance(seeds[0], dict) else seeds
    tdir = os.path.join(outdir, 'tokens')
    os.makedirs(tdir, exist_ok=True)
    toks = candidate_tokens(outdir, seeds)
    print(len(toks), 'candidate tokens')
    for t in toks:
        p = os.path.join(tdir, t + '.json')
        if os.path.exists(p):
            continue
        info = get(f'{GTB}/tokens/{t}/info') or {}
        pools = get(f'{GTB}/tokens/{t}/pools?page=1') or {}
        json.dump({'info': (info.get('data') or {}).get('attributes'),
                   'pools': [pool_row(x) for x in pools.get('data') or []]}, open(p, 'w'))

def rpc_account(addr):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'getAccountInfo',
                       'params': [addr, {'encoding': 'base64'}]}).encode()
    d = get(RPC, data=body, pace=0.5) or {}
    v = (d.get('result') or {}).get('value')
    return (base64.b64decode(v['data'][0]), v['owner']) if v else (None, None)

ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
METEORA_DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'

def fees(outdir):
    """Fee per SOL-paired candidate pool with reserve >= MIN_RESERVE.
    Raydium (AMM v4, CPMM, CLMM): api-v3.raydium.io feeRate.  Orca Whirlpool: fee_rate (u16, hundredths of a bp)
    at byte offset 45 of the pool account.  Meteora: base fee and the dynamic-fee flag from the pool account."""
    tdir = os.path.join(outdir, 'tokens')
    p = os.path.join(outdir, 'fees.json')
    out = json.load(open(p)) if os.path.exists(p) else {}
    pools = {}
    for f in sorted(os.listdir(tdir)):
        for r in json.load(open(os.path.join(tdir, f)))['pools']:
            if r['dex'] in VENUES and r['reserve_usd'] >= MIN_RESERVE and WSOL in (r['base'], r['quote']):
                pools[r['pool']] = r
    ray = [a for a, r in pools.items() if r['dex'].startswith('raydium') and a not in out]
    for i in range(0, len(ray), 20):
        d = get('https://api-v3.raydium.io/pools/info/ids?ids=' + ','.join(ray[i:i + 20]), pace=1) or {}
        for x in d.get('data') or []:
            if x:
                out[x['id']] = {'src': 'raydium-api', 'type': x.get('type'), 'program': x.get('programId'),
                                'fee': float(x['feeRate']), 'tvl_usd': x.get('tvl'),
                                'mintA': x['mintA']['address'], 'mintB': x['mintB']['address'],
                                'amountA': x.get('mintAmountA'), 'amountB': x.get('mintAmountB')}
    for a, r in pools.items():
        if a in out or r['dex'].startswith('raydium'):
            continue
        raw, owner = rpc_account(a)
        if raw is None:
            out[a] = {'src': 'rpc', 'fee': None, 'note': 'account not found'}
        elif owner == ORCA_WHIRLPOOL:
            out[a] = {'src': 'rpc', 'program': owner, 'fee': struct.unpack_from('<H', raw, 45)[0] / 1e6,
                      'tick_spacing': struct.unpack_from('<H', raw, 41)[0],
                      'fee_tier_seed': struct.unpack_from('<H', raw, 43)[0]}
        else:
            out[a] = {'src': 'rpc', 'program': owner, 'fee': None, 'len': len(raw),
                      'head': base64.b64encode(raw[:120]).decode()}
        json.dump(out, open(p, 'w'), indent=0)
    json.dump(out, open(p, 'w'), indent=0)
    print(len(out), 'pools with a fee record;', sum(1 for v in out.values() if v.get('fee') is None), 'unknown')

def bars(uni, outdir):
    os.makedirs(outdir, exist_ok=True)
    for u in json.load(open(uni))['pools']:
        p = os.path.join(outdir, u['pool'] + '.json')
        if os.path.exists(p):
            continue
        side = 'quote' if u['base'] == WSOL else 'base'   # price the meme in SOL
        rows, before = {}, WALL
        while before > START:
            d = get(OHLCV.format(u['pool'], before, side)) or {}
            lst = (d.get('data') or {}).get('attributes', {}).get('ohlcv_list') or []
            if not lst:
                break
            for r in lst:
                rows[r[0]] = r
            oldest = min(r[0] for r in lst)
            if oldest >= before:
                break
            before = oldest
        json.dump(sorted(rows.values()), open(p, 'w'))

if __name__ == '__main__':
    {'discover': discover, 'tokens': tokens, 'fees': fees, 'bars': bars}[sys.argv[1]](*sys.argv[2:])
