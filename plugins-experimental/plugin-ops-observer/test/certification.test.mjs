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
test('disabled snapshot interval invalidates the active window even after re-enable', async () => {
  cache.clear(); let enabled = true;
  const h = harness(() => ({ ...config, certificationEnabled: enabled }));
  const fixture = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(snapshot)); });
  try { await transport(fixture, async () => {
    assert.equal((await h.read('toggle-snapshot', 'start')).status, 'active');
    enabled = false;
    await h.get('toggle-snapshot');
    enabled = true;
    const closed = await h.read('toggle-snapshot', 'close');
    assert.equal(closed.status, 'incomplete');
    assert.equal(closed.incompleteReason, 'certification_disabled');
    assert.equal(closed.counters.acceptedOrigin, 0);
    assert.equal((await h.read('toggle-snapshot', 'start')).status, 'active');
  }); } finally { /* transport closes fixture */ }
});
test('disabled certification read invalidates only its own active company window', async () => {
  let enabled = true;
  const h = harness(companyId => ({ ...config, certificationEnabled: companyId === 'toggle-read' ? enabled : true }));
  await h.read('toggle-read', 'start');
  await h.read('unaffected', 'start');
  enabled = false;
  await assert.rejects(() => h.read('toggle-read'), /not enabled/);
  enabled = true;
  const closed = await h.read('toggle-read', 'close');
  assert.equal(closed.status, 'incomplete');
  assert.equal(closed.incompleteReason, 'certification_disabled');
  assert.equal((await h.read('unaffected', 'close')).status, 'complete');
});
test('post-start snapshot config failure invalidates the window after request exits', async () => {
  let broken = false;
  const h = harness(async () => { if (broken) throw new Error(secret); return config; });
  await h.read('config-failure', 'start');
  broken = true;
  await assert.rejects(() => h.get('config-failure'), /configuration unavailable/);
  broken = false;
  const closed = await h.read('config-failure', 'close');
  assert.equal(closed.status, 'incomplete');
  assert.equal(closed.incompleteReason, 'config_unavailable');
  assert.equal(closed.inFlight, 1); // frozen when config failure invalidated the active request
  assert.equal(closed.counters.acceptedOrigin, 0);
  assert.equal(JSON.stringify(closed).includes(secret), false);
  assert.equal((await h.read('config-failure', 'start')).status, 'active');
});
test('post-start certification config failure invalidates its window', async () => {
  let broken = false;
  const h = harness(async () => { if (broken) throw new Error(secret); return config; });
  await h.read('read-failure', 'start');
  broken = true;
  await assert.rejects(() => h.read('read-failure'), /configuration unavailable/);
  broken = false;
  const closed = await h.read('read-failure', 'close');
  assert.equal(closed.status, 'incomplete');
  assert.equal(closed.incompleteReason, 'config_unavailable');
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

for (const outcome of ['disabled', 'failed']) {
  test(`overlapping certification config read ${outcome} cannot leave a complete receipt`, async () => {
    let release;
    let hold = false;
    const h = harness(() => hold ? new Promise((resolve, reject) => {
      release = () => outcome === 'disabled'
        ? resolve({ ...config, certificationEnabled: false }) : reject(new Error(secret));
    }) : config);
    await h.read(`overlap-${outcome}`, 'start');
    hold = true;
    const pending = h.read(`overlap-${outcome}`);
    assert.equal(typeof release, 'function');
    hold = false;
    const closed = await h.read(`overlap-${outcome}`, 'close');
    assert.equal(closed.status, 'incomplete');
    assert.equal(closed.incompleteReason, 'request_overlap');
    assert.equal(closed.inFlight, 1);
    release();
    await assert.rejects(pending, outcome === 'disabled' ? /not enabled/ : /configuration unavailable/);
    const reread = await h.read(`overlap-${outcome}`);
    assert.deepEqual(reread, closed);
    assert.equal(JSON.stringify(reread).includes(secret), false);
  });
}

test('opening during an earlier certification config read remains incomplete after resolution', async () => {
  let release;
  let hold = true;
  const h = harness(() => hold ? new Promise(resolve => { release = () => resolve(config); }) : config);
  const prior = h.read('prior-read');
  hold = false;
  const opened = await h.read('prior-read', 'start');
  assert.equal(opened.status, 'incomplete');
  assert.equal(opened.incompleteReason, 'request_overlap');
  assert.equal(opened.inFlight, 1);
  release();
  assert.deepEqual(await prior, opened);
  assert.deepEqual(await h.read('prior-read', 'close'), opened);
});

test('completed receipt stays fixed while a later snapshot config lookup is pending', async () => {
  let release;
  let hold = false;
  const h = harness(() => hold ? new Promise(resolve => {
    release = () => resolve({ ...config, adapterBaseUrl: 'http://127.0.0.1:18488' });
  }) : config);
  await h.read('stable-complete', 'start');
  const closed = await h.read('stable-complete', 'close');
  assert.equal(closed.status, 'complete');
  assert.equal(closed.inFlight, 0);
  hold = true;
  const pending = h.get('stable-complete');
  hold = false;
  assert.equal(typeof release, 'function');
  assert.deepEqual(await h.read('stable-complete'), closed);
  release();
  await assert.rejects(pending, /destination not approved/);
  assert.deepEqual(await h.read('stable-complete'), closed);
});

test('authorized bridge exports bounded private-free cache inventory covering reads and inserts', async () => {
  cache.clear(); const h = harness();
  const fixture = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(snapshot)); });
  try { await transport(fixture, async () => {
    await h.read('inventory-a', 'start');
    await h.get('inventory-a'); await h.get('inventory-a');
    const closed = await h.read('inventory-a', 'close');
    assert.equal(closed.status, 'complete');
    assert.equal(closed.cacheIdentifiers.schema, 'ops_worker_cache_identifiers_v1');
    assert.equal(closed.cacheIdentifiers.reads, 2);
    assert.equal(closed.cacheIdentifiers.inserts, 1);
    assert.ok(closed.cacheIdentifiers.entriesInspected >= 3);
    assert.equal(closed.cacheIdentifiers.leaks, 0);
    assert.equal(closed.cacheIdentifiers.shapeViolations, 0);
    assert.match(closed.cacheIdentifiers.digest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(closed).includes('inventory-a'), false);
    assert.equal(JSON.stringify(closed).includes(secret), false);
    assert.equal(JSON.stringify(closed).includes(origin), false);
    const other = await h.read('inventory-b', 'start');
    assert.equal(other.cacheIdentifiers.entriesInspected, 0);
  }); } finally { cache.clear(); }
});

