export const PLUGIN_ID = "zutfen.plugin-ops-observer";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "ops-work";
export const SLOT_IDS = {
  page: "ops-work-page",
} as const;
export const EXPORT_NAMES = {
  page: "OpsWorkPage",
} as const;
export const DATA_KEYS = {
  snapshot: "ops-snapshot",
  certification: "ops-certification",
} as const;
/** Read-through cache TTL (ms). Source remains Ops; stale is marked stale. */
export const CACHE_TTL_MS = 30_000;
/** Older than this, the snapshot is displayed as explicitly stale. */
export const STALE_AFTER_MS = 60_000;
export const AUTHORITY_NOTICE =
  "Observed from Ops Supervisor — read only. Ops Supervisor and GitHub remain the sole authority planes.";
