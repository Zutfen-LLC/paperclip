// Bounded test selection for the fork's pull-request CI.
//
// vitest's own `--changed` walks the module graph transitively, and nearly
// every file reaches the `@paperclipai/shared` barrel: touching one validator
// there selects ~600 server and ~430 UI test files. This selector bounds the
// walk instead:
//
//   * changed test files always run;
//   * for every other changed source file, tests that import it directly run;
//   * tests that import it through one intermediate module run, unless the
//     intermediate is a re-export barrel or a hub that many tests import;
//   * tests named after it (`foo.ts` -> `foo.test.ts`, `foo-bar.test.ts`) run;
//   * for shared-library packages, whose exports reach consumers through a
//     barrel, tests that mention an exported name run;
//   * changing a project's own test configuration runs the whole project.
//
// The server tier is sized from recorded suite durations. A selection too big
// to fit the budget does not get truncated: it escalates to the broad tier
// (the full inventory in ci-full.yml). So does a changed runtime asset that no
// import reaches, because no selection could see its dependents.
//
// Selection is a heuristic over a static import graph. Typecheck and build run
// on every code change and cover removed or renamed exports; the nightly full
// run is the safety net for dependents the heuristic cannot see.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadShardDurations, selectGeneralServerShard } from "../../scripts/general-server-shard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRootDefault = path.resolve(here, "..", "..");

// Recorded-duration budget (ms, upstream-host speed) for the server tier. The
// self-hosted hosts ran about 2x slower than the recorded durations, so three
// shards of 5.5 recorded minutes land near 11-12 minutes of wall clock.
export const SERVER_SHARD_TARGET_MS = 5.5 * 60_000;
export const SERVER_MAX_SHARDS = 3;
export const SERVER_BUDGET_MS = SERVER_SHARD_TARGET_MS * SERVER_MAX_SHARDS;

// A non-barrel module imported directly by more tests than this is a hub
// (an app factory, a test helper). Tests that reach a change only through a
// hub are not selected; direct importers always are.
export const HUB_FANIN = 30;

// Names shorter than this are too generic to match tests on.
const MIN_SYMBOL_LENGTH = 5;

// Vitest project names must match scripts/run-vitest-stable.mjs. `big`
// projects run only their selected files; the rest are small enough to run in
// full whenever anything in or around them changes.
export const PROJECTS = [
  { id: "server", name: "@paperclipai/server", dir: "server", big: true },
  { id: "ui", name: "@paperclipai/ui", dir: "ui", big: true },
  { id: "cli", name: "paperclipai", dir: "cli" },
  { id: "shared", name: "@paperclipai/shared", dir: "packages/shared", lib: true },
  { id: "skills-catalog", name: "@paperclipai/skills-catalog", dir: "packages/skills-catalog", lib: true },
  { id: "db", name: "@paperclipai/db", dir: "packages/db", lib: true },
  { id: "adapter-utils", name: "@paperclipai/adapter-utils", dir: "packages/adapter-utils", lib: true },
  { id: "claude-local", name: "@paperclipai/adapter-claude-local", dir: "packages/adapters/claude-local", lib: true },
  // The next four are vitest projects in the root config that
  // scripts/run-vitest-stable.mjs never runs, so upstream CI skips them. They
  // pass in the toolchain container, so the focused tier runs them when touched.
  { id: "cursor-cloud", name: "@paperclipai/adapter-cursor-cloud", dir: "packages/adapters/cursor-cloud", lib: true },
  { id: "gemini-local", name: "@paperclipai/adapter-gemini-local", dir: "packages/adapters/gemini-local", lib: true },
  { id: "kimi-local", name: "@paperclipai/adapter-kimi-local", dir: "packages/adapters/kimi-local", lib: true },
  { id: "pi-local", name: "@paperclipai/adapter-pi-local", dir: "packages/adapters/pi-local", lib: true },
  { id: "codex-local", name: "@paperclipai/adapter-codex-local", dir: "packages/adapters/codex-local", lib: true },
  { id: "grok-local", name: "@paperclipai/adapter-grok-local", dir: "packages/adapters/grok-local", lib: true },
  { id: "openclaw-gateway", name: "@paperclipai/adapter-openclaw-gateway", dir: "packages/adapters/openclaw-gateway", lib: true },
  { id: "opencode-local", name: "@paperclipai/adapter-opencode-local", dir: "packages/adapters/opencode-local", lib: true },
  { id: "plugin-daytona", name: "@paperclipai/plugin-daytona", dir: "packages/plugins/sandbox-providers/daytona" },
  { id: "plugin-sdk", name: "@paperclipai/plugin-sdk", dir: "packages/plugins/sdk", lib: true },
  { id: "create-paperclip-plugin", name: "@paperclipai/create-paperclip-plugin", dir: "packages/plugins/create-paperclip-plugin" },
];

