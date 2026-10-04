#!/usr/bin/env bash
# Publishes nothing unless CI's `check` (GitHub Actions) passed on this exact commit: waits while it runs or
# has not started, fails on any other conclusion. Uses GH_REPO, GITHUB_SHA; WAIT_S and POLL_S for tests.
set -euo pipefail
deadline=$((SECONDS + ${WAIT_S:-1200}))
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
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::check on ${GITHUB_SHA:0:12} is $c after ${WAIT_S:-1200} s; the preview release stays as it is."
    exit 1
  fi
  sleep "${POLL_S:-20}"
done
