import test from "node:test";
import assert from "node:assert/strict";
import * as model from "../dist-test/ui/model.js";
const { parseEnvelope, humanAttention, outcomeLabel, buildViewModel, applyFilters, accessibleName, TERMINAL_EXECUTION_STATES } = model;

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
  assert.equal(parseEnvelope(envelope([], NaN), 1000).fetchedAtIso, "unknown");
  assert.deepEqual(parseEnvelope(null, 0), { kind: "malformed", reason: "missing_envelope" });
  assert.deepEqual(parseEnvelope({ fetchedAt: 0 }, 0), { kind: "malformed", reason: "missing_snapshot" });
});

test("terminal states are exact and terminal blockers are not blocked attention", () => {
  assert.deepEqual([...TERMINAL_EXECUTION_STATES], ["succeeded", "failed", "stopped", "stopped_for_review", "merged", "cancelled", "done", "skipped"]);
  assert.deepEqual(humanAttention(item("a", { review_state: "needs review" })), { attention: true, reason: "review" });
  assert.deepEqual(humanAttention(item("a", { review_state: "reviewed" })), { attention: false, reason: null });
  assert.deepEqual(humanAttention(item("a", { review_state: "review_completed" })), { attention: false, reason: null });
  assert.deepEqual(humanAttention(item("a", { review_state: "needs review", execution_state: "done" })), { attention: false, reason: null });
  assert.equal(humanAttention(item("a", { review_state: "approved", blocker: "x" })).reason, "blocked");
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
  const future = buildViewModel([item("future", { updated_at: new Date(220_000).toISOString() })], {now:100_000}).active;
  assert.equal(applyFilters(future, {query:"",scope:"all",recency:"24h",project:""},100_000).length,1);
  assert.equal(applyFilters(rows, {query:"",scope:"all",recency:"any",project:"q"},100_000).length,1);
  assert.equal(applyFilters(rows, {query:"b",scope:"all",recency:"24h",project:""},100_000).length,0);
  assert.equal(applyFilters(rows, {query:"",scope:"terminal",recency:"any",project:""},100_000).length,0);
});

test("accessibleName tolerates null fields", () => {
  assert.equal(accessibleName({item:item("a", {issue_number:214, issue_title:"Fix", project:"ops"}), attentionReason:null, terminal:false}), "#214 Fix · ops");
  assert.equal(accessibleName({item:item("a"), attentionReason:null, terminal:false}), "unknown issue · unknown");
});

test("summarize collapses whitespace and caps with an ellipsis", () => {
  assert.equal(model.summarize("  alpha \n  beta  ", 20), "alpha beta");
  assert.equal(model.summarize("  alpha \n  beta gamma  ", 10), "alpha bet…");
  assert.equal(model.summarize(123, 10), "123");
});

test("formatRecency is deterministic across minute, hour, day and UTC date buckets", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const ago = seconds => new Date(now - seconds * 1000).toISOString();
  assert.equal(model.formatRecency(ago(59), now), "just now");
  assert.equal(model.formatRecency(ago(60), now), "1m ago");
  assert.equal(model.formatRecency(ago(3600), now), "1h ago");
  assert.equal(model.formatRecency(ago(86400), now), "1d ago");
  assert.equal(model.formatRecency(ago(31 * 86400), now), "2026-09-02");
  assert.equal(model.formatRecency(null, now), "unknown");
  assert.equal(model.formatRecency("not-a-date", now), "unknown");
});

test("blockSummary gives a concise blocker or an em dash when absent", () => {
  assert.equal(model.blockSummary(item("empty")), "—");
  assert.equal(model.blockSummary(item("blocked", {blocker:"  wait \n for review  "})), "wait for review");
  assert.equal(model.blockSummary(item("long", {blocker:"x".repeat(400)})).length, 80);
});

test("duplicate ops_task_id keeps first evidence and counts ambiguous records as malformed", () => {
  const first = item("same", {issue_title:"first evidence"});
  const result = parseEnvelope(envelope([first, item("same", {issue_title:"wrong evidence"}), item("other")]), 1000);
  assert.equal(result.kind, "ready");
  assert.deepEqual(result.envelope.snapshot.items, [first, item("other")]);
  assert.equal(result.malformedItemCount, 1);
});

test("attentionReasons reports every independent nonterminal reason in precedence order", () => {
  assert.deepEqual(model.attentionReasons(item("all", {review_state:"needs review",blocker:"waiting",qualification_state:"AWAITING_GO"})), ["review","blocked","qualification"]);
  assert.deepEqual(model.attentionReasons(item("single", {blocker:"waiting"})), ["blocked"]);
  assert.deepEqual(model.attentionReasons(item("none")), []);
  assert.deepEqual(model.attentionReasons(item("done", {review_state:"needs review",blocker:"waiting",qualification_state:"PENDING_GO",execution_state:"done"})), []);
  const [row] = buildViewModel([item("all", {review_state:"needs review",blocker:"waiting",qualification_state:"AWAITING_GO"})], {now:0}).attention;
  assert.deepEqual(row.attentionReasons, ["review","blocked","qualification"]);
  assert.equal(row.attentionReason, "review");
});

test("recent outcomes order by descending timestamp and id tie-break", () => {
  const rows = buildViewModel([
    item("z", {execution_state:"done",updated_at:"2026-10-02T12:00:00Z"}),
    item("b", {execution_state:"failed",updated_at:"2026-10-03T12:00:00Z"}),
    item("a", {execution_state:"merged",updated_at:"2026-10-03T12:00:00Z"})
  ], {now:Date.parse("2026-10-03T12:00:00Z")});
  assert.deepEqual(rows.outcomes.map(row=>row.item.ops_task_id), ["a","b","z"]);
});

test("filtering away the selected item clears its orphaned selection", () => {
  const vm = buildViewModel([item("keep", {project:"a"}),item("hide", {project:"b"})], {now:0});
  const filters = {query:"",scope:"all",recency:"any",project:"a"};
  const filtered = Object.fromEntries(Object.entries(vm).map(([section,rows])=>[section,applyFilters(rows,filters,0)]));
  assert.equal(model.resolveSelection(vm,"hide"),"hide");
  assert.equal(model.resolveSelection(filtered,"hide"),null);
});

test("formatRecency rejects far-future and non-ISO timestamps while tolerating small clock skew", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  assert.equal(model.formatRecency(new Date(now+6*60_000).toISOString(),now),"unknown");
  assert.equal(model.formatRecency(new Date(now+2*60_000).toISOString(),now),"just now");
  assert.equal(model.formatRecency("10/02/2026 12:00:00",now),"unknown");
});

test("resolveSelection retains ids in any visible section and clears orphaned or null ids", () => {
  const row = id => ({item:item(id),terminal:false,attentionReason:null});
  for (const key of ["active", "attention", "outcomes"]) {
    const rows = {active:[],attention:[],outcomes:[],[key]:[row("present")]};
    assert.equal(model.resolveSelection(rows, "present"), "present", key);
    assert.equal(model.resolveSelection(rows, "hidden"), null, key);
    assert.equal(model.resolveSelection(rows, null), null, key);
  }
});