// Workspace packages with their own `test` script and no vitest project.
// Upstream CI does not run these either; they pass in the toolchain container,
// so a change inside one runs `pnpm --filter <name> test`. The runner and the
// Ops observer have their own lanes.
export const PACKAGE_TESTS = [
  { dir: "packages/adapters/hermes", name: "@paperclipai/hermes-paperclip-adapter" },
  { dir: "packages/google-sheets-mcp-server", name: "@paperclipai/google-sheets-mcp-server" },
  { dir: "packages/kv-demo-mcp-server", name: "@paperclipai/kv-demo-mcp-server" },
  { dir: "packages/plugins/examples/plugin-authoring-smoke-example", name: "@paperclipai/plugin-authoring-smoke-example" },
  { dir: "packages/plugins/paperclip-plugin-fake-sandbox", name: "@paperclipai/plugin-fake-sandbox" },
  { dir: "packages/plugins/plugin-workspace-diff", name: "@paperclipai/plugin-workspace-diff" },
  { dir: "packages/tailscale-https-broker", name: "@paperclipai/tailscale-https-broker" },
  { dir: "packages/teams-catalog", name: "@paperclipai/teams-catalog" },
];

// Packages that have tests this CI cannot run. A change inside one gets a note
// in the plan; typecheck and build still cover it.
export const UNRUN_PACKAGES = [
  { dir: "packages/adapters/cursor-local", why: "a sandbox test fails in the toolchain container (tar extraction) on the current base" },
  { dir: "packages/mcp-server", why: "tools.test.ts fails on the current base" },
  { dir: "packages/plugins/plugin-llm-wiki", why: "two test files fail to load on the current base" },
  { dir: "packages/plugins/sandbox-providers/", why: "standalone packages outside the pnpm workspace (the daytona provider is a vitest project)" },
];

const RUNNER_SOURCE = /^packages\/paperclip-runner\/(?:src|runner|protocol|generated)\//;
const RUNNER_COUPLED_SERVER_TESTS =
  /^server\/src\/services\/native-runtime\/(?:native-codex-runner|native-runner-|paperclip-runner-|runner-api|runner-prp-)[^/]*\.test\.ts$/;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const STATIC_ASSET = /\.(?:png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp4|webm|pdf)$/i;
const DOC_BASENAME = /^(?:README|CHANGELOG|LICENSE|CONTRIBUTING|NOTICE|PROVENANCE)(?:\.[A-Za-z]+)?$/;

// Which files vitest treats as tests in a project.
function isProjectTest(project, file) {
  if (!file.startsWith(`${project.dir}/`) || !TEST_FILE.test(file)) return false;
  if (project.id === "server") {
    return /^server\/src\/.+\.test\.ts$/.test(file) || /^server\/scripts\/.+\.test\.mjs$/.test(file);
  }
  return true;
}

