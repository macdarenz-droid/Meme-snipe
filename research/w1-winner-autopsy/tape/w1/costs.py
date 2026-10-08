"""Our latency and cost (PREREG §7 replay) and transaction costs (§4, AMENDMENT_1).

The fixed costs mirror packages/backtest/src/research/edge-costs.ts `expectedFixed` (conservative scenario,
fills-3 config); test_costs.py checks the number against research/edge/costs.json `fixedLamports`."""

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
