"""AMENDMENT_6: synthetic migration (buy_v3 / PostCompleteBuyEvent) rows and the BOOST accounting row."""
import json
import math
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import test_pipeline as tp  # noqa: E402
from synth import bt  # noqa: E402
from g1lib import params as P  # noqa: E402

S = tp.S


def post_complete(mint, pool, slot, sol=5_000):
    def mark(s):
        s.E.append({"event": "PostCompleteBuyEvent", "slot": slot, "block_time": bt(slot), "tx_idx": 5, "ev_idx": 9,
                    "fields": {"mint": mint, "pool": pool, "sol_amount": str(sol)}})
    return mark


def bad_deposit(s):
    for e in s.E:
        if e["event"] == "CompletePumpAmmMigrationEvent" and e["fields"]["mint"] == "A":
            e["fields"]["sol_amount"] = "80000000000"     # the pool opens with more than a plain migrate deposit


class Amendment6(unittest.TestCase):
    build = tp.Pipeline.build

    def gate(self, marker=None):
        from g1lib import gate
        from g1lib.market import Market
        tape, d, ctx = self.build(marker=marker)
        res, grads, trig, flows = gate.run(tape, d, ctx, Market(tape), [tp.DAY], log=tp.quiet)
        return tape, res, grads

    def test_post_complete_buy_count_and_checkable(self):
        _, res, grads = self.gate(post_complete("A", "poolA", S + 300))
        row = res["G1_0"]["v3_post_complete_buy_events"]
        self.assertEqual(row["count"], 1)
        self.assertFalse(row["checkable"])                         # the decoder's pump IDL has no v3 items yet
        self.assertEqual(row["status"], "not checkable")
        a = grads[grads["mint"] == "A"].iloc[0]
        self.assertEqual(a["v3_completer_pool_part"], 5_000)
        self.assertTrue(math.isnan(grads[grads["mint"] == "C"].iloc[0]["v3_completer_pool_part"]))
        _, base, _ = self.gate()
        self.assertEqual(base["G1_0"]["v3_post_complete_buy_events"]["count"], 0)

    def test_decoder_v3_detection(self):
        from g1lib.gate import decoder_has_v3
        d = tempfile.mkdtemp(prefix="g1idl_")
        self.addCleanup(shutil.rmtree, d)
        p = os.path.join(d, "pump.json")
        json.dump({"instructions": [{"name": "buy"}], "events": [{"name": "TradeEvent"}]}, open(p, "w"))
        self.assertFalse(decoder_has_v3(p))
        json.dump({"instructions": [{"name": "buy_v3"}, {"name": "buy_exact_quote_in_v3"}],
                   "events": [{"name": "PostCompleteBuyEvent"}]}, open(p, "w"))
        self.assertTrue(decoder_has_v3(p))

    def test_opening_reserves_against_plain_deposit(self):
        _, base, _ = self.gate()
        self.assertEqual(base["G1_0"]["v3_opening_reserve_check"]["flagged"], [])
        _, bad, _ = self.gate(bad_deposit)
        self.assertEqual(bad["G1_0"]["v3_opening_reserve_check"]["flagged"], ["poolA"])

        def both(s):
            bad_deposit(s)
            post_complete("A", "poolA", S + 300)(s)
        _, expl, _ = self.gate(both)
        chk = expl["G1_0"]["v3_opening_reserve_check"]
        self.assertEqual(chk["flagged"], [])
        self.assertEqual(chk["explained_by_post_complete_buy"], ["poolA"])

    def test_catchable_share_upper_bound(self):
        _, res, _ = self.gate()
        self.assertAlmostEqual(res["G1_0"]["catchable_share_upper_bound_for_post_v3"], 2 / 4)

    def test_boost_accounting_row(self):
        tape, res, _ = self.gate()
        h = res["boost_slices"]
        ha = h[h["pool"] == "poolA"]
        self.assertEqual(list(ha["boost_vault_remaining"]), [1000, 1000])
        self.assertEqual(list(ha["virtual_quote_reserves"]), [17_584_505_288] * 2)
        pr = tape.pool_rows
        self.assertEqual(list(ha["real_quote_reserves_after"]), list(pr[pr["is_boost"]]["after_quote"]))


if __name__ == "__main__":
    unittest.main()
