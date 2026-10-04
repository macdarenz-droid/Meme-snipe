cd /home/user/Meme-snipe
run() { cp "$1" /tmp/mut.bak
  python3 - "$1" "$2" "$3" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read()
assert s.count(a)>=1, "pattern missing: "+a
open(p,'w').write(s.replace(a,b,1))
PY
  if timeout 500 npx vitest run packages/core/test/facts/producer.test.ts packages/worker/test/persist.test.ts packages/worker/test/persist-worker.test.ts >/dev/null 2>&1; then echo "SURVIVED: $4"; else echo "caught: $4"; fi
  cp /tmp/mut.bak "$1"; }
P=packages/core/src/facts/producer.ts; S=packages/worker/src/persist/state.ts
run $P "if (h.migratedAtMs !== i.migratedAtMs || h.reserveAfter !== i.reserveAfter) return;" "if (h.migratedAtMs !== i.migratedAtMs || h.reserveAfter !== i.reserveAfter) continue;" "disagreement half-applies"
run $P "    if (i >= 0) this.#graduates.splice(i, 1);" "" "seeded entry not replaced by live"
run $S "    if (seen.has(i.mint)) throw" "    if (false) throw" "duplicate mint accepted"
run $S "    if (i.migratedAtMs > r.asOfMs) throw" "    if (false) throw" "late migration accepted"
run $S "  if (r.asOfMs !== asOf.receivedAt) throw" "  if (false) throw" "graduates asOf mismatch accepted"
run $S "    if (s.graduates !== undefined) graduatesProblem(s.graduates, asOf, false);" "" "no load check"
