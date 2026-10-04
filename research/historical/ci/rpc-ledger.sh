#!/usr/bin/env bash
# The account-wide Helius credit ledger (DATA-4). One JSON file, ledger.json, on release
# `helius-ledger`, so it outlives any cache or runner. Every helius day job reserves its
# run budget here before it spends anything, and settles the actual spend afterwards:
# a run that dies before settling leaves its whole reservation booked, so the ledger
# over-books and never under-books. A missing or unreadable ledger fails closed.
#
#   rpc-ledger.sh init PERIOD LIMIT WORKER_BUDGET [USED_SO_FAR [DAY=USED ...]]
#       creates the ledger for a billing period (refused when one exists). WORKER_BUDGET
#       is the live worker's share of the period, held back from every reservation
#       (the worker spends on the same account but cannot write here).
#   rpc-ledger.sh reserve ID DAY DAY_CAP RUN_BUDGET OUT_FILE
#       books min(RUN_BUDGET, what is left of DAY_CAP for DAY, what is left of the
#       period after the worker's share) as outstanding under ID and writes the amount to
#       OUT_FILE. Exit 3 when nothing is left (not resumable), 1 on any ledger problem.
#   rpc-ledger.sh settle ID WORK_DIR
#       books ID's actual spend and closes it. A spend counts at its usage file's credits
#       only when the file is final (written at a clean exit); a spend that started
#       (WORK_DIR/rpc-started-*) without a final usage file books the whole reservation.
#   rpc-ledger.sh show
#   rpc-ledger.sh unlock
#       removes a lock left by a job that died while holding it (see below).
#
# Writers take a lock first: asset ledger.lock, uploaded without --clobber, which GitHub
# refuses while the asset exists, so only one job reads, changes and writes the ledger
# at a time. A job that cannot take it within LOCK_WAIT seconds (default 300) fails
# closed; a lock left by a killed job blocks spending until `unlock` (helius-ledger.yml).
# `unlock` refuses a lock younger than LOCK_WAIT, which a live writer may still hold.
#
# Writes never leave the release without the newest ledger: `gh release upload --clobber`
# deletes the old asset before it uploads, so a write first uploads ledger.next.json
# (no clobber), then replaces ledger.json, then deletes ledger.next.json. Readers take
# ledger.next.json when it exists (it is never older than ledger.json), the next writer
# first copies it over ledger.json, and init refuses while either exists. A failed write
# exits 1 and prints the ledger it meant to write, also to the step summary.
# gh: GH_BIN (default /usr/bin/gh), with GH_TOKEN and GITHUB_REPOSITORY for the repo.
set -euo pipefail
gh=${GH_BIN:-/usr/bin/gh}
py=${PYTHON_BIN:-/usr/bin/python3}
tag=helius-ledger
cmd=${1:-}
shift || true
tmp=$(mktemp -d)
locked=
cleanup() {
  [ -z "$locked" ] || "$gh" release delete-asset "$tag" ledger.lock -y >/dev/null 2>&1 ||
    echo "rpc-ledger: could not remove ledger.lock: every helius job now fails closed until 'rpc-ledger.sh unlock'" >&2
  rm -rf "$tmp"
}
trap cleanup EXIT

lock() {
  echo "${GITHUB_RUN_ID:-local} $(date -u +%FT%TZ)" > "$tmp/ledger.lock"
  local waited=0
  until "$gh" release upload "$tag" -- "$tmp/ledger.lock" >/dev/null 2>"$tmp/lockerr"; do
    if [ "$waited" -ge "${LOCK_WAIT:-300}" ]; then
      echo "rpc-ledger: the ledger stayed locked for ${waited} s ($(head -c 200 "$tmp/lockerr")): refusing to spend credits; if no helius job is running, run 'rpc-ledger.sh unlock'" >&2
      exit 1
    fi
    sleep "${LOCK_POLL:-10}"; waited=$(( waited + ${LOCK_POLL:-10} ))
  done
  locked=1
}

