// Deterministic path classification for the fork's pull-request CI.
//
// Every changed path maps to exactly one class (first matching rule wins) and
// the union of classes selects which CI lanes a pull request runs. Anything
// that no rule recognises is "unknown" and selects the broad tier, so a new
// top-level directory fails toward more validation, never less.
//
// Pure functions live here; ci-plan.mjs does the git and workflow I/O. The
// lane ids are also the job ids in .github/workflows/ci.yml, and the verify job
// checks each selected lane's job result by that id.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLASS_IDS = [
  "infra",
  "ci",
  "workflows",
  "docker",
  "docs",
  "evals",
  "runner",
  "shared",
  "adapters",
  "plugins",
  "observer",
  "mcp",
  "ui",
  "server",
  "cli",
  "scripts",
  "e2e",
  "assets",
  "unknown",
];

// Lane ids == job ids in ci.yml. `policy` always runs.
export const LANE_IDS = [
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
];

// Files whose change can alter dependency resolution, the toolchain or test
// configuration for every package. They select the broad tier.
const INFRA_EXACT = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".nvmrc",
  "tsconfig.json",
  "tsconfig.base.json",
  "vitest.config.ts",
]);

// Documentation and repository metadata that no build, test or image reads.
// Markdown inside a package is deliberately not listed: the runner's drift
// checks and the Docker context both read committed markdown there.
const DOCS_PREFIXES = [
  "doc/",
  "docs/",
  "releases/",
  "report/",
  "screenshots/",
  "design/",
  ".agents/",
  ".claude/",
  ".codex/",
  ".github/ISSUE_TEMPLATE/",
];
const DOCS_EXACT = new Set([
  "README.md",
  "CONTRIBUTING.md",
  "ROADMAP.md",
  "SECURITY.md",
  "DESIGN.md",
  "AGENTS.md",
  "adapter-plugin.md",
  "LICENSE",
  ".mailmap",
  ".gitattributes",
  ".devin",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
]);

// Files the server reads from disk at run time. Tests reach them through the
// filesystem, not imports, so no import-based selection can see them.
const ASSET_PREFIXES = ["announcements/", "skills/", "skills-releases/", "tools/"];

const SHARED_PREFIXES = [
  "packages/shared/",
  "packages/db/",
  "packages/adapter-utils/",
  "packages/skills-catalog/",
  "packages/teams-catalog/",
  "packages/plugins/sdk/",
];
const MCP_PREFIXES = [
  "packages/mcp-server/",
  "packages/google-sheets-mcp-server/",
  "packages/kv-demo-mcp-server/",
  "packages/tailscale-https-broker/",
];

const startsWithAny = (file, prefixes) => prefixes.some((prefix) => file.startsWith(prefix));

export function classifyPath(file) {
  const base = path.posix.basename(file);
  if (INFRA_EXACT.has(file) || file.startsWith("patches/")) return "infra";

  // CI-owned infrastructure: the files this fork owns end to end.
  if (
    file === ".github/workflows/ci.yml" ||
    file === ".github/workflows/ci-full.yml" ||
    file === ".github/ci.Dockerfile" ||
    (file.startsWith(".github/scripts/") && /^ci-[^/]+$/.test(base)) ||
    (file.startsWith(".github/scripts/tests/") && /^ci-[^/]+$/.test(base))
  ) {
    return "ci";
  }
  if (file === ".github/docker-context-checks.Dockerfile") return "docker";
  if (DOCS_EXACT.has(file) || startsWithAny(file, DOCS_PREFIXES)) return "docs";
  // Upstream workflows, their helper scripts and the remaining .github files.
  if (file.startsWith(".github/")) return "workflows";

  if (file === "Dockerfile" || file === ".dockerignore" || file.startsWith("docker/")) return "docker";
  if (file.startsWith("evals/")) return "evals";
  if (startsWithAny(file, ASSET_PREFIXES)) return "assets";

  if (file.startsWith("packages/paperclip-runner/") || file.startsWith("packages/paperclip-eval-kernel/")) {
    return "runner";
  }
  if (startsWithAny(file, SHARED_PREFIXES)) return "shared";
  if (file.startsWith("packages/adapters/")) return "adapters";
  if (file.startsWith("packages/plugins/")) return "plugins";
  if (file.startsWith("plugins-experimental/")) return "observer";
  if (startsWithAny(file, MCP_PREFIXES)) return "mcp";
  if (file.startsWith("ui/")) return "ui";
  if (file.startsWith("server/")) return "server";
  if (file.startsWith("cli/")) return "cli";
  if (file.startsWith("scripts/")) return "scripts";
  if (file.startsWith("tests/")) return "e2e";
  return "unknown";
}

// Classes whose change reaches the broad tier on its own.
const BROAD_CLASSES = new Set(["infra", "assets", "unknown"]);

