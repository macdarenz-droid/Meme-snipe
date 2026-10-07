"""Execution audit replay (method fixed in PREREG.md before any result).

  EA_SCRATCH=<dir outside repo> python3 audit.py run [A|B|C|all]   # fetches (cached) and replays
  python3 audit.py report                                          # writes RESULTS tables from audit_results.json
"""
import json, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'lottery-probe'))
import heli, lottery
from concurrent.futures import ThreadPoolExecutor
POOL = ThreadPoolExecutor(8)
AHEAD = 40

LAT = (1, 5, 25, 150)
Q_STAKE = 10 / lottery.SOL_USD
HOLD = 14 * 86400
OUT = os.path.join(HERE, 'audit_results.json')
RESERVE = 20_000              # credits kept back for the report's own checks

def tx(sig):
    try:
        return heli.rpc('getTransaction', [sig, {'encoding': 'json', 'maxSupportedTransactionVersion': 0,
                                                 'commitment': 'finalized'}], cache_name='tx_' + sig)
    except RuntimeError as e:
        if 'version' in str(e).lower():
            return heli.rpc('getTransaction', [sig, {'encoding': 'json', 'maxSupportedTransactionVersion': 1,
                                                     'commitment': 'finalized'}], cache_name='tx1_' + sig)
        raise

class Swap:
    __slots__ = ('slot', 'idx', 'k', 't', 'B0', 'Q0', 'V', 'B1', 'Q1', 'f', 'kind', 'base', 'quote')

def swaps_of(sigrow, pool):
    t = tx(sigrow['signature'])
    out = []
    if not t:
        return out
    for k, ev in enumerate(heli.swaps_in_tx(t)):
        if ev['pool'] != pool:
            continue
        s = Swap()
        s.slot, s.idx, s.k, s.t = t['slot'], t.get('transactionIndex', 0), k, t.get('blockTime') or sigrow['blockTime']
        s.B0, s.Q0 = ev['pool_base_token_reserves'], ev['pool_quote_token_reserves']
        s.V = ev.get('virtual_quote_reserves') or 0
        s.f = (ev['lp_fee_bps'] + ev['protocol_fee_bps'] + ev.get('coin_creator_fee_bps', 0)) / 1e4
        s.kind, s.base, s.quote = ev['kind'], ev['amount_base'], ev['quote_amount']
        # the pool's quote moves by quote_amount_in_with_lp_fee (buy) / quote_amount_out_without_lp_fee (sell):
        # checked against the next event's pre-swap reserves; `quote_amount` alone is wrong for one buy layout
        if s.kind == 'buy':
            s.B1, s.Q1 = s.B0 - s.base, s.Q0 + ev['quote_amount_fee_adj']
        else:
            s.B1, s.Q1 = s.B0 + s.base, s.Q0 - ev['quote_amount_fee_adj']
        out.append(s)
    return out

def price(B, Q, V):
    return ((Q + V) / 1e9) / (B / 1e6) if B > 0 else float('inf')

def sell(tokens_raw, s):
    """Sell tokens (raw base units) into the state after swap s. Returns SOL proceeds after pool fees."""
    Qe = s.Q1 + s.V
    gross = Qe * tokens_raw / (s.B1 + tokens_raw)
    return gross * (1 - s.f) / 1e9

class Stream:
    """Swaps of one pool in (slot, transactionIndex, inner) order, fetched lazily from a signature list."""
    def __init__(self, pool, sigs):
        self.pool = pool
        self.sigs = [x for x in sigs if x['err'] is None]
        self.i = 0
        self.buf = []
        self.mismatch = 0
        self.last = None
        self.fetched = 0

    def _fill(self):
        # fetch all signatures of the next slot, then sort them by transaction index
        if self.i >= len(self.sigs):
            return False
        ahead = [x['signature'] for x in self.sigs[self.i:self.i + AHEAD]
                 if not os.path.exists(os.path.join(heli.RAW, 'tx_' + x['signature'] + '.json'))]
        if len(ahead) > 1:
            list(POOL.map(tx, ahead))                  # look-ahead prefetch (at most AHEAD past the need)
        slot = self.sigs[self.i]['slot']
        got = []
        while self.i < len(self.sigs) and self.sigs[self.i]['slot'] == slot:
            got += swaps_of(self.sigs[self.i], self.pool); self.i += 1; self.fetched += 1
        got.sort(key=lambda s: (s.slot, s.idx, s.k))
        self.buf += got
        return True

    def next(self):
        while not self.buf:
            if not self._fill():
                return None
        s = self.buf.pop(0)
        if self.last is not None and (self.last.B1 != s.B0 or abs(self.last.Q1 - s.Q0) > 2):
            self.mismatch += 1
        self.last = s
        return s

    def peek_slot(self):
        while not self.buf:
            if not self._fill():
                return None
        return self.buf[0].slot

