#!/usr/bin/env python3
"""Live forward sample analysis (PumpPortal new tokens + migrations, decision-time snapshots at mig+60s / mig+5m,
GeckoTerminal 1m candles fetched afterwards).
Inputs: live/new_tokens.jsonl, live/migrations.jsonl, live/snapshots.jsonl, live/ohlcv_1m/*.json
Outputs: results/live_tokens.csv, results/live_results.json
Run `python3 analyze_live.py pools` first to write live/migrations_with_pool.jsonl for fetch_ohlcv.mjs.
"""
import json, os, glob, math, sys, csv, statistics as st, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import boot_ci, boot_diff, q, load_candles, price_at, simulate, net_return, SCEN

D = os.path.dirname(os.path.abspath(__file__))
L = lambda f: [json.loads(l) for l in open(os.path.join(D, f)) if l.strip()]


def snaps():
    out = {}
    for s in L('live/snapshots.jsonl'):
        out.setdefault(s['mint'], {})[s['tag']] = s
    return out


def pool_of(sn):
    for tag in ('mig+60s', 'mig+5m'):
        s = sn.get(tag)
        if not s:
            continue
        j = s['jup'][0] if isinstance(s.get('jup'), list) and s['jup'] else {}
        if j.get('graduatedPool'):
            return j['graduatedPool']
        for p in (s.get('dex') or []) if isinstance(s.get('dex'), list) else []:
            if p.get('dexId') == 'pumpswap':
                return p['pairAddress']
    return None


def write_pools():
    S = snaps(); n = 0
    with open(os.path.join(D, 'live/migrations_with_pool.jsonl'), 'w') as f:
        for m in L('live/migrations.jsonl'):
            p = pool_of(S.get(m['mint'], {}))
            if p:
                f.write(json.dumps({'mint': m['mint'], 'pool': p, 'ts': m['ts'], 'blockTime': int(m['ts'] / 1000)}) + '\n'); n += 1
    print('wrote', n)


def rate(ts_ms, gap_s=90):
    ts = sorted(t / 1000 for t in ts_ms)
    if len(ts) < 2:
        return None, 0
    span = 0
    for a, b in zip(ts, ts[1:]):
        if b - a < gap_s:
            span += b - a
    return len(ts) / (span / 3600), span / 3600


