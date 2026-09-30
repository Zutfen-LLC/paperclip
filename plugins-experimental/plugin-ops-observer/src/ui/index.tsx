import { useEffect, useMemo, useState } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { AUTHORITY_NOTICE, STALE_AFTER_MS } from "../constants.js";

/** OpsWorkSnapshot item shape (ops_work_snapshot_v1). Unknowns are null. */
interface OpsWorkItem {
  project: string | null;
  repository: string | null;
  issue_number: number | null;
  issue_title: string | null;
  issue_state: string | null;
  ops_task_id: string | null;
  run_id: string | null;
  run_role: string | null;
  parent_run_id: string | null;
  work_class: string | null;
  execution_state: string | null;
  review_state: string | null;
  profile_id: string | null;
  provider: string | null;
  model: string | null;
  pr_number: number | null;
  pr_head_sha: string | null;
  reviewed_sha: string | null;
  base_sha: string | null;
  qualification_state: string | null;
  deployment_state: string | null;
  blocker: string | null;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    reasoning_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    estimated_cost_usd: number | null;
    actual_cost_usd: number | null;
  } | null;
  updated_at: string | null;
  source_links: string[];
  source_version: {
    ops_deployed_sha: string | null;
    endpoints: string[];
    fetched_at: string | null;
  };
}

interface SnapshotEnvelope {
  cached?: boolean;
  fetchedAt: number;
  snapshot: {
    schema: string;
    generated_at: string;
    ops_deployed_sha: string | null;
    items: OpsWorkItem[];
  };
}

function unknown_(): string {
  return "unknown";
}

function fmt(v: string | number | null): string {
  if (v === null || v === undefined || v === "") return unknown_();
  return String(v);
}

function fmtSha(sha: string | null): string {
  if (!sha) return unknown_();
  return sha.slice(0, 12);
}

function shortId(v: string | null): string {
  if (!v) return unknown_();
  return v.length > 18 ? `${v.slice(0, 15)}…` : v;
}

function isStale(envelope: SnapshotEnvelope, now: number): boolean {
  return now - envelope.fetchedAt > STALE_AFTER_MS;
}

