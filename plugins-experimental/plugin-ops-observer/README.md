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

`adapterToken` declares the host's `format: "secret-ref"` config schema and is stored as a `{ type: "secret_ref", secretId, version? }` binding. The worker resolves that binding with `ctx.secrets.resolve(binding, { companyId, configPath: "adapterToken" })`; the manifest requests only the SDK's `secrets.read-ref` capability. New config writes require the object reference and reject plaintext or bare UUID strings. The worker can still read a previously stored plaintext token for compatibility; that path is unprotected plaintext config and is NOT equivalent to secret-ref certification. Existing config is not migrated by this source change. Host config reads return the stored company-scoped config; secret resolution is an explicit SDK call, not an implicit `ctx.config.get` behavior.


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
local ops-readonly-adapter endpoint from the reviewed manifest deployment default
and CT152's existing `ops-observer-tunnel.service` forwarding
`127.0.0.1:18487` to `127.0.0.1:8487` on Hermes. `adapterBaseUrl` may be exactly
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
Native fetch uses `redirect: "manual"`: all 3xx responses are classified as
redirect refusals without reading `Location` or issuing a second request.
Error diagnostics do not include rejected
URLs, token values, or underlying fetch/secret exceptions. The boundary assumes
the operator controls the process/tunnel listening at this exact loopback port;
origin pinning is not server authentication against a compromised local host.
HTTP is intentional for this dedicated local tunnel, not permission to transmit
the credential to other HTTP services. Legacy raw tokens are still supported
with the same destination gate and the plaintext-config caveat below.

## Opt-in certification evidence (slice A)

The manifest's optional company config `certificationEnabled: true` enables
**process-local** counters. Default/absent/false is off; it neither adds data to
normal `ops-snapshot` envelopes nor emits outbound telemetry. An authorized board
caller uses the existing scoped plugin data bridge:

- `POST /api/plugins/<plugin-id>/data/ops-certification` with
  `{ "companyId": "<authorized-company-uuid>", "params": { "command": "start" } }`
  begins a five-minute window *before* sending measured snapshot requests.
- The same route and companyId with `params: {}` reads a live receipt; with
  `params: { "command": "close" }` closes it. Response is `{ "data": receipt }`.
  This is a getData read bridge, **not** a new action, capability, or write API.
- `status: "complete"` only when explicitly closed before expiry, without
  overlapping requests. `status: "active"` is not final evidence;
  `status: "incomplete"` means an in-flight request overlapped close/start, the
  five-minute limit expired, or the 10,000-event budget overflowed. Never call
  an incomplete receipt a full-window result. In-flight requests begun before
  `start` invalidate that window. Re-reading a closed receipt is supported until
  replaced by another start or worker restart; the worker retains at most one
  receipt per company and at most 64 companies per process. A restart loses
  this volatile evidence; there is no persistent receipt store.

Receipt shape: `schema`, `status`, `startedAt`, `endedAt` (number/null),
`inFlight`, `counters`, `upstreamMethod` (`GET`/`none`), and
`adapterAuthHeaderAttached` (boolean). Counters: `acceptedOrigin`,
`rejectedOrigin`, `secretResolutionAttempts`, `secretResolutionFailures`,
`cacheReads`, `cacheHits`, `cacheMisses`, `cacheRefreshes`, `fetchAttempts`,
`fetchSuccesses`, `fetchFailures`, `redirectRefusals`, `upstreamGet`,
`adapterAuthAttached`. Method and header classification are set at the
worker's sole fetch boundary, after the destination/credential gates; caller
headers are never passed to fetch. These are finite classifications/counters,
not header values, tokens, secret IDs, raw URLs, bodies, or cache keys. The
worker does not print fetch/secret exceptions. **Slice B** must independently
scan the entire installed-worker/adapter log and receipt interval for secret
hygiene; this worker receipt alone cannot certify external logs or deployed
adapter behavior. Certification is not a production rollout.

## Cache

Read-through, 30s TTL, in-worker memory only. Each cache key is the explicit
pair of required company ID and normalized approved adapter origin, never the token.
Missing company scope fails before configuration or cache access. Companies
sharing an adapter URL cannot reuse one another's cached payloads. Stale
(>60s) is visibly marked. A failed refresh reports an error rather than
returning an expired snapshot. Refresh re-reads; it never writes anywhere.
No Ops state is persisted inside Paperclip.

Secret-ref designation does not automatically encrypt a raw string placed in
plugin config. The config API returns the stored `configJson` to
authorized board callers; previously stored raw tokens are therefore plaintext config.
The corrected observer manifest rejects new raw-token writes.
A real secret-ref config stores only the reference object, and explicit scoped
resolution accesses the company secret. This correction does not migrate the
live raw-token config or claim an end-to-end UI/API redaction audit.

## Layout

`plugins-experimental/` — the built plugin is self-contained. Its manifest uses
the SDK's shared canonical secret-reference schema. Host/API and picker
regressions live in the server/UI test suites. Install from a local path (operator action):
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

## Opt-in bounded cross-integration

After building, operators with access to the existing test topology can run:

```
PYTHONDONTWRITEBYTECODE=1 python3 test/cross-integration.py <ops-candidate-checkout> <receipt-path>
```

The harness requires Ops PR #240 at exactly
`82acd5431e527687b3da0349bb8cc27de04d519f` and verifies the adapter source
against that Git blob. It starts a temporary candidate listener at the pinned
origin, reads actual Ops upstream data, then shuts the listener down. If the
port is occupied, binding fails; no service is stopped or alternate port
implicitly authorized. It separately executes the exact built worker bundle
in memory on CT152 through the existing dedicated tunnel, without installation
or remote file writes. Both probes verify version-1 schema, authenticated reads,
cache reuse, deterministic TTL expiry, and zero resolution/fetch for rejected
origins. Candidate upstream requests are instrumented for GET-only behavior
and absence of forwarded adapter credentials.

Before/after logical database and ordered task/event/run fingerprints, Paperclip
issue identities, production service identities, and stored plugin config are
checked for equality. The harness performs no Ops writes or issue creation.
The company-scoped secret resolver is a harness seam using the existing adapter
credential, not a live secret-ref migration or full host-bridge certification.
The existing tunnel still targets the unchanged running adapter; exact-candidate
proof comes from the separate temporary pinned-origin listener. No production
provenance/rollout claim is implied by candidate compatibility.
