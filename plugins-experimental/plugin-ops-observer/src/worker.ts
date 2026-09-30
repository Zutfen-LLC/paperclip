import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";
import { CACHE_TTL_MS, DATA_KEYS } from "./constants.js";

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

async function fetchSnapshot(baseUrl: string, token: string): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, "")}/snapshot`;
  // GET only. This is the only fetch in the plugin.
  const response = await fetch(url, {
    method: "GET",
    // Never follow even same-origin redirects: the only authorized route is /snapshot.
    redirect: "error",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`adapter responded ${response.status} (fail closed)`);
  }
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("adapter returned non-object payload (fail closed)");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== "ops_work_snapshot_v1") {
    throw new Error("unexpected snapshot schema (fail closed)");
  }
  return parsed;
}

const plugin = definePlugin({
  async setup(ctx) {
    // no events, no jobs, no webhooks, no actions: observation is pull-only
    ctx.data.register(DATA_KEYS.snapshot, async (params) => {
      const companyId = typeof params?.companyId === "string" ? params.companyId.trim() : "";
      if (!companyId) throw new Error("Company scope is required");
      let config: Record<string, unknown>;
      try {
        config = await ctx.config.get(companyId);
      } catch {
        throw new Error("Ops snapshot configuration unavailable (fail closed)");
      }
      const baseUrl = normalizedBaseUrl(config.adapterBaseUrl);
      const tokenRef = config.adapterToken;
      let token: string;
      try {
        token = isSecretRefBinding(tokenRef)
          ? await ctx.secrets.resolve(tokenRef, { companyId, configPath: "adapterToken" })
          : requireString(tokenRef, "adapterToken");
      } catch {
        throw new Error("Ops snapshot credential unavailable (fail closed)");
      }
      const cacheKey = JSON.stringify([companyId, baseUrl]);

      const cached = cache.get(cacheKey);
      if (cached && isFresh(cached)) {
        const envelope: SnapshotEnvelope = {
          cached: true,
          fetchedAt: cached.fetchedAt,
          snapshot: cached.snapshot,
        };
        return envelope;
      }

      try {
        const snapshot = await fetchSnapshot(baseUrl, token);
        const entry: CachedEntry = { fetchedAt: Date.now(), snapshot };
        cache.set(cacheKey, entry);
        const envelope: SnapshotEnvelope = {
          fetchedAt: entry.fetchedAt,
          snapshot: entry.snapshot,
        };
        return envelope;
      } catch {
        // Never forward fetch/runtime exception text: it can contain request headers.
        throw new Error("Ops snapshot request failed (fail closed)");
      }
    });
  },
});

runWorker(plugin, import.meta.url);

export default plugin;