// Per-class lane selection. The pseudo-lane `tests` marks a class that may
// affect vitest suites; ci-select-tests.mjs then picks the files and the
// tests_server / tests_workspaces lanes, and may still escalate to broad.
const CLASS_LANES = {
  docs: [],
  evals: [],
  ci: ["ci_check", "ci_selftest"],
  workflows: ["ci_check"],
  docker: [],
  runner: ["static", "runner_checks", "runner_vitest", "tests"],
  shared: ["static", "tests"],
  adapters: ["static", "tests"],
  plugins: ["static", "tests"],
  observer: ["observer"],
  mcp: ["static", "tests"],
  ui: ["static", "tests", "token_gates"],
  server: ["static", "tests"],
  cli: ["static", "tests"],
  scripts: ["static", "release_registry", "tests"],
  e2e: ["static", "e2e_typecheck"],
};

// Extra checks that run inside an existing job rather than as a lane.
export const STEP_FLAGS = ["release_registry", "token_gates", "e2e_typecheck", "docker_context", "script_tests"];

export function classifyChanges(files) {
  const byClass = {};
  for (const file of files) {
    const id = classifyPath(file);
    (byClass[id] ??= []).push(file);
  }
  const classes = CLASS_IDS.filter((id) => byClass[id]);
  const broadReasons = classes.filter((id) => BROAD_CLASSES.has(id));
  const broad = broadReasons.length > 0;

  const flags = new Set();
  for (const id of classes) for (const lane of CLASS_LANES[id] ?? []) flags.add(lane);
  // The context-integrity build is cheap, so it runs as a policy-job step for
  // anything that can change the build context. The production image is slow,
  // so its lane runs only when something that shapes the image changed.
  const dockerImage = byClass.docker?.some((file) => file !== ".github/docker-context-checks.Dockerfile") ?? false;
  const contextTouching =
    classes.includes("docker") ||
    classes.some((id) => !["docs", "evals", "ci", "workflows", "observer"].includes(id));
  if (dockerImage) flags.add("docker");
  if (contextTouching) flags.add("docker_context");

  // The broad tier runs the full inventory, which covers every focused lane
  // and step except these: ci-full.yml has no CI self-test and builds the
  // production image only outside pull requests. A broad plan keeps them when
  // its diff selects them.
  const uncoveredByFull = new Set(["docker", "ci_selftest"]);
  const lane = (id) => flags.has(id) && (!broad || uncoveredByFull.has(id));

  const lanes = {
    policy: true,
    static: lane("static"),
    tests_server: false,
    tests_workspaces: false,
    observer: lane("observer"),
    runner_checks: lane("runner_checks"),
    runner_vitest: lane("runner_vitest"),
    docker: lane("docker"),
    ci_check: lane("ci_check"),
    ci_selftest: lane("ci_selftest"),
    full: broad,
  };
  const steps = {
    release_registry: !broad && flags.has("release_registry"),
    token_gates: !broad && flags.has("token_gates"),
    e2e_typecheck: !broad && flags.has("e2e_typecheck"),
    docker_context: !broad && flags.has("docker_context"),
    // Set by ci-plan.mjs once the test selection knows which script tests apply.
    script_tests: false,
  };
  return { classes, byClass, broad, broadReasons, needsTests: !broad && flags.has("tests"), lanes, steps };
}

export function listChangedFiles({ base, head, cwd = process.cwd() }) {
  // --no-renames reports a rename as a delete plus an add, so both the old and
  // the new path are classified.
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "--no-renames", "-z", `${base}...${head}`],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const parts = output.split("\0").filter((part) => part.length > 0);
  const changes = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    changes.push({ status: parts[index], path: parts[index + 1] });
  }
  return changes;
}

export function writeGithubOutputs(outputs, outputFile = process.env.GITHUB_OUTPUT) {
  if (!outputFile) return;
  const lines = Object.entries(outputs).map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}=${text}`;
  });
  appendFileSync(outputFile, `${lines.join("\n")}\n`);
}

// CLI: `ci-classify.mjs [--files-from-stdin] | --base SHA --head SHA`
// Prints the classification as JSON. ci-plan.mjs is the workflow entry point.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  let files;
  if (args.includes("--files-from-stdin")) {
    const { readFileSync } = await import("node:fs");
    files = readFileSync(0, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  } else if (get("--base") && get("--head")) {
    files = listChangedFiles({ base: get("--base"), head: get("--head") }).map((change) => change.path);
  } else {
    console.error("usage: ci-classify.mjs --files-from-stdin | --base SHA --head SHA");
    process.exit(2);
  }
  const { byClass, ...rest } = classifyChanges(files);
  console.log(JSON.stringify({ ...rest, counts: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.length])) }, null, 2));
}
