import subprocess,sys
E='packages/core/src/risk/evaluate.ts'; A='packages/worker/src/run/account.ts'; W='packages/worker/src/run/worker.ts'; O='packages/worker/src/run/open-positions.ts'
R='packages/runner/src/runner.ts'; S='packages/worker/src/facts/source.ts'; F='packages/worker/src/facts/readers.ts'; G='packages/worker/src/engine/strategy.ts'
M=[
 (E,"dayChange === null ? 0n : -dayChange","0n"),
 (E,"weekChange === null ? 0n : -weekChange","0n"),
 (E,"const dayChange = a.markedAtDayStart === null ? null : equity - a.markedAtDayStart - atDay.flowsSince;","const dayChange = a.markedAtDayStart === null ? null : equity - a.markedAtDayStart;"),
 (E,"const weekChange = a.markedAtWeekStart === null ? null : equity - a.markedAtWeekStart - atWeek.flowsSince;","const weekChange = a.markedAtWeekStart === null ? null : equity - a.markedAtWeekStart;"),
 (A,"if (this.#s.dayMark?.startMs !== s.dayStartMs) {","if (this.#s.dayMark === undefined) {"),
 (A,"if (this.#s.weekMark?.startMs !== s.weekStartMs) {","if (this.#s.weekMark === undefined) {"),
 (A,"const stale = peak !== undefined && rearmAtMs !== null && peak.atMs < rearmAtMs;","const stale = false;"),
 (A,"(peak === undefined || stale || s.nav > peak.nav)","(peak === undefined || stale || s.nav >= peak.nav || true)"),
 (A,"s.nav !== null && s.nav > 0n && ","s.nav !== null && "),
 (A,"    if (changed) this.#file.write(this.#s);\n",""),
 (A,"this.#s.dayMark.startMs === melbourneDay(nowMs).start ? this.#s.dayMark.equity : null","this.#s.dayMark.equity"),
 (A,"this.#s.weekMark.startMs === melbourneWeek(nowMs).start ? this.#s.weekMark.equity : null","this.#s.weekMark.equity"),
 (A,"this.#s.navPeak === undefined || this.#s.navPeak.atMs > nowMs ? []","this.#s.navPeak === undefined ? []"),
 (A,"navMarks: this.#s.navPeak === undefined || this.#s.navPeak.atMs > nowMs ? [] : [{ atMs: this.#s.navPeak.atMs, nav: this.#s.navPeak.nav }],","navMarks: [],"),
 (W,"    this.#markAccount(now);\n",""),
 (W,"    if (!this.#reconciled) return;\n    const fact","    const fact"),
 (W,"      this.#publishAccount();\n    }\n  }\n\n  #afterRecord","    }\n  }\n\n  #afterRecord"),
 (O,"x.status !== 'closed' && x.status !== 'opening'","x.status !== 'closed'"),
 (O,"at(a.id) - at(b.id) || ","") ,
 (O,"plan === null ? 'unknown' : plan.universe","'U2'"),
 (W,"      open_positions: positions,","      open_positions: positions.slice(0, 1),"),
 (R,"Array.isArray(h.open_positions) ? h.open_positions : ",""),
 (R,"openPositions(h).every((p) => knownUniverse(p.universe));","(h.open_position === null || knownUniverse(h.open_position.universe));"),
 (R,"openPositions(h).every((p) => id(p.trade))","(h.open_position === null || id(h.open_position.trade))"),
 (S,"g.neededBy === 'H14' && ",""),
 (S,"g.detail?.startsWith(DEPLOYER_CHECK_DETAIL) === true","true"),
 (S,"g.code === 'not-covered' && g.neededBy","g.neededBy"),
 (S,".filter((m) => m.mint !== mint && m.createdAtMs >= fromMs)",".filter((m) => m.createdAtMs >= fromMs)"),
 (S,".filter((m) => m.mint !== mint && m.createdAtMs >= fromMs)",".filter((m) => m.mint !== mint)"),
 (S,"if (ctx === null || tip === null || creator === null ||","if (ctx === null || tip === null ||"),
 (S,"if (ctx === null || tip === null || creator === null ||","if (ctx === null || creator === null ||"),
 (S,"    deployerCheck: { lookbackMs: w.policy.gates.deployerRugLookbackDays * DAY_MS, rugs: RUG_CONFIG },\n",""),
 (F,"full = r.fact.mints.every((m) => m.status === 'rug' || m.status === 'clear' || m.status === 'open');","full = true;"),
 (F,"      for (const f of checkFacts(r)) this.#ingest('helius', f.key, f.value);\n",""),
 (G,"      if (cf !== null) cand.creator = cf.creator;\n",""),
 (G,"...(x.neededBy === undefined ? {} : { neededBy: x.neededBy }),",""),
 (W,"        priorMints: (creator, nowMs) =>","        priorMintsX: (creator, nowMs) =>"),
]
only=[int(x) for x in sys.argv[1:]]
tests=['packages/core/test/risk','packages/worker/test/account-marks.test.ts','packages/worker/test/open-positions.test.ts','packages/worker/test/run1c.test.ts','packages/runner/test','packages/worker/test/facts-source.test.ts','packages/worker/test/deployer-check.test.ts']
for i,(f,a,b) in enumerate(M):
    if only and i not in only: continue
    s=open(f).read()
    if s.count(a)!=1: print(i,'NOMATCH',a[:50]); continue
    open(f,'w').write(s.replace(a,b))
    r=subprocess.run(['npx','vitest','run',*tests],capture_output=True,text=True)
    open(f,'w').write(s)
    print(i,'KILLED' if r.returncode!=0 else 'SURVIVED',f.split('/')[-1],a[:60].replace('\n',' '),flush=True)
