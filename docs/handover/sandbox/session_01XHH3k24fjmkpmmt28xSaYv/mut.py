import subprocess, shutil, sys
S=sys.argv[1]; p='ci/rpc-ledger.sh'
muts=[('actual = max(actual, 0) if not notes else reserved','actual = max(actual, 0)'),
      ('\n    lock\n    fetch\n    rc=0','\n    fetch\n    rc=0'),
      ('out_all = sum(int(o["amount"]) for o in outstanding)','out_all = 0'),
      ('left_day = int(day_cap) - int(days.get(day, 0)) - out_day','left_day = int(day_cap)'),
      ('if any(o["id"] == rid for o in outstanding):','if False:'),
      ('assert u.get("final") is True and','assert'),
      ('  [ -z "$locked" ] || "$gh" release delete-asset','  true || "$gh" release delete-asset'),
      ('    if "$gh" release view "$tag" >/dev/null 2>&1; then lock; fi\n','')]
base=open(S+'/ledger.bak').read()
for a,b in muts:
    assert base.count(a)==1,a
    open(p,'w').write(base.replace(a,b))
    r=subprocess.run(['bash','ci/test-ci.sh'],capture_output=True,text=True).stdout.strip().splitlines()[-1]
    print(repr(a[:50]),'=>',r,flush=True)
shutil.copy(S+'/ledger.bak',p)
