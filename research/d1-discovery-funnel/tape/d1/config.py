"""Registered constants of D1 (research/d1-discovery-funnel/PREREG.md). Nothing here is tuned on data.

Every value cites the PREREG section, the sibling design it borrows a definition from, or the repo file it copies.
Readings chosen where the PREREG is silent are marked CONSERVATIVE and listed in ../OPEN_QUESTIONS.md.
"""
import calendar
import time

# ---- Days (PREREG §2) -------------------------------------------------------------------------------------------
DISCOVERY_DAYS = ("2026-09-10", "2026-09-11")          # Step A
VALIDATION_DAYS_STEP_B = ("2026-09-07", "2026-09-08", "2026-09-09")  # Step B, only if released


def epoch(day: str) -> int:
    return calendar.timegm(time.strptime(day, "%Y-%m-%d"))


# U1-B's holdout starts 2026-09-12; the wall is 2026-09-21T14:00Z; the sealed window starts 2026-09-22.
# No tape row may be at or after this instant (SHARED_TAPE_PLAN P5, tape README "decode").
WALL_EPOCH = epoch("2026-09-12")  # 1789171200

# ---- Universe (PREREG §3) ---------------------------------------------------------------------------------------
WSOL = "So11111111111111111111111111111111111111112"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
H10_MIN_AGE_S = 60 * 60            # migration + 60 min (H10, packages/core/src/config/policy.ts excludedWindowMs)
MAX_AGE_S = 24 * 60 * 60           # to migration + 24 h
MIN_EFFECTIVE_QUOTE = 50 * 10**9   # lamports: vault + signed virtual_quote_reserves
MIN_REAL_VAULT = 30 * 10**9        # lamports
GRID_S = 5 * 60                    # decision points every 5 minutes (CONSERVATIVE reading: UTC-aligned marks)

# ---- Trade (PREREG §3) --------------------------------------------------------------------------------------------
DELAY_SLOTS = 23                   # buy at decision + 23 slots; exit trigger + 23 slots (CONSERVATIVE, as H1-CGO §6)
HOLDS_S = (15 * 60, 60 * 60)       # two hold arms
THROTTLE_S = 60 * 60               # at most one entry per pool per hour (CONSERVATIVE: rolling 60 min)
SOL_USD = 119.26                   # packages/backtest/src/research/edge-costs.ts SOL_USD
SIZE_USD = 50
SPEND_LAMPORTS = int((SIZE_USD / SOL_USD) * 1e9)  # edge-costs.ts spendOf: floor -> 419,252,054
MCAP_REF_LAMPORTS = 420 * 10**9    # "market cap relative to 420 SOL"

# Fixed costs per filled round trip, exactly as edge-costs.ts `expectedFixed()` (conservative scenario,
# packages/core/src/config/fills.ts and policy.ts). Recomputed in costs.py and tested against research/edge/costs.json.
SIGNATURES_PER_TX = 1
BASE_FEE_PER_SIGNATURE = 5_000
ENTRY_PRIORITY_FEE = 20_000
TIP = 5_000
LADDER_PRIORITY_FEES = (20_000, 60_000, 150_000, 500_000)
LADDER_MAX_ATTEMPTS = 5
LAND_PPM_PUMPSWAP_CONSERVATIVE = 560_000
TOKEN_ACCOUNT_RENT = 1_513_840        # edge-costs.ts value; kept only to reproduce its 414,009 (tests)
# AMENDMENT_1 item 11 as corrected by AMENDMENT_2: rent of the token account the mint needs, with RENT-1's refund model.
# rent = (128 + account bytes) x lamports_per_byte in force at the entry slot (SIMD-0437).
TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
ACCOUNT_BYTES_TOKEN_2022 = 170       # Token-2022 associated account with extensions
ACCOUNT_BYTES_SPL_TOKEN = 165
ACCOUNT_OVERHEAD_BYTES = 128
RENT_RATE_BEFORE_0903 = 6_960        # before 2026-09-03
RENT_RATE_FROM_0903 = 6_333          # from 2026-09-03
RENT_RATE_FROM_EPOCH_1033 = 5_080    # from epoch 1033 (2026-09-11 21:12 UTC)
RENT_DATE_0903 = epoch("2026-09-03")
SLOTS_PER_EPOCH = 432_000
EPOCH_1033_FIRST_SLOT = 1033 * SLOTS_PER_EPOCH   # 446,256,000
UNKNOWN_PROGRAM_BYTES = ACCOUNT_BYTES_TOKEN_2022  # token program not on the tape: the larger account (CONSERVATIVE)
CLOSE_SUCCESS_PPM = 900_000
DUST_PPM = 50_000
EXPECTED_FIXED_LAMPORTS_REPO = 414_009  # research/edge/costs.json fixedLamports (rounded)

# Red team R2-11: before a pool's first fee-paying row, fills pay the dearest PumpSwap tier (lp, protocol, creator) of
# research/edge/snapshot/fee-configs.json (125 bps, the market-cap-0 tier); no later row's rate is ever used. The
# snapshot is from October: whether it is the dearest tier valid on each tape date is an open question (CODE_REDTEAM).
FALLBACK_FEE_BPS = (2, 93, 30)

# ---- W1 fast class (research/w1-winner-autopsy/PREREG.md §3, §5) -------------------------------------------------
FAST_NEAR_EVENT_SLOTS = 2
FAST_NEAR_EVENT_SHARE = 0.10
FAST_FOLLOW_SLOTS = 2
FAST_FOLLOW_SHARE = 0.30
FAST_LEADER_MIN_LAMPORTS = 1 * 10**9
HUB_MAX_LINKS = 50                 # an address linked to more than 50 owners is never used for joining

