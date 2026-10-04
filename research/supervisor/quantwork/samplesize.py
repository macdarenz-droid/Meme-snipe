"""Sample-size, coverage and sequential-test simulations for the Meme-snipe quant report.
All returns are per-trade NET returns as a fraction of notional (costs already deducted).
Run: python3 samplesize.py  (seeded, deterministic)."""
import numpy as np
from scipy import stats, optimize

rng = np.random.default_rng(20261003)
Z = stats.norm.ppf


def bracket(n, pw, rng):
    """Disciplined bracket: TP +30% gross, stop -15%, gaps and rugs. ~3% round-trip cost."""
    u = rng.random(n)
    pr, pg, ps = 0.04, 0.08, None  # rug/blocked exit, gapped stop
    out = np.empty(n)
    # order: rug, gap, tp, stop, remainder time-exit
    ps = 1 - pr - pg - pw - 0.10
    c = np.cumsum([pr, pg, pw, ps])
    out[u < c[0]] = -1.0
    m = (u >= c[0]) & (u < c[1]); out[m] = rng.uniform(-0.6, -0.3, m.sum())
    m = (u >= c[1]) & (u < c[2]); out[m] = 0.30 - 0.03
    m = (u >= c[2]) & (u < c[3]); out[m] = -0.15 - 0.03
    m = u >= c[3]; out[m] = rng.normal(0, 0.08, m.sum()) - 0.03
    return out


def runner(n, scale, rng, alpha=1.8):
    """Trailing-stop runner: right fat tail (Pareto alpha), -20% stops, 4% rugs."""
    u = rng.random(n)
    out = np.full(n, -0.20 - 0.03)
    out[u < 0.04] = -1.0
    w = u >= 0.64
    out[w] = scale * (rng.pareto(alpha, w.sum()) + 1) - 0.03
    return out


def find_param(fn, target, lo, hi, **kw):
    big = np.random.default_rng(1)
    def f(p):
        return fn(400000, p, np.random.default_rng(1), **kw).mean() - target
    return optimize.brentq(f, lo, hi)


def betting_test(x, alpha=0.05, lam_max=0.5):
    """Predictable plug-in betting e-process for H0: mean <= 0, X >= -1 (Waudby-Smith & Ramdas style).
    Returns first t with wealth >= 1/alpha, or None."""
    K = 1.0; s = 0.0; s2 = 0.0
    for t, xi in enumerate(x, 1):
        if t > 1:
            mu = s / (t - 1); var = max(s2 / (t - 1) - mu * mu, 1e-4)
            lam = min(lam_max, max(0.0, mu / (var + mu * mu)))
        else:
            lam = 0.0
        K *= 1 + lam * xi
        s += xi; s2 += xi * xi
        if K >= 1 / alpha:
            return t
    return None


