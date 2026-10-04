cd /home/user/rv3
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
run cost0 $M 'exitCost: n.signaturesPerTx * n.baseFeePerSignature + last.priorityFeeLamports + n.tip,' 'exitCost: 0n,'
run no-fee $M '+ last.priorityFeeLamports + n.tip' '+ n.tip'
run no-tip $M '+ last.priorityFeeLamports + n.tip' '+ last.priorityFeeLamports'
run no-sigs $M 'n.signaturesPerTx * n.baseFeePerSignature + ' ''
run maxage $M 'maxAgeMs: policy.gates.maxQuoteAgeMs }' 'maxAgeMs: 1e12 }'
run sol-fresh $M '!fresh(sol.atMs, nowMs, s.maxAgeMs) || ' ''
run sol-fresh-future $M 'const fresh = (atMs: number, nowMs: number, maxAgeMs: number): boolean => atMs <= nowMs && ' 'const fresh = (atMs: number, nowMs: number, maxAgeMs: number): boolean => '
run fallback-rethrow $M '  } catch {
    return h;' '  } catch (e) {
    throw e;'
run exit-nofallback $S "this.#marked(risk.history, ctx, sol, { fallback: true })" "this.#marked(risk.history, ctx, sol, { fallback: false })"
run exit-unmarked $S "const account = this.#marked(risk.history, ctx, sol, { fallback: true });" "const account = risk.history;"
run entry-unmarked $S "account: this.#marked(acct.history, ctx, sol, { fallback: false })" "account: acct.history"
run mark-log $S 'why.push(`${MARK_PREFIX}${own.mark ?? '"'"'unknown'"'"'}`)' 'void 0'
