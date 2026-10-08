"""PREREG §4 at trader level: a position is one trader, one mint, one day (OPEN_QUESTIONS Q7).

pnl    = cash + end mark - start mark (summed over the trader's owners)
basis  = start mark + SOL paid in that day (buys with their costs, plus tokens received from outside the trader at
         their mark); a transfer between two owners of the same trader is neither cash nor SOL paid in
return = pnl / basis (OPEN_QUESTIONS Q8). A position counts when it is clean and its basis is above zero.
cash uses the signer's SOL change where the signer owns every swap of a transaction (AMENDMENT_2 Q2); the
*_alt columns give the venue method for every swap, for the report."""
import numpy as np
import pandas as pd

from . import clusters
from .load import key_slot


def trader_positions(day, trader):
    """Positions of one ledger day under a cluster map (owner -> trader)."""
    r = day["rows"]
    t = clusters.assign(r["owner"].to_numpy(), trader)
    df = pd.DataFrame({"trader": t, "mint": r["mint"].to_numpy(np.int64), "cash": r["cash"].to_numpy(),
                       "paid": r["paid"].to_numpy(), "cash_alt": r["cash_alt"].to_numpy(),
                       "paid_alt": r["paid_alt"].to_numpy(), "nsig": r["nsig"].to_numpy(),
                       "dirty_start_only": r["dirty_start_only"].to_numpy(), "start_mark": r["start_mark"].to_numpy(),
                       "end_mark": r["end_mark"].to_numpy(), "end_bal": r["end_bal"].to_numpy(),
                       "start_bal": r["start_bal"].to_numpy(), "dirty": r["dirty"].to_numpy(),
                       "nbuy": r["nbuy"].to_numpy(), "nsell": r["nsell"].to_numpy(),
                       "buykey": r["buykey"].to_numpy(), "closekey": r["closekey"].to_numpy()})
    # transfers inside one trader: the receiver's SOL paid in is not new capital
    x = day["xfers"]
    adj = None
    if len(x):
        tf, tt = clusters.assign(x["frm"].to_numpy(), trader), clusters.assign(x["to"].to_numpy(), trader)
        inside = tf == tt
        if inside.any():
            adj = pd.DataFrame({"trader": tt[inside], "mint": x["mint"].to_numpy(np.int64)[inside],
                                "inner": x["value"].to_numpy()[inside]}).groupby(["trader", "mint"])["inner"].sum()
    g = df.groupby(["trader", "mint"], sort=False)
    p = g.agg(cash=("cash", "sum"), paid=("paid", "sum"), cash_alt=("cash_alt", "sum"), paid_alt=("paid_alt", "sum"),
              nsig=("nsig", "sum"), dirty_start_only=("dirty_start_only", "all"), start_mark=("start_mark", "sum"),
              end_mark=("end_mark", "sum"), end_bal=("end_bal", "sum"), start_bal=("start_bal", "sum"),
              dirty=("dirty", "any"), nbuy=("nbuy", "sum"), nsell=("nsell", "sum"), entry_key=("buykey", "min"),
              close_key=("closekey", "max"))
    if adj is not None:
        a_ = adj.reindex(p.index).fillna(0.0).to_numpy()
        p["paid"] = p["paid"] - a_
        p["paid_alt"] = p["paid_alt"] - a_
    p["pnl"] = p["cash"] + p["end_mark"] - p["start_mark"]
    p["basis"] = p["start_mark"] + p["paid"]
    p["counted"] = ~p["dirty"] & (p["basis"] > 0)
    p["ret"] = np.where(p["counted"], p["pnl"] / p["basis"].where(p["basis"] > 0, np.nan), np.nan)
    # AMENDMENT_2 Q2: the venue method alone, for the report (same positions)
    p["pnl_alt"] = p["cash_alt"] + p["end_mark"] - p["start_mark"]
    p["basis_alt"] = p["start_mark"] + p["paid_alt"]
    p["ret_alt"] = np.where(p["counted"] & (p["basis_alt"] > 0),
                            p["pnl_alt"] / p["basis_alt"].where(p["basis_alt"] > 0, np.nan), np.nan)
    p["signer_method"] = p["nsig"] > 0
    # Q14: a position left out only because its start was never seen (would count if it had been)
    p["start_only"] = p["dirty"] & p["dirty_start_only"] & (p["basis"] > 0)
    p["open_at_end"] = p["end_bal"] > 0
    p["day"] = day["day"]
    p["day_hi"] = day["hi"]
    ek = p["entry_key"].to_numpy()
    p["entry_slot"] = np.where(ek == np.iinfo(np.int64).max, -1, key_slot(np.where(ek == np.iinfo(np.int64).max, 0, ek)))
    ck = p["close_key"].to_numpy()
    p["exit_slot"] = np.where(p["open_at_end"].to_numpy() | (ck < 0), day["hi"], key_slot(np.maximum(ck, 0)))
    return p.reset_index()


def per_trader(pos):
    """Counted positions per trader: n, mean, sd, t."""
    c = pos[pos["counted"]]
    g = c.groupby("trader")["ret"]
    s = pd.DataFrame({"n": g.size(), "mean": g.mean(), "sd": g.std(ddof=1)})
    s["t"] = s["mean"] / (s["sd"] / np.sqrt(s["n"]))
    return s
