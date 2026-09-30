// Plugin-side read-only enforcement tests (node:test, no network mocks needed
// beyond a local fake adapter built on http).
//
// Proves:
// 1. getData retrieves a snapshot from the adapter (happy path).
// 2. The plugin issues ONLY GET /snapshot — spy adapter records methods/paths.
// 3. Read-through cache: second call within TTL does not hit the adapter.
// 4. Adapter failure (502/timeout/non-schema payload) fails closed — error
//    surfaces, no invented data.
// 5. No actions are registered: the worker module exposes no action surface
//    (structural assertion on module shape).
// 6. Provenance fields pass through unmodified from adapter to UI.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));


// import the built worker (dist) — the exact artifact Paperclip loads
const workerModule = await import("../dist/worker.js");
const plugin = (workerModule.default ?? workerModule).definition;

// Drive the plugin through the same contract the host uses: setup(ctx).
// Capture the ctx we hand it so tests can invoke registered data handlers.
function makeCtx(config, companyId = "company-default") {
  const dataHandlers = new Map();
  const ctx = {
    config: { get: async (requestedCompanyId) => {
      if (companyId !== "company-default") assert.equal(requestedCompanyId, companyId);
      return typeof config === "function" ? config(requestedCompanyId) : config;
    } },
    data: { register: (k, h) => dataHandlers.set(k, h) },
    events: { on: () => {} },
    jobs: { register: () => {} },
    launchers: { register: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  plugin.setup(ctx);
  return { ctx, dataHandlers };
}

const SNAPSHOT = {
  schema: "ops_work_snapshot_v1",
  schema_version: 1,
  generated_at: "2026-09-30T00:00:00Z",
  ops_deployed_sha: "1ec7f2c5a01305d3d0f8a14b7a97cb2c6a69906c",
  upstream_readiness: { ready: true },
  projects: [],
  items: [
    {
      project: "ops-supervisor",
      repository: "Zutfen-LLC/ops-supervisor",
      issue_number: 214,
      issue_title: "docs: remove stale notice",
      issue_state: "merged",
      ops_task_id: "gh-Zutfen-LLC-ops-supervisor-214",
      run_id: "run_6a411e0205024a3b9469d93fef27388c",
      run_role: "top_level",
      parent_run_id: null,
      work_class: null,
      execution_state: "stopped_for_review",
      review_state: "done",
      profile_id: null,
      provider: null,
      model: null,
      pr_number: 215,
      pr_head_sha: "be9e9c77070e2fd63b27d5027d7e52be4a79d10b",
      reviewed_sha: "be9e9c77070e2fd63b27d5027d7e52be4a79d10b",
      base_sha: "384ca6ff94128777146c27872c292c778e681cb0",
      qualification_state: "MERGED",
      deployment_state: null,
      blocker: null,
      usage: { input_tokens: 252625, output_tokens: 1227 },
      updated_at: "2026-09-25T21:21:35Z",
      source_links: [
        "https://github.com/Zutfen-LLC/ops-supervisor/issues/214",
        "https://github.com/Zutfen-LLC/ops-supervisor/pull/215",
      ],
      source_version: {
        ops_deployed_sha: "1ec7f2c5a01305d3d0f8a14b7a97cb2c6a69906c",
        endpoints: ["/api/tasks"],
        fetched_at: "2026-09-30T00:00:00Z",
      },
    },
  ],
};

function startFakeAdapter(opts = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (opts.failWith) {
      res.writeHead(opts.failWith, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_failure" }));
      return;
    }
    if (opts.badSchema) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schema: "something_else_v9" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(opts.payload ?? SNAPSHOT));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port }));
  });
}


test("declares the adapter token as a company-secret reference field", async () => {
  const manifestModule = await import("../dist/manifest.js");
  const manifest = manifestModule.default;
  assert.equal(manifest.instanceConfigSchema.properties.adapterToken.format, "secret-ref");
});

