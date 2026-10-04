"""What R8's loss review sees, and a CUSUM on episode returns beside it (STRATEGY-HEALTH-OBS step 1).

Synthetic data only: these are properties of the two rules on invented return streams, not the bot's performance.

R8 as coded (packages/core/src/risk/evaluate.ts, policy.ts): a review pause when any window of the last 20 trades since
the last review (shorter prefixes included) holds 5 or more losses. It counts signs only.

The candidate: z_i is one entry decision's net return (net lamports / entry lamports fixed before the first attempt).
  S_0 = 0, S_i = max(0, S_{i-1} - z_i - KAPPA), alarm when S_i >= h.
It accumulates only when an episode loses more than KAPPA, and by how much it lost, so a few severe losses alarm while
many small losses offset by wins do not. h is chosen on the training seed and checked on an independent seed.

Streams: numpy SeedSequence(seed).spawn(12), one child stream per scenario, so adding a scenario changes no other.
Run: python3 research/risk/loss_review.py   (numpy 2.4.6, Python 3; ~1 min)
"""
import math

import numpy as np

PATHS = 20_000
TRADES = 100
WINDOW = 20      # policy.loss.reviewWindowTrades
LOSSES = 5       # policy.loss.reviewLosses
KAPPA = 0.005
TRAIN_SEED = 810
VALID_SEED = 281011
# Registered before the run (docs/DECISIONS.md, STRATEGY-HEALTH-OBS): h is the smallest grid value whose in-control
# alarm rate within 100 episodes is <= 5% for every in-control model on the training seed; on the validation seed each
# must stay <= 5% + 2 Monte Carlo standard errors.
FALSE_ALARM_TARGET = 0.05
# Amended before validation: the first grid (to 4.00) held no h meeting the target on the training seed (S2 net needs ~7).
H_GRID = [round(0.05 * k, 2) for k in range(1, 241)]  # 0.05 .. 12.00
CHANGE_AT = 50   # change scenarios: the first 50 episodes in control, the last 50 shifted

# Discrete return models (probability, net return). S2 and S3 are risk.md §1.6's marginal and positive strategies net of
# v = 3.5%; each in-control model has a positive mean.
V = 0.035


def net(dist):
    return [(p, r - V) for p, r in dist]


S2 = net([(0.05, -0.95), (0.45, -0.20), (0.32, 0.20), (0.18, 0.70)])
S3 = net([(0.04, -0.95), (0.42, -0.18), (0.32, 0.25), (0.22, 0.90)])
# A profitable strategy that loses often: 10% of entries at +100%, 90% at -5% (mean +5.5%).
FREQUENT_LOSS = [(0.10, 1.00), (0.90, -0.05)]
IN_CONTROL = {"S2 marginal (net)": S2, "S3 positive (net)": S3, "10% at +100%, 90% at -5%": FREQUENT_LOSS}


def mean_of(dist):
    return sum(p * r for p, r in dist)


def draw(rng, dist, shape):
    ps = np.array([p for p, _ in dist])
    rs = np.array([r for _, r in dist])
    return rs[rng.choice(len(dist), size=shape, p=ps / ps.sum())]


def r8_first_trip(z):
    """Index (1-based) of the first episode at which R8 would pause for review, or 0. Windows end at each episode."""
    loss = (z < 0).astype(np.int32)
    c = np.cumsum(loss, axis=1)
    lagged = np.zeros_like(c)
    lagged[:, WINDOW:] = c[:, :-WINDOW]
    tripped = (c - lagged) >= LOSSES
    first = np.argmax(tripped, axis=1) + 1
    return np.where(tripped.any(axis=1), first, 0)


def cusum_first_alarm(z, h):
    s = np.zeros(z.shape[0])
    first = np.zeros(z.shape[0], dtype=np.int64)
    for i in range(z.shape[1]):
        s = np.maximum(0.0, s - z[:, i] - KAPPA)
        hit = (s >= h) & (first == 0)
        first[hit] = i + 1
    return first


def cusum_path_max(z):
    s = np.zeros(z.shape[0])
    m = np.zeros(z.shape[0])
    for i in range(z.shape[1]):
        s = np.maximum(0.0, s - z[:, i] - KAPPA)
        m = np.maximum(m, s)
    return m


def se(p, n):
    return math.sqrt(p * (1 - p) / n)


def pct(x):
    return f"{100 * x:6.2f}%"


def streams(seed):
    return [np.random.default_rng(s) for s in np.random.SeedSequence(seed).spawn(12)]


def in_control_samples(seed):
    rngs = streams(seed)
    return {name: draw(rngs[k], dist, (PATHS, TRADES)) for k, (name, dist) in enumerate(IN_CONTROL.items())}


def stress_samples(seed):
    """Stress models, each with a positive mean unless said otherwise. Streams 3..6 of the seed."""
    rngs = streams(seed)
    out = {}
    # Clustered: S3's returns, but losses come in runs (a loss is followed by a loss with probability 0.6, drawn from
    # S3's loss outcomes; otherwise a fresh S3 draw). The mean drops slightly; it is reported.
    rng = rngs[3]
    base = draw(rng, S3, (PATHS, TRADES))
    losses = draw(rng, [(p, r) for p, r in S3 if r < 0], (PATHS, TRADES))
    u = rng.random((PATHS, TRADES))
    z = base.copy()
    for i in range(1, TRADES):
        z[:, i] = np.where((z[:, i - 1] < 0) & (u[:, i] < 0.6), losses[:, i], base[:, i])
    out["clustered losses (S3)"] = z
    # Rare -105% (a blocked exit with failed-attempt fees): 1% of S3's entries, the rest S3.
    rng = rngs[4]
    z = draw(rng, S3, (PATHS, TRADES))
    out["S3 with 1% at -105%"] = np.where(rng.random((PATHS, TRADES)) < 0.01, -1.05, z)
    # Variance shift: S3 with every return's distance from its mean doubled (same mean).
    rng = rngs[5]
    m = mean_of(S3)
    out["S3, deviations doubled"] = m + 2 * (draw(rng, S3, (PATHS, TRADES)) - m)
    return out


