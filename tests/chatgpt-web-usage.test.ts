import { expect, test } from "bun:test";
import { estimateChatGptWebInputTokens, estimateChatGptWebUsage } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import type { CodexParsedRequest } from "../src/types";

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
  expect(estimateChatGptWebUsage(parsed, {}, caps, false, appName).inputTokens).toBe(expected);
});

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("Full compaction reports complete canonical history instead of its short read-only prompt", () => {
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 6 }, (_, index) => ({
    role: "user", content: `record ${index}: ${"word ".repeat(32_000)}`, timestamp: index,
  }));
  const caps = { ...capabilities, localToolsEnabled: true };
  const before = structuredClone(parsed);
  const ordinary = estimateChatGptWebUsage(parsed, { answer: "summary" }, caps);
  parsed._compactionRequest = true;
  const compaction = estimateChatGptWebUsage(parsed, { answer: "summary" }, caps);
  expect(compaction).toEqual(ordinary);
  expect(compaction.inputTokens).toBeGreaterThan(192_000);
  delete parsed._compactionRequest;
  expect(parsed).toEqual(before);
}, 15_000);

test("task and recoverable routes report the same complete history", () => {
  const parsed = request("word ".repeat(100_000));
  const caps = { ...capabilities, localToolsEnabled: true };
  parsed._conversationPolicy = "recoverable";
  const recoverable = estimateChatGptWebUsage(parsed, { answer: "done" }, caps);
  parsed._conversationPolicy = "task";
  expect(estimateChatGptWebUsage(parsed, { answer: "done" }, caps)).toEqual(recoverable);
});
