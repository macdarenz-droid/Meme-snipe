"""Integer-exact quotes for the pump curve and PumpSwap, ported from packages/core/src/amm/pump-curve.ts and
pump-swap.ts (the repo's golden-tested formulas). Python ints, so no overflow. Fee rates come from the caller
(here: the fee fields of the neighbouring on-chain trades, PREREG §2 and §4)."""
from dataclasses import dataclass, replace
from typing import Optional

BPS = 10_000


def fee_of(amount: int, bps: int) -> int:
    """ceil(amount * bps / 10,000), as both pump programs charge each fee component."""
    return -(-amount * bps // BPS)


@dataclass(frozen=True)
class Fees:
    lp: int = 0
    protocol: int = 0
    creator: int = 0

    @property
    def total(self) -> int:
        return self.lp + self.protocol + self.creator


@dataclass(frozen=True)
class CurveState:
    virtual_token: int
    virtual_quote: int
    real_token: int
    real_quote: int

    @property
    def complete(self) -> bool:
        return self.real_token <= 0


@dataclass(frozen=True)
class PoolState:
    base: int          # pool base token account
    quote_vault: int   # real quote vault
    virtual_quote: int  # signed virtual_quote_reserves

    @property
    def effective_quote(self) -> int:
        return self.quote_vault + self.virtual_quote


@dataclass(frozen=True)
class Fill:
    ok: bool
    reason: str = ""
    tokens: int = 0          # tokens received (buy) or sold (sell)
    quote: int = 0           # quote into/out of the reserves before fees
    fees: int = 0            # lamports paid in venue fees
    user_quote: int = 0      # paid in (buy, fees included) or received (sell, fees taken)
    impact: int = 0          # lamports lost to price impact against the pre-trade spot
    unsold_tokens: int = 0   # sell only: tokens the real vault could not absorb (valued at 0)


def _split(amount: int, f: Fees):
    return fee_of(amount, f.lp), fee_of(amount, f.protocol), fee_of(amount, f.creator)


# ---------------- bonding curve -----------------------------------------------------------------------
def curve_buy_exact_quote_in(s: CurveState, spend: int, f: Fees) -> Fill:
    """pump-curve.ts curveBuyExactQuoteIn: spend at most `spend` lamports, fees included."""
    if spend <= 1:
        return Fill(False, "zero-spend")
    if s.complete or s.virtual_token <= 0:
        return Fill(False, "curve-complete")
    untrimmed = spend * BPS // (BPS + f.total)
    lp, pr, cr = _split(untrimmed, f)
    over = untrimmed + lp + pr + cr - spend
    quote = untrimmed - over if over > 0 else untrimmed
    inp = quote - 1
    tokens = inp * s.virtual_token // (s.virtual_quote + inp)
    if tokens <= 0:
        return Fill(False, "zero-output")
    if tokens > s.real_token:
        return Fill(False, "exceeds-reserves")
    spot = tokens * s.virtual_quote // s.virtual_token
    fees = lp + pr + cr
    return Fill(True, tokens=tokens, quote=quote, fees=fees, user_quote=quote + fees, impact=quote - spot)


def curve_sell(s: CurveState, tokens: int, f: Fees) -> Fill:
    """pump-curve.ts curveSell: exactly `tokens` in; proceeds floored, fees rounded up."""
    if tokens <= 0:
        return Fill(False, "zero-tokens")
    if s.complete or s.virtual_token <= 0:
        return Fill(False, "curve-complete")
    quote = tokens * s.virtual_quote // (s.virtual_token + tokens)
    if quote > s.real_quote:
        return Fill(False, "exceeds-reserves")
    lp, pr, cr = _split(quote, f)
    user = quote - lp - pr - cr
    if user <= 0:
        return Fill(False, "zero-output")
    spot = tokens * s.virtual_quote // s.virtual_token
    return Fill(True, tokens=tokens, quote=quote, fees=lp + pr + cr, user_quote=user, impact=spot - quote)


def curve_spot_value(s: CurveState, tokens: int) -> int:
    return tokens * s.virtual_quote // s.virtual_token if s.virtual_token > 0 else 0


# ---------------- PumpSwap pool -----------------------------------------------------------------------
def _pool_sell_raw(p: PoolState, base: int, f: Fees):
    eff = p.effective_quote
    quote = eff * base // (p.base + base)
    lp, pr, cr = _split(quote, f)
    return quote, lp, pr, cr


def pool_sell(p: PoolState, base: int, f: Fees) -> Fill:
    """pump-swap.ts poolSell, with the real-vault cap (PREREG §4 exit A, OQ-5): when quote − lp fee exceeds the real
    vault, the largest base amount the vault can absorb is sold and the rest is valued at zero."""
    if base <= 0:
        return Fill(False, "zero-tokens")
    if p.base <= 0 or p.quote_vault <= 0 or p.effective_quote <= 0:
        return Fill(False, "no-liquidity")
    sell = base
    quote, lp, pr, cr = _pool_sell_raw(p, sell, f)
    if p.quote_vault < quote - lp:
        lo, hi = 0, base  # largest sell with quote − lp <= vault (monotone in base)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            q, l_, _, _ = _pool_sell_raw(p, mid, f)
            if q - l_ <= p.quote_vault:
                lo = mid
            else:
                hi = mid - 1
        sell = lo
        if sell <= 0:
            return Fill(False, "exceeds-reserves", unsold_tokens=base)
        quote, lp, pr, cr = _pool_sell_raw(p, sell, f)
    user = quote - lp - pr - cr
    if user <= 0:
        return Fill(False, "zero-output")
    spot = sell * p.effective_quote // p.base
    return Fill(True, tokens=sell, quote=quote, fees=lp + pr + cr, user_quote=user, impact=spot - quote,
                unsold_tokens=base - sell)


def pool_spot_value(p: PoolState, tokens: int) -> int:
    return tokens * p.effective_quote // p.base if p.base > 0 else 0


def worse_buy(fills):
    """Of buys at the start and at the end of a slot, the worse one (fewer tokens). Any refusal makes the slot
    unfillable (OQ-4: a size the curve cannot fill in either state is infeasible)."""
    for x in fills:
        if not x.ok:
            return x
    return min(fills, key=lambda x: (x.tokens, -x.user_quote))


def worse_sell(fills):
    """Of sells at the start and at the end of a slot, the worse one (less SOL received)."""
    ok = [x for x in fills if x.ok]
    if len(ok) < len(fills):
        return next(x for x in fills if not x.ok)
    return min(ok, key=lambda x: x.user_quote)


__all__ = ["Fees", "CurveState", "PoolState", "Fill", "fee_of", "curve_buy_exact_quote_in", "curve_sell",
           "curve_spot_value", "pool_sell", "pool_spot_value", "worse_buy", "worse_sell", "replace", "Optional"]
