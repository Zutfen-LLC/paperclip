import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const { default: worker, cache } = await import('../dist/worker.js');
const plugin = worker.definition;
const origin = 'http://127.0.0.1:18487';
const secret = 'secret-do-not-emit-issue10';
const binding = { type: 'secret_ref', secretId: 'secret-id-do-not-emit-issue10' };
const config = { adapterBaseUrl: origin, adapterToken: binding, certificationEnabled: true };
const snapshot = { schema: 'ops_work_snapshot_v1' };
function harness(configFor = () => config, resolve = async () => secret) {
  const handlers = new Map(), logs = [];
  plugin.setup({ data: { register: (key, fn) => handlers.set(key, fn) }, config: { get: configFor },
    secrets: { resolve }, logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  const read = (companyId, command) => handlers.get('ops-certification')({ companyId, command });
  const get = (companyId, extra = {}) => handlers.get('ops-snapshot')({ companyId, ...extra });
  return { read, get, handlers, logs };
}
function serve(handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url, headers: req.headers }); handler(req, res); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ seen, server,
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); },
    port: server.address().port }))); 
}
async function transport(fixture, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, options) => { assert.equal(url, `${origin}/snapshot`); return original(`http://127.0.0.1:${fixture.port}/snapshot`, options); };
  try { await fn(); } finally { globalThis.fetch = original; await fixture.close(); }
}
test('opt-in lifecycle counts GET, worker auth, cache miss/hit/TTL refresh, failed fetch and isolates companies', async () => {
  cache.clear();
  const fixture = await serve((_req, res) => { res.writeHead(fixture.fail ? 502 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture.fail ? {} : snapshot)); });
  const h = harness();
  const now = Date.now; let clock = 1_000_000; Date.now = () => clock;
  try { await transport(fixture, async () => {
    assert.equal((await h.read('a', 'start')).status, 'active');
    await h.get('a', { headers: { Authorization: 'caller-do-not-emit', Cookie: 'caller-cookie-do-not-emit' } });
    await h.get('a');
    clock += 30_000;
    fixture.fail = true;
    await assert.rejects(() => h.get('a'), /fail closed/);
    const a = await h.read('a', 'close');
    assert.equal(a.status, 'complete');
    assert.deepEqual(a.counters, { acceptedOrigin: 3, rejectedOrigin: 0, secretResolutionAttempts: 3,
      secretResolutionFailures: 0, cacheReads: 3, cacheHits: 1, cacheMisses: 1, cacheRefreshes: 1,
      fetchAttempts: 2, fetchSuccesses: 1, fetchFailures: 1, redirectRefusals: 0,
      upstreamGet: 2, adapterAuthAttached: 2 });
    assert.deepEqual(a.upstreamMethod, 'GET');
    assert.equal(a.adapterAuthHeaderAttached, true);
    assert.deepEqual(fixture.seen.map(x => x.method), ['GET', 'GET']);
    assert.deepEqual(Object.keys(fixture.seen[0].headers).filter(k => k === 'authorization' || k === 'cookie'), ['authorization']);
    assert.equal(fixture.seen[0].headers.authorization, `Bearer ${secret}`);
    assert.equal((await h.read('a')).status, 'complete');
    assert.equal((await h.read('b', 'start')).counters.fetchAttempts, 0);
    assert.equal(JSON.stringify([a, h.logs, [...cache.keys()]]).includes(secret), false);
    assert.equal(JSON.stringify(a).includes(binding.secretId), false);
    assert.equal(JSON.stringify(a).includes('caller-do-not-emit'), false);
  }); } finally { Date.now = now; }
});
test('rejected origin and failed secret resolution count negative paths without cache or fetch', async () => {
  cache.clear(); let resolutions = 0, fetches = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { fetches++; throw Error('must not fetch'); };
  const h = harness(() => ({ ...config, adapterBaseUrl: 'http://127.0.0.1:18488' }), async () => { resolutions++; throw Error(secret); });
  const auth = harness(() => config, async () => { resolutions++; throw Error(secret); });
  try {
    await h.read('rejected', 'start');
    await assert.rejects(() => h.get('rejected'), /destination not approved/);
    const rejected = await h.read('rejected', 'close');
    assert.equal(rejected.counters.rejectedOrigin, 1);
    for (const key of ['secretResolutionAttempts', 'cacheReads', 'cacheRefreshes', 'fetchAttempts']) assert.equal(rejected.counters[key], 0);
    await auth.read('auth', 'start');
    await assert.rejects(() => auth.get('auth'), /credential unavailable/);
    const failed = await auth.read('auth', 'close');
    assert.equal(failed.counters.secretResolutionAttempts, 1);
    assert.equal(failed.counters.secretResolutionFailures, 1);
    assert.equal(failed.counters.fetchAttempts, 0);
    assert.equal(resolutions, 1); assert.equal(fetches, 0);
    assert.equal(JSON.stringify([rejected, failed, h.logs, auth.logs]).includes(secret), false);
  } finally { globalThis.fetch = oldFetch; }
});
test('real HTTP redirect refuses Location without contacting redirected listener', async () => {
  cache.clear();
  const target = await serve((_req, res) => { res.end('should not arrive'); });
  const redirect = await serve((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target.port}/leak?secret=${secret}` }); res.end(); });
  const h = harness();
  try { await transport(redirect, async () => {
    await h.read('redirect', 'start');
    await assert.rejects(() => h.get('redirect'), /fail closed/);
    const receipt = await h.read('redirect', 'close');
    assert.equal(receipt.counters.fetchAttempts, 1);
    assert.equal(receipt.counters.fetchFailures, 1);
    assert.equal(receipt.counters.redirectRefusals, 1);
    assert.equal(target.seen.length, 0);
    assert.equal(JSON.stringify([receipt, h.logs]).includes(secret), false);
  }); } finally { await target.close(); }
});
test('disabled configuration cannot start or read telemetry and does not change snapshot envelope', async () => {
  cache.clear(); const h = harness(() => ({ ...config, certificationEnabled: false }));
  await assert.rejects(() => h.read('disabled', 'start'), /not enabled/);
  const fixture = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(snapshot)); });
  await transport(fixture, async () => { assert.deepEqual(Object.keys(await h.get('disabled')).sort(), ['fetchedAt', 'snapshot']); });
});
test('bounded receipt and full fixture window remain free of credentials and header values', async () => {
  cache.clear();
  const fixture = await serve((_req, res) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: secret })); });
  const h = harness();
  const errors = [];
  try { await transport(fixture, async () => {
    await h.read('hygiene', 'start');
    for (const suffix of ['first', 'second']) {
      try { await h.get('hygiene', { headers: { Authorization: `caller-${suffix}-header-do-not-emit` } }); }
      catch (err) { errors.push(err.message); }
    }
    const receipt = await h.read('hygiene', 'close');
    assert.equal(receipt.counters.fetchFailures, 2);
    const completeWindow = JSON.stringify({ receipt, errors, logs: h.logs, cacheKeys: [...cache.keys()], cacheValues: [...cache.values()] });
    for (const sentinel of [secret, binding.secretId, 'caller-first-header-do-not-emit', 'caller-second-header-do-not-emit']) {
      assert.equal(completeWindow.includes(sentinel), false);
    }
  }); } finally { /* transport closes the fixture */ }
});

test('closing during configuration lookup cannot claim a complete window', async () => {
  cache.clear(); let release;
  const h = harness(() => new Promise(resolve => { release = () => resolve(config); }));
  // Start normally, then hold only the snapshot config read.
  const initial = harness();
  await initial.read('pending-config', 'start');
  const request = h.get('pending-config');
  const receipt = await initial.read('pending-config', 'close');
  assert.equal(receipt.status, 'incomplete');
  assert.equal(receipt.inFlight, 1);
  release();
  await assert.rejects(request, /fail closed/);
});

test('concurrent close is incomplete and bounded window expires incomplete', async () => {
  cache.clear(); let release;
  const fixture = await serve((_req, res) => { release = () => { if (!res.headersSent) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(snapshot)); } }; });
  const h = harness();
  try { await transport(fixture, async () => {
    await h.read('concurrent', 'start');
    const pending = h.get('concurrent');
    while (!release) await new Promise(done => setTimeout(done, 1));
    const closed = await h.read('concurrent', 'close');
    assert.equal(closed.status, 'incomplete');
    assert.equal(closed.inFlight, 1);
    release(); await pending;
    assert.equal((await h.read('concurrent')).status, 'incomplete');
    await h.read('expiry', 'start');
    const old = Date.now; Date.now = () => old() + 301_000;
    try { assert.equal((await h.read('expiry')).status, 'incomplete'); } finally { Date.now = old; }
  }); } finally { if (release) release(); }
});
