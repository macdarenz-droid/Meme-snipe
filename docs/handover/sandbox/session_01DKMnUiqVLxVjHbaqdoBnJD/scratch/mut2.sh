R='s/case n == "raw" && /case /'
ROWS='s/(case n == "raw" && )tc\.RowsBaseline == tc\.RowsCandidate && /$1/; s/(case )tc\.RowsBaseline == tc\.RowsCandidate && (len\(tc\.ColumnsMissing)/$1$2/'
CM='s/len\(tc\.ColumnsMissing\) == 0 &&\n\t+len\(tc\.ColumnsDiffer\) == 1/len(tc.ColumnsDiffer) == 1/'
ONE='s/len\(tc\.ColumnsDiffer\) == 1 && tc\.ColumnsDiffer\[0\] == "meta\.logMessages"/len(tc.ColumnsDiffer) >= 1/'
NL='s/b\.NoLogs == c\.NoLogs && //'
SEEN='s/return seen == 0/return true/'
CRN='s/if cr == nil \{\n\t+return false/if cr == nil {\n\t\t\tcontinue/'
NOREC='s/if b\.Records == nil \|\| c\.Records == nil \|\| len\(blocks\) == 0 \{/if false {/'
run() { name="$1"; shift; cp digest.go /tmp/claude-0/digest.bak
  for e in "$@"; do perl -0pi -e "$e" digest.go; done
  n=$(diff /tmp/claude-0/digest.bak digest.go | grep -c '^>')
  if go test -count=1 -run 'TestCompareDigests|TestPilot|TestAgave|TestRPC' ./... >/dev/null 2>&1; then echo "$name ($n lines): SURVIVED"; else echo "$name ($n lines): killed"; fi
  cp /tmp/claude-0/digest.bak digest.go; }
#run nologs+one-col "$NL" "$ONE"
#run rows+seen "$ROWS" "$SEEN"
#run rows+crnil "$ROWS" "$CRN"
#run raw-only+norec "$R" "$NOREC"
#run colsmissing+nologs "$CM" "$NL"
#run colsmissing-alone "$CM"
IS='s/len\(tc\.ColumnsDiffer\) == 1 && tc\.ColumnsDiffer\[0\] == "meta\.logMessages"/len(tc.ColumnsDiffer) == 1/'
echo ---
run rows+seen+one "$ROWS" "$SEEN" "$ONE"
run rows+crnil+one "$ROWS" "$CRN" "$ONE"
run raw+norec+is "$R" "$NOREC" "$IS"
run raw+norec+one "$R" "$NOREC" "$ONE"
