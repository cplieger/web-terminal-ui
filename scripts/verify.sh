#!/usr/bin/env bash
# Local pre-publish verification for @cplieger/web-terminal-ui.
#
# The engine (@cplieger/web-terminal) is not published yet, so npm cannot
# resolve the peer dependency. This script overlays the LOCAL working-tree
# engine into node_modules/@cplieger/web-terminal (the same technique vibecli's
# dev-build.sh uses) and then runs the real gates: tsgo typecheck (source +
# tests) and vitest.
#
# Not for CI or release — CI resolves the published engine. The overlay dir is
# gitignored. Override the engine location with ENGINE_DIR=... if the sibling
# checkout lives elsewhere (default ../vterm; the engine's local directory is
# still named vterm until its directory/GitHub rename).
set -euo pipefail
cd "$(dirname "$0")/.."

ENGINE_DIR="${ENGINE_DIR:-../vterm}"
PKG="node_modules/@cplieger/web-terminal"

if [ ! -d "$ENGINE_DIR/web/src" ]; then
  echo "error: engine source not found at $ENGINE_DIR/web/src" >&2
  echo "       set ENGINE_DIR to the local @cplieger/web-terminal checkout" >&2
  exit 1
fi

echo "[1/4] overlay local engine -> $PKG"
mkdir -p "$PKG/src"
find "$PKG/src" -maxdepth 1 -name '*.ts' -delete
# Ship only runtime source; tests/fuzz/setup pull in vitest/fast-check which
# aren't installed in this package's node_modules and would break the typecheck.
for f in "$ENGINE_DIR"/web/src/*.ts; do
  case "$f" in
    *.test.ts | *fuzz* | *fc-strict-setup*) continue ;;
  esac
  cp "$f" "$PKG/src/"
done
# Minimal manifest so bundler resolution maps the bare specifier to src.
cp "$ENGINE_DIR/web/package.json" "$PKG/package.json"

echo "[2/4] tsgo typecheck (source)"
tsgo -p tsconfig.json

echo "[3/4] tsgo typecheck (tests)"
tsgo -p tsconfig.test.json

echo "[4/4] vitest"
npx vitest --run

echo "OK"
