import subprocess
W='packages/worker/src/run/worker.ts'; G='packages/worker/src/engine/strategy.ts'; P='packages/worker/src/persist/state.ts'; S='packages/worker/src/run/seed-start.ts'
M=[
 (W,"    if (restored.ok) {\n","    if (false) {\n"),
 (W,"      ...(this.#restored === null ? {} : { state: { index: this.#restored.index, labeller: this.#restored.labeller } }),\n",""),
 (W,"    if (now - this.#lastSaveMs >= PERSIST_EVERY_MS) this.#persist(now);\n",""),
 (W,"    if (code === EXIT.clean) this.#persist(d.timers.now());\n",""),
 (G,"    if (asOf === null || !this.#seedApplied || this.#waiting !== null) return null;","    if (asOf === null) return null;"),
 (G,"    if (COVERAGE_FACT.test(e.key)) this.#coverageFacts.push(e);\n",""),
 (G,"      if (COVERAGE_FACT.test(h.key)) this.#coverageFacts.push(h);\n",""),
 (G,"        this.#deployers = index;\n",""),
 (G,"        this.#labeller = labeller;\n",""),
 (G,"    if (this.#lastMoment === null || compareMoments(e.moment, this.#lastMoment) > 0) this.#lastMoment = e.moment;","    this.#lastMoment = e.moment;"),
 (P,"    if (day > this.#day) {","    if (day !== this.#day) {"),
 (P,"      return o['day'] >= day ? new DailyBudget(path, daily, o['day'] as string, o['spent'] as number) : new DailyBudget(path, daily, day, 0);","      return new DailyBudget(path, daily, day, o['day'] === day ? (o['spent'] as number) : 0);"),
 (S,"  o.budget?.spend(cap, now);\n",""),
 (S,"  o.budget?.refund(cap - (p.rpc === null ? 0 : p.rpc.result.creditsUsed), o.timers.now());\n",""),
 (S,"Math.min(SEED_CREDIT_CAP, o.budget.remaining(now))","SEED_CREDIT_CAP"),
]
for i,(f,a,b) in enumerate(M):
    if i not in (6, 8): continue
    s=open(f).read()
    if s.count(a)!=1: print(i,'NOMATCH',a[:50]); continue
    open(f,'w').write(s.replace(a,b))
    r=subprocess.run(['npx','vitest','run','packages/worker/test/persist-worker.test.ts','packages/worker/test/persist.test.ts'],capture_output=True,text=True)
    open(f,'w').write(s)
    print(i,'KILLED' if r.returncode!=0 else 'SURVIVED',f.split('/')[-1],a[:60].replace('\n',' '),flush=True)