assets() { # the release's asset names into $tmp/assets, or fail closed
  "$gh" release view "$tag" --json assets --jq '.assets[].name' > "$tmp/assets" 2>"$tmp/err" || {
    echo "rpc-ledger: cannot list release $tag ($(head -c 200 "$tmp/err")): refusing to spend credits; create the ledger with 'rpc-ledger.sh init'" >&2
    exit 1
  }
}
stale_next=
fetch() { # the newest ledger into $tmp/ledger.json, or fail closed
  : > "$tmp/err"
  assets
  local name=ledger.json
  if grep -qx ledger.next.json "$tmp/assets"; then name=ledger.next.json; stale_next=1; fi
  mkdir -p "$tmp/dl"
  if ! grep -qx "$name" "$tmp/assets" || ! "$gh" release download "$tag" --dir "$tmp/dl" --pattern "$name" >/dev/null 2>"$tmp/err" || [ ! -s "$tmp/dl/$name" ]; then
    echo "rpc-ledger: no readable $name on release $tag ($(head -c 200 "$tmp/err")): refusing to spend credits; create it with 'rpc-ledger.sh init'" >&2
    exit 1
  fi
  cp "$tmp/dl/$name" "$tmp/ledger.json"
  [ -z "$stale_next" ] || { mkdir -p "$tmp/repair"; cp "$tmp/dl/$name" "$tmp/repair/ledger.json"; }
}
write_failed() {
  echo "rpc-ledger: could not write the ledger ($1): refusing to spend credits. The ledger it meant to write:" >&2
  cat "$tmp/ledger.json" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo "### Helius ledger write failed ($1)"; echo; echo "The ledger it meant to write:"; echo; echo '```json'; cat "$tmp/ledger.json"; echo '```'; } >> "$GITHUB_STEP_SUMMARY" || true
  fi
  exit 1
}
push() { # under the lock: next first, then ledger.json, then drop next
  if [ -n "$stale_next" ]; then # a write that failed half-way: make ledger.json the newest first
    "$gh" release upload "$tag" --clobber -- "$tmp/repair/ledger.json" >/dev/null || write_failed "copying the left-over ledger.next.json to ledger.json"
    "$gh" release delete-asset "$tag" ledger.next.json -y >/dev/null || write_failed "deleting the left-over ledger.next.json"
  fi
  mkdir -p "$tmp/next"; cp "$tmp/ledger.json" "$tmp/next/ledger.next.json"
  "$gh" release upload "$tag" -- "$tmp/next/ledger.next.json" >/dev/null || write_failed "uploading ledger.next.json"
  "$gh" release upload "$tag" --clobber -- "$tmp/ledger.json" >/dev/null || write_failed "replacing ledger.json; ledger.next.json holds the new ledger"
  "$gh" release delete-asset "$tag" ledger.next.json -y >/dev/null || write_failed "deleting ledger.next.json after ledger.json was written"
}

