import { expect, test } from "bun:test";
import {
  filterModelCandidates,
  modelCandidateEmptyState,
  resetDiscoveredModelCandidates,
  retainSelectedModelCandidates,
} from "../launcher/src/api-access-model-selection";
import {
  recoverApiAccessActionFailure,
  shouldShowUpstreamMissingKey,
  upstreamDraftDiscoveryRevision,
  upstreamDraftMutationRevision,
  upstreamDraftRevisionConflict,
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

test("manual model empty states distinguish not fetched, empty results, and search misses", () => {
  expect(modelCandidateEmptyState([], [], false)).toBe("not-fetched");
  expect(modelCandidateEmptyState([], [], true)).toBe("empty");
  expect(modelCandidateEmptyState(["gpt-one"], [], true)).toBe("no-match");
  expect(modelCandidateEmptyState(["gpt-one"], ["gpt-one"], true)).toBeNull();
});

test("manual model discovery failure preserves the draft but not the previous transient candidates", async () => {
  const draft = {
    baseUrl: "https://draft.example/v1",
    key: "new-key",
    proxy: { mode: "custom", url: "http://proxy.example:8080" },
    filter: { mode: "selected", models: ["gpt-selected"] },
    candidateModels: ["gpt-selected", "gpt-candidate"],
  };
  const before = structuredClone(draft);
  draft.candidateModels = resetDiscoveredModelCandidates(draft.filter.models);
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
  expect(draft).toEqual({ ...before, candidateModels: ["gpt-selected"] });
});

test("upstream draft revision conflict keeps the original baseline stale", () => {
  const baseline = "revision-before-edit";
  expect(upstreamDraftRevisionConflict(true, baseline, baseline)).toBe(false);
  expect(upstreamDraftRevisionConflict(true, baseline, "revision-from-external-edit")).toBe(true);
  expect(upstreamDraftRevisionConflict(false, baseline, "revision-from-external-edit")).toBe(false);
});

test("upstream mutations cannot adopt a revision that changed after the draft baseline", () => {
  const baseline = "revision-before-edit";
  expect(upstreamDraftMutationRevision(baseline, baseline)).toBe(baseline);
  expect(upstreamDraftMutationRevision(baseline, "revision-from-external-edit")).toBeNull();
  expect(upstreamDraftMutationRevision(null, "revision-from-external-edit")).toBeNull();
});

test("manual discovery can use a stale draft baseline only when the draft supplies its own key", () => {
  const baseline = "revision-before-edit";
  const current = "revision-from-external-edit";
  expect(upstreamDraftDiscoveryRevision(baseline, current, true)).toBe(baseline);
  expect(upstreamDraftDiscoveryRevision(baseline, current, false)).toBeNull();
  expect(upstreamDraftDiscoveryRevision(baseline, baseline, false)).toBe(baseline);
  expect(upstreamDraftDiscoveryRevision(null, current, true)).toBeNull();
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
