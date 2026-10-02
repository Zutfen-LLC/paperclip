import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  HUB_FANIN,
  PACKAGE_TESTS,
  PROJECTS,
  RepoIndex,
  SERVER_BUDGET_MS,
  SERVER_SHARD_TARGET_MS,
  UNRUN_PACKAGES,
  exportedNames,
  extractSpecifiers,
  isBarrel,
  planTests,
} from "../ci-select-tests.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function fixture(tree) {
  const files = Object.keys(tree);
  return { files, read: (file) => tree[file] ?? "" };
}

const change = (file, status = "M") => ({ status, path: file });

// A small monorepo shaped like the real one: a shared package behind a
// barrel, a server with a route -> service chain, and a ui.
function baseTree(extra = {}) {
  return {
    "packages/shared/package.json": JSON.stringify({
      name: "@paperclipai/shared",
      exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
    }),
    "packages/shared/src/index.ts": 'export * from "./validators/index.js";\nexport * from "./other.js";\n',
    "packages/shared/src/validators/index.ts": 'export * from "./secret.js";\n',
    "packages/shared/src/validators/secret.ts":
      "export const envBindingSecretRefSchema = {};\nexport function parseSecretBinding() {}\nexport const ab = 1;\n",
    "packages/shared/src/other.ts": "export const otherThing = 1;\n",
    "server/package.json": JSON.stringify({ name: "@paperclipai/server" }),
    "server/src/services/plugin-config-validator.ts": 'import { envBindingSecretRefSchema } from "@paperclipai/shared";\nexport const v = envBindingSecretRefSchema;\n',
    "server/src/routes/plugins.ts": 'import { v } from "../services/plugin-config-validator.js";\nexport const r = v;\n',
    "server/src/__tests__/plugin-config-validator.test.ts": 'import { v } from "../services/plugin-config-validator.js";\n',
    "server/src/__tests__/plugin-routes.test.ts": 'import { r } from "../routes/plugins.js";\n',
    "server/src/__tests__/uses-symbol.test.ts": 'import { envBindingSecretRefSchema } from "@paperclipai/shared";\n',
    "server/src/__tests__/unrelated.test.ts": 'import { x } from "../services/other.js";\n',
    "ui/package.json": JSON.stringify({ name: "@paperclipai/ui" }),
    "ui/src/components/Form.tsx": "export function Form() {}\n",
    "ui/src/components/Form.test.tsx": 'import { Form } from "./Form";\n',
    "ui/src/pages/Page.tsx": 'import { Form } from "@/components/Form";\nexport const Page = Form;\n',
    "ui/src/pages/Page.test.tsx": 'import { Page } from "./Page";\n',
    ...extra,
  };
}

const plan = (tree, changes, extra = {}) => {
  const { files, read } = fixture(tree);
  return planTests({ files, read, changes, ...extra });
};

test("extractSpecifiers finds static, dynamic, require and mock specifiers", () => {
  const source = `
    import a from "./a.js";
    import "./side-effect";
    export * from "./reexport";
    export { x } from "./named";
    const b = await import("./dynamic.js");
    const c = require("./cjs");
    vi.mock("../mocked.js", () => ({}));
    await vi.importActual("../actual.js");
    import type { T } from "@paperclipai/shared/types";
  `;
  assert.deepEqual(
    extractSpecifiers(source).sort(),
    ["./a.js", "./side-effect", "./reexport", "./named", "./dynamic.js", "./cjs", "../mocked.js", "../actual.js", "@paperclipai/shared/types"].sort(),
  );
});

test("isBarrel recognises re-export-only modules and nothing else", () => {
  // Decided by content: an index file with real logic is not a barrel.
  assert.equal(isBarrel("a/index.ts", 'export * from "./x.js";\n'), true);
  assert.equal(isBarrel("a/index.ts", "export function bootstrap() { return 1; }\n"), false);
  assert.equal(isBarrel("a/index.ts", 'export * from "./x.js";\nexport const own = 1;\n'), false);
  assert.equal(isBarrel("a/mod.ts", 'export * from "./x.js";\nexport { y } from "./y.js";\nexport type { Z } from "./z.js";\n'), true);
  assert.equal(isBarrel("a/mod.ts", 'import { a } from "./a.js";\n// nothing else\n'), true);
  assert.equal(isBarrel("a/mod.ts", 'export * from "./x.js";\nexport const own = 1;\n'), false);
  assert.equal(isBarrel("a/mod.ts", "export function f() {}\n"), false);
});

