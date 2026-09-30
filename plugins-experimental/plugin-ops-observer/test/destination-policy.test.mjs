import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { inspect } from "node:util";

const worker = await import("../dist/worker.js");
const plugin = worker.default.definition;
const approved = "http://127.0.0.1:18487"; // reviewed manifest deployment endpoint
export const rejectedDestinations = [
  "http://evil.example:18487", "http://localhost:18487", "http://localhost.:18487",
  "http://10.0.0.31:18487", "http://192.168.1.1:18487", "http://8.8.8.8:18487",
  "http://127.0.0.1:18488", "http://127.0.0.1", "http://127.0.0.1:80",
  "https://127.0.0.1:18487", "ftp://127.0.0.1:18487", "file://127.0.0.1:18487",
  "http://user:password@127.0.0.1:18487", "http://@127.0.0.1:18487",
  `${approved}?x=1`, `${approved}?`, `${approved}#fragment`, `${approved}#`,
  `${approved}/snapshot`, `${approved}/other`, `${approved}//`, `${approved}/.`,
  `${approved}/../`, `${approved}/%2e/`, `${approved}/%2e%2e/`, `${approved}/%2f`,
  `${approved}/\\evil.example`, "http://127.0.0.1:18487.evil.example",
  "http://127.0.0.1.evil.example:18487", "http://evil127.0.0.1:18487",
  "http://127.0.0.1:18487@evil.example", "http://evil.example@127.0.0.1:18487",
  "http://127.1:18487", "http://127.0.1:18487", "http://127.0.0.2:18487",
  "http://2130706433:18487", "http://0x7f000001:18487", "http://0177.0.0.1:18487",
  "http://127.000.000.001:18487", "http://127.0.0.1.:18487",
  "http://[::1]:18487", "http://[0:0:0:0:0:0:0:1]:18487", "http://[::ffff:127.0.0.1]:18487",
  "http://%31%32%37.0.0.1:18487", "http://127%2e0%2e0%2e1:18487",
  "HTTP://127.0.0.1:18487", "http://127.0.0.1:018487", "http:127.0.0.1:18487",
  "http:/127.0.0.1:18487", "http:////127.0.0.1:18487", "http:\\\\127.0.0.1:18487",
  ` ${approved}`, `${approved} `, `\n${approved}`, `http://127.0.0.1:\t18487`,
  "http://１２７.０.０.１:18487", "//127.0.0.1:18487", "not-a-url", "",
];
const payload = { schema: "ops_work_snapshot_v1", schema_version: 1, items: [] };

for (const destination of rejectedDestinations) {
  for (const credentialKind of ["secret-ref", "raw"]) {
    for (const cacheState of ["cold", "seeded"]) {
    test(`destination rejected before all sensitive operations: ${JSON.stringify(destination)} (${credentialKind}, ${cacheState})`, async () => {
      worker.cache.clear();
      const token = "destination-secret-sentinel-do-not-expose";
      let resolutions = 0, fetches = 0, tokenReads = 0, cacheReads = 0;
      const logs = [], handlers = new Map();
      const config = { adapterBaseUrl: destination };
      Object.defineProperty(config, "adapterToken", { get() {
        tokenReads++;
        return credentialKind === "raw" ? token : { type: "secret_ref", secretId: "company-secret" };
      } });
      // Seed both the approved cache and whatever the legacy parser would use.
      const keys = [JSON.stringify(["policy-company", approved])];
      try { keys.push(JSON.stringify(["policy-company", new URL(destination.trim()).toString().replace(/\/$/, "")])); } catch {}
      if (cacheState === "seeded") for (const key of keys) worker.cache.set(key, { fetchedAt: Date.now(), snapshot: payload });
      const originalFetch = globalThis.fetch, originalGet = worker.cache.get;
      worker.cache.get = function (...args) { cacheReads++; return originalGet.apply(this, args); };
      globalThis.fetch = async () => { fetches++; return { ok: true, json: async () => payload }; };
      try {
        await plugin.setup({
          config: { get: async (companyId) => { assert.equal(companyId, "policy-company"); return config; } },
          secrets: { resolve: async () => { resolutions++; return token; } },
          data: { register: (key, handler) => handlers.set(key, handler) },
          logger: Object.fromEntries(["info", "warn", "error", "debug"].map(key => [key, (...args) => logs.push(args)])),
        });
        let result, error;
        try { result = await handlers.get("ops-snapshot")({ companyId: "policy-company" }); } catch (caught) { error = caught; }
        // Assert hygiene/counters even when the expected rejection is absent.
        assert.equal(inspect({ result, error, logs, keys: [...worker.cache.keys()], entries: [...worker.cache.values()] }, { depth: null }).includes(token), false);
        assert.deepEqual({ resolutions, fetches, tokenReads, cacheReads }, { resolutions: 0, fetches: 0, tokenReads: 0, cacheReads: 0 });
        assert.ok(error instanceof Error, "must reject rather than return cached authoritative data");
        assert.match(error.message, /adapterBaseUrl/);
      } finally { globalThis.fetch = originalFetch; worker.cache.get = originalGet; worker.cache.clear(); }
    });
    }
  }
}

