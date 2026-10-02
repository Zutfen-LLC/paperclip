import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Archive and import tests do real zip work that crossed vitest's 5s
    // default on the slower self-hosted CI hosts.
    testTimeout: 30000,
  },
});
