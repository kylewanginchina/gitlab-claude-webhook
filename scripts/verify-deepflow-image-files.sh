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

for tool in node npm cargo rustc go protoc clang make pkg-config rg; do
  require_text "$DOCKERFILE" "command -v $tool"
done

for package in \
  build-essential \
  cargo \
  clang \
  golang-go \
  llvm \
  libpcap-dev \
  libelf-dev \
  protobuf-compiler \
  pkg-config \
  rustc; do
  require_text "$DOCKERFILE" "$package"
done

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

echo "DeepFlow image files look structurally valid."
