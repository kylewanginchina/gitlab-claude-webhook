#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

# Copy only public build inputs needed by the structural checks; never copy .env.
cp "$ROOT_DIR/Dockerfile" "$ROOT_DIR/Dockerfile.deepflow" \
  "$ROOT_DIR/docker-compose.yml" "$ROOT_DIR/docker-compose.deepflow.yml" "$FIXTURE_DIR/"
cp -R "$ROOT_DIR/review-skills" "$FIXTURE_DIR/review-skills"

expect_rejected() {
  local check="$1"
  local expected="$2"
  if bash "$ROOT_DIR/scripts/$check" "$FIXTURE_DIR" >"$FIXTURE_DIR/check.log" 2>&1; then
    echo "Expected $check to reject fixture: $expected" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$FIXTURE_DIR/check.log"; then
    cat "$FIXTURE_DIR/check.log" >&2
    echo "Unexpected rejection from $check; expected: $expected" >&2
    exit 1
  fi
}

for image in runtime deepflow; do
  check="verify-$image-image-files.sh"
  dockerfile="Dockerfile"
  if [[ "$image" == deepflow ]]; then dockerfile="Dockerfile.deepflow"; fi
  bash "$ROOT_DIR/scripts/$check" "$FIXTURE_DIR" >/dev/null

  cp "$FIXTURE_DIR/$dockerfile" "$FIXTURE_DIR/dockerfile.backup"
  sed '\|^COPY review-skills/ ./review-skills/$|d' "$FIXTURE_DIR/dockerfile.backup" >"$FIXTURE_DIR/$dockerfile"
  expect_rejected "$check" 'COPY review-skills/ ./review-skills/'
  mv "$FIXTURE_DIR/dockerfile.backup" "$FIXTURE_DIR/$dockerfile"

  for asset in review-skills/.claude-plugin/plugin.json review-skills/skills/mr-review-core/SKILL.md; do
    mv "$FIXTURE_DIR/$asset" "$FIXTURE_DIR/asset.backup"
    expect_rejected "$check" "Missing or empty review skill asset: $asset"
    touch "$FIXTURE_DIR/$asset"
    expect_rejected "$check" "Missing or empty review skill asset: $asset"
    printf '%s\n' 'invalid asset contents' >"$FIXTURE_DIR/$asset"
    expect_rejected "$check" "$asset"
    mv "$FIXTURE_DIR/asset.backup" "$FIXTURE_DIR/$asset"
  done
done

echo "Both image checks rejected omitted COPY, missing, empty, and invalid skill assets."
