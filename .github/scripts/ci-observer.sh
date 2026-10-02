#!/usr/bin/env bash
# Build, typecheck and test the Ops observer plugin (plugins-experimental/).
#
#   .github/scripts/ci-run.sh --target-cache tests -- .github/scripts/ci-observer.sh
#
# The plugin is not a pnpm workspace member, so `pnpm install` gives it no
# node_modules. This links just what its build, typecheck and tests resolve
# (the plugin SDK, React and its types) from packages the workspace already
# installed, runs the checks, and removes the links again. Nothing is
# installed, and nothing outside the checkout is touched.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

pnpm run preflight:workspace-links
# Builds @paperclipai/shared and @paperclipai/plugin-sdk (dist/bundlers.js,
# which the plugin's esbuild config imports).
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps

cd plugins-experimental/plugin-ops-observer
cleanup() {
  rm -rf node_modules dist
}
trap cleanup EXIT
cleanup

mkdir -p node_modules/@paperclipai node_modules/@types
ln -s ../../../../packages/plugins/sdk node_modules/@paperclipai/plugin-sdk
ln -s ../../../../server/node_modules/@types/node node_modules/@types/node
ln -s ../../../../ui/node_modules/@types/react node_modules/@types/react
ln -s ../../../ui/node_modules/react node_modules/react
ln -s ../../../ui/node_modules/react-dom node_modules/react-dom

node esbuild.config.mjs
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node --test test/*.test.mjs
