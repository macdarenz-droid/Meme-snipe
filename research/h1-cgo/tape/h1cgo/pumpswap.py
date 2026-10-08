"""PumpSwap pool quotes, integer-exact: a port of packages/core/src/amm/pump-swap.ts and fees.ts (v1 instructions,
canonical SOL pools, no creator-fee override), plus the fixed costs of packages/backtest/src/research/edge-costs.ts.

Rates come from research/edge/snapshot/fee-configs.json (the live FeeConfig); tests/test_pumpswap.py and
`check_fee_tiers` verify the tier table against the fee bps the tape itself records."""
import json
import os
from dataclasses import dataclass

from .constants import FIXED


def _load_json(path):
    with open(path) as f:
        return json.load(f)

BPS = 10_000
_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
FEE_CONFIG_PATH = os.path.join(_REPO, "research", "edge", "snapshot", "fee-configs.json")


def load_tiers(path: str = FEE_CONFIG_PATH):
    raw = _load_json(path)["amm"]["fee_tiers"]
    tiers = [(int(t["market_cap_lamports_threshold"]),
              (int(t["fees"]["lp_fee_bps"]), int(t["fees"]["protocol_fee_bps"]), int(t["fees"]["creator_fee_bps"])))
             for t in raw]
    for i in range(1, len(tiers)):
        if tiers[i][0] < tiers[i - 1][0]:
            raise ValueError("fee tiers must be in ascending threshold order")
    return tiers


def select_tier(tiers, market_cap: int):
    """pump-fees calculate_fee_tier: below the first threshold the first tier, else the last tier <= market cap."""
    for thr, fees in reversed(tiers):
        if market_cap >= thr:
            return fees
    return tiers[0][1]


