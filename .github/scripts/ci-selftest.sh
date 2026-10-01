#!/usr/bin/env bash
# Exercise the self-hosted CI plumbing itself: the toolchain image, the
# dependency install path, the persistent cache mounts, and the container's
# isolation from the host. Runs when the CI files change.
#
#   .github/scripts/ci-selftest.sh
#
# The host needs only Git and Docker. Each check calls ci-run.sh the way a
# real lane does.
# The commands handed to ci-run.sh are single-quoted on purpose: they run in
# the container, which expands them, not this host shell.
# shellcheck disable=SC2016
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

echo "== toolchain image: pinned tools are present"
.github/scripts/ci-run.sh --no-install -- '
  node --version
  pnpm --version
  cargo --version
  rustc --version
  actionlint -version | head -1
  shellcheck --version | head -2
'

echo "== isolation: no host Docker socket, no GitHub credentials, not root"
.github/scripts/ci-run.sh --no-install -- '
  test ! -e /var/run/docker.sock
  test -z "${GITHUB_TOKEN:-}${ACTIONS_RUNTIME_TOKEN:-}${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"
  test "$(id -u)" != 0
  if git config --get-regexp "^http\..*extraheader$"; then
    echo "checkout persisted GitHub credentials" >&2
    exit 1
  fi
'

echo "== install path and one real suite"
.github/scripts/ci-run.sh --target-cache selftest -- 'pnpm exec vitest run --project @paperclipai/skills-catalog'

echo "== rust target cache is mounted writable and per cache name"
.github/scripts/ci-run.sh --no-install --target-cache selftest -- '
  target=packages/paperclip-runner/runner/target
  test -w "$target"
  touch "$target/.ci-selftest"
'
