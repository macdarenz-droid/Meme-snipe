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
R=packages/worker/src/seed/rpc.ts; S=packages/worker/src/seed/seed.ts; D=packages/worker/src/seed/days.ts
run $R "if (s.slot > o.untilSlot) {" "if (s.slot > o.untilSlot + 1n) {" "rpc future drop off by one"
run $R "else if (r.slot !== s.slot)" "else if (false)" "slot mismatch ignored"
run $S "e.moment.slot > o.untilSlot || e.moment.receivedAt > nowMs" "e.moment.slot > o.untilSlot" "keep: time leak guard"
run $S "if (prev === undefined || (prev.covered && !u.covered))" "if (prev === undefined)" "dup unit gap wins"
run $R "if (page.length < SIGNATURE_PAGE) throw" "if (false) throw" "history-end"
run $R "{ limit: SIGNATURE_PAGE, minContextSlot: o.untilSlot }" "{ limit: SIGNATURE_PAGE }" "minContextSlot"
run $R "if (first && notConfirmedYet(e))" "if (false)" "not-confirmed reason"
run $D "  checkReports(dir, day);" "" "QA/parity gate"
run $D "if (parity['mismatch_count'] !== 0 ||" "if (" "parity mismatch"
run $S "fact('resume', o.untilSlot" "fact('gap', o.untilSlot" "resume vs gap"
run $S "merged.length === 0" "true" "incomplete fill resumes"
run $S "if (start === null && o.fill === undefined)" "if (start === null)" "fill makes start"
