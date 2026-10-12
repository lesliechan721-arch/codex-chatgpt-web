import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chatGptPromptJsonBytes, compileChatGptWebPrompt, formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import { decodeWebContextPayload, decodeWebContextTransaction } from "../src/adapters/chatgpt-web/context-renderer";
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

test("two and six parts preserve complete records, fixed bytes, manifest and ACK hashes", () => {
  for (const count of [2, 6] as const) {
    const parsed = request();
    parsed.context.messages = Array.from({ length: 8 }, (_, index) => ({
      role: "user" as const, content: `record-${index} ` + body, timestamp: index,
    }));
    const options = { experimentalMultipartParts: count, contextRendering: "codex-context-text-v1" as const };
    const compiled = compileChatGptWebPrompt(parsed, capabilities, token, options);
    expect(compiled.multipart!.parts).toHaveLength(count);
    const decoded = decodeWebContextTransaction(compiled.multipart!.parts, compiled.contextFormat);
    expect(decoded.filter(record => record.kind === "message").map(record => record.message.content))
      .toEqual(parsed.context.messages.map(message => message.content));
    const transaction = `ctx_${"f".repeat(32)}`;
    const commit = formatChatGptWebMultipartCommit(compiled.multipart!, transaction);
    expect(commit.match(new RegExp(token, "g"))).toHaveLength(1);
    for (const [index, payload] of compiled.multipart!.parts.entries()) {
      const sha = createHash("sha256").update(payload, "utf8").digest("hex");
      expect(commit).toContain(`${index + 1}/${count}:${sha}`);
      if (index === count - 1) continue;
      const first = formatChatGptWebMultipartStage(payload, transaction, index + 1, count);
      const retry = formatChatGptWebMultipartStage(payload, transaction, index + 1, count);
      expect(first).toEqual(retry);
      expect(first.sha256).toBe(sha);
      expect(first.acknowledgement).toBe(`CODEX_MULTIPART_ACK ${transaction} ${index + 1}/${count} ${sha}`);
      expect(first.text).toContain("The later commit has not been sent yet");
      expect(first.text).toContain("<codex_context_part_text>");
      expect(first.text).not.toContain("<codex_context_part_json>");
      expect(first.text).not.toContain(token);
    }
    expect(compileChatGptWebPrompt(parsed, capabilities, token, options).multipart!.parts).toEqual(compiled.multipart!.parts);
  }
});

test("fences exceed embedded backtick runs and never gain indentation", () => {
  const parsed = request(body + " ``` ```` ````````  ```text");
  for (const format of ["legacy-json", "codex-context-text-v1"] as const) {
    const compiled = compileChatGptWebPrompt(parsed, capabilities, token, { contextRendering: format });
    expect(compiled.text).toContain("\n`````````text\n");
    expect(compiled.text).not.toContain("\n  `````````text\n");
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

test("format-forcing cannot split oversized records or admit an invalid multipart header", () => {
  const parsed = request("x ".repeat(140_000));
  const plus = { ...capabilities, proAvailable: false };
  for (const format of ["legacy-json", "codex-context-text-v1"] as const) {
    expect(() => compileChatGptWebPrompt(parsed, plus, token, { experimentalMultipartParts: 2, contextRendering: format })).toThrow();
  }
  expect(() => formatChatGptWebMultipartStage('{"context":"unknown"}', `ctx_${"0".repeat(32)}`, 1, 2)).toThrow();
  const source = compileChatGptWebPrompt(request("OK"), capabilities, token, { experimentalMultipartParts: 2 });
  expect(() => formatChatGptWebMultipartStage(source.multipart!.parts[0]!, `ctx_${"0".repeat(32)}`, 2, 2)).toThrow();
}, 30_000);

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
