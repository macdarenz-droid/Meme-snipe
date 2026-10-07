"""Exit 1 if any file under research/launch-probe/ contains the value of HELIUS_API_KEY (run before every commit)."""
import os, sys
k = os.environ.get('HELIUS_API_KEY', '').encode()
if not k:
    raise SystemExit('HELIUS_API_KEY not set; cannot check')
here = os.path.dirname(os.path.abspath(__file__))
bad = []
for root, _, files in os.walk(here):
    for f in files:
        p = os.path.join(root, f)
        if k in open(p, 'rb').read():
            bad.append(os.path.relpath(p, here))
if bad:
    print('KEY FOUND IN:', bad); sys.exit(1)
print('key check ok')
