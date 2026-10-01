# Paperclip Ops observer rollout receipt — Issue #3

Result: **BLOCKED_SECRET_REF_SCHEMA — NOT PRODUCTION CERTIFIED**.

Observed on October 1, 2026. The final retained snapshot is at `2026-10-01T12:27:46.951652+00:00`. The exact live migration blocker is tracked in #4. This report does not close #3 or claim its production acceptance criteria passed.

Machine-readable receipt: `2026-10-01-ops-observer-issue-3.json` in this directory. Credentials, raw config, issue contents, and complete instance backups remain in private operator storage. This receipt publishes identities, hashes, counts, fixed diagnostics, and limitations only.

## Required final report

### 1. Selected topology and reason

Use the existing standalone Paperclip LXC, CT152 on pm04. It already has private board authentication, persistent company state, and the dedicated observer tunnel. It does not require Paperclip to share the Hermes host, filesystem, or process namespace. No arbitrary outbound destination was introduced.

### 2. Paperclip identity

Hostname `paperclip-poc`; Proxmox CT152 on pm04; Debian 12. The board listens on `10.0.0.34:3100`. The `paperclip` account owns the systemd user unit `paperclipai.service`. Its final PID is 115506. The instance remains `/home/paperclip/.paperclip/instances/default`.

### 3. Adapter and Ops identities

The adapter, Ops API, and scheduler run as `zutfen` on `hermes`, address `10.0.0.31`. The adapter listens on `127.0.0.1:8487`; Ops listens on `127.0.0.1:8484`. These listeners were verified with `ss`. No firewall rule or listener address changed. Paperclip is not on this host.

### 4. Exact deployed source

- Paperclip: `d8c98d798ba007631efa92e6c984182449bc5f2b`, merged PR #2. The health response and release build stamp both report this SHA.
- Previous Paperclip: `6a6e609a78f76b6b93805e610355981878bc0a50`.
- Observer reviewed head: `3a28e419162bdca46c7adba7babc3db6a7b04397`. Source is identical at the deployed merge and canonical `2ec4bb3d7e79684d0059cd61d056a82397a469bf`, which is the receipt PR base.
- Adapter: `9d02dc2cb35addd77e88044b2fc50518bff1b51c`, merged Ops PR #240. Its script is byte-identical to reviewed `e10299e5da8b9d48a88451c44a3b12604dce83a3`; script SHA-256 is `1cebf8d9675e0955ceefc9400de06a9160b1d1029832f6f6c310a47878531d1f`.
- Ops API/scheduler: `d7ce4b1ea238613c78fd8c7fc39573e1ad8982c4`. The checkout reflog and latest tracked Python source mtime precede both process starts. Tracked Python source matches that commit. PID/start/restart identities did not change. This is corroborated deployment identity, not an API version self-report; the health endpoint returns only `status: ok`.

Paperclip was built with Node 24.21.0 and pnpm 9.15.4. Workspace typecheck/build passed. The observer build and typecheck passed; all 259 observer tests passed. The exact merged adapter passed 27 tests and 48 subtests. No application source was changed for this rollout. The repository-wide test suite was not run.

Release archive SHA-256: `a2476237fb396f179d6e5989a0dadf32ec5eb604435ce257df152173f025d57c`. The transferred archive was hashed before extraction. The live plugin worker, manifest, and UI hashes match the built artifacts. The 287 live migration hashes matched the complete source journal in order; there were zero pending migrations and no schema delta from the previous release.

### 5. Pinned origin and transport

The only approved origin remains `http://127.0.0.1:18487` inside CT152. The existing `ops-observer-tunnel.service` forwards CT loopback port 18487 over SSH to `zutfen@10.0.0.31`, then to Hermes loopback port 8487. The adapter reads the fixed Ops GET allowlist on loopback port 8484. The tunnel and its configuration were not changed or restarted.

