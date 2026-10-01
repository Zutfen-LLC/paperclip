# Self-hosted CI

This fork's CI runs on a small pool of persistent Docker-backed runners labelled
`[self-hosted, linux, x64]`. It is risk-based: an ordinary pull request runs the
lanes its diff can affect, and the full upstream-equivalent inventory runs
nightly, after merges, on demand, and for pull requests that cannot be bounded.

Files: `.github/workflows/ci.yml` (pull requests), `.github/workflows/ci-full.yml`
(full inventory), `.github/scripts/ci-*` (everything repository-controlled),
`.github/ci.Dockerfile` (toolchain image).

## Shape of a pull request run

```
classify ──┬─ policy                 always
           ├─ static                 typecheck + build (+ extra steps below)
           ├─ tests_server (1..3)    selected server suites, sharded by recorded duration
           ├─ tests_workspaces       whole small projects + selected UI suites
           ├─ observer               plugins-experimental/plugin-ops-observer
           ├─ runner_checks          runner static + Rust checks
           ├─ runner_vitest          runner vitest lane
           ├─ docker                 production image build
           ├─ ci_check               actionlint + shellcheck
           ├─ ci_selftest            toolchain image, caches and isolation
           └─ full                   reusable call of ci-full.yml (broad tier only)
verify                               the required check
```

`classify` runs `ci-plan.mjs`: it lists the diff of the pull request
(`base...head`), classifies every path, selects tests, and writes the lane plan
as job outputs and a step summary. A normal run starts three to five lane jobs.

`verify` is the only check to require in branch protection. It reads the plan
and fails unless every lane the plan selected succeeded; lanes the plan skipped
are fine; a failed or cancelled job always fails it; and if `classify` did not
succeed, nothing was validated and it fails.

## Path classification

`.github/scripts/ci-classify.mjs`. Each path gets exactly one class, first match
wins; the union of classes selects lanes.

| class | paths | lanes |
| --- | --- | --- |
| infra | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `tsconfig*.json`, `vitest.config.ts`, `patches/**` | **broad** |
| ci | `ci.yml`, `ci-full.yml`, `.github/ci.Dockerfile`, `.github/scripts/ci-*`, `.github/scripts/tests/ci-*` | ci_check, ci_selftest |
| workflows | other `.github/**` (upstream workflows and their scripts) | ci_check |
| docker | `Dockerfile`, `.dockerignore`, `docker/**`, `.github/docker-context-checks.Dockerfile` | docker (image), context check |
| docs | `doc/**`, `docs/**`, `releases/**`, `report/**`, `screenshots/**`, `design/**`, root `*.md` docs, `LICENSE`, `.agents/**`, `.claude/**`, `.codex/**`, issue/PR templates | policy only |
| evals | `evals/**` | policy only |
| runner | `packages/paperclip-runner/**`, `packages/paperclip-eval-kernel/**` | static, runner_checks, runner_vitest, tests |
| shared | `packages/{shared,db,adapter-utils,skills-catalog,teams-catalog}/**`, `packages/plugins/sdk/**` | static, tests |
| adapters | `packages/adapters/**` | static, tests |
| plugins | `packages/plugins/**` (rest) | static, tests |
| observer | `plugins-experimental/**` | observer |
| mcp | `packages/{mcp-server,google-sheets-mcp-server,kv-demo-mcp-server,tailscale-https-broker}/**` | static |
| ui | `ui/**` | static, tests, token gates |
| server | `server/**` | static, tests |
| cli | `cli/**` | static, tests |
| scripts | `scripts/**` | static, release registry tests |
| e2e | `tests/**` | static, test-suite typechecks |
| assets | `announcements/**`, `skills/**`, `skills-releases/**`, `tools/**` | **broad** |
| unknown | anything else | **broad** |

Two rules keep this conservative:

- **Unknown is broad.** A new top-level directory or root file selects the full
  inventory until someone gives it a class.
- **Markdown inside a package is not docs.** The runner's drift checks and the
  Docker context read committed markdown there.

