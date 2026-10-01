import assert from "node:assert/strict";
import test from "node:test";

import { CLASS_IDS, LANE_IDS, classifyChanges, classifyPath } from "../ci-classify.mjs";

// One or more real-looking paths per class. Adding a class to CLASS_IDS
// without adding examples here fails the coverage test below.
const EXAMPLES = {
  infra: [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".nvmrc",
    "tsconfig.json",
    "tsconfig.base.json",
    "vitest.config.ts",
    "patches/postgres@3.4.9.patch",
  ],
  ci: [
    ".github/workflows/ci.yml",
    ".github/workflows/ci-full.yml",
    ".github/ci.Dockerfile",
    ".github/scripts/ci-run.sh",
    ".github/scripts/ci-install.sh",
    ".github/scripts/ci-plan.mjs",
    ".github/scripts/tests/ci-classify.test.mjs",
  ],
  workflows: [
    ".github/workflows/pr.yml",
    ".github/workflows/pr-trusted.yml",
    ".github/scripts/check-pr-template.mjs",
    ".github/scripts/tests/check-pr-template.test.mjs",
    ".github/storybook-deploy/action.yml",
  ],
  docker: ["Dockerfile", ".dockerignore", "docker/docker-compose.yml", ".github/docker-context-checks.Dockerfile"],
  docs: [
    "doc/receipts/2026-10-01-ops-observer-issue-3.md",
    "doc/receipts/2026-10-01-ops-observer-issue-3.json",
    "doc/plugins/PLUGIN_SPEC.md",
    "docs/api/overview.mdx",
    "releases/v0.3.1.md",
    "README.md",
    "AGENTS.md",
    "DESIGN.md",
    "LICENSE",
    ".agents/skills/check-pr/SKILL.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
  ],
  evals: ["evals/promptfoo/config.yaml"],
  runner: [
    "packages/paperclip-runner/src/index.ts",
    "packages/paperclip-runner/runner/crates/core/src/lib.rs",
    "packages/paperclip-runner/docs/capability-contract.md",
    "packages/paperclip-eval-kernel/src/index.ts",
  ],
  shared: [
    "packages/shared/src/validators/secret.ts",
    "packages/db/src/schema/issues.ts",
    "packages/adapter-utils/src/index.ts",
    "packages/skills-catalog/src/index.ts",
    "packages/teams-catalog/src/index.ts",
    "packages/plugins/sdk/src/index.ts",
  ],
  adapters: ["packages/adapters/codex-local/src/index.ts"],
  plugins: ["packages/plugins/plugin-llm-wiki/src/worker.ts", "packages/plugins/sandbox-providers/daytona/src/index.ts"],
  observer: [
    "plugins-experimental/plugin-ops-observer/src/manifest.ts",
    "plugins-experimental/plugin-ops-observer/package.json",
    "plugins-experimental/plugin-ops-observer/test/worker.test.mjs",
  ],
  mcp: ["packages/mcp-server/src/index.ts", "packages/tailscale-https-broker/src/index.ts"],
  ui: ["ui/src/components/JsonSchemaForm.tsx", "ui/package.json", "ui/public/favicon.svg"],
  server: ["server/src/services/plugin-config-validator.ts", "server/package.json"],
  cli: ["cli/src/index.ts"],
  scripts: ["scripts/release.sh", "scripts/run-vitest-stable.mjs"],
  e2e: ["tests/e2e/onboarding.spec.ts"],
  assets: ["announcements/current.json", "skills/paperclip/SKILL.md", "skills-releases/paperclip/1.0.0.md", "tools/agent-shim/index.js"],
  unknown: ["brand-new-top-level/file.ts", "Makefile", "new-root-config.json", ".shellcheckrc"],
};

test("every class has examples and every example classifies as its class", () => {
  assert.deepEqual(Object.keys(EXAMPLES).sort(), [...CLASS_IDS].sort());
  for (const [id, paths] of Object.entries(EXAMPLES)) {
    for (const file of paths) assert.equal(classifyPath(file), id, `${file} should be ${id}`);
  }
});

