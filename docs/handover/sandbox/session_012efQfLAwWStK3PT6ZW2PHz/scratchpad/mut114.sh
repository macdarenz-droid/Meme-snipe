cd /tmp/claude-0/-home-user-Meme-snipe/2bf2916e-dcdc-547a-9cc9-f3ceeaba1e6f/scratchpad/bt || exit 1
git checkout -q -- .
OC=packages/backtest/src/research/outcome.ts; TR=packages/backtest/src/trades.ts
mut(){ perl -0pi -e "$2" $3; if git diff --quiet -- $3; then echo "$1 NOT APPLIED"; return; fi; echo "$1: $(npx vitest run $4 -t "$5" 2>&1 | grep -E 'Tests +[0-9]')"; git checkout -q -- $3; }
echo "base-research: $(npx vitest run packages/backtest/test/research.test.ts -t 'outcome stage' 2>&1 | grep -E 'Tests +[0-9]')"
echo "base-run-rent: $(npx vitest run packages/backtest/test/run.test.ts -t 'rent' 2>&1 | grep -E 'Tests +[0-9]')"
mut O1-always-rent 's/\(p\.closes \? rent : 0n\)/rent/' $OC packages/backtest/test/research.test.ts "outcome stage"
mut O2-no-failfee 's/ - \(!p\.dust && !p\.closes \? failedExit : 0n\)//' $OC packages/backtest/test/research.test.ts "outcome stage"
mut O3-ignore-dust 's/p\.closes = !p\.dust && closeSucceeds/p.closes = closeSucceeds/' $OC packages/backtest/test/research.test.ts "outcome stage"
mut O4-scenario-seed 's/accountGetsDust\(`\$\{o\.seed\}:\$\{p\.t\.id\}`, scen\)/accountGetsDust(`\${o.seed}:\${o.scenario}:\${p.t.id}`, scen)/; s/closeSucceeds\(`\$\{o\.seed\}:\$\{p\.t\.id\}`, scen\)/closeSucceeds(`\${o.seed}:\${o.scenario}:\${p.t.id}`, scen)/' $OC packages/backtest/test/research.test.ts "outcome stage"
mut T1-always-rent 's/firstOfEntry && closedEntries\.has\(p\.entryIntentId\) \? rentPaid/firstOfEntry ? rentPaid/' $TR packages/backtest/test/run.test.ts "rent"
mut T2-twice 's/firstOfEntry && closedEntries/closedEntries/' $TR packages/backtest/test/run.test.ts "rent"
git status --short | head -3
echo "DONE $(TZ=Australia/Melbourne date +%H:%M)"
