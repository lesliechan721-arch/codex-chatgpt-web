import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { apiAccessRevision, apiKeyPolicy, parseApiAccessPolicy } from "../src/api-access";

// The Electron runtime is CJS and the daemon is Bun/TS. Keep their version-1 contract identical.
const gui = createRequire(import.meta.url)("../launcher/electron/api-access-settings.cjs");

test("Launcher and daemon agree on policy hashing and startup evidence", () => {
  const controlToken = "test-control-token-not-a-real-secret";
  for (const key of ["a".repeat(32), "cgw_" + "b".repeat(43), "z".repeat(256)]) {
    const policy = apiKeyPolicy(key);
    expect(gui.keyPolicy(key)).toEqual(policy);
    expect(gui.parsePolicy(policy)).toEqual(parseApiAccessPolicy(policy));
    expect(gui.policyRevision(policy, controlToken)).toBe(apiAccessRevision(policy, controlToken));
  }
  const legacy = { version: 1, mode: "openai" } as const;
  expect(gui.parsePolicy(legacy)).toEqual(parseApiAccessPolicy(legacy));
  expect(gui.policyRevision(legacy, controlToken)).toBe(apiAccessRevision(legacy, controlToken));
});

test("Launcher and daemon reject the same malformed policies", () => {
  for (const raw of [null, [], {}, { version: 2, mode: "openai" },
    { version: 1, mode: "api-key", keySha256: "bad" },
    { version: 1, mode: "openai", key: "must-not-be-stored" }]) {
    expect(() => gui.parsePolicy(raw)).toThrow();
    expect(() => parseApiAccessPolicy(raw)).toThrow();
  }
});
