"""Shared constants and helpers for the EDGE-HUNT-U1 screen (candle proxies; exploratory)."""
import bisect, json, math, os
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('EH_DATA', os.path.join(HERE, 'data'))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))

WALL = 1789999200           # 2026-09-21T14:00Z: start of Melbourne day 2026-09-22 (research/signals/window.json)
ENTRY_FROM = 1786888800     # 2026-08-16T14:00Z: Melbourne day 2026-08-17 (14 d after the first sampled migration day)
HOLDOUT_FROM = 1789135200   # 2026-09-11T14:00Z: Melbourne day 2026-09-12 -> my holdout = last 10 of 35 days (28.6%)
MIG_FROM = 1785679200       # 2026-08-02T14:00Z: graduations used from here (step 1 paged back past 2026-08-02)
D1, D14 = 86400, 14 * 86400
TMAX = 7200                 # U1 T_max 120 min (preregistration exits.U1)
assert ENTRY_FROM - MIG_FROM >= D14

SOLUSD = json.load(open(os.path.join(DATA, 'sol_usd_hour.json')))
_sol_t = [b[0] + 3600 for b in SOLUSD]  # bar end times

def sol_usd(t):
    """SOL/USD close of the last hourly bar that ended at or before t."""
    i = bisect.bisect_right(_sol_t, t) - 1
    return SOLUSD[i][4] if i >= 0 else None

_fc = json.load(open(os.path.join(REPO, 'research', 'edge', 'snapshot', 'fee-configs.json')))['amm']['fee_tiers']
FEE_TIERS = [(int(x['market_cap_lamports_threshold']) / 1e9,
              sum(int(v) for v in x['fees'].values())) for x in _fc]

def fee_bps(mcap_sol):
    """PumpSwap canonical-pool total fee (lp + protocol + creator) at this market cap, 2026-10-03 snapshot."""
    f = FEE_TIERS[0][1]
    for thr, bps in FEE_TIERS:
        if mcap_sol >= thr: f = bps
    return f

# Fixed costs per position in lamports (docs/research/edge.md section 1, research/edge/costs.json, conservative):
TX = 5000 + 20000 + 5000                  # base + priority + tip per landed tx
FAIL_PER_EXIT = 0.7728 * 155000           # expected failed exit attempts per exit tx
RENT_LOSS = 0.145 * 1513840 + 0.095 * 155000
FIXED_ONE_EXIT = TX + TX + FAIL_PER_EXIT + RENT_LOSS          # = 414,009 (matches costs.json)
EXTRA_EXIT = TX + FAIL_PER_EXIT                               # a partial adds one more exit tx
NOTIONAL_USD = 2.0