def state_until(stream, first, slot_cap):
    """Advance from swap `first` through every swap with slot <= slot_cap; return the last one."""
    cur = first
    while True:
        ps = stream.peek_slot()
        if ps is None or ps > slot_cap:
            return cur
        cur = stream.next()

def coin_sigs(c, t_end):
    e = c['entry_ts']
    sigs = heli.pool_sigs(c['pool'], e - 3600, t_end)
    if not any(x['err'] is None and x['blockTime'] < e for x in sigs):
        sigs = heli.pool_sigs(c['pool'], e - 3 * 86400, e - 3601) + sigs
    return sigs

def entry_state(c, sigs):
    """Last swap before entry_ts (walk backwards over successful signatures)."""
    e = c['entry_ts']
    pre = [x for x in sigs if x['err'] is None and x['blockTime'] < e]
    best = None
    for x in reversed(pre):
        if best is not None and x['slot'] < best.slot:
            break                                      # every transaction of the last swap slot has been read
        for s in swaps_of(x, c['pool']):
            if best is None or (s.slot, s.idx, s.k) > (best.slot, best.idx, best.k):
                best = s
    return best

def fills(stream_factory, trig, tokens):
    """Proceeds at each latency for a trigger swap. A fresh stream positioned after the trigger."""
    st = stream_factory(trig)
    out = {}
    cur = trig
    for L in LAT:
        cur = state_until(st, cur, trig.slot + L)
        out[L] = {'sol': sell(tokens, cur), 'p_marg': price(cur.B1, cur.Q1, cur.V), 'slot': cur.slot}
    return out, st

