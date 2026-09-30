# @zutfen/plugin-ops-observer (experiment)

Read-only Ops Supervisor observer plugin for Paperclip.

Bounded integration experiment (2026-09-29/30): lets Paperclip display
Ops-managed work WITHOUT any authority over it.

## Authority model

```
Paperclip plugin (this repo)            [observer]
   | GET only, adapter bearer token
   v
ops-readonly-adapter (hermes loopback)  [dedicated read surface]
   | GET allowlist only
   v
Ops Supervisor / GitHub authority        [sole authority planes]
```

The plugin holds:
- capability `http.outbound` + `ui.page.register` ONLY (no data-write,
  issue, agent, or state capabilities — enforced by the host);
- a bearer token that authorizes exactly ONE route: `GET /snapshot` on the
  dedicated ops-readonly-adapter. The adapter itself is GET-only
  (every other method 405), exposes no Ops write route, and fails closed
  (502) on upstream errors.

The plugin does NOT hold any Ops, GitHub, Hermes-execution, or deployment
credential. Ops Supervisor's core API has no auth model that can express
read-only scope, which is why the adapter exists at all: it IS the
mechanically-proven read-only scope.

## What it shows

`ops_work_snapshot_v1` items: project/repo, issue number/title/state,
Ops lifecycle + execution state, run id, review state, PR number/head SHA,
reviewed (GO) SHA, base SHA, qualification state, blocker, token usage,
timestamps, source links, and per-item provenance (Ops deployed SHA,
source endpoints, fetch time). Missing values render as explicit
`unknown` — never inferred.

No actions are registered: the UI has no retry/approve/stop/merge/assign
buttons because the worker registers no action handlers at all.

## Cache

Read-through, 30s TTL, in-worker memory only. Stale (>60s) is visibly
marked. Refresh re-reads; it never writes anywhere. No Ops state is
persisted inside Paperclip.

## Layout

`plugins-experimental/` — self-contained; nothing outside this directory
changes. Install from a local path (operator action):
`paperclipai plugin install <abs path>`.

## Tests

`node --test test/worker.test.mjs` — proves GET-only fetch, cache
behavior, fail-closed on adapter failure / bad schema / missing config,
no registered actions, and provenance pass-through.
