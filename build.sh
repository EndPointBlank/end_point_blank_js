#!/usr/bin/env bash
# Install dependencies so the test suite can run.
set -euo pipefail
cd "$(dirname "$0")"
exec npm install
