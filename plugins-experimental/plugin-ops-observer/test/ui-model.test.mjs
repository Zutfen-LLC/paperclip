import test from "node:test";
import assert from "node:assert/strict";
import { parseEnvelope, humanAttention, outcomeLabel, buildViewModel, applyFilters, accessibleName, TERMINAL_EXECUTION_STATES } from "../dist/ui/model.js";

const item = (id, patch = {}) => ({ ops_task_id: id, updated_at: null, ...patch });
const envelope = (items = [], fetchedAt = 1000, patch = {}) => ({ fetchedAt, snapshot: { schema: "ops_work_snapshot_v1", items, ...patch } });

test("parseEnvelope validates schema and skips malformed task items", () => {
  assert.equal(parseEnvelope(envelope([item("a")]), 1000).kind, "ready");
  assert.deepEqual(parseEnvelope({ ...envelope(), snapshot: { schema: "bad", items: [] } }, 1000), { kind: "malformed", reason: "unexpected_schema" });
  assert.deepEqual(parseEnvelope({ ...envelope(), snapshot: { schema: "ops_work_snapshot_v1", items: {} } }, 1000), { kind: "malformed", reason: "items_not_array" });
  const result = parseEnvelope(envelope([item("a"), {}, item("")]), 1000);
  assert.equal(result.kind, "ready");
  assert.equal(result.malformedItemCount, 2);
  assert.equal(result.envelope.snapshot.items.length, 1);
  assert.equal(parseEnvelope(envelope([], 1000), 61_000).kind, "ready");
  assert.equal(parseEnvelope(envelope([], 1000), 61_001).stale, true);
  assert.deepEqual(parseEnvelope(null, 0), { kind: "malformed", reason: "missing_envelope" });
  assert.deepEqual(parseEnvelope({ fetchedAt: 0 }, 0), { kind: "malformed", reason: "missing_snapshot" });
});

test("terminal states are exact and terminal blockers are not blocked attention", () => {
  assert.deepEqual([...TERMINAL_EXECUTION_STATES], ["succeeded", "failed", "stopped", "stopped_for_review", "merged", "cancelled", "done", "skipped"]);
  assert.deepEqual(humanAttention(item("a", { review_state: "needs review" })), { attention: true, reason: "review" });
  assert.equal(humanAttention(item("a", { review_state: "decision pending" })).reason, "decision");
  assert.equal(humanAttention(item("a", { review_state: "authorize" })).reason, "approval");
  assert.equal(humanAttention(item("a", { blocker: "waiting" })).reason, "blocked");
  assert.equal(humanAttention(item("a", { qualification_state: "AWAITING_GO" })).reason, "qualification");
  assert.deepEqual(humanAttention(item("a")), { attention: false, reason: null });
  assert.equal(humanAttention(item("a", { blocker: "waiting", execution_state: "done" })).reason, null);
});

test("outcome labels preserve terminal source wording and classify kind", () => {
  assert.equal(outcomeLabel(item("a", { execution_state: "merged" })), "merged");
  assert.equal(outcomeLabel(item("a", { execution_state: "failed" })), "failed");
  assert.equal(outcomeLabel(item("a", { execution_state: "stopped_for_review" })), "stopped_for_review");
});

test("buildViewModel orders null timestamps last and caps outcomes at 25", () => {
  const rows = buildViewModel([item("z", { updated_at: null }), item("b", { updated_at: "2026-01-02" }), item("a", { updated_at: "2026-01-02" }), ...Array.from({length:30}, (_,i)=>item(`t${i}`, { execution_state:"done" }))], {now: 0});
  assert.deepEqual(rows.active.map(r=>r.item.ops_task_id), ["a","b","z"]);
  assert.equal(rows.outcomes.length, 25);
});

test("applyFilters supports query, scope, recency, project and combinations", () => {
  const rows = buildViewModel([item("a", { project:"p", issue_title:"Alpha", updated_at:new Date(90_000).toISOString() }), item("b", { project:"q", blocker:"wait", updated_at:null }), item("c", { project:"p", execution_state:"done", updated_at:new Date(90_000).toISOString() })], {now:100_000}).active;
  assert.equal(applyFilters(rows, {query:"ALPHA",scope:"all",recency:"any",project:""},100_000).length,1);
  assert.equal(applyFilters(rows, {query:"",scope:"attention",recency:"any",project:""},100_000).length,1);
  assert.equal(applyFilters(rows, {query:"",scope:"active",recency:"24h",project:"p"},100_000).length,1);
  assert.equal(applyFilters(rows, {query:"",scope:"all",recency:"7d",project:""},100_000).length,1);
  assert.equal(applyFilters(rows, {query:"",scope:"all",recency:"any",project:"q"},100_000).length,1);
  assert.equal(applyFilters(rows, {query:"b",scope:"all",recency:"24h",project:""},100_000).length,0);
  assert.equal(applyFilters(rows, {query:"",scope:"terminal",recency:"any",project:""},100_000).length,0);
});

test("accessibleName tolerates null fields", () => {
  assert.equal(accessibleName({item:item("a", {issue_number:214, issue_title:"Fix", project:"ops"}), attentionReason:null, terminal:false}), "#214 Fix · ops");
  assert.equal(accessibleName({item:item("a"), attentionReason:null, terminal:false}), "unknown issue · unknown");
});
