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
    """The credit ledger. A missing ledger starts at 0 only if no response has been cached yet; an empty or broken
    ledger stops the run (a disk-full crash once left it empty, which would have reset the cap)."""
    try:
        with open(LEDGER) as f:
            return json.load(f)
    except FileNotFoundError:
        if os.path.isdir(RAW) and os.listdir(RAW):
            raise SystemExit('credit ledger missing but responses are cached: rebuild it before running')
        return {'calls': 0, 'credits': 0}
    except ValueError:
        raise SystemExit('credit ledger unreadable: rebuild it before running')

def _write_json(path, obj):
    """Write, flush and fsync to a temporary file, then replace: a failed write raises and never leaves an empty file."""
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

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
            _write_json(LEDGER, led)
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
            _write_json(path + '.%d' % threading.get_ident(), res)
            os.replace(path + '.%d' % threading.get_ident(), path)
        return res
    raise RuntimeError('rpc retries exhausted for ' + method)

_short = {'checked': 0, 'extra': 0}
_short_lock = threading.Lock()

def _short_state():
    p = os.path.join(SCRATCH, 'short_pages.json')
    with _short_lock:
        if os.path.exists(p) and not _short['checked']:
            _short.update(json.load(open(p)))
        return _short, p

def gtfa(address, filters, details='full', order='asc', limit=100, cap=None, max_pages=None):
    """All transactions (or signatures) of gTFA for `address` under `filters`, following pagination.
    Returns (rows, complete): complete is False if max_pages stopped it early.
    Helius returns a paginationToken even on a short last page. The first 50 short pages are followed to verify that
    a short page is the end (PREREG F23); only if none of them returns more rows is a short page treated as the end."""
    rows, token, pages, after_short = [], None, 0, False
    while True:
        opt = {'transactionDetails': details, 'sortOrder': order, 'limit': limit, 'filters': filters,
               'commitment': 'finalized', 'encoding': 'json', 'maxSupportedTransactionVersion': 1}
        if token:
            opt['paginationToken'] = token
        res = rpc('getTransactionsForAddress', [address, opt], cap=cap) or {}
        pages += 1
        data = res.get('data') or []
        rows += data
        token = res.get('paginationToken')
        if after_short:
            st, p = _short_state()
            with _short_lock:
                st['checked'] += 1
                st['extra'] += 1 if data else 0
                _write_json(p, st)
        if not token or not data:
            return rows, True
        if len(data) < limit:
            st, p = _short_state()
            if st['checked'] >= 50 and st['extra'] == 0:
                return rows, True
            if max_pages and pages >= max_pages:
                return rows, False
            after_short = True
            continue
        after_short = False
        if max_pages and pages >= max_pages:
            return rows, False
