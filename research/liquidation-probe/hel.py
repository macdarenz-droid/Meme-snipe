"""Read-only Helius access for the liquidation probe (PREREG.md F6-F7).

Key hygiene: the key is read only from HELIUS_API_KEY inside _url(); no message, log or file contains it (errors are
scrubbed). Raw responses are cached under H3_SCRATCH (outside the repo). Credits: every request that leaves the
machine books 10 credits (per page of at most 100 full transactions) in a ledger that survives restarts, with a
hard stop at CAP. At most 5 requests a second.
"""
import hashlib, json, os, sys, threading, time
import requests

SCRATCH = os.environ.get('H3_SCRATCH') or sys.exit('H3_SCRATCH not set')
RAW = os.path.join(SCRATCH, 'raw')
LEDGER = os.path.join(SCRATCH, 'credits.json')
CAP = 250_000
STAGE1_CAP = 200_000
ACTIVE_CAP = [STAGE1_CAP]                  # stage 2 raises this to CAP
CREDITS_PER_CALL = 10
MIN_GAP = 0.2
READ_ONLY = {'getTransactionsForAddress', 'getTransaction', 'getAccountInfo', 'getSignaturesForAddress'}
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
    s, k = str(s), os.environ.get('HELIUS_API_KEY', '')
    return s.replace(k, '<key>') if k else s

def ledger():
    try:
        return json.load(open(LEDGER))
    except FileNotFoundError:
        return {'calls': 0, 'credits': 0}

def rpc(method, params, cap=None):
    """One JSON-RPC call, cached on disk by (method, params). Raises CapReached before exceeding `cap`."""
    assert method in READ_ONLY
    cap = min(cap or ACTIVE_CAP[0], CAP)
    os.makedirs(RAW, exist_ok=True)
    h = hashlib.sha1(json.dumps([method, params], sort_keys=True).encode()).hexdigest()
    path = os.path.join(RAW, h + '.json')
    if os.path.exists(path):
        return json.load(open(path))
    for attempt in range(7):
        with _lock:
            led = ledger()
            if led['credits'] + CREDITS_PER_CALL > cap:
                raise CapReached(f"credit cap {cap} reached ({led['credits']} counted)")
            led['calls'] += 1
            led['credits'] += CREDITS_PER_CALL
            json.dump(led, open(LEDGER + '.tmp', 'w'))
            os.replace(LEDGER + '.tmp', LEDGER)
            w = _last[0] + MIN_GAP - time.time()
            if w > 0:
                time.sleep(w)
            _last[0] = time.time()
        try:
            r = requests.post(_url(), json={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, timeout=90)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(64, 2 ** attempt)); continue
            j = r.json()
        except Exception as e:
            print('rpc error:', scrub(type(e).__name__), scrub(e)[:200], file=sys.stderr)
            time.sleep(min(64, 2 ** attempt)); continue
        if 'error' in j:
            if j['error'].get('code') in (-32429, 429):
                time.sleep(min(64, 2 ** attempt)); continue
            raise RuntimeError(scrub(json.dumps(j['error']))[:300])
        res = j['result']
        if res is not None:
            json.dump(res, open(path + '.tmp', 'w'))
            os.replace(path + '.tmp', path)
        return res
    raise RuntimeError('rpc retries exhausted for ' + method)

def gtfa(address, filters, details='full', order='asc', limit=100, cap=None, max_pages=None):
    """All transactions (or signatures) of gTFA for `address` under `filters`, following pagination.
    Returns (rows, complete): complete is False if max_pages stopped it early."""
    rows, token, pages = [], None, 0
    while True:
        opt = {'transactionDetails': details, 'sortOrder': order, 'limit': limit, 'filters': filters,
               'commitment': 'finalized', 'encoding': 'json', 'maxSupportedTransactionVersion': 1}
        if token:
            opt['paginationToken'] = token
        res = rpc('getTransactionsForAddress', [address, opt], cap=cap)
        pages += 1
        rows += res.get('data') or []
        token = res.get('paginationToken')
        if not token or not res.get('data') or len(res['data']) < limit:
            return rows, True
        if max_pages and pages >= max_pages:
            return rows, False
