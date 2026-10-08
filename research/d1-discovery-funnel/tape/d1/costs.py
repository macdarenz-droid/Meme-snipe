"""PumpSwap quote math and fixed costs, integer-exact, ported from the repo.

- `buy_exact_quote_in`, `sell`: packages/core/src/amm/pump-swap.ts (`poolBuyExactQuoteIn`, `poolSell`), v1 instructions.
- `expected_fixed`: packages/backtest/src/research/edge-costs.ts (`expectedFixed`), with the rent as a parameter
  (AMENDMENT_1 item 11: `fixed_for` uses the rent of the account the mint needs).
Fee rates come from the trade fields of the pool row whose state is used (PREREG §3: "fees from each trade's own
fields"). Price uses effective reserves (vault + signed virtual_quote_reserves); a sell is capped by the real vault.
"""
from dataclasses import dataclass
from typing import Optional

from . import config as C

BPS = 10_000


def fee_of(amount: int, bps: int) -> int:
    """ceil(amount * bps / 10,000), as both pump programs charge each component."""
    return (amount * bps + BPS - 1) // BPS


@dataclass(frozen=True)
class Pool:
    base: int      # pool base reserve
    vault: int     # real quote vault
    virt: int      # signed virtual_quote_reserves
    lp_bps: int
    protocol_bps: int
    creator_bps: int

    @property
    def eff(self) -> int:
        return self.vault + self.virt

    def usable(self) -> bool:
        return self.base > 0 and self.vault > 0 and self.eff > 0


@dataclass(frozen=True)
class Fill:
    base: int        # tokens bought or sold
    quote: int       # quote into / out of the constant product, before fees
    fees: int        # lp + protocol + creator
    user: int        # paid (buy, fees included) or received (sell, fees taken)
    impact: int      # quote lost to price impact vs the pre-trade spot
    after: Pool
    capped: bool = False


def buy_exact_quote_in(p: Pool, spend: int) -> Optional[Fill]:
    if spend <= 1 or not p.usable():
        return None
    total = p.lp_bps + p.protocol_bps + p.creator_bps
    untrimmed = spend * BPS // (BPS + total)
    lp, pr, cr = fee_of(untrimmed, p.lp_bps), fee_of(untrimmed, p.protocol_bps), fee_of(untrimmed, p.creator_bps)
    over = untrimmed + lp + pr + cr - spend
    quote = untrimmed - over if over > 0 else untrimmed
    inp = quote - 1
    base = p.base * inp // (p.eff + inp)
    if base <= 0:
        return None
    spot = base * p.eff // p.base
    after = Pool(p.base - base, p.vault + quote + lp, p.virt, p.lp_bps, p.protocol_bps, p.creator_bps)
    return Fill(base, quote, lp + pr + cr, quote + lp + pr + cr, quote - spot, after)


def sell(p: Pool, base_in: int) -> Optional[Fill]:
    """Sell `base_in`. If the program would refuse (vault < quote - lp fee), the quote out is capped at the real vault
    (CONSERVATIVE reading of "impact on effective reserves capped by the real vault"; see OPEN_QUESTIONS.md)."""
    if base_in <= 0 or not p.usable():
        return None
    quote = p.eff * base_in // (p.base + base_in)
    capped = False
    lp = fee_of(quote, p.lp_bps)
    if p.vault < quote - lp:
        quote, capped = p.vault, True
        lp = fee_of(quote, p.lp_bps)
    pr, cr = fee_of(quote, p.protocol_bps), fee_of(quote, p.creator_bps)
    user = max(0, quote - lp - pr - cr)
    spot = base_in * p.eff // p.base
    after = Pool(p.base + base_in, p.vault - quote + lp, p.virt, p.lp_bps, p.protocol_bps, p.creator_bps)
    return Fill(base_in, quote, lp + pr + cr, user, spot - quote, after, capped)


def expected_failed_exits() -> float:
    f = 1 - C.LAND_PPM_PUMPSWAP_CONSERVATIVE / 1e6
    return sum(f ** k for k in range(1, C.LADDER_MAX_ATTEMPTS + 1))


def rent_rate(entry_slot: int, entry_time: int) -> int:
    """AMENDMENT_2: lamports per byte in force at the entry slot. Keyed by slot only (RENT_BOUNDARY.md: 6,333 from slot
    444,096,000, the first of epoch 1028); entry_time is not used."""
    if entry_slot >= C.EPOCH_1033_FIRST_SLOT:
        return C.RENT_RATE_FROM_EPOCH_1033
    if entry_slot >= C.EPOCH_1028_FIRST_SLOT:   # RENT_BOUNDARY.md (red team R2-13): by slot, not by date
        return C.RENT_RATE_FROM_0903
    return C.RENT_RATE_BEFORE_0903


def rent_for(token_program, entry_slot: int, entry_time: int) -> int:
    """AMENDMENT_1 item 11 / AMENDMENT_2: (128 + bytes of the account the mint needs) x the rate at the entry slot."""
    if token_program == C.TOKEN_2022_PROGRAM:
        size = C.ACCOUNT_BYTES_TOKEN_2022
    elif token_program == C.SPL_TOKEN_PROGRAM:
        size = C.ACCOUNT_BYTES_SPL_TOKEN
    else:
        size = C.UNKNOWN_PROGRAM_BYTES
    return (C.ACCOUNT_OVERHEAD_BYTES + size) * rent_rate(entry_slot, entry_time)


def expected_fixed(rent: int = C.TOKEN_ACCOUNT_RENT) -> float:
    """Expected fixed lamports per filled round trip, exactly as edge-costs.ts `expectedFixed`, for a given rent."""
    base = C.SIGNATURES_PER_TX * C.BASE_FEE_PER_SIGNATURE
    entry_landed = base + C.ENTRY_PRIORITY_FEE + C.TIP
    exit_fixed = base + C.LADDER_PRIORITY_FEES[0] + C.TIP
    failed_exit = base + C.LADDER_PRIORITY_FEES[min(2, len(C.LADDER_PRIORITY_FEES) - 1)]
    close_success, dust = C.CLOSE_SUCCESS_PPM / 1e6, C.DUST_PPM / 1e6
    rent_back = close_success * (1 - dust)
    failed_close = (1 - close_success) * (1 - dust)
    return (entry_landed + exit_fixed + expected_failed_exits() * failed_exit
            + (1 - rent_back) * rent + failed_close * failed_exit)


FIXED_EDGE_COSTS = expected_fixed()  # 414,009: the repo's value, reproduced to check the formula


def fixed_for(token_program, entry_slot: int, entry_time: int) -> float:
    return expected_fixed(rent_for(token_program, entry_slot, entry_time))
