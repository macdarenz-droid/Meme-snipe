import subprocess, sys
M = [
 ("M4 stray dedupe off", "packages/worker/src/run/account.ts", "lamports === 0n || this.#s.strayFees?.[a.signature] !== undefined ||", "lamports === 0n ||"),
 ("M4 fold dedupe off", "packages/worker/src/run/account.ts", " || (folded !== undefined && atMs <= folded.atMs)) continue;", ") continue;"),
 ("M4 failed fee zero", "packages/core/src/fills/settle.ts", "if (outcome !== 'filled' && outcome !== 'failed')", "if (outcome !== 'filled')"),
 ("M4 strays not costs", "packages/worker/src/run/account.ts", "for (const r of Object.values(this.#s.strayFees ?? {})) costs.push", "for (const r of [] as StrayFee[]) costs.push"),
 ("M4 fold ignores unresolved", "packages/worker/src/run/account.ts", "if (sent !== undefined && sent <= before) before = sent - 1;", ""),
 ("M5 exit at entry price", "packages/core/src/fills/settle.ts", "const proceeds = toUsd(t.exitSol, pxOut);", "const proceeds = toUsd(t.exitSol, pxIn);"),
 ("M5 trading at entry price", "packages/core/src/fills/settle.ts", "const trading = toUsd(netLamports, pxOut);", "const trading = toUsd(netLamports, pxIn);"),
 ("M8 rent always back", "packages/core/src/fills/settle.ts", "rentReturned: closed ? rentPaid : 0n", "rentReturned: rentPaid"),
 ("M8 paper no close draw", "packages/worker/src/run/paper-world.ts", "if (!acct.ok) return failed(acct.reason);", ""),
 ("M8 sim leg ignores sell-only", "packages/worker/src/run/paper-world.ts", " && this.#accounts.closes(a.mint, a.inAmount), minContextSlot", ", minContextSlot"),
 ("M8 dust never drawn", "packages/core/src/fills/settle.ts", "if (held === 0n && accountGetsDust(l.dustSeed, s)) this.#sellOnly.add(l.mint);", ""),
 ("unbooked fills counted", "packages/worker/src/run/account.ts", "const counted = (a: PaperAttempt) => a.outcome !== 'filled' || booked.has(a.signature);", "const counted = (_a: PaperAttempt) => true;"),
]
tests = sys.argv[1:]
for name, f, a, b in M:
    s = open(f).read()
    assert s.count(a) == 1, name
    open(f, 'w').write(s.replace(a, b))
    r = subprocess.run(["npx", "vitest", "run", *tests], capture_output=True, text=True, timeout=900)
    out = r.stdout + r.stderr
    line = [l for l in out.splitlines() if l.strip().startswith("Tests ")]
    print(f"{name}: {'KILLED' if r.returncode != 0 else 'SURVIVED'} {line[-1].strip() if line else ''}", flush=True)
    subprocess.run(["git", "checkout", "-q", "--", f])
