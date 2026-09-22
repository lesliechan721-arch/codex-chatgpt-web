import { expect, test } from "bun:test";
import type { UpstreamModelCandidate, UpstreamModelPreview } from "../launcher/src/api-access-types";
import {
  automaticMetadataMode,
  customMetadataBaseMode,
  filterModelCandidates,
  metadataModeChoices,
  modelCandidateEmptyState,
  modelDiscoveryState,
  resetDiscoveredModelCandidates,
  retainBundledMetadataFacts,
  retainSelectedModelCandidates,
} from "../launcher/src/api-access-model-selection";
import {
  customOverrideTextFor,
  parseCustomOverrideText,
  recordValue,
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

test("stale selected bundled models keep choices and use the viewed default for Auto to Custom", () => {
  const preview: UpstreamModelPreview = {
    id: "gpt-stale",
    discovered: false,
    hasUpstreamMetadata: false,
    hasBundledMetadata: true,
    availableModes: ["default", "fallback", "custom"],
    automaticMode: "default",
    configuredMode: "default",
    configuredSourceAvailable: true,
    effectiveMode: "default",
    effectiveBaseMode: "default",
    degraded: false,
    customInvalid: false,
    model: {},
  };
  expect(metadataModeChoices(undefined, preview)).toEqual({
    modes: ["default", "fallback", "custom"],
    baseModes: ["default", "fallback"],
  });
  expect(automaticMetadataMode(undefined, preview)).toBe("default");
  expect(customMetadataBaseMode(undefined, undefined, preview)).toBe("default");
  expect(customMetadataBaseMode(undefined, preview, undefined)).toBe("default");
});

test("saved model discovery state distinguishes discovered, successful absence, and no current result", () => {
  const preview: UpstreamModelPreview = {
    id: "gpt-saved",
    discovered: false,
    hasUpstreamMetadata: false,
    hasBundledMetadata: false,
    availableModes: ["fallback", "custom"],
    automaticMode: "fallback",
    configuredMode: null,
    configuredSourceAvailable: true,
    effectiveMode: "fallback",
    effectiveBaseMode: "fallback",
    degraded: false,
    customInvalid: false,
    model: {},
  };
  expect(modelDiscoveryState(undefined, preview, false)).toBe("unavailable");
  expect(modelDiscoveryState(undefined, preview, true)).toBe("missing");
  expect(modelDiscoveryState(preview, undefined, true)).toBe("missing");
  const candidate: UpstreamModelCandidate = {
    id: preview.id,
    hasUpstreamMetadata: preview.hasUpstreamMetadata,
    hasBundledMetadata: preview.hasBundledMetadata,
    availableModes: preview.availableModes,
    automaticMode: preview.automaticMode,
  };
  expect(modelDiscoveryState(candidate, preview, true)).toBe("discovered");
  expect(modelDiscoveryState(undefined, { ...preview, discovered: true }, false)).toBe("discovered");
});

test("provider identity invalidation keeps only exact bundled metadata facts", () => {
  const preview: UpstreamModelPreview = {
    id: "gpt-bundled",
    discovered: true,
    hasUpstreamMetadata: true,
    hasBundledMetadata: true,
    availableModes: ["upstream", "default", "fallback", "custom"],
    automaticMode: "upstream",
    configuredMode: null,
    configuredSourceAvailable: true,
    effectiveMode: "upstream",
    effectiveBaseMode: "upstream",
    degraded: false,
    customInvalid: false,
    model: { slug: "gpt-bundled" },
  };
  const facts = retainBundledMetadataFacts({
    [preview.id]: preview,
    "provider-only": { ...preview, id: "provider-only", hasBundledMetadata: false },
  });
  const bundled = recordValue(facts, preview.id);
  expect(Object.keys(facts)).toEqual([preview.id]);
  expect(metadataModeChoices(bundled, undefined)).toEqual({
    modes: ["default", "fallback", "custom"],
    baseModes: ["default", "fallback"],
  });
  expect(automaticMetadataMode(bundled, undefined)).toBe("default");
  expect(customMetadataBaseMode(undefined, bundled, undefined)).toBe("default");
  expect(modelDiscoveryState(bundled, undefined, false)).toBe("unavailable");
});

test("Renderer custom override state treats prototype-named model IDs as ordinary keys", () => {
  for (const modelId of ["__proto__", "constructor", "toString"]) {
    let overrideText: Record<string, string> = {};
    expect(recordValue(overrideText, modelId)).toBeUndefined();

    overrideText = { ...overrideText, [modelId]: customOverrideTextFor(overrideText, modelId) };
    expect(recordValue(overrideText, modelId)).toBe("{}");

    overrideText = { ...overrideText, [modelId]: '{"support_verbosity":false}' };
    expect(customOverrideTextFor(overrideText, modelId)).toBe('{"support_verbosity":false}');
    expect(parseCustomOverrideText(overrideText, modelId)).toEqual({ support_verbosity: false });
  }
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
    modelCatalogState: "pending",
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
