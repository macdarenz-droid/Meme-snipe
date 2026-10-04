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
run $F "r.stoppedBy === 'done' && r.gaps.length === 0 &&" "r.stoppedBy === 'done' &&" "complete ignores tx gaps"
run $F "Math.min(gap.fromMs, live.receivedAt - 1)" "Math.min(gap.fromMs, live.receivedAt)" "no -1ms"
run $F ".filter((e) => compareMoments(e.moment, o.asOf) <= 0)]" "]" "close after asOf kept"
run $F "compareMoments(e.moment, o.asOf) <= 0 && e.moment.receivedAt <= o.asOf.receivedAt" "true" "asOf event filter"
run $F "&& events.length === read.length" "" "held-back events still complete"
run $F "if (m !== undefined && compareMoments(m, o.asOf) > 0) throw" "if (false) throw" "as-of guard"
run $F "const last = gap.untilSlot - 1n;" "const last = gap.untilSlot;" "last = untilSlot"
run $W "if (epoch !== this.#epoch || w.gap !== g || g.fill !== 'running') return;" "if (w.gap !== g) return;" "epoch ignored"
run $W "        g.lossy = !complete;" "" "lossy not set"
run $W "w.gap.fill = 'no'; // a fill" "// w.gap.fill = 'no'; // a fill" "fill not reset on drop"
run $F "if (gap.fromSlot === null) return false;" "if (gap.fromSlot === null) return true;" "null start true"
