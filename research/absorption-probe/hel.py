"""Read-only Helius access for the absorption probe, with a hard credit cap and key hygiene.

The key is read only from HELIUS_API_KEY and lives only inside _url(); errors are scrubbed. Raw responses are
cached in AB_SCRATCH (outside the repo). Credits are counted in a ledger that survives restarts:
10 per standard RPC call (the task's rule) and 100 per getTransactionsForAddress call (counted conservatively,
because that method returns up to 100 full transactions). Hard cap 2,000,000; at most ~9 requests per second.
Never sends or simulates a transaction.
"""
import hashlib, json, os, sys, threading, time
import requests
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'execution-audit'))
import heli                                            # decoding helpers only (no RPC from it)

SCRATCH = os.environ.get('AB_SCRATCH') or sys.exit('set AB_SCRATCH (outside the repo)')
RAW = os.path.join(SCRATCH, 'raw')
LEDGER = os.path.join(SCRATCH, 'credits.json')
CAP = 2_000_000
COST = {'getTransactionsForAddress': 100}
MIN_GAP = 0.11
READ_ONLY = {'getTransactionsForAddress', 'getSignaturesForAddress', 'getTransaction', 'getBlockTime', 'getBlock', 'getSlot'}
_lock = threading.Lock()
_last = [0.0]

class CapReached(Exception):
    pass

class WindowTooLarge(Exception):
    pass

def _url():
    k = os.environ.get('HELIUS_API_KEY', '')
    if not k:
        raise SystemExit('HELIUS_API_KEY not set')
    return 'https://mainnet.helius-rpc.com/?api-key=' + k

def scrub(s):
    s = str(s); k = os.environ.get('HELIUS_API_KEY', '')
    return s.replace(k, '<key>') if k else s

def ledger():
    try:
        return json.load(open(LEDGER))
    except FileNotFoundError:
        return {'calls': 0, 'credits': 0, 'by_method': {}}

def trim(method, params, res):
    """Full-transaction pages keep only transactions with a PumpSwap event (others carry no swap); the
    page's raw transaction count is kept as `n_raw`. Disk only: the call and its credits are unchanged."""
    if method != 'getTransactionsForAddress' or params[1].get('transactionDetails') != 'full' or not res:
        return res
    keep = []
    for t in res.get('data') or []:
        m = t['transaction']['message']; ks = m['accountKeys']
        lw = (t.get('meta') or {}).get('loadedAddresses') or {}
        ks = ks + lw.get('writable', []) + lw.get('readonly', [])
        if heli.AMM not in ks:
            continue
        ev = False
        for g in (t.get('meta') or {}).get('innerInstructions') or []:
            for ix in g['instructions']:
                if ks[ix['programIdIndex']] == heli.AMM and heli.b58decode(ix['data'])[:8] == heli.EVENT_IX_TAG:
                    ev = True; break
            if ev:
                break
        if ev:
            keep.append(t)
    return {'data': keep, 'paginationToken': res.get('paginationToken'), 'n_raw': len(res.get('data') or [])}

def rpc(method, params, cache=True):
    assert method in READ_ONLY, method
    os.makedirs(RAW, exist_ok=True)
    h = method + '_' + hashlib.sha1(json.dumps([method, params], sort_keys=True).encode()).hexdigest()
    path = os.path.join(RAW, h + '.json')
    if cache and os.path.exists(path):
        return json.load(open(path))
    c = COST.get(method, 10)
    for attempt in range(7):
        with _lock:
            led = ledger()
            if led['credits'] + c > CAP:
                raise CapReached(f"credit cap {CAP} reached ({led['credits']} counted)")
            led['calls'] += 1; led['credits'] += c
            led['by_method'][method] = led['by_method'].get(method, 0) + 1
            json.dump(led, open(LEDGER + '.tmp', 'w')); os.replace(LEDGER + '.tmp', LEDGER)
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
        res = trim(method, params, j['result'])
        if cache and res is not None:
            tmp = path + '.%d.tmp' % threading.get_ident()
            json.dump(res, open(tmp, 'w')); os.replace(tmp, path)
        return res
    raise RuntimeError('rpc retries exhausted for ' + method)

def rpc_v(opt, addr):
    """getTransactionsForAddress, retried with maxSupportedTransactionVersion 1 when a page holds a version-1
    transaction (the retry is a separate, counted call)."""
    try:
        return rpc('getTransactionsForAddress', [addr, opt])
    except RuntimeError as e:
        if '-32015' not in str(e):
            raise
        return rpc('getTransactionsForAddress', [addr, dict(opt, maxSupportedTransactionVersion=1)])

def txs_for_address(addr, t0, t1, limit=100, order='asc', max_pages=10_000, details='full'):
    """Successful transactions touching `addr` with block time in [t0, t1), in the given order (asc =
    oldest first). Each page is one getTransactionsForAddress call (100 credits)."""
    out, token = [], None
    for _ in range(max_pages):
        opt = {'transactionDetails': details, 'sortOrder': order, 'limit': limit, 'encoding': 'json',
               'maxSupportedTransactionVersion': 0, 'commitment': 'finalized',
               'filters': {'blockTime': {'gte': int(t0), 'lt': int(t1)}, 'status': 'succeeded'}}
        if token:
            opt['paginationToken'] = token
        res = rpc_v(opt, addr)
        out += res.get('data') or []
        token = res.get('paginationToken')
        if not token or not res.get('n_raw', len(res.get('data') or [])):
            break
    else:
        raise WindowTooLarge(f'more than {max_pages} pages')
    return out

def activity(addr, t):
    """Successful transactions touching `addr` in the 10 minutes before t (capped at 1000; one call)."""
    r = rpc('getTransactionsForAddress', [addr, {'transactionDetails': 'signatures', 'sortOrder': 'asc', 'limit': 1000,
            'commitment': 'finalized', 'filters': {'blockTime': {'gte': int(t) - 600, 'lt': int(t)}, 'status': 'succeeded'}}])
    return len(r.get('data') or [])

def credits():
    return ledger()

def key_leak_check(paths):
    """True if any file under `paths` contains the key's value (checked before each commit)."""
    k = os.environ.get('HELIUS_API_KEY', '')
    if not k:
        return False
    for root in paths:
        for dp, _, fs in os.walk(root):
            if '.git' in dp.split(os.sep):
                continue
            for f in fs:
                try:
                    if k.encode() in open(os.path.join(dp, f), 'rb').read():
                        print('KEY FOUND IN', os.path.join(dp, f)); return True
                except OSError:
                    pass
    return False

if __name__ == '__main__' and sys.argv[1:] == ['leakcheck']:
    sys.exit(1 if key_leak_check([os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')]) else 0)
