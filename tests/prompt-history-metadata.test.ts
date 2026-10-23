import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { decodeWebContextPayload } from "../src/adapters/chatgpt-web/context-renderer";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const turnToken = "turn_12345678901234567890123456789012";

function parsed(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    options: { reasoning: "high" },
    context: {
      messages: [
        {
          role: "assistant",
          phase: "commentary",
          content: [
            { type: "text", text: "I am checking the external state first." },
            {
              type: "toolCall",
              id: "call_1",
              name: "lookup",
              namespace: "mcp__inventory",
              arguments: { sku: "A-1" },
            },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "lookup",
          toolNamespace: "mcp__inventory",
          content: "in stock",
          isError: false,
          timestamp: 2,
        },
        {
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "text", text: "The item is in stock." }],
          timestamp: 3,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Legacy phase-less assistant history." }],
          timestamp: 4,
        },
      ],
    },
  };
}

function inlineEnvelope(text: string): Record<string, unknown> {
  const match = text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/);
  if (!match?.[1]) throw new Error("inline Codex context JSON missing");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

test("inline Web context preserves assistant phase and MCP namespace metadata", () => {
  const compiled = compileChatGptWebPrompt(parsed(), capabilities, turnToken);
  const envelope = inlineEnvelope(compiled.text) as { messages: Array<Record<string, unknown>> };
  expect(envelope.messages[0]?.phase).toBe("commentary");
  expect((envelope.messages[0]?.content as Array<Record<string, unknown>>)[1]?.namespace).toBe("mcp__inventory");
  expect(envelope.messages[1]?.tool_namespace).toBe("mcp__inventory");
  expect(envelope.messages[2]?.phase).toBe("final_answer");
  expect(envelope.messages[3]).not.toHaveProperty("phase");
});

test("mixed inline context preserves metadata, false, absent fields and content-block order", () => {
  const input = parsed();
  const source = '"long\\code";'.repeat(400);
  const assistant = input.context.messages[0]!;
  if (assistant.role !== "assistant") throw new Error("assistant fixture required");
  assistant.content.push({ type: "text", text: source }, { type: "thinking", thinking: source });
  input.context.messages.push({ role: "agentMessage", author: "writer", recipient: "coordinator", content: source, timestamp: 5 });
  const legacy = compileChatGptWebPrompt(input, capabilities, turnToken, { contextRendering: "legacy-json" });
  const expected = decodeWebContextPayload(legacy.contextPayload!).records;
  {
    const compiled = compileChatGptWebPrompt(input, capabilities, turnToken, {
      contextRendering: "codex-context-text-v1",
    });
    const actual = decodeWebContextPayload(compiled.contextPayload!).records;
    expect(actual).toEqual(expected);
    const messages = actual.filter(record => record.kind === "message").map(record => record.message);
    expect(messages[0]!.phase).toBe("commentary");
    expect(messages[1]!.is_error).toBe(false);
    expect(messages[3]).not.toHaveProperty("phase");
    expect(messages[4]!.author).toBe("writer");
    expect(messages[4]!.recipient).toBe("coordinator");
    expect((messages[0]!.content as Array<Record<string, unknown>>).map(part => part.type)).toEqual([
      "text", "tool_call", "text", "thinking_summary",
    ]);
  }
});


test("content-kind metadata does not prove replacement of earlier developer rules", () => {
  const rules = [
    ["model_switch.instructions", "<model_switch>Keep the earlier file protection.</model_switch>"],
    ["skills.catalog", "<skills_instructions>Keep the required skill validation.</skills_instructions>"],
    ["model_switch.instructions", "<model_switch>Add concise output.</model_switch>"],
  ];
  const input = parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: rules.map(([kind, content], index) => ({
    id: `rule-${index}`, type: "message", role: "developer", content,
    internal_chat_message_metadata_passthrough: { content_item_kinds: [kind] },
  })) });
  const compiled = compileChatGptWebPrompt(input, capabilities, turnToken, { bootstrapPreparation: true });
  expect(compiled.bootstrapContent!.payload.messages.map(message => message.content)).toEqual(rules.map(([, content]) => content));
  expect(compiled.bootstrapContent!.messageSourceIndices).toEqual([0, 1, 2]);
});
