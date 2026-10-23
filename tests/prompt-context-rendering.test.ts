import { expect, test } from "bun:test";
import {
  chatGptPromptJsonBytes, compileChatGptWebPrompt,
} from "../src/adapters/chatgpt-web/prompt";
import { decodeWebContextPayload } from "../src/adapters/chatgpt-web/context-renderer";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { estimateTokens } from "../src/lib/token-estimate";
import { resolveChatGptWebMessageTokenBudget, resolveChatGptWebTransportLimits } from "../src/chatgpt-web-models";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const token = `turn_${"a".repeat(32)}`;
const body = 'const quote = "C:\\source\\file";const escaped = "\\n";'.repeat(180);
function request(content = body): CodexParsedRequest {
  return { modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" }, context: {
    systemPrompt: ["Original system authority."], messages: [{ role: "user", content, timestamp: 1 }],
  } };
}

test("single input compares complete costs and records its exact selected payload", () => {
  const parsed = request();
  const legacy = compileChatGptWebPrompt(parsed, capabilities, token, { contextRendering: "legacy-json" });
  const mixed = compileChatGptWebPrompt(parsed, capabilities, token, { contextRendering: "codex-context-text-v1" });
  const auto = compileChatGptWebPrompt(parsed, capabilities, token);
  expect(auto.contextFormat).toBe("codex-context-text-v1");
  expect(auto.text).toBe(mixed.text);
  expect(estimateTokens(mixed.text)).toBeLessThan(estimateTokens(legacy.text));
  expect(chatGptPromptJsonBytes(mixed.text)).toBeLessThanOrEqual(chatGptPromptJsonBytes(legacy.text));
  expect(decodeWebContextPayload(mixed.contextPayload!).context).toEqual(decodeWebContextPayload(legacy.contextPayload!).context);
  expect(auto.text).not.toContain("<codex_context_json>");
  expect(auto.text).toContain("raw_fields");
  expect(compileChatGptWebPrompt(request("OK"), capabilities, token).contextFormat).toBe("legacy-json");
});

test("a beneficial field cannot override complete-envelope losses", () => {
  // One field can repay its descriptor while the new package's common instructions still cost more.
  const samples = [4, 8, 12, 16, 20, 24, 28].map(count => '"\\'.repeat(count * 10));
  let covered = false;
  for (const source of samples) {
    const parsed = request(source);
    const legacy = compileChatGptWebPrompt(parsed, capabilities, token, { contextRendering: "legacy-json" });
    const mixed = compileChatGptWebPrompt(parsed, capabilities, token, { contextRendering: "codex-context-text-v1" });
    if (mixed.contextPayload!.includes('"raw_fields"') && estimateTokens(mixed.text) >= estimateTokens(legacy.text)) {
      expect(compileChatGptWebPrompt(parsed, capabilities, token).contextFormat).toBe("legacy-json");
      covered = true;
      break;
    }
  }
  expect(covered).toBe(true);
});

test("cleanup is shared across renderers and keeps the active credential outside source data", () => {
  const parsed = request(body + ` old ${token} request_${"b".repeat(32)} binding_${"c".repeat(32)}`);
  parsed.context.messages.unshift({ role: "assistant", content: [
    { type: "toolCall", id: `call_${"d".repeat(32)}`, name: "exec", arguments: { command: body } },
  ], timestamp: 0 });
  const legacy = compileChatGptWebPrompt(parsed, capabilities, token, { contextRendering: "legacy-json" });
  const mixed = compileChatGptWebPrompt(parsed, capabilities, token, { contextRendering: "codex-context-text-v1" });
  expect(decodeWebContextPayload(mixed.contextPayload!).context).toEqual(decodeWebContextPayload(legacy.contextPayload!).context);
  expect(mixed.contextPayload).not.toContain(token);
  expect(mixed.text.match(new RegExp(token, "g"))).toHaveLength(1);
  expect(mixed.contextPayload).toContain(`call_${"d".repeat(32)}`);
  expect(mixed.contextPayload).toContain("[retired turn handle]");
});

test("inline renderers escape code spans and preserve source semantics", () => {
  const parsed = request(body + " ``` ```` ````````  ```text");
  const original = structuredClone(parsed);
  for (const format of ["legacy-json", "codex-context-text-v1"] as const) {
    const compiled = compileChatGptWebPrompt(parsed, capabilities, token, { contextRendering: format });
    expect(compiled.contextPayload).not.toContain("`");
    const records = decodeWebContextPayload(compiled.contextPayload!, format).records;
    expect(records.find(record => record.kind === "message")!.message.content).toBe(parsed.context.messages[0]!.content);
    expect(compiled.text).toMatch(/\n```(?:text|json)\n/);
    expect(compiled.text).not.toMatch(/\n +```(?:text|json)\n/);
    expect(parsed).toEqual(original);
  }
});

test("unverified whitespace and mismatched evidence cannot enable raw text", () => {
  const parsed = request(body + "\n\t  \n");
  const compiled = compileChatGptWebPrompt(parsed, capabilities, token, { contextRendering: "codex-context-text-v1" });
  expect(compiled.contextPayload).not.toContain('"raw_fields"');
  expect(decodeWebContextPayload(compiled.contextPayload!).context!.messages[0]!.content).toBe(parsed.context.messages[0]!.content);
  expect(() => compileChatGptWebPrompt(parsed, capabilities, token, {
    contextRawTextPolicy: { verifiedPath: "zero-risk", evidence: "unit-test mismatched path fixture", allowLf: true },
  })).toThrow("different input path");
});

test("only-mixed capacity preserves the complete selected input", () => {
  const parsed = request("\\".repeat(64_000));
  parsed.options.reasoning = "low";
  const plus = { ...capabilities, proAvailable: false };
  const legacy = compileChatGptWebPrompt(parsed, plus, token, { contextRendering: "legacy-json" });
  const compiled = compileChatGptWebPrompt(parsed, plus, token);
  const chars = resolveChatGptWebTransportLimits(CHATGPT_WEB_MODEL_ID, "low", plus).browserComposerCharLimit!;
  const tokens = resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_MODEL_ID, "low", plus);
  expect(estimateTokens(legacy.text)).toBeGreaterThan(tokens);
  expect(compiled.contextFormat).toBe("codex-context-text-v1");
  expect(compiled.text.length).toBeLessThan(chars);
  expect(estimateTokens(compiled.text)).toBeLessThan(tokens);
  expect(decodeWebContextPayload(compiled.contextPayload!).context).toEqual(decodeWebContextPayload(legacy.contextPayload!).context);
});