def main():
    new = L('live/new_tokens.jsonl'); mig = L('live/migrations.jsonl'); S = snaps()
    meta = json.load(open(os.path.join(D, 'backfill/meta.json'))) if os.path.exists(os.path.join(D, 'backfill/meta.json')) else {}
    sol_usd = meta.get('solUsd') or 119.3
    res = {}
    lr, lh = rate([x['ts'] for x in new])
    # migrations: rate over the same observed span as launches (they share the websocket)
    span_h = lh
    res['launches'] = {'n': len(new), 'observed_hours': span_h, 'per_hour': lr,
                       'mayhem_share': sum(bool(x.get('mayhem')) for x in new) / len(new),
                       'pump_suffix_share': sum(x['mint'].endswith('pump') for x in new) / len(new)}
    res['migrations'] = {'n': len(mig), 'per_hour': len(mig) / span_h if span_h else None}
    res['graduation_share_rate_ratio'] = (len(mig) / span_h) / lr if (lr and span_h) else None
    newset = {x['mint']: x['ts'] for x in new}
    cohort = [m for m in mig if m['mint'] in newset]
    res['cohort_created_and_migrated_in_window'] = {'n_migrated': len(cohort), 'n_created': len(newset),
                                                     'share_lower_bound': len(cohort) / len(newset) if newset else None,
                                                     'ttg_min_median': q([(m['ts'] - newset[m['mint']]) / 60000 for m in cohort], .5)}
    cand = {}
    for f in glob.glob(os.path.join(D, 'live/ohlcv_1m/*.json')):
        d, c = load_candles(f)
        if c:
            cand[d['mint']] = (d, c)
    rows = []
    for m in mig:
        sn = S.get(m['mint'], {}); a = sn.get('mig+60s'); b = sn.get('mig+5m')
        r = {'mint': m['mint'], 'mig_ts': m['ts'] / 1000, 'has_60s': bool(a), 'has_5m': bool(b)}
        if a:
            rug = a.get('rug') or {}
            mk = {x.get('pubkey') for x in (rug.get('markets') or [])}
            th = [h for h in (rug.get('topHolders') or []) if h.get('owner') not in mk and h.get('address') not in mk]
            r['top10_ex_pool_pct'] = sum(h.get('pct', 0) for h in th[:10]) if rug.get('topHolders') else None
            r['top1_ex_pool_pct'] = th[0]['pct'] if th else None
            r['insider_holders'] = sum(bool(h.get('insider')) for h in th[:20]) if th else None
            r['rug_score_norm'] = rug.get('score_normalised')
            r['rug_risks'] = '|'.join(x.get('name', '') for x in rug.get('risks') or [])
            r['rug_danger'] = int(any(x.get('level') == 'danger' for x in rug.get('risks') or []))
            r['graph_insiders'] = rug.get('graphInsidersDetected')
            r['rc_total_holders'] = rug.get('totalHolders')
            j = a['jup'][0] if isinstance(a.get('jup'), list) and a['jup'] else {}
            au = j.get('audit') or {}
            r['jup_top_holders_pct'] = au.get('topHoldersPercentage'); r['jup_dev_pct'] = au.get('devBalancePercentage')
            r['jup_holders_60s'] = j.get('holderCount'); r['dev_mints'] = au.get('devMints')
            r['socials'] = int(bool(j.get('twitter') or j.get('website') or j.get('telegram')))
            created = j.get('createdAt')
            from analyze import iso
            r['ttg_s'] = r['mig_ts'] - iso(created) if created else None
            dx = [p for p in (a.get('dex') or []) if isinstance(a.get('dex'), list) and p.get('dexId') == 'pumpswap']
            if dx:
                r['liq_quote_sol_60s'] = (dx[0].get('liquidity') or {}).get('quote')
                r['dex_profile_60s'] = int(bool(dx[0].get('info')))
                r['dex_boost_60s'] = int(bool((dx[0].get('boosts') or {}).get('active')))
        if b:
            dx = [p for p in (b.get('dex') or []) if isinstance(b.get('dex'), list) and p.get('dexId') == 'pumpswap']
            if dx:
                t = dx[0].get('txns', {}).get('m5', {})
                r['buys_5m'] = t.get('buys'); r['sells_5m'] = t.get('sells')
                r['buy_ratio_5m'] = t['buys'] / (t['buys'] + t['sells']) if (t.get('buys') is not None and (t['buys'] + t['sells'])) else None
                r['vol_usd_5m'] = (dx[0].get('volume') or {}).get('m5')
                r['dex_profile_5m'] = int(bool(dx[0].get('info')))
                r['liq_quote_sol_5m'] = (dx[0].get('liquidity') or {}).get('quote')
            j = b['jup'][0] if isinstance(b.get('jup'), list) and b['jup'] else {}
            s5 = j.get('stats5m') or {}
            if s5.get('buyVolume') is not None and (s5.get('buyVolume', 0) + s5.get('sellVolume', 0)) > 0:
                r['jup_buy_vol_share_5m'] = s5['buyVolume'] / (s5['buyVolume'] + s5['sellVolume'])
            r['jup_net_buyers_5m'] = s5.get('numNetBuyers')
            r['jup_holders_5m'] = j.get('holderCount')
            r['jup_top_holders_pct_5m'] = (j.get('audit') or {}).get('topHoldersPercentage')
        if m['mint'] in cand:
            d, c = cand[m['mint']]
            t0 = r['mig_ts']; Dt = math.ceil((t0 + 360) / 60) * 60  # decision after the +5m snapshot finished
            pe = price_at(c, Dt)
            r['data_until_min'] = (d['fetchedAt'] / 1000 - Dt) / 60
            if pe:
                r['entry_price'] = pe
                for k, s in (('15m', 900), ('30m', 1800), ('60m', 3600)):
                    if r['data_until_min'] * 60 >= s:
                        p = price_at(c, Dt + s) or pe
                        r['ret_' + k] = p / pe - 1
                        w = [x for x in c if Dt <= x[0] < Dt + s]
                        r['mae_' + k] = (min(x[3] for x in w) / pe - 1) if w else 0
                        r['mfe_' + k] = (max(x[2] for x in w) / pe - 1) if w else 0
                if r['data_until_min'] >= 30:
                    g, te, why = simulate(c, Dt, pe, -0.3, 0.5, 1800)
                    r['rule_S30_TP50_30m_gross'] = g - 1
                    r['rule_S30_TP50_30m_net_base'] = net_return(g, 2 / sol_usd, 67.4, 67.4 * math.sqrt(g), SCEN['base'])
        rows.append(r)
    res['n_rows'] = len(rows)
    std = [r for r in rows if (r.get('liq_quote_sol_60s') or 0) >= 30]
    res['standard_liquidity_share'] = len(std) / max(1, sum(1 for r in rows if r.get('liq_quote_sol_60s') is not None))
    for k in ('15m', '30m', '60m'):
        xs = [r['ret_' + k] for r in rows if r.get('ret_' + k) is not None]
        res['ret_' + k] = {'n': len(xs), 'median': q(xs, .5), 'median_ci': boot_ci(xs, st.median), 'p25': q(xs, .25), 'p75': q(xs, .75),
                           'mean': st.mean(xs) if xs else None, 'share_le_-50': sum(x <= -0.5 for x in xs) / len(xs) if xs else None,
                           'share_ge_+50': sum(x >= 0.5 for x in xs) / len(xs) if xs else None}
    nets = [r['rule_S30_TP50_30m_net_base'] for r in rows if r.get('rule_S30_TP50_30m_net_base') is not None]
    res['rule_live_S30_TP50_30m_entry_mig+6m'] = {'n': len(nets), 'mean_net': st.mean(nets) if nets else None, 'ci95': boot_ci(nets),
                                                  'win_rate': sum(x > 0 for x in nets) / len(nets) if nets else None}
    # signal splits on 30m outcome
    sig = {}
    def split(name, fn, key='ret_30m'):
        A = [r[key] for r in rows if r.get(key) is not None and fn(r) is True]
        Bn = [r[key] for r in rows if r.get(key) is not None and fn(r) is False]
        sig[name] = {'n_yes': len(A), 'n_no': len(Bn), 'median_yes': q(A, .5), 'median_no': q(Bn, .5),
                     'diff_median_ci': boot_diff(A, Bn) if (A and Bn) else None, 'mean_yes': st.mean(A) if A else None, 'mean_no': st.mean(Bn) if Bn else None}
    med = lambda k: q([r[k] for r in rows if r.get(k) is not None], .5)
    t10 = med('top10_ex_pool_pct'); br = med('buy_ratio_5m'); jt = med('jup_top_holders_pct'); hv = med('jup_holders_5m'); dv = med('jup_dev_pct')
    nb = med('jup_net_buyers_5m')
    nn = lambda v: v is not None
    split('top10_ex_pool_pct <= median (%.1f)' % (t10 or 0), lambda r: (r['top10_ex_pool_pct'] <= t10) if nn(r.get('top10_ex_pool_pct')) and t10 else None)
    split('jup topHolders%% <= median (%.1f)' % (jt or 0), lambda r: (r['jup_top_holders_pct'] <= jt) if nn(r.get('jup_top_holders_pct')) and jt else None)
    split('jup dev%% <= median (%.2f)' % (dv or 0), lambda r: (r['jup_dev_pct'] <= dv) if nn(r.get('jup_dev_pct')) and dv is not None else None)
    split('buy_ratio_5m >= median (%.2f)' % (br or 0), lambda r: (r['buy_ratio_5m'] >= br) if nn(r.get('buy_ratio_5m')) and br else None)
    split('jup net buyers 5m >= median (%s)' % nb, lambda r: (r['jup_net_buyers_5m'] >= nb) if nn(r.get('jup_net_buyers_5m')) and nb is not None else None)
    split('holders at +5m >= median (%s)' % hv, lambda r: (r['jup_holders_5m'] >= hv) if nn(r.get('jup_holders_5m')) and hv else None)
    split('rugcheck danger-level risk present', lambda r: bool(r['rug_danger']) if nn(r.get('rug_danger')) else None)
    split('rugcheck insiders detected', lambda r: bool(r['graph_insiders']) if nn(r.get('graph_insiders')) else None)
    split('socials present', lambda r: bool(r['socials']) if nn(r.get('socials')) else None)
    split('dexscreener profile at +5m', lambda r: bool(r['dex_profile_5m']) if nn(r.get('dex_profile_5m')) else None)
    split('ttg < 5 min', lambda r: (r['ttg_s'] < 300) if nn(r.get('ttg_s')) else None)
    res['signals_30m'] = sig
    os.makedirs(os.path.join(D, 'results'), exist_ok=True)
    json.dump(res, open(os.path.join(D, 'results/live_results.json'), 'w'), indent=1, default=str)
    keys = sorted({k for r in rows for k in r})
    with open(os.path.join(D, 'results/live_tokens.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); [w.writerow(r) for r in rows]
    print(json.dumps(res, indent=1, default=lambda x: round(x, 4) if isinstance(x, float) else str(x)))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'pools':
        write_pools()
    else:
        main()
