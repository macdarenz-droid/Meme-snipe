cd /home/user/Meme-snipe/research/historical/ci
m(){ f=$1; n=$2; e=$3; cp $f /tmp/claude-0/m4.bak; perl -0pi -e "$e" $f
  if cmp -s $f /tmp/claude-0/m4.bak; then echo "$n NOT APPLIED"; else
  bash test-ci.sh > /tmp/claude-0/m4.out 2>&1; if grep -q "passed, 0 failed" /tmp/claude-0/m4.out; then echo "$n SURVIVED"; else echo "$n killed"; fi; fi
  cp /tmp/claude-0/m4.bak $f; }
m rpc-ledger.sh L1-kill-books-actual 's/actual = max\(actual, 0\) if not notes else reserved/actual = max(actual, 0)/'
m rpc-ledger.sh L2-ignore-outstanding 's/out_all = sum\(int\(o\["amount"\]\) for o in outstanding\)/out_all = 0/'
m rpc-ledger.sh L3-ignore-worker 's/left_period = limit - worker - used - out_all/left_period = limit - used - out_all/'
m rpc-ledger.sh L4-no-locked-flag 's/  locked=1\n//'
m rpc-ledger.sh L5-lock-clobber 's/release upload "\$tag" -- "\$tmp\/ledger.lock"/release upload "\$tag" --clobber -- "\$tmp\/ledger.lock"/'
m rpc-ledger.sh L6-nonfinal-counts 's/u.get\("final"\) is True and //'
m rpc-ledger.sh L7-day-ignore-outstanding 's/out_day = sum\(int\(o\["amount"\]\) for o in outstanding if o\["day"\] == day\)/out_day = 0/'
m rpc-ledger.sh L8-settle-no-lock 's/(settle\)\n.*\n)    lock\n/$1/'
m rpc-ledger.sh L9-push-fail-ok 's/\|\| \{ echo "rpc-ledger: could not write the ledger" >&2; exit 1; \}/|| true/'
m rpc-ledger.sh L10-reserve-no-lock 's/(reserve\)\n.*\n)    lock\n/$1/'
m check-day.sh K1-ignore-scan-spend 's/left=\$\(\( \$\{RPC_RESERVATION:\?\} - spent \)\)/left=\${RPC_RESERVATION:?}/'
m rpc-day.sh D1-no-start-marker 's/: > "\$out\/rpc-started-scan"\n//'
m check-day.sh K2-no-rescan-marker 's/  : > "\$out\/rpc-started-rescan"\n//'
cd /home/user/Meme-snipe && git status --short
