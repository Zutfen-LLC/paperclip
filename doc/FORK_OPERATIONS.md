# Working fork and exact-revision POC deployments

## Authority and upstream synchronization

`Zutfen-LLC/paperclip` (`master`) is our working authority. `paperclipai/paperclip`
is the upstream synchronization source, not our push or PR destination.
Configure `origin` to the working fork and `upstream` to the source. Fetch both
with pruning before reconciliation. Review upstream changes deliberately,
preserve intentional fork changes, and test the resulting exact revision.
Keep fork patches narrow and regression-covered. Upstream absorption is welcome,
but is not required to operate this fork. Review accumulating drift explicitly;
do not silently substitute upstream HEAD for fork master.

## Hermes hardening contract and boundary

Operator cancellation targets only the run ID returned by that execution's
create request. A successful stop response is not termination proof: the adapter
polls the exact run to a terminal status before emitting an acknowledged
`executionCancellation` receipt. An already-completed/failed terminal race proves
termination, not that cancellation caused the termination. Failed stop requests,
missing/nonterminal status, and explicit mismatched status identity do not prove
successful cancellation. Duplicate cancellation is safe; timeout remains a
separate result path.

The runtime payload supplies the actual model/provider; the runner identity is
not a model. Gateway token counters are mapped directly, cache reads map to
cached input, and `usageBasis: "per_run"` prevents cumulative-session subtraction.
Cache-write tokens have no Paperclip summary field and are not invented or added
to another counter. No price is inferred: unsupported cost is `unpriced`.

The current Hermes Gateway run protocol lacks structured per-run environment or
metadata transport. The POC uses the task-bridge/systemd environment plus skill
pattern described in `doc/HERMES_GATEWAY_ONBOARDING.md`. Deployment credentials
stay in private runtime configuration, never prompts or this repository. Generic
environment transport, pricing, single-flight redesign, and Ops integration are
outside this patch.

Cancellation during create is observed once the accepted run ID becomes
available, then that exact run is stopped. A create request that never responds
has no recoverable ID in the current protocol; fixing admission idempotency or
lookup-by-key is a separate protocol project. Stop verification itself is bounded
and does not acknowledge unknown termination. Cancellation payloads on the
validated Gateway version may omit usage/runtime: absent counters are not
fabricated. Normal-run telemetry is compared against the terminal payload.

## Build an exact-SHA release (Linux x86-64 POC)

Use a clean checkout of a full 40-character fork SHA, not a registry Paperclip
package with manual source overlays. Tested build tools: Node `24.21.0`, pnpm
`9.15.4` (the root `packageManager` pin), Rust/Cargo `1.98.1`, Python `3.13.5`.
The repository requires Node >=24.11.0. Linux native dependencies and the runner
binary must be built on a compatible Linux x86-64 host. CT152 needs Node at
runtime, not a compiler or Git; building on the controlled build host is supported.

```sh
git clone https://github.com/Zutfen-LLC/paperclip.git fork-build
cd fork-build
git checkout --detach "$FORK_SHA"
test "$(git rev-parse HEAD)" = "$FORK_SHA"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
python3 scripts/fork/package-exact-head.py \
  --output "$RELEASE_DIR/paperclip-$FORK_SHA.tar.gz"
```

The packager refuses tracked source drift, stale server build stamps, missing
artifacts, nonportable symlinks, and output overwrites. It includes `git archive`
source plus the built workspace's dist directories/native runner and complete
locked dependency layout, preserving relative workspace links. It projects the
existing pnpm hoist aliases for the bundled CLI's transitive bare imports; it does
not download registry Paperclip packages. Workspace runtime manifests use their
canonical `publishConfig` entrypoints; original manifests are retained alongside
as `package.source.json`. This selects built JavaScript rather than requiring a
TypeScript loader on CT152. It adds
`fork-release.json` (commit, tree, lockfile hash, tool versions) and a separate
archive SHA-256. Do not use `build:npm` followed by installing registry
`@paperclipai/server`: that can mix an exact-head CLI with a different server.

Transfer the archive and checksum over existing operator SSH. Verify checksum
before extraction into a new, immutable release directory such as
`~/.paperclip/fork/releases/<full-sha>/release`. Entry point:
`/usr/bin/node <release>/cli/dist/index.js run --instance default`.
`server/dist/build-info.json` must contain the same SHA. `/api/health.commit`
provides deployed revision identity without relying on Git being installed.

## CT152 state and temporary validation

The existing service is the `paperclipai.service` systemd user unit. Its managed
shim resolves `~/.paperclip/cli/current` to the temporary installed npm tree
`2026.831.0`, containing era-matched overlays. The observed health revision is
`8fd872295ab1394cd8b168c83b8dfa9d6d95bfad`, not a reproducible fork release.
Keep that tree and shim untouched until review/merge authorization.

Preserve the entire `~/.paperclip/instances/default` directory: embedded
PostgreSQL `db`, `config.json`, `.env`, secrets, logs, backups, storage, and runtime
metadata. Existing PostgreSQL listens on port 54329. The service runs as
`paperclip`; never start the embedded database as root. Preserve both existing
tunnel services and all listener/auth settings.

Before any switch, verify there are no active runs, stop the app user unit, and
confirm its embedded PostgreSQL exited. Make a private, consistent full-instance
archive, plus unit/shim/current-pointer receipts. Verify archive readability and
hashes. Never copy a live database as a rollback snapshot.

For an unreviewed exact-head validation, use an offline copy of this existing POC
state under a private validation home on the same CT152, with the same instance
and entity IDs. Point only its database/log/storage/backup paths at that copy.
Start the candidate through a temporary systemd user drop-in with an exact
release entrypoint and validation `PAPERCLIP_HOME`. Also set `HOME` to that private
validation home: otherwise the CLI doctor sees the original account's managed
shim but no corresponding install manifest in the copied home. No managed install
checks need to be disabled. Keep the original unit,
original instance, and era install intact; never run both servers/databases
simultaneously. This allows candidate migrations on the copied state while
leaving the original DB untouched. Retain the validation state and E2E evidence
for review rather than overwriting the original history. No blank-instance
bootstrap, state reset, new LXC, listener change, or auth change is needed.

Rollback after validation: stop candidate, confirm its DB exited, remove only
the validation drop-in, reload the user manager, and start the original unit.
Verify health reports the original era SHA, original history remains readable,
and both tunnel directions still work. A binary-only rollback against a migrated
original database is not assumed safe.

## Authorized post-merge cutover

After explicit maintainer authorization, build the exact selected merged fork
SHA using the recipe above. Stage a fresh release, make another stopped-state
backup, then change the app entrypoint only; retain the original instance paths.
The normal startup migration mechanism applies the fork's pending migrations.
Inspect migration SQL versus the deployed era and test it against the offline
copy first. Stop if destructive reset is required; never force a blank database.

On a failed authorized migration, stop the candidate and preserve its failed
state for diagnosis. Restore the complete stopped-state instance snapshot and
original app entrypoint together, never an arbitrary mix of old code and new
schema. Coordinate this rollback before accepting new live writes.

Health gate: user service active; HTTP 200 from `/api/health`; exact expected
`commit`; authenticated/private exposure unchanged; existing agents/issues/run
history readable; Gateway tunnel healthy; a short coding run works and operator
cancel stops the exact remote run. Keep release SHA, checksum, build log,
migration receipt, state snapshot, and rollback command together.
