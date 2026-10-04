cd /home/user/Meme-snipe
run() { cp "$1" /tmp/mut.bak
  python3 - "$1" "$2" "$3" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read()
assert s.count(a)>=1, "pattern missing: "+a
open(p,'w').write(s.replace(a,b,1))
PY
  if npx vitest run packages/worker/test/persist.test.ts packages/core/test/gates >/dev/null 2>&1; then echo "SURVIVED: $4"; else echo "caught: $4"; fi
  cp /tmp/mut.bak "$1"; }
S=packages/worker/src/persist/state.ts; I=packages/core/src/gates/deployer-index.ts; L=packages/core/src/gates/rug-labeller.ts
run $S "if (w.via === SEED_VIA || [...open" "if (!continuing(w.stream, w.via) || w.via === SEED_VIA || [...open" "gap only for continuing"
run $S "if (continuing(w.stream, w.via)) fills.push" "fills.push" "fill plan ignores continuing"
run $I "(compareMoments(m, asOf) > 0 || m.receivedAt > asOf.receivedAt)" "(compareMoments(m, asOf) > 0)" "first/last receipt time"
run $I "for (const m of [idx.#first, idx.#last]) {
      if (m !== null &&" "for (const m of [idx.#first, idx.#last]) {
      if (false &&" "first/last check"
run $L "if (asOf !== undefined && (l['createdAtMs'] as number) > asOf.receivedAt) throw" "if (false) throw" "launch after asOf"
run $S "RugLabeller.restore(rugs, s.labeller, asOf)" "RugLabeller.restore(rugs, s.labeller)" "asOf not passed"
