"""Swap-transaction rates per watched pool from the Zeroed worker's 6 Oct recordings (zeroed-data, rec-2026-10-06).

Read-only. Downloads a fixed sample of frames files (every k-th file, first boot file excluded) into a scratch
directory given as argv[1], then counts, per logsSubscribe address, unique signatures (all, and err == null)
and the covered wall-clock span. Pool ages come from the worker's own candidate facts (migratedAtMs).
Output: JSON summary on stdout. No Helius call is made; GitHub release downloads only.
"""
import io, json, os, sys, collections, urllib.request
import zstandard

scratch = sys.argv[1]
step = int(sys.argv[2]) if len(sys.argv) > 2 else 57
rel = json.load(open(os.path.join(scratch, 'rel6.json')))
frames = sorted((a for a in rel['assets'] if '.frames-' in a['name']), key=lambda a: a['name'])
sample = frames[::step]

def fetch(a):
    p = os.path.join(scratch, a['name'])
    if not os.path.exists(p) or os.path.getsize(p) != a['size']:
        req = urllib.request.Request(a['url'], headers={'Accept': 'application/octet-stream'})
        with urllib.request.urlopen(req, timeout=120) as r, open(p, 'wb') as f:
            f.write(r.read())
    return p

files = []
migrated = {}
for a in sample:
    p = fetch(a)
    sigs_all = collections.defaultdict(set); sigs_err = collections.defaultdict(set)
    slots = collections.defaultdict(set)
    t0 = t1 = None
    with open(p, 'rb') as fh:
        for line in io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh)):
            o = json.loads(line); b = o['body']; ts = o['receivedAt']
            t0 = ts if t0 is None else min(t0, ts); t1 = ts if t1 is None else max(t1, ts)
            if b.get('type') == 'fact' and isinstance(b.get('value'), dict):
                for c in b['value'].get('candidates', []) or []:
                    if isinstance(c, dict) and c.get('pool') and c.get('migratedAtMs'):
                        migrated[c['pool']] = c['migratedAtMs']
            if b.get('type') in ('seen', 'logs') and str(b.get('via', '')).startswith('logs:'):
                addr = b['via'].split(':', 1)[1]
                sigs_all[addr].add(b['signature'])
                if b.get('err') is not None:
                    sigs_err[addr].add(b['signature'])
                sl = b.get('slot')
                if isinstance(sl, dict) and '$n' in sl:
                    slots[addr].add(int(sl['$n']))
    span = (t1 - t0) / 1000
    files.append({'asset': a['name'], 'span_s': span, 'start_ms': t0,
                  'addr': {k: [len(sigs_all[k]), len(sigs_all[k] - sigs_err[k]),
                               (max(slots[k]) - min(slots[k]) + 1) if slots[k] else 0] for k in sigs_all}})
json.dump({'files': files, 'migratedAtMs': migrated}, sys.stdout)
