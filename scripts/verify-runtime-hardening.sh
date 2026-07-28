#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bash "$ROOT_DIR/scripts/verify-runtime-image-files.sh"
bash "$ROOT_DIR/scripts/verify-deepflow-image-files.sh"
bash "$ROOT_DIR/scripts/verify-entrypoint-safety.sh"

echo "Runtime hardening verification passed."
