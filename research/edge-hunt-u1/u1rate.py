# Quick funnel: how many sampled pools have any hour in U1 (hourly high >= the 100-SOL-quote price, age 1-14 d).
import json, glob
n = e = 0
for f in glob.glob('data/bars/*.json'):
    d = json.load(open(f)); n += 1
    if d['eligHours'] > 0:
        e += 1; print(d['pool'][:8], d['eligHours'], len(d['h']), len(d['m5']))
print('pools', n, 'with U1 hours', e)
