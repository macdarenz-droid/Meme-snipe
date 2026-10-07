"""Per-day Helius credit estimate for whole-block reads (DATA-2 rpcscan), from the keyless slot grid.

Input: slot_grid.json (slot_grid.py output). No network access.
Per UTC day D:
  - the planner reads every 4,500-slot unit (units are epoch-aligned, and 432,000 / 4,500 = 96, so they are
    aligned to multiples of 4,500) whose interpolated time reaches [D 00:00 - 3,600 s, D+1 00:00 + 3,600 s)
    (rpcscan/main.go epochUnits: margin = 2 x 4,500 x 0.4 s = 3,600 s each side);
  - each produced block costs 1 credit (getBlock), plus one getBlocks per unit;
  - check-day.sh rescans one unit for determinism (one more unit a day);
  - retries (429, 5xx, truncated JSON) cost credits too: the client reserves a credit per HTTP attempt.
Point: retry overhead R_POINT, measured on 2026-09-21 (66 units for 319,730 credits, HANDOVER:1221, :1285; 79 planned units, :1227).
Upper: every planned slot produced, plus R_UPPER retries (above the largest measured share, 18 %).
Usage: estimate.py slot_grid.json > estimate.json
"""
import bisect, datetime as dt, json, math, sys

UNIT = 4500
MARGIN_S = 3600
R_UPPER = 0.25

g = json.load(open(sys.argv[1]))
rows = sorted((r for r in g['rows'] if r.get('time')), key=lambda r: r['first_produced'])
S = [r['first_produced'] for r in rows]
T = [r['time'] for r in rows]
P = [r['produced'] / r['win'] for r in rows]

def slot_at(t):
    i = bisect.bisect_left(T, t)
    i = min(max(i, 1), len(T) - 1)
    a, b = i - 1, i
    return S[a] + (t - T[a]) * (S[b] - S[a]) / (T[b] - T[a])

def produced_frac(s0, s1):
    v = [P[i] for i in range(len(S)) if s0 <= S[i] <= s1]
    if not v:
        i = min(range(len(S)), key=lambda k: abs(S[k] - (s0 + s1) / 2)); v = [P[i]]
    return sum(v) / len(v)

def day(d):
    t0 = int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp()); t1 = t0 + 86400
    a, b = slot_at(t0), slot_at(t1)
    lo, hi = slot_at(t0 - MARGIN_S), slot_at(t1 + MARGIN_S)
    units = math.floor(hi / UNIT) - math.floor(lo / UNIT) + 1
    p = produced_frac(a, b)
    return {'day': d.isoformat(), 'slots': round(b - a), 'slot_ms': round(86400 / (b - a) * 1000, 1),
            'units': units, 'produced_frac': round(p, 4)}

# anchor: 2026-09-21 measured 79 planned units; 66 units cost 319,730 credits including retries
anchor = day(dt.date(2026, 9, 21))
base_per_unit_0921 = UNIT * anchor['produced_frac'] + 1
R_POINT = 319730 / 66 / base_per_unit_0921 - 1

def credits(d):
    x = day(d)
    base = (x['units'] + 1) * (UNIT * x['produced_frac'] + 1)
    x['credits_point'] = round(base * (1 + R_POINT))
    x['credits_upper'] = round((x['units'] + 1) * (UNIT + 1) * (1 + R_UPPER))
    return x

first, last = dt.date(2026, 7, 19), dt.date(2026, 9, 21)
days = [credits(first + dt.timedelta(k)) for k in range((last - first).days + 1)]
by = {x['day']: x for x in days}

def window(start, n=30, lead=2):
    s = dt.date.fromisoformat(start)
    scored = [by[(s + dt.timedelta(k)).isoformat()] for k in range(n)]
    leadin = [by[(s - dt.timedelta(k)).isoformat()] for k in range(1, lead + 1)]
    allx = scored + leadin
    return {'start': start, 'end': scored[-1]['day'], 'lead_in_days': lead,
            'credits_point': sum(x['credits_point'] for x in allx), 'credits_upper': sum(x['credits_upper'] for x in allx),
            'max_day_upper': max(x['credits_upper'] for x in allx), 'units': sum(x['units'] + 1 for x in allx),
            'blocks': round(sum((x['units'] + 1) * UNIT * x['produced_frac'] for x in allx))}

