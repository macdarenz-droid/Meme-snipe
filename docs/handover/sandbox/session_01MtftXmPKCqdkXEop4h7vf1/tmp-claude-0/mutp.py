import subprocess, sys, json
muts = json.load(open(sys.argv[1]))
for f, a, b in muts:
    s = open(f).read()
    if a not in s: print('MISSING', a); continue
    open(f, 'w').write(s.replace(a, b, 1))
    r = subprocess.run('cd packages/core && npx vitest run test/risk 2>&1 | grep -E "Tests "; cd ../worker && npx vitest run test/partial-sale.test.ts 2>&1 | grep -E "Tests "', shell=True, capture_output=True, text=True)
    open(f, 'w').write(s)
    killed = 'failed' in r.stdout
    print('KILLED' if killed else 'SURVIVED', '|', a[:70], '=>', b[:50])
