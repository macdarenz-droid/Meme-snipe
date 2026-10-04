cd /home/user/rv4
run() { name="$1"; file="$2"; from="$3"; to="$4"
  cp "$file" /tmp/claude-0/bak
  python3 - "$file" "$from" "$to" <<'P' || { echo "$name: PATCH-FAIL"; return; }
import sys; f,a,b=sys.argv[1:]; s=open(f).read()
assert s.count(a)==1, ("count",s.count(a)); open(f,'w').write(s.replace(a,b))
P
  out=$(timeout 300 npx vitest run packages/worker/test/marks.test.ts packages/worker/test/position-market.test.ts 2>&1 | grep -E "Tests ")
  echo "$name: $out"; cp /tmp/claude-0/bak "$file"; }
M=packages/worker/src/engine/marks.ts; S=packages/worker/src/engine/strategy.ts
run first-rung $M 'steps.at(-1)!' 'steps[0]!'
run slip0 $M 'slippageBps: last.minOutBelowTriggerBps,' 'slippageBps: 0,'
run entry-no-catch $S "    try {
      account = this.#marked(acct.history, ctx, sol, { fallback: false });
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'error';
      return this.#fail(\`risk mark failed: \${detail}\`, [{ gate: 'worker', code: 'risk-mark-failed', detail }]);
    }" "    account = this.#marked(acct.history, ctx, sol, { fallback: false });"
run exit-nofallback $S "this.#marked(risk.history, ctx, sol, { fallback: true })" "this.#marked(risk.history, ctx, sol, { fallback: false })"
run seam-ignored $S "{ ...o, ...(this.#d.markedHistory === undefined ? {} : { mark: this.#d.markedHistory }) }" "o"
run entry-fallback $S "account = this.#marked(acct.history, ctx, sol, { fallback: false });" "account = this.#marked(acct.history, ctx, sol, { fallback: true });"
run first-rung $M 'steps.at(-1)!' 'steps[0]!'
run sol-fresh $M '!fresh(sol.atMs, nowMs, s.maxAgeMs) || ' ''
run exit-unmarked $S "const account = this.#marked(risk.history, ctx, sol, { fallback: true });" "const account = risk.history;"
