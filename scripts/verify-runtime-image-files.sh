#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_text() {
  local file="$1"
  local text="$2"
  grep -Fq "$text" "$file" || {
    echo "Missing '$text' in ${file#$ROOT_DIR/}" >&2
    exit 1
  }
}

require_text "$ROOT_DIR/Dockerfile" "su-exec"
require_text "$ROOT_DIR/Dockerfile" "ENTRYPOINT [\"/usr/local/bin/docker-entrypoint.sh\"]"
require_text "$ROOT_DIR/Dockerfile.deepflow" "gosu"
require_text "$ROOT_DIR/Dockerfile.deepflow" "ENTRYPOINT [\"/usr/local/bin/docker-entrypoint.sh\"]"
require_text "$ROOT_DIR/docker-compose.yml" "LOG_DIR=/app/logs"

for key in \
  CLAUDE_DEFAULT_TIMEOUT_MINUTES \
  CODEX_DEFAULT_TIMEOUT_MINUTES \
  REVIEW_ENABLED \
  REVIEW_DEFAULT_PROVIDER \
  REVIEW_MIN_CONFIDENCE \
  REVIEW_MAX_CANDIDATE_FINDINGS \
  REVIEW_MAX_FINAL_FINDINGS \
  REVIEW_PASS_CONCURRENCY \
  REVIEW_SCORING_CONCURRENCY \
  REVIEW_SKIP_DRAFT \
  REVIEW_SKIP_EXISTING_SHA \
  REVIEW_ALLOWED_COMMANDS; do
  require_text "$ROOT_DIR/docker-compose.yml" "$key"
done

echo "Runtime image files look structurally valid."
