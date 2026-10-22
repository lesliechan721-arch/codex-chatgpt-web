import { beforeAll, describe, expect, test } from "bun:test";
import {
  CHATGPT_ZERO_RISK_CONTINUITY_INPUT_CHAR_LIMIT, chatGptPromptJsonBytes, compileChatGptWebPrompt,
} from "../src/adapters/chatgpt-web/prompt";
import { decodeWebContextPayload } from "../src/adapters/chatgpt-web/context-renderer";
import { ZERO_RISK_CHATGPT_CONNECTOR_NAME } from "../src/config";
import { assertContinuityCompiledInput } from "../src/adapters/chatgpt-web/continuity-input";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";
import {
  activeCompactionToolResultInstruction,
  zeroRiskActiveCompactionToolResultInstruction,
} from "../src/adapters/chatgpt-web/native-compaction-control";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: false, extraHighAvailable: false, proAvailable: false };
const requestId = "request_12345678901234567890123456789012";

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: "chatgpt-web-zero-risk",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "Inspect the repository and fix the defect.", timestamp: 1 }],
      tools: [{
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    },
    ...(compaction ? { _compactionRequest: true } : {}),
  };
}

test("Zero Risk prompt carries only a neutral request id while MCP metadata owns its lifecycle", () => {
  const compiled = compileChatGptWebPrompt(request(), capabilities, requestId, {
    manualControl: true,
  });
  expect(compiled.multipart).toBeUndefined();
  expect(compiled.text).toContain(`The selected local Codex plugin for this turn is ${JSON.stringify(ZERO_RISK_CHATGPT_CONNECTOR_NAME)}.`);
  expect(compiled.text).toContain("<codex_zero_risk_request_json>");
  expect(compiled.text).toContain(`\"request_id\":\"${requestId}\"`);
  expect(compiled.text).not.toContain("turn_token");
  expect(compiled.text).not.toContain("surface_nonce");
  expect(compiled.text).not.toContain("Before reasoning");
  expect(compiled.text).not.toContain("ordinary assistant text");
  expect(compiled.text).not.toContain("exactly once");
  expect(compiled.text).not.toContain("codex_turn_start");
  expect(compiled.text).not.toContain("codex_turn_complete");
  expect(compiled.text).not.toContain("ChatGPT Web Medium with no local Codex bridge");
});

test("custom Zero Risk plugin is named in normal and compaction requests without automatic turn tokens", () => {
  for (const compaction of [false, true]) {
    const compiled = compileChatGptWebPrompt(request(compaction), capabilities, requestId, {
      manualControl: true, appName: "Codex Manual Work",
    });
    expect(compiled.text).toContain('The selected local Codex plugin for this turn is "Codex Manual Work".');
    expect(compiled.text).not.toContain("Codex Native");
    expect(compiled.text).not.toContain("turn_token");
    expect(compiled.text).toContain(`"request_id":"${requestId}"`);
  }
});

test("Zero Risk compaction prompt stays task-focused while MCP metadata owns completion", () => {
  const compiled = compileChatGptWebPrompt(request(true), capabilities, requestId, {
    manualControl: true,
  });
  expect(compiled.text).toContain("This is a Codex history-compaction checkpoint");
  expect(compiled.text).toContain("Do not call work tools or ChatGPT-native tools");
  expect(compiled.text).toContain("Produce the requested checkpoint summary now");
  expect(compiled.text).not.toContain("codex_turn_start");
  expect(compiled.text).not.toContain("codex_turn_complete");
});

test("Zero Risk read-only compaction permits MCP startup before source navigation", () => {
  const compiled = compileChatGptWebPrompt(request(true), capabilities, requestId, {
    manualControl: true,
    compactionReadOnly: true,
  });
  expect(compiled.text).toContain("Complete the original Zero Risk startup control from the MCP metadata before reading compaction sources.");
  expect(compiled.text).toContain("Then use only the three context reading tools with the independent compaction credential and the original checkpoint completion control.");
  expect(compiled.text).toContain("Do not execute business or ChatGPT-native tools.");
  expect(compiled.text).toContain(`\"request_id\":\"${requestId}\"`);
  expect(compiled.text).not.toContain("codex_turn_start");
  expect(compiled.text).not.toContain("codex_turn_complete");
});

test("Zero Risk prompt fails closed without Full harness or an exact manual binding", () => {
  expect(() => compileChatGptWebPrompt(request(), { ...capabilities, localToolsEnabled: false }, requestId, {
    manualControl: true,
  })).toThrow("requires the Full Codex harness");
  expect(() => compileChatGptWebPrompt(request(), capabilities, undefined, {
    manualControl: true,
  })).toThrow("requires a broker request id");
  expect(() => compileChatGptWebPrompt(request(), capabilities, requestId, {
    manualControl: true,
    experimentalMultipartParts: 2,
  })).toThrow("does not support rolling or multipart browser transport");
});

