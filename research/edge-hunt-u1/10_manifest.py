"""Writes manifest.json: sha256 and size of every data file this report used (data/ itself stays out of git)."""
import hashlib, json, os
HERE = os.path.dirname(os.path.abspath(__file__)); D = os.path.join(HERE, 'data')
files = {}
for root, _, fs in os.walk(D, followlinks=True):
    for f in sorted(fs):
        p = os.path.join(root, f); rel = os.path.relpath(p, D)
        if rel.startswith('trades_'): continue  # copied to results/trades
        h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
        files[rel] = {'sha256': h, 'bytes': os.path.getsize(p)}
agg = hashlib.sha256(''.join(f'{k}:{v["sha256"]}\n' for k, v in sorted(files.items())).encode()).hexdigest()
json.dump({'note': 'data/ is not in git; these hashes pin the inputs of REPORT.md', 'files': len(files), 'aggregateSha256': agg,
           'list': dict(sorted(files.items()))}, open(os.path.join(HERE, 'manifest.json'), 'w'), indent=0)
print(len(files), agg)
