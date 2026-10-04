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
F=packages/worker/src/seed/fill.ts; S=packages/worker/src/seed/seed.ts; R=packages/worker/src/seed/rpc.ts
run $F "Math.min(gap.fromMs, live.receivedAt - 1)" "Math.min(gap.fromMs, live.receivedAt)" "fill no -1ms"
run $S "Math.min(o.fill.fromMs, live.receivedAt - 1)" "Math.min(o.fill.fromMs, live.receivedAt)" "seed no -1ms"
run $R "if (o.maxPages !== undefined && calls.getSignaturesForAddress >= o.maxPages) throw" "if (false) throw" "page cap"
run $F "priority: gap.kind === 'position' ? P2 : P3" "priority: gap.kind === 'position' ? 1 : P3" "position at P1"
