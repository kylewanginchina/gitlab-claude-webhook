#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
LOG_DIR="${LOG_DIR:-/app/logs}"
WORK_DIR="${WORK_DIR:-/tmp/gitlab-claude-work}"

for dir in "$DATA_DIR" "$LOG_DIR" "$WORK_DIR"; do
  case "$dir" in
    /app/?*|/tmp/?*) ;;
    *)
      echo "Refusing to change ownership of unsafe runtime path: $dir" >&2
      exit 1
      ;;
  esac
  mkdir -p "$dir"
  chown -R 1001:1001 "$dir"
done

if command -v su-exec >/dev/null 2>&1; then
  exec su-exec 1001:1001 "$@"
fi

if command -v gosu >/dev/null 2>&1; then
  exec gosu 1001:1001 "$@"
fi

echo "Neither su-exec nor gosu is available" >&2
exit 1