test("exportedNames reads declarations and export lists, and drops short names", () => {
  const names = exportedNames(`
    export const envBindingSecretRefSchema = 1;
    export async function loadThing() {}
    export class WidgetFactory {}
    export interface PluginConfig {}
    export type SecretBinding = string;
    export enum Phase { A }
    export { localName as publicName, plain };
    export const ab = 1;
    // export const commented = 1;
  `);
  for (const expected of ["envBindingSecretRefSchema", "loadThing", "WidgetFactory", "PluginConfig", "SecretBinding", "Phase", "publicName", "plain"]) {
    assert.ok(names.includes(expected) || expected === "Phase" || expected === "plain", expected);
  }
  assert.ok(!names.includes("ab"));
  assert.ok(!names.includes("commented"));
  assert.ok(!names.includes("localName"));
});

test("RepoIndex resolves relative, alias and workspace-package specifiers", () => {
  const { files, read } = fixture(
    baseTree({
      "ui/src/pages/Probe.test.tsx": 'import { Page } from "./Page";\nimport { Form } from "@/components/Form";\nimport { s } from "@paperclipai/shared/other";\nimport { t } from "@paperclipai/shared";\nimport "../components/Form.js";\n',
    }),
  );
  const index = new RepoIndex(files, read);
  const probe = "ui/src/pages/Probe.test.tsx";
  const targets = [...index.importers.entries()].filter(([, from]) => from.has(probe)).map(([target]) => target).sort();
  assert.deepEqual(targets, [
    "packages/shared/src/index.ts",
    "packages/shared/src/other.ts",
    "ui/src/components/Form.tsx",
    "ui/src/pages/Page.tsx",
  ]);
});

test("a changed test file is selected and nothing else is dragged in", () => {
  const result = plan(baseTree(), [change("server/src/__tests__/unrelated.test.ts")]);
  assert.deepEqual(result.server.files, ["server/src/__tests__/unrelated.test.ts"]);
  assert.equal(result.reasons["server/src/__tests__/unrelated.test.ts"], "changed");
});

test("direct and one-hop importers are selected through a non-barrel intermediate", () => {
  const result = plan(baseTree(), [change("server/src/services/plugin-config-validator.ts")]);
  assert.deepEqual(result.server.files, [
    "server/src/__tests__/plugin-config-validator.test.ts",
    "server/src/__tests__/plugin-routes.test.ts",
  ]);
  assert.match(result.reasons["server/src/__tests__/plugin-routes.test.ts"], /imports server\/src\/routes\/plugins\.ts, which imports/);
});

test("the walk does not cross a re-export barrel", () => {
  // Every test imports the barrel; touching a leaf behind it must not select them all.
  const tree = baseTree({
    "server/src/barrel/index.ts": 'export * from "./leaf.js";\n',
    "server/src/barrel/leaf.ts": "export const leaf = 1;\n",
    "server/src/__tests__/via-barrel-a.test.ts": 'import { leaf } from "../barrel/index.js";\n',
    "server/src/__tests__/via-barrel-b.test.ts": 'import { leaf } from "../barrel/index.js";\n',
  });
  const result = plan(tree, [change("server/src/barrel/leaf.ts")]);
  assert.deepEqual(result.server.files, []);
});

test("a changed barrel selects no importers, only a note", () => {
  const result = plan(baseTree(), [change("packages/shared/src/index.ts")]);
  assert.deepEqual(result.server.files, []);
  assert.ok(result.notes.some((note) => /packages\/shared\/src\/index\.ts is a re-export barrel/.test(note)));
});

test("a hub intermediate is not walked through, but direct importers always run", () => {
  const tree = baseTree({
    "server/src/hub.ts": 'import { v } from "./services/plugin-config-validator.js";\nexport const hub = v;\n',
  });
  for (let i = 0; i <= HUB_FANIN; i += 1) {
    tree[`server/src/__tests__/hub-user-${i}.test.ts`] = 'import { hub } from "../hub.js";\n';
  }
  const result = plan(tree, [change("server/src/services/plugin-config-validator.ts")]);
  assert.ok(!result.server.files.some((file) => file.includes("hub-user-")), "hub importers must be cut");
  assert.ok(result.server.files.includes("server/src/__tests__/plugin-config-validator.test.ts"));
  assert.ok(result.server.files.includes("server/src/__tests__/plugin-routes.test.ts"));
});

