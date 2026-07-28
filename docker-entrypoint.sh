#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
LOG_DIR="${LOG_DIR:-/app/logs}"
WORK_DIR="${WORK_DIR:-/tmp/gitlab-claude-work}"

canonicalize_runtime_path() {
  node - "$1" "$2" <<'NODE'
const fs = require('fs');
const path = require('path');

const input = process.argv[2];
const allowedPaths = process.argv[3].split('\n').filter(Boolean);

try {
  if (!path.isAbsolute(input)) {
    throw new Error('path must be absolute');
  }

  const lexicalPath = path.resolve(input);
  let existingParent = lexicalPath;
  const missingParts = [];

  while (true) {
    try {
      if (!fs.statSync(existingParent).isDirectory()) {
        throw new Error('path is not a directory');
      }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      try {
        if (fs.lstatSync(existingParent).isSymbolicLink()) {
          throw new Error('path contains a broken symbolic link');
        }
      } catch (linkError) {
        if (linkError.code !== 'ENOENT') {
          throw linkError;
        }
      }

      const parent = path.dirname(existingParent);
      if (parent === existingParent) {
        throw new Error('no existing parent directory');
      }
      missingParts.unshift(path.basename(existingParent));
      existingParent = parent;
    }
  }

  const canonicalParent = fs.realpathSync.native(existingParent);
  const canonicalPath = path.join(canonicalParent, ...missingParts);
  if (!allowedPaths.includes(canonicalPath)) {
    throw new Error('path is not an approved runtime directory');
  }

  process.stdout.write(`${canonicalPath}\n`);
} catch (error) {
  console.error(`Refusing unsafe runtime path: ${input}`);
  process.exit(1);
}
NODE
}

if [ "$DATA_DIR" != "/app/data" ] || \
  [ "$LOG_DIR" != "/app/logs" ] || \
  [ "$WORK_DIR" != "/tmp/gitlab-claude-work" ]; then
  echo "Refusing unsupported runtime directory configuration" >&2
  exit 1
fi

allowed_runtime_dirs='/app/data
/app/logs
/tmp/gitlab-claude-work'

if [ "${DEEPFLOW_BUILD_TOOLS_ENABLED:-false}" = "true" ]; then
  allowed_runtime_dirs="$allowed_runtime_dirs
/home/claude/.cargo
/home/claude/.cache
/home/claude/go
/home/claude/.npm
/tmp/deepflow-work"
fi

set -f
for dir in $allowed_runtime_dirs; do
  canonical_dir="$(canonicalize_runtime_path "$dir" "$allowed_runtime_dirs")" || exit 1
  mkdir -p "$canonical_dir"
  chown -R -h 1001:1001 "$canonical_dir"
done
set +f

if command -v su-exec >/dev/null 2>&1; then
  exec su-exec 1001:1001 "$@"
fi

if command -v gosu >/dev/null 2>&1; then
  exec gosu 1001:1001 "$@"
fi

echo "Neither su-exec nor gosu is available" >&2
exit 1