def main():
    print("== Per-trade distributions ==")
    rows = []
    for mu in [0.0, 0.02, 0.05, 0.10]:
        pw = find_param(bracket, mu, 0.05, 0.775)
        x = bracket(400000, pw, rng)
        rows.append(("bracket", mu, pw, x))
        print(f"bracket mu={mu:+.2f} p_TP={pw:.3f} sd={x.std():.3f} win%={np.mean(x>0):.3f} p1={np.percentile(x,1):.2f}")
    for mu in [0.0, 0.02, 0.05, 0.10]:
        sc = find_param(runner, mu, 0.01, 2.0)
        x = runner(400000, sc, rng)
        rows.append(("runner", mu, sc, x))
        print(f"runner  mu={mu:+.2f} scale={sc:.3f} sd={x.std():.3f} win%={np.mean(x>0):.3f} p99={np.percentile(x,99):.2f} max={x.max():.1f} kurt={stats.kurtosis(x):.1f}")

    print("\n== Fixed-n required: one-sided alpha=0.05, power=0.80, n=((z.95+z.80)*sd/mu)^2 ==")
    for name, mu, p, x in rows:
        if mu == 0: continue
        sd = x.std()
        n = ((Z(0.95) + Z(0.80)) * sd / mu) ** 2
        n_ci = (1.96 * sd / (mu / 2)) ** 2  # CI half-width = mu/2
        print(f"{name} mu={mu:+.2f} sd={sd:.3f} n_power80={n:,.0f}  n_for_95CI_halfwidth_mu/2={n_ci:,.0f}")

    print("\n== Coverage of nominal 95% intervals for the mean (5000 reps) ==")
    for name, mu, p, _ in rows:
        if mu != 0.05: continue
        gen = (lambda n, r: bracket(n, p, r)) if name == "bracket" else (lambda n, r: runner(n, p, r))
        for n in [30, 100, 300]:
            cov_t = 0; cov_b = 0; reps = 2000
            r = np.random.default_rng(7)
            for _ in range(reps):
                x = gen(n, r)
                m = x.mean(); se = x.std(ddof=1) / np.sqrt(n)
                tq = stats.t.ppf(0.975, n - 1)
                cov_t += (m - tq * se <= mu <= m + tq * se)
                bs = r.choice(x, (300, n)).mean(1)
                lo, hi = np.percentile(bs, [2.5, 97.5])
                cov_b += (lo <= mu <= hi)
            print(f"{name} mu=+0.05 n={n}: t-interval coverage={cov_t/reps:.3f} bootstrap-percentile coverage={cov_b/reps:.3f}")

    print("\n== Sequential betting e-process, H0: mean<=0, alpha=0.05, cap at 3000 trades (1000 reps) ==")
    for name, mu, p, _ in rows:
        gen = (lambda n, r: bracket(n, p, r)) if name == "bracket" else (lambda n, r: runner(n, p, r))
        r = np.random.default_rng(11)
        ts = []
        rej = 0; reps = 1000
        for _ in range(reps):
            x = gen(3000, r)
            if name == "runner":
                x = np.minimum(x, 3.0)  # cap winners: conservative, keeps bets bounded
            t = betting_test(x)
            if t is not None:
                rej += 1; ts.append(t)
        ts = np.array(ts) if ts else np.array([np.nan])
        print(f"{name} mu={mu:+.2f}: reject-rate={rej/reps:.3f} median_stop={np.nanmedian(ts):.0f} p90_stop={np.nanpercentile(ts,90):.0f}")
    # negative mean false-positive check
    p_neg = find_param(bracket, -0.05, 0.01, 0.775)
    r = np.random.default_rng(12); rej = 0
    for _ in range(1000):
        rej += betting_test(bracket(3000, p_neg, r)) is not None
    print(f"bracket mu=-0.05: reject-rate={rej/1000:.3f}")

    print("\n== Rule-of-three / Clopper-Pearson upper bounds for rare events (blocked exits, failed fills) ==")
    for n, k in [(30, 0), (100, 0), (100, 1), (300, 0), (300, 3), (500, 5)]:
        ub = stats.beta.ppf(0.95, k + 1, n - k) if k < n else 1
        print(f"n={n} events={k}: one-sided 95% upper bound={ub:.4f}")

    print("\n== Expected max per-trade Sharpe under the null (Bailey & Lopez de Prado 2014, Eq.1) ==")
    g = 0.5772156649
    for n in [100, 300, 1000]:
        sdsr = 1 / np.sqrt(n)
        for N in [10, 72, 500]:
            e = sdsr * ((1 - g) * Z(1 - 1 / N) + g * Z(1 - 1 / (N * np.e)))
            print(f"n_trades={n} N_trials={N}: E[max SR_hat | true SR=0] ~= {e:.3f} per trade")

    print("\n== Probabilistic Sharpe Ratio example ==")
    for name, mu, p, x in rows:
        if mu != 0.05: continue
        for n in [100, 300]:
            r = np.random.default_rng(3)
            s = x[:n] if False else (bracket(n, p, r) if name == 'bracket' else runner(n, p, r))
            sr = s.mean() / s.std(ddof=1); sk = stats.skew(s); ku = stats.kurtosis(s, fisher=False)
            psr = stats.norm.cdf((sr - 0) * np.sqrt(n - 1) / np.sqrt(1 - sk * sr + (ku - 1) / 4 * sr * sr))
            print(f"{name} mu=+0.05 n={n}: SR={sr:.3f} skew={sk:.2f} kurt={ku:.1f} PSR(SR*=0)={psr:.3f}")


if __name__ == "__main__":
    main()