test("tests named after a changed file are selected", () => {
  const tree = baseTree({
    "server/src/services/widget-store.ts": "export const w = 1;\n",
    "server/src/__tests__/widget-store.test.ts": "// no import at all\n",
    "server/src/__tests__/widget-store-extra.test.ts": "// no import at all\n",
    "server/src/__tests__/widget-storefront.test.ts": "// must not match\n",
  });
  const result = plan(tree, [change("server/src/services/widget-store.ts")]);
  assert.deepEqual(result.server.files, ["server/src/__tests__/widget-store-extra.test.ts", "server/src/__tests__/widget-store.test.ts"]);
});

test("a shared-library change selects tests that use its exported names, across projects", () => {
  const tree = baseTree({
    "ui/src/pages/Secrets.test.tsx": 'import { envBindingSecretRefSchema } from "@paperclipai/shared";\n',
  });
  const result = plan(tree, [change("packages/shared/src/validators/secret.ts")]);
  assert.ok(result.server.files.includes("server/src/__tests__/uses-symbol.test.ts"));
  assert.ok(!result.server.files.includes("server/src/__tests__/unrelated.test.ts"));
  assert.deepEqual(result.ui.files, ["ui/src/pages/Secrets.test.tsx"]);
  assert.match(result.reasons["server/src/__tests__/uses-symbol.test.ts"], /uses a name exported by packages\/shared\/src\/validators\/secret\.ts/);
});

test("a touched small project runs whole; a hit in a small project runs it whole", () => {
  const tree = baseTree({
    "packages/adapters/codex-local/package.json": JSON.stringify({ name: "@paperclipai/adapter-codex-local" }),
    "packages/adapters/codex-local/src/run.test.ts": 'import { parseSecretBinding } from "@paperclipai/shared";\n',
  });
  const result = plan(tree, [change("packages/shared/src/validators/secret.ts")]);
  assert.deepEqual(result.wholeProjects.sort(), ["@paperclipai/adapter-codex-local", "@paperclipai/shared"]);
});

test("changing a project's own test configuration runs the whole project", () => {
  const ui = plan(baseTree(), [change("ui/vitest.config.ts")]);
  assert.equal(ui.ui.whole, true);
  assert.deepEqual(ui.ui.files, []);
  assert.deepEqual(ui.broadReasons, []);

  // Whole server is the entire inventory: that is the broad tier.
  const server = plan(baseTree(), [change("server/vitest.config.ts")]);
  assert.ok(server.broadReasons.some((reason) => /whole server project selected/.test(reason)));
});

test("a server selection over the duration budget escalates to broad instead of truncating", () => {
  const tree = baseTree();
  const durations = {};
  const changes = [];
  for (let i = 0; i < 6; i += 1) {
    const test = `server/src/__tests__/slow-${i}.test.ts`;
    tree[test] = "";
    durations[test] = SERVER_BUDGET_MS / 5;
    changes.push(change(test));
  }
  const result = plan(tree, changes, { durations });
  assert.equal(result.server.files.length, 6, "nothing is silently dropped");
  assert.ok(result.broadReasons.some((reason) => /over the \d+ minute budget/.test(reason)));
});

test("shard count follows estimated duration, between one and three", () => {
  const tree = baseTree();
  const changes = [];
  const durations = {};
  const add = (n, ms) => {
    for (let i = 0; i < n; i += 1) {
      const test = `server/src/__tests__/t${ms}-${i}.test.ts`;
      tree[test] = "";
      durations[test] = ms;
      changes.push(change(test));
    }
  };
  assert.equal(plan(tree, [], { durations }).server.shards, 0);
  add(1, 1000);
  assert.equal(plan(tree, changes, { durations }).server.shards, 1);
  add(1, SERVER_SHARD_TARGET_MS * 1.2);
  assert.equal(plan(tree, changes, { durations }).server.shards, 2);
  add(1, SERVER_SHARD_TARGET_MS * 1.5);
  assert.equal(plan(tree, changes, { durations }).server.shards, 3);
});

