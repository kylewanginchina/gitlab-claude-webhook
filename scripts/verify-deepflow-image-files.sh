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

require_file "$DOCKERFILE"
require_file "$COMPOSE_FILE"

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

for volume in \
  deepflow-cargo-registry \
  deepflow-cargo-git \
  deepflow-go-cache \
  deepflow-npm-cache \
  deepflow-work; do
  require_text "$COMPOSE_FILE" "$volume"
done

require_text "$COMPOSE_FILE" "Dockerfile.deepflow"
require_text "$COMPOSE_FILE" "gitlab-claude-webhook-deepflow"
require_text "$COMPOSE_FILE" "DEEPFLOW_RUSTUP_INIT_URL"
require_text "$COMPOSE_FILE" "DEEPFLOW_RUSTUP_DIST_SERVER"
require_text "$COMPOSE_FILE" "DEEPFLOW_RUSTUP_UPDATE_ROOT"

echo "DeepFlow image files look structurally valid."
