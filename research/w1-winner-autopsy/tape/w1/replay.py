"""PREREG §7 replay check: every top-decile test-day trade replayed at our latency and cost. An outcome stage: it reads
venue states after the trades it scores, and nothing in ranking or features calls it.

Entry: buy REPLAY_SPEND (fees included) at the venue state at the end of slot (first buy + 23). Exit: sell every token
at the state at the end of slot (exit + 23); a position the trader still held at day end exits at the day-end state
with no delay (OPEN_QUESTIONS Q16). Return = (proceeds - spend - expected fixed costs) / spend."""
import numpy as np
import pandas as pd

from . import load, venue
from .costs import FIXED_ROUND_TRIP, REPLAY_DELAY_SLOTS, REPLAY_SPEND
from .ledger import States

END_OF_SLOT = (1 << 16) - 1


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
    """trades: frame with mint, entry_slot, exit_slot, open_at_end, day_hi. Returns it with ret_replay and a reason
    for every trade that could not be replayed."""
    trades = trades.copy()
    ok = trades["entry_slot"].to_numpy() >= 0
    trades["replay_reason"] = np.where(ok, "", "no buy on the test day")
    rows = state_rows(units, vocab, set(trades.loc[ok, "mint"].astype(int)))
    st_holder = States()
    last_slot = max(u.hi for u in units)
    es = np.minimum(trades["entry_slot"].to_numpy() + REPLAY_DELAY_SLOTS, last_slot)
    xs_delay = np.minimum(trades["exit_slot"].to_numpy() + REPLAY_DELAY_SLOTS, last_slot)
    xs = np.where(trades["open_at_end"].to_numpy(bool), trades["day_hi"].to_numpy(), xs_delay)
    m = trades["mint"].to_numpy(np.int64)
    se = st_holder.asof(rows, m, load.make_key(es, END_OF_SLOT, 255))
    sx = st_holder.asof(rows, m, load.make_key(xs, END_OF_SLOT, 255))
    rets, reasons = [], []
    for i in range(len(trades)):
        if not ok[i]:
            rets.append(np.nan)
            reasons.append(trades["replay_reason"].iat[i])
            continue
        a = _tuple(se, i)
        tok, _ = venue.buy_exact_in(a, REPLAY_SPEND)
        if tok <= 0:
            rets.append(np.nan)
            reasons.append("no entry quote")
            continue
        proceeds = venue.sell(_tuple(sx, i), tok)
        rets.append((proceeds - REPLAY_SPEND - FIXED_ROUND_TRIP) / REPLAY_SPEND)
        reasons.append("")
    trades["ret_replay"] = rets
    trades["replay_reason"] = reasons
    return trades


def replay_mean(trades):
    r = trades["ret_replay"].to_numpy(np.float64)
    r = r[np.isfinite(r)]
    return float(r.mean()) if len(r) else None