test("approved spelling and single root slash share normalized company cache without token in key", async () => {
  worker.cache.clear();
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => { seen.push({ url, options }); return { ok: true, json: async () => payload }; };
  try {
    for (const destination of [approved, `${approved}/`]) {
      const handlers = new Map();
      await plugin.setup({ config: { get: async () => ({ adapterBaseUrl: destination, adapterToken: "approved-token" }) }, data: { register: (k, h) => handlers.set(k, h) } });
      const result = await handlers.get("ops-snapshot")({ companyId: "approved-company" });
      assert.deepEqual(result.snapshot, payload);
      if (destination.endsWith("/")) assert.equal(result.cached, true);
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${approved}/snapshot`);
    assert.equal(seen[0].options.method, "GET");
    assert.equal(seen[0].options.redirect, "error");
    assert.deepEqual([...worker.cache.keys()], [JSON.stringify(["approved-company", approved])]);
  } finally { globalThis.fetch = originalFetch; worker.cache.clear(); }
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`real HTTP ${status} redirect is refused without target request or credential exposure`, async () => {
    worker.cache.clear();
    const originalFetch = globalThis.fetch;
    let redirectedRequests = 0, initialRequests = 0;
    const target = http.createServer((req, res) => { redirectedRequests++; res.end(JSON.stringify(payload)); });
    await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
    const source = http.createServer((req, res) => {
      initialRequests++;
      res.writeHead(status, { location: `http://127.0.0.1:${target.address().port}/snapshot` }); res.end();
    });
    await new Promise(resolve => source.listen(0, "127.0.0.1", resolve));
    // Test transport maps only the already-authorized URL to a disposable listener;
    // production destination policy and native fetch redirect handling are untouched.
    globalThis.fetch = (url, options) => {
      assert.equal(url, `${approved}/snapshot`);
      return originalFetch(`http://127.0.0.1:${source.address().port}/snapshot`, options);
    };
    const handlers = new Map();
    try {
      await plugin.setup({ config: { get: async () => ({ adapterBaseUrl: approved, adapterToken: "redirect-secret" }) }, data: { register: (k, h) => handlers.set(k, h) } });
      await assert.rejects(() => handlers.get("ops-snapshot")({ companyId: "redirect-company" }), error => {
        assert.equal(error.message, "Ops snapshot request failed (fail closed)");
        assert.equal(inspect(error).includes("redirect-secret"), false); return true;
      });
      assert.equal(initialRequests, 1);
      assert.equal(redirectedRequests, 0);
      assert.equal(worker.cache.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
      source.closeAllConnections(); target.closeAllConnections();
      await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => target.close(resolve))]);
    }
  });
}
