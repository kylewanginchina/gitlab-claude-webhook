#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="$ROOT_DIR/Dockerfile.deepflow"
COMPOSE_FILE="$ROOT_DIR/docker-compose.deepflow.yml"

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

reject_text() {
  local file_path="$1"
  local text="$2"
  if grep -Fq "$text" "$file_path"; then
    echo "Unexpected '${text}' in ${file_path#$ROOT_DIR/}" >&2
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
if [[ -e "$ROOT_DIR/docker-entrypoint.sh" ]]; then
  echo "Unexpected runtime entrypoint: docker-entrypoint.sh" >&2
  exit 1
fi

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
require_line "$DOCKERFILE" 'USER claude'
reject_text "$DOCKERFILE" 'ENTRYPOINT'
reject_text "$DOCKERFILE" 'docker-entrypoint.sh'
reject_text "$DOCKERFILE" 'su-exec'
reject_text "$DOCKERFILE" 'gosu'

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
