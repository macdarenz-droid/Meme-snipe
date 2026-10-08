"""Our latency and cost (PREREG §7 replay) and transaction costs (§4, AMENDMENT_1).

The fixed costs mirror packages/backtest/src/research/edge-costs.ts `expectedFixed` (conservative scenario,
fills-3 config); test_costs.py checks the number against research/edge/costs.json `fixedLamports`."""

import numpy as np

SOL_USD = 119.26                       # edge-costs.ts SOL_USD
REPLAY_USD = 50.0                      # PREREG §7: $50 (0.4193 SOL)
REPLAY_SPEND = round(REPLAY_USD / SOL_USD * 1e9)   # 419,252,054 lamports
REPLAY_DELAY_SLOTS = 23                # PREREG §7: entry and exit each delayed 23 slots

# packages/core/src/config/fills.ts (network, conservative scenario) and policy.ts (exit ladder)
_BASE = 1 * 5_000                       # signaturesPerTx * baseFeePerSignature
_ENTRY_PRIORITY = 20_000
_TIP = 5_000
_LADDER_PRIORITY = [20_000, 60_000, 150_000, 500_000]
_MAX_ATTEMPTS = 5
_RENT = 1_513_840
_LAND_PUMPSWAP_CONSERVATIVE = 560_000 / 1e6
_CLOSE_SUCCESS = 900_000 / 1e6
_DUST = 50_000 / 1e6

ENTRY_LANDED = _BASE + _ENTRY_PRIORITY + _TIP
EXIT_FIXED = _BASE + _LADDER_PRIORITY[0] + _TIP
FAILED_EXIT = _BASE + _LADDER_PRIORITY[min(2, len(_LADDER_PRIORITY) - 1)]


def expected_fixed() -> float:
    """Expected fixed lamports per filled round trip, exactly as edge-costs.ts `expectedFixed`."""
    f = 1 - _LAND_PUMPSWAP_CONSERVATIVE
    failed = sum(f ** k for k in range(1, _MAX_ATTEMPTS + 1))
    rent_back = _CLOSE_SUCCESS * (1 - _DUST)
    failed_close = (1 - _CLOSE_SUCCESS) * (1 - _DUST)
    return ENTRY_LANDED + EXIT_FIXED + failed * FAILED_EXIT + (1 - rent_back) * _RENT + failed_close * FAILED_EXIT


FIXED_ROUND_TRIP = expected_fixed()
# AMENDMENT_1 "the repo's fixed cost per leg": the round trip's expected fixed cost split over its two legs
# (OPEN_QUESTIONS Q4, the larger of the two readings).
FIXED_PER_LEG = FIXED_ROUND_TRIP / 2


def amendment_tx_cost(signer_sol_pre: int, signer_sol_post: int, swaps_sol_net: int, rent_change: int = 0) -> int:
    """AMENDMENT_1 fallback: a transaction's cost to its signer = -(signer SOL change - the SOL its swaps
    paid (negative) or received (positive) for that signer - identified token-account rent change).
    Positive = cost. Used only when S has no tx_fee and the signer owns every swap of the transaction."""
    return -((signer_sol_post - signer_sol_pre) - swaps_sol_net - rent_change)


# AMENDMENT_2 Q2: token-account rents that can be identified in a signer's SOL change (lamports): the Token-2022
# pump account (packages/core/src/config/fills.ts tokenAccountRent) and the SPL associated token account (165 bytes).
RENT_CANDIDATES = (1_513_840, 2_039_280)
APP_FEE_CAP_SHARE = 0.05      # plausibility: app fees above 5% of the SOL traded + 0.01 SOL mean the SOL change is
APP_FEE_CAP_FIXED = 10_000_000  # not the trade's (e.g. a persistent WSOL account); the venue method is used then


def signer_cash(d_signer, venue_sum, tx_fee, jito, k_open, k_close, gross):
    """AMENDMENT_2 Q2, vectorised per transaction whose signer owns every swap.

    d_signer: signer_sol_post - signer_sol_pre; venue_sum: the swaps' SOL by the venue method (+ received, - paid);
    k_open / k_close: mints the signer opened (buy from a zero balance) / closed (sell to zero) in the transaction;
    gross: SOL traded (sum of |venue SOL|). Returns (cash, rent_created, rent_returned, accepted).

    Rent is identified, never assumed: an opening is charged the smaller candidate rent only when the SOL change
    beyond tx_fee + tip is at least that large (so rent is never credited beyond what was spent); a closing is credited
    the candidate nearest to the refund seen when a refund of at least half the smaller rent is seen, else the largest
    candidate is assumed returned (a refund masked by app fees; conservative). cash = SOL
    change + rent created - rent returned. Not accepted (venue method used) when the implied app fee is negative or
    above the cap."""
    d, vs, tf, jt = (np.asarray(x, np.float64) for x in (d_signer, venue_sum, tx_fee, jito))
    ko, kc, gr = (np.asarray(x, np.float64) for x in (k_open, k_close, gross))
    r = d - vs
    small = float(min(RENT_CANDIDATES))
    v_o = -(r + tf + jt)
    created = np.where((ko > 0) & (v_o >= ko * small), ko * small, 0.0)
    v_c = r + tf + jt + created
    per = np.where(kc > 0, v_c / np.maximum(kc, 1), 0.0)
    cand = np.array(RENT_CANDIDATES, np.float64)
    nearest = cand[np.argmin(np.abs(per[:, None] - cand[None, :]), axis=1)] if len(per) else per
    # a refund hidden under app fees cannot be seen: the largest candidate is assumed returned (conservative)
    returned = np.where(kc > 0, np.where(v_c >= kc * small / 2, kc * nearest, kc * float(max(RENT_CANDIDATES))), 0.0)
    cash = d + created - returned
    app = vs - tf - jt - cash
    accepted = (app >= -1) & (app <= APP_FEE_CAP_SHARE * gr + APP_FEE_CAP_FIXED)
    return cash, created, returned, accepted
