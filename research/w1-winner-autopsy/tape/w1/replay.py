"""PREREG §7 replay check: every top-decile test-day trade replayed at our latency and cost. An outcome stage: it reads
venue states after the trades it scores, and nothing in ranking or features calls it.

Entry: buy REPLAY_SPEND (fees included) at the venue state at the end of slot (first buy + 23). Exit: sell every token
at the state at the end of slot (exit + 23); a position the trader still held at day end exits at the day-end state
with no delay (OPEN_QUESTIONS Q16). Return = (proceeds - spend - expected fixed costs) / spend. AMENDMENT_3: an exit the vault
cannot pay scores what it pays (-100% for the unpaid part); a trade the tape has no state for is dropped and its share
reported."""
import numpy as np
import pandas as pd

from . import load, venue
from .costs import REPLAY_DELAY_SLOTS, REPLAY_SPEND, fixed_round_trip
from .ledger import States

END_OF_SLOT = (1 << 16) - 1
UNQUOTABLE = "entry refused by the venue (no trade)"
REFUSED_FLAG_SHARE = 0.10
FLAG = "mostly not executable at our latency"
UNPAID = "exit capped by the real vault (unpaid part -100%)"
NO_STATE = "no state on the tape (dropped)"
NO_BUY = "no buy on the test day"


def _tuple(st, i):
    k = int(st["kind"][i])
    if k == 0:
        return ("c", int(st["s1"][i]), int(st["s2"][i]), int(st["s3"][i]), int(st["s4"][i]), int(st["bps"][i]))
    if k == 1:
        return ("a", int(st["s1"][i]), int(st["s2"][i]), int(st["s3"][i]), int(st["bps"][i]))
    return None


def state_rows(units, vocab, mint_ids):
    names = {vocab.strs[m] for m in mint_ids}
    parts = [States.rows(sw) for u in units if len(sw := load.swaps(u, vocab, mints=names))]
    return pd.concat(parts, ignore_index=True) if parts else States.rows(load.swaps(units[0], vocab, mints=set()))


def replay_trades(trades, units, vocab):
    """trades: frame with mint, day, entry_slot, exit_slot, open_at_end, day_hi. Returns it with ret_replay and a reason
    for every trade that could not be replayed."""
    trades = trades.copy()
    ok = trades["entry_slot"].to_numpy() >= 0
    trades["replay_reason"] = np.where(ok, "", NO_BUY)
    rows = state_rows(units, vocab, set(trades.loc[ok, "mint"].astype(int)))
    st_holder = States()
    first_slot, last_slot = min(u.lo for u in units), max(u.hi for u in units)
    es = trades["entry_slot"].to_numpy() + REPLAY_DELAY_SLOTS
    xs = np.where(trades["open_at_end"].to_numpy(bool), trades["day_hi"].to_numpy(),   # Q16: day-end mark, no delay
                  trades["exit_slot"].to_numpy() + REPLAY_DELAY_SLOTS)
    m = trades["mint"].to_numpy(np.int64)
    se = st_holder.asof(rows, m, load.make_key(np.clip(es, 0, None), END_OF_SLOT, 255))
    sx = st_holder.asof(rows, m, load.make_key(np.clip(xs, 0, None), END_OF_SLOT, 255))
    rets, reasons = [], []
    for i in range(len(trades)):
        if not ok[i]:
            rets.append(np.nan)
            reasons.append(trades["replay_reason"].iat[i])
            continue
        a, x = _tuple(se, i), _tuple(sx, i)
        # AMENDMENT_3: a slot the tape did not read, or no venue state on the tape, is a data gap: dropped
        if not (first_slot <= es[i] <= last_slot and first_slot <= xs[i] <= last_slot) or a is None or x is None:
            rets.append(np.nan)
            reasons.append(NO_STATE)
            continue
        tok, _ = venue.buy_exact_in(a, REPLAY_SPEND)
        if tok <= 0:   # AMENDMENT_5 Q33: a refused entry is no trade (no SOL spent); counted, never scored
            rets.append(np.nan)
            reasons.append(UNQUOTABLE)
            continue
        proceeds, capped = venue.sell_detail(x, tok)
        # an exit the vault cannot (fully) pay scores what it pays: -100% for the unpaid part
        # R2-12: rent by date at the replay's entry slot (the position's day for the 09-03 band, Q-R2-b)
        rets.append((proceeds - REPLAY_SPEND - fixed_round_trip(trades["day"].iat[i], int(es[i]))) / REPLAY_SPEND)
        reasons.append(UNPAID if capped else "")
    trades["ret_replay"] = rets
    trades["replay_reason"] = reasons
    return trades


def shares(trades):
    """Shares of attempted trades: dropped for a data gap (AMENDMENT_3), scored with an unpaid exit (inside the mean),
    and refused at entry (AMENDMENT_5: no trade, outside the mean; above 10% the replay is flagged)."""
    att = trades[trades["replay_reason"] != NO_BUY]
    n = len(att)
    if n == 0:
        return {"attempted": 0}
    r = att["replay_reason"]
    refused = float((r == UNQUOTABLE).mean())
    return {"attempted": int(n), "dropped_no_state_share": float((r == NO_STATE).mean()),
            "unpaid_exit_share": float((r == UNPAID).mean()), "refused_entry_share": refused,
            "flag": FLAG if refused > REFUSED_FLAG_SHARE else None}


def replay_mean(trades):
    r = trades["ret_replay"].to_numpy(np.float64)
    r = r[np.isfinite(r)]
    return float(r.mean()) if len(r) else None
