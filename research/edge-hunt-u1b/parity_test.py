"""Checks costs.py against the bot's TypeScript quote code (parity.ts) on 3,000 random pool states and sizes."""
import json, os, random, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import costs
rng = random.Random(1); cases = []
for _ in range(3000):
    eff = rng.randint(30, 20000) * 10 ** 9 + rng.randint(0, 10 ** 9); virt = rng.choice([0, costs.VIRTUAL])
    base = rng.randint(10 ** 12, 9 * 10 ** 14)
    cases.append({'vault': eff - virt, 'virt': virt, 'base': base, 'spend': rng.choice([2, 20, 1000, 10 ** 5, 10 ** 7]) * rng.randint(10 ** 4, 10 ** 6),
                  'sellBase': rng.randint(10 ** 6, base // 2)})
f = os.path.join(costs.HERE, 'data', 'parity_cases.json'); json.dump(cases, open(f, 'w'))
ts = json.loads(subprocess.check_output(['node', '--experimental-strip-types', '--no-warnings', os.path.join(costs.HERE, 'parity.ts'), f]))
bad = 0
for c, t in zip(cases, ts):
    b = costs.buy(c['vault'], c['virt'], c['base'], c['spend']); s = costs.sell(c['vault'], c['virt'], c['base'], c['sellBase'])
    py = {'buy': None if b is None else [str(x) for x in b], 'sell': None if s is None else [str(x) for x in s]}
    if py != t: bad += 1; print('MISMATCH', c, py, t) if bad < 5 else None
print(f'parity: {len(cases)} cases, {bad} mismatches'); sys.exit(1 if bad else 0)
