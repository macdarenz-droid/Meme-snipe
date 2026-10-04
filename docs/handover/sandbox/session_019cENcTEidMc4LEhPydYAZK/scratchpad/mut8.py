import subprocess
D='packages/worker/src/facts/deployer-checks.ts'
M=[
 (D,"    if (day > this.#day) {","    if (day !== this.#day) {"),
 (D,"if (c !== undefined && c.slot <= req.asOf.slot && (FINAL.has(c.check.status) || c.slot >= oldest)) return c.check;","if (c !== undefined && (FINAL.has(c.check.status) || (c.slot >= oldest && c.slot <= req.asOf.slot))) return c.check;"),
 (D,"    const run = prev.catch(() => undefined).then(() => this.#checkNow(req, nowMs));","    const run = this.#checkNow(req, nowMs);"),
 (D,"      this.#spent += reserve;\n      this.#save();\n","      this.#spent += reserve;\n"),
 (D,"      this.#spent -= reserve - credits;\n","      this.#spent -= 0;\n"),
 (D,"      if (this.#inflight.get(req.creator) === run) this.#inflight.delete(req.creator);\n",""),
]
for i,(f,a,b) in enumerate(M):
    if i != 5: continue
    s=open(f).read()
    if s.count(a)!=1: print(i,'NOMATCH',a[:50]); continue
    open(f,'w').write(s.replace(a,b))
    r=subprocess.run(['npx','vitest','run','packages/worker/test/deployer-check.test.ts'],capture_output=True,text=True)
    open(f,'w').write(s)
    print(i,'KILLED' if r.returncode!=0 else 'SURVIVED',a[:70].replace('\n',' '),flush=True)
