import { expect, test } from "bun:test";
import {
  filterModelCandidates,
  retainSelectedModelCandidates,
} from "../launcher/src/api-access-model-selection";
import {
  recoverApiAccessActionFailure,
  shouldShowUpstreamMissingKey,
} from "../launcher/src/api-access-renderer-state";

test("manual model refresh keeps selected IDs that disappeared from the latest catalog removable", () => {
  const selected = ["gpt-a", "gpt-b"];
  expect(retainSelectedModelCandidates(["gpt-a", "gpt-c"], selected)).toEqual([
    "gpt-a",
    "gpt-c",
    "gpt-b",
  ]);
  expect(selected).toEqual(["gpt-a", "gpt-b"]);
});

test("manual model search filters candidates locally without changing selected IDs", () => {
  const selected = ["gpt-beta"];
  const candidates = retainSelectedModelCandidates(["gpt-alpha", "GPT-BETA", "other"], selected);
  expect(filterModelCandidates(candidates, "Gpt-")).toEqual(["gpt-alpha", "GPT-BETA", "gpt-beta"]);
  expect(filterModelCandidates(candidates, " beta ")).toEqual(["GPT-BETA", "gpt-beta"]);
  expect(selected).toEqual(["gpt-beta"]);
});

test("manual model discovery failure preserves the complete unsaved upstream draft", async () => {
  const draft = {
    baseUrl: "https://draft.example/v1",
    key: "new-key",
    proxy: { mode: "custom", url: "http://proxy.example:8080" },
    filter: { mode: "selected", models: ["gpt-selected"] },
    candidateModels: ["gpt-selected", "gpt-candidate"],
  };
  const before = structuredClone(draft);
  let refreshes = 0;
  await recoverApiAccessActionFailure("preserve-draft", async () => {
    refreshes++;
    Object.assign(draft, {
      baseUrl: "https://saved.example/v1",
      key: "",
      proxy: { mode: "global" },
      filter: { mode: "all" },
      candidateModels: [],
    });
  });
  expect(refreshes).toBe(0);
  expect(draft).toEqual(before);
});

test("configured upstream with an unreadable key shows the missing-key state", () => {
  expect(shouldShowUpstreamMissingKey({
    configuredMode: "api-key",
    effectiveMode: "api-key",
    revision: "revision",
    keyConfigured: true,
    keyAvailable: true,
    keyStorage: "os",
    runtimeState: "restart-required",
    baseUrl: "http://127.0.0.1:17841/v1",
    canApply: true,
    cleanupPending: false,
    upstream: {
      configured: true,
      keyAvailable: false,
      keyStorage: "unavailable",
      runtimeAvailable: false,
    },
  })).toBe(true);
});
