#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
LOG_DIR="${LOG_DIR:-/app/logs}"
WORK_DIR="${WORK_DIR:-/tmp/gitlab-claude-work}"

canonicalize_runtime_path() {
  node - "$1" <<'NODE'
const fs = require('fs');
const path = require('path');

const input = process.argv[2];
const allowedRoots = ['/app', '/tmp'];

function isWithinAllowedRoot(candidate) {
  return allowedRoots.some((root) => candidate.startsWith(`${root}${path.sep}`));
}

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
  if (!isWithinAllowedRoot(canonicalPath)) {
    throw new Error('path resolves outside approved runtime roots');
  }

  process.stdout.write(`${canonicalPath}\n`);
} catch (error) {
  console.error(`Refusing unsafe runtime path: ${input}`);
  process.exit(1);
}
NODE
}

for dir in "$DATA_DIR" "$LOG_DIR" "$WORK_DIR"; do
  canonical_dir="$(canonicalize_runtime_path "$dir")" || exit 1
  mkdir -p "$canonical_dir"
  chown -R 1001:1001 "$canonical_dir"
done

if command -v su-exec >/dev/null 2>&1; then
  exec su-exec 1001:1001 "$@"
fi

if command -v gosu >/dev/null 2>&1; then
  exec gosu 1001:1001 "$@"
fi

echo "Neither su-exec nor gosu is available" >&2
exit 1
