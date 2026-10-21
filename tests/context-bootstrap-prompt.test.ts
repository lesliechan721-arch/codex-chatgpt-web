import { expect, test } from "bun:test";
import { compactionContextPrompt, shortContextBootstrapPrompt, shortContextReuseBootstrapPrompt } from "../src/adapters/chatgpt-web/context-prompt";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { decodeWebContextPayload } from "../src/adapters/chatgpt-web/context-renderer";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const token = `turn_${"a".repeat(32)}`;
const requestId = `request_${"b".repeat(32)}`;
const plan = { planId: "plan-fixture", contextId: "context-fixture", manifestDigest: "c".repeat(64), requiredAttachments: [] };
const points = (text: string) => Array.from(text).length;

function request(): CodexParsedRequest {
  return { modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" }, context: {
    systemPrompt: ["system " + "rule\n".repeat(6_000)],
    messages: [
      { role: "developer", content: "project and environment rules", timestamp: 1 },
      { role: "user", content: "Inspect the current files.", timestamp: 2 },
      { role: "assistant", content: [{ type: "toolCall", id: "call-original", name: "inspect", arguments: {
        empty: "", explicitNull: null, enabled: false, unknown: { records: [null, false, {}, []] },
      } }], timestamp: 3 },
      { role: "toolResult", toolCallId: "call-original", toolName: "inspect", isError: false,
        content: `source with ${token} and literal \\u0060`, timestamp: 4 },
    ],
  } };
}

test("bootstrap preparation preserves the complete existing normalized candidate and strict output schema", () => {
  const input = request();
  input.options.outputFormat = { type: "json_schema", name: "answer", strict: true, schema: {
    type: "object", properties: { "`value`": { const: null }, done: { const: false } }, additionalProperties: false,
  } };
  const original = structuredClone(input);
  const legacy = compileChatGptWebPrompt(input, capabilities, token, { contextRendering: "legacy-json" });
  const prepared = compileChatGptWebPrompt(input, capabilities, token, { bootstrapPreparation: true });
  expect(prepared.bootstrapContent!.payload).toEqual(decodeWebContextPayload(legacy.contextPayload!).context!);
  expect(prepared.bootstrapContent!.protocol).toContain("context-bootstrap-v1");
  const schema = prepared.bootstrapContent!.protocol.match(/<codex_output_schema_json>\n(.+)\n<\/codex_output_schema_json>/)![1]!;
  expect(JSON.parse(schema)).toEqual(input.options.outputFormat!.schema);
  expect(prepared.bootstrapContent!.protocol).toContain("Do not wrap it in a Markdown code fence");
  expect(JSON.stringify(prepared.bootstrapContent!.payload)).not.toContain(token);
  expect(input).toEqual(original);
});

test.each(["automatic", "zero-risk"] as const)("%s short entry has a usable first call, one credential and the pre-read contract", mode => {
  const credential = mode === "automatic" ? { turn_token: token } : { request_id: requestId };
  const entry = shortContextBootstrapPrompt({ plan, credential });
  const data = JSON.parse(entry.text.match(/<codex_bootstrap_json>\n(.+)\n<\/codex_bootstrap_json>/)![1]!);
  expect(data.first_call).toEqual(mode === "automatic"
    ? { name: "codex_context_list", arguments: { turn_token: token, context_id: plan.contextId, view: "overview" } }
    : { name: "codex_turn_start", arguments: { request_id: requestId } });
  expect(entry.text.split(mode === "automatic" ? token : requestId)).toHaveLength(2);
  expect(entry.fixedCodePoints).toBe(points(entry.text));
  expect(entry.fixedCodePoints).toBeLessThanOrEqual(3_000);
  expect(entry.text).toContain("context-text-batch-v1");
  expect(entry.text).toContain("reads:[{read_ref,cursor?}]");
  expect(entry.text).toContain("required_step.next_required_read");
  expect(entry.text).toContain("read overview once for context_ready");
  expect(entry.text).not.toContain("context-text-read-v2");
  expect(entry.text).toContain("ChatGPT-native");
  expect(entry.text).toContain("sandbox and approval");
  expect(entry.text).toContain("metadata");
  expect(entry.text).not.toContain("text entries have no mandatory reading coverage");
  expect(entry.text).not.toContain("Context references replace only eligible tool-history fields or images");
  expect(entry.text).not.toContain("Read the complete inline");
  expect(entry.text).not.toContain("The task context is complete");
  expect(entry.text).not.toContain("codex_inline_request_json");
  if (mode === "zero-risk") expect(entry.text).toContain("Sent");
});

