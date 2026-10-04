cd /home/user/Meme-snipe
run() { cp "$1" /tmp/mut.bak
  python3 - "$1" "$2" "$3" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read()
assert s.count(a)>=1, "pattern missing: "+a
open(p,'w').write(s.replace(a,b,1))
PY
  if npx vitest run packages/worker/test/fill.test.ts packages/worker/test/seed.test.ts packages/worker/test/streams.test.ts >/dev/null 2>&1; then echo "SURVIVED: $4"; else echo "caught: $4"; fi
  cp /tmp/mut.bak "$1"; }
F=packages/worker/src/seed/fill.ts; W=packages/worker/src/providers/solana-ws.ts
run $F "const first = gap.close.fromSlot !== null && gap.close.fromSlot < gap.fromSlot ? gap.close.fromSlot : gap.fromSlot;" "const first = gap.fromSlot;" "first ignores close.fromSlot"
run $F "1)].filter((e) => compareMoments(e.moment, o.asOf) <= 0)" "1)]" "close after asOf kept"
run $F "if (gap.close.at !== undefined && compareMoments(gap.close.at, moment) >= 0)" "if (false)" "close.at follow"
run $F "else if (spent >= o.creditCap) stoppedBy = 'skipped-no-budget';" "" "budget skip"
