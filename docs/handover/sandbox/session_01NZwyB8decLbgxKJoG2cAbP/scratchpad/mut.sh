cd /home/user/Meme-snipe
run() { # file, from, to, label
  cp "$1" /tmp/mut.bak
  python3 - "$1" "$2" "$3" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read()
assert s.count(a)>=1, "pattern missing: "+a
open(p,'w').write(s.replace(a,b,1))
PY
  if npx vitest run packages/worker/test/seed.test.ts packages/core/test/gates/deployer-index.test.ts >/dev/null 2>&1; then echo "SURVIVED: $4"; else echo "caught: $4"; fi
  cp /tmp/mut.bak "$1"
}
R=packages/worker/src/seed/rpc.ts; S=packages/worker/src/seed/seed.ts; D=packages/worker/src/seed/days.ts; I=packages/core/src/gates/deployer-index.ts
run $R "if (s.slot > o.untilSlot) {" "if (s.slot > o.untilSlot + 1n) {" "rpc future drop off by one"
run $R "          owedTo = s.slot;" "" "owedTo not advanced"
run $R "gaps.push({ fromSlot: s.slot, toSlot: s.slot" "void ({ fromSlot: s.slot, toSlot: s.slot" "per-tx gap dropped"
run $R "if (credits + o.cost[method] > o.creditCap)" "if (false)" "no credit cap"
run $R "throw new Stop('halted'" "if (false) throw new Stop('halted'" "halt not stop"
run $R "if (s.err !== null) continue;" "" "failed tx fetched"
run $R "else if (r.slot !== s.slot)" "else if (false)" "slot mismatch ignored"
run $S "e.moment.slot > o.untilSlot || e.moment.receivedAt > nowMs" "e.moment.slot > o.untilSlot" "keep: time leak guard"
run $S "atMs: Math.max(last.atMs, g.atMs)" "atMs: Math.min(last.atMs, g.atMs)" "merge dates earlier"
run $S "ms > nowMs ? nowMs : ms" "ms" "clamp future"
run $S "if (next !== undefined && next.fromSlot > u.toSlot + 1n)" "if (false)" "inter-unit hole"
run $S "if (prev === undefined || (prev.covered && !u.covered))" "if (prev === undefined)" "dup unit gap wins"
run $D "if (got !== want)" "if (false)" "checksum skipped"
run $D "const defect = u.events === undefined ? 'no events file' : unitDefect(s);" "const defect = null;" "unit defects ignored"
run $D "if (slot > toSlot || blockTimeMs >= BOUNDARY_MS) continue;" "" "boundary creates kept"
run $I "if (late(e)) throw" "if (false) throw" "index seed late create"
run $I "if (c.createdAtMs > asOf.receivedAt) throw" "if (false) throw" "index chain time"
run $I "this.#first = start;" "" "index start not set"