Credential locations: adapter token file `/home/zutfen/.config/ops-supervisor/ops-readonly-adapter.token`, mode 0600; intended Paperclip encrypted secret storage in the existing instance database with master key `/home/paperclip/.paperclip/instances/default/secrets/master.key`, mode 0600. The old raw token remains in unchanged stored plugin config because migration was rejected. It is not reproduced here.

### 6. Secret-reference migration

**Blocked.** Creating a company-owned `local_encrypted` managed secret succeeded. Submitting `{type: "secret_ref", secretId: <real secret UUID>}` in `adapterToken` returned HTTP 400:

```json
{
  "error": "Configuration does not match the plugin's instanceConfigSchema",
  "fieldErrors": [{"field": "/adapterToken", "message": "must be string"}]
}
```

The merged manifest declares `type: "string", format: "secret-ref"`, while the worker expects the reference object. The real host rejects the object before storage or worker resolution. Config was read back and remained unchanged. The observer and the newly created unused secret were disabled, and those states were read back. No raw-string fallback was certified. Required runtime resolution with `configPath="adapterToken"`, company isolation, and resolved-secret UI/API hygiene remain unverified.

### 7. Production provenance

The adapter unit now labels the actual retained Ops source `d7ce4b1ea238613c78fd8c7fc39573e1ad8982c4`, replacing the stale `1ec7f2c5a01305d3d0f8a14b7a97cb2c6a69906c` label. Neither Ops service nor its source was changed to make this label match. Paperclip release identity is verified. Snapshot-advertised and Paperclip-envelope provenance were **not certified**: the mandatory secret-ref gate failed before those reads.

### 8. Method/path/auth refusals

A missing-token adapter liveness request returned 401 after deployment. The complete production method/path/auth matrix was not run after the secret-ref STOP gate. The exact-source adapter tests passed, but they are not substituted for production refusal evidence.

### 9. Upstream method inventory

Zero upstream calls were recorded by the temporary method-only audit launcher. The config validation failure never reached a snapshot read. The launcher recorded no credentials and was removed from the service command. The final adapter runs the exact reviewed script directly with no audit write permission. No production upstream inventory, GET-only certification, or forwarded-credential result is claimed.

### 10. Ops state fingerprints

Consistent read-only SQLite transactions captured ordered logical rows before deployment and after the failed migration. Counts and fingerprints were identical:

| Table | Before / after count | Before / after SHA-256 |
|---|---:|---|
| tasks | 27 / 27 | `33e091b22cd24368940362aedf2f7cf289ec72c8f1c5e75fb1b37c6860c218f3` |
| events | 1556 / 1556 | `f1b520a9338d0db6e61fc07ac13ba3394b14af30a9f04153565472d318d7eb58` |
| runs | 161 / 161 | `b1e7aff2781086be5667490e9d97601b9b125d6d4955797c41fe6b5e2d0dc4d4` |

The digest uses `SELECT * ORDER BY rowid` and canonical JSON serialization as recorded in the machine receipt. This proves neutrality over the measured deployment/migration-attempt interval. It does **not** prove neutrality over the production certification read window, which did not occur.

### 11. Paperclip neutrality

All 16 Paperclip issue identities, company IDs, titles, and creation timestamps were unchanged. Zero new issue mirrors were created. Stored plugin config, including its record hash, remained unchanged. Authorized lifecycle changes reinstalled the merged plugin into a SHA-named package directory while retaining its plugin UUID, then disabled it at the STOP gate. Creating and disabling the unused company secret are explicit operational changes, not observer reads.

The merged worker registers no actions, jobs, event subscriptions, webhooks, or tools. Its three capabilities are `http.outbound`, `ui.page.register`, and `secrets.read-ref`. Source and existing tests confirm this boundary; live action refusal certification was not performed.

### 12. Cache/TTL/destination policy

