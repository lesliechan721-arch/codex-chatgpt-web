import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { bindContextBootstrapRequestSource, contextBootstrapRequestMessageIndices,
  inheritContextBootstrapRequestSource } from "../src/adapters/chatgpt-web/context-bootstrap-request";
import { captureTaskUpdateSource } from "../src/adapters/chatgpt-web/task-update-source";

function request() {
  return parseRequest({ model: "gpt-6.1-sol", input: [
    { role: "developer", content: "Preserve rules." },
    { type: "message", id: "context", role: "user", content: "Workspace data", internal_chat_message_metadata_passthrough: {
      turn_id: "turn", content_item_kinds: ["environments.environment_context"],
    } },
    ...["first", "second"].map((id, index) => ({ type: "message", id, role: "user", content: [{ type: "input_text", text: `${index} 中文😀  \n` }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn", content_item_kinds: ["user.text"] } })),
  ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread", turn_id: "turn" }) } });
}

test("only an accepted native proof selects the complete ordered inline user group", () => {
  const parsed = request();
  expect(contextBootstrapRequestMessageIndices(parsed)).toBeUndefined();
  const proof = captureTaskUpdateSource(parsed, { capabilityIdentity: "test-runtime" })!;
  expect(proof.messages.map(message => message.sourceMessageId)).toEqual(["first", "second"]);
  bindContextBootstrapRequestSource(parsed, proof);
  expect(contextBootstrapRequestMessageIndices(parsed)).toEqual([2, 3]);
  const recovered = structuredClone(parsed);
  inheritContextBootstrapRequestSource(parsed, recovered);
  expect(contextBootstrapRequestMessageIndices(recovered)).toEqual([2, 3]);
  recovered.context.messages[3]!.content = "changed";
  expect(contextBootstrapRequestMessageIndices(recovered)).toBeUndefined();
});

test("source IDs and canonical structure must match; copied text grants no request identity", () => {
  const parsed = request();
  bindContextBootstrapRequestSource(parsed, captureTaskUpdateSource(parsed, { capabilityIdentity: "test-runtime" })!);
  const raw = parsed._rawBody as { input: Array<{ id?: string; content?: unknown }> };
  raw.input[3]!.id = "replacement";
  expect(contextBootstrapRequestMessageIndices(parsed)).toBeUndefined();
});
