"""Read-only Helius fetching for the launch probe (rules in PREREG.md).

  LP_SCRATCH=<dir outside repo> python3 -I fetch.py measure <n>          # signature counts only, no returns
  LP_SCRATCH=<dir outside repo> python3 -I fetch.py sample <window> <n>   # draws launches, writes derived/sample_<window>.json
  LP_SCRATCH=<dir outside repo> python3 -I fetch.py coins <window>        # fetches every sampled launch (cached)

Key hygiene and the credit cap are those of research/execution-audit/heli.py (key only inside its _url(),
errors scrubbed, ledger in the scratch directory, 10 credits counted per call, hard stop at CAP). Raw responses
are cached in LP_SCRATCH, never in the repo.
"""
import json, os, random, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SCR = os.environ.get('LP_SCRATCH')
if not SCR:
    raise SystemExit('LP_SCRATCH not set (a directory outside the repo)')
if os.path.realpath(SCR).startswith(os.path.realpath(os.path.join(HERE, '..', '..'))):
    raise SystemExit('LP_SCRATCH must be outside the repository')
os.environ['EA_SCRATCH'] = SCR
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'execution-audit'))
import heli, pumpdec
heli.CAP = 1_500_000
heli.MIN_GAP = 0.105                          # at most ~9.5 requests per second
from concurrent.futures import ThreadPoolExecutor
POOL = ThreadPoolExecutor(8)

MINT_AUTH = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM'
WINDOWS = {                                   # [start, end) unix seconds, UTC
    'measure': (1783641600, 1784505600),      # 2026-07-10 .. 07-20 (outside both windows, sizing only)
    'discovery': (1784678400, 1787270400),    # 2026-07-22 00:00 .. 08-21 00:00
    'validation': (1787270400, 1788739200),   # 2026-08-21 00:00 .. 09-07 00:00
}
WALL = 1790085600                             # 2026-09-21T14:00Z: nothing at or after
DRAW_W = 20                                   # seconds of creates taken before each random anchor
HORIZON = 3900                                # seconds after creation fetched (480-slot entry + 60 min + margin)
DERIVED = os.path.join(HERE, 'derived')

def tx(sig):
    return heli.rpc('getTransaction', [sig, {'encoding': 'json', 'maxSupportedTransactionVersion': 0,
                                             'commitment': 'finalized'}], cache_name='tx_' + sig)

def draw(window, n, seed):
    """Uniform-by-time draw: n random instants in the window; at each, every successful create transaction of
    the mint authority with block time in [bt - DRAW_W, bt), bt = the anchor block's time (within 20 s before
    the instant). Fixed-length windows give every launch the same inclusion probability."""
    t0, t1 = WINDOWS[window]
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        T = rng.randrange(t0 + 60, t1)
        a, slot, bt = heli.anchor_sig(T)
        page = heli.rpc('getSignaturesForAddress', [MINT_AUTH, {'before': a, 'limit': 200, 'commitment': 'finalized'}])
        got = [x for x in page if x['err'] is None and x.get('blockTime') is not None and bt - DRAW_W <= x['blockTime'] < bt]
        if page and page[-1].get('blockTime', 0) >= bt - DRAW_W:
            raise RuntimeError('draw window larger than one page')
        out.append({'T': T, 'anchor_slot': slot, 'bt': bt, 'sigs': [x['signature'] for x in got]})
    return out

def launch(sig):
    """Create transaction -> launch record (None if it holds no pump.fun CreateEvent)."""
    t = tx(sig)
    ev = pumpdec.events(t)
    cr = [e for k, i, e in ev if k == 'create']
    if not cr:
        return None
    c = cr[0]
    return {'sig': sig, 'slot': t['slot'], 'idx': t.get('transactionIndex'), 'time': t['blockTime'],
            'mint': c['mint'], 'bc': c['bonding_curve'], 'creator': c['creator']}

def bc_sigs(L):
    """Successful and failed signatures on the bonding curve from creation to creation + HORIZON, oldest first."""
    out, before = [], None
    for page_no in range(6):
        params = {'until': L['sig'], 'limit': 1000, 'commitment': 'finalized'}
        if before:
            params['before'] = before
        page = heli.rpc('getSignaturesForAddress', [L['bc'], params])
        out += page
        if len(page) < 1000:
            break
        before = page[-1]['signature']
    else:                                     # very long history: restart from an anchor at the horizon's end
        a, _, _ = heli.anchor_sig(L['time'] + HORIZON + 30)
        out, before = [], a
        while True:
            params = {'until': L['sig'], 'limit': 1000, 'commitment': 'finalized', 'before': before}
            page = heli.rpc('getSignaturesForAddress', [L['bc'], params])
            out += page
            if len(page) < 1000:
                break
            before = page[-1]['signature']
    rows = [x for x in out if x.get('blockTime') is not None and x['blockTime'] <= L['time'] + HORIZON]
    return rows[::-1]

def measure(n):
    """Sizing only: for launches drawn outside both windows, count bonding-curve signatures in the first 60 min."""
    d = draw('measure', n, seed=777)
    res = []
    for w in d:
        for s in w['sigs']:
            L = launch(s)
            if not L:
                continue
            rows = bc_sigs(L)
            n60 = sum(1 for x in rows if x['blockTime'] <= L['time'] + 3600)
            ok = sum(1 for x in rows if x['blockTime'] <= L['time'] + HORIZON and x['err'] is None)
            res.append((n60, ok))
    res.sort()
    print('launches', len(res), 'per draw', len(res) / n)
    print('sigs in 60 min (sorted):', [r[0] for r in res])
    print('successful sigs to horizon: total', sum(r[1] for r in res), 'mean', sum(r[1] for r in res) / max(1, len(res)))
    print(heli.credits())

if __name__ == '__main__':
    cmd = sys.argv[1]
    try:
        if cmd == 'measure':
            measure(int(sys.argv[2]))
    except Exception as e:
        print('error:', heli.scrub(type(e).__name__), heli.scrub(e)[:300], file=sys.stderr); raise SystemExit(1)
