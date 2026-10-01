import { describe, expect, it } from "vitest";
import manifest from "../../../plugins-experimental/plugin-ops-observer/src/manifest.js";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

const secretId = "77777777-7777-4777-8777-777777777777";

describe("Ops observer host config boundary (Issue #4)", () => {
  it("accepts the production object-shaped company secret reference", () => {
    const result = validateInstanceConfig({
      adapterBaseUrl: "http://127.0.0.1:18487",
      adapterToken: { type: "secret_ref", secretId },
    }, manifest.instanceConfigSchema!);

    // On the unfixed manifest this reports /adapterToken: must be string.
    expect(result).toEqual({ valid: true });
  });
});