export function OpsWorkPage(): JSX.Element {
  const { data, loading, error, refresh } = usePluginData<SnapshotEnvelope>(
    "ops-snapshot",
    {},
  );
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const stale = data ? isStale(data, now) : false;
  const items = useMemo(() => data?.snapshot.items ?? [], [data]);
  const detail = useMemo(
    () => items.find((i) => i.ops_task_id === selected) ?? null,
    [items, selected],
  );

  return (
    <div style={{ fontFamily: "var(--font-mono, monospace)", padding: "16px" }}>
      <div style={{ display: "flex", gap: "12px", alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: "16px" }}>Ops Work — observed</h2>
        <span style={{ fontSize: "12px", opacity: 0.8 }}>{AUTHORITY_NOTICE}</span>
      </div>

      <div style={{ fontSize: "11px", opacity: 0.7, margin: "8px 0" }}>
        {data
          ? `source: ops-readonly-adapter GET /snapshot · ops deployed SHA ${
              data.snapshot.ops_deployed_sha?.slice(0, 12) ?? unknown_()
            } · fetched ${new Date(data.fetchedAt).toISOString()}`
          : "source: —"}
        {data?.cached ? " · served from read-through cache" : ""}
        {stale ? " · STALE — older than 60s, refresh to be certain" : ""}
      </div>

      <div style={{ margin: "8px 0" }}>
        <button onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh (read-only)"}
        </button>
      </div>

      {error ? (
        <div role="alert" style={{ border: "1px solid #b00", padding: "8px" }}>
          Ops snapshot unavailable (fail closed): {error.message}
        </div>
      ) : null}

      {stale && !error ? (
        <div role="status" style={{ border: "1px solid #b80", padding: "4px 8px", margin: "8px 0" }}>
          Stale data shown — source timestamp is older than 60 seconds.
        </div>
      ) : null}

      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px" }}>
        <thead>
          <tr>
            {["Project / Repo", "Issue", "State", "Run", "Review", "PR/head", "Blocker", "Updated"].map(
              (h) => (
                <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #888", padding: "4px 8px" }}>
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.ops_task_id ?? Math.random()}
              data-ops-task-id={item.ops_task_id}
              onClick={() => setSelected(item.ops_task_id)}
              style={{ cursor: "pointer" }}
            >
              <td style={{ padding: "4px 8px" }}>{fmt(item.project)}<br />
                <span style={{ opacity: 0.7 }}>{fmt(item.repository)}</span></td>
              <td style={{ padding: "4px 8px" }}>
                {item.issue_number !== null ? `#${item.issue_number}` : unknown_()}<br />
                <span style={{ opacity: 0.7 }}>{fmt(item.issue_title)}</span></td>
              <td style={{ padding: "4px 8px" }}>{fmt(item.review_state)}<br />
                <span style={{ opacity: 0.7 }}>{fmt(item.execution_state)}</span></td>
              <td style={{ padding: "4px 8px" }}>{shortId(item.run_id)}</td>
              <td style={{ padding: "4px 8px" }}>{fmt(item.review_state)}</td>
              <td style={{ padding: "4px 8px" }}>
                {item.pr_number !== null ? `#${item.pr_number}` : unknown_()}<br />
                <span style={{ opacity: 0.7 }}>{fmtSha(item.pr_head_sha)}</span></td>
              <td style={{ padding: "4px 8px" }}>{fmt(item.blocker)}</td>
              <td style={{ padding: "4px 8px" }}>{fmt(item.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {detail ? (
        <div style={{ marginTop: "16px", border: "1px solid #888", padding: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>{fmt(detail.issue_title)}</strong>
            <button onClick={() => setSelected(null)}>Close</button>
          </div>
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: "12px" }}>
            {([
              ["Ops task ID", fmt(detail.ops_task_id)],
              ["Issue", detail.issue_number !== null ? `#${detail.issue_number}` : unknown_()],
              ["Issue state (GitHub)", fmt(detail.issue_state)],
              ["Lifecycle status (Ops)", fmt(detail.review_state)],
              ["Execution state", fmt(detail.execution_state)],
              ["Run ID", fmt(detail.run_id)],
              ["Run role", fmt(detail.run_role)],
              ["Parent run", fmt(detail.parent_run_id)],
              ["Work class", fmt(detail.work_class)],
              ["Profile", fmt(detail.profile_id)],
              ["Provider", fmt(detail.provider)],
              ["Model", fmt(detail.model)],
              ["PR", detail.pr_number !== null ? `#${detail.pr_number}` : unknown_()],
              ["PR head SHA", fmt(detail.pr_head_sha)],
              ["Reviewed (GO) SHA", fmt(detail.reviewed_sha)],
              ["Base SHA", fmt(detail.base_sha)],
              ["Qualification", fmt(detail.qualification_state)],
              ["Deployment", fmt(detail.deployment_state)],
              ["Blocker", fmt(detail.blocker)],
              ["Input tokens", fmt(detail.usage?.input_tokens ?? null)],
              ["Output tokens", fmt(detail.usage?.output_tokens ?? null)],
              ["Cache read tokens", fmt(detail.usage?.cache_read_tokens ?? null)],
              ["Updated at (Ops)", fmt(detail.updated_at)],
              ["Ops deployed SHA", fmt(detail.source_version?.ops_deployed_sha)],
              ["Source endpoints", (detail.source_version?.endpoints ?? []).join(", ")],
              ["Fetched at", fmt(detail.source_version?.fetched_at)],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt style={{ opacity: 0.7 }}>{k}:</dt>
                <dd style={{ margin: 0 }}>{v}</dd>
              </div>
            ))}
          </dl>
          <div style={{ marginTop: "8px" }}>
            {detail.source_links.map((href) => (
              <a key={href} href={href} target="_blank" rel="noreferrer" style={{ display: "block" }}>
                {href}
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default OpsWorkPage;