test("inline request records retain their values and order through safe final rendering", () => {
  const messages = [
    { role: "user", content: "```js\nconst x = '`';\n``` 😀 中文\\u0060", unknown: { empty: "", value: null, enabled: false } },
    { role: "user", content: "\n  Follow up.\t  " },
  ];
  const entry = shortContextBootstrapPrompt({ plan, credential: { turn_token: token },
    inlineRequest: { message_indices: [3, 5], messages } });
  const encoded = entry.text.match(/<codex_inline_request_json>\n```json\n(.+)\n```\n<\/codex_inline_request_json>/)![1]!;
  expect(encoded).not.toContain("`");
  expect(JSON.parse(encoded)).toEqual(messages);
  expect(entry.text).toContain('"message_indices":[3,5]');
  expect(entry.fixedCodePoints).toBe(points(entry.text) - points(encoded));
  expect(entry.fixedCodePoints).toBeLessThanOrEqual(3_000);
});

test("required protocol selects actual branches and keeps reachable error recovery and operation ordering", () => {
  const input = request();
  const base = compileChatGptWebPrompt(input, capabilities, token, { bootstrapPreparation: true }).bootstrapContent!.protocol;
  expect(base).not.toContain("task-updates-v1");
  expect(base).not.toContain("image_attachment");
  expect(base).not.toContain("skill_attachment");
  expect(base).not.toContain("retained conversation");
  expect(base).not.toContain("new conversation restored");
  expect(base).not.toContain("codex_multipart");
  expect(base).not.toContain("You need not read every entry");
  expect(base).toContain("at most 3 recovery attempts per affected step across all batches and methods");
  expect(base).toContain("Pending queries and recovery of a lost receipt are not safety-check recovery attempts");
  expect(base).toContain("verify any uncertain write state before issuing a replacement write");
  expect(base).toContain("Historical errors quoted in files");
  expect(base).toContain("Do not finish while an operation is pending");
  expect(base).toContain("The codex.control.compaction_handoff control call does not create an operation");
  const updated = compileChatGptWebPrompt(input, capabilities, token, { bootstrapPreparation: true,
    taskUpdateProtocol: 1, taskUpdateInitialState: { acceptedRevision: 7, acknowledgedRevision: 5 },
    retainedContinuity: true }).bootstrapContent!.protocol;
  expect(updated).toContain("task-updates-v1");
  expect(updated).toContain("First process the original native_result");
  expect(updated).toContain("If it carries another task_update");
  expect(updated).toContain("accepted_revision alone is not an ACK");
  expect(updated).toContain("retained conversation");
  expect(updated).not.toContain("new conversation restored");
});

