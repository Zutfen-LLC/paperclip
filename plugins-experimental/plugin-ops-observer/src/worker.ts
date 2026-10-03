import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";
import { CACHE_TTL_MS, DATA_KEYS } from "./constants.js";
import { certificationWindow, invalidateCertification, observeRequest, requestStarted, scanCacheIdentifiers } from "./certification.js";

/**
 * Ops Supervisor read-only observer worker.
 *
 * Mechanical read-only constraints:
 * - The ONLY network call is GET {adapterBaseUrl}/snapshot with the adapter
 *   bearer token. No other URL is ever constructed; no other method is used.
 * - No ctx.actions are registered: the UI bridge has no action surface at
 *   all, so no mutating action can be invoked from the plugin UI.
 * - Cache is a read-through derived projection with TTL + fetchedAt; the
 *   source of truth remains the adapter (and Ops behind it). Refresh only
 *   re-reads; it never writes anywhere.
 * - Fail-closed: adapter errors surface as explicit error state, never as
 *   invented snapshot data.
 */

interface SnapshotEnvelope {
  cached?: boolean;
  fetchedAt: number;
  snapshot: unknown;
}

interface CachedEntry {
  fetchedAt: number;
  snapshot: unknown;
}

export const cache = new Map<string, CachedEntry>();

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required config: ${name}`);
  }
  return value.trim();
}

// Pinned to the dedicated CT152 loopback tunnel; see manifest deployment default.
// This is not a generic loopback allowlist and is not company-configurable authority.
const APPROVED_ADAPTER_ORIGIN = "http://127.0.0.1:18487";

function normalizedBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error("Missing required config: adapterBaseUrl");
  }
  // Check literal spelling BEFORE WHATWG parsing can normalize encodings, IPv4
  // aliases, backslashes, control characters, dot segments, or an empty ?/#.
  // Only the exact origin and its single root slash are authorized.
  if (value !== APPROVED_ADAPTER_ORIGIN && value !== `${APPROVED_ADAPTER_ORIGIN}/`) {
    throw new Error("Invalid adapterBaseUrl: destination not approved (fail closed)");
  }
  const parsed = new URL(value);
  if (parsed.origin !== APPROVED_ADAPTER_ORIGIN || parsed.pathname !== "/"
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Invalid adapterBaseUrl: destination not approved (fail closed)");
  }
  return APPROVED_ADAPTER_ORIGIN;
}

function isSecretRefBinding(value: unknown): value is EnvSecretRefBinding {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as { type?: unknown }).type === "secret_ref"
    && typeof (value as { secretId?: unknown }).secretId === "string";
}
function isFresh(entry: CachedEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

async function fetchSnapshot(baseUrl: string, token: string, count: (name: "fetchAttempts" | "fetchSuccesses" | "fetchFailures" | "redirectRefusals" | "upstreamGet" | "adapterAuthAttached") => void): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, "")}/snapshot`;
  // Construct exactly one GET with a worker-owned header; caller headers are ignored.
  count("fetchAttempts");
  count("upstreamGet");
  count("adapterAuthAttached");
  try {
    const response = await fetch(url, {
      method: "GET",
      // Manual mode exposes 3xx status without following or examining Location.
      redirect: "manual",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status >= 300 && response.status < 400) {
      count("redirectRefusals");
      throw new Error("adapter redirect refused (fail closed)");
    }
    if (!response.ok) throw new Error(`adapter responded ${response.status} (fail closed)`);
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error("adapter returned non-object payload (fail closed)");
    if ((parsed as Record<string, unknown>).schema !== "ops_work_snapshot_v1") throw new Error("unexpected snapshot schema (fail closed)");
    count("fetchSuccesses");
    return parsed;
  } catch {
    count("fetchFailures");
    throw new Error("Ops snapshot request failed (fail closed)");
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    // no events, no jobs, no webhooks, no actions: observation is pull-only
    ctx.data.register(DATA_KEYS.certification, async (params) => {
      const companyId = typeof params?.companyId === "string" ? params.companyId.trim() : "";
      if (!companyId) throw new Error("Company scope is required");
      // Register before awaiting config. Release this read before the synchronous
      // start/close decision so it cannot overlap itself; other reads remain pending.
      const endRead = requestStarted(companyId);
      let config: Record<string, unknown>;
      try { config = await ctx.config.get(companyId); }
      catch {
        endRead();
        invalidateCertification(companyId, "config_unavailable");
        throw new Error("Ops snapshot configuration unavailable (fail closed)");
      }
      endRead();
      if (config.certificationEnabled !== true) {
        invalidateCertification(companyId, "certification_disabled");
        throw new Error("Certification not enabled");
      }
      if (params?.command === "start") {
        certificationWindow(companyId, "start");
        scanCacheIdentifiers(companyId, cache.keys(), APPROVED_ADAPTER_ORIGIN);
        return certificationWindow(companyId);
      }
      if (params?.command === "close" || params?.command === undefined) {
        scanCacheIdentifiers(companyId, cache.keys(), APPROVED_ADAPTER_ORIGIN);
      }
      return certificationWindow(companyId, params?.command);
    });
    ctx.data.register(DATA_KEYS.snapshot, async (params) => {
      const companyId = typeof params?.companyId === "string" ? params.companyId.trim() : "";
      if (!companyId) throw new Error("Company scope is required");
      const endRequest = requestStarted(companyId);
      let evidence: ReturnType<typeof observeRequest> | undefined;
      try {
        let config: Record<string, unknown>;
        try {
          config = await ctx.config.get(companyId);
        } catch {
          invalidateCertification(companyId, "config_unavailable");
          throw new Error("Ops snapshot configuration unavailable (fail closed)");
        }
        evidence = observeRequest(companyId, config.certificationEnabled === true);
        // The destination gate MUST precede credential and cache access.
        let baseUrl: string;
        try { baseUrl = normalizedBaseUrl(config.adapterBaseUrl); }
        catch {
          evidence.count("rejectedOrigin");
          if (config.adapterBaseUrl === undefined || config.adapterBaseUrl === "") throw new Error("Missing required config: adapterBaseUrl");
          throw new Error("Invalid adapterBaseUrl: destination not approved (fail closed)");
        }
        evidence.count("acceptedOrigin");
        const tokenRef = config.adapterToken;
        const resolveBinding = isSecretRefBinding(tokenRef);
        let token: string;
        if (resolveBinding) evidence.count("secretResolutionAttempts");
        try {
          token = resolveBinding
            ? await ctx.secrets.resolve(tokenRef, { companyId, configPath: "adapterToken" })
            : requireString(tokenRef, "adapterToken");
        } catch {
          if (resolveBinding) evidence.count("secretResolutionFailures");
          throw new Error("Ops snapshot credential unavailable (fail closed)");
        }
        const cacheKey = JSON.stringify([companyId, baseUrl]);
        scanCacheIdentifiers(companyId, cache.keys(), APPROVED_ADAPTER_ORIGIN,
          resolveBinding ? [token, tokenRef.secretId] : [token], "read");
        evidence.count("cacheReads");
        const cached = cache.get(cacheKey);
        if (cached && isFresh(cached)) {
          evidence.count("cacheHits");
          const envelope: SnapshotEnvelope = {
            cached: true,
            fetchedAt: cached.fetchedAt,
            snapshot: cached.snapshot,
          };
          return envelope;
        }
        evidence.count(cached ? "cacheRefreshes" : "cacheMisses");
        try {
          const snapshot = await fetchSnapshot(baseUrl, token, evidence.count);
          const entry: CachedEntry = { fetchedAt: Date.now(), snapshot };
          cache.set(cacheKey, entry);
          scanCacheIdentifiers(companyId, cache.keys(), APPROVED_ADAPTER_ORIGIN,
            resolveBinding ? [token, tokenRef.secretId] : [token], "insert");
          const envelope: SnapshotEnvelope = {
            fetchedAt: entry.fetchedAt,
            snapshot: entry.snapshot,
          };
          return envelope;
        } catch {
          // Never forward fetch/runtime exception text: it can contain request headers.
          throw new Error("Ops snapshot request failed (fail closed)");
        }
      } finally {
        endRequest();
      }
    });
  },
});

runWorker(plugin, import.meta.url);

export default plugin;
