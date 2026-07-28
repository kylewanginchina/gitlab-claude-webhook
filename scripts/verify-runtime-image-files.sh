#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="$ROOT_DIR/docker-entrypoint.sh"

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

require_regex() {
  local file="$1"
  local regex="$2"
  grep -Eq "$regex" "$file" || {
    echo "Missing pattern '$regex' in ${file#$ROOT_DIR/}" >&2
    exit 1
  }
}

require_executable() {
  local file="$1"
  [[ -x "$file" ]] || {
    echo "Expected executable file: ${file#$ROOT_DIR/}" >&2
    exit 1
  }
}

require_entrypoint_contract() {
  require_executable "$ENTRYPOINT"
  sh -n "$ENTRYPOINT"
  require_regex "$ENTRYPOINT" '^[[:space:]]*canonicalize_runtime_path\(\)'
  require_text "$ENTRYPOINT" 'fs.realpathSync.native'
  require_text "$ENTRYPOINT" 'allowedPaths.includes(canonicalPath)'
  require_text "$ENTRYPOINT" '/app/data'
  require_text "$ENTRYPOINT" '/app/logs'
  require_text "$ENTRYPOINT" '/tmp/gitlab-claude-work'
  require_text "$ENTRYPOINT" 'DEEPFLOW_BUILD_TOOLS_ENABLED'
  require_text "$ENTRYPOINT" '/home/claude/.cargo'
  require_text "$ENTRYPOINT" '/home/claude/.cache'
  require_text "$ENTRYPOINT" '/home/claude/go'
  require_text "$ENTRYPOINT" '/home/claude/.npm'
  require_text "$ENTRYPOINT" '/tmp/deepflow-work'
  require_text "$ENTRYPOINT" 'chown -R -h 1001:1001 "$canonical_dir"'
  require_text "$ENTRYPOINT" 'exec su-exec 1001:1001 "$@"'
  require_text "$ENTRYPOINT" 'exec gosu 1001:1001 "$@"'
}

require_dockerfile_contract() {
  local dockerfile="$1"
  local privilege_tool="$2"

  require_regex "$dockerfile" "^[[:space:]]*COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh$"
  require_line "$dockerfile" 'ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]'
  if [[ "$privilege_tool" == "su-exec" ]]; then
    require_regex "$dockerfile" '^[[:space:]]*RUN apk add --no-cache .*su-exec$'
  else
    require_regex "$dockerfile" '^[[:space:]]*gosu[[:space:]]*\\$'
  fi
  if grep -Eq '^[[:space:]]*USER[[:space:]]+' "$dockerfile"; then
    echo "Unexpected USER instruction in ${dockerfile#$ROOT_DIR/}; entrypoint must start as root." >&2
    exit 1
  fi
}

require_entrypoint_contract
require_dockerfile_contract "$ROOT_DIR/Dockerfile" su-exec
require_dockerfile_contract "$ROOT_DIR/Dockerfile.deepflow" gosu

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
