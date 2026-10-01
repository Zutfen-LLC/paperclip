import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CLASS_IDS, LANE_IDS } from "../ci-classify.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const doc = readFileSync(path.join(repoRoot, "doc/CI-SELF-HOSTED.md"), "utf8");

test("doc/CI-SELF-HOSTED.md documents every path class in its classification table", () => {
  for (const id of CLASS_IDS) {
    assert.match(doc, new RegExp(`^\\| ${id} \\|`, "m"), `class ${id} is missing from the table`);
  }
});

test("doc/CI-SELF-HOSTED.md names every lane", () => {
  for (const id of LANE_IDS) assert.ok(doc.includes(id), `lane ${id} is missing from the doc`);
});
