"""Registered constants of H1-CGO (research/h1-cgo/PREREG.md). Section numbers refer to the prereg.

Nothing here is tuned. A value the prereg does not fix is marked "OPEN" and listed in OPEN_QUESTIONS.md with the
conservative reading used.
"""

# §2 days. Rows from 2026-09-12 or later never exist in the tape; the code refuses them.
DISCOVERY_DAYS = ("2026-09-10", "2026-09-11")
VALIDATION_DAYS = ("2026-09-07", "2026-09-08", "2026-09-09")
WALL_DAY = "2026-09-12"  # first forbidden day (U1-B holdout from here)

# §3 universe and decision points
SOL_CURVE_QUOTE = "11111111111111111111111111111111"  # pump CreateEvent quote_mint for SOL
WSOL = "So11111111111111111111111111111111111111112"
DEFAULT_KEY = "11111111111111111111111111111111"
FIRST_DECISION_AFTER_MIGRATION_S = 60 * 60  # migration + 60 minutes (H10's floor)
LAST_DECISION_AFTER_MIGRATION_S = 24 * 60 * 60  # migration + 24 hours
MIN_EFFECTIVE_QUOTE_LAMPORTS = 50 * 10**9  # vault + signed virtual_quote_reserves >= 50 SOL
MIN_REAL_VAULT_LAMPORTS = 30 * 10**9  # real vault >= 30 SOL

# §4 CGO
MIN_COVERAGE = 0.90
BURN_OWNERS = frozenset({"1nc1nerator11111111111111111111111111111111"})
# The tokenized-agent buyback authority (research/shared-tape/README.md, S `protocol`).
PROTOCOL_OWNERS = frozenset({"GmFrDZT2cdrqykgTikVdXbe8EtCgzUDM9VsDhQnwsUsG"})

# H8_AMENDMENT_2: H11 as the bot runs it (packages/core/src/config/policy.ts gates)
H11_CHASE_AFTER_S = 5 * 60  # chaseCheckAfterMs
H11_CHASE_MAX_ABOVE_BPS = 0  # chaseMaxAboveMigrationBps
H11_SPIKE_BPS = 2500  # candleSpikeBps
H11_CANDLE_WINDOW_S = 3 * 60  # candleWindowMs

# §5 gate H1-CGO-0
GATE_A_MIN_PER_DAY = 150
GATE_B_MAX_R2 = 0.8
GATE_C_MIN_SPREAD = 0.2
PAST_RETURN_WINDOWS_S = (60 * 60, 6 * 60 * 60)  # past 1 hour, past 6 hours (+ since migration)

# §6 trade rule
SOL_USD = 119.26  # the repo's reference price (packages/backtest/src/research/edge-costs.ts SOL_USD)
TRADE_USD = 50.0
D_SLOTS = 23
HOLD_S = 60 * 60
BP_LOW_PCT = 20.0
BP_HIGH_PCT = 80.0
# Fixed costs per filled round trip, lamports, as edge-costs.ts expectedFixed() charges them (conservative scenario,
# packages/core/src/config/fills.ts + policy.ts). Recomputed in pumpswap.expected_fixed() and checked against
# research/edge/costs.json in the tests.
FIXED = dict(
    base_fee=5_000, entry_priority=20_000, tip=5_000, ladder_first=20_000, ladder_third=150_000,
    land_ppm_pumpswap=560_000, max_attempts=5, rent=1_513_840, close_success_ppm=900_000, dust_ppm=50_000,
)

# §8 primary
BOOT_RESAMPLES = 10_000
BOOT_SEED = 20261008  # fixed seed (OPEN: the prereg fixes "a fixed seed", not its value; chosen before any scoring)
CI_PRIMARY = 0.995
CI_SECONDARY = 0.95
MIN_TRADES = 300

# §10 secondary
SECONDARY_HOLDS_S = (15 * 60, 4 * 60 * 60)
SECONDARY_SIZES_USD = (5.0, 20.0, 100.0, 1_000.0, 10_000.0)


def spend_of(usd: float) -> int:
    """Lamports for a USD size, as edge-costs.ts spendOf: floor(usd / SOL_USD * 1e9)."""
    import math
    return int(math.floor((usd / SOL_USD) * 1e9))
