cd /home/user/Meme-snipe
run() { cp "$1" /tmp/mut.bak
  python3 - "$1" "$2" "$3" <<'PY'
import sys; p,a,b=sys.argv[1:]; s=open(p).read()
assert s.count(a)>=1, "pattern missing: "+a
open(p,'w').write(s.replace(a,b,1))
PY
  if timeout 500 npx vitest run packages/worker/test/boundary-marks.test.ts packages/worker/test/account-marks.test.ts >/dev/null 2>&1; then echo "SURVIVED: $4"; else echo "caught: $4"; fi
  cp /tmp/mut.bak "$1"; }
W=packages/worker/src/run/worker.ts; A=packages/worker/src/run/account.ts
run $W "this.#account.mark(snapshot, marked," "this.#account.mark(snapshot, true," "marked ignored"
run $W "      account, latches: fact.latches," "      account: fact.history, latches: fact.latches," "raw history"
run $W " && now - o.markAtMs <= maxAge" "" "freshness ignored"
run $W "o.markAtMs <= now && " "" "future mark accepted"
run $A "if (marked && this.#s.dayMark?.startMs" "if (this.#s.dayMark?.startMs" "day not gated"
run $A "if (marked && this.#s.weekMark?.startMs" "if (this.#s.weekMark?.startMs" "week not gated"