def change_samples(seed):
    """Episodes 1..50 from S3, 51..100 shifted. Streams 7..9."""
    rngs = streams(seed)
    out = {}
    # -2 points, additive: every return 2 points lower.
    rng = rngs[7]
    z = draw(rng, S3, (PATHS, TRADES))
    z[:, CHANGE_AT:] -= 0.02
    out["-2 points, every return lower"] = z
    # -2 points by mix: the same returns, but 2 points of mean moved by turning some +25% wins into -18% losses.
    rng = rngs[8]
    k = 0.02 / (0.25 + 0.18)
    s3_mixed = [(0.04, -0.95 - V), (0.42 + k, -0.18 - V), (0.32 - k, 0.25 - V), (0.22, 0.90 - V)]
    z = draw(rng, S3, (PATHS, TRADES))
    z[:, CHANGE_AT:] = draw(rng, s3_mixed, (PATHS, TRADES - CHANGE_AT))
    out["-2 points, more losses (same sizes)"] = z
    # -8 points, additive.
    rng = rngs[9]
    z = draw(rng, S3, (PATHS, TRADES))
    z[:, CHANGE_AT:] -= 0.08
    out["-8 points, every return lower"] = z
    return out


def binomial_table():
    print("R8 review trip, one window of 20 independent episodes: P(>= 5 losses) by win rate p")
    for p in (0.4, 0.5, 0.6, 0.7, 0.8):
        q = 1 - p
        tail = sum(math.comb(WINDOW, k) * q ** k * p ** (WINDOW - k) for k in range(LOSSES, WINDOW + 1))
        print(f"  p = {p:.1f}: {100 * tail:.2f}%")
    print()


def counterexample():
    """Two deterministic 20-episode sequences with identical signs: R8 cannot tell them apart; the CUSUM can."""
    signs = [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1]  # 4 losses: R8 never trips
    good = np.array([[0.30 if s else -0.02 for s in signs]])
    bad = np.array([[0.01 if s else -0.95 for s in signs]])
    print("Counterexample: the same signs (16 wins, 4 losses in 20), different amounts")
    for name, z in (("A  wins +30%, losses -2%", good), ("B  wins +1%,  losses -95%", bad)):
        growth = float(np.prod(1 + z))
        print(f"  {name}: mean {100 * z.mean():+.2f}%, compounded x{growth:.4f}, R8 trip at {int(r8_first_trip(z)[0])} (0 = never),"
              f" CUSUM max {float(cusum_path_max(z)[0]):.3f}")
    print("  R8 treats A and B identically (no pause for either); B loses almost everything.")
    print()


def choose_h(samples):
    maxima = {name: cusum_path_max(z) for name, z in samples.items()}
    for h in H_GRID:
        if all(float((m >= h).mean()) <= FALSE_ALARM_TARGET for m in maxima.values()):
            return h, maxima
    raise SystemExit("no h on the grid meets the target")


def main():
    binomial_table()
    counterexample()

    train = in_control_samples(TRAIN_SEED)
    h, _ = choose_h(train)
    print(f"CUSUM, kappa = {KAPPA}: h = {h} chosen on seed {TRAIN_SEED} (smallest grid value with <= {pct(FALSE_ALARM_TARGET).strip()}"
          f" alarms within {TRADES} episodes for every in-control model)")
    print()

    valid = in_control_samples(VALID_SEED)
    bound = FALSE_ALARM_TARGET + 2 * se(FALSE_ALARM_TARGET, PATHS)
    print(f"In control, validation seed {VALID_SEED}, {PATHS:,} paths x {TRADES} episodes: share of paths paused or alarmed")
    print(f"  {'model':<34} {'mean':>7} {'R8 trip':>9} {'CUSUM':>9}   (CUSUM bound {pct(bound).strip()})")
    ok = True
    for name, z in valid.items():
        r8 = float((r8_first_trip(z) > 0).mean())
        cu = float((cusum_first_alarm(z, h) > 0).mean())
        ok &= cu <= bound
        print(f"  {name:<34} {100 * mean_of(IN_CONTROL[name]):+6.2f}% {pct(r8)} {pct(cu)}")
    print(f"  validation {'holds' if ok else 'FAILS'}")
    print()

    print(f"Stress (validation seed): share of paths paused or alarmed within {TRADES} episodes")
    for name, z in stress_samples(VALID_SEED).items():
        r8 = float((r8_first_trip(z) > 0).mean())
        cu = float((cusum_first_alarm(z, h) > 0).mean())
        print(f"  {name:<34} mean {100 * float(z.mean()):+6.2f}%  R8 {pct(r8)}  CUSUM {pct(cu)}")
    print()

    print(f"Change after episode {CHANGE_AT} (S3 before; validation seed): detection after the change, and delay")
    for name, z in change_samples(VALID_SEED).items():
        for rule, first in (("R8", r8_first_trip(z)), ("CUSUM", cusum_first_alarm(z, h))):
            before = float(((first > 0) & (first <= CHANGE_AT)).mean())
            after = (first > CHANGE_AT)
            delays = first[after] - CHANGE_AT
            med = int(np.median(delays)) if delays.size else 0
            print(f"  {name:<36} {rule:<5} before {pct(before)}  after {pct(float(after.mean()))}  median delay {med}")
    print()
    print("All results are synthetic: properties of the rules on invented return models, not the bot's performance.")


if __name__ == "__main__":
    main()