def ceil_bps(amount: int, bps: int) -> int:
    return -((-amount * bps) // BPS)


@dataclass(frozen=True)
class Pool:
    base: int  # pool base token account amount
    vault: int  # real quote vault, lamports
    virtual: int  # signed virtual_quote_reserves

    @property
    def eff(self) -> int:
        return self.vault + self.virtual

    def mid(self) -> float:
        """Executable mid on effective reserves, lamports per raw token."""
        return self.eff / self.base


def pool_fees(pool: Pool, tiers, base_supply: int, creator_charged: bool):
    if pool.base <= 0:
        raise ValueError("base reserve must be > 0")
    lp, proto, creator = select_tier(tiers, (pool.eff * base_supply) // pool.base)
    return lp, proto, (creator if creator_charged else 0)


@dataclass(frozen=True)
class Trade:
    ok: bool
    reason: str = ""
    base: int = 0
    quote: int = 0  # into (buy) or out of (sell) the constant product, before fees
    fees: int = 0  # lp + protocol + creator, lamports
    user_quote: int = 0  # paid in (buy) or received (sell), fees included
    impact: int = 0  # lamports lost to price impact against the pre-trade mid
    fee_bps: tuple = (0, 0, 0)


def _refuse(pool: Pool):
    if pool.base <= 0 or pool.vault <= 0 or pool.eff <= 0:
        return Trade(False, "no-liquidity")
    return None


def buy_exact_quote_in(pool: Pool, spend: int, tiers, base_supply: int, creator_charged: bool = True) -> Trade:
    """pump-swap.ts poolBuyExactQuoteIn."""
    if spend <= 1:
        raise ValueError("spend must be > 1")
    r = _refuse(pool)
    if r:
        return r
    lp, pr, cr = pool_fees(pool, tiers, base_supply, creator_charged)
    untrimmed = (spend * BPS) // (BPS + lp + pr + cr)
    over = untrimmed + ceil_bps(untrimmed, lp) + ceil_bps(untrimmed, pr) + ceil_bps(untrimmed, cr) - spend
    quote = untrimmed - over if over > 0 else untrimmed
    inp = quote - 1
    base = (pool.base * inp) // (pool.eff + inp)
    if base <= 0:
        return Trade(False, "zero-output")
    fees = ceil_bps(untrimmed, lp) + ceil_bps(untrimmed, pr) + ceil_bps(untrimmed, cr)
    impact = quote - (base * pool.eff) // pool.base
    return Trade(True, "", base, quote, fees, quote + fees, impact, (lp, pr, cr))


def sell(pool: Pool, base: int, tiers, base_supply: int, creator_charged: bool = True) -> Trade:
    """pump-swap.ts poolSell."""
    if base <= 0:
        raise ValueError("base in must be > 0")
    r = _refuse(pool)
    if r:
        return r
    lp, pr, cr = pool_fees(pool, tiers, base_supply, creator_charged)
    quote = (pool.eff * base) // (pool.base + base)
    lpf, prf, crf = ceil_bps(quote, lp), ceil_bps(quote, pr), ceil_bps(quote, cr)
    if pool.vault < quote - lpf:
        return Trade(False, "exceeds-reserves")
    user = quote - lpf - prf - crf
    if user <= 0:
        return Trade(False, "zero-output")
    impact = (base * pool.eff) // pool.base - quote
    return Trade(True, "", base, quote, lpf + prf + crf, user, impact, (lp, pr, cr))


def amm_post_state(r) -> tuple:
    """(pre Pool, post Pool) of one PumpSwap trade row. Event reserves are pre-trade. Effective quote after =
    effective before + (quote in + lp fee) on a buy, - (quote out - lp fee) on a sell; the real vault after is the
    chain balance when the row is the pool's last trade in its transaction, else the v1 vault update."""
    pre = Pool(int(r["pool_base_token_reserves"]), int(r["pool_quote_token_reserves"]), int(r["virtual_quote_reserves"] or 0))
    base_amt = int(r["base_amount"])
    if r["side"] == "buy":
        dq = int(r["quote_amount_lp_adjusted"])  # quote into the curve + lp fee (both buy instructions)
        base = pre.base - base_amt
    else:
        dq = -(int(r["quote_amount"]) - int(r["lp_fee"]))
        base = pre.base + base_amt
    eff = pre.eff + dq
    vault = pre.vault + dq
    if r.get("last_in_tx") == "1" and r.get("chain_pool_quote", "") != "":
        vault = int(r["chain_pool_quote"])
    return pre, Pool(base, vault, eff - vault)


TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
# AMENDMENT_1 (rent): the rent of the token account the mint actually needs. Token-2022 with extensions (170 bytes):
# 2,074,080 lamports, as ruled. Legacy SPL Token (165 bytes) on the same 6,960 lamports-a-byte basis: (165 + 128) x
# 6,960 = 2,039,280. An unknown program is charged the larger, Token-2022 amount.
RENT_BY_PROGRAM = {TOKEN_2022: 2_074_080, SPL_TOKEN: 2_039_280}
RENT_DEFAULT = 2_074_080


def token_account_rent(token_program: str) -> int:
    return RENT_BY_PROGRAM.get(token_program, RENT_DEFAULT)


def expected_fixed(rent: int = None) -> float:
    """edge-costs.ts expectedFixed(): entry landed + exit fixed + expected failed exits + rent not returned + a close
    that fails without dust, lamports per filled round trip. `rent` replaces the repo's tokenAccountRent (AMENDMENT_1);
    left out, the repo's value is used (only for the parity check with research/edge/costs.json)."""
    f = dict(FIXED)
    if rent is not None:
        f["rent"] = rent
    entry = f["base_fee"] + f["entry_priority"] + f["tip"]
    exit_fixed = f["base_fee"] + f["ladder_first"] + f["tip"]
    failed_exit = f["base_fee"] + f["ladder_third"]
    p = 1 - f["land_ppm_pumpswap"] / 1e6
    e_fail = sum(p ** k for k in range(1, f["max_attempts"] + 1))
    close, dust = f["close_success_ppm"] / 1e6, f["dust_ppm"] / 1e6
    rent_back = close * (1 - dust)
    failed_close = (1 - close) * (1 - dust)
    return entry + exit_fixed + e_fail * failed_exit + (1 - rent_back) * f["rent"] + failed_close * failed_exit


def check_fee_tiers(rows, tiers) -> dict:
    """Diagnostic: compare the tier table with the fee bps the tape records on canonical SOL pool trades.
    `rows` iterates dicts with pre-trade reserves, base_supply and the three bps columns."""
    n = match = zero = 0
    for r in rows:
        obs = (int(r["lp_fee_basis_points"]), int(r["protocol_fee_basis_points"]), int(r["coin_creator_fee_basis_points"]))
        if obs == (0, 0, 0):
            zero += 1
            continue
        p = Pool(int(r["pool_base_token_reserves"]), int(r["pool_quote_token_reserves"]), int(r["virtual_quote_reserves"] or 0))
        t = select_tier(tiers, (p.eff * int(r["base_supply"])) // p.base)
        n += 1
        match += int(t[:2] == obs[:2] and (obs[2] == 0 or obs[2] == t[2]))
    return {"checked": n, "match": match, "zero_fee_rows": zero}