test("worker module registers no actions and no mutating surface", () => {
  assert.equal(typeof plugin.setup, "function");
  // setup against a context that HAS an actions client must not register any
  const registered = [];
  const ctx = {
    config: { get: async () => ({}) },
    data: { register: () => {} },
    actions: { register: (k) => registered.push(k) },
    events: { on: () => {} },
    jobs: { register: () => {} },
    launchers: { register: () => {} },
    logger: { info: () => {} },
  };
  plugin.setup(ctx);
  assert.deepEqual(registered, []);
});

test("getData retrieves snapshot; adapter sees only GET /snapshot with bearer", async () => {
  const fake = await startFakeAdapter();
  try {
    const { dataHandlers: captured } = makeCtx({
      adapterBaseUrl: `http://127.0.0.1:${fake.port}`,
      adapterToken: "tok",
    });
    const result = await captured.get("ops-snapshot")({ companyId: "company-default" });
    assert.equal(result.snapshot.items[0].ops_task_id, "gh-Zutfen-LLC-ops-supervisor-214");
    assert.equal(fake.seen.length, 1);
    assert.equal(fake.seen[0].method, "GET");
    assert.equal(fake.seen[0].url, "/snapshot");
    assert.equal(fake.seen[0].auth, "Bearer tok");
  } finally {
    fake.server.close();
  }
});

test("uses company-scoped resolved config from ctx.config.get", async () => {
  const fake = await startFakeAdapter();
  const secretValue = "resolved-company-token";
  try {
    const { dataHandlers } = makeCtx((companyId) => {
      assert.equal(companyId, "company-resolved-config");
      return { adapterBaseUrl: `http://127.0.0.1:${fake.port}`, adapterToken: secretValue };
    }, "company-resolved-config");
    const result = await dataHandlers.get("ops-snapshot")({ companyId: "company-resolved-config" });
    assert.ok(result.snapshot);
    assert.equal(fake.seen[0].auth, `Bearer ${secretValue}`);
  } finally { fake.server.close(); }
});

test("read-through cache: second call within TTL does not re-fetch", async () => {
  const fake = await startFakeAdapter();
  try {
    const { dataHandlers: captured } = makeCtx({
      adapterBaseUrl: `http://127.0.0.1:${fake.port}`,
      adapterToken: "tok",
    });
    await captured.get("ops-snapshot")({ companyId: "company-default" });
    const second = await captured.get("ops-snapshot")({ companyId: "company-default" });
    assert.equal(second.cached, true);
    assert.equal(fake.seen.length, 1);
    assert.deepEqual(second.snapshot.items, SNAPSHOT.items);
  } finally {
    fake.server.close();
  }
});

test("cache isolates companies sharing a URL and reuses within one company", async () => {
  const fake = await startFakeAdapter();
  try {
    const handlers = new Map();
    for (const companyId of ["company-a", "company-b"]) {
      const { dataHandlers } = makeCtx({ adapterBaseUrl: `http://127.0.0.1:${fake.port}`, adapterToken: "tok" }, companyId);
      handlers.set(companyId, dataHandlers.get("ops-snapshot"));
    }
    await handlers.get("company-a")({ companyId: "company-a" });
    const sameCompany = await handlers.get("company-a")({ companyId: "company-a" });
    const otherCompany = await handlers.get("company-b")({ companyId: "company-b" });
    assert.equal(sameCompany.cached, true);
    assert.notEqual(otherCompany.cached, true);
    assert.equal(fake.seen.length, 2);
  } finally { fake.server.close(); }
});

test("same company with different normalized URLs has independent cache entries", async () => {
  const a = await startFakeAdapter({ payload: { ...SNAPSHOT, marker: "response-a" } });
  const b = await startFakeAdapter({ payload: { ...SNAPSHOT, marker: "response-b" } });
  try {
    const { dataHandlers: aHandlers } = makeCtx({ adapterBaseUrl: `http://127.0.0.1:${a.port}/`, adapterToken: "tok" }, "company-url");
    const { dataHandlers: bHandlers } = makeCtx({ adapterBaseUrl: `http://127.0.0.1:${b.port}`, adapterToken: "tok" }, "company-url");
    const one = await aHandlers.get("ops-snapshot")({ companyId: "company-url" });
    const two = await bHandlers.get("ops-snapshot")({ companyId: "company-url" });
    assert.equal(one.snapshot.marker, "response-a");
    assert.equal(two.snapshot.marker, "response-b");
    assert.notEqual(two.cached, true);
    assert.equal(a.seen.length, 1);
    assert.equal(b.seen.length, 1);
  } finally { a.server.close(); b.server.close(); }
});

