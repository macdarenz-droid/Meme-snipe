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
run $S "compareMoments(m, asOf) > 0 || m.receivedAt > asOf.receivedAt" "compareMoments(m, asOf) > 0" "receipt-time half"
run $S "      if (after(e.moment, asOf)) throw" "      if (false) throw" "load late fact"
run $S "if (!continuing(w.stream, w.via) || [...open.keys()].some((k) => k.startsWith(\`\${sv}|\`))) continue;" "if ([...open.keys()].some((k) => k.startsWith(\`\${sv}|\`))) continue;" "continuing ignored (always gap)"
run $S "      return new DailyBudget(path, daily, day, daily);" "      return new DailyBudget(path, daily, day, 0);" "corrupt budget spends"
run $I "this.#first.receivedAt >= retainFromMs ? this.#first : { ...this.#first, receivedAt: retainFromMs }" "this.#first" "prune start not moved"
run $I "if (ms(v) > asOf.receivedAt) throw" "if (false) throw" "restore late entry"
run $I "for (const m of [idx.#first, idx.#last]) if (m !== null && compareMoments(m, asOf) > 0) throw" "for (const m of [idx.#first, idx.#last]) if (false) throw" "restore late first/last"
run $L "if (s.version !== config.version) throw" "if (false) throw" "labeller version"
run $S "for (const [k] of [...open.keys()].entries()) {}" "x" "noop"
