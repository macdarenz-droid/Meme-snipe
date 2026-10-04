p='.github/workflows/dryrun-rehearsal.yml'; s=open(p).read()
def rep(a,b):
    global s
    assert a in s, a[:60]
    s=s.replace(a,b)
rep("""# before any upload and fails the job if a secret value appears. No signing key exists anywhere.
""","""# before any upload and fails the job if a secret value appears. No signing key exists anywhere.
# Stdout limit: the worker's output goes only to logs/worker.log (scanned before upload); the job log shows the
# runner's own lines (names, counts, drill results), copied to logs/runner-<n>.log. That copy is scanned after
# the fact, so a hit on runner-*.log means the value was already in the public job log: rotate that key.
# Code that runs with the keys: a commit on the integration branch or this run's own ref head, and only the
# worker or the stub entry. Restored state cannot pick the label or the commit, and a run is at most 72 h with
# at most the jobs it needs plus 2.
# One concurrency group per run: a second dispatch for the same run waits; GitHub keeps one waiting job per
# group, so a third dispatch for that run cancels the waiting one. Different runs do not block each other.
""")
rep("""  group: dryrun-rehearsal
""","""  group: dryrun-rehearsal-${{ inputs.run_id || github.run_id }}
""")
rep("""          ref: ${{ inputs.sha || github.sha }}
          persist-credentials: false
""","""          ref: ${{ inputs.sha || github.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Check the commit, entry and chain limits
        env:
          SHA: ${{ inputs.sha || github.sha }}
          SEGMENT: ${{ inputs.segment }}
          HOURS: ${{ inputs.hours }}
          ENTRY: ${{ inputs.entry }}
        run: |
          git fetch --quiet --no-tags origin ccr-14987baf-i6lrsl
          if [ "$SHA" != "$GITHUB_SHA" ] && ! git merge-base --is-ancestor "$SHA" FETCH_HEAD; then
            echo "Refused: $SHA is neither on the integration branch nor this run's ref head."; exit 1
          fi
          case "$ENTRY" in packages/worker/src/main.ts|packages/runner/stub/worker.ts) ;; *) echo "Refused: entry $ENTRY"; exit 1 ;; esac
          node --no-warnings packages/runner/src/cli.ts check-segment --segment "$SEGMENT" --hours "$HOURS"
""")
rep("""      - name: Restore the previous job's state
        if: inputs.prev_run != ''
""","""      - name: Check the previous job
        if: inputs.prev_run != ''
        env:
          GH_TOKEN: ${{ github.token }}
          PREV: ${{ inputs.prev_run }}
        run: |
          meta="$(gh run view "$PREV" --repo "$GITHUB_REPOSITORY" --json workflowName,event)"
          echo "$meta" | jq -e '.workflowName == "Dry-run rehearsal" and .event == "workflow_dispatch"' >/dev/null \\
            || { echo "Refused: run $PREV is not a dispatched Dry-run rehearsal job."; exit 1; }

      - name: Restore the previous job's state
        if: inputs.prev_run != ''
""")
rep("""--hours "$HOURS" --segment-minutes 335""","""--hours "$HOURS" --segment "$SEGMENT" --segment-minutes 335""")
rep("""        run: |
          gh workflow run""","""        run: |
          node --no-warnings packages/runner/src/cli.ts check-segment --segment "$((SEGMENT + 1))" --hours "$HOURS"
          gh workflow run""")
open(p,'w').write(s)
