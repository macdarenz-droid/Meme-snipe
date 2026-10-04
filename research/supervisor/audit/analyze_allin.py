#!/usr/bin/env python3
"""Backfill analysis: base rates, signals, naive rule grid for pump.fun graduations.
Inputs (all in this directory):
  backfill/migrations.jsonl   one line per MigrateV2 tx (from backfill_migrations.mjs)
  backfill/ohlcv_1m/*.json    GeckoTerminal 1m candles, SOL-denominated, mig..mig+300min
  backfill/meta.json          Jupiter + DexScreener state at collection time (fetch_meta.mjs)
Outputs: results/backfill_tokens.csv, results/backfill_results.json (printed summary too).
Pure python (no numpy). Deterministic bootstrap (seed 7).
"""
import json, os, glob, math, random, statistics as st, csv, sys
from datetime import datetime, timezone

D = '/tmp/claude-0/-home-user-Meme-snipe/bfe97b8d-9361-5e1a-a5d2-7a95e7d0e23b/scratchpad/research/empirical-data'
OUTD='/tmp/claude-0/-home-user-Meme-snipe/bfe97b8d-9361-5e1a-a5d2-7a95e7d0e23b/scratchpad/audit'
random.seed(7)
B = 1000  # bootstrap resamples


def iso(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() if s else None


def boot_ci(xs, fn=st.mean, b=B):
    if len(xs) < 5:
        return (None, None)
    n = len(xs); v = []
    for _ in range(b):
        v.append(fn([xs[random.randrange(n)] for _ in range(n)]))
    v.sort()
    return (v[int(0.025 * b)], v[int(0.975 * b) - 1])


def boot_diff(a, b_, fn=st.median, b=B):
    if len(a) < 5 or len(b_) < 5:
        return (None, None)
    v = []
    for _ in range(b):
        ra = [a[random.randrange(len(a))] for _ in a]
        rb = [b_[random.randrange(len(b_))] for _ in b_]
        v.append(fn(ra) - fn(rb))
    v.sort()
    return (v[int(0.025 * b)], v[int(0.975 * b) - 1])


def q(xs, p):
    if not xs:
        return None
    s = sorted(xs); k = (len(s) - 1) * p; f = math.floor(k); c = math.ceil(k)
    return s[f] if f == c else s[f] + (s[c] - s[f]) * (k - f)


# ---------------- load universe ----------------
def load_universe(migf):
    rows = [json.loads(l) for l in open(migf) if l.strip()]
    stats = {'tx_ok_fetched': len(rows), 'tx_migrate': sum(r.get('kind') == 'migrate' for r in rows),
             'tx_fetch_failed': sum(r.get('kind') == 'fetch_failed' for r in rows)}
    by = {}
    for r in rows:
        if not r.get('mint') or not r.get('pool'):
            continue
        if r['mint'] not in by or by[r['mint']]['blockTime'] > r['blockTime']:
            by[r['mint']] = r
    stats['unique_mints'] = len(by)
    return by, stats


def load_candles(path):
    d = json.load(open(path))
    resp = d['resp']
    if not isinstance(resp, dict) or 'data' not in resp:
        return d, None
    L = resp['data']['attributes']['ohlcv_list']
    # list is newest first; merge duplicate timestamps (GT quirk)
    m = {}
    for c in reversed(L):  # oldest first
        t, o, h, l, cl, v = c
        if t in m:
            x = m[t]; x[2] = max(x[2], h); x[3] = min(x[3], l); x[4] = cl; x[5] += v
        else:
            m[t] = [t, o, h, l, cl, v]
    return d, sorted(m.values())


# ---------------- cost model ----------------
SCEN = {
    # fee_side: venue fee per side. Verified on-chain 2026-10-03 (fees_observed.json): LP 20 + protocol 5 + creator 95 bps = 1.20%/side
    # on a PumpSwap pool at ~$0.3-0.5M mcap. Base uses 1.25%; 'low' uses 0.30% (if the creator tier were 5 bps).
    # slip_side: adverse fill / MEV allowance per side; fixed_sol: network fees for buy+sell incl. 25% retry allowance
    'low': dict(fee_side=0.0030, slip_side=0.0, jup_side=0.0, fixed_sol=0.00011, rent_sol=0.0),
    'base': dict(fee_side=0.0125, slip_side=0.005, jup_side=0.0, fixed_sol=0.00026, rent_sol=0.0),
    'conservative': dict(fee_side=0.0125, slip_side=0.015, jup_side=0.005, fixed_sol=0.00026, rent_sol=0.0),
    'base_rent_lost': dict(fee_side=0.0125, slip_side=0.005, jup_side=0.0, fixed_sol=0.00026, rent_sol=0.00207),
}


def net_return(gross_mult, q_sol, r_entry, r_exit, sc):
    """gross_mult = P_exit/P_entry (pool mid prices). r_* = pool SOL reserve at entry/exit (for impact)."""
    imp_in = q_sol / (r_entry + q_sol) if r_entry else 0.0
    imp_out = q_sol / (r_exit + q_sol) if r_exit else 0.0
    side_in = sc['fee_side'] + sc['slip_side'] + sc['jup_side'] + imp_in
    side_out = sc['fee_side'] + sc['slip_side'] + sc['jup_side'] + imp_out
    proceeds = q_sol * (1 - side_in) * gross_mult * (1 - side_out)
    return (proceeds - sc['fixed_sol'] - sc['rent_sol']) / q_sol - 1


# ---------------- per-token features/outcomes ----------------
H = {'5m': 300, '15m': 900, '1h': 3600, '4h': 14400}


def price_at(c, t):
    """pool price at time t = close of last candle fully ended by t (None if no candle yet)."""
    p = None
    for x in c:
        if x[0] + 60 <= t:
            p = x[4]
        else:
            break
    return p


def simulate(c, t_entry, p_entry, stop, tp, tmax, tp_mode='close'):
    """walk 1m candles starting at t_entry; stop/tp as fractions (e.g. -0.3, 0.5) or None.
    Conservative: if stop and tp in same bar -> stop. Gap through stop -> exit at bar open.
    Returns (gross multiple, exit_time, reason)."""
    last = p_entry; t_end = t_entry + tmax
    for x in c:
        if x[0] < t_entry:
            continue
        if x[0] >= t_end:
            break
        t, o, h, l, cl, v = x
        if stop is not None:
            sp = p_entry * (1 + stop)
            if o <= sp:
                return o / p_entry, t, 'stop_gap'
            if l <= sp:  # wick touches stop: fill at stop, or at the bar close if the bar closes below it (1-min polling bot)
                return (min(sp, cl) if tp_mode == 'close' else sp) / p_entry, t, 'stop'
        if tp is not None:
            tpp = p_entry * (1 + tp)
            if tp_mode == 'wick' and h >= tpp:  # optimistic: fill at TP whenever the bar's high touches it
                return (max(o, tpp) if o >= tpp else tpp) / p_entry, t, 'tp'
            if tp_mode == 'close' and cl >= tpp:  # conservative: TP counts only if the bar CLOSES above it; fill capped at TP
                return tpp / p_entry, t, 'tp'
        last = cl
    return last / p_entry, t_end, 'time'


def token_record(mig, cand_d, c, meta, sol_usd):
    t0 = mig['blockTime']; pm = mig.get('migPriceSol'); r0 = mig.get('sol')
    rec = {'mint': mig['mint'], 'pool': mig['pool'], 't0': t0, 'mig_price_sol': pm, 'mig_sol_reserve': r0,
           'has_candles': bool(c)}
    j = meta.get('jup', {}).get(mig['mint'], {}) if meta else {}
    dx = meta.get('dex', {}).get(mig['mint'], []) if meta else []
    created = iso(j.get('createdAt')) if j else None
    rec['ttg_s'] = (t0 - created) if created else None
    rec['socials'] = int(bool(j.get('twitter') or j.get('website') or j.get('telegram'))) if j else None
    rec['twitter'] = int(bool(j.get('twitter'))) if j else None
    rec['dev_mints'] = (j.get('audit') or {}).get('devMints') if j else None
    rec['mayhem_like_suffix'] = int(not mig['mint'].endswith('pump'))
    # state at collection (outcome side)
    now_usd = j.get('usdPrice') if j else None
    rec['now_price_sol'] = (now_usd / sol_usd) if (now_usd and sol_usd) else None
    rec['now_liq_usd'] = j.get('liquidity') if j else None
    rec['collect_lag_h'] = ((meta['fetchedAt'] / 1000) - t0) / 3600 if meta else None
    rec['dex_boosted'] = int(any((p.get('boosts') or {}).get('active') for p in dx)) if dx else 0
    rec['dex_profile'] = int(any(p.get('info') for p in dx)) if dx else 0
    rec['mig_liq_usd'] = 2 * r0 * sol_usd if (r0 and sol_usd) else None
    if not c:
        return rec
    # reference price = pool price at migration from on-chain reserves (GT first-candle opens are sometimes anomalous)
    p0 = pm if pm else c[0][1]
    rec['p0'] = p0
    rec['p0_vs_mig'] = c[0][1] / pm - 1 if pm else None
    rec['first_close_vs_mig'] = c[0][4] / pm - 1 if pm else None
    rec['consistent'] = 1
    # AMM physics check: with constant product, price can rise at most by ((R0 + cumulative SOL volume)/R0)^2.
    # Candles whose high exceeds 1.5x that bound are data errors (GT mis-parsed trades) -> token flagged inconsistent.
    if pm and r0:
        cum = 0.0
        for x in c:
            cum += x[5]
            if x[2] > 1.5 * pm * ((r0 + cum) / r0) ** 2:
                rec['physics_violation'] = 1; break
        # Second check: a cluster of pools shows a first-minute jump to ~1.45e-3 SOL with thousands of SOL of reported
        # volume and a steady ~7 SOL/min afterwards, while Jupiter's current price sits at the normal dump floor.
        # We treat any candle high > 50x the migration price as a data error and exclude the token (counted in report).
        if max(x[2] for x in c) > 50 * pm:
            rec['spike_50x'] = 1
    rec['_needs_now_check'] = 1
    rec['n_candles'] = len(c)
    rec['last_trade_age_min'] = (c[-1][0] - t0) / 60
    for k, s in H.items():
        p = price_at(c, t0 + s)
        rec['ret_' + k] = (p / p0 - 1) if p else 0.0  # no full candle yet means no trade -> unchanged
    for k, s in [('1h', 3600), ('4h', 14400)]:
        w = [x for x in c if x[0] < t0 + s]
        rec['mfe_' + k] = max(x[2] for x in w) / p0 - 1
        rec['mae_' + k] = min(x[3] for x in w) / p0 - 1
        rec['min_after1m_' + k] = min([x[3] for x in w if x[0] >= c[0][0] + 60] or [w[-1][4]]) / p0 - 1
    rec['ret_now'] = (rec['now_price_sol'] / p0 - 1) if rec['now_price_sol'] else None
    rec.pop('_needs_now_check', None)
    if rec.get('spike_50x') and not (rec['now_price_sol'] and rec['now_price_sol'] > 2 * p0):
        # >50x spike in GT candles that did not persist to collection time (Jupiter price back at the dump floor):
        # either a GT parsing error or a whale self-pump; excluded from the main set, included in the sensitivity run.
        rec['implausible_50x'] = 1
        if not os.environ.get('INCLUDE_FLAGGED'):
            rec['consistent'] = 0
    # decision-time features at D = mig+5m aligned to next minute
    Dt = math.ceil((t0 + 300) / 60) * 60
    early = [x for x in c if x[0] < Dt]
    rec['early_vol_sol'] = sum(x[5] for x in early)
    rec['early_active_min'] = len(early)
    pe = price_at(c, Dt) or p0
    rec['early_mom'] = pe / p0 - 1
    rec['early_vs_mig'] = pe / pm - 1 if pm else None
    rec['early_high_vs_p0'] = max(x[2] for x in early) / p0 - 1 if early else 0
    rec['early_drawdown_from_high'] = pe / max(x[2] for x in early) - 1 if early else 0
    return rec


def rule_trades(recs, cands, X, filt, stop, tp, tmax, sc, q_sol, tp_mode='close'):
    out = []
    for r in recs:
        c = cands.get(r['pool'])
        if not c:
            continue
        t0 = r['t0']; Dt = math.ceil((t0 + X) / 60) * 60
        pe = price_at(c, Dt)
        if pe is None:
            continue
        if filt and not filt(r, c, Dt, pe):
            continue
        g, te, why = simulate(c, Dt, pe, stop, tp, tmax, tp_mode)
        pm = r['mig_price_sol']; r0 = r['mig_sol_reserve']
        rin = r0 * math.sqrt(pe / pm) if (pm and r0) else None
        rout = r0 * math.sqrt(pe * g / pm) if (pm and r0) else None
        out.append({'mint': r['mint'], 't0': t0, 'gross': g - 1, 'net': net_return(g, q_sol, rin, rout, sc), 'why': why})
    return out


def summ(tr, hours):
    if not tr:
        return {'n': 0}
    nets = [t['net'] for t in tr]
    wins = [x for x in nets if x > 0]; losses = [x for x in nets if x <= 0]
    lo, hi = boot_ci(nets)
    return {'n': len(nets), 'mean_net': st.mean(nets), 'ci95': [lo, hi], 'median_net': st.median(nets),
            'mean_gross': st.mean(t['gross'] for t in tr), 'win_rate': len(wins) / len(nets),
            'avg_win': st.mean(wins) if wins else None, 'avg_loss': st.mean(losses) if losses else None,
            'worst': min(nets), 'best': max(nets), 'per_day': len(nets) / hours * 24,
            'sd_net': st.pstdev(nets), 'n_needed_ci_excl0_if_true_mean_5pct': math.ceil((1.96 * st.pstdev(nets) / 0.05) ** 2),
            'exit_mix': {k: sum(t['why'] == k for t in tr) for k in ('stop', 'stop_gap', 'tp', 'time')}}


def main():
    migf = os.path.join(D, 'backfill/migrations.jsonl')
    by, ustats = load_universe(migf)
    meta = json.load(open(os.path.join(D, 'backfill/meta.json'))) if os.path.exists(os.path.join(D, 'backfill/meta.json')) else {}
    sol_usd = meta.get('solUsd') or 119.3
    cands = {}; fetched = 0; errs = 0; empty = 0
    for f in glob.glob(os.path.join(D, 'backfill/ohlcv_1m/*.json')):
        d, c = load_candles(f); fetched += 1
        if c is None:
            errs += 1; continue
        if not c:
            empty += 1
        cands[d['pool']] = c
    # analysis universe = migrations whose candle fetch was attempted (contiguous newest-first subset of the window)
    pools_done = {os.path.basename(f)[:-5] for f in glob.glob(os.path.join(D, 'backfill/ohlcv_1m/*.json'))}
    U = [m for m in by.values() if m['pool'] in pools_done]
    U.sort(key=lambda m: m['blockTime'])
    recs = [token_record(m, None, cands.get(m['pool']), meta, sol_usd) for m in U]
    t_lo = min(m['blockTime'] for m in U); t_hi = max(m['blockTime'] for m in U)
    hours = (t_hi - t_lo) / 3600
    res = {'universe': ustats, 'analysis_n': len(recs), 'window_utc': [datetime.fromtimestamp(t_lo, timezone.utc).isoformat(), datetime.fromtimestamp(t_hi, timezone.utc).isoformat()],
           'window_hours': hours, 'migrations_per_hour': len(recs) / hours if hours else None,
           'ohlcv_fetched': fetched, 'ohlcv_errors': errs, 'ohlcv_empty': empty, 'sol_usd': sol_usd}
    for r in recs:
        r['cls'] = 'standard' if (r['mig_sol_reserve'] or 0) >= 50 else ('dust' if (r['mig_sol_reserve'] or 0) < 5 else 'mid')
    res['class_counts'] = {k: sum(r['cls'] == k for r in recs) for k in ('standard', 'dust', 'mid')}
    res['n_no_candles_by_class'] = {k: sum(r['cls'] == k and not r['has_candles'] for r in recs) for k in ('standard', 'dust', 'mid')}
    res['n_inconsistent_price_standard'] = sum(r['cls'] == 'standard' and r['has_candles'] and not r.get('consistent') for r in recs)
    dust = [r for r in recs if r['cls'] == 'dust']
    res['dust_class'] = {'n': len(dust), 'median_mig_sol_reserve': q([r['mig_sol_reserve'] for r in dust], .5),
                         'median_ret_1h': q([r['ret_1h'] for r in dust if r.get('ret_1h') is not None], .5)}
    # analysis set: standard graduations (>=50 SOL in pool at migration) with candles and consistent prices.
    # Standard graduations with NO candles (no trades at all) are kept in base rates as unchanged-price/no-exit cases.
    with_c = [r for r in recs if r['cls'] == 'standard' and r['has_candles'] and r.get('consistent')]
    res['n_with_candles'] = len(with_c)
    # ---- Q1 base rates ----
    dist = {}
    for k in ['5m', '15m', '1h', '4h', 'now']:
        xs = [r['ret_' + k] for r in with_c if r.get('ret_' + k) is not None]
        dist[k] = {'n': len(xs), 'p10': q(xs, .1), 'p25': q(xs, .25), 'median': q(xs, .5), 'median_ci': boot_ci(xs, st.median), 'p75': q(xs, .75), 'p90': q(xs, .9),
                   'mean': st.mean(xs) if xs else None, 'share_up': sum(x > 0 for x in xs) / len(xs) if xs else None,
                   'share_le_-80': sum(x <= -0.8 for x in xs) / len(xs) if xs else None,
                   'share_ge_+100': sum(x >= 1 for x in xs) / len(xs) if xs else None}
    res['returns_from_p0'] = dist
    ex = {}
    for k in ['mfe_1h', 'mae_1h', 'mfe_4h', 'mae_4h', 'min_after1m_1h', 'p0_vs_mig', 'early_mom']:
        xs = [r[k] for r in with_c if r.get(k) is not None]
        ex[k] = {'n': len(xs), 'p10': q(xs, .1), 'p25': q(xs, .25), 'median': q(xs, .5), 'p75': q(xs, .75), 'p90': q(xs, .9)}
    res['excursions'] = ex
    res['rug_like'] = {
        'close_1h_le_-80': sum(r['ret_1h'] <= -0.8 for r in with_c) / len(with_c),
        'any_low_1h_le_-80': sum(r['mae_1h'] <= -0.8 for r in with_c) / len(with_c),
        'close_4h_le_-80': sum(r['ret_4h'] <= -0.8 for r in with_c) / len(with_c),
        'now_le_-80': (lambda xs: sum(x <= -0.8 for x in xs) / len(xs) if xs else None)([r['ret_now'] for r in with_c if r.get('ret_now') is not None]),
        'n': len(with_c)}
    stdr = [r for r in recs if r['cls'] == 'standard']
    lr = [r['now_liq_usd'] / r['mig_liq_usd'] for r in stdr if r.get('now_liq_usd') and r.get('mig_liq_usd')]
    res['liquidity'] = {'scope': 'standard graduations', 'n': len(lr), 'mig_liq_usd_median': q([r['mig_liq_usd'] for r in stdr if r.get('mig_liq_usd')], .5),
                        'now_liq_usd_median': q([r['now_liq_usd'] for r in stdr if r.get('now_liq_usd')], .5),
                        'now_liq_usd_p90': q([r['now_liq_usd'] for r in stdr if r.get('now_liq_usd')], .9),
                        'share_now_liq_gt_10k': sum((r.get('now_liq_usd') or 0) > 10000 for r in stdr) / len(stdr) if stdr else None,
                        'ratio_now_over_mig': {'p10': q(lr, .1), 'p25': q(lr, .25), 'median': q(lr, .5), 'p75': q(lr, .75), 'p90': q(lr, .9)},
                        'share_ratio_lt_0.1': sum(x < 0.1 for x in lr) / len(lr) if lr else None,
                        'collect_lag_h_range': [q([r['collect_lag_h'] for r in recs if r.get('collect_lag_h')], 0), q([r['collect_lag_h'] for r in recs if r.get('collect_lag_h')], 1)]}
    # ---- Q2 signals: outcome = gross return from entry at D (mig+5m) to D+60m (price), and rug flag ----
    def outcome(r):
        c = cands.get(r['pool'])
        if not c:
            return None
        Dt = math.ceil((r['t0'] + 300) / 60) * 60
        pe = price_at(c, Dt)
        p1 = price_at(c, Dt + 3600) or pe
        return p1 / pe - 1 if pe else None
    for r in with_c:
        r['out_D_1h'] = outcome(r)
        c = cands[r['pool']]; Dt = math.ceil((r['t0'] + 300) / 60) * 60; pe = price_at(c, Dt)
        r['out_D_4h'] = (price_at(c, Dt + 14400) or pe) / pe - 1 if pe else None
        r['out_D_now'] = (r['now_price_sol'] / pe - 1) if (pe and r.get('now_price_sol')) else None
    sigdefs = {
        'early_mom>0 (price at mig+5m above first trade)': lambda r: r['early_mom'] > 0,
        'early_vol_sol >= median': None,  # filled below (median split)
        'early_active_min == 5 (trades every minute)': lambda r: r['early_active_min'] >= 5,
        'early_drawdown_from_high > -30%': lambda r: r['early_drawdown_from_high'] > -0.3,
        'socials present (metadata)': lambda r: r.get('socials') == 1,
        'twitter present (metadata)': lambda r: r.get('twitter') == 1,
        'ttg > 30 min (slow graduation)': lambda r: r.get('ttg_s') is not None and r['ttg_s'] > 1800,
        'ttg < 5 min (fast/bundled graduation)': lambda r: r.get('ttg_s') is not None and r['ttg_s'] < 300,
        'dev_mints == 1 (first launch)': lambda r: r.get('dev_mints') == 1,
        'dexscreener profile (LOOK-AHEAD: current)': lambda r: r.get('dex_profile') == 1,
        'dexscreener boost active (LOOK-AHEAD: current)': lambda r: r.get('dex_boosted') == 1,
    }
    vmed = q([r['early_vol_sol'] for r in with_c], .5)
    sigdefs['early_vol_sol >= median'] = lambda r: r['early_vol_sol'] >= vmed
    sigs = {}
    for name, fn in sigdefs.items():
        A = [r for r in with_c if r['out_D_1h'] is not None and fn(r)]
        Bn = [r for r in with_c if r['out_D_1h'] is not None and not fn(r)]
        a = [r['out_D_1h'] for r in A]; b = [r['out_D_1h'] for r in Bn]
        a4 = [r['out_D_4h'] for r in A]; b4 = [r['out_D_4h'] for r in Bn]
        rugA = [r['out_D_now'] <= -0.8 for r in A if r.get('out_D_now') is not None]
        rugB = [r['out_D_now'] <= -0.8 for r in Bn if r.get('out_D_now') is not None]
        base_net = [net_return(1 + x, 2 / sol_usd, None, None, SCEN['base']) for x in a]
        sigs[name] = {'n_yes': len(a), 'n_no': len(b),
                      'median_1h_yes': q(a, .5), 'median_1h_no': q(b, .5), 'diff_median_1h_ci': boot_diff(a, b) if a and b else None,
                      'mean_1h_yes': st.mean(a) if a else None, 'mean_1h_no': st.mean(b) if b else None, 'diff_mean_1h_ci': boot_diff(a, b, st.mean) if a and b else None,
                      'median_4h_yes': q(a4, .5), 'median_4h_no': q(b4, .5),
                      'rug_now_yes': sum(rugA) / len(rugA) if rugA else None, 'rug_now_no': sum(rugB) / len(rugB) if rugB else None,
                      'yes_mean_net_base_hold1h': st.mean(base_net) if base_net else None, 'yes_mean_net_base_ci': boot_ci(base_net)}
    res['signals'] = sigs
    # ---- Q3 rule grid ----
    filters = {'none': None,
               'mom>0': lambda r, c, Dt, pe: pe > r['p0'],  # price at entry above migration pool price
               # threshold = sample median of the same quantity at that entry time (in-sample threshold; noted in report)
               'vol>=median': lambda r, c, Dt, pe: sum(x[5] for x in c if x[0] < Dt) >= vmed_by_X[min((60, 300, 900, 3600), key=lambda X: abs(Dt - r['t0'] - X))],
               'socials': lambda r, c, Dt, pe: r.get('socials') == 1,
               # not an instant/bundled graduation: >= 5 min between token creation (Jupiter createdAt) and migration
               'ttg>=5m': lambda r, c, Dt, pe: r.get('ttg_s') is not None and r['ttg_s'] >= 300,
               'ttg>=5m & socials': lambda r, c, Dt, pe: r.get('ttg_s') is not None and r['ttg_s'] >= 300 and r.get('socials') == 1}
    vmed_by_X = {}
    for X in (60, 300, 900, 3600):
        vs = []
        for r in with_c:
            Dt = math.ceil((r['t0'] + X) / 60) * 60
            vs.append(sum(x[5] for x in cands[r['pool']] if x[0] < Dt))
        vmed_by_X[X] = q(vs, .5)
    res['early_vol_median_by_entry'] = vmed_by_X
    exits = {'S-30/TP+50/60m': (-0.3, 0.5, 3600), 'S-20/TP+100/240m': (-0.2, 1.0, 14400), 'time-only 60m': (None, None, 3600)}
    q_sol = 2 / sol_usd
    grid = []
    for X in (60, 300, 900, 3600):
        for fn_name, fn in filters.items():
            for ex_name, (s, tpv, tm) in exits.items():
                tr = rule_trades(with_c, cands, X, fn, s, tpv, tm, SCEN['base'], q_sol)
                row = {'entry': f'mig+{X // 60}m', 'filter': fn_name, 'exit': ex_name, **summ(tr, hours)}
                trw = rule_trades(with_c, cands, X, fn, s, tpv, tm, SCEN['base'], q_sol, 'wick')
                row['mean_net_base_wickTP'] = st.mean(t['net'] for t in trw) if trw else None
                for scn in ('low', 'conservative', 'base_rent_lost'):
                    tr2 = rule_trades(with_c, cands, X, fn, s, tpv, tm, SCEN[scn], q_sol)
                    row['mean_net_' + scn] = st.mean(t['net'] for t in tr2) if tr2 else None
                # chronological split stability (first half vs second half of window)
                if tr:
                    mid = (t_lo + t_hi) / 2
                    h1 = [t['net'] for t in tr if t['t0'] < mid]; h2 = [t['net'] for t in tr if t['t0'] >= mid]
                    row['mean_net_first_half'] = st.mean(h1) if h1 else None
                    row['mean_net_second_half'] = st.mean(h2) if h2 else None
                grid.append(row)
    res['rule_grid'] = grid
    res['rule_grid_variants'] = len(grid)
    os.makedirs(os.path.join(OUTD, 'results'), exist_ok=True)
    suffix = '_incl_flagged' if os.environ.get('INCLUDE_FLAGGED') else ''
    json.dump(res, open(os.path.join(OUTD, f'results/backfill_results{suffix}.json'), 'w'), indent=1, default=str)
    keys = sorted({k for r in recs for k in r})
    with open(os.path.join(OUTD, f'results/backfill_tokens{suffix}.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); [w.writerow(r) for r in recs]
    print(json.dumps({k: v for k, v in res.items() if k not in ('rule_grid', 'signals')}, indent=1, default=str))
    for name, s in sigs.items():
        print(name, json.dumps(s, default=lambda x: round(x, 4) if isinstance(x, float) else str(x)))
    for g in sorted(grid, key=lambda g: -(g.get('mean_net') or -9)):
        print(g['entry'], g['filter'], g['exit'], 'n', g['n'], 'mean', round(g.get('mean_net') or 0, 4), 'ci', [round(x, 4) if x else x for x in g.get('ci95', [])],
              'med', round(g.get('median_net') or 0, 4), 'win', round(g.get('win_rate') or 0, 3), 'low', round(g.get('mean_net_low') or 0, 4), 'cons', round(g.get('mean_net_conservative') or 0, 4), 'wick', round(g.get('mean_net_base_wickTP') or 0, 4),
              'h1', round(g.get('mean_net_first_half') or 0, 4), 'h2', round(g.get('mean_net_second_half') or 0, 4), 'perday', round(g.get('per_day') or 0, 1))


if __name__ == '__main__':
    main()
