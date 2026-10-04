import sys, yaml
steps = yaml.safe_load(open(sys.argv[1]))["jobs"]["scan"]["steps"]
i = next(k for k, s in enumerate(steps) if s.get("id") == "published")
names = [s.get("name", s.get("uses", "")) for s in steps]
assert all("Scan" not in n and "Build" not in n for n in names[:i]), names[:i]
for s in steps[i + 1:]:
    if "setup-node" in s.get("uses", ""):
        continue
    assert "steps.published.outputs.complete != 'true'" in s.get("if", ""), s
tok = [s for s in steps if "github.token" in str(s)]
assert [s.get("id") or s.get("name") for s in tok] == ["published", "Publish this day"], tok
for s in tok:
    assert s["shell"].startswith("/usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc"), s
    assert s["env"]["BASH_ENV"] == "" and s["run"].startswith("/usr/bin/env -i PATH=/usr/bin:/bin "), s
    assert all(s["env"][k] == "" for k in ("LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH")), s
for s in steps[i + 1:]:
    if "always()" in s.get("if", ""):
        assert "steps.published.outcome == 'success'" in s["if"], s
# chaining: the scan step reports exit 75 as resumable and a resume-DAY artifact follows;
# the continue job is one gh step with actions: write only, no checkout, a bounded chain,
# dispatched only when this run holds a resume-* artifact
wf = yaml.safe_load(open(sys.argv[1]))
scan = next(s for s in steps if s.get("id") == "scan")
assert '-eq 75 ]; then echo "resumable=true"' in scan["run"] and 'exit "$rc"' in scan["run"], scan
assert any(s.get("with", {}).get("name") == "resume-${{ matrix.day }}" for s in steps)
c = wf["jobs"]["continue"]
assert c["needs"] == ["plan", "scan"] and "needs.scan.result == 'failure'" in c["if"], c
assert c["permissions"] == {"actions": "write"} and int(c["env"]["MAX_CHAIN"]) <= 12, c
assert len(c["steps"]) == 1 and "uses" not in c["steps"][0], c
r = c["steps"][0]["run"]
assert r.index('select(startswith("resume-"))') < r.index('-ge "$MAX_CHAIN"') < r.index("gh workflow run"), r
assert '-f chain="$next"' in r and "-f days=\"$DAYS\"" in r, r
assert wf[True]["workflow_dispatch"]["inputs"]["chain"]["default"] == "0"
# QA-phase budget: checked after the progress save and before QA, against this job's own
# timeout; QA, packaging and publishing never run on always(), so a stop skips them
names = [s.get("id") or s.get("name") or s.get("uses") for s in steps]
assert names[0] == "Record the job start (time budget of the QA phase)" and "JOB_START=" in steps[0]["run"]
qt = next(s for s in steps if s.get("id") == "qatime")
assert f'time-left.sh "$JOB_START" {wf["jobs"]["scan"]["timeout-minutes"]} ' in qt["run"] and '-eq 75 ]; then echo "resumable=true"' in qt["run"], qt
order = lambda key: names.index(key)
assert order("save") < order("qatime") < order("qa") < order("Package the day") < order("Publish this day")
for k in ("qa", "Package the day", "Publish this day"):
    st = steps[order(k)]
    assert "always()" not in st.get("if", ""), st
# chained only after a successful save, for either resumable stop
marks = [s for s in steps if "resumable" in s.get("if", "")]
assert len(marks) == 2, marks
for st in marks:
    assert "steps.save.outcome == 'success'" in st["if"] and "steps.qatime.outputs.resumable == 'true'" in st["if"] and "steps.scan.outputs.resumable == 'true'" in st["if"], st
assert order("Log the progress entry size") == order("save") - 1 and "du -sb" in steps[order("Log the progress entry size")]["run"]
# a 429 in the determinism rescan (check-day exit 75) is resumable too; the markers come after QA
qa = steps[order("qa")]
assert '-eq 75 ]; then echo "resumable=true"' in qa["run"] and 'exit "$rc"' in qa["run"], qa
for st in marks:
    assert "steps.qa.outputs.resumable == 'true'" in st["if"], st
    assert steps.index(st) > order("qa"), "resume markers must follow the QA step"
# phase durations: artifact upload and publish timed around their steps
assert order("Note the upload start") < names.index("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02") < order("Note the publish start") < order("Publish this day") < order("Log the publish duration")