test("classification never returns an id outside CLASS_IDS", () => {
  for (const file of ["a", "a/b/c.d", ".hidden", "ui", "server", "packages", ".github", ".github/x"]) {
    assert.ok(CLASS_IDS.includes(classifyPath(file)), file);
  }
});

test("markdown inside a package is not docs", () => {
  // The runner's drift checks and the Docker context read committed markdown.
  for (const file of ["packages/paperclip-runner/README.md", "server/src/onboarding-assets/a.md", "ui/README.md"]) {
    assert.notEqual(classifyPath(file), "docs", file);
  }
});

test("ci-owned names beat the generic .github rule, other workflow files do not", () => {
  assert.equal(classifyPath(".github/scripts/ci-run.sh"), "ci");
  assert.equal(classifyPath(".github/scripts/check-pr-lockfile.mjs"), "workflows");
  assert.equal(classifyPath(".github/workflows/ci-fullish.yml"), "workflows");
});

test("lane ids are the job ids verify checks", () => {
  assert.deepEqual(LANE_IDS, [
    "policy",
    "static",
    "tests_server",
    "tests_workspaces",
    "observer",
    "runner_checks",
    "runner_vitest",
    "docker",
    "ci_check",
    "ci_selftest",
    "full",
  ]);
});

const selected = (lanes) => Object.entries(lanes).filter(([, on]) => on).map(([id]) => id).sort();
const onSteps = (steps) => Object.entries(steps).filter(([, on]) => on).map(([id]) => id).sort();

// Lane selection before test selection: needsTests asks ci-plan.mjs to pick
// vitest suites, which then set tests_server and tests_workspaces.
const SIMULATIONS = {
  "docs-only": {
    files: ["doc/receipts/2026-10-01-ops-observer-issue-3.md", "doc/receipts/2026-10-01-ops-observer-issue-3.json", "README.md"],
    classes: ["docs"],
    lanes: ["policy"],
    steps: [],
    needsTests: false,
  },
  "ui-only": {
    files: ["ui/src/components/JsonSchemaForm.tsx", "ui/src/components/JsonSchemaForm.test.tsx"],
    classes: ["ui"],
    lanes: ["policy", "static"],
    steps: ["docker_context", "token_gates"],
    needsTests: true,
  },
  "server-core": {
    files: ["server/src/services/issues.ts", "server/src/__tests__/issues-service.test.ts"],
    classes: ["server"],
    lanes: ["policy", "static"],
    steps: ["docker_context"],
    needsTests: true,
  },
  "runner-rust": {
    files: ["packages/paperclip-runner/runner/crates/core/src/lib.rs", "packages/paperclip-runner/src/index.ts"],
    classes: ["runner"],
    lanes: ["policy", "runner_checks", "runner_vitest", "static"],
    steps: ["docker_context"],
    needsTests: true,
  },
  "docker-release": {
    files: ["Dockerfile", "scripts/release.sh"],
    classes: ["docker", "scripts"],
    lanes: ["docker", "policy", "static"],
    steps: ["docker_context", "release_registry"],
    needsTests: false,
  },
  "shared-sdk-schema-plus-observer (PR 6 shape)": {
    files: [
      "doc/plugins/PLUGIN_SPEC.md",
      "packages/plugins/sdk/src/index.ts",
      "packages/shared/src/index.ts",
      "packages/shared/src/validators/index.ts",
      "packages/shared/src/validators/secret.ts",
      "plugins-experimental/plugin-ops-observer/README.md",
      "plugins-experimental/plugin-ops-observer/esbuild.config.mjs",
      "plugins-experimental/plugin-ops-observer/src/manifest.ts",
      "plugins-experimental/plugin-ops-observer/test/worker.test.mjs",
      "server/src/__tests__/ops-observer-config-validator.test.ts",
      "server/src/__tests__/ops-observer-secret-config.integration.test.ts",
      "server/src/__tests__/plugin-secrets-handler.test.ts",
      "server/src/services/plugin-config-validator.ts",
      "server/src/services/plugin-secrets-handler.ts",
      "ui/src/components/JsonSchemaForm.test.tsx",
      "ui/src/components/JsonSchemaForm.tsx",
    ],
    classes: ["docs", "shared", "observer", "ui", "server"],
    lanes: ["observer", "policy", "static"],
    steps: ["docker_context", "token_gates"],
    needsTests: true,
  },
  "unknown production path": {
    files: ["new-service/src/index.ts"],
    classes: ["unknown"],
    lanes: ["full", "policy"],
    steps: [],
    needsTests: false,
    broad: true,
  },
};

