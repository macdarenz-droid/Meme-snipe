"""Small synthetic tape tables in the shared-tape column layout (all values strings)."""
import pandas as pd

from h1cgo.features import AMM_COLS, CURVE_COLS, T_COLS, TCOV_COLS

DAY0 = 1789084800  # 2026-09-11T00:00Z
WSOL = "So11111111111111111111111111111111111111112"


def t_of(slot):
    """2 slots a second from slot 0 at DAY0."""
    return DAY0 + slot // 2


def curve_row(slot, tx, owner, is_buy, tokens, sol, mint="M", fee=0, creator_fee=0, post="", protocol="0", outer=0, inner=""):
    r = {c: "" for c in CURVE_COLS}
    r.update(slot=str(slot), block_time=str(t_of(slot)), tx_idx=str(tx), ev_idx="0", outer_ix=str(outer), inner_ix=str(inner),
             mint=mint, is_buy="1" if is_buy else "0", sol_amount=str(sol), token_amount=str(tokens), fee=str(fee),
             creator_fee=str(creator_fee), user_token_owner=owner, owner_token_post=str(post), protocol=protocol,
             quote_mint="11111111111111111111111111111111")
    return r


def amm_row(slot, tx, owner, side, base_amt, pre_base, pre_vault, virtual=0, quote=None, lp_bps=20, pool="P", mint="M",
            post="", protocol="0", supply=10**15, outer=0, inner=""):
    """A PumpSwap trade consistent with the constant product on effective reserves (fees: lp 20, protocol 5, creator 95)."""
    eff = pre_vault + virtual
    if side == "buy":
        q = quote if quote is not None else -(-eff * base_amt // (pre_base - base_amt))
        lp, pr, cr = -(-q * lp_bps // 10_000), -(-q * 5 // 10_000), -(-q * 95 // 10_000)
        lp_adj, user = q + lp, q + lp + pr + cr
    else:
        q = eff * base_amt // (pre_base + base_amt)
        lp, pr, cr = -(-q * lp_bps // 10_000), -(-q * 5 // 10_000), -(-q * 95 // 10_000)
        lp_adj, user = q - lp, q - lp - pr - cr
    r = {c: "" for c in AMM_COLS}
    r.update(slot=str(slot), block_time=str(t_of(slot)), tx_idx=str(tx), ev_idx="0", outer_ix=str(outer), inner_ix=str(inner),
             pool=pool, base_mint=mint, quote_mint=WSOL, side=side, base_amount=str(base_amt), quote_amount=str(q),
             quote_amount_lp_adjusted=str(lp_adj), lp_fee=str(lp), protocol_fee=str(pr), coin_creator_fee=str(cr),
             user_quote_amount=str(user), pool_base_token_reserves=str(pre_base), pool_quote_token_reserves=str(pre_vault),
             virtual_quote_reserves=str(virtual), base_supply=str(supply), coin_creator="CREATOR", user_token_owner=owner,
             owner_token_post=str(post), canonical="1", protocol=protocol, last_in_tx="0", chain_pool_quote="",
             lp_fee_basis_points=str(lp_bps), protocol_fee_basis_points="5", coin_creator_fee_basis_points="95")
    return r


def t_row(slot, tx, kind, frm, to, amount, mint="M", outer=1, inner=""):
    r = {c: "" for c in T_COLS}
    r.update(slot=str(slot), tx_idx=str(tx), outer_ix=str(outer), inner_ix=str(inner), mint=mint, kind=kind,
             from_owner=frm, to_owner=to, amount=str(amount))
    return r


def frame(rows, cols):
    return pd.DataFrame(rows, columns=cols).astype(str) if rows else pd.DataFrame(columns=cols, dtype=str)


def universe(mig_slot=1000, create_slot=10, mint="M", pool="P", curve="BC"):
    return pd.DataFrame([dict(mint=mint, create_slot=create_slot, create_time=t_of(create_slot), bonding_curve=curve,
                              mig_slot=mig_slot, mig_time=t_of(mig_slot), pool=pool)])


def blocks(last_slot, first_slot=0):
    s = list(range(first_slot, last_slot + 1))
    return pd.DataFrame(dict(slot=[str(x) for x in s], block_time=[str(t_of(x)) for x in s]))


def tcov(rows=()):
    return frame([dict(zip(TCOV_COLS, r)) for r in rows], TCOV_COLS)


__all__ = ["curve_row", "amm_row", "t_row", "frame", "universe", "blocks", "tcov", "t_of", "DAY0",
           "AMM_COLS", "CURVE_COLS", "T_COLS", "TCOV_COLS"]
