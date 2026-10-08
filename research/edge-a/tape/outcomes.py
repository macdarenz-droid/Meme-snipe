"""Design A return test: outcome stage. Deliberately not implemented.

The design says a gate pass earns a return test "written and frozen here before it runs" and registers only:
entry on the first cross of 420 from below (features.cross_events), a stop under 399, placebo-level crosses as the
control, costs in SOL at $50 with the young-pool toll (about 3.5%), and membership of the k = 12 family (99.58%).
Exit rule besides the stop, horizon, exact stop level, the statistic and the sample floor are not registered
(OPEN_QUESTIONS Q9), so nothing is scored here. This module may read entry events and later prices; features.py
never imports it.
"""


def score_return_test(*_args, **_kwargs):
    raise NotImplementedError(
        "Design A's return test is not frozen: exit rule, horizon, stop level, statistic and sample floor are "
        "unregistered (OPEN_QUESTIONS Q9). It runs only after both gates pass and the test is frozen.")
