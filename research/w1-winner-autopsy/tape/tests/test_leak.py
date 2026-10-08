"""PREREG §9.1 and CLAUDE.md's blind rule: a planted future-only marker must be invisible to clusters, latency
classes, the ranking and the §8 features computed as of an earlier decision."""
import unittest

import numpy as np
import pandas as pd

import fixtures  # noqa: F401  (puts w1 on the path)
from w1 import classes, clusters, persist, rules
from w1.load import make_key

MARKER = 999_999          # an owner id that exists only in the future


def synth_day(name, n_traders=40, n_pos=25, seed=0, extra=None):
    rng = np.random.default_rng(seed)
    rows = []
    for t in range(1, n_traders + 1):
        mu = 0.02 * (t % 7 - 3)
        for m in range(n_pos):
            paid = 1e8
            rows.append({"owner": t, "mint": 1000 + m, "cash": paid * rng.normal(mu, 0.2) - paid * 0, "paid": paid,
                         "start_mark": 0.0, "end_mark": 0.0, "end_bal": 0, "start_bal": 0, "dirty": False, "nbuy": 1,
                         "nsell": 1, "buykey": make_key(10 + m, 1, 0), "closekey": make_key(20 + m, 1, 0)})
    r = pd.DataFrame(rows)
    r["cash"] = r["cash"] - r["paid"] * 0  # pnl = cash
    buys = pd.DataFrame({"owner": r["owner"], "mint": r["mint"], "slot": 10 + r["mint"] - 1000,
                         "key": r["buykey"], "jito": False, "lag": 3.0})
    d = {"day": name, "hi": 10_000, "rows": r, "xfers": pd.DataFrame(columns=["frm", "to", "mint", "value", "key"]),
         "buys": buys, "big": pd.DataFrame(columns=["owner", "mint", "slot", "key"]),
         "cg": pd.DataFrame(columns=["mint", "slot", "kind"]),
         "owners": np.arange(1, n_traders + 1, dtype=np.int64), "wedges": np.zeros((0, 2), np.int64),
         "tedges": np.zeros((0, 2), np.int64), "w_present": True, "hub_excluded_nodes": np.zeros(0, np.int64)}
    if extra:
        extra(d)
    return d


def plant(d):
    """Future-only marker: a new owner linked to every trader, a huge winner, and 1 SOL buys just before
    every buy, on the later day only."""
    n = len(d["owners"])
    d["owners"] = np.r_[d["owners"], MARKER]
    d["wedges"] = np.array([(MARKER, i) for i in range(1, 4)] + [(1, 2)], np.int64)
    extra = pd.DataFrame([{**d["rows"].iloc[0].to_dict(), "owner": MARKER, "cash": 1e15}])
    d["rows"] = pd.concat([d["rows"], extra], ignore_index=True)
    b = d["buys"]
    d["big"] = pd.DataFrame({"owner": MARKER, "mint": b["mint"], "slot": b["slot"] - 1, "key": b["key"] - 1})
    d["cg"] = pd.DataFrame({"mint": b["mint"].unique(), "slot": 9, "kind": 0})
    assert n > 0


class FutureMarker(unittest.TestCase):
    def test_ranking_day_artifacts_ignore_the_future(self):
        d1 = synth_day("2026-09-07", seed=1)
        d2_clean = synth_day("2026-09-08", seed=2)
        d2_marked = synth_day("2026-09-08", seed=2, extra=plant)
        res = []
        for d2 in (d2_clean, d2_marked):
            days = [d1, d2]
            trader, info = clusters.build(days, "2026-09-07")
            ranked, _ = persist.rank(d1, trader)
            cls = classes.classify(d1, trader)
            self.assertNotIn(MARKER, trader.index)
            self.assertNotIn(MARKER, ranked.index)
            res.append((trader, ranked, cls))
        pd.testing.assert_series_equal(res[0][0], res[1][0])
        pd.testing.assert_frame_equal(res[0][1], res[1][1])
        pd.testing.assert_frame_equal(res[0][2], res[1][2])
        # the marker does reach the later day's own artifacts, so the test can see it when it is allowed to
        trader2, _ = clusters.build([d1, d2_marked], "2026-09-08")
        self.assertIn(MARKER, trader2.index)
        self.assertGreater(classes.classify(d2_marked, trader2)["fast"].sum(), 30)
        self.assertEqual(classes.classify(d2_clean, trader2)["fast"].sum(), 0)

    def test_features_ignore_events_at_or_after_the_entry(self):
        def tape(with_marker):
            n = 50
            keys = make_key(np.arange(100, 100 + n), 1, 0)
            sw = pd.DataFrame({"key": keys, "bt": 1_789_000_000 + np.arange(n) * 20, "is_buy": np.arange(n) % 2 == 0,
                               "owner": np.arange(n) % 5, "post": 10**12, "sol": True, "overflow": False,
                               "venue": 1, "canonical": 1, "s1": 2 * 10**14 - np.arange(n) * 10**11,
                               "s2": 80 * 10**9 + np.arange(n) * 10**7, "s3": 0, "s4": 0, "bps": 30, "mint": 7})
            mv = pd.DataFrame({"key": [keys[10]], "kind": [0], "frm": [1], "to": [2], "amount": [10**11], "mint": [7]})
            if with_marker:   # at and after the entry key: a whale buy, a crash and a transfer to the creator
                k0 = keys[30]
                sw = pd.concat([sw, pd.DataFrame([{**sw.iloc[0].to_dict(), "key": k0, "bt": int(sw["bt"][30]),
                                                   "owner": MARKER, "s1": 10**10, "s2": 10**15, "is_buy": True},
                                                  {**sw.iloc[0].to_dict(), "key": k0 + 1, "bt": int(sw["bt"][30]),
                                                   "owner": MARKER, "s1": 10**16, "s2": 1, "is_buy": False}])])
                mv = pd.concat([mv, pd.DataFrame({"key": [k0, k0 + 5], "kind": [0, 0], "frm": [1, 1],
                                                  "to": [MARKER, 3], "amount": [10**14, 10**14], "mint": [7, 7]})])
            return rules.MintTape(sw, mv, create={"bt": 1_788_999_000, "creator": 3, "supply": 10**15},
                                  migr=(90, 1_788_999_500), boost_key=int(make_key(140, 1, 0)))
        entry_key, entry_bt = int(make_key(130, 1, 0)), 1_789_000_600
        out = []
        for marked in (False, True):
            t = tape(marked)
            (qi, bal), = list(t.sweep_holders([entry_key]))
            out.append(t.features(entry_key, entry_bt, 4e8, holders=(dict(bal), 10**15)))
        self.assertEqual(out[0], out[1])
        self.assertEqual(out[0]["boost_done"], 0)            # BOOST finished later: not yet known


if __name__ == "__main__":
    unittest.main()
