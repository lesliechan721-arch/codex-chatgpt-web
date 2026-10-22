import { expect, spyOn, test } from "bun:test";
import { estimateChatGptWebInputTokens, estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import * as promptModule from "../src/adapters/chatgpt-web/prompt";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";
import { resolveChatGptWebMessageTokenBudget, resolveChatGptWebStagingTokenBudget } from "../src/chatgpt-web-models";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test("usage counts the configured plugin name carried by the submitted prompt", () => {
  const parsed = request("Inspect the repository.");
  const caps = { ...capabilities, localToolsEnabled: true };
  const appName = `Codex ${"測試_".repeat(16)}`;
  const token = `turn_${"0".repeat(32)}`;
  const compiled = compileChatGptWebPrompt(parsed, caps, token, { appName });
  const expected = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
  expect(expected).not.toBe(estimateChatGptWebInputTokens(parsed, caps));
  for (const biggerContext of [false, true]) {
    expect(estimateChatGptWebUsage(parsed, {}, caps, biggerContext, false, appName).inputTokens).toBe(expected);
  }
});

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test.each([
  ["small inline input", ["small task"], undefined],
  ["whole-record token pressure", [50_000, 40_000, 50_000, 5_000].map(n => "word ".repeat(n)), 6],
  // Any two whole records exceed the 500k composer limit; one still fits a stage.
  ["whole-record composer pressure", Array.from({ length: 3 }, () => " ".repeat(260_000)), 6],
] as const)("%s multipart selection accounts for whole-record and composer fit before submission", (_label, contents, expected) => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed.context.messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
  const originalCompile = promptModule.compileChatGptWebPrompt;
  let twoPartFailure: unknown;
  const probe = spyOn(promptModule, "compileChatGptWebPrompt").mockImplementation((input, caps, token, options) => {
    try { return originalCompile(input, caps, token, options); }
    catch (error) {
      if (options?.experimentalMultipartParts === 2) twoPartFailure = error;
      throw error;
    }
  });
  let parts: 2 | 6 | undefined;
  try { parts = resolveBiggerContextMultipartParts(parsed, plus); }
  finally { probe.mockRestore(); }
  expect(parts).toBe(expected);
  if (expected === 6) {
    expect(twoPartFailure).toBeInstanceOf(ChatGptWebAdapterError);
    expect((twoPartFailure as ChatGptWebAdapterError).code).toBe("context_length_exceeded");
  }
  const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
  if (parts) {
    expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
      .toEqual([...contents]);
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text, parsed.modelId));
    const chars = messages.map(text => text.length);
    const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
    const maxStageChars = Math.max(...chars.slice(0, -1));
    const staging = resolveChatGptWebMultipartStagingMode(parsed.modelId, plus, maxStageMessageTokens, maxStageChars);
    expect(() => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...tokens), parsed.modelId,
      "high", plus, Math.max(...chars), parts,
      { stagingEffort: staging.effort, maxStageMessageTokens, maxStageChars,
        finalMessageTokens: tokens.at(-1)!, finalMessageChars: chars.at(-1)!,
        finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    )).not.toThrow();
  }
}, 60_000);

test("multipart selection stages sparse Pro input without dropping its complete record", () => {
  // Low-token text can still exceed the reasoning model's server character ceiling.
  // Stage the complete record instead of sending it inline or dropping its contents.
  const sparsePro = request("x".repeat(600_000));
  expect(resolveBiggerContextMultipartParts(sparsePro, capabilities)).toBe(2);
  const stagedPro = compileChatGptWebPrompt(sparsePro, capabilities, undefined, { experimentalMultipartParts: 2 });
  expect(stagedPro.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([sparsePro.context.messages[0]!.content]);
  const proMessages = compiledChatGptWebMessages(stagedPro);
  expect(proMessages[1]!.length).toBeLessThanOrEqual(500_000);
  expect(resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-sol", capabilities, estimateTokens(proMessages[0]!), proMessages[0]!.length,
  ).effort).toBe("max");
}, 30_000);

