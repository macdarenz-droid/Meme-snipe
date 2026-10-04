p='.github/workflows/data-helius-pilot.yml'; s=open(p).read()
def rep(o,n):
    global s
    assert s.count(o)==1, o[:60]; s=s.replace(o,n)
rep('''    timeout-minutes: 120
    steps:''','''    timeout-minutes: 120
    permissions:
      contents: write # used only by the two Helius credit ledger steps
    steps:''')
clean='''        shell: /usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc -eo pipefail {0}
        env:
          RID: pilot-${{ github.run_id }}-${{ github.run_attempt }}
          GH_TOKEN: ${{ github.token }}
          MAX_CREDITS: ${{ inputs.max_credits }}
          BASH_ENV: ""
          LD_PRELOAD: ""
          LD_AUDIT: ""
          LD_LIBRARY_PATH: ""
'''
rep('''      - name: Pilot (free plan, hard credit stop)
        env:
          HELIUS_API_KEY: ${{ secrets.HELIUS_API_KEY }}
          MAX_CREDITS: ${{ inputs.max_credits }}
        run: |
          mkdir -p "$RUNNER_TEMP/report"
''','''      # DATA-4: the pilot's credits are reserved in the account-wide ledger
      # (ci/rpc-ledger.sh, release helius-ledger) before any request, in a clean shell
      # without the Helius key; a missing ledger fails closed. The day key "pilot" gives
      # it its own cap of max_credits.
      - name: Reserve Helius credits
        id: reserve
'''+clean+'''        run: >-
          /usr/bin/env -i PATH=/usr/bin:/bin HOME="$HOME" GH_TOKEN="$GH_TOKEN" GITHUB_REPOSITORY="$GITHUB_REPOSITORY"
          /usr/bin/bash --noprofile --norc "$GITHUB_WORKSPACE/research/historical/ci/rpc-ledger.sh"
          reserve "$RID" pilot "$MAX_CREDITS" "$MAX_CREDITS" "$RUNNER_TEMP/rpc-reservation"
      - name: Pilot (free plan, hard credit stop)
        env:
          HELIUS_API_KEY: ${{ secrets.HELIUS_API_KEY }}
        run: |
          mkdir -p "$RUNNER_TEMP/report" "$RUNNER_TEMP/ledger"
          MAX_CREDITS=$(cat "$RUNNER_TEMP/rpc-reservation")
          : > "$RUNNER_TEMP/ledger/rpc-started-pilot"
''')
rep('''      - name: Summarise the report
        if: always()''','''      # The report is written after the last request, so its usage is final; with no
      # report (a killed run) the whole reservation is booked.
      - name: Settle Helius credits
        if: always() && steps.reserve.outcome == 'success'
'''+clean+'''        run: |
          /usr/bin/python3 - "$RUNNER_TEMP/report/pilot-report.json" "$RUNNER_TEMP/ledger/rpc-usage-pilot.json" <<'EOF' || true
          import json, sys
          u = json.load(open(sys.argv[1]))["usage"]
          u["final"] = True
          json.dump(u, open(sys.argv[2], "w"))
          EOF
          /usr/bin/env -i PATH=/usr/bin:/bin HOME="$HOME" GH_TOKEN="$GH_TOKEN" GITHUB_REPOSITORY="$GITHUB_REPOSITORY" \\
            /usr/bin/bash --noprofile --norc "$GITHUB_WORKSPACE/research/historical/ci/rpc-ledger.sh" settle "$RID" "$RUNNER_TEMP/ledger"
      - name: Summarise the report
        if: always()''')
open(p,'w').write(s)
