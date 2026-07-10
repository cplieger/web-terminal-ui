#!/usr/bin/env bash
# Local pre-publish verification for @cplieger/web-terminal-ui.
#
# The engine (@cplieger/web-terminal-engine) is not published yet, so npm cannot
# resolve the peer dependency. This script overlays the LOCAL working-tree
# engine into node_modules/@cplieger/web-terminal-engine (the same technique web-terminal-kiro's
# dev-build.sh uses) and then runs the real gates: tsc typecheck (source +
# tests) and vitest.
#
# Not for CI or release — CI resolves the published engine. The overlay dir is
# gitignored. Override the engine location with ENGINE_DIR=... if the sibling
# checkout lives elsewhere (default ../web-terminal-engine).
set -euo pipefail
cd "$(dirname "$0")/.."

ENGINE_DIR="${ENGINE_DIR:-../web-terminal-engine}"
PKG="node_modules/@cplieger/web-terminal-engine"

if [ ! -d "$ENGINE_DIR/web/src" ]; then
  printf '%s\n' "error: engine source not found at $ENGINE_DIR/web/src" >&2
  printf '%s\n' "       set ENGINE_DIR to the local @cplieger/web-terminal-engine checkout" >&2
  exit 1
fi

printf '%s\n' "[1/4] overlay local engine -> $PKG"
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

printf '%s\n' "[2/4] tsc typecheck (source)"
npx tsc -p tsconfig.json

printf '%s\n' "[3/4] tsc typecheck (tests)"
npx tsc -p tsconfig.test.json

printf '%s\n' "[4/4] vitest"
npx vitest --run

printf '%s\n' "OK"