test("multipart selection propagates non-capacity errors from the two-part probe", () => {
  const parsed = request("x".repeat(600_000));
  const originalCompile = promptModule.compileChatGptWebPrompt;
  for (const failure of [
    new Error("Context preparation failed"),
    new ChatGptWebAdapterError("Invalid context format", {
      status: 400, errorType: "invalid_request_error", code: "invalid_context_format", retryable: false,
    }),
    Object.assign(new Error("Unrelated error with a capacity-like code"), { code: "context_length_exceeded" }),
  ]) {
    const compile = spyOn(promptModule, "compileChatGptWebPrompt").mockImplementation((input, caps, token, options) => {
      if (options?.experimentalMultipartParts === 2) throw failure;
      return originalCompile(input, caps, token, options);
    });
    try {
      let observed: unknown;
      try { resolveBiggerContextMultipartParts(parsed, capabilities); }
      catch (error) { observed = error; }
      expect(observed).toBe(failure);
      expect(compile.mock.calls.some(([, , , options]) => options?.experimentalMultipartParts === 2)).toBe(true);
      expect(compile.mock.calls.some(([, , , options]) => options?.experimentalMultipartParts === 6)).toBe(false);
    } finally {
      compile.mockRestore();
    }
  }
}, 30_000);

test("Bigger Context compaction selects six parts before the legacy inline byte budget", () => {
  const parsed = request("x".repeat(160_000));
  parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(6);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([parsed.context.messages[0]!.content]);
});

test("unified tasks keep supported Bigger Context staging and canonical usage", () => {
  for (const compaction of [false, true]) {
    const parsed = request(compaction ? "Summarize the task." : "word ".repeat(100_000));
    parsed._compactionRequest = compaction;
    parsed._conversationPolicy = "recoverable";
    const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
    const usage = estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities, true);
    expect(parts).toBeDefined();
    parsed._conversationPolicy = "task";
    expect(resolveBiggerContextMultipartParts(parsed, capabilities)).toBe(parts);
    expect(estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities, true)).toEqual(usage);
  }
});

test("GPT-6 Sol stages complete Plus and Pro history with consistent usage accounting", () => {
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 4 }, (_, index) => ({
    role: "user", content: `record-${index}: ${"word ".repeat(24_000)}`, timestamp: index + 1,
  }));
  const original = structuredClone(parsed);
  for (const proAvailable of [false, true]) {
    const caps = { ...capabilities, proAvailable };
    const parts = resolveBiggerContextMultipartParts(parsed, caps);
    expect(parts).toBe(2);
    const staged = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts });
    expect(staged.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
      .toEqual(parsed.context.messages.map(message => message.content));
    expect(estimateChatGptWebUsage(parsed, { answer: "done" }, caps, true).inputTokens)
      .toBe(estimateCompiledChatGptWebInputTokens(staged, parsed.modelId));
    expect(parsed).toEqual(original);
  }
}, 30_000);

test("GPT-6 compaction respects the selected account and effort", () => {
  const parsed = { ...request("Summarize this task."), _chatgptModelFamily: "6" as const, _compactionRequest: true };
  for (const proAvailable of [false, true]) {
    const caps = { ...capabilities, proAvailable };
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      parsed.options.reasoning = effort;
      const supported = effort !== "low";
      const parts = resolveBiggerContextMultipartParts(parsed, caps);
      if (supported) {
        expect(parts).toBe(6);
        expect(compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts }).multipart!.parts).toHaveLength(6);
      } else {
        expect(parts).toBeUndefined();
        expect(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, true))
          .toEqual(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, false));
        expect(() => compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 }))
          .toThrow("GPT-6 Instant uses standard context");
      }
    }
  }
  parsed.options.reasoning = "max";
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(6);
  expect(compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts }).multipart!.parts).toHaveLength(6);
});

