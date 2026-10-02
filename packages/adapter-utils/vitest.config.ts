import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The process-session tests spawn real wrapper processes and poll for
    // their cleanup, which crossed vitest's 5s default on the slower
    // self-hosted CI hosts.
    testTimeout: 30000,
  },
});
