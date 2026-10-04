#!/usr/bin/env bash
# Publishes nothing unless CI's `check` (GitHub Actions) passed on this exact commit: waits while it runs or
# has not started, fails on any other conclusion. Uses GH_REPO, GITHUB_SHA; WAIT_S, POLL_S and CLOCK_FILE for tests.
set -euo pipefail
# Seconds since start. CLOCK_FILE is a test seam: tests point it at a file their stand-in `sleep` advances, so no
# wall clock decides a test. It moves timing only; anything but a whole number of seconds stops the script (exit 1).
now() {
  if [ -z "${CLOCK_FILE:-}" ]; then printf '%s' "$SECONDS"; return 0; fi
  local t
  t="$(cat "$CLOCK_FILE")" || exit 1
  [[ "$t" =~ ^(0|[1-9][0-9]{0,8})$ ]] || { echo "::error::CLOCK_FILE does not hold whole seconds." >&2; exit 1; }
  printf '%s' "$t"
}
# 26 min: the release job's 30-min timeout less ~4 min for its other steps (push CI's check takes 8-12 min).
start="$(now)"
deadline=$((start + ${WAIT_S:-1560}))
while :; do
  c="$(gh api "repos/$GH_REPO/commits/$GITHUB_SHA/check-runs?check_name=check&per_page=100" | jq -r '
    [(.check_runs // [])[] | select(.name == "check" and (.app.slug // "") == "github-actions")]
    | sort_by(.started_at // "") | last
    | if . == null then "none" elif .status != "completed" then "pending" else (.conclusion // "none") end')"
  case "$c" in
    success) echo "check passed on ${GITHUB_SHA:0:12}."; exit 0 ;;
    none | pending) ;;
    *) echo "::error::check was $c on ${GITHUB_SHA:0:12}; the preview release stays as it is."; exit 1 ;;
  esac
  t="$(now)"
  if [ "$t" -ge "$deadline" ]; then
    # 26 min: the release job's 30-min timeout less ~4 min for its other steps (push CI's check takes 8-12 min).
    echo "::error::check on ${GITHUB_SHA:0:12} is $c after ${WAIT_S:-1560} s; the preview release stays as it is."
    exit 1
  fi
  sleep "${POLL_S:-20}"
done
