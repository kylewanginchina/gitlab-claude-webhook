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

require_line() {
  local file="$1"
  local text="$2"
  grep -Fxq "$text" "$file" || {
    echo "Missing exact line '$text' in ${file#$ROOT_DIR/}" >&2
    exit 1
  }
}

reject_text() {
  local file="$1"
  local text="$2"
  if grep -Fq "$text" "$file"; then
    echo "Unexpected '$text' in ${file#$ROOT_DIR/}" >&2
    exit 1
  fi
}

require_no_runtime_entrypoint() {
  if [[ -e "$ROOT_DIR/docker-entrypoint.sh" ]]; then
    echo "Unexpected runtime entrypoint: docker-entrypoint.sh" >&2
    exit 1
  fi
}

require_dockerfile_contract() {
  local dockerfile="$1"

  require_line "$dockerfile" 'USER claude'
  reject_text "$dockerfile" 'ENTRYPOINT'
  reject_text "$dockerfile" 'docker-entrypoint.sh'
  reject_text "$dockerfile" 'su-exec'
  reject_text "$dockerfile" 'gosu'
}

require_no_runtime_entrypoint
require_dockerfile_contract "$ROOT_DIR/Dockerfile"
require_dockerfile_contract "$ROOT_DIR/Dockerfile.deepflow"
require_text "$ROOT_DIR/Dockerfile" 'adduser -S claude -u 1001 -G claude'

require_line "$ROOT_DIR/docker-compose.yml" '      - ./logs:/app/logs'
require_line "$ROOT_DIR/docker-compose.yml" '      - ./data:/app/data'

require_line "$ROOT_DIR/docker-compose.yml" '      - CLAUDE_DEFAULT_TIMEOUT_MINUTES=${CLAUDE_DEFAULT_TIMEOUT_MINUTES:-30}'
require_line "$ROOT_DIR/docker-compose.yml" '      - CODEX_DEFAULT_TIMEOUT_MINUTES=${CODEX_DEFAULT_TIMEOUT_MINUTES:-30}'
require_line "$ROOT_DIR/docker-compose.yml" '      - REVIEW_ENABLED=${REVIEW_ENABLED:-true}'
require_line "$ROOT_DIR/docker-compose.yml" '      - REVIEW_DEFAULT_PROVIDER=${REVIEW_DEFAULT_PROVIDER:-claude-multipass}'
require_line "$ROOT_DIR/docker-compose.yml" '      - REVIEW_MIN_CONFIDENCE=${REVIEW_MIN_CONFIDENCE:-80}'
require_line "$ROOT_DIR/docker-compose.yml" '      - REVIEW_MAX_CANDIDATE_FINDINGS=${REVIEW_MAX_CANDIDATE_FINDINGS:-12}'
require_line "$ROOT_DIR/docker-compose.yml" '      - REVIEW_MAX_FINAL_FINDINGS=${REVIEW_MAX_FINAL_FINDINGS:-8}'
require_line "$ROOT_DIR/docker-compose.yml" '      - REVIEW_PASS_CONCURRENCY=${REVIEW_PASS_CONCURRENCY:-4}'
require_line "$ROOT_DIR/docker-compose.yml" '      - REVIEW_SCORING_CONCURRENCY=${REVIEW_SCORING_CONCURRENCY:-4}'
require_line "$ROOT_DIR/docker-compose.yml" '      - REVIEW_SKIP_DRAFT=${REVIEW_SKIP_DRAFT:-true}'
require_line "$ROOT_DIR/docker-compose.yml" '      - REVIEW_SKIP_EXISTING_SHA=${REVIEW_SKIP_EXISTING_SHA:-true}'
require_line "$ROOT_DIR/docker-compose.yml" '      - REVIEW_ALLOWED_COMMANDS=${REVIEW_ALLOWED_COMMANDS:-/code-review}'
require_line "$ROOT_DIR/docker-compose.yml" '      - LOG_DIR=/app/logs'

echo "Runtime image files look structurally valid."