A broad plan replaces the focused lanes with the full inventory, except three
lanes `ci-full.yml` does not cover: `docker` (the pull request build of the
production image), `ci_check` (lint of changed upstream workflows) and
`ci_selftest`. Those still run when the diff selects them.

The Docker context-integrity check (about 15 seconds) runs inside the `policy`
job for any change that is not docs, evals, CI-only or observer-only.

## Test selection

`.github/scripts/ci-select-tests.mjs` picks vitest suites for the `tests`
classes. vitest's own `--changed` was measured and rejected: it walks the module
graph transitively, and nearly everything reaches the `@paperclipai/shared`
barrel, so one validator in `packages/shared` selected 597 server and 435 UI
suites. The selector bounds the walk instead:

1. A changed test file runs.
2. Tests that import a changed file directly run.
3. Tests that import it through one intermediate module run, unless the
   intermediate is a re-export barrel, or a hub that more than 30 tests import.
4. Tests named after a changed file run (`foo.ts` → `foo.test.ts`, `foo-x.test.ts`).
5. For shared-library packages (their exports reach consumers through a
   barrel), tests that mention an exported name of 5+ characters run.
6. Runner source changes add the server suites that drive the Runner binary.
7. A change to a project's own test configuration (`vitest.config`, setup
   files, `package.json`) runs the whole project.

`server` and `ui` run only their selected files. The other projects (shared, db,
adapters, SDK, CLI, ...) are small and run whole when anything in or around them
is selected.

**Escalation, not truncation.** The server tier has a budget of three shards of
5.5 recorded minutes each. A larger selection, a whole-server selection, or a
changed runtime asset that no import reaches (server reads it from disk, so no
test can be selected for it) makes the plan **broad** and runs `ci-full.yml`.

**What selection cannot see.** It is a heuristic over a static import graph.
Typecheck and build run on every code change and catch removed or renamed
exports. Behaviour changes in a dependent that is neither a direct nor a
one-hop importer, nor named after the file, nor uses an exported name, are left
to the nightly full run. Dynamic import paths built from variables are not
followed.

Preview any change set locally. The container sees only the checkout, so write
the file list inside it:

```sh
git diff --name-only origin/master...HEAD > .ci-files
.github/scripts/ci-run.sh --no-install -- 'node .github/scripts/ci-plan.mjs --files-from .ci-files'
rm .ci-files
# or straight from commits:
.github/scripts/ci-run.sh --no-install -- 'node .github/scripts/ci-plan.mjs --base origin/master --head HEAD'
```

## Full inventory

`ci-full.yml` runs the same commands the previous pull-request matrix ran, with
fewer, better-packed jobs:

| job | contents |
| --- | --- |
| server (1..3/3) | `general-server-without-chat`, 3 shards |
| chat | `general-chat` |
| serialized server (1..3/3) | route/authz suites, 3 shards |
| workspaces | `general-workspaces-a` then `-b` |
| runner vitest, runner checks | runner vitest lane; runner static + Rust |
| typecheck + build | `typecheck:build-gaps`, release registry tests, build, token gates |
| ops observer, canary dry run | `ci-observer.sh`; `release.sh canary --dry-run` |
| workflow lint, docker | actionlint/shellcheck; context check, production image, PID 1 check |

It runs on `workflow_dispatch` (Actions → CI full), nightly at 04:23 UTC on the
default branch, after pushes to `master` that change more than docs, and when
`ci.yml` escalates a pull request to broad. Pull request mergeability depends on
it only in that last case. Not included: the Playwright e2e and release-smoke
suites (they need a browser the toolchain image lacks) and
`verify-grok-npm-install.mjs` (it starts Docker containers, and the CI container
has no Docker socket).

### Shard counts

