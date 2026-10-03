#!/usr/bin/env bash
# Prints the scanner revision recorded in every unit: the git tree of the scanner folder
# plus the Go toolchain (its standard library can change output between releases).
# Fails if the toolchain in use is not go$GO_VERSION (GOTOOLCHAIN may switch it).
#   GO_VERSION=1.24.7 scanner-rev.sh
set -euo pipefail
: "${GO_VERSION:?GO_VERSION is required}"
have=$(go env GOVERSION)
[ "$have" = "go$GO_VERSION" ] || { echo "toolchain $have, expected go$GO_VERSION" >&2; exit 1; }
echo "$(git rev-parse HEAD:research/historical/scanner)-go$GO_VERSION"
