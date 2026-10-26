import { expect, test } from "bun:test";
import { estimateChatGptWebInputTokens, estimateChatGptWebUsage } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import type { CodexParsedRequest } from "../src/types";
import { parseRequest } from "../src/responses/parser";
import { planContextDelivery } from "../src/adapters/chatgpt-web/context-planner";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import type { ContextReuseBaseline } from "../src/adapters/chatgpt-web/context-reuse-types";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test("context diagnostics separate instructions from history without logging contents", () => {
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    instructions: "PRIVATE_SYSTEM top-level instructions ".repeat(100),
    input: [
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "PRIVATE_TOOL", parameters: { type: "object" } }] },
      { type: "message", role: "developer", content: "PRIVATE_DEVELOPER instructions" },
      { type: "message", role: "user", content: "PRIVATE_USER request" },
      { type: "message", role: "assistant", content: "PRIVATE_ANSWER" },
      { type: "function_call_output", call_id: "PRIVATE_CALL", output: "PRIVATE_RESULT" },
    ],
    reasoning: { effort: "high" },
  });
  const options = {};
  const plain = compileChatGptWebPrompt(parsed, capabilities, undefined, options);
  const measured = compileChatGptWebPrompt(parsed, capabilities, undefined, { ...options, includeContextTokenBreakdown: true });
  const { contextTokenBreakdown: counts, ...prompt } = measured;
  expect(prompt).toEqual(plain);
  expect(estimateCompiledChatGptWebInputTokens(measured, parsed.modelId))
    .toBe(estimateCompiledChatGptWebInputTokens(plain, parsed.modelId));
  expect(Object.keys(counts!).sort()).toEqual(["assistant", "developer", "system", "tool_result", "user"]);
  expect(counts!.developer!.records).toBe(1); // additional_tools is a registry, not a developer message.
  expect(counts!.system!.tokens).toBeGreaterThan(counts!.user!.tokens);
  expect(JSON.stringify(counts)).not.toContain("PRIVATE");
  const { sanitizeForExport } = require("../launcher/electron/logging.cjs");
  const logLine = `[chatgpt-web] context_token_breakdown ${JSON.stringify({ byRole: counts })}`;
  expect(sanitizeForExport(logLine)).toBe(logLine);
  for (const group of Object.values(counts!)) {
    expect(Object.keys(group).sort()).toEqual(["chars", "records", "tokens"]);
    expect(group.records).toBe(1);
    expect(group.tokens).toBeGreaterThan(0);
  }
});


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

test("short-start diagnostics count current records while reused rules stay on the page", () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", instructions: "Keep the measured task constraints.\n".repeat(700),
    input: [{ type: "message", role: "user", id: "measured_user", content: "Continue the requested work." }] });
  const prepare = (reuseBaseline?: ContextReuseBaseline) => planContextDelivery({ canonical: parsed, candidate: parsed,
    snapshot: createContextSnapshot(parsed), capabilities: { ...capabilities, localToolsEnabled: true },
    contextToolsAvailable: true, contextReuseAvailable: true, turnToken: `turn_${"7".repeat(32)}`,
    compileOptions: { includeContextTokenBreakdown: true }, ...(reuseBaseline ? { reuseBaseline } : {}) });
  const first = prepare();
  expect(first.compiled.contextTokenBreakdown!.system!.tokens).toBeGreaterThan(1000);
  const reuse = first.registration!.reuse!;
  const second = prepare({ baseline_id: "measured_baseline", page_identity: "measured_page", predecessor: "measured_head",
    units: reuse.units.map(({ delivery: _delivery, target_id: _target, ...unit }) => unit), snapshots: reuse.snapshots });
  expect(second.registration!.reuse!.mode).toBe("incremental");
  expect(second.compiled.contextTokenBreakdown).not.toHaveProperty("system");
  expect(second.compiled.contextTokenBreakdown!.user!.records).toBe(1);
});
