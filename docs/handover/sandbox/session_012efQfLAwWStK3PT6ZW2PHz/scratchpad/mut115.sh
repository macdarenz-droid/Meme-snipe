cd /tmp/claude-0/-home-user-Meme-snipe/2bf2916e-dcdc-547a-9cc9-f3ceeaba1e6f/scratchpad/bt || exit 1
pnpm install --frozen-lockfile >/dev/null 2>&1
OC=packages/backtest/src/research/outcome.ts; T=packages/backtest/test/edge.test.ts
mut(){ perl -0pi -e "$2" $3; if git diff --quiet -- $3; then echo "$1 NOT APPLIED"; return; fi; echo "$1: $(npx vitest run $T 2>&1 | grep -E 'Tests +[0-9]|×' | tr '\n' ' ')"; git checkout -q -- $3; }
echo "base: $(npx vitest run $T 2>&1 | grep -E 'Tests +[0-9]')"
mut A-failed-rung1 's/ladder\.steps\[Math\.min\(2, ladder\.steps\.length - 1\)\]!\.priorityFeeLamports;/ladder.steps[0]!.priorityFeeLamports;/' $OC
mut B-no-failclose 's/ - \(!p\.dust && !p\.closes \? failedExit : 0n\)//' $OC
mut C-ignore-dust 's/p\.closes = !p\.dust && closeSucceeds/p.closes = closeSucceeds/' $OC
mut D-rent-always 's/\(p\.closes \? rent : 0n\)/rent/' $OC
mut E-no-tip-exit 's/const exitFixed = base \+ ladder\.steps\[0\]!\.priorityFeeLamports \+ net\.tip;/const exitFixed = base + ladder.steps[0]!.priorityFeeLamports;/' $OC
git status --short | head -3
echo "DONE $(TZ=Australia/Melbourne date +%H:%M)"
