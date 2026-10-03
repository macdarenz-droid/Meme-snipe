#!/bin/sh
cd "$(dirname "$0")" && NODE_USE_ENV_PROXY=1 NODE_NO_WARNINGS=1 node live_collector.mjs "${1:-70}"
