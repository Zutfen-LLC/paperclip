#!/usr/bin/env node
// Plan a pull request's CI lanes: classify the diff, select tests, and write
// the result as job outputs for .github/workflows/ci.yml.
//
//   ci-plan.mjs --base SHA --head SHA        (what the classify job runs)
//   ci-plan.mjs --files-from FILE|-          (simulate a change set: one path per line)
//   ... --outputs-file F --summary-file G    (write job outputs / summary there)
//
// Reads repository files only; it needs no installed dependencies, so the
// classify job runs it through ci-run.sh --no-install. That container cannot
// reach the runner's $GITHUB_OUTPUT, so the workflow has this script write
// the outputs and summary into the checkout and forwards them from the host.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LANE_IDS, classifyChanges, listChangedFiles, writeGithubOutputs } from "./ci-classify.mjs";
import { planFromGit } from "./ci-select-tests.mjs";

// Everything but the policy lane is replaced by the full inventory when the
// plan is broad: the full workflow already contains those jobs.
function broadLanes() {
  return Object.fromEntries(LANE_IDS.map((id) => [id, id === "policy" || id === "full"]));
}

export function buildPlan({ changes, selectPlan = planFromGit }) {
  const classification = classifyChanges(changes.map((change) => change.path));
  let { lanes, steps, broad } = classification;
  const broadReasons = classification.broadReasons.map((id) => `${id} paths: ${classification.byClass[id].slice(0, 3).join(", ")}`);
  let selection = null;

  if (!broad && classification.needsTests) {
    selection = selectPlan({ changes, classes: classification.classes });
    if (selection.broadReasons.length > 0) {
      broad = true;
      broadReasons.push(...selection.broadReasons);
    } else {
      lanes = {
        ...lanes,
        tests_server: selection.server.files.length > 0,
        tests_workspaces: selection.wholeProjects.length > 0 || selection.ui.whole || selection.ui.files.length > 0,
      };
    }
  }
  if (broad) {
    lanes = broadLanes();
    steps = Object.fromEntries(Object.keys(steps).map((key) => [key, false]));
  }
  const shardCount = !broad && selection ? selection.server.shards : 0;
  return {
    classes: classification.classes,
    counts: Object.fromEntries(classification.classes.map((id) => [id, classification.byClass[id].length])),
    broad,
    broadReasons,
    lanes,
    steps,
    serverShards: Array.from({ length: shardCount }, (_, index) => index + 1),
    selection,
    changed: changes.length,
  };
}

export function renderSummary(plan) {
  const lines = ["## CI plan", "", `${plan.changed} changed path(s).`, ""];
  lines.push("| class | paths |", "| --- | ---: |");
  for (const id of plan.classes) lines.push(`| ${id} | ${plan.counts[id]} |`);
  if (plan.classes.length === 0) lines.push("| (none) | 0 |");
  lines.push("", plan.broad ? "**Broad tier**: the full inventory runs." : "**Focused tier**.");
  for (const reason of plan.broadReasons) lines.push(`- ${reason}`);
  lines.push("", "| lane | runs |", "| --- | --- |");
  for (const id of LANE_IDS) lines.push(`| ${id} | ${plan.lanes[id] ? "yes" : "skipped"} |`);
  const extra = Object.entries(plan.steps).filter(([, on]) => on).map(([key]) => key);
  if (extra.length > 0) lines.push("", `Extra steps: ${extra.join(", ")}`);
  const selection = plan.selection;
  if (selection && !plan.broad) {
    lines.push(
      "",
      `Server: ${selection.server.files.length} suite(s), ~${Math.round(selection.server.estMs / 1000)}s recorded, ${selection.server.shards} shard(s).`,
      `UI: ${selection.ui.whole ? "whole project" : `${selection.ui.files.length} suite(s)`}. Whole projects: ${selection.wholeProjects.join(", ") || "none"}.`,
    );
    for (const note of selection.notes.slice(0, 20)) lines.push(`- ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const get = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  let changes;
  if (get("--files-from")) {
    changes = readFileSync(get("--files-from") === "-" ? 0 : get("--files-from"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((file) => ({ status: "M", path: file }));
  } else if (get("--base") && get("--head")) {
    changes = listChangedFiles({ base: get("--base"), head: get("--head") });
  } else {
    console.error("usage: ci-plan.mjs --base SHA --head SHA | --files-from FILE|-");
    process.exit(2);
  }

  const plan = buildPlan({ changes });
  const summary = renderSummary(plan);
  console.log(summary);
  if (args.includes("--json")) console.log(JSON.stringify(plan, null, 2));
  const summaryFile = get("--summary-file") ?? process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, summary);
  writeGithubOutputs(
    {
      lanes: plan.lanes,
      steps: plan.steps,
      // Never empty: a matrix with no values is a planning error even when the
      // job is skipped, so the lane flag, not this list, decides whether it runs.
      server_shards: plan.serverShards.length > 0 ? plan.serverShards : [1],
      broad: String(plan.broad),
    },
    get("--outputs-file") ?? process.env.GITHUB_OUTPUT,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
