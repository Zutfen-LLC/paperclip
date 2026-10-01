#!/usr/bin/env bash
# Release canary dry run: what pr-trusted.yml's "Canary Dry Run" job runs.
#
#   .github/scripts/ci-run.sh --target-cache runner -- .github/scripts/ci-canary.sh
#
# release.sh always executes its workspace build, even with --skip-verify, and
# requires a clean tree on a branch named master. The install step may have
# resolved a stale lockfile in place, so stage a changed lockfile into an
# ephemeral local commit; the release script then sees a clean tree and a
# lockfile that matches the manifests. The commit never leaves the checkout.
#
# Not run here: scripts/verify-grok-npm-install.mjs. It starts its own Docker
# containers, which needs the host Docker socket, and the CI container
# deliberately has none.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

git checkout -B master HEAD
if git diff --quiet pnpm-lock.yaml; then
  git checkout -- pnpm-lock.yaml
else
  git add pnpm-lock.yaml
  git -c user.email=ci@paperclip.local -c user.name=CI \
    commit --no-verify -m "ci(canary): stage regenerated lockfile"
fi
./scripts/release.sh canary --skip-verify --dry-run
