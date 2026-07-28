#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${ENTRYPOINT_TEST_IMAGE:-gitlab-claude-webhook:runtime-hardening}"
TEST_DIR="$(mktemp -d)"
CONTAINERS=()

cleanup() {
  for container in "${CONTAINERS[@]}"; do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  find "$TEST_DIR" -depth -delete
}
trap cleanup EXIT

mkdir -p "$TEST_DIR/mock-bin"
mkdir -p "$TEST_DIR/symlink-external"
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
  local container_id
  local entrypoint_status
  container_id="$(docker run -d --entrypoint /bin/sh \
    -v "$ROOT_DIR/docker-entrypoint.sh:/entrypoint:ro" \
    -v "$TEST_DIR:/test" \
    --env MOCK_LOG="/test/$name.log" \
    --env DATA_DIR="$data_dir" \
    --env LOG_DIR="$log_dir" \
    --env WORK_DIR="$work_dir" \
    "$IMAGE" \
    -c 'set -eu
      ln -s /test/symlink-external /app/entrypoint-safety-link
      PATH=/test/mock-bin:/usr/local/bin:/usr/bin:/bin
      export PATH MOCK_LOG
      DATA_DIR="$DATA_DIR" LOG_DIR="$LOG_DIR" WORK_DIR="$WORK_DIR" /entrypoint true')"
  CONTAINERS+=("$container_id")
  entrypoint_status="$(docker wait "$container_id")"
  docker rm "$container_id" >/dev/null
  if [[ "$entrypoint_status" == "0" ]]; then
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

verify_toctou_external_target_unchanged() {
  local race_dir="$TEST_DIR/toctou-bin"
  local external_target="$TEST_DIR/toctou-external"
  local target_sentinel="$external_target/sentinel"
  local external_child="$external_target/toctou-child"
  local child_sentinel="$external_child/sentinel"

  mkdir -p "$race_dir" "$external_target"
  : >"$target_sentinel"
  chown 0:0 "$external_target" "$target_sentinel"

  printf '%s\n' \
    '#!/bin/sh' \
    'if [ "$1" = "-p" ] && [ "$2" = "/app/data/toctou-child" ]; then' \
    '  /bin/rmdir /app/data/toctou-child' \
    '  /bin/rmdir /app/data' \
    '  /bin/ln -s /test/toctou-external /app/data' \
    '  /bin/mkdir -p /app/data/toctou-child' \
    '  /bin/touch /app/data/toctou-child/sentinel' \
    'fi' \
    'exit 0' >"$race_dir/mkdir"
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$race_dir/su-exec"
  chmod 0755 "$race_dir/mkdir" "$race_dir/su-exec"

  local container_id
  local entrypoint_status
  container_id="$(docker run -d --entrypoint /bin/sh \
    -v "$ROOT_DIR/docker-entrypoint.sh:/entrypoint:ro" \
    -v "$TEST_DIR:/test" \
    "$IMAGE" \
    -c 'set -eu
      mkdir -p /app/data/toctou-child
      chown 0:0 /test/toctou-external /test/toctou-external/sentinel
      PATH=/test/toctou-bin:/usr/local/bin:/usr/bin:/bin
      export PATH
      DATA_DIR=/app/data/toctou-child LOG_DIR=/app/logs WORK_DIR=/tmp/gitlab-claude-work /entrypoint true')"
  CONTAINERS+=("$container_id")
  entrypoint_status="$(docker wait "$container_id")"
  docker rm "$container_id" >/dev/null

  local target_owner
  local target_sentinel_owner
  target_owner="$(stat -c %u:%g "$external_target")"
  target_sentinel_owner="$(stat -c %u:%g "$target_sentinel")"
  if [[ "$target_owner" != "0:0" || "$target_sentinel_owner" != "0:0" ]]; then
    echo "TOCTOU changed external target ownership: target=$target_owner sentinel=$target_sentinel_owner" >&2
    exit 1
  fi
  if [[ -e "$external_child" ]]; then
    local child_owner
    local child_sentinel_owner
    child_owner="$(stat -c %u:%g "$external_child")"
    child_sentinel_owner="$(stat -c %u:%g "$child_sentinel")"
    if [[ "$child_owner" != "0:0" || "$child_sentinel_owner" != "0:0" ]]; then
      echo "TOCTOU changed external child ownership: child=$child_owner sentinel=$child_sentinel_owner status=$entrypoint_status" >&2
      exit 1
    fi
  fi
  if [[ "$entrypoint_status" == "0" && ! -e "$external_child" ]]; then
    echo "TOCTOU entrypoint accepted the race path without creating its child." >&2
    exit 1
  fi
}

