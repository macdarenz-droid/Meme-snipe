"""Read-only Helius and GeckoTerminal access for the execution audit, plus PumpSwap event decoding.

Key hygiene: the key is read only from HELIUS_API_KEY and lives only inside _url(); no message, log or file
ever contains it (errors are scrubbed). Raw responses are cached in a scratch directory (EA_SCRATCH), never in
the repo. Credits: every RPC request that leaves the machine counts CREDITS_PER_CALL against a hard cap that
survives restarts (ledger file in the scratch directory).
"""
import base64, hashlib, json, os, struct, sys, time
import requests

SCRATCH = os.environ.get('EA_SCRATCH') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '_scratch_not_committed')
RAW = os.path.join(SCRATCH, 'raw')
GT = os.path.join(SCRATCH, 'gt')
LEDGER = os.path.join(SCRATCH, 'credits.json')
CAP = 1_500_000
CREDITS_PER_CALL = 10          # counted conservatively: archival calls cost 10 on Helius
MIN_GAP = 0.11                 # at most ~9 requests per second
GT_GAP = 6.5
AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
EVENT_IX_TAG = bytes([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d])   # sha256("anchor:event")[:8]
BUY = bytes([103, 244, 82, 31, 44, 245, 119, 119])
SELL = bytes([62, 47, 55, 10, 165, 3, 220, 42])

class CapReached(Exception):
    pass

def _key():
    k = os.environ.get('HELIUS_API_KEY', '')
    if not k:
        raise SystemExit('HELIUS_API_KEY not set')
    return k

def _url():
    return 'https://mainnet.helius-rpc.com/?api-key=' + _key()

def scrub(s):
    s = str(s)
    k = os.environ.get('HELIUS_API_KEY', '')
    return s.replace(k, '<key>') if k else s

def _ledger():
    try:
        return json.load(open(LEDGER))
    except FileNotFoundError:
        return {'calls': 0, 'credits': 0}

_last = [0.0]
_last_gt = [0.0]

def rpc(method, params, cache_name=None):
    """One JSON-RPC call, cached on disk by (method, params)."""
    os.makedirs(RAW, exist_ok=True)
    h = cache_name or hashlib.sha1(json.dumps([method, params], sort_keys=True).encode()).hexdigest()
    path = os.path.join(RAW, h + '.json')
    if os.path.exists(path):
        return json.load(open(path))
    for attempt in range(6):
        led = _ledger()
        if led['credits'] + CREDITS_PER_CALL > CAP:
            raise CapReached(f"credit cap {CAP} reached ({led['credits']} counted)")
        led['calls'] += 1; led['credits'] += CREDITS_PER_CALL
        json.dump(led, open(LEDGER, 'w'))
        wait = _last[0] + MIN_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            r = requests.post(_url(), json={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, timeout=60)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(64, 2 ** attempt)); continue
            j = r.json()
        except Exception as e:                         # scrubbed: the URL holds the key
            print('rpc error:', scrub(type(e).__name__), scrub(e)[:200], file=sys.stderr)
            time.sleep(min(64, 2 ** attempt)); continue
        if 'error' in j:
            if j['error'].get('code') in (-32429, 429):
                time.sleep(min(64, 2 ** attempt)); continue
            raise RuntimeError(scrub(json.dumps(j['error']))[:300])
        res = j['result']
        if res is not None:
            json.dump(res, open(path, 'w'))
        return res
    raise RuntimeError('rpc retries exhausted for ' + method)

def credits():
    return _ledger()

def gt_minutes(pool, before):
    """GeckoTerminal 1-minute OHLCV (SOL per token), up to 1000 bars ending before `before`. Cached."""
    os.makedirs(GT, exist_ok=True)
    path = os.path.join(GT, f'{pool}_{before}.json')
    if os.path.exists(path):
        return json.load(open(path))
    url = (f'https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/ohlcv/minute'
           f'?aggregate=1&limit=1000&currency=token&before_timestamp={before}')
    for attempt in range(6):
        wait = _last_gt[0] + GT_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_gt[0] = time.time()
        r = requests.get(url, headers={'accept': 'application/json'}, timeout=60)
        if r.status_code == 429:
            time.sleep(30); continue
        r.raise_for_status()
        rows = sorted(r.json()['data']['attributes']['ohlcv_list'])
        json.dump(rows, open(path, 'w'))
        return rows
    raise RuntimeError('geckoterminal retries exhausted')

# ---------- decoding ----------
_B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

def b58decode(s):
    n = 0
    for ch in s:
        n = n * 58 + _B58.index(ch)
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big') if n else b''
    return b'\x00' * (len(s) - len(s.lstrip('1'))) + b

def b58encode(b):
    n = int.from_bytes(b, 'big'); out = ''
    while n:
        n, r = divmod(n, 58); out = _B58[r] + out
    return '1' * (len(b) - len(b.lstrip(b'\x00'))) + out

