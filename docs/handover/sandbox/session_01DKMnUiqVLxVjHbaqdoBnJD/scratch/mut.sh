run() { name="$1"; expr="$2"; cp digest.go /tmp/claude-0/digest.bak
  perl -0pi -e "$expr" digest.go
  if cmp -s digest.go /tmp/claude-0/digest.bak; then echo "$name: NOT APPLIED"; else
  if go test -count=1 ./... >/dev/null 2>&1; then echo "$name: SURVIVED"; else echo "$name: killed"; fi; fi
  cp /tmp/claude-0/digest.bak digest.go; }
run raw-only 's/case n == "raw" && /case /'
run rows-eq 's/(case n == "raw" && )tc\.RowsBaseline == tc\.RowsCandidate && /$1/'
run cols-missing 's/(case n == "raw" && tc\.RowsBaseline == tc\.RowsCandidate && )len\(tc\.ColumnsMissing\) == 0 &&/$1/'
run one-col 's/len\(tc\.ColumnsDiffer\) == 1 && tc\.ColumnsDiffer\[0\] == "meta\.logMessages"/len(tc.ColumnsDiffer) >= 1/'
run is-logmsgs 's/len\(tc\.ColumnsDiffer\) == 1 && tc\.ColumnsDiffer\[0\] == "meta\.logMessages"/len(tc.ColumnsDiffer) == 1/'
run rawdiff 's/ && rawDiffExplained\(b, c, diff\):/:/'
run nologs 's/b\.NoLogs == c\.NoLogs && //'
run cut-nonempty 's/b\.Cut != "" && //'
run logs-eq-cut 's/c\.Logs == b\.Cut/c.Logs != b.Logs/'
run ge-to-gt 's/written\+len\(m\) >= limit/written+len(m) > limit/'
run prefix-cut 's/(out = append\(out, logTruncated\)\n\t+\}\n)(\t+)continue/$1$2break/'
run count-dropped 's/(if written\+len\(m\) >= limit \{)/written += 0\n\t\t$1\n\t\t\twritten += len(m)/'
run limit-9999 's/logLimitBytes = 10000/logLimitBytes = 9999/'
run limit-10001 's/logLimitBytes = 10000/logLimitBytes = 10001/'
run cr-nil 's/if cr == nil \{\n\t+return false/if cr == nil {\n\t\t\tcontinue/'
run seen 's/return seen == 0/return true/'
run no-records 's/if b\.Records == nil \|\| c\.Records == nil \|\| len\(blocks\) == 0 \{/if false {/'
run full-eq 's/br\.Full != cr\.Full && !recordExplained/!recordExplained/'