test("active Zero Risk compaction returns its checkpoint through the bound completion control", () => {
  const automatic = activeCompactionToolResultInstruction();
  const safe = zeroRiskActiveCompactionToolResultInstruction(true);

  expect(automatic).toContain("separate structured compaction handoff request");
  expect(automatic.toLowerCase()).toContain("call no more tools");
  expect(automatic).not.toContain("codex_turn_complete");
  expect(safe).toContain("codex_turn_complete");
  expect(safe).toContain("Return only the complete checkpoint summary to Codex");
  expect(safe).toContain("CONTEXT CHECKPOINT COMPACTION");
  expect(safe).not.toContain("separate structured compaction handoff request");
});

test("Zero Risk uses the same rendering selection while preserving its manual lifecycle and credential", () => {
  const input = request();
  const text = 'const path = "C:\\source\\file";'.repeat(400);
  input.context.messages[0]!.content = text;
  const compiled = compileChatGptWebPrompt(input, capabilities, requestId, { manualControl: true });
  expect(compiled.contextFormat).toBe("codex-context-text-v1");
  expect(decodeWebContextPayload(compiled.contextPayload!).context!.messages[0]!.content).toBe(text);
  expect(compiled.text).toContain(`"request_id":"${requestId}"`);
  expect(compiled.multipart).toBeUndefined();
  expect(compiled.text).not.toContain("turn_token");
  const whitespace = compileChatGptWebPrompt({ ...input, context: { ...input.context, messages: [
    { role: "user", content: text + "\n\t  ", timestamp: 1 },
  ] } }, capabilities, requestId, { manualControl: true });
  expect(whitespace.contextFormat).toBe("legacy-json");
});

test.each([
  ["Zero Risk both-fit", "chatgpt-web-zero-risk", false, 60_000, true],
  ["Zero Risk only-mixed-fit", "chatgpt-web-zero-risk", false, 105_000, false],
  ["Zero Risk Pro both-fit", "chatgpt-web-zero-risk-pro", true, 150_000, true],
  ["Zero Risk Pro only-mixed-fit", "chatgpt-web-zero-risk-pro", true, 318_000, false],
] as const)("%s complete rendering uses its selected window", (_label, modelId, proAvailable, words, legacyFits) => {
  const input = request();
  input.modelId = modelId;
  input.context.messages[0]!.content = "x ".repeat(words) + '"\\'.repeat(5_000) + "done";
  const original = structuredClone(input);
  const caps = { ...capabilities, proAvailable };
  const legacy = compileChatGptWebPrompt(input, caps, requestId, { manualControl: true, contextRendering: "legacy-json" });
  const mixed = compileChatGptWebPrompt(input, caps, requestId, { manualControl: true, contextRendering: "codex-context-text-v1" });
  const auto = compileChatGptWebPrompt(input, caps, requestId, { manualControl: true });
  const { contextWindow } = resolveChatGptWebContextLimits(modelId, "low", caps);
  const legacyTokens = estimateCompiledChatGptWebInputTokens(legacy, modelId);
  const mixedTokens = estimateCompiledChatGptWebInputTokens(mixed, modelId);
  expect(mixedTokens).toBeLessThan(legacyTokens);
  expect(mixedTokens).toBeLessThan(contextWindow);
  expect(chatGptPromptJsonBytes(mixed.text)).toBeLessThanOrEqual(chatGptPromptJsonBytes(legacy.text));
  if (legacyFits) {
    expect(legacyTokens).toBeLessThan(contextWindow);
    expect(() => assertContinuityCompiledInput(legacy, input, caps)).not.toThrow();
  } else {
    expect(legacyTokens).toBeGreaterThanOrEqual(contextWindow);
    expect(() => assertContinuityCompiledInput(legacy, input, caps)).toThrow();
  }
  expect(() => assertContinuityCompiledInput(mixed, input, caps)).not.toThrow();
  expect(auto.contextFormat).toBe("codex-context-text-v1");
  expect(auto.text).toBe(mixed.text);
  expect(() => assertContinuityCompiledInput(auto, input, caps)).not.toThrow();
  expect(decodeWebContextPayload(auto.contextPayload!).context)
    .toEqual(decodeWebContextPayload(legacy.contextPayload!).context);
  expect(auto.multipart).toBeUndefined();
  expect(auto.trimmedCompactionMessages).toBeUndefined();
  expect(auto.text).toContain(`"request_id":"${requestId}"`);
  expect(input).toEqual(original);
}, 30_000);