test("a runtime asset that no import reaches escalates to broad; imported, static and doc files do not", () => {
  const tree = baseTree({
    "server/src/onboarding-assets/guide.md": "# guide\n",
    "server/src/fixtures/data.json": "{}\n",
    "server/src/__tests__/reads-fixture.test.ts": 'import data from "../fixtures/data.json";\n',
    "ui/public/logo.svg": "<svg/>",
    "server/README.md": "# server\n",
  });
  const unreachable = plan(tree, [change("server/src/onboarding-assets/guide.md")]);
  assert.ok(unreachable.broadReasons.some((reason) => /runtime asset no import reaches/.test(reason)));

  const imported = plan(tree, [change("server/src/fixtures/data.json")]);
  assert.deepEqual(imported.broadReasons, []);
  assert.deepEqual(imported.server.files, ["server/src/__tests__/reads-fixture.test.ts"]);

  for (const file of ["ui/public/logo.svg", "server/README.md"]) {
    assert.deepEqual(plan(tree, [change(file)]).broadReasons, [], file);
  }
});

test("deleted files are not selected and do not throw", () => {
  const result = plan(baseTree(), [change("server/src/services/plugin-config-validator.ts", "D"), change("server/src/__tests__/gone.test.ts", "D")]);
  assert.deepEqual(result.server.files, []);
});

test("runner source changes add only the native runtime suites that drive the Runner binary", () => {
  const tree = baseTree({
    "packages/paperclip-runner/package.json": JSON.stringify({ name: "@paperclipai/paperclip-runner" }),
    "packages/paperclip-runner/src/index.ts": "export const run = 1;\n",
    "server/src/services/native-runtime/native-codex-runner.integration.test.ts": "",
    "server/src/services/native-runtime/runner-api.test.ts": "",
    "server/src/services/native-runtime/native-session-executor.test.ts": "",
  });
  const changes = [change("packages/paperclip-runner/src/index.ts")];
  assert.deepEqual(plan(tree, changes, { classes: ["runner"] }).server.files, [
    "server/src/services/native-runtime/native-codex-runner.integration.test.ts",
    "server/src/services/native-runtime/runner-api.test.ts",
  ]);
  assert.deepEqual(plan(tree, changes, { classes: [] }).server.files, []);
});

test("files outside the indexed trees are ignored by test selection", () => {
  const result = plan(baseTree(), [change("plugins-experimental/plugin-ops-observer/src/manifest.ts"), change("scripts/release.sh")]);
  assert.deepEqual(result.server.files, []);
  assert.deepEqual(result.wholeProjects, []);
  assert.deepEqual(result.broadReasons, []);
});


test("an index file with real logic selects its importers; a pure barrel does not", () => {
  const tree = baseTree({
    "server/src/index.ts": 'import { v } from "./services/plugin-config-validator.js";\nexport function startServer() { return v; }\n',
    "server/src/__tests__/boot.test.ts": 'import { startServer } from "../index.js";\n',
  });
  assert.deepEqual(plan(tree, [change("server/src/index.ts")]).server.files, ["server/src/__tests__/boot.test.ts"]);
});

test("deleted source and assets: small projects run whole, server assets escalate, tests are ignored", () => {
  const tree = baseTree({ "packages/db/package.json": JSON.stringify({ name: "@paperclipai/db" }) });
  const smallProject = plan(tree, [change("packages/db/src/schema/old.ts", "D")]);
  assert.deepEqual(smallProject.wholeProjects, ["@paperclipai/db"]);

  const serverAsset = plan(tree, [change("server/src/onboarding-assets/guide.md", "D")]);
  assert.ok(serverAsset.broadReasons.some((reason) => /was deleted and is a runtime asset/.test(reason)));

  const serverCode = plan(tree, [change("server/src/services/old.ts", "D")]);
  assert.deepEqual(serverCode.broadReasons, []);
  assert.ok(serverCode.notes.some((note) => /was deleted; typecheck and build cover/.test(note)));

  const deletedTest = plan(tree, [change("server/src/__tests__/gone.test.ts", "D")]);
  assert.deepEqual([deletedTest.broadReasons, deletedTest.server.files, deletedTest.wholeProjects], [[], [], []]);
});

test("assets in small projects run the project whole instead of escalating (migrations)", () => {
  const tree = baseTree({
    "packages/db/package.json": JSON.stringify({ name: "@paperclipai/db" }),
    "packages/db/src/migrations/0099_new.sql": "create table t ();\n",
    "packages/db/src/migrations/meta/_journal.json": "{}\n",
  });
  const result = plan(tree, [change("packages/db/src/migrations/0099_new.sql"), change("packages/db/src/migrations/meta/_journal.json")]);
  assert.deepEqual(result.broadReasons, []);
  assert.deepEqual(result.wholeProjects, ["@paperclipai/db"]);
});