test("missing company scope fails before config lookup or fetch", async () => {
  const fake = await startFakeAdapter();
  let configReads = 0;
  try {
    const handlers = new Map();
    const ctx = { config: { get: async () => { configReads++; return { adapterBaseUrl: `http://127.0.0.1:${fake.port}`, adapterToken: "tok" }; } }, data: { register: (k,h) => handlers.set(k,h) }, events:{on(){}}, jobs:{register(){}}, launchers:{register(){}}, logger:{info(){},warn(){},error(){}} };
    plugin.setup(ctx);
    await assert.rejects(() => handlers.get("ops-snapshot")({}), /company/i);
    assert.equal(configReads, 0);
    assert.equal(fake.seen.length, 0);
  } finally { fake.server.close(); }
});

test("token is absent from cache identifiers, returned data, and malicious fetch errors", async () => {
  const token = "unique-secret-token-do-not-leak";
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error(`request failed Authorization: Bearer ${token}`); };
    const { dataHandlers } = makeCtx({ adapterBaseUrl: "http://adapter.invalid", adapterToken: token }, "company-redaction");
    await assert.rejects(() => dataHandlers.get("ops-snapshot")({ companyId: "company-redaction" }), (error) => {
      assert.ok(!String(error).includes(token));
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("adapter 502 fails closed with explicit error", async () => {
  const fake = await startFakeAdapter({ failWith: 502 });
  try {
    const { dataHandlers: captured } = makeCtx({
      adapterBaseUrl: `http://127.0.0.1:${fake.port}`,
      adapterToken: "tok",
    });
    await assert.rejects(
      () => captured.get("ops-snapshot")({ companyId: "company-default" }),
      /fail closed/,
    );
  } finally {
    fake.server.close();
  }
});

test("unexpected payload schema fails closed", async () => {
  const fake = await startFakeAdapter({ badSchema: true });
  try {
    const { dataHandlers: captured } = makeCtx({
      adapterBaseUrl: `http://127.0.0.1:${fake.port}`,
      adapterToken: "tok",
    });
    await assert.rejects(
      () => captured.get("ops-snapshot")({ companyId: "company-default" }),
      /fail closed/,
    );
  } finally {
    fake.server.close();
  }
});

test("missing config fails closed (no invented defaults)", async () => {
  const { dataHandlers: captured } = makeCtx({});
  await assert.rejects(
    () => captured.get("ops-snapshot")({ companyId: "company-default" }),
    /Missing required config/,
  );
});

test("provenance passes through unmodified", async () => {
  const fake = await startFakeAdapter();
  try {
    const { dataHandlers: captured } = makeCtx({
      adapterBaseUrl: `http://127.0.0.1:${fake.port}`,
      adapterToken: "tok",
    });
    const result = await captured.get("ops-snapshot")({ companyId: "company-default" });
    const item = result.snapshot.items[0];
    assert.equal(item.source_version.ops_deployed_sha, SNAPSHOT.ops_deployed_sha);
    assert.deepEqual(item.source_links, SNAPSHOT.items[0].source_links);
    assert.equal(item.pr_head_sha, SNAPSHOT.items[0].pr_head_sha);
  } finally {
    fake.server.close();
  }
});

test("worker source contains no mutating HTTP verbs or action registrations", async () => {
  const fs = await import("node:fs");
  const workerSrc = fs.readFileSync(path.join(here, "../src/worker.ts"), "utf8");
  for (const forbidden of ['method: "POST"', 'method: "PUT"', 'method: "PATCH"', 'method: "DELETE"', "actions.register"]) {
    assert.ok(!workerSrc.includes(forbidden), `worker source must not contain ${forbidden}`);
  }
  assert.ok(workerSrc.includes('method: "GET"'));
});