verify_final_symlink_target_unchanged() {
  local race_dir="$TEST_DIR/final-link-bin"
  local external_target="$TEST_DIR/final-link-external"
  local sentinel="$external_target/sentinel"

  mkdir -p "$race_dir" "$external_target"
  : >"$sentinel"
  chown 0:0 "$external_target" "$sentinel"

  printf '%s\n' \
    '#!/bin/sh' \
    'if [ "$1" = "-p" ] && [ "$2" = "/app/data" ]; then' \
    '  /bin/rmdir /app/data' \
    '  /bin/ln -s /test/final-link-external /app/data' \
    '  /bin/mkdir -p /app/data' \
    'fi' \
    'exit 0' >"$race_dir/mkdir"
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$race_dir/su-exec"
  chmod 0755 "$race_dir/mkdir" "$race_dir/su-exec"

  docker run --rm --entrypoint /bin/sh \
    -v "$ROOT_DIR/docker-entrypoint.sh:/entrypoint:ro" \
    -v "$TEST_DIR:/test" \
    "$IMAGE" \
    -c 'set -eu
      chown 0:0 /test/final-link-external /test/final-link-external/sentinel
      PATH=/test/final-link-bin:/usr/local/bin:/usr/bin:/bin
      export PATH
      DATA_DIR=/app/data LOG_DIR=/app/logs WORK_DIR=/tmp/gitlab-claude-work /entrypoint true'

  local target_owner
  local sentinel_owner
  target_owner="$(stat -c %u:%g "$external_target")"
  sentinel_owner="$(stat -c %u:%g "$sentinel")"
  if [[ "$target_owner" != "0:0" || "$sentinel_owner" != "0:0" ]]; then
    echo "Final symlink race changed external ownership: target=$target_owner sentinel=$sentinel_owner" >&2
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
    grep -Fq "chown -R -h 1001:1001 $path" "$log_file" || {
      echo "Expected normal path $path to be chowned." >&2
      cat "$log_file" >&2
      exit 1
    }
  done
}

verify_preexisting_symlink_rejected() {
  local log_file="$TEST_DIR/preexisting-symlink.log"

  : >"$log_file"
  local container_id
  local entrypoint_status
  container_id="$(docker run -d --entrypoint /bin/sh \
    -v "$ROOT_DIR/docker-entrypoint.sh:/entrypoint:ro" \
    -v "$TEST_DIR:/test" \
    --env MOCK_LOG=/test/preexisting-symlink.log \
    "$IMAGE" \
    -c 'set -eu
      rmdir /app/data
      ln -s /test/symlink-external /app/data
      PATH=/test/mock-bin:/usr/local/bin:/usr/bin:/bin
      export PATH MOCK_LOG
      DATA_DIR=/app/data LOG_DIR=/app/logs WORK_DIR=/tmp/gitlab-claude-work /entrypoint true')"
  CONTAINERS+=("$container_id")
  entrypoint_status="$(docker wait "$container_id")"
  docker rm "$container_id" >/dev/null
  if [[ "$entrypoint_status" == "0" ]]; then
    echo "Expected pre-existing allowed-path symlink to be rejected." >&2
    cat "$log_file" >&2
    exit 1
  fi

  if grep -Fq 'chown -R -h 1001:1001 /app/data' "$log_file"; then
    echo "Expected pre-existing symlink rejection before chown." >&2
    cat "$log_file" >&2
    exit 1
  fi
}

verify_accepted normal /app/data /app/logs /tmp/gitlab-claude-work
verify_rejected empty-data-dir '' /app/logs /tmp/gitlab-claude-work ''
verify_rejected empty-log-dir /app/data '' /tmp/gitlab-claude-work ''
verify_rejected empty-work-dir /app/data /app/logs '' ''
verify_rejected traversal /app/../etc /app/logs /tmp/gitlab-claude-work /app/../etc
verify_rejected tmp-traversal /app/data /app/logs /tmp/../../etc /tmp/../../etc
verify_rejected symlink /app/entrypoint-safety-link /app/logs /tmp/gitlab-claude-work /app/entrypoint-safety-link
verify_preexisting_symlink_rejected
verify_toctou_external_target_unchanged
verify_final_symlink_target_unchanged

echo "Entrypoint rejects unsafe paths and preserves TOCTOU external targets."
