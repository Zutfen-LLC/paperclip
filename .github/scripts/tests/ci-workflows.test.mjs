import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LANE_IDS } from "../ci-classify.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");

const FORK_GUARD = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";

// A line-oriented read of a workflow's `jobs:` section. Enough structure to
// assert trust properties without a YAML dependency; actionlint covers syntax.
function jobsOf(workflow) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
  assert.ok(start >= 0, "workflow has a jobs: section");
  const jobs = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^  ([a-z_][a-z0-9_-]*):\s*$/.exec(line);
    if (header) {
      current = { id: header[1], lines: [] };
      jobs[current.id] = current;
    } else if (current) {
      current.lines.push(line);
    }
  }
  for (const job of Object.values(jobs)) job.text = job.lines.join("\n");
  return jobs;
}

const workflows = { "ci.yml": read(".github/workflows/ci.yml"), "ci-full.yml": read(".github/workflows/ci-full.yml") };

for (const [name, text] of Object.entries(workflows)) {
  test(`${name}: only trusted-event triggers, no secrets, no privileged contexts`, () => {
    assert.doesNotMatch(text, /pull_request_target/);
    assert.doesNotMatch(text, /workflow_run/);
    assert.doesNotMatch(text, /\bsecrets\./);
    assert.doesNotMatch(text, /secrets:\s*inherit/);
    assert.match(text, /permissions:\n {2}contents: read/);
  });

  test(`${name}: every checkout drops credentials`, () => {
    const checkouts = text.split("\n").flatMap((line, index, lines) => (line.includes("actions/checkout@") ? [lines.slice(index, index + 5).join("\n")] : []));
    assert.ok(checkouts.length > 0);
    for (const block of checkouts) assert.match(block, /persist-credentials: false/);
  });

  test(`${name}: every job but verify carries the fork guard; self-hosted jobs use exactly the verified labels`, () => {
    const jobs = Object.values(jobsOf(text)).filter((job) => job.id !== "verify");
    assert.ok(jobs.length > 0);
    for (const job of jobs) {
      assert.match(job.text, /^ {4}if: /m, `${name} ${job.id} needs an if`);
      assert.ok(job.text.includes(FORK_GUARD), `${name} ${job.id} must carry the fork guard`);
      const runsOn = /^ {4}runs-on: (.*)$/m.exec(job.text)?.[1];
      if (runsOn !== undefined) {
        assert.equal(runsOn, "[self-hosted, linux, x64]", `${name} ${job.id}: labels must be exactly the verified ones`);
      } else {
        assert.match(job.text, /^ {4}uses: \.\//m, `${name} ${job.id} either has runs-on or calls a local workflow`);
      }
    }
  });

  test(`${name}: no job mounts the host Docker socket or runs privileged`, () => {
    assert.doesNotMatch(text, /docker\.sock/);
    assert.doesNotMatch(text, /--privileged/);
  });
}

test("ci.yml: triggers are pull requests only", () => {
  const on = /^on:\n((?: {2}.*\n)+)/m.exec(workflows["ci.yml"])?.[1] ?? "";
  assert.deepEqual(on.trim().split("\n").map((line) => line.trim()), ["pull_request:"]);
});

test("ci.yml: a job exists for every lane and verify depends on all of them", () => {
  const jobs = jobsOf(workflows["ci.yml"]);
  for (const lane of LANE_IDS) assert.ok(jobs[lane], `job ${lane}`);
  const needs = /needs: \[([^\]]+)\]/.exec(jobs.verify.text)?.[1].split(",").map((id) => id.trim()) ?? [];
  assert.deepEqual([...needs].sort(), ["classify", ...LANE_IDS].sort());
});

test("ci.yml: lanes other than policy and classify are gated on the plan", () => {
  const jobs = jobsOf(workflows["ci.yml"]);
  for (const lane of LANE_IDS.filter((id) => id !== "policy")) {
    assert.ok(jobs[lane].text.includes(`fromJSON(needs.classify.outputs.lanes).${lane}`), `${lane} is gated on its lane flag`);
    assert.match(jobs[lane].text, /needs: \[classify\]/, `${lane} waits for classify`);
  }
  assert.match(jobs.policy.text, /needs: \[classify\]/);
});

test("ci.yml: verify runs hosted, without a checkout, and fails closed", () => {
  const verify = jobsOf(workflows["ci.yml"]).verify;
  assert.match(verify.text, /runs-on: ubuntu-latest/);
  assert.match(verify.text, /if: always\(\)/);
  assert.match(verify.text, /permissions: \{\}/);
  assert.doesNotMatch(verify.text, /actions\/checkout/);
  assert.doesNotMatch(verify.text, /^ {4}runs-on: .*self-hosted/m);
  assert.doesNotMatch(verify.text, /\buses:/);
});

