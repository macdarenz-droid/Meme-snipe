"""Every registered constant of G1 (PREREG.md, AMENDMENT_1.md, AMENDMENT_2.md), in one place.

Each constant names the section that registers it. Nothing here is tuned on data. Constants marked
"OQ-n" are conservative readings of a silent or ambiguous point, written up in OPEN_QUESTIONS.md.
"""
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --- PREREG §4: rule -------------------------------------------------------------------------------
LAMPORTS = 1_000_000_000
INITIAL_VIRTUAL_SOL = 30 * LAMPORTS            # §4 "real SOL = virtual_sol_reserves − 30 SOL"
TARGET_LAMPORTS = 85_005_000_000              # §4 "Target = 85.005 SOL" (pump-global.json, venues.md 2.2)
TRIGGER_FRACTION = 0.90                       # §4 trigger at 90% of target (76.50 SOL)
D = 23                                        # §4 landing delay, slots
EXIT_B_SECONDS = 30 * 60                      # §4 exit B: 30 minutes after entry, by block time
SOL_USD = 119.26                              # §4 repo reference price (edge-costs.ts SOL_USD)
SIZE_USD_PRIMARY = 50                         # §4 primary size, $50 = 0.4193 SOL
MIGRATION_FEE_LAMPORTS = 15_000_001           # §7 check 4 (pump-global.json poolMigrationFee)
TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000    # pump-global.json tokenTotalSupply
INITIAL_VIRTUAL_TOKENS = 1_073_000_000_000_000
INITIAL_REAL_TOKENS = 793_100_000_000_000

# --- PREREG §5: control S0 -------------------------------------------------------------------------
S0_PROGRESS_RANGE = (0.50, 0.80)              # uniform progress between 50% and 80% of target
S0_SEED = "G1-S0-2026-10-08"                  # fixed seed (committed before scoring, §5)

# --- PREREG §6: gate G1-0 --------------------------------------------------------------------------
GATE_MIN_CATCHABLE_PER_DAY = 100              # kill if fewer on average over the two discovery days
GATE_BOOST_SHARE_AFTER = 0.25                 # kill if BOOST quote after m + D < 25% on most graduates

# --- PREREG §9: primary statistic --------------------------------------------------------------------
BOOTSTRAP_RESAMPLES = 10_000
BOOTSTRAP_SEED = 20261008                     # fixed seed (§9 "fixed seed")
ALPHA_FAMILY = 0.005                          # 99.5% two-sided (loop family)
ALPHA_SHOWN = 0.05                            # 95% shown beside it
MIN_FILLED_TRADES = 300

# --- PREREG §10: secondary (reported, never judged) -----------------------------------------------
SECONDARY_EXITS = {"m+8": 8, "m+45": 45, "m+2D": 2 * D, "m+150": 150, "m+750": 750}
SECONDARY_TRIGGERS = (0.80, 0.95)
SECONDARY_SIZES_USD = (5, 20, 100, 1000, 10_000)

# --- AMENDMENT_1: G1-HC ------------------------------------------------------------------------------
HC_HUB_DEGREE = 50                            # never join through an address linked to > 50 owners
HC_EARLY_BUY_SLOTS = 10                       # group 2: first buy within 10 slots of create
HC_COST_FRACTION = 0.5                        # group 3: average cost <= half the curve price at t0
HC_SERIAL_MIN_BUYS = 5                        # group 4: at least 5 buys before the slot
HC_SERIAL_NEAR_SHARE = 0.10                   # group 4: of which >= 10% within 2 slots of create/migration
HC_SERIAL_NEAR_SLOTS = 2
HC_GATE_RHO = 0.2                             # gate (a)
HC_GATE_COVERAGE = 0.90                       # gate (b)
HC_GATE_MIN_PER_DAY = 100                     # gate (c)
BOOST_DESCRIPTIVE_OFFSETS = (D, 150, 300)     # unspent BOOST at m + D, m + 150, m + 300

# --- AMENDMENT_2: G1-CAP -----------------------------------------------------------------------------
CAP_RIVAL_REAL_SOL = 68 * LAMPORTS            # curves holding at least 68.0 real SOL
CAP_RECENT_MIGRATION_S = 90                   # plus migrations in [t − 90 s, t]
CAP_LAMBDA_WINDOW_S = 3600                    # trailing-hour mean
CAP_GRID_S = 10                               # on a 10-second grid
CAP_GATE_RHO_Z_LAMBDA = 0.3                   # gate (b) |rho(Z, lambda)| <= 0.3
CAP_GATE_IQR_Z = 1.0                          # gate (b) IQR of Z >= 1
CAP_GATE_RHO_FLOW = -0.10                     # gate (c) rho <= -0.10, one-sided 95% upper bound < 0
CAP_GATE_MIN_PER_DAY = 50                     # gate (d)

# --- Fixed costs and rent ------------------------------------------------------------------------
with open(os.path.join(HERE, "fixed_costs.json")) as _f:
    FIXED = json.load(_f)                     # produced by fixed_costs.ts from edge-costs.ts
REPO_RENT_LAMPORTS = 1_513_840                # §4 "the repo's 1,513,840 lamports"
TOKEN_ACCOUNT_BYTES = {"token2022": 170, "spl": 165}   # docs/research/execution.md line 417
SLOTS_PER_EPOCH = 432_000
# SIMD-0437 lamports per byte by epoch (docs/research/execution.md F1: epoch 1028 2026-09-03, epoch 1033 2026-09-11).
RENT_LAMPORTS_PER_BYTE = ((1033, 5_080), (1028, 6_333), (0, 6_960))
ACCOUNT_STORAGE_OVERHEAD = 128

# --- Addresses -----------------------------------------------------------------------------------
SOL_QUOTE_CURVE = "11111111111111111111111111111111"     # pump curve quote_mint for SOL
WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
BUYBACK_AUTHORITY = "GmFrDZT2cdrqykgTikVdXbe8EtCgzUDM9VsDhQnwsUsG"   # tapedec extras.go buybackAuthority
TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

# --- Coverage horizon for BOOST descriptive rows (OQ-9) -----------------------------------------
BOOST_COMPLETE_HORIZON_SLOTS = 4_500


def spend_lamports(usd: float) -> int:
    """edge-costs.ts spendOf: floor(usd / SOL_USD * 1e9)."""
    return int((usd / SOL_USD) * 1e9)


def trigger_lamports(fraction: float) -> int:
    """Real SOL that a curve trade must reach for a trigger at `fraction` of the target (rounded up)."""
    num = TARGET_LAMPORTS * round(fraction * 10_000)
    return -(-num // 10_000)
