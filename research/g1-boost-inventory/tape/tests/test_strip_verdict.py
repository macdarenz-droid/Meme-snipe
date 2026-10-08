import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import g1  # noqa: E402


class StripVerdict(unittest.TestCase):
    def test_partial_gate_has_no_verdict(self):
        res = {"a_g1_0_passes": True, "b_pass": True, "c_pass": False, "passes": True, "n": 5}
        out = g1.strip_verdict(res)
        self.assertIsNone(out["passes"])
        self.assertIsNone(out["a_g1_0_passes"])
        self.assertIsNone(out["b_pass"])
        self.assertEqual(out["n"], 5)
        self.assertTrue(out["verdict"].startswith("none"))


if __name__ == "__main__":
    unittest.main()
