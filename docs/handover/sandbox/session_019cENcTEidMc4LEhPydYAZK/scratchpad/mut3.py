import subprocess
S='packages/worker/src/facts/source.ts'
M=[
 (S,"if (w !== undefined && this.#readers?.readChainVolume !== undefined) this.#run","if (false) this.#run"),
 (S,"if (w !== undefined && this.#readers?.readChainVolume !== undefined)","if (this.#readers?.readChainVolume !== undefined)"),
 (S,"      ...(w.github === undefined ? {} : { releases: { scheduler: w.github } }),\n",""),
 (S,"    ...(w.github === undefined ? {} : { chainVolume: { volumeLagDays: w.policy.regime.volumeLagDays, volumeWindowDays: w.policy.regime.volumeWindowDays } }),\n",""),
 (S,"volumeLagDays: w.policy.regime.volumeLagDays,","volumeLagDays: 0,"),
]
for i,(f,a,b) in enumerate(M):
    s=open(f).read()
    if s.count(a)!=1: print(i,'NOMATCH'); continue
    open(f,'w').write(s.replace(a,b))
    r=subprocess.run(['npx','vitest','run','packages/worker/test/facts-source.test.ts'],capture_output=True,text=True)
    open(f,'w').write(s)
    print(i,'KILLED' if r.returncode!=0 else 'SURVIVED',flush=True)
