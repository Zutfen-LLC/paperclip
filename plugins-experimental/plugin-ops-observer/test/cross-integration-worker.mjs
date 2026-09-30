// Opt-in live qualification; credentials arrive on stdin, never argv or logs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
const worker = await import(input.workerUrl ?? "../dist/worker.js");
const origin = "http://127.0.0.1:18487", companyId = input.companyId, token = input.token;
assert.ok(typeof token === "string" && token.length > 0, "qualification token required");
worker.cache.clear();
let destination = origin, resolutions = 0;
const requests = [], logs = [], actions = [], handlers = new Map();
const originalFetch = globalThis.fetch, originalNow = Date.now;
globalThis.fetch = async (url, options) => {
  assert.equal(url, `${origin}/snapshot`);
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "error");
  assert.ok(options.headers.Authorization === `Bearer ${token}`, "credential mismatch");
  requests.push({ url, method: options.method, redirect: options.redirect });
  return originalFetch(url, options);
};
try {
  await worker.default.definition.setup({
    config: { get: async c => { assert.equal(c, companyId); return {
      adapterBaseUrl: destination, adapterToken: { type: "secret_ref", secretId: "qualification-company-secret" },
    }; } },
    secrets: { resolve: async (ref, scope) => {
      assert.equal(ref.secretId, "qualification-company-secret");
      assert.deepEqual(scope, { companyId, configPath: "adapterToken" });
      resolutions++; return token;
    } },
    data: { register: (k, h) => handlers.set(k, h) },
    actions: { register: k => actions.push(k) },
    logger: Object.fromEntries(["info", "warn", "error"].map(k => [k, (...args) => logs.push(args)])),
  });
  const handle = handlers.get("ops-snapshot");
  const first = await handle({ companyId });
  assert.equal(first.snapshot.schema, "ops_work_snapshot_v1");
  assert.equal(first.snapshot.schema_version, 1);
  assert.ok(first.snapshot.items.length > 0, "live snapshot must contain actual Ops items");
  destination = `${origin}/`;
  const cached = await handle({ companyId });
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.snapshot, first.snapshot);
  assert.equal(requests.length, 1);
  Date.now = () => first.fetchedAt + 30_000;
  const refreshed = await handle({ companyId });
  assert.notEqual(refreshed.cached, true);
  assert.equal(requests.length, 2);
  const stableItems = items => items.map(item => ({ ...item, source_version: { ...item.source_version, fetched_at: null } }));
  assert.deepEqual(stableItems(refreshed.snapshot.items), stableItems(first.snapshot.items));
  assert.deepEqual([...worker.cache.keys()], [JSON.stringify([companyId, origin])]);
  const rejected = ["http://evil.example:18487", "http://localhost:18487", "http://127.0.0.1:8487", "https://127.0.0.1:18487", "http://2130706433:18487", `${origin}/../`, `${origin}?`, "http://[::1]:18487"];
  for (const url of rejected) {
    destination = url;
    const resolveBefore = resolutions, fetchBefore = requests.length;
    await assert.rejects(() => handle({ companyId }), /adapterBaseUrl/);
    assert.equal(resolutions, resolveBefore);
    assert.equal(requests.length, fetchBefore);
  }
  assert.deepEqual(actions, []);
  assert.ok(!JSON.stringify({ first, cached, refreshed, logs, cache: [...worker.cache] }).includes(token), "token exposure detected");
  console.log(JSON.stringify({ schema: first.snapshot.schema, schema_version: first.snapshot.schema_version,
    items: first.snapshot.items.length, authorized_origin: origin, cache_reuse: true, ttl_refresh: true,
    rejected_destinations: rejected.length, rejected_secret_resolutions: 0, rejected_fetches: 0,
    token_exposure: false, actions_registered: actions.length, requests,
    secret_resolution_scope: { companyId, configPath: "adapterToken" } }));
} finally { Date.now = originalNow; globalThis.fetch = originalFetch; worker.cache.clear(); }