function projectInfraFile(project, file) {
  if (!file.startsWith(`${project.dir}/`)) return false;
  const rel = file.slice(project.dir.length + 1);
  return (
    /^(?:package\.json|vitest\.(?:config|setup)\.[cm]?[jt]s|tsconfig[^/]*\.json)$/.test(rel) ||
    /(?:^|\/)setup-[^/]+\.[cm]?[jt]s$/.test(rel)
  );
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

export function extractSpecifiers(source) {
  const specs = new Set();
  const pattern =
    /\b(?:from|import|require|vi\.(?:mock|doMock|unmock|importActual|importMock))\s*\(?\s*(['"])([^'"\n]+)\1/g;
  for (const match of source.matchAll(pattern)) specs.add(match[2]);
  return [...specs];
}

// A barrel only re-exports. Changing one changes an export surface, which
// typecheck and build verify, so importer-based selection skips it. Decided by
// content, not by the name `index`: server/src/index.ts holds real logic.
export function isBarrel(file, source) {
  const residue = stripComments(source)
    .replace(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+(['"])[^'"]+\1\s*;?/g, "")
    .replace(/\bimport\s+[^;]*?\bfrom\s+(['"])[^'"]+\1\s*;?/g, "")
    .replace(/\bimport\s+(['"])[^'"]+\1\s*;?/g, "");
  return residue.trim() === "";
}

export function exportedNames(source) {
  const text = stripComments(source);
  const names = new Set();
  const declaration =
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(declaration)) names.add(match[1]);
  for (const match of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const exported = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "").trim();
      if (exported && /^[A-Za-z_$][\w$]*$/.test(exported) && exported !== "default") names.add(exported);
    }
  }
  return [...names].filter((name) => name.length >= MIN_SYMBOL_LENGTH);
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// An in-memory view of the tracked files, with import resolution.
export class RepoIndex {
  constructor(files, read) {
    this.files = new Set(files);
    this.read = read;
    this.sources = new Map();
    this.packages = new Map();
    for (const file of this.files) {
      if (/(?:^|\/)package\.json$/.test(file) && !file.includes("node_modules")) {
        try {
          const pkg = JSON.parse(read(file));
          if (pkg.name) this.packages.set(pkg.name, { dir: path.posix.dirname(file), pkg });
        } catch {
          // Not a package manifest we can read; imports of it stay unresolved.
        }
      }
    }
    this.importers = new Map();
    for (const file of this.files) {
      if (!CODE_FILE.test(file)) continue;
      const source = read(file);
      this.sources.set(file, source);
      for (const spec of extractSpecifiers(source)) {
        const target = this.resolve(file, spec);
        if (!target || target === file) continue;
        if (!this.importers.has(target)) this.importers.set(target, new Set());
        this.importers.get(target).add(file);
      }
    }
  }

  candidates(base) {
    const out = [base];
    const swaps = [[/\.jsx$/, [".tsx"]], [/\.js$/, [".ts", ".tsx"]], [/\.mjs$/, [".mts"]], [/\.cjs$/, [".cts"]]];
    for (const [pattern, replacements] of swaps) {
      if (pattern.test(base)) for (const ext of replacements) out.push(base.replace(pattern, ext));
    }
    for (const ext of [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"]) out.push(base + ext);
    for (const ext of [".ts", ".tsx", ".js", ".mjs"]) out.push(`${base}/index${ext}`);
    return out;
  }

  firstExisting(base) {
    return this.candidates(base).find((candidate) => this.files.has(candidate)) ?? null;
  }

  resolve(fromFile, rawSpec) {
    const spec = rawSpec.replace(/[?#].*$/, "");
    if (spec.startsWith(".")) {
      return this.firstExisting(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)));
    }
    if (spec.startsWith("@/") && fromFile.startsWith("ui/")) {
      return this.firstExisting(`ui/src/${spec.slice(2)}`);
    }
    const match = /^(@[^/]+\/[^/]+|[^@./][^/]*)(\/.*)?$/.exec(spec);
    if (!match) return null;
    const entry = this.packages.get(match[1]);
    if (!entry) return null;
    return this.resolvePackage(entry, match[2] ? `.${match[2]}` : ".");
  }

  resolvePackage({ dir, pkg }, subpath) {
    const exportsField = pkg.exports;
    let target;
    if (exportsField && typeof exportsField === "object") {
      if (typeof exportsField[subpath] === "string") target = exportsField[subpath];
      else if (subpath !== "." && typeof exportsField["./*"] === "string") {
        target = exportsField["./*"].replace("*", subpath.slice(2));
      } else if (exportsField[subpath] && typeof exportsField[subpath] === "object") {
        const conditions = exportsField[subpath];
        target = [conditions.import, conditions.default, conditions.types].find((value) => typeof value === "string");
      }
    } else if (typeof exportsField === "string" && subpath === ".") {
      target = exportsField;
    }
    if (target) {
      // Published entries point at dist; the workspace source is what tests run.
      const sourceTarget = target.replace(/^\.\/dist\//, "./src/").replace(/\.d\.ts$/, ".ts");
      const resolved = this.firstExisting(path.posix.normalize(path.posix.join(dir, sourceTarget)));
      if (resolved) return resolved;
    }
    if (subpath === ".") return this.firstExisting(`${dir}/src/index`);
    return this.firstExisting(`${dir}/src/${subpath.slice(2)}`);
  }
}

function stemOf(file) {
  return path.posix.basename(file).replace(/\.[^.]+$/, "");
}

function siblingTests(index, project, file, allTests) {
  const stem = stemOf(file);
  if (stem.length < 4 || stem === "index") return [];
  const out = [];
  for (const test of allTests) {
    if (!test.startsWith(`${project.dir}/`)) continue;
    const base = path.posix.basename(test).replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, "");
    if (base === stem || base.startsWith(`${stem}.`) || base.startsWith(`${stem}-`)) out.push(test);
  }
  return out;
}

export function planTests({ files, read, changes, classes = [], durations = {} }) {
  const index = new RepoIndex(files, read);
  const tests = [...index.files].filter((file) => TEST_FILE.test(file));
  const testSet = new Set(tests);
  const projectOf = (file) =>
    PROJECTS.filter((project) => file.startsWith(`${project.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;

  const selected = new Map(); // test file -> reason
  const wholeProjects = new Map(); // project id -> reason
  const broadReasons = [];
  const notes = [];
  const add = (test, reason) => {
    if (!selected.has(test)) selected.set(test, reason);
  };

  const live = changes.filter((change) => change.status !== "D");
  const deleted = changes.filter((change) => change.status === "D");
  const touched = changes.filter((change) => projectOf(change.path));
  // Directory whose test files are named after a changed file's stem.
  const ownerDir = (file) => projectOf(file)?.dir ?? (file.startsWith("scripts/") ? "scripts" : null);
  const isDocFile = (file) => DOC_BASENAME.test(path.posix.basename(file));
  const isReadFromDisk = (file) => !CODE_FILE.test(file) && !STATIC_ASSET.test(file) && !isDocFile(file);

  // Project-level configuration changes select the whole project.
  for (const change of touched) {
    const project = projectOf(change.path);
    if (projectInfraFile(project, change.path)) {
      wholeProjects.set(project.id, `${change.path} configures ${project.name}`);
    }
  }

  const durationOf = (file) => durations[file];
  const sortedDurations = Object.values(durations).sort((a, b) => a - b);
  const median = sortedDurations.length ? sortedDurations[Math.floor(sortedDurations.length / 2)] : 1000;
  const estimate = (files) => files.reduce((sum, file) => sum + (durationOf(file) ?? median), 0);

  const hubCache = new Map();
  const isHub = (file) => {
    if (!hubCache.has(file)) {
      let count = 0;
      for (const importer of index.importers.get(file) ?? []) if (testSet.has(importer)) count += 1;
      hubCache.set(file, count > HUB_FANIN);
    }
    return hubCache.get(file);
  };

  const symbolFiles = [];
  const uncovered = [];
  for (const change of live) {
    const file = change.path;
    const project = projectOf(file);
    // Only server, ui, cli, packages and scripts are indexed. Other trees (the
    // experimental plugin, docs) have their own lanes.
    if (!index.files.has(file)) continue;
    if (TEST_FILE.test(file)) {
      if (testSet.has(file)) add(file, "changed");
      if (project && !project.big) wholeProjects.set(project.id, `${file} changed`);
      continue;
    }

    if (!CODE_FILE.test(file)) {
      const dir = ownerDir(file);
      if (dir) for (const test of siblingTests(index, { dir }, file, tests)) add(test, `named after ${file}`);
      if (!project || STATIC_ASSET.test(file) || isDocFile(file)) continue;
      if (project.big) {
        // Tests reach these files by import (fixtures, css) or by reading them
        // from disk. A file nothing imports has dependents no selection can see.
        // Migrations and package assets live in small projects, which run whole.
        const importers = index.importers.get(file);
        if (importers && importers.size > 0) {
          for (const importer of importers) {
            if (testSet.has(importer)) add(importer, `imports ${file}`);
          }
        } else if (!file.startsWith("ui/public/")) {
          broadReasons.push(`${file} is a runtime asset no import reaches; tests that read it cannot be selected`);
        }
      } else {
        wholeProjects.set(project.id, `${file} changed`);
      }
      continue;
    }

    if (project && !project.big) wholeProjects.set(project.id, `${file} changed`);
    const source = index.sources.get(file) ?? "";
    const barrel = isBarrel(file, source);
    const dir = ownerDir(file);
    if (dir) for (const test of siblingTests(index, { dir }, file, tests)) add(test, `named after ${file}`);
    if (barrel) {
      notes.push(`${file} is a re-export barrel; typecheck and build cover its export surface`);
      continue;
    }

    const before = selected.size;
    for (const importer of index.importers.get(file) ?? []) {
      if (testSet.has(importer)) {
        add(importer, `imports ${file}`);
      } else if (!isBarrel(importer, index.sources.get(importer) ?? "") && !isHub(importer)) {
        for (const second of index.importers.get(importer) ?? []) {
          if (testSet.has(second)) add(second, `imports ${importer}, which imports ${file}`);
        }
      }
    }
    if (project?.lib) symbolFiles.push({ file, names: exportedNames(source) });
    else if (selected.size === before) uncovered.push(file);
  }

  // A deleted file leaves nothing to walk from. Small projects run whole. In
  // server and ui, importers of a deleted module fail typecheck, but a deleted
  // runtime asset may be read from disk by tests no import reveals.
  for (const change of deleted) {
    const file = change.path;
    const project = projectOf(file);
    if (!project || TEST_FILE.test(file)) continue;
    if (!project.big) {
      wholeProjects.set(project.id, `${file} was deleted`);
    } else if (isReadFromDisk(file) && !file.startsWith("ui/public/")) {
      broadReasons.push(`${file} was deleted and is a runtime asset; tests that read it cannot be selected`);
    } else {
      notes.push(`${file} was deleted; typecheck and build cover what imported it`);
    }
  }

  // Packages with their own test script, and packages whose tests cannot run.
  const packageTests = new Set();
  for (const change of changes) {
    const file = change.path;
    if (isDocFile(file)) continue;
    for (const entry of PACKAGE_TESTS) {
      if (file.startsWith(`${entry.dir}/`)) packageTests.add(entry.name);
    }
    for (const entry of UNRUN_PACKAGES) {
      const prefix = entry.dir.endsWith("/") ? entry.dir : `${entry.dir}/`;
      if (file.startsWith(prefix) && !projectOf(file)) {
        const note = `${entry.dir} has tests this CI does not run: ${entry.why}`;
        if (!notes.includes(note)) notes.push(note);
      }
    }
  }

  // Shared-library exports reach consumers through a barrel, which the import
  // walk deliberately does not cross. Match tests by the names they use.
  for (const { file, names } of symbolFiles) {
    if (names.length === 0) continue;
    const pattern = new RegExp(`\\b(?:${names.map(escapeRegExp).join("|")})\\b`);
    for (const test of tests) {
      if (selected.has(test)) continue;
      if (pattern.test(index.sources.get(test) ?? "")) add(test, `uses a name exported by ${file}`);
    }
  }

  // Runner source changes reach the server through the Runner binary and its
  // vendored dist. The native-runtime suites that drive the binary are the
  // coupling worth running; the rest of that directory tests server-side
  // runtime logic that a Runner change cannot reach.
  if (classes.includes("runner") && live.some((change) => RUNNER_SOURCE.test(change.path) && !TEST_FILE.test(change.path))) {
    for (const test of tests) {
      if (RUNNER_COUPLED_SERVER_TESTS.test(test)) add(test, "drives the Runner binary");
    }
  }

  // Route selected tests to projects; a hit in a small project runs it whole.
  const byProject = new Map(PROJECTS.map((project) => [project.id, []]));
  for (const [test, reason] of selected) {
    const project = projectOf(test);
    if (!project || !isProjectTest(project, test)) continue;
    if (project.big) byProject.get(project.id).push(test);
    else if (!wholeProjects.has(project.id)) wholeProjects.set(project.id, `${reason}: ${test}`);
  }

  for (const file of uncovered) {
    if (![...selected.values()].some((reason) => reason.includes(file))) {
      notes.push(`no selected test reaches ${file}; typecheck and build cover it`);
    }
  }

  const scriptTests = [...selected.keys()].filter((test) => test.startsWith("scripts/") && /\.test\.(?:mjs|js|cjs)$/.test(test)).sort();
  const result = {
    server: null,
    ui: null,
    wholeProjects: [],
    packageTests: [...packageTests].sort(),
    scriptTests,
    broadReasons,
    notes,
    reasons: Object.fromEntries(selected),
  };

  const serverProject = PROJECTS.find((project) => project.id === "server");
  let serverFiles;
  if (wholeProjects.has("server")) {
    serverFiles = tests.filter((test) => isProjectTest(serverProject, test));
    broadReasons.push(`whole server project selected: ${wholeProjects.get("server")}`);
  } else {
    serverFiles = byProject.get("server").sort();
  }
  const serverEst = estimate(serverFiles);
  if (serverEst > SERVER_BUDGET_MS) {
    broadReasons.push(
      `server selection is ${serverFiles.length} files, ~${Math.round(serverEst / 60_000)} recorded minutes, over the ${Math.round(SERVER_BUDGET_MS / 60_000)} minute budget`,
    );
  }
  result.server = {
    files: serverFiles,
    estMs: serverEst,
    shards: serverFiles.length === 0 ? 0 : Math.min(SERVER_MAX_SHARDS, Math.max(1, Math.ceil(serverEst / SERVER_SHARD_TARGET_MS))),
  };

  result.ui = {
    whole: wholeProjects.has("ui"),
    files: wholeProjects.has("ui") ? [] : byProject.get("ui").sort(),
  };
  result.wholeProjects = PROJECTS.filter((project) => !project.big && wholeProjects.has(project.id)).map((project) => project.name);
  result.projectReasons = Object.fromEntries(wholeProjects);
  return result;
}

// ---- CLI -----------------------------------------------------------------

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

export function loadDurations(root = repoRootDefault) {
  return {
    ...loadShardDurations(path.join(root, "scripts/general-server-shard-durations.json")),
    ...loadShardDurations(path.join(root, "scripts/serialized-shard-durations.json")),
  };
}

export function planFromGit({ root = repoRootDefault, changes, classes }) {
  const tracked = git(["ls-files", "-z", "--", "server", "ui", "cli", "packages", "scripts"], root).split("\0").filter(Boolean);
  const read = (file) => {
    try {
      return readFileSync(path.join(root, file), "utf8");
    } catch {
      return "";
    }
  };
  return planTests({ files: tracked, read, changes, classes, durations: loadDurations(root) });
}

function sandboxEnv(label) {
  // Same sandbox as scripts/run-vitest-stable.mjs: config discovery would
  // otherwise read the checkout's .paperclip/config.json into unit tests.
  const root = realpathSync(mkdtempSync(path.join("/tmp", "pv-")));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PAPERCLIP_HOME: path.join(root, "h"),
    PAPERCLIP_CONFIG: path.join(root, "h", "config.json"),
    PAPERCLIP_INSTANCE_ID: `ci-${process.pid}-${label}`,
    TMPDIR: path.join(root, "t"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  return env;
}

function run(command, args, label) {
  console.log(`\n[ci-select-tests] ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit", env: sandboxEnv(label.replace(/\W+/g, "-")) });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function vitest(args, label) {
  run("pnpm", ["exec", "vitest", "run", "--exclude", "**/dist/**", ...args], label);
}

export function runGroup({ group, plan, shard, durations }) {
  if (group === "server") {
    const [index, count] = shard;
    const files = selectGeneralServerShard(plan.server.files, index, count, durations);
    console.log(`[ci-select-tests] server shard ${index + 1}/${count}: ${files.length} of ${plan.server.files.length} selected suites`);
    if (files.length === 0) return;
    vitest(["--project", "@paperclipai/server", "--no-file-parallelism", "--maxWorkers=1", ...files], `server shard ${index + 1}/${count}`);
    return;
  }
  if (group === "workspaces") {
    if (plan.wholeProjects.length > 0) {
      vitest(plan.wholeProjects.flatMap((name) => ["--project", name]), `whole projects: ${plan.wholeProjects.join(", ")}`);
    }
    if (plan.ui.whole) vitest(["--project", "@paperclipai/ui"], "ui (whole project)");
    else if (plan.ui.files.length > 0) vitest(["--project", "@paperclipai/ui", ...plan.ui.files], `ui: ${plan.ui.files.length} selected suites`);
    for (const name of plan.packageTests) run("pnpm", ["--filter", name, "test"], `package tests: ${name}`);
    return;
  }
  if (group === "scripts") {
    if (plan.scriptTests.length > 0) run("node", ["--test", ...plan.scriptTests], `script tests: ${plan.scriptTests.length} files`);
    return;
  }
  throw new Error(`unknown group ${group}`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[(i += 1)];
    else args._.push(argv[i]);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  const { listChangedFiles, classifyChanges } = await import("./ci-classify.mjs");
  if (!["plan", "run"].includes(command) || !args.base || !args.head) {
    console.error("usage: ci-select-tests.mjs plan|run --base SHA --head SHA [--group server|workspaces|scripts] [--shard I/N]");
    process.exit(2);
  }
  const changes = listChangedFiles({ base: args.base, head: args.head });
  const { classes } = classifyChanges(changes.map((change) => change.path));
  const plan = planFromGit({ changes, classes });
  if (command === "plan") {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    const shard = (args.shard ?? "1/1").split("/").map(Number);
    runGroup({ group: args.group, plan, shard: [shard[0] - 1, shard[1]], durations: loadDurations() });
  }
}