The pool is four runners. Observed shard runtimes were 20-28 minutes for the
four server shards and 16-19 for the three serialized shards, and a queued shard
buys no parallelism. The matrix therefore sets `max-parallel: 3`, so a full run
leaves one runner for pull request lanes, and lists jobs longest first.
General-server uses three shards (about 31 minutes each) instead of four. Total
work is about 190 runner-minutes, so the floor is ~63 minutes at three
concurrent jobs. Raise `max_parallel` on a manual run when the pool is idle.
Recorded suite durations live in `scripts/general-server-shard-durations.json`
and `scripts/serialized-shard-durations.json`; self-hosted runners ran about 2.2x
slower than those recordings.

## Trust model

The repository is public; the runner pool must never execute code from an
untrusted pull request.

- Every job that runs on the pool carries
  `github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository`.
  Fork pull requests skip all of them, including the reusable `full` call.
- Neither workflow uses `pull_request_target`, `workflow_run`, `secrets.*` or
  `secrets: inherit`. Permissions are `contents: read`. Every checkout sets
  `persist-credentials: false`.
- `verify` runs on `ubuntu-latest` with no checkout and no permissions. It only
  reads job results, so a fork pull request gets a **failed** required check
  rather than a skipped one that branch protection would read as passing.
- The runner host is orchestration only (Git and Docker). Repository commands
  run in the toolchain container as the invoking user, with the checkout and
  three cache directories mounted. There is no Docker socket, no host home
  directory, and no GitHub token in the container; `ci-selftest.sh` asserts
  this whenever the CI files change.
- `ci-run.sh` mounts the Rust target cache over the in-tree path, one directory
  per cache name, so lanes that build different profiles cannot contaminate each
  other. The caches (pnpm store, Cargo registry, target directories) persist
  across runs on a host and are written only by content-addressed or
  fingerprinting tools. Same-repository code can write them, which is the same
  trust boundary as editing the workflows; fork code never runs on the pool.

A same-repository branch can still edit the workflows themselves; that is the
boundary of trust ("write access to the repository").

## Operator actions

1. **Branch protection**: require the status check `verify` only.
2. **Disable the upstream pull request workflow** so a PR does not run both:
   `gh workflow disable pr.yml --repo Zutfen-LLC/paperclip` (or Actions → PR →
   ⋯ → Disable workflow). Upstream's `pr.yml` and `pr-trusted.yml` also produce
   a check named `verify`, which would be ambiguous next to this one. Do not
   edit those files; upstream tests pin them.
3. **Fork pull request approval** (Settings → Actions → General): keep
   "Require approval for all outside collaborators". Defence in depth only; the
   job guards above already keep fork code off the pool.
4. **Runner group**: restrict the self-hosted runner group to this repository.
5. **First run after a toolchain change**: each runner rebuilds the tagged image
   once (the tag is a hash of the Dockerfile and the pins), reusing cached
   layers. Superseded tags are removed.

## Local reproduction

Everything a lane runs goes through one wrapper, so any lane reproduces on a
machine with Git and Docker:

```sh
.github/scripts/ci-run.sh -- pnpm run typecheck:build-gaps        # installs first
.github/scripts/ci-run.sh --no-install -- '.github/scripts/ci-lint.sh'
.github/scripts/ci-run.sh --target-cache tests -- .github/scripts/ci-observer.sh
.github/scripts/ci-selftest.sh
node --test ".github/scripts/tests/*.test.mjs"                     # classifier, selector, plan, workflow structure, verify logic
```

Caches default to `~/.cache/paperclip-ci` (`PAPERCLIP_CI_CACHE` overrides):
`pnpm-store`, `cargo`, and `runner-target-<name>`. Deleting a directory is
always safe.

## Changing the rules

- New top-level directory: add a class in `ci-classify.mjs`, examples in
  `ci-classify.test.mjs`, and a row above. The coverage test fails until you do.
- New lane: add the job in `ci.yml` with the fork guard and a
  `fromJSON(needs.classify.outputs.lanes).<id>` condition, add the id to
  `LANE_IDS` and to `verify.needs`. `ci-workflows.test.mjs` enforces all three.
- Server budget or shard size: `SERVER_SHARD_TARGET_MS`, `SERVER_MAX_SHARDS` and
  `HUB_FANIN` in `ci-select-tests.mjs`.
