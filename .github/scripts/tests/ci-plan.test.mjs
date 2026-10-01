import assert from "node:assert/strict";
import test from "node:test";

import { LANE_IDS } from "../ci-classify.mjs";
import { buildPlan, renderSummary } from "../ci-plan.mjs";

const change = (file) => ({ status: "M", path: file });

function selection(overrides = {}) {
  return {
    server: { files: [], estMs: 0, shards: 0 },
    ui: { whole: false, files: [] },
    wholeProjects: [],
    broadReasons: [],
    notes: [],
    ...overrides,
  };
}

const on = (lanes) => Object.entries(lanes).filter(([, enabled]) => enabled).map(([id]) => id).sort();

test("docs-only plans policy and never asks for a test selection", () => {
  let called = false;
  const plan = buildPlan({
    changes: [change("doc/receipts/a.md")],
    selectPlan: () => {
      called = true;
      return selection();
    },
  });
  assert.equal(called, false);
  assert.deepEqual(on(plan.lanes), ["policy"]);
  assert.deepEqual(plan.serverShards, []);
  assert.equal(plan.broad, false);
});

test("lanes always carry exactly the lane ids", () => {
  for (const changes of [[], [change("doc/a.md")], [change("ui/src/a.tsx")], [change("mystery.ts")]]) {
    const plan = buildPlan({ changes, selectPlan: () => selection() });
    assert.deepEqual(Object.keys(plan.lanes).sort(), [...LANE_IDS].sort());
  }
});

test("selected server suites turn on the server lane with the planned shard list", () => {
  const plan = buildPlan({
    changes: [change("server/src/services/a.ts")],
    selectPlan: () => selection({ server: { files: ["server/src/__tests__/a.test.ts"], estMs: 5000, shards: 2 } }),
  });
  assert.deepEqual(on(plan.lanes), ["policy", "static", "tests_server"]);
  assert.deepEqual(plan.serverShards, [1, 2]);
});

test("workspace tests turn on for whole projects or selected ui suites", () => {
  const wholeProject = buildPlan({
    changes: [change("packages/shared/src/a.ts")],
    selectPlan: () => selection({ wholeProjects: ["@paperclipai/shared"] }),
  });
  assert.equal(wholeProject.lanes.tests_workspaces, true);
  assert.equal(wholeProject.lanes.tests_server, false);

  const ui = buildPlan({
    changes: [change("ui/src/a.tsx")],
    selectPlan: () => selection({ ui: { whole: false, files: ["ui/src/a.test.tsx"] } }),
  });
  assert.equal(ui.lanes.tests_workspaces, true);

  const none = buildPlan({ changes: [change("ui/src/a.tsx")], selectPlan: () => selection() });
  assert.equal(none.lanes.tests_workspaces, false);
});

test("a selection that cannot be bounded escalates to broad: only policy and full run", () => {
  const plan = buildPlan({
    changes: [change("server/src/services/issues.ts")],
    selectPlan: () => selection({ broadReasons: ["server selection is 500 files"] }),
  });
  assert.equal(plan.broad, true);
  assert.deepEqual(on(plan.lanes), ["full", "policy"]);
  assert.deepEqual(plan.serverShards, []);
  assert.ok(plan.broadReasons.includes("server selection is 500 files"));
  assert.deepEqual(Object.values(plan.steps).filter(Boolean), []);
});

test("infra and unknown paths are broad without consulting the selector", () => {
  for (const file of ["pnpm-lock.yaml", "mystery/file.ts"]) {
    let called = false;
    const plan = buildPlan({
      changes: [change(file)],
      selectPlan: () => {
        called = true;
        return selection();
      },
    });
    assert.equal(called, false, file);
    assert.deepEqual(on(plan.lanes), ["full", "policy"], file);
    assert.match(plan.broadReasons[0], /paths:/);
  }
});

test("the plan reports changed-path counts per class", () => {
  const plan = buildPlan({
    changes: [change("doc/a.md"), change("doc/b.md"), change("plugins-experimental/plugin-ops-observer/src/manifest.ts")],
    selectPlan: () => selection(),
  });
  assert.deepEqual(plan.counts, { docs: 2, observer: 1 });
  assert.equal(plan.changed, 3);
});

test("the summary names every lane and says whether the tier is broad", () => {
  const focused = renderSummary(buildPlan({ changes: [change("doc/a.md")], selectPlan: () => selection() }));
  for (const lane of LANE_IDS) assert.match(focused, new RegExp(`\\| ${lane} \\|`));
  assert.match(focused, /Focused tier/);

  const broad = renderSummary(buildPlan({ changes: [change("pnpm-lock.yaml")], selectPlan: () => selection() }));
  assert.match(broad, /Broad tier/);
  assert.match(broad, /infra paths: pnpm-lock\.yaml/);
});
