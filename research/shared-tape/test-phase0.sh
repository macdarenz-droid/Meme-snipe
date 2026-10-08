#!/usr/bin/env bash
# Dry run of phase0.sh against a local fake Helius (no network, a canary key) and a
# local stand-in for zeroed-data. The fake serves one block per unit (the testdata
# block, whose time is outside 2026-09-11, so the decoder drops it).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'kill $fpid 2>/dev/null; rm -rf "$T"' EXIT
cat > "$T/fake.py" <<'PY'
import json, sys, subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
t0 = 1789084800  # 2026-09-11T00:00Z
s0 = 446014935   # phase0.sh's slot estimate for t0
block = open(sys.argv[2], 'rb').read()
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        assert self.path.endswith('api-key=CANARY-phase0'), self.path
        req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        m, p = req['method'], req.get('params', [])
        if m == 'getBlocksWithLimit': body = json.dumps({'jsonrpc': '2.0', 'result': [p[0]], 'id': 1}).encode()
        elif m == 'getBlockTime': body = json.dumps({'jsonrpc': '2.0', 'result': t0 + int((p[0] - s0 - 500) * 0.4), 'id': 1}).encode()
        elif m == 'getBlocks': body = json.dumps({'jsonrpc': '2.0', 'result': [p[0]] if p[0] % 4500 == 0 else [], 'id': 1}).encode()
        elif m == 'getBlock': body = block
        else: body = b'{"jsonrpc":"2.0","error":{"code":-32601,"message":"no"},"id":1}'
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
srv = HTTPServer(('127.0.0.1', 0), H)
open(sys.argv[1], 'w').write(str(srv.server_address[1]))
srv.serve_forever()
PY
root=$(cd "$here/../.." && pwd)
(cd "$here/tapedec" && go build -o "$T/tapedec" .) || exit 1
"$T/tapedec" zcat "$root/research/historical/rpcscan/testdata/rpc/452277009.json.zst" > "$T/block.json" || exit 1
python3 "$T/fake.py" "$T/port" "$T/block.json" & fpid=$!
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
# The local stand-in for zeroed-data.
remote="$T/macdarenz-droid/zeroed-data.git"; mkdir -p "$(dirname "$remote")"
git init -q --bare -b main "$remote"; git -C "$remote" config uploadpack.allowFilter true
git clone -q "$remote" "$T/seed" 2>/dev/null; echo x > "$T/seed/README.md"
git -C "$T/seed" add -A && git -C "$T/seed" -c user.name=t -c user.email=t@t commit -qm seed && git -C "$T/seed" push -q origin main
git clone -q --depth 1 "file://$remote" "$T/zdata"
rc=0
env HELIUS_API_KEY=CANARY-phase0 TAPE_UPSTREAM="http://127.0.0.1:$(cat "$T/port")/" ZEROED_DATA="$T/zdata" RPC_CONC=4 \
  bash "$here/phase0.sh" "$T/work" 10 25 3 > "$T/out.txt" 2>&1 || rc=$?
pass=0 fail=0
ok() { echo "ok   $1"; pass=$((pass+1)); }
no() { echo "FAIL $1"; fail=$((fail+1)); }
[[ $rc == 0 ]] && grep -q "Phase 0 done" "$T/work/phase0.log" && ok "phase0.sh runs end to end" || { no "phase0.sh rc=$rc"; tail -20 "$T/out.txt"; }
grep -q "identity (credits, requests, bytes; selection calls excluded): true" "$T/work/phase0.log" && ok "identity holds with the selection calls" || no "identity"
grep -q "replay from the spool equals the live unit: true" "$T/work/phase0.log" && ok "replay digest equal" || no "replay"
git -C "$remote" ls-tree -r --name-only tape | grep -q '^tape/2026-09-11/phase0/records/ledger.json$' && ok "uploaded under tape/2026-09-11/phase0" || no "upload"
grep -rq CANARY-phase0 "$T/work" --include='*.log' --include='*.json' && no "canary in a log" || ok "canary key in no log or record"
u=$(cat "$T/work/credits-used"); a=$(jq .attempts "$T/work/ledger.json")
[[ "$u" == "$a" && "$u" -gt 0 ]] && ok "credits booked ($u)" || no "credits booked $u vs $a"
echo 5995 > "$T/work/credits-used"; rc=0
env HELIUS_API_KEY=CANARY-phase0 TAPE_UPSTREAM="http://127.0.0.1:$(cat "$T/port")/" ZEROED_DATA="$T/zdata" \
  bash "$here/phase0.sh" "$T/work" 10 > "$T/out2.txt" 2>&1 || rc=$?
[[ $rc != 0 && $(cat "$T/work/credits-used") -le 6000 ]] && ok "the cap holds across reruns (stopped at $(cat "$T/work/credits-used"))" || no "rerun cap: rc=$rc used $(cat "$T/work/credits-used")"
echo "$pass passed, $fail failed"
[[ $fail == 0 ]]
