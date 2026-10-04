cd /home/user/Meme-snipe
run() { cp "$1" /tmp/mut.bak
  python3 - "$1" "$2" "$3" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read()
assert s.count(a)>=1, "pattern missing: "+a
open(p,'w').write(s.replace(a,b,1))
PY
  if npx vitest run packages/worker/test/parity.test.ts >/dev/null 2>&1; then echo "SURVIVED: $4"; else echo "caught: $4"; fi
  cp /tmp/mut.bak "$1"; }
P=packages/worker/src/run/parity.ts
run $P "b.missing === null && b.deterministic" "b.deterministic" "missing ignored"
run $P " && b.redactions === 0" "" "redactions ignored"
run $P " && (b.excluded['ledger_refused'] ?? 0) === 0" "" "ledger_refused ignored"
run $P "const missing = j.seed === undefined ? 'no seed' : !existsSync(dir) ? 'no recording' : null;" "const missing = !existsSync(dir) ? 'no recording' : null;" "no seed not flagged"
run $P "const missing = j.seed === undefined ? 'no seed' : !existsSync(dir) ? 'no recording' : null;" "const missing = j.seed === undefined ? 'no seed' : null;" "no recording not flagged"
run $P "if (live.length === 0 && Object.keys(excluded).length === 0) continue;" "if (live.length === 0) continue;" "excluded-only boot skipped"
