"""Synthetic checks of the frozen rules (no network).  AB_SCRATCH=<dir> python3 -I test_rules.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import events, swaps

def mk(t, kind, user, B0, Q0, base, q, slot=None, idx=0):
    s = swaps.Swap()
    s.slot, s.idx, s.k, s.t, s.sig, s.user, s.kind = slot or t, idx, 0, t, f'{user}{t}', user, kind
    s.B0, s.Q0, s.V, s.f, s.base, s.qpool, s.quser = B0, Q0, 0, 0.003, base, q, q
    s.B1, s.Q1 = (B0 - base, Q0 + q) if kind == 'buy' else (B0 + base, Q0 - q)
    return s

def chain(spec, B=10**15, Q=10**12):
    out = []
    for t, kind, user, frac in spec:
        if kind == 'sell':
            q = int(Q * frac); base = int(B * q / (Q - q))
        else:
            q = int(Q * frac); base = int(B * q / (Q + q))
        s = mk(t, kind, user, B, Q, base, q); out.append(s); B, Q = s.B1, s.Q1
    return out

# a wallet selling 6% + 5% within 300 s qualifies; 6% then 5% at 301 s does not
sw = chain([(0, 'sell', 'w', 0.06), (100, 'sell', 'w', 0.05)])
assert events.find_sales(sw, 0, 10)[0]['n_sells'] == 2
sw = chain([(0, 'sell', 'w', 0.06), (301, 'sell', 'w', 0.05)])
assert events.find_sales(sw, 0, 10) == []
# other wallets do not add up
sw = chain([(0, 'sell', 'a', 0.06), (10, 'sell', 'b', 0.06)])
assert events.find_sales(sw, 0, 20) == []
# union-find groups
g = events.Groups(); g.u('x', 'f'); g.u('y', 'f'); g.u('z', 'y')
assert g.f('x') == g.f('z') and g.f('q') != g.f('x')
# b_trigger: dip of 12% by 6 sellers, back above the reference within the window
spec = [(0, 'buy', 'r', 0.001)] + [(600 + 60 * i, 'sell', f's{i}', 0.022) for i in range(6)] + \
       [(2000 + 30 * i, 'buy', f'b{i}', 0.03) for i in range(6)]
sw = chain(spec)
i, info = events.b_trigger(sw, 3600, 3600 + 3000)
assert i is None                                  # buys at 2000..2150 happen before the window opens
spec2 = [(0, 'buy', 'r', 0.001)] + [(600 + 60 * i, 'sell', f's{i}', 0.022) for i in range(6)] + \
        [(3700 + 30 * i, 'buy', f'b{i}', 0.03) for i in range(6)]
sw = chain(spec2)
i, info = events.b_trigger(sw, 3600, 3600 + 3000)
assert i is not None and info['sellers'] == 6 and info['dip'] > 0.1, info
# one seller making the whole dip: rejected
spec3 = [(0, 'buy', 'r', 0.001), (600, 'sell', 's', 0.03), (620, 'sell', 's', 0.03), (640, 'sell', 's', 0.03),
         (660, 'sell', 'o1', 0.001), (680, 'sell', 'o2', 0.001), (700, 'sell', 'o3', 0.001), (720, 'sell', 'o4', 0.001)] + \
        [(3700 + 30 * i, 'buy', f'b{i}', 0.03) for i in range(6)]
assert events.b_trigger(chain(spec3), 3600, 6600)[0] is None
# round-trip cost: zero-impact limit equals two fees plus fixed
s = mk(0, 'buy', 'u', 10**18, 10**15, 1, 1)
c = swaps.round_trip_cost(0.41925, s, 0.000414009)
assert abs(c - (1 - (1 - 0.003) / (1 + 0.003) + 0.000414009 / 0.41925)) < 1e-4, c
print('ok')
