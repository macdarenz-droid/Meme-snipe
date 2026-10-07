cd /tmp/claude-0/wt/int
resolve_docs() {
  files=$(git diff --name-only --diff-filter=U)
  for f in $files; do case "$f" in docs/*.md|HANDOVER.md|PROJECT_STATE.md) ;; *) return 1;; esac; done
  python3 /tmp/claude-0/keepboth.py $files && ! grep -lq "^<<<<<<<\|^>>>>>>>" $files && git add -A && git -c user.email=rb@x -c user.name=rb commit -q --no-edit
}
for b in "$@"; do
  git fetch -q origin claude/$b
  if git -c user.email=rb@x -c user.name=rb merge --no-edit -q FETCH_HEAD >/tmp/claude-0/m-$b.log 2>&1; then echo "OK $b";
  else f=$(git diff --name-only --diff-filter=U | tr '\n' ' '); if resolve_docs; then echo "DOCS-ONLY $b: $f (kept both)"; else echo "CONFLICT $b: $f"; exit 1; fi; fi
done