case $cmd in
  init)
    [ $# -ge 3 ] || { echo "usage: rpc-ledger.sh init PERIOD LIMIT WORKER_BUDGET [USED [DAY=USED ...]]" >&2; exit 2; }
    if "$gh" release view "$tag" >/dev/null 2>&1; then
      lock
      assets
      if grep -qx -e ledger.json -e ledger.next.json "$tmp/assets"; then
        echo "rpc-ledger: a ledger already exists ($(grep -x -e ledger.json -e ledger.next.json "$tmp/assets" | tr '\n' ' ')): refusing to overwrite it" >&2
        exit 1
      fi
    fi
    "$py" - "$tmp/ledger.json" "$@" <<'PY'
import json, re, sys
out, period, limit, worker, *rest = sys.argv[1:]
used, days = 0, {}
if rest:
    used = int(rest[0])
    for kv in rest[1:]:
        d, n = kv.split("=")
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", d), d
        days[d] = int(n)
limit, worker = int(limit), int(worker)
assert 0 < limit and 0 <= worker < limit and used >= 0 and sum(days.values()) <= used, "bad init values"
json.dump({"period": period, "limit": limit, "worker_budget": worker, "used": used, "days": days,
           "outstanding": [], "settled": []}, open(out, "w"), indent=1, sort_keys=True)
PY
    if "$gh" release view "$tag" >/dev/null 2>&1; then
      push
    else
      "$gh" release create "$tag" --title "Helius credit ledger" --notes "Account-wide Helius credit ledger (DATA-4, research/historical/ci/rpc-ledger.sh). Edited by the data-scan workflow only." -- "$tmp/ledger.json" >/dev/null
    fi
    echo "rpc-ledger: ledger created for $1: limit $2, worker share $3"
    ;;
  reserve)
    [ $# -eq 5 ] || { echo "usage: rpc-ledger.sh reserve ID DAY DAY_CAP RUN_BUDGET OUT_FILE" >&2; exit 2; }
    lock
    fetch
    rc=0
    "$py" - "$tmp/ledger.json" "$1" "$2" "$3" "$4" "$tmp/amount" <<'PY' || rc=$?
import json, sys, time
path, rid, day, day_cap, budget, out = sys.argv[1:]  # out: the amount, copied to OUT_FILE once written
try:
    l = json.load(open(path))
    used, limit, worker = int(l["used"]), int(l["limit"]), int(l["worker_budget"])
    days, outstanding = l["days"], l["outstanding"]
except Exception as e:
    print(f"rpc-ledger: unreadable ledger ({e}): refusing to spend credits", file=sys.stderr); sys.exit(1)
if any(o["id"] == rid for o in outstanding):
    print(f"rpc-ledger: {rid} already holds a reservation", file=sys.stderr); sys.exit(1)
out_all = sum(int(o["amount"]) for o in outstanding)
out_day = sum(int(o["amount"]) for o in outstanding if o["day"] == day)
left_period = limit - worker - used - out_all
left_day = int(day_cap) - int(days.get(day, 0)) - out_day
amount = min(int(budget), left_period, left_day)
print(f"rpc-ledger: period {l['period']}: {used} used, {out_all} reserved, worker share {worker} of {limit}; "
      f"{day}: {days.get(day, 0)} used, {out_day} reserved of cap {day_cap}; reserving {max(amount, 0)}")
if amount <= 0:
    print("rpc-ledger: no credits left for this run (period or day cap spent): not resumable", file=sys.stderr); sys.exit(3)
outstanding.append({"id": rid, "day": day, "amount": amount, "at": int(time.time())})
json.dump(l, open(path, "w"), indent=1, sort_keys=True)
open(out, "w").write(str(amount))
PY
    [ "$rc" -eq 0 ] || exit "$rc"
    push
    cp "$tmp/amount" "$5"
    ;;
  settle)
    [ $# -eq 2 ] || { echo "usage: rpc-ledger.sh settle ID WORK_DIR" >&2; exit 2; }
    lock
    fetch
    "$py" - "$tmp/ledger.json" "$@" <<'PY'
import glob, json, os, sys, time
path, rid, work = sys.argv[1:]
l = json.load(open(path))
o = next((o for o in l["outstanding"] if o["id"] == rid), None)
if o is None:
    print(f"rpc-ledger: {rid} holds no reservation", file=sys.stderr); sys.exit(1)
reserved, actual, notes = int(o["amount"]), 0, []
for started in sorted(glob.glob(os.path.join(work, "rpc-started-*"))):
    usage = os.path.join(work, "rpc-usage-" + os.path.basename(started)[len("rpc-started-"):] + ".json")
    try:
        u = json.load(open(usage))
        assert u.get("final") is True and isinstance(u["credits"], int) and u["credits"] >= 0
        actual += u["credits"]
    except Exception:
        notes.append(f"{os.path.basename(started)} without a final usage file: the whole reservation is booked")
        break
actual = max(actual, 0) if not notes else reserved
l["outstanding"].remove(o)
l["used"] = int(l["used"]) + actual
l["days"][o["day"]] = int(l["days"].get(o["day"], 0)) + actual
l["settled"].append({"id": rid, "day": o["day"], "reserved": reserved, "actual": actual, "at": int(time.time()), "note": "; ".join(notes)})
json.dump(l, open(path, "w"), indent=1, sort_keys=True)
print(f"rpc-ledger: {rid} settled: {actual} of {reserved} reserved booked{(' (' + '; '.join(notes) + ')') if notes else ''}; "
      f"{o['day']}: {l['days'][o['day']]} used; period: {l['used']} used of {l['limit']} (worker share {l['worker_budget']})")
PY
    push
    ;;
  show)
    fetch
    "$py" -c 'import json,sys; l=json.load(open(sys.argv[1])); print(json.dumps({k: l[k] for k in ("period","limit","worker_budget","used","days","outstanding")}, indent=1))' "$tmp/ledger.json"
    ;;
  unlock)
    "$gh" release download "$tag" --dir "$tmp" --pattern ledger.lock >/dev/null 2>&1 || true
    if [ -s "$tmp/ledger.lock" ]; then
      at=$(awk '{print $2}' "$tmp/ledger.lock"); at=$(date -u -d "$at" +%s 2>/dev/null || echo 0)
      age=$(( $(date -u +%s) - at ))
      if [ "$at" -gt 0 ] && [ "$age" -lt "${LOCK_WAIT:-300}" ]; then
        echo "rpc-ledger: the lock is ${age} s old ($(head -c 120 "$tmp/ledger.lock")): a job may still be writing; wait ${LOCK_WAIT:-300} s and retry" >&2
        exit 1
      fi
    fi
    "$gh" release delete-asset "$tag" ledger.lock -y >/dev/null && echo "rpc-ledger: lock removed" ;;
  *) echo "usage: rpc-ledger.sh init|reserve|settle|show|unlock ..." >&2; exit 2 ;;
esac
