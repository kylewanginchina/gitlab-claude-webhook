#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$ROOT_DIR/Dockerfile.deepflow"
COMPOSE_FILE="$ROOT_DIR/docker-compose.deepflow.yml"
ENTRYPOINT="$ROOT_DIR/docker-entrypoint.sh"

require_file() {
  local file_path="$1"
  if [[ ! -f "$file_path" ]]; then
    echo "Missing required file: ${file_path#$ROOT_DIR/}" >&2
    exit 1
  fi
}

require_text() {
  local file_path="$1"
  local text="$2"
  if ! grep -Fq "$text" "$file_path"; then
    echo "Missing '${text}' in ${file_path#$ROOT_DIR/}" >&2
    exit 1
  fi
}

require_line() {
  local file_path="$1"
  local text="$2"
  if ! grep -Fxq "$text" "$file_path"; then
    echo "Missing exact line '$text' in ${file_path#$ROOT_DIR/}" >&2
    exit 1
  fi
}

require_regex() {
  local file_path="$1"
  local regex="$2"
  if ! grep -Eq "$regex" "$file_path"; then
    echo "Missing pattern '$regex' in ${file_path#$ROOT_DIR/}" >&2
    exit 1
  fi
}

require_file "$DOCKERFILE"
require_file "$COMPOSE_FILE"
require_file "$ENTRYPOINT"
[[ -x "$ENTRYPOINT" ]] || { echo "Entrypoint is not executable" >&2; exit 1; }
sh -n "$ENTRYPOINT"
require_regex "$ENTRYPOINT" '^[[:space:]]*canonicalize_runtime_path\(\)'
require_text "$ENTRYPOINT" 'fs.realpathSync.native'
require_text "$ENTRYPOINT" 'allowedPaths.includes(canonicalPath)'
require_text "$ENTRYPOINT" 'DEEPFLOW_BUILD_TOOLS_ENABLED'
require_text "$ENTRYPOINT" 'chown -R -h 1001:1001 "$canonical_dir"'
require_text "$ENTRYPOINT" 'exec gosu 1001:1001 "$@"'

require_text "$DOCKERFILE" "ARG DEBIAN_MIRROR"
require_text "$DOCKERFILE" "ARG DEBIAN_SECURITY_MIRROR"
require_text "$DOCKERFILE" "ARG RUSTUP_INIT_URL"
require_text "$DOCKERFILE" "ARG RUSTUP_DIST_SERVER"
require_text "$DOCKERFILE" "ARG RUSTUP_UPDATE_ROOT"

for tool in node npm rustup cargo rustc go protoc clang make pkg-config rg; do
  require_text "$DOCKERFILE" "command -v $tool"
done

for package in \
  build-essential \
  clang \
  golang-go \
  llvm \
  libssl-dev \
  libpcap-dev \
  libelf-dev \
  protobuf-compiler \
  pkg-config; do
  require_text "$DOCKERFILE" "$package"
done

require_text "$DOCKERFILE" "https://rsproxy.cn/rustup/dist/x86_64-unknown-linux-gnu/rustup-init"
require_text "$DOCKERFILE" "rustup component add rustfmt clippy"
require_text "$DOCKERFILE" "cargo metadata --locked --format-version=1"
require_regex "$DOCKERFILE" '^[[:space:]]*gosu[[:space:]]*\\$'
require_line "$DOCKERFILE" 'COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh'
require_line "$DOCKERFILE" 'ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]'
if grep -Eq '^[[:space:]]*USER[[:space:]]+' "$DOCKERFILE"; then
  echo "Unexpected USER instruction in Dockerfile.deepflow; entrypoint must start as root." >&2
  exit 1
fi

for volume in \
  webhook-work \
  deepflow-cargo-registry \
  deepflow-cargo-git \
  deepflow-go-cache \
  deepflow-go-mod-cache \
  deepflow-npm-cache \
  deepflow-work; do
  require_text "$COMPOSE_FILE" "$volume"
done

require_line "$COMPOSE_FILE" '      - webhook-work:/tmp/gitlab-claude-work'
require_line "$COMPOSE_FILE" '      - deepflow-work:/tmp/deepflow-work'
require_line "$COMPOSE_FILE" '      - deepflow-cargo-registry:/home/claude/.cargo/registry'
require_line "$COMPOSE_FILE" '      - deepflow-cargo-git:/home/claude/.cargo/git'
require_line "$COMPOSE_FILE" '      - deepflow-go-cache:/home/claude/.cache/go-build'
require_line "$COMPOSE_FILE" '      - deepflow-go-mod-cache:/home/claude/go/pkg/mod'
require_line "$COMPOSE_FILE" '      - deepflow-npm-cache:/home/claude/.npm'

require_text "$COMPOSE_FILE" "Dockerfile.deepflow"
require_text "$COMPOSE_FILE" "gitlab-claude-webhook-deepflow"
require_text "$COMPOSE_FILE" "DEEPFLOW_RUSTUP_INIT_URL"
require_text "$COMPOSE_FILE" "DEEPFLOW_RUSTUP_DIST_SERVER"
require_text "$COMPOSE_FILE" "DEEPFLOW_RUSTUP_UPDATE_ROOT"

echo "DeepFlow image files look structurally valid."