test("GPT-6 six-part planning preserves input while the browser enforces the measured total window", () => {
  for (const [recordTokens, accepted] of [[44_000, true], [48_000, false]] as const) {
    const parsed = request("");
    parsed._chatgptModelFamily = "6";
    parsed.context.messages = Array.from({ length: 5 }, (_, index) => ({
      role: "user", content: `record-${index}: ${"word ".repeat(recordTokens)}`, timestamp: index + 1,
    }));
    const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
    expect(parts).toBe(6);
    const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
    expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
      .toEqual(parsed.context.messages.map(message => message.content));
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text, parsed.modelId));
    const chars = messages.map(text => text.length);
    const inputTokens = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
    const transport = {
      stagingEffort: "max" as const,
      maxStageMessageTokens: Math.max(...tokens.slice(0, -1)),
      maxStageChars: Math.max(...chars.slice(0, -1)),
      finalMessageTokens: tokens.at(-1)!, finalMessageChars: chars.at(-1)!,
    };
    const assertWindow = (modelFamily: "5.6" | "6", totalTokens = inputTokens) => assertChatGptWebMultipartInputWithinLimits(
      totalTokens, Math.max(...tokens), parsed.modelId, "high", capabilities,
      Math.max(...chars), parts!, transport, modelFamily,
    );
    expect(inputTokens).toBeGreaterThan(220_000);
    if (accepted) {
      expect(inputTokens).toBeLessThan(240_000);
      expect(assertWindow("6")).toBeUndefined();
      expect(assertWindow("6", 239_999)).toBeUndefined();
      expect(() => assertWindow("6", 240_000)).toThrow("240,000-token");
    } else {
      expect(inputTokens).toBeGreaterThan(240_000);
      expect(() => assertWindow("6")).toThrow("240,000-token");
      expect(assertWindow("5.6")).toBeUndefined();
    }
  }
}, 30_000);

test("Plus history is rebalanced into smaller Instant uploads and a larger selected-mode final message", () => {
  const plus = { ...capabilities, proAvailable: false, extraHighAvailable: false };
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 60 }, (_, index) => ({
    role: "user", content: `record-${index}: ${"word ".repeat(3000)}`, timestamp: index + 1,
  }));
  for (const compaction of [false, true]) {
    parsed._compactionRequest = compaction;
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: 6 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message.content)).toEqual(parsed.context.messages.map(message => message.content));
    expect(compiled.trimmedCompactionMessages).toBeUndefined();
    const messages = compiledChatGptWebMessages(compiled);
    const stagingTokens = messages.slice(0, -1).map(text => estimateTokens(text));
    const stagingBudget = resolveChatGptWebStagingTokenBudget("gpt-5.6-sol", "low", plus);
    expect(Math.max(...stagingTokens)).toBeLessThanOrEqual(stagingBudget);
    expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus,
      Math.max(...stagingTokens), Math.max(...messages.slice(0, -1).map(text => text.length))).effort).toBe("low");
    const finalTokens = estimateTokens(messages.at(-1)!);
    expect(finalTokens).toBeGreaterThan(Math.max(...stagingTokens));
    expect(finalTokens).toBeLessThanOrEqual(resolveChatGptWebMessageTokenBudget("gpt-5.6-sol", "high", plus));
  }
}, 30_000);

test("multipart planning leaves room for final attachments and execution instructions without losing history", () => {
  for (const scenario of [
    { extraHighAvailable: false, proAvailable: false, images: 3, schema: false },
    { extraHighAvailable: true, proAvailable: true, images: 10, schema: false },
    { extraHighAvailable: false, proAvailable: false, images: 0, schema: true },
  ]) {
    const caps = { ...capabilities, proAvailable: scenario.proAvailable };
    const parsed = request("");
    const texts = Array.from({ length: 36 }, (_, index) => `record ${index}: ${"word ".repeat(5_000)}`);
    parsed.context.messages = texts.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const images = Array.from({ length: scenario.images }, (_, index) => ({
      type: "image" as const, imageUrl: `data:image/png;base64,partition-image-${index}`, detail: "original" as const,
    }));
    if (images.length) parsed.context.messages.push({ role: "user", content: images, timestamp: 37 });
    if (scenario.schema) parsed.options.outputFormat = {
      type: "json_schema", name: "result", strict: true, schema: { type: "string", description: "schema ".repeat(24_000) },
    };
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message_index)).toEqual(parsed.context.messages.map((_, index) => index));
    expect(records.slice(0, texts.length).map(record => record.message.content)).toEqual(texts);
    expect(compiled.images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })))
      .toEqual(images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })));
    if (scenario.schema) expect(compiled.multipart!.commit).toContain(JSON.stringify(parsed.options.outputFormat!.schema));
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text));
    const chars = messages.map(text => text.length);
    const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
    const maxStageChars = Math.max(...chars.slice(0, -1));
    const stage = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
    expect(() => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...tokens),
      parsed.modelId, "high", caps, Math.max(...chars), 6,
      { stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens: tokens.at(-1)!, finalMessageChars: chars.at(-1)!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    )).not.toThrow();
  }
}, 30_000);