# BOOST swaps (found by signature via BoostBuyAndBurnEvent) and protocol swaps are left out of every flow, buyer and
# "Who" feature and of the fast-class buys. CONSERVATIVE pending the lead's ruling (OPEN_QUESTIONS #21).
EXCLUDE_PROTOCOL_SWAPS = True

# Step A plan (research/shared-tape/stepa-plan.txt: "DAY EPOCH FROM TO" per unit). Its sha256 is fixed here.
STEPA_PLAN_SHA256 = "fa99c8788f845a7d9f4a5c967d7cce18c0a7f476082c1969fc35cf4f57f38fc7"
# Step B plan (research/shared-tape/stepb-plan.txt, registered 2026-10-08 with stepb-plan.sha256; the same sha W1's
# guard fixes). Validation is judged only on every planned unit of every Step B day (red team R2-1).
STEPB_PLAN_SHA256 = "44f133a5b825876b8ca29bb9b807e3d75e2d2fb375780e26f3570fdab03058d5"

# ---- Feature windows (PREREG §4) --------------------------------------------------------------------------------
W5 = 5 * 60
W15 = 15 * 60
W60 = 60 * 60
CF_WINDOW_S = 60 * 60
WHO_WINDOW_S = 15 * 60             # CONSERVATIVE: the PREREG names 15 min only for failed buys; used for all "Who"

FEATURES = (
    # price path (5)
    "ret_5m", "ret_15m", "ret_60m", "ret_since_mig", "rv_15m",
    # flow (9)
    "buys_5m", "sells_5m", "net_sol_5m", "buys_15m", "sells_15m", "net_sol_15m",
    "uniq_buyers_15m", "first_buyers_15m", "max_sell_share_15m",
    # who (4)
    "fast_buy_share", "creator_cluster_buy_share", "app_routed_buy_share", "failed_buy_share_15m",
    # holders (4)
    "top10_share", "creator_share", "cgo", "cgo_coverage",
    # protocol (3)
    "boost_finished", "mcap_rel_420", "cf_collections_1h",
    # pool (3)
    "effective_quote_sol", "real_vault_sol", "age_since_mig_min",
)
assert len(FEATURES) == 28
BINARY_FEATURES = ("boost_finished",)   # AMENDMENT_1 item 23: top = 1, bottom = 0

# ---- Search (PREREG §5) -----------------------------------------------------------------------------------------
N_BLOCKS = 4
BLOCK_S = 6 * 60 * 60
FOLD_GAP_S = 60 * 60
Q_LOW, Q_HIGH = 0.20, 0.80
MIN_TRADES_PER_FOLD = 30
N_ADVANCE = 5

# ---- H8 at trade size (research/brainstorm-loop/H8_AMENDMENT.md; reporting only) ----------------------------------
H8_MIN_QUOTE_USD = 15_000          # policy.ts:205
H8_SIZE_MULTIPLE = 1_000           # floor = max($15,000, 1,000 x trade size)
H8_SIZES_USD = (5, 20, 50)
# sha256 of research/brainstorm-loop/sol-usd/SHA256SUMS (Binance SOLUSDT 1h/1m, 09-02..09-11): the pinned price input
SOLUSD_SUMS_SHA256 = "02083908d386a53c07acd1663bdd74f102053f12bcd92856cf09670fcf3da964"

# ---- H8 amendment 2 and AMENDMENT_3: universe tags and the bot's gates as of the decision ---------------------
# packages/core/src/config/research.ts (s0.u2Window*), docs/ARCHITECTURE.md §3.2 (U1), config/policy.ts gates.
U2_FROM_S, U2_TO_S = 60 * 60, 240 * 60
U1_FROM_S, U1_TO_S = 24 * 3600, 14 * 24 * 3600
U1_MIN_MCAP_SOL = 1_470
H8_U1_FLOOR_USD = 50_000           # policy.ts u1FloorUsd
H8_COUNT_SIZES_USD = (5, 20, 50, 100, 200, 500, 1_000, 10_000)   # H8_AMENDMENT_2 item 4
H8_TRADABLE_SIZE_USD = 5           # H8_AMENDMENT_2 item 3: the trial maximum (policy.ts maxNotional)
DUST_MIN_AT_MIGRATION = 5 * 10**9  # policy.ts gates.dustPoolMinAtMigration
H9_MIN_GRADUATION_S = 5 * 60       # gates.instantGraduationMinMs
H11_SPIKE_WINDOW_S = 3 * 60        # gates.candleWindowMs
H11_SPIKE_BPS = 2_500              # gates.candleSpikeBps
H11_CHASE_AFTER_S = 5 * 60         # gates.chaseCheckAfterMs (chaseMaxAboveMigrationBps = 0)
POOL_ACCOUNT_MIN_BYTES = 300       # tx/shape.ts POOL_ACCOUNT_MIN_BYTES
H12_HARD_BPS, H12_SINGLE_BPS, H12_TOP10_BPS = 4_000, 1_000, 3_000
H13_INSIDER_BPS, H13_DEV_CLUSTER_BPS = 1_500, 500
H13_INSIDER_SLOTS, H13_FIRST_BUYERS = 2, 20   # facts/producer.ts insiderSlots, firstBuyers

# ---- Validation (PREREG §6; bootstrap size and seed as H1-CGO §8 / G1 §9) ---------------------------------------
ALPHA = 0.005
N_BOOT = 10_000
BOOT_SEED = 20261008
MIN_TRADES_VALIDATION = 300
