"""Read-only Helius access for the squeeze probe (H1). Adapted from research/execution-audit/heli.py.

Key hygiene: the key is read only from HELIUS_API_KEY and lives only inside _url(); no message, log or file
ever contains it (errors are scrubbed). Raw responses are cached in SQ_SCRATCH (outside the repo).
Credits: every request that leaves the machine books CREDITS_PER_CALL against CAP in a ledger that survives
restarts; the cap is a hard stop. No pump.fun requests.
"""
import hashlib, json, os, sys, threading, time
import requests

SCRATCH = os.environ.get('SQ_SCRATCH') or sys.exit('SQ_SCRATCH not set')
RAW = os.path.join(SCRATCH, 'helius_raw')
LEDGER = os.path.join(SCRATCH, 'credits.json')
CAP = 400_000
CREDITS_PER_CALL = 10
MIN_GAP = 0.112                # at most ~9 requests a second
WALL = 1789999200              # 2026-09-21T14:00:00Z
_lock = threading.Lock()
_last = [0.0]


class CapReached(Exception):
    pass


def _url():
    k = os.environ.get('HELIUS_API_KEY', '')
    if not k:
        raise SystemExit('HELIUS_API_KEY not set')
    return 'https://mainnet.helius-rpc.com/?api-key=' + k


def scrub(s):
    s = str(s)
    k = os.environ.get('HELIUS_API_KEY', '')
    return s.replace(k, '<key>') if k else s


def ledger():
    try:
        return json.load(open(LEDGER))
    except FileNotFoundError:
        return {'calls': 0, 'credits': 0, 'by_method': {}}


def rpc(method, params):
    """One JSON-RPC call, cached on disk by (method, params). Returns the 'result' (or raises)."""
    os.makedirs(RAW, exist_ok=True)
    h = hashlib.sha1(json.dumps([method, params], sort_keys=True).encode()).hexdigest()
    path = os.path.join(RAW, h + '.json')
    if os.path.exists(path):
        return json.load(open(path))['r']
    for attempt in range(7):
        with _lock:
            led = ledger()
            if led['credits'] + CREDITS_PER_CALL > CAP:
                raise CapReached(f"credit cap {CAP} reached ({led['credits']} booked)")
            led['calls'] += 1
            led['credits'] += CREDITS_PER_CALL
            led['by_method'][method] = led['by_method'].get(method, 0) + 1
            json.dump(led, open(LEDGER + '.tmp', 'w'))
            os.replace(LEDGER + '.tmp', LEDGER)
            wait = _last[0] + MIN_GAP - time.time()
            if wait > 0:
                time.sleep(wait)
            _last[0] = time.time()
        try:
            r = requests.post(_url(), json={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, timeout=90)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(64, 2 ** attempt)); continue
            j = r.json()
        except Exception as e:  # scrubbed: the URL holds the key
            print('rpc error:', scrub(type(e).__name__), scrub(e)[:200], file=sys.stderr)
            time.sleep(min(64, 2 ** attempt)); continue
        if 'error' in j:
            if j['error'].get('code') in (-32429, 429):
                time.sleep(min(64, 2 ** attempt)); continue
            raise RuntimeError(scrub(json.dumps(j['error']))[:400])
        tmp = path + '.%d.tmp' % threading.get_ident()
        json.dump({'r': j['result']}, open(tmp, 'w'))
        os.replace(tmp, path)
        return j['result']
    raise RuntimeError('rpc retries exhausted for ' + method)


def gtfa_last(address, t_lte, pagination_token=None, limit=1):
    """getTransactionsForAddress: newest successful transactions touching `address` with blockTime <= t_lte."""
    if t_lte > WALL:
        raise ValueError('block time after the wall requested')
    opts = {'transactionDetails': 'full', 'sortOrder': 'desc', 'limit': limit,
            'filters': {'blockTime': {'lte': int(t_lte)}, 'status': 'succeeded'},
            'encoding': 'json', 'maxSupportedTransactionVersion': 0}
    if pagination_token:
        opts['paginationToken'] = pagination_token
    try:
        return rpc('getTransactionsForAddress', [address, opts])
    except RuntimeError as e:                    # a version-1 transaction in the window: ask again allowing it
        if '-32015' not in str(e):
            raise
        opts['maxSupportedTransactionVersion'] = 1
        return rpc('getTransactionsForAddress', [address, opts])


def gtfa_first(address):
    """Oldest successful transaction touching `address`."""
    opts = {'transactionDetails': 'signatures', 'sortOrder': 'asc', 'limit': 1,
            'filters': {'status': 'succeeded'}}
    return rpc('getTransactionsForAddress', [address, opts])


def account(address):
    return rpc('getAccountInfo', [address, {'encoding': 'base64'}])
