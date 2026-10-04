cd /home/user/Meme-snipe
run() { cp "$1" /tmp/mut.bak
  python3 - "$1" "$2" "$3" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read()
assert s.count(a)>=1, "pattern missing: "+a
open(p,'w').write(s.replace(a,b,1))
PY
  if timeout 500 npx vitest run packages/worker/test/persist-worker.test.ts packages/worker/test/persist.test.ts >/dev/null 2>&1; then echo "SURVIVED: $4"; else echo "caught: $4"; fi
  cp /tmp/mut.bak "$1"; }
S=packages/worker/src/engine/strategy.ts; W=packages/worker/src/run/worker.ts; R=packages/worker/src/run/seed-start.ts
run $S "if (asOf === null || !this.#seedApplied || this.#waiting !== null) return null;" "if (asOf === null) return null;" "save before seed"
run $W "    if (code === EXIT.clean) this.#persist(d.timers.now());" "" "no save at clean stop"
run $W "      ...(this.#restored === null ? {} : { state: { index: this.#restored.index, labeller: this.#restored.labeller } })," "" "state not in seed fact"
run $S "        this.#labeller = labeller;" "" "labeller not restored"
run $R "  o.budget?.spend(cap, now);" "" "no reserve"
run $R "  o.budget?.refund(cap - (p.rpc === null ? 0 : p.rpc.result.creditsUsed), o.timers.now());" "" "no refund"
run $R "Math.min(SEED_CREDIT_CAP, o.budget.remaining(now))" "SEED_CREDIT_CAP" "cap ignores remaining"
run $W "    if (now - this.#lastSaveMs >= PERSIST_EVERY_MS) this.#persist(now);" "" "no periodic save"
run $S "    if (COVERAGE_FACT.test(e.key)) this.#coverageFacts.push(e);" "" "live coverage not kept"
run $S "      if (COVERAGE_FACT.test(h.key)) this.#coverageFacts.push(h);" "" "seed history coverage not kept"