The existing 259-test observer suite passed. It includes company cache isolation, TTL refresh, rejected-origin ordering with zero token reads/resolutions/cache/fetch, and redirect refusal. Production first-read/cache/TTL, live secret-resolution ordering, and log/error/envelope/cache hygiene are **not certified**. The company config origin and code-owned pin remain unchanged.

### 13. Service evidence

| Service | Before PID | Final PID | Final restart count | Final start |
|---|---:|---:|---:|---|
| Paperclip, CT152 | 29201 | 115506 | 0 | October 1, 2026 12:14:32 UTC |
| Ops API | 3135333 | 3135333 | 0 | September 30, 2026 00:32:00 EDT |
| Ops scheduler | 3135334 | 3135334 | 0 | September 30, 2026 00:32:00 EDT |
| Read-only adapter | 3095125 | 2862867 | 0 | October 1, 2026 08:25:36 EDT |
| CT152 SSH tunnel | 35112 | 35112 | 0 | September 30, 2026 04:25:40 UTC |

Paperclip had one planned cutover restart. The adapter had one planned audited start and one planned restart to remove the audit launcher after the STOP gate. `NRestarts` counts automatic restarts, not these explicit operator restarts. Ops and tunnel PID/start/restart identities were preserved. A local daemon-reload cleared transient rendered `ExecStart` execution metadata; it did not restart Ops.

### 14. Rollback

The complete stopped-state Paperclip backup is under `/home/paperclip/.paperclip/fork/backups/issue-3-pre-cutover` on CT152 (directory mode 0700, instance archive mode 0600). Its instance archive SHA-256 is `008c030936b744c60d95b561d4a19573bb13c638aa2bfc7aab71e02bfd516256`. Archive readability was checked. It includes the existing database, secrets, config, logs, and storage; the previous unit and plugin directory are retained separately. No active Paperclip runs were present when stopped, and both app and embedded PostgreSQL listeners were confirmed absent before backup.

- Paperclip rollback: require no active runs; stop the user unit; verify app and embedded PostgreSQL exited. Preserve the post-cutover instance as a separate diagnosis copy. Restore the complete stopped instance archive and backed-up `paperclipai.service` together as `paperclip`. Reload/start the user manager. Verify health SHA `6a6e609a78f76b6b93805e610355981878bc0a50`, authenticated/private mode, and original issue identities. Do not mix old binaries and arbitrary new state.
- Plugin rollback: the old package `/home/paperclip/plugin-dev/plugin-ops-observer` was not overwritten. The backup also retains it. Restore the prior instance/plugin registry with the full instance rollback, or use the authenticated uninstall/reinstall flow with the old package. Keep the observer disabled while the secret-ref gate is unresolved; rollback does not confer certification.
- Adapter rollback: restore `/home/zutfen/paperclip-poc/evidence/issue-3/previous-adapter-unit.txt` to the user unit, reload, and restart only the adapter. The previous source checkout remains available. This restores the previous operational configuration, including its known stale provenance label; it does not certify that label.
- Secret rollback: config migration never committed, so no config undo is required. The created secret is disabled and unbound. Delete it only after verifying no bindings remain, or retain it disabled for diagnosis. Protected previous config is retained privately; never paste it into an issue or log.
- Transport rollback: none required. No tunnel, listener, firewall, or SSH trust configuration changed.

Private operator evidence is `/home/zutfen/paperclip-poc/evidence/issue-3` (0700); files containing prior config use 0600. No backup or token material is committed.

### 15. Deviations and uncertified claims

The authorized rollout reached the explicit secret-ref STOP gate. The merged release and adapter were deployed, but the observer remains disabled. #3 remains open and blocked by #4. No production certification or acceptance completion is claimed. No live secret resolution, complete refusal matrix, snapshot provenance comparison, production cache/TTL audit, or production certification read-neutrality window ran. No product patch was made to bypass the gate. Correct, review, merge, and deploy #4 before resuming #3.
