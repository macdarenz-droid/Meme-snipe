import subprocess
D='packages/worker/src/facts/deployer-checks.ts'; B='packages/worker/src/facts/budget.ts'; R='packages/worker/src/facts/readers.ts'; S='packages/worker/src/facts/source.ts'
M=[
 (D,"const FINAL: ReadonlySet<string> = new Set(['rug', 'clear', 'unjudged']);","const FINAL: ReadonlySet<string> = new Set(['rug', 'unjudged']);"),
 (D,"const FINAL: ReadonlySet<string> = new Set(['rug', 'clear', 'unjudged']);","const FINAL: ReadonlySet<string> = new Set(['clear', 'unjudged']);"),
 (D,"return c === undefined || (!FINAL.has(c.check.status) && rereadDue);","return c === undefined || !FINAL.has(c.check.status);"),
 (D,"return c === undefined || (!FINAL.has(c.check.status) && rereadDue);","return !FINAL.has(c?.check.status ?? 'rug') && rereadDue;"),
 (D,"const rereadDue = last === undefined || nowMs - last >= o.minGapMs;","const rereadDue = last === undefined || nowMs - last > o.minGapMs;"),
 (D,"      this.#lastReread.set(req.creator, nowMs);\n",""),
 (D,"if (pending.length > 0 && left > 0) {","if (pending.length > 0) {"),
 (D,"creditCapPerCandidate: Math.min(o.config.creditCapPerCandidate, left)","creditCapPerCandidate: o.config.creditCapPerCandidate"),
 (D,"      this.#spent += credits;\n",""),
 (D," && cache.get(m.mint)?.check.status !== 'rug'",""),
 (D,"(FINAL.has(c.check.status) || (c.slot >= oldest && c.slot <= req.asOf.slot))","(FINAL.has(c.check.status) || c.slot <= req.asOf.slot)"),
 (D,"(FINAL.has(c.check.status) || (c.slot >= oldest && c.slot <= req.asOf.slot))","(FINAL.has(c.check.status) || c.slot >= oldest)"),
 (D,"(FINAL.has(c.check.status) || (c.slot >= oldest && c.slot <= req.asOf.slot))","(c.slot >= oldest && c.slot <= req.asOf.slot)"),
 (D,"mints.every((m) => m.status === 'rug' || m.status === 'clear' || m.status === 'open')","mints.every((m) => m.status !== 'unfetched')"),
 (D,"        this.#day = Number.MAX_SAFE_INTEGER;\n        this.#spent = Number.MAX_SAFE_INTEGER;","        this.#day = -1;\n        this.#spent = 0;"),
 (D,"      this.#save();\n",""),
 (D,"(v['spent'] as number) < 0","false"),
 (B,"+ DEPLOYER_CHECK_CREDITS_PER_DAY) / (24 * 60)",") / (24 * 60)"),
 (B,"    deployerCheckCreditsOnce: RUG_CHECK_CONFIG.creditCapPerCandidate,","    deployerCheckCreditsOnce: 0,"),
 (B,"holderScanCreditsPerDay(HOLDER_SCANS_PER_DAY, a) + DEPLOYER_CHECK_CREDITS_PER_DAY + candidateCapacity","holderScanCreditsPerDay(HOLDER_SCANS_PER_DAY, a) + candidateCapacity"),
 (R,"      covered = r.covered;\n",""),
 (S,"        ...(w.stateDir === undefined ? {} : { spendFile: join(w.stateDir, DEPLOYER_CHECK_SPEND_FILE) }),\n",""),
]
tests=['packages/worker/test/deployer-check.test.ts','packages/worker/test/facts-readers.test.ts','packages/worker/test/facts-source.test.ts']
for i,(f,a,b) in enumerate(M):
    if i not in (11,13,16,21): continue
    s=open(f).read()
    if s.count(a)!=1: print(i,'NOMATCH',a[:50]); continue
    open(f,'w').write(s.replace(a,b))
    r=subprocess.run(['npx','vitest','run',*tests],capture_output=True,text=True)
    open(f,'w').write(s)
    print(i,'KILLED' if r.returncode!=0 else 'SURVIVED',f.split('/')[-1],a[:60].replace('\n',' '),flush=True)
