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
- capabilities `http.outbound`, `ui.page.register`, and `secrets.read-ref`
  (the latter resolves only company-bound config secret references; no
  data-write, issue, agent, or state capabilities — enforced by the host);
- a bearer token that authorizes exactly ONE route: `GET /snapshot` on the
  dedicated ops-readonly-adapter. The adapter itself is GET-only
  (every other method 405), exposes no Ops write route, and fails closed
  (502) on upstream errors.

The plugin does NOT hold any Ops, GitHub, Hermes-execution, or deployment
credential. Ops Supervisor's core API has no auth model that can express
read-only scope, which is why the adapter exists at all: it IS the
mechanically-proven read-only scope.

`adapterToken` declares the host's `format: "secret-ref"` config schema and is stored as a `{ type: "secret_ref", secretId, version? }` binding. The worker resolves that binding with `ctx.secrets.resolve(binding, { companyId, configPath: "adapterToken" })`; the manifest requests only the SDK's `secrets.read-ref` capability. Plain string tokens remain accepted for compatibility, but are not secret-ref protected. Host config reads return the stored company-scoped config; secret resolution is an explicit SDK call, not an implicit `ctx.config.get` behavior.


`ops_work_snapshot_v1` items: project/repo, issue number/title/state,
Ops lifecycle + execution state, run id, review state, PR number/head SHA,
reviewed (GO) SHA, base SHA, qualification state, blocker, token usage,
timestamps, source links, and per-item provenance (Ops deployed SHA,
source endpoints, fetch time). Missing values render as explicit
`unknown` — never inferred.

No actions are registered: the UI has no retry/approve/stop/merge/assign
buttons because the worker registers no action handlers at all.

## Pinned destination trust boundary

The worker pins the approved origin to `http://127.0.0.1:18487`, the dedicated
local ops-readonly-adapter endpoint from the reviewed manifest deployment default.
`adapterBaseUrl` may be exactly
that literal or `http://127.0.0.1:18487/`; both normalize to the pinned origin.
This is a code-owned policy, not an arbitrary company-configured URL allowlist.
Changing the deployed topology requires a separately reviewed code change.

Validation runs after mandatory company-scoped config lookup but BEFORE reading
`adapterToken`, resolving a secret reference, consulting the cache, or fetching.
Every other spelling fails closed: other schemes/ports, DNS names (including
`localhost`), other IPv4 addresses, IPv6, alternate IPv4 loopback notation,
userinfo, query/fragment delimiters (even empty), non-root paths, extra slashes,
dot segments, backslashes, encoded hosts/paths, whitespace/control characters,
and parser-normalized aliases. Literal admission precedes URL parsing; parsing
then verifies the exact origin and root path. No hostname lookup/DNS alias is
needed for the authorized numeric address.

The only request is `GET http://127.0.0.1:18487/snapshot` with the adapter bearer.
Native fetch uses `redirect: "error"`: ALL redirects, including same-origin ones,
fail closed without a second request. Error diagnostics do not include rejected
URLs, token values, or underlying fetch/secret exceptions. The boundary assumes
the operator controls the process/tunnel listening at this exact loopback port;
origin pinning is not server authentication against a compromised local host.
HTTP is intentional for this dedicated local tunnel, not permission to transmit
the credential to other HTTP services. Legacy raw tokens are still supported
with the same destination gate and the plaintext-config caveat below.

## Cache

Read-through, 30s TTL, in-worker memory only. Each cache key is the explicit
pair of required company ID and normalized approved adapter origin, never the token.
Missing company scope fails before configuration or cache access. Companies
sharing an adapter URL cannot reuse one another's cached payloads. Stale
(>60s) is visibly marked. A failed refresh reports an error rather than
returning an expired snapshot. Refresh re-reads; it never writes anywhere.
No Ops state is persisted inside Paperclip.

Secret-ref designation does not automatically encrypt a raw string placed in
plugin config. The config API persists and returns the stored `configJson` to
authorized board callers; legacy raw tokens are therefore plaintext config.
A real secret-ref config stores only the reference object, and explicit scoped
resolution accesses the company secret. This correction does not migrate the
live raw-token config or claim an end-to-end UI/API redaction audit.

## Layout

`plugins-experimental/` — self-contained; nothing outside this directory
changes. Install from a local path (operator action):
`paperclipai plugin install <abs path>`.

## Tests

From this package directory: `npm run build`, `npm test`, `npm run typecheck`.
Tests import the built worker artifact. `test/destination-policy.test.mjs`
checks the adversarial URL matrix with both raw and secret-ref credentials,
each with cold and pre-seeded caches. It asserts zero token-property reads,
secret resolutions, cache reads, and fetch calls on rejection, plus no token
in envelopes/errors/logs/cache. Real HTTP redirect fixtures cover 301/302/303/
307/308 and prove zero redirect-target requests. Test-only transports verify
the production pinned URL before mapping it to disposable ephemeral listeners;
the worker policy itself is never widened for testing.

`test/worker.test.mjs` retains GET-only, company-isolated cache, TTL refresh,
failed-refresh fail-closed, company-scoped secret resolution, token hygiene,
no-actions, and provenance regressions. Stale-display behavior is unchanged.