test("ci.yml: the full lane calls the reusable workflow and is the only job that does", () => {
  const jobs = jobsOf(workflows["ci.yml"]);
  assert.match(jobs.full.text, /uses: \.\/\.github\/workflows\/ci-full\.yml/);
  for (const job of Object.values(jobs).filter((candidate) => candidate.id !== "full")) {
    assert.doesNotMatch(job.text, /uses: \.\//, `${job.id} must not call a workflow`);
  }
});

test("ci-full.yml: triggers cover dispatch, nightly, post-merge and reuse, and the matrix is capped", () => {
  const text = workflows["ci-full.yml"];
  for (const trigger of ["workflow_call:", "workflow_dispatch:", "schedule:", "push:"]) assert.ok(text.includes(trigger), trigger);
  assert.match(text, /branches: \[master\]/);
  assert.match(text, /max-parallel: \$\{\{ fromJSON\(inputs\.max_parallel \|\| '3'\) \}\}/);
});

test("ci-full.yml keeps the full upstream-equivalent inventory", () => {
  const text = workflows["ci-full.yml"];
  for (const required of [
    "--group general-server-without-chat --shard-index 0 --shard-count 3",
    "--group general-server-without-chat --shard-index 2 --shard-count 3",
    "--group general-chat",
    "test:run:serialized -- --shard-index 0 --shard-count 3",
    "test:run:serialized -- --shard-index 2 --shard-count 3",
    "--group general-workspaces-a",
    "--group general-workspaces-b",
    "check:static",
    "check:runner",
    "test:typescript:vitest",
    "typecheck:build-gaps",
    "test:release-registry",
    "pnpm build",
    "ci-observer.sh",
    "ci-canary.sh",
    "--target production",
    "assert-orphan-reaping.sh",
    "docker-context-checks.Dockerfile",
    "ci-lint.sh",
    "check-pr-migration-order.mjs",
  ]) {
    assert.ok(text.includes(required), `ci-full.yml must still run: ${required}`);
  }
});

test("upstream pr.yml and pr-trusted.yml are not wired to the fork workflows", () => {
  for (const file of [".github/workflows/pr.yml", ".github/workflows/pr-trusted.yml"]) {
    const text = read(file);
    assert.doesNotMatch(text, /ci-full\.yml|ci\.yml/, file);
  }
});

// ---- verify aggregation, executed -----------------------------------------

function verifyScript() {
  const lines = jobsOf(workflows["ci.yml"]).verify.lines;
  const start = lines.findIndex((line) => /^ {8}run: \|$/.test(line));
  assert.ok(start >= 0, "verify has a run block");
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

const hasJq = spawnSync("jq", ["--version"]).status === 0;

function runVerify(needs) {
  return spawnSync("bash", ["-c", verifyScript()], { env: { PATH: process.env.PATH, NEEDS_JSON: JSON.stringify(needs) }, encoding: "utf8" });
}

function needsFor(selectedLanes, results = {}, classifyResult = "success") {
  const lanes = Object.fromEntries(LANE_IDS.map((id) => [id, id === "policy" || selectedLanes.includes(id)]));
  const needs = { classify: { result: classifyResult, outputs: { lanes: JSON.stringify(lanes) } } };
  for (const id of LANE_IDS) {
    needs[id] = { result: results[id] ?? (lanes[id] ? "success" : "skipped"), outputs: {} };
  }
  return needs;
}

const verifyCases = [
  ["docs-only: policy succeeded, everything else skipped", needsFor([]), 0],
  ["selected lanes all succeeded, unselected skipped", needsFor(["static", "tests_server", "observer"]), 0],
  ["broad: full selected and succeeded", needsFor(["full"]), 0],
  ["a selected lane failed", needsFor(["static", "tests_server"], { tests_server: "failure" }), 1],
  ["a selected lane was cancelled", needsFor(["static"], { static: "cancelled" }), 1],
  ["a selected lane was skipped (never ran)", needsFor(["static"], { static: "skipped" }), 1],
  ["policy failed", needsFor([], { policy: "failure" }), 1],
  ["policy was skipped", needsFor([], { policy: "skipped" }), 1],
  ["an unselected lane ran and failed anyway", needsFor([], { docker: "failure" }), 1],
  ["classify failed", needsFor(["static"], {}, "failure"), 1],
  ["classify was skipped (fork pull request)", needsFor([], {}, "skipped"), 1],
  ["full selected but its reusable workflow failed", needsFor(["full"], { full: "failure" }), 1],
];

for (const [name, needs, status] of verifyCases) {
  test(`verify: ${name}`, { skip: hasJq ? false : "jq is not installed" }, () => {
    const result = runVerify(needs);
    assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
  });
}

test("verify: a malformed or missing lane plan fails", { skip: hasJq ? false : "jq is not installed" }, () => {
  const broken = needsFor([]);
  broken.classify.outputs.lanes = "not json";
  assert.equal(runVerify(broken).status, 1);
  delete broken.classify.outputs.lanes;
  assert.equal(runVerify(broken).status, 1);
});

test("verify: a lane the plan names but the workflow does not run fails", { skip: hasJq ? false : "jq is not installed" }, () => {
  const needs = needsFor(["static"]);
  delete needs.static;
  assert.equal(runVerify(needs).status, 1);
});
