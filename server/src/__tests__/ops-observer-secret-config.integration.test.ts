import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  pluginConfig,
  plugins,
  secretAccessEvents,
} from "@paperclipai/db";
import { PLUGIN_ID, PLUGIN_VERSION } from "../../../plugins-experimental/plugin-ops-observer/src/constants.js";
import manifest from "../../../plugins-experimental/plugin-ops-observer/src/manifest.js";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/index.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { secretService } from "../services/secrets.js";
import { pluginLoader } from "../services/plugin-loader.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;
const sentinel = `ops-observer-secret-${randomUUID()}`;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping ops observer secret config integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("ops observer secret config end-to-end", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const priorKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const keyDir = path.join(os.tmpdir(), `ops-observer-secret-config-${randomUUID()}`);
  let companyId = "";
  let otherCompanyId = "";
  let secretId = "";
  const hostServices: ReturnType<typeof buildHostServices>[] = [];

  beforeAll(async () => {
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const keyFile = path.join(keyDir, "master.key");
    writeFileSync(keyFile, randomUUID().replaceAll("-", "").padEnd(64, "a").slice(0, 64), { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
    const started = await startEmbeddedPostgresTestDatabase("ops-observer-secret-config");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);

    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([companyRow(companyId, "Ops Observer company"), companyRow(otherCompanyId, "Other company")]);
    await db.insert(plugins).values({
      id: randomUUID(),
      pluginKey: PLUGIN_ID,
      packageName: "@paperclipai/plugin-ops-observer",
      version: PLUGIN_VERSION,
      apiVersion: 1,
      categories: ["ui", "connector"],
      manifestJson: manifest,
      status: "ready",
      installOrder: 1,
    });
    const [plugin] = await db.select({ id: plugins.id }).from(plugins).where(eq(plugins.pluginKey, PLUGIN_ID));
    pluginDbId = plugin!.id;
    const created = await secretServiceCreate(companyId, sentinel);
    secretId = created;

    // Exercise the real route and registry against this ephemeral DB.
    const actor = {
      type: "board" as const,
      userId: "ops-observer-test-admin",
      source: "session" as const,
      isInstanceAdmin: true,
      companyIds: [companyId, otherCompanyId],
    };
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = actor; next(); });
    // Real route, pluginRegistryService (inside pluginRoutes), secretService,
    // config validator and DB. Lifecycle/activity/live-event paths are unrelated.
    app.use("/api", pluginRoutes(db, pluginLoader(db), undefined, undefined, undefined, {
      workerManager: { isRunning: () => false } as never,
    }));
    app.use(errorHandler);
  }, 60_000);

  let pluginDbId = "";
  let app: express.Express;

  afterAll(async () => {
    for (const services of hostServices) services.dispose();
    if (db) {
      await db.delete(activityLog);
      await db.delete(secretAccessEvents);
      await db.delete(companySecretBindings);
      await db.delete(pluginConfig);
      await db.delete(companySecretVersions);
      await db.delete(companySecrets);
      await db.delete(plugins);
      await db.delete(companies);
    }
    await stopDb?.();
    if (priorKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = priorKeyFile;
    rmSync(keyDir, { recursive: true, force: true });
  });

  async function secretServiceCreate(selectedCompany: string, value: string): Promise<string> {
    const secret = await secretService(db).create(selectedCompany, {
      name: `ops-observer-${randomUUID()}`, provider: "local_encrypted", managedMode: "paperclip_managed", value,
    });
    expect(secret).toMatchObject({ companyId: selectedCompany, provider: "local_encrypted", managedMode: "paperclip_managed" });
    return secret.id;
  }

  async function postConfig(configJson: Record<string, unknown>, selectedCompany = companyId) {
    return request(app).post(`/api/plugins/${pluginDbId}/config`).send({ companyId: selectedCompany, configJson });
  }

  async function storedState() {
    const configs = await db.select().from(pluginConfig).where(eq(pluginConfig.pluginId, pluginDbId));
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, pluginDbId));
    return { configs, bindings };
  }

  it("POSTs and GETs the real manifest config, persists exact binding scope, and resolves only through the host handler", async () => {
    const configJson = {
      adapterBaseUrl: "http://127.0.0.1:18487",
      adapterToken: { type: "secret_ref", secretId },
    };
    const post = await postConfig(configJson);
    expect(post.status).toBe(200);
    expect(post.body.configJson).toEqual(configJson);

    const get = await request(app).get(`/api/plugins/${pluginDbId}/config`).query({ companyId });
    expect(get.status).toBe(200);
    expect(JSON.stringify(get.body).includes(sentinel)).toBe(false);
    expect(get.body.configJson.adapterToken).toEqual({ type: "secret_ref", secretId });

    const { configs, bindings } = await storedState();
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ companyId, pluginId: pluginDbId, configJson });
    expect(bindings.map(({ companyId: c, targetType, targetId, configPath, secretId: s, versionSelector }) => ({
      companyId: c, targetType, targetId, configPath, secretId: s, versionSelector,
    }))).toEqual([{
      companyId, targetType: "plugin", targetId: pluginDbId, configPath: "adapterToken", secretId, versionSelector: "latest",
    }]);

    const services = buildHostServices(db, pluginDbId, PLUGIN_ID, createPluginEventBus(), undefined, { manifest });
    hostServices.push(services);
    const handler = services.secrets;
    // Reading config never requests a plaintext projection from the provider.
    const accessesBefore = await db.select().from(secretAccessEvents);
    expect(accessesBefore).toHaveLength(0);
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretId));
    expect(versions).toHaveLength(1);
    expect(JSON.stringify(versions).includes(sentinel)).toBe(false);
    expect(JSON.stringify(configs).includes(sentinel)).toBe(false);
    expect(JSON.stringify(bindings).includes(sentinel)).toBe(false);
    const ref = configJson.adapterToken as { type: "secret_ref"; secretId: string };
    const resolved = await handler.resolve({ companyId, configPath: "adapterToken", secretRef: ref });
    expect(resolved === sentinel).toBe(true);
    expect(JSON.stringify(get.body).includes(resolved)).toBe(false);
    const accesses = await db.select().from(secretAccessEvents);
    expect(accesses).toHaveLength(1);
    expect(accesses[0]).toMatchObject({
      companyId, pluginId: pluginDbId, consumerId: pluginDbId,
      consumerType: "plugin_worker", configPath: "adapterToken", outcome: "success",
    });
    expect(JSON.stringify(accesses).includes(sentinel)).toBe(false);
    const readAgain = await request(app).get(`/api/plugins/${pluginDbId}/config`).query({ companyId });
    expect(readAgain.status).toBe(200);
    expect(readAgain.body.configJson).toEqual(configJson);
    expect(readAgain.text.includes(sentinel)).toBe(false);
    expect(await db.select().from(secretAccessEvents)).toHaveLength(1);

    const cases = [
      { companyId: otherCompanyId, configPath: "adapterToken", secretRef: ref },
      { companyId, configPath: "someOtherPath", secretRef: ref },
      { configPath: "adapterToken", secretRef: ref },
      { companyId, configPath: "adapterToken", secretRef: { type: "secret_ref", secretId: randomUUID() } },
      { companyId, configPath: "adapterToken", secretRef: { type: "secret_ref", secretId: "not-a-uuid" } },
      { companyId, configPath: "adapterToken", secretRef: secretId },
    ];
    for (const input of cases) {
      let caught: unknown;
      try { await handler.resolve(input as never); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message.includes(sentinel)).toBe(false);
    }

    const otherPluginId = randomUUID();
    await db.insert(plugins).values({
      id: otherPluginId, pluginKey: `test.other-${otherPluginId}`, packageName: "test.other",
      version: PLUGIN_VERSION, apiVersion: 1, categories: ["ui"],
      manifestJson: { ...manifest, id: `test.other-${otherPluginId}` }, status: "ready", installOrder: 2,
    });
    const otherServices = buildHostServices(db, otherPluginId, "test.other", createPluginEventBus());
    hostServices.push(otherServices);
    await expect(otherServices.secrets.resolve({ companyId, configPath: "adapterToken", secretRef: ref })).rejects.toThrow(/not bound/i);

    // Rejected company/plugin/path/ref probes must not reach the provider.
    expect(await db.select().from(secretAccessEvents)).toHaveLength(1);
    await db.insert(companySecretBindings).values({
      companyId, targetType: "plugin", targetId: pluginDbId, secretId,
      configPath: "anotherAdapterToken", versionSelector: "latest",
    });
    let ambiguous: unknown;
    try { await handler.resolve({ companyId, secretRef: ref }); } catch (error) { ambiguous = error; }
    expect(ambiguous).toBeInstanceOf(Error);
    expect((ambiguous as Error).message).toMatch(/ambiguous/i);
    expect((ambiguous as Error).message.includes(sentinel)).toBe(false);
  });

  it.each(["malformed ref", "bare UUID ref", "plaintext credential"])("rejects %s without changing persisted config or bindings", async (label) => {
    // Build values at execution time: secretId is allocated in beforeAll.
    const adapterToken = label === "malformed ref" ? { type: "secret_ref", secretId: "not-a-uuid" }
      : label === "bare UUID ref" ? secretId : sentinel;
    const baseline = await storedState();
    const res = await postConfig({ adapterBaseUrl: "http://127.0.0.1:18487", adapterToken });
    expect([400, 422]).toContain(res.status);
    expect(JSON.stringify(res.body).includes(sentinel)).toBe(false);
    expect(JSON.stringify(res.body).length).toBeLessThan(2_000);
    const after = await storedState();
    expect(after.configs).toEqual(baseline.configs);
    expect(after.bindings).toEqual(baseline.bindings);
  });

  it("rejects a cross-company secret without changing persisted config or bindings", async () => {
    const foreignSecretId = await secretServiceCreate(otherCompanyId, `foreign-${sentinel}`);
    const baseline = await storedState();
    const res = await postConfig({
      adapterBaseUrl: "http://127.0.0.1:18487",
      adapterToken: { type: "secret_ref", secretId: foreignSecretId },
    });
    expect([400, 422]).toContain(res.status);
    expect(JSON.stringify(res.body).includes(sentinel)).toBe(false);
    const after = await storedState();
    expect(after.configs).toEqual(baseline.configs);
    expect(after.bindings).toEqual(baseline.bindings);
  });
});

function companyRow(id: string, name: string) {
  return { id, name, issuePrefix: `P${id.slice(0, 7)}`.toUpperCase(), status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
}