starts = [(dt.date(2026, 7, 23) + dt.timedelta(k)).isoformat() for k in range((dt.date(2026, 8, 23) - dt.date(2026, 7, 23)).days + 1)]
wins = [window(s) for s in starts]
out = {'anchor_0921': anchor, 'retry_overhead_point': round(R_POINT, 4), 'retry_overhead_upper': R_UPPER,
       'grid_calls': g.get('calls'), 'days': days, 'windows_30d_leadin2': wins,
       'cheapest': min(wins, key=lambda w: w['credits_point']), 'latest': wins[-1]}

# 60 days: every clean post-BOOST day from 2026-07-24 to 2026-09-21 (lead-in 07-22, 07-23)
out['sixty_days_0724_0921_leadin2'] = window('2026-07-24', 60, 2)
# one lead-in day instead of two, cheapest window
out['cheapest_leadin1'] = window(out['cheapest']['start'], 30, 1)
# per slot-time regime (LD-08 targets; measured means from the grid)
regimes = [('400 ms target (to 08-20)', '2026-07-23', '2026-08-20'), ('350 ms (08-21 to 08-27)', '2026-08-21', '2026-08-27'),
           ('300 ms (08-28 to 09-17)', '2026-08-28', '2026-09-17'), ('250 ms (09-18 on)', '2026-09-18', '2026-09-21')]
out['regimes'] = []
for name, a, b in regimes:
    xs = [x for x in days if a <= x['day'] <= b]
    out['regimes'].append({'regime': name, 'days': len(xs), 'mean_slot_ms': round(sum(x['slot_ms'] for x in xs) / len(xs), 1),
                           'units_per_day': sorted({x['units'] for x in xs}),
                           'credits_point_per_day': round(sum(x['credits_point'] for x in xs) / len(xs)),
                           'credits_upper_per_day_max': max(x['credits_upper'] for x in xs),
                           'min_produced_frac': min(x['produced_frac'] for x in xs)})

def daylist(names):
    xs = [by[n] for n in names]
    return {'days': len(xs), 'credits_point': sum(x['credits_point'] for x in xs),
            'credits_upper': sum(x['credits_upper'] for x in xs),
            'blocks': round(sum((x['units'] + 1) * UNIT * x['produced_frac'] for x in xs))}

def span(a, b):
    a, b = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
    return [(a + dt.timedelta(k)).isoformat() for k in range((b - a).days + 1)]

# R2-05: 26 old-format days plus the 4 newest clean days (250 ms, post-B4), one lead-in day before each segment
out['mixed_26old_4new'] = daylist(span('2026-07-26', '2026-08-21') + span('2026-09-17', '2026-09-21'))
out['newest_4_with_leadin'] = daylist(span('2026-09-17', '2026-09-21'))
# extras budgeted inside U (supervisor round 3 item 6); P10 has its own allocation
EXTRAS = {'P12_fee_and_global_config_history': 1000, 'MR_pool_age_and_mint_lookups': 25000, 'admin_usage_reads': 100}
P10_CAP = 12000
ACCT_CAP = 9500000
rec = out['cheapest_leadin1']
est = rec['credits_point'] + sum(EXTRAS.values())
cap = rec['credits_upper'] + sum(EXTRAS.values())
out['spend_rules'] = {'extras_inside_U': EXTRAS, 'P10_own_allocation': P10_CAP,
                      'estimate_shown_to_owner': est, 'row_cap': cap, 'total_exposure_incl_P10': cap + P10_CAP,
                      'S_max_for_start_U_ge_1_1x_estimate': ACCT_CAP - math.ceil(1.1 * est),
                      'S_max_for_full_row_cap': ACCT_CAP - cap,
                      'min_blocks_per_s_in_14d_window': round(rec['blocks'] / (14 * 86400 - 31 * 45 * 60), 2)}
json.dump(out, sys.stdout, indent=1)