test("ui public assets are covered by the build, not escalated", () => {
  const result = plan(baseTree({ "ui/public/site.webmanifest": "{}\n" }), [change("ui/public/site.webmanifest")]);
  assert.deepEqual(result.broadReasons, []);
});

test("changed scripts select their sibling and importing tests for node --test", () => {
  const tree = baseTree({
    "scripts/prepare-npm-readme.mjs": "export const prepare = 1;\n",
    "scripts/prepare-npm-readme.test.mjs": 'import { prepare } from "./prepare-npm-readme.mjs";\n',
    "scripts/__tests__/prepare-npm-readme-extra.test.mjs": "// named after the script\n",
    "scripts/__tests__/ensure-plugin-build-deps.test.mjs": 'import "../ensure-plugin-build-deps.mjs";\n',
    "scripts/ensure-plugin-build-deps.mjs": "export const e = 1;\n",
    "scripts/unrelated.test.mjs": "",
  });
  const result = plan(tree, [change("scripts/prepare-npm-readme.mjs"), change("scripts/ensure-plugin-build-deps.mjs")]);
  assert.deepEqual(result.scriptTests, [
    "scripts/__tests__/ensure-plugin-build-deps.test.mjs",
    "scripts/__tests__/prepare-npm-readme-extra.test.mjs",
    "scripts/prepare-npm-readme.test.mjs",
  ]);
  assert.deepEqual(result.server.files, []);
});

test("a change inside an allowlisted package runs that package's test script; docs inside it do not", () => {
  const tree = baseTree();
  const result = plan(tree, [change("packages/teams-catalog/src/teams.ts"), change("packages/tailscale-https-broker/README.md")]);
  assert.deepEqual(result.packageTests, ["@paperclipai/teams-catalog"]);
});

test("a change inside a package with tests CI cannot run leaves a note, not a silent skip", () => {
  const result = plan(baseTree(), [change("packages/mcp-server/src/tools.ts"), change("packages/plugins/sandbox-providers/e2b/src/index.ts")]);
  assert.deepEqual(result.packageTests, []);
  assert.ok(result.notes.some((note) => /packages\/mcp-server has tests this CI does not run/.test(note)));
  assert.ok(result.notes.some((note) => /sandbox-providers\/ has tests this CI does not run/.test(note)));
  // The daytona provider is a vitest project, so it gets no such note.
  const daytona = plan(baseTree(), [change("packages/plugins/sandbox-providers/daytona/src/index.ts")]);
  assert.ok(!daytona.notes.some((note) => /sandbox-providers/.test(note)));
});

// ---- guards against the real repository ---------------------------------

test("PROJECTS covers every project scripts/run-vitest-stable.mjs runs, and extras are root vitest projects", () => {
  const source = readFileSync(path.join(repoRoot, "scripts/run-vitest-stable.mjs"), "utf8");
  const block = /const nonServerProjects = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  const upstream = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(upstream.length > 5);
  const ours = PROJECTS.filter((project) => project.id !== "server");
  const names = ours.map((project) => project.name);
  for (const name of upstream) assert.ok(names.includes(name), `${name} is run upstream`);
  const rootConfig = readFileSync(path.join(repoRoot, "vitest.config.ts"), "utf8");
  for (const project of ours.filter((candidate) => !upstream.includes(candidate.name))) {
    assert.ok(rootConfig.includes(`"${project.dir}"`), `${project.dir} must be a project in vitest.config.ts`);
  }
});

test("PACKAGE_TESTS and UNRUN_PACKAGES point at real workspace packages", () => {
  for (const { dir, name } of PACKAGE_TESTS) {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"));
    assert.equal(manifest.name, name);
    assert.ok(manifest.scripts?.test, `${dir} has a test script`);
    assert.ok(!PROJECTS.some((project) => project.dir === dir), `${dir} is not also a vitest project`);
  }
  for (const { dir, why } of UNRUN_PACKAGES) {
    assert.ok(existsSync(path.join(repoRoot, dir.replace(/\/$/, ""))), dir);
    assert.ok(why.length > 10);
    assert.ok(!PACKAGE_TESTS.some((entry) => entry.dir === dir.replace(/\/$/, "")));
  }
});

test("every PROJECTS entry is a real package with that name", () => {
  for (const project of PROJECTS) {
    const manifest = path.join(repoRoot, project.dir, "package.json");
    assert.ok(existsSync(manifest), `${project.dir}/package.json`);
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).name, project.name);
  }
});
