cd /tmp/claude-0/-home-user-Meme-snipe/2bf2916e-dcdc-547a-9cc9-f3ceeaba1e6f/scratchpad/bt || exit 1
git checkout -q -- .
EV=packages/core/src/gates/evidence.ts; SC=packages/backtest/src/study/score.ts; ST=packages/backtest/src/study/study.ts; MK=packages/backtest/src/sim/market.ts; WS=packages/worker/src/engine/strategy.ts
mut(){ perl -0pi -e "$2" $3; if git diff --quiet -- $3; then echo "$1 NOT APPLIED"; return; fi; echo "$1: $(npx vitest run $4 2>&1 | grep -E 'Tests +[0-9]|failed' | head -3 | tr '\n' ' ')"; git checkout -q -- $3; }
mut E1-use-now 's/const behind = tip - obs\.slot/const behind = now.slot - obs.slot/' $EV "packages/core/test/gates packages/backtest/test/replay.test.ts packages/worker/test/observed-tip.test.ts"
mut E2-no-clamp 's/this\.#ctx\.observedTip < now\.slot \? this\.#ctx\.observedTip : now\.slot/this.#ctx.observedTip/' $EV "packages/core/test/gates packages/worker/test/observed-tip.test.ts"
mut E3-stream-now 's/const behind = tip - head/const behind = now.slot - head/' $EV "packages/core/test/gates packages/backtest/test/replay.test.ts"
mut F1-ignore-complete 's/dev\.complete && //' $SC "packages/backtest/test/study.test.ts packages/backtest/test/full-study.test.ts packages/backtest/test/registry.test.ts"
mut F2-any-wallet 's/x\.wallet === r\.creator/true/' $SC "packages/backtest/test/study.test.ts packages/backtest/test/full-study.test.ts packages/backtest/test/registry.test.ts"
mut R1-register-unsized 's/ && unsized\.length === 0\)/)/' $ST "packages/backtest/test/registry.test.ts packages/backtest/test/full-study.test.ts packages/backtest/test/study.test.ts"
mut M1-tip-batch-max 's/if \(e\.moment\.slot > this\.#tip\) \{/if (batch.length > 0 \&\& batch[batch.length - 1]!.e.moment.slot > this.#tip) { this.#tip = batch[batch.length - 1]!.e.moment.slot;/' $MK "packages/backtest/test/replay.test.ts packages/backtest/test/study.test.ts packages/backtest/test/parity.test.ts"
mut W1-live-tip-plus 's/observedTip: ctx\.now\.slot \}/observedTip: ctx.now.slot - 50n }/' $WS "packages/worker/test/observed-tip.test.ts"
git status --short | head -3
echo "DONE $(TZ=Australia/Melbourne date +%H:%M)"