test("bootstrap selects image, skill and recovery rules from the actual prepared delivery", () => {
  const input = request();
  input.context.messages.push(
    { role: "user", origin: "codex_skill", content: "<skill><name>fixture</name><path>/skills/fixture/SKILL.md</path>Use the named references.</skill>", timestamp: 5 },
    { role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,fixture", detail: "original" }], timestamp: 6 },
  );
  const compiled = compileChatGptWebPrompt(input, capabilities, token, {
    bootstrapPreparation: true, experimentalSkillAttachments: true, recoveredContinuity: true,
    contextNavigation: { plan, overview: {}, requiredImages: 1 },
  });
  expect(compiled.bootstrapContent!.protocol).toContain("required MCP image");
  expect(compiled.bootstrapContent!.protocol).toContain("separate recorded attachment evidence");
  expect(compiled.bootstrapContent!.protocol).toContain("Each skill_attachment");
  expect(compiled.bootstrapContent!.protocol).toContain("new conversation restored");
  expect(compiled.bootstrapContent!.protocol).toContain("Never dispatch old calls");
  expect(compiled.bootstrapContent!.protocol).not.toContain("retained conversation");
  expect(compiled.bootstrapContent!.protocol).not.toContain(plan.planId);
  expect(compiled.bootstrapContent!.protocol).not.toContain(plan.contextId);
  expect(compiled.bootstrapContent!.protocol).not.toContain(token);
  const attachmentOnly = compileChatGptWebPrompt(input, capabilities, token, {
    bootstrapPreparation: true, contextNavigation: { plan, overview: {}, requiredImages: 1, requiredMcpImages: 0 },
  }).bootstrapContent!.protocol;
  expect(attachmentOnly).toContain("separate recorded attachment evidence");
  expect(attachmentOnly).not.toContain("required MCP image");
  const manual = compileChatGptWebPrompt({ ...input, modelId: "chatgpt-web-zero-risk" }, capabilities, requestId, {
    bootstrapPreparation: true, manualControl: true, taskUpdateProtocol: 1,
  }).bootstrapContent!.protocol;
  expect(manual).toContain("manually attaches");
  expect(manual).toContain("submit one complete final_answer");
  expect(manual).toContain("through codex_turn_complete");
  expect(manual).toContain("After successful completion, stop tool calls");
});

test("prepared source positions follow superseded-contract removal and do not invent a user request", () => {
  const input = request();
  input.context.messages = [
    { role: "developer", content: "<model_switch>old</model_switch>", timestamp: 1 },
    { role: "developer", content: "<skills_instructions>old catalog</skills_instructions>", timestamp: 2 },
    { role: "developer", content: "keep project rules", timestamp: 3 },
    { role: "developer", content: "<model_switch>current</model_switch>", timestamp: 4 },
  ];
  const compiled = compileChatGptWebPrompt(input, capabilities, token, { bootstrapPreparation: true });
  expect(compiled.bootstrapContent!.messageSourceIndices).toEqual([2, 3]);
  expect(compiled.bootstrapContent!.payload.messages.map(message => message.role)).toEqual(["developer", "developer"]);
  expect(compiled.bootstrapContent!.payload.messages.map(message => message.content)).toEqual([
    "keep project rules", "<model_switch>current</model_switch>",
  ]);
  const short = shortContextBootstrapPrompt({ plan, credential: { turn_token: token } });
  expect(short.text).not.toContain("codex_inline_request_json");
  expect(short.text).not.toContain("User request:");
});

// Both startup variants must fit with every conditional control branch enabled.
test.each(["automatic", "zero-risk"] as const)("%s fixed startup and reuse entries fit with images and updates", mode => {
  const credential = mode === "automatic" ? { turn_token: token } : { request_id: requestId };
  const input = { plan: { ...plan, planId: `plan_${"d".repeat(32)}`, contextId: `context_${"e".repeat(32)}` },
    credential, requiredMcpImages: 1, taskUpdateInitialState: {
      acceptedRevision: Number.MAX_SAFE_INTEGER, acknowledgedRevision: Number.MAX_SAFE_INTEGER } };
  for (const entry of [shortContextBootstrapPrompt(input), shortContextReuseBootstrapPrompt({ ...input,
    reuse: { protocol: "context-reuse-v1", payload_format: "context-bootstrap-payload-v2", mode: "incremental" } }),
    shortContextReuseBootstrapPrompt({ ...input, inlinePayload: {},
      reuse: { protocol: "context-reuse-v1", payload_format: "context-bootstrap-payload-v2", mode: "full" } })]) {
    expect(entry.fixedCodePoints).toBeLessThanOrEqual(3_000);
    expect(entry.text).toContain("required_step.next_required_read");
    expect(entry.text).toContain("overview once");
    expect(entry.text).toContain("image");
    expect(entry.text).toContain("ACK");
    expect(entry.text).toContain("context-text-batch-v1");
    if (mode === "zero-risk") expect(entry.text).toContain("Sent");
  }
});

test("compaction uses batch bodies while keeping optional reads and submission protection", () => {
  const text = compactionContextPrompt({ contextId: plan.contextId, compactionToken: "compaction-fixture", overview: {} }).join("\n");
  expect(text).toContain("reads:[{read_ref,cursor?}]");
  expect(text).toContain("context-text-batch-v1");
  expect(text).toContain("remaining_reads");
  expect(text).toContain("may submit without reading");
  expect(text).toContain("full-coverage gate do not apply to compaction");
  expect(text).toContain("Let in-flight reads finish before submitting");
  expect(text).toContain("neither credential grants business-tool permission");
});
