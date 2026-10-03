"""Risk-of-ruin Monte Carlo for the §8 policy (docs/ARCHITECTURE.md), re-run by RISK-1 with R6 to R10 as coded.

Same assumptions as docs/research/risk.md §1.6: 20,000 paths, up to 100 trades, at most 3 entries per Melbourne day,
$20 start, the S1 to S3 return distributions, v = 3.5% and F = $0.03 on every trade. Added here, as the policy does:
  R6  enter only if q + C <= E - 0.7 * HWM and L_week + q + C <= 0.20 * E_week_start
  R7  enter only while L_day + C < 0.075 * B (B = $20)
  R8  2 losses in a row: skip the next slot (2 h cooldown); 3: rest of the day; 5 in any 20: the path stops (review)
  R9  20% of week-start equity lost: rest of the week off (the review is assumed to pass at the week's end)
  R10 E <= 0.7 * HWM: the path stops (kill switch)
C = $0.80, the worst-case costs of one trial trade (fees, token-account rent, the exit ladder and EXIT-1 blocked-exit retries at the fee cap; RISK-1 fixture, $0.794 rounded up).
A path ends after 100 trades or 120 days. A second table lets every R8 review pass at once. Seeded: the same numbers on every run.

Run: python3 research/risk/montecarlo.py
"""
import random
import statistics

PATHS = 20_000
TRADES = 100
DAYS = 120
START = 20.0
V = 0.035
F = 0.03
C = 0.80
B = 20.0

DISTRIBUTIONS = {
    "S1 negative": [(0.08, -0.95), (0.50, -0.22), (0.27, 0.15), (0.15, 0.60)],
    "S2 marginal": [(0.05, -0.95), (0.45, -0.20), (0.32, 0.20), (0.18, 0.70)],
    "S3 positive": [(0.04, -0.95), (0.42, -0.18), (0.32, 0.25), (0.22, 0.90)],
}


def draw(rng, dist):
    u = rng.random()
    acc = 0.0
    for p, r in dist:
        acc += p
        if u < acc:
            return r
    return dist[-1][1]


def run(dist, q, limits, seed, review_stops=True):
    rng = random.Random(seed)
    finals, killed, reviewed, taken = [], 0, 0, []
    for _ in range(PATHS):
        e = hwm = START
        n = 0
        reviewed_here = False
        results = []
        stopped = None
        week_start = e
        for day in range(DAYS):
            if n >= TRADES or stopped:
                break
            if day % 7 == 0:
                week_start = e
            day_start = e
            week_off = limits and (week_start - e) >= 0.20 * week_start
            slots = 3
            skip = 0
            while slots > 0 and n < TRADES and not week_off:
                slots -= 1
                if skip:
                    skip -= 1
                    continue
                if limits:
                    l_day = max(0.0, day_start - e)
                    l_week = max(0.0, week_start - e)
                    if l_day + C >= 0.075 * B:
                        break
                    if q + C > e - 0.7 * hwm or l_week + q + C > 0.20 * week_start:
                        break
                pnl = q * draw(rng, dist) - q * V - F
                e += pnl
                hwm = max(hwm, e)
                n += 1
                results.append(pnl < 0)
                if e <= 0:
                    stopped = "ruin"
                    break
                if not limits:
                    continue
                if e <= 0.7 * hwm:
                    stopped = "kill"
                    break
                if sum(results[-20:]) >= 5:
                    if review_stops:
                        stopped = "review"
                        break
                    reviewed_here = True
                    results = []  # the owner reviews at once and only later trades count toward the next review
                    break
                streak = 0
                for loss in reversed(results):
                    if not loss:
                        break
                    streak += 1
                if streak >= 3:
                    break
                if streak == 2:
                    skip = 1
                if (week_start - e) >= 0.20 * week_start:
                    week_off = True
        finals.append(e)
        taken.append(n)
        killed += stopped == "kill"
        reviewed += stopped == "review" or reviewed_here
    return {
        "p_le_10": sum(f <= 10 for f in finals) / PATHS,
        "median": statistics.median(finals),
        "killed": killed / PATHS,
        "review": reviewed / PATHS,
        "trades": statistics.mean(taken),
    }


if __name__ == "__main__":
    print("Review stops the path (pause until reviewed, never resumed here):")
    print("| Scenario | q | No limits: P(B <= $10) | Median final | §8 limits: P(B <= $10) | Median final | Killed | Stopped for review | Mean trades taken |")
    print("|---|---|---|---|---|---|---|---|---|")
    for i, (name, dist) in enumerate(DISTRIBUTIONS.items()):
        for q in (2.0, 5.0):
            a = run(dist, q, False, 1000 + i * 10 + int(q))
            b = run(dist, q, True, 1000 + i * 10 + int(q))
            print(f"| {name} | ${q:.0f} | {a['p_le_10']:.2%} | ${a['median']:.2f} | {b['p_le_10']:.2%} | ${b['median']:.2f} | "
                  f"{b['killed']:.0%} | {b['review']:.0%} | {b['trades']:.0f} |")

    print()
    print("Each review passes at once and trading resumes the next day:")
    print("| Scenario | q | P(B <= $10) | Median final | Killed | Paths with a review | Mean trades taken |")
    print("|---|---|---|---|---|---|---|")
    for i, (name, dist) in enumerate(DISTRIBUTIONS.items()):
        q = 2.0
        b = run(dist, q, True, 1000 + i * 10 + int(q), review_stops=False)
        print(f"| {name} | ${q:.0f} | {b['p_le_10']:.2%} | ${b['median']:.2f} | {b['killed']:.1%} | {b['review']:.0%} | {b['trades']:.0f} |")
