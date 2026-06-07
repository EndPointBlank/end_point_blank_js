#!/usr/bin/env bash
# Run the test suite for end-point-blank-js (Jest).
set -euo pipefail
cd "$(dirname "$0")"
exec npm test
