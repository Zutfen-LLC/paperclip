import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });

const watch = process.argv.includes("--watch");
const contexts = await Promise.all([
  // Ship the canonical schema inside the manifest, not as a host runtime import.
  // This also makes the exact built manifest independently loadable for validation.
  esbuild.context({ ...presets.esbuild.manifest, external: [] }),
  esbuild.context(presets.esbuild.worker),
  esbuild.context(presets.esbuild.ui),
]);
if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watch mode: manifest, worker, ui");
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
