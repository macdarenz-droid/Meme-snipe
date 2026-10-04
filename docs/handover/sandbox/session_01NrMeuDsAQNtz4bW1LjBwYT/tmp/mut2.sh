source <(sed -n '3,12p' /tmp/claude-0/mut.sh)
S=packages/worker/src/engine/strategy.ts
run entry-unmarked $S 'account: this.#marked(acct.history, ctx, sol), latches: acct.latches' 'account: acct.history, latches: acct.latches'
run slip-source $S 'slippageBps: step.minOutBelowTriggerBps,' 'slippageBps: 0,'
run exitcost-zero $S 'exitCost: n.signaturesPerTx * n.baseFeePerSignature + step.priorityFeeLamports + n.tip,' 'exitCost: 0n,'
run maxage-source $S 'maxAgeMs: policy.gates.maxQuoteAgeMs,' 'maxAgeMs: 1e12,'
