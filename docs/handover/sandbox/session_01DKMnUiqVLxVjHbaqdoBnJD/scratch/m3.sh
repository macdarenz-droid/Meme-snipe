cd /home/user/Meme-snipe/research/historical/ci
m(){ f=$1; n=$2; e=$3; cp $f /tmp/claude-0/m.bak; perl -0pi -e "$e" $f
  if cmp -s $f /tmp/claude-0/m.bak; then echo "$n NOT APPLIED"; else
  bash test-ci.sh > /tmp/claude-0/m.out 2>&1; if grep -q "passed, 0 failed" /tmp/claude-0/m.out; then echo "$n SURVIVED"; else echo "$n killed: $(grep '^no' /tmp/claude-0/m.out | head -2 | cut -c1-90 | tr '\n' '|')"; fi; fi
  cp /tmp/claude-0/m.bak $f; }
bash test-ci.sh 2>&1 | tail -1
m rpc-day.sh r1-ignore-used 's/left_credits=\$\(\( cap - used \)\)/left_credits=\$cap/'
m rpc-day.sh r2-no-early-stop 's/if \[ "\$left_credits" -le 0 \]/if false/'
m rpc-day.sh r3-no-add 's/"\$here\/rpc-credits.sh" add "\$out" "\$out\/rpc-usage-run.json"\n//'
m rpc-day.sh r4-no-rm-usage 's/rm -f "\$out\/rpc-usage-run.json"\n//'
m rpc-day.sh r5-keep-old-rev 's/rm -rf "\$\(dirname "\$st"\)"/:/'
m rpc-day.sh r6-budget-exit1 's/progress kept for the next run" \| tee -a "\$summary"\n  exit 75/progress kept" | tee -a "\$summary"\n  exit 1/'
m rpc-day.sh r7-rc3-as-75 's/\[ "\$rc" -ne 3 \]/true/'
m rpc-credits.sh c1-no-sum 's/\$\(\( cur \+ n \)\)/\$(( n ))/'
m rpc-credits.sh c2-malformed-ok 's/\{ echo "rpc-credits: no credits in \$3" >&2; exit 1; \}/exit 0/'
m check-day.sh k1-full-cap 's/-max-credits \$\(\( RPC_CREDIT_CAP - used \)\)/-max-credits \$RPC_CREDIT_CAP/'
m check-day.sh k2-no-add 's/  "\$here\/rpc-credits.sh" add "\$out" "\$again\/rpc-usage.json"\n//'
m check-day.sh k3-no-precheck 's/\[ \$\(\( \$\{RPC_CREDIT_CAP:\?\} - used \)\) -gt 0 \] \|\|/true ||/'
m check-day.sh k4-rc3-as-1 's/elif \[ "\$rc" -eq 3 \] && \[ "\$\{SOURCE:-archive\}" = helius \]; then/elif false; then/'
m check-day.sh k5-archive-path-rpc 's/if \[ "\$\{SOURCE:-archive\}" = helius \]; then\n  # A day read/if true; then\n  # A day read/'
cd /home/user/Meme-snipe && git status --short