def replay(c, sigs, label):
    e = c['entry_ts']
    s0 = entry_state(c, sigs)
    if s0 is None:
        return {'mint': c['mint'], 'label': label, 'skip': 'no swap before entry in fetched range'}
    Pe = price(s0.B1, s0.Q1, s0.V)
    x = Q_STAKE / (1 + s0.f) * 1e9
    tokens = (s0.B1 * x) / (s0.Q1 + s0.V + x)          # raw base units
    tok_per_sol = (tokens / 1e6) / Q_STAKE
    m0 = c['p0_hourly_close_sol'] * 1e9
    model_tok_per_sol = (1 / c['p0_hourly_close_sol']) * (1 - lottery.fee(m0)) / (1 + Q_STAKE / lottery.R(m0))
    res = {'mint': c['mint'], 'pool': c['pool'], 'label': label, 'entry': {
        'slot': s0.slot, 'P_e': Pe, 'p0_hourly_close': c['p0_hourly_close_sol'], 'P_e_over_close': Pe / c['p0_hourly_close_sol'],
        'fee_bps': round(s0.f * 1e4, 2), 'model_fee_bps': lottery.fee(m0) * 1e4, 'quote_eff_sol': (s0.Q1 + s0.V) / 1e9,
        'virtual_quote_sol': s0.V / 1e9, 'tokens': tokens / 1e6, 'avg_fill': Q_STAKE / (tokens / 1e6),
        'avg_fill_over_close': Q_STAKE / (tokens / 1e6) / c['p0_hourly_close_sol'],
        'tokens_vs_model': tok_per_sol / model_tok_per_sol}}
    after = [x for x in sigs if x['blockTime'] >= e]
    def factory_from(i0):
        return Stream(c['pool'], after[i0:])
    # --- real-time path ---
    st = Stream(c['pool'], after)
    peak, armed = Pe, False
    peak_at = (s0.slot, s0.t)
    trig = {'R1': None, 'R2': None}
    trail = {'R1': 0.4, 'R2': 0.6}
    n = 0
    last_needed = None
    while True:
        s = st.next()
        if s is None:
            break
        n += 1
        if s.t >= e + HOLD:
            for r in trig:
                if trig[r] is None:
                    trig[r] = ('time', s, peak)
        P = price(s.B1, s.Q1, s.V)
        if not armed and P <= 0.7 * Pe:
            for r in trig:
                if trig[r] is None:
                    trig[r] = ('stop', s, peak)
        if P > peak:
            peak = P; peak_at = (s.slot, s.t)
        if not armed and peak >= 2 * Pe:
            armed = True
        if armed:
            for r in trig:
                if trig[r] is None and P <= (1 - trail[r]) * peak:
                    trig[r] = ('trail', s, peak, peak_at)
        if all(trig.values()):
            break
    res['realtime_swaps_read'] = n
    res['mismatch_rt'] = st.mismatch
    tok_sol_peak = lambda pk: tokens / 1e6 * pk
    def fills_from(trig_swap):
        # restart a stream at the trigger's slot (cached transactions, no extra credits)
        i0 = next(i for i, x in enumerate(after) if x['slot'] >= trig_swap.slot)
        stx = Stream(c['pool'], after[i0:])
        cur = None
        while True:                                    # advance to the trigger swap itself
            s = stx.next()
            if s is None or (s.slot, s.idx, s.k) == (trig_swap.slot, trig_swap.idx, trig_swap.k):
                cur = s; break
        out = {}
        for L in LAT:
            cur = state_until(stx, cur, trig_swap.slot + L)
            out[str(L)] = {'mult': sell(tokens, cur) / Q_STAKE, 'p_marg': price(cur.B1, cur.Q1, cur.V)}
        return out
    for r in ('R1', 'R2'):
        if trig[r] is None:
            res[r + '_rt'] = {'reason': 'none-in-range'}
            continue
        why, s, pk = trig[r][:3]
        pa = trig[r][3] if len(trig[r]) > 3 else None
        f = fills_from(s)
        res[r + '_rt'] = {'reason': why, 'slot': s.slot, 't': s.t, 'P_trig_over_Pe': price(s.B1, s.Q1, s.V) / Pe,
                          'peak_over_Pe': pk / Pe, 'peak_slot_t': pa, 'fills': f,
                          'share_of_peak_value': {L: f[L]['mult'] * Q_STAKE / tok_sol_peak(pk) for L in f}}
    # --- hourly exits ---
    for r in ('R1', 'R2'):
        h = c[r + '_hourly']
        tend = h['exit_bar_start'] + 3600
        cand = [x for x in after if x['blockTime'] >= tend and x['err'] is None]
        trig_s = None
        for x in cand:
            ss = swaps_of(x, c['pool'])
            if ss:
                trig_s = min(ss, key=lambda s: (s.idx, s.k)); break
        if trig_s is None:
            res[r + '_hourly'] = {'reason': 'no swap after exit bar in range'}
            continue
        f = fills_from(trig_s)
        res[r + '_hourly'] = {'model_reason': h['reason'], 'model_net_$10': h['net_$10'],
                              'model_p_exit_over_p0': h['p_exit'] / c['p0_hourly_close_sol'],
                              'slot': trig_s.slot, 'delay_s': trig_s.t - tend, 'fills': f}
    return res

def missing(r):
    return any(r.get(k, {}).get('reason') in ('none-in-range', 'no swap after exit bar in range')
               for k in ('R1_rt', 'R2_rt', 'R1_hourly', 'R2_hourly'))

def need_end(c):
    return max(c['R1_hourly']['exit_bar_start'], c['R2_hourly']['exit_bar_start']) + 3600 + 900