# The leading fixed fields both events share up to the pool pubkey, then the tail we need.
_COMMON = ['timestamp', 'amount_base', 'limit_quote', 'user_base_res', 'user_quote_res',
           'pool_base_token_reserves', 'pool_quote_token_reserves', 'quote_amount', 'lp_fee_bps', 'lp_fee',
           'protocol_fee_bps', 'protocol_fee', 'quote_amount_fee_adj', 'user_quote_amount']

def decode_swap(data):
    """data = EVENT_IX_TAG + discriminator + body. Returns dict or None."""
    if len(data) < 16 or data[:8] != EVENT_IX_TAG:
        return None
    disc, body = data[8:16], data[16:]
    if disc not in (BUY, SELL):
        return None
    kind = 'buy' if disc == BUY else 'sell'
    if len(body) < 14 * 8 + 32:
        return None
    vals = struct.unpack_from('<q13Q', body, 0)
    ev = dict(zip(_COMMON, vals)); ev['kind'] = kind
    p = 14 * 8
    ev['pool'] = b58encode(body[p:p + 32]); p += 32
    p += 32 * 6                                                      # user .. coin_creator
    if len(body) >= p + 16:
        ev['coin_creator_fee_bps'], ev['coin_creator_fee'] = struct.unpack_from('<2Q', body, p)
    p += 16
    # walk the version-dependent tail to virtual_quote_reserves
    try:
        if kind == 'buy':
            p += 1 + 8 + 8 + 8 + 8 + 8                                  # track_volume .. min_base_amount_out
            sl = struct.unpack_from('<I', body, p)[0]; p += 4 + sl       # ix_name
        p += 8 * 4                                                      # cashback bps/amt, buyback bps/amt
        lo, hi = struct.unpack_from('<Qq', body, p)
        ev['virtual_quote_reserves'] = lo + (hi << 64)
        p += 16
        ev['can_boost'] = body[p]
    except struct.error:
        ev['virtual_quote_reserves'] = None                             # older, shorter layout
    ev['body_len'] = len(body)
    return ev

def swaps_in_tx(tx):
    """All PumpSwap Buy/Sell events in a getTransaction result (json encoding), in inner-instruction order."""
    out = []
    if not tx or not tx.get('meta') or tx['meta'].get('err') is not None:
        return out
    keys = tx['transaction']['message']['accountKeys']
    lw = tx['meta'].get('loadedAddresses') or {}
    keys = keys + lw.get('writable', []) + lw.get('readonly', [])
    for grp in tx['meta'].get('innerInstructions') or []:
        for ix in grp['instructions']:
            if keys[ix['programIdIndex']] != AMM:
                continue
            ev = decode_swap(b58decode(ix['data']))
            if ev:
                out.append(ev)
    return out

def block_time(slot):
    """Block time of `slot`, or of the next non-skipped slot (returns (slot, time))."""
    for d in range(20):
        try:
            t = rpc('getBlockTime', [slot + d])
            if t is not None:
                return slot + d, t
        except RuntimeError as e:
            if 'skipped' in str(e) or '-32007' in str(e) or '-32009' in str(e):
                continue
            raise
    raise RuntimeError('no block near slot')

_cal = [(440727311, 1787330350), (443677006, 1788345878)]

def slot_for_time(T, tol=20):
    """A slot whose block time is within `tol` seconds before T (secant search on block times)."""
    pts = sorted(_cal)
    a, b = pts[0], pts[-1]
    s = int(a[0] + (T - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
    for _ in range(12):
        s, t = block_time(s)
        _cal.append((s, t))
        if -tol <= T - t <= tol:
            return s, t
        near = min(_cal, key=lambda p: abs(p[1] - T) + (1e9 if p[0] == s else 0))
        rate = (s - near[0]) / (t - near[1]) if t != near[1] else 2.5
        rate = min(max(rate, 2.0), 3.0)
        s = int(s + (T - t) * rate)
    return s, t

def anchor_sig(T):
    """A signature from a block at about time T (any transaction); used as `before` to start paging there."""
    s, _ = slot_for_time(T)
    for d in range(20):
        try:
            b = rpc('getBlock', [s + d, {'transactionDetails': 'signatures', 'rewards': False,
                                         'maxSupportedTransactionVersion': 0, 'commitment': 'finalized'}])
        except RuntimeError as e:
            if 'skipped' in str(e) or '-32007' in str(e) or '-32009' in str(e):
                continue
            raise
        if b and b.get('signatures'):
            return b['signatures'][-1], s + d, b.get('blockTime')
    raise RuntimeError('no anchor block')

def pool_sigs(pool, t0, t1):
    """Signatures touching `pool` with block time in [t0, t1], oldest first (reverse of the RPC's newest-first
    order). Failed transactions are kept with their err so the caller can drop them."""
    before, _, _ = anchor_sig(t1 + 30)
    out = []
    while True:
        page = rpc('getSignaturesForAddress', [pool, {'before': before, 'limit': 1000, 'commitment': 'finalized'}])
        if not page:
            break
        for x in page:
            if x.get('blockTime') is not None and x['blockTime'] < t0:
                return out[::-1]
            if x.get('blockTime') is None or x['blockTime'] <= t1:
                out.append(x)
        before = page[-1]['signature']
        if len(page) < 1000:
            break
    return out[::-1]
