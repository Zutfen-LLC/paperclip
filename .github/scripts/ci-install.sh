#!/usr/bin/env bash
# Install workspace dependencies inside the CI image (called by ci-run.sh).
set -euo pipefail

# A merge tree can hold a pnpm-lock.yaml that is stale for its manifests (for
# example after merging upstream). Resolve it in place for this run rather than
# failing every lane; the policy lane still validates that resolution succeeds.
if ! pnpm install --frozen-lockfile; then
  echo '::notice title=Lockfile::checked-in lockfile is stale for this merge tree; resolving it inline'
  pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile
  pnpm install --frozen-lockfile
fi