def run(which):
    T = json.load(open(os.path.join(HERE, 'targets.json')))
    val = {u['pool'] for u in json.load(open(os.path.join(HERE, '..', 'runner-probe', 'validation_sample.json')))}
    jobs = []
    if which in ('A', 'all'):
        jobs.append(('A-jackpot', T['winners_peak_ge_2x'][0]))
    if which in ('B', 'all'):
        jobs += [(f'B-winner{i}', c) for i, c in enumerate(T['winners_peak_ge_2x'][1:10], 1)]
    if which in ('C', 'all'):
        jobs += [(f'C-stop{i}', c) for i, c in enumerate(T['random_stop_outs_seed20261007'])]
    out = json.load(open(OUT)) if os.path.exists(OUT) else {'trades': {}, 'skipped': {}}
    for label, c in jobs:
        if c['pool'] in val:
            out['skipped'][label] = 'validation coin (never read)'; continue
        if label in out['trades']:
            continue
        try:
            r = None
            # widen the range only when a trigger or an exit swap lies past it (thin pools, no early trigger)
            for t_end in (need_end(c), c['entry_ts'] + HOLD + 86400):
                if t_end < need_end(c) or (r is not None and not missing(r)):
                    break
                sigs = coin_sigs(c, t_end)
                ok = sum(1 for x in sigs if x['err'] is None)
                led = heli.credits()['credits']
                if led + 10 * ok > heli.CAP - RESERVE:
                    r = None
                    out['skipped'][label] = f'would exceed cap: up to {ok} transactions ({10 * ok} credits), {led} used'
                    print(label, 'SKIP', out['skipped'][label]); break
                r = replay(c, sigs, label)
                r['sigs_in_range'] = ok; r['range_end'] = t_end
            if r is None:
                continue
        except heli.CapReached as ex:
            out['skipped'][label] = 'cap reached: ' + str(ex); print(label, 'CAP'); break
        out['trades'][label] = r
        out['credits'] = heli.credits()
        json.dump(out, open(OUT, 'w'), indent=1)
        print(label, 'done', heli.credits(), flush=True)
    out['credits'] = heli.credits()
    json.dump(out, open(OUT, 'w'), indent=1)

if __name__ == '__main__':
    if sys.argv[1] == 'run':
        run(sys.argv[2] if len(sys.argv) > 2 else 'all')

def fmt(x, d=2):
    return '—' if x is None else (f'{x:.{d}f}' if abs(x) < 1e4 else f'{x:.3g}')

def report():
    """Per-trade tables (markdown) from audit_results.json, printed to stdout and written to tables.md."""
    d = json.load(open(OUT))
    fixed_mult = lottery.FIXED / Q_STAKE
    L = [str(x) for x in LAT]
    lines = ['Multiples are proceeds / $10 stake after pool fees, before the network cost (subtract '
             f'{fixed_mult:.4f} for it). Model net is `net_$10` + 1 (a multiple, network cost included).', '']
    lines.append('| trade | rule | model mult | hourly replay L=' + ' / '.join(L) + ' | real-time reason | real-time L=' +
                 ' / '.join(L) + ' | rt share of peak value (L=1/150) | peak/P_e at trigger |')
    lines.append('|---|---|---|---|---|---|---|---|')
    for k, r in d['trades'].items():
        if 'skip' in r:
            lines.append(f'| {k} | — | skipped: {r["skip"]} |'); continue
        for rule in ('R1', 'R2'):
            h, rt = r.get(rule + '_hourly', {}), r.get(rule + '_rt', {})
            hm = ' / '.join(fmt(h['fills'][x]['mult']) for x in L) if 'fills' in h else h.get('reason', '—')
            rm = ' / '.join(fmt(rt['fills'][x]['mult']) for x in L) if 'fills' in rt else '—'
            sh = (fmt(rt['share_of_peak_value']['1'], 3) + ' / ' + fmt(rt['share_of_peak_value']['150'], 3)) if 'fills' in rt else '—'
            lines.append(f"| {k} | {rule} | {fmt(h.get('model_net_$10', -1) + 1)} ({h.get('model_reason', '')}) | {hm} | "
                         f"{rt.get('reason', '—')} | {rm} | {sh} | {fmt(rt.get('peak_over_Pe'))} |")
    lines += ['', '| trade | P_e / hourly close | avg fill / hourly close | fee bps (real / model) | tokens vs model | eff. quote SOL | swaps read | state mismatches |',
              '|---|---|---|---|---|---|---|---|']
    for k, r in d['trades'].items():
        if 'skip' in r:
            continue
        e = r['entry']
        lines.append(f"| {k} | {fmt(e['P_e_over_close'], 3)} | {fmt(e['avg_fill_over_close'], 3)} | {fmt(e['fee_bps'], 0)} / {fmt(e['model_fee_bps'], 0)} | "
                     f"{fmt(e['tokens_vs_model'], 3)} | {fmt(e['quote_eff_sol'], 1)} | {r.get('realtime_swaps_read')} | {r.get('mismatch_rt')} |")
    lines += ['', f"Credits counted: {d.get('credits')}", '', 'Skipped: ' + json.dumps(d.get('skipped', {}))]
    open(os.path.join(HERE, 'tables.md'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))

if __name__ == '__main__' and sys.argv[1] == 'report':
    report()
