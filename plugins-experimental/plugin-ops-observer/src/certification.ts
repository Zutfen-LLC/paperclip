// Bounded, process-local evidence only. No request values or identifiers enter receipts.
const WINDOW_MS = 300_000;
const MAX_COMPANIES = 64;
const MAX_EVENTS = 10_000;
const names = [
  "acceptedOrigin", "rejectedOrigin", "secretResolutionAttempts", "secretResolutionFailures",
  "cacheReads", "cacheHits", "cacheMisses", "cacheRefreshes", "fetchAttempts",
  "fetchSuccesses", "fetchFailures", "redirectRefusals", "upstreamGet", "adapterAuthAttached",
] as const;
type Name = typeof names[number];
type Window = {
  startedAt: number;
  endedAt?: number;
  status: "active" | "complete" | "incomplete";
  events: number;
  counters: Record<Name, number>;
};
const windows = new Map<string, Window>();
// Tracks requests even when not instrumented: opening a window mid-request cannot certify completeness.
const pending = new Map<string, number>();
function expire(window: Window) {
  if (window.status === "active" && Date.now() - window.startedAt >= WINDOW_MS) {
    window.status = "incomplete";
    window.endedAt = window.startedAt + WINDOW_MS;
  }
}
function receipt(window: Window, companyId: string) {
  expire(window);
  return {
    schema: "ops_observer_certification_v1" as const,
    status: window.status,
    startedAt: window.startedAt,
    endedAt: window.endedAt ?? null,
    inFlight: pending.get(companyId) ?? 0,
    counters: { ...window.counters },
    upstreamMethod: window.counters.upstreamGet > 0 ? "GET" as const : "none" as const,
    adapterAuthHeaderAttached: window.counters.adapterAuthAttached > 0,
  };
}
export function certificationWindow(companyId: string, command?: unknown) {
  if (command === "start") {
    const previous = windows.get(companyId);
    if (previous) expire(previous);
    if (previous?.status === "active") throw new Error("Certification window already active");
    if (!previous && windows.size >= MAX_COMPANIES) throw new Error("Certification window capacity reached");
    const counters = Object.fromEntries(names.map(name => [name, 0])) as Record<Name, number>;
    const window: Window = { startedAt: Date.now(), status: "active", events: 0, counters };
    // An earlier request overlaps the start, so the entire window cannot be certified.
    if ((pending.get(companyId) ?? 0) > 0) { window.status = "incomplete"; window.endedAt = Date.now(); }
    windows.set(companyId, window);
    return receipt(window, companyId);
  }
  if (command !== undefined && command !== "close") throw new Error("Invalid certification read command");
  const window = windows.get(companyId);
  if (!window) throw new Error("No certification window for company");
  expire(window);
  if (command === "close" && window.status === "active") {
    window.status = (pending.get(companyId) ?? 0) === 0 ? "complete" : "incomplete";
    window.endedAt = Date.now();
  }
  return receipt(window, companyId);
}
export function observeRequest(companyId: string, enabled: boolean) {
  const window = enabled ? windows.get(companyId) : undefined;
  if (window) expire(window);
  const active = window?.status === "active" ? window : undefined;
  return {
    count(name: Name) {
      if (!active || active.status !== "active") return;
      expire(active);
      if (active.status !== "active") return;
      if (active.events >= MAX_EVENTS) {
        active.status = "incomplete";
        active.endedAt = Date.now();
        return;
      }
      active.events++;
      active.counters[name]++;
    },
  };
}
// Requests start before async config lookup, so the overlap guard applies even
// when a certification window is opened while a config read is still pending.
export function requestStarted(companyId: string) {
  pending.set(companyId, (pending.get(companyId) ?? 0) + 1);
  return () => {
    const remaining = (pending.get(companyId) ?? 1) - 1;
    if (remaining) pending.set(companyId, remaining);
    else pending.delete(companyId);
  };
}