describe("Zero Risk Pro original character boundary", () => {
  const caps = { ...capabilities, proAvailable: true };
  const charLimit = CHATGPT_ZERO_RISK_CONTINUITY_INPUT_CHAR_LIMIT;
  let input: CodexParsedRequest;
  let original: CodexParsedRequest;
  let legacy: ReturnType<typeof compileChatGptWebPrompt>;
  let mixed: ReturnType<typeof compileChatGptWebPrompt>;
  beforeAll(() => {
    const suffix = '"\\'.repeat(200);
    input = {
      modelId: "chatgpt-web-zero-risk-pro", stream: true, options: { reasoning: "low" },
      _conversationPolicy: "task",
      context: { messages: [{ role: "user", content: suffix, timestamp: 1 }] },
    };
    // Keep the exact original boundary even if surrounding instructions change. This bare input
    // intentionally has no system or tools; those additions change the full candidate's costs.
    const shortLegacy = compileChatGptWebPrompt(input, caps, requestId, { manualControl: true, contextRendering: "legacy-json" });
    input.context.messages[0]!.content = "a".repeat(charLimit - shortLegacy.text.length) + suffix;
    original = structuredClone(input);
    legacy = compileChatGptWebPrompt(input, caps, requestId, { manualControl: true, contextRendering: "legacy-json" });
    mixed = compileChatGptWebPrompt(input, caps, requestId, { manualControl: true, contextRendering: "codex-context-text-v1" });
  }, 30_000);

  test("continuity accepts and selects the exact legacy boundary while rejecting oversized mixed", () => {
    expect(charLimit).toBe(1_000_000);
    expect(legacy.text.length).toBe(charLimit);
    expect(mixed.text.length).toBeGreaterThan(charLimit);
    expect(chatGptPromptJsonBytes(mixed.text)).toBeLessThanOrEqual(chatGptPromptJsonBytes(legacy.text));
    expect(decodeWebContextPayload(mixed.contextPayload!).context)
      .toEqual(decodeWebContextPayload(legacy.contextPayload!).context);
    const auto = compileChatGptWebPrompt(input, caps, requestId, { manualControl: true });
    expect(auto.contextFormat).toBe("legacy-json");
    expect(auto.text).toBe(legacy.text);
    // Check production admission once per distinct candidate; auto is byte-identical to the
    // accepted legacy input, so it does not need another full-input tokenizer pass here.
    expect(() => assertContinuityCompiledInput(legacy, input, caps)).not.toThrow();
    let rejection: unknown;
    try { assertContinuityCompiledInput(mixed, input, caps); }
    catch (error) { rejection = error; }
    expect(rejection).toMatchObject({ code: "continuity_input_limit", retryable: false });
    expect(auto.multipart).toBeUndefined();
    expect(auto.trimmedCompactionMessages).toBeUndefined();
    expect(input).toEqual(original);
  }, 60_000);

  test("recoverable still selects the larger beneficial mixed candidate from the same source", () => {
    const recoverable = compileChatGptWebPrompt({ ...input, _conversationPolicy: "recoverable" }, caps, requestId, { manualControl: true });
    expect(recoverable.contextFormat).toBe("codex-context-text-v1");
    expect(recoverable.text).toBe(mixed.text);
    expect(input).toEqual(original);
  }, 30_000);
});

test.each([
  ["chatgpt-web-zero-risk", false, 105_000],
  ["chatgpt-web-zero-risk-pro", true, 318_000],
] as const)("%s rendering keeps the original image and platform reserves", (modelId, proAvailable, words) => {
  const input = request();
  input.modelId = modelId;
  input.context.messages[0]!.content = [
    { type: "text", text: "x ".repeat(words) + '"\\'.repeat(5_000) + "done" },
    { type: "image", imageUrl: "data:image/png;base64,window-reserve-fixture", detail: "original" },
  ];
  const caps = { ...capabilities, proAvailable };
  const mixed = compileChatGptWebPrompt(input, caps, requestId, { manualControl: true, contextRendering: "codex-context-text-v1" });
  const auto = compileChatGptWebPrompt(input, caps, requestId, { manualControl: true });
  const { contextWindow } = resolveChatGptWebContextLimits(modelId, "low", caps);
  expect(estimateCompiledChatGptWebInputTokens(mixed, modelId)).toBeGreaterThanOrEqual(contextWindow);
  expect(mixed.images).toHaveLength(1);
  expect(auto.contextFormat).toBe("legacy-json");
  expect(() => assertContinuityCompiledInput(mixed, input, caps)).toThrow();
  expect(() => assertContinuityCompiledInput(auto, input, caps)).toThrow();
  expect(auto.multipart).toBeUndefined();
}, 30_000);
