#!/usr/bin/env bash
# Dry run of stepa.sh against a local fake Helius (no network, a canary key): the plan's
# boundaries, the 2026-09-12 clip (no getBlock at or after the first 09-12 slot), per-unit
# identity, decode and resume. The fake has one block per unit (the testdata block).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); root=$(cd "$here/../.." && pwd)
T=$(mktemp -d); trap 'kill $fpid 2>/dev/null; rm -rf "$T"' EXIT
cat > "$T/fake.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
t11 = 1789084800; s0 = 446014935          # 2026-09-11T00:00Z and stepa's estimate for it
def tm(s): return t11 + (s - s0 - 500) * 2 // 5   # 0.4 s a slot
block = open(sys.argv[2], 'rb').read()
log = open(sys.argv[3], 'a')
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        assert self.path.endswith('api-key=CANARY-stepa'), self.path
        req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        m, p = req['method'], req.get('params', [])
        r = None
        if m == 'getBlocksWithLimit': r = [p[0]]
        elif m == 'getBlockTime': r = tm(p[0])
        elif m == 'getBlocks': r = [p[0]] if p[0] % 4500 == 0 else []
        if m == 'getBlock':
            log.write('%d\n' % p[0]); log.flush(); body = block
        else: body = json.dumps({'jsonrpc': '2.0', 'result': r, 'id': 1}).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
srv = HTTPServer(('127.0.0.1', 0), H)
open(sys.argv[1], 'w').write(str(srv.server_address[1])); srv.serve_forever()
PY
cat > "$T/gh" <<'SH'
#!/usr/bin/env bash
# Fake gh: releases are directories under $FAKE_GH.
set -e
cmd="$1 $2"; shift 2
tag=$1; shift
repo=; files=(); pat=; dir=
while [ $# -gt 0 ]; do case $1 in -R) repo=$2; shift 2;; --json|--jq|--title|--notes) shift 2;; -p) pat=$2; shift 2;; -D) dir=$2; shift 2;; *) files+=("$1"); shift;; esac; done
[ "$repo" = macdarenz-droid/zeroed-data ] || { echo "wrong repo $repo" >&2; exit 9; }
[[ "$tag" == tape-* ]] || { echo "wrong tag $tag" >&2; exit 9; }
r="$FAKE_GH/$tag"
case $cmd in
  "release view") [ -d "$r" ] || exit 1; ls "$r" ;;
  "release create") mkdir -p "$r" ;;
  "release upload") for f in "${files[@]}"; do [ ! -e "$r/$(basename "$f")" ] || exit 8; cp "$f" "$r/"; done ;;
  "release download") cp "$r/$pat" "$dir/" ;;
esac
SH
chmod +x "$T/gh"; mkdir -p "$T/rel"
(cd "$here/tapedec" && go build -o "$T/tapedec" .) || exit 1
"$T/tapedec" zcat "$root/research/historical/rpcscan/testdata/rpc/452277009.json.zst" > "$T/block.json" || exit 1
python3 "$T/fake.py" "$T/port" "$T/block.json" "$T/getblock.log" & fpid=$!
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
run() { env GH="$T/gh" FAKE_GH="$T/rel" TAPE_TEST=1 HELIUS_API_KEY=CANARY-stepa TAPE_UPSTREAM="http://127.0.0.1:$(cat "$T/port")/" RPC_CONC=4 REPLAY_EVERY=2 "$@" bash "$here/stepa.sh" "$T/work" >> "$T/out.txt" 2>&1; }
pass=0 fail=0
ok() { echo "ok   $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
rc=0; run MAX_UNITS=3 || rc=$?
s12=$(( 446014935 + 500 + 86400 * 5 / 2 ))   # first slot with time >= 2026-09-12T00:00Z
s11=$(( 446014935 + 500 )); s10=$(( s11 - 86400 * 5 / 2 ))
[[ $rc == 0 ]] && ok "three units read" || { no "stepa rc=$rc"; tail -20 "$T/out.txt"; }
head -1 "$T/work/plan.txt" | grep -q " $(( s12 - 1 ))$" && ok "the newest unit is clipped at the last slot before 2026-09-12" || no "clip: $(head -1 "$T/work/plan.txt") vs $s12"
[[ $(sort -n "$T/getblock.log" | tail -1) -lt $s12 ]] && ok "no getBlock at or after the first 09-12 slot" || no "a 09-12 block was read"
tail -1 "$T/work/plan.txt" | grep -q "2026-09-10 [0-9]* $(( s10 / 4500 * 4500 )) " && ok "09-10 starts at the unit holding 00:00Z" || no "09-10 start: $(tail -1 "$T/work/plan.txt")"
dup=$(awk '{print $3}' "$T/work/plan.txt" | sort | uniq -d | wc -l)
[[ $dup == 0 ]] && ok "every unit planned once" || no "duplicate units"
n=$(awk '{print $2}' "$T/work/released.tsv" | sort -u | wc -l); [[ $n == 3 && $(ls "$T/rel/tape-2026-09-11" | wc -l) == 9 ]] && ok "3 units decoded, released (3 assets each) and read back" || no "released $n"
[[ $(find "$T/work/research/units" "$T/work/day/units" -name stats.json 2>/dev/null | wc -l) == 0 ]] && ok "local copies removed after read-back" || no "local copies left"
[[ $(find "$T/work/units" -name spool -type d | wc -l) == 0 ]] && ok "spools deleted after decode" || no "spool left"
grep -q "replay digest equal" "$T/work/stepa.log" && ok "replay digest on a sampled unit" || no "replay"
grep -rq CANARY-stepa "$T/work" --include='*.log' --include='*.json' --include='*.txt' && no "canary in a log" || ok "canary in no log"
before=$(wc -l < "$T/getblock.log"); rc=0; run MAX_UNITS=2 || rc=$?
after=$(wc -l < "$T/getblock.log")
[[ $rc == 0 && $(( after - before )) == 2 && $(awk '{print $2}' "$T/work/released.tsv" | sort -u | wc -l) == 5 ]] && ok "resume skips done units and reads the next two" || no "resume rc=$rc reads $((after-before))"
echo 999999 > "$T/work/stepa-credits-used"; rc=0; run || rc=$?
[[ $rc == 3 ]] && ok "the Step A cap stops the run" || no "cap rc=$rc"
echo "$pass passed, $fail failed"; [[ $fail == 0 ]]
