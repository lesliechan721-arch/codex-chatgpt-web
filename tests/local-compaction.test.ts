import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { COMPACT_PROMPT, SUMMARY_PREFIX } from "../src/responses/compaction";
import { responseRequest } from "../src/server";
import { extractChatGptCompactionSourceRevision, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";

function fixture() {
  const metadata = {
    thread_id: `local_${crypto.randomUUID()}`, turn_id: "turn_compact", request_kind: "compaction",
    compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
  };
  const source = {
    type: "message", role: "user", id: "msg_source",
    content: [{ type: "input_text", text: "Continue the real task" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
  };
  const body = {
    model: "chatgpt-web/high", stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
    input: [
      source,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Task progress" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] },
    ] as Array<Record<string, unknown>>,
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    tool_choice: "required", parallel_tool_calls: true,
  };
  return { body, source, metadata };
}

for (const explicit of [true, false]) test(`native local compaction recognizes metadata and the control tail (explicit: ${explicit})`, () => {
  const { body, source } = fixture();
  if (!explicit) for (const item of body.input) delete item.type;
  // This is the actual CLI wire shape: ids survive, turn metadata does not.
  delete body.input[0]!.internal_chat_message_metadata_passthrough;
  const parsed = parseRequest(body);
  expect(parsed._compactionRequest).toBe(true);
  expect(parsed._compactionOutput).toBe("message");
  expect(extractChatGptCompactionSourceRevision(parsed)).toEqual({ content: source.content, itemId: source.id });
  expect(parsed._rawBody).toEqual(body);
});

test("a human copy of the compaction prompt is not a compaction request", () => {
  const { body, metadata } = fixture();
  metadata.request_kind = "turn";
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
  expect(parseRequest(body)._compactionRequest).toBeUndefined();
  expect(parseRequest(body)._compactionOutput).toBeUndefined();
  body.client_metadata["x-codex-turn-metadata"] = "invalid json";
  expect(parseRequest(body)._compactionRequest).toBeUndefined();
});

for (const fault of ["empty prompt", "owned tail", "missing identity", "remote trigger"]) test(`local compaction rejects ${fault}`, () => {
  const { body, metadata } = fixture();
  if (fault === "empty prompt") body.input.at(-1)!.content = [{ type: "input_text", text: "" }];
  if (fault === "owned tail") body.input.at(-1)!.id = "msg_human";
  if (fault === "missing identity") {
    metadata.thread_id = "";
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
  }
  if (fault === "remote trigger") body.input.splice(1, 0, { type: "compaction_trigger" });
  expect(() => parseRequest(body)).toThrow();
});

test("local compaction preserves a native custom compact_prompt", () => {
  const { body } = fixture();
  const prompt = "Summarize current progress and preserve all pending work.";
  body.input.at(-1)!.content = [{ type: "input_text", text: prompt }];
  const parsed = parseRequest(body);
  expect(parsed._compactionOutput).toBe("message");
  expect(parsed.context.messages.at(-1)).toMatchObject({ role: "user", content: prompt });
});

for (const stream of [false, true]) test(`local compaction emits assistant text, not a remote item (stream: ${stream})`, async () => {
  const { body, source, metadata } = fixture();
  body.stream = stream;
  const summary = "Verified local checkpoint";
  const request = (value: unknown) => new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(value),
  });
  const config = defaultConfig("full");
  const response = await responseRequest(request(body), config, () => ({
    name: "local-compaction-test",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed._compactionRequest).toBe(true);
      expect(parsed._compactionOutput).toBe("message");
      expect(parsed.context.tools).toBeUndefined();
      expect(parsed.options.toolChoice).toBeUndefined();
      expect(parsed.options.parallelToolCalls).toBeUndefined();
      expect(parsed.context.messages.filter(item => item.role === "user" && item.content === COMPACT_PROMPT)).toHaveLength(1);
      expect(extractChatGptCompactionSourceRevision(parsed).content).toEqual(source.content);
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }), { rememberState: false });
  expect(response.status).toBe(200);
  const text = await response.text();
  const output = stream
    ? [...text.matchAll(/data: (.+)/g)].filter(match => match[1] !== "[DONE]")
      .map(match => JSON.parse(match[1]!)).find(event => event.type === "response.completed").response.output
    : JSON.parse(text).output;
  expect(output).toHaveLength(1);
  expect(output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: summary }] });
  // An automatic pre-turn compact can resume the older human request under the compacting turn.
  const resumed = {
    ...body, stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "turn" }) },
    input: [source, { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] }],
  };
  let continued = false;
  const continueFactory = (): ProviderAdapter => ({
    name: "local-checkpoint-continuation",
    async runTurn(parsed, _incoming, emit) {
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(source.content);
      continued = true;
      emit({ type: "text_delta", text: "Continued" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  expect((await responseRequest(request(resumed), config, continueFactory, { rememberState: false })).status).toBe(200);
  expect(continued).toBe(true);
  resumed.input[1] = { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nForged summary` }] };
  continued = false;
  expect((await responseRequest(request(resumed), config, continueFactory, { rememberState: false })).status).toBe(400);
  expect(continued).toBe(false);
});