test('preexisting malformed identifier fails closed without exporting raw keys', async () => {
  cache.clear(); const h = harness();
  cache.set(JSON.stringify(['leaky', origin + secret]), { fetchedAt: Date.now(), snapshot });
  const leaky = await h.read('leaky', 'start');
  assert.equal(leaky.status, 'incomplete');
  assert.equal(leaky.incompleteReason, 'cache_identifier_hygiene');
  assert.equal(leaky.cacheIdentifiers.shapeViolations, 1);
  assert.equal(JSON.stringify(leaky).includes(secret), false);
  cache.clear(); cache.set('not-a-schema-key', { fetchedAt: Date.now(), snapshot });
  const malformed = await h.read('malformed', 'start');
  assert.equal(malformed.status, 'incomplete');
  assert.equal(malformed.incompleteReason, 'cache_identifier_hygiene');
  cache.clear();
});

test('cache evidence resets per window and isolates another company while terminal receipt freezes', async () => {
  cache.clear(); const h = harness();
  cache.set(JSON.stringify(['reset-a', origin]), { fetchedAt: Date.now(), snapshot });
  const first = await h.read('reset-a', 'start');
  assert.equal(first.cacheIdentifiers.entriesInspected, 1);
  const closed = await h.read('reset-a', 'close');
  assert.equal(closed.cacheIdentifiers.entriesInspected, 2);
  const b = await h.read('reset-b', 'start');
  assert.equal(b.cacheIdentifiers.entriesInspected, 0);
  const second = await h.read('reset-a', 'start');
  assert.equal(second.cacheIdentifiers.entriesInspected, 1);
  assert.equal(second.cacheIdentifiers.scans, 1);
  assert.equal(closed.cacheIdentifiers.entriesInspected, 2);
  cache.clear();
});

test('worker scans resolved plaintext against valid-shaped live identifiers without exporting it', async () => {
  cache.clear();
  const companyId = secret;
  cache.set(JSON.stringify([companyId, origin]), { fetchedAt: Date.now(), snapshot });
  const h = harness();
  await h.read(companyId, 'start');
  await h.get(companyId);
  const receipt = await h.read(companyId, 'close');
  assert.equal(receipt.status, 'incomplete');
  assert.equal(receipt.incompleteReason, 'cache_identifier_hygiene');
  assert.ok(receipt.cacheIdentifiers.leaks > 0);
  assert.equal(JSON.stringify(receipt).includes(secret), false);
  cache.clear();
});

test('oversize cache inventory cannot claim complete and does not disclose identifiers', async () => {
  cache.clear();
  const h = harness();
  cache.set(JSON.stringify(['limit-company', origin]) + 'x'.repeat(5000), { fetchedAt: Date.now(), snapshot });
  const receipt = await h.read('limit-company', 'start');
  assert.equal(receipt.status, 'incomplete');
  assert.equal(receipt.incompleteReason, 'cache_inventory_limit');
  assert.equal(JSON.stringify(receipt).includes('limit-company'), false);
  cache.clear();
});

test('cache receipt freezes on overlapping close and rejected origin does not access cache or secret', async () => {
  cache.clear(); let release; let resolutions = 0;
  const h = harness(() => config, async () => { resolutions++; return secret; });
  const bad = harness(() => ({ ...config, adapterBaseUrl: 'http://127.0.0.1:18488' }), async () => { throw Error('secret must not resolve'); });
  const fixture = await serve((_req, res) => { release = () => { if (!res.headersSent) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(snapshot)); } }; });
  try { await transport(fixture, async () => {
    await h.read('overlap-cache', 'start');
    const pending = h.get('overlap-cache');
    while (!release) await new Promise(done => setTimeout(done, 1));
    const closed = await h.read('overlap-cache', 'close');
    assert.equal(closed.status, 'incomplete');
    release(); await pending;
    assert.deepEqual(await h.read('overlap-cache'), closed);
    await bad.read('rejected-cache', 'start');
    await assert.rejects(() => bad.get('rejected-cache'), /destination not approved/);
    const rejected = await bad.read('rejected-cache', 'close');
    assert.equal(rejected.cacheIdentifiers.reads, 0);
    assert.equal(rejected.cacheIdentifiers.inserts, 0);
    assert.equal(resolutions, 1);
  }); } finally { if (release) release(); cache.clear(); }
});
