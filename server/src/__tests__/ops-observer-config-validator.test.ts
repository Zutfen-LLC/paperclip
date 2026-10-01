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
  it.each(["latest", 1, 3])("accepts the shared version selector %s", (version) => {
    expect(validateInstanceConfig({
      adapterBaseUrl: "http://127.0.0.1:18487",
      adapterToken: { type: "secret_ref", secretId, version },
    }, manifest.instanceConfigSchema!)).toEqual({ valid: true });
  });

  it.each([
    secretId,
    "legacy-plaintext-not-a-reference",
    null,
    [],
    { type: "plain", value: "private-value" },
    { type: "secret_ref", secretId: "not-a-uuid" },
    { type: "secret_ref", secretId, version: null },
    { type: "secret_ref", secretId, version: 0 },
    { type: "secret_ref", secretId, version: 1.5 },
    { type: "secret_ref", secretId, value: "private-value" },
  ])("rejects malformed refs and plaintext without echoing input (#%#)", (adapterToken) => {
    const result = validateInstanceConfig({
      adapterBaseUrl: "http://127.0.0.1:18487",
      adapterToken,
    }, manifest.instanceConfigSchema!);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.errors).includes("private-value")).toBe(false);
    expect(JSON.stringify(result.errors).includes("legacy-plaintext")).toBe(false);
  });
});
