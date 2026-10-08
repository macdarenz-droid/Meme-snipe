"""Executable quotes on the pump curve and on PumpSwap, integer-exact as packages/core/src/amm
(pump-curve.ts `curveSell`, `curveBuyExactQuoteIn`; pump-swap.ts `poolSell`, `poolBuyExactQuoteIn`):
proceeds floored, fees rounded up. Used for the day-end mark and transfer valuation (PREREG §4) and for
the 23-slot replay (§7). A state is a plain tuple so the ledger loop stays cheap.

Curve state  ('c', vsr, vtr, rsr, rtr, fee_bps)   reserves AFTER the last trade (TradeEvent).
Pool state   ('a', base, vault, virtual, fee_bps)  reserves AFTER the last trade (event reserves are
             before the trade; the ledger applies the trade, historical-data.md).
fee_bps is the sum of the rates (one ceil on the summed rate; core rounds each part up, so this can
differ by a few lamports) the last trade on that venue paid (curve: fee + creator + cashback;
pool: lp + protocol + coin creator + cashback)."""

BPS = 10_000
CURVE_INITIAL_REAL_TOKENS = 793_100_000_000_000  # CreateEvent real_token_reserves on the tape (§8 curve progress)


def _fee(amount: int, bps: int) -> int:
    return -(-amount * bps // BPS) if bps > 0 else 0


def curve_sell(state, tokens: int) -> int:
    """Lamports received for selling `tokens` on the curve, gross capped by the real SOL reserves
    (PREREG §4: 'capped by the real vault'). 0 for a complete curve or no tokens."""
    _, vsr, vtr, rsr, rtr, fee_bps = state
    if tokens <= 0 or rtr <= 0:
        return 0
    gross = tokens * vsr // (vtr + tokens)
    gross = min(gross, rsr)
    return max(gross - _fee(gross, fee_bps), 0)


def pool_sell(state, tokens: int) -> int:
    """Lamports received for selling `tokens` into the pool at effective reserves (vault + signed virtual),
    gross capped by the real vault."""
    _, base, vault, virtual, fee_bps = state
    if tokens <= 0 or base <= 0:
        return 0
    q_eff = vault + virtual
    if q_eff <= 0:
        return 0
    gross = q_eff * tokens // (base + tokens)
    gross = min(gross, max(vault, 0))
    return max(gross - _fee(gross, fee_bps), 0)


def sell(state, tokens: int) -> int:
    if state is None or tokens <= 0:
        return 0
    return curve_sell(state, tokens) if state[0] == "c" else pool_sell(state, tokens)


def buy_exact_in(state, spend: int):
    """Tokens received for spending `spend` lamports, fees included (buy_exact_sol_in / buy_exact_quote_in:
    net = floor(spend*10000/(10000+bps)), fees ceil on net, net trimmed to fit). Returns (tokens, state_after)
    or (0, state) when no quote exists."""
    if state is None or spend <= 0:
        return 0, state
    fee_bps = state[-1]
    net = spend * BPS // (BPS + fee_bps)
    over = net + _fee(net, fee_bps) - spend
    if over > 0:
        net -= over
    if net <= 0:
        return 0, state
    if state[0] == "c":
        _, vsr, vtr, rsr, rtr, _f = state
        if rtr <= 0:
            return 0, state
        tokens = (net - 1) * vtr // (vsr + net - 1)
        if tokens <= 0 or tokens > rtr:  # past the cap core refuses the quote
            return 0, state
        return tokens, ("c", vsr + net, vtr - tokens, rsr + net, rtr - tokens, fee_bps)
    _, base, vault, virtual, _f = state
    q_eff = vault + virtual
    if q_eff <= 0 or base <= 0:
        return 0, state
    tokens = base * (net - 1) // (q_eff + net - 1)
    if tokens <= 0:
        return 0, state
    return tokens, ("a", base - tokens, vault + net, virtual, fee_bps)


def spot_price(state) -> float:
    """Lamports per raw token at the venue's reserves (for §8 returns); nan without a state."""
    if state is None:
        return float("nan")
    if state[0] == "c":
        return state[1] / state[2] if state[2] > 0 else float("nan")
    q = state[2] + state[3]
    return q / state[1] if state[1] > 0 else float("nan")


def effective_quote(state) -> float:
    """§8 'effective quote': curve virtual SOL reserves, or pool vault + virtual, lamports."""
    if state is None:
        return float("nan")
    return float(state[1]) if state[0] == "c" else float(state[2] + state[3])


def sell_vec(kind, s1, s2, s3, s4, bps, tokens):
    """Vectorised `sell` in float64 (marks only; can differ from the integer quote by about a lamport).
    kind 0 = curve (s1 vsr, s2 vtr, s3 rsr, s4 rtr), 1 = pool (s1 base, s2 vault, s3 virtual); kind < 0 = no state.
    Returns lamports (float) and a bool array 'has state'."""
    import numpy as np
    kind = np.asarray(kind)
    s1, s2, s3, s4, bps, q = (np.asarray(x, dtype=np.float64) for x in (s1, s2, s3, s4, bps, tokens))
    out = np.zeros(len(q))
    with np.errstate(divide="ignore", invalid="ignore"):
        c = (kind == 0) & (q > 0) & (s4 > 0)
        g = np.floor(q * s1 / (s2 + q))
        g = np.minimum(g, s3)
        out = np.where(c, g - np.ceil(g * bps / BPS), out)
        p = (kind == 1) & (q > 0) & (s1 > 0) & ((s2 + s3) > 0)
        g2 = np.floor((s2 + s3) * q / (s1 + q))
        g2 = np.minimum(g2, np.maximum(s2, 0))
        out = np.where(p, g2 - np.ceil(g2 * bps / BPS), out)
    return np.maximum(out, 0.0), kind >= 0
