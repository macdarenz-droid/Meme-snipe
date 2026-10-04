#!/usr/bin/env bash
# Prints the revision recorded in units read over RPC (research/historical/rpcscan):
# the scanner's tree (its decoders, through symlinks), "+rpc", the RPC scanner's own
# tree, and the Go toolchain. Fails like scanner-rev.sh on any other toolchain.
#   GO_VERSION=1.24.7 rpcscan-rev.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
base=$("$here/scanner-rev.sh")
echo "${base%-go*}+rpc$(git rev-parse HEAD:research/historical/rpcscan)-go${base##*-go}"
