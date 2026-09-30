import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
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

const cache = new Map<string, CachedEntry>();

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required config: ${name}`);
  }
  return value.trim();
}

function isFresh(entry: CachedEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

async function fetchSnapshot(baseUrl: string, token: string): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, "")}/snapshot`;
  // GET only. This is the only fetch in the plugin.
  const response = await fetch(url, {
    method: "GET",
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
  setup(ctx) {
    // no events, no jobs, no webhooks, no actions: observation is pull-only
    ctx.data.register(DATA_KEYS.snapshot, async (params) => {
      const config = await ctx.config.get(
        typeof params?.companyId === "string" ? params.companyId : undefined,
      );
      const baseUrl = requireString(config.adapterBaseUrl, "adapterBaseUrl");
      const token = requireString(config.adapterToken, "adapterToken");
      const cacheKey = baseUrl;

      const cached = cache.get(cacheKey);
      if (cached && isFresh(cached)) {
        const envelope: SnapshotEnvelope = {
          cached: true,
          fetchedAt: cached.fetchedAt,
          snapshot: cached.snapshot,
        };
        return envelope;
      }

      const snapshot = await fetchSnapshot(baseUrl, token);
      const entry: CachedEntry = { fetchedAt: Date.now(), snapshot };
      cache.set(cacheKey, entry);
      const envelope: SnapshotEnvelope = {
        fetchedAt: entry.fetchedAt,
        snapshot: entry.snapshot,
      };
      return envelope;
    });
  },
});

runWorker(plugin, import.meta.url);

export default plugin;