for (const [name, expected] of Object.entries(SIMULATIONS)) {
  test(`simulation: ${name}`, () => {
    const result = classifyChanges(expected.files);
    assert.deepEqual(result.classes, expected.classes);
    assert.deepEqual(selected(result.lanes), expected.lanes);
    assert.deepEqual(onSteps(result.steps), expected.steps);
    assert.equal(result.needsTests, expected.needsTests);
    assert.equal(result.broad, expected.broad ?? false);
  });
}

test("PR 6 shape selects none of the heavy lanes", () => {
  const { lanes } = classifyChanges(SIMULATIONS["shared-sdk-schema-plus-observer (PR 6 shape)"].files);
  for (const lane of ["runner_checks", "runner_vitest", "docker", "full", "ci_check", "ci_selftest"]) {
    assert.equal(lanes[lane], false, lane);
  }
});

test("broad classes override everything else and zero the focused lanes", () => {
  for (const trigger of ["pnpm-lock.yaml", "package.json", "skills/paperclip/SKILL.md", "mystery/file.ts"]) {
    const result = classifyChanges(["ui/src/a.tsx", trigger]);
    assert.equal(result.broad, true, trigger);
    assert.deepEqual(selected(result.lanes), ["full", "policy"], trigger);
    assert.equal(result.needsTests, false, trigger);
    assert.deepEqual(onSteps(result.steps), [], trigger);
  }
});

test("a broad plan still runs the lanes the full inventory does not cover", () => {
  const withCi = classifyChanges(["pnpm-lock.yaml", ".github/workflows/ci.yml"]);
  assert.deepEqual(selected(withCi.lanes), ["ci_check", "ci_selftest", "full", "policy"]);
  const withDocker = classifyChanges(["pnpm-lock.yaml", "docker/docker-compose.yml"]);
  assert.deepEqual(selected(withDocker.lanes), ["docker", "full", "policy"]);
  const withUpstreamWorkflow = classifyChanges(["pnpm-lock.yaml", ".github/workflows/pr.yml"]);
  assert.deepEqual(selected(withUpstreamWorkflow.lanes), ["ci_check", "full", "policy"]);
  // Extra steps belong to lanes the full inventory replaces.
  assert.deepEqual(onSteps(withCi.steps), []);
});

test("CI-owned files select lint and self-test, upstream workflows select only lint", () => {
  assert.deepEqual(selected(classifyChanges([".github/workflows/ci.yml"]).lanes), ["ci_check", "ci_selftest", "policy"]);
  assert.deepEqual(selected(classifyChanges([".github/workflows/pr.yml"]).lanes), ["ci_check", "policy"]);
});

test("the production image builds only for files that shape it", () => {
  assert.equal(classifyChanges([".github/docker-context-checks.Dockerfile"]).lanes.docker, false);
  assert.equal(classifyChanges([".github/docker-context-checks.Dockerfile"]).steps.docker_context, true);
  assert.equal(classifyChanges(["docker/docker-compose.yml"]).lanes.docker, true);
  assert.equal(classifyChanges([".dockerignore"]).lanes.docker, true);
});

test("an empty change set runs policy only", () => {
  const result = classifyChanges([]);
  assert.deepEqual(result.classes, []);
  assert.deepEqual(selected(result.lanes), ["policy"]);
  assert.equal(result.broad, false);
});

test("classification is order independent", () => {
  const files = SIMULATIONS["shared-sdk-schema-plus-observer (PR 6 shape)"].files;
  const forward = classifyChanges(files);
  const backward = classifyChanges([...files].reverse());
  assert.deepEqual(forward.lanes, backward.lanes);
  assert.deepEqual(forward.steps, backward.steps);
  assert.deepEqual(forward.classes, backward.classes);
});
