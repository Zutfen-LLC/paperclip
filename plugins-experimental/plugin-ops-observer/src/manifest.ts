import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
} from "./constants.js";

/**
 * Ops Supervisor read-only observer (experiment).
 *
 * Capability budget is deliberately minimal and contains NO data-write,
 * issue, agent, or state capabilities. The plugin can: fetch its dedicated
 * read-only adapter over HTTP, keep a short-lived derived cache, and render
 * one read-only page. Nothing else.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Ops Work (Read-Only Observer)",
  description:
    "Displays Ops Supervisor-managed work as a read-only snapshot. " +
    "Ops Supervisor and GitHub remain the sole authorities; this plugin " +
    "cannot create, mutate, dispatch, approve, merge, or cancel anything.",
  author: "Zutfen LLC",
  categories: ["ui", "connector"],
  capabilities: [
    "http.outbound",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      adapterBaseUrl: {
        type: "string",
        title: "Read-only adapter base URL",
        description:
          "Base URL of the dedicated ops-readonly-adapter (GET /snapshot only).",
        default: "http://127.0.0.1:18487",
      },
      adapterToken: {
        type: "string",
        format: "secret-ref",
        title: "Read-only adapter bearer token",
        description:
          "Token that authorizes ONLY the adapter's single GET /snapshot route. Select a company secret; raw values are not protected as secrets here.",
      },
    },
    required: ["adapterBaseUrl", "adapterToken"],
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Ops Work (Observed)",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
    ],
  },
};

export default manifest;
