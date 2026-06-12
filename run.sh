#!/usr/bin/env bash
# run.sh — build (if needed) and launch Faces.app.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = "--rebuild" ] || [ ! -f "Faces.app/Contents/MacOS/Faces" ]; then
  ./build-app.sh
fi

echo "==> Launching Faces.app"
open Faces.app
