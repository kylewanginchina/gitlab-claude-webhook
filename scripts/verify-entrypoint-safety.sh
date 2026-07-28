#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${ENTRYPOINT_TEST_IMAGE:-gitlab-claude-webhook:runtime-hardening}"
TEST_DIR="$(mktemp -d)"

cleanup() {
  find "$TEST_DIR" -depth -delete
}
trap cleanup EXIT

mkdir -p "$TEST_DIR/mock-bin"
printf '%s\n' \
  '#!/bin/sh' \
  'printf "%s %s\\n" "${0##*/}" "$*" >> "$MOCK_LOG"' \
  'exit 0' >"$TEST_DIR/mock-bin/mock-command"
chmod 0755 "$TEST_DIR/mock-bin/mock-command"
for command in mkdir chown su-exec; do
  ln -s mock-command "$TEST_DIR/mock-bin/$command"
done

verify_rejected() {
  local name="$1"
  local data_dir="$2"
  local log_dir="$3"
  local work_dir="$4"
  local unsafe_path="$5"
  local log_file="$TEST_DIR/$name.log"

  : >"$log_file"
  if docker run --rm --entrypoint /bin/sh \
    -v "$ROOT_DIR/docker-entrypoint.sh:/entrypoint:ro" \
    -v "$TEST_DIR:/test" \
    --env MOCK_LOG="/test/$name.log" \
    --env DATA_DIR="$data_dir" \
    --env LOG_DIR="$log_dir" \
    --env WORK_DIR="$work_dir" \
    "$IMAGE" \
    -c 'set -eu
      ln -s /etc /app/entrypoint-safety-link
      PATH=/test/mock-bin:/usr/local/bin:/usr/bin:/bin
      export PATH MOCK_LOG
      DATA_DIR="$DATA_DIR" LOG_DIR="$LOG_DIR" WORK_DIR="$WORK_DIR" /entrypoint true'; then
    echo "Expected $name path to be rejected, but entrypoint accepted it." >&2
    cat "$log_file" >&2
    exit 1
  fi

  if grep -Fq "chown -R 1001:1001 $unsafe_path" "$log_file"; then
    echo "Expected $name rejection before chown of the unsafe target, got:" >&2
    cat "$log_file" >&2
    exit 1
  fi
}

verify_accepted() {
  local name="$1"
  local data_dir="$2"
  local log_dir="$3"
  local work_dir="$4"
  local log_file="$TEST_DIR/$name.log"

  : >"$log_file"
  docker run --rm --entrypoint /bin/sh \
    -v "$ROOT_DIR/docker-entrypoint.sh:/entrypoint:ro" \
    -v "$TEST_DIR:/test" \
    --env MOCK_LOG="/test/$name.log" \
    --env DATA_DIR="$data_dir" \
    --env LOG_DIR="$log_dir" \
    --env WORK_DIR="$work_dir" \
    "$IMAGE" \
    -c 'set -eu
      PATH=/test/mock-bin:/usr/local/bin:/usr/bin:/bin
      export PATH MOCK_LOG
      DATA_DIR="$DATA_DIR" LOG_DIR="$LOG_DIR" WORK_DIR="$WORK_DIR" /entrypoint true'

  for path in "$data_dir" "$log_dir" "$work_dir"; do
    grep -Fq "chown -R 1001:1001 $path" "$log_file" || {
      echo "Expected normal path $path to be chowned." >&2
      cat "$log_file" >&2
      exit 1
    }
  done
}

verify_accepted normal /app/entrypoint-safety-data /app/entrypoint-safety-logs /tmp/entrypoint-safety-work
verify_rejected traversal /app/../etc /app/logs /tmp/gitlab-claude-work /app/../etc
verify_rejected tmp-traversal /app/data /app/logs /tmp/../../etc /tmp/../../etc
verify_rejected symlink /app/entrypoint-safety-link /app/logs /tmp/gitlab-claude-work /app/entrypoint-safety-link

echo "Entrypoint rejects traversal and symlink escape paths before chown."
